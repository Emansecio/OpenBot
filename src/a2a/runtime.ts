import type { A2AMessageRecord, A2AProjectionEnvelope } from "./store.js";
import { A2AStore } from "./store.js";

export interface A2ARuntimeOptions {
  store: A2AStore;
  agentIds: () => readonly string[];
  isUserLaneBusy: () => boolean;
  isUserLanePending: () => boolean;
  consume: (context: { message: A2AMessageRecord; signal: AbortSignal }) => Promise<{
    ackNonce?: string;
    outcome?: "success" | "partial" | "error" | "aborted";
  } | void>;
  publishProjection?: (envelope: A2AProjectionEnvelope) => boolean | Promise<boolean>;
  now?: () => number;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

/** Lease owner prefix of the in-process delivery runtime. */
export const A2A_RUNTIME_OWNER_PREFIX = "a2a-runtime:";

export class A2ARuntime {
  private readonly options: A2ARuntimeOptions;
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private wakeResolver: (() => void) | undefined;
  /** A wake that arrived while no wait was pending; the next wait returns at once. */
  private wakeRequested = false;
  /** Projection delivery backoff: with no subscriber, pending rows are not re-read every tick. */
  private projectionFailures = 0;
  private projectionRetryAtMs = 0;
  private cursor = 0;
  private abortController: AbortController | undefined;

  constructor(options: A2ARuntimeOptions) { this.options = options; }

  start(): void {
    if (this.running) return;
    this.abortController = new AbortController();
    this.running = true;
    // The first pass runs at once; no wake is needed to start it.
    this.loopPromise = this.loop();
  }

  wake(): void {
    const resolve = this.wakeResolver;
    this.wakeResolver = undefined;
    if (resolve !== undefined) resolve();
    else this.wakeRequested = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController?.abort();
    this.wake();
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  /** Waits for wake() or `intervalMs`, whichever comes first. */
  private waitForWakeOrScan(intervalMs = Math.max(1, this.options.pollIntervalMs ?? 1_000)): Promise<void> {
    if (this.wakeRequested || !this.running) {
      this.wakeRequested = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); this.wakeResolver = undefined; resolve(); };
      const timer = setTimeout(finish, intervalMs);
      timer.unref?.();
      this.wakeResolver = finish;
    });
  }

  /**
   * Runs on demand: while no message is queued or in flight a tick costs one
   * indexed read (no write transaction, no per-agent scan), and still picks
   * up a message whose wake was lost. A failing pass (a corrupt row, a
   * transient SQLite error) is logged and retried with backoff; it never
   * ends the loop.
   */
  private async loop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        const next = await this.deliverOnce();
        failures = 0;
        if (next === "poll") await this.waitForWakeOrScan();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!this.running || /store is closed/iu.test(message)) return;
        failures = Math.min(failures + 1, 6);
        console.warn(`[openbot] a2a delivery deferred: ${message}`);
        await this.waitForWakeOrScan(Math.min(30_000, Math.max(1, this.options.pollIntervalMs ?? 1_000) * (2 ** (failures - 1))));
      }
    }
  }

  /** One delivery pass: "again" right after a delivery, otherwise "poll". */
  private async deliverOnce(): Promise<"again" | "poll"> {
    // A wake requested before this pass is served by it; only a later one repeats it at once.
    this.wakeRequested = false;
    await this.flushProjections();
    // From here to the first claim nothing awaits, so the roster read below
    // and the claims see the same store state.
    const active = this.options.store.hasActiveMessages();
    const agents = [...new Set(this.options.agentIds())];
    if (!active) return "poll";
    this.options.store.recoverExpired(this.now());
    if (this.options.isUserLaneBusy() || this.options.isUserLanePending()) return "poll";
    for (let offset = 0; offset < agents.length; offset += 1) {
      const index = (this.cursor + offset) % agents.length;
      const agentId = agents[index]!;
      const claim = this.options.store.claimNext(agentId, {
        ownerId: A2A_RUNTIME_OWNER_PREFIX + String(process.pid),
        nowMs: this.now(),
        leaseDurationMs: this.options.leaseDurationMs ?? 30_000,
        recover: false,
      });
      if (claim === undefined) continue;
      this.cursor = (index + 1) % agents.length;
      await this.consumeClaim(agentId, claim.message, claim.lease.version, claim.lease.ownerId);
      await this.flushProjections();
      return "again";
    }
    return "poll";
  }

  private async consumeClaim(_agentId: string, message: A2AMessageRecord, version: number, ownerId: string): Promise<void> {
    const controller = new AbortController();
    let leaseVersion = version;
    let leaseLost = false;
    let stopRequested = false;
    let stopListener: (() => void) | undefined;
    let heartbeatStopped = false;
    const heartbeatEvery = Math.max(10, Math.floor((this.options.leaseDurationMs ?? 30_000) / 2));
    const heartbeat = setInterval(() => {
      try {
        leaseVersion = this.options.store.heartbeat(message.messageId, {
          ownerId,
          expectedVersion: leaseVersion,
          leaseDurationMs: this.options.leaseDurationMs ?? 30_000,
          nowMs: this.now(),
        }).version;
      } catch {
        leaseLost = true;
        controller.abort();
      }
    }, heartbeatEvery);
    heartbeat.unref?.();
    const stopRequestedPromise = new Promise<"stopped">((resolve) => {
      stopListener = () => {
        stopRequested = true;
        controller.abort();
        stopHeartbeat();
        resolve("stopped");
      };
      this.abortController?.signal.addEventListener("abort", stopListener, { once: true });
    });
    const stopHeartbeat = () => {
      if (heartbeatStopped) return;
      heartbeatStopped = true;
      clearInterval(heartbeat);
    };
    try {
      const runningConsume = this.options.consume({ message, signal: controller.signal });
      runningConsume.catch(() => undefined);
      const result = await Promise.race([runningConsume, stopRequestedPromise]);
      if (result === "stopped") return;
      stopHeartbeat();
      if (stopRequested || leaseLost) return;
      if (result?.outcome !== undefined && result.outcome !== "success") {
        this.options.store.ack(message.messageId, {
          ownerId,
          expectedVersion: leaseVersion,
          status: "rejected",
          terminalReason: `turn-${result.outcome}`,
        });
      } else {
        this.options.store.ack(message.messageId, { ownerId, expectedVersion: leaseVersion, status: "acked", ackNonce: result?.ackNonce });
      }
    } catch {
      stopHeartbeat();
      if (stopRequested || leaseLost) return;
      const maxAttempts = this.options.maxAttempts ?? 3;
      if (message.attempt >= maxAttempts) {
        this.options.store.ack(message.messageId, { ownerId, expectedVersion: leaseVersion, status: "dead" });
      } else {
        this.options.store.retry(message.messageId, { ownerId, expectedVersion: leaseVersion, availableAtMs: this.now() + (this.options.retryDelayMs ?? 0) });
      }
    } finally {
      stopHeartbeat();
      if (stopListener !== undefined) this.abortController?.signal.removeEventListener("abort", stopListener);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async flushProjections(): Promise<void> {
    if (this.options.publishProjection === undefined) return;
    if (Date.now() < this.projectionRetryAtMs) return;
    let rejected = false;
    for (const envelope of this.options.store.projectUndelivered(100)) {
      let accepted = false;
      try { accepted = await this.options.publishProjection(envelope); } catch { accepted = false; }
      this.options.store.acknowledgeProjection(envelope.projectionId, accepted, this.now());
      if (!accepted) rejected = true;
    }
    if (rejected) {
      this.projectionFailures = Math.min(this.projectionFailures + 1, 8);
      this.projectionRetryAtMs = Date.now() + Math.min(30_000, 100 * (2 ** (this.projectionFailures - 1)));
    } else {
      this.projectionFailures = 0;
      this.projectionRetryAtMs = 0;
    }
  }
}
