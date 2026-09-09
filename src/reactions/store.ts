/**
 * P2.4 — durable agent/conversation/entry-scoped reactions.
 *
 * A reaction is identified by a stable id and deduplicated by nonce so
 * repeated RPC/retry/reconnect never duplicates it. States: confirmed (added)
 * on success, rejected on a conflicting/identical-but-mismatched attempt, and
 * removed after explicit removal. Foreign agent/conversation access never
 * returns payload or existence. Persistence is authoritative in SQLite; SSE
 * frames are projections.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type ReactionState = "confirmed" | "rejected" | "removed";

export interface Reaction {
  id: string;
  agentId: string;
  conversationId: string | null;
  entryId: string;
  emoji: string;
  nonce: string;
  state: ReactionState;
  reason: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AddReactionInput {
  conversationId?: string;
  entryId: string;
  emoji: string;
  nonce: string;
}

const MAX_EMOJI_BYTES = 32;
const MAX_NONCE_BYTES = 128;
const MAX_REACTIONS_PER_ENTRY = 64;

interface ReactionRow {
  id: string; agent_id: string; conversation_id: string | null; entry_id: string;
  emoji: string; nonce: string; state: ReactionState; reason: string | null;
  created_at_ms: number; updated_at_ms: number;
}

function fromRow(row: ReactionRow): Reaction {
  return {
    id: row.id, agentId: row.agent_id, conversationId: row.conversation_id,
    entryId: row.entry_id, emoji: row.emoji, nonce: row.nonce, state: row.state,
    reason: row.reason, createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms,
  };
}

export type EntryResolveResult = true | false | "temporary";

export class ReactionStore {
  private readonly db: Database.Database;
  private readonly nowFn: () => number;
  /** Optional entry validator: true=persisted ok, false=missing/foreign, 'temporary'='reject'. */
  private readonly resolveEntry: ((agentId: string, entryId: string, conversationId?: string) => EntryResolveResult) | undefined;
  private readonly statements: {
    insert: Database.Statement;
    byNonce: Database.Statement;
    byId: Database.Statement;
    list: Database.Statement;
    listByConversation: Database.Statement;
    setRemoved: Database.Statement;
    delete: Database.Statement;
    purgeAgent: Database.Statement;
  };

  constructor(options: { db: Database.Database; nowFn?: () => number; resolveEntry?: (agentId: string, entryId: string, conversationId?: string) => EntryResolveResult }) {
    this.db = options.db;
    this.nowFn = options.nowFn ?? Date.now;
    this.resolveEntry = options.resolveEntry;
    const s = (sql: string) => this.db.prepare(sql);
    this.statements = {
      insert: s("INSERT INTO reactions (id, agent_id, conversation_id, entry_id, emoji, nonce, state, reason, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', NULL, ?, ?)"),
      byNonce: s("SELECT * FROM reactions WHERE agent_id = ? AND conversation_id IS ? AND entry_id = ? AND emoji = ? AND nonce = ?"),
      byId: s("SELECT * FROM reactions WHERE id = ?"),
      list: s("SELECT * FROM reactions WHERE agent_id = ? AND state != 'removed' ORDER BY created_at_ms ASC, id ASC"),
      listByConversation: s("SELECT * FROM reactions WHERE agent_id = ? AND conversation_id = ? AND state != 'removed' ORDER BY created_at_ms ASC, id ASC"),
      setRemoved: s("UPDATE reactions SET state = 'removed', updated_at_ms = ? WHERE id = ? AND agent_id = ? AND state != 'removed'"),
      delete: s("DELETE FROM reactions WHERE id = ?"),
      purgeAgent: s("DELETE FROM reactions WHERE agent_id = ?"),
    };
  }

  add(agentId: string, input: AddReactionInput): Reaction {
    if (typeof agentId !== "string" || !agentId.trim()) throw new Error("agentId inválido");
    if (typeof input.entryId !== "string" || !input.entryId.trim()) throw new Error("entryId obrigatório");
    if (typeof input.emoji !== "string" || !input.emoji.trim() || Buffer.byteLength(input.emoji, "utf8") > MAX_EMOJI_BYTES) throw new Error("emoji inválido");
    if (typeof input.nonce !== "string" || !input.nonce.trim() || Buffer.byteLength(input.nonce, "utf8") > MAX_NONCE_BYTES) throw new Error("nonce inválido");
    if (input.conversationId !== undefined && (typeof input.conversationId !== "string" || !input.conversationId.trim())) throw new Error("conversationId inválido");
    const conversationId = input.conversationId ?? null;
    if (this.resolveEntry) {
      const resolved = this.resolveEntry(agentId, input.entryId, conversationId ?? undefined);
      if (resolved === "temporary") throw new Error("reaction_conversa_temporaria");
      if (!resolved) throw new Error("reaction_entry_inexistente");
    }
    // Nonce dedupe: the same (agent, conversation, entry, emoji, nonce) is idempotent.
    const current = this.statements.byNonce.get(agentId, conversationId, input.entryId, input.emoji, input.nonce) as ReactionRow | undefined;
    if (current !== undefined) return fromRow(current);
    const count = this.db.prepare("SELECT COUNT(*) AS c FROM reactions WHERE agent_id = ? AND conversation_id IS ? AND entry_id = ? AND state = 'confirmed'").get(agentId, conversationId, input.entryId) as { c: number };
    if (count.c >= MAX_REACTIONS_PER_ENTRY) throw new Error("reaction_limite_excedido");
    const id = "rx-" + randomUUID();
    const now = this.nowFn();
    this.statements.insert.run(id, agentId, conversationId, input.entryId, input.emoji, input.nonce, now, now);
    return fromRow(this.statements.byId.get(id) as ReactionRow);
  }

  list(agentId: string, conversationId?: string): readonly Reaction[] {
    if (typeof agentId !== "string" || !agentId) throw new Error("agentId inválido");
    if (conversationId !== undefined && (typeof conversationId !== "string" || !conversationId)) throw new Error("conversationId inválido");
    const rows = (conversationId === undefined
      ? this.statements.list.all(agentId)
      : this.statements.listByConversation.all(agentId, conversationId)) as ReactionRow[];
    return rows.map(fromRow);
  }

  remove(agentId: string, reactionId: string): boolean {
    if (typeof reactionId !== "string" || !reactionId) return false;
    const row = this.statements.byId.get(reactionId) as ReactionRow | undefined;
    if (row === undefined || row.agent_id !== agentId) return false;
    this.statements.setRemoved.run(this.nowFn(), reactionId, agentId);
    this.statements.delete.run(reactionId);
    return true;
  }

  purgeAgent(agentId: string): number {
    if (typeof agentId !== "string" || !agentId.trim()) throw new Error("agentId inválido");
    return this.statements.purgeAgent.run(agentId).changes;
  }
}