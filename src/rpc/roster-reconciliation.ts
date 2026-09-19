import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { ConfigStore } from "../config/store.js";
import { HomeLifecycleError, sanitizeAgentId, type AgentHomeStore, type QuarantineEntryMetadata } from "../execution/home.js";

export interface RosterHomeReconciliationResult {
  /** Homes moved back from quarantine for agents still present in the roster. */
  restored: string[];
  /** Active homes moved to quarantine because no roster entry owns them. */
  quarantined: string[];
  /** Homes created for roster entries that had neither active nor quarantined data. */
  created: string[];
  /** States that require an explicit operator choice (for example, duplicate quarantines). */
  pending: Array<{ agentId: string; reason: string }>;
}

interface QuarantineMarker {
  agentId: string;
  quarantineId?: string;
  quarantinedAt: string;
}

const isMissing = (error: unknown): boolean => (
  typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
);

const keyOf = (agentId: string): string => agentId.toLowerCase();
const ACL_STAMP_NAME = ".openbot-acl-v1.json";

const isLocalHomeError = (error: unknown): error is Error => (
  error instanceof HomeLifecycleError && (error.code === "integrity_error" || error.code === "unsafe_path") ||
  error instanceof Error && (
    error.message === "home.json corrompido" ||
    error.message === "pasta de workspace reutilizada por outro agente"
  )
);

const activeReason = (error: Error): string => (
  error.message === "home.json corrompido" ||
  error.message === "pasta de workspace reutilizada por outro agente" ||
  error.message.startsWith("Home manifest")
)
  ? "home ativo possui manifesto inválido"
  : "home ativo possui integridade ou caminho inseguro";

const quarantineReason = "home em quarantine possui integridade ou caminho inseguro";

/**
 * Completes the roster/home invariant after a process restart.
 *
 * Local integrity/unsafe-path failures are isolated by agent and preserved for
 * explicit repair. Global I/O failures still abort bootstrap.
 */
export async function reconcileRosterHomes(
  config: Pick<ConfigStore, "snapshot">,
  homes: AgentHomeStore,
): Promise<RosterHomeReconciliationResult> {
  const result: RosterHomeReconciliationResult = {
    restored: [],
    quarantined: [],
    created: [],
    pending: [],
  };
  const pendingKeys = new Set<string>();
  const addPending = (agentId: string, reason: string): void => {
    const key = keyOf(agentId);
    if (pendingKeys.has(key)) return;
    pendingKeys.add(key);
    result.pending.push({ agentId, reason });
  };
  const roster = config.snapshot().agents;
  const rosterByKey = new Map(roster.map((agent) => [keyOf(agent.id), agent.id]));
  const activeIds = await scanActiveHomes(homes, addPending);
  const quarantined = await homes.listQuarantineMetadata();
  const activeByKey = new Map(activeIds.map((agentId) => [keyOf(agentId), agentId]));
  const quarantineByKey = new Map<string, QuarantineEntryMetadata[]>();
  for (const entry of quarantined) {
    const entries = quarantineByKey.get(keyOf(entry.agentId)) ?? [];
    entries.push(entry);
    quarantineByKey.set(keyOf(entry.agentId), entries);
  }

  for (const [agentKey, agentId] of rosterByKey) {
    if (pendingKeys.has(agentKey)) continue;
    const activeId = activeByKey.get(agentKey);
    if (activeId !== undefined) {
      try {
        await settleActiveMarker(homes, activeId);
        await homes.ensure(activeId);
      } catch (error) {
        if (!isLocalHomeError(error)) throw error;
        addPending(agentId, activeReason(error));
      }
      continue;
    }
    const candidates = quarantineByKey.get(agentKey) ?? [];
    if (candidates.length > 1) {
      addPending(agentId, "mais de um home em quarantine corresponde ao agente");
      continue;
    }
    if (candidates.length === 1) {
      try {
        await homes.restore(agentId, candidates[0]!.quarantineId);
        result.restored.push(agentId);
      } catch (error) {
        if (!isLocalHomeError(error)) throw error;
        addPending(agentId, quarantineReason);
      }
      continue;
    }
    try {
      const home = await homes.ensure(agentId);
      if (home.created) result.created.push(agentId);
    } catch (error) {
      if (!isLocalHomeError(error)) throw error;
      addPending(agentId, activeReason(error));
    }
  }

  for (const agentId of activeIds) {
    const agentKey = keyOf(agentId);
    if (rosterByKey.has(agentKey) || pendingKeys.has(agentKey)) continue;
    try {
      await settleActiveMarker(homes, agentId);
      await homes.quarantineForRecovery(agentId);
      result.quarantined.push(agentId);
    } catch (error) {
      if (!isLocalHomeError(error)) throw error;
      addPending(agentId, activeReason(error));
    }
  }
  return result;
}

async function scanActiveHomes(
  homes: AgentHomeStore,
  addPending: (agentId: string, reason: string) => void,
): Promise<string[]> {
  const children = await readdir(homes.root, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  const agentIds: string[] = [];
  for (const child of children) {
    if (child.name === ACL_STAMP_NAME) {
      if (child.isSymbolicLink() || !child.isFile()) {
        throw new HomeLifecycleError("unsafe_path", "Workspace ACL stamp is unsafe.");
      }
      continue;
    }
    if (child.name === ".quarantine" || child.name === ".staging" || child.name === ".snapshots") {
      if (!child.isDirectory() || child.isSymbolicLink()) {
        throw new HomeLifecycleError("unsafe_path", "Workspace lifecycle directory is unsafe.");
      }
      continue;
    }
    let agentId: string;
    try {
      agentId = sanitizeAgentId(child.name);
    } catch {
      throw new HomeLifecycleError("unsafe_path", "Workspace root contains an unsafe entry.");
    }
    agentIds.push(agentId);
    if (child.isSymbolicLink() || !child.isDirectory()) {
      addPending(agentId, "home ativo possui integridade ou caminho inseguro");
    }
  }
  return agentIds;
}

/**
 * A crash after writing the active quarantine marker but before rename leaves
 * a valid home with administrative metadata. Finalize that metadata without
 * touching user files; orphan homes are then passed through normal
 * marker-backed quarantine.
 */
async function settleActiveMarker(homes: AgentHomeStore, agentId: string): Promise<void> {
  const markerPath = join(homes.pathFor(agentId), ".openbot", "quarantine.json");
  let metadata;
  try {
    metadata = await lstat(markerPath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new HomeLifecycleError("unsafe_path", `reconciliação: marker quarantine inseguro para ${agentId}`);
  }
  let markerText: string;
  try {
    markerText = await readFile(markerPath, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
    throw new HomeLifecycleError("integrity_error", `reconciliação: marker quarantine inválido para ${agentId}`);
  }
  let marker: unknown;
  try {
    marker = JSON.parse(markerText) as unknown;
  } catch {
    throw new HomeLifecycleError("integrity_error", `reconciliação: marker quarantine inválido para ${agentId}`);
  }
  if (!isMarker(marker) || marker.agentId !== agentId) {
    throw new HomeLifecycleError("integrity_error", `reconciliação: identidade do marker quarantine inválida para ${agentId}`);
  }
  await unlink(markerPath);
}

function isMarker(value: unknown): value is QuarantineMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return typeof marker.agentId === "string"
    && typeof marker.quarantinedAt === "string"
    && (marker.quarantineId === undefined || typeof marker.quarantineId === "string");
}
