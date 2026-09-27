/**
 * Minimal ConfigStore stand-in for tests that only need reads. It mirrors the
 * store's read surface (`snapshot`, `view` and the id/name accessors) over a
 * fixed state; `extra` adds or overrides members such as `update`/`mutate`.
 */
export function fakeConfig<State extends { agents: ReadonlyArray<{ id: string; name?: string }>; profile?: { name?: string; machineId?: string } }>(
  state: State | (() => State),
  extra: Record<string, unknown> = {},
) {
  const read = typeof state === "function" ? state : () => state;
  return {
    snapshot: () => structuredClone(read()),
    view: () => read(),
    hasAgent: (agentId: string) => read().agents.some((agent) => agent.id === agentId),
    agentIds: () => read().agents.map((agent) => agent.id),
    agentName: (agentId: string) => read().agents.find((agent) => agent.id === agentId)?.name,
    profileName: () => read().profile?.name,
    profileMachineId: () => read().profile?.machineId,
    ...extra,
  };
}
