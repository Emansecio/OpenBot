import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { USER_PROFILE_AGENT_ID } from "../src/memory/types.js";
import { SqliteTranscriptStore } from "../src/store/index.js";

function chat(store: SqliteTranscriptStore, agentId: string, temporary = false): string {
  return store.conversationStore.create(agentId, { temporary }).id;
}


describe("memory core", () => {

  it("applies delete-derived only when a conversation is deleted", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const source = chat(transcript, "agent-a");
    chat(transcript, "agent-a");
    const memory = transcript.memoryStore.upsertMemory("agent-a", {
      kind: "fact", canonicalKey: "derived", text: "derivada", trust: "verified_tool", sourceConversationId: source,
    }, { kind: "admin" });
    transcript.conversationStore.delete("agent-a", source, { memoryPolicy: "delete-derived" });
    expect(transcript.memoryStore.getMemory("agent-a", memory.id)?.status).toBe("forgotten");
    transcript.close();
  });

  it("forgets refs-only memories whose deleted conversation leaves no provenance", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const source = chat(transcript, "agent-a");
    chat(transcript, "agent-a");
    const memory = transcript.memoryStore.upsertMemory("agent-a", {
      kind: "fact", canonicalKey: "refs-only", text: "derivada por entry", trust: "verified_tool",
      sourceEntryIds: [{ conversationId: source, entryId: "entry-1" }],
    }, { kind: "admin" });
    transcript.conversationStore.delete("agent-a", source, { memoryPolicy: "delete-derived" });
    expect(transcript.memoryStore.getMemory("agent-a", memory.id)?.status).toBe("forgotten");
    transcript.close();
  });

  it("aplica delete-derived à memória de perfil pela proveniência e preserva fontes válidas", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const source = chat(transcript, "agent-a");
    const survivor = chat(transcript, "agent-a");
    const exclusive = transcript.memoryStore.upsertMemory(USER_PROFILE_AGENT_ID, {
      kind: "preference",
      canonicalKey: "profile-exclusive",
      text: "derivada somente da conversa apagada",
      trust: "verified_tool",
      sourceConversationId: source,
      sourceEntryIds: [{ conversationId: source, entryId: "source-entry" }],
    }, { kind: "admin" });
    const multiSource = transcript.memoryStore.upsertMemory(USER_PROFILE_AGENT_ID, {
      kind: "preference",
      canonicalKey: "profile-multi-source",
      text: "também sustentada pela conversa sobrevivente",
      trust: "verified_tool",
      sourceConversationId: source,
      sourceEntryIds: [
        { conversationId: source, entryId: "source-entry" },
        { conversationId: survivor, entryId: "survivor-entry" },
      ],
    }, { kind: "admin" });
    const independent = transcript.memoryStore.upsertMemory(USER_PROFILE_AGENT_ID, {
      kind: "preference",
      canonicalKey: "profile-independent",
      text: "preferência sem conversa de origem",
      trust: "user",
    }, { kind: "admin" });

    transcript.conversationStore.delete("agent-a", source, { memoryPolicy: "delete-derived" });

    expect(transcript.memoryStore.getMemory(USER_PROFILE_AGENT_ID, exclusive.id)?.status).toBe("forgotten");
    expect(transcript.memoryStore.getMemory(USER_PROFILE_AGENT_ID, multiSource.id)).toMatchObject({
      status: "active",
      sourceConversationId: survivor,
      sourceEntryIds: [{ conversationId: survivor, entryId: "survivor-entry" }],
    });
    expect(transcript.memoryStore.getMemory(USER_PROFILE_AGENT_ID, independent.id)?.status).toBe("active");

    const retainSource = chat(transcript, "agent-a");
    chat(transcript, "agent-a");
    const retained = transcript.memoryStore.upsertMemory(USER_PROFILE_AGENT_ID, {
      kind: "preference",
      canonicalKey: "profile-retained",
      text: "preferência mantida explicitamente",
      trust: "user",
      sourceConversationId: retainSource,
      sourceEntryIds: [{ conversationId: retainSource, entryId: "retain-entry" }],
    }, { kind: "admin" });
    transcript.conversationStore.delete("agent-a", retainSource, { memoryPolicy: "retain" });
    expect(transcript.memoryStore.getMemory(USER_PROFILE_AGENT_ID, retained.id)).toMatchObject({
      status: "active",
      sourceConversationId: retainSource,
    });
    transcript.close();
  });

  it("rejeita memória de perfil derivada de conversa temporária", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const temporary = chat(transcript, "agent-a", true);
    expect(() => transcript.memoryStore.upsertMemory(USER_PROFILE_AGENT_ID, {
      kind: "preference",
      canonicalKey: "profile-temporary",
      text: "não persistir de conversa temporária",
      trust: "verified_tool",
      sourceConversationId: temporary,
      sourceEntryIds: [{ conversationId: temporary, entryId: "temporary-entry" }],
    }, { kind: "admin" })).toThrow(/temporária/);
    transcript.close();
  });

  it("deletes conversation jobs even when retaining memories and summaries", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const source = chat(transcript, "agent-a");
    chat(transcript, "agent-a");
    const queued = transcript.memoryStore.enqueueJob({ agentId: "agent-a", conversationId: source, provider: "xai", model: "grok-4.6", fromSequenceId: 0, throughSequenceId: 1 });
    const running = transcript.memoryStore.enqueueJob({ agentId: "agent-a", conversationId: source, provider: "xai", model: "grok-4.6", fromSequenceId: 2, throughSequenceId: 3 });
    transcript.memoryStore.claimJob("agent-a", running.id);
    transcript.conversationStore.delete("agent-a", source, { memoryPolicy: "retain" });
    expect(transcript.memoryStore.getJob("agent-a", queued.id)).toBeNull();
    expect(transcript.memoryStore.getJob("agent-a", running.id)).toBeNull();
    transcript.close();
  });

  it("does not rebuild FTS on reopen and requires explicit repair for retained memory search", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-memory-reopen-"));
    const dbPath = join(dir, "store.db");
    const first = new SqliteTranscriptStore({ path: dbPath });
    const source = chat(first, "agent-a");
    chat(first, "agent-a");
    const memory = first.memoryStore.upsertMemory("agent-a", {
      kind: "fact", canonicalKey: "keep", text: "preferência retida azul", trust: "verified_tool", sourceConversationId: source,
    }, { kind: "admin" });
    first.conversationStore.delete("agent-a", source, { memoryPolicy: "retain" });
    first.close();
    const corruptFts = new Database(dbPath);
    try {
      corruptFts.exec(`
        DELETE FROM memory_fts;
        DELETE FROM history_fts;
        INSERT INTO history_fts(source_id, agent_id, conversation_id, source_type, content, sequence_id)
        VALUES ('sentinel', 'agent-a', 'sentinel', 'summary', 'sentinel marker', 0);
      `);
    } finally {
      corruptFts.close();
    }
    const second = new SqliteTranscriptStore({ path: dbPath });
    try {
      expect(second.memoryStore.getMemory("agent-a", memory.id)?.status).toBe("active");
      expect(second.memoryStore.searchMemories("agent-a", "retida")).toEqual([]);
      const raw = new Database(dbPath, { readonly: true });
      try {
        expect(raw.prepare("SELECT COUNT(*) AS count FROM history_fts WHERE source_id = 'sentinel'").get()).toEqual({ count: 1 });
      } finally {
        raw.close();
      }
      second.memoryStore.rebuildFts();
      expect(second.memoryStore.searchMemories("agent-a", "retida").map((result) => result.memory.id)).toEqual([memory.id]);
      const repaired = new Database(dbPath, { readonly: true });
      try {
        expect(repaired.prepare("SELECT COUNT(*) AS count FROM history_fts WHERE source_id = 'sentinel'").get()).toEqual({ count: 0 });
      } finally {
        repaired.close();
      }
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps scoped memory and history searches correct after delete-derived without a global rebuild", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const source = chat(transcript, "agent-a");
    const survivor = chat(transcript, "agent-a");
    transcript.append("agent-a", [{
      kind: "message",
      id: "source-message",
      role: "user",
      content: "obsolete-token",
      timestampMs: 1,
      streaming: false,
    }], source);
    transcript.append("agent-a", [{
      kind: "message",
      id: "survivor-message",
      role: "user",
      content: "survivor-token",
      timestampMs: 2,
      streaming: false,
    }], survivor);
    transcript.memoryStore.upsertSummary("agent-a", {
      conversationId: source,
      throughSequenceId: 1,
      summaryJson: { obsolete: true },
      renderedText: "obsolete-summary",
    });
    const kept = transcript.memoryStore.upsertMemory("agent-a", {
      kind: "fact",
      canonicalKey: "scoped-keep",
      text: "lembrança permanente",
      trust: "verified_tool",
      sourceConversationId: survivor,
      sourceEntryIds: [
        { conversationId: source, entryId: "source-message" },
        { conversationId: survivor, entryId: "survivor-message" },
      ],
    }, { kind: "admin" });
    const rebuildFts = vi.spyOn(transcript.memoryStore, "rebuildFts");

    transcript.conversationStore.delete("agent-a", source, { memoryPolicy: "delete-derived" });

    expect(rebuildFts).not.toHaveBeenCalled();
    expect(transcript.memoryStore.searchHistory("agent-a", "obsolete-token")).toEqual([]);
    expect(transcript.memoryStore.searchHistory("agent-a", "obsolete-summary")).toEqual([]);
    expect(transcript.memoryStore.searchHistory("agent-a", "survivor-token").map((result) => result.conversationId)).toEqual([survivor]);
    expect(transcript.memoryStore.searchMemories("agent-a", "permanente").map((result) => result.memory.id)).toEqual([kept.id]);
    expect(transcript.memoryStore.getMemory("agent-a", kept.id)).toMatchObject({
      sourceConversationId: survivor,
      sourceEntryIds: [{ conversationId: survivor, entryId: "survivor-message" }],
    });
    transcript.close();
  });

  it("retains summaries globally after retain deletion and across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-memory-summary-retain-"));
    const dbPath = join(dir, "store.db");
    const first = new SqliteTranscriptStore({ path: dbPath });
    const source = chat(first, "agent-a");
    const survivor = chat(first, "agent-a");
    first.append("agent-a", [{ kind: "message", id: "src-1", role: "user", content: "histórico retido azul", timestampMs: 1 }], source);
    first.memoryStore.upsertSummary("agent-a", {
      conversationId: source,
      throughSequenceId: 1,
      summaryJson: { short: "retido" },
      renderedText: "summary retida azul",
    });
    first.conversationStore.delete("agent-a", source, { memoryPolicy: "retain" });
    expect(first.memoryStore.getSummary("agent-a", source)).toMatchObject({
      conversationId: source,
      renderedText: "summary retida azul",
    });
    expect(first.memoryStore.searchHistory("agent-a", "retida").some((result) => (
      result.kind === "summary" && result.conversationId === source
    ))).toBe(true);
    first.close();

    const second = new SqliteTranscriptStore({ path: dbPath });
    try {
      expect(second.memoryStore.getSummary("agent-a", source)).toMatchObject({
        conversationId: source,
        renderedText: "summary retida azul",
      });
      expect(second.memoryStore.searchHistory("agent-a", "retida").some((result) => (
        result.kind === "summary" && result.conversationId === source
      ))).toBe(true);
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches scoped memory search through sourceEntryIds even when sourceConversationId differs", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const currentConversation = chat(transcript, "agent-a");
    const foreignConversation = chat(transcript, "agent-a");
    const otherConversation = chat(transcript, "agent-a");
    const refsOnly = transcript.memoryStore.upsertMemory("agent-a", {
      kind: "fact",
      canonicalKey: "refs-only-current",
      text: "lembrança scoped por refs",
      trust: "verified_tool",
      sourceConversationId: foreignConversation,
      sourceEntryIds: [
        { conversationId: currentConversation, entryId: "entry-current" },
        { conversationId: foreignConversation, entryId: "entry-foreign" },
      ],
    }, { kind: "admin" });
    transcript.memoryStore.upsertMemory("agent-a", {
      kind: "fact",
      canonicalKey: "refs-only-other",
      text: "lembrança scoped por refs",
      trust: "verified_tool",
      sourceEntryIds: [{ conversationId: otherConversation, entryId: "entry-other" }],
    }, { kind: "admin" });

    const scoped = transcript.memoryStore.searchMemories("agent-a", "scoped", { conversationId: currentConversation });
    expect(scoped.map((result) => result.memory.id)).toEqual([refsOnly.id]);

    const historyScoped = transcript.memoryStore.searchHistory("agent-a", "scoped", { conversationId: currentConversation });
    expect(historyScoped.filter((result) => result.kind === "memory").map((result) => result.memory?.id)).toEqual([refsOnly.id]);
    transcript.close();
  });
});
