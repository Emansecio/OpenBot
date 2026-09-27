import { createHash } from "node:crypto";
import { lstat, open, opendir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { HomeArchiveError, validateArchivePath } from "./home-archive.js";
import { DEFAULT_WORKSPACE_QUOTA } from "./quota.js";
import { isHomeTrashArchivePath } from "./user-files.js";

export interface HomeInventoryEntry {
  path: string;
  type: "file" | "directory";
  size: number;
  sha256?: string;
}

export interface HomeInventory {
  agentId: string;
  root: string;
  files: number;
  directories: number;
  bytes: number;
  entries: HomeInventoryEntry[];
  /**
   * False when something was left out: links (opaque, never followed), other
   * special entries, files that changed while being hashed, or the listing
   * stopped at its entry/byte limits.
   */
  complete: boolean;
}

export const DEFAULT_HOME_INVENTORY_MAX_ENTRIES = DEFAULT_WORKSPACE_QUOTA.maxEntries ?? DEFAULT_WORKSPACE_QUOTA.maxFiles;
export const WORKSPACE_ACL_STAMP_NAME = ".openbot-acl-v1.json";
const INVENTORY_HASH_CHUNK_BYTES = 64 * 1024;

/**
 * Lifecycle validation must work even when a home exceeds its storage quota.
 * Links inside the home (e.g. junctions made by package managers) are opaque:
 * quarantine renames them and purges remove them without following, so they
 * are neither descended into nor treated as unsafe.
 */
export async function validateHomeTree(root: string): Promise<void> {
  const visit = async (current: string, prefix: string): Promise<void> => {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new HomeArchiveError("unsafe_path", "Home contains an unsafe directory.");
    }
    const children = await opendir(current);
    for await (const child of children) {
      const path = validateArchivePath(prefix ? `${prefix}/${child.name}` : child.name);
      const absolute = join(current, child.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!isHomeTrashArchivePath(path)) await visit(absolute, path);
      } else if (!info.isFile()) {
        throw new HomeArchiveError("unsafe_path", `Home contains an unsupported filesystem entry: ${path}`);
      }
    }
  };
  await visit(root, "");
}

const abortIfRequested = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new HomeArchiveError("io_error", "Home inventory was aborted.");
};

const sameIdentity = (left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean =>
  left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;

const hashFile = async (
  filename: string,
  expected: Awaited<ReturnType<typeof lstat>>,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<{ size: number; sha256: string }> => {
  abortIfRequested(signal);
  const handle = await open(filename, "r");
  try {
    const opened = await handle.stat();
    if (!sameIdentity(expected, opened) || opened.size !== expected.size) {
      throw new HomeArchiveError("io_error", "Home file changed while inventory was opening.");
    }
    if (opened.size > maxBytes) throw new HomeArchiveError("invalid_archive", "Home exceeds the inventory size limit.");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(INVENTORY_HASH_CHUNK_BYTES, opened.size));
    let offset = 0;
    while (offset < opened.size) {
      abortIfRequested(signal);
      const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, opened.size - offset), offset);
      if (result.bytesRead === 0) throw new HomeArchiveError("io_error", "Home file shrank during inventory.");
      digest.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const closed = await handle.stat();
    const current = await lstat(filename);
    if (!sameIdentity(expected, closed) || closed.size !== expected.size || closed.mtimeMs !== expected.mtimeMs ||
      !sameIdentity(expected, current) || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs) {
      throw new HomeArchiveError("io_error", "Home file changed during inventory.");
    }
    return { size: expected.size, sha256: digest.digest("hex") };
  } finally {
    await handle.close().catch(() => undefined);
  }
};

export async function inventoryHome(
  root: string,
  agentId: string,
  maxEntries = DEFAULT_HOME_INVENTORY_MAX_ENTRIES,
  maxBytes = DEFAULT_WORKSPACE_QUOTA.maxBytes,
  signal?: AbortSignal,
): Promise<HomeInventory> {
  const entries: HomeInventoryEntry[] = [];
  let bytes = 0;
  let files = 0;
  let directories = 0;
  // A report of the home, not a gate: what cannot be listed marks it
  // incomplete instead of failing the lifecycle operation that asked for it.
  let complete = true;
  let truncated = false;

  const visit = async (current: string, prefix: string): Promise<void> => {
    abortIfRequested(signal);
    const children = await readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (truncated) return;
      abortIfRequested(signal);
      const path = validateArchivePath(prefix.length === 0 ? child.name : `${prefix}/${child.name}`);
      const absolute = join(current, child.name);
      const metadata = await lstat(absolute);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        directories += 1;
        entries.push({ path, type: "directory", size: 0 });
        if (isHomeTrashArchivePath(path)) continue;
        await visit(absolute, path);
      } else if (metadata.isFile()) {
        if (entries.length >= maxEntries || metadata.size > maxBytes - bytes) {
          truncated = true;
          return;
        }
        let hashed: { size: number; sha256: string };
        try {
          hashed = await hashFile(absolute, metadata, maxBytes - bytes, signal);
        } catch (error) {
          if (signal?.aborted || !(error instanceof HomeArchiveError)) throw error;
          complete = false;
          continue;
        }
        bytes += hashed.size;
        files += 1;
        entries.push({ path, type: "file", size: hashed.size, sha256: hashed.sha256 });
      } else {
        // Links are opaque; other special entries are not part of the report.
        complete = false;
      }
    }
  };

  await visit(root, "");
  return { agentId, root, files, directories, bytes, entries, complete: complete && !truncated };
}
