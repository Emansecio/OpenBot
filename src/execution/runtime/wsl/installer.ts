import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile, lstat, unlink, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { win32 as path } from "node:path";

import { assertManagedRuntimePath, validateRuntimeDistroName } from "./adapter.js";

export interface RuntimeLayout {
  root: string;
  distro: string;
  images: string;
  state: string;
  staging: string;
  current: string;
  previous: string;
}

export interface RuntimeImageManifest {
  schemaVersion: 1;
  runtimeVersion: string;
  imageDigest: `sha256:${string}`;
}

export interface RuntimeGuestPackageManifest {
  schemaVersion: 1;
  runtimeVersion: string;
  supervisorVersion: string;
  supervisorDigest: `sha256:${string}`;
  rootfsDigest: `sha256:${string}`;
  /** Digest of the external WSL archive, when the packager supplied one. */
  archiveDigest?: `sha256:${string}`;
}

const MANIFEST_NAME = "runtime-manifest.json";
export const EXTERNAL_PACKAGE_MANIFEST_NAME = "manifest.json";
export const MANAGED_RUNTIME_DISTRO = "OpenBotRuntime" as const;
export const CANDIDATE_RUNTIME_DISTRO = "OpenBotRuntimeCandidate" as const;
export const MANAGED_RUNTIME_DISTROS = [MANAGED_RUNTIME_DISTRO, CANDIDATE_RUNTIME_DISTRO] as const;
const ACTIVATION_MANIFEST_NAME = "manifest.json";
const ACTIVATION_JOURNAL_NAME = "activation-transaction.json";

export type ManagedRuntimeDistro = (typeof MANAGED_RUNTIME_DISTROS)[number];

export interface RuntimeActivationManifest extends RuntimeGuestPackageManifest {
  schemaVersion: 1;
  distroName: typeof MANAGED_RUNTIME_DISTRO;
  activatedAt: string;
}

export interface RuntimeActivationJournal {
  schemaVersion: 1;
  phase: "prepared" | "current-committed";
  transactionId: string;
  previousCurrent: RuntimeActivationManifest | null;
  previousPrevious: RuntimeActivationManifest | null;
  nextCurrent: RuntimeActivationManifest;
  archives?: {
    current: { snapshotPath: string; existed: boolean };
    previous: { snapshotPath: string; existed: boolean };
  };
}

export interface RuntimeActivationArchivePlan {
  currentSource: string;
  previousSource?: string;
  currentSnapshot: string;
  currentExisted: boolean;
  previousSnapshot: string;
  previousExisted: boolean;
}

export function defaultRuntimeRoot(): string {
  const explicitRoot = process.env.OPENBOT_LOCAL_DATA_ROOT?.trim();
  if (explicitRoot) return path.join(explicitRoot, "runtime");
  const local = process.env.LOCALAPPDATA;
  const base = local && local.length > 0 ? local : path.join(homedir(), "AppData", "Local");
  return path.join(base, "OpenBot", "runtime");
}

export function validateManagedRuntimeDistroName(name: string): ManagedRuntimeDistro {
  if (!MANAGED_RUNTIME_DISTROS.includes(name as ManagedRuntimeDistro)) {
    throw new Error("runtime distro is not an allowlisted managed OpenBot distro");
  }
  return name as ManagedRuntimeDistro;
}

export function validateActivationDistroName(name: string): typeof MANAGED_RUNTIME_DISTRO {
  if (name !== MANAGED_RUNTIME_DISTRO) throw new Error("runtime activation must target OpenBotRuntime");
  return name;
}

const ensureDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("runtime directory is unsafe");
};

export async function createManagedRuntimeLayout(root: string): Promise<RuntimeLayout> {
  await ensureDirectory(root);
  const resolved = path.resolve(root);
  const layout: RuntimeLayout = {
    root: resolved,
    distro: path.join(resolved, "distro"),
    images: path.join(resolved, "images"),
    state: path.join(resolved, "state"),
    staging: path.join(resolved, "staging"),
    current: path.join(resolved, "current"),
    previous: path.join(resolved, "previous"),
  };
  for (const directory of Object.values(layout)) {
    assertManagedRuntimePath(resolved, directory);
    await ensureDirectory(directory);
  }
  validateRuntimeDistroName("OpenBotRuntime");
  return layout;
}

export function parseRuntimeGuestPackageManifest(value: unknown): RuntimeGuestPackageManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("runtime guest manifest is invalid");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !["schemaVersion", "runtimeVersion", "supervisorVersion", "supervisorDigest", "rootfsDigest", "archiveDigest"].includes(key)) ||
    input.schemaVersion !== 1 ||
    typeof input.runtimeVersion !== "string" || input.runtimeVersion.length === 0 ||
    typeof input.supervisorVersion !== "string" || input.supervisorVersion.length === 0 ||
    typeof input.supervisorDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.supervisorDigest) ||
    typeof input.rootfsDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.rootfsDigest) ||
    (input.archiveDigest !== undefined && (typeof input.archiveDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.archiveDigest)))
  ) throw new Error("runtime guest manifest is invalid");
  return {
    schemaVersion: 1,
    runtimeVersion: input.runtimeVersion,
    supervisorVersion: input.supervisorVersion,
    supervisorDigest: input.supervisorDigest as `sha256:${string}`,
    rootfsDigest: input.rootfsDigest as `sha256:${string}`,
    ...(input.archiveDigest === undefined ? {} : { archiveDigest: input.archiveDigest as `sha256:${string}` }),
  };
}

export function parseRuntimeActivationManifest(value: unknown): RuntimeActivationManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("runtime activation manifest is invalid");
  const input = value as Record<string, unknown>;
  const packageManifest = parseRuntimeGuestPackageManifest({
    schemaVersion: input.schemaVersion,
    runtimeVersion: input.runtimeVersion,
    supervisorVersion: input.supervisorVersion,
    supervisorDigest: input.supervisorDigest,
    rootfsDigest: input.rootfsDigest,
    ...(input.archiveDigest === undefined ? {} : { archiveDigest: input.archiveDigest }),
  });
  if (Object.keys(input).some((key) => ![
    "schemaVersion", "runtimeVersion", "supervisorVersion", "supervisorDigest", "rootfsDigest", "archiveDigest", "distroName", "activatedAt",
  ].includes(key)) || input.distroName !== MANAGED_RUNTIME_DISTRO || typeof input.activatedAt !== "string" || input.activatedAt.length === 0) {
    throw new Error("runtime activation manifest is invalid");
  }
  return {
    ...packageManifest,
    distroName: MANAGED_RUNTIME_DISTRO,
    activatedAt: input.activatedAt,
  };
}

const parseManifest = (value: unknown): RuntimeImageManifest => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("runtime manifest is invalid");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !["schemaVersion", "runtimeVersion", "imageDigest"].includes(key)) ||
    input.schemaVersion !== 1 ||
    typeof input.runtimeVersion !== "string" || input.runtimeVersion.length === 0 ||
    typeof input.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.imageDigest)
  ) {
    throw new Error("runtime manifest is invalid");
  }
  return {
    schemaVersion: 1,
    runtimeVersion: input.runtimeVersion,
    imageDigest: input.imageDigest as `sha256:${string}`,
  };
};

export async function writeRuntimeManifest(layout: RuntimeLayout, manifest: RuntimeImageManifest): Promise<void> {
  const checked = parseManifest(manifest);
  assertManagedRuntimePath(layout.root, layout.staging);
  const target = path.join(layout.staging, MANIFEST_NAME);
  const temporary = path.join(layout.staging, `.runtime-manifest-${randomUUID()}.tmp`);
  let promoted = false;
  try {
    await writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
    promoted = true;
  } finally {
    if (!promoted) await unlink(temporary).catch(() => undefined);
  }
}

export async function readRuntimeManifest(layout: RuntimeLayout): Promise<RuntimeImageManifest> {
  assertManagedRuntimePath(layout.root, layout.staging);
  const target = path.join(layout.staging, MANIFEST_NAME);
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("runtime manifest is invalid");
  const raw = await readFile(target, "utf8");
  return parseManifest(JSON.parse(raw) as unknown);
}

const writeJsonAtomically = async (target: string, value: unknown, root: string): Promise<void> => {
  assertManagedRuntimePath(root, target);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const activationManifestPath = (slot: string): string => path.join(slot, ACTIVATION_MANIFEST_NAME);

export async function readRuntimeActivation(layout: RuntimeLayout): Promise<RuntimeActivationManifest | null> {
  assertManagedRuntimePath(layout.root, layout.current);
  const target = activationManifestPath(layout.current);
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("runtime activation manifest is invalid");
    return parseRuntimeActivationManifest(JSON.parse(await readFile(target, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readPreviousRuntimeActivation(layout: RuntimeLayout): Promise<RuntimeActivationManifest | null> {
  assertManagedRuntimePath(layout.root, layout.previous);
  const target = activationManifestPath(layout.previous);
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("previous runtime activation manifest is invalid");
    return parseRuntimeActivationManifest(JSON.parse(await readFile(target, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function commitRuntimeActivation(
  layout: RuntimeLayout,
  manifest: RuntimeGuestPackageManifest,
  now = new Date(),
  archivePlan?: RuntimeActivationArchivePlan,
): Promise<RuntimeActivationManifest> {
  const checked = parseRuntimeGuestPackageManifest(manifest);
  const previousCurrent = await readRuntimeActivation(layout);
  const previousPrevious = await readPreviousRuntimeActivation(layout);
  const next: RuntimeActivationManifest = {
    ...checked,
    distroName: MANAGED_RUNTIME_DISTRO,
    activatedAt: now.toISOString(),
  };
  const journal: RuntimeActivationJournal = {
    schemaVersion: 1,
    phase: "prepared",
    transactionId: randomUUID(),
    previousCurrent,
    previousPrevious,
    nextCurrent: next,
    ...(archivePlan === undefined ? {} : {
      archives: {
        current: {
          snapshotPath: validateArchiveSnapshotPath(layout, archivePlan.currentSnapshot),
          existed: archivePlan.currentExisted,
        },
        previous: {
          snapshotPath: validateArchiveSnapshotPath(layout, archivePlan.previousSnapshot),
          existed: archivePlan.previousExisted,
        },
      },
    }),
  };
  if (archivePlan !== undefined) {
    validateArchiveSourcePath(layout, archivePlan.currentSource);
    if (archivePlan.previousSource !== undefined) validateArchiveSourcePath(layout, archivePlan.previousSource);
  }
  const journalPath = path.join(layout.state, ACTIVATION_JOURNAL_NAME);
  await writeJsonAtomically(journalPath, journal, layout.root);
  if (archivePlan !== undefined) {
    await copyManagedArchive(archivePlan.currentSource, path.join(layout.current, "runtime-package.tar"), layout.root);
    if (archivePlan.previousSource !== undefined) {
      await copyManagedArchive(archivePlan.previousSource, path.join(layout.previous, "runtime-package.tar"), layout.root);
    }
  }
  // Failures deliberately leave the journal for the next boot. The old current
  // record is never deleted, so promotion cannot produce an empty runtime.
  if (previousCurrent) await writeJsonAtomically(activationManifestPath(layout.previous), previousCurrent, layout.root);
  await writeJsonAtomically(activationManifestPath(layout.current), next, layout.root);
  await writeJsonAtomically(journalPath, { ...journal, phase: "current-committed" }, layout.root);
  await unlink(journalPath).catch(() => undefined);
  return next;
}

export async function recoverRuntimeActivation(layout: RuntimeLayout): Promise<void> {
  const journalPath = path.join(layout.state, ACTIVATION_JOURNAL_NAME);
  let raw: string;
  try {
    raw = await readFile(journalPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const input = JSON.parse(raw) as unknown;
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("runtime activation journal is invalid");
  const journal = input as Record<string, unknown>;
  if (
    journal.schemaVersion !== 1 ||
    (journal.phase !== "prepared" && journal.phase !== "current-committed") ||
    typeof journal.transactionId !== "string" || journal.transactionId.length === 0
  ) {
    throw new Error("runtime activation journal is invalid");
  }
  const previousCurrent = journal.previousCurrent === null ? null : parseRuntimeActivationManifest(journal.previousCurrent);
  const previousPrevious = journal.previousPrevious === null ? null : parseRuntimeActivationManifest(journal.previousPrevious);
  const nextCurrent = parseRuntimeActivationManifest(journal.nextCurrent);
  const archives = parseArchiveJournal(layout, journal.archives);
  if (journal.phase === "prepared") {
    await restoreRuntimeActivation(layout, previousCurrent);
    await restorePreviousRuntimeActivation(layout, previousPrevious);
    if (archives) {
      await restoreArchiveSnapshot(layout, "current", archives.current);
      await restoreArchiveSnapshot(layout, "previous", archives.previous);
    }
  } else {
    await restoreRuntimeActivation(layout, nextCurrent);
    await restorePreviousRuntimeActivation(layout, previousCurrent);
  }
  if (archives) {
    await removeArchiveSnapshot(layout, archives.current);
    await removeArchiveSnapshot(layout, archives.previous);
  }
  await unlink(journalPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

type RuntimeActivationArchiveJournal = NonNullable<RuntimeActivationJournal["archives"]>;

function validateArchiveSourcePath(layout: RuntimeLayout, candidate: string): void {
  assertManagedRuntimePath(layout.staging, candidate);
}

function validateArchiveSnapshotPath(layout: RuntimeLayout, candidate: string): string {
  validateArchiveSourcePath(layout, candidate);
  return candidate;
}

function parseArchiveJournal(layout: RuntimeLayout, value: unknown): RuntimeActivationArchiveJournal | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("runtime activation journal is invalid");
  const input = value as Record<string, unknown>;
  const parseSlot = (slot: unknown): { snapshotPath: string; existed: boolean } => {
    if (typeof slot !== "object" || slot === null || Array.isArray(slot)) throw new Error("runtime activation journal is invalid");
    const record = slot as Record<string, unknown>;
    if (typeof record.snapshotPath !== "string" || typeof record.existed !== "boolean") throw new Error("runtime activation journal is invalid");
    return { snapshotPath: validateArchiveSnapshotPath(layout, record.snapshotPath), existed: record.existed };
  };
  if (!("current" in input) || !("previous" in input)) throw new Error("runtime activation journal is invalid");
  return { current: parseSlot(input.current), previous: parseSlot(input.previous) };
}

async function copyManagedArchive(source: string, destination: string, root: string): Promise<void> {
  assertManagedRuntimePath(root, source);
  assertManagedRuntimePath(root, destination);
  const sourceMetadata = await lstat(source);
  if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) throw new Error("managed runtime archive source is invalid");
  const destinationMetadata = await lstat(destination).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (destinationMetadata?.isSymbolicLink() || destinationMetadata?.isDirectory()) throw new Error("managed runtime archive destination is invalid");
  await copyFile(source, destination);
}

async function restoreArchiveSnapshot(
  layout: RuntimeLayout,
  slot: "current" | "previous",
  snapshot: { snapshotPath: string; existed: boolean },
): Promise<void> {
  const destination = path.join(slot === "current" ? layout.current : layout.previous, "runtime-package.tar");
  if (snapshot.existed) {
    await copyManagedArchive(snapshot.snapshotPath, destination, layout.root);
  } else {
    assertManagedRuntimePath(layout.root, destination);
    await rm(destination, { force: true });
  }
}

async function removeArchiveSnapshot(layout: RuntimeLayout, snapshot: { snapshotPath: string }): Promise<void> {
  validateArchiveSnapshotPath(layout, snapshot.snapshotPath);
  await unlink(snapshot.snapshotPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

export async function restoreRuntimeActivation(layout: RuntimeLayout, manifest: RuntimeActivationManifest | null): Promise<void> {
  await restoreRuntimeActivationSlot(layout, "current", manifest);
}

export async function restorePreviousRuntimeActivation(layout: RuntimeLayout, manifest: RuntimeActivationManifest | null): Promise<void> {
  await restoreRuntimeActivationSlot(layout, "previous", manifest);
}

async function restoreRuntimeActivationSlot(
  layout: RuntimeLayout,
  slot: "current" | "previous",
  manifest: RuntimeActivationManifest | null,
): Promise<void> {
  const target = activationManifestPath(slot === "current" ? layout.current : layout.previous);
  if (manifest === null) {
    await unlink(target).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return;
  }
  await writeJsonAtomically(target, parseRuntimeActivationManifest(manifest), layout.root);
}

export async function readExternalRuntimePackageManifest(layout: RuntimeLayout): Promise<RuntimeGuestPackageManifest> {
  assertManagedRuntimePath(layout.root, layout.staging);
  const target = path.join(layout.staging, EXTERNAL_PACKAGE_MANIFEST_NAME);
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("runtime external manifest is invalid");
  const raw = await readFile(target, "utf8");
  try {
    return parseRuntimeGuestPackageManifest(JSON.parse(raw) as unknown);
  } catch {
    throw new Error("runtime external manifest is invalid");
  }
}

export async function writeExternalRuntimePackageManifest(layout: RuntimeLayout, manifest: RuntimeGuestPackageManifest): Promise<void> {
  const checked = parseRuntimeGuestPackageManifest(manifest);
  await writeJsonAtomically(path.join(layout.staging, EXTERNAL_PACKAGE_MANIFEST_NAME), checked, layout.root);
}

export async function sha256File(file: string): Promise<`sha256:${string}`> {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolveDigest(`sha256:${hash.digest("hex")}`));
  });
}
