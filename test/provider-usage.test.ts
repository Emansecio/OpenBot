import { describe, expect, it, vi } from "vitest";
import { OpenAiAdapter } from "../src/providers/openai.js";
import { OpenAiCompatAdapter } from "../src/providers/openai-compat.js";
import { OpenCodeGoAdapter } from "../src/providers/opencode-go.js";
import { createProviderRegistry, streamChat, type ProviderStreamEvent } from "../src/providers/router.js";

const request = { model: "gpt-6-astra", purpose: "memory-reflection" as const, messages: [{ role: "user" as const, content: "private prompt" }] };
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""));
const complete = { type: "response.completed", response: { status: "completed" } };
const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 12 } };

describe("provider attempts, errors and usage", () => {
  it.each([
    { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
    { type: "response.done", response: { status: "incomplete", incomplete_details: { reason: "content_filter" } } },
    { type: "response.failed", response: { error: { code: "invalid_prompt", message: "private failure" } } },
    { type: "error", code: "invalid_request_error", message: "private failure" },
  ])("does not retry permanent Responses termination $type", async event => {
    const fetchImpl = vi.fn(async () => sse([event]));
    const registry = createProviderRegistry();
    registry.register(new OpenAiAdapter({ apiKey: "private-key", fetchImpl }));
    const result = await streamChat("openai", request, undefined, { registry, sleep: async () => {} });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.error).toMatchObject({ kind: "validation", retryable: false });
    expect(result.attempts).toEqual([expect.objectContaining({ attempt: 1, protocol: "responses", outcome: "error", purpose: "memory-reflection" })]);
    expect(JSON.stringify(result.attempts)).not.toMatch(/private/);
  });

  it.each([429, 503, "server_error", "rate_limit_exceeded"])("recovers transient %s and keeps usage per attempt", async failure => {
    const fetchImpl = vi.fn().mockImplementationOnce(async () => typeof failure === "number"
      ? new Response("unavailable", { status: failure })
      : sse([{ type: "response.failed", response: { error: { code: failure }, usage: { output_tokens: 2 } } }]))
      .mockImplementationOnce(async () => sse([{ ...complete, response: { status: "completed", usage } }]));
    const registry = createProviderRegistry();
    registry.register(new OpenAiAdapter({ apiKey: "fixture", fetchImpl }));
    const result = await streamChat("openai", request, undefined, { registry, sleep: async () => {} });
    expect(result.error).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts![0]!.usage).toEqual(typeof failure === "number" ? undefined : { outputTokens: 2 });
    expect(result.attempts![1]!.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 80, reasoningTokens: 12 });
    expect(result.attempts![0]!.requestId).toBe(result.attempts![1]!.requestId);
    expect(result.attempts![0]!.attemptId).not.toBe(result.attempts![1]!.attemptId);
  });

  it("keeps partial output and usage on failure without replay", async () => {
    const registry = createProviderRegistry();
    const fetchImpl = vi.fn(async () => sse([
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.failed", response: { error: { code: "server_error" }, usage } },
    ]));
    registry.register(new OpenAiAdapter({ apiKey: "fixture", fetchImpl }));
    const events: ProviderStreamEvent[] = [];
    const result = await streamChat("openai", request, event => events.push(event), { registry });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "delta", delta: "partial" });
    expect(result.attempts![0]!.usage?.totalTokens).toBe(120);
  });

  it.each(["openai", "openai-compat"])("captures %s Chat usage-only frames and requests usage", async name => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.stream_options).toEqual({ include_usage: true });
      expect(body).not.toHaveProperty("requestId");
      return sse([{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 12 } } }, "[DONE]"]);
    });
    const registry = createProviderRegistry();
    registry.register(name === "openai" ? new OpenAiAdapter({ apiKey: "fixture", fetchImpl }) : new OpenAiCompatAdapter({ baseUrl: "http://127.0.0.1:9999/v1", fetchImpl }));
    const result = await streamChat(name, { ...request, model: "chat-test" }, undefined, { registry });
    expect(result.error).toBeUndefined();
    expect(result.attempts![0]!.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 80, reasoningTokens: 12 });
  });

  it("merges Messages cumulative usage without summing snapshots or inventing totals", async () => {
    const registry = createProviderRegistry();
    registry.register(new OpenCodeGoAdapter({ apiKey: "fixture", fetchImpl: async () => sse([
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 } } },
      { type: "message_delta", usage: { output_tokens: 10 } },
      { type: "message_delta", usage: { output_tokens: 20, total_tokens: -1 } },
      { type: "message_stop" },
    ]) }));
    const result = await streamChat("opencode-go", { ...request, model: "opencode-go/minimax-m2.7" }, undefined, { registry });
    expect(result.error).toBeUndefined();
    expect(result.attempts![0]!.usage).toEqual({ inputTokens: 10, outputTokens: 20, cachedInputTokens: 80, cacheCreationInputTokens: 5 });
  });

  it("propagates Messages max_tokens after final usage without applying a partial tool", async () => {
    const registry = createProviderRegistry();
    const fetchImpl = vi.fn(async () => sse([
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "clock", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"tz\":\"UTC\"}" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "parcial" } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 20, total_tokens: 30 } },
      { type: "message_stop" },
    ]));
    registry.register(new OpenCodeGoAdapter({ apiKey: "fixture", fetchImpl }));
    const events: ProviderStreamEvent[] = [];

    const result = await streamChat("opencode-go", { ...request, model: "opencode-go/minimax-m2.7" }, event => events.push(event), { registry, maxRetries: 2 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.error).toMatchObject({ kind: "validation", status: 400, code: "max_tokens", retryable: false });
    expect(result.message).toBeUndefined();
    expect(events).toContainEqual({ type: "delta", delta: "parcial" });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "tool-call" }));
    expect(result.attempts![0]!.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  });

  it.each(["invalid_request_error", "overloaded_error"])("classifies Messages %s with default retries", async type => {
    const fetchImpl = vi.fn(async () => sse([{ type: "error", error: { type } }]));
    const registry = createProviderRegistry();
    registry.register(new OpenCodeGoAdapter({ apiKey: "fixture", fetchImpl }));
    const result = await streamChat("opencode-go", { ...request, model: "opencode-go/minimax-m2.7" }, undefined, { registry, sleep: async () => {} });
    expect(fetchImpl).toHaveBeenCalledTimes(type === "invalid_request_error" ? 1 : 3);
    expect(result.error?.code).toBe(type);
  });

  it("does not count preflight cancellation or missing credentials as transport attempts", async () => {
    const registry = createProviderRegistry();
    const fetchImpl = vi.fn();
    registry.register(new OpenAiAdapter({ fetchImpl }));
    const result = await streamChat("openai", request, undefined, { registry });
    expect(result.error?.kind).toBe("auth");
    const cancelled = await streamChat("openai", { ...request, signal: AbortSignal.abort() }, undefined, { registry });
    expect(cancelled.aborted).toBe(true);
    expect(result.attempts).toEqual([]);
    expect(cancelled.attempts).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records cancellation during transport with unknown usage", async () => {
    const registry = createProviderRegistry();
    const controller = new AbortController();
    registry.register(new OpenAiAdapter({ apiKey: "fixture", fetchImpl: async () => {
      queueMicrotask(() => controller.abort());
      throw new DOMException("aborted", "AbortError");
    } }));
    const result = await streamChat("openai", { ...request, signal: controller.signal }, undefined, { registry });
    expect(result.aborted).toBe(true);
    expect(result.attempts).toEqual([expect.objectContaining({ outcome: "aborted", usage: undefined })]);
  });
});
