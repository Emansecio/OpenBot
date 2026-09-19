import { randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, open, rename, rm } from "node:fs/promises";
import { win32 as path } from "node:path";

const MAX_TREE_ENTRIES = 100_000;

export class SafeTreeError extends Error {
  constructor(
    readonly code: "outside_workspace" | "aborted" | "output_limit" | "invalid_path" | "io_error",
    message: string,
  ) {
    super(message);
    this.name = "SafeTreeError";
  }
}

export interface SafeTreeSummary {
  bytes: number;
  files: number;
  entries: number;
  kind: "file" | "directory";
}

const abortIfRequested = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new SafeTreeError("aborted", "File operation was aborted.");
};

const fsCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

const assertNotLink = async (target: string): Promise<Awaited<ReturnType<typeof lstat>>> => {
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) {
    throw new SafeTreeError("outside_workspace", "File path is outside the workspace.");
  }
  return metadata;
};

export async function inspectSafeTree(root: string, signal?: AbortSignal): Promise<SafeTreeSummary> {
  abortIfRequested(signal);
  const metadata = await assertNotLink(root);
  if (metadata.isFile()) return { bytes: Number(metadata.size), files: 1, entries: 1, kind: "file" };
  if (!metadata.isDirectory()) throw new SafeTreeError("invalid_path", "File path is invalid.");

  const summary: SafeTreeSummary = { bytes: 0, files: 0, entries: 1, kind: "directory" };
  const pending = [root];
  while (pending.length > 0) {
    abortIfRequested(signal);
    const directory = pending.pop()!;
    await assertNotLink(directory);
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        abortIfRequested(signal);
        if (entry.isSymbolicLink()) throw new SafeTreeError("outside_workspace", "File path is outside the workspace.");
        const child = path.join(directory, entry.name);
        const childMetadata = await assertNotLink(child);
        summary.entries += 1;
        if (summary.entries > MAX_TREE_ENTRIES) throw new SafeTreeError("output_limit", "Directory exceeds the entry limit.");
        if (childMetadata.isDirectory()) pending.push(child);
        else if (childMetadata.isFile()) {
          summary.files += 1;
          summary.bytes += Number(childMetadata.size);
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return summary;
}

const copyFileContents = async (source: string, destination: string, signal?: AbortSignal): Promise<void> => {
  const sourceHandle = await open(source, "r");
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    destinationHandle = await open(destination, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      abortIfRequested(signal);
      const result = await sourceHandle.read(buffer, 0, buffer.byteLength, position);
      if (result.bytesRead === 0) break;
      let written = 0;
      while (written < result.bytesRead) {
        const chunk = await destinationHandle.write(buffer, written, result.bytesRead - written, position + written);
        if (chunk.bytesWritten === 0) throw new SafeTreeError("io_error", "File operation failed.");
        written += chunk.bytesWritten;
      }
      position += result.bytesRead;
    }
  } finally {
    await sourceHandle.close().catch(() => undefined);
    if (destinationHandle !== undefined) await destinationHandle.close().catch(() => undefined);
  }
};

export async function copySafeTreeAtomic(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<SafeTreeSummary> {
  abortIfRequested(signal);
  const summary = await inspectSafeTree(source, signal);
  await assertPathAbsent(destination);
  const temporary = path.join(path.dirname(destination), `.openbot-${randomUUID()}.tmp`);
  try {
    await copySafeTree(source, temporary, signal);
    const copied = await inspectSafeTree(temporary, signal);
    if (copied.bytes > summary.bytes || copied.files > summary.files || copied.entries > summary.entries) {
      throw new SafeTreeError("output_limit", "Directory exceeds the entry limit.");
    }
    abortIfRequested(signal);
    await rename(temporary, destination);
    return copied;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function copySafeTree(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  abortIfRequested(signal);
  const metadata = await assertNotLink(source);
  if (metadata.isFile()) {
    await copyFileContents(source, destination, signal);
    return;
  }
  if (!metadata.isDirectory()) throw new SafeTreeError("invalid_path", "File path is invalid.");
  await mkdir(destination);
  const handle = await opendir(source);
  try {
    for await (const entry of handle) {
      abortIfRequested(signal);
      if (entry.isSymbolicLink()) throw new SafeTreeError("outside_workspace", "File path is outside the workspace.");
      await copySafeTree(path.join(source, entry.name), path.join(destination, entry.name), signal);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function assertPathAbsent(destination: string): Promise<void> {
  const existing = await lstat(destination).catch((error: unknown) => {
    if (fsCode(error) === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) throw new SafeTreeError("invalid_path", "File path is invalid.");
}

export async function renameOrCopy(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  abortIfRequested(signal);
  try {
    await rename(source, destination);
  } catch (error) {
    if (fsCode(error) !== "EXDEV") throw error;
    await copySafeTreeAtomic(source, destination, signal);
    try {
      await rm(source, { recursive: true, force: false });
    } catch {
      throw new SafeTreeError("io_error", "File operation failed.");
    }
  }
}

