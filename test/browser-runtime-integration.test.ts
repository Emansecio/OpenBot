import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../src/config/store.js";
import { BrowserSessionManager, type BrowserHostProcess } from "../src/browser/browser-session-manager.js";
import { encodeBrowserFrame } from "../src/browser/protocol.js";
import type {
  AgentRuntimeManager,
  RuntimeCapability,
  RuntimeLease,
  RuntimeMode,
  RuntimeStatus,
  StopReason,
} from "../src/execution/runtime/contracts.js";
import { defaultBrowserRoot, startServer, stopServer, type ServerHandle } from "../src/main.js";

class FakeBrowserHost implements BrowserHostProcess {
  readonly stdout = new PassThrough();
  readonly requests: Array<Record<string, unknown>> = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
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
          visible: command.command === "handoff" || command.command === "open",
        },
      })));
      callback();
    },
    final: (callback) => {
      queueMicrotask(() => {
        this.exited = true;
        for (const listener of this.exitListeners) listener(0, null);
      });
      callback();
    },
  });
  killed = false;
  exited = false;
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  constructor() {
    queueMicrotask(() => this.stdout.write(encodeBrowserFrame({ protocolVersion: 1, kind: "ready", hostVersion: "test" })));
  }

  kill(): void {
    this.killed = true;
    for (const listener of this.exitListeners) listener(0, null);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }
}

class FakeRuntimeManager implements AgentRuntimeManager {
  async ensure(agentId: string, mode: RuntimeMode): Promise<RuntimeStatus> {
    return this.status(agentId, mode);
  }

  async acquire(_agentId: string, _capability: RuntimeCapability): Promise<RuntimeLease> {
    throw new Error("runtime is not part of this browser integration test");
  }

  async status(agentId: string, mode: RuntimeMode = "lite"): Promise<RuntimeStatus> {
    return {
      agentId,
      mode,
      state: "lite-ready",
      runtimeVersion: null,
      imageDigest: null,
      runtimeBootId: null,
      activeLeaseCount: 0,
      activeProcessCount: 0,
      lastActivityAt: null,
      lastError: null,
    };
  }

  async stop(agentId: string, _reason: StopReason): Promise<RuntimeStatus> {
    return this.status(agentId);
  }

  async repair(agentId: string): Promise<RuntimeStatus> {
    return this.status(agentId);
  }

  async close(): Promise<void> {}
}

const dirs: string[] = [];
const handles: ServerHandle[] = [];
const managers: BrowserSessionManager[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; configPath: string; workspacesRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "openbot-browser-runtime-"));
  dirs.push(root);
  const configPath = join(root, "config.json");
  const config = new ConfigStore({ configPath });
  config.update({ agents: [{ id: "browser-agent", name: "Browser Agent", avatarId: "browser-agent" }] });
  config.close();
  return { root, configPath, workspacesRoot: join(root, "workspaces") };
}

describe("browser runtime composition", () => {
  it("keeps the browser host lazy, wraps the per-agent runtime backend, and closes the shared host", async () => {
    const { root, configPath, workspacesRoot } = await fixture();
    let host: FakeBrowserHost | undefined;
    let launchOptions: { userDataRoot: string; downloadsRoot: string } | undefined;
    const manager = new BrowserSessionManager({
      downloadsRoot: root,
      userDataRoot: join(root, "browser-profiles"),
      resolveDownloadRoot: (agentId) => join(workspacesRoot, agentId, "Downloads"),
      launchHost: (options) => {
        launchOptions = { userDataRoot: options.userDataRoot, downloadsRoot: options.downloadsRoot };
        host = new FakeBrowserHost();
        return host;
      },
    });
    managers.push(manager);

    const handle = await startServer(0, {
      configPath,
      workspacesRoot,
      storePath: join(root, "store.db"),
      keystoreDir: join(root, "keys"),
      allowUnauthenticatedLocalGateway: true,
      runtimeManager: new FakeRuntimeManager(),
      browserSessionManager: manager,
    });
    handles.push(handle);

    expect(handle.browserSessionManager).toBe(manager);
    expect(manager.hostRunning).toBe(false);
    expect(host).toBeUndefined();

    const result = await handle.executionBroker!.execute("browser-agent", "browser-1", {
      operation: "browser.open",
      url: "https://example.com/",
    });
    expect(result).toMatchObject({ ok: true, operation: "browser.open", command: "open", visible: true });
    expect(manager.hostRunning).toBe(true);
    expect(launchOptions?.userDataRoot).toBe(join(root, "browser-profiles"));
    expect(host?.requests[0]?.downloadRoot).toBe(join(workspacesRoot, "browser-agent", "Downloads"));
    expect(host?.requests[0]?.partition).toMatch(/^persist:openbot-agent-[a-f0-9]{32}$/u);

    await stopServer(handle);
    handles.splice(handles.indexOf(handle), 1);
    expect(manager.hostRunning).toBe(false);
    expect(host?.exited).toBe(true);
    expect(host?.killed).toBe(false);
  });

  it("creates only managed browser state beside the workspace root on normal boot", async () => {
    const { root, configPath, workspacesRoot } = await fixture();
    const handle = await startServer(0, {
      configPath,
      workspacesRoot,
      storePath: join(root, "store.db"),
      keystoreDir: join(root, "keys"),
      allowUnauthenticatedLocalGateway: true,
      runtimeManager: new FakeRuntimeManager(),
    });
    handles.push(handle);

    expect(handle.browserSessionManager).toBeDefined();
    expect(handle.browserSessionManager?.hostRunning).toBe(false);
    expect(defaultBrowserRoot(workspacesRoot)).toBe(join(root, "browser"));
    await expect(stat(defaultBrowserRoot(workspacesRoot))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("passes the exact workspace containment root and sibling Electron userData root", async () => {
    const { root, configPath, workspacesRoot } = await fixture();
    const launchOptions: Array<{ userDataRoot: string; downloadsRoot: string }> = [];
    let host: FakeBrowserHost | undefined;
    const handle = await startServer(0, {
      configPath,
      workspacesRoot,
      storePath: join(root, "store.db"),
      keystoreDir: join(root, "keys"),
      allowUnauthenticatedLocalGateway: true,
      runtimeManager: new FakeRuntimeManager(),
      browserOptions: {
        launchHost: (options) => {
          launchOptions.push({ userDataRoot: options.userDataRoot, downloadsRoot: options.downloadsRoot });
          host = new FakeBrowserHost();
          return host;
        },
      },
    });
    handles.push(handle);

    await handle.executionBroker!.execute("browser-agent", "browser-2", {
      operation: "browser.open",
      url: "https://example.com/",
    });
    expect(launchOptions).toEqual([{ userDataRoot: defaultBrowserRoot(workspacesRoot), downloadsRoot: workspacesRoot }]);
    expect(isAbsolute(launchOptions[0]!.userDataRoot)).toBe(true);
    expect(relative(workspacesRoot, launchOptions[0]!.userDataRoot).startsWith("..")).toBe(true);
    expect(host?.requests[0]?.downloadRoot).toBe(join(workspacesRoot, "browser-agent", "Downloads"));
    expect(host?.requests[0]?.homeRoot).toBe(join(workspacesRoot, "browser-agent"));
    expect(host).toBeDefined();
  });
});
