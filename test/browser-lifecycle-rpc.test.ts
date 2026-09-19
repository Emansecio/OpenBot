import { existsSync, mkdtempSync, promises as fsp, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { registerRpcHandlers, type BrowserAgentLifecycle } from "../src/rpc/index.js";
import { ConfigStore } from "../src/config/store.js";
import { createGateway } from "../src/server/gateway.js";
import { SqliteTranscriptStore } from "../src/store/index.js";

const handles: ServerHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(browserLifecycle: BrowserAgentLifecycle) {
  const dir = mkdtempSync(join(tmpdir(), "openbot-browser-lifecycle-rpc-"));
  dirs.push(dir);
  const handle = await startServer(0, {
    configPath: join(dir, "config.json"),
    stateRoot: join(dir, "state"),
    runtimeRoot: join(dir, "runtime"),
    browserRoot: join(dir, "browser"),
    allowUnauthenticatedLocalGateway: true,
    keystoreDir: join(dir, "keys"),
    storePath: join(dir, "store.db"),
    workspacesRoot: join(dir, "workspaces"),
    browserLifecycle,
  });
  handles.push(handle);
  return handle;
}

async function post(handle: ServerHandle, method: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as { ok: boolean; value?: unknown; failure?: string } };
}

describe("deleteAgents browser lifecycle", () => {
  it("tears down before commit and purges only after removing the home", async () => {
    const observations: Array<{ phase: "teardown" | "purge"; agentId: string; homeExists: boolean }> = [];
    let handle!: ServerHandle;
    const browserLifecycle: BrowserAgentLifecycle = {
      async teardownAgent(agentId) {
        observations.push({ phase: "teardown", agentId, homeExists: existsSync(handle.homes!.pathFor(agentId)) });
      },
      async purgeAgent(agentId) {
        observations.push({ phase: "purge", agentId, homeExists: existsSync(handle.homes!.pathFor(agentId)) });
      },
    };
    handle = await boot(browserLifecycle);
    for (const id of ["browser-victim-a", "browser-victim-b"]) {
      const created = await post(handle, "createAgent", { id, name: id });
      expect(created.status).toBe(200);
    }
    const homes = ["browser-victim-a", "browser-victim-b"].map((id) => handle.homes!.pathFor(id));

    const deleted = await post(handle, "deleteAgents", { ids: ["browser-victim-a", "browser-victim-b"] });

    expect(deleted).toMatchObject({ status: 200, json: { ok: true, value: { ids: ["browser-victim-a", "browser-victim-b"] } } });
    expect(observations).toEqual([
      { phase: "teardown", agentId: "browser-victim-a", homeExists: true },
      { phase: "teardown", agentId: "browser-victim-b", homeExists: true },
      { phase: "purge", agentId: "browser-victim-a", homeExists: false },
      { phase: "purge", agentId: "browser-victim-b", homeExists: false },
    ]);
    expect(homes.map((home) => existsSync(home))).toEqual([false, false]);
    expect(handle.config.snapshot().agents).toEqual([]);
  });

  it("keeps home and roster when broker drain times out before browser purge", async () => {
    const purge = vi.fn(async () => undefined);
    const handle = await boot({ teardownAgent: async () => undefined, purgeAgent: purge });
    expect((await post(handle, "createAgent", { id: "blocked-drain", name: "Blocked drain" })).status).toBe(200);
    const home = handle.homes!.pathFor("blocked-drain");
    const realFence = handle.executionBroker!.fenceAgent.bind(handle.executionBroker);
    const released = vi.fn();
    vi.spyOn(handle.executionBroker!, "fenceAgent").mockImplementation((agentId) => {
      const release = realFence(agentId);
      return () => { release(); released(); };
    });
    const drain = vi.spyOn(handle.executionBroker!, "drainAgent").mockRejectedValueOnce(
      Object.assign(new Error("execution drain deadline exceeded"), { name: "ExecutionDrainError" }),
    );
    const deletion = await post(handle, "deleteAgents", { ids: ["blocked-drain"] });
    expect(deletion.status).not.toBe(200);
    expect(drain).toHaveBeenCalledWith("blocked-drain", 5_000);
    expect(purge).not.toHaveBeenCalled();
    expect(existsSync(home)).toBe(true);
    expect(handle.config.snapshot().agents.map((agent) => agent.id)).toEqual(["blocked-drain"]);
    expect(released).toHaveBeenCalledOnce();
    expect((await post(handle, "getAgent", { id: "blocked-drain" })).status).toBe(200);
  });

  it("propaga a falha de teardown e não remove config, transcript, staging ou home", async () => {
    const teardown = vi.fn(async () => {
      throw new Error("lease still active");
    });
    const purge = vi.fn(async () => undefined);
    const handle = await boot({ teardownAgent: teardown, purgeAgent: purge });
    const created = await post(handle, "createAgent", { id: "protected-victim", name: "Protected victim" });
    expect(created.status).toBe(200);
    const home = handle.homes!.pathFor("protected-victim");
    const staged = await handle.attachmentStaging.stageBytes("protected-victim", {
      filename: "keep.txt",
      bytes: Buffer.from("staging survives rollback"),
    });
    handle.store.append("protected-victim", [{
      kind: "message",
      id: "protected-transcript",
      role: "user",
      content: "must survive failed deletion",
      timestampMs: 1,
    }]);

    const failed = await post(handle, "deleteAgents", { ids: ["protected-victim"] });

    expect(failed.status).toBe(503);
    expect(failed.json.failure).toContain("browser teardown failed for protected-victim: lease still active");
    expect(teardown).toHaveBeenCalledWith("protected-victim");
    expect(purge).not.toHaveBeenCalled();
    expect(existsSync(home)).toBe(true);
    expect(handle.attachmentStaging.get("protected-victim", staged.id)).toEqual(expect.objectContaining({ id: staged.id }));
    expect(existsSync(staged.storedPath)).toBe(true);
    expect(handle.config.snapshot().agents.map((agent) => agent.id)).toEqual(["protected-victim"]);
    expect(handle.store.getEntries("protected-victim")).toContainEqual(expect.objectContaining({
      id: "protected-transcript",
      content: "must survive failed deletion",
    }));
    expect((await post(handle, "listAgents", {})).json.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "protected-victim" }),
    ]));
  });

  it("mantém o journal pendente quando o purge pós-commit falha e repete no restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-browser-delete-reconcile-"));
    dirs.push(root);
    const purge = vi.fn(async () => {
      if (purge.mock.calls.length === 1) throw new Error("browser purge unavailable");
    });
    const browserLifecycle: BrowserAgentLifecycle = {
      teardownAgent: async () => undefined,
      purgeAgent: purge,
    };
    const options = {
      configPath: join(root, "config.json"),
      stateRoot: join(root, "state"),
      runtimeRoot: join(root, "runtime"),
      browserRoot: join(root, "browser"),
      keystoreDir: join(root, "keys"),
      storePath: join(root, "store.db"),
      workspacesRoot: join(root, "workspaces"),
      allowUnauthenticatedLocalGateway: true,
      browserLifecycle,
    } as const;
    const first = await bootWithOptions(options);
    await post(first, "createAgent", { id: "postcommit-victim", name: "Post-commit victim" });

    const failed = await post(first, "deleteAgents", { ids: ["postcommit-victim"] });

    expect(failed.status).toBe(500);
    expect(first.config.snapshot().agents).toEqual([]);
    expect(first.store.pendingAgentDeletions()).toEqual([
      expect.objectContaining({ agentId: "postcommit-victim" }),
    ]);
    expect(purge).toHaveBeenCalledTimes(1);
    await stopServer(first);
    handles.splice(handles.indexOf(first), 1);

    const restarted = await bootWithOptions(options);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(restarted.store.pendingAgentDeletions()).toEqual([]);
    expect(restarted.config.snapshot().agents).toEqual([]);
    await stopServer(restarted);
    handles.splice(handles.indexOf(restarted), 1);

    const stable = await bootWithOptions(options);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(stable.store.pendingAgentDeletions()).toEqual([]);
    await stopServer(stable);
    handles.splice(handles.indexOf(stable), 1);
  });

  it("mantém a referência de staging quando a remoção de bytes falha e a recupera no restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-attachment-delete-reconcile-"));
    dirs.push(root);
    const purge = vi.fn(async () => undefined);
    const browserLifecycle: BrowserAgentLifecycle = {
      teardownAgent: async () => undefined,
      purgeAgent: purge,
    };
    const options = {
      configPath: join(root, "config.json"),
      stateRoot: join(root, "state"),
      runtimeRoot: join(root, "runtime"),
      browserRoot: join(root, "browser"),
      keystoreDir: join(root, "keys"),
      storePath: join(root, "store.db"),
      workspacesRoot: join(root, "workspaces"),
      allowUnauthenticatedLocalGateway: true,
      browserLifecycle,
    } as const;
    const first = await bootWithOptions(options);
    await post(first, "createAgent", { id: "staging-victim", name: "Staging victim" });
    const staged = await first.attachmentStaging.stageBytes("staging-victim", {
      filename: "retry.txt",
      bytes: Buffer.from("retryable staged bytes"),
    });
    const realRm = fsp.rm.bind(fsp);
    let failOnce = true;
    const rm = vi.spyOn(fsp, "rm").mockImplementation(async (target, rmOptions) => {
      if (String(target) === staged.storedPath && failOnce) {
        failOnce = false;
        throw new Error("staging bytes busy");
      }
      return realRm(target, rmOptions);
    });

    const failed = await post(first, "deleteAgents", { ids: ["staging-victim"] });

    expect(failed.status).toBe(500);
    expect(first.config.snapshot().agents).toEqual([]);
    expect(first.store.pendingAgentDeletions()).toEqual([
      expect.objectContaining({ agentId: "staging-victim" }),
    ]);
    expect(first.attachmentStaging.get("staging-victim", staged.id)).toEqual(expect.objectContaining({ id: staged.id }));
    expect(existsSync(staged.storedPath)).toBe(true);
    expect(purge).toHaveBeenCalledOnce();
    rm.mockRestore();
    await stopServer(first);
    handles.splice(handles.indexOf(first), 1);

    const restarted = await bootWithOptions(options);
    expect(restarted.store.pendingAgentDeletions()).toEqual([]);
    expect(restarted.attachmentStaging.get("staging-victim", staged.id)).toBeNull();
    expect(existsSync(staged.storedPath)).toBe(false);
    expect(purge).toHaveBeenCalledTimes(2);
    await stopServer(restarted);
    handles.splice(handles.indexOf(restarted), 1);
  });

  it("executa a limpeza de caches após commit mesmo quando purge falha", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-delete-callback-"));
    dirs.push(root);
    const config = new ConfigStore({ configPath: join(root, "config.json") });
    const store = new SqliteTranscriptStore({ path: join(root, "store.db") });
    const purge = vi.fn(async () => { throw new Error("browser purge failed"); });
    const onDeleteAgentsCommitted = vi.fn();
    const gateway = createGateway();
    try {
      config.update({ agents: [{ id: "callback-victim", name: "Callback victim", avatarId: "callback-victim" }] });
      registerRpcHandlers(gateway, {
        config,
        store,
        browserLifecycle: { teardownAgent: async () => undefined, purgeAgent: purge },
        onDeleteAgentsCommitted,
      });
      const handler = gateway.listHandlers().get("deleteAgents");
      if (handler === undefined) throw new Error("missing deleteAgents handler");

      await expect(handler({ ids: ["callback-victim"] }, {} as never)).rejects.toThrow("browser purge failed");

      expect(onDeleteAgentsCommitted).toHaveBeenCalledWith(["callback-victim"]);
      expect(config.snapshot().agents).toEqual([]);
      expect(store.pendingAgentDeletions()).toEqual([
        expect.objectContaining({ agentId: "callback-victim" }),
      ]);
    } finally {
      gateway.close();
      store.close();
      config.close();
    }
  });

  it("preserva callback e journal quando uma purga síncrona falha após commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-delete-sync-cleanup-"));
    dirs.push(root);
    const config = new ConfigStore({ configPath: join(root, "config.json") });
    const store = new SqliteTranscriptStore({ path: join(root, "store.db") });
    const purgeAgentTasks = vi.fn(() => { throw new Error("task purge failed"); });
    const onDeleteAgentsCommitted = vi.fn();
    const gateway = createGateway();
    try {
      config.update({ agents: [{ id: "sync-cleanup-victim", name: "Sync cleanup victim", avatarId: "sync-cleanup-victim" }] });
      registerRpcHandlers(gateway, {
        config,
        store,
        asyncTaskStore: {
          fenceAgent: vi.fn(),
          terminalizeAgentTasks: vi.fn(),
          clearAgentFence: vi.fn(),
          purgeAgentTasks,
        } as never,
        browserLifecycle: { teardownAgent: async () => undefined, purgeAgent: async () => undefined },
        onDeleteAgentsCommitted,
      });
      const handler = gateway.listHandlers().get("deleteAgents");
      if (handler === undefined) throw new Error("missing deleteAgents handler");

      await expect(handler({ ids: ["sync-cleanup-victim"] }, {} as never)).rejects.toThrow("task purge failed");

      expect(purgeAgentTasks).toHaveBeenCalledWith("sync-cleanup-victim");
      expect(onDeleteAgentsCommitted).toHaveBeenCalledWith(["sync-cleanup-victim"]);
      expect(config.snapshot().agents).toEqual([]);
      expect(store.pendingAgentDeletions()).toEqual([
        expect.objectContaining({ agentId: "sync-cleanup-victim" }),
      ]);
    } finally {
      gateway.close();
      store.close();
      config.close();
    }
  });

  it("captura purgas síncronas de anexos e navegador após commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-delete-sync-purge-"));
    dirs.push(root);
    const config = new ConfigStore({ configPath: join(root, "config.json") });
    const store = new SqliteTranscriptStore({ path: join(root, "store.db") });
    const attachmentPurge = vi.fn(() => { throw new Error("attachment purge failed synchronously"); });
    const browserPurge = vi.fn(() => { throw new Error("browser purge failed synchronously"); });
    const onDeleteAgentsCommitted = vi.fn();
    const gateway = createGateway();
    try {
      config.update({ agents: [{ id: "sync-purge-victim", name: "Sync purge victim", avatarId: "sync-purge-victim" }] });
      registerRpcHandlers(gateway, {
        config,
        store,
        attachmentStaging: { purgeAgent: attachmentPurge } as never,
        browserLifecycle: { teardownAgent: async () => undefined, purgeAgent: browserPurge } as never,
        onDeleteAgentsCommitted,
      });
      const handler = gateway.listHandlers().get("deleteAgents");
      if (handler === undefined) throw new Error("missing deleteAgents handler");

      const failure = await Promise.resolve().then(() => handler({ ids: ["sync-purge-victim"] }, {} as never)).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: "attachment purge failed synchronously" }),
        expect.objectContaining({ message: "browser purge failed synchronously" }),
      ]));
      expect(attachmentPurge).toHaveBeenCalledWith("sync-purge-victim");
      expect(browserPurge).toHaveBeenCalledWith("sync-purge-victim");
      expect(onDeleteAgentsCommitted).toHaveBeenCalledWith(["sync-purge-victim"]);
      expect(config.snapshot().agents).toEqual([]);
      expect(store.pendingAgentDeletions()).toEqual([
        expect.objectContaining({ agentId: "sync-purge-victim" }),
      ]);
    } finally {
      gateway.close();
      store.close();
      config.close();
    }
  });
});

async function bootWithOptions(options: Parameters<typeof startServer>[1]): Promise<ServerHandle> {
  const handle = await startServer(0, options);
  handles.push(handle);
  return handle;
}
