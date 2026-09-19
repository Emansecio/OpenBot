/**
 * T5 — Roteador unificado de inferência (plano §3 T5; spec §3.1/§3.2).
 *
 * Contrato estável de chat via stream, independente dos adapters concretos
 * (T6 OpenAI, T7 xAI, T8 OpenAI-compat — implementam `ProviderAdapter` e são
 * registrados aqui; NENHUM adapter concreto vive neste arquivo).
 *
 * Design:
 *   - `ProviderChatRequest`: pedido normalizado que qualquer provider entende
 *     (model global único, system + messages + tools opcionais, temperature,
 *     maxTokens e AbortSignal para cancelamento).
 *   - `ProviderStreamEvent`: eventos observáveis do stream. O evento `message`
 *     entrega SEMPRE uma mensagem COMPLETA (papel do acumulador de deltas —
 *     os deltas do provider são transformados em mensagem por aqui, porque o
 *     consumidor — turn runner de T10 — espera mensagens completas, spec
 *     §3.1/§3.2). `done` e `error` são terminais.
 *   - `ProviderError`: erro normalizado com `kind` permanente vs transiente e
 *     `retryable` derivado. `classifyProviderError` faz o mapeamento
 *     (transientes: 429/5xx/rede; permanentes: 4xx de auth/validação).
 *
 * Regra de uso: `streamChat` nunca lança — o erro sai como evento `error`.
 */

import { randomUUID } from "node:crypto";
import type { ReasoningEffort } from "../shared/contracts.js";
import type { ProviderUsage } from "./usage.js";
import { ProviderAdmissionError, type ProviderAdmissionLease, type ProviderAdmissionScheduler } from "./admission.js";
import { resolveProviderCapabilities } from "./capabilities.js";
import { ResumeProtocolError, validateOpaqueResumeCursor } from "./resume.js";

/** Papel de uma mensagem no diálogo normalizado (espelho do transcript). */
export type ProviderMessageRole = "system" | "user" | "assistant" | "tool";

/** Tool em formato OpenAI-like (schema de entrada para o provider). */
export interface ProviderTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    /** JSON Schema do argumento (mesmo shape usado por T6/T7/T8). */
    parameters?: Record<string, unknown>;
  };
}

/** Mensagem do diálogo normalizado. `role: "tool"` carrega o resultado. */
export type ProviderUserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export type ProviderChatMessage = {
  role: "system";
  content: string;
  name?: string;
} | {
  role: "user";
  content: string | ProviderUserContentPart[];
  name?: string;
} | {
  role: "assistant";
  content: string;
  toolCalls?: ProviderToolCall[];
} | {
  role: "tool";
  content: string;
  toolCallId?: string;
};

/**
 * Pedido normalizado de chat — o mesmo shape para todos os providers.
 * `signal` propaga o cancelamento do turno (AbortSignal do consumidor).
 */
export interface ProviderChatRequest {
  requestId?: string;
  operationId?: string;
  onTransportStart?: (protocol: "chat" | "responses" | "codex" | "messages") => void;
  /** Host-owned stable conversation identity; never serialized in the body. */
  sessionId?: string;
  modelResolution?: import("./model-catalog.js").ModelResolution;
  /** Modelo global único resolvido pelo catálogo (T13); id como em models.ts. */
  model: string;
  /** Local-only purpose tag. Never serialized into the provider JSON body. */
  purpose?: "turn" | "memory-reflection" | "async-task" | "kickstart" | "resume";
  /** System prompt montado pelo turn runner (T10). */
  system?: string;
  /** Histórico do diálogo (transcript) até o turno atual. */
  messages: ProviderChatMessage[];
  /** Schemas de tool (T9) — opcional: sem tools, o provider roda chat puro. */
  tools?: ProviderTool[];
  /** Internal capability gate; not serialized into the provider request body. */
  acceptsImages?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Real provider reasoning control. Adapters omit it when unsupported. */
  reasoningEffort?: ReasoningEffort;
  /** AbortSignal: cancelamento do stream (abort encerra com `error` abortado). */
  signal?: AbortSignal;
  /** Local-only resume input. Adapters receive it only through `resumeChat`. */
  resume?: { cursor: string };
}

/**
 * Eventos observáveis do stream de chat (spec §3.1/§3.2). `message`, `done` e
 * `error` são terminais — exatamente UM deles encerra o stream.
 */
export type ProviderStreamEvent =
  | { type: "usage"; usage: ProviderUsage }
  | { type: "service-tier"; actual: "priority" | "default" | "unknown" }
  | {
      type: "delta";
      /** Fragmento de texto incremental do provider (acumulado pelo router). */
      delta: string;
    }
  | {
      type: "reasoning-start";
      /** Bounded, sanitized, explicitly-allowed summary start marker. */
      summary?: string;
    }
  | {
      type: "reasoning-progress";
      /** Bounded, sanitized, explicitly-allowed progress fragment (never raw CoT). */
      summary: string;
    }
  | {
      type: "reasoning-end";
      /** Optional bounded summary conclusion. */
      summary?: string;
    }
  | {
      type: "message";
      /** Mensagem COMPLETA do assistente (acumulação de todos os deltas). */
      message: ProviderAssistantMessage;
    }
  | {
      type: "tool-call";
      call: ProviderToolCall;
    }
  | {
      type: "tool-result";
      result: ProviderToolResult;
    }
  | {
      type: "resume-cursor";
      /** Opaque provider cursor at a durable provider boundary. */
      cursor: string;
    }
  | {
      type: "done";
    }
  | {
      /** Internal: tool-loop discarded assistant text staged for a deferred tool round. */
      type: "discard-round-text";
    }
  | {
      type: "error";
      error: ProviderError;
    };

/** Mensagem completa emitida pelo evento `message`. */
export interface ProviderAssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ProviderToolCall[];
}

/** Tool call emitida/esperada pelo provider (shape OpenAI-like). */
export interface ProviderToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Resultado de tool devolvido ao provider (próximo turno, T9). */
export interface ProviderToolResult {
  toolCallId: string;
  content: string;
}

/**
 * Erro normalizado de inferência. `kind` é a classificação estável do erro;
 * `retryable` é o derivado consumido pelo turn runner/UI para decidir retry.
 */
export type ProviderErrorKind =
  | "rate-limit" // 429 — transiente (retry com backoff)
  | "server" // 5xx do provider — transiente
  | "network" // falha de rede/EOF — transiente
  | "auth" // 401/403 — permanente
  | "validation" // 400/404 (modelo/req inválidos) — permanente
  | "aborted" // cancelamento pelo consumidor (AbortSignal)
  | "unknown";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: {
      kind?: ProviderErrorKind;
      status?: number;
      code?: string;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = opts.kind ?? "unknown";
    this.status = opts.status;
    this.code = opts.code;
    this.retryAfterMs = normalizeRetryAfterMs(opts.retryAfterMs);
    if (opts.cause !== undefined) this.cause = opts.cause;
    this.retryable = isRetryableKind(this.kind);
  }
}

/** `true` quando o erro é transiente (pode ser re-tentado com backoff). */
export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return kind === "rate-limit" || kind === "server" || kind === "network";
}

/**
 * Classifica um erro cru do adapter/transporte em `ProviderError`.
 *
 * Mapeamento (spec §3.1): retryable = 429 | 5xx | falha de rede; permanente =
 * 4xx de auth/validação. `AbortError` (cancelamento) vira `aborted`, nunca
 * retryable — o consumidor não deve re-tentar um turno abortado.
 */
export function classifyProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;

  if (isAbortError(err)) {
    const reason = err instanceof Error && "cause" in err ? err.cause : undefined;
    const reasonCode = extractCode(reason) ?? extractCode(err);
    const reasonMessage = reason instanceof Error ? reason.message : err instanceof Error ? err.message : String(err);
    if (reasonCode === "ETIMEDOUT" || /timed?\s*out/i.test(reasonMessage)) {
      return new ProviderError(reasonMessage, { kind: "network", code: "ETIMEDOUT", cause: err });
    }
    return new ProviderError("stream aborted", { kind: "aborted", code: "ABORT_ERR", cause: err });
  }

  const cause = err instanceof Error ? err : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const status = extractStatus(err);
  const code = extractCode(err) ?? cause?.name;
  const retryAfterMs = extractRetryAfterMs(err);

  if (status !== undefined) {
    if (status === 429) {
      return new ProviderError(message, { kind: "rate-limit", status, code, retryAfterMs, cause });
    }
    if (status >= 500) {
      return new ProviderError(message, { kind: "server", status, code, retryAfterMs, cause });
    }
    if (status === 401 || status === 403) {
      return new ProviderError(message, { kind: "auth", status, code, cause });
    }
    if (status === 400 || status === 404 || status === 422) {
      return new ProviderError(message, { kind: "validation", status, code, cause });
    }
    return new ProviderError(message, { kind: "validation", status, code, cause });
  }

  // Sem status HTTP: códigos de rede conhecidos → network (transiente).
  const knownNetwork = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
  if (code !== undefined && knownNetwork.has(code)) {
    return new ProviderError(message, { kind: "network", code, cause });
  }

  return new ProviderError(message, { kind: "unknown", code, cause });
}

/** Retorna o status HTTP presente em qualquer shape de erro (Response/axios etc.). */
function extractStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const record = err as Record<string, unknown>;
  const raw = record["status"] ?? record["statusCode"];
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  return undefined;
}

/** Retorna o `code` de erro quando presente no objeto. */
function extractCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const record = err as Record<string, unknown>;
  const raw = record["code"];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

const MAX_RETRY_AFTER_MS = 60_000;
/** Reflection jobs keep ~2/3 of their 30s execution deadline for the model call. */
const MEMORY_REFLECTION_ADMISSION_MAX_WAIT_MS = 10_000;

function normalizeRetryAfterMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.round(value));
}

function extractRetryAfterMs(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  return normalizeRetryAfterMs((err as Record<string, unknown>)["retryAfterMs"]);
}

/** AbortError do runtime (DOM/node: `AbortSignal.abort()` no consumidor). */
function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const record = err as Record<string, unknown>;
  return record["name"] === "AbortError" || (typeof record["code"] === "string" && record["code"] === "ABORT_ERR");
}

/**
 * Adapter de provider — a interface que T6 (OpenAI), T7 (xAI) e T8
 * (OpenAI-compat) implementam. Cada adapter:
 *   1. recebe o pedido NORMALIZADO (`ProviderChatRequest`);
 *   2. transforma em deltas de texto e/ou tool calls e os emite via
 *      `emit` — o adapter NÃO precisa acumular nem emitir `message` completo,
 *      `done` ou `error`: o router faz isso (acumulador de deltas, spec §3.1);
 *   3. respeita `req.signal` (abort encerra o stream com `AbortError`).
 */
export interface ProviderAdapter {
  readonly tracksTransport?: boolean;
  /** Nome canônico do provider: "openai" | "xai" | "openai-compat" (+ fake em test). */
  readonly name: string;
  /** Exact provider payload used both by the byte gate and the transport. */
  serializeRequest?(req: ProviderChatRequest): string;
  /**
   * Streama um turno de chat emitindo eventos parciais (`delta`, `tool-call`,
   * `tool-result`) via `emit`. Quando o fluxo do provider termina, a promise
   * resolve (o router emite `done`). Erros são lançados/emitidos e o router
   * os classifica e emite como evento `error`.
   */
  streamChat(
    req: ProviderChatRequest,
    emit: (event: ProviderStreamEvent) => void,
  ): Promise<void>;
  /** Optional real cursor-resume entrypoint. Unsupported adapters omit it. */
  resumeChat?(
    req: Omit<ProviderChatRequest, "resume">,
    cursor: string,
    emit: (event: ProviderStreamEvent) => void,
  ): Promise<void>;
  /** Optional lifecycle: releases owned executions/controllers on shutdown. */
  close?(): void | Promise<void>;
}

export interface RegisterProviderOptions {
  /** true (default) = substitui um adapter já registrado com o mesmo nome. */
  replace?: boolean;
}

/**
 * Registro de adapters por nome (T6+ chamam `registerProvider` no boot; o turn
 * runner de T10 resolve o provider ativo por nome).
 */
export interface ProviderRegistry {
  register(adapter: ProviderAdapter, opts?: RegisterProviderOptions): void;
  unregister(name: string): boolean;
  get(name: string): ProviderAdapter | undefined;
  has(name: string): boolean;
  names(): string[];
  clear(): void;
}

export interface RouterOptions {
  onAttempt?: (attempt: ProviderAttempt) => void;
  /** Registro de adapters; default: um Map interno (`createProviderRegistry()`). */
  registry?: ProviderRegistry;
  /** Número máximo de novas tentativas para falhas transitórias sem saída observável. */
  maxRetries?: number;
  /** Backoff injetável para testes e para o host controlar o agendamento. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Global process-wide admission; the lease wraps only one provider attempt. */
  admission?: ProviderAdmissionScheduler;
  /** Stable identity used by admission fairness (never sent to providers). */
  agentId?: string;
  /**
   * Observa o limite real da admissão: `true` antes de esperar por uma vaga,
   * `false` quando o lease foi concedido. É um fato da execução (não polling)
   * e existe apenas para o estado ao vivo do turno.
   */
  onAdmissionWait?: (waiting: boolean) => void;
  /** Observa o instante em que a requisição foi efetivamente entregue ao transporte. */
  onTransportStart?: (protocol: "chat" | "responses" | "codex" | "messages") => void;
}

/**
 * Acumulador de deltas → mensagem completa (spec §3.1/§3.2): o consumidor
 * espera mensagens completas, então o router acumula os `delta` do provider e
 * emite `message` apenas quando a resposta de texto termina.
 */
export class DeltaAccumulator {
  private _text = "";
  private readonly toolCalls: ProviderToolCall[] = [];

  /** Concatena um delta de texto na ordem em que chega. */
  appendText(delta: string): void {
    this._text += delta;
  }

  /** Registra uma tool call (ordem de chegada preservada). */
  addToolCall(call: ProviderToolCall): void {
    this.toolCalls.push(call);
  }

  /** Constrói a mensagem COMPLETA com o texto acumulado até aqui. */
  snapshot(): ProviderAssistantMessage {
    const message: ProviderAssistantMessage = { role: "assistant", content: this._text };
    if (this.toolCalls.length > 0) message.toolCalls = [...this.toolCalls];
    return message;
  }

  get text(): string {
    return this._text;
  }

  get toolCallCount(): number {
    return this.toolCalls.length;
  }
}

export interface StreamChatResult {
  attempts?: ProviderAttempt[];
  /** Mensagem completa final (assistente) ou `undefined` se o turno não rendeu texto. */
  message?: ProviderAssistantMessage;
  /** true quando o stream terminou por cancelamento (AbortSignal). */
  aborted: boolean;
  /** true quando o stream terminou com erro (não-retryable ou retryable). */
  error?: ProviderError;
  /** Last bounded opaque cursor emitted at a provider boundary. */
  cursor?: string;
}

export interface ProviderAttempt {
  requestId: string;
  operationId?: string;
  attemptId: string;
  attempt: number;
  provider: string;
  model: string;
  purpose: NonNullable<ProviderChatRequest["purpose"]>;
  protocol: "chat" | "responses" | "codex" | "messages";
  startedAtMs: number;
  durationMs: number;
  outcome: "success" | "error" | "aborted";
  errorKind?: ProviderErrorKind;
  usage?: ProviderUsage;
}

function logProviderTelemetry(stage: string, fields: object): void {
  if (process.env.NODE_ENV !== "test") console.info(`[openbot][${stage}] ${JSON.stringify(fields)}`);
}

function retrySleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    if (signal?.aborted) {
      finish();
      return;
    }
    timeoutHandle = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Chama `streamChat` do adapter registrado para `req.model`'s provider, faz o
 * papel do ACUMULADOR (deltas → `message` completa) e normaliza o fim do
 * stream (sempre exatamente um terminal: `message`|`done`|`error`).
 *
 * NUNCA lança: erros do adapter são classificados e entregues como evento
 * `error` + campo `result.error`. Abort (req.signal) encerra o stream com um
 * evento `error` kind `aborted` e `result.aborted === true` (spec §3.1).
 *
 * @param providerName nome do provider (ex.: "openai") — resolve no registry.
 * @param req          pedido normalizado (contém o model, o signal, etc.).
 * @param onEvent      observador opcional de TODOS os eventos emitidos.
 */
export async function streamChat(
  providerName: string,
  req: ProviderChatRequest,
  onEvent?: (event: ProviderStreamEvent) => void,
  opts: RouterOptions = {},
): Promise<StreamChatResult> {
  const requestId = req.requestId ?? randomUUID();
  const tracksTransport = (opts.registry ?? defaultRegistry).get(providerName)?.tracksTransport === true;
  const attempts: ProviderAttempt[] = [];
  const startedAtMs = Date.now();
  const result = await streamChatInternal(providerName, { ...req, requestId }, onEvent, {
    ...opts,
    onAttempt: (attempt) => {
      attempts.push(attempt);
      logProviderTelemetry("provider-attempt", attempt);
      try { opts.onAttempt?.(attempt); } catch { /* Telemetry cannot change inference. */ }
    },
  });
  logProviderTelemetry("provider-result", {
    requestId, operationId: req.operationId, provider: providerName, model: req.model, purpose: req.purpose ?? "turn",
    attempts: tracksTransport ? attempts.length : undefined, startedAtMs, durationMs: Date.now() - startedAtMs,
    outcome: result.aborted ? "aborted" : result.error ? "error" : "success",
    errorKind: result.error?.kind,
  });
  return { ...result, ...(tracksTransport ? { attempts } : {}) };
}

async function streamChatInternal(
  providerName: string,
  req: ProviderChatRequest,
  onEvent?: (event: ProviderStreamEvent) => void,
  opts: RouterOptions = {},
): Promise<StreamChatResult> {
  const registry = opts.registry ?? defaultRegistry;
  const resumeRequested = req.resume !== undefined;
  const maxRetries = resumeRequested
    ? 0
    : Number.isInteger(opts.maxRetries)
      ? Math.max(0, Math.min(2, opts.maxRetries as number))
      : 2;
  const sleep = opts.sleep ?? retrySleep;
  let observerFailed = false;
  let observerFailure: unknown;
  const observerErrorResult = (): StreamChatResult => ({
    aborted: false,
    error: classifyProviderError(observerFailure),
  });
  const emit = (event: ProviderStreamEvent): boolean => {
    if (observerFailed) return false;
    try {
      onEvent?.(event);
      return true;
    } catch (error) {
      observerFailed = true;
      observerFailure = error;
      return false;
    }
  };
  const forward = (event: ProviderStreamEvent): void => {
    if (!emit(event)) throw observerFailure;
  };
  const adapter = registry.get(providerName);
  if (!adapter) {
    const err = new ProviderError(`provider não registrado: ${providerName}`, {
      kind: "validation",
    });
    const terminal: ProviderStreamEvent = { type: "error", error: err };
    if (!emit(terminal)) return observerErrorResult();
    return { aborted: false, error: err };
  }

  if (req.signal?.aborted) {
    const err = new ProviderError("stream aborted before start", { kind: "aborted", code: "ABORT_ERR" });
    if (!emit({ type: "error", error: err })) return observerErrorResult();
    return { aborted: true, error: err };
  }

  const capability = req.modelResolution?.entry.provider === providerName && req.modelResolution.entry.id === req.model
    ? req.modelResolution.capabilities : resolveProviderCapabilities(providerName, req.model);
  let resumeCursor: string | undefined;
  if (resumeRequested) {
    try {
      resumeCursor = validateOpaqueResumeCursor(req.resume?.cursor);
    } catch (error) {
      const resumeError = error instanceof ResumeProtocolError
        ? new ProviderError(error.message, { kind: "validation", code: error.code })
        : new ProviderError("invalid resume cursor", { kind: "validation", code: "invalid_cursor" });
      if (!emit({ type: "error", error: resumeError })) return observerErrorResult();
      return { aborted: false, error: resumeError };
    }
    if (capability.resume !== "cursor" || typeof adapter.resumeChat !== "function") {
      const err = new ProviderError("provider does not support cursor resume", {
        kind: "validation",
        code: "resume_unavailable",
      });
      if (!emit({ type: "error", error: err })) return observerErrorResult();
      return { aborted: false, error: err };
    }
  }

  const accumulator = new DeltaAccumulator();

  // 1) repassa o signal para o adapter abortar o fetch subjacente;
  // 2) liga o abort do CONSUMIDOR no encerramento local do stream (o adapter
  //    pode lançar AbortError; também garantimos que, se o signal disparar
  //    sem erro do adapter, o stream termina com `aborted`).
  const controller = new AbortController();
  let abortListener: (() => void) | undefined;
  if (req.signal) {
    if (req.signal.aborted) {
      controller.abort();
    } else {
      abortListener = () => controller.abort();
      req.signal.addEventListener("abort", abortListener, { once: true });
    }
  }
  const effectiveRequest: ProviderChatRequest = { ...req, signal: controller.signal };

  try {
    let observedOutput = false;
    let terminalError: ProviderError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let admissionLease: ProviderAdmissionLease | undefined;
      let observation: ProviderAttempt | undefined;
      let usage: ProviderUsage | undefined;
      const finishAttempt = (error?: ProviderError): void => {
        if (!observation) return;
        observation.durationMs = Date.now() - observation.startedAtMs;
        observation.outcome = req.signal?.aborted ? "aborted" : error ? "error" : "success";
        observation.errorKind = req.signal?.aborted ? "aborted" : error?.kind;
        observation.usage = usage;
        opts.onAttempt?.(observation);
        observation = undefined;
      };
      try {
        const admission = opts.admission;
        if (admission !== undefined) {
          // Maintenance work (memory reflection) yields to interactive turns and
          // never burns its whole execution deadline waiting for a slot.
          try { opts.onAdmissionWait?.(true); } catch { /* status observation cannot change inference */ }
          try {
            admissionLease = await admission.acquire(opts.agentId ?? "default",
              req.purpose === "memory-reflection"
                ? { signal: req.signal, priority: "maintenance", maxWaitMs: MEMORY_REFLECTION_ADMISSION_MAX_WAIT_MS }
                : req.signal);
          } finally {
            try { opts.onAdmissionWait?.(false); } catch { /* status observation cannot change inference */ }
          }
        }
        effectiveRequest.onTransportStart = (protocol) => {
          observation = {
            requestId: req.requestId!, attemptId: randomUUID(), attempt: attempt + 1,
            operationId: req.operationId,
            provider: providerName, model: req.model, purpose: req.purpose ?? "turn", protocol,
            startedAtMs: Date.now(), durationMs: 0, outcome: "success",
          };
          try { opts.onTransportStart?.(protocol); } catch { /* status observation cannot change inference */ }
        };
        const requestForAdapter = resumeRequested
          ? (() => {
            const { resume: _resume, ...withoutResume } = effectiveRequest;
            return withoutResume;
          })()
          : effectiveRequest;
        const stream = resumeRequested
          ? adapter.resumeChat!(requestForAdapter, resumeCursor!, (event) => {
            switch (event.type) {
              case "usage":
                usage = { ...usage, ...event.usage };
                forward(event);
                break;
              case "resume-cursor":
                if (capability.resume !== "cursor") throw new ProviderError("resume cursor emitted without capability", { kind: "validation", code: "invalid_cursor" });
                resumeCursor = validateOpaqueResumeCursor(event.cursor);
                forward({ type: "resume-cursor", cursor: resumeCursor });
                break;
              case "delta":
                observedOutput = true;
                accumulator.appendText(event.delta);
                forward({ type: "delta", delta: event.delta });
                break;
              case "tool-call":
                observedOutput = true;
                accumulator.addToolCall(event.call);
                forward({ type: "tool-call", call: event.call });
                break;
              case "tool-result":
                observedOutput = true;
                forward({ type: "tool-result", result: event.result });
                break;
              case "reasoning-start":
              case "reasoning-progress":
              case "reasoning-end":
                forward({
                  type: event.type,
                  ...(event.summary !== undefined ? { summary: event.summary } : {}),
                } as Extract<ProviderStreamEvent, { type: "reasoning-start" | "reasoning-progress" | "reasoning-end" }>);
                break;
              case "message":
              case "done":
              case "error":
                break;
            }
          })
          : adapter.streamChat(requestForAdapter, (event) => {
          switch (event.type) {
            case "usage":
              usage = { ...usage, ...event.usage };
              forward(event);
              break;
            case "service-tier":
              forward(event);
              break;
            case "delta":
              observedOutput = true;
              accumulator.appendText(event.delta);
              forward({ type: "delta", delta: event.delta });
              break;
            case "tool-call":
              observedOutput = true;
              accumulator.addToolCall(event.call);
              forward({ type: "tool-call", call: event.call });
              break;
            case "tool-result":
              observedOutput = true;
              forward({ type: "tool-result", result: event.result });
              break;
            case "resume-cursor":
              if (capability.resume !== "cursor") throw new ProviderError("resume cursor emitted without capability", { kind: "validation", code: "invalid_cursor" });
              resumeCursor = validateOpaqueResumeCursor(event.cursor);
              forward({ type: "resume-cursor", cursor: resumeCursor });
              break;
            // P2.4 reasoning: forward canonical events unchanged (the consumer
            // gates them by the declared capability). Reasoning is never counted
            // as observable content, so absence of deltas cannot fake output.
            case "reasoning-start":
            case "reasoning-progress":
            case "reasoning-end":
              forward({
                type: event.type,
                ...(event.summary !== undefined ? { summary: event.summary } : {}),
              } as Extract<ProviderStreamEvent, { type: "reasoning-start" | "reasoning-progress" | "reasoning-end" }>);
              break;
            // Adapter não deve emitir terminais; se emitir, ignoramos a partir do fim.
            case "message":
            case "done":
            case "error":
              break;
          }
          });
        await stream;
        finishAttempt();
        break;
      } catch (err) {
        finishAttempt(classifyProviderError(err));
        if (observerFailed) return observerErrorResult();
        const classified = err instanceof ProviderAdmissionError
          ? new ProviderError(err.message, {
            kind: err.code === "queue-full" || err.code === "agent-queue-full" ? "rate-limit" : err.code === "aborted" ? "aborted" : "unknown",
            code: `PROVIDER_ADMISSION_${err.code.replaceAll("-", "_").toUpperCase()}`,
          })
          : classifyProviderError(err);
        // Admission is the boundary around one attempt. A queue-full or
        // shutdown decision is already the scheduler's final disposition;
        // retrying it internally would turn an explicit capacity rejection
        // into hidden backoff/requeue churn. Adapter failures below retain
        // the normal retry policy.
        if (err instanceof ProviderAdmissionError) {
          terminalError = classified;
          break;
        }
        if (!observedOutput && classified.retryable && attempt < maxRetries && !req.signal?.aborted) {
          const backoffMs = 250 * 2 ** attempt;
          // The lease wraps only the provider attempt itself. A backoff sleep
          // must not occupy a global admission slot: release it before waiting
          // and let the next attempt re-enter the queue fairly.
          admissionLease?.release();
          admissionLease = undefined;
          await sleep(Math.max(backoffMs, classified.retryAfterMs ?? 0), req.signal);
          if (req.signal?.aborted) break;
          continue;
        }
        terminalError = classified;
        break;
      } finally {
        admissionLease?.release();
      }
    }

    if (observerFailed) return observerErrorResult();

    if (req.signal?.aborted) {
      const err = new ProviderError("stream aborted", { kind: "aborted", code: "ABORT_ERR" });
      if (!emit({ type: "error", error: err })) return observerErrorResult();
      return { aborted: true, error: err };
    }

    if (terminalError !== undefined) {
      if (!emit({ type: "error", error: terminalError })) return observerErrorResult();
      return { aborted: false, error: terminalError };
    }

    const message = accumulator.snapshot();
    if (message.content.length > 0 || (message.toolCalls?.length ?? 0) > 0) {
      if (!emit({ type: "message", message })) return observerErrorResult();
      // `done` SEMPRE fecha um stream bem-sucedido (spec §3.1/§3.2): o consumidor
      // usa `done` como confirmação de término após a `message` completa.
      if (!emit({ type: "done" })) return observerErrorResult();
      return { aborted: false, message, ...(resumeCursor === undefined ? {} : { cursor: resumeCursor }) };
    }
    if (!emit({ type: "done" })) return observerErrorResult();
    return { aborted: false, ...(resumeCursor === undefined ? {} : { cursor: resumeCursor }) };
  } catch (err) {
    if (observerFailed) return observerErrorResult();
    // Abort do consumidor → erro `aborted` (não retryable), nunca "network".
    if (req.signal?.aborted || (isAbortError(err) && req.signal?.aborted)) {
      const abortedErr = new ProviderError("stream aborted", {
        kind: "aborted",
        code: "ABORT_ERR",
        cause: err,
      });
      if (!emit({ type: "error", error: abortedErr })) return observerErrorResult();
      return { aborted: true, error: abortedErr };
    }

    // Sem cancelamento: classifica transiente vs permanente (spec §3.1).
    const classified = classifyProviderError(err);
    if (!emit({ type: "error", error: classified })) return observerErrorResult();
    return { aborted: false, error: classified };
  } finally {
    if (req.signal && abortListener) req.signal.removeEventListener("abort", abortListener);
  }
}

/** Registro default do módulo (rotas T6+ registram aqui no boot). */
export const defaultRegistry: ProviderRegistry = createProviderRegistry();

/** Cria um registro de adapters por nome (T6/T7/T8 usam o mesmo contrato). */
export function createProviderRegistry(): ProviderRegistry {
  const adapters = new Map<string, ProviderAdapter>();

  return {
    register(adapter, opts = {}) {
      const replace = opts.replace ?? true;
      const existing = adapters.get(adapter.name);
      if (existing !== undefined && !replace) {
        throw new ProviderError(`provider já registrado: ${adapter.name}`, {
          kind: "validation",
        });
      }
      adapters.set(adapter.name, adapter);
    },
    unregister(name) {
      return adapters.delete(name);
    },
    get(name) {
      return adapters.get(name);
    },
    has(name) {
      return adapters.has(name);
    },
    names() {
      return [...adapters.keys()];
    },
    clear() {
      adapters.clear();
    },
  };
}
