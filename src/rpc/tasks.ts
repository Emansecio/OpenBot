import { randomUUID } from "node:crypto";

import type { ConfigStore } from "../config/store.js";
import { resolveAgentInference } from "./identity.js";
import { RpcError, type Gateway } from "../server/gateway.js";
import { parseDelegatedCapabilityGrant, parseTaskInputV1, type AsyncTaskRecord, type DelegatedCapabilityGrant, type DispatchAsyncTaskInput, type ProviderCapabilityGrant, type SubagentBudget } from "../tasks/contracts.js";
import { deriveEffectiveBudget, deriveEffectiveGrant } from "../tasks/state-machine.js";
import { AsyncTaskStore } from "../tasks/store.js";

function record(body: unknown, method: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RpcError(400, `${method}: corpo deve ser um objeto`);
  return body as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, name: string, method: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim().length === 0) throw new RpcError(400, `${method}: ${name} é obrigatório`);
  return value.trim();
}

function scopedAgent(config: ConfigStore, body: Record<string, unknown>, method: string): string {
  const agentId = requiredString(body, "agentId", method);
  if (!config.snapshot().agents.some((agent) => agent.id === agentId)) throw new RpcError(404, `${method}: agente não encontrado`);
  return agentId;
}

/**
 * P2.2 read-only scope: accepts the legacy native `{id}` alias and the
 * canonical `{agentId}` and normalizes both to a validated agentId. This is
 * intentionally restricted to read-only list methods; every mutating task
 * RPC keeps requiring an explicit `agentId`.
 */
function scopedReadAgent(config: ConfigStore, body: Record<string, unknown>, method: string): string {
  const explicit = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const alias = typeof body.id === "string" ? body.id.trim() : "";
  const raw = explicit.length > 0 ? explicit : alias.length > 0 ? alias : "";
  if (raw.length === 0) throw new RpcError(400, `${method}: agentId é obrigatório`);
  if (!config.snapshot().agents.some((agent) => agent.id === raw)) throw new RpcError(404, `${method}: agente não encontrado`);
  return raw;
}

function scopedTask(store: AsyncTaskStore, agentId: string, taskId: string, method: string): AsyncTaskRecord {
  const task = store.getTask(taskId);
  // Do not disclose the owner of a task belonging to another agent.
  if (task === null || task.agentId !== agentId) throw new RpcError(404, `${method}: tarefa não encontrada`);
  return task;
}

export type AsyncTaskAuthorityResolver = (requested: DelegatedCapabilityGrant, agentId: string, parentTurnId: string, now: number) => DelegatedCapabilityGrant | Promise<DelegatedCapabilityGrant | undefined> | undefined;

async function deriveConfiguredGrant(config: ConfigStore, requestedValue: unknown, agentId: string, parentTurnId: string, now: number, resolveAuthority?: AsyncTaskAuthorityResolver) {
  const requested = parseDelegatedCapabilityGrant(requestedValue);
  if (resolveAuthority !== undefined) {
    const authority = await resolveAuthority(requested, agentId, parentTurnId, now);
    if (authority === undefined) throw new RpcError(403, "dispatchAsyncTask: capability is not currently authorized");
    try {
      const effective = deriveEffectiveGrant(requested, authority, authority, now);
      if (effective.kind !== requested.kind || (effective.kind === "filesystem" && effective.constraints.operations.length === 0) || (effective.kind === "process" && effective.constraints.executables.length === 0) || (effective.kind === "browser" && effective.constraints.commandClasses.length === 0) || (effective.kind === "mcp" && (effective.constraints.tools?.length ?? 0) === 0) || (effective.kind === "skill" && effective.constraints.skillIds.length === 0)) {
        throw new RpcError(403, "dispatchAsyncTask: requested grant exceeds current authority");
      }
      return effective;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError(403, "dispatchAsyncTask: requested grant exceeds current authority");
    }
  }
  if (requested.kind !== "provider") throw new RpcError(403, "dispatchAsyncTask: no authority resolver is configured");
  const inference = resolveAgentInference(config.snapshot(), agentId);
  const authority: ProviderCapabilityGrant = {
    ...requested,
    parentAgentId: agentId,
    parentTurnId,
    issuedAt: Math.min(requested.issuedAt, now),
    expiresAt: Math.min(requested.expiresAt, now + 60_000),
    constraints: {
      adapters: [inference.provider],
      models: [inference.model],
      credentialRefs: [{ secretRef: `provider/${inference.provider}` }],
      allowNoCredential: false,
    },
  };
  const effective = deriveEffectiveGrant(requested, authority, authority, now);
  if (effective.kind !== "provider" || effective.constraints.adapters.length === 0 || effective.constraints.models.length === 0 || effective.constraints.credentialRefs.length === 0) {
    throw new RpcError(403, "dispatchAsyncTask: requested grant exceeds current provider authority");
  }
  return effective;
}

const HARD_TASK_BUDGET: SubagentBudget = {
  maxWallMs: 300_000, maxProviderCalls: 8, maxInputTokens: 32_768, maxOutputTokens: 32_768,
  maxToolRounds: 16, maxToolCalls: 64, maxMcpCalls: 32, maxBrowserCommands: 64,
  maxResultBytes: 256 * 1024, maxWorkspaceWriteBytes: 256 * 1024, maxDepth: 1,
};

export interface AsyncTaskRpcOptions {
  readonly store: AsyncTaskStore;
  readonly config: ConfigStore;
  readonly wake?: () => void;
  readonly resolveAuthority?: AsyncTaskAuthorityResolver;
}

export function registerAsyncTaskHandlers(gateway: Gateway, options: AsyncTaskRpcOptions): void {
  const list = async (body: unknown, method: string) => {
    const b = record(body, method);
    const agentId = scopedReadAgent(options.config, b, method);
    const rawLimit = b.limit === undefined ? 100 : b.limit;
    if (!Number.isInteger(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200) throw new RpcError(400, `${method}: limit deve ser um inteiro entre 1 e 200`);
    return options.store.listTasks(agentId, { limit: Number(rawLimit) });
  };
  gateway.registerHandler("getAsyncTasks", (body) => list(body, "getAsyncTasks"));
  gateway.registerHandler("getSubagents", (body) => list(body, "getSubagents"));
  gateway.registerHandler("listAsyncTasks", (body) => list(body, "listAsyncTasks"));
  gateway.registerHandler("getAsyncTask", (body) => {
    const b = record(body, "getAsyncTask");
    return scopedTask(options.store, scopedAgent(options.config, b, "getAsyncTask"), requiredString(b, "taskId", "getAsyncTask"), "getAsyncTask");
  });
  gateway.registerHandler("dispatchAsyncTask", async (body) => {
    const b = record(body, "dispatchAsyncTask");
    const agentId = scopedAgent(options.config, b, "dispatchAsyncTask");
    const parentTurnId = requiredString(b, "parentTurnId", "dispatchAsyncTask");
    const taskId = typeof b.taskId === "string" && b.taskId.trim() ? b.taskId.trim() : randomUUID();
    const clientNonce = requiredString(b, "clientNonce", "dispatchAsyncTask");
    try {
      const input = parseTaskInputV1(b.input);
      const grant = await deriveConfiguredGrant(options.config, b.grant, agentId, parentTurnId, Date.now(), options.resolveAuthority);
      const budget = deriveEffectiveBudget(HARD_TASK_BUDGET, HARD_TASK_BUDGET, b.budget);
      const dispatch: DispatchAsyncTaskInput = {
        taskId, agentId, parentTurnId, kind: "subagent", clientNonce, createdAtMs: Date.now(),
        lineage: { parentAgentId: agentId, parentTurnId, parentTaskId: null, childRunId: grant.childRunId, depth: 1 },
        grant, budget, parentBudget: HARD_TASK_BUDGET, input,
      };
      const result = options.store.dispatch(dispatch);
      options.wake?.();
      return { taskId: result.task.taskId, created: result.created, task: result.task };
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError(error instanceof Error && /nonce|contract|grant|budget|fenced|input/iu.test(error.message) ? 400 : 500, error instanceof Error ? error.message : String(error));
    }
  });
  gateway.registerHandler("steerAsyncTask", (body) => {
    const b = record(body, "steerAsyncTask");
    const agentId = scopedAgent(options.config, b, "steerAsyncTask");
    const taskId = requiredString(b, "taskId", "steerAsyncTask");
    const task = scopedTask(options.store, agentId, taskId, "steerAsyncTask");
    return options.store.steer({
      taskId, agentId, parentTurnId: task.parentTurnId,
      intentId: requiredString(b, "intentId", "steerAsyncTask"),
      expectedSteerVersion: typeof b.expectedSteerVersion === "number" ? b.expectedSteerVersion : task.steerVersion,
      requestedAtMs: Date.now(), message: requiredString(b, "message", "steerAsyncTask"),
    });
  });
  gateway.registerHandler("abortAsyncTask", (body) => {
    const b = record(body, "abortAsyncTask");
    const agentId = scopedAgent(options.config, b, "abortAsyncTask");
    const taskId = requiredString(b, "taskId", "abortAsyncTask");
    const task = scopedTask(options.store, agentId, taskId, "abortAsyncTask");
    const result = options.store.abort({
      taskId, agentId, parentTurnId: task.parentTurnId,
      intentId: requiredString(b, "intentId", "abortAsyncTask"),
      expectedAbortVersion: typeof b.expectedAbortVersion === "number" ? b.expectedAbortVersion : task.abortVersion,
      requestedAtMs: Date.now(), reason: b.reason === "parent" || b.reason === "shutdown" || b.reason === "budget_exhausted" ? b.reason : "user",
    });
    options.wake?.();
    return result;
  });
  gateway.registerHandler("settleAsyncTask", (body) => {
    const b = record(body, "settleAsyncTask");
    const agentId = scopedAgent(options.config, b, "settleAsyncTask");
    const task = scopedTask(options.store, agentId, requiredString(b, "taskId", "settleAsyncTask"), "settleAsyncTask");
    if (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled") {
      throw new RpcError(409, "settleAsyncTask: tarefa ainda não terminou");
    }
    return options.store.settleTask(task.taskId, agentId, requiredString(b, "settlementNonce", "settleAsyncTask"));
  });
}
