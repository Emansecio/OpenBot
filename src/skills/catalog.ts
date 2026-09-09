import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { open as openAsync, lstat as lstatAsync, realpath as realpathAsync } from "node:fs/promises";
import { TextDecoder } from "node:util";
import {
  isAbsolute,
  join,
  normalize,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  DEFAULT_SKILL_CATALOG_LIMITS,
  type SkillCatalogLimits,
  type SkillCatalogOptions,
  type SkillInvocationPolicy,
  type SkillReadResult,
  type SkillRoot,
  type SkillSummary,
} from "./contracts.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const TOP_LEVEL_KEYS = new Set([
  "name",
  "description",
  "id",
  "license",
  "metadata",
  "allowed-tools",
  "allowed_tools",
  "disable-model-invocation",
  "disable_model_invocation",
  "user-invocable",
  "user_invocable",
  "auto-select",
  "auto_select",
  "triggers",
  "argument-hint",
  "argument_hint",
  "when-to-use",
  "when_to_use",
  "compatibility",
]);
const FRONTMATTER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  allowed_tools: "allowed-tools",
  disable_model_invocation: "disable-model-invocation",
  user_invocable: "user-invocable",
  auto_select: "auto-select",
  argument_hint: "argument-hint",
  when_to_use: "when-to-use",
});
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

interface ValidatedRoot {
  readonly config: SkillRoot;
  readonly absolutePath: string;
  readonly realPath: string;
}

interface ParsedSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly invocation: SkillInvocationPolicy;
}

interface FileSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface CachedSkill {
  readonly parsed: ParsedSkill;
  readonly snapshot: FileSnapshot;
}

interface SkillRecord extends SkillSummary {
  readonly absoluteFilePath: string;
  readonly rootRealPath: string;
  readonly invocation: SkillInvocationPolicy;
}

export class InvalidSkillError extends Error {
  public constructor(message = "invalid skill") {
    super(message);
    this.name = "InvalidSkillError";
  }
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function comparablePath(value: string): string {
  const normalized = normalize(value);
  const root = parsePath(normalized).root;
  const withoutTrailingSeparator = normalized === root ? normalized : normalized.replace(/[\\/]$/, "");
  return isWindows() ? withoutTrailingSeparator.toLowerCase() : withoutTrailingSeparator;
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function containedBy(rootPath: string, candidatePath: string): boolean {
  const root = comparablePath(rootPath);
  const candidate = comparablePath(candidatePath);
  const remainder = relative(root, candidate);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function pathComponents(absolutePath: string): string[] {
  const normalized = normalize(absolutePath);
  const parsed = parsePath(normalized);
  const remainder = normalized.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean);
  const components: string[] = parsed.root ? [parsed.root] : [];
  let current = parsed.root;
  for (const component of remainder) {
    current = join(current, component);
    components.push(current);
  }
  return components;
}

function isReparsePoint(stats: Stats): boolean {
  const candidate = stats as Stats & { isReparsePoint?: () => boolean };
  return typeof candidate.isReparsePoint === "function" && candidate.isReparsePoint();
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  // dev/ino are the stable descriptor identity on POSIX and are populated by
  // current Node Windows builds. Keep the remaining fields as a conservative
  // fallback for filesystems that report zero identity values.
  return sameSnapshot(fileSnapshot(left), fileSnapshot(right));
}

function fileSnapshot(stats: Stats): FileSnapshot {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  const sameIdentity = (left.dev === 0 || right.dev === 0 || left.dev === right.dev) &&
    (left.ino === 0 || right.ino === 0 || left.ino === right.ino);
  return sameIdentity &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

/**
 * Checks every existing component. Comparing realpath with the lexical path
 * catches Windows junctions/reparse points as well as POSIX symlinks; lstat is
 * retained so a direct symlink is rejected even when realpath is unavailable.
 */
function assertNoLinkComponents(absolutePath: string): string {
  let lastRealPath = "";
  for (const component of pathComponents(absolutePath)) {
    let stats: Stats;
    try {
      stats = lstatSync(component);
      lastRealPath = realpathSync.native(component);
    } catch {
      throw new InvalidSkillError("skill path is unavailable");
    }
    if (stats.isSymbolicLink() || isReparsePoint(stats) || !samePath(lastRealPath, component)) {
      throw new InvalidSkillError("skill path contains a symlink, junction, or reparse point");
    }
  }
  return lastRealPath;
}

function normalizeId(value: string): string | undefined {
  if (!ID_PATTERN.test(value)) return undefined;
  return value.toLowerCase();
}

function validateSource(value: string): string {
  if (!SOURCE_PATTERN.test(value)) throw new TypeError("skill source must be a short label");
  return value;
}

function positiveInteger(value: number, key: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`invalid ${key}`);
  return value;
}

function mergeLimits(overrides: Partial<SkillCatalogLimits> | undefined): SkillCatalogLimits {
  const limits = { ...DEFAULT_SKILL_CATALOG_LIMITS, ...(overrides ?? {}) };
  positiveInteger(limits.maxSkillBytes, "maxSkillBytes");
  positiveInteger(limits.maxFrontmatterBytes, "maxFrontmatterBytes");
  positiveInteger(limits.maxCandidates, "maxCandidates");
  positiveInteger(limits.maxRoots, "maxRoots");
  positiveInteger(limits.maxNameCharacters, "maxNameCharacters");
  positiveInteger(limits.maxDescriptionCharacters, "maxDescriptionCharacters");
  positiveInteger(limits.maxTriggerCharacters, "maxTriggerCharacters");
  positiveInteger(limits.maxTriggers, "maxTriggers");
  // A caller may lower only the complete-file limit. Clamp the header limit so
  // the smaller safety budget remains usable without an unsafe widening.
  if (limits.maxFrontmatterBytes > limits.maxSkillBytes) limits.maxFrontmatterBytes = limits.maxSkillBytes;
  return limits;
}

function parseQuotedString(rawValue: string): string | undefined {
  if (rawValue.length < 2) return undefined;
  const first = rawValue[0];
  const last = rawValue.at(-1);
  if (first === '"' && last === '"') {
    try {
      const parsed: unknown = JSON.parse(rawValue);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (first === "'" && last === "'") {
    return rawValue.slice(1, -1).replace(/''/gu, "'");
  }
  return undefined;
}

function parseScalar(rawValue: string): string | boolean | undefined {
  const raw = rawValue.trim();
  if (!raw) return undefined;
  const quoted = parseQuotedString(raw);
  if (quoted !== undefined) return quoted;
  if (raw.startsWith('"') || raw.startsWith("'") || raw.endsWith('"') || raw.endsWith("'")) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith("[") || raw.endsWith("]")) return undefined;
  if (raw.startsWith("{") || raw.endsWith("}")) return undefined;
  if (CONTROL_CHARACTERS.test(raw)) return undefined;
  return raw;
}

function splitList(rawValue: string): string[] | undefined {
  const raw = rawValue.trim();
  if (!raw.startsWith("[") || !raw.endsWith("]")) return undefined;
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];
  const values: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if ((character === '"' || character === "'") && (quote === undefined || quote === character)) {
      quote = quote === undefined ? character : undefined;
      current += character;
      continue;
    }
    if (character === "," && quote === undefined) {
      const value = parseScalar(current);
      if (typeof value !== "string" || !value) return undefined;
      values.push(value);
      current = "";
      continue;
    }
    current += character;
  }
  if (quote !== undefined) return undefined;
  const value = parseScalar(current);
  if (typeof value !== "string" || !value) return undefined;
  values.push(value);
  return values;
}

const BLOCK_SCALAR_MARKERS = new Set([">", ">-", "|", "|-"]);

function consumeBlockScalar(lines: readonly string[], startIndex: number, marker: string): { value: string; nextIndex: number } {
  const folded = marker.startsWith(">");
  const stripTrailing = marker.endsWith("-");
  const collected: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      collected.push("");
      index += 1;
      continue;
    }
    if (!/^\s/u.test(line)) break;
    collected.push(line);
    index += 1;
  }
  const nonBlank = collected.filter((line) => line.trim().length > 0);
  const minIndent = nonBlank.length === 0
    ? 0
    : Math.min(...nonBlank.map((line) => line.match(/^\s*/u)?.[0].length ?? 0));
  const stripped = collected.map((line) => (line.trim() === "" ? "" : line.slice(minIndent).trimEnd()));
  let value: string;
  if (folded) {
    const parts: string[] = [];
    let buffer = "";
    for (const line of stripped) {
      if (line === "") {
        if (buffer) {
          parts.push(buffer);
          buffer = "";
        }
        parts.push("\n");
      } else {
        buffer = buffer ? `${buffer} ${line}` : line;
      }
    }
    if (buffer) parts.push(buffer);
    value = parts.join("");
  } else {
    value = stripped.join("\n");
  }
  if (stripTrailing) value = value.replace(/\n+$/u, "");
  return { value, nextIndex: index };
}

function parseFrontmatter(frontmatter: string, expectedId: string, limits: SkillCatalogLimits): {
  name: string;
  description: string;
  invocation: SkillInvocationPolicy;
} {
  const lines = frontmatter.split(/\r?\n/u);
  const values = new Map<string, string | boolean | string[] | undefined>();
  let nestedMetadata = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    if (/^\s/u.test(line)) {
      if (!nestedMetadata || !/^ {2}[A-Za-z][A-Za-z0-9_-]{0,63}:\s*/u.test(line)) {
        throw new InvalidSkillError("invalid frontmatter indentation");
      }
      const nested = /^ {2}([A-Za-z][A-Za-z0-9_-]{0,63}):\s*(.*)$/u.exec(line);
      if (!nested) throw new InvalidSkillError("invalid metadata field");
      const nestedValue = parseScalar(nested[2] ?? "");
      if (nestedValue === undefined || typeof nestedValue !== "string") {
        throw new InvalidSkillError("metadata values must be simple strings");
      }
      continue;
    }
    nestedMetadata = false;
    const match = /^([A-Za-z][A-Za-z0-9_-]{0,63}):(?:[ \t]*(.*))?$/u.exec(line);
    if (!match) throw new InvalidSkillError("invalid frontmatter field");
    const key = match[1] ?? "";
    const rawValue = match[2] ?? "";
    const canonicalKey = FRONTMATTER_ALIASES[key] ?? key;
    if (!TOP_LEVEL_KEYS.has(key) || values.has(canonicalKey)) {
      throw new InvalidSkillError("unknown or duplicate frontmatter field");
    }
    if (canonicalKey === "metadata") {
      if (rawValue.trim()) throw new InvalidSkillError("metadata must use simple nested fields");
      nestedMetadata = true;
      values.set(canonicalKey, undefined);
      continue;
    }
    const trimmedRaw = rawValue.trim();
    if (BLOCK_SCALAR_MARKERS.has(trimmedRaw)) {
      const block = consumeBlockScalar(lines, index + 1, trimmedRaw);
      if (CONTROL_CHARACTERS.test(block.value)) throw new InvalidSkillError("frontmatter metadata contains control characters");
      values.set(canonicalKey, block.value);
      index = block.nextIndex - 1;
      continue;
    }
    if (canonicalKey === "triggers") {
      const list = splitList(rawValue);
      if (list !== undefined) values.set(canonicalKey, list);
      else {
        const scalar = parseScalar(rawValue);
        if (typeof scalar !== "string" || !scalar) throw new InvalidSkillError("invalid triggers");
        values.set(canonicalKey, [scalar]);
      }
      continue;
    }
    const scalar = parseScalar(rawValue);
    if (scalar === undefined) throw new InvalidSkillError("invalid frontmatter value");
    values.set(canonicalKey, scalar);
  }

  const name = values.get("name");
  const description = values.get("description");
  if (typeof name !== "string" || !name.trim() || typeof description !== "string" || !description.trim()) {
    throw new InvalidSkillError("name and description are required");
  }
  if (name.length > limits.maxNameCharacters || description.length > limits.maxDescriptionCharacters) {
    throw new InvalidSkillError("frontmatter metadata exceeds its limit");
  }
  if (CONTROL_CHARACTERS.test(name) || CONTROL_CHARACTERS.test(description)) {
    throw new InvalidSkillError("frontmatter metadata contains control characters");
  }
  const declaredId = values.get("id");
  if (declaredId !== undefined && (typeof declaredId !== "string" || normalizeId(declaredId) !== expectedId)) {
    throw new InvalidSkillError("frontmatter id does not match the directory");
  }

  const disabledForModel = values.get("disable-model-invocation");
  const userInvocable = values.get("user-invocable");
  const autoSelect = values.get("auto-select");
  for (const value of [disabledForModel, userInvocable, autoSelect]) {
    if (value !== undefined && typeof value !== "boolean") throw new InvalidSkillError("invocation flag must be boolean");
  }
  const triggerValue = values.get("triggers");
  const triggers = Array.isArray(triggerValue) ? triggerValue : [];
  if (triggers.length > limits.maxTriggers || triggers.some((trigger) => trigger.length > limits.maxTriggerCharacters)) {
    throw new InvalidSkillError("invocation triggers exceed their limit");
  }
  const argumentHint = values.get("argument-hint");
  if (argumentHint !== undefined && (typeof argumentHint !== "string" || argumentHint.length > limits.maxTriggerCharacters)) {
    throw new InvalidSkillError("argument hint exceeds its limit");
  }

  return {
    name: name.trim(),
    description: description.trim(),
    invocation: {
      modelInvocable: disabledForModel !== true,
      userInvocable: userInvocable !== false,
      autoSelect: autoSelect !== false && disabledForModel !== true,
      triggers: Object.freeze([...triggers]),
      ...(typeof argumentHint === "string" ? { argumentHint: argumentHint.trim() } : {}),
    },
  };
}

function parseSkillText(text: string, id: string, limits: SkillCatalogLimits, byteLength: number): ParsedSkill {
  const firstBreak = text.indexOf("\n");
  if (firstBreak < 0 || text.slice(0, firstBreak).replace(/\r$/u, "") !== "---") {
    throw new InvalidSkillError("frontmatter opening marker is required");
  }
  let cursor = firstBreak + 1;
  let closeStart = -1;
  let bodyStart = -1;
  while (cursor <= text.length) {
    const lineEnd = text.indexOf("\n", cursor);
    const end = lineEnd < 0 ? text.length : lineEnd;
    const rawLine = text.slice(cursor, end);
    const line = rawLine.replace(/\r$/u, "");
    if (line === "---" || line === "...") {
      closeStart = cursor;
      bodyStart = lineEnd < 0 ? text.length : lineEnd + 1;
      break;
    }
    if (lineEnd < 0) break;
    cursor = lineEnd + 1;
  }
  if (closeStart < 0 || bodyStart < 0) throw new InvalidSkillError("frontmatter closing marker is required");
  const frontmatter = text.slice(firstBreak + 1, closeStart);
  if (Buffer.byteLength(text.slice(0, bodyStart), "utf8") > limits.maxFrontmatterBytes) {
    throw new InvalidSkillError("frontmatter exceeds its byte limit");
  }
  const parsed = parseFrontmatter(frontmatter, id, limits);
  if (byteLength > limits.maxSkillBytes) throw new InvalidSkillError("skill exceeds its byte limit");
  return {
    id,
    name: parsed.name,
    description: parsed.description,
    content: text.slice(bodyStart),
    invocation: parsed.invocation,
  };
}

function finishValidatedSkill(
  bytes: Buffer,
  id: string,
  limits: SkillCatalogLimits,
  finalSnapshot: ReturnType<typeof fileSnapshot>,
  before: string,
  root: ValidatedRoot,
  filePath: string,
): CachedSkill {
  if (bytes.byteLength > limits.maxSkillBytes) throw new InvalidSkillError("skill exceeds its byte limit");
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw new InvalidSkillError("skill is not valid UTF-8");
  }
  const after = assertNoLinkComponents(filePath);
  if (!samePath(before, after) || !containedBy(root.realPath, after)) throw new InvalidSkillError("skill path changed during read");
  return {
    parsed: parseSkillText(text, id, limits, bytes.byteLength),
    snapshot: finalSnapshot,
  };
}

function readValidatedSkill(
  root: ValidatedRoot,
  filePath: string,
  id: string,
  limits: SkillCatalogLimits,
  cached?: CachedSkill,
): CachedSkill {
  const before = assertNoLinkComponents(filePath);
  if (!containedBy(root.realPath, before)) throw new InvalidSkillError("skill path escapes its root");
  const pathStats = lstatSync(filePath);
  if (pathStats.isSymbolicLink() || isReparsePoint(pathStats) || !pathStats.isFile()) {
    throw new InvalidSkillError("SKILL.md is not a regular file");
  }
  if (pathStats.size > limits.maxSkillBytes) throw new InvalidSkillError("skill exceeds its byte limit");
  const currentSnapshot = fileSnapshot(pathStats);
  if (cached !== undefined && sameSnapshot(currentSnapshot, cached.snapshot)) return cached;
  let descriptor = -1;
  let finalSnapshot = currentSnapshot;
  let bytes: Buffer;
  try {
    // Opening once and consuming that descriptor closes the path-replacement
    // window present in readFileSync(path). O_NOFOLLOW is available on POSIX;
    // realpath/lstat checks below provide the Windows equivalent we can make
    // without native handle APIs.
    const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    descriptor = openSync(filePath, constants.O_RDONLY | noFollow);
    const descriptorStats = fstatSync(descriptor);
    if (!descriptorStats.isFile() || descriptorStats.size > limits.maxSkillBytes) {
      throw new InvalidSkillError("SKILL.md is not a bounded regular file");
    }
    const afterOpen = assertNoLinkComponents(filePath);
    const afterOpenStats = lstatSync(filePath);
    if (!samePath(before, afterOpen) || !sameFileSnapshot(descriptorStats, afterOpenStats)) {
      throw new InvalidSkillError("skill path changed during open");
    }
    bytes = readFileSync(descriptor);
    const afterRead = assertNoLinkComponents(filePath);
    const afterReadStats = lstatSync(filePath);
    if (!samePath(before, afterRead) || !sameFileSnapshot(descriptorStats, afterReadStats)) {
      throw new InvalidSkillError("skill path changed during read");
    }
    finalSnapshot = fileSnapshot(descriptorStats);
  } catch {
    if (descriptor >= 0) {
      try {
        closeSync(descriptor);
      } catch {
        // The original read/validation failure is the useful result.
      }
    }
    throw new InvalidSkillError("skill cannot be read");
  }
  try {
    closeSync(descriptor);
  } catch {
    throw new InvalidSkillError("skill descriptor cannot be closed");
  }
  return finishValidatedSkill(bytes, id, limits, finalSnapshot, before, root, filePath);
}

async function readValidatedSkillAsync(
  root: ValidatedRoot,
  filePath: string,
  id: string,
  limits: SkillCatalogLimits,
  cached?: CachedSkill,
): Promise<CachedSkill> {
  const before = assertNoLinkComponents(filePath);
  if (!containedBy(root.realPath, before)) throw new InvalidSkillError("skill path escapes its root");
  const pathStats = await lstatAsync(filePath);
  if (pathStats.isSymbolicLink() || isReparsePoint(pathStats) || !pathStats.isFile()) {
    throw new InvalidSkillError("SKILL.md is not a regular file");
  }
  if (pathStats.size > limits.maxSkillBytes) throw new InvalidSkillError("skill exceeds its byte limit");
  const currentSnapshot = fileSnapshot(pathStats);
  if (cached !== undefined && sameSnapshot(currentSnapshot, cached.snapshot)) return cached;
  const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let handle: Awaited<ReturnType<typeof openAsync>> | undefined;
  let finalSnapshot = currentSnapshot;
  let bytes: Buffer;
  try {
    handle = await openAsync(filePath, constants.O_RDONLY | noFollow);
    const descriptorStats = await handle.stat();
    if (!descriptorStats.isFile() || descriptorStats.size > limits.maxSkillBytes) {
      throw new InvalidSkillError("SKILL.md is not a bounded regular file");
    }
    const afterOpen = assertNoLinkComponents(filePath);
    const afterOpenStats = await lstatAsync(filePath);
    if (!samePath(before, afterOpen) || !sameFileSnapshot(descriptorStats, afterOpenStats)) {
      throw new InvalidSkillError("skill path changed during open");
    }
    bytes = await handle.readFile();
    const afterRead = assertNoLinkComponents(filePath);
    const afterReadStats = await lstatAsync(filePath);
    if (!samePath(before, afterRead) || !sameFileSnapshot(descriptorStats, afterReadStats)) {
      throw new InvalidSkillError("skill path changed during read");
    }
    finalSnapshot = fileSnapshot(descriptorStats);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // The original read/validation failure is the useful result.
    }
    if (error instanceof InvalidSkillError) throw error;
    throw new InvalidSkillError("skill cannot be read");
  }
  try {
    await handle.close();
  } catch {
    throw new InvalidSkillError("skill descriptor cannot be closed");
  }
  return finishValidatedSkill(bytes, id, limits, finalSnapshot, before, root, filePath);
}

function validateRoot(config: SkillRoot): ValidatedRoot {
  if (!config || typeof config.path !== "string" || !config.path.trim()) throw new TypeError("skill root path is required");
  if (typeof config.source !== "string") throw new TypeError("skill root source is required");
  const source = validateSource(config.source);
  const absolutePath = resolve(config.path);
  const realPath = assertNoLinkComponents(absolutePath);
  const stats = lstatSync(absolutePath);
  if (!stats.isDirectory()) throw new TypeError("skill root must be a directory");
  return { config: { path: config.path, source }, absolutePath, realPath };
}

/** Validates one explicitly supplied root without scanning its skill entries. */
export function validateSkillRoot(config: SkillRoot): SkillRoot {
  return validateRoot(config).config;
}

/** Fail-closed validation for a complete SKILL.md document before writing. */
export function validateSkillDocument(
  text: string,
  id: string,
  limits?: Partial<SkillCatalogLimits>,
): { name: string; description: string } {
  const merged = mergeLimits(limits);
  const normalized = normalizeId(id);
  if (normalized === undefined) throw new InvalidSkillError("invalid skill id");
  const parsed = parseSkillText(text, normalized, merged, Buffer.byteLength(text, "utf8"));
  return { name: parsed.name, description: parsed.description };
}

function summary(record: SkillRecord): SkillSummary {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    source: record.source,
  };
}

const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "de", "do", "da", "e", "em", "for", "in", "me", "my",
  "o", "of", "on", "or", "para", "por", "the", "this", "to", "um", "uma", "with",
]);

function searchText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase();
}

function searchTokens(value: string): string[] {
  return [...new Set(searchText(value).split(/[^a-z0-9]+/u).filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token)))];
}

function searchScore(record: SkillRecord, query: string): number {
  const normalizedQuery = searchText(query).trim();
  if (!normalizedQuery) return 1;
  const id = searchText(record.id);
  const name = searchText(record.name);
  const description = searchText(record.description);
  const triggers = record.invocation.triggers.map(searchText);
  let score = id.includes(normalizedQuery) || name.includes(normalizedQuery) || description.includes(normalizedQuery) ? 10_000 : 0;
  for (const token of searchTokens(normalizedQuery)) {
    if (id.includes(token)) score += 12;
    if (name.includes(token)) score += 8;
    if (description.includes(token)) score += 4;
    if (triggers.some((trigger) => trigger.includes(token))) score += 6;
  }
  return score;
}

function sameInvocationPolicy(left: SkillInvocationPolicy, right: SkillInvocationPolicy): boolean {
  if (left.modelInvocable !== right.modelInvocable || left.userInvocable !== right.userInvocable || left.autoSelect !== right.autoSelect) return false;
  if (left.argumentHint !== right.argumentHint || left.triggers.length !== right.triggers.length) return false;
  return left.triggers.every((trigger, index) => trigger === right.triggers[index]);
}

export class SkillCatalog {
  private readonly limits: SkillCatalogLimits;

  private readonly roots: readonly ValidatedRoot[];

  private records = new Map<string, SkillRecord>();

  private readonly skillCache = new Map<string, CachedSkill>();

  private refreshing = false;

  public constructor(options: SkillCatalogOptions) {
    if (!options || !Array.isArray(options.roots)) throw new TypeError("skill roots are required");
    this.limits = mergeLimits(options.limits);
    if (options.roots.length > this.limits.maxRoots) throw new TypeError("too many skill roots");
    this.roots = Object.freeze(options.roots.map((root) => validateRoot(root)));
    this.refresh();
  }

  /** Re-scan metadata. Earlier roots win duplicate IDs. */
  public refresh(): readonly SkillSummary[] {
    // The catalog API is synchronous, so a nested refresh can only happen
    // through re-entrant filesystem hooks. Reuse the last complete snapshot
    // instead of rebuilding it while an outer refresh is still in progress.
    if (this.refreshing) return this.list();
    this.refreshing = true;
    try {
      const next = new Map<string, SkillRecord>();
      const seenCacheKeys = new Set<string>();
      let candidates = 0;
      outer: for (const root of this.roots) {
        let entries: Dirent[];
        try {
          // A deterministic order makes the candidate limit and duplicate handling stable.
          entries = readdirSync(root.absolutePath, { withFileTypes: true }).sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
          );
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (candidates >= this.limits.maxCandidates) break outer;
          candidates += 1;
          if (!entry.isDirectory()) continue;
          const id = normalizeId(entry.name);
          if (id === undefined || next.has(id)) continue;
          try {
            const skillPath = join(root.absolutePath, entry.name);
            const childRealPath = assertNoLinkComponents(skillPath);
            if (!containedBy(root.realPath, childRealPath)) throw new InvalidSkillError("skill directory escapes its root");
            const childStats = lstatSync(skillPath);
            if (childStats.isSymbolicLink() || isReparsePoint(childStats) || !childStats.isDirectory()) continue;
            const filePath = join(skillPath, "SKILL.md");
            const cacheKey = comparablePath(filePath);
            seenCacheKeys.add(cacheKey);
            const validated = readValidatedSkill(root, filePath, id, this.limits, this.skillCache.get(cacheKey));
            this.skillCache.set(cacheKey, validated);
            const parsed = validated.parsed;
            next.set(id, {
              id,
              name: parsed.name,
              description: parsed.description,
              source: root.config.source,
              absoluteFilePath: filePath,
              rootRealPath: root.realPath,
              invocation: parsed.invocation,
            });
          } catch {
            // A malformed or unsafe third-party Skill is omitted, never trusted or surfaced.
            this.skillCache.delete(comparablePath(join(root.absolutePath, entry.name, "SKILL.md")));
          }
        }
      }
      for (const key of this.skillCache.keys()) {
        if (!seenCacheKeys.has(key)) this.skillCache.delete(key);
      }
      this.records = next;
      return this.list();
    } finally {
      this.refreshing = false;
    }
  }

  /** Returns the validated root config for a source label, if present. */
  public rootFor(source: string): SkillRoot | undefined {
    return this.roots.find((root) => root.config.source === source)?.config;
  }

  /** Returns the catalog source owning an id, if indexed. */
  public sourceOf(id: string): string | undefined {
    const normalized = normalizeId(id);
    if (normalized === undefined) return undefined;
    return this.records.get(normalized)?.source;
  }

  /** Returns a deterministic public list, optionally filtered by a user/model query. */
  public list(query?: string): readonly SkillSummary[] {
    const normalizedQuery = query?.trim();
    return [...this.records.values()]
      .map((record) => ({ record, score: normalizedQuery ? searchScore(record, normalizedQuery) : 1 }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || (left.record.id < right.record.id ? -1 : left.record.id > right.record.id ? 1 : 0))
      .map(({ record }) => summary(record));
  }

  /** Returns invocation hints kept separate from the public four-field catalog entry. */
  public invocationPolicy(id: string): SkillInvocationPolicy | undefined {
    const normalized = normalizeId(id);
    const record = normalized === undefined ? undefined : this.records.get(normalized);
    return record?.invocation;
  }

  /** Async path validation plus pre-parsed body; reloads with async I/O on cache miss. */
  public async readCachedValidated(id: string): Promise<SkillReadResult | undefined> {
    const normalized = normalizeId(id);
    if (normalized === undefined) return undefined;
    const record = this.records.get(normalized);
    if (!record) return undefined;
    const cached = this.skillCache.get(comparablePath(record.absoluteFilePath));
    if (cached !== undefined) {
      try {
        const [stats, resolved] = await Promise.all([
          lstatAsync(record.absoluteFilePath),
          realpathAsync(record.absoluteFilePath),
        ]);
        if (
          !stats.isSymbolicLink() &&
          !isReparsePoint(stats) &&
          stats.isFile() &&
          containedBy(record.rootRealPath, resolved) &&
          sameSnapshot(fileSnapshot(stats), cached.snapshot)
        ) {
          return this.readCached(normalized);
        }
      } catch {
        // Fall through to a full async reread; a missing file still fails closed.
      }
    }
    return this.readAsync(id);
  }

  /** Returns the body parsed during refresh without filesystem I/O. */
  public readCached(id: string): SkillReadResult | undefined {
    const normalized = normalizeId(id);
    if (normalized === undefined) return undefined;
    const record = this.records.get(normalized);
    if (!record) return undefined;
    const parsed = this.skillCache.get(comparablePath(record.absoluteFilePath))?.parsed;
    if (!parsed || parsed.name !== record.name || parsed.description !== record.description || !sameInvocationPolicy(parsed.invocation, record.invocation)) {
      return undefined;
    }
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      source: record.source,
      content: parsed.content,
      delimiters: { start: `[[OPENBOT_SKILL_BEGIN:${normalized}]]`, end: `[[OPENBOT_SKILL_END:${normalized}]]` },
      invocation: parsed.invocation,
      trust: "untrusted",
    };
  }

  /** Reads and validates one body after catalog discovery; paths never leave this class. */
  public read(id: string): SkillReadResult | undefined {
    return this.materializeRead(id, (root, record, normalized, cacheKey) => (
      readValidatedSkill(root, record.absoluteFilePath, normalized, this.limits, this.skillCache.get(cacheKey))
    ));
  }

  /** Same contract as `read`, but never uses sync filesystem APIs. */
  public async readAsync(id: string): Promise<SkillReadResult | undefined> {
    return this.materializeRead(id, (root, record, normalized, cacheKey) => (
      readValidatedSkillAsync(root, record.absoluteFilePath, normalized, this.limits, this.skillCache.get(cacheKey))
    ));
  }

  private materializeRead(
    id: string,
    load: (
      root: ValidatedRoot,
      record: SkillRecord,
      normalized: string,
      cacheKey: string,
    ) => CachedSkill,
  ): SkillReadResult | undefined;
  private materializeRead(
    id: string,
    load: (
      root: ValidatedRoot,
      record: SkillRecord,
      normalized: string,
      cacheKey: string,
    ) => Promise<CachedSkill>,
  ): Promise<SkillReadResult | undefined>;
  private materializeRead(
    id: string,
    load: (
      root: ValidatedRoot,
      record: SkillRecord,
      normalized: string,
      cacheKey: string,
    ) => CachedSkill | Promise<CachedSkill>,
  ): SkillReadResult | undefined | Promise<SkillReadResult | undefined> {
    const normalized = normalizeId(id);
    if (normalized === undefined) return undefined;
    const record = this.records.get(normalized);
    if (!record) return undefined;
    const cacheKey = comparablePath(record.absoluteFilePath);
    const root: ValidatedRoot = {
      config: { path: record.rootRealPath, source: record.source },
      absolutePath: record.rootRealPath,
      realPath: record.rootRealPath,
    };
    const finish = (validated: CachedSkill): SkillReadResult | undefined => {
      this.skillCache.set(cacheKey, validated);
      const parsed = validated.parsed;
      if (parsed.name !== record.name || parsed.description !== record.description || !sameInvocationPolicy(parsed.invocation, record.invocation)) {
        return undefined;
      }
      return {
        id: record.id,
        name: record.name,
        description: record.description,
        source: record.source,
        content: parsed.content,
        delimiters: { start: `[[OPENBOT_SKILL_BEGIN:${normalized}]]`, end: `[[OPENBOT_SKILL_END:${normalized}]]` },
        invocation: parsed.invocation,
        trust: "untrusted",
      };
    };
    try {
      const loaded = load(root, record, normalized, cacheKey);
      if (loaded instanceof Promise) {
        return loaded.then(finish, () => {
          this.skillCache.delete(cacheKey);
          return undefined;
        });
      }
      return finish(loaded);
    } catch {
      this.skillCache.delete(cacheKey);
      return undefined;
    }
  }
}
