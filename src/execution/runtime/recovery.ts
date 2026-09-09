/**
 * Small, host-side recovery journal for runtime leases.
 *
 * The journal deliberately contains identities only. It must never be used
 * as a source of workspace paths or arbitrary commands. A lease whose
 * identity cannot be validated is quarantined and reported instead of being
 * guessed at or silently ignored.
 */

interface RuntimeLeaseIdentity {
  leaseId: string;
  agentId: string;
  runtimeBootId: string;
  temporaryId: string;
}

export interface RuntimePendingLeaseRecord extends RuntimeLeaseIdentity {
  pending: true;
}

export interface RuntimeActiveLeaseRecord extends RuntimeLeaseIdentity {
  sandboxId: string;
  pending?: never;
}

export type RuntimeLeaseRecord = RuntimePendingLeaseRecord | RuntimeActiveLeaseRecord;

export const isPendingRuntimeLeaseRecord = (record: RuntimeLeaseRecord): record is RuntimePendingLeaseRecord =>
  record.pending === true;

export type RuntimeLeaseJournalIssueReason = "invalid-record" | "invalid-journal";

export interface RuntimeLeaseJournalIssue {
  reason: RuntimeLeaseJournalIssueReason;
  message: string;
  /** Only a validated, non-sensitive identity is included in the report. */
  leaseId?: string;
  quarantinePath?: string;
}

export interface RuntimeLeaseJournalReport {
  issues: RuntimeLeaseJournalIssue[];
  quarantined: number;
}

export interface RuntimeLeaseJournal {
  list(): Promise<RuntimeLeaseRecord[]>;
  put(record: RuntimeLeaseRecord): Promise<void>;
  delete(leaseId: string): Promise<void>;
}

/** Optional diagnostics exposed by journals that can quarantine bad data. */
export interface RuntimeLeaseJournalDiagnostics {
  getLastReport(): RuntimeLeaseJournalReport;
}

import type { RuntimeBoot } from "./contracts.js";

export interface RuntimeResourceReconciler {
  /**
   * Preferred operation for runtime-specific recovery. It receives the full
   * validated identity record so a backend can prove teardown against the
   * persisted boot, sandbox and temporary identities.
   */
  reconcileLease?(record: RuntimeLeaseRecord, activeBoot?: RuntimeBoot): Promise<void>;
  killSandbox(sandboxId: string): Promise<void>;
  removeTemporary(temporaryId: string): Promise<void>;
}

export interface RuntimeRecoveryResult {
  inspected: number;
  cleaned: number;
  failed: number;
  complete: boolean;
  /** Number of records moved out of the active journal as invalid. */
  quarantined?: number;
}

const MAX_IDENTIFIER_LENGTH = 256;

/**
 * Resource IDs are eventually used as directory names by the guest. Keep
 * this check stricter than a generic non-empty string check so recovery never
 * turns a corrupt journal into a path traversal primitive.
 */
export const validRuntimeIdentifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_IDENTIFIER_LENGTH &&
  value !== "." &&
  value !== ".." &&
  !value.includes("\0") &&
  !value.includes("/") &&
  !value.includes("\\");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ACTIVE_RECORD_KEYS = ["leaseId", "agentId", "runtimeBootId", "sandboxId", "temporaryId"] as const;
const PENDING_RECORD_KEYS = ["leaseId", "agentId", "runtimeBootId", "temporaryId", "pending"] as const;
const IDENTITY_KEYS = ["leaseId", "agentId", "runtimeBootId", "temporaryId"] as const;

const invalidRecord = (message: string): Error => new Error(`runtime lease record is invalid: ${message}`);
const hasExactKeys = (keys: string[], expected: readonly string[]): boolean =>
  keys.length === expected.length && keys.every((key) => expected.includes(key));

/** Parse and validate an untrusted journal value without exposing raw data. */
export function parseRuntimeLeaseRecord(value: unknown): RuntimeLeaseRecord {
  if (!isRecord(value)) throw invalidRecord("record must be an object");
  const keys = Object.keys(value);
  const pending = value.pending === true;
  const expected = pending ? PENDING_RECORD_KEYS : ACTIVE_RECORD_KEYS;
  if (!hasExactKeys(keys, expected)) throw invalidRecord("record fields are invalid");
  for (const key of IDENTITY_KEYS) {
    if (!validRuntimeIdentifier(value[key])) throw invalidRecord(`${key} is invalid`);
  }
  const identity = {
    leaseId: value.leaseId as string,
    agentId: value.agentId as string,
    runtimeBootId: value.runtimeBootId as string,
    temporaryId: value.temporaryId as string,
  };
  if (pending) return { ...identity, pending: true };
  if (!validRuntimeIdentifier(value.sandboxId)) throw invalidRecord("sandboxId is invalid");
  return { ...identity, sandboxId: value.sandboxId };
}

export function cloneRuntimeLeaseRecord(record: RuntimeLeaseRecord): RuntimeLeaseRecord {
  return { ...record };
}

const emptyReport = (): RuntimeLeaseJournalReport => ({ issues: [], quarantined: 0 });

const cloneReport = (report: RuntimeLeaseJournalReport): RuntimeLeaseJournalReport => ({
  issues: report.issues.map((issue) => ({ ...issue })),
  quarantined: report.quarantined,
});

/**
 * In-memory implementation used by host tests. It intentionally applies the
 * same validation/quarantine behavior as the durable journal, which keeps
 * tests from hiding recovery-only corruption paths.
 */
export class MemoryRuntimeLeaseJournal implements RuntimeLeaseJournal, RuntimeLeaseJournalDiagnostics {
  private readonly records = new Map<string, RuntimeLeaseRecord>();
  private readonly issues: RuntimeLeaseJournalIssue[] = [];
  private quarantinedCount = 0;
  private lastReport: RuntimeLeaseJournalReport = emptyReport();

  constructor(initial: readonly unknown[] = []) {
    for (const value of initial) {
      try {
        const record = parseRuntimeLeaseRecord(value);
        if (this.records.has(record.leaseId)) {
          this.quarantinedCount += 1;
          this.issues.push({ reason: "invalid-record", message: "runtime lease record is invalid: duplicate leaseId", leaseId: record.leaseId });
          continue;
        }
        this.records.set(record.leaseId, cloneRuntimeLeaseRecord(record));
      } catch (error) {
        this.quarantinedCount += 1;
        this.issues.push({
          reason: "invalid-record",
          message: error instanceof Error ? error.message : "runtime lease record is invalid",
        });
      }
    }
  }

  async list(): Promise<RuntimeLeaseRecord[]> {
    // A report belongs to the read that discovered it. Consuming pending
    // issues here prevents a quarantined record from keeping every later
    // recovery attempt in repair-required forever.
    this.lastReport = cloneReport({ issues: this.issues.splice(0), quarantined: this.quarantinedCount });
    this.quarantinedCount = 0;
    return [...this.records.values()].map(cloneRuntimeLeaseRecord);
  }

  async put(record: RuntimeLeaseRecord): Promise<void> {
    const checked = parseRuntimeLeaseRecord(record);
    this.records.set(checked.leaseId, cloneRuntimeLeaseRecord(checked));
  }

  async delete(leaseId: string): Promise<void> {
    if (!validRuntimeIdentifier(leaseId)) throw invalidRecord("leaseId is invalid");
    this.records.delete(leaseId);
  }

  getLastReport(): RuntimeLeaseJournalReport {
    if (this.issues.length === 0 && this.quarantinedCount === 0) return cloneReport(this.lastReport);
    return cloneReport({
      issues: [...this.lastReport.issues, ...this.issues],
      quarantined: this.lastReport.quarantined + this.quarantinedCount,
    });
  }
}

const isAlreadyAbsent = (error: unknown): boolean => {
  if (typeof error === "object" && error !== null) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH" || code === "ENOTFOUND" || code === "NOT_FOUND") return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /(?:not found|no such|does not exist|already (?:gone|removed|stopped|terminated)|no process)/iu.test(message);
};

const readJournalReport = async (journal: RuntimeLeaseJournal): Promise<RuntimeLeaseJournalReport> => {
  const diagnostics = journal as RuntimeLeaseJournal & Partial<RuntimeLeaseJournalDiagnostics>;
  if (typeof diagnostics.getLastReport !== "function") return emptyReport();
  return cloneReport(diagnostics.getLastReport());
};

/**
 * Reconcile only leases from a previous runtime boot. Records for the
 * current boot are left untouched because they may still own live resources.
 * Every cleanup operation is attempted independently and missing resources
 * are treated as already-cleaned; the journal entry is removed only after all
 * required teardown steps succeed.
 */
export async function reconcileRuntimeLeases(
  journal: RuntimeLeaseJournal,
  currentBootId: string,
  reconciler: RuntimeResourceReconciler,
  activeBoot?: RuntimeBoot,
): Promise<RuntimeRecoveryResult> {
  if (!validRuntimeIdentifier(currentBootId)) throw new Error("runtime boot id is invalid");

  const records = await journal.list();
  const report = await readJournalReport(journal);
  let cleaned = 0;
  let failed = report.issues.length;
  const cleanedSandboxes = new Set<string>();
  const cleanedTemporaries = new Set<string>();

  for (const record of records) {
    // Same-boot leases are not orphans. A crash recovery caller can safely
    // invoke this function before it has finished rebuilding its live table.
    if (record.runtimeBootId === currentBootId) continue;

    let cleanupFailed = false;
    if (reconciler.reconcileLease) {
      try {
        await reconciler.reconcileLease(record, activeBoot);
      } catch (error) {
        if (!isAlreadyAbsent(error)) cleanupFailed = true;
      }
    } else {
      if (isPendingRuntimeLeaseRecord(record)) {
        // Generic reconcilers cannot safely invent a sandbox identity. Keep
        // pending record for explicit repair unless backend supports full-record recovery.
        cleanupFailed = true;
      } else if (!cleanedSandboxes.has(record.sandboxId)) {
        try {
          await reconciler.killSandbox(record.sandboxId);
          cleanedSandboxes.add(record.sandboxId);
        } catch (error) {
          if (isAlreadyAbsent(error)) cleanedSandboxes.add(record.sandboxId);
          else cleanupFailed = true;
        }
      }
      if (!isPendingRuntimeLeaseRecord(record) && !cleanedTemporaries.has(record.temporaryId)) {
        try {
          await reconciler.removeTemporary(record.temporaryId);
          cleanedTemporaries.add(record.temporaryId);
        } catch (error) {
          if (isAlreadyAbsent(error)) cleanedTemporaries.add(record.temporaryId);
          else cleanupFailed = true;
        }
      }
    }

    if (cleanupFailed) {
      failed += 1;
      continue;
    }
    try {
      await journal.delete(record.leaseId);
      cleaned += 1;
    } catch {
      failed += 1;
    }
  }

  const result: RuntimeRecoveryResult = {
    inspected: records.length + report.issues.filter((issue) => issue.reason === "invalid-record").length,
    cleaned,
    failed,
    complete: failed === 0,
  };
  if (report.quarantined > 0) result.quarantined = report.quarantined;
  return result;
}

// Kept as a convenience export for callers that only know recovery.ts.
export { FileRuntimeLeaseJournal } from "./file-journal.js";
