import type {
  TranscriptEntry,
  TranscriptEventOrder,
  TranscriptEventPayload,
} from "./contracts.js";

const MAX_APPLIED_EVENTS = 4096;
const MAX_REPLICA_CURSORS = 128;
const MAX_DELTA_REPLICAS = 128;
const textEncoder = typeof TextEncoder === "function" ? new TextEncoder() : undefined;

export type TranscriptReducerStatus = "ready" | "resync-required";

export interface TranscriptReplicaCursor {
  readonly replicaKey: string;
  readonly epoch: string;
  /** Last transport event sequence accepted in this namespace. */
  readonly lastSequence: number;
  /** Last delta sequence represented by an authoritative updated snapshot. */
  readonly throughSequence: number;
}

export interface TranscriptClientState {
  readonly agentId: string;
  readonly conversationId?: string;
  readonly entries: readonly TranscriptEntry[];
  readonly status: TranscriptReducerStatus;
  readonly resyncReason?: string;
  readonly cursors: ReadonlyMap<string, TranscriptReplicaCursor>;
  /** Entry-to-stream binding prevents a fragment for one assistant being applied to another. */
  readonly deltaReplicas: ReadonlyMap<string, string>;
  /** Namespaces retired by an authoritative snapshot; late frames fail closed. */
  readonly retiredEpochs: ReadonlyMap<string, string>;
  /** Tuple fingerprint map; bounded so a malicious/replayed stream cannot grow it forever. */
  readonly applied: ReadonlyMap<string, string>;
  readonly finalEntryIds: ReadonlySet<string>;
  /** Unordered snapshots require the next fresh namespace event to begin at one. */
  readonly expectFirstOrderedSequence: boolean;
}

export type TranscriptReducerAction = "applied" | "duplicate" | "resync";

export interface TranscriptReduceResult {
  readonly state: TranscriptClientState;
  readonly action: TranscriptReducerAction;
  readonly resyncRequired: boolean;
  readonly reason?: string;
}

function cloneState(state: TranscriptClientState, patch: Partial<TranscriptClientState>): TranscriptClientState {
  return { ...state, ...patch };
}

function eventOrder(event: TranscriptEventPayload): TranscriptEventOrder | undefined {
  return "ordered" in event ? event.ordered : undefined;
}

function eventTuple(order: TranscriptEventOrder): string {
  return `${order.replicaKey}\u0000${order.epoch}\u0000${order.sequence}`;
}

function eventFingerprint(event: TranscriptEventPayload): string {
  // Event payloads are protocol JSON. A deterministic string is sufficient to
  // detect a conflicting reuse of the same dedupe tuple.
  return JSON.stringify(event);
}

function boundedMap<K, V>(source: ReadonlyMap<K, V>, max: number): Map<K, V> {
  const result = new Map(source);
  while (result.size > max) {
    const oldest = result.keys().next().value;
    if (oldest === undefined) break;
    result.delete(oldest);
  }
  return result;
}

function resync(state: TranscriptClientState, reason: string): TranscriptReduceResult {
  return {
    state: cloneState(state, { status: "resync-required", resyncReason: reason }),
    action: "resync",
    resyncRequired: true,
    reason,
  };
}

function withApplied(
  state: TranscriptClientState,
  event: TranscriptEventPayload,
  order: TranscriptEventOrder,
): { state: TranscriptClientState; duplicate: boolean } | TranscriptReduceResult {
  const tuple = eventTuple(order);
  const fingerprint = eventFingerprint(event);
  const existing = state.applied.get(tuple);
  if (existing !== undefined) {
    return existing === fingerprint
      ? { state, duplicate: true }
      : resync(state, "conflicting-duplicate");
  }

  const current = state.cursors.get(order.replicaKey);
  if (order.replicaKey !== `transcript:${state.agentId}`) return resync(state, "replica-mismatch");
  if (current !== undefined && current.epoch !== order.epoch) {
    return resync(state, "stale-epoch");
  }
  if (state.expectFirstOrderedSequence && order.sequence !== 1) {
    return resync(state, "initial-sequence-gap");
  }
  if (current !== undefined) {
    const expected = current.lastSequence + 1;
    if (order.sequence !== expected) {
      return resync(state, order.sequence > expected ? "sequence-gap" : "sequence-reorder");
    }
  } else if (order.sequence < 1) {
    return resync(state, "invalid-sequence");
  }

  const retiredEpoch = state.retiredEpochs.get(order.replicaKey);
  if (retiredEpoch !== undefined && retiredEpoch !== order.epoch) return resync(state, "stale-epoch");

  const applied = new Map(state.applied);
  applied.set(tuple, fingerprint);
  while (applied.size > MAX_APPLIED_EVENTS) {
    const oldest = applied.keys().next().value;
    if (oldest === undefined) break;
    applied.delete(oldest);
  }
  return { state: cloneState(state, { applied }), duplicate: false };
}

function commitCursor(
  state: TranscriptClientState,
  order: TranscriptEventOrder,
  throughSequence = order.sequence,
): TranscriptClientState {
  const cursors = boundedMap(state.cursors, MAX_REPLICA_CURSORS);
  cursors.delete(order.replicaKey);
  cursors.set(order.replicaKey, {
    replicaKey: order.replicaKey,
    epoch: order.epoch,
    lastSequence: order.sequence,
    throughSequence,
  });
  return cloneState(state, { cursors });
}

function replaceEntry(entries: readonly TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] | undefined {
  const id = typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id : undefined;
  if (id === undefined || id.length === 0) return undefined;
  const index = entries.findIndex((candidate) => (
    typeof (candidate as { id?: unknown }).id === "string" && (candidate as { id: string }).id === id
  ));
  if (index < 0) return undefined;
  const next = [...entries];
  next[index] = entry;
  return next;
}

function isAssistantMessage(entry: TranscriptEntry, id: string): entry is Extract<TranscriptEntry, { kind: "message" }> {
  return entry.kind === "message" && entry.id === id && entry.role === "assistant";
}

function finalAssistantIds(entries: readonly TranscriptEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "message" && entry.role === "assistant" && entry.streaming !== true && entry.isStreaming !== true
      && (entry.streaming === false || entry.isStreaming === false)) {
      ids.add(entry.id);
    }
  }
  return ids;
}

function byteLength(value: string): number {
  return textEncoder === undefined ? value.length : textEncoder.encode(value).byteLength;
}

export function createTranscriptClientState(agentId: string, conversationId?: string): TranscriptClientState {
  if (agentId.trim().length === 0) throw new Error("agentId is required");
  return {
    agentId,
    ...(conversationId === undefined ? {} : { conversationId }),
    entries: [],
    status: "ready",
    cursors: new Map(),
    deltaReplicas: new Map(),
    retiredEpochs: new Map(),
    applied: new Map(),
    finalEntryIds: new Set(),
    expectFirstOrderedSequence: false,
  };
}

/** Explicit reconnect hook: no live delta is replayed across reconnect. */
export function markTranscriptResync(state: TranscriptClientState, reason = "reconnect"): TranscriptClientState {
  return cloneState(state, { status: "resync-required", resyncReason: reason });
}

/**
 * Applies one typed transcript SSE event. A `resync` result is fail-closed:
 * callers must fetch an authoritative SQLite snapshot and feed it next.
 */
export function reduceTranscriptEvent(
  state: TranscriptClientState,
  event: TranscriptEventPayload,
): TranscriptReduceResult {
  if (event.agentId !== state.agentId) return resync(state, "cross-agent");
  if (event.conversationId !== undefined && (typeof event.conversationId !== "string" || event.conversationId.length === 0)) {
    return resync(state, "missing-conversation");
  }
  const orderedSnapshotSwitch = event.type === "snapshot" && "ordered" in event && event.ordered !== undefined;
  if (state.conversationId !== undefined) {
    if (event.conversationId === undefined) return resync(state, "missing-conversation");
    if (event.conversationId !== state.conversationId && !orderedSnapshotSwitch) return resync(state, "cross-conversation");
    if (event.conversationId !== state.conversationId && orderedSnapshotSwitch) {
      state = cloneState(state, {
        conversationId: event.conversationId,
        status: "ready",
        resyncReason: undefined,
        cursors: new Map(),
        deltaReplicas: new Map(),
        retiredEpochs: new Map(),
        applied: new Map(),
        finalEntryIds: new Set(),
        expectFirstOrderedSequence: false,
      });
    }
  } else if (event.conversationId !== undefined) {
    state = cloneState(state, { conversationId: event.conversationId });
  }
  if (state.status === "resync-required" && event.type !== "snapshot") {
    return resync(state, state.resyncReason ?? "resync-required");
  }

  if (event.type !== "snapshot" && "resyncRequired" in event && event.resyncRequired === true) {
    return resync(state, "server-resync");
  }

  if (event.type === "snapshot") {
    const order = event.ordered;
    if (order !== undefined && order.replicaKey !== `transcript:${state.agentId}`) {
      return resync(state, "replica-mismatch");
    }
    if (order !== undefined) {
      if (!Number.isSafeInteger(order.sequence) || order.sequence < 0) {
        return resync(state, "invalid-snapshot-sequence");
      }
      const tuple = eventTuple(order);
      const fingerprint = eventFingerprint(event);
      const known = state.applied.get(tuple);
      if (known !== undefined) {
        return known === fingerprint
          ? { state, action: "duplicate", resyncRequired: false }
          : resync(state, "conflicting-duplicate");
      }
      const current = state.cursors.get(order.replicaKey);
      if (current !== undefined) {
        if (current.epoch !== order.epoch) return resync(state, "stale-epoch");
        if (order.sequence < current.lastSequence) return resync(state, "stale-snapshot");
        if (order.sequence === current.lastSequence) return resync(state, "snapshot-conflict");
      }
      const retiredEpoch = state.retiredEpochs.get(order.replicaKey);
      if (retiredEpoch !== undefined && retiredEpoch !== order.epoch) return resync(state, "stale-epoch");
    }
    const retiredEpochs = order === undefined
      ? new Map<string, string>()
      : boundedMap(state.retiredEpochs, MAX_REPLICA_CURSORS);
    if (order !== undefined) {
      for (const [replicaKey, cursor] of state.cursors) retiredEpochs.set(replicaKey, cursor.epoch);
      retiredEpochs.delete(order.replicaKey);
    }
    const next = cloneState(state, {
      entries: [...event.entries],
      status: "ready",
      resyncReason: undefined,
      cursors: new Map(),
      deltaReplicas: new Map(),
      retiredEpochs,
      applied: new Map(),
      finalEntryIds: finalAssistantIds(event.entries),
      expectFirstOrderedSequence: order === undefined,
    });
    if (order !== undefined) {
      const applied = new Map<string, string>();
      applied.set(eventTuple(order), eventFingerprint(event));
      const withOrder = commitCursor(cloneState(next, { applied }), order, order.sequence);
      return { state: withOrder, action: "applied", resyncRequired: false };
    }
    return { state: next, action: "applied", resyncRequired: false };
  }

  const order = eventOrder(event);
  if (event.type === "appended" && order === undefined) {
    const id = typeof (event.entry as { id?: unknown }).id === "string" ? (event.entry as { id: string }).id : undefined;
    if (id === undefined || state.entries.some((entry) => (entry as { id?: unknown }).id === id)) return resync(state, "duplicate-entry");
    return {
      state: cloneState(state, { entries: [...state.entries, event.entry] }),
      action: "applied",
      resyncRequired: false,
    };
  }
  if (order === undefined || !Number.isSafeInteger(order.sequence) || order.sequence < 1) {
    return resync(state, "missing-order");
  }
  const prepared = withApplied(state, event, order);
  if ("action" in prepared) return prepared;
  if (prepared.duplicate) return { state, action: "duplicate", resyncRequired: false };
  let next = cloneState(prepared.state, { expectFirstOrderedSequence: false });

  if (event.type === "appended") {
    const id = typeof (event.entry as { id?: unknown }).id === "string" ? (event.entry as { id: string }).id : undefined;
    if (id === undefined || next.entries.some((entry) => (entry as { id?: unknown }).id === id)) return resync(state, "duplicate-entry");
    next = cloneState(next, { entries: [...next.entries, event.entry] });
  } else if (event.type === "delta") {
    if (next.finalEntryIds.has(event.entryId)) return resync(state, "delta-after-final");
    if (event.entryId.length === 0 || event.fragment.length === 0 || byteLength(event.fragment) > 16 * 1024) {
      return resync(state, "invalid-fragment");
    }
    const index = next.entries.findIndex((entry) => isAssistantMessage(entry, event.entryId));
    if (index < 0) return resync(state, "delta-entry-missing");
    const current = next.entries[index];
    if (current === undefined || !isAssistantMessage(current, event.entryId)) return resync(state, "delta-entry-invalid");
    const boundReplica = next.deltaReplicas.get(event.entryId);
    if (boundReplica !== undefined && boundReplica !== order.replicaKey) return resync(state, "delta-replica-mismatch");
    const deltaReplicas = new Map(next.deltaReplicas);
    deltaReplicas.set(event.entryId, order.replicaKey);
    while (deltaReplicas.size > MAX_DELTA_REPLICAS) {
      const oldest = deltaReplicas.keys().next().value;
      if (oldest === undefined) break;
      deltaReplicas.delete(oldest);
    }
    const entries = [...next.entries];
    entries[index] = { ...current, content: current.content + event.fragment, streaming: true, isStreaming: true };
    next = cloneState(next, { entries, deltaReplicas });
  } else {
    const throughSequence = event.throughSequence ?? order.sequence;
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0 || throughSequence > order.sequence) {
      return resync(state, "invalid-through-sequence");
    }
    const currentCursor = next.cursors.get(order.replicaKey);
    if (currentCursor !== undefined && throughSequence < currentCursor.throughSequence) {
      return resync(state, "stale-through-sequence");
    }
    const entryId = typeof (event.entry as { id?: unknown }).id === "string" ? (event.entry as { id: string }).id : undefined;
    if (entryId !== undefined && next.finalEntryIds.has(entryId)) return resync(state, "updated-after-final");
    const entries = replaceEntry(next.entries, event.entry);
    if (entries === undefined) return resync(state, "updated-entry-missing");
    const finalEntryIds = new Set(next.finalEntryIds);
    if (event.final === true) {
      const id = typeof (event.entry as { id?: unknown }).id === "string" ? (event.entry as { id: string }).id : undefined;
      if (id !== undefined) finalEntryIds.add(id);
    }
    next = cloneState(next, { entries, finalEntryIds });
    next = commitCursor(next, order, throughSequence);
    return { state: next, action: "applied", resyncRequired: false };
  }

  next = commitCursor(next, order, next.cursors.get(order.replicaKey)?.throughSequence ?? 0);
  return { state: next, action: "applied", resyncRequired: false };
}

export const applyTranscriptEvent = reduceTranscriptEvent;
