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
  type ProviderAdapter,
  type ProviderChatRequest,
  type ProviderStreamEvent,
} from "./router.js";
import {
  ApiError,
  buildChatBody,
  createChatCompletionsStreamHandler,
  normalizeOpenAiError,
  normalizeToolCallArguments,
  openAiStreamErrorStatus,
  providerHttpError,
  raceWithAbort,
  readSseFrames,
  sseFrameData,
  startProviderDeadline,
} from "./openai-helpers.js";
import { buildCodexResponsesBody, buildResponsesBody, usesResponsesApi } from "./request-bodies.js";

/** Nome canônico do provider no registry e no namespace da keystore. */
export const OPENAI_PROVIDER_NAME = "openai" as const;

/** Endpoint default da OpenAI. */
export const OPENAI_API_BASE_URL = "https://api.openai.com/v1" as const;

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

  /** Chat Completions SSE: deltas, usage and tool calls through the shared handler. */
  private async readStream(
    body: ReadableStream<Uint8Array>,
    emit: (event: ProviderStreamEvent) => void,
    signal: AbortSignal,
    onActivity: () => void,
  ): Promise<void> {
    const handler = createChatCompletionsStreamHandler("openai", emit);
    if (!await readSseFrames(body, signal, onActivity, "openai", (frame) => handler.dispatchFrame(frame))) {
      throw new ApiError("openai: stream terminou antes de [DONE]", 502);
    }
    handler.finish();
  }

  private async readResponsesStream(
    body: ReadableStream<Uint8Array>,
    emit: (event: ProviderStreamEvent) => void,
    signal: AbortSignal,
    onActivity: () => void,
    reportServiceTier = false,
  ): Promise<void> {
    type ToolSlot = { id: string; name: string; arguments: string; emitted: boolean; itemDone: boolean; argumentsDone: boolean };
    const tools = new Map<number, ToolSlot>();

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
      const slot = {
        id,
        name,
        arguments: args,
        emitted: current?.emitted ?? false,
        itemDone: current?.itemDone ?? false,
        argumentsDone: current?.argumentsDone ?? false,
      };
      tools.set(index, slot);
      return slot;
    };
    const markToolDone = (index: number, item: Record<string, unknown>): void => {
      const slot = upsertTool(index, item);
      slot.itemDone = true;
      if (typeof item.arguments === "string") slot.argumentsDone = true;
    };
    const emitTool = (index: number): void => {
      const slot = tools.get(index);
      if (!slot || slot.emitted) return;
      if (!slot.itemDone) throw new ApiError("openai: function call não terminou antes da conclusão da response", 502);
      if (!slot.argumentsDone) throw new ApiError("openai: argumentos de function call não terminaram antes da conclusão da response", 502);
      slot.arguments = normalizeToolCallArguments(slot.arguments, "openai Responses");
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
      const data = sseFrameData(frame);
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
          if (item?.type === "function_call") {
            if (index === undefined) throw new ApiError("openai: function call Responses sem output_index", 502, parsed);
            upsertTool(index, item);
          }
          return false;
        case "response.function_call_arguments.delta": {
          if (index === undefined) throw new ApiError("openai: argumentos de function call sem output_index", 502, parsed);
          if (typeof event.delta !== "string") return false;
          const slot = tools.get(index);
          if (!slot) throw new ApiError("openai: argumentos chegaram antes da function call", 502, parsed);
          slot.arguments += event.delta;
          return false;
        }
        case "response.function_call_arguments.done": {
          if (index === undefined) throw new ApiError("openai: argumentos finais de function call sem output_index", 502, parsed);
          if (typeof event.arguments !== "string") return false;
          const slot = tools.get(index);
          if (!slot) throw new ApiError("openai: function call ausente para argumentos finais", 502, parsed);
          slot.arguments = event.arguments;
          slot.argumentsDone = true;
          return false;
        }
        case "response.output_item.done":
          if (item?.type === "function_call") {
            if (index === undefined) throw new ApiError("openai: function call final Responses sem output_index", 502, parsed);
            markToolDone(index, item);
          }
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
              if (outputItem?.type === "function_call") markToolDone(outputPosition, outputItem);
            });
          }
          for (const toolIndex of [...tools.keys()].sort((left, right) => left - right)) emitTool(toolIndex);
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

    if (!await readSseFrames(body, signal, onActivity, "openai Responses", dispatchFrame)) {
      throw new ApiError("openai: stream terminou antes de response.completed", 502);
    }
  }

  async streamChat(
    req: ProviderChatRequest,
    emit: (event: ProviderStreamEvent) => void,
  ): Promise<void> {
    const deadline = startProviderDeadline(req.signal, this.timeoutMs, this.maxDurationMs);
    const signal = deadline.signal;
    let response: Response | undefined;
    let succeeded = false;

    try {
      let credential: { accessToken: string; accountId?: string };
      try {
        credential = await raceWithAbort(this.resolveCredential(), signal);
      } catch (err) {
        // Chave ausente → ApiError 401 → auth. Abort/timeout também cobre a
        // resolução da chave, mesmo que o backend da keystore fique pendente.
        if (deadline.timeoutError !== undefined) throw deadline.timeoutError;
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
        signal.throwIfAborted();
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
          signal,
        }), signal);
        deadline.resetIdle();
      } catch (err) {
        if (deadline.timeoutError !== undefined) throw deadline.timeoutError;
        throw normalizeOpenAiError(err);
      }

      if (!response.ok) {
        if (response.status === 401) {
          try {
            await this.onCredentialRejected?.(credential.accessToken);
          } catch {
            // Recording the rejection is bookkeeping; the 401 stays the error.
          }
        }
        throw await providerHttpError("openai", response, signal, deadline.resetIdle);
      }

      if (response.body === null) {
        throw new ApiError("openai: resposta sem corpo (stream vazio)", 502);
      }

      if (responsesApi) await this.readResponsesStream(response.body, emit, signal, deadline.resetIdle, Boolean(req.modelResolution?.serviceTier));
      else await this.readStream(response.body, emit, signal, deadline.resetIdle);
      succeeded = true;
    } catch (err) {
      if (deadline.timeoutError !== undefined) throw deadline.timeoutError;
      throw err;
    } finally {
      deadline.dispose();
      const responseBody = response?.body;
      if (!succeeded && responseBody !== undefined && responseBody !== null && !responseBody.locked) {
        await responseBody.cancel().catch(() => undefined);
      }
    }
  }
}
