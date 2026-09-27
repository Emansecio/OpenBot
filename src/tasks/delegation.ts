/**
 * Depth-1 delegated work (async tasks): which capabilities a task may be
 * granted, and how a granted command is executed through the same broker,
 * shared tools and providers that foreground turns use.
 */
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { resolveAgentSkillPolicy, type ConfigStore } from "../config/store.js";
import type { LocalExecutionBroker } from "../execution/broker.js";
import type { ExecutionRequest, ExecutionResult } from "../execution/contracts.js";
import { fileContentByteLength } from "../execution/files.js";
import type { AgentHomeStore } from "../execution/home.js";
import { classifyAgentPath, isReservedHomeRelative, sharedDirectoryName } from "../execution/user-files.js";
import type { SharedTools } from "../integrations/shared-tools.js";
import { fromMcpProviderToolName, toMcpProviderToolName } from "../mcp/contracts.js";
import type { McpManager } from "../mcp/manager.js";
import { isCatalogProvider, type ModelCatalogService } from "../providers/model-catalog.js";
import { streamChat, type ProviderRegistry } from "../providers/router.js";
import { resolveAgentInference } from "../rpc/identity.js";
import type { AsyncTaskAuthorityResolver } from "../rpc/tasks.js";
import type { SkillCatalog } from "../skills/catalog.js";
import { isModelSelectable, isSkillAllowed } from "../skills/references.js";
import { executionResultText, parseAsyncTaskCommandV1 } from "./command.js";
import { AsyncTaskContractError, parseDelegatedBrowserOrigin, type BudgetCounters, type DelegatedCapabilityOperation } from "./contracts.js";
import type { AsyncTaskRuntimeOptions } from "./runtime.js";
import type { AsyncTaskStore } from "./store.js";

export interface AsyncTaskAuthorityDeps {
  config: Pick<ConfigStore, "view">;
  mcpManager: Pick<McpManager, "getProviderTools">;
  skillCatalog: Pick<SkillCatalog, "list" | "invocationPolicy">;
  /** Browser origins the operator allows delegated tasks to open. */
  browserOrigins?: readonly string[];
}

/** Narrow a requested grant to what the agent's current configuration allows. */
export function createAsyncTaskAuthorityResolver({ config, mcpManager, skillCatalog, browserOrigins }: AsyncTaskAuthorityDeps): AsyncTaskAuthorityResolver {
  return async (requested, agentId, parentTurnId, now) => {
    const base = { ...requested, parentAgentId: agentId, parentTurnId, issuedAt: Math.min(requested.issuedAt, now), expiresAt: Math.min(requested.expiresAt, now + 60_000), version: requested.version };
    try {
      switch (requested.kind) {
        case "provider": {
          const inference = resolveAgentInference(config.view(), agentId);
          return { ...base, kind: "provider", constraints: { adapters: [inference.provider], models: [inference.model], credentialRefs: [{ secretRef: `provider/${inference.provider}` }], allowNoCredential: false } };
        }
        case "filesystem": {
          return { ...base, kind: "filesystem", constraints: {
            operations: [...requested.constraints.operations],
            roots: [...requested.constraints.roots],
          } };
        }
        case "process": {
          return { ...base, kind: "process", constraints: {
            operations: [...requested.constraints.operations],
            executables: [...requested.constraints.executables],
            cwdRoots: [...requested.constraints.cwdRoots],
            networkProfiles: [...requested.constraints.networkProfiles],
          } };
        }
        case "browser": {
          if (!config.view().flags.isAgentNetworkEnabled) return undefined;
          const configuredOrigins = (browserOrigins ?? []).map((origin) => {
            try { return parseDelegatedBrowserOrigin(origin); } catch { return null; }
          }).filter((origin): origin is string => origin !== null);
          const origins = configuredOrigins.filter((origin) => requested.constraints.origins.includes(origin));
          return { ...base, kind: "browser", constraints: { commandClasses: ["navigate", "observe", "interact", "input", "upload", "handoff"], origins, partitionAgentId: agentId } };
        }
        case "mcp": {
          const configuredServers = new Set((config.view().mcpServers ?? []).map((server) => server.id));
          const tools = await mcpManager.getProviderTools(agentId);
          const available = tools.flatMap((tool) => {
            try { return [fromMcpProviderToolName(tool.function.name)]; } catch { return []; }
          });
          const authorizedTools = available.filter((tool) => configuredServers.has(tool.serverId));
          return { ...base, kind: "mcp", constraints: { tools: authorizedTools } };
        }
        case "skill": {
          const policy = resolveAgentSkillPolicy(config.view(), agentId);
          const skillIds = skillCatalog.list("").map((skill) => skill.id)
            .filter((id) => isSkillAllowed(policy, id) && isModelSelectable(skillCatalog.invocationPolicy(id)));
          return { ...base, kind: "skill", constraints: { skillIds } };
        }
      }
    } catch {
      return undefined;
    }
  };
}

export interface DelegatedTaskExecutorDeps {
  homes: Pick<AgentHomeStore, "pathFor"> | undefined;
  executionBroker: Pick<LocalExecutionBroker, "execute"> | undefined;
  sharedTools: SharedTools | undefined;
  asyncTaskStore: Pick<AsyncTaskStore, "getBudgetState">;
  config: Pick<ConfigStore, "view">;
  modelCatalog: ModelCatalogService | undefined;
  registry: ProviderRegistry;
}

/** Execute one granted async-task command inside the agent's private home. */
export function createDelegatedTaskExecutor({ homes, executionBroker, sharedTools, asyncTaskStore, config, modelCatalog, registry }: DelegatedTaskExecutorDeps): AsyncTaskRuntimeOptions["execute"] {
  return async ({ task, objective, grant, signal, runProvider, runEffect, authorize, consumeSteer }) => {
    if (grant.kind !== "provider") {
      const command = parseAsyncTaskCommandV1(objective, grant.kind);
      const resolveGrantPath = (value: string): string => {
        const home = homes?.pathFor(task.agentId);
        if (home === undefined) throw new AsyncTaskContractError("capability_denied", "Agent home is unavailable.");
        if (isAbsolute(value)) return resolve(value);
        try {
          const classified = classifyAgentPath(value);
          // A relative path whose first segment names a shared directory is
          // the virtual mount surface, not a literal home subfolder — deny
          // it instead of shadowing the real folder inside the home.
          const firstSegment = value.split(/[\\/]/u).find((part) => part.length > 0 && part !== ".") ?? "";
          const ambiguousShared = classified.kind === "home" && sharedDirectoryName(firstSegment) !== undefined;
          if ((classified.kind !== "home" && classified.kind !== "root") || isReservedHomeRelative(value) || ambiguousShared) {
            throw new AsyncTaskContractError("capability_denied", "Shared and reserved paths are not available to async tasks.");
          }
          return resolve(home, classified.kind === "root" ? "." : classified.relative);
        } catch (error) {
          if (error instanceof AsyncTaskContractError) throw error;
          throw new AsyncTaskContractError("capability_denied", "Async task path is outside the private home.");
        }
      };
      const runExecution = async (request: ExecutionRequest, operation: DelegatedCapabilityOperation, reserve: Partial<BudgetCounters>, usage: (result: ExecutionResult) => Partial<BudgetCounters>) => {
        if (executionBroker === undefined) throw new Error("Shared execution broker is unavailable.");
        const result = await runEffect(operation, () => executionBroker.execute(task.agentId, task.taskId, request, signal), {
          reserve,
          usage: (value) => ({ toolRounds: 1, toolCalls: 1, ...usage(value) }),
        });
        if (!result.ok) throw new Error(result.message);
        return result;
      };
      if (command.kind === "filesystem") {
        const request = command.request;
        if (["file.copy", "file.move", "file.trash", "file.restore"].includes(request.operation)) {
          throw new AsyncTaskContractError("capability_denied", "This filesystem mutation requires an authoritative preflight and is unavailable to async tasks.");
        }
        const operation = request.operation === "file.write" || request.operation === "file.mkdir" || request.operation === "file.copy" || request.operation === "file.move" || request.operation === "file.trash" || request.operation === "file.restore"
          ? "write" as const
          : request.operation === "file.list" || request.operation === "command.run" ? "list" as const : "read" as const;
        const path = request.operation === "file.copy" || request.operation === "file.move" ? resolveGrantPath(request.destination)
          : "path" in request ? resolveGrantPath(request.path ?? (() => { throw new Error("file.restore requires a destination path"); })())
            : request.operation === "command.run" ? resolveGrantPath(request.cwd) : task.agentId;
        if ((request.operation === "file.copy" || request.operation === "file.move") && request.source !== undefined) {
          authorize({ kind: "filesystem", operation, path: resolveGrantPath(request.source) });
        }
        if (request.operation === "command.run") {
          for (const pathValue of request.params.paths) authorize({ kind: "filesystem", operation, path: resolveGrantPath(pathValue) });
        }
        const writesUnknownBytes = request.operation === "file.copy" || request.operation === "file.move" || request.operation === "file.restore";
        const writeBytes = request.operation === "file.write"
          ? (() => {
            try { return fileContentByteLength(request.content, request.encoding); }
            catch { throw new AsyncTaskContractError("invalid_contract", "File content encoding is invalid."); }
          })()
          : 0;
        const result = await runExecution(request, { kind: "filesystem", operation, path },
          operation === "write" ? { toolCalls: 1, workspaceWriteBytes: writeBytes } : { toolCalls: 1 },
          (value) => ({ toolCalls: 1, workspaceWriteBytes: value.ok && value.operation === "file.copy" ? value.bytes : value.ok && value.operation === "file.write" ? value.bytes : writesUnknownBytes ? (asyncTaskStore.getBudgetState(task.taskId)?.budget.maxWorkspaceWriteBytes ?? 0) : 0 }));
        return { result: executionResultText(result) };
      }
      if (command.kind === "process") {
        const request = command.request;
        const result = await runExecution(request, { kind: "process", operation: "run", executable: request.executable, cwd: resolveGrantPath(request.cwd), networkProfile: request.networkProfile }, { toolCalls: 1 }, () => ({ toolCalls: 1 }));
        return { result: executionResultText(result) };
      }
      if (command.kind === "browser") {
        const request = command.request;
        if (request.operation !== "browser.open" && request.operation !== "browser.navigate") throw new Error("Browser task requires a URL-bearing open or navigate command.");
        const requestUrl = request.url;
        if (requestUrl === undefined) throw new Error("Browser open requires a URL for delegated execution.");
        let requestOrigin: string;
        try { requestOrigin = new URL(requestUrl).origin; } catch { throw new Error("Browser URL is invalid."); }
        if (requestOrigin !== command.origin) throw new Error("Browser command origin does not match its URL.");
        const commandClass = "navigate" as const;
        const result = await runExecution(request, { kind: "browser", commandClass, origin: command.origin, partitionAgentId: task.agentId }, { browserCommands: 1 }, () => ({ browserCommands: 1 }));
        return { result: executionResultText(result) };
      }
      if (sharedTools === undefined) {
        throw new Error("Shared Skills/MCP executor is unavailable.");
      }
      const executor = sharedTools.executor();
      const call = command.kind === "mcp"
        ? { id: task.taskId, type: "function" as const, function: { name: toMcpProviderToolName(command.request.serverId, command.request.toolName), arguments: JSON.stringify(command.request.args) } }
        : (() => {
          if (Object.keys(command.request.args).length !== 0) throw new Error("Skill task args must be empty; use the canonical skill id only.");
          return { id: task.taskId, type: "function" as const, function: { name: "use_skill", arguments: JSON.stringify({ id: command.request.skillId }) } };
        })();
      const operation: DelegatedCapabilityOperation = command.kind === "mcp"
        ? { kind: "mcp", serverId: command.request.serverId, toolName: command.request.toolName }
        : { kind: "skill", skillId: command.request.skillId };
      const toolResult = await runEffect(operation, () => executor({ agentId: task.agentId, call, signal }), {
        reserve: { toolCalls: 1, ...(command.kind === "mcp" ? { mcpCalls: 1 } : {}) },
        usage: () => ({ toolRounds: 1, toolCalls: 1, ...(command.kind === "mcp" ? { mcpCalls: 1 } : {}) }),
      });
      if (!toolResult.handled || !toolResult.ok) throw new Error(toolResult.handled ? toolResult.error ?? "Shared tool execution failed." : "No shared executor handled the task command.");
      return { result: toolResult.content };
    }
    const inference = resolveAgentInference(config.view(), task.agentId);
    if (modelCatalog && isCatalogProvider(inference.provider)) {
      await modelCatalog.synchronize(inference.provider);
      inference.modelResolution = modelCatalog.resolve(inference.provider, inference.model, inference.reasoningEffort, inference.serviceTier);
    }
    const credential = grant.constraints.credentialRefs[0]
      ? { kind: "secret_ref" as const, secretRef: `provider/${inference.provider}` }
      : { kind: "none" as const };
    const budgetState = asyncTaskStore.getBudgetState(task.taskId);
    const outputRemaining = budgetState === null
      ? undefined
      : Math.max(1, budgetState.budget.maxOutputTokens - budgetState.usage.used.outputTokens - budgetState.usage.reserved.outputTokens);
    const system = "You are a bounded depth-1 OpenBot subagent.";
    let providerRequestText = `${system}\n${objective}`;
    // The grant binds the logical provider; its adapter resolves the actual
    // OAuth or API-key credential, just as it does for foreground turns.
    const streamed = await runProvider(
      { kind: "provider", adapter: inference.provider, model: inference.model, credential },
      () => {
        const steer = consumeSteer();
        const messages = steer === null
          ? [{ role: "user" as const, content: objective }]
          : [{ role: "user" as const, content: objective }, { role: "user" as const, content: `Additional instruction: ${steer}` }];
        providerRequestText = `${system}\n${messages.map((message) => message.content).join("\n")}`;
        return streamChat(inference.provider, {
          model: inference.model, reasoningEffort: inference.reasoningEffort, purpose: "async-task", system,
          modelResolution: inference.modelResolution,
          sessionId: createHash("sha256").update(JSON.stringify([task.agentId, task.taskId])).digest("hex"),
          messages, signal, maxTokens: outputRemaining,
        }, undefined, { registry, maxRetries: 0, agentId: task.agentId });
      },
      {
        requestText: () => providerRequestText,
        usage: (result) => {
          const reported = result.attempts?.at(-1)?.usage;
          return { inputTokens: reported?.inputTokens, outputTokens: reported?.outputTokens };
        },
      },
    );
    if (streamed.aborted || streamed.error || streamed.message === undefined) throw streamed.error ?? new Error("Subagent provider returned no message.");
    return { result: streamed.message.content };
  };
}
