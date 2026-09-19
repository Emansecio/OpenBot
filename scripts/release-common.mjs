import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { createReadStream,promises as fs } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeShortcutAppId } from "./shortcut-appid.mjs";

const execFile = promisify(execFileCallback);

export const PRODUCT_NAME = "OpenBot";
export const RELEASE_SCHEMA_VERSION = 1;
export const INSTALL_STATE_VERSION = 1;
export const DEFAULT_APP_ID = "local.openbot";
export const DATA_ROOT_MARKER = ".openbot-data-root.json";

export function parseArgs(argv = process.argv.slice(2)) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const raw = token.slice(2);
    const equals = raw.indexOf("=");
    if (equals >= 0) {
      result[raw.slice(0, equals)] = raw.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next != null && !next.startsWith("--")) {
      result[raw] = next;
      index += 1;
    } else {
      result[raw] = true;
    }
  }
  return result;
}

export function isMainModule(metaUrl = import.meta.url) {
  if (process.argv[1] == null) return false;
  return resolve(process.argv[1]) === resolve(fileURLToPath(metaUrl));
}

export function safeVersion(value) {
  const version = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(version) || version === "." || version === "..") {
    throw new Error(`Invalid release version: ${version}`);
  }
  return version;
}

export function safeSha256(value, label = "SHA-256") {
  const digest = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${label} must be a SHA-256 digest`);
  return digest;
}

export function releaseIdFor(version, buildId) {
  return safeVersion(`${safeVersion(version)}-${safeSha256(buildId, "buildId").slice(0, 16)}`);
}

export function stateReleaseId(state, slot = "active") {
  return safeVersion(state?.[`${slot}ReleaseId`] ?? state?.[`${slot}Version`]);
}

export function randomSuffix() {
  return `${process.pid}-${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
}

export function defaultAppDataRoot(env = process.env) {
  return env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
}

export function defaultLocalAppDataRoot(env = process.env) {
  return env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
}

export function defaultInstallRoot(env = process.env) {
  return env.OPENBOT_INSTALL_ROOT?.trim() || join(defaultLocalAppDataRoot(env), PRODUCT_NAME, "install");
}

export function defaultDataRoot(env = process.env) {
  return env.OPENBOT_DATA_ROOT?.trim() || join(defaultAppDataRoot(env), PRODUCT_NAME);
}

export function defaultLocalDataRoot(env = process.env) {
  return env.OPENBOT_LOCAL_DATA_ROOT?.trim() || join(defaultLocalAppDataRoot(env), PRODUCT_NAME);
}

export function shortcutPaths(shortcutRoot, env = process.env) {
  const configuredRoot = shortcutRoot != null && String(shortcutRoot).trim() !== ""
    ? shortcutRoot
    : env.OPENBOT_SHORTCUT_ROOT;
  if (configuredRoot != null && String(configuredRoot).trim() !== "") {
    const root = resolve(String(configuredRoot));
    return {
      desktop: join(root, "Desktop", `${PRODUCT_NAME}.lnk`),
      startMenu: join(root, "Start Menu", `${PRODUCT_NAME}.lnk`),
    };
  }
  return {
    desktop: join(env.USERPROFILE || homedir(), "Desktop", `${PRODUCT_NAME}.lnk`),
    startMenu: join(defaultAppDataRoot(env), "Microsoft", "Windows", "Start Menu", "Programs", `${PRODUCT_NAME}.lnk`),
  };
}

export function installLayout(root) {
  const installRoot = resolve(root);
  return {
    root: installRoot,
    versions: join(installRoot, "versions"),
    staging: join(installRoot, "staging"),
    state: join(installRoot, "state.json"),
    launcher: join(installRoot, `${PRODUCT_NAME}.cmd`),
    processState: join(installRoot, "process.json"),
    operationLock: `${installRoot}.openbot-operation.lock`,
  };
}

function lockOwnerPath(lockPath) {
  return join(lockPath, "owner.json");
}

async function readLockOwner(lockPath) {
  try {
    const stat = await fs.lstat(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return await readJson(lockOwnerPath(lockPath));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}

async function lockIsStale(lockPath, owner, options) {
  const staleMs = Number(options.staleMs ?? 30_000);
  const now = Date.now();
  const createdAt = Number(owner?.createdAt);
  if (owner?.ownerId && Number.isInteger(Number(owner.pid)) && Number(owner.pid) > 0) {
    let evidence;
    try {
      evidence = await (options.queryProcessEvidence ?? queryProcessEvidence)(Number(owner.pid));
    } catch {
      return false;
    }
    if (evidence != null) {
      const creationMismatch = owner.creationTime != null && evidence.creationTime != null
        && String(owner.creationTime) !== String(evidence.creationTime);
      const executableMismatch = owner.executablePath != null && evidence.executablePath != null
        && resolve(String(owner.executablePath)).toLowerCase() !== resolve(String(evidence.executablePath)).toLowerCase();
      if (!creationMismatch && !executableMismatch) return false;
      return true;
    }
    return true;
  }
  try {
    const stat = await fs.lstat(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return now - stat.mtimeMs >= staleMs;
  } catch {
    return false;
  }
}

async function removeStaleLock(lockPath, owner, options) {
  const tombstone = `${lockPath}.stale-${randomSuffix()}`;
  try {
    await fs.rename(lockPath, tombstone);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
  const movedStat = await fs.lstat(tombstone).catch(() => null);
  if (movedStat == null || !movedStat.isDirectory() || movedStat.isSymbolicLink()) {
    if (!(await pathExists(lockPath))) await fs.rename(tombstone, lockPath).catch(() => undefined);
    return false;
  }
  const movedOwner = await readLockOwner(tombstone);
  const sameOwner = owner?.ownerId != null
    ? movedOwner?.ownerId === owner.ownerId
    : movedOwner == null;
  if (!sameOwner) {
    if (!(await pathExists(lockPath))) await fs.rename(tombstone, lockPath).catch(() => undefined);
    else await removeTree(tombstone);
    return false;
  }
  await removeTree(tombstone);
  return true;
}

export async function acquireInstallLock(root, options = {}) {
  const installRoot = resolve(root);
  const lockPath = resolve(options.lockPath ?? installLayout(installRoot).operationLock);
  const timeoutMs = Number(options.timeoutMs ?? 10_000);
  const retryMs = Math.max(1, Number(options.retryMs ?? 25));
  const staleMs = Math.max(1_000, Number(options.staleMs ?? 30_000));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("OpenBot lock timeout must be a finite non-negative number");
  const identity = await (options.captureProcessEvidence
    ? options.captureProcessEvidence(process.pid, { expectedExecutable: process.execPath, expectedRoot: installRoot })
    : queryProcessEvidence(process.pid)).catch((error) => {
    throw new Error(`OpenBot lock owner identity could not be captured: ${error instanceof Error ? error.message : "unknown error"}`);
  });
  if (identity == null || identity.creationTime == null || identity.executablePath == null) {
    throw new Error("OpenBot lock owner identity could not be captured");
  }
  const owner = {
    ownerId: String(options.ownerId ?? randomSuffix()),
    pid: process.pid,
    createdAt: Date.now(),
    operation: String(options.operation ?? "lifecycle"),
    creationTime: identity.creationTime,
    executablePath: identity.executablePath ?? process.execPath,
    expectedRoot: installRoot,
  };
  const deadline = Date.now() + timeoutMs;
  await assertNoReparseAncestors(installRoot, { beforeRealpath: options.beforeRealpath });
  await fs.mkdir(installRoot, { recursive: true });
  await assertNoReparsePath(installRoot);
  await assertNoReparseAncestors(lockPath, { beforeRealpath: options.beforeRealpath });
  while (true) {
    try {
      await fs.mkdir(lockPath);
      try {
        await atomicWriteJson(lockOwnerPath(lockPath), owner);
      } catch (error) {
        await removeTree(lockPath);
        throw error;
      }
      let released = false;
      return {
        path: lockPath,
        ownerId: owner.ownerId,
        owner,
        async release() {
          if (released) return false;
          released = true;
          const current = await readLockOwner(lockPath);
          if (current?.ownerId !== owner.ownerId) return false;
          return removeStaleLock(lockPath, owner, { staleMs });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockStat = await fs.lstat(lockPath).catch((statError) => {
        if (statError?.code === "ENOENT") return null;
        throw statError;
      });
      if (lockStat == null) continue;
      if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
        throw new Error(`OpenBot operation lock is not a directory: ${lockPath}`, { cause: error });
      }
      const current = await readLockOwner(lockPath);
      if (await lockIsStale(lockPath, current, { ...options, staleMs })) {
        await removeStaleLock(lockPath, current, { staleMs });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`OpenBot install is busy: ${installRoot}`, { cause: error });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryMs));
    }
  }
}

export async function withInstallLock(root, operation, options = {}) {
  if (typeof operation !== "function") throw new TypeError("OpenBot lock operation must be a function");
  const existing = options.lock;
  const lock = existing ?? await acquireInstallLock(root, options);
  try {
    return await operation(lock);
  } finally {
    if (existing == null) await lock.release();
  }
}

export function normalizeManifest(manifest, options = {}) {
  if (manifest == null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Release manifest must be an object");
  }
  const normalized = { ...manifest };
  normalized.schemaVersion = Number(normalized.schemaVersion ?? RELEASE_SCHEMA_VERSION);
  normalized.product = String(normalized.product ?? "");
  normalized.version = safeVersion(normalized.version);
  const legacyIdentity = options.allowLegacyIdentity === true
    && normalized.productVersion == null
    && normalized.buildId == null
    && normalized.releaseId == null;
  normalized.productVersion = legacyIdentity ? normalized.version : safeVersion(normalized.productVersion);
  normalized.buildId = legacyIdentity
    ? safeSha256(normalized.contentSha256 ?? normalized.payloadSha256 ?? normalized.sha256, "contentSha256")
    : safeSha256(normalized.buildId, "buildId");
  normalized.releaseId = legacyIdentity ? normalized.version : safeVersion(normalized.releaseId);
  normalized.legacyIdentity = legacyIdentity;
  normalized.packageJsonVersion = safeVersion(normalized.packageJsonVersion);
  normalized.platform = String(normalized.platform ?? "");
  normalized.arch = String(normalized.arch ?? "");
  if (normalized.schemaVersion !== RELEASE_SCHEMA_VERSION) throw new Error("Unsupported release manifest schema");
  if (normalized.product !== PRODUCT_NAME) throw new Error(`Unexpected product: ${normalized.product}`);
  if (normalized.productVersion !== normalized.version) throw new Error("productVersion must match version");
  if (!legacyIdentity && normalized.releaseId !== releaseIdFor(normalized.productVersion, normalized.buildId)) throw new Error("releaseId does not match productVersion/buildId");
  if (!Number.isFinite(Date.parse(String(normalized.generatedAt ?? "")))) throw new Error("generatedAt must be an ISO timestamp");
  if (normalized.platform !== "win32") throw new Error(`Release platform must be win32, got ${normalized.platform}`);
  if (!/^(x64|arm64|ia32)$/.test(normalized.arch)) throw new Error(`Invalid release architecture: ${normalized.arch}`);
  if (normalized.signed !== false) throw new Error("Only unsigned local releases are accepted");
  if (normalized.signature != null) throw new Error("Signed release metadata is not supported by the local pipeline");
  return normalized;
}

const DPAPI_PE_MACHINE = Object.freeze({ x64: 0x8664, arm64: 0xaa64, ia32: 0x014c });

export function expectedDpapiPeMachine(arch) {
  const machine = DPAPI_PE_MACHINE[String(arch)];
  if (machine == null) throw new Error(`Unsupported DPAPI architecture: ${arch}`);
  return machine;
}

export async function readPeMachine(file) {
  const bytes = await fs.readFile(file);
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error("DPAPI addon is not a valid PE image");
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset > bytes.length - 6 || bytes[peOffset] !== 0x50 || bytes[peOffset + 1] !== 0x45 || bytes[peOffset + 2] !== 0 || bytes[peOffset + 3] !== 0) {
    throw new Error("DPAPI addon PE header is invalid");
  }
  return bytes.readUInt16LE(peOffset + 4);
}

export async function validateDpapiNativeArtifact(file, arch) {
  const expected = expectedDpapiPeMachine(arch);
  const actual = await readPeMachine(file);
  if (actual !== expected) throw new Error(`DPAPI addon machine mismatch: expected 0x${expected.toString(16)}, got 0x${actual.toString(16)}`);
  return { expected, actual };
}

async function listFiles(root, current = root, output = []) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Reparse/symbolic-link path is not allowed: ${path}`);
    if (entry.isDirectory()) {
      await listFiles(root, path, output);
    } else if (entry.isFile()) {
      output.push(path);
    }
  }
  return output;
}

export async function treeDigest(root, options = {}) {
  await assertNoReparseTree(root);
  const exclude = new Set((options.exclude ?? []).map((value) => String(value).replaceAll("\\", "/")));
  const hash = createHash("sha256");
  const files = await listFiles(root);
  for (const file of files) {
    const relativePath = relative(root, file).split(sep).join("/");
    if (exclude.has(relativePath)) continue;
    const stat = await fs.stat(file);
    hash.update(relativePath).update("\0").update(String(stat.size)).update("\0");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function fileSha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function copyTree(source, destination, options = {}) {
  await assertNoReparseTree(source);
  await assertNoReparseAncestors(destination);
  if (await pathExists(destination)) await assertNoReparseTree(destination);
  await fs.mkdir(dirname(destination), { recursive: true });
  await fs.cp(source, destination, {
    recursive: true,
    dereference: false,
    force: true,
    ...(options.filter == null ? {} : { filter: options.filter }),
  });
  await assertNoReparseTree(destination);
}

export async function removeTree(path) {
  await fs.rm(path, { recursive: true, force: true });
}

export async function pathExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function pathLabel(path) {
  return resolve(path);
}

async function assertNoReparsePoint(path, options = {}) {
  const candidate = pathLabel(path);
  let stat;
  try {
    stat = await fs.lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT" && options.allowMissing === true) return false;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Reparse/symbolic-link path is not allowed: ${candidate}`);
  if (stat.isDirectory()) {
    try {
      await options.beforeRealpath?.(candidate);
      const canonical = pathLabel(await fs.realpath(candidate));
      if (canonical.toLowerCase() !== candidate.toLowerCase()) {
        throw new Error(`Reparse/symbolic-link path is not allowed: ${candidate}`);
      }
    } catch (error) {
      if (error?.message?.startsWith("Reparse/symbolic-link path")) throw error;
      if (error?.code === "ENOENT") throw error;
      throw new Error(`Could not verify canonical path for ${candidate}: ${error.message}`, { cause: error });
    }
  }
  return true;
}

export const assertNoReparsePath = assertNoReparsePoint;

export async function assertNoReparseAncestors(path, options = {}) {
  let current = pathLabel(path);
  const root = parsePath(current).root;
  while (true) {
    try {
      await assertNoReparsePoint(current, { skipWindows: true, beforeRealpath: options.beforeRealpath });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (current === root) throw error;
    }
    if (current === root) break;
    current = dirname(current);
  }
}

export async function assertNoReparseTree(root) {
  const treeRoot = pathLabel(root);
  await assertNoReparseAncestors(treeRoot);
  await assertNoReparsePoint(treeRoot);
  const walk = async (current) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(current, entry.name);
      const stat = await fs.lstat(child);
      if (stat.isSymbolicLink()) throw new Error(`Reparse/symbolic-link path is not allowed: ${child}`);
      if (entry.isDirectory()) await walk(child);
    }
  };
  await walk(treeRoot);
}

export async function canonicalizePath(path, options = {}) {
  const lexical = pathLabel(path);
  await assertNoReparseAncestors(lexical);
  const exists = await pathExists(lexical);
  if (exists) {
    const stat = await fs.lstat(lexical);
    if (!stat.isDirectory() && options.directory !== false) throw new Error(`Expected a directory: ${lexical}`);
    const canonical = pathLabel(await fs.realpath(lexical));
    if (canonical.toLowerCase() !== lexical.toLowerCase()) {
      throw new Error(`Path is not canonical or resolves through a reparse point: ${lexical}`);
    }
    return canonical;
  }
  if (options.allowMissing === false) throw new Error(`Path does not exist: ${lexical}`);
  let existing = lexical;
  while (!(await pathExists(existing))) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`Could not resolve path: ${lexical}`);
    existing = parent;
  }
  const canonicalExisting = pathLabel(await fs.realpath(existing));
  return pathLabel(join(canonicalExisting, relative(existing, lexical)));
}

export async function canonicalizeInstallRoot(root) {
  return canonicalizePath(root, { allowMissing: true, directory: true });
}

export async function assertDataRootOutsideInstall(installRoot, dataRoot) {
  const canonicalInstall = await canonicalizePath(installRoot, { allowMissing: true, directory: true });
  const canonicalData = await canonicalizePath(dataRoot, { allowMissing: true, directory: true });
  if (isWithin(canonicalInstall, canonicalData)) {
    throw new Error(`Data root must be outside the install root: ${canonicalData}`);
  }
  await assertNoReparseAncestors(canonicalData);
  return canonicalData;
}

export async function readJson(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

export async function atomicWriteFile(path, contents) {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomSuffix()}`;
  try {
    await fs.writeFile(temporary, contents, "utf8");
    try {
      await fs.rename(temporary, path);
    } catch (error) {
      // Windows may reject replacing an existing file while another reader has
      // it open. Keep the operation recoverable, then retry the final rename.
      if (error?.code !== "EEXIST" && error?.code !== "EPERM" && error?.code !== "ENOTEMPTY") throw error;
      // Never remove the only valid destination before a replacement is
      // guaranteed: a failed retry must leave the previous version intact.
      await fs.rename(temporary, path);
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteJson(path, value) {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function rotateLogFile(path, options = {}) {
  const maxBytes = Number(options.maxBytes ?? 2 * 1024 * 1024);
  const backups = Number(options.backups ?? 2);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Log maxBytes must be a positive integer");
  if (!Number.isSafeInteger(backups) || backups < 1 || backups > 9) throw new Error("Log backups must be between 1 and 9");
  let size;
  try {
    size = (await fs.stat(path)).size;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (size <= maxBytes) return false;
  await fs.rm(`${path}.${backups}`, { force: true });
  for (let index = backups - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    if (await pathExists(source)) await fs.rename(source, `${path}.${index + 1}`);
  }
  await fs.rename(path, `${path}.1`);
  return true;
}

export async function removeOwnedProcessState(path, instanceId, options = {}) {
  const tombstone = `${path}.removing-${randomSuffix()}`;
  try {
    await fs.rename(path, tombstone);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false;
  }
  try {
    if (options.afterRename) await options.afterRename({ tombstone, path });
  } catch {
    await fs.rename(tombstone, path).catch(() => undefined);
    return false;
  }
  let state;
  try {
    state = await readJson(tombstone);
  } catch {
    await fs.rename(tombstone, path).catch(() => undefined);
    return false;
  }
  const identityMatches = options.allowMissingIdentity === true
    ? (instanceId == null ? state?.instanceId == null : state?.instanceId === instanceId)
    : state?.instanceId === instanceId;
  if (!identityMatches) {
    await fs.rename(tombstone, path).catch(() => undefined);
    return false;
  }
  // If a new invocation won the path while the old marker was tombstoned,
  // never replace or remove the new marker. The old, validated tombstone is
  // safe to discard.
  if (await pathExists(path)) {
    await fs.rm(tombstone, { force: true });
    return false;
  }
  try {
    await fs.rm(tombstone, { force: true });
    return true;
  } catch {
    await fs.rename(tombstone, path).catch(() => undefined);
    return false;
  }
}

export async function readInstallState(root) {
  try {
    const state = await readJson(installLayout(root).state);
    if (state == null || state.schemaVersion !== INSTALL_STATE_VERSION) throw new Error("Unsupported install state");
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeInstallState(root, state) {
  const next = {
    schemaVersion: INSTALL_STATE_VERSION,
    product: PRODUCT_NAME,
    ...state,
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteJson(installLayout(root).state, next);
  return next;
}

export function releaseRequiredFiles(options = {}) {
  const dpapiNative = options.dpapiNative ?? null;
  const required = [
    "assets/openbot.ico",
    "assets/openbot.png",
    "runtime/node.exe",
    "runtime/electron/electron.exe",
    "app/package.json",
    "app/scripts/openbot-browser-host.cjs",
    "app/scripts/openbot-electron.cjs",
    "app/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    "app/dist/main.js",
    "app/client/extracted/dist/electron-main/main.cjs",
    "app/client/extracted/dist/electron-preload/preload.cjs",
    "app/client/extracted/dist/renderer/index.html",
    `${PRODUCT_NAME}.cmd`,
    `${PRODUCT_NAME}.vbs`,
    "Uninstall-OpenBot.cmd",
    "Repair-OpenBot.cmd",
    "Update-OpenBot.cmd",
    "Rollback-OpenBot.cmd",
    "Recovery-OpenBot.cmd",
    "scripts/launch.mjs",
    "scripts/shutdown-gateway.mjs",
    "scripts/release-common.mjs",
    "scripts/install.mjs",
    "scripts/update.mjs",
    "scripts/uninstall.mjs",
    "scripts/recovery-center.mjs",
  ];
  if (dpapiNative) required.push(dpapiNative);
  return required;
}

export async function validateReleaseManifest(root, options = {}) {
  const manifestPath = join(root, "manifest.json");
  const manifest = normalizeManifest(await readJson(manifestPath), options);
  if (options.arch != null && manifest.arch !== options.arch) throw new Error(`Release architecture mismatch: ${manifest.arch}`);
  let appPackage;
  try {
    appPackage = await readJson(join(root, "app", "package.json"));
  } catch (error) {
    throw new Error(`Release app/package.json is unreadable: ${error.message}`, { cause: error });
  }
  const appPackageVersion = safeVersion(appPackage.version);
  if (manifest.version !== manifest.packageJsonVersion || manifest.version !== appPackageVersion) {
    throw new Error(
      `Release identity mismatch: manifest.version=${manifest.version}, `
      + `manifest.packageJsonVersion=${manifest.packageJsonVersion}, app/package.json.version=${appPackageVersion}`,
    );
  }
  const expectedDigest = manifest.contentSha256 ?? manifest.payloadSha256 ?? manifest.sha256;
  if (expectedDigest == null) throw new Error("Release manifest must declare a SHA-256 content hash");
  manifest.contentSha256 = safeSha256(expectedDigest, "contentSha256");
  const actualDigest = await treeDigest(root, { exclude: ["manifest.json"] });
  if (actualDigest.toLowerCase() !== manifest.contentSha256) {
    throw new Error(`Release content hash mismatch: expected ${expectedDigest}, got ${actualDigest}`);
  }
  return manifest;
}

export async function preflightRelease(root, options = {}) {
  const releaseRoot = resolve(root);
  const missing = [];
  let manifest = null;
  try {
    manifest = await validateReleaseManifest(releaseRoot, options);
  } catch (error) {
    missing.push(`manifest: ${error.message}`);
  }
  if (manifest && manifest.arch !== "x64") {
    missing.push(`unsupported release architecture: ${manifest.arch}; only x64 DPAPI is currently produced`);
  }
  const dpapiNative = manifest?.runtime?.dpapi ?? null;
  for (const relativePath of releaseRequiredFiles({ dpapiNative })) {
    try {
      const entry = await fs.stat(join(releaseRoot, relativePath));
      if (!entry.isFile()) missing.push(`${relativePath} (not a regular file)`);
    } catch {
      missing.push(relativePath);
    }
  }
  if (manifest?.arch === "x64") {
    const expectedDpapiNative = "app/native/dpapi/win32-x64/openbot-dpapi.node";
    if (dpapiNative !== expectedDpapiNative) {
      missing.push(`runtime.dpapi must be exactly ${expectedDpapiNative}`);
    } else {
      const dpapiPath = join(releaseRoot, expectedDpapiNative);
      try {
        await assertNoReparseAncestors(dpapiPath);
        await assertNoReparsePath(dpapiPath);
        const metadata = await fs.stat(dpapiPath);
        if (!metadata.isFile()) throw new Error("DPAPI addon is not a regular file");
        await validateDpapiNativeArtifact(dpapiPath, manifest.arch);
      } catch (error) {
        missing.push(`${dpapiNative}: ${error.message}`);
      }
    }
  }
  const nativeCandidates = [
    join(releaseRoot, "app", "node_modules", "better-sqlite3", "build", "Release"),
    join(releaseRoot, "app", "client", "extracted", "dist", "deps", "better-sqlite3", "build", "Release"),
  ];
  let nativeFound = false;
  for (const directory of nativeCandidates) {
    try {
      const nativeEntry = await fs.stat(join(directory, "better_sqlite3.node"));
      if (nativeEntry.isFile()) {
        nativeFound = true;
        break;
      }
    } catch {
      // The next candidate may contain the native runtime.
    }
  }
  if (!nativeFound && options.requireNative !== false) missing.push("native/better-sqlite3.node");
  return { ok: missing.length === 0, missing, manifest };
}

export async function assertPreflight(root, options = {}) {
  const result = await preflightRelease(root, options);
  if (!result.ok) throw new Error(`Launch preflight failed:\n- ${result.missing.join("\n- ")}`);
  return result;
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function createShortcut(target, shortcutPath, options = {}) {
  await fs.mkdir(dirname(shortcutPath), { recursive: true });
  if (options.fail === true || process.env.OPENBOT_TEST_SHORTCUT_FAILURE === "1") {
    throw new Error(`Simulated shortcut creation failure: ${shortcutPath}`);
  }
  if (process.env.OPENBOT_SKIP_SHORTCUTS === "1" || options.skip === true) return { path: shortcutPath, skipped: true };
  await assertNoReparsePath(shortcutPath, { allowMissing: true });
  const temporary = join(dirname(shortcutPath), `.openbot-shortcut-${randomSuffix()}.lnk`);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject WScript.Shell",
    `$shortcut = $shell.CreateShortcut(${psQuote(temporary)})`,
    `$shortcut.TargetPath = ${psQuote(target)}`,
    `$shortcut.Arguments = ${psQuote(options.arguments ?? "")}`,
    `$shortcut.WorkingDirectory = ${psQuote(options.workingDirectory ?? dirname(target))}`,
    `$shortcut.Description = ${psQuote(options.description ?? `${PRODUCT_NAME} local desktop`)}`,
    `$shortcut.WindowStyle = ${Number(options.windowStyle ?? 7)}`,
    ...(options.iconLocation == null ? [] : [`$shortcut.IconLocation = ${psQuote(options.iconLocation)}`]),
    "$shortcut.Save()",
  ].join("; ");
  try {
    await execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    // Set identity on a newly generated shortcut, never rewrite foreign property stores.
    if (options.appUserModelId != null) await writeShortcutAppId(temporary, options.appUserModelId);
    await assertNoReparsePath(shortcutPath, { allowMissing: true });
    await fs.rename(temporary, shortcutPath);
    return { path: shortcutPath, skipped: false, fallback: false };
  } catch (error) {
    if (options.allowFallback === false || options.appUserModelId != null) throw error;
    // Generic CI-only fallback. Product shortcuts must fail rather than publish a fake .lnk.
    await fs.writeFile(shortcutPath, `OpenBot shortcut\nTarget=${target}\nIcon=${options.iconLocation ?? ""}\n`, "utf8");
    return { path: shortcutPath, skipped: false, fallback: true };
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Remove the legacy Electron taskbar alias owned by older OpenBot builds.
 *
 * Explorer groups a running window by the shortcut AppUserModelID. Older
 * builds left an Electron.lnk carrying OpenBot.Desktop behind, so Explorer
 * could resolve the taskbar button to Electron's stock icon. Only an alias
 * whose AppID is ours and whose target is actually electron.exe is removed;
 * foreign links are never silently claimed.
 */
export async function removeOwnedElectronTaskbarAlias(startMenuShortcut, options = {}) {
  if (process.platform !== "win32" || extname(startMenuShortcut).toLowerCase() !== ".lnk") return false;
  const canonicalShortcut = resolve(startMenuShortcut);
  const legacyShortcut = join(dirname(canonicalShortcut), "Electron.lnk");
  let before;
  try {
    await assertNoReparseAncestors(legacyShortcut);
    before = await fs.lstat(legacyShortcut);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return false;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    `$link = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(legacyShortcut)})`,
    `$folder = (New-Object -ComObject Shell.Application).Namespace([IO.Path]::GetDirectoryName(${psQuote(legacyShortcut)}))`,
    `$item = $folder.ParseName([IO.Path]::GetFileName(${psQuote(legacyShortcut)}))`,
    "[pscustomobject]@{ target=$link.TargetPath; arguments=$link.Arguments; appId=$item.ExtendedProperty('System.AppUserModel.ID') } | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
  });
  const link = JSON.parse(stdout);
  if (link.appId !== (options.appUserModelId ?? DEFAULT_APP_ID)) return false;
  const target = typeof link.target === "string" && isAbsolute(link.target) ? resolve(link.target) : null;
  const electronTarget = target != null && basename(target).toLowerCase() === "electron.exe";
  if (!electronTarget || typeof link.arguments !== "string" || link.arguments.trim() !== "") {
    throw new Error(`Refusing to replace another application's taskbar shortcut: ${legacyShortcut}`);
  }
  const after = await fs.lstat(legacyShortcut);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`Taskbar shortcut changed before cleanup: ${legacyShortcut}`);
  }
  await fs.unlink(legacyShortcut);
  return true;
}

/** Read native shell fields before claiming/removing a shortcut from a managed install. */
export async function shortcutBelongsToInstall(shortcutPath, installRoot) {
  if (process.platform !== "win32" || extname(shortcutPath).toLowerCase() !== ".lnk") return false;
  try {
    await assertNoReparseAncestors(shortcutPath);
    const before = await fs.lstat(shortcutPath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return false;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
      `$link = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(resolve(shortcutPath))})`,
      "[pscustomobject]@{ target=$link.TargetPath; arguments=$link.Arguments } | ConvertTo-Json -Compress",
    ].join("; ");
    const { stdout } = await execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
    });
    const link = JSON.parse(stdout);
    const after = await fs.lstat(shortcutPath);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return false;
    if (typeof link.target !== "string" || !isAbsolute(link.target) || typeof link.arguments !== "string") return false;
    const target = resolve(link.target).toLowerCase();
    const args = link.arguments.trim();
    const vbs = join(resolve(installRoot), "OpenBot.vbs");
    const cmd = join(resolve(installRoot), "OpenBot.cmd");
    const exe = join(resolve(installRoot), "OpenBot.exe");
    if (args === "" && [vbs, cmd, exe].some(path => target === path.toLowerCase())) return true;
    const wscript = join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
    return target === wscript.toLowerCase() && args.toLowerCase() === `"${vbs}"`.toLowerCase();
  } catch {
    // Missing, malformed, inaccessible or reassigned links are not ours to mutate.
    return false;
  }
}

export async function removeShortcut(shortcutPath) {
  await fs.rm(shortcutPath, { force: true });
  if (await pathExists(shortcutPath)) throw new Error(`Shortcut removal was not verified: ${shortcutPath}`);
}

export async function materializePackage(sourcePath) {
  const source = resolve(sourcePath);
  await assertNoReparseAncestors(source);
  const sourceStat = await fs.stat(source);
  if (sourceStat.isDirectory()) {
    await assertNoReparseTree(source);
    return { root: source, cleanup: async () => undefined };
  }
  if (extname(source).toLowerCase() !== ".zip") throw new Error(`Release package must be a directory or .zip: ${source}`);
  const temporary = await fs.mkdtemp(join(tmpdir(), "openbot-release-"));
  const quote = psQuote(source);
  const destination = psQuote(temporary);
  const script = `Expand-Archive -LiteralPath ${quote} -DestinationPath ${destination} -Force`;
  try {
    await execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    await assertNoReparseTree(temporary);
    if (await pathExists(join(temporary, "manifest.json"))) {
      return { root: temporary, cleanup: () => removeTree(temporary) };
    }
    const entries = await fs.readdir(temporary, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());
    if (directories.length === 1 && await pathExists(join(temporary, directories[0].name, "manifest.json"))) {
      const nested = join(temporary, directories[0].name);
      return { root: nested, cleanup: () => removeTree(temporary) };
    }
    throw new Error("Archive does not contain a root manifest.json");
  } catch (error) {
    await removeTree(temporary);
    throw error;
  }
}

export async function quiesceInstall(root, options = {}) {
  normalizeMaintenanceTimeout(options.timeoutMs);
  const layout = installLayout(root);
  let processState = null;
  try {
    processState = await readJson(layout.processState);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const records = processRecords(processState, layout.root);
  const gatewayRecord = records.find((record) => record.name === "gateway");
  const gatewayUrl = options.gatewayUrl ?? processState?.gateway?.url ?? processState?.gatewayUrl ?? "http://127.0.0.1:1340";
  const gatewayPortPresent = () => options.isPortPresent ? options.isPortPresent(gatewayUrl) : tcpPortPresent(gatewayUrl);
  const query = options.queryProcessEvidence ?? queryProcessEvidence;
  const gatewayInitiallyLive = gatewayRecord != null && await query(gatewayRecord.pid);
  if (gatewayRecord == null && await gatewayPortPresent()) {
    throw new Error("Quiesce refused to proceed while gateway port is active without a provable owned process");
  }
  if (gatewayRecord != null && !gatewayInitiallyLive && await gatewayPortPresent()) {
    throw new Error(`Quiesce refused to remove process state while gateway port is still active`);
  }
  if (gatewayInitiallyLive) {
    const { shutdownGateway } = await import("./shutdown-gateway.mjs");
    const shutdown = await shutdownGateway({
      installRoot: layout.root,
      processState,
      timeoutMs: options.timeoutMs,
      taskkillPath: options.taskkillPath,
      url: gatewayUrl,
      queryProcessEvidence: options.queryProcessEvidence,
      isPortPresent: options.isPortPresent,
    });
    if (!shutdown.teardownProven) {
      if (shutdown.reason === "process-absent" && !(await gatewayPortPresent())) {
        // The recorded process already exited and the fixed gateway port is
        // also absent; this is a proven stale-state cleanup, not a kill.
      } else {
        throw new Error(`Quiesce refused to force gateway PID ${gatewayRecord.pid}; ownership was not proven after graceful shutdown`);
      }
    }
  }
  const pids = [];
  for (const record of records) {
    if (record.name === "gateway") continue;
    if (await query(record.pid)) pids.push(record.pid);
    await terminateOwnedProcess(record, options);
  }
  if (gatewayInitiallyLive) pids.push(gatewayRecord.pid);
  // A process state file is evidence of ownership. Never erase it when a
  // teardown was not proven; the next maintenance attempt must be able to
  // re-check the same PID/creation-time/executable tuple.
  await removeOwnedProcessState(layout.processState, processState?.instanceId, { allowMissingIdentity: processState?.instanceId == null });
  return { pids, processState, gatewayUrl };
}

function processRecords(processState, installRoot) {
  const records = [];
  const evidence = processState?.processes;
  if (evidence != null && typeof evidence === "object") {
    for (const [name, value] of Object.entries(evidence)) {
      const pid = Number(value?.pid);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        records.push({
          name,
          pid,
          creationTime: value.creationTime ?? null,
          expectedExecutable: value.executablePath ?? null,
          expectedRoot: value.expectedRoot ?? installRoot,
        });
      }
    }
  }
  if (records.length === 0) {
    for (const [name, pidValue] of [["electron", processState?.electronPid], ["gateway", processState?.gatewayPid], ["launcher", processState?.launcherPid]]) {
      const pid = Number(pidValue);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        records.push({ name, pid, creationTime: null, expectedExecutable: null, expectedRoot: installRoot });
      }
    }
  }
  if (records.some((record) => record.creationTime == null || record.expectedExecutable == null)) {
    throw new Error("Quiesce refused: process.json lacks ownership evidence");
  }
  return records;
}

export async function queryProcessEvidence(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform !== "win32") {
    try {
      process.kill(pid, 0);
      let creationTime = null;
      let executablePath = resolve(process.execPath);
      let commandLine = null;
      if (process.platform === "linux") {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        const closeParen = stat.lastIndexOf(")");
        const fields = closeParen >= 0 ? stat.slice(closeParen + 2).trim().split(/\s+/u) : [];
        creationTime = fields[19] == null ? null : `proc:${fields[19]}`;
        executablePath = await fs.readlink(`/proc/${pid}/exe`).catch(() => executablePath);
        commandLine = await fs.readFile(`/proc/${pid}/cmdline`, "utf8").then((value) => value.replaceAll("\0", " ").trim()).catch(() => null);
      }
      return { pid, creationTime, executablePath: resolve(executablePath), commandLine };
    } catch {
      return null;
    }
  }
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop`,
    "if ($null -eq $p) { exit 3 }",
    "$p | Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const result = await execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(result.stdout.trim());
    return {
      pid: Number(parsed.ProcessId),
      creationTime: parsed.CreationDate == null ? null : String(parsed.CreationDate),
      executablePath: parsed.ExecutablePath == null ? null : resolve(String(parsed.ExecutablePath)),
      commandLine: parsed.CommandLine == null ? null : String(parsed.CommandLine),
    };
  } catch (error) {
    if (error?.status === 3 || error?.code === 3) return null;
    throw new Error(`Could not inspect process ${pid}: ${error.message}`, { cause: error });
  }
}

export async function captureProcessEvidence(pid, options = {}) {
  const evidence = await queryProcessEvidence(pid);
  if (evidence == null) throw new Error(`Process ${pid} exited before ownership evidence was captured`);
  return {
    pid: evidence.pid,
    creationTime: evidence.creationTime ?? new Date().toISOString(),
    executablePath: resolve(options.expectedExecutable ?? evidence.executablePath ?? process.execPath),
    expectedRoot: resolve(options.expectedRoot ?? process.cwd()),
    commandLine: evidence.commandLine ?? null,
  };
}

function tcpPortPresent(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error("OpenBot gateway URL is invalid");
  }
  const hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
    throw new Error("OpenBot gateway URL must be loopback");
  }
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  return new Promise((resolvePort) => {
    const socket = net.createConnection({ host: parsed.hostname.replace(/^\[|\]$/gu, ""), port });
    const finish = (present) => { socket.destroy(); resolvePort(present); };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export function processOwnershipMatches(record, evidence) {
  if (record.pid !== evidence.pid) return false;
  if (record.creationTime == null || evidence.creationTime == null || String(record.creationTime) !== String(evidence.creationTime)) return false;
  if (record.expectedExecutable == null || evidence.executablePath == null) return false;
  if (resolve(record.expectedExecutable).toLowerCase() !== resolve(evidence.executablePath).toLowerCase()) return false;
  if (record.expectedRoot != null
    && !isWithin(record.expectedRoot, evidence.executablePath)
    && !String(evidence.commandLine ?? "").toLowerCase().includes(resolve(record.expectedRoot).toLowerCase())) return false;
  return true;
}

function normalizeMaintenanceTimeout(value, fallback = 10_000) {
  if (value == null || value === "") return fallback;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) throw new Error("OpenBot quiesce timeout must be a finite non-negative number");
  return normalized;
}

export async function terminateOwnedProcess(record, options = {}) {
  const query = options.queryProcessEvidence ?? queryProcessEvidence;
  const running = options.isProcessRunning ?? isProcessRunning;
  const evidence = await query(record.pid);
  if (evidence == null) return { teardownProven: true, forced: false, pid: record.pid };
  if (!processOwnershipMatches(record, evidence)) {
    throw new Error(`Quiesce refused to terminate PID ${record.pid}; ownership could not be proven`);
  }
  const timeoutMs = normalizeMaintenanceTimeout(options.timeoutMs);
  const platform = options.platform ?? process.platform;
  const invokeTaskkill = async (force) => {
    if (platform !== "win32") {
      try { process.kill(record.pid, "SIGTERM"); } catch { /* already gone */ }
      return;
    }
    const args = ["/PID", String(record.pid), "/T", ...(force ? ["/F"] : [])];
    if (options.runTaskkill) return options.runTaskkill(args, force);
    await execFile(options.taskkillPath ?? "taskkill.exe", args, { windowsHide: true, maxBuffer: 1024 * 1024 });
  };
  try {
    await invokeTaskkill(false);
  } catch {
    // A graceful taskkill can legitimately return nonzero (for example when
    // the process has no window). Continue to the bounded wait and fresh
    // ownership proof; only the force attempt is terminal.
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline && await running(record.pid)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  if (!(await running(record.pid))) return { teardownProven: true, forced: false, pid: record.pid };
  const recheck = await query(record.pid);
  if (!processOwnershipMatches(record, recheck)) {
    throw new Error(`Quiesce refused to force PID ${record.pid}; ownership changed`);
  }
  await invokeTaskkill(true);
  const forceDeadline = Date.now() + timeoutMs;
  while (Date.now() <= forceDeadline && await running(record.pid)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(100, Math.max(1, forceDeadline - Date.now()))));
  }
  if (await running(record.pid)) throw new Error(`Quiesce failed; process ${record.pid} is still running`);
  return { teardownProven: true, forced: true, pid: record.pid };
}

export async function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function terminateProcess(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (process.platform === "win32") {
    try {
      await execFile(options.taskkillPath ?? "taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export function stableLauncherContents(releaseId, productVersion = releaseId) {
  const safeRelease = safeVersion(releaseId);
  const safeProduct = safeVersion(productVersion);
  return `@echo off\r\nsetlocal EnableExtensions\r\nset "OPENBOT_INSTALL_ROOT=%~dp0"\r\nset "OPENBOT_ACTIVE_VERSION=${safeProduct}"\r\nset "OPENBOT_ACTIVE_RELEASE=${safeRelease}"\r\ncall "%~dp0versions\\${safeRelease}\\OpenBot.cmd" %*\r\nexit /b %ERRORLEVEL%\r\n`;
}

export function hiddenLauncherContents() {
  return [
    "Option Explicit",
    "Dim fileSystem, shell, rootDirectory, launcher, logsDirectory, logFile, logEntry, command, exitCode",
    'Set fileSystem = CreateObject("Scripting.FileSystemObject")',
    'Set shell = CreateObject("WScript.Shell")',
    "rootDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)",
    'launcher = fileSystem.BuildPath(rootDirectory, "OpenBot.cmd")',
    'logsDirectory = fileSystem.BuildPath(rootDirectory, "logs")',
    "If Not fileSystem.FolderExists(logsDirectory) Then fileSystem.CreateFolder(logsDirectory)",
    "For Each logEntry In fileSystem.GetFolder(logsDirectory).Files",
    'If LCase(Left(logEntry.Name, 9)) = "launcher-" Then If DateDiff("d", logEntry.DateLastModified, Now) > 7 Then logEntry.Delete True',
    "Next",
    'logFile = fileSystem.BuildPath(logsDirectory, "launcher-" & fileSystem.GetTempName)',
    "shell.CurrentDirectory = rootDirectory",
    'command = Chr(34) & shell.ExpandEnvironmentStrings("%ComSpec%") & Chr(34) & " /d /c " & Chr(34) & Chr(34) & launcher & Chr(34) & " >> " & Chr(34) & logFile & Chr(34) & " 2>&1" & Chr(34)',
    "exitCode = shell.Run(command, 0, True)",
    'If exitCode <> 0 Then MsgBox "OpenBot nao conseguiu iniciar." & vbCrLf & "Consulte: " & logFile, vbCritical, "OpenBot"',
    "If exitCode = 0 Then If fileSystem.FileExists(logFile) Then fileSystem.DeleteFile logFile, True",
    "WScript.Quit exitCode",
    "",
  ].join("\r\n");
}

export function versionLauncherContents() {
  return `@echo off\r\nsetlocal EnableExtensions\r\nset "OPENBOT_RELEASE_ROOT=%~dp0"\r\nif not defined OPENBOT_INSTALL_ROOT set "OPENBOT_INSTALL_ROOT=%~dp0"\r\nset "ELECTRON_RUN_AS_NODE="\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\launch.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`;
}

export function lifecycleWrapperContents(kind, options = {}) {
  const isRepair = kind === "repair";
  const wrapperShortcutRoot = !isRepair && options.shortcutRoot != null && String(options.shortcutRoot).trim() !== ""
    ? resolve(String(options.shortcutRoot))
    : null;
  const wrapperShortcutRootBase64 = wrapperShortcutRoot == null
    ? ""
    : Buffer.from(wrapperShortcutRoot, "utf8").toString("base64");
  const loadActiveVersion =
    `for /f "usebackq delims=" %%V in (\`powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$s=ConvertFrom-Json -InputObject (Get-Content -Raw -LiteralPath (Join-Path -Path $env:OPENBOT_ROOT -ChildPath 'state.json')); if ($s.activeReleaseId) {$s.activeReleaseId} else {$s.activeVersion}"\`) do set "OPENBOT_VERSION=%%V"`;
  const script = isRepair ? "install.mjs" : "uninstall.mjs";
  const outerDelegatedCleanup = isRepair
    ? 'pushd "%TEMP%" >nul || goto :openbot_outer_fail & "%ComSpec%" /d /v:on /c call "%OPENBOT_WRAPPER_TEMP%\\lifecycle-wrapper.cmd" %* & set "OPENBOT_EXIT=!ERRORLEVEL!" & rmdir /S /Q "%OPENBOT_WRAPPER_TEMP%" >nul 2>&1 & (if exist "%OPENBOT_WRAPPER_TEMP%" set "OPENBOT_EXIT=1") & exit !OPENBOT_EXIT!'
    : 'pushd "%TEMP%" >nul || goto :openbot_outer_fail & "%ComSpec%" /d /v:on /c call "%OPENBOT_WRAPPER_TEMP%\\lifecycle-wrapper.cmd" %* & set "OPENBOT_EXIT=!ERRORLEVEL!" & rmdir /S /Q "%OPENBOT_WRAPPER_TEMP%" >nul 2>&1 & (if exist "%OPENBOT_WRAPPER_TEMP%" set "OPENBOT_EXIT=1") & exit !OPENBOT_EXIT!';
  const argumentsBlock = isRepair
    ? [
      'if "%~1"=="" (',
      "  echo Usage: Repair-OpenBot.cmd ^<release-directory-or-zip^> 1>&2",
      '  set "OPENBOT_EXIT=2"',
      "  goto :openbot_inner_fail",
      ")",
      'set "OPENBOT_PACKAGE=%~1"',
    ]
    : [];
  const command = isRepair
    ? '"%OPENBOT_TEMP%\\node.exe" "%OPENBOT_TEMP%\\install.mjs" --repair --package "%OPENBOT_PACKAGE%" --root "%OPENBOT_ROOT%"'
      + " %*"
    : '"%OPENBOT_TEMP%\\node.exe" "%OPENBOT_TEMP%\\uninstall.mjs" --run-deferred-args "%OPENBOT_TEMP%\\uninstall-args.json"';
  return [
    "@echo off",
    "setlocal EnableExtensions EnableDelayedExpansion",
    'set "OPENBOT_EXIT="',
    `set "OPENBOT_WRAPPER_SHORTCUT_ROOT_B64=${wrapperShortcutRootBase64}"`,
    'if defined OPENBOT_WRAPPER_COPY goto :openbot_inner',
    'set "OPENBOT_WRAPPER_ROOT=%~dp0"',
    'set "OPENBOT_ROOT=%OPENBOT_WRAPPER_ROOT%"',
    'if "%OPENBOT_ROOT:~-1%"=="\\" set "OPENBOT_ROOT=%OPENBOT_ROOT:~0,-1%"',
    'set "OPENBOT_WRAPPER_TEMP=%TEMP%\\OpenBot-lifecycle-wrapper-%RANDOM%-%RANDOM%"',
    'set "OPENBOT_TEMP=%TEMP%\\OpenBot-lifecycle-runtime-%RANDOM%-%RANDOM%"',
    'mkdir "%OPENBOT_WRAPPER_TEMP%" >nul 2>&1 || goto :openbot_outer_fail',
    'mkdir "%OPENBOT_TEMP%" >nul 2>&1 || goto :openbot_outer_fail',
    'copy /Y "%~f0" "%OPENBOT_WRAPPER_TEMP%\\lifecycle-wrapper.cmd" >nul || goto :openbot_outer_fail',
    'set "OPENBOT_WRAPPER_COPY=1"',
    outerDelegatedCleanup,
    ":openbot_inner",
    'set "OPENBOT_ROOT=%OPENBOT_WRAPPER_ROOT%"',
    'if "%OPENBOT_ROOT:~-1%"=="\\" set "OPENBOT_ROOT=%OPENBOT_ROOT:~0,-1%"',
    loadActiveVersion,
    'if not defined OPENBOT_VERSION (echo OpenBot install state is missing; use the package installer. 1>&2 & set "OPENBOT_EXIT=2" & goto :openbot_inner_fail)',
    'set "OPENBOT_SOURCE=%OPENBOT_ROOT%\\versions\\%OPENBOT_VERSION%"',
    'if not defined OPENBOT_TEMP set "OPENBOT_TEMP=%TEMP%\\OpenBot-lifecycle-%RANDOM%-%RANDOM%"',
    'if not exist "%OPENBOT_TEMP%" mkdir "%OPENBOT_TEMP%" >nul 2>&1 || goto :openbot_inner_fail',
    'copy /Y "%OPENBOT_SOURCE%\\runtime\\node.exe" "%OPENBOT_TEMP%\\node.exe" >nul || goto :openbot_inner_fail',
    `copy /Y "%OPENBOT_SOURCE%\\scripts\\release-common.mjs" "%OPENBOT_TEMP%\\release-common.mjs" >nul || goto :openbot_inner_fail`,
    'if exist "%OPENBOT_SOURCE%\\scripts\\shortcut-appid.mjs" (copy /Y "%OPENBOT_SOURCE%\\scripts\\shortcut-appid.mjs" "%OPENBOT_TEMP%\\shortcut-appid.mjs" >nul || goto :openbot_inner_fail)',
    `copy /Y "%OPENBOT_SOURCE%\\scripts\\${script}" "%OPENBOT_TEMP%\\${script}" >nul || goto :openbot_inner_fail`,
    ...argumentsBlock,
    ...(isRepair ? ['copy /Y "%OPENBOT_SOURCE%\\scripts\\update.mjs" "%OPENBOT_TEMP%\\update.mjs" >nul || goto :openbot_inner_fail'] : []),
    'set "OPENBOT_INSTALL_ROOT=%OPENBOT_ROOT%"',
    'pushd "%OPENBOT_TEMP%" >nul || goto :openbot_inner_fail',
    ...(isRepair ? [] : [
      '"%OPENBOT_TEMP%\\node.exe" "%OPENBOT_TEMP%\\uninstall.mjs" --prepare-deferred-args "%OPENBOT_TEMP%\\uninstall-args.json" "%OPENBOT_ROOT%" %* > "%OPENBOT_TEMP%\\uninstall-error.log" 2>&1',
      'if errorlevel 1 (type "%OPENBOT_TEMP%\\uninstall-error.log" 1>&2 & popd & goto :openbot_inner_fail)',
      'del /q "%OPENBOT_TEMP%\\uninstall-error.log" >nul 2>&1',
    ]),
    command,
    'set "OPENBOT_EXIT=!ERRORLEVEL!"',
    'popd',
    'rmdir /S /Q "%OPENBOT_TEMP%" >nul 2>&1',
    'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$p=$env:OPENBOT_TEMP; for($i=0; $i -lt 20 -and (Test-Path -LiteralPath $p); $i++){ Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 100 }; if(Test-Path -LiteralPath $p){ exit 1 }" >nul 2>&1',
    'if exist "%OPENBOT_TEMP%" (set "OPENBOT_EXIT=1" & echo Temporary lifecycle directory cleanup was not verified. 1>&2)',
    'exit /b !OPENBOT_EXIT!',
    ":openbot_inner_fail",
    'if not defined OPENBOT_EXIT set "OPENBOT_EXIT=1"',
    'rmdir /S /Q "%OPENBOT_TEMP%" >nul 2>&1',
    'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$p=$env:OPENBOT_TEMP; for($i=0; $i -lt 20 -and (Test-Path -LiteralPath $p); $i++){ Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 100 }; if(Test-Path -LiteralPath $p){ exit 1 }" >nul 2>&1',
    'if exist "%OPENBOT_TEMP%" (echo Temporary lifecycle directory cleanup was not verified. 1>&2 & exit /b 1)',
    'exit /b %OPENBOT_EXIT%',
    ":openbot_outer_fail",
    'set "OPENBOT_EXIT=1"',
    ":openbot_outer_cleanup",
    'for %%D in ("%SystemRoot%" "%TEMP%") do if exist "%%~fD" (pushd "%%~fD" >nul 2>&1 & popd)',
    'set "OPENBOT_CLEANUP_EXIT=0"',
    'rmdir /S /Q "%OPENBOT_TEMP%" >nul 2>&1',
    'if exist "%OPENBOT_TEMP%" (echo Temporary lifecycle directory cleanup was not verified. 1>&2 & set "OPENBOT_CLEANUP_EXIT=1")',
    'rmdir /S /Q "%OPENBOT_WRAPPER_TEMP%" >nul 2>&1',
    'if exist "%OPENBOT_WRAPPER_TEMP%" (echo Temporary wrapper directory cleanup was not verified. 1>&2 & set "OPENBOT_CLEANUP_EXIT=1")',
    'if "!OPENBOT_CLEANUP_EXIT!"=="1" set "OPENBOT_EXIT=1"',
    'exit /b !OPENBOT_EXIT!',
    "",
  ].join("\r\n");
}

export function maintenanceWrapperContents(kind) {
  if (kind !== "update" && kind !== "rollback") throw new Error(`Unsupported maintenance wrapper: ${kind}`);
  const argumentCheck = kind === "update" ? [
    'if "%~1"=="" (',
    "  echo Usage: Update-OpenBot.cmd ^<release-directory-or-zip^> 1^>^&2",
    "  exit /b 2",
    ")",
    'set "OPENBOT_PACKAGE=%~1"',
  ] : [];
  const command = kind === "update"
    ? '"%OPENBOT_NODE%" "%OPENBOT_SCRIPT%" --package "%OPENBOT_PACKAGE%" --root "%OPENBOT_ROOT%"'
    : '"%OPENBOT_NODE%" "%OPENBOT_SCRIPT%" --rollback --root "%OPENBOT_ROOT%"';
  return [
    "@echo off",
    "setlocal EnableExtensions",
    'set "OPENBOT_ROOT=%~dp0"',
    'if "%OPENBOT_ROOT:~-1%"=="\\" set "OPENBOT_ROOT=%OPENBOT_ROOT:~0,-1%"',
    `for /f "usebackq delims=" %%V in (\`powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$s=ConvertFrom-Json -InputObject (Get-Content -Raw -LiteralPath (Join-Path -Path $env:OPENBOT_ROOT -ChildPath 'state.json')); if ($s.activeReleaseId) {$s.activeReleaseId} else {$s.activeVersion}"\`) do set "OPENBOT_VERSION=%%V"`,
    'if not defined OPENBOT_VERSION (echo OpenBot install state is missing. 1>&2 & exit /b 2)',
    'set "OPENBOT_NODE=%OPENBOT_ROOT%\\versions\\%OPENBOT_VERSION%\\runtime\\node.exe"',
    'set "OPENBOT_SCRIPT=%OPENBOT_ROOT%\\versions\\%OPENBOT_VERSION%\\scripts\\update.mjs"',
    ...argumentCheck,
    command,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

export function recoveryWrapperContents() {
  return [
    "@echo off",
    "setlocal EnableExtensions",
    'set "OPENBOT_ROOT=%~dp0"',
    'if "%OPENBOT_ROOT:~-1%"=="\\" set "OPENBOT_ROOT=%OPENBOT_ROOT:~0,-1%"',
    `for /f "usebackq delims=" %%V in (\`powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$s=ConvertFrom-Json -InputObject (Get-Content -Raw -LiteralPath (Join-Path -Path $env:OPENBOT_ROOT -ChildPath 'state.json')); if ($s.activeReleaseId) {$s.activeReleaseId} else {$s.activeVersion}"\`) do set "OPENBOT_VERSION=%%V"`,
    'if not defined OPENBOT_VERSION (echo OpenBot install state is missing. 1>&2 & exit /b 2)',
    'set "OPENBOT_NODE=%OPENBOT_ROOT%\\versions\\%OPENBOT_VERSION%\\runtime\\node.exe"',
    'set "OPENBOT_SCRIPT=%OPENBOT_ROOT%\\versions\\%OPENBOT_VERSION%\\scripts\\recovery-center.mjs"',
    'if "%~1"=="" ("%OPENBOT_NODE%" "%OPENBOT_SCRIPT%" status --root "%OPENBOT_ROOT%") else ("%OPENBOT_NODE%" "%OPENBOT_SCRIPT%" %* --root "%OPENBOT_ROOT%")',
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

export async function writeLifecycleWrappers(root, options = {}) {
  await atomicWriteFile(join(root, "Uninstall-OpenBot.cmd"), lifecycleWrapperContents("uninstall", {
    shortcutRoot: options.shortcutRoot,
  }));
  await atomicWriteFile(join(root, "Repair-OpenBot.cmd"), lifecycleWrapperContents("repair"));
  await atomicWriteFile(join(root, "Update-OpenBot.cmd"), maintenanceWrapperContents("update"));
  await atomicWriteFile(join(root, "Rollback-OpenBot.cmd"), maintenanceWrapperContents("rollback"));
  await atomicWriteFile(join(root, "Recovery-OpenBot.cmd"), recoveryWrapperContents());
}

export async function writeStableLauncher(root, releaseId, productVersion = releaseId) {
  await atomicWriteFile(installLayout(root).launcher, stableLauncherContents(releaseId, productVersion));
  await atomicWriteFile(join(root, `${PRODUCT_NAME}.vbs`), hiddenLauncherContents());
  try {
    await atomicWriteFile(join(root, `${PRODUCT_NAME}.ico`), await fs.readFile(join(root, "versions", releaseId, "assets", "openbot.ico")));
  } catch (error) {
    if (error?.code !== "ENOENT" || !(await pathExists(join(root, `${PRODUCT_NAME}.ico`)))) throw error;
  }
}

export async function writeVersionLauncher(root) {
  await atomicWriteFile(join(root, `${PRODUCT_NAME}.cmd`), versionLauncherContents());
  await atomicWriteFile(join(root, `${PRODUCT_NAME}.vbs`), hiddenLauncherContents());
}

export async function writeDataRootMarker(installRoot, dataRoot) {
  const canonicalInstall = await canonicalizePath(installRoot, { allowMissing: true, directory: true });
  const canonicalData = await assertDataRootOutsideInstall(canonicalInstall, dataRoot);
  await fs.mkdir(canonicalData, { recursive: true });
  const markerPath = join(canonicalData, DATA_ROOT_MARKER);
  if (await pathExists(markerPath)) {
    let marker;
    try {
      marker = await readJson(markerPath);
    } catch {
      throw new Error(`Data root ownership marker is unreadable; refusing to replace it: ${canonicalData}`);
    }
    const markerInstall = resolve(marker?.installRoot ?? "");
    const markerData = resolve(marker?.dataRoot ?? "");
    if (marker?.schemaVersion !== 1 || marker?.product !== PRODUCT_NAME || markerData.toLowerCase() !== canonicalData.toLowerCase()) {
      throw new Error(`Data root ownership marker is invalid; refusing to replace it: ${canonicalData}`);
    }
    if (markerInstall.toLowerCase() !== canonicalInstall.toLowerCase()) {
      throw new Error(`Data root belongs to another OpenBot installation: ${markerInstall}`);
    }
  }
  await atomicWriteJson(markerPath, {
    schemaVersion: 1,
    product: PRODUCT_NAME,
    installRoot: canonicalInstall,
    dataRoot: canonicalData,
  });
  return canonicalData;
}

export async function assertOwnedDataRoot(installRoot, dataRoot) {
  const canonicalInstall = await canonicalizePath(installRoot, { allowMissing: true, directory: true });
  const canonicalData = await canonicalizePath(dataRoot, { allowMissing: false, directory: true });
  let marker;
  try {
    marker = await readJson(join(canonicalData, DATA_ROOT_MARKER));
  } catch (error) {
    throw new Error(`Data root ownership marker is missing or unreadable: ${canonicalData}`, { cause: error });
  }
  if (marker?.schemaVersion !== 1 || marker?.product !== PRODUCT_NAME
      || resolve(marker.installRoot ?? "").toLowerCase() !== canonicalInstall.toLowerCase()
      || resolve(marker.dataRoot ?? "").toLowerCase() !== canonicalData.toLowerCase()) {
    throw new Error(`Data root ownership marker does not match this installation: ${canonicalData}`);
  }
  return canonicalData;
}

export function assertManagedInstallRoot(root, state) {
  const resolvedRoot = resolve(root);
  const sameRoot = typeof state?.installRoot === "string"
    && state.installRoot.toLowerCase() === resolvedRoot.toLowerCase();
  if (state == null || state.product !== PRODUCT_NAME || !sameRoot) {
    throw new Error(`Refusing to operate on an unmanaged install root: ${resolvedRoot}`);
  }
}

export function releaseFileName(manifest, extension = "") {
  return `${PRODUCT_NAME}-${manifest.releaseId ?? manifest.version}-${manifest.platform}-${manifest.arch}${extension}`;
}

export function isWithin(parent, child) {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

export function pathBasename(path) {
  return basename(path);
}
