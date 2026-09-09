import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface LocalFileLoggerOptions {
  path: string;
  maxBytes?: number;
  backups?: number;
  secrets?: readonly string[];
  now?: () => Date;
}

export interface LocalFileLogger {
  write(level: string, message: string): void;
}

export function redactLogText(value: unknown, secrets: readonly string[] = []): string {
  let output = String(value)
    .replace(/(bearer\s+)[^\s"']+/giu, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)"?\s*[:=]\s*"?)[^\s,"'}]+/giu, "$1[REDACTED]");
  for (const secret of secrets) {
    // Floor avoids corrupting every log line with a short common substring;
    // ceiling avoids a pathological env value making each redaction O(n*m).
    if (secret.length >= 8 && secret.length <= 4096 && secret.trim().length > 0) {
      output = output.replaceAll(secret, "[REDACTED]");
    }
  }
  return output;
}

function rotate(path: string, backups: number): void {
  rmSync(`${path}.${backups}`, { force: true });
  for (let index = backups - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    if (existsSync(source)) renameSync(source, `${path}.${index + 1}`);
  }
  if (existsSync(path)) renameSync(path, `${path}.1`);
}

function boundedLine(value: string, maxBytes: number): Buffer {
  const line = Buffer.from(value.endsWith("\n") ? value : `${value}\n`, "utf8");
  if (line.length <= maxBytes) return line;
  const suffix = Buffer.from("...[TRUNCATED]\n", "utf8");
  return Buffer.concat([line.subarray(0, Math.max(0, maxBytes - suffix.length)), suffix]);
}

export function createLocalFileLogger(options: LocalFileLoggerOptions): LocalFileLogger {
  const path = resolve(options.path);
  const maxBytes = Number(options.maxBytes ?? 2 * 1024 * 1024);
  const backups = Number(options.backups ?? 2);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 32) throw new Error("Local log maxBytes must be at least 32");
  if (!Number.isSafeInteger(backups) || backups < 1 || backups > 9) throw new Error("Local log backups must be between 1 and 9");
  mkdirSync(dirname(path), { recursive: true });
  const now = options.now ?? (() => new Date());
  const secrets = options.secrets ?? [];
  return {
    write(level, message) {
      const safeLevel = String(level).replaceAll(/[^A-Z]/giu, "").slice(0, 10) || "INFO";
      const safeMessage = redactLogText(message, secrets);
      const entry = boundedLine(`${now().toISOString()} ${safeLevel} ${safeMessage}`, maxBytes);
      const currentBytes = existsSync(path) ? statSync(path).size : 0;
      if (currentBytes + entry.length > maxBytes) rotate(path, backups);
      appendFileSync(path, entry);
    },
  };
}

function formatArgument(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function installLocalFileLoggerFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  target: Pick<Console, "log" | "info" | "warn" | "error"> = console,
): { installed: boolean; restore(): void } {
  const logDir = env.OPENBOT_LOG_DIR?.trim();
  if (!logDir) return { installed: false, restore() {} };
  const maxBytes = Number(env.OPENBOT_LOG_MAX_BYTES ?? 2 * 1024 * 1024);
  const backups = Number(env.OPENBOT_LOG_BACKUPS ?? 2);
  const secrets = Object.entries(env)
    .filter(([name, value]) => value != null && !name.endsWith("_PATH") && /(?:KEY|TOKEN|SECRET|PASSWORD)/iu.test(name))
    .map(([, value]) => value as string);
  const original = { log: target.log, info: target.info, warn: target.warn, error: target.error };
  let standard: LocalFileLogger;
  let errors: LocalFileLogger;
  try {
    standard = createLocalFileLogger({ path: join(logDir, "gateway.log"), maxBytes, backups, secrets });
    errors = createLocalFileLogger({ path: join(logDir, "gateway-error.log"), maxBytes, backups, secrets });
  } catch {
    return { installed: false, restore() {} };
  }
  let writing = false;
  const write = (logger: LocalFileLogger, level: string, values: unknown[]) => {
    if (writing) return;
    writing = true;
    try {
      try {
        logger.write(level, values.map(formatArgument).join(" "));
      } catch {
        // Logging must never terminate the local gateway.
      }
    } finally {
      writing = false;
    }
  };
  target.log = (...values: unknown[]) => write(standard, "INFO", values);
  target.info = (...values: unknown[]) => write(standard, "INFO", values);
  target.warn = (...values: unknown[]) => write(errors, "WARN", values);
  target.error = (...values: unknown[]) => write(errors, "ERROR", values);
  return {
    installed: true,
    restore() {
      target.log = original.log;
      target.info = original.info;
      target.warn = original.warn;
      target.error = original.error;
    },
  };
}
