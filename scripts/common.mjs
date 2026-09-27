// Shared helpers for the checkout scripts (launcher, shortcuts, recovery,
// verification gates). Kept free of dist/ imports so tests and gates can load
// it before a build.
import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeShortcutAppId } from "./shortcut-appid.mjs";

const execFile = promisify(execFileCallback);

const PRODUCT_NAME = "OpenBot";

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

export function isMainModule(metaUrl) {
  if (process.argv[1] == null) return false;
  return resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(metaUrl)).toLowerCase();
}

export function randomSuffix() {
  return `${process.pid}-${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
}

function samePath(left, right) {
  return resolve(String(left)).toLowerCase() === resolve(String(right)).toLowerCase();
}

export function isWithin(parent, child) {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

/** Absolute System32 path, so PATH (for example Git Bash coreutils) cannot shadow Windows tools. */
export function systemToolPath(name, env = process.env) {
  return join(env.SystemRoot || env.windir || "C:\\Windows", "System32", name);
}

export function windowsPowerShellPath(env = process.env) {
  return join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// ---------------------------------------------------------------- data roots

function defaultAppDataRoot(env = process.env) {
  return env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
}

function defaultLocalAppDataRoot(env = process.env) {
  return env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
}

export function defaultDataRoot(env = process.env) {
  return env.OPENBOT_DATA_ROOT?.trim() || join(defaultAppDataRoot(env), PRODUCT_NAME);
}

export function defaultLocalDataRoot(env = process.env) {
  return env.OPENBOT_LOCAL_DATA_ROOT?.trim() || join(defaultLocalAppDataRoot(env), PRODUCT_NAME);
}

// ------------------------------------------------------------------- files

export async function pathExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

export async function removeTree(path) {
  await fs.rm(path, { recursive: true, force: true });
}

// Windows reports transient sharing violations while antivirus, indexers or
// a reader hold the destination open.
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES", "EEXIST", "ENOTEMPTY"]);
const RENAME_ATTEMPTS = 5;

/**
 * Publish `contents` at `path` atomically: write and fsync a sibling temp file,
 * then rename it over the destination. The previous version stays intact on
 * any failure; the temp file never survives.
 */
export async function atomicWriteFile(path, contents) {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomSuffix()}`;
  try {
    const handle = await fs.open(temporary, "w");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await fs.rename(temporary, path);
        return;
      } catch (error) {
        if (!RENAME_RETRY_CODES.has(error?.code) || attempt >= RENAME_ATTEMPTS) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20 * attempt));
      }
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteJson(path, value) {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Shift `path` to `path.1` (and older backups up) once it exceeds maxBytes. */
export async function rotateLogFile(path, options = {}) {
  const maxBytes = Number(options.maxBytes ?? 2 * 1024 * 1024);
  const backups = Number(options.backups ?? 2);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Log maxBytes must be a non-negative integer");
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

// ---------------------------------------------------- reparse-safe file trees

async function assertNoReparsePoint(path, options = {}) {
  const candidate = resolve(path);
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
      const canonical = resolve(await fs.realpath(candidate));
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
  let current = resolve(path);
  const root = parsePath(current).root;
  while (true) {
    try {
      await assertNoReparsePoint(current, { beforeRealpath: options.beforeRealpath });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (current === root) throw error;
    }
    if (current === root) break;
    current = dirname(current);
  }
}

/** Every regular file under root, sorted; rejects any link on the way. */
async function listTreeFiles(root, current = root, output = []) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Reparse/symbolic-link path is not allowed: ${path}`);
    if (entry.isDirectory()) {
      // Directory junctions are not symlinks to readdir; realpath exposes them.
      await assertNoReparsePoint(path);
      await listTreeFiles(root, path, output);
    } else if (entry.isFile()) {
      output.push(path);
    }
  }
  return output;
}

async function assertNoReparseTree(root) {
  const treeRoot = resolve(root);
  await assertNoReparseAncestors(treeRoot);
  await listTreeFiles(treeRoot);
}

/** Content digest of a tree (relative path, size and bytes of every file), in one walk. */
export async function treeDigest(root) {
  const treeRoot = resolve(root);
  await assertNoReparseAncestors(treeRoot);
  const hash = createHash("sha256");
  for (const file of await listTreeFiles(treeRoot)) {
    const stat = await fs.stat(file);
    hash.update(relative(treeRoot, file).split(sep).join("/")).update("\0").update(String(stat.size)).update("\0");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function copyTree(source, destination) {
  await assertNoReparseTree(source);
  await assertNoReparseAncestors(destination);
  if (await pathExists(destination)) await assertNoReparseTree(destination);
  await fs.mkdir(dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, dereference: false, force: true, errorOnExist: false });
  // A link swapped in while copying would be copied as a link: re-check.
  await assertNoReparseTree(destination);
}

export async function canonicalizePath(path, options = {}) {
  const lexical = resolve(path);
  await assertNoReparseAncestors(lexical);
  if (await pathExists(lexical)) {
    const stat = await fs.lstat(lexical);
    if (!stat.isDirectory() && options.directory !== false) throw new Error(`Expected a directory: ${lexical}`);
    const canonical = resolve(await fs.realpath(lexical));
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
  return resolve(join(resolve(await fs.realpath(existing)), relative(existing, lexical)));
}

// ------------------------------------------------------------- DPAPI addon

const DPAPI_PE_MACHINE = Object.freeze({ x64: 0x8664, arm64: 0xaa64, ia32: 0x014c });

function expectedDpapiPeMachine(arch) {
  const machine = DPAPI_PE_MACHINE[String(arch)];
  if (machine == null) throw new Error(`Unsupported DPAPI architecture: ${arch}`);
  return machine;
}

async function readPeMachine(file) {
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

// --------------------------------------------------------------- shortcuts

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function runPowerShell(script, options = {}) {
  return execFile(windowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024, ...options,
  });
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
    await runPowerShell(script);
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

// --------------------------------------------------------- process evidence

/** Executable, command line and creation time of a live process, or null when it is gone. */
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
    const result = await runPowerShell(script);
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

/** Same PID, same creation time, same executable, and tied to the expected root. */
export function processOwnershipMatches(record, evidence) {
  if (record == null || evidence == null || record.pid !== Number(evidence.pid)) return false;
  if (record.creationTime == null || evidence.creationTime == null || String(record.creationTime) !== String(evidence.creationTime)) return false;
  const expectedExecutable = record.expectedExecutable ?? record.executablePath;
  if (expectedExecutable == null || evidence.executablePath == null || !samePath(expectedExecutable, evidence.executablePath)) return false;
  if (record.expectedRoot != null
    && !isWithin(record.expectedRoot, evidence.executablePath)
    && !String(evidence.commandLine ?? "").toLowerCase().includes(resolve(record.expectedRoot).toLowerCase())) return false;
  return true;
}

export async function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return error?.code === "EPERM";
  }
}

function normalizeTimeout(value, fallback = 10_000) {
  if (value == null || value === "") return fallback;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) throw new Error("OpenBot timeout must be a finite non-negative number");
  return normalized;
}

async function waitUntilGone(pid, running, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline && await running(pid)) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  return !(await running(pid));
}

/**
 * Stop a process tree whose identity was captured earlier: a polite taskkill,
 * a bounded wait, then /F only after a fresh ownership proof, so a recycled
 * PID is never killed.
 */
export async function terminateOwnedProcess(record, options = {}) {
  const query = options.queryProcessEvidence ?? queryProcessEvidence;
  const running = options.isProcessRunning ?? isProcessRunning;
  const evidence = await query(record.pid);
  if (evidence == null) return { teardownProven: true, forced: false, pid: record.pid };
  if (!processOwnershipMatches(record, evidence)) {
    throw new Error(`Refused to terminate PID ${record.pid}; ownership could not be proven`);
  }
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const platform = options.platform ?? process.platform;
  const invokeTaskkill = async (force) => {
    if (platform !== "win32") {
      try { process.kill(record.pid, force ? "SIGKILL" : "SIGTERM"); } catch { /* already gone */ }
      return;
    }
    const args = ["/PID", String(record.pid), "/T", ...(force ? ["/F"] : [])];
    if (options.runTaskkill) return options.runTaskkill(args, force);
    await execFile(options.taskkillPath ?? systemToolPath("taskkill.exe"), args, { windowsHide: true, maxBuffer: 1024 * 1024 });
  };
  try {
    await invokeTaskkill(false);
  } catch {
    // A polite taskkill fails for processes without a window. The bounded
    // wait and the fresh ownership proof below decide what happens next.
  }
  if (await waitUntilGone(record.pid, running, timeoutMs)) return { teardownProven: true, forced: false, pid: record.pid };
  const recheck = await query(record.pid);
  if (recheck == null) return { teardownProven: true, forced: false, pid: record.pid };
  if (!processOwnershipMatches(record, recheck)) {
    throw new Error(`Refused to force PID ${record.pid}; ownership changed`);
  }
  await invokeTaskkill(true);
  if (!(await waitUntilGone(record.pid, running, timeoutMs))) throw new Error(`Process ${record.pid} is still running after a forced stop`);
  return { teardownProven: true, forced: true, pid: record.pid };
}
