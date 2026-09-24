import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryReflectionWorker, type MemoryReflectionInput } from "../src/memory/reflection.js";
import { createReflectionTranscriptFingerprint } from "../src/memory/context.js";
import type { MemoryJob } from "../src/memory/types.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { TempRoots } from "./helpers/temp-roots.js";

const workers: MemoryReflectionWorker[] = [];
const stores: SqliteTranscriptStore[] = [];
const temp = new TempRoots();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  for (const store of stores.splice(0)) store.close();
  await temp.cleanup();
  const timerCount = vi.getTimerCount();
  vi.restoreAllMocks();
  vi.useRealTimers();
  assert.equal(timerCount, 0, "memory worker must not leak timers");
});

function fixture(recover = true) {
  const transcript = new SqliteTranscriptStore({ path: ":memory:" });
  stores.push(transcript);
  const store = transcript.memoryStore;
  const conversationId = transcript.conversationStore.create("agent-a").id;
  const input = {
    agentId: "agent-a", conversationId, provider: "xai", model: "fixture",
    fromSequenceId: 0, throughSequenceId: 1, entries: [],
  };
  const reflect = vi.fn(() => ({ operations: [] }));
  const worker = new MemoryReflectionWorker({
    store, reflect,
    ...(recover ? { loadInput: (job: Parameters<typeof store.enqueueJob>[0]) => ({ ...input, ...job }) } : {}),
  });
  workers.push(worker);
  return { transcript, store, input, reflect, worker };
}

describe("memory worker storage resilience", () => {
  it("does not steal a running job from a live worker sharing SQLite", async () => {
    const root = join(tmpdir(), `openbot-memory-worker-${randomUUID()}`);
    temp.track(root);
    const first = new SqliteTranscriptStore({ path: join(root, "store.db") });
    stores.push(first);
    const agentId = "agent-a";
    const conversationId = first.conversationStore.create(agentId).id;
    const input = {
      agentId, conversationId, provider: "xai", model: "fixture",
      fromSequenceId: 0, throughSequenceId: 1, entries: [],
    };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const firstReflect = vi.fn(async () => { await held; return { operations: [] }; });
    const firstWorker = new MemoryReflectionWorker({ store: first.memoryStore, reflect: firstReflect });
    workers.push(firstWorker);
    const job = firstWorker.enqueue(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(firstReflect).toHaveBeenCalledTimes(1);

    const second = new SqliteTranscriptStore({ path: join(root, "store.db") });
    stores.push(second);
    const secondReflect = vi.fn(() => ({ operations: [] }));
    const secondWorker = new MemoryReflectionWorker({
      store: second.memoryStore,
      reflect: secondReflect,
      loadInput: current => ({ ...input, ...current }),
    });
    workers.push(secondWorker);
    expect(secondWorker.recoverAbandonedJobs()).toBe(0);
    secondWorker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(secondReflect).not.toHaveBeenCalled();
    expect(second.memoryStore.getJob(agentId, job.id!)).toMatchObject({ status: "running", attempts: 1 });

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.memoryStore.getJob(agentId, job.id!)).toMatchObject({ status: "complete", attempts: 1 });
    await firstWorker.close();
    await secondWorker.close();
    first.close();
    second.close();
  });

  it.each(["scan", "deadline"])("recovers a transient %s read and honors the durable retry deadline", async phase => {
    const { store, input, reflect, worker } = fixture();
    const job = store.enqueueJob({ ...input, nextAttemptAtMs: 1_250 });
    const original = store.listRunnableJobs.bind(store);
    let failed = false;
    const scan = vi.spyOn(store, "listRunnableJobs").mockImplementation((now, limit) => {
      if (!failed && (phase === "scan" ? now === undefined : now === Number.MAX_SAFE_INTEGER)) {
        failed = true;
        throw new Error("apiKey=fixture-sensitive-read-error");
      }
      return original(now, limit);
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toBe(true);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("fixture-sensitive");
    const calls = scan.mock.calls.length;
    for (let index = 0; index < 20; index++) worker.start();
    await vi.advanceTimersByTimeAsync(99);
    expect(scan).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(1);
    expect(scan.mock.calls.length).toBeGreaterThan(calls);
    await vi.advanceTimersByTimeAsync(149);
    expect(reflect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(store.getJob(input.agentId, job.id)).toMatchObject({ status: "complete", attempts: 1 });
  });

  it("bounds repeated storage failures and cancels their timer on close", async () => {
    const { store, worker } = fixture();
    const scan = vi.spyOn(store, "listRunnableJobs").mockImplementation(() => { throw new Error("store unavailable"); });
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    let count = 1;
    for (const delay of [100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000]) {
      worker.start();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(scan).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(scan).toHaveBeenCalledTimes(++count);
      expect(vi.getTimerCount()).toBe(1);
    }
    await worker.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(scan).toHaveBeenCalledTimes(count);
  });

  it.each([false, true])("retains a request after a failed claim without duplicate execution (recovery=%s)", async recover => {
    const { store, input, reflect, worker } = fixture(recover);
    const claim = vi.spyOn(store, "claimJob").mockImplementationOnce(() => { throw new Error("claim unavailable"); });
    const job = recover ? store.enqueueJob(input) : worker.enqueue(input);
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reflect).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(store.getJob(input.agentId, job.id!)).toMatchObject({ status: "complete", attempts: 1 });
  });

  it("retries a failed completion write without repeating the completed inference", async () => {
    const { store, input, reflect, worker } = fixture();
    const job = store.enqueueJob(input);
    const complete = vi.spyOn(store, "completeJob").mockImplementationOnce(() => { throw new Error("completion unavailable"); });
    const retry = vi.spyOn(store, "retryJob");
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(store.getJob(input.agentId, job.id)?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(99);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(reflect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getJob(input.agentId, job.id)?.status).toBe("complete");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(retry).not.toHaveBeenCalled();
    expect(reflect).toHaveBeenCalledTimes(1);
  });

  it.each(["forgotten", "summary-updated"])("reloads a cached result invalidated by %s without blocking other agents", async change => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    stores.push(transcript);
    const store = transcript.memoryStore;
    const agentId = "agent-a";
    const conversationId = transcript.conversationStore.create(agentId).id;
    const otherConversation = transcript.conversationStore.create("agent-b").id;
    transcript.append(agentId, [{ kind: "message", id: "source", role: "user", content: "Preferência antiga.", timestampMs: 1 }], conversationId);
    const saved = store.upsertMemory(agentId, { kind: "preference", canonicalKey: "old-preference", text: "Preferência antiga.", trust: "user", sourceConversationId: conversationId, sourceEntryIds: [{ conversationId, entryId: "source" }] }, { kind: "user" });
    const loadInput = (job: MemoryJob) => {
      const forgotten = store.getForgottenSourceIds(job.agentId, job.conversationId);
      const input = { ...job, expectedPreviousRevision: store.getSummary(job.agentId, job.conversationId)?.revision ?? 0,
        entries: transcript.getEntriesBySequenceRange(job.agentId, job.fromSequenceId, job.throughSequenceId, job.conversationId)
          .filter(entry => typeof entry.id !== "string" || !forgotten.has(entry.id)),
      };
      return { ...input, transcriptFingerprint: createReflectionTranscriptFingerprint(input) };
    };
    const reflect = vi.fn((input: MemoryReflectionInput) => ({ summary: { throughSequenceId: input.throughSequenceId, summaryJson: {}, renderedText: input.entries.length > 0 ? "Resumo com fonte." : "Resumo sem fonte." }, operations: [] }));
    const worker = new MemoryReflectionWorker({ store, loadInput, reflect });
    workers.push(worker);
    const first = store.enqueueJob({ agentId, conversationId, provider: "xai", model: "fixture", fromSequenceId: 0, throughSequenceId: 1, summaryRequested: true, memoryRequested: false });
    vi.spyOn(store, "completeJob").mockImplementationOnce(() => { throw new Error("completion unavailable"); });
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSummary(agentId, conversationId)).toBeNull();
    if (change === "forgotten") store.forgetMemory(agentId, saved.id, { kind: "user" });
    else store.upsertSummary(agentId, { conversationId, throughSequenceId: 1, summaryJson: {}, renderedText: "Resumo novo." });
    const second = store.enqueueJob({ agentId: "agent-b", conversationId: otherConversation, provider: "xai", model: "fixture", fromSequenceId: 0, throughSequenceId: 1, summaryRequested: true, memoryRequested: false });
    worker.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(store.getJob("agent-b", second.id)?.status).toBe("complete");
    expect(store.getJob(agentId, first.id)?.status).toBe("retry");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getJob(agentId, first.id)?.status).toBe("complete");
    expect(reflect.mock.calls.filter(([input]) => input.agentId === agentId)).toHaveLength(2);
    const reloaded = reflect.mock.calls.filter(([input]) => input.agentId === agentId).at(-1)![0];
    if (change === "forgotten") expect(reloaded.entries).toEqual([]);
    else expect(reloaded.expectedPreviousRevision).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes while a failed state write is pending and releases idle waiters", async () => {
    const { store, input, reflect, worker } = fixture();
    store.enqueueJob(input);
    vi.spyOn(store, "completeJob").mockImplementation(() => { throw new Error("store unavailable"); });
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    let idle = false;
    void worker.waitForIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    await worker.close();
    await Promise.resolve();
    expect(idle).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reflect).toHaveBeenCalledTimes(1);
  });

  it("does not cancel or repeat an active job while another scan recovers", async () => {
    const { store, input } = fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let signal: AbortSignal | undefined;
    const reflect = vi.fn(async (_input, abort: AbortSignal) => {
      signal = abort;
      await held;
      return { operations: [] };
    });
    const worker = new MemoryReflectionWorker({ store, reflect, loadInput: job => ({ ...input, ...job }) });
    workers.push(worker);
    const job = worker.enqueue(input);
    vi.spyOn(store, "listRunnableJobs").mockImplementationOnce(() => { throw new Error("scan unavailable"); });
    await vi.advanceTimersByTimeAsync(0);
    expect(reflect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(signal?.aborted).toBe(false);
    expect(reflect).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getJob(input.agentId, job.id!)).toMatchObject({ status: "complete", attempts: 1 });
  });
});
