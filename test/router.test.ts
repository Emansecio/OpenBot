/**
 * T5 — Unit tests do roteador unificado de inferência (src/providers/router.ts)
 * com adapter FAKE (test/mocks/fake-provider-adapter.ts).
 *
 * Cobertura (plano §3 T5 — Done):
 *   - deltas viram `message` COMPLETA na ordem (acumulador, spec §3.1/§3.2);
 *   - `done` e `error` são emitidos corretamente (terminais: exatamente 1);
 *   - abort (AbortSignal) encerra o stream (kind `aborted`, não retryable);
 *   - mapeamento transiente (429/5xx/rede) vs permanente (4xx auth/validação);
 *   - registro de adapters por nome (register/get — contrato de T6/T7/T8);
 *   - router nunca lança: erro sai como evento `error` + `result.error`.
 */

import { describe, expect, it } from "vitest";

import {
  classifyProviderError,
  createProviderRegistry,
  DeltaAccumulator,
  ProviderError,
  streamChat,
  type ProviderChatRequest,
  type ProviderStreamEvent,
  type ProviderTool,
} from "../src/providers/router.js";
import {
  createFakeAdapter,
  FakeProviderAdapter,
  type FakeStreamScript,
} from "./mocks/fake-provider-adapter.js";

const registry = createProviderRegistry();

function registerFake(fake: FakeProviderAdapter): void {
  registry.register(fake);
}

function baseRequest(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    model: "grok-4.6",
    messages: [{ role: "user", content: "olá" }],
    ...overrides,
  };
}

function collectEvents(fake: FakeProviderAdapter, req: ProviderChatRequest): {
  events: ProviderStreamEvent[];
  result: Promise<Awaited<ReturnType<typeof streamChat>>>;
} {
  registerFake(fake);
  const events: ProviderStreamEvent[] = [];
  const result = streamChat(fake.name, req, (e) => events.push(e), { registry });
  return { events, result };
}

describe("T5 router — acumulador de deltas → mensagem completa", () => {
  it("deltas em ordem viram uma mensagem COMPLETA (evento `message` final)", async () => {
    const fake = createFakeAdapter("fake", {
      deltas: ["Olá", ", ", "mundo", "!"],
    });
    const { events, result } = collectEvents(fake, baseRequest());

    const out = await result;
    expect(out.aborted).toBe(false);
    expect(out.error).toBeUndefined();
    expect(out.message).toEqual({
      role: "assistant",
      content: "Olá, mundo!",
    });

    const types = events.map((e) => e.type);
    // 4 deltas na ordem + 1 message + 1 done = 6 eventos; terminal único (message).
    expect(types).toEqual(["delta", "delta", "delta", "delta", "message", "done"]);

    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.map((e) => (e as { delta: string }).delta)).toEqual([
      "Olá",
      ", ",
      "mundo",
      "!",
    ]);
    expect((events[4] as { message: { content: string } }).message.content).toBe("Olá, mundo!");
  });

  it("acumulador respeita ordem intercalada com tool calls (texto + tools)", async () => {
    const fake = createFakeAdapter("fake", {
      deltas: ["Vou ", "verificar"],
      toolCalls: [{ id: "call_1", name: "shell", arguments: '{"cmd":"dir"}' }],
    });
    const { events, result } = collectEvents(fake, baseRequest());

    const out = await result;
    expect(out.message).toEqual({
      role: "assistant",
      content: "Vou verificar",
      toolCalls: [
        { id: "call_1", type: "function", function: { name: "shell", arguments: '{"cmd":"dir"}' } },
      ],
    });

    const types = events.map((e) => e.type);
    expect(types).toEqual(["delta", "delta", "tool-call", "message", "done"]);
    expect(events.filter((e) => e.type === "message")).toHaveLength(1);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("stream vazio (sem deltas e sem tools) → só `done`, sem `message`", async () => {
    const fake = createFakeAdapter("fake", { deltas: [] });
    const { events, result } = collectEvents(fake, baseRequest());

    const out = await result;
    expect(out.message).toBeUndefined();
    expect(out.aborted).toBe(false);
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });

  it("DeltaAccumulator (unidade): appendText/snapshot preserva ordem e conteúdo", () => {
    const acc = new DeltaAccumulator();
    acc.appendText("a");
    acc.appendText("b");
    acc.addToolCall({
      id: "c1",
      type: "function",
      function: { name: "sh", arguments: "{}" },
    });
    const snap = acc.snapshot();
    expect(snap).toEqual({
      role: "assistant",
      content: "ab",
      toolCalls: [{ id: "c1", type: "function", function: { name: "sh", arguments: "{}" } }],
    });
    expect(acc.text).toBe("ab");
    expect(acc.toolCallCount).toBe(1);
  });
});

describe("T5 router — done/error emitidos corretamente", () => {
  it("erro do adapter NÃO vaza: vira evento `error` + result.error (classificado)", async () => {
    const fake = createFakeAdapter("fake", {
      deltas: ["a"],
      error: Object.assign(new Error("rate limit"), { status: 429 }),
    });
    const { events, result } = collectEvents(fake, baseRequest());

    const out = await result; // nunca rejeita
    expect(out.error).toBeInstanceOf(ProviderError);
    expect(out.error?.kind).toBe("rate-limit");
    expect(out.error?.retryable).toBe(true);
    expect(out.error?.status).toBe(429);

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error.kind).toBe("rate-limit");
    // terminal único: um delta + um error (sem message/done após o erro).
    const terminals = events.filter((e) => e.type === "error" || e.type === "done" || e.type === "message");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe("error");
    expect(events.map((e) => e.type)).toEqual(["delta", "error"]);
  });

  it("adapter inexistente → error validation (permanente), sem lançar", async () => {
    const events: ProviderStreamEvent[] = [];
    const result = await streamChat("nao-registrado", baseRequest(), (e) => events.push(e), { registry });

    expect(result.error?.kind).toBe("validation");
    expect(result.error?.retryable).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
  });

  it("falha de onEvent vira result.error sem reinvocar o observador", async () => {
    const fake = createFakeAdapter("observer-failure", { deltas: ["x"] });
    registerFake(fake);
    let observerCalls = 0;

    const result = streamChat(fake.name, baseRequest(), () => {
      observerCalls += 1;
      throw new Error("observer failed");
    }, { registry });

    await expect(result).resolves.toMatchObject({
      aborted: false,
      error: { kind: "unknown", message: "observer failed" },
    });
    expect(observerCalls).toBe(1);
  });
});

describe("T5 router — mapeamento de erros transientes vs permanentes", () => {
  it("429 → rate-limit (retryable)", () => {
    const err = classifyProviderError(Object.assign(new Error("too many"), { status: 429 }));
    expect(err.kind).toBe("rate-limit");
    expect(err.retryable).toBe(true);
  });

  it("5xx → server (retryable)", () => {
    for (const status of [500, 502, 503, 504]) {
      const err = classifyProviderError(Object.assign(new Error("boom"), { status }));
      expect(err.kind).toBe("server");
      expect(err.retryable).toBe(true);
    }
  });

  it("falha de rede (código ECONNRESET) → network (retryable)", () => {
    const err = classifyProviderError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    expect(err.kind).toBe("network");
    expect(err.retryable).toBe(true);
  });

  it("401/403 → auth (permanente)", () => {
    const err = classifyProviderError(Object.assign(new Error("invalid key"), { status: 401 }));
    expect(err.kind).toBe("auth");
    expect(err.retryable).toBe(false);
  });

  it("400/404/422 → validation (permanente)", () => {
    for (const status of [400, 404, 422]) {
      const err = classifyProviderError(Object.assign(new Error("bad request"), { status }));
      expect(err.kind).toBe("validation");
      expect(err.retryable).toBe(false);
    }
  });

  it("sem status/código conhecido → unknown (permanente)", () => {
    const err = classifyProviderError(new Error("algo estranho"));
    expect(err.kind).toBe("unknown");
    expect(err.retryable).toBe(false);
  });

  it("ProviderError já classificado passa intacto", () => {
    const original = new ProviderError("429 de novo", { kind: "rate-limit", status: 429 });
    const err = classifyProviderError(original);
    expect(err).toBe(original);
    expect(err.kind).toBe("rate-limit");
  });

  it("repete erro transitório até duas vezes antes de qualquer saída observável", async () => {
    const localRegistry = createProviderRegistry();
    let attempts = 0;
    localRegistry.register({
      name: "retry-before-output",
      async streamChat() {
        attempts += 1;
        throw Object.assign(new Error("temporary"), { status: 503 });
      },
    });
    const delays: number[] = [];
    const events: ProviderStreamEvent[] = [];

    const result = await streamChat(
      "retry-before-output",
      baseRequest(),
      (event) => events.push(event),
      { registry: localRegistry, sleep: async (ms) => { delays.push(ms); } },
    );

    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 500]);
    expect(result.error).toMatchObject({ kind: "server", retryable: true });
    expect(events.map((event) => event.type)).toEqual(["error"]);
  });

  it("respeita Retry-After limitado ao repetir rate limit", async () => {
    const localRegistry = createProviderRegistry();
    localRegistry.register({
      name: "retry-after",
      async streamChat() {
        throw Object.assign(new Error("rate limit"), { status: 429, retryAfterMs: 90_000 });
      },
    });
    const delays: number[] = [];

    const result = await streamChat(
      "retry-after",
      baseRequest(),
      undefined,
      { registry: localRegistry, sleep: async (ms) => { delays.push(ms); } },
    );

    expect(delays).toEqual([60_000, 60_000]);
    expect(result.error).toMatchObject({ kind: "rate-limit", retryAfterMs: 60_000 });
  });

  it("não repete após delta observável e aborta durante o backoff", async () => {
    const localRegistry = createProviderRegistry();
    let attempts = 0;
    localRegistry.register({
      name: "retry-after-output",
      async streamChat(_request, emit) {
        attempts += 1;
        emit({ type: "delta", delta: "partial" });
        throw Object.assign(new Error("temporary"), { status: 503 });
      },
    });
    const noRetryDelays: number[] = [];
    const noRetryEvents: ProviderStreamEvent[] = [];
    const noRetry = await streamChat(
      "retry-after-output",
      baseRequest(),
      (event) => noRetryEvents.push(event),
      { registry: localRegistry, sleep: async (ms) => { noRetryDelays.push(ms); } },
    );
    expect(attempts).toBe(1);
    expect(noRetryDelays).toEqual([]);
    expect(noRetry.error?.kind).toBe("server");
    expect(noRetryEvents.map((event) => event.type)).toEqual(["delta", "error"]);

    const abortRegistry = createProviderRegistry();
    let abortAttempts = 0;
    abortRegistry.register({
      name: "retry-abort",
      async streamChat() {
        abortAttempts += 1;
        throw Object.assign(new Error("temporary"), { status: 503 });
      },
    });
    const controller = new AbortController();
    const abortResult = await streamChat(
      "retry-abort",
      baseRequest({ signal: controller.signal }),
      undefined,
      { registry: abortRegistry, sleep: async () => { controller.abort(); } },
    );
    expect(abortAttempts).toBe(1);
    expect(abortResult.aborted).toBe(true);
    expect(abortResult.error?.kind).toBe("aborted");
  });
});

describe("T5 router — abort (AbortSignal) encerra o stream", () => {
  it("abort antes do stream → error `aborted`, não retryable, sem lançar", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = createFakeAdapter("fake", { deltas: ["x"] });
    const { events, result } = collectEvents(fake, baseRequest({ signal: controller.signal }));

    const out = await result;
    expect(out.aborted).toBe(true);
    expect(out.error?.kind).toBe("aborted");
    expect(out.error?.retryable).toBe(false);
    expect(out.message).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
  });

  it("abort no meio do stream → error `aborted` (nenhuma message/done)", async () => {
    const controller = new AbortController();
    const fake = createFakeAdapter("fake", {
      deltas: ["início", "meio"],
      deltaDelayMs: 20,
    });
    const { events, result } = collectEvents(fake, baseRequest({ signal: controller.signal }));

    // Aborta depois do primeiro delta chegar.
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();

    const out = await result;
    expect(out.aborted).toBe(true);
    expect(out.error?.kind).toBe("aborted");
    const hasTerminal = events.some((e) => e.type === "message" || e.type === "done");
    expect(hasTerminal).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});

describe("T5 router — registro de adapters por nome (contrato T6/T7/T8)", () => {
  it("register/get por nome + has + names + clear", () => {
    const registry = createProviderRegistry();
    const openai = createFakeAdapter("openai");
    const xai = createFakeAdapter("xai");

    registry.register(openai);
    registry.register(xai);

    expect(registry.has("openai")).toBe(true);
    expect(registry.has("xai")).toBe(true);
    expect(registry.has("nao-existe")).toBe(false);
    expect(registry.get("openai")).toBe(openai);
    expect(registry.get("xai")).toBe(xai);
    expect(registry.get("nao-existe")).toBeUndefined();
    expect(registry.names().sort()).toEqual(["openai", "xai"]);

    registry.clear();
    expect(registry.names()).toHaveLength(0);
    expect(registry.get("openai")).toBeUndefined();
  });

  it("register com replace=false rejeita duplicata; replace=true (default) substitui", () => {
    const registry = createProviderRegistry();
    const first = createFakeAdapter("openai");
    const second = createFakeAdapter("openai");

    registry.register(first);
    expect(() => registry.register(second, { replace: false })).toThrow(/já registrado/);
    registry.register(second); // replace default true
    expect(registry.get("openai")).toBe(second);
  });

  it("router usa o registry passado (não o default global)", async () => {
    const localRegistry = createProviderRegistry();
    const fake = createFakeAdapter("custom", { deltas: ["ok"] });
    localRegistry.register(fake);

    const events: ProviderStreamEvent[] = [];
    const result = await streamChat("custom", baseRequest(), (e) => events.push(e), { registry: localRegistry });

    expect(result.message?.content).toBe("ok");
    expect(events.map((e) => e.type)).toEqual(["delta", "message", "done"]);
    // O default global não conhece o adapter local.
    const events2: ProviderStreamEvent[] = [];
    const result2 = await streamChat("custom", baseRequest(), (e) => events2.push(e));
    expect(result2.error?.kind).toBe("validation");
  });
});

describe("T5 router — contrato do pedido repassado ao adapter", () => {
  it("system/tools/temperature/maxTokens chegam íntegros ao adapter", async () => {
    const fake = createFakeAdapter("fake", { deltas: ["ok"] });
    registerFake(fake);
    const tool: ProviderTool = {
      type: "function",
      function: { name: "shell", description: "executa", parameters: { type: "object" } },
    };
    const req = baseRequest({
      system: "você é o OpenBot",
      tools: [tool],
      temperature: 0.3,
      maxTokens: 512,
    });
    const { result } = collectEvents(fake, req);
    await result;

    expect(fake.invocations).toHaveLength(1);
    const seen = fake.invocations[0]?.req;
    expect(seen?.model).toBe("grok-4.6");
    expect(seen?.system).toBe("você é o OpenBot");
    expect(seen?.tools).toEqual([tool]);
    expect(seen?.temperature).toBe(0.3);
    expect(seen?.maxTokens).toBe(512);
    expect(seen?.messages).toEqual([{ role: "user", content: "olá" }]);
  });

  it("signal é repassado ao adapter e aborta o fetch subjacente", async () => {
    const controller = new AbortController();
    const fake = createFakeAdapter("fake", { deltas: ["a"], deltaDelayMs: 10_000 });
    registerFake(fake);
    const { events, result } = collectEvents(fake, baseRequest({ signal: controller.signal }));
    controller.abort();
    const out = await result;
    expect(out.aborted).toBe(true);
    expect(out.error).toMatchObject({ kind: "aborted", retryable: false });
    expect(out.message).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(["delta", "error"]);
    expect(fake.invocations[0]?.aborted).toBe(true);
    expect(fake.invocations[0]?.req.signal?.aborted).toBe(true);
  });
});
