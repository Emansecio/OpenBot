import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigStore } from "../src/config/store.js";
import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { createProviderRegistry, type ProviderAdapter, type ProviderChatRequest } from "../src/providers/router.js";
import { DEFAULT_AGENT_ID } from "../src/rpc/roster.js";

const dirs: string[] = [];
let handles: ServerHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbot-home-boot-"));
  dirs.push(dir);
  return dir;
};

function seedDefaultAgent(config: ConfigStore): void {
  config.update({ agents: [{ id: DEFAULT_AGENT_ID, name: "Local User", avatarId: DEFAULT_AGENT_ID }] });
}

function seedDefaultConfig(configPath: string): void {
  const config = new ConfigStore({ configPath });
  seedDefaultAgent(config);
  config.close();
}

function isolatedRoots(dir: string) {
  return {
    stateRoot: join(dir, "state"),
    runtimeRoot: join(dir, "runtime"),
    browserRoot: join(dir, "browser"),
    allowUnauthenticatedLocalGateway: true,
  };
}

describe("startServer agent home", () => {
  it("creates the default home before listen and writes without asking", async () => {
    const dir = await tempDir();
    const workspacesRoot = join(dir, "workspaces");
    const configPath = join(dir, "config.json");
    seedDefaultConfig(configPath);
    const requests: ProviderChatRequest[] = [];
    const registry = createProviderRegistry();
    const adapter: ProviderAdapter = {
      name: "xai",
      async streamChat(request, emit) {
        requests.push(request);
        if (requests.length === 1) {
          emit({
            type: "tool-call",
            call: {
              id: "w1",
              type: "function",
              function: {
                name: "file",
                arguments: JSON.stringify({
                  op: "write",
                  path: "Documents/nota.md",
                  content: "from-boot",
                  encoding: "utf8",
                }),
              },
            },
          });
          return;
        }
        emit({ type: "delta", delta: "gravado" });
      },
    };
    registry.register(adapter);

    const homeRoot = join(workspacesRoot, DEFAULT_AGENT_ID);
    const originalListen = Server.prototype.listen;
    let homeExistedAtListen = false;
    const listenSpy = vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args) {
      homeExistedAtListen = existsSync(join(homeRoot, ".openbot", "home.json"));
      return Reflect.apply(originalListen, this, args) as Server;
    });
    const handle = await (async () => {
      try {
        return await startServer(0, {
          ...isolatedRoots(dir),
          registry,
          workspacesRoot,
          storePath: join(dir, "store.db"),
          configPath,
          keystoreDir: join(dir, "keys"),
        });
      } finally {
        listenSpy.mockRestore();
      }
    })();
    handles.push(handle);

    expect(homeExistedAtListen).toBe(true);
    expect(handle.executionBroker).toBeDefined();
    expect(handle.homes).toBeDefined();
    await handle.runner.sendPrompt({ agentId: DEFAULT_AGENT_ID, prompt: "escreve" });
    await handle.runner.flush(DEFAULT_AGENT_ID);
    await expect(readFile(join(homeRoot, "Documents", "nota.md"), "utf8")).resolves.toBe("from-boot");
    expect(requests[0]?.tools?.some((tool) => tool.function.name === "process_run")).toBe(true);
    expect(requests[0]?.system).toMatch(/private physical Windows workspace[\s\S]*any mounted drive/i);
  });

  it("keeps Documents physical with shareUserFiles on; an explicit granted reference reaches the real folder", async () => {
    const dir = await tempDir();
    const profile = join(dir, "profile");
    await mkdir(join(profile, "Documents"), { recursive: true });
    const workspacesRoot = join(dir, "workspaces");
    const configPath = join(dir, "config.json");
    seedDefaultConfig(configPath);
    const requests: ProviderChatRequest[] = [];
    const registry = createProviderRegistry();
    const adapter: ProviderAdapter = {
      name: "xai",
      async streamChat(request, emit) {
        requests.push(request);
        if (requests.length % 2 === 1) {
          const granted = requests.length > 2;
          emit({
            type: "tool-call",
            call: {
              id: `w${requests.length}`,
              type: "function",
              function: {
                name: "file",
                arguments: JSON.stringify({
                  op: "write",
                  path: granted ? "shared://Documents/grant.md" : "Documents/nota.md",
                  content: granted ? "from-grant" : "from-profile",
                  encoding: "utf8",
                }),
              },
            },
          });
          return;
        }
        emit({ type: "delta", delta: "gravado" });
      },
    };
    registry.register(adapter);

    const handle = await startServer(0, {
      ...isolatedRoots(dir),
      registry,
      workspacesRoot,
      storePath: join(dir, "store.db"),
      configPath,
      keystoreDir: join(dir, "keys"),
      userProfile: profile,
      shareUserFiles: true,
    });
    handles.push(handle);

    const home = await handle.homes!.ensure(DEFAULT_AGENT_ID);
    await handle.runner.sendPrompt({ agentId: DEFAULT_AGENT_ID, prompt: "escreve" });
    await handle.runner.flush(DEFAULT_AGENT_ID);
    await expect(readFile(join(home.root, "Documents", "nota.md"), "utf8")).resolves.toBe("from-profile");
    await expect(readFile(join(profile, "Documents", "nota.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(profile, "Documents", "OpenBot", DEFAULT_AGENT_ID, "Documents", "nota.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    // Com grant de escrita, a pasta real é montada.
    await writeFile(join(home.root, ".openbot", "grants.json"), `${JSON.stringify({
      version: 1,
      grants: { Documents: { access: "write" } },
    }, null, 2)}\n`);
    await writeFile(join(home.root, ".openbot", "policy.json"), `${JSON.stringify({
      rules: [{ match: { tool: "file.*", path: "**" }, effect: "allow" }],
      default: "allow",
    }, null, 2)}\n`);
    // Free the shared store/config before booting a second server.
    await stopServer(handle);
    handles = handles.filter((entry) => entry !== handle);
    const secondRequests: ProviderChatRequest[] = [];
    const secondRegistry = createProviderRegistry();
    const secondAdapter: ProviderAdapter = {
      name: "xai",
      async streamChat(request, emit) {
        secondRequests.push(request);
        if (secondRequests.length === 1) {
          emit({
            type: "tool-call",
            call: {
              id: "g1",
              type: "function",
              function: {
                name: "file",
                arguments: JSON.stringify({
                  op: "write",
                  path: "shared://Documents/grant.md",
                  content: "from-grant",
                  encoding: "utf8",
                }),
              },
            },
          });
          return;
        }
        emit({ type: "delta", delta: "gravado" });
      },
    };
    secondRegistry.register(secondAdapter);
    const second = await startServer(0, {
      ...isolatedRoots(dir),
      registry: secondRegistry,
      workspacesRoot,
      storePath: join(dir, "store.db"),
      configPath,
      keystoreDir: join(dir, "keys"),
      userProfile: profile,
      shareUserFiles: true,
    });
    handles.push(second);
    await second.homes!.ensure(DEFAULT_AGENT_ID);
    await second.runner.sendPrompt({ agentId: DEFAULT_AGENT_ID, prompt: "escreve de novo" });
    await second.runner.flush(DEFAULT_AGENT_ID);
    await expect(readFile(join(profile, "Documents", "grant.md"), "utf8")).resolves.toBe("from-grant");
    // Restart and a new grant do not move the original private file.
    await expect(readFile(join(home.root, "Documents", "nota.md"), "utf8")).resolves.toBe("from-profile");
    await expect(readFile(join(profile, "Documents", "OpenBot", DEFAULT_AGENT_ID, "Documents", "grant.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ensureForeverBox is idempotent and getForeverBoxStatus stays frozen", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "config.json");
    seedDefaultConfig(configPath);
    const handle = await startServer(0, {
      ...isolatedRoots(dir),
      workspacesRoot: join(dir, "workspaces"),
      storePath: join(dir, "store.db"),
      configPath,
      keystoreDir: join(dir, "keys"),
    });
    handles.push(handle);
    const post = async (method: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.json() as Promise<{ ok: boolean; value: unknown }>;
    };
    const expectedRoot = (await handle.homes!.ensure(DEFAULT_AGENT_ID)).root;
    const first = await post("ensureForeverBox", { agentId: DEFAULT_AGENT_ID });
    const second = await post("ensureForeverBox", { agentId: DEFAULT_AGENT_ID });
    expect(first).toEqual({ ok: true, value: { agentId: DEFAULT_AGENT_ID, state: "ready", vncUrl: null, root: expectedRoot } });
    expect(second).toEqual({ ok: true, value: { agentId: DEFAULT_AGENT_ID, state: "ready", vncUrl: null, root: expectedRoot } });
    const status = await post("getForeverBoxStatus", {});
    expect(status).toEqual({ ok: true, value: { vncUrl: null, windows: [] } });
    const capabilities = await post("getComputerCapabilities", {});
    expect(capabilities).toEqual({ ok: true, value: { local: false, remoteExecution: false, audioTranscription: false } });
    expect(await post("getAgentWhatsapp", { agentId: DEFAULT_AGENT_ID })).toEqual({ error: "unknown method: getAgentWhatsapp" });
    expect(await post("setAgentWhatsapp", { agentId: DEFAULT_AGENT_ID, permission: "never" })).toEqual({ error: "unknown method: setAgentWhatsapp" });
  });

  it("ask in host settings still writes in the private home", async () => {
    const dir = await tempDir();
    const config = new ConfigStore({ configPath: join(dir, "config.json") });
    seedDefaultAgent(config);
    config.setHostSettings({ ...config.snapshot().hostSettings, localToolPermission: "ask" });
    const registry = createProviderRegistry();
    let calls = 0;
    registry.register({
      name: "xai",
      async streamChat(_request, emit) {
        calls += 1;
        if (calls === 1) {
          emit({
            type: "tool-call",
            call: {
              id: "a1",
              type: "function",
              function: {
                name: "file",
                arguments: JSON.stringify({
                  op: "write",
                  path: "Documents/ask.md",
                  content: "ok",
                  encoding: "utf8",
                }),
              },
            },
          });
          return;
        }
        emit({ type: "delta", delta: "ok" });
      },
    });
    const handle = await startServer(0, {
      ...isolatedRoots(dir),
      registry,
      config,
      workspacesRoot: join(dir, "workspaces"),
      storePath: join(dir, "store.db"),
      keystoreDir: join(dir, "keys"),
    });
    handles.push(handle);
    const home = await handle.homes!.ensure(DEFAULT_AGENT_ID);
    const sent = await handle.runner.sendPrompt({ agentId: DEFAULT_AGENT_ID, prompt: "escreve" });
    expect(sent.accepted).toBe(true);
    const deadline = Date.now() + 2_000;
    let pending: string[] = [];
    while (Date.now() < deadline) {
      pending = handle.executionBroker?.pendingRequestIds() ?? [];
      if (pending.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pending.length).toBeGreaterThan(0);
    expect(handle.executionBroker?.resolve(pending[0]!, "allow")).toBe(true);
    await handle.runner.flush(DEFAULT_AGENT_ID);
    await expect(readFile(join(home.root, "Documents", "ask.md"), "utf8")).resolves.toBe("ok");
  });

  it("never in host settings disables home tools without asking", async () => {
    const dir = await tempDir();
    const config = new ConfigStore({ configPath: join(dir, "config.json") });
    seedDefaultAgent(config);
    config.setHostSettings({ ...config.snapshot().hostSettings, localToolPermission: "never" });
    const requests: ProviderChatRequest[] = [];
    const registry = createProviderRegistry();
    registry.register({
      name: "xai",
      async streamChat(request, emit) {
        requests.push(request);
        if (requests.length === 1) {
          emit({
            type: "tool-call",
            call: {
              id: "n1",
              type: "function",
              function: {
                name: "file",
                arguments: JSON.stringify({
                  op: "write",
                  path: "Documents/blocked.md",
                  content: "nope",
                  encoding: "utf8",
                }),
              },
            },
          });
          return;
        }
        emit({ type: "delta", delta: "recusado" });
      },
    });
    const handle = await startServer(0, {
      ...isolatedRoots(dir),
      registry,
      config,
      workspacesRoot: join(dir, "workspaces"),
      storePath: join(dir, "store.db"),
      keystoreDir: join(dir, "keys"),
    });
    handles.push(handle);
    const home = await handle.homes!.ensure(DEFAULT_AGENT_ID);
    await handle.runner.sendPrompt({ agentId: DEFAULT_AGENT_ID, prompt: "escreve" });
    await handle.runner.flush(DEFAULT_AGENT_ID);
    await expect(readFile(join(home.root, "Documents", "blocked.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(handle.executionBroker?.pendingRequestIds()).toEqual([]);
    expect(JSON.stringify(requests[1]?.messages)).toContain("permission_denied");
    expect(JSON.stringify(requests[1]?.messages)).toContain("Local tools are disabled.");
  });

  it("disableAgentHome keeps chat-only bootstrap", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "config.json");
    seedDefaultConfig(configPath);
    const requests: ProviderChatRequest[] = [];
    const registry = createProviderRegistry();
    registry.register({
      name: "xai",
      async streamChat(request, emit) {
        requests.push(request);
        emit({ type: "delta", delta: "chat-ok" });
      },
    });
    const handle = await startServer(0, {
      ...isolatedRoots(dir),
      disableAgentHome: true,
      registry,
      storePath: join(dir, "store.db"),
      configPath,
      keystoreDir: join(dir, "keys"),
    });
    handles.push(handle);
    expect(handle.homes).toBeUndefined();
    expect(handle.executionBroker).toBeUndefined();
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/ensureForeverBox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: DEFAULT_AGENT_ID }),
    });
    expect(response.status).toBe(503);
    expect(await handle.runner.sendPrompt({ agentId: DEFAULT_AGENT_ID, prompt: "somente chat" })).toMatchObject({ accepted: true });
    await handle.runner.flush(DEFAULT_AGENT_ID);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.some((request) => request.messages.some((message) => message.role === "user" && message.content === "somente chat"))).toBe(true);
    await expect(response.json()).resolves.toMatchObject({ ok: false, failure: "workspace local indisponível" });
  });

  it("boot novo permanece vazio e não cria home default", async () => {
    const dir = await tempDir();
    const workspacesRoot = join(dir, "workspaces");
    const handle = await startServer(0, {
      ...isolatedRoots(dir),
      workspacesRoot,
      storePath: join(dir, "store.db"),
      configPath: join(dir, "config.json"),
      keystoreDir: join(dir, "keys"),
    });
    handles.push(handle);

    expect(handle.config.snapshot().agents).toEqual([]);
    expect(handle.homes).toBeDefined();
    await expect(readFile(join(workspacesRoot, DEFAULT_AGENT_ID, ".openbot", "home.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
