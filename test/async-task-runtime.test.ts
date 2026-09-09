import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { ProviderAdmissionScheduler } from "../src/providers/admission.js";
import { AsyncTaskRuntime } from "../src/tasks/runtime.js";
import { parseTaskInputV1, type DelegatedCapabilityGrant, type DispatchAsyncTaskInput, type ProviderCapabilityGrant, type SubagentBudget } from "../src/tasks/contracts.js";
import { AsyncTaskStore } from "../src/tasks/store.js";

const budget: SubagentBudget = {
  maxWallMs: 10_000, maxProviderCalls: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000,
  maxToolRounds: 1, maxToolCalls: 1, maxMcpCalls: 1, maxBrowserCommands: 1,
  maxResultBytes: 4_096, maxWorkspaceWriteBytes: 4_096, maxDepth: 1,
};

function input(kind: "provider" | "filesystem" = "provider", budgetValue: SubagentBudget = budget, agentId = "agent-a"): DispatchAsyncTaskInput {
  const taskId = randomUUID();
  const childRunId = randomUUID();
  const grant: DelegatedCapabilityGrant = kind === "filesystem" ? {
    grantId: randomUUID(), taskId, parentAgentId: agentId, parentTurnId: `turn-${agentId}`, childRunId,
    kind: "filesystem", constraints: { operations: ["read", "write", "list"], roots: ["C:\\workspace"] },
    issuedAt: 1, expiresAt: 9_000, version: 1, depth: 1,
  } : {
    grantId: randomUUID(), taskId, parentAgentId: agentId, parentTurnId: `turn-${agentId}`, childRunId,
    kind: "provider", constraints: { adapters: ["openai"], models: ["test"], credentialRefs: [{ secretRef: "provider/test/key" }], allowNoCredential: false },
    issuedAt: 1, expiresAt: 9_000, version: 1, depth: 1,
  } satisfies ProviderCapabilityGrant;
  return {
    taskId, agentId, parentTurnId: `turn-${agentId}`, kind: "subagent", clientNonce: randomUUID(), createdAtMs: 1,
    lineage: { parentAgentId: agentId, parentTurnId: `turn-${agentId}`, parentTaskId: null, childRunId, depth: 1 }, grant, budget: budgetValue,
    input: { version: 1, objective: "Faça uma verificação curta", source: { kind: "parent_turn", agentId, turnEntryId: `entry-${agentId}` } },
  };
}

async function eventually(read: () => string, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (read() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(read()).toBe(expected);
}

function tasksDone(store: AsyncTaskStore, tasks: readonly { taskId: string }[]): boolean {
  return tasks.every((task) => store.getTask(task.taskId)?.status === "completed");
}

describe("AsyncTaskRuntime", () => {
  it("canonicalizes immutable task input and rejects attachments, lone surrogates, and secret-shaped objectives", () => {
    expect(parseTaskInputV1({ version: 1, objective: "  cafe\u0301 ", source: { kind: "parent_turn", agentId: "agent-a" } }).objective).toBe("café");
    expect(() => parseTaskInputV1({ version: 1, objective: "x", source: { kind: "parent_turn", agentId: "agent-a" }, attachments: [] })).toThrow();
    expect(() => parseTaskInputV1({ version: 1, objective: "\uD800", source: { kind: "parent_turn", agentId: "agent-a" } })).toThrow();
    expect(() => parseTaskInputV1({ version: 1, objective: "use api_key=do-not-persist", source: { kind: "parent_turn", agentId: "agent-a" } })).toThrow();
  });

  it("claims, executes through shared services, and commits one durable terminal wake", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const admission = new ProviderAdmissionScheduler({ maxActive: 1 });
    const dispatched = store.dispatch(input()).task;
    let calls = 0;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], providerAdmission: admission, pollIntervalMs: 1,
      execute: async (context) => {
        calls += 1;
        expect(context.objective).toContain("verificação");
        return { result: "ok", usage: { providerCalls: 0 } };
      },
      now: () => 2_100,
    });
    runtime.start();
    await eventually(() => store.getTask(dispatched.taskId)?.status ?? "missing", "completed");
    await runtime.stop();
    expect(calls).toBe(1);
    expect(store.listUndeliveredOutbox().filter((event) => event.wakeKind === "task_terminal")).toHaveLength(1);
    const settled = store.settleTask(dispatched.taskId, "agent-a", "settlement-once", 2_100);
    expect(settled).toMatchObject({ settledAtMs: 2_100 });
    expect(store.settleTask(dispatched.taskId, "agent-a", "settlement-once", 2_100)).toEqual(settled);
    store.close();
    admission.shutdown();
    await admission.drain();
  });

  it("lets another agent progress while one agent has a blocked claim", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const first = store.dispatch(input()).task;
    const second = store.dispatch(input("provider", budget, "agent-b")).task;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered = false;
    let secondEntered = false;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a", "agent-b"], maxConcurrentTasks: 2, pollIntervalMs: 1, now: () => 2_100,
      execute: async ({ task }) => {
        if (task.taskId === first.taskId) {
          firstEntered = true;
          await firstBlocked;
          return { result: "first" };
        }
        secondEntered = true;
        return { result: "second" };
      },
    });
    runtime.start();
    await eventually(() => firstEntered ? "entered" : "waiting", "entered");
    await eventually(() => secondEntered ? "entered" : "waiting", "entered");
    expect(store.getTask(second.taskId)?.status).toBe("completed");
    releaseFirst();
    await eventually(() => store.getTask(first.taskId)?.status ?? "missing", "completed");
    await runtime.stop();
    store.close();
  });

  it("enforces the global lane cap and opens the next lane after completion", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const tasks = ["agent-a", "agent-b", "agent-c"].map((agentId) => store.dispatch(input("provider", budget, agentId)).task);
    const releases = new Map<string, () => void>();
    let active = 0;
    let maxActive = 0;
    const entered: string[] = [];
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a", "agent-b", "agent-c"], maxConcurrentTasks: 2, pollIntervalMs: 1, now: () => 2_100,
      execute: async ({ task }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        entered.push(task.agentId);
        await new Promise<void>((resolve) => { releases.set(task.taskId, resolve); });
        active -= 1;
        return { result: task.agentId };
      },
    });
    runtime.start();
    await eventually(() => String(entered.length), "2");
    expect(maxActive).toBe(2);
    expect(entered).not.toContain("agent-c");
    releases.get(tasks[0]!.taskId)!();
    await eventually(() => String(entered.length), "3");
    for (const task of tasks.slice(1)) releases.get(task.taskId)?.();
    await eventually(() => tasks.every((task) => store.getTask(task.taskId)?.status === "completed") ? "completed" : "waiting", "completed");
    await runtime.stop();
    store.close();
  });

  it("backs off while all global lanes are blocked instead of hot-spinning claims", async () => {
    vi.useFakeTimers();
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const tasks = [store.dispatch(input()).task, store.dispatch(input("provider", budget, "agent-b")).task];
    const releases = new Map<string, () => void>();
    let entered = 0;
    const originalClaimNext = store.claimNext.bind(store);
    let claimCalls = 0;
    const mutableStore = store as unknown as { claimNext: typeof store.claimNext };
    mutableStore.claimNext = (...args) => { claimCalls += 1; return originalClaimNext(...args); };
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a", "agent-b"], maxConcurrentTasks: 2, pollIntervalMs: 100, now: () => 2_100,
      execute: async ({ task }) => {
        entered += 1;
        await new Promise<void>((resolve) => { releases.set(task.taskId, resolve); });
        return { result: task.agentId };
      },
    });
    try {
      runtime.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(entered).toBe(2);
      const baselineClaims = claimCalls;
      await vi.advanceTimersByTimeAsync(99);
      expect(claimCalls).toBe(baselineClaims);
      for (const task of tasks) releases.get(task.taskId)!();
      await vi.advanceTimersByTimeAsync(0);
      expect(tasksDone(store, tasks)).toBe(true);
    } finally {
      for (const release of releases.values()) release();
      try {
        await vi.advanceTimersByTimeAsync(0);
        await runtime.stop();
        await runtime.whenIdle();
        store.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("round-robins agents when one lane has multiple queued tasks", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const first = store.dispatch(input()).task;
    const second = store.dispatch(input()).task;
    const other = store.dispatch(input("provider", budget, "agent-b")).task;
    const order: string[] = [];
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a", "agent-b"], maxConcurrentTasks: 1, pollIntervalMs: 1, now: () => 2_100,
      execute: async ({ task }) => { order.push(task.taskId); return { result: task.agentId }; },
    });
    runtime.start();
    await eventually(() => tasksDone(store, [first, second, other]) ? "completed" : "waiting", "completed");
    await runtime.stop();
    expect(order).toHaveLength(3);
    expect(order.slice(0, 2)).toContain(other.taskId);
    expect(order.slice(0, 2).filter((taskId) => taskId === first.taskId || taskId === second.taskId)).toHaveLength(1);
    store.close();
  });

  it("reconciles a failed attempt reservation before retrying the same shared budget", async () => {
    let clock = 2_100;
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => clock });
    const retryBudget = { ...budget, maxToolRounds: 2, maxToolCalls: 2 };
    const task = store.dispatch(input("filesystem", retryBudget)).task;
    let calls = 0;
    const runtime = new AsyncTaskRuntime({ store, agentIds: () => ["agent-a"], pollIntervalMs: 1, retryDelayMs: 0, now: () => clock,
      execute: async ({ runEffect }) => {
        calls += 1;
        return { result: await runEffect({ kind: "filesystem", operation: "read", path: "C:\\workspace" }, async () => {
          if (calls === 1) { clock = 2_500; throw new Error("transient after reservation"); }
          return "ok";
        }, { reserve: { toolCalls: 1 }, usage: () => ({ toolRounds: 1, toolCalls: 1 }), retrySafe: true }) };
      } });
    runtime.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
    await runtime.stop();
    expect(calls).toBe(2);
    expect(store.getBudgetState(task.taskId)?.usage).toMatchObject({ used: { toolRounds: 2, toolCalls: 2 }, reserved: { toolRounds: 0, toolCalls: 0 }, reservations: [] });
    store.close();
  });

  it("charges a provider effect that starts and does not retry after the provider boundary", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input()).task;
    let calls = 0;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, retryDelayMs: 0, now: () => 2_100,
      execute: async (context) => {
        calls += 1;
        await context.runProvider({ kind: "provider", adapter: "openai", model: "test", credential: { kind: "secret_ref", secretRef: "provider/test/key" } }, async () => {
          throw new Error("provider failed after invocation");
        });
        return { result: "unreachable" };
      },
    });
    runtime.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "failed");
    await runtime.stop();
    expect(calls).toBe(1);
    expect(store.getBudgetState(task.taskId)?.usage.used.providerCalls).toBe(1);
    expect(store.getBudgetState(task.taskId)?.usage.reserved.providerCalls).toBe(0);
    store.close();
  });

  it("does not invoke the executor when an abort is already terminal before admission", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input()).task;
    store.abort({ taskId: task.taskId, agentId: task.agentId, parentTurnId: task.parentTurnId, intentId: "abort-before-admission", expectedAbortVersion: 0, requestedAtMs: 2_100, reason: "user" });
    let calls = 0;
    const runtime = new AsyncTaskRuntime({ store, agentIds: () => ["agent-a"], pollIntervalMs: 1, now: () => 2_100, execute: async () => { calls += 1; return { result: "bad" }; } });
    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runtime.stop();
    expect(calls).toBe(0);
    expect(store.getTask(task.taskId)?.status).toBe("cancelled");
    store.close();
  });

  it("keeps the store usable after bounded stop until an executor ignoring AbortSignal drains", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input()).task;
    let entered = false;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, now: () => 2_100,
      execute: async () => { entered = true; await blocked; return { result: "late" }; },
    });
    runtime.start();
    await eventually(() => entered ? "entered" : "waiting", "entered");
    const startedAt = Date.now();
    await runtime.stop(25);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(runtime.isIdle()).toBe(false);
    expect(store.getTask(task.taskId)?.status).toBe("running");
    release();
    await runtime.whenIdle();
    expect(runtime.isIdle()).toBe(true);
    expect(store.getTask(task.taskId)?.status).toBe("cancelled");
    expect(store.listUndeliveredOutbox().some((event) => event.taskId === task.taskId && event.wakeKind === "task_terminal")).toBe(true);
    store.close();
  });

  it("requeues an expired running lease on restart before claiming it again", async () => {
    let clock = 2_100;
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => clock });
    const task = store.dispatch(input()).task;
    const claimed = store.claimNext("agent-a", { ownerId: "crashed-worker", nowMs: clock, leaseDurationMs: 100 })!;
    const running = store.start({ taskId: task.taskId, expectedVersion: claimed.task.version, leaseOwnerId: "crashed-worker", attempt: 1, startedAtMs: clock });
    store.reserveTaskBudget(task.taskId, 1, { reservationId: "crashed-effect", amounts: { providerCalls: 1, inputTokens: 0, outputTokens: 0, toolRounds: 0, toolCalls: 0, mcpCalls: 0, browserCommands: 0, resultBytes: 0, workspaceWriteBytes: 0 } }, {
      leaseOwnerId: "crashed-worker", attempt: 1, expectedTaskVersion: running.version,
    }, clock);
    clock = 2_300;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, now: () => clock,
      execute: async () => ({ result: "recovered", usage: { providerCalls: 0 } }),
    });
    runtime.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
    await runtime.stop();
    expect(store.listAttempts(task.taskId).map((attempt) => attempt.status)).toEqual(["abandoned", "completed"]);
    expect(store.getBudgetState(task.taskId)?.usage).toMatchObject({ used: { providerCalls: 1 }, reserved: { providerCalls: 0 }, reservations: [] });
    store.close();
  });

  it("keeps the shared loop alive when a claimed task fails during start", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const first = store.dispatch(input()).task;
    const second = store.dispatch(input()).task;
    const originalStart = store.start.bind(store);
    let failFirstStart = true;
    const mutableStore = store as unknown as { start: typeof store.start };
    mutableStore.start = (request) => {
      if (failFirstStart && request.taskId === first.taskId) {
        failFirstStart = false;
        throw new Error("start CAS raced with revocation");
      }
      return originalStart(request);
    };
    let executed = 0;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, now: () => 2_100,
      execute: async () => { executed += 1; return { result: "second completed" }; },
    });
    runtime.start();
    await eventually(() => store.getTask(second.taskId)?.status ?? "missing", "completed");
    await runtime.stop();
    expect(executed).toBe(1);
    expect(store.getTask(first.taskId)?.status).toBe("admitted");
    store.close();
  });

  it("charges Unicode provider output in token units instead of UTF-8 bytes", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input()).task;
    const unicode = "你".repeat(600);
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, now: () => 2_100,
      execute: async (context) => {
        const output = await context.runProvider({ kind: "provider", adapter: "openai", model: "test", credential: { kind: "secret_ref", secretRef: "provider/test/key" } }, async () => unicode);
        return { result: output };
      },
    });
    runtime.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
    await runtime.stop();
    expect(store.getBudgetState(task.taskId)?.usage.used.outputTokens).toBe(600);
    expect(store.getTask(task.taskId)?.error).toBeNull();
    store.close();
  });

  it("fails closed when Unicode provider output exceeds the token budget", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input()).task;
    const unicode = "你".repeat(1_001);
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, now: () => 2_100,
      execute: async (context) => ({
        result: await context.runProvider({ kind: "provider", adapter: "openai", model: "test", credential: { kind: "secret_ref", secretRef: "provider/test/key" } }, async () => unicode),
      }),
    });
    runtime.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "failed");
    await runtime.stop();
    expect(store.getTask(task.taskId)?.error?.code).toBe("budget_exhausted");
    expect(store.getBudgetState(task.taskId)?.usage.used.outputTokens).toBe(1_000);
    store.close();
  });

  it("resumes a durable retry_wait task after the worker is restarted", async () => {
    let clock = 2_100;
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => clock });
    const task = store.dispatch(input()).task;
    const first = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, retryDelayMs: 1_000, now: () => clock,
      execute: async () => { throw new Error("crash-like transient failure"); },
    });
    first.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "retry_wait");
    await first.stop();
    clock = 3_200;
    const second = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, retryDelayMs: 0, now: () => clock,
      execute: async () => ({ result: "retry recovered", usage: { providerCalls: 0 } }),
    });
    second.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
    await second.stop();
    expect(store.listAttempts(task.taskId).map((attempt) => attempt.status)).toEqual(["retry_wait", "completed"]);
    store.close();
  });

  it("fences parent deletion and terminalizes children idempotently", () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input()).task;
    store.fenceAgent("agent-a", 1_001);
    expect(() => store.dispatch({ ...input(), agentId: "agent-a", parentTurnId: "turn-a" })).toThrow();
    expect(store.terminalizeAgentTasks("agent-a", 1_002)).toHaveLength(1);
    expect(store.getTask(task.taskId)).toMatchObject({ status: "cancelled", error: { code: "aborted" } });
    expect(store.terminalizeAgentTasks("agent-a", 1_003)).toEqual([]);
    store.clearAgentFence("agent-a");
    store.close();
  });

  it("keeps projection unacknowledged with no delivery receipt and advances per-agent sequence durably", () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input()).task;
    const envelopes = store.projectUndelivered();
    expect(envelopes).toHaveLength(2);
    expect(envelopes.map((entry) => entry.channel)).toEqual(["async-tasks", "subagents"]);
    expect(envelopes[0]).toMatchObject({ agentId: "agent-a", taskId: task.taskId, sequence: 1 });
    expect(store.acknowledgeProjection(envelopes[0]!.projectionId, false, 2_101)).toBe(false);
    expect(store.listUndeliveredProjections()).toHaveLength(2);
    const [retry] = store.projectUndelivered();
    expect(retry).toMatchObject({ projectionId: envelopes[0]!.projectionId, sequence: 1 });
    expect(store.acknowledgeProjection(envelopes[0]!.projectionId, true, 2_102)).toBe(true);
    expect(store.listUndeliveredOutbox()).toHaveLength(1);
    expect(store.acknowledgeProjection(envelopes[1]!.projectionId, true, 2_103)).toBe(true);
    expect(store.listUndeliveredProjections()).toHaveLength(0);
    expect(store.listUndeliveredOutbox()).toHaveLength(0);
    store.close();
  });

  it("recovers after a transient projection transport failure without stopping the worker", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input()).task;
    let publishCalls = 0;
    const runtime = new AsyncTaskRuntime({
      store,
      agentIds: () => ["agent-a"],
      pollIntervalMs: 1,
      now: () => 2_100,
      execute: async () => ({ result: "ok" }),
      publishProjection: async () => {
        publishCalls += 1;
        if (publishCalls === 1) throw new Error("temporary transport failure");
        return true;
      },
    });
    runtime.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
    await eventually(() => store.listUndeliveredProjections().length === 0 ? "delivered" : "pending", "delivered");
    await runtime.stop();
    expect(publishCalls).toBeGreaterThan(1);
    store.close();
  });
});
