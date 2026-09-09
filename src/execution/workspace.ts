import { lstat, realpath } from "node:fs/promises";
import { win32 as path } from "node:path";

import { MAX_EXECUTION_PATH_BYTES, type ExecutionErrorCode } from "./contracts.js";

type WorkspaceErrorCode = Extract<ExecutionErrorCode, "invalid_path" | "outside_workspace" | "not_found" | "access_denied" | "io_error">;

const MESSAGES = {
  invalidRoot: "Workspace root is invalid.",
  missingRoot: "Workspace root does not exist.",
  rootNotDirectory: "Workspace root is not a directory.",
  unsafeRoot: "Workspace root contains a symbolic link or junction.",
  invalidPath: "Workspace path is invalid.",
  outsideWorkspace: "Workspace path is outside the workspace.",
  missingPath: "Workspace path does not exist.",
  unsafePath: "Workspace path contains a symbolic link or junction.",
  accessDenied: "Workspace path cannot be accessed.",
  ioError: "Workspace path could not be verified.",
} as const;

/** An error safe to return across the execution boundary. */
export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

const isMissing = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
};

const sanitizedFsError = (error: unknown, missingMessage: string): WorkspaceError => {
  if (isMissing(error)) return new WorkspaceError("not_found", missingMessage);
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") return new WorkspaceError("access_denied", MESSAGES.accessDenied);
  return new WorkspaceError("io_error", MESSAGES.ioError);
};

const pathSegments = (base: string, target: string): string[] => {
  const relative = path.relative(base, target);
  return relative === "" ? [] : relative.split("\\");
};

const samePath = (left: string, right: string): boolean => path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();

const INVALID_WINDOWS_COMPONENT = /[<>:"|?*\u0000-\u001f]/u;
const RESERVED_WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu;

const invalidPath = (): WorkspaceError => new WorkspaceError("invalid_path", MESSAGES.invalidPath);
const outsideWorkspace = (): WorkspaceError => new WorkspaceError("outside_workspace", MESSAGES.outsideWorkspace);

/**
 * Validate before calling path.resolve: resolve deliberately erases aliases
 * such as `directory\\..`, trailing separators, and repeated separators.
 */
const validateRelativeComponents = (relative: string): void => {
  const components = relative.split(/[\\/]/u);

  for (const component of components) {
    if (component === "..") throw outsideWorkspace();
    if (component === ".") continue;

    if (component.length === 0 || INVALID_WINDOWS_COMPONENT.test(component) || /[ .]$/u.test(component)) {
      throw invalidPath();
    }

    // Device names remain reserved with an extension (for example NUL.txt).
    const stem = component.split(".", 1)[0] ?? "";
    if (RESERVED_WINDOWS_DEVICE.test(stem)) throw invalidPath();
  }
};

async function assertRootHasNoLinks(absoluteRoot: string, skipLeaf = false): Promise<void> {
  const volumeRoot = path.parse(absoluteRoot).root;
  const segments = pathSegments(volumeRoot, absoluteRoot);
  let current = volumeRoot;

  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    if (skipLeaf && index === segments.length - 1) return;
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (isMissing(error)) throw new WorkspaceError("not_found", MESSAGES.missingRoot);
      throw sanitizedFsError(error, MESSAGES.missingRoot);
    }
    if (metadata.isSymbolicLink()) {
      throw new WorkspaceError("outside_workspace", MESSAGES.unsafeRoot);
    }
  }
}

/**
 * Grounds untrusted relative paths in one workspace.
 *
 * Input paths are always interpreted with Windows rules, independent of the
 * host path module's default semantics. Child reparse points are never
 * followed. The root itself may be a junction only when `allowRootReparse` is
 * set; the sandbox then uses that realpath.
 */
export interface WorkspaceCreateOptions {
  /** When true, ancestor reparse points (redirected LocalAppData) are allowed. The leaf must still not be a link. */
  allowAncestorLinks?: boolean;
  /**
   * When true, the root itself may be a junction/symlink (OneDrive Documents).
   * The sandbox uses the realpath and still rejects every child reparse point.
   */
  allowRootReparse?: boolean;
}

export class WorkspaceSandbox {
  private constructor(readonly root: string) {}

  static async create(root: string, options: WorkspaceCreateOptions = {}): Promise<WorkspaceSandbox> {
    if (
      typeof root !== "string" ||
      root.length === 0 ||
      root.includes("\0") ||
      Buffer.byteLength(root) > MAX_EXECUTION_PATH_BYTES
    ) {
      throw new WorkspaceError("invalid_path", MESSAGES.invalidRoot);
    }

    const absoluteRoot = path.resolve(root);
    if (Buffer.byteLength(absoluteRoot) > MAX_EXECUTION_PATH_BYTES) {
      throw new WorkspaceError("invalid_path", MESSAGES.invalidRoot);
    }
    if (!options.allowAncestorLinks) await assertRootHasNoLinks(absoluteRoot, options.allowRootReparse === true);

    let metadata;
    try {
      metadata = await lstat(absoluteRoot);
    } catch (error) {
      if (isMissing(error)) throw new WorkspaceError("not_found", MESSAGES.missingRoot);
      throw sanitizedFsError(error, MESSAGES.missingRoot);
    }
    if (metadata.isSymbolicLink()) {
      if (!options.allowRootReparse) {
        throw new WorkspaceError("outside_workspace", MESSAGES.unsafeRoot);
      }
    } else if (!metadata.isDirectory()) {
      throw new WorkspaceError("invalid_path", MESSAGES.rootNotDirectory);
    }

    try {
      const canonicalRoot = await realpath(absoluteRoot);
      // This is a second line of defence for reparse points that lstat does not
      // classify as links. It also prevents returning a root on another path.
      if (!options.allowAncestorLinks && !options.allowRootReparse && !samePath(canonicalRoot, absoluteRoot)) {
        throw new WorkspaceError("outside_workspace", MESSAGES.unsafeRoot);
      }
      const canonicalMetadata = await lstat(canonicalRoot);
      if (canonicalMetadata.isSymbolicLink() || !canonicalMetadata.isDirectory()) {
        throw new WorkspaceError("invalid_path", MESSAGES.rootNotDirectory);
      }
      return new WorkspaceSandbox(canonicalRoot);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (isMissing(error)) throw new WorkspaceError("not_found", MESSAGES.missingRoot);
      throw sanitizedFsError(error, MESSAGES.missingRoot);
    }
  }

  async resolveExisting(relative: string): Promise<string> {
    const destination = this.resolveLexically(relative);
    await this.verifyNoLinks(destination, false);
    return destination;
  }

  async resolveDestination(relative: string): Promise<string> {
    const destination = this.resolveLexically(relative);
    await this.verifyNoLinks(destination, true);
    return destination;
  }

  private resolveLexically(relative: string): string {
    if (
      typeof relative !== "string" ||
      relative.length === 0 ||
      relative.includes("\0") ||
      Buffer.byteLength(relative) > MAX_EXECUTION_PATH_BYTES
    ) {
      throw new WorkspaceError("invalid_path", MESSAGES.invalidPath);
    }

    // A drive-relative path (C:foo) is not considered absolute by isAbsolute,
    // so checking parse().root as well is intentional.
    if (path.isAbsolute(relative) || path.parse(relative).root !== "") {
      throw new WorkspaceError("outside_workspace", MESSAGES.outsideWorkspace);
    }
    validateRelativeComponents(relative);

    const destination = path.resolve(this.root, relative);
    if (Buffer.byteLength(destination) > MAX_EXECUTION_PATH_BYTES) throw invalidPath();
    const fromRoot = path.relative(this.root, destination);
    if (fromRoot === ".." || fromRoot.startsWith("..\\") || path.isAbsolute(fromRoot)) {
      throw new WorkspaceError("outside_workspace", MESSAGES.outsideWorkspace);
    }
    return destination;
  }

  private async verifyNoLinks(destination: string, allowMissingLeaf: boolean): Promise<void> {
    let current = this.root;
    const segments = pathSegments(this.root, destination);
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      let metadata;
      try {
        metadata = await lstat(current);
      } catch (error) {
        const isLeaf = index === segments.length - 1;
        if (allowMissingLeaf && isLeaf && errorCode(error) === "ENOENT") return;
        throw sanitizedFsError(error, MESSAGES.missingPath);
      }
      if (metadata.isSymbolicLink()) {
        throw new WorkspaceError("outside_workspace", MESSAGES.unsafePath);
      }

      try {
        if (!samePath(await realpath(current), current)) {
          throw new WorkspaceError("outside_workspace", MESSAGES.unsafePath);
        }
      } catch (error) {
        if (error instanceof WorkspaceError) throw error;
        throw sanitizedFsError(error, MESSAGES.missingPath);
      }
    }
  }
}
