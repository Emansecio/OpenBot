import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { win32 as path } from "node:path";

import { assertManagedRuntimePath, validateRuntimeTestDistroName } from "./adapter.js";
import { probeWslAvailability, parseWslDistroList, type WslAvailability } from "./health.js";
import {
  CANDIDATE_RUNTIME_DISTRO,
  commitRuntimeActivation,
  MANAGED_RUNTIME_DISTRO,
  MANAGED_RUNTIME_DISTROS,
  parseRuntimeGuestPackageManifest,
  readPreviousRuntimeActivation,
  readRuntimeActivation,
  restorePreviousRuntimeActivation,
  restoreRuntimeActivation,
  sha256File,
  validateManagedRuntimeDistroName,
  type ManagedRuntimeDistro,
  type RuntimeActivationManifest,
  type RuntimeGuestPackageManifest,
  type RuntimeLayout,
} from "./installer.js";

export const MAX_WSL_OUTPUT_BYTES = 1024 * 1024;

export interface WslCommandResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface WslCommandRunner {
  run(args: readonly string[], signal?: AbortSignal, input?: Buffer): Promise<WslCommandResult>;
}

export type WslDistroTermination = "terminated" | "already-stopped" | "absent";

const isWslFailureExit = (exitCode: number | null): boolean => exitCode === 1 || exitCode === -1 || exitCode === 0xffff_ffff;

/**
 * WSL uses a non-zero status for both an absent distro and a distro that is
 * already stopped. Only those documented lifecycle diagnostics are benign;
 * an unknown failure remains fatal so cleanup cannot be reported as complete.
 */
export function classifyWslDistroTermination(result: WslCommandResult): WslDistroTermination {
  if (result.exitCode === 0) return "terminated";
  const details = `${decodeWslOutput(result.stdout)}\n${decodeWslOutput(result.stderr)}`;
  if (isWslFailureExit(result.exitCode) && /no distribution|not found|not registered|does not exist|WSL_E_DISTRO_NOT_FOUND/iu.test(details)) {
    return "absent";
  }
  if (isWslFailureExit(result.exitCode) && /already stopped|not running|is stopped/iu.test(details)) {
    return "already-stopped";
  }
  throw new Error("managed WSL runtime termination failed");
}

export function isWslDistroAbsent(result: WslCommandResult): boolean {
  if (result.exitCode === 0) return false;
  const details = `${decodeWslOutput(result.stdout)}\n${decodeWslOutput(result.stderr)}`;
  return isWslFailureExit(result.exitCode) && /no distribution|not found|not registered|does not exist|WSL_E_DISTRO_NOT_FOUND/iu.test(details);
}

export interface RuntimeInstallationResult {
  runtimeVersion: string;
  supervisorVersion: string;
  supervisorDigest: `sha256:${string}`;
  rootfsDigest: `sha256:${string}`;
  archiveDigest: `sha256:${string}`;
  distroName: string;
  rolledBack: boolean;
}

export class RuntimeInstallationError extends Error {
  readonly code = "runtime_installation_failed" as const;
  readonly rollbackError?: unknown;

  constructor(message: string, rollbackError?: unknown) {
    super(message);
    this.name = "RuntimeInstallationError";
    this.rollbackError = rollbackError;
  }
}

const validateArgs = (args: readonly string[]): void => {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.includes("\0"))) {
    throw new Error("wsl arguments are invalid");
  }
};

export function decodeWslOutput(output: Buffer): string {
  if (output.length >= 2) {
    let zeroBytes = 0;
    for (let index = 1; index < output.length; index += 2) if (output[index] === 0) zeroBytes += 1;
    if (zeroBytes >= Math.floor(output.length / 4)) return output.toString("utf16le");
  }
  return output.toString("utf8");
}

export function createWslCommandRunner(
  executable = "wsl.exe",
  spawnImpl: typeof spawn = spawn,
  killGraceMs = 2_000,
): WslCommandRunner {
  if (executable !== "wsl.exe") throw new Error("wsl executable is not allowlisted");
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > 30_000) {
    throw new Error("wsl kill grace is invalid");
  }
  return {
    run(args, signal, input) {
      validateArgs(args);
      if (signal?.aborted) return Promise.reject(new Error("wsl command was aborted"));
      return new Promise((resolve, reject) => {
        const child = spawnImpl(executable, [...args], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        let pendingError: Error | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const clearKillTimer = () => {
          if (killTimer !== undefined) clearTimeout(killTimer);
          killTimer = undefined;
        };
        const finish = (result: WslCommandResult): void => {
          if (settled) return;
          settled = true;
          clearKillTimer();
          signal?.removeEventListener("abort", abort);
          if (pendingError) reject(pendingError);
          else resolve(result);
        };
        const fail = (error: unknown): void => {
          if (settled) return;
          settled = true;
          clearKillTimer();
          signal?.removeEventListener("abort", abort);
          reject(error);
        };
        const terminateAndReject = (error: Error): void => {
          if (settled || pendingError) return;
          pendingError = error;
          try {
            child.kill();
          } catch {
            fail(error);
            return;
          }
          killTimer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* reject below */ }
            fail(error);
          }, killGraceMs);
          killTimer.unref?.();
        };
        const abort = (): void => {
          terminateAndReject(new Error("wsl command was aborted"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        child.stdin?.end(input);
        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > MAX_WSL_OUTPUT_BYTES) {
            terminateAndReject(new Error("wsl stdout exceeded the byte limit"));
            return;
          }
          stdout.push(Buffer.from(chunk));
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.byteLength;
          if (stderrBytes > MAX_WSL_OUTPUT_BYTES) {
            terminateAndReject(new Error("wsl stderr exceeded the byte limit"));
            return;
          }
          stderr.push(Buffer.from(chunk));
        });
        child.once("error", (error) => {
          if (pendingError) return;
          fail(error);
        });
        child.once("close", (exitCode) => finish({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
      });
    },
  };
}

const defaultVersion = (status: string): number | null => {
  const match = status.match(/(?:default\s+version|vers[aã]o\s+padr[aã]o)\s*:\s*(\d+)/iu);
  return match?.[1] === undefined ? null : Number(match[1]);
};

const asRecord = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
};

const parseJson = (output: Buffer, message: string): unknown => {
  try { return JSON.parse(output.toString("utf8")) as unknown; } catch { throw new Error(message); }
};

const pathJoin = (...parts: string[]): string => path.join(...parts);
const randomId = (): string => randomUUID();

export class WslProvisioner {
  private readonly layout: RuntimeLayout;
  private readonly runner: WslCommandRunner;
  private readonly testOnlyDistroName?: string;

  constructor(options: { layout: RuntimeLayout; runner: WslCommandRunner; testOnlyDistroName?: string }) {
    this.layout = options.layout;
    this.runner = options.runner;
    if (options.testOnlyDistroName !== undefined) {
      this.testOnlyDistroName = validateRuntimeTestDistroName(options.testOnlyDistroName);
    }
  }

  async inspect(signal?: AbortSignal, distroName: string = MANAGED_RUNTIME_DISTRO): Promise<WslAvailability> {
    this.validateDistroName(distroName);
    const status = await this.runner.run(["--status"], signal);
    const list = await this.runner.run(["--list", "--quiet"], signal);
    if (status.exitCode !== 0 || list.exitCode !== 0) {
      return { supported: false, dedicatedDistroPresent: false, reason: "wsl2-unavailable" };
    }
    return probeWslAvailability({
      defaultVersion: defaultVersion(decodeWslOutput(status.stdout)),
      distros: parseWslDistroList(decodeWslOutput(list.stdout)),
    }, distroName);
  }

  async importManagedDistro(archive: string, signal?: AbortSignal): Promise<void> {
    await this.importDistro(archive, MANAGED_RUNTIME_DISTRO, this.layout.distro, signal);
  }

  async importManagedGuestPackage(archive: string, manifest: RuntimeGuestPackageManifest, signal?: AbortSignal): Promise<void> {
    await this.installManagedGuestPackage(archive, manifest, signal);
  }

  /**
   * Stage and validate a package in OpenBotRuntimeCandidate, then promote it
   * to OpenBotRuntime. No mutating command accepts a personal distro name.
   */
  async installManagedGuestPackage(
    archive: string,
    manifest: RuntimeGuestPackageManifest,
    signal?: AbortSignal,
  ): Promise<RuntimeInstallationResult> {
    await this.assertArchive(archive);
    const checked = parseRuntimeGuestPackageManifest(manifest);
    const actualArchiveDigest = await sha256File(archive);
    if (checked.archiveDigest !== undefined && checked.archiveDigest !== actualArchiveDigest) {
      throw new RuntimeInstallationError("runtime package archive digest mismatch");
    }
    // The activation record always includes the digest we actually checked,
    // even when an older package omitted it from the external manifest.
    const verifiedManifest: RuntimeGuestPackageManifest = { ...checked, archiveDigest: actualArchiveDigest };
    const finalDistroName = this.finalDistroName();
    const candidateDistroName = this.candidateDistroName();
    const existing = await this.listDistros(signal);
    const hadFinal = existing.has(finalDistroName);
    const oldCurrent = await readRuntimeActivation(this.layout);
    const oldPrevious = await this.readPreviousActivationSafely();
    const candidatePath = this.candidatePath();
    const backupArchive = pathJoin(this.layout.staging, `.previous-runtime-${randomId()}.tar`);
    const oldCurrentArchive = pathJoin(this.layout.staging, `.current-runtime-before-${randomId()}.tar`);
    const oldPreviousArchive = pathJoin(this.layout.staging, `.previous-runtime-before-${randomId()}.tar`);
    let finalMutated = false;
    let candidateImported = false;
    let backupCreated = false;
    const currentArchiveSnapshot = await this.snapshotManagedArchive(pathJoin(this.layout.current, "runtime-package.tar"), oldCurrentArchive);
    const previousArchiveSnapshot = await this.snapshotManagedArchive(pathJoin(this.layout.previous, "runtime-package.tar"), oldPreviousArchive);

    try {
      if (this.testOnlyDistroName !== undefined) {
        if (hadFinal) {
          await this.exportDistro(finalDistroName, backupArchive, signal);
          backupCreated = true;
          await this.removeDistro(finalDistroName, signal);
        }
      } else if (existing.has(CANDIDATE_RUNTIME_DISTRO)) {
        await this.removeManagedDistro(CANDIDATE_RUNTIME_DISTRO, signal);
      }
      await this.resetImportDirectory(candidatePath);

      if (hadFinal && this.testOnlyDistroName === undefined) {
        await this.exportManagedDistro(MANAGED_RUNTIME_DISTRO, backupArchive, signal);
        backupCreated = true;
      }

      // Mark the attempt before invoking wsl.exe: a command can fail after
      // registering a partial distro, so failure cleanup must still run.
      candidateImported = true;
      await this.importDistro(archive, candidateDistroName, candidatePath, signal);
      await this.validateGuest(candidateDistroName, verifiedManifest, signal);
      await this.terminateDistro(candidateDistroName, signal);
      if (this.testOnlyDistroName !== undefined) {
        // The live gate has one disposable distro. Unregister the candidate
        // before importing the promoted image under the same guarded name.
        await this.unregisterDistro(candidateDistroName, signal);
      }

      if (hadFinal && this.testOnlyDistroName === undefined) {
        await this.terminateManagedDistro(MANAGED_RUNTIME_DISTRO, signal);
        await this.unregisterManagedDistro(MANAGED_RUNTIME_DISTRO, signal);
        finalMutated = true;
      }

      finalMutated = true;
      await this.resetImportDirectory(this.layout.distro);
      await this.importDistro(archive, finalDistroName, this.layout.distro, signal);
      await this.validateGuest(finalDistroName, verifiedManifest, signal);

      await commitRuntimeActivation(this.layout, verifiedManifest, undefined, {
        currentSource: archive,
        ...(backupCreated ? { previousSource: backupArchive } : {}),
        currentSnapshot: oldCurrentArchive,
        currentExisted: currentArchiveSnapshot,
        previousSnapshot: oldPreviousArchive,
        previousExisted: previousArchiveSnapshot,
      });

      if (candidateImported && this.testOnlyDistroName === undefined) {
        await this.removeManagedDistro(CANDIDATE_RUNTIME_DISTRO, signal);
      }
      await rm(backupArchive, { force: true });
      await rm(oldCurrentArchive, { force: true });
      await rm(oldPreviousArchive, { force: true });
      return {
        runtimeVersion: verifiedManifest.runtimeVersion,
        supervisorVersion: verifiedManifest.supervisorVersion,
        supervisorDigest: verifiedManifest.supervisorDigest,
        rootfsDigest: verifiedManifest.rootfsDigest,
        archiveDigest: actualArchiveDigest,
        distroName: finalDistroName,
        rolledBack: false,
      };
    } catch (error) {
      let candidateCleanupError: unknown;
      if (candidateImported) {
        try {
          // Cleanup is compensating work and must outlive the caller's
          // cancelled signal; otherwise WSL rejects it before unregistering
          // a partially imported candidate.
          await this.cleanupAfterFailure(candidateDistroName, undefined);
        } catch (cleanupFailure) {
          candidateCleanupError = cleanupFailure;
        }
      }
      let rollbackError: unknown;
      // A candidate can fail before promotion. If an existing final image was
      // snapshotted, restore it as well; otherwise the failed attempt would
      // leave the managed runtime absent even though promotion never began.
      if (finalMutated || (hadFinal && backupCreated)) {
        try {
          await this.rollbackFinal(
            hadFinal,
            backupCreated ? backupArchive : null,
            oldCurrent,
            oldPrevious,
            oldCurrentArchive,
            currentArchiveSnapshot,
            oldPreviousArchive,
            previousArchiveSnapshot,
            undefined,
          );
        } catch (rollbackFailure) {
          rollbackError = rollbackFailure;
        }
      }
      if (candidateCleanupError !== undefined || rollbackError !== undefined) {
        const failures = [error, candidateCleanupError, rollbackError].filter((failure): failure is unknown => failure !== undefined);
        const recoveryArtifacts = [
          ...(backupCreated ? [backupArchive] : []),
          ...(currentArchiveSnapshot ? [oldCurrentArchive] : []),
          ...(previousArchiveSnapshot ? [oldPreviousArchive] : []),
        ];
        const recoveryHint = recoveryArtifacts.length === 0
          ? "; no recovery artifacts were created"
          : `; recovery artifacts preserved at: ${recoveryArtifacts.join(", ")}`;
        throw new RuntimeInstallationError(
          `runtime package installation and rollback failed${recoveryHint}`,
          new AggregateError(failures, "runtime package cleanup or rollback failed"),
        );
      }
      await rm(backupArchive, { force: true }).catch(() => undefined);
      await rm(oldCurrentArchive, { force: true }).catch(() => undefined);
      await rm(oldPreviousArchive, { force: true }).catch(() => undefined);
      if (error instanceof RuntimeInstallationError) throw error;
      throw new RuntimeInstallationError("managed runtime package installation failed", error);
    }
  }

  async exportManagedDistro(distroName: ManagedRuntimeDistro, archive: string, signal?: AbortSignal): Promise<void> {
    this.validateDistroName(distroName);
    await this.exportDistro(distroName, archive, signal);
  }

  private async exportDistro(distroName: string, archive: string, signal?: AbortSignal): Promise<void> {
    this.validateDistroName(distroName);
    await this.assertArchiveDestination(archive);
    const result = await this.runner.run(["--export", distroName, archive], signal);
    if (result.exitCode !== 0) throw new Error("managed WSL runtime export failed");
  }

  async removeManagedDistro(distroName: ManagedRuntimeDistro, signal?: AbortSignal): Promise<void> {
    this.validateDistroName(distroName);
    await this.removeDistro(distroName, signal);
  }

  private async removeDistro(distroName: string, signal?: AbortSignal): Promise<void> {
    await this.terminateDistro(distroName, signal);
    await this.unregisterDistro(distroName, signal);
  }

  private async importDistro(
    archive: string,
    distroName: string,
    distroPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.validateDistroName(distroName);
    assertManagedRuntimePath(this.layout.root, distroPath);
    await this.assertArchive(archive);
    const result = await this.runner.run(["--import", distroName, distroPath, archive, "--version", "2"], signal);
    if (result.exitCode !== 0) throw new Error("managed WSL runtime import failed");
  }

  private async listDistros(signal?: AbortSignal): Promise<Set<string>> {
    const result = await this.runner.run(["--list", "--quiet"], signal);
    if (result.exitCode !== 0) throw new Error("unable to inspect WSL distros");
    const listed = new Set(parseWslDistroList(decodeWslOutput(result.stdout)));
    return this.testOnlyDistroName === undefined
      ? new Set(MANAGED_RUNTIME_DISTROS.filter((name) => listed.has(name)))
      : new Set([this.testOnlyDistroName].filter((name) => listed.has(name)));
  }

  private async validateGuest(
    distroName: string,
    manifest: RuntimeGuestPackageManifest,
    signal?: AbortSignal,
  ): Promise<void> {
    const version = await this.runner.run([
      "-d", distroName, "--user", "root", "--", "/usr/lib/openbot/supervisor", "--protocol-version", "1", "version",
    ], signal);
    if (version.exitCode !== 0) throw new Error("managed guest supervisor is unavailable");
    const versionResponse = asRecord(parseJson(version.stdout, "managed guest supervisor response is invalid"), "managed guest supervisor response is invalid");
    if (versionResponse.supervisorVersion !== manifest.supervisorVersion || versionResponse.supervisorDigest !== manifest.supervisorDigest) {
      throw new Error("managed guest supervisor manifest mismatch");
    }

    const started = await this.runner.run([
      "-d", distroName, "--user", "root", "--", "/usr/lib/openbot/supervisor", "--protocol-version", "1", "start",
    ], signal);
    if (started.exitCode !== 0) throw new Error("managed guest supervisor failed to start");
    const boot = asRecord(parseJson(started.stdout, "managed guest supervisor boot response is invalid"), "managed guest supervisor boot response is invalid");
    if (
      typeof boot.runtimeBootId !== "string" || boot.runtimeBootId.length === 0 ||
      boot.runtimeVersion !== manifest.runtimeVersion || boot.imageDigest !== manifest.rootfsDigest
    ) {
      throw new Error("managed guest supervisor boot manifest mismatch");
    }

    const health = await this.runner.run([
      "-d", distroName, "--user", "root", "--", "/usr/lib/openbot/supervisor", "--protocol-version", "1", "health", boot.runtimeBootId,
    ], signal);
    if (health.exitCode !== 0) throw new Error("managed guest supervisor health check failed");
    const healthResponse = asRecord(parseJson(health.stdout, "managed guest supervisor health response is invalid"), "managed guest supervisor health response is invalid");
    if (healthResponse.ok !== true) throw new Error("managed guest supervisor health check failed");
  }

  private async terminateManagedDistro(distroName: ManagedRuntimeDistro, signal?: AbortSignal): Promise<void> {
    await this.terminateDistro(distroName, signal);
  }

  private async terminateDistro(distroName: string, signal?: AbortSignal): Promise<void> {
    this.validateDistroName(distroName);
    const result = await this.runner.run(["--terminate", distroName], signal);
    classifyWslDistroTermination(result);
  }

  private async unregisterManagedDistro(distroName: ManagedRuntimeDistro, signal?: AbortSignal): Promise<void> {
    await this.unregisterDistro(distroName, signal);
  }

  private async unregisterDistro(distroName: string, signal?: AbortSignal): Promise<void> {
    this.validateDistroName(distroName);
    const result = await this.runner.run(["--unregister", distroName], signal);
    if (result.exitCode !== 0 && !isWslDistroAbsent(result)) {
      throw new Error("managed WSL runtime unregister failed");
    }
  }

  private async cleanupAfterFailure(distroName: string, signal?: AbortSignal): Promise<void> {
    await this.removeDistro(distroName, signal);
  }

  private async rollbackFinal(
    hadFinal: boolean,
    backupArchive: string | null,
    oldCurrent: RuntimeActivationManifest | null,
    oldPrevious: RuntimeActivationManifest | null,
    oldCurrentArchive: string,
    currentArchiveSnapshot: boolean,
    oldPreviousArchive: string,
    previousArchiveSnapshot: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.cleanupAfterFailure(this.finalDistroName(), signal);
    if (!hadFinal || backupArchive === null) {
      await restoreRuntimeActivation(this.layout, oldCurrent);
      await restorePreviousRuntimeActivation(this.layout, oldPrevious);
      await this.restoreManagedArchive(pathJoin(this.layout.current, "runtime-package.tar"), oldCurrentArchive, currentArchiveSnapshot);
      await this.restoreManagedArchive(pathJoin(this.layout.previous, "runtime-package.tar"), oldPreviousArchive, previousArchiveSnapshot);
      return;
    }
    await this.resetImportDirectory(this.layout.distro);
    await this.importDistro(backupArchive, this.finalDistroName(), this.layout.distro, signal);
    if (oldCurrent) await this.validateGuest(this.finalDistroName(), oldCurrent, signal);
    await restoreRuntimeActivation(this.layout, oldCurrent);
    await restorePreviousRuntimeActivation(this.layout, oldPrevious);
    await this.restoreManagedArchive(pathJoin(this.layout.current, "runtime-package.tar"), oldCurrentArchive, currentArchiveSnapshot);
    await this.restoreManagedArchive(pathJoin(this.layout.previous, "runtime-package.tar"), oldPreviousArchive, previousArchiveSnapshot);
  }

  private async readPreviousActivationSafely(): Promise<RuntimeActivationManifest | null> {
    try { return await readPreviousRuntimeActivation(this.layout); } catch { return null; }
  }

  private candidatePath(): string {
    return pathJoin(this.layout.root, "distro-candidate");
  }

  private finalDistroName(): string {
    return this.testOnlyDistroName ?? MANAGED_RUNTIME_DISTRO;
  }

  private candidateDistroName(): string {
    return this.testOnlyDistroName ?? CANDIDATE_RUNTIME_DISTRO;
  }

  private validateDistroName(name: string): void {
    if (this.testOnlyDistroName === undefined) {
      validateManagedRuntimeDistroName(name);
    } else if (name !== this.testOnlyDistroName) {
      throw new Error("runtime test distro override escaped its allowlisted prefix");
    }
  }

  private async resetImportDirectory(directory: string): Promise<void> {
    assertManagedRuntimePath(this.layout.root, directory);
    const metadata = await lstat(directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (metadata?.isSymbolicLink()) throw new Error("managed runtime import directory is unsafe");
    if (metadata && !metadata.isDirectory()) throw new Error("managed runtime import directory is invalid");
    if (metadata) await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
  }

  private async assertArchive(archive: string): Promise<void> {
    assertManagedRuntimePath(this.layout.staging, archive);
    const metadata = await lstat(archive);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("runtime archive is invalid");
  }

  private async assertArchiveDestination(archive: string): Promise<void> {
    assertManagedRuntimePath(this.layout.staging, archive);
    const metadata = await lstat(archive).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (metadata?.isSymbolicLink() || metadata?.isDirectory()) throw new Error("runtime archive destination is invalid");
  }

  private async snapshotManagedArchive(source: string, snapshot: string): Promise<boolean> {
    const metadata = await lstat(source).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return false;
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("managed runtime archive is invalid");
    await copyFile(source, snapshot);
    return true;
  }

  private async restoreManagedArchive(destination: string, snapshot: string, existed: boolean): Promise<void> {
    if (existed) {
      await this.copyManagedArchive(snapshot, destination);
      return;
    }
    await rm(destination, { force: true });
  }

  private async copyManagedArchive(source: string, destination: string): Promise<void> {
    const sourceMetadata = await lstat(source);
    if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) throw new Error("managed runtime archive source is invalid");
    const destinationMetadata = await lstat(destination).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (destinationMetadata?.isSymbolicLink() || destinationMetadata?.isDirectory()) throw new Error("managed runtime archive destination is invalid");
    await copyFile(source, destination);
  }
}
