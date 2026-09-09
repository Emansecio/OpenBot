/**
 * Tipos auxiliares do servidor/gateway (bootstrap T1; consumidos por T3+).
 */

export interface HealthResponse {
  ok: true;
  pid: number;
  isBusy: boolean;
  activeAgentId?: string | null;
  busyAgentIds?: string[];
  startedAt: string;
  lastBusyAtMs?: number | null;
}

export interface PrepareUpgradeResponse {
  quiescing: boolean;
  runningTurns: number;
}
