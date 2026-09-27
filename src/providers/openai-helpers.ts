/**
 * Shared transport of the OpenAI-like adapters (OpenAI, xAI, OpenAI-compatible)
 * and of the OpenCode "messages" transport:
 *
 *   - request bodies: `buildChatBody` / `toOpenAiMessage`;
 *   - SSE reading: `readSseFrames` (frame boundaries, 1 MiB caps, EOF flush,
 *     reader always cancelled) and `sseFrameData`;
 *   - Chat Completions stream handling: `createChatCompletionsStreamHandler`
 *     (deltas, usage, tool-call accumulation, fail-closed finish reasons);
 *   - request deadlines: `startProviderDeadline` (idle + absolute timeouts
 *     bound to the caller's abort signal);
 *   - errors: `providerHttpError` (bounded body, provider message,
 *     Retry-After), `normalizeOpenAiError`, `ApiError` / `OpenAIError`.
 */

import type {
  ProviderChatMessage,
  ProviderChatRequest,
  ProviderStreamEvent,
  ProviderTool,
  ProviderToolCall,
} from "./router.js";
import { parseProviderUsage } from "./usage.js";
import { providerToolResultContent } from "./tool-calls.js";

/** Dado de uma tool call no formato nativo do chat.completions (delta ou completo). */
export interface OpenAiToolCallChunk {
  id?: string;
  index?: number;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

/** Corpo JSON do POST chat/completions (OpenAI-like). */
export interface OpenAiChatBody {
  model: string;
  messages: unknown[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: ProviderTool[];
  temperature?: number;
  max_tokens?: number;
  /** Enviado só quando o adapter declara suporte ao parâmetro (xAI/compat opt-in). */
  reasoning_effort?: string;
}

/**
 * Separa um buffer SSE em linhas. O SSE da OpenAI usa `\n` como separador e
 * `\r\n` aparece em alguns clientes de teste; normalizamos ambos. Linhas
 * vazias são descartadas (delimitadores de frame não são linhas de conteúdo).
 */
export function splitSseLines(raw: string): string[] {
  return raw.split(/\r\n|\n|\r/).filter((line) => line.length > 0);
}

/**
 * Localiza o primeiro delimitador de frame SSE sem confundir um `\r\n`
 * dividido entre chunks com duas quebras de linha. Um `\r` no fim do buffer é
 * mantido pendente até o próximo chunk, quando pode ser distinguido de CR puro.
 */
export function findSseFrameBoundary(
  buffer: string,
  start = 0,
): { index: number; length: number } | undefined {
  const lineEndingLength = (index: number): number => {
    const char = buffer[index];
    if (char === "\n") return 1;
    if (char !== "\r") return 0;
    if (index + 1 >= buffer.length) return -1;
    return buffer[index + 1] === "\n" ? 2 : 1;
  };

  for (let index = Math.max(0, start); index < buffer.length; index += 1) {
    const first = lineEndingLength(index);
    if (first < 0) return undefined;
    if (first === 0) continue;
    const second = lineEndingLength(index + first);
    if (second < 0) return undefined;
    if (second > 0) return { index, length: first + second };
    index += first - 1;
  }
  return undefined;
}

/**
 * Faz uma Promise respeitar um AbortSignal inclusive quando a operação
 * subjacente (por exemplo, uma leitura de keystore) não aceita signal.
 */
export function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    // Fecha a janela entre o teste inicial e o registro do listener.
    if (signal.aborted) onAbort();
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("This operation was aborted", "AbortError");
}

/** Erro explícito de timeout interno, classificado pelo router como network. */
export function providerTimeoutError(timeoutMs: number): OpenAIError {
  return new OpenAIError(`provider request timed out after ${timeoutMs} ms`, {
    code: "ETIMEDOUT",
  });
}

/** Parses HTTP Retry-After (seconds or date) and caps waits at one minute. */
export function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value.trim());
  const rawMs = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : Date.parse(value) - nowMs;
  if (!Number.isFinite(rawMs) || rawMs < 0) return undefined;
  return Math.min(60_000, Math.round(rawMs));
}

/** Maps an error embedded in an otherwise successful SSE response. */
export function openAiStreamErrorStatus(error: Record<string, unknown>, fallback = 400): number {
  if (typeof error.status === "number" && Number.isInteger(error.status)) return error.status;
  const signature = [error.code, error.type, error.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (/rate[ _-]?limit|too many requests/iu.test(signature)) return 429;
  if (/auth|api[ _-]?key|unauthori[sz]ed|forbidden/iu.test(signature)) return 401;
  if (/permission/iu.test(signature)) return 403;
  if (/invalid|not_found|not found|context_length|content_filter|quota|billing/iu.test(signature)) return 400;
  if (/overload|server|internal|unavailable/iu.test(signature)) return 503;
  return fallback;
}

export type OpenAiFinishDisposition = "success" | "incomplete" | "unknown" | "absent";

/** Fail-closed classification shared by OpenAI-compatible Chat transports. */
export function classifyOpenAiFinishReason(reason: string | undefined): OpenAiFinishDisposition {
  if (reason === undefined) return "absent";
  if (reason === "stop" || reason === "tool_calls" || reason === "function_call") return "success";
  if (reason === "length" || reason === "content_filter" || reason === "max_tokens") return "incomplete";
  return "unknown";
}

/** A completed tool call must carry one JSON object; empty means an empty object. */
export function normalizeToolCallArguments(argumentsText: string, label: string): string {
  const normalized = argumentsText.trim().length === 0 ? "{}" : argumentsText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new ApiError(`${label}: argumentos de tool call não formam JSON completo`, 502);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(`${label}: argumentos de tool call devem ser um objeto JSON`, 502);
  }
  return normalized;
}

/**
 * Converte uma mensagem normalizada (`ProviderChatMessage`) para o shape de
 * mensagem do chat.completions. `role: "tool"` vira `{role:"tool",
 * tool_call_id, content}`; as demais preservam role/content e o `name`
 * opcional.
 */
export function toOpenAiMessage(message: ProviderChatMessage): unknown {
  if (message.role === "tool") {
    return {
      role: "tool" as const,
      tool_call_id: message.toolCallId ?? "",
      content: providerToolResultContent(message),
    };
  }
  const out: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
    out.tool_calls = message.toolCalls;
  }
  if (message.role !== "assistant" && message.name !== undefined && message.name.length > 0) out.name = message.name;
  return out;
}

/**
 * Monta o corpo JSON do chat.completions (stream:true + tools + temperatura +
 * max_tokens). O system prompt vai como a PRIMEIRA mensagem da lista (não
 * dependemos de convenções de separação de system por provider — xAI,
 * OpenAI-compat e OpenAI aceitam `role:"system"` na lista).
 */
export function buildChatBody(req: ProviderChatRequest): OpenAiChatBody {
  const messages: unknown[] = [];
  if (req.system !== undefined && req.system.length > 0) {
    messages.push({ role: "system", content: req.system });
  }
  for (const message of req.messages) {
    messages.push(toOpenAiMessage(message));
  }
  const body: OpenAiChatBody = {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools !== undefined && req.tools.length > 0) body.tools = req.tools;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) {
    if (!Number.isSafeInteger(req.maxTokens) || req.maxTokens <= 0) throw new Error("provider: maxTokens inválido");
    body.max_tokens = req.maxTokens;
  }
  return body;
}

/**
 * Acumulador de `delta.tool_calls` do SSE da OpenAI → tool call COMPLETA
 * (shape `ProviderToolCall` do roteador).
 *
 * No streaming da OpenAI cada chunk traz um fragmento da tool call por
 * `index` (id/name no primeiro, `arguments` concatenados nos seguintes). Aqui
 * acumulamos por índice e devolvemos as calls na ordem numérica declarada.
 * `arguments` é uma STRING (JSON em texto) — o consumidor
 * (turn runner de T9+) faz o parse quando for executar a tool.
 */
export class OpenAiToolCallAccumulator {
  private readonly byIndex = new Map<number, ProviderToolCall>();
  private readonly order: number[] = [];

  /** Registra um delta de tool call (id/name/arguments fragmentados). */
  add(chunk: OpenAiToolCallChunk): void {
    if (!Number.isSafeInteger(chunk.index) || (chunk.index as number) < 0) {
      throw new ApiError("openai-like: tool call sem índice válido", 502, chunk);
    }
    if (chunk.type !== undefined && chunk.type !== "function") {
      throw new ApiError("openai-like: tipo de tool call não suportado", 502, chunk);
    }
    const index = chunk.index as number;
    let call = this.byIndex.get(index);
    if (call === undefined) {
      call = { id: "", type: "function", function: { name: "", arguments: "" } };
      this.byIndex.set(index, call);
      this.order.push(index);
    }
    if (chunk.id !== undefined) {
      if (typeof chunk.id !== "string") throw new ApiError("openai-like: id de tool call inválido", 502, chunk);
      if (call.id.length > 0 && chunk.id.length > 0 && call.id !== chunk.id) {
        throw new ApiError("openai-like: id de tool call mudou durante o stream", 502, chunk);
      }
      if (chunk.id.length > 0) call.id = chunk.id;
    }
    const fn = chunk.function;
    if (fn !== undefined) {
      if (typeof fn !== "object" || fn === null || Array.isArray(fn)) throw new ApiError("openai-like: função de tool call inválida", 502, chunk);
      if (fn.name !== undefined) {
        if (typeof fn.name !== "string") throw new ApiError("openai-like: nome de tool call inválido", 502, chunk);
        call.function.name += fn.name;
      }
      if (fn.arguments !== undefined) {
        if (typeof fn.arguments !== "string") throw new ApiError("openai-like: argumentos de tool call inválidos", 502, chunk);
        call.function.arguments += fn.arguments;
      }
    }
  }

  /** True se pelo menos uma tool call parcial foi acumulada. */
  get hasAny(): boolean {
    return this.order.length > 0;
  }

  /** True se TODAS as tool calls acumuladas têm id e nome completos. */
  get complete(): boolean {
    return (
      this.order.length > 0 &&
      this.order.every((index) => {
        const call = this.byIndex.get(index);
        return call !== undefined && call.id.length > 0 && call.function.name.length > 0;
      })
    );
  }

  /** Devolve as tool calls pelo índice declarado, não pela ordem de chegada. */
  calls(): ProviderToolCall[] {
    const out: ProviderToolCall[] = [];
    for (const index of [...this.order].sort((left, right) => left - right)) {
      const call = this.byIndex.get(index);
      if (call !== undefined) out.push(call);
    }
    return out;
  }

  /** Valida identidade única e argumentos completos antes de liberar execução. */
  finalizedCalls(label = "openai-like"): ProviderToolCall[] {
    if (!this.complete) throw new ApiError(`${label}: tool call incompleta no fim do stream`, 502);
    const ids = new Set<string>();
    return this.calls().map((call) => {
      if (ids.has(call.id)) throw new ApiError(`${label}: id de tool call duplicado`, 502, call);
      ids.add(call.id);
      return {
        ...call,
        function: {
          ...call.function,
          arguments: normalizeToolCallArguments(call.function.arguments, label),
        },
      };
    });
  }

  /** Limpa o estado (novo turno). */
  reset(): void {
    this.byIndex.clear();
    this.order.length = 0;
  }
}

/** The `data:` payload of one SSE frame (multi-line data joined), or "" when it has none. */
export function sseFrameData(frame: string): string {
  return splitSseLines(frame)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
}

const MAX_SSE_FRAME_BYTES = 1_048_576;

/**
 * Reads an SSE body frame by frame until `onFrame` returns true (a terminal
 * frame). A frame still in the buffer at EOF — a server that closes right
 * after `data: [DONE]\n` without the blank line — is dispatched as well.
 * Resolves true when a terminal frame was seen. The reader is always
 * cancelled and released, also on parse/emit errors.
 */
export async function readSseFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onActivity: () => void,
  label: string,
  onFrame: (frame: string) => boolean,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) break;
      onActivity();
      // A delimiter can straddle chunks by at most three characters (\r\n\r).
      let scanFrom = Math.max(0, buffer.length - 3);
      buffer += decoder.decode(value, { stream: true });
      let boundary = findSseFrameBoundary(buffer, scanFrom);
      while (boundary !== undefined) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        if (Buffer.byteLength(frame, "utf8") > MAX_SSE_FRAME_BYTES) throw new ApiError(`${label}: frame SSE excedeu 1 MiB`, 502);
        if (onFrame(frame)) return true;
        scanFrom = 0;
        boundary = findSseFrameBoundary(buffer, scanFrom);
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_FRAME_BYTES) throw new ApiError(`${label}: buffer SSE residual excedeu 1 MiB`, 502);
    }
    const trailing = (buffer + decoder.decode()).replace(/[\r\n]+$/u, "");
    return trailing.length > 0 && onFrame(trailing);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Chat Completions stream (OpenAI, xAI, OpenAI-compatible): `dispatchFrame`
 * emits deltas and usage and accumulates tool calls, returning true on
 * `[DONE]`; `finish` rejects incomplete/unknown finish reasons and emits the
 * completed tool calls.
 */
export function createChatCompletionsStreamHandler(
  label: string,
  emit: (event: ProviderStreamEvent) => void,
): { dispatchFrame(frame: string): boolean; finish(): void } {
  const toolAccumulator = new OpenAiToolCallAccumulator();
  let finishReason: string | undefined;
  let finishPayload: unknown;
  return {
    dispatchFrame(frame) {
      const data = sseFrameData(frame);
      if (data.length === 0) return false;
      if (data === "[DONE]") return true;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch {
        throw new ApiError(`${label}: frame SSE inválido`, 502, data);
      }
      if (typeof parsed !== "object" || parsed === null) return false;
      const payload = parsed as Record<string, unknown>;
      const usage = parseProviderUsage(payload.usage, "chat");
      if (usage) emit({ type: "usage", usage });
      if (typeof payload.error === "object" && payload.error !== null) {
        const error = payload.error as Record<string, unknown>;
        throw new ApiError(
          typeof error.message === "string" ? error.message : `${label}: erro no stream`,
          openAiStreamErrorStatus(error),
          parsed,
        );
      }
      const choices = payload.choices;
      if (!Array.isArray(choices)) throw new ApiError(`${label}: frame SSE sem choices`, 502, parsed);
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
          if (typeof chunk === "object" && chunk !== null) toolAccumulator.add(chunk as OpenAiToolCallChunk);
        }
      }
      if (finishReason === undefined && currentFinishReason !== undefined) {
        finishReason = currentFinishReason;
        finishPayload = parsed;
      }
      return false;
    },
    finish() {
      const disposition = classifyOpenAiFinishReason(finishReason);
      if (disposition === "incomplete" || disposition === "unknown") {
        throw new ApiError(`${label}: geração interrompida (${finishReason})`, disposition === "incomplete" ? 400 : 502, finishPayload, { code: finishReason });
      }
      if (toolAccumulator.hasAny) {
        for (const call of toolAccumulator.finalizedCalls(label)) emit({ type: "tool-call", call });
      }
    },
  };
}

/** Idle + absolute deadlines of one provider request, bound to the caller's signal. */
export interface ProviderDeadline {
  readonly signal: AbortSignal;
  /** The timeout that aborted the request, if one did. */
  readonly timeoutError: OpenAIError | undefined;
  /** Restart the idle timer (every response chunk counts as activity). */
  resetIdle(): void;
  dispose(): void;
}

export function startProviderDeadline(parent: AbortSignal | undefined, idleMs: number, maxMs: number): ProviderDeadline {
  const controller = new AbortController();
  let timeoutError: OpenAIError | undefined;
  const onAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(parent?.reason);
  };
  parent?.addEventListener("abort", onAbort, { once: true });
  if (parent?.aborted) onAbort();
  const expire = (ms: number): void => {
    if (controller.signal.aborted) return;
    timeoutError = providerTimeoutError(ms);
    controller.abort(timeoutError);
  };
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (controller.signal.aborted) return;
    idleTimer = setTimeout(() => expire(idleMs), idleMs);
  };
  resetIdle();
  const maxTimer = setTimeout(() => expire(maxMs), maxMs);
  return {
    signal: controller.signal,
    get timeoutError() { return timeoutError; },
    resetIdle,
    dispose() {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

const MAX_ERROR_BODY_BYTES = 64 * 1024;
export const ERROR_BODY_TRUNCATION_MESSAGE = "corpo de erro truncado";
const ERROR_BODY_TRUNCATION_MARKER = `\n[${ERROR_BODY_TRUNCATION_MESSAGE} após ${MAX_ERROR_BODY_BYTES} bytes]`;

/** Reads at most 64 KiB of an error response body. */
export async function readErrorBody(
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
    // A cut in the middle of a multi-byte character must not flush as U+FFFD.
    if (!truncated) parts.push(decoder.decode());
    if (truncated) parts.push(ERROR_BODY_TRUNCATION_MARKER);
    return { text: parts.join(""), truncated };
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * A non-2xx provider response as an `ApiError`: the provider's own message
 * (so context-overflow and auth errors stay recognizable), the parsed body and
 * the Retry-After hint.
 */
export async function providerHttpError(
  label: string,
  response: Response,
  signal: AbortSignal,
  onActivity?: () => void,
): Promise<ApiError> {
  let message = `${label}: HTTP ${response.status}`;
  let responseBody: unknown;
  try {
    const errorBody = await readErrorBody(response, signal, onActivity);
    let parsed: unknown = errorBody.text;
    try {
      parsed = JSON.parse(errorBody.text);
    } catch {
      // not JSON: keep the raw text
    }
    const extracted = extractOpenAiErrorMessage(parsed);
    if (extracted !== undefined) message = `${message} — ${extracted}`;
    if (errorBody.truncated) message = `${message} — ${ERROR_BODY_TRUNCATION_MESSAGE}`;
    responseBody = parsed;
  } catch {
    // unreadable body: the status line is all we have
  }
  return new ApiError(message, response.status, responseBody, {
    retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
  });
}

/** Extrai a mensagem legível do corpo de erro JSON da OpenAI. */
export function extractOpenAiErrorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.length > 0) return record.message;
  if (typeof record.error === "string" && record.error.length > 0) return record.error;
  if (typeof record.error === "object" && record.error !== null) {
    const error = record.error as Record<string, unknown>;
    if (typeof error.message === "string" && error.message.length > 0) return error.message;
  }
  return undefined;
}

/**
 * Normaliza um erro cru do transporte HTTP (fetch) para o que o
 * `classifyProviderError` do roteador entende:
 *   - o erro nativo do fetch (`TypeError: fetch failed`) NÃO carrega status —
 *     adicionamos `code:"UND_ERR_"`/`ECONN*` quando reconhecido para virar
 *     `network` (transiente);
 *   - o corpo de erro da OpenAI (401/429/5xx) vira um `ApiError` com `status`
 *     + mensagem legível — classificação correta de auth/rate-limit/server;
 *   - erro de resposta HTTP (ex.: 404 com body não-JSON) vira `ApiError` com
 *     `status` e mensagem padrão.
 */
export function normalizeOpenAiError(err: unknown): Error {
  if (err instanceof ApiError || err instanceof OpenAIError) return err;
  if (err instanceof Error) {
    const record = err as Error & { code?: unknown };
    const message = err.message;
    // `fetch failed` do undici: causa raiz carrega o código de rede real.
    const cause = record.cause;
    if (message === "fetch failed" && cause instanceof Error) {
      const causeRecord = cause as Error & { code?: unknown };
      return new OpenAIError(message, { cause, code: causeRecord.code });
    }
    return new OpenAIError(message, { cause: err, code: record.code });
  }
  return new OpenAIError(String(err), { cause: err });
}

/** Erro de API do provider (status HTTP + mensagem legível). */
export class ApiError extends Error {
  readonly code?: string;
  readonly status: number;
  readonly body?: unknown;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, body?: unknown, opts: { retryAfterMs?: number; code?: string } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = opts.code;
    this.body = body;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Erro de transporte/stream do provider (rede, parse, aborts — sem status). */
export class OpenAIError extends Error {
  readonly code?: unknown;

  constructor(
    message: string,
    opts: { cause?: unknown; code?: unknown } = {},
  ) {
    super(message);
    this.name = "OpenAIError";
    this.code = opts.code;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}
