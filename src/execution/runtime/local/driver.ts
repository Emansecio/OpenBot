import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { win32 as path } from "node:path";

import { boundedProcessOutput, MAX_PROCESS_OUTPUT_BYTES, type ExecutionResult } from "../../contracts.js";
import { WorkspaceSandbox } from "../../workspace.js";
import { redactLogText } from "../../../local-logger.js";
import type {
  ProcessRunRequest,
  RuntimeBoot,
  RuntimeDriver,
  RuntimeDriverLease,
  RuntimeHealth,
  RuntimeLease,
  RuntimeLeaseRequest,
  StopReason,
} from "../contracts.js";
import { RuntimeManagerError } from "../manager.js";
import type { RuntimeProcessRunner } from "../wsl/process-backend.js";

const failure = (
  code: "runtime_unavailable" | "runtime_protocol_error" | "process_not_allowed" | "process_aborted" | "timed_out" | "output_limit" | "io_error",
  message: string,
): ExecutionResult => ({ ok: false, operation: "process.run", code, message });

const terminateProcessTree = async (child: ChildProcess): Promise<void> => {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") {
    child.kill("SIGKILL");
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (child.exitCode === null && child.signalCode === null) child.kill();
      resolve();
    };
    killer.once("error", finish);
    killer.once("close", finish);
  });
};

export class LocalRuntimeDriver implements RuntimeDriver {
  private boot: RuntimeBoot | null = null;
  private readonly leases = new Map<string, {
    agentId: string;
    controller: AbortController;
    running?: Promise<ExecutionResult>;
  }>();

  async start(): Promise<RuntimeBoot> {
    this.boot = { runtimeBootId: randomUUID(), runtimeVersion: "native-windows", imageDigest: "native-windows" };
    return this.boot;
  }

  async health(boot: RuntimeBoot): Promise<RuntimeHealth> {
    return this.boot?.runtimeBootId === boot.runtimeBootId
      ? { ok: true }
      : { ok: false, code: "runtime_unavailable", message: "Native runtime is unavailable." };
  }

  async acquire(request: RuntimeLeaseRequest): Promise<RuntimeDriverLease> {
    if (!this.boot || request.runtimeBootId !== this.boot.runtimeBootId) {
      throw new RuntimeManagerError("runtime_unavailable", "Native runtime is unavailable.");
    }
    if (request.expiresAt <= Date.now()) throw new RuntimeManagerError("lease_expired", "Runtime lease expired.");
    if (request.capability.kind !== "process.run" || request.capability.networkProfile !== "host") {
      throw new RuntimeManagerError("unsupported_capability", "Native runtime only supports trusted host networking.");
    }
    this.leases.set(request.leaseId, { agentId: request.agentId, controller: new AbortController() });
    return { leaseId: request.leaseId, sandboxId: "native-" + request.leaseId };
  }

  async release(lease: RuntimeDriverLease): Promise<void> {
    const id = lease.leaseId ?? "";
    const active = this.leases.get(id);
    if (!active) return;
    active.controller.abort();
    await active.running;
    this.leases.delete(id);
  }

  async stop(_reason: StopReason): Promise<void> {
    await Promise.all([...this.leases.keys()].map((leaseId) => this.release({ leaseId, sandboxId: "native-" + leaseId })));
    this.boot = null;
  }

  processRunner(agentId: string, workspaceRoot: string): RuntimeProcessRunner {
    const runner = new LocalProcessRunner(agentId, workspaceRoot);
    return { run: async (lease, request, signal) => {
      const active = this.leases.get(lease.leaseId);
      if (!active || active.agentId !== agentId || active.controller.signal.aborted || active.running) {
        return failure("process_not_allowed", "Native process lease is not active for this bot.");
      }
      active.running = runner.run(lease, request, AbortSignal.any([signal, active.controller.signal]));
      return active.running;
    } };
  }
}

/**
 * Trusted Windows runner. Relative cwd values stay inside the agent workspace;
 * absolute cwd values intentionally address the host and any mounted drive.
 */
export class LocalProcessRunner implements RuntimeProcessRunner {
  constructor(private readonly agentId: string, private readonly workspaceRoot: string) {}

  async run(lease: RuntimeLease, request: ProcessRunRequest, signal: AbortSignal): Promise<ExecutionResult> {
    if (lease.agentId !== this.agentId) throw new RuntimeManagerError("agent_fenced", "Runtime lease belongs to another agent.");
    if (lease.capability.networkProfile !== "host" || request.networkProfile !== "host") {
      return failure("process_not_allowed", "Native runtime only supports trusted host networking.");
    }

    let cwd: string;
    try {
      if (path.isAbsolute(request.cwd)) {
        cwd = path.resolve(request.cwd);
        if (!(await stat(cwd)).isDirectory()) return failure("io_error", "Process cwd is not a directory.");
      } else {
        const workspace = await WorkspaceSandbox.create(this.workspaceRoot, { allowAncestorLinks: true });
        cwd = await workspace.resolveExisting(request.cwd);
      }
    } catch {
      return failure("io_error", "Workspace path could not be verified.");
    }
    if (signal.aborted) return failure("process_aborted", "Process execution was aborted.");

    return new Promise((resolve) => {
      const env = { ...process.env, ...request.env, OPENBOT_WORKSPACE: this.workspaceRoot };
      const secrets = Object.entries(env)
        .filter(([name, value]) => value != null && !name.endsWith("_PATH") && /(?:KEY|TOKEN|SECRET|PASSWORD)/iu.test(name))
        .map(([, value]) => value as string);
      const child = spawn(request.executable, request.argv, {
        cwd,
        shell: false,
        windowsHide: true,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputLimit = false;
      let timedOut = false;
      let aborted = false;
      let stdinFailed = false;
      let settled = false;
      let timeout: NodeJS.Timeout;
      let termination: Promise<void> | undefined;
      const started = Date.now();
      const terminate = (): void => {
        termination ??= terminateProcessTree(child);
      };
      const onAbort = (): void => {
        aborted = true;
        terminate();
      };
      const finish = (result: ExecutionResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, request.timeoutMs);
      timeout.unref();
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        const remaining = Math.max(0, MAX_PROCESS_OUTPUT_BYTES - stdoutBytes);
        if (remaining > 0) stdout.push(chunk.subarray(0, remaining));
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) {
          outputLimit = true;
          terminate();
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = Math.max(0, MAX_PROCESS_OUTPUT_BYTES - stderrBytes);
        if (remaining > 0) stderr.push(chunk.subarray(0, remaining));
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_PROCESS_OUTPUT_BYTES) {
          outputLimit = true;
          terminate();
        }
      });
      child.once("error", () => finish(failure("io_error", "Process could not be started.")));
      child.stdin.on("error", () => {
        stdinFailed = true;
        terminate();
      });
      child.once("close", async (code, closeSignal) => {
        await termination;
        const output = boundedProcessOutput({
          stdout: redactLogText(Buffer.concat(stdout).toString("utf8"), secrets),
          stderr: redactLogText(Buffer.concat(stderr).toString("utf8"), secrets),
          exitCode: code,
          ...(closeSignal === null ? {} : { signal: closeSignal }),
          durationMs: Date.now() - started,
          stdoutTruncated: stdoutBytes > MAX_PROCESS_OUTPUT_BYTES,
          stderrTruncated: stderrBytes > MAX_PROCESS_OUTPUT_BYTES,
        });
        const interrupted = (code: "output_limit" | "timed_out" | "process_aborted" | "io_error", message: string): void => {
          finish({ ok: false, operation: "process.run", code,
            message: `${message} Earlier effects may have completed; verify before retrying.`, partialOutput: output });
        };
        if (outputLimit) return interrupted("output_limit", "Process output exceeded the limit.");
        if (timedOut) return interrupted("timed_out", "Process execution timed out.");
        if (aborted || signal.aborted) return interrupted("process_aborted", "Process execution was aborted.");
        if (stdinFailed) return interrupted("io_error", "Process stdin could not be delivered.");
        finish({ ok: true, operation: "process.run", ...output });
      });
      child.stdin.end(request.stdin);
    });
  }
}
