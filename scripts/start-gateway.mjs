import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { assertLoopbackUrl, recordGatewayOwnership } from "./shutdown-gateway.mjs";
import {
  acquireInstallLock,
  installLayout,
  parseArgs,
  queryProcessEvidence,
  randomSuffix,
  removeOwnedProcessState,
} from "./release-common.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export async function stopGatewayChild(child, timeoutMs = 2_000) {
  if (child == null || child.exitCode != null || child.signalCode != null) return true;
  try { child.kill(); } catch { /* the exact child may have exited */ }
  if (child.exitCode != null || child.signalCode != null) return true;
  return new Promise((resolveStopped) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolveStopped(value); } };
    child.once?.("exit", () => finish(true));
    setTimeout(() => finish(child.exitCode != null || child.signalCode != null), timeoutMs);
  });
}

export async function startGateway(options = {}) {
  const installRoot = options.installRoot ?? root;
  const url = assertLoopbackUrl(options.url ?? process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340");
  const lock = options.lock ?? await acquireInstallLock(installRoot, {
    timeoutMs: options.lockTimeoutMs,
    operation: "start-gateway",
    captureProcessEvidence: options.captureProcessEvidence,
    queryProcessEvidence: options.queryProcessEvidence,
  });
  const ownsLock = options.lock == null;
  const instanceId = options.instanceId ?? randomSuffix();
  let gateway = null;
  try {
    const logs = join(installRoot, "logs");
    await mkdir(logs, { recursive: true });
    if (options.adoptExisting === true) {
      const health = await (options.readGatewayHealth ?? readGatewayHealth)(url);
      if (health != null && await gatewayMatches(health.pid, installRoot, options)) {
        return { pid: health.pid, gateway: null, adopted: true };
      }
    }
    const childEnv = { ...(options.env ?? process.env), OPENBOT_LOG_DIR: logs };
    gateway = (options.spawn ?? spawn)(process.execPath, [join(installRoot, "dist", "main.js")], {
      cwd: installRoot,
      env: childEnv,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    // Inspect identity after readiness, so the ownership capture also proves
    // the executable/script behind the healthy PID before publishing it.
    if (options.waitForReady === true) await waitForGateway(url, gateway.pid, gateway, options.timeoutMs);
    await (options.recordGatewayOwnership ?? recordGatewayOwnership)({
      installRoot,
      processStatePath: options.processStatePath,
      pid: gateway.pid,
      instanceId,
      expectedExecutable: process.execPath,
      dataRoot: options.dataRoot ?? process.env.OPENBOT_DATA_ROOT,
      url,
      env: options.env ?? process.env,
      captureProcessEvidence: options.captureProcessEvidence ?? (async (pid, { expectedRoot }) => {
        const evidence = await (options.queryProcessEvidence ?? queryProcessEvidence)(pid);
        if (!gatewayEvidenceMatches(evidence, pid, installRoot)) {
          throw new Error("OpenBot gateway executable/script identity could not be verified");
        }
        return { ...evidence, expectedRoot, creationTime: evidence.creationTime ?? new Date().toISOString() };
      }),
      writeState: options.writeState,
    });
    gateway.unref();
    return { pid: gateway.pid, gateway, adopted: false };
  } catch (error) {
    const stopped = await stopGatewayChild(gateway, options.childTimeoutMs);
    if (!stopped) throw new Error("OpenBot gateway ownership could not be recorded and child teardown was not proven", { cause: error });
    await removeOwnedProcessState(options.processStatePath ?? installLayout(installRoot).processState, instanceId).catch(() => undefined);
    throw error instanceof Error ? error : new Error("OpenBot gateway ownership could not be recorded");
  } finally {
    if (ownsLock) await lock.release();
  }
}

async function readGatewayHealth(url) {
  try {
    const response = await fetch(`${url.replace(/\/$/u, "")}/health`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return null;
    const health = await response.json();
    return health?.ok === true && Number.isInteger(health.pid) && health.pid > 0 ? health : null;
  } catch {
    return null;
  }
}

async function gatewayMatches(pid, installRoot, options) {
  const evidence = await (options.queryProcessEvidence ?? queryProcessEvidence)(pid).catch(() => null);
  return gatewayEvidenceMatches(evidence, pid, installRoot);
}

function gatewayEvidenceMatches(evidence, pid, installRoot) {
  if (evidence == null || evidence.pid !== pid) return false;
  if (evidence.executablePath == null || resolve(evidence.executablePath).toLowerCase() !== resolve(process.execPath).toLowerCase()) return false;
  const commandLine = String(evidence.commandLine ?? "").toLowerCase();
  return commandLine.includes(join(installRoot, "dist", "main.js").toLowerCase());
}

async function waitForGateway(url, expectedPid, child, timeoutMs = 20_000) {
  const deadline = Date.now() + Number(timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    const health = await readGatewayHealth(url);
    if (health?.pid === expectedPid) return health;
    if (child?.spawnError) throw child.spawnError;
    if (child?.exitCode != null) throw new Error(`Local gateway exited with code ${child.exitCode}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Local gateway did not become ready");
}

export async function main(options = {}) {
  const args = Array.isArray(options) ? parseArgs(options) : options;
  const result = await startGateway(Array.isArray(options) ? {
    installRoot: args.root ?? process.env.OPENBOT_ROOT ?? root,
    url: args.url ?? process.env.SAND_HOST_GATEWAY_URL,
    adoptExisting: true,
    waitForReady: true,
    timeoutMs: args.timeout,
  } : options);
  process.stdout.write(`${result.pid}|${result.adopted ? "adopted" : "started"}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[start-gateway] ${error.message}`);
    process.exitCode = 1;
  });
}
