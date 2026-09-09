import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigStore } from "../src/config/store.js";
import { registerMcpHandlers, type McpRpcHandler } from "../src/rpc/mcp.js";
import { McpManager } from "../src/mcp/manager.js";

type Registered = Map<string, McpRpcHandler>;

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "openbot-rpc-mcp-"));
  tempRoots.push(value);
  return value;
}

function register(options: Parameters<typeof registerMcpHandlers>[1]): Registered {
  const handlers: Registered = new Map();
  registerMcpHandlers({
    registerHandler(method: string, handler: McpRpcHandler) {
      handlers.set(method, handler);
    },
    publish: vi.fn(),
  } as never, options);
  return handlers;
}

function configWithServer(): ConfigStore {
  const config = new ConfigStore({ configPath: join(root(), "config.json") });
  config.update({
    mcpServers: [{
      id: "remote",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      headers: { authorization: { secretRef: "mcp/remote/auth" } },
    }],
    agents: [{
      id: "bot-a",
      name: "Bot A",
      avatarId: "bot-a",
      integrations: { mcp: { enabled: true, serverAllowlist: ["remote"] } },
    }],
  });
  return config;
}

function managerWithTools(description = "Search the web"): McpManager {
  return new McpManager({
    dnsLookup: async () => ["93.184.216.34"],
    secretResolver: () => "test-secret",
    connector: async () => ({
      async listTools() {
        return {
          tools: [
            { name: "search", description, inputSchema: { type: "object" } },
          ],
        };
      },
      async callTool() { return { content: [] }; },
      async close() {},
    }),
  });
}

describe("MCP RPC adapter", () => {
  it("lists only safe server metadata and reports configured status without probing", async () => {
    const config = configWithServer();
    const manager = managerWithTools();
    manager.setServer(config.snapshot().mcpServers![0]!);
    const handlers = register({ config, mcpManager: manager });

    const servers = await handlers.get("listMcpServers")!({ agentId: "bot-a" }, {} as never) as Array<Record<string, unknown>>;

    expect(servers).toEqual([expect.objectContaining({
      id: "remote",
      transport: "http",
      host: "mcp.example.test",
      path: "/mcp",
      status: "configured",
    })]);
    const encoded = JSON.stringify(servers);
    expect(encoded).not.toContain("?token");
    expect(encoded).not.toContain("mcp/remote/auth");
    expect(encoded).not.toContain("authorization");
    expect(encoded).not.toContain("toolCount");
  });

  it("probes explicitly and returns bounded tool metadata without input schemas", async () => {
    const config = configWithServer();
    const manager = managerWithTools("🙂".repeat(600));
    manager.setServer(config.snapshot().mcpServers![0]!);
    const handlers = register({ config, mcpManager: manager });

    const servers = await handlers.get("listMcpServers")!({ agentId: "bot-a", includeTools: true }, {} as never) as Array<Record<string, unknown>>;
    expect(servers[0]).toMatchObject({ status: "available", toolCount: 1 });

    const tools = await handlers.get("listMcpTools")!({ agentId: "bot-a" }, {} as never) as Array<Record<string, unknown>>;
    expect(tools).toEqual([{
      name: "mcp__remote__search",
      serverId: "remote",
      toolName: "search",
      description: expect.any(String),
    }]);
    const description = tools[0]!.description as string;
    expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(2_048);
    expect(description).not.toContain("�");
    expect(description.endsWith("...")).toBe(true);
    expect(JSON.stringify(tools)).not.toContain("inputSchema");
  });

  it("reports each server independently when one connector is unavailable", async () => {
    const config = configWithServer();
    config.update({
      mcpServers: [
        ...config.snapshot().mcpServers!,
        { id: "healthy", transport: "http", url: "https://mcp.example.test/healthy" },
      ],
      agents: [{
        ...config.snapshot().agents[0]!,
        integrations: { mcp: { enabled: true, serverAllowlist: ["remote", "healthy"] } },
      }],
    });
    const manager = new McpManager({
      dnsLookup: async () => ["93.184.216.34"],
      connector: async (server) => {
        if (server.id === "remote") throw new Error("remote unavailable");
        return {
          async listTools() { return { tools: [{ name: "search", inputSchema: { type: "object" } }] }; },
          async callTool() { return { content: [] }; },
          async close() {},
        };
      },
    });
    for (const server of config.snapshot().mcpServers ?? []) manager.setServer(server);
    const handlers = register({ config, mcpManager: manager });

    const servers = await handlers.get("listMcpServers")!({ agentId: "bot-a", includeTools: true }, {} as never) as Array<Record<string, unknown>>;
    expect(servers).toEqual([
      expect.objectContaining({ id: "remote", status: "error", error: "unavailable" }),
      expect.objectContaining({ id: "healthy", status: "available", toolCount: 1 }),
    ]);
  });

  it("does not expose disabled servers to a bot and rejects unknown agents", async () => {
    const config = configWithServer();
    config.update({ agents: [{
      id: "bot-a",
      name: "Bot A",
      avatarId: "bot-a",
      integrations: { mcp: { enabled: false, serverAllowlist: ["remote"] } },
    }] });
    const manager = managerWithTools();
    manager.setServer(config.snapshot().mcpServers![0]!);
    const handlers = register({ config, mcpManager: manager });

    expect(await handlers.get("listMcpServers")!({ agentId: "bot-a", includeTools: true }, {} as never)).toEqual([
      expect.objectContaining({ id: "remote", status: "disabled" }),
    ]);
    await expect(handlers.get("listMcpTools")!({ agentId: "missing" }, {} as never)).rejects.toMatchObject({ status: 404 });
  });

  it("updates only the selected agent, persists the policy and refreshes manager policy", async () => {
    const config = configWithServer();
    config.update({ agents: [
      ...config.snapshot().agents,
      { id: "bot-b", name: "Bot B", avatarId: "bot-b" },
    ] });
    const manager = managerWithTools();
    manager.setServer(config.snapshot().mcpServers![0]!);
    const setAgentPolicy = vi.spyOn(manager, "setAgentPolicy");
    const handlers = register({ config, mcpManager: manager });

    const value = await handlers.get("setAgentIntegrationPolicy")!({
      agentId: "bot-a",
      policy: { enabled: true, serverAllowlist: ["remote"], toolDenylist: ["search"] },
    }, {} as never);

    expect(value).toEqual({ agentId: "bot-a", mcp: expect.objectContaining({ toolDenylist: ["search"] }) });
    expect(config.snapshot().agents.find((agent) => agent.id === "bot-a")?.integrations?.mcp?.toolDenylist).toEqual(["search"]);
    expect(config.snapshot().agents.find((agent) => agent.id === "bot-b")?.integrations).toBeUndefined();
    expect(setAgentPolicy).toHaveBeenCalledWith("bot-a", expect.objectContaining({ toolDenylist: ["search"] }));
  });

  it("merges concurrent server and policy mutations from stale store instances", async () => {
    const path = join(root(), "concurrent-config.json");
    const first = new ConfigStore({ configPath: path });
    first.update({ agents: [{ id: "bot-a", name: "Bot A", avatarId: "bot-a" }] });
    const second = new ConfigStore({ configPath: path });
    const firstHandlers = register({ config: first });
    const secondHandlers = register({ config: second });

    await Promise.all([
      firstHandlers.get("setAgentIntegrationPolicy")!({
        agentId: "bot-a",
        policy: { enabled: true, serverAllowlist: [] },
      }, {} as never),
      secondHandlers.get("upsertMcpServer")!({
        server: { id: "local", transport: "http", url: "http://127.0.0.1:4545/mcp" },
      }, {} as never),
    ]);

    const reopened = new ConfigStore({ configPath: path }).snapshot();
    expect(reopened.mcpServers?.map((server) => server.id)).toEqual(["local"]);
    expect(reopened.agents[0]?.integrations?.mcp).toMatchObject({ enabled: true, serverAllowlist: [] });
  });

  it("upserts/removes servers through config and manager and publishes only a light event", async () => {
    const config = configWithServer();
    const manager = managerWithTools();
    manager.setServer(config.snapshot().mcpServers![0]!);
    const gateway = { registerHandler: vi.fn(), publish: vi.fn() };
    const handlers: Registered = new Map();
    registerMcpHandlers(gateway as never, { config, mcpManager: manager });
    for (const [method, handler] of gateway.registerHandler.mock.calls) handlers.set(method, handler);

    const upserted = await handlers.get("upsertMcpServer")!({
      server: { id: "local", transport: "http", url: "http://127.0.0.1:4545/mcp", sessionScope: "agent" },
    }, {} as never);
    expect(config.snapshot().mcpServers?.map((server) => server.id)).toEqual(["remote", "local"]);
    expect(upserted).toMatchObject({ id: "local", sessionScope: "agent" });
    expect(gateway.publish).toHaveBeenCalledWith("mcp-servers", expect.objectContaining({ type: "upserted" }));
    expect(JSON.stringify(gateway.publish.mock.calls)).not.toContain("secretRef");

    await handlers.get("removeMcpServer")!({ id: "local" }, {} as never);
    expect(config.snapshot().mcpServers?.map((server) => server.id)).toEqual(["remote"]);
    expect(gateway.publish).toHaveBeenCalledWith("mcp-servers", expect.objectContaining({ type: "removed", id: "local" }));
  });

  it("rolls back both config and manager when replacing a live server fails", async () => {
    const config = configWithServer();
    const manager = managerWithTools();
    const original = config.snapshot().mcpServers![0];
    manager.setServer(original!);
    const replace = vi.spyOn(manager, "replaceServer").mockImplementationOnce(() => { throw new Error("activation failed"); });
    const handlers = register({ config, mcpManager: manager });

    await expect(handlers.get("upsertMcpServer")!({
      server: { id: "remote", transport: "http", url: "http://127.0.0.1:4545/replaced" },
    }, {} as never)).rejects.toMatchObject({ status: 400 });
    expect(config.snapshot().mcpServers).toEqual([original]);
    expect(manager.getServer("remote")).toEqual(original);
    expect(replace).toHaveBeenCalledTimes(2);
  });

  it("never accepts an inline secret and requires an injected keystore for setMcpSecret", async () => {
    const config = configWithServer();
    const handlers = register({ config });

    await expect(handlers.get("upsertMcpServer")!({
      server: { id: "bad", transport: "http", url: "https://mcp.example.test", headers: { authorization: "inline" } },
    }, {} as never)).rejects.toMatchObject({ status: 400 });
    await expect(handlers.get("setMcpSecret")!({ secretRef: "mcp/remote/auth", value: "secret" }, {} as never)).rejects.toMatchObject({ status: 503 });
  });
});
