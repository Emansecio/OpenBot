import { spawn } from "node:child_process";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertManagedInstallRoot,
  acquireInstallLock,
  assertDataRootOutsideInstall,
  assertOwnedDataRoot,
  canonicalizeInstallRoot,
  defaultDataRoot,
  defaultInstallRoot,
  installLayout,
  isMainModule,
  parseArgs,
  pathExists,
  quiesceInstall,
  readInstallState,
  removeShortcut,
  removeTree,
  randomSuffix,
  shortcutBelongsToInstall,
} from "./release-common.mjs";

const DEFERRED_ARGUMENTS_FLAG = "--prepare-deferred-args";
const RUN_DEFERRED_ARGUMENTS_FLAG = "--run-deferred-args";
const DEFERRED_BOOLEAN_ARGUMENTS = new Set(["--purge-data", "--yes"]);
const DEFERRED_VALUE_ARGUMENTS = new Set(["--data-root", "--shortcut-root"]);
const WRAPPER_SHORTCUT_ROOT_ENV = "OPENBOT_WRAPPER_SHORTCUT_ROOT_B64";

export function buildDeferredUninstallArguments(argv, installRoot) {
  const root = String(installRoot ?? "").trim();
  if (root === "") throw new Error("Deferred uninstall requires an install root");
  const normalized = ["--root", root];
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? "");
    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(0, equals) : token;
    if (DEFERRED_BOOLEAN_ARGUMENTS.has(name)) {
      if (equals >= 0) throw new Error(`Unsupported value for uninstall argument: ${name}`);
      if (seen.has(name)) throw new Error(`Duplicate uninstall argument: ${name}`);
      seen.add(name);
      normalized.push(name);
      continue;
    }
    if (DEFERRED_VALUE_ARGUMENTS.has(name)) {
      if (seen.has(name)) throw new Error(`Duplicate uninstall argument: ${name}`);
      const value = equals >= 0 ? token.slice(equals + 1) : argv[++index];
      if (value == null || String(value).trim() === "" || String(value).startsWith("--")) {
        throw new Error(`Uninstall argument requires a value: ${name}`);
      }
      seen.add(name);
      normalized.push(name, String(value));
      continue;
    }
    throw new Error(`Unsupported uninstall argument: ${token || "<empty>"}`);
  }
  return normalized;
}

function decodeWrapperShortcutRoot(env = process.env) {
  const encoded = String(env[WRAPPER_SHORTCUT_ROOT_ENV] ?? "").trim();
  if (encoded === "") return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error("Generated uninstall wrapper contains an invalid shortcut root");
  }
  const bytes = Buffer.from(encoded, "base64");
  const decoded = bytes.toString("utf8");
  if (decoded.trim() === "" || Buffer.from(decoded, "utf8").toString("base64") !== encoded) {
    throw new Error("Generated uninstall wrapper contains an invalid shortcut root");
  }
  return resolve(decoded);
}

function mergeWrapperShortcutRoot(normalized, wrapperShortcutRoot) {
  if (wrapperShortcutRoot == null) return normalized;
  const shortcutIndex = normalized.indexOf("--shortcut-root");
  if (shortcutIndex < 0) return [...normalized, "--shortcut-root", wrapperShortcutRoot];
  const explicitShortcutRoot = resolve(normalized[shortcutIndex + 1]);
  if (explicitShortcutRoot.toLowerCase() !== wrapperShortcutRoot.toLowerCase()) {
    throw new Error("The explicit shortcut root does not match the generated uninstall wrapper");
  }
  return normalized;
}

async function prepareDeferredArguments(argv) {
  const [outputPath, installRoot, ...uninstallArguments] = argv;
  if (outputPath == null || String(outputPath).trim() === "") {
    throw new Error("Deferred uninstall requires an argument artifact path");
  }
  const normalized = mergeWrapperShortcutRoot(
    buildDeferredUninstallArguments(uninstallArguments, installRoot),
    decodeWrapperShortcutRoot(),
  );
  await writeFile(resolve(String(outputPath)), `${JSON.stringify(normalized)}\n`, { encoding: "utf8", flag: "wx" });
  return { ok: true, argumentsPrepared: normalized.length };
}

export async function assertRemovalTargetAbsent(target, options = {}) {
  try {
    await (options.lstat ?? lstat)(target);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw new Error(`OpenBot deferred uninstall cleanup absence could not be verified: ${target} (${error?.code ?? "unknown error"})`, { cause: error });
  }
  throw new Error(`OpenBot deferred uninstall cleanup left residue: ${target}`);
}

export async function scheduleWindowsDeferredRemoval(target, options = {}) {
  const delayMs = Number.isFinite(options.delayMs) && options.delayMs > 0 ? Math.floor(options.delayMs) : 0;
  const waitBlock = delayMs > 0 ? `Start-Sleep -Milliseconds ${delayMs};` : "";
  const literalPath = target.replaceAll("'", "''");
  const command = [
    waitBlock,
    `for ($i = 0; $i -lt 200; $i++) {`,
    `  if (!(Test-Path -LiteralPath '${literalPath}')) { exit 0 }`,
    `  try { [System.IO.Directory]::Delete('${literalPath}', $true) } catch { }`,
    `  if (!(Test-Path -LiteralPath '${literalPath}')) { exit 0 }`,
    `  Start-Sleep -Milliseconds 250`,
    `}`,
    `exit 1`,
  ].join(" ");
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
  const child = (options.spawn ?? spawn)(options.powershellPath ?? "powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand], {
    detached: false,
    cwd: options.cwd ?? process.env.TEMP ?? process.cwd(),
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolveCleanup, rejectCleanup) => {
    let settled = false;
    let started = child.spawned === true;
    const rejectOnce = (message) => { if (!settled) { settled = true; rejectCleanup(new Error(message)); } };
    child.once?.("spawn", () => { started = true; });
    child.once?.("error", () => rejectOnce(started
      ? "OpenBot deferred uninstall cleanup failed"
      : "OpenBot deferred uninstall cleanup could not be started"));
    child.once?.("exit", (code, signal) => {
      if (code === 0) {
        if (!settled) { settled = true; resolveCleanup(); }
        return;
      }
      rejectOnce(`OpenBot deferred uninstall cleanup failed (${signal == null ? `exit ${String(code)}` : `signal ${String(signal)}`})`);
    });
    if (child.exitCode != null) {
      if (child.exitCode === 0) { settled = true; resolveCleanup(); }
      else rejectOnce(`OpenBot deferred uninstall cleanup failed (exit ${String(child.exitCode)})`);
    }
  });
  await assertRemovalTargetAbsent(target, { lstat: options.lstat });
  return child;
}

async function uninstallReleaseLocked(options = {}) {
  if (options.purgeData === true && options.yes !== true) {
    throw new Error("--purge-data requires explicit confirmation (yes:true); workspaces will be permanently deleted");
  }
  const root = await canonicalizeInstallRoot(options.installRoot ?? defaultInstallRoot(options.env ?? process.env));
  const state = await readInstallState(root);
  assertManagedInstallRoot(root, state);
  const stateDataRoot = resolve(state.dataRoot ?? defaultDataRoot(options.env ?? process.env));
  const requestedDataRoot = resolve(options.dataRoot ?? stateDataRoot);
  if (options.purgeData === true && requestedDataRoot.toLowerCase() !== stateDataRoot.toLowerCase()) {
    throw new Error("Refusing to purge a data root different from the managed install state");
  }
  const dataRoot = options.purgeData === true
    ? await assertOwnedDataRoot(root, stateDataRoot)
    : await assertDataRootOutsideInstall(root, requestedDataRoot);
  const dataExisted = await pathExists(dataRoot);
  const persistedShortcutRoot = state.shortcutRoot == null || String(state.shortcutRoot).trim() === ""
    ? null
    : resolve(String(state.shortcutRoot));
  const explicitShortcutRoot = options.shortcutRoot == null || String(options.shortcutRoot).trim() === ""
    ? null
    : resolve(String(options.shortcutRoot));
  if (persistedShortcutRoot !== null && explicitShortcutRoot === null) {
    throw new Error("A persisted custom shortcut root requires an explicit matching --shortcut-root");
  }
  if (persistedShortcutRoot !== null && explicitShortcutRoot?.toLowerCase() !== persistedShortcutRoot.toLowerCase()) {
    throw new Error("The explicit shortcut root does not match the managed install state");
  }
  await quiesceInstall(root, {
    timeoutMs: options.quiesceTimeoutMs,
    taskkillPath: options.taskkillPath,
    gatewayUrl: options.gatewayUrl,
    isPortPresent: options.isPortPresent,
    queryProcessEvidence: options.queryProcessEvidence,
  });
  const shortcuts = {};
  for (const name of ["desktop", "startMenu"]) {
    const path = state.shortcuts?.[name];
    if (typeof path === "string" && await shortcutBelongsToInstall(path, root)) shortcuts[name] = path;
  }
  const shortcutSnapshots = await Promise.all(Object.values(shortcuts).map(async (path) => ({
    path,
    content: await readFile(path).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    }),
  })));
  const restoreShortcutSnapshots = async () => {
    const restoreErrors = [];
    for (const snapshot of shortcutSnapshots) {
      if (snapshot.content == null) continue;
      try { await writeFile(snapshot.path, snapshot.content); }
      catch (restoreError) { restoreErrors.push(restoreError); }
    }
    return restoreErrors;
  };
  let relocatedRoot = root;
  try {
    for (const path of Object.values(shortcuts)) await removeShortcut(path);
    if (process.platform === "win32") {
      relocatedRoot = join(dirname(root), `${basename(root)}.removing-${randomSuffix()}`);
      await rename(root, relocatedRoot);
      if (await pathExists(root)) throw new Error(`Install removal was not verified: ${root}`);
      try {
        await scheduleWindowsDeferredRemoval(relocatedRoot, {
          powershellPath: options.powershellPath,
          spawn: options.spawn,
          delayMs: options.deferredCleanupDelayMs ?? 500,
        });
      } catch (error) {
        throw new Error(`Install was relocated but deferred cleanup could not be started: ${error instanceof Error ? error.message : "unknown error"}`, { cause: error });
      }
    } else {
      await removeTree(root);
      if (await pathExists(root)) throw new Error(`Install removal was not verified: ${root}`);
    }
  } catch (error) {
    const rollbackErrors = [];
    if (relocatedRoot !== root && await pathExists(relocatedRoot)) {
      if (await pathExists(root)) rollbackErrors.push(new Error("Install rollback target is already occupied"));
      else {
        try { await rename(relocatedRoot, root); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
    }
    if (await pathExists(root)) rollbackErrors.push(...await restoreShortcutSnapshots());
    else rollbackErrors.push(new Error("Install root could not be restored"));
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Uninstall failed and rollback was incomplete", { cause: error });
    }
    throw error;
  }
  let dataPreserved = true;
  if (options.purgeData === true) {
    await removeTree(dataRoot);
    if (await pathExists(dataRoot)) throw new Error(`Data removal was not verified: ${dataRoot}`);
    dataPreserved = false;
  } else if (dataExisted && !(await pathExists(dataRoot))) {
    throw new Error(`Data preservation was not verified: ${dataRoot}`);
  }
  return {
    ok: true,
    root,
    ...(relocatedRoot === root ? {} : { relocatedRoot }),
    dataRoot,
    dataPreserved,
    shortcutsRemoved: shortcuts,
  };
}

export async function uninstallRelease(options = {}) {
  const root = await canonicalizeInstallRoot(options.installRoot ?? defaultInstallRoot(options.env ?? process.env));
  if (options.lock != null) return uninstallReleaseLocked({ ...options, installRoot: root });
  const lock = await acquireInstallLock(root, {
    timeoutMs: options.lockTimeoutMs,
    operation: "uninstall",
    captureProcessEvidence: options.captureProcessEvidence,
    queryProcessEvidence: options.queryProcessEvidence,
  });
  try {
    return await uninstallReleaseLocked({ ...options, installRoot: root, lock });
  } finally {
    await lock.release();
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === DEFERRED_ARGUMENTS_FLAG) {
    const result = await prepareDeferredArguments(argv.slice(1));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  if (argv[0] === RUN_DEFERRED_ARGUMENTS_FLAG) {
    const argsPath = argv[1];
    if (argsPath == null || String(argsPath).trim() === "") throw new Error("Deferred uninstall requires an argument artifact path");
    const prepared = JSON.parse(await readFile(resolve(String(argsPath)), "utf8"));
    if (!Array.isArray(prepared) || prepared.some((token) => typeof token !== "string")) {
      throw new Error("Deferred uninstall argument artifact is invalid");
    }
    return main(prepared);
  }
  const args = parseArgs(argv);
  if (args["purge-data"] === true && args.yes !== true) {
    throw new Error("--purge-data requires --yes");
  }
  const result = await uninstallRelease({
    installRoot: args.root,
    dataRoot: args["data-root"],
    purgeData: args["purge-data"] === true,
    yes: args.yes === true,
    shortcutRoot: args["shortcut-root"],
    env: process.env,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`[uninstall] ${error.message}`);
    process.exitCode = 1;
  });
}
