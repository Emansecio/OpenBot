import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureDefaultConversation, legacyConversationId, migrateOpenBotSchema } from "../store/schema.js";
import { SqliteMemoryStore } from "../memory/sqlite-store.js";

export const DEFAULT_CONVERSATION_TITLE = "Nova conversa";
export const DEFAULT_CONVERSATION_PAGE_LIMIT = 50;
export const MAX_CONVERSATION_PAGE_LIMIT = 200;

export type ConversationTitleSource = "auto" | "manual";
export type ConversationMemoryPolicy = "delete-derived" | "retain";

export interface Conversation {
  id: string;
  agentId: string;
  title: string;
  titleSource: ConversationTitleSource;
  temporary: boolean;
  archivedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  lastMessageAtMs: number | null;
}

export type ConversationRecord = Conversation;
export type AgentConversation = Conversation;

export interface SqliteConversationStoreOptions {
  path: string;
  now?: () => number;
  /** Borrow an already-open SQLite connection; close() then becomes a no-op for the database. */
  database?: Database.Database;
  /** Optional shared memory store used to apply the explicit deletion policy atomically. */
  memoryStore?: SqliteMemoryStore;
  /** Known sensitive values (e.g. keystore-held credentials) the default memory store must reject. */
  secretValues?: () => readonly string[];
}

export interface CreateConversationOptions {
  title?: string;
  temporary?: boolean;
}

export interface ListConversationOptions {
  limit?: number;
  cursor?: string;
}

export interface ConversationPage {
  items: Conversation[];
  nextCursor?: string;
}

export interface DeleteConversationResult {
  conversationId: string;
  memoryPolicy: ConversationMemoryPolicy;
}

export interface ConversationSnapshot {
  conversations: Conversation[];
  activeConversationId: string | null;
}

type ConversationRow = {
  id: string;
  agent_id: string;
  title: string;
  title_source: ConversationTitleSource;
  temporary: number;
  archived_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  last_message_at_ms: number | null;
};

type CursorData = {
  version: 1;
  agentId: string;
  updatedAtMs: number;
  id: string;
};

function validateAgentId(agentId: string): void {
  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    throw new Error("agentId deve ser uma string não vazia");
  }
}

function validateConversationId(conversationId: string): void {
  if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
    throw new Error("conversationId deve ser uma string não vazia");
  }
}

function validateTitle(title: string): string {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error("title deve ser uma string não vazia");
  }
  return title.trim();
}

function validatePageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONVERSATION_PAGE_LIMIT) {
    throw new Error(`limit deve ser um inteiro entre 1 e ${MAX_CONVERSATION_PAGE_LIMIT}`);
  }
  return limit;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    agentId: row.agent_id,
    title: row.title,
    titleSource: row.title_source,
    temporary: row.temporary === 1,
    archivedAtMs: row.archived_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    lastMessageAtMs: row.last_message_at_ms,
  };
}

function encodeCursor(data: CursorData): string {
  return `v1:${Buffer.from(JSON.stringify(data), "utf8").toString("base64url")}`;
}

function decodeCursor(agentId: string, cursor: string): CursorData {
  const match = /^v1:([A-Za-z0-9_-]+)$/.exec(cursor);
  if (match === null) throw new Error("cursor inválido");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"));
  } catch {
    throw new Error("cursor inválido");
  }
  const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
  if (
    record === undefined ||
    record.version !== 1 ||
    record.agentId !== agentId ||
    typeof record.updatedAtMs !== "number" ||
    !Number.isSafeInteger(record.updatedAtMs) ||
    typeof record.id !== "string" ||
    record.id.length === 0
  ) {
    throw new Error("cursor inválido para o agente");
  }
  return parsed as CursorData;
}

function isMemoryPolicy(value: string): value is ConversationMemoryPolicy {
  return value === "delete-derived" || value === "retain";
}

function isAutoPlaceholderTitle(title: string): boolean {
  const normalized = title.trim().toLocaleLowerCase();
  return normalized === DEFAULT_CONVERSATION_TITLE.toLocaleLowerCase()
    || normalized === "new conversation"
    || normalized === "new chat";
}

export class SqliteConversationStore {
  private readonly db: Database.Database;
  private readonly ownsDatabase: boolean;
  readonly path: string;
  private readonly nowFn: () => number;
  private readonly memoryStore: SqliteMemoryStore;
  private closed = false;

  constructor(opts: SqliteConversationStoreOptions) {
    if (typeof opts.path !== "string" || opts.path.length === 0) {
      throw new Error("conversation store: path é obrigatório");
    }
    if (opts.path !== ":memory:") {
      fs.mkdirSync(path.dirname(opts.path), { recursive: true });
    }
    this.path = opts.path;
    this.nowFn = opts.now ?? Date.now;
    let database: Database.Database | undefined = opts.database;
    this.ownsDatabase = opts.database === undefined;
    try {
      database ??= new Database(opts.path);
      this.db = database;
      this.db.pragma("foreign_keys = ON");
      if (this.ownsDatabase) {
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
        this.db.pragma("busy_timeout = 5000");
      }
      migrateOpenBotSchema(this.db);
      const memoryStore = opts.memoryStore ?? new SqliteMemoryStore({ path: opts.path, database: this.db, secretValues: opts.secretValues });
      if (!memoryStore.sharesDatabase(this.db)) {
        throw new Error("conversation store: memoryStore deve usar a mesma conexão SQLite");
      }
      this.memoryStore = memoryStore;
    } catch (error) {
      if (this.ownsDatabase) database?.close();
      throw error;
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("conversation store: conexão fechada");
  }

  sharesDatabase(database: Database.Database): boolean {
    return this.db === database;
  }

  private now(): number {
    const value = this.nowFn();
    if (!Number.isFinite(value)) throw new Error("conversation store: relógio inválido");
    return Math.trunc(value);
  }

  private readOwned(agentId: string, conversationId: string): ConversationRow {
    const row = this.db.prepare(`
      SELECT id, agent_id, title, title_source, temporary, archived_at_ms, created_at_ms, updated_at_ms, last_message_at_ms
      FROM agent_conversations
      WHERE agent_id = ? AND id = ?
    `).get(agentId, conversationId) as ConversationRow | undefined;
    if (row === undefined) throw new Error("conversation não encontrada para o agente");
    return row;
  }

  private readById(id: string): ConversationRow {
    const row = this.db.prepare(`
      SELECT id, agent_id, title, title_source, temporary, archived_at_ms, created_at_ms, updated_at_ms, last_message_at_ms
      FROM agent_conversations WHERE id = ?
    `).get(id) as ConversationRow | undefined;
    if (row === undefined) throw new Error("conversation não encontrada");
    return row;
  }

  private upsertActive(agentId: string, conversationId: string): void {
    this.db.prepare(`
      INSERT INTO agent_conversation_state(agent_id, active_conversation_id)
      VALUES (?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET active_conversation_id = excluded.active_conversation_id
    `).run(agentId, conversationId);
  }

  ensureDefault(agentId: string): Conversation {
    validateAgentId(agentId);
    this.ensureOpen();
    const id = ensureDefaultConversation(this.db, agentId, this.now());
    return toConversation(this.readOwned(agentId, id));
  }

  create(agentId: string, options: CreateConversationOptions = {}): Conversation {
    validateAgentId(agentId);
    this.ensureOpen();
    if (options.title !== undefined) validateTitle(options.title);
    if (options.temporary !== undefined && typeof options.temporary !== "boolean") {
      throw new Error("temporary deve ser boolean");
    }
    const title = options.title === undefined ? DEFAULT_CONVERSATION_TITLE : options.title.trim();
    const titleSource: ConversationTitleSource = options.title === undefined ? "auto" : "manual";
    const temporary = options.temporary === true ? 1 : 0;
    const now = this.now();
    const id = randomUUID();
    const create = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO agent_conversations
          (id, agent_id, title, title_source, temporary, archived_at_ms, created_at_ms, updated_at_ms, last_message_at_ms)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)
      `).run(id, agentId, title, titleSource, temporary, now, now);
      this.upsertActive(agentId, id);
    });
    create();
    return toConversation(this.readOwned(agentId, id));
  }

  getActive(agentId: string): Conversation | null {
    validateAgentId(agentId);
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT c.id, c.agent_id, c.title, c.title_source, c.temporary, c.archived_at_ms, c.created_at_ms, c.updated_at_ms, c.last_message_at_ms
      FROM agent_conversation_state AS s
      JOIN agent_conversations AS c ON c.id = s.active_conversation_id AND c.agent_id = s.agent_id
      WHERE s.agent_id = ? AND c.archived_at_ms IS NULL
    `).get(agentId) as ConversationRow | undefined;
    if (row !== undefined) return toConversation(row);
    const state = this.db.prepare("SELECT 1 AS present FROM agent_conversation_state WHERE agent_id = ?").get(agentId) as { present?: number } | undefined;
    if (state?.present !== 1) return null;
    const repairedId = ensureDefaultConversation(this.db, agentId, this.now());
    return toConversation(this.readOwned(agentId, repairedId));
  }

  get(agentId: string, conversationId: string): Conversation | null {
    validateAgentId(agentId);
    validateConversationId(conversationId);
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT id, agent_id, title, title_source, temporary, archived_at_ms, created_at_ms, updated_at_ms, last_message_at_ms
      FROM agent_conversations
      WHERE agent_id = ? AND id = ?
    `).get(agentId, conversationId) as ConversationRow | undefined;
    return row === undefined ? null : toConversation(row);
  }

  list(agentId: string, options: ListConversationOptions = {}): ConversationPage {
    validateAgentId(agentId);
    this.ensureOpen();
    const limit = validatePageLimit(options.limit ?? DEFAULT_CONVERSATION_PAGE_LIMIT);
    const cursor = options.cursor === undefined ? undefined : decodeCursor(agentId, options.cursor);
    const rows = cursor === undefined
      ? this.db.prepare(`
          SELECT id, agent_id, title, title_source, temporary, archived_at_ms, created_at_ms, updated_at_ms, last_message_at_ms
          FROM agent_conversations
          WHERE agent_id = ?
          ORDER BY updated_at_ms DESC, id DESC
          LIMIT ?
        `).all(agentId, limit + 1) as ConversationRow[]
      : this.db.prepare(`
          SELECT id, agent_id, title, title_source, temporary, archived_at_ms, created_at_ms, updated_at_ms, last_message_at_ms
          FROM agent_conversations
          WHERE agent_id = ?
            AND (updated_at_ms < ? OR (updated_at_ms = ? AND id < ?))
          ORDER BY updated_at_ms DESC, id DESC
          LIMIT ?
        `).all(agentId, cursor.updatedAtMs, cursor.updatedAtMs, cursor.id, limit + 1) as ConversationRow[];
    const hasNext = rows.length > limit;
    const selected = hasNext ? rows.slice(0, limit) : rows;
    const page: ConversationPage = { items: selected.map(toConversation) };
    if (hasNext) {
      const last = selected.at(-1);
      if (last !== undefined) page.nextCursor = encodeCursor({ version: 1, agentId, updatedAtMs: last.updated_at_ms, id: last.id });
    }
    return page;
  }

  activate(agentId: string, conversationId: string): Conversation {
    validateAgentId(agentId);
    validateConversationId(conversationId);
    this.ensureOpen();
    const activate = this.db.transaction(() => {
      const row = this.readOwned(agentId, conversationId);
      if (row.archived_at_ms !== null) throw new Error("não é possível ativar conversa arquivada");
      this.upsertActive(agentId, row.id);
    });
    activate();
    return toConversation(this.readOwned(agentId, conversationId));
  }

  rename(agentId: string, conversationId: string, title: string): Conversation {
    validateAgentId(agentId);
    validateConversationId(conversationId);
    const normalizedTitle = validateTitle(title);
    this.ensureOpen();
    const now = this.now();
    const rename = this.db.transaction(() => {
      this.readOwned(agentId, conversationId);
      this.db.prepare(`
        UPDATE agent_conversations
        SET title = ?, title_source = 'manual', updated_at_ms = ?
        WHERE agent_id = ? AND id = ?
      `).run(normalizedTitle, now, agentId, conversationId);
    });
    rename();
    return toConversation(this.readOwned(agentId, conversationId));
  }

  updateAutoTitle(agentId: string, conversationId: string, firstUserText: string): Conversation {
    validateAgentId(agentId);
    validateConversationId(conversationId);
    this.ensureOpen();
    const text = typeof firstUserText === "string" ? firstUserText.trim() : "";
    const update = this.db.transaction(() => {
      const row = this.readOwned(agentId, conversationId);
      if (row.title_source === "manual" || text.length === 0 || !isAutoPlaceholderTitle(row.title)) return;
      this.db.prepare(`
        UPDATE agent_conversations
        SET title = ?, title_source = 'auto', updated_at_ms = ?
        WHERE agent_id = ? AND id = ? AND title_source = 'auto' AND title = ?
      `).run(text, this.now(), agentId, conversationId, row.title);
    });
    update();
    return toConversation(this.readOwned(agentId, conversationId));
  }

  archive(agentId: string, conversationId: string): Conversation {
    validateAgentId(agentId);
    validateConversationId(conversationId);
    this.ensureOpen();
    const archive = this.db.transaction(() => {
      const row = this.readOwned(agentId, conversationId);
      if (row.archived_at_ms !== null) return;
      const activeCount = this.db.prepare(`
        SELECT COUNT(*) AS count FROM agent_conversations
        WHERE agent_id = ? AND archived_at_ms IS NULL
      `).get(agentId) as { count: number };
      if (activeCount.count <= 1) throw new Error("não é possível arquivar a única conversa restante");
      const now = this.now();
      this.db.prepare("UPDATE agent_conversations SET archived_at_ms = ?, updated_at_ms = ? WHERE agent_id = ? AND id = ?")
        .run(now, now, agentId, conversationId);
      this.memoryStore.cancelConversationJobs(agentId, conversationId, { code: "conversation_archived", text: "conversation archived" }, now);
      const state = this.db.prepare("SELECT active_conversation_id FROM agent_conversation_state WHERE agent_id = ?").get(agentId) as { active_conversation_id: string } | undefined;
      if (state?.active_conversation_id !== conversationId) return;
      const next = this.db.prepare(`
        SELECT id FROM agent_conversations
        WHERE agent_id = ? AND archived_at_ms IS NULL AND id <> ?
        ORDER BY updated_at_ms DESC, id DESC LIMIT 1
      `).get(agentId, conversationId) as { id: string } | undefined;
      if (next !== undefined) this.upsertActive(agentId, next.id);
    });
    archive();
    return toConversation(this.readOwned(agentId, conversationId));
  }

  delete(agentId: string, conversationId: string, options: { memoryPolicy: ConversationMemoryPolicy }): DeleteConversationResult {
    validateAgentId(agentId);
    validateConversationId(conversationId);
    if (typeof options !== "object" || options === null || !isMemoryPolicy(options.memoryPolicy)) {
      throw new Error("memoryPolicy inválido");
    }
    this.ensureOpen();
    const policy = options.memoryPolicy;
    const remove = this.db.transaction(() => {
      const target = this.readOwned(agentId, conversationId);
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM agent_conversations WHERE agent_id = ?").get(agentId) as { count: number };
      if (count.count <= 1) throw new Error("não é possível deletar a única conversa restante");
      const liveCount = this.db.prepare(`
        SELECT COUNT(*) AS count FROM agent_conversations
        WHERE agent_id = ? AND archived_at_ms IS NULL
      `).get(agentId) as { count: number };
      if (target.archived_at_ms === null && liveCount.count <= 1) {
        throw new Error("não é possível deletar a última conversa não arquivada");
      }
      const activeLive = this.db.prepare(`
        SELECT c.id
        FROM agent_conversation_state AS s
        JOIN agent_conversations AS c ON c.id = s.active_conversation_id AND c.agent_id = s.agent_id
        WHERE s.agent_id = ? AND c.archived_at_ms IS NULL
      `).get(agentId) as { id: string } | undefined;
      if (activeLive === undefined || activeLive.id === conversationId) {
        const next = this.db.prepare(`
          SELECT id FROM agent_conversations
          WHERE agent_id = ? AND id <> ? AND archived_at_ms IS NULL
          ORDER BY updated_at_ms DESC, id DESC LIMIT 1
        `).get(agentId, conversationId) as { id: string } | undefined;
        if (next !== undefined) {
          this.upsertActive(agentId, next.id);
        } else {
          let defaultId = legacyConversationId(agentId);
          const collision = this.db.prepare("SELECT 1 AS present FROM agent_conversations WHERE id = ?").get(defaultId) as { present?: number } | undefined;
          if (collision?.present === 1) defaultId = randomUUID();
          const now = this.now();
          this.db.prepare(`
            INSERT INTO agent_conversations
              (id, agent_id, title, title_source, temporary, archived_at_ms, created_at_ms, updated_at_ms, last_message_at_ms)
            VALUES (?, ?, ?, 'auto', 0, NULL, ?, ?, NULL)
          `).run(defaultId, agentId, DEFAULT_CONVERSATION_TITLE, now, now);
          this.upsertActive(agentId, defaultId);
        }
      }
      this.memoryStore.deleteConversationDerived(agentId, conversationId, policy);
      for (const table of [
        "prompt_queue",
        "transcript_entries",
        "accepted_nonces",
        "pending_nonces",
        "interaction_decisions",
        "turn_attempts",
        "turn_completions",
        "turn_checkpoints",
        "turn_effects",
        "kickstart_runs",
      ] as const) {
        this.db.prepare(`DELETE FROM ${table} WHERE agent_id = ? AND conversation_id = ?`).run(agentId, conversationId);
      }
      this.db.prepare("DELETE FROM agent_conversations WHERE agent_id = ? AND id = ?").run(agentId, conversationId);
    });
    remove();
    return { conversationId, memoryPolicy: policy };
  }

  snapshotAgent(agentId: string): ConversationSnapshot {
    validateAgentId(agentId);
    this.ensureOpen();
    const conversations = this.db.prepare(`
      SELECT id, agent_id, title, title_source, temporary, archived_at_ms, created_at_ms, updated_at_ms, last_message_at_ms
      FROM agent_conversations WHERE agent_id = ? ORDER BY updated_at_ms DESC, id DESC
    `).all(agentId) as ConversationRow[];
    const active = this.db.prepare("SELECT active_conversation_id FROM agent_conversation_state WHERE agent_id = ?").get(agentId) as { active_conversation_id: string } | undefined;
    return {
      conversations: conversations.map(toConversation),
      activeConversationId: active?.active_conversation_id ?? null,
    };
  }

  restoreAgent(agentId: string, snapshot: ConversationSnapshot): void {
    validateAgentId(agentId);
    this.ensureOpen();
    if (!snapshot || !Array.isArray(snapshot.conversations)) throw new Error("snapshot de conversas inválido");
    const activeId = snapshot.activeConversationId;
    if (activeId !== null && (!snapshot.conversations.some((conversation) => conversation.id === activeId && conversation.agentId === agentId))) {
      throw new Error("snapshot aponta para conversa ativa inválida");
    }
    const restore = this.db.transaction(() => {
      this.db.prepare("DELETE FROM agent_conversation_state WHERE agent_id = ?").run(agentId);
      this.db.prepare("DELETE FROM agent_conversations WHERE agent_id = ?").run(agentId);
      for (const conversation of snapshot.conversations) {
        if (conversation.agentId !== agentId) throw new Error("snapshot contém conversa de outro agente");
        this.db.prepare(`
          INSERT INTO agent_conversations
            (id, agent_id, title, title_source, temporary, archived_at_ms, created_at_ms, updated_at_ms, last_message_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          conversation.id,
          agentId,
          conversation.title,
          conversation.titleSource,
          conversation.temporary ? 1 : 0,
          conversation.archivedAtMs,
          conversation.createdAtMs,
          conversation.updatedAtMs,
          conversation.lastMessageAtMs,
        );
      }
      if (activeId !== null) this.upsertActive(agentId, activeId);
    });
    restore();
  }

  clear(agentId: string): void {
    validateAgentId(agentId);
    this.ensureOpen();
    const clear = this.db.transaction(() => {
      this.db.prepare("DELETE FROM agent_conversation_state WHERE agent_id = ?").run(agentId);
      for (const table of ["transcript_entries", "accepted_nonces", "pending_nonces", "interaction_decisions", "turn_attempts", "turn_completions"] as const) {
        this.db.prepare(`DELETE FROM ${table} WHERE agent_id = ?`).run(agentId);
      }
      this.db.prepare("DELETE FROM agent_conversations WHERE agent_id = ?").run(agentId);
    });
    clear();
  }

  close(): void {
    if (this.closed) return;
    if (this.ownsDatabase) this.db.close();
    this.closed = true;
  }
}

export function defaultConversationStorePath(): string {
  const explicitRoot = process.env.OPENBOT_DATA_ROOT?.trim();
  if (explicitRoot) return path.join(explicitRoot, "store.db");
  const appData = process.env.APPDATA;
  if (appData && appData.length > 0) return path.join(appData, "OpenBot", "store.db");
  return path.join(os.homedir(), "AppData", "Roaming", "OpenBot", "store.db");
}
