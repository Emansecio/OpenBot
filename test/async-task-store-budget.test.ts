
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  BudgetCounters,
  SubagentBudget,
} from "../src/tasks/contracts.js";
import { AsyncTaskStore as DurableAsyncTaskStore } from "../src/tasks/store.js";
import { deriveEffectiveBudget, deriveEffectiveGrant } from "../src/tasks/state-machine.js";
import { AsyncTaskStore, useTemporaryDatabases, budget, zeroCounters, dispatchInput } from "./helpers/async-task-store.js";

const temporaryDatabasePath = useTemporaryDatabases();

describe("AsyncTaskStore shared budget", () => {
  it("reserves one durable parent-turn cap across children and restart", () => {
    const dbPath = temporaryDatabasePath();
    const parentBudget: SubagentBudget = { ...budget, maxProviderCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, maxToolRounds: 1, maxToolCalls: 1, maxMcpCalls: 1, maxBrowserCommands: 1, maxResultBytes: 100, maxWorkspaceWriteBytes: 100 };
    const firstStore = new AsyncTaskStore({ path: dbPath });
    try {
      const first = firstStore.dispatch(dispatchInput({ parentBudget, budget: parentBudget, clientNonce: "parent-one" })).task;
      expect(first.status).toBe("queued");
      const clipped = firstStore.dispatch(dispatchInput({ parentBudget, budget: parentBudget, clientNonce: "parent-two" })).task;
      expect(firstStore.getBudgetState(clipped.taskId)?.budget.maxProviderCalls).toBe(0);
    } finally {
      firstStore.close();
    }
    const restarted = new AsyncTaskStore({ path: dbPath });
    try {
      const afterRestart = restarted.dispatch(dispatchInput({ parentBudget, budget: parentBudget, clientNonce: "parent-three" })).task;
      expect(restarted.getBudgetState(afterRestart.taskId)?.budget.maxProviderCalls).toBe(0);
    } finally {
      restarted.close();
    }
  });

  it("settles consumed and unused child reservations back into the durable parent ledger across reopen", () => {
    const dbPath = temporaryDatabasePath();
    const parentBudget: SubagentBudget = {
      ...budget, maxProviderCalls: 3, maxToolRounds: 3, maxToolCalls: 3,
      maxMcpCalls: 3, maxBrowserCommands: 3, maxInputTokens: 100, maxOutputTokens: 100,
      maxResultBytes: 100, maxWorkspaceWriteBytes: 100,
    };
    const oneEffect = { ...zeroCounters, toolRounds: 1, toolCalls: 1 };
    const finish = (store: AsyncTaskStore, task: ReturnType<AsyncTaskStore["dispatch"]>["task"], owner: string, actual: BudgetCounters, atMs: number) => {
      const claimed = store.claimNext(task.agentId, { ownerId: owner, nowMs: atMs, leaseDurationMs: 1_000 })!;
      store.start({ taskId: task.taskId, expectedVersion: claimed.task.version, leaseOwnerId: owner, attempt: 1, startedAtMs: atMs + 1 });
      if (actual.toolRounds !== 0 || actual.toolCalls !== 0) {
        store.reserveTaskBudget(task.taskId, 1, { reservationId: `${owner}-effect`, amounts: oneEffect }, { leaseOwnerId: owner, attempt: 1, expectedTaskVersion: claimed.task.version + 1 }, atMs + 1);
        store.reconcileTaskBudget(task.taskId, 2, `${owner}-effect`, actual, { leaseOwnerId: owner, attempt: 1, expectedTaskVersion: claimed.task.version + 1 }, atMs + 2);
      }
      store.commitTerminal({
        taskId: task.taskId, expectedVersion: claimed.task.version + 1, leaseOwnerId: owner, attempt: 1,
        status: "completed", finishedAtMs: atMs + 3,
        result: { kind: "inline", text: "ok", bytes: 2, truncated: false }, error: null,
        wakeKind: "task_terminal", wakePayload: { status: "completed", attempt: 1, summary: "ok", code: null, resultRef: null },
      });
    };
    const firstStore = new AsyncTaskStore({ path: dbPath });
    const first = firstStore.dispatch(dispatchInput({ parentTurnId: "turn-ledger", clientNonce: "ledger-one", parentBudget, budget: { ...parentBudget, maxToolRounds: 2, maxToolCalls: 2 } })).task;
    expect(firstStore.getBudgetState(first.taskId)?.budget.maxToolCalls).toBe(2);
    finish(firstStore, first, "ledger-worker-1", oneEffect, 1_100);
    const second = firstStore.dispatch(dispatchInput({ parentTurnId: "turn-ledger", clientNonce: "ledger-two", parentBudget, budget: { ...parentBudget, maxToolRounds: 3, maxToolCalls: 3 } })).task;
    expect(firstStore.getBudgetState(second.taskId)?.budget.maxToolCalls).toBe(2);
    firstStore.close();

    const reopened = new AsyncTaskStore({ path: dbPath });
    try {
      finish(reopened, second, "ledger-worker-2", zeroCounters, 1_200);
      const third = reopened.dispatch(dispatchInput({ parentTurnId: "turn-ledger", clientNonce: "ledger-three", parentBudget, budget: { ...parentBudget, maxToolRounds: 3, maxToolCalls: 3 } })).task;
      expect(reopened.getBudgetState(third.taskId)?.budget.maxToolCalls).toBe(2);
    } finally {
      reopened.close();
    }
  });

  it("fences reserve and reconcile to the current task lease across recovery and retry", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      const first = store.claimNext(task.agentId, { ownerId: "worker-1", nowMs: 1_100, leaseDurationMs: 100 })!;
      const firstFence = { leaseOwnerId: "worker-1", attempt: 1, expectedTaskVersion: first.task.version };
      const oneTool = { ...zeroCounters, toolCalls: 1 };
      expect(() => store.reserveTaskBudget(task.taskId, 1, { reservationId: "before-attempt", amounts: oneTool }, firstFence, 1_050)).toThrow();
      expect(store.getBudgetState(task.taskId)?.version).toBe(1);
      store.reserveTaskBudget(task.taskId, 1, { reservationId: "attempt-1", amounts: oneTool }, firstFence, 1_100);
      expect(() => store.reserveTaskBudget(task.taskId, 2, { reservationId: "attempt-1", amounts: oneTool }, firstFence, 1_110)).toThrow();
      expect(() => store.reserveTaskBudget(task.taskId, 2, {
        reservationId: "over-cap", amounts: { ...zeroCounters, toolCalls: budget.maxToolCalls + 1 },
      }, firstFence, 1_110)).toThrow();

      store.recoverExpiredLeases(1_200);
      store.transition({ taskId: task.taskId, expectedVersion: 3, to: "retry_wait", atMs: 1_210, nextAttemptAtMs: 1_300 });
      const second = store.claimNext(task.agentId, { ownerId: "worker-2", nowMs: 1_300, leaseDurationMs: 500 })!;
      expect(() => store.reserveTaskBudget(task.taskId, 2, { reservationId: "stale-reserve", amounts: oneTool }, firstFence, 1_310)).toThrow();
      expect(() => store.reconcileTaskBudget(task.taskId, 2, "attempt-1", oneTool, firstFence, 1_310)).toThrow();
      expect(store.getBudgetState(task.taskId)?.usage.reservations).toEqual([{ reservationId: "attempt-1", amounts: oneTool }]);

      const secondFence = { leaseOwnerId: "worker-2", attempt: 2, expectedTaskVersion: second.task.version };
      const reserved = store.reserveTaskBudget(task.taskId, 2, { reservationId: "attempt-2", amounts: oneTool }, secondFence, 1_310);
      expect(reserved.usage.reservations.map((entry) => entry.reservationId)).toEqual(["attempt-1", "attempt-2"]);
      const reconciled = store.reconcileTaskBudget(task.taskId, 3, "attempt-2", oneTool, secondFence, 1_320);
      expect(reconciled.usage).toMatchObject({ used: oneTool, reservations: [{ reservationId: "attempt-1" }] });
    } finally {
      store.close();
    }
  });

  it("reserves and reconciles counters with CAS and keeps the same usage across restart", () => {
    const databasePath = temporaryDatabasePath();
    const first = new AsyncTaskStore({ path: databasePath });
    const task = first.dispatch(dispatchInput()).task;
    const claimed = first.claimNext(task.agentId, { ownerId: "worker-budget", nowMs: 1_050, leaseDurationMs: 2_000 })!;
    const fence = { leaseOwnerId: "worker-budget", attempt: 1, expectedTaskVersion: claimed.task.version };
    const amounts = { ...zeroCounters, providerCalls: 1, inputTokens: 100, outputTokens: 50 };
    const reserved = first.reserveTaskBudget(task.taskId, 1, { reservationId: "provider-call-1", amounts }, fence, 1_100);
    expect(reserved).toMatchObject({ version: 2, usage: { reserved: amounts, reservations: [{ reservationId: "provider-call-1" }] } });
    expect(() => first.reserveTaskBudget(task.taskId, 1, { reservationId: "stale", amounts }, fence, 1_101)).toThrow();
    first.close();

    const reopened = new AsyncTaskStore({ path: databasePath });
    try {
      expect(reopened.getBudgetState(task.taskId)).toEqual(reserved);
      const actual = { ...zeroCounters, providerCalls: 1, inputTokens: 90, outputTokens: 40 };
      const reconciled = reopened.reconcileTaskBudget(task.taskId, 2, "provider-call-1", actual, fence, 1_200);
      expect(reconciled).toMatchObject({ version: 3, usage: { used: actual, reserved: zeroCounters, reservations: [] } });
    } finally {
      reopened.close();
    }
  });
});

describe("AsyncTaskStore capability grant", () => {
  it("advances an already scheduled future revocation to authoritative abort time", () => {
    let clock = 1_100;
    const store = new AsyncTaskStore({ path: temporaryDatabasePath(), now: () => clock });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.revokeGrant(task.taskId, 1, 5_000);
      clock = 1_200;
      store.abort({
        taskId: task.taskId, agentId: task.agentId, parentTurnId: task.parentTurnId,
        intentId: randomUUID(), expectedAbortVersion: 0, requestedAtMs: 1_150, reason: "parent",
      });
      expect(store.getGrant(task.taskId)).toMatchObject({ revokedAt: 1_200, version: 3 });
    } finally {
      store.close();
    }
  });

  it("revokes the persisted canonical grant by version CAS without changing task lineage", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      const revoked = store.revokeGrant(task.taskId, 1, 1_500);
      expect(revoked).toMatchObject({ taskId: task.taskId, version: 2, revokedAt: 1_500 });
      expect(store.getTask(task.taskId)?.lineage).toEqual(task.lineage);
      expect(() => store.revokeGrant(task.taskId, 1, 1_501)).toThrow();
    } finally {
      store.close();
    }
  });

  it("keeps a future revocation active before its boundary and clips the persisted lease to it", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      const claimed = store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 5_000 })!;
      expect(claimed.lease.expiresAtMs).toBe(6_100);
      store.revokeGrant(task.taskId, 1, 1_500);
      expect(store.getTask(task.taskId)?.lease?.expiresAtMs).toBe(1_500);
      const started = store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_400 });
      expect(started.status).toBe("running");
      expect(store.heartbeat({ taskId: task.taskId, expectedVersion: 3, leaseOwnerId: "worker-a", attempt: 1, nowMs: 1_499, leaseDurationMs: 500 }).lease?.expiresAtMs).toBe(1_500);
      expect(() => store.heartbeat({ taskId: task.taskId, expectedVersion: 4, leaseOwnerId: "worker-a", attempt: 1, nowMs: 1_500, leaseDurationMs: 500 })).toThrow();
    } finally {
      store.close();
    }
  });

  it("terminalizes a queued task when a scheduled revocation boundary is reached", () => {
    let clock = 1_100;
    const store = new AsyncTaskStore({ path: temporaryDatabasePath(), now: () => clock });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.revokeGrant(task.taskId, 1, 1_500);
      expect(store.getTask(task.taskId)?.status).toBe("queued");
      clock = 1_500;
      expect(store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: clock, leaseDurationMs: 1_000 })).toBeNull();
      expect(store.getTask(task.taskId)).toMatchObject({ status: "cancelled", error: { code: "capability_denied" } });
      expect(store.listUndeliveredOutbox().some((event) => event.wakeKind === "task_terminal" && event.payload.code === "capability_denied")).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("AsyncTaskStore derived contract round trip", () => {
  it("dispatches a derived zero-dimension budget and a grant with a future scheduled revocation", () => {
    const base = dispatchInput();
    const scheduledGrant = { ...base.grant, revokedAt: 1_500 };
    const grant = deriveEffectiveGrant(scheduledGrant, scheduledGrant, scheduledGrant, 1_000);
    const parentRemaining = { ...base.budget, maxProviderCalls: 0, maxMcpCalls: 0 };
    const derivedBudget = deriveEffectiveBudget(base.budget, parentRemaining, base.budget);
    expect(derivedBudget.maxProviderCalls).toBe(0);
    const store = new AsyncTaskStore({ path: temporaryDatabasePath(), now: () => 1_100 });
    try {
      const task = store.dispatch({ ...base, grant, budget: derivedBudget }).task;
      expect(store.getBudgetState(task.taskId)?.budget).toEqual(derivedBudget);
      expect(store.getGrant(task.taskId)?.revokedAt).toBe(1_500);
      expect(store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 1_000 })?.lease.expiresAtMs).toBe(1_500);
      const inactive = dispatchInput({ clientNonce: "revoked-at-creation" });
      expect(() => store.dispatch({ ...inactive, grant: { ...inactive.grant, revokedAt: inactive.createdAtMs } })).toThrow();
      expect(store.getTask(inactive.taskId)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("atomically materializes a zero-wall derived budget as an already terminal logical task", () => {
    const databasePath = temporaryDatabasePath();
    const base = dispatchInput({ clientNonce: "zero-wall" });
    const effectiveBudget = deriveEffectiveBudget(base.budget, { ...base.budget, maxWallMs: 0 }, base.budget);
    const effectiveGrant = deriveEffectiveGrant(base.grant, base.grant, base.grant, base.createdAtMs);
    const input = { ...base, budget: effectiveBudget, grant: effectiveGrant };
    const first = new AsyncTaskStore({ path: databasePath });
    let created: ReturnType<DurableAsyncTaskStore["dispatch"]>;
    try {
      created = first.dispatch(input);
      expect(created).toMatchObject({
        created: true,
        task: { status: "cancelled", version: 2, attempt: 0, finishedAtMs: base.createdAtMs, error: { code: "budget_exhausted" } },
      });
      expect(first.getGrant(base.taskId)).toMatchObject({ version: 2, revokedAt: base.createdAtMs });
      expect(first.listUndeliveredOutbox().map((event) => [event.wakeKind, event.transitionVersion]))
        .toEqual([["task_created", 1], ["task_terminal", 2]]);
    } finally {
      first.close();
    }

    const reopened = new AsyncTaskStore({ path: databasePath });
    try {
      expect(reopened.dispatch(input)).toEqual({ task: created.task, created: false });
      expect(reopened.listAttempts(base.taskId)).toEqual([]);
      expect(reopened.listUndeliveredOutbox()).toHaveLength(2);
    } finally {
      reopened.close();
    }
  });
});
