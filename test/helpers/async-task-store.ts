// Shared setup for the AsyncTaskStore test files.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach } from "vitest";
import type {
  BudgetCounters,
  DispatchAsyncTaskInput,
  ProviderCapabilityGrant,
  SubagentBudget,
} from "../../src/tasks/contracts.js";
import { AsyncTaskStore as DurableAsyncTaskStore } from "../../src/tasks/store.js";
import type { AsyncTaskStoreOptions } from "../../src/tasks/store.js";
import { TempRoots } from "./temp-roots.js";

export type TestAsyncTaskStoreOptions = Omit<AsyncTaskStoreOptions, "sensitiveValues"> & {
  readonly sensitiveValues?: AsyncTaskStoreOptions["sensitiveValues"];
};

/** Test store whose clock follows the timestamps passed to each call. */
export class AsyncTaskStore extends DurableAsyncTaskStore {
  constructor(options: TestAsyncTaskStoreOptions) {
    let clock = 1_000;
    super({ ...options, sensitiveValues: options.sensitiveValues ?? (() => []), now: options.now ?? (() => clock) });
    if (options.now !== undefined) return this;
    return new Proxy(this, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const input = args[0] as Record<string, unknown> | undefined;
          if (property === "claimNext") clock = Number((args[1] as Record<string, unknown>).nowMs);
          else if (property === "start") clock = Number(input?.startedAtMs);
          else if (property === "heartbeat") clock = Number(input?.nowMs);
          else if (property === "transition") clock = Number(input?.atMs);
          else if (property === "recordProgress") clock = Number((input?.progress as Record<string, unknown> | undefined)?.updatedAtMs);
          else if (property === "steer" || property === "abort") clock = Number(input?.requestedAtMs);
          else if (property === "commitTerminal") clock = Number(input?.finishedAtMs);
          else if (property === "markUnsafeEffectStarted") clock = Number(input?.markedAtMs);
          else if ((property === "expireBudgetExhaustedTasks" || property === "recoverExpiredLeases") && args[0] !== undefined) clock = Number(args[0]);
          else if (property === "reserveTaskBudget" && args[4] !== undefined) clock = Number(args[4]);
          else if (property === "reconcileTaskBudget" && args[5] !== undefined) clock = Number(args[5]);
          return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }
}

/** Fresh SQLite path per call, removed after each test of the calling file. */
export function useTemporaryDatabases(): () => string {
  const temp = new TempRoots();
  afterEach(async () => {
    await temp.cleanup();
  });
  return () => join(temp.make("openbot-async-task-"), "openbot.sqlite");
}

export const budget: SubagentBudget = {
  maxWallMs: 60_000,
  maxProviderCalls: 4,
  maxInputTokens: 10_000,
  maxOutputTokens: 5_000,
  maxToolRounds: 8,
  maxToolCalls: 20,
  maxMcpCalls: 10,
  maxBrowserCommands: 10,
  maxResultBytes: 4_096,
  maxWorkspaceWriteBytes: 100_000,
  maxDepth: 1,
};

export const zeroCounters: BudgetCounters = {
  providerCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  toolRounds: 0,
  toolCalls: 0,
  mcpCalls: 0,
  browserCommands: 0,
  resultBytes: 0,
  workspaceWriteBytes: 0,
};

export function dispatchInput(overrides: Partial<DispatchAsyncTaskInput> = {}): DispatchAsyncTaskInput {
  const taskId = overrides.taskId ?? randomUUID();
  const agentId = overrides.agentId ?? "agent-a";
  const parentTurnId = overrides.parentTurnId ?? "turn-parent";
  const childRunId = overrides.lineage?.childRunId ?? randomUUID();
  const grant: ProviderCapabilityGrant = {
    grantId: randomUUID(),
    taskId,
    parentAgentId: agentId,
    parentTurnId,
    childRunId,
    kind: "provider",
    constraints: {
      adapters: ["openai"],
      models: ["gpt-test"],
      credentialRefs: [{ secretRef: "provider/openai/test" }],
      allowNoCredential: false,
    },
    issuedAt: 900,
    expiresAt: 61_000,
    version: 1,
    depth: 1,
  };
  return {
    taskId,
    agentId,
    parentTurnId,
    kind: "subagent",
    clientNonce: "nonce-a",
    createdAtMs: 1_000,
    lineage: {
      parentAgentId: agentId,
      parentTurnId,
      parentTaskId: null,
      childRunId,
      depth: 1,
    },
    grant,
    budget,
    input: {
      version: 1,
      objective: "Executar tarefa de teste",
      source: { kind: "parent_turn", agentId, turnEntryId: parentTurnId },
    },
    ...overrides,
  };
}
