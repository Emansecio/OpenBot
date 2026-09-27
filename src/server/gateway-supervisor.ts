import { spawn as nodeSpawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";

import { systemToolPath } from "../shared/windows-tools.js";

/** Set on the gateway process started by the supervisor. */
export const GATEWAY_WORKER_ENV = "OPENBOT_GATEWAY_WORKER";
/** Opt-out for debugging: `0` runs the gateway in the entry process as before. */
export const GATEWAY_SUPERVISOR_ENV = "OPENBOT_GATEWAY_SUPERVISOR";
/** PID the worker reports in /health, so launcher ownership proofs keep targeting the supervisor. */
export const GATEWAY_SERVICE_PID_ENV = "OPENBOT_GATEWAY_SERVICE_PID";
export const GATEWAY_READY_MESSAGE = "openbot-gateway-ready";
export const GATEWAY_HEARTBEAT_MESSAGE = "openbot-gateway-heartbeat";
export const GATEWAY_STOP_MESSAGE = "openbot-gateway-stop";
/** Sent by the worker before a requested stop, so a failing teardown is not restarted. */
export const GATEWAY_STOPPING_MESSAGE = "openbot-gateway-stopping";

const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 10_000] as const;
const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS_PER_WINDOW = 5;
export const HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_STOP_GRACE_MS = 15_000;

export interface WorkerExit {
  code: number | null;
  /** The worker announced it was listening. */
  ready: boolean;
  /** The worker was itself a restart, so a boot failure may be transient (port still releasing). */
  restarted: boolean;
}

export type SupervisorDecision = { action: "exit"; code: number } | { action: "restart"; delayMs: number };

export function nextSupervisorAction(
  exit: WorkerExit,
  state: { stopping: boolean; restartTimes: readonly number[]; now: number },
): SupervisorDecision {
  const code = exit.code ?? 1;
  if (state.stopping || code === 0) return { action: "exit", code };
  // A first worker that never listened failed to boot (port taken, bad config): a restart cannot fix it.
  if (!exit.ready && !exit.restarted) return { action: "exit", code };
  const recent = state.restartTimes.filter((at) => state.now - at < RESTART_WINDOW_MS).length;
  if (recent >= MAX_RESTARTS_PER_WINDOW) return { action: "exit", code };
  return { action: "restart", delayMs: RESTART_DELAYS_MS[Math.min(recent, RESTART_DELAYS_MS.length - 1)]! };
}

let capturedServicePid: number | undefined;

/**
 * Reads the supervisor's variables once and removes them from the worker's
 * environment: every process the gateway spawns inherits process.env, and a
 * nested OpenBot started from a bot must not believe it is a worker or report
 * this supervisor's PID.
 */
export function captureWorkerEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const value = Number(env[GATEWAY_SERVICE_PID_ENV]);
  capturedServicePid = Number.isSafeInteger(value) && value > 0 ? value : undefined;
  delete env[GATEWAY_WORKER_ENV];
  delete env[GATEWAY_SERVICE_PID_ENV];
}

export function servicePid(env: NodeJS.ProcessEnv = process.env): number {
  if (capturedServicePid !== undefined) return capturedServicePid;
  const value = Number(env[GATEWAY_SERVICE_PID_ENV]);
  return Number.isSafeInteger(value) && value > 0 ? value : process.pid;
}

export function terminateWorkerTree(
  pid: number,
  run: typeof spawnSync = spawnSync,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform !== "win32") {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    return;
  }
  run(systemToolPath("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 10_000,
  });
}

export interface SuperviseGatewayOptions {
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  execPath?: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => void;
  exit?: (code: number) => void;
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
  log?: (message: string) => void;
  terminateTree?: (pid: number) => void;
  /** `0` disables the hung-worker watchdog (tests). */
  heartbeatTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  stopGraceMs?: number;
}

/**
 * Keeps the gateway available: runs it as a child and restarts it after an
 * unexpected exit. A requested shutdown (exit 0) or a signal ends supervision;
 * force teardown by the launchers kills this process tree, worker included.
 */
export function superviseGateway(options: SuperviseGatewayOptions = {}): void {
  const spawn = options.spawn ?? nodeSpawn;
  const execPath = options.execPath ?? process.execPath;
  const args = options.args ?? [...process.execArgv, process.argv[1]!, ...process.argv.slice(2)];
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, delayMs) => { setTimeout(callback, delayMs); });
  const exit = options.exit ?? ((code) => process.exit(code));
  const onSignal = options.onSignal ?? ((signal, handler) => { process.on(signal, handler); });
  const log = options.log ?? ((message) => console.error(`[openbot] ${message}`));
  const terminateTree = options.terminateTree ?? terminateWorkerTree;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  let stopping = false;
  let current: ChildProcess | undefined;
  const restartTimes: number[] = [];

  const requestWorkerStop = (exitCode: number): void => {
    const child = current;
    if (child == null) return;
    try { child.send?.({ type: GATEWAY_STOP_MESSAGE, exitCode }); } catch { /* worker already gone */ }
    const pid = child.pid;
    if (pid == null) return;
    setTimer(() => {
      if (current === child && child.exitCode == null && child.signalCode == null) terminateTree(pid);
    }, stopGraceMs);
  };

  // Console Ctrl+C reaches the worker directly; only stop restarting here.
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    onSignal(signal, () => {
      stopping = true;
      requestWorkerStop(0);
    });
  }

  const start = (restarted: boolean): void => {
    let ready = false;
    let settled = false;
    let lastBeat = 0;
    const child = spawn(execPath, args, {
      env: { ...env, [GATEWAY_WORKER_ENV]: "1", [GATEWAY_SERVICE_PID_ENV]: String(process.pid) },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      windowsHide: true,
    });
    current = child;
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (current === child) current = undefined;
      const decision = nextSupervisorAction({ code, ready, restarted }, { stopping, restartTimes, now: now() });
      if (decision.action === "exit") {
        if (code !== 0 && !stopping) log(`gateway encerrado com código ${code ?? "desconhecido"}; supervisor finalizado.`);
        exit(decision.code);
        return;
      }
      restartTimes.push(now());
      log(`gateway encerrado com código ${code ?? "desconhecido"}; reiniciando em ${decision.delayMs} ms.`);
      setTimer(() => {
        // A stop requested during the backoff ends supervision cleanly.
        if (stopping) exit(0);
        else start(true);
      }, decision.delayMs);
    };
    const watchHeartbeat = (): void => {
      if (settled || stopping || heartbeatTimeoutMs <= 0) return;
      if (ready && now() - lastBeat >= heartbeatTimeoutMs) {
        log("gateway sem heartbeat; encerrando o worker travado.");
        requestWorkerStop(1);
        return;
      }
      setTimer(watchHeartbeat, heartbeatIntervalMs);
    };
    child.on("message", (message: unknown) => {
      const type = (message as { type?: unknown } | null)?.type;
      if (type === GATEWAY_STOPPING_MESSAGE) {
        stopping = true;
        return;
      }
      if (type === GATEWAY_READY_MESSAGE || type === GATEWAY_HEARTBEAT_MESSAGE) {
        lastBeat = now();
        if (type === GATEWAY_READY_MESSAGE) {
          ready = true;
          if (heartbeatTimeoutMs > 0) setTimer(watchHeartbeat, heartbeatIntervalMs);
        }
      }
    });
    // 'error' also reports failed kill/IPC sends on a running worker; only a
    // worker that never started is settled here, the rest end in 'exit'.
    child.on("error", (error: NodeJS.ErrnoException) => {
      const spawnFailed = child.pid === undefined || error.syscall?.startsWith("spawn") === true || /^spawn\b/u.test(error.message);
      if (spawnFailed) {
        log(`falha ao iniciar o gateway: ${error.message}`);
        settle(1);
      } else {
        log(`erro no processo do gateway: ${error.message}`);
      }
    });
    child.once("exit", (code) => settle(code));
  };
  start(false);
}
