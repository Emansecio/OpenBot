import { MODEL_CATALOG } from "../config/models.js";
import { MAX_AGENT_DESCRIPTION_BYTES, MAX_AGENT_NAME_CHARS } from "../config/store.js";
import type { ToolCallExecutor, ToolExecutionContext, ToolExecutionResult } from "../execution/tool-loop.js";
import type { ProviderTool } from "../providers/router.js";
import { RpcError } from "../server/gateway.js";
import { REASONING_EFFORTS, type ProviderKind, type ReasoningEffort } from "../shared/contracts.js";

export const CREATE_BOT_TOOL_NAME = "create_bot";

export const CREATE_BOT_SYSTEM_PROMPT =
  "You can create and configure another OpenBot bot with the create_bot tool when the user explicitly asks you to do so. " +
  "Never create bots speculatively. Put the new bot's complete persona, responsibilities, boundaries, and working instructions in description. " +
  "Every created bot receives its own persistent workspace and the standard local runtime and tools. With no inference overrides it inherits your settings; a provider-only override selects that provider's compatible default model.";

export const CREATE_BOT_TOOL: ProviderTool = {
  type: "function",
  function: {
    name: CREATE_BOT_TOOL_NAME,
    description: "Create and initially configure another persistent OpenBot bot. Use only when the user explicitly requests a new bot.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "description"],
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: MAX_AGENT_NAME_CHARS,
          description: "Display name of the new bot.",
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: MAX_AGENT_NAME_CHARS,
          description: "Short role title shown in the interface. Defaults to name.",
        },
        description: {
          type: "string",
          minLength: 1,
          description: "Complete persona, responsibilities, boundaries, and working instructions for the new bot.",
        },
        provider: {
          type: "string",
          enum: ["openai", "xai", "opencode-go", "openai-compat"],
          description: "Optional inference provider. When omitted, it is inherited or inferred from model.",
        },
        model: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Optional model id. When omitted, it is inherited or selected from provider.",
        },
        reasoning_effort: {
          type: "string",
          enum: [...REASONING_EFFORTS],
          description: "Optional reasoning effort. When omitted, it is inherited from the creator.",
        },
      },
    },
  },
};

interface AgentInference {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

export interface AgentManagementToolsOptions {
  invokeCreateAgent: (body: Record<string, unknown>) => Promise<unknown>;
  resolveInference: (agentId: string) => AgentInference;
}

const PROVIDERS = ["openai", "xai", "opencode-go", "openai-compat"] as const;

const failure = (code: string, message: string): ToolExecutionResult => ({
  handled: true,
  ok: false,
  content: JSON.stringify({ ok: false, code, message }),
  error: message,
  result: { ok: false, operation: "bot.create", code, message },
});

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseArguments(raw: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function textField(
  body: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxCharacters?: number; maxBytes?: number } = {},
): string | undefined {
  const value = body[key];
  if (value === undefined && options.required !== true) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  const trimmed = value.trim();
  if (options.maxCharacters !== undefined && [...trimmed].length > options.maxCharacters) {
    throw new Error(`${key} is too long`);
  }
  if (options.maxBytes !== undefined && Buffer.byteLength(trimmed, "utf8") > options.maxBytes) {
    throw new Error(`${key} is too long`);
  }
  if (trimmed.includes("\0")) throw new Error(`${key} contains an invalid character`);
  return trimmed;
}

function providerField(body: Record<string, unknown>): ProviderKind | undefined {
  if (body.provider === undefined) return undefined;
  if (typeof body.provider !== "string" || !(PROVIDERS as readonly string[]).includes(body.provider)) {
    throw new Error("provider is invalid");
  }
  return body.provider as ProviderKind;
}

function reasoningField(body: Record<string, unknown>): ReasoningEffort | undefined {
  if (body.reasoning_effort === undefined) return undefined;
  if (typeof body.reasoning_effort !== "string" || !(REASONING_EFFORTS as readonly string[]).includes(body.reasoning_effort)) {
    throw new Error("reasoning_effort is invalid");
  }
  return body.reasoning_effort as ReasoningEffort;
}

function createdAgent(value: unknown): Record<string, unknown> {
  const agent = record(record(value)?.agent);
  if (agent === undefined || typeof agent.id !== "string") throw new Error("createAgent returned an invalid result");
  return agent;
}

export class AgentManagementTools {
  public constructor(private readonly options: AgentManagementToolsOptions) {}

  public providerTools(baseTools: readonly ProviderTool[] = []): ProviderTool[] {
    return [...baseTools.filter((tool) => tool.function.name !== CREATE_BOT_TOOL_NAME), CREATE_BOT_TOOL];
  }

  private async execute(context: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (context.call.function.name !== CREATE_BOT_TOOL_NAME) return { handled: false };
    if (context.signal?.aborted) return failure("aborted", "Bot creation was cancelled");
    const body = parseArguments(context.call.function.arguments);
    if (body === undefined) return failure("validation", "create_bot arguments must be a JSON object");

    let request: Record<string, unknown>;
    try {
      const name = textField(body, "name", { required: true, maxCharacters: MAX_AGENT_NAME_CHARS })!;
      const title = textField(body, "title", { maxCharacters: MAX_AGENT_NAME_CHARS });
      const description = textField(body, "description", { required: true, maxBytes: MAX_AGENT_DESCRIPTION_BYTES })!;
      const requestedProvider = providerField(body);
      const requestedModel = textField(body, "model", { maxCharacters: 256 });
      const creator = this.options.resolveInference(context.agentId);
      const creatorProvider = (PROVIDERS as readonly string[]).includes(creator.provider)
        ? creator.provider as ProviderKind
        : undefined;
      const requestedCatalogModel = requestedModel === undefined
        ? undefined
        : MODEL_CATALOG.find((entry) => entry.id === requestedModel);
      const inheritedProvider = requestedModel === undefined || requestedCatalogModel === undefined
        ? creatorProvider
        : undefined;
      request = {
        name,
        title: title ?? name,
        description,
        origin: `agent:${context.agentId}`,
        ...(requestedProvider ?? inheritedProvider ? { provider: requestedProvider ?? inheritedProvider } : {}),
        ...(requestedModel !== undefined
          ? { model: requestedModel }
          : requestedProvider === undefined ? { model: creator.model } : {}),
        reasoningEffort: reasoningField(body) ?? creator.reasoningEffort,
      };
    } catch (error) {
      return failure("validation", error instanceof Error ? error.message : "create_bot arguments are invalid");
    }

    try {
      const agent = createdAgent(await this.options.invokeCreateAgent(request));
      const inference = this.options.resolveInference(agent.id as string);
      const response = {
        ok: true,
        agent: {
          id: agent.id,
          name: agent.name,
          title: agent.title,
          description: agent.description,
          provider: inference.provider,
          model: inference.model,
          reasoningEffort: inference.reasoningEffort,
        },
      };
      return {
        handled: true,
        ok: true,
        content: JSON.stringify(response),
        result: { ok: true, operation: "bot.create", count: 1 },
      };
    } catch (error) {
      const message = error instanceof RpcError && error.status >= 400 && error.status < 500
        ? error.message
        : "Bot creation failed";
      return failure("create_failed", message);
    }
  }

  public executor(): ToolCallExecutor {
    const executor = (context: ToolExecutionContext) => this.execute(context);
    return Object.assign(executor, {
      canHandle: (name: string) => name === CREATE_BOT_TOOL_NAME,
    });
  }
}

export function createAgentManagementTools(options: AgentManagementToolsOptions): AgentManagementTools {
  return new AgentManagementTools(options);
}
