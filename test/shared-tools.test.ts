import { describe, expect, it, vi } from "vitest";

import type { ProviderTool, ProviderToolCall } from "../src/providers/router.js";
import type { ToolCallResult } from "../src/shared/contracts.js";
import type { ToolCallExecutor, ToolExecutionResult } from "../src/execution/tool-loop.js";
import type { SkillCatalog } from "../src/skills/catalog.js";
import type { McpAgentPolicy } from "../src/mcp/contracts.js";
import { MAX_PROVIDER_TOOL_SCHEMA_BYTES, SharedTools, createSharedTools, type SharedMcpManager } from "../src/integrations/shared-tools.js";

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
    expect(tools.map((tool) => tool.function.name)).toEqual(["mcp__browser__open", "file", "search_skills", "use_skill"]);
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
    expect(tools.map((tool) => tool.function.name)).toEqual(["search_skills", "use_skill"]);
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
    expect(first.map((tool) => tool.function.name)).toEqual(["search_skills", "use_skill"]);
    expect(shared.status("bot").mcp.state).toBe("error");

    release([mcpTool]);
    await expect(shared.providerTools("bot", [])).resolves.toContainEqual(mcpTool);
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

    expect(tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["file", "search_skills", "use_skill"]));
    expect(Buffer.byteLength(JSON.stringify(tools), "utf8")).toBeLessThanOrEqual(MAX_PROVIDER_TOOL_SCHEMA_BYTES);
    expect(tools.filter((tool) => tool.function.name.startsWith("mcp__"))).not.toHaveLength(100);
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

    const invalid = handled(await executor({ agentId: "bot", call: { ...call("mcp__browser__open", []), function: { name: "mcp__browser__open", arguments: "[]" } } }));
    expect(invalid).toMatchObject({ handled: true, ok: false, result: { code: "validation" } });

    policy.mcp = { enabled: false, serverAllowlist: ["browser"] };
    const denied = handled(await executor({ agentId: "bot", call: call("mcp__browser__open", {}) }));
    expect(denied).toMatchObject({ handled: true, ok: false, result: { code: "policy" } });
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
    expect(shared.executor().canHandle?.("mcp__bad")).toBe(true);
  });
});
