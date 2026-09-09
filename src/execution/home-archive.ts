import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { isHomeTrashArchivePath } from "./user-files.js";
import { WorkspaceSandbox } from "./workspace.js";

export const HOME_ARCHIVE_FORMAT = "openbot-home-archive";
export const HOME_ARCHIVE_VERSION = 1;
export const DEFAULT_HOME_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_HOME_ARCHIVE_MAX_ENTRIES = 100_000;

export type HomeArchiveEntryType = "file" | "directory";

export interface HomeArchiveEntry {
  path: string;
  type: HomeArchiveEntryType;
  size: number;
  sha256: string;
  /** Base64 payload for files. Omitted for directories. */
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
  version: typeof HOME_ARCHIVE_VERSION;
  manifest: HomeArchiveManifest;
}

export interface ExportHomeArchiveOptions {
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
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new HomeArchiveError("unsafe_path", "Archive path is invalid.");
  }
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/u.test(value)) {
    throw new HomeArchiveError("unsafe_path", "Archive path must be relative.");
  }
  const components = value.split(/[\\/]/u);
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

async function walkHome(root: string, relativePath = "", entries: HomeArchiveEntry[] = [], limits = { maxBytes: DEFAULT_HOME_ARCHIVE_MAX_BYTES, maxEntries: DEFAULT_HOME_ARCHIVE_MAX_ENTRIES }, total = { value: 0 }): Promise<HomeArchiveEntry[]> {
  const current = relativePath.length === 0 ? root : join(root, ...relativePath.split("/"));
  let children;
  try {
    children = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) throw new HomeArchiveError("not_found", "Home path disappeared while archiving.");
    throw error;
  }
  children.sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    const childPath = relativePath.length === 0 ? child.name : `${relativePath}/${child.name}`;
    const archivePath = validateArchivePath(childPath);
    const absolute = join(current, child.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new HomeArchiveError("unsafe_path", `Home contains a symbolic link: ${archivePath}`);
    if (metadata.isDirectory()) {
      entries.push({ path: archivePath, type: "directory", size: 0, sha256: hash(Buffer.alloc(0)) });
      if (entries.length > limits.maxEntries) throw new HomeArchiveError("invalid_archive", "Home contains too many entries.");
      if (isHomeTrashArchivePath(archivePath)) continue;
      await walkHome(root, archivePath, entries, limits, total);
      continue;
    }
    if (!metadata.isFile()) throw new HomeArchiveError("unsafe_path", `Home contains an unsupported filesystem entry: ${archivePath}`);
    const content = await readFile(absolute);
    total.value += content.byteLength;
    if (total.value > limits.maxBytes) throw new HomeArchiveError("invalid_archive", "Home exceeds the archive size limit.");
    entries.push({ path: archivePath, type: "file", size: content.byteLength, sha256: hash(content), contentBase64: content.toString("base64") });
    if (entries.length > limits.maxEntries) throw new HomeArchiveError("invalid_archive", "Home contains too many entries.");
  }
  return entries;
}

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HomeArchiveError("invalid_archive", "Archive is not valid JSON.");
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Bounded overwrite guard: only a previous home archive may be clobbered. Reads just the file prefix. */
async function isExistingHomeArchive(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").includes(HOME_ARCHIVE_FORMAT);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const decodeBase64 = (value: unknown): Buffer => {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new HomeArchiveError("invalid_archive", "Archive file payload is not valid base64.");
  }
  return Buffer.from(value, "base64");
};

function validateDocument(value: unknown, agentId: string, maxEntries: number, maxBytes: number): HomeArchiveDocument {
  if (!isRecord(value) || value.format !== HOME_ARCHIVE_FORMAT || value.version !== HOME_ARCHIVE_VERSION || !isRecord(value.manifest)) {
    throw new HomeArchiveError("invalid_archive", "Archive format or version is invalid.");
  }
  const manifest = value.manifest;
  if (manifest.agentId !== agentId || typeof manifest.createdAt !== "string" || typeof manifest.exportedAt !== "string" || typeof manifest.layoutVersion !== "number" || !Array.isArray(manifest.entries)) {
    throw new HomeArchiveError("integrity_error", "Archive identity or manifest is invalid.");
  }
  if (manifest.entries.length > maxEntries || manifest.entryCount !== manifest.entries.length || typeof manifest.totalBytes !== "number" || manifest.totalBytes < 0 || manifest.totalBytes > maxBytes) {
    throw new HomeArchiveError("invalid_archive", "Archive manifest limits are invalid.");
  }

  const entries: HomeArchiveEntry[] = [];
  const seen = new Map<string, HomeArchiveEntryType>();
  let totalBytes = 0;
  for (const candidate of manifest.entries) {
    if (!isRecord(candidate) || (candidate.type !== "file" && candidate.type !== "directory") || typeof candidate.size !== "number" || !Number.isSafeInteger(candidate.size) || candidate.size < 0 || typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.sha256)) {
      throw new HomeArchiveError("invalid_archive", "Archive entry is invalid.");
    }
    const path = validateArchivePath(candidate.path);
    if (seen.has(path)) throw new HomeArchiveError("integrity_error", "Archive contains duplicate paths.");
    for (const existing of seen.keys()) {
      if (path.startsWith(`${existing}/`) && seen.get(existing) === "file") throw new HomeArchiveError("integrity_error", "Archive contains a file/directory collision.");
      if (existing.startsWith(`${path}/`) && candidate.type === "file") throw new HomeArchiveError("integrity_error", "Archive contains a file/directory collision.");
    }
    let entry: HomeArchiveEntry;
    if (candidate.type === "file") {
      if (typeof candidate.contentBase64 !== "string") throw new HomeArchiveError("invalid_archive", "Archive file payload is missing.");
      const encoded = candidate.contentBase64;
      const content = decodeBase64(encoded);
      if (content.byteLength !== candidate.size || hash(content) !== candidate.sha256) throw new HomeArchiveError("integrity_error", `Archive hash mismatch for ${path}.`);
      totalBytes += content.byteLength;
      if (totalBytes > maxBytes) throw new HomeArchiveError("invalid_archive", "Archive exceeds the size limit.");
      entry = { path, type: "file", size: candidate.size, sha256: candidate.sha256, contentBase64: encoded };
    } else {
      if (candidate.size !== 0 || candidate.sha256 !== hash(Buffer.alloc(0))) throw new HomeArchiveError("integrity_error", `Directory metadata is invalid for ${path}.`);
      entry = { path, type: "directory", size: 0, sha256: candidate.sha256 };
    }
    seen.set(path, candidate.type);
    entries.push(entry);
  }
  if (totalBytes !== manifest.totalBytes) throw new HomeArchiveError("integrity_error", "Archive total byte count does not match its entries.");
  const homeManifest = entries.find((entry) => entry.path.toLowerCase() === ".openbot/home.json" && entry.type === "file");
  if (!homeManifest?.contentBase64) throw new HomeArchiveError("integrity_error", "Archive is missing .openbot/home.json.");
  let homeMetadata: unknown;
  try {
    homeMetadata = JSON.parse(Buffer.from(homeManifest.contentBase64, "base64").toString("utf8")) as unknown;
  } catch {
    throw new HomeArchiveError("integrity_error", "Archive home manifest is invalid.");
  }
  if (!isRecord(homeMetadata) || homeMetadata.agentId !== agentId || homeMetadata.layoutVersion !== manifest.layoutVersion) {
    throw new HomeArchiveError("integrity_error", "Archive home manifest identity does not match the archive.");
  }
  return {
    format: HOME_ARCHIVE_FORMAT,
    version: HOME_ARCHIVE_VERSION,
    manifest: {
      agentId: manifest.agentId,
      createdAt: manifest.createdAt,
      layoutVersion: manifest.layoutVersion,
      exportedAt: manifest.exportedAt,
      entryCount: manifest.entryCount,
      totalBytes: manifest.totalBytes,
      entries,
    },
  };
}

async function readArchive(path: string, agentId: string, options: ImportHomeArchiveOptions = {}): Promise<HomeArchiveDocument> {
  const maxBytes = options.maxBytes ?? DEFAULT_HOME_ARCHIVE_MAX_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_HOME_ARCHIVE_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new HomeArchiveError("invalid_archive", "Archive limits are invalid.");
  }
  await assertNoLinkInParent(path);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissing(error)) throw new HomeArchiveError("not_found", "Archive does not exist.");
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new HomeArchiveError("unsafe_path", "Archive path is not a regular file.");
  if (metadata.size > maxBytes * 2) throw new HomeArchiveError("invalid_archive", "Archive is too large.");
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > maxBytes * 2) throw new HomeArchiveError("invalid_archive", "Archive is too large.");
  return validateDocument(parseJson(raw), agentId, maxEntries, maxBytes);
}

export async function exportHomeArchive(root: string, agentId: string, destination: string, options: ExportHomeArchiveOptions = {}): Promise<{ path: string; manifest: HomeArchiveManifest }> {
  const maxBytes = options.maxBytes ?? DEFAULT_HOME_ARCHIVE_MAX_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_HOME_ARCHIVE_MAX_ENTRIES;
  const entries = await walkHome(root, "", [], { maxBytes, maxEntries });
  const manifest: HomeArchiveManifest = {
    agentId,
    createdAt: await readCreatedAt(root),
    layoutVersion: await readLayoutVersion(root),
    exportedAt: new Date().toISOString(),
    entryCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    entries,
  };
  const document: HomeArchiveDocument = { format: HOME_ARCHIVE_FORMAT, version: HOME_ARCHIVE_VERSION, manifest };
  const output = resolve(destination);
  if (pathWithin(resolve(root), output)) throw new HomeArchiveError("unsafe_path", "Archive cannot be written inside the home it exports.");
  if (!output.toLowerCase().endsWith(".json")) throw new HomeArchiveError("unsafe_path", "Archive destination must be a .json file.");
  let existing;
  try {
    existing = await lstat(output);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (existing && !options.overwrite) throw new HomeArchiveError("conflict", "Archive destination already exists.");
  if (existing?.isSymbolicLink() || existing && !existing.isFile()) throw new HomeArchiveError("unsafe_path", "Archive destination is not a regular file.");
  if (existing && options.overwrite && !(await isExistingHomeArchive(output))) {
    throw new HomeArchiveError("conflict", "Archive destination exists and is not a home archive; overwrite refused.");
  }
  await mkdir(dirname(output), { recursive: true });
  await assertNoLinkInParent(output);
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { flag: "wx", encoding: "utf8", mode: 0o600 });
    await rename(temporary, output);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return { path: output, manifest };
}

export async function validateHomeArchive(path: string, agentId: string, options: ImportHomeArchiveOptions = {}): Promise<HomeArchiveDocument> {
  return readArchive(path, agentId, options);
}

export async function materializeHomeArchive(document: HomeArchiveDocument, stageRoot: string): Promise<void> {
  await mkdir(stageRoot, { recursive: true });
  const sandbox = await WorkspaceSandbox.create(stageRoot, { allowAncestorLinks: true });
  const entries = [...document.manifest.entries].sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.path.localeCompare(right.path);
  });
  for (const entry of entries) {
    const destination = await sandbox.resolveDestination(entry.path);
    if (entry.type === "directory") {
      await mkdir(destination, { recursive: false });
      await sandbox.resolveExisting(entry.path);
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    await sandbox.resolveDestination(entry.path);
    const content = Buffer.from(entry.contentBase64 ?? "", "base64");
    await writeFile(destination, content, { flag: "wx", mode: 0o600 });
    await sandbox.resolveExisting(entry.path);
  }
}

export async function discardStage(stageRoot: string): Promise<void> {
  const resolved = resolve(stageRoot);
  if (resolved === parse(resolved).root) {
    throw new HomeArchiveError("unsafe_path", "Staging path is invalid.");
  }
  await rm(resolved, { recursive: true, force: true });
}

async function readCreatedAt(root: string): Promise<string> {
  const path = join(root, ".openbot", "home.json");
  try {
    const parsed = parseJson(await readFile(path, "utf8"));
    if (!isRecord(parsed) || typeof parsed.createdAt !== "string") throw new Error();
    return parsed.createdAt;
  } catch (error) {
    if (error instanceof HomeArchiveError) throw error;
    throw new HomeArchiveError("integrity_error", "Home manifest is invalid or missing.");
  }
}

async function readLayoutVersion(root: string): Promise<number> {
  try {
    const parsed = parseJson(await readFile(join(root, ".openbot", "home.json"), "utf8"));
    if (!isRecord(parsed) || typeof parsed.layoutVersion !== "number") throw new Error();
    return parsed.layoutVersion;
  } catch (error) {
    if (error instanceof HomeArchiveError) throw error;
    throw new HomeArchiveError("integrity_error", "Home manifest is invalid or missing.");
  }
}
