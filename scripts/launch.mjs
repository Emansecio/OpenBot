import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  assertManagedInstallRoot,
  acquireInstallLock,
  assertPreflight,
  atomicWriteJson,
  captureProcessEvidence,
  canonicalizeInstallRoot,
  canonicalizePath,
  defaultDataRoot,
  defaultLocalDataRoot,
  installLayout,
  isMainModule,
  parseArgs,
  queryProcessEvidence,
  randomSuffix,
  readInstallState,
  removeOwnedProcessState,
  rotateLogFile,
  stateReleaseId,
  terminateOwnedProcess,
} from "./release-common.mjs";
import { shutdownGateway } from "./shutdown-gateway.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));

export function createStartupTrace(options = {}) {
  const enabled = options.enabled ?? process.env.OPENBOT_STARTUP_TRACE === "1";
  const now = options.now ?? (() => performance.now());
  const write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
  const startedAt = now();
  return {
    mark(event, fields = {}) {
      if (!enabled) return;
      write(`[openbot][startup] ${JSON.stringify({
        event,
        elapsedMs: Number((now() - startedAt).toFixed(1)),
        ...fields,
      })}`);
    },
  };
}

function packageRootFromScript() {
  return resolve(scriptRoot, "..");
}

function envPath(env, key, fallback) {
  const value = env[key]?.trim();
  return value ? resolve(value) : fallback;
}

function assertLoopbackUrl(url) {
  const parsed = new URL(String(url));
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("OpenBot gateway URL must be loopback");
  }
  return parsed.toString().replace(/\/$/u, "");
}

async function readGatewayHealth(url) {
  const safeUrl = assertLoopbackUrl(url);
  try {
    const response = await fetch(`${safeUrl}/health`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return null;
    const health = await response.json();
    return health?.ok === true && Number.isInteger(health.pid) && health.pid > 0 ? health : null;
  } catch {
    return null;
  }
}

function samePath(left, right) {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

export async function readOwnedGatewayHealth(url, nodeExecutable, gatewayScript) {
  const health = await readGatewayHealth(url);
  if (health == null) return null;
  let evidence;
  try {
    evidence = await queryProcessEvidence(health.pid);
  } catch {
    return null;
  }
  if (evidence?.executablePath == null || evidence.commandLine == null) return null;
  if (!samePath(evidence.executablePath, nodeExecutable)) return null;
  if (!evidence.commandLine.toLowerCase().includes(resolve(gatewayScript).toLowerCase())) return null;
  return health;
}

export async function readLaunchInstallState(releaseRoot, installRoot) {
  const canonicalRelease = resolve(releaseRoot);
  const canonicalInstall = resolve(installRoot);
  if (samePath(canonicalRelease, canonicalInstall)) return null;
  const state = await readInstallState(canonicalInstall);
  if (state == null) throw new Error(`OpenBot install state is missing: ${installLayout(canonicalInstall).state}`);
  assertManagedInstallRoot(canonicalInstall, state);
  let activeReleaseId;
  try {
    activeReleaseId = stateReleaseId(state);
  } catch {
    throw new Error(`OpenBot install has an invalid active release identity: ${canonicalInstall}`);
  }
  const activeRelease = resolve(installLayout(canonicalInstall).versions, activeReleaseId);
  if (!samePath(activeRelease, canonicalRelease)) {
    throw new Error(`Release ${canonicalRelease} is not the active installed version`);
  }
  return state;
}

export async function waitForGateway(url, expectedPid, child, timeoutMs = 45_000) {
  const safeUrl = assertLoopbackUrl(url);
  if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) < 0) throw new Error("OpenBot gateway timeout must be a finite non-negative number");
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${safeUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      const health = await response.json();
      if (response.ok && health?.ok === true && health.pid === expectedPid) return health;
      lastError = new Error(`gateway health belongs to PID ${health?.pid ?? "unknown"}, expected ${expectedPid}`);
    } catch (error) {
      lastError = error;
    }
    if (child?.spawnError) throw new Error(`Local gateway failed to start: ${child.spawnError.message}`);
    if (child?.exitCode != null) {
      throw new Error(`Local gateway exited with code ${child.exitCode}; see gateway-error.log`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Local gateway did not become ready: ${lastError?.message ?? "timeout"}; see gateway-error.log`);
}

function setDataEnvironment(env, dataRoot, localDataRoot) {
  return {
    ...env,
    OPENBOT_DATA_ROOT: dataRoot,
    OPENBOT_LOCAL_DATA_ROOT: localDataRoot,
  };
}

export async function captureGatewayEvidenceWithRetry(pid, options = {}) {
  const capture = options.captureProcessEvidence ?? captureProcessEvidence;
  const attempts = Number(options.attempts ?? 4);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await capture(pid, { expectedExecutable: options.expectedExecutable, expectedRoot: options.expectedRoot });
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw lastError ?? new Error("Gateway ownership evidence was not captured");
}

export async function stopSpawnedGatewayHandle(child, timeoutMs = 2_000) {
  if (child == null || child.exitCode != null || child.signalCode != null) return true;
  try { child.kill(); } catch { /* the child may have exited between checks */ }
  if (child.exitCode != null || child.signalCode != null) return true;
  return new Promise((resolveStopped) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolveStopped(value); } };
    child.once?.("exit", () => finish(true));
    setTimeout(() => finish(child.exitCode != null || child.signalCode != null), timeoutMs);
  });
}

export async function teardownLaunchGateway(options = {}) {
  if (options.processState == null && options.gatewayChild != null) {
    const stopped = await stopSpawnedGatewayHandle(options.gatewayChild, options.childTimeoutMs);
    if (!stopped) throw new Error("OpenBot gateway child teardown was not proven");
    return { ok: true, owned: true, teardownProven: true, forced: false, childHandle: true };
  }
  const shutdown = await (options.shutdownGateway ?? shutdownGateway)({
    installRoot: options.installRoot,
    processState: options.processState,
    processStatePath: options.processStatePath,
    url: options.url,
    env: options.env,
    queryProcessEvidence: options.queryProcessEvidence,
    queryGatewayPid: options.queryGatewayPid,
    isPortPresent: options.isPortPresent,
    requestShutdown: options.requestShutdown,
    forceKill: options.forceKill,
    timeoutMs: options.timeoutMs,
    removeState: false,
  });
  if (!shutdown.teardownProven) throw new Error("OpenBot gateway teardown was not proven");
  if (options.removeProcessState === true && options.processStatePath != null) {
    await removeOwnedProcessState(options.processStatePath, options.instanceId, {
      allowMissingIdentity: options.instanceId == null,
    });
  }
  return shutdown;
}

export async function launchRelease(options = {}) {
  const environment = options.env ?? process.env;
  const trace = options.startupTrace ?? createStartupTrace({
    enabled: options.startupTraceEnabled ?? environment.OPENBOT_STARTUP_TRACE === "1",
    now: options.startupTraceNow,
    write: options.startupTraceWrite,
  });
  trace.mark("launcher-start");
  const root = await canonicalizePath(options.root ?? packageRootFromScript(), { allowMissing: false, directory: true });
  const { manifest } = await assertPreflight(root, { arch: options.arch ?? process.arch });
  trace.mark("preflight-complete");
  const appRoot = join(root, "app");
  const nodeExecutable = join(root, "runtime", "node.exe");
  const electronExecutable = join(root, "runtime", "electron", "electron.exe");
  const gatewayScript = join(appRoot, "dist", "main.js");
  const electronMain = join(appRoot, "scripts", "openbot-electron.cjs");
  const installRoot = await canonicalizeInstallRoot(options.installRoot ?? process.env.OPENBOT_INSTALL_ROOT ?? root);
  const layout = installLayout(installRoot);
  const installState = await readLaunchInstallState(root, layout.root);
  const dataRoot = envPath(environment, "OPENBOT_DATA_ROOT", installState?.dataRoot ?? defaultDataRoot(environment));
  const localDataRoot = envPath(environment, "OPENBOT_LOCAL_DATA_ROOT", installState?.localDataRoot ?? defaultLocalDataRoot(environment));
  const userData = envPath(environment, "OPENBOT_USER_DATA", join(localDataRoot, "electron"));
  const logsRoot = join(layout.root, "logs");
  await fs.mkdir(logsRoot, { recursive: true });
  const releaseLog = join(logsRoot, "release.log");
  await rotateLogFile(releaseLog, { maxBytes: 2 * 1024 * 1024, backups: 2 });
  await fs.appendFile(releaseLog, `${JSON.stringify({
    event: "release-launch",
    productVersion: manifest.productVersion,
    buildId: manifest.buildId,
    releaseId: manifest.releaseId,
    contentSha256: manifest.contentSha256,
    generatedAt: manifest.generatedAt,
    launchedAt: new Date().toISOString(),
  })}\n`, "utf8");
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.mkdir(localDataRoot, { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  trace.mark("directories-ready");

  const childEnv = setDataEnvironment(environment, dataRoot, localDataRoot);
  childEnv.OPENBOT_LOCAL_GATEWAY = "1";
  childEnv.SAND_HOST_GATEWAY_URL = "http://127.0.0.1:1340";
  childEnv.OPENBOT_BROWSER_ELECTRON_PATH = electronExecutable;
  childEnv.SAND_DEV_APP_ICON = join(root, "assets", "openbot.ico");
  childEnv.OPENBOT_INSTALL_ROOT = layout.root;
  childEnv.OPENBOT_RELEASE_ROOT = root;
  childEnv.OPENBOT_USER_DATA = userData;
  childEnv.OPENBOT_LOG_DIR = logsRoot;
  childEnv.OPENBOT_PRODUCT_VERSION = manifest.productVersion;
  childEnv.OPENBOT_BUILD_ID = manifest.buildId;
  childEnv.OPENBOT_RELEASE_ID = manifest.releaseId;
  childEnv.OPENBOT_CONTENT_SHA256 = manifest.contentSha256;
  trace.mark("release-identity", { productVersion: manifest.productVersion, buildId: manifest.buildId, releaseId: manifest.releaseId });

  const instanceId = randomSuffix();
  let gateway = null;
  let gatewayPid = null;
  let ownsGateway = false;
  let ownsProcessState = false;
  let gatewayOwnership = null;
  let electron = null;
  let electronExitCode = null;
  const spawnGateway = options.spawnGateway ?? spawn;
  const spawnElectron = options.spawnElectron ?? spawn;
  const waitForGatewayReady = options.waitForGateway ?? waitForGateway;
  const captureEvidence = options.captureProcessEvidence ?? captureProcessEvidence;
  const terminateOwned = options.terminateOwnedProcess ?? terminateOwnedProcess;
  try {
    const startupLock = await acquireInstallLock(layout.root, {
      timeoutMs: options.startLockTimeoutMs,
      operation: "launch-startup",
    });
    trace.mark("startup-lock-acquired");
    try {
      const existingHealth = await readOwnedGatewayHealth(childEnv.SAND_HOST_GATEWAY_URL, nodeExecutable, gatewayScript);
      if (existingHealth) {
        gatewayPid = existingHealth.pid;
        trace.mark("gateway-ready", { adopted: true });
      } else {
        gateway = spawnGateway(nodeExecutable, [gatewayScript], {
          cwd: appRoot,
          env: childEnv,
          windowsHide: true,
          stdio: "ignore",
        });
        gateway.spawnError = null;
        gateway.once("error", (error) => { gateway.spawnError = error; });
        gatewayPid = gateway.pid;
        ownsGateway = true;
        trace.mark("gateway-spawned");
        const [gatewayEvidence, launcherEvidence] = await Promise.all([
          captureGatewayEvidenceWithRetry(gatewayPid, {
            expectedExecutable: nodeExecutable,
            expectedRoot: root,
            captureProcessEvidence: captureEvidence,
          }),
          captureEvidence(process.pid, {
            expectedExecutable: nodeExecutable,
            expectedRoot: root,
          }),
        ]);
        gatewayOwnership = {
          instanceId,
          product: "OpenBot",
          version: manifest.version,
          productVersion: manifest.productVersion,
          buildId: manifest.buildId,
          releaseId: manifest.releaseId,
          contentSha256: manifest.contentSha256,
          dataRoot,
          localDataRoot,
          gateway: { url: childEnv.SAND_HOST_GATEWAY_URL, dataRoot },
          launcherPid: process.pid,
          gatewayPid,
          electronPid: null,
          processes: { gateway: gatewayEvidence, launcher: launcherEvidence },
          startedAt: new Date().toISOString(),
        };
        await atomicWriteJson(layout.processState, gatewayOwnership);
        ownsProcessState = true;
        // Ownership is now in memory and on disk before readiness is awaited;
        // a readiness failure can therefore still execute authenticated teardown.
        await waitForGatewayReady(childEnv.SAND_HOST_GATEWAY_URL, gatewayPid, gateway, options.gatewayReadyTimeoutMs);
        trace.mark("gateway-ready", { adopted: false });
      }
    } catch (error) {
      if (ownsGateway && gateway != null) {
        let stopped = false;
        let teardownError = null;
        try {
          stopped = await stopSpawnedGatewayHandle(gateway, options.childTimeoutMs);
        } catch (stopError) {
          teardownError = stopError;
        }
        if (stopped) {
          if (ownsProcessState) {
            await removeOwnedProcessState(layout.processState, instanceId);
            ownsProcessState = false;
          }
          gateway = null;
          gatewayPid = null;
          ownsGateway = false;
        } else {
          teardownError ??= new Error("OpenBot gateway child teardown was not proven; ownership marker was preserved");
        }
        if (teardownError != null) {
          throw new AggregateError([error, teardownError], "OpenBot startup failed and gateway teardown was not proven", { cause: error });
        }
      }
      throw error;
    } finally {
      await startupLock.release();
      trace.mark("startup-lock-released");
    }

    electron = spawnElectron(electronExecutable, [
      `--user-data-dir=${userData}`,
      electronMain,
      ...(options.args ?? []),
    ], {
      cwd: appRoot,
      env: childEnv,
      windowsHide: true,
      stdio: "inherit",
    });
    trace.mark("electron-spawned");
    if (ownsGateway) {
      const [launcherEvidence, gatewayEvidence, electronEvidence] = await Promise.all([
        captureEvidence(process.pid, {
          expectedExecutable: nodeExecutable,
          expectedRoot: root,
        }),
        captureEvidence(gatewayPid, {
          expectedExecutable: nodeExecutable,
          expectedRoot: root,
        }),
        captureEvidence(electron.pid, {
          expectedExecutable: electronExecutable,
          expectedRoot: root,
        }),
      ]);
      gatewayOwnership.electronPid = electron.pid;
      gatewayOwnership.processes = { launcher: launcherEvidence, gateway: gatewayEvidence, electron: electronEvidence };
      await atomicWriteJson(layout.processState, gatewayOwnership);
      trace.mark("process-state-recorded");
    }
    electronExitCode = await new Promise((resolvePromise, reject) => {
      electron.once("error", reject);
      electron.once("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
    });
    trace.mark("electron-exited", { exitCode: electronExitCode });
    if (electronExitCode === 23) return { ok: true, exitCode: 0, secondary: true, version: manifest.version };
    return { ok: electronExitCode === 0, exitCode: electronExitCode, version: manifest.version };
  } finally {
    const cleanupErrors = [];
    try {
      if (electron && electron.exitCode == null && electron.signalCode == null) {
        const electronEvidence = gatewayOwnership?.processes?.electron;
        if (electronEvidence != null) {
          const result = await terminateOwned({
            pid: electronEvidence.pid,
            creationTime: electronEvidence.creationTime,
            expectedExecutable: electronExecutable,
            expectedRoot: root,
          }, {
            timeoutMs: options.electronTeardownTimeoutMs,
            queryProcessEvidence: options.queryProcessEvidence,
            isProcessRunning: options.isProcessRunning,
            runTaskkill: options.runTaskkill,
            taskkillPath: options.taskkillPath,
            platform: options.platform ?? process.platform,
          });
          if (!result?.teardownProven) throw new Error("OpenBot Electron teardown was not proven");
        } else if (!await stopSpawnedGatewayHandle(electron, options.electronTeardownTimeoutMs)) {
          throw new Error("OpenBot Electron child teardown was not proven");
        }
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (ownsGateway && gatewayPid != null) {
        await teardownLaunchGateway({
          installRoot: layout.root,
          processState: gatewayOwnership,
          gatewayChild: gateway,
          processStatePath: layout.processState,
          url: childEnv.SAND_HOST_GATEWAY_URL,
          env: childEnv,
          shutdownGateway: options.shutdownGateway,
          removeProcessState: ownsProcessState,
          instanceId,
        });
      } else if (ownsProcessState) {
        await removeOwnedProcessState(layout.processState, instanceId);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    trace.mark("cleanup-complete", { ok: cleanupErrors.length === 0 });
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "OpenBot launch cleanup was not fully proven");
    }
  }
}

export async function launchPreflight(root = packageRootFromScript(), options = {}) {
  return assertPreflight(await canonicalizePath(root, { allowMissing: false, directory: true }), options);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const root = args.root ? resolve(String(args.root)) : packageRootFromScript();
  if (args.preflight === true) {
    const result = await launchPreflight(root, { arch: args.arch ?? process.arch });
    process.stdout.write(`${JSON.stringify({ ok: true, manifest: result.manifest }, null, 2)}\n`);
    return result;
  }
  const result = await launchRelease({
    root,
    installRoot: args["install-root"],
    env: process.env,
    args: args._args,
  });
  process.exitCode = result.exitCode;
  return result;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`[launch] ${error.message}`);
    process.exitCode = 1;
  });
}
