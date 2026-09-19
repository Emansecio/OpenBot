import { watch as watchFileSystem } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { isAbsolute, join, relative as relativePath, resolve } from "node:path";

import { WorkspaceQuotaError, type QuotaDelta, type WorkspaceUsage } from "./quota.js";
import { isHomeTrashArchivePath } from "./user-files.js";

interface WatchedMetadata {
  bytes: number;
  file: boolean;
}

export interface WorkspaceWatcher {
  on(event: "error", listener: (error: Error) => void): WorkspaceWatcher;
  close(): void;
}

export type WorkspaceWatch = (
  root: string,
  options: { recursive: true },
  listener: (event: string, filename: string | Buffer | null) => void,
) => WorkspaceWatcher;

export interface WorkspaceQuotaObserverOptions {
  root: string;
  onDelta?(delta: QuotaDelta, absolutePath: string): Promise<void> | void;
  /** Called under synchronize, including the initial inventory. */
  onSnapshot?(usage: WorkspaceUsage, scopes: ReadonlyMap<string, WorkspaceUsage>): void;
  synchronize?(operation: () => Promise<void>): Promise<void>;
  maxEntries?: number;
  onScan?(durationMs: number): void;
  reconciliationIntervalMs?: number;
  onError?(error: Error): void;
  watch?: WorkspaceWatch;
}

const defaultWatch: WorkspaceWatch = (root, options, listener) =>
  watchFileSystem(root, options, listener);

const slashPath = (value: string): string => value.replaceAll("\\", "/");
const insideTrashPayload = (relative: string): boolean => {
  const normalized = slashPath(relative).toLowerCase();
  return normalized.startsWith(".openbot/trash/");
};

async function snapshotPath(root: string, relative: string, maxEntries: number): Promise<Map<string, WatchedMetadata>> {
  const snapshot = new Map<string, WatchedMetadata>();
  const absolute = relative === "" ? root : join(root, relative);
  // An event may refer to a child of a directory replaced by a junction.
  let ancestor = root;
  for (const segment of slashPath(relative).split("/").slice(0, -1)) {
    ancestor = join(ancestor, segment);
    const parent = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (parent === null || parent.isSymbolicLink() || !parent.isDirectory()) return snapshot;
  }
  const metadata = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (metadata === null || metadata.isSymbolicLink()) return snapshot;
  if (metadata.isFile()) {
    if (relative !== "") snapshot.set(slashPath(relative), { bytes: metadata.size, file: true });
    return snapshot;
  }
  if (!metadata.isDirectory()) return snapshot;
  if (relative !== "") snapshot.set(slashPath(relative), { bytes: 0, file: false });
  if (relative !== "" && isHomeTrashArchivePath(slashPath(relative))) return snapshot;

  const pending: Array<{ absolute: string; relative: string }> = [{ absolute, relative: slashPath(relative) }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const directory = await opendir(current.absolute);
    try {
      for await (const entry of directory) {
        if (entry.isSymbolicLink()) continue;
        if (snapshot.size >= maxEntries) throw new WorkspaceQuotaError("Workspace inventory limit exceeded.");
        const childRelative = current.relative === "" ? entry.name : `${current.relative}/${entry.name}`;
        const childAbsolute = join(current.absolute, entry.name);
        if (entry.isDirectory()) {
          snapshot.set(childRelative, { bytes: 0, file: false });
          if (!isHomeTrashArchivePath(childRelative)) pending.push({ absolute: childAbsolute, relative: childRelative });
        } else if (entry.isFile()) {
          const childMetadata = await lstat(childAbsolute).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (childMetadata?.isFile()) snapshot.set(childRelative, { bytes: childMetadata.size, file: true });
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
  return snapshot;
}

const sumMetadata = (entries: Iterable<WatchedMetadata>): QuotaDelta => {
  const delta: QuotaDelta = { bytes: 0, files: 0, entries: 0 };
  for (const metadata of entries) {
    delta.entries += 1;
    if (metadata.file) {
      delta.files += 1;
      delta.bytes += metadata.bytes;
    }
  }
  return delta;
};

const emptyUsage = (): WorkspaceUsage => ({ bytes: 0, files: 0, directories: 0, entries: 0 });
const MAX_PENDING_PATHS = 1024;

export class WorkspaceQuotaObserver {
  private readonly root: string;
  private readonly snapshot = new Map<string, WatchedMetadata>();
  // Parent -> immediate children. File events never search the full inventory.
  private readonly children = new Map<string, Set<string>>();
  private readonly scopes = new Map<string, WorkspaceUsage>();
  private usage = emptyUsage();
  private readonly pending = new Set<string>();
  private readonly counters = { events: 0, coalescedEvents: 0, peakPendingPaths: 0, reconciledPaths: 0, visitedEntries: 0 };

  metrics(): Readonly<typeof this.counters> { return { ...this.counters }; }
  private fullScan = true;
  private watcher?: WorkspaceWatcher;
  private timer?: ReturnType<typeof setInterval>;
  private tail: Promise<void> = Promise.resolve();
  private scheduled = false;
  private failure?: Error;
  private started = false;
  private initialized = false;
  private closed = false;

  constructor(private readonly options: WorkspaceQuotaObserverOptions) {
    this.root = resolve(options.root);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Workspace quota observer is already started");
    this.started = true;
    try {
      // Install before inventory so changes during the walk are queued.
      this.watcher = (this.options.watch ?? defaultWatch)(this.root, { recursive: true }, (_event, filename) => {
        if (filename == null) { this.invalidate(); return; }
        this.enqueue(slashPath(Buffer.isBuffer(filename) ? filename.toString("utf8") : filename));
      });
      this.watcher.on("error", (error) => this.fail(error));
      this.schedule();
      await this.drain();
      this.timer = setInterval(() => this.invalidate(), this.options.reconciliationIntervalMs ?? 30_000);
      this.timer.unref();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw this.failure;
    }
  }

  /** Lost paths, queue overflow and structured writes require a new authority. */
  invalidate(): void {
    this.fullScan = true;
    this.pending.clear();
    this.schedule();
  }

  async drain(): Promise<void> {
    do { await this.tail; } while (this.scheduled);
    if (this.failure !== undefined) throw this.failure;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.watcher?.close();
    this.watcher = undefined;
    clearInterval(this.timer);
    // A final full walk also catches silent losses and external writers.
    this.invalidate();
    await this.drain();
  }

  private enqueue(input: string): void {
    if (this.failure !== undefined || this.closed) return;
    this.counters.events += 1;
    if (input === "" || input.includes("\0") || isAbsolute(input)) {
      this.fail(new Error("Workspace watcher reported an invalid path"));
      return;
    }
    const absolute = resolve(this.root, input);
    let relative = slashPath(relativePath(this.root, absolute));
    if (relative === "" || relative === ".." || relative.startsWith("../")) {
      this.fail(new Error("Workspace watcher reported a path outside the workspace"));
      return;
    }
    if (insideTrashPayload(relative)) return;
    let parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
    while (parent !== "" && !this.snapshot.has(parent)) {
      relative = parent;
      parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
    }
    if (!this.fullScan) {
      if (this.pending.has(relative)) this.counters.coalescedEvents += 1;
      this.pending.add(relative);
      this.counters.peakPendingPaths = Math.max(this.counters.peakPendingPaths, this.pending.size);
      if (this.pending.size >= MAX_PENDING_PATHS) this.invalidate();
    }
    this.schedule();
  }

  private schedule(): void {
    if (!this.started || this.scheduled || this.failure !== undefined) return;
    this.scheduled = true;
    this.tail = this.tail.then(async () => {
      try {
        const operation = async () => { await this.reconcileLocked(); };
        if (this.options.synchronize) await this.options.synchronize(operation);
        else await operation();
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.scheduled = false;
        if (this.fullScan || this.pending.size > 0) this.schedule();
      }
    });
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.watcher?.close();
    this.watcher = undefined;
    clearInterval(this.timer);
    this.options.onError?.(error);
  }

  /** The quota calls this only while holding its reservation lock. */
  async reconcileLocked(): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    if (this.fullScan) {
      this.fullScan = false;
      this.pending.clear();
      await this.reconcile("");
    }
    const paths = [...this.pending];
    this.pending.clear();
    const selected = new Set(paths);
    for (const path of paths) {
      let parent = path;
      let covered = false;
      while (parent.includes("/")) {
        parent = parent.slice(0, parent.lastIndexOf("/"));
        if (selected.has(parent)) { covered = true; break; }
      }
      if (!covered) await this.reconcile(path);
    }
    this.options.onSnapshot?.({ ...this.usage }, this.scopes);
    this.initialized = true;
  }

  private adjust(path: string, metadata: WatchedMetadata, sign: number): void {
    const apply = (usage: WorkspaceUsage): void => {
      usage.entries += sign;
      usage.files += metadata.file ? sign : 0;
      usage.directories += metadata.file ? 0 : sign;
      usage.bytes += sign * metadata.bytes;
    };
    apply(this.usage);
    const separator = path.indexOf("/");
    if (separator < 0) return; // The scope root itself is not a scoped entry.
    const scope = path.slice(0, separator).toLowerCase();
    let usage = this.scopes.get(scope);
    if (usage === undefined) { usage = emptyUsage(); this.scopes.set(scope, usage); }
    apply(usage);
    if (usage.entries === 0) this.scopes.delete(scope);
  }

  private async reconcile(relative: string): Promise<void> {
    this.counters.reconciledPaths += 1;
    const started = performance.now();
    const current = await snapshotPath(this.root, relative, this.options.maxEntries ?? 100_000);
    if (relative === "") this.options.onScan?.(performance.now() - started);
    const previous = new Map<string, WatchedMetadata>();
    const pending = relative === "" ? [...(this.children.get("") ?? [])] : [relative];
    while (pending.length > 0) {
      const path = pending.pop()!;
      this.counters.visitedEntries += 1;
      const metadata = this.snapshot.get(path);
      if (metadata !== undefined) previous.set(path, metadata);
      for (const child of this.children.get(path) ?? []) pending.push(child);
    }
    if (this.snapshot.size - previous.size + current.size > (this.options.maxEntries ?? 100_000)) {
      throw new WorkspaceQuotaError("Workspace inventory limit exceeded.");
    }
    for (const [path, metadata] of previous) {
      this.adjust(path, metadata, -1);
      this.snapshot.delete(path);
      this.children.delete(path);
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      this.children.get(parent)?.delete(path);
    }
    for (const [path, metadata] of current) {
      this.snapshot.set(path, metadata);
      this.adjust(path, metadata, 1);
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      let children = this.children.get(parent);
      if (children === undefined) { children = new Set(); this.children.set(parent, children); }
      children.add(path);
    }
    if ((relative !== "" || this.initialized) && this.options.onDelta !== undefined) {
      const before = sumMetadata(previous.values());
      const after = sumMetadata(current.values());
      const delta = { bytes: after.bytes - before.bytes, files: after.files - before.files, entries: after.entries - before.entries };
      if (delta.bytes !== 0 || delta.files !== 0 || delta.entries !== 0) await this.options.onDelta(delta, join(this.root, relative));
    }
  }
}
