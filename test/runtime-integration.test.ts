import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentRuntimeManager,
  RuntimeCapability,
  RuntimeLease,
  RuntimeMode,
  RuntimeStatus,
  StopReason,
} from "../src/execution/runtime/contracts.js";
import { startServer, stopServer, type ServerHandle } from "../src/main.js";

const dirs: string[] = [];
const handles: ServerHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeRuntimeManager implements AgentRuntimeManager {
  readonly stops: Array<{ agentId: string; reason: StopReason }> = [];
  readonly ensures: Array<{ agentId: string; mode: RuntimeMode }> = [];
  readonly repairs: string[] = [];
  readonly homeExistsDuringStop: boolean[] = [];
  homeExists?: (agentId: string) => boolean;
  private readonly statuses = new Map<string, RuntimeStatus>();

  async ensure(agentId: string, mode: RuntimeMode): Promise<RuntimeStatus> {
    this.ensures.push({ agentId, mode });
    const status = await this.status(agentId, mode);
    this.statuses.set(agentId, status);
    return status;
  }

  async acquire(_agentId: string, _capability: RuntimeCapability): Promise<RuntimeLease> {
    throw new Error("fake runtime acquire should not be called by create/delete tests");
  }

  async status(agentId: string): Promise<RuntimeStatus>;
  async status(agentId: string, mode: RuntimeMode): Promise<RuntimeStatus>;
  async status(agentId: string, mode: RuntimeMode = "lite"): Promise<RuntimeStatus> {
    return this.statuses.get(agentId) ?? {
      agentId,
      mode,
      state: mode === "lite" ? "lite-ready" : "stopped",
      runtimeVersion: null,
      imageDigest: null,
      runtimeBootId: null,
      activeLeaseCount: 0,
      activeProcessCount: 0,
      lastActivityAt: null,
      lastError: null,
    };
  }

  async stop(agentId: string, reason: StopReason): Promise<RuntimeStatus> {
    this.stops.push({ agentId, reason });
    if (this.homeExists !== undefined) {
      this.homeExistsDuringStop.push(this.homeExists(agentId));
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.homeExistsDuringStop.push(this.homeExists(agentId));
    }
    const status = await this.status(agentId);
    const stopped = { ...status, state: "stopped" as const, activeLeaseCount: 0, activeProcessCount: 0 };
    this.statuses.set(agentId, stopped);
    return stopped;
  }

  async repair(agentId: string): Promise<RuntimeStatus> {
    this.repairs.push(agentId);
    return this.status(agentId, "developer");
  }

  async close(): Promise<void> {}
}

async function boot(runtimeManager: FakeRuntimeManager): Promise<ServerHandle> {
  const root = mkdtempSync(join(tmpdir(), "openbot-runtime-integration-"));
  dirs.push(root);
  const handle = await startServer(0, {
    workspacesRoot: join(root, "workspaces"),
    storePath: join(root, "store.db"),
    configPath: join(root, "config.json"),
    keystoreDir: join(root, "keys"),
    allowUnauthenticatedLocalGateway: true,
    runtimeManager,
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

describe("runtime integration", () => {
  it("cria bot e workspace no modo confiável sem iniciar runtime isolado", async () => {
    const runtime = new FakeRuntimeManager();
    const handle = await boot(runtime);
    const created = await post(handle, "createAgent", { id: "runtime-a", name: "Runtime A" });
    expect(created.status).toBe(200);
    expect(runtime.ensures).toEqual([]);
    expect(readFileSync(join(handle.homes!.pathFor("runtime-a"), ".openbot", "home.json"), "utf8")).toContain("runtime-a");

    const status = await post(handle, "getLocalRuntimeStatus", { agentId: "runtime-a" });
    expect(status.status).toBe(200);
    expect(status.json.value).toMatchObject({ agentId: "runtime-a", state: "stopped", mode: "developer" });
  });

  it("observa modo Developer sem iniciar runtime e expõe repairLocalRuntime só para agente válido", async () => {
    const runtime = new FakeRuntimeManager();
    const handle = await boot(runtime);
    expect((await post(handle, "createAgent", { id: "developer", name: "Developer", runtimeMode: "developer" })).status).toBe(200);

    const status = await post(handle, "getLocalRuntimeStatus", { agentId: "developer" });
    expect(status.json.value).toMatchObject({ agentId: "developer", mode: "developer", state: "stopped" });
    expect(runtime.ensures).toEqual([]);

    const repaired = await post(handle, "repairLocalRuntime", { agentId: "developer" });
    expect(repaired.status).toBe(200);
    expect(repaired.json.value).toMatchObject({ agentId: "developer", mode: "developer", state: "stopped" });
    expect(runtime.repairs).toEqual(["developer"]);
    expect((await post(handle, "repairLocalRuntime", { agentId: "missing" })).status).toBe(400);
    expect(runtime.repairs).toEqual(["developer"]);
  });

  it("para o runtime antes de remover a home do agente", async () => {
    const runtime = new FakeRuntimeManager();
    const handle = await boot(runtime);
    await post(handle, "createAgent", { id: "runtime-delete", name: "Delete me" });
    const homePath = handle.homes!.pathFor("runtime-delete");
    runtime.homeExists = () => existsSync(homePath);
    const deleted = await post(handle, "deleteAgents", { ids: ["runtime-delete"] });
    expect(deleted.status).toBe(200);
    expect(runtime.stops).toEqual([{ agentId: "runtime-delete", reason: "agent-delete" }]);
    expect(runtime.homeExistsDuringStop).toEqual([true, true]);
    expect(existsSync(homePath)).toBe(false);
  });
});
