import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertManagedInstallRoot,
  atomicWriteJson,
  canonicalizeInstallRoot,
  defaultInstallRoot,
  installLayout,
  isMainModule,
  parseArgs,
  pathExists,
  readInstallState,
  stateReleaseId,
} from "./release-common.mjs";
import { assertGatewayStopped, createDataBackup, restoreDataBackup, verifyDataBackup } from "./update.mjs";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:1340";
const DIAGNOSTIC_LOG_BYTES = 64 * 1024;

export function redactDiagnosticText(value) {
  return String(value)
    .replace(/(bearer\s+)[^\s"']+/giu, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)"?\s*[:=]\s*"?)[^\s,"'}]+/giu, "$1[REDACTED]");
}

function sanitizedValue(value, depth = 0) {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizedValue(entry, depth + 1));
  if (value != null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizedValue(entry, depth + 1)]));
  }
  return value;
}

async function managedInstall(options) {
  const root = await canonicalizeInstallRoot(options.root ?? defaultInstallRoot(options.env ?? process.env));
  const state = await readInstallState(root);
  assertManagedInstallRoot(root, state);
  if (!state.activeVersion) throw new Error(`Install has no active version: ${root}`);
  if (typeof state.dataRoot !== "string" || !state.dataRoot.trim()
      || typeof state.localDataRoot !== "string" || !state.localDataRoot.trim()) {
    throw new Error(`Install state has no explicit data roots: ${root}`);
  }
  return { root, state, layout: installLayout(root) };
}

async function gatewayStatus(url) {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return { running: false };
    const health = await response.json();
    if (health?.ok !== true || !Number.isInteger(health.pid) || health.pid <= 0) return { running: false };
    return { running: true, pid: health.pid, busy: health.isBusy === true, startedAt: health.startedAt ?? null };
  } catch {
    return { running: false };
  }
}

export async function recoveryStatus(options = {}) {
  const { root, state, layout } = await managedInstall(options);
  const gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  const activeRelease = join(layout.versions, stateReleaseId(state));
  return sanitizedValue({
    ok: true,
    product: "OpenBot",
    installRoot: root,
    stateSchemaVersion: state.schemaVersion,
    activeVersion: state.activeVersion,
    activeBuildId: state.activeBuildId ?? null,
    activeReleaseId: state.activeReleaseId ?? state.activeVersion,
    activeContentSha256: state.activeContentSha256 ?? state.manifestSha256 ?? null,
    previousVersion: state.previousVersion ?? null,
    previousBuildId: state.previousBuildId ?? null,
    previousReleaseId: state.previousReleaseId ?? state.previousVersion ?? null,
    dataRoot: state.dataRoot ?? null,
    localDataRoot: state.localDataRoot ?? null,
    activeReleasePresent: await pathExists(activeRelease),
    processStatePresent: await pathExists(layout.processState),
    gateway: await gatewayStatus(gatewayUrl),
    lastBackup: state.lastBackup ?? null,
    lastFailure: state.lastFailure ?? null,
  });
}

async function readLogTail(path, maxBytes = DIAGNOSTIC_LOG_BYTES) {
  const handle = await fs.open(path, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    return redactDiagnosticText(buffer.toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function diagnosticLogs(root) {
  const logsRoot = join(root, "logs");
  let entries;
  try {
    entries = await fs.readdir(logsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".log"))
    .map((entry) => entry.name)
    .sort()
    .slice(0, 8);
  const logs = {};
  for (const name of names) logs[name] = await readLogTail(join(logsRoot, name));
  return logs;
}

export async function runRecoveryCommand(command, options = {}) {
  if (command === "verify-backup") {
    if (!options.backup) throw new Error("--backup is required");
    const verified = await verifyDataBackup(options.backup);
    return { ok: true, verified: true, backup: { path: verified.root, manifest: sanitizedValue(verified.manifest) } };
  }

  const { root, state } = await managedInstall(options);
  const gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  const gatewayTimeoutMs = Number(options.gatewayTimeoutMs ?? 2_000);
  if (command === "status") return recoveryStatus({ ...options, root, gatewayUrl });

  if (command === "backup") {
    await assertGatewayStopped(gatewayUrl, gatewayTimeoutMs);
    const backup = await createDataBackup({
      dataRoot: state.dataRoot,
      localDataRoot: state.localDataRoot,
      backupRoot: options.backupRoot,
      activeVersion: state.activeVersion,
      activeReleaseId: state.activeReleaseId ?? state.activeVersion,
      env: options.env ?? process.env,
    });
    return { ok: true, backup: { path: backup.path, manifest: sanitizedValue(backup.manifest) } };
  }

  if (command === "restore") {
    if (options.yes !== true) throw new Error("Restore requires --yes");
    if (!options.backup) throw new Error("--backup is required");
    await assertGatewayStopped(gatewayUrl, gatewayTimeoutMs);
    await verifyDataBackup(options.backup);
    const preRestoreBackup = await createDataBackup({
      dataRoot: state.dataRoot,
      localDataRoot: state.localDataRoot,
      backupRoot: options.backupRoot,
      activeVersion: state.activeVersion,
      activeReleaseId: state.activeReleaseId ?? state.activeVersion,
      env: options.env ?? process.env,
    });
    await restoreDataBackup(options.backup, {
      dataRoot: state.dataRoot,
      localDataRoot: state.localDataRoot,
      env: options.env ?? process.env,
    });
    return { ok: true, restored: true, backup: resolve(options.backup), preRestoreBackup: { path: preRestoreBackup.path } };
  }

  if (command === "diagnostics") {
    if (!options.output) throw new Error("--output is required");
    const bundle = {
      schemaVersion: 1,
      product: "OpenBot",
      createdAt: new Date().toISOString(),
      status: await recoveryStatus({ ...options, root, gatewayUrl }),
      logs: await diagnosticLogs(root),
    };
    await atomicWriteJson(resolve(options.output), sanitizedValue(bundle));
    return { ok: true, diagnostics: resolve(options.output) };
  }

  throw new Error(`Unknown recovery command: ${command}`);
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "status";
  const args = parseArgs(argv.slice(1));
  const result = await runRecoveryCommand(command, {
    root: args.root,
    backup: args.backup,
    backupRoot: args["backup-root"],
    output: args.output,
    yes: args.yes === true,
    gatewayUrl: args["gateway-url"],
    gatewayTimeoutMs: args["gateway-timeout-ms"],
    env: process.env,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`[recovery] ${redactDiagnosticText(error.message)}`);
    process.exitCode = 1;
  });
}
