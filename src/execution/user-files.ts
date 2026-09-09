import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { win32 as path } from "node:path";

import { WorkspaceError, WorkspaceSandbox } from "./workspace.js";

export const SHARED_USER_DIRECTORIES = ["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"] as const;
export type SharedUserDirectory = (typeof SHARED_USER_DIRECTORIES)[number];

const BLOCKED_SYSTEM_ROOT = [
  /^[a-z]:\\windows(?:\\|$)/iu,
  /^[a-z]:\\program files(?: \(x86\))?(?:\\|$)/iu,
  /^[a-z]:\\programdata(?:\\|$)/iu,
];

export function defaultUserProfile(): string {
  const explicit = process.env.USERPROFILE?.trim();
  if (explicit) return explicit;
  return homedir();
}

export function sharedDirectoryName(value: string): SharedUserDirectory | undefined {
  return SHARED_USER_DIRECTORIES.find((name) => name.toLowerCase() === value.toLowerCase());
}

export function isReservedHomeRelative(relative: string): boolean {
  const first = relative.split(/[\\/]/u).find((part) => part.length > 0 && part !== ".") ?? "";
  return first.toLowerCase() === ".openbot";
}

/** Per-agent Downloads folder under the user's real Downloads. Last segment stays `Downloads` for the browser host. */
const AGENT_PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u;
const RESERVED_AGENT_PATH_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

/** Shared path guard. Helpers must never rely on callers having canonicalized an id. */
export function validateAgentPathId(agentId: string): string {
  const stem = typeof agentId === "string" ? agentId.split(".", 1)[0] ?? "" : "";
  if (
    typeof agentId !== "string" ||
    !AGENT_PATH_ID.test(agentId) ||
    agentId.endsWith(".") ||
    agentId.endsWith(" ") ||
    RESERVED_AGENT_PATH_ID.test(stem)
  ) {
    throw new WorkspaceError("invalid_path", "Agent id is invalid.");
  }
  return agentId;
}

export function agentSharedDownloadRoot(userProfile: string, agentId: string): string {
  return path.join(path.resolve(userProfile), "Downloads", "OpenBot", validateAgentPathId(agentId), "Downloads");
}

/**
 * Per-bot redirect root for a shared directory: `<profile>\<Name>\OpenBot\<agentId>\<Name>`.
 * Bots without a grant see this private folder instead of the real one.
 */
export function agentSharedDirectoryRoot(userProfile: string, name: SharedUserDirectory, agentId: string): string {
  return path.join(path.resolve(userProfile), name, "OpenBot", validateAgentPathId(agentId), name);
}

export function isHomeTrashArchivePath(relative: string): boolean {
  const normalized = relative.replaceAll("\\", "/").toLowerCase();
  return normalized === ".openbot/trash" || normalized.startsWith(".openbot/trash/");
}

export type ClassifiedAgentPath =
  | { kind: "root" }
  | { kind: "shared"; mount: SharedUserDirectory; relative: string }
  | { kind: "home"; relative: string }
  | { kind: "host"; root: string; relative: string };

/** Drive-letter absolute paths (`C:\...`, `D:/...`, `C:`). All else stays bot-relative. */
export function isAbsoluteWindowsPath(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z]:(?:[\\/]|$)/u.test(value);
}

export function classifyAgentPath(relative: string): ClassifiedAgentPath {
  if (typeof relative !== "string" || relative.length === 0 || relative.includes("\0")) {
    throw new WorkspaceError("invalid_path", "Workspace path is invalid.");
  }
  if (isAbsoluteWindowsPath(relative)) {
    const root = `${relative.slice(0, 1).toUpperCase()}:\\`;
    const rest = relative.slice(2).split(/[\\/]/u).filter((part) => part.length > 0 && part !== ".");
    if (rest.some((part) => part === "..")) {
      throw new WorkspaceError("outside_workspace", "Workspace path is outside the workspace.");
    }
    return { kind: "host", root, relative: rest.length === 0 ? "." : rest.join("\\") };
  }
  const shared = /^shared:\/\//iu.test(relative);
  const parts = (shared ? relative.slice("shared://".length) : relative).split(/[\\/]/u).filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new WorkspaceError("outside_workspace", "Workspace path is outside the workspace.");
  }
  if (parts.length === 0 && !shared) return { kind: "root" };
  const mount = sharedDirectoryName(parts[0] ?? "");
  if (shared) {
    if (!mount) throw new WorkspaceError("invalid_path", "Shared folder name is invalid.");
    return {
      kind: "shared",
      mount,
      relative: parts.length === 1 ? "." : parts.slice(1).join("\\"),
    };
  }
  return { kind: "home", relative: parts.join("\\") };
}

const stripTrailingSep = (value: string): string => {
  const normalized = path.normalize(value);
  if (/^[a-z]:\\$/iu.test(normalized)) return normalized.toLowerCase();
  return normalized.replace(/[\\/]+$/u, "").toLowerCase();
};

export function isBlockedUserRoot(absolute: string): boolean {
  const normalized = stripTrailingSep(absolute);
  const driveRoot = stripTrailingSep(path.parse(path.normalize(absolute)).root);
  if (normalized === driveRoot) return true;
  if (/^[a-z]:\\users$/iu.test(normalized)) return true;
  if (BLOCKED_SYSTEM_ROOT.some((pattern) => pattern.test(normalized))) return true;
  const appdata = normalized.match(/\\appdata\\(local|roaming|locallow)(?:\\|$)/iu);
  if (!appdata) return false;
  return !(normalized.includes("\\temp\\") || normalized.endsWith("\\temp"));
}

export async function openSharedUserMount(
  userProfile: string,
  name: SharedUserDirectory,
): Promise<WorkspaceSandbox | undefined> {
  if (typeof userProfile !== "string" || userProfile.length === 0 || userProfile.includes("\0")) {
    return undefined;
  }
  const folder = path.join(path.resolve(userProfile), name);
  if (isBlockedUserRoot(folder)) return undefined;
  try {
    const sandbox = await WorkspaceSandbox.create(folder, {
      allowAncestorLinks: true,
      allowRootReparse: true,
    });
    if (isBlockedUserRoot(sandbox.root)) return undefined;
    return sandbox;
  } catch (error) {
    if (
      error instanceof WorkspaceError &&
      (error.code === "not_found" || error.code === "outside_workspace" || error.code === "invalid_path" || error.code === "access_denied")
    ) {
      return undefined;
    }
    throw error;
  }
}

const MOUNT_CACHE_TTL_MS = 30_000;
const mountCache = new Map<string, { at: number; mounts: ReadonlyMap<SharedUserDirectory, WorkspaceSandbox> }>();

export async function loadSharedUserMounts(
  userProfile: string,
): Promise<ReadonlyMap<SharedUserDirectory, WorkspaceSandbox>> {
  const key = path.resolve(userProfile).toLowerCase();
  const cached = mountCache.get(key);
  if (cached && Date.now() - cached.at < MOUNT_CACHE_TTL_MS) return cached.mounts;
  const mounts = new Map<SharedUserDirectory, WorkspaceSandbox>();
  for (const name of SHARED_USER_DIRECTORIES) {
    const mount = await openSharedUserMount(userProfile, name);
    if (mount) mounts.set(name, mount);
  }
  mountCache.set(key, { at: Date.now(), mounts });
  return mounts;
}

const ignorableRedirectError = (error: unknown): boolean =>
  error instanceof WorkspaceError &&
  (error.code === "not_found" || error.code === "outside_workspace" || error.code === "invalid_path" || error.code === "access_denied");

/** Opens a per-bot redirect only when it already exists. Does not create folders. */
export async function openExistingSharedRedirect(
  userProfile: string,
  name: SharedUserDirectory,
  agentId: string,
): Promise<WorkspaceSandbox | undefined> {
  const redirectRoot = agentSharedDirectoryRoot(userProfile, name, agentId);
  try {
    const redirect = await WorkspaceSandbox.create(redirectRoot, {
      allowAncestorLinks: true,
      allowRootReparse: true,
    });
    if (isBlockedUserRoot(redirect.root)) return undefined;
    return redirect;
  } catch (error) {
    if (ignorableRedirectError(error)) return undefined;
    throw error;
  }
}

/** Creates the per-bot redirect tree on first write and returns its sandbox. */
export async function materializeSharedRedirect(
  userProfile: string,
  name: SharedUserDirectory,
  agentId: string,
): Promise<WorkspaceSandbox | undefined> {
  const redirectRoot = agentSharedDirectoryRoot(userProfile, name, agentId);
  try {
    await mkdir(redirectRoot, { recursive: true });
    const redirect = await WorkspaceSandbox.create(redirectRoot, {
      allowAncestorLinks: true,
      allowRootReparse: true,
    });
    if (isBlockedUserRoot(redirect.root)) return undefined;
    return redirect;
  } catch (error) {
    if (ignorableRedirectError(error)) return undefined;
    throw error;
  }
}

/**
 * Only explicit shared:// paths use these mounts. All ordinary relative paths
 * belong to the physical home, regardless of grants.
 */
export async function loadAgentVisibleUserMounts(
  userProfile: string,
  agentId: string,
  accessFor: (name: SharedUserDirectory) => "none" | "read" | "write",
): Promise<ReadonlyMap<SharedUserDirectory, WorkspaceSandbox>> {
  validateAgentPathId(agentId);
  const realMounts = await loadSharedUserMounts(userProfile);
  const mounts = new Map<SharedUserDirectory, WorkspaceSandbox>();
  for (const name of SHARED_USER_DIRECTORIES) {
    if (accessFor(name) !== "none") {
      const real = realMounts.get(name);
      if (real) mounts.set(name, real);
      continue;
    }
  }
  return mounts;
}

export interface BrowserUploadTarget {
  /** Trusted root the browser host will contain the read inside. Must not be a reparse point. */
  root: string;
  /** Path relative to `root`, still model-safe (no drive, no `..`). */
  path: string;
}

/** Resolve a bot-visible relative path against the private home and optional shared mounts. */
export async function resolveAgentVisiblePath(
  homeRoot: string,
  relative: string,
  mounts: ReadonlyMap<SharedUserDirectory, WorkspaceSandbox>,
): Promise<string> {
  const classified = classifyAgentPath(relative);
  if (classified.kind === "root") {
    const home = await WorkspaceSandbox.create(homeRoot, { allowAncestorLinks: true });
    return home.root;
  }
  if (classified.kind === "shared") {
    const mount = mounts.get(classified.mount);
    if (mount) return mount.resolveExisting(classified.relative);
    throw new WorkspaceError("access_denied", "Shared folder is not granted or unavailable.");
  }
  const home = await WorkspaceSandbox.create(homeRoot, { allowAncestorLinks: true });
  return home.resolveExisting(classified.kind === "home" ? classified.relative : relative);
}

/** Resolve a browser upload to the authorized host root + relative path pair. */
export async function resolveBrowserUploadTarget(
  homeRoot: string,
  relative: string,
  mounts: ReadonlyMap<SharedUserDirectory, WorkspaceSandbox>,
): Promise<BrowserUploadTarget> {
  const classified = classifyAgentPath(relative);
  if (classified.kind === "root" || (classified.kind === "shared" && classified.relative === ".")) {
    throw new WorkspaceError("invalid_path", "Workspace path is invalid.");
  }
  if (classified.kind === "shared") {
    const mount = mounts.get(classified.mount);
    if (mount) {
      await mount.resolveExisting(classified.relative);
      return { root: mount.root, path: classified.relative.replaceAll("\\", "/") };
    }
    throw new WorkspaceError("access_denied", "Shared folder is not granted or unavailable.");
  }
  const home = await WorkspaceSandbox.create(homeRoot, { allowAncestorLinks: true });
  const homeRelative = classified.kind === "home" ? classified.relative : relative;
  await home.resolveExisting(homeRelative);
  return { root: homeRoot, path: homeRelative.replaceAll("\\", "/") };
}
