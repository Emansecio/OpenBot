import { randomUUID } from "node:crypto";

import { capabilityDigest, parseRuntimeCapability } from "./policy.js";
import { RuntimeAdmissionError, RuntimeScheduler } from "./scheduler.js";
import {
  reconcileRuntimeLeases,
  type RuntimeActiveLeaseRecord,
  type RuntimeLeaseJournal,
  type RuntimeLeaseRecord,
  type RuntimeRecoveryResult,
  type RuntimeResourceReconciler,
} from "./recovery.js";
import type {
  AgentRuntimeManager,
  RuntimeBoot,
  RuntimeCapability,
  RuntimeDriver,
  RuntimeDriverLease,
  RuntimeErrorCode,
  RuntimeHealth,
  RuntimeLease,
  RuntimeLeaseRequest,
  RuntimeMode,
  RuntimeState,
  RuntimeStatus,
  SanitizedRuntimeError,
  StopReason,
} from "./contracts.js";

export type { RuntimeDriver, RuntimeLeaseRequest } from "./contracts.js";

export interface RuntimeManagerOptions {
  driver: RuntimeDriver;
  now?: () => number;
  leaseTtlMs?: number;
  maxActiveLeases?: number;
  maxActiveLeasesPerAgent?: number;
  maxQueuedLeases?: number;
  admissionTimeoutMs?: number;
  leaseSweepIntervalMs?: number;
  /** Keep the managed runtime warm after the final lease is released. */
  idleStopMs?: number | null;
  journal?: RuntimeLeaseJournal;
  /**
   * Optional, explicitly injected cleanup seam. Implementations must accept
   * lease identities only and must never derive or touch agent workspaces.
   */
  reconciler?: RuntimeResourceReconciler;
}

export class RuntimeManagerError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeManagerError";
  }
}

interface AgentRecord {
  mode: RuntimeMode;
  fenced: boolean;
  lastActivityAt: number | null;
}

interface LeaseEntry {
  agentId: string;
  expiresAt: number;
  driverLease: RuntimeDriverLease;
  driverReleased: boolean;
  publicLease: RuntimeLease;
  journalRecord: RuntimeActiveLeaseRecord;
}

const GENERIC_RUNTIME_ERROR = "Runtime operation failed.";

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("This operation was aborted", "AbortError");

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortReason(signal);
};

const raceWithAbort = <T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (signal === undefined) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === "AbortError" || (error as Error & { code?: unknown }).code === "ABORT_ERR");

const errorFromHealth = (health: Extract<RuntimeHealth, { ok: false }>): RuntimeManagerError =>
  new RuntimeManagerError(health.code, health.message);

const sanitizeError = (error: unknown, fallback: RuntimeErrorCode): SanitizedRuntimeError => {
  if (error instanceof RuntimeManagerError) return { code: error.code, message: error.message };
  return { code: fallback, message: GENERIC_RUNTIME_ERROR };
};

export class RuntimeManager implements AgentRuntimeManager {
  private readonly driver: RuntimeDriver;
  private readonly now: () => number;
  private readonly leaseTtlMs: number;
  private readonly scheduler: RuntimeScheduler;
  private readonly idleStopMs: number | null;
  private readonly leaseSweepTimer: ReturnType<typeof setInterval>;
  private readonly journal?: RuntimeLeaseJournal;
  private readonly reconciler?: RuntimeResourceReconciler;
  private readonly agents = new Map<string, AgentRecord>();
  private readonly deletedAgents = new Set<string>();
  private readonly agentRepairRequired = new Set<string>();
  private readonly maintenanceFences = new Map<string, number>();
  private readonly leases = new Map<string, LeaseEntry>();
  private runtimeState: RuntimeState = "stopped";
  private boot: RuntimeBoot | null = null;
  private lastError: SanitizedRuntimeError | null = null;
  private startup: Promise<RuntimeStatus> | undefined;
  private startupGeneration = 0;
  private startupController: AbortController | undefined;
  private startupStopReason: StopReason | undefined;
  private runtimeGeneration = 0;
  private pendingAcquireCount = 0;
  private pendingAcquireWaiters: Array<() => void> = [];
  private recovery: Promise<RuntimeRecoveryResult> | undefined;
  private lastRecovery: { bootId: string; result: RuntimeRecoveryResult } | undefined;
  private idleStopTimer: ReturnType<typeof setTimeout> | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopRequestPromise: Promise<void> | undefined;
  private stopRequested = false;
  private closed = false;
  private shutdownStarted = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: RuntimeManagerOptions) {
    this.driver = options.driver;
    this.now = options.now ?? (() => Date.now());
    this.leaseTtlMs = options.leaseTtlMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs <= 0) {
      throw new Error("leaseTtlMs must be a positive integer");
    }
    this.scheduler = new RuntimeScheduler({
      maxActiveLeases: options.maxActiveLeases,
      maxActiveLeasesPerOwner: options.maxActiveLeasesPerAgent,
      maxQueuedLeases: options.maxQueuedLeases,
      admissionTimeoutMs: options.admissionTimeoutMs,
    });
    this.idleStopMs = options.idleStopMs === undefined ? 5 * 60_000 : options.idleStopMs;
    if (this.idleStopMs !== null && (!Number.isSafeInteger(this.idleStopMs) || this.idleStopMs < 0)) {
      throw new Error("idleStopMs must be null or a non-negative integer");
    }
    this.journal = options.journal;
    this.reconciler = options.reconciler;
    const leaseSweepIntervalMs = options.leaseSweepIntervalMs ?? 30_000;
    if (!Number.isSafeInteger(leaseSweepIntervalMs) || leaseSweepIntervalMs < 1) {
      throw new Error("leaseSweepIntervalMs must be a positive integer");
    }
    this.leaseSweepTimer = setInterval(() => {
      void this.expireLeases().catch(() => undefined);
    }, leaseSweepIntervalMs);
    this.leaseSweepTimer.unref?.();
  }

  /**
   * Reconcile the durable lease journal before the gateway starts accepting
   * work. This method is intentionally independent of agent homes: recovery
   * receives only opaque runtime identities and an injected cleanup seam.
   *
   * When no cleanup seam is available, a non-empty/corrupt journal is not
   * treated as healthy. The caller receives `complete: false`, and the
   * manager exposes `repair-required` rather than guessing at filesystem
   * paths or silently dropping evidence.
   */
  async recover(
    bootId = this.boot?.runtimeBootId ?? `host-${randomUUID()}`,
    activeBoot?: RuntimeBoot,
  ): Promise<RuntimeRecoveryResult> {
    if (!this.journal) return { inspected: 0, cleaned: 0, failed: 0, complete: true };
    if (this.lastRecovery?.bootId === bootId) return { ...this.lastRecovery.result };
    if (this.recovery) return this.recovery;

    this.recovery = (async () => {
      let result: RuntimeRecoveryResult;
      if (this.reconciler) {
        result = await reconcileRuntimeLeases(this.journal!, bootId, this.reconciler, activeBoot);
      } else {
        let records: RuntimeLeaseRecord[];
        try {
          records = await this.journal!.list();
        } catch {
          result = { inspected: 0, cleaned: 0, failed: 1, complete: false };
          this.runtimeState = "repair-required";
          this.lastError = { code: "runtime_unhealthy", message: "Runtime recovery requires repair." };
          return result;
        }
        const diagnostics = this.journal as RuntimeLeaseJournal & {
          getLastReport?: () => { issues: unknown[]; quarantined: number };
        };
        const report = typeof diagnostics.getLastReport === "function"
          ? diagnostics.getLastReport()
          : { issues: [], quarantined: 0 };
        const failed = records.length > 0 || report.issues.length > 0;
        result = {
          inspected: records.length + report.issues.length,
          cleaned: 0,
          failed: failed ? Math.max(1, records.length + report.issues.length) : 0,
          complete: !failed,
          ...(report.quarantined > 0 ? { quarantined: report.quarantined } : {}),
        };
      }
      this.lastRecovery = { bootId, result: { ...result } };
      if (!result.complete) {
        this.runtimeState = "repair-required";
        this.lastError = { code: "runtime_unhealthy", message: "Runtime recovery requires repair." };
      }
      return { ...result };
    })().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }

  async ensure(agentId: string, mode: RuntimeMode, signal?: AbortSignal): Promise<RuntimeStatus> {
    this.assertAgentId(agentId);
    throwIfAborted(signal);
    if (this.deletedAgents.has(agentId)) throw new RuntimeManagerError("agent_fenced", "Agent runtime is fenced.");
    if (mode === "lite" || mode === "browser") {
      const record = this.recordFor(agentId);
      record.mode = mode;
      return this.statusFor(agentId);
    }
    const record = this.recordFor(agentId);
    record.mode = mode;
    if (mode !== "developer") {
      return this.statusFor(agentId, {
        code: "unsupported_capability",
        message: "This runtime mode is not implemented yet.",
      });
    }
    if (this.runtimeState === "repair-required" || this.agentRepairRequired.has(agentId)) {
      return this.statusFor(agentId);
    }
    if (this.shutdownStarted) return this.statusFor(agentId, { code: "runtime_closed", message: "Runtime is closed." });
    if (this.stopRequested) return this.statusFor(agentId);
    if (this.runtimeState === "ready" || this.runtimeState === "busy") {
      this.clearIdleStopTimer();
      throwIfAborted(signal);
      return this.statusFor(agentId);
    }
    if (this.stopPromise) {
      await raceWithAbort(this.stopPromise, signal);
      throwIfAborted(signal);
      if (this.shutdownStarted) return this.statusFor(agentId, { code: "runtime_closed", message: "Runtime is closed." });
    }
    if (this.startup) {
      const joinedStartup = this.startup;
      const observedGeneration = this.startupGeneration;
      const status = await raceWithAbort(joinedStartup, signal);
      if (this.shutdownStarted || this.runtimeState !== "stopped") return status;
      if (this.startup) return raceWithAbort(this.startup, signal);
      if (this.startupGeneration !== observedGeneration) return status;
    }

    return raceWithAbort(this.beginStartup(), signal);
  }

  async acquire(agentId: string, capability: RuntimeCapability, signal?: AbortSignal): Promise<RuntimeLease> {
    this.assertAgentId(agentId);
    throwIfAborted(signal);
    if (this.shutdownStarted) throw new RuntimeManagerError("runtime_closed", "Runtime is closed.");
    if (this.deletedAgents.has(agentId)) throw new RuntimeManagerError("agent_fenced", "Agent runtime is fenced.");
    const normalizedCapability = this.normalizeCapability(capability);
    const record = this.recordFor(agentId);
    if (record.fenced || this.maintenanceFences.has(agentId)) throw new RuntimeManagerError("agent_fenced", "Agent runtime is fenced.");

    const status = await this.ensure(agentId, "developer", signal);
    throwIfAborted(signal);
    if (status.state !== "ready" && status.state !== "busy") {
      const failure = status.lastError;
      throw new RuntimeManagerError(
        failure?.code ?? "runtime_unavailable",
        failure?.message ?? "Runtime is unavailable.",
      );
    }

    await this.expireLeases();
    throwIfAborted(signal);
    const leaseId = randomUUID();
    this.beginPendingAcquire();
    try {
      try {
        await this.scheduler.reserveOrWaitFor(leaseId, agentId, signal);
      } catch (error) {
        if (error instanceof RuntimeAdmissionError) {
          throw new RuntimeManagerError("runtime_capacity_exceeded", error.message);
        }
        throw error;
      }

      this.clearIdleStopTimer();
      try {
        throwIfAborted(signal);
        if (this.shutdownStarted) throw new RuntimeManagerError("runtime_closed", "Runtime is closed.");
        if (this.deletedAgents.has(agentId) || record.fenced || this.maintenanceFences.has(agentId)) {
          throw new RuntimeManagerError("agent_fenced", "Agent runtime is fenced.");
        }
        if (this.stopRequested || this.runtimeState !== "ready" && this.runtimeState !== "busy") {
          throw new RuntimeManagerError("runtime_unavailable", "Runtime is stopping.");
        }
      } catch (error) {
        this.releaseReservation(leaseId);
        throw error;
      }
      const boot = this.boot;
      const acquireGeneration = this.runtimeGeneration;
      if (!boot) {
        this.releaseReservation(leaseId);
        throw new RuntimeManagerError("runtime_unavailable", "Runtime boot is unavailable.");
      }

      const expiresAt = this.now() + this.leaseTtlMs;
      const request: RuntimeLeaseRequest = {
        leaseId,
        agentId,
        runtimeBootId: boot.runtimeBootId,
        capability: normalizedCapability,
        policyDigest: capabilityDigest(normalizedCapability),
        expiresAt,
      };

      const pendingRecord: RuntimeLeaseRecord = {
        ...(this.driver.recoveryKind ? { recoveryKind: this.driver.recoveryKind } : {}),
        leaseId,
        agentId,
        runtimeBootId: boot.runtimeBootId,
        temporaryId: `tmp-${leaseId}`,
        pending: true,
      };
      try {
        await this.journal?.put(pendingRecord);
      } catch (error) {
        this.releaseReservation(leaseId);
        this.runtimeState = "unhealthy";
        this.lastError = sanitizeError(error, "runtime_unhealthy");
        throw new RuntimeManagerError("runtime_unhealthy", "Runtime lease journal is unavailable.");
      }

      let driverLease: RuntimeDriverLease;
      try {
        driverLease = await this.driver.acquire(request, signal);
      } catch (error) {
        let compensationError: unknown;
        let compensated = false;
        if (this.driver.compensateAcquire) {
          try {
            await this.driver.compensateAcquire(request);
            compensated = true;
          } catch (cleanupError) {
            compensationError = cleanupError;
          }
        }
        if (compensated) {
          try {
            await this.journal?.delete(leaseId);
          } catch (cleanupError) {
            compensationError = cleanupError;
          }
        }
        this.releaseReservation(leaseId);
        if (compensationError !== undefined || !compensated) {
          this.runtimeState = "unhealthy";
          this.lastError = sanitizeError(compensationError ?? error, "runtime_unhealthy");
        }
        if (compensationError !== undefined) {
          throw new RuntimeManagerError("runtime_unhealthy", "Runtime lease compensation failed.");
        }
        if (isAbortError(error)) throw error;
        throw error instanceof RuntimeManagerError
          ? error
          : new RuntimeManagerError("runtime_protocol_error", GENERIC_RUNTIME_ERROR);
      }

      const journalRecord: RuntimeActiveLeaseRecord = {
        ...(this.driver.recoveryKind ? { recoveryKind: this.driver.recoveryKind } : {}),
        leaseId,
        agentId,
        runtimeBootId: boot.runtimeBootId,
        sandboxId: driverLease.sandboxId,
        temporaryId: pendingRecord.temporaryId,
      };

      if (signal?.aborted || !this.isAcquireCurrent(agentId, record, boot, acquireGeneration)) {
        try {
          await this.cleanupRejectedAcquire(request, driverLease, journalRecord);
        } finally {
          this.releaseReservation(leaseId);
        }
        throwIfAborted(signal);
        throw new RuntimeManagerError("runtime_unavailable", "Runtime boot is no longer active.");
      }

      try {
        await this.journal?.put(journalRecord);
      } catch {
        try {
          await this.cleanupRejectedAcquire(request, driverLease, journalRecord);
        } finally {
          this.releaseReservation(leaseId);
        }
        throw new RuntimeManagerError("runtime_unhealthy", "Runtime lease journal is unavailable.");
      }

      if (signal?.aborted || !this.isAcquireCurrent(agentId, record, boot, acquireGeneration)) {
        try {
          await this.cleanupRejectedAcquire(request, driverLease, journalRecord);
        } finally {
          this.releaseReservation(leaseId);
        }
        throwIfAborted(signal);
        throw new RuntimeManagerError("runtime_unavailable", "Runtime boot is no longer active.");
      }

      let released = false;
      let releasePromise: Promise<void> | undefined;
      const publicLease: RuntimeLease = {
      leaseId,
      agentId,
      runtimeBootId: boot.runtimeBootId,
      sandboxId: driverLease.sandboxId,
      capability: normalizedCapability,
      expiresAt,
      get released() {
        return released;
      },
      release: async () => {
        if (released) return;
        if (!releasePromise) {
          releasePromise = this.releaseLease(leaseId)
            .then(() => {
              released = true;
            })
            .finally(() => {
              releasePromise = undefined;
            });
        }
        await releasePromise;
      },
    };
      this.leases.set(leaseId, {
        agentId,
        expiresAt,
        driverLease: { ...driverLease, leaseId },
        driverReleased: false,
        publicLease,
        journalRecord,
      });
      record.lastActivityAt = this.now();
      this.runtimeState = "busy";
      return publicLease;
    } finally {
      this.endPendingAcquire();
    }
  }

  metrics(): import("./scheduler.js").RuntimeAdmissionMetrics {
    return this.scheduler.metrics();
  }

  async status(agentId: string, requestedMode?: RuntimeMode): Promise<RuntimeStatus> {
    this.assertAgentId(agentId);
    await this.expireLeases();
    return this.statusFor(agentId, undefined, requestedMode);
  }

  markAgentRepairRequired(agentId: string): void {
    this.assertAgentId(agentId);
    this.agentRepairRequired.add(agentId);
  }

  clearAgentRepairRequired(agentId: string): void {
    this.assertAgentId(agentId);
    this.agentRepairRequired.delete(agentId);
  }

  async stop(agentId: string, reason: StopReason): Promise<RuntimeStatus> {
    this.assertAgentId(agentId);
    const record = this.recordFor(agentId);
    if (reason === "agent-delete") record.fenced = true;
    const canceledStartup = this.cancelStartup(reason);

    const entries = [...this.leases.values()].filter((entry) => entry.agentId === agentId);
    let releaseError: unknown;
    for (const entry of entries) {
      try {
        await entry.publicLease.release();
      } catch (error) {
        releaseError ??= error;
      }
    }

    if (canceledStartup) {
      try {
        await canceledStartup;
      } catch (error) {
        releaseError ??= error;
      }
    }

    if (this.leases.size === 0 && this.boot && !this.shutdownStarted) {
      this.clearIdleStopTimer();
      try {
        await this.requestStop(reason);
      } catch (error) {
        releaseError ??= error;
      }
    }
    if (releaseError) throw releaseError;
    const finalStatus = this.statusFor(agentId);
    if (reason === "agent-delete") {
      this.deletedAgents.add(agentId);
      this.agents.delete(agentId);
    }
    return finalStatus;
  }

  async repair(agentId: string): Promise<RuntimeStatus> {
    this.assertAgentId(agentId);
    if (this.deletedAgents.has(agentId)) throw new RuntimeManagerError("agent_fenced", "Agent runtime is fenced.");
    const record = this.recordFor(agentId);
    if (record.fenced) throw new RuntimeManagerError("agent_fenced", "Agent runtime is fenced.");
    this.lastRecovery = undefined;
    if (this.agentRepairRequired.has(agentId)) return this.status(agentId, "developer");
    if (this.runtimeState === "unhealthy" || this.runtimeState === "repair-required") {
      this.runtimeState = "stopped";
      this.lastError = null;
      this.boot = null;
    }
    await this.ensure(agentId, "developer");
    return this.status(agentId, "developer");
  }

  fenceAgentMaintenance(agentId: string): () => void {
    this.assertAgentId(agentId);
    this.maintenanceFences.set(agentId, (this.maintenanceFences.get(agentId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.maintenanceFences.get(agentId) ?? 1) - 1;
      if (remaining > 0) this.maintenanceFences.set(agentId, remaining);
      else this.maintenanceFences.delete(agentId);
    };
  }

  fenceAgent(agentId: string): void {
    this.assertAgentId(agentId);
    this.recordFor(agentId).fenced = true;
  }

  releaseAgentFence(agentId: string): void {
    this.assertAgentId(agentId);
    this.deletedAgents.delete(agentId);
    this.recordFor(agentId).fenced = false;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise) return this.closePromise;
    let canceledStartup: Promise<RuntimeStatus> | undefined;
    if (!this.shutdownStarted) {
      this.shutdownStarted = true;
      clearInterval(this.leaseSweepTimer);
      this.clearIdleStopTimer();
      this.scheduler.close(new RuntimeManagerError("runtime_closed", "Runtime is closed."));
      canceledStartup = this.cancelStartup("shutdown");
    }
    const closeAttempt = (async () => {
      await canceledStartup?.catch(() => undefined);
      await this.startup?.catch(() => undefined);
      await this.recovery?.catch(() => undefined);
      await this.waitForPendingAcquires();
      for (const record of this.agents.values()) record.fenced = true;
      const entries = [...this.leases.values()];
      let releaseError: unknown;
      for (const entry of entries) {
        try {
          await entry.publicLease.release();
        } catch (error) {
          releaseError ??= error;
        }
      }
      if (releaseError !== undefined) throw releaseError;
      if (this.boot) await this.stopRuntime("shutdown");
      else this.runtimeState = "stopped";
      this.closed = true;
    })();
    this.closePromise = closeAttempt;
    try {
      await closeAttempt;
    } finally {
      if (this.closePromise === closeAttempt) this.closePromise = undefined;
    }
  }

  private async startRuntime(signal: AbortSignal, generation: number): Promise<RuntimeStatus> {
    let startedBoot: RuntimeBoot | null = null;
    try {
      this.clearIdleStopTimer();
      const boot = await this.driver.start(signal);
      startedBoot = boot;
      if (!this.isCurrentStartup(generation)) return this.finishCanceledStartup(startedBoot);
      const health = await raceWithAbort(this.driver.health(boot, signal), signal);
      if (!this.isCurrentStartup(generation)) return this.finishCanceledStartup(startedBoot);
      if (!health.ok) throw errorFromHealth(health);
      const recovery = await this.recover(boot.runtimeBootId, boot);
      if (!this.isCurrentStartup(generation)) return this.finishCanceledStartup(startedBoot);
      if (!recovery.complete) {
        throw new RuntimeManagerError("runtime_unhealthy", "Runtime recovery requires repair.");
      }
      this.runtimeGeneration += 1;
      this.boot = boot;
      this.runtimeState = "ready";
      this.lastError = null;
      return this.statusFor(this.firstAgentId());
    } catch (error) {
      if (!this.isCurrentStartup(generation)) return this.finishCanceledStartup(startedBoot);
      if (startedBoot) await this.driver.stop("health-failure").catch(() => undefined);
      this.boot = null;
      const repairRequired = error instanceof RuntimeManagerError && error.message === "Runtime recovery requires repair.";
      this.runtimeState = repairRequired
        ? "repair-required"
        : error instanceof RuntimeManagerError && error.code === "runtime_unavailable"
          ? "runtime-unavailable"
          : "unhealthy";
      this.lastError = sanitizeError(error, this.runtimeState === "runtime-unavailable" ? "runtime_unavailable" : "runtime_unhealthy");
      return this.statusFor(this.firstAgentId());
    }
  }

  private beginStartup(): Promise<RuntimeStatus> {
    this.runtimeState = "starting";
    this.lastError = null;
    this.clearIdleStopTimer();
    const generation = ++this.startupGeneration;
    const controller = new AbortController();
    this.startupController = controller;
    let startup: Promise<RuntimeStatus>;
    startup = this.startRuntime(controller.signal, generation).finally(() => {
      if (this.startup !== startup) return;
      this.startup = undefined;
      if (this.startupGeneration === generation) {
        this.startupController = undefined;
        this.startupStopReason = undefined;
      }
    });
    this.startup = startup;
    return startup;
  }

  private isCurrentStartup(generation: number): boolean {
    return !this.shutdownStarted && this.startupGeneration === generation;
  }

  private async finishCanceledStartup(startedBoot: RuntimeBoot | null): Promise<RuntimeStatus> {
    const reason = this.startupStopReason ?? (this.shutdownStarted ? "shutdown" : "manual");
    if (startedBoot) {
      try {
        await this.driver.stop(reason);
      } catch (error) {
        this.boot = null;
        this.runtimeState = "unhealthy";
        this.lastError = sanitizeError(error, "runtime_unhealthy");
        return this.statusFor(this.firstAgentId());
      }
    }
    this.boot = null;
    this.runtimeState = "stopped";
    this.lastError = null;
    return this.statusFor(this.firstAgentId());
  }

  private isAcquireCurrent(
    agentId: string,
    record: AgentRecord,
    boot: RuntimeBoot,
    generation: number,
  ): boolean {
    return !this.shutdownStarted && !this.stopRequested &&
      (this.runtimeState === "ready" || this.runtimeState === "busy") &&
      this.runtimeGeneration === generation &&
      this.boot?.runtimeBootId === boot.runtimeBootId &&
      !this.deletedAgents.has(agentId) && !record.fenced && !this.maintenanceFences.has(agentId);
  }

  private async cleanupRejectedAcquire(
    request: RuntimeLeaseRequest,
    driverLease: RuntimeDriverLease,
    journalRecord?: RuntimeLeaseRecord,
  ): Promise<void> {
    let cleanupError: unknown;
    try {
      await this.driver.release({ ...driverLease, leaseId: request.leaseId });
    } catch (releaseError) {
      cleanupError = releaseError;
      if (this.driver.compensateAcquire) {
        try {
          await this.driver.compensateAcquire(request);
          cleanupError = undefined;
        } catch (compensationError) {
          cleanupError = compensationError;
        }
      }
    }
    if (cleanupError !== undefined) {
      if (journalRecord) await this.journal?.put(journalRecord).catch(() => undefined);
      this.runtimeState = "unhealthy";
      this.lastError = sanitizeError(cleanupError, "runtime_unhealthy");
      throw new RuntimeManagerError("runtime_unhealthy", "Runtime lease cleanup failed.");
    }
    if (journalRecord) {
      try {
        await this.journal?.delete(journalRecord.leaseId);
      } catch (error) {
        this.runtimeState = "unhealthy";
        this.lastError = sanitizeError(error, "runtime_unhealthy");
        throw new RuntimeManagerError("runtime_unhealthy", "Runtime lease journal cleanup failed.");
      }
    }
  }

  private beginPendingAcquire(): void {
    this.pendingAcquireCount += 1;
  }

  private endPendingAcquire(): void {
    this.pendingAcquireCount -= 1;
    if (this.pendingAcquireCount !== 0) return;
    const waiters = this.pendingAcquireWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private waitForPendingAcquires(): Promise<void> {
    if (this.pendingAcquireCount === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pendingAcquireWaiters.push(resolve);
    });
  }

  private async expireLeases(): Promise<void> {
    const now = this.now();
    for (const entry of this.leases.values()) {
      if (entry.expiresAt > now) continue;
      try {
        await entry.publicLease.release();
      } catch {
        this.runtimeState = "unhealthy";
        this.lastError = { code: "runtime_unhealthy", message: "Runtime lease cleanup failed." };
      }
    }
  }

  private async releaseLease(leaseId: string): Promise<void> {
    const entry = this.leases.get(leaseId);
    if (!entry) return;
    try {
      if (!entry.driverReleased) {
        await this.driver.release(entry.driverLease);
        entry.driverReleased = true;
      }
      await this.journal?.delete(entry.journalRecord.leaseId);
    } catch (error) {
      this.runtimeState = "unhealthy";
      this.lastError = sanitizeError(error, "runtime_unhealthy");
      throw new RuntimeManagerError("runtime_unhealthy", "Runtime lease cleanup failed.");
    }
    this.leases.delete(leaseId);
    this.scheduler.release(leaseId);
    const record = this.recordFor(entry.agentId);
    record.lastActivityAt = this.now();
    if (this.leases.size === 0 && this.runtimeState === "busy") {
      this.runtimeState = "ready";
      this.scheduleIdleStop();
    }
  }

  private scheduleIdleStop(): void {
    if (
      this.idleStopMs === null || this.idleStopTimer !== undefined || !this.boot || this.shutdownStarted ||
      this.leases.size > 0 || this.scheduler.activeCount > 0 || this.scheduler.waitingCount > 0
    ) return;
    this.idleStopTimer = setTimeout(() => {
      this.idleStopTimer = undefined;
      if (this.shutdownStarted || this.leases.size > 0 || !this.boot) return;
      void this.stopRuntime("idle").catch((error: unknown) => {
        this.runtimeState = "unhealthy";
        this.lastError = sanitizeError(error, "runtime_unhealthy");
      });
    }, this.idleStopMs);
    this.idleStopTimer.unref?.();
  }

  private releaseReservation(leaseId: string): void {
    this.scheduler.release(leaseId);
    if (this.leases.size === 0 && this.runtimeState === "ready") this.scheduleIdleStop();
  }

  private clearIdleStopTimer(): void {
    if (this.idleStopTimer === undefined) return;
    clearTimeout(this.idleStopTimer);
    this.idleStopTimer = undefined;
  }

  private async stopRuntime(reason: StopReason): Promise<void> {
    if (!this.boot) return;
    if (this.stopPromise) return this.stopPromise;
    this.clearIdleStopTimer();
    this.runtimeGeneration += 1;
    this.runtimeState = "stopping";
    const operation = (async () => {
      try {
        await this.driver.stop(reason);
        this.boot = null;
        this.runtimeState = "stopped";
        this.lastError = null;
      } catch (error) {
        this.runtimeState = "unhealthy";
        this.lastError = sanitizeError(error, "runtime_unhealthy");
        throw error instanceof RuntimeManagerError
          ? error
          : new RuntimeManagerError("runtime_unhealthy", "Runtime stop failed.");
      }
    })();
    this.stopPromise = operation;
    try {
      await operation;
    } finally {
      if (this.stopPromise === operation) this.stopPromise = undefined;
    }
  }

  private requestStop(reason: StopReason): Promise<void> {
    if (this.stopRequestPromise) return this.stopRequestPromise;
    this.stopRequested = true;
    this.runtimeGeneration += 1;
    this.runtimeState = "stopping";
    const operation = (async () => {
      await this.waitForPendingAcquires();
      await this.stopRuntime(reason);
    })();
    const request = operation.finally(() => {
      if (this.stopRequestPromise !== request) return;
      this.stopRequestPromise = undefined;
      this.stopRequested = false;
    });
    this.stopRequestPromise = request;
    return request;
  }

  private cancelStartup(reason: StopReason): Promise<RuntimeStatus> | undefined {
    const startup = this.startup;
    if (!startup) return undefined;
    if (this.runtimeState !== "starting") return startup;
    this.startupGeneration += 1;
    this.startupStopReason = reason;
    this.startupController?.abort();
    this.startupController = undefined;
    this.clearIdleStopTimer();
    this.boot = null;
    this.runtimeState = "stopped";
    this.lastError = null;
    return startup;
  }

  private normalizeCapability(capability: RuntimeCapability): RuntimeCapability {
    try {
      return parseRuntimeCapability(capability);
    } catch {
      throw new RuntimeManagerError("unsupported_capability", "Runtime capability is unsupported.");
    }
  }

  private recordFor(agentId: string): AgentRecord {
    const existing = this.agents.get(agentId);
    if (existing) return existing;
    const created: AgentRecord = { mode: "lite", fenced: false, lastActivityAt: null };
    this.agents.set(agentId, created);
    return created;
  }

  private statusFor(
    agentId: string,
    overrideError?: SanitizedRuntimeError,
    requestedMode?: RuntimeMode,
  ): RuntimeStatus {
    const record = this.recordFor(agentId);
    const mode = requestedMode ?? record.mode;
    const agentNeedsRepair = this.agentRepairRequired.has(agentId);
    const state = mode === "lite" || mode === "browser" ? "lite-ready" : agentNeedsRepair ? "repair-required" : this.runtimeState;
    const repairError = agentNeedsRepair
      ? { code: "runtime_unhealthy" as const, message: "Local runtime requires repair." }
      : undefined;
    let activeLeaseCount = 0;
    for (const entry of this.leases.values()) {
      if (entry.agentId === agentId) activeLeaseCount += 1;
    }
    return {
      agentId,
      mode,
      state,
      runtimeVersion: this.boot?.runtimeVersion ?? null,
      imageDigest: this.boot?.imageDigest ?? null,
      runtimeBootId: this.boot?.runtimeBootId ?? null,
      activeLeaseCount,
      activeProcessCount: activeLeaseCount,
      waitingLeaseCount: this.scheduler.waitingCount,
      lastActivityAt: record.lastActivityAt === null ? null : new Date(record.lastActivityAt).toISOString(),
      lastError: overrideError ?? repairError ?? this.lastError,
    };
  }

  private firstAgentId(): string {
    return this.agents.keys().next().value ?? "openbot-default";
  }

  private assertAgentId(agentId: string): void {
    if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > 128) {
      throw new RuntimeManagerError("agent_fenced", "Agent id is invalid.");
    }
  }
}
