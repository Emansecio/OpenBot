
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
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
  it("keeps nested maintenance fences local to one agent and resumes queued work", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const a = store.dispatch(input()).task;
    const b = store.dispatch(input("provider", budget, "agent-b")).task;
    const execute = vi.fn(async () => ({ result: "done" }));
    const runtime = new AsyncTaskRuntime({ store, agentIds: () => ["agent-a", "agent-b"], execute, now: () => 2_100, pollIntervalMs: 1 });
    const first = runtime.fenceAgent("agent-a");
    const second = runtime.fenceAgent("agent-a");
    try {
      await expect(runtime.drainAgent("agent-b")).rejects.toThrow("fenced");
      await runtime.drainAgent("agent-a");
      runtime.start();
      await eventually(() => store.getTask(b.taskId)?.status ?? "missing", "completed");
      expect(store.getTask(a.taskId)?.status).toBe("queued");
      first();
      first(); // A repeated release must not remove another owner's fence.
      runtime.wake();
      expect(store.getTask(a.taskId)?.status).toBe("queued");
      second();
      await eventually(() => store.getTask(a.taskId)?.status ?? "missing", "completed");
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      first(); second();
      await runtime.stop();
      store.close();
    }
  });

  it("refuses home maintenance until a non-cooperative agent claim has really drained", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const running = store.dispatch(input()).task;
    const other = store.dispatch(input("provider", budget, "agent-b")).task;
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    let entered = false;
    let signal: AbortSignal | undefined;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a", "agent-b"], now: () => 2_100, pollIntervalMs: 1,
      execute: async (context) => {
        if (context.task.taskId === running.taskId) {
          signal = context.signal;
          entered = true;
          await blocked;
        }
        return { result: "done" };
      },
    });
    let release: (() => void) | undefined;
    try {
      runtime.start();
      await eventually(() => entered ? "entered" : "waiting", "entered");
      release = runtime.fenceAgent("agent-a");
      const queued = store.dispatch(input()).task;
      await expect(runtime.drainAgent("agent-a", 10)).rejects.toThrow("deadline");
      expect(signal?.aborted).toBe(true);
      expect(store.getTask(queued.taskId)?.status).toBe("queued");
      await eventually(() => store.getTask(other.taskId)?.status ?? "missing", "completed");
      finish();
      await runtime.drainAgent("agent-a");
      expect(store.getTask(running.taskId)?.status).toBe("cancelled");
      expect(store.getTask(running.taskId)?.attempt).toBe(1);
      expect(store.getTask(queued.taskId)?.status).toBe("queued");
      release();
      await eventually(() => store.getTask(queued.taskId)?.status ?? "missing", "completed");
    } finally {
      finish(); release?.();
      await runtime.stop();
      await runtime.whenIdle();
      store.close();
    }
  });

  it("canonicalizes immutable task input and rejects attachments, lone surrogates, and secret-shaped objectives", () => {
    expect(parseTaskInputV1({ version: 1, objective: "  cafe\u0301 ", source: { kind: "parent_turn", agentId: "agent-a" } }).objective).toBe("café");
    expect(() => parseTaskInputV1({ version: 1, objective: "x", source: { kind: "parent_turn", agentId: "agent-a" }, attachments: [] })).toThrow();
    expect(() => parseTaskInputV1({ version: 1, objective: "\uD800", source: { kind: "parent_turn", agentId: "agent-a" } })).toThrow();
    expect(() => parseTaskInputV1({ version: 1, objective: "use api_key=do-not-persist", source: { kind: "parent_turn", agentId: "agent-a" } })).toThrow();
  });

  it("permite vocabulário técnico de autenticação sem aceitar valores inline", () => {
    const source = { kind: "parent_turn", agentId: "agent-a" } as const;
    expect(parseTaskInputV1({ version: 1, objective: "Explique os cookies HTTP.", source }).objective).toBe("Explique os cookies HTTP.");
    expect(parseTaskInputV1({ version: 1, objective: "Explique o cabeçalho Authorization.", source }).objective).toBe("Explique o cabeçalho Authorization.");
    expect(parseTaskInputV1({ version: 1, objective: "Documente a autenticação com access token.", source }).objective).toBe("Documente a autenticação com access token.");
    expect(() => parseTaskInputV1({ version: 1, objective: "Authorization: Bearer abc12345", source })).toThrow(/secret material/iu);
    expect(() => parseTaskInputV1({ version: 1, objective: "Bearer abc12345", source })).toThrow(/secret material/iu);
    expect(() => parseTaskInputV1({ version: 1, objective: "apiKey=sk-live-12345678", source })).toThrow(/secret material/iu);
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

  it("lets a measured write reservation supersede the unknown-size floor", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const writeBudget = { ...budget, maxToolRounds: 4, maxToolCalls: 4, maxWorkspaceWriteBytes: 4 };
    const task = store.dispatch(input("filesystem", writeBudget)).task;
    const runtime = new AsyncTaskRuntime({ store, agentIds: () => ["agent-a"], pollIntervalMs: 1, retryDelayMs: 0, now: () => 2_100,
      execute: async ({ runEffect }) => {
        for (const path of ["C:\\workspace\\a.txt", "C:\\workspace\\b.txt"]) {
          await runEffect({ kind: "filesystem", operation: "write", path }, async () => "ok", {
            reserve: { toolCalls: 1, workspaceWriteBytes: 2 },
            usage: () => ({ toolCalls: 1, workspaceWriteBytes: 2 }),
          });
        }
        return { result: "done" };
      } });
    runtime.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
    await runtime.stop();
    expect(store.getBudgetState(task.taskId)?.usage.used.workspaceWriteBytes).toBe(4);
    store.close();
  });

  it("charges only attempt counters when a retry-safe effect fails", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const readBudget = { ...budget, maxToolRounds: 2, maxToolCalls: 2, maxWorkspaceWriteBytes: 64 };
    const task = store.dispatch(input("filesystem", readBudget)).task;
    const runtime = new AsyncTaskRuntime({ store, agentIds: () => ["agent-a"], pollIntervalMs: 1, retryDelayMs: 0, now: () => 2_100,
      execute: async ({ runEffect }) => {
        try {
          await runEffect({ kind: "filesystem", operation: "read", path: "C:\\workspace\\a.txt" }, async () => { throw new Error("transient"); }, {
            reserve: { toolCalls: 1, workspaceWriteBytes: 64 },
            retrySafe: true,
          });
        } catch { /* the transient failure is the subject of this test */ }
        return { result: "done" };
      } });
    runtime.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
    await runtime.stop();
    expect(store.getBudgetState(task.taskId)?.usage.used).toMatchObject({ toolCalls: 1, workspaceWriteBytes: 0 });
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

  it("leaves retry-safe effects unmarked so a transient failure can retry", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const readBudget = { ...budget, maxToolRounds: 2, maxToolCalls: 2 };
    const task = store.dispatch(input("filesystem", readBudget)).task;
    let calls = 0;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, retryDelayMs: 0, now: () => 2_100,
      execute: async ({ runEffect }) => ({
        result: await runEffect({ kind: "filesystem", operation: "read", path: "C:\\workspace\\safe.txt" }, async () => {
          calls += 1;
          if (calls === 1) throw new Error("retry-safe read failed");
          return "ok";
        }, { retrySafe: true }),
      }),
    });
    runtime.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
    await runtime.stop();
    expect(calls).toBe(2);
    expect(store.listAttempts(task.taskId).every((attempt) => !attempt.unsafeEffectStarted)).toBe(true);
    store.close();
  });

  it("fails closed without dispatch when the durable unsafe-effect fence cannot persist", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input("filesystem")).task;
    const mutableStore = store as unknown as { markUnsafeEffectStarted: typeof store.markUnsafeEffectStarted };
    mutableStore.markUnsafeEffectStarted = (request) => {
      void request;
      throw new Error("marker persistence unavailable");
    };
    let effectCalls = 0;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, retryDelayMs: 0, now: () => 2_100,
      execute: async ({ runEffect }) => ({
        result: await runEffect({ kind: "filesystem", operation: "write", path: "C:\\workspace\\unsafe.txt" }, async () => {
          effectCalls += 1;
          return "must not run";
        }),
      }),
    });
    runtime.start();
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "failed");
    await runtime.stop();
    expect(effectCalls).toBe(0);
    expect(store.getTask(task.taskId)?.error).toMatchObject({ retryable: false, message: "marker persistence unavailable" });
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

  it("uses a bounded Unicode estimate when the provider does not report usage", async () => {
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
    expect(store.getBudgetState(task.taskId)?.usage.estimated?.outputTokens).toBe(600);
    expect(store.getTask(task.taskId)?.error).toBeNull();
    store.close();
  });

  it("does not treat Unicode characters as measured provider tokens", async () => {
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
    await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
    await runtime.stop();
    expect(store.getTask(task.taskId)?.error).toBeNull();
    expect(store.getBudgetState(task.taskId)?.usage.used.outputTokens).toBe(1_000);
    expect(store.getBudgetState(task.taskId)?.usage.estimated?.outputTokens).toBe(1_000);
    store.close();
  });

  it("reconciles provider usage even when the response has more characters than the token cap", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [], now: () => 2_100 });
    const task = store.dispatch(input()).task;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, now: () => 2_100,
      execute: async (context) => {
        const response = await context.runProvider(
          { kind: "provider", adapter: "openai", model: "test", credential: { kind: "secret_ref", secretRef: "provider/test/key" } },
          async () => ({ message: { content: "你".repeat(1_500) }, usage: { inputTokens: 41, outputTokens: 37 } }),
          { requestText: () => "system plus objective", usage: (value) => value.usage },
        );
        return { result: response.message.content };
      },
    });
    try {
      runtime.start();
      await eventually(() => store.getTask(task.taskId)?.status ?? "missing", "completed");
      expect(store.getBudgetState(task.taskId)?.usage.used).toMatchObject({ providerCalls: 1, inputTokens: 41, outputTokens: 37 });
      expect(store.getBudgetState(task.taskId)?.usage.estimated).toBeUndefined();
    } finally {
      await runtime.stop();
      store.close();
    }
  });
});
