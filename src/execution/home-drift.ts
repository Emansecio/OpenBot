/**
 * Drift de inventário por bot (melhoria 6 do spec
 * 2026-08-21-workspace-quality-improvements-design.md).
 *
 * Baseline de uso em `<home>/.openbot/usage.json`, escrita por
 * `auditUsage`/`repair`. O relatório compara a linha de base com o uso atual
 * do disco e sinaliza divergência (editores, antivírus, o próprio usuário).
 * Drift NUNCA bloqueia o bot — é sinal para o repair.
 */

import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { calculateWorkspaceUsage, type WorkspaceUsage, type WorkspaceUsageCalculator } from "./quota.js";

export interface HomeUsageBaseline {
  version: 1;
  checkedAt: string;
  bytes: number;
  files: number;
  directories: number;
}

export interface DriftReport {
  baseline: HomeUsageBaseline | null;
  current: WorkspaceUsage;
  driftBytes: number;
  driftFiles: number;
  drifted: boolean;
}

export const DRIFT_BYTES_RATIO = 0.05;
export const DRIFT_FILES_ABSOLUTE = 50;

/** Drift tracks user content: administrative `.openbot` metadata never counts. */
export const calculateVisibleUsage: WorkspaceUsageCalculator = (root, maxEntries) =>
  calculateWorkspaceUsage(root, maxEntries, (relative) =>
    relative === ".openbot" || relative.startsWith(".openbot/")
  );

const usagePath = (homeRoot: string): string => join(homeRoot, ".openbot", "usage.json");

export async function readUsageBaseline(homeRoot: string): Promise<HomeUsageBaseline | null> {
  let raw: string;
  try {
    raw = await readFile(usagePath(homeRoot), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HomeUsageBaseline>;
    if (
      parsed.version !== 1 || typeof parsed.checkedAt !== "string" ||
      typeof parsed.bytes !== "number" || typeof parsed.files !== "number" || typeof parsed.directories !== "number"
    ) return null;
    return { version: 1, checkedAt: parsed.checkedAt, bytes: parsed.bytes, files: parsed.files, directories: parsed.directories };
  } catch {
    return null;
  }
}

export async function writeUsageBaseline(homeRoot: string, usage: WorkspaceUsage, checkedAt: Date = new Date()): Promise<void> {
  const baseline: HomeUsageBaseline = {
    version: 1,
    checkedAt: checkedAt.toISOString(),
    bytes: usage.bytes,
    files: usage.files,
    directories: usage.directories,
  };
  const target = usagePath(homeRoot);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    await writeFile(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
    renamed = true;
  } finally {
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

export function detectDrift(baseline: HomeUsageBaseline | null, current: WorkspaceUsage): DriftReport {
  if (baseline === null) {
    return { baseline: null, current, driftBytes: 0, driftFiles: 0, drifted: false };
  }
  const driftBytes = current.bytes - baseline.bytes;
  const driftFiles = current.files - baseline.files;
  const byteThreshold = Math.max(baseline.bytes * DRIFT_BYTES_RATIO, 1024 * 1024);
  const drifted = Math.abs(driftBytes) > byteThreshold || Math.abs(driftFiles) > DRIFT_FILES_ABSOLUTE;
  return { baseline, current, driftBytes, driftFiles, drifted };
}

/** True when the baseline file exists but is unreadable/corrupt (repair should refresh). */
export async function hasCorruptBaseline(homeRoot: string): Promise<boolean> {
  try {
    await lstat(usagePath(homeRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return await readUsageBaseline(homeRoot) === null;
}
