import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

export const OPENBOT_SCHEMA_VERSION = 16;

const CONVERSATION_BOUND_TABLES = [
  "transcript_entries",
  "accepted_nonces",
  "pending_nonces",
  "interaction_decisions",
  "turn_attempts",
  "turn_completions",
] as const;

type ConversationBoundTable = (typeof CONVERSATION_BOUND_TABLES)[number];

type TableInfoRow = { name: string };
type ConversationRow = {
  id: string;
  agent_id: string;
  title: string;
  title_source: "auto" | "manual";
  temporary: number;
  archived_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  last_message_at_ms: number | null;
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.pragma(`table_info(${quoteIdentifier(table)})`) as TableInfoRow[]).map((column) => column.name),
  );
}

function validateAgentId(agentId: string): void {
  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    throw new Error("agentId deve ser uma string não vazia");
  }
}

/** Stable UUID-shaped id used when rows from the v2 agent partition are migrated. */
export function legacyConversationId(agentId: string): string {
  validateAgentId(agentId);
  const digest = createHash("sha256").update(`openbot:legacy-conversation:${agentId}`, "utf8").digest("hex");
  const bytes = digest.slice(0, 32).split("");
  bytes[12] = "5";
  bytes[16] = ["8", "9", "a", "b"][Number.parseInt(bytes[16]!, 16) % 4]!;
  return `${bytes.slice(0, 8).join("")}-${bytes.slice(8, 12).join("")}-${bytes.slice(12, 16).join("")}-${bytes.slice(16, 20).join("")}-${bytes.slice(20).join("")}`;
}

function createBaseSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_entries (
      sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      conversation_id TEXT,
      entry_id TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transcript_agent_sequence
      ON transcript_entries(agent_id, sequence_id);
    CREATE INDEX IF NOT EXISTS idx_transcript_agent_entry
      ON transcript_entries(agent_id, entry_id);
    CREATE INDEX IF NOT EXISTS idx_transcript_tool_local_id
      ON transcript_entries(agent_id, json_extract(payload_json, '$.localToolCallId'), sequence_id)
      WHERE kind = 'tool-call';
    CREATE TABLE IF NOT EXISTS accepted_nonces (
      agent_id TEXT NOT NULL,
      conversation_id TEXT,
      nonce TEXT NOT NULL,
      accepted_at_ms INTEGER NOT NULL,
      PRIMARY KEY (agent_id, conversation_id, nonce)
    );
    CREATE INDEX IF NOT EXISTS idx_nonce_agent_time
      ON accepted_nonces(agent_id, accepted_at_ms);
    CREATE TABLE IF NOT EXISTS pending_nonces (
      agent_id TEXT NOT NULL,
      conversation_id TEXT,
      nonce TEXT NOT NULL,
      accepted_at_ms INTEGER NOT NULL,
      PRIMARY KEY (agent_id, conversation_id, nonce)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_nonce_agent_time
      ON pending_nonces(agent_id, accepted_at_ms);
    CREATE TABLE IF NOT EXISTS interaction_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      conversation_id TEXT,
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      decision TEXT NOT NULL,
      metadata_json TEXT,
      created_at_ms INTEGER NOT NULL,
      UNIQUE(agent_id, request_id, kind)
    );
    CREATE TABLE IF NOT EXISTS runtime_owners (
      token TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      process_started_at_ms REAL,
      executable_path TEXT
    );
    CREATE TABLE IF NOT EXISTS turn_attempts (
      turn_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      conversation_id TEXT,
      client_nonce TEXT,
      retry_of_client_nonce TEXT,
      retry_failure_turn_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      phase TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turn_attempts_agent
      ON turn_attempts(agent_id, started_at_ms);
    CREATE TABLE IF NOT EXISTS turn_completions (
      agent_id TEXT NOT NULL,
      conversation_id TEXT,
      client_nonce TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      completed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (agent_id, conversation_id, client_nonce),
      UNIQUE (turn_id)
    );
    CREATE INDEX IF NOT EXISTS idx_turn_completions_agent_time
      ON turn_completions(agent_id, completed_at_ms);

    CREATE TABLE IF NOT EXISTS agent_conversations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      title_source TEXT NOT NULL CHECK (title_source IN ('auto', 'manual')),
      temporary INTEGER NOT NULL CHECK (temporary IN (0, 1)),
      archived_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      last_message_at_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_conversations_agent_updated
      ON agent_conversations(agent_id, updated_at_ms DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_conversations_agent_archived
      ON agent_conversations(agent_id, archived_at_ms, updated_at_ms DESC, id DESC);
    CREATE TABLE IF NOT EXISTS agent_conversation_state (
      agent_id TEXT PRIMARY KEY,
      active_conversation_id TEXT NOT NULL,
      FOREIGN KEY (active_conversation_id) REFERENCES agent_conversations(id) ON DELETE RESTRICT
    );

  `);
}

/** Durable control-plane records for depth-1 asynchronous subagent tasks. */
function createAsyncTaskSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS async_tasks (
      task_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      parent_turn_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'subagent'),
      status TEXT NOT NULL CHECK (status IN ('queued', 'admitted', 'running', 'retry_wait', 'cancelling', 'completed', 'failed', 'cancelled', 'abandoned')),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      version INTEGER NOT NULL CHECK (version >= 1),
      client_nonce TEXT NOT NULL,
      depth INTEGER NOT NULL CHECK (depth = 1),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      started_at_ms INTEGER,
      finished_at_ms INTEGER,
      next_attempt_at_ms INTEGER,
      lease_owner TEXT,
      lease_expires_at_ms INTEGER,
      lease_attempt INTEGER,
      lease_version INTEGER,
      progress_json TEXT,
      result_json TEXT,
      error_json TEXT,
      settled_at_ms INTEGER,
      settlement_nonce TEXT,
      steer_intent_json TEXT,
      steer_version INTEGER NOT NULL DEFAULT 0 CHECK (steer_version >= 0),
      abort_intent_json TEXT,
      abort_version INTEGER NOT NULL DEFAULT 0 CHECK (abort_version >= 0),
      lineage_json TEXT NOT NULL,
      input_json TEXT NOT NULL,
      UNIQUE(agent_id, client_nonce),
      CHECK ((lease_owner IS NULL AND lease_expires_at_ms IS NULL AND lease_attempt IS NULL AND lease_version IS NULL)
        OR (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL AND lease_attempt IS NOT NULL AND lease_version IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_async_tasks_claim
      ON async_tasks(agent_id, status, next_attempt_at_ms, created_at_ms, task_id);
    CREATE INDEX IF NOT EXISTS idx_async_tasks_list
      ON async_tasks(agent_id, created_at_ms, task_id);
    CREATE INDEX IF NOT EXISTS idx_async_tasks_parent_lineage
      ON async_tasks(agent_id, parent_turn_id, created_at_ms, task_id);
    CREATE INDEX IF NOT EXISTS idx_async_tasks_lease_expiry
      ON async_tasks(status, lease_expires_at_ms);

    CREATE TABLE IF NOT EXISTS async_task_attempts (
      attempt_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      status TEXT NOT NULL CHECK (status IN ('admitted', 'running', 'retry_wait', 'cancelling', 'completed', 'failed', 'cancelled', 'abandoned')),
      version INTEGER NOT NULL CHECK (version >= 1),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      started_at_ms INTEGER,
      finished_at_ms INTEGER,
      lease_owner TEXT,
      lease_expires_at_ms INTEGER,
      lease_version INTEGER,
      error_json TEXT,
      FOREIGN KEY (task_id) REFERENCES async_tasks(task_id) ON DELETE CASCADE,
      UNIQUE(task_id, attempt),
      CHECK ((lease_owner IS NULL AND lease_expires_at_ms IS NULL AND lease_version IS NULL)
        OR (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL AND lease_version IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_async_task_attempts_task
      ON async_task_attempts(task_id, attempt);

    CREATE TABLE IF NOT EXISTS async_task_grants (
      task_id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL UNIQUE,
      grant_json TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      revoked_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      FOREIGN KEY (task_id) REFERENCES async_tasks(task_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS async_task_budget_usage (
      task_id TEXT PRIMARY KEY,
      budget_json TEXT NOT NULL,
      usage_json TEXT NOT NULL,
      wall_used_ms INTEGER NOT NULL DEFAULT 0 CHECK (wall_used_ms >= 0),
      wall_reserved_ms INTEGER NOT NULL DEFAULT 0 CHECK (wall_reserved_ms >= 0),
      wall_reservations_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL CHECK (version >= 1),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      FOREIGN KEY (task_id) REFERENCES async_tasks(task_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS async_task_parent_budget_usage (
      agent_id TEXT NOT NULL,
      parent_turn_id TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      usage_json TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      PRIMARY KEY (agent_id, parent_turn_id)
    );

    CREATE TABLE IF NOT EXISTS async_task_outbox (
      outbox_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      transition_version INTEGER NOT NULL CHECK (transition_version >= 1),
      wake_kind TEXT NOT NULL CHECK (wake_kind IN ('task_created', 'task_progress', 'task_terminal', 'task_steer', 'task_abort', 'task_recovered')),
      payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      delivered_at_ms INTEGER,
      FOREIGN KEY (task_id) REFERENCES async_tasks(task_id) ON DELETE CASCADE,
      UNIQUE(task_id, transition_version, wake_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_async_task_outbox_undelivered
      ON async_task_outbox(delivered_at_ms, created_at_ms, outbox_id);

    CREATE TABLE IF NOT EXISTS async_task_agent_fences (
      agent_id TEXT PRIMARY KEY,
      fenced_at_ms INTEGER NOT NULL CHECK (fenced_at_ms >= 0)
    );
    CREATE TABLE IF NOT EXISTS async_task_projection_state (
      agent_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      epoch TEXT NOT NULL,
      next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1),
      PRIMARY KEY (agent_id, channel)
    );
    CREATE TABLE IF NOT EXISTS async_task_projection_outbox (
      projection_id TEXT PRIMARY KEY,
      source_outbox_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      epoch TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      task_id TEXT NOT NULL,
      snapshot_version INTEGER NOT NULL CHECK (snapshot_version >= 1),
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      delivered_at_ms INTEGER,
      UNIQUE(source_outbox_id, channel),
      UNIQUE(agent_id, channel, epoch, sequence),
      FOREIGN KEY (task_id) REFERENCES async_tasks(task_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_async_task_projection_pending
      ON async_task_projection_outbox(delivered_at_ms, agent_id, channel, created_at_ms, sequence);
  `);
}

/** Durable agent-to-agent collaboration state. SQLite is the authority for
 * identity incarnations, deletion fences, delivery and SSE projection. */
function createA2ASchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS a2a_agent_incarnations (
      agent_id TEXT NOT NULL,
      incarnation TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      retired_at_ms INTEGER,
      PRIMARY KEY (agent_id, incarnation)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_a2a_active_incarnation
      ON a2a_agent_incarnations(agent_id) WHERE status = 'active';
    CREATE TABLE IF NOT EXISTS a2a_agent_fences (
      agent_id TEXT PRIMARY KEY,
      fenced_at_ms INTEGER NOT NULL CHECK (fenced_at_ms >= 0)
    );
    CREATE TABLE IF NOT EXISTS a2a_messages (
      message_id TEXT PRIMARY KEY,
      sender_agent_id TEXT NOT NULL,
      sender_incarnation TEXT NOT NULL,
      recipient_agent_id TEXT NOT NULL,
      recipient_incarnation TEXT NOT NULL,
      nonce TEXT NOT NULL,
      parent_task_id TEXT,
      parent_turn_id TEXT NOT NULL,
      priority TEXT NOT NULL CHECK (priority IN ('normal', 'high')),
      hop_count INTEGER NOT NULL CHECK (hop_count BETWEEN 0 AND 4),
      payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      available_at_ms INTEGER NOT NULL CHECK (available_at_ms >= 0),
      expires_at_ms INTEGER,
      status TEXT NOT NULL CHECK (status IN ('queued', 'delivering', 'acked', 'rejected', 'dead', 'cancelled')),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      lease_owner TEXT,
      lease_expires_at_ms INTEGER,
      ack_nonce TEXT,
      ack_at_ms INTEGER,
      terminal_reason TEXT,
      UNIQUE(sender_agent_id, sender_incarnation, nonce),
      CHECK ((lease_owner IS NULL AND lease_expires_at_ms IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_a2a_claim
      ON a2a_messages(recipient_agent_id, status, available_at_ms, priority, created_at_ms, message_id);
    CREATE INDEX IF NOT EXISTS idx_a2a_recipient_status
      ON a2a_messages(recipient_agent_id, status, created_at_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_a2a_sender_incarnation_nonce
      ON a2a_messages(sender_agent_id, sender_incarnation, nonce);
    CREATE TABLE IF NOT EXISTS a2a_parent_usage (
      sender_agent_id TEXT NOT NULL,
      sender_incarnation TEXT NOT NULL,
      parent_turn_id TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      byte_count INTEGER NOT NULL DEFAULT 0,
      recipients_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (sender_agent_id, sender_incarnation, parent_turn_id)
    );
    CREATE TABLE IF NOT EXISTS a2a_outbox (
      outbox_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      transition_version INTEGER NOT NULL,
      event_kind TEXT NOT NULL,
      recipient_agent_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      delivered_at_ms INTEGER,
      UNIQUE(message_id, transition_version, event_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_a2a_outbox_pending
      ON a2a_outbox(delivered_at_ms, created_at_ms, outbox_id);
    CREATE TABLE IF NOT EXISTS a2a_projection_state (
      agent_id TEXT PRIMARY KEY,
      epoch TEXT NOT NULL,
      next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1)
    );
    CREATE TABLE IF NOT EXISTS a2a_projection_outbox (
      projection_id TEXT PRIMARY KEY,
      source_outbox_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      epoch TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      transition_version INTEGER NOT NULL,
      event_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      delivered_at_ms INTEGER,
      UNIQUE(agent_id, epoch, sequence),
      UNIQUE(source_outbox_id),
      UNIQUE(message_id, transition_version, event_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_a2a_projection_agent
      ON a2a_projection_outbox(agent_id, epoch, sequence);
  `);
}

/** Isolates nonce dedupe and parent-turn budgets across delete/recreate. Early
 * schema-v10 drafts keyed both only by the visible agent id. */
function migrateA2AIdentitySchema(db: Database.Database): void {
  const messageDefinition = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'a2a_messages'").get() as { sql: string } | undefined;
  const legacyMessageConstraint = /UNIQUE\s*\(\s*sender_agent_id\s*,\s*nonce\s*\)/iu.test(messageDefinition?.sql ?? "")
    || db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ux_a2a_sender_nonce'").get() !== undefined;
  const usageColumns = tableColumns(db, "a2a_parent_usage");
  if (!legacyMessageConstraint && usageColumns.has("sender_incarnation")) return;

  const migrate = db.transaction(() => {
    if (legacyMessageConstraint) {
      db.exec(`
        CREATE TABLE a2a_messages_identity_v10 (
          message_id TEXT PRIMARY KEY,
          sender_agent_id TEXT NOT NULL,
          sender_incarnation TEXT NOT NULL,
          recipient_agent_id TEXT NOT NULL,
          recipient_incarnation TEXT NOT NULL,
          nonce TEXT NOT NULL,
          parent_task_id TEXT,
          parent_turn_id TEXT NOT NULL,
          priority TEXT NOT NULL CHECK (priority IN ('normal', 'high')),
          hop_count INTEGER NOT NULL CHECK (hop_count BETWEEN 0 AND 4),
          payload_json TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          available_at_ms INTEGER NOT NULL CHECK (available_at_ms >= 0),
          expires_at_ms INTEGER,
          status TEXT NOT NULL CHECK (status IN ('queued', 'delivering', 'acked', 'rejected', 'dead', 'cancelled')),
          attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
          version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
          lease_owner TEXT,
          lease_expires_at_ms INTEGER,
          ack_nonce TEXT,
          ack_at_ms INTEGER,
          terminal_reason TEXT,
          UNIQUE(sender_agent_id, sender_incarnation, nonce),
          CHECK ((lease_owner IS NULL AND lease_expires_at_ms IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL))
        );
        INSERT INTO a2a_messages_identity_v10
        SELECT * FROM a2a_messages;
        DROP TABLE a2a_messages;
        ALTER TABLE a2a_messages_identity_v10 RENAME TO a2a_messages;
      `);
    }

    if (!usageColumns.has("sender_incarnation")) {
      db.exec(`
        CREATE TABLE a2a_parent_usage_identity_v10 (
          sender_agent_id TEXT NOT NULL,
          sender_incarnation TEXT NOT NULL,
          parent_turn_id TEXT NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          byte_count INTEGER NOT NULL DEFAULT 0,
          recipients_json TEXT NOT NULL DEFAULT '[]',
          PRIMARY KEY (sender_agent_id, sender_incarnation, parent_turn_id)
        );
        INSERT INTO a2a_parent_usage_identity_v10
          (sender_agent_id, sender_incarnation, parent_turn_id, message_count, byte_count, recipients_json)
        SELECT sender_agent_id, sender_incarnation, parent_turn_id,
          COUNT(*), SUM(length(CAST(payload_json AS BLOB))), json_group_array(DISTINCT recipient_agent_id)
        FROM a2a_messages
        GROUP BY sender_agent_id, sender_incarnation, parent_turn_id;
        DROP TABLE a2a_parent_usage;
        ALTER TABLE a2a_parent_usage_identity_v10 RENAME TO a2a_parent_usage;
      `);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_a2a_claim
        ON a2a_messages(recipient_agent_id, status, available_at_ms, priority, created_at_ms, message_id);
      CREATE INDEX IF NOT EXISTS idx_a2a_recipient_status
        ON a2a_messages(recipient_agent_id, status, created_at_ms);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_a2a_sender_incarnation_nonce
        ON a2a_messages(sender_agent_id, sender_incarnation, nonce);
    `);
  });
  migrate();
}

/** Completes early schema-v10 drafts without discarding already persisted A2A events. */
function migrateA2AProjectionSchema(db: Database.Database): void {
  const columns = tableColumns(db, "a2a_projection_outbox");
  if (!columns.has("source_outbox_id")) {
    db.exec("ALTER TABLE a2a_projection_outbox ADD COLUMN source_outbox_id TEXT");
  }
  db.exec(`
    UPDATE a2a_projection_outbox
    SET source_outbox_id = (
      SELECT source.outbox_id
      FROM a2a_outbox AS source
      WHERE source.message_id = a2a_projection_outbox.message_id
        AND source.transition_version = a2a_projection_outbox.transition_version
        AND source.event_kind = a2a_projection_outbox.event_kind
      LIMIT 1
    )
    WHERE source_outbox_id IS NULL
  `);
  db.exec(`
    UPDATE a2a_projection_outbox
    SET source_outbox_id = projection_id
    WHERE source_outbox_id IS NULL
  `);
  if (!columns.has("delivered_at_ms")) {
    db.exec(`
      ALTER TABLE a2a_projection_outbox ADD COLUMN delivered_at_ms INTEGER`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_a2a_projection_source
      ON a2a_projection_outbox(source_outbox_id) WHERE source_outbox_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_a2a_projection_pending
      ON a2a_projection_outbox(delivered_at_ms, created_at_ms, projection_id);
  `);
}

/** Memory, summary, job and rebuildable FTS tables. Kept here so every store
 * opening the shared connection observes the same schema before preparing SQL. */
function createMemorySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_memory_settings (
      agent_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'automatic' CHECK (mode IN ('automatic', 'explicit', 'off')),
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      through_sequence_id INTEGER NOT NULL CHECK (through_sequence_id >= 0),
      summary_json TEXT NOT NULL,
      rendered_text TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      retained INTEGER NOT NULL DEFAULT 0 CHECK (retained IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_summaries_agent_updated
      ON conversation_summaries(agent_id, updated_at_ms DESC, conversation_id);

    CREATE TABLE IF NOT EXISTS agent_memories (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('identity', 'preference', 'constraint', 'decision', 'fact', 'procedure', 'open_loop')),
      canonical_key TEXT NOT NULL,
      text TEXT NOT NULL,
      value_json TEXT,
      trust TEXT NOT NULL CHECK (trust IN ('user', 'verified_tool', 'external_observation')),
      status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'forgotten', 'expired')),
      importance INTEGER NOT NULL CHECK (importance BETWEEN 0 AND 100),
      confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
      pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
      source_conversation_id TEXT,
      source_entry_ids_json TEXT NOT NULL,
      valid_from_ms INTEGER NOT NULL,
      valid_to_ms INTEGER,
      expires_at_ms INTEGER,
      superseded_by TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_status
      ON agent_memories(agent_id, status, pinned DESC, importance DESC, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_key
      ON agent_memories(agent_id, canonical_key, status);
    CREATE INDEX IF NOT EXISTS idx_agent_memories_source_conversation
      ON agent_memories(agent_id, source_conversation_id);
    CREATE INDEX IF NOT EXISTS idx_agent_memories_page
      ON agent_memories(agent_id, pinned DESC, importance DESC, confidence DESC, updated_at_ms DESC, id ASC);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_memories_active_key
      ON agent_memories(agent_id, canonical_key) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_agent_memories_expiry
      ON agent_memories(agent_id, expires_at_ms) WHERE status = 'active' AND expires_at_ms IS NOT NULL;

    CREATE TABLE IF NOT EXISTS memory_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      snapshot_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY (memory_id) REFERENCES agent_memories(id) ON DELETE CASCADE,
      UNIQUE(memory_id, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_revisions_memory
      ON memory_revisions(memory_id, revision ASC);

    CREATE TABLE IF NOT EXISTS memory_jobs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      from_sequence_id INTEGER NOT NULL CHECK (from_sequence_id >= 0),
      through_sequence_id INTEGER NOT NULL CHECK (through_sequence_id >= from_sequence_id),
      summary_requested INTEGER NOT NULL DEFAULT 1 CHECK (summary_requested IN (0, 1)),
      memory_requested INTEGER NOT NULL DEFAULT 1 CHECK (memory_requested IN (0, 1)),
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'retry', 'complete', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at_ms INTEGER NOT NULL,
      last_error_code TEXT,
      last_error_text TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE(agent_id, conversation_id, through_sequence_id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_jobs_claim
      ON memory_jobs(agent_id, status, next_attempt_at_ms, created_at_ms);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      memory_id UNINDEXED,
      agent_id UNINDEXED,
      canonical_key,
      text,
      value_text
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
      source_id UNINDEXED,
      agent_id UNINDEXED,
      conversation_id UNINDEXED,
      source_type UNINDEXED,
      content,
      sequence_id UNINDEXED
    );

    CREATE TRIGGER IF NOT EXISTS agent_memories_fts_ai
    AFTER INSERT ON agent_memories
    WHEN NEW.status = 'active' AND NOT EXISTS (
      SELECT 1 FROM agent_conversations
      WHERE id = NEW.source_conversation_id AND agent_id = NEW.agent_id AND temporary = 1
    )
    BEGIN
      INSERT INTO memory_fts(memory_id, agent_id, canonical_key, text, value_text)
      VALUES (NEW.id, NEW.agent_id, NEW.canonical_key, NEW.text, COALESCE(NEW.value_json, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS agent_memories_fts_au
    AFTER UPDATE ON agent_memories
    BEGIN
      DELETE FROM memory_fts WHERE memory_id = OLD.id;
      INSERT INTO memory_fts(memory_id, agent_id, canonical_key, text, value_text)
      SELECT NEW.id, NEW.agent_id, NEW.canonical_key, NEW.text, COALESCE(NEW.value_json, '')
      WHERE NEW.status = 'active' AND NOT EXISTS (
        SELECT 1 FROM agent_conversations
        WHERE id = NEW.source_conversation_id AND agent_id = NEW.agent_id AND temporary = 1
      );
    END;
    CREATE TRIGGER IF NOT EXISTS agent_memories_fts_ad
    AFTER DELETE ON agent_memories
    BEGIN
      DELETE FROM memory_fts WHERE memory_id = OLD.id;
    END;

    CREATE TRIGGER IF NOT EXISTS transcript_entries_history_fts_ai
    AFTER INSERT ON transcript_entries
    WHEN NEW.kind = 'message' AND length(trim(COALESCE(json_extract(NEW.payload_json, '$.content'), ''))) > 0
      AND NOT EXISTS (
        SELECT 1 FROM agent_conversations
        WHERE id = NEW.conversation_id AND agent_id = NEW.agent_id AND temporary = 1
      )
    BEGIN
      INSERT INTO history_fts(source_id, agent_id, conversation_id, source_type, content, sequence_id)
      VALUES ('entry:' || NEW.sequence_id, NEW.agent_id, NEW.conversation_id, 'message',
        json_extract(NEW.payload_json, '$.content'), NEW.sequence_id);
    END;
    CREATE TRIGGER IF NOT EXISTS transcript_entries_history_fts_au
    AFTER UPDATE ON transcript_entries
    BEGIN
      DELETE FROM history_fts WHERE source_id = 'entry:' || OLD.sequence_id;
      INSERT INTO history_fts(source_id, agent_id, conversation_id, source_type, content, sequence_id)
      SELECT 'entry:' || NEW.sequence_id, NEW.agent_id, NEW.conversation_id, 'message',
        json_extract(NEW.payload_json, '$.content'), NEW.sequence_id
      WHERE NEW.kind = 'message' AND length(trim(COALESCE(json_extract(NEW.payload_json, '$.content'), ''))) > 0
        AND NOT EXISTS (
          SELECT 1 FROM agent_conversations
          WHERE id = NEW.conversation_id AND agent_id = NEW.agent_id AND temporary = 1
        );
    END;
    CREATE TRIGGER IF NOT EXISTS transcript_entries_history_fts_ad
    AFTER DELETE ON transcript_entries
    BEGIN
      DELETE FROM history_fts WHERE source_id = 'entry:' || OLD.sequence_id;
    END;

  `);
  createConversationSummaryHistoryTriggers(db);
}

function createConversationSummaryHistoryTriggers(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS conversation_summaries_history_fts_ai
    AFTER INSERT ON conversation_summaries
    WHEN NOT EXISTS (
      SELECT 1 FROM agent_conversations
      WHERE id = NEW.conversation_id AND agent_id = NEW.agent_id AND temporary = 1
    )
    BEGIN
      INSERT INTO history_fts(source_id, agent_id, conversation_id, source_type, content, sequence_id)
      VALUES ('summary:' || NEW.conversation_id, NEW.agent_id, NEW.conversation_id, 'summary', NEW.rendered_text, NEW.through_sequence_id);
    END;
    CREATE TRIGGER IF NOT EXISTS conversation_summaries_history_fts_au
    AFTER UPDATE ON conversation_summaries
    BEGIN
      DELETE FROM history_fts WHERE source_id = 'summary:' || OLD.conversation_id;
      INSERT INTO history_fts(source_id, agent_id, conversation_id, source_type, content, sequence_id)
      SELECT 'summary:' || NEW.conversation_id, NEW.agent_id, NEW.conversation_id, 'summary', NEW.rendered_text, NEW.through_sequence_id
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_conversations
        WHERE id = NEW.conversation_id AND agent_id = NEW.agent_id AND temporary = 1
      );
    END;
    CREATE TRIGGER IF NOT EXISTS conversation_summaries_history_fts_ad
    AFTER DELETE ON conversation_summaries
    BEGIN
      DELETE FROM history_fts WHERE source_id = 'summary:' || OLD.conversation_id;
    END;
  `);
}

export function rebuildOpenBotFts(db: Database.Database, now = Date.now()): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      memory_id UNINDEXED,
      agent_id UNINDEXED,
      canonical_key,
      text,
      value_text
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
      source_id UNINDEXED,
      agent_id UNINDEXED,
      conversation_id UNINDEXED,
      source_type UNINDEXED,
      content,
      sequence_id UNINDEXED
    );
    DELETE FROM memory_fts;
    DELETE FROM history_fts;
  `);
  db.prepare(`
    INSERT INTO memory_fts(memory_id, agent_id, canonical_key, text, value_text)
    SELECT m.id, m.agent_id, m.canonical_key, m.text, COALESCE(m.value_json, '')
    FROM agent_memories AS m
    WHERE m.status = 'active' AND m.valid_from_ms <= ? AND (m.valid_to_ms IS NULL OR m.valid_to_ms > ?)
      AND (m.expires_at_ms IS NULL OR m.expires_at_ms > ?)
      AND NOT EXISTS (
        SELECT 1 FROM agent_conversations c
        WHERE c.id = m.source_conversation_id AND c.agent_id = m.agent_id AND c.temporary = 1
      )
  `).run(now, now, now);
  db.prepare(`
    INSERT INTO history_fts(source_id, agent_id, conversation_id, source_type, content, sequence_id)
    SELECT 'entry:' || t.sequence_id, t.agent_id, t.conversation_id, 'message', json_extract(t.payload_json, '$.content'), t.sequence_id
    FROM transcript_entries t
    WHERE t.kind = 'message' AND length(trim(COALESCE(json_extract(t.payload_json, '$.content'), ''))) > 0
      AND NOT EXISTS (
        SELECT 1 FROM agent_conversations c
        WHERE c.id = t.conversation_id AND c.agent_id = t.agent_id AND c.temporary = 1
      )
  `).run();
  db.prepare(`
    INSERT INTO history_fts(source_id, agent_id, conversation_id, source_type, content, sequence_id)
    SELECT 'summary:' || s.conversation_id, s.agent_id, s.conversation_id, 'summary', s.rendered_text, s.through_sequence_id
    FROM conversation_summaries s
    WHERE NOT EXISTS (
      SELECT 1 FROM agent_conversations c
      WHERE c.id = s.conversation_id AND c.agent_id = s.agent_id AND c.temporary = 1
    )
  `).run();
}

function ensureConversationColumn(db: Database.Database, table: ConversationBoundTable): void {
  if (!tableColumns(db, table).has("conversation_id")) {
    db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN conversation_id TEXT`);
  }
}

function timestampBounds(db: Database.Database, agentId: string, fallbackNow: number): {
  createdAtMs: number;
  updatedAtMs: number;
  lastMessageAtMs: number | null;
} {
  const values: number[] = [];
  const addValues = (table: ConversationBoundTable, column: string) => {
    const row = db.prepare(`SELECT MIN(${quoteIdentifier(column)}) AS min_value, MAX(${quoteIdentifier(column)}) AS max_value FROM ${quoteIdentifier(table)} WHERE agent_id = ?`).get(agentId) as { min_value: number | null; max_value: number | null };
    if (typeof row.min_value === "number") values.push(row.min_value);
    if (typeof row.max_value === "number") values.push(row.max_value);
  };
  addValues("transcript_entries", "created_at_ms");
  addValues("accepted_nonces", "accepted_at_ms");
  addValues("pending_nonces", "accepted_at_ms");
  addValues("interaction_decisions", "created_at_ms");
  addValues("turn_attempts", "started_at_ms");
  const lastMessage = db.prepare(`
    SELECT MAX(created_at_ms) AS last_message_at_ms
    FROM transcript_entries
    WHERE agent_id = ? AND kind = 'message'
  `).get(agentId) as { last_message_at_ms: number | null };
  const createdAtMs = values.length > 0 ? Math.min(...values) : fallbackNow;
  const updatedAtMs = values.length > 0 ? Math.max(...values) : fallbackNow;
  return {
    createdAtMs,
    updatedAtMs,
    lastMessageAtMs: typeof lastMessage.last_message_at_ms === "number" ? lastMessage.last_message_at_ms : null,
  };
}

function insertDefaultConversation(db: Database.Database, agentId: string, conversationId: string, now: number): void {
  const bounds = timestampBounds(db, agentId, now);
  db.prepare(`
    INSERT OR IGNORE INTO agent_conversations
      (id, agent_id, title, title_source, temporary, archived_at_ms, created_at_ms, updated_at_ms, last_message_at_ms)
    VALUES (?, ?, 'Nova conversa', 'auto', 0, NULL, ?, ?, ?)
  `).run(conversationId, agentId, bounds.createdAtMs, bounds.updatedAtMs, bounds.lastMessageAtMs);
}

function usedConversationIds(db: Database.Database, table: ConversationBoundTable, agentId: string): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT conversation_id
    FROM ${quoteIdentifier(table)}
    WHERE agent_id = ? AND conversation_id IS NOT NULL AND conversation_id <> ''
  `).all(agentId) as Array<{ conversation_id: string }>;
  return rows.map((row) => row.conversation_id);
}

function hasMissingConversationIds(db: Database.Database, table: ConversationBoundTable, agentId: string): boolean {
  const row = db.prepare(`
    SELECT 1 AS present
    FROM ${quoteIdentifier(table)}
    WHERE agent_id = ? AND (conversation_id IS NULL OR conversation_id = '')
    LIMIT 1
  `).get(agentId) as { present?: number } | undefined;
  return row?.present === 1;
}

function backfillConversationIds(db: Database.Database, now: number): void {
  const agents = new Set<string>();
  const collect = (table: string) => {
    const rows = db.prepare(`SELECT DISTINCT agent_id FROM ${quoteIdentifier(table)}`).all() as Array<{ agent_id: string }>;
    for (const row of rows) agents.add(row.agent_id);
  };
  for (const table of CONVERSATION_BOUND_TABLES) collect(table);
  collect("agent_conversations");

  for (const agentId of agents) {
    const legacyId = legacyConversationId(agentId);
    const usedIds = new Set<string>();
    let hasMissing = false;
    for (const table of CONVERSATION_BOUND_TABLES) {
      for (const id of usedConversationIds(db, table, agentId)) usedIds.add(id);
      hasMissing ||= hasMissingConversationIds(db, table, agentId);
    }
    const domainCount = db.prepare("SELECT COUNT(*) AS count FROM agent_conversations WHERE agent_id = ?").get(agentId) as { count: number };
    if (hasMissing || (usedIds.size === 0 && domainCount.count === 0)) {
      insertDefaultConversation(db, agentId, legacyId, now);
      for (const table of CONVERSATION_BOUND_TABLES) {
        db.prepare(`UPDATE ${quoteIdentifier(table)} SET conversation_id = ? WHERE agent_id = ? AND (conversation_id IS NULL OR conversation_id = '')`).run(legacyId, agentId);
      }
      usedIds.add(legacyId);
    }

    for (const conversationId of usedIds) {
      const existing = db.prepare("SELECT 1 AS present FROM agent_conversations WHERE id = ?").get(conversationId) as { present?: number } | undefined;
      if (existing?.present === 1) continue;
      const bounds = timestampBounds(db, agentId, now);
      db.prepare(`
        INSERT OR IGNORE INTO agent_conversations
          (id, agent_id, title, title_source, temporary, archived_at_ms, created_at_ms, updated_at_ms, last_message_at_ms)
        VALUES (?, ?, 'Nova conversa', 'auto', 0, NULL, ?, ?, ?)
      `).run(conversationId, agentId, bounds.createdAtMs, bounds.updatedAtMs, bounds.lastMessageAtMs);
    }

    const active = db.prepare(`
      SELECT s.active_conversation_id
      FROM agent_conversation_state AS s
      JOIN agent_conversations AS c ON c.id = s.active_conversation_id AND c.agent_id = s.agent_id
      WHERE s.agent_id = ?
    `).get(agentId) as { active_conversation_id: string } | undefined;
    if (active === undefined) {
      const existing = db.prepare(`
        SELECT id FROM agent_conversations
        WHERE agent_id = ?
        ORDER BY updated_at_ms DESC, id DESC
        LIMIT 1
      `).get(agentId) as { id: string } | undefined;
      const target = [...usedIds][0] ?? existing?.id ?? legacyId;
      insertDefaultConversation(db, agentId, target, now);
      db.prepare("INSERT OR IGNORE INTO agent_conversation_state(agent_id, active_conversation_id) VALUES (?, ?)").run(agentId, target);
    }
  }

  for (const table of CONVERSATION_BOUND_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE conversation_id IS NULL`).get() as { count: number };
    if (row.count !== 0) throw new Error(`store: migração deixou ${row.count} linha(s) sem conversation_id em ${table}`);
  }
}

function hasConversationScopedNoncePrimaryKey(db: Database.Database, table: "accepted_nonces" | "pending_nonces"): boolean {
  const columns = db.pragma(`table_info(${quoteIdentifier(table)})`) as Array<{ name: string; pk: number }>;
  const primary = columns.filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk).map((column) => column.name);
  return primary.length === 3 && primary[0] === "agent_id" && primary[1] === "conversation_id" && primary[2] === "nonce";
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { present?: number } | undefined;
  return row?.present === 1;
}

/** Rebuilds the two nonce ledgers because SQLite cannot alter an existing PK in place. */
function migrateNoncePrimaryKeys(db: Database.Database): void {
  for (const table of ["accepted_nonces", "pending_nonces"] as const) {
    const legacy = `${table}_legacy_v4`;
    if (hasConversationScopedNoncePrimaryKey(db, table)) {
      if (tableExists(db, legacy) && tableColumns(db, legacy).has("conversation_id")) {
        db.exec(`
          INSERT OR IGNORE INTO ${quoteIdentifier(table)} (agent_id, conversation_id, nonce, accepted_at_ms)
          SELECT agent_id, conversation_id, nonce, accepted_at_ms FROM ${quoteIdentifier(legacy)}
          WHERE conversation_id IS NOT NULL AND conversation_id <> ''
        `);
        db.exec(`DROP TABLE ${quoteIdentifier(legacy)}`);
      }
      continue;
    }
    if (tableExists(db, legacy)) db.exec(`DROP TABLE ${quoteIdentifier(legacy)}`);
    db.exec(`ALTER TABLE ${quoteIdentifier(table)} RENAME TO ${quoteIdentifier(legacy)}`);
    db.exec(`
      CREATE TABLE ${quoteIdentifier(table)} (
        agent_id TEXT NOT NULL,
        conversation_id TEXT,
        nonce TEXT NOT NULL,
        accepted_at_ms INTEGER NOT NULL,
        PRIMARY KEY (agent_id, conversation_id, nonce)
      )
    `);
    db.exec(`
      INSERT OR IGNORE INTO ${quoteIdentifier(table)} (agent_id, conversation_id, nonce, accepted_at_ms)
      SELECT agent_id, conversation_id, nonce, accepted_at_ms
      FROM ${quoteIdentifier(legacy)}
      WHERE conversation_id IS NOT NULL AND conversation_id <> ''
    `);
    db.exec(`DROP TABLE ${quoteIdentifier(legacy)}`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_nonce_agent_time
      ON accepted_nonces(agent_id, accepted_at_ms);
    CREATE INDEX IF NOT EXISTS idx_pending_nonce_agent_time
      ON pending_nonces(agent_id, accepted_at_ms);
    CREATE INDEX IF NOT EXISTS idx_nonce_agent_conversation_time
      ON accepted_nonces(agent_id, conversation_id, accepted_at_ms);
    CREATE INDEX IF NOT EXISTS idx_pending_nonce_agent_conversation_time
      ON pending_nonces(agent_id, conversation_id, accepted_at_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_nonce_agent_conversation_nonce
      ON accepted_nonces(agent_id, COALESCE(conversation_id, ''), nonce);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_nonce_agent_conversation_nonce
      ON pending_nonces(agent_id, COALESCE(conversation_id, ''), nonce);
  `);
}

function migrateMemoryJobProviderModel(db: Database.Database): void {
  const columns = tableColumns(db, "memory_jobs");
  if (!columns.has("reasoning_effort")) {
    db.exec("ALTER TABLE memory_jobs ADD COLUMN reasoning_effort TEXT");
  }
  if (!columns.has("provider")) {
    db.exec("ALTER TABLE memory_jobs ADD COLUMN provider TEXT");
  }
  if (!columns.has("model")) {
    db.exec("ALTER TABLE memory_jobs ADD COLUMN model TEXT");
  }
  db.exec(`
    UPDATE memory_jobs SET provider = 'legacy-reflection-provider'
    WHERE provider IS NULL OR trim(provider) = '';
    UPDATE memory_jobs SET model = 'legacy-reflection-model'
    WHERE model IS NULL OR trim(model) = '';
  `);
}

function migrateMemoryJobOutputs(db: Database.Database): void {
  const columns = tableColumns(db, "memory_jobs");
  if (!columns.has("summary_requested")) {
    db.exec("ALTER TABLE memory_jobs ADD COLUMN summary_requested INTEGER NOT NULL DEFAULT 1 CHECK (summary_requested IN (0, 1))");
  }
  if (!columns.has("memory_requested")) {
    db.exec("ALTER TABLE memory_jobs ADD COLUMN memory_requested INTEGER NOT NULL DEFAULT 1 CHECK (memory_requested IN (0, 1))");
  }
}

function migrateConversationSummaryRetention(db: Database.Database): void {
  const columns = tableColumns(db, "conversation_summaries");
  const foreignKeys = db.pragma("foreign_key_list(conversation_summaries)") as Array<{ table: string }>;
  const needsRebuild = !columns.has("retained") || foreignKeys.some((row) => row.table === "agent_conversations");
  if (!needsRebuild) return;

  db.exec(`
    DROP TRIGGER IF EXISTS conversation_summaries_history_fts_ai;
    DROP TRIGGER IF EXISTS conversation_summaries_history_fts_au;
    DROP TRIGGER IF EXISTS conversation_summaries_history_fts_ad;
    ALTER TABLE conversation_summaries RENAME TO conversation_summaries_legacy_v6;
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      through_sequence_id INTEGER NOT NULL CHECK (through_sequence_id >= 0),
      summary_json TEXT NOT NULL,
      rendered_text TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      retained INTEGER NOT NULL DEFAULT 0 CHECK (retained IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_summaries_agent_updated
      ON conversation_summaries(agent_id, updated_at_ms DESC, conversation_id);
  `);
  const insertSql = columns.has("retained")
    ? `
      INSERT INTO conversation_summaries(conversation_id, agent_id, revision, through_sequence_id, summary_json, rendered_text, updated_at_ms, retained)
      SELECT conversation_id, agent_id, revision, through_sequence_id, summary_json, rendered_text, updated_at_ms, retained
      FROM conversation_summaries_legacy_v6
    `
    : `
      INSERT INTO conversation_summaries(conversation_id, agent_id, revision, through_sequence_id, summary_json, rendered_text, updated_at_ms, retained)
      SELECT conversation_id, agent_id, revision, through_sequence_id, summary_json, rendered_text, updated_at_ms, 0
      FROM conversation_summaries_legacy_v6
    `;
  db.exec(insertSql);
  db.exec(`
    DROP TABLE conversation_summaries_legacy_v6;
    DELETE FROM history_fts WHERE source_id LIKE 'summary:%';
  `);
  createConversationSummaryHistoryTriggers(db);
  db.prepare(`
    INSERT INTO history_fts(source_id, agent_id, conversation_id, source_type, content, sequence_id)
    SELECT 'summary:' || s.conversation_id, s.agent_id, s.conversation_id, 'summary', s.rendered_text, s.through_sequence_id
    FROM conversation_summaries s
    WHERE NOT EXISTS (
      SELECT 1 FROM agent_conversations c
      WHERE c.id = s.conversation_id AND c.agent_id = s.agent_id AND c.temporary = 1
    )
  `).run();
}

/**
 * Creates the current schema and upgrades every supported earlier schema in place.
 * The function is intentionally independent from either store implementation.
 */
/** P2.3 — server-side attachment staging registry. Bytes live on disk
 * under a controlled staging root; this table holds the durable metadata
 * (owner agent, optional conversation, sanitized filename, kind, size,
 * SHA-256, timestamps, expiry and state). State machine:
 * staged → committed → consumed (discard allowed while not consumed). */
function createP23Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachment_staging (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      conversation_id TEXT,
      filename TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('text', 'pdf', 'image')),
      stored_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      sha256 TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('staged', 'committed', 'discarded')),
      consumed_at_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_attachment_staging_agent_state
      ON attachment_staging(agent_id, state, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_attachment_staging_conversation
      ON attachment_staging(agent_id, conversation_id, state);
    CREATE INDEX IF NOT EXISTS idx_attachment_staging_expiry
      ON attachment_staging(expires_at_ms, state);
  `);
}

/** P2.4 — durable agent/conversation/entry-scoped reactions with nonce dedupe. */
function createP24Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      conversation_id TEXT,
      entry_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      nonce TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('confirmed', 'rejected', 'removed')),
      reason TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE(agent_id, conversation_id, entry_id, emoji, nonce)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_agent_state
      ON reactions(agent_id, state, created_at_ms, id);
    CREATE INDEX IF NOT EXISTS idx_reactions_conversation
      ON reactions(agent_id, conversation_id, state);
  `);
}

/** P2.6 — bounded provider checkpoints and durable effect idempotency ledger. */
function createP26Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      cursor TEXT NOT NULL,
      safe_sequence_id INTEGER NOT NULL CHECK (safe_sequence_id >= 0),
      completed_effect_ids_json TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      budget_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE(agent_id, conversation_id, turn_id)
    );
    CREATE INDEX IF NOT EXISTS idx_turn_checkpoints_agent_expiry
      ON turn_checkpoints(agent_id, expires_at_ms, updated_at_ms);
    CREATE TABLE IF NOT EXISTS turn_effects (
      agent_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      effect_id TEXT NOT NULL,
      fingerprint_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('prepared', 'started', 'completed', 'unsafe')),
      result_json TEXT,
      created_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      PRIMARY KEY (agent_id, conversation_id, turn_id, effect_id)
    );
    CREATE INDEX IF NOT EXISTS idx_turn_effects_agent_status
      ON turn_effects(agent_id, status, created_at_ms);
  `);
}

/** P2.8 — hidden opt-in onboarding runs; never projected into transcript/SSE. */
function createP28Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kickstart_runs (
      agent_id TEXT NOT NULL,
      client_nonce TEXT NOT NULL,
      conversation_id TEXT,
      origin TEXT NOT NULL CHECK (origin = 'kickstart'),
      version INTEGER NOT NULL CHECK (version >= 1),
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      turn_id TEXT,
      provider TEXT,
      model TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retryable', 'completed', 'interrupted', 'cancelled', 'failed')),
      observable_output INTEGER NOT NULL CHECK (observable_output IN (0, 1)),
      result_json TEXT,
      error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (agent_id, client_nonce)
    );
    CREATE INDEX IF NOT EXISTS idx_kickstart_runs_agent_status
      ON kickstart_runs(agent_id, status, updated_at_ms);
  `);
}

/** Durable delete intent. Presence blocks id reuse until reconciliation finishes. */
function createAgentDeletionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_deletion_journal (
      agent_id TEXT PRIMARY KEY COLLATE NOCASE,
      started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0)
    );
  `);
}

export function migrateOpenBotSchema(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > OPENBOT_SCHEMA_VERSION) throw new Error(`store: versão SQLite não suportada: ${version}`);
  db.pragma("foreign_keys = ON");
  createBaseSchema(db);
  createMemorySchema(db);
  createAsyncTaskSchema(db);
  createA2ASchema(db);
  createP23Schema(db);
  createP24Schema(db);
  createP26Schema(db);
  createP28Schema(db);
  createAgentDeletionSchema(db);
  migrateA2AIdentitySchema(db);
  migrateA2AProjectionSchema(db);
  const asyncTaskColumns = tableColumns(db, "async_tasks");
  if (!asyncTaskColumns.has("input_json")) {
    db.exec("ALTER TABLE async_tasks ADD COLUMN input_json TEXT");
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_async_tasks_input_insert_nonnull
      BEFORE INSERT ON async_tasks
      WHEN NEW.input_json IS NULL
      BEGIN SELECT RAISE(ABORT, 'async task input_json is immutable and required'); END;
  `);
  // Recreated (not IF NOT EXISTS) so pre-existing databases pick up the
  // NULL-to-value repair allowance below. Immutability of stored values is kept:
  // only filling a missing input is permitted, never changing or clearing one.
  db.exec("DROP TRIGGER IF EXISTS trg_async_tasks_input_immutable");
  db.exec(`
    CREATE TRIGGER trg_async_tasks_input_immutable
      BEFORE UPDATE OF input_json ON async_tasks
      WHEN NEW.input_json IS NULL OR (OLD.input_json IS NOT NULL AND NEW.input_json IS NOT OLD.input_json)
      BEGIN SELECT RAISE(ABORT, 'async task input_json is immutable'); END;
  `);
  // Idempotent: reruns on every startup so a crash between ADD COLUMN and the
  // backfill can never leave NULL rows behind permanently.
  db.exec(`UPDATE async_tasks SET input_json = json_object(
    'version', 1, 'objective', 'Legacy async task objective',
    'source', json_object('kind', 'parent_turn', 'agentId', agent_id, 'turnEntryId', parent_turn_id)
  ) WHERE input_json IS NULL`);
  if (!asyncTaskColumns.has("settled_at_ms")) db.exec("ALTER TABLE async_tasks ADD COLUMN settled_at_ms INTEGER");
  if (!asyncTaskColumns.has("settlement_nonce")) db.exec("ALTER TABLE async_tasks ADD COLUMN settlement_nonce TEXT");
  const projectionColumns = tableColumns(db, "async_task_projection_outbox");
  if (!projectionColumns.has("source_outbox_id")) {
    db.exec("ALTER TABLE async_task_projection_outbox ADD COLUMN source_outbox_id TEXT");
    db.exec("UPDATE async_task_projection_outbox SET source_outbox_id = projection_id WHERE source_outbox_id IS NULL");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_async_task_projection_source_channel ON async_task_projection_outbox(source_outbox_id, channel)");
  const parentBudgetColumns = tableColumns(db, "async_task_parent_budget_usage");
  if (!parentBudgetColumns.has("wall_used_ms")) db.exec("ALTER TABLE async_task_parent_budget_usage ADD COLUMN wall_used_ms INTEGER NOT NULL DEFAULT 0");
  if (!parentBudgetColumns.has("wall_reserved_ms")) db.exec("ALTER TABLE async_task_parent_budget_usage ADD COLUMN wall_reserved_ms INTEGER NOT NULL DEFAULT 0");
  if (!parentBudgetColumns.has("wall_reservations_json")) db.exec("ALTER TABLE async_task_parent_budget_usage ADD COLUMN wall_reservations_json TEXT NOT NULL DEFAULT '{}'");
  const ownerColumns = tableColumns(db, "runtime_owners");
  if (!ownerColumns.has("process_started_at_ms")) db.exec("ALTER TABLE runtime_owners ADD COLUMN process_started_at_ms REAL");
  if (!ownerColumns.has("executable_path")) db.exec("ALTER TABLE runtime_owners ADD COLUMN executable_path TEXT");

  const migrate = db.transaction(() => {
    for (const table of CONVERSATION_BOUND_TABLES) ensureConversationColumn(db, table);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_transcript_agent_conversation_sequence
        ON transcript_entries(agent_id, conversation_id, sequence_id);
      CREATE INDEX IF NOT EXISTS idx_nonce_agent_conversation_time
        ON accepted_nonces(agent_id, conversation_id, accepted_at_ms);
      CREATE INDEX IF NOT EXISTS idx_pending_nonce_agent_conversation_time
        ON pending_nonces(agent_id, conversation_id, accepted_at_ms);
      CREATE INDEX IF NOT EXISTS idx_decisions_agent_conversation_time
        ON interaction_decisions(agent_id, conversation_id, created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_turn_attempts_agent_conversation
        ON turn_attempts(agent_id, conversation_id, started_at_ms);
      CREATE INDEX IF NOT EXISTS idx_turn_completions_agent_conversation
        ON turn_completions(agent_id, conversation_id, completed_at_ms);
      CREATE INDEX IF NOT EXISTS idx_transcript_agent_conversation_nonce
        ON transcript_entries(
          agent_id,
          conversation_id,
          json_extract(payload_json, '$.clientNonce'),
          sequence_id
        );
    `);
    backfillConversationIds(db, Date.now());
    migrateNoncePrimaryKeys(db);
    migrateMemoryJobProviderModel(db);
    migrateMemoryJobOutputs(db);
    migrateConversationSummaryRetention(db);
    if (version < OPENBOT_SCHEMA_VERSION) rebuildOpenBotFts(db);
    db.pragma(`user_version = ${OPENBOT_SCHEMA_VERSION}`);
  });
  migrate();
}

/** Ensures the legacy agent-scoped store has a durable active conversation. */
export function ensureDefaultConversation(db: Database.Database, agentId: string, now = Date.now()): string {
  validateAgentId(agentId);
  const ensure = db.transaction(() => {
    const active = db.prepare(`
      SELECT s.active_conversation_id
      FROM agent_conversation_state AS s
      JOIN agent_conversations AS c ON c.id = s.active_conversation_id AND c.agent_id = s.agent_id
      WHERE s.agent_id = ? AND c.archived_at_ms IS NULL
    `).get(agentId) as { active_conversation_id: string } | undefined;
    if (active !== undefined) return active.active_conversation_id;

    const existing = db.prepare(`
      SELECT id
      FROM agent_conversations
      WHERE agent_id = ? AND archived_at_ms IS NULL
      ORDER BY updated_at_ms DESC, id DESC
      LIMIT 1
    `).get(agentId) as { id: string } | undefined;
    let conversationId = existing?.id;
    if (conversationId === undefined) {
      conversationId = legacyConversationId(agentId);
      const collision = db.prepare("SELECT 1 AS present FROM agent_conversations WHERE id = ?").get(conversationId) as { present?: number } | undefined;
      if (collision?.present === 1) conversationId = randomUUID();
      insertDefaultConversation(db, agentId, conversationId, now);
    }
    db.prepare("INSERT OR REPLACE INTO agent_conversation_state(agent_id, active_conversation_id) VALUES (?, ?)").run(agentId, conversationId);
    return conversationId;
  });
  return ensure();
}

export type { ConversationRow };
