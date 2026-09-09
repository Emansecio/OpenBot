import type { A2AMessageRecord, A2AProjectionEnvelope } from "./store.js";
import { A2AStore } from "./store.js";

export interface A2ARuntimeOptions {
  store: A2AStore;
  agentIds: () => readonly string[];
  isUserLaneBusy: () => boolean;
  isUserLanePending: () => boolean;
  enqueueBackground?: (agentId: string, priority: "normal" | "high", task: () => Promise<void>) => void;
  consume: (context: { message: A2AMessageRecord; signal: AbortSignal }) => Promise<{ ackNonce?: string } | void>;
  publishProjection?: (envelope: A2AProjectionEnvelope) => boolean | Promise<boolean>;
  now?: () => number;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export class A2ARuntime {
  private readonly options: A2ARuntimeOptions;
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private wakeResolver: (() => void) | undefined;
  private cursor = 0;
  private abortController: AbortController | undefined;

  constructor(options: A2ARuntimeOptions) { this.options = options; }

  start(): void {
    if (this.running) return;
    this.abortController = new AbortController();
    this.running = true;
    this.loopPromise = this.loop();
    this.wake();
  }

  wake(): void {
    const resolve = this.wakeResolver;
    this.wakeResolver = undefined;
    resolve?.();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController?.abort();
    this.wake();
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  private waitForWakeOrScan(): Promise<void> {
    const interval = Math.max(1, this.options.pollIntervalMs ?? 1_000);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); this.wakeResolver = undefined; resolve(); };
      const timer = setTimeout(finish, interval);
      timer.unref?.();
      this.wakeResolver = finish;
    });
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        this.options.store.recoverExpired();
      } catch (error) {
        if (!this.running || /store is closed/iu.test(error instanceof Error ? error.message : String(error))) return;
        throw error;
      }
      await this.flushProjections();
      if (this.options.isUserLaneBusy() || this.options.isUserLanePending()) {
        await this.waitForWakeOrScan();
        continue;
      }
      const agents = [...new Set(this.options.agentIds())];
      let processed = false;
      if (agents.length > 0) {
        for (let offset = 0; offset < agents.length; offset += 1) {
          const index = (this.cursor + offset) % agents.length;
          const agentId = agents[index]!;
          const claim = this.options.store.claimNext(agentId, {
            ownerId: `a2a-runtime:${process.pid}`,
            nowMs: this.now(),
            leaseDurationMs: this.options.leaseDurationMs ?? 30_000,
          });
          if (claim === undefined) continue;
          processed = true;
          this.cursor = (index + 1) % agents.length;
          const run = async () => {
            await this.consumeClaim(agentId, claim.message, claim.lease.version, claim.lease.ownerId);
          };
          if (this.options.enqueueBackground === undefined) await run();
          else await new Promise<void>((resolve) => {
            this.options.enqueueBackground!(agentId, claim.message.priority, async () => {
              try { await run(); } finally { resolve(); }
            });
          });
          await this.flushProjections();
          break;
        }
      }
      if (!processed) await this.waitForWakeOrScan();
    }
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
      this.options.store.ack(message.messageId, { ownerId, expectedVersion: leaseVersion, status: "acked", ackNonce: result?.ackNonce });
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
    for (const envelope of this.options.store.projectUndelivered(100)) {
      let accepted = false;
      try { accepted = await this.options.publishProjection(envelope); } catch { accepted = false; }
      this.options.store.acknowledgeProjection(envelope.projectionId, accepted, this.now());
    }
  }
}
