import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { McpHttpServerConfig, McpSecretRef, McpServerConfig, McpStdioServerConfig } from "./contracts.js";

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;
export const MAX_MCP_TIMEOUT_MS = 120_000;
export const DEFAULT_MCP_RESULT_BYTES = 1024 * 1024;
export const MAX_MCP_RESULT_BYTES = 8 * 1024 * 1024;
export const MAX_MCP_ARGS = 128;
export const MAX_MCP_ARG_BYTES = 8 * 1024;
export const MAX_MCP_ENV_ENTRIES = 64;
export const MAX_MCP_TOOLS = 256;
/** Upper bound for the shared catalog.  Discovery is deliberately bounded so
 * one malformed config cannot turn every tool refresh into an unbounded fan
 * out of remote connections. */
export const MAX_MCP_SERVERS = 64;
export const DEFAULT_MCP_TOOL_CACHE_TTL_MS = 30_000;
export const MAX_MCP_TOOL_CACHE_TTL_MS = 300_000;
export const DEFAULT_MCP_LIST_CONCURRENCY = 4;
export const MAX_MCP_LIST_CONCURRENCY = 8;
export const MAX_MCP_TOOL_DESCRIPTION_BYTES = 8 * 1024;
export const MAX_MCP_TOOL_SCHEMA_BYTES = 64 * 1024;
export const MAX_MCP_TOOL_SCHEMA_DEPTH = 16;
export const MAX_MCP_TOOL_SCHEMA_NODES = 2048;

const execFileAsync = promisify(execFile);
const WINDOWS_ACL_TOOL = "icacls.exe";
const EVERYONE_PRINCIPAL = "*S-1-1-0";
const SYSTEM_PRINCIPAL = "*S-1-5-18";

export class McpSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSecurityError";
  }
}

type LookupResult = string[] | readonly string[];
export type McpDnsLookup = (hostname: string) => Promise<LookupResult> | LookupResult;

const BLOCKED_COMMANDS = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "sh.exe",
  "bash",
  "bash.exe",
  "zsh",
  "zsh.exe",
  "fish",
  "fish.exe",
  "wsl",
  "wsl.exe",
]);

const asString = (value: unknown, message: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new McpSecurityError(message);
  return value;
};

const stripIpv6Brackets = (host: string): string => host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

const ipv4Parts = (address: string): number[] | undefined => {
  if (!net.isIPv4(address)) return undefined;
  const parts = address.split(".").map((item) => Number(item));
  return parts.length === 4 && parts.every((item) => Number.isInteger(item) && item >= 0 && item <= 255) ? parts : undefined;
};

const mappedIpv4 = (address: string): string | undefined => {
  const normalized = address.toLowerCase();
  const marker = normalized.lastIndexOf(":ffff:");
  if (marker === -1) return undefined;
  const tail = normalized.slice(marker + 6);
  return net.isIPv4(tail) ? tail : undefined;
};

const firstIpv6Byte = (address: string): number | undefined => {
  if (!net.isIPv6(address)) return undefined;
  const withoutZone = address.split("%")[0];
  if (withoutZone === undefined) return undefined;
  const first = withoutZone.split(":")[0] ?? "";
  const value = Number.parseInt(first === "" ? "0" : first, 16);
  return Number.isFinite(value) ? value >> 8 : undefined;
};

const firstIpv6Hextet = (address: string): number | undefined => {
  if (!net.isIPv6(address)) return undefined;
  const first = address.split(":")[0] ?? "";
  const value = Number.parseInt(first === "" ? "0" : first, 16);
  return Number.isFinite(value) ? value : undefined;
};

export function isLoopbackAddress(address: string): boolean {
  const ipv4 = mappedIpv4(address) ?? address;
  const parts = ipv4Parts(ipv4);
  if (parts !== undefined) return parts[0] === 127;
  return net.isIPv6(address) && address.toLowerCase() === "::1";
}

export function isDisallowedHttpAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  const ipv4Address = mappedIpv4(normalized) ?? normalized;
  const parts = ipv4Parts(ipv4Address);
  if (parts !== undefined) {
    const [a, b, c] = parts;
    if (a === undefined || b === undefined || c === undefined) return true;
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 168 || (b === 0 && c < 256))) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  if (!net.isIPv6(normalized)) return true;
  if (isLoopbackAddress(normalized)) return true;
  const first = firstIpv6Byte(normalized);
  const hextet = firstIpv6Hextet(normalized);
  if (first === undefined || hextet === undefined) return true;
  // IPv6 unspecified, unique-local, link-local, site-local and multicast.
  return first === 0 || (hextet & 0xfe00) === 0xfc00 || (hextet & 0xffc0) === 0xfe80 || first === 0xff || (hextet >= 0xfec0 && hextet <= 0xfeff);
}

const isLoopbackHost = (hostname: string): boolean => {
  const host = stripIpv6Brackets(hostname).toLowerCase().replace(/\.$/u, "");
  return host === "localhost" || host.endsWith(".localhost") || isLoopbackAddress(host);
};

export function validateHttpUrl(value: string): URL {
  asString(value, "MCP HTTP URL is invalid");
  let url: URL;
  try { url = new URL(value); } catch { throw new McpSecurityError("MCP HTTP URL is invalid"); }
  if (url.username.length > 0 || url.password.length > 0) throw new McpSecurityError("MCP HTTP URL cannot contain credentials");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new McpSecurityError("MCP HTTP URL must use HTTPS or loopback HTTP");
  if (url.hostname.length === 0) throw new McpSecurityError("MCP HTTP URL hostname is missing");
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) throw new McpSecurityError("insecure MCP HTTP is allowed only on loopback");
  return url;
}

const normalizeLookupAddresses = (value: LookupResult): string[] => value.map((item) => {
  if (typeof item !== "string" || net.isIP(stripIpv6Brackets(item)) === 0) throw new McpSecurityError("MCP DNS returned an invalid address");
  return stripIpv6Brackets(item);
});

export interface ValidatedHttpEndpoint {
  url: URL;
  addresses: string[];
}

const validateJsonShape = (value: unknown, depth: number, state: { nodes: number }, seen: Set<object>): void => {
  if (depth > MAX_MCP_TOOL_SCHEMA_DEPTH) throw new McpSecurityError("MCP tool schema is too deep");
  state.nodes += 1;
  if (state.nodes > MAX_MCP_TOOL_SCHEMA_NODES) throw new McpSecurityError("MCP tool schema is too large");
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value !== "object") throw new McpSecurityError("MCP tool schema contains unsupported values");
  if (seen.has(value)) throw new McpSecurityError("MCP tool schema is cyclic");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validateJsonShape(item, depth + 1, state, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (Buffer.byteLength(key) > MAX_MCP_ARG_BYTES) throw new McpSecurityError("MCP tool schema key is too large");
      validateJsonShape(item, depth + 1, state, seen);
    }
  }
  seen.delete(value);
};

export function validateMcpToolMetadata(tool: unknown): tool is { name: string; description?: string; inputSchema: Record<string, unknown> } {
  if (typeof tool !== "object" || tool === null || Array.isArray(tool)) throw new McpSecurityError("MCP tool definition is invalid");
  const candidate = tool as Record<string, unknown>;
  if (typeof candidate.name !== "string" || candidate.name.length === 0 || Buffer.byteLength(candidate.name) > MAX_MCP_ARG_BYTES) {
    throw new McpSecurityError("MCP tool name is invalid");
  }
  if (candidate.description !== undefined && (typeof candidate.description !== "string" || Buffer.byteLength(candidate.description) > MAX_MCP_TOOL_DESCRIPTION_BYTES)) {
    throw new McpSecurityError("MCP tool description is too large");
  }
  if (typeof candidate.inputSchema !== "object" || candidate.inputSchema === null || Array.isArray(candidate.inputSchema)) {
    throw new McpSecurityError("MCP tool input schema is invalid");
  }
  const schema = candidate.inputSchema as Record<string, unknown>;
  if (jsonByteLength(schema) > MAX_MCP_TOOL_SCHEMA_BYTES) throw new McpSecurityError("MCP tool input schema is too large");
  validateJsonShape(schema, 0, { nodes: 0 }, new Set<object>());
  return true;
}

const jsonByteLength = (value: unknown): number => {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new McpSecurityError("MCP tool metadata is not serializable"); }
  if (encoded === undefined) throw new McpSecurityError("MCP tool metadata is not serializable");
  return Buffer.byteLength(encoded);
};

export async function resolveAndValidateHttpEndpoint(
  value: string,
  lookup: McpDnsLookup = async (hostname) => (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address),
): Promise<ValidatedHttpEndpoint> {
  const url = validateHttpUrl(value);
  const hostname = stripIpv6Brackets(url.hostname);
  let addresses: string[];
  try { addresses = normalizeLookupAddresses(await lookup(hostname)); } catch (error) {
    if (error instanceof McpSecurityError) throw error;
    throw new McpSecurityError("MCP endpoint DNS resolution failed");
  }
  if (addresses.length === 0) throw new McpSecurityError("MCP endpoint has no resolved addresses");
  const loopbackHost = isLoopbackHost(hostname);
  if (url.protocol === "http:" && !addresses.every(isLoopbackAddress)) {
    throw new McpSecurityError("insecure MCP HTTP resolved outside loopback");
  }
  if (!loopbackHost && addresses.some((address) => isDisallowedHttpAddress(address))) {
    throw new McpSecurityError("MCP endpoint resolves to a private or reserved address");
  }
  if (loopbackHost && addresses.some((address) => !isLoopbackAddress(address))) {
    throw new McpSecurityError("loopback MCP endpoint resolved outside loopback");
  }
  return { url, addresses };
}

const isSecretRef = (value: unknown): value is McpSecretRef => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && typeof record.secretRef === "string" && record.secretRef.length > 0 && !record.secretRef.includes("\0");
};

export function validateSecretRefs(values: unknown, label: string): Record<string, McpSecretRef> | undefined {
  if (values === undefined) return undefined;
  if (typeof values !== "object" || values === null || Array.isArray(values)) throw new McpSecurityError(`${label} must use secret references`);
  const output: Record<string, McpSecretRef> = {};
  const entries = Object.entries(values as Record<string, unknown>);
  if (entries.length > MAX_MCP_ENV_ENTRIES) throw new McpSecurityError(`${label} exceeds the entry limit`);
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(key) || !isSecretRef(value)) throw new McpSecurityError(`${label} must use secret references`);
    output[key] = value;
  }
  return output;
}

export function validateHttpServerConfig(config: McpHttpServerConfig): void {
  const allowed = new Set(["id", "transport", "url", "headers", "timeoutMs", "maxResultBytes", "sessionScope"]);
  if (Object.keys(config as unknown as Record<string, unknown>).some((key) => !allowed.has(key))) throw new McpSecurityError("MCP HTTP configuration contains unsupported fields");
  if (config.sessionScope !== undefined && config.sessionScope !== "shared" && config.sessionScope !== "agent") throw new McpSecurityError("MCP session scope is invalid");
  validateHttpUrl(config.url);
  validateSecretRefs(config.headers, "MCP HTTP headers");
}

export interface StdioSecurityOptions {
  approvedCwdRoots: readonly string[];
  allowedCommands?: readonly string[];
}

export interface ValidatedStdioConfig {
  /** Canonical executable path before private snapshot staging. */
  command: string;
  args: string[];
  cwd: string;
  /** Identity captured while validating the working directory. */
  cwdIdentity: StdioCwdIdentity;
  env?: Record<string, McpSecretRef>;
  /** Identity captured while validating the executable, used for staging. */
  commandIdentity: StdioExecutableIdentity;
}

export interface StdioCwdIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface StdioExecutableIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly sha256: string;
}

const basename = (value: string): string => path.win32.basename(value).toLowerCase();
const windowsAbsolute = (value: string): boolean => /^[A-Za-z]:[\\/]/u.test(value);
const absolutePath = (value: string): boolean => path.isAbsolute(value) || windowsAbsolute(value);
const pathKey = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const windowsAclOptions = {
  encoding: "utf8" as const,
  maxBuffer: 4 * 1024 * 1024,
  shell: false as const,
  windowsHide: true,
};

/**
 * A chmod-only executable snapshot remains writable through inherited Windows
 * ACLs. The snapshot must stay readable by the child, so this uses an explicit
 * DACL: the file gets RX-only access, inheritance is removed, and the private
 * root denies writes/deletes needed for replacement. The ACL is intentionally
 * different from the home ACL, which grants the current account full control
 * and is therefore unsuitable here.
 */
const applyWindowsSnapshotDacl = async (root: string): Promise<void> => {
  if (process.platform !== "win32") return;
  const run = async (args: readonly string[]): Promise<void> => {
    try {
      await execFileAsync(WINDOWS_ACL_TOOL, [root, ...args], windowsAclOptions);
    } catch {
      throw new McpSecurityError("MCP stdio executable snapshot DACL could not be applied");
    }
  };

  // Grant explicit access to every node before removing inherited entries;
  // otherwise removing the root inheritance can cut off traversal mid-tree.
  await run([
    "/grant:r",
    `${EVERYONE_PRINCIPAL}:(OI)(CI)(RX)`,
    `${EVERYONE_PRINCIPAL}:RX`,
    `${SYSTEM_PRINCIPAL}:(OI)(CI)(F)`,
    `${SYSTEM_PRINCIPAL}:F`,
    "/T",
  ]);
  await run(["/inheritance:r", "/T"]);
  await run(["/deny", `${EVERYONE_PRINCIPAL}:(OI)(CI)(W,D,DC)`]);
  await run(["/verify"]);
};

const resetWindowsSnapshotDacl = async (root: string): Promise<void> => {
  if (process.platform !== "win32") return;
  await execFileAsync(WINDOWS_ACL_TOOL, [root, "/reset", "/T", "/C"], windowsAclOptions).catch(() => {});
};

interface ResolvedExecutable {
  requested: string;
  target: string;
  identity: StdioExecutableIdentity;
}

const digestExecutable = (contents: Uint8Array): string => createHash("sha256").update(contents).digest("hex");

const readExecutableContents = async (target: string): Promise<Buffer> => {
  const handle = await open(target, "r");
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const executableIdentity = (stat: Awaited<ReturnType<typeof lstat>>, contents?: Uint8Array): StdioExecutableIdentity => ({
  dev: Number(stat.dev),
  ino: Number(stat.ino),
  size: Number(stat.size),
  mtimeMs: Number(stat.mtimeMs),
  ctimeMs: Number(stat.ctimeMs),
  sha256: contents === undefined ? "" : digestExecutable(contents),
});

const cwdIdentity = (stat: Awaited<ReturnType<typeof lstat>>): StdioCwdIdentity => ({
  dev: Number(stat.dev),
  ino: Number(stat.ino),
  size: Number(stat.size),
  mtimeMs: Number(stat.mtimeMs),
  ctimeMs: Number(stat.ctimeMs),
});

const sameCwdIdentity = (left: StdioCwdIdentity, right: StdioCwdIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
  left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

/**
 * Revalidate the original cwd at the synchronous stdio launch boundary.
 * There is intentionally no async filesystem work here: callers can invoke
 * this immediately before `Client.connect`, whose legacy path calls
 * `StdioClientTransport.start` and its synchronous spawn without yielding.
 */
export function assertValidatedStdioCwd(config: Pick<ValidatedStdioConfig, "cwd" | "cwdIdentity">): void {
  let currentPath: string;
  let currentStat: ReturnType<typeof lstatSync>;
  try {
    currentPath = realpathSync(config.cwd);
    currentStat = lstatSync(currentPath);
  } catch {
    throw new McpSecurityError("MCP stdio cwd changed after validation");
  }
  if (
    pathKey(currentPath) !== pathKey(config.cwd) ||
    !currentStat.isDirectory() ||
    !sameCwdIdentity(cwdIdentity(currentStat), config.cwdIdentity)
  ) {
    throw new McpSecurityError("MCP stdio cwd changed after validation");
  }
}

const sameExecutableIdentity = (left: StdioExecutableIdentity, right: StdioExecutableIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
  left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

/**
 * Resolve an approved executable to a regular file before policy comparison.
 * The lexical path is retained only for diagnostics/policy matching; the
 * canonical target is what the stdio transport must spawn.
 */
const resolveExecutable = async (value: string, includeContentHash = false): Promise<ResolvedExecutable> => {
  const requested = path.resolve(value);
  let requestedStat: Awaited<ReturnType<typeof lstat>>;
  try {
    requestedStat = await lstat(requested);
  } catch {
    throw new McpSecurityError("MCP stdio command must reference an existing executable");
  }
  if (!requestedStat.isFile() && !requestedStat.isSymbolicLink()) {
    throw new McpSecurityError("MCP stdio command must reference a regular file");
  }
  let target: string;
  try {
    target = await realpath(requested);
  } catch {
    throw new McpSecurityError("MCP stdio command target could not be resolved");
  }
  let targetStat: Awaited<ReturnType<typeof lstat>>;
  try {
    targetStat = await lstat(target);
  } catch {
    throw new McpSecurityError("MCP stdio command target could not be inspected");
  }
  if (!targetStat.isFile()) throw new McpSecurityError("MCP stdio command target must be a regular file");
  if (BLOCKED_COMMANDS.has(basename(target))) throw new McpSecurityError("MCP stdio command is blocked");
  let contents: Buffer | undefined;
  if (includeContentHash) {
    try {
      contents = await readExecutableContents(target);
    } catch {
      throw new McpSecurityError("MCP stdio command target could not be read");
    }
  }
  return { requested, target, identity: executableIdentity(targetStat, contents) };
};

const containedBy = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !absolutePath(relative));
};

export async function validateStdioConfig(
  config: McpStdioServerConfig,
  options: StdioSecurityOptions,
): Promise<ValidatedStdioConfig> {
  const command = asString(config.command, "MCP stdio command is invalid");
  const commandName = basename(command);
  if (BLOCKED_COMMANDS.has(commandName)) throw new McpSecurityError("MCP stdio command is blocked");
  const configuredAllowedCommands = options.allowedCommands ?? [];
  if (configuredAllowedCommands.some((item) => typeof item !== "string" || item.length === 0 || item.includes("\0"))) {
    throw new McpSecurityError("MCP stdio command allowlist is invalid");
  }
  const allowed = new Set(configuredAllowedCommands.map((item) => item.toLowerCase()));
  let launchCommand: string;
  let commandIdentity: StdioExecutableIdentity;
  if (absolutePath(command)) {
    // Absolute paths are accepted only when the exact path (not merely its
    // basename) was explicitly allowlisted. Compare canonical targets as
    // well, so an approved-looking symlink cannot redirect to a shell.
    const resolvedCommand = await resolveExecutable(command, true);
    commandIdentity = resolvedCommand.identity;
    const approvedTargets: string[] = [];
    for (const item of configuredAllowedCommands) {
      if (!absolutePath(item)) continue;
      try {
        approvedTargets.push((await resolveExecutable(item)).target);
      } catch {
        // An unrelated stale allowlist entry must not make a valid command
        // unusable; the requested command itself is still fail-closed below.
      }
    }
    if (!approvedTargets.some((item) => pathKey(item) === pathKey(resolvedCommand.target))) {
      throw new McpSecurityError("MCP stdio command is not allowlisted");
    }
    // Keep the trusted Node runtime spelling for compatibility, while all
    // user-provided executable paths launch their canonical target.
    launchCommand = pathKey(command) === pathKey(process.execPath) ? process.execPath : resolvedCommand.target;
  } else {
    if (command.includes("/") || command.includes("\\") || command === "." || command === "..") {
      throw new McpSecurityError("MCP stdio command is not allowlisted");
    }
    const processExecutable = await resolveExecutable(process.execPath, true);
    let processExecutableAllowed = false;
    for (const item of configuredAllowedCommands) {
      if (!absolutePath(item)) continue;
      try {
        if (pathKey((await resolveExecutable(item)).target) === pathKey(processExecutable.target)) {
          processExecutableAllowed = true;
          break;
        }
      } catch {
        // Ignore unrelated stale entries; the selected command remains
        // subject to the exact policy checks below.
      }
    }
    const nodeCommand = commandName === "node" || commandName === "node.exe" || commandName === basename(process.execPath);
    if (nodeCommand && (allowed.has(command.toLowerCase()) || allowed.has(commandName) || processExecutableAllowed)) {
      // Never resolve `node` through PATH: it is the exact runtime already
      // trusted by this process.
      launchCommand = process.execPath;
      commandIdentity = processExecutable.identity;
    } else {
      if (!allowed.has(command.toLowerCase()) && !allowed.has(commandName)) {
        throw new McpSecurityError("MCP stdio command is not allowlisted");
      }
      const candidates = configuredAllowedCommands.filter((item) => absolutePath(item) && basename(item) === commandName);
      if (candidates.length !== 1 || candidates[0] === undefined) {
        throw new McpSecurityError("MCP stdio command requires one exact approved executable path");
      }
      const resolvedCandidate = await resolveExecutable(candidates[0], true);
      launchCommand = resolvedCandidate.target;
      commandIdentity = resolvedCandidate.identity;
    }
  }
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.length > MAX_MCP_ARGS)) throw new McpSecurityError("MCP stdio args are invalid");
  const args = (config.args ?? []).map((item) => {
    if (typeof item !== "string" || item.includes("\0") || Buffer.byteLength(item) > MAX_MCP_ARG_BYTES) throw new McpSecurityError("MCP stdio args are invalid");
    return item;
  });
  const cwdValue = asString(config.cwd, "MCP stdio cwd is invalid");
  const cwd = path.resolve(cwdValue);
  let realCwd: string;
  try { realCwd = await realpath(cwd); } catch { throw new McpSecurityError("MCP stdio cwd must exist"); }
  let cwdStat: Awaited<ReturnType<typeof lstat>>;
  try { cwdStat = await lstat(realCwd); } catch { throw new McpSecurityError("MCP stdio cwd must be inspected"); }
  if (!cwdStat.isDirectory()) throw new McpSecurityError("MCP stdio cwd must be a directory");
  if (options.approvedCwdRoots.length === 0) throw new McpSecurityError("MCP stdio has no approved cwd root");
  const roots = await Promise.all(options.approvedCwdRoots.map(async (root) => {
    const rootValue = asString(root, "MCP stdio approved root is invalid");
    try { return await realpath(path.resolve(rootValue)); } catch { throw new McpSecurityError("MCP stdio approved root must exist"); }
  }));
  if (!roots.some((root) => containedBy(realCwd, root))) throw new McpSecurityError("MCP stdio cwd is outside approved roots");
  const env = validateSecretRefs(config.env, "MCP stdio environment");
  return {
    command: launchCommand,
    args,
    cwd: realCwd,
    cwdIdentity: cwdIdentity(cwdStat),
    commandIdentity,
    ...(env === undefined ? {} : { env }),
  };
}

export interface StagedStdioExecutable {
  /** Private snapshot path passed to the path-only SDK transport. */
  readonly command: string;
  /** Restores cleanup permissions and removes the private snapshot. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Materialize the validated executable before handing it to the SDK. The SDK
 * accepts only a path, so its spawn cannot be bound to an already-open handle.
 * The source is therefore checked by file identity and SHA-256 while open,
 * then copied into a random private directory and made read-only before spawn.
 * This closes replacement of the configured alias; Windows also receives an
 * explicit read-only DACL because chmod does not override inherited ACLs.
 */
export async function stageValidatedStdioExecutable(config: ValidatedStdioConfig): Promise<StagedStdioExecutable> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openbot-mcp-stdio-"));
  const stagedCommand = path.join(root, process.platform === "win32" ? "mcp-executable.exe" : "mcp-executable");
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await resetWindowsSnapshotDacl(root);
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  };
  try {
    const source = await open(config.command, "r");
    let contents: Buffer;
    try {
      const currentStat = await source.stat();
      const currentIdentity = executableIdentity(currentStat);
      if (!sameExecutableIdentity(currentIdentity, config.commandIdentity)) {
        throw new McpSecurityError("MCP stdio executable changed after validation");
      }
      contents = await source.readFile();
    } finally {
      await source.close();
    }
    if (digestExecutable(contents) !== config.commandIdentity.sha256) {
      throw new McpSecurityError("MCP stdio executable content changed after validation");
    }
    await writeFile(stagedCommand, contents, { flag: "wx", mode: 0o500 });
    await chmod(stagedCommand, 0o500);
    const stagedStat = await lstat(stagedCommand);
    if (!stagedStat.isFile() || digestExecutable(await readExecutableContents(stagedCommand)) !== config.commandIdentity.sha256) {
      throw new McpSecurityError("MCP stdio executable snapshot could not be verified");
    }
    await applyWindowsSnapshotDacl(root);
    // chmod remains useful on non-Windows; Windows uses the explicit DACL
    // above because inherited ACLs are not changed by chmod.
    if (process.platform !== "win32") await chmod(root, 0o500);
    return { command: stagedCommand, cleanup };
  } catch (error) {
    await cleanup();
    if (error instanceof McpSecurityError) throw error;
    throw new McpSecurityError("MCP stdio executable snapshot could not be created");
  }
}

export function validateMcpServerConfig(config: McpServerConfig): void {
  if (typeof config !== "object" || config === null || Array.isArray(config)) throw new McpSecurityError("MCP server configuration is invalid");
  if (typeof config.id !== "string" || config.id.length === 0) throw new McpSecurityError("MCP server id is invalid");
  if (config.transport === "http") {
    validateHttpServerConfig(config);
    return;
  }
  if (config.transport !== "stdio") throw new McpSecurityError("MCP transport is invalid");
  const allowed = new Set(["id", "transport", "command", "args", "cwd", "env", "timeoutMs", "maxResultBytes", "sessionScope"]);
  if (Object.keys(config as unknown as Record<string, unknown>).some((key) => !allowed.has(key))) throw new McpSecurityError("MCP stdio configuration contains unsupported fields");
  if (config.sessionScope !== undefined && config.sessionScope !== "shared" && config.sessionScope !== "agent") throw new McpSecurityError("MCP session scope is invalid");
  asString(config.command, "MCP stdio command is invalid");
  asString(config.cwd, "MCP stdio cwd is invalid");
  validateSecretRefs(config.env, "MCP stdio environment");
  if (config.args !== undefined && !Array.isArray(config.args)) throw new McpSecurityError("MCP stdio args are invalid");
}

export async function resolveSecretRefs(
  values: Record<string, McpSecretRef> | undefined,
  resolver: (ref: string) => Promise<string> | string,
): Promise<Record<string, string> | undefined> {
  if (values === undefined) return undefined;
  const output: Record<string, string> = {};
  for (const [key, ref] of Object.entries(values)) {
    let value: string;
    try { value = await resolver(ref.secretRef); } catch { throw new McpSecurityError(`MCP secret ${key} could not be resolved`); }
    if (typeof value !== "string" || value.includes("\0")) throw new McpSecurityError(`MCP secret ${key} is invalid`);
    output[key] = value;
  }
  return output;
}
