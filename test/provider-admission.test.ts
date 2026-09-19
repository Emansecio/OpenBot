import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_MAX_ACTIVE,
  DEFAULT_PROVIDER_MAX_QUEUED,
  DEFAULT_PROVIDER_MAX_QUEUED_PER_AGENT,
  ProviderAdmissionScheduler,
  createProviderAdmissionFromEnv,
  providerAdmissionOptionsFromEnv,
} from "../src/providers/admission.js";
import { createProviderRegistry, streamChat } from "../src/providers/router.js";
import { createMemoryTranscriptStore, createTurnRunner } from "../src/rpc/send.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("global provider admission", () => {
  it("defaults to four active calls and a separate bounded queue", () => {
    const scheduler = new ProviderAdmissionScheduler();
    expect(scheduler.maxActive).toBe(DEFAULT_PROVIDER_MAX_ACTIVE);
    expect(scheduler.maxQueued).toBe(DEFAULT_PROVIDER_MAX_QUEUED);
    expect(scheduler.maxQueuedPerAgent).toBe(DEFAULT_PROVIDER_MAX_QUEUED_PER_AGENT);
  });

  it("keeps FIFO inside an agent and round-robins different agents", async () => {
    let clock = 0;
    const scheduler = new ProviderAdmissionScheduler({ maxActive: 1, maxQueued: 8, now: () => clock });
    const first = await scheduler.acquire("a");
    const order: string[] = [];
    const a1 = scheduler.acquire("a").then((lease) => { order.push("a1"); return lease; });
    const a2 = scheduler.acquire("a").then((lease) => { order.push("a2"); return lease; });
    const b1 = scheduler.acquire("b").then((lease) => { order.push("b1"); return lease; });
    expect(scheduler.metrics().waiting).toBe(3);
    first.release();
    const leaseA1 = await a1;
    clock = 5;
    leaseA1.release();
    const leaseB1 = await b1;
    leaseB1.release();
    const leaseA2 = await a2;
    leaseA2.release();
    expect(order).toEqual(["a1", "b1", "a2"]);
    expect(scheduler.metrics().waitTimeObservations.count).toBe(3);
  });

  it("round-robins agents when each has multiple waiters", async () => {
    const scheduler = new ProviderAdmissionScheduler({ maxActive: 1, maxQueued: 8 });
    const first = await scheduler.acquire("owner");
    const order: string[] = [];
    const a1 = scheduler.acquire("a").then((lease) => { order.push("a1"); return lease; });
    const a2 = scheduler.acquire("a").then((lease) => { order.push("a2"); return lease; });
    const b1 = scheduler.acquire("b").then((lease) => { order.push("b1"); return lease; });
    const b2 = scheduler.acquire("b").then((lease) => { order.push("b2"); return lease; });
    first.release();
    const l1 = await a1; l1.release();
    const l2 = await b1; l2.release();
    const l3 = await a2; l3.release();
    const l4 = await b2; l4.release();
    expect(order).toEqual(["a1", "b1", "a2", "b2"]);
  });

  it("caps one agent's waiting queue while preserving another agent's progress", async () => {
    const scheduler = new ProviderAdmissionScheduler({ maxActive: 1, maxQueued: 3, maxQueuedPerAgent: 2 });
    const active = await scheduler.acquire("a");
    const order: string[] = [];
    const a1 = scheduler.acquire("a").then((lease) => { order.push("a1"); return lease; });
    const a2 = scheduler.acquire("a").then((lease) => { order.push("a2"); return lease; });
    const a3 = scheduler.acquire("a").catch((error: unknown) => error);
    const b1 = scheduler.acquire("b").then((lease) => { order.push("b1"); return lease; });
    expect(await a3).toMatchObject({ code: "agent-queue-full" });
    expect(scheduler.metrics()).toMatchObject({ active: 1, waiting: 3, rejected: 1 });
    active.release();
    const l1 = await a1; l1.release();
    const l2 = await b1; l2.release();
    const l3 = await a2; l3.release();
    expect(order).toEqual(["a1", "b1", "a2"]);
    expect(scheduler.metrics()).toMatchObject({ active: 0, waiting: 0 });
  });

  it("normalizes agent queue rejection and does not retry through streamChat", async () => {
    const scheduler = new ProviderAdmissionScheduler({ maxActive: 1, maxQueued: 3, maxQueuedPerAgent: 2 });
    const active = await scheduler.acquire("a");
    const queued1 = scheduler.acquire("a").catch((error: unknown) => error);
    const queued2 = scheduler.acquire("a").catch((error: unknown) => error);
    const registry = createProviderRegistry();
    let calls = 0;
    let sleeps = 0;
    registry.register({ name: "agent-full", async streamChat() { calls += 1; } });
    const result = await streamChat("agent-full", { model: "fixture", messages: [] }, undefined, {
      registry,
      admission: scheduler,
      agentId: "a",
      maxRetries: 2,
      sleep: async () => { sleeps += 1; },
    });
    expect(result.error).toMatchObject({ code: "PROVIDER_ADMISSION_AGENT_QUEUE_FULL", retryable: true });
    expect(calls).toBe(0);
    expect(sleeps).toBe(0);
    scheduler.shutdown();
    expect(await queued1).toMatchObject({ code: "shutdown" });
    expect(await queued2).toMatchObject({ code: "shutdown" });
    active.release();
  });

  it("removes an aborted waiter without consuming a slot", async () => {
    const scheduler = new ProviderAdmissionScheduler({ maxActive: 1, maxQueued: 2 });
    const active = await scheduler.acquire("a");
    const controller = new AbortController();
    const waiting = scheduler.acquire("b", controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
    expect(scheduler.metrics()).toMatchObject({ active: 1, waiting: 0, aborted: 1 });
    active.release();
  });

  it("cleans timeout listeners and permits reusing the same abort signal", async () => {
    vi.useFakeTimers();
    const scheduler = new ProviderAdmissionScheduler({ maxActive: 1, maxQueued: 8 });
    const active = await scheduler.acquire("holder");
    const controller = new AbortController();
    const waiting = [
      scheduler.acquire("queued", { signal: controller.signal, maxWaitMs: 5 }),
      scheduler.acquire("queued", { signal: controller.signal, maxWaitMs: 5 }),
      scheduler.acquire("queued", { signal: controller.signal, maxWaitMs: 5 }),
    ];
    const rejections = waiting.map((promise) => expect(promise).rejects.toMatchObject({ code: "wait-timeout" }));

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5);
    await Promise.all(rejections);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(scheduler.waitingCount).toBe(0);

    active.release();
    const reused = await scheduler.acquire("reused", controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    reused.release();
  });

  it("cleans the abort listener when a queued waiter is aborted", async () => {
    const scheduler = new ProviderAdmissionScheduler({ maxActive: 1, maxQueued: 2 });
    const active = await scheduler.acquire("holder");
    const controller = new AbortController();
    const waiting = scheduler.acquire("queued", { signal: controller.signal, maxWaitMs: 1_000 });
    const rejection = expect(waiting).rejects.toMatchObject({ code: "aborted" });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort();
    await rejection;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(scheduler.waitingCount).toBe(0);
    active.release();
  });

  it("cleans queued listeners during shutdown", async () => {
    const scheduler = new ProviderAdmissionScheduler({ maxActive: 1, maxQueued: 2 });
    const active = await scheduler.acquire("holder");
    const controller = new AbortController();
    const waiting = [
      scheduler.acquire("queued", { signal: controller.signal, maxWaitMs: 1_000 }),
      scheduler.acquire("queued-two", { signal: controller.signal, maxWaitMs: 1_000 }),
    ];
    const rejections = waiting.map((promise) => expect(promise).rejects.toMatchObject({ code: "shutdown" }));

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(2);
    scheduler.shutdown();
    await Promise.all(rejections);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(scheduler.waitingCount).toBe(0);
    active.release();
    await scheduler.drain();
  });

  it("cleans timer and abort listener when a waiter is admitted", async () => {
    vi.useFakeTimers();
    const scheduler = new ProviderAdmissionScheduler({ maxActive: 1, maxQueued: 2 });
    const active = await scheduler.acquire("holder");
    const controller = new AbortController();
    const waiting = scheduler.acquire("queued", { signal: controller.signal, maxWaitMs: 1_000 });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    active.release();
    const lease = await waiting;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scheduler.activeCount).toBe(1);
    lease.release();
  });

  it("rejects a full global queue and releases the slot after failures", async () => {
    const scheduler = new ProviderAdmissionScheduler({ maxActive: 1, maxQueued: 1 });
    const active = await scheduler.acquire("a");
    const queued = scheduler.acquire("b");
    await expect(scheduler.acquire("c")).rejects.toMatchObject({ code: "queue-full" });
    active.release();
    (await queued).release();
    expect(scheduler.metrics()).toMatchObject({ active: 0, waiting: 0, rejected: 1 });

    const registry = createProviderRegistry();
    let calls = 0;
    registry.register({
      name: "retry",
      async streamChat(_request, emit) {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("temporary"), { status: 503 });
        emit({ type: "delta", delta: "ok" });
      },
    });
    const result = await streamChat("retry", { model: "m", messages: [] }, undefined, {
      registry,
      maxRetries: 1,
      sleep: async () => undefined,
      admission: scheduler,
      agentId: "retry-agent",
    });
    expect(result.message?.content).toBe("ok");
    expect(calls).toBe(2);
    expect(scheduler.metrics().active).toBe(0);
    expect(scheduler.metrics().admitted).toBe(4);
  });

  it("router rejects queue-full immediately without an internal retry", async () => {
    const scheduler = new ProviderAdmissionScheduler({ maxActive: 1, maxQueued: 1 });
    const blocker = await scheduler.acquire("blocker");
    const queued = scheduler.acquire("queued");
    const registry = createProviderRegistry();
    let calls = 0;
    let sleeps = 0;
    registry.register({
      name: "full",
      async streamChat() { calls += 1; },
    });
    const result = await streamChat("full", { model: "m", messages: [] }, undefined, {
      registry,
      maxRetries: 2,
      sleep: async () => { sleeps += 1; },
      admission: scheduler,
      agentId: "full-agent",
    });
    expect(result.error).toMatchObject({
      code: "PROVIDER_ADMISSION_QUEUE_FULL",
      retryable: true,
    });
    expect(calls).toBe(0);
    expect(sleeps).toBe(0);
    expect(scheduler.metrics()).toMatchObject({ rejected: 1, active: 1, waiting: 1 });
    scheduler.shutdown();
    await expect(queued).rejects.toMatchObject({ code: "shutdown" });
    blocker.release();
  });

  it("uses the same admission singleton for direct turns and tool-loop rounds", async () => {
    const scheduler = new ProviderAdmissionScheduler({ maxActive: 1, maxQueued: 4 });
    const registry = createProviderRegistry();
    let calls = 0;
    registry.register({
      name: "shared",
      async streamChat(request, emit) {
        calls += 1;
        const hasToolResult = request.messages.some((message) => message.role === "tool");
        if (calls === 2 && !hasToolResult) {
          emit({
            type: "tool-call",
            call: { id: "call-1", type: "function", function: { name: "echo", arguments: "{}" } },
          });
        } else {
          emit({ type: "delta", delta: calls === 1 ? "direct" : "tool-final" });
        }
      },
    });
    const direct = createTurnRunner({
      registry,
      admission: scheduler,
      store: createMemoryTranscriptStore(),
      resolveProvider: () => ({ provider: "shared", model: "fixture" }),
    });
    direct.sendPrompt({ agentId: "direct-agent", prompt: "direct" });
    await direct.flush("direct-agent");

    const tool = createTurnRunner({
      registry,
      admission: scheduler,
      store: createMemoryTranscriptStore(),
      resolveProvider: () => ({ provider: "shared", model: "fixture" }),
      tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }],
      toolExecutor: async () => ({ handled: true, ok: true, content: "tool ok", result: { ok: true, operation: "echo" } }),
    });
    tool.sendPrompt({ agentId: "tool-agent", prompt: "tool" });
    await tool.flush("tool-agent");

    expect(calls).toBe(3);
    expect(scheduler.metrics()).toMatchObject({ active: 0, waiting: 0, admitted: 3 });
  });

  it("settles queued waiters on shutdown and drains active leases", async () => {
    const scheduler = new ProviderAdmissionScheduler({ maxActive: 1, maxQueued: 4 });
    const active = await scheduler.acquire("a");
    const waiting = scheduler.acquire("b");
    scheduler.shutdown();
    await expect(waiting).rejects.toMatchObject({ code: "shutdown" });
    let drained = false;
    const drain = scheduler.drain().then(() => { drained = true; });
    expect(drained).toBe(false);
    active.release();
    await drain;
    expect(drained).toBe(true);
    await expect(scheduler.acquire("c")).rejects.toMatchObject({ code: "shutdown" });
  });

  it("rejects malformed production overrides instead of disabling the cap", () => {
    expect(() => providerAdmissionOptionsFromEnv({ OPENBOT_PROVIDER_MAX_ACTIVE: "0" })).toThrow(/OPENBOT_PROVIDER_MAX_ACTIVE/);
    expect(() => providerAdmissionOptionsFromEnv({ OPENBOT_PROVIDER_MAX_ACTIVE: "1.5" })).toThrow(/OPENBOT_PROVIDER_MAX_ACTIVE/);
    expect(() => providerAdmissionOptionsFromEnv({ OPENBOT_PROVIDER_MAX_QUEUED: "4097" })).toThrow(/OPENBOT_PROVIDER_MAX_QUEUED/);
    expect(() => new ProviderAdmissionScheduler({ maxQueuedPerAgent: 0 })).toThrow(/maxQueuedPerAgent/);
    expect(() => new ProviderAdmissionScheduler({ maxQueuedPerAgent: 4097 })).toThrow(/maxQueuedPerAgent/);
  });

  it("accepts exact bounded production overrides", () => {
    expect(providerAdmissionOptionsFromEnv({
      OPENBOT_PROVIDER_MAX_ACTIVE: "2",
      OPENBOT_PROVIDER_MAX_QUEUED: "17",
    })).toEqual({ maxActive: 2, maxQueued: 17 });
    expect(createProviderAdmissionFromEnv({
      OPENBOT_PROVIDER_MAX_ACTIVE: "2",
      OPENBOT_PROVIDER_MAX_QUEUED: "17",
    })).toMatchObject({ maxActive: 2, maxQueued: 17 });
  });
});
