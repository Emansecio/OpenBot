import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProviderRegistry, type ProviderAdapter, type ProviderChatRequest, type ProviderStreamEvent } from "../src/providers/router.js";
import type { AgentRuntimeManager, RuntimeCapability, RuntimeLease, RuntimeStatus } from "../src/execution/runtime/contracts.js";
import type { RuntimeProcessRunner } from "../src/execution/runtime/wsl/process-backend.js";
import { ConfigStore } from "../src/config/store.js";
import { startServer, stopServer, type ServerHandle } from "../src/main.js";

const dirs: string[] = [];
const handles: ServerHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const turnRequests = (requests: ProviderChatRequest[]) => requests.filter((request) => (request.purpose ?? "turn") === "turn");

async function boot(adapter: ProviderAdapter, runtime?: { manager: AgentRuntimeManager; runner: RuntimeProcessRunner }): Promise<ServerHandle> {
  const root = mkdtempSync(join(tmpdir(), "openbot-runtime-mode-"));
  dirs.push(root);
  const registry = createProviderRegistry();
  registry.register(adapter);
  const handle = await startServer(0, {
    registry,
    workspacesRoot: join(root, "workspaces"),
    runtimeRoot: join(root, "runtime"),
    browserRoot: join(root, "browser"),
    storePath: join(root, "store.db"),
    configPath: join(root, "config.json"),
    keystoreDir: join(root, "keys"),
    allowUnauthenticatedLocalGateway: true,
    ...(runtime ? { runtimeManager: runtime.manager, runtimeProcessRunner: runtime.runner } : {}),
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

describe("runtime mode por agente", () => {
  it("publica process_run para todo bot e persiste Developer", async () => {
    const requests: ProviderChatRequest[] = [];
    const adapter: ProviderAdapter = {
      name: "xai",
      async streamChat(request: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void) {
        requests.push(request);
        emit({ type: "delta", delta: "ok" });
      },
    };
    const handle = await boot(adapter);
    const liteAgent = await post(handle, "createAgent", { id: "openbot-default", name: "Lite" });
    expect(liteAgent.status).toBe(200);
    const created = await post(handle, "createAgent", { id: "developer", name: "Developer", runtimeMode: "developer" });
    expect(created.status).toBe(200);
    expect((created.json.value as { agent: { runtimeMode: string } }).agent.runtimeMode).toBe("developer");

    const lite = await post(handle, "sendPrompt", { agentId: "openbot-default", prompt: "lite", clientNonce: "mode:lite" });
    const developer = await post(handle, "sendPrompt", { agentId: "developer", prompt: "dev", clientNonce: "mode:dev" });
    expect(lite.status).toBe(200);
    expect(developer.status).toBe(200);
    await handle.runner.flush("openbot-default");
    await handle.runner.flush("developer");

    const turns = turnRequests(requests);
    expect(turns).toHaveLength(2);
    const requestFor = (prompt: string) => turns.find((request) => request.messages.some((message) => (
      message.role === "user" && message.content === prompt
    )));
    const liteRequest = requestFor("lite");
    const developerRequest = requestFor("dev");
    expect(liteRequest).toBeDefined();
    expect(developerRequest).toBeDefined();
    const liteTools = new Set(liteRequest!.tools!.map((tool) => tool.function.name));
    const developerTools = new Set(developerRequest!.tools!.map((tool) => tool.function.name));
    expect(liteTools.has("process_run")).toBe(true);
    expect(developerTools.has("process_run")).toBe(true);

    const reopened = new ConfigStore({ configPath: join(dirs.at(-1)!, "config.json") });
    expect(reopened.snapshot().agents.find((agent) => agent.id === "developer")?.runtimeMode).toBe("developer");
  });

  it("envia process_run do Developer ao backend local e devolve o resultado ao provider", async () => {
    const requests: ProviderChatRequest[] = [];
    const adapter: ProviderAdapter = {
      name: "xai",
      async streamChat(request, emit) {
        requests.push(request);
        if (turnRequests(requests).length === 1) {
          emit({ type: "tool-call", call: {
            id: "process-call",
            type: "function",
            function: { name: "process_run", arguments: JSON.stringify({ executable: "node", argv: ["--version"], cwd: ".", timeoutMs: 1_000, networkProfile: "host" }) },
          } });
        } else {
          emit({ type: "delta", delta: "process complete" });
        }
      },
    };
    const activeLease: RuntimeLease = {
      leaseId: "lease-1",
      agentId: "developer",
      runtimeBootId: "boot-1",
      sandboxId: "sandbox-1",
      capability: { kind: "process.run", networkProfile: "host" },
      expiresAt: Date.now() + 5_000,
      released: false,
      release: async () => undefined,
    };
    const manager: AgentRuntimeManager = {
      ensure: vi.fn(),
      acquire: vi.fn(async (_agentId: string, _capability: RuntimeCapability) => activeLease),
      status: vi.fn(async (agentId: string): Promise<RuntimeStatus> => ({
        agentId, mode: "developer", state: "ready", runtimeVersion: "test", imageDigest: null,
        runtimeBootId: "boot-1", activeLeaseCount: 0, activeProcessCount: 0, lastActivityAt: null, lastError: null,
      })),
      stop: vi.fn(),
      repair: vi.fn(),
      close: vi.fn(),
    };
    const runner: RuntimeProcessRunner = {
      run: vi.fn(async () => ({ ok: true as const, operation: "process.run" as const, stdout: "v22", stderr: "", exitCode: 0, durationMs: 1, stdoutTruncated: false, stderrTruncated: false })),
    };
    const handle = await boot(adapter, { manager, runner });
    await post(handle, "createAgent", { id: "developer", name: "Developer", runtimeMode: "developer" });
    expect((await post(handle, "sendPrompt", { agentId: "developer", prompt: "run", clientNonce: "mode:process" })).status).toBe(200);
    await handle.runner.flush("developer");
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(turnRequests(requests)).toHaveLength(2);
    const toolResult = turnRequests(requests)[1]?.messages.find((message) => message.role === "tool");
    expect(toolResult).toMatchObject({ role: "tool", toolCallId: "process-call" });
    expect(toolResult?.content).toContain("v22");
    expect(requests.every((request) => ["turn", "memory-reflection", undefined].includes(request.purpose))).toBe(true);
  });

  it("setAgentRuntimeMode keeps the trusted host mode fixed on developer", async () => {
    const adapter: ProviderAdapter = { name: "xai", async streamChat(_request, emit) { emit({ type: "delta", delta: "ok" }); } };
    const handle = await boot(adapter);
    await post(handle, "createAgent", { id: "developer", name: "Developer" });
    const saved = await post(handle, "setAgentRuntimeMode", { agentId: "developer", mode: "developer" });
    expect(saved.status).toBe(200);
    expect(saved.json.value).toMatchObject({ agentId: "developer", runtimeMode: "developer" });
    expect(handle.config.snapshot().agents.find((agent) => agent.id === "openbot-default")?.runtimeMode).toBeUndefined();
    const browser = await post(handle, "setAgentRuntimeMode", { agentId: "developer", mode: "browser" });
    expect(browser.status).toBe(400);
    expect(browser.json.failure).toContain("developer");
    expect(handle.config.snapshot().agents.find((agent) => agent.id === "developer")?.runtimeMode).toBe("developer");
    expect(handle.config.snapshot().agents.find((agent) => agent.id === "openbot-default")?.runtimeMode).toBeUndefined();
    const beforeInvalid = handle.config.snapshot().agents;
    const invalid = await post(handle, "setAgentRuntimeMode", { agentId: "developer", mode: "admin" });
    expect(invalid.status).toBe(400);
    expect(invalid.json.failure).toContain("runtimeMode");
    expect(handle.config.snapshot().agents).toEqual(beforeInvalid);
  });
});
