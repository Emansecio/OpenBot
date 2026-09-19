import { describe, expect, it, vi } from "vitest";
import { ProtocolError } from "@modelcontextprotocol/client";
import type { CallToolResult, ListToolsRequest, ListToolsResult, Tool } from "@modelcontextprotocol/client";
import { createPinnedDnsLookup, McpManager, McpPolicyError, McpResultLimitError, McpValidationError, type McpClientSession } from "../src/mcp/manager.js";
import { fromMcpProviderToolName, toMcpProviderToolName } from "../src/mcp/contracts.js";
import type { McpHttpServerConfig, McpServerConfig } from "../src/mcp/contracts.js";
import { MAX_MCP_RESULT_BYTES, MAX_MCP_SERVERS, MAX_MCP_TIMEOUT_MS, MAX_MCP_TOOLS } from "../src/mcp/security.js";

const tool = (name: string, description = `${name} description`): Tool => ({
  name,
  description,
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
});

const result = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

function fakeSession(tools: Tool[], calls: string[] = [], delayMs = 0): McpClientSession {
  return {
    async listTools(): Promise<ListToolsResult> { return { tools }; },
    async callTool(params, options): Promise<CallToolResult> {
      calls.push(params.name);
      if (delayMs > 0) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        options?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal?.reason ?? new Error("aborted")); }, { once: true });
      });
      return result(String((params.arguments as { value?: unknown } | undefined)?.value ?? "ok"));
    },
    async close() {},
  };
}

const server: McpHttpServerConfig = { id: "demo", transport: "http", url: "http://127.0.0.1:8787/mcp" };

describe("MCP provider tool naming", () => {
  it("maps names reversibly while retaining the provider contract", () => {
    const provider = toMcpProviderToolName("demo_server", "read_file");
    expect(provider).toBe("mcp__demo_server__read_file");
    expect(fromMcpProviderToolName(provider)).toEqual({ serverId: "demo_server", toolName: "read_file" });
    expect(() => fromMcpProviderToolName("mcp__demo__bad__name")).toThrow();
  });
});

describe("McpManager", () => {
  it("supports both Node DNS lookup callback shapes used by Undici", () => {
    const lookup = createPinnedDnsLookup(new URL("https://mcp.example.test/mcp"), "203.0.113.8", 4);
    const all = vi.fn();
    lookup("mcp.example.test", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: "203.0.113.8", family: 4 }]);

    const one = vi.fn();
    lookup("mcp.example.test", { all: false }, one);
    expect(one).toHaveBeenCalledWith(null, "203.0.113.8", 4);
  });

  it("matches server allowlists case-insensitively while retaining the configured provider id", async () => {
    const manager = new McpManager({
      servers: [{ ...server, id: "Demo" }],
      connector: async () => fakeSession([tool("echo")]),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });
    await expect(manager.listProviderTools("bot")).resolves.toEqual([
      expect.objectContaining({ serverId: "Demo", function: expect.objectContaining({ name: "mcp__Demo__echo" }) }),
    ]);
    expect(manager.getServer("DEMO")).toMatchObject({ id: "Demo" });
    await manager.close();
  });

  it("uses the same hard limits at manager construction and server registration", () => {
    expect(() => new McpManager({ timeoutMs: MAX_MCP_TIMEOUT_MS + 1 })).toThrow();
    expect(() => new McpManager({ maxResultBytes: MAX_MCP_RESULT_BYTES + 1 })).toThrow();
    expect(() => new McpManager({ servers: [{ ...server, timeoutMs: MAX_MCP_TIMEOUT_MS + 1 }] })).toThrow();
    expect(() => new McpManager({ servers: [{ ...server, maxResultBytes: MAX_MCP_RESULT_BYTES + 1 }] })).toThrow();
  });

  it("keeps the shared server cap when replaceServer inserts a new id", () => {
    const manager = new McpManager({
      servers: Array.from({ length: MAX_MCP_SERVERS }, (_, index) => ({ ...server, id: `server-${index}` })),
    });
    expect(() => manager.replaceServer({ ...server, id: "server-new" })).toThrow(McpValidationError);
  });

  it("rejects a per-call HTTP byte limit below the transport limit", async () => {
    const manager = new McpManager({
      servers: [server],
      connector: async () => fakeSession([tool("echo")]),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });
    await expect(manager.listProviderTools("bot", { maxResultBytes: 1 })).rejects.toThrow(McpValidationError);
    await manager.close();
  });

  it("shares one lazy connection and isolates agent policies", async () => {
    const calls: string[] = [];
    const connect = vi.fn(async () => fakeSession([tool("allowed"), tool("blocked")], calls));
    const manager = new McpManager({
      servers: [server],
      connector: connect,
      policies: {
        good: { enabled: true, serverAllowlist: ["demo"], toolAllowlist: ["allowed"] },
        bad: { enabled: true, serverAllowlist: ["demo"], toolAllowlist: [], toolDenylist: ["allowed"] },
      },
    });

    const [first, second] = await Promise.all([manager.listProviderTools("good"), manager.listProviderTools("good")]);
    expect(first.map((item) => item.function.name)).toEqual(["mcp__demo__allowed"]);
    expect(second).toEqual(first);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(await manager.listProviderTools("bad")).toEqual([]);
    await expect(manager.callProviderTool("bad", "mcp__demo__allowed", { value: "x" })).rejects.toThrow(McpPolicyError);
    await manager.close();
  });

  it("isola conexão e estado do servidor por bot quando sessionScope é agent", async () => {
    let connectionId = 0;
    const connect = vi.fn(async () => {
      const id = ++connectionId;
      return {
        ...fakeSession([tool("identity")]),
        async callTool() { return result(`session-${id}`); },
      };
    });
    const manager = new McpManager({
      servers: [{ ...server, sessionScope: "agent" }],
      connector: connect,
      policies: {
        "bot-a": { enabled: true, serverAllowlist: ["demo"] },
        "bot-b": { enabled: true, serverAllowlist: ["demo"] },
      },
    });

    await manager.listProviderTools("bot-a");
    await manager.listProviderTools("bot-b");
    await expect(manager.callProviderTool("bot-a", "mcp__demo__identity", {})).resolves.toEqual(result("session-1"));
    await expect(manager.callProviderTool("bot-b", "mcp__demo__identity", {})).resolves.toEqual(result("session-2"));
    expect(connect).toHaveBeenCalledTimes(2);
    await manager.close();
  });

  it("fecha somente a sessão MCP isolada do bot removido", async () => {
    const closes = [vi.fn(async () => {}), vi.fn(async () => {})];
    let connection = 0;
    const manager = new McpManager({
      servers: [{ ...server, sessionScope: "agent" }],
      connector: async () => {
        const index = connection++;
        return { ...fakeSession([tool("echo")]), close: closes[index]! };
      },
      policies: {
        "bot-a": { enabled: true, serverAllowlist: ["demo"] },
        "bot-b": { enabled: true, serverAllowlist: ["demo"] },
      },
    });

    await manager.listProviderTools("bot-a");
    await manager.listProviderTools("bot-b");
    manager.removeAgent("bot-a");
    await vi.waitFor(() => expect(closes[0]).toHaveBeenCalledTimes(1));
    expect(closes[1]).not.toHaveBeenCalled();
    await expect(manager.callProviderTool("bot-b", "mcp__demo__echo", {})).resolves.toMatchObject({ content: [{ text: "ok" }] });
    expect(connection).toBe(2);
    await manager.close();
    expect(closes[1]).toHaveBeenCalledTimes(1);
  });

  it("deduplicates and caches metadata across listings and calls", async () => {
    let listCalls = 0;
    const manager = new McpManager({
      servers: [server],
      connector: async () => ({
        ...fakeSession([tool("echo")]),
        async listTools() {
          listCalls += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          return { tools: [tool("echo")] };
        },
      }),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    await Promise.all([
      manager.listProviderTools("bot"),
      manager.listProviderTools("bot"),
      manager.callProviderTool("bot", "mcp__demo__echo", {}),
    ]);
    expect(listCalls).toBe(1);
    await manager.close();
  });

  it("follows MCP tool-list cursors before validating call availability", async () => {
    const cursors: Array<string | undefined> = [];
    const manager = new McpManager({
      servers: [server],
      connector: async () => ({
        ...fakeSession([]),
        async listTools(params: ListToolsRequest["params"]) {
          cursors.push(params?.cursor);
          return params?.cursor === undefined
            ? { tools: [tool("first")], nextCursor: "page-2" }
            : { tools: [tool("second")] };
        },
      }),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    await expect(manager.callProviderTool("bot", "mcp__demo__second", {})).resolves.toMatchObject({ content: [{ text: "ok" }] });
    expect(cursors).toEqual([undefined, "page-2"]);
    await manager.close();
  });

  it("rejects a repeated MCP tool-list cursor instead of looping", async () => {
    let calls = 0;
    const manager = new McpManager({
      servers: [server],
      connector: async () => ({
        ...fakeSession([]),
        async listTools() {
          calls += 1;
          return { tools: [tool("echo")], nextCursor: "same" };
        },
      }),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    await expect(manager.listProviderTools("bot")).rejects.toThrow(/cursor repeated/iu);
    expect(calls).toBe(2);
    await manager.close();
  });

  it("treats an empty MCP cursor as opaque and follows it", async () => {
    const cursors: Array<string | undefined> = [];
    const manager = new McpManager({
      servers: [server],
      connector: async () => ({
        ...fakeSession([]),
        async listTools(params: ListToolsRequest["params"]) {
          cursors.push(params?.cursor);
          return params?.cursor === undefined
            ? { tools: [tool("first")], nextCursor: "" }
            : { tools: [tool("second")] };
        },
      }),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    await expect(manager.callProviderTool("bot", "mcp__demo__second", {})).resolves.toMatchObject({ content: [{ text: "ok" }] });
    expect(cursors).toEqual([undefined, ""]);
    await manager.close();
  });

  it("stops paginated listing when agent removal cancels between pages", async () => {
    let manager!: McpManager;
    const cursors: Array<string | undefined> = [];
    const connector = async () => ({
      ...fakeSession([]),
      async listTools(params: ListToolsRequest["params"]) {
        cursors.push(params?.cursor);
        if (params?.cursor === undefined) {
          queueMicrotask(() => manager.removeAgent("bot"));
          return { tools: [tool("first")], nextCursor: "page-2" };
        }
        throw new Error("second page should not be requested");
      },
    });
    manager = new McpManager({
      servers: [{ ...server, sessionScope: "agent" }],
      connector,
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    await expect(manager.listProviderTools("bot")).rejects.toThrow(/aborted|listing failed/iu);
    expect(cursors).toEqual([undefined]);
    await manager.close();
  });

  it("rejects a paginated MCP catalog that exceeds the tool limit", async () => {
    const manager = new McpManager({
      servers: [server],
      connector: async () => ({
        ...fakeSession([]),
        async listTools() {
          return { tools: Array.from({ length: MAX_MCP_TOOLS + 1 }, (_, index) => tool(`tool-${index}`)) };
        },
      }),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    await expect(manager.listProviderTools("bot")).rejects.toThrow(/tool count exceeds/iu);
    await manager.close();
  });

  it("applies the byte budget across paginated MCP responses", async () => {
    const manager = new McpManager({
      servers: [{ ...server, maxResultBytes: 500 }],
      connector: async () => ({
        ...fakeSession([]),
        async listTools(params: ListToolsRequest["params"]) {
          return params?.cursor === undefined
            ? { tools: [tool("first")], nextCursor: "x".repeat(200) }
            : { tools: [tool("second")], nextCursor: "y".repeat(200) };
        },
      }),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    await expect(manager.listProviderTools("bot")).rejects.toThrow(McpResultLimitError);
    await manager.close();
  });

  it("invalidates metadata when a server is replaced", async () => {
    let listCalls = 0;
    const manager = new McpManager({
      servers: [server],
      connector: async (config) => ({
        ...fakeSession([tool(config.id === "demo" && "url" in config && config.url === server.url ? "old" : "new")]),
        async listTools() {
          listCalls += 1;
          return { tools: [tool(config.id === "demo" && "url" in config && config.url === server.url ? "old" : "new")] };
        },
      }),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    await expect(manager.listProviderTools("bot")).resolves.toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: "mcp__demo__old" }) }),
    ]);
    manager.replaceServer({ ...server, url: "http://127.0.0.1:8788/mcp" });
    await expect(manager.listProviderTools("bot")).resolves.toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: "mcp__demo__new" }) }),
    ]);
    expect(listCalls).toBe(2);
    await manager.close();
  });

  it("refreshes metadata after the configured TTL", async () => {
    vi.useFakeTimers();
    try {
      let listCalls = 0;
      const manager = new McpManager({
        servers: [server],
        toolCacheTtlMs: 100,
        connector: async () => ({
          ...fakeSession([tool("echo")]),
          async listTools() {
            listCalls += 1;
            return { tools: [tool("echo")] };
          },
        }),
        policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
      });

      await manager.listProviderTools("bot");
      vi.advanceTimersByTime(101);
      await manager.listProviderTools("bot");
      expect(listCalls).toBe(2);
      await manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("negative-caches discovery failures until server configuration changes", async () => {
    const connect = vi.fn(async () => { throw new Error("offline"); });
    const manager = new McpManager({
      servers: [server],
      connector: connect,
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    await expect(manager.listProviderTools("bot")).rejects.toThrow();
    await expect(manager.listProviderTools("bot")).rejects.toThrow();
    expect(connect).toHaveBeenCalledTimes(1);

    manager.replaceServer({ ...server, url: "http://127.0.0.1:8788/mcp" });
    await expect(manager.listProviderTools("bot")).rejects.toThrow();
    expect(connect).toHaveBeenCalledTimes(2);
    await manager.close();
  });

  it("invalidates a missing-secret negative cache when that secret changes", async () => {
    let secret: string | undefined;
    const resolveSecret = vi.fn(async () => {
      if (secret === undefined) throw new Error("missing");
      return secret;
    });
    const manager = new McpManager({
      servers: [{ ...server, headers: { Authorization: { secretRef: "demo-token" } } }],
      secretResolver: resolveSecret,
      connector: async () => fakeSession([tool("echo")]),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    await expect(manager.listProviderTools("bot")).rejects.toThrow();
    await expect(manager.listProviderTools("bot")).rejects.toThrow();
    expect(resolveSecret).toHaveBeenCalledTimes(1);

    secret = "Bearer test";
    manager.invalidateSecret("demo-token");
    await expect(manager.listProviderTools("bot")).resolves.toHaveLength(1);
    expect(resolveSecret).toHaveBeenCalledTimes(2);
    await manager.close();
  });

  it("keeps a deduplicated metadata request alive for remaining callers after one aborts", async () => {
    let release!: () => void;
    let started!: () => void;
    const listingStarted = new Promise<void>((resolve) => { started = resolve; });
    const manager = new McpManager({
      servers: [server],
      connector: async () => ({
        ...fakeSession([tool("echo")]),
        async listTools(_params, options) {
          started();
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason ?? new Error("aborted")), { once: true });
          });
          return { tools: [tool("echo")] };
        },
      }),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    const controller = new AbortController();
    const aborted = manager.listProviderTools("bot", { signal: controller.signal });
    await listingStarted;
    const remaining = manager.listProviderTools("bot");
    controller.abort();
    await expect(aborted).rejects.toThrow(/aborted/i);
    release();
    await expect(remaining).resolves.toHaveLength(1);
    await manager.close();
  });

  it("limits concurrent server listings while preserving configured order", async () => {
    const configs: McpHttpServerConfig[] = [
      server,
      { ...server, id: "second", url: "http://127.0.0.1:8788/mcp" },
      { ...server, id: "third", url: "http://127.0.0.1:8789/mcp" },
    ];
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    let maxActive = 0;
    let active = 0;
    let firstBatchStarted!: () => void;
    const firstBatch = new Promise<void>((resolve) => { firstBatchStarted = resolve; });
    let thirdStarted!: () => void;
    const third = new Promise<void>((resolve) => { thirdStarted = resolve; });
    const manager = new McpManager({
      servers: configs,
      maxListConcurrency: 2,
      connector: async (config) => ({
        ...fakeSession([tool("echo")]),
        async listTools() {
          active += 1;
          maxActive = Math.max(maxActive, active);
          started.push(config.id);
          if (started.length === 2) firstBatchStarted();
          if (config.id === "third") thirdStarted();
          await new Promise<void>((resolve) => { releases.set(config.id, resolve); });
          active -= 1;
          return { tools: [tool("echo")] };
        },
      }),
      policies: { bot: { enabled: true, serverAllowlist: ["demo", "second", "third"] } },
    });

    const listing = manager.listProviderTools("bot");
    await firstBatch;
    expect(started).toEqual(["demo", "second"]);
    releases.get("demo")?.();
    releases.get("second")?.();
    await third;
    releases.get("third")?.();

    await expect(listing).resolves.toEqual([
      expect.objectContaining({ serverId: "demo" }),
      expect.objectContaining({ serverId: "second" }),
      expect.objectContaining({ serverId: "third" }),
    ]);
    expect(maxActive).toBe(2);
    await manager.close();
  });

  it("removes an agent policy without affecting the default policy", () => {
    const manager = new McpManager({ defaultPolicy: { enabled: true, serverAllowlist: ["demo"] } });
    manager.setAgentPolicy("deleted-bot", { enabled: true, serverAllowlist: ["demo"] });
    manager.removeAgent("deleted-bot");
    expect(manager.getAgentPolicy("deleted-bot")).toEqual({ enabled: true, serverAllowlist: ["demo"] });
  });

  it("revalidates policy at call time and calls/list tools through the injected SDK-shaped session", async () => {
    const calls: string[] = [];
    const session = fakeSession([tool("echo")], calls);
    const manager = new McpManager({ servers: [server], connector: async () => session, policies: { bot: { enabled: true, serverAllowlist: ["demo"] } } });
    const tools = await manager.listProviderTools("bot");
    expect(tools[0]?.function).toMatchObject({ name: "mcp__demo__echo", parameters: { type: "object" } });
    expect(await manager.callProviderTool("bot", "mcp__demo__echo", { value: "hello" })).toMatchObject({ content: [{ text: "hello" }] });
    expect(calls).toEqual(["echo"]);
    manager.setAgentPolicy("bot", { enabled: false, serverAllowlist: ["demo"] });
    await expect(manager.callProviderTool("bot", "mcp__demo__echo", {})).rejects.toThrow(McpPolicyError);
  });

  it("propagates abort/timeout and enforces result bytes", async () => {
    const manager = new McpManager({
      servers: [server],
      connector: async () => fakeSession([tool("slow")], [], 1000),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
      timeoutMs: 20,
    });
    await expect(manager.callProviderTool("bot", "mcp__demo__slow", {})).rejects.toThrow(/timed out/i);
    await manager.close();

    const large = new McpManager({
      servers: [server],
      connector: async () => ({ ...fakeSession([tool("large")]), async callTool() { return result("x".repeat(100)); } }),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
      maxResultBytes: 32,
    });
    await expect(large.callProviderTool("bot", "mcp__demo__large", {})).rejects.toThrow(McpResultLimitError);
    await large.close();
  });

  it("applies one absolute timeout budget across tool listing and invocation", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const manager = new McpManager({
      servers: [server],
      connector: async () => ({
        async listTools(_params, options) {
          await new Promise<void>((resolve) => setTimeout(resolve, 40));
          if (options?.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
          return { tools: [tool("echo")] };
        },
        async callTool(params, options) {
          calls += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 40));
          if (options?.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
          return result(params.name);
        },
        async close() {},
      }),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
      timeoutMs: 50,
    });

    try {
      const started = Date.now();
      const invocation = manager.callProviderTool("bot", "mcp__demo__echo", {});
      const timedOut = expect(invocation).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(40);
      // Listing has completed, so the invocation must have started before the
      // remaining ten milliseconds of the one shared budget are consumed.
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      await timedOut;
      expect(Date.now() - started).toBe(50);
    } finally {
      vi.useRealTimers();
      await manager.close();
    }
  });

  it("allows listing and invocation when the shared timeout budget is sufficient", async () => {
    vi.useFakeTimers();
    const manager = new McpManager({
      servers: [server],
      connector: async () => ({
        async listTools() {
          await new Promise<void>((resolve) => setTimeout(resolve, 40));
          return { tools: [tool("echo")] };
        },
        async callTool(params) {
          await new Promise<void>((resolve) => setTimeout(resolve, 40));
          return result(params.name);
        },
        async close() {},
      }),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
      timeoutMs: 150,
    });

    try {
      const invocation = manager.callProviderTool("bot", "mcp__demo__echo", {});
      await vi.advanceTimersByTimeAsync(80);
      await expect(invocation).resolves.toMatchObject({ content: [{ text: "echo" }] });
    } finally {
      await manager.close();
      vi.useRealTimers();
    }
  });

  it("closes every connected server", async () => {
    const closed: string[] = [];
    const configs: McpServerConfig[] = [server, { ...server, id: "second", url: "http://127.0.0.1:8788/mcp" }];
    const manager = new McpManager({
      servers: configs,
      connector: async (config) => ({ ...fakeSession([tool("echo")]), async close() { closed.push(config.id); } }),
      policies: { bot: { enabled: true, serverAllowlist: ["demo", "second"] } },
    });
    await manager.listProviderTools("bot");
    await manager.close();
    expect(closed.sort()).toEqual(["demo", "second"]);
  });

  it("drops untrusted oversized metadata and sanitizes remote connector errors", async () => {
    const oversized: Tool = {
      name: "oversized",
      description: "x".repeat(9 * 1024),
      inputSchema: { type: "object", properties: {} },
    };
    const manager = new McpManager({
      servers: [server],
      connector: async () => fakeSession([oversized]),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });
    expect(await manager.listProviderTools("bot")).toEqual([]);
    await manager.close();

    const broken = new McpManager({
      servers: [server],
      connector: async () => ({
        ...fakeSession([]),
        async listTools() { throw new Error("https://user:secret@example.com/C:/private/token"); },
      }),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });
    await expect(broken.listProviderTools("bot")).rejects.toThrow("MCP tool listing failed");
    await expect(broken.listProviderTools("bot")).rejects.not.toThrow(/example\.com|private|secret/);
    await broken.close();
  });

  it("invalidates a failed transport session and reconnects after cache invalidation", async () => {
    const closes: string[] = [];
    let connection = 0;
    const manager = new McpManager({
      servers: [server],
      connector: async () => {
        connection += 1;
        const current = connection;
        return {
          ...fakeSession([tool("echo")]),
          async listTools() {
            if (current === 1) throw new Error("transport connection closed");
            return { tools: [tool("echo")] };
          },
          async close() { closes.push(`session-${current}`); },
        };
      },
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    await expect(manager.listProviderTools("bot")).rejects.toThrow("MCP tool listing failed");
    await expect(manager.listProviderTools("bot")).rejects.toThrow("MCP tool listing failed");
    expect(connection).toBe(1);
    expect(closes).toEqual(["session-1"]);

    manager.replaceServer(server);
    await expect(manager.listProviderTools("bot")).resolves.toHaveLength(1);
    expect(connection).toBe(2);
    await manager.close();
  });

  it("fails a transport call once without retrying and reconnects the next operation", async () => {
    let connection = 0;
    let calls = 0;
    const manager = new McpManager({
      servers: [server],
      connector: async () => {
        connection += 1;
        const current = connection;
        return {
          ...fakeSession([tool("echo")]),
          async callTool(params: { name: string }) {
            calls += 1;
            if (current === 1) throw new Error("transport connection reset");
            return result(params.name);
          },
        };
      },
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    await expect(manager.callProviderTool("bot", "mcp__demo__echo", {})).rejects.toThrow("MCP tool call failed");
    expect(calls).toBe(1);
    await expect(manager.callProviderTool("bot", "mcp__demo__echo", {})).resolves.toMatchObject({ content: [{ text: "echo" }] });
    expect(connection).toBe(2);
    expect(calls).toBe(2);
    await manager.close();
  });

  it("keeps a shared reconnect alive when only the first bot times out", async () => {
    vi.useFakeTimers();
    let connection = 0;
    const manager = new McpManager({
      servers: [server],
      connector: async (_config, context) => {
        connection += 1;
        const current = connection;
        if (current === 2) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 100);
            context.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(context.signal?.reason ?? new Error("aborted"));
            }, { once: true });
          });
        }
        return {
          ...fakeSession([tool("echo")]),
          async callTool() {
            if (current === 1) throw new Error("transport connection reset");
            return result("echo");
          },
        };
      },
      policies: {
        short: { enabled: true, serverAllowlist: ["demo"] },
        patient: { enabled: true, serverAllowlist: ["demo"] },
      },
    });
    try {
      await expect(manager.callProviderTool("short", "mcp__demo__echo", {}))
        .rejects.toThrow("MCP tool call failed");

      const short = manager.callProviderTool("short", "mcp__demo__echo", {}, { timeoutMs: 20 });
      const shortTimedOut = expect(short).rejects.toThrow(/timed out|aborted/i);
      await vi.advanceTimersByTimeAsync(5);
      const patient = manager.callProviderTool("patient", "mcp__demo__echo", {}, { timeoutMs: 300 });

      await vi.advanceTimersByTimeAsync(15);
      await shortTimedOut;
      await vi.advanceTimersByTimeAsync(80);
      await expect(patient).resolves.toMatchObject({ content: [{ text: "echo" }] });
      expect(connection).toBe(2);
    } finally {
      await manager.close();
      vi.useRealTimers();
    }
  });

  it("keeps the cached session for a tool-level error result", async () => {
    let connection = 0;
    const manager = new McpManager({
      servers: [server],
      connector: async () => {
        connection += 1;
        return {
          ...fakeSession([tool("echo")]),
          async callTool() { return { ...result("tool rejected"), isError: true }; },
        };
      },
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    await expect(manager.callProviderTool("bot", "mcp__demo__echo", {})).resolves.toMatchObject({ isError: true });
    await expect(manager.callProviderTool("bot", "mcp__demo__echo", {})).resolves.toMatchObject({ isError: true });
    expect(connection).toBe(1);
    await manager.close();
  });

  it("does not evict a session for a protocol-level tool error", async () => {
    let connection = 0;
    const manager = new McpManager({
      servers: [server],
      connector: async () => {
        connection += 1;
        return {
          ...fakeSession([tool("echo")]),
          async callTool() { throw new ProtocolError(-32602, "invalid tool arguments"); },
        };
      },
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    await expect(manager.callProviderTool("bot", "mcp__demo__echo", {})).rejects.toThrow("MCP tool call failed");
    await expect(manager.callProviderTool("bot", "mcp__demo__echo", {})).rejects.toThrow("MCP tool call failed");
    expect(connection).toBe(1);
    await manager.close();
  });

  it("does not evict a replacement when an older session fails concurrently", async () => {
    let connection = 0;
    const closes: string[] = [];
    let releaseFirstList!: () => void;
    let firstListStarted!: () => void;
    const firstListReady = new Promise<void>((resolve) => { firstListStarted = resolve; });
    const manager = new McpManager({
      servers: [server],
      connector: async () => {
        connection += 1;
        const current = connection;
        return {
          ...fakeSession([tool("echo")]),
          async listTools() {
            if (current === 1) {
              firstListStarted();
              await new Promise<void>((resolve) => { releaseFirstList = resolve; });
              throw new Error("transport connection closed");
            }
            return { tools: [tool("echo")] };
          },
          async close() { closes.push(`session-${current}`); },
        };
      },
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
    });

    const first = manager.listProviderTools("bot");
    await firstListReady;
    manager.replaceServer({ ...server, url: "http://127.0.0.1:8789/mcp" });
    await expect(manager.listProviderTools("bot")).resolves.toHaveLength(1);
    releaseFirstList();
    await expect(first).rejects.toThrow("MCP tool listing failed");
    expect(connection).toBe(2);
    expect(closes).toEqual(["session-1"]);
    await manager.close();
    expect(closes.sort()).toEqual(["session-1", "session-2"]);
  });

  it("keeps healthy server tools when another enabled server fails", async () => {
    const manager = new McpManager({
      servers: [server, { ...server, id: "healthy", url: "http://127.0.0.1:8788/mcp" }],
      connector: async (config) => {
        if (config.id === "demo") throw new Error("unavailable");
        return fakeSession([tool("echo")]);
      },
      policies: { bot: { enabled: true, serverAllowlist: ["demo", "healthy"] } },
    });
    await expect(manager.listProviderTools("bot")).resolves.toEqual([
      expect.objectContaining({ serverId: "healthy", function: expect.objectContaining({ name: "mcp__healthy__echo" }) }),
    ]);
    await manager.close();
  });

  it("closes a connector session that resolves after its deadline and removes it from the cache", async () => {
    vi.useFakeTimers();
    const lateClose = vi.fn(async () => {});
    const freshClose = vi.fn(async () => {});
    let connection = 0;
    const connect = vi.fn(async () => {
      connection += 1;
      if (connection === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        return { ...fakeSession([tool("late")]), close: lateClose };
      }
      return { ...fakeSession([tool("fresh")]), close: freshClose };
    });
    const manager = new McpManager({
      servers: [server],
      connector: connect,
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
      timeoutMs: 10,
    });
    try {
      const first = manager.listProviderTools("bot");
      const timedOut = expect(first).rejects.toThrow(/timed out|aborted/i);
      await vi.advanceTimersByTimeAsync(10);
      await timedOut;
      await vi.advanceTimersByTimeAsync(30);
      expect(lateClose).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(manager.listProviderTools("bot")).resolves.toEqual([
        expect.objectContaining({ function: expect.objectContaining({ name: "mcp__demo__fresh" }) }),
      ]);
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      await manager.close();
      vi.useRealTimers();
    }
  });

  it("does not wait forever for a stuck session during close", async () => {
    vi.useFakeTimers();
    const manager = new McpManager({
      servers: [server],
      connector: async () => ({
        ...fakeSession([tool("echo")]),
        async close() { await new Promise<void>(() => {}); },
      }),
      policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
      closeTimeoutMs: 15,
    });
    try {
      await manager.listProviderTools("bot");
      const started = Date.now();
      const closing = manager.close();
      let settled = false;
      void closing.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(14);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(Date.now() - started).toBe(15);
      await expect(manager.close()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
