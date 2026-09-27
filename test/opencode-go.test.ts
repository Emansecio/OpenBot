import { describe, expect, it, vi } from "vitest";

import { OpenCodeGoAdapter } from "../src/providers/opencode-go.js";
import { isContextOverflowError } from "../src/memory/context.js";
import type { ProviderStreamEvent } from "../src/providers/router.js";

const request = (model: string) => ({
  model,
  system: "Seja breve.",
  messages: [{ role: "user" as const, content: "oi" }],
  tools: [{
    type: "function" as const,
    function: { name: "clock", parameters: { type: "object", properties: {} } },
  }],
});

describe("OpenCode Go", () => {
  it.each(["minimax-m2.7", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max"])("routes %s through messages with a stable conversation session", async model => {
    const sessions: string[] = [];
    const adapter = new OpenCodeGoAdapter({ apiKey: "fixture", fetchImpl: (async (url, init) => {
      expect(String(url)).toBe("https://opencode.ai/zen/go/v1/messages");
      const headers = new Headers(init?.headers);
      expect(headers.get("user-agent")).toBe("OpenBot/0.1.1");
      sessions.push(headers.get("x-opencode-session")!);
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(model);
      expect(body.sessionId).toBeUndefined();
      return new Response('data: {"type":"message_stop"}\n\n');
    }) as typeof fetch });
    await adapter.streamChat({ ...request(`opencode-go/${model}`), sessionId: "conversation-fixture" }, () => undefined);
    await adapter.streamChat({ ...request(`opencode-go/${model}`), sessionId: "conversation-fixture" }, () => undefined);
    expect(sessions).toEqual(["conversation-fixture", "conversation-fixture"]);
  });
  it("keeps the provider's error message and Retry-After when a messages request fails", async () => {
    const overflow = new OpenCodeGoAdapter({ apiKey: "oc-test", fetchImpl: (async () => Response.json(
      { type: "error", error: { type: "invalid_request_error", message: "prompt too long: 210000 tokens > 200000 maximum" } },
      { status: 400 },
    )) as typeof fetch });
    const error = await overflow.streamChat(request("opencode-go/minimax-m3"), () => undefined).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 400, message: expect.stringContaining("prompt too long") });
    // The tool loop and memory reflection shrink the request on this signal.
    expect(isContextOverflowError(error)).toBe(true);

    const limited = new OpenCodeGoAdapter({ apiKey: "oc-test", fetchImpl: (async () => new Response("{}", {
      status: 429, headers: { "retry-after": "7" },
    })) as typeof fetch });
    await expect(limited.streamChat(request("opencode-go/minimax-m3"), () => undefined)).rejects.toMatchObject({ status: 429, retryAfterMs: 7_000 });
  });

  it("lets the caller cancel a model discovery that hangs", async () => {
    const adapter = new OpenCodeGoAdapter({ apiKey: "oc-test", fetchImpl: ((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })) as typeof fetch });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled")), 20);
    await expect(adapter.discoverModels(controller.signal)).rejects.toThrow("cancelled");
  });

  it("discovers all valid public model identifiers without sending credentials", async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return Response.json({ data: [{ id: "glm-5.3" }, { id: "minimax-m3" }, { id: "future-unknown" }] });
    }) as unknown as typeof fetch;
    const adapter = new OpenCodeGoAdapter({ apiKey: "oc-test", fetchImpl });

    await expect(adapter.discoverModels()).resolves.toEqual(["glm-5.3", "minimax-m3", "future-unknown"]);
    expect(fetchImpl).toHaveBeenCalledWith("https://opencode.ai/zen/go/v1/models", expect.objectContaining({ method: "GET" }));
  });

  it("merges declared free zen models into discovery without listing paid ids", async () => {
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      if (url === "https://opencode.ai/zen/v1/models") {
        return Response.json({ data: [{ id: "mimo-v2.5-free" }, { id: "gpt-6-astra" }] });
      }
      return Response.json({ data: [{ id: "glm-5.3" }] });
    }) as unknown as typeof fetch;
    const adapter = new OpenCodeGoAdapter({ apiKey: "oc-test", fetchImpl });

    await expect(adapter.discoverModels()).resolves.toEqual(["glm-5.3", "zen/mimo-v2.5-free"]);
  });

  it.each([
    ["opencode-go/gpt-5.6-luna", "/responses", 'data: {"type":"response.done","response":{"status":"completed"}}\n\n'],
    ["glm-5.3", "/chat/completions", "data: [DONE]\n\n"],
  ])("routes %s through %s", async (model, path, stream) => {
    let url = "";
    const fetchImpl = vi.fn(async (input, init) => {
      url = String(input);
      expect(new Headers(init?.headers).get("x-opencode-session")).toBe("conversation-fixture");
      expect(new Headers(init?.headers).get("user-agent")).toBe("OpenBot/0.1.1");
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const adapter = new OpenCodeGoAdapter({ apiKey: "oc-test", fetchImpl });

    await adapter.streamChat({ ...request(model), sessionId: "conversation-fixture" }, () => undefined);

    expect(url).toBe(`https://opencode.ai/zen/go/v1${path}`);
  });

  it.each([
    ["opencode-go/zen/mimo-v2.5-free", "/chat/completions", "data: [DONE]\n\n"],
    ["opencode-go/zen/muse-spark-1.3-contributor-free", "/responses", 'data: {"type":"response.done","response":{"status":"completed"}}\n\n'],
  ])("routes free tier %s through the zen endpoint %s", async (model, path, stream) => {
    let url = "";
    let wireModel = "";
    const fetchImpl = vi.fn(async (input, init) => {
      url = String(input);
      wireModel = JSON.parse(String(init?.body)).model;
      expect(new Headers(init?.headers).get("x-opencode-session")).toBe("conversation-fixture");
      expect(new Headers(init?.headers).get("user-agent")).toBe("OpenBot/0.1.1");
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const adapter = new OpenCodeGoAdapter({ apiKey: "oc-test", fetchImpl });

    await adapter.streamChat({ ...request(model), sessionId: "conversation-fixture" }, () => undefined);

    expect(url).toBe(`https://opencode.ai/zen/v1${path}`);
    expect(wireModel).toBe(model.replace("opencode-go/zen/", ""));
  });

  it("streams Anthropic text and tool calls through /messages", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = vi.fn(async (input, init) => {
      captured = { url: String(input), init };
      const frames = [
        { type: "message_start", message: { id: "msg_1" } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Olá" } },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_1", name: "clock", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"tz\":\"UTC\"}" } },
        { type: "content_block_stop", index: 1 },
        { type: "message_stop" },
      ];
      return new Response(frames.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const adapter = new OpenCodeGoAdapter({ apiKey: "oc-test", fetchImpl });
    const events: ProviderStreamEvent[] = [];

    await adapter.streamChat({
      ...request("minimax-m3"),
      messages: [
        { role: "user", content: "use a tool" },
        { role: "assistant", content: "", toolCalls: [{ id: "prior", type: "function", function: { name: "clock", arguments: "{}" } }] },
        {
          role: "tool",
          toolCallId: "prior",
          content: "clock failed",
          toolResult: { ok: false, error: "clock failed", code: "io_error", partialContent: "partial clock output" },
        },
      ],
    }, (event) => events.push(event));

    expect(captured?.url).toBe("https://opencode.ai/zen/go/v1/messages");
    const headers = new Headers(captured?.init?.headers);
    expect(headers.get("x-api-key")).toBe("oc-test");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    const body = JSON.parse(String(captured?.init?.body)) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const priorResult = body.messages.at(-1)?.content[0];
    expect(priorResult).toMatchObject({ type: "tool_result", tool_use_id: "prior", is_error: true });
    expect(JSON.parse(String(priorResult?.content))).toMatchObject({
      openbotToolResult: { ok: false, error: "clock failed", code: "io_error" },
      partialOutput: "partial clock output",
    });
    expect(events).toEqual([
      { type: "delta", delta: "Olá" },
      { type: "tool-call", call: { id: "tool_1", type: "function", function: { name: "clock", arguments: "{\"tz\":\"UTC\"}" } } },
    ]);
  });

  it("rejeita início de tool call Anthropic sem index", async () => {
    const frames = [
      { type: "content_block_start", content_block: { type: "tool_use", id: "tool_1", name: "clock", input: {} } },
      { type: "message_stop" },
    ];
    const adapter = new OpenCodeGoAdapter({
      apiKey: "oc-test",
      fetchImpl: vi.fn(async () => new Response(frames.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))) as unknown as typeof fetch,
    });

    await expect(adapter.streamChat(request("minimax-m3"), () => undefined)).rejects.toMatchObject({ status: 502 });
  });

  it("rejeita tool call sem content_block_stop", async () => {
    const frames = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_1", name: "clock", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"tz\":\"UTC\"}" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ];
    const adapter = new OpenCodeGoAdapter({
      apiKey: "oc-test",
      fetchImpl: vi.fn(async () => new Response(frames.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))) as unknown as typeof fetch,
    });

    await expect(adapter.streamChat(request("minimax-m3"), () => undefined)).rejects.toMatchObject({ status: 502 });
  });

  it("rejeita stop_reason desconhecido", async () => {
    const frames = [
      { type: "message_delta", delta: { stop_reason: "future_reason" } },
      { type: "message_stop" },
    ];
    const adapter = new OpenCodeGoAdapter({
      apiKey: "oc-test",
      fetchImpl: vi.fn(async () => new Response(frames.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))) as unknown as typeof fetch,
    });

    await expect(adapter.streamChat(request("minimax-m3"), () => undefined)).rejects.toMatchObject({ status: 502, code: "future_reason" });
  });

  it("fails closed without credentials or a known protocol", async () => {
    const missing = new OpenCodeGoAdapter({ fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(missing.streamChat(request("glm-5.3"), () => undefined)).rejects.toMatchObject({ status: 401 });

    const configured = new OpenCodeGoAdapter({ apiKey: "oc-test", fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(configured.streamChat(request("future-unknown"), () => undefined)).rejects.toMatchObject({ status: 400 });
  });
});
