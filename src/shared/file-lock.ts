/**
 * Advisory cross-process lock backed by an exclusive `<target>.lock` file.
 *
 * The lock records `{ pid, token }`. A waiter reclaims it when the owner PID is
 * gone, or when the lock is older than `staleMs` even though the PID looks
 * alive: Windows reuses PIDs, and a release that failed (antivirus holding the
 * file) must not wedge every later writer. The age rule means a holder that
 * keeps the lock longer than `staleMs` can lose it, so critical sections must
 * stay well below that bound — config commits and keystore writes take
 * milliseconds.
 *
 * Releasing is best-effort and never replaces the task's outcome: a lock that
 * could not be removed is reclaimed by the age rule instead.
 */
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileLockOptions {
  /** Maximum wait for the lock. */
  timeoutMs?: number;
  /** Pause between attempts. */
  retryMs?: number;
  /** Age after which a lock is reclaimed even when its owner PID looks alive. Defaults to `timeoutMs`. */
  staleMs?: number;
  /** Prefix for the timeout error, e.g. `config`. */
  label?: string;
}

interface LockRecord {
  pid: number;
  token: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_MS = 10;
const TRANSIENT_UNLINK_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const UNLINK_RETRY_DELAYS_MS = [10, 25, 50] as const;
const syncWait = new Int32Array(new SharedArrayBuffer(4));

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseRecord(text: string): LockRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { pid, token } = value as Record<string, unknown>;
    return typeof pid === "number" && typeof token === "string" ? { pid, token } : null;
  } catch {
    return null;
  }
}

function settings(options: FileLockOptions): Required<FileLockOptions> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    timeoutMs,
    retryMs: options.retryMs ?? DEFAULT_RETRY_MS,
    staleMs: options.staleMs ?? timeoutMs,
    label: options.label ?? "lock",
  };
}

const isTransientUnlink = (error: unknown): boolean =>
  TRANSIENT_UNLINK_CODES.has((error as NodeJS.ErrnoException | undefined)?.code ?? "");

// ---------------------------------------------------------------------------
// Synchronous variant
// ---------------------------------------------------------------------------

function readRecordSync(file: string): LockRecord | null {
  try {
    return parseRecord(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function unlinkWithRetrySync(file: string): boolean {
  for (let attempt = 0; ; attempt += 1) {
    try {
      unlinkSync(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      if (attempt >= UNLINK_RETRY_DELAYS_MS.length || !isTransientUnlink(error)) return false;
      Atomics.wait(syncWait, 0, 0, UNLINK_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** Removes the lock only while it still carries `token`. Never throws. */
function releaseSync(file: string, token: string): void {
  if (readRecordSync(file)?.token !== token) return;
  unlinkWithRetrySync(file);
}

function tryCreateSync(file: string, token: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    // No fsync: a torn record reads as ownerless and is reclaimed by age.
    writeSync(fd, JSON.stringify({ pid: process.pid, token }));
  } catch (error) {
    closeSync(fd);
    unlinkWithRetrySync(file);
    throw error;
  }
  closeSync(fd);
  return true;
}

/** Returns true when a stale lock was removed and acquisition should retry immediately. */
function reclaimIfStaleSync(file: string, staleMs: number): boolean {
  const owner = readRecordSync(file);
  if (owner !== null && !isProcessAlive(owner.pid)) {
    releaseSync(file, owner.token);
    return true;
  }
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(file).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if (ageMs < staleMs) return false;
  if (owner === null) unlinkWithRetrySync(file);
  else releaseSync(file, owner.token);
  return true;
}

export function withFileLockSync<T>(target: string, task: () => T, options: FileLockOptions = {}): T {
  const { timeoutMs, retryMs, staleMs, label } = settings(options);
  const file = `${target}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(file), { recursive: true });
  while (!tryCreateSync(file, token)) {
    if (reclaimIfStaleSync(file, staleMs)) continue;
    if (Date.now() >= deadline) throw new Error(`${label}: timeout aguardando lock de ${target}`);
    Atomics.wait(syncWait, 0, 0, retryMs);
  }
  try {
    return task();
  } finally {
    releaseSync(file, token);
  }
}

// ---------------------------------------------------------------------------
// Asynchronous variant
// ---------------------------------------------------------------------------

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function readRecord(file: string): Promise<LockRecord | null> {
  try {
    return parseRecord(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function unlinkWithRetry(file: string): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await unlink(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      if (attempt >= UNLINK_RETRY_DELAYS_MS.length || !isTransientUnlink(error)) return false;
      await delay(UNLINK_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

async function release(file: string, token: string): Promise<void> {
  if ((await readRecord(file))?.token !== token) return;
  await unlinkWithRetry(file);
}

async function tryCreate(file: string, token: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlinkWithRetry(file);
    throw error;
  }
  await handle.close();
  return true;
}

async function reclaimIfStale(file: string, staleMs: number): Promise<boolean> {
  const owner = await readRecord(file);
  if (owner !== null && !isProcessAlive(owner.pid)) {
    await release(file, owner.token);
    return true;
  }
  let ageMs: number;
  try {
    ageMs = Date.now() - (await stat(file)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if (ageMs < staleMs) return false;
  if (owner === null) await unlinkWithRetry(file);
  else await release(file, owner.token);
  return true;
}

export async function withFileLock<T>(target: string, task: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const { timeoutMs, retryMs, staleMs, label } = settings(options);
  const file = `${target}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(file), { recursive: true });
  while (!(await tryCreate(file, token))) {
    if (await reclaimIfStale(file, staleMs)) continue;
    if (Date.now() >= deadline) throw new Error(`${label}: timeout aguardando lock de ${target}`);
    await delay(retryMs);
  }
  try {
    return await task();
  } finally {
    await release(file, token);
  }
}
