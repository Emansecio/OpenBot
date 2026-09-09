import { watch as watchFileSystem } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { isAbsolute, join, relative as relativePath, resolve } from "node:path";

import type { QuotaDelta } from "./quota.js";
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
  onDelta(delta: QuotaDelta, absolutePath: string): Promise<void> | void;
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

async function snapshotPath(root: string, relative: string): Promise<Map<string, WatchedMetadata>> {
  const snapshot = new Map<string, WatchedMetadata>();
  const absolute = relative === "" ? root : join(root, relative);
  const metadata = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
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
        const childRelative = current.relative === "" ? entry.name : `${current.relative}/${entry.name}`;
        const childAbsolute = join(current.absolute, entry.name);
        if (entry.isDirectory()) {
          snapshot.set(childRelative, { bytes: 0, file: false });
          if (!isHomeTrashArchivePath(childRelative)) pending.push({ absolute: childAbsolute, relative: childRelative });
        } else if (entry.isFile()) {
          const childMetadata = await lstat(childAbsolute);
          if (!childMetadata.isSymbolicLink()) snapshot.set(childRelative, { bytes: childMetadata.size, file: true });
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

export class WorkspaceQuotaObserver {
  private readonly root: string;
  private readonly onDelta: WorkspaceQuotaObserverOptions["onDelta"];
  private readonly onError?: WorkspaceQuotaObserverOptions["onError"];
  private readonly watch: WorkspaceWatch;
  private readonly snapshot = new Map<string, WatchedMetadata>();
  private watcher?: WorkspaceWatcher;
  private tail: Promise<void> = Promise.resolve();
  private failure?: Error;
  private started = false;

  constructor(options: WorkspaceQuotaObserverOptions) {
    this.root = resolve(options.root);
    this.onDelta = options.onDelta;
    this.onError = options.onError;
    this.watch = options.watch ?? defaultWatch;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Workspace quota observer is already started");
    this.started = true;
    this.tail = snapshotPath(this.root, "").then((initial) => {
      for (const [path, metadata] of initial) this.snapshot.set(path, metadata);
    });
    try {
      this.watcher = this.watch(this.root, { recursive: true }, (_event, filename) => {
        if (filename == null) {
          this.fail(new Error("Workspace watcher lost the changed path"));
          return;
        }
        const value = slashPath(Buffer.isBuffer(filename) ? filename.toString("utf8") : filename);
        this.enqueue(value);
      });
      this.watcher.on("error", (error) => this.fail(error));
      await this.tail;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw this.failure;
    }
  }

  async drain(): Promise<void> {
    await this.tail;
    if (this.failure !== undefined) throw this.failure;
  }

  async close(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    await this.drain();
  }

  private enqueue(relative: string): void {
    if (this.failure !== undefined) return;
    this.tail = this.tail.then(async () => this.reconcile(relative)).catch((error) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.watcher?.close();
    this.watcher = undefined;
    this.onError?.(error);
  }

  private async reconcile(input: string): Promise<void> {
    if (input === "" || input.includes("\0") || isAbsolute(input)) {
      throw new Error("Workspace watcher reported an invalid path");
    }
    const absolute = resolve(this.root, input);
    const relative = slashPath(relativePath(this.root, absolute));
    if (relative === "" || relative === ".." || relative.startsWith("../")) {
      throw new Error("Workspace watcher reported a path outside the workspace");
    }
    if (insideTrashPayload(relative)) return;

    const prefix = `${relative}/`;
    const previous = new Map<string, WatchedMetadata>();
    for (const [path, metadata] of this.snapshot) {
      if (path === relative || path.startsWith(prefix)) previous.set(path, metadata);
    }
    const current = await snapshotPath(this.root, relative);
    const before = sumMetadata(previous.values());
    const after = sumMetadata(current.values());
    const delta: QuotaDelta = {
      bytes: after.bytes - before.bytes,
      files: after.files - before.files,
      entries: after.entries - before.entries,
    };
    for (const path of previous.keys()) this.snapshot.delete(path);
    for (const [path, metadata] of current) this.snapshot.set(path, metadata);
    if (delta.bytes !== 0 || delta.files !== 0 || delta.entries !== 0) await this.onDelta(delta, absolute);
  }
}
