import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import type { RpcHandler } from "../src/server/gateway.js";
import type { DispatchAsyncTaskInput, ProviderCapabilityGrant, SubagentBudget } from "../src/tasks/contracts.js";
import { AsyncTaskRuntime } from "../src/tasks/runtime.js";

/**
 * P2.2 RED contract. The production implementation must move these shapes to
 * src/shared/contracts.ts and the conversion to a first-party task projection
 * adapter. These test aliases deliberately do not construct fake Gateway
 * payloads; SSE is fed from the real Store projection pipeline below.
 */
interface NativeTaskProjectionItem {
  id: string;
  kind: string;
  status: string;
  label: string;
  detail: string;
  startedAtMs: number | null;
  progress?: { phase: string; summary: string; completedUnits: number | null; totalUnits: number | null } | null;
  error?: { code: string; message: string; retryable: boolean } | null;
  result?: { kind: "inline" | "ref"; text?: string; resultRef?: string; bytes: number; truncated: boolean } | null;
}

interface NativeTaskProjectionEvent {
  type: "snapshot" | "update" | "resync";
  agentId: string;
  parentAgentId: string;
  channel: "async-tasks" | "subagents";
  epoch?: string;
  sequence?: number;
  tasks?: NativeTaskProjectionItem[];
  subagents?: NativeTaskProjectionItem[];
  resyncRequired?: boolean;
  reason?: string;
}

const handles: ServerHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const budget: SubagentBudget = {
  maxWallMs: 10_000, maxProviderCalls: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000,
  maxToolRounds: 1, maxToolCalls: 1, maxMcpCalls: 1, maxBrowserCommands: 1,
  maxResultBytes: 4_096, maxWorkspaceWriteBytes: 4_096, maxDepth: 1,
};

function handler(handle: ServerHandle, method: string): RpcHandler {
  const fn = handle.gateway.listHandlers().get(method);
  if (!fn) throw new Error(`missing RPC handler: ${method}`);
  return fn;
}

function context(handle: ServerHandle) {
  return { getStatus: () => handle.runner.getStatus(), publish: () => undefined, method: "test" } as never;
}

function taskInput(agentId: string): DispatchAsyncTaskInput {
  const taskId = randomUUID();
  const parentTurnId = "turn-p22";
  const childRunId = randomUUID();
  const provider = "openai";
  const model = "test";
  const grant: ProviderCapabilityGrant = {
    grantId: randomUUID(), taskId, parentAgentId: agentId, parentTurnId, childRunId,
    kind: "provider",
    constraints: { adapters: [provider], models: [model], credentialRefs: [{ secretRef: "provider/test/key" }], allowNoCredential: false },
    issuedAt: Date.now() - 100, expiresAt: Date.now() + 5_000, version: 1, depth: 1,
  };
  return {
    taskId, agentId, parentTurnId, kind: "subagent", clientNonce: randomUUID(), createdAtMs: Date.now(),
    lineage: { parentAgentId: agentId, parentTurnId, parentTaskId: null, childRunId, depth: 1 }, grant, budget,
    input: { version: 1, objective: "P22 native projection fixture", source: { kind: "parent_turn", agentId } },
  };
}

async function harness(): Promise<ServerHandle> {
  const root = mkdtempSync(join(tmpdir(), "openbot-p22-native-contract-"));
  roots.push(root);
  const handle = await startServer(0, {
    configPath: join(root, "config.json"), stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime"),
    browserRoot: join(root, "browser"), keystoreDir: join(root, "keystore"), storePath: join(root, "store.db"),
    allowUnauthenticatedLocalGateway: true,
  });
  handles.push(handle);
  await handler(handle, "createAgent")({ id: "agent-a", name: "Agent A" }, context(handle));
  await handler(handle, "createAgent")({ id: "agent-b", name: "Agent B" }, context(handle));
  await handle.asyncTaskRuntime.stop();
  return handle;
}

async function openSse(handle: ServerHandle, channels = "async-tasks", agentId = "agent-a") {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/events?channels=${channels}&agentId=${agentId}`, {
    headers: { accept: "text/event-stream" },
  });
  expect(response.status).toBe(200);
  return response.body!.getReader();
}

/** Accumulates arbitrary chunks and parses only complete SSE \n\n frames. */
async function readSseFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count = 1,
  until?: (frame: NativeTaskProjectionEvent) => boolean,
): Promise<NativeTaskProjectionEvent[]> {
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: NativeTaskProjectionEvent[] = [];
  while (frames.length < count && !frames.some((frame) => until?.(frame) === true)) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let separator = buffer.indexOf("\n\n");
    while (separator >= 0) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
      if (data.length > 0) {
        const outer = JSON.parse(data) as { payload?: NativeTaskProjectionEvent };
        const frame = (outer.payload ?? outer) as NativeTaskProjectionEvent;
        frames.push(frame);
        if (until?.(frame) === true) break;
      }
      separator = buffer.indexOf("\n\n");
    }
  }
  return frames;
}

async function executeFromStoreToSse(
  handle: ServerHandle,
  task: DispatchAsyncTaskInput,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  execute: () => Promise<{ result: string }> = async () => ({ result: "terminal result" }),
  dispatch = true,
) {
  const terminalStatuses = ["completed", "failed", "cancelled", "abandoned"];
  const runtime = new AsyncTaskRuntime({
    store: handle.asyncTaskStore,
    agentIds: () => ["agent-a", "agent-b"],
    pollIntervalMs: 1,
    execute,
    maxAttempts: 1,
    // The envelope comes from SQLite projectUndelivered(); this is not an
    // artificial event fixture. The missing native mapper is the RED target.
    publishProjection: (envelope) => handle.gateway.publish(envelope.channel, envelope).accepted,
  });
  runtime.start();
  let frameTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (dispatch) handle.asyncTaskStore.dispatch(task);
    const framesPromise = readSseFrames(reader, Number.MAX_SAFE_INTEGER, (frame) => {
      const items = frame.tasks ?? frame.subagents ?? [];
      return items.some((item) => item.id === task.taskId && terminalStatuses.includes(item.status));
    });
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !terminalStatuses.includes(handle.asyncTaskStore.getTask(task.taskId)?.status ?? "")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const storedTask = handle.asyncTaskStore.getTask(task.taskId);
    expect(storedTask && terminalStatuses.includes(storedTask.status), "task must reach terminal store state before the 3-second deadline").toBe(true);
    const frames = await Promise.race([
      framesPromise,
      new Promise<never>((_resolve, reject) => {
        frameTimeout = setTimeout(() => reject(new Error(`timed out waiting for terminal SSE frame for ${task.taskId}`)), 3_000);
      }),
    ]);
    return { frames, task: storedTask };
  } finally {
    if (frameTimeout !== undefined) clearTimeout(frameTimeout);
    await runtime.stop();
    await reader.cancel().catch(() => undefined);
  }
}

async function loadFutureProjectionAdapter(): Promise<Record<string, unknown>> {
  try {
    // P2.2: the production first-party projection module is now implemented.
    return (await import("../src/tasks/projection.js"));
  } catch (error) {
    return { __loadError: error };
  }
}

function terminalize(handle: ServerHandle, input: DispatchAsyncTaskInput) {
  const created = handle.asyncTaskStore.dispatch(input).task;
  const claimAt = Date.now();
  const claim = handle.asyncTaskStore.claimNext(input.agentId, { ownerId: "owner-p22", nowMs: claimAt, leaseDurationMs: 5_000 });
  if (claim === null) throw new Error("test task was not claimable");
  const startedAt = Date.now();
  const started = handle.asyncTaskStore.start({ taskId: created.taskId, expectedVersion: claim.task.version, leaseOwnerId: "owner-p22", attempt: claim.attempt.attempt, startedAtMs: startedAt });
  const finishedAt = Date.now();
  return handle.asyncTaskStore.commitTerminal({
    taskId: created.taskId,
    expectedVersion: started.version,
    leaseOwnerId: "owner-p22",
    attempt: claim.attempt.attempt,
    status: "completed",
    finishedAtMs: finishedAt,
    result: { kind: "inline", text: "terminal result", bytes: 15, truncated: false },
    error: null,
    wakeKind: "task_terminal",
    wakePayload: { status: "completed", attempt: claim.attempt.attempt, summary: null, code: null, resultRef: null },
  }).task;
}

describe("P2.2 canonical task projection (RED)", () => {
  it("accepts native id alias for every read-only task list method", async () => {
    const handle = await harness();
    await Promise.all(["getAsyncTasks", "getSubagents", "listAsyncTasks"].map((method) =>
      expect(handler(handle, method)({ id: "agent-a" }, context(handle))).resolves.toEqual([]),
    ));
  });

  it("rejects id alias on every mutating task method", async () => {
    const handle = await harness();
    await Promise.all(["dispatchAsyncTask", "abortAsyncTask", "steerAsyncTask", "settleAsyncTask"].map((method) =>
      expect(Promise.resolve().then(() => handler(handle, method)({ id: "agent-a" }, context(handle)))).rejects.toMatchObject({ status: 400 }),
    ));
  });

  it("projects Store-created and terminal/error/result records through SSE without private fields", async () => {
    const handle = await harness();
    const completedInput = taskInput("agent-a");
    const completedRun = await executeFromStoreToSse(handle, completedInput, await openSse(handle, "async-tasks,subagents"));
    expect(completedRun.task).toMatchObject({ status: "completed", result: { kind: "inline", text: "terminal result" }, error: null });
    const failedInput = taskInput("agent-a");
    const failedRun = await executeFromStoreToSse(handle, failedInput, await openSse(handle, "async-tasks,subagents"), async () => {
      throw new Error("terminal failure");
    });
    expect(failedRun.task).toMatchObject({ status: "failed", result: null, error: { message: "terminal failure", retryable: true } });
    const frames = [...completedRun.frames, ...failedRun.frames];
    expect(frames.length).toBeGreaterThan(0);
    for (const runFrames of [completedRun.frames, failedRun.frames]) {
      const sequences = runFrames.map((frame) => frame.sequence ?? -1);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    }
    expect(frames.some((frame) => frame.type === "update")).toBe(true);
    const projected = frames.flatMap((frame) => frame.tasks ?? frame.subagents ?? []);
    expect(projected).toContainEqual(expect.objectContaining({
      id: completedInput.taskId,
      status: "completed",
      result: { kind: "inline", text: "terminal result", bytes: 15, truncated: false },
    }));
    expect(projected).toContainEqual(expect.objectContaining({
      id: failedInput.taskId,
      status: "failed",
      error: { code: "internal_error", message: "terminal failure", retryable: true },
    }));
    for (const frame of frames) {
      expect(frame).toMatchObject({ agentId: "agent-a", parentAgentId: "agent-a", epoch: expect.any(String), sequence: expect.any(Number) });
      const items = frame.tasks ?? frame.subagents ?? [];
      expect(Array.isArray(items)).toBe(true);
      for (const item of items) {
        expect(item).toMatchObject({ id: expect.any(String), status: expect.any(String), label: expect.any(String), detail: expect.any(String) });
        expect(item).not.toHaveProperty("input");
        expect(item).not.toHaveProperty("lineage");
        expect(JSON.stringify(item)).not.toContain("provider/test/key");
      }
    }
  });

  it("allowlists and caps label/detail/progress/error/result recursively, including terminal failure", async () => {
    const adapter = await loadFutureProjectionAdapter();
    expect(adapter.__loadError).toBeUndefined();
    const project = adapter.projectAsyncTaskForRenderer as ((record: unknown) => NativeTaskProjectionItem);
    expect(project).toBeTypeOf("function");
    expect(adapter.projectAsyncTaskListForRenderer).toBeTypeOf("function");
    const cap = (name: string) => adapter[name] as number;
    const malicious = {
      taskId: "task-private", agentId: "agent-a", kind: "subagent", status: "failed", startedAtMs: 1,
      input: { objective: "Ã©".repeat(10_000) }, lineage: { parentAgentId: "agent-a" }, lease: { ownerId: "secret" },
      progress: { phase: "Ã©".repeat(10_000), summary: "Ã©".repeat(20_000), completedUnits: 1, totalUnits: 2, nested: { token: "secret" } },
      error: { code: "provider_error", message: "Ã©".repeat(20_000), retryable: false, nested: { password: "secret" } },
      result: { kind: "inline", text: "Ã©".repeat(20_000), bytes: 40_000, truncated: false, nested: { token: "secret" } },
      inputSecret: "sk-do-not-show",
    };
    const projection = project(malicious);
    expect(projection).toMatchObject({ id: "task-private", status: "failed", error: expect.any(Object), result: expect.any(Object) });
    expect(Object.keys(projection).sort()).toEqual(["detail", "error", "id", "kind", "label", "progress", "result", "startedAtMs", "status"].sort());
    expect(JSON.stringify(projection)).not.toContain("secret");
    expect(Buffer.byteLength(projection.label, "utf8")).toBe(cap("PROJECTION_LABEL_MAX_BYTES"));
    expect(Buffer.byteLength(projection.detail, "utf8")).toBe(cap("PROJECTION_DETAIL_MAX_BYTES"));
    expect(Buffer.byteLength(projection.progress?.phase ?? "", "utf8")).toBe(cap("PROJECTION_PHASE_MAX_BYTES"));
    expect(Buffer.byteLength(projection.progress?.summary ?? "", "utf8")).toBe(cap("PROJECTION_SUMMARY_MAX_BYTES"));
    expect(Buffer.byteLength(projection.error?.message ?? "", "utf8")).toBe(cap("PROJECTION_ERROR_MESSAGE_MAX_BYTES"));
    expect(Buffer.byteLength(projection.result?.text ?? "", "utf8")).toBe(cap("PROJECTION_RESULT_TEXT_MAX_BYTES"));
    expect(projection.result).toMatchObject({ bytes: cap("PROJECTION_RESULT_TEXT_MAX_BYTES"), truncated: true });
    const refProjection = project({
      ...malicious,
      taskId: "task-ref",
      result: { kind: "ref", resultRef: "Ã©".repeat(20_000), bytes: 40_000, truncated: false, nested: { token: "secret" } },
    });
    expect(Buffer.byteLength(refProjection.result?.resultRef ?? "", "utf8")).toBe(cap("PROJECTION_RESULT_REF_MAX_BYTES"));
    expect(JSON.stringify(refProjection)).not.toContain("secret");
  });

  it("emits unique raw task identities and supports monotonic replace/upsert reducer semantics", async () => {
    const handle = await harness();
    const task = taskInput("agent-a");
    handle.asyncTaskStore.dispatch(task);
    handle.asyncTaskStore.projectUndelivered();
    const snapshot = handle.asyncTaskStore.getProjectionSnapshot("agent-a", "async-tasks")!;
    const reader = await openSse(handle);
    const initial = await readSseFrames(reader, 1);
    expect(initial[0]).toHaveProperty("tasks");
    expect(initial[0]).toMatchObject({ type: "snapshot", epoch: snapshot.epoch, sequence: snapshot.sequence, resyncRequired: expect.any(Boolean) });
    const clientState = new Map<string, NativeTaskProjectionItem>();
    const expectUniqueRawIds = (frame: NativeTaskProjectionEvent) => {
      const ids = (frame.tasks ?? frame.subagents ?? []).map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
    };
    const replaceFrom = (frame: NativeTaskProjectionEvent) => {
      expectUniqueRawIds(frame);
      clientState.clear();
      for (const item of frame.tasks ?? frame.subagents ?? []) clientState.set(item.id, item);
    };
    const upsertFrom = (frame: NativeTaskProjectionEvent) => {
      expectUniqueRawIds(frame);
      for (const item of frame.tasks ?? frame.subagents ?? []) clientState.set(item.id, item);
    };
    replaceFrom(initial[0]!);
    expect([...clientState.keys()]).toEqual([task.taskId]);

    const completed = await executeFromStoreToSse(handle, task, reader, undefined, false);
    let appliedSequence = snapshot.sequence;
    for (const frame of completed.frames) {
      if ((frame.sequence ?? -1) <= appliedSequence) continue;
      appliedSequence = frame.sequence!;
      upsertFrom(frame);
    }
    expect([...clientState.values()]).toEqual([
      expect.objectContaining({ id: task.taskId, status: "completed", result: expect.any(Object) }),
    ]);
    const reconnectResponse = await fetch(`http://127.0.0.1:${handle.port}/api/events?channels=async-tasks&agentId=agent-a`, {
      headers: { accept: "text/event-stream", "last-event-id": `async-tasks:${snapshot.epoch}:0` },
    });
    const reconnectReader = reconnectResponse.body!.getReader();
    const reconnect = await readSseFrames(reconnectReader, 1);
    expect(reconnect).toHaveLength(1);
    expect(reconnect[0]).toHaveProperty("tasks");
    expect(reconnect[0]).toMatchObject({ type: "snapshot", epoch: snapshot.epoch, sequence: appliedSequence, resyncRequired: true });
    replaceFrom(reconnect[0]!);
    expect([...clientState.values()]).toEqual([
      expect.objectContaining({ id: task.taskId, status: "completed", result: expect.any(Object) }),
    ]);
    await reconnectReader.cancel();
  });

  it("marks stale, gap and cursor-ahead reconnects as resync without polling", async () => {
    const handle = await harness();
    let pollCalls = 0;
    for (const method of ["getAsyncTasks", "getSubagents", "listAsyncTasks"]) {
      const original = handler(handle, method);
      handle.gateway.registerHandler(method, (body, ctx) => {
        pollCalls += 1;
        return original(body, ctx);
      });
    }
    handle.asyncTaskStore.dispatch(taskInput("agent-a"));
    handle.asyncTaskStore.projectUndelivered();
    const snapshot = handle.asyncTaskStore.getProjectionSnapshot("agent-a", "async-tasks")!;
    const reconnects = [
      { epoch: snapshot.epoch, sequence: 0, reason: "cursor-stale-or-gap" },
      { epoch: snapshot.epoch, sequence: snapshot.sequence + 1, reason: "cursor-ahead" },
      { epoch: "stale-epoch", sequence: snapshot.sequence, reason: "epoch-mismatch" },
    ];
    for (const cursor of reconnects) {
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/events?channels=async-tasks&agentId=agent-a`, {
        headers: { accept: "text/event-stream", "last-event-id": `async-tasks:${cursor.epoch}:${cursor.sequence}` },
      });
      const reader = response.body!.getReader();
      const frames = await readSseFrames(reader, 1);
      expect(frames[0]).toHaveProperty("tasks");
      expect(frames[0]).toMatchObject({ type: "snapshot", resyncRequired: true, reason: cursor.reason, epoch: snapshot.epoch, sequence: snapshot.sequence });
      await reader.cancel();
    }
    expect(pollCalls).toBe(0);
  });
});

describe("P2.2 ownership and bridge prerequisites", () => {
  it("rejects cross-agent task RPC and SSE, rejects terminal control, and accepts same-agent reads", async () => {
    const handle = await harness();
    const task = taskInput("agent-a");
    const terminal = terminalize(handle, task);
    const own = await handler(handle, "getAsyncTask")({ agentId: "agent-a", taskId: terminal.taskId }, context(handle));
    expect(own).toMatchObject({ agentId: "agent-a", taskId: task.taskId });
    await expect(Promise.resolve().then(() => handler(handle, "getAsyncTask")({ agentId: "agent-b", taskId: terminal.taskId }, context(handle)))).rejects.toMatchObject({ status: 404 });
    const reader = await openSse(handle, "async-tasks", "agent-b");
    handle.asyncTaskStore.projectUndelivered();
    const frames = await readSseFrames(reader, 1);
    expect(JSON.stringify(frames)).not.toContain(terminal.taskId);
    await reader.cancel();

    await expect(Promise.resolve().then(() => handler(handle, "abortAsyncTask")({ agentId: "agent-a", taskId: terminal.taskId, intentId: randomUUID(), expectedAbortVersion: terminal.abortVersion, reason: "user" }, context(handle)))).rejects.toMatchObject({ code: "invalid_contract" });
    await expect(Promise.resolve().then(() => handler(handle, "settleAsyncTask")({ agentId: "agent-a", taskId: terminal.taskId, settlementNonce: "settle-p22" }, context(handle)))).resolves.toMatchObject({ taskId: terminal.taskId, settledAtMs: expect.any(Number) });
  });

  it("rejects stale intent/version and malformed control content without mutating task state", async () => {
    const handle = await harness();
    const task = taskInput("agent-a");
    handle.asyncTaskStore.dispatch(task);
    const before = handle.asyncTaskStore.getTask(task.taskId)!;
    await expect(Promise.resolve().then(() => handler(handle, "abortAsyncTask")({ agentId: "agent-a", taskId: task.taskId, intentId: randomUUID(), expectedAbortVersion: before.abortVersion + 1, reason: "user" }, context(handle)))).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(Promise.resolve().then(() => handler(handle, "steerAsyncTask")({ agentId: "agent-a", taskId: task.taskId, intentId: randomUUID(), expectedSteerVersion: before.steerVersion, message: { malformed: true } }, context(handle)))).rejects.toMatchObject({ status: 400 });
    expect(handle.asyncTaskStore.getTask(task.taskId)).toMatchObject({ version: before.version, status: before.status });
  });

  it("keeps attachment bridge preconditions while leaving DOM lifecycle to the real Electron gate", () => {
    const root = new URL("..", import.meta.url).pathname.replace(/^\/(.):/, "$1:");
    const preload = readFileSync(join(root, "client/extracted/dist/electron-preload/preload.cjs"), "utf8");
    for (const method of ["stageAttachmentBytes", "commitStagedAttachments", "discardStagedAttachment"]) {
      expect(preload).toContain(`async ${method}(`);
    }
  });

  it("keeps the production backend local state inside the managed E2E root", () => {
    const root = new URL("..", import.meta.url).pathname.replace(/^\/(.):/, "$1:");
    const source = readFileSync(resolve(root, "scripts/electron-p22-tasks-verify.mjs"), "utf8");
    expect(source).toContain('OPENBOT_LOCAL_DATA_ROOT: join(runRoot, "local-data")');
  });

});
