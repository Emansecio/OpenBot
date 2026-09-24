import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../contracts.js";
import { HomeWorkspaceBackend } from "../home-backend.js";
import { defaultUserProfile } from "../user-files.js";
import type { WorkspaceQuotaOptions } from "../quota.js";
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

export class AgentRuntimeBackend implements ExecutionBackend {
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
      allowHostTrash: false,
      requireAbsoluteHostTransferPeers: true,
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

  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    if (request.operation === "process.run") return this.process.execute(request, signal);
    return this.home.execute(request, signal);
  }
}
