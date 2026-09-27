// Local Recovery Center for the checkout: status, data backup/verify/restore
// and a redacted diagnostics bundle. No telemetry; everything stays local.
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWriteJson,
  defaultDataRoot,
  defaultLocalDataRoot,
  isMainModule,
  parseArgs,
  pathExists,
} from "./common.mjs";
import { DEFAULT_GATEWAY_URL, buildStamp, checkoutRootId, processStatePath, readHealth } from "./gateway-control.mjs";
import { assertGatewayStopped, createDataBackup, restoreDataBackup, verifyDataBackup } from "./data-backup.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

function context(options) {
  const env = options.env ?? process.env;
  return {
    root: resolve(options.root ?? defaultRoot),
    dataRoot: resolve(options.dataRoot ?? defaultDataRoot(env)),
    localDataRoot: resolve(options.localDataRoot ?? defaultLocalDataRoot(env)),
    gatewayUrl: options.gatewayUrl ?? DEFAULT_GATEWAY_URL,
    gatewayTimeoutMs: Number(options.gatewayTimeoutMs ?? 2_000),
    env,
  };
}

async function gatewayStatus(url, root) {
  const health = await readHealth(url, { timeoutMs: 500 });
  if (health == null) return { running: false };
  return {
    running: true,
    pid: health.pid,
    busy: health.isBusy === true,
    startedAt: health.startedAt ?? null,
    thisCheckout: health.rootId === checkoutRootId(root),
    currentBuild: health.build === buildStamp(root),
  };
}

export async function recoveryStatus(options = {}) {
  const { root, dataRoot, localDataRoot, gatewayUrl } = context(options);
  return sanitizedValue({
    ok: true,
    product: "OpenBot",
    root,
    dataRoot,
    localDataRoot,
    buildPresent: await pathExists(join(root, "dist", "entry.js")),
    dataRootPresent: await pathExists(dataRoot),
    processStatePresent: await pathExists(processStatePath(root)),
    gateway: await gatewayStatus(gatewayUrl, root),
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
  const ctx = context(options);
  const roots = { dataRoot: ctx.dataRoot, localDataRoot: ctx.localDataRoot, env: ctx.env };
  const gatewayStopped = () => assertGatewayStopped({ url: ctx.gatewayUrl, timeoutMs: ctx.gatewayTimeoutMs, root: ctx.root });

  if (command === "status") return recoveryStatus(options);

  if (command === "verify-backup") {
    if (!options.backup) throw new Error("--backup is required");
    const verified = await verifyDataBackup(options.backup);
    return { ok: true, verified: true, backup: { path: verified.root, manifest: sanitizedValue(verified.manifest) } };
  }

  if (command === "backup") {
    await gatewayStopped();
    const backup = await createDataBackup({ ...roots, backupRoot: options.backupRoot });
    return { ok: true, backup: { path: backup.path, manifest: sanitizedValue(backup.manifest) } };
  }

  if (command === "restore") {
    if (options.yes !== true) throw new Error("Restore requires --yes");
    if (!options.backup) throw new Error("--backup is required");
    await gatewayStopped();
    const verified = await verifyDataBackup(options.backup);
    const preRestoreBackup = await createDataBackup({ ...roots, backupRoot: options.backupRoot, label: "pre-restore" });
    const restored = await restoreDataBackup(options.backup, { ...roots, verified });
    return {
      ok: true,
      restored: true,
      backup: verified.root,
      preRestoreBackup: { path: preRestoreBackup.path },
      ...(restored.leftovers.length > 0 ? { leftovers: restored.leftovers } : {}),
    };
  }

  if (command === "diagnostics") {
    if (!options.output) throw new Error("--output is required");
    const bundle = {
      schemaVersion: 1,
      product: "OpenBot",
      createdAt: new Date().toISOString(),
      status: await recoveryStatus(options),
      logs: await diagnosticLogs(ctx.root),
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
    dataRoot: args["data-root"],
    localDataRoot: args["local-data-root"],
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
