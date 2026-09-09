import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalFileExecutor } from "../src/execution/files.js";
import { WorkspaceQuotaObserver } from "../src/execution/quota-observer.js";
import {
  WorkspaceQuota,
  WorkspaceQuotaError,
  assertGlobalDiskBudget,
  calculateWorkspaceUsage,
  measureManagedDiskBytes,
  resolveGlobalDiskBudgetBytes,
} from "../src/execution/quota.js";
import { WorkspaceSandbox } from "../src/execution/workspace.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace inventory and quota", () => {
  it("calcula bytes/arquivos sem seguir symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-quota-"));
    roots.push(root);
    await writeFile(join(root, "one.txt"), "1234");
    const outside = await mkdtemp(join(tmpdir(), "openbot-quota-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await expect(symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir")).resolves.toBeUndefined();

    const usage = await calculateWorkspaceUsage(root);
    expect(usage.files).toBe(1);
    expect(usage.bytes).toBe(4);
  });

  it("impede write que ultrapassa bytes reservados e libera reserva cancelada", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-quota-write-"));
    roots.push(root);
    await mkdir(join(root, "Documents"));
    const workspace = await WorkspaceSandbox.create(root);
    const quota = new WorkspaceQuota(workspace, { maxBytes: 12, maxFiles: 100 });
    const files = LocalFileExecutor.fromWorkspace(workspace, quota);

    await expect(files.execute({ operation: "file.write", path: "Documents/a.txt", content: "123456", encoding: "utf8" })).resolves.toMatchObject({ ok: true });
    await expect(files.execute({ operation: "file.write", path: "Documents/b.txt", content: "123456789", encoding: "utf8" })).resolves.toMatchObject({ ok: false, code: "quota_exceeded" });
    await expect(readFile(join(root, "Documents", "b.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(files.execute({ operation: "file.write", path: "Documents/c.txt", content: "123456", encoding: "utf8" })).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(root, "Documents", "c.txt"), "utf8")).resolves.toBe("123456");
  });

  it("usa inventário incremental depois do primeiro scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-quota-incremental-"));
    roots.push(root);
    const workspace = await WorkspaceSandbox.create(root);
    const scan = vi.fn(async () => ({ bytes: 0, files: 0, directories: 0, entries: 0 }));
    const quota = new WorkspaceQuota(workspace, { maxBytes: 100, maxFiles: 100, maxEntries: 100 }, scan);

    const first = await quota.reserveDelta({ bytes: 10, files: 1, entries: 1 });
    first.commit();
    const second = await quota.reserveDelta({ bytes: 10, files: 1, entries: 1 });
    second.commit();

    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("detecta workspace que ultrapassou a quota fora do executor estruturado", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-quota-external-"));
    roots.push(root);
    await writeFile(join(root, "external.bin"), "12345");
    const workspace = await WorkspaceSandbox.create(root);
    const quota = new WorkspaceQuota(workspace, { maxBytes: 4, maxFiles: 10, maxEntries: 10 });

    await expect(quota.assertWithinQuota()).rejects.toThrow(/5.*4|4.*5/u);
  });

  it("reserva maxEntries atomicamente entre writes concorrentes", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-quota-entries-"));
    roots.push(root);
    const workspace = await WorkspaceSandbox.create(root);
    const quota = new WorkspaceQuota(workspace, { maxBytes: 100, maxFiles: 100, maxEntries: 1 });
    const files = LocalFileExecutor.fromWorkspace(workspace, quota);

    const results = await Promise.all([
      files.execute({ operation: "file.write", path: "one.txt", content: "1", encoding: "utf8" }),
      files.execute({ operation: "file.write", path: "two.txt", content: "2", encoding: "utf8" }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ code: "quota_exceeded" });
    expect((await calculateWorkspaceUsage(root)).entries).toBe(1);
  });

  it("does not walk .openbot/trash payloads when calculating usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-quota-trash-"));
    roots.push(root);
    await mkdir(join(root, ".openbot", "trash", "entry"), { recursive: true });
    await writeFile(join(root, "keep.txt"), "tiny");
    await writeFile(join(root, ".openbot", "trash", "entry", "payload"), "x".repeat(10_000));
    const usage = await calculateWorkspaceUsage(root);
    expect(usage.bytes).toBe(4);
    expect(usage.files).toBe(1);
  });

  it("observa create, grow, truncate, rename e delete como deltas serializados", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-quota-observer-"));
    roots.push(root);
    let emit!: (event: string, filename: string | Buffer | null) => void;
    let emitError!: (error: Error) => void;
    const deltas: Array<{ bytes: number; files: number; entries: number }> = [];
    const watcher = {
      on(event: string, listener: (error: Error) => void) {
        if (event === "error") emitError = listener;
        return this;
      },
      close: vi.fn(),
    };
    const observer = new WorkspaceQuotaObserver({
      root,
      onDelta: async (delta) => { deltas.push(delta); },
      watch: (_root, _options, listener) => {
        emit = listener;
        return watcher;
      },
    });
    await observer.start();

    const first = join(root, "first.txt");
    const second = join(root, "second.txt");
    await writeFile(first, "1234");
    emit("rename", "first.txt");
    await observer.drain();
    await writeFile(first, "123456");
    emit("change", "first.txt");
    await observer.drain();
    await writeFile(first, "1");
    emit("change", "first.txt");
    await observer.drain();
    await rename(first, second);
    emit("rename", "first.txt");
    emit("rename", "second.txt");
    await observer.drain();
    await unlink(second);
    emit("rename", "second.txt");
    await observer.drain();

    expect(deltas).toEqual([
      { bytes: 4, files: 1, entries: 1 },
      { bytes: 2, files: 0, entries: 0 },
      { bytes: -5, files: 0, entries: 0 },
      { bytes: -1, files: -1, entries: -1 },
      { bytes: 1, files: 1, entries: 1 },
      { bytes: -1, files: -1, entries: -1 },
    ]);
    expect(emitError).toBeTypeOf("function");
    await observer.close();
  });

  it("falha fechado quando o watcher perde autoridade", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-quota-observer-error-"));
    roots.push(root);
    let emitError!: (error: Error) => void;
    const onError = vi.fn();
    const observer = new WorkspaceQuotaObserver({
      root,
      onDelta: async () => undefined,
      onError,
      watch: () => ({
        on(event: string, listener: (error: Error) => void) {
          if (event === "error") emitError = listener;
          return this;
        },
        close: vi.fn(),
      }),
    });
    await observer.start();

    emitError(new Error("watch overflow"));

    await expect(observer.drain()).rejects.toThrow(/watch overflow/u);
    expect(onError).toHaveBeenCalledTimes(1);
    await expect(observer.close()).rejects.toThrow(/watch overflow/u);
  });
});

describe("global disk budget", () => {
  it("measures managed roots and skips staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-global-disk-"));
    roots.push(root);
    await mkdir(join(root, ".staging"), { recursive: true });
    await writeFile(join(root, ".staging", "tmp.bin"), "xxxx");
    await writeFile(join(root, "keep.bin"), "1234");
    expect(await measureManagedDiskBytes([root])).toBe(4);
    expect(resolveGlobalDiskBudgetBytes({ OPENBOT_GLOBAL_DISK_BUDGET_BYTES: "1048576" })).toBe(1_048_576);
    expect(() => assertGlobalDiskBudget(10, 0, 32)).not.toThrow();
  });

  it("rejects admission when used bytes meet the budget", () => {
    expect(() => assertGlobalDiskBudget(32, 0, 32)).toThrow(WorkspaceQuotaError);
    expect(resolveGlobalDiskBudgetBytes({ OPENBOT_GLOBAL_DISK_BUDGET_BYTES: "0" })).toBeGreaterThan(0);
  });
});
