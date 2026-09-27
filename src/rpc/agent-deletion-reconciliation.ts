import type { AttachmentStagingStore } from "../attachments/staging.js";
import type { ConfigStore } from "../config/store.js";
import type { Keystore } from "../keystore/index.js";
import type { ReactionStore } from "../reactions/store.js";
import type { A2AStore } from "../a2a/store.js";
import type { AsyncTaskStore } from "../tasks/store.js";

export interface AgentDeletionJournalStore {
  pendingAgentDeletions(): readonly { agentId: string; startedAtMs: number }[];
  completeAgentDeletion(agentIds: readonly string[]): void;
  clear(agentId: string): void;
  clearAgents?(agentIds: readonly string[]): void;
}

/** Agent-scoped persistence outside the transcript store, purged once a deletion commits. */
export interface AgentScopedPersistence {
  asyncTaskStore?: Pick<AsyncTaskStore, "purgeAgentTasks">;
  a2aStore?: Pick<A2AStore, "purgeAgent">;
  reactionStore?: Pick<ReactionStore, "purgeAgent">;
  attachmentStaging?: Pick<AttachmentStagingStore, "purgeAgent">;
  keystore?: Pick<Keystore, "purgeScope">;
  browserLifecycle?: { purgeAgent(agentId: string): Promise<void> };
}

/**
 * Purges every agent-scoped surface of one deleted agent. Each surface is
 * attempted even when an earlier one fails; the failures are returned so the
 * caller decides whether the deletion journal can be completed. Shared by the
 * live deletion and the startup reconciliation, so both purge the same set.
 */
export async function purgeAgentScopedPersistence(agentId: string, surfaces: AgentScopedPersistence): Promise<unknown[]> {
  const failures: unknown[] = [];
  const attempt = async (purge: () => unknown): Promise<void> => {
    try {
      await purge();
    } catch (error) {
      failures.push(error);
    }
  };
  await attempt(() => surfaces.asyncTaskStore?.purgeAgentTasks(agentId));
  // Cancels pending traffic, then deletes the agent's messages, usage, incarnations and fence.
  await attempt(() => surfaces.a2aStore?.purgeAgent(agentId));
  await attempt(() => surfaces.reactionStore?.purgeAgent(agentId));
  await attempt(() => surfaces.attachmentStaging?.purgeAgent(agentId));
  await attempt(() => surfaces.keystore?.purgeScope(agentId));
  await attempt(() => surfaces.browserLifecycle?.purgeAgent(agentId));
  return failures;
}

export interface AgentDeletionReconciliationResult {
  rolledBack: string[];
  completed: string[];
}

/**
 * Resolves crash-interrupted deletions before RPC admission opens. Roster
 * presence means deletion never committed and its intent is cancelled;
 * absence means every available agent-scoped persistence surface is purged
 * idempotently before the durable tombstone is removed. If browser cleanup is
 * unavailable, the journal remains pending until that capability returns.
 */
export async function reconcileAgentDeletions(options: {
  config: Pick<ConfigStore, "snapshot">;
  store: AgentDeletionJournalStore;
  keystore?: Keystore;
  attachmentStaging?: AttachmentStagingStore;
  browserLifecycle?: { purgeAgent(agentId: string): Promise<void> };
  asyncTaskStore?: AsyncTaskStore;
  a2aStore?: A2AStore;
  reactionStore?: ReactionStore;
}): Promise<AgentDeletionReconciliationResult> {
  const result: AgentDeletionReconciliationResult = { rolledBack: [], completed: [] };
  const roster = new Set(options.config.snapshot().agents.map((agent) => agent.id.toLowerCase()));
  const pending = options.store.pendingAgentDeletions();
  const rolledBack = pending
    .map((entry) => entry.agentId)
    .filter((agentId) => roster.has(agentId.toLowerCase()));
  const committed = pending
    .map((entry) => entry.agentId)
    .filter((agentId) => !roster.has(agentId.toLowerCase()));

  if (rolledBack.length > 0) {
    // The deletion began (and wrote its durable fences) but the roster kept
    // the agent: lift those fences too, or the agent stays blocked for A2A
    // and async tasks forever.
    for (const agentId of rolledBack) {
      options.asyncTaskStore?.clearAgentFence(agentId);
      options.a2aStore?.clearAgentFence(agentId);
    }
    options.store.completeAgentDeletion(rolledBack);
    result.rolledBack.push(...rolledBack);
  }
  if (committed.length === 0) return result;

  if (committed.length > 1 && options.store.clearAgents !== undefined) options.store.clearAgents(committed);
  else for (const agentId of committed) options.store.clear(agentId);

  const browserLifecycle = options.browserLifecycle;
  const browserPurgeUnavailable = browserLifecycle === undefined;
  if (browserPurgeUnavailable) {
    console.warn(
      `[openbot] agent deletion reconciliation pending: browser purge capability unavailable for ${committed.join(", ")}`,
    );
  }

  for (const agentId of committed) {
    const failures = await purgeAgentScopedPersistence(agentId, options);
    if (failures.length > 0) {
      throw failures.length === 1 ? failures[0] : new AggregateError(failures, "agent deletion reconciliation failed");
    }
  }
  if (browserPurgeUnavailable) return result;
  options.store.completeAgentDeletion(committed);
  result.completed.push(...committed);
  return result;
}
