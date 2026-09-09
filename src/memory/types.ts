import type Database from "better-sqlite3";

export type MemoryMode = "automatic" | "explicit" | "off";
export type MemoryKind =
  | "identity"
  | "preference"
  | "constraint"
  | "decision"
  | "fact"
  | "procedure"
  | "open_loop";
export type MemoryScope = "agent" | "user";
export const USER_PROFILE_AGENT_ID = "__openbot_user_profile__";
export const USER_PROFILE_KINDS: readonly MemoryKind[] = ["identity", "preference"];
export type MemoryTrust = "user" | "verified_tool" | "external_observation";
export type MemoryStatus = "active" | "superseded" | "forgotten" | "expired";
export type MemoryJobStatus = "pending" | "running" | "retry" | "complete" | "dead";
export type MemoryDeletePolicy = "delete-derived" | "retain";

export type MemoryMutationAuthority =
  | { kind: "user"; expectedRevision?: number }
  | { kind: "automatic"; conversationId: string; evidenceIds: readonly string[]; expectedRevision?: number }
  | { kind: "admin"; expectedRevision?: number };

export type MemoryMutationRejectionCode =
  | "protected_target"
  | "revision_conflict"
  | "invalid_authority";

export interface MemorySettings {
  agentId: string;
  mode: MemoryMode;
  updatedAtMs: number;
}

export interface MemorySourceRef {
  conversationId: string;
  entryId: string;
}

export type MemorySourceEntry = string | MemorySourceRef;

/** Local provenance for generated replies; never sent as model instructions. */
export type MemoryContextSource =
  | { memoryId: string }
  | { conversationId: string; entryId: string }
  | { conversationId: string; throughSequenceId: number; updatedAtMs: number };

export interface Memory {
  id: string;
  agentId: string;
  kind: MemoryKind;
  canonicalKey: string;
  text: string;
  valueJson: unknown | null;
  trust: MemoryTrust;
  status: MemoryStatus;
  importance: number;
  confidence: number;
  pinned: boolean;
  sourceConversationId: string | null;
  sourceEntryIds: MemorySourceEntry[];
  validFromMs: number;
  validToMs: number | null;
  expiresAtMs: number | null;
  supersededBy: string | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface MemoryUpsertInput {
  id?: string;
  agentId?: string;
  /** Refuse material changes to an active canonical key; exact repeats are no-ops. */
  createOnly?: boolean;
  kind: MemoryKind;
  canonicalKey: string;
  text: string;
  valueJson?: unknown | null;
  trust: MemoryTrust;
  status?: MemoryStatus;
  importance?: number;
  confidence?: number;
  pinned?: boolean;
  sourceConversationId?: string | null;
  sourceEntryIds?: readonly MemorySourceEntry[];
  validFromMs?: number;
  validToMs?: number | null;
  expiresAtMs?: number | null;
  nowMs?: number;
}

export interface MemoryListOptions {
  automatic?: boolean;
  includeInactive?: boolean;
  includeExpired?: boolean;
  kind?: MemoryKind | readonly MemoryKind[];
  limit?: number;
  conversationId?: string;
}

export interface MemoryPageOptions extends MemoryListOptions {
  cursor?: string;
  query?: string;
}

export interface MemoryPage {
  items: Memory[];
  nextCursor?: string;
}

export interface MemorySearchOptions extends MemoryListOptions {}

export function memoryContextSources(memory: Memory): MemoryContextSource[] {
  return [{ memoryId: memory.id }, ...memory.sourceEntryIds.flatMap((source) => typeof source !== "string"
    ? [source]
    : memory.sourceConversationId === null ? [] : [{ conversationId: memory.sourceConversationId, entryId: source }])];
}

export interface MemorySearchResult {
  memory: Memory;
  snippet: string;
  score: number;
  provenance: {
    sourceConversationId: string | null;
    sourceEntryIds: MemorySourceEntry[];
  };
}

export interface ConversationSummary {
  conversationId: string;
  agentId: string;
  revision: number;
  throughSequenceId: number;
  summaryJson: unknown;
  renderedText: string;
  updatedAtMs: number;
  retained: boolean;
}

export interface ConversationSummaryInput {
  conversationId: string;
  agentId?: string;
  expectedPreviousRevision?: number;
  throughSequenceId: number;
  summaryJson: unknown;
  renderedText: string;
  updatedAtMs?: number;
}

export type HistoryResultKind = "memory" | "summary" | "message";

export interface HistorySearchResult {
  kind: HistoryResultKind;
  snippet: string;
  score: number;
  agentId: string;
  conversationId: string | null;
  sequenceId: number | null;
  provenance: {
    source: "memory" | "summary" | "transcript";
    memoryId?: string;
    sourceEntryIds?: MemorySourceEntry[];
  };
  memory?: Memory;
  summary?: ConversationSummary;
}

export interface HistorySearchOptions {
  automatic?: boolean;
  conversationId?: string;
  excludeConversationId?: string;
  limit?: number;
  includeMemories?: boolean;
}

export interface TranscriptSearchOptions {
  conversationId?: string;
  limit?: number;
  /** Stable opaque cursor returned by a previous page. */
  cursor?: string;
}

export interface TranscriptSearchItem {
  entryId: string | null;
  sequenceId: number;
  kind: string;
  conversationId: string | null;
  snippet: string;
  score: number;
}

export interface TranscriptSearchPage {
  items: TranscriptSearchItem[];
  nextCursor?: string;
}

export interface MemoryJob {
  id: string;
  agentId: string;
  conversationId: string;
  provider: string;
  model: string;
  reasoningEffort?: import("../shared/contracts.js").ReasoningEffort;
  fromSequenceId: number;
  throughSequenceId: number;
  summaryRequested: boolean;
  memoryRequested: boolean;
  status: MemoryJobStatus;
  attempts: number;
  nextAttemptAtMs: number;
  lastErrorCode: string | null;
  lastErrorText: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface MemoryJobInput {
  id?: string;
  agentId: string;
  conversationId: string;
  provider?: string;
  model?: string;
  reasoningEffort?: import("../shared/contracts.js").ReasoningEffort;
  fromSequenceId: number;
  throughSequenceId: number;
  summaryRequested?: boolean;
  memoryRequested?: boolean;
  status?: MemoryJobStatus;
  attempts?: number;
  nextAttemptAtMs?: number;
  lastErrorCode?: string | null;
  lastErrorText?: string | null;
  nowMs?: number;
}

export interface MemoryJobError {
  code?: string;
  text?: string;
}

export interface MemoryJobRetryPolicy {
  maxAttempts?: number;
  backoffMs?: readonly number[];
}

export interface MemoryDeadJobSample {
  id: string;
  conversationId: string;
  attempts: number;
  lastErrorCode: string | null;
}

export interface MemoryStatusCounts {
  active: number;
  pinned: number;
  inactive: number;
  jobs: {
    pending: number;
    running: number;
    retry: number;
    dead: number;
    deadSample: readonly MemoryDeadJobSample[];
  };
}

export interface MemoryRevision {
  id: number;
  memoryId: string;
  revision: number;
  snapshotJson: unknown;
  reason: string;
  createdAtMs: number;
}

export interface MemoryAgentSnapshot {
  settings: MemorySettings | null;
  memories: Memory[];
  revisions: MemoryRevision[];
  summaries: ConversationSummary[];
  jobs: MemoryJob[];
}

export interface MemoryStore {
  getSettings(agentId: string): MemorySettings;
  setSettings(agentId: string, mode: MemoryMode): MemorySettings;
  getMemory(agentId: string, memoryId: string): Memory | null;
  get(agentId: string, memoryId: string): Memory | null;
  /** Direct lookup by the active unique key (expects an already-normalized key). Optional so external stores keep working. */
  getMemoryByCanonicalKey?(agentId: string, canonicalKey: string): Memory | null;
  upsertMemory(input: MemoryUpsertInput & { agentId: string; authority: MemoryMutationAuthority }): Memory;
  upsertMemory(agentId: string, input: MemoryUpsertInput, authority: MemoryMutationAuthority): Memory;
  upsert(input: MemoryUpsertInput & { agentId: string; authority: MemoryMutationAuthority }): Memory;
  upsert(agentId: string, input: MemoryUpsertInput, authority: MemoryMutationAuthority): Memory;
  supersedeMemory(agentId: string, memoryId: string, authority: MemoryMutationAuthority, replacement?: MemoryUpsertInput, reason?: string): Memory;
  forgetMemory(agentId: string, memoryId: string, authority: MemoryMutationAuthority, reason?: string): Memory;
  listMemories(agentId: string, options?: MemoryListOptions): readonly Memory[];
  listMemoriesPage(agentId: string, options?: MemoryPageOptions): MemoryPage;
  list(agentId: string, options?: MemoryListOptions): readonly Memory[];
  searchMemories(agentId: string, query: string, options?: MemorySearchOptions): readonly MemorySearchResult[];
  search(agentId: string, query: string, options?: MemorySearchOptions): readonly MemorySearchResult[];
  getSummary(agentId: string, conversationId: string, automatic?: boolean): ConversationSummary | null;
  getForgottenSourceIds(agentId: string, conversationId: string): ReadonlySet<string>;
  hasForgottenContextSources(agentId: string, sources: readonly MemoryContextSource[]): boolean;
  upsertSummary(input: ConversationSummaryInput & { agentId: string }): ConversationSummary;
  upsertSummary(agentId: string, input: ConversationSummaryInput): ConversationSummary;
  searchHistory(agentId: string, query: string, options?: HistorySearchOptions): readonly HistorySearchResult[];
  /**
   * P2.3 agent/conversation-scoped FTS transcript search with a stable cursor
   * and bounded snippets. Returns entries that resolve to persisted messages.
   */
  searchTranscript?(agentId: string, query: string, options?: TranscriptSearchOptions): TranscriptSearchPage;
  enqueueJob(input: MemoryJobInput): MemoryJob;
  getJob(agentId: string, jobId: string): MemoryJob | null;
  getLatestCompletedJobBoundary(agentId: string, conversationId: string, output: "summary" | "memory"): number | null;
  isConversationActive(agentId: string, conversationId: string): boolean;
  claimJob(agentId: string, jobId?: string, nowMs?: number): MemoryJob | null;
  completeJob(agentId: string, jobId: string, nowMs?: number): MemoryJob | null;
  retryJob(agentId: string, jobId: string, error?: MemoryJobError, nowMs?: number, policy?: MemoryJobRetryPolicy): MemoryJob | null;
  deadJob(agentId: string, jobId: string, error?: MemoryJobError, nowMs?: number): MemoryJob | null;
  cancelConversationJobs(agentId: string, conversationId: string, error?: MemoryJobError, nowMs?: number): number;
  listJobs(agentId: string, options?: { status?: MemoryJobStatus | readonly MemoryJobStatus[]; limit?: number }): readonly MemoryJob[];
  getStatusCounts(agentId: string, options?: { deadSampleLimit?: number }): MemoryStatusCounts;
  listRunnableJobs(nowMs?: number, limit?: number): readonly MemoryJob[];
  resetRunningJobs(nowMs?: number): number;
  rebuildFts(): void;
  deleteConversationDerived(agentId: string, conversationId: string, policy: MemoryDeletePolicy): void;
  snapshotAgent(agentId: string): MemoryAgentSnapshot;
  validateAgentSnapshot(agentId: string, snapshot: MemoryAgentSnapshot): void;
  validateAgentRows(agentId: string, snapshot: MemoryAgentSnapshot): void;
  restoreAgent(agentId: string, snapshot: MemoryAgentSnapshot): void;
  clear(agentId: string): void;
  close(): void;
  /** Shared SQLite transaction seam used by reflection application and transcript snapshots. */
  transaction<T>(fn: () => T): T;
  /** Internal row operations used by the transcript store's larger transaction. */
  clearAgentRows(agentId: string): void;
  restoreAgentRows(agentId: string, snapshot: MemoryAgentSnapshot, rebuildFts?: boolean): void;
}

export interface SqliteMemoryStoreOptions {
  path: string;
  database?: Database.Database;
  /** Compatibility aliases for callers that call the shared handle db/connection. */
  db?: Database.Database;
  connection?: Database.Database;
  now?: () => number;
  secretValues?: () => readonly string[];
}
