
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createProviderRegistry, type ProviderChatRequest } from "../src/providers/router.js";
import type { ConfigStore } from "../src/config/store.js";
import { createFakeAdapter } from "./mocks/fake-provider-adapter.js";
import { MAX_SEND_QUEUE_PER_AGENT, createMemoryTranscriptStore, createTurnRunner, type TurnRunnerOptions, type TranscriptStore } from "../src/rpc/send.js";
import type { TranscriptEntry } from "../src/shared/contracts.js";

/** Coleta os eventos publicados pelo runner (pub fake — sem HTTP). */
function collectPublish() {
  const events: { channel: string; payload: unknown }[] = [];
  return {
    events,
    publish: (channel: string, payload: unknown) => {
      events.push({ channel, payload });
    },
  };
}

/** Relógio determinístico (entries com timestampMs estável e crescente). */
function fixedClock() {
  let t = 1_000;
  return {
    now: () => (t += 1),
  };
}

function ids() {
  let n = 0;
  return { newId: () => `id:${++n}` };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type RunnerOpts = Omit<TurnRunnerOptions, "now" | "newId"> & {
  now?: () => number;
  newId?: (role: "user" | "assistant") => string;
};

function makeRunner(opts: RunnerOpts = {}): {
  runner: ReturnType<typeof createTurnRunner>;
  events: ReturnType<typeof collectPublish>["events"];
} {
  const now = opts.now ?? fixedClock().now;
  const newId = opts.newId ?? ids().newId;
  const pub = collectPublish();
  const runner = createTurnRunner({
    registry: opts.registry,
    store: opts.store,
    config: opts.config,
    systemPrompt: opts.systemPrompt,
    resolveProvider: opts.resolveProvider,
    publish: pub.publish,
    now,
    newId,
    ledgerCap: opts.ledgerCap,
  });
  return { runner, events: pub.events };
}

/** Todas as entries dos eventos appended do canal transcript. */
function allAppended(events: ReturnType<typeof collectPublish>["events"]): TranscriptEntry[] {
  return events
    .filter((e) => e.channel === "transcript" && (e.payload as { type: string }).type === "appended")
    .map((e) => (e.payload as { entry: TranscriptEntry }).entry);
}

/** Registra um adapter fake como "xai" (provider do modelo default do catálogo). */
function fakeXai(deltas: string[] = ["resposta"]): {
  registry: ReturnType<typeof createProviderRegistry>;
  adapter: ReturnType<typeof createFakeAdapter>;
} {
  const registry = createProviderRegistry();
  const adapter = createFakeAdapter("xai", { deltas });
  registry.register(adapter);
  return { registry, adapter };
}


describe("fake provider abort lifecycle", () => {
  it("não deixa rejeição órfã quando o sinal aborta após stream sem delay", async () => {
    const adapter = createFakeAdapter("xai", { deltas: ["ok"] });
    const controller = new AbortController();
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      await adapter.streamChat({ model: "grok-4.6", messages: [], signal: controller.signal }, () => undefined);
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});


describe("T10 sendPrompt — aceitação e dedupe por clientNonce", () => {
  it("sendPrompt válido confirma após persistir o echo", async () => {
    const { runner } = makeRunner();
    const result = runner.sendPrompt({ agentId: "openbot-default", prompt: "olá" });
    expect(await result).toEqual({ accepted: true });
  });

  it("aceita o shape do cliente (id + text) no lugar de agentId + prompt", async () => {
    const { runner } = makeRunner();
    expect(await runner.sendPrompt({ id: "openbot-default", text: "Teste" } as never)).toEqual({ accepted: true });
  });

  it("dedupe: retry do MESMO nonce retorna accepted SEM rodar de novo", async () => {
    const { registry, adapter } = fakeXai();
    const { runner, events } = makeRunner({ registry });

    const first = runner.sendPrompt({ agentId: "a", prompt: "olá", clientNonce: "nonce:abc" });
    const retry = runner.sendPrompt({ agentId: "a", prompt: "olá", clientNonce: "nonce:abc" });
    expect(retry).toBe(first);
    expect(await first).toEqual({ accepted: true });
    expect(await retry).toEqual({ accepted: true });
    await runner.flush("a");

    // 1 turno executado (ledger de aceitação — o retry não rodou de novo).
    expect(adapter.invocations).toHaveLength(1);
    expect(runner.isPromptCompleted("a", "nonce:abc")).toBe(true);
    const assistant = allAppended(events).find((e) => e.kind === "message" && e.role === "assistant");
    expect(assistant).toBeDefined();
  });

  it("claim perdido sem echo não confirma persistência nem executa", async () => {
    const { registry, adapter } = fakeXai();
    const store = createMemoryTranscriptStore() as TranscriptStore & {
      claimAcceptedNonce: (agentId: string, nonce: string) => boolean;
    };
    const claims: string[] = [];
    store.claimAcceptedNonce = (agentId, nonce) => {
      claims.push(`${agentId}:${nonce}`);
      return false;
    };
    const { runner } = makeRunner({ registry, store });

    expect(() => runner.sendPrompt({ agentId: "a", prompt: "corrida", clientNonce: "nonce:race" }))
      .toThrow(/sem confirmação de persistência/);
    await runner.flush("a");

    expect(claims).toEqual(["a:nonce:race"]);
    expect(adapter.invocations).toHaveLength(0);
    expect(store.hasAcceptedNonce("a", "nonce:race")).toBe(false);
  });

  it("rejeita agentId inexistente com config antes do claim", () => {
    const { registry } = fakeXai();
    const store = createMemoryTranscriptStore();
    let claimCalls = 0;
    const claim = store.claimAcceptedNonce.bind(store);
    store.claimAcceptedNonce = (...args) => {
      claimCalls += 1;
      return claim(...args);
    };
    const config = {
      snapshot: () => ({ agents: [{ id: "known" }] }),
    } as ConfigStore;
    const { runner } = makeRunner({ registry, store, config });

    expect(() => runner.sendPrompt({ agentId: "ghost", prompt: "p", clientNonce: "nonce:ghost" }))
      .toThrow(/agente não encontrado/);
    expect(claimCalls).toBe(0);
    expect(store.hasAcceptedNonce("ghost", "nonce:ghost")).toBe(false);
  });

  it("nonces DIFERENTES rodam turnos independentes", async () => {
    const { registry, adapter } = fakeXai();
    const { runner } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "p1", clientNonce: "nonce:1" });
    runner.sendPrompt({ agentId: "a", prompt: "p2", clientNonce: "nonce:2" });
    await runner.flush("a");

    expect(adapter.invocations).toHaveLength(2);
  });

  it("não persiste o nonce quando a fila rejeita o turno", async () => {
    const store = createMemoryTranscriptStore();
    const { runner } = makeRunner({ store });
    for (let i = 0; i < MAX_SEND_QUEUE_PER_AGENT; i += 1) {
      runner.sendPrompt({ agentId: "a", prompt: `p${i}`, clientNonce: `n${i}` });
    }

    expect(() => runner.sendPrompt({ agentId: "a", prompt: "cheia", clientNonce: "rejected" })).toThrow(/fila cheia/);
    expect(store.hasAcceptedNonce("a", "rejected")).toBe(false);
    await runner.abortAllTurns();
  });

  it("libera nonce quando a preparação falha antes do echo, permitindo retry", async () => {
    const store = createMemoryTranscriptStore();
    const { registry, adapter } = fakeXai(["retry ok"]);
    let failPreparation = true;
    const runner = createTurnRunner({
      registry,
      store,
      readAttachments: async () => {
        if (failPreparation) {
          failPreparation = false;
          throw new Error("falha determinística na leitura");
        }
        return [];
      },
    });
    const args = {
      agentId: "a",
      prompt: "tentar novamente",
      attachments: [{ path: "C:\\docs\\contexto.md", name: "contexto.md" }],
      clientNonce: "nonce:preparation-retry",
    };

    runner.sendPrompt(args);
    await runner.flush("a");
    expect(store.getEntries("a").some((entry) => (
      entry.kind === "message" && entry.role === "user" && entry.clientNonce === args.clientNonce
    ))).toBe(false);
    expect(store.hasAcceptedNonce("a", args.clientNonce)).toBe(false);

    expect(await runner.sendPrompt(args)).toEqual({ accepted: true });
    await runner.flush("a");
    expect(adapter.invocations).toHaveLength(1);
    expect(store.getEntries("a").some((entry) => (
      entry.kind === "message" && entry.role === "user" && entry.clientNonce === args.clientNonce
    ))).toBe(true);
  });

  it("retryPrompt repete a falha retryable sem duplicar usuário nem reenviar o parcial", async () => {
    const registry = createProviderRegistry();
    const requests: ProviderChatRequest[] = [];
    let attempt = 0;
    registry.register({
      name: "retryable",
      async streamChat(request, emit) {
        requests.push(request);
        attempt += 1;
        emit({ type: "delta", delta: attempt === 1 ? "parcial" : "recuperado" });
        if (attempt === 1) throw Object.assign(new Error("temporary"), { status: 503 });
      },
    });
    const store = createMemoryTranscriptStore();
    let configured: ProviderChatRequest["reasoningEffort"] = "low";
    const runner = createTurnRunner({
      registry,
      store,
      resolveProvider: () => ({ provider: "retryable", model: "retry-model", reasoningEffort: configured }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "pergunta", clientNonce: "nonce:original" });
    await runner.flush("a");
    configured = "high";
    expect(await runner.retryPrompt("a")).toEqual({ accepted: true });
    await runner.flush("a");
    expect(await runner.retryPrompt("a")).toEqual({ accepted: true });
    await runner.flush("a");

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.reasoningEffort)).toEqual(["low", "low"]);
    expect(requests[1]?.messages).toEqual([{ role: "user", content: "pergunta" }]);
    const entries = store.getEntries("a");
    expect(entries.filter((entry) => entry.kind === "message" && entry.role === "user")).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === "notice" && entry.type === "retry-attempt")).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === "message" && entry.role === "assistant" && entry.content === "recuperado")).toHaveLength(1);
  });

  it("mantém cancelamento pendente até a ferramenta terminar e bloqueia retry de efeito concluído", async () => {
    const started = deferred();
    const release = deferred();
    const registry = createProviderRegistry();
    registry.register({ name: "xai", async streamChat(_request, emit) {
      emit({ type: "tool-call", call: { id: "one", type: "function", function: { name: "discardable", arguments: "{}" } } });
      emit({ type: "tool-call", call: { id: "two", type: "function", function: { name: "discardable", arguments: '{"next":true}' } } });
    } });
    const execute = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return { handled: true as const, ok: true, content: "feito" };
    });
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({ registry, store, toolExecutor: execute,
      tools: [{ type: "function", function: { name: "discardable", parameters: { type: "object" } } }] });
    runner.sendPrompt({ agentId: "a", prompt: "operação descartável", clientNonce: "cancel-tool" });
    await started.promise;
    runner.cancelPrompt("a");
    expect(runner.promptStatus("a")).toMatchObject({ isBusy: true, canCancel: false, cancelRequested: true });
    release.resolve();
    await runner.flush("a");
    expect(runner.promptStatus("a")).toEqual({ isBusy: false, canCancel: false, agentId: "a", queued: [], recoverable: [], recoverableTruncated: false,
      // O término é confirmado pelo backend: aborted é o resultado factual do turno.
      lastTurn: expect.objectContaining({ turnId: expect.any(String), outcome: "aborted", finishedAtMs: expect.any(Number) }) });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(() => runner.retryPrompt("a")).toThrow("Este turno já executou ferramentas");
    const completed = store.getEntries("a").find((entry) => entry.kind === "tool-call" && entry.status === "completed")!;
    if (completed.kind !== "tool-call") throw new Error("expected completed tool call");
    store.replace("a", String(completed.id), { ...completed, status: "failed", result: { ok: false, code: "process_aborted", message: "Process execution was aborted." } });
    expect(() => runner.retryPrompt("a")).toThrow("Este turno já executou ferramentas");
    store.replace("a", String(completed.id), { ...completed, status: "failed", result: { ok: false, code: "aborted", message: "Resultado não confirmado após reinício." } });
    expect(() => runner.retryPrompt("a")).toThrow("Confira os resultados e possíveis efeitos");
    store.replace("a", String(completed.id), { ...completed, status: "failed", result: { ok: false, code: "process_failed", exitCode: 7 } });
    expect(() => runner.retryPrompt("a")).toThrow("Confira os resultados e possíveis efeitos");
  });

  it("não revive uma falha antiga depois que a conversa avançou", async () => {
    const registry = createProviderRegistry();
    let attempt = 0;
    registry.register({
      name: "retryable",
      async streamChat(_request, emit) {
        attempt += 1;
        emit({ type: "delta", delta: attempt === 1 ? "parcial" : "nova resposta" });
        if (attempt === 1) throw Object.assign(new Error("temporary"), { status: 503 });
      },
    });
    const runner = createTurnRunner({
      registry,
      resolveProvider: () => ({ provider: "retryable", model: "retry-model" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "antiga", clientNonce: "nonce:old" });
    await runner.flush("a");
    runner.sendPrompt({ agentId: "a", prompt: "nova", clientNonce: "nonce:new" });
    await runner.flush("a");

    expect(() => runner.retryPrompt("a")).toThrow(/falha.*atual|conversa avançou/i);
    expect(attempt).toBe(2);
  });

  it("retryPrompt ignora falhas arquivadas e reporta quando só existe falha antiga arquivada", () => {
    const store = createMemoryTranscriptStore();
    const conversations = store.conversationStore!;
    const agentId = "a";
    const archived = conversations.ensureDefault(agentId);
    const live = conversations.create!(agentId, { title: "Live" });
    conversations.archive!(agentId, archived.id);
    conversations.activate!(agentId, live.id);
    store.append(agentId, [{
      kind: "message",
      id: "archived-user",
      role: "user",
      content: "old archived failure",
      timestampMs: 1,
      streaming: false,
      turnId: "turn:archived",
      clientNonce: "nonce:archived",
    }, {
      kind: "notice",
      id: "archived-notice",
      type: "provider-error",
      level: "error",
      retryable: true,
      turnId: "turn:archived",
      provider: "xai",
      model: "grok-4.6",
      clientNonce: "nonce:archived",
    }], archived.id);

    expect(() => store.conversationStore?.archive?.(agentId, live.id)).toThrow();
    expect(() => createTurnRunner({ store }).retryPrompt(agentId)).toThrow(/nenhuma falha recuperável atual/i);
  });

  it("rejeita mais de 16 anexos antes de persistir o nonce", () => {
    const store = createMemoryTranscriptStore();
    const { runner } = makeRunner({ store });
    const attachments = Array.from({ length: 17 }, (_, index) => ({
      path: `C:\\docs\\${index}.txt`,
      name: `${index}.txt`,
    }));

    expect(() => runner.sendPrompt({
      agentId: "a",
      prompt: "muitos anexos",
      clientNonce: "too-many-attachments",
      attachments,
    })).toThrow(/máximo de 16 anexos/);
    expect(store.hasAcceptedNonce("a", "too-many-attachments")).toBe(false);
  });

  it("corpo inválido (agentId/prompt/attachments/clientNonce) → lança RpcError 400", () => {
    const { runner } = makeRunner();
    expect(() => runner.sendPrompt({ agentId: "", prompt: "x" })).toThrow(/agentId/);
    expect(() => runner.sendPrompt({ agentId: "a", prompt: "  " })).toThrow(/prompt/);
    expect(() => runner.sendPrompt({ agentId: "a", prompt: "x", attachments: "nope" as unknown as never })).toThrow(/attachments/);
    expect(() => runner.sendPrompt({ agentId: "a", prompt: "x", clientNonce: "" })).toThrow(/clientNonce/);
    expect(() => runner.sendPrompt({ agentId: "a", prompt: "x", clientNonce: "   " })).toThrow(/clientNonce/);
    expect(() => runner.sendPrompt({ agentId: "a", prompt: "x", clientNonce: null as unknown as string })).toThrow(/clientNonce/);
    expect(() => runner.sendPrompt({ agentId: "a", prompt: "x", clientNonce: 42 as unknown as string })).toThrow(/clientNonce/);
  });
});
