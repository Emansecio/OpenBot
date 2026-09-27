import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteTranscriptStore } from "../src/store/index.js";
import { normalizeTranscriptEntry, type TranscriptEntry } from "../src/shared/contracts.js";
import { TempRoots } from "./helpers/temp-roots.js";

const stores: SqliteTranscriptStore[] = [];
const temp = new TempRoots();

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await temp.cleanup();
});

function open(path?: string): SqliteTranscriptStore {
  const store = new SqliteTranscriptStore({ path: path ?? join(temp.make("openbot-store-robust-"), "store.db") });
  stores.push(store);
  return store;
}

function message(id: string, content: string, timestampMs: number, extra: Record<string, unknown> = {}): TranscriptEntry {
  return normalizeTranscriptEntry({ kind: "message", id, role: "user", content, timestampMs, streaming: false, ...extra });
}

describe("transcript reads survive an unreadable row", () => {
  it("keeps the conversation readable and replaces the bad row with a stable notice", () => {
    const store = open();
    const conversationId = store.conversationStore.ensureDefault("agent-a").id;
    store.append("agent-a", [message("m1", "um", 1), message("m2", "dois", 2), message("m3", "três", 3)], conversationId);
    const db = store.databaseForSharedStores();
    const broken = db.prepare("SELECT sequence_id FROM transcript_entries WHERE entry_id = 'm2'").get() as { sequence_id: number };
    // Valid JSON the reader rejects (SQLite triggers already refuse malformed JSON).
    db.prepare("UPDATE transcript_entries SET payload_json = ? WHERE sequence_id = ?")
      .run(JSON.stringify({ kind: "message", id: "m2", role: "user", content: "dois", timestampMs: "ontem" }), broken.sequence_id);

    const expectedNotice = { kind: "notice", id: `notice:unreadable:${broken.sequence_id}`, type: "unreadable-entry" };
    expect(store.getEntries("agent-a", conversationId)).toMatchObject([{ id: "m1" }, expectedNotice, { id: "m3" }]);
    expect(store.getAgentTranscriptTail("agent-a", 50, undefined, conversationId).entries).toMatchObject([{ id: "m1" }, expectedNotice, { id: "m3" }]);
    expect(store.getRecentEntries("agent-a", { limit: 10 }, conversationId)).toHaveLength(3);
    // Deletion snapshots start by reading the whole agent.
    expect(store.snapshotAgent("agent-a").transcriptRows).toHaveLength(3);
  });

  it("rejects at write time an entry the reader could not load back", () => {
    const store = open();
    const conversationId = store.conversationStore.ensureDefault("agent-a").id;
    const toolCall = normalizeTranscriptEntry({
      kind: "tool-call", id: "call-1", name: "file.read", summary: "leitura", status: "completed",
      result: { ok: true, bytes: Number.NaN },
    });
    expect(() => store.append("agent-a", [toolCall], conversationId)).toThrow(/transcript entry inválida \(tool-call\)/);
    expect(store.getEntries("agent-a", conversationId)).toEqual([]);

    store.append("agent-a", [message("m1", "ok", 1)], conversationId);
    expect(() => store.replace("agent-a", "m1", { ...message("m1", "ok", 1), timestampMs: "agora" } as unknown as TranscriptEntry, conversationId))
      .toThrow(/transcript entry inválida/);
    expect(store.getEntries("agent-a", conversationId)).toMatchObject([{ id: "m1", timestampMs: 1 }]);
  });
});

describe("prompt queue survives an unreadable row", () => {
  it("drops an undecodable queued prompt from recovery instead of failing every start", () => {
    const path = join(temp.make("openbot-queue-robust-"), "store.db");
    const first = open(path);
    const conversationId = first.conversationStore.ensureDefault("a").id;
    for (const nonce of ["broken", "good"]) {
      first.promptQueue.put({ agentId: "a", conversationId, prompt: `prompt ${nonce}`, clientNonce: nonce }, { provider: "xai", model: "grok-4.6" });
    }
    first.databaseForSharedStores().prepare("UPDATE prompt_queue SET args_json = '{\"prompt\":' WHERE nonce = 'broken'").run();
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const second = open(path);
    expect(second.promptQueue.list("a").map((row) => row.args.clientNonce)).toEqual(["good"]);
    const state = second.databaseForSharedStores().prepare("SELECT state FROM prompt_queue WHERE nonce = 'broken'").get();
    expect(state).toEqual({ state: "cancelled" });
    expect(second.promptQueue.list("a").map((row) => row.args.clientNonce)).toEqual(["good"]);
    expect(second.promptQueue.transition("a", conversationId, "good", "queued", "running")).toBe(true);
  });
});

describe("live tail pagination", () => {
  it("points the cursor at the oldest row still shown when live previews trim the page", () => {
    const store = open();
    const conversationId = store.conversationStore.ensureDefault("agent-a").id;
    store.append("agent-a", Array.from({ length: 5 }, (_, index) => message(`m${index + 1}`, `m${index + 1}`, index + 1)), conversationId);
    store.setLiveEntry("agent-a", message("live-1", "parcial", 10, { streaming: true }), conversationId);
    store.setLiveEntry("agent-a", message("live-2", "parcial", 11, { streaming: true }), conversationId);

    const first = store.openAgentTail("agent-a", 5, undefined, conversationId);
    expect(first.entries.map((entry) => (entry as { id: string }).id)).toEqual(["m3", "m4", "m5", "live-1", "live-2"]);
    expect(first.nextBeforeSeq).toBeDefined();

    const older = store.openAgentTail("agent-a", 5, first.nextBeforeSeq, conversationId);
    expect(older.entries.map((entry) => (entry as { id: string }).id)).toEqual(["m1", "m2"]);
    expect(older.nextBeforeSeq).toBeUndefined();
  });

  it("returns every durable row across pages when there is nothing live", () => {
    const store = open();
    const conversationId = store.conversationStore.ensureDefault("agent-a").id;
    store.append("agent-a", Array.from({ length: 3 }, (_, index) => message(`m${index + 1}`, `m${index + 1}`, index + 1)), conversationId);
    const page = store.openAgentTail("agent-a", 3, undefined, conversationId);
    expect(page.entries).toHaveLength(3);
    expect(page.nextBeforeSeq).toBeUndefined();
  });
});

describe("interaction decisions", () => {
  it("returns the stored decision when the same request is answered from another conversation", () => {
    const store = open();
    const first = store.conversationStore.ensureDefault("agent-a").id;
    const second = store.conversationStore.create("agent-a").id;
    expect(store.rememberInteractionDecision("agent-a", "request-1", "tool", "allow", first)).toMatchObject({ decision: "allow" });
    expect(store.rememberInteractionDecision("agent-a", "request-1", "tool", "deny", second)).toMatchObject({ decision: "allow" });
  });
});

describe("history search indexing", () => {
  it("indexes a streamed answer once it completes, even when the text did not change", () => {
    const store = open();
    const conversationId = store.conversationStore.ensureDefault("agent-a").id;
    const db = store.databaseForSharedStores();
    const indexed = () => db.prepare("SELECT content FROM history_fts WHERE agent_id = 'agent-a'").all();

    store.append("agent-a", [message("answer", "texto parcial", 1, { streaming: true, isStreaming: true })], conversationId);
    expect(indexed()).toEqual([]);
    store.replace("agent-a", "answer", message("answer", "texto completo", 1, { streaming: true, isStreaming: true }), conversationId);
    expect(indexed()).toEqual([]);
    store.replace("agent-a", "answer", message("answer", "texto completo", 1, { streaming: false, isStreaming: false }), conversationId);
    expect(indexed()).toEqual([{ content: "texto completo" }]);
  });

  it("reads open tool calls and in-flight rows through the partial indexes", () => {
    const store = open();
    const db = store.databaseForSharedStores();
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
    expect(plan(`SELECT sequence_id FROM transcript_entries WHERE agent_id = 'a' AND conversation_id = 'c'
      AND kind = 'tool-call' AND json_extract(payload_json, '$.status') IN ('pending', 'running') ORDER BY sequence_id`))
      .toContain("idx_transcript_open_tool_calls");
    // The boot probe for rows without a conversation must not scan the transcript.
    expect(plan("SELECT 1 FROM transcript_entries WHERE conversation_id IS NULL OR conversation_id = '' LIMIT 1"))
      .toContain("idx_transcript_missing_conversation");
    const conversationId = store.conversationStore.ensureDefault("agent-a").id;
    store.append("agent-a", [normalizeTranscriptEntry({ kind: "tool-call", id: "call-1", name: "file.read", summary: "x", status: "running" })], conversationId);
    expect(store.getOpenToolCalls("agent-a", conversationId)).toMatchObject([{ id: "call-1" }]);
  });
});
