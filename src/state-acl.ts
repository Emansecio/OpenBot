import {
  WindowsHomeAclAdapter,
  type HomeAclCommandOptions,
  type HomeAclCommandResult,
  type HomeAclResult,
} from "./execution/home-acl.js";

/** Injectable `icacls.exe` seam for state-directory ACL tests and integrations. */
export type StateAclCommandOptions = HomeAclCommandOptions;
export type StateAclCommandResult = HomeAclCommandResult;
export type StateAclCommandRunner = (
  file: string,
  args: readonly string[],
  options: StateAclCommandOptions,
) => Promise<StateAclCommandResult>;

export interface OpenBotStateAclOptions {
  /** Override only for tests or a platform-specific integration harness. */
  platform?: NodeJS.Platform;
  /** Production uses `icacls.exe` without a shell; tests inject a recorder. */
  runner?: StateAclCommandRunner;
  /** Current Windows account name or SID; defaults to USERDOMAIN\\USERNAME. */
  currentUser?: string | (() => string | Promise<string>);
}

/**
 * Applies and verifies the restrictive ACL used by OpenBot state directories.
 *
 * The delegated adapter grants only the current account, SYSTEM, and local
 * Administrators, removes inheritance, and fails closed on any command or
 * verification error. There is deliberately no chmod/permissive fallback.
 */
export async function applyOpenBotStateAcl(
  root: string,
  options: OpenBotStateAclOptions = {},
): Promise<HomeAclResult> {
  const adapter = new WindowsHomeAclAdapter({
    platform: options.platform,
    runner: options.runner,
    currentUser: options.currentUser,
  });
  return adapter.apply(root, { agentId: "openbot-state", operation: "create" });
}

/** Fast recurring-boot check used only after a protected stamp was created. */
export async function verifyOpenBotStateAcl(
  root: string,
  options: OpenBotStateAclOptions = {},
): Promise<HomeAclResult> {
  const adapter = new WindowsHomeAclAdapter({
    platform: options.platform,
    runner: options.runner,
    currentUser: options.currentUser,
  });
  return adapter.verify(root);
}
