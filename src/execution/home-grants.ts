/**
 * Grants de pastas do usuário por bot (melhoria 1 do spec
 * 2026-08-21-workspace-quality-improvements-design.md).
 *
 * `.openbot/grants.json` dentro da home decide se o bot enxerga a pasta
 * REAL do usuário (Desktop/Documents/...) e com qual acesso. Sem grant,
 * a pasta resolve no redirect privado do bot — nunca na real.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "../shared/fs-atomic.js";

export const GRANTS_VERSION = 1;

export type SharedDirectoryAccess = "none" | "read" | "write";

export interface SharedDirectoryGrant {
  access: SharedDirectoryAccess;
  /** ISO timestamp; grant expirado é tratado como "none". */
  expiresAt?: string;
}

export interface GrantsDocument {
  version: typeof GRANTS_VERSION;
  grants: Record<string, SharedDirectoryGrant>;
}

export class GrantsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantsError";
  }
}

export function emptyGrants(): GrantsDocument {
  return { version: GRANTS_VERSION, grants: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lê `.openbot/grants.json`; ausente → documento vazio (nenhum grant). */
export async function readSharedGrants(homeRoot: string): Promise<GrantsDocument> {
  let raw: string;
  try {
    raw = await readFile(join(homeRoot, ".openbot", "grants.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyGrants();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GrantsError("grants.json corrompido");
  }
  if (!isPlainObject(parsed) || parsed.version !== GRANTS_VERSION || !isPlainObject(parsed.grants)) {
    throw new GrantsError("grants.json inválido");
  }
  const grants: Record<string, SharedDirectoryGrant> = {};
  for (const [name, value] of Object.entries(parsed.grants)) {
    if (!isPlainObject(value) || typeof value.access !== "string") continue;
    if (value.access !== "none" && value.access !== "read" && value.access !== "write") continue;
    const grant: SharedDirectoryGrant = { access: value.access };
    if (typeof value.expiresAt === "string" && value.expiresAt.length > 0) grant.expiresAt = value.expiresAt;
    grants[name] = grant;
  }
  return { version: GRANTS_VERSION, grants };
}

/** Grava `.openbot/grants.json` de forma atômica e durável (tmp + fsync + rename). */
export async function writeSharedGrants(homeRoot: string, document: GrantsDocument): Promise<void> {
  if (document.version !== GRANTS_VERSION || !isPlainObject(document.grants)) {
    throw new GrantsError("grants document inválido");
  }
  const target = join(homeRoot, ".openbot", "grants.json");
  await writeFileAtomic(target, `${JSON.stringify(document, null, 2)}\n`);
}

/** Grant efetivo de uma pasta: expirado ou ausente → "none". */
export function effectiveGrant(document: GrantsDocument, directory: string, now: Date = new Date()): SharedDirectoryAccess {
  const grant = document.grants[directory];
  if (grant === undefined) return "none";
  if (grant.expiresAt !== undefined) {
    const expires = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expires) || expires <= now.getTime()) return "none";
  }
  return grant.access;
}
