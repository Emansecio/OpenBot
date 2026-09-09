import { mkdirSync, renameSync, rmdirSync } from "node:fs";
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 as path } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_FILE_BYTES } from "../src/execution/contracts.js";
import { LocalFileExecutor } from "../src/execution/files.js";
import { WorkspaceQuota } from "../src/execution/quota.js";
import { WorkspaceSandbox } from "../src/execution/workspace.js";

const roots: string[] = [];
async function temp(prefix = "openbot-files-"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("LocalFileExecutor", () => {
  it("lista, escreve e lê somente dentro do workspace", async () => {
    const root = await temp();
    await mkdir(path.join(root, "src"));
    const executor = await LocalFileExecutor.create(root);

    await expect(executor.execute({ operation: "file.write", path: "src/note.txt", content: "olá", encoding: "utf8" }))
      .resolves.toEqual({ ok: true, operation: "file.write", bytes: 4 });
    await expect(executor.execute({ operation: "file.read", path: "src/note.txt", encoding: "utf8" }))
      .resolves.toEqual({ ok: true, operation: "file.read", content: "olá", encoding: "utf8", bytes: 4 });
    await expect(executor.execute({ operation: "file.list", path: "src" }))
      .resolves.toEqual({ ok: true, operation: "file.list", entries: [{ name: "note.txt", kind: "file" }] });
  });

  it("suporta base64 sem interpretar conteúdo", async () => {
    const root = await temp();
    const executor = await LocalFileExecutor.create(root);
    const content = Buffer.from([0, 1, 255]).toString("base64");
    expect(await executor.execute({ operation: "file.write", path: "bytes.bin", content, encoding: "base64" }))
      .toMatchObject({ ok: true, bytes: 3 });
    expect(await executor.execute({ operation: "file.read", path: "bytes.bin", encoding: "base64" }))
      .toMatchObject({ ok: true, content, bytes: 3 });
  });

  it("rejeita base64 malformado sem criar arquivo", async () => {
    const root = await temp();
    const executor = await LocalFileExecutor.create(root);

    for (const [index, content] of ["!!!!", "AA=A", "AAA", "AB=="].entries()) {
      expect(await executor.execute({
        operation: "file.write",
        path: `invalid-${index}.bin`,
        content,
        encoding: "base64"
      })).toMatchObject({ ok: false, code: "invalid_request" });
    }

    expect(await readdir(root)).toEqual([]);
  });

  it("preserva base64 válido e aplica o limite decodificado", async () => {
    const root = await temp();
    const executor = await LocalFileExecutor.create(root);
    const atLimit = Buffer.alloc(MAX_FILE_BYTES).toString("base64");
    const overLimit = Buffer.alloc(MAX_FILE_BYTES + 1).toString("base64");

    expect(await executor.execute({
      operation: "file.write",
      path: "at-limit.bin",
      content: atLimit,
      encoding: "base64"
    })).toMatchObject({ ok: true, bytes: MAX_FILE_BYTES });
    expect(await executor.execute({
      operation: "file.write",
      path: "over-limit.bin",
      content: overLimit,
      encoding: "base64"
    })).toMatchObject({ ok: false, code: "output_limit" });
    expect(await readdir(root)).toEqual(["at-limit.bin"]);
  });

  it("rejeita traversal e não altera arquivo externo", async () => {
    const root = await temp();
    const outside = path.join(path.dirname(root), "outside-openbot.txt");
    roots.push(outside);
    await writeFile(outside, "safe");
    const executor = await LocalFileExecutor.create(root);
    expect(await executor.execute({ operation: "file.write", path: "..\\outside-openbot.txt", content: "bad", encoding: "utf8" }))
      .toMatchObject({ ok: false, code: "outside_workspace" });
    expect(await readFile(outside, "utf8")).toBe("safe");
  });

  it("rejeita junction de escape", async () => {
    const root = await temp();
    const outside = await temp("openbot-files-outside-");
    await symlink(outside, path.join(root, "linked"), "junction");
    const executor = await LocalFileExecutor.create(root);
    expect(await executor.execute({ operation: "file.write", path: "linked/new.txt", content: "bad", encoding: "utf8" }))
      .toMatchObject({ ok: false, code: "outside_workspace" });
  });

  it("falha fechado quando o arquivo vira junction entre validação e abertura", async () => {
    const root = await temp();
    const outside = await temp("openbot-files-race-outside-");
    await writeFile(path.join(outside, "secret.txt"), "outside-secret");
    const target = path.join(root, "race.txt");
    await writeFile(target, "inside-secret");
    let raced = false;
    const workspace = await WorkspaceSandbox.create(root);
    const executor = LocalFileExecutor.fromWorkspace(workspace, undefined, {
      beforePathUse: async (absolute) => {
        if (raced || absolute !== target) return;
        raced = true;
        await rm(target, { force: true });
        await symlink(outside, target, "junction");
      },
    });

    expect(await executor.execute({ operation: "file.read", path: "race.txt", encoding: "utf8" }))
      .toMatchObject({ ok: false, code: "outside_workspace" });
    expect(raced).toBe(true);
  });

  it("aplica limite de leitura sem alocar o arquivo completo", async () => {
    const root = await temp();
    const largeFile = path.join(root, "large.bin");
    await writeFile(largeFile, Buffer.alloc(MAX_FILE_BYTES + 1));
    const executor = await LocalFileExecutor.create(root);
    const probe = await open(largeFile, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as typeof probe;
    await probe.close();
    const allocateReadBuffer = vi.spyOn(Buffer, "allocUnsafe");
    const readChunk = vi.spyOn(fileHandlePrototype, "read");
    const readWholeFile = vi.spyOn(fileHandlePrototype, "readFile");
    try {
      expect(await executor.execute({ operation: "file.read", path: "large.bin", encoding: "base64" }))
        .toMatchObject({ ok: false, code: "output_limit" });
      expect(allocateReadBuffer).not.toHaveBeenCalled();
      expect(readChunk).not.toHaveBeenCalled();
      expect(readWholeFile).not.toHaveBeenCalled();
    } finally {
      allocateReadBuffer.mockRestore();
      readChunk.mockRestore();
      readWholeFile.mockRestore();
    }
  });

  it("não inicia efeitos com signal previamente abortado", async () => {
    const root = await temp();
    const executor = await LocalFileExecutor.create(root);
    const controller = new AbortController();
    controller.abort();
    expect(await executor.execute({ operation: "file.write", path: "never.txt", content: "x", encoding: "utf8" }, controller.signal))
      .toMatchObject({ ok: false, code: "aborted" });
    expect(await readdir(root)).toEqual([]);
  });

  it("não deixa temporários após escrita atômica", async () => {
    const root = await temp();
    const executor = await LocalFileExecutor.create(root);
    await executor.execute({ operation: "file.write", path: "final.txt", content: "done", encoding: "utf8" });
    expect(await readdir(root)).toEqual(["final.txt"]);
  });

  it("mantém a quota carregada quando a validação falha após o rename", async () => {
    const root = await temp();
    const directory = path.join(root, "nested");
    const displaced = path.join(root, "displaced");
    const destination = path.join(directory, "first.txt");
    await mkdir(directory);
    const workspace = await WorkspaceSandbox.create(root);
    const quota = new WorkspaceQuota(workspace, { maxBytes: 2, maxFiles: 1, maxEntries: 10 });
    const reserve = quota.reserve.bind(quota);
    let raced = false;
    vi.spyOn(quota, "reserve").mockImplementation(async (...args) => {
      const reservation = await reserve(...args);
      return {
        commit: () => {
          reservation.commit();
          if (raced) return;
          raced = true;
          renameSync(directory, displaced);
          mkdirSync(directory);
          renameSync(path.join(displaced, "first.txt"), destination);
          rmdirSync(displaced);
        },
        cancel: () => reservation.cancel(),
      };
    });
    const markUsageDirty = vi.spyOn(quota, "markUsageDirty");
    const executor = LocalFileExecutor.fromWorkspace(workspace, quota);

    await expect(executor.execute({ operation: "file.write", path: "nested/first.txt", content: "x", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: false, code: "outside_workspace" });
    await expect(readFile(destination, "utf8")).resolves.toBe("x");
    expect(markUsageDirty).toHaveBeenCalledOnce();
    await expect(executor.execute({ operation: "file.write", path: "nested/second.txt", content: "y", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: false, code: "quota_exceeded" });
  });

  it("oferece stat/mkdir/copy/move e lixeira recuperável sem expor .openbot", async () => {
    const root = await temp();
    const executor = await LocalFileExecutor.create(root);

    await expect(executor.execute({ operation: "file.stat", path: "." }))
      .resolves.toEqual({ ok: true, operation: "file.stat", kind: "directory", bytes: 0 });
    await expect(executor.execute({ operation: "file.mkdir", path: "nested/dir" }))
      .resolves.toEqual({ ok: true, operation: "file.mkdir", created: true });
    await executor.execute({ operation: "file.write", path: "nested/dir/source.txt", content: "copy me", encoding: "utf8" });

    await expect(executor.execute({ operation: "file.copy", source: "nested/dir/source.txt", destination: "copy.txt" }))
      .resolves.toEqual({ ok: true, operation: "file.copy", bytes: 7, entries: 1 });
    await expect(executor.execute({ operation: "file.move", source: "copy.txt", destination: "nested/moved.txt" }))
      .resolves.toEqual({ ok: true, operation: "file.move" });
    const trashed = await executor.execute({ operation: "file.trash", path: "nested/moved.txt" });
    expect(trashed).toMatchObject({ ok: true, operation: "file.trash" });
    if (!trashed.ok || trashed.operation !== "file.trash") throw new Error("trash did not return an id");
    expect((await readdir(root)).sort()).toEqual([".openbot", "nested"]);
    await expect(executor.execute({ operation: "file.list", path: "." })).resolves.toEqual({
      ok: true,
      operation: "file.list",
      entries: [{ name: "nested", kind: "directory" }],
    });
    await expect(executor.execute({ operation: "file.restore", trashId: trashed.trashId }))
      .resolves.toEqual({ ok: true, operation: "file.restore", path: "nested\\moved.txt" });
    await expect(readFile(path.join(root, "nested", "moved.txt"), "utf8")).resolves.toBe("copy me");
  });

  it("reserva maxEntries para mkdir concorrente e rejeita o segundo criador", async () => {
    const root = await temp();
    const workspace = await WorkspaceSandbox.create(root);
    const quota = new WorkspaceQuota(workspace, { maxBytes: 1024, maxFiles: 10, maxEntries: 1 });
    const executor = LocalFileExecutor.fromWorkspace(workspace, quota);
    const results = await Promise.all([
      executor.execute({ operation: "file.mkdir", path: "one" }),
      executor.execute({ operation: "file.mkdir", path: "two" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "quota_exceeded")).toHaveLength(1);
  });

  it("não copia árvores que contenham symlink nem deixa staging visível", async () => {
    const root = await temp();
    const outside = await temp("openbot-copy-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await mkdir(path.join(root, "source"));
    await symlink(outside, path.join(root, "source", "linked"), "junction");
    const executor = await LocalFileExecutor.create(root);
    expect(await executor.execute({ operation: "file.copy", source: "source", destination: "destination" }))
      .toMatchObject({ ok: false, code: "outside_workspace" });
    expect(await readdir(root)).toEqual(["source"]);
  });

  it("copia diretórios como uma unidade e não sobrescreve destino existente", async () => {
    const root = await temp();
    await mkdir(path.join(root, "source", "child"), { recursive: true });
    await writeFile(path.join(root, "source", "child", "data.txt"), "data");
    const executor = await LocalFileExecutor.create(root);

    await expect(executor.execute({ operation: "file.copy", source: "source", destination: "clone" }))
      .resolves.toEqual({ ok: true, operation: "file.copy", bytes: 4, entries: 3 });
    await expect(executor.execute({ operation: "file.copy", source: "source", destination: "clone" }))
      .resolves.toMatchObject({ ok: false, code: "invalid_path" });
    await expect(readFile(path.join(root, "clone", "child", "data.txt"), "utf8")).resolves.toBe("data");
  });

  it("não restaura sobre conflito e mantém a entrada recuperável", async () => {
    const root = await temp();
    const executor = await LocalFileExecutor.create(root);
    await executor.execute({ operation: "file.write", path: "conflict.txt", content: "original", encoding: "utf8" });
    const trashed = await executor.execute({ operation: "file.trash", path: "conflict.txt" });
    if (!trashed.ok || trashed.operation !== "file.trash") throw new Error("trash did not return an id");
    await executor.execute({ operation: "file.write", path: "conflict.txt", content: "new", encoding: "utf8" });
    await expect(executor.execute({ operation: "file.restore", trashId: trashed.trashId }))
      .resolves.toMatchObject({ ok: false, code: "invalid_path" });
    await expect(readFile(path.join(root, "conflict.txt"), "utf8")).resolves.toBe("new");
    await expect(executor.execute({ operation: "file.restore", trashId: trashed.trashId, path: "restored.txt" }))
      .resolves.toMatchObject({ ok: true, operation: "file.restore" });
    await expect(readFile(path.join(root, "restored.txt"), "utf8")).resolves.toBe("original");
  });

  it("reserva também a estrutura interna antes de mover para a lixeira", async () => {
    const root = await temp();
    const workspace = await WorkspaceSandbox.create(root);
    const quota = new WorkspaceQuota(workspace, { maxBytes: 1024, maxFiles: 10, maxEntries: 4 });
    const executor = LocalFileExecutor.fromWorkspace(workspace, quota);
    await expect(executor.execute({ operation: "file.write", path: "item.txt", content: "x", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: true });
    await expect(executor.execute({ operation: "file.trash", path: "item.txt" }))
      .resolves.toMatchObject({ ok: false, code: "quota_exceeded" });
    await expect(readFile(path.join(root, "item.txt"), "utf8")).resolves.toBe("x");
    await expect(readdir(root)).resolves.toEqual(["item.txt"]);
  });
});
