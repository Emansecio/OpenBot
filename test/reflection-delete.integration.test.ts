import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { MemoryReflectionWorker } from "../src/memory/reflection.js";
import { createProviderRegistry } from "../src/providers/router.js";
import { OpenAiAdapter } from "../src/providers/openai.js";
import { SqliteTranscriptStore } from "../src/store/index.js";

const handles: ServerHandle[] = [];
const workers: MemoryReflectionWorker[] = [];
const stores: SqliteTranscriptStore[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = read();
    if (predicate(value)) return value;
    if (Date.now() - startedAt >= timeoutMs) throw new Error("timeout waiting for reflection");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function rpcContext(handle: ServerHandle) {
  return {
    getStatus: () => handle.runner.getStatus(),
    publish: () => undefined,
    method: "deleteConversation",
  };
}

async function bootBlockedResponses() {
  const root = mkdtempSync(join(tmpdir(), "openbot-reflection-delete-"));
  roots.push(root);
  let signal: AbortSignal | undefined;
  let bodyCancelled = false;
  let calls = 0;
  const registry = createProviderRegistry();
  registry.register(new OpenAiAdapter({
    name: "xai",
    protocol: "responses",
    apiKey: "fixture",
    fetchImpl: async (_url, init) => {
      calls += 1;
      signal = init?.signal as AbortSignal;
      return new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }));
    },
  }));
  const handle = await startServer(0, {
    stateRoot: root,
    registry,
    disableAgentHome: true,
    allowUnauthenticatedLocalGateway: true,
  });
  handles.push(handle);
  const agentId = "delete-test";
  handle.config.update({ agents: [{ id: agentId, name: "Delete", avatarId: "avatar-default" }] });
  const target = handle.conversationStore.ensureDefault(agentId);
  const survivor = handle.conversationStore.create(agentId, { title: "Survivor" });
  handle.conversationStore.activate(agentId, target.id);
  handle.store.append(agentId, [{ kind: "message", id: "source", role: "user", content: "context", timestampMs: 1 }], target.id);
  const job = handle.store.memoryStore.enqueueJob({
    agentId,
    conversationId: target.id,
    provider: "xai",
    model: "grok-4.6",
    fromSequenceId: 0,
    throughSequenceId: handle.store.getLatestSequenceId(agentId, target.id)!,
    summaryRequested: true,
    memoryRequested: false,
  });
  handle.reflectionWorker!.start();
  await waitFor(() => signal, (value) => value !== undefined);
  return { handle, agentId, target, survivor, job, getSignal: () => signal, getBodyCancelled: () => bodyCancelled, getCalls: () => calls };
}

describe("reflection cancellation on conversation deletion", () => {
  it("aborts the reflection signal and response body after a successful delete", async () => {
    const fixture = await bootBlockedResponses();
    const deleteConversation = fixture.handle.gateway.listHandlers().get("deleteConversation")!;

    const result = deleteConversation(
      { agentId: fixture.agentId, conversationId: fixture.target.id },
      rpcContext(fixture.handle),
    ) as { conversationId: string };

    expect(result.conversationId).toBe(fixture.target.id);
    expect(fixture.getSignal()!.aborted).toBe(true);
    await fixture.handle.reflectionWorker!.waitForIdle();
    await waitFor(fixture.getBodyCancelled, Boolean);
    expect(fixture.getCalls()).toBe(1);
    expect(fixture.handle.store.memoryStore.getJob(fixture.agentId, fixture.job.id)).toBeNull();
    expect(fixture.handle.conversationStore.get(fixture.agentId, fixture.target.id)).toBeNull();
    expect(fixture.handle.conversationStore.get(fixture.agentId, fixture.survivor.id)).toMatchObject({ id: fixture.survivor.id });
    expect(fixture.handle.conversationStore.getActive(fixture.agentId)?.id).toBe(fixture.survivor.id);
  });

  it("keeps the reflection alive when the delete transaction is rejected", async () => {
    const fixture = await bootBlockedResponses();
    const onlyAgent = "single-delete-test";
    fixture.handle.config.update({ agents: [{ id: onlyAgent, name: "Single", avatarId: "avatar-default" }] });
    const onlyConversation = fixture.handle.conversationStore.ensureDefault(onlyAgent);
    fixture.handle.store.append(onlyAgent, [{ kind: "message", id: "single-source", role: "user", content: "context", timestampMs: 1 }], onlyConversation.id);
    const onlyJob = fixture.handle.store.memoryStore.enqueueJob({
      agentId: onlyAgent,
      conversationId: onlyConversation.id,
      provider: "xai",
      model: "grok-4.6",
      fromSequenceId: 0,
      throughSequenceId: fixture.handle.store.getLatestSequenceId(onlyAgent, onlyConversation.id)!,
      summaryRequested: true,
      memoryRequested: false,
    });
    fixture.handle.reflectionWorker!.start();
    await waitFor(fixture.getCalls, (value) => value >= 2);
    const onlySignal = fixture.getSignal()!;
    const deleteConversation = fixture.handle.gateway.listHandlers().get("deleteConversation")!;
    expect(() => deleteConversation({ agentId: onlyAgent, conversationId: onlyConversation.id }, rpcContext(fixture.handle))).toThrow(/única conversa restante/i);
    expect(onlySignal!.aborted).toBe(false);
    expect(fixture.handle.store.memoryStore.getJob(onlyAgent, onlyJob.id)).toMatchObject({ status: "running" });
  });

  it("does not cancel a reflection when deletion rolls back after entering the transaction", async () => {
    const fixture = await bootBlockedResponses();
    const deleteConversation = fixture.handle.gateway.listHandlers().get("deleteConversation")!;
    const deleteDerived = vi.spyOn(fixture.handle.store.memoryStore, "deleteConversationDerived")
      .mockImplementation(() => { throw new Error("transaction fixture failure"); });

    expect(() => deleteConversation(
      { agentId: fixture.agentId, conversationId: fixture.target.id },
      rpcContext(fixture.handle),
    )).toThrow(/transaction fixture failure/i);
    deleteDerived.mockRestore();

    expect(fixture.getSignal()!.aborted).toBe(false);
    expect(fixture.getBodyCancelled()).toBe(false);
    expect(fixture.handle.store.memoryStore.getJob(fixture.agentId, fixture.job.id)).toMatchObject({ status: "running" });
    expect(fixture.handle.conversationStore.get(fixture.agentId, fixture.target.id)).toMatchObject({ id: fixture.target.id });
  });

  it("cancels a loading reflection and removes only the deleted conversation job", async () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    stores.push(store);
    const target = store.conversationStore.ensureDefault("agent-a");
    const survivor = store.conversationStore.create("agent-a", { title: "Survivor" });
    store.conversationStore.activate("agent-a", target.id);
    let loading = false;
    let loadingAborted = false;
    let loadingAbortReason: unknown;
    let reflected = 0;
    const worker = new MemoryReflectionWorker({
      store: store.memoryStore,
      loadInput: (_job, signal) => new Promise<null>((_resolve, reject) => {
        loading = true;
        signal.addEventListener("abort", () => {
          loadingAborted = true;
          loadingAbortReason = signal.reason;
          reject(signal.reason);
        }, { once: true });
      }),
      reflect: () => {
        reflected += 1;
        return { operations: [] };
      },
    });
    workers.push(worker);
    const job = store.memoryStore.enqueueJob({
      agentId: "agent-a",
      conversationId: target.id,
      provider: "xai",
      model: "grok-4.6",
      fromSequenceId: 0,
      throughSequenceId: 1,
      summaryRequested: false,
      memoryRequested: true,
    });
    worker.start();
    await waitFor(() => loading, Boolean);
    store.conversationStore.delete("agent-a", target.id, { memoryPolicy: "delete-derived" });
    worker.cancelConversation("agent-a", target.id, "deleted");
    await worker.waitForIdle();

    expect(loadingAborted).toBe(true);
    expect(loadingAbortReason).toMatchObject({ message: "reflection conversation deleted" });
    expect(reflected).toBe(0);
    expect(store.memoryStore.getJob("agent-a", job.id)).toBeNull();
    expect(store.conversationStore.get("agent-a", target.id)).toBeNull();
    expect(store.conversationStore.get("agent-a", survivor.id)).toMatchObject({ id: survivor.id });
  });

  it("drops a queued reflection for the deleted conversation while the survivor runs", async () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    stores.push(store);
    const survivor = store.conversationStore.ensureDefault("agent-a");
    const target = store.conversationStore.create("agent-a", { title: "Queued" });
    store.conversationStore.activate("agent-a", survivor.id);
    let releaseSurvivor!: () => void;
    const survivorStarted = new Promise<void>((resolve) => { releaseSurvivor = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const reflected: string[] = [];
    const worker = new MemoryReflectionWorker({
      concurrency: 1,
      perAgentConcurrency: 1,
      store: store.memoryStore,
      reflect: async (input) => {
        reflected.push(input.conversationId);
        if (input.conversationId === survivor.id) {
          markStarted();
          await survivorStarted;
        }
        return { operations: [] };
      },
    });
    workers.push(worker);
    const survivorJob = worker.enqueue({
      agentId: "agent-a",
      conversationId: survivor.id,
      provider: "xai",
      model: "grok-4.6",
      fromSequenceId: 0,
      throughSequenceId: 1,
      summaryRequested: false,
      memoryRequested: true,
      entries: [],
    });
    const targetJob = worker.enqueue({
      agentId: "agent-a",
      conversationId: target.id,
      provider: "xai",
      model: "grok-4.6",
      fromSequenceId: 2,
      throughSequenceId: 3,
      summaryRequested: false,
      memoryRequested: true,
      entries: [],
    });
    await started;
    store.conversationStore.delete("agent-a", target.id, { memoryPolicy: "delete-derived" });
    worker.cancelConversation("agent-a", target.id, "deleted");
    releaseSurvivor();
    await worker.waitForIdle();

    expect(reflected).toEqual([survivor.id]);
    expect(store.memoryStore.getJob("agent-a", survivorJob.id!)).toMatchObject({ status: "complete" });
    expect(store.memoryStore.getJob("agent-a", targetJob.id!)).toBeNull();
    expect(store.conversationStore.get("agent-a", target.id)).toBeNull();
  });
});
