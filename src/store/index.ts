import Database from "better-sqlite3";
import { createPromptQueue, type PromptQueueStore } from "./prompt-queue.js";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeTranscriptEntry, type TranscriptEntry, type SandTranscriptPage } from "../shared/contracts.js";
import type {
  RecentEntriesOptions,
  KickstartRunRecord,
  TranscriptAgentSnapshot,
  TranscriptInteractionDecision,
  TranscriptStore,
  TurnAttemptPhase,
  TurnAttemptRecord,
  TurnOutcome,
} from "../rpc/send.js";
import { ensureDefaultConversation, ensureOpenBotSchema, validateAgentId, type ConversationRow } from "./schema.js";
import { windowsPowerShellPath } from "../shared/windows-tools.js";
import { SqliteConversationStore } from "../conversations/store.js";
import { SqliteMemoryStore } from "../memory/sqlite-store.js";
import type { MemoryAgentSnapshot } from "../memory/types.js";
import { utf8Prefix } from "../shared/utf8.js";
export const DEFAULT_TRANSCRIPT_PAGE_LIMIT = 50;
export const MAX_TRANSCRIPT_PAGE_LIMIT = 1000;
const MAX_KICKSTART_RESULT_BYTES = 4 * 1024;
const MAX_KICKSTART_ERROR_BYTES = 2 * 1024;

export function defaultStoreDir(): string {
  const explicitRoot = process.env.OPENBOT_DATA_ROOT?.trim();
  if (explicitRoot) return explicitRoot;
  const appData = process.env.APPDATA;
  if (appData && appData.length > 0) return path.join(appData, "OpenBot");
  return path.join(os.homedir(), "AppData", "Roaming", "OpenBot");
}

export function defaultStorePath(): string {
  return path.join(defaultStoreDir(), "store.db");
}

export interface SqliteTranscriptStoreOptions {
  /** SQLite filename; `:memory:` is useful for isolated tests. */
  path: string;
  /** Borrow an already-open SQLite connection; close() then becomes a no-op for the database. */
  database?: Database.Database;
  currentProcessIdentity?: ProcessIdentity;
  processIdentity?: (pid: number) => ProcessIdentity | null;
  conversationStore?: SqliteConversationStore;
  memoryStore?: SqliteMemoryStore;
  /** Known sensitive values (e.g. keystore-held credentials) the default memory store must reject. */
  secretValues?: () => readonly string[];
}

export interface ProcessIdentity {
  startedAtMs: number;
  executablePath: string;
}

export interface TranscriptPage extends SandTranscriptPage {}

export interface ConversationOutline {
  title: string | null;
  lastMessage: string | null;
}

export interface InteractionDecision {
  agentId: string;
  requestId: string;
  kind: string;
  decision: string;
  createdAtMs: number;
}

export interface SqliteConversationSnapshot {
  id: string;
  agentId: string;
  title: string;
  titleSource: "auto" | "manual";
  temporary: boolean;
  archivedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  lastMessageAtMs: number | null;
}

export interface SqliteTranscriptRowSnapshot {
  sequenceId: number;
  agentId: string;
  conversationId: string | null;
  entryId: string | null;
  kind: string;
  payloadJson: string;
  createdAtMs: number;
}

export interface SqliteNonceRowSnapshot {
  agentId: string;
  conversationId: string | null;
  nonce: string;
  acceptedAtMs: number;
}

export interface SqliteInteractionDecisionRowSnapshot {
  id: number;
  agentId: string;
  conversationId: string | null;
  requestId: string;
  kind: string;
  decision: string;
  metadataJson: string | null;
  createdAtMs: number;
}

export interface SqliteTurnAttemptRowSnapshot {
  turnId: string;
  agentId: string;
  conversationId: string | null;
  clientNonce: string | null;
  retryOfClientNonce: string | null;
  retryFailureTurnId: string | null;
  provider: string;
  model: string;
  phase: TurnAttemptPhase;
  startedAtMs: number;
}

export interface SqliteTurnCompletionRowSnapshot {
  agentId: string;
  conversationId: string | null;
  clientNonce: string;
  turnId: string;
  outcome?: TurnOutcome;
  completedAtMs: number;
}

/** Full SQLite rollback snapshot, including conversation domain and bound rows. */
export interface SqliteTranscriptAgentSnapshot extends TranscriptAgentSnapshot {
  promptQueueRows?: Array<{ sequence: number; agent_id: string; conversation_id: string; nonce: string; args_json: string; inference_json: string; state: string; payload_digest?: string; payload_compacted?: number; recovery_of?: string | null }>;
  conversations: SqliteConversationSnapshot[];
  activeConversationId: string | null;
  transcriptRows: SqliteTranscriptRowSnapshot[];
  acceptedNonceRows: SqliteNonceRowSnapshot[];
  pendingNonceRows: SqliteNonceRowSnapshot[];
  interactionDecisionRows: SqliteInteractionDecisionRowSnapshot[];
  turnAttemptRows: SqliteTurnAttemptRowSnapshot[];
  turnCompletionRows: SqliteTurnCompletionRowSnapshot[];
  kickstartRuns: KickstartRunRecord[];
  memorySnapshot?: MemoryAgentSnapshot;
}

type EntryRow = {
  payload_json: string;
};

type PageRow = EntryRow & {
  sequence_id: number;
};

/** 64 MiB: after a large transaction the WAL file shrinks back instead of keeping its peak size. */
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

type PresenceRow = { present?: number };
type TurnCompletionOutcomeRow = { outcome: TurnOutcome };
type NonceRow = { nonce: string };
type ConversationIdRow = { conversation_id: string };
type InteractionDecisionRow = {
  agent_id: string;
  request_id: string;
  kind: string;
  decision: string;
  created_at_ms: number;
};

interface StoreStatements {
  getEntries: Database.Statement<unknown[], PageRow>;
  getNonces: Database.Statement<unknown[], NonceRow>;
  getInteractionDecisions: Database.Statement<unknown[], InteractionDecisionRow>;
  insertEntry: Database.Statement;
  touchConversation: Database.Statement;
  deleteEntries: Database.Statement;
  deleteNonces: Database.Statement;
  hasNonce: Database.Statement<unknown[], PresenceRow>;
  getNonceConversations: Database.Statement<unknown[], ConversationIdRow>;
  insertNonce: Database.Statement;
  insertPendingNonce: Database.Statement;
  deletePendingNonce: Database.Statement;
  deleteNonce: Database.Statement;
  trimNonces: Database.Statement;
  firstPage: Database.Statement<unknown[], PageRow>;
  nextPage: Database.Statement<unknown[], PageRow>;
  replaceEntry: Database.Statement;
  replaceToolCallByLocalId: Database.Statement;
  recentEntries: Database.Statement<unknown[], PageRow>;
  recentEntriesByKinds: Database.Statement<unknown[], PageRow>;
  latestAssistant: Database.Statement<unknown[], EntryRow>;
  openToolCalls: Database.Statement<unknown[], PageRow>;
  findToolCallByLocalId: Database.Statement<unknown[], EntryRow>;
  firstUserMessage: Database.Statement<unknown[], EntryRow>;
  latestNonEmptyMessage: Database.Statement<unknown[], EntryRow>;
  getInteractionDecision: Database.Statement<unknown[], InteractionDecisionRow>;
  insertInteractionDecision: Database.Statement;
  deleteInteractionDecisions: Database.Statement;
  insertTurnAttempt: Database.Statement;
  updateTurnAttempt: Database.Statement;
  deleteTurnAttempt: Database.Statement;
  deleteAgentTurnAttempts: Database.Statement;
  insertTurnCompletion: Database.Statement;
  hasTurnCompletion: Database.Statement<unknown[], TurnCompletionOutcomeRow>;
  deleteTurnCompletion: Database.Statement;
  deleteAgentTurnCompletions: Database.Statement;
}

type TurnAttemptRow = {
  turn_id: string;
  agent_id: string;
  conversation_id: string | null;
  client_nonce: string | null;
  retry_of_client_nonce: string | null;
  retry_failure_turn_id: string | null;
  provider: string;
  model: string;
  phase: TurnAttemptPhase;
  started_at_ms: number;
};

type KickstartRunRow = {
  agent_id: string;
  client_nonce: string;
  conversation_id: string | null;
  origin: "kickstart";
  version: number;
  attempt: number;
  turn_id: string | null;
  provider: string | null;
  model: string | null;
  status: KickstartRunRecord["status"];
  observable_output: number;
  result_json: string | null;
  error: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

type TranscriptSnapshotRow = {
  sequence_id: number;
  agent_id: string;
  conversation_id: string | null;
  entry_id: string | null;
  kind: string;
  payload_json: string;
  created_at_ms: number;
};

type BoundNonceRow = {
  agent_id: string;
  conversation_id: string | null;
  nonce: string;
  accepted_at_ms: number;
};

type InteractionDecisionSnapshotRow = InteractionDecisionRow & {
  id: number;
  conversation_id: string | null;
  metadata_json: string | null;
};

type TurnCompletionRow = {
  agent_id: string;
  conversation_id: string | null;
  client_nonce: string;
  turn_id: string;
  outcome: TurnOutcome;
  completed_at_ms: number;
};

function parseKickstartRun(row: KickstartRunRow): KickstartRunRecord {
  let result: { text: string } | undefined;
  if (row.result_json !== null) {
    try {
      const parsed: unknown = JSON.parse(row.result_json);
      if (isRecord(parsed) && typeof parsed.text === "string") result = { text: parsed.text.slice(0, 4096) };
    } catch { /* corrupt bounded result is treated as absent */ }
  }
  return {
    agentId: row.agent_id,
    clientNonce: row.client_nonce,
    ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
    origin: "kickstart",
    version: 1,
    attempt: row.attempt,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.provider === null ? {} : { provider: row.provider }),
    ...(row.model === null ? {} : { model: row.model }),
    status: row.status,
    observableOutput: row.observable_output === 1,
    ...(result === undefined ? {} : { result }),
    ...(row.error === null ? {} : { error: row.error }),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

function isOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "boolean";
}

function isAgentReference(value: unknown): boolean {
  return typeof value === "string" || (
    isRecord(value) && value.kind === "agent" && typeof value.id === "string" && typeof value.name === "string"
  );
}

function isUserReference(value: unknown): boolean {
  return typeof value === "boolean" || (
    isRecord(value) && typeof value.name === "string" && typeof value.authId === "string"
  );
}

function isSendMessagePayload(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "text":
      return isOptionalString(value, "text") && isOptionalString(value, "content");
    case "attachment":
      return isOptionalString(value, "url") && isOptionalString(value, "file_name");
    case "widget":
      return isOptionalString(value, "prompt");
    case "cursor-agent":
    case "permission-request":
      return isOptionalString(value, "title");
    case "secret-request":
      return isOptionalString(value, "label");
    case "email-draft":
      return isOptionalString(value, "subject") && isOptionalString(value, "body");
    case "slack-draft":
      return isOptionalString(value, "body");
    case "auto-review-approval":
      return value.approval === undefined || (isRecord(value.approval) && isOptionalString(value.approval, "summary"));
    case "local-tool-permission":
      return isRecord(value.ask) &&
        (value.ask.status === "pending" || value.ask.status === "expired") &&
        typeof value.ask.requestId === "string" &&
        ["run-command", "send-input", "read-file", "list-directory", "write-file"].includes(String(value.ask.action)) &&
        typeof value.ask.target === "string" &&
        (value.ask.expiresAtMs === undefined || typeof value.ask.expiresAtMs === "number");
    case "connector":
      return isOptionalString(value, "variant") && isOptionalBoolean(value, "connected");
    case "connectors":
      return true;
    case "listener-connect":
      return value.platform === undefined || value.platform === "slack" || value.platform === "github";
    default:
      return false;
  }
}

function isToolCallResult(value: unknown): boolean {
  return isRecord(value) && typeof value.ok === "boolean" &&
    isOptionalString(value, "operation") && isOptionalString(value, "code") &&
    isOptionalString(value, "memoryId") && isOptionalString(value, "canonicalKey") &&
    isOptionalString(value, "message") && isOptionalString(value, "path") &&
    isOptionalString(value, "command") &&
    (value.bytes === undefined || typeof value.bytes === "number") &&
    (value.count === undefined || typeof value.count === "number") &&
    (value.exitCode === undefined || value.exitCode === null || typeof value.exitCode === "number");
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "message":
      return typeof value.id === "string" &&
        (value.role === "user" || value.role === "assistant") &&
        typeof value.content === "string" && typeof value.timestampMs === "number" &&
        isOptionalString(value, "clientNonce") && isOptionalString(value, "turnId") &&
        isOptionalString(value, "provider") && isOptionalString(value, "model") &&
        isOptionalString(value, "retryOfClientNonce") &&
        (value.fromAgent === undefined || isAgentReference(value.fromAgent)) &&
        (value.fromUser === undefined || isUserReference(value.fromUser)) &&
        (value.toAgent === undefined || isAgentReference(value.toAgent)) &&
        isOptionalBoolean(value, "streaming") && isOptionalBoolean(value, "isStreaming") &&
        (value.completionState === undefined || value.completionState === "complete" || value.completionState === "interrupted");
    case "send-message":
      return isOptionalString(value, "id") && isSendMessagePayload(value.message) &&
        (value.author === undefined || isAgentReference(value.author)) && isOptionalBoolean(value, "streaming");
    case "user-attachment":
      return isOptionalString(value, "id") && typeof value.file_name === "string" &&
        typeof value.file_path === "string" && isOptionalString(value, "clientNonce") &&
        isOptionalString(value, "turnId") && isOptionalString(value, "extractedText") &&
        isOptionalString(value, "skipped");
    case "tool-call":
      return isOptionalString(value, "id") && typeof value.name === "string" &&
        typeof value.summary === "string" &&
        ["pending", "running", "completed", "failed"].includes(String(value.status)) &&
        (value.result === undefined || isToolCallResult(value.result));
    case "notice":
    case "event":
    case "widget":
    case "tool-request":
      return true;
    default:
      return false;
  }
}

function transcriptEntryId(entry: TranscriptEntry): string | undefined {
  return "id" in entry && typeof entry.id === "string" ? entry.id : undefined;
}

function parseEntry(payload: string): TranscriptEntry {
  const value: unknown = JSON.parse(payload);
  if (!isTranscriptEntry(value)) {
    throw new Error("store: transcript entry inválida");
  }
  return normalizeTranscriptEntry(value);
}

/** Boot reconciliation and display reads must not fail over one unreadable row; the row is left untouched. */
function tryParseEntry(payload: string): TranscriptEntry | undefined {
  try {
    return parseEntry(payload);
  } catch {
    return undefined;
  }
}

/** Display lookup: an unreadable or mismatched row reads as absent. */
function readMessageEntry(payload: string): Extract<TranscriptEntry, { kind: "message" }> | undefined {
  const entry = tryParseEntry(payload);
  return entry?.kind === "message" ? entry : undefined;
}

function readToolCallEntry(payload: string): Extract<TranscriptEntry, { kind: "tool-call" }> | undefined {
  const entry = tryParseEntry(payload);
  return entry?.kind === "tool-call" ? entry : undefined;
}

/**
 * Serializes an entry and proves it reads back. Data the reader would reject
 * (e.g. a NaN that JSON turns into null) fails this write instead of making
 * every later read of the conversation fail.
 */
function serializeEntry(entry: TranscriptEntry): string {
  const json = JSON.stringify(entry);
  if (!isTranscriptEntry(JSON.parse(json))) {
    throw new Error(`store: transcript entry inválida (${String((entry as { kind?: unknown }).kind)})`);
  }
  return json;
}

/** Stands in for an unreadable row so the rest of the conversation stays readable. */
function unreadableEntry(sequenceId: number): TranscriptEntry {
  return normalizeTranscriptEntry({
    kind: "notice",
    id: `notice:unreadable:${sequenceId}`,
    type: "unreadable-entry",
    level: "error",
    text: "Uma entrada deste histórico não pôde ser lida e foi omitida.",
  });
}

function entryCreatedAt(entry: TranscriptEntry): number {
  const record = entry as Record<string, unknown>;
  return typeof record.timestampMs === "number" && Number.isFinite(record.timestampMs) ? record.timestampMs : Date.now();
}

function entryIdOf(entry: TranscriptEntry): string | null {
  const record = entry as Record<string, unknown>;
  return typeof record.id === "string" ? record.id : null;
}

function validateConversationId(conversationId: string): void {
  if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
    throw new Error("conversationId deve ser uma string não vazia");
  }
}

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSCRIPT_PAGE_LIMIT) {
    throw new Error(`limit deve ser um inteiro entre 1 e ${MAX_TRANSCRIPT_PAGE_LIMIT}`);
  }
  return limit;
}

function isSqliteTranscriptAgentSnapshot(snapshot: TranscriptAgentSnapshot): snapshot is SqliteTranscriptAgentSnapshot {
  const candidate = snapshot as Partial<SqliteTranscriptAgentSnapshot>;
  return Array.isArray(candidate.conversations) &&
    Array.isArray(candidate.transcriptRows) &&
    Array.isArray(candidate.acceptedNonceRows) &&
    Array.isArray(candidate.pendingNonceRows) &&
    Array.isArray(candidate.interactionDecisionRows) &&
    Array.isArray(candidate.turnAttemptRows) &&
    Array.isArray(candidate.turnCompletionRows) &&
    (typeof candidate.activeConversationId === "string" || candidate.activeConversationId === null);
}

function validateBoundConversationId(
  conversationIds: ReadonlySet<string>,
  conversationId: string | null,
  label: string,
): string {
  if (conversationId === null) throw new Error(`snapshot contém ${label} sem conversationId`);
  if (!conversationIds.has(conversationId)) throw new Error(`snapshot contém ${label} com conversa inválida`);
  return conversationId;
}

function validateSnapshotMemoryConversationRefs(
  agentId: string,
  snapshot: MemoryAgentSnapshot,
  conversationIds: ReadonlySet<string>,
): void {
  const assertConversation = (conversationId: string, label: string): void => {
    if (!conversationIds.has(conversationId)) throw new Error(`snapshot contém ${label} com conversa inválida`);
  };
  for (const memory of snapshot.memories) {
    if (memory.sourceConversationId !== null) assertConversation(memory.sourceConversationId, "memória");
    for (const ref of memory.sourceEntryIds) {
      if (typeof ref !== "string") assertConversation(ref.conversationId, "memória");
    }
  }
  for (const summary of snapshot.summaries) {
    if (!summary.retained) assertConversation(summary.conversationId, "summary");
  }
  for (const job of snapshot.jobs) {
    assertConversation(job.conversationId, "job");
  }
}

interface StoreOwnership {
  token: string;
}

interface StoreOwnershipRecord {
  pid: number;
  token: string;
  process_started_at_ms: number | null;
  executable_path: string | null;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isRecord(error) && error.code === "ESRCH");
  }
}

const PROCESS_START_TOLERANCE_MS = 2_000;

function normalizeExecutablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function localProcessIdentity(): ProcessIdentity {
  return {
    startedAtMs: Math.round(Date.now() - process.uptime() * 1_000),
    executablePath: normalizeExecutablePath(process.execPath),
  };
}

function queryProcessIdentity(pid: number): ProcessIdentity | null {
  if (!isProcessAlive(pid)) return null;
  if (pid === process.pid) return localProcessIdentity();
  if (process.platform !== "win32") return null;
  const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; ` +
    `[pscustomobject]@{startedAtMs=[DateTimeOffset]::new($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();executablePath=$p.Path}|ConvertTo-Json -Compress`;
  const result = spawnSync(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3_000,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isRecord(parsed) || typeof parsed.startedAtMs !== "number" || typeof parsed.executablePath !== "string" || parsed.executablePath.length === 0) return null;
    return { startedAtMs: parsed.startedAtMs, executablePath: normalizeExecutablePath(parsed.executablePath) };
  } catch {
    return null;
  }
}

function sameProcessIdentity(record: StoreOwnershipRecord, observed: ProcessIdentity | null): boolean {
  if (observed === null || record.process_started_at_ms === null || record.executable_path === null) return false;
  return Math.abs(record.process_started_at_ms - observed.startedAtMs) <= PROCESS_START_TOLERANCE_MS &&
    normalizeExecutablePath(record.executable_path) === normalizeExecutablePath(observed.executablePath);
}


export class SqliteTranscriptStore implements TranscriptStore {
  readonly promptQueue: PromptQueueStore;
  private readonly db: Database.Database;
  private readonly ownsDatabase: boolean;
  readonly path: string;
  readonly conversationStore: SqliteConversationStore;
  readonly memoryStore: SqliteMemoryStore;
  private readonly statements: StoreStatements;
  /** Cached by resolveConversationId; lives as long as the db connection. */
  private conversationExistsStmt: Database.Statement<unknown[], { id: string }> | null = null;
  /** Cached direct lookups (nonce echo / retryable notice); see those methods. */
  private userEchoByNonceStmt: Database.Statement<unknown[], EntryRow> | null = null;
  private retryableNoticeStmt: Database.Statement<unknown[], EntryRow> | null = null;
  private readonly ownership: StoreOwnership | null;
  private readonly currentProcessIdentity: ProcessIdentity;
  private readonly processIdentity: (pid: number) => ProcessIdentity | null;
  private readonly liveEntries = new Map<string, Map<string, Map<string, TranscriptEntry>>>();
  /** Statements prepared on first use and reused; better-sqlite3 compiles on every prepare. */
  private readonly statementCache = new Map<string, Database.Statement>();
  private readonly reportedUnreadable = new Set<number>();
  private closed = false;

  private sql<P extends unknown[] = unknown[], R = unknown>(text: string): Database.Statement<P, R> {
    let statement = this.statementCache.get(text);
    if (statement === undefined) {
      statement = this.db.prepare(text);
      this.statementCache.set(text, statement);
    }
    return statement as unknown as Database.Statement<P, R>;
  }

  /** Bulk read: an unreadable row becomes a notice instead of failing the whole read. */
  private readRow(row: PageRow): TranscriptEntry {
    const entry = tryParseEntry(row.payload_json);
    if (entry !== undefined) return entry;
    if (!this.reportedUnreadable.has(row.sequence_id)) {
      this.reportedUnreadable.add(row.sequence_id);
      console.warn(`[openbot] store: transcript entry ${row.sequence_id} ilegível substituída por aviso`);
    }
    return unreadableEntry(row.sequence_id);
  }

  private insertEntryRow(agentId: string, conversationId: string, entry: TranscriptEntry): number {
    const createdAt = entryCreatedAt(entry);
    this.statements.insertEntry.run(agentId, conversationId, entryIdOf(entry), entry.kind, serializeEntry(entry), createdAt);
    return createdAt;
  }

  private liveFor(agentId: string, conversationId: string, create = false): Map<string, TranscriptEntry> | undefined {
    let conversations = this.liveEntries.get(agentId);
    if (conversations === undefined) {
      if (!create) return undefined;
      conversations = new Map();
      this.liveEntries.set(agentId, conversations);
    }
    let entries = conversations.get(conversationId);
    if (entries === undefined && create) {
      entries = new Map();
      conversations.set(conversationId, entries);
    }
    return entries;
  }

  private mergeLive(agentId: string, conversationId: string, entries: readonly TranscriptEntry[]): TranscriptEntry[] {
    const live = this.liveFor(agentId, conversationId);
    if (live === undefined || live.size === 0) return [...entries];
    const consumed = new Set<string>();
    const merged = entries.map((entry) => {
      const id = transcriptEntryId(entry);
      const preview = id === undefined ? undefined : live.get(id);
      if (id !== undefined && preview !== undefined) consumed.add(id);
      return preview ?? entry;
    });
    for (const [id, preview] of live) if (!consumed.has(id)) merged.push(preview);
    return merged;
  }

  constructor(opts: SqliteTranscriptStoreOptions) {
    if (typeof opts.path !== "string" || opts.path.length === 0) {
      throw new Error("store: path é obrigatório");
    }
    if (opts.path !== ":memory:") {
      const parent = path.dirname(opts.path);
      fs.mkdirSync(parent, { recursive: true });
    }
    this.path = opts.path;
    this.ownership = opts.path === ":memory:" ? null : { token: randomUUID() };
    this.currentProcessIdentity = opts.currentProcessIdentity ?? localProcessIdentity();
    this.processIdentity = opts.processIdentity ?? queryProcessIdentity;
    this.ownsDatabase = opts.database === undefined;
    let database: Database.Database | undefined = opts.database;
    try {
      database ??= new Database(opts.path);
      this.db = database;
      this.db.pragma("foreign_keys = ON");
      if (this.ownsDatabase) {
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
        this.db.pragma("busy_timeout = 5000");
        this.db.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
      }
      ensureOpenBotSchema(this.db);
      this.promptQueue = createPromptQueue(this.db);
      const memoryStore = opts.memoryStore ?? new SqliteMemoryStore({ path: opts.path, database: this.db, secretValues: opts.secretValues });
      if (!memoryStore.sharesDatabase(this.db)) {
        throw new Error("store: memoryStore injetado deve usar a mesma conexão SQLite");
      }
      const conversationStore = opts.conversationStore ?? new SqliteConversationStore({ path: opts.path, database: this.db, memoryStore, secretValues: opts.secretValues });
      if (!conversationStore.sharesDatabase(this.db)) {
        throw new Error("store: conversationStore injetado deve usar a mesma conexão SQLite");
      }
      this.memoryStore = memoryStore;
      this.conversationStore = conversationStore;
      this.registerOwnershipAndReconcile();
      this.statements = this.prepareStatements();
      this.promptQueue.compactTerminal();
    } catch (error) {
      if (this.ownsDatabase && database !== undefined) {
        this.unregisterOwnership();
        database.close();
      }
      throw error;
    }
  }

  /** Internal shared-connection seam for durable control-plane stores. */
  databaseForSharedStores(): Database.Database {
    if (this.closed) throw new Error("store: conexão SQLite fechada");
    return this.db;
  }

  private reconcileInterruptedTurnAttempts(): void {
    const attempts = this.db.prepare<unknown[], TurnAttemptRow>("SELECT * FROM turn_attempts ORDER BY started_at_ms ASC").all();
    if (attempts.length === 0) return;
    const conversationIds = new Map<string, string>();
    for (const attempt of attempts) {
      conversationIds.set(attempt.turn_id, attempt.conversation_id ?? ensureDefaultConversation(this.db, attempt.agent_id));
    }
    const entries = this.db.prepare<unknown[], { kind: string; payload_json: string }>("SELECT kind, payload_json FROM transcript_entries WHERE agent_id = ? AND conversation_id = ? ORDER BY sequence_id ASC");
    const insert = this.db.prepare("INSERT INTO transcript_entries (agent_id, conversation_id, entry_id, kind, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)");
    const remove = this.db.prepare("DELETE FROM turn_attempts WHERE turn_id = ?");
    let unreadable = 0;
    this.db.transaction(() => {
      for (const attempt of attempts) {
        const conversationId = conversationIds.get(attempt.turn_id)!;
        const current = entries.all(attempt.agent_id, conversationId);
        const parsed: TranscriptEntry[] = [];
        for (const row of current) {
          const entry = tryParseEntry(row.payload_json);
          if (entry === undefined) unreadable += 1;
          else parsed.push(entry);
        }
        const skippedEntries = parsed.length !== current.length;
        const durableEcho = parsed.some((entry) => (
          (entry.kind === "message" && entry.role === "user" && (entry.turnId === attempt.turn_id || entry.clientNonce === attempt.client_nonce)) ||
          (entry.kind === "notice" && entry.type === "retry-attempt" && entry.clientNonce === attempt.client_nonce)
        ));
        const alreadyNoticed = parsed.some((entry) => entry.kind === "notice" && entry.type === "restart-interrupted" && entry.turnId === attempt.turn_id);
        if (durableEcho && !alreadyNoticed) {
          // Failed I/O and process limits do not establish that earlier effects rolled back.
          // An unreadable row may be a tool call, so its effects cannot be ruled out.
          const possibleEffects = skippedEntries || parsed.some((entry) => entry.kind === "tool-call"
            && typeof entry.localToolCallId === "string" && entry.localToolCallId.startsWith(`${attempt.turn_id}\0`)
            && (entry.status === "completed" || entry.status === "running"
              || (entry.result?.ok === false && ["aborted", "process_aborted", "process_failed", "io_error", "timed_out", "output_limit", "process_timeout", "process_output_limit"].includes(entry.result.code ?? ""))));
          const notice = normalizeTranscriptEntry({
            kind: "notice",
            id: `notice:${attempt.turn_id}:restart-interrupted`,
            type: "restart-interrupted",
            text: possibleEffects
              ? "OpenBot foi reiniciado antes de concluir a resposta. Confira os efeitos das ferramentas e envie uma nova instrução para continuar."
              : "OpenBot foi reiniciado antes de concluir a resposta. Você pode tentar novamente.",
            level: "error",
            retryable: !possibleEffects,
            turnId: attempt.turn_id,
            provider: attempt.provider,
            model: attempt.model,
            ...(attempt.client_nonce === null ? {} : { clientNonce: attempt.client_nonce }),
            ...(attempt.retry_of_client_nonce === null ? {} : { retryOfClientNonce: attempt.retry_of_client_nonce }),
            ...(attempt.retry_failure_turn_id === null ? {} : { retryFailureTurnId: attempt.retry_failure_turn_id }),
          });
          insert.run(attempt.agent_id, conversationId, notice.id, notice.kind, JSON.stringify(notice), Date.now());
        }
        remove.run(attempt.turn_id);
      }
    })();
    if (unreadable > 0) console.warn(`[openbot] store: ${unreadable} transcript entries ilegíveis ignoradas na reconciliação de turnos interrompidos`);
  }

  private reconcileInterruptedEntries(): void {
    // Each branch repeats a partial index predicate verbatim, so the boot
    // reads only the rows still in flight instead of every transcript row.
    const rows = this.sql<unknown[], PageRow>(`
      SELECT sequence_id, payload_json
      FROM transcript_entries INDEXED BY idx_transcript_streaming_messages
      WHERE kind = 'message' AND (json_extract(payload_json, '$.streaming') = 1 OR json_extract(payload_json, '$.isStreaming') = 1)
      UNION ALL
      SELECT sequence_id, payload_json
      FROM transcript_entries INDEXED BY idx_transcript_open_tool_calls
      WHERE kind = 'tool-call' AND json_extract(payload_json, '$.status') IN ('pending', 'running')
    `).all();
    if (rows.length === 0) return;
    const update = this.db.prepare("UPDATE transcript_entries SET payload_json = ? WHERE sequence_id = ?");
    let unreadable = 0;
    this.db.transaction(() => {
      for (const row of rows) {
        const entry = tryParseEntry(row.payload_json);
        if (entry === undefined) {
          unreadable += 1;
          continue;
        }
        let reconciled: TranscriptEntry;
        if (entry.kind === "message") {
          reconciled = { ...entry, streaming: false, isStreaming: false, completionState: "interrupted" };
        } else if (entry.kind === "tool-call") {
          reconciled = {
            ...entry,
            status: "failed",
            result: {
              ok: false,
              code: "aborted",
              message: "OpenBot foi reiniciado sem confirmar o resultado. A operação pode ter produzido efeitos; confira-os antes de continuar.",
            },
          };
        } else {
          continue;
        }
        update.run(JSON.stringify(reconciled), row.sequence_id);
      }
    })();
    if (unreadable > 0) console.warn(`[openbot] store: ${unreadable} transcript entries ilegíveis mantidas sem reconciliação`);
  }

  /**
   * A claim is durable before its turn is queued, so a crash can leave only
   * the acceptance row behind.  `pending_nonces` makes that window explicit:
   * on restart, keep a nonce only when its user echo was committed, then drop
   * the transient marker.  A committed echo is the idempotency proof and must
   * never be retried into a duplicate turn.
   */
  private reconcileAcceptedNonces(): void {
    const deleteOrphans = this.db.prepare(`
      DELETE FROM accepted_nonces
      WHERE EXISTS (
        SELECT 1
        FROM pending_nonces AS pending
        WHERE pending.agent_id = accepted_nonces.agent_id
          AND pending.conversation_id = accepted_nonces.conversation_id
          AND pending.nonce = accepted_nonces.nonce
      )
      AND NOT EXISTS (
        SELECT 1
        FROM transcript_entries AS entry
        WHERE entry.agent_id = accepted_nonces.agent_id
          AND entry.conversation_id = accepted_nonces.conversation_id
          AND (
            (entry.kind = 'message' AND json_extract(entry.payload_json, '$.role') = 'user')
            OR
            (entry.kind = 'notice' AND json_extract(entry.payload_json, '$.type') = 'retry-attempt')
          )
          AND json_extract(entry.payload_json, '$.clientNonce') = accepted_nonces.nonce
      )
      RETURNING agent_id, conversation_id, nonce
    `);
    const clearPending = this.db.prepare("DELETE FROM pending_nonces");
    this.db.transaction(() => {
      const interrupted = deleteOrphans.all() as Array<{ agent_id: string; conversation_id: string; nonce: string }>;
      const insert = this.sql("INSERT INTO transcript_entries (agent_id, conversation_id, entry_id, kind, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)");
      for (const pending of interrupted) {
        const notice = normalizeTranscriptEntry({
          kind: "notice", id: `notice:${randomUUID()}`, level: "error",
          text: "Um envio foi interrompido antes da confirmação. Confira a pendência local antes de reenviar: ela pode recuperar o texto e os anexos. O servidor não retomou ferramentas automaticamente.",
          clientNonce: pending.nonce,
        });
        insert.run(pending.agent_id, pending.conversation_id, notice.id, notice.kind, JSON.stringify(notice), Date.now());
      }
      clearPending.run();
    })();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("store: conexão fechada");
  }

  /** Resolve an omitted id to the live active conversation and validate explicit ownership. */
  private resolveConversationId(agentId: string, conversationId?: string, now = Date.now()): string {
    if (conversationId === undefined) return ensureDefaultConversation(this.db, agentId, now);
    validateConversationId(conversationId);
    // Hot path: called by every store operation. The prepared statement is
    // cached instead of recompiled on each call (behavior is identical).
    this.conversationExistsStmt ??= this.db.prepare(
      "SELECT id FROM agent_conversations WHERE agent_id = ? AND id = ?",
    );
    const row = this.conversationExistsStmt.get(agentId, conversationId);
    if (row?.id === undefined) throw new Error("conversation não encontrada para o agente");
    return row.id;
  }

  validateConversation(agentId: string, conversationId: string): void {
    validateAgentId(agentId);
    this.ensureOpen();
    this.resolveConversationId(agentId, conversationId);
  }

  private prepareStatements(): StoreStatements {
    return {
      getEntries: this.db.prepare(
        "SELECT sequence_id, payload_json FROM transcript_entries WHERE agent_id = ? AND conversation_id = ? ORDER BY sequence_id ASC",
      ),
      getNonces: this.db.prepare(
        "SELECT nonce FROM accepted_nonces WHERE agent_id = ? ORDER BY accepted_at_ms ASC, rowid ASC",
      ),
      getInteractionDecisions: this.db.prepare(
        "SELECT request_id, kind, decision, created_at_ms FROM interaction_decisions WHERE agent_id = ? AND conversation_id = ? ORDER BY created_at_ms ASC, id ASC",
      ),
      insertEntry: this.db.prepare(
        "INSERT INTO transcript_entries (agent_id, conversation_id, entry_id, kind, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      ),
      touchConversation: this.db.prepare(`
        UPDATE agent_conversations
        SET updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END,
            last_message_at_ms = CASE
              WHEN ? IS NOT NULL AND (last_message_at_ms IS NULL OR last_message_at_ms < ?) THEN ?
              ELSE last_message_at_ms
            END
        WHERE agent_id = ? AND id = ?
      `),
      deleteEntries: this.db.prepare("DELETE FROM transcript_entries WHERE agent_id = ?"),
      deleteNonces: this.db.prepare("DELETE FROM accepted_nonces WHERE agent_id = ?"),
      hasNonce: this.db.prepare(
        "SELECT 1 AS present FROM accepted_nonces WHERE agent_id = ? AND conversation_id = ? AND nonce = ? LIMIT 1",
      ),
      getNonceConversations: this.db.prepare(
        "SELECT conversation_id FROM accepted_nonces WHERE agent_id = ? AND nonce = ? ORDER BY accepted_at_ms ASC, rowid ASC",
      ),
      insertNonce: this.db.prepare(
        "INSERT OR IGNORE INTO accepted_nonces (agent_id, conversation_id, nonce, accepted_at_ms) VALUES (?, ?, ?, ?)",
      ),
      insertPendingNonce: this.db.prepare(
        "INSERT OR IGNORE INTO pending_nonces (agent_id, conversation_id, nonce, accepted_at_ms) VALUES (?, ?, ?, ?)",
      ),
      deletePendingNonce: this.db.prepare("DELETE FROM pending_nonces WHERE agent_id = ? AND conversation_id = ? AND nonce = ?"),
      deleteNonce: this.db.prepare("DELETE FROM accepted_nonces WHERE agent_id = ? AND conversation_id = ? AND nonce = ?"),
      trimNonces: this.db.prepare(`
        DELETE FROM accepted_nonces
        WHERE agent_id = ?
          AND rowid NOT IN (
            SELECT rowid
            FROM accepted_nonces
            WHERE agent_id = ?
            ORDER BY accepted_at_ms DESC, rowid DESC
            LIMIT ?
          )
      `),
      firstPage: this.db.prepare(`
        SELECT sequence_id, payload_json
        FROM transcript_entries
        WHERE agent_id = ? AND conversation_id = ?
        ORDER BY sequence_id DESC
        LIMIT ?
      `),
      nextPage: this.db.prepare(`
        SELECT sequence_id, payload_json
        FROM transcript_entries
        WHERE agent_id = ? AND conversation_id = ? AND sequence_id < ?
        ORDER BY sequence_id DESC
        LIMIT ?
      `),
      replaceEntry: this.db.prepare(`
        UPDATE transcript_entries
        SET payload_json = ?
        WHERE rowid = (
          SELECT rowid FROM transcript_entries
          WHERE agent_id = ? AND conversation_id = ? AND entry_id = ?
          ORDER BY sequence_id DESC
          LIMIT 1
        )
      `),
      recentEntries: this.db.prepare(`
        SELECT sequence_id, payload_json
        FROM transcript_entries
        WHERE agent_id = ? AND conversation_id = ? AND sequence_id > ?
        ORDER BY sequence_id DESC
        LIMIT ?
      `),
      recentEntriesByKinds: this.db.prepare(`
        SELECT sequence_id, payload_json
        FROM transcript_entries
        WHERE agent_id = ? AND conversation_id = ?
          AND sequence_id > ?
          AND kind IN (SELECT value FROM json_each(?))
        ORDER BY sequence_id DESC
        LIMIT ?
      `),
      latestAssistant: this.db.prepare(`
        SELECT payload_json
        FROM transcript_entries
        WHERE agent_id = ? AND conversation_id = ?
          AND kind = 'message'
          AND json_extract(payload_json, '$.role') = 'assistant'
        ORDER BY sequence_id DESC
        LIMIT 1
      `),
      openToolCalls: this.db.prepare(`
        SELECT sequence_id, payload_json
        FROM transcript_entries INDEXED BY idx_transcript_open_tool_calls
        WHERE agent_id = ? AND conversation_id = ?
          AND kind = 'tool-call'
          AND json_extract(payload_json, '$.status') IN ('pending', 'running')
        ORDER BY sequence_id ASC
      `),
      replaceToolCallByLocalId: this.db.prepare(`
        UPDATE transcript_entries
        SET entry_id = ?, payload_json = ?
        WHERE rowid = (
          SELECT rowid FROM transcript_entries
          WHERE agent_id = ? AND conversation_id = ?
            AND kind = 'tool-call'
            AND json_extract(payload_json, '$.localToolCallId') = ?
          ORDER BY sequence_id DESC
          LIMIT 1
        )
      `),
      findToolCallByLocalId: this.db.prepare(`
        SELECT payload_json
        FROM transcript_entries
        WHERE agent_id = ? AND conversation_id = ?
          AND kind = 'tool-call'
          AND json_extract(payload_json, '$.localToolCallId') = ?
        ORDER BY sequence_id DESC
        LIMIT 1
      `),
      firstUserMessage: this.db.prepare(`
        SELECT payload_json
        FROM transcript_entries
        WHERE agent_id = ? AND conversation_id = ?
          AND kind = 'message'
          AND json_extract(payload_json, '$.role') = 'user'
          AND length(trim(COALESCE(json_extract(payload_json, '$.content'), ''))) > 0
        ORDER BY sequence_id ASC
        LIMIT 1
      `),
      latestNonEmptyMessage: this.db.prepare(`
        SELECT payload_json
        FROM transcript_entries
        WHERE agent_id = ? AND conversation_id = ?
          AND kind = 'message'
          AND length(trim(COALESCE(json_extract(payload_json, '$.content'), ''))) > 0
        ORDER BY sequence_id DESC
        LIMIT 1
      `),
      getInteractionDecision: this.db.prepare(
        "SELECT agent_id, request_id, kind, decision, created_at_ms FROM interaction_decisions WHERE agent_id = ? AND conversation_id = ? AND request_id = ? AND kind = ?",
      ),
      insertInteractionDecision: this.db.prepare(
        "INSERT OR IGNORE INTO interaction_decisions (agent_id, conversation_id, request_id, kind, decision, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      ),
      deleteInteractionDecisions: this.db.prepare(
        "DELETE FROM interaction_decisions WHERE agent_id = ?",
      ),
      insertTurnAttempt: this.db.prepare(`
        INSERT INTO turn_attempts (turn_id, agent_id, conversation_id, client_nonce, retry_of_client_nonce, retry_failure_turn_id, provider, model, phase, started_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateTurnAttempt: this.db.prepare("UPDATE turn_attempts SET phase = ? WHERE agent_id = ? AND turn_id = ?"),
      deleteTurnAttempt: this.db.prepare("DELETE FROM turn_attempts WHERE agent_id = ? AND turn_id = ?"),
      deleteAgentTurnAttempts: this.db.prepare("DELETE FROM turn_attempts WHERE agent_id = ?"),
      insertTurnCompletion: this.db.prepare(`
        INSERT OR IGNORE INTO turn_completions (agent_id, conversation_id, client_nonce, turn_id, outcome, completed_at_ms)
        SELECT attempt.agent_id, attempt.conversation_id, attempt.client_nonce, attempt.turn_id, ?, ?
        FROM turn_attempts AS attempt
        JOIN accepted_nonces AS accepted
          ON accepted.agent_id = attempt.agent_id
         AND accepted.conversation_id = attempt.conversation_id
         AND accepted.nonce = attempt.client_nonce
        WHERE attempt.agent_id = ? AND attempt.turn_id = ? AND attempt.client_nonce IS NOT NULL
      `),
      hasTurnCompletion: this.db.prepare(
        "SELECT outcome FROM turn_completions WHERE agent_id = ? AND conversation_id = ? AND client_nonce = ? LIMIT 1",
      ),
      deleteTurnCompletion: this.db.prepare(
        "DELETE FROM turn_completions WHERE agent_id = ? AND conversation_id = ? AND client_nonce = ?",
      ),
      deleteAgentTurnCompletions: this.db.prepare("DELETE FROM turn_completions WHERE agent_id = ?"),
    };
  }

  getEntries(agentId: string, conversationId?: string): readonly TranscriptEntry[] {
    validateAgentId(agentId);
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const rows = this.statements.getEntries.all(agentId, resolvedConversationId);
    return this.mergeLive(agentId, resolvedConversationId, rows.map((row) => this.readRow(row)));
  }

  /** Uses idx_transcript_agent_entry; only identity is read, never transcript bodies. */
  findEntryConversationIds(agentId: string, entryId: string, conversationId?: string): readonly string[] {
    validateAgentId(agentId);
    this.ensureOpen();
    if (!entryId) return [];
    const rows = this.sql(conversationId === undefined
      ? "SELECT DISTINCT conversation_id FROM transcript_entries WHERE agent_id = ? AND entry_id = ? AND conversation_id IS NOT NULL LIMIT 2"
      : "SELECT DISTINCT conversation_id FROM transcript_entries WHERE agent_id = ? AND entry_id = ? AND conversation_id = ? LIMIT 1")
      .all(...(conversationId === undefined ? [agentId, entryId] : [agentId, entryId, conversationId])) as Array<{ conversation_id: string | null }>;
    const matches = new Set(rows.map((row) => row.conversation_id).filter((id): id is string => typeof id === "string"));
    const live = this.liveEntries.get(agentId);
    if (conversationId === undefined) {
      for (const [id, entries] of live ?? []) {
        if (entries.has(entryId)) matches.add(id);
        if (matches.size > 1) break;
      }
    } else if (live?.get(conversationId)?.has(entryId)) {
      matches.add(conversationId);
    }
    return Array.from(matches).slice(0, 2);
  }

  append(agentId: string, entries: readonly TranscriptEntry[], conversationId?: string, consumeStagedAttachments = false): void {
    validateAgentId(agentId);
    this.ensureOpen();
    if (entries.length === 0) return;
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const transaction = this.db.transaction((items: readonly TranscriptEntry[]) => {
      let updatedAtMs = Number.NEGATIVE_INFINITY;
      let lastMessageAtMs: number | null = null;
      for (const entry of items) {
        if (consumeStagedAttachments && entry.kind === "user-attachment" && entry.file_path.startsWith("attachment:") && !entry.skipped) {
          const consumed = this.sql(`
            UPDATE attachment_staging SET state = 'committed', consumed_at_ms = ?
            WHERE id = ? AND agent_id = ? AND (conversation_id IS NULL OR conversation_id = ?)
              AND state != 'discarded' AND consumed_at_ms IS NULL AND expires_at_ms > ?
          `).run(Date.now(), entry.file_path.slice("attachment:".length), agentId, resolvedConversationId, Date.now());
          if (consumed.changes !== 1) throw new Error("Anexo indisponível para envio. Anexe novamente ou tente recuperar a pendência.");
        }
        const createdAt = this.insertEntryRow(agentId, resolvedConversationId, entry);
        if (createdAt > updatedAtMs) updatedAtMs = createdAt;
        if (entry.kind === "message" && (lastMessageAtMs === null || createdAt > lastMessageAtMs)) {
          lastMessageAtMs = createdAt;
        }
      }
      if (updatedAtMs !== Number.NEGATIVE_INFINITY) {
        this.statements.touchConversation.run(
          updatedAtMs,
          updatedAtMs,
          lastMessageAtMs,
          lastMessageAtMs,
          lastMessageAtMs,
          agentId,
          resolvedConversationId,
        );
      }
    });
    transaction(entries);
  }

  beginAgentDeletion(agentIds: readonly string[], startedAtMs = Date.now()): void {
    const ids = [...new Set(agentIds.map((agentId) => {
      validateAgentId(agentId);
      return agentId;
    }))];
    this.ensureOpen();
    const insert = this.db.prepare(`
      INSERT INTO agent_deletion_journal(agent_id, started_at_ms)
      VALUES (?, ?)
      ON CONFLICT(agent_id) DO NOTHING
    `);
    this.db.transaction(() => {
      for (const agentId of ids) insert.run(agentId, startedAtMs);
    })();
  }

  completeAgentDeletion(agentIds: readonly string[]): void {
    const ids = [...new Set(agentIds.map((agentId) => {
      validateAgentId(agentId);
      return agentId;
    }))];
    this.ensureOpen();
    const remove = this.db.prepare("DELETE FROM agent_deletion_journal WHERE agent_id = ?");
    this.db.transaction(() => {
      for (const agentId of ids) remove.run(agentId);
    })();
  }

  pendingAgentDeletions(): readonly { agentId: string; startedAtMs: number }[] {
    this.ensureOpen();
    const rows = this.db.prepare(`
      SELECT agent_id, started_at_ms
      FROM agent_deletion_journal
      ORDER BY started_at_ms ASC, agent_id ASC
    `).all() as Array<{ agent_id: string; started_at_ms: number }>;
    return rows.map((row) => ({ agentId: row.agent_id, startedAtMs: row.started_at_ms }));
  }

  hasPendingAgentDeletion(agentId: string): boolean {
    validateAgentId(agentId);
    this.ensureOpen();
    return this.db.prepare("SELECT 1 AS present FROM agent_deletion_journal WHERE agent_id = ? COLLATE NOCASE")
      .get(agentId) !== undefined;
  }

  clear(agentId: string): void {
    this.clearAgents([agentId]);
  }

  clearAgents(agentIds: readonly string[]): void {
    const uniqueAgentIds = [...new Set(agentIds)];
    for (const agentId of uniqueAgentIds) validateAgentId(agentId);
    this.ensureOpen();
    if (uniqueAgentIds.length === 0) return;

    const deleteConversationState = this.db.prepare("DELETE FROM agent_conversation_state WHERE agent_id = ?");
    const deletePendingNonces = this.db.prepare("DELETE FROM pending_nonces WHERE agent_id = ?");
    const deleteKickstarts = this.db.prepare("DELETE FROM kickstart_runs WHERE agent_id = ?");
    const deleteConversations = this.db.prepare("DELETE FROM agent_conversations WHERE agent_id = ?");
    const transaction = this.db.transaction(() => {
      for (const agentId of uniqueAgentIds) {
        deleteConversationState.run(agentId);
        this.statements.deleteEntries.run(agentId);
        this.statements.deleteNonces.run(agentId);
        deletePendingNonces.run(agentId);
        this.statements.deleteInteractionDecisions.run(agentId);
        this.statements.deleteAgentTurnAttempts.run(agentId);
        this.statements.deleteAgentTurnCompletions.run(agentId);
        deleteKickstarts.run(agentId);
        this.promptQueue.clear(agentId);
        this.memoryStore.clearAgentRows(agentId);
        deleteConversations.run(agentId);
      }
    });
    transaction();
    // The delete triggers already removed these rows from both FTS tables.
    for (const agentId of uniqueAgentIds) this.liveEntries.delete(agentId);
  }

  snapshotAgent(agentId: string): SqliteTranscriptAgentSnapshot {
    validateAgentId(agentId);
    this.ensureOpen();
    const snapshot = this.db.transaction(() => {
      const transcriptRows = this.db.prepare<unknown[], TranscriptSnapshotRow>(`
        SELECT sequence_id, agent_id, conversation_id, entry_id, kind, payload_json, created_at_ms
        FROM transcript_entries WHERE agent_id = ? ORDER BY sequence_id ASC
      `).all(agentId);
      const acceptedNonceRows = this.db.prepare<unknown[], BoundNonceRow>(`
        SELECT agent_id, conversation_id, nonce, accepted_at_ms
        FROM accepted_nonces WHERE agent_id = ? ORDER BY accepted_at_ms ASC, rowid ASC
      `).all(agentId);
      const pendingNonceRows = this.db.prepare<unknown[], BoundNonceRow>(`
        SELECT agent_id, conversation_id, nonce, accepted_at_ms
        FROM pending_nonces WHERE agent_id = ? ORDER BY accepted_at_ms ASC, rowid ASC
      `).all(agentId);
      const interactionDecisionRows = this.db.prepare<unknown[], InteractionDecisionSnapshotRow>(`
        SELECT id, agent_id, conversation_id, request_id, kind, decision, metadata_json, created_at_ms
        FROM interaction_decisions WHERE agent_id = ? ORDER BY created_at_ms ASC, id ASC
      `).all(agentId);
      const turnAttemptRows = this.db.prepare<unknown[], TurnAttemptRow>(`
        SELECT turn_id, agent_id, conversation_id, client_nonce, retry_of_client_nonce, retry_failure_turn_id, provider, model, phase, started_at_ms
        FROM turn_attempts WHERE agent_id = ? ORDER BY started_at_ms ASC, turn_id ASC
      `).all(agentId);
      const turnCompletionRows = this.db.prepare<unknown[], TurnCompletionRow>(`
        SELECT agent_id, conversation_id, client_nonce, turn_id, outcome, completed_at_ms
        FROM turn_completions WHERE agent_id = ? ORDER BY completed_at_ms ASC, turn_id ASC
      `).all(agentId);
      const kickstartRuns = this.db.prepare<unknown[], KickstartRunRow>(`
        SELECT agent_id, client_nonce, conversation_id, origin, version, attempt, turn_id, provider, model,
               status, observable_output, result_json, error, created_at_ms, updated_at_ms
        FROM kickstart_runs WHERE agent_id = ? ORDER BY created_at_ms ASC, client_nonce ASC
      `).all(agentId).map(parseKickstartRun);
      const conversations = this.db.prepare<unknown[], ConversationRow>(`
        SELECT id, agent_id, title, title_source, temporary, archived_at_ms, created_at_ms, updated_at_ms, last_message_at_ms
        FROM agent_conversations WHERE agent_id = ? ORDER BY updated_at_ms ASC, id ASC
      `).all(agentId);
      const active = this.db.prepare<unknown[], { active_conversation_id: string }>("SELECT active_conversation_id FROM agent_conversation_state WHERE agent_id = ?").get(agentId);
      const entries = transcriptRows.map((row) => this.readRow(row));
      const interactionDecisions: TranscriptInteractionDecision[] = interactionDecisionRows.map((row) => ({
        requestId: row.request_id,
        kind: row.kind,
        decision: row.decision,
        createdAtMs: row.created_at_ms,
      }));
      return {
        entries,
        acceptedNonces: acceptedNonceRows.map((row) => row.nonce),
        completedNonceBindings: turnCompletionRows.map((row) => ({
          nonce: row.client_nonce,
          ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
          turnId: row.turn_id,
          outcome: row.outcome,
          completedAtMs: row.completed_at_ms,
        })),
        interactionDecisions,
        conversations: conversations.map((row) => ({
          id: row.id,
          agentId: row.agent_id,
          title: row.title,
          titleSource: row.title_source,
          temporary: row.temporary === 1,
          archivedAtMs: row.archived_at_ms,
          createdAtMs: row.created_at_ms,
          updatedAtMs: row.updated_at_ms,
          lastMessageAtMs: row.last_message_at_ms,
        })),
        activeConversationId: active?.active_conversation_id ?? null,
        transcriptRows: transcriptRows.map((row) => ({
          sequenceId: row.sequence_id,
          agentId: row.agent_id,
          conversationId: row.conversation_id,
          entryId: row.entry_id,
          kind: row.kind,
          payloadJson: row.payload_json,
          createdAtMs: row.created_at_ms,
        })),
        acceptedNonceRows: acceptedNonceRows.map((row) => ({
          agentId: row.agent_id,
          conversationId: row.conversation_id,
          nonce: row.nonce,
          acceptedAtMs: row.accepted_at_ms,
        })),
        pendingNonceRows: pendingNonceRows.map((row) => ({
          agentId: row.agent_id,
          conversationId: row.conversation_id,
          nonce: row.nonce,
          acceptedAtMs: row.accepted_at_ms,
        })),
        interactionDecisionRows: interactionDecisionRows.map((row) => ({
          id: row.id,
          agentId: row.agent_id,
          conversationId: row.conversation_id,
          requestId: row.request_id,
          kind: row.kind,
          decision: row.decision,
          metadataJson: row.metadata_json,
          createdAtMs: row.created_at_ms,
        })),
        turnAttemptRows: turnAttemptRows.map((row) => ({
          turnId: row.turn_id,
          agentId: row.agent_id,
          conversationId: row.conversation_id,
          clientNonce: row.client_nonce,
          retryOfClientNonce: row.retry_of_client_nonce,
          retryFailureTurnId: row.retry_failure_turn_id,
          provider: row.provider,
          model: row.model,
          phase: row.phase,
          startedAtMs: row.started_at_ms,
        })),
        turnCompletionRows: turnCompletionRows.map((row) => ({
          agentId: row.agent_id,
          conversationId: row.conversation_id,
          clientNonce: row.client_nonce,
          turnId: row.turn_id,
          outcome: row.outcome,
          completedAtMs: row.completed_at_ms,
        })),
        kickstartRuns,
        promptQueueRows: this.db.prepare<unknown[], NonNullable<SqliteTranscriptAgentSnapshot["promptQueueRows"]>[number]>("SELECT * FROM prompt_queue WHERE agent_id=? ORDER BY sequence").all(agentId),
        memorySnapshot: this.memoryStore.snapshotAgent(agentId),
      } satisfies SqliteTranscriptAgentSnapshot;
    });
    return snapshot();
  }

  private validateFullRestoreSnapshot(agentId: string, snapshot: SqliteTranscriptAgentSnapshot): void {
    const conversationIds = new Set<string>();
    for (const conversation of snapshot.conversations) {
      if (conversation.agentId !== agentId) throw new Error("snapshot contém conversa de outro agente");
      if (conversationIds.has(conversation.id)) throw new Error("snapshot contém conversa duplicada");
      conversationIds.add(conversation.id);
    }
    if (snapshot.activeConversationId !== null && !conversationIds.has(snapshot.activeConversationId)) {
      throw new Error("snapshot aponta para conversa ativa inválida");
    }
    for (const row of snapshot.promptQueueRows ?? []) {
      if (row.agent_id !== agentId || !conversationIds.has(row.conversation_id)) throw new Error("snapshot contém fila de outra conversa");
    }

    const transcriptSequences = new Set<number>();
    for (const row of snapshot.transcriptRows) {
      if (row.agentId !== agentId) throw new Error("snapshot contém transcript de outro agente");
      if (transcriptSequences.has(row.sequenceId)) throw new Error("snapshot contém transcript duplicado");
      transcriptSequences.add(row.sequenceId);
      validateBoundConversationId(conversationIds, row.conversationId, "transcript");
    }

    const acceptedNonceKeys = new Set<string>();
    for (const row of snapshot.acceptedNonceRows) {
      if (row.agentId !== agentId) throw new Error("snapshot contém nonce de outro agente");
      const conversationId = validateBoundConversationId(conversationIds, row.conversationId, "nonce");
      const key = `${conversationId}\u0000${row.nonce}`;
      if (acceptedNonceKeys.has(key)) throw new Error("snapshot contém nonce duplicado");
      acceptedNonceKeys.add(key);
    }

    const pendingNonceKeys = new Set<string>();
    for (const row of snapshot.pendingNonceRows) {
      if (row.agentId !== agentId) throw new Error("snapshot contém nonce pendente de outro agente");
      const conversationId = validateBoundConversationId(conversationIds, row.conversationId, "nonce pendente");
      const key = `${conversationId}\u0000${row.nonce}`;
      if (pendingNonceKeys.has(key)) throw new Error("snapshot contém nonce pendente duplicado");
      pendingNonceKeys.add(key);
    }

    const decisionIds = new Set<number>();
    for (const row of snapshot.interactionDecisionRows) {
      if (row.agentId !== agentId) throw new Error("snapshot contém decisão de outro agente");
      if (decisionIds.has(row.id)) throw new Error("snapshot contém decisão duplicada");
      decisionIds.add(row.id);
      validateBoundConversationId(conversationIds, row.conversationId, "decisão");
    }

    const turnIds = new Set<string>();
    for (const row of snapshot.turnAttemptRows) {
      if (row.agentId !== agentId) throw new Error("snapshot contém turno de outro agente");
      if (turnIds.has(row.turnId)) throw new Error("snapshot contém turno duplicado");
      turnIds.add(row.turnId);
      validateBoundConversationId(conversationIds, row.conversationId, "turno");
    }

    const completionNonces = new Set<string>();
    const completionTurnIds = new Set<string>();
    for (const row of snapshot.turnCompletionRows) {
      if (row.agentId !== agentId) throw new Error("snapshot contém conclusão de outro agente");
      const conversationId = validateBoundConversationId(conversationIds, row.conversationId, "conclusão");
      const nonceKey = `${conversationId}\u0000${row.clientNonce}`;
      if (completionNonces.has(nonceKey) || completionTurnIds.has(row.turnId)) throw new Error("snapshot contém conclusão duplicada");
      if (row.outcome !== undefined && !["success", "partial", "error", "aborted"].includes(row.outcome)) throw new Error("snapshot contém desfecho inválido");
      completionNonces.add(nonceKey);
      completionTurnIds.add(row.turnId);
    }

    const kickstartNonces = new Set<string>();
    for (const run of snapshot.kickstartRuns ?? []) {
      if (run.agentId !== agentId) throw new Error("snapshot contém kickstart de outro agente");
      if (kickstartNonces.has(run.clientNonce)) throw new Error("snapshot contém kickstart duplicado");
      kickstartNonces.add(run.clientNonce);
      if (run.conversationId !== undefined) validateBoundConversationId(conversationIds, run.conversationId, "kickstart");
    }

    const memorySnapshot = snapshot.memorySnapshot;
    if (memorySnapshot !== undefined) {
      this.memoryStore.validateAgentRows(agentId, memorySnapshot);
      validateSnapshotMemoryConversationRefs(agentId, memorySnapshot, conversationIds);
    }
  }

  restoreAgent(agentId: string, snapshot: TranscriptAgentSnapshot | SqliteTranscriptAgentSnapshot): void {
    validateAgentId(agentId);
    this.ensureOpen();
    const fullSnapshot = isSqliteTranscriptAgentSnapshot(snapshot);
    if (fullSnapshot) this.validateFullRestoreSnapshot(agentId, snapshot);
    this.liveEntries.delete(agentId);
    const conversationId = fullSnapshot ? undefined : ensureDefaultConversation(this.db, agentId);
    // Prepared once: better-sqlite3 compiles every prepare call, so preparing
    // inside the loops below would recompile one statement per restored row.
    const insertConversation = this.db.prepare(`
      INSERT INTO agent_conversations
        (id, agent_id, title, title_source, temporary, archived_at_ms, created_at_ms, updated_at_ms, last_message_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertActiveConversation = this.db.prepare("INSERT INTO agent_conversation_state(agent_id, active_conversation_id) VALUES (?, ?)");
    const insertTranscriptRow = this.db.prepare(`
      INSERT INTO transcript_entries(sequence_id, agent_id, conversation_id, entry_id, kind, payload_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAcceptedNonceRow = this.db.prepare("INSERT INTO accepted_nonces(agent_id, conversation_id, nonce, accepted_at_ms) VALUES (?, ?, ?, ?)");
    const insertPendingNonceRow = this.db.prepare("INSERT INTO pending_nonces(agent_id, conversation_id, nonce, accepted_at_ms) VALUES (?, ?, ?, ?)");
    const insertDecisionRow = this.db.prepare(`
      INSERT INTO interaction_decisions(id, agent_id, conversation_id, request_id, kind, decision, metadata_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTurnAttemptRow = this.db.prepare(`
      INSERT INTO turn_attempts(turn_id, agent_id, conversation_id, client_nonce, retry_of_client_nonce, retry_failure_turn_id, provider, model, phase, started_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTurnCompletionRow = this.db.prepare(`
      INSERT INTO turn_completions(agent_id, conversation_id, client_nonce, turn_id, outcome, completed_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertKickstartRow = this.db.prepare(`
      INSERT INTO kickstart_runs
        (agent_id, client_nonce, conversation_id, origin, version, attempt, turn_id, provider, model,
         status, observable_output, result_json, error, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, 'kickstart', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertCompletionBinding = this.db.prepare(`
      INSERT OR IGNORE INTO turn_completions(agent_id, conversation_id, client_nonce, turn_id, outcome, completed_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const transaction = this.db.transaction((state: TranscriptAgentSnapshot | SqliteTranscriptAgentSnapshot) => {
      const complete = isSqliteTranscriptAgentSnapshot(state);
      if (complete) this.db.prepare("DELETE FROM agent_conversation_state WHERE agent_id = ?").run(agentId);
      this.statements.deleteEntries.run(agentId);
      this.statements.deleteNonces.run(agentId);
      this.db.prepare("DELETE FROM pending_nonces WHERE agent_id = ?").run(agentId);
      this.statements.deleteInteractionDecisions.run(agentId);
      this.statements.deleteAgentTurnAttempts.run(agentId);
      this.statements.deleteAgentTurnCompletions.run(agentId);
      this.db.prepare("DELETE FROM kickstart_runs WHERE agent_id = ?").run(agentId);
      this.promptQueue.clear(agentId);
      this.memoryStore.clearAgentRows(agentId);
      if (complete) {
        this.db.prepare("DELETE FROM agent_conversations WHERE agent_id = ?").run(agentId);
        for (const conversation of state.conversations) {
          insertConversation.run(
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
        if (state.activeConversationId !== null) {
          insertActiveConversation.run(agentId, state.activeConversationId);
        }
        for (const row of state.transcriptRows) {
          insertTranscriptRow.run(row.sequenceId, agentId, row.conversationId, row.entryId, row.kind, row.payloadJson, row.createdAtMs);
        }
        for (const row of state.acceptedNonceRows) {
          insertAcceptedNonceRow.run(agentId, row.conversationId, row.nonce, row.acceptedAtMs);
        }
        for (const row of state.pendingNonceRows) {
          insertPendingNonceRow.run(agentId, row.conversationId, row.nonce, row.acceptedAtMs);
        }
        for (const row of state.interactionDecisionRows) {
          insertDecisionRow.run(row.id, agentId, row.conversationId, row.requestId, row.kind, row.decision, row.metadataJson, row.createdAtMs);
        }
        for (const row of state.turnAttemptRows) {
          insertTurnAttemptRow.run(row.turnId, agentId, row.conversationId, row.clientNonce, row.retryOfClientNonce, row.retryFailureTurnId, row.provider, row.model, row.phase, row.startedAtMs);
        }
        for (const row of state.turnCompletionRows) {
          insertTurnCompletionRow.run(agentId, row.conversationId, row.clientNonce, row.turnId, row.outcome ?? "success", row.completedAtMs);
        }
        for (const run of state.kickstartRuns ?? []) {
          insertKickstartRow.run(
            agentId,
            run.clientNonce,
            run.conversationId ?? null,
            run.version,
            run.attempt,
            run.turnId ?? null,
            run.provider ?? null,
            run.model ?? null,
            run.status,
            run.observableOutput ? 1 : 0,
            run.result === undefined ? null : JSON.stringify({ text: run.result.text.slice(0, 4096) }),
            run.error ?? null,
            run.createdAtMs,
            run.updatedAtMs,
          );
        }
        const insertPromptQueueRow = this.sql("INSERT INTO prompt_queue(sequence,agent_id,conversation_id,nonce,args_json,inference_json,state,payload_digest,payload_compacted,recovery_of) VALUES(?,?,?,?,?,?,?,?,?,?)");
        for (const row of state.promptQueueRows ?? []) {
          if (row.agent_id !== agentId) throw new Error("Invalid prompt queue snapshot owner");
          insertPromptQueueRow.run(row.sequence, agentId, row.conversation_id, row.nonce, row.args_json, row.inference_json, row.state, row.payload_digest ?? "", row.payload_compacted ?? 0, row.recovery_of ?? null);
        }
        const memorySnapshot = state.memorySnapshot ?? {
          settings: null,
          memories: [],
          revisions: [],
          summaries: [],
          jobs: [],
        } satisfies MemoryAgentSnapshot;
        this.memoryStore.restoreAgentRows(agentId, memorySnapshot, false);
        return;
      }
      for (const entry of state.entries) this.insertEntryRow(agentId, conversationId!, entry);
      const now = Date.now();
      for (const nonce of state.acceptedNonces) this.statements.insertNonce.run(agentId, conversationId, nonce, now);
      for (const completion of state.completedNonceBindings ?? []) {
        insertCompletionBinding.run(agentId, conversationId, completion.nonce, completion.turnId, completion.outcome ?? "success", completion.completedAtMs);
      }
      for (const decision of state.interactionDecisions) {
        this.statements.insertInteractionDecision.run(
          agentId,
          conversationId,
          decision.requestId,
          decision.kind,
          decision.decision,
          decision.createdAtMs,
        );
      }
    });
    // Insert triggers index the restored rows; a full FTS rebuild is not needed.
    transaction(snapshot);
  }

  hasAcceptedNonce(agentId: string, nonce: string, conversationId?: string): boolean {
    validateAgentId(agentId);
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const row = this.statements.hasNonce.get(agentId, resolvedConversationId, nonce);
    return row?.present === 1;
  }

  findAcceptedNonceConversations(agentId: string, nonce: string): readonly string[] {
    validateAgentId(agentId);
    this.ensureOpen();
    const rows = this.statements.getNonceConversations.all(agentId, nonce);
    return rows.map((row) => row.conversation_id);
  }

  /** Nonce-indexed lookup for the user echo; strict, because a missed echo could duplicate a send. */
  findUserEchoByNonce(agentId: string, nonce: string, conversationId?: string): TranscriptEntry | undefined {
    validateAgentId(agentId);
    if (nonce.length === 0) return undefined;
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    this.userEchoByNonceStmt ??= this.db.prepare(`
      SELECT payload_json
      FROM transcript_entries
      WHERE agent_id = ? AND conversation_id = ?
        AND json_extract(payload_json, '$.clientNonce') = ?
        AND (
          (kind = 'message' AND json_extract(payload_json, '$.role') = 'user')
          OR
          (kind = 'notice' AND json_extract(payload_json, '$.type') = 'retry-attempt')
        )
      ORDER BY sequence_id ASC
      LIMIT 1
    `);
    const row = this.userEchoByNonceStmt.get(agentId, resolvedConversationId, nonce);
    return row === undefined ? undefined : parseEntry(row.payload_json);
  }

  /**
   * Retryable error notice of a turn: a range scan of one conversation's rows,
   * strict like the echo lookup because retry decisions depend on it.
   */
  findRetryableErrorNotice(agentId: string, turnId: string, conversationId?: string): TranscriptEntry | undefined {
    validateAgentId(agentId);
    if (turnId.length === 0) return undefined;
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    this.retryableNoticeStmt ??= this.db.prepare(`
      SELECT payload_json
      FROM transcript_entries
      WHERE agent_id = ? AND conversation_id = ?
        AND kind = 'notice'
        AND json_extract(payload_json, '$.turnId') = ?
        AND json_extract(payload_json, '$.retryable') = 1
      ORDER BY sequence_id ASC
      LIMIT 1
    `);
    const row = this.retryableNoticeStmt.get(agentId, resolvedConversationId, turnId);
    return row === undefined ? undefined : parseEntry(row.payload_json);
  }

  /**
   * Transcript suffix that failure recovery needs: from the user message of the
   * latest retryable failure notice to the end. Everything recovery inspects
   * (that message, its attachments, the failed turn's tool calls, later
   * messages) is appended at or after that message, and turn ids are unique
   * (`turn:<uuid>`), so the suffix answers the
   * same questions as the whole conversation without reading it. Returns [] when
   * no such notice exists, and undefined when a suffix cannot be proven
   * equivalent (live previews, an unreadable notice, no matching message); the
   * caller then reads the whole conversation.
   */
  getRetryableFailureWindow(agentId: string, conversationId?: string): readonly TranscriptEntry[] | undefined {
    validateAgentId(agentId);
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    if ((this.liveFor(agentId, resolvedConversationId)?.size ?? 0) > 0) return undefined;
    // Same predicate recovery applies to parsed entries; normalization only adds ids.
    const notice = this.sql<unknown[], PageRow>(`
      SELECT sequence_id, payload_json FROM transcript_entries
      WHERE agent_id = ? AND conversation_id = ? AND kind = 'notice'
        AND json_extract(payload_json, '$.level') = 'error'
        AND json_type(payload_json, '$.retryable') = 'true'
        AND json_type(payload_json, '$.turnId') = 'text'
        AND json_type(payload_json, '$.provider') = 'text'
        AND json_type(payload_json, '$.model') = 'text'
      ORDER BY sequence_id DESC
      LIMIT 1
    `).get(agentId, resolvedConversationId);
    if (notice === undefined) return [];
    const failure = tryParseEntry(notice.payload_json);
    if (failure?.kind !== "notice" || typeof failure.turnId !== "string") return undefined;
    const originalNonce = typeof failure.retryOfClientNonce === "string"
      ? failure.retryOfClientNonce
      : typeof failure.clientNonce === "string" ? failure.clientNonce : null;
    const user = this.sql<unknown[], { sequence_id: number }>(`
      SELECT sequence_id FROM transcript_entries
      WHERE agent_id = ? AND conversation_id = ? AND kind = 'message'
        AND json_extract(payload_json, '$.role') = 'user'
        AND (json_extract(payload_json, '$.turnId') = ? OR (? IS NOT NULL AND json_extract(payload_json, '$.clientNonce') = ?))
      ORDER BY sequence_id DESC
      LIMIT 1
    `).get(agentId, resolvedConversationId, failure.turnId, originalNonce, originalNonce);
    if (user === undefined) return undefined;
    return this.sql<unknown[], PageRow>(
      "SELECT sequence_id, payload_json FROM transcript_entries WHERE agent_id = ? AND conversation_id = ? AND sequence_id >= ? ORDER BY sequence_id ASC",
    ).all(agentId, resolvedConversationId, Math.min(user.sequence_id, notice.sequence_id)).map((row) => this.readRow(row));
  }

  private registerOwnershipAndReconcile(): void {
    if (this.ownership === null) {
      this.reconcileInterruptedEntries();
      this.reconcileKickstartRuns();
      return;
    }
    const list = this.db.prepare<unknown[], StoreOwnershipRecord>("SELECT token, pid, process_started_at_ms, executable_path FROM runtime_owners");
    const remove = this.db.prepare("DELETE FROM runtime_owners WHERE token = ?");
    const insert = this.db.prepare("INSERT INTO runtime_owners (token, pid, process_started_at_ms, executable_path) VALUES (?, ?, ?, ?)");
    this.db.transaction(() => {
      let hasLiveOwner = false;
      for (const owner of list.all()) {
        const observed = owner.pid === process.pid ? this.currentProcessIdentity : this.processIdentity(owner.pid);
        if (sameProcessIdentity(owner, observed)) hasLiveOwner = true;
        else remove.run(owner.token);
      }
      insert.run(this.ownership!.token, process.pid, this.currentProcessIdentity.startedAtMs, normalizeExecutablePath(this.currentProcessIdentity.executablePath));
      if (!hasLiveOwner) {
        this.db.prepare("UPDATE prompt_queue SET state='interrupted' WHERE state='running'").run();
        this.db.prepare(`UPDATE attachment_staging SET expires_at_ms=? WHERE expires_at_ms=? AND NOT EXISTS (
          SELECT 1 FROM prompt_queue q, json_each(q.args_json,'$.attachments') a
          WHERE q.agent_id=attachment_staging.agent_id AND q.state IN ('queued','running')
            AND json_extract(a.value,'$.path')='attachment:' || attachment_staging.id
        )`).run(Date.now() + 24 * 60 * 60_000, Number.MAX_SAFE_INTEGER);
        this.reconcileAcceptedNonces();
        this.reconcileInterruptedTurnAttempts();
        this.reconcileInterruptedEntries();
        this.reconcileKickstartRuns();
      }
    }).immediate();
  }

  private unregisterOwnership(): void {
    if (this.ownership === null) return;
    this.db.prepare("DELETE FROM runtime_owners WHERE token = ?").run(this.ownership.token);
  }

  claimAcceptedNonce(agentId: string, nonce: string, conversationId?: string): boolean {
    validateAgentId(agentId);
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const claim = this.db.transaction(() => {
      const acceptedAtMs = Date.now();
      const result = this.statements.insertNonce.run(agentId, resolvedConversationId, nonce, acceptedAtMs);
      if (result.changes !== 1) return false;
      this.statements.insertPendingNonce.run(agentId, resolvedConversationId, nonce, acceptedAtMs);
      return true;
    });
    return claim();
  }

  rememberAcceptedNonce(agentId: string, nonce: string, conversationId?: string): void {
    validateAgentId(agentId);
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const remember = this.db.transaction(() => {
      this.statements.insertNonce.run(agentId, resolvedConversationId, nonce, Date.now());
      this.statements.deletePendingNonce.run(agentId, resolvedConversationId, nonce);
    });
    remember();
  }

  beginTurnAttempt(attempt: TurnAttemptRecord): void {
    validateAgentId(attempt.agentId);
    this.ensureOpen();
    const conversationId = this.resolveConversationId(attempt.agentId, attempt.conversationId, attempt.startedAtMs);
    this.statements.insertTurnAttempt.run(
      attempt.turnId,
      attempt.agentId,
      conversationId,
      attempt.clientNonce ?? null,
      attempt.retryOfClientNonce ?? null,
      attempt.retryFailureTurnId ?? null,
      attempt.provider,
      attempt.model,
      attempt.phase,
      attempt.startedAtMs,
    );
  }

  updateTurnAttempt(agentId: string, turnId: string, phase: TurnAttemptPhase): void {
    validateAgentId(agentId);
    this.ensureOpen();
    this.statements.updateTurnAttempt.run(phase, agentId, turnId);
  }

  finishTurnAttempt(agentId: string, turnId: string, outcome: TurnOutcome = "success"): void {
    validateAgentId(agentId);
    this.ensureOpen();
    const finish = this.db.transaction(() => {
      this.statements.insertTurnCompletion.run(outcome, Date.now(), agentId, turnId);
      this.statements.deleteTurnAttempt.run(agentId, turnId);
    });
    finish();
  }

  getKickstartRun(agentId: string, clientNonce: string): KickstartRunRecord | undefined {
    validateAgentId(agentId);
    this.ensureOpen();
    const row = this.sql<unknown[], KickstartRunRow>(`
      SELECT agent_id, client_nonce, conversation_id, origin, version, attempt, turn_id, provider, model,
             status, observable_output, result_json, error, created_at_ms, updated_at_ms
      FROM kickstart_runs WHERE agent_id = ? AND client_nonce = ?
    `).get(agentId, clientNonce);
    return row === undefined ? undefined : parseKickstartRun(row);
  }

  claimKickstartRun(input: Omit<KickstartRunRecord, "attempt" | "status" | "observableOutput" | "createdAtMs" | "updatedAtMs">): { run: KickstartRunRecord; claimed: boolean } {
    validateAgentId(input.agentId);
    this.ensureOpen();
    const claim = this.db.transaction(() => {
      const nowMs = Date.now();
      const inserted = this.sql(`
        INSERT OR IGNORE INTO kickstart_runs
          (agent_id, client_nonce, conversation_id, origin, version, attempt, turn_id, provider, model,
           status, observable_output, result_json, error, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, 'kickstart', ?, 1, NULL, ?, ?, 'queued', 0, NULL, NULL, ?, ?)
      `).run(
        input.agentId,
        input.clientNonce,
        input.conversationId ?? null,
        input.version,
        input.provider ?? null,
        input.model ?? null,
        nowMs,
        nowMs,
      );
      let run = this.getKickstartRun(input.agentId, input.clientNonce)!;
      if (inserted.changes === 1) return { run, claimed: true };
      if (run.status === "retryable" && !run.observableOutput) {
        this.sql(`
          UPDATE kickstart_runs
          SET conversation_id = ?, version = ?, attempt = attempt + 1, turn_id = NULL,
              provider = ?, model = ?, status = 'queued', observable_output = 0,
              result_json = NULL, error = NULL, updated_at_ms = ?
          WHERE agent_id = ? AND client_nonce = ? AND status = 'retryable' AND observable_output = 0
        `).run(
          input.conversationId ?? null,
          input.version,
          input.provider ?? null,
          input.model ?? null,
          nowMs,
          input.agentId,
          input.clientNonce,
        );
        run = this.getKickstartRun(input.agentId, input.clientNonce)!;
        return { run, claimed: true };
      }
      return { run, claimed: false };
    });
    return claim();
  }

  updateKickstartRun(
    agentId: string,
    clientNonce: string,
    update: Partial<Pick<KickstartRunRecord, "status" | "turnId" | "provider" | "model" | "observableOutput" | "result" | "error">>,
  ): KickstartRunRecord | undefined {
    const current = this.getKickstartRun(agentId, clientNonce);
    if (current === undefined) return undefined;
    const next = { ...current, ...update, updatedAtMs: Date.now() };
    if (next.result !== undefined) next.result = { text: utf8Prefix(next.result.text, MAX_KICKSTART_RESULT_BYTES) };
    if (next.error !== undefined) next.error = utf8Prefix(next.error, MAX_KICKSTART_ERROR_BYTES);
    this.sql(`
      UPDATE kickstart_runs
      SET turn_id = ?, provider = ?, model = ?, status = ?, observable_output = ?,
          result_json = ?, error = ?, updated_at_ms = ?
      WHERE agent_id = ? AND client_nonce = ?
    `).run(
      next.turnId ?? null,
      next.provider ?? null,
      next.model ?? null,
      next.status,
      next.observableOutput ? 1 : 0,
      next.result === undefined ? null : JSON.stringify(next.result),
      next.error ?? null,
      next.updatedAtMs,
      agentId,
      clientNonce,
    );
    return this.getKickstartRun(agentId, clientNonce);
  }

  cancelKickstartRun(agentId: string, clientNonce: string): KickstartRunRecord | undefined {
    const current = this.getKickstartRun(agentId, clientNonce);
    if (current === undefined) return undefined;
    return this.updateKickstartRun(agentId, clientNonce, {
      status: current.observableOutput ? "interrupted" : "cancelled",
      error: "cancelled",
    });
  }

  reconcileKickstartRuns(nowMs = Date.now()): number {
    this.ensureOpen();
    const result = this.sql(`
      UPDATE kickstart_runs
      SET status = CASE WHEN observable_output = 1 THEN 'interrupted' ELSE 'retryable' END,
          error = CASE WHEN observable_output = 1 THEN 'restart-after-output' ELSE 'restart-before-output' END,
          updated_at_ms = ?
      WHERE status IN ('queued', 'running')
    `).run(nowMs);
    return result.changes;
  }

  hasCompletedTurnForNonce(agentId: string, nonce: string, conversationId?: string): boolean {
    return this.getTurnOutcomeForNonce(agentId, nonce, conversationId) !== undefined;
  }

  getTurnOutcomeForNonce(agentId: string, nonce: string, conversationId?: string): TurnOutcome | undefined {
    validateAgentId(agentId);
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    return this.statements.hasTurnCompletion.get(agentId, resolvedConversationId, nonce)?.outcome;
  }

  forgetAcceptedNonce(agentId: string, nonce: string, conversationId?: string): void {
    validateAgentId(agentId);
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const forget = this.db.transaction(() => {
      this.statements.deleteTurnCompletion.run(agentId, resolvedConversationId, nonce);
      this.statements.deleteNonce.run(agentId, resolvedConversationId, nonce);
      this.statements.deletePendingNonce.run(agentId, resolvedConversationId, nonce);
    });
    forget();
  }

  trimAcceptedNonces(agentId: string, cap: number): void {
    validateAgentId(agentId);
    if (!Number.isInteger(cap) || cap < 0) throw new Error("ledger cap inválido");
    this.ensureOpen();
    const trim = this.db.transaction(() => {
      this.statements.trimNonces.run(agentId, agentId, cap);
      this.sql(`
        DELETE FROM turn_completions
        WHERE agent_id = ? AND NOT EXISTS (
          SELECT 1 FROM accepted_nonces AS accepted
          WHERE accepted.agent_id = turn_completions.agent_id
            AND accepted.conversation_id = turn_completions.conversation_id
            AND accepted.nonce = turn_completions.client_nonce
        )
      `).run(agentId);
    });
    trim();
  }

  getAgentTranscriptTail(
    agentId: string,
    limit = DEFAULT_TRANSCRIPT_PAGE_LIMIT,
    beforeSeq?: number,
    conversationId?: string,
  ): TranscriptPage {
    validateAgentId(agentId);
    validateLimit(limit);
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) {
      throw new Error("beforeSeq inválido");
    }
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const rows = beforeSeq === undefined
      ? this.statements.firstPage.all(agentId, resolvedConversationId, limit + 1)
      : this.statements.nextPage.all(agentId, resolvedConversationId, beforeSeq, limit + 1);

    const hasNext = rows.length > limit;
    const selected = hasNext ? rows.slice(0, limit) : rows;
    const pageRows = [...selected].reverse();
    const page: TranscriptPage = { entries: pageRows.map((row) => this.readRow(row)) };
    if (hasNext && pageRows[0]) page.nextBeforeSeq = pageRows[0].sequence_id;
    return page;
  }

  openAgentTail(agentId: string, limit = DEFAULT_TRANSCRIPT_PAGE_LIMIT, beforeSeq?: number, conversationId?: string): TranscriptPage {
    if (beforeSeq !== undefined) return this.getAgentTranscriptTail(agentId, limit, beforeSeq, conversationId);
    validateAgentId(agentId);
    validateLimit(limit);
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const rows = this.statements.firstPage.all(agentId, resolvedConversationId, limit + 1);
    const hasNext = rows.length > limit;
    const durable = (hasNext ? rows.slice(0, limit) : rows).reverse();
    const live = this.liveFor(agentId, resolvedConversationId);
    if (live === undefined || live.size === 0) {
      const page: TranscriptPage = { entries: durable.map((row) => this.readRow(row)) };
      if (hasNext && durable[0]) page.nextBeforeSeq = durable[0].sequence_id;
      return page;
    }
    // Live previews replace their durable row in place or append after it.
    // Trimming the merged page to `limit` drops the oldest durable rows, so
    // the cursor must point at the oldest row still shown.
    const consumed = new Set<string>();
    const merged: Array<{ entry: TranscriptEntry; sequenceId?: number }> = durable.map((row) => {
      const entry = this.readRow(row);
      const id = transcriptEntryId(entry);
      const preview = id === undefined ? undefined : live.get(id);
      if (id !== undefined && preview !== undefined) consumed.add(id);
      return { entry: preview ?? entry, sequenceId: row.sequence_id };
    });
    for (const [id, preview] of live) if (!consumed.has(id)) merged.push({ entry: preview });
    const shown = merged.slice(-limit);
    const page: TranscriptPage = { entries: shown.map((item) => item.entry) };
    const oldestShown = shown.find((item) => item.sequenceId !== undefined)?.sequenceId;
    const newestDurable = durable.at(-1)?.sequence_id;
    if (merged.length > shown.length || hasNext) {
      const cursor = oldestShown ?? (newestDurable === undefined ? undefined : newestDurable + 1);
      if (cursor !== undefined) page.nextBeforeSeq = cursor;
    }
    return page;
  }

  /**
   * Reconnect/resync seam: return only rows committed to SQLite.  The normal
   * `openAgentTail` intentionally merges the process-local live preview for
   * the active renderer, but that preview is not authoritative after a
   * dropped connection or process restart.
   */
  openDurableAgentTail(agentId: string, limit = DEFAULT_TRANSCRIPT_PAGE_LIMIT, beforeSeq?: number, conversationId?: string): TranscriptPage {
    return this.getAgentTranscriptTail(agentId, limit, beforeSeq, conversationId);
  }

  setLiveEntry(agentId: string, entry: TranscriptEntry, conversationId?: string): void {
    validateAgentId(agentId);
    this.ensureOpen();
    const id = transcriptEntryId(entry);
    if (id === undefined || id.length === 0) return;
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    this.liveFor(agentId, resolvedConversationId, true)!.set(id, normalizeTranscriptEntry(entry));
  }

  clearLiveEntry(agentId: string, entryId: string, conversationId?: string): void {
    validateAgentId(agentId);
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    this.liveFor(agentId, resolvedConversationId)?.delete(entryId);
  }

  replace(agentId: string, entryId: string, entry: TranscriptEntry, conversationId?: string): boolean {
    validateAgentId(agentId);
    this.ensureOpen();
    if (typeof entryId !== "string" || entryId.length === 0) return false;
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const result = this.statements.replaceEntry.run(serializeEntry(entry), agentId, resolvedConversationId, entryId);
    return result.changes > 0;
  }

  replaceToolCallByLocalId(
    agentId: string,
    localToolCallId: string,
    entry: Extract<TranscriptEntry, { kind: "tool-call" }>,
    conversationId?: string,
  ): boolean {
    validateAgentId(agentId);
    this.ensureOpen();
    if (localToolCallId.length === 0) return false;
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const entryId = typeof entry.id === "string" ? entry.id : null;
    const result = this.statements.replaceToolCallByLocalId.run(
      entryId,
      serializeEntry(entry),
      agentId,
      resolvedConversationId,
      localToolCallId,
    );
    return result.changes > 0;
  }

  getRecentEntries(agentId: string, options: RecentEntriesOptions, conversationId?: string): readonly TranscriptEntry[] {
    validateAgentId(agentId);
    if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error("limit inválido");
    if (options.afterSequenceId !== undefined && (!Number.isSafeInteger(options.afterSequenceId) || options.afterSequenceId < 0)) {
      throw new Error("afterSequenceId inválido");
    }
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const afterSequenceId = options.afterSequenceId ?? 0;
    const rows = options.kinds === undefined
      ? this.statements.recentEntries.all(agentId, resolvedConversationId, afterSequenceId, options.limit)
      : this.statements.recentEntriesByKinds.all(agentId, resolvedConversationId, afterSequenceId, JSON.stringify([...new Set(options.kinds)]), options.limit);
    return rows.reverse().map((row) => this.readRow(row));
  }

  getLatestAssistant(agentId: string, conversationId?: string): Extract<TranscriptEntry, { kind: "message" }> | undefined {
    validateAgentId(agentId);
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const row = this.statements.latestAssistant.get(agentId, resolvedConversationId);
    return row === undefined ? undefined : readMessageEntry(row.payload_json);
  }

  getOpenToolCalls(agentId: string, conversationId?: string): readonly Extract<TranscriptEntry, { kind: "tool-call" }>[] {
    validateAgentId(agentId);
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const rows = this.statements.openToolCalls.all(agentId, resolvedConversationId);
    // An unreadable open call cannot be reconciled; it is reported by bulk reads.
    return rows.flatMap((row) => {
      const entry = readToolCallEntry(row.payload_json);
      return entry === undefined ? [] : [entry];
    });
  }

  findToolCallByLocalId(
    agentId: string,
    localToolCallId: string,
    conversationId?: string,
  ): Extract<TranscriptEntry, { kind: "tool-call" }> | undefined {
    validateAgentId(agentId);
    if (typeof localToolCallId !== "string" || localToolCallId.length === 0) return undefined;
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const row = this.statements.findToolCallByLocalId.get(agentId, resolvedConversationId, localToolCallId);
    return row === undefined ? undefined : readToolCallEntry(row.payload_json);
  }

  getEarliestUser(agentId: string, conversationId?: string): Extract<TranscriptEntry, { kind: "message" }> | undefined {
    validateAgentId(agentId);
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const row = this.statements.firstUserMessage.get(agentId, resolvedConversationId);
    return row === undefined ? undefined : readMessageEntry(row.payload_json);
  }

  getConversationOutline(agentId: string, conversationId?: string): ConversationOutline {
    validateAgentId(agentId);
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const firstRow = this.statements.firstUserMessage.get(agentId, resolvedConversationId);
    const lastRow = this.statements.latestNonEmptyMessage.get(agentId, resolvedConversationId);
    const firstUser = firstRow === undefined ? undefined : readMessageEntry(firstRow.payload_json);
    const last = lastRow === undefined ? undefined : readMessageEntry(lastRow.payload_json);
    return { title: firstUser?.content ?? null, lastMessage: last?.content ?? null };
  }

  getLatestSequenceId(agentId: string, conversationId?: string): number | null {
    validateAgentId(agentId);
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const row = this.sql<unknown[], { sequence_id: number | null }>(`
      SELECT MAX(sequence_id) AS sequence_id
      FROM transcript_entries
      WHERE agent_id = ? AND conversation_id = ?
    `).get(agentId, resolvedConversationId);
    return row?.sequence_id ?? null;
  }

  getEntriesBySequenceRange(
    agentId: string,
    fromSequenceId: number,
    throughSequenceId: number,
    conversationId?: string,
  ): readonly TranscriptEntry[] {
    return this.getEntriesWithSequenceByRange(agentId, fromSequenceId, throughSequenceId, conversationId)
      .map((row) => row.entry);
  }

  getEntriesWithSequenceByRange(
    agentId: string,
    fromSequenceId: number,
    throughSequenceId: number,
    conversationId?: string,
  ): readonly { sequenceId: number; entry: TranscriptEntry }[] {
    validateAgentId(agentId);
    if (!Number.isSafeInteger(fromSequenceId) || fromSequenceId < 0) throw new Error("fromSequenceId inválido");
    if (!Number.isSafeInteger(throughSequenceId) || throughSequenceId < fromSequenceId) throw new Error("throughSequenceId inválido");
    this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const rows = this.sql<unknown[], PageRow>(`
      SELECT sequence_id, payload_json
      FROM transcript_entries
      WHERE agent_id = ? AND conversation_id = ? AND sequence_id BETWEEN ? AND ?
      ORDER BY sequence_id ASC
    `).all(agentId, resolvedConversationId, fromSequenceId, throughSequenceId);
    return rows.map((row) => ({ sequenceId: row.sequence_id, entry: this.readRow(row) }));
  }

  getInteractionDecision(agentId: string, requestId: string, kind: string, conversationId?: string): InteractionDecision | null {
    validateAgentId(agentId); this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    const row = this.statements.getInteractionDecision.get(agentId, resolvedConversationId, requestId, kind);
    return row ? { agentId: row.agent_id, requestId: row.request_id, kind: row.kind, decision: row.decision, createdAtMs: row.created_at_ms } : null;
  }

  /**
   * Records the first decision for a request. Decisions are unique per agent
   * (UNIQUE(agent_id, request_id, kind)), so the stored one is returned even
   * when it was recorded from another conversation.
   */
  rememberInteractionDecision(agentId: string, requestId: string, kind: string, decision: string, conversationId?: string): InteractionDecision {
    validateAgentId(agentId); this.ensureOpen();
    const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
    this.statements.insertInteractionDecision.run(agentId, resolvedConversationId, requestId, kind, decision, Date.now());
    const row = this.sql<unknown[], InteractionDecisionRow>(
      "SELECT agent_id, request_id, kind, decision, created_at_ms FROM interaction_decisions WHERE agent_id = ? AND request_id = ? AND kind = ?",
    ).get(agentId, requestId, kind);
    if (row === undefined) throw new Error("store: decisão de interação não foi registrada");
    return { agentId: row.agent_id, requestId: row.request_id, kind: row.kind, decision: row.decision, createdAtMs: row.created_at_ms };
  }

  close(): void {
    if (this.closed) return;
    this.liveEntries.clear();
    this.statementCache.clear();
    this.unregisterOwnership();
    this.memoryStore.close();
    this.conversationStore.close();
    if (this.ownsDatabase) {
      // Cheap, and recommended before closing: refreshes planner statistics
      // only for tables whose shape changed.
      try { this.db.pragma("optimize"); } catch { /* best effort */ }
      this.db.close();
    }
    this.closed = true;
  }
}
