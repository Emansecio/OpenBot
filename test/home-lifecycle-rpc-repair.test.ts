import { writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { AgentHomeStore } from "../src/execution/home.js";
import type { BrowserAgentLifecycle } from "../src/rpc/index.js";
import { TempRoots } from "./helpers/temp-roots.js";

const temp = new TempRoots();
const handles: ServerHandle[] = [];

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

  it("limpa repair-required só após repair de home bem-sucedido", async () => {
    const { handle } = await boot();
    await post(handle, "createAgent", { id: "repair-clear", name: "Repair clear", runtimeMode: "developer" });
    handle.runtimeManager.markAgentRepairRequired?.("repair-clear");
    await expect(handle.runtimeManager.status("repair-clear", "developer")).resolves.toMatchObject({ state: "repair-required" });

    expect((await post(handle, "repairAgentHome", { agentId: "repair-clear" })).status).toBe(200);
    await expect(handle.runtimeManager.status("repair-clear", "developer")).resolves.toMatchObject({ state: "stopped" });
  });

  it("mantém repair-required quando repair ou restore de home falha", async () => {
    const { handle } = await boot();
    await post(handle, "createAgent", { id: "repair-stays", name: "Repair stays", runtimeMode: "developer" });
    handle.runtimeManager.markAgentRepairRequired?.("repair-stays");
    writeFileSync(join(handle.homes!.pathFor("repair-stays"), ".openbot", "home.json"), "not-json");

    expect((await post(handle, "repairAgentHome", { agentId: "repair-stays" })).status).toBe(422);
    await expect(handle.runtimeManager.status("repair-stays", "developer")).resolves.toMatchObject({ state: "repair-required" });
    expect((await post(handle, "restoreAgentHome", { agentId: "repair-stays", quarantineId: "missing" })).status).not.toBe(200);
    await expect(handle.runtimeManager.status("repair-stays", "developer")).resolves.toMatchObject({ state: "repair-required" });
  });

  it("preserva repair-required quando delete falha antes do commit", async () => {
    const { handle } = await boot({
      async teardownAgent(agentId) {
        if (agentId === "delete-fails") throw new Error("browser teardown failed");
      },
      async purgeAgent() {},
    });
    await post(handle, "createAgent", { id: "delete-fails", name: "Delete fails", runtimeMode: "developer" });
    handle.runtimeManager.markAgentRepairRequired?.("delete-fails");

    expect((await post(handle, "deleteAgents", { ids: ["delete-fails"] })).status).toBe(503);
    await expect(handle.runtimeManager.status("delete-fails", "developer")).resolves.toMatchObject({
      state: "repair-required",
      lastError: { code: "runtime_unhealthy" },
    });
    expect((await post(handle, "getAgent", { id: "delete-fails" })).status).toBe(200);
  });

  it("limpa repair-required após restore e agent-delete sem herdar ao recriar ID", async () => {
    const { handle } = await boot();
    await post(handle, "createAgent", { id: "restore-clear", name: "Restore clear", runtimeMode: "developer" });
    expect((await post(handle, "deleteAgents", { ids: ["restore-clear"] })).status).toBe(200);
    handle.runtimeManager.markAgentRepairRequired?.("restore-clear");
    const quarantined = await handle.homes!.listQuarantine();
    const entry = quarantined.find((candidate) => candidate.agentId === "restore-clear")!;

    expect((await post(handle, "restoreAgentHome", { agentId: "restore-clear", quarantineId: entry.quarantineId })).status).toBe(200);
    await expect(handle.runtimeManager.status("restore-clear", "developer")).resolves.toMatchObject({ state: "stopped" });

    await post(handle, "createAgent", { id: "delete-clear", name: "Delete clear", runtimeMode: "developer" });
    handle.runtimeManager.markAgentRepairRequired?.("delete-clear");
    expect((await post(handle, "deleteAgents", { ids: ["delete-clear"] })).status).toBe(200);
    expect((await post(handle, "createAgent", { id: "delete-clear", name: "Recreated", runtimeMode: "developer" })).status).toBe(200);
    await expect(handle.runtimeManager.status("delete-clear", "developer")).resolves.toMatchObject({ state: "stopped" });
  });
});
