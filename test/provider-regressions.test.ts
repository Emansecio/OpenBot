import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";

import type { Keystore } from "../src/keystore/index.js";
import { testCompatConnection } from "../src/providers/local-discover.js";
import { OpenAiCompatAdapter, validateCompatBaseUrl } from "../src/providers/openai-compat.js";
import { OpenAiToolCallAccumulator } from "../src/providers/openai-helpers.js";
import { OpenAiAdapter } from "../src/providers/openai.js";
import { defaultRegistry, streamChat } from "../src/providers/router.js";

const encoder = new TextEncoder();
const request = { model: "test", messages: [{ role: "user" as const, content: "oi" }] };
type FetchInput = Parameters<typeof fetch>[0];

afterEach(() => defaultRegistry.clear());

function delayedChunkedResponse(chunks: string[], delayMs: number): Response {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0;
      const push = () => {
        const chunk = chunks[index++];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunk));
        timer = setTimeout(push, delayMs);
      };
      timer = setTimeout(push, delayMs);
    },
    cancel() { if (timer !== undefined) clearTimeout(timer); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunkedResponse(chunks: string[]): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("regressões do transporte OpenAI-like", () => {
  it.each([
    ["openai", "length"],
    ["openai", "content_filter"],
    ["compat", "length"],
    ["compat", "content_filter"],
  ] as const)("propaga finish_reason %s/%s após consumir o uso final", async (kind, reason) => {
    const fetchImpl = vi.fn(async () => chunkedResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "parcial" }, finish_reason: reason }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`,
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;
    const adapter = kind === "openai"
      ? new OpenAiAdapter({ apiKey: "sk-test", fetchImpl })
      : new OpenAiCompatAdapter({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });
    defaultRegistry.register(adapter);
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    const result = await streamChat(adapter.name, { ...request, model: "chat-test" }, event => events.push(event), { maxRetries: 2 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.error).toMatchObject({ kind: "validation", status: 400, code: reason, retryable: false });
    expect(result.message).toBeUndefined();
    expect(events).toContainEqual({ type: "delta", delta: "parcial" });
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } });
  });

  it.each(["openai", "compat"] as const)("emite tool call completa no término normal do Chat %s", async kind => {
    const fetchImpl = vi.fn(async () => chunkedResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "clock", arguments: "{}" } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;
    const adapter = kind === "openai"
      ? new OpenAiAdapter({ apiKey: "sk-test", fetchImpl })
      : new OpenAiCompatAdapter({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });
    defaultRegistry.register(adapter);

    const result = await streamChat(adapter.name, { ...request, model: "chat-test" }, undefined, { maxRetries: 0 });

    expect(result.error).toBeUndefined();
    expect(result.message?.toolCalls).toEqual([{ id: "call-1", type: "function", function: { name: "clock", arguments: "{}" } }]);
  });

  it("rejeita frame JSON sem o contrato de chat-completions", async () => {
    const fetchImpl = vi.fn(async () => chunkedResponse([
      'data: {"object":"chat.completion.chunk","unexpected":true}\n\n',
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;
    const adapter = new OpenAiAdapter({ apiKey: "sk-test", fetchImpl });
    defaultRegistry.register(adapter);

    const result = await streamChat(adapter.name, request, undefined, { maxRetries: 0 });

    expect(result.error).toMatchObject({ kind: "server", status: 502, retryable: true });
    expect(result.message).toBeUndefined();
  });

  it("aplica a mesma validação de frame ao provider compatível", async () => {
    const fetchImpl = vi.fn(async () => chunkedResponse([
      'data: {"object":"chat.completion.chunk","unexpected":true}\n\n',
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;
    const adapter = new OpenAiCompatAdapter({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });
    defaultRegistry.register(adapter);

    const result = await streamChat(adapter.name, request, undefined, { maxRetries: 0 });

    expect(result.error).toMatchObject({ kind: "server", status: 502, retryable: true });
  });

  it("rejeita tool call incompleta ao terminar o stream", async () => {
    const payload = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] });
    const fetchImpl = vi.fn(async () => chunkedResponse([
      `data: ${payload}\n\n`,
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;
    const adapter = new OpenAiAdapter({ apiKey: "sk-test", fetchImpl });
    defaultRegistry.register(adapter);

    const result = await streamChat(adapter.name, request, undefined, { maxRetries: 0 });

    expect(result.error).toMatchObject({ kind: "server", status: 502, retryable: true });
    expect(result.message).toBeUndefined();
  });

  it.each(["openai", "compat"] as const)("rejeita finish_reason desconhecido em %s", async kind => {
    const fetchImpl = vi.fn(async () => chunkedResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "parcial" }, finish_reason: "future_reason" }] })}\n\n`,
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;
    const adapter = kind === "openai"
      ? new OpenAiAdapter({ apiKey: "sk-test", fetchImpl })
      : new OpenAiCompatAdapter({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });
    defaultRegistry.register(adapter);

    const result = await streamChat(adapter.name, request, undefined, { maxRetries: 0 });

    expect(result.error).toMatchObject({ kind: "server", status: 502, code: "future_reason" });
    expect(result.message).toBeUndefined();
  });

  it("valida índice, tipo, ordem, identidade e JSON das tool calls OpenAI-like", () => {
    const invalid = new OpenAiToolCallAccumulator();
    expect(() => invalid.add({ function: { name: "clock" } } as never)).toThrow(/índice válido/);
    expect(() => invalid.add({ index: 0, type: "custom" } as never)).toThrow(/tipo de tool call/);

    const ordered = new OpenAiToolCallAccumulator();
    ordered.add({ index: 2, id: "call-2", type: "function", function: { name: "second", arguments: "{}" } });
    ordered.add({ index: 0, id: "call-0", type: "function", function: { name: "first", arguments: "{}" } });
    expect(ordered.finalizedCalls().map(call => call.id)).toEqual(["call-0", "call-2"]);

    const duplicate = new OpenAiToolCallAccumulator();
    duplicate.add({ index: 0, id: "same", function: { name: "first", arguments: "{}" } });
    duplicate.add({ index: 1, id: "same", function: { name: "second", arguments: "{}" } });
    expect(() => duplicate.finalizedCalls()).toThrow(/duplicado/);

    const openJson = new OpenAiToolCallAccumulator();
    openJson.add({ index: 0, id: "call", function: { name: "clock", arguments: "{\"tz\":" } });
    expect(() => openJson.finalizedCalls()).toThrow(/JSON completo/);
  });

  it("drena frames completos antes de aplicar o limite ao residual SSE", async () => {
    const padding = "x".repeat(600 * 1024);
    const frame = `data: ${JSON.stringify({ choices: [], padding })}\n\n`;
    const fetchImpl = vi.fn(async () => chunkedResponse([frame + frame + "data: [DONE]\n\n"])) as unknown as typeof fetch;
    const adapter = new OpenAiAdapter({ apiKey: "sk-test", fetchImpl });

    await expect(adapter.streamChat(request, () => undefined)).resolves.toBeUndefined();
  });

  it("propaga Retry-After do HTTP para a política do router", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "rate limit" } }),
      { status: 429, headers: { "retry-after": "5" } },
    )) as unknown as typeof fetch;
    const adapter = new OpenAiAdapter({ apiKey: "sk-test", fetchImpl });
    defaultRegistry.register(adapter);

    const result = await streamChat(adapter.name, request, undefined, { maxRetries: 0 });

    expect(result.error).toMatchObject({ kind: "rate-limit", retryAfterMs: 5_000 });
  });

  it("classifica rate limit entregue dentro do stream HTTP 200", async () => {
    const payload = JSON.stringify({ error: { message: "rate limited", code: "rate_limit_exceeded" } });
    const fetchImpl = vi.fn(async () => chunkedResponse([`data: ${payload}\n\n`])) as unknown as typeof fetch;
    const adapter = new OpenAiAdapter({ apiKey: "sk-test", fetchImpl });
    defaultRegistry.register(adapter);

    const result = await streamChat(adapter.name, request, undefined, { maxRetries: 0 });

    expect(result.error).toMatchObject({ kind: "rate-limit", status: 429, retryable: true });
  });

  it("aceita CRLF quando o par \\r\\n é dividido entre chunks", async () => {
    const payload = JSON.stringify({ choices: [{ delta: { content: "ok" } }] });
    const fetchImpl = vi.fn(async () => chunkedResponse([
      `data: ${payload}\r`, "\n\r", "\ndata: [DONE]\r", "\n\r", "\n",
    ])) as unknown as typeof fetch;
    const adapter = new OpenAiAdapter({ apiKey: "sk-test", fetchImpl });
    defaultRegistry.register(adapter);

    const result = await streamChat(adapter.name, request);

    expect(result.error).toBeUndefined();
    expect(result.message?.content).toBe("ok");
  });

  it("cancela o reader/body quando um frame SSE falha", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode("data: {inválido}\n\n")); },
      cancel,
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const adapter = new OpenAiCompatAdapter({
      baseUrl: "http://127.0.0.1:1234/v1",
      fetchImpl,
    });
    defaultRegistry.register(adapter);

    // Este caso valida exclusivamente o teardown do body malformado. Retry tem
    // cobertura própria no router e reutilizaria deliberadamente este stream.
    const result = await streamChat(adapter.name, request, undefined, { maxRetries: 0 });

    expect(result.error?.kind).toBe("server");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["openai", "compat"] as const)("timeout de %s continua recuperável manualmente sem repetição automática", async (kind) => {
    const fetchImpl = vi.fn((_input: FetchInput, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })) as unknown as typeof fetch;
    const adapter = kind === "openai"
      ? new OpenAiAdapter({ apiKey: "sk-test", fetchImpl, timeoutMs: 10 })
      : new OpenAiCompatAdapter({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl, timeoutMs: 10 });
    defaultRegistry.register(adapter);

    const sleep = vi.fn(async () => {});
    const result = await streamChat(adapter.name, request, undefined, { sleep });

    expect(result.aborted).toBe(false);
    expect(result.error).toMatchObject({ kind: "network", code: "ETIMEDOUT", retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(["openai", "compat"] as const)("não repete %s ao esgotar o prazo absoluto apesar dos heartbeats", async (kind) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => delayedChunkedResponse(Array(30).fill(": ping\n\n"), 5)) as unknown as typeof fetch;
    const adapter = kind === "openai"
      ? new OpenAiAdapter({ apiKey: "sk-test", fetchImpl, timeoutMs: 20, maxDurationMs: 40 })
      : new OpenAiCompatAdapter({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl, timeoutMs: 20, maxDurationMs: 40 });
    defaultRegistry.register(adapter);
    const sleep = vi.fn(async () => {});
    try {
      const pending = streamChat(adapter.name, request, undefined, { sleep });
      await vi.advanceTimersByTimeAsync(150);
      expect((await pending).error).toMatchObject({ kind: "network", code: "ETIMEDOUT", retryable: true });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each([["openai", false], ["compat", false], ["openai", true], ["compat", true]] as const)(
    "classifica queda real de socket em %s (texto parcial: %s)", async (kind, partial) => {
      let calls = 0;
      const server = createServer((req, res) => {
        req.resume();
        calls += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (calls > 1) {
          res.end('data: {"choices":[{"delta":{"content":"recuperado"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
          return;
        }
        res.write(partial ? 'data: {"choices":[{"delta":{"content":"parcial"}}]}\n\n' : ": ping\n\n");
        setTimeout(() => res.destroy(), 30);
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("fixture address missing");
        const baseUrl = `http://127.0.0.1:${address.port}/v1`;
        const adapter = kind === "openai" ? new OpenAiAdapter({ baseUrl, apiKey: "fixture-only" }) : new OpenAiCompatAdapter({ baseUrl });
        defaultRegistry.register(adapter);
        const events: string[] = [];
        const result = await streamChat(adapter.name, request, event => events.push(event.type), { sleep: async () => {} });
        if (partial) {
          expect(calls).toBe(1);
          expect(events).toEqual(["delta", "error"]);
          expect(result.error).toMatchObject({ kind: "network", code: "UND_ERR_SOCKET", retryable: true });
        } else {
          expect(calls).toBe(2);
          expect(result.error).toBeUndefined();
          expect(result.message?.content).toBe("recuperado");
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    },
  );

  it.each(["openai", "compat"] as const)("reseta idle timeout a cada chunk no adapter %s", async (kind) => {
    vi.useFakeTimers();
    const payload = JSON.stringify({ choices: [{ delta: { content: "ok" } }] });
    const fetchImpl = vi.fn(async () => delayedChunkedResponse([
      "data: {\"choices\":[]}\n\n",
      `data: ${payload}\n\n`,
      "data: [DONE]\n\n",
    ], 12)) as unknown as typeof fetch;
    const adapter = kind === "openai"
      ? new OpenAiAdapter({ apiKey: "sk-test", fetchImpl, timeoutMs: 20, maxDurationMs: 200 })
      : new OpenAiCompatAdapter({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl, timeoutMs: 20, maxDurationMs: 200 });
    defaultRegistry.register(adapter);

    try {
      const pending = streamChat(adapter.name, request, undefined, { maxRetries: 0 });
      for (let chunk = 0; chunk < 4; chunk += 1) await vi.advanceTimersByTimeAsync(12);
      const result = await pending;

      expect(result.error).toBeUndefined();
      expect(result.message?.content).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("timeout abrange resolução de chave que fica pendente", async () => {
    const keystore = {
      reveal: () => new Promise<string | null>(() => undefined),
    } as unknown as Keystore;
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const adapter = new OpenAiAdapter({ keystore, fetchImpl, timeoutMs: 10 });
    defaultRegistry.register(adapter);

    const result = await streamChat(adapter.name, request, undefined, { maxRetries: 0 });

    expect(result.error).toMatchObject({ kind: "network", code: "ETIMEDOUT", retryable: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("abort do usuário durante resolução de chave continua sendo aborted", async () => {
    const controller = new AbortController();
    const keystore = {
      reveal: () => new Promise<string | null>(() => undefined),
    } as unknown as Keystore;
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const adapter = new OpenAiAdapter({ keystore, fetchImpl, timeoutMs: 1_000 });
    defaultRegistry.register(adapter);
    const pending = streamChat(adapter.name, { ...request, signal: controller.signal });

    controller.abort();
    const result = await pending;

    expect(result.aborted).toBe(true);
    expect(result.error).toMatchObject({ kind: "aborted", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("regressões de URL e descoberta local", () => {
  it("rejeita baseURL compat com query ou hash de forma clara", () => {
    expect(() => validateCompatBaseUrl("http://127.0.0.1:1234/v1?token=x")).toThrow(/query ou hash/);
    expect(() => validateCompatBaseUrl("http://127.0.0.1:1234/v1#fragmento")).toThrow(/query ou hash/);
  });

  it("testCompatConnection aceita apiKey opcional sem quebrar options existentes", async () => {
    const authorizations: Array<string | null> = [];
    const fetchImpl = vi.fn(async (_input: FetchInput, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ data: [{ id: "modelo" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const withKey = await testCompatConnection("http://127.0.0.1:1234/v1", { apiKey: "secret", fetchImpl });
    const withoutKey = await testCompatConnection("http://127.0.0.1:1234/v1", { fetchImpl });

    expect(withKey).toMatchObject({ ok: true, models: [{ id: "modelo", name: "modelo" }] });
    expect(withoutKey).toMatchObject({ ok: true, models: [{ id: "modelo", name: "modelo" }] });
    expect(authorizations).toEqual(["Bearer secret", null]);
  });
});
