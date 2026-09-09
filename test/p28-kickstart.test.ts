import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createKeystore } from "../src/keystore/index.js";
import { XaiAdapter } from "../src/providers/xai.js";
import { createProviderRegistry } from "../src/providers/router.js";
import { registerRpcHandlers } from "../src/rpc/index.js";
import {
  KICKSTART_INTERNAL_PROMPT,
  MAX_KICKSTART_NONCE_BYTES,
  createMemoryTranscriptStore,
  createTurnRunner,
} from "../src/rpc/send.js";
import { registerRosterHandlers } from "../src/rpc/roster.js";
import { Gateway } from "../src/server/gateway.js";
import { SqliteTranscriptStore } from "../src/store/index.js";

const kickstart = (agentId = "agent-a", clientNonce = "nonce-a") => ({
  agentId,
  clientNonce,
  mode: "onboarding" as const,
});

function fixtureRunner(provider: { streamChat: (request: any, emit: (event: any) => void) => Promise<void> | void }, extra: Record<string, unknown> = {}) {
  const registry = createProviderRegistry();
  registry.register({ name: "fixture", ...provider } as any);
  const store = createMemoryTranscriptStore();
  store.conversationStore!.ensureDefault("agent-a");
  const runner = createTurnRunner({
    registry,
    store,
    resolveProvider: () => ({ provider: "fixture", model: "fixture-model" }),
    resolveKickstartReadiness: async () => undefined,
    ...extra,
  });
  return { runner, store };
}

describe("P2.8 kickstart opt-in", () => {
  it("mantém o roster legado como no-op e zero provider", async () => {
    const handlers = new Map<string, (body: unknown) => unknown>();
    const gateway = {
      registerHandler(name: string, handler: (body: unknown) => unknown) { handlers.set(name, handler); },
      publish() { /* no-op */ },
    } as any;
    const agent = {
      id: "agent-a",
      name: "Fixture",
      avatarId: "fixture",
      provider: "openai-compat",
      model: "openai-compatible",
    };
    const config = {
      snapshot: () => ({ agents: [agent], profile: {} }),
      update: () => ({ agents: [agent] }),
      mutate: (mutator: (current: { agents: Array<typeof agent>; profile: Record<string, never> }) => Partial<{ agents: Array<typeof agent>; profile: Record<string, never> }>) => {
        const current = { agents: [agent], profile: {} };
        return { ...current, ...mutator(current) };
      },
    };
    let optInCalls = 0;
    registerRosterHandlers(gateway, config as any, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => {
      optInCalls += 1;
      throw new Error("must not run");
    });
    const result = await handlers.get("kickstartAgent")!({ id: "agent-a" });
    expect(result).toEqual({ isIntroductionInFlight: false });
    expect(optInCalls).toBe(0);
  });

  it("expõe o contrato operacional opt-in no TurnRunner", () => {
    const runner = createTurnRunner({
      registry: createProviderRegistry(),
      store: createMemoryTranscriptStore(),
      resolveKickstartReadiness: async () => undefined,
    });

    expect(typeof (runner as any).kickstartAgent).toBe("function");
  });

  it("não chama provider sem opt-in e rejeita readiness antes do claim", async () => {
    let calls = 0;
    const { runner, store } = fixtureRunner({
      async streamChat() { calls += 1; },
    }, { resolveKickstartReadiness: async () => { throw new Error("not-ready"); } });

    await expect((runner as any).kickstartAgent({ agentId: "agent-a", clientNonce: "n" }))
      .rejects.toMatchObject({ status: 400 });
    await expect(runner.kickstartAgent(kickstart("agent-a", "é".repeat(MAX_KICKSTART_NONCE_BYTES))))
      .rejects.toMatchObject({ status: 400 });
    await expect(runner.kickstartAgent(kickstart())).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(0);
    expect(store.getKickstartRun?.("agent-a", "nonce-a")).toBeUndefined();
  });

  it("aceita no onboarding a credencial global usada pelo adapter de produção", async () => {
    const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "openbot-p28-credential-"));
    try {
      const keystore = createKeystore({ dir: join(root, "keys") });
      await keystore.upsert("xai", "fixture-key");
      const registry = createProviderRegistry();
      registry.register(new XaiAdapter({
        keystore,
        fetchImpl: async () => new Response(
          'data: {"choices":[{"delta":{"content":"Olá"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      }));
      const store = createMemoryTranscriptStore();
      store.conversationStore!.ensureDefault("agent-a");
      const config = {
        snapshot: () => ({
          agents: [{ id: "agent-a", name: "Agent A", avatarId: "fixture", provider: "xai", model: "grok-4.6", runtimeMode: "lite" }],
          profile: {}, activeProvider: "xai", globalModel: "grok-4.6",
        }),
      };
      const gateway = new Gateway();
      const { runner } = registerRpcHandlers(gateway, {
        store,
        registry,
        keystore,
        config: config as never,
        homes: { inventory: async () => ({}) } as never,
        runtimeManager: { status: async () => ({ state: "lite-ready" }) } as never,
      });

      await expect(runner.kickstartAgent(kickstart())).resolves.toMatchObject({ accepted: true });
      await runner.flush("agent-a");
      expect(store.getKickstartRun?.("agent-a", "nonce-a")).toMatchObject({ status: "completed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("faz uma única execução concorrente, sem tools, transcript ou publicação", async () => {
    let calls = 0;
    let request: any;
    const published: unknown[] = [];
    const { runner, store } = fixtureRunner({
      async streamChat(next, emit) {
        calls += 1;
        request = next;
        emit({ type: "delta", delta: "Olá" });
      },
    }, { publish: (_channel: string, payload: unknown) => published.push(payload) });

    const [first, second] = await Promise.all([runner.kickstartAgent(kickstart()), runner.kickstartAgent(kickstart())]);
    await runner.flush("agent-a");

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(calls).toBe(1);
    expect(request.messages).toEqual([{ role: "user", content: KICKSTART_INTERNAL_PROMPT }]);
    expect(request.tools).toBeUndefined();
    expect(store.getEntries("agent-a")).toHaveLength(0);
    expect(published).toHaveLength(0);
    expect(store.getKickstartRun?.("agent-a", "nonce-a")).toMatchObject({ status: "completed", result: { text: "Olá" } });
  });

  it("marca partial como interrupted e nunca faz replay pelo mesmo nonce", async () => {
    let calls = 0;
    const { runner, store } = fixtureRunner({
      async streamChat(_request, emit) {
        calls += 1;
        emit({ type: "delta", delta: "parcial" });
        throw new Error("fixture disconnect");
      },
    });

    await runner.kickstartAgent(kickstart());
    await runner.flush("agent-a");
    const again = await runner.kickstartAgent(kickstart());
    expect(calls).toBe(1);
    expect(again.status).toBe("interrupted");
    expect(store.getKickstartRun?.("agent-a", "nonce-a")).toMatchObject({ status: "interrupted", observableOutput: true });
  });

  it("fence cancela kickstart enfileirado sem efeito tardio", async () => {
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { runner, store } = fixtureRunner({
      async streamChat() { calls += 1; await blocked; },
    });

    await runner.kickstartAgent(kickstart());
    const second = await runner.kickstartAgent(kickstart("agent-a", "nonce-b"));
    runner.fenceAgents(["agent-a"]);
    release();
    await runner.flush("agent-a");
    expect(calls).toBe(1);
    expect(store.getKickstartRun?.("agent-a", "nonce-a")?.status).toBe("cancelled");
    expect(store.getKickstartRun?.("agent-a", "nonce-b")?.status).toBe("cancelled");
    runner.releaseAgentFence(["agent-a"]);
  });

  it("reconcilia queued/running sem output após restart e preserva snapshot/clear", async () => {
    const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "openbot-p28-"));
    const path = join(root, "store.db");
    try {
      const first = new SqliteTranscriptStore({ path });
      first.claimKickstartRun({ agentId: "agent-a", clientNonce: "nonce-a", origin: "kickstart", version: 1, provider: "fixture", model: "fixture-model" });
      first.updateKickstartRun("agent-a", "nonce-a", { status: "running", turnId: "kickstart:crash" });
      first.close();

      const restarted = new SqliteTranscriptStore({ path });
      expect(restarted.getKickstartRun("agent-a", "nonce-a")).toMatchObject({ status: "retryable", attempt: 1 });
      const snapshot = restarted.snapshotAgent("agent-a");
      restarted.clear("agent-a");
      expect(restarted.getKickstartRun("agent-a", "nonce-a")).toBeUndefined();
      restarted.restoreAgent("agent-a", snapshot);
      expect(restarted.getKickstartRun("agent-a", "nonce-a")).toMatchObject({ status: "retryable" });
      restarted.updateKickstartRun("agent-a", "nonce-a", { result: { text: "é".repeat(4096) }, error: "é".repeat(4096) });
      const bounded = restarted.getKickstartRun("agent-a", "nonce-a")!;
      expect(Buffer.byteLength(bounded.result!.text, "utf8")).toBeLessThanOrEqual(4096);
      expect(Buffer.byteLength(bounded.error!, "utf8")).toBeLessThanOrEqual(2048);
      restarted.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
