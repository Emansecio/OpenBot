// The OpenBot desktop launcher for this checkout (the only launch path).
//
//   openbot-desktop.vbs (hidden, error dialog)
//     -> openbot-desktop.cmd (picks runtime\node)
//       -> node scripts/launch.mjs
//
// Flow: verify the backend build, ensure one gateway for this checkout on
// 127.0.0.1:1340 (verifying the client and the taskbar registration while it
// boots), run Electron, then stop the gateway only if this launcher owns it.
import { spawn as spawnProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureProcessEvidence,
  defaultDataRoot,
  defaultLocalDataRoot,
  isMainModule,
  isProcessRunning,
  processOwnershipMatches,
  queryProcessEvidence,
  rotateLogFile,
  systemToolPath,
} from "./common.mjs";
import {
  DEFAULT_GATEWAY_URL,
  buildStamp,
  checkoutRootId,
  gatewayEntryScript,
  gatewayTokenPath,
  newInstanceId,
  portInUse,
  processStatePath,
  readHealth,
  readProcessState,
  removeProcessStateIfOwner,
  stopGateway,
  waitForGateway,
  watchChild,
  writeProcessState,
} from "./gateway-control.mjs";
import { resolveElectronExecutable } from "./electron-executable.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Exit codes understood by openbot-desktop.vbs (5 is reserved for "Node not found" in the cmd). */
export const EXIT = Object.freeze({ OK: 0, FAILURE: 1, BUILD: 2, ELECTRON: 3, GATEWAY: 4, TEARDOWN: 6 });
export const SECOND_INSTANCE_EXIT = 23;
const GATEWAY_READY_TIMEOUT_MS = 45_000;
const LOCK_OPTIONS = { timeoutMs: 60_000, staleMs: 120_000, label: "gateway launcher" };
const ELECTRON_LOG_MAX_BYTES = 2 * 1024 * 1024;

export class LaunchError extends Error {
  constructor(message, exitCode, options) {
    super(message, options);
    this.exitCode = exitCode;
  }
}

export function createStartupTrace(options = {}) {
  const enabled = options.enabled ?? process.env.OPENBOT_STARTUP_TRACE === "1";
  const now = options.now ?? (() => performance.now());
  const write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
  const startedAt = now();
  return {
    mark(event, fields = {}) {
      if (!enabled) return;
      write(`[openbot][startup] ${JSON.stringify({ event, elapsedMs: Number((now() - startedAt).toFixed(1)), ...fields })}`);
    },
  };
}

// Inherited variables that would point the desktop at a remote/dev gateway or
// turn electron.exe into plain Node. Matched case-insensitively (Windows).
const CLEARED_VARIABLES = new Set([
  "SAND_DEV_CAPABILITY", "SAND_DEV_CONTROL_PORT", "SAND_HOST_GATEWAY_URL", "SAND_HOST_GATEWAY_TOKEN",
  "VITE_DEV_SERVER_URL", "ELECTRON_RUN_AS_NODE", "OPENBOT_RELEASE_ROOT", "OPENBOT_INSTALL_ROOT",
]);

/** Environment shared by the gateway and Electron. */
export function baseEnvironment(env, root) {
  const next = {};
  for (const [name, value] of Object.entries(env)) {
    if (value != null && !CLEARED_VARIABLES.has(name.toUpperCase())) next[name] = value;
  }
  next.OPENBOT_LOCAL_GATEWAY = "1";
  next.OPENBOT_ROOT = root;
  return next;
}

export function gatewayEnvironment(env, root, logsRoot) {
  return { ...baseEnvironment(env, root), OPENBOT_LOG_DIR: logsRoot };
}

/** Electron talks only to the proven local gateway at url. */
export function electronEnvironment(env, { root, url, userData }) {
  return {
    ...baseEnvironment(env, root),
    SAND_HOST_GATEWAY_URL: url,
    SAND_DEV_BOX_CONTROL_PLANE: "0",
    SAND_DEV_APP_ICON: join(root, "assets", "openbot.ico"),
    OPENBOT_USER_DATA: userData,
  };
}

export function parseCdpPort(value) {
  if (value == null || String(value).trim() === "") return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LaunchError("OPENBOT_AUDIT_CDP_PORT deve ser uma porta válida entre 1 e 65535.", EXIT.FAILURE);
  }
  return port;
}

export function electronArguments({ root, userData, logsRoot, cdpPort = null, extra = [] }) {
  return [
    `--user-data-dir=${userData}`,
    // GPU acceleration paints an all-black window with some Windows drivers.
    "--disable-gpu",
    "--enable-logging",
    `--log-file=${join(logsRoot, "electron-chromium.log")}`,
    ...(cdpPort == null ? [] : [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${cdpPort}`,
      `--remote-allow-origins=http://127.0.0.1:${cdpPort}`,
    ]),
    join(root, "scripts", "openbot-electron.cjs"),
    ...extra,
  ];
}

function defaultDeps() {
  return {
    spawn: spawnProcess,
    readHealth,
    portInUse,
    isProcessRunning,
    queryProcessEvidence,
    captureProcessEvidence,
    stopGateway,
    withLock: async (target, task, options) => {
      const { withFileLock } = await import(pathToFileURL(join(defaultRoot, "dist", "shared", "file-lock.js")).href);
      return withFileLock(target, task, options);
    },
  };
}

function formatErrors(errors) {
  return errors.slice(0, 10).map((error) => `  - ${error}`).join("\n") + (errors.length > 10 ? `\n  ... +${errors.length - 10}` : "");
}

async function recordedGatewayIsOurs(state, deps) {
  const evidence = state.gateway?.evidence;
  if (evidence == null) return false;
  const current = await deps.queryProcessEvidence(state.gateway.pid).catch(() => null);
  return current != null && processOwnershipMatches(evidence, current);
}

/**
 * Make sure one gateway of this checkout answers on url. Runs `alongside`
 * while a freshly spawned gateway boots. Returns who owns the gateway: the
 * launcher stops it at the end only when `owned` is true.
 */
export async function ensureGateway(options) {
  const { root, url, env, tokenPath, logsRoot } = options;
  const trace = options.trace ?? createStartupTrace({ enabled: false });
  const deps = { ...defaultDeps(), ...options.deps };
  const alongside = options.alongside ?? (async () => undefined);
  const statePath = processStatePath(root);
  const rootId = checkoutRootId(root);
  const build = buildStamp(root);
  const port = new URL(url).port;
  const logHint = join(logsRoot, "gateway-error.log");

  return deps.withLock(statePath, async () => {
    const [health, rawState] = await Promise.all([deps.readHealth(url), readProcessState(statePath)]);
    const state = rawState?.rootId === rootId ? rawState : null;
    const launcherAlive = state != null && state.launcherPid !== process.pid && await deps.isProcessRunning(state.launcherPid);

    if (health != null) {
      if (health.rootId !== rootId) {
        throw new LaunchError(`A porta ${port} já está em uso pelo PID ${health.pid}, que não é o gateway deste checkout. Feche-o e tente novamente.`, EXIT.GATEWAY);
      }
      const recorded = state?.gateway.pid === health.pid;
      const stale = health.build !== build;
      if (!stale || launcherAlive || !recorded) {
        if (stale) trace.mark("gateway-stale-build-kept", { reason: launcherAlive ? "in-use" : "unrecorded" });
        await alongside();
        if (recorded && !launcherAlive) {
          // The launcher that started this gateway is gone: take it over so it
          // is stopped when this window closes instead of lingering.
          const instanceId = newInstanceId();
          await writeProcessState(statePath, { ...state, instanceId, launcherPid: process.pid });
          trace.mark("gateway-ready", { adopted: true, owned: true });
          return { pid: health.pid, owned: true, adopted: true, instanceId, evidence: state.gateway.evidence ?? null, watch: null };
        }
        trace.mark("gateway-ready", { adopted: true, owned: false });
        return { pid: health.pid, owned: false, adopted: true };
      }
      // An orphan from an older build: replace it with the current one.
      trace.mark("gateway-restart-stale-build");
      const stopped = await deps.stopGateway({ url, pid: health.pid, rootId, tokenPath, evidence: state.gateway.evidence ?? null });
      if (!stopped.stopped) throw new LaunchError(`O gateway anterior (PID ${health.pid}) não encerrou.`, EXIT.GATEWAY);
      await removeProcessStateIfOwner(statePath, state.instanceId);
    } else if (state != null && await deps.isProcessRunning(state.gateway.pid) && await recordedGatewayIsOurs(state, deps)) {
      // Our supervisor is alive but not answering: booting or restarting its worker.
      trace.mark("gateway-wait-recorded", { pid: state.gateway.pid });
      const waiting = new AbortController();
      try {
        await Promise.all([
          waitForGateway(url, state.gateway.pid, {
            rootId, logHint, timeoutMs: options.readyTimeoutMs ?? GATEWAY_READY_TIMEOUT_MS, signal: waiting.signal,
            isAlive: () => deps.isProcessRunning(state.gateway.pid),
          }),
          alongside().catch((error) => { waiting.abort(); throw error; }),
        ]);
        const owned = !launcherAlive;
        const instanceId = owned ? newInstanceId() : undefined;
        if (owned) await writeProcessState(statePath, { ...state, instanceId, launcherPid: process.pid });
        trace.mark("gateway-ready", { adopted: true, owned });
        return { pid: state.gateway.pid, owned, adopted: true, instanceId, evidence: state.gateway.evidence, watch: null };
      } catch (error) {
        if (error instanceof LaunchError) throw error;
        if (await deps.isProcessRunning(state.gateway.pid)) throw new LaunchError(error.message, EXIT.GATEWAY, { cause: error });
        // It died while we waited; start a fresh one below.
        await removeProcessStateIfOwner(statePath, state.instanceId);
      }
    } else if (rawState != null && (state == null || !launcherAlive)) {
      // A record for a gateway that no longer exists (or another checkout's leftover).
      await removeProcessStateIfOwner(statePath, rawState.instanceId);
    }

    if (await deps.portInUse(url)) {
      throw new LaunchError(`A porta ${port} está ocupada por um processo que não responde como gateway do OpenBot.`, EXIT.GATEWAY);
    }

    const child = deps.spawn(process.execPath, [gatewayEntryScript(root)], {
      cwd: root,
      env: gatewayEnvironment(env, root, logsRoot),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    const watch = watchChild(child);
    if (!Number.isInteger(child.pid) || child.pid <= 0) {
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      throw new LaunchError(`O gateway local não iniciou: ${watch.error?.message ?? "sem PID"}`, EXIT.GATEWAY, { cause: watch.error });
    }
    trace.mark("gateway-spawned", { pid: child.pid });
    const instanceId = newInstanceId();
    const handle = { pid: child.pid, owned: true, adopted: false, instanceId, evidence: null, watch };
    const waiting = new AbortController();
    try {
      // Record ownership before waiting, so a crash here still leaves a trail.
      await writeProcessState(statePath, {
        instanceId, product: "OpenBot", rootId, url, tokenPath,
        launcherPid: process.pid, gateway: { pid: child.pid }, startedAt: new Date().toISOString(),
      });
      await Promise.all([
        waitForGateway(url, child.pid, { watch, rootId, logHint, timeoutMs: options.readyTimeoutMs ?? GATEWAY_READY_TIMEOUT_MS, signal: waiting.signal })
          .catch((error) => { throw new LaunchError(error.message, EXIT.GATEWAY, { cause: error }); }),
        alongside().catch((error) => { waiting.abort(); throw error; }),
      ]);
    } catch (error) {
      waiting.abort();
      await deps.stopGateway({ url, pid: child.pid, watch, rootId, tokenPath }).catch(() => undefined);
      await removeProcessStateIfOwner(statePath, instanceId).catch(() => undefined);
      throw error;
    }
    child.unref();
    trace.mark("gateway-ready", { adopted: false, owned: true });
    return handle;
  }, LOCK_OPTIONS);
}

/** Record process evidence for a gateway this launcher owns (used for a later forced stop). */
async function recordGatewayEvidence(root, handle, deps) {
  if (!handle.owned || handle.evidence != null) return;
  try {
    const evidence = await deps.captureProcessEvidence(handle.pid, { expectedExecutable: process.execPath, expectedRoot: root });
    handle.evidence = evidence;
    const statePath = processStatePath(root);
    const state = await readProcessState(statePath);
    if (state?.instanceId === handle.instanceId) {
      await writeProcessState(statePath, { ...state, gateway: { pid: handle.pid, evidence } });
    }
  } catch {
    // Without evidence, a later launcher can still adopt via /health; only the
    // forced stop by a different launcher becomes unavailable.
  }
}

async function releaseGateway(root, handle, options, deps) {
  if (!handle?.owned) return null;
  const statePath = processStatePath(root);
  const result = await deps.stopGateway({
    url: options.url, pid: handle.pid, watch: handle.watch, rootId: checkoutRootId(root),
    tokenPath: options.tokenPath, evidence: handle.evidence,
  });
  if (!result.stopped) throw new Error(`OpenBot gateway PID ${handle.pid} did not stop (${result.reason})`);
  await deps.withLock(statePath, () => removeProcessStateIfOwner(statePath, handle.instanceId), LOCK_OPTIONS);
  return result;
}

async function forceStopElectron(watch) {
  if (watch == null || watch.exited) return;
  const pid = watch.child.pid;
  if (process.platform === "win32" && Number.isInteger(pid)) {
    // The live child handle proves the PID; /T takes the renderer processes too.
    await new Promise((resolveKill) => {
      spawnProcess(systemToolPath("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        .once("exit", resolveKill).once("error", resolveKill);
    });
  } else {
    watch.child.kill("SIGKILL");
  }
  await Promise.race([watch.done, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
}

function openElectronLog(logsRoot) {
  const path = join(logsRoot, "electron.log");
  const fd = openSync(path, "a");
  writeSync(fd, `[${new Date().toISOString()}] OpenBot Electron launcher started (pid ${process.pid})\n`);
  return fd;
}

/** Run the desktop app. Resolves with the process exit code. */
export async function launch(options = {}) {
  const root = resolve(options.root ?? defaultRoot);
  const env = options.env ?? process.env;
  const url = options.url ?? DEFAULT_GATEWAY_URL;
  const trace = options.trace ?? createStartupTrace({ enabled: env.OPENBOT_STARTUP_TRACE === "1" });
  const deps = { ...defaultDeps(), ...options.deps };
  const logsRoot = join(root, "logs");
  trace.mark("launcher-start");

  const cdpPort = parseCdpPort(env.OPENBOT_AUDIT_CDP_PORT);
  let electronPath;
  try {
    electronPath = (options.resolveElectron ?? resolveElectronExecutable)(root);
  } catch (error) {
    throw new LaunchError(error.message, EXIT.ELECTRON, { cause: error });
  }

  // Never start a gateway from a stale or partial backend build.
  const verifyBackend = options.verifyBackend
    ?? (async () => (await import("./verify-backend-artifacts.mjs")).verifyBackendArtifacts({ sourceRoot: root }));
  const backend = await verifyBackend();
  if (!backend.ok) throw new LaunchError(`Build do backend ausente ou desatualizado. Rode npm run build.\n${formatErrors(backend.errors)}`, EXIT.BUILD);
  trace.mark("backend-verified");

  mkdirSync(logsRoot, { recursive: true });
  const dataRoot = defaultDataRoot(env);
  const tokenPath = gatewayTokenPath(dataRoot, env);
  const userData = resolve(env.OPENBOT_USER_DATA?.trim() || join(defaultLocalDataRoot(env), "electron"));
  mkdirSync(userData, { recursive: true });

  const verifyClient = options.verifyClient
    ?? (async () => (await import("./verify-client-artifacts.mjs")).verifyClientArtifacts({ root }));
  const ensureTaskbar = options.ensureTaskbar
    ?? (async () => (await import("./setup-desktop-shortcut.mjs")).ensureTaskbarShortcutCached({ root, electronPath }));
  const alongside = async () => {
    const client = await verifyClient();
    if (!client.ok) throw new LaunchError(`Artefatos do cliente Electron inválidos (veja client/client-artifacts.manifest.json).\n${formatErrors(client.errors)}`, EXIT.BUILD);
    trace.mark("client-verified");
    if (process.platform === "win32") {
      // Explorer takes the taskbar name/icon from the Start-menu registration.
      try {
        await ensureTaskbar();
      } catch (error) {
        throw new LaunchError(`Não foi possível confirmar a identidade OpenBot na barra de tarefas: ${error.message}`, EXIT.FAILURE, { cause: error });
      }
      trace.mark("taskbar-ready");
    }
  };

  const gateway = await ensureGateway({ root, url, env, tokenPath, logsRoot, trace, deps, alongside, readyTimeoutMs: options.readyTimeoutMs });
  let electron = null;
  let exitCode = EXIT.FAILURE;
  let failure = null;
  try {
    const evidence = recordGatewayEvidence(root, gateway, deps);
    // Chromium appends to its --log-file as well; both are bounded here.
    await Promise.all(["electron.log", "electron-chromium.log"].map((name) =>
      rotateLogFile(join(logsRoot, name), { maxBytes: ELECTRON_LOG_MAX_BYTES, backups: 2 }).catch(() => undefined)));
    const logFd = openElectronLog(logsRoot);
    try {
      const child = deps.spawn(electronPath, electronArguments({ root, userData, logsRoot, cdpPort, extra: options.args ?? [] }), {
        cwd: root,
        env: electronEnvironment(env, { root, url, userData }),
        stdio: ["ignore", logFd, logFd],
      });
      electron = watchChild(child);
    } finally {
      closeSync(logFd);
    }
    trace.mark("electron-spawned", { pid: electron.child.pid });
    await Promise.all([electron.done, evidence]);
    if (electron.error != null) throw new LaunchError(`Electron não iniciou: ${electron.error.message}`, EXIT.ELECTRON, { cause: electron.error });
    trace.mark("electron-exited", { exitCode: electron.code });
    // 23: another window of this profile is already open and was focused.
    exitCode = electron.code === SECOND_INSTANCE_EXIT ? EXIT.OK : electron.code;
    if (electron.code === SECOND_INSTANCE_EXIT && gateway.owned) {
      // The open window is using this gateway; leave it running. The next
      // launcher takes it over (its recorded launcher is gone by then).
      trace.mark("gateway-left-for-primary");
      return exitCode;
    }
  } catch (error) {
    failure = error;
    await forceStopElectron(electron);
  }
  try {
    await releaseGateway(root, gateway, { url, tokenPath }, deps);
    trace.mark("cleanup-complete", { ok: true });
  } catch (error) {
    trace.mark("cleanup-complete", { ok: false });
    if (failure != null) throw new AggregateError([failure, error], failure.message);
    throw new LaunchError(`O OpenBot fechou, mas o gateway local não encerrou: ${error.message}`, EXIT.TEARDOWN, { cause: error });
  }
  if (failure != null) throw failure;
  return exitCode;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    process.exitCode = await launch({ args: argv });
  } catch (error) {
    const primary = error instanceof AggregateError ? error.errors[0] : error;
    console.error(`[launch] ${error.message}`);
    if (error instanceof AggregateError) for (const inner of error.errors.slice(1)) console.error(`[launch] ${inner.message}`);
    process.exitCode = primary?.exitCode ?? EXIT.FAILURE;
  }
}

if (isMainModule(import.meta.url)) await main();
