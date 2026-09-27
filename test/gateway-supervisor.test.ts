import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  GATEWAY_READY_MESSAGE,
  GATEWAY_SERVICE_PID_ENV,
  GATEWAY_STOP_MESSAGE,
  GATEWAY_STOPPING_MESSAGE,
  GATEWAY_WORKER_ENV,
  captureWorkerEnvironment,
  nextSupervisorAction,
  servicePid,
  superviseGateway,
  type SuperviseGatewayOptions,
} from "../src/server/gateway-supervisor.js";

describe("nextSupervisorAction", () => {
  const idle = { stopping: false, restartTimes: [], now: 1_000_000 };

  it("ends supervision on a requested stop or a clean exit", () => {
    expect(nextSupervisorAction({ code: 0, ready: true, restarted: false }, idle)).toEqual({ action: "exit", code: 0 });
    expect(nextSupervisorAction({ code: 1, ready: true, restarted: false }, { ...idle, stopping: true })).toEqual({ action: "exit", code: 1 });
  });

  it("does not retry a first boot failure but retries a failed restart", () => {
    expect(nextSupervisorAction({ code: 1, ready: false, restarted: false }, idle)).toEqual({ action: "exit", code: 1 });
    expect(nextSupervisorAction({ code: 1, ready: false, restarted: true }, idle)).toEqual({ action: "restart", delayMs: 1_000 });
    expect(nextSupervisorAction({ code: null, ready: true, restarted: false }, idle)).toEqual({ action: "restart", delayMs: 1_000 });
  });

  it("backs off and gives up after too many restarts in the window", () => {
    const now = 1_000_000;
    expect(nextSupervisorAction({ code: 1, ready: true, restarted: true }, { stopping: false, restartTimes: [now - 1, now - 2], now }))
      .toEqual({ action: "restart", delayMs: 5_000 });
    const burst = [1, 2, 3, 4, 5].map((offset) => now - offset);
    expect(nextSupervisorAction({ code: 1, ready: true, restarted: true }, { stopping: false, restartTimes: burst, now }))
      .toEqual({ action: "exit", code: 1 });
    const old = [1, 2, 3, 4, 5].map((offset) => now - 11 * 60_000 - offset);
    expect(nextSupervisorAction({ code: 1, ready: true, restarted: true }, { stopping: false, restartTimes: old, now }))
      .toEqual({ action: "restart", delayMs: 1_000 });
  });
});

describe("superviseGateway", () => {
  class FakeChild extends EventEmitter {
    readonly sent: unknown[] = [];
    exitCode: number | null = null;
    signalCode: string | null = null;
    constructor(readonly options: SpawnOptions, readonly pid = 4_200) { super(); }
    send(message: unknown): boolean { this.sent.push(message); return true; }
    ready(): void { this.emit("message", { type: GATEWAY_READY_MESSAGE }); }
    die(code: number | null): void {
      this.exitCode = code;
      this.emit("exit", code, null);
    }
  }

  const harness = (overrides: Partial<SuperviseGatewayOptions> = {}) => {
    const children: FakeChild[] = [];
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const exits: number[] = [];
    const terminated: number[] = [];
    const signals = new Map<string, () => void>();
    superviseGateway({
      spawn: (_command, _args, options) => {
        const child = new FakeChild(options);
        children.push(child);
        return child as unknown as ChildProcess;
      },
      execPath: "node.exe",
      args: ["dist/main.js"],
      env: { PATH: "C:\\Windows" },
      now: () => 1_000_000,
      setTimer: (callback, delayMs) => { timers.push({ callback, delayMs }); },
      exit: (code) => { exits.push(code); },
      onSignal: (signal, handler) => { signals.set(signal, handler); },
      terminateTree: (pid) => { terminated.push(pid); },
      heartbeatTimeoutMs: 0,
      log: () => undefined,
      ...overrides,
    });
    return { children, timers, exits, signals, terminated };
  };

  it("starts a marked worker, restarts it after a crash, and stops on a clean exit", () => {
    const { children, timers, exits } = harness();
    expect(children).toHaveLength(1);
    expect(children[0]!.options.env).toMatchObject({ PATH: "C:\\Windows", [GATEWAY_WORKER_ENV]: "1", [GATEWAY_SERVICE_PID_ENV]: String(process.pid) });
    expect(children[0]!.options.stdio).toEqual(["inherit", "inherit", "inherit", "ipc"]);

    children[0]!.ready();
    children[0]!.die(1);
    expect(exits).toEqual([]);
    expect(timers).toEqual([expect.objectContaining({ delayMs: 1_000 })]);
    timers[0]!.callback();
    expect(children).toHaveLength(2);

    children[1]!.ready();
    children[1]!.die(0);
    expect(exits).toEqual([0]);
  });

  it("exits with the boot failure code without restarting", () => {
    const { children, timers, exits } = harness();
    children[0]!.die(1);
    expect(timers).toEqual([]);
    expect(exits).toEqual([1]);
  });

  it("does not restart after a stop signal, even if the worker then fails", () => {
    const { children, timers, exits, signals } = harness();
    children[0]!.ready();
    signals.get("SIGINT")!();
    expect(children[0]!.sent).toEqual([{ type: GATEWAY_STOP_MESSAGE, exitCode: 0 }]);
    children[0]!.die(1);
    expect(timers.filter((timer) => timer.delayMs === 1_000)).toEqual([]);
    expect(exits).toEqual([1]);
  });

  it("restarts a worker that goes silent after becoming ready", () => {
    let clock = 1_000_000;
    const { children, timers, terminated } = harness({
      heartbeatTimeoutMs: 40,
      heartbeatIntervalMs: 10,
      stopGraceMs: 5,
      now: () => clock,
    });
    children[0]!.ready();
    const watch = timers.find((timer) => timer.delayMs === 10);
    expect(watch).toBeDefined();
    clock += 40;
    watch!.callback();
    expect(children[0]!.sent).toEqual([{ type: GATEWAY_STOP_MESSAGE, exitCode: 1 }]);
    const grace = timers.find((timer) => timer.delayMs === 5);
    grace!.callback();
    expect(terminated).toEqual([4_200]);
  });

  it("does not restart a worker that announced a requested stop, even if its teardown fails", () => {
    const { children, timers, exits } = harness();
    children[0]!.ready();
    children[0]!.emit("message", { type: GATEWAY_STOPPING_MESSAGE });
    children[0]!.die(1);
    expect(timers.filter((timer) => timer.delayMs === 1_000)).toEqual([]);
    expect(exits).toEqual([1]);
  });

  it("keeps supervising when a running worker reports an IPC error", () => {
    const { children, exits } = harness();
    children[0]!.ready();
    children[0]!.emit("error", Object.assign(new Error("channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" }));
    expect(exits).toEqual([]);
    children[0]!.die(0);
    expect(exits).toEqual([0]);
  });

  it("ends cleanly when a stop signal arrives during the restart backoff", () => {
    const { children, timers, exits, signals } = harness();
    children[0]!.ready();
    children[0]!.die(1);
    signals.get("SIGTERM")!();
    timers.find((timer) => timer.delayMs === 1_000)!.callback();
    expect(children).toHaveLength(1);
    expect(exits).toEqual([0]);
  });

  it("settles once when a spawn error is followed by exit", () => {
    const { children, exits } = harness();
    children[0]!.emit("error", new Error("spawn node.exe ENOENT"));
    children[0]!.die(-4058);
    expect(exits).toEqual([1]);
  });
});

describe("captureWorkerEnvironment", () => {
  it("keeps the supervisor pid and removes the worker markers from the inherited environment", () => {
    const env: NodeJS.ProcessEnv = { [GATEWAY_WORKER_ENV]: "1", [GATEWAY_SERVICE_PID_ENV]: "4343", PATH: "C:\\Windows" };
    captureWorkerEnvironment(env);
    expect(env).toEqual({ PATH: "C:\\Windows" });
    expect(servicePid(env)).toBe(4343);
    captureWorkerEnvironment({});
    expect(servicePid({})).toBe(process.pid);
  });
});

describe("servicePid", () => {
  it("reports the supervisor pid only when it is a valid positive integer", () => {
    expect(servicePid({ [GATEWAY_SERVICE_PID_ENV]: "4242" })).toBe(4242);
    expect(servicePid({ [GATEWAY_SERVICE_PID_ENV]: "abc" })).toBe(process.pid);
    expect(servicePid({})).toBe(process.pid);
  });
});

