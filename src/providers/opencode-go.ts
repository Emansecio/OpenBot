import type { Keystore } from "../keystore/index.js";
import { parseProviderUsage } from "./usage.js";
import type { ProviderAdapter, ProviderChatMessage, ProviderChatRequest, ProviderStreamEvent } from "./router.js";
import {
  ApiError,
  findSseFrameBoundary,
  normalizeOpenAiError,
  openAiStreamErrorStatus,
  providerTimeoutError,
  raceWithAbort,
  splitSseLines,
} from "./openai-helpers.js";
import { OpenAiAdapter } from "./openai.js";
import {
  OPENCODE_ZEN_MODELS,
  isOpenCodeZenModel,
  openCodeGoRemoteId,
  openCodeModelMetadata,
} from "./opencode-go-models.js";

export { OPENCODE_GO_MODELS, OPENCODE_ZEN_MODELS, openCodeGoCatalogId, openCodeGoRemoteId, openCodeZenCatalogId } from "./opencode-go-models.js";
export type { OpenCodeGoProtocol } from "./opencode-go-models.js";

export const OPENCODE_GO_PROVIDER_NAME = "opencode-go" as const;
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1" as const;
export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1" as const;

export interface OpenCodeGoAdapterOptions {
  apiKey?: string;
  keystore?: Keystore;
  baseUrl?: string;
  /** Endpoint do tier gratuito Zen (modelos `opencode-go/zen/*`). */
  zenBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Absolute request duration cap; idle timeout is reset on every stream chunk. */
  maxDurationMs?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function anthropicContent(message: ProviderChatMessage): unknown[] {
  if (message.role === "user") {
    if (typeof message.content === "string") return [{ type: "text", text: message.content }];
    return message.content.map((part) => part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", source: { type: "url", url: part.image_url.url } });
  }
  if (message.role === "assistant") {
    const content: unknown[] = message.content ? [{ type: "text", text: message.content }] : [];
    for (const call of message.toolCalls ?? []) {
      let input: unknown;
      try { input = JSON.parse(call.function.arguments); } catch { throw new ApiError("opencode-go: argumentos de tool inválidos", 400); }
      content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
    }
    return content;
  }
  if (message.role === "tool") {
    if (!message.toolCallId) throw new ApiError("opencode-go: tool result sem toolCallId", 400);
    return [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }];
  }
  return [{ type: "text", text: message.content }];
}

function buildAnthropicBody(req: ProviderChatRequest): Record<string, unknown> {
  if (req.maxTokens !== undefined && (!Number.isSafeInteger(req.maxTokens) || req.maxTokens <= 0)) {
    throw new ApiError("opencode-go: maxTokens inválido", 400);
  }
  const system = [req.system, ...req.messages.filter((message) => message.role === "system").map((message) => message.content)]
    .filter((value): value is string => Boolean(value)).join("\n\n");
  const messages: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  for (const message of req.messages.filter((entry) => entry.role !== "system")) {
    const role = message.role === "tool" ? "user" : message.role;
    const content = anthropicContent(message);
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  }
  return {
    model: req.model,
    stream: true,
    max_tokens: req.maxTokens ?? 8_192,
    ...(system ? { system } : {}),
    messages,
    ...(req.tools?.length ? {
      tools: req.tools.map((tool) => ({
        name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}),
        input_schema: tool.function.parameters ?? {},
      })),
    } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };
}

export class OpenCodeGoAdapter implements ProviderAdapter {
  readonly tracksTransport = true;
  readonly name = OPENCODE_GO_PROVIDER_NAME;
  readonly baseUrl: string;
  readonly zenBaseUrl: string;
  private readonly apiKey?: string;
  private readonly keystore?: Keystore;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxDurationMs: number;
  private readonly responses: OpenAiAdapter;
  private readonly chat: OpenAiAdapter;
  private readonly zenResponses: OpenAiAdapter;
  private readonly zenChat: OpenAiAdapter;

  constructor(opts: OpenCodeGoAdapterOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? OPENCODE_GO_BASE_URL).replace(/\/+$/, "");
    this.zenBaseUrl = (opts.zenBaseUrl ?? OPENCODE_ZEN_BASE_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.keystore = opts.keystore;
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxDurationMs = opts.maxDurationMs ?? Math.max(900_000, this.timeoutMs);
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("OpenCode idle timeout is invalid");
    if (!Number.isSafeInteger(this.maxDurationMs) || this.maxDurationMs < this.timeoutMs) throw new Error("OpenCode max duration is invalid");
    const shared = {
      name: this.name,
      requestHeaders: (req: ProviderChatRequest) => ({ "user-agent": "OpenBot/0.1.1", ...(req.sessionId ? { "x-opencode-session": req.sessionId } : {}) }),
      credentialResolver: () => this.resolveCredential().then((accessToken) => ({ accessToken })),
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      maxDurationMs: this.maxDurationMs,
    };
    // Modelos "chat" recebem `reasoning_effort` somente quando o catálogo
    // declara suporte; o protocolo "messages" (Anthropic) nunca recebe.
    const endpoints = (baseUrl: string) => ({
      responses: new OpenAiAdapter({ ...shared, baseUrl, protocol: "responses" }),
      chat: new OpenAiAdapter({ ...shared, baseUrl, protocol: "openai", reasoningEffortPolicy: "declared" }),
    });
    const go = endpoints(this.baseUrl);
    this.responses = go.responses;
    this.chat = go.chat;
    const zen = endpoints(this.zenBaseUrl);
    this.zenResponses = zen.responses;
    this.zenChat = zen.chat;
  }

  private async resolveCredential(): Promise<string> {
    const key = this.apiKey ?? await this.keystore?.reveal(this.name) ?? undefined;
    if (key) return key;
    throw new ApiError("chave de API do OpenCode Go não configurada", 401);
  }

  async discoverModels(signal?: AbortSignal): Promise<string[]> {
    const list = async (baseUrl: string): Promise<string[]> => {
      const response = await this.fetchImpl(`${baseUrl}/models`, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "OpenBot/0.1.1" },
        signal,
      });
      if (!response.ok) throw new ApiError(`opencode-go: HTTP ${response.status} ao detectar modelos`, response.status);
      const payload = record(await response.json());
      if (!Array.isArray(payload?.data)) throw new ApiError("opencode-go: catálogo de modelos inválido", 502);
      return payload.data.map((item) => record(item)?.id).filter((id): id is string =>
        typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(id));
    };
    const go = await list(this.baseUrl);
    // Modelos Zen saem com infixo `zen/` para virarem `opencode-go/zen/<id>` no
    // catálogo — só os ids declarados como free, para não listar o tier pago.
    let zen: string[] = [];
    try {
      const wanted = new Set(Object.keys(OPENCODE_ZEN_MODELS));
      zen = (await list(this.zenBaseUrl)).filter((id) => wanted.has(id)).map((id) => `zen/${id}`);
    } catch {
      // Zen indisponível não derruba a descoberta do tier Go.
    }
    return [...new Set([...go, ...zen])];
  }

  private endpointFor(modelId: string): { responses: OpenAiAdapter; chat: OpenAiAdapter; baseUrl: string } {
    return isOpenCodeZenModel(modelId)
      ? { responses: this.zenResponses, chat: this.zenChat, baseUrl: this.zenBaseUrl }
      : { responses: this.responses, chat: this.chat, baseUrl: this.baseUrl };
  }

  serializeRequest(req: ProviderChatRequest): string {
    const remoteModel = openCodeGoRemoteId(req.model);
    const protocol = this.requestProtocol(req);
    if (!protocol) throw new ApiError(`opencode-go: modelo sem protocolo conhecido: ${req.model}`, 400);
    const remoteRequest = remoteModel === req.model ? req : { ...req, model: remoteModel };
    const endpoint = this.endpointFor(req.model);
    if (protocol === "responses") return endpoint.responses.serializeRequest(remoteRequest);
    if (protocol === "chat") return endpoint.chat.serializeRequest(remoteRequest);
    return JSON.stringify(buildAnthropicBody(remoteRequest));
  }

  async streamChat(req: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void): Promise<void> {
    const remoteModel = openCodeGoRemoteId(req.model);
    const protocol = this.requestProtocol(req);
    if (!protocol) throw new ApiError(`opencode-go: modelo sem protocolo conhecido: ${req.model}`, 400);
    const remoteRequest = remoteModel === req.model ? req : { ...req, model: remoteModel };
    const endpoint = this.endpointFor(req.model);
    if (protocol === "responses") return endpoint.responses.streamChat(remoteRequest, emit);
    if (protocol === "chat") return endpoint.chat.streamChat(remoteRequest, emit);
    return this.streamAnthropic(remoteRequest, emit, endpoint.baseUrl);
  }

  private requestProtocol(req: ProviderChatRequest) {
    const snapshot = req.modelResolution;
    if (snapshot?.entry.provider === this.name
      && openCodeGoRemoteId(snapshot.entry.id) === openCodeGoRemoteId(req.model)
      && isOpenCodeZenModel(snapshot.entry.id) === isOpenCodeZenModel(req.model)) {
      return snapshot.protocol === "codex" ? undefined : snapshot.protocol;
    }
    return openCodeModelMetadata(req.model)?.protocol;
  }

  private async streamAnthropic(req: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void, baseUrl = this.baseUrl): Promise<void> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(req.signal?.reason);
    req.signal?.addEventListener("abort", onAbort, { once: true });
    if (req.signal?.aborted) onAbort();
    let timeoutError: ReturnType<typeof providerTimeoutError> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = (): void => {
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
    try {
      const key = await raceWithAbort(this.resolveCredential(), controller.signal);
      const body = this.serializeRequest(req);
      controller.signal.throwIfAborted();
      req.onTransportStart?.("messages");
      const response = await raceWithAbort(this.fetchImpl(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${key}`,
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "x-openbot-purpose": req.purpose ?? "turn",
          "user-agent": "OpenBot/0.1.1",
          ...(req.sessionId ? { "x-opencode-session": req.sessionId } : {}),
        },
        body,
        signal: controller.signal,
      }), controller.signal);
      resetIdleTimer();
      if (!response.ok) throw new ApiError(`opencode-go: HTTP ${response.status}`, response.status);
      if (!response.body) throw new ApiError("opencode-go: resposta sem corpo", 502);
      await this.readAnthropicStream(response.body, emit, controller.signal, resetIdleTimer);
    } catch (error) {
      if (timeoutError) throw timeoutError;
      throw error instanceof ApiError ? error : normalizeOpenAiError(error);
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      clearTimeout(maxDurationTimer);
      req.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async readAnthropicStream(
    body: ReadableStream<Uint8Array>,
    emit: (event: ProviderStreamEvent) => void,
    signal: AbortSignal,
    onActivity: () => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const tools = new Map<number, { id: string; name: string; arguments: string; streaming: boolean; stopped: boolean }>();
    let buffer = "";
    let completed = false;
    let stopReason: string | undefined;
    let stopPayload: unknown;

    const isIncompleteReason = (reason: string | undefined): boolean =>
      reason === "max_tokens" || reason === "length" || reason === "content_filter";

    const dispatch = (frame: string): void => {
      const data = splitSseLines(frame).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data) return;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { throw new ApiError("opencode-go: frame Anthropic inválido", 502); }
      const event = record(parsed);
      if (!event || typeof event.type !== "string") return;
      const usage = parseProviderUsage(event.type === "message_start" ? record(event.message)?.usage : event.usage, "messages");
      if (usage) emit({ type: "usage", usage });
      if (event.type === "error") {
        const error = record(event.error);
        throw new ApiError(typeof error?.message === "string" ? error.message : "opencode-go: erro no stream", openAiStreamErrorStatus(error ?? {}, 502), event, {
          code: typeof error?.type === "string" ? error.type : undefined,
        });
      }
      const index = typeof event.index === "number" ? event.index : undefined;
      const block = record(event.content_block);
      const delta = record(event.delta);
      const currentStopReason = typeof delta?.stop_reason === "string" ? delta.stop_reason : undefined;
      if (stopReason === undefined && currentStopReason !== undefined) {
        stopReason = currentStopReason;
        stopPayload = parsed;
      }
      if (event.type === "content_block_start" && index !== undefined && block?.type === "tool_use" && stopReason === undefined) {
        if (typeof block.id !== "string" || typeof block.name !== "string") throw new ApiError("opencode-go: tool call inválida", 502);
        tools.set(index, { id: block.id, name: block.name, arguments: Object.keys(record(block.input) ?? {}).length ? JSON.stringify(block.input) : "", streaming: false, stopped: false });
      } else if (event.type === "content_block_delta" && stopReason === undefined && delta?.type === "text_delta" && typeof delta.text === "string") {
        emit({ type: "delta", delta: delta.text });
      } else if (event.type === "content_block_delta" && stopReason === undefined && index !== undefined && delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const tool = tools.get(index);
        if (!tool) throw new ApiError("opencode-go: argumentos chegaram antes da tool call", 502);
        if (!tool.streaming) {
          tool.arguments = "";
          tool.streaming = true;
        }
        tool.arguments += delta.partial_json;
      } else if (event.type === "content_block_stop" && index !== undefined) {
        const tool = tools.get(index);
        if (tool) tool.stopped = true;
      } else if (event.type === "message_stop") {
        completed = true;
      }
    };
    try {
      while (!completed) {
        const { done, value } = await raceWithAbort(reader.read(), signal);
        if (done) break;
        onActivity();
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 1_048_576) throw new ApiError("opencode-go: buffer SSE excedeu 1 MiB", 502);
        let boundary = findSseFrameBoundary(buffer);
        while (boundary) {
          dispatch(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary.length);
          boundary = findSseFrameBoundary(buffer);
        }
      }
      if (!completed) throw new ApiError("opencode-go: stream terminou antes de message_stop", 502);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (isIncompleteReason(stopReason)) {
      throw new ApiError(`opencode-go: geração interrompida (${stopReason})`, 400, stopPayload, { code: stopReason });
    }
    for (const tool of tools.values()) {
      if (!tool.stopped) continue;
      emit({ type: "tool-call", call: { id: tool.id, type: "function", function: { name: tool.name, arguments: tool.arguments || "{}" } } });
    }
  }
}
