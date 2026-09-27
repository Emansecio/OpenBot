import type { ConfigStore } from "../config/store.js";
import { RpcError } from "../server/gateway.js";

/** The RPC body as a plain object; anything else is a 400. */
export function rpcRecord(body: unknown, method: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RpcError(400, `${method}: corpo deve ser um objeto`);
  return body as Record<string, unknown>;
}

/** A required non-blank string field, trimmed. */
export function rpcRequiredString(body: Record<string, unknown>, name: string, method: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim().length === 0) throw new RpcError(400, `${method}: ${name} é obrigatório`);
  return value.trim();
}

/** The body's `agentId`, which must name a configured agent. */
export function rpcScopedAgent(config: ConfigStore, body: Record<string, unknown>, method: string): string {
  const agentId = rpcRequiredString(body, "agentId", method);
  if (!config.hasAgent(agentId)) throw new RpcError(404, `${method}: agente não encontrado`);
  return agentId;
}

/**
 * Like rpcScopedAgent, but also accepts the legacy native `{id}` alias when
 * `agentId` is absent. Only read-only and legacy native methods use it.
 */
export function rpcScopedAgentOrIdAlias(config: ConfigStore, body: Record<string, unknown>, method: string): string {
  const explicit = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const alias = typeof body.id === "string" ? body.id.trim() : "";
  const agentId = explicit.length > 0 ? explicit : alias;
  if (agentId.length === 0) throw new RpcError(400, `${method}: agentId é obrigatório`);
  if (!config.hasAgent(agentId)) throw new RpcError(404, `${method}: agente não encontrado`);
  return agentId;
}
