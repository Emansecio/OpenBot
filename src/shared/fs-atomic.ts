/**
 * Escrita de arquivos durável e atômica.
 *
 * writeFileAtomicSync: tmp único + fsync + rename + fsync do diretório
 * (best-effort — Windows pode não suportar fsync de diretório). O arquivo de
 * destino nunca fica parcialmente escrito e os dados sobrevivem a crash de
 * processo e, na maioria dos sistemas, a perda de energia.
 *
 * writeFileExclusiveSync: create-once durável ("wx" + fsync), preservando o
 * protocolo de criação atômica entre processos (quem perde lê o arquivo do
 * vencedor). Lança EEXIST como writeFileSync.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

// Antivírus/indexador do Windows seguram arquivos recém-escritos por instantes;
// só esses códigos são repetidos, com espera total limitada (~310 ms).
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160] as const;

function isTransientRenameError(error: unknown, platform: NodeJS.Platform): boolean {
  return platform === "win32" && TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}

export async function renameWithRetry(
  from: string,
  to: string,
  options: { rename?: (from: string, to: string) => Promise<void>; platform?: NodeJS.Platform } = {},
): Promise<void> {
  const renameFn = options.rename ?? rename;
  const platform = options.platform ?? process.platform;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFn(from, to);
      return;
    } catch (error) {
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !isTransientRenameError(error, platform)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

export function renameWithRetrySync(
  from: string,
  to: string,
  options: { rename?: (from: string, to: string) => void; platform?: NodeJS.Platform } = {},
): void {
  const renameFn = options.rename ?? renameSync;
  const platform = options.platform ?? process.platform;
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameFn(from, to);
      return;
    } catch (error) {
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !isTransientRenameError(error, platform)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // fsync de diretório não é suportado em todos os FS/plataformas.
  }
}

function writeAllSync(fd: number, data: string | Buffer): void {
  const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

export function writeFileAtomicSync(path: string, data: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = openSync(tmp, "wx", mode);
    writeAllSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameWithRetrySync(tmp, path);
    renamed = true;
    fsyncDir(dirname(path));
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Liberação best-effort; o erro original prevalece.
      }
    }
    if (!renamed) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Limpeza best-effort: o mesmo bloqueio que impediu o rename não pode
        // substituir o erro original.
      }
    }
  }
}

export function writeFileExclusiveSync(path: string, data: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number | undefined;
  // EEXIST propaga como em writeFileSync({ flag: "wx" }).
  fd = openSync(path, "wx", mode);
  try {
    writeAllSync(fd, data);
    fsyncSync(fd);
  } catch (error) {
    // O arquivo foi criado por esta chamada; não deixar conteúdo parcial.
    try {
      closeSync(fd);
      fd = undefined;
    } catch {
      // Liberação best-effort; o erro de escrita prevalece.
    }
    rmSync(path, { force: true });
    throw error;
  }
  closeSync(fd);
}

async function fsyncDirAsync(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // fsync de diretório não é suportado em todos os FS/plataformas.
  }
}

export interface AtomicWriteHooks {
  /** Runs after the temporary file is durable and before it replaces the target. */
  beforeRename?: () => void | Promise<void>;
}

/** Variante assíncrona de {@link writeFileAtomicSync} — mesma garantia de durabilidade. */
export async function writeFileAtomic(path: string, data: string | Buffer, mode = 0o600, hooks: AtomicWriteHooks = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    handle = await open(tmp, "wx", mode);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.beforeRename?.();
    await renameWithRetry(tmp, path);
    renamed = true;
    await fsyncDirAsync(dirname(path));
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Liberação best-effort; o erro original prevalece.
      }
    }
    if (!renamed) await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Variante assíncrona de {@link writeFileExclusiveSync} — create-once durável ("wx" + fsync). */
export async function writeFileExclusive(path: string, data: string | Buffer, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // EEXIST propaga como em writeFile({ flag: "wx" }).
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } catch (error) {
    // O arquivo foi criado por esta chamada; não deixar conteúdo parcial.
    try {
      await handle.close();
    } catch {
      // Liberação best-effort; o erro de escrita prevalece.
    }
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
}
