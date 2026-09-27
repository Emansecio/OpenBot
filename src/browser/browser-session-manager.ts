import { createHash } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  EgressProxy,
  type EgressProxyAddress,
  type EgressProxyOptions,
} from "./egress-proxy.js";

import {
  createAuthToken,
  createRequestId,
  encodeBrowserFrame,
  parseBrowserHostMessage,
  validateBrowserCommand,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserHostCommandResult,
  type BrowserHostDownloadEvent,
  type BrowserHostHandoffEvent,
  type BrowserHostMessage,
  type BrowserHostRequest,
  type BrowserInternalCommand,
  type BrowserLeaseDescriptor,
} from "./protocol.js";

export const DEFAULT_BROWSER_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_BROWSER_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_BROWSER_LEASE_TTL_MS = 15 * 60_000;
export const MAX_BROWSER_LEASE_TTL_MS = 24 * 60 * 60_000;
// The host queues at most 16 requests per agent and 64 overall (plus one
// running per agent); larger manager limits only turned into host rejections.
export const DEFAULT_BROWSER_MAX_PENDING_REQUESTS = 64;
export const DEFAULT_BROWSER_MAX_PENDING_PER_AGENT = 16;
/** Chromium caches of an idle partition are dropped only above this size. */
export const DEFAULT_BROWSER_MAX_PARTITION_CACHE_BYTES = 200 * 1024 * 1024;
const LEASE_CLEANUP_RETRY_MS = 30_000;
const MAX_AGENT_ID_BYTES = 256;

export interface BrowserHostProcess {
  stdin: {
    write(chunk: string): boolean;
    end(): void;
    once?(event: "drain", listener: () => void): unknown;
    removeListener?(event: "drain", listener: () => void): unknown;
  };
  stdout: NodeJS.ReadableStream;
  /** Optional host stderr stream, exposed only for isolated diagnostics/tests. */
  stderr?: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface BrowserHostLaunchOptions {
  authToken: string;
  hostPath: string;
  /** Absolute path to a local Electron launcher entrypoint. */
  electronPath: string;
  downloadsRoot: string;
  /** Managed Electron user-data root for persistent per-agent partitions. */
  userDataRoot: string;
  /** Proxy details are supplied out-of-band to the host and never in frames. */
  proxyUrl: string;
  proxyToken: string;
  maxDownloadBytes: number;
}

export type BrowserHostLauncher = (options: BrowserHostLaunchOptions) => BrowserHostProcess | Promise<BrowserHostProcess>;

export interface BrowserSessionManagerOptions {
  /** Managed ancestor for per-agent Downloads directories. */
  downloadsRoot: string;
  /**
   * Managed Electron userData/profile root, outside every agent home.
   * Defaults to a sibling of downloadsRoot, never a folder inside it.
   */
  userDataRoot?: string;
  /** Resolves the already-authorized agent home Downloads directory. */
  resolveDownloadRoot?: (agentId: string) => string | Promise<string>;
  /** Resolves the already-authorized agent home for browser uploads. */
  resolveHomeRoot?: (agentId: string) => string | Promise<string>;
  hostPath?: string;
  electronPath?: string;
  launchHost?: BrowserHostLauncher;
  egressProxy?: EgressProxy;
  egressProxyOptions?: EgressProxyOptions;
  maxDownloadBytes?: number;
  onDownload?: (event: BrowserDownloadEvent) => void | Promise<void>;
  /** Diagnostic hook; normal callers should leave host stderr unobserved. */
  onHostStderr?: (chunk: string) => void;
  commandTimeoutMs?: number;
  readyTimeoutMs?: number;
  leaseTtlMs?: number;
  maxPendingRequests?: number;
  maxPendingPerAgent?: number;
  /** Idle partitions whose Chromium caches exceed this are trimmed on host stop. */
  maxPartitionCacheBytes?: number;
  now?: () => number;
}

export interface BrowserDownloadEvent {
  agentId: string;
  sessionId: string;
  tabId: string;
  path: string;
  state: "completed" | "cancelled" | "interrupted" | "limit";
  bytes: number;
}

export const DEFAULT_BROWSER_MAX_DOWNLOAD_BYTES = 1024 * 1024;

export interface BrowserAcquireOptions {
  sessionId?: string;
  ttlMs?: number;
}

export interface BrowserLease extends BrowserLeaseDescriptor {
  release(): Promise<void>;
}

export class BrowserHostError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BrowserHostError";
    this.code = code;
  }
}

export async function waitForBrowserCommandPipe<T>(connection: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new BrowserHostError("BROWSER_HOST_LAUNCH_FAILED", "browser host command pipe timed out"));
    }, 15_000);
  });
  try {
    return await Promise.race([connection, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

interface LeaseState extends BrowserLeaseDescriptor {
  /** Idle TTL: each command moves expiresAt this far into the future. */
  ttlMs: number;
  released: boolean;
  expired?: boolean;
  /** The user controls the tab's window; the lease does not expire meanwhile. */
  handoffActive?: boolean;
  cleanup?: Promise<BrowserHostCommandResult | undefined>;
  /** Set when a cleanup failed; the sweep retries it at this time. */
  cleanupRetryAt?: number;
  /** Trusted home root supplied by the server, never model-controlled. */
  homeRoot?: string;
}

interface PendingRequest {
  resolve(result: BrowserHostCommandResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  host: HostConnection;
  state: LeaseState;
  abortCleanup?: () => void;
  cancellationSent?: boolean;
}

interface HostConnection {
  process: BrowserHostProcess;
  token: string;
  lines: Interface;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  /** The host sent its ready frame; later protocol errors end the host. */
  readyObserved: boolean;
  writeTail: Promise<void>;
}

/**
 * Owns one lazy, authenticated browser host and all per-agent browser leases.
 * The host is intentionally a single process: idle agents do not retain an
 * Electron process, while each agent keeps a persistent Electron partition.
 */
export class BrowserSessionManager {
  private readonly downloadsRoot: string;
  private readonly userDataRoot: string;
  private readonly resolveDownloadRoot?: (agentId: string) => string | Promise<string>;
  private readonly resolveHomeRoot?: (agentId: string) => string | Promise<string>;
  private readonly hostPath: string;
  /** Resolved on first launch: a missing Electron must only disable the browser. */
  private electronPath?: string;
  private readonly launchHost: BrowserHostLauncher;
  private readonly proxy: EgressProxy;
  private readonly maxDownloadBytes: number;
  private readonly onDownload?: (event: BrowserDownloadEvent) => void | Promise<void>;
  private readonly onHostStderr?: (chunk: string) => void;
  private readonly commandTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly leaseTtlMs: number;
  private readonly maxPendingRequests: number;
  private readonly maxPendingPerAgent: number;
  private readonly maxPartitionCacheBytes: number;
  private readonly now: () => number;
  private readonly leases = new Map<string, LeaseState>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingByAgent = new Map<string, number>();
  /** Includes requests reserved while host startup is still awaiting readiness. */
  private pendingCount = 0;
  private host?: HostConnection;
  /** Set before the shared host pipe is closed so no caller can reuse it. */
  private stopping?: Promise<void>;
  private starting?: Promise<HostConnection>;
  private startingProcess?: BrowserHostProcess;
  private proxyStarting?: Promise<EgressProxyAddress>;
  private leaseSweepTimer?: ReturnType<typeof setTimeout>;
  private readonly agentTeardowns = new Map<string, Promise<void>>();
  private readonly downloadObservers = new Map<string, Set<Promise<void>>>();
  /**
   * Agents purged while a shared host kept their partition folder open. The
   * reset already cleared the storage; the folder is removed once no host
   * runs, unless the agent acquired a lease (and reused it) meanwhile.
   */
  private readonly pendingPartitionPurges = new Set<string>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(options: BrowserSessionManagerOptions) {
    if (typeof options.downloadsRoot !== "string" || options.downloadsRoot.length === 0 || !isAbsolute(options.downloadsRoot)) {
      throw new Error("downloadsRoot must be an absolute path");
    }
    this.downloadsRoot = resolve(options.downloadsRoot);
    const userDataRoot = options.userDataRoot ?? join(dirname(this.downloadsRoot), `${basename(this.downloadsRoot)}.browser-user-data`);
    if (!isAbsolute(userDataRoot)) throw new BrowserHostError("BROWSER_USER_DATA_ROOT_INVALID", "userDataRoot must be absolute");
    this.userDataRoot = resolve(userDataRoot);
    this.resolveDownloadRoot = options.resolveDownloadRoot;
    this.resolveHomeRoot = options.resolveHomeRoot;
    this.hostPath = options.hostPath ?? fileURLToPath(new URL("../../scripts/openbot-browser-host.cjs", import.meta.url));
    // An explicit path is configuration and is checked now; the packaged
    // runtime is looked up when the first browser command needs it.
    if (options.electronPath !== undefined) this.electronPath = resolveExplicitElectronPath(options.electronPath);
    this.launchHost = options.launchHost ?? defaultBrowserHostLauncher;
    this.proxy = options.egressProxy ?? new EgressProxy(options.egressProxyOptions);
    this.maxDownloadBytes = clampDownloadLimit(options.maxDownloadBytes ?? DEFAULT_BROWSER_MAX_DOWNLOAD_BYTES);
    this.onDownload = options.onDownload;
    this.onHostStderr = options.onHostStderr;
    this.commandTimeoutMs = clampTimeout(options.commandTimeoutMs ?? DEFAULT_BROWSER_COMMAND_TIMEOUT_MS, "commandTimeoutMs");
    this.readyTimeoutMs = clampTimeout(options.readyTimeoutMs ?? this.commandTimeoutMs, "readyTimeoutMs");
    this.leaseTtlMs = clampLeaseTtl(options.leaseTtlMs ?? DEFAULT_BROWSER_LEASE_TTL_MS);
    this.maxPendingRequests = clampPendingLimit(options.maxPendingRequests ?? DEFAULT_BROWSER_MAX_PENDING_REQUESTS, "maxPendingRequests");
    this.maxPendingPerAgent = clampPendingLimit(options.maxPendingPerAgent ?? DEFAULT_BROWSER_MAX_PENDING_PER_AGENT, "maxPendingPerAgent");
    const maxPartitionCacheBytes = options.maxPartitionCacheBytes ?? DEFAULT_BROWSER_MAX_PARTITION_CACHE_BYTES;
    if (!Number.isSafeInteger(maxPartitionCacheBytes) || maxPartitionCacheBytes < 0) throw new Error("maxPartitionCacheBytes must be a non-negative integer");
    this.maxPartitionCacheBytes = maxPartitionCacheBytes;
    this.now = options.now ?? Date.now;
  }

  get activeLeaseCount(): number {
    return this.leases.size;
  }

  get hostRunning(): boolean {
    return this.host !== undefined;
  }

  hasLease(lease: BrowserLeaseDescriptor | string): boolean {
    const leaseId = typeof lease === "string" ? lease : lease.leaseId;
    const state = this.leases.get(leaseId);
    return state !== undefined && !state.released;
  }

  async acquire(agentId: string, options?: BrowserAcquireOptions): Promise<BrowserLease>;
  async acquire(options: { agentId: string; sessionId?: string; ttlMs?: number }): Promise<BrowserLease>;
  async acquire(
    agentIdOrOptions: string | { agentId: string; sessionId?: string; ttlMs?: number },
    options: BrowserAcquireOptions = {},
  ): Promise<BrowserLease> {
    const agentId = typeof agentIdOrOptions === "string" ? agentIdOrOptions : agentIdOrOptions.agentId;
    const requested = typeof agentIdOrOptions === "string" ? options : agentIdOrOptions;
    assertAgentId(agentId);
    while (this.agentTeardowns.has(agentId) || this.stopping !== undefined) {
      await (this.agentTeardowns.get(agentId) ?? this.stopping);
    }
    if (this.closed) throw new BrowserHostError("BROWSER_MANAGER_CLOSED", "browser session manager is closed");
    const ttlMs = clampLeaseTtl(requested.ttlMs ?? this.leaseTtlMs);
    const sessionId = requested.sessionId ?? createRequestId();
    assertIdentifier(sessionId, "sessionId");
    const leaseId = createRequestId();
    const tabId = createRequestId();
    const partition = `persist:openbot-agent-${hashAgentId(agentId)}`;
    const downloadRoot = await this.resolveAgentDownloadRoot(agentId);
    const homeRoot = await this.resolveAgentHomeRoot(agentId);
    // Root resolution can yield while the last old lease starts teardown.
    // Re-check immediately before publishing the new lease so it cannot be
    // returned while the previous host pipe is still closing.
    while (this.agentTeardowns.has(agentId) || this.stopping !== undefined) {
      await (this.agentTeardowns.get(agentId) ?? this.stopping);
    }
    if (this.closed) throw new BrowserHostError("BROWSER_MANAGER_CLOSED", "browser session manager is closed");
    const state: LeaseState = {
      leaseId,
      agentId,
      sessionId,
      tabId,
      partition,
      downloadRoot,
      ...(homeRoot === undefined ? {} : { homeRoot }),
      expiresAt: this.now() + ttlMs,
      ttlMs,
      released: false,
    };
    // The agent uses its partition again: the storage was cleared by the
    // purge, and deleting the folder later would now erase new data.
    this.pendingPartitionPurges.delete(agentId);
    this.leases.set(leaseId, state);
    this.scheduleLeaseSweep();
    return this.asPublicLease(state);
  }

  async execute(
    lease: BrowserLeaseDescriptor | string,
    command: BrowserCommand,
    signal?: AbortSignal,
    options?: { homeRoot?: string },
  ): Promise<BrowserCommandResult> {
    const state = this.getLease(lease);
    await this.assertLeaseActive(state);
    if (signal?.aborted) throw browserAbortError();
    const safeCommand = validateBrowserCommand(command);
    this.renewLease(state);
    // Closing always runs to completion: cancelling a turn must not leave
    // the window open or the lease half released.
    if (safeCommand.command === "close") return await this.closeLease(state);
    try {
      return await this.sendCommand(state, safeCommand, undefined, signal, options?.homeRoot) as BrowserCommandResult;
    } catch (error) {
      // The host no longer has this tab (never opened, or closed by the
      // user). Release the lease so it cannot keep the host running.
      if (error instanceof BrowserHostError && error.code === "BROWSER_TAB_NOT_FOUND") {
        await this.beginLeaseCleanup(state).catch(() => undefined);
      }
      throw error;
    }
  }

  open(lease: BrowserLeaseDescriptor | string, url = "about:blank", signal?: AbortSignal): Promise<BrowserCommandResult> {
    return this.execute(lease, { command: "open", url }, signal);
  }

  navigate(lease: BrowserLeaseDescriptor | string, url: string, signal?: AbortSignal): Promise<BrowserCommandResult> {
    return this.execute(lease, { command: "navigate", url }, signal);
  }

  snapshot(lease: BrowserLeaseDescriptor | string, includeText = true, signal?: AbortSignal): Promise<BrowserCommandResult> {
    return this.execute(lease, { command: "snapshot", includeText }, signal);
  }

  click(lease: BrowserLeaseDescriptor | string, x: number, y: number, button: "left" | "middle" | "right" = "left", signal?: AbortSignal): Promise<BrowserCommandResult> {
    return this.execute(lease, { command: "click", x, y, button }, signal);
  }

  type(lease: BrowserLeaseDescriptor | string, text: string, signal?: AbortSignal): Promise<BrowserCommandResult> {
    return this.execute(lease, { command: "type", text }, signal);
  }

  upload(lease: BrowserLeaseDescriptor | string, selector: string, path: string, signal?: AbortSignal): Promise<BrowserCommandResult> {
    return this.execute(lease, { command: "upload", selector, path }, signal);
  }

  screenshot(lease: BrowserLeaseDescriptor | string, fullPage = false, signal?: AbortSignal): Promise<BrowserCommandResult> {
    return this.execute(lease, { command: "screenshot", fullPage }, signal);
  }

  handoff(lease: BrowserLeaseDescriptor | string, signal?: AbortSignal): Promise<BrowserCommandResult> {
    return this.execute(lease, { command: "handoff" }, signal);
  }

  async release(lease: BrowserLeaseDescriptor | string): Promise<void> {
    const leaseId = typeof lease === "string" ? lease : lease.leaseId;
    const state = this.leases.get(leaseId);
    if (state === undefined) return;
    await this.beginLeaseCleanup(state);
  }

  /** Drain tabs and downloads without deleting the agent's persistent profile. */
  teardownAgent(agentId: string): Promise<void> {
    return this.runAgentCleanup(agentId, false);
  }

  /** Explicit deletion/reset only. Ordinary backend/home cleanup must not purge. */
  purgeAgent(agentId: string): Promise<void> {
    return this.runAgentCleanup(agentId, true);
  }

  private async runAgentCleanup(agentId: string, purge: boolean): Promise<void> {
    assertAgentId(agentId);
    const previous = this.agentTeardowns.get(agentId);
    // Serialize unlike operations too: a purge cannot be lost by joining a drain.
    const teardown = (async () => {
      if (previous !== undefined) await previous;
      const owned = [...this.leases.values()].filter((lease) => lease.agentId === agentId);
      await Promise.all(owned.map((lease) => this.release(lease)));
      await Promise.all([...(this.downloadObservers.get(agentId) ?? [])]);
      if (purge) await this.performAgentPurge(agentId);
    })();
    this.agentTeardowns.set(agentId, teardown);
    try {
      await teardown;
    } finally {
      if (this.agentTeardowns.get(agentId) === teardown) this.agentTeardowns.delete(agentId);
    }
  }

  private async removePartitionRoot(agentId: string): Promise<void> {
    const target = this.partitionRootFor(agentId);
    if (!isPathWithin(this.userDataRoot, target) || target === this.userDataRoot) {
      throw new BrowserHostError("BROWSER_PARTITION_OUTSIDE_ROOT", "browser partition is outside the managed user-data root");
    }
    await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }

  private async performAgentPurge(agentId: string): Promise<void> {
    if (this.stopping !== undefined) await this.stopping;
    if (this.host !== undefined && this.leases.size === 0) {
      await this.stopHost();
      await this.removePartitionRoot(agentId);
      return;
    }
    if (this.host !== undefined) {
      const homeRoot = await this.resolveAgentHomeRoot(agentId);
      const state: LeaseState = {
        leaseId: createRequestId(),
        agentId,
        sessionId: "browser-reset",
        tabId: createRequestId(),
        partition: `persist:openbot-agent-${hashAgentId(agentId)}`,
        downloadRoot: await this.resolveAgentDownloadRoot(agentId),
        ...(homeRoot === undefined ? {} : { homeRoot }),
        expiresAt: this.now() + this.commandTimeoutMs,
        ttlMs: this.commandTimeoutMs,
        released: false,
      };
      await this.sendCommand(state, { command: "reset" }, this.host);
      // The running host keeps the folder open; delete it once no host runs.
      this.pendingPartitionPurges.add(agentId);
      return;
    }
    await this.removePartitionRoot(agentId);
  }

  private async removePendingPartitions(): Promise<void> {
    for (const agentId of [...this.pendingPartitionPurges]) {
      try {
        await this.removePartitionRoot(agentId);
        this.pendingPartitionPurges.delete(agentId);
      } catch {
        // Kept for the next host stop or start.
      }
    }
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.closing = this.closeManager();
    return this.closing;
  }

  private async closeManager(): Promise<void> {
    this.clearLeaseSweepTimer();
    this.startingProcess?.kill("SIGTERM");
    const proxyClosing = this.proxy.close();
    const starting = this.starting;
    if (starting !== undefined) await starting.catch(() => undefined);
    const leases = [...this.leases.values()];
    this.leases.clear();
    if (this.host !== undefined) {
      await Promise.all(leases.map(async (lease) => {
        lease.released = true;
        try {
          await this.sendCommand(lease, { command: "close" }, this.host);
        } catch {
          // Process teardown below is the final authority for tab cleanup.
        }
      }));
      await this.stopHost();
    }
    if (this.stopping !== undefined) await this.stopping;
    await proxyClosing;
    await Promise.all([...this.downloadObservers.values()].flatMap((observers) => [...observers]));
    const error = new BrowserHostError("BROWSER_MANAGER_CLOSED", "browser session manager is closed");
    for (const id of this.pending.keys()) {
      this.settlePending(id, error);
    }
  }

  private async sendCommand(
    state: LeaseState,
    command: BrowserInternalCommand,
    existingHost?: HostConnection,
    signal?: AbortSignal,
    homeRoot = state.homeRoot,
  ): Promise<BrowserHostCommandResult> {
    if (signal?.aborted) throw browserAbortError();
    const cleanup = command.command === "close" || command.command === "reset";
    if (!cleanup && state.released) throw new BrowserHostError("BROWSER_LEASE_NOT_FOUND", "browser lease is no longer active");
    this.reservePendingSlot(state.agentId);
    try {
      const host = existingHost ?? await raceWithBrowserAbort(this.ensureHost(), signal);
      if (signal?.aborted) throw browserAbortError();
      // Host startup yields. A drain may have revoked this lease meanwhile.
      if (!cleanup && state.released) throw new BrowserHostError("BROWSER_LEASE_NOT_FOUND", "browser lease is no longer active");
      const id = createRequestId();
      const request: BrowserHostRequest = {
        protocolVersion: 1,
        kind: "request",
        id,
        token: host.token,
        agentId: state.agentId,
        sessionId: state.sessionId,
        tabId: state.tabId,
        partition: state.partition,
        downloadRoot: state.downloadRoot,
        ...(homeRoot === undefined ? {} : { homeRoot }),
        command,
      };
      const frame = encodeBrowserFrame(request);
      return new Promise<BrowserHostCommandResult>((resolveResult, rejectResult) => {
        const pending: PendingRequest = {
          resolve: resolveResult,
          reject: rejectResult,
          timer: setTimeout(() => {
            this.settlePending(id, new BrowserHostError("BROWSER_COMMAND_TIMEOUT", `browser command ${command.command} timed out`), true);
          }, this.commandTimeoutMs),
          host,
          state,
        };
        if (signal !== undefined) {
          const onAbort = () => {
            this.settlePending(id, browserAbortError(), true);
          };
          pending.abortCleanup = () => signal.removeEventListener("abort", onAbort);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) {
            clearTimeout(pending.timer);
            pending.abortCleanup();
            this.releasePendingSlot(state.agentId);
            rejectResult(browserAbortError());
            return;
          }
        }
        this.pending.set(id, pending);
        void this.writeFrame(host, frame, signal).catch((error: unknown) => {
          this.settlePending(id, error instanceof Error ? error : new Error(String(error)), true);
        });
      });
    } catch (error) {
      this.releasePendingSlot(state.agentId);
      throw error;
    }
  }

  private settlePending(id: string, error?: Error, cancelHost = false): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.abortCleanup?.();
    this.releasePendingSlot(pending.state.agentId);
    if (cancelHost && !pending.cancellationSent) {
      pending.cancellationSent = true;
      void this.sendCancellation(pending.host, pending.state, id).catch(() => undefined);
    }
    if (error !== undefined) pending.reject(error);
  }

  private reservePendingSlot(agentId: string): void {
    const pendingForAgent = this.pendingByAgent.get(agentId) ?? 0;
    if (this.pendingCount >= this.maxPendingRequests || pendingForAgent >= this.maxPendingPerAgent) {
      throw new BrowserHostError("BROWSER_PENDING_LIMIT", "browser command pending limit reached");
    }
    this.pendingCount += 1;
    this.pendingByAgent.set(agentId, pendingForAgent + 1);
  }

  private releasePendingSlot(agentId: string): void {
    if (this.pendingCount > 0) this.pendingCount -= 1;
    const count = this.pendingByAgent.get(agentId) ?? 1;
    if (count <= 1) this.pendingByAgent.delete(agentId);
    else this.pendingByAgent.set(agentId, count - 1);
  }

  private async sendCancellation(host: HostConnection, state: LeaseState, targetId: string): Promise<void> {
    if (this.closed || this.host !== host) return;
    const request: BrowserHostRequest = {
      protocolVersion: 1,
      kind: "request",
      id: createRequestId(),
      token: host.token,
      agentId: state.agentId,
      sessionId: state.sessionId,
      tabId: state.tabId,
      partition: state.partition,
      downloadRoot: state.downloadRoot,
      ...(state.homeRoot === undefined ? {} : { homeRoot: state.homeRoot }),
      command: { command: "cancel", targetId },
    };
    await this.writeFrame(host, encodeBrowserFrame(request));
  }

  private async writeFrame(host: HostConnection, frame: string, signal?: AbortSignal): Promise<void> {
    const previous = host.writeTail;
    let release!: () => void;
    host.writeTail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous.catch(() => undefined);
    try {
      const accepted = host.process.stdin.write(frame);
      if (!accepted && host.process.stdin.once !== undefined) {
        await new Promise<void>((resolveDrain, rejectDrain) => {
          let settled = false;
          const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            host.process.stdin.removeListener?.("drain", onDrain);
            callback();
          };
          const onDrain = () => finish(resolveDrain);
          const onAbort = () => finish(() => rejectDrain(browserAbortError()));
          const timer = setTimeout(() => finish(() => rejectDrain(
            new BrowserHostError("BROWSER_COMMAND_TIMEOUT", "browser host stdin drain timed out"),
          )), this.commandTimeoutMs);
          timer.unref();
          host.process.stdin.once!("drain", onDrain);
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
    } finally {
      release();
    }
  }

  private async ensureHost(): Promise<HostConnection> {
    const stopping = this.stopping;
    if (stopping !== undefined) await stopping;
    if (this.closed) throw new BrowserHostError("BROWSER_MANAGER_CLOSED", "browser session manager is closed");
    if (this.host !== undefined) return this.host;
    if (this.starting !== undefined) return this.starting;
    this.starting = this.startHost();
    try {
      this.host = await this.starting;
      return this.host;
    } finally {
      this.starting = undefined;
    }
  }

  private async startHost(): Promise<HostConnection> {
    const electronPath = this.electronPath ??= resolvePackagedElectronPath();
    const token = createAuthToken();
    // No host is running here, so purged partition folders are free to go.
    await this.removePendingPartitions();
    const proxy = await this.ensureProxy();
    const processHandle = await this.launchHost({
      authToken: token,
      hostPath: this.hostPath,
      electronPath,
      downloadsRoot: this.downloadsRoot,
      userDataRoot: this.userDataRoot,
      proxyUrl: `http://${proxy.host}:${proxy.port}`,
      proxyToken: proxy.token,
      maxDownloadBytes: this.maxDownloadBytes,
    });
    this.startingProcess = processHandle;
    if (processHandle.stderr !== undefined && this.onHostStderr !== undefined) {
      processHandle.stderr.on("data", (chunk: unknown) => {
        try {
          this.onHostStderr?.(String(chunk));
        } catch {
          // Diagnostics must never affect the browser lifecycle.
        }
      });
    }
    if (this.closed) {
      processHandle.kill("SIGTERM");
      this.startingProcess = undefined;
      throw new BrowserHostError("BROWSER_MANAGER_CLOSED", "browser session manager is closed");
    }
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let readySettled = false;
    const ready = new Promise<void>((resolveReadyPromise, rejectReadyPromise) => {
      resolveReady = () => {
        if (!readySettled) {
          readySettled = true;
          resolveReadyPromise();
        }
      };
      rejectReady = (error) => {
        if (!readySettled) {
          readySettled = true;
          rejectReadyPromise(error);
        }
      };
    });
    const lines = createInterface({ input: processHandle.stdout });
    const connection: HostConnection = {
      process: processHandle,
      token,
      lines,
      ready,
      resolveReady,
      rejectReady,
      readyObserved: false,
      writeTail: Promise.resolve(),
    };
    lines.on("line", (line) => {
      // Electron on Windows emits one leading CRLF on stdout before the
      // application entrypoint runs. It carries no protocol data.
      if (line.length === 0) return;
      this.handleHostLine(connection, line);
    });
    processHandle.onExit((code, signal) => this.handleHostExit(connection, code, signal));
    const timeout = setTimeout(() => {
      connection.rejectReady(new BrowserHostError("BROWSER_HOST_NOT_READY", "browser host did not become ready"));
      processHandle.kill("SIGTERM");
    }, this.readyTimeoutMs);
    try {
      await ready;
      clearTimeout(timeout);
      return connection;
    } catch (error) {
      clearTimeout(timeout);
      lines.close();
      processHandle.kill("SIGTERM");
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      if (this.startingProcess === processHandle) this.startingProcess = undefined;
    }
  }

  private handleHostLine(connection: HostConnection, line: string): void {
    let message: BrowserHostMessage;
    try {
      message = parseBrowserHostMessage(line);
    } catch (error) {
      const protocolError = error instanceof Error ? error : new Error(String(error));
      connection.rejectReady(new BrowserHostError("BROWSER_PROTOCOL_ERROR", protocolError.message));
      // After ready, a malformed frame means the command stream can no longer
      // be trusted. Ending the host fails pending commands now instead of
      // leaving them to time out.
      if (connection.readyObserved) connection.process.kill("SIGTERM");
      return;
    }
    if (message.kind === "ready") {
      connection.readyObserved = true;
      connection.resolveReady();
      return;
    }
    if (message.kind === "event") {
      if (message.event === "download") this.handleDownloadEvent(message);
      else this.handleHandoffEvent(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    if (!message.ok) {
      this.settlePending(message.id, new BrowserHostError(message.error?.code ?? "BROWSER_HOST_ERROR", message.error?.message ?? "browser host command failed"));
      return;
    }
    if (message.result === undefined) {
      this.settlePending(message.id, new BrowserHostError("BROWSER_PROTOCOL_ERROR", "browser host response has no result"));
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.abortCleanup?.();
    this.releasePendingSlot(pending.state.agentId);
    pending.resolve(message.result);
  }

  private handleHostExit(connection: HostConnection, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.host === connection) {
      this.host = undefined;
      for (const lease of this.leases.values()) {
        lease.released = true;
      }
      this.leases.clear();
      this.clearLeaseSweepTimer();
    }
    const error = new BrowserHostError("BROWSER_HOST_EXITED", `browser host exited (${code ?? "signal"}${signal ? `/${signal}` : ""})`);
    connection.rejectReady(error);
    for (const [id, pending] of this.pending) {
      if (pending.host === connection) this.settlePending(id, error);
    }
  }

  private handleHandoffEvent(message: BrowserHostHandoffEvent): void {
    const state = [...this.leases.values()].find((lease) => lease.tabId === message.tabId && !lease.released);
    if (state === undefined) return;
    state.handoffActive = message.active;
    // The user takes as long as needed; the idle TTL restarts when they return.
    if (!message.active) state.expiresAt = this.now() + state.ttlMs;
    this.scheduleLeaseSweep();
  }

  private handleDownloadEvent(message: BrowserHostDownloadEvent): void {
    const state = [...this.leases.values()].find((lease) => lease.tabId === message.tabId);
    if (state === undefined) return;
    if (!isAbsolute(message.path) || message.path.includes("\0")) return;
    const candidate = resolve(message.path);
    const root = resolve(state.downloadRoot);
    if (!isPathWithin(root, candidate)) return;
    const event: BrowserDownloadEvent = {
      agentId: state.agentId,
      sessionId: state.sessionId,
      tabId: state.tabId,
      path: candidate,
      state: message.state ?? "completed",
      bytes: message.bytes ?? 0,
    };
    try {
      const result = this.onDownload?.(event);
      if (result !== undefined) {
        const observers = this.downloadObservers.get(state.agentId) ?? new Set<Promise<void>>();
        this.downloadObservers.set(state.agentId, observers);
        const observed = Promise.resolve(result).catch(() => undefined).finally(() => {
          observers.delete(observed);
          if (observers.size === 0) this.downloadObservers.delete(state.agentId);
        });
        observers.add(observed);
      }
    } catch {
      // Inventory/quota callbacks are observers; a callback failure cannot
      // corrupt browser lease state or make a completed download unsafe.
    }
  }

  private async ensureProxy(): Promise<EgressProxyAddress> {
    if (this.proxy.address !== null) return this.proxy.address;
    if (this.proxyStarting !== undefined) return this.proxyStarting;
    this.proxyStarting = this.proxy.start();
    try {
      return await this.proxyStarting;
    } finally {
      this.proxyStarting = undefined;
    }
  }

  private async resolveAgentDownloadRoot(agentId: string): Promise<string> {
    const raw = this.resolveDownloadRoot === undefined
      ? join(this.downloadsRoot, hashAgentId(agentId), "Downloads")
      : await this.resolveDownloadRoot(agentId);
    if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || !isAbsolute(raw)) {
      throw new BrowserHostError("BROWSER_DOWNLOAD_ROOT_INVALID", "download root resolver returned an invalid absolute path");
    }
    const candidate = resolve(raw);
    if (!isPathWithin(this.downloadsRoot, candidate)) {
      throw new BrowserHostError("BROWSER_DOWNLOAD_ROOT_INVALID", "download root is outside the managed browser root");
    }
    if (this.resolveDownloadRoot !== undefined && candidate.toLowerCase().split(/[\\/]/u).pop() !== "downloads") {
      throw new BrowserHostError("BROWSER_DOWNLOAD_ROOT_INVALID", "download root must point to the agent Downloads directory");
    }
    return candidate;
  }

  private async resolveAgentHomeRoot(agentId: string): Promise<string | undefined> {
    if (this.resolveHomeRoot === undefined) return undefined;
    const raw = await this.resolveHomeRoot(agentId);
    if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || !isAbsolute(raw)) {
      throw new BrowserHostError("BROWSER_HOME_ROOT_INVALID", "home root resolver returned an invalid absolute path");
    }
    return resolve(raw);
  }

  private getLease(lease: BrowserLeaseDescriptor | string): LeaseState {
    const leaseId = typeof lease === "string" ? lease : lease.leaseId;
    const state = this.leases.get(leaseId);
    if (state === undefined) throw new BrowserHostError("BROWSER_LEASE_NOT_FOUND", "browser lease was not found");
    return state;
  }

  private async assertLeaseActive(state: LeaseState): Promise<void> {
    if (state.released) {
      if (state.cleanup !== undefined) await state.cleanup;
      throw new BrowserHostError(
        state.expired === true ? "BROWSER_LEASE_EXPIRED" : "BROWSER_LEASE_NOT_FOUND",
        state.expired === true ? "browser lease has expired" : "browser lease is no longer active",
      );
    }
    if (state.handoffActive === true || this.now() < state.expiresAt) return;
    await this.beginLeaseCleanup(state, { expired: true });
    throw new BrowserHostError("BROWSER_LEASE_EXPIRED", "browser lease has expired");
  }

  private renewLease(state: LeaseState): void {
    state.expiresAt = this.now() + state.ttlMs;
    this.scheduleLeaseSweep();
  }

  private scheduleLeaseSweep(): void {
    this.clearLeaseSweepTimer();
    if (this.closed || this.leases.size === 0) return;
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const lease of this.leases.values()) {
      const due = this.sweepDueAt(lease);
      if (due !== undefined && due < nextExpiry) nextExpiry = due;
    }
    if (!Number.isFinite(nextExpiry)) return;
    const delay = Math.max(0, Math.min(nextExpiry - this.now(), 2_147_483_647));
    this.leaseSweepTimer = setTimeout(() => {
      this.leaseSweepTimer = undefined;
      void this.sweepExpiredLeases();
    }, delay);
  }

  private clearLeaseSweepTimer(): void {
    if (this.leaseSweepTimer === undefined) return;
    clearTimeout(this.leaseSweepTimer);
    this.leaseSweepTimer = undefined;
  }

  /** Expiry of an idle lease, or the retry time of a cleanup that failed. */
  private sweepDueAt(lease: LeaseState): number | undefined {
    if (!lease.released) return lease.handoffActive === true ? undefined : lease.expiresAt;
    return lease.cleanup === undefined ? lease.cleanupRetryAt : undefined;
  }

  private async sweepExpiredLeases(): Promise<void> {
    if (this.closed) return;
    const due = [...this.leases.values()].filter((lease) => {
      const at = this.sweepDueAt(lease);
      return at !== undefined && this.now() >= at;
    });
    await Promise.all(due.map((lease) => this.beginLeaseCleanup(lease, { expired: !lease.released }).catch(() => undefined)));
    this.scheduleLeaseSweep();
  }

  private async closeLease(state: LeaseState): Promise<BrowserCommandResult> {
    const result = await this.beginLeaseCleanup(state);
    if (result?.command === "close") return result as BrowserCommandResult;
    return { command: "close", tabId: state.tabId, visible: false };
  }

  private async beginLeaseCleanup(
    state: LeaseState,
    options: { expired?: boolean } = {},
  ): Promise<BrowserHostCommandResult | undefined> {
    if (state.cleanup !== undefined) return await state.cleanup;
    state.released = true;
    state.cleanupRetryAt = undefined;
    if (options.expired) state.expired = true;
    state.cleanup = this.cleanupLease(state);
    try {
      const result = await state.cleanup;
      this.leases.delete(state.leaseId);
      return result;
    } catch (error) {
      // Keep ownership and let the sweep retry; never hide a live tab.
      state.cleanup = undefined;
      state.cleanupRetryAt = this.now() + LEASE_CLEANUP_RETRY_MS;
      throw error;
    } finally {
      this.scheduleLeaseSweep();
    }
  }

  private async cleanupLease(state: LeaseState): Promise<BrowserHostCommandResult | undefined> {
    // Include launch reservations, not only commands already written to a pipe.
    if (this.starting !== undefined) await this.starting.catch(() => undefined);
    if (this.stopping !== undefined) await this.stopping;
    const host = this.host;
    if (host === undefined) return;

    try {
      return await this.sendCommand(state, { command: "close" }, host);
    } catch (error) {
      const lastLease = this.host === host && !this.hasActiveLeaseExcept(state);
      // A missing tab, or a host that exited with all its tabs, is already
      // clean. A shared-host close failure must propagate: resetting here
      // would erase cookies and application data.
      if (error instanceof BrowserHostError && (error.code === "BROWSER_TAB_NOT_FOUND" || error.code === "BROWSER_HOST_EXITED")) {
        return { command: "close", tabId: state.tabId, visible: false };
      }
      if (lastLease && error instanceof BrowserHostError && error.code === "BROWSER_COMMAND_TIMEOUT") {
        return { command: "close", tabId: state.tabId, visible: false };
      }
      throw error;
    } finally {
      // A released or expired final lease must not keep the shared host alive.
      if (this.host === host && !this.hasActiveLeaseExcept(state)) await this.stopHost();
    }
  }

  private hasActiveLeaseExcept(state: LeaseState): boolean {
    for (const lease of this.leases.values()) {
      if (lease !== state && !lease.released) return true;
    }
    return false;
  }

  private asPublicLease(state: LeaseState): BrowserLease {
    return {
      leaseId: state.leaseId,
      agentId: state.agentId,
      sessionId: state.sessionId,
      tabId: state.tabId,
      partition: state.partition,
      downloadRoot: state.downloadRoot,
      expiresAt: state.expiresAt,
      release: () => this.release(state),
    };
  }

  private partitionRootFor(agentId: string): string {
    return join(this.userDataRoot, "Partitions", `openbot-agent-${hashAgentId(agentId)}`);
  }

  private async purgeIdlePartitionCaches(): Promise<void> {
    const partitionsRoot = join(this.userDataRoot, "Partitions");
    if (!existsSync(partitionsRoot)) return;
    let children;
    try {
      children = await readdir(partitionsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const cacheSegments = [
      ["Cache"],
      ["Code Cache"],
      ["GPUCache"],
      ["DawnCache"],
      ["DawnGraphiteCache"],
      ["DawnWebGPUCache"],
      // Service Worker/CacheStorage is application data, not disposable cache.
    ] as const;
    await Promise.all(children.map(async (child) => {
      if (!child.isDirectory() || child.isSymbolicLink() || !child.name.startsWith("openbot-agent-")) return;
      const root = join(partitionsRoot, child.name);
      const targets = cacheSegments.map((segments) => join(root, ...segments));
      // Warm caches make the next session fast; drop them only when large.
      let total = 0;
      for (const target of targets) {
        total += await directorySize(target, this.maxPartitionCacheBytes - total + 1);
        if (total > this.maxPartitionCacheBytes) break;
      }
      if (total <= this.maxPartitionCacheBytes) return;
      await Promise.all(targets.map((target) => rm(target, { recursive: true, force: true }).catch(() => undefined)));
    }));
  }

  private async stopHost(): Promise<void> {
    if (this.stopping !== undefined) {
      await this.stopping;
      return;
    }
    const connection = this.host;
    if (connection === undefined) return;
    // Remove the connection from service before touching stdin. A concurrent
    // ensureHost/acquire must wait for onExit, then start a fresh pipe.
    this.host = undefined;
    let resolveStop!: () => void;
    let rejectStop!: (error: Error) => void;
    const exited = new Promise<void>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    // Keep host admission blocked through profile cleanup, not just process exit.
    const stopping = exited.then(async () => {
      await this.removePendingPartitions();
      await this.purgeIdlePartitionCaches().catch(() => undefined);
    });
    this.stopping = stopping;
    let exitObserved = false;
    try {
      let settled = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimeout: ReturnType<typeof setTimeout> | undefined;
      // A command timeout can be deliberately short (for example in a
      // teardown test), but it must not make stopHost return while the
      // process is still considered live. Give stdin shutdown a bounded
      // grace period, then force the process down before resolving.
      const gracefulStopMs = Math.max(100, Math.min(2_000, this.commandTimeoutMs));
      connection.process.onExit(() => {
        exitObserved = true;
        if (settled) {
          // A timeout must fence profile reuse until a late exit is proven.
          if (this.stopping === stopping) this.stopping = undefined;
          return;
        }
        settled = true;
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        if (hardTimeout !== undefined) clearTimeout(hardTimeout);
        resolveStop();
      });
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        connection.process.kill("SIGTERM");
      }, gracefulStopMs);
      hardTimeout = setTimeout(() => {
        if (settled) return;
        connection.process.kill("SIGTERM");
        settled = true;
        rejectStop(new BrowserHostError(
          "BROWSER_HOST_TEARDOWN_TIMEOUT",
          "browser host teardown could not prove process exit",
        ));
      }, gracefulStopMs + 1_000);
      try {
        connection.process.stdin.end();
      } catch {
        // The force-kill timer below is the final authority for a broken
        // command pipe; shutdown must remain bounded.
      }
      await stopping;
    } finally {
      if (exitObserved && this.stopping === stopping) this.stopping = undefined;
    }
  }
}

function defaultBrowserHostLauncher(options: BrowserHostLaunchOptions): Promise<BrowserHostProcess> {
  return launchBrowserHostWithPipe(options);
}

const BROWSER_HOST_ENV_ALLOWLIST = new Set([
  "APPDATA",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMSPEC",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XDG_RUNTIME_DIR",
]);

export interface BrowserHostEnvironmentOptions {
  authToken: string;
  commandPipe: string;
  downloadsRoot: string;
  maxDownloadBytes: number;
  proxyToken: string;
  proxyUrl: string;
  userDataRoot: string;
}

/** Build the complete child environment without inheriting provider or tool secrets. */
export function buildBrowserHostEnvironment(
  options: BrowserHostEnvironmentOptions,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && BROWSER_HOST_ENV_ALLOWLIST.has(key.toUpperCase())) environment[key] = value;
  }
  environment.OPENBOT_BROWSER_AUTH_TOKEN = options.authToken;
  environment.OPENBOT_BROWSER_USER_DATA_ROOT = options.userDataRoot;
  environment.OPENBOT_BROWSER_DOWNLOADS_ROOT = options.downloadsRoot;
  environment.OPENBOT_BROWSER_COMMAND_PIPE = options.commandPipe;
  environment.OPENBOT_BROWSER_PROXY_URL = options.proxyUrl;
  environment.OPENBOT_BROWSER_PROXY_TOKEN = options.proxyToken;
  environment.OPENBOT_BROWSER_MAX_DOWNLOAD_BYTES = String(options.maxDownloadBytes);
  return environment;
}

async function launchBrowserHostWithPipe(options: BrowserHostLaunchOptions): Promise<BrowserHostProcess> {
  const commandPipe = await createBrowserCommandPipe();
  const environment = buildBrowserHostEnvironment({ ...options, commandPipe: commandPipe.path });
  const javaScriptLauncher = isJavaScriptLauncher(options.electronPath);
  const launcher = javaScriptLauncher
    ? { command: process.execPath, args: [options.electronPath, options.hostPath] }
    : { command: options.electronPath, args: [options.hostPath] };
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(launcher.command, launcher.args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Only a console launcher needs hiding. For electron.exe (a GUI program)
      // SW_HIDE would override the first window it shows.
      windowsHide: javaScriptLauncher,
      env: environment,
    });
  } catch (error) {
    // Windows reports some invalid executables synchronously.
    await closeServer(commandPipe.server);
    throw new BrowserHostError("BROWSER_HOST_LAUNCH_FAILED", `browser host could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Spawn failures and early exits arrive as events; without these listeners
  // an 'error' event would be thrown in the gateway process.
  const launchFailure = new Promise<never>((_resolve, reject) => {
    child.once("error", (error) => {
      reject(new BrowserHostError("BROWSER_HOST_LAUNCH_FAILED", `browser host could not start: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      reject(new BrowserHostError("BROWSER_HOST_LAUNCH_FAILED", `browser host exited during launch (${code ?? signal ?? "unknown"})`));
    });
  });
  launchFailure.catch(() => undefined);
  let command: Socket;
  try {
    command = await waitForBrowserCommandPipe(Promise.race([commandPipe.connection, launchFailure]));
  } catch (error) {
    child.kill("SIGTERM");
    await closeServer(commandPipe.server);
    throw error;
  }
  command.on("error", () => undefined);
  child.stdout.on("error", () => undefined);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => undefined);
  child.stderr.on("error", () => undefined);
  return {
    stdin: {
      write: (chunk: string) => command.write(chunk),
      end: () => command.end(),
      once: (event, listener) => command.once(event, listener),
      removeListener: (event, listener) => command.removeListener(event, listener),
    },
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal) => child.kill(signal),
    onExit: (listener) => {
      child.once("exit", listener);
      child.once("error", () => listener(null, null));
    },
  };
}

function hashAgentId(agentId: string): string {
  return createHash("sha256").update(agentId, "utf8").digest("hex").slice(0, 32);
}

async function createBrowserCommandPipe(): Promise<{ path: string; server: Server; connection: Promise<Socket> }> {
  const path = `\\\\.\\pipe\\openbot-browser-${createHash("sha256").update(createAuthToken()).digest("hex").slice(0, 32)}`;
  const server = createServer();
  const connection = new Promise<Socket>((resolveConnection, rejectConnection) => {
    server.once("connection", (socket) => {
      void closeServer(server);
      resolveConnection(socket);
    });
    server.once("error", rejectConnection);
  });
  // A listen failure rejects both this and the listen promise below.
  connection.catch(() => undefined);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(path, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  return { path, server, connection };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });
}

/**
 * The packaged electron.exe itself, as `require("electron")` resolves it.
 * Launching node + electron/cli.js made electron.exe a grandchild that
 * survived when the manager killed the wrapper on Windows.
 */
function resolvePackagedElectronPath(): string {
  const configured = process.env.OPENBOT_BROWSER_ELECTRON_PATH?.trim();
  if (configured !== undefined && configured.length > 0) return resolveExplicitElectronPath(configured);
  const packageRoot = resolve(fileURLToPath(new URL("../../node_modules/electron/", import.meta.url)));
  const distRoot = join(packageRoot, "dist");
  let executable = "";
  try {
    executable = readFileSync(join(packageRoot, "path.txt"), "utf8").trim();
  } catch {
    // Reported below as a missing runtime.
  }
  const candidate = resolve(distRoot, executable);
  if (executable.length === 0 || candidate === distRoot || !isPathWithin(distRoot, candidate) || !existsSync(candidate)) {
    throw new BrowserHostError(
      "BROWSER_ELECTRON_NOT_INSTALLED",
      "local Electron runtime is missing; install the packaged electron dependency before using browser mode",
    );
  }
  return candidate;
}

function resolveExplicitElectronPath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw new BrowserHostError("BROWSER_ELECTRON_PATH_INVALID", "electronPath must be an absolute path");
  }
  const candidate = resolve(value);
  if (!existsSync(candidate)) {
    throw new BrowserHostError("BROWSER_ELECTRON_PATH_INVALID", "electronPath does not exist");
  }
  return candidate;
}

function isJavaScriptLauncher(value: string): boolean {
  const name = basename(value).toLowerCase();
  return name.endsWith(".js") || name.endsWith(".cjs") || name.endsWith(".mjs");
}

function assertAgentId(agentId: string): void {
  if (typeof agentId !== "string" || agentId.trim().length === 0 || Buffer.byteLength(agentId, "utf8") > MAX_AGENT_ID_BYTES) {
    throw new BrowserHostError("BROWSER_AGENT_ID_INVALID", "agentId is invalid");
  }
}

function assertIdentifier(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\r\n]/u.test(value)) {
    throw new BrowserHostError("BROWSER_IDENTIFIER_INVALID", `${name} is invalid`);
  }
}

function clampTimeout(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 1 || value > MAX_BROWSER_COMMAND_TIMEOUT_MS) {
    throw new Error(`${name} must be between 1 and ${MAX_BROWSER_COMMAND_TIMEOUT_MS}ms`);
  }
  return Math.floor(value);
}

function clampLeaseTtl(value: number): number {
  if (!Number.isFinite(value) || value < 1_000 || value > MAX_BROWSER_LEASE_TTL_MS) {
    throw new Error(`leaseTtlMs must be between 1000 and ${MAX_BROWSER_LEASE_TTL_MS}ms`);
  }
  return Math.floor(value);
}

function clampPendingLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error(`${name} must be between 1 and 10000`);
  }
  return value;
}

function browserAbortError(): BrowserHostError {
  return new BrowserHostError("BROWSER_COMMAND_ABORTED", "browser command was aborted");
}

async function raceWithBrowserAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) throw browserAbortError();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(browserAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function clampDownloadLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2 * 1024 * 1024 * 1024) {
    throw new Error("maxDownloadBytes must be between 1 and 2147483648");
  }
  return value;
}

/** Bytes under a directory, without following links; stops once above `stopAbove`. */
async function directorySize(root: string, stopAbove: number): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0 && total <= stopAbove) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(target);
      } else if (entry.isFile()) {
        total += await lstat(target).then((metadata) => metadata.size, () => 0);
        if (total > stopAbove) break;
      }
    }
  }
  return total;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation.length === 0 || (!relation.startsWith("..") && !isAbsolute(relation));
}

export { hashAgentId };
