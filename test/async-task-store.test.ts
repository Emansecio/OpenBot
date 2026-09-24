import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BudgetCounters,
  DispatchAsyncTaskInput,
  ProviderCapabilityGrant,
  SubagentBudget,
} from "../src/tasks/contracts.js";
import { AsyncTaskStore as DurableAsyncTaskStore } from "../src/tasks/store.js";
import type { AsyncTaskStoreOptions } from "../src/tasks/store.js";
import { TempRoots } from "./helpers/temp-roots.js";

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
          else if (property === "markUnsafeEffectStarted") clock = Number(input?.markedAtMs);
          else if ((property === "expireBudgetExhaustedTasks" || property === "recoverExpiredLeases") && args[0] !== undefined) clock = Number(args[0]);
          else if (property === "reserveTaskBudget" && args[4] !== undefined) clock = Number(args[4]);
          else if (property === "reconcileTaskBudget" && args[5] !== undefined) clock = Number(args[5]);
          return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }
}

const temp = new TempRoots();

afterEach(async () => {
  await temp.cleanup();
});

function temporaryDatabasePath(): string {
  const dir = temp.make("openbot-async-task-");
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
  it("shares projection batches across agents so a blocked agent cannot starve later events", () => {
    const store = new AsyncTaskStore({ path: ":memory:" });
    try {
      for (let index = 0; index < 101; index += 1) {
        store.dispatch(dispatchInput({
          agentId: "agent-a",
          clientNonce: `agent-a-${index}`,
          taskId: randomUUID(),
          createdAtMs: 1_000 + index,
        }));
      }
      store.dispatch(dispatchInput({
        agentId: "agent-b",
        clientNonce: "agent-b-0",
        taskId: randomUUID(),
        createdAtMs: 1_200,
      }));
      // The second agent's event is deliberately inserted after agent A's
      // first batch; it must still be selected in the same fair batch.
      const projected = store.projectUndelivered(100);
      expect(projected.some((event) => event.agentId === "agent-b")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("advances a subscribed channel while another channel for the same agent stays pending", () => {
    const store = new AsyncTaskStore({ path: ":memory:" });
    try {
      const first = store.dispatch(dispatchInput({ agentId: "agent-a", clientNonce: "channel-first", taskId: randomUUID(), createdAtMs: 1_000 })).task;
      const second = store.dispatch(dispatchInput({ agentId: "agent-a", clientNonce: "channel-second", taskId: randomUUID(), createdAtMs: 1_001 })).task;
      const batch = store.projectUndelivered(2);
      expect(batch.map((event) => event.taskId)).toEqual([first.taskId, first.taskId]);
      const accepted = batch.find((event) => event.channel === "async-tasks")!;
      store.acknowledgeProjection(accepted.projectionId, true, 1_100);
      const next = store.projectUndelivered(2);
      expect(next.some((event) => event.channel === "async-tasks" && event.taskId === second.taskId)).toBe(true);
      expect(next.some((event) => event.channel === "subagents" && event.taskId === first.taskId)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("rotates one-item batches past undelivered streams", () => {
    const store = new AsyncTaskStore({ path: ":memory:" });
    try {
      store.dispatch(dispatchInput({ agentId: "agent-a", clientNonce: "small-a", taskId: randomUUID(), createdAtMs: 1_000 }));
      store.dispatch(dispatchInput({ agentId: "agent-b", clientNonce: "small-b", taskId: randomUUID(), createdAtMs: 1_001 }));
      const agents = Array.from({ length: 4 }, () => store.projectUndelivered(1)[0]?.agentId);
      expect(agents).toContain("agent-a");
      expect(agents).toContain("agent-b");
    } finally {
      store.close();
    }
  });

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

  it("persists the unsafe-effect fence before dispatch and rejects retry transitions", () => {
    const store = new AsyncTaskStore({ path: temporaryDatabasePath() });
    try {
      const task = store.dispatch(dispatchInput()).task;
      store.claimNext(task.agentId, { ownerId: "worker-effect", nowMs: 1_100, leaseDurationMs: 500 });
      store.start({ taskId: task.taskId, expectedVersion: 2, leaseOwnerId: "worker-effect", attempt: 1, startedAtMs: 1_120 });
      const marked = store.markUnsafeEffectStarted({
        taskId: task.taskId, expectedVersion: 3, leaseOwnerId: "worker-effect", attempt: 1, markedAtMs: 1_130,
      });
      expect(marked).toMatchObject({ status: "running", version: 4 });
      expect(store.listAttempts(task.taskId)[0]).toMatchObject({ unsafeEffectStarted: true, version: 3 });
      expect(store.markUnsafeEffectStarted({
        taskId: task.taskId, expectedVersion: 4, leaseOwnerId: "worker-effect", attempt: 1, markedAtMs: 1_131,
      })).toEqual(marked);
      expect(() => store.heartbeat({
        taskId: task.taskId, expectedVersion: 3, leaseOwnerId: "worker-effect", attempt: 1,
        nowMs: 1_135, leaseDurationMs: 500,
      })).toThrow();
      expect(store.heartbeat({
        taskId: task.taskId, expectedVersion: 4, leaseOwnerId: "worker-effect", attempt: 1,
        nowMs: 1_135, leaseDurationMs: 500,
      })).toMatchObject({ version: 5, status: "running" });
      expect(store.listAttempts(task.taskId)[0]).toMatchObject({ unsafeEffectStarted: true });
      expect(() => store.transition({
        taskId: task.taskId, expectedVersion: 5, to: "retry_wait", atMs: 1_140,
        leaseOwnerId: "worker-effect", attempt: 1, nextAttemptAtMs: 1_200,
        error: { code: "provider_error", message: "retry later", retryable: true },
      })).toThrow("outcome is uncertain");
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
