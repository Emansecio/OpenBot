/**
 * T6 — Adapter OpenAI (base comum dos adapters "OpenAI-like"; plano §3 T6).
 *
 * Implementa o contrato `ProviderAdapter` do roteador (src/providers/router.ts)
 * para a API OpenAI `chat.completions` com `stream:true` e parâmetro `tools`
 * opcional. A chave `sk-...` é resolvida via keystore (namespace
 * `scoped:v1:provider:openai:apiKey` — `reveal`), nunca lida de config ou env.
 *
 * O adapter NÃO acumula nem emite `message`/`done`/`error` — o roteador faz
 * isso (acumulador de deltas, spec §3.1). Este adapter apenas:
 *   1. monta o corpo JSON (helpers T6 — `buildChatBody`), incluindo o system
 *      prompt como primeira mensagem;
 *   2. faz o POST em `https://api.openai.com/v1/chat/completions` com
 *      `Authorization: Bearer <chave>` e `stream:true`;
 *   3. lê o SSE linha-a-linha, emite `delta` (content) e `tool-call` (via
 *      `OpenAiToolCallAccumulator` — normalização de tool calls reusada por
 *      xAI/OpenAI-compat);
 *   4. respeita `req.signal` (abort encerra o fetch e o stream);
 *   5. erros de transporte/HTTP são normalizados (`normalizeOpenAiError` +
 *      `classifyProviderError` do roteador no catch) — o adapter LANÇA, o
 *      roteador classifica transiente vs permanente.
 *
 * Helpers em `openai-helpers.ts` são a base reusada por T7 (xAI) e T8
 * (OpenAI-compat) — este arquivo não duplica nada disso.
 */

import type { Keystore } from "../keystore/index.js";
import { parseProviderUsage } from "./usage.js";
import {
  defaultRegistry,
  type ProviderAdapter,
  type ProviderChatRequest,
  type ProviderStreamEvent,
} from "./router.js";
import {
  ApiError,
  OpenAiToolCallAccumulator,
  buildChatBody,
  extractOpenAiErrorMessage,
  findSseFrameBoundary,
  normalizeOpenAiError,
  openAiStreamErrorStatus,
  parseRetryAfterMs,
  providerTimeoutError,
  raceWithAbort,
  splitSseLines,
} from "./openai-helpers.js";
import { buildCodexResponsesBody, buildResponsesBody, usesResponsesApi } from "./request-bodies.js";

/** Nome canônico do provider no registry e no namespace da keystore. */
export const OPENAI_PROVIDER_NAME = "openai" as const;

/** Endpoint default da OpenAI. */
export const OPENAI_API_BASE_URL = "https://api.openai.com/v1" as const;

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const ERROR_BODY_TRUNCATION_MESSAGE = "corpo de erro truncado";
const ERROR_BODY_TRUNCATION_MARKER = `\n[${ERROR_BODY_TRUNCATION_MESSAGE} após ${MAX_ERROR_BODY_BYTES} bytes]`;

async function readErrorBody(
  response: Response,
  signal: AbortSignal,
  onActivity?: () => void,
): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) return { text: "", truncated: false };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let remaining = MAX_ERROR_BODY_BYTES;
  let truncated = false;

  try {
    while (remaining > 0) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) {
        parts.push(decoder.decode());
        return { text: parts.join(""), truncated: false };
      }
      onActivity?.();
      const retained = value.subarray(0, remaining);
      parts.push(decoder.decode(retained, { stream: true }));
      remaining -= retained.byteLength;
      if (retained.byteLength < value.byteLength) {
        truncated = true;
        break;
      }
    }

    if (!truncated) {
      const next = await raceWithAbort(reader.read(), signal);
      truncated = !next.done;
    }
    parts.push(decoder.decode());
    if (truncated) parts.push(ERROR_BODY_TRUNCATION_MARKER);
    return { text: parts.join(""), truncated };
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Chave da keystore: `scoped:v1:provider:openai:apiKey` (T4). */
export function openAiApiKeyKey(): string {
  return `scoped:v1:provider:${OPENAI_PROVIDER_NAME}:apiKey`;
}

export interface OpenAiAdapterOptions {
  requestHeaders?: (request: ProviderChatRequest) => Record<string, string>;
  /** URL base da API (default: OpenAI oficial). xAI/OpenAI-compat passam outra. */
  baseUrl?: string;
  /** Provider "nomeado" no registry (default "openai"; xAI usa "xai"). */
  name?: string;
  /** Chave de API fornecida diretamente (testes/mocks). Sobrepoe a keystore. */
  apiKey?: string;
  /** OAuth credential resolver used by ChatGPT Codex and xAI login flows. */
  credentialResolver?: () => Promise<{ accessToken: string; accountId?: string }>;
  onCredentialRejected?: (accessToken: string) => Promise<void>;
  /** Explicit transport override; Codex also adds account-scoped headers. */
  protocol?: "openai" | "responses" | "codex";
  /** Keystore (T4) para `reveal` da chave por namespace scoped:v1:provider:<name>:apiKey. */
  keystore?: Keystore;
  /** Idle timeout reset on every response body chunk. Default 120_000 ms. */
  timeoutMs?: number;
  /** Absolute request duration cap. Default 900_000 ms. */
  maxDurationMs?: number;
  /** `fetch` injetável (testes usam o do Node; prod usa globalThis.fetch). */
  fetchImpl?: typeof fetch;
  /**
   * Política do parâmetro `reasoning_effort` no corpo chat.completions
   * (omítido por default — nem todo endpoint aceita o campo):
   *  - "declared": envia só quando `modelResolution.supportedReasoningEfforts`
   *    contém o esforço pedido (providers de catálogo — fail-closed);
   *  - "always": envia sempre que `req.reasoningEffort` está presente
   *    (opt-in do endpoint compat configurável pelo usuário).
   */
  reasoningEffortPolicy?: "declared" | "always";
}

/**
 * Adapter OpenAI (chat.completions stream) — implementa `ProviderAdapter`.
 * `streamChat` emite `delta` e `tool-call` e resolve ao fim do stream; erros
 * são LANÇADOS e o roteador os converte em evento `error` (nunca lança para o
 * consumidor final).
 */
export class OpenAiAdapter implements ProviderAdapter {
  readonly tracksTransport = true;
  readonly name: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxDurationMs: number;
  private readonly requestHeaders?: OpenAiAdapterOptions["requestHeaders"];
  private readonly apiKey?: string;
  private readonly keystore?: Keystore;
  private readonly credentialResolver?: OpenAiAdapterOptions["credentialResolver"];
  private readonly onCredentialRejected?: OpenAiAdapterOptions["onCredentialRejected"];
  private readonly protocol: "openai" | "responses" | "codex";
  private readonly reasoningEffortPolicy?: OpenAiAdapterOptions["reasoningEffortPolicy"];
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiAdapterOptions = {}) {
    this.requestHeaders = opts.requestHeaders;
    this.name = opts.name ?? OPENAI_PROVIDER_NAME;
    this.baseUrl = (opts.baseUrl ?? OPENAI_API_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxDurationMs = opts.maxDurationMs ?? Math.max(900_000, this.timeoutMs);
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("OpenAI idle timeout is invalid");
    if (!Number.isSafeInteger(this.maxDurationMs) || this.maxDurationMs < this.timeoutMs) throw new Error("OpenAI max duration is invalid");
    this.apiKey = opts.apiKey;
    this.keystore = opts.keystore;
    this.credentialResolver = opts.credentialResolver;
    this.onCredentialRejected = opts.onCredentialRejected;
    this.protocol = opts.protocol ?? "openai";
    this.reasoningEffortPolicy = opts.reasoningEffortPolicy;
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  serializeRequest(req: ProviderChatRequest): string {
    const codex = this.protocol === "codex";
    const responsesApi = codex || this.protocol === "responses" || usesResponsesApi(req.model);
    const body = codex ? buildCodexResponsesBody(req) : responsesApi ? buildResponsesBody(req) : buildChatBody(req);
    if (!responsesApi && !codex && this.reasoningEffortPolicy !== undefined && req.reasoningEffort !== undefined) {
      const allowed = this.reasoningEffortPolicy === "always"
        || req.modelResolution?.supportedReasoningEfforts?.includes(req.reasoningEffort) === true;
      if (allowed) body.reasoning_effort = req.reasoningEffort;
    }
    return JSON.stringify(body);
  }

  /** Resolve a chave de API: direta (testes) ou keystore (namespace scoped:v1). */
  private async resolveCredential(): Promise<{ accessToken: string; accountId?: string }> {
    if (this.credentialResolver !== undefined) return this.credentialResolver();
    if (this.apiKey !== undefined) return { accessToken: this.apiKey };
    if (this.keystore !== undefined) {
      const revealed = await this.keystore.reveal(this.name);
      if (revealed !== null && revealed.length > 0) return { accessToken: revealed };
    }
    throw new ApiError(
      `chave de API do provider "${this.name}" não configurada (keystore vazia)`,
      401,
      { error: { message: "missing api key" } },
    );
  }

  /** Lê o corpo SSE e emite `delta`/`tool-call` (acumulador de tool calls). */
  private async readStream(
    body: ReadableStream<Uint8Array>,
    emit: (event: ProviderStreamEvent) => void,
    signal: AbortSignal,
    onActivity: () => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    const toolAccumulator = new OpenAiToolCallAccumulator();
    let buffer = "";
    let terminated = false;
    let finishReason: string | undefined;
    let finishPayload: unknown;

    const isIncompleteReason = (reason: string | undefined): reason is "length" | "content_filter" | "max_tokens" =>
      reason === "length" || reason === "content_filter" || reason === "max_tokens";

    const dispatchFrame = (frame: string): boolean => {
      const data = splitSseLines(frame).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (data.length === 0) return false;
      if (data === "[DONE]") return true;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch {
        throw new ApiError("openai: frame SSE inválido", 502, data);
      }
      if (typeof parsed !== "object" || parsed === null) return false;
      const payload = parsed as Record<string, unknown>;
      const usage = parseProviderUsage(payload.usage, "chat");
      if (usage) emit({ type: "usage", usage });
      if (typeof payload.error === "object" && payload.error !== null) {
        const error = payload.error as Record<string, unknown>;
        throw new ApiError(
          typeof error.message === "string" ? error.message : "openai: erro no stream",
          openAiStreamErrorStatus(error),
          parsed,
        );
      }
      const choices = payload.choices;
      if (!Array.isArray(choices)) {
        throw new ApiError("openai: frame SSE sem choices", 502, parsed);
      }
      if (choices.length === 0) return false;
      const choice = choices[0] as Record<string, unknown> | undefined;
      const currentFinishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
      const delta = choice?.delta;
      // A final chunk may carry both the last text/tool delta and
      // `finish_reason`; preserve that delta before recording the reason.
      if (finishReason === undefined && typeof delta === "object" && delta !== null) {
        const record = delta as Record<string, unknown>;
        if (typeof record.content === "string" && record.content.length > 0) emit({ type: "delta", delta: record.content });
        if (Array.isArray(record.tool_calls)) for (const chunk of record.tool_calls) {
          if (typeof chunk === "object" && chunk !== null) toolAccumulator.add(chunk as Parameters<OpenAiToolCallAccumulator["add"]>[0]);
        }
      }
      if (finishReason === undefined && currentFinishReason !== undefined) {
        finishReason = currentFinishReason;
        finishPayload = parsed;
      }
      return false;
    };

    try {
      while (!terminated) {
        const { done, value } = await raceWithAbort(reader.read(), signal);
        if (done) break;
        onActivity();
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 1_048_576) throw new ApiError("openai: buffer SSE excedeu 1 MiB", 502);
        let boundary = findSseFrameBoundary(buffer);
        while (boundary !== undefined) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          if (dispatchFrame(frame)) { terminated = true; break; }
          boundary = findSseFrameBoundary(buffer);
        }
      }
      if (!terminated) throw new ApiError("openai: stream terminou antes de [DONE]", 502);
    } finally {
      // Cancela também em parse/EOF/emit error; não deixa o body produzindo em
      // background depois que o adapter já falhou.
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (isIncompleteReason(finishReason)) {
      throw new ApiError(`openai: geração interrompida (${finishReason})`, 400, finishPayload, { code: finishReason });
    }
    if (toolAccumulator.hasAny && !toolAccumulator.complete) {
      throw new ApiError("openai: tool call incompleta no fim do stream", 502);
    }
    for (const call of toolAccumulator.calls()) emit({ type: "tool-call", call });
  }

  private async readResponsesStream(
    body: ReadableStream<Uint8Array>,
    emit: (event: ProviderStreamEvent) => void,
    signal: AbortSignal,
    onActivity: () => void,
    reportServiceTier = false,
  ): Promise<void> {
    type ToolSlot = { id: string; name: string; arguments: string; emitted: boolean };
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    const tools = new Map<number, ToolSlot>();
    let buffer = "";
    let completed = false;

    const record = (value: unknown): Record<string, unknown> | undefined =>
      typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
    const outputIndex = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
    const errorMessage = (event: Record<string, unknown>): string => {
      const response = record(event.response);
      const error = record(event.error) ?? record(response?.error);
      const incomplete = record(response?.incomplete_details);
      if (typeof error?.message === "string") return error.message;
      if (typeof incomplete?.reason === "string") return incomplete.reason;
      if (typeof event.message === "string") return event.message;
      return "OpenAI Responses API falhou";
    };
    const responseError = (event: Record<string, unknown>): ApiError => {
      const response = record(event.response);
      const error = record(event.error) ?? record(response?.error);
      const incomplete = event.type === "response.incomplete" || response?.status === "incomplete";
      const status = incomplete ? 400 : openAiStreamErrorStatus(error ?? event, 502);
      const code = incomplete ? record(response?.incomplete_details)?.reason : error?.code ?? error?.type ?? event.code;
      return new ApiError(`openai: ${errorMessage(event)}`, status, event, { code: typeof code === "string" ? code : undefined });
    };
    const upsertTool = (index: number, item: Record<string, unknown>): ToolSlot => {
      const current = tools.get(index);
      const id = typeof item.call_id === "string" ? item.call_id : current?.id;
      const name = typeof item.name === "string" ? item.name : current?.name;
      const args = typeof item.arguments === "string" ? item.arguments : current?.arguments ?? "";
      if (!id || !name) throw new ApiError("openai: function call inválida no stream Responses", 502, item);
      const slot = { id, name, arguments: args, emitted: current?.emitted ?? false };
      tools.set(index, slot);
      return slot;
    };
    const emitTool = (index: number, item?: Record<string, unknown>): void => {
      const slot = item ? upsertTool(index, item) : tools.get(index);
      if (!slot || slot.emitted) return;
      slot.emitted = true;
      emit({
        type: "tool-call",
        call: {
          id: slot.id,
          type: "function",
          function: { name: slot.name, arguments: slot.arguments },
        },
      });
    };

    const dispatchFrame = (frame: string): boolean => {
      const data = splitSseLines(frame)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data || data === "[DONE]") return false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new ApiError("openai: frame SSE Responses inválido", 502, data);
      }
      const event = record(parsed);
      if (!event || typeof event.type !== "string") {
        throw new ApiError("openai: evento Responses sem type", 502, parsed);
      }

      const index = outputIndex(event.output_index);
      const usage = parseProviderUsage(record(event.response)?.usage, "responses");
      if (usage) emit({ type: "usage", usage });
      const item = record(event.item);
      switch (event.type) {
        case "response.output_text.delta":
          if (typeof event.delta === "string" && event.delta) emit({ type: "delta", delta: event.delta });
          return false;
        case "response.output_item.added":
          if (index !== undefined && item?.type === "function_call") upsertTool(index, item);
          return false;
        case "response.function_call_arguments.delta": {
          if (index === undefined || typeof event.delta !== "string") return false;
          const slot = tools.get(index);
          if (!slot) throw new ApiError("openai: argumentos chegaram antes da function call", 502, parsed);
          slot.arguments += event.delta;
          return false;
        }
        case "response.function_call_arguments.done": {
          if (index === undefined || typeof event.arguments !== "string") return false;
          const slot = tools.get(index);
          if (!slot) throw new ApiError("openai: function call ausente para argumentos finais", 502, parsed);
          slot.arguments = event.arguments;
          return false;
        }
        case "response.output_item.done":
          if (index !== undefined && item?.type === "function_call") emitTool(index, item);
          return false;
        case "response.completed":
        case "response.done": {
          const response = record(event.response);
          if (response?.status !== undefined && response.status !== "completed") {
            throw responseError(event);
          }
          const output = response?.output;
          if (reportServiceTier) {
            const tier = response?.service_tier;
            emit({ type: "service-tier", actual: tier === "priority" || tier === "fast" ? "priority" : tier === "default" ? "default" : "unknown" });
          }
          if (Array.isArray(output)) {
            output.forEach((entry, outputPosition) => {
              const outputItem = record(entry);
              if (outputItem?.type === "function_call") emitTool(outputPosition, outputItem);
            });
          }
          for (const toolIndex of tools.keys()) emitTool(toolIndex);
          return true;
        }
        case "response.failed":
        case "response.incomplete":
        case "error":
          throw responseError(event);
        default:
          return false;
      }
    };

    try {
      while (!completed) {
        const { done, value } = await raceWithAbort(reader.read(), signal);
        if (done) break;
        onActivity();
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 1_048_576) throw new ApiError("openai: buffer SSE Responses excedeu 1 MiB", 502);
        let boundary = findSseFrameBoundary(buffer);
        while (boundary !== undefined) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          if (dispatchFrame(frame)) {
            completed = true;
            break;
          }
          boundary = findSseFrameBoundary(buffer);
        }
      }
      if (!completed) throw new ApiError("openai: stream terminou antes de response.completed", 502);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async streamChat(
    req: ProviderChatRequest,
    emit: (event: ProviderStreamEvent) => void,
  ): Promise<void> {
    const controller = new AbortController();
    let timeoutError: ReturnType<typeof providerTimeoutError> | undefined;
    const onAbort = (): void => {
      if (!controller.signal.aborted) controller.abort(req.signal?.reason);
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    if (req.signal?.aborted) onAbort();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (controller.signal.aborted) return;
      idleTimer = setTimeout(() => {
        if (controller.signal.aborted) return;
        timeoutError = providerTimeoutError(this.timeoutMs);
        controller.abort(timeoutError);
      }, this.timeoutMs);
    };
    resetIdleTimer();
    const maxDurationTimer = setTimeout(() => {
      if (controller.signal.aborted) return;
      timeoutError = providerTimeoutError(this.maxDurationMs);
      controller.abort(timeoutError);
    }, this.maxDurationMs);
    let response: Response | undefined;
    let succeeded = false;

    try {
      let credential: { accessToken: string; accountId?: string };
      try {
        credential = await raceWithAbort(this.resolveCredential(), controller.signal);
      } catch (err) {
        // Chave ausente → ApiError 401 → auth. Abort/timeout também cobre a
        // resolução da chave, mesmo que o backend da keystore fique pendente.
        if (timeoutError !== undefined) throw timeoutError;
        throw err instanceof ApiError ? err : normalizeOpenAiError(err);
      }

      const codex = this.protocol === "codex";
      if (codex && !credential.accountId) throw new ApiError("sessão Codex sem accountId", 401);
      const responsesApi = codex || this.protocol === "responses" || usesResponsesApi(req.model);
      const endpoint = new URL(this.baseUrl);
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/${responsesApi ? "responses" : "chat/completions"}`;
      const url = endpoint.toString();

      try {
        const body = this.serializeRequest(req);
        controller.signal.throwIfAborted();
        req.onTransportStart?.(codex ? "codex" : responsesApi ? "responses" : "chat");
        response = await raceWithAbort(this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${credential.accessToken}`,
            accept: "text/event-stream",
            "x-openbot-purpose": req.purpose ?? "turn",
            ...this.requestHeaders?.(req),
            ...(codex ? {
              "chatgpt-account-id": credential.accountId!,
              "OpenAI-Beta": "responses=experimental",
              originator: "openbot",
            } : {}),
          },
          body,
          signal: controller.signal,
        }), controller.signal);
        resetIdleTimer();
      } catch (err) {
        if (timeoutError !== undefined) throw timeoutError;
        throw normalizeOpenAiError(err);
      }

      if (!response.ok) {
        if (response.status === 401) await this.onCredentialRejected?.(credential.accessToken);
        let message = `openai: HTTP ${response.status}`;
        let responseBody: unknown = undefined;
        try {
          const errorBody = await readErrorBody(response, controller.signal, resetIdleTimer);
          const text = errorBody.text;
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // corpo não-JSON — mantém o texto bruto
          }
          const extracted = extractOpenAiErrorMessage(parsed);
          if (extracted !== undefined) message = `openai: HTTP ${response.status} — ${extracted}`;
          if (errorBody.truncated) message = `${message} — ${ERROR_BODY_TRUNCATION_MESSAGE}`;
          responseBody = parsed;
        } catch {
          // corpo ilegível — mensagem padrão já montada
        }
        throw new ApiError(message, response.status, responseBody, {
          retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
        });
      }

      if (response.body === null) {
        throw new ApiError("openai: resposta sem corpo (stream vazio)", 502);
      }

      if (responsesApi) await this.readResponsesStream(response.body, emit, controller.signal, resetIdleTimer, Boolean(req.modelResolution?.serviceTier));
      else await this.readStream(response.body, emit, controller.signal, resetIdleTimer);
      succeeded = true;
    } catch (err) {
      if (timeoutError !== undefined) throw timeoutError;
      throw err;
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      clearTimeout(maxDurationTimer);
      req.signal?.removeEventListener("abort", onAbort);
      const responseBody = response?.body;
      if (!succeeded && responseBody !== undefined && responseBody !== null && !responseBody.locked) {
        await responseBody.cancel().catch(() => undefined);
      }
    }
  }
}

/**
 * Registra o adapter OpenAI no registry default do roteador como "openai"
 * (contrato `ProviderRegistry.register` de T5). Retorna a instância criada.
 * Chamado no boot (T10) e pelos testes.
 */
export function registerOpenAiAdapter(opts: OpenAiAdapterOptions = {}): OpenAiAdapter {
  const adapter = new OpenAiAdapter(opts);
  defaultRegistry.register(adapter);
  return adapter;
}
