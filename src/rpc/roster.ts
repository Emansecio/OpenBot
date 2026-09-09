import { randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { MODEL_CATALOG } from "../config/models.js";
import {
  ConfigConflictError,
  ConfigStore,
  LOCAL_PROFILE_AVATAR_SHAPES,
  MAX_AGENT_NAME_CHARS,
  MAX_LOCAL_AGENTS,
  MAX_PROFILE_AVATAR_BYTES,
  validateHostSettings,
  type LocalAgent,
  type LocalAgentRuntimeMode,
  type LocalProfile,
  type OpenBotConfig,
  type LocalProfileAvatarShape,
} from "../config/store.js";
import type { AgentHomeStore } from "../execution/home.js";
import { sanitizeAgentId } from "../execution/home.js";
import { WorkspaceQuotaError } from "../execution/quota.js";
import type { AgentRuntimeManager } from "../execution/runtime/contracts.js";
import type { Keystore } from "../keystore/index.js";
import { compatPresetEndpoints, wrapKeystoreForCompat } from "../providers/compat-presets.js";
import { testCompatConnection } from "../providers/local-discover.js";
import { OpenAiCompatAdapter, registerOpenAiCompatAdapter, unregisterOpenAiCompatAdapter, validateCompatBaseUrl } from "../providers/openai-compat.js";
import { defaultRegistry, type ProviderAdapter, type ProviderRegistry } from "../providers/router.js";
import { openCodeGoCatalogId } from "../providers/opencode-go-models.js";
import type { Gateway } from "../server/gateway.js";
import { RpcError } from "../server/gateway.js";
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  type KickstartAgentArgs,
  type KickstartAgentResult,
  type ProviderKind,
  type ReasoningEffort,
  type SandHostSettings,
} from "../shared/contracts.js";
import type { AgentActivitySnapshot, AgentActivityStore } from "./activity.js";
import type { ConversationStoreLike, TranscriptAgentSnapshot, TranscriptStore } from "./send.js";
import { catalogProviderForModel, inheritInference, isKnownCatalogModel, resolveAgentInference } from "./identity.js";

export const DEFAULT_AGENT_ID = "openbot-default";
const PNG_SIGNATURE_HEX = "89504e470d0a1a0a";
const AGENT_AVATAR_SEGMENTS = [".openbot", "avatar.png"] as const;
const PROFILE_AVATAR_FILENAME = "profile-avatar.png";
const bad = (message: string): never => { throw new RpcError(400, message); };
const booleanFlag = (value: unknown): boolean => (
  typeof value === "boolean" ? value : bad("flag deve ser boolean")
);
function record(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("roster: corpo deve ser um objeto");
  return body as Record<string, unknown>;
}

function agentIdOf(body: unknown): string | undefined {
  const value = record(body).agentId ?? record(body).id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function titleFrom(value: Record<string, unknown>, operation: string): string | undefined {
  if (!("title" in value)) return undefined;
  if (typeof value.title !== "string" || !value.title.trim()) return bad(`${operation}: title inválido`);
  return value.title.trim();
}

function summarize(agent: LocalAgent, model: string, activeId?: string, activity?: AgentActivityStore) {
  const createdAt = agent.createdAt ?? Date.now();
  const updatedAt = agent.updatedAt ?? createdAt;
  const live = activity?.get(agent.id);
  const hidden = Boolean(agent.hiddenFromSidebar);
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title ?? agent.name,
    description: agent.description ?? "",
    path: `/agents/${agent.id}`,
    createdAt,
    updatedAt,
    hasUnread: Boolean(agent.hasUnread),
    notificationsEnabled: Boolean(agent.notificationsEnabled),
    notifyOnUpdatesEnabled: Boolean(agent.notifyOnUpdatesEnabled),
    isGroup: false,
    origin: agent.origin ?? "user",
    lastMessageId: live?.lastMessageId ?? null,
    lastMessagePreview: live?.lastMessagePreview ?? null,
    lastEntry: live?.lastEntry ?? null,
    isRunning: Boolean(live?.isRunning),
    isRunningTurn: Boolean(live?.isRunning),
    isComposingMessage: false,
    awaitingUserResponse: null,
    memberIds: [] as string[],
    conversationPartnerIds: [] as string[],
    avatarId: agent.avatarId,
    avatarShape: agent.avatarShape ?? null,
    avatarColor: agent.avatarColor ?? null,
    hasCustomPicture: agent.hasCustomAvatar === true || Boolean(agent.avatarPngBase64),
    model,
    runtimeMode: agent.runtimeMode ?? "developer",
    isActive: activeId === agent.id,
    profile: {
      name: agent.name,
      title: agent.title ?? agent.name,
      description: agent.description ?? "",
      avatarId: agent.avatarId,
    },
    unread: Boolean(agent.hasUnread),
    hiddenFromSidebar: hidden,
    isHiddenFromSidebar: hidden,
  };
}

function wrapAgent(agent: LocalAgent, model: string, activeId?: string, activity?: AgentActivityStore) {
  return { agent: summarize(agent, model, activeId, activity) };
}

function toClientDefaultModel(modelId: string) {
  return {
    modelId,
    maxMode: true,
    parameters: [
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  };
}

function defaultModelForProvider(provider: string, models = MODEL_CATALOG) {
  if (provider === "openai") return models.find((entry) => entry.id === "gpt-5.6-sol") ?? models.find(entry => entry.provider === provider);
  return models.find((entry) => entry.provider === provider);
}

function resolveCreateInference(body: Record<string, unknown>, current: OpenBotConfig, models = MODEL_CATALOG): {
  provider: ProviderKind;
  model: string;
  reasoningEffort: ReasoningEffort;
} {
  if (body.provider !== undefined && typeof body.provider !== "string") return bad("createAgent: provider inválido");
  const requestedProvider = body.provider as string | undefined;
  if (requestedProvider !== undefined && !(["openai", "xai", "opencode-go", "openai-compat"] as string[]).includes(requestedProvider)) {
    return bad("createAgent: provider não suportado");
  }
  const rawModel = body.model ?? body.modelId;
  if (rawModel !== undefined && (typeof rawModel !== "string" || !rawModel.trim())) return bad("createAgent: modelo inválido");
  const requestedModel = typeof rawModel === "string" ? rawModel.trim() : undefined;
  if (body.reasoningEffort !== undefined && (
    typeof body.reasoningEffort !== "string" ||
    !(REASONING_EFFORTS as readonly string[]).includes(body.reasoningEffort)
  )) {
    return bad("createAgent: reasoningEffort inválido");
  }

  let provider = current.activeProvider;
  let model = current.globalModel;
  if (requestedModel !== undefined) {
    const catalog = models.find((entry) => entry.id === requestedModel);
    if (catalog !== undefined) {
      if (requestedProvider !== undefined && requestedProvider !== catalog.provider) {
        return bad(`createAgent: modelo ${requestedModel} incompatível com provider ${requestedProvider}`);
      }
      if (catalog.provider === "openai-compat") requireCompatBaseUrl(current.compatBaseUrl);
      provider = catalog.provider;
      model = catalog.id;
    } else {
      provider = (requestedProvider ?? current.activeProvider) as ProviderKind;
      if (provider !== "openai-compat") return bad(`createAgent: modelo não suportado: ${requestedModel}`);
      requireCompatBaseUrl(current.compatBaseUrl);
      model = requestedModel;
    }
  } else if (requestedProvider !== undefined) {
    provider = requestedProvider as ProviderKind;
    const globalCatalog = models.find((entry) => entry.id === current.globalModel);
    if (globalCatalog?.provider !== provider) {
      const fallback = defaultModelForProvider(provider, models);
      if (fallback === undefined) return bad("createAgent: provider sem modelo configurado");
      model = fallback.id;
    }
    if (provider === "openai-compat") requireCompatBaseUrl(current.compatBaseUrl);
  }
  return {
    provider,
    model,
    reasoningEffort: body.reasoningEffort as ReasoningEffort | undefined
      ?? current.globalReasoningEffort
      ?? DEFAULT_REASONING_EFFORT,
  };
}

function syncCompatAdapter(
  baseURL: string | null | undefined,
  keystore?: Keystore,
  registry?: ProviderRegistry,
): void {
  if (typeof baseURL === "string" && baseURL.length > 0) {
    validateCompatBaseUrl(baseURL);
    const scoped = wrapKeystoreForCompat(baseURL, keystore);
    if (registry) registry.register(new OpenAiCompatAdapter({ baseUrl: baseURL, keystore: scoped }));
    else registerOpenAiCompatAdapter({ baseUrl: baseURL, keystore: scoped });
    return;
  }
  if (registry) registry.unregister("openai-compat");
  else unregisterOpenAiCompatAdapter();
}

function restoreCompatAdapter(
  previous: ProviderAdapter | undefined,
  registry?: ProviderRegistry,
): void {
  const target = registry ?? defaultRegistry;
  target.unregister("openai-compat");
  if (previous !== undefined) target.register(previous);
}

function requireCompatBaseUrl(baseURL: string | null | undefined): string {
  if (typeof baseURL !== "string" || baseURL.length === 0) {
    return bad("openai-compat exige uma baseURL válida");
  }
  try {
    validateCompatBaseUrl(baseURL);
  } catch (error) {
    return bad(error instanceof Error ? error.message : "baseURL inválida");
  }
  return baseURL;
}

function ensureCompatAdapter(
  baseURL: string | null | undefined,
  keystore?: Keystore,
  registry?: ProviderRegistry,
): void {
  syncCompatAdapter(requireCompatBaseUrl(baseURL), keystore, registry);
}

const MODEL_CATALOG_CACHE_TTL_MS = 30_000;
type ModelDiscoveryAdapter = ProviderAdapter & { discoverModels: () => Promise<string[]> };
const modelDiscoveryCache = new WeakMap<ModelDiscoveryAdapter, { value?: readonly string[]; expiresAtMs: number; pending?: Promise<readonly string[]> }>();

async function discoverAvailableModels(adapter: ModelDiscoveryAdapter): Promise<readonly string[]> {
  const now = Date.now();
  const cached = modelDiscoveryCache.get(adapter);
  if (cached?.value !== undefined && cached.expiresAtMs > now) return cached.value;
  if (cached?.pending !== undefined) return cached.pending;
  const entry: { value?: readonly string[]; expiresAtMs: number; pending?: Promise<readonly string[]> } = { expiresAtMs: 0 };
  const pending = adapter.discoverModels().then((models) => {
    entry.value = [...models];
    entry.expiresAtMs = Date.now() + MODEL_CATALOG_CACHE_TTL_MS;
    entry.pending = undefined;
    return entry.value;
  }).catch((error) => {
    modelDiscoveryCache.delete(adapter);
    throw error;
  });
  entry.pending = pending;
  modelDiscoveryCache.set(adapter, entry);
  return pending;
}

export async function availableModelCatalog(registry: ProviderRegistry = defaultRegistry) {
  const local = MODEL_CATALOG.filter((entry) => entry.provider !== "opencode-go");
  const adapter = registry.get("opencode-go") as ModelDiscoveryAdapter | undefined;
  if (!adapter?.discoverModels) return local.map((entry) => ({ ...entry }));
  try {
    const available = new Set((await discoverAvailableModels(adapter)).map(openCodeGoCatalogId));
    return MODEL_CATALOG.filter((entry) => entry.provider !== "opencode-go" || available.has(entry.id)).map((entry) => ({ ...entry }));
  } catch {
    return local.map((entry) => ({ ...entry }));
  }
}

function modelIdOf(body: Record<string, unknown>): unknown {
  const raw = body.model ?? body.modelId;
  if (typeof raw === "string") return raw;
  if (isRecord(raw) && typeof raw.modelId === "string") return raw.modelId;
  if (isRecord(raw) && typeof raw.id === "string") return raw.id;
  if (isRecord(raw) && typeof raw.name === "string") return raw.name;
  return raw;
}

type HomeLifecycleFence = <T>(agentId: string, operation: () => Promise<T>) => Promise<T>;

/**
 * Minimal browser lifecycle seam used by deleteAgents.
 *
 * The roster must not depend on the browser implementation: the bootstrap
 * injects the shared browser service, while tests can provide a deterministic
 * fake.  A successful call means that every lease/tab owned by the agent has
 * been released (or was already absent).
 */
export interface BrowserAgentLifecycle {
  teardownAgent(agentId: string): Promise<void>;
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function toHomeRpcError(method: string, error: unknown): never {
  if (error instanceof RpcError) throw error;
  const code = errorCodeOf(error);
  const status = code === "conflict" ? 409
    : code === "not_found" ? 404
          : code === "access_denied" ? 403
        : code === "invalid_path" || code === "outside_workspace" || code === "unsafe_path" ? 400
          : code === "invalid_archive" || code === "integrity_error" ? 422
            : undefined;
  if (status !== undefined) {
    const message = error instanceof Error ? error.message : "operação de workspace falhou";
    throw new RpcError(status, `${method}: ${message}`);
  }
  throw error;
}

function requiredHomeAgentId(body: unknown, method: string): string {
  const b = record(body);
  const raw = b.agentId ?? b.id;
  if (typeof raw !== "string" || raw.trim().length === 0) return bad(`${method}: agentId é obrigatório`);
  try {
    return sanitizeAgentId(raw.trim());
  } catch (error) {
    return toHomeRpcError(method, error);
  }
}

function optionalHomeAgentId(body: unknown, method: string): string | undefined {
  const b = record(body);
  if (b.agentId === undefined && b.id === undefined) return undefined;
  return requiredHomeAgentId(body, method);
}

function requiredArchivePath(body: unknown, method: string, field: "archivePath" | "destination"): string {
  const b = record(body);
  const raw = field === "archivePath" ? (b.archivePath ?? b.path) : (b.destination ?? b.archivePath ?? b.path);
  if (typeof raw !== "string" || raw.trim().length === 0) return bad(`${method}: ${field} é obrigatório`);
  return raw.trim();
}

function archiveOptions(body: unknown, method: string): { maxBytes?: number; maxEntries?: number } {
  const b = record(body);
  const options: { maxBytes?: number; maxEntries?: number } = {};
  for (const field of ["maxBytes", "maxEntries"] as const) {
    const value = b[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      return bad(`${method}: ${field} deve ser um inteiro positivo`);
    }
    options[field] = value;
  }
  return options;
}

function profileAvatarPath(config: ConfigStore): string {
  return join(dirname(config.path), PROFILE_AVATAR_FILENAME);
}

async function profileForClient(config: ConfigStore): Promise<LocalProfile> {
  const profile = config.snapshot().profile;
  if (profile.hasCustomAvatar !== true) return profile;
  try {
    const bytes = await readFile(profileAvatarPath(config));
    return { ...profile, avatarPngBase64: bytes.toString("base64") };
  } catch {
    return profile;
  }
}

function agentAvatarPath(homes: AgentHomeStore, agentId: string): string {
  return join(homes.pathFor(agentId), ...AGENT_AVATAR_SEGMENTS);
}

function withoutInlineProfileAvatar(profile: LocalProfile, hasCustomAvatar: boolean): LocalProfile {
  const { avatarPngBase64: _legacyAvatar, hasCustomAvatar: _previousMarker, ...metadata } = profile;
  return hasCustomAvatar ? { ...metadata, hasCustomAvatar: true } : metadata;
}

function withoutInlineAvatar(agent: LocalAgent): LocalAgent {
  const { avatarPngBase64: _legacyAvatar, ...metadata } = agent;
  return { ...metadata, hasCustomAvatar: true };
}

export interface LegacyProfileAvatarMigrationResult {
  migrated: boolean;
  error?: string;
}

/** Moves legacy local-profile PNG bytes beside config JSON. */
export async function migrateLegacyProfileAvatar(config: ConfigStore): Promise<LegacyProfileAvatarMigrationResult> {
  const legacyBase64 = config.snapshot().profile.avatarPngBase64;
  if (legacyBase64 === undefined) return { migrated: false };

  const path = profileAvatarPath(config);
  let previous: Buffer | undefined;
  try {
    try {
      previous = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(path, Buffer.from(legacyBase64, "base64"));
    const committed = config.mutateProfile((current) => (
      current.profile.avatarPngBase64 === legacyBase64
        ? withoutInlineProfileAvatar(current.profile, true)
        : current.profile
    ));
    if (committed.profile.hasCustomAvatar === true && committed.profile.avatarPngBase64 === undefined) {
      return { migrated: true };
    }
    if (previous !== undefined) await writeFile(path, previous);
    else await rm(path, { force: true });
    return { migrated: false };
  } catch (error) {
    let rollbackError: unknown;
    try {
      if (previous !== undefined) await writeFile(path, previous);
      else await rm(path, { force: true });
    } catch (caught) {
      rollbackError = caught;
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      migrated: false,
      error: rollbackError === undefined
        ? detail
        : `${detail}; rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
    };
  }
}

export interface LegacyAgentAvatarMigrationResult {
  migrated: string[];
  failed: Array<{ agentId: string; error: string }>;
}

/**
 * Moves legacy per-agent PNG payloads out of JSON config and into agent homes.
 * File writes happen first; config commit removes only unchanged legacy values.
 */
export async function migrateLegacyAgentAvatars(
  config: ConfigStore,
  homes: AgentHomeStore,
): Promise<LegacyAgentAvatarMigrationResult> {
  const candidates = config.snapshot().agents.filter(
    (agent): agent is LocalAgent & { avatarPngBase64: string } => typeof agent.avatarPngBase64 === "string",
  );
  const failed: LegacyAgentAvatarMigrationResult["failed"] = [];
  const staged: Array<{
    agentId: string;
    legacyBase64: string;
    path: string;
    previous?: Buffer;
  }> = [];

  for (const agent of candidates) {
    try {
      const bytes = Buffer.from(agent.avatarPngBase64, "base64");
      const home = await homes.ensure(agent.id);
      const path = join(home.root, ...AGENT_AVATAR_SEGMENTS);
      let previous: Buffer | undefined;
      try {
        previous = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeFile(path, bytes);
      staged.push({ agentId: agent.id, legacyBase64: agent.avatarPngBase64, path, previous });
    } catch (error) {
      failed.push({ agentId: agent.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (staged.length === 0) return { migrated: [], failed };

  const restoreFile = async (entry: typeof staged[number]): Promise<void> => {
    if (entry.previous !== undefined) await writeFile(entry.path, entry.previous);
    else await rm(entry.path, { force: true });
  };

  try {
    const expected = new Map(staged.map((entry) => [entry.agentId, entry.legacyBase64]));
    const committed = config.mutate((current) => ({
      agents: current.agents.map((agent) => {
        const legacy = expected.get(agent.id);
        return legacy !== undefined && agent.avatarPngBase64 === legacy
          ? withoutInlineAvatar(agent)
          : agent;
      }),
    }));
    const migrated = staged
      .filter((entry) => committed.agents.some((agent) =>
        agent.id === entry.agentId && agent.hasCustomAvatar === true && agent.avatarPngBase64 === undefined,
      ))
      .map((entry) => entry.agentId);
    const migratedSet = new Set(migrated);
    for (const entry of staged) {
      if (migratedSet.has(entry.agentId)) continue;
      try {
        await restoreFile(entry);
      } catch (error) {
        failed.push({ agentId: entry.agentId, error: `rollback: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return { migrated, failed };
  } catch (error) {
    for (const entry of staged) {
      try {
        await restoreFile(entry);
      } catch (rollbackError) {
        failed.push({ agentId: entry.agentId, error: `rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}` });
      }
      failed.push({ agentId: entry.agentId, error: error instanceof Error ? error.message : String(error) });
    }
    return { migrated: [], failed };
  }
}

export function registerRosterHandlers(
  gateway: Gateway,
  config: ConfigStore,
  homes?: AgentHomeStore,
  keystore?: Keystore,
  activity?: AgentActivityStore,
  registry?: ProviderRegistry,
  store?: TranscriptStore,
  onDeleteAgents?: (agentIds: readonly string[]) => Promise<void>,
  /** Runs after prompt/runtime quiescence and before home removal/config commit. */
  beforeDeleteBrowser?: (agentIds: readonly string[]) => Promise<void>,
  beforeDeleteAgents?: (agentIds: readonly string[]) => Promise<void> | void,
  afterDeleteAgents?: (agentIds: readonly string[]) => void,
  /** Runs only after roster, home, and persistence cleanup have committed. */
  onDeleteAgentsCommitted?: (agentIds: readonly string[]) => Promise<void> | void,
  runtimeManager?: AgentRuntimeManager,
  homeLifecycleFence?: HomeLifecycleFence,
  conversationStore?: ConversationStoreLike,
  onAgentHomeReady?: (agentId: string) => void,
  kickstartAgent?: (args: KickstartAgentArgs) => Promise<KickstartAgentResult>,
  isAgentDeletionPending?: (agentId: string) => boolean,
  assertManagedDiskBudget?: (extraBytes?: number) => Promise<void>,
): void {
  const modelCatalog = config.modelCatalog;
  const catalogModels = () => modelCatalog?.available() ?? MODEL_CATALOG;
  const selectedCatalogModel = (id: string) => catalogModels().find(m => m.id === id);
  let activeAgentId: string | undefined = config.snapshot().agents[0]?.id;
  const clearAgentHomeRepair = (agentId: string): void => {
    onAgentHomeReady?.(agentId);
    runtimeManager?.clearAgentRepairRequired?.(agentId);
  };
  const agentLifecycleLocks = new Map<string, Promise<void>>();
  const reservedAgentSlots = new Set<string>();
  let recentImplicitCreate: { key: string; agentId: string; expiresAt: number } | undefined;
  const withAgentLifecycleLock = async <T>(agentId: string, task: () => Promise<T>): Promise<T> => {
    const key = agentId.toLowerCase();
    const previous = agentLifecycleLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    agentLifecycleLocks.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (agentLifecycleLocks.get(key) === tail) agentLifecycleLocks.delete(key);
    }
  };
  const withAgentLifecycleLocks = async <T>(agentIds: readonly string[], task: () => Promise<T>): Promise<T> => {
    const ordered = [...new Map(agentIds.map((agentId) => [agentId.toLowerCase(), agentId])).values()]
      .sort((left, right) => left.localeCompare(right));
    const enter = (index: number): Promise<T> => index >= ordered.length
      ? task()
      : withAgentLifecycleLock(ordered[index]!, () => enter(index + 1));
    return enter(0);
  };
  const effectiveAgentCount = (state: OpenBotConfig): number => {
    const liveIds = new Set(state.agents.map((agent) => agent.id.toLowerCase()));
    let reserved = 0;
    for (const agentId of reservedAgentSlots) if (!liveIds.has(agentId)) reserved += 1;
    return state.agents.length + reserved;
  };
  const requireAgentCapacity = (state: OpenBotConfig, operation: string): void => {
    if (effectiveAgentCount(state) >= MAX_LOCAL_AGENTS) {
      throw new RpcError(409, `${operation}: limite de ${MAX_LOCAL_AGENTS} agentes atingido`);
    }
  };
  const admitManagedDisk = async (operation: string, extraBytes?: number): Promise<void> => {
    if (!assertManagedDiskBudget) return;
    try {
      await assertManagedDiskBudget(extraBytes);
    } catch (error) {
      if (error instanceof WorkspaceQuotaError) {
        throw new RpcError(409, `${operation}: limite global de disco atingido`);
      }
      throw error;
    }
  };
  const modelOf = (agent: LocalAgent) => {
    // Hot path (roster publication): resolveAgentInference reads only
    // `agent.model`/`agent.provider` plus the config-level fallbacks.
    // When agent.model is set, no config fallback is consulted, so we can
    // answer without cloning the whole config (snapshot()). Otherwise,
    // fall back to the snapshot-based path for identical behavior.
    if (agent.model) {
      return resolveAgentInference(
        { agents: [agent] } as unknown as Parameters<typeof resolveAgentInference>[0],
        agent.id,
      ).model;
    }
    return resolveAgentInference(config.snapshot(), agent.id).model;
  };
  const agents = () => {
    const list = config.snapshot().agents;
    if (list.some((entry) => entry.createdAt === undefined || entry.updatedAt === undefined)) {
      const now = Date.now();
      return config.mutate((current) => ({
        agents: current.agents.map((entry) => ({
          ...entry,
          createdAt: entry.createdAt ?? now,
          updatedAt: entry.updatedAt ?? now,
        })),
      })).agents;
    }
    return list;
  };
  const requireAgent = (body: unknown, optional = false): LocalAgent => {
    const id = agentIdOf(body);
    if (id === undefined) {
      if (optional) {
        const first = agents()[0];
        if (first) return first;
      }
      return bad("agente não encontrado");
    }
    const found = agents().find((entry) => entry.id === id);
    if (!found) return bad("agente não encontrado");
    return found;
  };
  const publishRoster = (activeId?: string) => {
    if (activeId) activeAgentId = activeId;
    const list = agents().map((entry) => summarize(entry, modelOf(entry), activeAgentId, activity));
    gateway.publish("agents", { agents: list, activeAgentId });
  };
  activity?.subscribe(() => publishRoster());

  gateway.registerHandler("getLocalProfile", () => profileForClient(config));
  gateway.registerHandler("updateLocalProfile", async (body) => {
    const b = record(body);
    const snapshot = config.snapshot();
    let next: LocalProfile = { ...snapshot.profile };

    if (b.name !== undefined) {
      if (typeof b.name !== "string") return bad("updateLocalProfile: name inválido");
      const name = b.name.replace(/\s+/g, " ").trim();
      if (!name || name.length > MAX_AGENT_NAME_CHARS || name.includes("\0")) return bad("updateLocalProfile: name inválido");
      next.name = name;
    }
    if (b.avatarId !== undefined) {
      if (typeof b.avatarId !== "string" || !b.avatarId.trim() || b.avatarId.includes("\0")) return bad("updateLocalProfile: avatarId inválido");
      next.avatarId = b.avatarId.trim();
    }
    if (b.avatarShape !== undefined) {
      if (b.avatarShape === null) delete next.avatarShape;
      else if (typeof b.avatarShape !== "string" || !LOCAL_PROFILE_AVATAR_SHAPES.includes(b.avatarShape as LocalProfileAvatarShape)) {
        return bad("updateLocalProfile: avatarShape inválido");
      } else next.avatarShape = b.avatarShape as LocalProfileAvatarShape;
    }
    if (b.avatarColor !== undefined) {
      if (b.avatarColor === null) delete next.avatarColor;
      else if (typeof b.avatarColor !== "string" || !/^#[0-9a-f]{6}$/i.test(b.avatarColor)) return bad("updateLocalProfile: avatarColor inválido");
      else next.avatarColor = b.avatarColor;
    }

    const avatarChanged = b.avatarPngBase64 !== undefined;
    let avatarBytes: Buffer | undefined;
    if (avatarChanged && b.avatarPngBase64 !== null) {
      if (typeof b.avatarPngBase64 !== "string" || b.avatarPngBase64.length > Math.ceil(MAX_PROFILE_AVATAR_BYTES * 4 / 3) + 8) {
        return bad("updateLocalProfile: avatar PNG inválido");
      }
      avatarBytes = Buffer.from(b.avatarPngBase64, "base64");
      if (avatarBytes.length < 8 || avatarBytes.length > MAX_PROFILE_AVATAR_BYTES || avatarBytes.subarray(0, 8).toString("hex") !== PNG_SIGNATURE_HEX) {
        return bad("updateLocalProfile: avatar PNG inválido");
      }
      next = withoutInlineProfileAvatar(next, true);
    } else if (avatarChanged) {
      next = withoutInlineProfileAvatar(next, false);
    }

    const path = profileAvatarPath(config);
    let previousAvatar: Buffer | undefined;
    if (avatarChanged) {
      try {
        previousAvatar = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (avatarBytes !== undefined) await writeFile(path, avatarBytes);
      else await rm(path, { force: true });
    }

    try {
      config.mutateProfile(() => next, { expectedRevision: snapshot.revision ?? 0 });
    } catch (error) {
      if (avatarChanged) {
        try {
          if (previousAvatar !== undefined) await writeFile(path, previousAvatar);
          else await rm(path, { force: true });
        } catch {
          // Preserve original config commit failure.
        }
      }
      if (error instanceof ConfigConflictError) throw new RpcError(409, error.message);
      throw error;
    }
    return profileForClient(config);
  });
  gateway.registerHandler("listAgents", () => agents().map((entry) => summarize(entry, modelOf(entry), activeAgentId, activity)));
  gateway.registerHandler("countAgents", () => agents().length);
  gateway.registerHandler("getAgent", (body) => summarize(requireAgent(body, true), modelOf(requireAgent(body, true)), activeAgentId, activity));
  gateway.registerHandler("openAgent", (body) => {
    const current = requireAgent(body, true);
    publishRoster(current.id);
    return summarize(current, modelOf(current), current.id, activity);
  });
  gateway.registerHandler("kickstartAgent", async (body) => {
    const b = record(body);
    // The historical zero-argument/legacy roster call is intentionally honest:
    // it does not resolve a provider and remains a no-op.
    if (b.mode === undefined) {
      requireAgent(body);
      return { isIntroductionInFlight: false };
    }
    if (b.mode !== "onboarding" || typeof b.agentId !== "string" || typeof b.clientNonce !== "string" || !b.agentId.trim() || !b.clientNonce.trim()) {
      return bad("kickstartAgent: exige agentId, clientNonce e mode=onboarding");
    }
    requireAgent({ agentId: b.agentId });
    if (kickstartAgent === undefined) throw new RpcError(503, "kickstartAgent: readiness indisponível");
    return kickstartAgent({ agentId: b.agentId.trim(), clientNonce: b.clientNonce.trim(), mode: "onboarding" });
  });
  gateway.registerHandler("searchAgents", (body) => {
    const q = record(body).query;
    if (q !== undefined && typeof q !== "string") return bad("searchAgents: query deve ser string");
    return agents()
      .filter((entry) => !q || entry.name.toLowerCase().includes(q.toLowerCase()))
      .map((entry) => summarize(entry, modelOf(entry), activeAgentId, activity));
  });
  gateway.registerHandler("createAgent", async (body) => {
    const b = record(body);
    const profile = isRecord(b.profile) ? b.profile : {};
    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim()
      : typeof profile.name === "string" && profile.name.trim() ? profile.name.trim()
      : "New Bot";
    const explicitId = typeof b.id === "string" && b.id.trim() ? b.id.trim() : undefined;
    if (b.runtimeMode !== undefined && b.runtimeMode !== "developer") {
      return bad("createAgent: runtimeMode é fixo em developer");
    }
    const runtimeMode = "developer" as const;
    const title = titleFrom(b, "createAgent") ?? titleFrom(profile, "createAgent") ?? name;
    const description = typeof b.description === "string" ? b.description : typeof profile.description === "string" ? profile.description : "";
    const origin = typeof b.origin === "string" ? b.origin : "user";
    const avatarShape = typeof b.avatarShape === "string" ? b.avatarShape : undefined;
    const avatarColor = typeof b.avatarColor === "string" ? b.avatarColor : undefined;
    await modelCatalog?.initialize();
    const inference = resolveCreateInference(b, config.snapshot(), catalogModels());
    const implicitKey = JSON.stringify([name, title, description, origin, runtimeMode ?? null, avatarShape ?? null, avatarColor ?? null, inference.provider, inference.model, inference.reasoningEffort]);
    const create = async () => {
      if (!explicitId && recentImplicitCreate?.key === implicitKey && recentImplicitCreate.expiresAt >= Date.now()) {
        const existing = agents().find((entry) => entry.id === recentImplicitCreate?.agentId);
        if (existing) return wrapAgent(existing, modelOf(existing), existing.id, activity);
      }
      requireAgentCapacity(config.snapshot(), "createAgent");
      await admitManagedDisk("createAgent");
      const avatarId = typeof b.avatarId === "string" ? b.avatarId
        : typeof profile.avatarId === "string" ? profile.avatarId
        : `avatar-${randomUUID().slice(0, 8)}`;
      const rawId = explicitId ?? `agent-${randomUUID().slice(0, 8)}`;
      let id: string;
      try {
        id = sanitizeAgentId(rawId);
      } catch {
        return bad("createAgent: id inválido");
      }
      return withAgentLifecycleLock(id, async () => {
      if (agents().some((entry) => entry.id.toLowerCase() === id.toLowerCase())) return bad("createAgent: id já existe");
      if (isAgentDeletionPending?.(id)) return bad("createAgent: id possui exclusão pendente de reconciliação");
      const now = Date.now();
      const created: LocalAgent = {
        id,
        name,
        title,
        avatarId,
        description,
        origin,
        runtimeMode,
        avatarShape,
        avatarColor,
        model: inference.model,
        provider: inference.provider,
        reasoningEffort: inference.reasoningEffort,
        createdAt: now,
        updatedAt: now,
      };
      let home;
      try {
        home = await homes?.ensure(id);
      } catch (error) {
        return toHomeRpcError("createAgent", error);
      }
      try {
        config.mutate((current) => {
          if (current.agents.some((entry) => entry.id.toLowerCase() === id.toLowerCase())) {
            return bad("createAgent: id já existe");
          }
          requireAgentCapacity(current, "createAgent");
          return { agents: [...current.agents, created] };
        });
      } catch (error) {
        if (home?.created && homes) {
          try {
            await homes.discardCreated(home);
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], "createAgent: failed to rollback home after config commit failure", { cause: rollbackError });
          }
        }
        throw error;
      }
      try {
        conversationStore?.ensureDefault(id);
      } catch (error) {
        try {
          config.mutate((current) => ({ agents: current.agents.filter((entry) => entry.id !== id) }));
          if (home?.created && homes) await homes.discardCreated(home);
          conversationStore?.clear?.(id);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "createAgent: failed to rollback conversation after initialization failure", { cause: rollbackError });
        }
        throw error;
      }
      // Bots created by another bot must not yank the user's open chat:
      // only user-initiated creations switch the active agent.
      const keepCurrentChat = origin.startsWith("agent:") && activeAgentId !== undefined;
      const effectiveActiveId = keepCurrentChat ? activeAgentId : id;
      const wrapped = wrapAgent(created, modelOf(created), effectiveActiveId, activity);
      gateway.publish("agent-upserted", { ...wrapped, activeAgentId: effectiveActiveId });
      publishRoster(keepCurrentChat ? undefined : id);
      if (!explicitId) recentImplicitCreate = { key: implicitKey, agentId: id, expiresAt: Date.now() + 2_000 };
      return wrapped;
      });
    };
    return explicitId ? create() : withAgentLifecycleLock("__implicit-create__", create);
  });
  gateway.registerHandler("updateAgent", (body) => {
    const b = record(body);
    const current = requireAgent(b);
    const profile = isRecord(b.profile) ? b.profile : {};
    const name = typeof b.name === "string" ? b.name : typeof profile.name === "string" ? profile.name : current.name;
    const title = titleFrom(b, "updateAgent") ?? titleFrom(profile, "updateAgent") ?? current.title;
    const avatarId = typeof b.avatarId === "string" ? b.avatarId : typeof profile.avatarId === "string" ? profile.avatarId : current.avatarId;
    const description = typeof b.description === "string" ? b.description : typeof profile.description === "string" ? profile.description : current.description;
    const avatarShape = typeof b.avatarShape === "string" ? b.avatarShape : typeof profile.avatarShape === "string" ? profile.avatarShape : current.avatarShape;
    const avatarColor = typeof b.avatarColor === "string" ? b.avatarColor : typeof profile.avatarColor === "string" ? profile.avatarColor : current.avatarColor;
    if (!name.trim()) return bad("updateAgent: name inválido");
    const committed = config.mutate((state) => ({
      agents: state.agents.map((entry) => entry.id === current.id
        ? { ...entry, name: name.trim(), title, avatarId, description, avatarShape, avatarColor, updatedAt: Date.now() }
        : entry),
      ...(current.id === DEFAULT_AGENT_ID ? { profile: { name: name.trim(), avatarId } } : {}),
    }));
    const updated = committed.agents.find((entry) => entry.id === current.id)!;
    const wrapped = wrapAgent(updated, modelOf(updated), current.id, activity);
    gateway.publish("agent-upserted", { ...wrapped, activeAgentId });
    publishRoster();
    return wrapped.agent;
  });
  gateway.registerHandler("setAgentAvatarBytes", async (body) => {
    const b = record(body);
    const requestedAgent = requireAgent(b);
    const pngBase64 = typeof b.pngBase64 === "string" ? b.pngBase64 : typeof b.bytesBase64 === "string" ? b.bytesBase64 : "";
    if (!pngBase64) return bad("setAgentAvatarBytes: pngBase64 é obrigatório");
    let decoded: Buffer;
    try {
      decoded = Buffer.from(pngBase64, "base64");
    } catch {
      return bad("setAgentAvatarBytes: png inválido");
    }
    if (decoded.length < 8 || decoded.length > 700 * 1024 || decoded.subarray(0, 8).toString("hex") !== PNG_SIGNATURE_HEX) {
      return bad("setAgentAvatarBytes: PNG inválido (máx 700 KiB)");
    }
    return withAgentLifecycleLock(requestedAgent.id, async () => {
    if (!homes) throw new RpcError(503, "setAgentAvatarBytes: workspace local indisponível");
    const current = requireAgent(b);
    const home = await homes.ensure(current.id);
    const avatarPath = join(home.root, ...AGENT_AVATAR_SEGMENTS);
    let previousAvatar: Buffer | undefined;
    try {
      previousAvatar = await readFile(avatarPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(avatarPath, decoded);
    let committed: OpenBotConfig;
    try {
      committed = config.mutate((state) => ({
        agents: state.agents.map((entry) => entry.id === current.id
          ? { ...withoutInlineAvatar(entry), updatedAt: Date.now() }
          : entry),
      }));
    } catch (error) {
      try {
        if (previousAvatar !== undefined) await writeFile(avatarPath, previousAvatar);
        else await rm(avatarPath, { force: true });
      } catch {
        // Preserve original config commit failure.
      }
      throw error;
    }
    const updated = committed.agents.find((entry) => entry.id === current.id)!;
    const wrapped = wrapAgent(updated, modelOf(updated), current.id, activity);
    gateway.publish("agent-upserted", { ...wrapped, activeAgentId });
    publishRoster();
    return wrapped.agent;
    });
  });
  gateway.registerHandler("getAgentAvatar", async (body) => {
    const current = requireAgent(body);
    if (homes) {
      try {
        const bytes = await readFile(agentAvatarPath(homes, current.id));
        return { pngBase64: bytes.toString("base64") };
      } catch {
        // fallback para o valor persistido no config
      }
    }
    if (current.avatarPngBase64) return { pngBase64: current.avatarPngBase64 };
    return { pngBase64: null };
  });

  const runHomeLifecycle = <T>(method: string, agentId: string, operation: () => Promise<T>): Promise<T> => {
    const task = async (): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        return toHomeRpcError(method, error);
      }
    };
    return homeLifecycleFence ? homeLifecycleFence(agentId, task) : task();
  };

  gateway.registerHandler("listQuarantinedAgents", async () => {
    if (!homes) throw new RpcError(503, "listQuarantinedAgents: workspace local indisponível");
    try {
      return await homes.listQuarantine();
    } catch (error) {
      return toHomeRpcError("listQuarantinedAgents", error);
    }
  });

  gateway.registerHandler("restoreAgentHome", async (body) => {
    if (!homes) throw new RpcError(503, "restoreAgentHome: workspace local indisponível");
    const method = "restoreAgentHome";
    const agentId = requiredHomeAgentId(body, method);
    const b = record(body);
    const rawQuarantineId = b.quarantineId;
    if (rawQuarantineId !== undefined && (typeof rawQuarantineId !== "string" || rawQuarantineId.trim().length === 0)) {
      return bad(`${method}: quarantineId inválido`);
    }
    const quarantineId = typeof rawQuarantineId === "string" ? rawQuarantineId.trim() : undefined;
    return runHomeLifecycle(method, agentId, async () => {
      const restored = await homes.restore(agentId, quarantineId);
      const result = { ...restored, inventory: await homes.inventory(agentId) };
      clearAgentHomeRepair(agentId);
      return result;
    });
  });

  gateway.registerHandler("exportAgentHome", async (body) => {
    if (!homes) throw new RpcError(503, "exportAgentHome: workspace local indisponível");
    const method = "exportAgentHome";
    const agentId = requiredHomeAgentId(body, method);
    const options = archiveOptions(body, method);
    const b = record(body);
    if (b.overwrite !== undefined && typeof b.overwrite !== "boolean") return bad(`${method}: overwrite deve ser booleano`);
    const overwrite = typeof b.overwrite === "boolean" ? b.overwrite : undefined;
    const destination = requiredArchivePath(body, method, "destination");
    return runHomeLifecycle(method, agentId, async () => homes.exportArchive(agentId, destination, {
      ...options,
      ...(overwrite === undefined ? {} : { overwrite }),
    }));
  });

  gateway.registerHandler("importAgentHome", async (body) => {
    if (!homes) throw new RpcError(503, "importAgentHome: workspace local indisponível");
    const method = "importAgentHome";
    const agentId = requiredHomeAgentId(body, method);
    const archivePath = requiredArchivePath(body, method, "archivePath");
    const options = archiveOptions(body, method);
    return runHomeLifecycle(method, agentId, async () => {
      const extraBytes = await stat(archivePath).then((info) => info.size).catch(() => 0);
      await admitManagedDisk(method, extraBytes);
      const imported = await homes.importArchive(agentId, archivePath, options);
      return { ...imported, inventory: await homes.inventory(agentId) };
    });
  });

  gateway.registerHandler("getWorkspaceInventory", async (body) => {
    if (!homes) throw new RpcError(503, "getWorkspaceInventory: workspace local indisponível");
    const method = "getWorkspaceInventory";
    const agentId = optionalHomeAgentId(body, method);
    if (agentId !== undefined) return runHomeLifecycle(method, agentId, async () => homes.inventory(agentId));
    try {
      return await homes.inventory();
    } catch (error) {
      return toHomeRpcError(method, error);
    }
  });

  gateway.registerHandler("repairAgentHome", async (body) => {
    if (!homes) throw new RpcError(503, "repairAgentHome: workspace local indisponível");
    const method = "repairAgentHome";
    const agentId = requiredHomeAgentId(body, method);
    return runHomeLifecycle(method, agentId, async () => {
      const repaired = await homes.repair(agentId);
      clearAgentHomeRepair(agentId);
      return repaired;
    });
  });

  gateway.registerHandler("deleteAgents", async (body) => {
    const ids = record(body).ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return bad("deleteAgents: ids inválidos");
    const canonicalIds = new Map(agents().map((agent) => [agent.id.toLowerCase(), agent.id]));
    const uniqueIds = [...new Set(ids.map((id) => canonicalIds.get(id.toLowerCase())).filter((id): id is string => id !== undefined))];
    if (uniqueIds.length === 0) return { ok: true, ids: [] };
    return withAgentLifecycleLocks(uniqueIds, async () => {
    const lockedCanonicalIds = new Map(agents().map((agent) => [agent.id.toLowerCase(), agent.id]));
    const lockedUniqueIds = [...new Set(uniqueIds.map((id) => lockedCanonicalIds.get(id.toLowerCase())).filter((id): id is string => id !== undefined))];
    if (lockedUniqueIds.length === 0) return { ok: true, ids: [] };
    for (const agentId of lockedUniqueIds) reservedAgentSlots.add(agentId.toLowerCase());
    const previousAgents = agents();
    let remaining = previousAgents.filter((entry) => !lockedUniqueIds.includes(entry.id));
    const previousActiveAgentId = activeAgentId;
    const removedHomes: Array<{ agentId: string; quarantineId: string }> = [];
    const transcriptSnapshots = new Map<string, TranscriptAgentSnapshot>();
    const activitySnapshots = new Map<string, AgentActivitySnapshot>();
    let rosterCommitted = false;
    let persistenceCleanupStarted = false;
    let irreversibleDeletion = false;
    const runtimeFence = runtimeManager as (AgentRuntimeManager & {
      releaseAgentFence?(agentId: string): void;
    }) | undefined;
    try {
      await beforeDeleteAgents?.(lockedUniqueIds);
      await onDeleteAgents?.(lockedUniqueIds);
      // Browser teardown is deliberately before the home transaction. A
      // browser failure therefore leaves the bot fully registered and its
      // workspace recoverable.
      await beforeDeleteBrowser?.(lockedUniqueIds);
      for (const agentId of lockedUniqueIds) {
        if (store?.snapshotAgent) transcriptSnapshots.set(agentId, store.snapshotAgent(agentId));
        if (activity) activitySnapshots.set(agentId, activity.snapshot(agentId));
      }
      if (homes) {
        for (const agentId of lockedUniqueIds) {
          const quarantineId = await homes.remove(agentId);
          if (quarantineId !== undefined) removedHomes.push({ agentId, quarantineId });
        }
      }
      // Lifecycle callbacks and home removal await external work. Reload the
      // roster after those awaits so concurrent CRUD changes survive this
      // deletion; only the requested IDs are removed from the current state.
      const committed = config.mutate((current) => ({
        agents: current.agents.filter((entry) => !lockedUniqueIds.includes(entry.id)),
      }));
      remaining = committed.agents;
      rosterCommitted = true;
      // From this point on, persistence cleanup may have partially completed.
      // Rollback is allowed only after every affected store has been restored;
      // otherwise the safe state is a deleted roster entry, never a reactivated
      // agent with an incomplete transcript/ledger/activity state.
      persistenceCleanupStarted = true;
      if (lockedUniqueIds.length > 1 && store?.clearAgents !== undefined) store.clearAgents(lockedUniqueIds);
      else for (const id of lockedUniqueIds) store?.clear(id);
      for (const id of lockedUniqueIds) activity?.clear(id, false);
      // Roster and every rollback-covered persistence store are now clean.
      // Failures in post-commit purges must leave the agent deleted and the
      // durable journal pending for startup reconciliation, never resurrect it.
      irreversibleDeletion = true;
      if (previousActiveAgentId !== undefined && lockedUniqueIds.includes(previousActiveAgentId)) {
        activeAgentId = remaining[0]?.id;
      }
      publishRoster();
      await onDeleteAgentsCommitted?.(lockedUniqueIds);
      for (const agentId of lockedUniqueIds) clearAgentHomeRepair(agentId);
      return { ok: true, ids: lockedUniqueIds };
    } catch (error) {
      if (irreversibleDeletion) throw error;
      const rollbackFailures: string[] = [];
      let persistenceRestored = !persistenceCleanupStarted;
      if (persistenceCleanupStarted) {
        persistenceRestored = store?.restoreAgent !== undefined
          && transcriptSnapshots.size === lockedUniqueIds.length
          && activitySnapshots.size === (activity ? lockedUniqueIds.length : 0);
        if (persistenceRestored) {
          for (const agentId of [...lockedUniqueIds].reverse()) {
            const snapshot = transcriptSnapshots.get(agentId);
            if (snapshot === undefined) {
              persistenceRestored = false;
              break;
            }
            try {
              store!.restoreAgent!(agentId, snapshot);
            } catch (restoreError) {
              rollbackFailures.push(`${agentId} store: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
              persistenceRestored = false;
            }
          }
          if (activity) {
            for (const agentId of [...lockedUniqueIds].reverse()) {
              const snapshot = activitySnapshots.get(agentId);
              if (snapshot === undefined) {
                persistenceRestored = false;
                continue;
              }
              try {
                activity.restore(agentId, snapshot, false);
              } catch (restoreError) {
                rollbackFailures.push(`${agentId} activity: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
                persistenceRestored = false;
              }
            }
          }
        }
      }

      if (!persistenceRestored) {
        // Do not restore config/home after a partial clear. Keeping the bot
        // absent is safer than exposing it with data that could not be
        // restored atomically. Preserve the original failure and add any
        // compensation failures without masking either cause.
        if (rollbackFailures.length > 0) {
          throw new AggregateError(
            [error, ...rollbackFailures.map((failure) => new Error(failure))],
            `deleteAgents: falha ao preservar estado durante exclusão (${rollbackFailures.join("; ")})`, { cause: error },
          );
        }
        throw error;
      }

      activeAgentId = previousActiveAgentId;
      if (rosterCommitted) {
        try {
          config.mutate((current) => {
            const currentById = new Map(current.agents.map((agent) => [agent.id.toLowerCase(), agent]));
            const previousKeys = new Set(previousAgents.map((agent) => agent.id.toLowerCase()));
            const deletedKeys = new Set(lockedUniqueIds.map((agentId) => agentId.toLowerCase()));
            return {
              agents: [
                ...previousAgents.flatMap((agent) => {
                  const live = currentById.get(agent.id.toLowerCase());
                  if (live) return [live];
                  return deletedKeys.has(agent.id.toLowerCase()) ? [agent] : [];
                }),
                ...current.agents.filter((agent) => !previousKeys.has(agent.id.toLowerCase())),
              ],
            };
          });
        } catch (rollbackError) {
          rollbackFailures.push(`config: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (homes) {
        for (const entry of [...removedHomes].reverse()) {
          try {
            await homes.restore(entry.agentId, entry.quarantineId);
          } catch (rollbackError) {
            rollbackFailures.push(`${entry.agentId}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
          }
        }
      }
      if (rollbackFailures.length > 0) {
        throw new RpcError(500, `deleteAgents: falha ao reverter exclusão (${rollbackFailures.join("; ")})`);
      }
      throw error;
    } finally {
      try {
        afterDeleteAgents?.(lockedUniqueIds);
      } finally {
        for (const agentId of lockedUniqueIds) {
          reservedAgentSlots.delete(agentId.toLowerCase());
          runtimeFence?.releaseAgentFence?.(agentId);
        }
      }
    }
    });
  });
  gateway.registerHandler("duplicateAgent", async (body) => {
    const source = requireAgent(body);
    requireAgentCapacity(config.snapshot(), "duplicateAgent");
    await admitManagedDisk("duplicateAgent");
    const id = sanitizeAgentId(`agent-${randomUUID().slice(0, 8)}`);
    if (isAgentDeletionPending?.(id)) return bad("duplicateAgent: id possui exclusão pendente de reconciliação");
    const now = Date.now();
    const copy: LocalAgent = {
      id,
      name: `${source.name} (cópia)`,
      title: source.title ?? source.name,
      avatarId: source.avatarId,
      description: source.description,
      origin: source.origin ?? "user",
      avatarShape: source.avatarShape,
      avatarColor: source.avatarColor,
      ...(source.runtimeMode === undefined ? {} : { runtimeMode: source.runtimeMode }),
      ...inheritInference(source, config.snapshot()),
      createdAt: now,
      updatedAt: now,
    };
    let home;
    try {
      home = await homes?.ensure(id);
    } catch (error) {
      return toHomeRpcError("duplicateAgent", error);
    }
    try {
      config.mutate((current) => {
        if (current.agents.some((agent) => agent.id.toLowerCase() === id.toLowerCase())) {
          return bad("duplicateAgent: id já existe");
        }
        requireAgentCapacity(current, "duplicateAgent");
        return { agents: [...current.agents, copy] };
      });
    } catch (error) {
      if (home?.created && homes) {
        try {
          await homes.discardCreated(home);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "duplicateAgent: failed to rollback home after config commit failure", { cause: rollbackError });
        }
      }
      throw error;
    }
    try {
      conversationStore?.ensureDefault(id);
    } catch (error) {
      try {
        config.mutate((current) => ({ agents: current.agents.filter((entry) => entry.id !== id) }));
        if (home?.created && homes) await homes.discardCreated(home);
        conversationStore?.clear?.(id);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "duplicateAgent: failed to rollback conversation after initialization failure", { cause: rollbackError });
      }
      throw error;
    }
    const wrapped = wrapAgent(copy, modelOf(copy), id, activity);
    gateway.publish("agent-upserted", { ...wrapped, activeAgentId: id });
    publishRoster(id);
    return wrapped;
  });
  gateway.registerHandler("setAgentRuntimeMode", (body) => {
    const b = record(body);
    const current = requireAgent(b);
    if (b.mode !== "developer") return bad("runtimeMode é fixo em developer");
    const runtimeMode: LocalAgentRuntimeMode = "developer";
    const committed = config.mutate((state) => ({
      agents: state.agents.map((entry) => entry.id === current.id ? { ...entry, runtimeMode, updatedAt: Date.now() } : entry),
    }));
    const updated = committed.agents.find((entry) => entry.id === current.id)!;
    publishRoster();
    return { agentId: updated.id, runtimeMode: updated.runtimeMode ?? "developer" };
  });
  gateway.registerHandler("getAvailableModels", () => modelCatalog?.available() ?? availableModelCatalog(registry ?? defaultRegistry));
  gateway.registerHandler("getProviderModelCatalog", async body => {
    const b = record(body);
    if (b.provider !== "openai" && b.provider !== "xai" && b.provider !== "opencode-go") return bad("provider não suportado");
    if (b.refresh !== undefined && typeof b.refresh !== "boolean") return bad("refresh inválido");
    if (!modelCatalog) throw new RpcError(503, "Descoberta indisponível neste backend");
    if (b.refresh !== undefined) return modelCatalog.get(b.provider, b.refresh === true);
    await modelCatalog.synchronize(b.provider);
    return modelCatalog.peek(b.provider);
  });
  gateway.registerHandler("getAgentDefaultModel", (body) => {
    const target = agentIdOf(body) !== undefined ? requireAgent(body) : agents().find((entry) => entry.id === activeAgentId) ?? agents()[0];
    const id = target ? modelOf(target) : config.snapshot().globalModel;
    return { model: id, ...toClientDefaultModel(id) };
  });
  gateway.registerHandler("setAgentDefaultModel", async (body) => {
    await modelCatalog?.initialize();
    const b = record(body);
    const nextModel = modelIdOf(b);
    if (typeof nextModel !== "string" || !nextModel.trim()) return bad("modelo é obrigatório");
    const scoped = agentIdOf(b) !== undefined;
    const target = scoped ? requireAgent(b) : agents().find((entry) => entry.id === activeAgentId) ?? agents()[0];
    const catalogProvider = modelCatalog ? selectedCatalogModel(nextModel)?.provider : catalogProviderForModel(nextModel);
    const requestedProvider = typeof b.provider === "string" ? b.provider : undefined;
    if (catalogProvider && requestedProvider && catalogProvider !== requestedProvider) return bad("modelo incompatível com provider");
    if (!target && catalogProvider === undefined) return bad("modelo custom exige um agente");
    if (modelCatalog && !catalogProvider && requestedProvider !== "openai-compat") return bad("Modelo pendente ou indisponível. Atualize o catálogo.");
    const provider = (catalogProvider ?? requestedProvider ?? (isKnownCatalogModel(nextModel) ? undefined : "openai-compat")) as ProviderKind | undefined;
    if (catalogProvider === undefined && provider !== "openai-compat") return bad(`modelo não suportado: ${nextModel}`);
    if (provider && !(["openai", "xai", "opencode-go", "openai-compat"] as string[]).includes(provider)) return bad("provider não suportado");
    if (provider === "openai-compat") ensureCompatAdapter(config.snapshot().compatBaseUrl, keystore, registry);
    if (!target) {
      config.update({ globalModel: nextModel, activeProvider: catalogProvider! });
      return { model: nextModel, ...toClientDefaultModel(nextModel) };
    }
    if (target) {
      config.mutate((state) => ({
        agents: state.agents.map((entry) => entry.id === target.id
          ? { ...entry, model: nextModel, provider: provider ?? catalogProvider ?? entry.provider, ...(entry.model !== nextModel ? { serviceTier: "default" as const } : {}), updatedAt: Date.now() }
          : entry),
      }));
      publishRoster();
    }
    return { model: nextModel, ...toClientDefaultModel(nextModel) };
  });
  gateway.registerHandler("getActiveProvider", (body) => {
    const target = agentIdOf(body) !== undefined ? requireAgent(body) : agents().find((entry) => entry.id === activeAgentId);
    return { provider: resolveAgentInference(config.snapshot(), target?.id).provider };
  });
  gateway.registerHandler("setActiveProvider", async (body) => {
    await modelCatalog?.initialize();
    const b = record(body);
    const provider = b.provider;
    if (typeof provider !== "string") return bad("provider é obrigatório");
    if (!(["openai", "xai", "opencode-go", "openai-compat"] as string[]).includes(provider)) return bad("provider não suportado");
    if (provider === "openai-compat") ensureCompatAdapter(config.snapshot().compatBaseUrl, keystore, registry);
    const catalog = defaultModelForProvider(provider, catalogModels());
    if (!catalog) return bad("provider sem modelo configurado");
    const target = agentIdOf(b) !== undefined ? requireAgent(b) : agents().find((entry) => entry.id === activeAgentId);
    if (target) {
      config.mutate((state) => ({
        agents: state.agents.map((entry) => entry.id === target.id
          ? {
              ...entry,
              provider: provider as ProviderKind,
              ...(entry.provider !== provider ? { serviceTier: "default" as const } : {}),
              model: selectedCatalogModel(entry.model ?? "")?.provider === provider ? entry.model : catalog.id,
              updatedAt: Date.now(),
            }
          : entry),
      }));
      publishRoster();
      return { provider };
    }
    return { provider: config.update({ activeProvider: provider as ProviderKind, globalModel: catalog.id }).activeProvider };
  });
  gateway.registerHandler("getProviderConfig", (body) => {
    const current = config.snapshot();
    const target = agentIdOf(body) !== undefined ? requireAgent(body) : agents().find((entry) => entry.id === activeAgentId);
    const resolved = resolveAgentInference(current, target?.id);
    const last = target ? store?.getLatestAssistant(target.id) : undefined;
    return { provider: resolved.provider, model: resolved.model, reasoningEffort: resolved.reasoningEffort, serviceTier: resolved.serviceTier ?? "default", lastServiceTier: last?.model === resolved.model ? last.serviceTierOutcome : undefined, baseURL: current.compatBaseUrl, agentId: target?.id };
  });
  gateway.registerHandler("setProviderConfig", async (body) => {
    await modelCatalog?.initialize();
    const b = record(body);
    const current = config.snapshot();
    const requestedAgentId = agentIdOf(b);
    const explicitAgent = requestedAgentId !== undefined;
    const target = explicitAgent
      ? current.agents.find((entry) => entry.id === requestedAgentId) ?? bad("agente não encontrado")
      : current.agents.find((entry) => entry.id === activeAgentId);
    const scoped = target !== undefined;
    if (b.serviceTier !== undefined && b.serviceTier !== "default" && b.serviceTier !== "priority") return bad("Velocidade inválida");
    if (b.serviceTier === "priority" && !scoped) return bad("Selecione um bot para configurar Fast.");
    if (b.serviceTier === "priority") {
      if (!modelCatalog) return bad("Atualize o catálogo para confirmar o suporte a Fast.");
      await modelCatalog.get("openai");
    }
    if (b.requireActive === true && target?.id !== activeAgentId) return bad("o bot ativo mudou; reabra as configurações");
    const patch: { activeProvider?: ProviderKind; globalModel?: string; globalReasoningEffort?: ReasoningEffort; compatBaseUrl?: string | null; agents?: LocalAgent[] } = {};
    if (b.baseURL !== undefined) {
      if (b.baseURL !== null && typeof b.baseURL !== "string") return bad("baseURL inválida");
      const trimmed = typeof b.baseURL === "string" ? b.baseURL.trim() || null : null;
      if (trimmed) {
        try {
          validateCompatBaseUrl(trimmed);
        } catch (error) {
          return bad(error instanceof Error ? error.message : "baseURL inválida");
        }
      }
      patch.compatBaseUrl = trimmed;
    }
    const nextModel = b.model !== undefined || b.modelId !== undefined ? modelIdOf(b) : undefined;
    let agentModel = target?.model;
    let agentProvider = target?.provider;
    let agentReasoningEffort = target?.reasoningEffort ?? current.globalReasoningEffort;
    let selectsCompat = false;
    if (b.reasoningEffort !== undefined) {
      if (typeof b.reasoningEffort !== "string" || !(REASONING_EFFORTS as readonly string[]).includes(b.reasoningEffort)) {
        return bad("reasoningEffort inválido");
      }
      if (scoped) agentReasoningEffort = b.reasoningEffort as ReasoningEffort;
      else patch.globalReasoningEffort = b.reasoningEffort as ReasoningEffort;
    }
    if (nextModel !== undefined) {
      if (typeof nextModel !== "string" || !nextModel.trim()) return bad("modelo é obrigatório");
      const catalog = selectedCatalogModel(nextModel);
      if (catalog && typeof b.provider === "string" && catalog.provider !== b.provider) return bad("modelo incompatível com provider");
      if (catalog) {
        if (!scoped) {
          patch.globalModel = catalog.id;
          patch.activeProvider = catalog.provider;
        }
        agentModel = catalog.id;
        agentProvider = catalog.provider;
        selectsCompat = catalog.provider === "openai-compat";
      } else if ((typeof b.provider === "string" ? b.provider : agentProvider ?? current.activeProvider) === "openai-compat") {
        agentModel = nextModel;
        agentProvider = "openai-compat";
        selectsCompat = true;
        if (!scoped) patch.activeProvider = "openai-compat";
      } else {
        return bad(`modelo não suportado: ${nextModel}`);
      }
    } else if (typeof b.provider === "string") {
      if (!(["openai", "xai", "opencode-go", "openai-compat"] as string[]).includes(b.provider)) return bad("provider não suportado");
      const catalog = defaultModelForProvider(b.provider, catalogModels());
      if (!catalog) return bad("provider sem modelo configurado");
      if (!scoped) patch.activeProvider = b.provider as ProviderKind;
      agentProvider = b.provider as ProviderKind;
      selectsCompat = b.provider === "openai-compat";
      if (selectedCatalogModel(target?.model ?? current.globalModel)?.provider !== b.provider) {
        if (!scoped) patch.globalModel = catalog.id;
        agentModel = catalog.id;
      }
    }
    const agentPatchRequested = target !== undefined && (nextModel !== undefined || typeof b.provider === "string" || b.reasoningEffort !== undefined || b.serviceTier !== undefined);
    const changedModel = nextModel !== undefined && nextModel !== target?.model || agentProvider !== undefined && agentProvider !== target?.provider;
    const serviceTier = b.serviceTier as LocalAgent["serviceTier"] ?? (changedModel ? "default" : target?.serviceTier);
    if (agentPatchRequested) {
      const now = Date.now();
      patch.agents = current.agents.map((entry) => {
        const stamped = {
          ...entry,
          ...(entry.createdAt === undefined ? { createdAt: now } : {}),
          ...(entry.updatedAt === undefined ? { updatedAt: now } : {}),
        };
        return entry.id === target.id
          ? { ...stamped, model: agentModel ?? entry.model, provider: agentProvider ?? entry.provider, reasoningEffort: agentReasoningEffort, serviceTier, updatedAt: now }
          : stamped;
      });
    }
    const effectiveBaseURL = patch.compatBaseUrl !== undefined ? patch.compatBaseUrl : current.compatBaseUrl;
    const projected = {
      ...current,
      ...(patch.activeProvider !== undefined ? { activeProvider: patch.activeProvider } : {}),
      ...(patch.globalModel !== undefined ? { globalModel: patch.globalModel } : {}),
      ...(patch.globalReasoningEffort !== undefined ? { globalReasoningEffort: patch.globalReasoningEffort } : {}),
      ...(patch.compatBaseUrl !== undefined ? { compatBaseUrl: patch.compatBaseUrl } : {}),
      ...(patch.agents !== undefined ? { agents: patch.agents } : {}),
    };
    const clearsCompatInUse = patch.compatBaseUrl === null && (
      projected.activeProvider === "openai-compat" ||
      projected.agents.some((entry) => resolveAgentInference(projected, entry.id).provider === "openai-compat")
    );
    if (selectsCompat || clearsCompatInUse) {
      requireCompatBaseUrl(effectiveBaseURL);
    }
    const previousCompatAdapter = (registry ?? defaultRegistry).get("openai-compat");
    let next = current;
    try {
      syncCompatAdapter(effectiveBaseURL, keystore, registry);
      next = Object.keys(patch).length > 0
        ? config.update(patch, { expectedRevision: current.revision ?? 0 })
        : current;
    } catch (error) {
      try {
        restoreCompatAdapter(previousCompatAdapter, registry);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "setProviderConfig: falha ao reverter adapter após falha de commit", { cause: rollbackError },
        );
      }
      if (error instanceof ConfigConflictError) {
        throw new RpcError(409, "setProviderConfig: configuração alterada; tente novamente");
      }
      throw error;
    }
    if (agentPatchRequested) {
      publishRoster();
    }
    const resolved = resolveAgentInference(config.snapshot(), target?.id);
    return { provider: resolved.provider, model: resolved.model, reasoningEffort: resolved.reasoningEffort, serviceTier: resolved.serviceTier ?? "default", baseURL: next.compatBaseUrl, agentId: target?.id };
  });
  gateway.registerHandler("getHostSettings", () => config.snapshot().hostSettings);
  gateway.registerHandler("setHostSettings", (body) => {
    const b = record(body);
    const settings = (b.settings ?? b) as SandHostSettings;
    if (settings.localToolPermission !== undefined && settings.localToolPermission !== "always") {
      return bad("localToolPermission é fixo em always");
    }
    try {
      validateHostSettings(settings);
    } catch (error) {
      return bad(error instanceof Error ? error.message : "settings inválidos");
    }
    return config.update({
      hostSettings: { ...settings, localToolPermission: "always" },
    }).hostSettings;
  });
  // P2.4: reactToMessage is registered exclusively by src/rpc/reactions.ts
  // (durable, entry-scoped, nonce-deduped). The inert stub was retired so a
  // single authority owns the method and missing targets fail closed with 404.
  const patchFlag = (body: unknown, field: "hasUnread" | "hiddenFromSidebar" | "notificationsEnabled", value: unknown) => {
    const current = requireAgent(body);
    const flag = booleanFlag(value);
    const committed = config.mutate((state) => ({
      agents: state.agents.map((entry) => entry.id === current.id
        ? { ...entry, [field]: flag, updatedAt: Date.now() }
        : entry),
    }));
    const updated = committed.agents.find((entry) => entry.id === current.id)!;
    publishRoster();
    return summarize(updated, modelOf(updated), activeAgentId, activity);
  };
  gateway.registerHandler("setAgentUnread", (body) => {
    const b = record(body);
    return patchFlag(b, "hasUnread", b.unread ?? b.hasUnread ?? b.value);
  });
  gateway.registerHandler("setAgentHiddenFromSidebar", (body) => {
    const b = record(body);
    return patchFlag(b, "hiddenFromSidebar", b.hidden ?? b.hiddenFromSidebar ?? b.value);
  });
  gateway.registerHandler("setAgentNotificationsEnabled", (body) => {
    const b = record(body);
    return patchFlag(b, "notificationsEnabled", b.enabled ?? b.notificationsEnabled ?? b.isEnabled ?? b.value);
  });
  gateway.registerHandler("setAgentNotifyOnUpdates", (body) => {
    const b = record(body);
    const current = requireAgent(b);
    const flag = booleanFlag(b.enabled ?? b.notifyOnUpdatesEnabled ?? b.isEnabled ?? b.value);
    const committed = config.mutate((state) => ({
      agents: state.agents.map((entry) => entry.id === current.id
        ? { ...entry, notifyOnUpdatesEnabled: flag, updatedAt: Date.now() }
        : entry),
    }));
    const updated = committed.agents.find((entry) => entry.id === current.id)!;
    publishRoster();
    return summarize(updated, modelOf(updated), activeAgentId, activity);
  });
  gateway.registerHandler("discoverLocalProviders", () => ({
    endpoints: compatPresetEndpoints(),
  }));
  gateway.registerHandler("testProviderConnection", async (body) => {
    const b = record(body);
    const current = config.snapshot();
    const target = agentIdOf(b) !== undefined ? requireAgent(b) : agents().find((entry) => entry.id === activeAgentId);
    const resolved = resolveAgentInference(current, target?.id);
    const requestedProvider = typeof b.provider === "string" ? b.provider : resolved.provider;
    if (!( ["openai", "xai", "opencode-go", "openai-compat"] as string[]).includes(requestedProvider)) return bad("provider não suportado");
    if (requestedProvider === "opencode-go") {
      const adapter = (registry ?? defaultRegistry).get("opencode-go") as ModelDiscoveryAdapter | undefined;
      if (!adapter?.discoverModels) return bad("provider OpenCode Go indisponível");
      return { ok: true, models: await adapter.discoverModels() };
    }
    const provider = requestedProvider as ProviderKind;
    const baseURL = provider === "openai"
      ? "https://api.openai.com/v1"
      : provider === "xai"
        ? "https://api.x.ai/v1"
        : typeof b.baseURL === "string" && b.baseURL.trim()
          ? b.baseURL.trim()
          : current.compatBaseUrl;
    if (!baseURL) return bad("baseURL é obrigatória para OpenAI-compatible");
    const suppliedKey = typeof b.apiKey === "string" && b.apiKey.trim() ? b.apiKey.trim() : undefined;
    const apiKey = suppliedKey ?? await keystore?.reveal(provider) ?? undefined;
    if (provider !== "openai-compat" && !apiKey) return bad(`API key de ${provider} não configurada`);
    return testCompatConnection(baseURL, { apiKey });
  });
  gateway.registerHandler("getLocalRuntimeStatus", async (body) => {
    const agent = requireAgent(body, true);
    if (runtimeManager) return runtimeManager.status(agent.id, agent.runtimeMode ?? "developer");
    return {
      agentId: agent.id,
      mode: "developer",
      state: "ready",
      runtimeVersion: null,
      imageDigest: null,
      runtimeBootId: null,
      activeLeaseCount: 0,
      activeProcessCount: 0,
      lastActivityAt: null,
      lastError: null,
    };
  });
  gateway.registerHandler("repairLocalRuntime", async (body) => {
    const agent = requireAgent(body);
    if (!runtimeManager) throw new RpcError(503, "runtime local indisponível");
    return runtimeManager.repair(agent.id);
  });
  gateway.registerHandler("getForeverBoxStatus", (body) => {
    requireAgent(body, true);
    return { vncUrl: null, windows: [] };
  });
  gateway.registerHandler("ensureForeverBox", async (body) => {
    const id = requireAgent(body, true).id;
    if (!homes) throw new RpcError(503, "workspace local indisponível");
    const home = await homes.ensure(id);
    return { agentId: id, state: "ready", vncUrl: null, root: home.root };
  });
  gateway.registerHandler("handBackForeverBox", () => ({ ok: true }));
  gateway.registerHandler("isAgentNetworkEnabled", () => config.snapshot().flags.isAgentNetworkEnabled);
  gateway.registerHandler("isGlobalSearchEnabled", () => config.snapshot().flags.isGlobalSearchEnabled);
  gateway.registerHandler("isEgressTunnelAvailable", () => config.snapshot().flags.isEgressTunnelAvailable);
  gateway.registerHandler("getComputerCapabilities", () => ({ local: false, remoteExecution: false, audioTranscription: false }));
  gateway.registerHandler("transcribeAudio", () => ({ supported: false, text: "" }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
