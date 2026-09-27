import { realpathSync } from "node:fs";
import path from "node:path";

import { isLocalOrAdministrativeShare } from "./user-files.js";
import { WorkspaceError } from "./workspace.js";

export const PROTECTED_PATH_MESSAGE = "This path belongs to OpenBot's private data or to another bot's home and cannot be used by this bot.";

export class ProtectedPathError extends WorkspaceError {
  constructor() {
    super("access_denied", PROTECTED_PATH_MESSAGE);
    this.name = "ProtectedPathError";
  }
}

export interface ProtectedPathsOptions {
  /** Directories owned by OpenBot itself: state, credentials, runtime, browser profiles and all bot homes. */
  directories: readonly string[];
  /** Individual OpenBot files; SQLite sidecars (`-wal`, `-shm`, `-journal`) are covered with them. */
  files?: readonly string[];
}

const normalize = (value: string): string => path.win32.resolve(value).replace(/[\\/]+$/u, "").toLowerCase();

const within = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(`${root}\\`);

/** Canonical form of the nearest existing ancestor plus the not-yet-existing remainder. */
const canonical = (value: string): string | undefined => {
  let current = path.win32.resolve(value);
  const remainder: string[] = [];
  for (;;) {
    try {
      return path.win32.join(realpathSync.native(current), ...remainder);
    } catch {
      const parent = path.win32.dirname(current);
      if (parent === current) return undefined;
      remainder.unshift(path.win32.basename(current));
      current = parent;
    }
  }
};

const isUncPath = (value: string): boolean => /^[\\/]{2}(?![?.][\\/])/u.test(value);

/** Spelling and canonical form, so a junction or 8.3 alias is treated as its target. */
const forms = (value: string): string[] => {
  const lexical = normalize(value);
  // A remote share cannot hold this machine's OpenBot data, and resolving it
  // would block the event loop for as long as the server takes to answer.
  if (isUncPath(value)) return [lexical];
  const resolved = canonical(value);
  const real = resolved === undefined ? lexical : normalize(resolved);
  return real === lexical ? [lexical] : [lexical, real];
};

/**
 * Paths a bot must not reach through structured tools or as a process cwd /
 * executable, even though host access is otherwise trusted. The bot's own
 * home is exempt although it lives inside the protected workspaces root.
 * Bots run as the Windows user, so this is not an OS boundary: it removes the
 * direct tool routes to OpenBot's secrets, store and sibling homes.
 */
export class ProtectedPaths {
  private readonly directories: string[];
  private readonly files: string[];
  private readonly exempt: string[];

  constructor(options: ProtectedPathsOptions, exemptRoot?: string) {
    this.directories = [...new Set(options.directories.flatMap(forms))];
    this.files = [...new Set((options.files ?? []).flatMap(forms))];
    this.exempt = exemptRoot === undefined ? [] : forms(exemptRoot);
  }

  forHome(homeRoot: string): ProtectedPaths {
    return new ProtectedPaths({ directories: this.directories, files: this.files }, homeRoot);
  }

  /** Lexical check, for names produced by a directory walk; use blocksResolved for caller-supplied paths. */
  blocks(candidate: string): boolean {
    const target = normalize(candidate);
    if (this.exempt.some((root) => within(root, target))) return false;
    return this.directories.some((root) => within(root, target))
      || this.files.some((file) => target === file || target.startsWith(`${file}-`));
  }

  /**
   * Checks the spelling and the canonical target, including paths that do not
   * exist yet. A share that loops back to this machine or is administrative
   * (`C$`) could reach anything local, so it is blocked outright.
   */
  blocksResolved(candidate: string): boolean {
    if (isLocalOrAdministrativeShare(candidate)) return true;
    return forms(candidate).some((form) => this.blocks(form));
  }

  /** For tree walks: an ancestor of the exempt home stays traversable so the walk can reach it. */
  blocksDescent(candidate: string): boolean {
    const target = normalize(candidate);
    return this.blocks(target) && !this.exempt.some((root) => within(target, root));
  }
}
