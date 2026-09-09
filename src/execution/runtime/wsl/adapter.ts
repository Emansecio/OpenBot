import { win32 as path } from "node:path";

import type {
  RuntimeBoot,
  RuntimeDriver,
  RuntimeDriverLease,
  RuntimeHealth,
  RuntimeLeaseRequest,
  StopReason,
} from "../contracts.js";

export interface WslSupervisorTransport extends RuntimeDriver {}

export interface WslRuntimeAdapterOptions {
  runtimeRoot: string;
  distroName?: string;
  transport: WslSupervisorTransport;
}

const LIVE_TEST_DISTRO = /^OpenBotRuntimeLive-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function validateRuntimeTestDistroName(name: string): string {
  if (process.env.OPENBOT_RUNTIME_WSL_LIVE_TEST !== "1" || !LIVE_TEST_DISTRO.test(name)) {
    throw new Error("managed runtime test distro override is not permitted");
  }
  return name;
}

export function validateRuntimeDistroName(name: string): string {
  if (name !== "OpenBotRuntime") validateRuntimeTestDistroName(name);
  return name;
}

export function assertManagedRuntimePath(runtimeRoot: string, candidate: string): true {
  if (typeof runtimeRoot !== "string" || runtimeRoot.length === 0 || runtimeRoot.includes("\0")) {
    throw new Error("runtime root is invalid");
  }
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) {
    throw new Error("runtime path is invalid");
  }
  const root = path.resolve(runtimeRoot).replace(/[\\/]+$/u, "");
  const target = path.resolve(candidate);
  const normalizedRoot = root.toLowerCase();
  const normalizedTarget = target.toLowerCase();
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}\\`)) {
    throw new Error("runtime path is outside the managed root");
  }
  return true;
}

const validBoot = (boot: RuntimeBoot): RuntimeBoot => {
  if (
    typeof boot.runtimeBootId !== "string" || boot.runtimeBootId.length === 0 ||
    typeof boot.runtimeVersion !== "string" || boot.runtimeVersion.length === 0 ||
    typeof boot.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(boot.imageDigest)
  ) {
    throw new Error("runtime boot identity is invalid");
  }
  return boot;
};

export class WslRuntimeAdapter implements RuntimeDriver {
  readonly runtimeRoot: string;
  readonly distroName: string;
  private readonly transport: WslSupervisorTransport;
  private activeBoot: RuntimeBoot | null = null;

  constructor(options: WslRuntimeAdapterOptions) {
    assertManagedRuntimePath(options.runtimeRoot, options.runtimeRoot);
    this.runtimeRoot = path.resolve(options.runtimeRoot);
    this.distroName = validateRuntimeDistroName(options.distroName ?? "OpenBotRuntime");
    this.transport = options.transport;
  }

  async start(signal?: AbortSignal): Promise<RuntimeBoot> {
    if (signal?.aborted) throw new Error("runtime start was aborted");
    const boot = validBoot(await this.transport.start(signal));
    this.activeBoot = boot;
    return boot;
  }

  async health(boot: RuntimeBoot, signal?: AbortSignal): Promise<RuntimeHealth> {
    this.assertBoot(boot);
    return this.transport.health(boot, signal);
  }

  async acquire(request: RuntimeLeaseRequest, signal?: AbortSignal): Promise<RuntimeDriverLease> {
    this.assertBootId(request.runtimeBootId);
    if (typeof request.agentId !== "string" || request.agentId.length === 0 || request.agentId.includes("\0")) {
      throw new Error("runtime agent id is invalid");
    }
    if (request.capability.kind !== "process.run" || request.capability.networkProfile !== "none") {
      throw new Error("runtime capability is unsupported");
    }
    if (!/^[a-f0-9]{64}$/u.test(request.policyDigest) || request.expiresAt <= Date.now()) {
      throw new Error("runtime lease is invalid");
    }
    return this.transport.acquire(request, signal);
  }

  async compensateAcquire(request: RuntimeLeaseRequest): Promise<void> {
    this.assertBootId(request.runtimeBootId);
    await this.transport.compensateAcquire?.(request);
  }

  async release(lease: RuntimeDriverLease): Promise<void> {
    if (lease.leaseId !== undefined && (lease.leaseId.length === 0 || lease.leaseId.includes("\0"))) {
      throw new Error("runtime lease id is invalid");
    }
    await this.transport.release(lease);
  }

  async stop(reason: StopReason): Promise<void> {
    await this.transport.stop(reason);
    this.activeBoot = null;
  }

  private assertBoot(boot: RuntimeBoot): void {
    validBoot(boot);
    this.assertBootId(boot.runtimeBootId);
  }

  private assertBootId(runtimeBootId: string): void {
    if (!this.activeBoot || runtimeBootId !== this.activeBoot.runtimeBootId) {
      throw new Error("runtime boot identity is stale");
    }
  }
}
