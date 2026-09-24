/**
 * P2.3 — reply contract, transcript FTS search and incremental history RED.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProviderRegistry } from "../src/providers/router.js";
import { createFakeAdapter } from "./mocks/fake-provider-adapter.js";
import { createTurnRunner } from "../src/rpc/send.js";
import { SqliteTranscriptStore } from "../src/store/index.js";

const roots: string[] = [];
const stores: SqliteTranscriptStore[] = [];

afterEach(() => {
  for (const db of stores.splice(0)) { try { db.close(); } catch { /* ignore */ } }
  for (const root of roots.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { /* locked by WAL on Windows; retry */ }
    }
  }
});

function tmpStore(): { db: SqliteTranscriptStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "openbot-p23-rsh-"));
  roots.push(root);
  const db = new SqliteTranscriptStore({ path: join(root, "store.db") });
  stores.push(db);
  return { db, root };
}

function runnerSetup(db: SqliteTranscriptStore) {
  const registry = createProviderRegistry();
  registry.register(createFakeAdapter("xai", { deltas: ["ok"] }));
  const events: { channel: string; payload: unknown }[] = [];
  const publish = (channel: string, payload: unknown) => { events.push({ channel, payload }); };
  let n = 0;
  const newId = (role: string) => "id-" + role + "-" + (++n);
  const runner = createTurnRunner({ registry, store: db, publish, newId: newId });
  return { runner, events };
}

describe("P2.3 reply contract", () => {
  it("shape validation rejects malformed replyContext synchronously", async () => {
    const { db } = tmpStore();
    const { runner } = runnerSetup(db);
    expect(() => runner.sendPrompt({ agentId: "a", prompt: "p", replyContext: { replyToId: "" } as never })).toThrow(/replyToId/);
    expect(() => runner.sendPrompt({ agentId: "a", prompt: "p", replyContext: { replyToId: "x" } as never })).toThrow(/conversationId/);
    db.close();
  });

  it("resolves the durable entry server-side and attaches replyTo metadata", async () => {
    const { db } = tmpStore();
    const convA = db.conversationStore.ensureDefault("a").id;
    db.append("a", [{ kind: "message", id: "target-1", role: "user", content: "texto original", timestampMs: 1 }], convA);
    const { runner } = runnerSetup(db);
    runner.sendPrompt({ agentId: "a", prompt: "responder", conversationId: convA, clientNonce: randomUUID(), replyContext: { replyToId: "target-1", conversationId: convA } });
    await runner.flush("a");
    const replyEntry = db.getEntries("a", convA).find((entry) => entry.kind === "message" && entry.role === "user" && entry.id.startsWith("id-user"));
    expect((replyEntry as any)?.replyTo).toMatchObject({ replyToId: "target-1", quotedText: "texto original" });
    db.close();
  });

  it("rejects a missing reply target with an error notice", async () => {
    const { db } = tmpStore();
    const convA = db.conversationStore.ensureDefault("a").id;
    const { runner } = runnerSetup(db);
    runner.sendPrompt({ agentId: "a", prompt: "p", conversationId: convA, clientNonce: randomUUID(), replyContext: { replyToId: "does-not-exist", conversationId: convA } });
    await runner.flush("a");
    const notices = db.getEntries("a", convA).filter((entry) => entry.kind === "notice");
    expect(notices.some((notice) => (notice as any).text.includes("reply_alvo_inexistente"))).toBe(true);
    db.close();
  });

  it("rejects a reply that references a foreign conversation", async () => {
    const { db } = tmpStore();
    const convA = db.conversationStore.ensureDefault("a").id;
    const convB = db.conversationStore.create("a", { title: "other" }).id;
    db.conversationStore.activate("a", convA);
    const { runner } = runnerSetup(db);
    runner.sendPrompt({ agentId: "a", prompt: "p", conversationId: convA, clientNonce: randomUUID(), replyContext: { replyToId: "any", conversationId: convB } });
    await runner.flush("a");
    const notices = db.getEntries("a", convA).filter((entry) => entry.kind === "notice");
    expect(notices.some((notice) => (notice as any).text.includes("reply_conversa_estrangeira"))).toBe(true);
    db.close();
  });

  it("rejects a reply targeting a temporary conversation", async () => {
    const { db } = tmpStore();
    const temp = db.conversationStore.create("a", { title: "temp", temporary: true }).id;
    db.conversationStore.activate("a", temp);
    db.append("a", [{ kind: "message", id: "target-3", role: "user", content: "temp", timestampMs: 1 }], temp);
    const { runner } = runnerSetup(db);
    runner.sendPrompt({ agentId: "a", prompt: "p", conversationId: temp, clientNonce: randomUUID(), replyContext: { replyToId: "target-3", conversationId: temp } });
    await runner.flush("a");
    const notices = db.getEntries("a", temp).filter((entry) => entry.kind === "notice");
    expect(notices.some((notice) => (notice as any).text.includes("reply_conversa_temporaria"))).toBe(true);
    db.close();
  });

  it("treats another agent's entry as missing (no existence leak)", async () => {
    const { db } = tmpStore();
    db.append("agent-b", [{ kind: "message", id: "b-target", role: "user", content: "b", timestampMs: 1 }]);
    const convA = db.conversationStore.ensureDefault("agent-a").id;
    const { runner } = runnerSetup(db);
    runner.sendPrompt({ agentId: "agent-a", prompt: "p", conversationId: convA, clientNonce: randomUUID(), replyContext: { replyToId: "b-target", conversationId: convA } });
    await runner.flush("agent-a");
    const notices = db.getEntries("agent-a", convA).filter((entry) => entry.kind === "notice");
    expect(notices.some((notice) => (notice as any).text.includes("reply_alvo_inexistente"))).toBe(true);
    db.close();
  });
});

describe("P2.3 searchTranscript (FTS, scoped, cursor, snippets)", () => {
  function seed(db: SqliteTranscriptStore) {
    const convA = db.conversationStore.ensureDefault("agent-a").id;
    const convB = db.conversationStore.ensureDefault("agent-b").id;
    for (let index = 0; index < 30; index += 1) {
      db.append("agent-a", [{ kind: "message", id: "a-" + index, role: index % 2 === 0 ? "user" : "assistant", content: "needle phrase number " + index + " alpha", timestampMs: 1000 + index }], convA);
    }
    db.append("agent-b", [{ kind: "message", id: "b-1", role: "user", content: "needle phrase secret-cross-agent", timestampMs: 1 }], convB);
    return { convA, convB };
  }

  it("is agent-scoped and conversation-scoped (no cross-agent/cross-conversation leak)", async () => {
    const { db } = tmpStore();
    const { convA, convB } = seed(db);
    const pageA = db.memoryStore.searchTranscript("agent-a", "needle phrase", { conversationId: convA, limit: 50 });
    expect(pageA.items.length).toBeGreaterThan(0);
    expect(pageA.items.every((item) => item.conversationId === convA)).toBe(true);
    const pageOther = db.memoryStore.searchTranscript("agent-a", "needle phrase", { conversationId: convB, limit: 50 });
    expect(pageOther.items).toHaveLength(0);
    const cross = db.memoryStore.searchTranscript("agent-b", "needle phrase", { conversationId: convB, limit: 50 });
    expect(cross.items.some((item) => item.entryId === "b-1")).toBe(true);
    const leaked = db.memoryStore.searchTranscript("agent-b", "secret-cross-agent", { conversationId: convA, limit: 50 });
    expect(leaked.items).toHaveLength(0);
    db.close();
  });

  it("bounds snippets (never unbounded content)", async () => {
    const { db } = tmpStore();
    const convA = db.conversationStore.ensureDefault("a").id;
    db.append("a", [{ kind: "message", id: "long-1", role: "user", content: "needle " + "x".repeat(2000) + " tail", timestampMs: 1 }], convA);
    const page = db.memoryStore.searchTranscript("a", "needle", { conversationId: convA, limit: 10 });
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(item.snippet.length).toBeLessThan(300);
      expect(item.snippet).not.toContain("tail");
    }
    db.close();
  });

  it("rejects an invalid cursor and pages without duplication", async () => {
    const { db } = tmpStore();
    const { convA } = seed(db);
    expect(() => db.memoryStore.searchTranscript("agent-a", "needle", { conversationId: convA, cursor: "garbage" })).toThrow(/cursor/);
    expect(() => db.memoryStore.searchTranscript("agent-a", "needle", { conversationId: convA, cursor: "v1t:abc" })).toThrow(/cursor/);
    const ids: string[] = [];
    let first = db.memoryStore.searchTranscript("agent-a", "needle", { conversationId: convA, limit: 7 });
    let cursor: string | undefined = first.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    expect(() => db.memoryStore.searchTranscript("agent-b", "needle", { cursor })).toThrow(/cursor/);
    expect(() => db.memoryStore.searchTranscript("agent-a", "alpha", { conversationId: convA, cursor })).toThrow(/cursor/);
    ids.push(...first.items.map((item) => item.entryId || ""));
    let pages = 1;
    while (cursor !== undefined && pages < 20) {
      const next = db.memoryStore.searchTranscript("agent-a", "needle", { conversationId: convA, limit: 7, cursor });
      ids.push(...next.items.map((item) => item.entryId || ""));
      cursor = next.nextCursor;
      pages += 1;
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(30);
    db.close();
  });
});

describe("P2.3 incremental history (authoritative SQLite)", () => {
  it("tails pages without gaps or duplication using a stable cursor", async () => {
    const { db } = tmpStore();
    const convA = db.conversationStore.ensureDefault("a").id;
    for (let index = 0; index < 60; index += 1) {
      db.append("a", [{ kind: "message", id: "h-" + index, role: index % 2 === 0 ? "user" : "assistant", content: "line " + index, timestampMs: index }], convA);
    }
    const allIds: string[] = [];
    let page = db.openDurableAgentTail("a", 21, undefined, convA);
    allIds.push(...page.entries.map((entry) => entry.id as string));
    while (page.nextBeforeSeq !== undefined) {
      page = db.openDurableAgentTail("a", 21, page.nextBeforeSeq, convA);
      allIds.push(...page.entries.map((entry) => entry.id as string));
    }
    expect(allIds).toHaveLength(60);
    expect(new Set(allIds).size).toBe(60);
    db.close();
  });
});
