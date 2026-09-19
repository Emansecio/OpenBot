import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { win32 as path } from "node:path";
import { boundedProcessOutput, MAX_PROCESS_OUTPUT_BYTES, type ExecutionResult } from "../../contracts.js";
import { WorkspaceSandbox } from "../../workspace.js";
import { redactLogText } from "../../../local-logger.js";
import type { ProcessRunRequest, RuntimeBoot, RuntimeDriver, RuntimeDriverLease, RuntimeHealth, RuntimeLease, RuntimeLeaseRequest, StopReason } from "../contracts.js";
import { RuntimeManagerError } from "../manager.js";
import type { RuntimeProcessRunner } from "../wsl/process-backend.js";
import { nativeEnvironment } from "./environment.js";
import { NativeJobHelperCache } from "./helper-cache.js";
import { NATIVE_JOB_KIND, nativeJobName, nativeSandboxId, WindowsJobProcess } from "./windows-job.js";
export { LocalRuntimeReconciler } from "./windows-job.js";

const failure = (code: "runtime_unavailable" | "runtime_protocol_error" | "process_not_allowed" | "process_aborted" | "timed_out" | "output_limit" | "io_error", message: string): ExecutionResult =>
  ({ ok: false, operation: "process.run", code, message });

export class LocalRuntimeDriver implements RuntimeDriver {
  readonly recoveryKind = NATIVE_JOB_KIND;
  private boot: RuntimeBoot | null = null;
  private readonly helper?: NativeJobHelperCache;

  constructor(options: { runtimeRoot?: string } = {}) {
    if (options.runtimeRoot !== undefined) this.helper = new NativeJobHelperCache(options.runtimeRoot);
  }
  private readonly leases = new Map<string, { agentId: string; controller: AbortController; job: WindowsJobProcess; running?: Promise<ExecutionResult> }>();

  async start(signal?: AbortSignal): Promise<RuntimeBoot> {
    signal?.throwIfAborted();
    await this.helper?.executable(signal);
    this.boot = { runtimeBootId: randomUUID(), runtimeVersion: "native-windows-job-v1", imageDigest: "native-windows" };
    return this.boot;
  }
  async health(boot: RuntimeBoot): Promise<RuntimeHealth> {
    return this.boot?.runtimeBootId === boot.runtimeBootId
      ? { ok: true }
      : { ok: false, code: "runtime_unavailable", message: "Native runtime is unavailable." };
  }
  async acquire(request: RuntimeLeaseRequest, signal?: AbortSignal): Promise<RuntimeDriverLease> {
    signal?.throwIfAborted();
    if (!this.boot || request.runtimeBootId !== this.boot.runtimeBootId) throw new RuntimeManagerError("runtime_unavailable", "Native runtime is unavailable.");
    if (request.expiresAt <= Date.now()) throw new RuntimeManagerError("lease_expired", "Runtime lease expired.");
    if (request.capability.kind !== "process.run" || request.capability.networkProfile !== "host") throw new RuntimeManagerError("unsupported_capability", "Native runtime only supports trusted host networking.");
    const executable = await this.helper?.executable(signal);
    signal?.throwIfAborted();
    const job = new WindowsJobProcess(nativeJobName(request.runtimeBootId, request.leaseId), process.env, executable);
    this.leases.set(request.leaseId, { agentId: request.agentId, controller: new AbortController(), job });
    await job.start(signal);
    return { leaseId: request.leaseId, sandboxId: nativeSandboxId(request.leaseId) };
  }
  async compensateAcquire(request: RuntimeLeaseRequest): Promise<void> {
    // A pending lease may own a ready supervisor, but cannot yet run a command.
    await this.release({ leaseId: request.leaseId, sandboxId: nativeSandboxId(request.leaseId) });
  }
  async release(lease: RuntimeDriverLease): Promise<void> {
    const id = lease.leaseId ?? "";
    const active = this.leases.get(id);
    if (!active) return;
    active.controller.abort();
    await active.running?.catch(() => undefined);
    await active.job.stop();
    this.leases.delete(id);
  }
  async stop(_reason: StopReason): Promise<void> {
    await Promise.all([...this.leases.keys()].map((leaseId) => this.release({ leaseId, sandboxId: nativeSandboxId(leaseId) })));
    this.boot = null;
  }
  processRunner(agentId: string, workspaceRoot: string): RuntimeProcessRunner {
    const runner = new LocalProcessRunner(agentId, workspaceRoot);
    return { run: async (lease, request, signal) => {
      const active = this.leases.get(lease.leaseId);
      if (!active || active.agentId !== agentId || active.controller.signal.aborted || active.running ||
        lease.runtimeBootId !== this.boot?.runtimeBootId || lease.sandboxId !== nativeSandboxId(lease.leaseId)) {
        return failure("process_not_allowed", "Native process lease is not active for this bot.");
      }
      active.running = runner.run(lease, request, AbortSignal.any([signal, active.controller.signal]), active.job);
      return active.running;
    } };
  }
}

/** Trusted host access remains intentional. Job Objects own lifecycle, not permissions. */
export class LocalProcessRunner implements RuntimeProcessRunner {
  constructor(private readonly agentId: string, private readonly workspaceRoot: string) {}

  async run(lease: RuntimeLease, request: ProcessRunRequest, signal: AbortSignal, ownedJob?: WindowsJobProcess): Promise<ExecutionResult> {
    if (lease.agentId !== this.agentId) throw new RuntimeManagerError("agent_fenced", "Runtime lease belongs to another agent.");
    if (lease.capability.networkProfile !== "host" || request.networkProfile !== "host") return failure("process_not_allowed", "Native runtime only supports trusted host networking.");
    if (signal.aborted) return failure("process_aborted", "Process execution was aborted.");
    let cwd: string;
    let environment: NodeJS.ProcessEnv;
    try {
      if (path.isAbsolute(request.cwd)) {
        cwd = path.resolve(request.cwd);
        if (!(await stat(cwd)).isDirectory()) return failure("io_error", "Process cwd is not a directory.");
      } else {
        const workspace = await WorkspaceSandbox.create(this.workspaceRoot, { allowAncestorLinks: true });
        cwd = await workspace.resolveExisting(request.cwd);
      }
      environment = await nativeEnvironment(this.workspaceRoot, request.env, signal);
    } catch {
      return signal.aborted ? failure("process_aborted", "Process execution was aborted.") : failure("io_error", "Workspace or operational paths could not be verified.");
    }
    const secrets = Object.entries(environment).filter(([name, value]) => value != null && !name.endsWith("_PATH") && /(?:KEY|TOKEN|SECRET|PASSWORD)/iu.test(name)).map(([, value]) => value as string);
    // Standalone test/embedding callers still receive OS ownership, but have no durable journal.
    const managed = lease.sandboxId === nativeSandboxId(lease.leaseId);
    const job = ownedJob ?? new WindowsJobProcess(nativeJobName(managed ? lease.runtimeBootId : randomUUID(), managed ? lease.leaseId : randomUUID()), environment);
    try { if (!ownedJob) await job.start(signal); }
    catch {
      try { await job.stop(); }
      catch { throw new RuntimeManagerError("runtime_unhealthy", "Native process cleanup could not be verified."); }
      return signal.aborted ? failure("process_aborted", "Process execution was aborted.") : failure("runtime_unavailable", "Native process ownership is unavailable.");
    }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0;
    let outputLimit = false, timedOut = false, aborted = false, stdinFailed = false;
    let exitCode: number | null = null;
    let termination: Promise<void> | undefined;
    let cleanupError: unknown;
    const started = Date.now();
    const terminate = (): void => { termination ??= job.stop().catch((error: unknown) => { cleanupError = error; }); };
    const onAbort = (): void => { aborted = true; terminate(); };
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, request.timeoutMs);
    timeout.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    let protocolOk = false;
    try {
      if (!signal.aborted) protocolOk = await job.run({ ...request, cwd, env: environment }, (frame) => {
        if (frame.kind === "exit") { exitCode = frame.code; return; }
        if (frame.kind === "stdin-error") { stdinFailed = true; return; }
        const chunk = Buffer.from(frame.data, "base64");
        const prior = frame.kind === "stdout" ? stdoutBytes : stderrBytes;
        const remaining = Math.max(0, MAX_PROCESS_OUTPUT_BYTES - prior);
        if (remaining > 0) (frame.kind === "stdout" ? stdout : stderr).push(chunk.subarray(0, remaining));
        if (frame.kind === "stdout") stdoutBytes += chunk.length; else stderrBytes += chunk.length;
        if (prior + chunk.length > MAX_PROCESS_OUTPUT_BYTES) { outputLimit = true; terminate(); }
      });
    } catch {
      protocolOk = false;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      terminate();
      await termination;
    }
    if (cleanupError !== undefined) throw new RuntimeManagerError("runtime_unhealthy", "Native process cleanup could not be verified.");
    const output = boundedProcessOutput({
      stdout: redactLogText(Buffer.concat(stdout).toString("utf8"), secrets), stderr: redactLogText(Buffer.concat(stderr).toString("utf8"), secrets),
      exitCode, durationMs: Date.now() - started, stdoutTruncated: stdoutBytes > MAX_PROCESS_OUTPUT_BYTES, stderrTruncated: stderrBytes > MAX_PROCESS_OUTPUT_BYTES,
    });
    const interrupted = (code: "output_limit" | "timed_out" | "process_aborted" | "io_error", message: string): ExecutionResult => ({ ok: false, operation: "process.run", code, message: `${message} Earlier effects may have completed; verify before retrying.`, partialOutput: output });
    if (outputLimit) return interrupted("output_limit", "Process output exceeded the limit.");
    if (timedOut) return interrupted("timed_out", "Process execution timed out.");
    if (aborted || signal.aborted) return interrupted("process_aborted", "Process execution was aborted.");
    if (stdinFailed) return interrupted("io_error", "Process stdin could not be delivered.");
    if (!protocolOk || exitCode === null) return interrupted("io_error", "Process could not complete.");
    return { ok: true, operation: "process.run", ...output };
  }
}
