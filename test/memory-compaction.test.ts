
import { describe, expect, it } from "vitest";
import { buildReflectionRequestPayload, projectReflectionExistingMemory, planReflectionJob } from "../src/memory/context.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { createTurnRunner } from "../src/rpc/send.js";
import { createProviderRegistry } from "../src/providers/router.js";
import { createFakeAdapter } from "./mocks/fake-provider-adapter.js";
import { USER_PROFILE_AGENT_ID } from "../src/memory/types.js";

function createTranscriptStore(): SqliteTranscriptStore {
  return new SqliteTranscriptStore({ path: ":memory:" });
}


describe("memory context integration", () => {

  it("decouples conversation compaction from durable-memory mode", () => {
    expect(planReflectionJob("off", { temporary: false }, "continue", true)).toEqual({
      summaryRequested: true,
      memoryRequested: false,
    });
    expect(planReflectionJob("automatic", { temporary: false }, "continue", false)).toEqual({
      summaryRequested: false,
      memoryRequested: true,
    });
    expect(planReflectionJob("explicit", { temporary: false }, "continue", false)).toBeNull();
    expect(planReflectionJob("explicit", { temporary: false }, "remember this", false)).toEqual({
      summaryRequested: false,
      memoryRequested: true,
    });
    expect(planReflectionJob("automatic", { temporary: true }, "remember this", true)).toBeNull();
  });

  it("queues summary-only compaction under mode off after enough unsummarized transcript entries", async () => {
    const store = createTranscriptStore();
    const conversationId = store.conversationStore.create("agent-a").id;
    store.memoryStore.setSettings("agent-a", "off");
    store.append("agent-a", Array.from({ length: 39 }, (_, index) => ({
      kind: "message" as const,
      id: `history-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `histórico ${index}`,
      timestampMs: index + 1,
    })), conversationId);
    const registry = createProviderRegistry();
    registry.register(createFakeAdapter("xai", { deltas: ["ok"] }));
    const runner = createTurnRunner({ registry, store });

    runner.sendPrompt({ agentId: "agent-a", prompt: "continue", conversationId });
    await runner.flush("agent-a");

    expect(store.memoryStore.listJobs("agent-a", { limit: 10 })).toEqual([
      expect.objectContaining({ summaryRequested: true, memoryRequested: false, status: "pending" }),
    ]);
    expect(store.memoryStore.listMemories("agent-a")).toEqual([]);
    store.close();
  });

  it.each([false, true])("ignores global sequence gaps with previous summary=%s and still compacts at the local threshold", async (previousSummary) => {
    const store = createTranscriptStore();
    try {
      const conversationId = store.conversationStore.create("agent-a").id;
      const entry = (id: string) => ({ kind: "message" as const, id, role: "user" as const, content: "short", timestampMs: 1 });
      store.memoryStore.setSettings("agent-a", "off");
      if (previousSummary) {
        store.append("agent-a", [entry("old")], conversationId);
        store.memoryStore.upsertSummary("agent-a", {
          conversationId, throughSequenceId: store.getLatestSequenceId("agent-a", conversationId)!,
          summaryJson: {}, renderedText: "previous", updatedAtMs: 1,
        });
      }
      for (const otherAgent of ["agent-a", "agent-b"]) {
        const other = store.conversationStore.create(otherAgent).id;
        store.append(otherAgent, Array.from({ length: 80 }, (_, i) => entry(`other-${i}`)), other);
      }
      store.conversationStore.activate("agent-a", conversationId);
      const registry = createProviderRegistry();
      registry.register(createFakeAdapter("xai", { deltas: ["ok"] }));
      const runner = createTurnRunner({ registry, store });
      runner.sendPrompt({ agentId: "agent-a", prompt: "continue", conversationId });
      await runner.flush("agent-a");
      expect(store.memoryStore.listJobs("agent-a")).toEqual([]);
      store.append("agent-a", Array.from({ length: 35 }, (_, i) => entry(`local-${i}`)), conversationId);
      runner.sendPrompt({ agentId: "agent-a", prompt: "below threshold", conversationId });
      await runner.flush("agent-a");
      expect(store.memoryStore.listJobs("agent-a")).toEqual([]);
      runner.sendPrompt({ agentId: "agent-a", prompt: "threshold", conversationId });
      await runner.flush("agent-a");
      expect(store.memoryStore.listJobs("agent-a")).toEqual([
        expect.objectContaining({ summaryRequested: true, memoryRequested: false }),
      ]);
    } finally { store.close(); }
  });

  it("still queues summary-only work under context pressure below the entry threshold", async () => {
    const store = createTranscriptStore();
    try {
      const conversationId = store.conversationStore.create("agent-a").id;
      store.memoryStore.setSettings("agent-a", "off");
      store.append("agent-a", [
        { kind: "message", id: "large-user", role: "user", content: "x".repeat(100_000), timestampMs: 1 },
        { kind: "message", id: "large-assistant", role: "assistant", content: "y".repeat(100_000), timestampMs: 2 },
      ], conversationId);
      const registry = createProviderRegistry();
      registry.register(createFakeAdapter("xai", { deltas: ["ok"] }));
      const runner = createTurnRunner({ registry, store, resolveProvider: () => ({ provider: "xai", model: "unknown" }) });
      runner.sendPrompt({ agentId: "agent-a", prompt: "continue", conversationId });
      await runner.flush("agent-a");
      expect(store.memoryStore.listJobs("agent-a")).toEqual([
        expect.objectContaining({ summaryRequested: true, memoryRequested: false }),
      ]);
    } finally { store.close(); }
  });

  it("creates memory-synthesis jobs only on explicit intent in explicit mode and never for temporary conversations", async () => {
    const store = createTranscriptStore();
    const explicitConversation = store.conversationStore.create("agent-a").id;
    const temporaryConversation = store.conversationStore.create("agent-a", { temporary: true }).id;
    store.conversationStore.activate("agent-a", explicitConversation);
    store.memoryStore.setSettings("agent-a", "explicit");
    const registry = createProviderRegistry();
    registry.register(createFakeAdapter("xai", { deltas: ["ok"] }));
    const runner = createTurnRunner({ registry, store });

    runner.sendPrompt({ agentId: "agent-a", prompt: "responda normalmente", conversationId: explicitConversation });
    await runner.flush("agent-a");
    expect(store.memoryStore.listJobs("agent-a")).toHaveLength(0);

    runner.sendPrompt({ agentId: "agent-a", prompt: "remember this preference for next time", conversationId: explicitConversation });
    await runner.flush("agent-a");
    expect(store.memoryStore.listJobs("agent-a")).toEqual([
      expect.objectContaining({ summaryRequested: false, memoryRequested: true }),
    ]);

    store.conversationStore.activate("agent-a", temporaryConversation);
    runner.sendPrompt({ agentId: "agent-a", prompt: "remember this too", conversationId: temporaryConversation });
    await runner.flush("agent-a");
    expect(store.memoryStore.listJobs("agent-a")).toHaveLength(1);
    store.close();
  });

  it("includes existingMemories with editable flags in reflection payloads", () => {
    const store = createTranscriptStore();
    const conversationId = store.conversationStore.create("agent-a").id;
    const otherConversation = store.conversationStore.create("agent-a").id;
    store.memoryStore.upsertMemory("agent-a", {
      kind: "fact",
      canonicalKey: "editable-fact",
      text: "derived from the current conversation",
      trust: "external_observation",
      sourceConversationId: conversationId,
    }, { kind: "admin" });
    store.memoryStore.upsertMemory("agent-a", {
      kind: "constraint",
      canonicalKey: "pinned-constraint",
      text: "pinned project rule",
      trust: "external_observation",
      pinned: true,
      sourceConversationId: conversationId,
    }, { kind: "admin" });
    store.memoryStore.upsertMemory("agent-a", {
      kind: "preference",
      canonicalKey: "foreign-preference",
      text: "belongs to another conversation",
      trust: "external_observation",
      sourceConversationId: otherConversation,
    }, { kind: "admin" });

    const payload = buildReflectionRequestPayload({
      agentId: "agent-a",
      conversationId,
      provider: "xai",
      model: "grok-4.6",
      fromSequenceId: 0,
      throughSequenceId: 1,
      entries: [{ kind: "message", role: "user", content: "hello" }],
      existingMemories: store.memoryStore.listMemories("agent-a", { limit: 24 })
        .map((memory) => projectReflectionExistingMemory(memory, conversationId)),
    });

    expect(payload.existingMemories).toHaveLength(3);
    expect(payload.existingMemories?.find((memory) => memory.canonicalKey === "pinned-constraint")).toMatchObject({
      pinned: true,
      editable: false,
    });
    expect(payload.existingMemories?.find((memory) => memory.canonicalKey === "editable-fact")).toMatchObject({
      pinned: false,
      editable: true,
    });
    expect(payload.existingMemories?.find((memory) => memory.canonicalKey === "foreign-preference")).toMatchObject({
      pinned: false,
      editable: false,
    });
    store.close();
  });

  it.each([65_536, 32_768, 4_096])("bounds the complete reflection payload with a large shared profile at %i bytes", (limit) => {
    const store = createTranscriptStore();
    try {
      const conversationId = store.conversationStore.create("agent-a").id;
      for (let index = 0; index < 6; index++) {
        store.memoryStore.upsertMemory(USER_PROFILE_AGENT_ID, {
          kind: "preference", canonicalKey: `style-${index}`,
          text: 'Preferência de estilo: "exemplos e explicações". '.repeat(260), trust: "user",
        }, { kind: "user" });
      }
      const userProfile = store.memoryStore.listMemories(USER_PROFILE_AGENT_ID, { automatic: true })
        .map(({ canonicalKey, kind, text }) => ({ canonicalKey, kind, text }));
      const input = {
        agentId: "agent-a", conversationId, provider: "xai", model: "fixture",
        fromSequenceId: 2, throughSequenceId: 3, summaryRequested: true, memoryRequested: false,
        previousSummary: { revision: 1, throughSequenceId: 1, summaryJson: { state: '"\\'.repeat(3_000) }, renderedText: '"\\'.repeat(3_000) },
        userProfile,
        entries: [{ kind: "message", id: "new-2", role: "user", content: "Vamos continuar." }, { kind: "message", id: "new-3", role: "user", content: "Estado atual." }],
      };
      for (const entrySequenceIds of [undefined, [2, 3]]) {
        const payload = buildReflectionRequestPayload({ ...input, entrySequenceIds }, limit);
        expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThanOrEqual(limit);
        expect(payload.entries.length).toBeGreaterThan(0);
        expect(payload.userProfile?.length).toBeGreaterThan(0);
      }
      expect(store.memoryStore.listMemories(USER_PROFILE_AGENT_ID)[0]?.text.length).toBeGreaterThan(10_000);
    } finally { store.close(); }
  });

  it("defers whole long messages and never advances coverage over an oversized entry", () => {
    const first = { kind: "message", id: "long-1", role: "user", content: "Contexto do projeto. ".repeat(700) + " MARCADOR_FINAL_731" };
    const second = { ...first, id: "long-2", content: first.content + "🧭".repeat(2_000) };
    const input = {
      agentId: "agent-a", conversationId: "conversation-a", provider: "xai", model: "fixture",
      fromSequenceId: 1, throughSequenceId: 2, summaryRequested: true, memoryRequested: false,
      entries: [first, second], entrySequenceIds: [1, 2],
    };
    const payload = buildReflectionRequestPayload(input, 32_768);
    expect(payload.throughSequenceId).toBe(1);
    expect(payload.deferredThroughSequenceId).toBe(2);
    expect(payload.entries).toContainEqual(expect.objectContaining({ id: first.id, content: first.content }));
    expect(payload.entries.some((entry) => (entry as { id?: string }).id === second.id)).toBe(false);
    const next = buildReflectionRequestPayload({ ...input, fromSequenceId: 2, entries: [second], entrySequenceIds: [2] }, 32_768);
    expect(next.throughSequenceId).toBe(2);
    expect(next.entries).toContainEqual(expect.objectContaining({ id: second.id, content: second.content }));
    expect(() => buildReflectionRequestPayload({ ...input, entries: [{ ...first, content: first.content.repeat(6) }], entrySequenceIds: [1] }, 32_768))
      .toThrow(/entrada.*limite/);
  });

  it("drops absolute attachment paths from reflection projections while keeping basename and untrusted text", () => {
    const payload = buildReflectionRequestPayload({
      agentId: "agent-a",
      conversationId: "conversation-a",
      provider: "xai",
      model: "grok-4.6",
      fromSequenceId: 0,
      throughSequenceId: 2,
      summaryRequested: true,
      memoryRequested: false,
      previousSummary: {
        revision: 3,
        throughSequenceId: 1,
        summaryJson: { sentinel: "A" },
        renderedText: "SENTINELA_A",
      },
      expectedPreviousRevision: 3,
      entries: [{
        kind: "user-attachment",
        id: "attachment-1",
        file_name: "arquivo-1.txt",
        file_path: "C:\\Users\\Thiago\\Documents\\arquivo-1.txt",
        extractedText: `anexo ${"A".repeat(10_000)}`,
      }],
    });

    const attachment = payload.entries.find((entry) => (
      typeof entry === "object" && entry !== null && (entry as { kind?: unknown }).kind === "user-attachment"
    )) as { file_name?: string; file_path?: string; extractedText?: string; untrusted?: boolean; truncated?: boolean } | undefined;

    expect(attachment).toBeDefined();
    expect(attachment?.file_name).toBe("arquivo-1.txt");
    expect(attachment?.file_path).toBeUndefined();
    expect(attachment?.untrusted).toBe(true);
    expect(attachment?.truncated).toBe(true);
    expect(attachment?.extractedText).toContain("anexo");
    expect(payload.previousSummary).toMatchObject({ revision: 3, throughSequenceId: 1, renderedText: "SENTINELA_A" });
    expect(payload.expectedPreviousRevision).toBe(3);
    expect(payload.transcriptFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(payload)).not.toContain("C:\\\\Users\\\\Thiago");
  });
});
