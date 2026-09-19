import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { createMemoryTranscriptStore, TurnRunner } from "../src/rpc/send.js";
import { createProviderRegistry } from "../src/providers/router.js";
import { AttachmentStagingStore } from "../src/attachments/staging.js";

describe("durable prompt queue", () => {
  it("pins staged attachments until the pending request is removed and restores queue snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-queue-attachment-"));
    const store = new SqliteTranscriptStore({ path: join(root, "store.db") });
    try {
      const conversationId = store.conversationStore.ensureDefault("a").id;
      let now = Date.now();
      const staging = new AttachmentStagingStore({ db: store.databaseForSharedStores(), root: join(root, "staging"), nowFn: () => now });
      const attachment = await staging.stageBytes("a", { filename: "queued.txt", bytes: Buffer.from("retained"), conversationId });
      const args = { agentId: "a", conversationId, prompt: "file", clientNonce: "file", attachments: [{ path: `attachment:${attachment.id}`, name: "queued.txt" }] };
      store.promptQueue.put(args, { provider: "xai", model: "grok-4.6" });
      now += 60 * 60_000;
      expect(staging.expireDue()).toBe(0);
      expect(await staging.discard("a", attachment.id)).toBe(false);
      const snapshot = store.snapshotAgent("a");
      store.clear("a");
      expect(store.promptQueue.list("a")).toEqual([]);
      store.restoreAgent("a", snapshot);
      expect(store.promptQueue.list("a")).toHaveLength(1);
      expect(store.promptQueue.transition("a", conversationId, "file", "queued", "cancelled")).toBe(true);
      now += 2 * 24 * 60 * 60_000;
      expect(staging.expireDue()).toBe(1);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("acknowledges the second request before the first ends, cancels only the current turn and rejects stale cancellation", async () => {
    const store = createMemoryTranscriptStore();
    const conversationId = store.conversationStore!.ensureDefault("a").id;
    const registry = createProviderRegistry();
    const seen: string[] = [];
    registry.register({ name: "xai", async streamChat(request, emit) {
      const prompt = request.messages.at(-1)?.content;
      seen.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
      if (seen.length === 1) await new Promise<void>(resolve => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
      else emit({ type: "delta", delta: "done" });
    } });
    const runner = new TurnRunner({ store, registry });
    await runner.sendPrompt({ agentId: "a", conversationId, prompt: "first", clientNonce: "first" });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const first = runner.promptStatus("a");
    try {
      await expect(runner.sendPrompt({ agentId: "a", conversationId, prompt: "second", clientNonce: "second" })).resolves.toEqual({ accepted: true });
      expect(seen).toHaveLength(1);
      expect(runner.acceptanceStatus("a", "second", conversationId).outcome).toBe("found");
      expect(runner.promptStatus("a").queued).toHaveLength(1);
      expect(runner.cancelCurrentTurn("a", conversationId, first.turnId!).cancelled).toBe(true);
      await runner.flush("a");
      expect(seen).toHaveLength(2);
      expect(() => runner.cancelCurrentTurn("a", conversationId, first.turnId!)).toThrow(/turno mudou/);
      expect(runner.promptStatus("a").queued).toEqual([]);
    } finally { runner.cancelPrompt("a"); await runner.flush("a"); }
  });

  it("removes one waiting message without aborting the active response", async () => {
    const store = createMemoryTranscriptStore();
    const conversationId = store.conversationStore!.ensureDefault("a").id;
    const registry = createProviderRegistry();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let signal: AbortSignal | undefined;
    let calls = 0;
    registry.register({ name: "xai", async streamChat(request, emit) { calls++; signal = request.signal; await held; emit({ type: "delta", delta: "done" }); } });
    const runner = new TurnRunner({ store, registry });
    try {
      await runner.sendPrompt({ agentId: "a", conversationId, prompt: "first", clientNonce: "first" });
      await vi.waitFor(() => expect(calls).toBe(1));
      await runner.sendPrompt({ agentId: "a", conversationId, prompt: "remove", clientNonce: "remove" });
      runner.removeQueuedPrompt("a", conversationId, "remove");
      expect(signal?.aborted).toBe(false);
      expect(runner.promptStatus("a").queued).toEqual([]);
      release(); await runner.flush("a");
      expect(calls).toBe(1);
    } finally { release(); await runner.flush("a"); }
  });

  it("recovers pending requests after reopening SQLite, not running requests, and preserves idempotency", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-queue-"));
    const file = join(root, "store.db");
    let store = new SqliteTranscriptStore({ path: file });
    try {
      const conversationId = store.conversationStore.ensureDefault("a").id;
      const inference = { provider: "xai", model: "grok-4.6" };
      const args = { agentId: "a", conversationId, prompt: "recover", clientNonce: "recover" };
      store.promptQueue.put(args, inference);
      store.promptQueue.put(args, inference);
      expect(store.promptQueue.list("a")).toHaveLength(1);
      expect(() => store.promptQueue.put({ ...args, prompt: "different" }, inference)).toThrow(/different prompt/);
      store.promptQueue.put({ ...args, clientNonce: "already-started" }, inference);
      store.promptQueue.transition("a", conversationId, "already-started", "queued", "running");
      store.close(); store = new SqliteTranscriptStore({ path: file });
      expect(store.promptQueue.get("a", conversationId, "already-started")?.state).toBe("interrupted");
      const registry = createProviderRegistry(); let calls = 0;
      registry.register({ name: "xai", async streamChat(_request, emit) { calls++; emit({ type: "delta", delta: "recovered" }); } });
      const runner = new TurnRunner({ store, registry });
      runner.recoverQueuedPrompts(); runner.recoverQueuedPrompts(); await runner.flush("a");
      expect(calls).toBe(1);
      expect(store.getEntries("a", conversationId).filter(entry => entry.kind === "message" && entry.role === "user")).toHaveLength(1);
      await runner.sendPrompt(args); await runner.flush("a"); expect(calls).toBe(1);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});