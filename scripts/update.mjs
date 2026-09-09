import { promises as fs } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import {
  assertManagedInstallRoot,
  acquireInstallLock,
  assertPreflight,
  atomicWriteJson,
  assertNoReparsePath,
  assertNoReparseTree,
  canonicalizeInstallRoot,
  canonicalizePath,
  copyTree,
  defaultDataRoot,
  defaultInstallRoot,
  defaultLocalDataRoot,
  installLayout,
  isWithin,
  isMainModule,
  materializePackage,
  parseArgs,
  pathExists,
  quiesceInstall,
  randomSuffix,
  readInstallState,
  readJson,
  removeTree,
  safeVersion,
  shortcutPaths,
  stateReleaseId,
  treeDigest,
  validateReleaseManifest,
  writeInstallState,
  writeStableLauncher,
} from "./release-common.mjs";
import { writeReleaseShortcuts } from "./install.mjs";

const DATA_BACKUP_SCHEMA_VERSION = 1;
const DATA_BACKUP_ENTRY_NAMES = new Set(["roaming", "workspaces"]);

async function gatewayIsRunning(url, timeoutMs) {
  const parsed = new URL(String(url));
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("OpenBot gateway URL must be loopback");
  }
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  return new Promise((resolvePort) => {
    const socket = net.createConnection({ host: parsed.hostname.replace(/^\[|\]$/gu, ""), port });
    const finish = (present) => { socket.destroy(); resolvePort(present); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function assertGatewayStopped(url = "http://127.0.0.1:1340", timeoutMs = 2_000) {
  const normalizedTimeout = Number(timeoutMs);
  if (!Number.isFinite(normalizedTimeout) || normalizedTimeout < 0) {
    throw new Error("OpenBot gateway timeout must be a finite non-negative number");
  }
  const deadline = Date.now() + normalizedTimeout;
  do {
    if (!(await gatewayIsRunning(url, Math.max(50, Math.min(500, Number(timeoutMs) || 50))))) return true;
    if (Date.now() >= deadline) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  } while (Date.now() <= deadline);
  throw new Error("OpenBot gateway is still running; close the application before backup or update");
}

function backupTargets(dataRoot, localDataRoot) {
  const targets = [{ name: "roaming", source: resolve(dataRoot), destination: resolve(dataRoot) }];
  const workspaces = resolve(localDataRoot, "workspaces");
  if (!isWithin(resolve(dataRoot), workspaces) && !isWithin(workspaces, resolve(dataRoot))) {
    targets.push({ name: "workspaces", source: workspaces, destination: workspaces });
  }
  return targets;
}

export async function createDataBackup(options = {}) {
  const dataRoot = await canonicalizePath(options.dataRoot ?? defaultDataRoot(options.env ?? process.env), { allowMissing: true, directory: true });
  const localDataRoot = await canonicalizePath(options.localDataRoot ?? defaultLocalDataRoot(options.env ?? process.env), { allowMissing: true, directory: true });
  let backupRoot = await canonicalizePath(options.backupRoot ?? join(localDataRoot, "backups"), { allowMissing: true, directory: true });
  if (isWithin(dataRoot, backupRoot)) {
    backupRoot = await canonicalizePath(join(dirname(localDataRoot), "OpenBot-backups"), { allowMissing: true, directory: true });
  }
  await fs.mkdir(backupRoot, { recursive: true });
  await assertNoReparsePath(backupRoot);
  const label = String(options.activeVersion ?? "unknown").replaceAll(/[^A-Za-z0-9._-]/gu, "-");
  const name = `update-${label}-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomSuffix()}`;
  const staging = join(backupRoot, `.${name}.staging`);
  const root = join(backupRoot, name);
  const entries = [];
  try {
    await fs.mkdir(staging, { recursive: true });
    for (const target of backupTargets(dataRoot, localDataRoot)) {
      const present = await pathExists(target.source);
      if (!present) {
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
      activeVersion: options.activeVersion ?? null,
      activeReleaseId: options.activeReleaseId ?? null,
      createdAt: new Date().toISOString(),
      entries,
    };
    await atomicWriteJson(join(staging, "manifest.json"), manifest);
    await fs.rename(staging, root);
    return { root, path: root, manifest };
  } catch (error) {
    await removeTree(staging);
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
      const digest = await treeDigest(source);
      if (digest !== entry.sha256) throw new Error(`Backup entry checksum mismatch: ${entry.name}`);
    } else if (entry.sha256 != null) {
      throw new Error(`Absent backup entry has a checksum: ${entry.name}`);
    }
  }
  if (!seen.has("roaming")) throw new Error("OpenBot backup has no roaming entry");
  return { ok: true, root, manifest };
}

export async function restoreDataBackup(backupPath, options = {}) {
  const { root, manifest } = await verifyDataBackup(backupPath);
  const dataRoot = await canonicalizePath(options.dataRoot ?? defaultDataRoot(options.env ?? process.env), { allowMissing: true, directory: true });
  const localDataRoot = await canonicalizePath(options.localDataRoot ?? defaultLocalDataRoot(options.env ?? process.env), { allowMissing: true, directory: true });
  const destinations = new Map(backupTargets(dataRoot, localDataRoot).map((target) => [target.name, target.destination]));
  const prepared = [];
  try {
    for (const entry of manifest.entries) {
      const destination = destinations.get(entry.name);
      if (!destination) throw new Error(`Unsupported backup entry: ${entry.name}`);
      const source = join(root, entry.name);
      const staging = `${destination}.restore-${randomSuffix()}`;
      const previous = `${destination}.restore-old-${randomSuffix()}`;
      if (entry.present === true) {
        await copyTree(source, staging);
      }
      prepared.push({ destination, staging, previous, present: entry.present === true, movedPrevious: false, promoted: false });
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
    for (const item of [...prepared].reverse()) {
      if (item.promoted) await removeTree(item.destination).catch(() => undefined);
      if (item.movedPrevious && await pathExists(item.previous)) {
        await fs.rename(item.previous, item.destination).catch(() => undefined);
      }
      await removeTree(item.staging).catch(() => undefined);
    }
    throw error;
  }
  for (const item of prepared) {
    await removeTree(item.previous);
    await removeTree(item.staging);
  }
  return { ok: true, root, manifest };
}

async function readManagedState(root) {
  const state = await readInstallState(root);
  assertManagedInstallRoot(root, state);
  if (!state.activeVersion) throw new Error(`Install has no active version: ${root}`);
  return { ...state, activeVersion: safeVersion(state.activeVersion), activeReleaseId: stateReleaseId(state) };
}

async function stageUpdateLocked(options = {}) {
  if (!options.packagePath) throw new Error("--package is required for staging");
  const root = await canonicalizeInstallRoot(options.installRoot ?? defaultInstallRoot(options.env ?? process.env));
  const layout = installLayout(root);
  const state = await readManagedState(root);
  const materialized = await materializePackage(options.packagePath);
  let staging = null;
  try {
    const manifest = await validateReleaseManifest(materialized.root, { arch: options.arch ?? process.arch });
    await assertPreflight(materialized.root, { arch: manifest.arch });
    if (manifest.buildId === state.activeBuildId && manifest.contentSha256 === state.activeContentSha256) {
      throw new Error(`Release ${manifest.releaseId} is already active; use repair for the exact same build`);
    }
    await fs.mkdir(layout.staging, { recursive: true });
    await assertNoReparsePath(layout.staging);
    staging = join(layout.staging, `${manifest.releaseId}.${randomSuffix()}`);
    await copyTree(materialized.root, staging);
    await assertPreflight(staging, { arch: manifest.arch });
    await assertNoReparseTree(staging);
    const nextState = await writeInstallState(root, {
      ...state,
      stagedVersion: manifest.version,
      stagedBuildId: manifest.buildId,
      stagedReleaseId: manifest.releaseId,
      stagedPath: staging,
      stagedManifestSha256: manifest.contentSha256,
    });
    return { ok: true, root, version: manifest.version, releaseId: manifest.releaseId, staging, state: nextState };
  } catch (error) {
    if (staging) await removeTree(staging);
    throw error;
  } finally {
    await materialized.cleanup();
  }
}

export async function stageUpdate(options = {}) {
  const root = await canonicalizeInstallRoot(options.installRoot ?? defaultInstallRoot(options.env ?? process.env));
  if (options.lock != null) return stageUpdateLocked({ ...options, installRoot: root });
  const lock = await acquireInstallLock(root, { timeoutMs: options.lockTimeoutMs, operation: "stage" });
  try {
    return await stageUpdateLocked({ ...options, installRoot: root, lock });
  } finally {
    await lock.release();
  }
}

async function stageForApply(options, root, state) {
  if (options.packagePath) return stageUpdateLocked(options);
  if (!state.stagedPath) throw new Error("No staged release is available; pass --package or run --stage first");
  const canonicalStaging = await canonicalizePath(state.stagedPath, { allowMissing: false, directory: true });
  if (!isWithin(installLayout(root).staging, canonicalStaging)) {
    throw new Error("Refusing to apply a staged release outside the managed staging directory");
  }
  await assertNoReparseTree(canonicalStaging);
  await assertPreflight(canonicalStaging, { arch: options.arch ?? process.arch });
  return { ok: true, root, version: state.stagedVersion, releaseId: state.stagedReleaseId, staging: canonicalStaging, state };
}

async function updateReleaseLocked(options = {}) {
  const root = await canonicalizeInstallRoot(options.installRoot ?? defaultInstallRoot(options.env ?? process.env));
  const layout = installLayout(root);
  const initialState = await readManagedState(root);
  const staged = await stageForApply(options, root, initialState);
  if (options.stageOnly === true) return staged;

  let target = null;
  let targetBackup = null;
  let committed = false;
  let dataBackup = null;
  try {
    const quiesced = await quiesceInstall(root, {
      timeoutMs: options.quiesceTimeoutMs,
      taskkillPath: options.taskkillPath,
      gatewayUrl: options.gatewayUrl,
      isPortPresent: options.isPortPresent,
      queryProcessEvidence: options.queryProcessEvidence,
    });
    await (options.assertGatewayStopped ?? assertGatewayStopped)(quiesced.gatewayUrl, options.gatewayStopTimeoutMs);
    dataBackup = await createDataBackup({
      dataRoot: initialState.dataRoot ?? defaultDataRoot(options.env ?? process.env),
      localDataRoot: initialState.localDataRoot ?? defaultLocalDataRoot(options.env ?? process.env),
      backupRoot: options.backupRoot,
      activeVersion: initialState.activeVersion,
      activeReleaseId: initialState.activeReleaseId,
      env: options.env ?? process.env,
    });
    const nextRoot = resolve(staged.staging);
    const manifest = (await validateReleaseManifest(nextRoot, { arch: options.arch ?? process.arch }));
    target = join(layout.versions, manifest.releaseId);
    await fs.mkdir(layout.versions, { recursive: true });
    await assertNoReparsePath(layout.versions);
    if (await pathExists(target)) {
      await assertNoReparsePath(target);
      await assertNoReparseTree(target);
      targetBackup = `${target}.rollback-${randomSuffix()}`;
      await fs.rename(target, targetBackup);
    }
    await assertNoReparseTree(nextRoot);
    await fs.rename(nextRoot, target);
    committed = true;
    await assertNoReparseTree(target);
    const promotedTarget = await canonicalizePath(target, { allowMissing: false, directory: true });
    if (promotedTarget.toLowerCase() !== target.toLowerCase()) {
      throw new Error(`Staging promotion changed release identity: ${target}`);
    }
    if (options.simulateFailure === true) throw new Error("Simulated update failure before commit finalization");
    await writeStableLauncher(root, manifest.releaseId, manifest.version);
    const shortcuts = shortcutPaths(initialState.shortcutRoot, options.env ?? process.env);
    await writeReleaseShortcuts(root, shortcuts, { env: options.env ?? process.env, releaseId: manifest.releaseId });
    const nextState = await writeInstallState(root, {
      ...initialState,
      shortcuts,
      activeVersion: manifest.version,
      activeBuildId: manifest.buildId,
      activeReleaseId: manifest.releaseId,
      activeContentSha256: manifest.contentSha256,
      activeGeneratedAt: manifest.generatedAt,
      manifestSha256: manifest.contentSha256,
      previousVersion: initialState.activeVersion,
      previousBuildId: initialState.activeBuildId ?? null,
      previousReleaseId: initialState.activeReleaseId,
      previousContentSha256: initialState.activeContentSha256 ?? initialState.manifestSha256 ?? null,
      previousGeneratedAt: initialState.activeGeneratedAt ?? null,
      stagedVersion: null,
      stagedBuildId: null,
      stagedReleaseId: null,
      stagedPath: null,
      stagedManifestSha256: null,
      lastBackup: {
        path: dataBackup.path,
        fromVersion: initialState.activeVersion,
        fromReleaseId: initialState.activeReleaseId,
        createdAt: dataBackup.manifest.createdAt,
      },
      lastFailure: null,
    });
    if (options.failAfterCommit === true) throw new Error("Simulated update failure after commit");
    if (targetBackup) await removeTree(targetBackup);
    return {
      ok: true,
      root,
      version: manifest.version,
      releaseId: manifest.releaseId,
      previousVersion: initialState.activeVersion,
      backup: nextState.lastBackup,
      state: nextState,
    };
  } catch (error) {
    if (committed && target) {
      await removeTree(target);
    }
    if (targetBackup && await pathExists(targetBackup)) {
      await fs.rename(targetBackup, target);
    }
    const attemptedStaging = staged.staging ? resolve(staged.staging) : null;
    const stagingRoot = resolve(layout.staging);
    if (attemptedStaging && attemptedStaging !== stagingRoot && isWithin(stagingRoot, attemptedStaging)) {
      await removeTree(attemptedStaging);
    }
    const failure = {
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
      attemptedVersion: staged.version ?? null,
      rolledBack: true,
    };
    await writeStableLauncher(root, initialState.activeReleaseId, initialState.activeVersion).catch(() => undefined);
    const rollbackState = options.packagePath
      ? initialState
      : { ...initialState, stagedVersion: null, stagedBuildId: null, stagedReleaseId: null, stagedPath: null, stagedManifestSha256: null };
    const lastBackup = dataBackup == null ? rollbackState.lastBackup : {
      path: dataBackup.path,
      fromVersion: initialState.activeVersion,
      fromReleaseId: initialState.activeReleaseId,
      createdAt: dataBackup.manifest.createdAt,
    };
    await writeInstallState(root, { ...rollbackState, lastBackup, lastFailure: failure }).catch(() => undefined);
    if (options.throwOnFailure === false) {
      return { ok: false, rolledBack: true, root, activeVersion: initialState.activeVersion, error: failure };
    }
    const wrapped = new Error(`${failure.message} (rolled back to ${initialState.activeVersion})`);
    wrapped.cause = error;
    wrapped.rolledBack = true;
    throw wrapped;
  }
}

export async function updateRelease(options = {}) {
  const root = await canonicalizeInstallRoot(options.installRoot ?? defaultInstallRoot(options.env ?? process.env));
  if (options.lock != null) return updateReleaseLocked({ ...options, installRoot: root });
  const lock = await acquireInstallLock(root, {
    timeoutMs: options.lockTimeoutMs,
    operation: "update",
    captureProcessEvidence: options.captureProcessEvidence,
    queryProcessEvidence: options.queryProcessEvidence,
  });
  try {
    return await updateReleaseLocked({ ...options, installRoot: root, lock });
  } finally {
    await lock.release();
  }
}

async function rollbackReleaseLocked(options = {}) {
  const root = await canonicalizeInstallRoot(options.installRoot ?? defaultInstallRoot(options.env ?? process.env));
  const state = await readManagedState(root);
  if (!state.previousVersion) throw new Error("No previous release is available for rollback");
  const targetVersion = safeVersion(state.previousVersion);
  const targetReleaseId = stateReleaseId(state, "previous");
  if ((state.lastBackup?.fromReleaseId ?? state.lastBackup?.fromVersion) !== (state.lastBackup?.fromReleaseId ? targetReleaseId : targetVersion) || !state.lastBackup?.path) {
    throw new Error(`No compatible data backup is available for rollback to ${targetVersion}`);
  }
  const target = join(installLayout(root).versions, targetReleaseId);
  const { manifest: targetManifest } = await assertPreflight(target, {
    arch: options.arch ?? process.arch,
    allowLegacyIdentity: true,
  });
  const quiesced = await quiesceInstall(root, {
    timeoutMs: options.quiesceTimeoutMs,
    taskkillPath: options.taskkillPath,
    gatewayUrl: options.gatewayUrl,
    isPortPresent: options.isPortPresent,
    queryProcessEvidence: options.queryProcessEvidence,
  });
  await (options.assertGatewayStopped ?? assertGatewayStopped)(quiesced.gatewayUrl, options.gatewayStopTimeoutMs);
  const dataRoot = state.dataRoot ?? defaultDataRoot(options.env ?? process.env);
  const localDataRoot = state.localDataRoot ?? defaultLocalDataRoot(options.env ?? process.env);
  const currentBackup = await createDataBackup({
    dataRoot,
    localDataRoot,
    backupRoot: options.backupRoot,
    activeVersion: state.activeVersion,
    activeReleaseId: state.activeReleaseId,
    env: options.env ?? process.env,
  });
  let restored = false;
  try {
    await restoreDataBackup(state.lastBackup.path, { dataRoot, localDataRoot, env: options.env ?? process.env });
    restored = true;
    await writeStableLauncher(root, targetReleaseId, targetVersion);
    const shortcuts = shortcutPaths(state.shortcutRoot, options.env ?? process.env);
    await writeReleaseShortcuts(root, shortcuts, { env: options.env ?? process.env, releaseId: targetReleaseId });
    const nextState = await writeInstallState(root, {
      ...state,
      shortcuts,
      activeVersion: targetManifest.version,
      activeBuildId: targetManifest.buildId,
      activeReleaseId: targetManifest.releaseId,
      activeContentSha256: targetManifest.contentSha256,
      activeGeneratedAt: targetManifest.generatedAt,
      manifestSha256: targetManifest.contentSha256,
      previousVersion: state.activeVersion,
      previousBuildId: state.activeBuildId ?? null,
      previousReleaseId: state.activeReleaseId,
      previousContentSha256: state.activeContentSha256 ?? null,
      previousGeneratedAt: state.activeGeneratedAt ?? null,
      lastBackup: {
        path: currentBackup.path,
        fromVersion: state.activeVersion,
        fromReleaseId: state.activeReleaseId,
        createdAt: currentBackup.manifest.createdAt,
      },
      lastFailure: null,
    });
    return {
      ok: true,
      root,
      version: targetVersion,
      releaseId: targetReleaseId,
      previousVersion: state.activeVersion,
      backup: nextState.lastBackup,
      state: nextState,
    };
  } catch (error) {
    if (restored) {
      await restoreDataBackup(currentBackup.path, { dataRoot, localDataRoot, env: options.env ?? process.env }).catch(() => undefined);
      await writeStableLauncher(root, state.activeReleaseId, state.activeVersion).catch(() => undefined);
    }
    throw error;
  }
}

export async function rollbackRelease(options = {}) {
  const root = await canonicalizeInstallRoot(options.installRoot ?? defaultInstallRoot(options.env ?? process.env));
  if (options.lock != null) return rollbackReleaseLocked({ ...options, installRoot: root });
  const lock = await acquireInstallLock(root, {
    timeoutMs: options.lockTimeoutMs,
    operation: "rollback",
    captureProcessEvidence: options.captureProcessEvidence,
    queryProcessEvidence: options.queryProcessEvidence,
  });
  try {
    return await rollbackReleaseLocked({ ...options, installRoot: root, lock });
  } finally {
    await lock.release();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = args.rollback === true ? await rollbackRelease({
    installRoot: args.root,
    arch: args.arch,
    env: process.env,
  }) : await updateRelease({
    packagePath: args.package,
    installRoot: args.root,
    arch: args.arch,
    stageOnly: args.stage === true,
    simulateFailure: args.fail === true || process.env.OPENBOT_UPDATE_FAIL === "1",
    failAfterCommit: args["fail-after-commit"] === true,
    throwOnFailure: true,
    env: process.env,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`[update] ${error.message}`);
    process.exitCode = 1;
  });
}
