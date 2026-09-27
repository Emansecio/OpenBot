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
  /** Checkout identity (see server/build-identity.ts); absent in bare test gateways. */
  rootId?: string;
  /** Build stamp loaded by this process (see server/build-identity.ts). */
  build?: string;
}

export interface PrepareUpgradeResponse {
  quiescing: boolean;
  runningTurns: number;
}
