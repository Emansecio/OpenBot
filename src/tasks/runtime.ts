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
  private readonly agentControllers = new Map<string, { taskId: string; controller: AbortController }>();
  private readonly agentFences = new Map<string, number>();
  private readonly activeClaims = new Map<string, Promise<void>>();
  private recoveryNextAtMs = 0;
  private recoveryFailureCount = 0;
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
    this.runRecovery(this.activeClaimTaskIds(), true);
    const loop = this.loop();
    this.loopPromise = loop;
    void loop.then(
      () => { if (this.loopPromise === loop) this.loopPromise = null; },
      () => { if (this.loopPromise === loop) this.loopPromise = null; },
    );
  }

  private recoveryIntervalMs(): number {
    return Math.max(this.pollIntervalMs, Math.floor(this.leaseDurationMs / 3));
  }

  private scheduleNextRecovery(nowMs: number, failed = false): void {
    if (!failed) this.recoveryFailureCount = 0;
    const backoff = failed
      ? Math.min(5_000, this.recoveryIntervalMs() * (2 ** Math.max(0, this.recoveryFailureCount - 1)))
      : this.recoveryIntervalMs();
    const next = nowMs + backoff;
    this.recoveryNextAtMs = Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER;
  }

  private activeClaimTaskIds(): readonly string[] {
    return Array.from(new Set(Array.from(this.agentControllers.values(), (entry) => entry.taskId)));
  }

  private reportRecoveryFailure(scope: string, error: unknown): void {
    this.recoveryFailureCount = Math.min(this.recoveryFailureCount + 1, 7);
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[openbot] async task lease recovery deferred (${scope}): ${detail}`);
  }

  private runRecovery(excludedTaskIds = this.activeClaimTaskIds(), reschedule = false): boolean {
    let healthy = true;
    try {
      healthy = this.recoverExpiredWork(excludedTaskIds);
    } catch (error) {
      healthy = false;
      this.reportRecoveryFailure("scan", error);
    }
    if (reschedule) {
      this.scheduleNextRecovery(this.nowFn(), !healthy);
    } else if (!healthy) {
      // An immediate post-claim pass must not move a failed scan behind an
      // already distant timer; keep the bounded retry/backoff observable.
      this.scheduleNextRecovery(this.nowFn(), true);
    } else {
      this.recoveryFailureCount = 0;
    }
    return healthy;
  }

  private recoverExpiredWork(excludedTaskIds = this.activeClaimTaskIds()): boolean {
    const now = this.nowFn();
    let healthy = true;
    for (const agentId of this.agentIds()) {
      let recoveredTasks: readonly AsyncTaskRecord[];
      try {
        recoveredTasks = this.store.recoverExpiredLeases(now, agentId, excludedTaskIds, true);
      } catch (error) {
        healthy = false;
        this.reportRecoveryFailure(`agent ${agentId}`, error);
        continue;
      }
      for (const recovered of recoveredTasks) {
        if (recovered.agentId !== agentId || recovered.status !== "abandoned") continue;
        try {
          const attempt = this.store.listAttempts(recovered.taskId).find((entry) => entry.attempt === recovered.attempt);
          const recoveredAtMs = attempt?.finishedAtMs;
          if (recoveredAtMs === null || recoveredAtMs === undefined) {
            throw new Error("Recovered task attempt has no authoritative finish timestamp.");
          }
          // Keep policy metadata anchored to the persisted recovery timestamp;
          // the store owns the authoritative operation time for the retry.
          const transitionAtMs = recoveredAtMs;
          this.store.liquidateAbandonedBudget(recovered.taskId, recoveredAtMs);
          if (attempt?.unsafeEffectStarted) {
            this.store.transition({
              taskId: recovered.taskId, expectedVersion: recovered.version,
              to: "failed", atMs: transitionAtMs,
              error: {
                code: "internal_error",
                message: "Task effect outcome is uncertain after lease recovery; automatic retry is blocked.",
                retryable: false,
              },
            });
            continue;
          }
          if (recovered.attempt >= this.maxAttempts) {
            const grant = this.store.getGrant(recovered.taskId);
            const revoked = grant?.revokedAt !== undefined && grant.revokedAt <= recoveredAtMs;
            this.store.transition({
              taskId: recovered.taskId, expectedVersion: recovered.version,
              to: revoked ? "cancelled" : "failed", atMs: transitionAtMs,
              error: revoked
                ? { code: "capability_denied", message: "Recovered task capability grant was revoked after retry exhaustion.", retryable: false }
                : { code: "internal_error", message: "Task lease recovery exhausted the retry limit.", retryable: false },
            });
            continue;
          }
          try {
            this.store.transition({
              taskId: recovered.taskId, expectedVersion: recovered.version, to: "retry_wait", atMs: transitionAtMs,
              retryAtOperationNow: true, error: { code: "internal_error", message: "Worker lease recovered after process restart.", retryable: true },
            });
          } catch (error) {
            if (error instanceof AsyncTaskContractError && error.code === "capability_denied") {
              // Only a proved capability denial may take the cancellation
              // fallback; CAS/DB and budget failures remain recoverable.
              this.store.transition({
                taskId: recovered.taskId, expectedVersion: recovered.version, to: "cancelled", atMs: transitionAtMs,
                error: { code: "capability_denied", message: "Recovered task capability grant was revoked before retry.", retryable: false },
              });
            } else if (error instanceof AsyncTaskContractError && error.code === "budget_exhausted") {
              this.store.transition({
                taskId: recovered.taskId, expectedVersion: recovered.version, to: "failed", atMs: transitionAtMs,
                error: { code: "budget_exhausted", message: error.message, retryable: false },
              });
            } else {
              throw error;
            }
          }
        } catch (error) {
          healthy = false;
          this.reportRecoveryFailure(`task ${recovered.taskId}`, error);
        }
      }
    }
    return healthy;
  }

  private maybeRecoverExpiredWork(): void {
    const now = this.nowFn();
    if (now < this.recoveryNextAtMs) return;
    this.runRecovery(this.activeClaimTaskIds(), true);
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

  /** Suspend only this agent's admissions. Nested maintenance owns its own fence. */
  fenceAgent(agentId: string): () => void {
    if (typeof agentId !== "string" || agentId.trim().length === 0) throw new Error("Agent id is required.");
    this.agentFences.set(agentId, (this.agentFences.get(agentId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.agentFences.get(agentId) ?? 1) - 1;
      if (remaining > 0) this.agentFences.set(agentId, remaining);
      else this.agentFences.delete(agentId);
      this.wake();
    };
  }

  /** Never report a completed drain while an executor can still touch its home. */
  async drainAgent(agentId: string, deadlineMs = 5_000): Promise<void> {
    if (!this.agentFences.has(agentId)) throw new Error("Agent must be fenced before draining tasks.");
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new Error("Task drain deadline must be positive.");
    const execution = this.agentControllers.get(agentId);
    if (execution !== undefined) {
      try {
        const task = this.store.getTask(execution.taskId);
        if (task?.status === "running" || task?.status === "admitted") {
          this.store.abort({
            taskId: task.taskId, agentId, parentTurnId: task.parentTurnId,
            intentId: `maintenance-${task.taskId}-${task.attempt}`,
            expectedAbortVersion: task.abortVersion, requestedAtMs: this.nowFn(), reason: "parent",
          });
        }
      } finally {
        execution.controller.abort(new Error("Agent workspace maintenance."));
      }
    }
    const active = this.activeClaims.get(agentId);
    if (active === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        active,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Agent tasks did not drain before the maintenance deadline.")), deadlineMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
      this.maybeRecoverExpiredWork();
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
      if (this.agentFences.has(agentId) || this.activeClaims.has(agentId)) continue;
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
          if (!this.stopped) this.runRecovery(this.activeClaimTaskIds());
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
    this.agentControllers.set(task.agentId, { taskId: task.taskId, controller });
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let current = task;
    let budgetVersion = 1;
    let unsafeEffectStarted = false;
    let unsafeEffectFenceFailed = false;
    let unsafeEffectFenceError: unknown;
    const stopHeartbeat = (): void => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };
    controller.signal.addEventListener("abort", stopHeartbeat, { once: true });
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
        if (this.stopped || controller.signal.aborted) {
          stopHeartbeat();
          return;
        }
        try {
          let lastError: unknown;
          for (let renewalAttempt = 0; renewalAttempt < 2; renewalAttempt += 1) {
            const observed = this.store.getTask(task.taskId);
            if (observed === null) throw new Error("Task disappeared during heartbeat.");
            current = observed;
            if (observed.abortIntent?.consumedAtMs === null) {
              current = this.store.consumeAbortIntent(task.taskId, leaseOwnerId, attempt, this.nowFn());
              stopHeartbeat();
              controller.abort(new Error("task abort intent"));
              return;
            }
            const nowMs = this.nowFn();
            const lease = observed.lease;
            if ((observed.status !== "admitted" && observed.status !== "running" && observed.status !== "cancelling")
              || lease === null || lease.ownerId !== leaseOwnerId || lease.attempt !== attempt || lease.expiresAtMs <= nowMs) {
              throw new Error("Task lease is no longer live.");
            }
            try {
              current = this.store.heartbeat({ taskId: task.taskId, expectedVersion: observed.version, leaseOwnerId, attempt, nowMs, leaseDurationMs: this.leaseDurationMs });
              return;
            } catch (error) {
              lastError = error;
            }
          }
          if (lastError !== undefined) throw lastError;
        } catch {
          stopHeartbeat();
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
        if (unsafeEffectFenceFailed) {
          throw unsafeEffectFenceError ?? new Error("Unsafe effect marker persistence failed.");
        }
        context.authorize(operation);
        if (controller.signal.aborted) throw new Error("Task was aborted before effect admission.");
        const reservationId = `effect-${task.taskId}-${attempt}-${randomUUID()}`;
        const reserved = reserveEffect(options.reserve ?? defaultReservation(operation), reservationId);
        if (!options.retrySafe) {
          // Fail closed if the durable fence itself cannot be persisted: the
          // external call must never run without the in-memory guard set.
          unsafeEffectStarted = true;
        }
        try {
          if (!options.retrySafe) {
            try {
              current = this.store.markUnsafeEffectStarted({
                taskId: task.taskId,
                expectedVersion: current.version,
                leaseOwnerId,
                attempt,
                markedAtMs: this.nowFn(),
              });
            } catch (error) {
              unsafeEffectFenceFailed = true;
              unsafeEffectFenceError = error;
              throw error;
            }
          }
          const result = await call();
          reconcileEffect(reservationId, reserved.amounts, options.usage?.(result) ?? reserved.amounts);
          return result;
        } catch (error) {
          // A failed read consumed only its attempt counters; size dimensions
          // may never have been spent. A failed mutation may have partially
          // applied, so its reservation is conservatively kept.
          const { inputTokens: _input, outputTokens: _output, workspaceWriteBytes: _bytes, ...attemptOnly } = reserved.amounts;
          const actual = options.retrySafe ? attemptOnly : reserved.amounts;
          try { reconcileEffect(reservationId, reserved.amounts, actual); } catch { /* lease recovery conservatively owns the reservation */ }
          throw error;
        }
      };
      const runEffect = async <T>(operation: DelegatedCapabilityOperation, call: () => Promise<T>, options: { readonly reserve?: Partial<BudgetCounters>; readonly usage?: (result: T) => Partial<BudgetCounters>; readonly retrySafe?: boolean } = {}): Promise<T> => {
        if (operation.kind === "provider") {
          throw new AsyncTaskContractError("invalid_contract", "Provider effects must use runProvider admission.");
        }
        const minimum = { ...defaultReservation(operation) };
        const requested = options.reserve ?? {};
        // A measured write reservation supersedes the unknown-size floor;
        // usage reconciliation still charges the real bytes afterwards.
        if (requested.workspaceWriteBytes !== undefined) delete minimum.workspaceWriteBytes;
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
      // An executor may catch an injected runEffect rejection. A failed
      // durable fence must still prevent a false successful terminal commit;
      // no external effect was dispatched and the task remains explicitly
      // failed below.
      if (unsafeEffectFenceFailed) throw unsafeEffectFenceError ?? new Error("Unsafe effect marker persistence failed.");
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
        retryable: !unsafeEffectFenceFailed
          && !(error instanceof AsyncTaskContractError && (error.code === "budget_exhausted" || error.code === "capability_denied")),
      };
      const latest = this.store.getTask(task.taskId);
      if (latest === null || latest.status === "cancelled" || latest.status === "completed" || latest.status === "failed") return;
      current = latest;
      if (current.status !== "running" && current.status !== "cancelling") return;
      if (failure.retryable && !controller.signal.aborted && !unsafeEffectStarted && attempt < this.maxAttempts && current.status === "running") {
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
      stopHeartbeat();
      this.controllers.delete(task.taskId);
      if (this.agentControllers.get(task.agentId)?.controller === controller) this.agentControllers.delete(task.agentId);
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
