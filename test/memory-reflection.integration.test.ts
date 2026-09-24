
import { afterEach, describe, expect, it, vi } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { ContextAssembler, REFLECTION_REQUEST_MAX_BYTES, REFLECTION_REQUEST_RETRY_BYTES } from "../src/memory/context.js";
import { createProviderRegistry, ProviderError, type ProviderChatRequest, type ProviderStreamEvent } from "../src/providers/router.js";
import { OpenAiAdapter } from "../src/providers/openai.js";
import { TempRoots } from "./helpers/temp-roots.js";

const handles: ServerHandle[] = [];
const temp = new TempRoots();

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  await temp.cleanup();
});

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (predicate(value)) return value;
    if (Date.now() - start >= timeoutMs) throw new Error("timeout waiting for reflection");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("memory reflection integration", () => {
  it("keeps the gateway and foreground chat healthy after a transient memory scan failure", async () => {
    const root = temp.make("openbot-reflection-scan-recovery-");
    const registry = createProviderRegistry();
    let reflectionCalls = 0;
    registry.register({ name: "xai", async streamChat(request, emit) {
      if (request.purpose === "memory-reflection") {
        reflectionCalls++;
        emit({ type: "delta", delta: JSON.stringify({ operations: [] }) });
      } else emit({ type: "delta", delta: "foreground healthy" });
    } });
    const handle = await startServer(0, { stateRoot: root, registry, disableAgentHome: true, allowUnauthenticatedLocalGateway: true });
    handles.push(handle);
    const agentId = "scan-recovery";
    handle.config.update({ agents: [{ id: agentId, name: "Recovery", avatarId: "avatar-default" }] });
    const conversationId = handle.conversationStore.ensureDefault(agentId).id;
    handle.store.append(agentId, [{ kind: "message", id: "scan-source", role: "user", content: "context", timestampMs: 1 }], conversationId);
    const job = handle.store.memoryStore.enqueueJob({
      agentId, conversationId, provider: "xai", model: "grok-4.6", fromSequenceId: 0,
      throughSequenceId: handle.store.getLatestSequenceId(agentId, conversationId)!, summaryRequested: false, memoryRequested: true,
    });
    const scan = vi.spyOn(handle.store.memoryStore, "listRunnableJobs").mockImplementationOnce(() => { throw new Error("fixture transient storage failure"); });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      handle.reflectionWorker!.start();
      await waitFor(() => warning.mock.calls.length, count => count === 1);
      const health = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(health.ok).toBe(true);
      await handle.runner.sendPrompt({ agentId, conversationId, prompt: "continue", clientNonce: "scan-recovery-chat" });
      await handle.runner.flush(agentId);
      expect(handle.store.getEntries(agentId, conversationId).some(entry => entry.kind === "message" && entry.role === "assistant" && entry.content === "foreground healthy")).toBe(true);
      await waitFor(() => handle.store.memoryStore.getJob(agentId, job.id)?.status, status => status === "complete");
      expect(reflectionCalls).toBe(1);
      expect(handle.server.listening).toBe(true);
    } finally {
      scan.mockRestore();
      warning.mockRestore();
    }
  });

  it("aborts an active reflection transport only after a successful archive RPC", async () => {
    const root = temp.make("openbot-reflection-archive-");
    let signal: AbortSignal | undefined;
    let cancelled = false;
    let calls = 0;
    const registry = createProviderRegistry();
    registry.register(new OpenAiAdapter({ name: "xai", protocol: "responses", apiKey: "fixture", fetchImpl: async (_url, init) => {
      calls += 1;
      signal = init?.signal as AbortSignal;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    } }));
    const handle = await startServer(0, { stateRoot: root, registry, disableAgentHome: true, allowUnauthenticatedLocalGateway: true });
    handles.push(handle);
    const agentId = "archive-test";
    handle.config.update({ agents: [{ id: agentId, name: "Archive", avatarId: "avatar-default" }] });
    const conversationId = handle.conversationStore.ensureDefault(agentId).id;
    handle.store.append(agentId, [{ kind: "message", id: "source", role: "user", content: "context", timestampMs: 1 }], conversationId);
    const job = handle.store.memoryStore.enqueueJob({ agentId, conversationId, provider: "xai", model: "grok-4.6",
      fromSequenceId: 0, throughSequenceId: handle.store.getLatestSequenceId(agentId, conversationId)!, summaryRequested: true, memoryRequested: false });
    handle.reflectionWorker!.start();
    await waitFor(() => signal, value => value !== undefined);
    const archive = handle.gateway.listHandlers().get("archiveConversation")!;
    const context = { method: "archiveConversation", getStatus: () => ({ isBusy: false, activeAgentId: null }), publish: () => {} };
    expect(() => archive({ agentId, conversationId }, context)).toThrow();
    expect(signal!.aborted).toBe(false);
    expect(handle.store.memoryStore.getJob(agentId, job.id)?.status).toBe("running");
    handle.conversationStore.create(agentId);
    archive({ agentId, conversationId }, context);
    expect(signal!.aborted).toBe(true);
    await handle.reflectionWorker!.waitForIdle();
    await waitFor(() => cancelled, Boolean);
    expect(calls).toBe(1);
    expect(handle.store.memoryStore.getJob(agentId, job.id)).toMatchObject({ status: "dead", lastErrorCode: "conversation_archived", attempts: 1 });
    expect(handle.store.memoryStore.getSummary(agentId, conversationId)).toBeNull();
  });

  it("does not retry a reflection job after a permanent Responses failure", async () => {
    const root = temp.make("openbot-reflection-permanent-");
    let calls = 0;
    const registry = createProviderRegistry();
    registry.register(new OpenAiAdapter({ name: "xai", protocol: "responses", apiKey: "fixture", fetchImpl: async () => {
      calls += 1;
      return new Response('data: {"type":"response.failed","response":{"error":{"code":"invalid_prompt"}}}\n\n');
    } }));
    const handle = await startServer(0, { stateRoot: root, registry, disableAgentHome: true, allowUnauthenticatedLocalGateway: true });
    handles.push(handle);
    const agentId = "permanent-test";
    handle.config.update({ agents: [{ id: agentId, name: "Permanent", avatarId: "avatar-default" }] });
    const conversationId = handle.conversationStore.ensureDefault(agentId).id;
    handle.store.append(agentId, [{ kind: "message", id: "source", role: "user", content: "context", timestampMs: 1 }], conversationId);
    const job = handle.store.memoryStore.enqueueJob({ agentId, conversationId, provider: "xai", model: "grok-4.6",
      fromSequenceId: 0, throughSequenceId: handle.store.getLatestSequenceId(agentId, conversationId)!, summaryRequested: true, memoryRequested: false });
    handle.reflectionWorker!.start();
    await handle.reflectionWorker!.waitForIdle();
    expect(calls).toBe(1);
    expect(handle.store.memoryStore.getJob(agentId, job.id)).toMatchObject({ status: "dead", lastErrorCode: "provider_validation", attempts: 1 });
    expect(handle.store.memoryStore.listRunnableJobs(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
  it("schedules, completes, and shuts down the durable reflection worker through startServer", async () => {
    const root = temp.make("openbot-memory-reflection-integration-");
    const requests: ProviderChatRequest[] = [];
    const registry = createProviderRegistry();
    registry.register({
      name: "xai",
      async streamChat(request: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void) {
        requests.push(request);
        if (request.system?.includes("maintain OpenBot summaries")) {
          const payload = JSON.parse(String(request.messages[0]?.content ?? "{}")) as { summaryRequested?: boolean; memoryRequested?: boolean; entries?: Array<{ id?: string }> };
          const citedEntryId = payload.entries?.find((entry) => typeof entry.id === "string")?.id;
          emit({
            type: "delta",
            delta: JSON.stringify({
              ...(payload.summaryRequested ? {
                summary: {
                  throughSequenceId: 1,
                  summaryJson: { reflection: true },
                  renderedText: "resumo refletido",
                },
              } : {}),
              operations: payload.memoryRequested ? [{
                op: "upsert",
                memory: {
                  kind: "fact",
                  canonicalKey: "reflection-result",
                  text: "lembrança consolidada",
                  trust: "verified_tool",
                  sourceEntryIds: citedEntryId === undefined ? [] : [citedEntryId],
                },
              }] : [],
            }),
          });
          return;
        }
        emit({ type: "delta", delta: "turn ok" });
      },
    });

    const handle = await startServer(0, {
      stateRoot: root,
      disableAgentHome: true,
      registry,
      allowUnauthenticatedLocalGateway: true,
    });
    handles.push(handle);

    const agentId = "openbot-default";
    if (!handle.config.snapshot().agents.some((agent) => agent.id === agentId)) {
      handle.config.update({ agents: [{ id: agentId, name: "Default", avatarId: "avatar-default" }] });
      handle.conversationStore.ensureDefault(agentId);
    }
    const conversation = handle.conversationStore.getActive(agentId) ?? handle.conversationStore.ensureDefault(agentId);
    handle.store.memoryStore.setSettings(agentId, "automatic");

    handle.runner.sendPrompt({ agentId, conversationId: conversation.id, prompt: "salve este contexto" });
    await handle.runner.flush(agentId);

    await waitFor(
      () => handle.store.memoryStore.listJobs(agentId, { limit: 10 }),
      (jobs) => jobs.some((job) => job.status === "complete"),
    );

    expect(requests.some((request) => request.system?.includes("maintain OpenBot summaries"))).toBe(true);
    expect(handle.store.memoryStore.getSummary(agentId, conversation.id)).toBeNull();
    expect(handle.store.memoryStore.listJobs(agentId, { limit: 10 })).toEqual([
      expect.objectContaining({ status: "complete", summaryRequested: false, memoryRequested: true }),
    ]);
    expect(handle.store.memoryStore.searchMemories(agentId, "lembrança").map((result) => result.memory.canonicalKey)).toContain("reflection-result");

    let reflectionClosed = false;
    const originalClose = handle.reflectionWorker!.close.bind(handle.reflectionWorker);
    handle.reflectionWorker!.close = async () => {
      reflectionClosed = true;
      await originalClose();
    };

    handles.pop();
    await stopServer(handle);
    expect(reflectionClosed).toBe(true);
    expect(handle.server.listening).toBe(false);
  });

  it("recovers an abandoned running job exactly once on restart with the original provider and model", async () => {
    const root = temp.make("openbot-memory-reflection-restart-");
    const firstRegistry = createProviderRegistry();
    let firstReflectionCalls = 0;
    firstRegistry.register({
      name: "xai",
      async streamChat(request: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void) {
        if (request.system?.includes("maintain OpenBot summaries")) {
          firstReflectionCalls += 1;
          await new Promise<never>((_, reject) => {
            const abort = () => reject(request.signal?.reason ?? new Error("reflection aborted"));
            if (request.signal?.aborted) abort();
            else request.signal?.addEventListener("abort", abort, { once: true });
          });
        }
        emit({ type: "delta", delta: "turn ok" });
      },
    });

    const firstHandle = await startServer(0, {
      stateRoot: root,
      disableAgentHome: true,
      registry: firstRegistry,
      allowUnauthenticatedLocalGateway: true,
    });
    handles.push(firstHandle);

    const agentId = "openbot-default";
    if (!firstHandle.config.snapshot().agents.some((agent) => agent.id === agentId)) {
      firstHandle.config.update({ agents: [{ id: agentId, name: "Default", avatarId: "avatar-default" }] });
      firstHandle.conversationStore.ensureDefault(agentId);
    }
    const conversation = firstHandle.conversationStore.getActive(agentId) ?? firstHandle.conversationStore.ensureDefault(agentId);
    firstHandle.config.update({ globalReasoningEffort: "low" });
    firstHandle.store.memoryStore.setSettings(agentId, "automatic");

    firstHandle.runner.sendPrompt({ agentId, conversationId: conversation.id, prompt: "gere memória persistente" });
    await firstHandle.runner.flush(agentId);

    await waitFor(
      () => firstHandle.store.memoryStore.listJobs(agentId, { limit: 10 }),
      (jobs) => jobs.some((job) => job.status === "running"),
      5_000,
    );
    expect(firstReflectionCalls).toBe(1);
    expect(firstHandle.store.memoryStore.listJobs(agentId)[0]?.reasoningEffort).toBe("low");
    firstHandle.config.update({ globalReasoningEffort: "high" });

    handles.pop();
    await stopServer(firstHandle);

    const recoveredRequests: Array<{ purpose?: string; model?: string; reasoningEffort?: string }> = [];
    const secondRegistry = createProviderRegistry();
    secondRegistry.register({
      name: "xai",
      async streamChat(request: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void) {
        if (request.system?.includes("maintain OpenBot summaries")) {
          recoveredRequests.push({ purpose: request.purpose, model: request.model, reasoningEffort: request.reasoningEffort });
          const payload = JSON.parse(String(request.messages[0]?.content ?? "{}")) as { summaryRequested?: boolean; memoryRequested?: boolean; entries?: Array<{ id?: string }> };
          const citedEntryId = payload.entries?.find((entry) => typeof entry.id === "string")?.id;
          emit({
            type: "delta",
            delta: JSON.stringify({
              ...(payload.summaryRequested ? {
                summary: {
                  throughSequenceId: 1,
                  summaryJson: { recovered: true },
                  renderedText: "resumo recuperado",
                },
              } : {}),
              operations: payload.memoryRequested ? [{
                op: "upsert",
                memory: {
                  kind: "fact",
                  canonicalKey: "restart-recovery",
                  text: "job recuperado",
                  trust: "verified_tool",
                  sourceEntryIds: citedEntryId === undefined ? [] : [citedEntryId],
                },
              }] : [],
            }),
          });
          return;
        }
        emit({ type: "delta", delta: "turn ok" });
      },
    });

    const restarted = await startServer(0, {
      stateRoot: root,
      disableAgentHome: true,
      registry: secondRegistry,
      allowUnauthenticatedLocalGateway: true,
    });
    handles.push(restarted);

    await waitFor(
      () => restarted.store.memoryStore.listJobs(agentId, { limit: 10 }),
      (jobs) => jobs.some((job) => job.status === "complete"),
      5_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    const [recovered] = restarted.store.memoryStore.listJobs(agentId, { limit: 10 });
    expect(recoveredRequests).toEqual([{ purpose: "memory-reflection", model: "grok-4.6", reasoningEffort: "low" }]);
    expect(recovered).toMatchObject({
      status: "complete",
      provider: "xai",
      model: "grok-4.6",
      conversationId: conversation.id,
    });
    expect(restarted.store.memoryStore.getSummary(agentId, conversation.id)).toBeNull();
    expect(restarted.store.memoryStore.searchMemories(agentId, "recuperado").map((result) => result.memory.canonicalKey)).toContain("restart-recovery");
  });

  it("caps oversized reflection requests and retries one context overflow with a smaller payload", async () => {
    const root = temp.make("openbot-memory-reflection-overflow-");
    const reflectionPayloadBytes: number[] = [];
    const reflectionPayloads: Array<{ entries?: Array<Record<string, unknown>> }> = [];
    const registry = createProviderRegistry();
    registry.register({
      name: "xai",
      async streamChat(request: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void) {
        if (!request.system?.includes("maintain OpenBot summaries")) {
          emit({ type: "delta", delta: "turn ok" });
          return;
        }
        const payloadBytes = Buffer.byteLength(String(request.messages[0]?.content ?? ""), "utf8");
        reflectionPayloadBytes.push(payloadBytes);
        reflectionPayloads.push(JSON.parse(String(request.messages[0]?.content ?? "{}")) as { entries?: Array<Record<string, unknown>> });
        if (reflectionPayloadBytes.length === 1) {
          throw new Error("Your input exceeds the context window of this model.");
        }
        emit({
          type: "delta",
          delta: JSON.stringify({
            summary: {
              throughSequenceId: 999,
              summaryJson: { compacted: true },
              renderedText: "resumo compacto",
            },
            operations: [],
          }),
        });
      },
    });

    const handle = await startServer(0, {
      stateRoot: root,
      disableAgentHome: true,
      registry,
      allowUnauthenticatedLocalGateway: true,
    });
    handles.push(handle);

    const agentId = "openbot-default";
    const conversation = handle.conversationStore.getActive(agentId) ?? handle.conversationStore.ensureDefault(agentId);
    handle.store.memoryStore.setSettings(agentId, "automatic");

    const hugeEntries = Array.from({ length: 18 }, (_, index) => {
      if (index % 3 === 0) {
        return {
          kind: "message" as const,
          id: `user-${index}`,
          role: "user" as const,
          content: `usuario ${index} ${"U".repeat(11_000)}`,
          timestampMs: index + 1,
        };
      }
      if (index % 3 === 1) {
        return {
          kind: "tool-call" as const,
          id: `tool-${index}`,
          name: "memory_search",
          summary: `resultado ${index} ${"T".repeat(9_000)}`,
          status: "completed" as const,
          result: { ok: true, message: `payload ${"R".repeat(4_000)}` },
        };
      }
      return {
        kind: "user-attachment" as const,
        id: `attachment-${index}`,
        file_name: `arquivo-${index}.txt`,
        file_path: `C:\\tmp\\arquivo-${index}.txt`,
        extractedText: `anexo ${index} ${"A".repeat(10_000)}`,
      };
    });

    handle.reflectionWorker!.enqueue({
      agentId,
      conversationId: conversation.id,
      provider: "xai",
      model: "grok-4.6",
      fromSequenceId: 0,
      throughSequenceId: 999,
      summaryRequested: true,
      memoryRequested: false,
      entries: hugeEntries,
    });

    await waitFor(
      () => handle.store.memoryStore.listJobs(agentId, { limit: 10 }),
      (jobs) => jobs.some((job) => job.status === "complete"),
      5_000,
    );

    expect(reflectionPayloadBytes).toHaveLength(2);
    expect(reflectionPayloadBytes[0]).toBeLessThanOrEqual(REFLECTION_REQUEST_MAX_BYTES);
    expect(reflectionPayloadBytes[1]).toBeLessThanOrEqual(REFLECTION_REQUEST_RETRY_BYTES);
    expect(reflectionPayloadBytes[1]).toBeLessThan(reflectionPayloadBytes[0]!);
    expect(reflectionPayloads).toHaveLength(2);
    for (const payload of reflectionPayloads) {
      const attachments = (payload.entries ?? []).filter((entry) => entry.kind === "user-attachment");
      expect(attachments.length).toBeGreaterThan(0);
      for (const attachment of attachments) {
        expect(attachment.file_path).toBeUndefined();
        expect(attachment.file_name).toMatch(/^arquivo-\d+\.txt$/);
        expect(attachment.untrusted).toBe(true);
        expect(attachment.truncated).toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain("C:\\\\tmp\\\\");
    }
    expect(handle.store.memoryStore.getSummary(agentId, conversation.id)?.renderedText).toBe("resumo compacto");
  });

  it("advances the summary only to the covered boundary and enqueues the deferred tail", async () => {
    const root = temp.make("openbot-memory-reflection-covered-");
    const payloads: Array<{ fromSequenceId?: number; throughSequenceId?: number; deferredThroughSequenceId?: number }> = [];
    const registry = createProviderRegistry();
    registry.register({
      name: "xai",
      async streamChat(request: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void) {
        if (request.system?.includes("maintain OpenBot summaries")) {
          const payload = JSON.parse(String(request.messages[0]?.content ?? "{}")) as {
            fromSequenceId?: number; throughSequenceId?: number; deferredThroughSequenceId?: number;
          };
          payloads.push(payload);
          emit({
            type: "delta",
            delta: JSON.stringify({
              summary: {
                throughSequenceId: payload.throughSequenceId,
                summaryJson: { covered: true },
                renderedText: `coberto até ${payload.throughSequenceId}`,
              },
              operations: [],
            }),
          });
          return;
        }
        emit({ type: "delta", delta: "turn ok" });
      },
    });

    const handle = await startServer(0, {
      stateRoot: root,
      disableAgentHome: true,
      registry,
      allowUnauthenticatedLocalGateway: true,
    });
    handles.push(handle);

    const agentId = "openbot-default";
    const conversation = handle.conversationStore.getActive(agentId) ?? handle.conversationStore.ensureDefault(agentId);
    handle.store.memoryStore.setSettings(agentId, "automatic");

    handle.store.append(agentId, Array.from({ length: 40 }, (_, index) => ({
      kind: "message" as const,
      id: `m-${index}`,
      role: "user" as const,
      content: `mensagem ${index} ${"X".repeat(20_000)}`,
      timestampMs: index + 1,
      streaming: false,
    })), conversation.id);
    const lastSequence = handle.store.getLatestSequenceId!(agentId, conversation.id)!;

    handle.store.memoryStore.enqueueJob({
      agentId,
      conversationId: conversation.id,
      provider: "xai",
      model: "grok-4.6",
      fromSequenceId: 1,
      throughSequenceId: lastSequence,
      summaryRequested: true,
      memoryRequested: false,
    });
    handle.reflectionWorker!.start();

    await waitFor(
      () => handle.store.memoryStore.listJobs(agentId, { limit: 20 }),
      (jobs) => jobs.length > 0 && jobs.every((job) => job.status === "complete"),
      10_000,
    );

    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads[0]!.deferredThroughSequenceId).toBe(lastSequence);
    expect(payloads[0]!.throughSequenceId).toBeLessThan(lastSequence);
    for (let index = 1; index < payloads.length; index += 1) {
      expect(payloads[index]!.fromSequenceId).toBe(payloads[index - 1]!.throughSequenceId! + 1);
    }
    expect(payloads.at(-1)!.throughSequenceId).toBe(lastSequence);
    expect(handle.store.memoryStore.getSummary(agentId, conversation.id)?.throughSequenceId).toBe(lastSequence);
  });

  it.each(["prefix", "tail", "restart"])("rebuilds an invalidated summary in complete batches from a %s job", async (start) => {
    const root = temp.make("openbot-memory-rebuild-");
    const payloads: Array<{ fromSequenceId: number; throughSequenceId: number; entries: Array<{ id?: string; content?: string }>; previousSummary?: { renderedText?: string } | null }> = [];
    let notifySecond!: () => void;
    const secondStarted = new Promise<void>(resolve => { notifySecond = resolve; });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    let calls = 0;
    const registry = createProviderRegistry();
    registry.register({ name: "xai", async streamChat(request, emit) {
      if (++calls === 2 && start === "restart") {
        notifySecond();
        request.signal?.addEventListener("abort", releaseSecond, { once: true });
        try { await secondGate; }
        finally { request.signal?.removeEventListener("abort", releaseSecond); }
        if (request.signal?.aborted) return;
      }
      const payload = JSON.parse(String(request.messages[0]?.content)) as typeof payloads[number];
      payloads.push(payload);
      expect(payload.throughSequenceId).toBeGreaterThanOrEqual(payload.fromSequenceId);
      expect(payload.entries.some(entry => entry.id === "forgotten-source")).toBe(false);
      const hasTail = payload.entries.some(entry => entry.content?.includes("MARCADOR_FINAL_731"))
        || payload.previousSummary?.renderedText?.includes("MARCADOR_FINAL_731");
      emit({ type: "delta", delta: JSON.stringify({
        summary: { throughSequenceId: payload.throughSequenceId, summaryJson: { state: "contexto reconstruído" }, renderedText: hasTail ? "MARCADOR_FINAL_731" : "Contexto reconstruído." },
        operations: [],
      }) });
    } });
    let handle = await startServer(0, { stateRoot: root, registry, disableAgentHome: true, allowUnauthenticatedLocalGateway: true });
    handles.push(handle);
    const agentId = "review-rebuild";
    const conversationId = handle.conversationStore.create(agentId).id;
    let memory = handle.store.memoryStore;
    memory.setSettings(agentId, "off");
    const entries = Array.from({ length: 40 }, (_, index) => ({
      kind: "message" as const, id: index === 0 ? "forgotten-source" : `rebuild-${index}`, role: "user" as const,
      content: index === 0 ? "Preferência retirada." : "Contexto do projeto. ".repeat(700) + (index === 1 ? " MARCADOR_FINAL_731" : ""), timestampMs: index + 1,
    }));
    handle.store.append(agentId, entries, conversationId);
    const oldBoundary = handle.store.getLatestSequenceId(agentId, conversationId)!;
    memory.upsertSummary(agentId, { conversationId, throughSequenceId: oldBoundary, summaryJson: {}, renderedText: "Resumo anterior.", updatedAtMs: 1 });
    const saved = memory.upsertMemory(agentId, {
      kind: "preference", canonicalKey: "removed-preference", text: entries[0]!.content, trust: "user",
      sourceConversationId: conversationId, sourceEntryIds: [{ conversationId, entryId: entries[0]!.id }],
    }, { kind: "user" });
    memory.forgetMemory(agentId, saved.id, { kind: "user" });
    expect(memory.getSummary(agentId, conversationId, true)).toBeNull();
    handle.store.append(agentId, [{ kind: "message", id: "new-work", role: "user", content: "Continuar.", timestampMs: 42 }], conversationId);
    const lastSequence = handle.store.getLatestSequenceId(agentId, conversationId)!;
    const job = memory.enqueueJob({ agentId, conversationId, provider: "xai", model: "grok-4.6", fromSequenceId: start === "prefix" ? 0 : oldBoundary + 1, throughSequenceId: lastSequence, summaryRequested: true, memoryRequested: false });
    handle.reflectionWorker!.start();
    if (start === "restart") {
      await secondStarted;
      const checkpoint = memory.getSummary(agentId, conversationId, true)!;
      expect(checkpoint.throughSequenceId).toBeLessThan(oldBoundary);
      await stopServer(handle);
      handles.splice(handles.indexOf(handle), 1);
      releaseSecond();
      handle = await startServer(0, { stateRoot: root, registry, disableAgentHome: true, allowUnauthenticatedLocalGateway: true });
      handles.push(handle);
      memory = handle.store.memoryStore;
    }
    const finished = await waitFor(() => memory.getJob(agentId, job.id), current => current?.status === "complete" || current?.status === "retry" || current?.status === "dead", 5_000);
    expect(finished?.status).toBe("complete");
    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads[0]!.throughSequenceId).toBeLessThan(oldBoundary);
    for (let index = 1; index < payloads.length; index++) expect(payloads[index]!.fromSequenceId).toBe(payloads[index - 1]!.throughSequenceId + 1);
    expect(payloads.flatMap(payload => payload.entries.flatMap(entry => entry.id ? [entry.id] : [])))
      .toEqual([...entries.slice(1).map(entry => entry.id), "new-work"]);
    expect(memory.getSummary(agentId, conversationId, true)).toMatchObject({ throughSequenceId: lastSequence, renderedText: "MARCADOR_FINAL_731" });
    handle.store.append(agentId, [{ kind: "message", id: "follow-up", role: "user", content: "Qual o estado?", timestampMs: 43 }], conversationId);
    const assembled = new ContextAssembler().assemble({ agentId, conversationId, prompt: "Qual o estado?", recentStore: handle.store, memoryStore: memory, mode: "off", conversation: { temporary: false }, systemText: "", toolText: "" });
    expect(JSON.stringify(assembled.messages)).toContain("MARCADOR_FINAL_731");
    expect(JSON.stringify(assembled.messages)).not.toContain("Preferência retirada");
  });

  it("keeps an oversized message unsummarized and reports the limit without repeating inference", async () => {
    const root = temp.make("openbot-memory-large-entry-");
    const registry = createProviderRegistry();
    let calls = 0;
    registry.register({ name: "xai", async streamChat(request, emit) {
      calls++;
      const payload = JSON.parse(String(request.messages[0]?.content)) as { throughSequenceId: number };
      emit({ type: "delta", delta: JSON.stringify({ summary: { throughSequenceId: payload.throughSequenceId, summaryJson: {}, renderedText: "Primeiro trecho resumido." }, operations: [] }) });
    } });
    const handle = await startServer(0, { stateRoot: root, registry, disableAgentHome: true, allowUnauthenticatedLocalGateway: true });
    handles.push(handle);
    const agentId = "large-entry";
    const conversationId = handle.conversationStore.create(agentId).id;
    const oversized = "Observação extensa do projeto. ".repeat(3_000) + " MARCADOR_FINAL_731";
    handle.store.append(agentId, [
      { kind: "message", id: "small", role: "user", content: "Primeiro trecho.", timestampMs: 1 },
      { kind: "message", id: "oversized", role: "user", content: oversized, timestampMs: 2 },
    ], conversationId);
    const rows = handle.store.getEntriesWithSequenceByRange(agentId, 0, handle.store.getLatestSequenceId(agentId, conversationId)!, conversationId);
    const memory = handle.store.memoryStore;
    const job = memory.enqueueJob({ agentId, conversationId, provider: "xai", model: "grok-4.6", fromSequenceId: 0, throughSequenceId: rows.at(-1)!.sequenceId, summaryRequested: true, memoryRequested: false });
    handle.reflectionWorker!.start();
    const failed = await waitFor(() => memory.getJob(agentId, job.id), current => current?.status === "dead");
    expect(failed).toMatchObject({ attempts: 1, lastErrorCode: "reflection_input_too_large" });
    expect(calls).toBe(1);
    expect(memory.getSummary(agentId, conversationId)?.throughSequenceId).toBe(rows[0]!.sequenceId);
    expect(handle.store.getEntries(agentId, conversationId)).toContainEqual(expect.objectContaining({ id: "oversized", content: oversized }));
    expect(handle.store.getEntries(agentId, conversationId)).toContainEqual(expect.objectContaining({ kind: "notice", type: "memory-reflection-failed", text: expect.stringContaining("histórico foi preservado") }));
  });

  it("keeps the summary prefix when a memory-only predecessor is still running", async () => {
    const root = temp.make("openbot-memory-reflection-coalesced-prefix-");
    const payloads: Array<{
      fromSequenceId?: number;
      throughSequenceId?: number;
      summaryRequested?: boolean;
      memoryRequested?: boolean;
      previousSummary?: { renderedText?: string } | null;
      entries?: Array<{ id?: string; content?: string }>;
    }> = [];
    let firstStartedResolve!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let reflectionCalls = 0;
    const registry = createProviderRegistry();
    registry.register({
      name: "xai",
      async streamChat(request: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void) {
        if (!request.system?.includes("maintain OpenBot summaries")) {
          emit({ type: "delta", delta: "turn ok" });
          return;
        }
        const payload = JSON.parse(String(request.messages[0]?.content ?? "{}")) as typeof payloads[number];
        payloads.push(payload);
        reflectionCalls += 1;
        if (reflectionCalls === 1) {
          firstStartedResolve();
          await firstGate;
        }
        const sourceEntryId = payload.entries?.find((entry) => typeof entry.id === "string")?.id;
        const includesDecision = payload.entries?.some((entry) => entry.content === "DECISAO_INICIAL_PRESERVADA") === true;
        emit({
          type: "delta",
          delta: JSON.stringify({
            ...(payload.summaryRequested ? {
              summary: {
                throughSequenceId: payload.throughSequenceId,
                summaryJson: { includesDecision },
                renderedText: includesDecision ? "resumo com decisão inicial" : "resumo sem decisão inicial",
              },
            } : {}),
            operations: payload.memoryRequested ? [{
              op: "upsert",
              memory: {
                kind: "fact",
                canonicalKey: `coalesced-${reflectionCalls}`,
                text: `memória ${reflectionCalls}`,
                trust: "verified_tool",
                sourceEntryIds: sourceEntryId === undefined ? [] : [sourceEntryId],
              },
            }] : [],
          }),
        });
      },
    });

    const handle = await startServer(0, {
      stateRoot: root,
      disableAgentHome: true,
      registry,
      allowUnauthenticatedLocalGateway: true,
    });
    handles.push(handle);
    try {
      const agentId = "openbot-default";
      const conversation = handle.conversationStore.getActive(agentId) ?? handle.conversationStore.ensureDefault(agentId);
      handle.store.memoryStore.setSettings(agentId, "automatic");
      handle.store.append(agentId, Array.from({ length: 41 }, (_, index) => ({
        kind: "message" as const,
        id: `coalesced-${index}`,
        role: "user" as const,
        content: index === 0 ? "DECISAO_INICIAL_PRESERVADA" : `mensagem ${index}`,
        timestampMs: index + 1,
        streaming: false,
      })), conversation.id);

      const predecessor = handle.store.memoryStore.enqueueJob({
        id: "coalesced-predecessor",
        agentId,
        conversationId: conversation.id,
        provider: "xai",
        model: "grok-4.6",
        fromSequenceId: 0,
        throughSequenceId: 39,
        summaryRequested: false,
        memoryRequested: true,
      });
      handle.reflectionWorker!.start();
      await firstStarted;

      const successor = handle.store.memoryStore.enqueueJob({
        id: "coalesced-successor",
        agentId,
        conversationId: conversation.id,
        provider: "xai",
        model: "grok-4.6",
        fromSequenceId: 0,
        throughSequenceId: 41,
        summaryRequested: true,
        memoryRequested: true,
      });
      expect(successor).toMatchObject({
        id: "coalesced-successor",
        fromSequenceId: 0,
        throughSequenceId: 41,
        summaryRequested: true,
        memoryRequested: true,
        status: "pending",
      });
      expect(handle.store.memoryStore.getJob(agentId, predecessor.id)).toMatchObject({ status: "running", throughSequenceId: 39 });

      releaseFirst();
      await waitFor(
        () => handle.store.memoryStore.getJob(agentId, successor.id),
        (job) => job?.status === "complete",
        10_000,
      );
      expect(payloads).toHaveLength(2);
      expect(payloads[0]).toMatchObject({ fromSequenceId: 0, throughSequenceId: 39, summaryRequested: false, memoryRequested: true });
      expect(payloads[1]).toMatchObject({ fromSequenceId: 0, throughSequenceId: 41, summaryRequested: true, memoryRequested: true });
      expect(payloads[1]!.entries?.some((entry) => entry.content === "DECISAO_INICIAL_PRESERVADA")).toBe(true);
      expect(handle.store.memoryStore.getSummary(agentId, conversation.id)).toMatchObject({
        throughSequenceId: 41,
        renderedText: "resumo com decisão inicial",
      });
    } finally {
      releaseFirst();
    }
  });

  it("keeps the previous summary and range start after a predecessor failure", async () => {
    const root = temp.make("openbot-memory-reflection-failed-predecessor-");
    const payloads: Array<{
      fromSequenceId?: number;
      throughSequenceId?: number;
      summaryRequested?: boolean;
      memoryRequested?: boolean;
      previousSummary?: { renderedText?: string } | null;
    }> = [];
    let reflectionCalls = 0;
    const registry = createProviderRegistry();
    registry.register({
      name: "xai",
      async streamChat(request: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void) {
        if (!request.system?.includes("maintain OpenBot summaries")) {
          emit({ type: "delta", delta: "turn ok" });
          return;
        }
        const payload = JSON.parse(String(request.messages[0]?.content ?? "{}")) as typeof payloads[number];
        payloads.push(payload);
        reflectionCalls += 1;
        if (reflectionCalls === 1) {
          throw new ProviderError("fixture predecessor failure", { kind: "validation", code: "fixture_predecessor" });
        }
        emit({
          type: "delta",
          delta: JSON.stringify({
            ...(payload.summaryRequested ? {
              summary: {
                throughSequenceId: payload.throughSequenceId,
                summaryJson: { previousSummarySeen: payload.previousSummary?.renderedText === "decisão anterior" },
                renderedText: payload.previousSummary?.renderedText === "decisão anterior"
                  ? "resumo preservado após falha: decisão anterior"
                  : "resumo sem contexto anterior",
              },
            } : {}),
            operations: [],
          }),
        });
      },
    });

    const handle = await startServer(0, {
      stateRoot: root,
      disableAgentHome: true,
      registry,
      allowUnauthenticatedLocalGateway: true,
    });
    handles.push(handle);
    const agentId = "openbot-default";
    const conversation = handle.conversationStore.getActive(agentId) ?? handle.conversationStore.ensureDefault(agentId);
    handle.store.append(agentId, Array.from({ length: 5 }, (_, index) => ({
      kind: "message" as const,
      id: `failed-predecessor-${index}`,
      role: "user" as const,
      content: `mensagem ${index}`,
      timestampMs: index + 1,
      streaming: false,
    })), conversation.id);
    handle.store.memoryStore.upsertSummary(agentId, {
      conversationId: conversation.id,
      throughSequenceId: 1,
      summaryJson: { decision: "anterior" },
      renderedText: "decisão anterior",
    });

    const predecessor = handle.store.memoryStore.enqueueJob({
      id: "failed-predecessor",
      agentId,
      conversationId: conversation.id,
      provider: "xai",
      model: "grok-4.6",
      fromSequenceId: 2,
      throughSequenceId: 3,
      summaryRequested: false,
      memoryRequested: true,
    });
    handle.reflectionWorker!.start();
    await waitFor(
      () => handle.store.memoryStore.getJob(agentId, predecessor.id),
      (job) => job?.status === "dead",
      5_000,
    );
    expect(handle.store.memoryStore.getJob(agentId, predecessor.id)).toMatchObject({
      status: "dead",
      lastErrorCode: "provider_validation",
    });

    const successor = handle.store.memoryStore.enqueueJob({
      id: "failed-predecessor-successor",
      agentId,
      conversationId: conversation.id,
      provider: "xai",
      model: "grok-4.6",
      fromSequenceId: 2,
      throughSequenceId: 5,
      summaryRequested: true,
      memoryRequested: true,
    });
    expect(successor).toMatchObject({ fromSequenceId: 2, throughSequenceId: 5, status: "pending" });
    handle.reflectionWorker!.start();
    await waitFor(
      () => handle.store.memoryStore.getJob(agentId, successor.id),
      (job) => job?.status === "complete",
      5_000,
    );
    expect(payloads[1]).toMatchObject({
      fromSequenceId: 2,
      throughSequenceId: 5,
      summaryRequested: true,
      previousSummary: { renderedText: "decisão anterior" },
    });
    expect(handle.store.memoryStore.getSummary(agentId, conversation.id)).toMatchObject({
      throughSequenceId: 5,
      renderedText: "resumo preservado após falha: decisão anterior",
    });
    const assembled = new ContextAssembler().assemble({
      agentId,
      conversationId: conversation.id,
      prompt: "continue",
      recentStore: handle.store,
      memoryStore: handle.store.memoryStore,
      mode: "automatic",
      conversation: { temporary: false },
      systemText: "",
      toolText: "",
    });
    expect(JSON.stringify(assembled.messages)).toContain("anterior");
  });
});
