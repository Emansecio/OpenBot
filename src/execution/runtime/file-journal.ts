import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  cloneRuntimeLeaseRecord,
  parseRuntimeLeaseRecord,
  validRuntimeIdentifier,
  type RuntimeLeaseJournal,
  type RuntimeLeaseJournalDiagnostics,
  type RuntimeLeaseJournalIssue,
  type RuntimeLeaseJournalReport,
  type RuntimeLeaseRecord,
} from "./recovery.js";

const JOURNAL_SCHEMA_VERSION = 1;
const DEFAULT_FILE_NAME = "runtime-leases.json";
const QUARANTINE_DIRECTORY = "quarantine/runtime-leases";

export interface FileRuntimeLeaseJournalOptions {
  /** Managed runtime state directory, never a workspace or agent home. */
  stateRoot: string;
  fileName?: string;
}

interface JournalSnapshot {
  records: RuntimeLeaseRecord[];
  dirty: boolean;
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";

const cloneReport = (report: RuntimeLeaseJournalReport): RuntimeLeaseJournalReport => ({
  issues: report.issues.map((issue) => ({ ...issue })),
  quarantined: report.quarantined,
});

const safeLeaseId = (value: unknown): string | undefined =>
  validRuntimeIdentifier(value) ? value : undefined;

const parseJournalRecords = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("journal root must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== JOURNAL_SCHEMA_VERSION) throw new Error("journal schema is unsupported");
  if (Array.isArray(input.leases)) return input.leases;
  // Accept the first development format so an interrupted upgrade does not
  // destroy recoverable lease identities. New writes always use `leases`.
  if (Array.isArray(input.records)) return input.records;
  throw new Error("journal records are missing");
};

/**
 * Durable, serialized and atomically replaced lease journal.
 *
 * The file lives under the caller-provided runtime state directory. Invalid
 * JSON, invalid records and symlinked journal files are moved to a sibling
 * quarantine directory before a clean active journal is published. No
 * workspace path is ever read, removed or inferred here.
 */
export class FileRuntimeLeaseJournal implements RuntimeLeaseJournal, RuntimeLeaseJournalDiagnostics {
  readonly stateRoot: string;
  readonly filePath: string;
  readonly quarantineRoot: string;

  private queue: Promise<void> = Promise.resolve();
  private lastReport: RuntimeLeaseJournalReport = { issues: [], quarantined: 0 };

  constructor(stateRootOrOptions: string | FileRuntimeLeaseJournalOptions, fileName = DEFAULT_FILE_NAME) {
    const options = typeof stateRootOrOptions === "string"
      ? { stateRoot: stateRootOrOptions, fileName }
      : stateRootOrOptions;
    if (typeof options.stateRoot !== "string" || options.stateRoot.length === 0) {
      throw new Error("runtime journal state root is invalid");
    }
    const selectedFileName = options.fileName ?? DEFAULT_FILE_NAME;
    if (
      selectedFileName.length === 0 ||
      selectedFileName === "." ||
      selectedFileName === ".." ||
      selectedFileName.includes("/") ||
      selectedFileName.includes("\\") ||
      selectedFileName.includes("\0")
    ) {
      throw new Error("runtime journal file name is invalid");
    }
    this.stateRoot = resolve(options.stateRoot);
    this.filePath = join(this.stateRoot, selectedFileName);
    this.quarantineRoot = join(this.stateRoot, QUARANTINE_DIRECTORY);
  }

  async list(): Promise<RuntimeLeaseRecord[]> {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot(true);
      if (snapshot.dirty) await this.writeRecords(snapshot.records);
      return snapshot.records.map(cloneRuntimeLeaseRecord);
    });
  }

  async put(record: RuntimeLeaseRecord): Promise<void> {
    const checked = parseRuntimeLeaseRecord(record);
    await this.enqueue(async () => {
      const snapshot = await this.readSnapshot(false);
      const records = snapshot.records.filter((current) => current.leaseId !== checked.leaseId);
      records.push(cloneRuntimeLeaseRecord(checked));
      await this.writeRecords(records);
    });
  }

  async delete(leaseId: string): Promise<void> {
    if (!validRuntimeIdentifier(leaseId)) throw new Error("runtime lease record is invalid: leaseId is invalid");
    await this.enqueue(async () => {
      const snapshot = await this.readSnapshot(false);
      const records = snapshot.records.filter((record) => record.leaseId !== leaseId);
      if (records.length !== snapshot.records.length || snapshot.dirty) await this.writeRecords(records);
    });
  }

  getLastReport(): RuntimeLeaseJournalReport {
    return cloneReport(this.lastReport);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureStateRoot(): Promise<void> {
    await mkdir(this.stateRoot, { recursive: true });
    const metadata = await lstat(this.stateRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("runtime journal state root is unsafe");
  }

  private async ensureQuarantineRoot(): Promise<void> {
    await mkdir(this.quarantineRoot, { recursive: true });
    const metadata = await lstat(this.quarantineRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("runtime journal quarantine is unsafe");
  }

  private async readSnapshot(resetReport: boolean): Promise<JournalSnapshot> {
    await this.ensureStateRoot();
    if (resetReport) this.lastReport = { issues: [], quarantined: 0 };

    let metadata;
    try {
      metadata = await lstat(this.filePath);
    } catch (error) {
      if (isMissing(error)) return { records: [], dirty: false };
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      await this.quarantineJournalFile("journal file is not a regular file");
      return { records: [], dirty: false };
    }

    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      await this.quarantineJournalFile("journal could not be read");
      return { records: [], dirty: false };
    }

    let values: unknown[];
    try {
      values = parseJournalRecords(JSON.parse(raw) as unknown);
    } catch (error) {
      await this.quarantineJournalFile(error instanceof Error ? error.message : "journal is invalid");
      return { records: [], dirty: false };
    }

    const records: RuntimeLeaseRecord[] = [];
    const leaseIds = new Set<string>();
    let dirty = false;
    for (const value of values) {
      try {
        const record = parseRuntimeLeaseRecord(value);
        if (leaseIds.has(record.leaseId)) {
          dirty = true;
          await this.quarantineRecord(value, "runtime lease record is invalid: duplicate leaseId");
          continue;
        }
        leaseIds.add(record.leaseId);
        records.push(record);
      } catch (error) {
        dirty = true;
        await this.quarantineRecord(value, error instanceof Error ? error.message : "record is invalid");
      }
    }
    return { records, dirty };
  }

  private async quarantineJournalFile(message: string): Promise<void> {
    let quarantinePath: string | undefined;
    try {
      quarantinePath = await this.newQuarantinePath("corrupt");
      await rename(this.filePath, quarantinePath);
    } catch {
      // Keep the report even if the filesystem cannot move the artifact. The
      // active file is never overwritten in this failure path.
      this.recordIssue({ reason: "invalid-journal", message });
      return;
    }
    this.recordIssue({ reason: "invalid-journal", message, quarantinePath });
  }

  private async quarantineRecord(value: unknown, message: string): Promise<void> {
    let quarantinePath: string | undefined;
    try {
      quarantinePath = await this.newQuarantinePath("record");
      await this.writeUnique(quarantinePath, `${JSON.stringify({ schemaVersion: 1, reason: message, record: value })}\n`);
    } catch {
      this.recordIssue({ reason: "invalid-record", message, leaseId: safeLeaseId(this.readLeaseId(value)) });
      return;
    }
    this.recordIssue({ reason: "invalid-record", message, leaseId: safeLeaseId(this.readLeaseId(value)), quarantinePath });
  }

  private readLeaseId(value: unknown): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>).leaseId;
  }

  private recordIssue(issue: RuntimeLeaseJournalIssue): void {
    this.lastReport.issues.push(issue);
    this.lastReport.quarantined += 1;
  }

  private async newQuarantinePath(kind: string): Promise<string> {
    await this.ensureQuarantineRoot();
    return join(this.quarantineRoot, `${kind}-${Date.now()}-${randomUUID()}.json`);
  }

  private async writeRecords(records: readonly RuntimeLeaseRecord[]): Promise<void> {
    await this.ensureStateRoot();
    const payload = `${JSON.stringify({ schemaVersion: JOURNAL_SCHEMA_VERSION, leases: records }, null, 2)}\n`;
    await this.writeUnique(this.filePath, payload);
  }

  private async writeUnique(target: string, payload: string): Promise<void> {
    const temporary = join(this.stateRoot, `.runtime-leases-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
}
