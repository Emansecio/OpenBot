import { MAX_TOOL_RESULT_BYTES_PER_ROUND, parseToolArguments, toolFailure, type ToolCallExecutor, type ToolExecutionContext, type ToolExecutionResult } from "../execution/tool-loop.js";
import type { McpAgentPolicy } from "../mcp/contracts.js";
import {
  isMcpProviderToolName,
  McpAbortedError,
  McpPolicyError,
  McpResultLimitError,
  MCP_PROVIDER_TOOL_PREFIX,
  McpTimeoutError,
  McpValidationError,
} from "../mcp/contracts.js";
import { McpOperationalError, McpSecurityError } from "../mcp/security.js";
import { utf8Prefix } from "../shared/utf8.js";
import type { ProviderTool } from "../providers/router.js";
import type { SkillCatalog } from "../skills/catalog.js";
import { SkillDispatcher, type SkillAgentPolicy } from "../skills/dispatcher.js";
import { parseSkillCommand, parseSkillReferences } from "../skills/references.js";
import type { TurnContextResolution } from "../rpc/send.js";

export const MAX_PROVIDER_TOOL_SCHEMA_BYTES = 256 * 1024;
export const DEFAULT_MCP_TURN_DISCOVERY_TIMEOUT_MS = 1_500;
export const SEARCH_MCP_TOOLS_NAME = "search_mcp_tools";
export const CALL_MCP_TOOL_NAME = "call_mcp_tool";
const MCP_SEARCH_LIMIT = 20;
const MCP_SEARCH_DESCRIPTION_BYTES = 240;

export const MCP_GATEWAY_TOOLS: ProviderTool[] = [
  {
    type: "function",
    function: {
      name: SEARCH_MCP_TOOLS_NAME,
      description: "Search authorized MCP tools by task keywords. Returns matching names, descriptions, and bounded input schemas; omittedByByteLimit reports schemas excluded by the response byte limit; invoke one with call_mcp_tool.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1, maxLength: 256 },
          limit: { type: "integer", minimum: 1, maximum: MCP_SEARCH_LIMIT },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: CALL_MCP_TOOL_NAME,
      description: "Call one authorized MCP tool by its mcp__server__tool name with a JSON object of arguments.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 256 },
          arguments: { type: "object" },
        },
        required: ["name"],
      },
    },
  },
];

export interface SharedMcpManager {
  setAgentPolicy(agentId: string, policy: McpAgentPolicy): void;
  removeAgent?(agentId: string): void;
  getProviderTools(agentId: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ProviderTool[]>;
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


/** Honest codes: a policy denial or timeout is not an availability failure. */
const mcpFailure = (operation: string, error: unknown, fallback: string): ToolExecutionResult => {
  if (error instanceof McpOperationalError) return toolFailure(operation, "unavailable", fallback);
  if (error instanceof McpPolicyError || error instanceof McpSecurityError) return toolFailure(operation, "policy", fallback);
  if (error instanceof McpValidationError) return toolFailure(operation, "validation", fallback);
  if (error instanceof McpTimeoutError) return toolFailure(operation, "timed_out", fallback);
  if (error instanceof McpAbortedError) return toolFailure(operation, "aborted", fallback);
  if (error instanceof McpResultLimitError) return toolFailure(operation, "output_limit", fallback);
  return toolFailure(operation, "unavailable", fallback);
};

const isMcpToolErrorResult = (value: unknown): boolean =>
  typeof value === "object"
  && value !== null
  && !Array.isArray(value)
  && (value as { isError?: unknown }).isError === true;

function compactMcpDescription(value: string | undefined): string {
  if (value === undefined || value.length === 0) return "";
  if (Buffer.byteLength(value, "utf8") <= MCP_SEARCH_DESCRIPTION_BYTES) return value;
  // The ellipsis takes 3 UTF-8 bytes; the whole description stays within the bound.
  return `${utf8Prefix(value, MCP_SEARCH_DESCRIPTION_BYTES - 3)}…`;
}

/** The promise's value when it settles within the budget; undefined on timeout or abort. Never rejects. */
function settleWithin<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const finish = (value: T | undefined): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(undefined);
    const timer = setTimeout(onAbort, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(finish, () => finish(undefined));
  });
}

function isMcpSchemaToolName(name: string): boolean {
  return name.startsWith(MCP_PROVIDER_TOOL_PREFIX) || name === SEARCH_MCP_TOOLS_NAME || name === CALL_MCP_TOOL_NAME;
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
    const combined: ProviderTool[] = baseTools.filter((tool) => !isMcpSchemaToolName(tool.function.name));
    if (skillPolicy.enabled !== false) combined.push(...this.skillDispatcher.tools);
    let mcpState: SharedToolsStatus["mcp"] = { enabled: false, state: "disabled" };
    if (mcpPolicy.enabled) {
      combined.push(...MCP_GATEWAY_TOOLS);
      // Until this turn's discovery settles, report the last known outcome.
      const previous = this.statuses.get(agentId)?.mcp;
      mcpState = previous?.enabled === true ? previous : { enabled: true, state: "ready" };
      // Discovery runs to the listing's own deadline instead of the turn
      // budget: cutting it short would abort a slow cold start on every turn
      // and never warm the cache. The turn waits at most its budget, only to
      // report the outcome; gateway search/call work without a warm catalog.
      const discovery = this.options.mcpManager.getProviderTools(agentId).then(
        (tools): SharedToolsStatus["mcp"] => ({ enabled: true, state: "ready", toolCount: tools.length }),
        (): SharedToolsStatus["mcp"] => ({ enabled: true, state: "error", error: { code: "unavailable" } }),
      );
      void discovery.then((outcome) => {
        const current = this.statuses.get(agentId);
        if (current !== undefined && current.mcp.enabled) this.statuses.set(agentId, { ...current, mcp: outcome });
      });
      mcpState = await settleWithin(discovery, this.mcpTurnTimeoutMs, options?.signal) ?? mcpState;
    }
    const names = new Set<string>();
    const unique = combined.filter((tool) => {
      const name = tool.function.name;
      if (names.has(name)) return false;
      names.add(name);
      return true;
    });
    // Same bound as serializing the whole array, measured incrementally:
    // "[" + tools joined by "," + "]".
    const bounded: ProviderTool[] = [];
    let arrayBytes = 2;
    for (const tool of unique) {
      const bytes = Buffer.byteLength(JSON.stringify(tool), "utf8") + (bounded.length > 0 ? 1 : 0);
      if (arrayBytes + bytes > MAX_PROVIDER_TOOL_SCHEMA_BYTES) continue;
      bounded.push(tool);
      arrayBytes += bytes;
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
    if (context.signal?.aborted) {
      return toolFailure("shared.tool", "aborted", "Tool execution was aborted.");
    }
    if (this.skillDispatcher.canHandle(context.call.function.name)) {
      return this.skillDispatcher.execute(context);
    }
    const policy = this.options.resolveAgentMcpPolicy(context.agentId);
    this.options.mcpManager.setAgentPolicy(context.agentId, policy);
    if (context.call.function.name === SEARCH_MCP_TOOLS_NAME) {
      if (!policy.enabled) return toolFailure("mcp.search", "policy", "MCP is disabled for this bot");
      const args = parseToolArguments(context.call.function.arguments);
      const query = typeof args?.query === "string" ? args.query.trim() : "";
      if (query.length === 0 || Buffer.byteLength(query, "utf8") > 256) {
        return toolFailure("mcp.search", "validation", "search_mcp_tools query is invalid");
      }
      const limit = args?.limit === undefined ? 8 : args.limit;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MCP_SEARCH_LIMIT) {
        return toolFailure("mcp.search", "validation", "search_mcp_tools limit is invalid");
      }
      try {
        const listed = await this.options.mcpManager.getProviderTools(context.agentId, { signal: context.signal });
        const needle = query.toLocaleLowerCase();
        const compact = listed.map((tool) => ({
          name: tool.function.name,
          description: compactMcpDescription(tool.function.description),
          ...(tool.function.parameters === undefined ? {} : { parameters: tool.function.parameters }),
        }));
        const matched = compact.filter((tool) => (
          tool.name.toLocaleLowerCase().includes(needle) || tool.description.toLocaleLowerCase().includes(needle)
        ));
        const selected = (matched.length > 0 ? matched : compact).slice(0, limit as number);
        const encode = (tools: typeof compact, omittedByByteLimit: number): string => JSON.stringify({
          tools,
          count: tools.length,
          ...(omittedByByteLimit > 0 ? { omittedByByteLimit } : {}),
        });
        const bounded: typeof selected = [];
        let omittedByByteLimit = 0;
        let toolBytes = 0;
        for (const tool of selected) {
          // Exactly the size of encode([...bounded, tool], 0): the empty
          // envelope with the new count, the tools and their separators.
          const itemBytes = Buffer.byteLength(JSON.stringify(tool), "utf8");
          const envelopeBytes = Buffer.byteLength(JSON.stringify({ tools: [], count: bounded.length + 1 }), "utf8");
          const size = envelopeBytes + toolBytes + itemBytes + bounded.length;
          if (size > MAX_TOOL_RESULT_BYTES_PER_ROUND) {
            omittedByByteLimit += 1;
            continue;
          }
          bounded.push(tool);
          toolBytes += itemBytes;
        }
        let content = encode(bounded, omittedByByteLimit);
        while (Buffer.byteLength(content, "utf8") > MAX_TOOL_RESULT_BYTES_PER_ROUND && bounded.length > 0) {
          bounded.pop();
          omittedByByteLimit += 1;
          content = encode(bounded, omittedByByteLimit);
        }
        return { handled: true, ok: true, content, result: { ok: true, operation: "mcp.search", bytes: Buffer.byteLength(content) } };
      } catch (error) {
        return mcpFailure("mcp.search", error, "MCP tool listing failed");
      }
    }
    if (context.call.function.name === CALL_MCP_TOOL_NAME) {
      if (!policy.enabled) return toolFailure("mcp.call", "policy", "MCP is disabled for this bot");
      const args = parseToolArguments(context.call.function.arguments);
      const name = typeof args?.name === "string" ? args.name.trim() : "";
      if (!isMcpProviderToolName(name)) return toolFailure("mcp.call", "validation", "call_mcp_tool name is invalid");
      const callArgs = args?.arguments;
      if (callArgs !== undefined && (typeof callArgs !== "object" || callArgs === null || Array.isArray(callArgs))) {
        return toolFailure("mcp.call", "validation", "MCP tool arguments must be a JSON object");
      }
      return this.callMcp(context.agentId, name, (callArgs ?? {}) as Record<string, unknown>, context.signal);
    }
    if (!isMcpProviderToolName(context.call.function.name)) return { handled: false };
    if (!policy.enabled) return toolFailure("mcp.call", "policy", "MCP is disabled for this bot");
    const args = parseToolArguments(context.call.function.arguments);
    if (args === undefined) return toolFailure("mcp.call", "validation", "MCP tool arguments must be a JSON object");
    return this.callMcp(context.agentId, context.call.function.name, args, context.signal);
  }

  private async callMcp(
    agentId: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    try {
      const value = await this.options.mcpManager.callProviderTool(agentId, name, args, { signal });
      const content = JSON.stringify(value);
      if (isMcpToolErrorResult(value)) {
        const message = "MCP tool reported an execution error";
        return {
          handled: true,
          ok: false,
          content,
          error: content,
          result: { ok: false, operation: "mcp.call", code: "tool_error", message },
        };
      }
      return {
        handled: true,
        ok: true,
        content,
        result: { ok: true, operation: "mcp.call", bytes: Buffer.byteLength(content) },
      };
    } catch (error) {
      return mcpFailure("mcp.call", error, "MCP tool execution failed");
    }
  }

  public executor(): ToolCallExecutor {
    const executor = (context: ToolExecutionContext) => this.execute(context);
    return Object.assign(executor, {
      canHandle: (name: string) => this.skillDispatcher.canHandle(name)
        || isMcpProviderToolName(name)
        || name === SEARCH_MCP_TOOLS_NAME
        || name === CALL_MCP_TOOL_NAME,
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
