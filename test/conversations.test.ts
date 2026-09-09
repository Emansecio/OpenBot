import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { migrateOpenBotSchema, OPENBOT_SCHEMA_VERSION } from "../src/store/schema.js";
import { SqliteConversationStore } from "../src/conversations/store.js";
import { SqliteMemoryStore } from "../src/memory/sqlite-store.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { normalizeTranscriptEntry } from "../src/shared/contracts.js";

describe("OpenBot conversation schema", () => {
  it("migrates a v2 database and assigns every legacy row to one conversation", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        PRAGMA user_version = 2;
        CREATE TABLE transcript_entries (
          sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          entry_id TEXT,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL
        );
        CREATE TABLE accepted_nonces (
          agent_id TEXT NOT NULL,
          nonce TEXT NOT NULL,
          accepted_at_ms INTEGER NOT NULL,
          PRIMARY KEY (agent_id, nonce)
        );
        CREATE TABLE pending_nonces (
          agent_id TEXT NOT NULL,
          nonce TEXT NOT NULL,
          accepted_at_ms INTEGER NOT NULL,
          PRIMARY KEY (agent_id, nonce)
        );
        CREATE TABLE interaction_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          decision TEXT NOT NULL,
          metadata_json TEXT,
          created_at_ms INTEGER NOT NULL,
          UNIQUE(agent_id, request_id, kind)
        );
        CREATE TABLE turn_attempts (
          turn_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          client_nonce TEXT,
          retry_of_client_nonce TEXT,
          retry_failure_turn_id TEXT,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          phase TEXT NOT NULL,
          started_at_ms INTEGER NOT NULL
        );
      `);
      db.prepare("INSERT INTO transcript_entries(agent_id, entry_id, kind, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?)")
        .run("agent-a", "entry-a", "message", JSON.stringify({ kind: "message", id: "entry-a", role: "user", content: "oi" }), 10);
      db.prepare("INSERT INTO accepted_nonces(agent_id, nonce, accepted_at_ms) VALUES (?, ?, ?)").run("agent-a", "nonce-a", 11);
      db.prepare("INSERT INTO pending_nonces(agent_id, nonce, accepted_at_ms) VALUES (?, ?, ?)").run("agent-a", "nonce-a", 11);
      db.prepare("INSERT INTO interaction_decisions(agent_id, request_id, kind, decision, metadata_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)")
        .run("agent-a", "request-a", "tool", "allow", '{"source":"legacy"}', 12);
      db.prepare("INSERT INTO turn_attempts(turn_id, agent_id, client_nonce, retry_of_client_nonce, retry_failure_turn_id, provider, model, phase, started_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("turn-a", "agent-a", "client-a", "retry-client", "turn-failure", "xai", "grok", "preparing", 13);

      migrateOpenBotSchema(db);

      expect(db.pragma("user_version", { simple: true })).toBe(OPENBOT_SCHEMA_VERSION);
      const ids = [
        "transcript_entries",
        "accepted_nonces",
        "pending_nonces",
        "interaction_decisions",
        "turn_attempts",
      ];
      for (const table of ids) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE conversation_id IS NULL`).get()).toEqual({ count: 0 });
      }
      for (const table of ["accepted_nonces", "pending_nonces"] as const) {
        expect((db.pragma(`table_info(${table})`) as Array<{ name: string; pk: number }>)
          .filter((column) => column.pk > 0)
          .sort((left, right) => left.pk - right.pk)
          .map((column) => column.name)).toEqual(["agent_id", "conversation_id", "nonce"]);
      }
      const rows = db.prepare("SELECT DISTINCT conversation_id FROM transcript_entries WHERE agent_id = ?").all("agent-a") as Array<{ conversation_id: string }>;
      expect(rows).toHaveLength(1);
      const conversationId = rows[0]!.conversation_id;
      expect(db.prepare("SELECT COUNT(*) AS count FROM accepted_nonces WHERE agent_id = ?").get("agent-a")).toEqual({ count: 1 });
      expect(db.prepare("SELECT agent_id, conversation_id, nonce, accepted_at_ms FROM accepted_nonces WHERE agent_id = ?").all("agent-a"))
        .toEqual([{ agent_id: "agent-a", conversation_id: conversationId, nonce: "nonce-a", accepted_at_ms: 11 }]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM pending_nonces WHERE agent_id = ?").get("agent-a")).toEqual({ count: 1 });
      expect(db.prepare("SELECT agent_id, conversation_id, nonce, accepted_at_ms FROM pending_nonces WHERE agent_id = ?").all("agent-a"))
        .toEqual([{ agent_id: "agent-a", conversation_id: conversationId, nonce: "nonce-a", accepted_at_ms: 11 }]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM interaction_decisions WHERE agent_id = ?").get("agent-a")).toEqual({ count: 1 });
      expect(db.prepare("SELECT id, agent_id, conversation_id, request_id, kind, decision, metadata_json, created_at_ms FROM interaction_decisions WHERE agent_id = ?").all("agent-a"))
        .toEqual([{
          id: 1,
          agent_id: "agent-a",
          conversation_id: conversationId,
          request_id: "request-a",
          kind: "tool",
          decision: "allow",
          metadata_json: '{"source":"legacy"}',
          created_at_ms: 12,
        }]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM turn_attempts WHERE agent_id = ?").get("agent-a")).toEqual({ count: 1 });
      expect(db.prepare("SELECT turn_id, agent_id, conversation_id, client_nonce, retry_of_client_nonce, retry_failure_turn_id, provider, model, phase, started_at_ms FROM turn_attempts WHERE agent_id = ?").all("agent-a"))
        .toEqual([{
          turn_id: "turn-a",
          agent_id: "agent-a",
          conversation_id: conversationId,
          client_nonce: "client-a",
          retry_of_client_nonce: "retry-client",
          retry_failure_turn_id: "turn-failure",
          provider: "xai",
          model: "grok",
          phase: "preparing",
          started_at_ms: 13,
        }]);
      expect(db.prepare("SELECT agent_id, active_conversation_id FROM agent_conversation_state WHERE agent_id = ?").get("agent-a"))
        .toMatchObject({ agent_id: "agent-a", active_conversation_id: conversationId });
      const before = db.prepare("SELECT COUNT(*) AS count FROM agent_conversations").get() as { count: number };
      migrateOpenBotSchema(db);
      expect(db.prepare("SELECT COUNT(*) AS count FROM agent_conversations").get()).toEqual(before);
      expect(db.prepare("SELECT DISTINCT conversation_id FROM transcript_entries WHERE agent_id = ?").all("agent-a"))
        .toEqual(rows);
    } finally {
      db.close();
    }
  });

  it("creates and activates the default conversation for an agent without history", () => {
    const store = new SqliteConversationStore({ path: ":memory:" });
    try {
      const conversation = store.ensureDefault("agent-a");
      expect(conversation).toMatchObject({
        agentId: "agent-a",
        title: "Nova conversa",
        titleSource: "auto",
        temporary: false,
        archivedAtMs: null,
        lastMessageAtMs: null,
      });
      expect(store.getActive("agent-a")).toEqual(conversation);
    } finally {
      store.close();
    }
  });

  it("looks up one conversation without exposing another agent's row", () => {
    const store = new SqliteConversationStore({ path: ":memory:" });
    try {
      const conversation = store.create("agent-a", { title: "Direta" });
      expect(store.get("agent-a", conversation.id)).toEqual(conversation);
      expect(store.get("agent-b", conversation.id)).toBeNull();
      expect(store.get("agent-a", "00000000-0000-4000-8000-000000000000")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("migrates a v6 summary table so retained summaries survive conversation deletion", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-summary-v6-migration-"));
    const dbPath = join(dir, "store.db");
    const db = new Database(dbPath);
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA user_version = 6;
        CREATE TABLE agent_conversations (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          title TEXT NOT NULL,
          title_source TEXT NOT NULL,
          temporary INTEGER NOT NULL,
          archived_at_ms INTEGER,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          last_message_at_ms INTEGER
        );
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          through_sequence_id INTEGER NOT NULL,
          summary_json TEXT NOT NULL,
          rendered_text TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
        );
      `);
      db.prepare(`
        INSERT INTO agent_conversations(id, agent_id, title, title_source, temporary, archived_at_ms, created_at_ms, updated_at_ms, last_message_at_ms)
        VALUES ('conv-retain', 'agent-a', 'Retida', 'auto', 0, 1, 1, 2, 2)
      `).run();
      db.prepare(`
        INSERT INTO conversation_summaries(conversation_id, agent_id, revision, through_sequence_id, summary_json, rendered_text, updated_at_ms)
        VALUES ('conv-retain', 'agent-a', 1, 2, '{}', 'summary antiga retida', 3)
      `).run();

      migrateOpenBotSchema(db);

      const columns = db.pragma("table_info(conversation_summaries)") as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("retained");
      const fk = db.pragma("foreign_key_list(conversation_summaries)") as Array<{ table: string; on_delete: string }>;
      expect(fk.some((row) => row.table === "agent_conversations")).toBe(false);
      db.prepare("UPDATE conversation_summaries SET retained = 1 WHERE conversation_id = ?").run("conv-retain");
      db.prepare("DELETE FROM agent_conversation_state WHERE agent_id = ?").run("agent-a");
      db.prepare("DELETE FROM agent_conversations WHERE id = ?").run("conv-retain");
      expect(db.prepare("SELECT agent_id, retained, rendered_text FROM conversation_summaries WHERE conversation_id = ?").get("conv-retain"))
        .toEqual({ agent_id: "agent-a", retained: 1, rendered_text: "summary antiga retida" });
    } finally {
      db.close();
    }

    const reopened = new SqliteTranscriptStore({ path: dbPath });
    try {
      expect(reopened.memoryStore.getSummary("agent-a", "conv-retain")).toMatchObject({
        conversationId: "conv-retain",
        renderedText: "summary antiga retida",
      });
      expect(reopened.memoryStore.searchHistory("agent-a", "retida").some((result) => result.kind === "summary")).toBe(true);
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfills memory and history FTS exactly once during a v4 to current schema migration", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA user_version = 4;
        CREATE TABLE transcript_entries (
          sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          conversation_id TEXT,
          entry_id TEXT,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL
        );
        CREATE TABLE accepted_nonces (
          agent_id TEXT NOT NULL,
          conversation_id TEXT,
          nonce TEXT NOT NULL,
          accepted_at_ms INTEGER NOT NULL,
          PRIMARY KEY (agent_id, conversation_id, nonce)
        );
        CREATE TABLE pending_nonces (
          agent_id TEXT NOT NULL,
          conversation_id TEXT,
          nonce TEXT NOT NULL,
          accepted_at_ms INTEGER NOT NULL,
          PRIMARY KEY (agent_id, conversation_id, nonce)
        );
        CREATE TABLE interaction_decisions (
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
        CREATE TABLE runtime_owners (
          token TEXT PRIMARY KEY,
          pid INTEGER NOT NULL
        );
        CREATE TABLE turn_attempts (
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
        CREATE TABLE agent_conversations (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          title TEXT NOT NULL,
          title_source TEXT NOT NULL,
          temporary INTEGER NOT NULL,
          archived_at_ms INTEGER,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          last_message_at_ms INTEGER
        );
        CREATE TABLE agent_conversation_state (
          agent_id TEXT PRIMARY KEY,
          active_conversation_id TEXT NOT NULL
        );
        CREATE TABLE agent_memory_settings (
          agent_id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          through_sequence_id INTEGER NOT NULL,
          summary_json TEXT NOT NULL,
          rendered_text TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE agent_memories (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          canonical_key TEXT NOT NULL,
          text TEXT NOT NULL,
          value_json TEXT,
          trust TEXT NOT NULL,
          status TEXT NOT NULL,
          importance INTEGER NOT NULL,
          confidence REAL NOT NULL,
          pinned INTEGER NOT NULL,
          source_conversation_id TEXT,
          source_entry_ids_json TEXT NOT NULL,
          valid_from_ms INTEGER NOT NULL,
          valid_to_ms INTEGER,
          expires_at_ms INTEGER,
          superseded_by TEXT,
          revision INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE memory_revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL
        );
        CREATE TABLE memory_jobs (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          from_sequence_id INTEGER NOT NULL,
          through_sequence_id INTEGER NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          next_attempt_at_ms INTEGER NOT NULL,
          last_error_code TEXT,
          last_error_text TEXT,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );
      `);
      db.prepare(`
        INSERT INTO agent_conversations(id, agent_id, title, title_source, temporary, archived_at_ms, created_at_ms, updated_at_ms, last_message_at_ms)
        VALUES ('conv-a', 'agent-a', 'Migrada', 'auto', 0, NULL, 1, 2, 2)
      `).run();
      db.prepare("INSERT INTO agent_conversation_state(agent_id, active_conversation_id) VALUES ('agent-a', 'conv-a')").run();
      db.prepare(`
        INSERT INTO transcript_entries(agent_id, conversation_id, entry_id, kind, payload_json, created_at_ms)
        VALUES ('agent-a', 'conv-a', 'entry-a', 'message', ?, 3)
      `).run(JSON.stringify({ kind: "message", id: "entry-a", role: "user", content: "histórico migrado azul" }));
      db.prepare(`
        INSERT INTO conversation_summaries(conversation_id, agent_id, revision, through_sequence_id, summary_json, rendered_text, updated_at_ms)
        VALUES ('conv-a', 'agent-a', 1, 3, '{}', 'summary migrada azul', 4)
      `).run();
      db.prepare(`
        INSERT INTO agent_memories(
          id, agent_id, kind, canonical_key, text, value_json, trust, status, importance, confidence, pinned,
          source_conversation_id, source_entry_ids_json, valid_from_ms, valid_to_ms, expires_at_ms, superseded_by,
          revision, created_at_ms, updated_at_ms
        ) VALUES (
          'mem-a', 'agent-a', 'fact', 'migrated key', 'memória migrada azul', NULL, 'verified_tool', 'active', 50, 0.9, 0,
          'conv-a', '[]', 1, NULL, NULL, NULL, 1, 1, 4
        )
      `).run();

      migrateOpenBotSchema(db);

      expect(db.pragma("user_version", { simple: true })).toBe(OPENBOT_SCHEMA_VERSION);
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_fts WHERE memory_id = 'mem-a'").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM history_fts WHERE source_id = 'entry:1'").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM history_fts WHERE source_id = 'summary:conv-a'").get()).toEqual({ count: 1 });
      const before = db.prepare("SELECT COUNT(*) AS count FROM history_fts").get() as { count: number };
      migrateOpenBotSchema(db);
      expect(db.prepare("SELECT COUNT(*) AS count FROM history_fts").get()).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("creates conversations and paginates with an opaque agent-scoped cursor", () => {
    let now = 100;
    const store = new SqliteConversationStore({ path: ":memory:", now: () => now++ });
    try {
      const defaultConversation = store.ensureDefault("agent-a");
      const second = store.create("agent-a", { title: "Segunda", temporary: true });
      const third = store.create("agent-a", { title: "Terceira" });
      expect(second.temporary).toBe(true);
      expect(store.getActive("agent-a")?.id).toBe(third.id);
      const firstPage = store.list("agent-a", { limit: 2 });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.items.map((item) => item.id)).toEqual([third.id, second.id]);
      expect(firstPage.nextCursor).toMatch(/^v1:/);
      const secondPage = store.list("agent-a", { limit: 2, cursor: firstPage.nextCursor });
      expect(secondPage.items).toEqual([defaultConversation]);
      expect(() => store.list("agent-b", { cursor: firstPage.nextCursor })).toThrow(/cursor/);
    } finally {
      store.close();
    }
  });

  it("enforces agent ownership and keeps manual titles stable", () => {
    const store = new SqliteConversationStore({ path: ":memory:" });
    try {
      const own = store.ensureDefault("agent-a");
      const other = store.ensureDefault("agent-b");
      expect(() => store.activate("agent-a", other.id)).toThrow(/agente/);
      expect(() => store.rename("agent-a", other.id, "intruso")).toThrow(/agente/);
      expect(() => store.archive("agent-a", other.id)).toThrow(/agente/);
      expect(() => store.delete("agent-a", other.id, { memoryPolicy: "retain" })).toThrow(/agente/);

      expect(store.updateAutoTitle("agent-a", own.id, "  primeira pergunta  ")).toMatchObject({
        title: "primeira pergunta",
        titleSource: "auto",
      });
      const autoOnly = store.create("agent-a");
      expect(store.updateAutoTitle("agent-a", autoOnly.id, "primeira da conversa").title).toBe("primeira da conversa");
      expect(store.updateAutoTitle("agent-a", autoOnly.id, "segunda não renomeia").title).toBe("primeira da conversa");
      expect(store.rename("agent-a", own.id, "Título manual")).toMatchObject({ title: "Título manual", titleSource: "manual" });
      expect(store.updateAutoTitle("agent-a", own.id, "não substituir")).toMatchObject({ title: "Título manual", titleSource: "manual" });
    } finally {
      store.close();
    }
  });

  it("preserves archive/delete invariants and selects a replacement active conversation", () => {
    const store = new SqliteConversationStore({ path: ":memory:" });
    try {
      const first = store.ensureDefault("agent-a");
      const second = store.create("agent-a", { title: "Segunda" });
      expect(store.getActive("agent-a")?.id).toBe(second.id);
      store.activate("agent-a", first.id);
      store.archive("agent-a", first.id);
      expect(store.getActive("agent-a")?.id).toBe(second.id);
      expect(() => store.archive("agent-a", second.id)).toThrow(/única/);

      const third = store.create("agent-a", { title: "Terceira" });
      store.activate("agent-a", third.id);
      const deletion = store.delete("agent-a", third.id, { memoryPolicy: "delete-derived" });
      expect(deletion).toEqual({ conversationId: third.id, memoryPolicy: "delete-derived" });
      expect(store.getActive("agent-a")?.id).toBe(second.id);
      expect(() => store.delete("agent-a", second.id, { memoryPolicy: "retain" })).toThrow(/última conversa não arquivada/);
      expect(() => store.delete("agent-a", first.id, { memoryPolicy: "retain" })).not.toThrow();
      expect(store.getActive("agent-a")?.id).toBe(second.id);
    } finally {
      store.close();
    }
  });

  it("purges resume checkpoints, effects and kickstart runs when a conversation is deleted", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      const keep = transcript.conversationStore.ensureDefault("agent-a");
      const gone = transcript.conversationStore.create("agent-a", { title: "Apagar" });
      const scope = {
        agentId: "agent-a",
        conversationId: gone.id,
        turnId: "turn-gone",
        provider: "openai-compat",
        model: "openai-compatible",
      } as const;
      transcript.createResumeCheckpoint({
        checkpointId: "checkpoint-gone",
        ...scope,
        cursor: "fixture-v1:gone:1",
        safeSequenceId: 0,
        completedEffectIds: [],
        expiresAtMs: Date.now() + 60_000,
        version: 1,
        budget: { maxProviderAttempts: 2, providerAttemptsUsed: 0, maxToolRounds: 8, toolRoundsUsed: 0, maxToolCalls: 16, toolCallsUsed: 0 },
      });
      transcript.prepareResumeEffect(scope, "effect:v1:gone", "hash-gone");
      transcript.claimKickstartRun({
        agentId: "agent-a",
        clientNonce: "kick-gone",
        conversationId: gone.id,
        origin: "kickstart",
        version: 1,
        turnId: "kickstart:gone",
        provider: "openai-compat",
        model: "openai-compatible",
      });
      transcript.conversationStore.activate("agent-a", keep.id);
      transcript.conversationStore.delete("agent-a", gone.id, { memoryPolicy: "delete-derived" });
      expect(transcript.findResumeCheckpoint("agent-a", gone.id, "turn-gone")).toBeUndefined();
      expect(transcript.getResumeEffect(scope, "effect:v1:gone")).toBeUndefined();
      expect(transcript.getKickstartRun("agent-a", "kick-gone")).toBeUndefined();
    } finally {
      transcript.close();
    }
  });

  it("archives conversation jobs atomically and leaves other conversations untouched", () => {
    const db = new Database(":memory:");
    const memory = new SqliteMemoryStore({ path: ":memory:", database: db });
    const store = new SqliteConversationStore({ path: ":memory:", database: db, memoryStore: memory });
    try {
      const target = store.ensureDefault("agent-a");
      const survivor = store.create("agent-a", { title: "Sobrevive" });
      const pending = memory.enqueueJob({
        agentId: "agent-a",
        conversationId: target.id,
        provider: "xai",
        model: "grok-4.6",
        fromSequenceId: 0,
        throughSequenceId: 0,
      });
      const retry = memory.enqueueJob({
        agentId: "agent-a",
        conversationId: target.id,
        provider: "xai",
        model: "grok-4.6",
        fromSequenceId: 1,
        throughSequenceId: 1,
      });
      memory.claimJob("agent-a", retry.id);
      memory.retryJob("agent-a", retry.id, { code: "temporary", text: "falha transitória" }, 100, { backoffMs: [0] });
      const running = memory.enqueueJob({
        agentId: "agent-a",
        conversationId: target.id,
        provider: "xai",
        model: "grok-4.6",
        fromSequenceId: 2,
        throughSequenceId: 2,
      });
      memory.claimJob("agent-a", running.id);
      const survivorJob = memory.enqueueJob({
        agentId: "agent-a",
        conversationId: survivor.id,
        provider: "xai",
        model: "grok-4.6",
        fromSequenceId: 3,
        throughSequenceId: 3,
      });

      store.archive("agent-a", target.id);

      for (const jobId of [pending.id, retry.id, running.id]) {
        expect(memory.getJob("agent-a", jobId)).toMatchObject({
          status: "dead",
          lastErrorCode: "conversation_archived",
        });
      }
      expect(memory.getJob("agent-a", survivorJob.id)).toMatchObject({ status: "pending" });
      expect(store.getActive("agent-a")?.id).toBe(survivor.id);
    } finally {
      store.close();
      memory.close();
      db.close();
    }
  });

  it("always activates a newly created conversation and starts it empty", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const store = transcript.conversationStore;
    try {
      const first = store.ensureDefault("agent-a");
      const second = store.create("agent-a", { title: "Segunda" });
      expect(store.getActive("agent-a")?.id).toBe(second.id);
      expect(store.snapshotAgent("agent-a")).toMatchObject({
        activeConversationId: second.id,
        conversations: expect.arrayContaining([
          expect.objectContaining({ id: first.id }),
          expect.objectContaining({ id: second.id }),
        ]),
      });
      expect(transcript.getEntries("agent-a", second.id)).toEqual([]);
    } finally {
      transcript.close();
    }
  });

  it("rolls back memory policy, conversation rows and active replacement if delete fails at the final conversation delete", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-conversation-atomic-delete-"));
    const dbPath = join(dir, "store.db");
    const transcript = new SqliteTranscriptStore({ path: dbPath });
    try {
      const source = transcript.conversationStore.ensureDefault("agent-a");
      const survivor = transcript.conversationStore.create("agent-a", { title: "Sobrevive" });
      transcript.conversationStore.activate("agent-a", source.id);
      transcript.append("agent-a", [{
        kind: "message",
        id: "entry-atomic",
        role: "user",
        content: "permanece se rollback funcionar",
        timestampMs: 10,
        streaming: false,
      }], source.id);
      transcript.memoryStore.upsertSummary("agent-a", {
        conversationId: source.id,
        throughSequenceId: 1,
        summaryJson: { rollback: true },
        renderedText: "summary rollback",
      });
      const memory = transcript.memoryStore.upsertMemory("agent-a", {
        kind: "fact",
        canonicalKey: "atomic-memory",
        text: "memória derivada",
        trust: "verified_tool",
        sourceConversationId: source.id,
      }, { kind: "admin" });
      const job = transcript.memoryStore.enqueueJob({
        agentId: "agent-a",
        conversationId: source.id,
        provider: "xai",
        model: "grok-4.6",
        fromSequenceId: 0,
        throughSequenceId: 1,
      });
      const db = new Database(dbPath);
      try {
        db.prepare("INSERT INTO accepted_nonces(agent_id, conversation_id, nonce, accepted_at_ms) VALUES (?, ?, ?, ?)")
          .run("agent-a", source.id, "accepted-atomic", 11);
        db.prepare("INSERT INTO pending_nonces(agent_id, conversation_id, nonce, accepted_at_ms) VALUES (?, ?, ?, ?)")
          .run("agent-a", source.id, "pending-atomic", 12);
        db.prepare("INSERT INTO interaction_decisions(agent_id, conversation_id, request_id, kind, decision, metadata_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run("agent-a", source.id, "request-atomic", "tool", "allow", '{"source":"test"}', 13);
        db.prepare("INSERT INTO turn_attempts(turn_id, agent_id, conversation_id, client_nonce, retry_of_client_nonce, retry_failure_turn_id, provider, model, phase, started_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run("turn-atomic", "agent-a", source.id, "nonce-atomic", null, null, "xai", "grok-4.6", "streaming", 14);
        db.exec(`
          CREATE TRIGGER agent_conversations_delete_fail_atomic
          BEFORE DELETE ON agent_conversations
          WHEN OLD.id = '${source.id}'
          BEGIN
            SELECT RAISE(FAIL, 'delete boom');
          END;
        `);
      } finally {
        db.close();
      }

      expect(() => transcript.conversationStore.delete("agent-a", source.id, { memoryPolicy: "delete-derived" })).toThrow(/delete boom/);

      const verify = new Database(dbPath, { readonly: true });
      try {
        expect(transcript.conversationStore.getActive("agent-a")?.id).toBe(source.id);
        expect(verify.prepare("SELECT COUNT(*) AS count FROM agent_conversations WHERE id = ?").get(source.id)).toEqual({ count: 1 });
        expect(verify.prepare("SELECT COUNT(*) AS count FROM transcript_entries WHERE conversation_id = ?").get(source.id)).toEqual({ count: 1 });
        expect(verify.prepare("SELECT COUNT(*) AS count FROM accepted_nonces WHERE conversation_id = ?").get(source.id)).toEqual({ count: 1 });
        expect(verify.prepare("SELECT COUNT(*) AS count FROM pending_nonces WHERE conversation_id = ?").get(source.id)).toEqual({ count: 1 });
        expect(verify.prepare("SELECT COUNT(*) AS count FROM interaction_decisions WHERE conversation_id = ?").get(source.id)).toEqual({ count: 1 });
        expect(verify.prepare("SELECT COUNT(*) AS count FROM turn_attempts WHERE conversation_id = ?").get(source.id)).toEqual({ count: 1 });
        expect(verify.prepare("SELECT active_conversation_id FROM agent_conversation_state WHERE agent_id = ?").get("agent-a"))
          .toEqual({ active_conversation_id: source.id });
        expect(transcript.memoryStore.getSummary("agent-a", source.id)?.renderedText).toBe("summary rollback");
        expect(transcript.memoryStore.getMemory("agent-a", memory.id)?.status).toBe("active");
        expect(transcript.memoryStore.getJob("agent-a", job.id)?.status).toBe("pending");
      } finally {
        verify.close();
      }
    } finally {
      transcript.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an injected memory store that does not share the same SQLite connection", () => {
    const conversationDb = new Database(":memory:");
    const memoryDb = new Database(":memory:");
    try {
      const memory = new SqliteMemoryStore({ path: ":memory:", database: memoryDb });
      expect(() => new SqliteConversationStore({ path: ":memory:", database: conversationDb, memoryStore: memory }))
        .toThrow(/mesma conexão SQLite/i);
    } finally {
      conversationDb.close();
      memoryDb.close();
    }
  });

  it("does not delete the last live conversation and appends away from archived state", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-conversations-archive-active-"));
    const dbPath = join(dir, "store.db");
    const conversations = new SqliteConversationStore({ path: dbPath });
    const transcript = new SqliteTranscriptStore({ path: dbPath });
    try {
      const archived = conversations.ensureDefault("agent-a");
      const live = conversations.create("agent-a", { title: "Viva" });
      conversations.activate("agent-a", archived.id);
      conversations.archive("agent-a", archived.id);
      expect(conversations.getActive("agent-a")?.id).toBe(live.id);
      expect(() => conversations.activate("agent-a", archived.id)).toThrow(/arquivada/);
      expect(() => conversations.delete("agent-a", live.id, { memoryPolicy: "retain" })).toThrow(/última conversa não arquivada/);

      const db = new Database(dbPath);
      try {
        db.prepare("UPDATE agent_conversation_state SET active_conversation_id = ? WHERE agent_id = ?").run(archived.id, "agent-a");
      } finally {
        db.close();
      }
      expect(conversations.getActive("agent-a")?.id).toBe(live.id);
      transcript.append("agent-a", [normalizeTranscriptEntry({
        kind: "message",
        id: "append-after-archive",
        role: "user",
        content: "vai para a viva",
        timestampMs: 20,
      })]);
      const row = new Database(dbPath);
      try {
        expect(row.prepare("SELECT conversation_id FROM transcript_entries WHERE agent_id = ? AND entry_id = ?").get("agent-a", "append-after-archive"))
          .toEqual({ conversation_id: live.id });
      } finally {
        row.close();
      }
    } finally {
      transcript.close();
      conversations.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("snapshots, clears and restores conversations without duplicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-conversations-"));
    const dbPath = join(dir, "store.db");
    const store = new SqliteConversationStore({ path: dbPath });
    try {
      const first = store.ensureDefault("agent-a");
      const second = store.create("agent-a", { title: "Segunda" });
      store.activate("agent-a", second.id);
      const snapshot = store.snapshotAgent("agent-a");
      const db = new Database(dbPath);
      try {
        db.prepare("INSERT INTO transcript_entries(agent_id, conversation_id, kind, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?)")
          .run("agent-a", second.id, "message", JSON.stringify({ kind: "message", role: "user", content: "persistente" }), 1);
      } finally {
        db.close();
      }

      const beforeRestore = new Database(dbPath);
      try {
        beforeRestore.prepare("INSERT INTO transcript_entries(agent_id, conversation_id, kind, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?)")
          .run("agent-a", second.id, "notice", JSON.stringify({ kind: "notice", text: "não capturado", level: "info" }), 2);
      } finally {
        beforeRestore.close();
      }
      store.restoreAgent("agent-a", snapshot);
      const preservedDb = new Database(dbPath);
      try {
        expect(preservedDb.prepare("SELECT COUNT(*) AS count FROM transcript_entries WHERE agent_id = ?").get("agent-a")).toEqual({ count: 2 });
      } finally {
        preservedDb.close();
      }

      store.clear("agent-a");
      expect(store.list("agent-a").items).toEqual([]);
      expect(store.getActive("agent-a")).toBeNull();
      const clearedDb = new Database(dbPath);
      try {
        expect(clearedDb.prepare("SELECT COUNT(*) AS count FROM transcript_entries WHERE agent_id = ?").get("agent-a")).toEqual({ count: 0 });
      } finally {
        clearedDb.close();
      }

      store.restoreAgent("agent-a", snapshot);
      store.restoreAgent("agent-a", snapshot);
      expect(store.list("agent-a").items.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
      expect(store.getActive("agent-a")?.id).toBe(second.id);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips all conversation-bound rows with the transcript snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-conversations-full-snapshot-"));
    const dbPath = join(dir, "store.db");
    const conversations = new SqliteConversationStore({ path: dbPath });
    const transcript = new SqliteTranscriptStore({ path: dbPath });
    try {
      const active = conversations.ensureDefault("agent-a");
      const db = new Database(dbPath);
      try {
        db.prepare("INSERT INTO transcript_entries(sequence_id, agent_id, conversation_id, entry_id, kind, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(101, "agent-a", active.id, "entry-101", "message", JSON.stringify({ kind: "message", id: "entry-101", role: "user", content: "oi", timestampMs: 1010 }), 1010);
        db.prepare("INSERT INTO accepted_nonces(agent_id, conversation_id, nonce, accepted_at_ms) VALUES (?, ?, ?, ?)")
          .run("agent-a", active.id, "accepted-1", 1020);
        db.prepare("INSERT INTO pending_nonces(agent_id, conversation_id, nonce, accepted_at_ms) VALUES (?, ?, ?, ?)")
          .run("agent-a", active.id, "pending-1", 1030);
        db.prepare("INSERT INTO interaction_decisions(id, agent_id, conversation_id, request_id, kind, decision, metadata_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(201, "agent-a", active.id, "request-1", "tool", "allow", '{"source":"test"}', 1040);
        db.prepare("INSERT INTO turn_attempts(turn_id, agent_id, conversation_id, client_nonce, retry_of_client_nonce, retry_failure_turn_id, provider, model, phase, started_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run("turn-1", "agent-a", active.id, "nonce-turn", "nonce-old", "turn-old", "xai", "grok", "streaming", 1050);
      } finally {
        db.close();
      }

      const snapshot = transcript.snapshotAgent("agent-a");
      expect(snapshot.acceptedNonceRows).toEqual([{ agentId: "agent-a", conversationId: active.id, nonce: "accepted-1", acceptedAtMs: 1020 }]);
      expect(snapshot.pendingNonceRows).toEqual([{ agentId: "agent-a", conversationId: active.id, nonce: "pending-1", acceptedAtMs: 1030 }]);
      expect(snapshot.interactionDecisionRows).toEqual([{
        id: 201,
        agentId: "agent-a",
        conversationId: active.id,
        requestId: "request-1",
        kind: "tool",
        decision: "allow",
        metadataJson: '{"source":"test"}',
        createdAtMs: 1040,
      }]);
      expect(snapshot.turnAttemptRows).toEqual([{
        turnId: "turn-1",
        agentId: "agent-a",
        conversationId: active.id,
        clientNonce: "nonce-turn",
        retryOfClientNonce: "nonce-old",
        retryFailureTurnId: "turn-old",
        provider: "xai",
        model: "grok",
        phase: "streaming",
        startedAtMs: 1050,
      }]);

      transcript.clear("agent-a");
      expect(transcript.snapshotAgent("agent-a")).toMatchObject({
        conversations: [],
        activeConversationId: null,
        transcriptRows: [],
        acceptedNonceRows: [],
        pendingNonceRows: [],
        interactionDecisionRows: [],
        turnAttemptRows: [],
      });
      transcript.restoreAgent("agent-a", snapshot);
      const restored = transcript.snapshotAgent("agent-a");
      expect(restored.conversations).toEqual(snapshot.conversations);
      expect(restored.activeConversationId).toBe(snapshot.activeConversationId);
      expect(restored.transcriptRows).toEqual(snapshot.transcriptRows);
      expect(restored.acceptedNonceRows).toEqual(snapshot.acceptedNonceRows);
      expect(restored.pendingNonceRows).toEqual(snapshot.pendingNonceRows);
      expect(restored.interactionDecisionRows).toEqual(snapshot.interactionDecisionRows);
      expect(restored.turnAttemptRows).toEqual(snapshot.turnAttemptRows);
    } finally {
      transcript.close();
      conversations.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("works through two simultaneous SQLite connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-conversations-two-"));
    const dbPath = join(dir, "store.db");
    const first = new SqliteConversationStore({ path: dbPath });
    const second = new SqliteConversationStore({ path: dbPath });
    try {
      const created = first.ensureDefault("agent-a");
      expect(second.getActive("agent-a")?.id).toBe(created.id);
      const extra = second.create("agent-a", { title: "Outra" });
      expect(first.list("agent-a").items.map((item) => item.id)).toContain(extra.id);
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not invent a legacy default when reopening a domain-only agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-conversations-domain-only-"));
    const dbPath = join(dir, "store.db");
    const first = new SqliteConversationStore({ path: dbPath });
    const created = first.create("agent-a", { title: "Única" });
    first.close();
    const second = new SqliteConversationStore({ path: dbPath });
    try {
      expect(second.list("agent-a").items).toEqual([created]);
      expect(second.getActive("agent-a")?.id).toBe(created.id);
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
