import type { ExecutionRequest, ExecutionResult, ProcessNetworkProfile } from "../contracts.js";

export type RuntimeMode = "lite" | "browser" | "developer";

export type RuntimeState =
  | "lite-ready"
  | "runtime-unavailable"
  | "runtime-installing"
  | "stopped"
  | "starting"
  | "ready"
  | "busy"
  | "waiting-approval"
  | "stopping"
  | "unhealthy"
  | "quota-exceeded"
  | "repair-required";

export type RuntimeCapability = {
  kind: "process.run";
  networkProfile: ProcessNetworkProfile;
};

export type StopReason = "idle" | "shutdown" | "agent-delete" | "health-failure" | "manual";

export type RuntimeErrorCode =
  | "runtime_unavailable"
  | "runtime_protocol_error"
  | "runtime_unhealthy"
  | "runtime_version_mismatch"
  | "unsupported_capability"
  | "agent_fenced"
  | "lease_expired"
  | "lease_released"
  | "runtime_capacity_exceeded"
  | "runtime_closed";

export interface SanitizedRuntimeError {
  code: RuntimeErrorCode;
  message: string;
}

export interface RuntimeBoot {
  runtimeBootId: string;
  runtimeVersion: string;
  imageDigest: string;
}

export type RuntimeHealth =
  | { ok: true }
  | { ok: false; code: RuntimeErrorCode; message: string };

export interface RuntimeLeaseRequest {
  leaseId: string;
  agentId: string;
  runtimeBootId: string;
  capability: RuntimeCapability;
  policyDigest: string;
  expiresAt: number;
}

export interface RuntimeDriverLease {
  leaseId?: string;
  sandboxId: string;
}

export interface RuntimeDriver {
  /** Identifies a versioned recovery protocol, including pending leases. */
  readonly recoveryKind?: "native-job-v1";
  start(signal?: AbortSignal): Promise<RuntimeBoot>;
  health(boot: RuntimeBoot, signal?: AbortSignal): Promise<RuntimeHealth>;
  acquire(request: RuntimeLeaseRequest, signal?: AbortSignal): Promise<RuntimeDriverLease>;
  /**
   * Best-effort compensation when acquire may have committed in the guest
   * before the host received a usable lease identity. Optional for existing
   * drivers that cannot address an acquire by request identity yet.
   */
  compensateAcquire?(request: RuntimeLeaseRequest): Promise<void>;
  release(lease: RuntimeDriverLease): Promise<void>;
  stop(reason: StopReason): Promise<void>;
}

export interface RuntimeStatus {
  agentId: string;
  mode: RuntimeMode;
  state: RuntimeState;
  runtimeVersion: string | null;
  imageDigest: string | null;
  runtimeBootId: string | null;
  activeLeaseCount: number;
  activeProcessCount: number;
  /** Number of callers waiting for a runtime lease, when admission is queued. */
  waitingLeaseCount?: number;
  lastActivityAt: string | null;
  lastError: SanitizedRuntimeError | null;
}

export interface RuntimeLease {
  readonly leaseId: string;
  readonly agentId: string;
  readonly runtimeBootId: string;
  readonly sandboxId: string;
  readonly capability: RuntimeCapability;
  readonly expiresAt: number;
  readonly released: boolean;
  release(): Promise<void>;
}

export interface AgentRuntimeManager {
  metrics?(): import("./scheduler.js").RuntimeAdmissionMetrics;
  /** Ref-counted temporary admission fence; releasing it never clears a deletion fence. */
  fenceAgentMaintenance?(agentId: string): () => void;
  ensure(agentId: string, mode: RuntimeMode, signal?: AbortSignal): Promise<RuntimeStatus>;
  acquire(agentId: string, capability: RuntimeCapability, signal?: AbortSignal): Promise<RuntimeLease>;
  status(agentId: string, requestedMode?: RuntimeMode): Promise<RuntimeStatus>;
  /** Marks only one agent fail-closed after its home recovery needs operator repair. */
  markAgentRepairRequired?(agentId: string): void;
  /** Clears the per-agent home recovery fence after a committed repair, restore, or delete. */
  clearAgentRepairRequired?(agentId: string): void;
  stop(agentId: string, reason: StopReason): Promise<RuntimeStatus>;
  repair(agentId: string): Promise<RuntimeStatus>;
  close(): Promise<void>;
}

export type ProcessRunRequest = Extract<ExecutionRequest, { operation: "process.run" }>;
export type ProcessRunResult = Extract<ExecutionResult, { ok: true; operation: "process.run" }>;
