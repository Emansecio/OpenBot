import { win32 as path } from "node:path";

import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../contracts.js";
import { LocalCommandExecutor } from "../commands.js";
import { LocalFileExecutor } from "../files.js";
import { HomeWorkspaceBackend } from "../home-backend.js";
import { defaultUserProfile } from "../user-files.js";
import type { WorkspaceQuotaOptions } from "../quota.js";
import { WorkspaceSandbox } from "../workspace.js";
import type { AgentRuntimeManager } from "./contracts.js";
import { WslProcessBackend, type RuntimeProcessRunner } from "./wsl/process-backend.js";

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
}

type HostExecutors = {
  files: LocalFileExecutor;
  commands: LocalCommandExecutor;
};

const absoluteRequestPath = (request: ExecutionRequest): string | undefined => {
  switch (request.operation) {
    case "file.list":
    case "file.stat":
    case "file.mkdir":
    case "file.trash":
    case "file.read":
    case "file.write":
      return path.isAbsolute(request.path) ? request.path : undefined;
    case "file.copy":
    case "file.move":
      return path.isAbsolute(request.source) ? request.source : path.isAbsolute(request.destination) ? request.destination : undefined;
    case "file.restore":
      return request.path !== undefined && path.isAbsolute(request.path) ? request.path : undefined;
    case "command.run":
      return path.isAbsolute(request.cwd) ? request.cwd : undefined;
    default:
      return undefined;
  }
};

export class AgentRuntimeBackend implements ExecutionBackend {
  private readonly hostVolumes = new Map<string, Promise<HostExecutors>>();

  private constructor(
    private readonly home: HomeWorkspaceBackend,
    private readonly process: WslProcessBackend,
  ) {}

  static async create(options: AgentRuntimeBackendOptions): Promise<AgentRuntimeBackend> {
    const shareUserFiles = options.shareUserFiles === true;
    const home = await HomeWorkspaceBackend.create(options.homeRoot, {
      ...(shareUserFiles ? { userProfile: options.userProfile ?? defaultUserProfile() } : {}),
      // Grant-based shared folders (melhoria 1): with an agentId the backend
      // evaluates .openbot/grants.json instead of sharing everything.
      agentId: options.agentId,
      quota: options.quota,
    });
    return new AgentRuntimeBackend(
      home,
      new WslProcessBackend({
        agentId: options.agentId,
        manager: options.manager,
        runner: options.runner,
        quota: home.quota,
      }),
    );
  }

  /** Observational only: never scans the home or initializes a process. */
  quotaMetrics(): ReturnType<HomeWorkspaceBackend["quota"]["metrics"]> {
    return this.home.quota.metrics();
  }

  private hostExecutors(root: string): Promise<HostExecutors> {
    const key = root.toLowerCase();
    const cached = this.hostVolumes.get(key);
    if (cached) return cached;
    const pending = WorkspaceSandbox.create(root, { allowAncestorLinks: true }).then((workspace) => ({
      files: LocalFileExecutor.fromWorkspace(workspace),
      commands: LocalCommandExecutor.fromWorkspace(workspace),
    }));
    this.hostVolumes.set(key, pending);
    pending.catch(() => this.hostVolumes.delete(key));
    return pending;
  }

  private async executeHost(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const firstPath = absoluteRequestPath(request);
    if (firstPath === undefined) return this.home.execute(request, signal);
    const resolvedFirst = path.resolve(firstPath);
    const root = path.parse(resolvedFirst).root;
    const relative = (value: string): string => {
      if (!path.isAbsolute(value)) throw new Error("Host paths must be absolute.");
      const resolved = path.resolve(value);
      if (path.parse(resolved).root.toLowerCase() !== root.toLowerCase()) {
        throw new Error("Host paths must use the same volume.");
      }
      return path.relative(root, resolved) || ".";
    };
    try {
      const executors = await this.hostExecutors(root);
      switch (request.operation) {
        case "file.list":
        case "file.stat":
        case "file.mkdir":
        case "file.read":
        case "file.write":
          return executors.files.execute({ ...request, path: relative(request.path) }, signal);
        case "file.copy":
        case "file.move":
          return executors.files.execute({
            ...request,
            source: relative(request.source),
            destination: relative(request.destination),
          }, signal);
        case "command.run": {
          const cwd = path.resolve(request.cwd);
          const paths = request.params.paths.map((value) => relative(path.resolve(cwd, value)));
          return executors.commands.execute({
            ...request,
            cwd: ".",
            params: { ...request.params, paths },
          }, signal);
        }
        case "file.trash":
        case "file.restore":
          return { ok: false, operation: request.operation, code: "unsupported", message: "Use process_run for recoverable host trash operations." };
        default:
          return { ok: false, operation: request.operation, code: "unsupported", message: "Host operation is not supported." };
      }
    } catch {
      return { ok: false, operation: request.operation, code: "invalid_path", message: "Host path could not be verified." };
    }
  }

  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    if (request.operation === "process.run") return this.process.execute(request, signal);
    if (absoluteRequestPath(request) !== undefined) return this.executeHost(request, signal);
    return this.home.execute(request, signal);
  }
}
