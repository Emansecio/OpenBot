import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type {
  BrowserCapabilityGrant,
  DelegatedCapabilityGrant,
  DispatchAsyncTaskInput,
  FilesystemCapabilityGrant,
  McpCapabilityGrant,
  ProcessCapabilityGrant,
  ProviderCapabilityGrant,
  SkillCapabilityGrant,
  SubagentBudget,
} from "../src/tasks/contracts.js";
import { AsyncTaskRuntime } from "../src/tasks/runtime.js";
import { AsyncTaskStore } from "../src/tasks/store.js";

const stores: AsyncTaskStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const budget: SubagentBudget = {
  maxWallMs: 10_000, maxProviderCalls: 2, maxInputTokens: 1_000, maxOutputTokens: 1_000,
  maxToolRounds: 1, maxToolCalls: 2, maxMcpCalls: 1, maxBrowserCommands: 1,
  maxResultBytes: 4_096, maxWorkspaceWriteBytes: 4_096, maxDepth: 1,
};

function grantFor(kind: DelegatedCapabilityGrant["kind"], taskId: string, parentTurnId: string): DelegatedCapabilityGrant {
  const base = {
    grantId: randomUUID(), taskId, parentAgentId: "agent-a", parentTurnId, childRunId: randomUUID(),
    issuedAt: Date.now() - 100, expiresAt: Date.now() + 5_000, version: 1, depth: 1 as const,
  };
  switch (kind) {
    case "provider": return { ...base, kind, constraints: { adapters: ["openai"], models: ["test"], credentialRefs: [{ secretRef: "provider/test/key" }], allowNoCredential: false } } satisfies ProviderCapabilityGrant;
    case "filesystem": return { ...base, kind, constraints: { operations: ["read", "write"], roots: ["C:\\workspace"] } } satisfies FilesystemCapabilityGrant;
    case "process": return { ...base, kind, constraints: { operations: ["run"], executables: ["node"], cwdRoots: ["C:\\workspace"], networkProfiles: ["none"] } } satisfies ProcessCapabilityGrant;
    case "browser": return { ...base, kind, constraints: { commandClasses: ["navigate"], origins: ["https://example.com"], partitionAgentId: "agent-a" } } satisfies BrowserCapabilityGrant;
    case "mcp": return { ...base, kind, constraints: { tools: [{ serverId: "server-a", toolName: "tool-a" }] } } satisfies McpCapabilityGrant;
    case "skill": return { ...base, kind, constraints: { skillIds: ["skill-a"] } } satisfies SkillCapabilityGrant;
  }
}

function taskFor(kind: DelegatedCapabilityGrant["kind"], parentTurnId = `turn-${kind}`, taskBudget = budget): DispatchAsyncTaskInput {
  const taskId = randomUUID();
  const grant = grantFor(kind, taskId, parentTurnId);
  return {
    taskId, agentId: "agent-a", parentTurnId, kind: "subagent", clientNonce: randomUUID(), createdAtMs: Date.now(),
    lineage: { parentAgentId: "agent-a", parentTurnId, parentTaskId: null, childRunId: grant.childRunId, depth: 1 },
    grant, budget: taskBudget, input: { version: 1, objective: `exercise-${kind}`, source: { kind: "parent_turn", agentId: "agent-a" } },
  };
}

async function waitFor(store: AsyncTaskStore, ids: readonly string[]): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (ids.every((id) => ["completed", "failed", "cancelled"].includes(store.getTask(id)?.status ?? ""))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("shared async-task capability boundary", () => {
  it("crosses each injected shared surface only after grant authorization", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [] });
    stores.push(store);
    const kinds = ["provider", "filesystem", "process", "browser", "mcp", "skill"] as const;
    const tasks = kinds.map((kind) => taskFor(kind));
    for (const task of tasks) store.dispatch(task);
    const calls = new Map<string, number>(kinds.map((kind) => [kind, 0]));
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1,
      execute: async (context) => {
        switch (context.grant.kind) {
          case "provider":
            await context.runProvider({ kind: "provider", adapter: "openai", model: "test", credential: { kind: "secret_ref", secretRef: "provider/test/key" } }, async () => { calls.set("provider", calls.get("provider")! + 1); return "provider-ok"; });
            break;
          case "filesystem":
            await context.runEffect({ kind: "filesystem", operation: "read", path: "C:\\workspace\\input.txt" }, async () => { calls.set("filesystem", calls.get("filesystem")! + 1); return "fs-ok"; });
            break;
          case "process":
            await context.runEffect({ kind: "process", operation: "run", executable: "node", cwd: "C:\\workspace", networkProfile: "none" }, async () => { calls.set("process", calls.get("process")! + 1); return "process-ok"; });
            break;
          case "browser":
            await context.runEffect({ kind: "browser", commandClass: "navigate", origin: "https://example.com", partitionAgentId: "agent-a" }, async () => { calls.set("browser", calls.get("browser")! + 1); return "browser-ok"; });
            break;
          case "mcp":
            await context.runEffect({ kind: "mcp", serverId: "server-a", toolName: "tool-a" }, async () => { calls.set("mcp", calls.get("mcp")! + 1); return "mcp-ok"; });
            break;
          case "skill":
            await context.runEffect({ kind: "skill", skillId: "skill-a" }, async () => { calls.set("skill", calls.get("skill")! + 1); return "skill-ok"; });
            break;
        }
        return { result: "ok" };
      },
    });
    runtime.start();
    await waitFor(store, tasks.map((task) => task.taskId));
    await runtime.stop();
    expect(tasks.map((task) => store.getTask(task.taskId)?.status)).toEqual(kinds.map(() => "completed"));
    expect(Object.fromEntries(calls)).toEqual(Object.fromEntries(kinds.map((kind) => [kind, 1])));
  });

  it("does not invoke a shared surface when the grant operation is denied", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [] });
    stores.push(store);
    const task = taskFor("filesystem", "turn-denied");
    store.dispatch(task);
    let calls = 0;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1,
      execute: async (context) => {
        await context.runEffect({ kind: "filesystem", operation: "read", path: "C:\\outside\\secret.txt" }, async () => { calls += 1; return "bad"; });
        return { result: "unreachable" };
      },
    });
    runtime.start();
    await waitFor(store, [task.taskId]);
    await runtime.stop();
    expect(store.getTask(task.taskId)).toMatchObject({ status: "failed", error: { code: "capability_denied" } });
    expect(calls).toBe(0);
  });

  it("rejects every non-provider effect before its callback when tool rounds are exhausted", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [] });
    stores.push(store);
    const kinds = ["filesystem", "process", "browser", "mcp", "skill"] as const;
    const zeroRounds = { ...budget, maxToolRounds: 0 };
    const tasks = kinds.map((kind) => taskFor(kind, `turn-zero-${kind}`, zeroRounds));
    for (const task of tasks) store.dispatch(task);
    expect(store.getBudgetState(tasks[0]!.taskId)?.budget.maxToolRounds).toBe(0);
    const calls = new Map<string, number>(kinds.map((kind) => [kind, 0]));
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1,
      execute: async (context) => {
        const kind = context.grant.kind;
        if (kind === "filesystem") await context.runEffect({ kind, operation: "read", path: "C:\\workspace\\input.txt" }, async () => { calls.set(kind, calls.get(kind)! + 1); return "x"; });
        if (kind === "process") await context.runEffect({ kind, operation: "run", executable: "node", cwd: "C:\\workspace", networkProfile: "none" }, async () => { calls.set(kind, calls.get(kind)! + 1); return "x"; });
        if (kind === "browser") await context.runEffect({ kind, commandClass: "navigate", origin: "https://example.com", partitionAgentId: "agent-a" }, async () => { calls.set(kind, calls.get(kind)! + 1); return "x"; });
        if (kind === "mcp") await context.runEffect({ kind, serverId: "server-a", toolName: "tool-a" }, async () => { calls.set(kind, calls.get(kind)! + 1); return "x"; });
        if (kind === "skill") await context.runEffect({ kind, skillId: "skill-a" }, async () => { calls.set(kind, calls.get(kind)! + 1); return "x"; });
        return { result: "unreachable" };
      },
    });
    runtime.start();
    await waitFor(store, tasks.map((task) => task.taskId));
    await runtime.stop();
    expect({ statuses: tasks.map((task) => store.getTask(task.taskId)?.status), errors: tasks.map((task) => store.getTask(task.taskId)?.error), calls: Object.fromEntries(calls) }).toEqual({ statuses: kinds.map(() => "failed"), errors: kinds.map(() => expect.objectContaining({ code: "budget_exhausted" })), calls: Object.fromEntries(kinds.map((kind) => [kind, 0])) });
    expect(Object.fromEntries(calls)).toEqual(Object.fromEntries(kinds.map((kind) => [kind, 0])));
  });

  it("consumes shared tool rounds across retrySafe attempts", async () => {
    const store = new AsyncTaskStore({ path: ":memory:", sensitiveValues: () => [] });
    stores.push(store);
    const task = taskFor("filesystem", "turn-round-retry", { ...budget, maxToolRounds: 1 });
    store.dispatch(task);
    let calls = 0;
    const runtime = new AsyncTaskRuntime({
      store, agentIds: () => ["agent-a"], pollIntervalMs: 1, retryDelayMs: 1, maxAttempts: 2,
      execute: async (context) => {
        await context.runEffect({ kind: "filesystem", operation: "read", path: "C:\\workspace\\input.txt" }, async () => {
          calls += 1;
          throw new Error("safe transient failure");
        }, { retrySafe: true });
        return { result: "unreachable" };
      },
    });
    runtime.start();
    await waitFor(store, [task.taskId]);
    await runtime.stop();
    expect(store.getTask(task.taskId)).toMatchObject({ status: "failed", error: { code: "budget_exhausted" } });
    expect(calls).toBe(1);
    expect(store.getBudgetState(task.taskId)?.usage.used.toolRounds).toBe(1);
    expect(store.getBudgetState(task.taskId)?.usage.reserved.toolRounds).toBe(0);
  });
});
