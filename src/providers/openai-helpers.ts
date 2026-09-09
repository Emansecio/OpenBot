/**
 * T6 — Helpers compartilhados dos adapters "OpenAI-like" (src/providers/).
 *
 * Base comum para T6 (OpenAI), T7 (xAI/Grok) e T8 (OpenAI-compat com baseURL
 * custom). Tudo que é reutilizável de um adapter chat.completions `stream:true`
 * vive aqui, para os três não duplicarem:
 *
 *   - `OpenAiChatBody` + `buildChatBody(req)` — corpo JSON normalizado do
 *     endpoint chat/completions (`stream:true`, `tools` opcionais, system
 *     inline na lista de mensagens — não dependemos de convenções de
 *     separação de `system` por provider);
 *   - `parseOpenAiSseChunk` — parser linha-a-linha do SSE da OpenAI
 *     (linhas `data:`/`event:`/`:` + JSON; termina com `[DONE]`; sem
 *     dependência de fetch stream, funciona para qualquer Reader);
 *   - `OpenAiToolCallAccumulator` — acumulador de `delta.tool_calls` → tool
 *     call COMPLETA (id/name/arguments concatenados por índice, ordem de
 *     chegada preservada — shape `ProviderToolCall` do roteador);
 *   - `OpenAiSseFrame` — uma linha `data:` já parseada (nula no heartbeat
 *     `:ping`/comentários);
 *   - `normalizeOpenAiError(err)` — enriquece erros crus do transporte com
 *     `status`/`code` para o `classifyProviderError` do roteador (429/5xx/
 *     rede/auth/validação — transiente vs permanente, spec §3.1);
 *   - `extractOpenAiErrorMessage(body)` — extrai a mensagem legível do corpo
 *     de erro JSON da OpenAI (`error.message`), com fallbacks robustos.
 */

import type {
  ProviderChatMessage,
  ProviderChatRequest,
  ProviderTool,
  ProviderToolCall,
} from "./router.js";

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

/** Frame `data:` do SSE da OpenAI já parseado (nulo para heartbeat/comentário). */
export type OpenAiSseFrame =
  | {
      /** `null` quando `data: [DONE]` (fim do stream). */
      data: unknown;
      /** `event:` do SSE quando presente (ex.: `error`). */
      event?: string;
    }
  | null;

/** Uma linha SSE bruta ("data: {...}" | "event: x" | ":" comentário | ""). */
export interface OpenAiSseLine {
  field: string;
  value: string;
}

/** Corpo JSON do POST chat/completions (OpenAI-like). */
export interface OpenAiChatBody {
  model: string;
  messages: unknown[];
  stream: true;
  tools?: ProviderTool[];
  temperature?: number;
  max_tokens?: number;
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
 * Interpreta uma linha SSE bruta. Linhas que começam com `:` são comentários
 * (heartbeat `:ping` do gateway — ignorados); `event:` opcional; `data:` pode
 * aparecer múltiplas vezes (campos SSE são multi-linha) — juntamos com `\n`.
 */
export function parseSseLine(line: string): OpenAiSseLine | null {
  if (line.length === 0 || line.startsWith(":")) return null;
  const colon = line.indexOf(":");
  if (colon === -1) {
    // Linha sem campo (ex.: "data" sem valor) — tratada como data vazia.
    return { field: line.trim(), value: "" };
  }
  const field = line.slice(0, colon).trim();
  // Após o `:` um espaço único é opcional e removido (spec SSE).
  let value = line.slice(colon + 1);
  if (value.startsWith(" ")) value = value.slice(1);
  return { field, value };
}

/**
 * Localiza o primeiro delimitador de frame SSE sem confundir um `\r\n`
 * dividido entre chunks com duas quebras de linha. Um `\r` no fim do buffer é
 * mantido pendente até o próximo chunk, quando pode ser distinguido de CR puro.
 */
export function findSseFrameBoundary(
  buffer: string,
): { index: number; length: number } | undefined {
  const lineEndingLength = (index: number): number => {
    const char = buffer[index];
    if (char === "\n") return 1;
    if (char !== "\r") return 0;
    if (index + 1 >= buffer.length) return -1;
    return buffer[index + 1] === "\n" ? 2 : 1;
  };

  for (let index = 0; index < buffer.length; index += 1) {
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
export function openAiStreamErrorStatus(error: Record<string, unknown>): number {
  if (typeof error.status === "number" && Number.isInteger(error.status)) return error.status;
  const signature = [error.code, error.type, error.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (/rate[ _-]?limit|too many requests/iu.test(signature)) return 429;
  if (/auth|api[ _-]?key|unauthori[sz]ed|forbidden/iu.test(signature)) return 401;
  if (/overload|server|internal|unavailable/iu.test(signature)) return 503;
  return 400;
}

/**
 * Parser de um chunk SSE completo: interpreta cada linha `data:` como um frame
 * (`[DONE]` → `{data: null}`). Heartbeats (`:ping`), linhas vazias e campos
 * não-`data` são ignorados. Pensado para chunks COMPLETOS (fixtures, testes,
 * reuso por T7/T8); o adapter lê linha a linha o corpo do fetch com a mesma
 * semântica (`data: [DONE]` encerra).
 */
export function parseOpenAiSseChunk(chunk: string): OpenAiSseFrame[] {
  const frames: OpenAiSseFrame[] = [];
  for (const line of splitSseLines(chunk)) {
    const parsed = parseSseLine(line);
    if (parsed === null) continue;
    if (parsed.field !== "data") continue;
    if (parsed.value === "[DONE]") {
      frames.push({ data: null });
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(parsed.value);
    } catch {
      // JSON inválido em um frame `data:` → frame descartável (o stream
      // continua; erros reais do provider vêm como HTTP status ≠ 200).
      continue;
    }
    frames.push({ data, event: undefined });
  }
  return frames;
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
      content: message.content,
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
 * acumulamos por índice e devolvemos as calls na ordem em que apareceram pela
 * primeira vez. `arguments` é uma STRING (JSON em texto) — o consumidor
 * (turn runner de T9+) faz o parse quando for executar a tool.
 */
export class OpenAiToolCallAccumulator {
  private readonly byIndex = new Map<number, ProviderToolCall>();
  private readonly order: number[] = [];

  /** Registra um delta de tool call (id/name/arguments fragmentados). */
  add(chunk: OpenAiToolCallChunk): void {
    if (typeof chunk.index !== "number") return;
    const index = chunk.index;
    let call = this.byIndex.get(index);
    if (call === undefined) {
      call = { id: "", type: "function", function: { name: "", arguments: "" } };
      this.byIndex.set(index, call);
      this.order.push(index);
    }
    if (typeof chunk.id === "string") call.id = chunk.id;
    const fn = chunk.function;
    if (fn !== undefined) {
      if (typeof fn.name === "string") call.function.name += fn.name;
      if (typeof fn.arguments === "string") call.function.arguments += fn.arguments;
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

  /** Devolve as tool calls completas NA ORDEM em que apareceram. */
  calls(): ProviderToolCall[] {
    const out: ProviderToolCall[] = [];
    for (const index of this.order) {
      const call = this.byIndex.get(index);
      if (call !== undefined) out.push(call);
    }
    return out;
  }

  /** Limpa o estado (novo turno). */
  reset(): void {
    this.byIndex.clear();
    this.order.length = 0;
  }
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
  readonly status: number;
  readonly body?: unknown;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, body?: unknown, opts: { retryAfterMs?: number } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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
