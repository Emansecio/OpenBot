import type { ExecutionBackend, ExecutionErrorCode, ExecutionRequest, ExecutionResult } from "../../contracts.js";
import { boundedProcessOutput, MAX_PROCESS_OUTPUT_BYTES } from "../../contracts.js";
import type {
  AgentRuntimeManager,
  ProcessRunRequest,
  RuntimeLease,
} from "../contracts.js";
import { RuntimeManagerError } from "../manager.js";
import { runtimeCapabilityForRequest } from "../policy.js";
import { WorkspaceQuotaError } from "../../quota.js";
import type { WorkspaceProcessObservation, QuotaDelta } from "../../quota.js";
import { WorkspaceQuotaObserver } from "../../quota-observer.js";

export interface RuntimeProcessRunner {
  run(lease: RuntimeLease, request: ProcessRunRequest, signal: AbortSignal): Promise<ExecutionResult>;
}

export interface WslProcessBackendOptions {
  agentId: string;
  manager: AgentRuntimeManager;
  runner: RuntimeProcessRunner;
  quota?: RuntimeWorkspaceQuotaGuard;
  /** @deprecated Retained for caller compatibility; polling is no longer used. */
  quotaPollIntervalMs?: number;
  quotaObserverFactory?: RuntimeQuotaObserverFactory;
}

export interface RuntimeWorkspaceQuotaGuard {
  readonly workspaceRoot?: string;
  observeProcesses?(onError: (error: Error) => void): Promise<WorkspaceProcessObservation>;
  assertWithinQuota(): Promise<void>;
  refreshUsage?(): Promise<unknown>;
  applyExternalDelta?(delta: QuotaDelta, scopePath?: string): Promise<void>;
  markUsageDirty?(): void;
}

export interface RuntimeQuotaObserver {
  start(): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export type RuntimeQuotaObserverFactory = (options: {
  root: string;
  onDelta(delta: QuotaDelta, absolutePath: string): Promise<void>;
  onError(error: Error): void;
}) => RuntimeQuotaObserver;

const failure = (code: ExecutionErrorCode, message: string): ExecutionResult => ({
  ok: false,
  operation: "process.run",
  code,
  message,
});

const runtimeFailure = (error: unknown): ExecutionResult => {
  if (error instanceof RuntimeManagerError) {
    switch (error.code) {
      case "agent_fenced":
      case "unsupported_capability":
        return failure("process_not_allowed", "Process capability is not allowed.");
      case "lease_expired":
        return failure("lease_expired", "Runtime lease expired.");
      case "runtime_protocol_error":
        return failure("runtime_protocol_error", "Runtime protocol failed.");
      case "runtime_unhealthy":
        return failure("runtime_unhealthy", "Runtime is unhealthy.");
      case "runtime_unavailable":
      case "runtime_closed":
      case "runtime_capacity_exceeded":
        return failure("runtime_unavailable", "Runtime is unavailable.");
      case "lease_released":
        return failure("lease_expired", "Runtime lease is no longer active.");
    }
  }
  return failure("runtime_unavailable", "Runtime is unavailable.");
};

const processFailure = (code: ExecutionErrorCode, message: string): ExecutionResult => failure(code, message);
const quotaMessage = (error: WorkspaceQuotaError): string => error.message;
const verifyExternalUsage = async (quota: RuntimeWorkspaceQuotaGuard): Promise<void> => {
  if (quota.refreshUsage) {
    await quota.refreshUsage();
    await quota.assertWithinQuota();
    return;
  }
  await quota.assertWithinQuota();
};

export class WslProcessBackend implements ExecutionBackend {
  private readonly agentId: string;
  private readonly manager: AgentRuntimeManager;
  private readonly runner: RuntimeProcessRunner;
  private readonly quota?: RuntimeWorkspaceQuotaGuard;
  private readonly quotaObserverFactory: RuntimeQuotaObserverFactory;
  private readonly sharedObservation: boolean;

  constructor(options: WslProcessBackendOptions) {
    this.agentId = options.agentId;
    this.manager = options.manager;
    this.runner = options.runner;
    this.quota = options.quota;
    this.sharedObservation = options.quota?.observeProcesses !== undefined && options.quotaObserverFactory === undefined;
    this.quotaObserverFactory = options.quotaObserverFactory ?? ((observerOptions) => new WorkspaceQuotaObserver(observerOptions));
  }

  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    if (request.operation !== "process.run") {
      return { ok: false, operation: request.operation, code: "unsupported", message: "Operation is not supported by the process backend." };
    }
    if (request.networkProfile !== "none" && request.networkProfile !== "host") {
      return processFailure("process_not_allowed", "Process network profile is not allowed.");
    }
    if (signal?.aborted) return processFailure("process_aborted", "Process execution was aborted.");
    let observation: WorkspaceProcessObservation | undefined;
    const controller = new AbortController();
    let quotaFailure: unknown;
    const recordQuotaFailure = (error: unknown): void => {
      if (quotaFailure === undefined) quotaFailure = error;
      this.quota?.markUsageDirty?.();
      controller.abort();
    };
    if (this.quota !== undefined) {
      try {
        if (this.sharedObservation) observation = await this.quota.observeProcesses!(recordQuotaFailure);
        else await verifyExternalUsage(this.quota);
      } catch (error) {
        if (error instanceof WorkspaceQuotaError) this.quota.markUsageDirty?.();
        return error instanceof WorkspaceQuotaError
          ? processFailure("quota_exceeded", quotaMessage(error))
          : processFailure("runtime_unhealthy", "Workspace quota could not be verified.");
      }
    }

    let lease: RuntimeLease;
    try {
      lease = await this.manager.acquire(this.agentId, runtimeCapabilityForRequest(request), signal);
    } catch (error) {
      await observation?.close().catch(() => this.quota?.markUsageDirty?.());
      return runtimeFailure(error);
    }

    const quotaObserver: RuntimeQuotaObserver | undefined = observation !== undefined
      ? { start: async () => undefined, drain: () => observation!.drain(), close: () => observation!.close() }
      : this.quota?.workspaceRoot !== undefined && this.quota.applyExternalDelta !== undefined
      ? this.quotaObserverFactory({
          root: this.quota.workspaceRoot,
          onDelta: async (delta, absolutePath) => this.quota!.applyExternalDelta!(delta, absolutePath),
          onError: recordQuotaFailure,
        })
      : undefined;
    let quotaObserverClosed = false;
    const closeQuotaObserver = async (): Promise<void> => {
      if (quotaObserver === undefined || quotaObserverClosed) return;
      quotaObserverClosed = true;
      try {
        await quotaObserver.close();
      } catch (error) {
        recordQuotaFailure(error);
      }
    };
    let timedOut = false;
    const abortListener = () => controller.abort();
    signal?.addEventListener("abort", abortListener, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    timeout.unref();

    let result: ExecutionResult = processFailure("runtime_protocol_error", "Runtime process execution failed.");
    let runnerResult: ExecutionResult | undefined;
    try {
      try {
        await quotaObserver?.start();
      } catch (error) {
        recordQuotaFailure(error);
      }
      let executionError: unknown;
      if (quotaFailure !== undefined) {
        result = processFailure("runtime_unhealthy", "Workspace quota could not be verified.");
      } else if (signal?.aborted || controller.signal.aborted) {
        result = timedOut
          ? processFailure("process_timeout", "Process execution timed out.")
          : processFailure("process_aborted", "Process execution was aborted.");
      } else {
        try {
          result = runnerResult = await this.runner.run(lease, request, controller.signal);
        } catch (error) {
          executionError = error;
        }
      }
      await closeQuotaObserver();
      if (this.quota !== undefined && !this.sharedObservation) {
        try {
          await verifyExternalUsage(this.quota);
        } catch (error) {
          if (quotaFailure === undefined) quotaFailure = error;
        }
      }
      if (executionError !== undefined) throw executionError;
      if (quotaFailure instanceof WorkspaceQuotaError) result = processFailure("quota_exceeded", quotaMessage(quotaFailure));
      else if (quotaFailure !== undefined) result = processFailure("runtime_unhealthy", "Workspace quota could not be verified.");
      else if (timedOut) result = processFailure("process_timeout", "Process execution timed out.");
      else if (signal?.aborted) result = processFailure("process_aborted", "Process execution was aborted.");
      else if (result.ok && result.operation === "process.run" && (
        Buffer.byteLength(result.stdout, "utf8") > MAX_PROCESS_OUTPUT_BYTES ||
        Buffer.byteLength(result.stderr, "utf8") > MAX_PROCESS_OUTPUT_BYTES
      )) {
        result = processFailure("process_output_limit", "Process output exceeded the byte limit.");
      }
    } catch (error) {
      if (quotaFailure instanceof WorkspaceQuotaError) result = processFailure("quota_exceeded", quotaMessage(quotaFailure));
      else if (quotaFailure !== undefined) result = processFailure("runtime_unhealthy", "Workspace quota could not be verified.");
      else if (timedOut) result = processFailure("process_timeout", "Process execution timed out.");
      else if (signal?.aborted || controller.signal.aborted) result = processFailure("process_aborted", "Process execution was aborted.");
      else result = runtimeFailure(error);
    } finally {
      await closeQuotaObserver();
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortListener);
      if (quotaFailure !== undefined) this.quota?.markUsageDirty?.();
      try {
        await lease.release();
      } catch {
        // A timeout/abort is only complete after the guest acknowledges lease
        // teardown. Never report a successful cleanup contract when release
        // failed, regardless of the process result that preceded it.
        result = processFailure("runtime_unhealthy", "Runtime lease cleanup failed.");
      }
    }
    if (!result.ok && runnerResult?.operation === "process.run") {
      const output = runnerResult.ok ? runnerResult : runnerResult.partialOutput;
      if (output !== undefined) {
        return {
          ...result,
          message: result.message.includes("Earlier effects may have completed")
            ? result.message : `${result.message} Earlier effects may have completed; verify before retrying.`,
          partialOutput: boundedProcessOutput({
            stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode,
            ...(output.signal === undefined ? {} : { signal: output.signal }),
            durationMs: output.durationMs, stdoutTruncated: output.stdoutTruncated, stderrTruncated: output.stderrTruncated,
          }),
        };
      }
    }
    return result;
  }
}
