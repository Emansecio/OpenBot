/**
 * P2.4 — durable reactions: store/RPC/SSE ordering, nonce dedupe, fail-closed
 * foreign/missing targets, station identity and reconnect-safe ordered frames.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createGateway, type RpcHandler } from "../src/server/gateway.js";
import { createServer } from "node:http";
import { ReactionStore } from "../src/reactions/store.js";
import { registerReactionHandlers } from "../src/rpc/reactions.js";
import type { ServerHandle } from "../src/main.js";
import { startServer, stopServer } from "../src/main.js";
import { TempRoots } from "./helpers/temp-roots.js";

const handles: ServerHandle[] = [];
const tempRoots = new TempRoots();

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => stopServer(h)));
  await tempRoots.cleanup();
});

function context(handle: ServerHandle) {
  return { getStatus: () => handle.runner.getStatus(), publish: () => undefined, method: "test" } as never;
}

function handler(handle: ServerHandle, method: string): RpcHandler {
  const fn = handle.gateway.listHandlers().get(method);
  if (!fn) throw new Error("missing handler: " + method);
  return fn;
}

async function harness(): Promise<ServerHandle> {
  const root = tempRoots.make("openbot-p24-rx-");
  const handle = await startServer(0, {
    configPath: join(root, "config.json"), stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime"),
    browserRoot: join(root, "browser"), keystoreDir: join(root, "keystore"), storePath: join(root, "store.db"),
    allowUnauthenticatedLocalGateway: true,
  });
  handles.push(handle);
  await handler(handle, "createAgent")({ id: "agent-a", name: "Agent A" }, context(handle));
  await handler(handle, "createAgent")({ id: "agent-b", name: "Agent B" }, context(handle));
  return handle;
}

async function durableEntry(handle: ServerHandle, agentId: string): Promise<{ entryId: string; conversationId: string }> {
  handle.store.append(agentId, [{ kind: "message", id: "m-" + randomUUID().slice(0, 8), role: "user", content: "alvo durável", timestampMs: Date.now() }]);
  const conversationId = handle.store.conversationStore.ensureDefault(agentId).id;
  const entry = handle.store.getEntries(agentId, conversationId).find((e) => e.kind === "message" && e.role === "user");
  if (!entry) throw new Error("no durable entry");
  const entryId = (entry as { id: string }).id;
  return { entryId, conversationId };
}

describe("P2.4 reactions (store)", () => {
  it("adds, deduplicates by nonce and lists with stable identity", async () => {
    const handle = await harness();
    void handle;
    const store = new ReactionStore({ db: handle.store.databaseForSharedStores(), resolveEntry: () => true });
    const one = store.add("a", { entryId: "m1", emoji: "heart", nonce: "n-1" });
    const dup = store.add("a", { entryId: "m1", emoji: "heart", nonce: "n-1" });
    expect(dup.id).toBe(one.id);
    const listed = store.list("a");
    expect(listed.filter((r) => r.state === "confirmed").map((r) => r.id)).toEqual([one.id]);
  });

  it("rejects missing and temporary targets fail-closed", async () => {
    const handle = await harness();
    void handle;
    const missing = new ReactionStore({ db: handle.store.databaseForSharedStores(), resolveEntry: () => false });
    expect(() => missing.add("a", { entryId: "x", emoji: "heart", nonce: "n2" })).toThrow(/inexistente/);
    const temp = new ReactionStore({ db: handle.store.databaseForSharedStores(), resolveEntry: () => "temporary" });
    expect(() => temp.add("a", { entryId: "x", emoji: "heart", nonce: "n2" })).toThrow(/temporaria/);
  });

  it("rejects foreign removal and enforces per-entry limit", async () => {
    const handle = await harness();
    void handle;
    const store = new ReactionStore({ db: handle.store.databaseForSharedStores(), resolveEntry: () => true });
    const a = Array.from({ length: 64 }, (_, i) => store.add("a", { entryId: "m1", emoji: "e", nonce: "lim-" + i }));
    const first = a[0]!;
    expect(store.list("a").length).toBe(64);
    expect(() => store.add("a", { entryId: "m1", emoji: "e", nonce: "lim-64" })).toThrow(/limite/);
    expect(store.remove("b", first.id)).toBe(false);
    expect(store.remove("a", first.id)).toBe(true);
    expect(store.list("a").some((r) => r.id === first.id)).toBe(false);
  });
});

describe("P2.4 reactions (RPC + SSE ordered)", () => {
  it("add/remove/list over the gateway resolve a durable entry and emit ordered SSE", async () => {
    const handle = await harness();
    const { entryId, conversationId } = await durableEntry(handle, "agent-a");
    const reader = await (async () => {
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/events?channels=reactions&agentId=agent-a`, { headers: { accept: "text/event-stream" } });
      return response.body!.getReader();
    })();
    const decoder = new TextDecoder();
    const collect = async (count: number) => {
      let buffer = "";
      const frames: unknown[] = [];
      while (frames.length < count) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        let sep = buffer.indexOf("\n\n");
        while (sep >= 0 && frames.length < count) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          if (data) frames.push(JSON.parse(data));
          sep = buffer.indexOf("\n\n");
        }
      }
      return frames;
    };
    const added = await handler(handle, "addReaction")({ agentId: "agent-a", entryId, emoji: "heart", nonce: "rx-1", conversationId }, context(handle)) as { id: string; state: string; emoji: string };
    expect(added).toMatchObject({ id: expect.any(String), state: "confirmed", emoji: "heart" });
    const dup = await handler(handle, "addReaction")({ agentId: "agent-a", entryId, emoji: "heart", nonce: "rx-1", conversationId }, context(handle)) as { id: string };
    expect(dup.id).toBe(added.id);
    const frames = await collect(1);
    const payload = frames[0] as { channel?: string; payload?: { reason?: string; ordered?: { replicaKey?: string; sequence?: number }; reaction?: { id?: string } } };
    expect(payload.channel).toBe("reactions");
    expect(payload.payload?.reason).toBe("add");
    expect(payload.payload?.ordered).toMatchObject({ replicaKey: "reactions:agent-a", sequence: expect.any(Number) });
    const listed = await handler(handle, "listReactions")({ agentId: "agent-a", conversationId }, context(handle));
    expect((listed as unknown[]).length).toBe(1);
    const other = await handler(handle, "listReactions")({ agentId: "agent-a", conversationId: "conv-ficticia" }, context(handle));
    expect((other as unknown[]).length).toBe(0);
    await reader.cancel();
  });

  it("reactToMessage alias resolves a durable entry and fails closed on missing target", async () => {
    const handle = await harness();
    const { entryId, conversationId } = await durableEntry(handle, "agent-a");
    const ok = await handler(handle, "reactToMessage")({ agentId: "agent-a", messageId: entryId, reaction: "laugh" }, context(handle));
    expect(ok).toMatchObject({ ok: true });
    const listed = await handler(handle, "listReactions")({ agentId: "agent-a", conversationId }, context(handle)) as Array<{ entryId: string; conversationId: string }>;
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ entryId, conversationId })]));
    await expect(Promise.resolve().then(() => handler(handle, "reactToMessage")({ agentId: "agent-a", messageId: "nao-existe", reaction: "laugh" }, context(handle)))).rejects.toMatchObject({ status: 404 });
    await expect(Promise.resolve().then(() => handler(handle, "addReaction")({ agentId: "agent-b", entryId, emoji: "heart", nonce: "foreign" }, context(handle)))).rejects.toMatchObject({ status: 404 });
  });

  it("resolves an unscoped entry without loading conversation pages or transcript bodies", async () => {
    const handle = await harness();
    const { entryId, conversationId } = await durableEntry(handle, "agent-a");
    const pages = vi.spyOn(handle.conversationStore, "list");
    const entries = vi.spyOn(handle.store, "getEntries");
    try {
      const reaction = await handler(handle, "addReaction")({ agentId: "agent-a", entryId, emoji: "heart", nonce: "indexed" }, context(handle)) as { conversationId: string };
      expect(reaction.conversationId).toBe(conversationId);
      expect(pages).not.toHaveBeenCalled();
      expect(entries).not.toHaveBeenCalled();
    } finally {
      pages.mockRestore();
      entries.mockRestore();
    }
  });

  it("reconciles a legacy unscoped reaction before nonce deduplication", async () => {
    const handle = await harness();
    const { entryId, conversationId } = await durableEntry(handle, "agent-a");
    const now = Date.now();
    handle.store.databaseForSharedStores().prepare(`INSERT INTO reactions
      (id, agent_id, conversation_id, entry_id, emoji, nonce, state, reason, created_at_ms, updated_at_ms)
      VALUES ('rx-legacy', 'agent-a', NULL, ?, 'heart', 'legacy-nonce', 'confirmed', NULL, ?, ?)`)
      .run(entryId, now, now);
    const retried = await handler(handle, "addReaction")({ agentId: "agent-a", entryId, conversationId, emoji: "heart", nonce: "legacy-nonce" }, context(handle)) as { id: string };
    expect(retried.id).toBe("rx-legacy");
    const listed = await handler(handle, "listReactions")({ agentId: "agent-a", conversationId }, context(handle)) as Array<{ id: string }>;
    expect(listed.map((item) => item.id)).toEqual(["rx-legacy"]);
  });

  it("does not assign an unscoped reaction when the entry ID exists in two conversations", async () => {
    const handle = await harness();
    const first = handle.conversationStore.create("agent-a");
    const second = handle.conversationStore.create("agent-a");
    for (const conversation of [first, second]) {
      handle.store.append("agent-a", [{ kind: "message", id: "duplicate-entry", role: "user", content: "same id", timestampMs: Date.now() }], conversation.id);
    }
    await expect(Promise.resolve().then(() => handler(handle, "addReaction")({ agentId: "agent-a", entryId: "duplicate-entry", emoji: "heart", nonce: "ambiguous" }, context(handle)))).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a reaction in a temporary conversation outside the first page", async () => {
    const handle = await harness();
    const temporary = handle.conversationStore.create("agent-a", { temporary: true });
    const entryId = "temporary-message";
    handle.store.append("agent-a", [{ kind: "message", id: entryId, role: "user", content: "temporary", timestampMs: Date.now() }], temporary.id);
    for (let index = 0; index < 201; index += 1) handle.conversationStore.create("agent-a", { title: `Later ${index}` });
    handle.store.databaseForSharedStores().prepare("UPDATE agent_conversations SET updated_at_ms = 1 WHERE id = ?").run(temporary.id);
    expect(handle.conversationStore.list("agent-a", { limit: 200 }).items.some((item) => item.id === temporary.id)).toBe(false);
    await expect(Promise.resolve().then(() => handler(handle, "addReaction")({ agentId: "agent-a", conversationId: temporary.id, entryId, emoji: "heart", nonce: "temporary-nonce" }, context(handle)))).rejects.toMatchObject({ status: 404, message: expect.stringContaining("reaction_conversa_temporaria") });
  });
});
