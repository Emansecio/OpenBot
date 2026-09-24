import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { migrateOpenBotSchema, OPENBOT_SCHEMA_VERSION } from "../src/store/schema.js";
import type { BudgetCounters, DispatchAsyncTaskInput, ProviderCapabilityGrant, SubagentBudget } from "../src/tasks/contracts.js";
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
  it("migrates a populated v7 async-task schema to the current version without losing legacy state", () => {
    const database = new Database(":memory:");
    try {
      expect(OPENBOT_SCHEMA_VERSION).toBe(20);
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
      expect(database.prepare("SELECT unsafe_effect_started FROM async_task_attempts WHERE task_id = ?").get(legacyInput.taskId)).toEqual({
        unsafe_effect_started: 1,
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
