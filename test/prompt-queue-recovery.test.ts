import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { createMemoryTranscriptStore, TurnRunner, MAX_SEND_QUEUE_PER_AGENT } from "../src/rpc/send.js";
import { createProviderRegistry } from "../src/providers/router.js";
import { AgentActivityStore } from "../src/rpc/activity.js";
import { promptPayloadDigest } from "../src/store/prompt-queue.js";
import { migrateOpenBotSchema } from "../src/store/schema.js";

describe("prompt queue recovery and retention", () => {
  it.each([false, true])("releases cancelled slots once and reconciles activity (replacement=%s)", async replacement => {
    const store = createMemoryTranscriptStore();
    const conversationId = store.conversationStore!.ensureDefault("a").id;
    const registry = createProviderRegistry();
    const activity = new AgentActivityStore();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const seen: string[] = [];
    registry.register({ name: "xai", async streamChat(request, emit) {
      const prompt = request.messages.at(-1)?.content;
      seen.push(typeof prompt === "string" ? prompt : "");
      if (seen.length === 1) await held;
      emit({ type: "delta", delta: "done" });
    } });
    const runner = new TurnRunner({ store, registry, activity });
    try {
      await runner.sendPrompt({ agentId: "a", conversationId, prompt: "first", clientNonce: "first" });
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      await Promise.all(Array.from({ length: MAX_SEND_QUEUE_PER_AGENT - 1 }, (_, i) =>
        runner.sendPrompt({ agentId: "a", conversationId, prompt: `pending-${i}`, clientNonce: `pending-${i}` })));
      for (let i = 0; i < MAX_SEND_QUEUE_PER_AGENT - 1; i++) {
        runner.removeQueuedPrompt("a", conversationId, `pending-${i}`);
        runner.removeQueuedPrompt("a", conversationId, `pending-${i}`);
      }
      expect(runner.promptStatus("a").queued).toEqual([]);
      expect(runner.promptStatus("a").isBusy).toBe(true);
      expect(activity.get("a").isRunning).toBe(true);
      if (replacement) await runner.sendPrompt({ agentId: "a", conversationId, prompt: "replacement", clientNonce: "replacement" });
      release(); await runner.flush("a");
      expect(seen).toEqual(replacement ? ["first", "replacement"] : ["first"]);
      expect(runner.promptStatus("a").isBusy).toBe(false);
      expect(activity.get("a").isRunning).toBe(false);
      expect(runner.getStatus().runningTurns).toBe(0);
    } finally { release(); await runner.flush("a"); }
  });

  it.each(["memory", "sqlite"] as const)("preserves failed preparation for explicit revision with exactly-once acceptance (%s)", async kind => {
    const store = kind === "sqlite" ? new SqliteTranscriptStore({ path: ":memory:" }) : createMemoryTranscriptStore();
    const conversationId = store.conversationStore!.ensureDefault("a").id;
    const registry = createProviderRegistry();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    registry.register({ name: "xai", async streamChat(_request, emit) { calls++; if (calls === 1) await held; emit({ type: "delta", delta: "done" }); } });
    const runner = new TurnRunner({ store, registry, readAttachments: async (_agent, attachments) =>
      attachments?.length ? [{ name: "missing.txt", path: "missing.txt", skipped: "not_found" }] : [] });
    const args = { agentId: "a", conversationId, prompt: "preserve this", clientNonce: "failed", attachments: [{ name: "missing.txt", path: "missing.txt" }] };
    try {
      await runner.sendPrompt({ agentId: "a", conversationId, prompt: "first", clientNonce: "first" });
      await runner.sendPrompt(args);
      release(); await runner.flush("a");
      expect(calls).toBe(1);
      expect(store.promptQueue!.get("a", conversationId, "failed")).toMatchObject({ state: "interrupted", compacted: false, args });
      expect(runner.promptStatus("a").recoverable).toMatchObject([{ clientNonce: "failed", canReview: true }]);
      expect(runner.getQueuedPrompt("a", conversationId, "failed")).toEqual(args);
      const revised = { ...args, clientNonce: "revision", prompt: "revised text", attachments: [] };
      expect(runner.reviseQueuedPrompt(revised, "failed")).toEqual({ accepted: true });
      expect(runner.reviseQueuedPrompt(revised, "failed")).toEqual({ accepted: true });
      await runner.flush("a");
      expect(calls).toBe(2);
      expect(store.promptQueue!.get("a", conversationId, "failed")).toMatchObject({ state: "cancelled", compacted: true });
      expect(store.promptQueue!.get("a", conversationId, "revision")).toMatchObject({ state: "completed", compacted: true, recoveryOf: "failed" });
      expect(runner.reviseQueuedPrompt(revised, "failed")).toEqual({ accepted: true });
      expect(() => runner.reviseQueuedPrompt({ ...revised, prompt: "different" }, "failed")).toThrow(/nonce/i);
      expect(() => runner.reviseQueuedPrompt({ ...revised, clientNonce: "second-revision" }, "failed")).toThrow(/revisão/);
      const userEntries = store.getEntries("a", conversationId).filter(entry => entry.kind === "message" && entry.role === "user");
      expect(userEntries.map(entry => entry.kind === "message" ? entry.content : "")).toEqual(["first", "revised text"]);
      expect(runner.promptStatus("a").recoverable).toEqual([]);
    } finally { release(); await runner.flush("a"); if (store instanceof SqliteTranscriptStore) store.close(); }
  });

  it("retains interrupted payloads across reopen and compacts terminal payloads without losing nonce/snapshot identity", () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-queue-retention-"));
    const file = join(root, "store.db");
    let store = new SqliteTranscriptStore({ path: file });
    try {
      const conversationId = store.conversationStore.ensureDefault("a").id;
      const args = { agentId: "a", conversationId, prompt: "x".repeat(200_000), clientNonce: "terminal" };
      const inference = { provider: "xai", model: "fixture" };
      store.promptQueue.put(args, inference);
      store.promptQueue.transition("a", conversationId, "terminal", "queued", "cancelled");
      store.promptQueue.put({ ...args, clientNonce: "interrupted" }, inference);
      store.promptQueue.transition("a", conversationId, "interrupted", "queued", "interrupted");
      const compacted = store.promptQueue.get("a", conversationId, "terminal")!;
      expect(compacted.digest).toBe(promptPayloadDigest(args));
      expect(JSON.stringify(compacted).length).toBeLessThan(1000);
      const snapshot = store.snapshotAgent("a");
      store.clear("a"); store.restoreAgent("a", snapshot);
      store.close(); store = new SqliteTranscriptStore({ path: file });
      expect(store.promptQueue.put(args, inference)).toMatchObject({ state: "cancelled", compacted: true, digest: compacted.digest });
      expect(() => store.promptQueue.put({ ...args, prompt: "other" }, inference)).toThrow(/different prompt/);
      expect(store.promptQueue.get("a", conversationId, "interrupted")?.args.prompt).toHaveLength(200_000);
      expect(store.promptQueue.list("a")).toEqual([]);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses draft replay once an interrupted turn has persisted its user echo", () => {
    const store = createMemoryTranscriptStore();
    const conversationId = store.conversationStore!.ensureDefault("a").id;
    const args = { agentId: "a", conversationId, prompt: "already started", clientNonce: "started" };
    store.promptQueue!.put(args, { provider: "xai", model: "fixture" });
    store.promptQueue!.transition("a", conversationId, "started", "queued", "interrupted");
    store.append("a", [{ kind: "message", id: "user:started", timestampMs: 1, role: "user", content: args.prompt, clientNonce: args.clientNonce }], conversationId);
    const runner = new TurnRunner({ store });
    expect(runner.promptStatus("a").recoverable).toMatchObject([{ canReview: false }]);
    expect(() => runner.getQueuedPrompt("a", conversationId, "started")).toThrow(/já iniciou/);
    expect(() => runner.reviseQueuedPrompt({ ...args, clientNonce: "replay" }, "started")).toThrow(/já iniciou/);
    expect(store.promptQueue!.get("a", conversationId, "replay")).toBeUndefined();
    const snapshot = runner.promptStatuses(["a", "b"]);
    expect(snapshot.agents.map(item => item.agentId)).toEqual(["a", "b"]);
    expect(snapshot.isBusy).toBe(false);
  });

  it("migrates v18 completed-without-echo failures into recoverable jobs before compacting legacy terminals", () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      const conversationId = store.conversationStore.ensureDefault("a").id;
      const db = store.databaseForSharedStores();
      for (const nonce of ["failed", "completed"]) {
        store.promptQueue.put({ agentId: "a", conversationId, prompt: `payload-${nonce}`, clientNonce: nonce }, { provider: "xai", model: "fixture" });
      }
      store.append("a", [{ kind: "message", id: "echo:completed", timestampMs: 1, role: "user", content: "payload-completed", clientNonce: "completed" }], conversationId);
      db.prepare("UPDATE prompt_queue SET state='completed',payload_digest=''").run();
      db.pragma("user_version = 18");
      migrateOpenBotSchema(db);
      expect(db.pragma("user_version", { simple: true })).toBe(19);
      expect(store.promptQueue.get("a", conversationId, "failed")).toMatchObject({ state: "interrupted", compacted: false });
      expect(store.promptQueue.compactTerminal()).toBe(1);
      expect(store.promptQueue.get("a", conversationId, "failed")?.args.prompt).toBe("payload-failed");
      expect(store.promptQueue.get("a", conversationId, "completed")).toMatchObject({ state: "completed", compacted: true });
    } finally { store.close(); }
  });

  it("rolls back a rejected replacement without compacting or consuming the recoverable original", () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      const conversationId = store.conversationStore.ensureDefault("a").id;
      const args = { agentId: "a", conversationId, prompt: "preserved", clientNonce: "original" };
      store.promptQueue.put(args, { provider: "xai", model: "fixture" });
      store.promptQueue.transition("a", conversationId, "original", "queued", "interrupted");
      expect(() => store.promptQueue.revise("a", conversationId, "original", { ...args, clientNonce: "new", attachments: [{ name: "missing.txt", path: "attachment:missing" }] })).toThrow(/unavailable/);
      expect(store.promptQueue.get("a", conversationId, "new")).toBeUndefined();
      expect(store.promptQueue.get("a", conversationId, "original")).toMatchObject({ state: "interrupted", compacted: false, args });
    } finally { store.close(); }
  });

});
