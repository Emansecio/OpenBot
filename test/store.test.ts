import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  DEFAULT_TRANSCRIPT_PAGE_LIMIT,
  MAX_TRANSCRIPT_PAGE_LIMIT,
  SqliteTranscriptStore,
  type ConversationOutline,
} from "../src/store/index.js";
import { SqliteConversationStore } from "../src/conversations/store.js";
import { SqliteMemoryStore } from "../src/memory/sqlite-store.js";
import { normalizeTranscriptEntry, type TranscriptEntry } from "../src/shared/contracts.js";

const openStores: SqliteTranscriptStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createStore(): SqliteTranscriptStore {
  const dir = mkdtempSync(join(tmpdir(), "openbot-store-"));
  tempDirs.push(dir);
  const store = new SqliteTranscriptStore({ path: join(dir, "store.db") });
  openStores.push(store);
  return store;
}

function message(id: string, role: "user" | "assistant", content: string, timestampMs: number): TranscriptEntry {
  return normalizeTranscriptEntry({ kind: "message", id, role, content, timestampMs, streaming: false });
}

function attachment(name: string): TranscriptEntry {
  return normalizeTranscriptEntry({ kind: "user-attachment", file_name: name, file_path: `C:\\docs\\${name}` });
}

describe("SqliteTranscriptStore", () => {
  it("rejects an injected foreign memory store without closing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-store-foreign-memory-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "store.db");
    const foreignMemoryDb = new Database(":memory:");
    const foreignMemory = new SqliteMemoryStore({ path: ":memory:", database: foreignMemoryDb });
    try {
      expect(() => new SqliteTranscriptStore({ path: dbPath, memoryStore: foreignMemory }))
        .toThrow(/memoryStore injetado deve usar a mesma conexão SQLite/i);
      expect(foreignMemoryDb.prepare("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
    } finally {
      foreignMemory.close();
      foreignMemoryDb.close();
    }
  });

  it("rejects an injected foreign conversation store without closing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-store-foreign-conversation-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "store.db");
    const foreignConversationDb = new Database(":memory:");
    const foreignConversation = new SqliteConversationStore({ path: ":memory:", database: foreignConversationDb });
    try {
      expect(() => new SqliteTranscriptStore({ path: dbPath, conversationStore: foreignConversation }))
        .toThrow(/conversationStore injetado deve usar a mesma conexão SQLite/i);
      expect(foreignConversationDb.prepare("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
    } finally {
      foreignConversation.close();
      foreignConversationDb.close();
    }
  });

  it("accepts injected shared conversation and memory stores on the same SQLite connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-store-shared-injected-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "store.db");
    const sharedDb = new Database(dbPath);
    const sharedMemory = new SqliteMemoryStore({ path: dbPath, database: sharedDb });
    const sharedConversation = new SqliteConversationStore({ path: dbPath, database: sharedDb, memoryStore: sharedMemory });

    const reopened = new SqliteTranscriptStore({
      path: dbPath,
      database: sharedDb,
      memoryStore: sharedMemory,
      conversationStore: sharedConversation,
    });
    try {
      expect(reopened.memoryStore).toBe(sharedMemory);
      expect(reopened.conversationStore).toBe(sharedConversation);
      const active = reopened.conversationStore.ensureDefault("agent-shared");
      reopened.append("agent-shared", [message("shared", "user", "ok", 1)], active.id);
      expect(reopened.getEntries("agent-shared", active.id)).toContainEqual(message("shared", "user", "ok", 1));
    } finally {
      reopened.close();
      sharedDb.close();
    }
  });

  it("persiste entries em ordem e preserva o payload completo", () => {
    const store = createStore();
    const entries = [message("u1", "user", "olá", 100), attachment("a.txt")];

    store.append("agent-a", entries);

    expect(store.getEntries("agent-a")).toEqual(entries);
    expect(store.getEntries("agent-b")).toEqual([]);
  });

  it("sobrevive ao fechamento e reabertura do mesmo arquivo", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-reopen-"));
    tempDirs.push(dir);
    const path = join(dir, "store.db");
    const first = new SqliteTranscriptStore({ path });
    first.append("agent-a", [message("u1", "user", "persistir", 100)]);
    first.rememberAcceptedNonce("agent-a", "nonce-1");
    first.close();

    const second = new SqliteTranscriptStore({ path });
    openStores.push(second);
    expect(second.getEntries("agent-a")).toHaveLength(1);
    expect(second.hasAcceptedNonce("agent-a", "nonce-1")).toBe(true);
  });

  it("reconcilia nonce aceito sem mensagem após close/reopen, liberando retry", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-orphan-nonce-"));
    tempDirs.push(dir);
    const path = join(dir, "store.db");
    const first = new SqliteTranscriptStore({ path });
    expect(first.claimAcceptedNonce("agent-a", "orphan-nonce")).toBe(true);
    first.close();

    const second = new SqliteTranscriptStore({ path });
    openStores.push(second);
    expect(second.hasAcceptedNonce("agent-a", "orphan-nonce")).toBe(false);
    expect(second.getEntries("agent-a")).toEqual([
      expect.objectContaining({ kind: "notice", level: "error", text: expect.stringContaining("Confira a pendência local antes de reenviar") }),
    ]);
    expect(second.claimAcceptedNonce("agent-a", "orphan-nonce")).toBe(true);
  });

  it("preserva nonce aceito quando o echo do usuário sobrevive ao close/reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-committed-nonce-"));
    tempDirs.push(dir);
    const path = join(dir, "store.db");
    const first = new SqliteTranscriptStore({ path });
    expect(first.claimAcceptedNonce("agent-a", "committed-nonce")).toBe(true);
    first.append("agent-a", [normalizeTranscriptEntry({
      kind: "message",
      id: "user-1",
      role: "user",
      content: "turno aceito",
      timestampMs: 100,
      clientNonce: "committed-nonce",
    })]);
    first.close();

    const second = new SqliteTranscriptStore({ path });
    openStores.push(second);
    expect(second.hasAcceptedNonce("agent-a", "committed-nonce")).toBe(true);
    expect(second.claimAcceptedNonce("agent-a", "committed-nonce")).toBe(false);
  });

  it("preserva nonce aceito quando o marcador durável de retry sobrevive ao restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-retry-nonce-"));
    tempDirs.push(dir);
    const path = join(dir, "store.db");
    const first = new SqliteTranscriptStore({ path });
    expect(first.claimAcceptedNonce("agent-a", "retry:turn-1")).toBe(true);
    first.append("agent-a", [{
      kind: "notice",
      type: "retry-attempt",
      id: "retry-attempt:turn-2",
      text: "Nova tentativa iniciada.",
      level: "info",
      clientNonce: "retry:turn-1",
      retryFailureTurnId: "turn-1",
    }]);
    first.close();

    const second = new SqliteTranscriptStore({ path });
    openStores.push(second);
    expect(second.hasAcceptedNonce("agent-a", "retry:turn-1")).toBe(true);
    expect(second.claimAcceptedNonce("agent-a", "retry:turn-1")).toBe(false);
  });

  it("reconcilia turno aceito sem resposta em uma falha recuperável única", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-open-turn-"));
    tempDirs.push(dir);
    const path = join(dir, "store.db");
    const first = new SqliteTranscriptStore({ path });
    openStores.push(first);
    first.beginTurnAttempt({
      turnId: "turn:user-only",
      agentId: "agent-a",
      clientNonce: "nonce:user-only",
      provider: "xai",
      model: "grok-4.6",
      phase: "preparing",
      startedAtMs: 100,
    });
    first.append("agent-a", [normalizeTranscriptEntry({
      kind: "message",
      id: "user-only",
      role: "user",
      content: "mensagem aceita antes do crash",
      timestampMs: 100,
      streaming: false,
      clientNonce: "nonce:user-only",
      turnId: "turn:user-only",
      provider: "xai",
      model: "grok-4.6",
    })]);
    first.rememberAcceptedNonce("agent-a", "nonce:user-only");
    first.close();

    const second = new SqliteTranscriptStore({ path });
    expect(second.hasCompletedTurnForNonce("agent-a", "nonce:user-only")).toBe(false);
    const notices = second.getEntries("agent-a").filter((entry) => entry.kind === "notice" && entry.type === "restart-interrupted");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      retryable: true,
      turnId: "turn:user-only",
      clientNonce: "nonce:user-only",
      provider: "xai",
      model: "grok-4.6",
    });
    second.close();

    const third = new SqliteTranscriptStore({ path });
    openStores.push(third);
    expect(third.getEntries("agent-a").filter((entry) => entry.kind === "notice" && entry.type === "restart-interrupted")).toHaveLength(1);
  });

  it("persiste a conclusão do turno junto da remoção da tentativa", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-completed-turn-"));
    tempDirs.push(dir);
    const path = join(dir, "store.db");
    const first = new SqliteTranscriptStore({ path });
    const conversationId = first.conversationStore.ensureDefault("agent-a").id;
    first.claimAcceptedNonce("agent-a", "nonce:completed", conversationId);
    first.beginTurnAttempt({
      turnId: "turn:completed",
      agentId: "agent-a",
      conversationId,
      clientNonce: "nonce:completed",
      provider: "xai",
      model: "grok-4.6",
      phase: "provider-pending",
      startedAtMs: 100,
    });
    first.append("agent-a", [normalizeTranscriptEntry({
      kind: "message",
      id: "user:completed",
      role: "user",
      content: "mensagem concluída",
      timestampMs: 100,
      clientNonce: "nonce:completed",
      turnId: "turn:completed",
    })], conversationId);
    first.rememberAcceptedNonce("agent-a", "nonce:completed", conversationId);
    first.finishTurnAttempt("agent-a", "turn:completed");
    expect(first.hasCompletedTurnForNonce("agent-a", "nonce:completed", conversationId)).toBe(true);
    first.close();

    const second = new SqliteTranscriptStore({ path });
    openStores.push(second);
    expect(second.hasCompletedTurnForNonce("agent-a", "nonce:completed", conversationId)).toBe(true);
    expect(second.snapshotAgent("agent-a").turnAttemptRows).toEqual([]);
    expect(second.snapshotAgent("agent-a").turnCompletionRows).toHaveLength(1);
  });

  it("marca resposta parcial como interrompida e cria retry após restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-partial-turn-"));
    tempDirs.push(dir);
    const path = join(dir, "store.db");
    const first = new SqliteTranscriptStore({ path });
    openStores.push(first);
    first.beginTurnAttempt({
      turnId: "turn:partial",
      agentId: "agent-a",
      clientNonce: "nonce:partial",
      provider: "xai",
      model: "grok-4.6",
      phase: "streaming",
      startedAtMs: 100,
    });
    first.append("agent-a", [
      normalizeTranscriptEntry({ kind: "message", id: "u-partial", role: "user", content: "pergunta", timestampMs: 100, streaming: false, clientNonce: "nonce:partial", turnId: "turn:partial" }),
      normalizeTranscriptEntry({ kind: "message", id: "a-partial", role: "assistant", content: "resposta truncada", timestampMs: 101, streaming: true, isStreaming: true, turnId: "turn:partial", provider: "xai", model: "grok-4.6" }),
    ]);
    first.rememberAcceptedNonce("agent-a", "nonce:partial");
    first.close();

    const second = new SqliteTranscriptStore({ path });
    openStores.push(second);
    const entries = second.getEntries("agent-a");
    const partial = entries.find((entry) => entry.kind === "message" && entry.id === "a-partial");
    expect(partial).toMatchObject({ streaming: false, isStreaming: false, completionState: "interrupted" });
    expect(entries.filter((entry) => entry.kind === "notice" && entry.type === "restart-interrupted")).toHaveLength(1);
  });

  it("mantém dedupe por nonce e aplica FIFO", () => {
    const store = createStore();
    store.rememberAcceptedNonce("agent-a", "n1");
    store.rememberAcceptedNonce("agent-a", "n2");
    store.rememberAcceptedNonce("agent-a", "n3");
    store.trimAcceptedNonces("agent-a", 2);

    expect(store.hasAcceptedNonce("agent-a", "n1")).toBe(false);
    expect(store.hasAcceptedNonce("agent-a", "n2")).toBe(true);
    expect(store.hasAcceptedNonce("agent-a", "n3")).toBe(true);
    store.rememberAcceptedNonce("agent-a", "n3");
    expect(store.hasAcceptedNonce("agent-a", "n3")).toBe(true);
    store.forgetAcceptedNonce("agent-a", "n3");
    expect(store.hasAcceptedNonce("agent-a", "n3")).toBe(false);
  });

  it("reivindica um nonce uma única vez com operação atômica", () => {
    const store = createStore();

    expect(store.claimAcceptedNonce("agent-a", "nonce-claim")).toBe(true);
    expect(store.claimAcceptedNonce("agent-a", "nonce-claim")).toBe(false);
    expect(store.hasAcceptedNonce("agent-a", "nonce-claim")).toBe(true);
  });

  it("replace atualiza o payload da entry pelo id", () => {
    const store = createStore();
    store.append("agent-a", [{
      kind: "tool-call",
      id: "call-1",
      name: "file",
      summary: "write Documents/a.md",
      status: "pending",
    }]);
    expect(store.replace("agent-a", "call-1", {
      kind: "tool-call",
      id: "call-1",
      name: "file",
      summary: "write Documents/a.md",
      status: "completed",
      result: { ok: true, operation: "file.write", bytes: 2, path: "Documents/a.md" },
    })).toBe(true);
    expect(store.getEntries("agent-a")).toEqual([{
      kind: "tool-call",
      id: "call-1",
      name: "file",
      summary: "write Documents/a.md",
      status: "completed",
      result: { ok: true, operation: "file.write", bytes: 2, path: "Documents/a.md" },
    }]);
    expect(store.replace("agent-a", "missing", {
      kind: "tool-call",
      id: "missing",
      name: "file",
      summary: "x",
      status: "failed",
    })).toBe(false);
  });

  it("replace survives reopen and keeps a single row", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-replace-reopen-"));
    tempDirs.push(dir);
    const path = join(dir, "store.db");
    const first = new SqliteTranscriptStore({ path });
    first.append("agent-a", [{
      kind: "tool-call",
      id: "call-1",
      name: "file",
      summary: "list .",
      status: "pending",
    }]);
    first.replace("agent-a", "call-1", {
      kind: "tool-call",
      id: "call-1",
      name: "file",
      summary: "list .",
      status: "completed",
      result: { ok: true, operation: "file.list", count: 0, path: "." },
    });
    first.close();
    const second = new SqliteTranscriptStore({ path });
    openStores.push(second);
    const entries = second.getEntries("agent-a");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "call-1", status: "completed", result: { ok: true } });
  });

  it("reconcilia mensagens streaming e tools abertas ao reabrir o store", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-reconcile-"));
    tempDirs.push(dir);
    const path = join(dir, "store.db");
    const first = new SqliteTranscriptStore({ path });
    first.append("agent-a", [
      normalizeTranscriptEntry({
        kind: "message",
        id: "stream-1",
        role: "assistant",
        content: "parcial",
        timestampMs: 1,
        streaming: true,
        isStreaming: true,
      }),
      {
        kind: "tool-call",
        id: "tool-1",
        name: "file.read",
        summary: "read",
        status: "running",
      },
    ]);
    first.close();

    const second = new SqliteTranscriptStore({ path });
    openStores.push(second);
    const entries = second.getEntries("agent-a");

    expect(entries[0]).toMatchObject({ id: "stream-1", streaming: false, isStreaming: false, content: "parcial" });
    expect(entries[1]).toMatchObject({
      id: "tool-1",
      status: "failed",
      result: { ok: false, code: "aborted" },
    });
    expect(second.getOpenToolCalls("agent-a")).toEqual([]);
  });

  it("não reconcilia trabalho vivo enquanto outra instância possui o store", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-owned-store-"));
    tempDirs.push(dir);
    const path = join(dir, "store.db");
    const first = new SqliteTranscriptStore({ path });
    openStores.push(first);
    first.append("agent-a", [normalizeTranscriptEntry({
      kind: "message",
      id: "stream-live",
      role: "assistant",
      content: "em andamento",
      timestampMs: 1,
      streaming: true,
      isStreaming: true,
    })]);

    const second = new SqliteTranscriptStore({ path });
    openStores.push(second);
    expect(second.getEntries("agent-a")[0]).toMatchObject({
      id: "stream-live",
      streaming: true,
      isStreaming: true,
    });
  });

  it("não confunde PID reutilizado com o owner antigo do store", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-reused-owner-"));
    tempDirs.push(dir);
    const path = join(dir, "store.db");
    const initial = new SqliteTranscriptStore({ path });
    initial.close();
    const db = new Database(path);
    try {
      db.prepare("INSERT INTO runtime_owners(token, pid, process_started_at_ms, executable_path) VALUES (?, ?, ?, ?)")
        .run("stale-owner", process.pid, 100, "C:\\old\\openbot.exe");
      db.prepare("INSERT INTO accepted_nonces(agent_id, nonce, accepted_at_ms) VALUES (?, ?, ?)").run("agent-a", "stale-nonce", 1);
      db.prepare("INSERT INTO pending_nonces(agent_id, nonce, accepted_at_ms) VALUES (?, ?, ?)").run("agent-a", "stale-nonce", 1);
      db.prepare("INSERT INTO transcript_entries(agent_id, entry_id, kind, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?)").run(
        "agent-a",
        "partial-reused",
        "message",
        JSON.stringify({ kind: "message", id: "partial-reused", role: "assistant", content: "parcial", timestampMs: 1, streaming: true, isStreaming: true }),
        1,
      );
    } finally {
      db.close();
    }

    const currentIdentity = { startedAtMs: 200, executablePath: "C:\\new\\openbot.exe" };
    const reopened = new SqliteTranscriptStore({
      path,
      currentProcessIdentity: currentIdentity,
      processIdentity: () => currentIdentity,
    });
    openStores.push(reopened);

    expect(reopened.hasAcceptedNonce("agent-a", "stale-nonce")).toBe(false);
    expect(reopened.getEntries("agent-a")[0]).toMatchObject({ streaming: false, completionState: "interrupted" });
  });

  it("pagina o tail com beforeSeq numérico", () => {
    const store = createStore();
    store.append("agent-a", [
      message("m1", "user", "um", 1),
      message("m2", "assistant", "dois", 2),
      message("m3", "user", "três", 3),
    ]);

    const first = store.getAgentTranscriptTail("agent-a", 2);
    expect(first.entries).toEqual([
      message("m2", "assistant", "dois", 2),
      message("m3", "user", "três", 3),
    ]);
    expect(first.nextBeforeSeq).toBe(2);

    const second = store.openAgentTail("agent-a", 2, first.nextBeforeSeq);
    expect(second).toEqual({ entries: [message("m1", "user", "um", 1)] });
  });

  it("rejeita beforeSeq e limites inválidos", () => {
    const store = createStore();
    expect(() => store.getAgentTranscriptTail("agent-a", 0)).toThrow(/limit/);
    expect(() => store.getAgentTranscriptTail("agent-a", MAX_TRANSCRIPT_PAGE_LIMIT + 1)).toThrow(/limit/);
    expect(() => store.getAgentTranscriptTail("agent-a", 1, 0)).toThrow(/beforeSeq/);
    expect(() => store.getAgentTranscriptTail("agent-a", 1, Number.NaN)).toThrow(/beforeSeq/);
  });

  it("produz outline vazio ou com título e última mensagem", () => {
    const store = createStore();
    expect(store.getConversationOutline("agent-a")).toEqual<ConversationOutline>({
      title: null,
      lastMessage: null,
    });

    store.append("agent-a", [
      message("u1", "user", "Primeira pergunta", 10),
      message("a1", "assistant", "Última resposta", 20),
    ]);

    expect(store.getConversationOutline("agent-a")).toEqual({
      title: "Primeira pergunta",
      lastMessage: "Última resposta",
    });
  });

  it("touches the conversation once per append batch using the max timestamps", () => {
    const store = createStore();
    const conversation = store.conversationStore.ensureDefault("agent-a");
    const seedDb = new Database(store.path);
    try {
      seedDb.prepare("UPDATE agent_conversations SET created_at_ms = 0, updated_at_ms = 0 WHERE agent_id = ? AND id = ?").run("agent-a", conversation.id);
      seedDb.exec(`
        CREATE TABLE conversation_touch_audit (touches INTEGER NOT NULL);
        CREATE TRIGGER audit_conversation_touch
        AFTER UPDATE ON agent_conversations
        BEGIN
          INSERT INTO conversation_touch_audit (touches) VALUES (1);
        END;
      `);
    } finally {
      seedDb.close();
    }
    store.append("agent-a", [
      message("older-user", "user", "primeira", 10),
      normalizeTranscriptEntry({ kind: "notice", id: "notice", text: "info", level: "info", timestampMs: 40 }),
      message("newer-assistant", "assistant", "última", 30),
    ], conversation.id);

    const db = new Database(store.path);
    try {
      expect(db.prepare("SELECT updated_at_ms, last_message_at_ms FROM agent_conversations WHERE agent_id = ? AND id = ?").get("agent-a", conversation.id))
        .toEqual({ updated_at_ms: 40, last_message_at_ms: 30 });
      expect(db.prepare("SELECT COUNT(*) AS touches FROM conversation_touch_audit").get()).toEqual({ touches: 1 });
    } finally {
      db.close();
    }
  });

  it("limpa transcript e ledger de um agente sem afetar outro", () => {
    const store = createStore();
    store.append("agent-a", [message("a", "user", "A", 1)]);
    store.append("agent-b", [message("b", "user", "B", 2)]);
    store.rememberAcceptedNonce("agent-a", "n-a");
    store.rememberInteractionDecision("agent-a", "req-a", "tool", "allow");
    store.rememberInteractionDecision("agent-b", "req-b", "tool", "deny");
    store.clear("agent-a");

    expect(store.getEntries("agent-a")).toEqual([]);
    expect(store.hasAcceptedNonce("agent-a", "n-a")).toBe(false);
    expect(store.getInteractionDecision("agent-a", "req-a", "tool")).toBeNull();
    expect(store.getInteractionDecision("agent-b", "req-b", "tool")).not.toBeNull();
    expect(store.getEntries("agent-b")).toHaveLength(1);
  });

  it("substitui tool-call pela identidade local sem sobrescrever card com id colidente", () => {
    const store = createStore();
    const localToolCallId = "turn-1\0same-id";
    const running: Extract<TranscriptEntry, { kind: "tool-call" }> = {
      kind: "tool-call",
      id: "same-id",
      name: "write-file",
      summary: "Escrever arquivo",
      status: "running",
      localToolCallId,
    };
    const approval: TranscriptEntry = {
      kind: "send-message",
      id: "same-id",
      message: {
        type: "local-tool-permission",
        ask: {
          status: "pending",
          requestId: localToolCallId,
          action: "write-file",
          target: "notes.txt",
        },
      },
      streaming: false,
    };
    store.append("agent-a", [running, approval]);

    expect(store.replaceToolCallByLocalId("agent-a", localToolCallId, {
      ...running,
      status: "completed",
      result: { ok: true, operation: "file.write", bytes: 2, path: "notes.txt" },
    })).toBe(true);

    const entries = store.getEntries("agent-a");
    expect(entries[0]).toMatchObject({ kind: "tool-call", status: "completed", result: { ok: true } });
    expect(entries[1]).toEqual(approval);
  });

  it("rejects a forged full snapshot before deleting the current agent state", () => {
    const store = createStore();
    const conversation = store.conversationStore.ensureDefault("agent-a");
    store.append("agent-a", [message("seed", "user", "preservar", 1)], conversation.id);
    store.rememberAcceptedNonce("agent-a", "nonce-seed", conversation.id);
    store.rememberInteractionDecision("agent-a", "request-seed", "tool", "allow", conversation.id);
    store.beginTurnAttempt({
      turnId: "turn-seed",
      agentId: "agent-a",
      conversationId: conversation.id,
      clientNonce: "nonce-seed",
      provider: "xai",
      model: "grok-4.6",
      phase: "preparing",
      startedAtMs: 2,
    });

    const snapshot = store.snapshotAgent("agent-a");
    const forged = {
      ...snapshot,
      transcriptRows: snapshot.transcriptRows.map((row, index) => index === 0 ? { ...row, conversationId: "missing-conversation" } : row),
    };

    expect(() => store.restoreAgent("agent-a", forged)).toThrow(/conversa|snapshot/i);
    expect(store.getEntries("agent-a", conversation.id)).toEqual([message("seed", "user", "preservar", 1)]);
    expect(store.hasAcceptedNonce("agent-a", "nonce-seed", conversation.id)).toBe(true);
    expect(store.getInteractionDecision("agent-a", "request-seed", "tool", conversation.id)).toMatchObject({ decision: "allow" });
    expect(store.snapshotAgent("agent-a").turnAttemptRows).toHaveLength(1);
  });

  it("rejects a foreign resume checkpoint atomically", () => {
    const store = createStore();
    const conversation = store.conversationStore.ensureDefault("agent-a");
    const scope = {
      agentId: "agent-a",
      conversationId: conversation.id,
      turnId: "turn-resume",
      provider: "xai",
      model: "grok-4.6",
    } as const;
    store.createResumeCheckpoint({
      checkpointId: "checkpoint-resume",
      ...scope,
      cursor: "fixture-v1:resume:1",
      safeSequenceId: 0,
      completedEffectIds: [],
      expiresAtMs: Date.now() + 60_000,
      version: 1,
      budget: { maxProviderAttempts: 2, providerAttemptsUsed: 0, maxToolRounds: 8, toolRoundsUsed: 0, maxToolCalls: 16, toolCallsUsed: 0 },
    });
    store.prepareResumeEffect(scope, "effect-pending", "hash-pending");
    const snapshot = store.snapshotAgent("agent-a");
    const forged = {
      ...snapshot,
      resumeCheckpoints: snapshot.resumeCheckpoints.map((checkpoint) => ({ ...checkpoint, agentId: "other-agent" })),
    };

    expect(() => store.restoreAgent("agent-a", forged)).toThrow(/checkpoint de outro agente/i);
    expect(store.snapshotAgent("agent-a").resumeCheckpoints).toEqual(snapshot.resumeCheckpoints);
    expect(store.getResumeEffect(scope, "effect-pending")).toMatchObject({ status: "prepared" });
  });

  it("rejects an invalid resume cursor before clearing the agent", () => {
    const store = createStore();
    const conversation = store.conversationStore.ensureDefault("agent-a");
    const scope = {
      agentId: "agent-a",
      conversationId: conversation.id,
      turnId: "turn-cursor",
      provider: "xai",
      model: "grok-4.6",
    } as const;
    store.createResumeCheckpoint({
      checkpointId: "checkpoint-cursor",
      ...scope,
      cursor: "fixture-v1:cursor:1",
      safeSequenceId: 0,
      completedEffectIds: [],
      expiresAtMs: Date.now() + 60_000,
      version: 1,
      budget: { maxProviderAttempts: 2, providerAttemptsUsed: 0, maxToolRounds: 8, toolRoundsUsed: 0, maxToolCalls: 16, toolCallsUsed: 0 },
    });
    const snapshot = store.snapshotAgent("agent-a");
    const forged = {
      ...snapshot,
      resumeCheckpoints: snapshot.resumeCheckpoints.map((checkpoint) => ({ ...checkpoint, cursor: "" })),
    };

    expect(() => store.restoreAgent("agent-a", forged)).toThrow(/cursor/i);
    expect(store.getResumeCheckpoint(scope)?.cursor).toBe("fixture-v1:cursor:1");
  });

  it("prevalidates an invalid memory snapshot before clearing persisted rows", () => {
    const store = createStore();
    const conversation = store.conversationStore.ensureDefault("agent-a");
    store.append("agent-a", [message("seed", "user", "preservar", 1)], conversation.id);
    const originalClearAgentRows = store.memoryStore.clearAgentRows.bind(store.memoryStore);
    let clearCalls = 0;
    store.memoryStore.clearAgentRows = ((agentId: string) => {
      clearCalls += 1;
      return originalClearAgentRows(agentId);
    });

    const snapshot = store.snapshotAgent("agent-a");
    const invalidMemorySnapshot = {
      ...snapshot.memorySnapshot!,
      memories: [
        ...snapshot.memorySnapshot!.memories,
        {
          id: "dup-memory",
          agentId: "other-agent",
          kind: "fact" as const,
          canonicalKey: "dup-memory",
          text: "inválida",
          valueJson: null,
          trust: "verified_tool" as const,
          status: "active" as const,
          importance: 50,
          confidence: 0.5,
          pinned: false,
          sourceConversationId: conversation.id,
          sourceEntryIds: [],
          validFromMs: 1,
          validToMs: null,
          expiresAtMs: null,
          supersededBy: null,
          revision: 1,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
    };
    const forged = { ...snapshot, memorySnapshot: invalidMemorySnapshot };

    expect(() => store.restoreAgent("agent-a", forged)).toThrow(/memória de outro agente|snapshot/i);
    expect(clearCalls).toBe(0);
    expect(store.getEntries("agent-a", conversation.id)).toEqual([message("seed", "user", "preservar", 1)]);
  });

  it("mescla preview live no tail sem antecipar a escrita SQLite", () => {
    const store = createStore();
    const conversation = store.conversationStore.ensureDefault("agent-a");
    const first = message("assistant-live", "assistant", "E2E ", 1);
    const preview = { ...first, content: "E2E incremental stream ", streaming: true };
    store.append("agent-a", [first], conversation.id);

    store.setLiveEntry("agent-a", preview, conversation.id);
    expect(store.openAgentTail("agent-a", 50, undefined, conversation.id).entries).toEqual([preview]);

    store.clearLiveEntry("agent-a", "assistant-live", conversation.id);
    expect(store.openAgentTail("agent-a", 50, undefined, conversation.id).entries).toEqual([first]);
  });
});
