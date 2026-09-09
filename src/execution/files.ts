import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir as fsMkdir, open, opendir, rename, rm, rmdir, unlink, writeFile as fsWriteFile } from "node:fs/promises";
import { win32 as path } from "node:path";

import {
  MAX_FILE_BYTES,
  MAX_LIST_ENTRIES,
  type ExecutionBackend,
  type ExecutionErrorCode,
  type ExecutionRequest,
  type ExecutionResult,
  type FileEncoding,
} from "./contracts.js";
import { WorkspaceQuota, WorkspaceQuotaError } from "./quota.js";
import { WorkspaceError, WorkspaceSandbox } from "./workspace.js";

type FileRequest = Extract<ExecutionRequest, { operation: `file.${string}` }>;
class FileExecutionError extends Error {
  constructor(
    readonly code: ExecutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FileExecutionError";
  }
}

const MESSAGES = {
  aborted: "File operation was aborted.",
  accessDenied: "File operation is not permitted.",
  invalidRequest: "File request is invalid.",
  invalidPath: "File path is invalid.",
  outsideWorkspace: "File path is outside the workspace.",
  ioError: "File operation failed.",
  notFound: "File path does not exist.",
  readLimit: "File exceeds the byte limit.",
  listLimit: "Directory exceeds the entry limit.",
  unsupported: "Operation is not supported by the file executor.",
} as const;

export interface FileExecutorOptions {
  /** Top-level directory names hidden from the agent-facing file surface. */
  reservedTopLevel?: readonly string[];
  /** Trusted internal trash location. It is never accepted as an agent path. */
  trashRoot?: string;
  /** Internal deterministic seam used by race-regression tests. */
  beforePathUse?: (absolute: string) => Promise<void>;
}

type FileMetadata = Awaited<ReturnType<typeof lstat>>;

const hasStableIdentity = (metadata: FileMetadata): boolean =>
  Number.isInteger(metadata.dev) && Number.isInteger(metadata.ino) && (metadata.dev !== 0 || metadata.ino !== 0);

const assertStableIdentity = (expected: FileMetadata, actual: FileMetadata): void => {
  if (
    expected.isSymbolicLink() || actual.isSymbolicLink() ||
    !hasStableIdentity(expected) || !hasStableIdentity(actual) ||
    expected.dev !== actual.dev || expected.ino !== actual.ino
  ) {
    throw new FileExecutionError("outside_workspace", MESSAGES.outsideWorkspace);
  }
};

const assertStablePath = async (filename: string, expected: FileMetadata): Promise<void> => {
  let actual: FileMetadata;
  try {
    actual = await lstat(filename);
  } catch {
    throw new FileExecutionError("outside_workspace", MESSAGES.outsideWorkspace);
  }
  assertStableIdentity(expected, actual);
};

const noFollowReadFlags = (): string | number => {
  // O_NOFOLLOW is available on POSIX. Windows has no Node equivalent, so its
  // lstat/fstat identity check below is the required fallback there.
  return process.platform === "win32" ? "r" : fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
};

const openVerifiedFile = async (
  filename: string,
  expected: FileMetadata,
  options: FileExecutorOptions,
): Promise<Awaited<ReturnType<typeof open>>> => {
  await options.beforePathUse?.(filename);
  const handle = await open(filename, noFollowReadFlags());
  try {
    assertStableIdentity(expected, await handle.stat());
    // The pathname may have been replaced while open() was in flight. The
    // handle is safe to use, but a changed visible path must fail closed.
    await assertStablePath(filename, expected);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
};

const openVerifiedDirectory = async (
  directoryName: string,
  expected: FileMetadata,
  options: FileExecutorOptions,
): Promise<Awaited<ReturnType<typeof opendir>>> => {
  await options.beforePathUse?.(directoryName);
  const directory = await opendir(directoryName);
  try {
    // Dir has no portable fstat API. lstat immediately after opendir binds
    // the directory handle to the identity that was validated before open.
    await assertStablePath(directoryName, expected);
    return directory;
  } catch (error) {
    await directory.close().catch(() => undefined);
    throw error;
  }
};

const copyFileContents = async (
  source: string,
  destination: string,
  expected: FileMetadata,
  signal: AbortSignal | undefined,
  options: FileExecutorOptions,
): Promise<void> => {
  const sourceHandle = await openVerifiedFile(source, expected, options);
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // createTemporaryPath reserves this unique name before the copy starts.
    destinationHandle = await open(destination, "w", 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      abortIfRequested(signal);
      const result = await sourceHandle.read(buffer, 0, buffer.byteLength, position);
      if (result.bytesRead === 0) break;
      let written = 0;
      while (written < result.bytesRead) {
        const chunk = await destinationHandle.write(buffer, written, result.bytesRead - written, position + written);
        if (chunk.bytesWritten === 0) throw new FileExecutionError("io_error", MESSAGES.ioError);
        written += chunk.bytesWritten;
      }
      position += result.bytesRead;
    }
  } finally {
    await sourceHandle.close().catch(() => undefined);
    if (destinationHandle) await destinationHandle.close().catch(() => undefined);
  }
};

const abortIfRequested = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new FileExecutionError("aborted", MESSAGES.aborted);
};

const fsErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

const operationOf = (request: unknown): ExecutionRequest["operation"] | "unknown" => {
  if (typeof request !== "object" || request === null || !("operation" in request)) return "unknown";
  const operation = request.operation;
  if (
    operation === "file.list" || operation === "file.stat" || operation === "file.mkdir" || operation === "file.copy" ||
    operation === "file.move" || operation === "file.trash" || operation === "file.restore" || operation === "file.read" ||
    operation === "file.write" || operation === "command.run"
  ) {
    return operation;
  }
  return "unknown";
};

const failureFor = (operation: ExecutionRequest["operation"] | "unknown", error: unknown): ExecutionResult => {
  if (error instanceof FileExecutionError) {
    return { ok: false, operation, code: error.code, message: error.message };
  }
  if (error instanceof WorkspaceQuotaError) {
    return { ok: false, operation, code: "quota_exceeded", message: error.message };
  }
  if (error instanceof WorkspaceError) {
    const message =
      error.code === "invalid_path"
        ? MESSAGES.invalidPath
        : error.code === "outside_workspace"
          ? MESSAGES.outsideWorkspace
          : error.code === "not_found"
            ? MESSAGES.notFound
            : error.code === "access_denied"
              ? MESSAGES.accessDenied
              : MESSAGES.ioError;
    return { ok: false, operation, code: error.code, message };
  }

  switch (fsErrorCode(error)) {
    case "ENOENT":
    case "ENOTDIR":
      return { ok: false, operation, code: "not_found", message: MESSAGES.notFound };
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return { ok: false, operation, code: "access_denied", message: MESSAGES.accessDenied };
    case "EISDIR":
    case "EINVAL":
    case "ENAMETOOLONG":
      return { ok: false, operation, code: "invalid_path", message: MESSAGES.invalidPath };
    default:
      return { ok: false, operation, code: "io_error", message: MESSAGES.ioError };
  }
};

const assertEncoding: (encoding: unknown) => asserts encoding is FileEncoding = (encoding) => {
  if (encoding !== "utf8" && encoding !== "base64") {
    throw new FileExecutionError("invalid_request", MESSAGES.invalidRequest);
  }
};

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const decodeBase64 = (content: string): Buffer => {
  const maxEncodedBytes = 4 * Math.ceil(MAX_FILE_BYTES / 3);
  if (content.length > maxEncodedBytes) {
    throw new FileExecutionError("output_limit", MESSAGES.readLimit);
  }
  if (!BASE64_PATTERN.test(content)) {
    throw new FileExecutionError("invalid_request", MESSAGES.invalidRequest);
  }

  const result = Buffer.from(content, "base64");
  if (result.toString("base64") !== content) {
    throw new FileExecutionError("invalid_request", MESSAGES.invalidRequest);
  }
  return result;
};

const normalizedName = (value: string): string => value.toLowerCase();

const isWorkspaceRoot = (workspace: WorkspaceSandbox, absolute: string): boolean =>
  path.normalize(workspace.root).toLowerCase() === path.normalize(absolute).toLowerCase();

const isReservedPath = (workspace: WorkspaceSandbox, absolute: string, options: FileExecutorOptions): boolean => {
  const relative = path.relative(workspace.root, absolute);
  const first = relative.split(/[\\/]/u)[0] ?? "";
  const reserved = [".openbot", ...(options.reservedTopLevel ?? [])];
  return reserved.some((name) => normalizedName(name) === normalizedName(first));
};

const isReservedName = (name: string, options: FileExecutorOptions): boolean => {
  const reserved = [".openbot", ...(options.reservedTopLevel ?? [])];
  return reserved.some((item) => normalizedName(item) === normalizedName(name));
};

const assertVisiblePath = (workspace: WorkspaceSandbox, absolute: string, options: FileExecutorOptions): void => {
  if (isReservedPath(workspace, absolute, options)) {
    throw new FileExecutionError("access_denied", MESSAGES.accessDenied);
  }
};

const contentBuffer = (content: unknown, encoding: unknown): Buffer => {
  if (typeof content !== "string") throw new FileExecutionError("invalid_request", MESSAGES.invalidRequest);
  assertEncoding(encoding);

  if (encoding === "base64") {
    const result = decodeBase64(content);
    if (result.byteLength > MAX_FILE_BYTES) throw new FileExecutionError("output_limit", MESSAGES.readLimit);
    return result;
  }

  const bytes = Buffer.byteLength(content, encoding);
  if (bytes > MAX_FILE_BYTES) throw new FileExecutionError("output_limit", MESSAGES.readLimit);
  const result = Buffer.from(content, encoding);
  if (result.byteLength > MAX_FILE_BYTES) throw new FileExecutionError("output_limit", MESSAGES.readLimit);
  return result;
};

/** Validates and returns decoded write payload bytes before any filesystem mutation. */
export function fileContentByteLength(content: string, encoding: FileEncoding): number {
  return contentBuffer(content, encoding).byteLength;
}

const readFile = async (
  workspace: WorkspaceSandbox,
  request: Extract<FileRequest, { operation: "file.read" }>,
  signal: AbortSignal | undefined,
  options: FileExecutorOptions,
): Promise<ExecutionResult> => {
  assertEncoding(request.encoding);
  abortIfRequested(signal);
  const filename = await workspace.resolveExisting(request.path);
  assertVisiblePath(workspace, filename, options);
  const expected = await lstat(filename);
  if (!expected.isFile() || expected.isSymbolicLink()) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  abortIfRequested(signal);

  const handle = await openVerifiedFile(filename, expected, options);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > MAX_FILE_BYTES) {
      throw new FileExecutionError("output_limit", MESSAGES.readLimit);
    }

    // The extra byte detects a file that grows beyond the limit between stat
    // and read while keeping allocation and I/O strictly bounded.
    const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      abortIfRequested(signal);
      const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }

    const after = await handle.stat();
    abortIfRequested(signal);
    if (bytesRead > MAX_FILE_BYTES || after.size > MAX_FILE_BYTES) {
      throw new FileExecutionError("output_limit", MESSAGES.readLimit);
    }

    const content = buffer.subarray(0, bytesRead).toString(request.encoding);
    return { ok: true, operation: "file.read", content, encoding: request.encoding, bytes: bytesRead };
  } finally {
    await handle.close().catch(() => undefined);
  }
};

const listFiles = async (
  workspace: WorkspaceSandbox,
  request: Extract<FileRequest, { operation: "file.list" }>,
  signal: AbortSignal | undefined,
  options: FileExecutorOptions,
): Promise<ExecutionResult> => {
  abortIfRequested(signal);
  const directoryName = await workspace.resolveExisting(request.path);
  assertVisiblePath(workspace, directoryName, options);
  abortIfRequested(signal);

  const metadata = await lstat(directoryName);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);

  const directory = await openVerifiedDirectory(directoryName, metadata, options);
  const entries: { name: string; kind: "file" | "directory" | "other" }[] = [];
  try {
    while (entries.length <= MAX_LIST_ENTRIES) {
      abortIfRequested(signal);
      const entry = await directory.read();
      if (entry === null) break;
      entries.push({
        name: entry.name,
        kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
      });
    }
  } finally {
    await directory.close().catch(() => undefined);
  }

  abortIfRequested(signal);
  if (entries.length > MAX_LIST_ENTRIES) throw new FileExecutionError("output_limit", MESSAGES.listLimit);
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const visibleEntries = isWorkspaceRoot(workspace, directoryName)
    ? entries.filter((entry) => !isReservedName(entry.name, options))
    : entries;
  return { ok: true, operation: "file.list", entries: visibleEntries };
};

const openUniqueTemporaryFile = async (directory: string, signal: AbortSignal | undefined) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const filename = path.join(directory, `.openbot-${randomUUID()}.tmp`);
    abortIfRequested(signal); // opening with wx creates the file
    try {
      return { filename, handle: await open(filename, "wx", 0o600) };
    } catch (error) {
      if (fsErrorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new FileExecutionError("io_error", MESSAGES.ioError);
};

interface TreeSummary {
  bytes: number;
  files: number;
  entries: number;
  kind: "file" | "directory" | "other";
}

const MAX_TREE_ENTRIES = 100_000;

const inspectTree = async (root: string, signal: AbortSignal | undefined, options: FileExecutorOptions): Promise<TreeSummary> => {
  abortIfRequested(signal);
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink()) throw new FileExecutionError("outside_workspace", MESSAGES.outsideWorkspace);
  if (metadata.isFile()) return { bytes: metadata.size, files: 1, entries: 1, kind: "file" };
  if (!metadata.isDirectory()) return { bytes: 0, files: 0, entries: 1, kind: "other" };

  const summary: TreeSummary = { bytes: 0, files: 0, entries: 1, kind: "directory" };
  const pending = [root];
  while (pending.length > 0) {
    abortIfRequested(signal);
    const directory = pending.pop()!;
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new FileExecutionError("outside_workspace", MESSAGES.outsideWorkspace);
    }
    const handle = await openVerifiedDirectory(directory, directoryMetadata, options);
    try {
      for await (const entry of handle) {
        abortIfRequested(signal);
        if (entry.isSymbolicLink()) throw new FileExecutionError("outside_workspace", MESSAGES.outsideWorkspace);
        const child = path.join(directory, entry.name);
        const childMetadata = await lstat(child);
        if (childMetadata.isSymbolicLink()) throw new FileExecutionError("outside_workspace", MESSAGES.outsideWorkspace);
        summary.entries += 1;
        if (summary.entries > MAX_TREE_ENTRIES) throw new FileExecutionError("output_limit", MESSAGES.listLimit);
        if (childMetadata.isDirectory()) pending.push(child);
        else if (childMetadata.isFile()) {
          summary.files += 1;
          summary.bytes += childMetadata.size;
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return summary;
};

const createTemporaryPath = async (directory: string, signal: AbortSignal | undefined): Promise<string> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const temporary = path.join(directory, `.openbot-${randomUUID()}.tmp`);
    abortIfRequested(signal);
    try {
      const handle = await open(temporary, "wx", 0o600);
      await handle.close();
      return temporary;
    } catch (error) {
      if (fsErrorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new FileExecutionError("io_error", MESSAGES.ioError);
};

const createTemporaryDirectory = async (directory: string, signal: AbortSignal | undefined): Promise<string> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const temporary = path.join(directory, `.openbot-${randomUUID()}.tmp`);
    abortIfRequested(signal);
    try {
      await fsMkdir(temporary);
      return temporary;
    } catch (error) {
      if (fsErrorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new FileExecutionError("io_error", MESSAGES.ioError);
};

const copyTree = async (
  source: string,
  destination: string,
  signal: AbortSignal | undefined,
  options: FileExecutorOptions,
): Promise<void> => {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) throw new FileExecutionError("outside_workspace", MESSAGES.outsideWorkspace);
  abortIfRequested(signal);
  if (metadata.isFile()) {
    await copyFileContents(source, destination, metadata, signal, options);
    return;
  }
  if (!metadata.isDirectory()) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  await fsMkdir(destination).catch((error: unknown) => {
    if (fsErrorCode(error) !== "EEXIST") throw error;
  });
  const handle = await openVerifiedDirectory(source, metadata, options);
  try {
    for await (const entry of handle) {
      abortIfRequested(signal);
      if (entry.isSymbolicLink()) throw new FileExecutionError("outside_workspace", MESSAGES.outsideWorkspace);
      await copyTree(path.join(source, entry.name), path.join(destination, entry.name), signal, options);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
};

const assertDestinationParent = async (
  workspace: WorkspaceSandbox,
  requestPath: string,
  destination: string,
): Promise<{ path: string; metadata: FileMetadata }> => {
  const parent = await workspace.resolveExisting(path.dirname(requestPath));
  const metadata = await lstat(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || path.dirname(destination) !== parent) {
    throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  }
  return { path: parent, metadata };
};

const assertDestinationAbsent = async (destination: string): Promise<void> => {
  const existing = await lstat(destination).catch((error: unknown) => {
    if (fsErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
};

const statFile = async (
  workspace: WorkspaceSandbox,
  request: Extract<FileRequest, { operation: "file.stat" }>,
  signal: AbortSignal | undefined,
  options: FileExecutorOptions,
): Promise<ExecutionResult> => {
  abortIfRequested(signal);
  const target = await workspace.resolveExisting(request.path);
  assertVisiblePath(workspace, target, options);
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) throw new FileExecutionError("outside_workspace", MESSAGES.outsideWorkspace);
  return {
    ok: true,
    operation: "file.stat",
    kind: metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : "other",
    bytes: metadata.isFile() ? metadata.size : 0,
  };
};

const mkdirFile = async (
  workspace: WorkspaceSandbox,
  request: Extract<FileRequest, { operation: "file.mkdir" }>,
  signal: AbortSignal | undefined,
  quota: WorkspaceQuota | undefined,
  options: FileExecutorOptions,
): Promise<ExecutionResult> => {
  abortIfRequested(signal);
  // This first validation rejects absolute paths and traversal even when an
  // intermediate directory is not present yet.
  try {
    const existingTarget = await workspace.resolveDestination(request.path);
    assertVisiblePath(workspace, existingTarget, options);
    if (isWorkspaceRoot(workspace, existingTarget)) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
    const metadata = await lstat(existingTarget).catch((error: unknown) => {
      if (fsErrorCode(error) === "ENOENT") throw new WorkspaceError("not_found", MESSAGES.notFound);
      throw error;
    });
    if (!metadata.isDirectory()) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
    return { ok: true, operation: "file.mkdir", created: false };
  } catch (error) {
    if (!(error instanceof WorkspaceError) || error.code !== "not_found") throw error;
  }

  const components = request.path.split(/[\\/]/u).filter((component) => component.length > 0 && component !== ".");
  if (components.length === 0) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  const created: string[] = [];
  let relative = "";
  try {
    for (const component of components) {
      abortIfRequested(signal);
      relative = relative.length === 0 ? component : path.join(relative, component);
      const target = await workspace.resolveDestination(relative);
      assertVisiblePath(workspace, target, options);
      const existing = await lstat(target).catch((error: unknown) => {
        if (fsErrorCode(error) === "ENOENT") return null;
        throw error;
      });
      if (existing !== null) {
        if (!existing.isDirectory() || existing.isSymbolicLink()) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
        continue;
      }
      const parentPath = await workspace.resolveExisting(path.dirname(relative));
      const parentMetadata = await lstat(parentPath);
      if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
      const reservation = quota ? await quota.reserveDelta({ bytes: 0, files: 0, entries: 1 }) : undefined;
      try {
        await options.beforePathUse?.(parentPath);
        await assertStablePath(parentPath, parentMetadata);
        await fsMkdir(target);
        await assertStablePath(parentPath, parentMetadata);
        reservation?.commit();
        created.push(target);
      } catch (error) {
        reservation?.cancel();
        throw error;
      }
    }
    return { ok: true, operation: "file.mkdir", created: created.length > 0 };
  } catch (error) {
    for (const directory of [...created].reverse()) await rmdir(directory).catch(() => undefined);
    if (created.length > 0) quota?.markUsageDirty();
    throw error;
  }
};

const copyFileRequest = async (
  workspace: WorkspaceSandbox,
  request: Extract<FileRequest, { operation: "file.copy" }>,
  signal: AbortSignal | undefined,
  quota: WorkspaceQuota | undefined,
  options: FileExecutorOptions,
): Promise<ExecutionResult> => {
  abortIfRequested(signal);
  const source = await workspace.resolveExisting(request.source);
  assertVisiblePath(workspace, source, options);
  if (isWorkspaceRoot(workspace, source)) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  const summary = await inspectTree(source, signal, options);
  if (summary.kind === "other") throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  const destination = await workspace.resolveDestination(request.destination);
  assertVisiblePath(workspace, destination, options);
  if (isWorkspaceRoot(workspace, destination)) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  const parent = await assertDestinationParent(workspace, request.destination, destination);
  await assertDestinationAbsent(destination);
  if (summary.kind === "directory") {
    const relative = path.relative(source, destination);
    if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
    }
  }

  const reservation = quota ? await quota.reserveDelta({ bytes: summary.bytes, files: summary.files, entries: summary.entries }) : undefined;
  let temporary: string | undefined;
  let renamed = false;
  let committed = false;
  try {
    await options.beforePathUse?.(parent.path);
    await assertStablePath(parent.path, parent.metadata);
    temporary = summary.kind === "directory" ? await createTemporaryDirectory(parent.path, signal) : await createTemporaryPath(parent.path, signal);
    await assertStablePath(parent.path, parent.metadata);
    await copyTree(source, temporary, signal, options);
    const copied = await inspectTree(temporary, signal, options);
    if (copied.bytes > summary.bytes || copied.files > summary.files || copied.entries > summary.entries) throw new WorkspaceQuotaError();
    abortIfRequested(signal);
    await assertStablePath(parent.path, parent.metadata);
    await assertDestinationAbsent(destination);
    const temporaryMetadata = await lstat(temporary);
    await rename(temporary, destination);
    renamed = true;
    await assertStablePath(parent.path, parent.metadata);
    await assertStablePath(destination, temporaryMetadata);
    reservation?.commit();
    committed = true;
    return { ok: true, operation: "file.copy", bytes: copied.bytes, entries: copied.entries };
  } catch (error) {
    if (renamed && !committed) {
      try {
        await assertStablePath(parent.path, parent.metadata);
        await rename(destination, temporary!);
      } catch {
        throw new FileExecutionError("io_error", MESSAGES.ioError);
      }
    }
    throw error;
  } finally {
    if (!committed) reservation?.cancel();
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
};

const moveFile = async (
  workspace: WorkspaceSandbox,
  request: Extract<FileRequest, { operation: "file.move" }>,
  signal: AbortSignal | undefined,
  options: FileExecutorOptions,
): Promise<ExecutionResult> => {
  abortIfRequested(signal);
  const source = await workspace.resolveExisting(request.source);
  assertVisiblePath(workspace, source, options);
  if (isWorkspaceRoot(workspace, source)) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  const sourceMetadata = await lstat(source);
  if (sourceMetadata.isSymbolicLink()) throw new FileExecutionError("outside_workspace", MESSAGES.outsideWorkspace);
  const destination = await workspace.resolveDestination(request.destination);
  assertVisiblePath(workspace, destination, options);
  if (isWorkspaceRoot(workspace, destination)) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  const parent = await assertDestinationParent(workspace, request.destination, destination);
  await assertDestinationAbsent(destination);
  if (sourceMetadata.isDirectory()) {
    const relative = path.relative(source, destination);
    if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
    }
  }
  abortIfRequested(signal);
  await options.beforePathUse?.(source);
  await assertStablePath(source, sourceMetadata);
  await options.beforePathUse?.(parent.path);
  await assertStablePath(parent.path, parent.metadata);
  let moved = false;
  try {
    await rename(source, destination);
    moved = true;
    await assertStablePath(parent.path, parent.metadata);
    await assertStablePath(destination, sourceMetadata);
    return { ok: true, operation: "file.move" };
  } catch (error) {
    if (moved) {
      try {
        await assertStablePath(parent.path, parent.metadata);
        await assertDestinationAbsent(source);
        await rename(destination, source);
      } catch {
        throw new FileExecutionError("io_error", MESSAGES.ioError);
      }
    }
    throw error;
  }
};

const internalTrashRoot = (workspace: WorkspaceSandbox, options: FileExecutorOptions): string =>
  options.trashRoot ?? path.join(workspace.root, ".openbot", "trash");

interface InternalTrashPlan {
  target: string;
  missingEntries: number;
}

const inspectInternalTrashRoot = async (workspace: WorkspaceSandbox, options: FileExecutorOptions): Promise<InternalTrashPlan> => {
  const root = path.normalize(workspace.root);
  const target = path.normalize(internalTrashRoot(workspace, options));
  const relative = path.relative(root, target);
  const components = relative.split(/[\\/]/u).filter((component) => component.length > 0);
  if (components.length < 2 || normalizedName(components[0]!) !== ".openbot") {
    throw new FileExecutionError("access_denied", MESSAGES.accessDenied);
  }
  let current = root;
  let missingEntries = 0;
  for (const component of components) {
    current = path.join(current, component);
    const existing = await lstat(current).catch((error: unknown) => {
      if (fsErrorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (existing?.isSymbolicLink()) throw new FileExecutionError("outside_workspace", MESSAGES.outsideWorkspace);
    if (existing !== null && !existing.isDirectory()) throw new FileExecutionError("access_denied", MESSAGES.accessDenied);
    if (existing === null) missingEntries += 1;
  }
  return { target, missingEntries };
};

const ensureInternalTrashRoot = async (workspace: WorkspaceSandbox, options: FileExecutorOptions): Promise<string> => {
  const plan = await inspectInternalTrashRoot(workspace, options);
  let current = path.normalize(workspace.root);
  const relative = path.relative(current, plan.target);
  for (const component of relative.split(/[\\/]/u).filter((item) => item.length > 0)) {
    current = path.join(current, component);
    await fsMkdir(current).catch((error: unknown) => {
      if (fsErrorCode(error) !== "EEXIST") throw error;
    });
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new FileExecutionError("outside_workspace", MESSAGES.outsideWorkspace);
    if (!metadata.isDirectory()) throw new FileExecutionError("access_denied", MESSAGES.accessDenied);
  }
  return plan.target;
};

const rollbackInternalTrashRoot = async (workspace: WorkspaceSandbox, plan: InternalTrashPlan): Promise<void> => {
  if (plan.missingEntries === 0) return;
  let current = plan.target;
  for (let index = 0; index < plan.missingEntries; index += 1) {
    await rmdir(current).catch(() => undefined);
    current = path.dirname(current);
  }
  // The workspace itself is never part of the rollback set.
  if (path.normalize(current).toLowerCase() === path.normalize(workspace.root).toLowerCase()) return;
};

const trashFile = async (
  workspace: WorkspaceSandbox,
  request: Extract<FileRequest, { operation: "file.trash" }>,
  signal: AbortSignal | undefined,
  quota: WorkspaceQuota | undefined,
  options: FileExecutorOptions,
): Promise<ExecutionResult> => {
  abortIfRequested(signal);
  const source = await workspace.resolveExisting(request.path);
  assertVisiblePath(workspace, source, options);
  if (isWorkspaceRoot(workspace, source)) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  const sourceParent = await workspace.resolveExisting(path.dirname(request.path));
  const sourceParentMetadata = await lstat(sourceParent);
  if (!sourceParentMetadata.isDirectory() || sourceParentMetadata.isSymbolicLink()) {
    throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  }
  const trashPlan = await inspectInternalTrashRoot(workspace, options);
  const trashRoot = trashPlan.target;
  const trashId = randomUUID();
  const entry = path.join(trashRoot, trashId);
  const payload = path.join(entry, "payload");
  const marker = path.join(entry, "meta.json");
  const markerContents = JSON.stringify({ version: 1, path: path.relative(workspace.root, source) });
  const reservation = quota ? await quota.reserveDelta({ bytes: Buffer.byteLength(markerContents), files: 1, entries: trashPlan.missingEntries + 2 }) : undefined;
  let moved = false;
  let renamed = false;
  try {
    await ensureInternalTrashRoot(workspace, options);
    const trashRootMetadata = await lstat(trashRoot);
    if (!trashRootMetadata.isDirectory() || trashRootMetadata.isSymbolicLink()) {
      throw new FileExecutionError("outside_workspace", MESSAGES.outsideWorkspace);
    }
    await fsMkdir(entry);
    await fsWriteFile(marker, markerContents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    abortIfRequested(signal);
    await options.beforePathUse?.(source);
    await assertStablePath(source, metadata);
    await options.beforePathUse?.(sourceParent);
    await assertStablePath(sourceParent, sourceParentMetadata);
    await assertStablePath(trashRoot, trashRootMetadata);
    await rename(source, payload);
    renamed = true;
    await assertStablePath(payload, metadata);
    await assertStablePath(trashRoot, trashRootMetadata);
    moved = true;
    reservation?.commit();
    return { ok: true, operation: "file.trash", trashId };
  } catch (error) {
    if (renamed && !moved) {
      try {
        await assertStablePath(sourceParent, sourceParentMetadata);
        await assertDestinationAbsent(source);
        await rename(payload, source);
      } catch {
        throw new FileExecutionError("io_error", MESSAGES.ioError);
      }
    }
    throw error;
  } finally {
    if (!moved) {
      reservation?.cancel();
      await rm(entry, { recursive: true, force: true }).catch(() => undefined);
      await rollbackInternalTrashRoot(workspace, trashPlan);
    }
  }
};

const validTrashId = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);

const restoreFile = async (
  workspace: WorkspaceSandbox,
  request: Extract<FileRequest, { operation: "file.restore" }>,
  signal: AbortSignal | undefined,
  quota: WorkspaceQuota | undefined,
  options: FileExecutorOptions,
): Promise<ExecutionResult> => {
  abortIfRequested(signal);
  if (!validTrashId(request.trashId)) throw new FileExecutionError("invalid_request", MESSAGES.invalidRequest);
  const trashRoot = await ensureInternalTrashRoot(workspace, options);
  const entry = path.join(trashRoot, request.trashId);
  const payload = path.join(entry, "payload");
  const marker = path.join(entry, "meta.json");
  const markerMetadata = await lstat(marker);
  if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  const markerHandle = await openVerifiedFile(marker, markerMetadata, options);
  let raw: string;
  try {
    raw = (await markerHandle.readFile()).toString("utf8");
  } finally {
    await markerHandle.close().catch(() => undefined);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new FileExecutionError("invalid_path", MESSAGES.invalidPath); }
  if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1 || typeof (parsed as { path?: unknown }).path !== "string") {
    throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  }
  const storedPath = (parsed as { path: string }).path;
  const destinationRequest = request.path ?? storedPath;
  const destination = await workspace.resolveDestination(destinationRequest);
  assertVisiblePath(workspace, destination, options);
  if (isWorkspaceRoot(workspace, destination)) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  const parent = await assertDestinationParent(workspace, destinationRequest, destination);
  await assertDestinationAbsent(destination);
  const payloadMetadata = await lstat(payload);
  if (payloadMetadata.isSymbolicLink() || (!payloadMetadata.isFile() && !payloadMetadata.isDirectory())) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);

  let moved = false;
  let markerRemoved = false;
  try {
    abortIfRequested(signal);
    await options.beforePathUse?.(payload);
    await assertStablePath(payload, payloadMetadata);
    await options.beforePathUse?.(parent.path);
    await assertStablePath(parent.path, parent.metadata);
    await rename(payload, destination);
    moved = true;
    await assertStablePath(parent.path, parent.metadata);
    await assertStablePath(destination, payloadMetadata);
    await unlink(marker);
    markerRemoved = true;
    await rmdir(entry);
    quota?.markUsageDirty();
    return { ok: true, operation: "file.restore", path: destinationRequest };
  } catch (error) {
    if (moved) {
      try {
        await assertStablePath(parent.path, parent.metadata);
        await rename(destination, payload);
      } catch {
        throw new FileExecutionError("io_error", MESSAGES.ioError);
      }
    }
    if (markerRemoved) {
      try {
        await fsWriteFile(marker, raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch {
        throw new FileExecutionError("io_error", MESSAGES.ioError);
      }
    }
    throw error;
  }
};

const writeFile = async (
  workspace: WorkspaceSandbox,
  request: Extract<FileRequest, { operation: "file.write" }>,
  signal: AbortSignal | undefined,
  quota?: WorkspaceQuota,
  options: FileExecutorOptions = {},
): Promise<ExecutionResult> => {
  const content = contentBuffer(request.content, request.encoding);
  abortIfRequested(signal);
  const destination = await workspace.resolveDestination(request.path);
  assertVisiblePath(workspace, destination, options);
  if (destination === workspace.root) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);

  // Resolve and inspect the parent separately: writes never create parent
  // directories and temporary files must remain inside the sandbox.
  const parentRequestPath = path.dirname(request.path);
  const parent = await workspace.resolveExisting(parentRequestPath);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);
  if (path.dirname(destination) !== parent) throw new FileExecutionError("invalid_path", MESSAGES.invalidPath);

  abortIfRequested(signal);
  const reservation = quota ? await quota.reserve(destination, content.byteLength) : undefined;
  let temporary: Awaited<ReturnType<typeof openUniqueTemporaryFile>> | undefined;
  let handleOpen = false;
  let committed = false;
  try {
    await options.beforePathUse?.(parent);
    await assertStablePath(parent, parentMetadata);
    temporary = await openUniqueTemporaryFile(parent, signal);
    handleOpen = true;
    let written = 0;
    while (written < content.byteLength) {
      abortIfRequested(signal);
      const result = await temporary.handle.write(content, written, content.byteLength - written, written);
      if (result.bytesWritten === 0) throw new FileExecutionError("io_error", MESSAGES.ioError);
      written += result.bytesWritten;
    }
    abortIfRequested(signal);
    await temporary.handle.sync();
    await temporary.handle.close();
    handleOpen = false;
    await assertStablePath(parent, parentMetadata);

    // Re-verify the destination after writing the temporary file. This catches
    // a parent or destination changed to a reparse point before commit.
    const verifiedDestination = await workspace.resolveDestination(request.path);
    if (verifiedDestination !== destination) throw new FileExecutionError("outside_workspace", MESSAGES.outsideWorkspace);
    await assertStablePath(parent, parentMetadata);
    abortIfRequested(signal); // rename is the atomic commit
    await rename(temporary.filename, destination);
    reservation?.commit();
    committed = true;
    try {
      await assertStablePath(parent, parentMetadata);
    } catch (error) {
      quota?.markUsageDirty();
      throw error;
    }
    return { ok: true, operation: "file.write", bytes: content.byteLength };
  } finally {
    if (!committed) reservation?.cancel();
    if (temporary && handleOpen) await temporary.handle.close().catch(() => undefined);
    if (temporary) await unlink(temporary.filename).catch(() => undefined);
  }
};

/** Execute one file request against an already validated workspace. */
export async function executeFileRequest(
  workspace: WorkspaceSandbox,
  request: ExecutionRequest,
  signal?: AbortSignal,
  quota?: WorkspaceQuota,
  options: FileExecutorOptions = {},
): Promise<ExecutionResult> {
  const operation = operationOf(request);
  try {
    switch (request.operation) {
      case "file.read":
        return await readFile(workspace, request, signal, options);
      case "file.list":
        return await listFiles(workspace, request, signal, options);
      case "file.stat":
        return await statFile(workspace, request, signal, options);
      case "file.mkdir":
        return await mkdirFile(workspace, request, signal, quota, options);
      case "file.copy":
        return await copyFileRequest(workspace, request, signal, quota, options);
      case "file.move":
        return await moveFile(workspace, request, signal, options);
      case "file.trash":
        return await trashFile(workspace, request, signal, quota, options);
      case "file.restore":
        return await restoreFile(workspace, request, signal, quota, options);
      case "file.write":
        return await writeFile(workspace, request, signal, quota, options);
      default:
        return { ok: false, operation, code: "unsupported", message: MESSAGES.unsupported };
    }
  } catch (error) {
    return failureFor(operation, error);
  }
}

/** File-only execution backend. Command requests are rejected as unsupported. */
export class LocalFileExecutor implements ExecutionBackend {
  constructor(
    readonly workspace: WorkspaceSandbox,
    private readonly quota?: WorkspaceQuota,
    private readonly options: FileExecutorOptions = {},
  ) {}

  static fromWorkspace(workspace: WorkspaceSandbox, quota?: WorkspaceQuota, options: FileExecutorOptions = {}): LocalFileExecutor {
    return new LocalFileExecutor(workspace, quota, options);
  }

  static async create(root: string): Promise<LocalFileExecutor> {
    return LocalFileExecutor.fromWorkspace(await WorkspaceSandbox.create(root));
  }

  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    if (request.operation === "command.run") {
      return { ok: false, operation: request.operation, code: "unsupported", message: MESSAGES.unsupported };
    }
    return executeFileRequest(this.workspace, request, signal, this.quota, this.options);
  }
}
