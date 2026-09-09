import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough, Writable } from "node:stream";

import type { Tool } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { WorkspaceQuota } from "../src/execution/quota.js";
import { WorkspaceSandbox } from "../src/execution/workspace.js";
import {
  RuntimeManager,
  type RuntimeDriver,
  type RuntimeLeaseRequest,
} from "../src/execution/runtime/manager.js";
import type {
  RuntimeBoot,
  RuntimeCapability,
  RuntimeDriverLease,
  RuntimeHealth,
} from "../src/execution/runtime/contracts.js";
import { McpManager, type McpClientSession } from "../src/mcp/manager.js";
import type { McpHttpServerConfig } from "../src/mcp/contracts.js";
import { BrowserSessionManager, type BrowserHostProcess } from "../src/browser/browser-session-manager.js";
import { encodeBrowserFrame, type BrowserHostRequest } from "../src/browser/protocol.js";
import {
  createMemoryTranscriptStore,
  createTurnRunner,
  type TranscriptStore,
} from "../src/rpc/send.js";
import { createProviderRegistry, type ProviderAdapter } from "../src/providers/router.js";
import { MAX_LIVE_RESPONSE_BYTES } from "../src/rpc/stream-state.js";
import { ConfigStore, MAX_PROFILE_AVATAR_BYTES } from "../src/config/store.js";
import {
  MAX_ATTACHMENTS_PER_TURN,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  readTurnAttachments,
} from "../src/rpc/attachments.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { longStreamGate, sanitizeBenchmarkError } from "../scripts/benchmark-hot-path-gates.mjs";

const TRANSCRIPT_ENTRIES = 20_000;
const TRANSCRIPT_PAGE_SIZE = 128;
const MAX_TRANSCRIPT_EVENT_BYTES = 128 * 1024;

const message = (id: string, content = id) => ({
  kind: "message" as const,
  id,
  role: "user" as const,
  content,
  timestampMs: 1,
  streaming: false,
});

const nextImmediate = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string, rounds = 2_000): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    if (await predicate()) return;
    await nextImmediate();
  }
  throw new Error(`${label} did not reach its deterministic barrier`);
};

const capability = (): RuntimeCapability => ({ kind: "process.run", networkProfile: "none" });

class FakeRuntimeDriver implements RuntimeDriver {
  readonly acquired: RuntimeLeaseRequest[] = [];
  readonly released: string[] = [];
  starts = 0;
  stops = 0;
  abortObserved = false;
  waitForAbort = false;

  async start(): Promise<RuntimeBoot> {
    this.starts += 1;
    return { runtimeBootId: `bench-boot-${this.starts}`, runtimeVersion: "test", imageDigest: "sha256:test" };
  }

  async health(): Promise<RuntimeHealth> {
    return { ok: true };
  }

  async acquire(request: RuntimeLeaseRequest, signal?: AbortSignal): Promise<RuntimeDriverLease> {
    this.acquired.push(request);
    if (this.waitForAbort) {
      await new Promise<void>((resolve, reject) => {
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

  async release(lease: RuntimeDriverLease): Promise<void> {
    if (lease.leaseId !== undefined) this.released.push(lease.leaseId);
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }
}

type ScheduledBrowserRequest = { request: BrowserHostRequest; released: boolean };

/** In-process equivalent of the host scheduler; no Electron or network is started. */
class FairBrowserHost implements BrowserHostProcess {
  readonly stdout = new PassThrough();
  readonly started: string[] = [];
  readonly completed: string[] = [];
  private readonly queues = new Map<string, ScheduledBrowserRequest[]>();
  private readonly active = new Map<string, ScheduledBrowserRequest>();
  private readonly agentOrder: string[] = [];
  private agentCursor = 0;
  private activeCount = 0;
  private readonly maxActive = 4;
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      const request = JSON.parse(chunk.toString()) as BrowserHostRequest;
      const command = request.command.command;
      if (command === "close") {
        this.respond(request);
        callback();
        return;
      }
      let queue = this.queues.get(request.agentId);
      if (queue === undefined) {
        queue = [];
        this.queues.set(request.agentId, queue);
        this.agentOrder.push(request.agentId);
      }
      queue.push({ request, released: false });
      this.pump();
      callback();
    },
  });

  constructor() {
    queueMicrotask(() => this.stdout.write(encodeBrowserFrame({ protocolVersion: 1, kind: "ready", hostVersion: "fair-test" })));
  }

  releaseNext(agentId: string): void {
    const pending = this.active.get(agentId);
    if (pending === undefined || pending.released) throw new Error(`no active browser request for ${agentId}`);
    pending.released = true;
    this.active.delete(agentId);
    this.activeCount -= 1;
    const key = `${agentId}:${this.commandIndex(pending.request)}`;
    this.completed.push(key);
    this.respond(pending.request);
    this.pump();
  }

  kill(_signal?: NodeJS.Signals): void {
    for (const listener of this.exitListeners) listener(0, null);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }

  private commandIndex(request: BrowserHostRequest): string {
    const url = "url" in request.command && typeof request.command.url === "string" ? request.command.url : "";
    return url.split("/").pop() ?? request.id;
  }

  private respond(request: BrowserHostRequest): void {
    queueMicrotask(() => this.stdout.write(encodeBrowserFrame({
      protocolVersion: 1,
      kind: "response",
      id: request.id,
      ok: true,
      result: {
        command: request.command.command === "cancel" ? "cancel" : request.command.command,
        tabId: request.tabId,
        url: "url" in request.command && typeof request.command.url === "string" ? request.command.url : "https://example.com/",
        title: "test",
      },
    })));
  }

  private pump(): void {
    while (this.activeCount < this.maxActive) {
      const next = this.takeNext();
      if (next === undefined) return;
      this.active.set(next.request.agentId, next);
      this.activeCount += 1;
      this.started.push(`${next.request.agentId}:${this.commandIndex(next.request)}`);
    }
  }

  private takeNext(): ScheduledBrowserRequest | undefined {
    for (let offset = 0; offset < this.agentOrder.length; offset += 1) {
      const index = (this.agentCursor + offset) % this.agentOrder.length;
      const agentId = this.agentOrder[index];
      if (agentId === undefined) continue;
      const queue = this.queues.get(agentId);
      if (queue === undefined || this.active.has(agentId) || queue.length === 0) continue;
      this.agentCursor = (index + 1) % this.agentOrder.length;
      return queue.shift();
    }
    return undefined;
  }
}

const fakeBrowserProxy = {
  address: null,
  async start() { return { host: "127.0.0.1", port: 1, token: "test" }; },
  async close() {},
} as never;

describe("multi-bot structural performance gates", () => {
  it("fails the long-stream gate when durable SQLite evidence is incomplete", () => {
    const valid = {
      storeKind: "sqlite",
      databasePath: "<redacted-temp-path>",
      databaseBytes: 1,
      persistenceVerified: true,
      ttftMs: 0,
    };
    expect(longStreamGate(valid)).toBe(true);
    expect(longStreamGate({ ...valid, storeKind: "memory" })).toBe(false);
    expect(longStreamGate({ ...valid, databasePath: "/tmp/secret.sqlite" })).toBe(false);
    expect(longStreamGate({ ...valid, databaseBytes: 0 })).toBe(false);
    expect(longStreamGate({ ...valid, persistenceVerified: false })).toBe(false);
    expect(longStreamGate({ ...valid, ttftMs: null })).toBe(false);
    expect(sanitizeBenchmarkError(`failed at ${process.cwd()}\\tmp\\secret.sqlite`)).toBe("failed at <workspace>\\tmp\\secret.sqlite");
  });

  it("proves the benchmark long stream uses durable SQLite and survives reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-performance-long-stream-reopen-"));
    const dbPath = join(root, "transcript.sqlite");
    try {
      const store = new SqliteTranscriptStore({ path: dbPath });
      store.append("long-stream-agent", [message("durable", "persisted output")]);
      store.close();
      expect((await stat(dbPath)).size).toBeGreaterThan(0);

      const reopened = new SqliteTranscriptStore({ path: dbPath });
      try {
        expect(reopened.getEntries("long-stream-agent")).toEqual([
          expect.objectContaining({ id: "durable", content: "persisted output" }),
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("streams thousands of deterministic deltas with exact output and distinct durable writes", async () => {
    const deltaCount = 2_048;
    const deltas = Array.from({ length: deltaCount }, (_, index) => `d${index.toString().padStart(4, "0")}|`);
    const expected = deltas.join("");
    expect(Buffer.byteLength(expected, "utf8")).toBeLessThan(MAX_LIVE_RESPONSE_BYTES);

    const root = await mkdtemp(join(tmpdir(), "openbot-performance-durable-stream-"));
    const dbPath = join(root, "transcript.sqlite");
    const backingStore = new SqliteTranscriptStore({ path: dbPath });
    let backingClosed = false;
    try {
    const counts = { append: 0, replace: 0, live: 0 };
    const store = new Proxy(backingStore, {
      get(target, property) {
        if (property === "append") return (...args: Parameters<TranscriptStore["append"]>) => {
          counts.append += 1;
          return target.append(...args);
        };
        if (property === "replace") return (...args: Parameters<NonNullable<TranscriptStore["replace"]>>) => {
          counts.replace += 1;
          return target.replace(...args);
        };
        if (property === "setLiveEntry") return (...args: Parameters<NonNullable<TranscriptStore["setLiveEntry"]>>) => {
          counts.live += 1;
          return target.setLiveEntry(...args);
        };
        const value = target[property as keyof SqliteTranscriptStore];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as TranscriptStore;
    const registry = createProviderRegistry();
    let providerCalls = 0;
    registry.register({
      name: "fake",
      async streamChat(_request, emit) {
        providerCalls += 1;
        for (const delta of deltas) emit({ type: "delta", delta });
      },
    });
    let clock = 0;
    const published: unknown[] = [];
    const runner = createTurnRunner({
      registry,
      store,
      resolveProvider: () => ({ provider: "fake", model: "fake" }),
      now: () => (clock += 125),
    });
    runner.setPublish((_channel, payload) => published.push(payload));

    runner.sendPrompt({ agentId: "stream-agent", prompt: "stream", clientNonce: "stream-1" });
    await runner.flush("stream-agent");

    const final = [...store.getEntries("stream-agent")].reverse().find((entry) => (
      entry.kind === "message" && entry.role === "assistant" && entry.streaming === false
    ));
    const appendedEvents = published.filter((payload) => (payload as { type?: string }).type === "appended");
    const deltaEvents = published.filter((payload) => (payload as { type?: string }).type === "delta") as Array<{ type: "delta"; fragment: string; entryId: string; ordered: { replicaKey: string; epoch: string; sequence: number } }>;
    const updatedEvents = published.filter((payload) => (payload as { type?: string }).type === "updated");
    const publishedPayloadBytes = published.map((payload) => Buffer.byteLength(JSON.stringify(payload), "utf8"));
    const streamingContents = published.flatMap((payload) => {
      const entry = (payload as { entry?: { kind?: string; role?: string; streaming?: boolean; content?: string } }).entry;
      return entry?.kind === "message" && entry.role === "assistant" && entry.streaming === true && typeof entry.content === "string"
        ? [entry.content]
        : [];
    });
    const finalPublishedPayload = [...published].reverse().find((payload) => {
      const entry = (payload as { entry?: { kind?: string; role?: string; streaming?: boolean; content?: string } }).entry;
      return entry?.kind === "message" && entry.role === "assistant" && entry.streaming === false && entry.content === expected;
    });
    const finalContentBytes = Buffer.byteLength(expected, "utf8");
    const finalPublishedPayloadBytes = Buffer.byteLength(JSON.stringify(finalPublishedPayload ?? null), "utf8");
    expect(final).toMatchObject({ content: expected, streaming: false });
    expect(providerCalls).toBe(1);
    expect(appendedEvents.length).toBeGreaterThan(0);
    expect(deltaEvents).toHaveLength(deltaCount);
    expect(deltaEvents.map((event) => event.fragment).join("")).toBe(expected);
    expect(new Set(deltaEvents.map((event) => event.entryId)).size).toBe(1);
    expect(deltaEvents.every((event, index) => index === 0 || event.ordered.sequence > deltaEvents[index - 1]!.ordered.sequence)).toBe(true);
    expect(counts.append).toBeGreaterThan(0);
    expect(counts.replace).toBeGreaterThan(0);
    expect(counts.live).toBeGreaterThan(0);
    expect(counts.replace).toBeLessThan(deltaCount);
    expect(counts.live).toBeGreaterThan(0);
    expect(updatedEvents.length).toBeLessThan(deltaCount);
    expect(finalPublishedPayload).toBeDefined();
    expect(publishedPayloadBytes).toHaveLength(published.length);
    expect(publishedPayloadBytes.length).toBeGreaterThan(1);
    expect(publishedPayloadBytes.reduce((total, bytes) => total + bytes, 0)).toBeGreaterThan(finalContentBytes);
    expect(Math.max(...publishedPayloadBytes)).toBeGreaterThanOrEqual(finalContentBytes);
    expect(Math.max(...publishedPayloadBytes)).toBeGreaterThanOrEqual(finalPublishedPayloadBytes);
    backingStore.close();
    backingClosed = true;
    expect((await stat(dbPath)).size).toBeGreaterThan(0);
    const reopened = new SqliteTranscriptStore({ path: dbPath });
    try {
      const persistedFinal = [...reopened.getEntries("stream-agent")].reverse().find((entry) => (
        entry.kind === "message" && entry.role === "assistant" && entry.streaming === false
      ));
      expect(persistedFinal).toMatchObject({ content: expected, streaming: false });
    } finally {
      reopened.close();
    }
    } finally {
      if (!backingClosed) backingStore.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a PNG avatar with exactly the public byte cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-performance-avatar-"));
    try {
      const config = new ConfigStore({ configPath: join(root, "config.json") });
      const avatar = Buffer.alloc(MAX_PROFILE_AVATAR_BYTES, 0x61);
      Buffer.from("89504e470d0a1a0a", "hex").copy(avatar);
      const avatarPngBase64 = avatar.toString("base64");

      config.update({ profile: { avatarPngBase64 } });
      const accepted = config.snapshot().profile.avatarPngBase64;

      expect(Buffer.from(accepted ?? "", "base64")).toEqual(avatar);
      expect(Buffer.byteLength(avatarPngBase64, "utf8")).toBeGreaterThan(MAX_PROFILE_AVATAR_BYTES);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts sixteen real text attachments just below the aggregate cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-performance-attachments-"));
    try {
      const bytesPerFile = MAX_TEXT_ATTACHMENT_BYTES - 1;
      const attachments = await Promise.all(Array.from({ length: MAX_ATTACHMENTS_PER_TURN }, async (_, index) => {
        const name = `attachment-${index.toString().padStart(2, "0")}.txt`;
        const path = join(root, name);
        await writeFile(path, Buffer.alloc(bytesPerFile, 0x61));
        return { name, path };
      }));
      const sourceBytes = bytesPerFile * attachments.length;

      const result = await readTurnAttachments(attachments, [root]);
      const extractedTextBytes = result.extracted.reduce((total, item) => (
        total + Buffer.byteLength(item.text ?? "", "utf8")
      ), 0);

      expect(attachments).toHaveLength(MAX_ATTACHMENTS_PER_TURN);
      expect(sourceBytes).toBeLessThan(MAX_ATTACHMENTS_TOTAL_BYTES);
      expect(MAX_ATTACHMENTS_TOTAL_BYTES - sourceBytes).toBe(MAX_ATTACHMENTS_PER_TURN);
      expect(result.extracted).toHaveLength(MAX_ATTACHMENTS_PER_TURN);
      expect(result.extracted.filter((item) => item.skipped !== undefined)).toHaveLength(0);
      expect(extractedTextBytes).toBe(sourceBytes);
      expect(Buffer.byteLength(result.context, "utf8")).toBeGreaterThan(extractedTextBytes);
      expect(result.context).toContain("[[OPENBOT_UNTRUSTED_ATTACHMENT_BEGIN]]");
      expect(result.context).toContain("[[OPENBOT_UNTRUSTED_ATTACHMENT_END]]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("overlaps four slow fake providers across distinct agent queues", async () => {
    const agents = ["slow-a", "slow-b", "slow-c", "slow-d"];
    const registry = createProviderRegistry();
    let providerCalls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    let completed = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    registry.register({
      name: "fake",
      async streamChat(_request, emit) {
        providerCalls += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await barrier;
        emit({ type: "delta", delta: "ok" });
        concurrent -= 1;
        completed += 1;
      },
    });
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      resolveProvider: () => ({ provider: "fake", model: "fake" }),
    });
    for (const agentId of agents) {
      runner.sendPrompt({ agentId, prompt: "wait", clientNonce: `${agentId}-1` });
    }
    const flushPromises = agents.map((agentId) => runner.flush(agentId));
    try {
      await waitFor(() => providerCalls === agents.length, "slow provider starts");
      expect(providerCalls).toBe(agents.length);
      expect(completed).toBe(0);
      expect(maxConcurrent).toBe(agents.length);
      release();
      await Promise.all(flushPromises);

      expect(completed).toBe(agents.length);
      for (const agentId of agents) {
        expect(store.getEntries(agentId).filter((entry) => entry.kind === "message" && entry.role === "assistant")).toHaveLength(1);
      }
    } finally {
      release();
      await Promise.allSettled(flushPromises);
    }
  });

  it("keeps a large conversation delete plus reopen under 10 seconds", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-performance-delete-reopen-"));
    const dbPath = join(root, "store.db");
    const conversationCount = 24;
    const messagesPerConversation = 180;
    const memoriesPerConversation = 20;
    try {
      const first = new SqliteTranscriptStore({ path: dbPath });
      const agentId = "perf-agent";
      const target = first.conversationStore.ensureDefault(agentId);
      const allConversations = [target];
      for (let index = 0; index < conversationCount - 1; index += 1) {
        allConversations.push(first.conversationStore.create(agentId, { title: `Conv ${index}` }));
      }
      for (const [conversationIndex, conversation] of allConversations.entries()) {
        const entries = Array.from({ length: messagesPerConversation }, (_, messageIndex) => ({
          kind: "message" as const,
          id: `msg-${conversationIndex}-${messageIndex}`,
          role: messageIndex % 2 === 0 ? "user" as const : "assistant" as const,
          content: `conversation ${conversationIndex} token ${messageIndex}`,
          timestampMs: conversationIndex * messagesPerConversation + messageIndex + 1,
          streaming: false,
        }));
        first.append(agentId, entries, conversation.id);
        first.memoryStore.upsertSummary(agentId, {
          conversationId: conversation.id,
          throughSequenceId: messagesPerConversation,
          summaryJson: { conversationIndex },
          renderedText: `summary token ${conversationIndex}`,
        });
        for (let memoryIndex = 0; memoryIndex < memoriesPerConversation; memoryIndex += 1) {
          first.memoryStore.upsertMemory(agentId, {
            kind: "fact",
            canonicalKey: `memory-${conversationIndex}-${memoryIndex}`,
            text: `memory token ${conversationIndex}-${memoryIndex}`,
            trust: "verified_tool",
            sourceConversationId: conversation.id,
          }, { kind: "admin" });
        }
      }

      const startedAt = performance.now();
      first.conversationStore.delete(agentId, target.id, { memoryPolicy: "delete-derived" });
      first.close();
      const reopened = new SqliteTranscriptStore({ path: dbPath });
      try {
        const elapsedMs = performance.now() - startedAt;
        expect(elapsedMs).toBeLessThan(10_000);
        expect(reopened.conversationStore.list(agentId, { limit: conversationCount }).items.map((conversation) => conversation.id)).not.toContain(target.id);
        expect(reopened.memoryStore.searchHistory(agentId, "summary token 1").length).toBeGreaterThan(0);
        expect(reopened.memoryStore.searchMemories(agentId, "memory token 1-1").length).toBeGreaterThan(0);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("paginates a large transcript with a bounded event payload", () => {
    const store = createMemoryTranscriptStore();
    store.append("agent", Array.from({ length: TRANSCRIPT_ENTRIES }, (_, index) => message(`m-${index}`)));

    let beforeSeq: number | undefined;
    let pages = 0;
    let entries = 0;
    let maxEventBytes = 0;
    let newestId: string | undefined;
    let oldestId: string | undefined;
    do {
      const page = store.openAgentTail("agent", TRANSCRIPT_PAGE_SIZE, beforeSeq);
      const event = { type: "snapshot", agentId: "agent", entries: page.entries };
      maxEventBytes = Math.max(maxEventBytes, Buffer.byteLength(JSON.stringify(event)));
      entries += page.entries.length;
      const newest = page.entries[page.entries.length - 1]?.id;
      const oldest = page.entries[0]?.id;
      if (newestId === undefined && typeof newest === "string") newestId = newest;
      if (typeof oldest === "string") oldestId = oldest;
      beforeSeq = page.nextBeforeSeq;
      pages += 1;
    } while (beforeSeq !== undefined);

    expect(entries).toBe(TRANSCRIPT_ENTRIES);
    expect(pages).toBe(Math.ceil(TRANSCRIPT_ENTRIES / TRANSCRIPT_PAGE_SIZE));
    expect(newestId).toBe(`m-${TRANSCRIPT_ENTRIES - 1}`);
    expect(oldestId).toBe("m-0");
    expect(maxEventBytes).toBeLessThanOrEqual(MAX_TRANSCRIPT_EVENT_BYTES);
  });

  it("overlaps independent agent queues and serializes the same queue", async () => {
    const overlapRegistry = createProviderRegistry();
    let overlapStarts = 0;
    let overlapInFlight = 0;
    let overlapMaxInFlight = 0;
    let releaseOverlap!: () => void;
    const overlapGate = new Promise<void>((resolve) => { releaseOverlap = resolve; });
    let resolveOverlapReady!: () => void;
    const overlapReady = new Promise<void>((resolve) => { resolveOverlapReady = resolve; });
    const overlapAdapter: ProviderAdapter = {
      name: "fake",
      async streamChat(_request, emit) {
        overlapStarts += 1;
        overlapInFlight += 1;
        overlapMaxInFlight = Math.max(overlapMaxInFlight, overlapInFlight);
        if (overlapInFlight === 2) resolveOverlapReady();
        await overlapGate;
        emit({ type: "delta", delta: "ok" });
        overlapInFlight -= 1;
      },
    };
    overlapRegistry.register(overlapAdapter);
    const overlapRunner = createTurnRunner({
      registry: overlapRegistry,
      resolveProvider: () => ({ provider: "fake", model: "fake" }),
    });
    overlapRunner.sendPrompt({ agentId: "a", prompt: "one", clientNonce: "a-1" });
    overlapRunner.sendPrompt({ agentId: "b", prompt: "one", clientNonce: "b-1" });
    await overlapReady;
    expect(overlapStarts).toBe(2);
    expect(overlapMaxInFlight).toBe(2);
    releaseOverlap();
    await Promise.all([overlapRunner.flush("a"), overlapRunner.flush("b")]);

    const serialRegistry = createProviderRegistry();
    let serialStarts = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let resolveFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { resolveFirstEntered = resolve; });
    const serialAdapter: ProviderAdapter = {
      name: "fake",
      async streamChat(_request, emit) {
        serialStarts += 1;
        if (serialStarts === 1) {
          resolveFirstEntered();
          await firstGate;
        }
        emit({ type: "delta", delta: "ok" });
      },
    };
    serialRegistry.register(serialAdapter);
    const serialRunner = createTurnRunner({
      registry: serialRegistry,
      resolveProvider: () => ({ provider: "fake", model: "fake" }),
    });
    serialRunner.sendPrompt({ agentId: "same", prompt: "first", clientNonce: "same-1" });
    serialRunner.sendPrompt({ agentId: "same", prompt: "second", clientNonce: "same-2" });
    await firstEntered;
    await nextImmediate();
    expect(serialStarts).toBe(1);
    releaseFirst();
    await serialRunner.flush("same");
    expect(serialStarts).toBe(2);
  });

  it("reserves concurrent quota without oversubscription", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-performance-quota-"));
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
      expect(secondSettled).toBe(false);
      first.cancel();
      const secondReservation = await second;
      secondReservation.cancel();
      await expect(quota.usage()).resolves.toMatchObject({ bytes: 0, files: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shares one MCP session and one cached tool-list call", async () => {
    const server: McpHttpServerConfig = { id: "demo", transport: "http", url: "http://127.0.0.1:8787/mcp" };
    const tool: Tool = { name: "echo", inputSchema: { type: "object", properties: {} } };
    let connectorCalls = 0;
    let listToolsCalls = 0;
    let callToolCalls = 0;
    const session: McpClientSession = {
      async listTools() {
        listToolsCalls += 1;
        return { tools: [tool] };
      },
      async callTool() {
        callToolCalls += 1;
        return { content: [{ type: "text", text: "ok" }] };
      },
      async close() {},
    };
    const manager = new McpManager({
      servers: [server],
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
      expect(connectorCalls).toBe(1);
      expect(listToolsCalls).toBe(1);
      expect(callToolCalls).toBe(1);
    } finally {
      await manager.close();
    }
  });

  it("bounds runtime admission and propagates cancellation to the injected driver", async () => {
    const driver = new FakeRuntimeDriver();
    const manager = new RuntimeManager({ driver, maxActiveLeases: 1 });
    const queuedController = new AbortController();
    let first: { release(): Promise<void> } | undefined;
    let queued: Promise<unknown> | undefined;
    try {
      first = await manager.acquire("agent-a", capability());
      queued = manager.acquire("agent-b", capability(), queuedController.signal);
      await waitFor(async () => (await manager.status("agent-a")).waitingLeaseCount === 1, "runtime admission queue");
      queuedController.abort();
      await expect(queued).rejects.toBeDefined();
    } finally {
      queuedController.abort();
      try {
        if (queued !== undefined) await Promise.allSettled([queued]);
        if (first !== undefined) await first.release();
      } finally {
        await manager.close();
      }
    }

    const cancellingDriver = new FakeRuntimeDriver();
    cancellingDriver.waitForAbort = true;
    const cancellingManager = new RuntimeManager({ driver: cancellingDriver });
    const controller = new AbortController();
    let pending: Promise<unknown> | undefined;
    try {
      pending = cancellingManager.acquire("agent-c", capability(), controller.signal);
      await nextImmediate();
      controller.abort();
      await expect(pending).rejects.toBeDefined();
      expect(cancellingDriver.abortObserved).toBe(true);
    } finally {
      controller.abort();
      try {
        if (pending !== undefined) await Promise.allSettled([pending]);
      } finally {
        await cancellingManager.close();
      }
    }
  });

  it("preserves FIFO dispatch per agent while browser agents overlap", async () => {
    const host = new FairBrowserHost();
    const root = await mkdtemp(join(tmpdir(), "openbot-performance-browser-"));
    const manager = new BrowserSessionManager({
      downloadsRoot: join(root, "downloads"),
      launchHost: () => host,
      egressProxy: fakeBrowserProxy,
      commandTimeoutMs: 5_000,
      readyTimeoutMs: 5_000,
    });
    let requests: Promise<unknown>[] = [];
    try {
      const leases = await Promise.all(["a", "b", "c", "d"].map((agentId) => manager.acquire(agentId)));
      requests = leases.flatMap((lease) => [0, 1, 2].map((index) => manager.navigate(lease, `https://example.com/${lease.agentId}/${index}`)));

      await waitFor(() => host.started.length === 4, "browser scheduler initial slots");
      expect(host.started.slice(0, 4)).toEqual(["a:0", "b:0", "c:0", "d:0"]);

      for (const round of [0, 1, 2]) {
        for (const agentId of ["a", "b", "c", "d"]) {
          host.releaseNext(agentId);
          await waitFor(() => host.completed.includes(`${agentId}:${round}`), `browser ${agentId} round ${round}`);
          if (round < 2) await waitFor(() => host.started.includes(`${agentId}:${round + 1}`), `browser ${agentId} next round`);
          if (round === 0 && agentId === "a") {
            expect(host.started.indexOf("b:0")).toBeLessThan(host.started.indexOf("a:1"));
          }
        }
      }
      await Promise.all(requests);
      expect(host.started).toEqual([
        "a:0", "b:0", "c:0", "d:0",
        "a:1", "b:1", "c:1", "d:1",
        "a:2", "b:2", "c:2", "d:2",
      ]);
    } finally {
      try {
        await Promise.allSettled(requests);
        await manager.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
