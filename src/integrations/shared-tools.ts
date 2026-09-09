import type { ToolCallExecutor, ToolExecutionContext, ToolExecutionResult } from "../execution/tool-loop.js";
import type { McpAgentPolicy } from "../mcp/contracts.js";
import { MCP_PROVIDER_TOOL_PREFIX } from "../mcp/contracts.js";
import type { ProviderTool } from "../providers/router.js";
import type { SkillCatalog } from "../skills/catalog.js";
import { SkillDispatcher, type SkillAgentPolicy } from "../skills/dispatcher.js";
import { parseSkillCommand, parseSkillReferences } from "../skills/references.js";
import type { TurnContextResolution } from "../rpc/send.js";

export const MAX_PROVIDER_TOOL_SCHEMA_BYTES = 256 * 1024;
export const DEFAULT_MCP_TURN_DISCOVERY_TIMEOUT_MS = 1_500;

export interface SharedMcpManager {
  setAgentPolicy(agentId: string, policy: McpAgentPolicy): void;
  removeAgent?(agentId: string): void;
  getProviderTools(agentId: string, options?: { signal?: AbortSignal }): Promise<ProviderTool[]>;
  callProviderTool(
    agentId: string,
    name: string,
    args: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

export interface SharedToolsOptions {
  catalog: SkillCatalog;
  mcpManager: SharedMcpManager;
  resolveAgentSkillPolicy: (agentId: string) => SkillAgentPolicy;
  resolveAgentMcpPolicy: (agentId: string) => McpAgentPolicy;
  mcpTurnTimeoutMs?: number;
}

export interface SharedToolsStatus {
  skills: { enabled: boolean };
  mcp: {
    enabled: boolean;
    state: "disabled" | "ready" | "error";
    toolCount?: number;
    error?: { code: "unavailable" };
  };
}

const safeFailure = (operation: string, code: string, message: string): ToolExecutionResult => ({
  handled: true,
  ok: false,
  content: "",
  error: message,
  result: { ok: false, operation, code, message },
});

function parseObjectArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export class SharedTools {
  private readonly skillDispatcher: SkillDispatcher;
  private readonly statuses = new Map<string, SharedToolsStatus>();
  private readonly mcpTurnTimeoutMs: number;

  public constructor(private readonly options: SharedToolsOptions) {
    this.mcpTurnTimeoutMs = options.mcpTurnTimeoutMs ?? DEFAULT_MCP_TURN_DISCOVERY_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.mcpTurnTimeoutMs) || this.mcpTurnTimeoutMs < 1) {
      throw new Error("mcpTurnTimeoutMs must be a positive integer");
    }
    this.skillDispatcher = new SkillDispatcher({
      catalog: options.catalog,
      policyForAgent: options.resolveAgentSkillPolicy,
    });
  }

  public async providerTools(
    agentId: string,
    baseTools: readonly ProviderTool[] = [],
    options?: { signal?: AbortSignal },
  ): Promise<ProviderTool[]> {
    const skillPolicy = this.options.resolveAgentSkillPolicy(agentId);
    const mcpPolicy = this.options.resolveAgentMcpPolicy(agentId);
    this.options.mcpManager.setAgentPolicy(agentId, mcpPolicy);
    const combined: ProviderTool[] = [...baseTools];
    if (skillPolicy.enabled !== false) combined.push(...this.skillDispatcher.tools);
    let mcpState: SharedToolsStatus["mcp"] = { enabled: mcpPolicy.enabled, state: mcpPolicy.enabled ? "ready" : "disabled" };
    if (mcpPolicy.enabled) {
      const discovery = this.options.mcpManager.getProviderTools(agentId).then(
        (tools) => ({ state: "ready" as const, tools }),
        () => ({ state: "error" as const }),
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      const unavailable = new Promise<{ state: "error" }>((resolve) => {
        timeout = setTimeout(() => resolve({ state: "error" }), this.mcpTurnTimeoutMs);
        timeout.unref();
        if (options?.signal) {
          abortListener = () => resolve({ state: "error" });
          if (options.signal.aborted) abortListener();
          else options.signal.addEventListener("abort", abortListener, { once: true });
        }
      });
      const listed = await Promise.race([discovery, unavailable]);
      if (timeout !== undefined) clearTimeout(timeout);
      if (options?.signal && abortListener) options.signal.removeEventListener("abort", abortListener);
      if (listed.state === "ready") {
        combined.push(...listed.tools);
        mcpState = { enabled: true, state: "ready", toolCount: listed.tools.length };
      } else {
        // Remote/process errors are untrusted. The diagnostic intentionally
        // carries no original message, URL, path, arguments or secret data.
        mcpState = { enabled: true, state: "error", error: { code: "unavailable" } };
      }
    }
    const names = new Set<string>();
    const unique = combined.filter((tool) => {
      const name = tool.function.name;
      if (names.has(name)) return false;
      names.add(name);
      return true;
    });
    const bounded: ProviderTool[] = [];
    for (const tool of unique) {
      const next = [...bounded, tool];
      if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_PROVIDER_TOOL_SCHEMA_BYTES) continue;
      bounded.push(tool);
    }
    if (mcpState.state === "ready") {
      mcpState = {
        ...mcpState,
        toolCount: bounded.filter((tool) => tool.function.name.startsWith(MCP_PROVIDER_TOOL_PREFIX)).length,
      };
    }
    this.statuses.set(agentId, { skills: { enabled: skillPolicy.enabled !== false }, mcp: mcpState });
    return bounded;
  }

  public status(agentId: string): SharedToolsStatus {
    return this.statuses.get(agentId) ?? {
      skills: { enabled: this.options.resolveAgentSkillPolicy(agentId).enabled !== false },
      mcp: { enabled: false, state: "disabled" },
    };
  }

  /** Drop status and MCP policy state after a roster deletion commits. */
  public removeAgent(agentId: string): void {
    this.statuses.delete(agentId);
    this.options.mcpManager.removeAgent?.(agentId);
  }

  /** Batch lifecycle seam used by deleteAgents commit cleanup. */
  public cleanupDeletedAgents(agentIds: readonly string[]): void {
    for (const agentId of agentIds) this.removeAgent(agentId);
  }

  public async resolveTurnContext(agentId: string, args: { prompt: string; richText?: string }): Promise<string> {
    return (await this.resolveTurnContextResolution(agentId, args)).context;
  }

  /**
   * Resolves ephemeral Skill context with provenance. A workflow reference is
   * deliberately authoritative over textual fallback normalization when both
   * are present in one composer submission.
   */
  public async resolveTurnContextResolution(
    agentId: string,
    args: { prompt: string; richText?: string },
  ): Promise<TurnContextResolution> {
    const resolved = await this.skillDispatcher.resolveSkillContext(agentId, args);
    if (parseSkillReferences(args.richText).length > 0) {
      return {
        source: "reference",
        context: resolved.context,
        ...(resolved.error !== undefined ? { error: resolved.error } : {}),
      };
    }
    const command = parseSkillCommand(args.prompt);
    if (
      command !== undefined &&
      resolved.context.trim().length > 0 &&
      resolved.skillIds.includes(command.skillId)
    ) {
      return {
        source: "text-command",
        context: resolved.context,
        normalizedPrompt: resolved.prompt,
        ...(resolved.error !== undefined ? { error: resolved.error } : {}),
      };
    }
    return {
      source: "other",
      context: resolved.context,
      ...(resolved.error !== undefined ? { error: resolved.error } : {}),
    };
  }

  private async execute(context: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (this.skillDispatcher.canHandle(context.call.function.name)) {
      return this.skillDispatcher.execute(context);
    }
    if (!context.call.function.name.startsWith(MCP_PROVIDER_TOOL_PREFIX)) return { handled: false };
    const policy = this.options.resolveAgentMcpPolicy(context.agentId);
    this.options.mcpManager.setAgentPolicy(context.agentId, policy);
    if (!policy.enabled) return safeFailure("mcp.call", "policy", "MCP is disabled for this bot");
    const args = parseObjectArguments(context.call.function.arguments);
    if (args === undefined) return safeFailure("mcp.call", "validation", "MCP tool arguments must be a JSON object");
    try {
      const value = await this.options.mcpManager.callProviderTool(
        context.agentId,
        context.call.function.name,
        args,
        { signal: context.signal },
      );
      const content = JSON.stringify(value);
      return {
        handled: true,
        ok: true,
        content,
        result: { ok: true, operation: "mcp.call", bytes: Buffer.byteLength(content) },
      };
    } catch {
      return safeFailure("mcp.call", "unavailable", "MCP tool execution failed");
    }
  }

  public executor(): ToolCallExecutor {
    const executor = (context: ToolExecutionContext) => this.execute(context);
    return Object.assign(executor, {
      canHandle: (name: string) => this.skillDispatcher.canHandle(name) || name.startsWith(MCP_PROVIDER_TOOL_PREFIX),
    });
  }
}

export function createSharedTools(options: SharedToolsOptions): SharedTools {
  return new SharedTools(options);
}

export function composeToolExecutors(...executors: Array<ToolCallExecutor | undefined>): ToolCallExecutor | undefined {
  const active = executors.filter((executor): executor is ToolCallExecutor => executor !== undefined);
  if (active.length === 0) return undefined;
  const chained: ToolCallExecutor = async (context) => {
    for (const executor of active) {
      const result = await executor(context);
      if (result.handled) return result;
    }
    return { handled: false };
  };
  chained.canHandle = (name: string) => active.some((executor) => executor.canHandle?.(name) ?? false);
  return chained;
}
