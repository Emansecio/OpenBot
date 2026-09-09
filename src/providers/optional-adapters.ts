/**
 * P2.5 — optional provider adapters: OpenRouter (OpenAI-compatible
 * specialization) and the strict offline CLI protocols (codex-cli.v1 /
 * claude-code.v1).
 *
 * OpenRouter reuses the shared serializer (providerRequestBody), the P1.3
 * model-context gate (prepareProviderRound), the router/ProviderError contract
 * and the P1.1 admission scheduler (acquired by the router per attempt). The
 * credential is an opaque reference resolved only at call time and is never
 * persisted, published, included in errors or logged.
 *
 * CLI adapters execute exclusively through LocalExecutionBroker.process.run —
 * the adapter never spawns, never reads env tokens, never puts sessions or
 * tokens in argv/env, and parses its own strictly versioned JSON-lines
 * protocol. Session references are opaque and agent-scoped.
 */
import { randomUUID } from "node:crypto";

import type { ModelCatalogEntry } from "../shared/contracts.js";
import { MAX_PROCESS_STDIN_BYTES, type ExecutionRequest } from "../execution/contracts.js";
import type { LocalExecutionBroker } from "../execution/broker.js";
import { resolveModelCapabilities, prepareProviderRound } from "../memory/model-context.js";
import {
  OpenAiToolCallAccumulator,
  extractOpenAiErrorMessage,
  parseRetryAfterMs,
  raceWithAbort,
} from "./openai-helpers.js";
import { providerRequestBody } from "./request-bodies.js";
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderChatRequest,
  type ProviderStreamEvent,
} from "./router.js";
import { resolveProviderCapabilities } from "./capabilities.js";

export interface ProviderUsageObservation {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly provider: string;
  readonly model: string;
}

export type UsageCollector = { record(usage: ProviderUsageObservation): void };

const DEFAULT_OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MAX_REQUEST_BYTES = 512 * 1024;
const DEFAULT_CLI_TIMEOUT_MS = 300_000;
const DEFAULT_CLI_MAX_STDOUT_BYTES = 256 * 1024;
const DEFAULT_CLI_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_CLI_MAX_EVENT_BYTES = 16 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const ERROR_BODY_MARKER = "\n[openrouter error body truncated]";

function redactSecret(message: string, secrets: readonly string[]): string {
  let output = message;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    output = output.split(secret).join("[redacted]");
  }
  return output;
}

function hasImageParts(req: ProviderChatRequest): boolean {
  return req.messages.some((message) => message.role === "user" && Array.isArray(message.content)
    && (message.content as Array<{ type: string }>).some((part) => part.type === "image_url"));
}

function protocolError(message: string): ProviderError {
  return new ProviderError(message, { kind: "validation", code: "protocol_error" });
}

/* ------------------------------------------------------------------ */
/* OpenRouter — OpenAI-compatible specialization                       */
/* ------------------------------------------------------------------ */

export interface OpenRouterAdapterOptions {
  readonly name?: string;
  readonly agentId?: string;
  readonly credentialRef?: string;
  readonly resolveCredential?: (ref: string, scope: { agentId: string }) => Promise<string | null | undefined>;
  readonly modelCatalog?: readonly ModelCatalogEntry[];
  readonly maxRequestBytes?: number;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly httpReferer?: string;
  readonly appTitle?: string;
  readonly usageCollector?: UsageCollector;
}

export class OpenRouterAdapter implements ProviderAdapter {
  readonly name: string;
  private readonly agentId: string;
  private readonly credentialRef?: string;
  private readonly resolveCredential?: OpenRouterAdapterOptions["resolveCredential"];
  private readonly modelCatalog: readonly ModelCatalogEntry[];
  private readonly maxRequestBytes: number;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly httpReferer?: string;
  private readonly appTitle?: string;
  private readonly usageCollector?: UsageCollector;

  constructor(options: OpenRouterAdapterOptions = {}) {
    this.name = options.name ?? "openrouter";
    this.agentId = options.agentId ?? "";
    this.credentialRef = options.credentialRef;
    this.resolveCredential = options.resolveCredential;
    this.modelCatalog = options.modelCatalog ?? [];
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_OPENROUTER_MAX_REQUEST_BYTES;
    const endpoint = (options.endpoint ?? DEFAULT_OPENROUTER_ENDPOINT).replace(/\/+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error("OpenRouter endpoint is not a valid URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("OpenRouter endpoint must be http(s)");
    this.endpoint = endpoint;
    this.fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.httpReferer = options.httpReferer;
    this.appTitle = options.appTitle;
    this.usageCollector = options.usageCollector;
  }

  serializeRequest(req: ProviderChatRequest): string {
    return JSON.stringify({
      ...providerRequestBody("openrouter", req),
      stream: true,
      stream_options: { include_usage: true },
    });
  }

  async streamChat(req: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void): Promise<void> {
    if (req.signal?.aborted) throw new ProviderError("stream aborted before start", { kind: "aborted", code: "ABORT_ERR" });
    // A declared catalog is authoritative: when one is provided, the model
    // must exist and its capability must be known (fail-closed). Without a
    // catalog the caller owns model selection; capabilities still gate
    // features via the matrix (unknown pairs fail closed).
    const hasCatalog = this.modelCatalog.length > 0;
    const entry = this.modelCatalog.find((candidate) => candidate.id === req.model);
    if (hasCatalog && entry === undefined) {
      throw new ProviderError(`openrouter: modelo desconhecido: ${req.model}`, { kind: "validation", code: "model_capability_unknown" });
    }
    const capability = resolveProviderCapabilities("openrouter", req.model);
    if (hasCatalog && entry !== undefined && !capability.streaming) {
      throw new ProviderError(`openrouter: modelo sem capability conhecida: ${req.model}`, { kind: "validation", code: "model_capability_unknown" });
    }
    if ((hasCatalog && !capability.images && hasImageParts(req)) || (hasCatalog && !capability.tools && (req.tools?.length ?? 0) > 0)) {
      throw new ProviderError("openrouter: feature não suportada por este modelo", { kind: "validation", code: "unsupported_feature" });
    }

    // P1.3 gate: model-aware byte/token budget before any network call. The
    // prepared request must not need further truncation to cross the wire —
    // an under-budget call fails before fetch instead of silently shrinking
    // the prompt.
    const prepared = prepareProviderRound(req, {
      capabilities: resolveModelCapabilities(entry ?? req.model, "openrouter", this.modelCatalog),
      maxBytes: this.maxRequestBytes,
      provider: "openrouter",
      serializeRequest: (candidate) => this.serializeRequest(candidate),
    });
    if (prepared.exhausted || prepared.budget.truncated) {
      throw new ProviderError("openrouter: pedido acima do orçamento de contexto", { kind: "validation", code: "context_budget_exceeded" });
    }

    if (this.credentialRef === undefined || typeof this.resolveCredential !== "function") {
      throw new ProviderError("openrouter: credencial opaca ausente", { kind: "auth", status: 401, code: "auth" });
    }
    const secret = await this.resolveCredential(this.credentialRef, { agentId: this.agentId });
    if (typeof secret !== "string" || secret.length === 0) {
      throw new ProviderError("openrouter: credencial indisponível", { kind: "auth", status: 401, code: "auth" });
    }

    const serializedBody = this.serializeRequest(prepared.request);
    if (Buffer.byteLength(serializedBody, "utf8") > this.maxRequestBytes) {
      throw new ProviderError("openrouter: pedido acima do orçamento de contexto", { kind: "validation", code: "context_budget_exceeded" });
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      ...(this.httpReferer === undefined ? {} : { "http-referer": this.httpReferer }),
      ...(this.appTitle === undefined ? {} : { "x-title": this.appTitle }),
    };
    const signal = req.signal ?? new AbortController().signal;
    const response = await this.fetchImpl(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers,
      body: serializedBody,
      signal,
    });

    if (!response.ok) {
      const errorText = await this.readErrorBody(response, signal);
      const rawMessage = extractOpenAiErrorMessage(parsedErrorBody(errorText)) ?? "openrouter request failed";
      const sanitized = redactSecret(rawMessage, [secret]).slice(0, 2_048);
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const kind = response.status === 401 || response.status === 403
        ? "auth" as const
        : response.status === 429
          ? "rate-limit" as const
          : response.status >= 500
            ? "server" as const
            : "validation" as const;
      throw new ProviderError(sanitized, {
        kind,
        status: response.status,
        code: kind,
        ...(kind === "auth" ? {} : { retryAfterMs }),
      });
    }
    if (response.body === null) throw protocolError("openrouter: stream sem corpo");

    let recorded = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const toolAccumulator = new OpenAiToolCallAccumulator();
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const controller = signal;
    let terminated = false;
    try {
      // Line-oriented strict SSE parser: accepts both canonical frames split by
      // a blank line and single-newline separated data lines; multi-chunk
      // protection keeps the buffer bounded. Any non-data, non-comment line is
      // a protocol error.
      let buffer = "";
      // OpenRouter delivers one JSON object per `data:` line (canonical SSE
      // frames separated by blank lines, or the offline fixture's single-newline
      // frames). Each data line is dispatched immediately; comments and SSE
      // metadata lines are ignored; any other line is a protocol error.
      while (!terminated) {
        const { done, value } = await raceWithAbort(reader.read(), controller);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffer, "utf8") > 1_048_576) throw protocolError("openrouter: buffer SSE excedeu 1 MiB");
        let newline = buffer.indexOf("\n");
        while (newline >= 0 && !terminated) {
          const line = newline > 0 && buffer[newline - 1] === "\r" ? buffer.slice(0, newline - 1) : buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.length === 0 || line.startsWith(":") || line.startsWith("event:") || line.startsWith("id:") || line.startsWith("retry:")) {
            // Frame separator / comment / metadata.
          } else if (line.startsWith("data:")) {
            const data = line.slice(5).replace(/^ /, "");
            if (this.dispatchOpenRouterFrame(data, emit, toolAccumulator, (usage) => { recorded = usage; }, capability)) {
              terminated = true;
            }
          } else {
            throw protocolError("openrouter: linha SSE inesperada");
          }
          newline = buffer.indexOf("\n");
        }
      }
      if (!terminated) throw protocolError("openrouter: stream terminou antes de [DONE]");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (toolAccumulator.hasAny && !toolAccumulator.complete) throw protocolError("openrouter: tool call incompleta");
    for (const call of toolAccumulator.calls()) emit({ type: "tool-call", call });
    if (this.usageCollector !== undefined && recorded.totalTokens > 0) {
      this.usageCollector.record({ ...recorded, provider: this.name, model: req.model });
    }
  }

  private dispatchOpenRouterFrame(
    data: string,
    emit: (event: ProviderStreamEvent) => void,
    toolAccumulator: OpenAiToolCallAccumulator,
    recordUsage: (usage: { inputTokens: number; outputTokens: number; totalTokens: number }) => void,
    capability: ReturnType<typeof resolveProviderCapabilities>,
  ): boolean {
    if (data.length === 0) return false;
    if (data === "[DONE]") return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw protocolError("openrouter: frame SSE inválido");
    }
    if (typeof parsed !== "object" || parsed === null) throw protocolError("openrouter: frame SSE inválido");
    const payload = parsed as Record<string, unknown>;
    if (typeof payload.error === "object" && payload.error !== null) {
      throw protocolError("openrouter: erro no stream");
    }
    if (typeof payload.usage === "object" && payload.usage !== null) {
      const usage = payload.usage as Record<string, unknown>;
      const prompt = usage.prompt_tokens, completion = usage.completion_tokens, total = usage.total_tokens;
      if ([prompt, completion, total].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
        recordUsage({ inputTokens: prompt as number, outputTokens: completion as number, totalTokens: total as number });
      }
    }
    const choices = payload.choices;
    if (!Array.isArray(choices)) throw protocolError("openrouter: frame SSE sem choices");
    const choice = choices[0] as Record<string, unknown> | undefined;
    const delta = choice?.delta;
    if (typeof delta === "object" && delta !== null) {
      const record = delta as Record<string, unknown>;
      if (typeof record.content === "string" && record.content.length > 0) emit({ type: "delta", delta: record.content });
      if (capability.tools && Array.isArray(record.tool_calls)) {
        for (const chunk of record.tool_calls) {
          if (typeof chunk === "object" && chunk !== null) toolAccumulator.add(chunk as Parameters<OpenAiToolCallAccumulator["add"]>[0]);
        }
      }
    }
    return false;
  }

  private async readErrorBody(response: Response, signal: AbortSignal): Promise<string> {
    if (response.body === null) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const parts: string[] = [];
    let remaining = MAX_ERROR_BODY_BYTES;
    let truncated = false;
    try {
      while (remaining > 0) {
        const { done, value } = await raceWithAbort(reader.read(), signal);
        if (done) break;
        const retained = value.subarray(0, remaining);
        parts.push(decoder.decode(retained, { stream: true }));
        remaining -= retained.byteLength;
        if (retained.byteLength < value.byteLength) { truncated = true; break; }
      }
      parts.push(decoder.decode());
      return parts.join("") + (truncated ? ERROR_BODY_MARKER : "");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  close(): void { /* stateless */ }
}

function parsedErrorBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: text.slice(0, 2_048) } };
  }
}

/* ------------------------------------------------------------------ */
/* Shared strict CLI provider adapter                                 */
/* ------------------------------------------------------------------ */

const CLI_PROTOCOLS: Record<string, string> = {
  "codex-cli": "codex-cli.v1",
  "claude-code": "claude-code.v1",
};

const CLI_ALLOWED_TYPES = new Set(["session", "child-start", "delta", "tool-call", "usage", "done"]);
const CLI_ALLOWED_FIELDS: Record<string, ReadonlySet<string>> = {
  session: new Set(["protocol", "sequence", "type", "sessionId"]),
  "child-start": new Set(["protocol", "sequence", "type", "pid"]),
  delta: new Set(["protocol", "sequence", "type", "text"]),
  "tool-call": new Set(["protocol", "sequence", "type", "id", "name", "arguments"]),
  usage: new Set(["protocol", "sequence", "type", "inputTokens", "outputTokens", "totalTokens"]),
  done: new Set(["protocol", "sequence", "type", "cursor"]),
};

export interface CliProviderAdapterOptions {
  readonly provider: "codex-cli" | "claude-code";
  readonly agentId?: string;
  readonly sessionRef?: string;
  readonly resolveSession?: (ref: string, scope: { agentId: string }) => Promise<{ protocol: string } | null | undefined>;
  readonly executable: string;
  readonly args: readonly string[];
  readonly executionBroker: Pick<LocalExecutionBroker, "execute">;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxEventBytes?: number;
  readonly usageCollector?: UsageCollector;
}

export function createCliProviderAdapter(options: CliProviderAdapterOptions): ProviderAdapter {
  const provider = options.provider;
  const protocol = CLI_PROTOCOLS[provider];
  // Fail-closed at construction: unknown provider, missing broker or an
  // invalid process definition never produces a usable adapter.
  if (protocol === undefined) throw new ProviderError("cli: protocolo desconhecido", { kind: "validation", code: "invalid_contract" });
  if (options.executionBroker === undefined || typeof options.executionBroker.execute !== "function") {
    throw new ProviderError("cli: execution broker obrigatório", { kind: "validation", code: "invalid_contract" });
  }
  if (typeof options.executable !== "string" || options.executable.length === 0) {
    throw new ProviderError("cli: executable obrigatório", { kind: "validation", code: "invalid_contract" });
  }
  if (typeof options.cwd !== "string" || options.cwd.length === 0) {
    throw new ProviderError("cli: cwd obrigatório", { kind: "validation", code: "invalid_contract" });
  }
  const agentId = options.agentId ?? "cli";
  const sessionRef = options.sessionRef;
  const resolveSession = options.resolveSession;
  const executable = options.executable;
  const args = [...options.args];
  const executionBroker = options.executionBroker;
  const cwd = options.cwd;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_CLI_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_CLI_MAX_STDERR_BYTES;
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_CLI_MAX_EVENT_BYTES;
  const usageCollector = options.usageCollector;
  const inFlight = new Map<string, AbortController>();
  let closed = false;

  const serializeRequest = (req: ProviderChatRequest): string => JSON.stringify({
    protocol: "openbot.cli-request.v1",
    provider,
    model: req.model,
    ...(req.system === undefined ? {} : { system: req.system }),
    messages: req.messages,
    ...(req.tools === undefined ? {} : { tools: req.tools }),
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.maxTokens === undefined ? {} : { maxTokens: req.maxTokens }),
  });

  const adapter: ProviderAdapter = {
    name: provider,
    serializeRequest,

    async streamChat(req: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void): Promise<void> {
      if (closed || req.signal?.aborted) throw new ProviderError("stream aborted before start", { kind: "aborted", code: "aborted" });
      if (protocol === undefined) throw protocolError("protocolo CLI desconhecido");
      if (sessionRef === undefined || typeof resolveSession !== "function") {
        throw new ProviderError("cli: sessão opaca ausente", { kind: "validation", code: "missing_session" });
      }

      const requestId = `cli-${provider}-${randomUUID()}`;
      const controller = new AbortController();
      inFlight.set(requestId, controller);
      const onAbort = (): void => controller.abort(req.signal?.reason);
      if (req.signal !== undefined) req.signal.addEventListener("abort", onAbort, { once: true });
      if (req.signal?.aborted) onAbort();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("cli execution backstop timeout"));
      }, timeoutMs);
      timeout.unref?.();
      const awaitLifecycle = async <T>(promise: Promise<T>): Promise<T> => {
        try {
          return await raceWithAbort(promise, controller.signal);
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          throw new ProviderError(timedOut ? "cli: timeout de execução" : "cli: execução cancelada", {
            kind: timedOut ? "network" : "aborted",
            code: timedOut ? "timed_out" : "aborted",
          });
        }
      };

      try {
        const session = await awaitLifecycle(resolveSession(sessionRef, { agentId }));
        if (session === null || session === undefined) {
          throw new ProviderError("cli: sessão opaca ausente", { kind: "validation", code: "missing_session" });
        }
        if (session.protocol !== protocol) throw protocolError("protocolo da sessão não confere");
        if (closed || controller.signal.aborted) {
          throw new ProviderError("stream aborted before execution started", { kind: "aborted", code: "aborted" });
        }
        if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4_096) {
          throw new ProviderError("cli: cwd inválido", { kind: "validation", code: "invalid_contract" });
        }
        // Feature gate before execution: unsupported features are rejected up
        // front using the exact provider+model capability (fail-closed for
        // unknown models).
        const capability = resolveProviderCapabilities(provider, req.model);
        if ((!capability.tools && (req.tools?.length ?? 0) > 0) || (!capability.images && hasImageParts(req))) {
          throw new ProviderError("cli: feature não suportada", { kind: "validation", code: "unsupported_feature" });
        }
        const stdin = serializeRequest(req);
        if (Buffer.byteLength(stdin, "utf8") > MAX_PROCESS_STDIN_BYTES) {
          throw new ProviderError("cli: pedido excedeu o limite", { kind: "validation", code: "request_too_large" });
        }
        const processRequest: ExecutionRequest = {
          operation: "process.run",
          executable,
          argv: args,
          cwd,
          stdin,
          networkProfile: "host",
          timeoutMs,
        };
        const result = await awaitLifecycle(executionBroker.execute(agentId, requestId, processRequest, controller.signal));

        if (controller.signal.aborted || (!result.ok && (result.code === "process_aborted" || result.code === "aborted"))) {
          throw new ProviderError("cli: execução cancelada", { kind: "aborted", code: "aborted" });
        }
        if (!result.ok) {
          const code = result.code === "process_timeout" || result.code === "timed_out"
            ? "timed_out"
            : result.code === "process_not_allowed"
              ? "process_not_allowed"
              : result.code === "process_output_limit" || result.code === "output_limit"
                ? "output_limit"
                : result.code ?? "execution_failed";
          const kind = code === "timed_out" ? "network" : "validation";
          throw new ProviderError(`cli: execução falhou (${code})`, { kind, code });
        }
        if (result.operation !== "process.run") {
          throw new ProviderError("cli: resultado inesperado", { kind: "validation", code: "execution_failed" });
        }

        if (Buffer.byteLength(result.stdout, "utf8") > maxStdoutBytes) {
          throw new ProviderError("cli: stdout excedeu o limite", { kind: "validation", code: "output_limit" });
        }
        if (Buffer.byteLength(result.stderr, "utf8") > maxStderrBytes) {
          throw new ProviderError("cli: stderr excedeu o limite", { kind: "validation", code: "output_limit" });
        }
        parseCliProtocol({
          stdout: result.stdout,
          protocol,
          maxEventBytes,
          usageCollector,
          model: req.model,
          providerName: provider,
          emit,
        });
      } finally {
        clearTimeout(timeout);
        if (req.signal !== undefined) req.signal.removeEventListener("abort", onAbort);
        inFlight.delete(requestId);
      }
    },

    close(): void {
      closed = true;
      for (const controller of inFlight.values()) {
        try { controller.abort(); } catch { /* already aborted */ }
      }
      inFlight.clear();
    },
  };
  return adapter;
}

interface ParseCliProtocolOptions {
  readonly stdout: string;
  readonly protocol: string;
  readonly maxEventBytes: number;
  readonly usageCollector?: UsageCollector;
  readonly model: string;
  readonly providerName: string;
  readonly emit: (event: ProviderStreamEvent) => void;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw protocolError(`cli: ${name} inválido`);
  return value;
}

function boundedString(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw protocolError(`cli: ${name} inválido`);
  }
  return value;
}

function parseCliProtocol(options: ParseCliProtocolOptions): void {
  const { stdout, protocol, maxEventBytes, usageCollector, model, providerName, emit } = options;
  const lines = stdout.split(/\r\n|\n|\r/).filter((line) => line.length > 0);
  let expectedSequence = 1;
  let terminalSeen = false;
  let sawSession = false;
  let sawUsage = false;
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const rawLine of lines) {
    if (Buffer.byteLength(rawLine, "utf8") > maxEventBytes) {
      throw new ProviderError("cli: frame excedeu o limite", { kind: "validation", code: "output_limit" });
    }
    if (terminalSeen) throw protocolError("cli: conteúdo após o terminal");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      throw protocolError("cli: frame JSON inválido");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw protocolError("cli: frame JSON inválido");
    const frame = parsed as Record<string, unknown>;
    if (frame.protocol !== protocol) throw protocolError("cli: protocolo do frame divergente");
    const type = frame.type;
    if (typeof type !== "string" || !CLI_ALLOWED_TYPES.has(type)) throw protocolError("cli: evento desconhecido");
    if (frame.sequence !== expectedSequence) throw protocolError("cli: sequência fora de ordem");
    expectedSequence += 1;
    const allowed = CLI_ALLOWED_FIELDS[type];
    if (allowed === undefined || Object.keys(frame).some((key) => !allowed.has(key))) throw protocolError(`cli: campos inválidos em ${type}`);
    if (!sawSession) {
      if (type !== "session") throw protocolError("cli: primeiro evento deve ser session");
      sawSession = true;
    }
    switch (type) {
      case "session":
        boundedString(frame.sessionId, "sessionId", 2_048);
        break;
      case "child-start":
        nonNegativeInteger(frame.pid, "pid");
        break;
      case "delta":
        emit({ type: "delta", delta: boundedString(frame.text, "text", maxEventBytes) });
        break;
      case "tool-call":
        emit({ type: "tool-call", call: { id: boundedString(frame.id, "id", 2_048), type: "function", function: { name: boundedString(frame.name, "name", 2_048), arguments: boundedString(frame.arguments, "arguments", maxEventBytes) } } });
        break;
      case "usage":
        usage = {
          inputTokens: nonNegativeInteger(frame.inputTokens, "inputTokens"),
          outputTokens: nonNegativeInteger(frame.outputTokens, "outputTokens"),
          totalTokens: nonNegativeInteger(frame.totalTokens, "totalTokens"),
        };
        sawUsage = true;
        break;
      case "done":
        boundedString(frame.cursor, "cursor", 2_048);
        terminalSeen = true;
        emit({ type: "done" });
        break;
    }
  }
  if (!terminalSeen) throw protocolError("cli: EOF antes de done");
  if (usageCollector !== undefined) {
    usageCollector.record({
      inputTokens: sawUsage ? usage.inputTokens : 0,
      outputTokens: sawUsage ? usage.outputTokens : 0,
      totalTokens: sawUsage ? usage.totalTokens : 0,
      provider: providerName,
      model,
    });
  }
}
