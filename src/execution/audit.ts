/**
 * Audit-before-act por bot (melhoria 2 do spec
 * 2026-08-21-workspace-quality-improvements-design.md).
 *
 * JSONL append-only em `<home>/.openbot/audit/audit-<UTC-date>.jsonl`. A
 * entrada de decisão é gravada ANTES da execução; a de resultado depois.
 * Auditoria é observabilidade: falha de escrita nunca quebra a execução,
 * mas fica contabilizada em `failedWrites`.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

export interface AuditDecisionEntry {
  kind: "decision";
  requestId: string;
  operation: string;
  paths: string[];
  decision: "allow" | "ask" | "deny";
  /** "policy" quando uma regra apertou a decisão; "global" caso contrário. */
  source: "global" | "policy";
  ruleIndex?: number;
}

export interface AuditOutcomeEntry {
  kind: "outcome";
  requestId: string;
  operation: string;
  outcome: "ok" | "error";
  code?: string;
  durationMs: number;
}

export type AuditEntry = AuditDecisionEntry | AuditOutcomeEntry;

const auditDate = (at: Date): string => at.toISOString().slice(0, 10);

export class HomeAuditLogger {
  private readonly directory: string;
  /** Number of entries dropped due to write failures (observability). */
  failedWrites = 0;

  constructor(
    homeRoot: string,
    private readonly agentId: string,
  ) {
    this.directory = join(homeRoot, ".openbot", "audit");
  }

  async record(entry: AuditEntry, now: Date = new Date()): Promise<void> {
    const line = `${JSON.stringify({ ts: now.toISOString(), agentId: this.agentId, ...entry })}\n`;
    const file = join(this.directory, `audit-${auditDate(now)}.jsonl`);
    try {
      await mkdir(this.directory, { recursive: true });
      await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      this.failedWrites += 1;
    }
  }
}
