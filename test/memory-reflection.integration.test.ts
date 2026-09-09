import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { REFLECTION_REQUEST_MAX_BYTES, REFLECTION_REQUEST_RETRY_BYTES } from "../src/memory/context.js";
import { createProviderRegistry, type ProviderChatRequest, type ProviderStreamEvent } from "../src/providers/router.js";

const handles: ServerHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
  it("schedules, completes, and shuts down the durable reflection worker through startServer", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-memory-reflection-integration-"));
    roots.push(root);
    const requests: ProviderChatRequest[] = [];
    const registry = createProviderRegistry();
    registry.register({
      name: "xai",
      async streamChat(request: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void) {
        requests.push(request);
        if (request.system?.includes("maintain OpenBot summaries")) {
          const payload = JSON.parse(String(request.messages[0]?.content ?? "{}")) as { summaryRequested?: boolean; memoryRequested?: boolean };
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
    const root = mkdtempSync(join(tmpdir(), "openbot-memory-reflection-restart-"));
    roots.push(root);
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
          const payload = JSON.parse(String(request.messages[0]?.content ?? "{}")) as { summaryRequested?: boolean; memoryRequested?: boolean };
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
    const root = mkdtempSync(join(tmpdir(), "openbot-memory-reflection-overflow-"));
    roots.push(root);
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
});
