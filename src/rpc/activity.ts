/** Preview that the Grok Bot sidebar reads from `agent.lastEntry`. */
export type LastEntryPreview =
  | { kind: "text"; text: string }
  | { kind: "attachment"; count: number; kinds: string[] }
  | { kind: "link"; url: string };

export interface AgentActivity {
  isRunning: boolean;
  lastMessageId: string | null;
  lastMessagePreview: string | null;
  lastEntry: LastEntryPreview | null;
}

export interface AgentActivitySnapshot {
  present: boolean;
  state: AgentActivity;
}

const IDLE: AgentActivity = {
  isRunning: false,
  lastMessageId: null,
  lastMessagePreview: null,
  lastEntry: null,
};

export function previewFromText(text: string): LastEntryPreview {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const clipped = collapsed.length <= 140 ? collapsed : `${collapsed.slice(0, 139).trimEnd()}…`;
  return { kind: "text", text: clipped };
}

/** Live turn/preview state merged into listAgents / agents SSE. */
export class AgentActivityStore {
  private readonly byAgent = new Map<string, AgentActivity>();
  private readonly listeners = new Set<() => void>();

  get(agentId: string): AgentActivity {
    return this.byAgent.get(agentId) ?? IDLE;
  }

  runningAgentIds(): string[] {
    return [...this.byAgent.entries()].filter(([, state]) => state.isRunning).map(([id]) => id);
  }

  snapshot(agentId: string): AgentActivitySnapshot {
    const state = this.byAgent.get(agentId);
    return {
      present: state !== undefined,
      state: { ...(state ?? IDLE), lastEntry: state?.lastEntry === null || state?.lastEntry === undefined
        ? null
        : { ...state.lastEntry } },
    };
  }

  restore(agentId: string, snapshot: AgentActivitySnapshot, publish = true): void {
    if (!snapshot.present) this.byAgent.delete(agentId);
    else this.byAgent.set(agentId, {
      ...snapshot.state,
      lastEntry: snapshot.state.lastEntry === null ? null : { ...snapshot.state.lastEntry },
    });
    if (publish) this.emit();
  }

  patch(agentId: string, next: Partial<AgentActivity>, publish = true): AgentActivity {
    const current = this.get(agentId);
    const merged: AgentActivity = {
      isRunning: next.isRunning ?? current.isRunning,
      lastMessageId: next.lastMessageId !== undefined ? next.lastMessageId : current.lastMessageId,
      lastMessagePreview: next.lastMessagePreview !== undefined ? next.lastMessagePreview : current.lastMessagePreview,
      lastEntry: next.lastEntry !== undefined ? next.lastEntry : current.lastEntry,
    };
    this.byAgent.set(agentId, merged);
    if (publish) this.emit();
    return merged;
  }

  clear(agentId: string, publish = true): void {
    if (!this.byAgent.delete(agentId)) return;
    if (publish) this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* one observer must not break turn state */ }
    }
  }
}
