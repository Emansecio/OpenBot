import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AsyncTaskRuntime } from "../src/tasks/runtime.js";
import { AsyncTaskStore, useTemporaryDatabases, budget, dispatchInput } from "./helpers/async-task-store.js";

const temporaryDatabasePath = useTemporaryDatabases();

describe("AsyncTaskStore recovery", () => {
  it("recovers an admitted attempt whose owner never started it", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-admitted", nowMs: 1_100, leaseDurationMs: 100 });
      expect(store.recoverExpiredLeases(1_200)).toEqual([
        expect.objectContaining({ taskId: task.taskId, status: "abandoned", version: 3 }),
      ]);
      expect(store.listAttempts(task.taskId)[0]).toMatchObject({ status: "abandoned", error: { code: "internal_error" } });
      expect(store.listUndeliveredOutbox().at(-1)).toMatchObject({
        wakeKind: "task_recovered", payload: { status: "abandoned", attempt: 1, code: "internal_error" },
      });
    } finally {
      store.close();
    }
  });

  it("abandons expired leased attempts atomically and fences the former worker before a policy retry", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-dead", nowMs: 1_100, leaseDurationMs: 500 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-dead", attempt: 1, startedAtMs: 1_120 });
      expect(store.recoverExpiredLeases(1_599)).toEqual([]);

      const recovered = store.recoverExpiredLeases(1_600);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ taskId: task.taskId, status: "abandoned", version: 4, lease: null });
      expect(store.listAttempts(task.taskId)[0]).toMatchObject({ status: "abandoned", lease: null, finishedAtMs: 1_600 });
      expect(store.listUndeliveredOutbox().at(-1)).toMatchObject({ transitionVersion: 4, wakeKind: "task_recovered" });
      expect(() => store.heartbeat({ taskId: task.taskId, expectedVersion: 3, leaseOwnerId: "worker-dead", attempt: 1, nowMs: 1_601, leaseDurationMs: 500 })).toThrow();

      const waiting = store.transition({ taskId: task.taskId, expectedVersion: 4, to: "retry_wait", atMs: 1_610, nextAttemptAtMs: 1_700 });
      expect(waiting).toMatchObject({ status: "retry_wait", version: 5, attempt: 1 });
      expect(store.claimNext(task.agentId, { ownerId: "worker-new", nowMs: 1_700, leaseDurationMs: 500 })?.task.attempt).toBe(2);
    } finally {
      store.close();
    }
  });

  it("keeps an abandoned unsafe effect terminal instead of requeueing it", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-dead-effect", nowMs: 1_100, leaseDurationMs: 500 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-dead-effect", attempt: 1, startedAtMs: 1_120 });
      store.markUnsafeEffectStarted({ taskId: task.taskId, expectedVersion: 3, leaseOwnerId: "worker-dead-effect", attempt: 1, markedAtMs: 1_130 });
      const recovered = store.recoverExpiredLeases(1_600)[0]!;
      expect(recovered.status).toBe("abandoned");
      expect(store.listAttempts(task.taskId)[0]?.unsafeEffectStarted).toBe(true);
      const failed = store.transition({
        taskId: task.taskId, expectedVersion: recovered.version, to: "failed", atMs: 1_600,
        error: { code: "internal_error", message: "Task effect outcome is uncertain after lease recovery; automatic retry is blocked.", retryable: false },
      });
      expect(failed).toMatchObject({ status: "failed", error: { retryable: false } });
      expect(() => store.claimNext(task.agentId, { ownerId: "worker-new", nowMs: 1_700, leaseDurationMs: 500 })).not.toThrow();
      expect(store.listAttempts(task.taskId).map((entry) => entry.status)).toEqual(["abandoned"]);
    } finally {
      store.close();
    }
  });

  it("terminalizes a conservative legacy retry-wait marker before claiming", () => {
    const databasePath = temporaryDatabasePath();
    const store = new AsyncTaskStore({ path: databasePath });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-legacy", nowMs: 1_100, leaseDurationMs: 500 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-legacy", attempt: 1, startedAtMs: 1_120 });
      store.transition({
        taskId: task.taskId, expectedVersion: 3, to: "retry_wait", atMs: 1_200,
        leaseOwnerId: "worker-legacy", attempt: 1, nextAttemptAtMs: 1_300,
        error: { code: "provider_error", message: "legacy retry", retryable: true },
      });
      const legacyConnection = new Database(databasePath);
      legacyConnection.prepare("UPDATE async_task_attempts SET status = 'abandoned', unsafe_effect_started = 1 WHERE task_id = ? AND attempt = 1").run(task.taskId);
      legacyConnection.close();

      expect(store.claimNext(task.agentId, { ownerId: "worker-new", nowMs: 1_300, leaseDurationMs: 500 })).toBeNull();
      expect(store.getTask(task.taskId)).toMatchObject({
        status: "failed",
        error: { code: "internal_error", retryable: false, message: "Legacy retry-wait effect outcome is uncertain; automatic retry is blocked." },
      });
      expect(store.listAttempts(task.taskId).map((entry) => entry.status)).toEqual(["failed"]);
      expect(store.listUndeliveredOutbox().at(-1)).toMatchObject({ taskId: task.taskId, wakeKind: "task_terminal" });
    } finally {
      store.close();
    }
  });

  it("excludes active claim task IDs from bounded lease recovery", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const active = store.dispatch(dispatchInput({ clientNonce: "active-claim" })).task;
      const orphan = store.dispatch(dispatchInput({
        agentId: "agent-b", parentTurnId: "turn-b", clientNonce: "expired-orphan",
        input: { version: 1, objective: "Executar tarefa de teste", source: { kind: "parent_turn", agentId: "agent-b", turnEntryId: "turn-b" } },
      })).task;
      const activeClaim = store.claimNext(active.agentId, { ownerId: "worker-active", nowMs: 1_100, leaseDurationMs: 100 })!;
      store.start({ taskId: active.taskId, expectedVersion: activeClaim.task.version, leaseOwnerId: "worker-active", attempt: 1, startedAtMs: 1_100 });
      const orphanClaim = store.claimNext(orphan.agentId, { ownerId: "worker-orphan", nowMs: 1_100, leaseDurationMs: 100 })!;
      store.start({ taskId: orphan.taskId, expectedVersion: orphanClaim.task.version, leaseOwnerId: "worker-orphan", attempt: 1, startedAtMs: 1_100 });

      const recovered = store.recoverExpiredLeases(1_200, undefined, [active.taskId]);
      expect(recovered).toEqual([expect.objectContaining({ taskId: orphan.taskId, status: "abandoned" })]);
      expect(store.getTask(active.taskId)).toMatchObject({ status: "running", lease: { ownerId: "worker-active", attempt: 1 } });
      expect(store.recoverExpiredLeases(1_200, undefined, [active.taskId])).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("terminalizes a revoked abandoned lease durably instead of leaving it stuck", async () => {
    let clock = 1_100;
    const store = new AsyncTaskStore({ path: temporaryDatabasePath(), now: () => clock });
    try {
      const task = store.dispatch(dispatchInput()).task;
      const claimed = store.claimNext(task.agentId, { ownerId: "worker-revoked", nowMs: clock, leaseDurationMs: 500 })!;
      store.start({ taskId: task.taskId, expectedVersion: claimed.task.version, leaseOwnerId: "worker-revoked", attempt: 1, startedAtMs: clock });
      clock = 1_300;
      store.revokeGrant(task.taskId, 1, clock);
      clock = 1_301;
      const runtime = new AsyncTaskRuntime({
        store, agentIds: () => [task.agentId], pollIntervalMs: 1, now: () => clock,
        execute: async () => ({ result: "must not execute" }),
      });
      runtime.start();
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && store.getTask(task.taskId)?.status !== "cancelled") await new Promise((resolve) => setTimeout(resolve, 10));
      expect(store.getTask(task.taskId)).toMatchObject({ status: "cancelled", error: { code: "capability_denied" } });
      expect(store.listUndeliveredOutbox().some((event) => event.taskId === task.taskId && event.wakeKind === "task_terminal")).toBe(true);
      expect(store.settleTask(task.taskId, task.agentId, "revoked-settlement", clock)).toMatchObject({ settledAtMs: clock });
      await runtime.stop();
    } finally {
      store.close();
    }
  });

  it("terminalizes a revoked abandoned lease after retry exhaustion across restart", async () => {
    const dbPath = temporaryDatabasePath();
    let clock = 1_100;
    const firstStore = new AsyncTaskStore({ path: dbPath, now: () => clock });
    const task = firstStore.dispatch(dispatchInput()).task;
    const claimed = firstStore.claimNext(task.agentId, { ownerId: "worker-exhausted", nowMs: clock, leaseDurationMs: 500 })!;
    firstStore.start({ taskId: task.taskId, expectedVersion: claimed.task.version, leaseOwnerId: "worker-exhausted", attempt: 1, startedAtMs: clock });
    clock = 1_300;
    firstStore.revokeGrant(task.taskId, 1, clock);
    firstStore.close();

    const store = new AsyncTaskStore({ path: dbPath, now: () => clock });
    try {
      const runtime = new AsyncTaskRuntime({
        store, agentIds: () => [task.agentId], maxAttempts: 1, pollIntervalMs: 1, now: () => clock,
        execute: async () => ({ result: "must not execute" }),
      });
      runtime.start();
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && store.getTask(task.taskId)?.status !== "cancelled") await new Promise((resolve) => setTimeout(resolve, 10));
      expect(store.getTask(task.taskId)).toMatchObject({ status: "cancelled", error: { code: "capability_denied" } });
      expect(store.listUndeliveredOutbox().some((event) => event.taskId === task.taskId && event.wakeKind === "task_terminal")).toBe(true);
      expect(store.settleTask(task.taskId, task.agentId, "exhausted-restart-settlement", clock)).toMatchObject({ settledAtMs: clock });
      await runtime.stop();
    } finally {
      store.close();
    }
  });

  it("recovers each agent independently after restart without leaving another agent abandoned", async () => {
    const dbPath = temporaryDatabasePath();
    let clock = 1_100;
    const firstStore = new AsyncTaskStore({ path: dbPath, now: () => clock });
    const taskA = firstStore.dispatch(dispatchInput({ clientNonce: "multi-agent-a" })).task;
    const taskB = firstStore.dispatch(dispatchInput({
      agentId: "agent-b", clientNonce: "multi-agent-b",
      input: { version: 1, objective: "Executar tarefa de teste", source: { kind: "parent_turn", agentId: "agent-b", turnEntryId: "turn-parent" } },
    })).task;
    const claimA = firstStore.claimNext(taskA.agentId, { ownerId: "worker-a", nowMs: clock, leaseDurationMs: 100 })!;
    firstStore.start({ taskId: taskA.taskId, expectedVersion: claimA.task.version, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: clock });
    const claimB = firstStore.claimNext(taskB.agentId, { ownerId: "worker-b", nowMs: clock, leaseDurationMs: 100 })!;
    firstStore.start({ taskId: taskB.taskId, expectedVersion: claimB.task.version, leaseOwnerId: "worker-b", attempt: 1, startedAtMs: clock });
    clock = 1_300;
    firstStore.revokeGrant(taskA.taskId, 1, clock);
    firstStore.close();

    const store = new AsyncTaskStore({ path: dbPath, now: () => clock });
    try {
      const runtime = new AsyncTaskRuntime({
        store, agentIds: () => ["agent-a", "agent-b"], maxAttempts: 2, pollIntervalMs: 1, retryDelayMs: 0, now: () => clock,
        execute: async (context) => ({ result: `completed-${context.task.agentId}` }),
      });
      runtime.start();
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && store.getTask(taskB.taskId)?.status !== "completed") await new Promise((resolve) => setTimeout(resolve, 10));
      expect(store.getTask(taskA.taskId)).toMatchObject({ status: "cancelled", error: { code: "capability_denied" } });
      expect(store.getTask(taskB.taskId)).toMatchObject({ status: "completed" });
      expect(store.listTasks().every((task) => task.status !== "abandoned")).toBe(true);
      expect(store.listUndeliveredOutbox().some((event) => event.taskId === taskA.taskId && event.wakeKind === "task_terminal")).toBe(true);
      expect(store.listAttempts(taskB.taskId).map((attempt) => attempt.status)).toEqual(["abandoned", "completed"]);
      expect(store.settleTask(taskA.taskId, taskA.agentId, "multi-agent-a-settlement", clock)).toMatchObject({ settledAtMs: clock });
      expect(store.settleTask(taskB.taskId, taskB.agentId, "multi-agent-b-settlement", clock)).toMatchObject({ settledAtMs: clock });
      await runtime.stop();
    } finally {
      store.close();
    }
  });
});

describe("AsyncTaskStore queued deadline sweep", () => {
  it("terminally cancels expired queued and retry-wait tasks with budget_exhausted before claim", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const queuedBase = dispatchInput({ clientNonce: "expired-queued" });
      const shortBudget = { ...queuedBase.budget, maxWallMs: 300 };
      const queued = store.dispatch({ ...queuedBase, budget: shortBudget, grant: { ...queuedBase.grant, expiresAt: 1_300 } }).task;

      const retryBase = dispatchInput({ agentId: "agent-retry", clientNonce: "expired-retry" });
      const retry = store.dispatch({ ...retryBase, budget: shortBudget, grant: { ...retryBase.grant, expiresAt: 1_300 } }).task;
      store.claimNext(retry.agentId, { ownerId: "worker-r", nowMs: 1_100, leaseDurationMs: 100 });
      store.start({ taskId: retry.taskId, expectedVersion: 2, leaseOwnerId: "worker-r", attempt: 1, startedAtMs: 1_120 });
      store.transition({
        taskId: retry.taskId, expectedVersion: 3, to: "retry_wait", atMs: 1_180,
        leaseOwnerId: "worker-r", attempt: 1, nextAttemptAtMs: 1_250,
        error: { code: "provider_error", message: "retry", retryable: true },
      });
      const history = store.listAttempts(retry.taskId);

      expect(store.claimNext(queued.agentId, { ownerId: "worker-next", nowMs: 1_300, leaseDurationMs: 100 })).toBeNull();
      expect(store.getTask(queued.taskId)).toMatchObject({ status: "cancelled", version: 2, error: { code: "budget_exhausted" } });
      expect(store.getTask(retry.taskId)).toMatchObject({ status: "cancelled", version: 5, error: { code: "budget_exhausted" } });
      expect(store.listAttempts(retry.taskId)).toEqual(history);
      expect(store.expireBudgetExhaustedTasks(1_301)).toEqual([]);
      for (const taskId of [queued.taskId, retry.taskId]) {
        expect(store.getGrant(taskId)).toMatchObject({ revokedAt: 1_300, version: 2 });
        expect(store.listUndeliveredOutbox().filter((event) => event.taskId === taskId).at(-1))
          .toMatchObject({ wakeKind: "task_terminal", payload: { status: "cancelled", code: "budget_exhausted" } });
      }
    } finally {
      store.close();
    }
  });
});
