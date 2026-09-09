import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserHostError,
  BrowserSessionManager,
  buildBrowserHostEnvironment,
  hashAgentId,
  waitForBrowserCommandPipe,
  type BrowserHostProcess,
} from "../src/browser/browser-session-manager.js";
import { encodeBrowserFrame } from "../src/browser/protocol.js";

describe("browser host environment", () => {
  it("encaminha somente variáveis operacionais e remove segredos arbitrários do processo pai", () => {
    const environment = buildBrowserHostEnvironment({
      authToken: "browser-auth",
      commandPipe: "\\\\.\\pipe\\openbot-browser-test",
      downloadsRoot: "C:\\OpenBot\\workspaces",
      maxDownloadBytes: 1_024,
      proxyToken: "proxy-auth",
      proxyUrl: "http://127.0.0.1:19000",
      userDataRoot: "C:\\OpenBot\\browser",
    }, {
      SystemRoot: "C:\\Windows",
      Path: "C:\\Windows\\System32",
      TEMP: "C:\\Temp",
      OPENAI_API_KEY: "sk-secret",
      GITHUB_TOKEN: "gh-secret",
      UNRELATED_VALUE: "private",
      ELECTRON_RUN_AS_NODE: "1",
    });

    expect(environment).toMatchObject({
      SystemRoot: "C:\\Windows",
      Path: "C:\\Windows\\System32",
      TEMP: "C:\\Temp",
      OPENBOT_BROWSER_AUTH_TOKEN: "browser-auth",
      OPENBOT_BROWSER_COMMAND_PIPE: "\\\\.\\pipe\\openbot-browser-test",
      OPENBOT_BROWSER_PROXY_TOKEN: "proxy-auth",
    });
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(environment).not.toHaveProperty("UNRELATED_VALUE");
    expect(environment).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
  });
});

class FakeBrowserHost implements BrowserHostProcess {
  readonly stdout = new PassThrough();
  readonly requests: Array<Record<string, unknown>> = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
      this.requests.push(request);
      const command = request.command as Record<string, unknown>;
      const result = {
        command: command.command,
        tabId: request.tabId,
        url: typeof command.url === "string" ? command.url : "https://example.com/",
        title: "Example",
        visible: command.command === "handoff" || command.command === "open" ? true : undefined,
      };
      queueMicrotask(() => this.stdout.write(encodeBrowserFrame({ protocolVersion: 1, kind: "response", id: request.id, ok: true, result })));
      callback();
    },
    final: (callback) => {
      this.exit();
      callback();
    },
  });
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  killed = false;
  private exited = false;

  constructor(prefixBlankLine = false) {
    queueMicrotask(() => {
      if (prefixBlankLine) this.stdout.write("\r\n");
      this.stdout.write(encodeBrowserFrame({ protocolVersion: 1, kind: "ready", hostVersion: "test" }));
    });
  }

  kill(): void {
    this.killed = true;
    this.exit();
  }

  private exit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(0, null);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }
}

class TimeoutCloseHost implements BrowserHostProcess {
  readonly stdout = new PassThrough();
  readonly requests: Array<Record<string, unknown>> = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
      this.requests.push(request);
      const command = request.command as Record<string, unknown>;
      if (command.command === "close") {
        callback();
        return;
      }
      const result = {
        command: command.command,
        tabId: request.tabId,
        url: typeof command.url === "string" ? command.url : "https://example.com/",
        title: "Example",
        visible: command.command === "handoff" || command.command === "open" ? true : undefined,
      };
      queueMicrotask(() => this.stdout.write(encodeBrowserFrame({ protocolVersion: 1, kind: "response", id: request.id, ok: true, result })));
      callback();
    },
  });
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  constructor() {
    queueMicrotask(() => {
      this.stdout.write(encodeBrowserFrame({ protocolVersion: 1, kind: "ready", hostVersion: "test" }));
    });
  }

  kill(): void {
    for (const listener of this.exitListeners) listener(0, null);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }
}

class BlockingFirstCloseHost implements BrowserHostProcess {
  readonly stdout = new PassThrough();
  readonly requests: Array<Record<string, unknown>> = [];
  private blockedClose: Record<string, unknown> | undefined;
  private shouldBlockClose = true;
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
      this.requests.push(request);
      const command = request.command as Record<string, unknown>;
      if (command.command === "close" && this.shouldBlockClose) {
        this.shouldBlockClose = false;
        this.blockedClose = request;
        callback();
        return;
      }
      this.respond(request);
      callback();
    },
    final: (callback) => {
      this.exit();
      callback();
    },
  });
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private exited = false;

  constructor() {
    queueMicrotask(() => this.stdout.write(encodeBrowserFrame({ protocolVersion: 1, kind: "ready", hostVersion: "test" })));
  }

  finishBlockedClose(): void {
    const request = this.blockedClose;
    if (request === undefined) throw new Error("no blocked close request");
    this.blockedClose = undefined;
    this.respond(request);
  }

  kill(): void {
    this.exit();
  }

  private exit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(0, null);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }

  private respond(request: Record<string, unknown>): void {
    const command = request.command as Record<string, unknown>;
    queueMicrotask(() => this.stdout.write(encodeBrowserFrame({
      protocolVersion: 1,
      kind: "response",
      id: request.id,
      ok: true,
      result: {
        command: command.command,
        tabId: request.tabId,
        url: typeof command.url === "string" ? command.url : "https://example.com/",
        title: "Example",
        visible: command.command === "open" || command.command === "handoff",
      },
    })));
  }
}

class DelayedBrowserHost implements BrowserHostProcess {
  readonly stdout = new PassThrough();
  readonly requests: Array<Record<string, unknown>> = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
      this.requests.push(request);
      const command = request.command as Record<string, unknown>;
      if (command.command === "cancel" || command.command === "close") {
        queueMicrotask(() => this.stdout.write(encodeBrowserFrame({
          protocolVersion: 1,
          kind: "response",
          id: request.id,
          ok: true,
          result: { command: command.command, tabId: request.tabId, visible: false },
        })));
      }
      callback();
    },
    final: (callback) => {
      this.exit();
      callback();
    },
  });
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private exited = false;

  constructor() {
    queueMicrotask(() => this.stdout.write(encodeBrowserFrame({ protocolVersion: 1, kind: "ready", hostVersion: "test" })));
  }

  kill(): void {
    this.exit();
  }

  private exit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(0, null);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }
}

class TeardownRaceBrowserHost implements BrowserHostProcess {
  readonly stdout = new PassThrough();
  readonly requests: Array<Record<string, unknown>> = [];
  readonly stdin = {
    write: (chunk: string): boolean => {
      const request = JSON.parse(chunk) as Record<string, unknown>;
      this.requests.push(request);
      const command = request.command as Record<string, unknown>;
      queueMicrotask(() => this.stdout.write(encodeBrowserFrame({
        protocolVersion: 1,
        kind: "response",
        id: request.id,
        ok: true,
        result: {
          command: command.command,
          tabId: request.tabId,
          url: typeof command.url === "string" ? command.url : "https://example.com/",
          title: "Example",
          visible: command.command === "open" || command.command === "handoff",
        },
      })));
      return true;
    },
    end: (): void => {
      this.endCalled = true;
      if (this.exitOnEnd) this.exit();
    },
  };
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  endCalled = false;
  killed = false;
  private exited = false;

  constructor(private readonly exitOnEnd = false) {
    queueMicrotask(() => this.stdout.write(encodeBrowserFrame({ protocolVersion: 1, kind: "ready", hostVersion: "test" })));
  }

  exit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(0, null);
  }

  kill(): void {
    this.killed = true;
    this.exit();
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }
}

class LateExitBrowserHost extends TeardownRaceBrowserHost {
  override kill(): void {
    this.killed = true;
  }
}

const hosts: FakeBrowserHost[] = [];
const managers: BrowserSessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  hosts.splice(0);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("BrowserSessionManager", () => {
  it("ignores Electron's leading blank stdout line before the ready frame", async () => {
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      launchHost: () => new FakeBrowserHost(true),
    });
    managers.push(manager);
    const lease = await manager.acquire("agent-a");
    await expect(manager.open(lease, "https://example.com/")).resolves.toMatchObject({ command: "open" });
  });

  it("accepts an absolute packaged Electron path from the environment", async () => {
    vi.stubEnv("OPENBOT_BROWSER_ELECTRON_PATH", process.execPath);
    let electronPath = "";
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      launchHost: (options) => {
        electronPath = options.electronPath;
        const host = new FakeBrowserHost();
        hosts.push(host);
        return host;
      },
    });
    managers.push(manager);
    const lease = await manager.acquire("agent-env");
    await manager.open(lease, "https://example.com/");
    expect(electronPath).toBe(resolve(process.execPath));
  });

  it("lazily launches one authenticated host and derives persistent per-agent state", async () => {
    let launches = 0;
    let electronPath = "";
    let authToken = "";
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      launchHost: (options) => {
        launches += 1;
        electronPath = options.electronPath;
        authToken = options.authToken;
        const host = new FakeBrowserHost();
        hosts.push(host);
        return host;
      },
    });
    managers.push(manager);
    const lease = await manager.acquire("agent/one", { sessionId: "session-1" });
    const nextLease = await manager.acquire("agent/one", { sessionId: "session-2" });
    expect(launches).toBe(0);
    expect(lease.partition).toMatch(/^persist:openbot-agent-[a-f0-9]{32}$/u);
    expect(lease.downloadRoot).toContain("downloads");
    expect(nextLease).toMatchObject({
      agentId: lease.agentId,
      partition: lease.partition,
      downloadRoot: lease.downloadRoot,
    });
    expect(nextLease.leaseId).not.toBe(lease.leaseId);
    await manager.open(lease, "https://example.com/");
    await manager.navigate(nextLease, "https://example.com/next");
    expect(launches).toBe(1);
    expect(electronPath.replaceAll("\\", "/")).toMatch(/\/node_modules\/electron\/cli\.js$/u);
    expect(hosts[0]?.requests).toHaveLength(2);
    expect(authToken).toMatch(/^[a-f0-9]{64}$/u);
    expect(hosts[0]?.requests.map((request) => request.token)).toEqual([authToken, authToken]);
    expect(hosts[0]?.requests.map((request) => request.partition)).toEqual([lease.partition, lease.partition]);
    expect(JSON.stringify(hosts[0]?.requests[0])).not.toContain("OPENBOT_BROWSER_AUTH_TOKEN");
  });

  it("tears down only the owning agent and never exposes a CDP endpoint", async () => {
    let host: FakeBrowserHost | undefined;
    let launchOptions: Record<string, unknown> | undefined;
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      launchHost: (options) => {
        launchOptions = options as unknown as Record<string, unknown>;
        host = new FakeBrowserHost();
        hosts.push(host);
        return host;
      },
    });
    managers.push(manager);
    const first = await manager.acquire("agent-a");
    const second = await manager.acquire("agent-b");
    await manager.handoff(first);
    await manager.handoff(second);
    await manager.teardownAgent("agent-a");
    expect(manager.activeLeaseCount).toBe(1);
    expect(host?.requests.filter((request) => (request.command as Record<string, unknown>).command === "close")).toHaveLength(1);
    expect(host?.requests.filter((request) => (request.command as Record<string, unknown>).command === "reset")).toHaveLength(1);
    expect(Object.keys(launchOptions ?? {}).sort()).toEqual([
      "authToken",
      "downloadsRoot",
      "electronPath",
      "hostPath",
      "maxDownloadBytes",
      "proxyToken",
      "proxyUrl",
      "userDataRoot",
    ]);
    expect(JSON.stringify({ launchOptions, requests: host?.requests })).not.toMatch(/cdp|remoteDebugging|debuggerAddress/iu);
  });

  it("rejects expired leases and closes the host idempotently", async () => {
    let now = 10_000;
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      leaseTtlMs: 1_000,
      now: () => now,
      launchHost: () => {
        const host = new FakeBrowserHost();
        hosts.push(host);
        return host;
      },
    });
    managers.push(manager);
    const lease = await manager.acquire("agent-a");
    now += 1_001;
    await expect(manager.snapshot(lease)).rejects.toMatchObject({ code: "BROWSER_LEASE_EXPIRED" } satisfies Partial<BrowserHostError>);
    await manager.close();
    await manager.close();
    expect(manager.hostRunning).toBe(false);
  });

  it("closes an expired tab before discarding its lease", async () => {
    let now = 10_000;
    let host: FakeBrowserHost | undefined;
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      leaseTtlMs: 1_000,
      now: () => now,
      launchHost: () => {
        host = new FakeBrowserHost();
        hosts.push(host);
        return host;
      },
    });
    managers.push(manager);
    const lease = await manager.acquire("agent-a");
    await manager.open(lease, "https://example.com/");
    now += 1_001;

    await expect(manager.snapshot(lease)).rejects.toMatchObject({ code: "BROWSER_LEASE_EXPIRED" } satisfies Partial<BrowserHostError>);
    expect(host?.requests.map((request) => (request.command as Record<string, unknown>).command)).toEqual(["open", "close"]);
    expect(manager.activeLeaseCount).toBe(0);
    expect(manager.hostRunning).toBe(false);
  });

  it("keeps the shared host and other agents alive when one lease expires", async () => {
    let now = 10_000;
    let host: FakeBrowserHost | undefined;
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      leaseTtlMs: 1_000,
      now: () => now,
      launchHost: () => {
        host = new FakeBrowserHost();
        hosts.push(host);
        return host;
      },
    });
    managers.push(manager);
    const expired = await manager.acquire("agent-a");
    const survivor = await manager.acquire("agent-b", { ttlMs: 2_000 });
    await manager.open(expired, "https://example.com/expired");
    await manager.open(survivor, "https://example.com/survivor");
    now += 1_001;

    await expect(manager.snapshot(expired)).rejects.toMatchObject({ code: "BROWSER_LEASE_EXPIRED" } satisfies Partial<BrowserHostError>);
    await expect(manager.snapshot(survivor)).resolves.toMatchObject({ command: "snapshot" });
    expect(host?.requests.map((request) => (request.command as Record<string, unknown>).command)).toEqual(["open", "open", "close", "snapshot"]);
    expect(manager.activeLeaseCount).toBe(1);
    expect(manager.hostRunning).toBe(true);
  });

  it("faz reset da partição quando o close expira mas outro agente ainda usa o host", async () => {
    let host: TimeoutCloseHost | undefined;
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      commandTimeoutMs: 50,
      launchHost: () => {
        host = new TimeoutCloseHost();
        return host;
      },
    });
    managers.push(manager);
    const first = await manager.acquire("agent-a");
    const second = await manager.acquire("agent-b");
    await manager.open(first, "https://example.com/a");
    await manager.open(second, "https://example.com/b");

    await expect(manager.release(first)).resolves.toBeUndefined();
    await expect(manager.snapshot(second)).resolves.toMatchObject({ command: "snapshot" });
    expect(host?.requests.map((request) => (request.command as Record<string, unknown>).command)).toEqual([
      "open",
      "open",
      "close",
      "cancel",
      "reset",
      "snapshot",
    ]);
    expect(manager.activeLeaseCount).toBe(1);
    expect(manager.hostRunning).toBe(true);
  });

  it("encerra o host quando o close da última lease expira", async () => {
    let host: TimeoutCloseHost | undefined;
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      commandTimeoutMs: 50,
      launchHost: () => {
        host = new TimeoutCloseHost();
        return host;
      },
    });
    managers.push(manager);
    const lease = await manager.acquire("agent-a");
    await manager.open(lease, "https://example.com/a");

    await expect(manager.release(lease)).resolves.toBeUndefined();
    expect(host?.requests.map((request) => (request.command as Record<string, unknown>).command)).toEqual([
      "open",
      "close",
      "cancel",
    ]);
    expect(manager.activeLeaseCount).toBe(0);
    expect(manager.hostRunning).toBe(false);
  });

  it("removes a persisted partition directly when no host is running", async () => {
    const root = join(tmpdir(), `openbot-browser-manager-${Date.now()}`);
    mkdirSync(join(root, "workspaces", "agent-a", "Downloads"), { recursive: true });
    const partitionRoot = join(root, "profiles", "Partitions", `openbot-agent-${hashAgentId("agent-a")}`);
    mkdirSync(partitionRoot, { recursive: true });
    const manager = new BrowserSessionManager({
      downloadsRoot: join(root, "workspaces"),
      userDataRoot: join(root, "profiles"),
      resolveDownloadRoot: () => join(root, "workspaces", "agent-a", "Downloads"),
      launchHost: () => new FakeBrowserHost(),
    });
    managers.push(manager);
    await manager.teardownAgent("agent-a");
    expect(existsSync(partitionRoot)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("purges Chromium cache after the last lease stops the host and keeps cookies", async () => {
    const root = join(tmpdir(), `openbot-browser-cache-${Date.now()}`);
    mkdirSync(join(root, "workspaces", "agent-a", "Downloads"), { recursive: true });
    const partitionRoot = join(root, "profiles", "Partitions", `openbot-agent-${hashAgentId("agent-a")}`);
    mkdirSync(join(partitionRoot, "Cache"), { recursive: true });
    writeFileSync(join(partitionRoot, "Cache", "data"), "cached");
    writeFileSync(join(partitionRoot, "Cookies"), "keep");
    const manager = new BrowserSessionManager({
      downloadsRoot: join(root, "workspaces"),
      userDataRoot: join(root, "profiles"),
      resolveDownloadRoot: () => join(root, "workspaces", "agent-a", "Downloads"),
      launchHost: () => new FakeBrowserHost(),
    });
    managers.push(manager);
    const lease = await manager.acquire("agent-a");
    await manager.open(lease, "https://example.com/a");
    await manager.release(lease);
    expect(manager.hostRunning).toBe(false);
    await vi.waitFor(() => expect(existsSync(join(partitionRoot, "Cache"))).toBe(false));
    expect(existsSync(join(partitionRoot, "Cookies"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("cancels an in-flight host request without waiting for its response", async () => {
    const host = new DelayedBrowserHost();
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      launchHost: () => host,
      commandTimeoutMs: 1_000,
    });
    managers.push(manager);
    const lease = await manager.acquire("agent-a");
    const controller = new AbortController();
    const pending = manager.execute(lease, { command: "navigate", url: "https://example.com/slow" }, controller.signal);
    await vi.waitFor(() => expect(host.requests).toHaveLength(1));

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "BROWSER_COMMAND_ABORTED" } satisfies Partial<BrowserHostError>);
    await vi.waitFor(() => expect(host.requests).toHaveLength(2));
    expect(host.requests[1]?.command).toMatchObject({ command: "cancel" });
    expect(host.requests[1]?.command).toMatchObject({ targetId: host.requests[0]?.id });
  });

  it("cancela close em andamento usando o mesmo AbortSignal", async () => {
    const host = new TimeoutCloseHost();
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      launchHost: () => host,
      commandTimeoutMs: 50,
    });
    managers.push(manager);
    const closing = await manager.acquire("agent-a");
    await manager.acquire("agent-b");
    await manager.open(closing, "https://example.com/");
    const controller = new AbortController();
    const pending = manager.execute(closing, { command: "close" }, controller.signal);
    await vi.waitFor(() => expect(host.requests.some((request) =>
      (request.command as Record<string, unknown>).command === "close")).toBe(true));

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "BROWSER_COMMAND_ABORTED" } satisfies Partial<BrowserHostError>);
    expect(manager.hasLease(closing)).toBe(false);
  });

  it("does not acquire a new lease through a host pipe while the last host tears down", async () => {
    const launched: TeardownRaceBrowserHost[] = [];
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      launchHost: () => {
        const host = new TeardownRaceBrowserHost(launched.length > 0);
        launched.push(host);
        return host;
      },
      commandTimeoutMs: 1_000,
    });
    managers.push(manager);
    const first = await manager.acquire("agent-a");
    await manager.open(first, "https://example.com/first");

    const releasing = manager.release(first);
    await vi.waitFor(() => expect(launched[0]?.endCalled).toBe(true));

    let acquired = false;
    const secondPromise = manager.acquire("agent-b").then((lease) => {
      acquired = true;
      return lease;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquired).toBe(false);

    launched[0]?.exit();
    await releasing;
    const second = await secondPromise;
    await manager.open(second, "https://example.com/second");
    expect(launched).toHaveLength(2);
  });

  it("não declara teardown concluído sem prova de saída do host antigo", async () => {
    const oldHost = new LateExitBrowserHost();
    const newHost = new FakeBrowserHost();
    let launches = 0;
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      commandTimeoutMs: 10,
      launchHost: () => launches++ === 0 ? oldHost : newHost,
    });
    managers.push(manager);
    const first = await manager.acquire("agent-a");
    await manager.open(first, "https://example.com/first");

    vi.useFakeTimers();
    const releasing = manager.release(first);
    const rejection = expect(releasing).rejects.toMatchObject({
      code: "BROWSER_HOST_TEARDOWN_TIMEOUT",
    } satisfies Partial<BrowserHostError>);
    await vi.waitFor(() => expect(oldHost.endCalled).toBe(true));
    await vi.advanceTimersByTimeAsync(1_100);
    await rejection;
    expect(oldHost.endCalled).toBe(true);
    expect(oldHost.killed).toBe(true);
    vi.useRealTimers();

    const second = await manager.acquire("agent-b");
    await manager.open(second, "https://example.com/second");
    oldHost.exit();

    expect(manager.activeLeaseCount).toBe(1);
    await expect(manager.snapshot(second)).resolves.toMatchObject({ command: "snapshot" });
    await manager.close();
  });

  it("rechecks teardown after asynchronous lease-root resolution", async () => {
    const launched: TeardownRaceBrowserHost[] = [];
    let releaseAgentBRoot!: () => void;
    const agentBRoot = new Promise<void>((resolve) => {
      releaseAgentBRoot = resolve;
    });
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      resolveDownloadRoot: async (agentId) => {
        if (agentId === "agent-b") await agentBRoot;
        return `C:\\Temp\\OpenBot\\downloads\\${agentId}\\Downloads`;
      },
      launchHost: () => {
        const host = new TeardownRaceBrowserHost();
        launched.push(host);
        return host;
      },
      commandTimeoutMs: 1_000,
    });
    managers.push(manager);
    const first = await manager.acquire("agent-a");
    await manager.open(first, "https://example.com/first");

    let acquired = false;
    const secondPromise = manager.acquire("agent-b").then((lease) => {
      acquired = true;
      return lease;
    });
    const releasing = manager.release(first);
    await vi.waitFor(() => expect(launched[0]?.endCalled).toBe(true));
    releaseAgentBRoot();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(acquired).toBe(false);

    launched[0]?.exit();
    await releasing;
    await expect(secondPromise).resolves.toMatchObject({ agentId: "agent-b" });
  });

  it("não publica uma nova lease do agente enquanto o teardown anterior ainda apaga seu perfil", async () => {
    const host = new BlockingFirstCloseHost();
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      launchHost: () => host,
      commandTimeoutMs: 1_000,
    });
    managers.push(manager);
    const oldLease = await manager.acquire("agent-a");
    const survivor = await manager.acquire("agent-b");
    await manager.open(oldLease, "https://example.com/old");
    await manager.open(survivor, "https://example.com/survivor");

    const teardown = manager.teardownAgent("agent-a");
    await vi.waitFor(() => expect(host.requests.some((request) =>
      (request.command as Record<string, unknown>).command === "close")).toBe(true));

    let acquired = false;
    const nextLease = manager.acquire("agent-a").then((lease) => {
      acquired = true;
      return lease;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquired).toBe(false);

    host.finishBlockedClose();
    await teardown;
    await expect(nextLease).resolves.toMatchObject({ agentId: "agent-a" });
    expect(host.requests.map((request) => (request.command as Record<string, unknown>).command)).toContain("reset");
    expect(manager.activeLeaseCount).toBe(2);
  });

  it("sweeps expired leases on the clock and clears its timer after the host stops", async () => {
    vi.useFakeTimers();
    let now = 10_000;
    const host = new FakeBrowserHost();
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      leaseTtlMs: 1_000,
      now: () => now,
      launchHost: () => host,
    });
    managers.push(manager);
    const lease = await manager.acquire("agent-a");
    await manager.open(lease, "https://example.com/");

    now += 1_000;
    await vi.advanceTimersByTimeAsync(4_000);

    expect(manager.activeLeaseCount).toBe(0);
    expect(manager.hostRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("bounds pending commands per agent instead of buffering unbounded stdin work", async () => {
    const host = new DelayedBrowserHost();
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      maxPendingRequests: 1,
      maxPendingPerAgent: 1,
      launchHost: () => host,
    });
    managers.push(manager);
    const lease = await manager.acquire("agent-a");
    const first = manager.execute(lease, { command: "navigate", url: "https://example.com/one" });
    await vi.waitFor(() => expect(host.requests).toHaveLength(1));

    await expect(manager.execute(lease, { command: "navigate", url: "https://example.com/two" })).rejects.toMatchObject({
      code: "BROWSER_PENDING_LIMIT",
    });

    await manager.close();
    await expect(first).rejects.toMatchObject({ code: "BROWSER_HOST_EXITED" });
  });

  it("reserves pending capacity while the shared host is still starting", async () => {
    const host = new FakeBrowserHost();
    let markLaunchStarted!: () => void;
    const launchStarted = new Promise<void>((resolve) => {
      markLaunchStarted = resolve;
    });
    let releaseHost!: (value: BrowserHostProcess) => void;
    const hostReady = new Promise<BrowserHostProcess>((resolve) => {
      releaseHost = resolve;
    });
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      maxPendingRequests: 1,
      maxPendingPerAgent: 1,
      launchHost: () => {
        markLaunchStarted();
        return hostReady;
      },
    });
    managers.push(manager);
    const lease = await manager.acquire("agent-a");
    const first = manager.open(lease, "https://example.com/first");
    await launchStarted;

    const second = manager.open(lease, "https://example.com/second");
    await expect(second).rejects.toMatchObject({
      code: "BROWSER_PENDING_LIMIT",
    } satisfies Partial<BrowserHostError>);

    releaseHost(host);
    await expect(first).resolves.toMatchObject({ command: "open" });
  });

  it("libera a capacidade reservada quando o chamador aborta durante o startup", async () => {
    const host = new FakeBrowserHost();
    let markLaunchStarted!: () => void;
    const launchStarted = new Promise<void>((resolve) => { markLaunchStarted = resolve; });
    let releaseHost!: (value: BrowserHostProcess) => void;
    const hostReady = new Promise<BrowserHostProcess>((resolve) => { releaseHost = resolve; });
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      maxPendingRequests: 1,
      maxPendingPerAgent: 1,
      launchHost: () => {
        markLaunchStarted();
        return hostReady;
      },
    });
    managers.push(manager);
    const lease = await manager.acquire("agent-a");
    const controller = new AbortController();
    const first = manager.open(lease, "https://example.com/aborted", controller.signal);
    await launchStarted;
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: "BROWSER_COMMAND_ABORTED" } satisfies Partial<BrowserHostError>);

    const second = manager.open(lease, "https://example.com/survivor");
    const beforeHostReady = await Promise.race([
      second.then(() => "resolved" as const, (error: BrowserHostError) => error.code),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 10)),
    ]);
    expect(beforeHostReady).toBe("pending");

    releaseHost(host);
    await expect(second).resolves.toMatchObject({ command: "open" });
  });

  it("releases the shared write tail when stdin never drains", async () => {
    let backpressured = true;
    let drainListener: (() => void) | undefined;
    const process = {
      stdin: {
        write: () => !backpressured,
        end: () => undefined,
        once: (_event: "drain", listener: () => void) => { drainListener = listener; },
        removeListener: (_event: "drain", listener: () => void) => {
          if (drainListener === listener) drainListener = undefined;
        },
      },
      stdout: new PassThrough(),
      kill: () => undefined,
      onExit: () => undefined,
    };
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      commandTimeoutMs: 10,
      launchHost: () => process,
    });
    const harness = manager as unknown as {
      writeFrame(host: { process: typeof process; writeTail: Promise<void> }, frame: string): Promise<void>;
    };
    const host = { process, writeTail: Promise.resolve() };

    await expect(harness.writeFrame(host, "first")).rejects.toMatchObject({ code: "BROWSER_COMMAND_TIMEOUT" });
    expect(drainListener).toBeUndefined();
    backpressured = false;
    await expect(harness.writeFrame(host, "second")).resolves.toBeUndefined();
    await manager.close();
  });

  it("releases a reserved pending slot when host startup fails", async () => {
    let launches = 0;
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      maxPendingRequests: 1,
      maxPendingPerAgent: 1,
      launchHost: () => {
        launches += 1;
        if (launches === 1) return Promise.reject(new Error("host startup failed"));
        return new FakeBrowserHost();
      },
    });
    managers.push(manager);
    const lease = await manager.acquire("agent-a");

    await expect(manager.open(lease, "https://example.com/failed")).rejects.toThrow("host startup failed");
    await expect(manager.open(lease, "https://example.com/retry")).resolves.toMatchObject({ command: "open" });
    expect(launches).toBe(2);
  });
});

describe("browser host command pipe timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels the launch timeout when the named pipe connects early", async () => {
    vi.useFakeTimers();
    const connection = Promise.resolve("connected");

    await expect(waitForBrowserCommandPipe(connection)).resolves.toBe("connected");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the launch timeout when the named pipe aborts", async () => {
    vi.useFakeTimers();
    const error = new Error("pipe closed");
    let rejectConnection!: (reason: Error) => void;
    const connection = new Promise<never>((_, reject) => {
      rejectConnection = reject;
    });
    const pending = waitForBrowserCommandPipe(connection);

    rejectConnection(error);
    await expect(pending).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the 15-second launch timeout", async () => {
    vi.useFakeTimers();
    const connection = new Promise<never>(() => undefined);
    const pending = waitForBrowserCommandPipe(connection);
    const rejection = expect(pending).rejects.toMatchObject({
      code: "BROWSER_HOST_LAUNCH_FAILED",
      message: "browser host command pipe timed out",
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});
