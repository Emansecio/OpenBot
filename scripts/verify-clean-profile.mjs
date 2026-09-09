import { promises as fs } from "node:fs";
import { cp, mkdtemp, readdir, readFile, realpath, rm, mkdir, writeFile, lstat, stat } from "node:fs/promises";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { captureProcessEvidence, terminateOwnedProcess } from "./release-common.mjs";

const execFile = promisify(execFileCallback);
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SENSITIVE_ENV_NAME = /(?:API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/iu;
const PROVIDER_ENV_NAME = /^(?:AWS|AZURE|GOOGLE|GCP|OCI|OPENAI|ANTHROPIC|XAI|GH|GITHUB|NPM|VAULT|KUBECONFIG)(?:_|$)/iu;
const REMOVED_ENV_NAMES = new Set([
  "OPENBOT_GATEWAY_TOKEN", "OPENBOT_GATEWAY_NETWORK_TOKEN", "OPENBOT_INSTALL_ROOT",
  "SAND_HOST_GATEWAY_TOKEN", "SAND_HOST_GATEWAY_NETWORK_TOKEN", "E2E_GATEWAY_TOKEN",
  "ELECTRON_RUN_AS_NODE", "NODE_PATH", "NODE_OPTIONS",
]);
const PROFILE_ENV_NAMES = new Set([
  "APPDATA", "LOCALAPPDATA", "OPENBOT_DATA_ROOT", "OPENBOT_LOCAL_DATA_ROOT",
  "OPENBOT_USER_DATA", "OPENBOT_LOG_DIR", "OPENBOT_GATEWAY_TOKEN_PATH",
  "SAND_USER_DATA_DIR", "SAND_DATA_ROOT", "SAND_HOST_GATEWAY_URL",
]);

function cleanPath(value) { return resolve(String(value)); }
function isWithin(root, candidate) {
  const suffix = relative(cleanPath(root), cleanPath(candidate));
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

export function createCleanProfilePaths(tempRoot) {
  const root = cleanPath(tempRoot);
  const appData = join(root, "appdata");
  const localAppData = join(root, "localappdata");
  const dataRoot = join(root, "data-root");
  const localDataRoot = join(root, "local-data-root");
  const userData = join(root, "user-data");
  const installRoot = join(root, "install");
  const logs = join(root, "logs");
  return {
    tempRoot: root, appData, localAppData, dataRoot, localDataRoot, userData,
    installRoot, logs, configPath: join(dataRoot, "openbot-config.json"),
    storePath: join(dataRoot, "store.db"), keystoreDir: dataRoot,
    runtimeRoot: join(localDataRoot, "runtime"), browserRoot: join(localDataRoot, "browser"),
    workspacesRoot: join(localDataRoot, "workspaces"), processStatePath: join(installRoot, "process.json"),
  };
}

export async function assertCleanProfilePaths(paths, tempRoot = paths.tempRoot) {
  const errors = [];
  for (const [name, value] of Object.entries(paths)) {
    if (typeof value !== "string" || !isWithin(tempRoot, value)) errors.push(`${name} escapes TempRoot`);
    if (typeof value !== "string") continue;
    try {
      const info = await lstat(value);
      if (info.isSymbolicLink()) errors.push(`${name} is a reparse/symbolic path`);
      const actual = await realpath(value);
      if (!isWithin(tempRoot, actual)) errors.push(`${name} real path escapes TempRoot`);
    } catch (error) {
      if (error?.code !== "ENOENT") errors.push(`${name} cannot be verified`);
    }
  }
  if (errors.length > 0) throw new Error(`clean-profile path isolation failed: ${errors.join(", ")}`);
  return true;
}

export function buildCleanProfileEnvironment(baseEnv, paths) {
  const env = {};
  for (const [name, value] of Object.entries(baseEnv ?? {})) {
    const normalizedName = name.toUpperCase();
    if (value == null || PROFILE_ENV_NAMES.has(normalizedName) || REMOVED_ENV_NAMES.has(normalizedName) || SENSITIVE_ENV_NAME.test(name) || PROVIDER_ENV_NAME.test(name) || /^NODE_/iu.test(name)) continue;
    env[name] = value;
  }
  Object.assign(env, {
    APPDATA: paths.appData, LOCALAPPDATA: paths.localAppData,
    OPENBOT_DATA_ROOT: paths.dataRoot, OPENBOT_LOCAL_DATA_ROOT: paths.localDataRoot,
    OPENBOT_USER_DATA: paths.userData, OPENBOT_INSTALL_ROOT: paths.installRoot,
    OPENBOT_LOG_DIR: paths.logs,
  });
  return env;
}

export async function ensureRoots(paths) {
  await assertCleanProfilePaths(paths);
  for (const path of [paths.appData, paths.localAppData, paths.dataRoot, paths.localDataRoot, paths.userData, paths.installRoot, paths.logs]) {
    await mkdir(path, { recursive: true });
  }
  await assertCleanProfilePaths(paths);
}

async function resolveDependencyDirectory(name, fromDirectory) {
  let current = fromDirectory;
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if (await fileExists(join(candidate, "package.json"))) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function copyRuntimeDependency(name, sourceNodeModules, targetNodeModules, copied, fromDirectory = sourceNodeModules) {
  if (copied.has(name)) return;
  // better-sqlite3 declares prebuild-install for installation, but its
  // runtime loads only bindings (and the native .node already in its build).
  if (name === "prebuild-install") return;
  const sourceDirectory = await resolveDependencyDirectory(name, fromDirectory);
  if (!sourceDirectory) throw new Error(`clean-profile runtime dependency unavailable: ${name}`);
  const targetDirectory = join(targetNodeModules, ...name.split("/"));
  copied.add(name);
  await cp(sourceDirectory, targetDirectory, { recursive: true, force: true, dereference: true });
  const manifest = JSON.parse(await readFile(join(sourceDirectory, "package.json"), "utf8"));
  const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) };
  for (const dependencyName of Object.keys(dependencies)) {
    await copyRuntimeDependency(dependencyName, sourceNodeModules, targetNodeModules, copied, sourceDirectory);
  }
}

export function cleanProfileDpapiAddonRelativePath() {
  return join("native", "dpapi", `win32-${process.arch}`, "openbot-dpapi.node");
}

export async function copyInstall(paths) {
  await cp(join(REPO_ROOT, "dist"), join(paths.installRoot, "dist"), { recursive: true, force: true, dereference: true });
  await writeFile(join(paths.installRoot, "package.json"), '{"private":true,"type":"module"}\n', "utf8");
  const sourceNodeModules = join(REPO_ROOT, "node_modules");
  const targetNodeModules = join(paths.installRoot, "node_modules");
  await mkdir(targetNodeModules, { recursive: true });
  const copied = new Set();
  for (const dependencyName of ["@modelcontextprotocol/client", "better-sqlite3", "undici"]) {
    await copyRuntimeDependency(dependencyName, sourceNodeModules, targetNodeModules, copied);
  }
  // The gateway only needs the packaged Electron CLI path to construct its
  // browser manager; the real desktop process stays in the repository runtime.
  await mkdir(join(targetNodeModules, "electron"), { recursive: true });
  await cp(join(sourceNodeModules, "electron", "cli.js"), join(targetNodeModules, "electron", "cli.js"), { force: true });
  const dpapiRelative = cleanProfileDpapiAddonRelativePath();
  const dpapiSource = join(REPO_ROOT, dpapiRelative);
  if (!(await fileExists(dpapiSource))) throw new Error(`clean-profile DPAPI addon unavailable: ${dpapiRelative}`);
  await cp(dpapiSource, join(paths.installRoot, dpapiRelative), { force: true, dereference: true });
  await assertCleanProfilePaths({ tempRoot: paths.tempRoot, installRoot: paths.installRoot, distRoot: join(paths.installRoot, "dist"), nodeModules: targetNodeModules }, paths.tempRoot);
}

async function freePort(port) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      server.close((error) => error ? reject(error) : resolvePort(actual));
    });
  });
}

async function assertProductPortFree(port = 1340) {
  try { await freePort(port); } catch { throw new Error("clean-profile product port is occupied; no external process was adopted or terminated"); }
}

async function assertDevControlPortFree(port = 62150) {
  try { await freePort(port); } catch { throw new Error("clean-profile Electron exposed the unauthenticated dev control port"); }
}

async function processInventory(root) {
  if (process.platform !== "win32") return [];
  const env = { ...process.env, OPENBOT_INVENTORY_ROOT: cleanPath(root) };
  const command = "$root=$env:OPENBOT_INVENTORY_ROOT; @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress";
  try {
    const { stdout } = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    if (!stdout.trim()) return [];
    const value = JSON.parse(stdout);
    return Array.isArray(value) ? value : [value];
  } catch { throw new Error("clean-profile process inventory unavailable"); }
}

async function waitNoRootProcesses(root, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await processInventory(root)).length === 0) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("clean-profile owned process residue");
}

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function fileExists(path) { return fs.access(path).then(() => true, () => false); }

async function waitGatewayHealth(url, pid, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      const body = await response.json();
      if (response.ok && body?.ok === true && Number(body.pid) === pid) return body;
    } catch { /* child is still starting */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("clean-profile gateway did not become ready");
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  const ready = new Promise((resolveReady, rejectReady) => {
    socket.addEventListener("open", resolveReady, { once: true });
    socket.addEventListener("error", rejectReady, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const pendingCall = pending.get(message.id);
    if (!pendingCall) return;
    pending.delete(message.id);
    if (message.error) pendingCall.reject(new Error("CDP command failed")); else pendingCall.resolve(message.result);
  });
  return {
    ready,
    send(method, params = {}) {
      const callId = ++id;
      return new Promise((resolveCall, rejectCall) => {
        pending.set(callId, { resolve: resolveCall, reject: rejectCall });
        socket.send(JSON.stringify({ id: callId, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

export async function waitElectronTarget(cdpPort, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) throw new Error("clean-profile Electron exited before ready");
    try {
      const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(500) })).json();
      const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl && entry.title === "OpenBot");
      if (target) return target;
    } catch { /* Electron is still starting */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("clean-profile Electron did not expose a CDP page");
}

export function isElectronReadyEvidence(value) {
  return value?.readyState === "complete"
    && value.title === "OpenBot"
    && value.hasRoot === true
    && Number(value.rootChildren) > 0;
}

async function waitElectronReady(cdp, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  const expression = `(() => ({
    readyState: document.readyState,
    title: document.title,
    hasRoot: Boolean(document.querySelector('#root')),
    rootChildren: document.querySelector('#root')?.childElementCount ?? 0
  }))()`;
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) throw new Error("clean-profile Electron exited before renderer ready");
    try {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
      const value = result?.result?.value;
      if (isElectronReadyEvidence(value)) return value;
    } catch { /* renderer is still loading */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("clean-profile Electron renderer did not reach OpenBot ready state");
}

export async function waitChildExit(child, timeoutMs = 15_000) {
  if (child.exitCode == null && child.signalCode == null) {
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          const error = new Error("clean-profile child did not exit");
          error.code = "CLEAN_PROFILE_CHILD_TIMEOUT";
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  }
  if (child.signalCode != null) throw new Error("clean-profile child exited by signal");
  if (child.exitCode !== 0) throw new Error(`clean-profile child exited with code ${child.exitCode}`);
  return { exitCode: child.exitCode, signalCode: child.signalCode };
}

async function launchElectron(paths, env, label, productPort = 1340) {
  const electron = process.env.ELECTRON_PATH?.trim() || join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe");
  const electronMain = join(REPO_ROOT, "client", "extracted", "dist", "electron-main", "main.cjs");
  if (!(await fileExists(electron)) || !(await fileExists(electronMain))) throw new Error("clean-profile Electron executable or entrypoint unavailable");
  const cdpPort = await freePort(0);
  const devControlPort = await freePort(0);
  const stdoutPath = join(paths.logs, `electron-${label}.stdout.log`);
  const stderrPath = join(paths.logs, `electron-${label}.stderr.log`);
  const stdout = (await fs.open(stdoutPath, "a")).createWriteStream();
  const stderr = (await fs.open(stderrPath, "a")).createWriteStream();
  let child;
  let processEvidence;
  try {
    child = spawn(electron, [`--user-data-dir=${paths.userData}`, "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${cdpPort}`, electronMain], {
      cwd: REPO_ROOT,
      env: { ...env, OPENBOT_LOCAL_GATEWAY: "1", OPENBOT_VISUAL_TEST: "1", SAND_HOST_GATEWAY_URL: `http://127.0.0.1:${productPort}`, SAND_DEV_CONTROL_PORT: String(devControlPort), ELECTRON_NO_ATTACH_CONSOLE: "1" },
      stdio: ["ignore", stdout, stderr], windowsHide: true,
    });
    processEvidence = await captureProcessEvidence(child.pid, { expectedExecutable: electron, expectedRoot: paths.tempRoot });
    const target = await waitElectronTarget(cdpPort, child);
    const cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");
    const readyEvidence = await waitElectronReady(cdp, child);
    return { child, cdp, cdpPort, devControlPort, stdout, stderr, processEvidence, readyEvidence };
  } catch (error) {
    if (processEvidence) await terminateOwnedProcess(processEvidence, { timeoutMs: 2_000 }).catch(() => undefined);
    await Promise.all([stdout.close(), stderr.close()]);
    throw error;
  }
}

async function closeElectron(session, root) {
  if (!session) return;
  let forced = false;
  let failure = null;
  const bounded = (promise, timeoutMs) => Promise.race([promise, new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs))]);
  try {
    await bounded(session.cdp.send("Browser.close"), 2_000);
  } catch {
    await bounded(session.cdp.send("Runtime.evaluate", { expression: "window.close()" }), 1_000).catch(() => undefined);
  }
  session.cdp.close();
  try {
    await waitChildExit(session.child);
  } catch (error) {
    if (error?.code !== "CLEAN_PROFILE_CHILD_TIMEOUT") failure = error;
    else {
      forced = true;
      if (!session.processEvidence) failure = new Error("clean-profile Electron cleanup ownership was not captured");
      else {
        try { await terminateOwnedProcess(session.processEvidence, { timeoutMs: 2_000 }); } catch (terminateError) { failure = terminateError; }
        try { await waitChildExit(session.child, 5_000); } catch { /* forced teardown is itself RED */ }
      }
    }
  }
  await Promise.all([session.stdout.close(), session.stderr.close()]);
  if (failure) throw failure;
  return { forced, graceful: !forced };
}

async function startOwnedGateway(paths, env, startGateway, productPort = 1340) {
  const gatewayUrl = `http://127.0.0.1:${productPort}`;
  const result = await startGateway({ installRoot: paths.installRoot, url: gatewayUrl, dataRoot: paths.dataRoot, env, adoptExisting: false, waitForReady: true, timeoutMs: 20_000 });
  if (result.adopted === true || !(await fileExists(paths.processStatePath))) throw new Error("clean-profile gateway ownership was not established");
  await waitGatewayHealth(gatewayUrl, result.pid);
  return result;
}

async function stopOwnedGateway(paths, shutdownGateway, productPort = 1340) {
  const result = await shutdownGateway({ installRoot: paths.installRoot, processStatePath: paths.processStatePath, dataRoot: paths.dataRoot, url: `http://127.0.0.1:${productPort}`, timeoutMs: 8_000, forceWaitMs: 2_000, removeState: true });
  if (result.ok !== true || result.teardownProven !== true || result.forced === true || result.gracefulAccepted !== true || result.reason === "stale" || result.reason === "graceful-unavailable") throw new Error("clean-profile gateway did not stop gracefully");
  if (await fileExists(paths.processStatePath)) throw new Error("clean-profile process.json residue");
  await assertProductPortFree(productPort);
  return result;
}

async function collectFiles(root) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path); else files.push(path);
    }
  }
  await visit(root);
  return files;
}

async function assertNoSecretInLogs(paths, secrets) {
  const logRoots = [paths.logs, join(paths.installRoot, "logs")];
  for (const logRoot of logRoots) for (const file of await collectFiles(logRoot)) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const secret of secrets) if (secret && secret.length >= 8 && text.includes(secret)) throw new Error("clean-profile secret found in logs");
  }
}

async function requestRpc(port, method, body, token) {
  const response = await fetch(`http://127.0.0.1:${port}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const value = await response.json();
  if (!response.ok || value?.ok !== true) throw new Error("clean-profile RPC failed");
  return value.value;
}

/** Runs the real isolated gateway + Electron first-boot/restart gate. */
export async function runCleanProfile(options = {}) {
  const productPort = Number(options.productPort ?? 1340);
  if (!Number.isInteger(productPort) || productPort < 1 || productPort > 65535) throw new Error("clean-profile product port is invalid");
  const ownRoot = options.tempRoot == null;
  const tempRoot = options.tempRoot ?? await mkdtemp(join(tmpdir(), "openbot-clean-profile-"));
  const paths = createCleanProfilePaths(tempRoot);
  const environmentObject = process.env;
  const previousEnv = { ...environmentObject };
  const cleanEnv = buildCleanProfileEnvironment(previousEnv, paths);
  const inheritedSecrets = Object.entries(previousEnv).filter(([name, value]) => SENSITIVE_ENV_NAME.test(name) && value && value.length >= 8).map(([, value]) => value);
  const replaceEnvironment = (next) => {
    for (const name of Object.keys(environmentObject)) delete environmentObject[name];
    Object.assign(environmentObject, next);
  };
  let gateway;
  let electron;
  let green = false;
  let stage = "prepare";
  const rendererEvidence = [];
  let lifecycle = options.lifecycle;
  try {
    await ensureRoots(paths);
    replaceEnvironment(cleanEnv);
    if (options.lifecycle) {
      lifecycle = options.lifecycle;
    } else {
      stage = "prepare.copy-install";
      await copyInstall(paths);
      const { startGateway } = await import("./start-gateway.mjs");
      const { shutdownGateway } = await import("./shutdown-gateway.mjs");
      lifecycle = {
        startGateway: (rootPaths, env) => startOwnedGateway(rootPaths, env, startGateway, productPort),
        stopGateway: (rootPaths) => stopOwnedGateway(rootPaths, shutdownGateway, productPort),
        launchElectron: (rootPaths, env, label) => launchElectron(rootPaths, env, label, productPort),
        closeElectron: (session, root) => closeElectron(session, root),
      };
    }
    const tokenPath = join(paths.dataRoot, "gateway.token");
    let firstConfig;
    let firstToken;
    let firstTokenMtime;
    for (const [index, label] of [[0, "first"], [1, "restart"]]) {
      stage = `${label}.port-free`;
      await assertProductPortFree(productPort);
      stage = `${label}.gateway-start`;
      gateway = await lifecycle.startGateway(paths, cleanEnv);
      stage = `${label}.token-read`;
      const token = (await readFile(tokenPath, "utf8")).trim();
      if (token.length < 16) throw new Error("clean-profile gateway token missing");
      const tokenStat = await stat(tokenPath);
      stage = `${label}.token-persist`;
      if (index === 0) { firstToken = token; firstTokenMtime = tokenStat.mtimeMs; }
      else if (token !== firstToken || tokenStat.mtimeMs !== firstTokenMtime) throw new Error("clean-profile token was rewritten across restart");
      stage = `${label}.roster`;
      const roster = await requestRpc(productPort, "listAgents", {}, token);
      if (!Array.isArray(roster) || roster.length !== 0) throw new Error("clean-profile roster is not empty");
      stage = `${label}.electron-launch`;
      electron = await lifecycle.launchElectron(paths, cleanEnv, label);
      stage = `${label}.renderer-ready`;
      if (!isElectronReadyEvidence(electron?.readyEvidence)) throw new Error("clean-profile renderer readiness evidence incomplete");
      stage = `${label}.dev-control-closed`;
      await assertDevControlPortFree(electron.devControlPort);
      rendererEvidence.push(electron.readyEvidence);
      stage = `${label}.electron-close`;
      const electronClose = await lifecycle.closeElectron(electron, paths.tempRoot);
      if (electronClose?.forced !== false || electronClose?.graceful !== true) throw new Error("clean-profile Electron did not close gracefully");
      electron = undefined;
      stage = `${label}.config-persist`;
      const config = await readJson(paths.configPath);
      if (index === 0) firstConfig = config;
      else if (JSON.stringify(config) !== JSON.stringify(firstConfig)) throw new Error("clean-profile configuration did not persist");
      stage = `${label}.gateway-stop`;
      const shutdown = await lifecycle.stopGateway(paths);
      if (shutdown.ok !== true || shutdown.forced === true || shutdown.teardownProven !== true || shutdown.gracefulAccepted !== true || shutdown.reason === "stale" || shutdown.reason === "graceful-unavailable") throw new Error("clean-profile gateway teardown was not graceful");
      gateway = undefined;
      stage = `${label}.process-drain`;
      await waitNoRootProcesses(paths.tempRoot);
    }
    stage = "final.secret-scan";
    await assertNoSecretInLogs(paths, [...inheritedSecrets, firstToken]);
    stage = "final.renderer-evidence";
    const electronReal = rendererEvidence.length === 2;
    if (!electronReal) throw new Error("clean-profile Electron readiness evidence incomplete");
    green = true;
    return { status: "GREEN", tempRoot: paths.tempRoot, cleanup: ownRoot ? "temp-root-removed" : "preserved-by-caller", boots: 2, zeroBots: true, tokenPersisted: true, electronReal, rendererEvidence, processAbsent: true, portsFree: true, processStateAbsent: true };
  } catch {
    try { if (electron) await lifecycle?.closeElectron?.(electron, paths.tempRoot); } catch { /* preserve diagnostic root */ }
    try { if (gateway && lifecycle?.stopGateway) await lifecycle.stopGateway(paths); } catch { /* preserve diagnostic root */ }
    throw new Error(`clean-profile RED; stage=${stage}; diagnosticRoot=${paths.tempRoot}`);
  } finally {
    replaceEnvironment(previousEnv);
    if (green && ownRoot) await rm(paths.tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCleanProfile().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    console.error(error instanceof Error && /^clean-profile RED; stage=[a-z0-9.-]+; diagnosticRoot=/u.test(error.message) ? error.message : "clean-profile RED; diagnosticRoot preserved");
    process.exitCode = 1;
  });
}
