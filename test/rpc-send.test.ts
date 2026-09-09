/**
 * T10 — Turn runner mínimo (src/rpc/send.ts): unit tests do pipeline
 * envio → stream → transcript → eventos SSE (sem HTTP — o runner direto).
 *
 * Cobertura (plano §3 T10 — Done):
 *   - sendPrompt aceita → {accepted:true} (ack após persistir o echo);
 *   - dedupe por clientNonce (ledger de aceitação): retry do MESMO nonce
 *     retorna accepted SEM rodar de novo (turno único);
 *   - fila EXCLUSIVA por agente: turns do mesmo agente serializam (1 turno em
 *     curso por vez); agentes diferentes rodam em paralelo;
 *   - monta system prompt + transcript (entries kind "message" → diálogo);
 *   - eventos SSE `transcript` (snapshot no início / appended no tail) com
 *     kinds e message.type EXATOS do contrato (mapa-frontend §3.3):
 *     message / user-attachment / tool-call / notice — shapes que a UI
 *     renderiza sem duplicar a resposta textual;
 *   - provider ausente → notice de erro (sem quebrar a fila);
 *   - TranscriptStore INJETÁVEL (T11 pluga o sqlite pela mesma interface).
 *
 * Nota: o resolveProvider DEFAULT do runner usa o catálogo estático (Decisão
 * §8.3) — modelo default `grok-4.6` → provider "xai". Os testes registram o
 * adapter fake como "xai" para exercitar esse caminho real; onde um provider
 * arbitrário é preciso, passam `resolveProvider` explícito.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createProviderRegistry, type ProviderChatRequest } from "../src/providers/router.js";
import type { ConfigStore } from "../src/config/store.js";
import { createKeystore } from "../src/keystore/index.js";
import { XaiAdapter } from "../src/providers/xai.js";
import { createFakeAdapter } from "./mocks/fake-provider-adapter.js";
import {
  MAX_PROVIDER_TEXT_CONTEXT_BYTES,
  MAX_PROVIDER_TRANSCRIPT_MESSAGES,
  MAX_SEND_QUEUE_PER_AGENT,
  createMemoryTranscriptStore,
  createTurnRunner,
  type TurnRunnerOptions,
  type TranscriptStore,
} from "../src/rpc/send.js";
import type { TranscriptEntry } from "../src/shared/contracts.js";
import { MAX_LIVE_RESPONSE_BYTES } from "../src/rpc/stream-state.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { AgentActivityStore } from "../src/rpc/activity.js";
import {
  canonicalProviderRequestBytes,
  providerRequestBodyBytes,
  resolveModelCapabilities,
} from "../src/memory/model-context.js";

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
    expect(runner.promptStatus("a")).toEqual({ isBusy: false, canCancel: false, agentId: "a" });
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

  it("cancelamento esquece imediatamente nonces ainda enfileirados", async () => {
    const registry = createProviderRegistry();
    registry.register(createFakeAdapter("xai", { deltas: ["slow"], deltaDelayMs: 50 }));
    const store = createMemoryTranscriptStore();
    const { runner } = makeRunner({ registry, store });
    runner.sendPrompt({ agentId: "a", prompt: "active" });
    runner.sendPrompt({ agentId: "a", prompt: "queued", clientNonce: "queued-cancel" });
    await Promise.resolve();
    expect(store.hasAcceptedNonce("a", "queued-cancel")).toBe(true);
    expect(runner.cancelPrompt("a").cancelled).toBe(true);
    expect(store.hasAcceptedNonce("a", "queued-cancel")).toBe(false);
    await runner.flush("a");
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

describe("T10 montagem do diálogo (system + transcript → streamChat)", () => {
  it("system prompt + mensagens do transcript chegam ao provider na ordem", async () => {
    const { registry, adapter } = fakeXai();
    const { runner } = makeRunner({ registry, systemPrompt: () => "SYS-OPENBOT" });

    runner.sendPrompt({ agentId: "a", prompt: "primeira" });
    await runner.flush("a");
    runner.sendPrompt({ agentId: "a", prompt: "segunda" });
    await runner.flush("a");

    expect(adapter.invocations).toHaveLength(2);
    const first = adapter.invocations[0]?.req;
    expect(first?.system).toBe("SYS-OPENBOT");
    expect(first?.model).toBe("grok-4.6"); // default do catálogo estático (Decisão §8.3)
    expect(first?.messages).toEqual([{ role: "user", content: "primeira" }]);

    // segundo turno: histórico completo (user+assistant do turno anterior)
    const second = adapter.invocations[1]?.req;
    expect(second?.messages).toEqual([
      { role: "user", content: "primeira" },
      { role: "assistant", content: "resposta" },
      { role: "user", content: "segunda" },
    ]);
  });

  it("usa a query de tail limitada para montar o contexto do provider", async () => {
    const store = createMemoryTranscriptStore();
    store.append("a", Array.from({ length: 200 }, (_, index) => ({
      kind: "message" as const,
      id: `m${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `m${index}`,
      timestampMs: index,
      streaming: false,
    })));
    let fullReads = 0;
    let recentReads = 0;
    let tailReads = 0;
    const getEntries = store.getEntries.bind(store);
    const getRecentEntries = store.getRecentEntries.bind(store);
    const openDurableAgentTail = store.openDurableAgentTail!.bind(store);
    store.getEntries = (agentId) => { fullReads += 1; return getEntries(agentId); };
    store.getRecentEntries = (agentId, options) => { recentReads += 1; return getRecentEntries(agentId, options); };
    store.openDurableAgentTail = (agentId, limit, beforeSeq, conversationId) => {
      tailReads += 1;
      return openDurableAgentTail(agentId, limit, beforeSeq, conversationId);
    };
    const { registry, adapter } = fakeXai();
    const { runner } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "atual" });
    await runner.flush("a");

    expect(adapter.invocations[0]?.req.messages).toHaveLength(80);
    expect(adapter.invocations[0]?.req.messages.at(-1)).toEqual({ role: "user", content: "atual" });
    expect(recentReads).toBe(1);
    expect(tailReads).toBe(1);
    expect(fullReads).toBe(0);
  });

  it("preserva a primeira instrução e começa o restante recente em uma mensagem do usuário", async () => {
    const store = createMemoryTranscriptStore();
    store.append("a", Array.from({ length: MAX_PROVIDER_TRANSCRIPT_MESSAGES + 20 }, (_, index) => ({
      kind: "message" as const,
      id: `long-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: index === 0 ? "IMPORTANTE: responda sempre em português" : `long-${index}`,
      timestampMs: index,
      streaming: false,
    })));
    const { registry, adapter } = fakeXai();
    const { runner } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "pergunta final" });
    await runner.flush("a");

    const messages = adapter.invocations[0]?.req.messages ?? [];
    expect(messages.length).toBeLessThanOrEqual(MAX_PROVIDER_TRANSCRIPT_MESSAGES);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toEqual({ role: "user", content: "IMPORTANTE: responda sempre em português" });
    expect(messages[1]).toEqual({ role: "user", content: "long-22" });
    expect(messages[2]).toEqual({ role: "assistant", content: "long-23" });
    expect(messages.at(-1)).toEqual({ role: "user", content: "pergunta final" });
    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
      kind: "notice",
      level: "info",
      text: "O histórico antigo foi resumido ou omitido para caber no contexto.",
    }));
  });

  it("limita o histórico por tokens e bytes e preserva a solicitação atual", async () => {
    const store = createMemoryTranscriptStore();
    store.append("a", Array.from({ length: 60 }, (_, index) => ({
      kind: "message" as const,
      id: `large-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `${index}:`.padEnd(24 * 1024, "x"),
      timestampMs: index,
      streaming: false,
    })));
    const { registry, adapter } = fakeXai();
    const { runner } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "PEDIDO ATUAL PRESERVADO" });
    await runner.flush("a");

    const messages = adapter.invocations[0]?.req.messages ?? [];
    const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
    expect(bytes).toBeLessThanOrEqual(MAX_PROVIDER_TEXT_CONTEXT_BYTES);
    expect(bytes).toBeGreaterThan(256 * 1024);
    expect(messages.length).toBeGreaterThan(12);
    expect(messages.length).toBeLessThan(61);
    expect(messages[0]?.role).toBe("user");
    expect(typeof messages[0]?.content).toBe("string");
    expect((messages[0] as { content: string }).content).toMatch(/^\d+:/u);
    expect(messages.at(-1)).toEqual({ role: "user", content: "PEDIDO ATUAL PRESERVADO" });
  });

  it("falha fechado antes do provider quando o overhead fixo esgota o envelope", async () => {
    const { registry, adapter } = fakeXai();
    const { runner, events } = makeRunner({
      registry,
      systemPrompt: () => "s".repeat(MAX_PROVIDER_TEXT_CONTEXT_BYTES + 1_024),
    });

    runner.sendPrompt({ agentId: "a", prompt: "pedido" });
    await runner.flush("a");

    expect(adapter.invocations).toHaveLength(0);
    expect(allAppended(events).some((entry) => entry.kind === "notice" && entry.level === "error")).toBe(true);
  });

  it("preserva a âncora global e mantém a fronteira de usuário quando anexos esgotam o tail", async () => {
    const store = createMemoryTranscriptStore();
    store.append("a", [{
      kind: "message",
      id: "attachment-anchor",
      role: "user",
      content: "TAREFA ORIGINAL COM ANEXOS",
      timestampMs: 1,
      streaming: false,
    }]);
    const history: TranscriptEntry[] = [];
    for (let index = 0; index < 60; index += 1) {
      history.push(
        { kind: "message", id: `u-${index}`, role: "user", content: `u-${index}`, timestampMs: index * 4 + 2, streaming: false },
        { kind: "user-attachment", id: `a1-${index}`, file_name: `a1-${index}.txt`, file_path: `a1-${index}.txt`, extractedText: "x" },
        { kind: "user-attachment", id: `a2-${index}`, file_name: `a2-${index}.txt`, file_path: `a2-${index}.txt`, extractedText: "y" },
        { kind: "message", id: `r-${index}`, role: "assistant", content: `r-${index}`, timestampMs: index * 4 + 5, streaming: false },
      );
    }
    store.append("a", history);
    const { registry, adapter } = fakeXai();
    const { runner } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "pergunta após anexos" });
    await runner.flush("a");

    const messages = adapter.invocations[0]?.req.messages ?? [];
    expect(messages.length).toBeLessThanOrEqual(MAX_PROVIDER_TRANSCRIPT_MESSAGES);
    expect(messages[0]).toEqual({ role: "user", content: "TAREFA ORIGINAL COM ANEXOS" });
    expect(messages[1]).toEqual({
      role: "user",
      content: "u-21\n\n[[OPENBOT_UNTRUSTED_ATTACHMENT_BEGIN]]\nname: \"a1-21.txt\"\ncontent:\nx\n[[OPENBOT_UNTRUSTED_ATTACHMENT_END]]\n\n[[OPENBOT_UNTRUSTED_ATTACHMENT_BEGIN]]\nname: \"a2-21.txt\"\ncontent:\ny\n[[OPENBOT_UNTRUSTED_ATTACHMENT_END]]",
    });
    expect(messages[2]).toEqual({ role: "assistant", content: "r-21" });
    expect(messages.at(-1)).toEqual({ role: "user", content: "pergunta após anexos" });
  });

  it("não envia resposta interrompida por crash como histórico concluído", async () => {
    const store = createMemoryTranscriptStore();
    store.append("a", [
      { kind: "message", id: "old-user", role: "user", content: "pergunta antiga", timestampMs: 1, streaming: false },
      { kind: "message", id: "old-partial", role: "assistant", content: "resposta truncada", timestampMs: 2, streaming: false, isStreaming: false, completionState: "interrupted", turnId: "turn:old" },
    ]);
    const { registry, adapter } = fakeXai(["nova"]);
    const { runner } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "próxima" });
    await runner.flush("a");

    expect(adapter.invocations[0]?.req.messages).toEqual([
      { role: "user", content: "pergunta antiga" },
      { role: "user", content: "próxima" },
    ]);
  });

  it("resolveProvider custom (modelo global) é respeitado", async () => {
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("fake", { deltas: ["r"] });
    registry.register(adapter);
    const { runner } = makeRunner({
      registry,
      resolveProvider: () => ({ provider: "fake", model: "gpt-5.6-sol" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    expect(adapter.invocations[0]?.req.model).toBe("gpt-5.6-sol");
  });

  it("fixa provider e modelo no aceite mesmo se a configuração mudar durante a preparação", async () => {
    const registry = createProviderRegistry();
    const oldAdapter = createFakeAdapter("old", { deltas: ["old"] });
    const newAdapter = createFakeAdapter("new", { deltas: ["new"] });
    registry.register(oldAdapter);
    registry.register(newAdapter);
    let selected = { provider: "old", model: "old-model" };
    let releasePreparation!: () => void;
    let preparationStarted!: () => void;
    const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const started = new Promise<void>((resolve) => { preparationStarted = resolve; });
    const runner = createTurnRunner({
      registry,
      resolveProvider: () => selected,
      readAttachments: async () => {
        preparationStarted();
        await preparationGate;
        return [];
      },
    });

    runner.sendPrompt({ agentId: "a", prompt: "usar escolha atual", attachments: [{ path: "temp", name: "temp" }] });
    await started;
    selected = { provider: "new", model: "new-model" };
    releasePreparation();
    await runner.flush("a");

    expect(oldAdapter.invocations).toHaveLength(1);
    expect(oldAdapter.invocations[0]?.req.model).toBe("old-model");
    expect(newAdapter.invocations).toHaveLength(0);
  });

  it("provider que conclui vazio gera explicação explícita", async () => {
    const registry = createProviderRegistry();
    registry.register({ name: "empty", async streamChat() {} });
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      resolveProvider: () => ({ provider: "empty", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "responda", clientNonce: "nonce:empty" });
    await runner.flush("a");

    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
      kind: "notice",
      level: "error",
      text: "O provedor concluiu sem retornar conteúdo.",
      retryable: true,
      provider: "empty",
      model: "fake",
      clientNonce: "nonce:empty",
      turnId: expect.any(String),
    }));
    expect(store.getEntries("a").some((entry) => entry.kind === "message" && entry.role === "assistant")).toBe(false);
  });

  it("provider não registrado → notice de erro no transcript (sem quebrar a fila)", async () => {
    const registry = createProviderRegistry(); // vazio
    const store = createMemoryTranscriptStore();
    const { runner, events } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    // notice de erro no tail (kind "notice") — a fila não quebra
    const appended = allAppended(events);
    expect(appended.some((e) => e.kind === "notice")).toBe(true);
    expect(appended.some((e) => e.kind === "message" && e.role === "assistant")).toBe(false);

    // o agente continua aceitando novos turns
    const result = runner.sendPrompt({ agentId: "a", prompt: "de novo" });
    expect(await result).toEqual({ accepted: true });
    await runner.flush("a");
    const entries = store.getEntries("a");
    expect(entries.flatMap((entry) => entry.kind === "message" && entry.role === "user" ? [entry.content] : []))
      .toEqual(["p", "de novo"]);
    expect(entries.filter((entry) => entry.kind === "notice" && entry.level === "error")).toHaveLength(2);
  });
});

describe("T10 eventos SSE transcript — snapshot no início / appended no tail", () => {
  it("snapshot com o histórico existente ANTES do turno (reset do cliente)", async () => {
    const store = createMemoryTranscriptStore();
    store.append("a", [
      { kind: "message", id: "id:prev", role: "assistant", content: "histórico", timestampMs: 1, streaming: false },
    ]);
    const { registry } = fakeXai();
    const { runner, events } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    const snapshots = events.filter((e) => e.channel === "transcript" && (e.payload as { type: string }).type === "snapshot");
    expect(snapshots).toHaveLength(1);
    const first = snapshots[0] as { payload: { type: "snapshot"; agentId: string; entries: TranscriptEntry[] } };
    expect(first.payload.agentId).toBe("a");
    expect(first.payload.entries).toHaveLength(1);
    const previous = first.payload.entries[0];
    expect(previous?.kind === "message" ? previous.id : undefined).toBe("id:prev");
  });

  it("limita snapshot grande e sinaliza resync sem perder appended do turno", async () => {
    const store = createMemoryTranscriptStore();
    store.append("a", Array.from({ length: 400 }, (_, index) => ({
      kind: "message" as const,
      id: `history:${index}`,
      role: "assistant" as const,
      content: "x".repeat(1024),
      timestampMs: index,
      streaming: false,
    })));
    const { registry } = fakeXai(["ok"]);
    const { runner, events } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    const snapshot = events.find((event) => (
      event.channel === "transcript" && (event.payload as { type?: string }).type === "snapshot"
    ))?.payload as {
      type: string;
      entries: TranscriptEntry[];
      truncated?: boolean;
      resyncRequired?: boolean;
    } | undefined;
    expect(snapshot?.entries.length).toBeLessThan(400);
    expect(snapshot?.truncated).toBe(true);
    expect(snapshot?.resyncRequired).toBe(true);
    expect(Buffer.byteLength(`data: ${JSON.stringify({ channel: "transcript", payload: snapshot })}\n\n`, "utf8"))
      .toBeLessThanOrEqual(256 * 1024);
    expect(allAppended(events).some((entry) => entry.kind === "message" && entry.role === "user" && entry.content === "p"))
      .toBe(true);
  });

  it("appended: mensagem do usuário + resposta textual única do assistente", async () => {
    const { registry } = fakeXai(["Olá, ", "mundo!"]);
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "oi" });
    await runner.flush("a");

    const appended = allAppended(events);

    const user = appended.find((e) => e.kind === "message" && e.role === "user");
    expect(user).toMatchObject({
      kind: "message",
      role: "user",
      content: "oi",
      fromUser: { name: "You", authId: "local-user" },
      streaming: false,
    });
    expect(user).not.toHaveProperty("toAgent");
    expect(typeof (user as { id: string }).id).toBe("string");
    expect(typeof (user as { timestampMs: number }).timestampMs).toBe("number");

    const firstAssistant = appended.find((e) => e.kind === "message" && e.role === "assistant");
    expect(firstAssistant).toMatchObject({
      kind: "message",
      role: "assistant",
      streaming: true,
    });
    expect(firstAssistant).not.toHaveProperty("fromAgent");
    expect(firstAssistant).not.toHaveProperty("clientNonce");
    const updated = events
      .filter((e) => e.channel === "transcript" && (e.payload as { type?: string }).type === "updated")
      .map((e) => (e.payload as { entry: TranscriptEntry }).entry);
    const assistant = [...updated].reverse().find((e) => e.kind === "message" && e.role === "assistant" && e.streaming === false)
      ?? [...appended].reverse().find((e) => e.kind === "message" && e.role === "assistant" && e.streaming === false);
    expect(assistant).toMatchObject({
      kind: "message",
      role: "assistant",
      content: "Olá, mundo!",
      streaming: false,
    });
    expect(assistant).not.toHaveProperty("fromAgent");
    expect(assistant).not.toHaveProperty("clientNonce");

    // A mensagem final já é a entry `message` fechada. Um card textual
    // paralelo exibiria a mesma resposta novamente; cards não textuais não
    // são afetados por esta regra.
    expect(appended.filter((e) => e.kind === "send-message" && e.message.type === "text")).toHaveLength(0);
  });

  it("attachments → entries user-attachment com file_name/file_path (mapa-frontend §3.3)", async () => {
    const { registry } = fakeXai();
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({
      agentId: "a",
      prompt: "leia isto",
      attachments: [{ path: "C:\\docs\\notas.md", name: "notas.md" }],
      clientNonce: "nonce:att",
    });
    await runner.flush("a");

    const att = allAppended(events).find((e) => e.kind === "user-attachment");
    expect(att).toMatchObject({
      kind: "user-attachment",
      file_name: "notas.md",
      file_path: "C:\\docs\\notas.md",
      clientNonce: "nonce:att",
    });
  });

  it("associa anexos homônimos pela posição, sem reutilizar o primeiro conteúdo", async () => {
    const { registry } = fakeXai();
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      readAttachments: async () => [
        { name: "igual.md", path: "C:\\a\\igual.md", text: "primeiro" },
        { name: "igual.md", path: "C:\\b\\igual.md", text: "segundo" },
      ],
    });
    runner.sendPrompt({
      agentId: "a",
      prompt: "compare",
      attachments: [
        { path: "C:\\a\\igual.md", name: "igual.md" },
        { path: "C:\\b\\igual.md", name: "igual.md" },
      ],
    });
    await runner.flush("a");

    const attachments = store.getEntries("a").filter((entry) => entry.kind === "user-attachment");
    expect(attachments.map((entry) => entry.extractedText)).toEqual(["primeiro", "segundo"]);
  });

  it("tool-call do roteador → entry tool-call (name/summary/status) no transcript", async () => {
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("xai", {
      deltas: ["Vou executar"],
      toolCalls: [{ id: "call_1", name: "shell", arguments: '{"cmd":"dir"}' }],
    });
    registry.register(adapter);
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "rode" });
    await runner.flush("a");

    const tool = allAppended(events).find((e) => e.kind === "tool-call");
    expect(tool).toMatchObject({
      kind: "tool-call",
      id: "call_1",
      name: "shell",
      summary: "tool shell",
      status: "completed",
    });
    expect(JSON.stringify(tool)).not.toContain('{"cmd":"dir"}');
  });

  it("erro do provider → notice de erro (kind notice) no tail", async () => {
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("xai", {
      deltas: ["x"],
      error: Object.assign(new Error("chave inválida"), { status: 401 }),
    });
    registry.register(adapter);
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    const appended = allAppended(events);
    const notice = appended.find((e) => e.kind === "notice");
    expect(notice).toMatchObject({ kind: "notice", status: 401 });
    expect(notice?.kind === "notice" ? notice.text : "").toMatch(/chave.*configurações/i);
    // sem message/send-message falsos após o erro
    expect(appended.some((e) => e.kind === "send-message")).toBe(false);
  });

  it("erro retryable persiste mensagem clara e metadados da tentativa", async () => {
    const registry = createProviderRegistry();
    registry.register(createFakeAdapter("xai", {
      deltas: ["parcial"],
      error: Object.assign(new Error("raw provider rate limit"), { status: 429, code: "rate_limit" }),
    }));
    const store = createMemoryTranscriptStore();
    const { runner } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "p", clientNonce: "nonce:rate" });
    await runner.flush("a");

    const notice = store.getEntries("a").find((entry) => entry.kind === "notice");
    expect(notice).toMatchObject({
      kind: "notice",
      level: "error",
      retryable: true,
      providerErrorKind: "rate-limit",
      providerErrorCode: "rate_limit",
      provider: "xai",
      model: "grok-4.6",
      clientNonce: "nonce:rate",
    });
    expect(notice?.kind === "notice" ? notice.text : "").toMatch(/limite de uso/i);
    expect(notice?.kind === "notice" ? notice.turnId : undefined).toMatch(/^turn:/u);
  });

  it("snapshot vem ANTES de qualquer appended (ordem do canal)", async () => {
    const { registry } = fakeXai();
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    const transcriptEvents = events.filter((e) => e.channel === "transcript");
    expect(transcriptEvents[0]?.payload).toMatchObject({ type: "snapshot" });
    const appendedIdx = transcriptEvents.findIndex((e) => (e.payload as { type: string }).type === "appended");
    expect(appendedIdx).toBeGreaterThan(0);
  });
});

describe("T10 TranscriptStore injetável (T11 pluga o sqlite)", () => {
  it("store custom é usado para transcript e ledger — runner não sabe do storage", async () => {
    const { registry } = fakeXai();
    const seen: string[] = [];
    const nonces = new Set<string>();
    const customStore: TranscriptStore = {
      getEntries: (agentId) => {
        seen.push(`get:${agentId}`);
        return [];
      },
      append: (agentId, entries) => {
        seen.push(`append:${agentId}:${entries.length}`);
      },
      beginTurnAttempt: (attempt) => seen.push(`turn:begin:${attempt.agentId}:${attempt.turnId}`),
      updateTurnAttempt: (agentId, turnId, phase) => seen.push(`turn:${phase}:${agentId}:${turnId}`),
      finishTurnAttempt: (agentId, turnId) => seen.push(`turn:finish:${agentId}:${turnId}`),
      clear: (agentId) => {
        seen.push(`clear:${agentId}`);
      },
      getAgentTranscriptTail: () => ({ entries: [] }),
      openAgentTail: (agentId, limit) => {
        seen.push(`tail:${agentId}:${limit}`);
        return { entries: [] };
      },
      getConversationOutline: () => ({ title: null, lastMessage: null }),
      getRecentEntries: () => [],
      getEarliestUser: () => undefined,
      getLatestAssistant: () => undefined,
      getOpenToolCalls: () => [],
      hasAcceptedNonce: (agentId, nonce) => {
        seen.push(`has:${agentId}:${nonce}`);
        return nonces.has(`${agentId}:${nonce}`);
      },
      claimAcceptedNonce: (agentId, nonce) => {
        seen.push(`claim:${agentId}:${nonce}`);
        const key = `${agentId}:${nonce}`;
        if (nonces.has(key)) return false;
        nonces.add(key);
        return true;
      },
      rememberAcceptedNonce: (agentId, nonce) => {
        seen.push(`remember:${agentId}:${nonce}`);
        nonces.add(`${agentId}:${nonce}`);
      },
      forgetAcceptedNonce: (agentId, nonce) => {
        seen.push(`forget:${agentId}:${nonce}`);
        nonces.delete(`${agentId}:${nonce}`);
      },
      trimAcceptedNonces: (agentId, cap) => {
        seen.push(`trim:${agentId}:${cap}`);
      },
      replace: () => false,
    };
    const { runner } = makeRunner({ registry, store: customStore });

    runner.sendPrompt({ agentId: "a", prompt: "p", clientNonce: "nonce:store" });
    await runner.flush("a");

    expect(seen).toContain("tail:a:500");
    expect(seen.some((s) => s.startsWith("append:a:"))).toBe(true);
    expect(seen).toContain("claim:a:nonce:store");
    expect(seen).toContain("trim:a:1000");
    expect(seen.some((entry) => entry.startsWith("turn:begin:a:turn:"))).toBe(true);
    expect(seen.some((entry) => entry.startsWith("turn:provider-pending:a:turn:"))).toBe(true);
    expect(seen.some((entry) => entry.startsWith("turn:streaming:a:turn:"))).toBe(true);
    expect(seen.some((entry) => entry.startsWith("turn:finish:a:turn:"))).toBe(true);
  });

  it("ledger FIFO do store em memória remove o nonce mais antigo", () => {
    const store = createMemoryTranscriptStore();
    store.rememberAcceptedNonce("a", "n1");
    store.rememberAcceptedNonce("a", "n2");
    store.trimAcceptedNonces("a", 1);

    expect(store.hasAcceptedNonce("a", "n1")).toBe(false);
    expect(store.hasAcceptedNonce("a", "n2")).toBe(true);
  });

  it("keystore real injetada resolve chave de adapter real via registry (paridade com T6/T7)", async () => {
    const registry = createProviderRegistry();
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const fetchImpl = fetchMock as unknown as typeof globalThis.fetch;
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openbot-rpc-keystore-"));
    try {
      const keystore = createKeystore({ dir, writeBackend: undefined, legacyReadBackend: undefined });
      await keystore.upsert("xai", "xai-secreta");
      const adapter = new XaiAdapter({
        baseUrl: "http://127.0.0.1:1/v1",
        keystore,
        fetchImpl,
      });
      registry.register(adapter);

      const { runner } = makeRunner({ registry });
      runner.sendPrompt({ agentId: "a", prompt: "p" });
      await runner.flush("a");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0]?.[1];
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer xai-secreta");
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "grok-4.6", stream: true });
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("send/tool xAI mede o body chat real, não apenas o envelope canônico", async () => {
    const registry = createProviderRegistry();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push(String(init?.body));
      const payload = [
        { choices: [{ delta: { content: "done" } }] },
        "[DONE]",
      ];
      const body = payload.map((event) => event === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    registry.register(new XaiAdapter({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "xai-test", fetchImpl }));
    const system = "s".repeat(128);
    const prompt = "p".repeat(256);
    const maxTokens = resolveModelCapabilities("grok-4.6", "xai").maxOutputTokens;
    const toolWithPadding = (padding: number) => [{
      type: "function" as const,
      function: { name: "lookup", parameters: { type: "object", description: "d".repeat(padding) } },
    }];
    const canonicalWithoutPadding = canonicalProviderRequestBytes({
      model: "grok-4.6",
      system,
      messages: [{ role: "user", content: prompt }],
      tools: toolWithPadding(0),
      maxTokens,
    });
    const tools = toolWithPadding(MAX_PROVIDER_TEXT_CONTEXT_BYTES - canonicalWithoutPadding - 10);
    const ungatedRequest: ProviderChatRequest = {
      model: "grok-4.6",
      system,
      messages: [{ role: "user", content: prompt }],
      tools,
      maxTokens,
    };
    expect(canonicalProviderRequestBytes(ungatedRequest)).toBe(MAX_PROVIDER_TEXT_CONTEXT_BYTES - 10);
    expect(providerRequestBodyBytes("xai", ungatedRequest)).toBeGreaterThan(MAX_PROVIDER_TEXT_CONTEXT_BYTES);
    const runner = createTurnRunner({
      registry,
      systemPrompt: () => system,
      tools,
      toolExecutor: async () => ({ handled: true, ok: true, content: "tool ok", result: { ok: true } }),
    });

    runner.sendPrompt({ agentId: "a", prompt });
    await runner.flush("a");

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0] ?? "{}") as { model: string; messages: ProviderChatRequest["messages"]; tools: NonNullable<ProviderChatRequest["tools"]>; max_tokens: number };
    const canonical = canonicalProviderRequestBytes({
      model: body.model,
      system: body.messages[0]?.role === "system" && typeof body.messages[0].content === "string" ? body.messages[0].content : undefined,
      messages: body.messages.filter((message) => message.role !== "system"),
      tools: body.tools,
      maxTokens: body.max_tokens,
    });
    const bodyBytes = Buffer.byteLength(calls[0] ?? "", "utf8");
    expect(bodyBytes).toBeLessThanOrEqual(MAX_PROVIDER_TEXT_CONTEXT_BYTES);
    expect(bodyBytes).toBeGreaterThan(MAX_PROVIDER_TEXT_CONTEXT_BYTES - 512);
    expect(bodyBytes).toBeGreaterThan(canonical + 25);
  });
});

describe("T10 — stream incremental reusa o mesmo id", () => {
  it("openAgentTail expõe o preview live mais recente antes da persistência periódica", async () => {
    const registry = createProviderRegistry();
    let now = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    registry.register({
      name: "xai",
      async streamChat(_request, emit) {
        emit({ type: "delta", delta: "E2E " });
        now = 400;
        emit({ type: "delta", delta: "incremental " });
        now = 800;
        emit({ type: "delta", delta: "stream " });
        await blocked;
      },
    });
    const store = createMemoryTranscriptStore();
    const { runner, events } = makeRunner({ registry, store, now: () => now });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const assistant = store.openAgentTail("a").entries.find((entry) => (
        entry.kind === "message" && entry.role === "assistant"
      ));
      expect(assistant).toMatchObject({
        content: "E2E incremental stream ",
        streaming: true,
      });
      const orderedTranscriptEvents = events
        .filter((event) => event.channel === "transcript")
        .map((event) => event.payload as {
          type?: string;
          ordered?: { replicaKey: string; epoch: string; sequence: number };
          resyncRequired?: boolean;
        });
      expect(orderedTranscriptEvents.some((event) => event.type === "updated" && event.resyncRequired === true)).toBe(false);
      const nonDelta = orderedTranscriptEvents.filter((event) => event.type !== "delta");
      expect(nonDelta.some((event) => event.ordered?.replicaKey === "transcript:a")).toBe(true);
      const deltas = orderedTranscriptEvents.filter((event) => event.type === "delta");
      expect(deltas.every((event) => event.ordered?.replicaKey === "transcript:a")).toBe(true);
      const firstDeltaSequence = deltas[0]?.ordered?.sequence ?? 0;
      expect(deltas.map((event) => event.ordered?.sequence)).toEqual(
        deltas.map((_, index) => firstDeltaSequence + index),
      );
    } finally {
      release();
      await runner.flush("a");
    }
  });

  it("publica o primeiro delta antes do provider concluir", async () => {
    const registry = createProviderRegistry();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    registry.register({
      name: "xai",
      async streamChat(_request, emit) {
        emit({ type: "delta", delta: "parcial" });
        await blocked;
        emit({ type: "delta", delta: " final" });
      },
    });
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const assistantBeforeDone = allAppended(events).find((entry) => entry.kind === "message" && entry.role === "assistant");
    expect(assistantBeforeDone).toMatchObject({
      kind: "message",
      role: "assistant",
      content: "",
      streaming: true,
    });
    expect(events.some((event) => (
      event.channel === "transcript" && (event.payload as { type?: string }).type === "delta"
    ))).toBe(true);

    release();
    await runner.flush("a");
  });

  it("usa openAgentTail limitado para o snapshot inicial do SQLite e preserva os 500 mais novos", async () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      store.append("a", Array.from({ length: 20_000 }, (_, index) => ({
        kind: "message" as const,
        id: `history:${index}`,
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `h${index}`,
        timestampMs: index,
        streaming: false,
      })));
      const getEntries = store.getEntries.bind(store);
      const openDurableAgentTail = store.openDurableAgentTail.bind(store);
      let tailReads = 0;
      store.getEntries = () => {
        throw new Error("full transcript snapshot");
      };
      store.openDurableAgentTail = (agentId, limit, beforeSeq, conversationId) => {
        tailReads += 1;
        return openDurableAgentTail(agentId, limit, beforeSeq, conversationId);
      };
      const { registry } = fakeXai(["ok"]);
      const { runner, events } = makeRunner({ registry, store });

      runner.sendPrompt({ agentId: "a", prompt: "final" });
      await runner.flush("a");

      const snapshot = events.find((event) => event.channel === "transcript" && (event.payload as { type?: string }).type === "snapshot")
        ?.payload as { entries: TranscriptEntry[]; truncated?: boolean; resyncRequired?: boolean; method?: string } | undefined;
      expect(tailReads).toBe(1);
      expect(snapshot?.entries).toHaveLength(500);
      expect(snapshot?.entries[0]).toMatchObject({ id: "history:19500" });
      expect(snapshot?.entries.at(-1)).toMatchObject({ id: "history:19999" });
      expect(snapshot).toMatchObject({ truncated: true, resyncRequired: true, method: "openAgentTail" });
      expect(() => getEntries("a")).not.toThrow();
    } finally {
      store.close();
    }
  });

  it("deltas geram uma entry streaming e o texto final fecha no mesmo id", async () => {
    const { registry } = fakeXai(["a", "b", "c"]);
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    const assistantMessages = allAppended(events).filter((e) => e.kind === "message" && e.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect((assistantMessages[0] as { streaming?: boolean }).streaming).toBe(true);
    const updated = events
      .filter((e) => e.channel === "transcript" && (e.payload as { type?: string }).type === "updated")
      .map((e) => (e.payload as { entry: TranscriptEntry }).entry)
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "message" }> => (
        entry.kind === "message" && entry.role === "assistant"
      ));
    const final = updated.reverse().find((entry) => entry.streaming === false);
    expect(final).toMatchObject({ content: "abc", id: (assistantMessages[0] as { id: string }).id });
    const deltaEvents = events
      .filter((event) => event.channel === "transcript" && (event.payload as { type?: string }).type === "delta")
      .map((event) => event.payload as { type: "delta"; entryId: string; fragment: string; ordered: { replicaKey: string; epoch: string; sequence: number } });
    expect(deltaEvents.map((event) => event.fragment).join("")).toBe("abc");
    expect(deltaEvents).toHaveLength(3);
    expect(new Set(deltaEvents.map((event) => event.entryId)).size).toBe(1);
    const orderedEvents = events
      .filter((event) => event.channel === "transcript" && (event.payload as { ordered?: unknown }).ordered !== undefined)
      .map((event) => (event.payload as { ordered: { replicaKey: string; epoch: string; sequence: number } }).ordered);
    expect(orderedEvents.every((event) => event.replicaKey === "transcript:a")).toBe(true);
    expect(new Set(orderedEvents.map((event) => event.epoch)).size).toBe(1);
    expect(orderedEvents.map((event) => event.sequence)).toEqual(
      orderedEvents.map((_, index) => index + 1),
    );
    const finalPayload = [...events].reverse().find((event) => (
      event.channel === "transcript" && (event.payload as { type?: string; final?: boolean }).type === "updated"
        && (event.payload as { final?: boolean }).final === true
    ))?.payload as { throughSequence?: number; final?: boolean; ordered?: { sequence: number } } | undefined;
    expect(finalPayload).toMatchObject({ final: true, throughSequence: deltaEvents.at(-1)!.ordered.sequence });
  });

  it("mantém uma única namespace ordenada por agente, sem mapa por turno", async () => {
    const { registry } = fakeXai(["ok"]);
    const { runner } = makeRunner({ registry });
    for (let index = 0; index < 24; index += 1) {
      runner.sendPrompt({ agentId: "a", prompt: `p-${index}` });
      await runner.flush("a");
    }

    const orderMap = (runner as unknown as { transcriptOrderByKey: Map<string, unknown> }).transcriptOrderByKey;
    expect([...orderMap.keys()]).toEqual(["transcript:a"]);
  });

  it("fenceia o epoch por agente antes de um resync autoritativo", async () => {
    const { registry } = fakeXai(["before"]);
    const { runner, events } = makeRunner({ registry });
    runner.sendPrompt({ agentId: "a", prompt: "before" });
    await runner.flush("a");
    const beforeEpoch = events
      .filter((event) => event.channel === "transcript")
      .map((event) => (event.payload as { ordered?: { epoch?: string } }).ordered?.epoch)
      .find((epoch): epoch is string => epoch !== undefined);

    runner.rotateTranscriptEpoch("a");
    runner.publishConversationSnapshot("a");
    const afterEpochs = events
      .filter((event) => event.channel === "transcript")
      .map((event) => (event.payload as { ordered?: { epoch?: string } }).ordered?.epoch)
      .filter((epoch): epoch is string => epoch !== undefined);
    expect(afterEpochs.at(-1)).toBeDefined();
    expect(afterEpochs.at(-1)).not.toBe(beforeEpoch);
    expect((events.at(-1)?.payload as { ordered?: { sequence?: number } }).ordered?.sequence).toBe(1);
  });

  it("todo snapshot emitido carrega activeAgentId igual a agentId", async () => {
    const { registry } = fakeXai();
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    const snapshots = events
      .filter((event) => event.channel === "transcript" && (event.payload as { type?: string }).type === "snapshot")
      .map((event) => event.payload as {
        type: "snapshot";
        agentId: string;
        activeAgentId: string;
        entries: TranscriptEntry[];
      });
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      expect(snapshot.agentId).toBe("a");
      expect(snapshot.activeAgentId).toBe("a");
      expect(snapshot.activeAgentId).toBe(snapshot.agentId);
    }
  });
});
