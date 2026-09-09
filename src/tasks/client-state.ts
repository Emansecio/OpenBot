/**
 * P2.2 — pure client state machine for the async-task / subagent projection
 * channels.
 *
 * Consumes the first-party NativeAsyncTaskProjectionEvent frames (SQLite
 * authority behind the gateway) and maintains a closed local state per
 * channel with:
 *   - initial snapshot: replaces the whole local list;
 *   - monotonic updates: only an event with the same epoch and a strictly
 *     greater sequence advances the local cursor; the matching item is
 *     upserted by `id` (never appended blindly);
 *   - deduplication: identical epoch/sequence or lower sequence is ignored;
 *   - cursor stale / gap / cursor-ahead / epoch mismatch: flagged as requiring
 *     an authoritative resync from SQLite (the client replaces its list on the
 *     next snapshot instead of merging);
 *   - resync: a snapshot after any mismatch replaces the local state, so
 *     snapshots are never concatenated and duplicate task identities never
 *     appear.
 *
 * This module is pure and framework-free; the renderer overlay and tests share
 * its semantics.
 */
import type {
  NativeAsyncTaskClientCursor,
  NativeAsyncTaskClientState,
  NativeAsyncTaskClientStateTransition,
  NativeAsyncTaskProjectionChannel,
  NativeAsyncTaskProjectionEvent,
  NativeAsyncTaskProjectionItem,
} from "../shared/contracts.js";

export interface CreateNativeAsyncTaskClientStateOptions {
  readonly agentId: string;
  readonly channel: NativeAsyncTaskProjectionChannel;
  readonly epoch?: string;
  readonly sequence?: number;
}

export function createNativeAsyncTaskClientState(options: CreateNativeAsyncTaskClientStateOptions): NativeAsyncTaskClientState {
  return {
    agentId: options.agentId,
    channel: options.channel,
    items: [],
    epoch: options.epoch ?? null,
    sequence: options.sequence ?? 0,
    eventsApplied: 0,
    resyncRequired: false,
  };
}

function itemsOf(event: NativeAsyncTaskProjectionEvent): readonly NativeAsyncTaskProjectionItem[] {
  if (event.channel === "async-tasks") return event.tasks ?? [];
  return event.subagents ?? [];
}

function upsertById(items: readonly NativeAsyncTaskProjectionItem[], upsert: NativeAsyncTaskProjectionItem): NativeAsyncTaskProjectionItem[] {
  const index = items.findIndex((item) => item.id === upsert.id);
  if (index >= 0) {
    const copy = [...items];
    copy[index] = upsert;
    return copy;
  }
  const copy = [...items, upsert];
  copy.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return copy;
}

function uniqueIds(items: readonly NativeAsyncTaskProjectionItem[]): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

/**
 * Applies one frame to the channel state. Returns the next state plus a
 * transition summary. A frame belonging to another agent/channel is ignored.
 */
export function applyNativeAsyncTaskClientEvent(
  state: NativeAsyncTaskClientState,
  event: NativeAsyncTaskProjectionEvent,
): NativeAsyncTaskClientStateTransition {
  if (event.agentId !== state.agentId || event.channel !== state.channel) {
    return { state, handled: false, resyncRequired: state.resyncRequired, reason: "wrong-scope" };
  }
  const type = event.type;
  if (type !== "snapshot" && type !== "update" && type !== "resync") {
    return { state, handled: false, resyncRequired: state.resyncRequired, reason: "unknown-type" };
  }
  const epoch = event.epoch ?? state.epoch ?? null;
  const sequence = event.sequence ?? state.sequence + 1;

  // A pure resync marker never carries items: it only tells the client that
  // the next authoritative snapshot must replace the local list.
  if (type === "resync") {
    return {
      state: { ...state, epoch: epoch ?? state.epoch, sequence: Math.max(state.sequence, sequence), resyncRequired: true, eventsApplied: state.eventsApplied + 1 },
      handled: true,
      resyncRequired: true,
      reason: event.reason ?? "resync",
    };
  }

  if (type === "snapshot") {
    // Snapshots are always authoritative: they REPLACE the whole local list
    // (never concatenate). The resyncRequired flag on a snapshot tells the
    // client that its previous cursor was stale; the replacement is still the
    // SQLite truth. An older/equal snapshot is deduplicated and ignored.
    if (state.epoch === epoch && sequence <= state.sequence) {
      return { state, handled: false, resyncRequired: state.resyncRequired, reason: "dedupe" };
    }
    const items = itemsOf(event);
    const next: NativeAsyncTaskClientState = {
      agentId: state.agentId,
      channel: state.channel,
      items: [...items],
      epoch,
      sequence: Math.max(state.sequence, sequence),
      eventsApplied: state.eventsApplied + 1,
      resyncRequired: false,
    };
    return { state: next, handled: true, resyncRequired: false, reason: uniqueIds(items) ? "snapshot" : "snapshot-duplicate" };
  }

  // update
  if (state.epoch !== null && epoch !== state.epoch) {
    return { state, handled: false, resyncRequired: true, reason: "epoch-mismatch" };
  }
  if (state.epoch === epoch && sequence <= state.sequence) {
    return { state, handled: false, resyncRequired: state.resyncRequired, reason: "stale-or-duplicate" };
  }
  const gap = state.epoch === epoch && sequence > state.sequence + 1;
  const items = itemsOf(event);
  if (items.length > 1) {
    // An update must carry a single item; a multi-item frame is treated as a
    // snapshot to stay authoritative.
    const next: NativeAsyncTaskClientState = {
      agentId: state.agentId,
      channel: state.channel,
      items: [...items],
      epoch: state.epoch ?? epoch,
      sequence,
      eventsApplied: state.eventsApplied + 1,
      resyncRequired: gap,
    };
    return { state: next, handled: true, resyncRequired: gap, reason: gap ? "update-gap" : "update-batch" };
  }
  const single = items[0];
  if (single === undefined) {
    // Tombstone-style empty update: keep the cursor, no duplicates.
    const next: NativeAsyncTaskClientState = { ...state, sequence, eventsApplied: state.eventsApplied + 1, resyncRequired: gap };
    return { state: next, handled: true, resyncRequired: gap, reason: gap ? "update-gap" : "update-empty" };
  }
  const nextItems = upsertById(state.items, single);
  const next: NativeAsyncTaskClientState = {
    agentId: state.agentId,
    channel: state.channel,
    items: nextItems,
    epoch: state.epoch ?? epoch,
    sequence,
    eventsApplied: state.eventsApplied + 1,
    resyncRequired: gap,
  };
  return { state: next, handled: true, resyncRequired: gap, reason: gap ? "update-gap" : "update" };
}

/** Convenience cursor for Last-Event-ID reconnects. */
export function toNativeAsyncTaskClientCursor(state: NativeAsyncTaskClientState): NativeAsyncTaskClientCursor | null {
  if (state.epoch === null) return null;
  return { channel: state.channel, epoch: state.epoch, sequence: state.sequence };
}

export function nativeAsyncTaskClientEventId(cursor: NativeAsyncTaskClientCursor): string {
  return `${cursor.channel}:${cursor.epoch}:${cursor.sequence}`;
}
