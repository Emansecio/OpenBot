import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { AgentHomeStore } from "../src/execution/home.js";
import { AgentRuntimeBackend } from "../src/execution/runtime/agent-backend.js";
import type { HomeAclAdapter } from "../src/execution/home-acl.js";
import type { BrowserAgentLifecycle } from "../src/rpc/index.js";
import { hashAgentId } from "../src/browser/browser-session-manager.js";
import type { DispatchAsyncTaskInput, ProviderCapabilityGrant, SubagentBudget } from "../src/tasks/contracts.js";
import { TempRoots } from "./helpers/temp-roots.js";

const temp = new TempRoots();
const handles: ServerHandle[] = [];

const busyTaskBudget: SubagentBudget = {
  maxWallMs: 60_000, maxProviderCalls: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000,
  maxToolRounds: 1, maxToolCalls: 1, maxMcpCalls: 1, maxBrowserCommands: 1,
  maxResultBytes: 4_096, maxWorkspaceWriteBytes: 4_096, maxDepth: 1,
};

function busyTaskInput(agentId: string): DispatchAsyncTaskInput {
  const taskId = randomUUID();
  const childRunId = randomUUID();
  const now = Date.now();
  const grant: ProviderCapabilityGrant = {
    grantId: randomUUID(), taskId, parentAgentId: agentId, parentTurnId: `busy-turn-${agentId}`, childRunId,
    kind: "provider", constraints: {
      adapters: ["openai"], models: ["test"], credentialRefs: [{ secretRef: "provider/test/key" }], allowNoCredential: false,
    }, issuedAt: now - 100, expiresAt: now + 60_000, version: 1, depth: 1,
  };
  return {
    taskId, agentId, parentTurnId: `busy-turn-${agentId}`, kind: "subagent", clientNonce: randomUUID(), createdAtMs: now,
    lineage: { parentAgentId: agentId, parentTurnId: `busy-turn-${agentId}`, parentTaskId: null, childRunId, depth: 1 },
    grant, budget: busyTaskBudget,
    input: { version: 1, objective: "busy", source: { kind: "parent_turn", agentId, turnEntryId: `busy-entry-${agentId}` } },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  await temp.cleanup();
});

async function boot(browserLifecycle?: BrowserAgentLifecycle, homes?: AgentHomeStore): Promise<{ handle: ServerHandle; root: string }> {
  const root = temp.make("openbot-home-lifecycle-rpc-");
  const handle = await startServer(0, {
    stateRoot: join(root, "state"),
    allowUnauthenticatedLocalGateway: true,
    runtimeRoot: join(root, "runtime"),
    browserRoot: join(root, "browser"),
    configPath: join(root, "config.json"),
    storePath: join(root, "store.db"),
    keystoreDir: join(root, "keys"),
    workspacesRoot: homes?.root ?? join(root, "workspaces"),
    browserLifecycle,
    ...(homes ? { homes } : {}),
  });
  handles.push(handle);
  return { handle, root };
}

async function post(handle: ServerHandle, method: string, body: unknown): Promise<{
  status: number;
  json: { ok: boolean; value?: unknown; failure?: string };
}> {
  return await new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: handle.port,
      path: `/api/${method}`,
      method: "POST",
      headers: { "content-type": "application/json" },
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok: boolean; value?: unknown; failure?: string },
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}


describe("home lifecycle RPC", () => {
  it("falha antes do boot do servidor quando o bootstrap ACL Windows falha", async () => {
    const root = temp.make("openbot-home-acl-rpc-");
    const listen = vi.spyOn(http.Server.prototype, "listen");

    await expect(startServer(0, {
      stateRoot: join(root, "state"),
      stateAcl: {
        platform: "win32",
        currentUser: "CONTOSO\\alice",
        runner: async () => ({ exitCode: 1, stderr: "icacls indisponível" }),
      },
    })).rejects.toThrow(/OpenBot state ACL failed.*icacls indisponível/i);
    expect(listen).not.toHaveBeenCalled();
  });

  it("drena o browser antes de cada mutação de workspace protegida pelo fence", async () => {
    const calls: string[] = [];
    const { handle, root } = await boot({
      async teardownAgent(agentId) {
        calls.push(`browser:${agentId}`);
      },
      async purgeAgent(agentId) {
        calls.push(`purge:${agentId}`);
      },
    });
    await post(handle, "createAgent", { id: "fenced-home", name: "Fenced home" });
    const archivePath = join(root, "fenced-home.json");

    expect((await post(handle, "exportAgentHome", { agentId: "fenced-home", destination: archivePath })).status).toBe(200);
    expect(calls).toEqual(["browser:fenced-home"]);

    expect((await post(handle, "repairAgentHome", { agentId: "fenced-home" })).status).toBe(200);
    expect(calls).toEqual(["browser:fenced-home", "browser:fenced-home"]);

    expect((await post(handle, "deleteAgents", { ids: ["fenced-home"] })).status).toBe(200);
    const quarantined = (await post(handle, "listQuarantinedAgents", {})).json.value as Array<{ agentId: string; quarantineId: string }>;
    expect((await post(handle, "restoreAgentHome", { agentId: "fenced-home", quarantineId: quarantined[0]!.quarantineId })).status).toBe(200);

    await post(handle, "createAgent", { id: "import-source", name: "Import source" });
    const importArchive = join(root, "import-source.json");
    expect((await post(handle, "exportAgentHome", { agentId: "import-source", destination: importArchive })).status).toBe(200);
    expect((await post(handle, "deleteAgents", { ids: ["import-source"] })).status).toBe(200);
    expect((await post(handle, "importAgentHome", { agentId: "import-source", archivePath: importArchive })).status).toBe(200);
    expect(calls.filter((entry) => entry === "browser:fenced-home")).toHaveLength(4);
    expect(calls.filter((entry) => entry === "browser:import-source")).toHaveLength(3);
    expect(calls.filter((entry) => entry.startsWith("purge:"))).toEqual(["purge:fenced-home", "purge:import-source"]);
  });

  it("reads inventory without lifecycle maintenance while async work is busy", async () => {
    const browserDrain = vi.fn(async () => undefined);
    const { handle } = await boot({ teardownAgent: browserDrain, purgeAgent: async () => undefined });
    await post(handle, "createAgent", { id: "async-home", name: "Async home" });
    const document = join(handle.homes!.pathFor("async-home"), "Documents", "keep.txt");
    writeFileSync(document, "keep");
    let releaseBusy!: () => void;
    const busy = new Promise<void>((resolve) => { releaseBusy = resolve; });
    const runtimeInternals = handle.asyncTaskRuntime as unknown as { execute: (context: unknown) => Promise<unknown> };
    runtimeInternals.execute = async () => { await busy; return { result: "busy task finished" }; };
    const busyTask = handle.asyncTaskStore.dispatch(busyTaskInput("async-home")).task;
    const drain = vi.spyOn(handle.asyncTaskRuntime, "drainAgent");
    const realFence = handle.asyncTaskRuntime.fenceAgent.bind(handle.asyncTaskRuntime);
    const brokerDrain = vi.spyOn(handle.executionBroker!, "drainAgent");
    const realBrokerFence = handle.executionBroker!.fenceAgent.bind(handle.executionBroker);
    const brokerReleased = vi.fn();
    vi.spyOn(handle.executionBroker!, "fenceAgent").mockImplementation((agentId) => {
      const release = realBrokerFence(agentId);
      return () => { release(); brokerReleased(); };
    });
    const flush = vi.spyOn(handle.runner, "flush");
    const runtimeStop = vi.spyOn(handle.runtimeManager, "stop");
    const released = vi.fn();
    vi.spyOn(handle.asyncTaskRuntime, "fenceAgent").mockImplementation((agentId) => {
      const release = realFence(agentId);
      return () => { release(); released(); };
    });
    const inventory = post(handle, "getWorkspaceInventory", { agentId: "async-home" });
    try {
      await vi.waitFor(() => expect(handle.asyncTaskStore.getTask(busyTask.taskId)).toMatchObject({ status: "running" }));
      expect((await inventory).status).toBe(200);
      expect(drain).not.toHaveBeenCalled();
      expect(browserDrain).not.toHaveBeenCalled();
      expect(released).not.toHaveBeenCalled();
      expect(brokerReleased).not.toHaveBeenCalled();
      expect(brokerDrain).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      expect(runtimeStop).not.toHaveBeenCalled();
      expect(readFileSync(document, "utf8")).toBe("keep");
    } finally {
      releaseBusy();
    }

    await vi.waitFor(() => expect(handle.asyncTaskStore.getTask(busyTask.taskId)).toMatchObject({ status: "completed" }));

    const repaired = await post(handle, "repairAgentHome", { agentId: "async-home" });
    expect(repaired.status).toBe(200);
    expect(browserDrain).toHaveBeenCalledWith("async-home");
    expect(released).toHaveBeenCalledOnce();

    drain.mockRejectedValueOnce(new Error("async work did not stop"));
    browserDrain.mockClear();
    expect((await post(handle, "repairAgentHome", { agentId: "async-home" })).status).not.toBe(200);
    expect(browserDrain).not.toHaveBeenCalled();
    expect(readFileSync(document, "utf8")).toBe("keep");
    expect(released).toHaveBeenCalledTimes(2);
    expect(brokerReleased).toHaveBeenCalledTimes(2);

    brokerDrain.mockRejectedValueOnce(Object.assign(new Error("execution drain deadline exceeded"), { name: "ExecutionDrainError" }));
    expect((await post(handle, "repairAgentHome", { agentId: "async-home" })).status).not.toBe(200);
    expect(browserDrain).not.toHaveBeenCalled();
    expect(readFileSync(document, "utf8")).toBe("keep");
    expect(released).toHaveBeenCalledTimes(3);
    expect(brokerReleased).toHaveBeenCalledTimes(3);
  });

  it("exports, inventories, quarantines and restores a home without recreating a bot", async () => {
    const { handle, root } = await boot();
    const created = await post(handle, "createAgent", { id: "portable", name: "Portable" });
    expect(created.status).toBe(200);
    const homeRoot = handle.homes!.pathFor("portable");
    const profileRoot = join(root, "browser", "Partitions", `openbot-agent-${hashAgentId("portable")}`);
    mkdirSync(profileRoot, { recursive: true });
    const persistedCookie = join(profileRoot, "Cookies");
    writeFileSync(persistedCookie, "existing-browser-login");
    writeFileSync(join(homeRoot, "Documents", "keep.txt"), "keep");
    const archivePath = join(root, "portable.obhome.json");

    const exported = await post(handle, "exportAgentHome", { agentId: "portable", destination: archivePath });
    expect(exported).toMatchObject({ status: 200, json: { ok: true, value: { path: archivePath } } });
    expect(existsSync(archivePath)).toBe(true);
    expect(readFileSync(persistedCookie, "utf8")).toBe("existing-browser-login");
    expect((await post(handle, "repairAgentHome", { agentId: "portable" })).status).toBe(200);
    expect(readFileSync(persistedCookie, "utf8")).toBe("existing-browser-login");

    const inventory = await post(handle, "getWorkspaceInventory", { agentId: "portable" });
    expect(inventory.status).toBe(200);
    expect(readFileSync(persistedCookie, "utf8")).toBe("existing-browser-login");
    expect((inventory.json.value as { agentId: string; entries: Array<{ path: string }> }).entries.some((entry) => entry.path === "Documents/keep.txt")).toBe(true);

    const deleted = await post(handle, "deleteAgents", { ids: ["portable"] });
    expect(deleted.status).toBe(200);
    expect(existsSync(homeRoot)).toBe(false);
    expect(existsSync(profileRoot)).toBe(false);
    expect((await post(handle, "listAgents", {})).json.value).toEqual([]);

    const quarantined = await post(handle, "listQuarantinedAgents", {});
    expect(quarantined.status).toBe(200);
    const entry = (quarantined.json.value as Array<{ agentId: string; quarantineId: string }>).find((candidate) => candidate.agentId === "portable");
    expect(entry).toBeDefined();

    const restored = await post(handle, "restoreAgentHome", { agentId: "portable", quarantineId: entry!.quarantineId });
    expect(restored.status).toBe(200);
    expect(readFileSync(join(homeRoot, "Documents", "keep.txt"), "utf8")).toBe("keep");
    expect((await post(handle, "listQuarantinedAgents", {})).json.value).toEqual([]);
    expect((await post(handle, "listAgents", {})).json.value).toEqual([]);
  });

  it("invalidates cached runtime authority only after repair or import commits", async () => {
    const { handle, root } = await boot();
    const agentId = "cache-home";
    expect((await post(handle, "createAgent", { id: agentId, name: "Cache home" })).status).toBe(200);
    const createBackend = vi.spyOn(AgentRuntimeBackend, "create");
    let sequence = 0;
    const workspaceInfo = () => handle.executionBroker!.execute(agentId, `cache-${++sequence}`, { operation: "workspace.info" });
    const metricAgents = () => handle.executionDiagnostics.snapshot().workspaces.map((workspace) => workspace.agentId);
    await expect(workspaceInfo()).resolves.toMatchObject({ ok: true });
    expect(createBackend).toHaveBeenCalledTimes(1);
    expect(metricAgents()).toEqual([agentId]);

    const archivePath = join(root, "cache-home.obhome");
    expect((await post(handle, "getWorkspaceInventory", { agentId })).status).toBe(200);
    expect((await post(handle, "exportAgentHome", { agentId, destination: archivePath })).status).toBe(200);
    expect(metricAgents()).toEqual([agentId]);
    await expect(workspaceInfo()).resolves.toMatchObject({ ok: true });
    expect(createBackend).toHaveBeenCalledTimes(1);

    expect((await post(handle, "repairAgentHome", { agentId })).status).toBe(200);
    expect(metricAgents()).toEqual([]);
    await expect(workspaceInfo()).resolves.toMatchObject({ ok: true });
    expect(createBackend).toHaveBeenCalledTimes(2);
    expect(metricAgents()).toEqual([agentId]);

    // Quarantine only this disposable fixture, retaining the main cache to
    // reproduce an old backend surviving an external home replacement.
    await handle.homes!.remove(agentId);
    expect(metricAgents()).toEqual([agentId]);
    expect((await post(handle, "importAgentHome", { agentId, archivePath })).status).toBe(200);
    expect(metricAgents()).toEqual([]);
    await expect(workspaceInfo()).resolves.toMatchObject({ ok: true });
    expect(createBackend).toHaveBeenCalledTimes(3);
    expect(metricAgents()).toEqual([agentId]);
  });

  it("aplica quota persistente por bot somente após drenar e invalidar a autoridade atual", async () => {
    const { handle } = await boot();
    const agentId = "quota-config";
    expect((await post(handle, "createAgent", { id: agentId, name: "Quota config" })).status).toBe(200);
    const createBackend = vi.spyOn(AgentRuntimeBackend, "create");
    let sequence = 0;
    const workspaceInfo = () => handle.executionBroker!.execute(agentId, `quota-info-${++sequence}`, { operation: "workspace.info" });

    await expect(workspaceInfo()).resolves.toMatchObject({
      ok: true,
      quota: { global: { maxBytes: 2 * 1024 * 1024 * 1024 }, folders: { downloads: { maxBytes: 256 * 1024 * 1024 } } },
    });
    expect(createBackend).toHaveBeenCalledTimes(1);

    const updated = await post(handle, "updateAgent", {
      agentId,
      workspaceQuota: { maxBytes: 4_096, folders: { Projects: { maxBytes: 2_048 } } },
    });
    expect(updated.status).toBe(200);
    expect(handle.config.snapshot().agents.find((agent) => agent.id === agentId)?.workspaceQuota).toEqual({
      maxBytes: 4_096,
      folders: { projects: { maxBytes: 2_048 } },
    });
    await expect(workspaceInfo()).resolves.toMatchObject({
      ok: true,
      quota: {
        global: { maxBytes: 4_096, maxFiles: 100_000, maxEntries: 200_000 },
        folders: { projects: { maxBytes: 2_048, maxFiles: 80_000, maxEntries: 160_000 } },
      },
    });
    expect(createBackend).toHaveBeenCalledTimes(2);

    expect((await post(handle, "updateAgent", { agentId, workspaceQuota: { maxBytes: 0 } })).status).toBe(400);
    expect((await post(handle, "updateAgent", { agentId, workspaceQuota: null })).status).toBe(200);
    await expect(workspaceInfo()).resolves.toMatchObject({ quota: { global: { maxBytes: 2 * 1024 * 1024 * 1024 } } });
    expect(createBackend).toHaveBeenCalledTimes(3);
  });

  it("imports atomically, repairs canonical folders and rejects invalid lifecycle input", async () => {
    const homesRoot = temp.make("openbot-home-import-rollback-");
    let failImportAcl = false;
    let failureObservedAfterRename = false;
    const acl: HomeAclAdapter = {
      async apply(root, context) {
        if (failImportAcl && context.operation === "import" && context.agentId === "source") {
          failureObservedAfterRename = existsSync(root);
          return { status: "failed", platform: "win32", message: "falha ACL pós-rename" };
        }
        return { status: "verified", platform: "win32" };
      },
    };
    const homes = await AgentHomeStore.create(join(homesRoot, "workspaces"), { acl });
    const { handle, root } = await boot(undefined, homes);
    await post(handle, "createAgent", { id: "source", name: "Source" });
    writeFileSync(join(handle.homes!.pathFor("source"), "Projects", "hello.txt"), "hello");
    const archivePath = join(root, "source.json");
    expect((await post(handle, "exportAgentHome", { agentId: "source", destination: archivePath })).status).toBe(200);

    expect((await post(handle, "deleteAgents", { ids: ["source"] })).status).toBe(200);
    failImportAcl = true;
    const clearHomeReady = vi.spyOn(handle.runtimeManager, "clearAgentRepairRequired");
    const failedImport = await post(handle, "importAgentHome", { agentId: "source", archivePath });
    expect(failedImport.status).toBe(403);
    expect(failureObservedAfterRename).toBe(true);
    expect(clearHomeReady).not.toHaveBeenCalled();
    expect(existsSync(handle.homes!.pathFor("source"))).toBe(false);

    failImportAcl = false;
    const imported = await post(handle, "importAgentHome", { agentId: "source", archivePath });
    expect(imported.status).toBe(200);
    expect(clearHomeReady).toHaveBeenCalledWith("source");
    expect(readFileSync(join(handle.homes!.pathFor("source"), "Projects", "hello.txt"), "utf8")).toBe("hello");

    rmSync(join(handle.homes!.pathFor("source"), "Documents"), { recursive: true, force: true });
    const repaired = await post(handle, "repairAgentHome", { agentId: "source" });
    expect(repaired.status).toBe(200);
    expect((repaired.json.value as { actions: string[] }).actions).toContain("created-Documents");

    const invalid = await post(handle, "importAgentHome", { agentId: "../escape", archivePath });
    expect(invalid.status).toBe(400);
    const missing = await post(handle, "exportAgentHome", { agentId: "missing", destination: join(root, "missing.json") });
    expect(missing.status).toBe(404);
  });

  it("lists all active workspace inventories in the empty-agent state", async () => {
    const { handle } = await boot();
    const inventory = await post(handle, "getWorkspaceInventory", {});
    expect(inventory).toMatchObject({ status: 200, json: { ok: true, value: [] } });
    const invalid = await post(handle, "restoreAgentHome", {});
    expect(invalid.status).toBe(400);
  });
});
