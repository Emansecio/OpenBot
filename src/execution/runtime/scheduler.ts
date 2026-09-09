export interface RuntimeSchedulerOptions {
  maxActiveLeases?: number;
  maxActiveLeasesPerOwner?: number;
  maxQueuedLeases?: number;
  admissionTimeoutMs?: number;
}

export class RuntimeAdmissionError extends Error {
  readonly code = "runtime_capacity_exceeded" as const;

  constructor(message = "Runtime admission timed out.") {
    super(message);
    this.name = "RuntimeAdmissionError";
  }
}

interface PendingAdmission {
  leaseId: string;
  ownerId: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("This operation was aborted", "AbortError");

export class RuntimeScheduler {
  private readonly active = new Map<string, string>();
  private readonly pending: PendingAdmission[] = [];
  private readonly maxActiveLeases: number;
  private readonly maxActiveLeasesPerOwner: number;
  private readonly maxQueuedLeases: number;
  private readonly admissionTimeoutMs: number;

  constructor(options: RuntimeSchedulerOptions = {}) {
    this.maxActiveLeases = options.maxActiveLeases ?? 4;
    if (!Number.isSafeInteger(this.maxActiveLeases) || this.maxActiveLeases < 1) {
      throw new Error("maxActiveLeases must be a positive integer");
    }
    this.maxActiveLeasesPerOwner = options.maxActiveLeasesPerOwner ?? 2;
    if (!Number.isSafeInteger(this.maxActiveLeasesPerOwner) || this.maxActiveLeasesPerOwner < 1) {
      throw new Error("maxActiveLeasesPerOwner must be a positive integer");
    }
    this.maxQueuedLeases = options.maxQueuedLeases ?? 32;
    if (!Number.isSafeInteger(this.maxQueuedLeases) || this.maxQueuedLeases < 1) {
      throw new Error("maxQueuedLeases must be a positive integer");
    }
    this.admissionTimeoutMs = options.admissionTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.admissionTimeoutMs) || this.admissionTimeoutMs <= 0) {
      throw new Error("admissionTimeoutMs must be a positive integer");
    }
  }

  reserve(leaseId: string): boolean {
    return this.reserveFor(leaseId, leaseId);
  }

  async reserveOrWait(leaseId: string, signal?: AbortSignal): Promise<void> {
    return this.reserveOrWaitFor(leaseId, leaseId, signal);
  }

  async reserveOrWaitFor(leaseId: string, ownerId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortReason(signal);
    if (this.reserveFor(leaseId, ownerId)) return;
    if (this.pending.length >= this.maxQueuedLeases) {
      throw new RuntimeAdmissionError("Runtime admission queue is full.");
    }

    await new Promise<void>((resolve, reject) => {
      const admission: PendingAdmission = { leaseId, ownerId, resolve, reject, signal };
      const settle = (callback: () => void): void => {
        const index = this.pending.indexOf(admission);
        if (index === -1) return;
        this.pending.splice(index, 1);
        this.detach(admission);
        callback();
        this.pump();
      };
      const rejectForAbort = (): void => settle(() => reject(abortReason(signal!)));
      admission.abortListener = rejectForAbort;
      admission.timer = setTimeout(() => {
        settle(() => reject(new RuntimeAdmissionError()));
      }, this.admissionTimeoutMs);
      admission.timer.unref?.();
      signal?.addEventListener("abort", rejectForAbort, { once: true });
      this.pending.push(admission);
      this.pump();
    });
  }

  release(leaseId: string): void {
    this.active.delete(leaseId);
    this.pump();
  }

  close(error: unknown = new RuntimeAdmissionError("Runtime is closed.")): void {
    for (const admission of [...this.pending]) {
      const index = this.pending.indexOf(admission);
      if (index === -1) continue;
      this.pending.splice(index, 1);
      this.detach(admission);
      admission.reject(error);
    }
  }

  has(leaseId: string): boolean {
    return this.active.has(leaseId);
  }

  get activeCount(): number {
    return this.active.size;
  }

  get waitingCount(): number {
    return this.pending.length;
  }

  get capacity(): number {
    return this.maxActiveLeases;
  }

  shouldStop(): boolean {
    return this.active.size === 0 && this.pending.length === 0;
  }

  private reserveFor(leaseId: string, ownerId: string): boolean {
    if (this.active.has(leaseId)) return true;
    if (
      this.pending.length > 0 ||
      this.active.size >= this.maxActiveLeases ||
      this.activeCountFor(ownerId) >= this.maxActiveLeasesPerOwner
    ) return false;
    this.active.set(leaseId, ownerId);
    return true;
  }

  private activeCountFor(ownerId: string): number {
    let count = 0;
    for (const activeOwner of this.active.values()) if (activeOwner === ownerId) count += 1;
    return count;
  }

  private detach(admission: PendingAdmission): void {
    if (admission.timer !== undefined) clearTimeout(admission.timer);
    if (admission.signal !== undefined && admission.abortListener !== undefined) {
      admission.signal.removeEventListener("abort", admission.abortListener);
    }
  }

  private pump(): void {
    while (this.active.size < this.maxActiveLeases && this.pending.length > 0) {
      const index = this.pending.findIndex((admission) => (
        this.activeCountFor(admission.ownerId) < this.maxActiveLeasesPerOwner
      ));
      if (index < 0) return;
      const [admission] = this.pending.splice(index, 1);
      if (admission === undefined) return;
      this.detach(admission);
      if (admission.signal?.aborted) {
        admission.reject(abortReason(admission.signal));
        continue;
      }
      this.active.set(admission.leaseId, admission.ownerId);
      admission.resolve();
    }
  }
}
