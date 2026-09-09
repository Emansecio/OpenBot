import { stat } from "node:fs/promises";
import { win32 as path } from "node:path";

import {
  BrowserHostError,
  BrowserSessionManager,
  type BrowserLease,
} from "./browser-session-manager.js";
import {
  MAX_BROWSER_UPLOAD_BYTES,
  assertSafeBrowserUploadPath,
  type BrowserCommand,
  type BrowserCommandResult,
} from "./protocol.js";
import type {
  BrowserExecutionOperation,
  BrowserExecutionRequest,
  ExecutionBackend,
  ExecutionErrorCode,
  ExecutionRequest,
  ExecutionResult,
} from "../execution/contracts.js";
import { effectiveGrant, readSharedGrants } from "../execution/home-grants.js";
import { loadAgentVisibleUserMounts, resolveBrowserUploadTarget } from "../execution/user-files.js";
import { WorkspaceError } from "../execution/workspace.js";

export interface BrowserExecutionBackendOptions {
  /** Stable identity used for the partition, downloads and lease ownership. */
  agentId: string;
  /** Shared lazy browser host/session manager. */
  manager: BrowserSessionManager;
  /** Existing per-agent file/process backend, kept behind the same broker seam. */
  delegate?: ExecutionBackend;
  /** Alias for integrations that call the delegated backend `backend`. */
  backend?: ExecutionBackend;
  /** Canonical home root used to validate browser.upload before it reaches the host. */
  homeRoot?: string;
  /** When set, browser.upload can read the user's shared Desktop/Documents/Downloads folders. */
  userProfile?: string;
  sessionId?: string;
  ttlMs?: number;
}

interface LeaseAcquisition {
  pending: Promise<BrowserLease>;
  consumers: number;
  /** At least one consumer completed acquisition and can use the lease. */
  retainLease: boolean;
  lease?: BrowserLease;
  released?: boolean;
}

interface LeaseAccess {
  lease: BrowserLease;
  acquisition?: LeaseAcquisition;
}

interface LeaseConsumer {
  pending: Promise<LeaseAccess>;
  acquisition?: LeaseAcquisition;
}

/**
 * Per-agent execution facade for structured browser operations.
 *
 * Browser state is acquired lazily and reused for the lifetime of this
 * backend. Non-browser requests stay on the existing per-agent backend. The
 * model only sees the finite command set represented by BrowserExecutionRequest;
 * this class never accepts JavaScript, CDP, or an arbitrary host command.
 */
export class BrowserExecutionBackend implements ExecutionBackend {
  private readonly agentId: string;
  private readonly manager: BrowserSessionManager;
  private readonly delegate?: ExecutionBackend;
  private readonly sessionId?: string;
  private readonly ttlMs?: number;
  private readonly homeRoot?: string;
  private readonly userProfile?: string;
  private lease?: BrowserLease;
  private acquiringLease?: Promise<BrowserLease>;
  private leaseAcquisition?: LeaseAcquisition;
  /** Teardown is terminal for this per-agent backend. */
  private closing = false;
  private activeOperations = 0;
  private operationsDrained?: Promise<void>;
  private resolveOperationsDrained?: () => void;

  constructor(options: BrowserExecutionBackendOptions) {
    this.agentId = options.agentId;
    this.manager = options.manager;
    this.delegate = options.delegate ?? options.backend;
    this.sessionId = options.sessionId;
    this.ttlMs = options.ttlMs;
    this.homeRoot = options.homeRoot;
    this.userProfile = options.userProfile;
  }

  get activeLease(): BrowserLease | undefined {
    return this.lease;
  }

  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    // The delegated file/process runtime has its own lifecycle. It must not
    // hold the browser teardown barrier open when a non-browser operation is
    // already in flight.
    if (!isBrowserRequest(request)) {
      if (this.delegate !== undefined) return this.delegate.execute(request, signal);
      return {
        ok: false,
        operation: request.operation,
        code: "unsupported",
        message: "This backend has no delegated non-browser executor.",
      };
    }
    if (this.closing) return backendClosing(request.operation);
    this.activeOperations += 1;
    try {
      return await this.executeBrowser(request, signal);
    } finally {
      this.activeOperations -= 1;
      if (this.closing && this.activeOperations === 0) this.resolveOperationsDrained?.();
    }
  }

  /** Releases every browser lease owned by this agent, including stale state. */
  async teardown(): Promise<void> {
    if (this.teardownPromise !== undefined) return this.teardownPromise;
    this.closing = true;
    this.teardownPromise = (async () => {
      await this.waitForOperations();
      // The operation drain includes ref-counted lease consumers, including
      // any release that completes after teardown began. Keep this second
      // await as a defensive invariant if a future acquisition path is added.
      const pending = this.acquiringLease;
      if (pending !== undefined) await pending.catch(() => undefined);
      this.clearLeaseReference();
      await this.manager.teardownAgent(this.agentId);
    })();
    return this.teardownPromise;
  }

  close(): Promise<void> {
    return this.teardown();
  }

  private teardownPromise?: Promise<void>;

  private async waitForOperations(): Promise<void> {
    if (this.activeOperations === 0) return;
    if (this.operationsDrained === undefined) {
      this.operationsDrained = new Promise<void>((resolve) => {
        this.resolveOperationsDrained = resolve;
      });
    }
    await this.operationsDrained;
  }

  private async executeBrowser(request: BrowserExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    if (signal?.aborted) return aborted(request.operation);

    let uploadTarget: { root: string; path: string } | undefined;
    if (request.operation === "browser.upload") {
      try {
        uploadTarget = await validateUploadFile(this.homeRoot, request.path, this.agentId, this.userProfile);
      } catch (error) {
        return browserFailure(request.operation, error);
      }
    }

    // close is idempotent and must not launch the shared host merely to close
    // a session that was never opened.
    if (request.operation === "browser.close" && this.lease === undefined) {
      return {
        ok: true,
        operation: request.operation,
        command: "close",
        tabId: "",
        visible: false,
      };
    }

    let consumer: LeaseConsumer;
    try {
      consumer = this.beginLeaseConsumer();
    } catch (error) {
      return browserFailure(request.operation, error);
    }
    let lease: BrowserLease;
    try {
      lease = (await consumer.pending).lease;
    } catch (error) {
      if (consumer.acquisition !== undefined) await this.finishLeaseConsumer(consumer.acquisition, false);
      return browserFailure(request.operation, error);
    }

    // The manager deliberately does not take an AbortSignal for lease
    // acquisition. Re-check after that await so an abort cannot leave a
    // lease published after the caller has already given up.
    if (signal?.aborted) {
      if (consumer.acquisition !== undefined) await this.finishLeaseConsumer(consumer.acquisition, false);
      return aborted(request.operation);
    }

    // One aborted waiter must not tear down a lease shared by another waiter.
    // Once any consumer has reached the command stage, retain the lease for
    // subsequent operations just as for a non-concurrent acquisition.
    if (consumer.acquisition !== undefined) await this.finishLeaseConsumer(consumer.acquisition, true);

    try {
      const command = toBrowserCommand(request);
      const uploadCommand = uploadTarget !== undefined && command.command === "upload"
        ? { ...command, path: uploadTarget.path }
        : command;
      const result = await this.manager.execute(
        lease,
        uploadCommand,
        signal,
        uploadTarget === undefined ? undefined : { homeRoot: uploadTarget.root },
      );
      if (request.operation === "browser.close") this.clearLeaseReference();
      if (signal?.aborted) return aborted(request.operation);
      return browserSuccess(request.operation, result);
    } catch (error) {
      if (isAbortFailure(error) || signal?.aborted) return aborted(request.operation);
      if (isLeaseFailure(error)) this.clearLeaseReference();
      if (request.operation === "browser.close") {
        this.clearLeaseReference();
        await this.manager.release(lease);
      }
      return browserFailure(request.operation, error);
    }
  }

  private beginLeaseConsumer(): LeaseConsumer {
    if (this.closing) {
      throw new BrowserHostError("BROWSER_MANAGER_CLOSED", "browser backend is closing");
    }
    let acquisition = this.leaseAcquisition;
    if (acquisition !== undefined) {
      // Keep late joiners in the same ref-counted acquisition window even
      // after the promise has fulfilled but before its earlier consumers have
      // released their ownership tokens.
      acquisition.consumers += 1;
    } else if (this.lease !== undefined && this.manager.hasLease(this.lease)) {
      return { pending: Promise.resolve({ lease: this.lease }) };
    } else {
      const requested = {
        agentId: this.agentId,
        ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
        ...(this.ttlMs === undefined ? {} : { ttlMs: this.ttlMs }),
      };
      acquisition = {
        pending: Promise.resolve(undefined as unknown as BrowserLease),
        consumers: 1,
        retainLease: false,
      };
      this.leaseAcquisition = acquisition;
      const pending = this.startLeaseAcquisition(acquisition, requested);
      acquisition.pending = pending;
      this.acquiringLease = pending;
      void pending.then(
        () => {
          if (this.acquiringLease === pending) this.acquiringLease = undefined;
        },
        () => {
          if (this.acquiringLease === pending) this.acquiringLease = undefined;
        },
      );
    }

    const sharedAcquisition = acquisition;
    return {
      acquisition: sharedAcquisition,
      pending: sharedAcquisition.pending.then((lease) => ({ lease, acquisition: sharedAcquisition })),
    };
  }

  private async startLeaseAcquisition(
    acquisition: LeaseAcquisition,
    requested: { agentId: string; sessionId?: string; ttlMs?: number },
  ): Promise<BrowserLease> {
    const lease = await this.manager.acquire(requested);
    if (this.closing || this.leaseAcquisition !== acquisition || acquisition.released) {
      // Teardown may have started while the manager was resolving the
      // per-agent paths. Never publish a lease after the close barrier.
      await this.manager.release(lease).catch(() => undefined);
      throw new BrowserHostError("BROWSER_MANAGER_CLOSED", "browser backend is closing");
    }
    acquisition.lease = lease;
    this.lease = lease;
    return lease;
  }

  private async finishLeaseConsumer(acquisition: LeaseAcquisition, retainLease: boolean): Promise<void> {
    if (acquisition.consumers <= 0) return;
    if (retainLease) acquisition.retainLease = true;
    acquisition.consumers -= 1;
    if (acquisition.consumers !== 0) return;

    if (this.leaseAcquisition === acquisition) this.leaseAcquisition = undefined;
    if (acquisition.retainLease || acquisition.lease === undefined || this.lease !== acquisition.lease) return;

    acquisition.released = true;
    const lease = acquisition.lease;
    this.clearLeaseReference();
    await this.manager.release(lease).catch(() => undefined);
  }

  private clearLeaseReference(): void {
    this.lease = undefined;
    this.acquiringLease = undefined;
  }
}

function backendClosing(operation: ExecutionRequest["operation"]): ExecutionResult {
  return {
    ok: false,
    operation,
    code: "runtime_unavailable",
    message: "The per-agent browser backend is closing.",
  };
}

function isBrowserRequest(request: ExecutionRequest): request is BrowserExecutionRequest {
  return request.operation.startsWith("browser.");
}

function toBrowserCommand(request: BrowserExecutionRequest): BrowserCommand {
  switch (request.operation) {
    case "browser.open":
      return { command: "open", ...(request.url === undefined ? {} : { url: request.url }) };
    case "browser.navigate":
      return { command: "navigate", url: request.url };
    case "browser.snapshot":
      return { command: "snapshot", ...(request.includeText === undefined ? {} : { includeText: request.includeText }) };
    case "browser.click":
      return {
        command: "click",
        x: request.x,
        y: request.y,
        ...(request.button === undefined ? {} : { button: request.button }),
        ...(request.clickCount === undefined ? {} : { clickCount: request.clickCount }),
      };
    case "browser.click_element":
      return { command: "click_element", elementId: request.elementId };
    case "browser.scroll":
      return { command: "scroll", deltaX: request.deltaX, deltaY: request.deltaY };
    case "browser.press_key":
      return { command: "press_key", key: request.key };
    case "browser.type":
      return { command: "type", text: request.text };
    case "browser.upload":
      return { command: "upload", selector: request.selector, path: request.path };
    case "browser.screenshot":
      return { command: "screenshot", ...(request.fullPage === undefined ? {} : { fullPage: request.fullPage }) };
    case "browser.close":
      return { command: "close" };
    case "browser.handoff":
      return { command: "handoff" };
  }
}

function browserSuccess(operation: BrowserExecutionOperation, result: BrowserCommandResult): ExecutionResult {
  return { ok: true, operation, ...result };
}

function aborted(operation: BrowserExecutionOperation): ExecutionResult {
  return {
    ok: false,
    operation,
    code: "aborted",
    message: "Browser operation was aborted.",
  };
}

function browserFailure(operation: BrowserExecutionOperation, error: unknown): ExecutionResult {
  const message = error instanceof Error ? error.message : "Browser operation failed.";
  return {
    ok: false,
    operation,
    code: browserErrorCode(error),
    message,
  };
}

function browserErrorCode(error: unknown): ExecutionErrorCode {
  const code = error instanceof BrowserHostError ? error.code : undefined;
  if (code === "BROWSER_LEASE_EXPIRED") return "lease_expired";
  if (code === "BROWSER_COMMAND_TIMEOUT" || code === "BROWSER_NAVIGATION_TIMEOUT") return "timed_out";
  if (code === "BROWSER_COMMAND_ABORTED") return "aborted";
  if (code === "BROWSER_MANAGER_CLOSED" || code === "BROWSER_HOST_NOT_READY" || code === "BROWSER_HOST_EXITED") return "runtime_unavailable";
  if (code === "BROWSER_PROTOCOL_ERROR") return "runtime_protocol_error";
  if (code === "BROWSER_TAB_FORBIDDEN" || code === "BROWSER_UNAUTHORIZED") return "permission_denied";
  if (code === "BROWSER_UPLOAD_FILE_NOT_FOUND") return "not_found";
  if (code === "BROWSER_UPLOAD_ACCESS_DENIED") return "permission_denied";
  if (code === "BROWSER_UPLOAD_FILE_TOO_LARGE") return "output_limit";
  if (code?.startsWith("BROWSER_UPLOAD_")) return "invalid_request";
  if (code?.startsWith("BROWSER_URL_") || code === "BROWSER_COORDINATES_INVALID" || code === "BROWSER_COMMAND_INVALID") return "invalid_request";
  return "io_error";
}

function isAbortFailure(error: unknown): boolean {
  return error instanceof BrowserHostError && error.code === "BROWSER_COMMAND_ABORTED";
}

async function validateUploadFile(
  homeRoot: string | undefined,
  relativePath: string,
  agentId: string,
  userProfile?: string,
): Promise<{ root: string; path: string }> {
  if (homeRoot === undefined) {
    throw new BrowserHostError("BROWSER_UPLOAD_HOME_UNAVAILABLE", "browser upload home is unavailable");
  }
  try {
    assertSafeBrowserUploadPath(relativePath.replace(/^shared:\/\//iu, ""));
    const overlay = userProfile !== undefined && /^shared:\/\//iu.test(relativePath);
    const grants = overlay ? await readSharedGrants(homeRoot) : undefined;
    const mounts = userProfile !== undefined && grants !== undefined
      ? await loadAgentVisibleUserMounts(userProfile, agentId, (name) => effectiveGrant(grants, name))
      : new Map();
    const target = await resolveBrowserUploadTarget(homeRoot, relativePath, mounts);
    const candidate = path.join(target.root, target.path);
    const metadata = await stat(candidate);
    if (!metadata.isFile()) {
      throw new BrowserHostError("BROWSER_UPLOAD_PATH_INVALID", "browser upload path is not a regular file");
    }
    if (!Number.isSafeInteger(metadata.size) || metadata.size > MAX_BROWSER_UPLOAD_BYTES) {
      throw new BrowserHostError("BROWSER_UPLOAD_FILE_TOO_LARGE", "browser upload file exceeds the byte limit");
    }
    return target;
  } catch (error) {
    if (error instanceof BrowserHostError) throw error;
    if (error instanceof WorkspaceError && error.code === "not_found") {
      throw new BrowserHostError("BROWSER_UPLOAD_FILE_NOT_FOUND", "browser upload file was not found");
    }
    if (error instanceof WorkspaceError && error.code === "access_denied") {
      throw new BrowserHostError("BROWSER_UPLOAD_ACCESS_DENIED", "browser upload folder is not granted or unavailable");
    }
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new BrowserHostError("BROWSER_UPLOAD_FILE_NOT_FOUND", "browser upload file was not found");
    }
    throw new BrowserHostError("BROWSER_UPLOAD_PATH_INVALID", "browser upload path is invalid or unsafe");
  }
}

function isLeaseFailure(error: unknown): boolean {
  return error instanceof BrowserHostError && (
    error.code === "BROWSER_LEASE_EXPIRED" ||
    error.code === "BROWSER_LEASE_NOT_FOUND" ||
    error.code === "BROWSER_TAB_NOT_FOUND"
  );
}
