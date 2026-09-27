import { rm } from "node:fs/promises";
import path from "node:path";

import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../contracts.js";
import { HomeWorkspaceBackend } from "../home-backend.js";
import { PROTECTED_PATH_MESSAGE, type ProtectedPaths } from "../protected-paths.js";
import { defaultUserProfile } from "../user-files.js";
import { WorkspaceQuotaError, type WorkspaceQuotaOptions } from "../quota.js";
import type { AgentRuntimeManager } from "./contracts.js";
import { RuntimeProcessBackend, type RuntimeProcessRunner } from "./process-backend.js";

export interface AgentRuntimeBackendOptions {
  agentId: string;
  homeRoot: string;
  manager: AgentRuntimeManager;
  runner: RuntimeProcessRunner;
  /**
   * When true, Desktop/Documents/Downloads/Pictures/Videos/Music are the user's
   * real folders. Defaults to false; `startServer` in production passes true.
   */
  shareUserFiles?: boolean;
  /** Override the Windows profile used for shared folders. */
  userProfile?: string;
  /** Optional quota override propagated to the agent home backend. */
  quota?: WorkspaceQuotaOptions;
  /** OpenBot data and sibling homes that file tools and process cwd/executable must not use. */
  protectedPaths?: ProtectedPaths;
}

export class AgentRuntimeBackend implements ExecutionBackend {
  private constructor(
    private readonly home: HomeWorkspaceBackend,
    private readonly process: RuntimeProcessBackend,
    private readonly protectedPaths?: ProtectedPaths,
  ) {}

  static async create(options: AgentRuntimeBackendOptions): Promise<AgentRuntimeBackend> {
    const shareUserFiles = options.shareUserFiles === true;
    const home = await HomeWorkspaceBackend.create(options.homeRoot, {
      ...(shareUserFiles ? { userProfile: options.userProfile ?? defaultUserProfile() } : {}),
      // Grant-based shared folders (melhoria 1): with an agentId the backend
      // evaluates .openbot/grants.json instead of sharing everything.
      agentId: options.agentId,
      quota: options.quota,
      allowHostTrash: false,
      requireAbsoluteHostTransferPeers: true,
      ...(options.protectedPaths === undefined ? {} : { protectedPaths: options.protectedPaths }),
    });
    return new AgentRuntimeBackend(
      home,
      new RuntimeProcessBackend({
        agentId: options.agentId,
        manager: options.manager,
        runner: options.runner,
        quota: home.quota,
      }),
      options.protectedPaths?.forHome(home.workspace.root),
    );
  }

  /** Observational only: never scans the home or initializes a process. */
  quotaMetrics(): ReturnType<HomeWorkspaceBackend["quota"]["metrics"]> {
    return this.home.quota.metrics();
  }

  /**
   * Count a file another process wrote into this home (a finished browser
   * download) against the workspace quota. A file that takes the home over
   * its quota is removed. Returns whether the file was kept.
   */
  async admitExternalFile(absolutePath: string): Promise<boolean> {
    const relative = path.relative(this.home.workspace.root, absolutePath);
    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("External file is outside the agent home.");
    }
    const quota = this.home.quota;
    // The file is already on disk: rescan, then check the home total and the
    // folder's own limit (Downloads has one) without adding it twice.
    quota.markUsageDirty();
    try {
      await quota.applyExternalDelta({ bytes: 0, files: 0, entries: 0 }, absolutePath);
      return true;
    } catch (error) {
      if (!(error instanceof WorkspaceQuotaError)) throw error;
      await rm(absolutePath, { force: true });
      quota.markUsageDirty();
      return false;
    }
  }

  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    if (request.operation === "process.run") {
      if (this.usesProtectedPath(request)) {
        return { ok: false, operation: request.operation, code: "access_denied", message: PROTECTED_PATH_MESSAGE };
      }
      return this.process.execute(request, signal);
    }
    return this.home.execute(request, signal);
  }

  /** Relative cwd resolves inside the home; only absolute cwd/executable can point elsewhere. */
  private usesProtectedPath(request: Extract<ExecutionRequest, { operation: "process.run" }>): boolean {
    const protectedPaths = this.protectedPaths;
    if (protectedPaths === undefined) return false;
    return [request.cwd, request.executable].some((value) => path.win32.isAbsolute(value) && protectedPaths.blocksResolved(value));
  }
}
