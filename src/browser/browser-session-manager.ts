import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import {
  EgressProxy,
  type EgressProxyAddress,
  type EgressProxyOptions,
} from "./egress-proxy.js";

import {
  assertSafeBrowserUrl,
  createAuthToken,
  createRequestId,
  encodeBrowserFrame,
  parseBrowserHostMessage,
  validateBrowserCommand,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserHostCommandResult,
  type BrowserHostMessage,
  type BrowserHostRequest,
  type BrowserInternalCommand,
  type BrowserLeaseDescriptor,
} from "./protocol.js";

export const DEFAULT_BROWSER_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_BROWSER_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_BROWSER_LEASE_TTL_MS = 15 * 60_000;
export const MAX_BROWSER_LEASE_TTL_MS = 24 * 60 * 60_000;
export const DEFAULT_BROWSER_MAX_PENDING_REQUESTS = 256;
export const DEFAULT_BROWSER_MAX_PENDING_PER_AGENT = 32;
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
  downloadsRoot?: string;
  /** Managed Electron userData/profile root, outside every agent home. */
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
  released: boolean;
  expired?: boolean;
  cleanup?: Promise<BrowserHostCommandResult | undefined>;
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
  readySettled: boolean;
  writeTail: Promise<void>;
}

/**
 * Owns one lazy, authenticated browser host and all per-agent browser leases.
 * The host is intentionally a single process: idle agents do not retain an
 * Electron process, while each agent keeps a persistent Electron partition.
 */
export class BrowserSessionManager {
  private readonly downloadsRoot?: string;
  private readonly userDataRoot: string;
  private readonly resolveDownloadRoot?: (agentId: string) => string | Promise<string>;
  private readonly resolveHomeRoot?: (agentId: string) => string | Promise<string>;
  private readonly hostPath: string;
  private readonly electronPath: string;
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
  private closed = false;

  constructor(options: BrowserSessionManagerOptions) {
    if ((options.downloadsRoot === undefined || options.downloadsRoot.length === 0) && options.resolveDownloadRoot === undefined) {
      throw new Error("downloadsRoot or resolveDownloadRoot is required");
    }
    this.downloadsRoot = options.downloadsRoot === undefined ? undefined : resolve(options.downloadsRoot);
    const userDataRoot = options.userDataRoot ?? join(this.downloadsRoot ?? resolve("."), ".browser-user-data");
    if (!isAbsolute(userDataRoot)) throw new BrowserHostError("BROWSER_USER_DATA_ROOT_INVALID", "userDataRoot must be absolute");
    this.userDataRoot = resolve(userDataRoot);
    this.resolveDownloadRoot = options.resolveDownloadRoot;
    this.resolveHomeRoot = options.resolveHomeRoot;
    this.hostPath = options.hostPath ?? fileURLToPath(new URL("../../scripts/openbot-browser-host.cjs", import.meta.url));
    this.electronPath = options.electronPath === undefined
      ? resolvePackagedElectronCliPath()
      : resolveExplicitElectronPath(options.electronPath);
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
    const teardown = this.agentTeardowns.get(agentId);
    if (teardown !== undefined) await teardown;
    const stopping = this.stopping;
    if (stopping !== undefined) await stopping;
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
    const stoppingAfterRoots = this.stopping;
    if (stoppingAfterRoots !== undefined) await stoppingAfterRoots;
    const teardownAfterRoots = this.agentTeardowns.get(agentId);
    if (teardownAfterRoots !== undefined) await teardownAfterRoots;
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
      released: false,
    };
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
    if (safeCommand.command === "navigate") {
      assertSafeBrowserUrl(safeCommand.url);
    }
    if (safeCommand.command === "close") return await this.closeLease(state, signal);
    return await this.sendCommand(state, safeCommand, undefined, signal, options?.homeRoot) as BrowserCommandResult;
  }

  run(lease: BrowserLeaseDescriptor | string, command: BrowserCommand, signal?: AbortSignal): Promise<BrowserCommandResult> {
    return this.execute(lease, command, signal);
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
    if (state.released) {
      if (state.cleanup !== undefined) await state.cleanup;
      return;
    }
    await this.beginLeaseCleanup(state);
  }

  async teardownAgent(agentId: string): Promise<void> {
    assertAgentId(agentId);
    const existing = this.agentTeardowns.get(agentId);
    if (existing !== undefined) return existing;
    const teardown = this.performAgentTeardown(agentId);
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

  private async performAgentTeardown(agentId: string): Promise<void> {
    const owned = [...this.leases.values()].filter((lease) => lease.agentId === agentId);
    await Promise.all(owned.map((lease) => this.release(lease)));
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
        released: false,
      };
      await this.sendCommand(state, { command: "reset" }, this.host);
      return;
    }
    await this.removePartitionRoot(agentId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
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
    this.reservePendingSlot(state.agentId);
    try {
      const host = existingHost ?? await raceWithBrowserAbort(this.ensureHost(), signal);
      if (signal?.aborted) throw browserAbortError();
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
    const token = createAuthToken();
    const proxy = await this.ensureProxy();
    const processHandle = await this.launchHost({
      authToken: token,
      hostPath: this.hostPath,
      electronPath: this.electronPath,
      downloadsRoot: this.downloadsRoot ?? resolve("."),
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
      readySettled,
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
      return;
    }
    if (message.kind === "ready") {
      connection.resolveReady();
      return;
    }
    if (message.kind === "event") {
      if (message.event === "download") this.handleDownloadEvent(message);
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

  private handleDownloadEvent(message: Extract<BrowserHostMessage, { kind: "event" }>): void {
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
      if (result !== undefined && typeof (result).catch === "function") void (result).catch(() => undefined);
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
      ? join(this.downloadsRoot!, hashAgentId(agentId), "Downloads")
      : await this.resolveDownloadRoot(agentId);
    if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || !isAbsolute(raw)) {
      throw new BrowserHostError("BROWSER_DOWNLOAD_ROOT_INVALID", "download root resolver returned an invalid absolute path");
    }
    const candidate = resolve(raw);
    if (this.downloadsRoot !== undefined) {
      const base = resolve(this.downloadsRoot);
      if (!isPathWithin(base, candidate)) {
        throw new BrowserHostError("BROWSER_DOWNLOAD_ROOT_INVALID", "download root is outside the managed browser root");
      }
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
    if (this.now() < state.expiresAt) return;
    await this.beginLeaseCleanup(state, { expired: true });
    throw new BrowserHostError("BROWSER_LEASE_EXPIRED", "browser lease has expired");
  }

  private scheduleLeaseSweep(): void {
    this.clearLeaseSweepTimer();
    if (this.closed || this.leases.size === 0) return;
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const lease of this.leases.values()) {
      if (!lease.released && lease.expiresAt < nextExpiry) nextExpiry = lease.expiresAt;
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

  private async sweepExpiredLeases(): Promise<void> {
    if (this.closed) return;
    const expired = [...this.leases.values()].filter((lease) => !lease.released && this.now() >= lease.expiresAt);
    await Promise.all(expired.map((lease) => this.beginLeaseCleanup(lease, { expired: true }).catch(() => undefined)));
    this.scheduleLeaseSweep();
  }

  private async closeLease(state: LeaseState, signal?: AbortSignal): Promise<BrowserCommandResult> {
    const result = await this.beginLeaseCleanup(state, { signal });
    if (result?.command === "close") return result as BrowserCommandResult;
    return { command: "close", tabId: state.tabId, visible: false };
  }

  private async beginLeaseCleanup(
    state: LeaseState,
    options: { expired?: boolean; signal?: AbortSignal } = {},
  ): Promise<BrowserHostCommandResult | undefined> {
    if (state.cleanup !== undefined) return await state.cleanup;
    state.released = true;
    if (options.expired) state.expired = true;
    state.cleanup = this.cleanupLease(state, options.signal);
    try {
      return await state.cleanup;
    } finally {
      this.leases.delete(state.leaseId);
      this.scheduleLeaseSweep();
    }
  }

  private async cleanupLease(state: LeaseState, signal?: AbortSignal): Promise<BrowserHostCommandResult | undefined> {
    const host = this.host;
    if (host === undefined) return;

    try {
      return await this.sendCommand(state, { command: "close" }, host, signal);
    } catch (error) {
      const lastLease = this.host === host && !this.hasActiveLeaseExcept(state);
      // A missing tab is already clean. For a live shared host, reset only
      // this lease's partition as a bounded fallback; other agents keep
      // their tabs and the shared host remains available.
      if (error instanceof BrowserHostError && error.code === "BROWSER_TAB_NOT_FOUND") {
        return { command: "close", tabId: state.tabId, visible: false };
      }
      if (this.host === host && this.hasActiveLeaseExcept(state)) {
        try {
          await this.sendCommand(state, { command: "reset" }, host, signal);
          return { command: "close", tabId: state.tabId, visible: false };
        } catch (resetError) {
          throw resetError instanceof Error ? resetError : error;
        }
      }
      if (
        lastLease &&
        error instanceof BrowserHostError &&
        (error.code === "BROWSER_COMMAND_TIMEOUT" || error.code === "BROWSER_HOST_EXITED")
      ) {
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
      ["Service Worker", "CacheStorage"],
    ] as const;
    await Promise.all(children.map(async (child) => {
      if (!child.isDirectory() || child.isSymbolicLink() || !child.name.startsWith("openbot-agent-")) return;
      const root = join(partitionsRoot, child.name);
      await Promise.all(cacheSegments.map((segments) =>
        rm(join(root, ...segments), { recursive: true, force: true }).catch(() => undefined)));
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
    const stopping = new Promise<void>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    this.stopping = stopping;
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
        if (settled) return;
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
      void this.purgeIdlePartitionCaches().catch(() => undefined);
    } finally {
      if (this.stopping === stopping) this.stopping = undefined;
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
  const launcher = isJavaScriptLauncher(options.electronPath)
    ? { command: process.execPath, args: [options.electronPath, options.hostPath] }
    : { command: options.electronPath, args: [options.hostPath] };
  const child = spawn(launcher.command, launcher.args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: environment,
  });
  let command: Socket;
  try {
    command = await waitForBrowserCommandPipe(commandPipe.connection);
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

function resolvePackagedElectronCliPath(): string {
  const configured = process.env.OPENBOT_BROWSER_ELECTRON_PATH?.trim();
  if (configured !== undefined && configured.length > 0) return resolveExplicitElectronPath(configured);
  const candidate = resolve(fileURLToPath(new URL("../../node_modules/electron/cli.js", import.meta.url)));
  if (!existsSync(candidate)) {
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

function isPathWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation.length === 0 || (!relation.startsWith("..") && !isAbsolute(relation));
}

export { hashAgentId };
