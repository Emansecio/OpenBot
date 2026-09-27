import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MemoryReflectionWorker, applyReflectionResult } from "../src/memory/reflection.js";
import { SqliteMemoryStore } from "../src/memory/sqlite-store.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { OPENBOT_SCHEMA_VERSION } from "../src/store/schema.js";
import { USER_PROFILE_AGENT_ID } from "../src/memory/types.js";

function chat(store: SqliteTranscriptStore, agentId: string, temporary = false): string {
  return store.conversationStore.create(agentId, { temporary }).id;
}

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (predicate(value)) return value;
    if (Date.now() - start >= timeoutMs) throw new Error("timeout waiting for memory core condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}


describe("memory core", () => {
  it.each(["queued", "loading", "stream"])("cancels archived reflection at %s without cancelling another conversation", async phase => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const conversationId = chat(transcript, "agent-a");
    chat(transcript, "agent-a");
    const otherConversationId = chat(transcript, "agent-b");
    let canRun = phase !== "queued";
    let reached = false;
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const reflected: string[] = [];
    const worker = new MemoryReflectionWorker({ store: transcript.memoryStore, canRunAgent: () => canRun,
      loadInput: async (job, abort) => {
        if (job.conversationId === conversationId && phase === "loading") {
          signal = abort;
          reached = true;
          await pending;
        }
        return { ...job, entries: [] };
      },
      reflect: async (input, abort) => {
        reflected.push(input.conversationId);
        if (input.conversationId === conversationId) {
          signal = abort;
          reached = true;
          await pending;
        } else expect(abort.aborted).toBe(false);
        return { operations: [] };
      },
    });
    try {
      const job = transcript.memoryStore.enqueueJob({ agentId: "agent-a", conversationId, provider: "xai", model: "grok-4.6", fromSequenceId: 0, throughSequenceId: 1 });
      const other = transcript.memoryStore.enqueueJob({ agentId: "agent-b", conversationId: otherConversationId, provider: "xai", model: "grok-4.6", fromSequenceId: 0, throughSequenceId: 1 });
      worker.start();
      if (phase !== "queued") await waitFor(() => reached, Boolean);
      transcript.conversationStore.archive("agent-a", conversationId);
      worker.cancelConversation("agent-a", conversationId);
      if (signal) expect(signal.aborted).toBe(true);
      canRun = true;
      worker.start();
      release();
      await worker.waitForIdle();
      expect(transcript.memoryStore.getJob("agent-a", job.id)).toMatchObject({ status: "dead", lastErrorCode: "conversation_archived" });
      expect(transcript.memoryStore.getJob("agent-b", other.id)?.status).toBe("complete");
      expect(reflected.filter(id => id === conversationId)).toHaveLength(phase === "stream" ? 1 : 0);
    } finally {
      release();
      await worker.close();
      transcript.close();
    }
  });
  it("creates the current schema and borrows the transcript connection", () => {
    const db = new Database(":memory:");
    const transcript = new SqliteTranscriptStore({ path: ":memory:", database: db });
    expect(db.pragma("user_version", { simple: true })).toBe(OPENBOT_SCHEMA_VERSION);
    expect(transcript.databaseForSharedStores()).toBe(db);
    expect(transcript.memoryStore.getSettings("agent-a").mode).toBe("automatic");
    expect(transcript.memoryStore.listMemories("agent-a")).toEqual([]);
    transcript.close();
    expect(db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
    db.close();
  });

  it("deduplicates canonical keys, records conflict revisions and keeps forget tombstones", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const conversationId = chat(transcript, "agent-a");
    const first = transcript.memoryStore.upsertMemory("agent-a", {
      kind: "preference",
      canonicalKey: " Favorite Color ",
      text: "azul",
      trust: "user",
      sourceConversationId: conversationId,
    }, { kind: "admin" });
    const second = transcript.memoryStore.upsertMemory("agent-a", {
      kind: "preference",
      canonicalKey: "favorite color",
      text: "verde",
      trust: "user",
      sourceConversationId: conversationId,
    }, { kind: "admin" });
    expect(transcript.memoryStore.listMemories("agent-a").map((memory) => memory.text)).toEqual(["verde"]);
    expect(transcript.memoryStore.getMemory("agent-a", first.id)?.status).toBe("superseded");
    expect(transcript.memoryStore.snapshotAgent("agent-a").revisions.length).toBeGreaterThanOrEqual(2);
    expect(transcript.memoryStore.forgetMemory("agent-a", second.id, { kind: "admin" }).status).toBe("forgotten");
    expect(transcript.memoryStore.getMemory("agent-a", second.id)?.status).toBe("forgotten");
    transcript.close();
  });

  it("rejeita reuso de tombstone quando a canonicalKey já tem identidade ativa", () => {
    const memory = new SqliteMemoryStore({ path: ":memory:", now: () => 100 });
    const old = memory.upsertMemory("agent-a", {
      id: "memory-old",
      kind: "fact",
      canonicalKey: "same-key",
      text: "valor antigo",
      trust: "verified_tool",
    }, { kind: "admin" });
    expect(memory.forgetMemory("agent-a", old.id, { kind: "admin" }).status).toBe("forgotten");

    const recreated = memory.upsertMemory("agent-a", {
      id: old.id,
      kind: "fact",
      canonicalKey: "same-key",
      text: "valor novo",
      trust: "verified_tool",
    }, { kind: "admin" });
    expect(recreated.id).not.toBe(old.id);
    expect(recreated.status).toBe("active");

    expect(() => memory.upsertMemory("agent-a", {
      id: old.id,
      kind: "fact",
      canonicalKey: "same-key",
      text: "valor repetido",
      trust: "verified_tool",
    }, { kind: "admin" })).toThrow(/memoryId retirado/iu);
    expect(memory.getMemory("agent-a", old.id)?.status).toBe("forgotten");
    expect(memory.getMemory("agent-a", recreated.id)?.status).toBe("active");

    const different = memory.upsertMemory("agent-a", {
      id: old.id,
      kind: "fact",
      canonicalKey: "different-key",
      text: "outra identidade",
      trust: "verified_tool",
    }, { kind: "admin" });
    expect(different.id).not.toBe(old.id);
    expect(different.canonicalKey).toBe("different-key");
    memory.close();
  });

  it("rejects keystore-known opaque secrets at the memory write boundary", () => {
    const secrets = ["opaque-known-credential-9f8e2d"];
    const transcript = new SqliteTranscriptStore({ path: ":memory:", secretValues: () => secrets });
    const remember = (text: string) => transcript.memoryStore.upsertMemory("agent-a", {
      kind: "fact",
      canonicalKey: "known-credential",
      text,
      trust: "external_observation",
    }, { kind: "admin" });

    // Opaque value with no recognizable pattern: only the keystore-provided
    // secret list can catch it.
    expect(() => remember("valor anotado: opaque-known-credential-9f8e2d")).toThrow(/segredo|credencial/i);
    expect(transcript.memoryStore.listMemories("agent-a")).toEqual([]);

    // Values registered after construction are covered too: the callback is
    // re-evaluated on each write instead of being captured once.
    secrets.push("opaque-known-credential-77aa1b");
    expect(() => remember("outro valor: opaque-known-credential-77aa1b")).toThrow(/segredo|credencial/i);
    expect(transcript.memoryStore.listMemories("agent-a")).toEqual([]);
    transcript.close();
  });

  it("separa metadados de autorização da validação da sobrecarga por objeto", () => {
    const memory = new SqliteMemoryStore({ path: ":memory:" });
    const objectResult = memory.upsertMemory({
      id: "object-id",
      agentId: "agent-a",
      authority: { kind: "admin" },
      kind: "fact",
      canonicalKey: "object-authority",
      text: "entrada por objeto",
      trust: "verified_tool",
    });
    const positionalResult = memory.upsertMemory("agent-a", {
      id: "positional-id",
      kind: "fact",
      canonicalKey: "positional-authority",
      text: "entrada posicional",
      trust: "verified_tool",
    }, { kind: "admin" });
    expect(objectResult).toMatchObject({ agentId: "agent-a", kind: "fact", text: "entrada por objeto" });
    expect(positionalResult).toMatchObject({ agentId: "agent-a", kind: "fact", text: "entrada posicional" });

    const automaticAuthority = { kind: "automatic", conversationId: "conversation-a", evidenceIds: [] } as const;
    expect(() => memory.upsertMemory({
      agentId: "agent-a",
      authority: automaticAuthority,
      kind: "fact",
      canonicalKey: "automatic-object",
      text: "sem proveniência",
      trust: "verified_tool",
    })).toThrow(/mutação automática/iu);
    expect(() => memory.upsertMemory("agent-a", {
      kind: "fact",
      canonicalKey: "automatic-positional",
      text: "sem proveniência",
      trust: "verified_tool",
    }, automaticAuthority)).toThrow(/mutação automática/iu);

    expect(() => memory.upsertMemory({
      agentId: "agent-a",
      authority: { kind: "admin" },
      kind: "fact",
      canonicalKey: "unsupported",
      text: "campo extra",
      trust: "verified_tool",
      unsupported: true,
    } as never)).toThrow(/campo não suportado/iu);
    memory.close();
  });

  it("mantém cache de proveniência em escritas irrelevantes e o estende só com entradas acrescentadas", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const conversationId = chat(transcript, "agent-a");
    const internals = transcript.memoryStore as unknown as { forgottenSourceCache?: object };
    const db = transcript.databaseForSharedStores();
    transcript.append("agent-a", [{ kind: "message", id: "origin", role: "user", content: "fato", timestampMs: 1 }], conversationId);
    const forgotten = transcript.memoryStore.upsertMemory("agent-a", {
      kind: "fact",
      canonicalKey: "provenance-cache",
      text: "fato",
      trust: "verified_tool",
      sourceConversationId: conversationId,
      sourceEntryIds: [{ conversationId, entryId: "origin" }],
    }, { kind: "admin" });
    transcript.memoryStore.forgetMemory("agent-a", forgotten.id, { kind: "admin" });

    expect(transcript.memoryStore.getForgottenSourceIds("agent-a", conversationId).has("origin")).toBe(true);
    const cachedBefore = internals.forgottenSourceCache;
    expect(cachedBefore).toBeDefined();
    const markerBefore = db.prepare<[], { version: number }>("SELECT version FROM memory_provenance_state WHERE id = 1").get()!;

    transcript.memoryStore.setSettings("agent-a", "explicit");
    const markerAfterSettings = db.prepare<[], { version: number }>("SELECT version FROM memory_provenance_state WHERE id = 1").get()!;
    expect(markerAfterSettings.version).toBe(markerBefore.version);
    transcript.memoryStore.getForgottenSourceIds("agent-a", conversationId);
    expect(internals.forgottenSourceCache).toBe(cachedBefore);

    transcript.append("agent-a", [
      { kind: "message", id: "later", role: "user", content: "outra pergunta", timestampMs: 2 },
      { kind: "message", id: "cited", role: "assistant", content: "resposta", timestampMs: 3, memoryContextSources: [{ memoryId: forgotten.id }] },
    ], conversationId);
    const markerAfterEntry = db.prepare<[], { version: number }>("SELECT version FROM memory_provenance_state WHERE id = 1").get()!;
    expect(markerAfterEntry.version).toBeGreaterThan(markerAfterSettings.version);
    const incremental = [...transcript.memoryStore.getForgottenSourceIds("agent-a", conversationId)].sort();
    expect(internals.forgottenSourceCache).toBe(cachedBefore);
    expect(incremental).toEqual(["cited", "origin"]);

    internals.forgottenSourceCache = undefined;
    expect([...transcript.memoryStore.getForgottenSourceIds("agent-a", conversationId)].sort()).toEqual(incremental);

    const rebuilt = internals.forgottenSourceCache;
    const later = db.prepare<[string], { payload_json: string }>("SELECT payload_json FROM transcript_entries WHERE entry_id = ?").get("later")!;
    const rewritten = { ...JSON.parse(later.payload_json) as Record<string, unknown>, role: "assistant", memoryContextSources: [{ memoryId: forgotten.id }] };
    db.prepare("UPDATE transcript_entries SET payload_json = ? WHERE entry_id = ?").run(JSON.stringify(rewritten), "later");
    expect(transcript.memoryStore.getForgottenSourceIds("agent-a", conversationId).has("later")).toBe(true);
    expect(internals.forgottenSourceCache).not.toBe(rebuilt);
    transcript.close();
  });

  it("tolera proveniência ilegível sem falhar o turno e sem liberar conteúdo esquecido", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const conversationId = chat(transcript, "agent-a");
    const db = transcript.databaseForSharedStores();
    transcript.append("agent-a", [{ kind: "message", id: "origin", role: "user", content: "fato", timestampMs: 1 }], conversationId);
    const forgotten = transcript.memoryStore.upsertMemory("agent-a", {
      kind: "fact",
      canonicalKey: "unreadable-provenance",
      text: "fato",
      trust: "verified_tool",
      sourceConversationId: conversationId,
      sourceEntryIds: [{ conversationId, entryId: "origin" }],
    }, { kind: "admin" });
    transcript.memoryStore.forgetMemory("agent-a", forgotten.id, { kind: "admin" });
    transcript.append("agent-a", [
      { kind: "message", id: "later", role: "user", content: "outra pergunta", timestampMs: 2 },
      { kind: "message", id: "garbled", role: "assistant", content: "resposta", timestampMs: 3 },
    ], conversationId);
    const garbled = db.prepare<[string], { payload_json: string }>("SELECT payload_json FROM transcript_entries WHERE entry_id = ?").get("garbled")!;
    db.prepare("UPDATE transcript_entries SET payload_json = ? WHERE entry_id = ?")
      .run(JSON.stringify({ ...JSON.parse(garbled.payload_json) as Record<string, unknown>, memoryContextSources: "garbled" }), "garbled");
    db.prepare("UPDATE memory_revisions SET snapshot_json = '{' WHERE memory_id = ?").run(forgotten.id);

    const ids = transcript.memoryStore.getForgottenSourceIds("agent-a", conversationId);
    expect(ids.has("garbled")).toBe(true);
    expect(ids.has("later")).toBe(false);
    expect(transcript.memoryStore.hasForgottenContextSources("agent-a", [{ memoryId: forgotten.id }])).toBe(true);
    transcript.close();
  });

  it("invalida o cache quando outra conexão altera uma entrada de proveniência", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-memory-provenance-"));
    const path = join(dir, "store.sqlite");
    const transcript = new SqliteTranscriptStore({ path });
    const conversationId = chat(transcript, "agent-a");
    transcript.append("agent-a", [{ kind: "message", id: "external-entry", role: "user", content: "antes", timestampMs: 1 }], conversationId);
    const forgotten = transcript.memoryStore.upsertMemory("agent-a", {
      kind: "fact",
      canonicalKey: "external-provenance",
      text: "antes",
      trust: "verified_tool",
      sourceConversationId: conversationId,
      sourceEntryIds: [{ conversationId, entryId: "external-entry" }],
    }, { kind: "admin" });
    transcript.memoryStore.forgetMemory("agent-a", forgotten.id, { kind: "admin" });
    const internals = transcript.memoryStore as unknown as { forgottenSourceCache?: object };
    transcript.memoryStore.getForgottenSourceIds("agent-a", conversationId);
    const cachedBefore = internals.forgottenSourceCache;
    expect(cachedBefore).toBeDefined();

    const external = new Database(path);
    const row = external.prepare<[string], { payload_json: string }>("SELECT payload_json FROM transcript_entries WHERE entry_id = ?").get("external-entry")!;
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    payload.role = "assistant";
    external.prepare("UPDATE transcript_entries SET payload_json = ? WHERE entry_id = ?").run(JSON.stringify(payload), "external-entry");
    external.close();

    transcript.memoryStore.getForgottenSourceIds("agent-a", conversationId);
    expect(internals.forgottenSourceCache).not.toBe(cachedBefore);
    transcript.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("não cria revisão para upsert semanticamente idêntico", () => {
    let now = 100;
    const memory = new SqliteMemoryStore({ path: ":memory:", now: () => now });
    const first = memory.upsertMemory("agent-a", {
      kind: "fact",
      canonicalKey: "stable-upsert",
      text: "valor estável",
      trust: "verified_tool",
      importance: 40,
      confidence: 0.8,
      pinned: true,
      sourceEntryIds: [],
      validFromMs: 100,
      validToMs: 400,
      expiresAtMs: 500,
    }, { kind: "admin" });
    const revisionsBefore = memory.snapshotAgent("agent-a").revisions.filter((revision) => revision.memoryId === first.id);

    now = 200;
    const same = memory.upsertMemory("agent-a", {
      id: first.id,
      kind: first.kind,
      canonicalKey: first.canonicalKey,
      text: first.text,
      trust: first.trust,
      importance: first.importance,
      confidence: first.confidence,
      pinned: first.pinned,
      sourceEntryIds: first.sourceEntryIds,
      validFromMs: first.validFromMs,
      validToMs: first.validToMs,
      expiresAtMs: first.expiresAtMs,
    }, { kind: "admin" });
    expect(same).toEqual(first);
    expect(memory.snapshotAgent("agent-a").revisions.filter((revision) => revision.memoryId === first.id)).toHaveLength(revisionsBefore.length);

    const changed = memory.upsertMemory("agent-a", {
      id: first.id,
      kind: first.kind,
      canonicalKey: first.canonicalKey,
      text: "valor alterado",
      trust: first.trust,
      importance: first.importance,
      confidence: first.confidence,
      pinned: first.pinned,
      sourceEntryIds: first.sourceEntryIds,
      validFromMs: first.validFromMs,
      validToMs: first.validToMs,
      expiresAtMs: first.expiresAtMs,
    }, { kind: "admin" });
    expect(changed.revision).toBe(first.revision + 1);
    expect(memory.snapshotAgent("agent-a").revisions.filter((revision) => revision.memoryId === first.id)).toHaveLength(revisionsBefore.length + 1);
    memory.close();
  });

  it("records revisions for updates and expiration", () => {
    let now = 100;
    const memory = new SqliteMemoryStore({ path: ":memory:", now: () => now });
    const created = memory.upsertMemory("agent-a", {
      kind: "fact", canonicalKey: "revision", text: "primeira", trust: "verified_tool", expiresAtMs: 200,
    }, { kind: "admin" });
    now = 150;
    memory.upsertMemory("agent-a", {
      id: created.id,
      kind: created.kind,
      canonicalKey: created.canonicalKey,
      text: "segunda",
      trust: created.trust,
      expiresAtMs: created.expiresAtMs,
      nowMs: now,
    }, { kind: "admin" });
    now = 200;
    expect(memory.listMemories("agent-a")).toEqual([]);
    const revisions = memory.snapshotAgent("agent-a").revisions.filter((revision) => revision.memoryId === created.id);
    expect(revisions.map((revision) => revision.revision)).toEqual([1, 2, 3]);
    expect(memory.getMemory("agent-a", created.id)?.status).toBe("expired");
    memory.close();
  });

  it("isolates FTS by agent and excludes temporary conversations", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const permanent = chat(transcript, "agent-a");
    const temporary = chat(transcript, "agent-a", true);
    transcript.append("agent-a", [{ kind: "message", id: "p", role: "user", content: "cidade azul", timestampMs: 1 }], permanent);
    transcript.append("agent-a", [{ kind: "message", id: "t", role: "user", content: "segredo temporário azul", timestampMs: 2 }], temporary);
    transcript.append("agent-b", [{ kind: "message", id: "b", role: "user", content: "cidade azul", timestampMs: 3 }]);
    transcript.memoryStore.upsertSummary("agent-a", { conversationId: permanent, throughSequenceId: 1, summaryJson: {}, renderedText: "resumo azul" });
    const agentAResults = transcript.memoryStore.searchHistory("agent-a", "azul");
    const agentBResults = transcript.memoryStore.searchHistory("agent-b", "azul");
    expect(agentAResults).toHaveLength(2);
    expect(agentAResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "message", agentId: "agent-a", conversationId: permanent }),
      expect.objectContaining({ kind: "summary", agentId: "agent-a", conversationId: permanent }),
    ]));
    expect(agentAResults.every((result) => result.conversationId !== temporary)).toBe(true);
    expect(agentBResults).toEqual([
      expect.objectContaining({ kind: "message", agentId: "agent-b" }),
    ]);
    expect(() => transcript.memoryStore.upsertMemory("agent-a", { kind: "fact", canonicalKey: "temp", text: "não", trust: "verified_tool", sourceConversationId: temporary }, { kind: "admin" })).toThrow(/temporária/);
    transcript.close();
  });

  it("recalls history from a natural-language query without requiring every prompt word", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const conversationId = chat(transcript, "agent-a");
    transcript.append("agent-a", [{
      kind: "message",
      id: "budget",
      role: "user",
      content: "O orçamento do projeto Aurora é 100 reais.",
      timestampMs: 1,
    }], conversationId);

    expect(transcript.memoryStore.searchHistory(
      "agent-a",
      "Qual era o orçamento do projeto Aurora?",
      { includeMemories: false },
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "message", conversationId }),
    ]));
    transcript.close();
  });

  it("keeps a blank memory search scoped to the requested conversation", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const firstConversation = chat(transcript, "agent-a");
    const secondConversation = chat(transcript, "agent-a");
    transcript.memoryStore.upsertMemory("agent-a", {
      kind: "fact",
      canonicalKey: "first-scoped-memory",
      text: "primeira memória",
      trust: "verified_tool",
      sourceConversationId: firstConversation,
    }, { kind: "admin" });
    transcript.memoryStore.upsertMemory("agent-a", {
      kind: "fact",
      canonicalKey: "second-scoped-memory",
      text: "segunda memória",
      trust: "verified_tool",
      sourceConversationId: secondConversation,
    }, { kind: "admin" });

    expect(transcript.memoryStore.searchMemories("agent-a", "   ", {
      conversationId: firstConversation,
      limit: 20,
    }).map((result) => result.memory.canonicalKey)).toEqual(["first-scoped-memory"]);
    transcript.close();
  });

  it("filters legacy and structured source references without reparsing plain text", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const conversationId = chat(transcript, "agent-a");
    const otherConversationId = chat(transcript, "agent-a");
    const insert = (canonicalKey: string, sourceEntryIds: readonly (string | { conversationId: string; entryId: string })[]) => {
      transcript.memoryStore.upsertMemory("agent-a", {
        kind: "fact",
        canonicalKey,
        text: `evidence ${canonicalKey}`,
        trust: "verified_tool",
        sourceEntryIds,
      }, { kind: "admin" });
    };

    insert("legacy", [`${conversationId}:legacy-entry`]);
    insert("plain", ["legacy-entry"]);
    insert("structured", [{ conversationId, entryId: "structured-entry" }]);
    insert("mixed", [`${conversationId}:mixed-entry`, { conversationId, entryId: "mixed-object" }]);
    insert("other", [{ conversationId: otherConversationId, entryId: "other-entry" }]);
    insert("empty", []);

    const expected = new Set(["legacy", "structured", "mixed"]);
    expect(new Set(transcript.memoryStore.listMemories("agent-a", { conversationId }).map((memory) => memory.canonicalKey))).toEqual(expected);
    expect(new Set(transcript.memoryStore.listMemoriesPage("agent-a", { conversationId }).items.map((memory) => memory.canonicalKey))).toEqual(expected);
    expect(new Set(transcript.memoryStore.searchMemories("agent-a", "evidence", { conversationId }).map((result) => result.memory.canonicalKey))).toEqual(expected);
    transcript.close();
  });

  it("pages every memory with a stable agent-bound cursor", () => {
    const memory = new SqliteMemoryStore({ path: ":memory:", now: () => 100 });
    for (let index = 0; index < 7; index += 1) {
      memory.upsertMemory("agent-a", {
        kind: "fact",
        canonicalKey: `page-${index}`,
        text: `memória paginada ${index}`,
        trust: "verified_tool",
        pinned: index % 3 === 0,
        importance: index % 2 === 0 ? 75 : 25,
      }, { kind: "admin" });
    }
    memory.upsertMemory("agent-b", {
      kind: "fact",
      canonicalKey: "other-agent",
      text: "não deve aparecer",
      trust: "verified_tool",
    }, { kind: "admin" });

    const expected = memory.listMemories("agent-a", { limit: 100 }).map((item) => item.id);
    const actual: string[] = [];
    let cursor: string | undefined;
    do {
      const page = memory.listMemoriesPage("agent-a", { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      actual.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
    const firstPage = memory.listMemoriesPage("agent-a", { limit: 2 });
    expect(() => memory.listMemoriesPage("agent-b", { limit: 2, cursor: firstPage.nextCursor })).toThrow(/cursor.*agente/iu);
    expect(memory.listMemoriesPage("agent-a", { limit: 2, query: "paginada 6" }).items.map((item) => item.canonicalKey))
      .toEqual(["page-6"]);
    memory.close();
  });

  it("accepts durable observed kinds while rejecting secrets", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const conversationId = chat(transcript, "agent-a");
    const result = applyReflectionResult(transcript.memoryStore, {
      agentId: "agent-a",
      conversationId,
      provider: "xai",
      model: "grok-4.6",
      fromSequenceId: 0,
      throughSequenceId: 1,
      entries: [
        { kind: "message", id: "e1", role: "user", content: "contexto" },
        { kind: "tool-call", id: "t1", name: "file", summary: "read", status: "completed" },
      ],
    }, { operations: [
      { op: "upsert", memory: { kind: "identity", canonicalKey: "role", text: "sou dev", trust: "verified_tool", sourceEntryIds: ["e1"] } },
      { op: "upsert", memory: { kind: "fact", canonicalKey: "key", text: "apiKey=sk-123456789012345", trust: "verified_tool", sourceEntryIds: ["e1"] } },
      { op: "upsert", memory: { kind: "fact", canonicalKey: "safe", text: "resultado verificado", trust: "verified_tool", sourceEntryIds: ["t1"] } },
    ] });
    expect(result.memories).toHaveLength(2);
    expect(result.rejected.map((item) => item.code)).toEqual(["secret"]);
    expect(transcript.memoryStore.listMemories("agent-a")).toEqual(expect.arrayContaining([
      // The model cannot self-assert verification: a user message is an observation.
      expect.objectContaining({ kind: "identity", canonicalKey: "role", text: "sou dev", trust: "external_observation" }),
      // A completed tool result backs "verified_tool".
      expect.objectContaining({ canonicalKey: "safe", text: "resultado verificado", trust: "verified_tool" }),
    ]));
    expect(JSON.stringify(transcript.memoryStore.snapshotAgent("agent-a"))).not.toContain("sk-123456789012345");
    transcript.close();
  });

  it("rejects only the candidate the store refuses and keeps the rest of the reflection", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:", secretValues: () => ["opaque-known-credential-5c3a1f"] });
    try {
      const conversationId = chat(transcript, "agent-a");
      const result = applyReflectionResult(transcript.memoryStore, {
        agentId: "agent-a",
        conversationId,
        provider: "xai",
        model: "grok-4.6",
        fromSequenceId: 0,
        throughSequenceId: 1,
        entries: [{ kind: "message", id: "e1", role: "user", content: "contexto" }],
      }, { operations: [
        { op: "upsert", memory: { kind: "fact", canonicalKey: "opaque", text: "valor opaque-known-credential-5c3a1f", trust: "verified_tool", sourceEntryIds: ["e1"] } },
        { op: "upsert", memory: { kind: "fact", canonicalKey: "fine", text: "fato comum", trust: "verified_tool", sourceEntryIds: ["e1"] } },
      ] });
      expect(result.rejected).toEqual([expect.objectContaining({ index: 0, code: "policy" })]);
      expect(transcript.memoryStore.listMemories("agent-a").map((memory) => memory.canonicalKey)).toEqual(["fine"]);
    } finally {
      transcript.close();
    }
  });

  it("limits explicit-mode memories to the messages that asked to remember", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      const conversationId = chat(transcript, "agent-a");
      const result = applyReflectionResult(transcript.memoryStore, {
        agentId: "agent-a",
        conversationId,
        provider: "xai",
        model: "grok-4.6",
        fromSequenceId: 0,
        throughSequenceId: 2,
        entries: [
          { kind: "message", id: "ask", role: "user", content: "lembre que eu gosto de chá verde", fromUser: { name: "Usuário", authId: "local" } },
          { kind: "message", id: "chat", role: "user", content: "meu carro é azul", fromUser: { name: "Usuário", authId: "local" } },
        ],
      }, { operations: [
        { op: "upsert", memory: { kind: "preference", canonicalKey: "tea", text: "gosta de chá verde", trust: "external_observation", sourceEntryIds: ["ask"] } },
        { op: "upsert", memory: { kind: "fact", canonicalKey: "car", text: "carro azul", trust: "external_observation", sourceEntryIds: ["chat"] } },
      ] }, { explicitEvidenceOnly: true });
      expect(result.rejected).toEqual([expect.objectContaining({ index: 1, code: "explicit_scope" })]);
      expect(transcript.memoryStore.listMemories("agent-a").map((memory) => memory.canonicalKey)).toEqual(["tea"]);
    } finally {
      transcript.close();
    }
  });
});

describe("memory lifecycle and privacy", () => {
  const ref = (conversationId: string, entryId: string) => ({ conversationId, entryId });
  const revisionTexts = (transcript: SqliteTranscriptStore, memoryId: string): string[] => (
    transcript.databaseForSharedStores()
      .prepare("SELECT snapshot_json FROM memory_revisions WHERE memory_id = ?")
      .all(memoryId) as Array<{ snapshot_json: string }>
  ).map((row) => row.snapshot_json);

  it("returns a released job to pending without spending an attempt", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      const conversationId = chat(transcript, "agent-a");
      const job = transcript.memoryStore.enqueueJob({ agentId: "agent-a", conversationId, fromSequenceId: 0, throughSequenceId: 1 });
      const claimed = transcript.memoryStore.claimJob("agent-a", job.id)!;
      expect(claimed.status).toBe("running");
      const released = transcript.memoryStore.releaseJob("agent-a", job.id)!;
      expect(released.status).toBe("pending");
      expect(released.attempts).toBe(claimed.attempts - 1);
    } finally {
      transcript.close();
    }
  });

  it("keeps attempts and backoff when a newer turn widens a retrying job, and moves it to the current provider", () => {
    let now = 1_000;
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const store = new SqliteMemoryStore({ path: ":memory:", database: transcript.databaseForSharedStores(), now: () => now });
    try {
      const conversationId = chat(transcript, "agent-a");
      const job = store.enqueueJob({ agentId: "agent-a", conversationId, provider: "xai", model: "grok-old", fromSequenceId: 0, throughSequenceId: 1 });
      store.claimJob("agent-a", job.id);
      const retried = store.retryJob("agent-a", job.id, { code: "timeout" })!;
      expect(retried.status).toBe("retry");
      now += 10;
      const same = store.enqueueJob({ agentId: "agent-a", conversationId, provider: "openai", model: "gpt-new", fromSequenceId: 0, throughSequenceId: 1 });
      expect(same).toMatchObject({ id: job.id, provider: "xai", model: "grok-old" });
      const widened = store.enqueueJob({ agentId: "agent-a", conversationId, provider: "openai", model: "gpt-new", fromSequenceId: 0, throughSequenceId: 4 });
      expect(widened).toMatchObject({
        id: job.id,
        status: "retry",
        attempts: retried.attempts,
        nextAttemptAtMs: retried.nextAttemptAtMs,
        provider: "openai",
        model: "gpt-new",
        throughSequenceId: 4,
      });
    } finally {
      store.close();
      transcript.close();
    }
  });

  it("leaves archived conversations out of cross-chat history search", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      const live = chat(transcript, "agent-a");
      const archived = chat(transcript, "agent-a");
      transcript.append("agent-a", [{ kind: "message", id: "live", role: "user", content: "cidade laranja viva", timestampMs: 1 }], live);
      transcript.append("agent-a", [{ kind: "message", id: "old", role: "user", content: "cidade laranja arquivada", timestampMs: 2 }], archived);
      transcript.conversationStore.activate("agent-a", live);
      transcript.conversationStore.archive("agent-a", archived);
      const crossChat = transcript.memoryStore.searchHistory("agent-a", "laranja", { includeMemories: false });
      expect(crossChat.map((result) => result.conversationId)).toEqual([live]);
      const scoped = transcript.memoryStore.searchHistory("agent-a", "laranja", { includeMemories: false, conversationId: archived });
      expect(scoped.map((result) => result.conversationId)).toEqual([archived]);
    } finally {
      transcript.close();
    }
  });

  it("accepts a user edit of a retained memory whose source conversation was deleted", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      const keep = chat(transcript, "agent-a");
      const gone = chat(transcript, "agent-a");
      const memory = transcript.memoryStore.upsertMemory("agent-a", {
        kind: "fact",
        canonicalKey: "retained-fact",
        text: "fato retido",
        trust: "verified_tool",
        sourceConversationId: gone,
        sourceEntryIds: [ref(gone, "entry-1")],
      }, { kind: "admin" });
      transcript.conversationStore.activate("agent-a", keep);
      transcript.conversationStore.delete("agent-a", gone, { memoryPolicy: "retain" });
      const retained = transcript.memoryStore.getMemory("agent-a", memory.id)!;
      const edited = transcript.memoryStore.upsertMemory("agent-a", {
        id: retained.id,
        kind: retained.kind,
        canonicalKey: retained.canonicalKey,
        text: "fato retido editado",
        trust: "user",
        sourceConversationId: retained.sourceConversationId,
        sourceEntryIds: retained.sourceEntryIds,
      }, { kind: "user", expectedRevision: retained.revision });
      expect(edited.text).toBe("fato retido editado");
      expect(() => transcript.memoryStore.upsertMemory("agent-a", {
        kind: "fact",
        canonicalKey: "new-from-deleted",
        text: "novo fato",
        trust: "user",
        sourceConversationId: gone,
      }, { kind: "user" })).toThrow(/conversation/);
    } finally {
      transcript.close();
    }
  });

  it("purges the text of memories derived from a deleted conversation but keeps their forget in force", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      const keep = chat(transcript, "agent-a");
      const gone = chat(transcript, "agent-a");
      const onlyGone = transcript.memoryStore.upsertMemory("agent-a", {
        kind: "fact", canonicalKey: "only-gone", text: "texto privado apagado", trust: "verified_tool",
        sourceConversationId: gone, sourceEntryIds: [ref(gone, "g1")],
      }, { kind: "admin" });
      const shared = transcript.memoryStore.upsertMemory("agent-a", {
        kind: "fact", canonicalKey: "shared", text: "versão antiga privada", trust: "verified_tool",
        sourceConversationId: keep, sourceEntryIds: [ref(keep, "k1")],
      }, { kind: "admin" });
      const sharedNow = transcript.memoryStore.upsertMemory("agent-a", {
        id: shared.id, kind: "fact", canonicalKey: "shared", text: "versão atual", trust: "verified_tool",
        sourceConversationId: keep, sourceEntryIds: [ref(keep, "k1"), ref(gone, "g2")],
      }, { kind: "admin", expectedRevision: shared.revision });
      transcript.conversationStore.activate("agent-a", keep);
      transcript.conversationStore.delete("agent-a", gone, { memoryPolicy: "delete-derived" });

      const forgotten = transcript.memoryStore.getMemory("agent-a", onlyGone.id)!;
      expect(forgotten.status).toBe("forgotten");
      expect(forgotten.text).not.toContain("privado");
      expect(revisionTexts(transcript, onlyGone.id).join("\n")).not.toContain("privado");

      const survivor = transcript.memoryStore.getMemory("agent-a", sharedNow.id)!;
      expect(survivor).toMatchObject({ status: "active", text: "versão atual", sourceConversationId: keep });
      expect(survivor.sourceEntryIds).toEqual([ref(keep, "k1")]);
      expect(revisionTexts(transcript, sharedNow.id).join("\n")).not.toContain("antiga privada");
    } finally {
      transcript.close();
    }
  });

  it("prunes old history without lifting a forget and purges old tombstone text", () => {
    let now = 1_000;
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const store = new SqliteMemoryStore({ path: ":memory:", database: transcript.databaseForSharedStores(), now: () => now });
    try {
      const conversationId = chat(transcript, "agent-a");
      const kept = store.upsertMemory("agent-a", {
        kind: "fact", canonicalKey: "kept", text: "primeira", trust: "verified_tool",
        sourceConversationId: conversationId, sourceEntryIds: [ref(conversationId, "e1")],
      }, { kind: "admin" });
      now += 10;
      store.upsertMemory("agent-a", {
        id: kept.id, kind: "fact", canonicalKey: "kept", text: "segunda", trust: "verified_tool",
        sourceConversationId: conversationId, sourceEntryIds: [ref(conversationId, "e1")],
      }, { kind: "admin", expectedRevision: kept.revision });
      const doomed = store.upsertMemory("agent-a", {
        kind: "fact", canonicalKey: "doomed", text: "esquecido privado", trust: "verified_tool",
        sourceConversationId: conversationId, sourceEntryIds: [ref(conversationId, "e2")],
      }, { kind: "admin" });
      store.forgetMemory("agent-a", doomed.id, { kind: "user" }, "user-delete");
      const forgottenRevisions = revisionTexts(transcript, doomed.id).length;
      now += 10;

      expect(store.pruneHistory(now)).toBeGreaterThan(0);

      expect(revisionTexts(transcript, kept.id)).toHaveLength(1);
      expect(revisionTexts(transcript, doomed.id)).toHaveLength(forgottenRevisions);
      expect(store.getMemory("agent-a", doomed.id)?.text).not.toContain("privado");
      expect(revisionTexts(transcript, doomed.id).join("\n")).not.toContain("privado");
      expect(() => store.upsertMemory("agent-a", {
        kind: "fact", canonicalKey: "recreated", text: "recriado", trust: "verified_tool",
        sourceConversationId: conversationId, sourceEntryIds: [ref(conversationId, "e2")],
      }, { kind: "automatic", conversationId, evidenceIds: ["e2"] })).toThrow(/esquecida/);
    } finally {
      store.close();
      transcript.close();
    }
  });

  it("forgets and purges shared-profile memories sourced only from a deleted bot's conversations", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      const conversationId = chat(transcript, "agent-a");
      const profile = transcript.memoryStore.upsertMemory(USER_PROFILE_AGENT_ID, {
        kind: "preference", canonicalKey: "profile-from-a", text: "prefere respostas privadas", trust: "verified_tool",
        sourceConversationId: conversationId, sourceEntryIds: [ref(conversationId, "p1")],
      }, { kind: "admin" });
      const unrelated = transcript.memoryStore.upsertMemory(USER_PROFILE_AGENT_ID, {
        kind: "preference", canonicalKey: "profile-manual", text: "idioma português", trust: "user",
        sourceConversationId: null,
      }, { kind: "admin" });
      transcript.clear("agent-a");
      const scrubbed = transcript.memoryStore.getMemory(USER_PROFILE_AGENT_ID, profile.id)!;
      expect(scrubbed.status).toBe("forgotten");
      expect(scrubbed.text).not.toContain("privadas");
      expect(transcript.memoryStore.getMemory(USER_PROFILE_AGENT_ID, unrelated.id)).toMatchObject({ status: "active", text: "idioma português" });
    } finally {
      transcript.close();
    }
  });
});
