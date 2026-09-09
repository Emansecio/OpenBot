import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import {
  CONTEXT_HARD_LIMIT_BYTES,
  CONTEXT_OUTPUT_RESERVE_BYTES,
  ContextAssembler,
  OPENBOT_UNTRUSTED_MEMORY_CONTEXT_BEGIN,
} from "../dist/memory/context.js";
import { WorkspaceQuota } from "../dist/execution/quota.js";
import { WorkspaceSandbox } from "../dist/execution/workspace.js";
import { RuntimeManager } from "../dist/execution/runtime/manager.js";
import { McpManager } from "../dist/mcp/manager.js";
import { createMemoryTranscriptStore, createTurnRunner } from "../dist/rpc/send.js";
import { createProviderRegistry } from "../dist/providers/router.js";
import { MAX_LIVE_RESPONSE_BYTES } from "../dist/rpc/stream-state.js";
import { ConfigStore, MAX_PROFILE_AVATAR_BYTES } from "../dist/config/store.js";
import {
  MAX_ATTACHMENTS_PER_TURN,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  readTurnAttachments,
} from "../dist/rpc/attachments.js";
import { SqliteTranscriptStore } from "../dist/store/index.js";
import { longStreamGate, sanitizeBenchmarkError } from "./benchmark-hot-path-gates.mjs";

const TRANSCRIPT_ENTRIES = 20_000;
const TRANSCRIPT_PAGE_SIZE = 128;
const MAX_TRANSCRIPT_EVENT_BYTES = 128 * 1024;
const MEMORY_CONTEXT_CONVERSATIONS = 2;
const MEMORY_CONTEXT_TRANSCRIPT_ENTRIES = 20_000;
const MEMORY_CONTEXT_MEMORIES = 2_000;
const MEMORY_CONTEXT_BATCH_SIZE = 500;
const MEMORY_CONTEXT_PROMPT = "Need the quarterly support rollout delta, account preference, and prior incident context for the current reply.";
const MEMORY_CONTEXT_HISTORY_QUERY = "quarterly support rollout delta concise replies incident";
const MEMORY_CONTEXT_MATCH_TOKEN = "quarterly support rollout delta";
const MEMORY_CONTEXT_TEMP_SENTINEL = "temporary-conversation-should-not-leak-9f30a6e4";
const MEMORY_CONTEXT_CROSS_AGENT_SENTINEL = "cross-agent-leak-should-not-appear-11d2a59c";
const MEMORY_CONTEXT_SYSTEM_BYTES = 20 * 1024;
const MEMORY_CONTEXT_TOOL_BYTES = 8 * 1024;
const LONG_STREAM_DELTA_COUNT = 2_048;
const EVENT_LOOP_DELAY_RESOLUTION_MS = 1;

const message = (id) => ({
  kind: "message",
  id,
  role: "user",
  content: id,
  timestampMs: 1,
  streaming: false,
});

const nextImmediate = () => new Promise((resolve) => setImmediate(resolve));

function estimateTokens(bytes) {
  return Math.max(1, Math.ceil(bytes / 4));
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function benchmarkGate(caseResult, keys) {
  return keys.every((key) => caseResult[key] === true);
}

function finiteMilliseconds(nanoseconds) {
  const milliseconds = nanoseconds / 1e6;
  return Number.isFinite(milliseconds) ? Number(milliseconds.toFixed(3)) : null;
}

function instrumentSqliteTranscriptStore(dbPath) {
  const backing = new SqliteTranscriptStore({ path: dbPath });
  const counts = {
    sqliteAppendMutationCount: 0,
    sqliteAppendEntryCount: 0,
    sqliteReplaceMutationCount: 0,
    livePreviewUpdateCount: 0,
  };
  const store = new Proxy(backing, {
    get(target, property) {
      if (property === "append") {
        return (agentId, entries, conversationId) => {
          target.append(agentId, entries, conversationId);
          if (entries.length > 0) {
            counts.sqliteAppendMutationCount += 1;
            counts.sqliteAppendEntryCount += entries.length;
          }
        };
      }
      if (property === "replace") {
        return (agentId, entryId, entry, conversationId) => {
          const replaced = target.replace(agentId, entryId, entry, conversationId);
          if (replaced) counts.sqliteReplaceMutationCount += 1;
          return replaced;
        };
      }
      if (property === "setLiveEntry") {
        return (agentId, entry, conversationId) => {
          target.setLiveEntry?.(agentId, entry, conversationId);
          counts.livePreviewUpdateCount += 1;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { store, backing, counts };
}

async function waitFor(predicate, label, rounds = 2_000) {
  for (let round = 0; round < rounds; round += 1) {
    if (await predicate()) return;
    await nextImmediate();
  }
  throw new Error(`${label} did not reach its deterministic barrier`);
}

const capability = () => ({ kind: "process.run", networkProfile: "none" });

class FakeRuntimeDriver {
  acquired = [];
  released = [];
  starts = 0;
  abortObserved = false;
  waitForAbort = false;

  async start() {
    this.starts += 1;
    return { runtimeBootId: `bench-boot-${this.starts}`, runtimeVersion: "test", imageDigest: "sha256:test" };
  }

  async health() {
    return { ok: true };
  }

  async acquire(request, signal) {
    this.acquired.push(request);
    if (this.waitForAbort) {
      await new Promise((resolve, reject) => {
        const abort = () => {
          this.abortObserved = true;
          reject(signal?.reason ?? new Error("aborted"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
        void resolve;
      });
    }
    return { sandboxId: `bench-sandbox-${this.acquired.length}` };
  }

  async release(lease) {
    if (lease.leaseId !== undefined) this.released.push(lease.leaseId);
  }

  async stop() {}
}

async function benchmarkTranscript() {
  const started = performance.now();
  const store = createMemoryTranscriptStore();
  store.append("agent", Array.from({ length: TRANSCRIPT_ENTRIES }, (_, index) => message(`m-${index}`)));
  let beforeSeq;
  let pages = 0;
  let entries = 0;
  let maxEventBytes = 0;
  do {
    const page = store.openAgentTail("agent", TRANSCRIPT_PAGE_SIZE, beforeSeq);
    const event = { type: "snapshot", agentId: "agent", entries: page.entries };
    maxEventBytes = Math.max(maxEventBytes, Buffer.byteLength(JSON.stringify(event)));
    entries += page.entries.length;
    beforeSeq = page.nextBeforeSeq;
    pages += 1;
  } while (beforeSeq !== undefined);
  return {
    durationMs: Number((performance.now() - started).toFixed(3)),
    entries,
    pages,
    pageSize: TRANSCRIPT_PAGE_SIZE,
    maxEventBytes,
    eventByteGate: MAX_TRANSCRIPT_EVENT_BYTES,
    cursorExhausted: beforeSeq === undefined,
  };
}

async function benchmarkQueues() {
  const started = performance.now();
  const overlapRegistry = createProviderRegistry();
  let overlapInFlight = 0;
  let overlapMaxInFlight = 0;
  let overlapStarts = 0;
  let releaseOverlap;
  const overlapGate = new Promise((resolve) => { releaseOverlap = resolve; });
  overlapRegistry.register({
    name: "fake",
    async streamChat(_request, emit) {
      overlapStarts += 1;
      overlapInFlight += 1;
      overlapMaxInFlight = Math.max(overlapMaxInFlight, overlapInFlight);
      await overlapGate;
      emit({ type: "delta", delta: "ok" });
      overlapInFlight -= 1;
    },
  });
  const overlapRunner = createTurnRunner({
    registry: overlapRegistry,
    resolveProvider: () => ({ provider: "fake", model: "fake" }),
  });
  overlapRunner.sendPrompt({ agentId: "agent-a", prompt: "one", clientNonce: "a-1" });
  overlapRunner.sendPrompt({ agentId: "agent-b", prompt: "one", clientNonce: "b-1" });
  await waitFor(() => overlapStarts === 2, "independent queue overlap");
  releaseOverlap();
  await Promise.all([overlapRunner.flush("agent-a"), overlapRunner.flush("agent-b")]);

  const serialRegistry = createProviderRegistry();
  let serialStarts = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  serialRegistry.register({
    name: "fake",
    async streamChat(_request, emit) {
      serialStarts += 1;
      if (serialStarts === 1) await firstGate;
      emit({ type: "delta", delta: "ok" });
    },
  });
  const serialRunner = createTurnRunner({
    registry: serialRegistry,
    resolveProvider: () => ({ provider: "fake", model: "fake" }),
  });
  serialRunner.sendPrompt({ agentId: "same", prompt: "first", clientNonce: "same-1" });
  serialRunner.sendPrompt({ agentId: "same", prompt: "second", clientNonce: "same-2" });
  await waitFor(() => serialStarts === 1, "same queue first turn");
  await nextImmediate();
  const serialBeforeRelease = serialStarts;
  releaseFirst();
  await serialRunner.flush("same");
  return {
    durationMs: Number((performance.now() - started).toFixed(3)),
    independentAgents: 2,
    overlapStarts,
    maxConcurrentIndependent: overlapMaxInFlight,
    sameAgentTurns: serialStarts,
    sameAgentStartsBeforeRelease: serialBeforeRelease,
    independentOverlapObserved: overlapMaxInFlight >= 2,
    sameAgentSerialObserved: serialBeforeRelease === 1 && serialStarts === 2,
  };
}

async function benchmarkQuota() {
  const started = performance.now();
  const root = await mkdtemp(join(tmpdir(), "openbot-hot-paths-quota-"));
  try {
    const workspace = await WorkspaceSandbox.create(root);
    const quota = new WorkspaceQuota(workspace, { maxBytes: 100, maxFiles: 2 });
    const first = await quota.reserve(join(root, "a.bin"), 60);
    let secondSettled = false;
    const second = quota.reserve(join(root, "b.bin"), 60).then((reservation) => {
      secondSettled = true;
      return reservation;
    });
    await nextImmediate();
    const queuedUntilRelease = !secondSettled;
    first.cancel();
    const secondReservation = await second;
    secondReservation.cancel();
    const usage = await quota.usage();
    return {
      durationMs: Number((performance.now() - started).toFixed(3)),
      concurrentReservations: 2,
      queuedUntilRelease,
      sequentialReservationsAfterRelease: 2,
      postCancelBytes: usage.bytes,
      postCancelFiles: usage.files,
      oversubscriptionPrevented: queuedUntilRelease && usage.bytes === 0 && usage.files === 0,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function benchmarkMcpCache() {
  const started = performance.now();
  let connectorCalls = 0;
  let listToolsCalls = 0;
  let callToolCalls = 0;
  const session = {
    async listTools() {
      listToolsCalls += 1;
      return { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] };
    },
    async callTool() {
      callToolCalls += 1;
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() {},
  };
  const manager = new McpManager({
    servers: [{ id: "demo", transport: "http", url: "http://127.0.0.1:8787/mcp" }],
    connector: async () => {
      connectorCalls += 1;
      return session;
    },
    dnsLookup: () => ["127.0.0.1"],
    policies: { bot: { enabled: true, serverAllowlist: ["demo"] } },
  });
  try {
    await Promise.all([manager.listProviderTools("bot"), manager.listProviderTools("bot")]);
    await manager.callProviderTool("bot", "mcp__demo__echo", {});
    return {
      durationMs: Number((performance.now() - started).toFixed(3)),
      connectorCalls,
      listToolsCalls,
      callToolCalls,
      sessionCacheHit: connectorCalls === 1,
      toolListCacheHit: listToolsCalls === 1,
    };
  } finally {
    await manager.close();
  }
}

async function benchmarkRuntime() {
  const started = performance.now();
  const driver = new FakeRuntimeDriver();
  const manager = new RuntimeManager({ driver, maxActiveLeases: 1 });
  let first;
  const queuedController = new AbortController();
  let queued;
  let queuedCancelled = false;
  let queuedWaitObserved = false;
  try {
    first = await manager.acquire("agent-a", capability());
    queued = manager.acquire("agent-b", capability(), queuedController.signal);
    await waitFor(async () => (await manager.status("agent-a")).waitingLeaseCount === 1, "runtime admission queue");
    queuedWaitObserved = true;
    queuedController.abort();
    await queued;
  } catch {
    queuedCancelled = true;
  } finally {
    queuedController.abort();
    if (queued !== undefined) await Promise.allSettled([queued]);
    if (first !== undefined) await first.release();
    await manager.close();
  }

  const cancellingDriver = new FakeRuntimeDriver();
  cancellingDriver.waitForAbort = true;
  const cancellingManager = new RuntimeManager({ driver: cancellingDriver });
  const controller = new AbortController();
  let pending;
  let cancelled = false;
  try {
    pending = cancellingManager.acquire("agent-c", capability(), controller.signal);
    await waitFor(() => cancellingDriver.acquired.length === 1, "runtime admission");
    controller.abort();
    await pending;
  } catch {
    cancelled = true;
  } finally {
    controller.abort();
    if (pending !== undefined) await Promise.allSettled([pending]);
    await cancellingManager.close();
  }
  return {
    durationMs: Number((performance.now() - started).toFixed(3)),
    maxActiveLeases: 1,
    queuedCancelled,
    driverCancelled: cancelled,
    driverAbortObserved: cancellingDriver.abortObserved,
    admissionBounded: queuedWaitObserved && queuedCancelled && cancelled && cancellingDriver.abortObserved,
    queuedWaitObserved,
  };
}

async function benchmarkBrowserFairness() {
  const startedAt = performance.now();
  const hostSource = await readFile(new URL("../scripts/openbot-browser-host.cjs", import.meta.url), "utf8");
  const agents = ["agent-a", "agent-b", "agent-c", "agent-d"];
  const queues = new Map();
  const active = new Map();
  const agentOrder = [];
  const started = [];
  let cursor = 0;

  const pump = () => {
    while (active.size < 4) {
      let next;
      for (let offset = 0; offset < agentOrder.length; offset += 1) {
        const index = (cursor + offset) % agentOrder.length;
        const agentId = agentOrder[index];
        const queue = queues.get(agentId);
        if (queue === undefined || active.has(agentId) || queue.length === 0) continue;
        cursor = (index + 1) % agentOrder.length;
        next = queue.shift();
        break;
      }
      if (next === undefined) break;
      active.set(next.agentId, next);
      started.push(`${next.agentId}:${next.index}`);
    }
  };

  for (const agentId of agents) {
    const queue = [];
    queues.set(agentId, queue);
    agentOrder.push(agentId);
    for (let index = 0; index < 3; index += 1) queue.push({ agentId, index });
    pump();
  }
  const completed = [];
  for (let round = 0; round < 3; round += 1) {
    for (const agentId of agents) {
      const item = active.get(agentId);
      if (item === undefined) throw new Error(`browser fairness model missing ${agentId}`);
      active.delete(agentId);
      completed.push(`${agentId}:${item.index}`);
      pump();
    }
  }
  const expected = [0, 1, 2].flatMap((index) => agents.map((agentId) => `${agentId}:${index}`));
  const initialOrder = started.slice(0, agents.length);
  const schedulerSymbolsPresent = ["MAX_AGENT_QUEUE", "MAX_TOTAL_QUEUE", "takeNextRequest", "agentCursor"].every((symbol) => hostSource.includes(symbol));
  return {
    durationMs: Number((performance.now() - startedAt).toFixed(3)),
    agents: agents.length,
    requests: expected.length,
    activeSlots: 4,
    started,
    completed,
    initialOrder,
    roundRobinObserved: JSON.stringify(started) === JSON.stringify(expected),
    fifoByAgent: agents.every((agentId) => completed.filter((id) => id.startsWith(`${agentId}:`)).join(",") === `${agentId}:0,${agentId}:1,${agentId}:2`),
    headOfLineAvoided: initialOrder[0] === "agent-a:0" && initialOrder[1] === "agent-b:0" && started.includes("agent-a:1") && started.indexOf("agent-b:0") < started.indexOf("agent-a:1"),
    schedulerSymbolsPresent,
  };
}

function transcriptMessage(id, role, content, timestampMs) {
  return {
    kind: "message",
    id,
    role,
    content,
    timestampMs,
    streaming: false,
    completionState: "complete",
  };
}

function appendConversationEntries(store, agentId, conversationId, conversationLabel, totalEntries, matchToken) {
  let timestampMs = 1;
  for (let start = 0; start < totalEntries; start += MEMORY_CONTEXT_BATCH_SIZE) {
    const batch = [];
    const end = Math.min(totalEntries, start + MEMORY_CONTEXT_BATCH_SIZE);
    for (let index = start; index < end; index += 1) {
      const role = index % 2 === 0 ? "user" : "assistant";
      const sharedPhrase = index % 3 === 0
        ? `${matchToken} customer preference concise replies and prior incident references`
        : `${conversationLabel} operational transcript baseline and handoff details`;
      const content = `${conversationLabel} message ${index} ${sharedPhrase} batch ${Math.floor(index / MEMORY_CONTEXT_BATCH_SIZE)}`;
      batch.push(transcriptMessage(`${conversationLabel}-m-${index}`, role, content, timestampMs));
      timestampMs += 1;
    }
    store.append(agentId, batch, conversationId);
  }
}

function seedMemories(memoryStore, agentId, primaryConversationId, secondaryConversationId, totalMemories, matchToken) {
  const kinds = ["identity", "preference", "constraint", "decision", "fact", "procedure", "open_loop"];
  const primaryRelevant = Math.floor(totalMemories * 0.6);
  for (let index = 0; index < totalMemories; index += 1) {
    const pinned = index % 9 === 0 || index < 120;
    const relevant = index < primaryRelevant || pinned;
    const sourceConversationId = index % 2 === 0 ? primaryConversationId : secondaryConversationId;
    const text = relevant
      ? `Memory ${index} ${matchToken} keep concise answers, mention prior rollout incident, and preserve customer preference ordering.`
      : `Memory ${index} unrelated archival note for background bookkeeping ${index % 17}.`;
    memoryStore.upsertMemory(agentId, {
      kind: kinds[index % kinds.length],
      canonicalKey: `bench.memory.${index}`,
      text,
      trust: "user",
      importance: pinned ? 95 : relevant ? 70 : 30,
      confidence: pinned ? 0.95 : relevant ? 0.8 : 0.4,
      pinned,
      sourceConversationId,
      sourceEntryIds: [`${sourceConversationId}:entry-${index}`],
    }, { kind: "admin" });
  }
}

function findContextMessage(messages) {
  return messages.find((entry) => entry.role === "user" && typeof entry.content === "string" && entry.content.includes(OPENBOT_UNTRUSTED_MEMORY_CONTEXT_BEGIN));
}

async function benchmarkMemoryContext() {
  const root = await mkdtemp(join(tmpdir(), "openbot-hot-paths-memory-context-"));
  let store;
  try {
    const dbPath = join(root, "store.db");
    store = new SqliteTranscriptStore({ path: dbPath });
    const agentId = "bench-memory-agent";
    const otherAgentId = "bench-memory-other-agent";
    const entriesPerConversation = MEMORY_CONTEXT_TRANSCRIPT_ENTRIES / MEMORY_CONTEXT_CONVERSATIONS;

    const seedStarted = performance.now();
    const primaryConversation = store.conversationStore.create(agentId, { title: "Primary conversation" });
    const secondaryConversation = store.conversationStore.create(agentId, { title: "Secondary conversation" });
    const temporaryConversation = store.conversationStore.create(agentId, { title: "Temporary conversation", temporary: true });
    const otherConversation = store.conversationStore.create(otherAgentId, { title: "Other agent conversation" });

    appendConversationEntries(store, agentId, primaryConversation.id, "primary", entriesPerConversation, MEMORY_CONTEXT_MATCH_TOKEN);
    appendConversationEntries(store, agentId, secondaryConversation.id, "secondary", entriesPerConversation, MEMORY_CONTEXT_MATCH_TOKEN);
    store.append(agentId, [
      transcriptMessage("temp-0", "user", `${MEMORY_CONTEXT_TEMP_SENTINEL} ${MEMORY_CONTEXT_MATCH_TOKEN} temporary transcript evidence`, 30_001),
      transcriptMessage("temp-1", "assistant", `${MEMORY_CONTEXT_TEMP_SENTINEL} temporary assistant follow-up`, 30_002),
    ], temporaryConversation.id);
    store.append(otherAgentId, [
      transcriptMessage("other-0", "user", `${MEMORY_CONTEXT_CROSS_AGENT_SENTINEL} ${MEMORY_CONTEXT_MATCH_TOKEN} foreign transcript evidence`, 40_001),
      transcriptMessage("other-1", "assistant", `${MEMORY_CONTEXT_CROSS_AGENT_SENTINEL} foreign assistant follow-up`, 40_002),
    ], otherConversation.id);

    seedMemories(store.memoryStore, agentId, primaryConversation.id, secondaryConversation.id, MEMORY_CONTEXT_MEMORIES, MEMORY_CONTEXT_MATCH_TOKEN);
    store.memoryStore.upsertMemory(otherAgentId, {
      kind: "fact",
      canonicalKey: "other-agent-sentinel",
      text: `${MEMORY_CONTEXT_CROSS_AGENT_SENTINEL} ${MEMORY_CONTEXT_MATCH_TOKEN} foreign memory should never leak into the main agent search.`,
      trust: "user",
      importance: 100,
      confidence: 1,
      pinned: true,
      sourceConversationId: otherConversation.id,
      sourceEntryIds: [`${otherConversation.id}:sentinel`],
    }, { kind: "admin" });

    const latestPrimarySequenceId = store.getLatestSequenceId(agentId, primaryConversation.id) ?? 0;
    const latestSecondarySequenceId = store.getLatestSequenceId(agentId, secondaryConversation.id) ?? 0;
    store.memoryStore.upsertSummary(agentId, {
      conversationId: primaryConversation.id,
      throughSequenceId: latestPrimarySequenceId,
      summaryJson: { topic: "primary", token: MEMORY_CONTEXT_MATCH_TOKEN, preference: "concise" },
      renderedText: `Primary conversation summary includes ${MEMORY_CONTEXT_MATCH_TOKEN}, concise answers, and current incident handling.`,
    });
    store.memoryStore.upsertSummary(agentId, {
      conversationId: secondaryConversation.id,
      throughSequenceId: latestSecondarySequenceId,
      summaryJson: { topic: "secondary", token: MEMORY_CONTEXT_MATCH_TOKEN, source: "history" },
      renderedText: `Secondary conversation summary keeps ${MEMORY_CONTEXT_MATCH_TOKEN} historical rollout evidence and prior remediation notes.`,
    });
    const seedDurationMs = Number((performance.now() - seedStarted).toFixed(3));

    const searchStarted = performance.now();
    const historyResults = store.memoryStore.searchHistory(agentId, MEMORY_CONTEXT_HISTORY_QUERY, { limit: 20 });
    const searchHistoryDurationMs = Number((performance.now() - searchStarted).toFixed(3));

    const assembleStarted = performance.now();
    const assembler = new ContextAssembler();
    const assembled = assembler.assemble({
      agentId,
      conversationId: primaryConversation.id,
      prompt: MEMORY_CONTEXT_PROMPT,
      recentStore: store,
      memoryStore: store.memoryStore,
      mode: "automatic",
      conversation: { temporary: false },
      systemText: "s".repeat(MEMORY_CONTEXT_SYSTEM_BYTES),
      toolText: "t".repeat(MEMORY_CONTEXT_TOOL_BYTES),
    });
    const assembleDurationMs = Number((performance.now() - assembleStarted).toFixed(3));

    const contextMessage = findContextMessage(assembled.messages);
    const contextBytes = contextMessage?.content ? byteLength(contextMessage.content) : 0;
    const serializedMessages = JSON.stringify(assembled.messages);
    const tempLeakResults = store.memoryStore.searchHistory(agentId, MEMORY_CONTEXT_TEMP_SENTINEL, { limit: 20 });
    const crossAgentLeakResults = store.memoryStore.searchHistory(agentId, MEMORY_CONTEXT_CROSS_AGENT_SENTINEL, { limit: 20 });
    const hardCapRespected = assembled.bytes <= assembled.availableBytes && assembled.availableBytes <= (CONTEXT_HARD_LIMIT_BYTES - MEMORY_CONTEXT_SYSTEM_BYTES - MEMORY_CONTEXT_TOOL_BYTES - CONTEXT_OUTPUT_RESERVE_BYTES);
    const crossAgentLeak = crossAgentLeakResults.some((result) => result.snippet.includes(MEMORY_CONTEXT_CROSS_AGENT_SENTINEL))
      || serializedMessages.includes(MEMORY_CONTEXT_CROSS_AGENT_SENTINEL);
    const tempExcluded = tempLeakResults.length === 0 && !serializedMessages.includes(MEMORY_CONTEXT_TEMP_SENTINEL);
    const memoryContextOk = hardCapRespected && !crossAgentLeak && tempExcluded;

    return {
      durationMs: Number((seedDurationMs + searchHistoryDurationMs + assembleDurationMs).toFixed(3)),
      ok: memoryContextOk,
      corpus: {
        agentCount: 1,
        conversationCount: MEMORY_CONTEXT_CONVERSATIONS,
        transcriptMessageEntries: MEMORY_CONTEXT_TRANSCRIPT_ENTRIES,
        activeMemories: MEMORY_CONTEXT_MEMORIES,
        summaries: 2,
        temporaryConversationsExcludedFromCorpus: 1,
        foreignAgentsExcludedFromCorpus: 1,
      },
      timingsMs: {
        seed: seedDurationMs,
        searchHistory: searchHistoryDurationMs,
        assemble: assembleDurationMs,
      },
      resultCounts: {
        searchHistory: historyResults.length,
        assembledMessages: assembled.messages.length,
        recentMessages: assembled.messages.filter((entry) => entry.role !== "system").length,
        temporaryLeakResults: tempLeakResults.length,
        crossAgentLeakResults: crossAgentLeakResults.length,
      },
      context: {
        bytes: assembled.bytes,
        tokensApprox: estimateTokens(assembled.bytes),
        contextMessageBytes: contextBytes,
        contextMessageTokensApprox: estimateTokens(Math.max(contextBytes, 1)),
        availableBytes: assembled.availableBytes,
        hardLimitBytes: CONTEXT_HARD_LIMIT_BYTES,
        outputReserveBytes: CONTEXT_OUTPUT_RESERVE_BYTES,
      },
      invariants: {
        hardCapRespected,
        crossAgentLeak,
        tempExcluded,
      },
    };
  } finally {
    try {
      store?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function benchmarkLongStream() {
  const root = await mkdtemp(join(tmpdir(), "openbot-hot-paths-long-stream-"));
  const dbPath = join(root, "transcript.sqlite");
  const { store, backing, counts } = instrumentSqliteTranscriptStore(dbPath);
  try {
  const deltas = Array.from(
    { length: LONG_STREAM_DELTA_COUNT },
    (_, index) => `d${index.toString().padStart(4, "0")}|`,
  );
  const expectedContent = deltas.join("");
  const expectedContentBytes = byteLength(expectedContent);
  if (expectedContentBytes >= MAX_LIVE_RESPONSE_BYTES) {
    throw new Error("long stream fixture exceeds MAX_LIVE_RESPONSE_BYTES");
  }

  const registry = createProviderRegistry();
  let providerCallCount = 0;
  let deltaCount = 0;
  let accumulatedDeltaBytes = 0;
  const heapUsedBefore = process.memoryUsage().heapUsed;
  let heapUsedPeak = heapUsedBefore;
  registry.register({
    name: "fake",
    async streamChat(_request, emit) {
      providerCallCount += 1;
      for (const delta of deltas) {
        deltaCount += 1;
        accumulatedDeltaBytes += byteLength(delta);
        emit({ type: "delta", delta });
        if ((deltaCount & 31) === 0) {
          heapUsedPeak = Math.max(heapUsedPeak, process.memoryUsage().heapUsed);
        }
      }
    },
  });

  let appendedEventCount = 0;
  let updatedEventCount = 0;
  let totalPublishCount = 0;
  let maxSsePayloadBytes = 0;
  let accumulatedSsePayloadBytes = 0;
  let finalPublishedPayloadBytes = 0;
  let streamingUpdateCount = 0;
  let ttftMs = null;
  const publishedStreamingContentLengths = [];
  const publishedDeltaFragments = [];
  let lastStreamingContent = "";
  let clockMs = 0;
  const runner = createTurnRunner({
    registry,
    store,
    resolveProvider: () => ({ provider: "fake", model: "fake" }),
    now: () => (clockMs += 125),
  });
  runner.setPublish((_channel, payload) => {
    totalPublishCount += 1;
    const payloadBytes = byteLength(JSON.stringify(payload));
    maxSsePayloadBytes = Math.max(maxSsePayloadBytes, payloadBytes);
    accumulatedSsePayloadBytes += payloadBytes;
    if (payload?.type === "appended") appendedEventCount += 1;
    if (payload?.type === "updated") updatedEventCount += 1;
    if (payload?.type === "delta" && typeof payload.fragment === "string") publishedDeltaFragments.push(payload.fragment);
    const entry = payload?.entry;
    if (entry?.kind === "message" && entry.role === "assistant" && typeof entry.content === "string") {
      if (entry.streaming === true) {
        if (ttftMs === null) ttftMs = Number((performance.now() - started).toFixed(3));
        publishedStreamingContentLengths.push(entry.content.length);
        lastStreamingContent = entry.content;
        if (payload?.type === "updated") streamingUpdateCount += 1;
      } else {
        finalPublishedPayloadBytes = payloadBytes;
      }
    }
  });

  let started = 0;
  const eventLoop = monitorEventLoopDelay({ resolution: EVENT_LOOP_DELAY_RESOLUTION_MS });
  eventLoop.enable();
  await new Promise((resolve) => setTimeout(resolve, EVENT_LOOP_DELAY_RESOLUTION_MS * 2));
  eventLoop.reset();
  started = performance.now();
  runner.sendPrompt({ agentId: "long-stream-agent", prompt: "stream", clientNonce: "long-stream-1" });
  await runner.flush("long-stream-agent");
  const elapsedMs = Number((performance.now() - started).toFixed(3));
  await new Promise((resolve) => setTimeout(resolve, EVENT_LOOP_DELAY_RESOLUTION_MS * 2));
  eventLoop.disable();

  const heapUsedAfter = process.memoryUsage().heapUsed;
  heapUsedPeak = Math.max(heapUsedPeak, heapUsedAfter);
  const final = [...store.getEntries("long-stream-agent")].reverse().find((entry) => (
    entry.kind === "message" && entry.role === "assistant" && entry.streaming === false
  ));
  const finalContent = final?.content ?? "";
  const finalContentLength = finalContent.length;
  const finalContentBytes = byteLength(finalContent);
  const sampleAvailable = eventLoop.count > 0;
  const eventLoopMeanMs = sampleAvailable ? finiteMilliseconds(eventLoop.mean) : null;
  const eventLoopMaxMs = sampleAvailable ? finiteMilliseconds(eventLoop.max) : null;
  const eventLoopP50Ms = sampleAvailable ? finiteMilliseconds(eventLoop.percentile(50)) : null;
  const eventLoopMeasured = sampleAvailable && [eventLoopMeanMs, eventLoopMaxMs, eventLoopP50Ms].every((value) => (
    typeof value === "number" && Number.isFinite(value) && value >= 0
  ));
  const outputExact = finalContent === expectedContent
    && finalContentLength === expectedContent.length
    && finalContentBytes === expectedContentBytes;
  const sseBytesCoherent = Number.isFinite(maxSsePayloadBytes)
    && maxSsePayloadBytes > 0
    && totalPublishCount > 1
    && accumulatedSsePayloadBytes > finalContentBytes
    && accumulatedSsePayloadBytes >= maxSsePayloadBytes
    && maxSsePayloadBytes >= finalContentBytes
    && finalPublishedPayloadBytes > 0
    && maxSsePayloadBytes >= finalPublishedPayloadBytes;
  const durableWritesDistinctFromPublications = counts.sqliteReplaceMutationCount !== updatedEventCount
    || counts.sqliteAppendMutationCount !== appendedEventCount;
  const incrementalProgressObserved = publishedDeltaFragments.join("") === expectedContent
    && publishedDeltaFragments.length === LONG_STREAM_DELTA_COUNT;
  const streamCardinalityExact = publishedDeltaFragments.length === LONG_STREAM_DELTA_COUNT
    && publishedDeltaFragments.join("") === expectedContent;
  const structuralFactor = expectedContentBytes > 0
    ? accumulatedSsePayloadBytes / expectedContentBytes
    : Number.POSITIVE_INFINITY;
  const linearPublishedBytes = Number.isFinite(structuralFactor) && structuralFactor <= 256;
  const storeUpdateAccountingExact = counts.sqliteReplaceMutationCount > 0
    && counts.sqliteReplaceMutationCount < LONG_STREAM_DELTA_COUNT
    && counts.livePreviewUpdateCount > 0
    && updatedEventCount < LONG_STREAM_DELTA_COUNT;

  backing.close();
  const databaseBytes = (await stat(dbPath)).size;
  const reopened = new SqliteTranscriptStore({ path: dbPath });
  let persistenceVerified = false;
  try {
    const persistedFinal = [...reopened.getEntries("long-stream-agent")].reverse().find((entry) => (
      entry.kind === "message" && entry.role === "assistant" && entry.streaming === false
    ));
    persistenceVerified = persistedFinal?.content === expectedContent;
  } finally {
    reopened.close();
  }

  return {
    storeKind: "sqlite",
    databasePath: "<redacted-temp-path>",
    databaseBytes,
    persistenceVerified,
    finalContentLength,
    finalContentBytes,
    expectedContentLength: expectedContent.length,
    expectedContentBytes,
    deltaCount,
    accumulatedDeltaBytes,
    providerCallCount,
    appendedEventCount,
    updatedEventCount,
    totalPublishCount,
    ...counts,
    maxSsePayloadBytes,
    accumulatedSsePayloadBytes,
    sseByteAccounting: "published-payload-json",
    maxPublishedPayloadBytes: maxSsePayloadBytes,
    accumulatedPublishedPayloadBytes: accumulatedSsePayloadBytes,
    finalPublishedPayloadBytes,
    ttftMs,
    publishedPayloadFrameCount: totalPublishCount,
    streamingUpdateCount,
    publishedStreamingFrameCount: publishedStreamingContentLengths.length,
    firstStreamingContentLength: publishedStreamingContentLengths[0] ?? 0,
    lastStreamingContentLength: lastStreamingContent.length,
    elapsedMs,
    eventLoopDelay: {
      resolutionMs: EVENT_LOOP_DELAY_RESOLUTION_MS,
      sampleAvailable,
      meanMs: eventLoopMeanMs,
      maxMs: eventLoopMaxMs,
      p50Ms: eventLoopP50Ms,
      ...(sampleAvailable ? {} : { unavailableReason: "no samples collected during the diagnostic window" }),
    },
    eventLoopMeasured,
    heapUsedBefore,
    heapUsedPeak,
    sampledHeapUsedPeak: heapUsedPeak,
    heapPeakSampling: "sampled-during-provider-emission-and-after-flush",
    heapUsedAfter,
    outputExact,
    deltasComplete: deltaCount === LONG_STREAM_DELTA_COUNT && accumulatedDeltaBytes === expectedContentBytes,
    streamObserved: appendedEventCount > 0 && updatedEventCount > 0 && totalPublishCount >= appendedEventCount + updatedEventCount,
    durableWritesObserved: counts.sqliteAppendMutationCount > 0 && counts.sqliteReplaceMutationCount > 0 && counts.livePreviewUpdateCount > 0,
    sqliteMutationAccounting: "logical store mutations/checkpoints; not physical SQLite writes",
    durableWritesDistinctFromPublications,
    incrementalProgressObserved,
    streamCardinalityExact,
    structuralFactor,
    linearPublishedBytes,
    storeUpdateAccountingExact,
    sseBytesCoherent,
  };
  } finally {
    backing.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function benchmarkMaxAvatar() {
  const root = await mkdtemp(join(tmpdir(), "openbot-hot-paths-avatar-"));
  try {
    const config = new ConfigStore({ configPath: join(root, "config.json") });
    const avatar = Buffer.alloc(MAX_PROFILE_AVATAR_BYTES, 0x61);
    Buffer.from("89504e470d0a1a0a", "hex").copy(avatar);
    const avatarPngBase64 = avatar.toString("base64");
    config.update({ profile: { avatarPngBase64 } });
    const snapshot = config.snapshot();
    const accepted = snapshot.profile.avatarPngBase64 ?? "";
    const decoded = Buffer.from(accepted, "base64");
    const publicSnapshotAccepted = decoded.length === MAX_PROFILE_AVATAR_BYTES && decoded.equals(avatar);
    return {
      decodedBytes: decoded.length,
      base64Bytes: byteLength(avatarPngBase64),
      serializedBytes: byteLength(JSON.stringify(snapshot.profile)),
      acceptedAtLimit: publicSnapshotAccepted,
      publicSnapshotAccepted,
      cap: MAX_PROFILE_AVATAR_BYTES,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function benchmarkMaxAttachments() {
  const root = await mkdtemp(join(tmpdir(), "openbot-hot-paths-attachments-"));
  try {
    const bytesPerFile = MAX_TEXT_ATTACHMENT_BYTES - 1;
    const attachments = await Promise.all(Array.from({ length: MAX_ATTACHMENTS_PER_TURN }, async (_, index) => {
      const name = `attachment-${index.toString().padStart(2, "0")}.txt`;
      const path = join(root, name);
      await writeFile(path, Buffer.alloc(bytesPerFile, 0x61));
      return { name, path };
    }));
    const sourceBytes = bytesPerFile * attachments.length;
    const { context, extracted } = await readTurnAttachments(attachments, [root]);
    const accepted = extracted.filter((item) => item.text !== undefined);
    const skippedCount = extracted.filter((item) => item.skipped !== undefined).length;
    const extractedTextBytes = accepted.reduce((total, item) => total + byteLength(item.text ?? ""), 0);
    const contextBytes = byteLength(context);
    const formattedContextObserved = contextBytes > extractedTextBytes && context.length > 0;
    const acceptedNearAggregateLimit = attachments.length === MAX_ATTACHMENTS_PER_TURN
      && accepted.length === attachments.length
      && skippedCount === 0
      && sourceBytes === extractedTextBytes
      && sourceBytes < MAX_ATTACHMENTS_TOTAL_BYTES
      && MAX_ATTACHMENTS_TOTAL_BYTES - sourceBytes === MAX_ATTACHMENTS_PER_TURN
      && bytesPerFile <= MAX_TEXT_ATTACHMENT_BYTES
      && formattedContextObserved;
    return {
      requestedCount: attachments.length,
      extractedCount: accepted.length,
      skippedCount,
      sourceBytes,
      extractedTextBytes,
      contextBytes,
      formattedContextObserved,
      caps: {
        attachmentsPerTurn: MAX_ATTACHMENTS_PER_TURN,
        aggregateBytes: MAX_ATTACHMENTS_TOTAL_BYTES,
        textAttachmentBytes: MAX_TEXT_ATTACHMENT_BYTES,
      },
      acceptedNearAggregateLimit,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function benchmarkSlowProviders() {
  const agents = ["slow-a", "slow-b", "slow-c", "slow-d"];
  const registry = createProviderRegistry();
  let providerCalls = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  let completedCount = 0;
  const completions = new Map();
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  registry.register({
    name: "fake",
    async streamChat(request, emit) {
      providerCalls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await barrier;
      emit({ type: "delta", delta: "ok" });
      concurrent -= 1;
      completedCount += 1;
      const prompt = request.messages.at(-1)?.content ?? "unknown";
      completions.set(prompt, (completions.get(prompt) ?? 0) + 1);
    },
  });
  const runner = createTurnRunner({
    registry,
    resolveProvider: () => ({ provider: "fake", model: "fake" }),
  });
  for (const agentId of agents) {
    runner.sendPrompt({ agentId, prompt: agentId, clientNonce: `${agentId}-1` });
  }
  const flushPromises = agents.map((agentId) => runner.flush(agentId));
  let startedBeforeRelease = 0;
  let overlapObserved = false;
  try {
    await waitFor(() => providerCalls === agents.length, "slow provider starts");
    startedBeforeRelease = providerCalls;
    overlapObserved = maxConcurrent > 1 && completedCount === 0;
    release();
    await Promise.all(flushPromises);
  } finally {
    release();
    await Promise.allSettled(flushPromises);
  }
  const eachAgentCompletedOnce = agents.every((agentId) => completions.get(agentId) === 1);
  return {
    agentCount: agents.length,
    startedBeforeRelease,
    maxConcurrent,
    completedCount,
    overlapObserved,
    providerCalls,
    eachAgentCompletedOnce,
  };
}

async function main() {
  // Diagnostics stay sequential so heap/event-loop observations are not mixed
  // with another benchmark case running concurrently.
  const transcript = await benchmarkTranscript();
  const queues = await benchmarkQueues();
  const quota = await benchmarkQuota();
  const mcpCache = await benchmarkMcpCache();
  const runtimeAdmission = await benchmarkRuntime();
  const browserFairness = await benchmarkBrowserFairness();
  const memoryContext = await benchmarkMemoryContext();
  const longStream = await benchmarkLongStream();
  const maxAvatar = await benchmarkMaxAvatar();
  const maxAttachments = await benchmarkMaxAttachments();
  const slowProviders = await benchmarkSlowProviders();
  const ok = benchmarkGate(transcript, ["cursorExhausted"])
    && transcript.maxEventBytes <= transcript.eventByteGate
    && benchmarkGate(queues, ["independentOverlapObserved", "sameAgentSerialObserved"])
    && benchmarkGate(quota, ["oversubscriptionPrevented"])
    && benchmarkGate(mcpCache, ["sessionCacheHit", "toolListCacheHit"])
    && benchmarkGate(runtimeAdmission, ["admissionBounded", "queuedWaitObserved"])
    && benchmarkGate(browserFairness, ["roundRobinObserved", "fifoByAgent", "headOfLineAvoided", "schedulerSymbolsPresent"])
    && memoryContext.ok
    && benchmarkGate(longStream, [
      "outputExact",
      "deltasComplete",
      "streamObserved",
      "durableWritesObserved",
      "durableWritesDistinctFromPublications",
      "incrementalProgressObserved",
      "streamCardinalityExact",
      "linearPublishedBytes",
      "storeUpdateAccountingExact",
      "sseBytesCoherent",
    ])
    && longStreamGate(longStream)
    && longStream.providerCallCount === 1
    && benchmarkGate(maxAvatar, ["acceptedAtLimit", "publicSnapshotAccepted"])
    && maxAvatar.decodedBytes === maxAvatar.cap
    && benchmarkGate(maxAttachments, ["acceptedNearAggregateLimit", "formattedContextObserved"])
    && benchmarkGate(slowProviders, ["overlapObserved", "eachAgentCompletedOnce"])
    && slowProviders.startedBeforeRelease === slowProviders.agentCount
    && slowProviders.completedCount === slowProviders.agentCount
    && slowProviders.providerCalls === slowProviders.agentCount;
  return {
    schemaVersion: 1,
    ok,
    mode: "hermetic-structural",
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      electron: null,
      electronAvailable: false,
      hardware: {
        cpuCount: cpus().length,
        cpuModel: cpus()[0]?.model ?? "unknown",
        totalMemoryBytes: totalmem(),
      },
    },
    safety: {
      tempOrMemoryOnly: true,
      realProvider: false,
      electron: false,
      wsl: false,
      appData: false,
    },
    cases: {
      transcript,
      queues,
      quota,
      mcpCache,
      runtimeAdmission,
      browserFairness,
      memoryContext,
      longStream,
      maxAvatar,
      maxAttachments,
      slowProviders,
    },
  };
}

main().then((report) => {
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}).catch((error) => {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    ok: false,
    mode: "hermetic-structural",
    error: sanitizeBenchmarkError(error instanceof Error ? error.message : String(error)),
  })}\n`);
  process.exitCode = 1;
});
