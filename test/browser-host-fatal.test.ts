import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { BROWSER_HOST_SOURCE as hostSource, loadBrowserHost } from "./helpers/browser-host.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hostPath = resolve(root, "scripts/openbot-browser-host.cjs");
const electronCli = resolve(root, "node_modules/electron/cli.js");

interface SchedulerRequest {
  id: string;
  agentId: string;
  sessionId: string;
  tabId: string;
  partition: string;
  command: { command: string; targetId?: string };
}

interface SchedulerHarness {
  enqueueRequest(request: SchedulerRequest): void;
  handleCancel(request: SchedulerRequest): void;
  handleLine(line: string): Promise<void>;
  hostExecute(request: SchedulerRequest, signal: AbortSignal): Promise<unknown>;
  seedTab(tabId: string, tab: Record<string, unknown>): void;
  setExecute(execute: (request: SchedulerRequest, signal: AbortSignal) => Promise<unknown>): void;
  setTransport(
    sendValue: (value: unknown) => Promise<void>,
    sendFailure: (id: string, code: string, message: string) => Promise<void>,
  ): void;
  failFastHost(kind: string, error: Error): void;
  seedFatalWindows(): void;
  fatalState(): { tabCount: number; tabDestroyCalls: number; keepAliveDestroyCalls: number; quitCalls: number };
  state(): {
    activeRequestCount: number;
    agentOrder: string[];
    queuedByAgent: Array<[string, number]>;
    maxActiveRequests: number;
    maxAgentQueue: number;
    maxTotalQueue: number;
  };
}

function schedulerRequest(id: string, agentId: string, command: SchedulerRequest["command"] = { command: "snapshot" }): SchedulerRequest {
  return { id, agentId, sessionId: `session-${agentId}`, tabId: `tab-${agentId}`, partition: `persist:${agentId}`, command };
}

function createSchedulerHarness(): SchedulerHarness {
  // Runs inside the host module scope, so it can swap the scheduler seams.
  const exposeHarness = `
  let fatalTabDestroyCalls = 0;
  let keepAliveDestroyCalls = 0;
  harness.scheduler = {
  enqueueRequest,
  handleCancel,
  handleLine,
  hostExecute: execute,
  seedTab(tabId, tab) { TABS.set(tabId, tab); },
  setExecute(value) { execute = value; },
  setTransport(sendValue, sendFailure) { send = sendValue; sendError = sendFailure; },
  failFastHost,
  seedFatalWindows() {
    TABS.set("fatal-tab", { window: { isDestroyed: () => false, destroy: () => { fatalTabDestroyCalls += 1; } } });
    keepAliveWindow = { isDestroyed: () => false, destroy: () => { keepAliveDestroyCalls += 1; } };
  },
  fatalState() {
    return { tabCount: TABS.size, tabDestroyCalls: fatalTabDestroyCalls, keepAliveDestroyCalls, quitCalls: app.quitCalls };
  },
  state() {
    return {
      activeRequestCount,
      agentOrder: [...AGENT_ORDER],
      queuedByAgent: [...AGENT_QUEUES].map(([agentId, queue]) => [agentId, queue.items.length]),
      maxActiveRequests: MAX_ACTIVE_REQUESTS,
      maxAgentQueue: MAX_AGENT_QUEUE,
      maxTotalQueue: MAX_TOTAL_QUEUE,
    };
  },
};`;
  return loadBrowserHost({ append: exposeHarness }).scope.scheduler as SchedulerHarness;
}

async function flushScheduler(): Promise<void> {
  await new Promise<void>((resolveFlush) => setImmediate(resolveFlush));
}

describe("browser host fatal lifecycle", () => {
  it("chooses fairly between multiple eligible queued agents across scheduler cycles", async () => {
    const harness = createSchedulerHarness();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    harness.setExecute((request) => {
      started.push(request.id);
      return new Promise<void>((resolve) => releases.set(request.id, resolve));
    });
    harness.setTransport(async () => undefined, async () => undefined);
    for (const agentId of ["a", "b", "c", "d"]) {
      for (let index = 1; index <= 3; index += 1) {
        harness.enqueueRequest(schedulerRequest(`${agentId}-${index}`, agentId));
      }
    }
    harness.enqueueRequest(schedulerRequest("e-1", "e"));
    expect(started).toEqual(["a-1", "b-1", "c-1", "d-1"]);
    for (const id of ["a-1", "b-1", "c-1", "d-1"]) {
      releases.get(id)!();
      await flushScheduler();
    }
    expect(started).toEqual(["a-1", "b-1", "c-1", "d-1", "a-2", "b-2", "c-2", "d-2"]);
    releases.get("a-2")!();
    await flushScheduler();
    expect(started.at(-1)).toBe("e-1");
  });

  it("keeps the active scheduler slot until a cancelled operation really returns", async () => {
    const harness = createSchedulerHarness();
    const started: string[] = [];
    const signals = new Map<string, AbortSignal>();
    const releases = new Map<string, () => void>();
    harness.setExecute((request, signal) => {
      started.push(request.id);
      signals.set(request.id, signal);
      return new Promise<void>((resolve) => releases.set(request.id, resolve));
    });
    harness.setTransport(async () => undefined, async () => undefined);
    for (const agentId of ["a", "b", "c", "d", "e"]) {
      harness.enqueueRequest(schedulerRequest(`${agentId}-1`, agentId));
    }

    expect(started).toEqual(["a-1", "b-1", "c-1", "d-1"]);
    harness.handleCancel(schedulerRequest("cancel-a-1", "a", { command: "cancel", targetId: "a-1" }));
    expect(signals.get("a-1")?.aborted).toBe(true);
    expect(harness.state().activeRequestCount).toBe(4);
    expect(started).not.toContain("e-1");

    releases.get("a-1")!();
    await flushScheduler();
    expect(started).toEqual(["a-1", "b-1", "c-1", "d-1", "e-1"]);
    expect(harness.state().activeRequestCount).toBe(4);
  });

  it("lets close preempt the tab's queued and running work, even with a full queue", async () => {
    const harness = createSchedulerHarness();
    const started: string[] = [];
    const signals = new Map<string, AbortSignal>();
    const releases = new Map<string, () => void>();
    const failures: Array<{ id: string; code: string }> = [];
    harness.setExecute((request, signal) => {
      started.push(request.id);
      signals.set(request.id, signal);
      return new Promise<void>((resolve) => releases.set(request.id, resolve));
    });
    harness.setTransport(async () => undefined, async (id, code) => { failures.push({ id, code }); });
    harness.enqueueRequest(schedulerRequest("a-running", "a"));
    for (let index = 0; index < 16; index += 1) harness.enqueueRequest(schedulerRequest(`a-queued-${index}`, "a"));
    harness.enqueueRequest(schedulerRequest("b-running", "b"));

    harness.enqueueRequest(schedulerRequest("a-close", "a", { command: "close" }));

    expect(signals.get("a-running")?.aborted).toBe(true);
    expect(failures).toContainEqual({ id: "a-running", code: "BROWSER_COMMAND_ABORTED" });
    expect(failures).toContainEqual({ id: "a-queued-15", code: "BROWSER_COMMAND_ABORTED" });
    expect(failures).not.toContainEqual({ id: "a-close", code: "BROWSER_QUEUE_FULL" });
    expect(signals.get("b-running")?.aborted).toBe(false);
    releases.get("a-running")!();
    await flushScheduler();
    expect(started).toEqual(["a-running", "b-running", "a-close"]);
  });

  it("refuses agent commands on a handed-off or crashed tab but still lets lifecycle through", async () => {
    const harness = createSchedulerHarness();
    const window = {
      isDestroyed: () => false,
      isFocused: () => true,
      show: () => undefined,
      focus: () => undefined,
      webContents: { isDestroyed: () => false, getURL: () => "https://example.com/", getTitle: () => "Example" },
    };
    const owner = { agentId: "a", sessionId: "session-a", partition: "persist:a" };
    harness.seedTab("tab-a", { ...owner, window, handoff: { engaged: true, timer: undefined } });
    const signal = new AbortController().signal;
    await expect(harness.hostExecute(schedulerRequest("snapshot", "a"), signal))
      .rejects.toMatchObject({ code: "BROWSER_HANDOFF_ACTIVE" });
    await expect(harness.hostExecute(schedulerRequest("handoff", "a", { command: "handoff" }), signal))
      .resolves.toMatchObject({ command: "handoff", visible: true });

    harness.seedTab("tab-a", { ...owner, window, handoff: null, crashed: true });
    await expect(harness.hostExecute(schedulerRequest("snapshot", "a"), signal))
      .rejects.toMatchObject({ code: "BROWSER_TAB_CRASHED" });
  });

  it("reports a malformed command from an authenticated caller as invalid, not unauthorized", async () => {
    const harness = createSchedulerHarness();
    const failures: Array<{ id: string; code: string }> = [];
    harness.setTransport(async () => undefined, async (id, code) => { failures.push({ id, code }); });
    const envelope = {
      protocolVersion: 1,
      kind: "request",
      agentId: "a",
      sessionId: "session-a",
      tabId: "tab-a",
      partition: "persist:openbot-agent-" + "a".repeat(32),
      downloadRoot: "C:\\Downloads",
    };
    // The harness host runs without a launch token, so the valid token is "".
    await harness.handleLine(JSON.stringify({ ...envelope, id: "bad-shape", token: "", command: { command: "upload", selector: "input", path: "a.txt:stream" } }));
    await harness.handleLine(JSON.stringify({ ...envelope, id: "bad-token", token: "wrong", command: { command: "snapshot" } }));
    expect(failures).toEqual([
      { id: "bad-shape", code: "BROWSER_COMMAND_INVALID" },
      { id: "bad-token", code: "BROWSER_UNAUTHORIZED" },
    ]);
  });

  it("checks queue limits before retaining a new agent queue", () => {
    const harness = createSchedulerHarness();
    const failures: Array<{ id: string; code: string }> = [];
    harness.setExecute(() => new Promise(() => undefined));
    harness.setTransport(async () => undefined, async (id, code) => { failures.push({ id, code }); });
    for (const agentId of ["a", "b", "c", "d"]) {
      harness.enqueueRequest(schedulerRequest(`${agentId}-active`, agentId));
      for (let index = 0; index < 16; index += 1) {
        harness.enqueueRequest(schedulerRequest(`${agentId}-queued-${index}`, agentId));
      }
    }
    expect(harness.state()).toMatchObject({ maxAgentQueue: 16, maxTotalQueue: 64 });

    harness.enqueueRequest(schedulerRequest("overflow-1", "overflow"));
    expect(failures).toContainEqual({ id: "overflow-1", code: "BROWSER_QUEUE_FULL" });
    expect(harness.state().agentOrder).not.toContain("overflow");
    expect(harness.state().queuedByAgent).not.toContainEqual(["overflow", expect.any(Number)]);
  });

  it("rejects the seventeenth queued request for one blocked agent", () => {
    const harness = createSchedulerHarness();
    const failures: Array<{ id: string; code: string }> = [];
    harness.setExecute(() => new Promise(() => undefined));
    harness.setTransport(async () => undefined, async (id, code) => { failures.push({ id, code }); });
    harness.enqueueRequest(schedulerRequest("a-active", "a"));
    for (let index = 0; index < 16; index += 1) {
      harness.enqueueRequest(schedulerRequest(`a-queued-${index}`, "a"));
    }
    expect(harness.state().queuedByAgent).toContainEqual(["a", 16]);

    harness.enqueueRequest(schedulerRequest("a-overflow", "a"));
    expect(failures).toContainEqual({ id: "a-overflow", code: "BROWSER_QUEUE_FULL" });
    expect(harness.state().queuedByAgent).toContainEqual(["a", 16]);
  });

  it("cleans up tabs and quits Electron after a fatal error", async () => {
    const harness = createSchedulerHarness();
    harness.seedFatalWindows();

    harness.failFastHost("uncaughtException", new Error("fatal cleanup test"));
    await flushScheduler();

    expect(harness.fatalState()).toEqual({
      tabCount: 0,
      tabDestroyCalls: 1,
      keepAliveDestroyCalls: 1,
      quitCalls: 1,
    });
  });

  it("exits an injected fatal exception without waiting for an Electron dialog", async () => {
    const startup = hostSource.indexOf("void main().catch");
    expect(hostSource.indexOf('process.on("uncaughtException"')).toBeGreaterThanOrEqual(0);
    expect(hostSource.indexOf('process.on("uncaughtException"')).toBeLessThan(startup);
    expect(hostSource.indexOf('process.on("unhandledRejection"')).toBeGreaterThanOrEqual(0);
    expect(hostSource.indexOf('process.on("unhandledRejection"')).toBeLessThan(startup);
    expect(hostSource).toContain("process.exit(1)");
    expect(hostSource).toContain("shutdown().catch");
    const child = spawn(process.execPath, [electronCli, hostPath], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        OPENBOT_BROWSER_TEST_INJECT_FATAL: "uncaught",
        ELECTRON_RUN_AS_NODE: undefined,
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolveResult) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolveResult({ code: null, signal: null, timedOut: true });
      }, 10_000);
      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({ code: null, signal: null, timedOut: false });
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({ code, signal, timedOut: false });
      });
    });

    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
    expect(stderr).toMatch(/uncaughtException: injected browser host exception/iu);
  }, 15_000);
});

describe("browser host home lifecycle", () => {
  it.each([true, false])("awaits owned download cleanup and flushes storage even if the tab is present=%s", async (present) => {
    let finishDownload!: () => void;
    const done = new Promise<void>((resolve) => { finishDownload = resolve; });
    const cancel = vi.fn();
    const otherCancel = vi.fn();
    const destroy = vi.fn();
    const close = vi.fn(() => { throw new Error("beforeunload may veto close"); });
    const storage = { flushStorageData: vi.fn(), cookies: { flushStore: vi.fn(async () => undefined) }, clearStorageData: vi.fn() };
    const { host } = loadBrowserHost({ electron: { session: { fromPartition: () => storage } } });
    const owner = { agentId: "agent-a", sessionId: "session-a", partition: "persist:agent-a" };
    if (present) host.TABS.set("a", { ...owner, window: { isDestroyed: () => false, destroy, close } });
    host.ACTIVE_DOWNLOADS.set("a", new Set([{ item: { cancel }, finished: false, done }]));
    host.ACTIVE_DOWNLOADS.set("b", new Set([{ item: { cancel: otherCancel }, finished: false, done: Promise.resolve() }]));
    let drained = false;
    const closing = host.closeTab({ ...owner, tabId: "a" }).then(() => { drained = true; });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(otherCancel).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(present ? 1 : 0);
    expect(close).not.toHaveBeenCalled();
    expect(drained).toBe(false);
    expect(storage.flushStorageData).not.toHaveBeenCalled();
    finishDownload();
    await closing;
    expect(storage.flushStorageData).toHaveBeenCalledOnce();
    expect(storage.cookies.flushStore).toHaveBeenCalledOnce();
    expect(storage.clearStorageData).not.toHaveBeenCalled();
    expect(host.TABS.has("a")).toBe(false);
  });
});
