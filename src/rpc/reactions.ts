/**
 * P2.4 — reaction RPC: add (nonce-deduped, entry-validated), remove, list.
 * Reactions are the replacement for the inert reactToMessage stub; the SQLite
 * store is authoritative and every mutation emits an ordered SSE projection.
 */
import type { ConfigStore } from "../config/store.js";
import { ReactionStore } from "../reactions/store.js";
import { RpcError, type Gateway } from "../server/gateway.js";

function record(body: unknown, method: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RpcError(400, method + ": corpo deve ser um objeto");
  return body as Record<string, unknown>;
}

function scopedAgent(config: ConfigStore, body: Record<string, unknown>, method: string): string {
  const explicit = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const alias = typeof body.id === "string" ? body.id.trim() : "";
  const agentId = explicit.length > 0 ? explicit : alias.length > 0 ? alias : "";
  if (agentId.length === 0) throw new RpcError(400, method + ": agentId é obrigatório");
  if (!config.snapshot().agents.some((agent) => agent.id === agentId)) throw new RpcError(404, method + ": agente não encontrado");
  return agentId;
}

function reactionError(method: string, message: string): never {
  const status = /inexistente|temporaria|foreign|limite/i.test(message) ? 404 : 400;
  throw new RpcError(status, method + ": " + message);
}

export interface RegisterReactionHandlersOptions {
  store: ReactionStore;
  config?: ConfigStore;
  /** Publisher for the ordered `reactions` SSE projection. */
  publish?: (agentId: string, event: { reaction: unknown; reason: string }) => { accepted: boolean };
}

function serialize(r: { id: string; agentId: string; conversationId: string | null; entryId: string; emoji: string; state: string; createdAtMs: number }) {
  return { id: r.id, agentId: r.agentId, conversationId: r.conversationId, entryId: r.entryId, emoji: r.emoji, state: r.state, createdAtMs: r.createdAtMs };
}

export function registerReactionHandlers(gateway: Gateway, options: RegisterReactionHandlersOptions): void {
  const { store, config, publish } = options;
  const agent = (body: Record<string, unknown>, method: string) => config === undefined ? (typeof body.agentId === "string" && body.agentId.trim() ? body.agentId.trim() : (() => { throw new RpcError(400, method + ": agentId obrigatório"); })()) : scopedAgent(config, body, method);

  gateway.registerHandler("addReaction", (body) => {
    const method = "addReaction";
    const b = record(body, method);
    const agentId = agent(b, method);
    const entryId = b.entryId ?? b.messageId ?? b.replyToId;
    const emoji = b.emoji ?? b.reaction;
    if (typeof entryId !== "string" || !entryId.trim()) throw new RpcError(400, method + ": alvo da entry é obrigatório");
    if (typeof emoji !== "string" || !emoji.trim()) throw new RpcError(400, method + ": emoji é obrigatório");
    const nonce = typeof b.nonce === "string" && b.nonce.trim() ? b.nonce.trim() : "anon-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
    const conversationId = typeof b.conversationId === "string" && b.conversationId.trim() ? b.conversationId.trim() : undefined;
    let added;
    try {
      added = store.add(agentId, { conversationId, entryId: entryId.trim(), emoji: emoji.trim(), nonce });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("reaction_")) reactionError(method, message);
      throw new RpcError(400, method + ": " + message);
    }
    publish?.(agentId, { reaction: serialize(added), reason: "add" });
    return serialize(added);
  });

  // reactToMessage is the legacy native alias for addReaction (replaces the
  // inert stub so the durable reaction surface is reachable from the renderer).
  gateway.registerHandler("reactToMessage", (body) => {
    const b = record(body, "reactToMessage");
    const agentId = agent(b, "reactToMessage");
    const entryId = b.entryId ?? b.messageId ?? b.replyToId;
    const emoji = b.emoji ?? b.reaction;
    if (typeof entryId !== "string" || !entryId.trim()) throw new RpcError(400, "reactToMessage: alvo da entry é obrigatório");
    if (typeof emoji !== "string" || !emoji.trim()) throw new RpcError(400, "reactToMessage: emoji é obrigatório");
    const nonce = typeof b.nonce === "string" && b.nonce.trim() ? b.nonce.trim() : "rv-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
    const conversationId = typeof b.conversationId === "string" && b.conversationId.trim() ? b.conversationId.trim() : undefined;
    let added;
    try { added = store.add(agentId, { conversationId, entryId: entryId.trim(), emoji: emoji.trim(), nonce }); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("reaction_")) reactionError("reactToMessage", message);
      throw new RpcError(400, "reactToMessage: " + message);
    }
    publish?.(agentId, { reaction: serialize(added), reason: "add" });
    return { ok: true };
  });
  gateway.registerHandler("removeReaction", (body) => {
    const method = "removeReaction";
    const b = record(body, method);
    const agentId = agent(b, method);
    const reactionId = typeof b.reactionId === "string" && b.reactionId.trim() ? b.reactionId.trim() : (typeof b.id === "string" ? b.id : "");
    if (!reactionId) throw new RpcError(400, method + ": reactionId é obrigatório");
    const removed = store.remove(agentId, reactionId);
    if (!removed) throw new RpcError(404, method + ": reaction não encontrada");
    publish?.(agentId, { reaction: { id: reactionId, removed: true }, reason: "remove" });
    return { removed: true, reactionId };
  });

  gateway.registerHandler("listReactions", (body) => {
    const method = "listReactions";
    const b = record(body, method);
    const agentId = agent(b, method);
    const conversationId = typeof b.conversationId === "string" && b.conversationId.trim() ? b.conversationId.trim() : undefined;
    return store.list(agentId, conversationId).map(serialize);
  });
}