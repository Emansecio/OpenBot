import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
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
  complete: boolean;
}

export const DEFAULT_HOME_INVENTORY_MAX_ENTRIES = DEFAULT_WORKSPACE_QUOTA.maxEntries ?? DEFAULT_WORKSPACE_QUOTA.maxFiles;
const INVENTORY_HASH_CHUNK_BYTES = 64 * 1024;

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

  const visit = async (current: string, prefix: string): Promise<void> => {
    abortIfRequested(signal);
    const children = await readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      abortIfRequested(signal);
      const path = validateArchivePath(prefix.length === 0 ? child.name : `${prefix}/${child.name}`);
      const absolute = join(current, child.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new HomeArchiveError("unsafe_path", `Home contains a symbolic link: ${path}`);
      if (metadata.isDirectory()) {
        directories += 1;
        entries.push({ path, type: "directory", size: 0 });
        if (entries.length > maxEntries) throw new HomeArchiveError("invalid_archive", "Home contains too many entries.");
        if (isHomeTrashArchivePath(path)) continue;
        await visit(absolute, path);
      } else if (metadata.isFile()) {
        if (metadata.size > maxBytes - bytes) throw new HomeArchiveError("invalid_archive", "Home exceeds the inventory size limit.");
        const hashed = await hashFile(absolute, metadata, maxBytes - bytes, signal);
        bytes += hashed.size;
        files += 1;
        entries.push({ path, type: "file", size: hashed.size, sha256: hashed.sha256 });
        if (entries.length > maxEntries) throw new HomeArchiveError("invalid_archive", "Home contains too many entries.");
      } else {
        throw new HomeArchiveError("unsafe_path", `Home contains an unsupported filesystem entry: ${path}`);
      }
    }
  };

  await visit(root, "");
  return { agentId, root, files, directories, bytes, entries, complete: true };
}
