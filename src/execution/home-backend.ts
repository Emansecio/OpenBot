import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { win32 as path } from "node:path";

import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "./contracts.js";
import { LocalCommandExecutor } from "./commands.js";
import { LocalFileExecutor } from "./files.js";
import { effectiveGrant, readSharedGrants } from "./home-grants.js";
import { extractRequestPaths } from "./policy.js";
import {
  DEFAULT_WORKSPACE_QUOTA,
  DEFAULT_WORKSPACE_QUOTA_SCOPES,
  WorkspaceQuota,
  type WorkspaceQuotaOptions,
} from "./quota.js";
import {
  assertPathAbsent,
  copySafeTreeAtomic,
  inspectSafeTree,
  renameOrCopy,
  SafeTreeError,
} from "./safe-tree.js";
import {
  classifyAgentPath,
  isAbsoluteWindowsPath,
  isReservedHomeRelative,
  loadSharedUserMounts,
  openExistingSharedRedirect,
  openSharedUserMount,
  SHARED_USER_DIRECTORIES,
  type ClassifiedAgentPath,
  type SharedUserDirectory,
} from "./user-files.js";
import { WorkspaceError, WorkspaceSandbox } from "./workspace.js";

const RESERVED_AGENT_DIRECTORIES = [".openbot"] as const;

/** Operations that mutate a mount; blocked when the grant is read-only. */
const MOUNT_WRITE_OPERATIONS = new Set<ExecutionRequest["operation"]>([
  "file.write",
  "file.mkdir",
  "file.trash",
  "file.move",
  "file.copy",
  "file.restore",
]);

const isAdministrativeSearch = (request: Extract<ExecutionRequest, { operation: "command.run" }>): boolean => {
  const cwdComponents = request.cwd.split(/[\\/]/u);
  if (cwdComponents.some((component) => component === ".." || RESERVED_AGENT_DIRECTORIES.some((name) => component.toLowerCase() === name.toLowerCase()))) {
    return true;
  }
  return request.params.paths.some((scope) => {
    const components = scope.split(/[\\/]/u);
    if (components.some((component) => component === "..")) return true;
    const resolved = path.normalize(path.join(request.cwd, scope));
    if (resolved === ".") return true;
    const first = resolved.split(/[\\/]/u)[0] ?? "";
    return RESERVED_AGENT_DIRECTORIES.some((name) => first.toLowerCase() === name.toLowerCase());
  });
};

const joinVirtual = (cwd: string, scope: string): string => {
  if (isAbsoluteWindowsPath(scope) || /^shared:\/\//iu.test(scope)) return scope;
  if (scope === "." || scope.length === 0) return cwd;
  if (cwd === "." || cwd.length === 0) return scope;
  return /^shared:\/\//iu.test(cwd) ? `${cwd}/${scope}` : path.join(cwd, scope);
};

const validTrashId = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);

const failure = (
  operation: ExecutionRequest["operation"],
  code: Extract<ExecutionResult, { ok: false }>["code"],
  message: string,
): ExecutionResult => ({ ok: false, operation, code, message });

const fromWorkspaceError = (operation: ExecutionRequest["operation"], error: WorkspaceError): ExecutionResult => {
  const message =
    error.code === "invalid_path"
      ? "File path is invalid."
      : error.code === "outside_workspace"
        ? "File path is outside the workspace."
        : error.code === "not_found"
          ? "File path does not exist."
          : error.code === "access_denied"
            ? "File operation is not permitted."
            : "File operation failed.";
  return failure(operation, error.code, message);
};

const fromSafeTreeError = (operation: ExecutionRequest["operation"], error: SafeTreeError): ExecutionResult =>
  failure(operation, error.code, error.message);

const abortIfRequested = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new SafeTreeError("aborted", "File operation was aborted.");
};

const fsCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

interface MountExecutors {
  workspace: WorkspaceSandbox;
  files: LocalFileExecutor;
  commands: LocalCommandExecutor;
  /** True when the grant only allows reading the real user folder. */
  readOnly: boolean;
}

export interface HomeWorkspaceBackendOptions {
  /** Profile for explicit shared:// folder references. Relative paths stay in the home. */
  userProfile?: string;
  /**
   * Agent identity for grant evaluation. When provided together with
   * `userProfile`, `.openbot/grants.json` decides which real folders the bot
   * sees through shared:// references (read/write).
   * Without `agentId`, the legacy shared mode applies (all mounts read-write).
   */
  agentId?: string;
  /** Optional quota override for focused runtime and backend tests. */
  quota?: WorkspaceQuotaOptions;
}

const readOnlyFailure = (operation: ExecutionRequest["operation"]): ExecutionResult =>
  failure(operation, "access_denied", "Shared folder is read-only for this bot.");

export class HomeWorkspaceBackend implements ExecutionBackend {
  private constructor(
    readonly workspace: WorkspaceSandbox,
    readonly quota: WorkspaceQuota,
    private readonly files: LocalFileExecutor,
    private readonly commands: LocalCommandExecutor,
    private readonly mounts: Map<SharedUserDirectory, MountExecutors>,
    private readonly userProfile?: string,
    private readonly agentId?: string,
  ) {}

  static async create(root: string, options: HomeWorkspaceBackendOptions = {}): Promise<HomeWorkspaceBackend> {
    const workspace = await WorkspaceSandbox.create(root, { allowAncestorLinks: true });
    const quota = new WorkspaceQuota(
      workspace,
      options.quota ?? { ...DEFAULT_WORKSPACE_QUOTA, scopes: DEFAULT_WORKSPACE_QUOTA_SCOPES },
    );
    const overlay = options.userProfile !== undefined;
    const mounts = new Map<SharedUserDirectory, MountExecutors>();
    // Per-agent grants are loaded per shared operation; private work needs no mounts.
    if (overlay && options.agentId === undefined) {
      // Legacy shared mode: every real user folder is mounted read-write.
      for (const [name, sandbox] of await loadSharedUserMounts(options.userProfile!)) {
        mounts.set(name, {
          workspace: sandbox,
          files: LocalFileExecutor.fromWorkspace(sandbox),
          commands: LocalCommandExecutor.fromWorkspace(sandbox),
          readOnly: false,
        });
      }
    }
    return new HomeWorkspaceBackend(
      workspace,
      quota,
      LocalFileExecutor.fromWorkspace(workspace, quota, {
        reservedTopLevel: RESERVED_AGENT_DIRECTORIES,
        trashRoot: path.join(workspace.root, ".openbot", "trash"),
      }),
      LocalCommandExecutor.fromWorkspace(workspace),
      mounts,
      options.userProfile,
      options.agentId,
    );
  }

  /**
   * Explicit shared references require a current read or write grant.
   * Corrupt grants metadata fails closed with a clear error.
   */
  private static async loadGrantedMounts(
    mounts: Map<SharedUserDirectory, MountExecutors>,
    homeRoot: string,
    userProfile: string,
  ): Promise<void> {
    const grants = await readSharedGrants(homeRoot);
    for (const name of SHARED_USER_DIRECTORIES) {
      const access = effectiveGrant(grants, name);
      if (access !== "none") {
        const sandbox = await openSharedUserMount(userProfile, name);
        if (sandbox) {
          mounts.set(name, {
            workspace: sandbox,
            files: LocalFileExecutor.fromWorkspace(sandbox),
            commands: LocalCommandExecutor.fromWorkspace(sandbox),
            readOnly: access === "read",
          });
          continue;
        }
      }
    }
  }


  private readonly hostMounts = new Map<string, MountExecutors>();

  /**
   * On-demand sandbox for drive-letter absolute paths (`C:\...`). Every drive
   * is addressable; symlink/reparse verification still applies via
   * WorkspaceSandbox, but no grant or system-root block is enforced.
   */
  private async hostMount(driveRoot: string): Promise<MountExecutors> {
    const key = driveRoot.toLowerCase();
    const existing = this.hostMounts.get(key);
    if (existing) return existing;
    const workspace = await WorkspaceSandbox.create(driveRoot, { allowAncestorLinks: true });
    const mount: MountExecutors = {
      workspace,
      files: LocalFileExecutor.fromWorkspace(workspace),
      commands: LocalCommandExecutor.fromWorkspace(workspace),
      readOnly: false,
    };
    this.hostMounts.set(key, mount);
    return mount;
  }

  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const needsSharedMounts = request.operation === "workspace.info" ||
      extractRequestPaths(request).some((value) => /^shared:\/\//iu.test(value)) ||
      request.operation === "file.restore";
    if (needsSharedMounts && this.userProfile !== undefined && this.agentId !== undefined) {
      // A backend is cached for the bot's lifetime; grants are not. Keep each
      // operation's mount snapshot private so concurrent requests cannot swap it.
      const mounts = new Map<SharedUserDirectory, MountExecutors>();
      try {
        await HomeWorkspaceBackend.loadGrantedMounts(mounts, this.workspace.root, this.userProfile);
      } catch {
        return failure(request.operation, "access_denied", "Shared folder grants could not be verified.");
      }
      const current = new HomeWorkspaceBackend(this.workspace, this.quota, this.files, this.commands,
        mounts, this.userProfile, this.agentId);
      return current.executeResolved(request, signal);
    }
    return this.executeResolved(request, signal);
  }

  private executeResolved(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    if (request.operation === "workspace.info") return this.workspaceInfo();
    if (request.operation === "command.run") {
      if (isAdministrativeSearch(request)) {
        return Promise.resolve({
          ok: false,
          operation: request.operation,
          code: "access_denied",
          message: "Workspace path cannot be accessed.",
        });
      }
      return this.executeSearch(request, signal);
    }
    return this.executeFile(request, signal);
  }

  private async workspaceInfo(): Promise<ExecutionResult> {
    const legacyFolders: { name: string; path: string }[] = [];
    if (this.userProfile !== undefined && this.agentId !== undefined) {
      for (const name of SHARED_USER_DIRECTORIES) {
        const legacy = await openExistingSharedRedirect(this.userProfile, name, this.agentId);
        if (legacy) legacyFolders.push({ name, path: legacy.root });
      }
    }
    return {
      ok: true, operation: "workspace.info", homeRoot: this.workspace.root,
      sharedFolders: [...this.mounts].map(([name, mount]) => ({
        name: `shared://${name}`, path: mount.workspace.root, access: mount.readOnly ? "read" : "write",
      })),
      legacyFolders,
    };
  }

  private async executeSearch(
    request: Extract<ExecutionRequest, { operation: "command.run" }>,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const started = Date.now();
    const lines: string[] = [];
    let matched = false;
    for (const scope of request.params.paths.map((item) => joinVirtual(request.cwd, item))) {
      let classified: ClassifiedAgentPath;
      try {
        classified = classifyAgentPath(scope);
      } catch (error) {
        if (error instanceof WorkspaceError) return fromWorkspaceError(request.operation, error);
        throw error;
      }
      if (classified.kind === "root") {
        return failure(request.operation, "access_denied", "Workspace path cannot be accessed.");
      }
      if (classified.kind === "home") {
        const result = await this.commands.execute({
          ...request,
          cwd: ".",
          params: { ...request.params, paths: [classified.relative] },
        }, signal);
        if (!result.ok) return result;
        if (result.operation !== "command.run") return result;
        if (result.stdout.length > 0) lines.push(result.stdout);
        if (result.exitCode === 0) matched = true;
        continue;
      }
      if (classified.kind === "host") {
        let host: MountExecutors;
        try {
          host = await this.hostMount(classified.root);
        } catch (error) {
          if (error instanceof WorkspaceError) return fromWorkspaceError(request.operation, error);
          throw error;
        }
        const result = await host.commands.execute({
          ...request,
          cwd: ".",
          params: { ...request.params, paths: [classified.relative] },
        }, signal);
        if (!result.ok) return result;
        if (result.operation !== "command.run") return result;
        const prefix = `${classified.root.replaceAll("\\", "/")}`;
        for (const line of result.stdout.split("\n")) {
          if (line.length === 0) continue;
          lines.push(`${prefix}${line}`);
        }
        if (result.exitCode === 0) matched = true;
        continue;
      }
      const mount = this.mounts.get(classified.mount);
      if (!mount) return failure(request.operation, "access_denied", "Shared folder is not granted or unavailable.");
      const result = await mount.commands.execute({
        ...request,
        cwd: ".",
        params: { ...request.params, paths: [classified.relative] },
      }, signal);
      if (!result.ok) return result;
      if (result.operation !== "command.run") return result;
      const prefix = `shared://${classified.mount}/`;
      for (const line of result.stdout.split("\n")) {
        if (line.length === 0) continue;
        lines.push(`${prefix}${line}`);
      }
      if (result.exitCode === 0) matched = true;
    }
    return {
      ok: true,
      operation: "command.run",
      command: request.command,
      stdout: lines.join("\n"),
      stderr: "",
      exitCode: request.command === "search.files" ? 0 : matched ? 0 : 1,
      durationMs: Date.now() - started,
    };
  }

  private async executeFile(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    try {
      abortIfRequested(signal);
      switch (request.operation) {
        case "file.list":
          return await this.listRouted(request, signal);
        case "file.copy":
          return await this.copyRouted(request, signal);
        case "file.move":
          return await this.moveRouted(request, signal);
        case "file.trash":
          return await this.trashRouted(request, signal);
        case "file.restore":
          return await this.restoreRouted(request, signal);
        case "file.read":
        case "file.stat":
        case "file.mkdir":
        case "file.write":
          return await this.singlePathRouted(request, signal);
        default:
          return this.files.execute(request, signal);
      }
    } catch (error) {
      if (error instanceof SafeTreeError) return fromSafeTreeError(request.operation, error);
      if (error instanceof WorkspaceError) return fromWorkspaceError(request.operation, error);
      const code = fsCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return failure(request.operation, "not_found", "File path does not exist.");
      if (code === "EACCES" || code === "EPERM") return failure(request.operation, "access_denied", "File operation is not permitted.");
      if (code === "EEXIST") return failure(request.operation, "invalid_path", "File path is invalid.");
      throw error;
    }
  }

  private async listRouted(
    request: Extract<ExecutionRequest, { operation: "file.list" }>,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const classified = classifyAgentPath(request.path);
    return this.delegateClassified(classified, request, signal);
  }

  private async singlePathRouted(
    request: Extract<ExecutionRequest, { operation: "file.read" | "file.stat" | "file.mkdir" | "file.write" }>,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const classified = classifyAgentPath(request.path);
    if (classified.kind === "root") {
      if (request.operation === "file.stat") {
        return { ok: true, operation: "file.stat", kind: "directory", bytes: 0 };
      }
      return failure(request.operation, "invalid_path", "File path is invalid.");
    }
    if (classified.kind === "shared" && classified.relative === "." && request.operation === "file.mkdir") {
      if (this.mounts.get(classified.mount)?.readOnly) return readOnlyFailure(request.operation);
      return this.mounts.has(classified.mount)
        ? { ok: true, operation: "file.mkdir", created: false }
        : failure(request.operation, "access_denied", "Shared folder is not granted or unavailable.");
    }
    return this.delegateClassified(classified, request, signal);
  }

  private async copyRouted(
    request: Extract<ExecutionRequest, { operation: "file.copy" }>,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    return this.transferRouted(request.source, request.destination, "copy", request, signal);
  }

  private async moveRouted(
    request: Extract<ExecutionRequest, { operation: "file.move" }>,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    return this.transferRouted(request.source, request.destination, "move", request, signal);
  }

  private async transferRouted(
    sourcePath: string,
    destinationPath: string,
    mode: "copy" | "move",
    request: Extract<ExecutionRequest, { operation: "file.copy" | "file.move" }>,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const source = classifyAgentPath(sourcePath);
    const destination = classifyAgentPath(destinationPath);
    if (source.kind === "root" || destination.kind === "root") {
      return failure(request.operation, "invalid_path", "File path is invalid.");
    }
    const destinationMount = this.mountFor(destination);
    if (destinationMount?.readOnly) return readOnlyFailure(request.operation);
    if (mode === "move" && this.mountFor(source)?.readOnly) return readOnlyFailure(request.operation);
    if (this.sameMount(source, destination)) {
      const sourceMount = this.mountFor(source);
      if (sourceMount?.readOnly) return readOnlyFailure(request.operation);
      const rewritten = {
        ...request,
        source: source.relative,
        destination: destination.relative,
      };
      return this.delegateClassified(source, rewritten, signal);
    }
    const sourceExec = await this.executorsFor(source);
    const destExec = await this.executorsFor(destination);
    if (!sourceExec || !destExec) return failure(request.operation, "access_denied", "Shared folder is not granted or unavailable.");
    if (source.relative === "." || destination.relative === ".") {
      return failure(request.operation, "invalid_path", "File path is invalid.");
    }
    if (
      (source.kind === "home" && isReservedHomeRelative(source.relative)) ||
      (destination.kind === "home" && isReservedHomeRelative(destination.relative))
    ) {
      return failure(request.operation, "access_denied", "File operation is not permitted.");
    }
    const sourceAbs = await sourceExec.workspace.resolveExisting(source.relative);
    const destAbs = await destExec.workspace.resolveDestination(destination.relative);
    await destExec.workspace.resolveExisting(path.dirname(destination.relative));
    await assertPathAbsent(destAbs);
    const summary = await inspectSafeTree(sourceAbs, signal);
    let reservation: { commit(): void; cancel(): void } | undefined;
    if (destination.kind === "home") {
      reservation = await this.quota.reserveDelta({
        bytes: summary.bytes,
        files: summary.files,
        entries: summary.entries,
      }, destAbs);
    }
    try {
      if (mode === "copy") {
        const copied = await copySafeTreeAtomic(sourceAbs, destAbs, signal);
        reservation?.commit();
        reservation = undefined;
        return { ok: true, operation: "file.copy", bytes: copied.bytes, entries: copied.entries };
      }
      await renameOrCopy(sourceAbs, destAbs, signal);
      reservation?.commit();
      reservation = undefined;
      this.quota.markUsageDirty();
      return { ok: true, operation: "file.move" };
    } catch (error) {
      if (mode === "move") this.quota.markUsageDirty();
      throw error;
    } finally {
      reservation?.cancel();
    }
  }

  private async trashRouted(
    request: Extract<ExecutionRequest, { operation: "file.trash" }>,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const classified = classifyAgentPath(request.path);
    if (classified.kind !== "shared" && classified.kind !== "host") return this.files.execute(request, signal);
    if (classified.relative === ".") return failure(request.operation, "invalid_path", "File path is invalid.");
    const mount = classified.kind === "host"
      ? await this.hostMount(classified.root)
      : this.mounts.get(classified.mount);
    if (!mount) return failure(request.operation, "access_denied", "Shared folder is not granted or unavailable.");
    if (mount.readOnly) return readOnlyFailure(request.operation);
    const source = await mount.workspace.resolveExisting(classified.relative);
    const summary = await inspectSafeTree(source, signal);
    const trashRoot = path.join(this.workspace.root, ".openbot", "trash");
    const trashId = randomUUID();
    const entry = path.join(trashRoot, trashId);
    const payload = path.join(entry, "payload");
    const marker = path.join(entry, "meta.json");
    const storedPath = classified.kind === "host"
      ? `${classified.root.replaceAll("\\", "/")}${classified.relative.replaceAll("\\", "/")}`
      : `shared://${classified.mount}/${classified.relative.replaceAll("\\", "/")}`;
    const markerContents = JSON.stringify({ version: 1, path: storedPath });
    const reservation = await this.quota.reserveDelta({
      bytes: summary.bytes + Buffer.byteLength(markerContents),
      files: summary.files + 1,
      entries: summary.entries + 2,
    }, entry);
    try {
      await mkdir(entry, { recursive: true });
      abortIfRequested(signal);
      await writeFile(marker, markerContents, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await renameOrCopy(source, payload, signal);
      reservation.commit();
      this.quota.markUsageDirty();
      return { ok: true, operation: "file.trash", trashId };
    } catch (error) {
      reservation.cancel();
      const payloadMissing = await lstat(payload).then(() => false).catch(() => true);
      if (payloadMissing) await rm(entry, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async restoreRouted(
    request: Extract<ExecutionRequest, { operation: "file.restore" }>,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    if (!validTrashId(request.trashId)) {
      return this.files.execute(request, signal);
    }
    const marker = path.join(this.workspace.root, ".openbot", "trash", request.trashId, "meta.json");
    let storedPath: string | undefined;
    try {
      const parsed = JSON.parse(await readFile(marker, "utf8")) as { path?: unknown };
      storedPath = typeof parsed.path === "string" ? parsed.path : undefined;
    } catch {
      return this.files.execute(request, signal);
    }
    if (storedPath === undefined) return this.files.execute(request, signal);
    const stored = classifyAgentPath(storedPath);
    const destinationPath = request.path ?? storedPath;
    const destination = classifyAgentPath(destinationPath);
    const routable = (kind: ClassifiedAgentPath["kind"]): boolean => kind === "shared" || kind === "host";
    if (!routable(stored.kind) && !routable(destination.kind)) {
      return this.files.execute(request, signal);
    }
    if (destination.kind === "root" || destination.relative === ".") {
      return failure(request.operation, "invalid_path", "File path is invalid.");
    }
    if (destination.kind === "home" && isReservedHomeRelative(destination.relative)) {
      return failure(request.operation, "access_denied", "File operation is not permitted.");
    }
    const destinationRestoreMount = this.mountFor(destination);
    if (destinationRestoreMount?.readOnly) return readOnlyFailure(request.operation);
    const destExec = await this.executorsFor(destination);
    if (!destExec) return failure(request.operation, "access_denied", "Shared folder is not granted or unavailable.");
    const payload = path.join(this.workspace.root, ".openbot", "trash", request.trashId, "payload");
    const destinationAbs = await destExec.workspace.resolveDestination(destination.relative);
    await destExec.workspace.resolveExisting(path.dirname(destination.relative));
    await assertPathAbsent(destinationAbs);
    await inspectSafeTree(payload, signal);
    await renameOrCopy(payload, destinationAbs, signal);
    await unlink(marker).catch(() => undefined);
    await rm(path.dirname(payload), { recursive: true, force: true }).catch(() => undefined);
    this.quota.markUsageDirty();
    return { ok: true, operation: "file.restore", path: destinationPath };
  }

  private async delegateClassified(
    classified: ClassifiedAgentPath,
    request: ExecutionRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    if (classified.kind === "root") return this.files.execute(request, signal);
    if (classified.kind === "home") return this.files.execute(request, signal);
    if (classified.kind === "host") {
      return (await this.hostMount(classified.root)).files.execute(this.rewriteSharedRequest(request, classified.relative), signal);
    }
    const mount = this.mounts.get(classified.mount);
    if (!mount) return Promise.resolve(failure(request.operation, "access_denied", "Shared folder is not granted or unavailable."));
    if (mount.readOnly && MOUNT_WRITE_OPERATIONS.has(request.operation)) {
      return Promise.resolve(readOnlyFailure(request.operation));
    }
    return mount.files.execute(this.rewriteSharedRequest(request, classified.relative), signal);
  }

  private rewriteSharedRequest(request: ExecutionRequest, relative: string): ExecutionRequest {
    switch (request.operation) {
      case "file.list":
      case "file.stat":
      case "file.mkdir":
      case "file.trash":
      case "file.read":
      case "file.write":
        return { ...request, path: relative };
      case "file.copy":
      case "file.move":
        return request;
      default:
        return request;
    }
  }

  private sameMount(left: ClassifiedAgentPath, right: ClassifiedAgentPath): boolean {
    if (left.kind === "home" && right.kind === "home") return true;
    if (left.kind === "host" && right.kind === "host") {
      return left.root.toLowerCase() === right.root.toLowerCase();
    }
    return left.kind === "shared" && right.kind === "shared" && left.mount === right.mount;
  }

  private async executorsFor(classified: Exclude<ClassifiedAgentPath, { kind: "root" }>): Promise<MountExecutors | undefined> {
    if (classified.kind === "home") {
      return { workspace: this.workspace, files: this.files, commands: this.commands, readOnly: false };
    }
    if (classified.kind === "host") return this.hostMount(classified.root);
    return this.mounts.get(classified.mount);
  }

  private mountFor(classified: ClassifiedAgentPath): MountExecutors | undefined {
    return classified.kind === "shared" ? this.mounts.get(classified.mount) : undefined;
  }
}
