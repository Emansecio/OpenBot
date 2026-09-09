import { describe, expect, it } from "vitest";

import type { TranscriptEntry, TranscriptEventPayload } from "../src/shared/contracts.js";
import {
  createTranscriptClientState,
  markTranscriptResync,
  reduceTranscriptEvent,
} from "../src/shared/transcript-reducer.js";

const AGENT_ID = "agent-a";
const REPLICA = "transcript:agent-a";
const EPOCH = "epoch-1";

function assistant(content = "", streaming = true): TranscriptEntry {
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

function order(sequence: number, replicaKey = REPLICA, epoch = EPOCH) {
  return { replicaKey, epoch, sequence };
}

function apply(state: ReturnType<typeof createTranscriptClientState>, event: TranscriptEventPayload) {
  const result = reduceTranscriptEvent(state, event);
  expect(result.action).toBe("applied");
  expect(result.resyncRequired).toBe(false);
  return result.state;
}

describe("transcript client reducer", () => {
  it("applies ordered deltas, dedupes the tuple, replaces snapshots, and marks final", () => {
    let state = createTranscriptClientState(AGENT_ID);
    state = apply(state, {
      type: "appended",
      agentId: AGENT_ID,
      entry: assistant(),
    });
    state = apply(state, {
      type: "delta",
      agentId: AGENT_ID,
      entryId: "assistant-1",
      fragment: "a",
      ordered: order(2),
    });
    expect(state.cursors.get(REPLICA)).toMatchObject({ lastSequence: 2, throughSequence: 0 });
    const duplicate = reduceTranscriptEvent(state, {
      type: "delta",
      agentId: AGENT_ID,
      entryId: "assistant-1",
      fragment: "a",
      ordered: order(2),
    });
    expect(duplicate.action).toBe("duplicate");
    expect(duplicate.state.entries[0]).toMatchObject({ content: "a" });

    state = apply(state, {
      type: "delta",
      agentId: AGENT_ID,
      entryId: "assistant-1",
      fragment: "b",
      ordered: order(3),
    });
    state = apply(state, {
      type: "updated",
      agentId: AGENT_ID,
      entry: assistant("authoritative-ab"),
      ordered: order(4),
      throughSequence: 3,
      final: false,
    });
    state = apply(state, {
      type: "delta",
      agentId: AGENT_ID,
      entryId: "assistant-1",
      fragment: "!",
      ordered: order(5),
    });
    state = apply(state, {
      type: "updated",
      agentId: AGENT_ID,
      entry: assistant("authoritative-ab!", false),
      ordered: order(6),
      throughSequence: 5,
      final: true,
    });

    expect(state.entries[0]).toMatchObject({ content: "authoritative-ab!", streaming: false });
    expect(state.finalEntryIds.has("assistant-1")).toBe(true);
    expect(state.cursors.get(REPLICA)).toMatchObject({ lastSequence: 6, throughSequence: 5 });
  });

  it("fails closed on gap, reorder, stale epoch, and cross-agent events", () => {
    let state = createTranscriptClientState(AGENT_ID);
    state = apply(state, {
      type: "appended",
      agentId: AGENT_ID,
      entry: assistant(),
    });
    const bound = apply(state, {
      type: "delta",
      agentId: AGENT_ID,
      entryId: "assistant-1",
      fragment: "ok",
      ordered: order(1),
    });
    const gap = reduceTranscriptEvent(bound, {
      type: "delta",
      agentId: AGENT_ID,
      entryId: "assistant-1",
      fragment: "gap",
      ordered: order(3),
    });
    expect(gap).toMatchObject({ action: "resync", reason: "sequence-gap", resyncRequired: true });

    let reordered = createTranscriptClientState(AGENT_ID);
    reordered = apply(reordered, {
      type: "appended",
      agentId: AGENT_ID,
      entry: assistant(),
    });
    reordered = apply(reordered, {
      type: "delta",
      agentId: AGENT_ID,
      entryId: "assistant-1",
      fragment: "new",
      ordered: order(2),
    });
    const reorder = reduceTranscriptEvent(reordered, {
      type: "delta",
      agentId: AGENT_ID,
      entryId: "assistant-1",
      fragment: "old",
      ordered: order(1),
    });
    expect(reorder).toMatchObject({ action: "resync", reason: "sequence-reorder", resyncRequired: true });

    const staleEpoch = reduceTranscriptEvent(bound, {
      type: "delta",
      agentId: AGENT_ID,
      entryId: "assistant-1",
      fragment: "old",
      ordered: order(2, REPLICA, "epoch-old"),
    });
    expect(staleEpoch).toMatchObject({ action: "resync", reason: "stale-epoch", resyncRequired: true });

    const crossAgent = reduceTranscriptEvent(bound, {
      type: "delta",
      agentId: "agent-b",
      entryId: "assistant-1",
      fragment: "wrong-agent",
      ordered: order(2),
    });
    expect(crossAgent).toMatchObject({ action: "resync", reason: "cross-agent", resyncRequired: true });

    const wrongReplica = reduceTranscriptEvent(bound, {
      type: "delta",
      agentId: AGENT_ID,
      entryId: "assistant-1",
      fragment: "wrong-stream",
      ordered: order(2, "transcript:agent-a:entry:another-entry"),
    });
    expect(wrongReplica).toMatchObject({ action: "resync", reason: "replica-mismatch", resyncRequired: true });
  });

  it("accepts an unordered appended baseline without inventing a cursor", () => {
    const state = apply(createTranscriptClientState(AGENT_ID), {
      type: "appended",
      agentId: AGENT_ID,
      entry: assistant(),
    });
    expect(state.entries).toHaveLength(1);
    expect(state.cursors.size).toBe(0);
  });

  it("requires a fresh authoritative snapshot after reconnect and accepts a fresh epoch", () => {
    let state = createTranscriptClientState(AGENT_ID);
    state = apply(state, {
      type: "appended",
      agentId: AGENT_ID,
      entry: assistant(),
      ordered: order(1),
    });
    state = markTranscriptResync(state, "reconnect");
    const ignored = reduceTranscriptEvent(state, {
      type: "delta",
      agentId: AGENT_ID,
      entryId: "assistant-1",
      fragment: "not-replayed",
      ordered: order(2),
    });
    expect(ignored).toMatchObject({ action: "resync", reason: "reconnect", resyncRequired: true });

    state = apply(state, {
      type: "snapshot",
      agentId: AGENT_ID,
      activeAgentId: AGENT_ID,
      entries: [assistant("durable checkpoint")],
    });
    state = apply(state, {
      type: "delta",
      agentId: AGENT_ID,
      entryId: "assistant-1",
      fragment: " + live",
      ordered: order(1, REPLICA, "fresh-entry-epoch"),
    });
    expect(state.entries[0]).toMatchObject({ content: "durable checkpoint + live" });
    expect(state.status).toBe("ready");

    state = apply(state, {
      type: "updated",
      agentId: AGENT_ID,
      entry: assistant("durable checkpoint + live", false),
      ordered: order(2, REPLICA, "fresh-entry-epoch"),
      throughSequence: 1,
      final: true,
    });

    const lateDelta = reduceTranscriptEvent(state, {
      type: "delta",
      agentId: AGENT_ID,
      entryId: "assistant-1",
      fragment: "late",
      ordered: order(3, REPLICA, "fresh-entry-epoch"),
    });
    expect(lateDelta).toMatchObject({ action: "resync", reason: "delta-after-final", resyncRequired: true });
  });

  it("hydrates final assistant ids from an authoritative snapshot", () => {
    let state = apply(createTranscriptClientState(AGENT_ID), {
      type: "snapshot",
      agentId: AGENT_ID,
      activeAgentId: AGENT_ID,
      entries: [assistant("persisted", false)],
    });
    const lateDelta = reduceTranscriptEvent(state, {
      type: "delta",
      agentId: AGENT_ID,
      entryId: "assistant-1",
      fragment: "late",
      ordered: order(1),
    });
    expect(lateDelta).toMatchObject({ action: "resync", reason: "delta-after-final", resyncRequired: true });
    const lateUpdate = reduceTranscriptEvent(state, {
      type: "updated",
      agentId: AGENT_ID,
      entry: assistant("overwrite", false),
      ordered: order(1),
      throughSequence: 1,
      final: false,
    });
    expect(lateUpdate).toMatchObject({ action: "resync", reason: "updated-after-final", resyncRequired: true });
  });

  it("keeps conversation and final snapshot boundaries isolated", () => {
    let state = createTranscriptClientState(AGENT_ID, "conversation-a");
    const wrongConversation = reduceTranscriptEvent(state, {
      type: "snapshot",
      agentId: AGENT_ID,
      activeAgentId: AGENT_ID,
      conversationId: "conversation-b",
      entries: [assistant("wrong")],
    });
    expect(wrongConversation).toMatchObject({ action: "resync", reason: "cross-conversation" });

    state = apply(state, {
      type: "snapshot",
      agentId: AGENT_ID,
      activeAgentId: AGENT_ID,
      conversationId: "conversation-a",
      entries: [assistant("right", false)],
    });
    expect(state.entries[0]).toMatchObject({ content: "right", streaming: false });
  });

  it("does not let a stale or conflicting ordered snapshot overwrite the current state", () => {
    let state = createTranscriptClientState(AGENT_ID);
    state = apply(state, {
      type: "snapshot",
      agentId: AGENT_ID,
      activeAgentId: AGENT_ID,
      entries: [assistant("new")],
      ordered: order(5),
    });

    const stale = reduceTranscriptEvent(state, {
      type: "snapshot",
      agentId: AGENT_ID,
      activeAgentId: AGENT_ID,
      entries: [assistant("old")],
      ordered: order(4),
    });
    expect(stale).toMatchObject({ action: "resync", reason: "stale-snapshot", resyncRequired: true });
    expect(stale.state.entries[0]).toMatchObject({ content: "new" });

    const conflict = reduceTranscriptEvent(state, {
      type: "snapshot",
      agentId: AGENT_ID,
      activeAgentId: AGENT_ID,
      entries: [assistant("different")],
      ordered: order(5),
    });
    expect(conflict).toMatchObject({ action: "resync", reason: "conflicting-duplicate", resyncRequired: true });
    expect(conflict.state.entries[0]).toMatchObject({ content: "new" });
  });

  it("binds an initially unscoped state when a conversation first appears", () => {
    let state = apply(createTranscriptClientState(AGENT_ID), {
      type: "snapshot",
      agentId: AGENT_ID,
      activeAgentId: AGENT_ID,
      conversationId: "conversation-a",
      entries: [assistant("right")],
    });
    const missingScope = reduceTranscriptEvent(state, {
      type: "appended",
      agentId: AGENT_ID,
      entry: { kind: "notice", id: "unscoped", text: "wrong", level: "info" },
    });
    expect(missingScope).toMatchObject({ action: "resync", reason: "missing-conversation", resyncRequired: true });
    const wrongScope = reduceTranscriptEvent(state, {
      type: "appended",
      agentId: AGENT_ID,
      conversationId: "conversation-b",
      entry: { kind: "notice", id: "wrong-scope", text: "wrong", level: "info" },
    });
    expect(wrongScope).toMatchObject({ action: "resync", reason: "cross-conversation", resyncRequired: true });
    expect(state.conversationId).toBe("conversation-a");
  });

  it("accepts an ordered snapshot as the conversation switch boundary", () => {
    let state = apply(createTranscriptClientState(AGENT_ID, "conversation-a"), {
      type: "snapshot",
      agentId: AGENT_ID,
      activeAgentId: AGENT_ID,
      conversationId: "conversation-a",
      entries: [assistant("one")],
    });
    state = apply(state, {
      type: "snapshot",
      agentId: AGENT_ID,
      activeAgentId: AGENT_ID,
      conversationId: "conversation-b",
      entries: [assistant("two")],
      ordered: order(1, REPLICA, "epoch-b"),
    });
    expect(state).toMatchObject({ conversationId: "conversation-b", entries: [{ content: "two" }] });
  });
});
