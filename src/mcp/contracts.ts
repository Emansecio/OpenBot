import type {
  CallToolRequest,
  CallToolRequestOptions,
  CallToolResult,
  CacheableRequestOptions,
  ListToolsRequest,
  ListToolsResult,
  Tool,
} from "@modelcontextprotocol/client";

/** Shared MCP transport kind. Configuration never carries resolved secrets. */
export type McpTransportKind = "http" | "stdio";
export type McpSessionScope = "shared" | "agent";

export interface McpSecretRef {
  secretRef: string;
}

export interface McpHttpServerConfig {
  id: string;
  transport: "http";
  url: string;
  /** Header values are references resolved by the host keystore at connect time. */
  headers?: Record<string, McpSecretRef>;
  timeoutMs?: number;
  maxResultBytes?: number;
  /** Shared by default; agent isolates stateful server sessions and metadata per bot. */
  sessionScope?: McpSessionScope;
}

export interface McpStdioServerConfig {
  id: string;
  transport: "stdio";
  command: string;
  args?: string[];
  cwd: string;
  /** Environment values are references resolved by the host keystore at connect time. */
  env?: Record<string, McpSecretRef>;
  timeoutMs?: number;
  maxResultBytes?: number;
  /** Shared by default; agent isolates stateful server sessions and metadata per bot. */
  sessionScope?: McpSessionScope;
}

export type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig;

export interface McpAgentPolicy {
  enabled: boolean;
  /** Omitted means no server is allowed; callers must opt a server in explicitly. */
  serverAllowlist?: string[];
  /** Exact provider name, `serverId/toolName`, or tool name. */
  toolAllowlist?: string[];
  /** Deny always wins over allow. Same matching forms as toolAllowlist. */
  toolDenylist?: string[];
}

export interface McpProviderTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
  serverId: string;
  toolName: string;
}

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResultBytes?: number;
}

export interface McpListOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResultBytes?: number;
}

export interface McpConnectorContext {
  signal?: AbortSignal;
  /** Resolved only for the process/transport; never persisted by the manager. */
  headers?: Record<string, string>;
  /** Minimal explicit environment; never merged with process.env. */
  env?: Record<string, string>;
}

export interface McpClientSession {
  listTools(
    params?: ListToolsRequest["params"],
    options?: CacheableRequestOptions,
  ): Promise<ListToolsResult>;
  callTool(
    params: CallToolRequest["params"],
    options?: CallToolRequestOptions,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type McpConnector = (
  server: McpServerConfig,
  context: McpConnectorContext,
) => Promise<McpClientSession>;

export const MCP_PROVIDER_TOOL_PREFIX = "mcp__";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_TOOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class McpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpValidationError";
  }
}

export class McpPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpPolicyError";
  }
}

export class McpTimeoutError extends Error {
  constructor(message = "MCP request timed out") {
    super(message);
    this.name = "McpTimeoutError";
  }
}

export class McpAbortedError extends Error {
  constructor(message = "MCP request aborted") {
    super(message);
    this.name = "McpAbortedError";
  }
}

export class McpResultLimitError extends Error {
  constructor(message = "MCP result exceeds the byte limit") {
    super(message);
    this.name = "McpResultLimitError";
  }
}

export function validateMcpSegment(value: string, kind: "server" | "tool"): string {
  const pattern = kind === "server" ? SAFE_ID : SAFE_TOOL;
  if (typeof value !== "string" || !pattern.test(value) || value.includes("__")) {
    throw new McpValidationError(`${kind} id is invalid`);
  }
  return value;
}

/** Reversible mapping used at the provider boundary. `__` is forbidden in segments. */
export function toMcpProviderToolName(serverId: string, toolName: string): string {
  validateMcpSegment(serverId, "server");
  validateMcpSegment(toolName, "tool");
  return `${MCP_PROVIDER_TOOL_PREFIX}${serverId}__${toolName}`;
}

export function fromMcpProviderToolName(value: string): { serverId: string; toolName: string } {
  if (!value.startsWith(MCP_PROVIDER_TOOL_PREFIX)) throw new McpValidationError("MCP provider tool name is invalid");
  const body = value.slice(MCP_PROVIDER_TOOL_PREFIX.length);
  const separator = body.indexOf("__");
  if (separator <= 0 || separator === body.length - 2 || body.indexOf("__", separator + 2) !== -1) {
    throw new McpValidationError("MCP provider tool name is invalid");
  }
  const serverId = body.slice(0, separator);
  const toolName = body.slice(separator + 2);
  validateMcpSegment(serverId, "server");
  validateMcpSegment(toolName, "tool");
  return { serverId, toolName };
}

export function isMcpProviderToolName(value: string): boolean {
  try {
    fromMcpProviderToolName(value);
    return true;
  } catch {
    return false;
  }
}

export type McpTool = Tool;
