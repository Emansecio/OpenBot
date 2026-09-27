// Backup and restore of the OpenBot data roots (roaming data root and the
// local workspaces), used by the Recovery Center.
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  assertNoReparsePath,
  atomicWriteJson,
  canonicalizePath,
  copyTree,
  defaultDataRoot,
  defaultLocalDataRoot,
  isProcessRunning,
  isWithin,
  pathExists,
  randomSuffix,
  readJson,
  removeTree,
  treeDigest,
} from "./common.mjs";
import { DEFAULT_GATEWAY_URL, portInUse, processStatePath, readProcessState } from "./gateway-control.mjs";

const DATA_BACKUP_SCHEMA_VERSION = 1;
const DATA_BACKUP_ENTRY_NAMES = new Set(["roaming", "workspaces"]);

/**
 * Refuse to touch the data while a gateway may write it: the port must stay
 * closed for the whole window and no recorded gateway supervisor may be alive
 * (it reopens the port after its restart backoff).
 */
export async function assertGatewayStopped(options = {}) {
  const url = options.url ?? DEFAULT_GATEWAY_URL;
  const timeoutMs = Number(options.timeoutMs ?? 2_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("OpenBot gateway timeout must be a finite non-negative number");
  if (options.root != null) {
    const state = await readProcessState(processStatePath(options.root)).catch(() => null);
    if (state != null && await (options.isProcessRunning ?? isProcessRunning)(state.gateway.pid)) {
      throw new Error(`OpenBot gateway is still running (PID ${state.gateway.pid}); close the application before backup or restore`);
    }
  }
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await portInUse(url, Math.max(50, Math.min(500, timeoutMs || 50))))) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  } while (Date.now() <= deadline);
  throw new Error("OpenBot gateway is still running; close the application before backup or restore");
}

function backupTargets(dataRoot, localDataRoot) {
  const targets = [{ name: "roaming", source: resolve(dataRoot), destination: resolve(dataRoot) }];
  const workspaces = resolve(localDataRoot, "workspaces");
  if (!isWithin(resolve(dataRoot), workspaces) && !isWithin(workspaces, resolve(dataRoot))) {
    targets.push({ name: "workspaces", source: workspaces, destination: workspaces });
  }
  return targets;
}

async function dataRoots(options) {
  const env = options.env ?? process.env;
  return {
    dataRoot: await canonicalizePath(options.dataRoot ?? defaultDataRoot(env), { allowMissing: true, directory: true }),
    localDataRoot: await canonicalizePath(options.localDataRoot ?? defaultLocalDataRoot(env), { allowMissing: true, directory: true }),
  };
}

export async function createDataBackup(options = {}) {
  const { dataRoot, localDataRoot } = await dataRoots(options);
  let backupRoot = await canonicalizePath(options.backupRoot ?? join(localDataRoot, "backups"), { allowMissing: true, directory: true });
  if (isWithin(dataRoot, backupRoot)) {
    backupRoot = await canonicalizePath(join(dirname(localDataRoot), "OpenBot-backups"), { allowMissing: true, directory: true });
  }
  await fs.mkdir(backupRoot, { recursive: true });
  await assertNoReparsePath(backupRoot);
  const label = String(options.label ?? "backup").replaceAll(/[^A-Za-z0-9._-]/gu, "-");
  const name = `${label}-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomSuffix()}`;
  const staging = join(backupRoot, `.${name}.staging`);
  const root = join(backupRoot, name);
  const entries = [];
  try {
    await fs.mkdir(staging, { recursive: true });
    for (const target of backupTargets(dataRoot, localDataRoot)) {
      if (!(await pathExists(target.source))) {
        entries.push({ name: target.name, present: false, sha256: null });
        continue;
      }
      const destination = join(staging, target.name);
      await copyTree(target.source, destination);
      entries.push({ name: target.name, present: true, sha256: await treeDigest(destination) });
    }
    const manifest = {
      schemaVersion: DATA_BACKUP_SCHEMA_VERSION,
      product: "OpenBot",
      createdAt: new Date().toISOString(),
      entries,
    };
    await atomicWriteJson(join(staging, "manifest.json"), manifest);
    await fs.rename(staging, root);
    return { root, path: root, manifest };
  } catch (error) {
    await removeTree(staging).catch(() => undefined);
    throw error;
  }
}

export async function verifyDataBackup(backupPath) {
  const root = await canonicalizePath(backupPath, { allowMissing: false, directory: true });
  const manifest = await readJson(join(root, "manifest.json"));
  if (manifest?.schemaVersion !== DATA_BACKUP_SCHEMA_VERSION || manifest?.product !== "OpenBot" || !Array.isArray(manifest.entries)) {
    throw new Error(`Invalid OpenBot data backup: ${root}`);
  }
  const seen = new Set();
  for (const entry of manifest.entries) {
    if (entry == null || typeof entry !== "object" || !DATA_BACKUP_ENTRY_NAMES.has(entry.name) || seen.has(entry.name)) {
      throw new Error(`Invalid OpenBot backup entry: ${entry?.name ?? "unknown"}`);
    }
    seen.add(entry.name);
    if (typeof entry.present !== "boolean") throw new Error(`Invalid OpenBot backup entry state: ${entry.name}`);
    const source = join(root, entry.name);
    if (entry.present) {
      if (!(await pathExists(source))) throw new Error(`Backup entry is missing: ${entry.name}`);
      if (await treeDigest(source) !== entry.sha256) throw new Error(`Backup entry checksum mismatch: ${entry.name}`);
    } else if (entry.sha256 != null) {
      throw new Error(`Absent backup entry has a checksum: ${entry.name}`);
    }
  }
  if (!seen.has("roaming")) throw new Error("OpenBot backup has no roaming entry");
  return { ok: true, root, manifest };
}

/**
 * Replace the data roots with a verified backup. All entries are staged
 * first, then swapped; a failure puts every previous directory back. Pass
 * `verified` (a verifyDataBackup result for the same path) to skip hashing
 * the backup a second time.
 */
export async function restoreDataBackup(backupPath, options = {}) {
  const canonical = await canonicalizePath(backupPath, { allowMissing: false, directory: true });
  const { root, manifest } = options.verified?.root === canonical ? options.verified : await verifyDataBackup(canonical);
  const { dataRoot, localDataRoot } = await dataRoots(options);
  const destinations = new Map(backupTargets(dataRoot, localDataRoot).map((target) => [target.name, target.destination]));
  const prepared = [];
  try {
    for (const entry of manifest.entries) {
      const destination = destinations.get(entry.name);
      if (!destination) throw new Error(`Unsupported backup entry: ${entry.name}`);
      const item = {
        destination,
        staging: `${destination}.restore-${randomSuffix()}`,
        previous: `${destination}.restore-old-${randomSuffix()}`,
        present: entry.present === true,
        movedPrevious: false,
        promoted: false,
      };
      prepared.push(item);
      if (item.present) await copyTree(join(root, entry.name), item.staging);
    }
    for (const item of prepared) {
      if (await pathExists(item.destination)) {
        await fs.rename(item.destination, item.previous);
        item.movedPrevious = true;
      }
      if (item.present) {
        await fs.rename(item.staging, item.destination);
        item.promoted = true;
      }
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...prepared].reverse()) {
      try {
        if (item.promoted) await removeTree(item.destination);
        if (item.movedPrevious) await fs.rename(item.previous, item.destination);
      } catch (rollbackError) {
        rollbackErrors.push(new Error(`Could not put ${item.destination} back; the previous data is preserved at ${item.previous}`, { cause: rollbackError }));
      }
      await removeTree(item.staging).catch(() => undefined);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], `OpenBot restore failed and could not be fully rolled back: ${error.message}`);
    }
    throw error;
  }
  // The restore is complete; leftover copies of the replaced data are
  // reported rather than turning a successful restore into a failure.
  const leftovers = [];
  for (const item of prepared) {
    for (const path of [item.previous, item.staging]) {
      try { await removeTree(path); } catch { leftovers.push(path); }
    }
  }
  return { ok: true, root, manifest, leftovers };
}
