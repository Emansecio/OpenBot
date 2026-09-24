import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { AsyncTaskRuntime } from "../src/tasks/runtime.js";
import { type DelegatedCapabilityGrant, type DispatchAsyncTaskInput, type ProviderCapabilityGrant, type SubagentBudget } from "../src/tasks/contracts.js";
import { AsyncTaskStore } from "../src/tasks/store.js";

const budget: SubagentBudget = {
  maxWallMs: 10_000, maxProviderCalls: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000,
  maxToolRounds: 1, maxToolCalls: 1, maxMcpCalls: 1, maxBrowserCommands: 1,
  maxResultBytes: 4_096, maxWorkspaceWriteBytes: 4_096, maxDepth: 1,
};

function input(kind: "provider" | "filesystem" = "provider", budgetValue: SubagentBudget = budget, agentId = "agent-a"): DispatchAsyncTaskInput {
  const taskId = randomUUID();
  const childRunId = randomUUID();
  const grant: DelegatedCapabilityGrant = kind === "filesystem" ? {
    grantId: randomUUID(), taskId, parentAgentId: agentId, parentTurnId: `turn-${agentId}`, childRunId,
    kind: "filesystem", constraints: { operations: ["read", "write", "list"], roots: ["C:\\workspace"] },
    issuedAt: 1, expiresAt: 9_000, version: 1, depth: 1,
  } : {
    grantId: randomUUID(), taskId, parentAgentId: agentId, parentTurnId: `turn-${agentId}`, childRunId,
    kind: "provider", constraints: { adapters: ["openai"], models: ["test"], credentialRefs: [{ secretRef: "provider/test/key" }], allowNoCredential: false },
    issuedAt: 1, expiresAt: 9_000, version: 1, depth: 1,
  } satisfies ProviderCapabilityGrant;
  return {
    taskId, agentId, parentTurnId: `turn-${agentId}`, kind: "subagent", clientNonce: randomUUID(), createdAtMs: 1,
    lineage: { parentAgentId: agentId, parentTurnId: `turn-${agentId}`, parentTaskId: null, childRunId, depth: 1 }, grant, budget: budgetValue,
    input: { version: 1, objective: "Faça uma verificação curta", source: { kind: "parent_turn", agentId, turnEntryId: `entry-${agentId}` } },
  };
}

async function eventually(read: () => string, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (read() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(read()).toBe(expected);
}


describe("AsyncTaskRuntime", () => {

  it("requeues an expired running lease on restart before claiming it again", async () => {
    let clock = 2_100;
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => clock });
    const task = store.dispatch(input()).task;
    const claimed = store.claimNext("agent-a", { ownerId: "crashed-worker", nowMs: clock, leaseDurationMs: 100 })!;
    const running = store.start({ taskId: task.taskId, expectedVersion: claimed.task.version, leaseOwnerId: "crashed-worker", attempt: 1, startedAtMs: clock });
    store.reserveTaskBudget(task.taskId, 1, { reservationId: "crashed-effect", amounts: { providerCalls: 1, inputTokens: 0, outputTokens: 0, toolRounds: 0, toolCalls: 0, mcpCalls: 0, browserCommands: 0, resultBytes: 0, workspaceWriteBytes: 0 } }, {
      leaseOwnerId: "crashed-worker", attempt: 1, expectedTaskVersion: running.version,
    }, clock);
    clock = 2_300;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, now: () => clock,
      execute: async () => ({ result: "recovered", usage: { providerCalls: 0 } }),
    });
    runtime.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
    await runtime.stop();
    expect(store.listAttempts(task.taskId).map((attempt) => attempt.status)).toEqual(["abandoned", "completed"]);
    expect(store.getBudgetState(task.taskId)?.usage).toMatchObject({ used: { providerCalls: 1 }, reserved: { providerCalls: 0 }, reservations: [] });
    store.close();
  });

  it("keeps the shared loop alive when a claimed task fails during start", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const first = store.dispatch(input()).task;
    const second = store.dispatch(input()).task;
    const originalStart = store.start.bind(store);
    let failFirstStart = true;
    const mutableStore = store as unknown as { start: typeof store.start };
    mutableStore.start = (request) => {
      if (failFirstStart && request.taskId === first.taskId) {
        failFirstStart = false;
        throw new Error("start CAS raced with revocation");
      }
      return originalStart(request);
    };
    let executed = 0;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, now: () => 2_100,
      execute: async () => { executed += 1; return { result: "second completed" }; },
    });
    runtime.start();
    await eventually(() => store.getTask(second.taskId)?.status ?? "missing", "completed");
    await runtime.stop();
    expect(executed).toBe(1);
    expect(store.getTask(first.taskId)?.status).toBe("admitted");
    store.close();
  });

  it("renews a live lease after steer advances the task version", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input()).task;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    let signal: AbortSignal | undefined;
    let heartbeatCalls = 0;
    let steered = false;
    const originalHeartbeat = store.heartbeat.bind(store);
    const heartbeatSpy = vi.spyOn(store, "heartbeat").mockImplementation((request) => {
      heartbeatCalls += 1;
      if (!steered) {
        steered = true;
        const current = store.getTask(task.taskId)!;
        store.steer({
          taskId: task.taskId, agentId: task.agentId, parentTurnId: task.parentTurnId,
          intentId: "steer-before-heartbeat", expectedSteerVersion: current.steerVersion,
          requestedAtMs: 2_100, message: "continue with the updated instruction",
        });
      }
      return originalHeartbeat(request);
    });
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], leaseDurationMs: 100, pollIntervalMs: 1, now: () => 2_100,
      execute: async (context) => { entered = true; signal = context.signal; await blocked; return { result: "steered" }; },
    });
    try {
      runtime.start();
      await eventually(() => entered ? "entered" : "waiting", "entered");
      await eventually(() => heartbeatCalls > 0 ? "renewing" : "waiting", "renewing");
      release();
      await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
      await runtime.stop();
      expect(steered).toBe(true);
      expect(heartbeatCalls).toBeGreaterThanOrEqual(2);
      expect(signal?.aborted).toBe(false);
      expect(store.getTask(task.taskId)).toMatchObject({ status: "completed", error: null });
    } finally {
      release();
      await runtime.stop();
      heartbeatSpy.mockRestore();
      store.close();
    }
  });

  it("reconciles an expired claim after its terminal commit loses the lease", async () => {
    let clock = 2_100;
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => clock });
    const task = store.dispatch(input()).task;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    let signal: AbortSignal | undefined;
    let calls = 0;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], leaseDurationMs: 100, maxAttempts: 2, retryDelayMs: 0, pollIntervalMs: 1, now: () => clock,
      execute: async (context) => {
        calls += 1;
        if (calls === 1) { entered = true; signal = context.signal; await blocked; }
        return { result: calls === 1 ? "late" : "recovered" };
      },
    });
    try {
      runtime.start();
      await eventually(() => entered ? "entered" : "waiting", "entered");
      clock = 2_300;
      await eventually(() => signal?.aborted ? "aborted" : "waiting", "aborted");
      release();
      await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
      await runtime.stop();
      expect(calls).toBe(2);
      expect(store.listAttempts(task.taskId).map((attempt) => attempt.status)).toEqual(["abandoned", "completed"]);
      expect(store.getTask(task.taskId)).toMatchObject({ status: "completed", error: null });
    } finally {
      release();
      await runtime.stop();
      store.close();
    }
  });

  it("blocks an unsafe effect after SQLite reopen when the process crashes before terminal commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-async-effect-crash-"));
    const databasePath = join(root, "tasks.sqlite");
    const counterPath = join(root, "remote-counter.txt");
    writeFileSync(counterPath, "0", "utf8");
    let firstStore: AsyncTaskStore | undefined;
    let reopened: AsyncTaskStore | undefined;
    try {
      firstStore = new AsyncTaskStore({ path: databasePath, sensitiveValues: () => [], now: () => 1_100 });
      const task = firstStore.dispatch(input("filesystem")).task;
      const claim = firstStore.claimNext(task.agentId, { ownerId: "crashed-worker", nowMs: 1_100, leaseDurationMs: 500 })!;
      const running = firstStore.start({ taskId: task.taskId, expectedVersion: claim.task.version, leaseOwnerId: "crashed-worker", attempt: 1, startedAtMs: 1_100 });
      firstStore.markUnsafeEffectStarted({ taskId: task.taskId, expectedVersion: running.version, leaseOwnerId: "crashed-worker", attempt: 1, markedAtMs: 1_100 });
      writeFileSync(counterPath, String(Number(readFileSync(counterPath, "utf8")) + 1), "utf8");
      firstStore.close();
      firstStore = undefined;

      let dispatches = 0;
      reopened = new AsyncTaskStore({ path: databasePath, sensitiveValues: () => [], now: () => 1_600 });
      const runtime = new AsyncTaskRuntime({
        store: reopened, agentIds: () => [task.agentId], leaseDurationMs: 500, maxAttempts: 2, retryDelayMs: 0, pollIntervalMs: 1,
        now: () => 1_600,
        execute: async () => {
          dispatches += 1;
          writeFileSync(counterPath, String(Number(readFileSync(counterPath, "utf8")) + 1), "utf8");
          return { result: "must not dispatch" };
        },
      });
      runtime.start();
      await eventually(() => reopened?.getTask(task.taskId)?.status ?? "missing", "failed");
      await runtime.stop();
      expect(dispatches).toBe(0);
      expect(readFileSync(counterPath, "utf8")).toBe("1");
      expect(reopened.getTask(task.taskId)?.error).toMatchObject({
        code: "internal_error",
        retryable: false,
        message: "Task effect outcome is uncertain after lease recovery; automatic retry is blocked.",
      });
      expect(reopened.listAttempts(task.taskId)[0]?.unsafeEffectStarted).toBe(true);
    } finally {
      reopened?.close();
      firstStore?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks an unsafe effect after a real worker process exits before terminal commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-async-effect-worker-crash-"));
    const databasePath = join(root, "tasks.sqlite");
    const counterPath = join(root, "remote-counter.txt");
    const statePath = join(root, "worker-state.json");
    const workerPath = join(root, "crash-worker.mjs");
    writeFileSync(counterPath, "0", "utf8");
    writeFileSync(workerPath, `
      import { randomUUID } from "node:crypto";
      import { writeFileSync, readFileSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      const [{ AsyncTaskStore }, { databasePath, counterPath, statePath }] = await Promise.all([
        import(pathToFileURL(process.argv[5]).href),
        Promise.resolve({ databasePath: process.argv[2], counterPath: process.argv[3], statePath: process.argv[4] }),
      ]);
      const taskId = randomUUID();
      const childRunId = randomUUID();
      const input = {
        taskId, agentId: "agent-a", parentTurnId: "turn-agent-a", kind: "subagent", clientNonce: randomUUID(), createdAtMs: 1,
        lineage: { parentAgentId: "agent-a", parentTurnId: "turn-agent-a", parentTaskId: null, childRunId, depth: 1 },
        grant: {
          grantId: randomUUID(), taskId, parentAgentId: "agent-a", parentTurnId: "turn-agent-a", childRunId,
          kind: "filesystem", constraints: { operations: ["read", "write", "list"], roots: ["C:\\\\workspace"] },
          issuedAt: 1, expiresAt: 8_001, version: 1, depth: 1,
        },
        budget: {
          maxWallMs: 8_000, maxProviderCalls: 1, maxInputTokens: 100, maxOutputTokens: 100,
          maxToolRounds: 1, maxToolCalls: 1, maxMcpCalls: 1, maxBrowserCommands: 1,
          maxResultBytes: 4_096, maxWorkspaceWriteBytes: 4_096, maxDepth: 1,
        },
        input: { version: 1, objective: "crash worker", source: { kind: "parent_turn", agentId: "agent-a", turnEntryId: "entry-agent-a" } },
      };
      const store = new AsyncTaskStore({ path: databasePath, sensitiveValues: () => [], now: () => 1_100 });
      const created = store.dispatch(input).task;
      const claim = store.claimNext("agent-a", { ownerId: "crashed-worker", nowMs: 1_100, leaseDurationMs: 500 });
      const running = store.start({ taskId, expectedVersion: claim.task.version, leaseOwnerId: "crashed-worker", attempt: 1, startedAtMs: 1_100 });
      store.markUnsafeEffectStarted({ taskId, expectedVersion: running.version, leaseOwnerId: "crashed-worker", attempt: 1, markedAtMs: 1_100 });
      writeFileSync(counterPath, String(Number(readFileSync(counterPath, "utf8")) + 1), "utf8");
      writeFileSync(statePath, JSON.stringify({ taskId: created.taskId }), "utf8");
      process.exit(137);
    `, "utf8");
    let reopened: AsyncTaskStore | undefined;
    try {
      const worker = spawnSync(process.execPath, [
        join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs"),
        workerPath,
        databasePath,
        counterPath,
        statePath,
        resolve("src/tasks/store.ts"),
      ], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, windowsHide: true });
      expect(worker.status, `${worker.stdout}\n${worker.stderr}`).toBe(137);
      const state = JSON.parse(readFileSync(statePath, "utf8")) as { taskId: string };
      reopened = new AsyncTaskStore({ path: databasePath, sensitiveValues: () => [], now: () => 1_600 });
      let dispatches = 0;
      const runtime = new AsyncTaskRuntime({
        store: reopened, agentIds: () => ["agent-a"], leaseDurationMs: 500, maxAttempts: 2, retryDelayMs: 0, pollIntervalMs: 1,
        now: () => 1_600,
        execute: async () => { dispatches += 1; writeFileSync(counterPath, String(Number(readFileSync(counterPath, "utf8")) + 1), "utf8"); return { result: "must not dispatch" }; },
      });
      runtime.start();
      await eventually(() => reopened?.getTask(state.taskId)?.status ?? "missing", "failed");
      await runtime.stop();
      expect(dispatches).toBe(0);
      expect(readFileSync(counterPath, "utf8")).toBe("1");
      expect(reopened.getTask(state.taskId)?.error).toMatchObject({ code: "internal_error", retryable: false });
      expect(reopened.listAttempts(state.taskId)[0]?.unsafeEffectStarted).toBe(true);
    } finally {
      reopened?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciles another expired lease without requeueing the active claim", async () => {
    let clock = 2_100;
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => clock });
    const active = store.dispatch(input("provider", budget, "agent-a")).task;
    const orphan = store.dispatch(input("provider", budget, "agent-b")).task;
    const orphanClaim = store.claimNext(orphan.agentId, { ownerId: "worker-orphan", nowMs: clock, leaseDurationMs: 100 })!;
    store.start({ taskId: orphan.taskId, expectedVersion: orphanClaim.task.version, leaseOwnerId: "worker-orphan", attempt: 1, startedAtMs: clock });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    let signal: AbortSignal | undefined;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a", "agent-b"], leaseDurationMs: 100, maxAttempts: 2, retryDelayMs: 0, pollIntervalMs: 1, now: () => clock,
      execute: async (context) => {
        if (context.task.taskId === active.taskId) { entered = true; signal = context.signal; await blocked; }
        return { result: context.task.taskId === orphan.taskId ? "orphan-recovered" : "active-recovered" };
      },
    });
    try {
      runtime.start();
      await eventually(() => entered ? "entered" : "waiting", "entered");
      clock = 2_300;
      await eventually(() => signal?.aborted ? "aborted" : "waiting", "aborted");
      await eventually(() => store.getTask(orphan.taskId)?.status ?? "missing", "completed");
      expect(store.getTask(active.taskId)).toMatchObject({ status: "running", lease: { ownerId: expect.any(String) } });
      release();
      await eventually(() => store.getTask(active.taskId)?.status ?? "missing", "completed");
      await runtime.stop();
      expect(store.listAttempts(orphan.taskId).map((attempt) => attempt.status)).toEqual(["abandoned", "completed"]);
      expect(store.listAttempts(active.taskId).map((attempt) => attempt.status)).toEqual(["abandoned", "completed"]);
    } finally {
      release();
      await runtime.stop();
      store.close();
    }
  });

  it("leaves an expired non-cooperative claim for restart during shutdown", async () => {
    let clock = 2_100;
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => clock });
    const task = store.dispatch(input()).task;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    let signal: AbortSignal | undefined;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], leaseDurationMs: 100, pollIntervalMs: 1, now: () => clock,
      execute: async (context) => { entered = true; signal = context.signal; await blocked; return { result: "late" }; },
    });
    try {
      runtime.start();
      await eventually(() => entered ? "entered" : "waiting", "entered");
      clock = 2_300;
      await eventually(() => signal?.aborted ? "aborted" : "waiting", "aborted");
      await runtime.stop(10);
      expect(runtime.isIdle()).toBe(false);
      expect(store.getTask(task.taskId)).toMatchObject({ status: "running", lease: { ownerId: expect.any(String) } });
      release();
      await runtime.whenIdle();
      expect(store.getTask(task.taskId)?.status).toBe("cancelling");

      const restarted = new AsyncTaskRuntime({
        store, agentIds: () => ["agent-a"], leaseDurationMs: 100, maxAttempts: 2, retryDelayMs: 0, pollIntervalMs: 1, now: () => clock,
        execute: async () => ({ result: "restarted" }),
      });
      restarted.start();
      await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "cancelled");
      await restarted.stop();
      expect(store.listAttempts(task.taskId).map((attempt) => attempt.status)).toEqual(["abandoned"]);
      expect(store.getTask(task.taskId)?.error?.code).toBe("capability_denied");
    } finally {
      release();
      await runtime.whenIdle();
      await runtime.stop();
      store.close();
    }
  });

  it("keeps the scheduler alive when startup recovery is transiently unavailable", async () => {
    let clock = 2_100;
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => clock });
    const orphan = store.dispatch(input()).task;
    const claim = store.claimNext(orphan.agentId, { ownerId: "worker-orphan", nowMs: clock, leaseDurationMs: 100 })!;
    store.start({ taskId: orphan.taskId, expectedVersion: claim.task.version, leaseOwnerId: "worker-orphan", attempt: 1, startedAtMs: clock });
    clock = 2_300;
    const queued = store.dispatch(input()).task;
    const originalRecover = store.recoverExpiredLeases.bind(store);
    let recoveryCalls = 0;
    const mutableStore = store as unknown as { recoverExpiredLeases: typeof store.recoverExpiredLeases };
    mutableStore.recoverExpiredLeases = (...args) => {
      recoveryCalls += 1;
      if (recoveryCalls === 1) throw new Error("transient recovery busy");
      return originalRecover(...args);
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], leaseDurationMs: 100, maxAttempts: 2, retryDelayMs: 0, pollIntervalMs: 1, now: () => clock,
      execute: async (context) => ({ result: context.task.taskId === orphan.taskId ? "orphan" : "queued" }),
    });
    try {
      runtime.start();
      await eventually(() => store.getTask(queued.taskId)?.status ?? "missing", "completed");
      await eventually(() => store.getTask(orphan.taskId)?.status ?? "missing", "completed");
      expect(recoveryCalls).toBeGreaterThanOrEqual(2);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("lease recovery deferred"));
    } finally {
      await runtime.stop();
      warning.mockRestore();
      store.close();
    }
  });

  it("retries an abandoned policy transition after a transient store failure", async () => {
    let clock = 2_100;
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => clock });
    const task = store.dispatch(input()).task;
    const claim = store.claimNext(task.agentId, { ownerId: "worker-abandoned", nowMs: clock, leaseDurationMs: 100 })!;
    store.start({ taskId: task.taskId, expectedVersion: claim.task.version, leaseOwnerId: "worker-abandoned", attempt: 1, startedAtMs: clock });
    clock = 2_300;
    const originalTransition = store.transition.bind(store);
    let transitionCalls = 0;
    const mutableStore = store as unknown as { transition: typeof store.transition };
    mutableStore.transition = (request) => {
      if (request.to === "retry_wait") {
        transitionCalls += 1;
        if (transitionCalls === 1) throw new Error("transient transition busy");
      }
      return originalTransition(request);
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], leaseDurationMs: 100, maxAttempts: 2, retryDelayMs: 0, pollIntervalMs: 1, now: () => clock,
      execute: async () => ({ result: "recovered" }),
    });
    try {
      runtime.start();
      await eventually(() => String(transitionCalls), "1");
      clock = 2_400;
      runtime.wake();
      await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
      expect(transitionCalls).toBeGreaterThanOrEqual(2);
      expect(store.listAttempts(task.taskId).map((attempt) => attempt.status)).toEqual(["abandoned", "completed"]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("lease recovery deferred"));
    } finally {
      await runtime.stop();
      warning.mockRestore();
      store.close();
    }
  });

  it("uses the store's authoritative recovery timestamp when runtime time lags", async () => {
    let storeClock = 2_100;
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => storeClock });
    const task = store.dispatch(input()).task;
    const claim = store.claimNext(task.agentId, { ownerId: "worker-clock", nowMs: storeClock, leaseDurationMs: 100 })!;
    store.start({ taskId: task.taskId, expectedVersion: claim.task.version, leaseOwnerId: "worker-clock", attempt: 1, startedAtMs: storeClock });
    storeClock = 2_400;
    let runtimeNowCalls = 0;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], maxAttempts: 2, retryDelayMs: 0, pollIntervalMs: 1, leaseDurationMs: 100,
      now: () => runtimeNowCalls++ === 0 ? 2_300 : 2_400,
      execute: async () => ({ result: "clock-recovered" }),
    });
    try {
      runtime.start();
      await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
      expect(store.listAttempts(task.taskId).map((attempt) => attempt.status)).toEqual(["abandoned", "completed"]);
      expect(store.listAttempts(task.taskId)[0]?.finishedAtMs).toBe(2_400);
    } finally {
      await runtime.stop();
      store.close();
    }
  });

  it("schedules a recovered retry at the store operation time when its clock advances per operation", async () => {
    let clock = 2_100;
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => ++clock });
    const task = store.dispatch(input()).task;
    const claim = store.claimNext(task.agentId, { ownerId: "worker-clock-step", nowMs: clock, leaseDurationMs: 100 })!;
    store.start({ taskId: task.taskId, expectedVersion: claim.task.version, leaseOwnerId: "worker-clock-step", attempt: 1, startedAtMs: clock });
    clock = 2_300;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], maxAttempts: 2, retryDelayMs: 0, pollIntervalMs: 1, leaseDurationMs: 100,
      now: () => clock, execute: async () => ({ result: "clock-step-recovered" }),
    });
    try {
      runtime.start();
      await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
      expect(store.listAttempts(task.taskId).map((attempt) => attempt.status)).toEqual(["abandoned", "completed"]);
    } finally {
      await runtime.stop();
      store.close();
    }
  });

  it("stops heartbeat renewal after abort while a non-cooperative executor remains live", async () => {
    let clock = 2_100;
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => clock });
    const task = store.dispatch(input()).task;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    let signal: AbortSignal | undefined;
    let heartbeatCalls = 0;
    const originalHeartbeat = store.heartbeat.bind(store);
    const heartbeatSpy = vi.spyOn(store, "heartbeat").mockImplementation((request) => {
      heartbeatCalls += 1;
      return originalHeartbeat(request);
    });
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], leaseDurationMs: 300, pollIntervalMs: 1, now: () => clock,
      execute: async (context) => { entered = true; signal = context.signal; await blocked; return { result: "aborted" }; },
    });
    try {
      runtime.start();
      await eventually(() => entered ? "entered" : "waiting", "entered");
      await eventually(() => heartbeatCalls > 0 ? "renewing" : "waiting", "renewing");
      const beforeAbort = store.getTask(task.taskId)!;
      store.abort({
        taskId: task.taskId, agentId: task.agentId, parentTurnId: task.parentTurnId,
        intentId: "abort-live-heartbeat", expectedAbortVersion: beforeAbort.abortVersion,
        requestedAtMs: clock, reason: "user",
      });
      await eventually(() => signal?.aborted ? "aborted" : "waiting", "aborted");
      const callsAfterAbort = heartbeatCalls;
      const leaseAfterAbort = store.getTask(task.taskId)?.lease?.expiresAtMs;
      clock = 2_300;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(heartbeatCalls).toBe(callsAfterAbort);
      expect(store.getTask(task.taskId)?.lease?.expiresAtMs).toBe(leaseAfterAbort);
      release();
      await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "cancelled");
    } finally {
      release();
      await runtime.stop();
      heartbeatSpy.mockRestore();
      store.close();
    }
  });

  it("does not open claim transactions for idle bots on each poll", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const claim = vi.spyOn(store, "claimNext");
    const expiry = vi.spyOn(store, "expireBudgetExhaustedTasks");
    const runtime = new AsyncTaskRuntime({ store, agentIds: () => Array.from({ length: 20 }, (_, i) => `agent-${i}`), pollIntervalMs: 1, now: () => 2_100, execute: async () => ({ result: "unexpected" }) });
    try {
      runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(claim).not.toHaveBeenCalled();
      expect(expiry).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.stop();
      store.close();
    }
  });

  it("resumes a durable retry_wait task after the worker is restarted", async () => {
    let clock = 2_100;
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => clock });
    const task = store.dispatch(input()).task;
    const first = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, retryDelayMs: 1_000, now: () => clock,
      execute: async () => { throw new Error("crash-like transient failure"); },
    });
    first.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "retry_wait");
    await first.stop();
    clock = 3_200;
    const second = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, retryDelayMs: 0, now: () => clock,
      execute: async () => ({ result: "retry recovered", usage: { providerCalls: 0 } }),
    });
    second.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
    await second.stop();
    expect(store.listAttempts(task.taskId).map((attempt) => attempt.status)).toEqual(["retry_wait", "completed"]);
    store.close();
  });

  it("fences parent deletion and terminalizes children idempotently", () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input()).task;
    store.fenceAgent("agent-a", 1_001);
    expect(() => store.dispatch({ ...input(), agentId: "agent-a", parentTurnId: "turn-a" })).toThrow();
    expect(store.terminalizeAgentTasks("agent-a", 1_002)).toHaveLength(1);
    expect(store.getTask(task.taskId)).toMatchObject({ status: "cancelled", error: { code: "aborted" } });
    expect(store.terminalizeAgentTasks("agent-a", 1_003)).toEqual([]);
    store.clearAgentFence("agent-a");
    store.close();
  });

  it("keeps projection unacknowledged with no delivery receipt and advances per-agent sequence durably", () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input()).task;
    const envelopes = store.projectUndelivered();
    expect(envelopes).toHaveLength(2);
    expect(envelopes.map((entry) => entry.channel)).toEqual(["async-tasks", "subagents"]);
    expect(envelopes[0]).toMatchObject({ agentId: "agent-a", taskId: task.taskId, sequence: 1 });
    expect(store.acknowledgeProjection(envelopes[0]!.projectionId, false, 2_101)).toBe(false);
    expect(store.listUndeliveredProjections()).toHaveLength(2);
    const [retry] = store.projectUndelivered();
    expect(retry).toMatchObject({ projectionId: envelopes[0]!.projectionId, sequence: 1 });
    expect(store.acknowledgeProjection(envelopes[0]!.projectionId, true, 2_102)).toBe(true);
    expect(store.listUndeliveredOutbox()).toHaveLength(1);
    expect(store.acknowledgeProjection(envelopes[1]!.projectionId, true, 2_103)).toBe(true);
    expect(store.listUndeliveredProjections()).toHaveLength(0);
    expect(store.listUndeliveredOutbox()).toHaveLength(0);
    store.close();
  });

  it("recovers after a transient projection transport failure without stopping the worker", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input()).task;
    let publishCalls = 0;
    const runtime = new AsyncTaskRuntime({
      store,
      agentIds: () => ["agent-a"],
      pollIntervalMs: 1,
      now: () => 2_100,
      execute: async () => ({ result: "ok" }),
      publishProjection: async () => {
        publishCalls += 1;
        if (publishCalls === 1) throw new Error("temporary transport failure");
        return true;
      },
    });
    runtime.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
    await eventually(() => store.listUndeliveredProjections().length === 0 ? "delivered" : "pending", "delivered");
    await runtime.stop();
    expect(publishCalls).toBeGreaterThan(1);
    store.close();
  });

  it("recovers after a transient runnable-agent scan failure without stopping the worker", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input()).task;
    const originalRunnableAgentIds = store.runnableAgentIds.bind(store);
    let scanCalls = 0;
    vi.spyOn(store, "runnableAgentIds").mockImplementation((nowMs) => {
      scanCalls += 1;
      if (scanCalls === 1) throw new Error("temporary admission scan failure");
      return originalRunnableAgentIds(nowMs);
    });
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, now: () => 2_100,
      execute: async () => ({ result: "recovered" }),
    });
    runtime.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
    await runtime.stop();
    expect(scanCalls).toBeGreaterThan(1);
    expect(runtime.isIdle()).toBe(true);
    store.close();
  });

  it("waits for an active claim to drain when admission scanning fails", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input()).task;
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    let entered = false;
    const originalRunnableAgentIds = store.runnableAgentIds.bind(store);
    let scanCalls = 0;
    vi.spyOn(store, "runnableAgentIds").mockImplementation((nowMs) => {
      scanCalls += 1;
      if (scanCalls === 2) throw new Error("admission scan unavailable while claim is active");
      return originalRunnableAgentIds(nowMs);
    });
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], maxConcurrentTasks: 2, pollIntervalMs: 1, now: () => 2_100,
      execute: async () => { entered = true; await blocked; return { result: "drained" }; },
    });
    runtime.start();
    await eventually(() => entered ? "entered" : "waiting", "entered");
    await runtime.stop(10);
    expect(runtime.isIdle()).toBe(false);
    finish();
    await runtime.whenIdle();
    expect(runtime.isIdle()).toBe(true);
    expect(store.getTask(task.taskId)?.status).toBe("cancelled");
    store.close();
  });
});
