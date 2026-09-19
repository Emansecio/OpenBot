import { constants as bufferConstants } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, opendir, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

import { isHomeTrashArchivePath } from "./user-files.js";
import { WorkspaceSandbox } from "./workspace.js";

export const HOME_ARCHIVE_FORMAT = "openbot-home-archive";
export const HOME_ARCHIVE_VERSION = 2;
export const DEFAULT_HOME_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_HOME_ARCHIVE_MAX_ENTRIES = 200_000;
export const HOME_ARCHIVE_MAX_METADATA_BYTES = 64 * 1024 * 1024;
// v1 remains a JSON compatibility reader, bounded by the Node string limit.
export const HOME_ARCHIVE_MAX_LEGACY_BYTES = bufferConstants.MAX_STRING_LENGTH;
export const HOME_ARCHIVE_CHUNK_BYTES = 256 * 1024;
const MAGIC = Buffer.from("OPENBOT-HOME-ARCHIVE\0\x02", "binary");

export type HomeArchiveEntryType = "file" | "directory";

export interface HomeArchiveEntry {
  path: string;
  type: HomeArchiveEntryType;
  size: number;
  sha256: string;
  /** Legacy v1 only. Version 2 manifests never retain file bodies. */
  contentBase64?: string;
}

export interface HomeArchiveManifest {
  agentId: string;
  createdAt: string;
  layoutVersion: number;
  exportedAt: string;
  entryCount: number;
  totalBytes: number;
  entries: HomeArchiveEntry[];
}

export interface HomeArchiveDocument {
  format: typeof HOME_ARCHIVE_FORMAT;
  version: 1 | typeof HOME_ARCHIVE_VERSION;
  manifest: HomeArchiveManifest;
}

export interface ExportHomeArchiveOptions {
  /** Only a validated existing archive may be replaced. Default publication never clobbers. */
  overwrite?: boolean;
  maxBytes?: number;
  maxEntries?: number;
}

export interface ImportHomeArchiveOptions {
  maxBytes?: number;
  maxEntries?: number;
}

export class HomeArchiveError extends Error {
  constructor(
    readonly code: "invalid_archive" | "integrity_error" | "conflict" | "unsafe_path" | "not_found" | "io_error",
    message: string,
  ) {
    super(message);
    this.name = "HomeArchiveError";
  }
}

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

const isMissing = (error: unknown): boolean => errorCode(error) === "ENOENT";

const hash = (content: Buffer): string => createHash("sha256").update(content).digest("hex");
const EMPTY_HASH = hash(Buffer.alloc(0));

const pathWithin = (base: string, target: string): boolean => {
  const fromBase = relative(base, target);
  return fromBase === "" || (fromBase !== ".." && !fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase));
};

async function assertNoLinkInParent(path: string): Promise<void> {
  const parent = dirname(path);
  let metadata;
  try {
    metadata = await lstat(parent);
  } catch (error) {
    if (isMissing(error)) throw new HomeArchiveError("not_found", "Archive parent does not exist.");
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new HomeArchiveError("unsafe_path", "Archive parent is unsafe.");
  // A junction/symlink in an ancestor is also rejected. This keeps an
  // apparently in-root path from redirecting to another volume.
  const canonical = await import("node:fs/promises").then(({ realpath }) => realpath(parent));
  if (resolve(canonical).toLowerCase() !== resolve(parent).toLowerCase()) {
    throw new HomeArchiveError("unsafe_path", "Archive parent contains a symbolic link or junction.");
  }
}

/** Archive paths are portable, relative paths and never Windows aliases. */
export function validateArchivePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 32_768 || value.includes("\0")) {
    throw new HomeArchiveError("unsafe_path", "Archive path is invalid.");
  }
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/u.test(value)) {
    throw new HomeArchiveError("unsafe_path", "Archive path must be relative.");
  }
  const components = value.split(/[\\/]/u);
  if (components.length > 256) throw new HomeArchiveError("unsafe_path", "Archive path is too deep.");
  if (components.some((component) => component.length === 0 || component === "." || component === "..")) {
    throw new HomeArchiveError("unsafe_path", "Archive path contains an unsafe component.");
  }
  for (const component of components) {
    if (/[<>:"|?*\u0000-\u001f]/u.test(component) || /[ .]$/u.test(component)) {
      throw new HomeArchiveError("unsafe_path", "Archive path contains an unsafe component.");
    }
    const stem = component.split(".", 1)[0] ?? "";
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(stem)) {
      throw new HomeArchiveError("unsafe_path", "Archive path contains a reserved device name.");
    }
  }
  return components.join("/");
}

type FileHandle = Awaited<ReturnType<typeof open>>;
const parseJson = (raw: string): unknown => {
  try { return JSON.parse(raw) as unknown; }
  catch { throw new HomeArchiveError("invalid_archive", "Archive is not valid JSON."); }
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function limitsFor(options: ImportHomeArchiveOptions) {
  const maxBytes = options.maxBytes ?? DEFAULT_HOME_ARCHIVE_MAX_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_HOME_ARCHIVE_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new HomeArchiveError("invalid_archive", "Archive limits are invalid.");
  }
  return { maxBytes, maxEntries };
}

async function readExactly(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) throw new HomeArchiveError("integrity_error", "Archive or source file is truncated.");
    offset += bytesRead;
  }
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten === 0) throw new HomeArchiveError("io_error", "Archive write made no progress.");
    offset += bytesWritten;
  }
}

/** Never allocates a buffer proportional to the file size. Handles empty files too. */
async function transfer(handle: FileHandle, position: number, size: number, output?: FileHandle): Promise<string> {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(HOME_ARCHIVE_CHUNK_BYTES, size));
  for (let copied = 0; copied < size;) {
    const chunk = buffer.subarray(0, Math.min(buffer.length, size - copied));
    await readExactly(handle, chunk, position + copied);
    digest.update(chunk);
    if (output) await writeAll(output, chunk);
    copied += chunk.length;
  }
  return digest.digest("hex");
}

async function openRegular(path: string): Promise<FileHandle> {
  const before = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) throw new HomeArchiveError("not_found", "Archive or source file does not exist.");
    throw error;
  });
  if (before.isSymbolicLink() || !before.isFile()) throw new HomeArchiveError("unsafe_path", "Archive or source path is not a regular file.");
  const handle = await open(path, "r");
  try {
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new HomeArchiveError("unsafe_path", "Archive or source path changed while opening.");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// Metadata only. File bodies in v2 are contiguous, in manifest order, after the header.
// The WeakMap keeps the validated source out of RPC responses and serialized manifests.
const sources = new WeakMap<HomeArchiveDocument, { path: string; offset: number; headerHash: string; manifestHash: string }>();

function validateMetadata(value: unknown, agentId: string | undefined, options: ImportHomeArchiveOptions): HomeArchiveDocument {
  const { maxBytes, maxEntries } = limitsFor(options);
  if (!isRecord(value) || value.format !== HOME_ARCHIVE_FORMAT || (value.version !== 1 && value.version !== 2) || !isRecord(value.manifest)) {
    throw new HomeArchiveError("invalid_archive", "Archive format or version is invalid.");
  }
  const manifest = value.manifest;
  if (typeof manifest.agentId !== "string" || (agentId !== undefined && manifest.agentId !== agentId) || typeof manifest.createdAt !== "string" || typeof manifest.exportedAt !== "string" || !Number.isSafeInteger(manifest.layoutVersion) || !Array.isArray(manifest.entries)) {
    throw new HomeArchiveError("integrity_error", "Archive identity or manifest is invalid.");
  }
  if (manifest.entries.length > maxEntries || manifest.entryCount !== manifest.entries.length || !Number.isSafeInteger(manifest.totalBytes) || (manifest.totalBytes as number) < 0 || (manifest.totalBytes as number) > maxBytes) {
    throw new HomeArchiveError("invalid_archive", "Archive manifest limits are invalid.");
  }
  const entries: HomeArchiveEntry[] = [];
  const seen = new Map<string, HomeArchiveEntryType>();
  const parents = new Set<string>();
  let totalBytes = 0;
  for (const candidate of manifest.entries) {
    if (!isRecord(candidate) || (candidate.type !== "file" && candidate.type !== "directory") || typeof candidate.size !== "number" || !Number.isSafeInteger(candidate.size) || candidate.size < 0 || typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.sha256)) {
      throw new HomeArchiveError("invalid_archive", "Archive entry is invalid.");
    }
    const path = validateArchivePath(candidate.path);
    const key = path.toLowerCase(); // Portable archives must not alias on Windows.
    if (seen.has(key)) throw new HomeArchiveError("integrity_error", "Archive contains duplicate paths.");
    if (candidate.type === "file" && parents.has(key)) throw new HomeArchiveError("integrity_error", "Archive contains a file/directory collision.");
    const components = key.split("/");
    components.pop();
    while (components.length > 0) {
      const parent = components.join("/");
      if (seen.get(parent) === "file") throw new HomeArchiveError("integrity_error", "Archive contains a file/directory collision.");
      parents.add(parent);
      components.pop();
    }
    if (candidate.type === "directory" && (candidate.size !== 0 || candidate.sha256 !== EMPTY_HASH)) {
      throw new HomeArchiveError("integrity_error", `Directory metadata is invalid for ${path}.`);
    }
    totalBytes += candidate.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) throw new HomeArchiveError("invalid_archive", "Archive exceeds the size limit.");
    const entry: HomeArchiveEntry = { path, type: candidate.type, size: candidate.size, sha256: candidate.sha256 };
    if (value.version === 1 && entry.type === "file") {
      if (typeof candidate.contentBase64 !== "string") throw new HomeArchiveError("invalid_archive", "Archive file payload is missing.");
      entry.contentBase64 = candidate.contentBase64;
    }
    if (value.version === 2 && candidate.contentBase64 !== undefined) throw new HomeArchiveError("invalid_archive", "Version 2 metadata cannot contain payloads.");
    seen.set(key, entry.type);
    entries.push(entry);
  }
  if (totalBytes !== manifest.totalBytes) throw new HomeArchiveError("integrity_error", "Archive total byte count does not match its entries.");
  const home = entries.find((entry) => entry.path.toLowerCase() === ".openbot/home.json" && entry.type === "file");
  if (!home || home.size > HOME_ARCHIVE_MAX_METADATA_BYTES) throw new HomeArchiveError("integrity_error", "Archive home manifest is missing or too large.");
  return {
    format: HOME_ARCHIVE_FORMAT, version: value.version,
    manifest: { agentId: manifest.agentId, createdAt: manifest.createdAt, exportedAt: manifest.exportedAt, layoutVersion: manifest.layoutVersion as number, entryCount: entries.length, totalBytes, entries },
  };
}

function validateHomeMetadata(content: Buffer, document: HomeArchiveDocument): void {
  const metadata = parseJson(content.toString("utf8"));
  if (!isRecord(metadata) || metadata.agentId !== document.manifest.agentId || metadata.layoutVersion !== document.manifest.layoutVersion) {
    throw new HomeArchiveError("integrity_error", "Archive home manifest identity does not match the archive.");
  }
}

function decodeLegacy(entry: HomeArchiveEntry): Buffer {
  const value = entry.contentBase64;
  // Validate in small blocks: one regexp over a large payload can exhaust the JS stack.
  if (typeof value !== "string" || value.length % 4 !== 0 || value.length !== Math.ceil(entry.size / 3) * 4) {
    throw new HomeArchiveError("integrity_error", "Archive file payload size is invalid.");
  }
  const unpadded = value.replace(/={1,2}$/u, "");
  for (let index = 0; index < unpadded.length; index += HOME_ARCHIVE_CHUNK_BYTES) {
    if (/[^A-Za-z0-9+/]/u.test(unpadded.slice(index, index + HOME_ARCHIVE_CHUNK_BYTES))) throw new HomeArchiveError("invalid_archive", "Archive file payload is not valid base64.");
  }
  const content = Buffer.from(value, "base64");
  if (content.length !== entry.size || hash(content) !== entry.sha256) throw new HomeArchiveError("integrity_error", `Archive hash mismatch for ${entry.path}.`);
  return content;
}

async function readArchiveHeader(path: string, agentId: string | undefined, options: ImportHomeArchiveOptions): Promise<HomeArchiveDocument> {
  const { maxBytes } = limitsFor(options);
  await assertNoLinkInParent(path);
  const handle = await openRegular(path);
  try {
    const metadata = await handle.stat();
    const prefix = Buffer.alloc(MAGIC.length + 4);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    if (bytesRead >= MAGIC.length && prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
      if (bytesRead !== prefix.length) throw new HomeArchiveError("integrity_error", "Archive header is truncated.");
      const length = prefix.readUInt32LE(MAGIC.length);
      if (length === 0 || length > HOME_ARCHIVE_MAX_METADATA_BYTES || length > metadata.size - prefix.length) throw new HomeArchiveError("invalid_archive", "Archive metadata exceeds its limit or is truncated.");
      const header = Buffer.allocUnsafe(length);
      await readExactly(handle, header, prefix.length);
      const document = validateMetadata(parseJson(header.toString("utf8")), agentId, options);
      if (document.version !== 2) throw new HomeArchiveError("invalid_archive", "Archive header version does not match its framing.");
      const offset = prefix.length + length;
      if (!Number.isSafeInteger(offset + document.manifest.totalBytes) || metadata.size - offset !== document.manifest.totalBytes) throw new HomeArchiveError("integrity_error", "Archive payload length does not match its manifest.");
      sources.set(document, { path, offset, headerHash: hash(header), manifestHash: hash(Buffer.from(JSON.stringify(document.manifest))) });
      return document;
    }
    // v1 compatibility deliberately retains JSON parsing; only v2 is bounded
    // independently of payload size. Never exceed Node's supported string size.
    if (metadata.size > Math.min(HOME_ARCHIVE_MAX_LEGACY_BYTES, maxBytes * 2)) throw new HomeArchiveError("invalid_archive", "Legacy JSON archive exceeds the runtime string or archive size limit; use a version 2 archive.");
    const raw = Buffer.allocUnsafe(metadata.size);
    await readExactly(handle, raw, 0);
    const document = validateMetadata(parseJson(raw.toString("utf8")), agentId, options);
    if (document.version !== 1) throw new HomeArchiveError("invalid_archive", "Version 2 archives require binary framing.");
    return document;
  } finally {
    await handle.close();
  }
}

/** Reads bounded metadata only for v2. Listing is not an integrity verification. */
export async function readHomeArchiveSummary(path: string, agentId: string): Promise<Omit<HomeArchiveManifest, "entries">> {
  const { entries: _entries, ...summary } = (await readArchiveHeader(path, agentId, {})).manifest;
  return summary;
}

/** Checks all payload hashes, optionally writing into a private, unpublished stage. */
async function consumeArchive(document: HomeArchiveDocument, stageRoot?: string): Promise<void> {
  // Do not trust a caller-mutated manifest between validation and materialization.
  const checked = validateMetadata(document, document.manifest.agentId, { maxBytes: Number.MAX_SAFE_INTEGER, maxEntries: Math.max(1, document.manifest.entries.length) });
  const source = sources.get(document);
  let handle: FileHandle | undefined;
  try {
    let position = source?.offset ?? 0;
    if (document.version === 2) {
      if (!source) throw new HomeArchiveError("invalid_archive", "Version 2 materialization requires a validated archive source.");
      if (hash(Buffer.from(JSON.stringify(checked.manifest))) !== source.manifestHash) throw new HomeArchiveError("integrity_error", "Archive metadata changed after validation.");
      await assertNoLinkInParent(source.path);
      handle = await openRegular(source.path);
      // Check framing and metadata on the same descriptor used for the bodies.
      const prefix = Buffer.alloc(MAGIC.length + 4);
      await readExactly(handle, prefix, 0);
      const length = source.offset - prefix.length;
      if (!prefix.subarray(0, MAGIC.length).equals(MAGIC) || prefix.readUInt32LE(MAGIC.length) !== length) throw new HomeArchiveError("integrity_error", "Archive framing changed after validation.");
      const header = Buffer.allocUnsafe(length);
      await readExactly(handle, header, prefix.length);
      if (hash(header) !== source.headerHash || (await handle.stat()).size !== source.offset + checked.manifest.totalBytes) throw new HomeArchiveError("integrity_error", "Archive changed after validation.");
    }
    let sandbox: WorkspaceSandbox | undefined;
    if (stageRoot !== undefined) {
      await mkdir(stageRoot); // Exclusive ownership. Never materialize over existing state.
      sandbox = await WorkspaceSandbox.create(stageRoot, { allowAncestorLinks: true });
      for (const entry of checked.manifest.entries.filter((entry) => entry.type === "directory").sort((a, b) => a.path.split("/").length - b.path.split("/").length)) {
        const destination = await sandbox.resolveDestination(entry.path);
        await mkdir(destination, { recursive: true });
      }
    }
    for (const entry of checked.manifest.entries) {
      if (entry.type === "directory") continue;
      let output: FileHandle | undefined;
      try {
        if (sandbox) {
          const destination = await sandbox.resolveDestination(entry.path);
          await mkdir(dirname(destination), { recursive: true });
          await sandbox.resolveDestination(entry.path);
          output = await open(destination, "wx", 0o600);
        }
        if (handle) {
          const digest = await transfer(handle, position, entry.size, output);
          if (digest !== entry.sha256) throw new HomeArchiveError("integrity_error", `Archive hash mismatch for ${entry.path}.`);
          if (entry.path.toLowerCase() === ".openbot/home.json") {
            const content = Buffer.allocUnsafe(entry.size);
            await readExactly(handle, content, position);
            validateHomeMetadata(content, checked);
          }
          position += entry.size;
        } else {
          const content = decodeLegacy(entry);
          if (entry.path.toLowerCase() === ".openbot/home.json") validateHomeMetadata(content, checked);
          if (output) await writeAll(output, content);
        }
        if (output) await output.sync();
      } finally {
        await output?.close();
      }
    }
  } finally {
    await handle?.close();
  }
}

export async function validateHomeArchive(path: string, agentId: string, options: ImportHomeArchiveOptions = {}): Promise<HomeArchiveDocument> {
  const document = await readArchiveHeader(resolve(path), agentId, options);
  await consumeArchive(document);
  return document;
}

export async function materializeHomeArchive(document: HomeArchiveDocument, stageRoot: string): Promise<void> {
  await consumeArchive(document, stageRoot);
}

/** One payload pass: all validation completes in staging before the caller publishes it. */
export async function stageHomeArchive(path: string, agentId: string, stageRoot: string, options: ImportHomeArchiveOptions = {}): Promise<void> {
  await consumeArchive(await readArchiveHeader(resolve(path), agentId, options), stageRoot);
}

export async function exportHomeArchive(root: string, agentId: string, destination: string, options: ExportHomeArchiveOptions = {}): Promise<{ path: string; manifest: HomeArchiveManifest }> {
  const limits = limitsFor(options);
  const output = resolve(destination);
  if (pathWithin(resolve(root), output)) throw new HomeArchiveError("unsafe_path", "Archive cannot be written inside the home it exports.");
  if (!/\.(?:json|obhome)$/iu.test(output)) throw new HomeArchiveError("unsafe_path", "Archive destination must be a .obhome or .json file.");
  const existing = await lstat(output).catch((error: unknown) => { if (isMissing(error)) return undefined; throw error; });
  if (existing && !options.overwrite) throw new HomeArchiveError("conflict", "Archive destination already exists.");
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw new HomeArchiveError("unsafe_path", "Archive destination is not a regular file.");
    try { await consumeArchive(await readArchiveHeader(output, undefined, options)); }
    catch { throw new HomeArchiveError("conflict", "Archive destination is not a valid home archive; overwrite refused."); }
  }
  await mkdir(dirname(output), { recursive: true });
  await assertNoLinkInParent(output);
  const sandbox = await WorkspaceSandbox.create(root, { allowAncestorLinks: true });
  const manifestPath = await sandbox.resolveExisting(".openbot/home.json");
  const homeHandle = await openRegular(manifestPath);
  let homeMetadata: unknown;
  try {
    const size = (await homeHandle.stat()).size;
    if (size > HOME_ARCHIVE_MAX_METADATA_BYTES) throw new HomeArchiveError("invalid_archive", "Home manifest is too large.");
    const content = Buffer.allocUnsafe(size);
    await readExactly(homeHandle, content, 0);
    homeMetadata = parseJson(content.toString("utf8"));
  } finally { await homeHandle.close(); }
  if (!isRecord(homeMetadata) || homeMetadata.agentId !== agentId || typeof homeMetadata.createdAt !== "string" || !Number.isSafeInteger(homeMetadata.layoutVersion)) throw new HomeArchiveError("integrity_error", "Home manifest identity is invalid.");
  const entries: HomeArchiveEntry[] = [];
  const pending = [""];
  let totalBytes = 0;
  let metadataBytes = 4096;
  // opendir keeps an oversized directory from being loaded before the entry cap.
  while (pending.length > 0) {
    const parent = pending.pop()!;
    const directory = parent === "" ? sandbox.root : await sandbox.resolveExisting(parent);
    const children = await opendir(directory);
    for await (const child of children) {
      if (entries.length >= limits.maxEntries) throw new HomeArchiveError("invalid_archive", "Home contains too many entries.");
      const path = validateArchivePath(parent === "" ? child.name : `${parent}/${child.name}`);
      const absolute = await sandbox.resolveExisting(path);
      const metadata = await lstat(absolute);
      let entry: HomeArchiveEntry;
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        entry = { path, type: "directory", size: 0, sha256: EMPTY_HASH };
        if (!isHomeTrashArchivePath(path)) pending.push(path);
      } else {
        const handle = await openRegular(absolute);
        try {
          const before = await handle.stat();
          totalBytes += before.size;
          if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxBytes) throw new HomeArchiveError("invalid_archive", "Home exceeds the archive size limit.");
          const sha256 = await transfer(handle, 0, before.size);
          const after = await handle.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new HomeArchiveError("conflict", "Home file changed while archiving.");
          entry = { path, type: "file", size: before.size, sha256 };
        } finally { await handle.close(); }
      }
      metadataBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (metadataBytes > HOME_ARCHIVE_MAX_METADATA_BYTES) throw new HomeArchiveError("invalid_archive", "Archive metadata exceeds its limit.");
      entries.push(entry);
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const manifest: HomeArchiveManifest = { agentId, createdAt: homeMetadata.createdAt, layoutVersion: homeMetadata.layoutVersion as number, exportedAt: new Date().toISOString(), entryCount: entries.length, totalBytes, entries };
  const document = validateMetadata({ format: HOME_ARCHIVE_FORMAT, version: HOME_ARCHIVE_VERSION, manifest }, agentId, options);
  const header = Buffer.from(JSON.stringify(document));
  if (header.length > HOME_ARCHIVE_MAX_METADATA_BYTES) throw new HomeArchiveError("invalid_archive", "Archive metadata exceeds its limit.");
  const prefix = Buffer.alloc(MAGIC.length + 4);
  MAGIC.copy(prefix);
  prefix.writeUInt32LE(header.length, MAGIC.length);
  const temporary = `${output}.${randomUUID()}.tmp`;
  let writer: FileHandle | undefined;
  try {
    writer = await open(temporary, "wx", 0o600);
    await writeAll(writer, prefix);
    await writeAll(writer, header);
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      const source = await openRegular(await sandbox.resolveExisting(entry.path));
      try {
        if ((await source.stat()).size !== entry.size || await transfer(source, 0, entry.size, writer) !== entry.sha256 || (await source.stat()).size !== entry.size) throw new HomeArchiveError("conflict", "Home file changed while archiving.");
      } finally { await source.close(); }
    }
    await writer.sync();
    await writer.close();
    writer = undefined;
    await validateHomeArchive(temporary, agentId, options);
    await assertNoLinkInParent(output);
    if (existing) {
      const current = await lstat(output);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== existing.dev || current.ino !== existing.ino || current.size !== existing.size || current.mtimeMs !== existing.mtimeMs || current.ctimeMs !== existing.ctimeMs) {
        throw new HomeArchiveError("conflict", "Archive destination changed while exporting.");
      }
      // Explicit overwrite only. The gateway fence cannot lock external same-user writers.
      await rename(temporary, output);
    } else {
      // Atomic no-clobber publication, including a destination created during export.
      await link(temporary, output).catch((error: unknown) => {
        if (errorCode(error) === "EEXIST") throw new HomeArchiveError("conflict", "Archive destination already exists; choose a new filename.");
        throw error;
      });
    }
  } finally {
    await writer?.close();
    await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw error; });
  }
  return { path: output, manifest };
}

export async function discardStage(stageRoot: string): Promise<void> {
  const resolved = resolve(stageRoot);
  if (resolved === parse(resolved).root) throw new HomeArchiveError("unsafe_path", "Staging path is invalid.");
  await rm(resolved, { recursive: true, force: true });
}
