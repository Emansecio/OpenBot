import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { A2ARuntime, type A2ARuntimeOptions } from "../src/a2a/runtime.js";
import { A2AStore } from "../src/a2a/store.js";
import { consumeA2ATurn } from "../src/a2a/turn-consumer.js";
import type { A2AEnvelope } from "../src/a2a/contracts.js";
import { createTurnRunner } from "../src/rpc/send.js";
import { createProviderRegistry } from "../src/providers/router.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { createFakeAdapter } from "./mocks/fake-provider-adapter.js";

type SendInput = Omit<A2AEnvelope, "senderIncarnation" | "recipientIncarnation">;
const roots: string[] = [];
const stores = new Set<A2AStore>();
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function envelope(id: string, priority: "normal" | "high" = "normal", recipientAgentId = "agent-b"): SendInput {
  return {
    version: 1, messageId: id, senderAgentId: "agent-a", recipientAgentId,
    nonce: `nonce-${id}`, parentTaskId: null, parentTurnId: "turn-1", priority, hopCount: 0,
    payload: { version: 1, kind: "text", text: id }, createdAtMs: 1_000, availableAtMs: 1_000, expiresAtMs: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for A2A state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function runtimeHarness() {
  const root = mkdtempSync(join(tmpdir(), "openbot-a2a-runtime-"));
  roots.push(root);
  let userBusy = false;
  let userPending = false;
  let consume: NonNullable<A2ARuntimeOptions["consume"]> = async ({ message }) => ({ ackNonce: `ack-${message.messageId}` });
  const store = new A2AStore({ path: join(root, "store.db"), now: () => 1_000, sensitiveValues: () => [] });
  stores.add(store);
  store.syncActiveAgents(["agent-a", "agent-b", "agent-c"]);
  store.ensureAgentIncarnation("agent-a");
  store.ensureAgentIncarnation("agent-b");
  store.ensureAgentIncarnation("agent-c");
  const options: A2ARuntimeOptions = {
    store,
    agentIds: () => ["agent-b", "agent-c"],
    isUserLaneBusy: () => userBusy,
    isUserLanePending: () => userPending,
    consume: (context) => consume(context),
    pollIntervalMs: 1,
  };
  return {
    store,
    options,
    setUserBusy: (value: boolean) => { userBusy = value; },
    setUserPending: (value: boolean) => { userPending = value; },
    setConsume: (value: typeof consume) => { consume = value; },
  };
}

describe("P2.1 A2A runtime", () => {
  it("persists before wake and boot-scans a message when the physical wake was lost", async () => {
    const h = runtimeHarness();
    h.store.send(envelope("lost-wake"));
    const consumed = deferred<string>();
    h.setConsume(async ({ message }) => { consumed.resolve(message.messageId); return { ackNonce: "ack-lost-wake" }; });
    const runtime = new A2ARuntime(h.options);
    runtime.start();
    await consumed.promise;
    await waitFor(() => h.store.getMessage("lost-wake")?.status === "acked");
    expect(h.store.getMessage("lost-wake")).toMatchObject({ status: "acked" });
    await runtime.stop();
  });

  it("keeps user work ahead of A2A without preempting an active user turn", async () => {
    const h = runtimeHarness();
    h.store.send(envelope("normal", "normal"));
    h.store.send(envelope("high", "high"));
    const order: string[] = [];
    const consumed = deferred<void>();
    h.setUserBusy(true);
    h.setConsume(async ({ message }) => { order.push(message.messageId); if (order.length === 2) consumed.resolve(); return { ackNonce: `ack-${message.messageId}` }; });
    const runtime = new A2ARuntime(h.options);
    runtime.start();
    await Promise.resolve();
    expect(order).toEqual([]);
    h.setUserBusy(false);
    runtime.wake();
    await consumed.promise;
    expect(order.slice().sort()).toEqual(["high", "normal"].sort());
    await runtime.stop();
  });

  it("also blocks A2A while a user turn is pending, then admits it after release", async () => {
    const h = runtimeHarness();
    h.store.send(envelope("pending-user"));
    const consumed = deferred<void>();
    const order: string[] = [];
    h.setUserPending(true);
    h.setConsume(async ({ message }) => { order.push(message.messageId); consumed.resolve(); return { ackNonce: "ack-pending-user" }; });
    const runtime = new A2ARuntime(h.options);
    runtime.start();
    await Promise.resolve();
    expect(order).toEqual([]);
    h.setUserPending(false);
    runtime.wake();
    await consumed.promise;
    expect(order).toEqual(["pending-user"]);
    await runtime.stop();
  });

  it("orders high before normal for one recipient while giving another recipient a fair turn", async () => {
    const h = runtimeHarness();
    h.store.send(envelope("b-normal", "normal", "agent-b"));
    h.store.send(envelope("b-high", "high", "agent-b"));
    h.store.send(envelope("c-normal", "normal", "agent-c"));
    const order: string[] = [];
    const consumed = deferred<void>();
    h.setConsume(async ({ message }) => { order.push(message.messageId); if (order.length === 3) consumed.resolve(); return { ackNonce: `ack-${message.messageId}` }; });
    const runtime = new A2ARuntime(h.options);
    runtime.start();
    await consumed.promise;
    expect(order.indexOf("b-high")).toBeLessThan(order.indexOf("b-normal"));
    expect(order.indexOf("c-normal")).toBeLessThan(order.indexOf("b-normal"));
    await runtime.stop();
  });

  it("redelivers after a consumer crash and terminates after the attempt cap", async () => {
    const h = runtimeHarness();
    h.store.send(envelope("crash"));
    let calls = 0;
    const finished = deferred<void>();
    h.setConsume(async () => { calls += 1; if (calls === 2) finished.resolve(); throw new Error("consumer crash"); });
    const runtime = new A2ARuntime({ ...h.options, maxAttempts: 2, retryDelayMs: 0 });
    runtime.start();
    await finished.promise;
    await waitFor(() => h.store.getMessage("crash")?.status === "dead");
    expect(calls).toBe(2);
    expect(h.store.getMessage("crash")).toMatchObject({ status: "dead", attempt: 2 });
    await runtime.stop();
  });

  it("rejects a durably partial consumer turn instead of ACKing it", async () => {
    const h = runtimeHarness();
    h.store.send(envelope("partial-turn"));
    h.setConsume(async () => ({ ackNonce: "must-not-ack", outcome: "partial" }));
    const runtime = new A2ARuntime(h.options);
    runtime.start();
    await waitFor(() => h.store.getMessage("partial-turn")?.status === "rejected");
    expect(h.store.getMessage("partial-turn")).toMatchObject({
      status: "rejected",
      ackNonce: null,
      terminalReason: "turn-partial",
    });
    await runtime.stop();
  });

  it("fails closed instead of ACKing an accepted nonce whose turn crashed before completion", async () => {
    const h = runtimeHarness();
    const message = h.store.send(envelope("false-ack-window")).message;
    const transcriptPath = join(roots.at(-1)!, "transcript.db");
    const nonce = `a2a:${message.messageId}`;

    const beforeCrash = new SqliteTranscriptStore({ path: transcriptPath });
    const conversationId = beforeCrash.conversationStore.ensureDefault(message.recipientAgentId).id;
    beforeCrash.claimAcceptedNonce(message.recipientAgentId, nonce, conversationId);
    beforeCrash.beginTurnAttempt({
      turnId: "turn:crashed-a2a",
      agentId: message.recipientAgentId,
      conversationId,
      clientNonce: nonce,
      provider: "xai",
      model: "grok-4.6",
      phase: "provider-pending",
      startedAtMs: 1_000,
    });
    beforeCrash.append(message.recipientAgentId, [{
      kind: "message",
      id: "user:crashed-a2a",
      role: "user",
      content: "false-ack-window",
      timestampMs: 1_000,
      turnId: "turn:crashed-a2a",
      clientNonce: nonce,
    }], conversationId);
    beforeCrash.rememberAcceptedNonce(message.recipientAgentId, nonce, conversationId);
    beforeCrash.close();

    const afterRestart = new SqliteTranscriptStore({ path: transcriptPath });
    try {
      const registry = createProviderRegistry();
      const adapter = createFakeAdapter("xai", { deltas: ["must not run"] });
      registry.register(adapter);
      const runner = createTurnRunner({ registry, store: afterRestart });

      await expect(consumeA2ATurn(runner, message)).rejects.toThrow(/durable completion/i);
      expect(runner.isPromptCompleted(message.recipientAgentId, nonce)).toBe(false);
      expect(adapter.invocations).toHaveLength(0);
    } finally {
      afterRestart.close();
    }
  });

  it("heartbeats a slow consumer and ACKs with the latest lease version", async () => {
    vi.useFakeTimers();
    const h = runtimeHarness();
    h.store.send(envelope("slow"));
    h.setConsume(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { ackNonce: "ack-slow" };
    });
    const runtime = new A2ARuntime({ ...h.options, leaseDurationMs: 30 });
    runtime.start();
    await vi.advanceTimersByTimeAsync(80);
    expect(h.store.getMessage("slow")).toMatchObject({ status: "acked", ackNonce: "ack-slow" });
    expect(h.store.getMessage("slow")!.version).toBeGreaterThan(3);
    await runtime.stop();
  });

  it("stops promptly even when an in-flight consumer ignores its AbortSignal", async () => {
    const h = runtimeHarness();
    h.store.send(envelope("uncooperative-consumer"));
    const started = deferred<void>();
    h.setConsume(async () => {
      started.resolve();
      await new Promise<void>(() => undefined);
    });
    const runtime = new A2ARuntime(h.options);
    runtime.start();
    await started.promise;

    const stopped = await Promise.race([
      runtime.stop().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    expect(stopped).toBe(true);
    expect(h.store.getMessage("uncooperative-consumer")).toMatchObject({ status: "delivering" });
  });

  it("replays an unaccepted durable projection and acknowledges it only after publication", async () => {
    const h = runtimeHarness();
    h.store.send(envelope("projection"));
    const published: string[] = [];
    let rejectFirstQueued = true;
    const runtime = new A2ARuntime({
      ...h.options,
      publishProjection: (event) => {
        published.push(event.eventKind);
        if (event.eventKind === "queued" && rejectFirstQueued) {
          rejectFirstQueued = false;
          return false;
        }
        return true;
      },
    });
    runtime.start();
    await waitFor(() => h.store.getMessage("projection")?.status === "acked" && h.store.projectUndelivered().length === 0);
    expect(published.filter((kind) => kind === "queued").length).toBeGreaterThanOrEqual(2);
    expect(published).toContain("delivering");
    expect(published).toContain("acked");
    await runtime.stop();
  });

  it("periodically scans after restart without requiring a physical wake", async () => {
    vi.useFakeTimers();
    const h = runtimeHarness();
    const firstScan = deferred<void>();
    const first = new A2ARuntime({
      ...h.options,
      agentIds: () => {
        firstScan.resolve();
        return h.options.agentIds();
      },
    });
    first.start();
    await firstScan.promise;
    await first.stop();
    const consumed = deferred<void>();
    const initialScan = deferred<void>();
    let scans = 0;
    h.setConsume(async () => { consumed.resolve(); return { ackNonce: "ack-restart-scan" }; });
    const restarted = new A2ARuntime({
      ...h.options,
      pollIntervalMs: 50,
      agentIds: () => {
        scans += 1;
        if (scans === 1) initialScan.resolve();
        return h.options.agentIds();
      },
    });
    restarted.start();
    await initialScan.promise;
    h.store.send(envelope("restart-scan"));
    expect(h.store.getMessage("restart-scan")).toMatchObject({ status: "queued" });
    await vi.advanceTimersByTimeAsync(49);
    expect(h.store.getMessage("restart-scan")).toMatchObject({ status: "queued" });
    await vi.advanceTimersByTimeAsync(1);
    await consumed.promise;
    expect(h.store.getMessage("restart-scan")).toMatchObject({ status: "acked" });
    await restarted.stop();
  });

  it("keeps delivering after a failing pass instead of stopping the loop", async () => {
    const h = runtimeHarness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hasActive = h.store.hasActiveMessages.bind(h.store);
    let failures = 1;
    h.store.hasActiveMessages = () => {
      if (failures > 0) { failures -= 1; throw new Error("transient read failure"); }
      return hasActive();
    };
    const runtime = new A2ARuntime(h.options);
    runtime.start();
    h.store.send(envelope("after-failure"));
    await waitFor(() => h.store.getMessage("after-failure")?.status === "acked");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("transient read failure"));
    await runtime.stop();
  });

  it("does no write transaction and no per-agent claim while idle", async () => {
    const h = runtimeHarness();
    const recover = vi.spyOn(h.store, "recoverExpired");
    const claim = vi.spyOn(h.store, "claimNext");
    const runtime = new A2ARuntime(h.options);
    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(recover).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    h.store.send(envelope("wakes-work"));
    runtime.wake();
    await waitFor(() => h.store.getMessage("wakes-work")?.status === "acked");
    // Recovery runs once per pass, not once more inside every claim.
    expect(claim.mock.calls.every(([, options]) => options.recover === false)).toBe(true);
    await runtime.stop();
  });

  it("stops waiting for the recipient turn when the delivery is aborted", async () => {
    let releaseFlush: (() => void) | undefined;
    const runner = {
      sendAgentPrompt: async () => ({ accepted: true }),
      flush: () => new Promise<void>((resolve) => { releaseFlush = resolve; }),
      promptOutcome: () => "success" as const,
    };
    const controller = new AbortController();
    const h = runtimeHarness();
    h.store.send(envelope("aborted-wait"));
    const pending = consumeA2ATurn(runner as never, h.store.getMessage("aborted-wait")!, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    releaseFlush?.();
  });

  it("purges every row of a deleted agent and prunes only finished history", () => {
    const h = runtimeHarness();
    h.store.send(envelope("to-b"));
    h.store.send(envelope("to-c", "normal", "agent-c"));
    const claimed = h.store.claimNext("agent-c", { ownerId: "test", leaseDurationMs: 10_000 })!;
    h.store.ack("to-c", { ownerId: "test", expectedVersion: claimed.lease.version, status: "acked" });
    h.store.fenceAgent("agent-b");

    h.store.purgeAgent("agent-b");
    expect(h.store.getMessage("to-b")).toBeUndefined();
    expect(h.store.getMessage("to-c")).toMatchObject({ status: "acked" });
    expect(h.store.isAgentFenced("agent-b")).toBe(false);
    expect(h.store.listForRecipient("agent-b")).toEqual([]);

    h.store.send(envelope("still-queued", "normal", "agent-c"));
    // Everything is older than the cutoff, but queued traffic is never pruned.
    expect(h.store.pruneHistory(10_000)).toBe(1);
    expect(h.store.getMessage("to-c")).toBeUndefined();
    expect(h.store.getMessage("still-queued")).toMatchObject({ status: "queued" });
    expect(h.store.hasActiveMessages()).toBe(true);
  });
});
