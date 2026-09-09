import { promises as fs } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import net from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  defaultDataRoot,
  atomicWriteJson,
  captureProcessEvidence,
  installLayout,
  isWithin,
  parseArgs,
  queryProcessEvidence,
  readJson,
  removeOwnedProcessState,
} from "./release-common.mjs";

const execFile = promisify(execFileCallback);

function positivePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function samePath(left, right) {
  return resolve(String(left)).toLowerCase() === resolve(String(right)).toLowerCase();
}

export function assertLoopbackUrl(value) {
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
  return parsed.toString().replace(/\/$/u, "");
}

export function normalizeTimeout(value, fallback = 10_000, label = "timeout") {
  if (value == null || value === "") return fallback;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) throw new Error(`OpenBot ${label} must be a finite non-negative number`);
  return normalized;
}

function ownershipRecord(state, options) {
  const gateway = state?.processes?.gateway;
  const pid = positivePid(gateway?.pid ?? state?.gatewayPid ?? options.pid);
  const expectedExecutable = gateway?.executablePath ?? gateway?.expectedExecutable ?? options.expectedExecutable;
  const expectedRoot = gateway?.expectedRoot ?? options.expectedRoot ?? options.installRoot;
  const creationTime = gateway?.creationTime ?? options.creationTime;
  if (pid == null || !expectedExecutable || !expectedRoot || !creationTime) return null;
  return {
    pid,
    creationTime: String(creationTime),
    expectedExecutable: resolve(String(expectedExecutable)),
    expectedRoot: resolve(String(expectedRoot)),
  };
}

export function processOwnershipMatches(record, evidence) {
  if (record == null || evidence == null || record.pid !== Number(evidence.pid)) return false;
  if (record.creationTime !== String(evidence.creationTime ?? "")) return false;
  if (evidence.executablePath == null || !samePath(record.expectedExecutable, evidence.executablePath)) return false;
  const executableInRoot = isWithin(record.expectedRoot, resolve(String(evidence.executablePath)));
  const commandLine = String(evidence.commandLine ?? "").toLowerCase();
  const rootInCommand = commandLine.includes(resolve(record.expectedRoot).toLowerCase());
  return executableInRoot || rootInCommand;
}

async function readState(options) {
  if (options.processState != null && typeof options.processState === "object") return options.processState;
  const processStatePath = options.processStatePath ?? installLayout(options.installRoot).processState;
  try {
    return await readJson(processStatePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("OpenBot gateway process state is unreadable", { cause: error });
  }
}

async function readToken(state, options) {
  const dataRoot = options.dataRoot
    ?? state?.gateway?.dataRoot
    ?? state?.dataRoot
    ?? defaultDataRoot(options.env ?? process.env);
  const tokenPath = options.tokenPath ?? state?.gateway?.tokenPath ?? join(resolve(String(dataRoot)), "gateway.token");
  try {
    const token = (await fs.readFile(tokenPath, "utf8")).trim();
    if (!token) throw new Error("empty");
    return token;
  } catch {
    throw new Error("OpenBot gateway token is unavailable");
  }
}

async function requestShutdown(url, token, options) {
  if (options.requestShutdown) {
    try {
      const response = await options.requestShutdown({ url, token });
      if (response === false || (response?.status != null && Number(response.status) !== 202)) throw new Error("unexpected shutdown response");
      return true;
    } catch {
      throw new Error("OpenBot gateway graceful shutdown request failed");
    }
  }
  let response;
  try {
    response = await fetch(`${url}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "http://127.0.0.1" },
      signal: AbortSignal.timeout(Number(options.requestTimeoutMs ?? 2_000)),
    });
  } catch {
    throw new Error("OpenBot gateway graceful shutdown request failed");
  }
  if (response.status !== 202) {
    throw new Error(`OpenBot gateway graceful shutdown rejected (HTTP ${response.status})`);
  }
  return true;
}

async function queryGatewayPid(url, options) {
  if (options.queryGatewayPid) return options.queryGatewayPid(url);
  // Test seams model process evidence and port state directly; production
  // always confirms the loopback health PID before sending the token.
  if (options.isPortPresent) return null;
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return null;
    const health = await response.json();
    return positivePid(health?.pid);
  } catch {
    return null;
  }
}

async function portPresent(url, options) {
  if (options.isPortPresent) return options.isPortPresent(url);
  const parsed = new URL(assertLoopbackUrl(url));
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  return new Promise((resolvePort) => {
    const socket = net.createConnection({ host: parsed.hostname.replace(/^\[|\]$/gu, ""), port });
    const finish = (present) => { socket.destroy(); resolvePort(present); };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function prove(record, options) {
  const evidence = await (options.queryProcessEvidence ?? queryProcessEvidence)(record.pid);
  return {
    evidence,
    owned: processOwnershipMatches(record, evidence),
    alive: evidence != null,
  };
}

async function forceKill(pid, options) {
  if (options.forceKill) return options.forceKill(pid);
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
  try {
    await execFile(options.taskkillPath ?? "taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    throw new Error("OpenBot gateway force shutdown failed");
  }
}

export async function shutdownGateway(options = {}) {
  const timeoutMs = normalizeTimeout(options.timeoutMs, 10_000);
  const forceWaitMs = normalizeTimeout(options.forceWaitMs, timeoutMs, "force timeout");
  const state = await readState(options);
  const statePath = options.processStatePath ?? (options.installRoot == null ? null : installLayout(options.installRoot).processState);
  const finish = async (result) => {
    if (result.teardownProven && options.removeState === true && statePath != null) {
      await removeOwnedProcessState(statePath, state?.instanceId, { allowMissingIdentity: state?.instanceId == null });
    }
    return result;
  };
  const record = ownershipRecord(state, options);
  if (record == null) {
    return finish({ ok: false, owned: false, teardownProven: false, forced: false, gracefulAccepted: false, reason: "ownership-unproven" });
  }
  const url = assertLoopbackUrl(options.url ?? state?.gateway?.url ?? state?.gatewayUrl ?? "http://127.0.0.1:1340");
  const initial = await prove(record, options);
  if (!initial.owned) {
    if (!initial.alive && !(await portPresent(url, options))) {
      return finish({ ok: true, owned: true, teardownProven: true, forced: false, gracefulAccepted: false, pid: record.pid, reason: "stale" });
    }
    return finish({ ok: false, owned: false, teardownProven: false, forced: false, gracefulAccepted: false, reason: initial.alive ? "ownership-mismatch" : "process-absent" });
  }

  const respondingPid = await queryGatewayPid(url, options);
  if (respondingPid == null || respondingPid !== record.pid) {
    return finish({ ok: false, owned: false, teardownProven: false, forced: false, gracefulAccepted: false, reason: respondingPid == null ? "gateway-unconfirmed" : "gateway-pid-mismatch" });
  }

  let gracefulAccepted = false;
  let gracefulError = null;
  try {
    const token = await readToken(state, options);
    await requestShutdown(url, token, options);
    gracefulAccepted = true;
  } catch {
    // Keep the error redacted, then continue through the bounded ownership
    // recheck so an owned gateway cannot be silently stranded.
    gracefulError = "graceful-unavailable";
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const [proof, present] = await Promise.all([prove(record, options), portPresent(url, options)]);
    if (!proof.alive && !present) {
      return finish({ ok: true, owned: true, teardownProven: true, forced: false, gracefulAccepted, pid: record.pid, ...(gracefulError == null ? {} : { reason: gracefulError }) });
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(100, Math.max(1, deadline - Date.now()))));
  }

  // This is intentionally a fresh proof after the bounded graceful wait. A
  // recycled PID or an adopted gateway must never receive the force fallback.
  const recheck = await prove(record, options);
  if (!recheck.owned) {
    return finish({ ok: false, owned: false, teardownProven: false, forced: false, gracefulAccepted: false, reason: recheck.alive ? "ownership-changed" : "process-absent" });
  }
  await forceKill(record.pid, options);
  const forceDeadline = Date.now() + forceWaitMs;
  let afterForce = await prove(record, options);
  let portStillPresent = await portPresent(url, options);
  while ((afterForce.alive || portStillPresent === true) && Date.now() <= forceDeadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(100, Math.max(1, forceDeadline - Date.now()))));
    afterForce = await prove(record, options);
    portStillPresent = await portPresent(url, options);
  }
  const gone = !afterForce.alive;
  if (!gone) throw new Error("OpenBot gateway force shutdown was not verified");
  if (portStillPresent === true) throw new Error("OpenBot gateway port remained after force shutdown");
  return finish({ ok: true, owned: true, teardownProven: true, forced: true, gracefulAccepted: false, pid: record.pid, ...(gracefulError == null ? {} : { reason: gracefulError }) });
}

export async function recordGatewayOwnership(options = {}) {
  const installRoot = resolve(String(options.installRoot));
  const pid = positivePid(options.pid);
  if (pid == null) throw new Error("OpenBot gateway PID is invalid");
  const url = assertLoopbackUrl(options.url ?? "http://127.0.0.1:1340");
  const evidence = await (options.captureProcessEvidence ?? captureProcessEvidence)(pid, {
    expectedRoot: installRoot,
    expectedExecutable: options.expectedExecutable,
  });
  const processStatePath = options.processStatePath ?? installLayout(installRoot).processState;
  const state = {
    instanceId: options.instanceId ?? `desktop-${process.pid}-${Date.now()}`,
    product: "OpenBot",
    dataRoot: options.dataRoot ?? defaultDataRoot(options.env ?? process.env),
    gateway: { url, dataRoot: options.dataRoot ?? defaultDataRoot(options.env ?? process.env) },
    gatewayPid: pid,
    processes: { gateway: evidence },
    startedAt: new Date().toISOString(),
  };
  try {
    await (options.writeState ?? atomicWriteJson)(processStatePath, state);
  } catch {
    // The gateway is already owned and evidenced. If the ownership marker
    // cannot be persisted, perform the same authenticated teardown from the
    // in-memory evidence so a launcher failure does not strand this process.
    await shutdownGateway({
      processState: state,
      dataRoot: state.dataRoot,
      url,
      queryProcessEvidence: options.queryProcessEvidence,
      queryGatewayPid: options.queryGatewayPid,
      isPortPresent: options.isPortPresent,
      requestShutdown: options.requestShutdown,
      forceKill: options.forceKill,
      timeoutMs: options.timeoutMs,
      taskkillPath: options.taskkillPath,
    }).catch(() => undefined);
    throw new Error("OpenBot gateway ownership state could not be recorded");
  }
  return { ok: true, pid };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.record === true) {
    const result = await recordGatewayOwnership({
      installRoot: args.root,
      processStatePath: args["process-state"],
      pid: args.pid,
      expectedExecutable: args["expected-executable"],
      dataRoot: args["data-root"],
      url: args.url,
      env: process.env,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  const result = await shutdownGateway({
    installRoot: args.root,
    processStatePath: args["process-state"],
    dataRoot: args["data-root"],
    tokenPath: args["token-path"],
    url: args.url,
    timeoutMs: args.timeout,
    pid: args.pid,
    removeState: args["remove-state"] === true,
    env: process.env,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.ok !== true || result.teardownProven !== true) process.exitCode = 1;
  return result;
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname.replace(/^\/(.):/, "$1:"))) {
  main().catch((error) => {
    console.error(`[shutdown] ${error.message}`);
    process.exitCode = 1;
  });
}
