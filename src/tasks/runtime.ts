import { randomUUID } from "node:crypto";

import { ProviderAdmissionScheduler } from "../providers/admission.js";
import {
  AsyncTaskContractError,
  type AsyncTaskFailure,
  type AsyncTaskRecord,
  type AsyncTaskResult,
  type BudgetCounters,
  type DelegatedCapabilityOperation,
} from "./contracts.js";
import { assertGrantAllowsOperation } from "./state-machine.js";
import { AsyncTaskStore } from "./store.js";
import { projectAsyncTaskForRenderer } from "./projection.js";

const ZERO_USAGE: BudgetCounters = {
  providerCalls: 0, inputTokens: 0, outputTokens: 0, toolRounds: 0, toolCalls: 0,
  mcpCalls: 0, browserCommands: 0, resultBytes: 0, workspaceWriteBytes: 0,
};

/** Maximum number of async task executions in the shared worker by default. */
export const DEFAULT_ASYNC_TASK_MAX_CONCURRENT = 4;

// Durable budget counters are token-shaped, not byte-shaped. Counting Unicode
// code points is intentionally conservative (especially for ASCII) while
// avoiding UTF-8 byte inflation for CJK and other multi-byte text.
function estimateTextTokens(value: string): number {
  return Array.from(value).length;
}

export interface AsyncTaskExecutionContext {
  readonly task: AsyncTaskRecord;
  readonly signal: AbortSignal;
  readonly objective: string;
  readonly grant: import("./contracts.js").DelegatedCapabilityGrant;
  /** Every injected effect must cross this grant boundary before it runs. */
  readonly runEffect: <T>(operation: DelegatedCapabilityOperation, call: () => Promise<T>, options?: { readonly reserve?: Partial<BudgetCounters>; readonly usage?: (result: T) => Partial<BudgetCounters>; readonly retrySafe?: boolean }) => Promise<T>;
  readonly runProvider: <T>(operation: DelegatedCapabilityOperation & { kind: "provider" }, call: () => Promise<T>) => Promise<T>;
  readonly authorize: (operation: DelegatedCapabilityOperation) => void;
  readonly consumeSteer: () => string | null;
}

export interface AsyncTaskExecutionResult {
  readonly result: AsyncTaskResult | string;
  readonly usage?: Partial<BudgetCounters>;
}

export interface AsyncTaskRuntimeOptions {
  readonly store: AsyncTaskStore;
  readonly agentIds: () => readonly string[];
  readonly execute: (context: AsyncTaskExecutionContext) => Promise<AsyncTaskExecutionResult>;
  readonly providerAdmission?: ProviderAdmissionScheduler;
  readonly ownerId?: string;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  /** Global task execution cap; each agent still has at most one active claim. */
  readonly maxConcurrentTasks?: number;
  readonly now?: () => number;
  /**
   * P2.2: each durable outbox event is enriched with the native renderer
   * projection before delivery (type "update", parentAgentId and the single
   * projected item under `tasks` / `subagents`) while preserving the
   * durable epoch/sequence/agentId/channel fields.
   */
  readonly publishProjection?: (envelope: import("./contracts.js").AsyncTaskProjectionEnvelope & import("./projection.js").NativeAsyncTaskProjectionLiveEvent) => boolean | Promise<boolean>;
}

/** One shared-process durable worker. It never creates a process/home/database. */
export class AsyncTaskRuntime {
  private readonly store: AsyncTaskStore;
  private readonly agentIds: () => readonly string[];
  private readonly execute: AsyncTaskRuntimeOptions["execute"];
  private readonly providerAdmission?: ProviderAdmissionScheduler;
  private readonly ownerId: string;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxConcurrentTasks: number;
  private readonly nowFn: () => number;
  private readonly publishProjection?: AsyncTaskRuntimeOptions["publishProjection"];
  private stopped = true;
  private loopPromise: Promise<void> | null = null;
  private readonly waiters = new Set<() => void>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeClaims = new Map<string, Promise<void>>();
  private roundRobinCursor = 0;
  private projectionFailureCount = 0;
  private projectionRetryAtMs = 0;

  constructor(options: AsyncTaskRuntimeOptions) {
    this.store = options.store;
    this.agentIds = options.agentIds;
    this.execute = options.execute;
    this.providerAdmission = options.providerAdmission;
    this.ownerId = options.ownerId ?? `async-worker-${randomUUID()}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    this.leaseDurationMs = options.leaseDurationMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 100;
    this.maxConcurrentTasks = options.maxConcurrentTasks ?? DEFAULT_ASYNC_TASK_MAX_CONCURRENT;
    this.nowFn = options.now ?? Date.now;
    this.publishProjection = options.publishProjection;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) throw new Error("pollIntervalMs must be positive");
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs < 100) throw new Error("leaseDurationMs must be at least 100ms");
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error("maxAttempts must be positive");
    if (!Number.isSafeInteger(this.maxConcurrentTasks) || this.maxConcurrentTasks < 1 || this.maxConcurrentTasks > 64) {
      throw new Error("maxConcurrentTasks must be an integer between 1 and 64");
    }
  }

  start(): void {
    if (!this.stopped) return;
    // A bounded stop may return while an executor is still ignoring its
    // AbortSignal. Do not start a second shared worker against the same store
    // until the first loop has actually drained.
    if (this.loopPromise !== null) return;
    this.stopped = false;
    this.recoverExpiredWork();
    const loop = this.loop();
    this.loopPromise = loop;
    void loop.then(
      () => { if (this.loopPromise === loop) this.loopPromise = null; },
      () => { if (this.loopPromise === loop) this.loopPromise = null; },
    );
  }

  private recoverExpiredWork(): void {
    const now = this.nowFn();
    for (const agentId of this.agentIds()) {
      for (const recovered of this.store.recoverExpiredLeases(now, agentId)) {
        if (recovered.agentId !== agentId || recovered.status !== "abandoned") continue;
        this.store.liquidateAbandonedBudget(recovered.taskId, now);
        if (recovered.attempt >= this.maxAttempts) {
          const grant = this.store.getGrant(recovered.taskId);
          const revoked = grant?.revokedAt !== undefined && grant.revokedAt <= now;
          try {
            this.store.transition({
              taskId: recovered.taskId, expectedVersion: recovered.version,
              to: revoked ? "cancelled" : "failed", atMs: now,
              error: revoked
                ? { code: "capability_denied", message: "Recovered task capability grant was revoked after retry exhaustion.", retryable: false }
                : { code: "internal_error", message: "Task lease recovery exhausted the retry limit.", retryable: false },
            });
          } catch {
            // Another process may have won the durable recovery CAS.
          }
          continue;
        }
        try {
          this.store.transition({
            taskId: recovered.taskId, expectedVersion: recovered.version, to: "retry_wait", atMs: now,
            nextAttemptAtMs: now, error: { code: "internal_error", message: "Worker lease recovered after process restart.", retryable: true },
          });
        } catch {
          // A revoked grant cannot enter retry_wait. Make that decision
          // durable so the recovered task cannot remain permanently stuck.
          try {
            this.store.transition({
              taskId: recovered.taskId, expectedVersion: recovered.version, to: "cancelled", atMs: now,
              error: { code: "capability_denied", message: "Recovered task capability grant was revoked before retry.", retryable: false },
            });
          } catch {
            // Another process may have won the durable recovery CAS.
          }
        }
      }
    }
  }

  async stop(deadlineMs = 5_000): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.notifyWaiters();
    const loop = this.loopPromise;
    if (loop === null) return;
    const timeout = new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, Math.max(1, deadlineMs));
      handle.unref?.();
    });
    await Promise.race([loop, timeout]);
  }

  wake(): void {
    if (this.stopped) return;
    this.notifyWaiters();
  }

  async drain(): Promise<void> {
    await this.whenIdle();
  }

  /** True only after the worker loop and any in-flight claim have settled. */
  isIdle(): boolean {
    return this.loopPromise === null;
  }

  /** Resolves when a bounded stop's deferred claim has really drained. */
  async whenIdle(): Promise<void> {
    const loop = this.loopPromise;
    if (loop !== null) await loop;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const progressed = this.scheduleClaims();
      await this.flushProjections();
      if (!progressed) await this.waitForWork();
    }
    // A bounded stop must keep the loop promise alive until every launched
    // claim has settled. This preserves the existing whenIdle/shutdown fence
    // even though claims now run concurrently.
    await Promise.allSettled(this.activeClaims.values());
  }

  /**
   * Claims a fair round-robin slice without awaiting executors. A claim is
   * tracked before its promise starts so the same agent can never own two
   * active leases, while independent agents can make progress concurrently.
   */
  private scheduleClaims(): boolean {
    const agents = Array.from(new Set(this.agentIds()));
    if (agents.length === 0 || this.activeClaims.size >= this.maxConcurrentTasks) return false;
    const start = this.roundRobinCursor % agents.length;
    let scanned = 0;
    let progressed = false;
    while (!this.stopped && this.activeClaims.size < this.maxConcurrentTasks && scanned < agents.length) {
      const agentId = agents[(start + scanned) % agents.length]!;
      scanned += 1;
      if (this.activeClaims.has(agentId)) continue;
      let claim;
      try {
        claim = this.store.claimNext(agentId, {
          ownerId: this.ownerId,
          nowMs: this.nowFn(),
          leaseDurationMs: this.leaseDurationMs,
        });
      } catch {
        // A concurrent revocation/expiry must not kill the shared worker.
        continue;
      }
      if (claim === null) continue;
      progressed = true;
      const execution = this.runClaim(claim.task, claim.lease.ownerId, claim.lease.attempt)
        .catch(() => {
          // Isolate a single claim's CAS/start failure from later tasks.
        })
        .finally(() => {
          if (this.activeClaims.get(agentId) === execution) this.activeClaims.delete(agentId);
          this.notifyWaiters();
        });
      this.activeClaims.set(agentId, execution);
    }
    this.roundRobinCursor = (start + Math.max(1, scanned)) % agents.length;
    return progressed;
  }

  /** Waits for a claim/completion wake, with polling as a bounded fallback. */
  private waitForWork(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        this.waiters.delete(settle);
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      this.waiters.add(settle);
      timer = setTimeout(settle, this.pollIntervalMs);
      timer.unref?.();
    });
  }

  private notifyWaiters(): void {
    for (const settle of Array.from(this.waiters)) settle();
  }

  private async flushProjections(): Promise<void> {
    if (this.publishProjection === undefined) return;
    if (Date.now() < this.projectionRetryAtMs) return;
    try {
      const pending = this.store.projectUndelivered(100);
      let failed = false;
      for (const envelope of pending) {
        // The pending projection comes from the durable outbox; the native item
        // is read from the current SQLite record (never an artificial fixture).
        // SSE receipt never mutates task state — acknowledgements only clear the
        // durable outbox after a real transport accept.
        const record = this.store.getTask(envelope.taskId);
        const event: Parameters<NonNullable<AsyncTaskRuntimeOptions["publishProjection"]>>[0] = {
          ...envelope,
          type: "update",
          parentAgentId: record?.lineage.parentAgentId ?? envelope.agentId,
          ...(envelope.channel === "async-tasks"
            ? { tasks: record === null ? [] : [projectAsyncTaskForRenderer(record)] }
            : { subagents: record === null ? [] : [projectAsyncTaskForRenderer(record)] }),
        };
        try {
          const accepted = await this.publishProjection(event);
          if (!accepted) {
            failed = true;
            continue;
          }
          this.store.acknowledgeProjection(envelope.projectionId, true, this.nowFn());
        } catch {
          // One unavailable channel must not head-of-line block projections
          // for another subscribed channel. The durable row stays pending.
          failed = true;
        }
      }
      if (failed) {
        this.projectionFailureCount = Math.min(this.projectionFailureCount + 1, 7);
        this.projectionRetryAtMs = Date.now() + Math.min(5_000, 100 * (2 ** (this.projectionFailureCount - 1)));
      } else {
        this.projectionFailureCount = 0;
        this.projectionRetryAtMs = 0;
      }
    } catch {
      this.projectionFailureCount = Math.min(this.projectionFailureCount + 1, 7);
      this.projectionRetryAtMs = Date.now() + Math.min(5_000, 100 * (2 ** (this.projectionFailureCount - 1)));
    }
  }

  private async runClaim(task: AsyncTaskRecord, leaseOwnerId: string, attempt: number): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.taskId, controller);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let current = task;
    let budgetVersion = 1;
    let unsafeEffectStarted = false;
    try {
      current = this.store.start({ taskId: task.taskId, expectedVersion: task.version, leaseOwnerId, attempt, startedAtMs: this.nowFn() });
      budgetVersion = this.store.getBudgetState(task.taskId)?.version ?? 1;
      const budget = this.store.getBudgetState(task.taskId);
      if (budget === null) throw new AsyncTaskContractError("budget_exhausted", "Task budget is missing.");
      const latest = this.store.getTask(task.taskId);
      if (latest === null) return;
      current = latest;
      budgetVersion = this.store.getBudgetState(task.taskId)?.version ?? budgetVersion;
      heartbeat = setInterval(() => {
        try {
          const observed = this.store.getTask(task.taskId);
          if (observed?.abortIntent?.consumedAtMs === null) {
            current = this.store.consumeAbortIntent(task.taskId, leaseOwnerId, attempt, this.nowFn());
            controller.abort(new Error("task abort intent"));
            return;
          }
          current = this.store.heartbeat({ taskId: task.taskId, expectedVersion: current.version, leaseOwnerId, attempt, nowMs: this.nowFn(), leaseDurationMs: this.leaseDurationMs });
        } catch {
          controller.abort();
        }
      }, Math.max(25, Math.floor(this.leaseDurationMs / 3)));
      heartbeat.unref?.();
      const reserveEffect = (amounts: Partial<BudgetCounters>, reservationId: string): { amounts: BudgetCounters; version: number } => {
        const normalized = { ...ZERO_USAGE, ...amounts };
        const latest = this.store.getTask(task.taskId);
        if (latest === null) throw new Error("Task disappeared before effect reservation.");
        current = latest;
        const state = this.store.getBudgetState(task.taskId);
        if (state === null) throw new AsyncTaskContractError("budget_exhausted", "Task budget is missing.");
        const reserved = this.store.reserveTaskBudget(task.taskId, state.version, { reservationId, amounts: normalized }, {
          leaseOwnerId, attempt, expectedTaskVersion: current.version,
        }, this.nowFn());
        budgetVersion = reserved.version;
        return { amounts: normalized, version: reserved.version };
      };
      const reconcileEffect = (reservationId: string, amounts: BudgetCounters, actual: Partial<BudgetCounters>): void => {
        const latest = this.store.getTask(task.taskId);
        if (latest === null) throw new Error("Task disappeared during effect reconciliation.");
        current = latest;
        const reconciled = this.store.reconcileTaskBudget(task.taskId, budgetVersion, reservationId, { ...ZERO_USAGE, ...actual }, {
          leaseOwnerId, attempt, expectedTaskVersion: current.version,
        }, this.nowFn());
        budgetVersion = reconciled.version;
        void amounts;
      };
      const defaultReservation = (operation: DelegatedCapabilityOperation): Partial<BudgetCounters> => {
        const state = this.store.getBudgetState(task.taskId);
        if (state === null) return {};
        const toolEffect = { toolRounds: 1, toolCalls: 1 };
        switch (operation.kind) {
          case "provider": return { providerCalls: 1, inputTokens: estimateTextTokens(current.input.objective), outputTokens: state.budget.maxOutputTokens };
          case "mcp": return { ...toolEffect, mcpCalls: 1 };
          case "browser": return { ...toolEffect, browserCommands: 1 };
          case "skill": return toolEffect;
          case "process": return toolEffect;
          case "filesystem": return operation.operation === "write" ? { ...toolEffect, workspaceWriteBytes: state.budget.maxWorkspaceWriteBytes } : toolEffect;
        }
      };
      const runEffectImpl = async <T>(operation: DelegatedCapabilityOperation, call: () => Promise<T>, options: { readonly reserve?: Partial<BudgetCounters>; readonly usage?: (result: T) => Partial<BudgetCounters>; readonly retrySafe?: boolean } = {}): Promise<T> => {
        context.authorize(operation);
        if (controller.signal.aborted) throw new Error("Task was aborted before effect admission.");
        const reservationId = `effect-${task.taskId}-${attempt}-${randomUUID()}`;
        const reserved = reserveEffect(options.reserve ?? defaultReservation(operation), reservationId);
        let started = false;
        if (!options.retrySafe) unsafeEffectStarted = true;
        try {
          started = true;
          const result = await call();
          reconcileEffect(reservationId, reserved.amounts, options.usage?.(result) ?? reserved.amounts);
          return result;
        } catch (error) {
          try { reconcileEffect(reservationId, reserved.amounts, started ? reserved.amounts : ZERO_USAGE); } catch { /* lease recovery conservatively owns the reservation */ }
          throw error;
        }
      };
      const runEffect = async <T>(operation: DelegatedCapabilityOperation, call: () => Promise<T>, options: { readonly reserve?: Partial<BudgetCounters>; readonly usage?: (result: T) => Partial<BudgetCounters>; readonly retrySafe?: boolean } = {}): Promise<T> => {
        if (operation.kind === "provider") {
          throw new AsyncTaskContractError("invalid_contract", "Provider effects must use runProvider admission.");
        }
        const minimum = defaultReservation(operation);
        const requested = options.reserve ?? {};
        const reserve = Object.fromEntries(Object.keys({ ...minimum, ...requested }).map((key) => [
          key,
          Math.max((minimum as Record<string, number>)[key] ?? 0, (requested as Record<string, number>)[key] ?? 0),
        ])) as Partial<BudgetCounters>;
        return runEffectImpl(operation, call, { ...options, reserve });
      };
      const context: AsyncTaskExecutionContext = {
        task: current,
        grant: this.store.getGrant(task.taskId) ?? (() => { throw new AsyncTaskContractError("capability_denied", "Task grant is missing."); })(),
        signal: controller.signal,
        objective: current.input.objective,
        authorize: (operation) => {
          const grant = this.store.getGrant(task.taskId);
          if (grant === null) throw new AsyncTaskContractError("capability_denied", "Task grant is missing.");
          assertGrantAllowsOperation(grant, operation, {
            now: this.nowFn(), currentVersion: grant.version, expectedGrantId: grant.grantId,
            taskId: current.taskId, parentAgentId: current.lineage.parentAgentId,
            parentTurnId: current.lineage.parentTurnId, childRunId: current.lineage.childRunId,
          });
        },
        runEffect,
        runProvider: async (operation, call) => {
          context.authorize(operation);
          if (controller.signal.aborted) throw new Error("Task was aborted before provider admission.");
          let lease: { release: () => void } | undefined;
          if (this.providerAdmission !== undefined) lease = await this.providerAdmission.acquire(current.agentId, controller.signal);
          const execute = async () => {
            return call();
          };
          try {
            const state = this.store.getBudgetState(task.taskId);
            const outputRemaining = state === null ? 0 : Math.max(0, state.budget.maxOutputTokens - state.usage.used.outputTokens - state.usage.reserved.outputTokens);
            // The shipped adapters enforce a 16-token protocol minimum. Do
            // not invoke one with a larger effective cap than the remaining
            // durable budget; wait/retry cannot make that effect safe.
            if (outputRemaining < 16) throw new AsyncTaskContractError("budget_exhausted", "Provider output budget is exhausted.");
            return await runEffectImpl(operation, execute, {
              reserve: { providerCalls: 1, inputTokens: estimateTextTokens(current.input.objective), outputTokens: outputRemaining },
              usage: (result) => ({
                providerCalls: 1,
                inputTokens: estimateTextTokens(current.input.objective),
                outputTokens: (() => {
                  const outputTokens = typeof result === "string"
                    ? estimateTextTokens(result)
                    : (typeof result === "object" && result !== null && "message" in result && typeof (result as { message?: { content?: unknown } }).message?.content === "string" ? estimateTextTokens((result as { message: { content: string } }).message.content) : 0);
                  if (outputTokens > outputRemaining) throw new AsyncTaskContractError("budget_exhausted", "Provider output exceeded the remaining token budget.");
                  return outputTokens;
                })(),
              }),
            });
          } finally {
            lease?.release();
          }
        },
        consumeSteer: () => {
          const steer = this.store.getTask(task.taskId)?.steerIntent;
          if (steer !== undefined && steer !== null && steer.consumedAtMs === null) {
            try { this.store.consumeSteerIntent(task.taskId, leaseOwnerId, attempt, this.nowFn()); } catch { /* lease/abort wins */ }
            return steer.message;
          }
          return null;
        },
      };
      const beforeExecute = this.store.getTask(task.taskId);
      if (beforeExecute?.abortIntent?.consumedAtMs === null) {
        current = this.store.consumeAbortIntent(task.taskId, leaseOwnerId, attempt, this.nowFn());
        controller.abort(new Error("task abort intent"));
      }
      if (controller.signal.aborted || beforeExecute?.status === "cancelling") throw new Error("Task was aborted before executor start.");
      const execution = await this.execute(context);
      if (this.stopped) {
        this.finalizeShutdownClaim(task.taskId, leaseOwnerId, attempt);
        return;
      }
      if (execution.usage !== undefined && Object.values(execution.usage).some((value) => typeof value === "number" && value !== 0)) {
        throw new AsyncTaskContractError("invalid_contract", "Executor usage must be reported through runEffect.");
      }
      const latestTask = this.store.getTask(task.taskId);
      if (latestTask === null) return;
      current = latestTask;
      if (controller.signal.aborted || current.status === "cancelling" || current.abortIntent?.consumedAtMs === null) {
        if (current.abortIntent?.consumedAtMs === null) current = this.store.consumeAbortIntent(task.taskId, leaseOwnerId, attempt, this.nowFn());
        throw new Error("Task was aborted before terminal commit.");
      }
      const result: AsyncTaskResult = typeof execution.result === "string"
        ? { kind: "inline", text: execution.result, bytes: Buffer.byteLength(execution.result, "utf8"), truncated: false }
        : execution.result;
      const resultBytes = Math.min(result.bytes, budget.budget.maxResultBytes);
      const resultReservationId = `result-${task.taskId}-${attempt}-${randomUUID()}`;
      const resultReservation = reserveEffect({ resultBytes }, resultReservationId);
      reconcileEffect(resultReservationId, resultReservation.amounts, { resultBytes });
      this.store.commitTerminal({
        taskId: task.taskId, expectedVersion: current.version, leaseOwnerId, attempt,
        status: "completed", finishedAtMs: this.nowFn(), result, error: null, wakeKind: "task_terminal",
        wakePayload: { status: "completed", attempt, summary: "completed", code: null, resultRef: result.kind === "ref" ? result.resultRef : null },
      });
    } catch (error) {
      if (this.stopped) {
        this.finalizeShutdownClaim(task.taskId, leaseOwnerId, attempt);
        return;
      }
      const failure: AsyncTaskFailure = {
        code: error instanceof AsyncTaskContractError ? error.code === "budget_exhausted" ? "budget_exhausted" : error.code === "capability_denied" ? "capability_denied" : "internal_error" : "internal_error",
        message: error instanceof Error ? error.message : String(error),
        retryable: !(error instanceof AsyncTaskContractError && (error.code === "budget_exhausted" || error.code === "capability_denied")),
      };
      const latest = this.store.getTask(task.taskId);
      if (latest === null || latest.status === "cancelled" || latest.status === "completed" || latest.status === "failed") return;
      current = latest;
      if (current.status !== "running" && current.status !== "cancelling") return;
      if (failure.retryable && !unsafeEffectStarted && attempt < this.maxAttempts && current.status === "running") {
        this.store.transition({ taskId: task.taskId, expectedVersion: current.version, to: "retry_wait", atMs: this.nowFn(), leaseOwnerId, attempt, nextAttemptAtMs: this.nowFn() + this.retryDelayMs, error: failure });
      } else if (current.status === "running" || current.status === "cancelling") {
        this.store.commitTerminal({
          taskId: task.taskId, expectedVersion: current.version, leaseOwnerId, attempt,
          status: controller.signal.aborted ? "cancelled" : "failed", finishedAtMs: this.nowFn(), result: null,
          error: controller.signal.aborted ? { code: "aborted", message: "Task aborted.", retryable: false } : failure,
          wakeKind: "task_terminal",
          wakePayload: { status: controller.signal.aborted ? "cancelled" : "failed", attempt, summary: failure.message, code: controller.signal.aborted ? "aborted" : failure.code, resultRef: null },
        });
      }
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      this.controllers.delete(task.taskId);
    }
  }

  /** Fence a non-cooperative claim after bounded shutdown finally drains. */
  private finalizeShutdownClaim(taskId: string, leaseOwnerId: string, attempt: number): void {
    let current = this.store.getTask(taskId);
    if (current === null || (current.status !== "running" && current.status !== "cancelling")) return;
    if (current.lease?.ownerId !== leaseOwnerId || current.lease.attempt !== attempt) return;
    try {
      if (current.status === "running") {
        current = this.store.abort({
          taskId, agentId: current.agentId, parentTurnId: current.parentTurnId,
          intentId: `shutdown-${taskId}-${attempt}`,
          expectedAbortVersion: current.abortVersion, requestedAtMs: this.nowFn(), reason: "shutdown",
        });
      }
      if (current.status === "cancelled") return;
      this.store.commitTerminal({
        taskId, expectedVersion: current.version, leaseOwnerId, attempt,
        status: "cancelled", finishedAtMs: this.nowFn(), result: null,
        error: { code: "aborted", message: "Task cancelled during runtime shutdown.", retryable: false },
        wakeKind: "task_terminal",
        wakePayload: { status: "cancelled", attempt, summary: "Task cancelled during runtime shutdown.", code: "aborted", resultRef: null },
      });
    } catch (error) {
      // A concurrent abort/recovery may have won the CAS fence. If it did not,
      // leave the durable lease for normal recovery rather than throwing from
      // the worker cleanup path.
      void error;
    }
  }
}
