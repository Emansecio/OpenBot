import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type CallToolRequestOptions,
  type CallToolResult,
  type FetchLike,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/client";
import { Agent, fetch as undiciFetch } from "undici";
import net from "node:net";
import path from "node:path";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ProviderTool } from "../providers/router.js";
import {
  fromMcpProviderToolName,
  McpAbortedError,
  McpPolicyError,
  McpResultLimitError,
  McpTimeoutError,
  McpValidationError,
  type McpAgentPolicy,
  type McpCallOptions,
  type McpClientSession,
  type McpConnector,
  type McpConnectorContext,
  type McpListOptions,
  type McpProviderTool,
  type McpSecretRef,
  type McpServerConfig,
  toMcpProviderToolName,
  validateMcpSegment,
} from "./contracts.js";
import {
  DEFAULT_MCP_RESULT_BYTES,
  DEFAULT_MCP_LIST_CONCURRENCY,
  DEFAULT_MCP_TOOL_CACHE_TTL_MS,
  DEFAULT_MCP_TIMEOUT_MS,
  MAX_MCP_RESULT_BYTES,
  MAX_MCP_LIST_CONCURRENCY,
  MAX_MCP_ARG_BYTES,
  MAX_MCP_ARGS,
  MAX_MCP_ENV_ENTRIES,
  MAX_MCP_SERVERS,
  MAX_MCP_TIMEOUT_MS,
  MAX_MCP_TOOL_CACHE_TTL_MS,
  MAX_MCP_TOOLS,
  type McpDnsLookup,
  McpSecurityError,
  assertValidatedStdioCwd,
  resolveAndValidateHttpEndpoint,
  resolveSecretRefs,
  stageValidatedStdioExecutable,
  type ValidatedStdioConfig,
  validateMcpServerConfig,
  validateMcpToolMetadata,
  validateStdioConfig,
  type StdioSecurityOptions,
} from "./security.js";

export {
  McpAbortedError,
  McpPolicyError,
  McpResultLimitError,
  McpTimeoutError,
  McpValidationError,
};
export type { McpClientSession };

export interface McpManagerOptions {
  servers?: readonly McpServerConfig[];
  policies?: Readonly<Record<string, McpAgentPolicy>>;
  defaultPolicy?: McpAgentPolicy;
  connector?: McpConnector;
  secretResolver?: (secretRef: string) => Promise<string> | string;
  dnsLookup?: McpDnsLookup;
  stdioApprovedCwdRoots?: readonly string[];
  stdioAllowedCommands?: readonly string[];
  timeoutMs?: number;
  maxResultBytes?: number;
  closeTimeoutMs?: number;
  /** How long validated server tool metadata may be reused. */
  toolCacheTtlMs?: number;
  /** Maximum number of server metadata requests in flight per listing. */
  maxListConcurrency?: number;
}

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new McpValidationError("MCP tool arguments must be an object");
  return value as Record<string, unknown>;
};

const numberLimit = (value: number | undefined, fallback: number, maximum: number, name: string): number => {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > maximum) throw new McpValidationError(`${name} is invalid`);
  return candidate;
};

const jsonBytes = (value: unknown): number => {
  try { return Buffer.byteLength(JSON.stringify(value) ?? "null"); } catch { throw new McpValidationError("MCP result is not serializable"); }
};

const policyCopy = (policy: McpAgentPolicy): McpAgentPolicy => ({
  enabled: policy.enabled,
  ...(policy.serverAllowlist === undefined ? {} : { serverAllowlist: [...policy.serverAllowlist] }),
  ...(policy.toolAllowlist === undefined ? {} : { toolAllowlist: [...policy.toolAllowlist] }),
  ...(policy.toolDenylist === undefined ? {} : { toolDenylist: [...policy.toolDenylist] }),
});

const serverKey = (serverId: string): string => serverId.toLowerCase();
const sameServerId = (left: string, right: string): boolean => serverKey(left) === serverKey(right);

const toolParameters = (tool: Tool): Record<string, unknown> => {
  const schema = tool.inputSchema;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return { type: "object", properties: {} };
  return schema;
};

const matchesToolRule = (rule: string, serverId: string, toolName: string, providerName: string): boolean => {
  if (rule === providerName || rule === toolName) return true;
  if (rule.startsWith("mcp__")) {
    try {
      const parsed = fromMcpProviderToolName(rule);
      return sameServerId(parsed.serverId, serverId) && parsed.toolName === toolName;
    } catch {
      return false;
    }
  }
  const slash = rule.indexOf("/");
  return slash > 0 && sameServerId(rule.slice(0, slash), serverId) && rule.slice(slash + 1) === toolName;
};

const asCallOptions = (options: McpCallOptions | McpListOptions | undefined, fallbackTimeout: number, fallbackBytes: number) => ({
  timeoutMs: numberLimit(options?.timeoutMs, fallbackTimeout, MAX_MCP_TIMEOUT_MS, "MCP timeout"),
  maxResultBytes: numberLimit(options?.maxResultBytes, fallbackBytes, MAX_MCP_RESULT_BYTES, "MCP result byte limit"),
  signal: options?.signal,
});

const preserveMcpError = (error: unknown): Error | undefined => {
  if (error instanceof McpAbortedError || error instanceof McpPolicyError || error instanceof McpResultLimitError || error instanceof McpTimeoutError || error instanceof McpValidationError || error instanceof McpSecurityError) return error;
  if (error instanceof Error && error.name === "AbortError") return new McpAbortedError();
  return undefined;
};

const sanitizeExternalError = (error: unknown, fallback: string): Error => preserveMcpError(error) ?? new McpValidationError(fallback);

const SESSION_SDK_ERROR_CODES = new Set<SdkErrorCode>([
  SdkErrorCode.ConnectionClosed,
  SdkErrorCode.SendFailed,
  SdkErrorCode.NotConnected,
  SdkErrorCode.ClientHttpNotImplemented,
  SdkErrorCode.ClientHttpAuthentication,
  SdkErrorCode.ClientHttpForbidden,
  SdkErrorCode.ClientHttpUnexpectedContent,
  SdkErrorCode.ClientHttpFailedToOpenStream,
]);

/** Invalidate only failures that leave an SDK transport/session unusable. */
const isSessionTransportFailure = (error: unknown): boolean => {
  if (error instanceof McpAbortedError || error instanceof McpTimeoutError || error instanceof McpPolicyError || error instanceof McpResultLimitError || error instanceof McpValidationError || error instanceof McpSecurityError) return false;
  if (ProtocolError.isInstance(error)) return false;
  if (SdkError.isInstance(error)) {
    return SESSION_SDK_ERROR_CODES.has(error.code);
  }
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]).has(code)) return true;
  const message = error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? "");
  return /(?:transport|connection|socket|stream|broken pipe|reset|closed|disconnected|econnreset|econnrefused|epipe|timed out)/iu.test(message);
};

type ResolvedStdioLaunch = Pick<
  ValidatedStdioConfig,
  "command" | "args" | "cwd" | "cwdIdentity" | "commandIdentity"
>;

interface ResolvedConnectorContext extends McpConnectorContext {
  /** Internal launch data; stripped before invoking an injected connector. */
  stdio?: ResolvedStdioLaunch;
}

interface CachedSession {
  readonly cacheKey: string;
  readonly serverKey: string;
  readonly agentKey?: string;
  promise: Promise<McpClientSession>;
  readonly controller: AbortController;
  pending: boolean;
  waiters: number;
}

interface CachedToolList {
  readonly cacheKey: string;
  readonly serverKey: string;
  readonly agentKey?: string;
  readonly version: number;
  readonly promise: Promise<ListToolsResult>;
  readonly controller: AbortController;
  pending: boolean;
  expiresAt: number;
  waiters: number;
  failureCount: number;
  failureKind?: string;
}

const MCP_NEGATIVE_CACHE_BACKOFF_MS = [5_000, 30_000, 120_000] as const;
const MAX_MCP_TOOL_PAGES = MAX_MCP_TOOLS;
const negativeCacheKind = (error: unknown): string => error instanceof McpTimeoutError
  ? "timeout"
  : error instanceof McpValidationError
    ? "validation"
    : "connection";

const abortError = (signal: AbortSignal): Error => {
  if (signal.reason instanceof McpTimeoutError) return signal.reason;
  if (signal.reason instanceof McpAbortedError) return signal.reason;
  return new McpAbortedError();
};

const agentKey = (agentId: string): string => agentId.toLowerCase();
const scopedResourceKey = (config: McpServerConfig, agentId: string): string => config.sessionScope === "agent"
  ? `${serverKey(config.id)}\0${agentKey(agentId)}`
  : serverKey(config.id);

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortError(signal);
};

const remainingBudget = (deadlineAt: number): number => {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new McpTimeoutError();
  return remaining;
};

/**
 * The SDK's stdio transport merges a small default host environment even
 * when an `env` object is supplied.  Explicitly shadow every inherited key,
 * then add only the values required by the configured server.
 */
const minimalStdioEnvironment = (
  supplied: Record<string, string> | undefined,
  command: string,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of DEFAULT_INHERITED_ENV_VARS) env[key] = "";
  // Windows' child-process loader needs these system locations to start a
  // Node executable. They are not user credentials and are copied narrowly,
  // rather than inheriting the whole host environment.
  for (const key of ["SYSTEMROOT", "SystemRoot", "WINDIR", "windir", "SYSTEMDRIVE", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (supplied !== undefined) Object.assign(env, supplied);

  // Named executables need PATH for process resolution.  Restrict it to the
  // current Node installation when the approved command is Node; absolute
  // commands do not need PATH at all.  Other named commands should be
  // configured by absolute path so no broad host PATH is inherited.
  const commandName = path.basename(command).toLowerCase();
  if (!/^[A-Za-z]:[\\/]/u.test(command) && !command.startsWith("/") &&
    new Set(["node", "node.exe", path.basename(process.execPath).toLowerCase()]).has(commandName)) {
    env.PATH = path.dirname(process.execPath);
    if (process.platform === "win32") env.Path = env.PATH;
  }
  return env;
};

const limitedResponse = async (response: Response, maxBytes: number): Promise<Response> => {
  if (response.body === null) return response;
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxBytes) {
      await response.body.cancel();
      throw new McpResultLimitError("MCP HTTP response exceeds the byte limit");
    }
  }
  const reader = response.body.getReader();
  let total = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        total += next.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          controller.error(new McpResultLimitError("MCP HTTP response exceeds the byte limit"));
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

export const createPinnedDnsLookup = (endpoint: URL, pinnedAddress: string, family: number) => (
  hostname: string,
  options: { all?: boolean },
  callback: (error: Error | null, address: string | Array<{ address: string; family: number }>, callbackFamily?: number) => void,
): void => {
  if (hostname.toLowerCase() !== endpoint.hostname.toLowerCase()) {
    const error = new Error("MCP endpoint hostname changed");
    if (options.all === true) callback(error, []);
    else callback(error, "", 0);
    return;
  }
  if (options.all === true) callback(null, [{ address: pinnedAddress, family }]);
  else callback(null, pinnedAddress, family);
};

const pinnedHttpDispatcher = (endpoint: URL, addresses: readonly string[]): Agent => {
  const pinnedAddress = addresses[0];
  if (pinnedAddress === undefined) throw new McpSecurityError("MCP endpoint has no resolved address");
  const family = net.isIP(pinnedAddress);
  return new Agent({
    maxRedirections: 0,
    connect: {
      lookup: createPinnedDnsLookup(endpoint, pinnedAddress, family),
    },
  });
};

export class McpManager {
  private readonly servers = new Map<string, McpServerConfig>();
  private readonly serverVersions = new Map<string, number>();
  private readonly toolLists = new Map<string, CachedToolList>();
  private readonly policies = new Map<string, McpAgentPolicy>();
  private readonly sessions = new Map<string, CachedSession>();
  private readonly connector?: McpConnector;
  private readonly secretResolver?: (secretRef: string) => Promise<string> | string;
  private readonly dnsLookup?: McpDnsLookup;
  private readonly stdioSecurity: StdioSecurityOptions;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxResultBytes: number;
  private readonly closeTimeoutMs: number;
  private readonly toolCacheTtlMs: number;
  private readonly maxListConcurrency: number;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: McpManagerOptions = {}) {
    this.connector = options.connector;
    this.secretResolver = options.secretResolver;
    this.dnsLookup = options.dnsLookup;
    this.stdioSecurity = {
      approvedCwdRoots: [...(options.stdioApprovedCwdRoots ?? [])],
      // The manager itself is allowed to launch its own Node runtime for
      // local fixtures even when the caller did not provide an explicit list.
      // Any other executable still requires an exact name/path allowlist.
      allowedCommands: [...(options.stdioAllowedCommands ?? []), process.execPath],
    };
    this.defaultTimeoutMs = numberLimit(options.timeoutMs, DEFAULT_MCP_TIMEOUT_MS, MAX_MCP_TIMEOUT_MS, "MCP timeout");
    this.defaultMaxResultBytes = numberLimit(options.maxResultBytes, DEFAULT_MCP_RESULT_BYTES, MAX_MCP_RESULT_BYTES, "MCP result byte limit");
    this.closeTimeoutMs = numberLimit(options.closeTimeoutMs, 5_000, MAX_MCP_TIMEOUT_MS, "MCP close timeout");
    this.toolCacheTtlMs = numberLimit(options.toolCacheTtlMs, DEFAULT_MCP_TOOL_CACHE_TTL_MS, MAX_MCP_TOOL_CACHE_TTL_MS, "MCP tool cache TTL");
    this.maxListConcurrency = numberLimit(options.maxListConcurrency, DEFAULT_MCP_LIST_CONCURRENCY, MAX_MCP_LIST_CONCURRENCY, "MCP list concurrency");
    for (const server of options.servers ?? []) this.setServer(server);
    for (const [agentId, policy] of Object.entries(options.policies ?? {})) this.setAgentPolicy(agentId, policy);
    this.defaultPolicy = policyCopy(options.defaultPolicy ?? { enabled: false });
  }

  private readonly defaultPolicy: McpAgentPolicy;

  validateServer(config: McpServerConfig): void {
    validateMcpServerConfig(config);
    if (config.timeoutMs !== undefined) numberLimit(config.timeoutMs, this.defaultTimeoutMs, MAX_MCP_TIMEOUT_MS, "MCP timeout");
    if (config.maxResultBytes !== undefined) numberLimit(config.maxResultBytes, this.defaultMaxResultBytes, MAX_MCP_RESULT_BYTES, "MCP result byte limit");
    validateMcpSegment(config.id, "server");
    const secretEntries = config.transport === "http" ? config.headers : config.env;
    if (secretEntries !== undefined && Object.keys(secretEntries).length > MAX_MCP_ENV_ENTRIES) {
      throw new McpValidationError("MCP secret entry count exceeds the limit");
    }
    if (config.transport === "stdio" && (config.args?.length ?? 0) > MAX_MCP_ARGS) {
      throw new McpValidationError("MCP stdio args exceed the limit");
    }
    if (config.transport === "stdio" && config.args?.some((arg) =>
      typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg, "utf8") > MAX_MCP_ARG_BYTES)) {
      throw new McpValidationError("MCP stdio args are invalid");
    }
  }

  setServer(config: McpServerConfig): void {
    this.validateServer(config);
    const key = serverKey(config.id);
    if (this.servers.has(key)) throw new McpValidationError(`MCP server ${config.id} is duplicated`);
    if (this.servers.size >= MAX_MCP_SERVERS) throw new McpValidationError("MCP server count exceeds the limit");
    this.servers.set(key, structuredClone(config));
    this.invalidateServerMetadata(key);
  }

  /** Replace a configured server only after validating the complete new value. */
  replaceServer(config: McpServerConfig): void {
    this.validateServer(config);
    const key = serverKey(config.id);
    if (!this.servers.has(key) && this.servers.size >= MAX_MCP_SERVERS) {
      throw new McpValidationError("MCP server count exceeds the limit");
    }
    this.invalidateServerSessions(key);
    this.invalidateServerMetadata(key);
    this.servers.set(key, structuredClone(config));
  }

  /** Invalidate only servers that reference a changed keystore secret. */
  invalidateSecret(secretRef: string): void {
    for (const [key, config] of this.servers) {
      const refs = config.transport === "http" ? config.headers : config.env;
      if (!refs || !Object.values(refs).some((entry) => entry.secretRef === secretRef)) continue;
      this.invalidateServerSessions(key);
      this.invalidateServerMetadata(key);
    }
  }

  removeServer(serverId: string): void {
    validateMcpSegment(serverId, "server");
    const key = serverKey(serverId);
    const removed = this.servers.delete(key);
    const hadMetadata = [...this.toolLists.values()].some((entry) => entry.serverKey === key);
    const hadSession = [...this.sessions.values()].some((entry) => entry.serverKey === key);
    this.invalidateServerSessions(key);
    this.invalidateServerMetadata(key);
    // Version identity plus entry identity protects an in-flight request
    // even when a removed id is later configured again. Do not retain version
    // state for arbitrary unknown ids.
    if (removed || hadMetadata || hadSession) this.serverVersions.delete(key);
  }

  getServer(serverId: string): McpServerConfig | undefined {
    validateMcpSegment(serverId, "server");
    const value = this.servers.get(serverKey(serverId));
    return value === undefined ? undefined : structuredClone(value);
  }

  /** Drop all per-agent policy state after an agent has been deleted. */
  removeAgent(agentId: string): void {
    if (typeof agentId !== "string" || agentId.length === 0 || agentId.includes("\0")) {
      throw new McpValidationError("agent id is invalid");
    }
    this.policies.delete(agentId);
    const key = agentKey(agentId);
    for (const [cacheKey, entry] of this.sessions) {
      if (entry.agentKey !== key) continue;
      this.sessions.delete(cacheKey);
      entry.controller.abort(new McpAbortedError());
      void entry.promise.then((session) => this.closeSession(session)).catch(() => {});
    }
    for (const [cacheKey, entry] of this.toolLists) {
      if (entry.agentKey !== key) continue;
      this.toolLists.delete(cacheKey);
      entry.controller.abort(new McpAbortedError());
    }
  }

  private invalidateServerMetadata(key: string): void {
    this.serverVersions.set(key, (this.serverVersions.get(key) ?? 0) + 1);
    for (const [cacheKey, entry] of this.toolLists) {
      if (entry.serverKey !== key) continue;
      this.toolLists.delete(cacheKey);
    }
  }

  private invalidateServerSessions(key: string): void {
    for (const [cacheKey, entry] of this.sessions) {
      if (entry.serverKey !== key) continue;
      this.sessions.delete(cacheKey);
      entry.controller.abort(new McpAbortedError());
      void entry.promise.then((session) => this.closeSession(session)).catch(() => {});
    }
  }

  setAgentPolicy(agentId: string, policy: McpAgentPolicy): void {
    if (typeof agentId !== "string" || agentId.length === 0 || agentId.includes("\0")) throw new McpValidationError("agent id is invalid");
    if (typeof policy.enabled !== "boolean") throw new McpValidationError("MCP policy enabled is invalid");
    for (const list of [policy.serverAllowlist, policy.toolAllowlist, policy.toolDenylist]) {
      if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== "string" || item.length === 0 || item.includes("\0")))) {
        throw new McpValidationError("MCP policy list is invalid");
      }
    }
    this.policies.set(agentId, policyCopy(policy));
  }

  getAgentPolicy(agentId: string): McpAgentPolicy {
    return policyCopy(this.policies.get(agentId) ?? this.defaultPolicy);
  }

  private requirePolicy(agentId: string): McpAgentPolicy {
    const policy = this.policies.get(agentId) ?? this.defaultPolicy;
    if (!policy.enabled) throw new McpPolicyError("MCP is disabled for this bot");
    return policy;
  }

  private serverAllowed(policy: McpAgentPolicy, serverId: string): boolean {
    return policy.serverAllowlist !== undefined && policy.serverAllowlist.some((id) => sameServerId(id, serverId));
  }

  private toolAllowed(policy: McpAgentPolicy, serverId: string, toolName: string): boolean {
    const providerName = toMcpProviderToolName(serverId, toolName);
    if (policy.toolDenylist?.some((rule) => matchesToolRule(rule, serverId, toolName, providerName))) return false;
    return policy.toolAllowlist === undefined || policy.toolAllowlist.some((rule) => matchesToolRule(rule, serverId, toolName, providerName));
  }

  private async resolveContext(config: McpServerConfig, signal: AbortSignal): Promise<ResolvedConnectorContext> {
    throwIfAborted(signal);
    if (config.transport === "http") {
      await resolveAndValidateHttpEndpoint(config.url, this.dnsLookup);
      const headers = await this.resolveRefs(config.headers);
      throwIfAborted(signal);
      return { signal, ...(headers === undefined ? {} : { headers }) };
    }
    const validated = await validateStdioConfig(config, this.stdioSecurity);
    const env = await this.resolveRefs(validated.env);
    throwIfAborted(signal);
    return {
      signal,
      ...(env === undefined ? {} : { env }),
      stdio: {
        command: validated.command,
        args: validated.args,
        cwd: validated.cwd,
        cwdIdentity: validated.cwdIdentity,
        commandIdentity: validated.commandIdentity,
      },
    };
  }

  private async resolveRefs(values: Record<string, McpSecretRef> | undefined): Promise<Record<string, string> | undefined> {
    if (values === undefined) return undefined;
    if (this.secretResolver === undefined) throw new McpValidationError("MCP secret resolver is not configured");
    return resolveSecretRefs(values, this.secretResolver);
  }

  private async connect(config: McpServerConfig, signal: AbortSignal): Promise<McpClientSession> {
    let session: McpClientSession | undefined;
    let closedSession = false;
    try {
      const context = await this.resolveContext(config, signal);
      const connectorContext: McpConnectorContext = {
        signal,
        ...(context.headers === undefined ? {} : { headers: context.headers }),
        ...(context.env === undefined ? {} : { env: context.env }),
      };
      session = this.connector === undefined
        ? await this.connectWithSdk(config, context)
        : await this.connector(structuredClone(config), connectorContext);
      if (!session || typeof session.listTools !== "function" || typeof session.callTool !== "function" || typeof session.close !== "function") {
        throw new McpValidationError("MCP connector returned an invalid session");
      }
      // A connector may ignore AbortSignal and resolve after the deadline. It
      // must never be published into the shared session map in that case.
      if (this.closed || signal.aborted) {
        await session.close().catch(() => {});
        closedSession = true;
        if (this.closed) throw new McpValidationError("MCP manager is closed");
        throw abortError(signal);
      }
      return session;
    } catch (error) {
      if (session !== undefined && !closedSession) await session.close().catch(() => {});
      throw sanitizeExternalError(error, "MCP connection failed");
    }
  }

  private getSession(config: McpServerConfig, agentId: string): CachedSession {
    if (this.closed) throw new McpValidationError("MCP manager is closed");
    const key = scopedResourceKey(config, agentId);
    const existing = this.sessions.get(key);
    if (existing !== undefined) return existing;
    const controller = new AbortController();
    const entry: CachedSession = {
      cacheKey: key,
      serverKey: serverKey(config.id),
      ...(config.sessionScope === "agent" ? { agentKey: agentKey(agentId) } : {}),
      promise: undefined as unknown as Promise<McpClientSession>,
      controller,
      pending: true,
      waiters: 0,
    };
    entry.promise = this.connect(config, controller.signal).then(
      (session) => {
        entry.pending = false;
        return session;
      },
      (error: unknown) => {
        entry.pending = false;
        if (this.sessions.get(key) === entry) this.sessions.delete(key);
        throw error;
      },
    );
    this.sessions.set(key, entry);
    return entry;
  }

  private async waitForSession(
    config: McpServerConfig,
    agentId: string,
    signal: AbortSignal,
  ): Promise<{ entry: CachedSession; session: McpClientSession }> {
    throwIfAborted(signal);
    const entry = this.getSession(config, agentId);
    entry.waiters += 1;
    let abortListener: (() => void) | undefined;
    try {
      const session = await new Promise<McpClientSession>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
          callback();
        };
        abortListener = () => finish(() => reject(abortError(signal)));
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) abortListener();
        entry.promise.then(
          (connected) => finish(() => resolve(connected)),
          (error: unknown) => finish(() => reject(error)),
        );
      });
      return { entry, session };
    } finally {
      if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (entry.pending && entry.waiters === 0 && !entry.controller.signal.aborted) {
        entry.controller.abort(signal.reason instanceof Error ? signal.reason : new McpAbortedError());
      }
    }
  }

  private invalidateSession(entry: CachedSession, session: McpClientSession): void {
    // A replacement/removal may have installed a newer entry while this
    // operation was in flight. Never evict or close that newer session.
    if (this.sessions.get(entry.cacheKey) !== entry) return;
    this.sessions.delete(entry.cacheKey);
    void this.closeSession(session).catch(() => {});
  }

  private serverFor(serverId: string): McpServerConfig {
    const config = this.servers.get(serverKey(serverId));
    if (config === undefined) throw new McpValidationError(`MCP server ${serverId} is not configured`);
    return config;
  }

  private async runWithDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, sourceSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sourceAbort: (() => void) | undefined;
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    const deadline = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new McpTimeoutError());
        reject(new McpTimeoutError());
      }, timeoutMs);
      if (sourceSignal !== undefined) {
        sourceAbort = () => {
          controller.abort(sourceSignal.reason);
          reject(new McpAbortedError());
        };
        if (sourceSignal.aborted) sourceAbort();
        else sourceSignal.addEventListener("abort", sourceAbort, { once: true });
      }
    });
    try {
      return await Promise.race([operationPromise, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (sourceSignal !== undefined && sourceAbort !== undefined) sourceSignal.removeEventListener("abort", sourceAbort);
    }
  }

  private async fetchServerTools(config: McpServerConfig, agentId: string, sourceSignal?: AbortSignal): Promise<ListToolsResult> {
    const timeoutMs = config.timeoutMs ?? this.defaultTimeoutMs;
    const deadlineAt = Date.now() + timeoutMs;
    let entry: CachedSession | undefined;
    let session: McpClientSession;
    try {
      const acquired = await this.runWithDeadline(
        (signal) => this.waitForSession(config, agentId, signal),
        remainingBudget(deadlineAt),
        sourceSignal,
      );
      entry = acquired.entry;
      session = acquired.session;
    } catch (error) {
      throw sanitizeExternalError(error, "MCP connection failed");
    }
    const maxResultBytes = config.maxResultBytes ?? this.defaultMaxResultBytes;
    const tools: Tool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;
    let listingBytes = 0;
    while (true) {
      if (sourceSignal !== undefined) throwIfAborted(sourceSignal);
      if (pageCount >= MAX_MCP_TOOL_PAGES) throw new McpValidationError("MCP tool page count exceeds the limit");
      const pageTimeoutMs = remainingBudget(deadlineAt);
      let listed: ListToolsResult;
      try {
        listed = await this.runWithDeadline((signal) => session.listTools(
          cursor === undefined ? undefined : { cursor },
          { signal, timeout: pageTimeoutMs, maxTotalTimeout: pageTimeoutMs },
        ), pageTimeoutMs, sourceSignal);
      } catch (error) {
        if (entry !== undefined && isSessionTransportFailure(error)) this.invalidateSession(entry, session);
        throw sanitizeExternalError(error, "MCP tool listing failed");
      }
      pageCount += 1;
      if (!Array.isArray(listed.tools)) throw new McpValidationError("MCP tool list is invalid");
      if (listed.tools.length > MAX_MCP_TOOLS - tools.length) throw new McpValidationError("MCP tool count exceeds the limit");
      const pageBytes = jsonBytes(listed);
      if (pageBytes > maxResultBytes || listingBytes > maxResultBytes - pageBytes) {
        throw new McpResultLimitError("MCP tool list exceeds the byte limit");
      }
      listingBytes += pageBytes;
      tools.push(...listed.tools);
      if (jsonBytes({ tools }) > maxResultBytes) throw new McpResultLimitError("MCP tool list exceeds the byte limit");

      const nextCursor = listed.nextCursor;
      if (nextCursor === undefined) return { tools };
      if (typeof nextCursor !== "string") throw new McpValidationError("MCP pagination cursor is invalid");
      if (seenCursors.has(nextCursor)) throw new McpValidationError("MCP pagination cursor repeated");
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  private cachedServerTools(config: McpServerConfig, agentId: string): CachedToolList {
    const key = scopedResourceKey(config, agentId);
    const configKey = serverKey(config.id);
    const version = this.serverVersions.get(configKey) ?? 0;
    const existing = this.toolLists.get(key);
    if (existing !== undefined && existing.version === version && (existing.pending || existing.expiresAt > Date.now())) {
      return existing;
    }
    const previousFailureCount = existing?.failureCount ?? 0;
    const previousFailureKind = existing?.failureKind;

    let entry!: CachedToolList;
    const controller = new AbortController();
    const promise = this.fetchServerTools(config, agentId, controller.signal).then((listed) => {
      entry.pending = false;
      if (this.toolLists.get(key) !== entry || this.serverVersions.get(configKey) !== entry.version) {
        throw new McpValidationError("MCP server configuration changed during tool listing");
      }
      entry.expiresAt = Date.now() + this.toolCacheTtlMs;
      return listed;
    }, (error: unknown) => {
      entry.pending = false;
      if (error instanceof McpAbortedError) {
        if (this.toolLists.get(key) === entry) this.toolLists.delete(key);
      } else if (this.toolLists.get(key) === entry) {
        const kind = negativeCacheKind(error);
        entry.failureKind = kind;
        entry.failureCount = previousFailureKind === kind ? previousFailureCount + 1 : 1;
        entry.expiresAt = Date.now() + MCP_NEGATIVE_CACHE_BACKOFF_MS[Math.min(entry.failureCount - 1, MCP_NEGATIVE_CACHE_BACKOFF_MS.length - 1)]!;
      }
      throw error;
    });
    entry = {
      cacheKey: key,
      serverKey: configKey,
      ...(config.sessionScope === "agent" ? { agentKey: agentKey(agentId) } : {}),
      version,
      promise,
      controller,
      pending: true,
      expiresAt: 0,
      waiters: 0,
      failureCount: 0,
    };
    this.toolLists.set(key, entry);
    return entry;
  }

  private async listServerTools(
    config: McpServerConfig,
    agentId: string,
    options: McpListOptions | McpCallOptions | undefined,
    deadlineAt?: number,
  ): Promise<ListToolsResult> {
    const transportByteLimit = config.maxResultBytes ?? this.defaultMaxResultBytes;
    if (options?.maxResultBytes !== undefined && options.maxResultBytes < transportByteLimit) {
      throw new McpValidationError("MCP per-call byte limit cannot be lower than the transport limit");
    }
    const limits = asCallOptions(options, config.timeoutMs ?? this.defaultTimeoutMs, config.maxResultBytes ?? this.defaultMaxResultBytes);
    const cache = this.cachedServerTools(config, agentId);
    cache.waiters += 1;
    try {
      const timeoutMs = deadlineAt === undefined ? limits.timeoutMs : remainingBudget(deadlineAt);
      const listed = await this.runWithDeadline(() => cache.promise, timeoutMs, limits.signal);
      if (jsonBytes(listed) > limits.maxResultBytes) throw new McpResultLimitError("MCP tool list exceeds the byte limit");
      return listed;
    } catch (error) {
      throw sanitizeExternalError(error, "MCP tool listing failed");
    } finally {
      cache.waiters -= 1;
      if (cache.pending && cache.waiters === 0) cache.controller.abort(new McpAbortedError());
    }
  }

  private async providerToolsForServer(
    config: McpServerConfig,
    policy: McpAgentPolicy,
    agentId: string,
    options?: McpListOptions,
    deadlineAt?: number,
  ): Promise<McpProviderTool[]> {
    if (!this.serverAllowed(policy, config.id)) return [];
    const listed = await this.listServerTools(config, agentId, options, deadlineAt);
    const output: McpProviderTool[] = [];
    const seen = new Set<string>();
    for (const tool of listed.tools) {
      if (output.length >= MAX_MCP_TOOLS) break;
      try {
        validateMcpToolMetadata(tool);
        const providerName = toMcpProviderToolName(config.id, tool.name);
        if (!this.toolAllowed(policy, config.id, tool.name)) continue;
        if (seen.has(providerName)) continue;
        seen.add(providerName);
        output.push({
          type: "function",
          function: { name: providerName, ...(tool.description === undefined ? {} : { description: tool.description }), parameters: toolParameters(tool) },
          serverId: config.id,
          toolName: tool.name,
        });
      } catch {
        // Tool names are untrusted server data; invalid names are omitted.
      }
    }
    return output;
  }

  async listProviderToolsForServer(agentId: string, serverId: string, options?: McpListOptions): Promise<McpProviderTool[]> {
    const policy = this.policies.get(agentId) ?? this.defaultPolicy;
    if (!policy.enabled) return [];
    return this.providerToolsForServer(this.serverFor(serverId), policy, agentId, options);
  }

  async listProviderTools(agentId: string, options?: McpListOptions): Promise<McpProviderTool[]> {
    const policy = this.policies.get(agentId) ?? this.defaultPolicy;
    if (!policy.enabled) return [];
    const limits = asCallOptions(options, this.defaultTimeoutMs, this.defaultMaxResultBytes);
    const deadlineAt = Date.now() + limits.timeoutMs;
    const configs = [...this.servers.values()].filter((config) => this.serverAllowed(policy, config.id));
    const results = new Array<McpProviderTool[] | undefined>(configs.length);
    const failures = new Array<unknown>(configs.length);
    let cursor = 0;
    let succeeded = false;

    const worker = async (): Promise<void> => {
      while (true) {
        const index = cursor++;
        const config = configs[index];
        if (config === undefined) return;
        try {
          results[index] = await this.providerToolsForServer(config, policy, agentId, options, deadlineAt);
          succeeded = true;
        } catch (error) {
          // A single unavailable server must not hide healthy servers. An
          // explicit caller abort remains authoritative for the whole turn.
          if (options?.signal?.aborted) throw error;
          failures[index] = error;
        }
      }
    };
    const workerCount = Math.min(this.maxListConcurrency, configs.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    throwIfAborted(options?.signal ?? new AbortController().signal);

    const output: McpProviderTool[] = [];
    const seen = new Set<string>();
    for (const tools of results) {
      if (tools === undefined) continue;
      for (const tool of tools) {
        if (output.length >= MAX_MCP_TOOLS) return output;
        if (seen.has(tool.function.name)) continue;
        seen.add(tool.function.name);
        output.push(tool);
      }
    }
    if (!succeeded) {
      const firstFailure = failures.find((error) => error !== undefined);
      if (firstFailure !== undefined) throw firstFailure;
    }
    return output;
  }

  async listTools(agentId: string, options?: McpListOptions): Promise<McpProviderTool[]> {
    return this.listProviderTools(agentId, options);
  }

  async getProviderTools(agentId: string, options?: McpListOptions): Promise<ProviderTool[]> {
    const tools = await this.listProviderTools(agentId, options);
    return tools.map(({ serverId: _serverId, toolName: _toolName, ...providerTool }) => providerTool);
  }

  async callProviderTool(agentId: string, providerName: string, args: unknown, options?: McpCallOptions): Promise<CallToolResult> {
    const { serverId, toolName } = fromMcpProviderToolName(providerName);
    const policy = this.requirePolicy(agentId);
    if (!this.serverAllowed(policy, serverId) || !this.toolAllowed(policy, serverId, toolName)) {
      throw new McpPolicyError(`MCP tool ${providerName} is not allowed for this bot`);
    }
    const config = this.serverFor(serverId);
    const arguments_ = record(args);
    const limits = asCallOptions(options, config.timeoutMs ?? this.defaultTimeoutMs, config.maxResultBytes ?? this.defaultMaxResultBytes);
    const deadlineAt = Date.now() + limits.timeoutMs;
    const listed = await this.listServerTools(config, agentId, options, deadlineAt);
    const definition = listed.tools.find((tool) => tool.name === toolName);
    if (definition === undefined) throw new McpValidationError(`MCP tool ${providerName} is not available`);
    try { validateMcpToolMetadata(definition); } catch { throw new McpValidationError("MCP tool definition is invalid"); }
    let entry!: CachedSession;
    let session: McpClientSession;
    try {
      const sessionTimeoutMs = remainingBudget(deadlineAt);
      const acquired = await this.runWithDeadline((signal) => this.waitForSession(config, agentId, signal), sessionTimeoutMs, limits.signal);
      entry = acquired.entry;
      session = acquired.session;
    } catch (error) {
      throw sanitizeExternalError(error, "MCP connection failed");
    }
    const callTimeoutMs = remainingBudget(deadlineAt);
    const callOptions: CallToolRequestOptions = {
      signal: undefined,
      timeout: callTimeoutMs,
      maxTotalTimeout: callTimeoutMs,
      toolDefinition: definition,
    };
    let result: CallToolResult;
    try {
      result = await this.runWithDeadline((signal) => session.callTool({ name: toolName, arguments: arguments_ }, { ...callOptions, signal }), callTimeoutMs, limits.signal);
    } catch (error) {
      // Timeouts also invalidate: a session whose SDK ignored the abort may
      // still hold the orphaned call; the next caller reconnects instead of
      // reusing the wedged transport. invalidateSession never evicts a newer
      // entry installed concurrently.
      if (isSessionTransportFailure(error) || error instanceof McpTimeoutError) this.invalidateSession(entry, session);
      throw sanitizeExternalError(error, "MCP tool call failed");
    }
    if (jsonBytes(result) > limits.maxResultBytes) throw new McpResultLimitError();
    return result;
  }

  async callTool(agentId: string, providerName: string, args: unknown, options?: McpCallOptions): Promise<CallToolResult> {
    return this.callProviderTool(agentId, providerName, args, options);
  }

  private async connectWithSdk(config: McpServerConfig, context: ResolvedConnectorContext): Promise<McpClientSession> {
    const client = new Client({ name: "OpenBot", version: "0.1.0" });
    if (config.transport === "http") {
      const validated = await resolveAndValidateHttpEndpoint(config.url, this.dnsLookup);
      const dispatcher = pinnedHttpDispatcher(validated.url, validated.addresses);
      const safeFetch: FetchLike = async (input, init) => {
        const target = typeof input === "string" ? input : input.toString();
        await resolveAndValidateHttpEndpoint(target, this.dnsLookup);
        // Redirects are fail-closed: a Location is another network target and
        // must not bypass the DNS/SSRF validation above.
        const response = await undiciFetch(input, {
          ...init,
          redirect: "error",
          dispatcher,
        });
        return limitedResponse(response, config.maxResultBytes ?? this.defaultMaxResultBytes);
      };
      const transport = new StreamableHTTPClientTransport(validated.url, {
        ...(context.headers === undefined ? {} : { requestInit: { headers: context.headers } }),
        fetch: safeFetch,
        onInsufficientScope: "throw",
      });
      let resourcesClosed = false;
      const closeResources = async (): Promise<void> => {
        if (resourcesClosed) return;
        resourcesClosed = true;
        await transport.close().catch(() => {});
        await dispatcher.close().catch(() => {});
      };
      const abortHandshake = (): void => { void closeResources(); };
      context.signal?.addEventListener("abort", abortHandshake, { once: true });
      try {
        if (context.signal !== undefined) throwIfAborted(context.signal);
        await client.connect(transport);
        if (context.signal !== undefined) throwIfAborted(context.signal);
      } catch (error) {
        await closeResources();
        await client.close().catch(() => {});
        throw error;
      } finally {
        context.signal?.removeEventListener("abort", abortHandshake);
      }
      return {
        listTools: client.listTools.bind(client),
        callTool: client.callTool.bind(client),
        close: async () => {
          try { await client.close(); } finally {
            await closeResources();
          }
        },
      };
    }
    const validated = context.stdio;
    if (validated === undefined) throw new McpValidationError("MCP stdio launch context is missing");
    // Keep the identities captured before resolving secrets. The executable
    // is snapshotted asynchronously, while the cwd is revalidated
    // synchronously at the launch boundary below.
    const launch = validated;
    if (context.signal !== undefined) throwIfAborted(context.signal);
    const staged = await stageValidatedStdioExecutable(launch);
    let transport: StdioClientTransport;
    try {
      if (context.signal !== undefined) throwIfAborted(context.signal);
      transport = new StdioClientTransport({
        command: staged.command,
        args: launch.args,
        cwd: launch.cwd,
        env: minimalStdioEnvironment(context.env, launch.command),
        stderr: "ignore",
        maxBufferSize: config.maxResultBytes ?? this.defaultMaxResultBytes,
      });
    } catch (error) {
      await staged.cleanup();
      throw error;
    }
    let closePromise: Promise<void> | undefined;
    const closeTransport = async (): Promise<void> => {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async () => {
        await transport.close().catch(() => {});
        await staged.cleanup();
      })();
      return closePromise;
    };
    const abortHandshake = (): void => { void closeTransport(); };
    context.signal?.addEventListener("abort", abortHandshake, { once: true });
    try {
      if (context.signal !== undefined) throwIfAborted(context.signal);
      // This check must remain synchronous and directly adjacent to connect:
      // the SDK's legacy connect path calls transport.start(), whose spawn is
      // synchronous before its first await. No async gap may be introduced.
      assertValidatedStdioCwd(launch);
      await client.connect(transport);
      if (context.signal !== undefined) throwIfAborted(context.signal);
    } catch (error) {
      await closeTransport();
      await client.close().catch(() => {});
      throw error;
    } finally {
      context.signal?.removeEventListener("abort", abortHandshake);
    }
    return {
      listTools: client.listTools.bind(client),
      callTool: client.callTool.bind(client),
      close: async () => {
        try { await client.close(); } finally { await closeTransport(); }
      },
    };
  }

  private async closeSession(session: McpClientSession): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.close().catch(() => {}),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, this.closeTimeoutMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async closeInternal(): Promise<void> {
    const pending = [...this.sessions.values()];
    this.sessions.clear();
    for (const cached of pending) cached.controller.abort(new McpAbortedError());
    for (const cached of this.toolLists.values()) cached.controller.abort(new McpAbortedError());
    this.toolLists.clear();
    this.serverVersions.clear();
    await Promise.all(pending.map(async (value) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const session = await Promise.race<McpClientSession | undefined>([
          value.promise,
          new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), this.closeTimeoutMs); }),
        ]);
        if (session !== undefined) await this.closeSession(session);
      } catch {
        // Shutdown is best-effort and must never expose remote paths or URLs.
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }));
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }
}
