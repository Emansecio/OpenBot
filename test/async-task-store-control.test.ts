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
import { TASK_RESULT_MIN_TRUNCATION_MARKER, TASK_RESULT_TRUNCATION_MARKER, assertGrantAllowsOperation } from "../src/tasks/state-machine.js";
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
