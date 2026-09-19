"use strict";

// First-party bridge for the immutable renderer contract. The backend may
// publish cheap ordered transcript.delta frames, while the active renderer
// only accepts appended/updated/snapshot. This adapter validates the ordered
// stream before emitting renderer-compatible updates.

const MAX_APPLIED_EVENTS = 4096;
const MAX_REPLICA_CURSORS = 128;
const MAX_DELTA_REPLICAS = 128;
const MAX_FRAGMENT_BYTES = 16 * 1024;
const MAX_RESYNC_BUFFERED_EVENTS = 256;
const MAX_RESYNC_BUFFERED_BYTES = 512 * 1024;

function eventOrder(payload) {
  return payload && typeof payload.ordered === "object" ? payload.ordered : undefined;
}

function tuple(order) {
  return `${order.replicaKey}\u0000${order.epoch}\u0000${order.sequence}`;
}

function fingerprint(payload) {
  return JSON.stringify(payload);
}

function boundedMap(source, maximum) {
  const result = new Map(source);
  while (result.size > maximum) {
    const oldest = result.keys().next().value;
    if (oldest === undefined) break;
    result.delete(oldest);
  }
  return result;
}

function isMessage(entry, id) {
  return entry && entry.kind === "message" && entry.id === id && entry.role === "assistant" && typeof entry.content === "string";
}

function finalAssistantIds(entries) {
  const ids = new Set();
  for (const entry of entries) {
    if (entry && entry.kind === "message" && entry.role === "assistant" && typeof entry.id === "string"
      && entry.streaming !== true && entry.isStreaming !== true
      && (entry.streaming === false || entry.isStreaming === false)) {
      ids.add(entry.id);
    }
  }
  return ids;
}

function createState(agentId) {
  return {
    agentId,
    conversationId: undefined,
    status: "ready",
    entries: [],
    cursors: new Map(),
    applied: new Map(),
    deltaReplicas: new Map(),
    finalEntryIds: new Set(),
    rendererEpoch: `openbot-renderer:${agentId}:0`,
    rendererGeneration: 0,
    rendererSequence: 0,
    pending: undefined,
    timer: undefined,
    bufferedEvents: [],
    bufferedBytes: 0,
    resyncEpoch: undefined,
    bufferOverflowed: false,
    expectFirstOrderedSequence: false,
  };
}

function conversationIdOf(payload) {
  if (!payload || typeof payload.conversationId !== "string" || payload.conversationId.length === 0) return undefined;
  return payload.conversationId;
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function projectTranscriptForRenderer(payload) {
  if (!payload || typeof payload !== "object") return payload;
  // The immutable renderer reserves fromUser for another human and will not
  // acknowledge its nonce. Keep OpenBot's local-user provenance in the backend.
  const localUserEntry = (entry) => {
    // Keep tool-call entries as non-rendered records. The immutable chat
    // renderer intentionally does not render them, so projecting them as
    // notices would turn every internal tool transition into transcript noise.
    // Do not carry execution results across the renderer boundary: they can
    // contain process output even though the entry itself is not rendered.
    if (entry?.kind === "tool-call") {
      const { result: _result, ...toolCall } = entry;
      return toolCall;
    }
    if (entry?.kind !== "message" || entry.role !== "user" || !entry.fromUser
      || entry.fromAgent || entry.toAgent || typeof entry.clientNonce !== "string") return entry;
    const { fromUser: _provenance, ...localUser } = entry;
    return localUser;
  };
  return { ...payload,
    ...(payload.entry ? { entry: localUserEntry(payload.entry) } : {}),
    ...(Array.isArray(payload.entries) ? { entries: payload.entries.map(localUserEntry) } : {}),
  };
}

function createTranscriptAdapter(options = {}) {
  const states = new Map();
  const emit = typeof options.onEmit === "function" ? options.onEmit : () => {};
  const onResync = typeof options.onResync === "function" ? options.onResync : () => {};
  const schedule = typeof options.schedule === "function" ? options.schedule : (callback) => setTimeout(callback, 100);
  const cancel = typeof options.cancel === "function" ? options.cancel : (handle) => clearTimeout(handle);
  const coalesce = options.coalesce === true;

  function getState(agentId) {
    let state = states.get(agentId);
    if (!state) {
      state = createState(agentId);
      states.set(agentId, state);
    }
    return state;
  }

  function clearPending(state) {
    if (state.timer !== undefined) cancel(state.timer);
    state.timer = undefined;
    state.pending = undefined;
  }

  function fail(state, payload, reason) {
    if (state.status === "resync-required") return "ignored";
    clearPending(state);
    state.bufferedEvents = [];
    state.bufferedBytes = 0;
    state.status = "resync-required";
    const request = {
      ...(payload && typeof payload === "object" ? payload : {}),
      agentId: state.agentId,
      resyncRequired: true,
      reason,
    };
    onResync(request);
    return "resync";
  }

  function commit(state, order, throughSequence) {
    const cursors = boundedMap(state.cursors, MAX_REPLICA_CURSORS);
    cursors.delete(order.replicaKey);
    cursors.set(order.replicaKey, {
      replicaKey: order.replicaKey,
      epoch: order.epoch,
      lastSequence: order.sequence,
      throughSequence: throughSequence ?? state.cursors.get(order.replicaKey)?.throughSequence ?? 0,
    });
    state.cursors = cursors;
  }

  function checkOrder(state, payload, allowSnapshot) {
    const order = eventOrder(payload);
    if (!order || typeof order.replicaKey !== "string" || order.replicaKey.length === 0
      || typeof order.epoch !== "string" || order.epoch.length === 0
      || !Number.isSafeInteger(order.sequence) || (allowSnapshot ? order.sequence < 0 : order.sequence < 1)) {
      return { error: "missing-order" };
    }
    const eventTuple = tuple(order);
    const known = state.applied.get(eventTuple);
    const currentFingerprint = fingerprint(payload);
    if (known !== undefined) return known === currentFingerprint ? { duplicate: true } : { error: "conflicting-duplicate" };
    if (order.replicaKey !== `transcript:${state.agentId}`) return { error: "replica-mismatch" };
    const current = state.cursors.get(order.replicaKey);
    if (current && current.epoch !== order.epoch) return { error: "stale-epoch" };
    if (state.expectFirstOrderedSequence && order.sequence !== 1) return { error: "initial-sequence-gap" };
    if (current) {
      const expected = current.lastSequence + 1;
      if (order.sequence !== expected) return { error: order.sequence > expected ? "sequence-gap" : "sequence-reorder" };
    }
    const applied = new Map(state.applied);
    applied.set(eventTuple, currentFingerprint);
    state.applied = boundedMap(applied, MAX_APPLIED_EVENTS);
    return { order };
  }

  function validateSnapshotOrder(state, payload) {
    const order = eventOrder(payload);
    if (!order) return { order: undefined };
    if (typeof order.replicaKey !== "string" || order.replicaKey.length === 0
      || typeof order.epoch !== "string" || order.epoch.length === 0
      || !Number.isSafeInteger(order.sequence) || order.sequence < 0) {
      return { error: "missing-order" };
    }
    if (order.replicaKey !== `transcript:${state.agentId}`) return { error: "replica-mismatch" };
    const key = tuple(order);
    const known = state.applied.get(key);
    const currentFingerprint = fingerprint(payload);
    if (known !== undefined) return known === currentFingerprint ? { duplicate: true } : { error: "conflicting-duplicate" };
    const current = state.cursors.get(order.replicaKey);
    if (current !== undefined) {
      if (current.epoch !== order.epoch) return { error: "stale-epoch" };
      if (order.sequence < current.lastSequence) return { error: "stale-snapshot" };
      if (order.sequence === current.lastSequence) return { error: "snapshot-conflict" };
    }
    return { order };
  }

  function flush(agentId) {
    const state = states.get(agentId);
    if (!state || state.pending === undefined) return false;
    const pending = state.pending;
    if (state.timer !== undefined) cancel(state.timer);
    state.timer = undefined;
    state.pending = undefined;
    if (state.status !== "resync-required") emitRenderer(state, pending);
    return true;
  }

  function emitRenderer(state, payload) {
    payload = projectTranscriptForRenderer(payload);
    if (payload.type === "snapshot") {
      // A snapshot is the reset boundary; the next ordered frame starts at 1.
      state.rendererSequence = 0;
      const { ordered: _ignored, ...snapshot } = payload;
      emit(snapshot);
      return;
    }
    state.rendererSequence += 1;
    const ordered = {
      replicaKey: `transcript:${state.agentId}`,
      epoch: state.rendererEpoch,
      sequence: state.rendererSequence,
    };
    emit({
      ...payload,
      ordered,
      ...(payload.type === "updated" ? { throughSequence: ordered.sequence } : {}),
    });
  }

  function queueDelta(state, payload, entry) {
    state.pending = {
      type: "updated",
      agentId: payload.agentId,
      ...(payload.conversationId === undefined ? {} : { conversationId: payload.conversationId }),
      entry,
      ordered: payload.ordered,
      throughSequence: payload.ordered.sequence,
      final: false,
    };
    if (!coalesce) {
      const pending = state.pending;
      state.pending = undefined;
      emitRenderer(state, pending);
      return;
    }
    if (state.timer === undefined) state.timer = schedule(() => flush(state.agentId));
  }

  function applySnapshot(payload, options = {}) {
    if (!payload || typeof payload.agentId !== "string" || !Array.isArray(payload.entries)) return "ignored";
    const state = getState(payload.agentId);
    const incomingConversationId = conversationIdOf(payload);
    const hasConversationField = Object.prototype.hasOwnProperty.call(payload, "conversationId");
    const allowConversationSwitch = options.allowConversationSwitch === true;
    if (hasConversationField && incomingConversationId === undefined && !allowConversationSwitch) return fail(state, payload, "missing-conversation");
    if (state.conversationId !== undefined
      && incomingConversationId !== state.conversationId
      && !allowConversationSwitch) return fail(state, payload, "cross-conversation");
    const conversationSwitch = state.conversationId !== undefined
      && incomingConversationId !== state.conversationId
      && allowConversationSwitch;
    const checked = validateSnapshotOrder(conversationSwitch
      ? { ...state, cursors: new Map(), applied: new Map() }
      : state, payload);
    if (checked.error) return fail(state, payload, checked.error);
    if (checked.duplicate) return "duplicate";
    const bufferedEvents = state.bufferedEvents;
    clearPending(state);
    state.status = "ready";
    state.conversationId = incomingConversationId;
    state.entries = [...payload.entries];
    state.cursors = new Map();
    state.applied = new Map();
    state.deltaReplicas = new Map();
    state.finalEntryIds = finalAssistantIds(payload.entries);
    state.expectFirstOrderedSequence = checked.order === undefined;
    state.bufferedEvents = [];
    state.bufferedBytes = 0;
    state.resyncEpoch = undefined;
    state.bufferOverflowed = false;
    state.rendererGeneration += 1;
    state.rendererEpoch = `openbot-renderer:${state.agentId}:${state.rendererGeneration}`;
    // An unordered reconnect snapshot intentionally forgets the old epoch;
    // the next live per-agent event establishes the current stream again.
    if (checked.order) {
      const applied = new Map(state.applied);
      applied.set(tuple(checked.order), fingerprint(payload));
      state.applied = boundedMap(applied, MAX_APPLIED_EVENTS);
      commit(state, checked.order, checked.order.sequence);
    }
    emitRenderer(state, payload);
    let replayFailed = false;
    for (const buffered of bufferedEvents) {
      const replay = accept(buffered);
      if (replay === "resync" || replay === "ignored") {
        replayFailed = true;
        break;
      }
    }
    return replayFailed ? "resync" : "applied";
  }

  function accept(payload) {
    if (!payload || typeof payload !== "object" || typeof payload.agentId !== "string" || payload.agentId.length === 0) return "ignored";
    if (payload.type === "snapshot") return applySnapshot(payload, { allowConversationSwitch: eventOrder(payload) !== undefined });
    const state = getState(payload.agentId);
    const incomingConversationId = conversationIdOf(payload);
    if (state.conversationId !== undefined && incomingConversationId !== state.conversationId) {
      return fail(state, payload, incomingConversationId === undefined ? "missing-conversation" : "cross-conversation");
    }
    if (state.conversationId === undefined && incomingConversationId !== undefined) state.conversationId = incomingConversationId;
    if (state.status === "resync-required") {
      if (payload.resyncRequired === true || eventOrder(payload) === undefined) return "ignored";
      const incomingConversationId = conversationIdOf(payload);
      if (state.conversationId !== undefined && incomingConversationId !== state.conversationId) return "ignored";
      const order = eventOrder(payload);
      if (state.resyncEpoch !== undefined && order.epoch === state.resyncEpoch) return "ignored";
      if (state.bufferOverflowed) return "ignored";
      const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      if (state.bufferedEvents.length >= MAX_RESYNC_BUFFERED_EVENTS
        || state.bufferedBytes + bytes > MAX_RESYNC_BUFFERED_BYTES) {
        if (!state.bufferOverflowed) {
          state.bufferOverflowed = true;
          state.bufferedEvents = [];
          state.bufferedBytes = 0;
          onResync({
            ...payload,
            agentId: state.agentId,
            resyncRequired: true,
            reason: "resync-buffer-overflow",
          });
          return "resync";
        }
        return "ignored";
      }
      state.bufferedEvents.push(payload);
      state.bufferedBytes += bytes;
      return "buffered";
    }
    if (payload.type !== "appended" && payload.type !== "delta" && payload.type !== "updated") return fail(state, payload, "unknown-transcript-event");

    if (payload.type === "appended" && !eventOrder(payload)) {
      const id = typeof payload.entry?.id === "string" ? payload.entry.id : undefined;
      if (!id || state.entries.some((entry) => entry && entry.id === id)) return fail(state, payload, "duplicate-entry");
      state.entries = [...state.entries, payload.entry];
      emitRenderer(state, payload);
      return "applied";
    }
    if (payload.resyncRequired === true) return fail(state, payload, "server-resync");

    const checked = checkOrder(state, payload, false);
    if (checked.error) return fail(state, payload, checked.error);
    if (checked.duplicate) return "duplicate";
    const order = checked.order;
    if (!order) return fail(state, payload, "missing-order");
    state.expectFirstOrderedSequence = false;

    if (payload.type === "appended") {
      const id = typeof payload.entry?.id === "string" ? payload.entry.id : undefined;
      if (!id) return fail(state, payload, "duplicate-entry");
      const existingIndex = state.entries.findIndex((entry) => entry && entry.id === id);
      if (existingIndex >= 0) {
        const existing = state.entries[existingIndex];
        if (fingerprint(existing) === fingerprint(payload.entry)) {
          commit(state, order, state.cursors.get(order.replicaKey)?.throughSequence ?? 0);
          return "applied";
        }
        // A reconnect may rebase an in-flight assistant after the durable
        // snapshot. Treat that single streaming append as an authoritative
        // replacement for already-connected clients; ordinary duplicates
        // remain fail-closed.
        if (!isMessage(existing, id) || !isMessage(payload.entry, id) || payload.entry.streaming !== true) {
          return fail(state, payload, "duplicate-entry");
        }
        flush(state.agentId);
        state.entries = [...state.entries];
        state.entries[existingIndex] = payload.entry;
        commit(state, order, state.cursors.get(order.replicaKey)?.throughSequence ?? 0);
        emitRenderer(state, { ...payload, type: "updated", entry: payload.entry, final: false });
        return "applied";
      }
      state.entries = [...state.entries, payload.entry];
      commit(state, order, state.cursors.get(order.replicaKey)?.throughSequence ?? 0);
      emitRenderer(state, payload);
      return "applied";
    }

    if (payload.type === "delta") {
      if (typeof payload.entryId !== "string" || payload.entryId.length === 0
        || typeof payload.fragment !== "string" || payload.fragment.length === 0
        || byteLength(payload.fragment) > MAX_FRAGMENT_BYTES) return fail(state, payload, "invalid-fragment");
      if (state.finalEntryIds.has(payload.entryId)) return fail(state, payload, "delta-after-final");
      const index = state.entries.findIndex((entry) => isMessage(entry, payload.entryId));
      if (index < 0) return fail(state, payload, "delta-entry-missing");
      const replica = state.deltaReplicas.get(payload.entryId);
      if (replica !== undefined && replica !== order.replicaKey) return fail(state, payload, "delta-replica-mismatch");
      const replicas = new Map(state.deltaReplicas);
      replicas.set(payload.entryId, order.replicaKey);
      state.deltaReplicas = boundedMap(replicas, MAX_DELTA_REPLICAS);
      const current = state.entries[index];
      const entry = { ...current, content: current.content + payload.fragment, streaming: true, isStreaming: true };
      state.entries = [...state.entries];
      state.entries[index] = entry;
      commit(state, order, state.cursors.get(order.replicaKey)?.throughSequence ?? 0);
      queueDelta(state, payload, entry);
      return "applied";
    }

    const throughSequence = payload.throughSequence ?? order.sequence;
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0 || throughSequence > order.sequence) return fail(state, payload, "invalid-through-sequence");
    const currentCursor = state.cursors.get(order.replicaKey);
    if (currentCursor && throughSequence < currentCursor.throughSequence) return fail(state, payload, "stale-through-sequence");
    const entryId = typeof payload.entry?.id === "string" ? payload.entry.id : undefined;
    if (!entryId || state.finalEntryIds.has(entryId)) return fail(state, payload, "updated-after-final");
    const index = state.entries.findIndex((entry) => entry && entry.id === entryId);
    if (index < 0) return fail(state, payload, "updated-entry-missing");
    flush(state.agentId);
    state.entries = [...state.entries];
    state.entries[index] = payload.entry;
    if (payload.final === true) state.finalEntryIds.add(entryId);
    commit(state, order, throughSequence);
    emitRenderer(state, payload);
    return "applied";
  }

  function markResync(payload, reason = "server-resync") {
    const agentId = typeof payload?.agentId === "string" ? payload.agentId : undefined;
    if (!agentId) return;
    const state = getState(agentId);
    clearPending(state);
    state.status = "resync-required";
    state.resyncReason = reason;
    state.resyncEpoch = state.cursors.get(`transcript:${state.agentId}`)?.epoch;
    state.bufferOverflowed = false;
    if (!Array.isArray(state.bufferedEvents)) {
      state.bufferedEvents = [];
      state.bufferedBytes = 0;
    }
  }

  function dispose() {
    for (const state of states.values()) clearPending(state);
    states.clear();
  }

  function disposeAgent(agentId) {
    const state = states.get(agentId);
    if (!state) return false;
    clearPending(state);
    states.delete(agentId);
    return true;
  }

  return { accept, flush, markResync, reset: applySnapshot, getState, disposeAgent, dispose };
}

function createTranscriptSnapshotGate() {
  const generations = new Map();
  let generationCounter = 0;
  function begin(agentId, conversationId) {
    const generation = ++generationCounter;
    generations.set(agentId, generation);
    return { agentId, conversationId, generation };
  }
  function isCurrent(request) {
    return request && generations.get(request.agentId) === request.generation;
  }
  function disposeAgent(agentId) {
    generations.delete(agentId);
  }
  return { begin, isCurrent, disposeAgent };
}

module.exports = { createTranscriptAdapter, createTranscriptSnapshotGate, projectTranscriptForRenderer };
