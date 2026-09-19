import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  type ProviderKind,
  type ReasoningEffort,
  type SandHostSettings,
} from "../shared/contracts.js";
import type { McpAgentPolicy, McpSecretRef, McpServerConfig } from "../mcp/contracts.js";
import {
  MAX_MCP_ARG_BYTES,
  MAX_MCP_ARGS,
  MAX_MCP_ENV_ENTRIES,
  MAX_MCP_RESULT_BYTES,
  MAX_MCP_SERVERS,
  MAX_MCP_TIMEOUT_MS,
} from "../mcp/security.js";
import { validateCompatBaseUrl } from "../providers/openai-compat.js";
import { isCatalogProvider, type ModelCatalogService } from "../providers/model-catalog.js";
import { writeFileAtomicSync, writeFileExclusiveSync } from "../shared/fs-atomic.js";
import { MODEL_CATALOG } from "./models.js";

export const MAX_AGENT_NAME_CHARS = 120;
export const MAX_AGENT_DESCRIPTION_BYTES = 16 * 1024;
export const MAX_PROFILE_AVATAR_BYTES = 700 * 1024;
/** Hard roster ceiling. Bounds config cloning, publication, and lifecycle fan-out. */
export const MAX_LOCAL_AGENTS = 128;
export const LOCAL_PROFILE_AVATAR_SHAPES = ["circle", "rounded", "square"] as const;
export type LocalProfileAvatarShape = typeof LOCAL_PROFILE_AVATAR_SHAPES[number];

export interface LocalProfile {
  name: string;
  avatarId: string;
  machineId: string;
  avatarShape?: LocalProfileAvatarShape;
  avatarColor?: string;
  /** External profile avatar marker. Bytes live beside config JSON. */
  hasCustomAvatar?: boolean;
  /** Legacy migration input and RPC compatibility only. */
  avatarPngBase64?: string;
}

export type LocalAgentRuntimeMode = "lite" | "browser" | "developer";

export interface LocalSkillPolicy {
  enabled: boolean;
  disabledIds?: string[];
}

export interface LocalAgentIntegrations {
  skills?: LocalSkillPolicy;
  mcp?: McpAgentPolicy;
}

export interface LocalAgent {
  id: string;
  name: string;
  /** Optional independent UI title. Legacy agents fall back to `name`. */
  title?: string;
  avatarId: string;
  description?: string;
  origin?: string;
  avatarShape?: string;
  avatarColor?: string;
  /** External avatar marker. Bytes live at `<agent-home>/.openbot/avatar.png`. */
  hasCustomAvatar?: boolean;
  /** Legacy migration input only; new writes must externalize bytes. */
  avatarPngBase64?: string;
  createdAt?: number;
  updatedAt?: number;
  hasUnread?: boolean;
  hiddenFromSidebar?: boolean;
  notificationsEnabled?: boolean;
  notifyOnUpdatesEnabled?: boolean;
  model?: string;
  provider?: ProviderKind;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: import("../providers/model-catalog.js").ServiceTier;
  runtimeMode?: LocalAgentRuntimeMode;
  integrations?: LocalAgentIntegrations;
}

export interface OpenBotFlags {
  isAgentNetworkEnabled: boolean;
  isGlobalSearchEnabled: boolean;
  isEgressTunnelAvailable: boolean;
}

export interface OpenBotConfig {
  version: 1;
  /** Monotonic host-owned revision used for compare-and-swap commits. */
  revision?: number;
  profile: LocalProfile;
  agents: LocalAgent[];
  activeProvider: ProviderKind;
  globalModel: string;
  globalReasoningEffort?: ReasoningEffort;
  compatBaseUrl: string | null;
  hostSettings: SandHostSettings;
  flags: OpenBotFlags;
  /** Shared MCP definitions. Secrets are references resolved by the host keystore. */
  mcpServers?: McpServerConfig[];
  /**
   * Opt-in do usuário: o adapter openai-compat envia `reasoning_effort` no
   * corpo chat.completions. Default false — endpoints estritos podem rejeitar
   * parâmetros desconhecidos.
   */
  compatReasoningEffort?: boolean;
}

export interface ConfigStoreOptions {
  configPath?: string;
  allowUnverifiedModels?: boolean;
}

export interface OpenBotConfigUpdate {
  profile?: Partial<LocalProfile>;
  agents?: LocalAgent[];
  activeProvider?: ProviderKind;
  globalModel?: string;
  globalReasoningEffort?: ReasoningEffort;
  compatBaseUrl?: string | null;
  hostSettings?: SandHostSettings;
  flags?: Partial<OpenBotFlags>;
  mcpServers?: McpServerConfig[];
  compatReasoningEffort?: boolean;
}

export function defaultConfigPath(): string {
  const explicitRoot = process.env.OPENBOT_DATA_ROOT?.trim();
  if (explicitRoot) return join(explicitRoot, "openbot-config.json");
  const appData = process.env.APPDATA;
  const root = appData && appData.length > 0
    ? appData
    : join(homedir(), "AppData", "Roaming");
  return join(root, "OpenBot", "openbot-config.json");
}

function createDefaultConfig(): OpenBotConfig {
  return {
    version: 1,
    revision: 0,
    profile: {
      name: "OpenBot Local",
      avatarId: "openbot-default",
      machineId: randomUUID(),
    },
    // A fresh installation intentionally has no bot.  The first bot is a
    // user-created resource, not a bootstrap fixture.
    agents: [],
    activeProvider: "xai",
    globalModel: "grok-4.6",
    globalReasoningEffort: DEFAULT_REASONING_EFFORT,
    compatBaseUrl: null,
    hostSettings: {
      timezone: "America/Sao_Paulo",
      pinnedAgents: [],
      sidebarSections: [],
      autoReviewEnabled: false,
      localToolPermission: "always",
    },
    flags: {
      isAgentNetworkEnabled: false,
      isGlobalSearchEnabled: true,
      isEgressTunnelAvailable: false,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SAFE_CONFIG_ID = /^(?!.*__)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_POLICY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const MCP_SECRET_REF_KEYS = new Set(["secretRef"]);

function configError(field: string): Error {
  return new Error(`config inválida: ${field}`);
}

function validateConfigId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_CONFIG_ID.test(value) || value.includes("__")) {
    throw configError(field);
  }
  return value;
}

function validateNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw configError(field);
  }
  return value;
}

function dedupeStrings(value: unknown, field: string, pattern = SAFE_POLICY_PATTERN): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw configError(field);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry.trim() || !pattern.test(entry)) throw configError(field);
    if (!seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}

function validateSecretRef(value: unknown, field: string): McpSecretRef {
  if (!isRecord(value) || Object.keys(value).some((key) => !MCP_SECRET_REF_KEYS.has(key)) ||
      typeof value.secretRef !== "string" || !value.secretRef.trim() || value.secretRef.includes("\0") ||
      /[\r\n]/u.test(value.secretRef)) {
    throw configError(`${field}.secretRef`);
  }
  return { secretRef: value.secretRef };
}

function validateSecretMap(value: unknown, field: string): Record<string, McpSecretRef> {
  if (!isRecord(value)) throw configError(field);
  const result: Record<string, McpSecretRef> = {};
  const entries = Object.entries(value);
  if (entries.length > MAX_MCP_ENV_ENTRIES) throw configError(field);
  for (const [key, secret] of entries) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(key)) throw configError(`${field}.${key}`);
    result[key] = validateSecretRef(secret, `${field}.${key}`);
  }
  return result;
}

function validatePositiveNumber(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw configError(field);
  return value;
}

function validateMcpUrl(value: unknown, field: string): string {
  const text = validateNonEmptyString(value, field);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw configError(field);
  }
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].some((key) => /^(?:api[-_]?key|authorization|key|password|secret|token)$/iu.test(key))) {
    throw configError(field);
  }
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (url.protocol === "http:" && !loopback.has(url.hostname.toLowerCase())) throw configError(field);
  return text;
}

function normalizeMcpServer(value: unknown, index: number): McpServerConfig {
  if (!isRecord(value)) throw configError(`mcpServers[${index}]`);
  const id = validateConfigId(value.id, `mcpServers[${index}].id`);
  if (value.transport === "http") {
    const allowed = new Set(["id", "transport", "url", "headers", "timeoutMs", "maxResultBytes", "sessionScope"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) throw configError(`mcpServers[${index}]`);
    const server: McpServerConfig = {
      id,
      transport: "http",
      url: validateMcpUrl(value.url, `mcpServers[${index}].url`),
    };
    if (value.headers !== undefined) server.headers = validateSecretMap(value.headers, `mcpServers[${index}].headers`);
    if (value.timeoutMs !== undefined) server.timeoutMs = validatePositiveNumber(value.timeoutMs, `mcpServers[${index}].timeoutMs`, MAX_MCP_TIMEOUT_MS);
    if (value.maxResultBytes !== undefined) server.maxResultBytes = validatePositiveNumber(value.maxResultBytes, `mcpServers[${index}].maxResultBytes`, MAX_MCP_RESULT_BYTES);
    if (value.sessionScope !== undefined) {
      if (value.sessionScope !== "shared" && value.sessionScope !== "agent") throw configError(`mcpServers[${index}].sessionScope`);
      server.sessionScope = value.sessionScope;
    }
    return server;
  }
  if (value.transport === "stdio") {
    const allowed = new Set(["id", "transport", "command", "args", "cwd", "env", "timeoutMs", "maxResultBytes", "sessionScope"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) throw configError(`mcpServers[${index}]`);
    const server: McpServerConfig = {
      id,
      transport: "stdio",
      command: validateNonEmptyString(value.command, `mcpServers[${index}].command`),
      cwd: validateNonEmptyString(value.cwd, `mcpServers[${index}].cwd`),
    };
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || value.args.length > MAX_MCP_ARGS) throw configError(`mcpServers[${index}].args`);
      server.args = value.args.map((arg, argIndex) => {
        const text = validateNonEmptyString(arg, `mcpServers[${index}].args[${argIndex}]`);
        if (Buffer.byteLength(text, "utf8") > MAX_MCP_ARG_BYTES) throw configError(`mcpServers[${index}].args[${argIndex}]`);
        return text;
      });
    }
    if (value.env !== undefined) server.env = validateSecretMap(value.env, `mcpServers[${index}].env`);
    if (value.timeoutMs !== undefined) server.timeoutMs = validatePositiveNumber(value.timeoutMs, `mcpServers[${index}].timeoutMs`, MAX_MCP_TIMEOUT_MS);
    if (value.maxResultBytes !== undefined) server.maxResultBytes = validatePositiveNumber(value.maxResultBytes, `mcpServers[${index}].maxResultBytes`, MAX_MCP_RESULT_BYTES);
    if (value.sessionScope !== undefined) {
      if (value.sessionScope !== "shared" && value.sessionScope !== "agent") throw configError(`mcpServers[${index}].sessionScope`);
      server.sessionScope = value.sessionScope;
    }
    return server;
  }
  throw configError(`mcpServers[${index}].transport`);
}

function normalizeMcpServers(value: unknown): McpServerConfig[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_MCP_SERVERS) throw configError("mcpServers");
  const ids = new Set<string>();
  const servers = value.map((entry, index) => {
    const server = normalizeMcpServer(entry, index);
    const key = server.id.toLowerCase();
    if (ids.has(key)) throw new Error(`config inválida: mcpServers.id duplicado: ${server.id}`);
    ids.add(key);
    return server;
  });
  return servers;
}

function normalizeMcpPolicy(value: unknown, field: string, serverIds: ReadonlySet<string>): McpAgentPolicy {
  if (!isRecord(value) || typeof value.enabled !== "boolean") throw configError(`${field}.enabled`);
  const allowed = new Set(["enabled", "serverAllowlist", "toolAllowlist", "toolDenylist"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw configError(field);
  const policy: McpAgentPolicy = { enabled: value.enabled };
  if (value.serverAllowlist !== undefined) {
    policy.serverAllowlist = dedupeStrings(value.serverAllowlist, `${field}.serverAllowlist`, SAFE_CONFIG_ID)
      .map((serverId) => {
        if (!serverIds.has(serverId.toLowerCase())) throw new Error(`config inválida: ${field}.serverAllowlist servidor desconhecido: ${serverId}`);
        return serverId;
      });
  }
  for (const listName of ["toolAllowlist", "toolDenylist"] as const) {
    const raw = value[listName];
    if (raw === undefined) continue;
    const list = dedupeStrings(raw, `${field}.${listName}`);
    for (const entry of list) {
      const slash = entry.indexOf("/");
      const providerPrefix = entry.startsWith("mcp__") ? entry.slice(5).indexOf("__") : -1;
      const serverId = slash > 0
        ? entry.slice(0, slash)
        : providerPrefix > 0
          ? entry.slice(5, 5 + providerPrefix)
          : undefined;
      if (serverId !== undefined && !serverIds.has(serverId.toLowerCase())) {
        throw new Error(`config inválida: ${field}.${listName} servidor desconhecido: ${serverId}`);
      }
    }
    policy[listName] = list;
  }
  return policy;
}

function normalizeIntegrations(value: unknown, field: string, serverIds: ReadonlySet<string>): LocalAgentIntegrations | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw configError(field);
  const allowed = new Set(["skills", "mcp", "whatsapp"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw configError(field);
  const integrations: LocalAgentIntegrations = {};
  if (value.skills !== undefined) {
    if (!isRecord(value.skills) || typeof value.skills.enabled !== "boolean") throw configError(`${field}.skills.enabled`);
    if (Object.keys(value.skills).some((key) => !["enabled", "disabledIds"].includes(key))) throw configError(`${field}.skills`);
    const skills: LocalSkillPolicy = { enabled: value.skills.enabled };
    if (value.skills.disabledIds !== undefined) {
      skills.disabledIds = [...new Set(
        dedupeStrings(value.skills.disabledIds, `${field}.skills.disabledIds`, SAFE_CONFIG_ID).map((id) => id.toLowerCase()),
      )];
    }
    integrations.skills = skills;
  }
  if (value.mcp !== undefined) integrations.mcp = normalizeMcpPolicy(value.mcp, `${field}.mcp`, serverIds);
  if (value.whatsapp !== undefined) {
    if (!isRecord(value.whatsapp) || typeof value.whatsapp.enabled !== "boolean") throw configError(`${field}.whatsapp.enabled`);
    if (Object.keys(value.whatsapp).some((key) => key !== "enabled")) throw configError(`${field}.whatsapp`);
  }
  return Object.keys(integrations).length === 0 ? undefined : integrations;
}

function validateAgent(agent: LocalAgent, ids: Set<string>, globalModel: string, serverIds: ReadonlySet<string>, allowUnverified = false): LocalAgent {
  if (!agent || typeof agent.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(agent.id)) throw new Error("config inválida: agent.id");
  if (agent.id.endsWith(".") || agent.id.endsWith(" ")) throw new Error("config inválida: agent.id");
  const stem = agent.id.split(".")[0] ?? "";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)) throw new Error("config inválida: agent.id reservado");
  const normalizedId = agent.id.toLowerCase();
  if (ids.has(normalizedId)) throw new Error(`config inválida: agent.id duplicado: ${agent.id}`);
  ids.add(normalizedId);
  if (typeof agent.name !== "string" || !agent.name.trim()) throw new Error("config inválida: agent.name");
  if (agent.name.includes("\0") || [...agent.name].length > MAX_AGENT_NAME_CHARS) {
    throw new Error("config inválida: agent.name");
  }
  if (
    agent.description !== undefined &&
    (typeof agent.description !== "string" ||
      agent.description.includes("\0") ||
      Buffer.byteLength(agent.description, "utf8") > MAX_AGENT_DESCRIPTION_BYTES)
  ) {
    throw new Error("config inválida: agent.description");
  }
  if (agent.title !== undefined && (typeof agent.title !== "string" || !agent.title.trim())) throw new Error("config inválida: agent.title");
  // Campos de exibição: rejeita somente lixo que nunca foi um valor válido
  // (tipo errado, NUL, nova linha, comprimento absurdo) — nunca um valor
  // legado que a UI já renderizava.
  if (agent.origin !== undefined && (typeof agent.origin !== "string" || agent.origin.includes("\0") || /[\r\n]/u.test(agent.origin) || agent.origin.length > 128)) {
    throw new Error("config inválida: agent.origin");
  }
  if (agent.avatarShape !== undefined && (typeof agent.avatarShape !== "string" || agent.avatarShape.includes("\0") || agent.avatarShape.length > 64)) {
    throw new Error("config inválida: agent.avatarShape");
  }
  if (agent.avatarColor !== undefined && (typeof agent.avatarColor !== "string" || agent.avatarColor.includes("\0") || /[\r\n]/u.test(agent.avatarColor) || agent.avatarColor.length > 64)) {
    throw new Error("config inválida: agent.avatarColor");
  }
  if (typeof agent.avatarId !== "string" || !agent.avatarId) throw new Error("config inválida: agent.avatarId");
  if (agent.hasCustomAvatar !== undefined && typeof agent.hasCustomAvatar !== "boolean") {
    throw new Error("config inválida: agent.hasCustomAvatar");
  }
  if (agent.avatarPngBase64 !== undefined) {
    if (typeof agent.avatarPngBase64 !== "string" || agent.avatarPngBase64.length > Math.ceil(MAX_PROFILE_AVATAR_BYTES * 4 / 3) + 8) {
      throw new Error("config inválida: agent.avatarPngBase64");
    }
    const bytes = Buffer.from(agent.avatarPngBase64, "base64");
    if (bytes.length < 8 || bytes.length > MAX_PROFILE_AVATAR_BYTES || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("config inválida: agent.avatarPngBase64");
    }
  }
  if (agent.provider !== undefined && !["openai", "xai", "opencode-go", "openai-compat"].includes(agent.provider)) throw new Error("config inválida: agent.provider");
  if (agent.runtimeMode !== undefined && !["lite", "browser", "developer"].includes(agent.runtimeMode)) throw new Error("config inválida: agent.runtimeMode");
  if (agent.model !== undefined && (typeof agent.model !== "string" || !agent.model.trim())) throw new Error("config inválida: agent.model");
  if (agent.serviceTier !== undefined && agent.serviceTier !== "default" && agent.serviceTier !== "priority") {
    throw new Error("config inválida: agent.serviceTier");
  }
  if (agent.serviceTier === "priority") {
    // Provider efetivo: explícito do agente, senão o catálogo do modelo
    // efetivo (agente pode herdar o modelo global). Comparar só com
    // `agent.model` rejeitaria `priority` num agente que herda um modelo
    // OpenAI — falso negativo que também derrubaria o load inteiro.
    const tierModel = agent.model ?? globalModel;
    const tierProvider = agent.provider ?? MODEL_CATALOG.find(m => m.id === tierModel)?.provider;
    if (tierProvider !== "openai") throw new Error("Fast requer um modelo OpenAI compatível.");
  }
  if (agent.reasoningEffort !== undefined && !(REASONING_EFFORTS as readonly unknown[]).includes(agent.reasoningEffort)) {
    throw new Error("config inválida: agent.reasoningEffort");
  }
  const effectiveModel = agent.model ?? globalModel;
  const catalog = MODEL_CATALOG.find((entry) => entry.id === effectiveModel);
  if (catalog && agent.provider && catalog.provider !== agent.provider) {
    throw new Error(`config inválida: modelo ${effectiveModel} incompatível com provider ${agent.provider}`);
  }
  if (!catalog && !allowUnverified && agent.provider !== "openai-compat") {
    throw new Error(`config inválida: modelo não suportado: ${effectiveModel}`);
  }
  const integrations = normalizeIntegrations(agent.integrations, `agents.${agent.id}.integrations`, serverIds);
  const { integrations: _legacyIntegrations, ...agentWithoutIntegrations } = agent;
  return integrations === undefined ? agentWithoutIntegrations : { ...agentWithoutIntegrations, integrations };
}

function validateAgents(agents: readonly LocalAgent[], globalModel: string, serverIds: ReadonlySet<string>, allowUnverified = false): LocalAgent[] {
  if (!Array.isArray(agents)) throw new Error("config inválida: agents");
  if (agents.length > MAX_LOCAL_AGENTS) throw new Error(`config inválida: agents excede o limite de ${MAX_LOCAL_AGENTS}`);
  const ids = new Set<string>();
  return agents.map((agent) => validateAgent(agent, ids, globalModel, serverIds, allowUnverified));
}

function validateModelProvider(config: Pick<OpenBotConfig, "activeProvider" | "globalModel">, allowUnverified = false): void {
  const supportedProviders = new Set<ProviderKind>(["openai", "xai", "opencode-go", "openai-compat"]);
  if (!supportedProviders.has(config.activeProvider)) {
    throw new Error(`provider não suportado: ${String(config.activeProvider)}`);
  }
  const model = MODEL_CATALOG.find((entry) => entry.id === config.globalModel);
  if (!model && allowUnverified) return;
  if (!model) throw new Error(`modelo não suportado: ${config.globalModel}`);
  if (model.provider !== config.activeProvider) {
    throw new Error(`provider ${config.activeProvider} incompatível com o modelo ${config.globalModel}`);
  }
}

export function validateHostSettings(settings: unknown, required = false): asserts settings is SandHostSettings {
  if (!isRecord(settings)) throw new Error("config inválida: hostSettings");
  if ((required || settings.timezone !== undefined) && typeof settings.timezone !== "string") {
    throw new Error("config inválida: hostSettings.timezone");
  }
  if (settings.pinnedAgents !== undefined &&
      (!Array.isArray(settings.pinnedAgents) || !settings.pinnedAgents.every((id) => typeof id === "string"))) {
    throw new Error("config inválida: hostSettings.pinnedAgents");
  }
  if (settings.autoReviewEnabled !== undefined && typeof settings.autoReviewEnabled !== "boolean") {
    throw new Error("config inválida: hostSettings.autoReviewEnabled");
  }
  if (settings.localToolPermission !== undefined &&
      (typeof settings.localToolPermission !== "string" || !["ask", "always", "never"].includes(settings.localToolPermission))) {
    throw new Error("config inválida: hostSettings.localToolPermission");
  }
}

const LEGACY_MODEL_IDS: Readonly<Record<string, string>> = {
  "grok-4.5": "grok-4.6",
  "gpt-4.1": "gpt-5.6-sol",
  "gpt-4.1-mini": "gpt-5.6-sol",
};

function migrateModelId(model: string): string {
  return LEGACY_MODEL_IDS[model] ?? model;
}

function validateLocalProfile(profile: LocalProfile): void {
  if (!profile.name.trim() || profile.name.length > MAX_AGENT_NAME_CHARS || profile.name.includes("\0")) {
    throw new Error("config inválida: profile.name");
  }
  // O load exige machineId; a validação do write-path precisa do mesmo
  // invariante ou um mutateProfile poderia persistir uma config que o boot
  // rejeita.
  if (typeof profile.machineId !== "string" || !profile.machineId.trim()) {
    throw new Error("config inválida: profile.machineId");
  }
  if (!profile.avatarId.trim() || profile.avatarId.includes("\0")) throw new Error("config inválida: profile.avatarId");
  if (profile.avatarShape !== undefined && !LOCAL_PROFILE_AVATAR_SHAPES.includes(profile.avatarShape)) {
    throw new Error("config inválida: profile.avatarShape");
  }
  if (profile.avatarColor !== undefined && !/^#[0-9a-f]{6}$/i.test(profile.avatarColor)) {
    throw new Error("config inválida: profile.avatarColor");
  }
  if (profile.hasCustomAvatar !== undefined && typeof profile.hasCustomAvatar !== "boolean") {
    throw new Error("config inválida: profile.hasCustomAvatar");
  }
  if (profile.avatarPngBase64 !== undefined) {
    const bytes = Buffer.from(profile.avatarPngBase64, "base64");
    if (bytes.length < 8 || bytes.length > MAX_PROFILE_AVATAR_BYTES || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("config inválida: profile.avatarPngBase64");
    }
  }
}

function decodeConfig(raw: unknown, allowUnverified = false): OpenBotConfig {
  if (!isRecord(raw)) throw new Error("config inválida: raiz deve ser um objeto");
  if (raw.version !== 1) {
    if (raw.version !== undefined) throw new Error(`versão não suportada: ${String(raw.version)}`);
    throw new Error("config inválida: versão ausente");
  }
  if (raw.revision === undefined) raw.revision = 0;
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) {
    throw new Error("config inválida: revision");
  }
  if (!isRecord(raw.profile) ||
      typeof raw.profile.name !== "string" ||
      typeof raw.profile.avatarId !== "string" ||
      typeof raw.profile.machineId !== "string") {
    throw new Error("config inválida: profile");
  }
  if (raw.profile.name === "Local User") raw.profile.name = "OpenBot Local";
  validateLocalProfile(raw.profile as unknown as LocalProfile);
  if (typeof raw.activeProvider !== "string" || typeof raw.globalModel !== "string") {
    throw new Error("config inválida: provider/modelo");
  }
  if (raw.globalReasoningEffort === undefined) raw.globalReasoningEffort = DEFAULT_REASONING_EFFORT;
  if (!(REASONING_EFFORTS as readonly unknown[]).includes(raw.globalReasoningEffort)) {
    throw new Error("config inválida: globalReasoningEffort");
  }
  raw.globalModel = migrateModelId(raw.globalModel);
  if (Array.isArray(raw.agents)) {
    raw.agents = raw.agents.map((agent) =>
      isRecord(agent) && typeof agent.model === "string"
        ? { ...agent, model: migrateModelId(agent.model) }
        : agent,
    );
  }
  if (raw.compatBaseUrl !== undefined && raw.compatBaseUrl !== null && typeof raw.compatBaseUrl !== "string") {
    throw new Error("config inválida: compatBaseUrl");
  }
  if (raw.compatBaseUrl === undefined) raw.compatBaseUrl = null;
  if (typeof raw.compatBaseUrl === "string") validateCompatBaseUrl(raw.compatBaseUrl);
  if (raw.compatReasoningEffort !== undefined && typeof raw.compatReasoningEffort !== "boolean") {
    throw new Error("config inválida: compatReasoningEffort");
  }
  // Superfície removida (P2.5 legado): a chave era de configuração inerte —
  // nenhum agente podia selecionar esses providers. Aceita e descarta para
  // que configs antigas carreguem; some na próxima gravação.
  delete raw.optionalProviders;
  if (!isRecord(raw.hostSettings)) throw new Error("config inválida: hostSettings");
  const settings = raw.hostSettings;
  validateHostSettings(settings, true);
  if (!isRecord(raw.flags) ||
      typeof raw.flags.isAgentNetworkEnabled !== "boolean" ||
      typeof raw.flags.isGlobalSearchEnabled !== "boolean" ||
      typeof raw.flags.isEgressTunnelAvailable !== "boolean") {
    throw new Error("config inválida: flags");
  }
  const config = raw as unknown as OpenBotConfig;
  const mcpServers = normalizeMcpServers(raw.mcpServers);
  if (mcpServers !== undefined) config.mcpServers = mcpServers;
  validateModelProvider(config, allowUnverified);
  config.agents = validateAgents(config.agents, config.globalModel, new Set((mcpServers ?? []).map((server) => server.id.toLowerCase())), allowUnverified);
  return structuredClone(config);
}

function requireConfiguredAgent(config: OpenBotConfig, agentId: string): LocalAgent {
  if (typeof agentId !== "string" || !agentId.trim()) throw new Error("config: agentId inválido");
  const agent = config.agents.find((entry) => entry.id === agentId);
  if (!agent) throw new Error(`config: agente não encontrado: ${agentId}`);
  return agent;
}

/** Returns the effective per-agent Skill policy without exposing mutable config state. */
export function resolveAgentSkillPolicy(config: OpenBotConfig, agentId: string): Required<LocalSkillPolicy> {
  const policy = requireConfiguredAgent(config, agentId).integrations?.skills;
  return {
    enabled: policy?.enabled ?? true,
    disabledIds: [...new Set(policy?.disabledIds ?? [])],
  };
}

/** Returns the effective per-agent MCP policy. Missing policy is deny-all by default. */
export function resolveAgentMcpPolicy(config: OpenBotConfig, agentId: string): McpAgentPolicy {
  const policy = requireConfiguredAgent(config, agentId).integrations?.mcp;
  if (!policy) return { enabled: false, serverAllowlist: [] };
  return {
    enabled: policy.enabled,
    ...(policy.serverAllowlist !== undefined ? { serverAllowlist: [...policy.serverAllowlist] } : { serverAllowlist: [] }),
    ...(policy.toolAllowlist !== undefined ? { toolAllowlist: [...policy.toolAllowlist] } : {}),
    ...(policy.toolDenylist !== undefined ? { toolDenylist: [...policy.toolDenylist] } : {}),
  };
}

interface ConfigLockRecord {
  pid: number;
  token: string;
}

const CONFIG_LOCK_RETRY_MS = 10;
const CONFIG_LOCK_TIMEOUT_MS = 5_000;
const configLockWait = new Int32Array(new SharedArrayBuffer(4));

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readConfigLock(file: string): ConfigLockRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(value) || typeof value.pid !== "number" || typeof value.token !== "string") return null;
    return { pid: value.pid, token: value.token };
  } catch {
    return null;
  }
}

function releaseConfigLock(file: string, token: string): void {
  if (readConfigLock(file)?.token !== token) return;
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function withConfigLock<T>(target: string, task: () => T): T {
  const file = `${target}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;
  mkdirSync(dirname(file), { recursive: true });

  while (true) {
    try {
      writeFileExclusiveSync(file, JSON.stringify({ pid: process.pid, token }));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readConfigLock(file);
      if (owner !== null && !isProcessAlive(owner.pid)) {
        releaseConfigLock(file, owner.token);
        continue;
      }
      if (owner !== null) {
        // O pid pode ter sido reutilizado pelo SO após a morte do dono.
        // Um lock mais antigo que o timeout é tratado como obsoleto mesmo
        // com pid aparentemente vivo; o release confere o token, então um
        // dono realmente ativo nunca tem o lock roubado por engano.
        try {
          if (Date.now() - statSync(file).mtimeMs >= CONFIG_LOCK_TIMEOUT_MS) {
            releaseConfigLock(file, owner.token);
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
          continue;
        }
      }
      if (owner === null) {
        try {
          if (Date.now() - statSync(file).mtimeMs >= CONFIG_LOCK_TIMEOUT_MS) {
            unlinkSync(file);
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
          continue;
        }
      }
      if (Date.now() >= deadline) throw new Error(`config: timeout aguardando lock de ${target}`, { cause: error });
      Atomics.wait(configLockWait, 0, 0, CONFIG_LOCK_RETRY_MS);
    }
  }

  try {
    return task();
  } finally {
    releaseConfigLock(file, token);
  }
}

export class ConfigConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`config: revision conflict (expected ${expectedRevision}, actual ${actualRevision})`);
    this.name = "ConfigConflictError";
  }
}

export interface ConfigMutationOptions {
  expectedRevision?: number;
}

export class ConfigStore {
  readonly path: string;
  private config: OpenBotConfig;
  modelCatalog?: ModelCatalogService;
  private readonly allowUnverified: boolean;

  constructor(options: ConfigStoreOptions = {}) {
    this.allowUnverified = options.allowUnverifiedModels === true;
    this.path = options.configPath ?? defaultConfigPath();
    if (existsSync(this.path)) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      } catch {
        throw new Error("config JSON corrompido");
      }
      this.config = decodeConfig(raw, this.allowUnverified);
    } else {
      // First boot races another process here: create under the file lock and
      // adopt the winner instead of overwriting it.
      this.config = withConfigLock(this.path, () => {
        if (existsSync(this.path)) {
          let raw: unknown;
          try {
            raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
          } catch {
            throw new Error("config JSON corrompido");
          }
          return decodeConfig(raw, this.allowUnverified);
        }
        const fresh = createDefaultConfig();
        this.persist(fresh);
        return fresh;
      });
    }
  }

  /**
   * Returns the last committed in-memory state. External file edits only
   * become visible after a commit re-reads the disk under the lock — the
   * store assumes the config file is single-writer in steady state; the
   * file lock exists for first-boot races and commit mutual exclusion, not
   * continuous multi-process write sharing.
   */
  snapshot(): OpenBotConfig {
    return structuredClone(this.config);
  }

  /**
   * Read-only accessors for hot paths (per-entry transcript publication).
   * They read the live config without the full structuredClone of
   * `snapshot()` and never hand out mutable references: only primitives.
   */
  agentName(agentId: string): string | undefined {
    return this.config.agents.find((entry) => entry.id === agentId)?.name;
  }

  profileName(): string | undefined {
    return this.config.profile?.name;
  }

  profileMachineId(): string | undefined {
    return this.config.profile?.machineId;
  }

  update(
    patch: OpenBotConfigUpdate | ((current: Readonly<OpenBotConfig>) => OpenBotConfigUpdate),
    options: ConfigMutationOptions = {},
  ): OpenBotConfig {
    return this.commit(typeof patch === "function" ? patch : () => patch, options);
  }

  /** Computes a patch from the latest on-disk state while holding the lock. */
  mutate(
    mutator: (current: Readonly<OpenBotConfig>) => OpenBotConfigUpdate,
    options: ConfigMutationOptions = {},
  ): OpenBotConfig {
    return this.update(mutator, options);
  }

  /** Replaces profile atomically, allowing legacy optional fields to be removed. */
  mutateProfile(
    mutator: (current: Readonly<OpenBotConfig>) => LocalProfile,
    options: ConfigMutationOptions = {},
  ): OpenBotConfig {
    return this.commit((current) => ({ profile: mutator(current) }), options, true);
  }

  private commit(
    mutator: (current: Readonly<OpenBotConfig>) => OpenBotConfigUpdate,
    options: ConfigMutationOptions,
    replaceProfile = false,
  ): OpenBotConfig {
    return withConfigLock(this.path, () => {
      const current = existsSync(this.path)
        ? decodeConfig(JSON.parse(readFileSync(this.path, "utf8")) as unknown, this.allowUnverified)
        : this.config;
      const actualRevision = current.revision ?? 0;
      if (options.expectedRevision !== undefined && options.expectedRevision !== actualRevision) {
        throw new ConfigConflictError(options.expectedRevision, actualRevision);
      }
      const patch = mutator(structuredClone(current));
      const next: OpenBotConfig = {
        ...current,
        revision: actualRevision + 1,
        ...(patch.activeProvider !== undefined ? { activeProvider: patch.activeProvider } : {}),
        ...(patch.globalModel !== undefined ? { globalModel: patch.globalModel } : {}),
        ...(patch.globalReasoningEffort !== undefined ? { globalReasoningEffort: patch.globalReasoningEffort } : {}),
        ...(patch.compatBaseUrl !== undefined ? { compatBaseUrl: patch.compatBaseUrl } : {}),
        ...(patch.compatReasoningEffort !== undefined ? { compatReasoningEffort: patch.compatReasoningEffort } : {}),
        ...(patch.agents !== undefined ? { agents: patch.agents } : {}),
        ...(patch.mcpServers !== undefined ? { mcpServers: patch.mcpServers } : {}),
        profile: replaceProfile && patch.profile !== undefined
        ? patch.profile as LocalProfile
        : { ...current.profile, ...patch.profile },
        hostSettings: { ...current.hostSettings, ...patch.hostSettings },
        flags: { ...current.flags, ...patch.flags },
      };
      const mcpServers = normalizeMcpServers(next.mcpServers);
      if (mcpServers !== undefined) next.mcpServers = mcpServers;
      validateModelProvider(next, this.allowUnverified);
      validateLocalProfile(next.profile);
      validateHostSettings(next.hostSettings, true);
      if (typeof next.compatBaseUrl === "string") validateCompatBaseUrl(next.compatBaseUrl);
      if (next.compatReasoningEffort !== undefined && typeof next.compatReasoningEffort !== "boolean") {
        throw new Error("config inválida: compatReasoningEffort");
      }
      next.agents = validateAgents(next.agents, next.globalModel, new Set((mcpServers ?? []).map((server) => server.id.toLowerCase())), this.allowUnverified);
      if (this.modelCatalog) {
        const check = (provider: string, model: string, effort?: ReasoningEffort) => {
          if (isCatalogProvider(provider)) this.modelCatalog!.resolve(provider, model, effort);
        };
        if (next.activeProvider !== current.activeProvider || next.globalModel !== current.globalModel || next.globalReasoningEffort !== current.globalReasoningEffort) {
          check(next.activeProvider, next.globalModel, next.globalReasoningEffort);
        }
        for (const agent of next.agents) {
          const previous = current.agents.find(a => a.id === agent.id);
          if (!previous || previous.model !== agent.model || previous.provider !== agent.provider || previous.reasoningEffort !== agent.reasoningEffort || previous.serviceTier !== agent.serviceTier) {
            const provider = agent.model
              ? agent.provider ?? this.modelCatalog.find(agent.model)?.provider ?? MODEL_CATALOG.find(model => model.id === agent.model)?.provider ?? next.activeProvider
              : next.activeProvider;
            if (isCatalogProvider(provider)) this.modelCatalog.resolve(provider, agent.model ?? next.globalModel, agent.reasoningEffort ?? next.globalReasoningEffort, agent.serviceTier);
          }
        }
      }
      return this.replace(next);
    });
  }

  setGlobalModel(modelId: string): OpenBotConfig {
    const model = this.modelCatalog ? this.modelCatalog.find(modelId) : MODEL_CATALOG.find((entry) => entry.id === modelId);
    if (!model) throw new Error(`modelo não suportado: ${modelId}`);
    return this.update({
      globalModel: model.id,
      activeProvider: model.provider,
    });
  }

  setActiveProvider(provider: ProviderKind): OpenBotConfig {
    return this.update({ activeProvider: provider });
  }

  setHostSettings(settings: SandHostSettings): OpenBotConfig {
    validateHostSettings(settings);
    return this.update({ hostSettings: settings });
  }

  close(): void {}

  private replace(config: OpenBotConfig): OpenBotConfig {
    this.persist(config);
    this.config = config;
    return this.snapshot();
  }

  private persist(config: OpenBotConfig): void {
    writeFileAtomicSync(this.path, `${JSON.stringify(config, null, 2)}\n`);
  }
}
