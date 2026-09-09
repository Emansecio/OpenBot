/**
 * Usuário Linux por bot no runtime WSL (melhoria 4 do spec
 * 2026-08-21-workspace-quality-improvements-design.md).
 *
 * Cada agente ganha uma conta POSIX dedicada (`ob-<sanitizado>`) na distro
 * gerenciada. O supervisor faz setuid para essa conta antes de executar;
 * root fica só no bootstrap/health. Falha na criação = fail-closed.
 */

import { RuntimeManagerError } from "../manager.js";
import type { WslCommandRunner } from "./provisioner.js";
import { createHash } from "node:crypto";

export const GUEST_USER_PREFIX = "ob-";
const GUEST_USER_MAX_LEN = 32;
const GUEST_USER_HASH_LEN = 8;

/**
 * Deterministic per-agent Linux username: `ob-` + sanitized agent id,
 * lowercased, `[a-z0-9-]` only, capped at 32 chars (adduser limit).
 * Long ids retain a short hash of the original identity so truncation cannot
 * make two agents share the same Linux account.
 */
export function linuxUserNameFor(agentId: string): string {
  if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > 128) {
    throw new RuntimeManagerError("runtime_protocol_error", "Runtime agent identity is invalid.");
  }
  const sanitized = agentId
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "-")
    .replaceAll(/[._]/gu, "-")
    .replaceAll(/-{2,}/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  const availableStemLength = GUEST_USER_MAX_LEN - GUEST_USER_PREFIX.length;
  const normalizedId = agentId.toLowerCase();
  if (sanitized.length > 0 && sanitized.length <= availableStemLength && sanitized === normalizedId) {
    return `${GUEST_USER_PREFIX}${sanitized}`;
  }
  const hash = createHash("sha256").update(agentId, "utf8").digest("hex").slice(0, GUEST_USER_HASH_LEN);
  const readableStem = sanitized.length === 0 ? "agent" : sanitized;
  const stemPrefix = readableStem
    .slice(0, availableStemLength - GUEST_USER_HASH_LEN - 1)
    .replace(/-+$/u, "") || "agent";
  const stem = `${stemPrefix}-${hash}`;
  return `${GUEST_USER_PREFIX}${stem}`;
}

/** True when the name matches what linuxUserNameFor can produce. */
export function isValidGuestUserName(name: string): boolean {
  return new RegExp(`^${GUEST_USER_PREFIX}[a-z0-9-]{1,${GUEST_USER_MAX_LEN - GUEST_USER_PREFIX.length}}$`, "u").test(name);
}

export interface GuestUserProvisionerOptions {
  runner: WslCommandRunner;
  distroName: string;
}

/**
 * Idempotent per-distro provisioning cache. `ensure` runs `id -u <name>`;
 * a missing account is created with no login shell and no home (the bot's
 * real home lives on the mounted workspace). Any failure fails closed.
 */
export class GuestUserProvisioner {
  private readonly runner: WslCommandRunner;
  private readonly distroName: string;
  private readonly ensured = new Set<string>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(options: GuestUserProvisionerOptions) {
    this.runner = options.runner;
    this.distroName = options.distroName;
  }

  async ensure(agentId: string, signal?: AbortSignal): Promise<string> {
    const userName = linuxUserNameFor(agentId);
    if (this.ensured.has(userName)) return userName;
    const existing = this.inFlight.get(userName);
    if (existing) return existing;
    const pending = this.provision(userName, signal);
    this.inFlight.set(userName, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(userName) === pending) this.inFlight.delete(userName);
    }
  }

  private async provision(userName: string, signal?: AbortSignal): Promise<string> {
    const base = ["-d", this.distroName, "--user", "root", "--"];
    const check = await this.runner.run([...base, "id", "-u", userName], signal).catch((error: unknown) => {
      throw new RuntimeManagerError("runtime_unhealthy", `Runtime guest user check failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (check.exitCode !== 0) {
      const hasUseradd = await this.runner.run([...base, "sh", "-c", "command -v useradd >/dev/null 2>&1"], signal).catch((error: unknown) => {
        throw new RuntimeManagerError("runtime_unhealthy", `Runtime guest user tool check failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      const createArgs = hasUseradd.exitCode === 0
        ? [...base, "useradd", "--system", "--user-group", "--no-create-home", "--shell", "/usr/sbin/nologin", userName]
        : [...base, "adduser", "-S", "-D", "-H", "-s", "/sbin/nologin", userName];
      const create = await this.runner.run(createArgs, signal).catch((error: unknown) => {
        throw new RuntimeManagerError("runtime_unhealthy", `Runtime guest user creation failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (create.exitCode !== 0) {
        // Fail closed: never fall back to a shared/root account.
        throw new RuntimeManagerError("runtime_unhealthy", "Runtime guest user could not be provisioned.");
      }
    }
    this.ensured.add(userName);
    return userName;
  }

  /** Test/teardown hook: forget cached provisions. */
  reset(): void {
    this.ensured.clear();
  }
}
