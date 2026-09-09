/**
 * Global provider-attempt admission for the shared OpenBot process.
 *
 * The scheduler owns only the interval occupied by `ProviderAdapter.streamChat`.
 * Context assembly, tool execution and persistence remain outside this lease.
 */

export const DEFAULT_PROVIDER_MAX_ACTIVE = 4;
export const DEFAULT_PROVIDER_MAX_QUEUED = 64;
export const DEFAULT_PROVIDER_MAX_QUEUED_PER_AGENT = 8;

export type ProviderAdmissionMetrics = {
  active: number;
  waiting: number;
  admitted: number;
  rejected: number;
  aborted: number;
  waitTimeObservations: {
    count: number;
    totalMs: number;
    maxMs: number;
    meanMs: number;
  };
};

export type ProviderAdmissionLease = {
  readonly agentId: string;
  readonly admittedAtMs: number;
  release(): void;
};

export type ProviderAdmissionOptions = {
  maxActive?: number;
  maxQueued?: number;
  maxQueuedPerAgent?: number;
  now?: () => number;
};

export class ProviderAdmissionError extends Error {
  readonly code: "queue-full" | "agent-queue-full" | "aborted" | "shutdown";
  readonly retryable: boolean;

  constructor(code: ProviderAdmissionError["code"], message: string, retryable: boolean) {
    super(message);
    this.name = "ProviderAdmissionError";
    this.code = code;
    this.retryable = retryable;
  }
}

type Waiter = {
  agentId: string;
  signal?: AbortSignal;
  resolve: (lease: ProviderAdmissionLease) => void;
  reject: (error: ProviderAdmissionError) => void;
  enqueuedAtMs: number;
  settled: boolean;
  onAbort?: () => void;
};

function validBound(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} deve ser um inteiro entre ${min} e ${max}`);
  }
  return value;
}

export class ProviderAdmissionScheduler {
  readonly maxActive: number;
  readonly maxQueued: number;
  readonly maxQueuedPerAgent: number;
  private readonly now: () => number;
  private readonly queues = new Map<string, Waiter[]>();
  private readonly readyAgents: string[] = [];
  private readonly readySet = new Set<string>();
  private active = 0;
  private waiting = 0;
  private accepting = true;
  private admitted = 0;
  private rejected = 0;
  private aborted = 0;
  private waitCount = 0;
  private waitTotalMs = 0;
  private waitMaxMs = 0;
  private drainPromise: Promise<void> | undefined;
  private drainResolve: (() => void) | undefined;

  constructor(options: ProviderAdmissionOptions = {}) {
    this.maxActive = validBound(options.maxActive, DEFAULT_PROVIDER_MAX_ACTIVE, 1, 64, "maxActive");
    this.maxQueued = validBound(options.maxQueued, DEFAULT_PROVIDER_MAX_QUEUED, 1, 4096, "maxQueued");
    this.maxQueuedPerAgent = validBound(options.maxQueuedPerAgent, DEFAULT_PROVIDER_MAX_QUEUED_PER_AGENT, 1, 4096, "maxQueuedPerAgent");
    this.now = options.now ?? Date.now;
  }

  get activeCount(): number { return this.active; }
  get waitingCount(): number { return this.waiting; }

  acquire(agentId: string, signal?: AbortSignal): Promise<ProviderAdmissionLease> {
    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return Promise.reject(new ProviderAdmissionError("shutdown", "provider admission exige agentId", false));
    }
    if (!this.accepting) {
      this.rejected += 1;
      return Promise.reject(new ProviderAdmissionError("shutdown", "provider admission está em shutdown", false));
    }
    if (signal?.aborted) {
      this.aborted += 1;
      return Promise.reject(new ProviderAdmissionError("aborted", "provider admission abortada antes da espera", false));
    }
    if (this.active < this.maxActive && this.waiting === 0) {
      this.active += 1;
      this.admitted += 1;
      return Promise.resolve(this.makeLease(agentId));
    }
    const agentQueue = this.queues.get(agentId);
    if ((agentQueue?.length ?? 0) >= Math.min(this.maxQueuedPerAgent, this.maxQueued)) {
      this.rejected += 1;
      return Promise.reject(new ProviderAdmissionError("agent-queue-full", "fila de provider deste agente está cheia", true));
    }
    if (this.waiting >= this.maxQueued) {
      this.rejected += 1;
      return Promise.reject(new ProviderAdmissionError("queue-full", "fila global de provider está cheia", true));
    }
    return new Promise<ProviderAdmissionLease>((resolve, reject) => {
      const waiter: Waiter = {
        agentId,
        signal,
        resolve,
        reject,
        enqueuedAtMs: this.now(),
        settled: false,
      };
      waiter.onAbort = () => {
        if (waiter.settled) return;
        this.removeWaiter(waiter);
        waiter.settled = true;
        this.aborted += 1;
        reject(new ProviderAdmissionError("aborted", "provider admission abortada durante a espera", false));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      let queue = this.queues.get(agentId);
      if (queue === undefined) {
        queue = [];
        this.queues.set(agentId, queue);
      }
      queue.push(waiter);
      this.waiting += 1;
      if (!this.readySet.has(agentId)) {
        this.readySet.add(agentId);
        this.readyAgents.push(agentId);
      }
      this.pump();
    });
  }

  metrics(): ProviderAdmissionMetrics {
    return {
      active: this.active,
      waiting: this.waiting,
      admitted: this.admitted,
      rejected: this.rejected,
      aborted: this.aborted,
      waitTimeObservations: {
        count: this.waitCount,
        totalMs: this.waitTotalMs,
        maxMs: this.waitMaxMs,
        meanMs: this.waitCount === 0 ? 0 : this.waitTotalMs / this.waitCount,
      },
    };
  }

  /** Stop accepting work and settle every waiter not yet admitted. */
  shutdown(): void {
    if (!this.accepting) return;
    this.accepting = false;
    for (const queue of this.queues.values()) {
      for (const waiter of queue) {
        this.settleQueued(waiter, new ProviderAdmissionError("shutdown", "provider admission encerrou durante a espera" , false));
      }
    }
    this.queues.clear();
    this.readyAgents.length = 0;
    this.readySet.clear();
    this.waiting = 0;
    this.resolveDrainIfIdle();
  }

  /** Resolve when all already admitted leases have been released. */
  drain(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    this.drainPromise ??= new Promise<void>((resolve) => { this.drainResolve = resolve; });
    return this.drainPromise;
  }

  close(): Promise<void> {
    this.shutdown();
    return this.drain();
  }

  private makeLease(agentId: string): ProviderAdmissionLease {
    const admittedAtMs = this.now();
    let released = false;
    return {
      agentId,
      admittedAtMs,
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.pump();
        this.resolveDrainIfIdle();
      },
    };
  }

  private settleQueued(waiter: Waiter, error: ProviderAdmissionError): void {
    if (waiter.settled) return;
    waiter.settled = true;
    waiter.signal?.removeEventListener("abort", waiter.onAbort!);
    this.waiting -= 1;
    waiter.reject(error);
  }

  private removeWaiter(waiter: Waiter): void {
    const queue = this.queues.get(waiter.agentId);
    if (queue === undefined) return;
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    this.waiting -= index >= 0 ? 1 : 0;
    if (queue.length === 0) {
      this.queues.delete(waiter.agentId);
      this.readySet.delete(waiter.agentId);
      const readyIndex = this.readyAgents.indexOf(waiter.agentId);
      if (readyIndex >= 0) this.readyAgents.splice(readyIndex, 1);
    }
  }

  private pump(): void {
    while (this.accepting && this.active < this.maxActive && this.waiting > 0 && this.readyAgents.length > 0) {
      const agentId = this.readyAgents.shift()!;
      this.readySet.delete(agentId);
      const queue = this.queues.get(agentId);
      const waiter = queue?.shift();
      if (waiter === undefined) {
        this.queues.delete(agentId);
        continue;
      }
      this.waiting -= 1;
      if (queue !== undefined && queue.length > 0) {
        this.readySet.add(agentId);
        this.readyAgents.push(agentId);
      } else {
        this.queues.delete(agentId);
      }
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      const waitedMs = Math.max(0, this.now() - waiter.enqueuedAtMs);
      this.waitCount += 1;
      this.waitTotalMs += waitedMs;
      this.waitMaxMs = Math.max(this.waitMaxMs, waitedMs);
      this.active += 1;
      this.admitted += 1;
      waiter.resolve(this.makeLease(waiter.agentId));
    }
  }

  private resolveDrainIfIdle(): void {
    if (this.active !== 0 || this.drainResolve === undefined) return;
    const resolve = this.drainResolve;
    this.drainResolve = undefined;
    this.drainPromise = undefined;
    resolve();
  }
}

function parseEnvBound(env: NodeJS.ProcessEnv, key: string, min: number, max: number): number | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} deve ser um inteiro entre ${min} e ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} deve ser um inteiro entre ${min} e ${max}`);
  }
  return value;
}

export function providerAdmissionOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderAdmissionOptions {
  return {
    maxActive: parseEnvBound(env, "OPENBOT_PROVIDER_MAX_ACTIVE", 1, 64),
    maxQueued: parseEnvBound(env, "OPENBOT_PROVIDER_MAX_QUEUED", 1, 4096),
  };
}

export function createProviderAdmissionFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderAdmissionScheduler {
  return new ProviderAdmissionScheduler(providerAdmissionOptionsFromEnv(env));
}
