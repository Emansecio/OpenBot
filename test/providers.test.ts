/**
 * T6 — Testes do adapter OpenAI e dos helpers compartilhados
 * (src/providers/openai.ts + openai-helpers.ts), contra o mock de provider
 * (test/mocks/provider-server.ts) e fixtures de contrato.
 *
 * Cobertura (plano §3 T6 — Done):
 *   - paridade contra mock de provider: SSE de deltas vira `delta` na ordem e
 *     `message` COMPLETA via roteador (T5); SSE de `tool_calls` fragmentadas
 *     vira `tool-call` normalizada (id/name/arguments concatenados);
 *   - chave via keystore: reveal por namespace `scoped:v1:provider:openai:apiKey`
 *     (e por nome custom — base para xAI/OpenAI-compat);
 *   - helpers (reuso T7/T8): buildChatBody (stream:true + tools + system
 *     inline), OpenAiToolCallAccumulator, parseOpenAiSseChunk (fixtures),
 *     normalizeOpenAiError, extractOpenAiErrorMessage;
 *   - erros: 401 → auth, 429 → rate-limit, 500 → server, 400 → validation
 *     (transiente vs permanente, spec §3.1);
 *   - abort (AbortSignal) encerra o stream (kind `aborted`, não retryable);
 *   - registro como "openai" no registry do roteador;
 *   - fixtures de contrato: corpo do chat.completions e SSE de tool calls.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  OpenAiAdapter,
  OPENAI_API_BASE_URL,
  openAiApiKeyKey,
  registerOpenAiAdapter,
} from "../src/providers/openai.js";
import {
  ApiError,
  OpenAIError,
  OpenAiToolCallAccumulator,
  buildChatBody,
  extractOpenAiErrorMessage,
  normalizeOpenAiError,
  parseOpenAiSseChunk,
  splitSseLines,
} from "../src/providers/openai-helpers.js";
import { defaultRegistry, streamChat } from "../src/providers/router.js";
import type { ProviderChatRequest, ProviderStreamEvent } from "../src/providers/router.js";
import { createKeystore } from "../src/keystore/index.js";
import type { KeystoreOptions } from "../src/keystore/index.js";

import {
  startMockProviderServer,
  type MockProviderServer,
  type MockToolCallChunk,
} from "./mocks/provider-server.js";

import openAiChatRequestFixture from "./fixtures/openai-chat-request.json" with { type: "json" };
import openAiSseToolCallsFixture from "./fixtures/openai-sse-toolcalls.json" with { type: "json" };

let activeServers: MockProviderServer[] = [];
let activeKeystoreDirs: string[] = [];

afterEach(async () => {
  const servers = activeServers;
  activeServers = [];
  await Promise.all(servers.map((s) => s.close()));
  for (const dir of activeKeystoreDirs.splice(0)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  defaultRegistry.clear();
});

async function bootMock(opts: Parameters<typeof startMockProviderServer>[0] = {}): Promise<MockProviderServer> {
  const mock = await startMockProviderServer(opts);
  activeServers.push(mock);
  return mock;
}

function memoryKeystore(opts: Partial<KeystoreOptions> = {}): ReturnType<typeof createKeystore> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-providers-keystore-"));
  activeKeystoreDirs.push(dir);
  return createKeystore({ writeBackend: undefined, legacyReadBackend: undefined, ...opts, dir });
}

function baseRequest(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    model: "chat-completions-test",
    messages: [{ role: "user", content: "olá" }],
    ...overrides,
  };
}

function collectEvents(
  adapter: OpenAiAdapter,
  req: ProviderChatRequest,
): { events: ProviderStreamEvent[]; result: Promise<Awaited<ReturnType<typeof streamChat>>> } {
  // O roteador resolve o adapter por NOME no registry (contrato T5) — registra
  // antes de streamar (same pattern de test/router.test.ts com o registry local).
  defaultRegistry.register(adapter);
  const events: ProviderStreamEvent[] = [];
  const result = streamChat(adapter.name, req, (e) => events.push(e));
  return { events, result };
}

describe("T6 openai-helpers — buildChatBody (contrato chat.completions)", () => {
  it("system inline + tools + temperature + maxTokens → corpo com stream:true e max_tokens", () => {
    const body = buildChatBody({
      model: "chat-completions-test",
      system: "Você é o OpenBot.",
      messages: [{ role: "user", content: "Liste os arquivos." }],
      tools: [
        {
          type: "function",
          function: {
            name: "shell",
            description: "Executa um comando",
            parameters: { type: "object", properties: { cmd: { type: "string" } } },
          },
        },
      ],
      temperature: 0.2,
      maxTokens: 512,
    });
    expect(body.stream).toBe(true);
    expect(body.model).toBe("chat-completions-test");
    expect(body.messages).toEqual([
      { role: "system", content: "Você é o OpenBot." },
      { role: "user", content: "Liste os arquivos." },
    ]);
    expect(body.tools).toHaveLength(1);
    expect((body.tools?.[0] as { type: string }).type).toBe("function");
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(512);
  });

  it("sem system/sem tools → corpo mínimo (stream:true, sem campos opcionais)", () => {
    const body = buildChatBody({ model: "chat-completions-mini-test", messages: [{ role: "user", content: "oi" }] });
    expect(body.stream).toBe(true);
    expect(body.tools).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.messages).toEqual([{ role: "user", content: "oi" }]);
  });

  it("mensagem role tool vira tool_call_id no corpo (round-trip T9)", () => {
    const body = buildChatBody({
      model: "chat-completions-test",
      messages: [{ role: "tool", content: "ok", toolCallId: "call_1" }],
    });
    expect(body.messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ]);
  });
});

describe("T6 openai-helpers — OpenAiToolCallAccumulator (normalização de tool calls)", () => {
  it("fragmentos por índice viram tool call completa (id+name+arguments concatenados)", () => {
    const acc = new OpenAiToolCallAccumulator();
    acc.add({ index: 0, id: "call_9Y5h", type: "function", function: { name: "shell", arguments: "" } });
    acc.add({ index: 0, function: { arguments: '{"cmd":"dir"}' } });
    acc.add({ index: 1, id: "call_abc", type: "function", function: { name: "file", arguments: '{"path":"' } });
    acc.add({ index: 1, function: { arguments: 'C:\\"}' } });

    const calls = acc.calls();
    expect(calls).toEqual([
      { id: "call_9Y5h", type: "function", function: { name: "shell", arguments: '{"cmd":"dir"}' } },
      { id: "call_abc", type: "function", function: { name: "file", arguments: '{"path":"C:\\"}' } },
    ]);
    expect(acc.hasAny).toBe(true);
    expect(acc.complete).toBe(true);
  });

  it("sem id/name (parcial) → complete=false, mas hasAny=true (ordem preservada)", () => {
    const acc = new OpenAiToolCallAccumulator();
    acc.add({ index: 0, function: { arguments: "{}" } });
    expect(acc.hasAny).toBe(true);
    expect(acc.complete).toBe(false);
    expect(acc.calls()[0]?.id).toBe("");
    expect(acc.calls()[0]?.function.name).toBe("");
  });

  it("reset limpa o estado (novo turno)", () => {
    const acc = new OpenAiToolCallAccumulator();
    acc.add({ index: 0, id: "c", function: { name: "sh", arguments: "{}" } });
    acc.reset();
    expect(acc.hasAny).toBe(false);
    expect(acc.calls()).toEqual([]);
  });
});

describe("T6 openai-helpers — parseOpenAiSseChunk (parser de SSE da OpenAI)", () => {
  it("parseia frames data: com [DONE] como fim e ignora heartbeat/comentários", () => {
    const sse = [
      ": ping",
      "event: message",
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"oi"},"finish_reason":null}]}',
      "",
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const frames = parseOpenAiSseChunk(sse);
    expect(frames).toHaveLength(3);
    const content = (frames[0]?.data as { choices: { delta: { content: string } }[] }).choices[0]?.delta.content;
    expect(content).toBe("oi");
    expect(frames[2]).toEqual({ data: null });
  });

  it("splitSseLines normaliza \\r\\n e linhas vazias", () => {
    expect(splitSseLines("data: a\r\ndata: b\r\n")).toEqual(["data: a", "data: b"]);
  });

  it("JSON inválido em data: é descartado (stream continua)", () => {
    const frames = parseOpenAiSseChunk("data: {json incompleto}\n\ndata: [DONE]\n\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ data: null });
  });

  it("fixture de contrato: SSE de tool_calls → texto acumulado + tool call normalizada", () => {
    const fixture = openAiSseToolCallsFixture;
    const frames = parseOpenAiSseChunk(fixture.sse);

    // Delimitador de frame é a linha vazia — o parser trata cada data: como frame.
    const contentFrames = frames
      .map((f) => (f?.data as { choices: { delta: { content?: string } }[] } | null)?.choices[0]?.delta.content)
      .filter((c): c is string => typeof c === "string");
    expect(contentFrames.join("")).toBe(fixture.expectedText);

    const acc = new OpenAiToolCallAccumulator();
    for (const frame of frames) {
      if (frame === null || frame.data === null) continue;
      const choices = (frame.data as { choices: { delta: { tool_calls?: MockToolCallChunk[] } }[] }).choices;
      const toolCalls = choices[0]?.delta.tool_calls;
      if (toolCalls) for (const chunk of toolCalls) acc.add(chunk);
    }
    expect(acc.calls()[0]).toEqual(fixture.expectedToolCall);
  });
});

describe("T6 openai-helpers — normalização de erros", () => {
  it("extractOpenAiErrorMessage extrai error.message (formato OpenAI)", () => {
    expect(extractOpenAiErrorMessage({ error: { message: "invalid api key" } })).toBe("invalid api key");
    expect(extractOpenAiErrorMessage({ message: "plain" })).toBe("plain");
    expect(extractOpenAiErrorMessage({ error: "string error" })).toBe("string error");
    expect(extractOpenAiErrorMessage(null)).toBeUndefined();
    expect(extractOpenAiErrorMessage({})).toBeUndefined();
  });

  it("normalizeOpenAiError: ApiError/OpenAIError passam intactos", () => {
    const api = new ApiError("429", 429);
    expect(normalizeOpenAiError(api)).toBe(api);
    const transport = new OpenAIError("network", { code: "ECONNRESET" });
    expect(normalizeOpenAiError(transport)).toBe(transport);
  });

  it("normalizeOpenAiError: erro do fetch (fetch failed + causa com código de rede) carrega o code", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    const normalized = normalizeOpenAiError(new TypeError("fetch failed", { cause }));
    expect(normalized).toBeInstanceOf(OpenAIError);
    if (!(normalized instanceof OpenAIError)) throw new Error("expected OpenAIError");
    expect(normalized.code).toBe("ECONNREFUSED");
  });

  it("normalizeOpenAiError: erro genérico vira OpenAIError sem status (classificação pelo roteador)", () => {
    const normalized = normalizeOpenAiError(new Error("algo quebrou"));
    expect(normalized).toBeInstanceOf(OpenAIError);
    expect((normalized as Error & { status?: number }).status).toBeUndefined();
  });
});

describe("T6 adapter OpenAI — paridade contra mock de provider (SSE de deltas)", () => {
  it("deltas do mock viram delta na ordem + message COMPLETA via roteador (sem rede real)", async () => {
    const mock = await bootMock({ script: { deltas: ["Olá", ", ", "mundo", "!"] } });
    const adapter = new OpenAiAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });
    const { events, result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error).toBeUndefined();
    expect(out.aborted).toBe(false);
    expect(out.message).toEqual({ role: "assistant", content: "Olá, mundo!" });

    const types = events.map((e) => e.type);
    expect(types).toEqual(["delta", "delta", "delta", "delta", "message", "done"]);
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { delta: string }).delta)).toEqual([
      "Olá",
      ", ",
      "mundo",
      "!",
    ]);
  });

  it("corpo do request chega ao mock no formato chat.completions (Authorization Bearer + stream:true)", async () => {
    const mock = await bootMock({ expectedApiKey: "sk-paridade", script: { deltas: ["ok"] } });
    const adapter = new OpenAiAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-paridade" });
    const { result } = collectEvents(
      adapter,
      baseRequest({ system: "sys", temperature: 0.5, maxTokens: 128 }),
    );
    await result;

    expect(mock.requests).toHaveLength(1);
    const req = mock.requests[0];
    if (req === undefined) throw new Error("mock provider received no request");
    expect(req.url).toBe("/v1/chat/completions");
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe("Bearer sk-paridade");
    const body = req.body as { stream: boolean; model: string; messages: unknown[]; max_tokens: number; temperature: number };
    expect(body.stream).toBe(true);
    expect(body.model).toBe("chat-completions-test");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "olá" },
    ]);
    expect(body.max_tokens).toBe(128);
    expect(body.temperature).toBe(0.5);
  });

  it("tools param chega ao mock no corpo (contrato T6 — tools → tool_calls)", async () => {
    const mock = await bootMock({ script: { deltas: ["ok"] } });
    const adapter = new OpenAiAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });
    const { result } = collectEvents(
      adapter,
      baseRequest({
        tools: [
          { type: "function", function: { name: "shell", description: "executa", parameters: { type: "object" } } },
        ],
      }),
    );
    await result;

    const body = mock.requests[0]?.body as { tools?: unknown[] };
    expect(body.tools).toHaveLength(1);
    expect((body.tools?.[0] as { function: { name: string } }).function.name).toBe("shell");
  });
});

describe("T6 adapter OpenAI — paridade contra mock (SSE de tool_calls)", () => {
  it("tool_calls fragmentadas por índice viram um único evento tool-call completo", async () => {
    const toolCallChunks: MockToolCallChunk[] = [
      { index: 0, id: "call_9Y5h", type: "function", function: { name: "shell", arguments: "" } },
      { index: 0, function: { arguments: '{"cmd":"dir"}' } },
    ];
    const mock = await bootMock({
      script: { deltas: ["Vou ", "listar"], toolCalls: toolCallChunks },
    });
    const adapter = new OpenAiAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });
    const { events, result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error).toBeUndefined();
    expect(out.message).toEqual({
      role: "assistant",
      content: "Vou listar",
      toolCalls: [
        { id: "call_9Y5h", type: "function", function: { name: "shell", arguments: '{"cmd":"dir"}' } },
      ],
    });

    const toolCallEvents = events.filter((e) => e.type === "tool-call");
    expect(toolCallEvents).toHaveLength(1);
    const call = (toolCallEvents[0] as { call: { id: string; function: { name: string; arguments: string } } }).call;
    expect(call.id).toBe("call_9Y5h");
    expect(call.function.name).toBe("shell");
    expect(call.function.arguments).toBe('{"cmd":"dir"}');

    const types = events.map((e) => e.type);
    expect(types).toEqual(["delta", "delta", "tool-call", "message", "done"]);
  });

  it("duas tool calls (índices distintos) preservam ordem e acumulação independente", async () => {
    const mock = await bootMock({
      script: {
        deltas: [],
        toolCalls: [
          { index: 0, id: "call_a", type: "function", function: { name: "file", arguments: '{"a":' } },
          { index: 1, id: "call_b", type: "function", function: { name: "shell", arguments: "{}" } },
          { index: 0, function: { arguments: "1}" } },
        ],
      },
    });
    const adapter = new OpenAiAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });
    const { events, result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.message?.toolCalls).toEqual([
      { id: "call_a", type: "function", function: { name: "file", arguments: '{"a":1}' } },
      { id: "call_b", type: "function", function: { name: "shell", arguments: "{}" } },
    ]);
    const calls = events.filter((e) => e.type === "tool-call");
    expect(calls).toHaveLength(2);
  });

  it("SSE bruto de fixture (data: com tool_calls) falado pelo mock → paridade completa", async () => {
    const mock = await bootMock({ rawSse: openAiSseToolCallsFixture.sse });
    const adapter = new OpenAiAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });
    const { events, result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.message?.content).toBe(openAiSseToolCallsFixture.expectedText);
    expect(out.message?.toolCalls).toEqual([openAiSseToolCallsFixture.expectedToolCall]);
    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("T6 adapter OpenAI — chave via keystore (namespace scoped:v1:provider:openai:apiKey)", () => {
  it("reveal pelo namespace openai:apiKey → request autenticado com a chave revelada", async () => {
    const mock = await bootMock({ expectedApiKey: "sk-keystore-secreta", script: { deltas: ["ok"] } });
    const keystore = memoryKeystore();
    await keystore.upsert("openai", "sk-keystore-secreta");

    const adapter = new OpenAiAdapter({ baseUrl: mock.baseUrl, keystore });
    const { result } = collectEvents(adapter, baseRequest());
    const out = await result;

    expect(out.error).toBeUndefined();
    expect(out.message?.content).toBe("ok");
    // Namespace do contrato T4.
    expect(openAiApiKeyKey()).toBe("scoped:v1:provider:openai:apiKey");
  });

  it("chave ausente na keystore → error auth (permanente, não retryable)", async () => {
    const mock = await bootMock({ script: { deltas: ["x"] } });
    const keystore = memoryKeystore();
    const adapter = new OpenAiAdapter({ baseUrl: mock.baseUrl, keystore });
    const { events, result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error?.kind).toBe("auth");
    expect(out.error?.retryable).toBe(false);
    expect(out.error?.status).toBe(401);
    expect(mock.requestCount()).toBe(0); // nunca chegou ao provider
    expect(events.map((e) => e.type)).toEqual(["error"]);
  });

  it("chave com nome custom (base p/ xAI) revela pelo namespace do nome", async () => {
    const mock = await bootMock({ expectedApiKey: "xai-custom", script: { deltas: ["ok"] } });
    const keystore = memoryKeystore();
    await keystore.upsert("xai", "xai-custom");

    const adapter = new OpenAiAdapter({ baseUrl: mock.baseUrl, name: "xai", keystore });
    const { result } = collectEvents(adapter, baseRequest());
    const out = await result;

    expect(out.error).toBeUndefined();
    expect(mock.requests[0]?.headers.authorization).toBe("Bearer xai-custom");
  });
});

describe("T6 adapter OpenAI — erros HTTP classificados (transiente vs permanente)", () => {
  it("401 → auth (permanente), nunca retryable", async () => {
    const mock = await bootMock({ error: { status: 401, message: "invalid api key" } });
    const adapter = new OpenAiAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-ruim" });
    const { events, result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error?.kind).toBe("auth");
    expect(out.error?.retryable).toBe(false);
    expect(out.error?.status).toBe(401);
    expect(out.error?.message).toContain("invalid api key");
    expect(events.map((e) => e.type)).toEqual(["error"]);
  });

  it("429 → rate-limit (retryable)", async () => {
    const mock = await bootMock({ error: { status: 429, message: "rate limit exceeded" } });
    const adapter = new OpenAiAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });
    const { result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error?.kind).toBe("rate-limit");
    expect(out.error?.retryable).toBe(true);
    expect(out.error?.status).toBe(429);
  });

  it.each([
    { status: 500, message: "internal error" },
    { status: 503, message: "upstream down" },
  ])("$status → server (retryable)", async ({ status, message }) => {
    const mock = await bootMock({ error: { status, message } });
    const adapter = new OpenAiAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });
    const { result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error?.kind).toBe("server");
    expect(out.error?.retryable).toBe(true);
    expect(out.error?.status).toBe(status);
    expect(out.error?.message).toContain(message);
  });

  it("400 → validation (permanente)", async () => {
    const mock = await bootMock({ error: { status: 400, message: "bad request" } });
    const adapter = new OpenAiAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });
    const { result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error?.kind).toBe("validation");
    expect(out.error?.retryable).toBe(false);
  });

  it("corpo de erro sem JSON parseável ainda classifica pelo status HTTP", async () => {
    const adapter = new OpenAiAdapter({
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "sk-test",
      fetchImpl: async () => new Response("plain-text unauthorized", {
        status: 401,
        headers: { "content-type": "text/plain" },
      }),
    });
    const { result } = collectEvents(adapter, baseRequest());
    const out = await result;
    expect(out.error?.kind).toBe("auth");
    expect(out.error?.retryable).toBe(false);
    expect(out.error?.status).toBe(401);
    expect(out.error?.message).toBe("openai: HTTP 401");
  });
});

describe("T6 adapter OpenAI — abort encerra o stream", () => {
  it("abort no meio do SSE → error aborted (não retryable), nenhuma message/done", async () => {
    const controller = new AbortController();
    const mock = await bootMock({
      script: { deltas: ["início", "meio"], chunkDelayMs: 40 },
    });
    const adapter = new OpenAiAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });
    const { events, result } = collectEvents(adapter, baseRequest({ signal: controller.signal }));

    // Aborta depois do primeiro delta chegar (40ms por frame).
    await new Promise((r) => setTimeout(r, 60));
    controller.abort();

    const out = await result;
    expect(out.aborted).toBe(true);
    expect(out.error?.kind).toBe("aborted");
    expect(out.error?.retryable).toBe(false);
    const hasTerminal = events.some((e) => e.type === "message" || e.type === "done");
    expect(hasTerminal).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("abort antes do stream começar → error aborted (rota do roteador)", async () => {
    const controller = new AbortController();
    controller.abort();
    const mock = await bootMock({ script: { deltas: ["x"] } });
    const adapter = new OpenAiAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });
    const { events, result } = collectEvents(adapter, baseRequest({ signal: controller.signal }));

    const out = await result;
    expect(out.aborted).toBe(true);
    expect(out.error?.kind).toBe("aborted");
    expect(events.map((e) => e.type)).toEqual(["error"]);
  });
});

describe("T6 registro — adapter OpenAI como 'openai' no registry do roteador", () => {
  it("registerOpenAiAdapter registra com nome 'openai' e streamChat resolve", async () => {
    const mock = await bootMock({ script: { deltas: ["registrado"] } });
    const adapter = registerOpenAiAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });

    expect(adapter.name).toBe("openai");
    expect(defaultRegistry.has("openai")).toBe(true);
    expect(defaultRegistry.get("openai")).toBe(adapter);

    const events: ProviderStreamEvent[] = [];
    const result = await streamChat("openai", baseRequest(), (e) => events.push(e));
    expect(result.message?.content).toBe("registrado");
    expect(events.at(-1)?.type).toBe("done");
  });

  it("endpoint default é api.openai.com/v1 (sem fetch — só configuração)", () => {
    const adapter = new OpenAiAdapter({ apiKey: "sk-test" });
    expect(adapter.baseUrl).toBe(OPENAI_API_BASE_URL);
    expect(adapter.baseUrl.endsWith("/v1")).toBe(true);
  });
});

describe("T6 fixtures de contrato — chat-request", () => {
  it("buildChatBody produz exatamente o corpo esperado da fixture", () => {
    const fixture = openAiChatRequestFixture;
    const body = buildChatBody({
      model: fixture.request.model,
      system: fixture.request.system,
      messages: fixture.request.messages as ProviderChatRequest["messages"],
      tools: fixture.request.tools as ProviderChatRequest["tools"],
      temperature: fixture.request.temperature,
      maxTokens: fixture.request.maxTokens,
    });
    expect(body).toEqual(fixture.expectedBody);
  });
});

describe("OpenAI error body bounds", () => {
  it("limita e sinaliza corpo de erro grande, cancelando o restante", async () => {
    const limit = 64 * 1024;
    let cancelled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(limit + 1024)));
        closeTimer = setTimeout(() => controller.close(), 50);
      },
      cancel() {
        cancelled = true;
        if (closeTimer !== undefined) clearTimeout(closeTimer);
      },
    });
    const adapter = new OpenAiAdapter({
      apiKey: "sk-test",
      fetchImpl: async () => new Response(body, { status: 500 }),
    });

    let caught: unknown;
    try {
      await adapter.streamChat(baseRequest(), () => undefined);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const error = caught as ApiError;
    expect(error.message).toContain("corpo de erro truncado");
    expect(error.body).toEqual(expect.any(String));
    expect(Buffer.byteLength(error.body as string, "utf8")).toBeLessThanOrEqual(limit + 128);
    expect(error.body as string).toContain("corpo de erro truncado");
    expect(cancelled).toBe(true);
  });
});
