import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32 as win32Path } from "node:path";

/**
 * ACL integration is deliberately injectable. The home lifecycle must not
 * silently replace a restrictive Windows ACL with a broader one when
 * `icacls` (or a future native helper) is unavailable.
 */
export type HomeAclStatus = "not-applicable" | "applied" | "verified" | "failed";

export interface HomeAclResult {
  status: HomeAclStatus;
  platform: NodeJS.Platform;
  message?: string;
}

export interface HomeAclContext {
  agentId: string;
  operation: "create" | "repair" | "restore" | "import" | "quarantine";
}

export interface HomeAclAdapter {
  /**
   * Apply or verify the ACL for a home. Implementations must never broaden
   * access as a fallback. A failure is reported, not replaced by chmod or a
   * permissive ACL.
   */
  apply(root: string, context: HomeAclContext): Promise<HomeAclResult>;
}

export interface HomeAclCommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface HomeAclCommandOptions {
  shell: false;
  windowsHide: true;
  timeoutMs: number;
}

/** Injectable command runner used to keep ACL unit tests side-effect free. */
export type HomeAclCommandRunner = (
  file: string,
  args: readonly string[],
  options: HomeAclCommandOptions,
) => Promise<HomeAclCommandResult>;

export interface WindowsHomeAclAdapterOptions {
  /** Override only for tests or a platform-specific integration harness. */
  platform?: NodeJS.Platform;
  /** Injected runner; the production runner invokes `icacls.exe` without a shell. */
  runner?: HomeAclCommandRunner;
  /** Current account name or SID. Defaults to USERDOMAIN\\USERNAME. */
  currentUser?: string | (() => string | Promise<string>);
  commandTimeoutMs?: number;
}

const ICACLS = "icacls.exe";
const FULL_CONTROL = "(OI)(CI)F";
const DIRECT_FULL_CONTROL = "F";
const SYSTEM = "*S-1-5-18";
const ADMINISTRATORS = "*S-1-5-32-544";
const FORBIDDEN_PRINCIPALS = /^(?:everyone|users|authenticated users|guest|anonymous logon|\*s-1-1-0|\*s-1-5-11|\*s-1-5-32-545)$/iu;
const SID = /^\*S-\d+-\d+(?:-\d+)+$/u;
const ACCOUNT = /^(?:[^\\/:*?"<>|]+\\)?[^\\/:*?"<>|]+$/u;

const execFileAsync = promisify(execFile);

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function summarize(result: HomeAclCommandResult): string {
  const output = `${text(result.stderr)} ${text(result.stdout)}`.replace(/\s+/gu, " ").trim();
  return output.length > 360 ? `${output.slice(0, 357)}...` : output;
}

function commandFailed(result: HomeAclCommandResult): boolean {
  return !Number.isInteger(result.exitCode) || result.exitCode !== 0;
}

function createWindowsCommandRunner(): HomeAclCommandRunner {
  return async (file, args, options) => {
    try {
      const result = await execFileAsync(file, [...args], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        shell: options.shell,
        windowsHide: options.windowsHide,
        timeout: options.timeoutMs,
      });
      return {
        exitCode: 0,
        stdout: text(result.stdout),
        stderr: text(result.stderr),
      };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        stdout?: unknown;
        stderr?: unknown;
      };
      const exitCode = typeof failure.code === "number" ? failure.code : -1;
      return {
        exitCode,
        stdout: text(failure.stdout),
        stderr: text(failure.stderr) || (error instanceof Error ? error.message : "icacls failed"),
      };
    }
  };
}

function resolveCurrentUser(): string {
  const username = process.env.USERNAME?.trim();
  const domain = process.env.USERDOMAIN?.trim();
  if (!username) throw new Error("Current Windows account could not be resolved.");
  return domain ? `${domain}\\${username}` : username;
}

function validateCurrentUser(value: string): string {
  const principal = value.trim();
  if (!principal || FORBIDDEN_PRINCIPALS.test(principal) || (!SID.test(principal) && !ACCOUNT.test(principal))) {
    throw new Error("Current Windows account is not a safe ACL principal.");
  }
  return principal;
}

function validateRoot(root: string): string {
  const normalized = win32Path.normalize(root);
  // icacls accepts wildcard patterns. A workspace root must be one literal
  // absolute path, never a pattern or an option supplied to the child process.
  if (!win32Path.isAbsolute(root) || root.includes("*") || root.includes("?")) {
    throw new Error("Workspace root must be one literal absolute Windows path.");
  }
  return normalized;
}

/**
 * Windows DACL adapter.
 *
 * The sequence resets inherited/explicit entries for the complete home tree,
 * removes inheritance, grants only the current account plus SYSTEM and the
 * local Administrators SID, and then asks icacls to verify the resulting ACL
 * tree. No shell, command interpolation, or permissive fallback is used.
 */
export class WindowsHomeAclAdapter implements HomeAclAdapter {
  private readonly platform: NodeJS.Platform;
  private readonly runner: HomeAclCommandRunner;
  private readonly currentUser: WindowsHomeAclAdapterOptions["currentUser"];
  private readonly commandTimeoutMs: number;

  constructor(options: WindowsHomeAclAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? createWindowsCommandRunner();
    this.currentUser = options.currentUser;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.commandTimeoutMs) || this.commandTimeoutMs < 1) {
      throw new Error("commandTimeoutMs must be a positive integer");
    }
  }

  private async runCommand(args: readonly string[], options: HomeAclCommandOptions): Promise<HomeAclCommandResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.runner(ICACLS, args, options),
        new Promise<HomeAclCommandResult>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`icacls timed out after ${this.commandTimeoutMs} ms`)), this.commandTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async verify(root: string): Promise<HomeAclResult> {
    if (this.platform !== "win32") {
      return {
        status: "not-applicable",
        platform: this.platform,
        message: "Windows ACLs are not applicable on this platform.",
      };
    }

    let target: string;
    try {
      target = validateRoot(root);
      const resolved = typeof this.currentUser === "function"
        ? await this.currentUser()
        : this.currentUser ?? resolveCurrentUser();
      validateCurrentUser(resolved);
    } catch (error) {
      return {
        status: "failed",
        platform: this.platform,
        message: error instanceof Error ? error.message : "Windows ACL inputs are invalid.",
      };
    }

    const options: HomeAclCommandOptions = { shell: false, windowsHide: true, timeoutMs: this.commandTimeoutMs };
    let verification: HomeAclCommandResult;
    try {
      verification = await this.runCommand([target, "/verify", "/T", "/Q"], options);
    } catch (error) {
      return {
        status: "failed",
        platform: this.platform,
        message: `icacls verification failed: ${error instanceof Error ? error.message : "command error"}`,
      };
    }
    if (commandFailed(verification)) {
      return {
        status: "failed",
        platform: this.platform,
        message: `icacls verification failed with exit ${verification.exitCode}${summarize(verification) ? `: ${summarize(verification)}` : "."}`,
      };
    }
    return {
      status: "verified",
      platform: this.platform,
      message: "DACL tree verification succeeded.",
    };
  }

  async apply(root: string, _context: HomeAclContext): Promise<HomeAclResult> {
    if (this.platform !== "win32") {
      return {
        status: "not-applicable",
        platform: this.platform,
        message: "Windows ACLs are not applicable on this platform.",
      };
    }

    let target: string;
    let principal: string;
    try {
      target = validateRoot(root);
      const resolved = typeof this.currentUser === "function"
        ? await this.currentUser()
        : this.currentUser ?? resolveCurrentUser();
      principal = validateCurrentUser(resolved);
    } catch (error) {
      return {
        status: "failed",
        platform: this.platform,
        message: error instanceof Error ? error.message : "Windows ACL inputs are invalid.",
      };
    }

    const options: HomeAclCommandOptions = { shell: false, windowsHide: true, timeoutMs: this.commandTimeoutMs };
    const commands: readonly (readonly string[])[] = [
      [target, "/reset", "/T", "/Q"],
      [
        target,
        "/grant:r",
        `${principal}:${FULL_CONTROL}`,
        `${principal}:${DIRECT_FULL_CONTROL}`,
        `${SYSTEM}:${FULL_CONTROL}`,
        `${SYSTEM}:${DIRECT_FULL_CONTROL}`,
        `${ADMINISTRATORS}:${FULL_CONTROL}`,
        `${ADMINISTRATORS}:${DIRECT_FULL_CONTROL}`,
        "/T",
        "/Q",
      ],
      // Grant explicit access before removing inheritance. If inheritance is
      // removed from the root first, icacls can lose traversal rights before
      // it reaches descendants and leave the tree half-configured.
      [target, "/inheritance:r", "/T", "/Q"],
    ];

    for (const [index, args] of commands.entries()) {
      let result: HomeAclCommandResult;
      try {
        result = await this.runCommand(args, options);
      } catch (error) {
        return {
          status: "failed",
          platform: this.platform,
          message: `icacls apply step ${index + 1} failed: ${error instanceof Error ? error.message : "command error"}`,
        };
      }
      if (commandFailed(result)) {
        return {
          status: "failed",
          platform: this.platform,
          message: `icacls apply step ${index + 1} failed with exit ${result.exitCode}${summarize(result) ? `: ${summarize(result)}` : "."}`,
        };
      }
    }

    let verification: HomeAclCommandResult;
    try {
      verification = await this.runCommand([target, "/verify", "/T", "/Q"], options);
    } catch (error) {
      return {
        status: "failed",
        platform: this.platform,
        message: `icacls verification failed: ${error instanceof Error ? error.message : "command error"}`,
      };
    }
    if (commandFailed(verification)) {
      return {
        status: "failed",
        platform: this.platform,
        message: `icacls verification failed with exit ${verification.exitCode}${summarize(verification) ? `: ${summarize(verification)}` : "."}`,
      };
    }

    return {
      status: "verified",
      platform: this.platform,
      message: "DACL applied for the current account, SYSTEM, and Administrators; icacls /verify succeeded.",
    };
  }
}

/** Safe default on platforms without Windows ACLs. */
export class NoopHomeAclAdapter implements HomeAclAdapter {
  async apply(_root: string, _context: HomeAclContext): Promise<HomeAclResult> {
    return {
      status: "not-applicable",
      platform: process.platform,
      message: "Windows ACLs are not applicable on this platform.",
    };
  }
}

export const DEFAULT_HOME_ACL_ADAPTER: HomeAclAdapter = process.platform === "win32"
  ? new WindowsHomeAclAdapter()
  : new NoopHomeAclAdapter();
