import { describe, expect, it, vi } from "vitest";

import type { ProviderTool, ProviderToolCall } from "../src/providers/router.js";
import type { ToolCallResult } from "../src/shared/contracts.js";
import { MAX_TOOL_RESULT_BYTES_PER_ROUND, type ToolCallExecutor, type ToolExecutionResult } from "../src/execution/tool-loop.js";
import type { SkillCatalog } from "../src/skills/catalog.js";
import type { McpAgentPolicy } from "../src/mcp/contracts.js";
import { McpAbortedError, McpPolicyError, McpResultLimitError, McpTimeoutError } from "../src/mcp/contracts.js";
import { MAX_PROVIDER_TOOL_SCHEMA_BYTES, SEARCH_MCP_TOOLS_NAME, CALL_MCP_TOOL_NAME, SharedTools, createSharedTools, type SharedMcpManager } from "../src/integrations/shared-tools.js";

function call(name: string, args: unknown): ProviderToolCall {
  return { id: `${name}-1`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function handled(result: ToolExecutionResult): Exclude<ToolExecutionResult, { handled: false }> {
  if (!result.handled) throw new Error("expected shared tool to be handled");
  return result;
}

function catalog(): SkillCatalog {
  return {
    list: () => [{ id: "browser", name: "Browser", description: "Visual browser", source: "test" }],
    invocationPolicy: (id: string) => id === "browser"
      ? { modelInvocable: true, userInvocable: true, autoSelect: true, triggers: [] }
      : undefined,
    read: (id: string) => id === "browser"
      ? {
        id,
        name: "Browser",
        description: "Visual browser",
        source: "test",
        content: "Use the visual browser.",
        delimiters: { start: `[[OPENBOT_SKILL_BEGIN:${id}]]`, end: `[[OPENBOT_SKILL_END:${id}]]` },
        invocation: { modelInvocable: true, userInvocable: true, autoSelect: true, triggers: [] },
        trust: "untrusted" as const,
      }
      : undefined,
  } as unknown as SkillCatalog;
}

const mcpTool: ProviderTool = {
  type: "function",
  function: { name: "mcp__browser__open", description: "Open a page", parameters: { type: "object" } },
};

function fakeMcp(overrides: Partial<SharedMcpManager> = {}): SharedMcpManager & { policy?: McpAgentPolicy; calls: Array<{ agentId: string; name: string; args: unknown; signal?: AbortSignal }> } {
  const state = {
    policy: undefined as McpAgentPolicy | undefined,
    calls: [] as Array<{ agentId: string; name: string; args: unknown; signal?: AbortSignal }>,
  };
  const manager: SharedMcpManager & typeof state = {
    ...state,
    setAgentPolicy(agentId, policy) {
      void agentId;
      this.policy = policy;
    },
    async getProviderTools() { return [mcpTool]; },
    async callProviderTool(agentId, name, args, options) {
      this.calls.push({ agentId, name, args, signal: options?.signal });
      return { content: [{ type: "text", text: "opened" }] };
    },
    ...overrides,
  };
  return manager;
}

describe("SharedTools", () => {
  it("combines base, Skills and authorized MCP tools without duplicate names", async () => {
    const base: ProviderTool[] = [mcpTool, { type: "function", function: { name: "file", parameters: { type: "object" } } }];
    const manager = fakeMcp();
    const shared = createSharedTools({
      catalog: catalog(),
      mcpManager: manager,
      resolveAgentSkillPolicy: () => ({ enabled: true, disabledIds: [] }),
      resolveAgentMcpPolicy: () => ({ enabled: true, serverAllowlist: ["browser"] }),
    });

    const tools = await shared.providerTools("bot", base);
    expect(tools.map((tool) => tool.function.name)).toEqual([
      "file", "search_skills", "use_skill", SEARCH_MCP_TOOLS_NAME, CALL_MCP_TOOL_NAME,
    ]);
    expect(new Set(tools.map((tool) => tool.function.name)).size).toBe(tools.length);
    expect(manager.policy).toEqual({ enabled: true, serverAllowlist: ["browser"] });
  });

  it("does not let MCP discovery failure remove base or Skill tools and exposes only a safe diagnostic", async () => {
    const manager = fakeMcp({
      async getProviderTools() { throw new Error("secret=C:\\private\\token.json"); },
    });
    const shared = createSharedTools({
      catalog: catalog(),
      mcpManager: manager,
      resolveAgentSkillPolicy: () => ({ enabled: true }),
      resolveAgentMcpPolicy: () => ({ enabled: true, serverAllowlist: ["browser"] }),
    });

    const tools = await shared.providerTools("bot", []);
    expect(tools.map((tool) => tool.function.name)).toEqual([
      "search_skills", "use_skill", SEARCH_MCP_TOOLS_NAME, CALL_MCP_TOOL_NAME,
    ]);
    expect(tools.some((tool) => tool.function.name.startsWith("mcp__"))).toBe(false);
    // The warm-listing rejection lands asynchronously; flush it before reading.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const status = shared.status("bot");
    expect(status.mcp).toMatchObject({ enabled: true, state: "error", error: { code: "unavailable" } });
    expect(JSON.stringify(status)).not.toContain("private");
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("não bloqueia o primeiro token enquanto MCP lento aquece o cache", async () => {
    let release!: (tools: ProviderTool[]) => void;
    const delayed = new Promise<ProviderTool[]>((resolve) => { release = resolve; });
    const manager = fakeMcp({ async getProviderTools() { return delayed; } });
    const shared = createSharedTools({
      catalog: catalog(),
      mcpManager: manager,
      resolveAgentSkillPolicy: () => ({ enabled: true }),
      resolveAgentMcpPolicy: () => ({ enabled: true, serverAllowlist: ["browser"] }),
      mcpTurnTimeoutMs: 10,
    });

    const first = await shared.providerTools("bot", []);
    expect(first.map((tool) => tool.function.name)).toEqual([
      "search_skills", "use_skill", SEARCH_MCP_TOOLS_NAME, CALL_MCP_TOOL_NAME,
    ]);
    expect(shared.status("bot").mcp.state).toBe("ready");

    release([mcpTool]);
    const searched = handled(await shared.executor()({
      agentId: "bot",
      call: call(SEARCH_MCP_TOOLS_NAME, { query: "open" }),
    }));
    expect(searched.content).toContain("mcp__browser__open");
  });

  it("returns the bounded input schema for a selected MCP tool", async () => {
    const parameters = {
      type: "object",
      properties: { item: { type: "string", minLength: 1 } },
      required: ["item"],
      additionalProperties: false,
    };
    const manager = fakeMcp({
      async getProviderTools() {
        return [{
          type: "function" as const,
          function: { name: "mcp__fixture__fetch", description: "fixture fetch", parameters },
        }];
      },
    });
    const shared = createSharedTools({
      catalog: catalog(),
      mcpManager: manager,
      resolveAgentSkillPolicy: () => ({ enabled: true }),
      resolveAgentMcpPolicy: () => ({ enabled: true, serverAllowlist: ["fixture"] }),
    });

    const result = handled(await shared.executor()({
      agentId: "bot",
      call: call(SEARCH_MCP_TOOLS_NAME, { query: "fetch" }),
    }));
    const payload = JSON.parse(result.content) as { tools: Array<{ name: string; parameters: Record<string, unknown> }>; count: number };

    expect(payload).toEqual({ tools: [{ name: "mcp__fixture__fetch", description: "fixture fetch", parameters }], count: 1 });
    expect(payload.tools[0]?.parameters).toMatchObject({ required: ["item"], properties: { item: { type: "string" } } });
  });

  it("bounds the selected MCP schemas by the tool-result byte limit", async () => {
    const manager = fakeMcp({
      async getProviderTools() {
        return Array.from({ length: 4 }, (_, index) => ({
          type: "function" as const,
          function: {
            name: `mcp__fixture__large_${index}`,
            parameters: { type: "object", description: "x".repeat(40 * 1024) },
          },
        }));
      },
    });
    const shared = createSharedTools({
      catalog: catalog(),
      mcpManager: manager,
      resolveAgentSkillPolicy: () => ({ enabled: true }),
      resolveAgentMcpPolicy: () => ({ enabled: true, serverAllowlist: ["fixture"] }),
    });

    const result = handled(await shared.executor()({
      agentId: "bot",
      call: call(SEARCH_MCP_TOOLS_NAME, { query: "large", limit: 4 }),
    }));
    const payload = JSON.parse(result.content) as { tools: unknown[]; count: number };

    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES_PER_ROUND);
    expect(payload.count).toBe(payload.tools.length);
    expect(payload.count).toBeLessThan(4);
  });

  it("reports an oversized-only MCP schema omission in a bounded envelope", async () => {
    const manager = fakeMcp({
      async getProviderTools() {
        return [{
          type: "function" as const,
          function: { name: "mcp__fixture__oversized", parameters: { type: "object", description: "x".repeat(140 * 1024) } },
        }];
      },
    });
    const shared = createSharedTools({
      catalog: catalog(),
      mcpManager: manager,
      resolveAgentSkillPolicy: () => ({ enabled: true }),
      resolveAgentMcpPolicy: () => ({ enabled: true, serverAllowlist: ["fixture"] }),
    });

    const result = handled(await shared.executor()({
      agentId: "bot",
      call: call(SEARCH_MCP_TOOLS_NAME, { query: "oversized" }),
    }));
    const payload = JSON.parse(result.content) as { tools: unknown[]; count: number; omittedByByteLimit?: number };

    expect(payload).toMatchObject({ tools: [], count: 0, omittedByByteLimit: 1 });
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES_PER_ROUND);
  });

  it("keeps a later small MCP schema while reporting an earlier oversized omission", async () => {
    const manager = fakeMcp({
      async getProviderTools() {
        return [
          {
            type: "function" as const,
            function: { name: "mcp__fixture__oversized", parameters: { type: "object", description: "x".repeat(140 * 1024) } },
          },
          {
            type: "function" as const,
            function: {
              name: "mcp__fixture__small",
              parameters: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
            },
          },
        ];
      },
    });
    const shared = createSharedTools({
      catalog: catalog(),
      mcpManager: manager,
      resolveAgentSkillPolicy: () => ({ enabled: true }),
      resolveAgentMcpPolicy: () => ({ enabled: true, serverAllowlist: ["fixture"] }),
    });

    const result = handled(await shared.executor()({
      agentId: "bot",
      call: call(SEARCH_MCP_TOOLS_NAME, { query: "fixture", limit: 2 }),
    }));
    const payload = JSON.parse(result.content) as { tools: Array<{ name: string; parameters: Record<string, unknown> }>; count: number; omittedByByteLimit?: number };

    expect(payload).toMatchObject({ count: 1, omittedByByteLimit: 1, tools: [{ name: "mcp__fixture__small" }] });
    expect(payload.tools[0]?.parameters).toMatchObject({ required: ["item"] });
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES_PER_ROUND);
  });

  it("rebalances the omission counter when a borderline schema only fits without metadata", async () => {
    const nearParameters = { type: "object", description: "x".repeat(130_950) };
    const nearTool = { name: "mcp__fixture__near_limit", description: "", parameters: nearParameters };
    const withoutOmission = JSON.stringify({ tools: [nearTool], count: 1 });
    const withOneOmission = JSON.stringify({ tools: [nearTool], count: 1, omittedByByteLimit: 1 });
    expect(Buffer.byteLength(withoutOmission, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES_PER_ROUND);
    expect(Buffer.byteLength(withOneOmission, "utf8")).toBeGreaterThan(MAX_TOOL_RESULT_BYTES_PER_ROUND);

    const manager = fakeMcp({
      async getProviderTools() {
        return [
          {
            type: "function" as const,
            function: { name: "mcp__fixture__oversized", parameters: { type: "object", description: "x".repeat(140 * 1024) } },
          },
          { type: "function" as const, function: nearTool },
        ];
      },
    });
    const shared = createSharedTools({
      catalog: catalog(),
      mcpManager: manager,
      resolveAgentSkillPolicy: () => ({ enabled: true }),
      resolveAgentMcpPolicy: () => ({ enabled: true, serverAllowlist: ["fixture"] }),
    });

    const result = handled(await shared.executor()({
      agentId: "bot",
      call: call(SEARCH_MCP_TOOLS_NAME, { query: "fixture", limit: 2 }),
    }));
    const payload = JSON.parse(result.content) as { tools: unknown[]; count: number; omittedByByteLimit?: number };

    expect(payload).toMatchObject({ tools: [], count: 0, omittedByByteLimit: 2 });
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES_PER_ROUND);
  });

  it("limita o catálogo de schemas sem remover tools locais e de Skills", async () => {
    const manager = fakeMcp({
      async getProviderTools() {
        return Array.from({ length: 100 }, (_, index) => ({
          type: "function" as const,
          function: {
            name: `mcp__large__tool_${index}`,
            description: "x".repeat(8 * 1024),
            parameters: { type: "object" },
          },
        }));
      },
    });
    const shared = createSharedTools({
      catalog: catalog(),
      mcpManager: manager,
      resolveAgentSkillPolicy: () => ({ enabled: true }),
      resolveAgentMcpPolicy: () => ({ enabled: true, serverAllowlist: ["large"] }),
    });

    const tools = await shared.providerTools("bot", [{ type: "function", function: { name: "file", parameters: { type: "object" } } }]);

    expect(tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["file", "search_skills", "use_skill", SEARCH_MCP_TOOLS_NAME, CALL_MCP_TOOL_NAME]));
    expect(Buffer.byteLength(JSON.stringify(tools), "utf8")).toBeLessThanOrEqual(MAX_PROVIDER_TOOL_SCHEMA_BYTES);
    expect(tools.filter((tool) => tool.function.name.startsWith("mcp__"))).toHaveLength(0);
  });

  it("cleans status and delegated MCP policy state after agent deletion", async () => {
    const removed: string[] = [];
    const manager = fakeMcp({ removeAgent(agentId) { removed.push(agentId); } });
    const shared = createSharedTools({
      catalog: catalog(),
      mcpManager: manager,
      resolveAgentSkillPolicy: () => ({ enabled: true }),
      resolveAgentMcpPolicy: () => ({ enabled: true, serverAllowlist: ["browser"] }),
    });

    await shared.providerTools("deleted-bot", []);
    expect(shared.status("deleted-bot").mcp.state).toBe("ready");
    shared.removeAgent("deleted-bot");

    expect(removed).toEqual(["deleted-bot"]);
    expect(shared.status("deleted-bot").mcp.state).toBe("disabled");
  });

  it("mantém a descoberta MCP independente do cancelamento do turno", async () => {
    let received: AbortSignal | undefined;
    const manager = fakeMcp({
      async getProviderTools(_agentId, options?: { signal?: AbortSignal }) {
        received = options?.signal;
        return [];
      },
    });
    const shared = createSharedTools({
      catalog: catalog(),
      mcpManager: manager,
      resolveAgentSkillPolicy: () => ({ enabled: true }),
      resolveAgentMcpPolicy: () => ({ enabled: true, serverAllowlist: ["browser"] }),
    });
    const controller = new AbortController();

    await shared.providerTools("bot", [], { signal: controller.signal });

    expect(received).toBeUndefined();
  });

  it("dispatches Skills and MCP, validates object JSON, rechecks policy, and forwards abort signal", async () => {
    const policy = { skill: { enabled: true }, mcp: { enabled: true, serverAllowlist: ["browser"] } };
    const manager = fakeMcp();
    const shared = createSharedTools({
      catalog: catalog(),
      mcpManager: manager,
      resolveAgentSkillPolicy: () => policy.skill,
      resolveAgentMcpPolicy: () => policy.mcp,
    });
    const executor: ToolCallExecutor = shared.executor();

    const skillResult = handled(await executor({ agentId: "bot", call: call("use_skill", { id: "browser" }) }));
    expect(skillResult).toMatchObject({ handled: true, ok: true });
    expect(skillResult.content).toContain("Use the visual browser.");

    const controller = new AbortController();
    const mcpResult = handled(await executor({ agentId: "bot", call: call("mcp__browser__open", { url: "https://example.com" }), signal: controller.signal }));
    expect(mcpResult).toMatchObject({ handled: true, ok: true, result: { operation: "mcp.call" } });
    expect(manager.calls[0]).toMatchObject({ agentId: "bot", name: "mcp__browser__open", args: { url: "https://example.com" }, signal: controller.signal });

    const gateway = handled(await executor({ agentId: "bot", call: call(CALL_MCP_TOOL_NAME, { name: "mcp__browser__open", arguments: { url: "https://example.com/via-gateway" } }) }));
    expect(gateway).toMatchObject({ handled: true, ok: true, result: { operation: "mcp.call" } });
    expect(manager.calls[1]).toMatchObject({ name: "mcp__browser__open", args: { url: "https://example.com/via-gateway" } });

    const invalid = handled(await executor({ agentId: "bot", call: { ...call("mcp__browser__open", []), function: { name: "mcp__browser__open", arguments: "[]" } } }));
    expect(invalid).toMatchObject({ handled: true, ok: false, result: { code: "validation" } });

    policy.mcp = { enabled: false, serverAllowlist: ["browser"] };
    const denied = handled(await executor({ agentId: "bot", call: call("mcp__browser__open", {}) }));
    expect(denied).toMatchObject({ handled: true, ok: false, result: { code: "policy" } });
  });

  it("maps a resolved MCP isError result to a tool failure while preserving its content", async () => {
    const manager = fakeMcp({
      async callProviderTool() {
        return { isError: true, content: [{ type: "text", text: "tool rejected" }] };
      },
    });
    const shared = createSharedTools({
      catalog: catalog(),
      mcpManager: manager,
      resolveAgentSkillPolicy: () => ({ enabled: true }),
      resolveAgentMcpPolicy: () => ({ enabled: true, serverAllowlist: ["browser"] }),
    });

    const result = handled(await shared.executor()({ agentId: "bot", call: call("mcp__browser__open", {}) }));

    expect(result).toMatchObject({
      handled: true,
      ok: false,
      result: { ok: false, operation: "mcp.call", code: "tool_error", message: "MCP tool reported an execution error" },
    });
    expect(result.content).toContain('"isError":true');
    expect(result.content).toContain("tool rejected");
    expect(result.error).toBe(result.content);
  });

  it("delegates explicit Skill context and treats unknown names as local-broker candidates", async () => {
    const shared = new SharedTools({
      catalog: catalog(),
      mcpManager: fakeMcp(),
      resolveAgentSkillPolicy: () => ({ enabled: true }),
      resolveAgentMcpPolicy: () => ({ enabled: false }),
    });
    await expect(shared.resolveTurnContext("bot", { prompt: "/skill browser open" })).resolves.toContain("Use the visual browser.");
    await expect(shared.resolveTurnContextResolution("bot", { prompt: "/skill browser open" })).resolves.toEqual({
      source: "text-command",
      context: expect.stringContaining("Use the visual browser."),
      normalizedPrompt: "open",
    });
    await expect(shared.resolveTurnContextResolution("bot", {
      prompt: "/skill browser open",
      richText: JSON.stringify({ type: "doc", content: [{ type: "workflowReference", attrs: { id: "skill:browser" } }] }),
    })).resolves.toMatchObject({ source: "reference" });
    expect(shared.executor().canHandle?.("file")).toBe(false);
    expect(shared.executor().canHandle?.("mcp__browser__open")).toBe(true);
    expect(shared.executor().canHandle?.("mcp__bad")).toBe(false);
  });

  it("maps typed MCP errors to honest failure codes instead of collapsing to unavailable", async () => {
    const cases = [
      { error: new McpPolicyError("denied"), code: "policy" },
      { error: new McpTimeoutError(), code: "timed_out" },
      { error: new McpAbortedError(), code: "aborted" },
      { error: new McpResultLimitError(), code: "output_limit" },
      { error: new Error("socket reset"), code: "unavailable" },
    ];
    for (const { error, code } of cases) {
      const manager = fakeMcp({ async callProviderTool() { throw error; } });
      const shared = createSharedTools({
        catalog: catalog(),
        mcpManager: manager,
        resolveAgentSkillPolicy: () => ({ enabled: true }),
        resolveAgentMcpPolicy: () => ({ enabled: true, serverAllowlist: ["browser"] }),
      });
      const result = handled(await shared.executor()({ agentId: "bot", call: call("mcp__browser__open", {}) }));
      expect(result).toMatchObject({ handled: true, ok: false, result: { code } });
      expect(result.error ?? "").not.toContain(error.message);
    }
  });

  it("refuses extension execution when the turn signal is already aborted", async () => {
    const manager = fakeMcp();
    const shared = createSharedTools({
      catalog: catalog(),
      mcpManager: manager,
      resolveAgentSkillPolicy: () => ({ enabled: true }),
      resolveAgentMcpPolicy: () => ({ enabled: true, serverAllowlist: ["browser"] }),
    });
    const controller = new AbortController();
    controller.abort();
    const skillResult = handled(await shared.executor()({ agentId: "bot", call: call("use_skill", { id: "browser" }), signal: controller.signal }));
    expect(skillResult).toMatchObject({ ok: false, result: { code: "aborted" } });
    const mcpResult = handled(await shared.executor()({ agentId: "bot", call: call("mcp__browser__open", {}), signal: controller.signal }));
    expect(mcpResult).toMatchObject({ ok: false, result: { code: "aborted" } });
    expect(manager.calls).toHaveLength(0);
  });
});
