import { RpcError } from "../server/gateway.js";

interface AgentFenceState {
  active: number;
  deleting: boolean;
  drained?: Promise<void>;
  releaseDrain?: () => void;
  deletionEnded?: Promise<void>;
  releaseDeletion?: () => void;
}

const keyOf = (agentId: string): string => agentId.trim().toLowerCase();

/** Bounds the caller's wait only; the caller must retain fences until drain settles. */
export async function waitForDeletionDrain(drain: Promise<void>, timeoutMs = 5_000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("Deletion deadline must be positive.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      drain,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RpcError(503,
          "Não foi possível encerrar a execução a tempo. O bot não foi excluído. Aguarde o encerramento antes de tentar novamente.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Process-wide admission fence for agent-scoped RPC work. Deletion closes
 * admission first, then drains operations that were already admitted.
 */
export class AgentLifecycleFence {
  private readonly states = new Map<string, AgentFenceState>();

  run<T>(agentIds: readonly string[], operation: () => T): T | Promise<Awaited<T>> {
    const keys = [...new Set(agentIds.map(keyOf).filter(Boolean))].sort();
    for (const key of keys) {
      if (this.states.get(key)?.deleting) {
        throw new RpcError(409, `agent lifecycle: ${key} está sendo excluído`);
      }
    }
    for (const key of keys) {
      const state = this.states.get(key) ?? { active: 0, deleting: false };
      state.active += 1;
      this.states.set(key, state);
    }
    const release = (): void => {
      for (const key of keys) {
        const state = this.states.get(key);
        if (!state) continue;
        state.active = Math.max(0, state.active - 1);
        if (state.active === 0) state.releaseDrain?.();
        if (state.active === 0 && !state.deleting) this.states.delete(key);
      }
    };
    try {
      const result = operation();
      if (result !== null && typeof result === "object" && "then" in result) {
        return Promise.resolve(result).finally(release) as Promise<Awaited<T>>;
      }
      release();
      return result as T;
    } catch (error) {
      release();
      throw error;
    }
  }

  runWhenAvailable<T>(agentIds: readonly string[], operation: () => T): T | Promise<Awaited<T>> {
    const keys = [...new Set(agentIds.map(keyOf).filter(Boolean))].sort();
    const waits = keys.flatMap((key) => {
      const state = this.states.get(key);
      return state?.deleting && state.deletionEnded ? [state.deletionEnded] : [];
    });
    if (waits.length === 0) return this.run(keys, operation);
    return Promise.all(waits).then(() => this.run(keys, operation)) as Promise<Awaited<T>>;
  }

  async beginDeletion(agentIds: readonly string[]): Promise<void> {
    const keys = [...new Set(agentIds.map(keyOf).filter(Boolean))].sort();
    for (const key of keys) {
      if (this.states.get(key)?.deleting) {
        throw new RpcError(409, `agent lifecycle: ${key} já está sendo excluído`);
      }
    }
    const drains: Promise<void>[] = [];
    for (const key of keys) {
      const state = this.states.get(key) ?? { active: 0, deleting: false };
      state.deleting = true;
      state.deletionEnded = new Promise<void>((resolve) => { state.releaseDeletion = resolve; });
      if (state.active > 0) {
        state.drained ??= new Promise<void>((resolve) => { state.releaseDrain = resolve; });
        drains.push(state.drained);
      }
      this.states.set(key, state);
    }
    await Promise.all(drains);
  }

  endDeletion(agentIds: readonly string[]): void {
    for (const key of new Set(agentIds.map(keyOf).filter(Boolean))) {
      const state = this.states.get(key);
      if (!state) continue;
      state.deleting = false;
      state.drained = undefined;
      state.releaseDrain = undefined;
      state.releaseDeletion?.();
      state.deletionEnded = undefined;
      state.releaseDeletion = undefined;
      if (state.active === 0) this.states.delete(key);
    }
  }

  isDeleting(agentId: string): boolean {
    return this.states.get(keyOf(agentId))?.deleting === true;
  }
}

const AGENT_ID_FIELDS = [
  "agentId",
  "senderAgentId",
  "recipientAgentId",
  "parentAgentId",
  "targetAgentId",
] as const;

/** Extract agent identities from first-party RPC contracts without accepting arbitrary nested data. */
export function rpcAgentIds(method: string, body: unknown): string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
  const record = body as Record<string, unknown>;
  const ids: string[] = [];
  for (const field of AGENT_ID_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) ids.push(value);
  }
  if (method === "createAgent" && typeof record.id === "string" && record.id.trim().length > 0) {
    ids.push(record.id);
  }
  return ids;
}
