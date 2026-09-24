import { describe, expect, it } from "vitest";

import { MAX_RESUME_CURSOR_BYTES, resumeFingerprintHash, stableResumeEffectId, validateOpaqueResumeCursor } from "../src/providers/resume.js";
import { createProviderRegistry, streamChat } from "../src/providers/router.js";
import { overrideProviderCapability } from "../src/providers/capabilities.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { createMemoryTranscriptStore, TurnRunner } from "../src/rpc/send.js";
import { runToolLoop } from "../src/execution/tool-loop.js";

describe("P2.6 resume protocol", () => {
  it("accepts a bounded opaque cursor and derives a stable turn-scoped effect key", () => {
    const cursor = validateOpaqueResumeCursor("fixture-v1:session-a:7");
    expect(cursor).toBe("fixture-v1:session-a:7");
    expect(stableResumeEffectId("turn:1", "execution\\0file.read\\0path"))
      .toBe(stableResumeEffectId("turn:1", "execution\\0file.read\\0path"));
    expect(stableResumeEffectId("turn:1", "execution\\0file.read\\0path"))
      .not.toBe(stableResumeEffectId("turn:2", "execution\\0file.read\\0path"));
    expect(() => validateOpaqueResumeCursor("x".repeat(MAX_RESUME_CURSOR_BYTES + 1))).toThrow(/cursor/i);
  });

  it("fails closed when a real provider pair has no cursor capability", async () => {
    let invocations = 0;
    const registry = createProviderRegistry();
    registry.register({
      name: "xai",
      async streamChat() {
        invocations += 1;
      },
    });

    const result = await streamChat("xai", {
      model: "grok-4.6",
      messages: [],
      resume: { cursor: "fixture-v1:session-a:7" },
    }, undefined, { registry, maxRetries: 0 });

    expect(result.error?.code).toBe("resume_unavailable");
    expect(invocations).toBe(0);
  });

  it("uses the fixture cursor to return only the remaining suffix", async () => {
    const restore = overrideProviderCapability("openai-compat", "openai-compatible", { resume: "cursor" });
    try {
      const registry = createProviderRegistry();
      const cursors: string[] = [];
      registry.register({
        name: "openai-compat",
        async streamChat(_request, emit) {
          emit({ type: "delta", delta: "prefix" });
          emit({ type: "resume-cursor", cursor: "fixture-v1:session-a:1" });
        },
        async resumeChat(_request, cursor, emit) {
          cursors.push(cursor);
          if (cursor !== "fixture-v1:session-a:1") throw new Error("foreign cursor");
          emit({ type: "delta", delta: "suffix" });
          emit({ type: "resume-cursor", cursor: "fixture-v1:session-a:2" });
        },
      });

      const first = await streamChat("openai-compat", { model: "openai-compatible", messages: [] }, undefined, { registry });
      const resumed = await streamChat("openai-compat", {
        model: "openai-compatible",
        messages: [],
        resume: { cursor: first.cursor! },
      }, undefined, { registry });

      expect(first.message?.content).toBe("prefix");
      expect(first.cursor).toBe("fixture-v1:session-a:1");
      expect(resumed.message?.content).toBe("suffix");
      expect(resumed.cursor).toBe("fixture-v1:session-a:2");
      expect(cursors).toEqual(["fixture-v1:session-a:1"]);
    } finally {
      restore();
    }
  });

  it("persists a scoped checkpoint and claims an effect exactly once", () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    const scope = { agentId: "agent-a", conversationId: "conversation-a", turnId: "turn-a", provider: "openai-compat", model: "openai-compatible" } as const;
    const checkpoint = {
      checkpointId: "checkpoint-a",
      ...scope,
      cursor: "fixture-v1:session-a:1",
      safeSequenceId: 0,
      completedEffectIds: [],
      expiresAtMs: Date.now() + 60_000,
      version: 1,
      budget: { maxProviderAttempts: 2, providerAttemptsUsed: 0, maxToolRounds: 8, toolRoundsUsed: 0, maxToolCalls: 16, toolCallsUsed: 0 },
    } as const;

    expect(store.createResumeCheckpoint(checkpoint)).toBe(true);
    expect(store.createResumeCheckpoint(checkpoint)).toBe(false);
    expect(store.getResumeCheckpoint(scope)).toMatchObject({ checkpointId: "checkpoint-a", version: 1 });
    const prepared = store.prepareResumeEffect(scope, "effect:v1:one", "hash-a");
    expect(prepared.status).toBe("prepared");
    expect(store.prepareResumeEffect(scope, "effect:v1:one", "hash-a").status).toBe("prepared");
    expect(store.markResumeEffectStarted(scope, "effect:v1:one")?.status).toBe("started");
    const advanced = store.commitResumeEffectAndCheckpoint({
      scope,
      effectId: "effect:v1:one",
      fingerprintHash: "hash-a",
      result: { ok: true, operation: "file.read", content: "ok" },
      checkpoint: {
        expectedVersion: 1,
        cursor: "fixture-v1:session-a:2",
        safeSequenceId: 2,
        completedEffectIds: ["effect:v1:one"],
        expiresAtMs: Date.now() + 60_000,
        budget: checkpoint.budget,
      },
    });
    expect(advanced.version).toBe(2);
    expect(store.getResumeEffect(scope, "effect:v1:one")).toMatchObject({ status: "completed", result: { ok: true } });
    expect(() => store.commitResumeEffectAndCheckpoint({
      scope,
      effectId: "effect:v1:one",
      fingerprintHash: "hash-a",
      result: { ok: true },
      checkpoint: {
        expectedVersion: 1,
        cursor: "fixture-v1:session-a:3",
        safeSequenceId: 3,
        completedEffectIds: ["effect:v1:one"],
        expiresAtMs: Date.now() + 60_000,
        budget: checkpoint.budget,
      },
    })).toThrow(/CAS/i);
    store.prepareResumeEffect(scope, "effect:v1:crash", "hash-crash");
    store.markResumeEffectStarted(scope, "effect:v1:crash");
    expect(store.reconcileResumeEffects("agent-a")).toBe(1);
    expect(store.getResumeEffect(scope, "effect:v1:crash")?.status).toBe("unsafe");
    store.close();
  });

  it("reuses a completed tool outcome and never invokes the executor twice", async () => {
    const store = createMemoryTranscriptStore();
    const scope = { agentId: "agent-a", conversationId: "conversation-a", turnId: "turn-tool", provider: "openai-compat", model: "openai-compatible" } as const;
    let executions = 0;
    const call = { id: "call-1", type: "function" as const, function: { name: "fixture_tool", arguments: "{}" } };
    const run = () => {
      let round = 0;
      return runToolLoop({
        agentId: scope.agentId,
        conversationId: scope.conversationId,
        turnId: scope.turnId,
        request: { model: scope.model, messages: [], tools: [{ type: "function", function: { name: "fixture_tool", description: "fixture", parameters: { type: "object" } } }] },
        executeTool: Object.assign(async () => {
          executions += 1;
          return { handled: true as const, ok: true, content: "cached", result: { ok: true } };
        }, { canHandle: () => true }),
        resumableEffects: {
          prepare: (effectId, fingerprintHash) => store.prepareResumeEffect!(scope, effectId, fingerprintHash),
          markStarted: (effectId) => store.markResumeEffectStarted!(scope, effectId),
          complete: (effectId, fingerprintHash, result) => store.completeResumeEffect!(scope, effectId, fingerprintHash, result),
        },
        stream: async (_request, emit) => {
          round += 1;
          if (round === 1) {
            emit({ type: "tool-call", call });
            return { aborted: false, message: { role: "assistant", content: "", toolCalls: [call] } };
          }
          return { aborted: false, message: { role: "assistant", content: "done" } };
        },
        onEvent: () => undefined,
      });
    };
    await run();
    await run();
    expect(executions).toBe(1);
    expect([...store.getEntries(scope.agentId, scope.conversationId)]).toHaveLength(0);
  });

  it("treats a started effect without a durable result as unsafe and does not re-execute", async () => {
    const store = createMemoryTranscriptStore();
    const scope = { agentId: "agent-a", conversationId: "conversation-a", turnId: "turn-started", provider: "openai-compat", model: "openai-compatible" } as const;
    let executions = 0;
    const call = { id: "call-1", type: "function" as const, function: { name: "fixture_tool", arguments: "{}" } };
    const resumableEffects = {
      prepare: (effectId: string, fingerprintHash: string) => store.prepareResumeEffect!(scope, effectId, fingerprintHash),
      markStarted: (effectId: string) => store.markResumeEffectStarted!(scope, effectId),
      markUnsafe: (effectId: string) => store.markResumeEffectUnsafe!(scope, effectId),
      complete: (effectId: string, fingerprintHash: string, result: unknown) => store.completeResumeEffect!(scope, effectId, fingerprintHash, result),
    };
    const fingerprint = "fixture_tool\0{}";
    const effectId = stableResumeEffectId(scope.turnId, fingerprint);
    const fingerprintHash = resumeFingerprintHash(fingerprint);
    store.prepareResumeEffect!(scope, effectId, fingerprintHash);
    store.markResumeEffectStarted!(scope, effectId);
    const result = await runToolLoop({
      agentId: scope.agentId,
      conversationId: scope.conversationId,
      turnId: scope.turnId,
      request: { model: scope.model, messages: [], tools: [{ type: "function", function: { name: "fixture_tool", description: "fixture", parameters: { type: "object" } } }] },
      executeTool: Object.assign(async () => {
        executions += 1;
        return { handled: true as const, ok: true, content: "should-not-run", result: { ok: true } };
      }, { canHandle: () => true }),
      resumableEffects,
      stream: async (_request, emit) => {
        emit({ type: "tool-call", call });
        return { aborted: false, message: { role: "assistant", content: "", toolCalls: [call] } };
      },
      onEvent: () => undefined,
    });
    expect(executions).toBe(0);
    expect(result.error?.code).toBe("unsafe_effect");
    expect(store.getResumeEffect!(scope, effectId)?.status).toBe("unsafe");
  });

  it("does not mark resume tool-calls as completed without executing them", async () => {
    const restore = overrideProviderCapability("openai-compat", "openai-compatible", { resume: "cursor" });
    try {
      const store = createMemoryTranscriptStore();
      const conversation = store.conversationStore!.ensureDefault("agent-a");
      const scope = { agentId: "agent-a", conversationId: conversation.id, turnId: "turn-tools", provider: "openai-compat", model: "openai-compatible" } as const;
      store.append("agent-a", [{
        kind: "message", id: "user-tools", role: "user", content: "resume", timestampMs: 1,
        streaming: false, turnId: scope.turnId, clientNonce: "nonce-tools", provider: scope.provider, model: scope.model,
      }], conversation.id);
      store.append("agent-a", [{
        kind: "message", id: "assistant-tools", role: "assistant", content: "partial", timestampMs: 2,
        streaming: false, turnId: scope.turnId, completionState: "interrupted",
      }], conversation.id);
      store.createResumeCheckpoint!({
        checkpointId: "checkpoint-tools", ...scope, cursor: "fixture-v1:tools:1", safeSequenceId: 1,
        completedEffectIds: [], expiresAtMs: 9_999_999_999_999, version: 1,
        budget: { maxProviderAttempts: 2, providerAttemptsUsed: 0, maxToolRounds: 8, toolRoundsUsed: 0, maxToolCalls: 16, toolCallsUsed: 0 },
      });
      const registry = createProviderRegistry();
      registry.register({
        name: "openai-compat",
        async streamChat() { /* unused */ },
        async resumeChat(_request, _cursor, emit) {
          emit({ type: "tool-call", call: { id: "call-1", type: "function", function: { name: "fixture_tool", arguments: "{}" } } });
        },
      });
      const runner = new TurnRunner({ store, registry, resolveProvider: () => ({ provider: scope.provider, model: scope.model }) });
      runner.resumePrompt(scope.agentId, scope.turnId, scope.conversationId);
      await runner.flush(scope.agentId);
      const tools = store.getEntries(scope.agentId, scope.conversationId).filter((entry) => entry.kind === "tool-call");
      expect(tools.some((entry) => entry.kind === "tool-call" && entry.status === "completed")).toBe(false);
      expect(store.getEntries(scope.agentId, scope.conversationId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "notice", id: `notice:${scope.turnId}:resume-unsafe_effect` }),
      ]));
    } finally {
      restore();
    }
  });

  it("fails closed on an expired checkpoint without calling the provider", () => {
    const store = createMemoryTranscriptStore();
    const conversation = store.conversationStore!.ensureDefault("agent-a");
    const scope = { agentId: "agent-a", conversationId: conversation.id, turnId: "turn-expired", provider: "openai-compat", model: "openai-compatible" } as const;
    store.append("agent-a", [{
      kind: "message", id: "user-expired", role: "user", content: "resume", timestampMs: 1,
      streaming: false, turnId: scope.turnId, clientNonce: "nonce-expired", provider: scope.provider, model: scope.model,
    }], conversation.id);
    store.createResumeCheckpoint!({
      checkpointId: "checkpoint-expired", ...scope, cursor: "fixture-v1:expired:1", safeSequenceId: 0,
      completedEffectIds: [], expiresAtMs: 1_000, version: 1,
      budget: { maxProviderAttempts: 2, providerAttemptsUsed: 0, maxToolRounds: 8, toolRoundsUsed: 0, maxToolCalls: 16, toolCallsUsed: 0 },
    });
    let providerCalls = 0;
    const registry = createProviderRegistry();
    registry.register({ name: "openai-compat", async streamChat() { providerCalls += 1; } });
    const runner = new TurnRunner({ store, registry, now: () => 2_000, resolveProvider: () => ({ provider: scope.provider, model: scope.model }) });

    expect(runner.resumePrompt(scope.agentId, scope.turnId, scope.conversationId)).toEqual({ accepted: true });
    expect(providerCalls).toBe(0);
    expect(store.getEntries(scope.agentId, scope.conversationId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "notice", id: `notice:${scope.turnId}:resume-expired_checkpoint` }),
    ]));
  });

  it("blocks resume when a crash left an unsafe effect outcome", () => {
    const store = createMemoryTranscriptStore();
    const conversation = store.conversationStore!.ensureDefault("agent-a");
    const scope = { agentId: "agent-a", conversationId: conversation.id, turnId: "turn-unsafe", provider: "openai-compat", model: "openai-compatible" } as const;
    store.append("agent-a", [{
      kind: "message", id: "user-unsafe", role: "user", content: "resume", timestampMs: 1,
      streaming: false, turnId: scope.turnId, clientNonce: "nonce-unsafe", provider: scope.provider, model: scope.model,
    }], conversation.id);
    store.createResumeCheckpoint!({
      checkpointId: "checkpoint-unsafe", ...scope, cursor: "fixture-v1:unsafe:1", safeSequenceId: 0,
      completedEffectIds: [], expiresAtMs: 9_999_999_999_999, version: 1,
      budget: { maxProviderAttempts: 2, providerAttemptsUsed: 0, maxToolRounds: 8, toolRoundsUsed: 0, maxToolCalls: 16, toolCallsUsed: 0 },
    });
    store.prepareResumeEffect!(scope, "effect:v1:unsafe", "hash-unsafe");
    store.markResumeEffectStarted!(scope, "effect:v1:unsafe");
    store.reconcileResumeEffects!(scope.agentId);
    let providerCalls = 0;
    const registry = createProviderRegistry();
    registry.register({ name: "openai-compat", async streamChat() { providerCalls += 1; } });
    const runner = new TurnRunner({ store, registry, now: () => 2_000, resolveProvider: () => ({ provider: scope.provider, model: scope.model }) });

    expect(runner.resumePrompt(scope.agentId, scope.turnId, scope.conversationId)).toEqual({ accepted: true });
    expect(providerCalls).toBe(0);
    expect(store.getEntries(scope.agentId, scope.conversationId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "notice", id: `notice:${scope.turnId}:resume-unsafe_effect` }),
    ]));
  });

  it("resumes an interrupted fixture turn with the same turn identity and no duplicate assistant", async () => {
    const restore = overrideProviderCapability("openai-compat", "openai-compatible", { resume: "cursor" });
    try {
      const store = createMemoryTranscriptStore();
      const conversation = store.conversationStore!.ensureDefault("agent-a");
      const registry = createProviderRegistry();
      let initialCalls = 0;
      const resumedCursors: string[] = [];
      registry.register({
        name: "openai-compat",
        async streamChat(_request, emit) {
          initialCalls += 1;
          emit({ type: "delta", delta: "prefix" });
          emit({ type: "resume-cursor", cursor: "fixture-v1:turn-a:1" });
          throw Object.assign(new Error("fixture abort"), { name: "AbortError" });
        },
        async resumeChat(request, cursor, emit) {
          expect(request.reasoningEffort).toBe("low");
          resumedCursors.push(cursor);
          emit({ type: "delta", delta: "suffix" });
        },
      });
      const runner = new TurnRunner({
        store,
        registry,
        resolveProvider: () => ({ provider: "openai-compat", model: "openai-compatible", reasoningEffort: "low" }),
      });
      runner.sendPrompt({ agentId: "agent-a", prompt: "resume me", clientNonce: "nonce-a", conversationId: conversation.id });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const user = store.getEntries("agent-a", conversation.id).find((entry) => entry.kind === "message" && entry.role === "user");
      expect(user?.kind).toBe("message");
      const turnId = user?.kind === "message" ? user.turnId : undefined;
      expect(turnId).toBeTypeOf("string");
      expect(store.findResumeCheckpoint!("agent-a", conversation.id, turnId! )?.cursor).toBe("fixture-v1:turn-a:1");
      runner.resumePrompt("agent-a", turnId!, conversation.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(initialCalls).toBe(1);
      expect(resumedCursors).toEqual(["fixture-v1:turn-a:1"]);
      const assistants = store.getEntries("agent-a", conversation.id).filter((entry) => entry.kind === "message" && entry.role === "assistant" && entry.turnId === turnId);
      expect(assistants).toHaveLength(1);
      expect(assistants[0]?.kind === "message" ? assistants[0].content : "").toBe("prefixsuffix");
    } finally {
      restore();
    }
  });

  it("persists the latest resume cursor from the same turn instead of freezing the first", async () => {
    const restore = overrideProviderCapability("openai-compat", "openai-compatible", { resume: "cursor" });
    try {
      const store = createMemoryTranscriptStore();
      const conversation = store.conversationStore!.ensureDefault("agent-a");
      const registry = createProviderRegistry();
      const resumedCursors: string[] = [];
      registry.register({
        name: "openai-compat",
        async streamChat(_request, emit) {
          emit({ type: "delta", delta: "prefix" });
          emit({ type: "resume-cursor", cursor: "fixture-v1:turn-a:1" });
          emit({ type: "resume-cursor", cursor: "fixture-v1:turn-a:2" });
          throw Object.assign(new Error("fixture abort"), { name: "AbortError" });
        },
        async resumeChat(_request, cursor, emit) {
          resumedCursors.push(cursor);
          emit({ type: "delta", delta: "suffix" });
        },
      });
      const runner = new TurnRunner({
        store,
        registry,
        resolveProvider: () => ({ provider: "openai-compat", model: "openai-compatible" }),
      });
      runner.sendPrompt({ agentId: "agent-a", prompt: "resume me", clientNonce: "nonce-latest", conversationId: conversation.id });
      await runner.flush("agent-a");
      const user = store.getEntries("agent-a", conversation.id).find((entry) => entry.kind === "message" && entry.role === "user");
      const turnId = user?.kind === "message" ? user.turnId : undefined;
      expect(store.findResumeCheckpoint!("agent-a", conversation.id, turnId!)?.cursor).toBe("fixture-v1:turn-a:2");
      runner.resumePrompt("agent-a", turnId!, conversation.id);
      await runner.flush("agent-a");
      expect(resumedCursors).toEqual(["fixture-v1:turn-a:2"]);
    } finally {
      restore();
    }
  });

  it("keeps ordinary tool rounds out of the recovery allowance", async () => {
    const restore = overrideProviderCapability("openai-compat", "openai-compatible", { resume: "cursor" });
    try {
      const store = createMemoryTranscriptStore();
      const conversation = store.conversationStore!.ensureDefault("agent-a");
      const registry = createProviderRegistry();
      const calls = [
        { id: "call-1", type: "function" as const, function: { name: "fixture_tool", arguments: '{"step":1}' } },
        { id: "call-2", type: "function" as const, function: { name: "fixture_tool", arguments: '{"step":2}' } },
      ];
      let initialRounds = 0;
      let executions = 0;
      let resumes = 0;
      registry.register({
        name: "openai-compat",
        async streamChat(_request, emit) {
          initialRounds += 1;
          if (initialRounds <= calls.length) {
            const call = calls[initialRounds - 1]!;
            emit({ type: "resume-cursor", cursor: `fixture-v1:multi:${initialRounds}` });
            emit({ type: "tool-call", call });
            return;
          }
          emit({ type: "resume-cursor", cursor: "fixture-v1:multi:3" });
          throw Object.assign(new Error("fixture abort after tool rounds"), { name: "AbortError" });
        },
        async resumeChat(_request, cursor, emit) {
          resumes += 1;
          expect(cursor).toBe("fixture-v1:multi:3");
          emit({ type: "delta", delta: "final" });
        },
      });
      const runner = new TurnRunner({
        store,
        registry,
        resolveProvider: () => ({ provider: "openai-compat", model: "openai-compatible" }),
        tools: [{ type: "function", function: { name: "fixture_tool", description: "fixture", parameters: { type: "object" } } }],
        toolExecutor: async () => {
          executions += 1;
          return { handled: true, ok: true, content: "ok", result: { ok: true } };
        },
      });

      runner.sendPrompt({ agentId: "agent-a", prompt: "run two steps", clientNonce: "nonce-multi", conversationId: conversation.id });
      await runner.flush("agent-a");
      const user = store.getEntries("agent-a", conversation.id).find((entry) => entry.kind === "message" && entry.role === "user");
      const turnId = user?.kind === "message" ? user.turnId : undefined;
      expect(turnId).toBeTypeOf("string");
      const before = store.findResumeCheckpoint!("agent-a", conversation.id, turnId!);
      expect(before?.budget).toMatchObject({ providerAttemptsUsed: 3, toolRoundsUsed: 2, toolCallsUsed: 2 });
      expect(before?.completedEffectIds).toHaveLength(2);

      runner.resumePrompt("agent-a", turnId!, conversation.id);
      await runner.flush("agent-a");

      const after = store.findResumeCheckpoint!("agent-a", conversation.id, turnId!);
      expect(resumes).toBe(1);
      expect(executions).toBe(2);
      expect(after?.budget.providerAttemptsUsed).toBe(4);
      expect(after?.completedEffectIds).toEqual(before?.completedEffectIds);
      const assistants = store.getEntries("agent-a", conversation.id).filter((entry) => entry.kind === "message" && entry.role === "assistant" && entry.turnId === turnId);
      expect(assistants).toHaveLength(1);
      expect(assistants[0]?.kind === "message" ? assistants[0].content : "").toBe("final");

      runner.resumePrompt("agent-a", turnId!, conversation.id);
      expect(resumes).toBe(1);
      expect(store.getEntries("agent-a", conversation.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "notice", id: `notice:${turnId}:resume-resume_aborted` }),
      ]));
    } finally {
      restore();
    }
  });

  it("persists the hard resume ceiling after progress extends beyond the soft window", async () => {
    const restore = overrideProviderCapability("openai-compat", "openai-compatible", { resume: "cursor" });
    try {
      const store = createMemoryTranscriptStore();
      const conversation = store.conversationStore!.ensureDefault("agent-a");
      const modelResolution = {
        entry: {
          id: "openai-compatible",
          provider: "openai-compat",
          displayName: "Fixture model",
          // Keep the adaptive soft window at its default 16 rounds. The
          // fixture then supplies a distinct successful result each round so
          // the loop must extend it before the interrupted recovery point.
          contextWindow: 64_000,
          maxOutputTokens: 1_024,
          maxRequestBytes: 1_048_576,
          tokenizerStrategy: "estimated",
          safetyMargin: 0.1,
        },
        capabilities: {
          streaming: true,
          tools: true,
          images: false,
          cancellation: "abort-signal",
          authentication: "keystore-api-key",
          usage: "stream-events",
          resume: "cursor",
          reasoning: false,
        },
        protocol: "chat",
      } as never;
      const calls = Array.from({ length: 17 }, (_, index) => ({
        id: `long-call-${index + 1}`,
        type: "function" as const,
        function: { name: "fixture_tool", arguments: JSON.stringify({ step: index + 1 }) },
      }));
      let initialRounds = 0;
      let executions = 0;
      let finalizationCalls = 0;
      let resumes = 0;
      const resumedCursors: string[] = [];
      const registry = createProviderRegistry();
      registry.register({
        name: "openai-compat",
        async streamChat(request, emit) {
          if (request.tools?.length === 0) {
            finalizationCalls += 1;
            emit({ type: "delta", delta: "unexpected soft-limit finalization" });
            return;
          }
          initialRounds += 1;
          if (initialRounds <= calls.length) {
            const call = calls[initialRounds - 1]!;
            emit({ type: "resume-cursor", cursor: `fixture-v1:long:${initialRounds}` });
            emit({ type: "tool-call", call });
            return;
          }
          emit({ type: "resume-cursor", cursor: "fixture-v1:long:18" });
          throw Object.assign(new Error("fixture abort after extended progress"), { name: "AbortError" });
        },
        async resumeChat(_request, cursor, emit) {
          resumes += 1;
          resumedCursors.push(cursor);
          emit({ type: "delta", delta: "final after extended progress" });
        },
      });
      const runner = new TurnRunner({
        store,
        registry,
        resolveProvider: () => ({ provider: "openai-compat", model: "openai-compatible", modelResolution }),
        tools: [{ type: "function", function: { name: "fixture_tool", description: "fixture", parameters: { type: "object" } } }],
        toolExecutor: async (context) => {
          executions += 1;
          return { handled: true, ok: true, content: `completed ${context.call.function.arguments}`, result: { ok: true } };
        },
      });

      runner.sendPrompt({ agentId: "agent-a", prompt: "run beyond the soft window", clientNonce: "nonce-long-resume", conversationId: conversation.id });
      await runner.flush("agent-a");
      const user = store.getEntries("agent-a", conversation.id).find((entry) => entry.kind === "message" && entry.role === "user");
      const turnId = user?.kind === "message" ? user.turnId : undefined;
      expect(turnId).toBeTypeOf("string");
      const before = store.findResumeCheckpoint!("agent-a", conversation.id, turnId!);
      expect(finalizationCalls).toBe(0);
      expect(initialRounds).toBe(18);
      expect(executions).toBe(17);
      expect(before).toMatchObject({ cursor: "fixture-v1:long:18", budget: { maxToolRounds: 128, maxToolCalls: 128, toolRoundsUsed: 17, toolCallsUsed: 17 } });
      expect(before?.budget.toolRoundsUsed).toBeGreaterThan(16);
      expect(before?.completedEffectIds).toHaveLength(17);

      runner.resumePrompt("agent-a", turnId!, conversation.id);
      await runner.flush("agent-a");
      const after = store.findResumeCheckpoint!("agent-a", conversation.id, turnId!);
      expect(resumes).toBe(1);
      expect(resumedCursors).toEqual(["fixture-v1:long:18"]);
      expect(executions).toBe(17);
      expect(after?.budget).toMatchObject({ maxToolRounds: 128, maxToolCalls: 128, providerAttemptsUsed: 19, toolRoundsUsed: 17, toolCallsUsed: 17 });
      expect(after?.completedEffectIds).toEqual(before?.completedEffectIds);
      const assistants = store.getEntries("agent-a", conversation.id).filter((entry) => entry.kind === "message" && entry.role === "assistant" && entry.turnId === turnId);
      expect(assistants).toHaveLength(1);
      expect(assistants[0]?.kind === "message" ? assistants[0].content : "").toBe("final after extended progress");
    } finally {
      restore();
    }
  });

  it("durably caps failed resume attempts before invoking the provider", async () => {
    const restore = overrideProviderCapability("openai-compat", "openai-compatible", { resume: "cursor" });
    try {
      const store = createMemoryTranscriptStore();
      const conversation = store.conversationStore!.ensureDefault("agent-a");
      const scope = { agentId: "agent-a", conversationId: conversation.id, turnId: "turn-failed-resume", provider: "openai-compat", model: "openai-compatible" } as const;
      store.append("agent-a", [{
        kind: "message", id: "user-failed-resume", role: "user", content: "resume", timestampMs: 1,
        streaming: false, turnId: scope.turnId, clientNonce: "nonce-failed-resume", provider: scope.provider, model: scope.model,
      }], conversation.id);
      store.append("agent-a", [{
        kind: "message", id: "assistant-failed-resume", role: "assistant", content: "partial", timestampMs: 2,
        streaming: false, turnId: scope.turnId, completionState: "interrupted",
      }], conversation.id);
      store.createResumeCheckpoint!({
        checkpointId: "checkpoint-failed-resume", ...scope, cursor: "fixture-v1:failed:1", safeSequenceId: 1,
        completedEffectIds: [], expiresAtMs: 9_999_999_999_999, version: 1,
        budget: { maxProviderAttempts: 2, providerAttemptsUsed: 1, maxToolRounds: 8, toolRoundsUsed: 0, maxToolCalls: 16, toolCallsUsed: 0 },
      });
      let providerCalls = 0;
      const registry = createProviderRegistry();
      registry.register({
        name: "openai-compat",
        async streamChat() { throw new Error("initial stream must not run"); },
        async resumeChat(_request, _cursor, emit) {
          providerCalls += 1;
          if (providerCalls === 2)
            emit({ type: "resume-cursor", cursor: "fixture-v1:failed:2" });
          throw new Error("fixture resume failure");
        },
      });
      const runner = new TurnRunner({ store, registry, resolveProvider: () => ({ provider: scope.provider, model: scope.model }) });

      runner.resumePrompt(scope.agentId, scope.turnId, scope.conversationId);
      await runner.flush(scope.agentId);
      expect(providerCalls).toBe(1);
      expect(store.findResumeCheckpoint!(scope.agentId, scope.conversationId, scope.turnId)?.budget.providerAttemptsUsed).toBe(2);

      runner.resumePrompt(scope.agentId, scope.turnId, scope.conversationId);
      await runner.flush(scope.agentId);
      expect(providerCalls).toBe(2);
      expect(store.findResumeCheckpoint!(scope.agentId, scope.conversationId, scope.turnId)).toMatchObject({
        cursor: "fixture-v1:failed:2",
        budget: { providerAttemptsUsed: 3 },
      });

      runner.resumePrompt(scope.agentId, scope.turnId, scope.conversationId);
      expect(providerCalls).toBe(2);
      expect(store.getEntries(scope.agentId, scope.conversationId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "notice", id: `notice:${scope.turnId}:resume-resume_budget_exhausted` }),
      ]));
    } finally {
      restore();
    }
  });

  it("consumes a reserved resume attempt when cancellation aborts the provider", async () => {
    const restore = overrideProviderCapability("openai-compat", "openai-compatible", { resume: "cursor" });
    try {
      const store = createMemoryTranscriptStore();
      const conversation = store.conversationStore!.ensureDefault("agent-a");
      const scope = { agentId: "agent-a", conversationId: conversation.id, turnId: "turn-cancelled-resume", provider: "openai-compat", model: "openai-compatible" } as const;
      store.append("agent-a", [{
        kind: "message", id: "user-cancelled-resume", role: "user", content: "resume", timestampMs: 1,
        streaming: false, turnId: scope.turnId, clientNonce: "nonce-cancelled-resume", provider: scope.provider, model: scope.model,
      }], conversation.id);
      store.append("agent-a", [{
        kind: "message", id: "assistant-cancelled-resume", role: "assistant", content: "partial", timestampMs: 2,
        streaming: false, turnId: scope.turnId, completionState: "interrupted",
      }], conversation.id);
      store.createResumeCheckpoint!({
        checkpointId: "checkpoint-cancelled-resume", ...scope, cursor: "fixture-v1:cancelled:1", safeSequenceId: 1,
        completedEffectIds: [], expiresAtMs: 9_999_999_999_999, version: 1,
        budget: { maxProviderAttempts: 2, providerAttemptsUsed: 1, maxToolRounds: 8, toolRoundsUsed: 0, maxToolCalls: 16, toolCallsUsed: 0 },
      });
      let providerCalls = 0;
      let started: () => void = () => undefined;
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      const registry = createProviderRegistry();
      registry.register({
        name: "openai-compat",
        async streamChat() { throw new Error("initial stream must not run"); },
        async resumeChat(request) {
          providerCalls += 1;
          started();
          await new Promise<void>((_resolve, reject) => {
            if (request.signal?.aborted) {
              reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
              return;
            }
            request.signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
          });
        },
      });
      const runner = new TurnRunner({ store, registry, resolveProvider: () => ({ provider: scope.provider, model: scope.model }) });

      runner.resumePrompt(scope.agentId, scope.turnId, scope.conversationId);
      await startedPromise;
      runner.cancelPrompt(scope.agentId);
      await runner.flush(scope.agentId);

      expect(providerCalls).toBe(1);
      expect(store.findResumeCheckpoint!(scope.agentId, scope.conversationId, scope.turnId)?.budget.providerAttemptsUsed).toBe(2);
      expect(store.getEntries(scope.agentId, scope.conversationId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "notice", id: `notice:${scope.turnId}:resume-ABORT_ERR` }),
      ]));
    } finally {
      restore();
    }
  });

  it("records live tool usage and completed effect ids on the resume checkpoint", async () => {
    const restore = overrideProviderCapability("openai-compat", "openai-compatible", { resume: "cursor" });
    try {
      const store = createMemoryTranscriptStore();
      const conversation = store.conversationStore!.ensureDefault("agent-a");
      const registry = createProviderRegistry();
      let rounds = 0;
      registry.register({
        name: "openai-compat",
        async streamChat(_request, emit) {
          rounds += 1;
          if (rounds === 1) {
            emit({ type: "resume-cursor", cursor: "fixture-v1:budget:1" });
            emit({ type: "tool-call", call: { id: "call-1", type: "function", function: { name: "fixture_tool", arguments: "{}" } } });
            return;
          }
          emit({ type: "resume-cursor", cursor: "fixture-v1:budget:2" });
          emit({ type: "delta", delta: "done" });
        },
        async resumeChat() {
          throw new Error("resume should not run during the original turn");
        },
      });
      const runner = new TurnRunner({
        store,
        registry,
        resolveProvider: () => ({ provider: "openai-compat", model: "openai-compatible" }),
        tools: [{ type: "function", function: { name: "fixture_tool", description: "fixture", parameters: { type: "object" } } }],
        toolExecutor: async () => ({ handled: true, ok: true, content: "ok", result: { ok: true } }),
      });
      runner.sendPrompt({ agentId: "agent-a", prompt: "use a tool", clientNonce: "nonce-budget", conversationId: conversation.id });
      await runner.flush("agent-a");
      const user = store.getEntries("agent-a", conversation.id).find((entry) => entry.kind === "message" && entry.role === "user");
      const turnId = user?.kind === "message" ? user.turnId : undefined;
      const checkpoint = store.findResumeCheckpoint!("agent-a", conversation.id, turnId!);
      expect(checkpoint?.budget.toolCallsUsed).toBeGreaterThanOrEqual(1);
      expect(checkpoint?.completedEffectIds.length).toBeGreaterThanOrEqual(1);
      expect(checkpoint?.completedEffectIds.every((id) => id.startsWith("effect:v1:"))).toBe(true);
    } finally {
      restore();
    }
  });

  it("rejects resume when the original turn budget is already exhausted", () => {
    const store = createMemoryTranscriptStore();
    const conversation = store.conversationStore!.ensureDefault("agent-a");
    const scope = { agentId: "agent-a", conversationId: conversation.id, turnId: "turn-budget", provider: "openai-compat", model: "openai-compatible" } as const;
    store.append("agent-a", [{
      kind: "message", id: "user-budget", role: "user", content: "resume", timestampMs: 1,
      streaming: false, turnId: scope.turnId, clientNonce: "nonce-budget-exhausted", provider: scope.provider, model: scope.model,
    }], conversation.id);
    store.createResumeCheckpoint!({
      checkpointId: "checkpoint-budget", ...scope, cursor: "fixture-v1:budget:exhausted", safeSequenceId: 0,
      completedEffectIds: ["effect:v1:done"], expiresAtMs: 9_999_999_999_999, version: 1,
      budget: { maxProviderAttempts: 3, providerAttemptsUsed: 1, maxToolRounds: 8, toolRoundsUsed: 1, maxToolCalls: 1, toolCallsUsed: 1 },
    });
    let providerCalls = 0;
    const registry = createProviderRegistry();
    registry.register({
      name: "openai-compat",
      async streamChat() { providerCalls += 1; },
      async resumeChat() { providerCalls += 1; },
    });
    const runner = new TurnRunner({ store, registry, now: () => 2_000, resolveProvider: () => ({ provider: scope.provider, model: scope.model }) });
    expect(runner.resumePrompt(scope.agentId, scope.turnId, scope.conversationId)).toEqual({ accepted: true });
    expect(providerCalls).toBe(0);
    expect(store.getEntries(scope.agentId, scope.conversationId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "notice", id: `notice:${scope.turnId}:resume-resume_budget_exhausted` }),
    ]));
  });

  it("rejects resume while the agent is fenced without calling the provider", () => {
    const store = createMemoryTranscriptStore();
    const conversation = store.conversationStore!.ensureDefault("agent-a");
    const scope = { agentId: "agent-a", conversationId: conversation.id, turnId: "turn-fenced", provider: "openai-compat", model: "openai-compatible" } as const;
    store.append("agent-a", [{
      kind: "message", id: "user-fenced", role: "user", content: "resume", timestampMs: 1,
      streaming: false, turnId: scope.turnId, clientNonce: "nonce-fenced", provider: scope.provider, model: scope.model,
    }], conversation.id);
    store.createResumeCheckpoint!({
      checkpointId: "checkpoint-fenced", ...scope, cursor: "fixture-v1:fenced:1", safeSequenceId: 0,
      completedEffectIds: [], expiresAtMs: 9_999_999_999_999, version: 1,
      budget: { maxProviderAttempts: 2, providerAttemptsUsed: 0, maxToolRounds: 8, toolRoundsUsed: 0, maxToolCalls: 16, toolCallsUsed: 0 },
    });
    let providerCalls = 0;
    const registry = createProviderRegistry();
    registry.register({
      name: "openai-compat",
      async streamChat() { providerCalls += 1; },
      async resumeChat() { providerCalls += 1; },
    });
    const runner = new TurnRunner({ store, registry, now: () => 2_000, resolveProvider: () => ({ provider: scope.provider, model: scope.model }) });
    runner.fenceAgents(["agent-a"]);
    expect(() => runner.resumePrompt(scope.agentId, scope.turnId, scope.conversationId)).toThrow(/exclusão|409/i);
    expect(providerCalls).toBe(0);
  });

  it("rechecks checkpoint expiry after the agent queue delay before calling the provider", async () => {
    const restore = overrideProviderCapability("openai-compat", "openai-compatible", { resume: "cursor" });
    try {
      const store = createMemoryTranscriptStore();
      const conversation = store.conversationStore!.ensureDefault("agent-a");
      const scope = { agentId: "agent-a", conversationId: conversation.id, turnId: "turn-queued-expiry", provider: "openai-compat", model: "openai-compatible" } as const;
      store.append("agent-a", [{
        kind: "message", id: "user-queued-expiry", role: "user", content: "resume", timestampMs: 1,
        streaming: false, turnId: scope.turnId, clientNonce: "nonce-queued-expiry", provider: scope.provider, model: scope.model,
      }], conversation.id);
      store.createResumeCheckpoint!({
        checkpointId: "checkpoint-queued-expiry", ...scope, cursor: "fixture-v1:queued:1", safeSequenceId: 0,
        completedEffectIds: [], expiresAtMs: 1_500, version: 1,
        budget: { maxProviderAttempts: 2, providerAttemptsUsed: 0, maxToolRounds: 8, toolRoundsUsed: 0, maxToolCalls: 16, toolCallsUsed: 0 },
      });
      let nowMs = 1_000;
      let releaseHang: () => void = () => undefined;
      const hang = new Promise<void>((resolve) => { releaseHang = resolve; });
      let resumeChatCalls = 0;
      const registry = createProviderRegistry();
      registry.register({
        name: "openai-compat",
        async streamChat() {
          await hang;
        },
        async resumeChat() {
          resumeChatCalls += 1;
        },
      });
      const runner = new TurnRunner({
        store,
        registry,
        now: () => nowMs,
        resolveProvider: () => ({ provider: scope.provider, model: scope.model }),
      });
      runner.sendPrompt({ agentId: "agent-a", prompt: "block the queue", clientNonce: "nonce-block", conversationId: conversation.id });
      expect(runner.resumePrompt(scope.agentId, scope.turnId, scope.conversationId)).toEqual({ accepted: true });
      nowMs = 2_000;
      releaseHang();
      await runner.flush("agent-a");
      expect(resumeChatCalls).toBe(0);
      expect(store.getEntries(scope.agentId, scope.conversationId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "notice", id: `notice:${scope.turnId}:resume-expired_checkpoint` }),
      ]));
    } finally {
      restore();
    }
  });

  it("rejects resume of a deleted conversation without calling the provider", () => {
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      const keep = transcript.conversationStore.ensureDefault("agent-a");
      const gone = transcript.conversationStore.create("agent-a", { title: "Apagar" });
      const scope = { agentId: "agent-a", conversationId: gone.id, turnId: "turn-deleted", provider: "openai-compat", model: "openai-compatible" } as const;
      transcript.append("agent-a", [{
        kind: "message", id: "user-deleted", role: "user", content: "resume", timestampMs: 1,
        streaming: false, turnId: scope.turnId, clientNonce: "nonce-deleted", provider: scope.provider, model: scope.model,
      }], gone.id);
      transcript.createResumeCheckpoint({
        checkpointId: "checkpoint-deleted", ...scope, cursor: "fixture-v1:deleted:1", safeSequenceId: 0,
        completedEffectIds: [], expiresAtMs: 9_999_999_999_999, version: 1,
        budget: { maxProviderAttempts: 2, providerAttemptsUsed: 0, maxToolRounds: 8, toolRoundsUsed: 0, maxToolCalls: 16, toolCallsUsed: 0 },
      });
      transcript.conversationStore.activate("agent-a", keep.id);
      transcript.conversationStore.delete("agent-a", gone.id, { memoryPolicy: "delete-derived" });
      let providerCalls = 0;
      const registry = createProviderRegistry();
      registry.register({ name: "openai-compat", async streamChat() { providerCalls += 1; }, async resumeChat() { providerCalls += 1; } });
      const runner = new TurnRunner({ store: transcript, registry, resolveProvider: () => ({ provider: scope.provider, model: scope.model }) });
      expect(() => runner.resumePrompt(scope.agentId, scope.turnId, gone.id)).toThrow(/não encontrada/i);
      expect(providerCalls).toBe(0);
      expect(transcript.findResumeCheckpoint(scope.agentId, gone.id, scope.turnId)).toBeUndefined();
    } finally {
      transcript.close();
    }
  });
});
