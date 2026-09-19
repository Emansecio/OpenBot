import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteTranscriptStore } from "../src/store/index.js";

const DAY_MS = 24 * 60 * 60_000;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore(): { store: SqliteTranscriptStore; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "openbot-memory-job-retention-"));
  roots.push(root);
  const dbPath = join(root, "store.db");
  return { store: new SqliteTranscriptStore({ path: dbPath }), dbPath };
}

function completeJob(
  store: SqliteTranscriptStore,
  input: {
    id: string;
    agentId: string;
    conversationId: string;
    throughSequenceId: number;
    nowMs: number;
    summaryRequested?: boolean;
    memoryRequested?: boolean;
  },
) {
  const job = store.memoryStore.enqueueJob({
    ...input,
    provider: "xai",
    model: "grok-4.6",
    fromSequenceId: 0,
    summaryRequested: input.summaryRequested ?? false,
    memoryRequested: input.memoryRequested ?? true,
  });
  expect(store.memoryStore.claimJob(input.agentId, job.id, input.nowMs)).not.toBeNull();
  return store.memoryStore.completeJob(input.agentId, job.id, input.nowMs);
}

function deadJob(
  store: SqliteTranscriptStore,
  input: { id: string; agentId: string; conversationId: string; throughSequenceId: number; nowMs: number },
) {
  const job = store.memoryStore.enqueueJob({
    ...input,
    provider: "xai",
    model: "grok-4.6",
    fromSequenceId: 0,
    summaryRequested: false,
    memoryRequested: true,
  });
  expect(store.memoryStore.claimJob(input.agentId, job.id, input.nowMs)).not.toBeNull();
  return store.memoryStore.deadJob(input.agentId, job.id, { code: "fixture_dead" }, input.nowMs);
}

describe("memory job retention", () => {
  it("keeps each conversation's highest completed memory boundary through global cleanup and restart", () => {
    const { store, dbPath } = createStore();
    let reopened: SqliteTranscriptStore | undefined;
    const oldAt = 1;
    const cleanupAt = 8 * DAY_MS;
    const conversationA = store.conversationStore.create("agent-a", { title: "A principal" }).id;
    const conversationAOther = store.conversationStore.create("agent-a", { title: "A outra" }).id;
    const conversationB = store.conversationStore.create("agent-b", { title: "B principal" }).id;

    try {
      const memoryCheckpoint = completeJob(store, {
        id: "memory-a-keep",
        agentId: "agent-a",
        conversationId: conversationA,
        throughSequenceId: 20,
        nowMs: oldAt,
      });
      const obsoleteMemory = completeJob(store, {
        id: "memory-a-old",
        agentId: "agent-a",
        conversationId: conversationA,
        throughSequenceId: 10,
        nowMs: oldAt,
      });
      const summaryOnly = completeJob(store, {
        id: "summary-a-newer",
        agentId: "agent-a",
        conversationId: conversationA,
        throughSequenceId: 30,
        nowMs: oldAt + 1,
        summaryRequested: true,
        memoryRequested: false,
      });
      const obsoleteDead = deadJob(store, {
        id: "dead-a-old",
        agentId: "agent-a",
        conversationId: conversationA,
        throughSequenceId: 5,
        nowMs: oldAt,
      });
      const otherConversationCheckpoint = completeJob(store, {
        id: "memory-a-other-keep",
        agentId: "agent-a",
        conversationId: conversationAOther,
        throughSequenceId: 7,
        nowMs: oldAt,
      });
      const otherAgentCheckpoint = completeJob(store, {
        id: "memory-b-keep",
        agentId: "agent-b",
        conversationId: conversationB,
        throughSequenceId: 8,
        nowMs: oldAt,
      });

      const trigger = store.memoryStore.enqueueJob({
        id: "cleanup-trigger",
        agentId: "agent-b",
        conversationId: conversationB,
        provider: "xai",
        model: "grok-4.6",
        fromSequenceId: 9,
        throughSequenceId: 9,
        nowMs: cleanupAt,
      });

      expect(store.memoryStore.getJob("agent-a", memoryCheckpoint!.id)).toMatchObject({
        status: "complete",
        throughSequenceId: 20,
        memoryRequested: true,
      });
      expect(store.memoryStore.getJob("agent-a", obsoleteMemory!.id)).toBeNull();
      expect(store.memoryStore.getJob("agent-a", summaryOnly!.id)).toBeNull();
      expect(store.memoryStore.getJob("agent-a", obsoleteDead!.id)).toBeNull();
      expect(store.memoryStore.getJob("agent-a", otherConversationCheckpoint!.id)).toMatchObject({ status: "complete" });
      expect(store.memoryStore.getJob("agent-b", otherAgentCheckpoint!.id)).toMatchObject({ status: "complete" });
      expect(store.memoryStore.getJob("agent-b", trigger.id)).toMatchObject({ status: "pending" });
      store.close();

      reopened = new SqliteTranscriptStore({ path: dbPath });
      expect(reopened.memoryStore.getLatestCompletedJobBoundary("agent-a", conversationA, "memory")).toBe(20);
      expect(reopened.memoryStore.getLatestCompletedJobBoundary("agent-a", conversationA, "summary")).toBeNull();
      expect(reopened.memoryStore.getLatestCompletedJobBoundary("agent-a", conversationAOther, "memory")).toBe(7);
      expect(reopened.memoryStore.getLatestCompletedJobBoundary("agent-b", conversationB, "memory")).toBe(8);

      const memoryBoundary = reopened.memoryStore.getLatestCompletedJobBoundary("agent-a", conversationA, "memory") ?? -1;
      const next = reopened.memoryStore.enqueueJob({
        id: "memory-a-next",
        agentId: "agent-a",
        conversationId: conversationA,
        provider: "xai",
        model: "grok-4.6",
        fromSequenceId: memoryBoundary + 1,
        throughSequenceId: 22,
        nowMs: cleanupAt + 1,
      });
      expect(next).toMatchObject({ fromSequenceId: 21, throughSequenceId: 22, memoryRequested: true });

      reopened.conversationStore.delete("agent-a", conversationA, { memoryPolicy: "delete-derived" });
      expect(reopened.memoryStore.getJob("agent-a", memoryCheckpoint!.id)).toBeNull();
      expect(reopened.memoryStore.getJob("agent-a", next.id)).toBeNull();
      expect(reopened.memoryStore.getLatestCompletedJobBoundary("agent-a", conversationA, "memory")).toBeNull();
      expect(reopened.memoryStore.getJob("agent-a", otherConversationCheckpoint!.id)).toMatchObject({ status: "complete" });
      expect(reopened.memoryStore.getJob("agent-b", otherAgentCheckpoint!.id)).toMatchObject({ status: "complete" });
    } finally {
      reopened?.close();
      store.close();
    }
  });

  it("keeps the batch-100 cleanup bound while retaining the memory checkpoint", () => {
    const { store } = createStore();
    const oldAt = 1;
    const cleanupAt = 8 * DAY_MS;
    const conversationId = store.conversationStore.create("agent-a", { title: "Batch" }).id;
    try {
      const keeper = completeJob(store, {
        id: "memory-batch-keeper",
        agentId: "agent-a",
        conversationId,
        throughSequenceId: 999,
        nowMs: oldAt,
      });
      const obsolete: string[] = [];
      for (let index = 0; index < 105; index += 1) {
        const id = `dead-batch-${index}`;
        obsolete.push(id);
        deadJob(store, {
          id,
          agentId: "agent-a",
          conversationId,
          throughSequenceId: index,
          nowMs: oldAt,
        });
      }
      store.memoryStore.enqueueJob({
        id: "batch-cleanup-trigger",
        agentId: "agent-a",
        conversationId,
        provider: "xai",
        model: "grok-4.6",
        fromSequenceId: 1000,
        throughSequenceId: 1000,
        nowMs: cleanupAt,
      });

      const jobs = store.memoryStore.listJobs("agent-a", { limit: 1000 });
      expect(store.memoryStore.getJob("agent-a", keeper!.id)).toMatchObject({ status: "complete", throughSequenceId: 999 });
      expect(jobs.filter((job) => job.status === "dead")).toHaveLength(5);
      expect(obsolete.filter((id) => store.memoryStore.getJob("agent-a", id) === null)).toHaveLength(100);
    } finally {
      store.close();
    }
  });
});
