import { lstat, opendir } from "node:fs/promises";
import { join, win32 as path } from "node:path";

import { isHomeTrashArchivePath } from "./user-files.js";
import { WorkspaceSandbox } from "./workspace.js";

export interface WorkspaceUsage {
  bytes: number;
  files: number;
  directories: number;
  entries: number;
}

export interface WorkspaceQuotaOptions {
  maxBytes: number;
  maxFiles: number;
  maxEntries?: number;
  /**
   * Per-folder sub-quotas keyed by the first path segment (case-insensitive),
   * e.g. { downloads: {...}, projects: {...} }. Checked at reservation time
   * in addition to the global limit (melhoria 6).
   */
  scopes?: Record<string, WorkspaceQuotaOptions>;
}

export interface QuotaReservation {
  commit(): void;
  cancel(): void;
}

export interface QuotaDelta {
  bytes: number;
  files: number;
  entries: number;
}

export class WorkspaceQuotaError extends Error {
  constructor(message = "Workspace quota exceeded.") {
    super(message);
    this.name = "WorkspaceQuotaError";
  }
}

const isSymlink = (entry: { isSymbolicLink(): boolean }): boolean => entry.isSymbolicLink();

export async function calculateWorkspaceUsage(
  root: string,
  maxEntries = 100_000,
  skip?: (relativeSlashPath: string) => boolean,
): Promise<WorkspaceUsage> {
  const pending: { directory: string; relative: string }[] = [{ directory: root, relative: "" }];
  const usage: WorkspaceUsage = { bytes: 0, files: 0, directories: 0, entries: 0 };
  while (pending.length > 0) {
    const current = pending.pop()!;
    const handle = await opendir(current.directory);
    try {
      for await (const entry of handle) {
        if (isSymlink(entry)) continue;
        usage.entries += 1;
        if (usage.entries > maxEntries) throw new WorkspaceQuotaError("Workspace inventory limit exceeded.");
        const child = join(current.directory, entry.name);
        const relative = current.relative.length === 0 ? entry.name : `${current.relative}/${entry.name}`;
        if (entry.isDirectory()) {
          if (skip?.(relative.replaceAll("\\", "/"))) continue;
          usage.directories += 1;
          if (isHomeTrashArchivePath(relative.replaceAll("\\", "/"))) continue;
          pending.push({ directory: child, relative });
        } else if (entry.isFile()) {
          if (skip?.(relative.replaceAll("\\", "/"))) {
            usage.entries -= 1;
            continue;
          }
          const metadata = await lstat(child);
          usage.files += 1;
          usage.bytes += metadata.size;
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return usage;
}

export type WorkspaceUsageCalculator = (root: string, maxEntries?: number) => Promise<WorkspaceUsage>;

const FULL_SCAN_AFTER_COMMITS = 256;

export class WorkspaceQuota {
  private pendingBytes = 0;
  private pendingFiles = 0;
  private pendingEntries = 0;
  private cachedUsage: WorkspaceUsage | undefined;
  private usageDirty = true;
  private commitsSinceRefresh = 0;
  private reservationTail: Promise<void> = Promise.resolve();
  private readonly scopes: Record<string, WorkspaceQuotaOptions>;
  private readonly scopeUsage = new Map<string, WorkspaceUsage>();
  private readonly scopePaths = new Map<string, string>();
  private readonly scopeDirty = new Set<string>();
  private readonly pendingScope = new Map<string, QuotaDelta>();

  constructor(
    private readonly workspace: WorkspaceSandbox,
    private readonly options: WorkspaceQuotaOptions,
    private readonly calculateUsage: WorkspaceUsageCalculator = calculateWorkspaceUsage,
  ) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) throw new Error("maxBytes must be non-negative");
    if (!Number.isSafeInteger(options.maxFiles) || options.maxFiles < 0) throw new Error("maxFiles must be non-negative");
    if (options.maxEntries !== undefined && (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1)) {
      throw new Error("maxEntries must be positive");
    }
    this.scopes = {};
    for (const [name, scopeOptions] of Object.entries(options.scopes ?? {})) {
      if (!Number.isSafeInteger(scopeOptions.maxBytes) || scopeOptions.maxBytes < 0) throw new Error(`scope ${name}: maxBytes must be non-negative`);
      if (!Number.isSafeInteger(scopeOptions.maxFiles) || scopeOptions.maxFiles < 0) throw new Error(`scope ${name}: maxFiles must be non-negative`);
      if (scopeOptions.maxEntries !== undefined && (!Number.isSafeInteger(scopeOptions.maxEntries) || scopeOptions.maxEntries < 1)) {
        throw new Error(`scope ${name}: maxEntries must be positive`);
      }
      this.scopes[name.toLowerCase()] = scopeOptions;
    }
  }

  get workspaceRoot(): string {
    return this.workspace.root;
  }

  /** Explicit full scan for boot, repair and process.run verification. */
  async usage(): Promise<WorkspaceUsage> {
    return this.refreshUsage();
  }

  async refreshUsage(): Promise<WorkspaceUsage> {
    let release!: () => void;
    const previous = this.reservationTail;
    this.reservationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.refreshUsageLocked();
    } finally {
      release();
    }
  }

  /** Force one full scan before the next structured reservation. */
  markUsageDirty(): void {
    this.usageDirty = true;
    for (const scope of this.scopeUsage.keys()) this.scopeDirty.add(scope);
  }

  /** Apply one filesystem-watcher delta while preserving reservation ordering. */
  async applyExternalDelta(delta: QuotaDelta, scopePath?: string): Promise<void> {
    let release!: () => void;
    const previous = this.reservationTail;
    this.reservationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (![delta.bytes, delta.files, delta.entries].every(Number.isSafeInteger)) {
        throw new WorkspaceQuotaError("Workspace quota delta is invalid.");
      }
      const usage = await this.currentUsageLocked();
      const projected: WorkspaceUsage = {
        ...usage,
        bytes: usage.bytes + delta.bytes,
        files: usage.files + delta.files,
        entries: usage.entries + delta.entries,
      };
      if (projected.bytes < 0 || projected.files < 0 || projected.entries < 0) {
        throw new WorkspaceQuotaError("Workspace quota delta is inconsistent.");
      }
      this.assertUsage(projected);

      const scope = scopePath === undefined ? undefined : this.scopeFor(scopePath);
      let projectedScope: WorkspaceUsage | undefined;
      if (scope !== undefined) {
        const current = await this.currentScopeUsageLocked(scope.name, scope.directory);
        projectedScope = {
          ...current,
          bytes: current.bytes + delta.bytes,
          files: current.files + delta.files,
          entries: current.entries + delta.entries,
        };
        if (projectedScope.bytes < 0 || projectedScope.files < 0 || projectedScope.entries < 0) {
          throw new WorkspaceQuotaError("Workspace scoped quota delta is inconsistent.");
        }
        this.assertScopeUsage(scope.name, projectedScope);
      }
      this.cachedUsage = projected;
      if (scope !== undefined && projectedScope !== undefined) this.scopeUsage.set(scope.name, projectedScope);
    } finally {
      release();
    }
  }

  /** First path segment of a workspace-relative destination (lowercased), if any. */
  private scopeFor(destination: string): { name: string; directory: string } | undefined {
    const root = this.workspace.root.replace(/[\\/]+$/u, "");
    const normalized = destination.replace(/[\\/]+$/u, "");
    const relative = path.relative(root.toLowerCase(), normalized.toLowerCase());
    if (relative === "" || relative.startsWith("..")) return undefined;
    const first = relative.split(/[\\/]/u)[0] ?? "";
    if (first.length === 0) return undefined;
    const lowered = first.toLowerCase();
    if (this.scopes[lowered] === undefined) return undefined;
    // Keep the on-disk casing from the actual destination.
    const head = normalized.slice(root.length).replace(/^[\\/]+/u, "").split(/[\\/]/u)[0] ?? "";
    return { name: lowered, directory: join(this.workspace.root, head) };
  }

  private async currentScopeUsageLocked(scope: string, directory: string): Promise<WorkspaceUsage> {
    this.scopePaths.set(scope, directory);
    const cached = this.scopeUsage.get(scope);
    if (cached !== undefined && !this.scopeDirty.has(scope)) return { ...cached };
    let usage: WorkspaceUsage;
    try {
      usage = await this.calculateUsage(directory, this.scopes[scope]!.maxEntries ?? this.options.maxEntries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") usage = { bytes: 0, files: 0, directories: 0, entries: 0 };
      else throw error;
    }
    this.scopeUsage.set(scope, usage);
    this.scopeDirty.delete(scope);
    return { ...usage };
  }

  private scopedQuotaError(scope: string, usage: WorkspaceUsage): WorkspaceQuotaError {
    const limits = this.scopes[scope]!;
    const entriesLimit = limits.maxEntries === undefined ? "unlimited" : String(limits.maxEntries);
    return new WorkspaceQuotaError(
      `Workspace quota exceeded in ${scope}: bytes ${usage.bytes}/${limits.maxBytes}, files ${usage.files}/${limits.maxFiles}, entries ${usage.entries}/${entriesLimit}. Delete files or empty the bot trash, then try again.`,
    );
  }

  private assertScopeUsage(scope: string, projected: WorkspaceUsage): void {
    const limits = this.scopes[scope]!;
    const pending = this.pendingScope.get(scope) ?? { bytes: 0, files: 0, entries: 0 };
    if (
      projected.bytes + pending.bytes > limits.maxBytes ||
      projected.files + pending.files > limits.maxFiles ||
      (limits.maxEntries !== undefined && projected.entries + pending.entries > limits.maxEntries)
    ) throw this.scopedQuotaError(scope, {
      ...projected,
      bytes: projected.bytes + pending.bytes,
      files: projected.files + pending.files,
      entries: projected.entries + pending.entries,
    });
  }

  /**
   * Verify current cached authority. Call refreshUsage() when external code
   * such as process.run may have changed the workspace.
   */
  async assertWithinQuota(): Promise<void> {
    let release!: () => void;
    const previous = this.reservationTail;
    this.reservationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const usage = await this.currentUsageLocked();
      this.assertUsage(usage);
    } finally {
      release();
    }
  }

  async reserve(destination: string, bytes: number): Promise<QuotaReservation> {
    let release!: () => void;
    const previous = this.reservationTail;
    this.reservationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new WorkspaceQuotaError();
      const root = this.workspace.root.replace(/[\\/]+$/u, "").toLowerCase();
      const normalized = destination.toLowerCase();
      if (normalized !== root && !normalized.startsWith(`${root}\\`) && !normalized.startsWith(`${root}/`)) {
        throw new WorkspaceQuotaError();
      }
      const existing = await lstat(destination).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (existing?.isSymbolicLink() || (existing !== null && !existing.isFile())) throw new WorkspaceQuotaError();
      const usage = await this.currentUsageLocked();
      const oldBytes = existing?.size ?? 0;
      const newFile = existing === null;
      const scope = this.scopeFor(destination);
      const scopeContext = scope === undefined
        ? undefined
        : { name: scope.name, usage: await this.currentScopeUsageLocked(scope.name, scope.directory) };
      return this.reserveDeltaLocked(
        usage,
        {
          bytes: Math.max(0, bytes - oldBytes),
          files: newFile ? 1 : 0,
          entries: newFile ? 1 : 0,
        },
        {
          bytes: bytes - oldBytes,
          files: newFile ? 1 : 0,
          entries: newFile ? 1 : 0,
        },
        release,
        scopeContext,
      );
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Reserve quota for a new tree or a set of directory entries atomically. */
  async reserveDelta(delta: QuotaDelta, scopePath?: string): Promise<QuotaReservation> {
    let release!: () => void;
    const previous = this.reservationTail;
    this.reservationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const usage = await this.currentUsageLocked();
      const scope = scopePath === undefined ? undefined : this.scopeFor(scopePath);
      const scopeContext = scope === undefined
        ? undefined
        : { name: scope.name, usage: await this.currentScopeUsageLocked(scope.name, scope.directory) };
      return this.reserveDeltaLocked(usage, delta, delta, release, scopeContext);
    } catch (error) {
      release();
      throw error;
    }
  }

  private async refreshUsageLocked(): Promise<WorkspaceUsage> {
    const usage = await this.calculateUsage(this.workspace.root, this.options.maxEntries);
    this.cachedUsage = { ...usage };
    this.usageDirty = false;
    this.commitsSinceRefresh = 0;
    return { ...usage };
  }

  private async currentUsageLocked(): Promise<WorkspaceUsage> {
    if (this.cachedUsage === undefined || this.usageDirty) return this.refreshUsageLocked();
    return { ...this.cachedUsage };
  }

  private quotaError(usage: WorkspaceUsage): WorkspaceQuotaError {
    const entriesLimit = this.options.maxEntries === undefined ? "unlimited" : String(this.options.maxEntries);
    return new WorkspaceQuotaError(
      `Workspace quota exceeded: bytes ${usage.bytes}/${this.options.maxBytes}, files ${usage.files}/${this.options.maxFiles}, entries ${usage.entries}/${entriesLimit}. Delete files or empty the bot trash, then try again.`,
    );
  }

  private assertUsage(usage: WorkspaceUsage): void {
    if (
      usage.bytes + this.pendingBytes > this.options.maxBytes ||
      usage.files + this.pendingFiles > this.options.maxFiles ||
      (this.options.maxEntries !== undefined && usage.entries + this.pendingEntries > this.options.maxEntries)
    ) throw this.quotaError({
      ...usage,
      bytes: usage.bytes + this.pendingBytes,
      files: usage.files + this.pendingFiles,
      entries: usage.entries + this.pendingEntries,
    });
  }

  private reserveDeltaLocked(
    usage: WorkspaceUsage,
    reserved: QuotaDelta,
    committed: QuotaDelta,
    releaseLock: () => void,
    scope?: { name: string; usage: WorkspaceUsage },
  ): QuotaReservation {
    if (
      !Number.isSafeInteger(reserved.bytes) || reserved.bytes < 0 ||
      !Number.isSafeInteger(reserved.files) || reserved.files < 0 ||
      !Number.isSafeInteger(reserved.entries) || reserved.entries < 0 ||
      !Number.isSafeInteger(committed.bytes) ||
      !Number.isSafeInteger(committed.files) || committed.files < 0 ||
      !Number.isSafeInteger(committed.entries) || committed.entries < 0
    ) throw new WorkspaceQuotaError();

    const projected: WorkspaceUsage = {
      bytes: usage.bytes + this.pendingBytes + reserved.bytes,
      files: usage.files + this.pendingFiles + reserved.files,
      entries: usage.entries + this.pendingEntries + reserved.entries,
      directories: usage.directories + Math.max(0, reserved.entries - reserved.files),
    };
    if (
      projected.bytes > this.options.maxBytes ||
      projected.files > this.options.maxFiles ||
      (this.options.maxEntries !== undefined && projected.entries > this.options.maxEntries)
    ) throw this.quotaError(projected);
    if (scope !== undefined) {
      const projectedScope: WorkspaceUsage = {
        ...scope.usage,
        bytes: scope.usage.bytes + reserved.bytes,
        files: scope.usage.files + reserved.files,
        entries: scope.usage.entries + reserved.entries,
      };
      this.assertScopeUsage(scope.name, projectedScope);
    }

    let active = true;
    this.pendingBytes += reserved.bytes;
    this.pendingFiles += reserved.files;
    this.pendingEntries += reserved.entries;
    if (scope !== undefined) {
      const pending = this.pendingScope.get(scope.name) ?? { bytes: 0, files: 0, entries: 0 };
      this.pendingScope.set(scope.name, {
        bytes: pending.bytes + reserved.bytes,
        files: pending.files + reserved.files,
        entries: pending.entries + reserved.entries,
      });
    }
    const settle = (commit: boolean): void => {
      if (!active) return;
      active = false;
      if (commit && this.cachedUsage !== undefined) {
        this.cachedUsage.bytes = Math.max(0, this.cachedUsage.bytes + committed.bytes);
        this.cachedUsage.files += committed.files;
        this.cachedUsage.entries += committed.entries;
        this.cachedUsage.directories += Math.max(0, committed.entries - committed.files);
        this.commitsSinceRefresh += 1;
        if (this.commitsSinceRefresh >= FULL_SCAN_AFTER_COMMITS) this.usageDirty = true;
      }
      if (scope !== undefined && commit && this.scopeUsage.has(scope.name)) {
        const scopeCached = this.scopeUsage.get(scope.name)!;
        this.scopeUsage.set(scope.name, {
          ...scopeCached,
          bytes: Math.max(0, scopeCached.bytes + committed.bytes),
          files: scopeCached.files + committed.files,
          entries: scopeCached.entries + committed.entries,
          directories: scopeCached.directories + Math.max(0, committed.entries - committed.files),
        });
      }
      this.pendingBytes -= reserved.bytes;
      this.pendingFiles -= reserved.files;
      this.pendingEntries -= reserved.entries;
      if (scope !== undefined) {
        const pending = this.pendingScope.get(scope.name);
        if (pending !== undefined) {
          const remaining = {
            bytes: pending.bytes - reserved.bytes,
            files: pending.files - reserved.files,
            entries: pending.entries - reserved.entries,
          };
          if (remaining.bytes === 0 && remaining.files === 0 && remaining.entries === 0) this.pendingScope.delete(scope.name);
          else this.pendingScope.set(scope.name, remaining);
        }
      }
      releaseLock();
    };
    return { commit: () => settle(true), cancel: () => settle(false) };
  }
}

export const DEFAULT_GLOBAL_DISK_BUDGET_BYTES = 32 * 1024 * 1024 * 1024;
const GLOBAL_DISK_INVENTORY_MAX_ENTRIES = 2_000_000;

export function resolveGlobalDiskBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENBOT_GLOBAL_DISK_BUDGET_BYTES?.trim();
  if (!raw) return DEFAULT_GLOBAL_DISK_BUDGET_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_GLOBAL_DISK_BUDGET_BYTES;
  return parsed;
}

/** Workspaces + browser partitions. Skips `.staging` so in-flight imports do not inflate admission. */
export async function measureManagedDiskBytes(roots: readonly string[]): Promise<number> {
  let total = 0;
  for (const root of roots) {
    try {
      const usage = await calculateWorkspaceUsage(root, GLOBAL_DISK_INVENTORY_MAX_ENTRIES, (relative) => {
        const slash = relative.replaceAll("\\", "/").toLowerCase();
        return slash === ".staging" || slash.startsWith(".staging/");
      });
      total += usage.bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return total;
}

export function assertGlobalDiskBudget(
  usedBytes: number,
  extraBytes = 0,
  budget = resolveGlobalDiskBudgetBytes(),
): void {
  const extra = Number.isSafeInteger(extraBytes) && extraBytes > 0 ? extraBytes : 0;
  if (usedBytes + extra >= budget) throw new WorkspaceQuotaError("Global disk budget exceeded.");
}

export const DEFAULT_WORKSPACE_QUOTA: WorkspaceQuotaOptions = {
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxFiles: 100_000,
  maxEntries: 200_000,
};

/** Sub-quotas por pasta (melhoria 6): Downloads menor, Projects maior, .openbot contido. */
export const DEFAULT_WORKSPACE_QUOTA_SCOPES: Record<string, WorkspaceQuotaOptions> = {
  downloads: { maxBytes: 256 * 1024 * 1024, maxFiles: 25_000, maxEntries: 50_000 },
  projects: { maxBytes: 1536 * 1024 * 1024, maxFiles: 80_000, maxEntries: 160_000 },
  ".openbot": { maxBytes: 64 * 1024 * 1024, maxFiles: 10_000, maxEntries: 20_000 },
};
