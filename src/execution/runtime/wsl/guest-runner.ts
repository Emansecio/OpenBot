import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { win32 as path } from "node:path";

import type { ExecutionErrorCode, ExecutionResult } from "../../contracts.js";
import type {
  ProcessRunRequest,
  RuntimeBoot,
  RuntimeDriverLease,
  RuntimeHealth,
  RuntimeLeaseRequest,
  RuntimeLease,
  StopReason,
} from "../contracts.js";
import { RuntimeManagerError } from "../manager.js";
import { capabilityDigest } from "../policy.js";
import { encodeRuntimeFrame, type RuntimeFrame } from "./transport.js";
import { validateRuntimeDistroName, type WslSupervisorTransport } from "./adapter.js";
import { GuestUserProvisioner, isValidGuestUserName } from "./guest-users.js";
import {
  classifyWslDistroTermination,
  MAX_WSL_OUTPUT_BYTES,
  type WslCommandRunner,
  type WslCommandResult,
} from "./provisioner.js";

const DEFAULT_DISTRO = "OpenBotRuntime";
const DEFAULT_SUPERVISOR = "/usr/lib/openbot/supervisor";
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const START_RETRY_DELAYS_MS = [100, 250, 500] as const;
const RELEASE_RETRY_DELAYS_MS = [100, 250, 500] as const;
const EMPTY_POLICY_DIGEST = "0".repeat(64);
const SAFE_RUNTIME_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

type RecordValue = Record<string, unknown>;

const asRecord = (value: unknown, message: string): RecordValue => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RuntimeManagerError("runtime_protocol_error", message);
  return value as RecordValue;
};

const parseJsonRecord = (output: Buffer): RecordValue => {
  if (output.byteLength > MAX_WSL_OUTPUT_BYTES) throw new RuntimeManagerError("runtime_protocol_error", "Runtime supervisor response is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.toString("utf8"));
  } catch {
    throw new RuntimeManagerError("runtime_protocol_error", "Runtime supervisor response is invalid.");
  }
  return asRecord(parsed, "Runtime supervisor response is invalid.");
};

const assertGuestAcknowledged = (response: RecordValue, message: string): void => {
  if (response.ok === true) return;
  const error = new RuntimeManagerError("runtime_unhealthy", message);
  if (response.ok === false && typeof response.code === "string") {
    Object.assign(error, { guestCode: response.code });
  }
  throw error;
};

const parseBoot = (output: Buffer): RuntimeBoot => {
  const record = parseJsonRecord(output);
  if (record.ok === false && typeof record.code === "string" && typeof record.message === "string") {
    const error = new RuntimeManagerError("runtime_unhealthy", "Runtime supervisor start failed.");
    Object.assign(error, { guestCode: record.code });
    throw error;
  }
  if (
    typeof record.runtimeBootId !== "string" || !SAFE_RUNTIME_IDENTIFIER.test(record.runtimeBootId) ||
    typeof record.runtimeVersion !== "string" || record.runtimeVersion.length === 0 ||
    typeof record.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(record.imageDigest)
  ) throw new RuntimeManagerError("runtime_protocol_error", "Runtime supervisor boot identity is invalid.");
  return {
    runtimeBootId: record.runtimeBootId,
    runtimeVersion: record.runtimeVersion,
    imageDigest: record.imageDigest,
  };
};

const retryableTeardownError = (error: unknown): boolean =>
  error instanceof RuntimeManagerError &&
  (error as RuntimeManagerError & { guestCode?: string }).guestCode === "teardown_incomplete";

const waitForRetry = (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(new Error("wsl command was aborted"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("wsl command was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

const parseExecutionResult = (output: Buffer): ExecutionResult => {
  const record = parseJsonRecord(output);
  if (record.ok === false) {
    if (
      record.operation !== "process.run" || typeof record.code !== "string" ||
      typeof record.message !== "string"
    ) throw new RuntimeManagerError("runtime_protocol_error", "Runtime supervisor process error is invalid.");
    return {
      ok: false,
      operation: "process.run",
      code: record.code as ExecutionErrorCode,
      message: record.message,
    };
  }
  if (
    record.ok !== true || record.operation !== "process.run" ||
    typeof record.stdout !== "string" || typeof record.stderr !== "string" ||
    (typeof record.exitCode !== "number" && record.exitCode !== null) ||
    typeof record.durationMs !== "number" || !Number.isSafeInteger(record.durationMs) || record.durationMs < 0 ||
    typeof record.stdoutTruncated !== "boolean" || typeof record.stderrTruncated !== "boolean" ||
    (record.signal !== undefined && typeof record.signal !== "string")
  ) throw new RuntimeManagerError("runtime_protocol_error", "Runtime supervisor process result is invalid.");
  return {
    ok: true,
    operation: "process.run",
    stdout: record.stdout,
    stderr: record.stderr,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    stdoutTruncated: record.stdoutTruncated,
    stderrTruncated: record.stderrTruncated,
    ...(record.signal === undefined ? {} : { signal: record.signal }),
  };
};

const samePath = (left: string, right: string): boolean =>
  path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();

const invalidWorkspace = (message: string): RuntimeManagerError =>
  new RuntimeManagerError("runtime_protocol_error", message);

const validateAbsoluteWorkspacePath = (value: string, message: string): string => {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    value.startsWith("\\\\") || !path.isAbsolute(value) ||
    value.split(/[\\/]/u).some((part) => part === "..")
  ) throw invalidWorkspace(message);
  return path.normalize(value);
};

const assertNoReparsePoints = async (candidate: string): Promise<void> => {
  const volumeRoot = path.parse(candidate).root;
  let current = volumeRoot;
  for (const segment of path.relative(volumeRoot, candidate).split("\\")) {
    if (segment.length === 0) continue;
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      throw invalidWorkspace("Runtime workspace path cannot be verified.");
    }
    if (metadata.isSymbolicLink()) {
      throw invalidWorkspace("Runtime workspace path contains a junction or reparse point.");
    }
    try {
      if (!samePath(await realpath(current), current)) {
        throw invalidWorkspace("Runtime workspace path contains a junction or reparse point.");
      }
    } catch (error) {
      if (error instanceof RuntimeManagerError) throw error;
      throw invalidWorkspace("Runtime workspace path cannot be verified.");
    }
  }
};

const validateWorkspaceRoot = async (
  workspaceRoot: string,
  agentId: string,
  managedWorkspacesRoot: string | undefined,
): Promise<string> => {
  if (managedWorkspacesRoot === undefined) {
    throw invalidWorkspace("Managed runtime workspace root is not configured.");
  }
  if (
    typeof agentId !== "string" || agentId.length === 0 || agentId.includes("\0") ||
    agentId.includes("\\") || agentId.includes("/") || agentId === "." || agentId === ".."
  ) {
    throw invalidWorkspace("Runtime agent identity is invalid.");
  }

  const checkedManagedRoot = validateAbsoluteWorkspacePath(
    managedWorkspacesRoot,
    "Managed runtime workspace root is invalid.",
  );
  const checkedWorkspaceRoot = validateAbsoluteWorkspacePath(
    workspaceRoot,
    "Runtime workspace path is invalid.",
  );
  const expectedWorkspaceRoot = path.join(checkedManagedRoot, agentId);
  if (!samePath(checkedWorkspaceRoot, expectedWorkspaceRoot)) {
    throw invalidWorkspace("Runtime workspace does not match the managed agent home.");
  }

  // Verify every component before resolving either path. This rejects
  // junctions/reparse points instead of trusting their basename or following
  // them to a path outside the managed homes tree.
  await assertNoReparsePoints(checkedManagedRoot);
  await assertNoReparsePoints(checkedWorkspaceRoot);
  let canonicalManagedRoot: string;
  let canonicalWorkspaceRoot: string;
  try {
    canonicalManagedRoot = await realpath(checkedManagedRoot);
    canonicalWorkspaceRoot = await realpath(checkedWorkspaceRoot);
  } catch {
    throw invalidWorkspace("Runtime workspace path cannot be verified.");
  }
  const expectedCanonicalRoot = path.join(canonicalManagedRoot, agentId);
  if (!samePath(canonicalWorkspaceRoot, expectedCanonicalRoot)) {
    throw invalidWorkspace("Runtime workspace is outside the managed agent home.");
  }
  return canonicalWorkspaceRoot;
};

export interface WslGuestClientOptions {
  runner: WslCommandRunner;
  distroName?: string;
  supervisorPath?: string;
  /** Canonical host root that owns all managed agent homes. */
  managedWorkspacesRoot?: string;
  stopTimeoutMs?: number;
  /** Override for tests; defaults to a real GuestUserProvisioner. */
  guestUserProvisioner?: Pick<GuestUserProvisioner, "ensure">;
}

export class WslGuestClient implements WslSupervisorTransport {
  private readonly runner: WslCommandRunner;
  private readonly distroName: string;
  private readonly supervisorPath: string;
  private readonly managedWorkspacesRoot?: string;
  private readonly stopTimeoutMs: number;
  private readonly guestUsers: Pick<GuestUserProvisioner, "ensure">;
  private activeBoot: RuntimeBoot | null = null;

  constructor(options: WslGuestClientOptions) {
    this.runner = options.runner;
    this.distroName = options.distroName ?? DEFAULT_DISTRO;
    this.supervisorPath = options.supervisorPath ?? DEFAULT_SUPERVISOR;
    this.managedWorkspacesRoot = options.managedWorkspacesRoot;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.guestUsers = options.guestUserProvisioner ?? new GuestUserProvisioner({ runner: this.runner, distroName: this.distroName });
    validateRuntimeDistroName(this.distroName);
    if (this.supervisorPath !== DEFAULT_SUPERVISOR) throw new Error("runtime supervisor path is not allowlisted");
    if (!Number.isSafeInteger(this.stopTimeoutMs) || this.stopTimeoutMs <= 0) {
      throw new Error("runtime stop timeout must be a positive integer");
    }
  }

  async start(signal?: AbortSignal): Promise<RuntimeBoot> {
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.runGuest(["--protocol-version", "1", "start"], signal);
      try {
        const boot = parseBoot(result.stdout);
        this.activeBoot = boot;
        return boot;
      } catch (error) {
        const delay = START_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !retryableTeardownError(error)) throw error;
        await waitForRetry(delay, signal);
      }
    }
  }

  async health(boot: RuntimeBoot, signal?: AbortSignal): Promise<RuntimeHealth> {
    this.assertBoot(boot);
    const result = await this.runGuest(["--protocol-version", "1", "health", boot.runtimeBootId], signal);
    const response = parseJsonRecord(result.stdout);
    if (response.ok !== true) return { ok: false, code: "runtime_unhealthy", message: "Runtime supervisor health check failed." };
    return { ok: true };
  }

  async acquire(request: RuntimeLeaseRequest, signal?: AbortSignal): Promise<RuntimeDriverLease> {
    this.assertBootId(request.runtimeBootId);
    const response = await this.runFrame("acquire", request.runtimeBootId, request.leaseId, request.agentId, request.policyDigest, { ...request }, signal);
    const expectedSandboxId = `sandbox-${request.leaseId}`;
    if (response.sandboxId !== expectedSandboxId) {
      throw new RuntimeManagerError("runtime_protocol_error", "Runtime sandbox identity is invalid.");
    }
    return { sandboxId: expectedSandboxId, leaseId: request.leaseId };
  }

  /**
   * The lease id is host-generated and therefore remains an addressable
   * identity even when the acquire response lost the guest sandbox id.
   * Supervisors may use that id to make the compensating release idempotent.
   */
  async compensateAcquire(request: RuntimeLeaseRequest): Promise<void> {
    this.assertBootId(request.runtimeBootId);
    const response = await this.runFrame(
      "release",
      request.runtimeBootId,
      request.leaseId,
      request.agentId,
      request.policyDigest,
      // The supervisor deterministically derives this identity from the
      // host-generated lease id, so compensation remains addressable even
      // when the acquire response was lost before parsing.
      { sandboxId: `sandbox-${request.leaseId}` },
      undefined,
    );
    assertGuestAcknowledged(response, "Runtime supervisor lease compensation failed.");
  }

  async release(lease: RuntimeDriverLease): Promise<void> {
    if (!this.activeBoot || typeof lease.leaseId !== "string" || lease.leaseId.length === 0) {
      throw new RuntimeManagerError("lease_released", "Runtime lease is no longer active.");
    }
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.runFrame("release", this.activeBoot.runtimeBootId, lease.leaseId, null, EMPTY_POLICY_DIGEST, { sandboxId: lease.sandboxId }, undefined);
      try {
        assertGuestAcknowledged(response, "Runtime supervisor lease cleanup failed.");
        return;
      } catch (error) {
        const delay = RELEASE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !retryableTeardownError(error)) throw error;
        await waitForRetry(delay);
      }
    }
  }

  async stop(reason: StopReason): Promise<void> {
    if (!this.activeBoot) return;
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const stopSequence = (async () => {
      const response = await this.runFrame("stop", this.activeBoot!.runtimeBootId, null, null, EMPTY_POLICY_DIGEST, { reason }, controller.signal);
      assertGuestAcknowledged(response, "Runtime supervisor shutdown cleanup failed.");
      return this.runner.run(["--terminate", this.distroName], controller.signal);
    })();
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new RuntimeManagerError("runtime_unhealthy", "Runtime stop timed out.");
        reject(error);
        controller.abort(error);
      }, this.stopTimeoutMs);
    });
    let result: WslCommandResult;
    try {
      result = await Promise.race([stopSequence, deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    try {
      classifyWslDistroTermination(result);
    } catch {
      throw new RuntimeManagerError("runtime_unhealthy", "Runtime stop failed.");
    }
    this.activeBoot = null;
  }

  async runProcess(lease: RuntimeLease, request: ProcessRunRequest, workspaceRoot: string, signal: AbortSignal): Promise<ExecutionResult> {
    if (!this.activeBoot || lease.runtimeBootId !== this.activeBoot.runtimeBootId) {
      throw new RuntimeManagerError("runtime_protocol_error", "Runtime boot identity is stale.");
    }
    if (lease.agentId.length === 0 || lease.leaseId.length === 0) throw new RuntimeManagerError("lease_expired", "Runtime lease is invalid.");
    const checkedWorkspaceRoot = await validateWorkspaceRoot(workspaceRoot, lease.agentId, this.managedWorkspacesRoot);
    // Per-agent Linux identity (melhoria 4): provisioned once per distro,
    // fail-closed. The supervisor refuses to run without it.
    const linuxUser = await this.guestUsers.ensure(lease.agentId, signal);
    if (!isValidGuestUserName(linuxUser)) {
      throw new RuntimeManagerError("runtime_protocol_error", "Runtime guest user identity is invalid.");
    }
    const now = Date.now();
    const deadline = Math.min(lease.expiresAt, now + request.timeoutMs + 5_000);
    if (deadline <= now) throw new RuntimeManagerError("lease_expired", "Runtime lease expired.");
    const response = await this.runFrame(
      "run",
      lease.runtimeBootId,
      lease.leaseId,
      lease.agentId,
      capabilityDigest(lease.capability),
      { ...request, workspaceWindowsPath: checkedWorkspaceRoot, linuxUser },
      signal,
      deadline,
    );
    return parseExecutionResult(Buffer.from(JSON.stringify(response), "utf8"));
  }

  private async runFrame(
    type: RuntimeFrame["type"],
    runtimeBootId: string,
    leaseId: string | null,
    agentId: string | null,
    policyDigest: string,
    payload: RecordValue,
    signal?: AbortSignal,
    deadline = Date.now() + 30_000,
  ): Promise<RecordValue> {
    const frame: RuntimeFrame = {
      protocolVersion: 1,
      type,
      runtimeBootId,
      leaseId,
      agentId,
      nonce: randomUUID(),
      deadline,
      policyDigest,
      payload,
    };
    const result = await this.runGuest(["--protocol-version", "1", "frame"], signal, Buffer.from(encodeRuntimeFrame(frame), "utf8"));
    return parseJsonRecord(result.stdout);
  }

  private async runGuest(args: readonly string[], signal?: AbortSignal, input?: Buffer): Promise<WslCommandResult> {
    const result = await this.runner.run(["-d", this.distroName, "--user", "root", "--", this.supervisorPath, ...args], signal, input);
    if (result.exitCode !== 0) throw new RuntimeManagerError("runtime_protocol_error", "Runtime supervisor command failed.");
    return result;
  }

  private assertBoot(boot: RuntimeBoot): void {
    this.assertBootId(boot.runtimeBootId);
  }

  private assertBootId(runtimeBootId: string): void {
    if (!this.activeBoot || this.activeBoot.runtimeBootId !== runtimeBootId) {
      throw new RuntimeManagerError("runtime_protocol_error", "Runtime boot identity is stale.");
    }
  }
}

export interface WslProcessRunnerOptions {
  client: WslGuestClient;
  agentId: string;
  workspaceRoot: string;
}

export class WslProcessRunner {
  private readonly client: WslGuestClient;
  private readonly agentId: string;
  private readonly workspaceRoot: string;

  constructor(options: WslProcessRunnerOptions) {
    this.client = options.client;
    this.agentId = options.agentId;
    this.workspaceRoot = options.workspaceRoot;
  }

  run(lease: RuntimeLease, request: ProcessRunRequest, signal: AbortSignal): Promise<ExecutionResult> {
    if (lease.agentId !== this.agentId) throw new RuntimeManagerError("agent_fenced", "Runtime lease belongs to another agent.");
    return this.client.runProcess(lease, request, this.workspaceRoot, signal);
  }
}
