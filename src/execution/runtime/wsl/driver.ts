import { lstat } from "node:fs/promises";
import { win32 as path } from "node:path";

import type {
  RuntimeBoot,
  RuntimeDriver,
  RuntimeDriverLease,
  RuntimeHealth,
  RuntimeLeaseRequest,
  StopReason,
} from "../contracts.js";
import { RuntimeManagerError } from "../manager.js";
import { validateRuntimeDistroName, WslRuntimeAdapter } from "./adapter.js";
import { createManagedRuntimeLayout, readExternalRuntimePackageManifest, recoverRuntimeActivation, type RuntimeLayout } from "./installer.js";
import { WslProvisioner, type WslCommandRunner } from "./provisioner.js";
import { WslGuestClient } from "./guest-runner.js";

class DefaultWslRuntimeDriver implements RuntimeDriver {
  private readonly runner: WslCommandRunner;
  private readonly providedClient?: WslGuestClient;
  private readonly runtimeRoot: string;
  private readonly managedWorkspacesRoot?: string;
  private readonly distroName: string;
  private adapter: WslRuntimeAdapter | null = null;
  private layout: RuntimeLayout | null = null;

  constructor(options: { runtimeRoot: string; runner: WslCommandRunner; client?: WslGuestClient; managedWorkspacesRoot?: string; distroName?: string }) {
    this.runtimeRoot = options.runtimeRoot;
    this.runner = options.runner;
    this.providedClient = options.client;
    this.managedWorkspacesRoot = options.managedWorkspacesRoot;
    this.distroName = validateRuntimeDistroName(options.distroName ?? "OpenBotRuntime");
  }

  async start(signal?: AbortSignal): Promise<RuntimeBoot> {
    const adapter = await this.prepare();
    return adapter.start(signal);
  }

  async health(boot: RuntimeBoot, signal?: AbortSignal): Promise<RuntimeHealth> {
    if (!this.adapter) return { ok: false, code: "runtime_unavailable", message: "WSL2 runtime is unavailable." };
    return this.adapter.health(boot, signal);
  }

  async acquire(request: RuntimeLeaseRequest, signal?: AbortSignal): Promise<RuntimeDriverLease> {
    if (!this.adapter) throw new RuntimeManagerError("runtime_unavailable", "WSL2 runtime is unavailable.");
    return this.adapter.acquire(request, signal);
  }

  async compensateAcquire(request: RuntimeLeaseRequest): Promise<void> {
    if (!this.adapter) return;
    await this.adapter.compensateAcquire(request);
  }

  async release(lease: RuntimeDriverLease): Promise<void> {
    if (!this.adapter) throw new RuntimeManagerError("lease_released", "Runtime lease is no longer active.");
    return this.adapter.release(lease);
  }

  async stop(reason: StopReason): Promise<void> {
    if (!this.adapter) return;
    await this.adapter.stop(reason);
    this.adapter = null;
  }

  private async prepare(): Promise<WslRuntimeAdapter> {
    if (this.adapter) return this.adapter;
    this.layout ??= await createManagedRuntimeLayout(this.runtimeRoot);
    try {
      await recoverRuntimeActivation(this.layout);
    } catch {
      throw new RuntimeManagerError("runtime_unhealthy", "Managed runtime activation state requires repair.");
    }
    const provisioner = new WslProvisioner({
      layout: this.layout,
      runner: this.runner,
      ...(this.distroName === "OpenBotRuntime" ? {} : { testOnlyDistroName: this.distroName }),
    });
    let availability = await provisioner.inspect(undefined, this.distroName);
    if (!availability.supported) throw new RuntimeManagerError("runtime_unavailable", "WSL2 is unavailable.");
    if (!availability.dedicatedDistroPresent && await this.importStagedPackage(provisioner)) {
      availability = await provisioner.inspect(undefined, this.distroName);
    }
    if (!availability.dedicatedDistroPresent) throw new RuntimeManagerError("runtime_unavailable", "OpenBotRuntime distro is not installed.");
    const client = this.providedClient ?? new WslGuestClient({
      runner: this.runner,
      distroName: this.distroName,
      managedWorkspacesRoot: this.managedWorkspacesRoot,
    });
    this.adapter = new WslRuntimeAdapter({ runtimeRoot: this.layout.root, distroName: this.distroName, transport: client });
    return this.adapter;
  }

  private async importStagedPackage(provisioner: WslProvisioner): Promise<boolean> {
    const archive = path.join(this.layout!.staging, "openbot-runtime-package.tar");
    const manifestPath = path.join(this.layout!.staging, "manifest.json");
    const archiveMetadata = await lstat(archive).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!archiveMetadata) return false;
    if (archiveMetadata.isSymbolicLink() || !archiveMetadata.isFile()) throw new RuntimeManagerError("runtime_protocol_error", "Staged runtime package is invalid.");
    const manifestMetadata = await lstat(manifestPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!manifestMetadata || manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) {
      throw new RuntimeManagerError("runtime_protocol_error", "Staged runtime manifest is invalid.");
    }
    let manifest;
    try { manifest = await readExternalRuntimePackageManifest(this.layout!); } catch { throw new RuntimeManagerError("runtime_protocol_error", "Staged runtime manifest is invalid."); }
    try {
      await provisioner.installManagedGuestPackage(archive, manifest);
    } catch {
      throw new RuntimeManagerError("runtime_unhealthy", "Managed runtime package installation failed.");
    }
    return true;
  }
}

export function createDefaultWslRuntimeDriver(options: {
  runtimeRoot: string;
  runner: WslCommandRunner;
  client?: WslGuestClient;
  managedWorkspacesRoot?: string;
  distroName?: string;
}): RuntimeDriver {
  return new DefaultWslRuntimeDriver(options);
}
