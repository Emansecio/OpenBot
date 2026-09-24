
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createProviderRegistry, type ProviderChatRequest } from "../src/providers/router.js";
import { createFakeAdapter } from "./mocks/fake-provider-adapter.js";
import { createMemoryTranscriptStore, createTurnRunner, type TurnRunnerOptions } from "../src/rpc/send.js";
import type { TranscriptEntry } from "../src/shared/contracts.js";
import { MAX_LIVE_RESPONSE_BYTES } from "../src/rpc/stream-state.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { AgentActivityStore } from "../src/rpc/activity.js";

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


describe("T10 fila exclusiva por agente (serialização)", () => {
  it("turns do MESMO agente serializam — um turno em curso por vez", async () => {
    const registry = createProviderRegistry();
    const starts = Array.from({ length: 3 }, () => deferred());
    const releases = Array.from({ length: 3 }, () => deferred());
    const prompts: string[] = [];
    let active = 0;
    let maxActive = 0;
    const adapter = {
      name: "xai",
      invocations: [] as ProviderChatRequest[],
      async streamChat(req: ProviderChatRequest, emit: (event: { type: "delta"; delta: string }) => void) {
        const index = prompts.length;
        prompts.push(String(req.messages.at(-1)?.content));
        adapter.invocations.push(req);
        active += 1;
        maxActive = Math.max(maxActive, active);
        starts[index]!.resolve();
        try {
          await releases[index]!.promise;
          emit({ type: "delta", delta: "r" });
        } finally {
          active -= 1;
        }
      },
    };
    registry.register(adapter);
    const { runner } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "p1" });
    runner.sendPrompt({ agentId: "a", prompt: "p2" });
    runner.sendPrompt({ agentId: "a", prompt: "p3" });
    await starts[0]!.promise;
    expect(active).toBe(1);
    expect(maxActive).toBe(1);
    releases[0]!.resolve();
    await starts[1]!.promise;
    expect(maxActive).toBe(1);
    releases[1]!.resolve();
    await starts[2]!.promise;
    expect(maxActive).toBe(1);
    releases[2]!.resolve();
    await runner.flush("a");

    expect(adapter.invocations).toHaveLength(3);
    expect(prompts).toEqual(["p1", "p2", "p3"]);
  });

  it("agentes DIFERENTES rodam em paralelo (sem deadlock na fila)", async () => {
    const registry = createProviderRegistry();
    const starts = Array.from({ length: 3 }, () => deferred());
    const releases = Array.from({ length: 3 }, () => deferred());
    const prompts: string[] = [];
    let active = 0;
    let maxActive = 0;
    const adapter = {
      name: "xai",
      invocations: [] as ProviderChatRequest[],
      async streamChat(req: ProviderChatRequest, emit: (event: { type: "delta"; delta: string }) => void) {
        const index = prompts.length;
        prompts.push(String(req.messages.at(-1)?.content));
        adapter.invocations.push(req);
        active += 1;
        maxActive = Math.max(maxActive, active);
        starts[index]!.resolve();
        try {
          await releases[index]!.promise;
          emit({ type: "delta", delta: "r" });
        } finally {
          active -= 1;
        }
      },
    };
    registry.register(adapter);
    const { runner } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "pa" });
    runner.sendPrompt({ agentId: "b", prompt: "pb" });
    runner.sendPrompt({ agentId: "a", prompt: "pa2" });
    await Promise.all([starts[0]!.promise, starts[1]!.promise]);
    expect(active).toBe(2);
    expect(maxActive).toBe(2);
    expect(prompts).toEqual(expect.arrayContaining(["pa", "pb"]));
    releases[0]!.resolve();
    releases[1]!.resolve();
    await starts[2]!.promise;
    releases[2]!.resolve();
    await Promise.all([runner.flush("a"), runner.flush("b")]);

    expect(adapter.invocations).toHaveLength(3);
    expect(prompts).toEqual(expect.arrayContaining(["pa", "pb", "pa2"]));
  });

  it("expõe todos os bots busy e cancel sem id não cancela dois turnos", async () => {
    const registry = createProviderRegistry();
    const starts = [deferred(), deferred()];
    let invocation = 0;
    registry.register({
      name: "xai",
      async streamChat(request) {
        starts[invocation++]!.resolve();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });
    const runner = createTurnRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "a" });
    runner.sendPrompt({ agentId: "b", prompt: "b" });
    await Promise.all(starts.map((entry) => entry.promise));

    expect(runner.getStatus()).toMatchObject({ isBusy: true, busyAgentIds: expect.arrayContaining(["a", "b"]) });
    expect(runner.cancelPrompt()).toEqual({ cancelled: false, agentIds: [] });
    expect(runner.promptStatus("a").isBusy).toBe(true);
    expect(runner.promptStatus("b").isBusy).toBe(true);

    runner.cancelPrompt("a");
    runner.cancelPrompt("b");
    await Promise.all([runner.flush("a"), runner.flush("b")]);
  });

  it("não publica estado idle entre turnos já enfileirados", async () => {
    const registry = createProviderRegistry();
    registry.register(createFakeAdapter("xai", { deltas: ["ok"] }));
    const activity = new AgentActivityStore();
    const states: boolean[] = [];
    activity.subscribe(() => states.push(activity.get("a").isRunning));
    const runner = createTurnRunner({ registry, activity });

    runner.sendPrompt({ agentId: "a", prompt: "primeiro" });
    runner.sendPrompt({ agentId: "a", prompt: "segundo" });
    await runner.flush("a");

    expect(states.at(-1)).toBe(false);
    expect(states.slice(0, -1)).not.toContain(false);
  });

  it("falha ao publicar notice não envenena o próximo turno da fila", async () => {
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("xai", { deltas: ["segundo executou"] });
    registry.register(adapter);
    const store = createMemoryTranscriptStore();
    const append = store.append.bind(store);
    let toolsCalls = 0;
    let noticeFailures = 2;
    store.append = (agentId, entries, conversationId) => {
      if (noticeFailures > 0 && entries.some((entry) => entry.kind === "notice")) {
        noticeFailures -= 1;
        throw new Error("notice write failed");
      }
      append(agentId, entries, conversationId);
    };
    const runner = createTurnRunner({
      registry,
      store,
      tools: async () => {
        toolsCalls += 1;
        if (toolsCalls === 1) throw new Error("discovery failed");
        return [];
      },
    });

    runner.sendPrompt({ agentId: "a", prompt: "primeiro" });
    runner.sendPrompt({ agentId: "a", prompt: "segundo" });
    await runner.flush("a");

    expect(adapter.invocations).toHaveLength(1);
    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
      kind: "message",
      role: "assistant",
      content: "segundo executou",
    }));
  });

  it("fecha tool-call aberta no finally do turno", async () => {
    const { registry } = fakeXai(["ok"]);
    const store = createMemoryTranscriptStore();
    store.append("a", [{ kind: "tool-call", id: "stale-tool", name: "file", summary: "read", status: "running" }]);
    const runner = createTurnRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "continue" });
    await runner.flush("a");

    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
      kind: "tool-call",
      id: "stale-tool",
      status: "failed",
      result: expect.objectContaining({ code: "aborted" }),
    }));
  });

  it("cancelamento abrangente remove pendências duráveis sem executar seus turnos", async () => {
    const registry = createProviderRegistry();
    registry.register(createFakeAdapter("xai", { deltas: ["slow"], deltaDelayMs: 50 }));
    const store = createMemoryTranscriptStore();
    const { runner } = makeRunner({ registry, store });
    runner.sendPrompt({ agentId: "a", prompt: "active" });
    runner.sendPrompt({ agentId: "a", prompt: "queued", clientNonce: "queued-cancel" });
    await Promise.resolve();
    const queued = store.promptQueue!.list("a");
    expect(queued.map(item => item.args.clientNonce)).toEqual(["queued-cancel"]);
    expect(runner.cancelPrompt("a").cancelled).toBe(true);
    expect(store.hasAcceptedNonce("a", "queued-cancel")).toBe(false);
    expect(store.promptQueue!.list("a")).toEqual([]);
    expect(store.promptQueue!.get("a", queued[0]!.args.conversationId!, "queued-cancel")?.state).toBe("cancelled");
    await runner.flush("a");
  });

  it("terminaliza texto parcial como interrupted quando o consumidor de evento falha", async () => {
    const { registry } = fakeXai(["parcial"]);
    const store = createMemoryTranscriptStore();
    let failedOnce = false;
    const runner = createTurnRunner({
      registry,
      store,
      publish: (channel, payload) => {
        if (!failedOnce && channel === "transcript" && (payload as { type?: string }).type === "delta") {
          failedOnce = true;
          throw new Error("observer failed");
        }
      },
      now: fixedClock().now,
      newId: ids().newId,
    });

    runner.sendPrompt({ agentId: "a", prompt: "falhe depois do delta" });
    await runner.flush("a");

    expect(failedOnce).toBe(true);
    const finalAssistant = [...store.getEntries("a")].reverse().find((entry) => (
      entry.kind === "message" && entry.role === "assistant" && entry.streaming === false
    ));
    expect(finalAssistant).toMatchObject({ content: "parcial", completionState: "interrupted" });
  });

  it.each(["memory", "sqlite"] as const)("preserva a resposta e encerra como interrupted após falha única na gravação final (%s)", async (kind) => {
    const { registry, adapter } = fakeXai(["texto que não pode sumir"]);
    const store = kind === "sqlite" ? new SqliteTranscriptStore({ path: ":memory:" }) : createMemoryTranscriptStore();
    const replace = store.replace.bind(store);
    let failures = 0;
    store.replace = (agentId, id, entry, conversationId) => {
      if (failures === 0 && entry.kind === "message" && entry.role === "assistant" && entry.streaming === false) {
        failures += 1;
        throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
      }
      return replace(agentId, id, entry, conversationId);
    };
    try {
      const runner = createTurnRunner({ registry, store });
      await runner.sendPrompt({ agentId: "a", prompt: "oi", clientNonce: "final-write" });
      await runner.flush("a");
      const assistants = store.getEntries("a").filter((entry): entry is Extract<TranscriptEntry, { kind: "message" }> => entry.kind === "message" && entry.role === "assistant");
      expect(failures).toBe(1);
      expect(adapter.invocations).toHaveLength(1);
      expect(assistants).toHaveLength(1);
      store.clearLiveEntry!("a", assistants[0]!.id!);
      expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
        id: assistants[0]!.id, content: "texto que não pode sumir", streaming: false, completionState: "interrupted",
      }));
      expect(runner.promptStatus("a")).toMatchObject({ isBusy: false, canCancel: false, lastTurn: { outcome: "error" } });
      expect(store.getEntries("a")).toContainEqual(expect.objectContaining({ kind: "notice", level: "error" }));
    } finally {
      if (store instanceof SqliteTranscriptStore) store.close();
    }
  });

  it("libera o executor e mantém o journal quando a gravação final continua falhando", async () => {
    const { registry } = fakeXai(["texto retido"]);
    const store = createMemoryTranscriptStore();
    const replace = store.replace.bind(store);
    let failWrites = true;
    store.replace = (agentId, id, entry, conversationId) => {
      if (failWrites && entry.kind === "message" && entry.role === "assistant" && entry.streaming === false) throw new Error("write failed");
      return replace(agentId, id, entry, conversationId);
    };
    const runner = createTurnRunner({ registry, store });
    await runner.sendPrompt({ agentId: "a", prompt: "primeiro", clientNonce: "failed-write" });
    await runner.flush("a");
    expect(runner.promptStatus("a")).toMatchObject({ isBusy: false, canCancel: false, lastTurn: { outcome: "error" } });
    expect(runner.isPromptCompleted("a", "failed-write")).toBe(false);
    const first = store.getEntries("a").find(entry => entry.kind === "message" && entry.role === "assistant");
    expect(first).toMatchObject({ content: "texto retido", streaming: false, completionState: "interrupted" });
    failWrites = false;
    await runner.sendPrompt({ agentId: "a", prompt: "segundo", clientNonce: "next-write" });
    await runner.flush("a");
    const assistants = store.getEntries("a").filter(entry => entry.kind === "message" && entry.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[1]!.id).not.toBe(first!.id);
    expect(runner.promptStatus("a")).toMatchObject({ isBusy: false, lastTurn: { outcome: "success" } });
  });

  it("limita resposta viva ao teto aceito pelo SSE", async () => {
    const registry = createProviderRegistry();
    registry.register(createFakeAdapter("xai", { deltas: ["x".repeat(MAX_LIVE_RESPONSE_BYTES + 1024)] }));
    const store = createMemoryTranscriptStore();
    const { runner } = makeRunner({ registry, store });
    runner.sendPrompt({ agentId: "a", prompt: "resposta grande" });
    await runner.flush("a");
    const assistants = store.getEntries("a").filter((entry): entry is Extract<TranscriptEntry, { kind: "message" }> => entry.kind === "message" && entry.role === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    expect(Math.max(...assistants.map((entry) => Buffer.byteLength(entry.content, "utf8")))).toBeLessThanOrEqual(MAX_LIVE_RESPONSE_BYTES);
    const finalAssistant = [...store.getEntries("a")].reverse().find((entry) => (
      entry.kind === "message" && entry.role === "assistant" && entry.streaming === false
    ));
    expect(finalAssistant).toMatchObject({ completionState: "interrupted" });
    expect(Buffer.byteLength(JSON.stringify({ channel: "transcript", payload: { type: "updated", agentId: "a", entry: finalAssistant } }), "utf8")).toBeLessThan(256 * 1024);
    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
      kind: "notice",
      level: "error",
      retryable: true,
      text: "A resposta atingiu o limite seguro de tamanho.",
    }));
    expect(store.getEntries("a")).not.toContainEqual(expect.objectContaining({
      kind: "notice",
      text: "Geração interrompida.",
    }));
    expect(store.getEntries("a").filter((entry) => entry.kind === "send-message" && entry.message.type === "text")).toHaveLength(0);
  });

  it("coalesce deltas rápidos e persiste stream no máximo uma vez por segundo", async () => {
    const registry = createProviderRegistry();
    let clock = 0;
    registry.register({
      name: "bursty",
      async streamChat(_request, emit) {
        for (let index = 0; index < 60; index += 1) {
          clock += 20;
          emit({ type: "delta", delta: "x" });
        }
      },
    });
    const store = createMemoryTranscriptStore();
    const originalReplace = store.replace.bind(store);
    const replacementTimes: number[] = [];
    store.replace = (...args) => {
      replacementTimes.push(clock);
      return originalReplace(...args);
    };
    const published = collectPublish();
    const runner = createTurnRunner({
      registry,
      store,
      publish: published.publish,
      now: () => clock,
      resolveProvider: () => ({ provider: "bursty", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "burst" });
    await runner.flush("a");

    const updates = published.events.filter((event) => (
      event.channel === "transcript" && (event.payload as { type?: string }).type === "updated"
    ));
    expect(updates.length).toBeLessThanOrEqual(14);
    expect(replacementTimes).toEqual([1_020, 1_200]);
  });

  it("shutdown aborta o turno ativo, descarta os enfileirados e recusa novos", async () => {
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("xai", { deltas: ["x", "y"], deltaDelayMs: 50 });
    registry.register(adapter);
    const store = createMemoryTranscriptStore();
    const { runner } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "ativo" });
    runner.sendPrompt({ agentId: "a", prompt: "enfileirado", clientNonce: "queued-before-shutdown" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.invocations).toHaveLength(1);

    await runner.abortAllTurns();

    expect(adapter.invocations).toHaveLength(1);
    expect(store.getEntries("a").some((entry) => entry.kind === "message" && entry.content === "enfileirado")).toBe(false);
    expect(store.hasAcceptedNonce("a", "queued-before-shutdown")).toBe(false);
    expect(() => runner.sendPrompt({ agentId: "a", prompt: "depois" })).toThrow(/encerramento/);
  });

  it("falha o shutdown quando um provider não encerra dentro do timeout", async () => {
    const registry = createProviderRegistry();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    registry.register({
      name: "hung",
      async streamChat() {
        await blocked;
      },
    });
    const { runner } = makeRunner({
      registry,
      resolveProvider: () => ({ provider: "hung", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "ativo" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const drain = runner.waitForDrain();
    let drained = false;
    void drain.then(() => { drained = true; });
    await expect(runner.abortAllTurns(10)).rejects.toThrow(/timed out|timeout|encerra/i);
    expect(drained).toBe(false);

    release();
    await drain;
    expect(drained).toBe(true);
  });
});
