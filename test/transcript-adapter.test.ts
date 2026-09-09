import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createTranscriptAdapter, createTranscriptSnapshotGate } = require("../client/extracted/dist/node-agent-coordinator/openbot-transcript-adapter.cjs") as {
  createTranscriptAdapter: (options: {
    onEmit: (payload: any) => void;
    onResync: (payload: any) => void;
    schedule: (callback: () => void) => unknown;
    cancel: (handle: unknown) => void;
    coalesce?: boolean;
  }) => {
    accept: (payload: any) => string;
    flush: (agentId: string) => boolean;
    markResync: (payload: any, reason?: string) => void;
    reset: (payload: any, options?: { allowConversationSwitch?: boolean }) => string;
    disposeAgent: (agentId: string) => boolean;
    getState: (agentId: string) => any;
    dispose: () => void;
  };
  createTranscriptSnapshotGate: () => {
    begin: (agentId: string, conversationId?: string) => { agentId: string; conversationId?: string; generation: number };
    isCurrent: (request: { agentId: string; generation: number }) => boolean;
    disposeAgent: (agentId: string) => void;
  };
};

const AGENT_ID = "agent-a";
const REPLICA = `transcript:${AGENT_ID}`;

it("projects tool progress and failure into one visible native notice without raw output", () => {
  const { adapter, emitted } = makeAdapter();
  const entry = { kind: "tool-call", id: "tool-1", name: "process_run", summary: "run process", status: "running" };
  adapter.reset({ type: "snapshot", agentId: AGENT_ID, entries: [entry] });
  expect(emitted.at(-1).entries).toEqual([{ kind: "notice", id: "tool-1", text: "Executando · run process" }]);
  adapter.accept({ type: "updated", agentId: AGENT_ID, ordered: order(1), entry: {
    ...entry, status: "failed", result: { ok: false, message: "Process exited with code 7.", stdout: "synthetic-private-output" },
  } });
  expect(emitted.at(-1).entry).toEqual({ kind: "notice", id: "tool-1", text: "Falhou · run process · Process exited with code 7." });
});

function assistant(content = "", streaming = true) {
  return {
    kind: "message",
    id: "assistant-1",
    role: "assistant",
    content,
    timestampMs: 1,
    streaming,
    isStreaming: streaming,
  };
}

function order(sequence: number, epoch = "epoch-1") {
  return { replicaKey: REPLICA, epoch, sequence };
}

function makeAdapter(options: { coalesce?: boolean } = {}) {
  const emitted: any[] = [];
  const resyncs: any[] = [];
  const scheduled: Array<() => void> = [];
  const adapter = createTranscriptAdapter({
    onEmit: (payload) => emitted.push(payload),
    onResync: (payload) => resyncs.push(payload),
    schedule: (callback) => {
      scheduled.push(callback);
      return callback;
    },
    cancel: (handle) => {
      const index = scheduled.indexOf(handle as () => void);
      if (index >= 0) scheduled.splice(index, 1);
    },
    coalesce: options.coalesce,
  });
  return { adapter, emitted, resyncs, scheduled };
}

describe("coordinator transcript adapter", () => {
  it("acknowledges local user nonces without changing stored provenance or agent authors", () => {
    const { adapter, emitted } = makeAdapter();
    const user = { kind: "message", id: "user-1", role: "user", content: "anexo", clientNonce: "nonce-1", fromUser: { authId: "local", name: "Local" } };
    const agent = { ...user, id: "agent-1", fromAgent: { id: "peer" } };
    adapter.reset({ type: "snapshot", agentId: AGENT_ID, entries: [user, agent] });
    expect(emitted[0].entries[0]).toEqual({ kind: "message", id: "user-1", role: "user", content: "anexo", clientNonce: "nonce-1" });
    expect(emitted[0].entries[1]).toEqual(agent);
    expect(user.fromUser.authId).toBe("local");
    expect(adapter.accept({ type: "appended", agentId: AGENT_ID, entry: { ...user, id: "user-2" }, ordered: order(1) })).toBe("applied");
    expect(emitted.at(-1).entry.fromUser).toBeUndefined();
    expect(emitted.at(-1).entry.clientNonce).toBe("nonce-1");
  });

  it("converts ordered deltas to renderer-compatible dense updated events", () => {
    const { adapter, emitted } = makeAdapter();
    adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant()] });
    expect(adapter.accept({ type: "appended", agentId: AGENT_ID, entry: { kind: "message", id: "user-1", role: "user", content: "oi", timestampMs: 1 }, ordered: order(1) })).toBe("applied");
    expect(adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "a", ordered: order(2) })).toBe("applied");
    expect(adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "b", ordered: order(3) })).toBe("applied");
    expect(emitted.map((payload) => payload.type)).toEqual(["snapshot", "appended", "updated", "updated"]);
    adapter.flush(AGENT_ID);
    expect(emitted.at(-1)).toMatchObject({ type: "updated", entry: { id: "assistant-1", content: "ab" }, ordered: { replicaKey: REPLICA, sequence: 3 }, throughSequence: 3, final: false });

    expect(adapter.accept({ type: "updated", agentId: AGENT_ID, entry: assistant("ab", false), ordered: order(4), throughSequence: 3, final: true })).toBe("applied");
    expect(emitted.at(-1)).toMatchObject({ type: "updated", entry: { content: "ab", streaming: false }, ordered: { replicaKey: REPLICA, sequence: 4 }, throughSequence: 4, final: true });
    expect(emitted.every((payload) => payload.type !== "delta")).toBe(true);
    expect(emitted.filter((payload) => payload.type !== "snapshot").map((payload) => payload.ordered.sequence)).toEqual([1, 2, 3, 4]);
    expect(adapter.getState(AGENT_ID).finalEntryIds.has("assistant-1")).toBe(true);
  });

  it("dedupes tuple and requests authoritative resync on gap, reorder, stale epoch, and wrong entry stream", () => {
    const { adapter, resyncs } = makeAdapter();
    adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant()] });
    expect(adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "a", ordered: order(1) })).toBe("applied");
    expect(adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "a", ordered: order(1) })).toBe("duplicate");
    expect(adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "gap", ordered: order(3) })).toBe("resync");
    expect(resyncs.at(-1)).toMatchObject({ reason: "sequence-gap", resyncRequired: true, agentId: AGENT_ID });

    const reordered = makeAdapter();
    reordered.adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant()], ordered: order(5) });
    expect(reordered.adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "regressive", ordered: order(4) })).toBe("resync");
    expect(reordered.resyncs.at(-1)).toMatchObject({ reason: "sequence-reorder", resyncRequired: true, agentId: AGENT_ID });

    const stale = makeAdapter();
    stale.adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant()] });
    stale.adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "a", ordered: order(1) });
    expect(stale.adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "old", ordered: order(2, "old-epoch") })).toBe("resync");
    expect(stale.resyncs.at(-1)).toMatchObject({ reason: "stale-epoch" });

    const wrong = makeAdapter();
    wrong.adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant()] });
    wrong.adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "a", ordered: order(1) });
    expect(wrong.adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "wrong", ordered: { replicaKey: `${REPLICA}:other`, epoch: "epoch-1", sequence: 2 } })).toBe("resync");
    expect(wrong.resyncs.at(-1)).toMatchObject({ reason: "replica-mismatch" });
  });

  it("suppresses late frames after reconnect until an unordered authoritative snapshot resets the epoch", () => {
    const { adapter, emitted, resyncs } = makeAdapter();
    adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant()] });
    adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "old", ordered: order(1) });
    adapter.markResync({ agentId: AGENT_ID }, "reconnect");
    expect(adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "replayed", ordered: order(2) })).toBe("ignored");
    expect(resyncs).toHaveLength(0);
    expect(adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant("durable")] })).toBe("applied");
    expect(adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: " + fresh", ordered: order(1, "fresh-epoch") })).toBe("applied");
    adapter.flush(AGENT_ID);
    expect(emitted.at(-1)).toMatchObject({ type: "updated", entry: { content: "durable + fresh" } });
  });

  it("rejects a delta after the final authoritative update", () => {
    const { adapter, resyncs } = makeAdapter();
    adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant()] });
    adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "done", ordered: order(1) });
    adapter.accept({ type: "updated", agentId: AGENT_ID, entry: assistant("done", false), ordered: order(2), throughSequence: 1, final: true });
    expect(adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "late", ordered: order(3) })).toBe("resync");
    expect(resyncs.at(-1)).toMatchObject({ reason: "delta-after-final" });
  });

  it("hydrates final assistant ids from an authoritative snapshot", () => {
    const { adapter, resyncs } = makeAdapter();
    expect(adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant("persisted", false)] })).toBe("applied");
    expect(adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "late", ordered: order(1) })).toBe("resync");
    expect(resyncs.at(-1)).toMatchObject({ reason: "delta-after-final" });
  });

  it("keeps a 2,048-fragment burst bounded at the renderer boundary and preserves exact text", () => {
    const { adapter, emitted, scheduled } = makeAdapter({ coalesce: true });
    adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant()] });
    adapter.accept({ type: "appended", agentId: AGENT_ID, entry: { kind: "message", id: "user-1", role: "user", content: "oi", timestampMs: 1 }, ordered: order(1) });
    const fragments = Array.from({ length: 2048 }, (_, index) => `fragment-${index}|`);
    for (const [index, fragment] of fragments.entries()) {
      expect(adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment, ordered: order(index + 2) })).toBe("applied");
    }
    expect(emitted.filter((payload) => payload.type === "updated")).toHaveLength(0);
    expect(scheduled).toHaveLength(1);
    adapter.flush(AGENT_ID);
    const forwarded = emitted.filter((payload) => payload.type !== "snapshot");
    const updates = forwarded.filter((payload) => payload.type === "updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      ordered: { replicaKey: REPLICA, sequence: 2 },
      entry: { content: fragments.join("") },
    });
    expect(forwarded.map((payload) => payload.ordered.sequence)).toEqual([1, 2]);
    expect(Math.max(...forwarded.map((payload) => Buffer.byteLength(JSON.stringify(payload), "utf8")))).toBeLessThan(256 * 1024);
  });

  it("does not let a stale or conflicting ordered snapshot overwrite the current state", () => {
    const { adapter, emitted, resyncs } = makeAdapter();
    expect(adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant("new")], ordered: order(5) })).toBe("applied");
    expect(adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant("old")], ordered: order(4) })).toBe("resync");
    expect(resyncs.at(-1)).toMatchObject({ reason: "stale-snapshot" });
    expect(adapter.getState(AGENT_ID).entries[0]).toMatchObject({ content: "new" });

    const conflict = makeAdapter();
    expect(conflict.adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant("new")], ordered: order(5) })).toBe("applied");
    expect(conflict.adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant("different")], ordered: order(5) })).toBe("resync");
    expect(conflict.resyncs.at(-1)).toMatchObject({ reason: "conflicting-duplicate" });
    expect(conflict.adapter.getState(AGENT_ID).entries[0]).toMatchObject({ content: "new" });
    expect(emitted.filter((payload) => payload.type === "snapshot")).toHaveLength(1);
  });

  it("binds live events to a conversation and permits switching only through an explicit snapshot reset", () => {
    const { adapter, resyncs } = makeAdapter();
    expect(adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, conversationId: "c1", entries: [assistant("one")] })).toBe("applied");
    expect(adapter.accept({ type: "appended", agentId: AGENT_ID, conversationId: "c2", entry: { kind: "notice", id: "wrong", text: "wrong", level: "info" }, ordered: order(1) })).toBe("resync");
    expect(resyncs.at(-1)).toMatchObject({ reason: "cross-conversation", conversationId: "c2" });

    const implicit = makeAdapter();
    expect(implicit.adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, conversationId: "c1", entries: [assistant("one")] })).toBe("applied");
    expect(implicit.adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, conversationId: "c2", entries: [assistant("two")] })).toBe("resync");
    expect(implicit.resyncs.at(-1)).toMatchObject({ reason: "cross-conversation", conversationId: "c2" });
    expect(implicit.adapter.getState(AGENT_ID)).toMatchObject({ conversationId: "c1", entries: [{ content: "one" }] });

    const switched = makeAdapter();
    expect(switched.adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, conversationId: "c1", entries: [assistant("one")] })).toBe("applied");
    expect(switched.adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, conversationId: "c2", entries: [assistant("two")] }, { allowConversationSwitch: true })).toBe("applied");
    expect(switched.adapter.getState(AGENT_ID).conversationId).toBe("c2");
  });

  it("drops an out-of-order snapshot completion after a newer conversation request", () => {
    const gate = createTranscriptSnapshotGate();
    const c1 = gate.begin(AGENT_ID, "c1");
    const c2 = gate.begin(AGENT_ID, "c2");
    expect(gate.isCurrent(c2)).toBe(true);
    expect(gate.isCurrent(c1)).toBe(false);
  });

  it("cleans an agent adapter and snapshot gate without retaining timers or stale requests", () => {
    const { adapter, scheduled } = makeAdapter({ coalesce: true });
    adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant()] });
    adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "pending", ordered: order(1) });
    expect(scheduled).toHaveLength(1);
    expect(adapter.disposeAgent(AGENT_ID)).toBe(true);
    expect(scheduled).toHaveLength(0);
    expect(adapter.getState(AGENT_ID).rendererGeneration).toBe(0);

    const gate = createTranscriptSnapshotGate();
    const oldRequest = gate.begin(AGENT_ID, "c1");
    gate.disposeAgent(AGENT_ID);
    expect(gate.isCurrent(oldRequest)).toBe(false);
    const freshRequest = gate.begin(AGENT_ID, "c1");
    expect(freshRequest.generation).not.toBe(oldRequest.generation);
    expect(gate.isCurrent(oldRequest)).toBe(false);
  });

  it("rebases an in-flight assistant append after a durable reconnect snapshot", () => {
    const { adapter, emitted } = makeAdapter();
    adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [] });
    expect(adapter.accept({ type: "appended", agentId: AGENT_ID, entry: assistant("old"), ordered: order(1, "old-epoch") })).toBe("applied");
    expect(emitted.at(-1)).toMatchObject({ type: "appended", entry: { id: "assistant-1", content: "old" } });
    adapter.markResync({ agentId: AGENT_ID }, "reconnect");
    expect(adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: " + new", ordered: order(1, "fresh-epoch") })).toBe("buffered");
    expect(adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant("old")] })).toBe("applied");
    adapter.flush(AGENT_ID);
    expect(emitted.at(-1)).toMatchObject({ type: "updated", entry: { content: "old + new" } });
  });

  it("accepts an ordered backend snapshot as the explicit conversation switch boundary", () => {
    const { adapter } = makeAdapter();
    adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, conversationId: "c1", entries: [assistant("one")] });
    expect(adapter.accept({ type: "appended", agentId: AGENT_ID, conversationId: "c1", entry: { kind: "notice", id: "c1-entry", text: "one", level: "info" }, ordered: order(1) })).toBe("applied");
    expect(adapter.accept({
      type: "snapshot",
      agentId: AGENT_ID,
      activeAgentId: AGENT_ID,
      conversationId: "c2",
      entries: [assistant("two")],
      ordered: order(1),
    })).toBe("applied");
    expect(adapter.getState(AGENT_ID)).toMatchObject({ conversationId: "c2", entries: [{ content: "two" }] });
  });

  it("buffers fresh ordered frames during resync and replays them after the durable snapshot", () => {
    const { adapter, emitted } = makeAdapter();
    adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, conversationId: "c1", entries: [assistant()] });
    adapter.accept({ type: "delta", agentId: AGENT_ID, conversationId: "c1", entryId: "assistant-1", fragment: "old", ordered: order(1, "old") });
    adapter.markResync({ agentId: AGENT_ID, conversationId: "c1" }, "server-resync");
    expect(adapter.accept({ type: "delta", agentId: AGENT_ID, conversationId: "c1", entryId: "assistant-1", fragment: "late-old", ordered: order(2, "old") })).toBe("ignored");
    expect(adapter.accept({ type: "delta", agentId: AGENT_ID, conversationId: "c1", entryId: "assistant-1", fragment: "a", ordered: order(1, "fresh") })).toBe("buffered");
    expect(adapter.accept({ type: "delta", agentId: AGENT_ID, conversationId: "c1", entryId: "assistant-1", fragment: "b", ordered: order(2, "fresh") })).toBe("buffered");
    expect(adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, conversationId: "c1", entries: [assistant("durable")] })).toBe("applied");
    adapter.flush(AGENT_ID);
    expect(emitted.at(-1)).toMatchObject({ type: "updated", entry: { content: "durableab" } });
  });

  it("dedupes a buffered appended entry already covered by the authoritative snapshot", () => {
    const { adapter, emitted, resyncs } = makeAdapter();
    const user = { kind: "message", id: "user-race", role: "user", content: "oi", timestampMs: 1 };
    adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant()] });
    adapter.markResync({ agentId: AGENT_ID }, "server-resync");
    expect(adapter.accept({ type: "appended", agentId: AGENT_ID, entry: user, ordered: order(1, "fresh") })).toBe("buffered");
    expect(adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant(), user] })).toBe("applied");
    expect(resyncs).toHaveLength(0);
    expect(emitted.filter((payload) => payload.type === "appended")).toHaveLength(0);
    expect(adapter.getState(AGENT_ID).cursors.get(REPLICA)).toMatchObject({ epoch: "fresh", lastSequence: 1 });
  });

  it("fails closed when a buffered appended id conflicts with the snapshot", () => {
    const { adapter, resyncs } = makeAdapter();
    const buffered = { kind: "notice", id: "notice-race", text: "late", level: "info" };
    const durable = { kind: "notice", id: "notice-race", text: "different", level: "info" };
    adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant()] });
    adapter.markResync({ agentId: AGENT_ID }, "server-resync");
    expect(adapter.accept({ type: "appended", agentId: AGENT_ID, entry: buffered, ordered: order(1, "fresh") })).toBe("buffered");
    expect(adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant(), durable] })).toBe("resync");
    expect(resyncs.at(-1)).toMatchObject({ reason: "duplicate-entry" });
    expect(adapter.getState(AGENT_ID).status).toBe("resync-required");
  });

  it("requires sequence one when replaying the first frame after an unordered snapshot", () => {
    const { adapter, resyncs } = makeAdapter();
    adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant()] });
    adapter.markResync({ agentId: AGENT_ID }, "server-resync");
    expect(adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "skipped", ordered: order(2, "fresh") })).toBe("buffered");
    expect(adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant("durable")] })).toBe("resync");
    expect(resyncs.at(-1)).toMatchObject({ reason: "initial-sequence-gap" });
    expect(adapter.getState(AGENT_ID).entries[0]).toMatchObject({ content: "durable" });
  });

  it("bounds frames retained while a resync request is in flight and fails closed on overflow", () => {
    const { adapter, resyncs } = makeAdapter();
    adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant()] });
    adapter.markResync({ agentId: AGENT_ID }, "server-resync");
    let buffered = 0;
    for (let sequence = 1; sequence <= 300; sequence += 1) {
      const result = adapter.accept({ type: "delta", agentId: AGENT_ID, entryId: "assistant-1", fragment: "x", ordered: order(sequence, "fresh") });
      if (result === "buffered") buffered += 1;
    }
    expect(buffered).toBeLessThanOrEqual(256);
    expect(adapter.getState(AGENT_ID).bufferedEvents.length).toBeLessThanOrEqual(256);
    expect(resyncs.at(-1)).toMatchObject({ reason: "resync-buffer-overflow", resyncRequired: true });
    expect(adapter.getState(AGENT_ID).status).toBe("resync-required");
    expect(adapter.reset({ type: "snapshot", agentId: AGENT_ID, activeAgentId: AGENT_ID, entries: [assistant("durable")] })).toBe("applied");
    expect(adapter.getState(AGENT_ID).entries[0]).toMatchObject({ content: "durable" });
  });
});
