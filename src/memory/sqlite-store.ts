import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { REASONING_EFFORTS } from "../shared/contracts.js";

import { migrateOpenBotSchema, rebuildOpenBotFts } from "../store/schema.js";
import {
  assertNoMemoryInstructionContent,
  assertNoSensitiveMemoryContent,
  MEMORY_POLICY_LIMITS,
  validateMemoryCandidate,
  type MemoryPolicyOptions,
} from "./policy.js";
import type {
  ConversationSummary,
  ConversationSummaryInput,
  HistorySearchOptions,
  HistorySearchResult,
  TranscriptSearchOptions,
  TranscriptSearchPage,
  Memory,
  MemoryContextSource,
  MemoryAgentSnapshot,
  MemoryDeletePolicy,
  MemoryJob,
  MemoryJobError,
  MemoryJobInput,
  MemoryJobRetryPolicy,
  MemoryJobStatus,
  MemoryKind,
  MemoryListOptions,
  MemoryPage,
  MemoryPageOptions,
  MemoryMode,
  MemoryMutationAuthority,
  MemoryRevision,
  MemorySearchOptions,
  MemorySearchResult,
  MemorySettings,
  MemoryStatusCounts,
  MemorySourceEntry,
  MemorySourceRef,
  MemoryStatus,
  MemoryStore,
  MemoryTrust,
  MemoryUpsertInput,
  SqliteMemoryStoreOptions,
} from "./types.js";
import { memoryContextSources, USER_PROFILE_AGENT_ID, USER_PROFILE_KINDS } from "./types.js";

type MemoryRow = {
  id: string;
  agent_id: string;
  kind: string;
  canonical_key: string;
  text: string;
  value_json: string | null;
  trust: string;
  status: string;
  importance: number;
  confidence: number;
  pinned: number;
  source_conversation_id: string | null;
  source_entry_ids_json: string;
  valid_from_ms: number;
  valid_to_ms: number | null;
  expires_at_ms: number | null;
  superseded_by: string | null;
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
};

type SummaryRow = {
  conversation_id: string;
  agent_id: string;
  revision: number;
  through_sequence_id: number;
  summary_json: string;
  rendered_text: string;
  updated_at_ms: number;
  retained: number;
};

type JobRow = {
  id: string;
  agent_id: string;
  conversation_id: string;
  provider: string;
  model: string;
  reasoning_effort: MemoryJob["reasoningEffort"] | null;
  from_sequence_id: number;
  through_sequence_id: number;
  summary_requested: number;
  memory_requested: number;
  status: string;
  attempts: number;
  next_attempt_at_ms: number;
  last_error_code: string | null;
  last_error_text: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

type RevisionRow = {
  id: number;
  memory_id: string;
  revision: number;
  snapshot_json: string;
  reason: string;
  created_at_ms: number;
};

type MemoryPageCursor = {
  version: 1;
  agentId: string;
  filter: string;
  pinned: 0 | 1;
  importance: number;
  confidence: number;
  updatedAtMs: number;
  id: string;
};

type TranscriptPageCursor = {
  version: 2;
  agentId: string;
  filter: string;
  sequenceId: number;
};

const MEMORY_KINDS: readonly MemoryKind[] = ["identity", "preference", "constraint", "decision", "fact", "procedure", "open_loop"];
const MEMORY_STATUSES: readonly MemoryStatus[] = ["active", "superseded", "forgotten", "expired"];
const JOB_STATUSES: readonly MemoryJobStatus[] = ["pending", "running", "retry", "complete", "dead"];
const MEMORY_KIND_SET: ReadonlySet<string> = new Set(MEMORY_KINDS);
const MEMORY_STATUS_SET: ReadonlySet<string> = new Set(MEMORY_STATUSES);
const JOB_STATUS_SET: ReadonlySet<string> = new Set(JOB_STATUSES);
const LEGACY_MEMORY_JOB_PROVIDER = "legacy-reflection-provider";
const LEGACY_MEMORY_JOB_MODEL = "legacy-reflection-model";

function assertAgentId(agentId: string): void {
  if (typeof agentId !== "string" || agentId.trim().length === 0 || agentId.length > 256) {
    throw new Error("agentId deve ser uma string não vazia");
  }
}

function assertConversationId(conversationId: string): void {
  if (typeof conversationId !== "string" || conversationId.trim().length === 0 || conversationId.length > 512) {
    throw new Error("conversationId deve ser uma string não vazia");
  }
}

function assertMemoryId(memoryId: string): void {
  if (typeof memoryId !== "string" || memoryId.trim().length === 0 || memoryId.length > 256) {
    throw new Error("memoryId deve ser uma string não vazia");
  }
}

function assertSafeTimestamp(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} inválido`);
}

function assertOptionalSafeTimestamp(value: unknown, label: string): asserts value is number | null {
  if (value !== null) assertSafeTimestamp(value, label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function visitTextValues(value: unknown, visit: (text: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitTextValues(item, visit);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) visitTextValues(item, visit);
  }
}

function assertValidSummaryContent(renderedText: string, summaryJsonValue: unknown, options: MemoryPolicyOptions): void {
  assertNoSensitiveMemoryContent(`${renderedText}\n${json(summaryJsonValue)}`, options);
  assertNoMemoryInstructionContent(renderedText);
  visitTextValues(summaryJsonValue, (text) => {
    assertNoSensitiveMemoryContent(text, options);
    assertNoMemoryInstructionContent(text);
  });
}

function parseJson(value: string | null): unknown {
  if (value === null || value.length === 0) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function json(value: unknown): string {
  let result: string;
  try {
    result = JSON.stringify(value ?? null);
  } catch {
    throw new Error("JSON de memória inválido");
  }
  if (result === undefined) throw new Error("JSON de memória inválido");
  return result;
}

function nowMs(value: number | undefined, fallback: () => number): number {
  const result = value ?? fallback();
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("timestamp inválido");
  return result;
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function normalizeCanonicalKey(value: string): string {
  if (typeof value !== "string") throw new Error("canonicalKey deve ser texto");
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu, " ");
  if (bytes(normalized) === 0 || bytes(normalized) > MEMORY_POLICY_LIMITS.canonicalKeyBytes) {
    throw new Error("canonicalKey excede o limite");
  }
  return normalized;
}

function isMemorySourceRef(value: unknown): value is MemorySourceRef {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && typeof (value as { conversationId?: unknown }).conversationId === "string"
    && typeof (value as { entryId?: unknown }).entryId === "string";
}

function normalizeSources(value: unknown): MemorySourceEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MEMORY_POLICY_LIMITS.sourceEntryIds) throw new Error("sourceEntryIds excede o limite");
  return value.map((source) => {
    if (typeof source === "string") {
      if (source.length === 0 || bytes(source) > MEMORY_POLICY_LIMITS.sourceEntryIdBytes) throw new Error("sourceEntryId inválido");
      return source;
    }
    if (!isMemorySourceRef(source) || source.conversationId.length === 0 || source.entryId.length === 0
      || bytes(source.conversationId) > MEMORY_POLICY_LIMITS.sourceEntryIdBytes
      || bytes(source.entryId) > MEMORY_POLICY_LIMITS.sourceEntryIdBytes) {
      throw new Error("sourceEntryId inválido");
    }
    return { conversationId: source.conversationId, entryId: source.entryId };
  });
}

function parseSources(value: string): MemorySourceEntry[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? normalizeSources(parsed) : [];
}

function sourceConversation(ref: MemorySourceEntry): string | null {
  if (typeof ref !== "string") return ref.conversationId;
  const separator = ref.indexOf(":");
  return separator > 0 ? ref.slice(0, separator) : null;
}

function memorySnapshot(memory: Memory): Record<string, unknown> {
  return {
    id: memory.id,
    agentId: memory.agentId,
    kind: memory.kind,
    canonicalKey: memory.canonicalKey,
    text: memory.text,
    valueJson: memory.valueJson,
    trust: memory.trust,
    status: memory.status,
    importance: memory.importance,
    confidence: memory.confidence,
    pinned: memory.pinned,
    sourceConversationId: memory.sourceConversationId,
    sourceEntryIds: memory.sourceEntryIds,
    validFromMs: memory.validFromMs,
    validToMs: memory.validToMs,
    expiresAtMs: memory.expiresAtMs,
    supersededBy: memory.supersededBy,
    revision: memory.revision,
    createdAtMs: memory.createdAtMs,
    updatedAtMs: memory.updatedAtMs,
  };
}

function fromMemoryRow(row: MemoryRow): Memory {
  ensureKind(row.kind);
  ensureTrust(row.trust);
  ensureStatus(row.status);
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind,
    canonicalKey: row.canonical_key,
    text: row.text,
    valueJson: parseJson(row.value_json),
    trust: row.trust,
    status: row.status,
    importance: row.importance,
    confidence: row.confidence,
    pinned: row.pinned === 1,
    sourceConversationId: row.source_conversation_id,
    sourceEntryIds: parseSources(row.source_entry_ids_json),
    validFromMs: row.valid_from_ms,
    validToMs: row.valid_to_ms,
    expiresAtMs: row.expires_at_ms,
    supersededBy: row.superseded_by,
    revision: row.revision,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function fromSummaryRow(row: SummaryRow): ConversationSummary {
  return {
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    revision: row.revision,
    throughSequenceId: row.through_sequence_id,
    summaryJson: parseJson(row.summary_json),
    renderedText: row.rendered_text,
    updatedAtMs: row.updated_at_ms,
    retained: row.retained === 1,
  };
}

function fromJobRow(row: JobRow): MemoryJob {
  ensureJobStatus(row.status);
  return {
    id: row.id,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    provider: row.provider,
    model: row.model,
    ...(row.reasoning_effort == null ? {} : { reasoningEffort: row.reasoning_effort }),
    fromSequenceId: row.from_sequence_id,
    throughSequenceId: row.through_sequence_id,
    summaryRequested: row.summary_requested === 1,
    memoryRequested: row.memory_requested === 1,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAtMs: row.next_attempt_at_ms,
    lastErrorCode: row.last_error_code,
    lastErrorText: row.last_error_text,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function fromRevisionRow(row: RevisionRow): MemoryRevision {
  return {
    id: row.id,
    memoryId: row.memory_id,
    revision: row.revision,
    snapshotJson: parseJson(row.snapshot_json),
    reason: row.reason,
    createdAtMs: row.created_at_ms,
  };
}

function ftsQuery(query: string): string {
  const terms = query.normalize("NFKC").trim().split(/\s+/u).filter(Boolean).slice(0, 16);
  if (terms.length === 0) return "";
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function memoryPageFilter(options: MemoryPageOptions, kinds: readonly MemoryKind[], query: string): string {
  return JSON.stringify({
    includeInactive: options.includeInactive === true,
    includeExpired: options.includeExpired === true,
    kinds: [...new Set(kinds)].sort(),
    conversationId: options.conversationId ?? null,
    query,
  });
}

function encodeMemoryPageCursor(cursor: MemoryPageCursor): string {
  return `v1m:${Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")}`;
}

function decodeMemoryPageCursor(agentId: string, filter: string, cursor: string): MemoryPageCursor {
  const match = /^v1m:([A-Za-z0-9_-]+)$/u.exec(cursor);
  if (match === null) throw new Error("cursor inválido");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"));
  } catch {
    throw new Error("cursor inválido");
  }
  const record = isRecord(parsed) ? parsed : undefined;
  if (
    record === undefined
    || record.version !== 1
    || record.agentId !== agentId
    || record.filter !== filter
    || (record.pinned !== 0 && record.pinned !== 1)
    || typeof record.importance !== "number"
    || !Number.isFinite(record.importance)
    || typeof record.confidence !== "number"
    || !Number.isFinite(record.confidence)
    || typeof record.updatedAtMs !== "number"
    || !Number.isSafeInteger(record.updatedAtMs)
    || record.updatedAtMs < 0
    || typeof record.id !== "string"
    || record.id.length === 0
  ) {
    throw new Error("cursor inválido para o agente ou filtros");
  }
  return parsed as MemoryPageCursor;
}

function transcriptPageFilter(conversationId: string | undefined, match: string): string {
  return JSON.stringify({ conversationId: conversationId ?? null, match });
}

function encodeTranscriptPageCursor(cursor: TranscriptPageCursor): string {
  return `v2t:${Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")}`;
}

function decodeTranscriptPageCursor(agentId: string, filter: string, cursor: string): TranscriptPageCursor {
  const match = /^v2t:([A-Za-z0-9_-]+)$/u.exec(cursor);
  if (match === null || cursor.length > 4_096) throw new Error("cursor inválido");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"));
  } catch {
    throw new Error("cursor inválido");
  }
  const record = isRecord(parsed) ? parsed : undefined;
  if (
    record === undefined
    || record.version !== 2
    || record.agentId !== agentId
    || record.filter !== filter
    || typeof record.sequenceId !== "number"
    || !Number.isSafeInteger(record.sequenceId)
    || record.sequenceId < 1
  ) {
    throw new Error("cursor inválido para o agente ou filtros");
  }
  return parsed as TranscriptPageCursor;
}

function snippet(content: string, query: string): string {
  const text = content.trim();
  if (text.length <= 240) return text;
  const term = query.trim().split(/\s+/u).find(Boolean)?.toLocaleLowerCase();
  const index = term === undefined ? 0 : Math.max(0, text.toLocaleLowerCase().indexOf(term));
  const start = Math.max(0, index - 80);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + 240)}${start + 240 < text.length ? "…" : ""}`;
}

function safeError(value: string | null | undefined, options: MemoryPolicyOptions): string | null {
  if (value === undefined || value === null) return null;
  if (assertsSecret(value, options)) return "[redacted]";
  return value.slice(0, 2_000);
}

function assertsSecret(value: string, options: MemoryPolicyOptions): boolean {
  try {
    assertNoSensitiveMemoryContent(value, options);
    return false;
  } catch {
    return true;
  }
}

function ensureKind(value: unknown): asserts value is MemoryKind {
  if (typeof value !== "string" || !MEMORY_KIND_SET.has(value)) throw new Error("kind de memória inválido");
}

function ensureTrust(value: unknown): asserts value is MemoryTrust {
  if (value !== "user" && value !== "verified_tool" && value !== "external_observation") throw new Error("trust de memória inválido");
}

function mutationRejection(code: "protected_target" | "revision_conflict" | "invalid_authority" | "policy", message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function ensureMutationAuthority(authority: MemoryMutationAuthority | undefined): asserts authority is MemoryMutationAuthority {
  if (authority === undefined || (authority.kind !== "user" && authority.kind !== "automatic" && authority.kind !== "admin")) {
    throw mutationRejection("invalid_authority", "autoridade de mutação de memória é obrigatória");
  }
  if (authority.expectedRevision !== undefined && (!Number.isSafeInteger(authority.expectedRevision) || authority.expectedRevision < 0)) {
    throw mutationRejection("invalid_authority", "expectedRevision de memória inválida");
  }
  if (authority.kind === "automatic") {
    assertConversationId(authority.conversationId);
    if (!Array.isArray(authority.evidenceIds) || authority.evidenceIds.some((id) => typeof id !== "string" || id.trim().length === 0)) {
      throw mutationRejection("invalid_authority", "evidenceIds automáticos inválidos");
    }
  }
}

function assertMutationAllowed(authority: MemoryMutationAuthority, target: Memory | undefined): void {
  const actualRevision = target?.revision ?? 0;
  if (authority.expectedRevision !== undefined && authority.expectedRevision !== actualRevision) {
    throw mutationRejection("revision_conflict", `revisão de memória stale: esperada ${authority.expectedRevision}, atual ${actualRevision}`);
  }
  if (authority.kind === "automatic" && target !== undefined && (target.pinned || target.trust === "user")) {
    throw mutationRejection("protected_target", "automação não altera memória pinned ou trust:user");
  }
  if (authority.kind === "automatic" && target !== undefined) {
    const hasConversationProvenance = target.sourceConversationId === authority.conversationId
      || target.sourceEntryIds.some((source) => (
        typeof source === "string"
          ? source.startsWith(`${authority.conversationId}:`)
          : source.conversationId === authority.conversationId
      ));
    if (!hasConversationProvenance) {
      throw mutationRejection("invalid_authority", "automação só altera memória derivada da conversa autorizada");
    }
  }
}

function ensureStatus(value: unknown): asserts value is MemoryStatus {
  if (typeof value !== "string" || !MEMORY_STATUS_SET.has(value)) throw new Error("status de memória inválido");
}

function ensureMode(value: unknown): asserts value is MemoryMode {
  if (value !== "automatic" && value !== "explicit" && value !== "off") throw new Error("mode de memória inválido");
}

function ensureJobStatus(value: unknown): asserts value is MemoryJobStatus {
  if (typeof value !== "string" || !JOB_STATUS_SET.has(value)) throw new Error("status de job inválido");
}

function countValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function requiredRow<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function activeConversationExistsClause(jobTable = "memory_jobs"): string {
  return `EXISTS (
    SELECT 1
    FROM agent_conversations AS c
    WHERE c.id = ${jobTable}.conversation_id
      AND c.agent_id = ${jobTable}.agent_id
      AND c.archived_at_ms IS NULL
  )`;
}

export class SqliteMemoryStore implements MemoryStore {
  private forgottenSourceCache?: {
    stamp: string;
    entries: Map<string, { conversationId: string; entryId: string; sequenceId: number; at: number }>;
    sourceTime: (source: MemoryContextSource) => number;
  };
  private readonly db: Database.Database;
  private readonly ownsDatabase: boolean;
  private readonly nowFn: () => number;
  private readonly secretValues?: () => readonly string[];
  readonly path: string;
  private closed = false;
  private transactionDepth = 0;

  constructor(opts: SqliteMemoryStoreOptions) {
    if (typeof opts.path !== "string" || opts.path.length === 0) throw new Error("memory store: path é obrigatório");
    if (opts.path !== ":memory:") fs.mkdirSync(nodePath.dirname(opts.path), { recursive: true });
    this.path = opts.path;
    this.nowFn = opts.now ?? Date.now;
    this.secretValues = opts.secretValues;
    const borrowedDatabase = opts.database ?? opts.db ?? opts.connection;
    this.ownsDatabase = borrowedDatabase === undefined;
    let database = borrowedDatabase;
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
    } catch (error) {
      if (this.ownsDatabase) database?.close();
      throw error;
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("memory store: conexão fechada");
  }

  sharesDatabase(database: Database.Database): boolean {
    return this.db === database;
  }

  private runTransaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.transactionDepth += 1;
    try {
      return this.db.transaction(fn)();
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private policyOptions(): MemoryPolicyOptions {
    return this.secretValues === undefined ? {} : { secretValues: this.secretValues };
  }

  private validateConversation(agentId: string, conversationId: string, required = false): boolean {
    assertAgentId(agentId);
    assertConversationId(conversationId);
    const row = this.db.prepare<unknown[], { agent_id: string; temporary: number }>("SELECT agent_id, temporary FROM agent_conversations WHERE id = ?").get(conversationId);
    if (row === undefined) {
      if (required) throw new Error("conversation não encontrada para o agente");
      return false;
    }
    if (row.agent_id !== agentId && agentId !== USER_PROFILE_AGENT_ID) throw new Error("conversation não pertence ao agente");
    if (row.temporary === 1) throw new Error("memória não pode ser derivada de conversa temporária");
    return true;
  }

  private expireDue(agentId?: string, now = this.nowFn()): void {
    this.runTransaction(() => {
      const rows = this.db.prepare<unknown[], MemoryRow>(`
        SELECT * FROM agent_memories
        WHERE status = 'active' AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?
          ${agentId === undefined ? "" : "AND agent_id = ?"}
      `).all(...(agentId === undefined ? [now] : [now, agentId]));
      if (rows.length === 0) return;
      const expire = this.db.prepare(`
        UPDATE agent_memories SET status = 'expired', revision = revision + 1, updated_at_ms = ?
        WHERE id = ? AND agent_id = ? AND status = 'active'
      `);
      for (const row of rows) {
        const previous = fromMemoryRow(row);
        const changed = expire.run(now, previous.id, previous.agentId);
        if (changed.changes === 1) {
          this.recordRevision({ ...previous, status: "expired", revision: previous.revision + 1, updatedAtMs: now }, "expired");
        }
      }
    });
  }

  getSettings(agentId: string): MemorySettings {
    assertAgentId(agentId);
    this.ensureOpen();
    const existing = this.db.prepare<unknown[], { agent_id: string; mode: string; updated_at_ms: number }>("SELECT agent_id, mode, updated_at_ms FROM agent_memory_settings WHERE agent_id = ?").get(agentId);
    if (existing !== undefined) {
      ensureMode(existing.mode);
      return { agentId: existing.agent_id, mode: existing.mode, updatedAtMs: existing.updated_at_ms };
    }
    const now = this.nowFn();
    this.db.prepare("INSERT OR IGNORE INTO agent_memory_settings(agent_id, mode, updated_at_ms) VALUES (?, 'automatic', ?)").run(agentId, now);
    return { agentId, mode: "automatic", updatedAtMs: now };
  }

  setSettings(agentId: string, mode: MemoryMode): MemorySettings {
    assertAgentId(agentId);
    ensureMode(mode);
    this.ensureOpen();
    const updatedAtMs = this.nowFn();
    this.db.prepare(`
      INSERT INTO agent_memory_settings(agent_id, mode, updated_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET mode = excluded.mode, updated_at_ms = excluded.updated_at_ms
    `).run(agentId, mode, updatedAtMs);
    return { agentId, mode, updatedAtMs };
  }

  getMemory(agentId: string, memoryId: string): Memory | null {
    assertAgentId(agentId);
    assertMemoryId(memoryId);
    this.ensureOpen();
    const row = this.db.prepare<unknown[], MemoryRow>("SELECT * FROM agent_memories WHERE agent_id = ? AND id = ?").get(agentId, memoryId);
    return row === undefined ? null : fromMemoryRow(row);
  }

  get(agentId: string, memoryId: string): Memory | null {
    return this.getMemory(agentId, memoryId);
  }

  getMemoryByCanonicalKey(agentId: string, canonicalKey: string): Memory | null {
    assertAgentId(agentId);
    this.ensureOpen();
    const now = this.nowFn();
    this.expireDue(agentId, now);
    const row = this.db.prepare<unknown[], MemoryRow>(`
      SELECT * FROM agent_memories
      WHERE agent_id = ? AND canonical_key = ? AND status = 'active'
        AND valid_from_ms <= ?
        AND (valid_to_ms IS NULL OR valid_to_ms > ?)
        AND (expires_at_ms IS NULL OR expires_at_ms > ?)
        AND NOT EXISTS (SELECT 1 FROM agent_conversations AS c WHERE c.id = agent_memories.source_conversation_id AND c.agent_id = agent_memories.agent_id AND c.temporary = 1)
      LIMIT 1
    `).get(agentId, canonicalKey, now, now, now);
    return row === undefined ? null : fromMemoryRow(row);
  }

  upsertMemory(input: MemoryUpsertInput & { agentId: string; authority: MemoryMutationAuthority }): Memory;
  upsertMemory(agentId: string, input: MemoryUpsertInput, authority: MemoryMutationAuthority): Memory;
  upsertMemory(
    first: string | (MemoryUpsertInput & { agentId?: string; authority?: MemoryMutationAuthority }),
    second?: MemoryUpsertInput,
    third?: MemoryMutationAuthority,
  ): Memory {
    const agentId = typeof first === "string" ? first : first.agentId;
    const input = typeof first === "string" ? second : first;
    const authority = typeof first === "string" ? third : first.authority;
    if (input === undefined) throw new Error("input de memória é obrigatório");
    ensureMutationAuthority(authority);
    assertAgentId(agentId ?? "");
    this.ensureOpen();
    ensureKind(input.kind);
    if (agentId === USER_PROFILE_AGENT_ID && !USER_PROFILE_KINDS.includes(input.kind)) {
      throw mutationRejection("policy", "perfil de usuário aceita apenas identity e preference");
    }
    ensureTrust(input.trust);
    const { createOnly: _createOnly, ...candidate } = input;
    validateMemoryCandidate({ ...candidate, kind: input.kind, trust: input.trust }, this.policyOptions());
    const canonicalKey = normalizeCanonicalKey(input.canonicalKey);
    const text = input.text.trim();
    if (bytes(text) === 0 || bytes(text) > MEMORY_POLICY_LIMITS.textBytes) throw new Error("text excede o limite");
    const valueJson = input.valueJson === undefined || input.valueJson === null ? null : json(input.valueJson);
    if (valueJson !== null && bytes(valueJson) > MEMORY_POLICY_LIMITS.valueJsonBytes) throw new Error("valueJson excede o limite");
    const sourceEntryIds = normalizeSources(input.sourceEntryIds);
    assertNoSensitiveMemoryContent(`${canonicalKey}\n${text}\n${valueJson ?? ""}\n${json(sourceEntryIds)}`, this.policyOptions());
    const sourceConversationId = input.sourceConversationId ?? null;
    if (sourceConversationId !== null) this.validateConversation(agentId!, sourceConversationId, true);
    for (const source of sourceEntryIds) {
      if (typeof source !== "string") this.validateConversation(agentId!, source.conversationId, true);
    }
    if (authority.kind === "automatic") {
      if (sourceConversationId !== authority.conversationId) {
        throw mutationRejection("invalid_authority", "mutação automática deve usar a conversa da autoridade");
      }
      const evidenceIds = new Set(authority.evidenceIds);
      const foreignEvidence = sourceEntryIds.some((source) => (
        typeof source === "string"
        || source.conversationId !== authority.conversationId
        || !evidenceIds.has(source.entryId)
      ));
      if (foreignEvidence) throw mutationRejection("invalid_authority", "proveniência automática fora da autoridade");
      const forgotten = this.getForgottenSourceIds(agentId!, authority.conversationId);
      if (sourceEntryIds.some((source) => forgotten.has(typeof source === 'string' ? source : source.entryId))) {
        throw mutationRejection("invalid_authority", "fonte esquecida não pode recriar memória automaticamente");
      }
    }
    const status = input.status ?? "active";
    ensureStatus(status);
    if (status !== "active") throw new Error("upsertMemory aceita apenas status active; use forget/supersede");
    const importance = input.importance ?? 50;
    const confidence = input.confidence ?? 0.5;
    if (!Number.isInteger(importance) || importance < 0 || importance > 100) throw new Error("importance inválida");
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("confidence inválida");
    const timestamp = nowMs(input.nowMs, this.nowFn);
    const validFromMs = input.validFromMs ?? timestamp;
    const validToMs = input.validToMs ?? null;
    const expiresAtMs = input.expiresAtMs ?? null;
    if (validToMs !== null && validToMs < validFromMs) throw new Error("validToMs inválido");
    const id = input.id ?? randomUUID();
    assertMemoryId(id);
    const transaction = () => this.runTransaction(() => {
      this.expireDue(agentId, timestamp);
      const byId = this.db.prepare<unknown[], MemoryRow>("SELECT * FROM agent_memories WHERE agent_id = ? AND id = ?").get(agentId, id);
      if (byId !== undefined && byId.canonical_key !== canonicalKey && byId.status === "active") {
        throw new Error("memoryId já pertence a outra canonicalKey");
      }
      const active = this.db.prepare<unknown[], MemoryRow>("SELECT * FROM agent_memories WHERE agent_id = ? AND canonical_key = ? AND status = 'active' LIMIT 1").get(agentId, canonicalKey);
      const old = byId ?? active;
      if (input.createOnly === true && active !== undefined) {
        const previous = fromMemoryRow(active);
        const sameValueJson = valueJson === null
          ? previous.valueJson === null
          : json(previous.valueJson) === valueJson;
        if (previous.kind === input.kind && previous.text === text && sameValueJson) return previous;
        assertMutationAllowed(authority, previous);
        throw Object.assign(new Error("canonicalKey já existe; use o gerenciador de memória para editar"), { code: "policy" });
      }
      assertMutationAllowed(authority, old === undefined ? undefined : fromMemoryRow(old));
      if (active !== undefined && active.id !== id) assertMutationAllowed(authority, fromMemoryRow(active));
      if (old !== undefined && old.status === "active" && old.id === id) {
        const previous = fromMemoryRow(old);
        const next: Memory = {
          ...previous,
          kind: input.kind,
          canonicalKey,
          text,
          valueJson: input.valueJson ?? null,
          trust: input.trust,
          importance,
          confidence,
          pinned: input.pinned ?? previous.pinned,
          sourceConversationId,
          sourceEntryIds,
          validFromMs,
          validToMs,
          expiresAtMs,
          revision: previous.revision + 1,
          updatedAtMs: timestamp,
        };
        if (JSON.stringify(memorySnapshot(previous)) === JSON.stringify(memorySnapshot(next))) return previous;
        this.db.prepare(`
          UPDATE agent_memories SET kind = ?, canonical_key = ?, text = ?, value_json = ?, trust = ?,
            importance = ?, confidence = ?, pinned = ?, source_conversation_id = ?, source_entry_ids_json = ?,
            valid_from_ms = ?, valid_to_ms = ?, expires_at_ms = ?, superseded_by = NULL, revision = ?, updated_at_ms = ?
          WHERE agent_id = ? AND id = ?
        `).run(input.kind, canonicalKey, text, valueJson, input.trust, importance, confidence, (input.pinned ?? previous.pinned) ? 1 : 0,
          sourceConversationId, json(sourceEntryIds), validFromMs, validToMs, expiresAtMs, next.revision, timestamp, agentId, id);
        this.recordRevision(next, "upsert");
        return next;
      }
      let newId = id;
      if (active !== undefined && active.id !== id) {
        const before = fromMemoryRow(active);
        this.db.prepare("UPDATE agent_memories SET status = 'superseded', superseded_by = ?, revision = revision + 1, updated_at_ms = ? WHERE agent_id = ? AND id = ?")
          .run(newId, timestamp, agentId, active.id);
        this.recordRevision({ ...before, status: "superseded", supersededBy: newId, revision: before.revision + 1, updatedAtMs: timestamp }, "conflict-superseded");
      } else if (byId !== undefined && byId.status !== "active") {
        // Tombstones and expired rows remain immutable history; a new active
        // value gets a fresh id even when a caller repeats the old id.
        newId = randomUUID();
      }
      const reusedId = newId === id;
      const createdAtMs = reusedId ? byId?.created_at_ms ?? timestamp : timestamp;
      const revision = reusedId ? byId?.revision ?? 1 : 1;
      this.db.prepare(`
        INSERT INTO agent_memories
          (id, agent_id, kind, canonical_key, text, value_json, trust, status, importance, confidence, pinned,
           source_conversation_id, source_entry_ids_json, valid_from_ms, valid_to_ms, expires_at_ms, superseded_by,
           revision, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `).run(newId, agentId, input.kind, canonicalKey, text, valueJson, input.trust, importance, confidence, input.pinned ? 1 : 0,
        sourceConversationId, json(sourceEntryIds), validFromMs, validToMs, expiresAtMs, revision, createdAtMs, timestamp);
      const created = this.db.prepare<unknown[], MemoryRow>("SELECT * FROM agent_memories WHERE agent_id = ? AND id = ?").get(agentId, newId);
      if (created === undefined) throw new Error("memória criada não encontrada");
      this.recordRevision(fromMemoryRow(created), active === undefined ? "upsert" : "conflict-replacement");
      return fromMemoryRow(created);
    });
    return transaction();
  }

  upsert(input: MemoryUpsertInput & { agentId: string; authority: MemoryMutationAuthority }): Memory;
  upsert(agentId: string, input: MemoryUpsertInput, authority: MemoryMutationAuthority): Memory;
  upsert(
    first: string | (MemoryUpsertInput & { agentId?: string; authority?: MemoryMutationAuthority }),
    second?: MemoryUpsertInput,
    third?: MemoryMutationAuthority,
  ): Memory {
    if (typeof first === "string") return this.upsertMemory(first, second!, third!);
    if (typeof first.agentId !== "string" || first.authority === undefined) throw new Error("agentId e authority são obrigatórios");
    return this.upsertMemory(first.agentId, first, first.authority);
  }

  private recordRevision(memory: Memory, reason: string): void {
    const safeReason = safeError(reason, this.policyOptions()) ?? "memory-change";
    this.db.prepare("INSERT OR IGNORE INTO memory_revisions(memory_id, revision, snapshot_json, reason, created_at_ms) VALUES (?, ?, ?, ?, ?)")
      .run(memory.id, memory.revision, json(memorySnapshot(memory)), safeReason, memory.updatedAtMs);
  }

  supersedeMemory(
    agentId: string,
    memoryId: string,
    authority: MemoryMutationAuthority,
    replacement?: MemoryUpsertInput,
    reason = "superseded",
  ): Memory {
    assertAgentId(agentId);
    assertMemoryId(memoryId);
    ensureMutationAuthority(authority);
    this.ensureOpen();
    const current = this.getMemory(agentId, memoryId);
    if (current === null) throw new Error("memória não encontrada");
    assertMutationAllowed(authority, current);
    if (replacement !== undefined) {
      return this.runTransaction(() => {
        const next = this.upsertMemory(agentId, { ...replacement, id: replacement.id ?? randomUUID() }, authority);
        const before = this.getMemory(agentId, memoryId)!;
        const updatedAtMs = this.nowFn();
        const changed = this.db.prepare("UPDATE agent_memories SET status = 'superseded', superseded_by = ?, revision = revision + 1, updated_at_ms = ? WHERE agent_id = ? AND id = ? AND status = 'active'")
          .run(next.id, updatedAtMs, agentId, memoryId);
        const result = this.getMemory(agentId, memoryId)!;
        if (changed.changes === 1) {
          this.recordRevision({ ...before, status: "superseded", supersededBy: next.id, revision: before.revision + 1, updatedAtMs }, reason);
        }
        return result;
      });
    }
    const updatedAtMs = this.nowFn();
    const result = () => this.runTransaction(() => {
      const row = this.db.prepare<unknown[], MemoryRow>("SELECT * FROM agent_memories WHERE agent_id = ? AND id = ?").get(agentId, memoryId);
      if (row === undefined) throw new Error("memória não encontrada");
      if (row.status !== "active") return fromMemoryRow(row);
      const before = fromMemoryRow(row);
      this.db.prepare("UPDATE agent_memories SET status = 'superseded', revision = revision + 1, updated_at_ms = ? WHERE agent_id = ? AND id = ?")
        .run(updatedAtMs, agentId, memoryId);
      this.recordRevision({ ...before, status: "superseded", revision: before.revision + 1, updatedAtMs }, reason);
      return this.getMemory(agentId, memoryId)!;
    });
    return result();
  }

  forgetMemory(agentId: string, memoryId: string, authority: MemoryMutationAuthority, reason = "forgotten"): Memory {
    assertAgentId(agentId);
    assertMemoryId(memoryId);
    ensureMutationAuthority(authority);
    this.ensureOpen();
    const result = () => this.runTransaction(() => {
      const row = this.db.prepare<unknown[], MemoryRow>("SELECT * FROM agent_memories WHERE agent_id = ? AND id = ?").get(agentId, memoryId);
      if (row === undefined) throw new Error("memória não encontrada");
      const before = fromMemoryRow(row);
      assertMutationAllowed(authority, before);
      if (before.status === "forgotten") return before;
      const updatedAtMs = this.nowFn();
      this.db.prepare("UPDATE agent_memories SET status = 'forgotten', superseded_by = NULL, revision = revision + 1, updated_at_ms = ? WHERE agent_id = ? AND id = ?")
        .run(updatedAtMs, agentId, memoryId);
      const next = { ...before, status: "forgotten" as const, supersededBy: null, revision: before.revision + 1, updatedAtMs };
      this.recordRevision(next, reason);
      return next;
    });
    return result();
  }

  listMemories(agentId: string, options: MemoryListOptions = {}): readonly Memory[] {
    assertAgentId(agentId);
    this.ensureOpen();
    const now = this.nowFn();
    this.expireDue(agentId, now);
    const includeInactive = options.includeInactive ?? false;
    const includeExpired = options.includeExpired ?? false;
    const kinds = options.kind === undefined ? undefined : (Array.isArray(options.kind) ? options.kind : [options.kind]);
    for (const kind of kinds ?? []) ensureKind(kind);
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit de memórias inválido");
    const clauses = ["agent_id = ?", "NOT EXISTS (SELECT 1 FROM agent_conversations AS c WHERE c.id = agent_memories.source_conversation_id AND c.agent_id = agent_memories.agent_id AND c.temporary = 1)"];
    const args: unknown[] = [agentId];
    if (!includeInactive) clauses.push("status = 'active'");
    clauses.push("valid_from_ms <= ?");
    args.push(now);
    if (!includeExpired) {
      clauses.push("(valid_to_ms IS NULL OR valid_to_ms > ?)");
      clauses.push("(expires_at_ms IS NULL OR expires_at_ms > ?)");
      args.push(now, now);
    }
    if (kinds !== undefined && kinds.length > 0) {
      clauses.push(`kind IN (${kinds.map(() => "?").join(",")})`);
      args.push(...kinds);
    }
    if (options.conversationId !== undefined) {
      assertConversationId(options.conversationId);
      clauses.push(`(
        source_conversation_id = ?
        OR EXISTS (
          SELECT 1
          FROM json_each(source_entry_ids_json) AS source
          WHERE (
            json_type(source.value) = 'object'
            AND json_extract(source.value, '$.conversationId') = ?
          ) OR (
            json_type(source.value) = 'text'
            AND instr(source.value, ':') > 0
            AND substr(source.value, 1, instr(source.value, ':') - 1) = ?
          )
        )
      )`);
      args.push(options.conversationId, options.conversationId, options.conversationId);
    }
    const rows = this.db.prepare<unknown[], MemoryRow>(`SELECT * FROM agent_memories WHERE ${clauses.join(" AND ")} ORDER BY pinned DESC, importance DESC, confidence DESC, updated_at_ms DESC, id ASC LIMIT ?`).all(...args, limit);
    return rows.map(fromMemoryRow).filter((memory) => !options.automatic || memory.trust === "user" || !this.hasForgottenContextSources(agentId, memoryContextSources(memory)));
  }

  list(agentId: string, options: MemoryListOptions = {}): readonly Memory[] {
    return this.listMemories(agentId, options);
  }

  listMemoriesPage(agentId: string, options: MemoryPageOptions = {}): MemoryPage {
    assertAgentId(agentId);
    this.ensureOpen();
    const now = this.nowFn();
    this.expireDue(agentId, now);
    const includeInactive = options.includeInactive ?? false;
    const includeExpired = options.includeExpired ?? false;
    const kinds = options.kind === undefined ? [] : (Array.isArray(options.kind) ? [...options.kind] : [options.kind]);
    for (const kind of kinds) ensureKind(kind);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit de página de memórias inválido");
    if (options.conversationId !== undefined) assertConversationId(options.conversationId);
    if (options.query !== undefined && typeof options.query !== "string") throw new Error("query de memórias inválida");
    const query = (options.query ?? "").normalize("NFKC").trim();
    if (bytes(query) > 512) throw new Error("query de memórias muito longa");
    const filter = memoryPageFilter(options, kinds, query);
    const cursor = options.cursor === undefined ? undefined : decodeMemoryPageCursor(agentId, filter, options.cursor);
    const clauses = [
      "agent_id = ?",
      "NOT EXISTS (SELECT 1 FROM agent_conversations AS c WHERE c.id = agent_memories.source_conversation_id AND c.agent_id = agent_memories.agent_id AND c.temporary = 1)",
    ];
    const args: unknown[] = [agentId];
    if (!includeInactive) clauses.push("status = 'active'");
    clauses.push("valid_from_ms <= ?");
    args.push(now);
    if (!includeExpired) {
      clauses.push("(valid_to_ms IS NULL OR valid_to_ms > ?)");
      clauses.push("(expires_at_ms IS NULL OR expires_at_ms > ?)");
      args.push(now, now);
    }
    if (kinds.length > 0) {
      clauses.push(`kind IN (${kinds.map(() => "?").join(",")})`);
      args.push(...kinds);
    }
    if (options.conversationId !== undefined) {
      clauses.push(`(
        source_conversation_id = ?
        OR EXISTS (
          SELECT 1
          FROM json_each(source_entry_ids_json) AS source
          WHERE (
            json_type(source.value) = 'object'
            AND json_extract(source.value, '$.conversationId') = ?
          ) OR (
            json_type(source.value) = 'text'
            AND instr(source.value, ':') > 0
            AND substr(source.value, 1, instr(source.value, ':') - 1) = ?
          )
        )
      )`);
      args.push(options.conversationId, options.conversationId, options.conversationId);
    }
    if (query.length > 0) {
      clauses.push(`(
        instr(lower(text), lower(?)) > 0
        OR instr(lower(kind), lower(?)) > 0
        OR instr(lower(status), lower(?)) > 0
        OR instr(lower(COALESCE(source_conversation_id, '')), lower(?)) > 0
      )`);
      args.push(query, query, query, query);
    }
    if (cursor !== undefined) {
      clauses.push(`(
        pinned < ?
        OR (pinned = ? AND importance < ?)
        OR (pinned = ? AND importance = ? AND confidence < ?)
        OR (pinned = ? AND importance = ? AND confidence = ? AND updated_at_ms < ?)
        OR (pinned = ? AND importance = ? AND confidence = ? AND updated_at_ms = ? AND id > ?)
      )`);
      args.push(
        cursor.pinned,
        cursor.pinned, cursor.importance,
        cursor.pinned, cursor.importance, cursor.confidence,
        cursor.pinned, cursor.importance, cursor.confidence, cursor.updatedAtMs,
        cursor.pinned, cursor.importance, cursor.confidence, cursor.updatedAtMs, cursor.id,
      );
    }
    const rows = this.db.prepare<unknown[], MemoryRow>(`
      SELECT *
      FROM agent_memories
      WHERE ${clauses.join(" AND ")}
      ORDER BY pinned DESC, importance DESC, confidence DESC, updated_at_ms DESC, id ASC
      LIMIT ?
    `).all(...args, limit + 1);
    const hasNext = rows.length > limit;
    const selected = hasNext ? rows.slice(0, limit) : rows;
    const page: MemoryPage = { items: selected.map(fromMemoryRow) };
    if (hasNext) {
      const last = selected.at(-1);
      if (last !== undefined) {
        page.nextCursor = encodeMemoryPageCursor({
          version: 1,
          agentId,
          filter,
          pinned: last.pinned === 1 ? 1 : 0,
          importance: last.importance,
          confidence: last.confidence,
          updatedAtMs: last.updated_at_ms,
          id: last.id,
        });
      }
    }
    return page;
  }

  searchMemories(agentId: string, query: string, options: MemorySearchOptions = {}): readonly MemorySearchResult[] {
    assertAgentId(agentId);
    if (typeof query !== "string") throw new Error("query inválida");
    this.ensureOpen();
    const limit = Math.min(options.limit ?? 20, 20);
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit inválido");
    const match = ftsQuery(query);
    if (match.length === 0) {
      return this.listMemories(agentId, { ...options, limit }).map((memory) => ({
        memory,
        snippet: memory.text,
        score: 0,
        provenance: { sourceConversationId: memory.sourceConversationId, sourceEntryIds: memory.sourceEntryIds },
      }));
    }
    this.expireDue(agentId);
    const searchNow = this.nowFn();
    const clauses = ["f.agent_id = ?", "memory_fts MATCH ?", "m.status = 'active'", "m.valid_from_ms <= ?", "(m.valid_to_ms IS NULL OR m.valid_to_ms > ?)", "(m.expires_at_ms IS NULL OR m.expires_at_ms > ?)"];
    const args: unknown[] = [agentId, match, searchNow, searchNow, searchNow];
    if (options.conversationId !== undefined) {
      assertConversationId(options.conversationId);
      clauses.push(`(
        m.source_conversation_id = ?
        OR EXISTS (
          SELECT 1
          FROM json_each(m.source_entry_ids_json) AS source
          WHERE (
            json_type(source.value) = 'object'
            AND json_extract(source.value, '$.conversationId') = ?
          ) OR (
            json_type(source.value) = 'text'
            AND instr(source.value, ':') > 0
            AND substr(source.value, 1, instr(source.value, ':') - 1) = ?
          )
        )
      )`);
      args.push(options.conversationId, options.conversationId, options.conversationId);
    }
    const rows = this.db.prepare<unknown[], MemoryRow & { fts_text: string; score: number }>(`
      SELECT m.*, f.text AS fts_text, bm25(memory_fts) AS score
      FROM memory_fts AS f JOIN agent_memories AS m ON m.id = f.memory_id AND m.agent_id = f.agent_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY m.pinned DESC, score ASC, m.importance DESC, m.updated_at_ms DESC
      LIMIT ?
    `).all(...args, limit);
    return rows.map((row) => ({
      memory: fromMemoryRow(row),
      snippet: snippet(row.text, query),
      score: typeof row.score === "number" ? row.score : 0,
      provenance: { sourceConversationId: row.source_conversation_id, sourceEntryIds: parseSources(row.source_entry_ids_json) },
    })).filter(({ memory }) => !options.automatic || memory.trust === "user" || !this.hasForgottenContextSources(agentId, memoryContextSources(memory)));
  }

  search(agentId: string, query: string, options: MemorySearchOptions = {}): readonly MemorySearchResult[] {
    return this.searchMemories(agentId, query, options);
  }

  /** Resolve tombstones and their revisions, including shared-profile origins. */
  private forgottenSources() {
    // Reuse the provenance walk until this connection or another writer changes the DB.
    const stamp = `${this.db.prepare<[], { changes: number }>('SELECT total_changes() AS changes').get()!.changes}:${String(this.db.pragma('data_version', { simple: true }))}`;
    if (this.forgottenSourceCache?.stamp === stamp) return this.forgottenSourceCache;
    const memories = new Map<string, number>();
    const entries = new Map<string, { conversationId: string; entryId: string; sequenceId: number; at: number }>();
    const key = (conversation: string, entry: string) => `${conversation}\0${entry}`;
    const rows = this.db.prepare<unknown[], { snapshot_json: string; forgotten_at: number }>(`
      WITH RECURSIVE forgotten(id, forgotten_at) AS (
        SELECT id, updated_at_ms FROM agent_memories
        WHERE status = 'forgotten'
        UNION
        SELECT m.id, f.forgotten_at FROM agent_memories m JOIN forgotten f ON m.superseded_by = f.id
      )
      SELECT r.snapshot_json, f.forgotten_at FROM forgotten f JOIN memory_revisions r ON r.memory_id = f.id
    `).all();
    for (const row of rows) {
      const snapshot = JSON.parse(row.snapshot_json) as Memory;
      memories.set(snapshot.id, Math.max(memories.get(snapshot.id) ?? -1, row.forgotten_at));
      for (const source of snapshot.sourceEntryIds) {
        const ref = typeof source === 'string' ? { conversationId: snapshot.sourceConversationId, entryId: source } : source;
        if (ref.conversationId === null) continue;
        entries.set(key(ref.conversationId, ref.entryId), { ...ref, conversationId: ref.conversationId, sequenceId: 0, at: Math.max(entries.get(key(ref.conversationId, ref.entryId))?.at ?? -1, row.forgotten_at) });
      }
    }
    const sourceTime = (source: MemoryContextSource): number => {
      if ("memoryId" in source) return memories.get(source.memoryId) ?? -1;
      if ("entryId" in source) return entries.get(key(source.conversationId, source.entryId))?.at ?? -1;
      let at = -1;
      for (const entry of entries.values()) {
        if (entry.conversationId === source.conversationId && entry.sequenceId <= source.throughSequenceId && entry.at >= source.updatedAtMs) at = Math.max(at, entry.at);
      }
      return at;
    };
    // Dependencies always precede their generated reply in the transcript.
    // Read only provenance/roles here, never match or erase message text.
    if (memories.size > 0) {
      const transcript = this.db.prepare<unknown[], { sequence_id: number; conversation_id: string; entry_id: string; kind: string; role: string | null; sources: string | null }>(`
        SELECT sequence_id, conversation_id, entry_id, kind, json_extract(payload_json, '$.role') AS role,
          json_extract(payload_json, '$.memoryContextSources') AS sources
        FROM transcript_entries WHERE conversation_id IS NOT NULL ORDER BY sequence_id
      `).all();
      for (const entry of transcript) {
        const direct = entries.get(key(entry.conversation_id, entry.entry_id));
        if (direct) direct.sequenceId = entry.sequence_id;
      }
      const turns = new Map<string, number>();
      for (const entry of transcript) {
        const entryKey = key(entry.conversation_id, entry.entry_id);
        const direct = entries.get(entryKey)?.at ?? -1;
        if (entry.kind === "message" && entry.role === "user") turns.set(entry.conversation_id, direct);
        const sources = entry.sources === null ? [] : JSON.parse(entry.sources) as MemoryContextSource[];
        const at = Math.max(direct, turns.get(entry.conversation_id) ?? -1, ...sources.map(sourceTime));
        if (at < 0) continue;
        entries.set(entryKey, { conversationId: entry.conversation_id, entryId: entry.entry_id, sequenceId: entry.sequence_id, at });
        turns.set(entry.conversation_id, at);
      }
    }
    this.forgottenSourceCache = { stamp, entries, sourceTime };
    return this.forgottenSourceCache;
  }

  getForgottenSourceIds(agentId: string, conversationId: string): ReadonlySet<string> {
    assertAgentId(agentId);
    assertConversationId(conversationId);
    this.ensureOpen();
    return new Set([...this.forgottenSources().entries.values()].filter((entry) => entry.conversationId === conversationId).map((entry) => entry.entryId));
  }

  hasForgottenContextSources(agentId: string, sources: readonly MemoryContextSource[]): boolean {
    assertAgentId(agentId);
    this.ensureOpen();
    if (sources.length === 0) return false;
    const { sourceTime } = this.forgottenSources();
    return sources.some((source) => sourceTime(source) >= 0);
  }

  getSummary(agentId: string, conversationId: string, automatic = false): ConversationSummary | null {
    assertAgentId(agentId);
    assertConversationId(conversationId);
    this.ensureOpen();
    const row = this.db.prepare<unknown[], SummaryRow>("SELECT * FROM conversation_summaries WHERE agent_id = ? AND conversation_id = ?").get(agentId, conversationId);
    if (automatic && row !== undefined && this.hasForgottenContextSources(agentId, [{ conversationId, throughSequenceId: row.through_sequence_id, updatedAtMs: row.updated_at_ms }])) return null;
    return row === undefined ? null : fromSummaryRow(row);
  }

  upsertSummary(input: ConversationSummaryInput & { agentId: string }): ConversationSummary;
  upsertSummary(agentId: string, input: ConversationSummaryInput): ConversationSummary;
  upsertSummary(first: string | (ConversationSummaryInput & { agentId?: string }), second?: ConversationSummaryInput): ConversationSummary {
    const agentId = typeof first === "string" ? first : first.agentId;
    const input = typeof first === "string" ? second : first;
    if (input === undefined) throw new Error("summary input é obrigatório");
    assertAgentId(agentId ?? "");
    assertConversationId(input.conversationId);
    if (!Number.isSafeInteger(input.throughSequenceId) || input.throughSequenceId < 0) throw new Error("throughSequenceId inválido");
    if (typeof input.renderedText !== "string" || input.renderedText.trim().length === 0 || bytes(input.renderedText) > MEMORY_POLICY_LIMITS.renderedSummaryBytes) throw new Error("renderedText inválido");
    const summaryJson = json(input.summaryJson);
    if (bytes(summaryJson) > MEMORY_POLICY_LIMITS.valueJsonBytes) throw new Error("summaryJson excede o limite");
    assertValidSummaryContent(input.renderedText, input.summaryJson, this.policyOptions());
    this.ensureOpen();
    this.validateConversation(agentId!, input.conversationId, true);
    const updatedAtMs = input.updatedAtMs ?? this.nowFn();
    const result = () => this.runTransaction(() => {
      const old = this.db.prepare<unknown[], { revision: number; through_sequence_id: number }>("SELECT revision, through_sequence_id FROM conversation_summaries WHERE agent_id = ? AND conversation_id = ?")
        .get(agentId, input.conversationId);
      // A delayed/retried reflection must not overwrite a newer summary with
      // an earlier transcript boundary.
      if (old !== undefined && input.throughSequenceId < old.through_sequence_id) {
        return this.getSummary(agentId!, input.conversationId)!;
      }
      const actualPreviousRevision = old?.revision ?? 0;
      if (input.expectedPreviousRevision !== undefined) {
        if (!Number.isSafeInteger(input.expectedPreviousRevision) || input.expectedPreviousRevision < 0) throw new Error("expectedPreviousRevision inválida");
        if (input.expectedPreviousRevision !== actualPreviousRevision) {
          throw new Error(`summary revision stale: esperada ${input.expectedPreviousRevision}, atual ${actualPreviousRevision}`);
        }
      }
      const revision = actualPreviousRevision + 1;
      this.db.prepare(`
        INSERT INTO conversation_summaries(conversation_id, agent_id, revision, through_sequence_id, summary_json, rendered_text, updated_at_ms, retained)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(conversation_id) DO UPDATE SET agent_id = excluded.agent_id, revision = excluded.revision,
          through_sequence_id = excluded.through_sequence_id, summary_json = excluded.summary_json,
          rendered_text = excluded.rendered_text, updated_at_ms = excluded.updated_at_ms, retained = 0
      `).run(input.conversationId, agentId, revision, input.throughSequenceId, summaryJson, input.renderedText.trim(), updatedAtMs);
      return this.getSummary(agentId!, input.conversationId)!;
    });
    return result();
  }

  searchHistory(agentId: string, query: string, options: HistorySearchOptions = {}): readonly HistorySearchResult[] {
    assertAgentId(agentId);
    if (typeof query !== "string") throw new Error("query inválida");
    this.ensureOpen();
    const limit = Math.min(options.limit ?? 20, 20);
    const includeMemories = options.includeMemories ?? true;
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit inválido");
    if (options.conversationId !== undefined) assertConversationId(options.conversationId);
    if (options.excludeConversationId !== undefined) assertConversationId(options.excludeConversationId);
    const result: HistorySearchResult[] = [];
    if (includeMemories) {
      for (const found of this.searchMemories(agentId, query, { limit, conversationId: options.conversationId, automatic: options.automatic })) {
        result.push({
          kind: "memory",
          snippet: found.snippet,
          score: found.score,
          agentId,
          conversationId: found.memory.sourceConversationId,
          sequenceId: null,
          provenance: { source: "memory", memoryId: found.memory.id, sourceEntryIds: found.memory.sourceEntryIds },
          memory: found.memory,
        });
      }
    }
    const match = ftsQuery(query);
    if (match.length > 0) {
      const clauses = ["agent_id = ?", "history_fts MATCH ?"];
      const args: unknown[] = [agentId, match];
      if (options.conversationId !== undefined) {
        clauses.push("conversation_id = ?");
        args.push(options.conversationId);
      }
      if (options.excludeConversationId !== undefined) {
        clauses.push("conversation_id <> ?");
        args.push(options.excludeConversationId);
      }
      const rows = this.db.prepare<unknown[], {
        source_id: string;
        agent_id: string;
        conversation_id: string | null;
        source_type: "message" | "summary";
        content: string;
        sequence_id: number | string | null;
        score: number;
      }>(`SELECT *, bm25(history_fts) AS score FROM history_fts WHERE ${clauses.join(" AND ")} ORDER BY score ASC, sequence_id DESC LIMIT ?`).all(...args, limit);
      for (const row of rows) {
        const summary = row.source_type === "summary" && row.conversation_id !== null ? this.getSummary(agentId, row.conversation_id) ?? undefined : undefined;
        if (options.automatic && row.conversation_id !== null) {
          if (row.source_type === 'summary' && this.getSummary(agentId, row.conversation_id, true) === null) continue;
          if (row.source_type === 'message') {
            const source = this.db.prepare<unknown[], { entry_id: string }>('SELECT entry_id FROM transcript_entries WHERE agent_id = ? AND sequence_id = ?').get(agentId, row.sequence_id);
            if (source && this.getForgottenSourceIds(agentId, row.conversation_id).has(source.entry_id)) continue;
          }
        }
        result.push({
          kind: row.source_type === "summary" ? "summary" : "message",
          snippet: snippet(row.content, query),
          score: typeof row.score === "number" ? row.score : 0,
          agentId,
          conversationId: row.conversation_id,
          sequenceId: typeof row.sequence_id === "number" ? row.sequence_id : Number(row.sequence_id),
          provenance: {
            source: row.source_type === "summary" ? "summary" : "transcript",
            ...(row.source_type !== "message" || row.conversation_id === null ? {} : {
              sourceEntryIds: this.db.prepare<unknown[], { entry_id: string }>('SELECT entry_id FROM transcript_entries WHERE agent_id = ? AND sequence_id = ?').all(agentId, row.sequence_id)
                .map((entry) => ({ conversationId: row.conversation_id!, entryId: entry.entry_id })),
            }),
          },
          ...(summary === undefined ? {} : { summary }),
        });
      }
    }
    const deduped: HistorySearchResult[] = [];
    const seen = new Set<string>();
    for (const entry of result.sort((a, b) => (a.kind === "memory" ? -1 : 0) - (b.kind === "memory" ? -1 : 0) || a.score - b.score)) {
      const key = entry.provenance.source === "memory"
        ? `memory:${entry.provenance.memoryId ?? ""}`
        : entry.provenance.source === "summary"
          ? `summary:${entry.conversationId ?? ""}`
          : `transcript:${entry.conversationId ?? ""}:${entry.sequenceId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(entry);
      if (deduped.length >= limit) break;
    }
    return deduped;
  }

  /**
   * P2.3 — agent/conversation-scoped FTS transcript search with a stable
   * cursor and bounded snippets. Sources are persisted 'message' rows only;
   * the page resolves each match to its transcript entry id without
   * duplication across pages (cursor strictly decreases sequence_id).
   */
  searchTranscript(agentId: string, query: string, options: TranscriptSearchOptions = {}): TranscriptSearchPage {
    assertAgentId(agentId);
    if (typeof query !== "string" || query.trim().length === 0) throw new Error("query obrigatória");
    if (query.length > 512) throw new Error("query muito longa");
    this.ensureOpen();
    const limit = Math.min(options.limit ?? 20, 50);
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit inválido");
    if (options.conversationId !== undefined) assertConversationId(options.conversationId);
    const match = ftsQuery(query);
    if (match.length === 0) return { items: [] };
    const filter = transcriptPageFilter(options.conversationId, match);
    const clauses = ["f.agent_id = ?", "history_fts MATCH ?", "f.source_type = 'message'"];
    const args: unknown[] = [agentId, match];
    if (options.conversationId !== undefined) { clauses.push("f.conversation_id = ?"); args.push(options.conversationId); }
    let beforeSeq: number | undefined;
    if (options.cursor !== undefined) {
      beforeSeq = decodeTranscriptPageCursor(agentId, filter, options.cursor).sequenceId;
      clauses.push("f.sequence_id < ?");
      args.push(beforeSeq);
    }
    args.push(limit + 1);
    const rows = this.db.prepare<unknown[], { seq: number; conversation_id: string | null; content: string; source_type: string; entry_id: string | null; kind: string | null; score: number }>(`
      SELECT f.sequence_id AS seq, f.conversation_id AS conversation_id,
        f.content AS content, f.source_type AS source_type,
        t.entry_id AS entry_id, t.kind AS kind, bm25(history_fts) AS score
      FROM history_fts AS f
      LEFT JOIN transcript_entries AS t
        ON t.agent_id = f.agent_id AND t.conversation_id = f.conversation_id AND t.sequence_id = f.sequence_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY f.sequence_id DESC, f.rowid ASC
      LIMIT ?
    `).all(...args);
    const hasNext = rows.length > limit;
    const selected = hasNext ? rows.slice(0, limit) : rows;
    const items = selected.map((row) => ({
      entryId: row.entry_id ?? null,
      sequenceId: row.seq,
      kind: row.kind ?? row.source_type,
      conversationId: row.conversation_id,
      snippet: snippet(row.content, query),
      score: typeof row.score === "number" ? row.score : 0,
    }));
    let nextCursor: string | undefined;
    if (hasNext && selected.length > 0) {
      const last = selected[selected.length - 1];
      if (last !== undefined) {
        nextCursor = encodeTranscriptPageCursor({ version: 2, agentId, filter, sequenceId: last.seq });
      }
    }
    return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }

  enqueueJob(input: MemoryJobInput): MemoryJob {
    assertAgentId(input.agentId);
    if (input.reasoningEffort !== undefined && !REASONING_EFFORTS.includes(input.reasoningEffort)) throw new Error("reasoningEffort de job inválido");
    this.validateConversation(input.agentId, input.conversationId, true);
    const provider = typeof input.provider === "string" && input.provider.trim().length > 0
      ? input.provider.trim()
      : LEGACY_MEMORY_JOB_PROVIDER;
    const model = typeof input.model === "string" && input.model.trim().length > 0
      ? input.model.trim()
      : LEGACY_MEMORY_JOB_MODEL;
    const summaryRequested = input.summaryRequested ?? false;
    const memoryRequested = input.memoryRequested ?? true;
    if (typeof summaryRequested !== "boolean" || typeof memoryRequested !== "boolean" || (!summaryRequested && !memoryRequested)) {
      throw new Error("job de reflexão precisa solicitar summary ou memória");
    }
    if (!Number.isSafeInteger(input.fromSequenceId) || input.fromSequenceId < 0 || !Number.isSafeInteger(input.throughSequenceId) || input.throughSequenceId < input.fromSequenceId) throw new Error("sequência de job inválida");
    const timestamp = nowMs(input.nowMs, this.nowFn);
    const id = input.id ?? randomUUID();
    assertMemoryId(id);
    const status = input.status ?? "pending";
    ensureJobStatus(status);
    const result = () => this.runTransaction(() => {
      this.db.prepare(`
        DELETE FROM memory_jobs
        WHERE id IN (
          SELECT id FROM memory_jobs
          WHERE status IN ('complete', 'dead') AND updated_at_ms < ?
          ORDER BY updated_at_ms ASC
          LIMIT 100
        )
      `).run(timestamp - 7 * 24 * 60 * 60_000);

      const running = status === "pending" ? this.db.prepare<unknown[], JobRow>(`
        SELECT * FROM memory_jobs
        WHERE agent_id = ? AND conversation_id = ? AND status = 'running'
        ORDER BY through_sequence_id DESC
        LIMIT 1
      `).get(input.agentId, input.conversationId) : undefined;
      if (running !== undefined && input.throughSequenceId <= running.through_sequence_id) return running;

      const pending = status === "pending" ? this.db.prepare<unknown[], JobRow>(`
        SELECT * FROM memory_jobs
        WHERE agent_id = ? AND conversation_id = ? AND status IN ('pending', 'retry')
        ORDER BY through_sequence_id DESC
        LIMIT 1
      `).get(input.agentId, input.conversationId) : undefined;
      if (pending !== undefined) {
        const fromSequenceId = Math.max(
          running === undefined ? 0 : running.through_sequence_id + 1,
          Math.min(pending.from_sequence_id, input.fromSequenceId),
        );
        const throughSequenceId = Math.max(pending.through_sequence_id, input.throughSequenceId);
        const nextAttemptAtMs = Math.min(pending.next_attempt_at_ms, input.nextAttemptAtMs ?? timestamp);
        this.db.prepare(`
          UPDATE memory_jobs
          SET from_sequence_id = ?, through_sequence_id = ?, summary_requested = ?, memory_requested = ?,
              status = 'pending', attempts = 0, next_attempt_at_ms = ?, last_error_code = NULL,
              last_error_text = NULL, updated_at_ms = ?
          WHERE id = ?
        `).run(
          fromSequenceId,
          throughSequenceId,
          pending.summary_requested === 1 || summaryRequested ? 1 : 0,
          pending.memory_requested === 1 || memoryRequested ? 1 : 0,
          nextAttemptAtMs,
          timestamp,
          pending.id,
        );
        return requiredRow(this.db.prepare<unknown[], JobRow>("SELECT * FROM memory_jobs WHERE id = ?").get(pending.id), "job de memória atualizado não encontrado");
      }

      const fromSequenceId = running === undefined
        ? input.fromSequenceId
        : Math.max(input.fromSequenceId, running.through_sequence_id + 1);
      this.db.prepare(`
        INSERT INTO memory_jobs(id, agent_id, conversation_id, provider, model, reasoning_effort, from_sequence_id, through_sequence_id, summary_requested, memory_requested, status, attempts, next_attempt_at_ms, last_error_code, last_error_text, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, conversation_id, through_sequence_id) DO NOTHING
      `).run(
        id,
        input.agentId,
        input.conversationId,
        provider,
        model,
        input.reasoningEffort ?? null,
        fromSequenceId,
        input.throughSequenceId,
        summaryRequested ? 1 : 0,
        memoryRequested ? 1 : 0,
        status,
        input.attempts ?? 0,
        input.nextAttemptAtMs ?? timestamp,
        input.lastErrorCode ?? null,
        input.lastErrorText ?? null,
        timestamp,
        timestamp,
      );
      const current = this.db.prepare<unknown[], JobRow>(`
        SELECT * FROM memory_jobs
        WHERE agent_id = ? AND conversation_id = ? AND through_sequence_id = ?
      `).get(input.agentId, input.conversationId, input.throughSequenceId);
      if (current?.status === "dead") {
        this.db.prepare(`
          UPDATE memory_jobs
          SET provider = ?, model = ?, reasoning_effort = ?, from_sequence_id = ?, summary_requested = ?, memory_requested = ?,
              status = 'pending', attempts = 0, next_attempt_at_ms = ?, last_error_code = NULL,
              last_error_text = NULL, updated_at_ms = ?
          WHERE agent_id = ? AND conversation_id = ? AND through_sequence_id = ? AND status = 'dead'
        `).run(provider, model, input.reasoningEffort ?? null, fromSequenceId, summaryRequested ? 1 : 0, memoryRequested ? 1 : 0, timestamp, timestamp, input.agentId, input.conversationId, input.throughSequenceId);
      }
      return requiredRow(
        this.db.prepare<unknown[], JobRow>("SELECT * FROM memory_jobs WHERE agent_id = ? AND conversation_id = ? AND through_sequence_id = ?")
          .get(input.agentId, input.conversationId, input.throughSequenceId),
        "job de memória criado não encontrado",
      );
    });
    return fromJobRow(result());
  }

  isConversationActive(agentId: string, conversationId: string): boolean {
    assertAgentId(agentId);
    assertConversationId(conversationId);
    this.ensureOpen();
    const row = this.db.prepare<unknown[], { active?: number }>(`
      SELECT 1 AS active
      FROM agent_conversations
      WHERE agent_id = ? AND id = ? AND archived_at_ms IS NULL
    `).get(agentId, conversationId);
    return row?.active === 1;
  }

  claimJob(agentId: string, jobId?: string, at = this.nowFn()): MemoryJob | null {
    assertAgentId(agentId);
    this.ensureOpen();
    const result = () => this.runTransaction(() => {
      const row = jobId === undefined
        ? this.db.prepare<unknown[], JobRow>(`
          SELECT * FROM memory_jobs
          WHERE agent_id = ?
            AND status IN ('pending', 'retry')
            AND next_attempt_at_ms <= ?
            AND ${activeConversationExistsClause()}
          ORDER BY next_attempt_at_ms ASC, created_at_ms ASC, id ASC
          LIMIT 1
        `).get(agentId, at)
        : this.db.prepare<unknown[], JobRow>(`
          SELECT * FROM memory_jobs
          WHERE agent_id = ?
            AND id = ?
            AND status IN ('pending', 'retry')
            AND next_attempt_at_ms <= ?
            AND ${activeConversationExistsClause()}
        `).get(agentId, jobId, at);
      if (row === undefined) return null;
      const claimed = this.db.prepare(`
        UPDATE memory_jobs
        SET status = 'running', attempts = attempts + 1, updated_at_ms = ?
        WHERE agent_id = ? AND id = ? AND status IN ('pending', 'retry')
          AND ${activeConversationExistsClause()}
      `)
        .run(at, agentId, row.id);
      if (claimed.changes !== 1) return null;
      return requiredRow(this.db.prepare<unknown[], JobRow>("SELECT * FROM memory_jobs WHERE agent_id = ? AND id = ?").get(agentId, row.id), "job de memória reivindicado não encontrado");
    });
    const row = result();
    return row === null ? null : fromJobRow(row);
  }

  completeJob(agentId: string, jobId: string, at = this.nowFn()): MemoryJob | null {
    return this.updateJob(agentId, jobId, "complete", at);
  }

  retryJob(agentId: string, jobId: string, error: MemoryJobError = {}, at = this.nowFn(), policy: MemoryJobRetryPolicy = {}): MemoryJob | null {
    assertAgentId(agentId);
    assertMemoryId(jobId);
    this.ensureOpen();
    // Read-decide-write under one transaction so two racing workers cannot both
    // reschedule past maxAttempts on the same connection.
    const outcome = this.runTransaction((): "dead" | "retried" | null => {
      const row = this.db.prepare<unknown[], { attempts: number }>("SELECT attempts FROM memory_jobs WHERE agent_id = ? AND id = ?").get(agentId, jobId);
      if (row === undefined) return null;
      const maxAttempts = policy.maxAttempts ?? 3;
      const backoffMs = policy.backoffMs ?? [5_000, 30_000, 300_000];
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts inválido");
      if (!Array.isArray(backoffMs) || backoffMs.length === 0 || backoffMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) {
        throw new Error("backoffMs inválido");
      }
      if (row.attempts >= maxAttempts) return "dead";
      const attemptIndex = Math.max(0, Math.min(row.attempts - 1, backoffMs.length - 1));
      const delay = backoffMs[attemptIndex]!;
      this.db.prepare("UPDATE memory_jobs SET status = 'retry', next_attempt_at_ms = ?, last_error_code = ?, last_error_text = ?, updated_at_ms = ? WHERE agent_id = ? AND id = ? AND status = 'running'")
        .run(at + delay, safeError(error.code ?? "retry", this.policyOptions()), safeError(error.text, this.policyOptions()), at, agentId, jobId);
      return "retried";
    });
    if (outcome === null) return null;
    if (outcome === "dead") return this.deadJob(agentId, jobId, error, at);
    return this.getJob(agentId, jobId);
  }

  deadJob(agentId: string, jobId: string, error: MemoryJobError = {}, at = this.nowFn()): MemoryJob | null {
    assertAgentId(agentId);
    assertMemoryId(jobId);
    this.ensureOpen();
    // Terminal states are sticky: a late error callback must never flip a
    // complete job back to dead (it would regress getLatestCompletedJobBoundary).
    this.db.prepare("UPDATE memory_jobs SET status = 'dead', last_error_code = ?, last_error_text = ?, updated_at_ms = ? WHERE agent_id = ? AND id = ? AND status IN ('pending', 'retry', 'running')")
      .run(safeError(error.code ?? "dead", this.policyOptions()), safeError(error.text, this.policyOptions()), at, agentId, jobId);
    return this.getJob(agentId, jobId);
  }

  cancelConversationJobs(agentId: string, conversationId: string, error: MemoryJobError = {}, at = this.nowFn()): number {
    assertAgentId(agentId);
    assertConversationId(conversationId);
    this.ensureOpen();
    return this.db.prepare(`
      UPDATE memory_jobs
      SET status = 'dead', last_error_code = ?, last_error_text = ?, updated_at_ms = ?
      WHERE agent_id = ? AND conversation_id = ? AND status IN ('pending', 'retry', 'running')
    `).run(
      safeError(error.code ?? "conversation_archived", this.policyOptions()),
      safeError(error.text ?? "conversation archived", this.policyOptions()),
      at,
      agentId,
      conversationId,
    ).changes;
  }

  getJob(agentId: string, jobId: string): MemoryJob | null {
    const row = this.db.prepare<unknown[], JobRow>("SELECT * FROM memory_jobs WHERE agent_id = ? AND id = ?").get(agentId, jobId);
    return row === undefined ? null : fromJobRow(row);
  }

  getLatestCompletedJobBoundary(agentId: string, conversationId: string, output: "summary" | "memory"): number | null {
    assertAgentId(agentId);
    assertConversationId(conversationId);
    this.ensureOpen();
    const column = output === "summary" ? "summary_requested" : "memory_requested";
    const row = this.db.prepare<unknown[], { boundary: number | null }>(`
      SELECT MAX(through_sequence_id) AS boundary
      FROM memory_jobs
      WHERE agent_id = ? AND conversation_id = ? AND status = 'complete' AND ${column} = 1
    `).get(agentId, conversationId);
    return typeof row?.boundary === "number" ? row.boundary : null;
  }

  private updateJob(agentId: string, jobId: string, status: MemoryJobStatus, at: number): MemoryJob | null {
    assertAgentId(agentId);
    assertMemoryId(jobId);
    ensureJobStatus(status);
    this.ensureOpen();
    this.db.prepare("UPDATE memory_jobs SET status = ?, updated_at_ms = ? WHERE agent_id = ? AND id = ? AND status = 'running'").run(status, at, agentId, jobId);
    return this.getJob(agentId, jobId);
  }

  listJobs(agentId: string, options: { status?: MemoryJobStatus | readonly MemoryJobStatus[]; limit?: number } = {}): readonly MemoryJob[] {
    assertAgentId(agentId);
    this.ensureOpen();
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit de jobs inválido");
    const statuses = options.status === undefined ? undefined : (Array.isArray(options.status) ? options.status : [options.status]);
    for (const status of statuses ?? []) ensureJobStatus(status);
    const args: unknown[] = [agentId];
    let clause = "agent_id = ?";
    if (statuses !== undefined && statuses.length > 0) {
      clause += ` AND status IN (${statuses.map(() => "?").join(",")})`;
      args.push(...statuses);
    }
    const rows = this.db.prepare<unknown[], JobRow>(`SELECT * FROM memory_jobs WHERE ${clause} ORDER BY created_at_ms ASC, id ASC LIMIT ?`).all(...args, limit);
    return rows.map(fromJobRow);
  }

  getStatusCounts(agentId: string, options: { deadSampleLimit?: number } = {}): MemoryStatusCounts {
    assertAgentId(agentId);
    this.ensureOpen();
    const now = this.nowFn();
    this.expireDue(agentId, now);
    const deadSampleLimit = options.deadSampleLimit ?? 10;
    if (!Number.isInteger(deadSampleLimit) || deadSampleLimit < 0 || deadSampleLimit > 100) {
      throw new Error("deadSampleLimit inválido");
    }
    const memoryRow = this.db.prepare<{ agentId: string; now: number }, { active?: number; pinned?: number; inactive?: number }>(`
      SELECT
        SUM(CASE
          WHEN status = 'active'
            AND valid_from_ms <= @now
            AND (valid_to_ms IS NULL OR valid_to_ms > @now)
            AND (expires_at_ms IS NULL OR expires_at_ms > @now)
          THEN 1 ELSE 0 END) AS active,
        SUM(CASE
          WHEN pinned = 1
            AND status = 'active'
            AND valid_from_ms <= @now
            AND (valid_to_ms IS NULL OR valid_to_ms > @now)
            AND (expires_at_ms IS NULL OR expires_at_ms > @now)
          THEN 1 ELSE 0 END) AS pinned,
        SUM(CASE
          WHEN valid_from_ms <= @now
            AND (
              status <> 'active'
              OR (valid_to_ms IS NOT NULL AND valid_to_ms <= @now)
              OR (expires_at_ms IS NOT NULL AND expires_at_ms <= @now)
            )
          THEN 1 ELSE 0 END) AS inactive
      FROM agent_memories
      WHERE agent_id = @agentId
        AND NOT EXISTS (
          SELECT 1
          FROM agent_conversations AS c
          WHERE c.id = agent_memories.source_conversation_id
            AND c.agent_id = agent_memories.agent_id
            AND c.temporary = 1
        )
    `).get({ agentId, now });
    const jobRow = this.db.prepare<unknown[], { pending?: number; running?: number; retry?: number; dead?: number }>(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retry,
        SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
      FROM memory_jobs
      WHERE agent_id = ?
        AND ${activeConversationExistsClause()}
    `).get(agentId);
    const deadSample = deadSampleLimit === 0
      ? []
      : this.db.prepare<unknown[], {
        id: string;
        conversation_id: string;
        attempts: number;
        last_error_code: string | null;
      }>(`
        SELECT id, conversation_id, attempts, last_error_code
        FROM memory_jobs
        WHERE agent_id = ? AND status = 'dead'
          AND ${activeConversationExistsClause()}
        ORDER BY updated_at_ms DESC, id DESC
        LIMIT ?
      `).all(agentId, deadSampleLimit).map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        attempts: row.attempts,
        lastErrorCode: row.last_error_code,
      }));
    return {
      active: countValue(memoryRow?.active),
      pinned: countValue(memoryRow?.pinned),
      inactive: countValue(memoryRow?.inactive),
      jobs: {
        pending: countValue(jobRow?.pending),
        running: countValue(jobRow?.running),
        retry: countValue(jobRow?.retry),
        dead: countValue(jobRow?.dead),
        deadSample,
      },
    };
  }

  listRunnableJobs(at = this.nowFn(), limit = 100): readonly MemoryJob[] {
    this.ensureOpen();
    if (!Number.isSafeInteger(at) || at < 0) throw new Error("timestamp inválido");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit de jobs inválido");
    const rows = this.db.prepare<unknown[], JobRow>(`
      WITH runnable AS (
        SELECT
          id,
          agent_id,
          conversation_id,
          provider,
          model,
          from_sequence_id,
          through_sequence_id,
          summary_requested,
          memory_requested,
          status,
          attempts,
          next_attempt_at_ms,
          last_error_code,
          last_error_text,
          created_at_ms,
          updated_at_ms,
          ROW_NUMBER() OVER (
            PARTITION BY agent_id
            ORDER BY next_attempt_at_ms ASC, created_at_ms ASC, id ASC
          ) AS agent_rank
        FROM memory_jobs
        WHERE status IN ('pending', 'retry')
          AND next_attempt_at_ms <= ?
          AND ${activeConversationExistsClause()}
      )
      SELECT
        id,
        agent_id,
        conversation_id,
        provider,
        model,
        from_sequence_id,
        through_sequence_id,
        summary_requested,
        memory_requested,
        status,
        attempts,
        next_attempt_at_ms,
        last_error_code,
        last_error_text,
        created_at_ms,
        updated_at_ms
      FROM runnable
      ORDER BY agent_rank ASC, next_attempt_at_ms ASC, created_at_ms ASC, id ASC
      LIMIT ?
    `).all(at, limit);
    return rows.map(fromJobRow);
  }

  resetRunningJobs(at = this.nowFn()): number {
    this.ensureOpen();
    return this.db.prepare("UPDATE memory_jobs SET status = 'pending', next_attempt_at_ms = ?, updated_at_ms = ? WHERE status = 'running'").run(at, at).changes;
  }

  rebuildFts(): void {
    this.ensureOpen();
    this.runTransaction(() => {
      rebuildOpenBotFts(this.db, this.nowFn());
    });
  }

  deleteConversationDerived(agentId: string, conversationId: string, policy: MemoryDeletePolicy): void {
    assertAgentId(agentId);
    assertConversationId(conversationId);
    if (policy !== "delete-derived" && policy !== "retain") throw new Error("memory delete policy inválida");
    this.ensureOpen();
    const target = this.db.prepare<unknown[], { agent_id: string }>("SELECT agent_id FROM agent_conversations WHERE id = ?").get(conversationId);
    if (target !== undefined && target.agent_id !== agentId) throw new Error("conversation não pertence ao agente");
    this.runTransaction(() => {
      this.db.prepare("DELETE FROM memory_jobs WHERE agent_id = ? AND conversation_id = ?").run(agentId, conversationId);
      if (policy === "retain") {
        this.db.prepare("UPDATE conversation_summaries SET retained = 1 WHERE agent_id = ? AND conversation_id = ?").run(agentId, conversationId);
        return;
      }
      this.db.prepare("DELETE FROM conversation_summaries WHERE agent_id = ? AND conversation_id = ?").run(agentId, conversationId);
      const rows = this.db.prepare<unknown[], MemoryRow>("SELECT * FROM agent_memories WHERE agent_id = ? AND status = 'active'").all(agentId);
      for (const row of rows) {
        const memory = fromMemoryRow(row);
        const refs = memory.sourceEntryIds;
        const hasOtherRef = refs.some((ref) => {
          const source = sourceConversation(ref);
          return source !== null && source !== conversationId;
        });
        const hasTargetRef = refs.some((ref) => sourceConversation(ref) === conversationId);
        if (memory.sourceConversationId === conversationId && !hasOtherRef) {
          this.forgetMemory(agentId, memory.id, { kind: "admin" }, "conversation-deleted");
          continue;
        }
        if (memory.sourceConversationId === conversationId || hasTargetRef) {
          const kept = refs.filter((ref) => sourceConversation(ref) !== conversationId);
          const nextConversation = kept.map(sourceConversation).find((source): source is string => source !== null) ?? (memory.sourceConversationId === conversationId ? null : memory.sourceConversationId);
          if (nextConversation === null && kept.length === 0) {
            this.forgetMemory(agentId, memory.id, { kind: "admin" }, "conversation-deleted");
            continue;
          }
          const updatedAtMs = this.nowFn();
          this.db.prepare("UPDATE agent_memories SET source_conversation_id = ?, source_entry_ids_json = ?, revision = revision + 1, updated_at_ms = ? WHERE agent_id = ? AND id = ?")
            .run(nextConversation, json(kept), updatedAtMs, agentId, memory.id);
          this.recordRevision({ ...memory, sourceConversationId: nextConversation, sourceEntryIds: kept, revision: memory.revision + 1, updatedAtMs }, "conversation-deleted");
        }
      }
    });
  }

  snapshotAgent(agentId: string): MemoryAgentSnapshot {
    assertAgentId(agentId);
    this.ensureOpen();
    const settingsRow = this.db.prepare<unknown[], { agent_id: string; mode: string; updated_at_ms: number }>("SELECT agent_id, mode, updated_at_ms FROM agent_memory_settings WHERE agent_id = ?").get(agentId);
    let settings: MemorySettings | null = null;
    if (settingsRow !== undefined) {
      const mode = settingsRow.mode;
      ensureMode(mode);
      settings = { agentId: settingsRow.agent_id, mode, updatedAtMs: settingsRow.updated_at_ms };
    }
    const memories = this.db.prepare<unknown[], MemoryRow>("SELECT * FROM agent_memories WHERE agent_id = ? ORDER BY created_at_ms ASC, id ASC").all(agentId);
    const revisions = this.db.prepare<unknown[], RevisionRow>("SELECT r.* FROM memory_revisions r JOIN agent_memories m ON m.id = r.memory_id WHERE m.agent_id = ? ORDER BY r.id ASC").all(agentId);
    const summaries = this.db.prepare<unknown[], SummaryRow>("SELECT * FROM conversation_summaries WHERE agent_id = ? ORDER BY conversation_id ASC").all(agentId);
    const jobs = this.db.prepare<unknown[], JobRow>("SELECT * FROM memory_jobs WHERE agent_id = ? ORDER BY created_at_ms ASC, id ASC").all(agentId);
    return {
      settings,
      memories: memories.map(fromMemoryRow),
      revisions: revisions.map(fromRevisionRow),
      summaries: summaries.map(fromSummaryRow),
      jobs: jobs.map(fromJobRow),
    };
  }

  restoreAgent(agentId: string, snapshot: MemoryAgentSnapshot): void {
    assertAgentId(agentId);
    this.ensureOpen();
    this.transaction(() => this.restoreAgentRows(agentId, snapshot));
  }

  clearAgentRows(agentId: string): void {
    assertAgentId(agentId);
    this.db.prepare("DELETE FROM conversation_summaries WHERE agent_id = ?").run(agentId);
    this.db.prepare("DELETE FROM memory_jobs WHERE agent_id = ?").run(agentId);
    this.db.prepare("DELETE FROM agent_memory_settings WHERE agent_id = ?").run(agentId);
    this.db.prepare("DELETE FROM agent_memories WHERE agent_id = ?").run(agentId);
  }

  private validateSnapshotCore(agentId: string, snapshot: MemoryAgentSnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.memories) || !Array.isArray(snapshot.revisions) || !Array.isArray(snapshot.summaries) || !Array.isArray(snapshot.jobs)) {
      throw new Error("snapshot de memória inválido");
    }
    if (snapshot.settings !== null) {
      if (snapshot.settings.agentId !== agentId) throw new Error("snapshot contém settings de outro agente");
      ensureMode(snapshot.settings.mode);
      assertSafeTimestamp(snapshot.settings.updatedAtMs, "updatedAtMs");
    }
    const memoryIds = new Set<string>();
    const activeKeys = new Set<string>();
    for (const memory of snapshot.memories) {
      if (memory.agentId !== agentId) throw new Error("snapshot contém memória de outro agente");
      assertMemoryId(memory.id);
      if (memoryIds.has(memory.id)) throw new Error("snapshot contém memória duplicada");
      memoryIds.add(memory.id);
      const foreignMemory = this.db.prepare<unknown[], { present?: number }>("SELECT 1 AS present FROM agent_memories WHERE id = ? AND agent_id <> ?").get(memory.id, agentId);
      if (foreignMemory?.present === 1) throw new Error("snapshot colide com memória de outro agente");
      ensureStatus(memory.status);
      ensureKind(memory.kind);
      ensureTrust(memory.trust);
      if (typeof memory.pinned !== "boolean") throw new Error("pinned inválido");
      if (!Number.isInteger(memory.importance) || memory.importance < 0 || memory.importance > 100) throw new Error("importance inválida");
      if (!Number.isFinite(memory.confidence) || memory.confidence < 0 || memory.confidence > 1) throw new Error("confidence inválida");
      assertSafeTimestamp(memory.validFromMs, "validFromMs");
      assertOptionalSafeTimestamp(memory.validToMs, "validToMs");
      assertOptionalSafeTimestamp(memory.expiresAtMs, "expiresAtMs");
      if (memory.validToMs !== null && memory.validToMs < memory.validFromMs) throw new Error("validToMs inválido");
      assertSafeTimestamp(memory.createdAtMs, "createdAtMs");
      assertSafeTimestamp(memory.updatedAtMs, "updatedAtMs");
      if (!Number.isSafeInteger(memory.revision) || memory.revision < 1) throw new Error("revision inválida");
      if (memory.supersededBy !== null) assertMemoryId(memory.supersededBy);
      const source = normalizeSources(memory.sourceEntryIds);
      validateMemoryCandidate({
        kind: memory.kind,
        canonicalKey: memory.canonicalKey,
        text: memory.text,
        valueJson: memory.valueJson,
        trust: memory.trust,
        importance: memory.importance,
        confidence: memory.confidence,
        pinned: memory.pinned,
        sourceConversationId: memory.sourceConversationId,
        sourceEntryIds: source,
        validFromMs: memory.validFromMs,
        validToMs: memory.validToMs,
        expiresAtMs: memory.expiresAtMs,
      }, this.policyOptions());
      if (memory.status === "active") {
        const key = normalizeCanonicalKey(memory.canonicalKey);
        if (activeKeys.has(key)) throw new Error("snapshot contém canonicalKey ativo duplicado");
        activeKeys.add(key);
      }
    }
    const revisionIds = new Set<number>();
    const revisionPairs = new Set<string>();
    for (const revision of snapshot.revisions) {
      if (!memoryIds.has(revision.memoryId)) throw new Error("snapshot contém revision órfã");
      if (!Number.isSafeInteger(revision.id) || revision.id < 1 || !Number.isSafeInteger(revision.revision) || revision.revision < 1) throw new Error("revision inválida");
      if (revisionIds.has(revision.id) || revisionPairs.has(`${revision.memoryId}:${revision.revision}`)) throw new Error("snapshot contém revision duplicada");
      revisionIds.add(revision.id);
      revisionPairs.add(`${revision.memoryId}:${revision.revision}`);
      const foreignRevision = this.db.prepare<unknown[], { present?: number }>(`
        SELECT 1 AS present FROM memory_revisions AS r
        JOIN agent_memories AS m ON m.id = r.memory_id
        WHERE r.id = ? AND m.agent_id <> ?
      `).get(revision.id, agentId);
      if (foreignRevision?.present === 1) throw new Error("snapshot colide com revision de outro agente");
      assertSafeTimestamp(revision.createdAtMs, "createdAtMs");
      if (typeof revision.reason !== "string" || revision.reason.length > 2_000) throw new Error("reason inválido");
      assertNoSensitiveMemoryContent(`${revision.reason}\n${json(revision.snapshotJson)}`, this.policyOptions());
      assertNoMemoryInstructionContent(revision.reason);
      if (!isRecord(revision.snapshotJson)) throw new Error("snapshot de revision inválido");
      const candidate = revision.snapshotJson;
      if (candidate.agentId !== undefined && candidate.agentId !== agentId) throw new Error("snapshot de revision contém agente incorreto");
      if (candidate.id !== undefined && candidate.id !== revision.memoryId) throw new Error("snapshot de revision contém memória incorreta");
      const source = candidate.sourceEntryIds === undefined
        ? []
        : normalizeSources(candidate.sourceEntryIds);
      ensureKind(candidate.kind);
      ensureTrust(candidate.trust);
      if (typeof candidate.canonicalKey !== "string" || typeof candidate.text !== "string") throw new Error("snapshot de revision inválido");
      if (candidate.sourceConversationId !== undefined && candidate.sourceConversationId !== null && typeof candidate.sourceConversationId !== "string") {
        throw new Error("sourceConversationId de revision inválido");
      }
      validateMemoryCandidate({
        kind: candidate.kind,
        canonicalKey: candidate.canonicalKey,
        text: candidate.text,
        valueJson: candidate.valueJson,
        trust: candidate.trust,
        sourceConversationId: candidate.sourceConversationId,
        sourceEntryIds: source,
      }, this.policyOptions());
    }
    const summaryConversations = new Set<string>();
    for (const summary of snapshot.summaries) {
      if (summary.agentId !== agentId) throw new Error("snapshot contém summary de outro agente");
      if (summaryConversations.has(summary.conversationId)) throw new Error("snapshot contém summary duplicado");
      summaryConversations.add(summary.conversationId);
      assertConversationId(summary.conversationId);
      if (typeof summary.retained !== "boolean") throw new Error("summary retained inválido");
      if (!Number.isSafeInteger(summary.revision) || summary.revision < 1 || !Number.isSafeInteger(summary.throughSequenceId) || summary.throughSequenceId < 0) throw new Error("summary inválido");
      assertSafeTimestamp(summary.updatedAtMs, "updatedAtMs");
      if (typeof summary.renderedText !== "string" || summary.renderedText.trim().length === 0 || bytes(summary.renderedText) > MEMORY_POLICY_LIMITS.renderedSummaryBytes) throw new Error("renderedText inválido");
      const renderedJson = json(summary.summaryJson);
      if (bytes(renderedJson) > MEMORY_POLICY_LIMITS.valueJsonBytes) throw new Error("summaryJson excede o limite");
      assertValidSummaryContent(summary.renderedText, summary.summaryJson, this.policyOptions());
    }
    const jobIds = new Set<string>();
    const jobKeys = new Set<string>();
    for (const job of snapshot.jobs) {
      if (job.agentId !== agentId) throw new Error("snapshot contém job de outro agente");
      assertMemoryId(job.id);
      if (jobIds.has(job.id) || jobKeys.has(`${job.conversationId}:${job.throughSequenceId}`)) throw new Error("snapshot contém job duplicado");
      jobIds.add(job.id);
      jobKeys.add(`${job.conversationId}:${job.throughSequenceId}`);
      const foreignJob = this.db.prepare<unknown[], { present?: number }>("SELECT 1 AS present FROM memory_jobs WHERE id = ? AND agent_id <> ?").get(job.id, agentId);
      if (foreignJob?.present === 1) throw new Error("snapshot colide com job de outro agente");
      assertConversationId(job.conversationId);
      ensureJobStatus(job.status);
      if (!Number.isSafeInteger(job.fromSequenceId) || job.fromSequenceId < 0 || !Number.isSafeInteger(job.throughSequenceId) || job.throughSequenceId < job.fromSequenceId || !Number.isSafeInteger(job.attempts) || job.attempts < 0) throw new Error("job inválido");
      if (job.summaryRequested !== undefined && typeof job.summaryRequested !== "boolean") throw new Error("summaryRequested de job inválido");
      if (job.memoryRequested !== undefined && typeof job.memoryRequested !== "boolean") throw new Error("memoryRequested de job inválido");
      if (job.summaryRequested === false && job.memoryRequested === false) throw new Error("job sem saída solicitada");
      if (typeof job.provider !== "string" || job.provider.trim().length === 0) throw new Error("provider de job inválido");
      if (typeof job.model !== "string" || job.model.trim().length === 0) throw new Error("model de job inválido");
      if (job.reasoningEffort !== undefined && !REASONING_EFFORTS.includes(job.reasoningEffort)) throw new Error("reasoningEffort de job inválido");
      assertSafeTimestamp(job.nextAttemptAtMs, "nextAttemptAtMs");
      assertSafeTimestamp(job.createdAtMs, "createdAtMs");
      assertSafeTimestamp(job.updatedAtMs, "updatedAtMs");
      for (const error of [job.lastErrorCode, job.lastErrorText]) {
        if (error !== null && (typeof error !== "string" || error.length > 2_000)) throw new Error("erro de job inválido");
        if (error !== null) assertNoSensitiveMemoryContent(error, this.policyOptions());
      }
    }
  }

  private validateSnapshotConversationRefs(
    agentId: string,
    snapshot: MemoryAgentSnapshot,
    assertConversation: (conversationId: string) => void,
  ): void {
    for (const memory of snapshot.memories) {
      const source = normalizeSources(memory.sourceEntryIds);
      if (memory.sourceConversationId !== null) assertConversation(memory.sourceConversationId);
      for (const ref of source) {
        if (typeof ref !== "string") assertConversation(ref.conversationId);
      }
    }
    for (const summary of snapshot.summaries) {
      if (!summary.retained) assertConversation(summary.conversationId);
    }
    for (const job of snapshot.jobs) {
      assertConversation(job.conversationId);
    }
  }

  validateAgentSnapshot(agentId: string, snapshot: MemoryAgentSnapshot): void {
    assertAgentId(agentId);
    this.validateSnapshotCore(agentId, snapshot);
  }

  validateAgentRows(agentId: string, snapshot: MemoryAgentSnapshot): void {
    this.validateAgentSnapshot(agentId, snapshot);
  }

  restoreAgentRows(agentId: string, snapshot: MemoryAgentSnapshot, rebuildFts = true): void {
    assertAgentId(agentId);
    this.validateAgentRows(agentId, snapshot);
    this.validateSnapshotConversationRefs(agentId, snapshot, (conversationId) => {
      this.validateConversation(agentId, conversationId, true);
    });
    this.clearAgentRows(agentId);
    if (snapshot.settings !== null) {
      if (snapshot.settings.agentId !== agentId) throw new Error("snapshot contém settings de outro agente");
      ensureMode(snapshot.settings.mode);
      this.db.prepare("INSERT INTO agent_memory_settings(agent_id, mode, updated_at_ms) VALUES (?, ?, ?)").run(agentId, snapshot.settings.mode, snapshot.settings.updatedAtMs);
    }
    for (const memory of snapshot.memories) {
      if (memory.agentId !== agentId) throw new Error("snapshot contém memória de outro agente");
      const source = normalizeSources(memory.sourceEntryIds);
      if (memory.sourceConversationId !== null) this.validateConversation(agentId, memory.sourceConversationId, true);
      for (const ref of source) {
        if (typeof ref !== "string") this.validateConversation(agentId, ref.conversationId, true);
      }
      assertNoSensitiveMemoryContent(`${memory.canonicalKey}\n${memory.text}\n${json(memory.valueJson)}\n${json(source)}`, this.policyOptions());
      this.db.prepare(`
        INSERT INTO agent_memories(id, agent_id, kind, canonical_key, text, value_json, trust, status, importance, confidence, pinned, source_conversation_id, source_entry_ids_json, valid_from_ms, valid_to_ms, expires_at_ms, superseded_by, revision, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(memory.id, agentId, memory.kind, normalizeCanonicalKey(memory.canonicalKey), memory.text, memory.valueJson === null ? null : json(memory.valueJson), memory.trust, memory.status, memory.importance, memory.confidence, memory.pinned ? 1 : 0, memory.sourceConversationId, json(source), memory.validFromMs, memory.validToMs, memory.expiresAtMs, memory.supersededBy, memory.revision, memory.createdAtMs, memory.updatedAtMs);
    }
    for (const revision of snapshot.revisions) {
      if (!snapshot.memories.some((memory) => memory.id === revision.memoryId)) throw new Error("snapshot contém revision órfã");
      assertNoSensitiveMemoryContent(json(revision.snapshotJson), this.policyOptions());
      this.db.prepare("INSERT INTO memory_revisions(id, memory_id, revision, snapshot_json, reason, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)").run(revision.id, revision.memoryId, revision.revision, json(revision.snapshotJson), safeError(revision.reason, this.policyOptions()) ?? "memory-change", revision.createdAtMs);
    }
    for (const summary of snapshot.summaries) {
      if (summary.agentId !== agentId) throw new Error("snapshot contém summary de outro agente");
      if (!summary.retained) this.validateConversation(agentId, summary.conversationId, true);
      assertValidSummaryContent(summary.renderedText, summary.summaryJson, this.policyOptions());
      this.db.prepare("INSERT INTO conversation_summaries(conversation_id, agent_id, revision, through_sequence_id, summary_json, rendered_text, updated_at_ms, retained) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(summary.conversationId, agentId, summary.revision, summary.throughSequenceId, json(summary.summaryJson), summary.renderedText, summary.updatedAtMs, summary.retained ? 1 : 0);
    }
    for (const job of snapshot.jobs) {
      if (job.agentId !== agentId) throw new Error("snapshot contém job de outro agente");
      this.validateConversation(agentId, job.conversationId, true);
      this.db.prepare("INSERT INTO memory_jobs(id, agent_id, conversation_id, provider, model, reasoning_effort, from_sequence_id, through_sequence_id, summary_requested, memory_requested, status, attempts, next_attempt_at_ms, last_error_code, last_error_text, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(job.id, agentId, job.conversationId, job.provider, job.model, job.reasoningEffort ?? null, job.fromSequenceId, job.throughSequenceId, job.summaryRequested === false ? 0 : 1, job.memoryRequested === false ? 0 : 1, job.status, job.attempts, job.nextAttemptAtMs, job.lastErrorCode, job.lastErrorText, job.createdAtMs, job.updatedAtMs);
    }
    if (rebuildFts) this.rebuildFts();
  }

  clear(agentId: string): void {
    assertAgentId(agentId);
    this.ensureOpen();
    this.transaction(() => this.clearAgentRows(agentId));
  }

  transaction<T>(fn: () => T): T {
    this.ensureOpen();
    return this.runTransaction(fn);
  }

  close(): void {
    if (this.closed) return;
    if (this.ownsDatabase) this.db.close();
    this.closed = true;
  }
}
