// Gateway lifecycle for the checkout launcher: identity, ownership record,
// readiness and proven teardown of the local gateway on 127.0.0.1:1340.
//
// Ownership rules (kept deliberately strict):
// - A gateway is ours only when /health reports this checkout's rootId.
// - The bearer token is sent only to a gateway whose /health pid matches the
//   recorded pid and whose rootId matches this checkout.
// - A forced stop needs fresh proof: the live child handle this launcher
//   spawned (Windows keeps the PID reserved while the handle is open), or
//   process evidence (pid + creation time + executable + root) matching the
//   evidence recorded when the gateway started.
import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs, statSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  atomicWriteJson,
  isProcessRunning,
  processOwnershipMatches,
  queryProcessEvidence,
  systemToolPath,
} from "./common.mjs";

const execFile = promisify(execFileCallback);

export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:1340";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function assertLoopbackUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error("OpenBot gateway URL is invalid");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("OpenBot gateway URL must be loopback");
  }
  return parsed.toString().replace(/\/$/u, "");
}

// Must match src/server/build-identity.ts.
export function checkoutRootId(root) {
  return createHash("sha256").update(resolve(root).toLowerCase()).digest("hex").slice(0, 16);
}

export function buildStamp(root) {
  try {
    return String(Math.trunc(statSync(join(root, "dist", "main.js")).mtimeMs));
  } catch {
    return "unknown";
  }
}

export function processStatePath(root) {
  return join(resolve(root), "process.json");
}

export function gatewayEntryScript(root) {
  return join(resolve(root), "dist", "entry.js");
}

function positivePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** /health of the gateway at url, or null when nothing healthy answers. */
export async function readHealth(url, options = {}) {
  const safeUrl = assertLoopbackUrl(url);
  try {
    const response = await fetch(`${safeUrl}/health`, { signal: AbortSignal.timeout(options.timeoutMs ?? 1_000) });
    if (!response.ok) return null;
    const health = await response.json();
    return health?.ok === true && positivePid(health.pid) != null ? health : null;
  } catch {
    return null;
  }
}

export async function portInUse(url, timeoutMs = 250) {
  const parsed = new URL(assertLoopbackUrl(url));
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  return new Promise((resolvePort) => {
    const socket = net.createConnection({ host: parsed.hostname.replace(/^\[|\]$/gu, ""), port });
    const finish = (present) => { socket.destroy(); resolvePort(present); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

// ------------------------------------------------------------ process.json

export function newInstanceId() {
  return `${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** The ownership record, or null when absent or unreadable (a torn/corrupt file is not ownership). */
export async function readProcessState(path) {
  let text;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`OpenBot gateway process state is unreadable: ${path}`, { cause: error });
  }
  try {
    const state = JSON.parse(text);
    return state != null && typeof state === "object" && typeof state.instanceId === "string"
      && positivePid(state.gateway?.pid) != null ? state : null;
  } catch {
    return null;
  }
}

export async function writeProcessState(path, state) {
  await atomicWriteJson(path, state);
}

/** Remove the record only while it still names instanceId; a newer launcher's record is kept. */
export async function removeProcessStateIfOwner(path, instanceId) {
  const current = await readProcessState(path).catch(() => null);
  if (current?.instanceId !== instanceId) return false;
  await fs.rm(path, { force: true });
  return true;
}

// ----------------------------------------------------------------- token

export function gatewayTokenPath(dataRoot, env = process.env) {
  const explicit = env.OPENBOT_GATEWAY_TOKEN_PATH?.trim();
  return explicit ? resolve(explicit) : join(resolve(dataRoot), "gateway.token");
}

export async function readGatewayToken(tokenPath) {
  let token;
  try {
    token = (await fs.readFile(tokenPath, "utf8")).trim();
  } catch {
    throw new Error("OpenBot gateway token is unavailable");
  }
  if (token.length < 16) throw new Error("OpenBot gateway token is unavailable");
  return token;
}

export async function requestShutdown(url, token, options = {}) {
  let response;
  try {
    response = await fetch(`${assertLoopbackUrl(url)}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "http://127.0.0.1" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
    });
  } catch {
    throw new Error("OpenBot gateway graceful shutdown request failed");
  }
  if (response.status !== 202) throw new Error(`OpenBot gateway graceful shutdown rejected (HTTP ${response.status})`);
}

// -------------------------------------------------------------- readiness

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

/**
 * Track a spawned child: error/exit are recorded synchronously so readiness
 * and teardown can consult them at any time.
 */
export function watchChild(child) {
  const watch = { child, error: null, exited: false, code: null };
  watch.done = new Promise((resolveDone) => {
    child.once?.("error", (error) => {
      watch.error = error;
      // A spawn failure never emits exit.
      if (positivePid(child.pid) == null) { watch.exited = true; resolveDone(); }
    });
    child.once?.("exit", (code, signal) => {
      watch.exited = true;
      watch.code = code ?? (signal ? 1 : 0);
      resolveDone();
    });
  });
  return watch;
}

/**
 * Wait until /health answers for expectedPid with this checkout's identity.
 * Fails fast when the spawned child exits, when isAlive() says the recorded
 * supervisor is gone, or when options.signal is aborted.
 */
export async function waitForGateway(url, expectedPid, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 45_000);
  const deadline = Date.now() + timeoutMs;
  const logHint = options.logHint ? `; see ${options.logHint}` : "";
  while (true) {
    const health = await readHealth(url);
    if (health?.pid === expectedPid) {
      if (options.rootId != null && health.rootId !== options.rootId) {
        throw new Error(`Gateway PID ${expectedPid} does not belong to this checkout`);
      }
      return health;
    }
    if (options.signal?.aborted) throw new Error("Gateway readiness wait was cancelled");
    const watch = options.watch;
    if (watch?.error) throw new Error(`Local gateway failed to start: ${watch.error.message}`, { cause: watch.error });
    if (watch?.exited) throw new Error(`Local gateway exited with code ${watch.code}${logHint}`);
    if (options.isAlive != null && !(await options.isAlive())) throw new Error(`Local gateway process ${expectedPid} stopped before becoming ready${logHint}`);
    if (Date.now() >= deadline) throw new Error(`Local gateway did not become ready in ${Math.round(timeoutMs / 1000)}s${logHint}`);
    await delay(100);
  }
}

// --------------------------------------------------------------- teardown

async function killTree(pid, options) {
  if (options.forceKill) return options.forceKill(pid);
  if (process.platform !== "win32") {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    return;
  }
  await execFile(systemToolPath("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, maxBuffer: 1024 * 1024 })
    .catch(() => undefined);
}

async function waitGone(pid, url, options, timeoutMs) {
  const running = options.isProcessRunning ?? isProcessRunning;
  const inUse = options.portInUse ?? portInUse;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const watch = options.watch;
    const alive = watch != null ? !watch.exited : await running(pid);
    if (!alive && !(await inUse(url))) return true;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Stop a gateway this launcher owns. Graceful first (authenticated
 * /shutdown, only to the proven gateway), then a forced tree kill only with
 * fresh proof of identity. Resolves with what happened; throws when the
 * teardown cannot be proven.
 */
export async function stopGateway(options) {
  const url = assertLoopbackUrl(options.url ?? DEFAULT_GATEWAY_URL);
  const pid = positivePid(options.pid);
  if (pid == null) throw new Error("OpenBot gateway PID is invalid");
  const timeoutMs = Number(options.timeoutMs ?? 10_000);
  const watch = options.watch ?? null;
  const running = options.isProcessRunning ?? isProcessRunning;
  const query = options.queryProcessEvidence ?? queryProcessEvidence;

  if (watch?.exited || (watch == null && !(await running(pid)))) {
    if (await (options.portInUse ?? portInUse)(url)) {
      return { stopped: false, forced: false, gracefulAccepted: false, reason: "port-held-by-other-process" };
    }
    return { stopped: true, forced: false, gracefulAccepted: false, reason: "already-stopped" };
  }

  let gracefulAccepted = false;
  const health = await (options.readHealth ?? readHealth)(url);
  if (health?.pid === pid && (options.rootId == null || health.rootId === options.rootId)) {
    try {
      const token = await (options.readToken ?? (() => readGatewayToken(options.tokenPath)))();
      await (options.requestShutdown ?? requestShutdown)(url, token);
      gracefulAccepted = true;
    } catch {
      // Fall through to the bounded wait and the proven force path.
    }
  }
  if (gracefulAccepted && await waitGone(pid, url, { ...options, watch }, timeoutMs)) {
    return { stopped: true, forced: false, gracefulAccepted, reason: "graceful" };
  }

  // Fresh proof right before forcing: never kill a recycled or foreign PID.
  let proven = watch != null && !watch.exited;
  if (!proven && options.evidence != null) {
    const evidence = await query(pid).catch(() => null);
    if (evidence == null) {
      return { stopped: !(await (options.portInUse ?? portInUse)(url)), forced: false, gracefulAccepted, reason: "exited" };
    }
    proven = processOwnershipMatches(options.evidence, evidence);
  }
  if (!proven) throw new Error(`OpenBot gateway PID ${pid} did not stop and its ownership cannot be proven; it was left running`);
  await killTree(pid, options);
  if (!(await waitGone(pid, url, { ...options, watch }, options.forceWaitMs ?? 5_000))) {
    throw new Error(`OpenBot gateway PID ${pid} is still running after a forced stop`);
  }
  return { stopped: true, forced: true, gracefulAccepted, reason: "forced" };
}
