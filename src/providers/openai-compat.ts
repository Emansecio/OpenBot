/**
 * T8 — Adapter OpenAI-compatible com baseURL custom (plano §3 T8).
 *
 * Para servidores que falam a API OpenAI `chat.completions` com `stream:true`
 * em um endpoint custom configurado pelo usuário.
 *
 * Design (mesmo padrão do T6/T7 — implementa `ProviderAdapter` do roteador):
 *   1. `baseUrl` CONFIGURÁVEL e OBRIGATÓRIA no adapter (não há default sensato
 *      para "compatible"); validada no construtor (fail-fast);
 *   2. chave de API OPCIONAL: resolvida via keystore (namespace
 *      `scoped:v1:provider:openai-compat:apiKey` — `reveal`) ou `apiKey`
 *      direta (testes/mocks); SEM chave o request sai SEM header Authorization
 *      (endpoints custom podem não exigir chave);
 *   3. REUSA os helpers de openai-helpers.ts (T6): `buildChatBody` (system
 *      inline + tools + max_tokens), `OpenAiToolCallAccumulator` (tool calls),
 *      `normalizeOpenAiError`/`ApiError`/`extractOpenAiErrorMessage` (erros);
 *   4. erros de transporte/HTTP são normalizados e LANÇADOS — o roteador os
 *      classifica (transiente vs permanente, spec §3.1).
 *
 * ENDEREÇAMENTO DO MODELO — escolha documentada (plano §3 T8: "<baseURL>/<model>
 * OU par baseURL+model; siga o contrato do router"):
 *   **Par baseURL + model**: a `baseUrl` é a RAÍZ da API (config do adapter) e o
 *   `req.model` do contrato do roteador (string) vai no CORPO do chat.completions.
 *   O endpoint é sempre `{baseUrl}/chat/completions`; o model NUNCA é
 *   interpolado no path da URL. Razões: (a) o contrato do roteador
 *   (`ProviderChatRequest.model`) modela o modelo como string de catálogo, não
 *   como path de URL — interpolá-lo na URL quebraria o contrato e o catálogo
 *   estático (Decisão §8.3); (b) servidores OpenAI-compatible endereçam o modelo
 *   exclusivamente no corpo (`{"model": ...}`);
 *   (c) segurança: nenhuma injeção de path possível via nome de modelo.
 *
 * VALIDAÇÃO DE URL (segurança default):
 *   - apenas esquemas http/https (qualquer outro → erro validation 400);
 *   - http para host NÃO-loopback é BLOQUEADO por default (ex.: expor credenciais
 *     em texto claro na LAN); liberável com `allowNonLoopbackHttp: true`;
 *   - https remoto é PERMITIDO (cifrado de ponta a ponta; TLS estrito do fetch
 *     nativo do Node — `rejectUnauthorized` não é configurável aqui de propósito;
 *     fixtures de teste injetam um `fetchImpl` próprio para o cert self-signed);
 *   - loopback = `localhost`, `::1` e `127.0.0.0/8` (`isLoopbackHost`).
 *
 * REGISTRO: `registerOpenAiCompatAdapter` registra como "openai-compat" no
 * registry default do roteador. SÓ registra quando uma `baseUrl` é fornecida
 * (sem baseURL custom configurada o adapter não existe — boot sem quebrar).
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

/** Nome canônico do provider no registry e no namespace da keystore. */
export const OPENAI_COMPAT_PROVIDER_NAME = "openai-compat" as const;

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const ERROR_BODY_TRUNCATION_MESSAGE = "corpo de erro truncado";
const ERROR_BODY_TRUNCATION_MARKER = `\n[${ERROR_BODY_TRUNCATION_MESSAGE} após ${MAX_ERROR_BODY_BYTES} bytes]`;

async function readErrorBody(
  response: Response,
  signal: AbortSignal,
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
    if (!truncated) parts.push(decoder.decode());
    if (truncated) parts.push(ERROR_BODY_TRUNCATION_MARKER);
    return { text: parts.join(""), truncated };
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Chave da keystore: `scoped:v1:provider:openai-compat:apiKey` (T4). */
export function openaiCompatApiKeyKey(): string {
  return `scoped:v1:provider:${OPENAI_COMPAT_PROVIDER_NAME}:apiKey`;
}

/**
 * True para hosts de loopback: `localhost`, `::1` e qualquer `127.x.x.x`
 * (127.0.0.0/8). `[::1]` com colchetes também é aceito (URL parseada).
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    // 127.0.0.0/8 — cada octeto dentro de 0-255 (expressão já garante dígitos).
    return h.split(".").every((octet) => Number(octet) <= 255);
  }
  return false;
}

export interface CompatBaseUrlValidation {
  /** URL parseada (base da API, ex.: `http://127.0.0.1:1234/v1`). */
  url: URL;
  /** True se o host é loopback (localhost/127.0.0.0/8/::1). */
  isLoopback: boolean;
}

/**
 * Valida uma baseURL custom para o adapter OpenAI-compatible (fail-fast no
 * construtor). Regras (segurança default, configurável):
 *   - apenas http/https (outro esquema → ApiError 400);
 *   - http para host NÃO-loopback → bloqueado por default
 *     (`allowNonLoopbackHttp: true` libera); https remoto sempre permitido.
 */
export function validateCompatBaseUrl(
  raw: string,
  opts: { allowNonLoopbackHttp?: boolean } = {},
): CompatBaseUrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(
      `openai-compat: baseURL inválida: "${raw}" — URL absoluta http/https esperada`,
      400,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiError(
      `openai-compat: baseURL "${raw}" usa protocolo "${url.protocol}" — apenas http/https`,
      400,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ApiError(`openai-compat: baseURL não pode conter credenciais`, 400);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ApiError(
      `openai-compat: baseURL "${raw}" não pode conter query ou hash`,
      400,
    );
  }
  const isLoopback = isLoopbackHost(url.hostname);
  if (url.protocol === "http:" && !isLoopback && !(opts.allowNonLoopbackHttp ?? false)) {
    throw new ApiError(
      `openai-compat: baseURL http para host não-loopback "${url.hostname}" bloqueada ` +
        `por segurança (use https ou allowNonLoopbackHttp: true)`,
      400,
    );
  }
  return { url, isLoopback };
}

export interface OpenAiCompatAdapterOptions {
  /**
   * URL base da API compatível (OBRIGATÓRIA). O adapter anexa
   * `/chat/completions` e envia `req.model` no corpo (par baseURL+model).
   */
  baseUrl?: string;
  /** Provider "nomeado" no registry (default "openai-compat"). */
  name?: string;
  /** Chave de API fornecida diretamente (testes/mocks). Sobrepoe a keystore. */
  apiKey?: string;
  /** Keystore (T4) para `reveal` da chave por namespace scoped:v1:provider:<name>:apiKey. */
  keystore?: Keystore;
  /** Idle timeout reset on every response body chunk. Default 120_000 ms. */
  timeoutMs?: number;
  /** Absolute request duration cap. Default 900_000 ms. */
  maxDurationMs?: number;
  /** `fetch` injetável (testes usam o do Node; prod usa globalThis.fetch). */
  fetchImpl?: typeof fetch;
  /**
   * Libera http para host não-loopback (default false — bloqueio de segurança;
   * https remoto SEMPRE permitido).
   */
  allowNonLoopbackHttp?: boolean;
  /**
   * Opt-in do usuário: envia `reasoning_effort` no corpo chat.completions.
   * Default false — endpoints estritos podem rejeitar parâmetros desconhecidos
   * com HTTP 400 (normalizado como erro de validação na UI).
   */
  sendReasoningEffort?: boolean;
}

/**
 * Adapter OpenAI-compatible (chat.completions stream com baseURL custom) —
 * implementa `ProviderAdapter`. `streamChat` emite `delta` e `tool-call` e
 * resolve ao fim do stream; erros são LANÇADOS e o roteador os converte em
 * evento `error` (nunca lança para o consumidor final).
 *
 * Chave OPCIONAL: sem `apiKey` e sem registro na keystore, o request sai sem
 * header Authorization (endpoints custom podem não exigir chave).
 */
export class OpenAiCompatAdapter implements ProviderAdapter {
  readonly tracksTransport = true;
  readonly name: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxDurationMs: number;
  readonly allowNonLoopbackHttp: boolean;
  private readonly apiKey?: string;
  private readonly keystore?: Keystore;
  private readonly sendReasoningEffort: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiCompatAdapterOptions = {}) {
    this.name = opts.name ?? OPENAI_COMPAT_PROVIDER_NAME;
    // Validação de URL no construtor (fail-fast): apenas http/https, http
    // não-loopback bloqueado por default, https remoto permitido.
    const { url } = validateCompatBaseUrl(opts.baseUrl ?? "", {
      allowNonLoopbackHttp: opts.allowNonLoopbackHttp,
    });
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxDurationMs = opts.maxDurationMs ?? Math.max(900_000, this.timeoutMs);
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("OpenAI-compatible idle timeout is invalid");
    if (!Number.isSafeInteger(this.maxDurationMs) || this.maxDurationMs < this.timeoutMs) throw new Error("OpenAI-compatible max duration is invalid");
    this.allowNonLoopbackHttp = opts.allowNonLoopbackHttp ?? false;
    this.apiKey = opts.apiKey;
    this.keystore = opts.keystore;
    this.sendReasoningEffort = opts.sendReasoningEffort ?? false;
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  serializeRequest(req: ProviderChatRequest): string {
    const body = buildChatBody(req);
    if (this.sendReasoningEffort && req.reasoningEffort !== undefined) body.reasoning_effort = req.reasoningEffort;
    return JSON.stringify(body);
  }

  /**
   * Resolve a chave de API: direta (testes) ou keystore (namespace scoped:v1).
   * Retorna `undefined` quando NÃO há chave configurada — para
   * OpenAI-compatible a chave é OPCIONAL (o request segue sem Authorization).
   */
  private async resolveApiKey(): Promise<string | undefined> {
    if (this.apiKey !== undefined) return this.apiKey;
    if (this.keystore !== undefined) {
      const revealed = await this.keystore.reveal(this.name);
      if (revealed !== null && revealed.length > 0) return revealed;
    }
    return undefined;
  }

  /** Lê o corpo SSE e emite `delta`/`tool-call` (reuso do acumulador T6). */
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
        throw new ApiError("openai-compat: frame SSE inválido", 502, data);
      }
      if (typeof parsed !== "object" || parsed === null) return false;
      const payload = parsed as Record<string, unknown>;
      const usage = parseProviderUsage(payload.usage, "chat");
      if (usage) emit({ type: "usage", usage });
      if (typeof payload.error === "object" && payload.error !== null) {
        const error = payload.error as Record<string, unknown>;
        throw new ApiError(
          typeof error.message === "string" ? error.message : "openai-compat: erro no stream",
          openAiStreamErrorStatus(error),
          parsed,
        );
      }
      const choices = payload.choices;
      if (!Array.isArray(choices)) {
        throw new ApiError("openai-compat: frame SSE sem choices", 502, parsed);
      }
      if (choices.length === 0) return false;
      const choice = choices[0] as Record<string, unknown> | undefined;
      const currentFinishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
      const delta = choice?.delta;
      // Preserve a final chunk's delta before recording its finish reason;
      // later frames are consumed only for protocol/usage completion.
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
        if (buffer.length > 1_048_576) throw new ApiError("openai-compat: buffer SSE excedeu 1 MiB", 502);
        let boundary = findSseFrameBoundary(buffer);
        while (boundary !== undefined) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          if (dispatchFrame(frame)) { terminated = true; break; }
          boundary = findSseFrameBoundary(buffer);
        }
      }
      if (!terminated) throw new ApiError("openai-compat: stream terminou antes de [DONE]", 502);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (isIncompleteReason(finishReason)) {
      throw new ApiError(`openai-compat: geração interrompida (${finishReason})`, 400, finishPayload, { code: finishReason });
    }
    if (toolAccumulator.hasAny && !toolAccumulator.complete) {
      throw new ApiError("openai-compat: tool call incompleta no fim do stream", 502);
    }
    for (const call of toolAccumulator.calls()) emit({ type: "tool-call", call });
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
      // Chave OPCIONAL, mas sua resolução também respeita abort/timeout.
      const apiKey = await raceWithAbort(this.resolveApiKey(), controller.signal);
      const endpoint = new URL(this.baseUrl);
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/chat/completions`;
      const url = endpoint.toString();

      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "text/event-stream",
        "x-openbot-purpose": req.purpose ?? "turn",
      };
      if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;

      try {
        const body = this.serializeRequest(req);
        controller.signal.throwIfAborted();
        req.onTransportStart?.("chat");
        response = await raceWithAbort(this.fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        }), controller.signal);
        resetIdleTimer();
      } catch (err) {
        if (timeoutError !== undefined) throw timeoutError;
        throw normalizeOpenAiError(err);
      }

      if (!response.ok) {
        let message = `openai-compat: HTTP ${response.status}`;
        let responseBody: unknown = undefined;
        try {
          const errorBody = await readErrorBody(response, controller.signal);
          const text = errorBody.text;
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // corpo não-JSON — mantém o texto bruto
          }
          const extracted = extractOpenAiErrorMessage(parsed);
          if (extracted !== undefined) message = `openai-compat: HTTP ${response.status} — ${extracted}`;
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
        throw new ApiError("openai-compat: resposta sem corpo (stream vazio)", 502);
      }

      await this.readStream(response.body, emit, controller.signal, resetIdleTimer);
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
 * Registra o adapter OpenAI-compatible no registry default do roteador como
 * "openai-compat" (contrato `ProviderRegistry.register` de T5). Chamado no
 * boot (T8) e pelos testes.
 *
 * SEM `baseUrl` (nenhuma baseURL custom configurada) o adapter NÃO registra e
 * retorna `undefined` — o provider não existe até ter baseURL (MVP: env
 * `OPENBOT_COMPAT_BASE_URL` no boot; T14 pluga a config local).
 */
export function registerOpenAiCompatAdapter(
  opts: OpenAiCompatAdapterOptions = {},
): OpenAiCompatAdapter | undefined {
  if (opts.baseUrl === undefined || opts.baseUrl.length === 0) return undefined;
  const adapter = new OpenAiCompatAdapter(opts);
  defaultRegistry.register(adapter);
  return adapter;
}

export function unregisterOpenAiCompatAdapter(name = OPENAI_COMPAT_PROVIDER_NAME): boolean {
  return defaultRegistry.unregister(name);
}
