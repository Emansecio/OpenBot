import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({
  failTempWrite: undefined as Error | undefined,
  failRenameSync: undefined as Error | undefined,
  failRmSync: undefined as Error | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: vi.fn(actual.rm),
    unlink: vi.fn(actual.unlink),
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (faults.failTempWrite !== undefined && String(args[0]).endsWith(".tmp")) {
        const failure = faults.failTempWrite;
        handle.writeFile = async () => { throw failure; };
      }
      return handle;
    }),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: vi.fn((from: string, to: string) => {
      if (faults.failRenameSync !== undefined) throw faults.failRenameSync;
      actual.renameSync(from, to);
    }),
    rmSync: vi.fn((...args: Parameters<typeof actual.rmSync>) => {
      if (faults.failRmSync !== undefined) throw faults.failRmSync;
      actual.rmSync(...args);
    }),
  };
});

import * as fsp from "node:fs/promises";
import { writeFileAtomic, writeFileAtomicSync } from "../src/shared/fs-atomic.js";

const roots: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openbot-fs-atomic-"));
  roots.push(dir);
  return dir;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  faults.failTempWrite = undefined;
  faults.failRenameSync = undefined;
  faults.failRmSync = undefined;
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("writeFileAtomic", () => {
  it("remove o temporário quando a escrita falha e preserva o destino", async () => {
    const dir = await makeDir();
    const file = join(dir, "sand-secrets.json");
    const previous = '{"old":true}\n';
    await writeFile(file, previous, "utf8");
    const writeFailure = new Error("injected write failure");
    faults.failTempWrite = writeFailure;

    await expect(writeFileAtomic(file, '{"next":true}\n')).rejects.toBe(writeFailure);
    faults.failTempWrite = undefined;

    expect(await readFile(file, "utf8")).toBe(previous);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("não remove o destino depois do rename bem-sucedido", async () => {
    const dir = await makeDir();
    const file = join(dir, "sand-secrets.json");

    await writeFileAtomic(file, '{"next":true}\n');

    expect(fsp.rm).not.toHaveBeenCalled();
    expect(fsp.unlink).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe('{"next":true}\n');
  });

  it("executa beforeRename depois do temporário durável e antes da troca", async () => {
    const dir = await makeDir();
    const file = join(dir, "target.json");
    await writeFile(file, "old", "utf8");
    let seen: string | undefined;

    await writeFileAtomic(file, "new", 0o600, {
      beforeRename: async () => { seen = await readFile(file, "utf8"); },
    });

    expect(seen).toBe("old");
    expect(await readFile(file, "utf8")).toBe("new");
  });
});

describe("writeFileAtomicSync", () => {
  it("mantém o erro original do rename mesmo quando a limpeza também falha", async () => {
    const dir = await makeDir();
    const file = join(dir, "config.json");
    const renameFailure = Object.assign(new Error("rename blocked"), { code: "ENOENT" });
    faults.failRenameSync = renameFailure;
    faults.failRmSync = Object.assign(new Error("cleanup blocked"), { code: "EPERM" });

    expect(() => writeFileAtomicSync(file, "data")).toThrow(renameFailure);
  });

  it("não tenta limpar o temporário depois de um rename bem-sucedido", async () => {
    const dir = await makeDir();
    const file = join(dir, "config.json");
    const { rmSync } = await import("node:fs");

    writeFileAtomicSync(file, "data");

    expect(rmSync).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("data");
  });
});
