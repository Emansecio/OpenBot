import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { A2AStore, type A2AStoreOptions } from "../src/a2a/store.js";
import type { A2AEnvelope } from "../src/a2a/contracts.js";

type SendInput = Omit<A2AEnvelope, "senderIncarnation" | "recipientIncarnation">;

const roots: string[] = [];
const stores = new Set<A2AStore>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), "openbot-a2a-store-"));
  roots.push(root);
  return join(root, "store.db");
}

function harness(): { options: A2AStoreOptions; now: { value: number } } {
  const now = { value: 1_000 };
  return { options: { path: dbPath(), now: () => now.value, sensitiveValues: () => [] }, now };
}

function open(h: { options: A2AStoreOptions }, active = ["agent-a", "agent-b", "agent-c"]): A2AStore {
  const store = new A2AStore(h.options);
  stores.add(store);
  store.syncActiveAgents(active);
  for (const agentId of active) store.ensureAgentIncarnation(agentId);
  return store;
}

function message(overrides: Partial<SendInput> = {}): SendInput {
  return {
    version: 1,
    messageId: "message-1",
    senderAgentId: "agent-a",
    recipientAgentId: "agent-b",
    nonce: "nonce-1",
    parentTaskId: null,
    parentTurnId: "turn-1",
    priority: "normal",
    hopCount: 0,
    payload: { version: 1, kind: "text", text: "hello" },
    createdAtMs: 1_000,
    availableAtMs: 1_000,
    expiresAtMs: null,
    ...overrides,
  };
}

describe("P2.1 durable A2A store", () => {
  it("resolves active incarnations and commits message, limits and outbox atomically before wake", () => {
    const h = harness();
    const store = open(h);
    const result = store.send(message());
    expect(result).toMatchObject({ created: true, message: { status: "queued", nonce: "nonce-1" } });
    expect(result.message.senderIncarnation).toEqual(expect.any(String));
    expect(result.message.recipientIncarnation).toEqual(expect.any(String));
    expect(store.getMessage(result.message.messageId)).toMatchObject({ status: "queued" });
    expect(store.listUndeliveredOutbox()).toHaveLength(1);
    expect(store.getParentTurnUsage("agent-a", "turn-1")).toMatchObject({ messageCount: 1 });
  });

  it("keeps projection delivery durable until the SSE transport accepts it", () => {
    const h = harness();
    const store = open(h);
    store.send(message());
    const [projection] = store.projectUndelivered();
    expect(projection).toMatchObject({ agentId: "agent-b", sequence: 1, eventKind: "queued", payload: { messageId: "message-1", status: "queued" } });
    expect(store.acknowledgeProjection(projection!.projectionId, false)).toBe(false);
    expect(store.projectUndelivered()).toHaveLength(1);
    expect(store.acknowledgeProjection(projection!.projectionId, true)).toBe(true);
    expect(store.projectUndelivered()).toHaveLength(0);
    expect(store.listUndeliveredOutbox()).toHaveLength(0);
  });

  it("deduplicates an identical nonce without charging limits and rejects a conflicting retry", () => {
    const h = harness();
    const store = open(h);
    const first = store.send(message());
    const duplicate = store.send(message({ messageId: "different-id" }));
    expect(duplicate).toMatchObject({ created: false, message: { messageId: first.message.messageId } });
    expect(store.getParentTurnUsage("agent-a", "turn-1")).toMatchObject({ messageCount: 1 });
    expect(() => store.send(message({ messageId: "conflicting-id", payload: { version: 1, kind: "text", text: "different" } }))).toThrow(/nonce|conflict/i);
  });

  it("retorna o tail recente na listagem e no snapshot sem inverter a ordem de exibição", () => {
    const h = harness();
    const store = open({ options: { ...h.options, limits: { maxMessagesPerTurn: 200, maxPendingPerRecipient: 200 } } });
    for (let index = 0; index < 130; index += 1) {
      store.send(message({
        messageId: `message-${index}`,
        nonce: `nonce-${index}`,
        createdAtMs: 1_000 + index,
        availableAtMs: 1_000 + index,
      }));
    }

    const listed = store.listForRecipient("agent-b");
    const snapshot = store.getSnapshot("agent-b").items;
    expect(listed).toHaveLength(128);
    expect(listed[0]?.messageId).toBe("message-2");
    expect(listed.at(-1)?.messageId).toBe("message-129");
    expect(snapshot.map((item) => item.messageId)).toEqual(listed.map((item) => item.messageId));
    expect(snapshot.some((item) => item.messageId === "message-0")).toBe(false);
  });

  it.each([
    ["unknown recipient", /not active/i],
    ["sender fence", /fenced/i],
    ["recipient fence", /fenced/i],
    ["retired incarnation", /not active/i],
  ] as const)("rejects %s in the same transaction as dispatch", (label, errorPattern) => {
    const h = harness();
    const store = open(h);
    if (label === "unknown recipient") store.syncActiveAgents(["agent-a"]);
    if (label === "sender fence") store.fenceAgent("agent-a");
    if (label === "recipient fence") store.fenceAgent("agent-b");
    if (label === "retired incarnation") store.retireAgent("agent-b");
    expect(() => store.send(message({ nonce: `blocked-${label}` }))).toThrow(errorPattern);
    expect(store.getMessage("message-1")).toBeUndefined();
    expect(store.listUndeliveredOutbox()).toEqual([]);
    expect(store.getParentTurnUsage("agent-a", "turn-1")).toEqual({ messageCount: 0, byteCount: 0, recipients: [] });
  });

  it("persists a deletion fence across stores, clears it only as rollback, then permits dispatch", () => {
    const h = harness();
    const store = open(h);
    store.fenceAgent("agent-b");
    store.close();
    stores.delete(store);

    const reopened = open(h);
    expect(() => reopened.send(message({ nonce: "fenced" }))).toThrow(/fence/i);
    reopened.clearAgentFence("agent-b");
    expect(reopened.send(message({ nonce: "rollback-cleared" }))).toMatchObject({ created: true });
  });

  it("claims with a lease, rejects stale ACKs, ACKs idempotently and recovers expiry", () => {
    const h = harness();
    const store = open(h);
    store.send(message());
    const claim = store.claimNext("agent-b", { ownerId: "worker-1", nowMs: 1_000, leaseDurationMs: 100 });
    expect(claim).toMatchObject({ message: { status: "delivering" }, lease: { ownerId: "worker-1" } });
    expect(() => store.ack("message-1", { ownerId: "other", expectedVersion: claim!.message.version, status: "acked" })).toThrow();
    h.now.value = 1_101;
    expect(store.recoverExpired(1_101)).toMatchObject([{ status: "queued" }]);
    const retry = store.claimNext("agent-b", { ownerId: "worker-2", nowMs: 1_102, leaseDurationMs: 100 });
    const ack = store.ack("message-1", { ownerId: "worker-2", expectedVersion: retry!.message.version, status: "acked", ackNonce: "ack-1" });
    expect(ack).toMatchObject({ status: "acked", ack: { ackNonce: "ack-1" } });
    expect(store.ack("message-1", { ownerId: "worker-2", expectedVersion: ack.version, status: "acked", ackNonce: "ack-1" })).toEqual(ack);
  });

  it("terminalizes an expired lease at the durable delivery-attempt cap", () => {
    const h = harness();
    const store = open({ options: { ...h.options, limits: { maxAttempts: 1 } } });
    store.send(message());
    store.claimNext("agent-b", { ownerId: "worker-1", nowMs: 1_000, leaseDurationMs: 100 });
    expect(store.recoverExpired(1_101)).toMatchObject([{ status: "dead", attempt: 1, terminalReason: "attempt-cap" }]);
    expect(store.claimNext("agent-b", { ownerId: "worker-2", nowMs: 1_102, leaseDurationMs: 100 })).toBeUndefined();
  });

  it("compacts replaceable heartbeat events instead of growing both durable outboxes without bound", () => {
    const h = harness();
    const store = open(h);
    store.send(message());
    let claim = store.claimNext("agent-b", { ownerId: "worker-1", nowMs: 1_000, leaseDurationMs: 100 })!;
    for (let index = 0; index < 50; index += 1) {
      claim = {
        message: store.heartbeat("message-1", {
          ownerId: "worker-1",
          expectedVersion: claim.message.version,
          leaseDurationMs: 100,
          nowMs: 1_001 + index,
        }),
        lease: claim.lease,
      };
    }
    expect(store.listUndeliveredOutbox()).toHaveLength(3);
    expect(store.projectUndelivered(100)).toHaveLength(3);

    store.ack("message-1", {
      ownerId: "worker-1",
      expectedVersion: claim.message.version,
      status: "acked",
      ackNonce: "ack-bounded-heartbeat",
    });
    expect(store.listUndeliveredOutbox()).toHaveLength(3);
    expect(store.projectUndelivered(100)).toHaveLength(3);
  });

  it("upgrades an intermediate schema-v10 projection outbox without losing its pending event", () => {
    const h = harness();
    const store = open(h);
    store.send(message());
    store.close();
    stores.delete(store);

    const db = new Database(h.options.path);
    db.exec(`
      CREATE TABLE a2a_projection_outbox_intermediate (
        projection_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        epoch TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        transition_version INTEGER NOT NULL,
        event_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE(agent_id, epoch, sequence),
        UNIQUE(message_id, transition_version, event_kind)
      );
      INSERT INTO a2a_projection_outbox_intermediate
        (projection_id, message_id, agent_id, epoch, sequence, transition_version, event_kind, payload_json, created_at_ms)
      SELECT projection_id, message_id, agent_id, epoch, sequence, transition_version, event_kind, payload_json, created_at_ms
      FROM a2a_projection_outbox;
      DROP TABLE a2a_projection_outbox;
      ALTER TABLE a2a_projection_outbox_intermediate RENAME TO a2a_projection_outbox;
      PRAGMA user_version = 10;
    `);
    db.close();

    const reopened = open(h);
    const [projection] = reopened.projectUndelivered();
    expect(projection).toMatchObject({ messageId: "message-1", eventKind: "queued", sourceOutboxId: expect.any(String) });
    expect(reopened.acknowledgeProjection(projection!.projectionId, true)).toBe(true);
    expect(reopened.projectUndelivered()).toEqual([]);
    expect(reopened.listUndeliveredOutbox()).toEqual([]);
  });

  it("enforces the parent-turn message cap independently", () => {
    const h = harness();
    const store = open({ options: { ...h.options, limits: { maxMessagesPerTurn: 1, maxPendingPerRecipient: 10 } } });
    store.send(message({ messageId: "m1" }));
    expect(() => store.send(message({ messageId: "m2", nonce: "n2" }))).toThrow(/message|limit|cap/i);
  });

  it("enforces the parent-turn byte cap independently", () => {
    const h = harness();
    const store = open({ options: { ...h.options, limits: { maxBytesPerTurn: 100, maxMessagesPerTurn: 10, maxPendingPerRecipient: 10 } } });
    store.send(message({ messageId: "m1", payload: { version: 1, kind: "text", text: "x".repeat(60) } }));
    expect(() => store.send(message({ messageId: "m2", nonce: "n2", payload: { version: 1, kind: "text", text: "y".repeat(60) } }))).toThrow(/byte|limit|cap|size/i);
  });

  it("enforces the distinct-recipient fan-out cap independently", () => {
    const h = harness();
    const store = open({ options: { ...h.options, limits: { maxRecipientsPerTurn: 1, maxMessagesPerTurn: 10, maxPendingPerRecipient: 10 } } });
    store.send(message({ messageId: "m1", recipientAgentId: "agent-b" }));
    expect(() => store.send(message({ messageId: "m2", nonce: "n2", recipientAgentId: "agent-c" }))).toThrow(/recipient|fan.?out|limit|cap/i);
  });

  it("enforces the pending-per-recipient cap independently", () => {
    const h = harness();
    const store = open({ options: { ...h.options, limits: { maxPendingPerRecipient: 1, maxMessagesPerTurn: 10 } } });
    store.send(message({ messageId: "m1" }));
    expect(() => store.send(message({ messageId: "m2", nonce: "n2" }))).toThrow(/pending|limit|cap/i);
  });

  it("rejects known sensitive values before persisting payload or outbox", () => {
    const h = harness();
    const store = open({ options: { ...h.options, sensitiveValues: () => ["top-secret-token"] } });
    expect(() => store.send(message({ payload: { version: 1, kind: "text", text: "use top-secret-token" } }))).toThrow(/sensitive|secret/i);
    expect(store.getMessage("message-1")).toBeUndefined();
    expect(store.listUndeliveredOutbox()).toEqual([]);
    expect(store.getParentTurnUsage("agent-a", "turn-1")).toEqual({ messageCount: 0, byteCount: 0, recipients: [] });
  });

  it("terminalizes pending old incarnation durably and accepts only the recreated incarnation", () => {
    const h = harness();
    const store = open(h);
    const first = store.send(message());
    const oldIncarnation = first.message.recipientIncarnation;
    const oldProjectionEpoch = store.getSnapshot("agent-b").epoch;
    store.retireAgent("agent-b");
    expect(store.getMessage(first.message.messageId)).toMatchObject({ status: "cancelled" });
    expect(store.projectUndelivered().some((event) => event.agentId === "agent-b")).toBe(false);
    store.close();
    stores.delete(store);

    const reopened = open(h);
    expect(reopened.getSnapshot("agent-b").epoch).not.toBe(oldProjectionEpoch);
    expect(reopened.listForRecipient("agent-b")).toEqual([]);
    expect(reopened.getMessageForRecipient("agent-b", first.message.messageId)).toBeUndefined();
    const recreated = reopened.send(message({ messageId: "message-2", nonce: "nonce-2" }));
    expect(recreated.message.recipientIncarnation).not.toBe(oldIncarnation);
    expect(reopened.getMessage(first.message.messageId)).toMatchObject({ status: "cancelled" });
    expect(() => reopened.send(message({ messageId: "message-3", nonce: "nonce-3" }), { expectedRecipientIncarnation: oldIncarnation })).toThrow(/incarnation/i);
  });

  it("does not inherit nonce dedupe or parent-turn limits after sender recreation", () => {
    const h = harness();
    const store = open({ options: { ...h.options, limits: { maxMessagesPerTurn: 1, maxPendingPerRecipient: 10 } } });
    const first = store.send(message());
    expect(store.getParentTurnUsage("agent-a", "turn-1")).toMatchObject({ messageCount: 1 });

    store.retireAgent("agent-a");
    const recreatedIncarnation = store.ensureAgentIncarnation("agent-a");
    expect(recreatedIncarnation).not.toBe(first.message.senderIncarnation);
    expect(store.getParentTurnUsage("agent-a", "turn-1")).toMatchObject({ messageCount: 0 });

    const recreated = store.send(message({ messageId: "message-new-incarnation" }));
    expect(recreated).toMatchObject({ created: true, message: { senderIncarnation: recreatedIncarnation, nonce: "nonce-1" } });
    expect(store.getParentTurnUsage("agent-a", "turn-1")).toMatchObject({ messageCount: 1 });
  });

  it("migrates legacy schema-v10 identity keys without losing messages", () => {
    const h = harness();
    const store = open(h);
    const first = store.send(message());
    store.close();
    stores.delete(store);

    const db = new Database(h.options.path);
    db.exec(`
      CREATE TABLE a2a_messages_legacy_v10 AS SELECT * FROM a2a_messages;
      DROP TABLE a2a_messages;
      ALTER TABLE a2a_messages_legacy_v10 RENAME TO a2a_messages;
      CREATE UNIQUE INDEX ux_a2a_sender_nonce ON a2a_messages(sender_agent_id, nonce);

      CREATE TABLE a2a_parent_usage_legacy_v10 (
        sender_agent_id TEXT NOT NULL,
        parent_turn_id TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        byte_count INTEGER NOT NULL,
        recipients_json TEXT NOT NULL,
        PRIMARY KEY (sender_agent_id, parent_turn_id)
      );
      INSERT INTO a2a_parent_usage_legacy_v10
        (sender_agent_id, parent_turn_id, message_count, byte_count, recipients_json)
      SELECT sender_agent_id, parent_turn_id, message_count, byte_count, recipients_json
      FROM a2a_parent_usage;
      DROP TABLE a2a_parent_usage;
      ALTER TABLE a2a_parent_usage_legacy_v10 RENAME TO a2a_parent_usage;
      PRAGMA user_version = 10;
    `);
    db.close();

    const reopened = open(h);
    expect(reopened.getMessage(first.message.messageId)).toMatchObject({ senderIncarnation: first.message.senderIncarnation, nonce: "nonce-1" });
    expect(reopened.send(message({ messageId: "duplicate-after-migration" }))).toMatchObject({ created: false, duplicate: true });
    reopened.retireAgent("agent-a");
    const newIncarnation = reopened.ensureAgentIncarnation("agent-a");
    expect(reopened.send(message({ messageId: "same-nonce-new-incarnation" }))).toMatchObject({ created: true, message: { senderIncarnation: newIncarnation } });
  });
});
