import { describe, expect, it, vi } from "vitest";

import { OpenCodeGoAdapter } from "../src/providers/opencode-go.js";
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

    await adapter.streamChat(request("minimax-m3"), (event) => events.push(event));

    expect(captured?.url).toBe("https://opencode.ai/zen/go/v1/messages");
    const headers = new Headers(captured?.init?.headers);
    expect(headers.get("x-api-key")).toBe("oc-test");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(events).toEqual([
      { type: "delta", delta: "Olá" },
      { type: "tool-call", call: { id: "tool_1", type: "function", function: { name: "clock", arguments: "{\"tz\":\"UTC\"}" } } },
    ]);
  });

  it("fails closed without credentials or a known protocol", async () => {
    const missing = new OpenCodeGoAdapter({ fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(missing.streamChat(request("glm-5.3"), () => undefined)).rejects.toMatchObject({ status: 401 });

    const configured = new OpenCodeGoAdapter({ apiKey: "oc-test", fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(configured.streamChat(request("future-unknown"), () => undefined)).rejects.toMatchObject({ status: 400 });
  });
});
