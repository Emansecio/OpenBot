import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 as win32Path } from "node:path";
import { promisify } from "node:util";

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
  /** Optional SID for an account name that is otherwise resolved by whoami. */
  currentUserSid?: string | (() => string | Promise<string>);
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
const SDDL_LINE = /^D:(?:[A-Z]*)(?:\([^()]*\))+$/iu;
const SDDL_ACE = /\(([^()]*)\)/gu;
const SDDL_SYSTEM = new Set(["SY", "S-1-5-18"]);
const SDDL_ADMINISTRATORS = new Set(["BA", "S-1-5-32-544"]);
const FULL_CONTROL_MASKS = new Set(["F", "FA", "GA", "0X1F01FF"]);
const ALLOWED_INHERITANCE_FLAGS = new Set(["", "OICI"]);
const WHOAMI = "whoami.exe";
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

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
 * local Administrators SID, and then asks icacls to verify and save the
 * resulting ACL tree. The saved SDDL is checked against that policy. No shell,
 * command interpolation, or permissive fallback is used.
 */
export class WindowsHomeAclAdapter implements HomeAclAdapter {
  private readonly platform: NodeJS.Platform;
  private readonly runner: HomeAclCommandRunner;
  private readonly currentUser: WindowsHomeAclAdapterOptions["currentUser"];
  private readonly currentUserSid: WindowsHomeAclAdapterOptions["currentUserSid"];
  private readonly commandTimeoutMs: number;

  constructor(options: WindowsHomeAclAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? createWindowsCommandRunner();
    this.currentUser = options.currentUser;
    this.currentUserSid = options.currentUserSid;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.commandTimeoutMs) || this.commandTimeoutMs < 1) {
      throw new Error("commandTimeoutMs must be a positive integer");
    }
  }

  private async runCommand(file: string, args: readonly string[], options: HomeAclCommandOptions): Promise<HomeAclCommandResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.runner(file, args, options),
        new Promise<HomeAclCommandResult>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`icacls timed out after ${this.commandTimeoutMs} ms`)), this.commandTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async resolveCurrentSid(
    principal: string,
    options: HomeAclCommandOptions,
  ): Promise<string | undefined> {
    const configured = typeof this.currentUserSid === "function"
      ? await this.currentUserSid()
      : this.currentUserSid;
    if (configured !== undefined) return normalizeSid(configured);
    if (SID.test(principal)) return normalizeSid(principal);

    const result = await this.runCommand(WHOAMI, ["/user", "/fo", "csv", "/nh"], options);
    if (commandFailed(result)) return undefined;
    const matches = (text(result.stdout) + "\n" + text(result.stderr)).match(/\*?S-\d+(?:-\d+)+/giu) ?? [];
    const match = matches.find((candidate) => {
      const sid = normalizePrincipal(candidate);
      return sid !== "S-1-5-18" && sid !== "S-1-5-32-544";
    });
    return match === undefined ? undefined : normalizeSid(match);
  }

  private async readPolicyDescriptors(
    target: string,
    options: HomeAclCommandOptions,
  ): Promise<{ descriptors: string[]; temporaryRoot: string }> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "openbot-acl-inspect-"));
    const aclFile = join(temporaryRoot, "tree.acl");
    try {
      const saved = await this.runCommand(ICACLS, [target, "/save", aclFile, "/T", "/Q"], options);
      if (commandFailed(saved)) {
        throw new Error("icacls ACL save failed with exit " + saved.exitCode + (summarize(saved) ? ": " + summarize(saved) : "."));
      }

      let contents = text(saved.stdout);
      try {
        const bytes = await readFile(aclFile);
        contents = bytes[0] === 0xff && bytes[1] === 0xfe
          ? bytes.subarray(2).toString("utf16le")
          : bytes[1] === 0 && bytes[3] === 0
            ? bytes.toString("utf16le")
            : bytes.toString("utf8").replace(/^\uFEFF/u, "");
      } catch (error) {
        // Injected runners may return an SDDL fixture in stdout instead of
        // creating a file. Production icacls writes the file and is read above.
        if (!contents.match(/(?:^|\r?\n)D:/iu)) {
          throw new Error("icacls ACL descriptor could not be read: " + (error instanceof Error ? error.message : "ACL file unavailable"));
        }
      }
      const descriptors = contents
        .split(/\r?\n/gu)
        .map((line) => line.trim())
        .filter((line) => SDDL_LINE.test(line));
      if (descriptors.length === 0) throw new Error("icacls ACL descriptor is empty or invalid.");
      return { descriptors, temporaryRoot };
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
  }

  private async verifyPolicy(
    target: string,
    principal: string,
    options: HomeAclCommandOptions,
  ): Promise<string | undefined> {
    const { descriptors, temporaryRoot } = await this.readPolicyDescriptors(target, options);
    try {
      const normalizedPrincipal = normalizePrincipal(principal);
      let currentSid: string | undefined;
      let foundCurrent = false;
      for (const descriptor of descriptors) {
        const parsed = parseSddlDescriptor(descriptor);
        if (parsed === undefined) return "icacls ACL descriptor is invalid.";
        if (!parsed.protected && !parsed.inherited) return "Windows ACL inheritance policy is not proven.";
        const found = new Set<string>();
        for (const ace of parsed.aces) {
          const identity = normalizePrincipal(ace.sid);
          const isCurrent = identity === normalizedPrincipal
            || (currentSid !== undefined && identity === currentSid);
          if (!isCurrent && !SDDL_SYSTEM.has(identity) && !SDDL_ADMINISTRATORS.has(identity)) {
            currentSid ??= await this.resolveCurrentSid(principal, options);
            if (currentSid === undefined || identity !== currentSid) {
              return "Windows ACL contains an unexpected principal: " + ace.sid + ".";
            }
          }
          const flags = ace.flags.toUpperCase();
          const inherited = flags.includes("ID");
          const baseFlags = flags.replace("ID", "");
          if (inherited !== parsed.inherited || !FULL_CONTROL_MASKS.has(ace.mask.toUpperCase()) || !ALLOWED_INHERITANCE_FLAGS.has(baseFlags)) {
            return "Windows ACL entry for " + ace.sid + " does not match the Full Control policy.";
          }
          found.add(identity);
          if (isCurrent || (currentSid !== undefined && identity === currentSid)) foundCurrent = true;
        }
        const required = [
          ["S-1-5-18", SDDL_SYSTEM],
          ["S-1-5-32-544", SDDL_ADMINISTRATORS],
          [normalizedPrincipal, new Set([normalizedPrincipal, ...(currentSid === undefined ? [] : [currentSid])])],
        ] as const;
        for (const [identity, aliases] of required) {
          if (![...aliases].some((alias) => found.has(alias))) {
            return "Windows ACL is missing the required principal " + identity + ".";
          }
        }
      }
      return foundCurrent ? undefined : "Windows ACL is missing the current account.";
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
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
    let verification: HomeAclCommandResult;
    try {
      verification = await this.runCommand(ICACLS, [target, "/verify", "/T", "/Q"], options);
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
    try {
      const policyError = await this.verifyPolicy(target, principal, options);
      if (policyError !== undefined) {
        return { status: "failed", platform: this.platform, message: policyError };
      }
    } catch (error) {
      return {
        status: "failed",
        platform: this.platform,
        message: error instanceof Error ? error.message : "Windows ACL policy could not be verified.",
      };
    }
    return { status: "verified", platform: this.platform, message: "DACL structure and access policy verification succeeded." };
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
        result = await this.runCommand(ICACLS, args, options);
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
      verification = await this.runCommand(ICACLS, [target, "/verify", "/T", "/Q"], options);
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

    try {
      const policyError = await this.verifyPolicy(target, principal, options);
      if (policyError !== undefined) {
        return { status: "failed", platform: this.platform, message: policyError };
      }
    } catch (error) {
      return {
        status: "failed",
        platform: this.platform,
        message: error instanceof Error ? error.message : "Windows ACL policy could not be verified.",
      };
    }
    return { status: "verified", platform: this.platform, message: "DACL applied and access policy verification succeeded." };
  }
}

interface ParsedSddlAce {
  flags: string;
  mask: string;
  sid: string;
}

interface ParsedSddlDescriptor {
  inherited: boolean;
  protected: boolean;
  aces: ParsedSddlAce[];
}

function normalizeSid(value: string): string {
  const sid = value.trim().replace(/^\*/u, "").toUpperCase();
  if (!SID.test("*" + sid)) throw new Error("Current Windows account SID is invalid.");
  return sid;
}

function normalizePrincipal(value: string): string {
  const principal = value.trim().replace(/^\*/u, "").toUpperCase();
  if (principal === "SY") return "S-1-5-18";
  if (principal === "BA") return "S-1-5-32-544";
  return principal;
}

function parseSddlDescriptor(value: string): ParsedSddlDescriptor | undefined {
  const dacl = value.match(/^D:([A-Z]*)(.*)$/iu);
  if (dacl?.[2] === undefined) return undefined;
  const aces: ParsedSddlAce[] = [];
  for (const match of dacl[2].matchAll(SDDL_ACE)) {
    const fields = (match[1] ?? "").split(";");
    if (fields.length !== 6 || fields[0]?.toUpperCase() !== "A") return undefined;
    aces.push({ flags: fields[1] ?? "", mask: fields[2] ?? "", sid: fields[5] ?? "" });
  }
  if (aces.length === 0) return undefined;
  const inherited = aces.every((ace) => ace.flags.toUpperCase().includes("ID"));
  return {
    inherited,
    protected: dacl[1]?.toUpperCase().includes("P") === true,
    aces,
  };
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
