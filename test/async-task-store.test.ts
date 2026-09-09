import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { migrateOpenBotSchema, OPENBOT_SCHEMA_VERSION } from "../src/store/schema.js";
import { AsyncTaskRuntime } from "../src/tasks/runtime.js";
import type {
  BudgetCounters,
  DispatchAsyncTaskInput,
  ProviderCapabilityGrant,
  SubagentBudget,
} from "../src/tasks/contracts.js";
import { AsyncTaskStore as DurableAsyncTaskStore } from "../src/tasks/store.js";
import type { AsyncTaskStoreOptions } from "../src/tasks/store.js";
import {
  TASK_RESULT_MIN_TRUNCATION_MARKER,
  TASK_RESULT_TRUNCATION_MARKER,
  assertGrantAllowsOperation,
  deriveEffectiveBudget,
  deriveEffectiveGrant,
} from "../src/tasks/state-machine.js";

type TestAsyncTaskStoreOptions = Omit<AsyncTaskStoreOptions, "sensitiveValues"> & {
  readonly sensitiveValues?: AsyncTaskStoreOptions["sensitiveValues"];
};

class AsyncTaskStore extends DurableAsyncTaskStore {
  constructor(options: TestAsyncTaskStoreOptions) {
    let clock = 1_000;
    super({ ...options, sensitiveValues: options.sensitiveValues ?? (() => []), now: options.now ?? (() => clock) });
    if (options.now !== undefined) return this;
    return new Proxy(this, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const input = args[0] as Record<string, unknown> | undefined;
          if (property === "claimNext") clock = Number((args[1] as Record<string, unknown>).nowMs);
          else if (property === "start") clock = Number(input?.startedAtMs);
          else if (property === "heartbeat") clock = Number(input?.nowMs);
          else if (property === "transition") clock = Number(input?.atMs);
          else if (property === "recordProgress") clock = Number((input?.progress as Record<string, unknown> | undefined)?.updatedAtMs);
          else if (property === "steer" || property === "abort") clock = Number(input?.requestedAtMs);
          else if (property === "commitTerminal") clock = Number(input?.finishedAtMs);
          else if ((property === "expireBudgetExhaustedTasks" || property === "recoverExpiredLeases") && args[0] !== undefined) clock = Number(args[0]);
          else if (property === "reserveTaskBudget" && args[4] !== undefined) clock = Number(args[4]);
          else if (property === "reconcileTaskBudget" && args[5] !== undefined) clock = Number(args[5]);
          return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporaryDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "openbot-async-task-"));
  tempDirs.push(dir);
  return join(dir, "openbot.sqlite");
}

const budget: SubagentBudget = {
  maxWallMs: 60_000,
  maxProviderCalls: 4,
  maxInputTokens: 10_000,
  maxOutputTokens: 5_000,
  maxToolRounds: 8,
  maxToolCalls: 20,
  maxMcpCalls: 10,
  maxBrowserCommands: 10,
  maxResultBytes: 4_096,
  maxWorkspaceWriteBytes: 100_000,
  maxDepth: 1,
};

const zeroCounters: BudgetCounters = {
  providerCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  toolRounds: 0,
  toolCalls: 0,
  mcpCalls: 0,
  browserCommands: 0,
  resultBytes: 0,
  workspaceWriteBytes: 0,
};

function dispatchInput(overrides: Partial<DispatchAsyncTaskInput> = {}): DispatchAsyncTaskInput {
  const taskId = overrides.taskId ?? randomUUID();
  const agentId = overrides.agentId ?? "agent-a";
  const parentTurnId = overrides.parentTurnId ?? "turn-parent";
  const childRunId = overrides.lineage?.childRunId ?? randomUUID();
  const grant: ProviderCapabilityGrant = {
    grantId: randomUUID(),
    taskId,
    parentAgentId: agentId,
    parentTurnId,
    childRunId,
    kind: "provider",
    constraints: {
      adapters: ["openai"],
      models: ["gpt-test"],
      credentialRefs: [{ secretRef: "provider/openai/test" }],
      allowNoCredential: false,
    },
    issuedAt: 900,
    expiresAt: 61_000,
    version: 1,
    depth: 1,
  };
  return {
    taskId,
    agentId,
    parentTurnId,
    kind: "subagent",
    clientNonce: "nonce-a",
    createdAtMs: 1_000,
    lineage: {
      parentAgentId: agentId,
      parentTurnId,
      parentTaskId: null,
      childRunId,
      depth: 1,
    },
    grant,
    budget,
    input: {
      version: 1,
      objective: "Executar tarefa de teste",
      source: { kind: "parent_turn", agentId, turnEntryId: parentTurnId },
    },
    ...overrides,
  };
}

describe("AsyncTaskStore dispatch", () => {
  it("requires a valid sensitive-value provider and fails closed on unsafe callback output", () => {
    const open = (options: object) => {
      const store = new DurableAsyncTaskStore(options as AsyncTaskStoreOptions);
      store.close();
    };
    expect(() => open({ path: temporaryDatabasePath() })).toThrow();
    expect(() => open({ path: temporaryDatabasePath(), sensitiveValues: () => ["x"] })).toThrow();
    expect(() => open({ path: temporaryDatabasePath(), sensitiveValues: () => ["    "] })).toThrow();
    expect(() => open({ path: temporaryDatabasePath(), sensitiveValues: () => ["[redacted]"] })).toThrow();
    expect(() => open({ path: temporaryDatabasePath(), sensitiveValues: () => null })).toThrow();
    expect(() => open({ path: temporaryDatabasePath(), sensitiveValues: () => [] })).not.toThrow();
  });

  it("rejects known sensitive values anywhere in the durable task scope or grant before inserting rows", () => {
    const database = new Database(":memory:");
    const knownSecret = "xai-aggregate-secret";
    const store = new AsyncTaskStore({ path: ":memory:", database, sensitiveValues: () => [knownSecret] });
    try {
      const inputs = [
        (() => {
          const input = dispatchInput({ clientNonce: "secret-model" });
          const grant = input.grant as ProviderCapabilityGrant;
          return { ...input, grant: { ...grant, constraints: { ...grant.constraints, models: [`model/${knownSecret}`] } } };
        })(),
        (() => {
          const input = dispatchInput({ clientNonce: "secret-credential" });
          const grant = input.grant as ProviderCapabilityGrant;
          return { ...input, grant: { ...grant, constraints: { ...grant.constraints, credentialRefs: [{ secretRef: `provider/${knownSecret}` }] } } };
        })(),
        dispatchInput({ clientNonce: `nonce/${knownSecret}` }),
      ];
      for (const input of inputs) expect(() => store.dispatch(input)).toThrow();
      for (const table of ["async_tasks", "async_task_attempts", "async_task_grants", "async_task_budget_usage", "async_task_outbox"]) {
        expect((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(0);
      }
      expect(JSON.stringify({ tasks: store.listTasks(), outbox: store.listUndeliveredOutbox() })).not.toContain(knownSecret);
      const raw = database.prepare("SELECT group_concat(grant_json, ' ') AS value FROM async_task_grants").get() as { value: string | null };
      expect(raw.value ?? "").not.toContain(knownSecret);
    } finally {
      store.close();
      database.close();
    }
  });

  it("fails closed when a persisted grant contains a value registered as sensitive later", () => {
    const lateSecret = "xai-late-registered-secret";
    let sensitiveValues: readonly string[] = [];
    const store = new AsyncTaskStore({ path: temporaryDatabasePath(), sensitiveValues: () => sensitiveValues });
    try {
      const input = dispatchInput();
      const inputGrant = input.grant as ProviderCapabilityGrant;
      const grant: ProviderCapabilityGrant = { ...inputGrant, constraints: { ...inputGrant.constraints, models: [`model/${lateSecret}`] } };
      store.dispatch({ ...input, grant });
      sensitiveValues = [lateSecret];
      expect(() => store.getGrant(input.taskId)).toThrow();
    } finally {
      store.close();
    }
  });

  it("persists a queued task, canonical grant, shared budget, and one task-created outbox event atomically", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const input = dispatchInput();
      const result = store.dispatch(input);

      expect(result.created).toBe(true);
      expect(result.task).toMatchObject({
        taskId: input.taskId,
        agentId: input.agentId,
        clientNonce: "nonce-a",
        status: "queued",
        attempt: 0,
        version: 1,
      });
      expect(store.getGrant(input.taskId)).toEqual(input.grant);
      expect(store.getBudgetState(input.taskId)).toEqual({ budget, usage: { used: zeroCounters, reserved: zeroCounters, reservations: [] }, version: 1 });
      expect(store.listUndeliveredOutbox()).toEqual([
        expect.objectContaining({ taskId: input.taskId, transitionVersion: 1, wakeKind: "task_created", deliveredAtMs: null }),
      ]);
    } finally {
      store.close();
    }
  });

  it("returns only the most recent bounded task window in chronological order", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const taskIds: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const input = dispatchInput({ clientNonce: `bounded-${index}`, createdAtMs: 1_000 + index });
        taskIds.push(input.taskId);
        store.dispatch(input);
      }

      expect(store.listTasks("agent-a", { limit: 2 }).map((task) => task.taskId)).toEqual(taskIds.slice(-2));
      expect(store.getProjectionSnapshot("agent-a", "async-tasks", { limit: 2 })).toMatchObject({
        truncated: true,
        items: taskIds.slice(-2).map((taskId) => ({ taskId })),
      });
    } finally {
      store.close();
    }
  });

  it("deduplicates agent nonce across restart without duplicating task or outbox state", () => {
    const databasePath = temporaryDatabasePath();
    const first = new AsyncTaskStore({ path: databasePath });
    const input = dispatchInput({ clientNonce: "  nonce-restart  " });
    const created = first.dispatch(input);
    first.close();

    const second = new AsyncTaskStore({ path: databasePath });
    try {
      const duplicate = second.dispatch(dispatchInput({ agentId: input.agentId, clientNonce: "nonce-restart" }));
      expect(duplicate).toEqual({ task: created.task, created: false });
      expect(second.listTasks(input.agentId)).toHaveLength(1);
      expect(second.listUndeliveredOutbox()).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it("rejects malformed scope and leaves all five async tables unchanged", () => {
    const database = new Database(":memory:");
    const store = new AsyncTaskStore({ path: ":memory:", database });
    try {
      const input = dispatchInput();
      expect(() => store.dispatch({ ...input, clientNonce: "   " })).toThrow();
      expect(() => store.dispatch({ ...input, lineage: { ...input.lineage, parentTurnId: "other-turn" } })).toThrow();
      expect(() => store.dispatch({ ...input, grant: { ...input.grant, taskId: randomUUID() } })).toThrow();
      expect(() => store.dispatch({ ...input, grant: { ...input.grant, revokedAt: input.grant.issuedAt - 1 } })).toThrow();
      expect(() => store.dispatch({ ...input, grant: { ...input.grant, revokedAt: input.grant.expiresAt + 1 } })).toThrow();
      for (const table of ["async_tasks", "async_task_attempts", "async_task_grants", "async_task_budget_usage", "async_task_outbox"]) {
        expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    } finally {
      store.close();
      database.close();
    }
  });

  it("rolls back the task row when a later dispatch insert violates grant uniqueness", () => {
    const database = new Database(":memory:");
    const store = new AsyncTaskStore({ path: ":memory:", database });
    try {
      const firstInput = dispatchInput({ clientNonce: "nonce-first" });
      store.dispatch(firstInput);
      const secondInput = dispatchInput({ clientNonce: "nonce-second" });
      const collidingGrant = { ...secondInput.grant, grantId: firstInput.grant.grantId };
      expect(() => store.dispatch({ ...secondInput, grant: collidingGrant })).toThrow();
      expect(store.getTask(secondInput.taskId)).toBeNull();
      expect(store.listTasks()).toHaveLength(1);
      expect(store.listUndeliveredOutbox()).toHaveLength(1);
    } finally {
      store.close();
      database.close();
    }
  });
});

describe("AsyncTaskStore agent deletion", () => {
  it("purges the deleted agent's tasks so a recreated agent does not inherit nonce or history", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const deleted = store.dispatch(dispatchInput({ clientNonce: "nonce-deleted" })).task;
      const survivor = store.dispatch(dispatchInput({ agentId: "agent-b", clientNonce: "nonce-survivor" })).task;
      store.terminalizeAgentTasks(deleted.agentId);
      store.getProjectionSnapshot(deleted.agentId, "async-tasks");
      store.purgeAgentTasks(deleted.agentId);

      expect(store.getTask(deleted.taskId)).toBeNull();
      expect(store.listTasks(deleted.agentId)).toEqual([]);
      expect(store.getProjectionSnapshot(deleted.agentId, "async-tasks")!.items).toEqual([]);
      expect(store.getTask(survivor.taskId)).toMatchObject({ taskId: survivor.taskId, agentId: "agent-b" });
      expect(store.dispatch(dispatchInput({ clientNonce: "nonce-deleted" })).created).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("AsyncTaskStore claiming", () => {
  it("uses the injected authoritative clock instead of stale or future caller metadata", () => {
    let clock = 1_100;
    const store = new AsyncTaskStore({ path: temporaryDatabasePath(), now: () => clock });
    try {
      const futureTask = store.dispatch(dispatchInput({ agentId: "agent-future", clientNonce: "future-claim" })).task;
      expect(() => store.claimNext(futureTask.agentId, { ownerId: "worker-f", nowMs: 1_200, leaseDurationMs: 500 })).toThrow();
      expect(store.getTask(futureTask.taskId)?.status).toBe("queued");

      const task = store.dispatch(dispatchInput({ clientNonce: "authoritative-clock" })).task;
      const claimed = store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 500 })!;
      expect(claimed.lease.expiresAtMs).toBeGreaterThanOrEqual(1_599);
      expect(claimed.lease.expiresAtMs).toBeLessThanOrEqual(1_600);
      expect(() => store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_200 })).toThrow();
      const running = store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_100 });
      expect(() => store.heartbeat({ taskId: task.taskId, expectedVersion: 3, leaseOwnerId: "worker-a", attempt: 1, nowMs: 1_200, leaseDurationMs: 500 })).toThrow();
      expect(store.getTask(task.taskId)).toEqual(running);
      clock = 2_000;
      expect(() => store.heartbeat({ taskId: task.taskId, expectedVersion: 3, leaseOwnerId: "worker-a", attempt: 1, nowMs: 1_599, leaseDurationMs: 500 })).toThrow();
      expect(store.getTask(task.taskId)?.lease?.expiresAtMs).toBe(claimed.lease.expiresAtMs);
    } finally {
      store.close();
    }
  });

  it("does not claim a queued task before its durable creation timestamp", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      expect(store.claimNext(task.agentId, { ownerId: "worker-early", nowMs: 500, leaseDurationMs: 500 })).toBeNull();
      expect(store.getTask(task.taskId)).toMatchObject({ status: "queued", version: 1, attempt: 0 });
      expect(store.listAttempts(task.taskId)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("claims one eligible task with a fenced exclusive lease and creates attempt one", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const dispatched = store.dispatch(dispatchInput());
      const claimed = store.claimNext(dispatched.task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 500 });

      expect(claimed).not.toBeNull();
      expect(claimed?.task).toMatchObject({ taskId: dispatched.task.taskId, status: "admitted", attempt: 1, version: 2 });
      expect(claimed?.attempt).toMatchObject({ taskId: dispatched.task.taskId, attempt: 1, status: "admitted", version: 1 });
      expect(claimed?.lease).toEqual({ ownerId: "worker-a", expiresAtMs: 1_600, attempt: 1, version: 2 });
      expect(store.claimNext(dispatched.task.agentId, { ownerId: "worker-b", nowMs: 1_101, leaseDurationMs: 500 })).toBeNull();
      expect(store.listAttempts(dispatched.task.taskId)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("keeps the lease exclusive across two SQLite connections", () => {
    const databasePath = temporaryDatabasePath();
    const first = new AsyncTaskStore({ path: databasePath });
    const task = first.dispatch(dispatchInput()).task;
    const second = new AsyncTaskStore({ path: databasePath });
    try {
      expect(first.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 500 })?.lease.ownerId).toBe("worker-a");
      expect(second.claimNext(task.agentId, { ownerId: "worker-b", nowMs: 1_100, leaseDurationMs: 500 })).toBeNull();
      expect(second.getTask(task.taskId)?.lease?.ownerId).toBe("worker-a");
    } finally {
      second.close();
      first.close();
    }
  });

  it("clips leases to the grant/task deadline and never admits a revoked task", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const shortInput = dispatchInput({ clientNonce: "nonce-short" });
      const shortTask = store.dispatch({ ...shortInput, grant: { ...shortInput.grant, expiresAt: 1_200 } }).task;
      const claimed = store.claimNext(shortTask.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 5_000 });
      expect(claimed?.lease.expiresAtMs).toBe(1_200);

      const revokedInput = dispatchInput({ clientNonce: "nonce-revoked" });
      const revokedTask = store.dispatch(revokedInput).task;
      store.revokeGrant(revokedTask.taskId, 1, 1_050);
      expect(store.claimNext(revokedTask.agentId, { ownerId: "worker-b", nowMs: 1_100, leaseDurationMs: 500 })).toBeNull();
    } finally {
      store.close();
    }
  });

  it("fences start and heartbeat by owner, attempt, and task version without emitting wakes", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      const claimed = store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 500 })!;
      expect(() => store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-b", attempt: 1, startedAtMs: 1_120 })).toThrow();
      expect(store.getTask(task.taskId)?.version).toBe(2);

      const started = store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_120 });
      expect(started).toMatchObject({ status: "running", version: 3, startedAtMs: 1_120 });
      expect(() => store.heartbeat({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, nowMs: 1_130, leaseDurationMs: 500 })).toThrow();

      const heartbeat = store.heartbeat({ taskId: task.taskId, expectedVersion: 3, leaseOwnerId: "worker-a", attempt: 1, nowMs: 1_130, leaseDurationMs: 500 });
      expect(heartbeat).toMatchObject({ status: "running", version: 4, lineage: claimed.task.lineage });
      expect(heartbeat.lease).toEqual({ ownerId: "worker-a", expiresAtMs: 1_630, attempt: 1, version: 4 });
      expect(store.listUndeliveredOutbox()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("moves an owned running attempt to retry-wait and claims a new attempt on the same logical task", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 500 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_120 });
      const waiting = store.transition({
        taskId: task.taskId,
        expectedVersion: 3,
        to: "retry_wait",
        atMs: 1_200,
        leaseOwnerId: "worker-a",
        attempt: 1,
        nextAttemptAtMs: 1_300,
        error: { code: "provider_error", message: "retry later", retryable: true },
      });
      expect(waiting).toMatchObject({ taskId: task.taskId, status: "retry_wait", attempt: 1, version: 4, lease: null, nextAttemptAtMs: 1_300 });
      expect(store.claimNext(task.agentId, { ownerId: "worker-b", nowMs: 1_299, leaseDurationMs: 500 })).toBeNull();

      const retried = store.claimNext(task.agentId, { ownerId: "worker-b", nowMs: 1_300, leaseDurationMs: 500 });
      expect(retried?.task).toMatchObject({ taskId: task.taskId, status: "admitted", attempt: 2, version: 5 });
      expect(store.listAttempts(task.taskId).map((entry) => [entry.attempt, entry.status])).toEqual([[1, "retry_wait"], [2, "admitted"]]);
      expect(store.getBudgetState(task.taskId)?.version).toBe(1);
    } finally {
      store.close();
    }
  });

  it("rejects transition timestamps before creation or start without corrupting the active attempt", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 500 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_120 });
      expect(() => store.transition({
        taskId: task.taskId,
        expectedVersion: 3,
        to: "retry_wait",
        atMs: 1_110,
        leaseOwnerId: "worker-a",
        attempt: 1,
        nextAttemptAtMs: 1_300,
        error: { code: "provider_error", message: "retry later", retryable: true },
      })).toThrow();
      expect(store.getTask(task.taskId)).toMatchObject({ status: "running", version: 3 });
      expect(store.listAttempts(task.taskId)[0]).toMatchObject({ status: "running", finishedAtMs: null });
    } finally {
      store.close();
    }
  });

  it("rejects start and heartbeat timestamps before the current attempt fence", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const firstTask = store.dispatch(dispatchInput({ clientNonce: "early-start" })).task;
      store.claimNext(firstTask.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 500 });
      expect(() => store.start({ taskId: firstTask.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_050 })).toThrow();
      expect(store.getTask(firstTask.taskId)).toMatchObject({ status: "admitted", version: 2 });

      const secondTask = store.dispatch(dispatchInput({ agentId: "agent-heartbeat", clientNonce: "early-heartbeat" })).task;
      store.claimNext(secondTask.agentId, { ownerId: "worker-b", nowMs: 1_100, leaseDurationMs: 500 });
      store.start({ taskId: secondTask.taskId, expectedVersion: 2, leaseOwnerId: "worker-b", attempt: 1, startedAtMs: 1_120 });
      expect(() => store.heartbeat({ taskId: secondTask.taskId, expectedVersion: 3, leaseOwnerId: "worker-b", attempt: 1, nowMs: 1_110, leaseDurationMs: 500 })).toThrow();
      expect(store.getTask(secondTask.taskId)).toMatchObject({ status: "running", version: 3 });
    } finally {
      store.close();
    }
  });

  it("uses attempt two rather than the logical task start as the retry transition clock fence", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-1", nowMs: 1_100, leaseDurationMs: 1_000 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-1", attempt: 1, startedAtMs: 1_120 });
      store.transition({
        taskId: task.taskId, expectedVersion: 3, to: "retry_wait", atMs: 1_200,
        leaseOwnerId: "worker-1", attempt: 1, nextAttemptAtMs: 1_900,
        error: { code: "provider_error", message: "retry", retryable: true },
      });
      store.claimNext(task.agentId, { ownerId: "worker-2", nowMs: 1_900, leaseDurationMs: 1_000 });
      expect(() => store.start({ taskId: task.taskId, expectedVersion: 5, leaseOwnerId: "worker-2", attempt: 2, startedAtMs: 1_500 })).toThrow();
      store.start({ taskId: task.taskId, expectedVersion: 5, leaseOwnerId: "worker-2", attempt: 2, startedAtMs: 2_000 });
      expect(() => store.heartbeat({ taskId: task.taskId, expectedVersion: 6, leaseOwnerId: "worker-2", attempt: 2, nowMs: 1_500, leaseDurationMs: 500 })).toThrow();

      expect(() => store.transition({
        taskId: task.taskId, expectedVersion: 6, to: "retry_wait", atMs: 1_500,
        leaseOwnerId: "worker-2", attempt: 2, nextAttemptAtMs: 2_100,
        error: { code: "provider_error", message: "clock regression", retryable: true },
      })).toThrow();
      expect(store.getTask(task.taskId)).toMatchObject({ status: "running", version: 6, attempt: 2 });
      expect(store.listAttempts(task.taskId)[1]).toMatchObject({ status: "running", startedAtMs: 2_000, finishedAtMs: null });
    } finally {
      store.close();
    }
  });

  it("rejects retry scheduling at or after the authoritative grant deadline without mutation", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const base = dispatchInput();
      const task = store.dispatch({ ...base, grant: { ...base.grant, revokedAt: 1_500 } }).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 1_000 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_120 });
      const beforeTask = store.getTask(task.taskId);
      const beforeAttempts = store.listAttempts(task.taskId);
      const beforeOutbox = store.listUndeliveredOutbox();
      const retry = (nextAttemptAtMs: number) => store.transition({
        taskId: task.taskId, expectedVersion: 3, to: "retry_wait", atMs: 1_200,
        leaseOwnerId: "worker-a", attempt: 1, nextAttemptAtMs,
        error: { code: "provider_error", message: "retry later", retryable: true },
      });
      expect(() => retry(1_600)).toThrow();
      expect(() => retry(1_500)).toThrow();
      expect(store.getTask(task.taskId)).toEqual(beforeTask);
      expect(store.listAttempts(task.taskId)).toEqual(beforeAttempts);
      expect(store.listUndeliveredOutbox()).toEqual(beforeOutbox);
      expect(retry(1_499)).toMatchObject({ status: "retry_wait", nextAttemptAtMs: 1_499, version: 4 });
    } finally {
      store.close();
    }
  });
});

describe("AsyncTaskStore control intents", () => {
  it("rejects steer and abort intents timestamped before the current attempt", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const steerTask = store.dispatch(dispatchInput({ clientNonce: "early-steer" })).task;
      store.claimNext(steerTask.agentId, { ownerId: "worker-s", nowMs: 1_100, leaseDurationMs: 500 });
      expect(() => store.steer({
        taskId: steerTask.taskId, agentId: steerTask.agentId, parentTurnId: steerTask.parentTurnId,
        intentId: randomUUID(), expectedSteerVersion: 0, requestedAtMs: 1_050, message: "early",
      })).toThrow();
      expect(store.getTask(steerTask.taskId)).toMatchObject({ status: "admitted", version: 2, steerIntent: null });

      const abortTask = store.dispatch(dispatchInput({ agentId: "agent-abort-early", clientNonce: "early-abort" })).task;
      store.claimNext(abortTask.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 500 });
      expect(() => store.abort({
        taskId: abortTask.taskId, agentId: abortTask.agentId, parentTurnId: abortTask.parentTurnId,
        intentId: randomUUID(), expectedAbortVersion: 0, requestedAtMs: 1_050, reason: "parent",
      })).toThrow();
      expect(store.getTask(abortTask.taskId)).toMatchObject({ status: "admitted", version: 2, abortIntent: null });
      expect(store.listUndeliveredOutbox().filter((event) => event.wakeKind === "task_steer" || event.wakeKind === "task_abort")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("persists steer and abort before delivery, scopes them to the parent, and makes retries idempotent", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 1_000 });
      const steerInput = {
        taskId: task.taskId,
        agentId: task.agentId,
        parentTurnId: task.parentTurnId,
        intentId: randomUUID(),
        expectedSteerVersion: 0,
        requestedAtMs: 1_150,
        message: "Priorize os testes.",
      } as const;
      const steered = store.steer(steerInput);
      expect(steered).toMatchObject({ version: 3, steerVersion: 1, steerIntent: { intentId: steerInput.intentId, version: 1 } });
      expect(store.steer(steerInput)).toEqual(steered);
      expect(() => store.steer({ ...steerInput, message: "payload conflitante" })).toThrow();
      expect(() => store.steer({ ...steerInput, intentId: randomUUID(), parentTurnId: "turn-other", expectedSteerVersion: 1 })).toThrow();

      const abortInput = {
        taskId: task.taskId,
        agentId: task.agentId,
        parentTurnId: task.parentTurnId,
        intentId: randomUUID(),
        expectedAbortVersion: 0,
        requestedAtMs: 1_200,
        reason: "parent" as const,
      };
      const cancelling = store.abort(abortInput);
      expect(cancelling).toMatchObject({ status: "cancelling", version: 4, abortVersion: 1, abortIntent: { intentId: abortInput.intentId, version: 1 } });
      expect(store.getGrant(task.taskId)).toMatchObject({ revokedAt: 1_200, version: 2 });
      expect(store.abort(abortInput)).toEqual(cancelling);
      expect(store.listUndeliveredOutbox().map((event) => event.wakeKind)).toEqual(["task_created", "task_steer", "task_abort"]);
    } finally {
      store.close();
    }
  });

  it("forbids bypassing abort intent persistence through a direct cancelling transition", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 500 });
      expect(() => store.transition({
        taskId: task.taskId,
        expectedVersion: 2,
        to: "cancelling",
        atMs: 1_150,
        leaseOwnerId: "worker-a",
        attempt: 1,
      })).toThrow();
      expect(store.getTask(task.taskId)).toMatchObject({ status: "admitted", version: 2, abortIntent: null });
      expect(store.listUndeliveredOutbox().map((event) => event.wakeKind)).toEqual(["task_created"]);
    } finally {
      store.close();
    }
  });

  it("revokes effects on active abort but preserves the lease for an owned cancelled commit", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 1_000 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_120 });
      const cancelling = store.abort({
        taskId: task.taskId, agentId: task.agentId, parentTurnId: task.parentTurnId,
        intentId: randomUUID(), expectedAbortVersion: 0, requestedAtMs: 1_200, reason: "user",
      });
      expect(cancelling).toMatchObject({ status: "cancelling", version: 4, lease: { ownerId: "worker-a", expiresAtMs: 2_100 } });
      expect(store.getGrant(task.taskId)).toMatchObject({ revokedAt: 1_200, version: 2 });
      expect(() => store.heartbeat({
        taskId: task.taskId, expectedVersion: 4, leaseOwnerId: "worker-a", attempt: 1, nowMs: 1_250, leaseDurationMs: 500,
      })).toThrowError(expect.objectContaining({ code: "capability_denied" }));

      const committed = store.commitTerminal({
        taskId: task.taskId, expectedVersion: 4, leaseOwnerId: "worker-a", attempt: 1,
        status: "cancelled", finishedAtMs: 1_300, result: null,
        error: { code: "aborted", message: "confirmed abort", retryable: false },
        wakeKind: "task_terminal",
        wakePayload: { status: "cancelled", attempt: 1, summary: "confirmed abort", code: "aborted", resultRef: null },
      });
      expect(committed.task).toMatchObject({ status: "cancelled", version: 5, lease: null });
      expect(committed.attempt).toMatchObject({ status: "cancelled", lease: null });
      expect(store.listUndeliveredOutbox().map((event) => event.wakeKind)).toEqual(["task_created", "task_abort", "task_terminal"]);
    } finally {
      store.close();
    }
  });

  it("blocks retry after recovery of a revoked abort while allowing terminal policy decisions", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      for (const [index, terminal] of (["failed", "cancelled"] as const).entries()) {
        const task = store.dispatch(dispatchInput({ agentId: `agent-recovered-${index}`, clientNonce: `recovered-${index}` })).task;
        const owner = `worker-${index}`;
        store.claimNext(task.agentId, { ownerId: owner, nowMs: 1_100, leaseDurationMs: 100 });
        store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: owner, attempt: 1, startedAtMs: 1_120 });
        store.abort({
          taskId: task.taskId, agentId: task.agentId, parentTurnId: task.parentTurnId,
          intentId: randomUUID(), expectedAbortVersion: 0, requestedAtMs: 1_150, reason: "parent",
        });
        expect(store.recoverExpiredLeases(1_200).some((entry) => entry.taskId === task.taskId)).toBe(true);
        expect(() => store.transition({
          taskId: task.taskId, expectedVersion: 5, to: "retry_wait", atMs: 1_210, nextAttemptAtMs: 1_300,
          error: { code: "provider_error", message: "must not retry", retryable: true },
        })).toThrowError(expect.objectContaining({ code: "capability_denied" }));
        const failure = terminal === "failed"
          ? { code: "capability_denied" as const, message: "authority revoked", retryable: false }
          : { code: "aborted" as const, message: "abort finalized", retryable: false };
        const finalTask = store.transition({ taskId: task.taskId, expectedVersion: 5, to: terminal, atMs: 1_220, error: failure });
        expect(finalTask.status).toBe(terminal);
        expect(store.listUndeliveredOutbox().filter((event) => event.taskId === task.taskId).at(-1))
          .toMatchObject({ wakeKind: "task_terminal", payload: { status: terminal, code: failure.code } });
      }
    } finally {
      store.close();
    }
  });

  it("atomically aborts queued and retry-wait tasks to cancelled while preserving attempt history", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const queued = store.dispatch(dispatchInput({ clientNonce: "abort-queued" })).task;
      const queuedInput = {
        taskId: queued.taskId,
        agentId: queued.agentId,
        parentTurnId: queued.parentTurnId,
        intentId: randomUUID(),
        expectedAbortVersion: 0,
        requestedAtMs: 1_100,
        reason: "parent" as const,
      };
      const queuedCancelled = store.abort(queuedInput);
      expect(queuedCancelled).toMatchObject({ status: "cancelled", version: 2, attempt: 0, finishedAtMs: 1_100, abortVersion: 1 });
      expect(store.getGrant(queued.taskId)).toMatchObject({ revokedAt: 1_100, version: 2 });
      expect(store.abort(queuedInput)).toEqual(queuedCancelled);

      const retry = store.dispatch(dispatchInput({ clientNonce: "abort-retry" })).task;
      store.claimNext(retry.agentId, { ownerId: "worker-r", nowMs: 1_100, leaseDurationMs: 500 });
      store.start({ taskId: retry.taskId, expectedVersion: 2, leaseOwnerId: "worker-r", attempt: 1, startedAtMs: 1_120 });
      store.transition({
        taskId: retry.taskId,
        expectedVersion: 3,
        to: "retry_wait",
        atMs: 1_200,
        leaseOwnerId: "worker-r",
        attempt: 1,
        nextAttemptAtMs: 1_400,
        error: { code: "provider_error", message: "retry later", retryable: true },
      });
      const history = store.listAttempts(retry.taskId);
      const retryInput = {
        taskId: retry.taskId,
        agentId: retry.agentId,
        parentTurnId: retry.parentTurnId,
        intentId: randomUUID(),
        expectedAbortVersion: 0,
        requestedAtMs: 1_250,
        reason: "user" as const,
      };
      const retryCancelled = store.abort(retryInput);
      expect(retryCancelled).toMatchObject({ status: "cancelled", version: 5, attempt: 1, nextAttemptAtMs: null, abortVersion: 1 });
      expect(store.listAttempts(retry.taskId)).toEqual(history);
      expect(store.listUndeliveredOutbox().filter((event) => event.taskId === retry.taskId).map((event) => event.wakeKind))
        .toEqual(["task_created", "task_abort", "task_terminal"]);
    } finally {
      store.close();
    }
  });

  it("rolls back queued abort intent, terminal status, and task-abort wake if terminal wake conflicts", () => {
    const database = new Database(":memory:");
    const store = new AsyncTaskStore({ path: ":memory:", database });
    try {
      const task = store.dispatch(dispatchInput()).task;
      database.prepare(`
        INSERT INTO async_task_outbox(outbox_id, task_id, transition_version, wake_kind, payload_json, created_at_ms, delivered_at_ms)
        VALUES (?, ?, 2, 'task_terminal', ?, 1050, NULL)
      `).run(randomUUID(), task.taskId, JSON.stringify({ status: "cancelled", attempt: 0, summary: null, code: "aborted", resultRef: null }));
      expect(() => store.abort({
        taskId: task.taskId,
        agentId: task.agentId,
        parentTurnId: task.parentTurnId,
        intentId: randomUUID(),
        expectedAbortVersion: 0,
        requestedAtMs: 1_100,
        reason: "parent",
      })).toThrow();
      expect(store.getTask(task.taskId)).toMatchObject({ status: "queued", version: 1, abortIntent: null, abortVersion: 0 });
      expect(store.getGrant(task.taskId)?.version).toBe(1);
      expect(store.getGrant(task.taskId)).not.toHaveProperty("revokedAt");
      expect(database.prepare("SELECT COUNT(*) AS count FROM async_task_outbox WHERE task_id = ? AND wake_kind = 'task_abort'").get(task.taskId))
        .toEqual({ count: 0 });
    } finally {
      store.close();
      database.close();
    }
  });

  it("allows retry policy to fail a retry-wait task without rewriting its finished attempt", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 500 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_120 });
      store.transition({
        taskId: task.taskId, expectedVersion: 3, to: "retry_wait", atMs: 1_200,
        leaseOwnerId: "worker-a", attempt: 1, nextAttemptAtMs: 1_400,
        error: { code: "provider_error", message: "retry later", retryable: true },
      });
      const history = store.listAttempts(task.taskId);
      expect(() => store.transition({
        taskId: task.taskId, expectedVersion: 4, to: "failed", atMs: 1_199,
        error: { code: "budget_exhausted", message: "too early", retryable: false },
      })).toThrow();
      const failed = store.transition({
        taskId: task.taskId, expectedVersion: 4, to: "failed", atMs: 1_250,
        error: { code: "budget_exhausted", message: "policy stopped retry", retryable: false },
      });
      expect(failed).toMatchObject({ status: "failed", version: 5, finishedAtMs: 1_250 });
      expect(store.getGrant(task.taskId)).toMatchObject({ revokedAt: 1_250, version: 2 });
      expect(store.listAttempts(task.taskId)).toEqual(history);
      expect(store.listUndeliveredOutbox().at(-1)).toMatchObject({ wakeKind: "task_terminal", transitionVersion: 5 });
    } finally {
      store.close();
    }
  });
});

describe("AsyncTaskStore terminal commit", () => {
  it("atomically revokes authority at authoritative terminal time and rejects later budget reservations", () => {
    let clock = 1_100;
    const store = new AsyncTaskStore({ path: temporaryDatabasePath(), now: () => clock });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 1_000 });
      clock = 1_120;
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_115 });
      clock = 1_300;
      const committed = store.commitTerminal({
        taskId: task.taskId, expectedVersion: 3, leaseOwnerId: "worker-a", attempt: 1,
        status: "completed", finishedAtMs: 1_250,
        result: { kind: "inline", text: "ok", bytes: 2, truncated: false }, error: null,
        wakeKind: "task_terminal",
        wakePayload: { status: "completed", attempt: 1, summary: "ok", code: null, resultRef: null },
      });
      expect(committed.task.finishedAtMs).toBe(clock);
      expect(committed.outboxEvent.createdAtMs).toBe(clock);
      const grant = store.getGrant(task.taskId)!;
      expect(grant.revokedAt).toBe(clock);
      expect(() => assertGrantAllowsOperation(grant, {
        kind: "provider", adapter: "openai", model: "gpt-test", credential: { kind: "secret_ref", secretRef: "provider/openai/test" },
      }, {
        now: clock, currentVersion: grant.version, expectedGrantId: grant.grantId, taskId: task.taskId,
        parentAgentId: task.agentId, parentTurnId: task.parentTurnId, childRunId: task.lineage.childRunId,
      })).toThrow();
      expect(() => store.reserveTaskBudget(
        task.taskId,
        1,
        { reservationId: "after-terminal", amounts: zeroCounters },
        { leaseOwnerId: "worker-a", attempt: 1, expectedTaskVersion: 4 },
        1_300,
      )).toThrow();
    } finally {
      store.close();
    }
  });

  it("rejects a terminal timestamp before the current retry attempt without emitting a wake", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-1", nowMs: 1_100, leaseDurationMs: 1_000 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-1", attempt: 1, startedAtMs: 1_120 });
      store.transition({
        taskId: task.taskId, expectedVersion: 3, to: "retry_wait", atMs: 1_200,
        leaseOwnerId: "worker-1", attempt: 1, nextAttemptAtMs: 1_900,
        error: { code: "provider_error", message: "retry", retryable: true },
      });
      store.claimNext(task.agentId, { ownerId: "worker-2", nowMs: 1_900, leaseDurationMs: 1_000 });
      store.start({ taskId: task.taskId, expectedVersion: 5, leaseOwnerId: "worker-2", attempt: 2, startedAtMs: 2_000 });
      const beforeOutbox = store.listUndeliveredOutbox();
      expect(() => store.commitTerminal({
        taskId: task.taskId, expectedVersion: 6, leaseOwnerId: "worker-2", attempt: 2,
        status: "completed", finishedAtMs: 1_500,
        result: { kind: "inline", text: "impossible", bytes: 10, truncated: false }, error: null,
        wakeKind: "task_terminal",
        wakePayload: { status: "completed", attempt: 2, summary: null, code: null, resultRef: null },
      })).toThrow();
      expect(store.getTask(task.taskId)).toMatchObject({ status: "running", version: 6, attempt: 2 });
      expect(store.listUndeliveredOutbox()).toEqual(beforeOutbox);
    } finally {
      store.close();
    }
  });

  it("commits the limited terminal result, attempt, and logical outbox wake in one transaction", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 1_000 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_120 });
      const result = { kind: "inline", text: "feito", bytes: Buffer.byteLength("feito"), truncated: false } as const;
      const terminalInput = {
        taskId: task.taskId,
        expectedVersion: 3,
        leaseOwnerId: "worker-a",
        attempt: 1,
        status: "completed",
        finishedAtMs: 1_300,
        result,
        error: null,
        wakeKind: "task_terminal",
        wakePayload: { status: "completed", attempt: 1, summary: "feito", code: null, resultRef: null },
      } as const;
      const committed = store.commitTerminal(terminalInput);

      expect(committed.task).toMatchObject({ status: "completed", version: 4, result, lease: null, finishedAtMs: 1_300 });
      expect(committed.attempt).toMatchObject({ status: "completed", finishedAtMs: 1_300, lease: null });
      expect(committed.outboxEvent).toMatchObject({ taskId: task.taskId, transitionVersion: 4, wakeKind: "task_terminal" });
      expect(() => store.commitTerminal(terminalInput)).toThrow();
      expect(store.getTask(task.taskId)).toEqual(committed.task);
      expect(store.listUndeliveredOutbox().filter((event) => event.wakeKind === "task_terminal")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("rolls back task and attempt when the logical terminal wake cannot be inserted", () => {
    const database = new Database(":memory:");
    const store = new AsyncTaskStore({ path: ":memory:", database });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 1_000 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_120 });
      database.prepare(`
        INSERT INTO async_task_outbox(outbox_id, task_id, transition_version, wake_kind, payload_json, created_at_ms, delivered_at_ms)
        VALUES (?, ?, 4, 'task_terminal', ?, 1200, NULL)
      `).run(randomUUID(), task.taskId, JSON.stringify({ status: "completed", attempt: 1, summary: null, code: null, resultRef: null }));
      const result = { kind: "inline", text: "ok", bytes: 2, truncated: false } as const;
      expect(() => store.commitTerminal({
        taskId: task.taskId,
        expectedVersion: 3,
        leaseOwnerId: "worker-a",
        attempt: 1,
        status: "completed",
        finishedAtMs: 1_300,
        result,
        error: null,
        wakeKind: "task_terminal",
        wakePayload: { status: "completed", attempt: 1, summary: null, code: null, resultRef: null },
      })).toThrow();
      expect(store.getTask(task.taskId)).toMatchObject({ status: "running", version: 3, result: null });
      expect(store.listAttempts(task.taskId)[0]).toMatchObject({ status: "running", finishedAtMs: null });
      expect(store.getGrant(task.taskId)?.version).toBe(1);
      expect(store.getGrant(task.taskId)).not.toHaveProperty("revokedAt");
    } finally {
      store.close();
      database.close();
    }
  });

  it("truncates an inline result to the task budget instead of rejecting the terminal commit", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 1_000 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_120 });
      const text = "x".repeat(budget.maxResultBytes + 1);
      const committed = store.commitTerminal({
        taskId: task.taskId,
        expectedVersion: 3,
        leaseOwnerId: "worker-a",
        attempt: 1,
        status: "completed",
        finishedAtMs: 1_300,
        result: { kind: "inline", text, bytes: Buffer.byteLength(text), truncated: false },
        error: null,
        wakeKind: "task_terminal",
        wakePayload: { status: "completed", attempt: 1, summary: null, code: null, resultRef: null },
      });
      expect(committed.task).toMatchObject({ status: "completed", version: 4, result: { kind: "inline", bytes: budget.maxResultBytes, truncated: true } });
      if (committed.task.result?.kind !== "inline") throw new Error("expected inline result");
      expect(committed.task.result.text.endsWith(TASK_RESULT_TRUNCATION_MARKER)).toBe(true);
      expect(store.listUndeliveredOutbox().at(-1)).toMatchObject({ wakeKind: "task_terminal", payload: { status: "completed", attempt: 1 } });
    } finally {
      store.close();
    }
  });

  it("rejects dishonest truncated input and oversized references without mutating durable state", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 1_000 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_120 });
      const before = { task: store.getTask(task.taskId), attempts: store.listAttempts(task.taskId), outbox: store.listUndeliveredOutbox() };
      expect(() => store.commitTerminal({
        taskId: task.taskId, expectedVersion: 3, leaseOwnerId: "worker-a", attempt: 1,
        status: "completed", finishedAtMs: 1_300,
        result: { kind: "inline", text: "partial", bytes: 7, truncated: true }, error: null,
        wakeKind: "task_terminal",
        wakePayload: { status: "completed", attempt: 1, summary: null, code: null, resultRef: null },
      })).toThrow();
      expect(() => store.commitTerminal({
        taskId: task.taskId, expectedVersion: 3, leaseOwnerId: "worker-a", attempt: 1,
        status: "completed", finishedAtMs: 1_300,
        result: { kind: "ref", resultRef: "result/too-large", bytes: budget.maxResultBytes + 1, truncated: false }, error: null,
        wakeKind: "task_terminal",
        wakePayload: { status: "completed", attempt: 1, summary: null, code: null, resultRef: "result/too-large" },
      })).toThrow();
      expect({ task: store.getTask(task.taskId), attempts: store.listAttempts(task.taskId), outbox: store.listUndeliveredOutbox() }).toEqual(before);
    } finally {
      store.close();
    }
  });

  it("rejects a sensitive result reference instead of persisting a broken redacted reference", () => {
    const knownSecret = "xai-outro-valor-secreto";
    const store = new AsyncTaskStore({ path: temporaryDatabasePath(), sensitiveValues: () => [knownSecret] });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 1_000 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_120 });
      const beforeTask = store.getTask(task.taskId);
      const beforeAttempts = store.listAttempts(task.taskId);
      const beforeOutbox = store.listUndeliveredOutbox();
      const resultRef = `result/${knownSecret}`;
      expect(() => store.commitTerminal({
        taskId: task.taskId, expectedVersion: 3, leaseOwnerId: "worker-a", attempt: 1,
        status: "completed", finishedAtMs: 1_300,
        result: { kind: "ref", resultRef, bytes: 10, truncated: false }, error: null,
        wakeKind: "task_terminal",
        wakePayload: { status: "completed", attempt: 1, summary: "done", code: null, resultRef },
      })).toThrow();
      expect(store.getTask(task.taskId)).toEqual(beforeTask);
      expect(store.listAttempts(task.taskId)).toEqual(beforeAttempts);
      expect(store.listUndeliveredOutbox()).toEqual(beforeOutbox);
    } finally {
      store.close();
    }
  });

  it.each([1, 10, 100_000])("truncates inline results at effective result cap %i with an explicit marker", (maxResultBytes) => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const base = dispatchInput();
      const task = store.dispatch({ ...base, budget: { ...base.budget, maxResultBytes } }).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 1_000 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_120 });
      const text = "x".repeat(100_001);
      const committed = store.commitTerminal({
        taskId: task.taskId, expectedVersion: 3, leaseOwnerId: "worker-a", attempt: 1,
        status: "completed", finishedAtMs: 1_300,
        result: { kind: "inline", text, bytes: Buffer.byteLength(text), truncated: false }, error: null,
        wakeKind: "task_terminal",
        wakePayload: { status: "completed", attempt: 1, summary: "done", code: null, resultRef: null },
      });
      expect(committed.task.result).toMatchObject({ kind: "inline", truncated: true });
      if (committed.task.result?.kind !== "inline") throw new Error("expected inline result");
      expect(committed.task.result.bytes).toBe(Buffer.byteLength(committed.task.result.text));
      expect(committed.task.result.bytes).toBe(Math.min(64 * 1024, maxResultBytes));
      const marker = maxResultBytes >= Buffer.byteLength(TASK_RESULT_TRUNCATION_MARKER)
        ? TASK_RESULT_TRUNCATION_MARKER
        : TASK_RESULT_MIN_TRUNCATION_MARKER;
      expect(committed.task.result.text.endsWith(marker)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("acknowledges an outbox row idempotently and preserves chronological delivery order", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      const event = store.listUndeliveredOutbox()[0]!;
      expect(store.acknowledgeOutbox(event.outboxId, 1_050)?.deliveredAtMs).toBe(1_050);
      expect(store.acknowledgeOutbox(event.outboxId, 1_999)?.deliveredAtMs).toBe(1_050);
      expect(store.listUndeliveredOutbox()).toEqual([]);
      expect(store.getTask(task.taskId)?.status).toBe("queued");
    } finally {
      store.close();
    }
  });
});

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

describe("AsyncTaskStore durable redaction", () => {
  it("accepts redacted text markers without misclassifying them as structural leaks", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath(), sensitiveValues: () => ["reda"] });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-safe", nowMs: 1_100, leaseDurationMs: 1_000 });
      const updated = store.recordProgress({
        taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-safe", attempt: 1,
        progress: { phase: "reda", summary: "reda", completedUnits: 1, totalUnits: 2, updatedAtMs: 1_110 },
      });
      expect(updated.progress).toMatchObject({ phase: "[redacted]", summary: "[redacted]" });
      expect(store.listUndeliveredOutbox().at(-1)?.payload.summary).toBe("[redacted]");
    } finally {
      store.close();
    }
  });

  it("rejects new structural secrets before claim, control-intent, or budget SQL mutation", () => {
    const database = new Database(":memory:");
    const ownerSecret = "xai-struct-owner-secret";
    const steerSecret = "xai-struct-steer-secret";
    const abortSecret = "xai-struct-abort-secret";
    const reservationSecret = "xai-struct-reservation-secret";
    const forbidden = [ownerSecret, steerSecret, abortSecret, reservationSecret];
    const store = new AsyncTaskStore({ path: ":memory:", database, sensitiveValues: () => forbidden });
    try {
      const task = store.dispatch(dispatchInput()).task;
      expect(() => store.claimNext(task.agentId, { ownerId: ownerSecret, nowMs: 1_100, leaseDurationMs: 1_000 })).toThrow();
      expect(store.getTask(task.taskId)).toMatchObject({ status: "queued", version: 1, attempt: 0 });
      expect(store.listAttempts(task.taskId)).toEqual([]);

      const claimed = store.claimNext(task.agentId, { ownerId: "worker-safe", nowMs: 1_100, leaseDurationMs: 1_000 })!;
      const beforeTask = store.getTask(task.taskId);
      const beforeBudget = store.getBudgetState(task.taskId);
      const beforeOutbox = store.listUndeliveredOutbox();
      expect(() => store.steer({
        taskId: task.taskId, agentId: task.agentId, parentTurnId: task.parentTurnId,
        intentId: steerSecret, expectedSteerVersion: 0, requestedAtMs: 1_110, message: "safe",
      })).toThrow();
      expect(() => store.abort({
        taskId: task.taskId, agentId: task.agentId, parentTurnId: task.parentTurnId,
        intentId: abortSecret, expectedAbortVersion: 0, requestedAtMs: 1_110, reason: "parent",
      })).toThrow();
      expect(() => store.reserveTaskBudget(
        task.taskId,
        1,
        { reservationId: reservationSecret, amounts: { ...zeroCounters, toolCalls: 1 } },
        { leaseOwnerId: "worker-safe", attempt: 1, expectedTaskVersion: claimed.task.version },
        1_110,
      )).toThrow();
      expect(store.getTask(task.taskId)).toEqual(beforeTask);
      expect(store.getBudgetState(task.taskId)).toEqual(beforeBudget);
      expect(store.listUndeliveredOutbox()).toEqual(beforeOutbox);

      const raw = database.prepare(`
        SELECT t.lease_owner, t.steer_intent_json, t.abort_intent_json, b.usage_json
        FROM async_tasks t JOIN async_task_budget_usage b ON b.task_id = t.task_id
        WHERE t.task_id = ?
      `).get(task.taskId);
      const durable = JSON.stringify(raw);
      for (const secret of forbidden) expect(durable).not.toContain(secret);
    } finally {
      store.close();
      database.close();
    }
  });

  it("fails closed across aggregate readers and owner operations when secrets are registered after persistence", () => {
    const database = new Database(":memory:");
    const ownerSecret = "xai-late-owner-secret";
    const intentSecret = "xai-late-intent-secret";
    const reservationSecret = "xai-late-reservation-secret";
    let sensitiveValues: readonly string[] = [];
    const store = new AsyncTaskStore({ path: ":memory:", database, sensitiveValues: () => sensitiveValues });
    try {
      const task = store.dispatch(dispatchInput()).task;
      const claimed = store.claimNext(task.agentId, { ownerId: ownerSecret, nowMs: 1_100, leaseDurationMs: 1_000 })!;
      sensitiveValues = [ownerSecret];
      expect(() => store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: ownerSecret, attempt: 1, startedAtMs: 1_120 })).toThrow();
      sensitiveValues = [];
      store.reserveTaskBudget(
        task.taskId,
        1,
        { reservationId: reservationSecret, amounts: { ...zeroCounters, toolCalls: 1 } },
        { leaseOwnerId: ownerSecret, attempt: 1, expectedTaskVersion: claimed.task.version },
        1_110,
      );
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: ownerSecret, attempt: 1, startedAtMs: 1_120 });
      store.steer({
        taskId: task.taskId, agentId: task.agentId, parentTurnId: task.parentTurnId,
        intentId: intentSecret, expectedSteerVersion: 0, requestedAtMs: 1_130, message: "safe",
      });
      const beforeRaw = JSON.stringify({
        task: database.prepare("SELECT * FROM async_tasks WHERE task_id = ?").get(task.taskId),
        attempt: database.prepare("SELECT * FROM async_task_attempts WHERE task_id = ?").get(task.taskId),
        budget: database.prepare("SELECT * FROM async_task_budget_usage WHERE task_id = ?").get(task.taskId),
        outbox: database.prepare("SELECT * FROM async_task_outbox WHERE task_id = ? ORDER BY transition_version").all(task.taskId),
      });
      const event = store.listUndeliveredOutbox()[0]!;

      sensitiveValues = [ownerSecret];
      expect(() => store.getTask(task.taskId)).toThrow();
      expect(() => store.listTasks()).toThrow();
      expect(() => store.listAttempts(task.taskId)).toThrow();
      expect(() => store.heartbeat({ taskId: task.taskId, expectedVersion: 4, leaseOwnerId: ownerSecret, attempt: 1, nowMs: 1_140, leaseDurationMs: 100 })).toThrow();
      expect(() => store.recordProgress({
        taskId: task.taskId, expectedVersion: 4, leaseOwnerId: ownerSecret, attempt: 1,
        progress: { phase: "safe", summary: "safe", completedUnits: 1, totalUnits: 2, updatedAtMs: 1_140 },
      })).toThrow();
      expect(() => store.transition({
        taskId: task.taskId, expectedVersion: 4, to: "retry_wait", atMs: 1_140,
        leaseOwnerId: ownerSecret, attempt: 1, nextAttemptAtMs: 1_200,
        error: { code: "provider_error", message: "safe", retryable: true },
      })).toThrow();
      expect(() => store.commitTerminal({
        taskId: task.taskId, expectedVersion: 4, leaseOwnerId: ownerSecret, attempt: 1,
        status: "completed", finishedAtMs: 1_140,
        result: { kind: "inline", text: "ok", bytes: 2, truncated: false }, error: null,
        wakeKind: "task_terminal", wakePayload: { status: "completed", attempt: 1, summary: "ok", code: null, resultRef: null },
      })).toThrow();

      sensitiveValues = [reservationSecret];
      expect(() => store.getBudgetState(task.taskId)).toThrow();
      sensitiveValues = [intentSecret];
      expect(() => store.getTask(task.taskId)).toThrow();
      sensitiveValues = [event.outboxId];
      expect(() => store.listUndeliveredOutbox()).toThrow();
      expect(() => store.acknowledgeOutbox(event.outboxId, 1_140)).toThrow();

      sensitiveValues = [];
      const afterRaw = JSON.stringify({
        task: database.prepare("SELECT * FROM async_tasks WHERE task_id = ?").get(task.taskId),
        attempt: database.prepare("SELECT * FROM async_task_attempts WHERE task_id = ?").get(task.taskId),
        budget: database.prepare("SELECT * FROM async_task_budget_usage WHERE task_id = ?").get(task.taskId),
        outbox: database.prepare("SELECT * FROM async_task_outbox WHERE task_id = ? ORDER BY transition_version").all(task.taskId),
      });
      expect(afterRaw).toBe(beforeRaw);
    } finally {
      store.close();
      database.close();
    }
  });

  it("redacts common secrets in intents, failures, inline results, and wakes before SQLite persistence", () => {
    const database = new Database(":memory:");
    let clock = 1_100;
    const knownSecret = "xai-outro-valor-secreto";
    const store = new AsyncTaskStore({ path: ":memory:", database, now: () => clock, sensitiveValues: () => [knownSecret] });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 1_000 });
      clock = 1_120;
      store.recordProgress({
        taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1,
        progress: {
          phase: "accessToken=progressCamel", summary: `client_secret=progressSnake "apiKey"='progress-api' ${knownSecret}`,
          completedUnits: 1, totalUnits: 2, updatedAtMs: 1_110,
        },
      });
      clock = 1_150;
      store.steer({
        taskId: task.taskId, agentId: task.agentId, parentTurnId: task.parentTurnId,
        intentId: randomUUID(), expectedSteerVersion: 0, requestedAtMs: 1_140,
        message: `{"client_secret":"json-client-secret","access_token":"json-access-token","opaque":"${knownSecret}"}`,
      });
      clock = 1_160;
      store.start({ taskId: task.taskId, expectedVersion: 4, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_155 });
      clock = 1_300;
      const committed = store.commitTerminal({
        taskId: task.taskId, expectedVersion: 5, leaseOwnerId: "worker-a", attempt: 1,
        status: "failed", finishedAtMs: 1_250,
        result: { kind: "inline", text: `{"payload":[{"refresh_token":"result-refresh"},{"safe":"sk-result-json"},{"opaque":"${knownSecret}"}]}`, bytes: Buffer.byteLength(`{"payload":[{"refresh_token":"result-refresh"},{"safe":"sk-result-json"},{"opaque":"${knownSecret}"}]}`), truncated: false },
        error: { code: "provider_error", message: `{"outer":{"clientSecret":"nested-client","note":"Bearer failure-bearer","opaque":"${knownSecret}"},"items":[{"access_token":"nested-access"}]}`, retryable: false },
        wakeKind: "task_terminal",
        wakePayload: { status: "failed", attempt: 1, summary: `{"meta":{"idToken":"wake-id","authorization":"Bearer wake-auth"},"array":["sk-wake-json","${knownSecret}"]}`, code: "provider_error", resultRef: null },
      });
      expect(committed.task.result?.bytes).toBe(Buffer.byteLength(committed.task.result?.kind === "inline" ? committed.task.result.text : ""));
      expect(committed.task.result).toMatchObject({ kind: "inline", truncated: false });
      expect(JSON.parse(committed.task.steerIntent?.message ?? "null")).toEqual({ client_secret: "[redacted]", access_token: "[redacted]", opaque: "[redacted]" });
      expect(JSON.parse(committed.task.error?.message ?? "null")).toMatchObject({
        outer: { clientSecret: "[redacted]", note: "[redacted]", opaque: "[redacted]" },
        items: [{ access_token: "[redacted]" }],
      });
      expect(JSON.parse(committed.task.result?.kind === "inline" ? committed.task.result.text : "null"))
        .toMatchObject({ payload: [{ refresh_token: "[redacted]" }, { safe: "[redacted]" }, { opaque: "[redacted]" }] });
      const terminalSummary = store.listUndeliveredOutbox().find((event) => event.wakeKind === "task_terminal")?.payload.summary;
      expect(JSON.parse(terminalSummary ?? "null")).toMatchObject({
        meta: { idToken: "[redacted]", authorization: "[redacted]" },
        array: ["[redacted]", "[redacted]"],
      });
      expect(store.listUndeliveredOutbox().map((event) => event.wakeKind))
        .toEqual(["task_created", "task_progress", "task_steer", "task_terminal"]);
      const raw = database.prepare(`
        SELECT progress_json, steer_intent_json, result_json, error_json FROM async_tasks WHERE task_id = ?
      `).get(task.taskId) as { progress_json: string; steer_intent_json: string; result_json: string; error_json: string };
      const outbox = database.prepare("SELECT group_concat(payload_json, ' ') AS value FROM async_task_outbox WHERE task_id = ?").get(task.taskId) as { value: string };
      const durable = `${raw.progress_json} ${raw.steer_intent_json} ${raw.result_json} ${raw.error_json} ${outbox.value}`;
      const api = JSON.stringify({ task: store.getTask(task.taskId), outbox: store.listUndeliveredOutbox() });
      for (const forbidden of [
        knownSecret, "progresscamel", "progresssnake", "progress-api", "json-client-secret", "json-access-token",
        "result-refresh", "result-json", "nested-client", "failure-bearer", "nested-access", "wake-id", "wake-auth", "wake-json",
        "api_key=", "api-key=", "client_secret=", "clientsecret=", "access_token=", "accesstoken=",
      ]) {
        expect(durable.toLowerCase()).not.toContain(forbidden);
        expect(api.toLowerCase()).not.toContain(forbidden);
      }
    } finally {
      store.close();
      database.close();
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

describe("AsyncTaskStore persistence validation", () => {
  it("requires every cancelled task or cancelled attempt to carry a coherent abort/budget error", () => {
    const database = new Database(":memory:");
    const store = new AsyncTaskStore({ path: ":memory:", database });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 100 });
      store.recoverExpiredLeases(1_200);
      expect(() => store.transition({ taskId: task.taskId, expectedVersion: 3, to: "cancelled", atMs: 1_210 })).toThrow();

      database.prepare(`
        UPDATE async_tasks SET status = 'cancelled', version = version + 1, finished_at_ms = 1300,
          lease_owner = NULL, lease_expires_at_ms = NULL, lease_attempt = NULL, lease_version = NULL, error_json = NULL
        WHERE task_id = ?
      `).run(task.taskId);
      expect(() => store.getTask(task.taskId)).toThrow();

      const attemptTask = store.dispatch(dispatchInput({ agentId: "agent-attempt-cancel", clientNonce: "bad-cancel-attempt" })).task;
      store.claimNext(attemptTask.agentId, { ownerId: "worker-b", nowMs: 1_100, leaseDurationMs: 500 });
      database.prepare(`
        UPDATE async_task_attempts SET status = 'cancelled', finished_at_ms = 1200,
          lease_owner = NULL, lease_expires_at_ms = NULL, lease_version = NULL, error_json = NULL
        WHERE task_id = ? AND attempt = 1
      `).run(attemptTask.taskId);
      expect(() => store.listAttempts(attemptTask.taskId)).toThrow();
    } finally {
      store.close();
      database.close();
    }
  });

  it("rejects impossible task attempt counts and failed or abandoned records without errors", () => {
    const database = new Database(":memory:");
    const store = new AsyncTaskStore({ path: ":memory:", database });
    try {
      const completed = store.dispatch(dispatchInput({ clientNonce: "completed-zero-attempt" })).task;
      database.prepare(`
        UPDATE async_tasks SET status = 'completed', version = 2, finished_at_ms = 1200,
          result_json = ?, error_json = NULL
        WHERE task_id = ?
      `).run(JSON.stringify({ kind: "inline", text: "ok", bytes: 2, truncated: false }), completed.taskId);
      expect(() => store.getTask(completed.taskId)).toThrow();

      const failedAttempt = store.dispatch(dispatchInput({ agentId: "agent-failed-attempt", clientNonce: "failed-attempt-no-error" })).task;
      store.claimNext(failedAttempt.agentId, { ownerId: "worker-f", nowMs: 1_100, leaseDurationMs: 500 });
      database.prepare(`
        UPDATE async_task_attempts SET status = 'failed', finished_at_ms = 1200,
          lease_owner = NULL, lease_expires_at_ms = NULL, lease_version = NULL, error_json = NULL
        WHERE task_id = ? AND attempt = 1
      `).run(failedAttempt.taskId);
      expect(() => store.listAttempts(failedAttempt.taskId)).toThrow();
      database.prepare("UPDATE async_task_attempts SET status = 'abandoned' WHERE task_id = ? AND attempt = 1").run(failedAttempt.taskId);
      expect(() => store.listAttempts(failedAttempt.taskId)).toThrow();

      const abandonedTask = store.dispatch(dispatchInput({ agentId: "agent-abandoned-task", clientNonce: "abandoned-task-no-error" })).task;
      store.claimNext(abandonedTask.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 500 });
      database.prepare(`
        UPDATE async_tasks SET status = 'abandoned', version = 3,
          lease_owner = NULL, lease_expires_at_ms = NULL, lease_attempt = NULL, lease_version = NULL, error_json = NULL
        WHERE task_id = ?
      `).run(abandonedTask.taskId);
      expect(() => store.getTask(abandonedTask.taskId)).toThrow();
    } finally {
      store.close();
      database.close();
    }
  });

  it("rejects incompatible or future outbox records during list and acknowledge", () => {
    const database = new Database(":memory:");
    const store = new AsyncTaskStore({ path: ":memory:", database });
    try {
      const task = store.dispatch(dispatchInput()).task;
      const event = store.listUndeliveredOutbox()[0]!;
      database.prepare("UPDATE async_task_outbox SET wake_kind = 'task_steer', payload_json = ? WHERE outbox_id = ?")
        .run(JSON.stringify({ status: "admitted", attempt: 0, summary: "forged", code: null, resultRef: null }), event.outboxId);
      expect(() => store.listUndeliveredOutbox()).toThrow();

      database.prepare("UPDATE async_task_outbox SET wake_kind = 'task_created', payload_json = ?, transition_version = 99 WHERE outbox_id = ?")
        .run(JSON.stringify({ status: "queued", attempt: 0, summary: null, code: null, resultRef: null }), event.outboxId);
      expect(() => store.listUndeliveredOutbox()).toThrow();
      expect(() => store.acknowledgeOutbox(event.outboxId, 1_100)).toThrow();
      expect(store.getTask(task.taskId)?.version).toBe(1);
    } finally {
      store.close();
      database.close();
    }
  });

  it("rejects a forged failed terminal wake for an immutable completed task", () => {
    const database = new Database(":memory:");
    const store = new AsyncTaskStore({ path: ":memory:", database });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-a", nowMs: 1_100, leaseDurationMs: 1_000 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-a", attempt: 1, startedAtMs: 1_120 });
      const committed = store.commitTerminal({
        taskId: task.taskId, expectedVersion: 3, leaseOwnerId: "worker-a", attempt: 1,
        status: "completed", finishedAtMs: 1_300,
        result: { kind: "ref", resultRef: "result/completed", bytes: 100, truncated: false }, error: null,
        wakeKind: "task_terminal",
        wakePayload: { status: "completed", attempt: 1, summary: "done", code: null, resultRef: "result/completed" },
      });
      database.prepare("UPDATE async_task_outbox SET payload_json = ? WHERE outbox_id = ?").run(JSON.stringify({
        status: "failed", attempt: 1, summary: "forged", code: "provider_error", resultRef: null,
      }), committed.outboxEvent.outboxId);
      expect(() => store.listUndeliveredOutbox()).toThrow();
      expect(() => store.acknowledgeOutbox(committed.outboxEvent.outboxId, 1_400)).toThrow();
    } finally {
      store.close();
      database.close();
    }
  });

  it("restores task, attempt, grant, budget usage, active lease, and undelivered outbox after restart", () => {
    const databasePath = temporaryDatabasePath();
    const first = new AsyncTaskStore({ path: databasePath });
    const task = first.dispatch(dispatchInput()).task;
    const claimed = first.claimNext(task.agentId, { ownerId: "worker-restart", nowMs: 1_050, leaseDurationMs: 2_000 })!;
    first.reserveTaskBudget(
      task.taskId,
      1,
      { reservationId: "restart-reservation", amounts: { ...zeroCounters, toolCalls: 2 } },
      { leaseOwnerId: "worker-restart", attempt: 1, expectedTaskVersion: claimed.task.version },
      1_050,
    );
    const before = {
      task: first.getTask(task.taskId),
      attempts: first.listAttempts(task.taskId),
      grant: first.getGrant(task.taskId),
      budget: first.getBudgetState(task.taskId),
      outbox: first.listUndeliveredOutbox(),
    };
    first.close();

    const reopened = new AsyncTaskStore({ path: databasePath });
    try {
      expect({
        task: reopened.getTask(task.taskId),
        attempts: reopened.listAttempts(task.taskId),
        grant: reopened.getGrant(task.taskId),
        budget: reopened.getBudgetState(task.taskId),
        outbox: reopened.listUndeliveredOutbox(),
      }).toEqual(before);
    } finally {
      reopened.close();
    }
  });

  it("fails closed when durable JSON no longer matches the closed task contract", () => {
    const database = new Database(":memory:");
    const store = new AsyncTaskStore({ path: ":memory:", database });
    try {
      const task = store.dispatch(dispatchInput()).task;
      database.prepare("UPDATE async_tasks SET lineage_json = ? WHERE task_id = ?").run("{}", task.taskId);
      expect(() => store.getTask(task.taskId)).toThrow();
      database.prepare("UPDATE async_task_grants SET grant_json = ? WHERE task_id = ?").run('{"token":"inline-secret"}', task.taskId);
      expect(() => store.getGrant(task.taskId)).toThrow();
      database.prepare("UPDATE async_task_budget_usage SET usage_json = ? WHERE task_id = ?").run('{"used":{}}', task.taskId);
      expect(() => store.getBudgetState(task.taskId)).toThrow();
    } finally {
      store.close();
      database.close();
    }
  });

  it("fails closed when the current attempt is missing or its lease fence diverges from the task", () => {
    const database = new Database(":memory:");
    const store = new AsyncTaskStore({ path: ":memory:", database });
    try {
      const missing = store.dispatch(dispatchInput({ clientNonce: "missing-attempt" })).task;
      store.claimNext(missing.agentId, { ownerId: "worker-m", nowMs: 1_100, leaseDurationMs: 500 });
      database.prepare("DELETE FROM async_task_attempts WHERE task_id = ? AND attempt = 1").run(missing.taskId);
      expect(() => store.heartbeat({ taskId: missing.taskId, expectedVersion: 2, leaseOwnerId: "worker-m", attempt: 1, nowMs: 1_200, leaseDurationMs: 500 })).toThrow();
      expect(store.getTask(missing.taskId)).toMatchObject({ status: "admitted", version: 2 });

      const divergent = store.dispatch(dispatchInput({ agentId: "agent-divergent", clientNonce: "divergent-attempt" })).task;
      store.claimNext(divergent.agentId, { ownerId: "worker-d", nowMs: 1_100, leaseDurationMs: 500 });
      database.prepare("UPDATE async_task_attempts SET lease_version = lease_version + 1 WHERE task_id = ? AND attempt = 1").run(divergent.taskId);
      expect(() => store.steer({
        taskId: divergent.taskId, agentId: divergent.agentId, parentTurnId: divergent.parentTurnId,
        intentId: randomUUID(), expectedSteerVersion: 0, requestedAtMs: 1_200, message: "must fail closed",
      })).toThrow();
      expect(store.listUndeliveredOutbox().some((event) => event.taskId === divergent.taskId && event.wakeKind === "task_steer")).toBe(false);
    } finally {
      store.close();
      database.close();
    }
  });

  it("fails closed when the indexed grant id diverges from canonical grant JSON", () => {
    const database = new Database(":memory:");
    const store = new AsyncTaskStore({ path: ":memory:", database });
    try {
      const task = store.dispatch(dispatchInput()).task;
      database.prepare("UPDATE async_task_grants SET grant_id = ? WHERE task_id = ?").run(randomUUID(), task.taskId);
      expect(() => store.getGrant(task.taskId)).toThrow();
    } finally {
      store.close();
      database.close();
    }
  });
});

describe("OpenBot async task schema v13", () => {
  it("migrates a populated v7 async-task schema to v15 without losing legacy state", () => {
    const database = new Database(":memory:");
    try {
      expect(OPENBOT_SCHEMA_VERSION).toBe(15);
      const legacyInput = dispatchInput({ agentId: "legacy-agent", parentTurnId: "legacy-turn", clientNonce: "legacy-nonce" });
      const legacyGrant = legacyInput.grant as ProviderCapabilityGrant;
      const legacyAttemptId = randomUUID();
      const legacyOutboxId = randomUUID();
      const legacyProjectionId = randomUUID();
      database.exec(`
        CREATE TABLE async_tasks (
          task_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          parent_turn_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind = 'subagent'),
          status TEXT NOT NULL CHECK (status IN ('queued', 'admitted', 'running', 'retry_wait', 'cancelling', 'completed', 'failed', 'cancelled', 'abandoned')),
          attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
          version INTEGER NOT NULL CHECK (version >= 1),
          client_nonce TEXT NOT NULL,
          depth INTEGER NOT NULL CHECK (depth = 1),
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          started_at_ms INTEGER,
          finished_at_ms INTEGER,
          next_attempt_at_ms INTEGER,
          lease_owner TEXT,
          lease_expires_at_ms INTEGER,
          lease_attempt INTEGER,
          lease_version INTEGER,
          progress_json TEXT,
          result_json TEXT,
          error_json TEXT,
          steer_intent_json TEXT,
          steer_version INTEGER NOT NULL DEFAULT 0 CHECK (steer_version >= 0),
          abort_intent_json TEXT,
          abort_version INTEGER NOT NULL DEFAULT 0 CHECK (abort_version >= 0),
          lineage_json TEXT NOT NULL,
          UNIQUE(agent_id, client_nonce),
          CHECK ((lease_owner IS NULL AND lease_expires_at_ms IS NULL AND lease_attempt IS NULL AND lease_version IS NULL)
            OR (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL AND lease_attempt IS NOT NULL AND lease_version IS NOT NULL))
        );
        CREATE INDEX idx_async_tasks_claim ON async_tasks(agent_id, status, next_attempt_at_ms, created_at_ms, task_id);
        CREATE INDEX idx_async_tasks_parent_lineage ON async_tasks(agent_id, parent_turn_id, created_at_ms, task_id);
        CREATE TABLE async_task_attempts (
          attempt_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          attempt INTEGER NOT NULL CHECK (attempt >= 1),
          status TEXT NOT NULL CHECK (status IN ('admitted', 'running', 'retry_wait', 'cancelling', 'completed', 'failed', 'cancelled', 'abandoned')),
          version INTEGER NOT NULL CHECK (version >= 1),
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          started_at_ms INTEGER,
          finished_at_ms INTEGER,
          lease_owner TEXT,
          lease_expires_at_ms INTEGER,
          lease_version INTEGER,
          error_json TEXT,
          FOREIGN KEY (task_id) REFERENCES async_tasks(task_id) ON DELETE CASCADE,
          UNIQUE(task_id, attempt),
          CHECK ((lease_owner IS NULL AND lease_expires_at_ms IS NULL AND lease_version IS NULL)
            OR (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL AND lease_version IS NOT NULL))
        );
        CREATE INDEX idx_async_task_attempts_task ON async_task_attempts(task_id, attempt);
        CREATE TABLE async_task_grants (
          task_id TEXT PRIMARY KEY,
          grant_id TEXT NOT NULL UNIQUE,
          grant_json TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version >= 1),
          revoked_at_ms INTEGER,
          updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
          FOREIGN KEY (task_id) REFERENCES async_tasks(task_id) ON DELETE CASCADE
        );
        CREATE TABLE async_task_budget_usage (
          task_id TEXT PRIMARY KEY,
          budget_json TEXT NOT NULL,
          usage_json TEXT NOT NULL,
          wall_used_ms INTEGER NOT NULL DEFAULT 0 CHECK (wall_used_ms >= 0),
          wall_reserved_ms INTEGER NOT NULL DEFAULT 0 CHECK (wall_reserved_ms >= 0),
          wall_reservations_json TEXT NOT NULL DEFAULT '{}',
          version INTEGER NOT NULL CHECK (version >= 1),
          updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
          FOREIGN KEY (task_id) REFERENCES async_tasks(task_id) ON DELETE CASCADE
        );
        CREATE TABLE async_task_parent_budget_usage (
          agent_id TEXT NOT NULL,
          parent_turn_id TEXT NOT NULL,
          budget_json TEXT NOT NULL,
          usage_json TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version >= 1),
          updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
          PRIMARY KEY (agent_id, parent_turn_id)
        );
        CREATE TABLE async_task_outbox (
          outbox_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          transition_version INTEGER NOT NULL CHECK (transition_version >= 1),
          wake_kind TEXT NOT NULL CHECK (wake_kind IN ('task_created', 'task_progress', 'task_terminal', 'task_steer', 'task_abort', 'task_recovered')),
          payload_json TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          delivered_at_ms INTEGER,
          FOREIGN KEY (task_id) REFERENCES async_tasks(task_id) ON DELETE CASCADE,
          UNIQUE(task_id, transition_version, wake_kind)
        );
        CREATE INDEX idx_async_task_outbox_undelivered ON async_task_outbox(delivered_at_ms, created_at_ms, outbox_id);
        CREATE TABLE async_task_agent_fences (
          agent_id TEXT PRIMARY KEY,
          fenced_at_ms INTEGER NOT NULL CHECK (fenced_at_ms >= 0)
        );
        CREATE TABLE async_task_projection_state (
          agent_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          epoch TEXT NOT NULL,
          next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1),
          PRIMARY KEY (agent_id, channel)
        );
        CREATE TABLE async_task_projection_outbox (
          projection_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          epoch TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence >= 1),
          task_id TEXT NOT NULL,
          snapshot_version INTEGER NOT NULL CHECK (snapshot_version >= 1),
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          delivered_at_ms INTEGER,
          UNIQUE(agent_id, channel, epoch, sequence),
          FOREIGN KEY (task_id) REFERENCES async_tasks(task_id) ON DELETE CASCADE
        );
        CREATE INDEX idx_async_task_projection_pending
          ON async_task_projection_outbox(delivered_at_ms, agent_id, channel, created_at_ms, sequence);
      `);
      database.prepare(`INSERT INTO async_tasks(
        task_id, agent_id, parent_turn_id, kind, status, attempt, version, client_nonce, depth,
        created_at_ms, started_at_ms, lease_owner, lease_expires_at_ms, lease_attempt, lease_version, lineage_json
      ) VALUES (?, ?, ?, 'subagent', 'running', 1, 3, ?, 1, 1000, 1100, 'legacy-worker', 2000, 1, 3, ?)`).run(
        legacyInput.taskId,
        legacyInput.agentId,
        legacyInput.parentTurnId,
        legacyInput.clientNonce,
        JSON.stringify(legacyInput.lineage),
      );
      database.prepare(`INSERT INTO async_task_attempts(
        attempt_id, task_id, attempt, status, version, created_at_ms, started_at_ms,
        lease_owner, lease_expires_at_ms, lease_version
      ) VALUES (?, ?, 1, 'running', 2, 1000, 1100, 'legacy-worker', 2000, 3)`).run(legacyAttemptId, legacyInput.taskId);
      database.prepare("INSERT INTO async_task_grants VALUES (?, ?, ?, 1, NULL, 1000)").run(
        legacyInput.taskId,
        legacyGrant.grantId,
        JSON.stringify(legacyGrant),
      );
      database.prepare("INSERT INTO async_task_budget_usage VALUES (?, ?, ?, 125, 0, ?, 2, 1200)").run(
        legacyInput.taskId,
        JSON.stringify(budget),
        JSON.stringify({ used: { ...zeroCounters, toolCalls: 1 }, reserved: { ...zeroCounters }, reservations: [] }),
        JSON.stringify({}),
      );
      database.prepare("INSERT INTO async_task_parent_budget_usage VALUES (?, ?, ?, ?, 2, 1200)").run(
        legacyInput.agentId,
        legacyInput.parentTurnId,
        JSON.stringify(budget),
        JSON.stringify({ ...zeroCounters, toolCalls: 2 }),
      );
      database.prepare("INSERT INTO async_task_outbox VALUES (?, ?, 1, 'task_created', ?, 1000, NULL)").run(
        legacyOutboxId,
        legacyInput.taskId,
        JSON.stringify({ status: "queued", attempt: 0, summary: null, code: null, resultRef: null }),
      );
      database.prepare("INSERT INTO async_task_agent_fences VALUES (?, 900)").run("retired-agent");
      database.prepare("INSERT INTO async_task_projection_state VALUES (?, 'async-tasks', 'legacy-epoch', 2)").run(legacyInput.agentId);
      database.prepare("INSERT INTO async_task_projection_outbox VALUES (?, ?, 'async-tasks', 'legacy-epoch', 1, ?, 1, 'task_created', ?, 1000, NULL)").run(
        legacyProjectionId,
        legacyInput.agentId,
        legacyInput.taskId,
        JSON.stringify({ taskId: legacyInput.taskId, status: "queued" }),
      );
      database.pragma("user_version = 7");

      expect((database.pragma("table_info(async_tasks)") as Array<{ name: string }>).map((column) => column.name)).not.toContain("input_json");
      expect((database.pragma("table_info(async_task_projection_outbox)") as Array<{ name: string }>).map((column) => column.name)).not.toContain("source_outbox_id");
      migrateOpenBotSchema(database);

      expect(database.pragma("user_version", { simple: true })).toBe(OPENBOT_SCHEMA_VERSION);
      const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'async_task%'").all() as Array<{ name: string }>).map((row) => row.name).sort();
      expect(tables).toEqual(["async_task_agent_fences", "async_task_attempts", "async_task_budget_usage", "async_task_grants", "async_task_outbox", "async_task_parent_budget_usage", "async_task_projection_outbox", "async_task_projection_state", "async_tasks"]);
      const indexes = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%async_task%'").all() as Array<{ name: string }>).map((row) => row.name));
      expect([...indexes]).toEqual(expect.arrayContaining([
        "idx_async_tasks_claim",
        "idx_async_tasks_list",
        "idx_async_tasks_parent_lineage",
        "idx_async_task_outbox_undelivered",
      ]));
      const listPlan = (database.prepare("EXPLAIN QUERY PLAN SELECT * FROM async_tasks WHERE agent_id = ? ORDER BY created_at_ms DESC, task_id DESC LIMIT ?").all(legacyInput.agentId, 20) as Array<{ detail: string }>).map((step) => step.detail).join(" ");
      expect(listPlan).toContain("idx_async_tasks_list");
      expect(database.prepare(`SELECT task_id, status, attempt, version, client_nonce, input_json,
        settled_at_ms, settlement_nonce FROM async_tasks WHERE task_id = ?`).get(legacyInput.taskId)).toEqual({
        task_id: legacyInput.taskId,
        status: "running",
        attempt: 1,
        version: 3,
        client_nonce: "legacy-nonce",
        input_json: JSON.stringify({
          version: 1,
          objective: "Legacy async task objective",
          source: { kind: "parent_turn", agentId: legacyInput.agentId, turnEntryId: legacyInput.parentTurnId },
        }),
        settled_at_ms: null,
        settlement_nonce: null,
      });
      expect(database.prepare("SELECT attempt_id, status, lease_owner FROM async_task_attempts WHERE task_id = ?").get(legacyInput.taskId)).toEqual({
        attempt_id: legacyAttemptId,
        status: "running",
        lease_owner: "legacy-worker",
      });
      expect(database.prepare("SELECT grant_id, grant_json FROM async_task_grants WHERE task_id = ?").get(legacyInput.taskId)).toEqual({
        grant_id: legacyGrant.grantId,
        grant_json: JSON.stringify(legacyGrant),
      });
      expect(database.prepare("SELECT wall_used_ms, wall_reserved_ms, wall_reservations_json FROM async_task_parent_budget_usage WHERE agent_id = ? AND parent_turn_id = ?").get(
        legacyInput.agentId,
        legacyInput.parentTurnId,
      )).toEqual({ wall_used_ms: 0, wall_reserved_ms: 0, wall_reservations_json: "{}" });
      expect(database.prepare("SELECT source_outbox_id, task_id, delivered_at_ms FROM async_task_projection_outbox WHERE projection_id = ?").get(legacyProjectionId)).toEqual({
        source_outbox_id: legacyProjectionId,
        task_id: legacyInput.taskId,
        delivered_at_ms: null,
      });
      expect(database.prepare("SELECT outbox_id FROM async_task_outbox WHERE task_id = ?").get(legacyInput.taskId)).toEqual({ outbox_id: legacyOutboxId });
      expect(database.prepare("SELECT fenced_at_ms FROM async_task_agent_fences WHERE agent_id = 'retired-agent'").get()).toEqual({ fenced_at_ms: 900 });
      expect(() => database.prepare("UPDATE async_tasks SET input_json = NULL WHERE task_id = ?").run(legacyInput.taskId)).toThrow();
      expect(() => database.prepare(`INSERT INTO async_tasks(
        task_id, agent_id, parent_turn_id, kind, status, attempt, version, client_nonce, depth,
        created_at_ms, lineage_json, input_json
      ) SELECT ?, agent_id, parent_turn_id, kind, 'queued', 0, 1, client_nonce, depth,
        created_at_ms, lineage_json, input_json FROM async_tasks WHERE task_id = ?`).run(randomUUID(), legacyInput.taskId)).toThrow();
      const store = new AsyncTaskStore({ path: ":memory:", database });
      expect(store.getTask(legacyInput.taskId)).toMatchObject({ status: "running", input: JSON.parse((database.prepare("SELECT input_json FROM async_tasks WHERE task_id = ?").get(legacyInput.taskId) as { input_json: string }).input_json) });
      expect(store.dispatch(dispatchInput({ agentId: legacyInput.agentId, clientNonce: legacyInput.clientNonce })).created).toBe(false);
      store.close();
    } finally {
      database.close();
    }
  });
});
