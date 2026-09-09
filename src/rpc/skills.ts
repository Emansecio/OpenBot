import type { SkillCatalog } from "../skills/catalog.js";
import type {
  SkillInvocationPolicy,
  SkillSummary,
} from "../skills/contracts.js";
import type { Gateway, RpcHandler } from "../server/gateway.js";
import { RpcError } from "../server/gateway.js";

/** A per-agent policy can only narrow catalog permissions, never widen them. */
export interface SkillAgentPolicy {
  enabled?: boolean;
  modelInvocable?: boolean;
  userInvocable?: boolean;
  autoSelect?: boolean;
}

export type ResolveSkillPolicy = (
  agentId: string,
  skillId: string,
  summary: SkillSummary,
) => SkillAgentPolicy | boolean | undefined;

export interface SkillRpcOptions {
  /** Shared, already-rooted catalog. Chat input never supplies filesystem paths. */
  catalog?: SkillCatalog;
  /** Optional per-agent narrowing policy, evaluated on every RPC call. */
  resolveSkillPolicy?: ResolveSkillPolicy;
}

/** Exported for focused tests and small gateway adapters. */
export type SkillRpcHandler = RpcHandler;

interface EffectiveSkillPolicy {
  enabled: boolean;
  modelInvocable: boolean;
  userInvocable: boolean;
  autoSelect: boolean;
}

interface NativeSkillWorkflow {
  id: string;
  name: string;
  description: string;
  body: "";
  trigger: null;
  source: "local-skill";
  sourceRef: string;
  pluginId: null;
  publishedByCurrentUser: true;
  isEnabledForAgent: true;
  disableModelInvocation: boolean;
  filePath: "";
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RpcError(400, "skills: corpo deve ser um objeto");
  }
  return body as Record<string, unknown>;
}

function requiredAgentId(body: unknown): string {
  const record = bodyRecord(body);
  const value = record.agentId ?? record.id;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RpcError(400, "skills: agentId/id deve ser uma string não vazia");
  }
  return value.trim();
}

function optionalAgentId(body: unknown): string | undefined {
  const record = bodyRecord(body);
  const value = record.agentId ?? record.id;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RpcError(400, "skills: agentId/id deve ser uma string não vazia");
  }
  return value.trim();
}

function basePolicy(invocation: SkillInvocationPolicy | undefined): EffectiveSkillPolicy {
  return {
    enabled: true,
    modelInvocable: invocation?.modelInvocable !== false,
    userInvocable: invocation?.userInvocable !== false,
    autoSelect: invocation?.autoSelect !== false,
  };
}

function effectivePolicy(
  catalog: SkillCatalog,
  summary: SkillSummary,
  agentId: string,
  resolveSkillPolicy?: ResolveSkillPolicy,
): EffectiveSkillPolicy {
  const current = basePolicy(catalog.invocationPolicy(summary.id));
  let override: SkillAgentPolicy | boolean | undefined;
  try {
    override = resolveSkillPolicy?.(agentId, summary.id, summary);
  } catch {
    // A policy provider is an authorization boundary. A broken provider fails
    // closed instead of accidentally exposing a skill to the composer/model.
    return { enabled: false, modelInvocable: false, userInvocable: false, autoSelect: false };
  }
  if (override === undefined) return current;
  if (override === false) {
    return { enabled: false, modelInvocable: false, userInvocable: false, autoSelect: false };
  }
  if (override === true) return current;
  return {
    enabled: current.enabled && override.enabled !== false,
    modelInvocable: current.modelInvocable && override.modelInvocable !== false,
    userInvocable: current.userInvocable && override.userInvocable !== false,
    autoSelect: current.autoSelect && override.autoSelect !== false,
  };
}

function publicSkills(
  catalog: SkillCatalog | undefined,
  agentId: string | undefined,
  resolveSkillPolicy: ResolveSkillPolicy | undefined,
): SkillSummary[] {
  if (!catalog) return [];
  return [...catalog.list()].filter((summary) => {
    if (agentId === undefined) return true;
    return effectivePolicy(catalog, summary, agentId, resolveSkillPolicy).enabled;
  });
}

function nativeWorkflow(
  summary: SkillSummary,
  policy: EffectiveSkillPolicy,
): NativeSkillWorkflow {
  return {
    // The prefix makes the ID unambiguous in Tiptap workflowReference nodes;
    // the body and file path remain intentionally unavailable over this RPC.
    id: `skill:${summary.id}`,
    name: summary.name,
    description: summary.description,
    body: "",
    trigger: null,
    source: "local-skill",
    sourceRef: summary.id,
    pluginId: null,
    publishedByCurrentUser: true,
    isEnabledForAgent: true,
    disableModelInvocation: !policy.modelInvocable,
    filePath: "",
  };
}

/** Registers the three small RPCs used by the native composer and settings. */
export function registerSkillHandlers(gateway: Gateway, options: SkillRpcOptions = {}): void {
  const { catalog, resolveSkillPolicy } = options;

  gateway.registerHandler("getAgentWorkflows", (body) => {
    const agentId = requiredAgentId(body);
    if (!catalog) return [];
    return publicSkills(catalog, agentId, resolveSkillPolicy)
      .filter((summary) => {
        const policy = effectivePolicy(catalog, summary, agentId, resolveSkillPolicy);
        return policy.enabled && policy.userInvocable;
      })
      .map((summary) => nativeWorkflow(
        summary,
        effectivePolicy(catalog, summary, agentId, resolveSkillPolicy),
      ));
  });

  gateway.registerHandler("getAvailableSkills", (body) => {
    const agentId = requiredAgentId(body);
    return publicSkills(catalog, agentId, resolveSkillPolicy).filter((summary) => (
      catalog !== undefined
      && effectivePolicy(catalog, summary, agentId, resolveSkillPolicy).userInvocable
    ));
  });

  gateway.registerHandler("refreshSkills", (body) => {
    const agentId = optionalAgentId(body);
    catalog?.refresh();
    return publicSkills(catalog, agentId, resolveSkillPolicy).filter((summary) => (
      agentId === undefined
      || catalog === undefined
      || effectivePolicy(catalog, summary, agentId, resolveSkillPolicy).userInvocable
    ));
  });
}
