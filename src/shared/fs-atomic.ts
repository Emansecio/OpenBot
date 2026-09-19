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
  try {
    fd = openSync(tmp, "wx", mode);
    writeAllSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    fsyncDir(dirname(path));
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Liberação best-effort; o erro original prevalece.
      }
    }
    rmSync(tmp, { force: true });
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

/** Variante assíncrona de {@link writeFileAtomicSync} — mesma garantia de durabilidade. */
export async function writeFileAtomic(path: string, data: string | Buffer, mode = 0o600): Promise<void> {
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
    await rename(tmp, path);
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
