import type { RuntimeBoot } from "../contracts.js";
import {
  isPendingRuntimeLeaseRecord,
  validRuntimeIdentifier,
  type RuntimeLeaseRecord,
  type RuntimeResourceReconciler,
} from "../recovery.js";
import { validateRuntimeDistroName } from "./adapter.js";
import { WslGuestClient } from "./guest-runner.js";
import type { WslCommandRunner } from "./provisioner.js";

const DEFAULT_DISTRO = "OpenBotRuntime";

const invalidRecord = (message: string): Error => new Error(`runtime lease recovery identity is invalid: ${message}`);

const validateLeaseRecordForWsl = (record: RuntimeLeaseRecord): void => {
  if (
    !validRuntimeIdentifier(record.leaseId) ||
    !validRuntimeIdentifier(record.runtimeBootId) ||
    !validRuntimeIdentifier(record.temporaryId)
  ) throw invalidRecord("record contains an invalid identity");
  if (!isPendingRuntimeLeaseRecord(record) && (
    !validRuntimeIdentifier(record.sandboxId) || record.sandboxId !== `sandbox-${record.leaseId}`
  )) {
    throw invalidRecord("sandboxId does not match leaseId");
  }
  if (record.temporaryId !== `tmp-${record.leaseId}`) {
    throw invalidRecord("temporaryId does not match leaseId");
  }
};

/**
 * Production WSL recovery. The guest supervisor's start operation is the
 * single shared-runtime orphan sweep: it tears down every persisted guest
 * lease before publishing a new boot identity. The host then proves the
 * exact persisted sandbox/cgroup identities are absent before the journal
 * record can be deleted.
 */
export class WslRuntimeResourceReconciler implements RuntimeResourceReconciler {
  private readonly client: WslGuestClient;
  private readonly runner: WslCommandRunner;
  private readonly distroName: string;
  private recoveryStart: Promise<RuntimeBoot> | undefined;

  constructor(options: {
    client: WslGuestClient;
    runner: WslCommandRunner;
    distroName?: string;
  }) {
    this.client = options.client;
    this.runner = options.runner;
    this.distroName = validateRuntimeDistroName(options.distroName ?? DEFAULT_DISTRO);
  }

  async reconcileLease(record: RuntimeLeaseRecord, activeBoot?: RuntimeBoot): Promise<void> {
    validateLeaseRecordForWsl(record);
    try {
      await this.ensureGuestRecovery(activeBoot);
      for (const target of [
        `/run/openbot/sandboxes/${record.leaseId}`,
        `/sys/fs/cgroup/openbot/${record.runtimeBootId}/${record.leaseId}`,
      ]) {
        const result = await this.runner.run([
          "-d",
          this.distroName,
          "--user",
          "root",
          "--",
          "test",
          "!",
          "-e",
          target,
        ]);
        if (result.exitCode !== 0) {
          throw new Error("guest runtime teardown proof failed");
        }
      }
    } catch (error) {
      // Do not let the generic recovery layer classify an infrastructure
      // failure such as a missing wsl.exe as an already-absent resource.
      const wrapped = new Error("WSL runtime teardown could not be proved");
      Object.assign(wrapped, { code: "RUNTIME_RECOVERY_FAILED", cause: error });
      throw wrapped;
    }
  }

  /**
   * The full lease record is required for WSL teardown because the persisted
   * runtime boot id is part of the cgroup identity. Calling either legacy
   * single-id seam directly is therefore fail-closed.
   */
  async killSandbox(_sandboxId: string): Promise<void> {
    throw new Error("WSL recovery requires the full lease identity");
  }

  async removeTemporary(_temporaryId: string): Promise<void> {
    throw new Error("WSL recovery requires the full lease identity");
  }

  private ensureGuestRecovery(activeBoot?: RuntimeBoot): Promise<RuntimeBoot> {
    if (activeBoot) {
      return (async () => {
        const health = await this.client.health(activeBoot);
        if (!health.ok) throw new Error("guest runtime recovery health check failed");
        return activeBoot;
      })();
    }
    if (!this.recoveryStart) {
      const attempt = (async () => {
        const boot = await this.client.start();
        const health = await this.client.health(boot);
        if (!health.ok) throw new Error("guest runtime recovery health check failed");
        return boot;
      })();
      this.recoveryStart = attempt;
      void attempt.catch(() => {
        if (this.recoveryStart === attempt) this.recoveryStart = undefined;
      });
    }
    return this.recoveryStart;
  }
}

export const createWslRuntimeResourceReconciler = (options: {
  client: WslGuestClient;
  runner: WslCommandRunner;
  distroName?: string;
}): RuntimeResourceReconciler => new WslRuntimeResourceReconciler(options);
