import type { Keystore } from "../keystore/index.js";
import type { ProviderAdapter, ProviderChatMessage, ProviderChatRequest, ProviderStreamEvent } from "./router.js";
import {
  ApiError,
  findSseFrameBoundary,
  normalizeOpenAiError,
  providerTimeoutError,
  raceWithAbort,
  splitSseLines,
} from "./openai-helpers.js";
import { OpenAiAdapter } from "./openai.js";
import {
  OPENCODE_GO_MODELS,
  openCodeGoRemoteId,
} from "./opencode-go-models.js";

export { OPENCODE_GO_MODELS, openCodeGoCatalogId, openCodeGoRemoteId } from "./opencode-go-models.js";
export type { OpenCodeGoProtocol } from "./opencode-go-models.js";

export const OPENCODE_GO_PROVIDER_NAME = "opencode-go" as const;
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1" as const;

export interface OpenCodeGoAdapterOptions {
  apiKey?: string;
  keystore?: Keystore;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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
  readonly name = OPENCODE_GO_PROVIDER_NAME;
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly keystore?: Keystore;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly responses: OpenAiAdapter;
  private readonly chat: OpenAiAdapter;

  constructor(opts: OpenCodeGoAdapterOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? OPENCODE_GO_BASE_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.keystore = opts.keystore;
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    const shared = {
      name: this.name,
      requestHeaders: (req: ProviderChatRequest) => ({ "user-agent": "OpenBot/0.1.1", ...(req.sessionId ? { "x-opencode-session": req.sessionId } : {}) }),
      baseUrl: this.baseUrl,
      credentialResolver: () => this.resolveCredential().then((accessToken) => ({ accessToken })),
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    };
    this.responses = new OpenAiAdapter({ ...shared, protocol: "responses" });
    this.chat = new OpenAiAdapter({ ...shared, protocol: "openai" });
  }

  private async resolveCredential(): Promise<string> {
    const key = this.apiKey ?? await this.keystore?.reveal(this.name) ?? undefined;
    if (key) return key;
    throw new ApiError("chave de API do OpenCode Go não configurada", 401);
  }

  async discoverModels(signal?: AbortSignal): Promise<string[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/models`, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": "OpenBot/0.1.1" },
      signal,
    });
    if (!response.ok) throw new ApiError(`opencode-go: HTTP ${response.status} ao detectar modelos`, response.status);
    const payload = record(await response.json());
    if (!Array.isArray(payload?.data)) throw new ApiError("opencode-go: catálogo de modelos inválido", 502);
    return [...new Set(payload.data.map((item) => record(item)?.id).filter((id): id is string =>
      typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(id)))];
  }

  serializeRequest(req: ProviderChatRequest): string {
    const remoteModel = openCodeGoRemoteId(req.model);
    const protocol = this.requestProtocol(req);
    if (!protocol) throw new ApiError(`opencode-go: modelo sem protocolo conhecido: ${req.model}`, 400);
    const remoteRequest = remoteModel === req.model ? req : { ...req, model: remoteModel };
    if (protocol === "responses") return this.responses.serializeRequest(remoteRequest);
    if (protocol === "chat") return this.chat.serializeRequest(remoteRequest);
    return JSON.stringify(buildAnthropicBody(remoteRequest));
  }

  async streamChat(req: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void): Promise<void> {
    const remoteModel = openCodeGoRemoteId(req.model);
    const protocol = this.requestProtocol(req);
    if (!protocol) throw new ApiError(`opencode-go: modelo sem protocolo conhecido: ${req.model}`, 400);
    const remoteRequest = remoteModel === req.model ? req : { ...req, model: remoteModel };
    if (protocol === "responses") return this.responses.streamChat(remoteRequest, emit);
    if (protocol === "chat") return this.chat.streamChat(remoteRequest, emit);
    return this.streamAnthropic(remoteRequest, emit);
  }

  private requestProtocol(req: ProviderChatRequest) {
    const snapshot = req.modelResolution;
    if (snapshot?.entry.provider === this.name && openCodeGoRemoteId(snapshot.entry.id) === openCodeGoRemoteId(req.model)) {
      return snapshot.protocol === "codex" ? undefined : snapshot.protocol;
    }
    return OPENCODE_GO_MODELS[openCodeGoRemoteId(req.model)]?.protocol;
  }

  private async streamAnthropic(req: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void): Promise<void> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(req.signal?.reason);
    req.signal?.addEventListener("abort", onAbort, { once: true });
    if (req.signal?.aborted) onAbort();
    let timeoutError: ReturnType<typeof providerTimeoutError> | undefined;
    const timer = setTimeout(() => {
      timeoutError = providerTimeoutError(this.timeoutMs);
      controller.abort(timeoutError);
    }, this.timeoutMs);
    try {
      const key = await raceWithAbort(this.resolveCredential(), controller.signal);
      const response = await raceWithAbort(this.fetchImpl(`${this.baseUrl}/messages`, {
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
        body: this.serializeRequest(req),
        signal: controller.signal,
      }), controller.signal);
      if (!response.ok) throw new ApiError(`opencode-go: HTTP ${response.status}`, response.status);
      if (!response.body) throw new ApiError("opencode-go: resposta sem corpo", 502);
      await this.readAnthropicStream(response.body, emit, controller.signal);
    } catch (error) {
      if (timeoutError) throw timeoutError;
      throw error instanceof ApiError ? error : normalizeOpenAiError(error);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async readAnthropicStream(
    body: ReadableStream<Uint8Array>,
    emit: (event: ProviderStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const tools = new Map<number, { id: string; name: string; arguments: string; streaming: boolean }>();
    let buffer = "";
    let completed = false;
    const dispatch = (frame: string): void => {
      const data = splitSseLines(frame).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data) return;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { throw new ApiError("opencode-go: frame Anthropic inválido", 502); }
      const event = record(parsed);
      if (!event || typeof event.type !== "string") return;
      if (event.type === "error") {
        const error = record(event.error);
        throw new ApiError(typeof error?.message === "string" ? error.message : "opencode-go: erro no stream", 502);
      }
      const index = typeof event.index === "number" ? event.index : undefined;
      const block = record(event.content_block);
      const delta = record(event.delta);
      if (event.type === "content_block_start" && index !== undefined && block?.type === "tool_use") {
        if (typeof block.id !== "string" || typeof block.name !== "string") throw new ApiError("opencode-go: tool call inválida", 502);
        tools.set(index, { id: block.id, name: block.name, arguments: Object.keys(record(block.input) ?? {}).length ? JSON.stringify(block.input) : "", streaming: false });
      } else if (event.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
        emit({ type: "delta", delta: delta.text });
      } else if (event.type === "content_block_delta" && index !== undefined && delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const tool = tools.get(index);
        if (!tool) throw new ApiError("opencode-go: argumentos chegaram antes da tool call", 502);
        if (!tool.streaming) {
          tool.arguments = "";
          tool.streaming = true;
        }
        tool.arguments += delta.partial_json;
      } else if (event.type === "content_block_stop" && index !== undefined) {
        const tool = tools.get(index);
        if (tool) {
          emit({ type: "tool-call", call: { id: tool.id, type: "function", function: { name: tool.name, arguments: tool.arguments || "{}" } } });
          tools.delete(index);
        }
      } else if (event.type === "message_stop") {
        completed = true;
      }
    };
    try {
      while (!completed) {
        const { done, value } = await raceWithAbort(reader.read(), signal);
        if (done) break;
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
  }
}
