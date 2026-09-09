/**
 * T7 — Testes do adapter xAI/Grok (src/providers/xai.ts), contra o mock de
 * provider (test/mocks/provider-server.ts) e fixtures de contrato.
 *
 * Cobertura (plano §3 T7 — Done):
 *   - conversa mock COMPLETA (stream + tools) contra o servidor fake: SSE de
 *     deltas vira `delta` na ordem e `message` COMPLETA via roteador (T5);
 *     SSE de `tool_calls` fragmentadas vira `tool-call` normalizada
 *     (id/name/arguments concatenados — mesmo acumulador reusado do T6);
 *   - API OpenAI-compatible: endpoint default `https://api.x.ai/v1` e corpo
 *     chat.completions idêntico ao do T6 (buildChatBody reusado — fixture);
 *   - modelo default do produto `grok-*` como default do catálogo estático;
 *   - chave via keystore: reveal por namespace
 *     `scoped:v1:provider:xai:apiKey` (T4);
 *   - reuso dos helpers compartilhados do T6 (normalizeOpenAiError,
 *     extractOpenAiErrorMessage, buildChatBody, OpenAiToolCallAccumulator);
 *   - erros: 401 → auth, 429 → rate-limit, 500 → server (transiente vs
 *     permanente, spec §3.1);
 *   - abort (AbortSignal) encerra o stream (kind `aborted`, não retryable);
 *   - registro como "xai" no registry do roteador (boot, main.ts).
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  XAI_API_BASE_URL,
  XAI_PROVIDER_NAME,
  XaiAdapter,
  registerXaiAdapter,
  xaiApiKeyKey,
} from "../src/providers/xai.js";
import {
  OpenAiToolCallAccumulator,
  buildChatBody,
  extractOpenAiErrorMessage,
  normalizeOpenAiError,
} from "../src/providers/openai-helpers.js";
import { classifyProviderError, defaultRegistry, streamChat } from "../src/providers/router.js";
import type { ProviderChatRequest, ProviderStreamEvent } from "../src/providers/router.js";
import { MODEL_CATALOG } from "../src/config/models.js";
import { createKeystore } from "../src/keystore/index.js";
import type { KeystoreOptions } from "../src/keystore/index.js";

import {
  startMockProviderServer,
  type MockProviderServer,
  type MockToolCallChunk,
} from "./mocks/provider-server.js";

import xaiChatRequestFixture from "./fixtures/xai-chat-request.json" with { type: "json" };
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-xai-keystore-"));
  activeKeystoreDirs.push(dir);
  return createKeystore({ writeBackend: undefined, legacyReadBackend: undefined, ...opts, dir });
}

function baseRequest(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    model: "grok-4.6",
    messages: [{ role: "user", content: "olá" }],
    ...overrides,
  };
}

function collectEvents(
  adapter: XaiAdapter,
  req: ProviderChatRequest,
  onEvent?: (event: ProviderStreamEvent) => void,
): { events: ProviderStreamEvent[]; result: Promise<Awaited<ReturnType<typeof streamChat>>> } {
  defaultRegistry.register(adapter);
  const events: ProviderStreamEvent[] = [];
  const result = streamChat(adapter.name, req, (event) => {
    events.push(event);
    onEvent?.(event);
  });
  return { events, result };
}

describe("T7 xAI — identidade do provider e endpoint OpenAI-compatible", () => {
  it("nome canônico 'xai' + namespace keystore scoped:v1:provider:xai:apiKey", () => {
    expect(XAI_PROVIDER_NAME).toBe("xai");
    expect(xaiApiKeyKey()).toBe("scoped:v1:provider:xai:apiKey");
  });

  it("endpoint default é api.x.ai/v1 (API OpenAI-compatible), sem fetch — só configuração", () => {
    const adapter = new XaiAdapter({ apiKey: "xai-test" });
    expect(adapter.name).toBe("xai");
    expect(adapter.baseUrl).toBe(XAI_API_BASE_URL);
    expect(adapter.baseUrl.endsWith("/v1")).toBe(true);
  });
});

describe("T7 xAI — catálogo estático: modelo default do produto grok-*", () => {
  it("default do catálogo é Grok 4.6 com provider xai", () => {
    const grok = MODEL_CATALOG.find((m) => m.default);
    expect(grok).toMatchObject({ id: "grok-4.6", provider: "xai", displayName: "Grok 4.6" });
  });
});

describe("T7 xAI — paridade contra mock de provider (conversa mock: stream + tools)", () => {
  it("deltas do mock viram delta na ordem + message COMPLETA via roteador (sem rede real)", async () => {
    const mock = await bootMock({ script: { deltas: ["Olá", ", ", "Grok", "!"] } });
    const adapter = new XaiAdapter({ baseUrl: mock.baseUrl, apiKey: "xai-test" });
    const { events, result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error).toBeUndefined();
    expect(out.aborted).toBe(false);
    expect(out.message).toEqual({ role: "assistant", content: "Olá, Grok!" });

    const types = events.map((e) => e.type);
    expect(types).toEqual(["delta", "delta", "delta", "delta", "message", "done"]);
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { delta: string }).delta)).toEqual([
      "Olá",
      ", ",
      "Grok",
      "!",
    ]);
  });

  it("corpo do request chega ao mock no formato chat.completions (Authorization Bearer + stream:true + model grok-*)", async () => {
    const mock = await bootMock({ expectedApiKey: "xai-paridade", script: { deltas: ["ok"] } });
    const adapter = new XaiAdapter({ baseUrl: mock.baseUrl, apiKey: "xai-paridade" });
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
    expect(req.headers.authorization).toBe("Bearer xai-paridade");
    const body = req.body as { stream: boolean; model: string; messages: unknown[]; max_tokens: number; temperature: number };
    expect(body.stream).toBe(true);
    expect(body.model).toBe("grok-4.6");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "olá" },
    ]);
    expect(body.max_tokens).toBe(128);
    expect(body.temperature).toBe(0.5);
  });

  it("tools param chega ao mock no corpo (contrato T7 — tools → tool_calls)", async () => {
    const mock = await bootMock({ script: { deltas: ["ok"] } });
    const adapter = new XaiAdapter({ baseUrl: mock.baseUrl, apiKey: "xai-test" });
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

describe("T7 xAI — paridade contra mock (SSE de tool_calls — conversa mock completa)", () => {
  it("tool_calls fragmentadas por índice viram um único evento tool-call completo", async () => {
    const toolCallChunks: MockToolCallChunk[] = [
      { index: 0, id: "call_grok1", type: "function", function: { name: "shell", arguments: "" } },
      { index: 0, function: { arguments: '{"cmd":"dir"}' } },
    ];
    const mock = await bootMock({
      script: { deltas: ["Vou ", "listar"], toolCalls: toolCallChunks },
    });
    const adapter = new XaiAdapter({ baseUrl: mock.baseUrl, apiKey: "xai-test" });
    const { events, result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error).toBeUndefined();
    expect(out.message).toEqual({
      role: "assistant",
      content: "Vou listar",
      toolCalls: [
        { id: "call_grok1", type: "function", function: { name: "shell", arguments: '{"cmd":"dir"}' } },
      ],
    });

    const toolCallEvents = events.filter((e) => e.type === "tool-call");
    expect(toolCallEvents).toHaveLength(1);
    const call = (toolCallEvents[0] as { call: { id: string; function: { name: string; arguments: string } } }).call;
    expect(call.id).toBe("call_grok1");
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
    const adapter = new XaiAdapter({ baseUrl: mock.baseUrl, apiKey: "xai-test" });
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
    const adapter = new XaiAdapter({ baseUrl: mock.baseUrl, apiKey: "xai-test" });
    const { events, result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.message?.content).toBe(openAiSseToolCallsFixture.expectedText);
    expect(out.message?.toolCalls).toEqual([openAiSseToolCallsFixture.expectedToolCall]);
    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("T7 xAI — chave via keystore (namespace scoped:v1:provider:xai:apiKey)", () => {
  it("reveal pelo namespace xai:apiKey → request autenticado com a chave revelada", async () => {
    const mock = await bootMock({ expectedApiKey: "xai-keystore-secreta", script: { deltas: ["ok"] } });
    const keystore = memoryKeystore();
    await keystore.upsert("xai", "xai-keystore-secreta");

    const adapter = new XaiAdapter({ baseUrl: mock.baseUrl, keystore });
    const { result } = collectEvents(adapter, baseRequest());
    const out = await result;

    expect(out.error).toBeUndefined();
    expect(out.message?.content).toBe("ok");
    // Namespace do contrato T4.
    expect(xaiApiKeyKey()).toBe("scoped:v1:provider:xai:apiKey");
  });

  it("chave ausente na keystore → error auth (permanente, não retryable)", async () => {
    const mock = await bootMock({ script: { deltas: ["x"] } });
    const keystore = memoryKeystore();
    const adapter = new XaiAdapter({ baseUrl: mock.baseUrl, keystore });
    const { events, result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error?.kind).toBe("auth");
    expect(out.error?.retryable).toBe(false);
    expect(out.error?.status).toBe(401);
    expect(mock.requestCount()).toBe(0); // nunca chegou ao provider
    expect(events.map((e) => e.type)).toEqual(["error"]);
  });
});

describe("T7 xAI — erros HTTP classificados (transiente vs permanente)", () => {
  it("401 → auth (permanente), nunca retryable", async () => {
    const mock = await bootMock({ error: { status: 401, message: "invalid api key" } });
    const adapter = new XaiAdapter({ baseUrl: mock.baseUrl, apiKey: "xai-ruim" });
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
    const adapter = new XaiAdapter({ baseUrl: mock.baseUrl, apiKey: "xai-test" });
    const { result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error?.kind).toBe("rate-limit");
    expect(out.error?.retryable).toBe(true);
    expect(out.error?.status).toBe(429);
  });

  it("500 → server (retryable)", async () => {
    const mock = await bootMock({ error: { status: 500, message: "internal error" } });
    const adapter = new XaiAdapter({ baseUrl: mock.baseUrl, apiKey: "xai-test" });
    const { result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error?.kind).toBe("server");
    expect(out.error?.retryable).toBe(true);
  });
});

describe("T7 xAI — abort encerra o stream", () => {
  it("abort no meio do SSE → error aborted (não retryable), nenhuma message/done", async () => {
    const controller = new AbortController();
    const mock = await bootMock({
      script: { deltas: ["início", "meio"], chunkDelayMs: 40 },
    });
    const adapter = new XaiAdapter({ baseUrl: mock.baseUrl, apiKey: "xai-test" });
    let resolveFirstDelta!: () => void;
    const firstDelta = new Promise<void>((resolve) => {
      resolveFirstDelta = resolve;
    });
    const { events, result } = collectEvents(adapter, baseRequest({ signal: controller.signal }), (event) => {
      if (event.type === "delta") resolveFirstDelta();
    });

    await firstDelta;
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
    const adapter = new XaiAdapter({ baseUrl: mock.baseUrl, apiKey: "xai-test" });
    const { events, result } = collectEvents(adapter, baseRequest({ signal: controller.signal }));

    const out = await result;
    expect(out.aborted).toBe(true);
    expect(out.error?.kind).toBe("aborted");
    expect(events.map((e) => e.type)).toEqual(["error"]);
  });
});

describe("T7 xAI — reuso dos helpers compartilhados de T6 (openai-helpers)", () => {
  it("OpenAiToolCallAccumulator (reuso T6) normaliza tool calls fragmentadas da xAI", () => {
    const acc = new OpenAiToolCallAccumulator();
    acc.add({ index: 0, id: "call_grok", type: "function", function: { name: "file", arguments: '{"p":"' } });
    acc.add({ index: 0, function: { arguments: "C:\\" } });
    expect(acc.calls()).toEqual([
      { id: "call_grok", type: "function", function: { name: "file", arguments: '{"p":"C:\\' } },
    ]);
    expect(acc.complete).toBe(true);
  });

  it("normalizeOpenAiError + extractOpenAiErrorMessage (reuso T6) alimentam o classificador do roteador", () => {
    const normalized = normalizeOpenAiError(
      Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }),
    );
    const classified = classifyProviderError(normalized);
    expect(normalized.name).toBe("OpenAIError");
    expect((normalized as Error & { code?: string }).code).toBe("ECONNREFUSED");
    expect(classified).toMatchObject({ kind: "network", retryable: true, code: "ECONNREFUSED" });
    expect(extractOpenAiErrorMessage({ error: { message: "invalid api key" } })).toBe("invalid api key");
    expect(extractOpenAiErrorMessage({ message: "plain" })).toBe("plain");
    expect(extractOpenAiErrorMessage(null)).toBeUndefined();
  });
});

describe("T7 registro — adapter xAI como 'xai' no registry do roteador", () => {
  it("registerXaiAdapter registra com nome 'xai' e streamChat resolve", async () => {
    const mock = await bootMock({ script: { deltas: ["registrado"] } });
    const adapter = registerXaiAdapter({ baseUrl: mock.baseUrl, apiKey: "xai-test" });

    expect(adapter.name).toBe("xai");
    expect(defaultRegistry.has("xai")).toBe(true);
    expect(defaultRegistry.get("xai")).toBe(adapter);

    const events: ProviderStreamEvent[] = [];
    const result = await streamChat("xai", baseRequest(), (e) => events.push(e));
    expect(result.message?.content).toBe("registrado");
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("T7 fixtures de contrato — xai-chat-request", () => {
  it("buildChatBody produz exatamente o corpo esperado da fixture (wire format igual ao T6)", () => {
    const fixture = xaiChatRequestFixture;
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
