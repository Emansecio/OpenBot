import { createHash } from "node:crypto";
import type { Keystore } from "../keystore/index.js";
import { McpManager } from "../mcp/manager.js";
import type {
  McpAgentPolicy,
  McpProviderTool,
  McpServerConfig,
} from "../mcp/contracts.js";
import type { ConfigStore, LocalAgent, OpenBotConfig } from "../config/store.js";
import { ConfigConflictError, resolveAgentMcpPolicy } from "../config/store.js";
import type { Gateway, RpcHandler } from "../server/gateway.js";
import { RpcError } from "../server/gateway.js";

/** Exported for focused tests and small gateway adapters. */
export type McpRpcHandler = RpcHandler;

/**
 * The RPC adapter deliberately receives the shared manager and config rather
 * than constructing either one.  The process owns one manager; bots only get
 * a policy projection of that shared state.
 */
export interface McpRpcOptions {
  mcpManager?: McpManager;
  config?: ConfigStore;
  /** Secret values are accepted only when the host explicitly injects a keystore. */
  keystore?: Pick<Keystore, "upsert">;
}

export interface McpServerRpcView {
  id: string;
  transport: "http" | "stdio";
  sessionScope: "shared" | "agent";
  status: "configured" | "disabled" | "available" | "error";
  host?: string;
  path?: string;
  command?: string;
  toolCount?: number;
  error?: "unavailable";
}

export interface McpToolRpcView {
  name: string;
  serverId: string;
  toolName: string;
  description?: string;
}

const SAFE_SECRET_REF = /^mcp\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_DESCRIPTION_BYTES = 2_048;

function recordBody(body: unknown, allowMissing = false): Record<string, unknown> {
  if (body === undefined && allowMissing) return {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RpcError(400, "MCP: corpo deve ser um objeto");
  }
  return body as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new RpcError(400, `MCP: ${field} inválido`);
  }
  return value.trim();
}

function agentIdFrom(body: unknown, required = true): string | undefined {
  const record = recordBody(body, !required);
  const value = record.agentId ?? record.id;
  if (value === undefined && !required) return undefined;
  return requiredString(value, "agentId");
}

function safeFailure(error: unknown, status: number, message: string): RpcError {
  if (error instanceof RpcError) return error;
  // MCP servers are untrusted. Never forward their error text, paths, args,
  // headers or secret references through the management RPC.
  return new RpcError(status, message);
}

function truncateUtf8(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_DESCRIPTION_BYTES) return value;
  let end = MAX_DESCRIPTION_BYTES - 3;
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}...`;
}

function publicServer(config: McpServerConfig, status: McpServerRpcView["status"], extras: Partial<McpServerRpcView> = {}): McpServerRpcView {
  if (config.transport === "stdio") {
    return { id: config.id, transport: "stdio", command: config.command, sessionScope: config.sessionScope ?? "shared", status, ...extras };
  }
  let host = "";
  let path = "/";
  try {
    const url = new URL(config.url);
    host = url.host;
    path = url.pathname || "/";
  } catch {
    // ConfigStore validates URLs. Keep the RPC fail-closed if an injected
    // config bypasses that store instead of returning the original URL.
  }
  return { id: config.id, transport: "http", host, path, sessionScope: config.sessionScope ?? "shared", status, ...extras };
}

function serverList(config: OpenBotConfig | undefined): McpServerConfig[] {
  return [...(config?.mcpServers ?? [])];
}

function configuredAgent(config: OpenBotConfig | undefined, agentId: string): LocalAgent | undefined {
  return config?.agents.find((agent) => agent.id === agentId);
}

function policyFor(
  config: OpenBotConfig | undefined,
  manager: McpManager | undefined,
  agentId: string,
): McpAgentPolicy {
  if (config !== undefined) return resolveAgentMcpPolicy(config, agentId);
  return manager?.getAgentPolicy(agentId) ?? { enabled: false, serverAllowlist: [] };
}

function serverAllowed(policy: McpAgentPolicy, serverId: string): boolean {
  return policy.enabled && (policy.serverAllowlist?.some((id) => id.toLowerCase() === serverId.toLowerCase()) ?? false);
}

function toolsForServer(tools: readonly McpProviderTool[], serverId: string): number {
  return tools.reduce((count, tool) => count + (tool.serverId.toLowerCase() === serverId.toLowerCase() ? 1 : 0), 0);
}

function publicTool(tool: McpProviderTool): McpToolRpcView {
  return {
    name: tool.function.name,
    serverId: tool.serverId,
    toolName: tool.toolName,
    ...(tool.function.description === undefined ? {} : { description: truncateUtf8(tool.function.description) }),
  };
}

function toMcpSecretStorageKey(secretRef: string): string {
  // The digest avoids alias collisions while keeping the provider-shaped
  // keystore namespace. The clear reference remains only in config.
  return `mcp-${createHash("sha256").update(secretRef, "utf8").digest("hex").slice(0, 48)}`;
}

function managerSyncPolicy(
  manager: McpManager | undefined,
  config: OpenBotConfig | undefined,
  agentId: string,
): void {
  if (!manager) return;
  try {
    manager.setAgentPolicy(agentId, policyFor(config, manager, agentId));
  } catch (error) {
    throw safeFailure(error, 400, "MCP: política inválida");
  }
}

export function registerMcpHandlers(gateway: Gateway, options: McpRpcOptions = {}): void {
  const { mcpManager, config, keystore } = options;
  const snapshot = (): OpenBotConfig | undefined => config?.snapshot();
  const requireAgent = (agentId: string, current = snapshot()): OpenBotConfig | undefined => {
    if (current !== undefined && configuredAgent(current, agentId) === undefined) {
      throw new RpcError(404, "MCP: agente não encontrado");
    }
    return current;
  };

  const listMcpServers: McpRpcHandler = async (body) => {
    const record = recordBody(body, true);
    const agentId = agentIdFrom(record, false);
    const current = agentId === undefined ? snapshot() : requireAgent(agentId, snapshot());
    if (agentId !== undefined) managerSyncPolicy(mcpManager, current, agentId);
    const servers = serverList(current);
    const shouldProbe = record.includeTools === true || record.probe === true || record.check === true;
    if (!shouldProbe || agentId === undefined || mcpManager === undefined) {
      const policy = agentId === undefined ? undefined : policyFor(current, mcpManager, agentId);
      return servers.map((server) => {
        if (policy !== undefined && !serverAllowed(policy, server.id)) return publicServer(server, "disabled");
        return publicServer(server, "configured");
      });
    }

    const policy = policyFor(current, mcpManager, agentId);
    const enabled = servers.filter((server) => serverAllowed(policy, server.id));
    if (enabled.length === 0) return servers.map((server) => publicServer(server, "disabled"));
    const probed = new Map<string, { status: "available" | "error"; toolCount?: number }>();
    for (const server of enabled) {
      try {
        const tools = await mcpManager.listProviderToolsForServer(agentId, server.id);
        probed.set(server.id.toLowerCase(), { status: "available", toolCount: toolsForServer(tools, server.id) });
      } catch {
        // Probe each server independently: one dead connector must not turn
        // healthy servers into false negatives in the chat/settings surface.
        probed.set(server.id.toLowerCase(), { status: "error" });
      }
    }
    return servers.map((server) => {
      if (!serverAllowed(policy, server.id)) return publicServer(server, "disabled");
      const result = probed.get(server.id.toLowerCase());
      return result?.status === "available"
        ? publicServer(server, "available", { toolCount: result.toolCount ?? 0 })
        : publicServer(server, "error", { error: "unavailable" });
    });
  };

  const listMcpTools: McpRpcHandler = async (body) => {
    const agentId = agentIdFrom(body);
    const current = requireAgent(agentId!);
    managerSyncPolicy(mcpManager, current, agentId!);
    if (mcpManager === undefined) return [];
    try {
      const tools = await mcpManager.listProviderTools(agentId!);
      return tools.map(publicTool);
    } catch (error) {
      throw safeFailure(error, 503, "MCP: ferramentas indisponíveis");
    }
  };

  const refreshMcp: McpRpcHandler = async (body, ctx) => {
    const agentId = agentIdFrom(body, false);
    const current = snapshot();
    if (current === undefined) return [];
    if (agentId !== undefined) {
      requireAgent(agentId, current);
      managerSyncPolicy(mcpManager, current, agentId);
    } else {
      for (const agent of current.agents) managerSyncPolicy(mcpManager, current, agent.id);
    }
    return listMcpServers({ ...(agentId === undefined ? {} : { agentId }) }, ctx);
  };

  const setAgentIntegrationPolicy: McpRpcHandler = (body) => {
    const record = recordBody(body);
    const agentId = requiredString(record.agentId, "agentId");
    const policyValue = record.policy ?? record.mcp;
    if (typeof policyValue !== "object" || policyValue === null || Array.isArray(policyValue)) {
      throw new RpcError(400, "MCP: policy deve ser um objeto");
    }
    if (!config) throw new RpcError(503, "MCP: configuração indisponível");
    let next: OpenBotConfig;
    try {
      next = config.mutate((current) => {
        if (configuredAgent(current as OpenBotConfig, agentId) === undefined) throw new RpcError(404, "MCP: agente não encontrado");
        return {
          agents: current.agents.map((agent) => agent.id === agentId
            ? { ...agent, integrations: { ...agent.integrations, mcp: structuredClone(policyValue) as McpAgentPolicy } }
            : agent),
        };
      });
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError(400, "MCP: política inválida");
    }
    managerSyncPolicy(mcpManager, next, agentId);
    return { agentId, mcp: next.agents.find((agent) => agent.id === agentId)?.integrations?.mcp };
  };

  const upsertMcpServer: McpRpcHandler = async (body) => {
    const record = recordBody(body);
    const rawServer = record.server ?? record;
    if (typeof rawServer !== "object" || rawServer === null || Array.isArray(rawServer)) {
      throw new RpcError(400, "MCP: servidor inválido");
    }
    if (!config) throw new RpcError(503, "MCP: configuração indisponível");
    const serverId = requiredString((rawServer as Record<string, unknown>).id, "server.id");
    let previousConfigServer: McpServerConfig | undefined;
    let after: OpenBotConfig;
    try {
      if (mcpManager) mcpManager.validateServer(rawServer as McpServerConfig);
      after = config.mutate((current) => {
        const nextServers = [...serverList(current as OpenBotConfig)];
        const index = nextServers.findIndex((server) => server.id.toLowerCase() === serverId.toLowerCase());
        previousConfigServer = index === -1 ? undefined : nextServers[index];
        if (index === -1) nextServers.push(rawServer as McpServerConfig);
        else nextServers[index] = rawServer as McpServerConfig;
        return { mcpServers: nextServers };
      });
    } catch {
      throw new RpcError(400, "MCP: configuração de servidor inválida");
    }
    const server = serverList(after).find((entry) => entry.id.toLowerCase() === serverId.toLowerCase())!;
    const previousManagerServer = mcpManager?.getServer(server.id);
    try {
      if (mcpManager) {
        // ConfigStore normalizes the raw input. Validate that normalized
        // value before replacing the live manager entry as well.
        mcpManager.validateServer(server);
        mcpManager.replaceServer(server);
      }
    } catch {
      let configRolledBack = false;
      try {
        config.mutate((current) => {
          const servers = serverList(current as OpenBotConfig).filter((entry) => entry.id.toLowerCase() !== server.id.toLowerCase());
          if (previousConfigServer !== undefined) servers.push(previousConfigServer);
          return { mcpServers: servers };
        }, { expectedRevision: after.revision ?? 0 });
        configRolledBack = true;
      } catch (error) {
        if (!(error instanceof ConfigConflictError)) { /* reconciliation will reload manager state */ }
      }
      if (configRolledBack) {
        try {
          if (mcpManager) {
            if (previousManagerServer === undefined) mcpManager.removeServer(server.id);
            else mcpManager.replaceServer(previousManagerServer);
          }
        } catch { /* best effort rollback */ }
      }
      throw new RpcError(400, "MCP: servidor não pôde ser ativado");
    }
    const view = publicServer(server, "configured");
    gateway.publish("mcp-servers", { type: "upserted", server: view });
    return view;
  };

  const removeMcpServer: McpRpcHandler = (body) => {
    const record = recordBody(body);
    const id = requiredString(record.id ?? record.serverId, "serverId");
    if (!config) throw new RpcError(503, "MCP: configuração indisponível");
    let removedServer: McpServerConfig | undefined;
    let after: OpenBotConfig | undefined;
    try {
      after = config.mutate((current) => {
        const servers = serverList(current as OpenBotConfig);
        removedServer = servers.find((server) => server.id.toLowerCase() === id.toLowerCase());
        if (removedServer === undefined) throw new RpcError(404, "MCP: servidor não encontrado");
        return { mcpServers: servers.filter((server) => server.id.toLowerCase() !== id.toLowerCase()) };
      });
      mcpManager?.removeServer(id);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (removedServer !== undefined && after !== undefined) {
        try {
          config.mutate((current) => ({
            mcpServers: [...serverList(current as OpenBotConfig), removedServer!],
          }), { expectedRevision: after.revision ?? 0 });
        } catch { /* keep newer config; startup/refresh resynchronizes manager */ }
      }
      throw new RpcError(400, "MCP: servidor não pôde ser removido");
    }
    gateway.publish("mcp-servers", { type: "removed", id });
    return { removed: true, id };
  };

  const setMcpSecret: McpRpcHandler = async (body) => {
    const record = recordBody(body);
    const secretRef = requiredString(record.secretRef, "secretRef");
    if (!SAFE_SECRET_REF.test(secretRef)) throw new RpcError(400, "MCP: secretRef inválido");
    const value = record.value;
    if (typeof value !== "string" || value.length === 0 || value.length > 8_192 || value.includes("\0")) {
      throw new RpcError(400, "MCP: valor de segredo inválido");
    }
    if (!keystore) throw new RpcError(503, "MCP: keystore indisponível");
    try {
      await keystore.upsert(toMcpSecretStorageKey(secretRef), value);
      mcpManager?.invalidateSecret(secretRef);
    } catch {
      throw new RpcError(400, "MCP: segredo não pôde ser armazenado");
    }
    return { stored: true, secretRef };
  };

  gateway.registerHandler("listMcpServers", listMcpServers);
  gateway.registerHandler("listMcpTools", listMcpTools);
  gateway.registerHandler("refreshMcp", refreshMcp);
  gateway.registerHandler("setAgentIntegrationPolicy", setAgentIntegrationPolicy);
  gateway.registerHandler("upsertMcpServer", upsertMcpServer);
  gateway.registerHandler("removeMcpServer", removeMcpServer);
  gateway.registerHandler("setMcpSecret", setMcpSecret);
}

export { SAFE_SECRET_REF, toMcpSecretStorageKey };
