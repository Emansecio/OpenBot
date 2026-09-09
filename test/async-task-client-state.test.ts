import { describe, expect, it } from "vitest";

import type { NativeAsyncTaskProjectionEvent, NativeAsyncTaskProjectionItem } from "../src/shared/contracts.js";
import { applyNativeAsyncTaskClientEvent, createNativeAsyncTaskClientState, nativeAsyncTaskClientEventId, toNativeAsyncTaskClientCursor } from "../src/tasks/client-state.js";

const item = (id: string, status: string, extra: Partial<NativeAsyncTaskProjectionItem> = {}): NativeAsyncTaskProjectionItem => ({
  id, kind: "subagent", status, label: "label-" + id, detail: "detail", startedAtMs: null, ...extra,
});

const snapshot = (epoch: string, sequence: number, items: NativeAsyncTaskProjectionItem[], reason = "stream-connected"): NativeAsyncTaskProjectionEvent => ({
  type: "snapshot", agentId: "agent-a", parentAgentId: "agent-a", channel: "async-tasks",
  epoch, sequence, tasks: items, resyncRequired: reason !== "cursor-current", reason,
});

const update = (epoch: string, sequence: number, item: NativeAsyncTaskProjectionItem): NativeAsyncTaskProjectionEvent => ({
  type: "update", agentId: "agent-a", parentAgentId: "agent-a", channel: "async-tasks",
  epoch, sequence, tasks: [item], resyncRequired: false, reason: "live",
});

describe("P2.2 native client state machine", () => {
  it("replaces the whole list on the initial snapshot", () => {
    const state = createNativeAsyncTaskClientState({ agentId: "agent-a", channel: "async-tasks" });
    const first = applyNativeAsyncTaskClientEvent(state, snapshot("epoch-1", 1, [item("t1", "queued"), item("t2", "running")]));
    expect(first.handled).toBe(true);
    expect(first.state.items.map((entry) => entry.id)).toEqual(["t1", "t2"]);
    expect(first.state.epoch).toBe("epoch-1");
    expect(first.state.sequence).toBe(1);
    expect(first.state.resyncRequired).toBe(false);
  });

  it("never concatenates snapshots and never duplicates task identities", () => {
    const state = createNativeAsyncTaskClientState({ agentId: "agent-a", channel: "async-tasks" });
    const first = applyNativeAsyncTaskClientEvent(state, snapshot("epoch-1", 1, [item("t1", "queued")]));
    // A resync snapshot from SQLite REPLACES local state (no append).
    const second = applyNativeAsyncTaskClientEvent(first.state, snapshot("epoch-1", 3, [item("t2", "running"), item("t3", "completed")]));
    expect(second.state.items.map((entry) => entry.id).sort()).toEqual(["t2", "t3"]);
    expect(second.state.items).toHaveLength(2);
    expect(new Set(second.state.items.map((entry) => entry.id)).size).toBe(2);
  });

  it("upserts by id on monotonic updates and advances the cursor only forward", () => {
    const state = applyNativeAsyncTaskClientEvent(
      applyNativeAsyncTaskClientEvent(createNativeAsyncTaskClientState({ agentId: "agent-a", channel: "async-tasks" }), snapshot("epoch-1", 1, [item("t1", "queued")])).state,
      update("epoch-1", 2, item("t1", "running")),
    ).state;
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ id: "t1", status: "running" });
    expect(state.sequence).toBe(2);
    // A new task appears as an update without replacing existing ones.
    const withNew = applyNativeAsyncTaskClientEvent(state, update("epoch-1", 3, item("t2", "queued"))).state;
    expect(withNew.items.map((entry) => entry.id).sort()).toEqual(["t1", "t2"]);
    expect(new Set(withNew.items.map((entry) => entry.id)).size).toBe(2);
  });

  it("deduplicates stale, duplicate and lower-sequence events without mutation", () => {
    const base = applyNativeAsyncTaskClientEvent(createNativeAsyncTaskClientState({ agentId: "agent-a", channel: "async-tasks" }), snapshot("epoch-1", 2, [item("t1", "queued")])).state;
    const dup = applyNativeAsyncTaskClientEvent(base, update("epoch-1", 2, item("t1", "running")));
    expect(dup.handled).toBe(false);
    expect(dup.reason).toBe("stale-or-duplicate");
    expect(dup.state.items[0]).toMatchObject({ status: "queued" });
    const older = applyNativeAsyncTaskClientEvent(base, update("epoch-1", 1, item("t1", "failed")));
    expect(older.handled).toBe(false);
    expect(older.state.items[0]?.status).toBe("queued");
  });

  it("flags epoch mismatch, stale/gap and cursor-ahead as resync from SQLite", () => {
    const retained = item("t1", "queued");
    const base = applyNativeAsyncTaskClientEvent(createNativeAsyncTaskClientState({ agentId: "agent-a", channel: "async-tasks" }), snapshot("epoch-1", 1, [retained])).state;
    const mismatch = applyNativeAsyncTaskClientEvent(base, update("epoch-2", 2, item("t9", "running")));
    expect(mismatch.handled).toBe(false);
    expect(mismatch.resyncRequired).toBe(true);
    expect(mismatch.reason).toBe("epoch-mismatch");
    const gap = applyNativeAsyncTaskClientEvent(base, update("epoch-1", 3, item("t-gap", "running")));
    expect(gap.handled).toBe(true);
    expect(gap.resyncRequired).toBe(true);
    expect(gap.reason).toBe("update-gap");
    expect(gap.state).toMatchObject({ sequence: 3, resyncRequired: true });
    // A resync marker never mutates the list content.
    const cursorAhead = applyNativeAsyncTaskClientEvent(base, { type: "resync", agentId: "agent-a", parentAgentId: "agent-a", channel: "async-tasks", epoch: "epoch-9", sequence: 99, resyncRequired: true, reason: "cursor-ahead" });
    expect(cursorAhead.handled).toBe(true);
    expect(cursorAhead.resyncRequired).toBe(true);
    expect(cursorAhead.reason).toBe("cursor-ahead");
    expect(cursorAhead.state).toMatchObject({ epoch: "epoch-9", sequence: 99, resyncRequired: true, items: [retained] });
  });

  it("exports a Last-Event-ID cursor and ignores foreign scopes", () => {
    const state = applyNativeAsyncTaskClientEvent(createNativeAsyncTaskClientState({ agentId: "agent-a", channel: "async-tasks" }), snapshot("epoch-1", 4, [])).state;
    const cursor = toNativeAsyncTaskClientCursor(state);
    expect(cursor).toMatchObject({ channel: "async-tasks", epoch: "epoch-1", sequence: 4 });
    expect(nativeAsyncTaskClientEventId(cursor!)).toBe("async-tasks:epoch-1:4");
    const foreign = applyNativeAsyncTaskClientEvent(state, { type: "update", agentId: "agent-b", parentAgentId: "agent-b", channel: "async-tasks", epoch: "epoch-1", sequence: 5, tasks: [item("t-foreign", "running")] });
    expect(foreign.handled).toBe(false);
    expect(foreign.reason).toBe("wrong-scope");
    expect(foreign.state.items).toEqual([]);
  });
});
