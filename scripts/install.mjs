import { promises as fs } from "node:fs";
import { TASKBAR_APP_ID } from "./shortcut-appid.mjs";
import { dirname, join, resolve } from "node:path";
import {
  assertManagedInstallRoot,
  acquireInstallLock,
  assertPreflight,
  assertDataRootOutsideInstall,
  assertNoReparsePath,
  assertNoReparseAncestors,
  assertNoReparseTree,
  atomicWriteFile,
  canonicalizePath,
  canonicalizeInstallRoot,
  copyTree,
  createShortcut,
  defaultDataRoot,
  defaultInstallRoot,
  defaultLocalDataRoot,
  installLayout,
  isMainModule,
  materializePackage,
  parseArgs,
  pathExists,
  randomSuffix,
  readInstallState,
  removeTree,
  removeOwnedElectronTaskbarAlias,
  shortcutPaths,
  shortcutBelongsToInstall,
  validateReleaseManifest,
  writeDataRootMarker,
  writeInstallState,
  writeLifecycleWrappers,
  writeStableLauncher,
  quiesceInstall,
} from "./release-common.mjs";
import { assertGatewayStopped } from "./update.mjs";

async function ensureSafeInstallRoot(root, state) {
  if (state != null) {
    assertManagedInstallRoot(root, state);
    return;
  }
  if (!(await pathExists(root))) return;
  const entries = await fs.readdir(root);
  if (entries.length > 0) throw new Error(`Refusing to install over a non-OpenBot directory: ${root}`);
}

async function readOptionalFile(path) {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// A recorded path alone is not ownership: old skipped installs recorded the
// user's default shortcuts, and another install can later replace a real link.
export async function managedReleaseShortcuts(root, state, options = {}) {
  const managed = {};
  for (const name of ["desktop", "startMenu"]) {
    const path = state?.shortcuts?.[name];
    if (typeof path !== "string" || path.trim() === "") continue;
    if (await shortcutBelongsToInstall(path, root)) managed[name] = path;
    else if (options.recreateMissing === true && state.shortcutOwnershipVersion === 1) {
      try { await fs.lstat(path); }
      catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await assertNoReparseAncestors(path);
        managed[name] = path;
      }
    }
  }
  return managed;
}

export async function writeReleaseShortcuts(root, shortcuts, options = {}) {
  if (options.skipShortcuts === true) return;
  const executable = join(root, "OpenBot.exe");
  const launcher = await pathExists(executable) ? executable : join(root, "OpenBot.vbs");
  const shortcutOptions = {
    description: "OpenBot local desktop",
    arguments: "",
    appUserModelId: TASKBAR_APP_ID,
    allowFallback: false,
    workingDirectory: root,
    windowStyle: 7,
    iconLocation: options.releaseId
      ? join(root, "versions", options.releaseId, "assets", "openbot.ico")
      : join(root, "OpenBot.ico"),
    fail: options.failShortcut === true,
  };
  for (const path of Object.values(shortcuts)) {
    await createShortcut(launcher, path, shortcutOptions);
  }
  if (shortcuts.startMenu != null) {
    await removeOwnedElectronTaskbarAlias(shortcuts.startMenu, { appUserModelId: TASKBAR_APP_ID });
  }
}

async function installReleaseLocked(options = {}) {
  if (!options.packagePath) throw new Error("--package is required");
  const root = await canonicalizeInstallRoot(options.installRoot ?? defaultInstallRoot(options.env ?? process.env));
  const layout = installLayout(root);
  const state = await readInstallState(root);
  await ensureSafeInstallRoot(root, state);
  const materialized = await materializePackage(options.packagePath);
  let movedTarget = null;
  let backupTarget = null;
  let target = null;
  let shortcuts = null;
  let shortcutBackupRoot = null;
  let dataMarkerPath = null;
  let oldDataMarker = null;
  const shortcutSnapshots = [];
  const oldLauncher = await readOptionalFile(layout.launcher);
  const oldHiddenLauncher = await readOptionalFile(join(root, "OpenBot.vbs"));
  const oldIcon = await fs.readFile(join(root, "OpenBot.ico")).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const oldStateFile = await readOptionalFile(layout.state);
  const oldUninstallWrapper = await readOptionalFile(join(root, "Uninstall-OpenBot.cmd"));
  const oldRepairWrapper = await readOptionalFile(join(root, "Repair-OpenBot.cmd"));
  const oldUpdateWrapper = await readOptionalFile(join(root, "Update-OpenBot.cmd"));
  const oldRollbackWrapper = await readOptionalFile(join(root, "Rollback-OpenBot.cmd"));
  const oldRecoveryWrapper = await readOptionalFile(join(root, "Recovery-OpenBot.cmd"));
  try {
    const manifest = await validateReleaseManifest(materialized.root, { arch: options.arch ?? process.arch });
    await assertPreflight(materialized.root, { arch: manifest.arch });
    const persistedShortcutRoot = state?.shortcutRoot == null || String(state.shortcutRoot).trim() === ""
      ? null
      : resolve(String(state.shortcutRoot));
    const requestedShortcutRoot = options.shortcutRoot == null || String(options.shortcutRoot).trim() === ""
      ? null
      : resolve(String(options.shortcutRoot));
    if (state != null && requestedShortcutRoot != null && requestedShortcutRoot.toLowerCase() !== persistedShortcutRoot?.toLowerCase()) {
      throw new Error("The requested shortcut root does not match the managed install state");
    }
    await fs.mkdir(layout.staging, { recursive: true });
    await assertNoReparsePath(layout.staging);
    const skipShortcuts = options.skipShortcuts === true || process.env.OPENBOT_SKIP_SHORTCUTS === "1";
    shortcuts = state == null
      ? (skipShortcuts ? {} : shortcutPaths(options.shortcutRoot, options.env ?? process.env))
      : await managedReleaseShortcuts(root, state, { recreateMissing: !skipShortcuts });
    if (!skipShortcuts) {
      shortcutBackupRoot = join(layout.staging, `.install-shortcuts-${randomSuffix()}`);
      await fs.mkdir(shortcutBackupRoot, { recursive: true });
      for (const [name, path] of Object.entries(shortcuts)) {
        const backup = join(shortcutBackupRoot, `${name}.lnk`);
        const existed = await pathExists(path);
        if (existed) await fs.copyFile(path, backup);
        shortcutSnapshots.push({ path, backup, existed });
      }
    }
    const sameIdentity = state?.activeBuildId === manifest.buildId
      && state?.activeContentSha256 === manifest.contentSha256;
    if (sameIdentity && options.force !== true) {
      await writeReleaseShortcuts(root, shortcuts, { ...options, releaseId: manifest.releaseId });
      if (!skipShortcuts) await writeInstallState(root, { ...state, shortcuts, shortcutOwnershipVersion: 1 });
      return { ok: true, alreadyInstalled: true, version: manifest.version, releaseId: manifest.releaseId, root, shortcuts };
    }
    if (state != null && !sameIdentity) {
      throw new Error(`Installed release ${state.activeReleaseId ?? state.activeVersion} differs from ${manifest.releaseId}; use update so data is backed up first`);
    }
    if (state != null) {
      const quiesced = await quiesceInstall(root, {
        timeoutMs: options.quiesceTimeoutMs,
        taskkillPath: options.taskkillPath,
        gatewayUrl: options.gatewayUrl,
        isPortPresent: options.isPortPresent,
        queryProcessEvidence: options.queryProcessEvidence,
      });
      await (options.assertGatewayStopped ?? assertGatewayStopped)(quiesced.gatewayUrl, options.gatewayStopTimeoutMs);
    }
    await fs.mkdir(layout.versions, { recursive: true });
    await assertNoReparsePath(layout.versions);
    const staging = join(layout.staging, `${manifest.releaseId}.${randomSuffix()}`);
    target = join(layout.versions, manifest.releaseId);
    const dataRoot = await assertDataRootOutsideInstall(
      root,
      options.dataRoot ?? state?.dataRoot ?? defaultDataRoot(options.env ?? process.env),
    );
    const localDataRoot = await assertDataRootOutsideInstall(
      root,
      options.localDataRoot ?? state?.localDataRoot ?? defaultLocalDataRoot(options.env ?? process.env),
    );
    dataMarkerPath = join(dataRoot, ".openbot-data-root.json");
    oldDataMarker = await readOptionalFile(dataMarkerPath);
    await removeTree(staging);
    await copyTree(materialized.root, staging);
    await assertPreflight(staging, { arch: manifest.arch });
    await assertNoReparseTree(staging);
    if (await pathExists(target)) {
      await assertNoReparsePath(target);
      await assertNoReparseTree(target);
      backupTarget = `${target}.previous-${randomSuffix()}`;
      await fs.rename(target, backupTarget);
    }
    await fs.rename(staging, target);
    movedTarget = target;
    await assertNoReparseTree(target);
    const promotedTarget = await canonicalizePath(target, { allowMissing: false, directory: true });
    if (promotedTarget.toLowerCase() !== target.toLowerCase()) {
      throw new Error(`Staging promotion changed release identity: ${target}`);
    }

    await writeStableLauncher(root, manifest.releaseId, manifest.version);
    const nextState = await writeInstallState(root, {
      installRoot: root,
      activeVersion: manifest.version,
      activeBuildId: manifest.buildId,
      activeReleaseId: manifest.releaseId,
      activeContentSha256: manifest.contentSha256,
      activeGeneratedAt: manifest.generatedAt,
      previousVersion: null,
      previousBuildId: null,
      previousReleaseId: null,
      previousContentSha256: null,
      previousGeneratedAt: null,
      stagedVersion: null,
      stagedBuildId: null,
      stagedReleaseId: null,
      dataRoot,
      localDataRoot,
      shortcutRoot: options.shortcutRoot ? resolve(options.shortcutRoot) : state?.shortcutRoot ?? null,
      shortcuts: skipShortcuts && state != null ? state.shortcuts ?? {} : shortcuts,
      shortcutOwnershipVersion: skipShortcuts && state != null ? state.shortcutOwnershipVersion ?? null : 1,
      unsignedLocal: true,
      manifestSha256: manifest.contentSha256,
    });
    await writeLifecycleWrappers(root, { shortcutRoot: nextState.shortcutRoot });
    await writeDataRootMarker(root, dataRoot);
    await writeReleaseShortcuts(root, shortcuts, { ...options, releaseId: manifest.releaseId });
    if (backupTarget) await removeTree(backupTarget);
    if (shortcutBackupRoot) await removeTree(shortcutBackupRoot);
    return { ok: true, version: manifest.version, releaseId: manifest.releaseId, root, state: nextState, shortcuts };
  } catch (error) {
    if (movedTarget) {
      await removeTree(movedTarget);
      if (backupTarget && await pathExists(backupTarget)) await fs.rename(backupTarget, movedTarget);
    } else if (backupTarget && target && await pathExists(backupTarget)) {
      await fs.rename(backupTarget, target);
    }
    if (oldLauncher == null) await fs.rm(layout.launcher, { force: true });
    else await atomicWriteFile(layout.launcher, oldLauncher);
    if (oldHiddenLauncher == null) await fs.rm(join(root, "OpenBot.vbs"), { force: true });
    else await atomicWriteFile(join(root, "OpenBot.vbs"), oldHiddenLauncher);
    if (oldIcon == null) await fs.rm(join(root, "OpenBot.ico"), { force: true });
    else await atomicWriteFile(join(root, "OpenBot.ico"), oldIcon);
    if (oldStateFile == null) await fs.rm(layout.state, { force: true });
    else await atomicWriteFile(layout.state, oldStateFile);
    if (oldUninstallWrapper == null) await fs.rm(join(root, "Uninstall-OpenBot.cmd"), { force: true });
    else await atomicWriteFile(join(root, "Uninstall-OpenBot.cmd"), oldUninstallWrapper);
    if (oldRepairWrapper == null) await fs.rm(join(root, "Repair-OpenBot.cmd"), { force: true });
    else await atomicWriteFile(join(root, "Repair-OpenBot.cmd"), oldRepairWrapper);
    if (oldUpdateWrapper == null) await fs.rm(join(root, "Update-OpenBot.cmd"), { force: true });
    else await atomicWriteFile(join(root, "Update-OpenBot.cmd"), oldUpdateWrapper);
    if (oldRollbackWrapper == null) await fs.rm(join(root, "Rollback-OpenBot.cmd"), { force: true });
    else await atomicWriteFile(join(root, "Rollback-OpenBot.cmd"), oldRollbackWrapper);
    if (oldRecoveryWrapper == null) await fs.rm(join(root, "Recovery-OpenBot.cmd"), { force: true });
    else await atomicWriteFile(join(root, "Recovery-OpenBot.cmd"), oldRecoveryWrapper);
    if (dataMarkerPath != null) {
      if (oldDataMarker == null) await fs.rm(dataMarkerPath, { force: true });
      else await atomicWriteFile(dataMarkerPath, oldDataMarker);
    }
    for (const snapshot of shortcutSnapshots) {
      if (snapshot.existed) {
        await fs.mkdir(dirname(snapshot.path), { recursive: true });
        await fs.copyFile(snapshot.backup, snapshot.path);
      } else {
        await fs.rm(snapshot.path, { force: true });
      }
    }
    throw error;
  } finally {
    if (shortcutBackupRoot) await removeTree(shortcutBackupRoot);
    await materialized.cleanup();
  }
}

export async function installRelease(options = {}) {
  const root = await canonicalizeInstallRoot(options.installRoot ?? defaultInstallRoot(options.env ?? process.env));
  if (options.lock != null) return installReleaseLocked({ ...options, installRoot: root });
  const lock = await acquireInstallLock(root, {
    timeoutMs: options.lockTimeoutMs,
    operation: options.force === true ? "repair" : "install",
  });
  try {
    return await installReleaseLocked({ ...options, installRoot: root, lock });
  } finally {
    await lock.release();
  }
}

export async function repairRelease(options = {}) {
  return installRelease({ ...options, force: true });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = args.repair === true
    ? await repairRelease({
      packagePath: args.package,
      installRoot: args.root,
      shortcutRoot: args["shortcut-root"],
      dataRoot: args["data-root"],
      localDataRoot: args["local-data-root"],
      arch: args.arch,
      skipShortcuts: args["skip-shortcuts"] === true,
      failShortcut: args["fail-shortcut"] === true,
      env: process.env,
    })
    : await installRelease({
      packagePath: args.package,
      installRoot: args.root,
      shortcutRoot: args["shortcut-root"],
      dataRoot: args["data-root"],
      localDataRoot: args["local-data-root"],
      arch: args.arch,
      force: args.force === true,
      failShortcut: args["fail-shortcut"] === true,
      skipShortcuts: args["skip-shortcuts"] === true,
      env: process.env,
    });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`[install] ${error.message}`);
    process.exitCode = 1;
  });
}
