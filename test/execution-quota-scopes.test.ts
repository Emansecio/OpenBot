import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHomeStore } from "../src/execution/home.js";
import { HomeWorkspaceBackend } from "../src/execution/home-backend.js";
import { LocalFileExecutor } from "../src/execution/files.js";
import { WorkspaceQuota, WorkspaceQuotaError } from "../src/execution/quota.js";
import { WorkspaceSandbox } from "../src/execution/workspace.js";
import { TempRoots } from "./helpers/temp-roots.js";

const temp = new TempRoots();
afterEach(async () => {
  await temp.cleanup();
});

const tempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temp.track(dir);
  return dir;
};

const sandboxFor = async (root: string): Promise<WorkspaceSandbox> =>
  WorkspaceSandbox.create(root, { allowAncestorLinks: true });

describe("scoped workspace quota (melhoria 6)", () => {
  it("aplica a cota no destino de mkdir/copy e rebalanceia move entre escopos", async () => {
    const root = await tempDir("openbot-quota-operations-");
    await mkdir(join(root, "Downloads"), { recursive: true });
    await mkdir(join(root, "Projects"), { recursive: true });
    await writeFile(join(root, "source.txt"), "123456");
    const workspace = await sandboxFor(root);
    const quota = new WorkspaceQuota(workspace, {
      maxBytes: 1024,
      maxFiles: 100,
      maxEntries: 100,
      scopes: {
        downloads: { maxBytes: 5, maxFiles: 10, maxEntries: 10 },
        projects: { maxBytes: 100, maxFiles: 10, maxEntries: 10 },
      },
    });
    const executor = LocalFileExecutor.fromWorkspace(workspace, quota);

    await expect(executor.execute({ operation: "file.copy", source: "source.txt", destination: "Downloads/copy.txt" }))
      .resolves.toMatchObject({ ok: false, operation: "file.copy", code: "quota_exceeded" });
    await expect(executor.execute({ operation: "file.move", source: "source.txt", destination: "Downloads/moved.txt" }))
      .resolves.toMatchObject({ ok: false, operation: "file.move", code: "quota_exceeded" });
    await expect(executor.execute({ operation: "file.mkdir", path: "Downloads/one" }))
      .resolves.toMatchObject({ ok: true, operation: "file.mkdir" });

    await writeFile(join(root, "Projects", "source.txt"), "123456");
    const balancedQuota = new WorkspaceQuota(workspace, {
      maxBytes: 1024,
      maxFiles: 100,
      maxEntries: 100,
      scopes: {
        downloads: { maxBytes: 6, maxFiles: 10, maxEntries: 10 },
        projects: { maxBytes: 100, maxFiles: 10, maxEntries: 10 },
      },
    });
    const balancedExecutor = LocalFileExecutor.fromWorkspace(workspace, balancedQuota);
    await expect(balancedExecutor.execute({ operation: "file.move", source: "Projects/source.txt", destination: "Downloads/accepted.txt" }))
      .resolves.toEqual({ ok: true, operation: "file.move" });
    await expect(balancedExecutor.execute({ operation: "file.write", path: "Downloads/extra.txt", content: "x", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: false, operation: "file.write", code: "quota_exceeded" });
    await expect(readFile(join(root, "Projects", "source.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "Downloads", "accepted.txt"), "utf8")).resolves.toBe("123456");
    await expect(balancedQuota.usage()).resolves.toMatchObject({ bytes: 12, files: 2 });
  });

  it("aplica a cota de destino em cópia de uma montagem compartilhada", async () => {
    const profile = await tempDir("openbot-quota-shared-profile-");
    await mkdir(join(profile, "Documents"), { recursive: true });
    await writeFile(join(profile, "Documents", "source.txt"), "123456");
    const homeRoot = await tempDir("openbot-quota-shared-home-");
    await mkdir(join(homeRoot, "Downloads"), { recursive: true });
    const backend = await HomeWorkspaceBackend.create(homeRoot, {
      userProfile: profile,
      quota: {
        maxBytes: 1024,
        maxFiles: 100,
        maxEntries: 100,
        scopes: { downloads: { maxBytes: 5, maxFiles: 10, maxEntries: 10 } },
      },
    });

    await expect(backend.execute({
      operation: "file.copy",
      source: "shared://Documents/source.txt",
      destination: "Downloads/copy.txt",
    })).rejects.toBeInstanceOf(WorkspaceQuotaError);
    await expect(readFile(join(profile, "Documents", "source.txt"), "utf8")).resolves.toBe("123456");
    await expect(readFile(join(homeRoot, "Downloads", "copy.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializa transferências concorrentes para não ultrapassar o escopo", async () => {
    const root = await tempDir("openbot-quota-transfer-race-");
    await mkdir(join(root, "Downloads"), { recursive: true });
    await mkdir(join(root, "Projects"), { recursive: true });
    await writeFile(join(root, "Projects", "one.txt"), "1234");
    await writeFile(join(root, "Projects", "two.txt"), "5678");
    const workspace = await sandboxFor(root);
    const quota = new WorkspaceQuota(workspace, {
      maxBytes: 1024,
      maxFiles: 100,
      maxEntries: 100,
      scopes: { downloads: { maxBytes: 5, maxFiles: 10, maxEntries: 10 }, projects: { maxBytes: 100, maxFiles: 10, maxEntries: 10 } },
    });
    const executor = LocalFileExecutor.fromWorkspace(workspace, quota);
    const results = await Promise.all([
      executor.execute({ operation: "file.move", source: "Projects/one.txt", destination: "Downloads/one.txt" }),
      executor.execute({ operation: "file.move", source: "Projects/two.txt", destination: "Downloads/two.txt" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "quota_exceeded")).toHaveLength(1);
    await expect(quota.usage()).resolves.toMatchObject({ bytes: 8, files: 2 });
  });

  it("move para a lixeira mesmo com o escopo .openbot no limite, porque a lixeira não é medida", async () => {
    const root = await tempDir("openbot-quota-trash-scope-");
    await writeFile(join(root, "source.txt"), "x");
    const workspace = await sandboxFor(root);
    const quota = new WorkspaceQuota(workspace, {
      maxBytes: 1024,
      maxFiles: 100,
      maxEntries: 100,
      scopes: { ".openbot": { maxBytes: 1024, maxFiles: 100, maxEntries: 1 } },
    });
    const executor = LocalFileExecutor.fromWorkspace(workspace, quota);

    await expect(executor.execute({ operation: "file.trash", path: "source.txt" }))
      .resolves.toMatchObject({ ok: true, operation: "file.trash" });
    await expect(readFile(join(root, "source.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("não conta o conteúdo da lixeira no escopo .openbot, como no cálculo global", async () => {
    const root = await tempDir("openbot-quota-trash-scope-content-");
    await mkdir(join(root, ".openbot", "trash", "entry", "payload"), { recursive: true });
    await writeFile(join(root, ".openbot", "trash", "entry", "payload", "old.bin"), Buffer.alloc(200));
    const quota = new WorkspaceQuota(await sandboxFor(root), {
      maxBytes: 1024,
      maxFiles: 100,
      maxEntries: 100,
      scopes: { ".openbot": { maxBytes: 64, maxFiles: 100, maxEntries: 100 } },
    });
    const reservation = await quota.reserveDelta({ bytes: 10, files: 1, entries: 1 }, join(root, ".openbot", "note.json"));
    reservation.cancel();
  });

  it("enforces the Downloads sub-quota independently of the global limit", async () => {
    const root = await tempDir("openbot-quota-scope-");
    await mkdir(join(root, "Downloads"), { recursive: true });
    const quota = new WorkspaceQuota(await sandboxFor(root), {
      maxBytes: 10 * 1024 * 1024,
      maxFiles: 1000,
      scopes: { downloads: { maxBytes: 100, maxFiles: 1000 } },
    });

    // 60 bytes in Downloads: within global, over the 100-byte scope when doubled.
    await (await quota.reserve(join(root, "Downloads", "a.bin"), 60)).commit();
    await expect(quota.reserve(join(root, "Downloads", "b.bin"), 60)).rejects.toBeInstanceOf(WorkspaceQuotaError);

    // The same size in another folder is fine (global limit far away).
    await (await quota.reserve(join(root, "Documents", "c.bin"), 60)).commit();
  });

  it("scope paths are matched case-insensitively", async () => {
    const root = await tempDir("openbot-quota-case-");
    await mkdir(join(root, "Projects"), { recursive: true });
    const quota = new WorkspaceQuota(await sandboxFor(root), {
      maxBytes: 10 * 1024 * 1024,
      maxFiles: 1000,
      scopes: { projects: { maxBytes: 50, maxFiles: 1000 } },
    });
    await (await quota.reserve(join(root, "Projects", "a.txt"), 40)).commit();
    await expect(quota.reserve(join(root, "PROJECTS", "b.txt"), 40)).rejects.toBeInstanceOf(WorkspaceQuotaError);
  });

  it("cancelling a reservation releases the scope budget", async () => {
    const root = await tempDir("openbot-quota-cancel-");
    await mkdir(join(root, "Downloads"), { recursive: true });
    const quota = new WorkspaceQuota(await sandboxFor(root), {
      maxBytes: 10 * 1024 * 1024,
      maxFiles: 1000,
      scopes: { downloads: { maxBytes: 100, maxFiles: 1000 } },
    });
    const reservation = await quota.reserve(join(root, "Downloads", "a.bin"), 90);
    reservation.cancel();
    await (await quota.reserve(join(root, "Downloads", "b.bin"), 90)).commit();
  });

  it("markUsageDirty forces scope rescans", async () => {
    const root = await tempDir("openbot-quota-dirty-");
    await mkdir(join(root, "Downloads"), { recursive: true });
    const quota = new WorkspaceQuota(await sandboxFor(root), {
      maxBytes: 10 * 1024 * 1024,
      maxFiles: 1000,
      scopes: { downloads: { maxBytes: 150, maxFiles: 1000 } },
    });
    await (await quota.reserve(join(root, "Downloads", "a.bin"), 100)).commit();
    // External change outside the quota's knowledge.
    await writeFile(join(root, "Downloads", "external.bin"), Buffer.alloc(100, 1));
    quota.markUsageDirty();
    await expect(quota.reserve(join(root, "Downloads", "b.bin"), 100)).rejects.toBeInstanceOf(WorkspaceQuotaError);
  });
});
