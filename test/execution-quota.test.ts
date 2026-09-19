import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalFileExecutor } from "../src/execution/files.js";
import { WorkspaceQuotaObserver, type WorkspaceWatch } from "../src/execution/quota-observer.js";
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
  it("coalesces a burst and looks up only the changed subtree", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-quota-burst-"));
    roots.push(root);
    await Promise.all(Array.from({ length: 256 }, (_, index) => writeFile(join(root, `${index}.txt`), "x")));
    let emit!: (event: string, filename: string | Buffer | null) => void;
    const onDelta = vi.fn();
    const onScan = vi.fn();
    const observer = new WorkspaceQuotaObserver({ root, onDelta, onScan,
      watch: (_root, _options, listener) => {
        emit = listener;
        return { on() { return this; }, close() {} };
      },
    });
    await observer.start();
    try {
      await writeFile(join(root, "0.txt"), "xxxx");
      for (let index = 0; index < 10_000; index += 1) emit("change", "0.txt");
      await observer.drain();
      expect(onDelta).toHaveBeenCalledExactlyOnceWith({ bytes: 3, files: 0, entries: 0 }, join(root, "0.txt"));
      expect(observer.metrics()).toMatchObject({ events: 10_000, coalescedEvents: 9_999,
        peakPendingPaths: 1, reconciledPaths: 2, visitedEntries: 1 });
      expect(onScan).toHaveBeenCalledTimes(1);
      // Unique-path overflow is bounded and falls back to a single full walk.
      for (let index = 0; index < 5_000; index += 1) emit("change", `missing-${index}.txt`);
      await observer.drain();
      expect(observer.metrics().peakPendingPaths).toBe(1024);
      expect(onScan).toHaveBeenCalledTimes(2);
    } finally { await observer.close(); }
  });

  it("shares one inventory and reconciles structured writes without double counting", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-quota-shared-"));
    roots.push(root);
    await mkdir(join(root, "Downloads"));
    const quota = new WorkspaceQuota(await WorkspaceSandbox.create(root), {
      maxBytes: 10, maxFiles: 10, maxEntries: 20,
      scopes: { downloads: { maxBytes: 10, maxFiles: 10 } },
    });
    let emit!: (event: string, filename: string | Buffer | null) => void;
    const close = vi.fn();
    const watch = vi.fn<WorkspaceWatch>((_root, _options, listener) => {
      emit = listener;
      return { on() { return this; }, close };
    });
    const onError = vi.fn();
    const [one, two] = await Promise.all([quota.observeProcesses(onError, watch), quota.observeProcesses(vi.fn(), watch)]);
    try {
      expect(watch).toHaveBeenCalledTimes(1);
      expect(quota.metrics()).toMatchObject({ scans: 1, observationStarts: 1, activeProcesses: 2 });
      const target = join(root, "Downloads", "a.txt");
      const reservation = await quota.reserve(target, 4);
      await writeFile(target, "1234");
      emit("change", "Downloads/a.txt");
      reservation.commit();
      await one.drain();
      const next = await quota.reserve(join(root, "Downloads", "b.txt"), 6);
      next.cancel();
      await one.drain();
      expect(onError).not.toHaveBeenCalled();
      await one.close();
      expect(close).not.toHaveBeenCalled();
      expect(quota.metrics().activeProcesses).toBe(1);
      // Silent external write: final reconciliation cannot trust watcher events.
      await writeFile(target, "12345678901");
      await expect(two.close()).rejects.toBeInstanceOf(WorkspaceQuotaError);
      expect(close).toHaveBeenCalledTimes(1);
      expect(quota.metrics().activeObservers).toBe(0);
      await expect(quota.assertWithinQuota()).rejects.toBeInstanceOf(WorkspaceQuotaError);
    } finally { await one.close().catch(() => undefined); await two.close().catch(() => undefined); }
  });

  it("waits for the retiring observer final reconciliation before starting a new authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-quota-handoff-"));
    roots.push(root);
    const quota = new WorkspaceQuota(await WorkspaceSandbox.create(root), { maxBytes: 10, maxFiles: 10, observationIdleMs: 0 });
    const watch = vi.fn<WorkspaceWatch>(() => ({ on() { return this; }, close() {} }));
    const first = await quota.observeProcesses(vi.fn(), watch);
    const reservation = await quota.reserve(join(root, "held.txt"), 4);
    // The outstanding structured reservation deterministically blocks the
    // retiring observer's final walk on the quota's reservation lock.
    const closing = first.close();
    const joining = quota.observeProcesses(vi.fn(), watch);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(watch).toHaveBeenCalledTimes(1);
      expect(quota.metrics().scans).toBe(1);
      await writeFile(join(root, "held.txt"), "1234");
    } finally { reservation.commit(); }
    await closing;
    const second = await joining;
    try {
      expect(watch).toHaveBeenCalledTimes(2);
      expect(quota.metrics()).toMatchObject({ scans: 3, activeObservers: 1, activeProcesses: 1 });
      await expect(quota.reserve(join(root, "extra.txt"), 7)).rejects.toBeInstanceOf(WorkspaceQuotaError);
    } finally { await second.close(); }
  });

  it("reuses the warm observer across sequential consumers within the idle window", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-quota-idle-"));
    roots.push(root);
    const quota = new WorkspaceQuota(await WorkspaceSandbox.create(root), { maxBytes: 10, maxFiles: 10, observationIdleMs: 30 });
    const watch = vi.fn<WorkspaceWatch>(() => ({ on() { return this; }, close() {} }));
    const first = await quota.observeProcesses(vi.fn(), watch);
    await writeFile(join(root, "a.txt"), "1234");
    await first.close();
    // Boundary validation ran, but the authority stays warm instead of retiring.
    expect(quota.metrics()).toMatchObject({ scans: 2, activeObservers: 1, activeProcesses: 0 });
    const second = await quota.observeProcesses(vi.fn(), watch);
    try {
      expect(watch).toHaveBeenCalledTimes(1);
      expect(quota.metrics()).toMatchObject({ scans: 2, observationStarts: 1, activeProcesses: 1 });
      await expect(quota.reserve(join(root, "b.txt"), 7)).rejects.toBeInstanceOf(WorkspaceQuotaError);
    } finally { await second.close(); }
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(quota.metrics()).toMatchObject({ activeObservers: 0, activeProcesses: 0 });
  });

  it("mantém o observador quando um novo consumidor entra durante o fechamento ocioso", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-quota-idle-race-"));
    roots.push(root);
    const quota = new WorkspaceQuota(await WorkspaceSandbox.create(root), { maxBytes: 10, maxFiles: 10, observationIdleMs: 20 });
    const watch = vi.fn<WorkspaceWatch>(() => ({ on() { return this; }, close() {} }));
    const realDrain = WorkspaceQuotaObserver.prototype.drain;
    let blockNextDrain = false;
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let entered!: () => void;
    const drainEntered = new Promise<void>((resolve) => { entered = resolve; });
    const drain = vi.spyOn(WorkspaceQuotaObserver.prototype, "drain").mockImplementation(async function (this: WorkspaceQuotaObserver) {
      if (blockNextDrain) {
        blockNextDrain = false;
        entered();
        await blocked;
      }
      return realDrain.call(this);
    });
    try {
      const first = await quota.observeProcesses(vi.fn(), watch);
      blockNextDrain = true;
      const closing = first.close();
      await entered;

      const joining = quota.observeProcesses(vi.fn(), watch);
      expect(quota.metrics()).toMatchObject({ activeObservers: 1, activeProcesses: 1 });
      unblock();
      await closing;
      const second = await joining;
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        expect(quota.metrics()).toMatchObject({ activeObservers: 1, activeProcesses: 1 });
      } finally {
        await second.close();
      }
    } finally {
      unblock();
      drain.mockRestore();
    }
  });

  it("reconciles lost paths and periodic silent changes, and batches rename accounting", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-quota-reconcile-"));
    roots.push(root);
    await writeFile(join(root, "old.txt"), "1234");
    let emit!: (event: string, filename: string | Buffer | null) => void;
    const snapshots: number[] = [];
    const observer = new WorkspaceQuotaObserver({ root, reconciliationIntervalMs: 10,
      onSnapshot: (usage) => { snapshots.push(usage.bytes); },
      watch: (_root, _options, listener) => {
        emit = listener;
        return { on() { return this; }, close() {} };
      },
    });
    await observer.start();
    try {
      await rename(join(root, "old.txt"), join(root, "new.txt"));
      emit("rename", "new.txt");
      emit("rename", "old.txt");
      await observer.drain();
      expect(snapshots.every((bytes) => bytes === 4)).toBe(true);
      await writeFile(join(root, "new.txt"), "123456");
      emit("change", null);
      await observer.drain();
      expect(snapshots.at(-1)).toBe(6);
      await writeFile(join(root, "new.txt"), "1");
      await vi.waitFor(() => expect(snapshots.at(-1)).toBe(1));
    } finally { await observer.close(); }
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
