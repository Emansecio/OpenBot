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
    options.asyncTaskStore?.purgeAgentTasks(agentId);
    options.a2aStore?.retireAgent(agentId);
    options.a2aStore?.clearAgentFence(agentId);
    options.reactionStore?.purgeAgent(agentId);
    await options.attachmentStaging?.purgeAgent(agentId);
    await options.keystore?.purgeScope(agentId);
    if (browserLifecycle !== undefined) await browserLifecycle.purgeAgent(agentId);
  }
  if (browserPurgeUnavailable) return result;
  options.store.completeAgentDeletion(committed);
  result.completed.push(...committed);
  return result;
}
