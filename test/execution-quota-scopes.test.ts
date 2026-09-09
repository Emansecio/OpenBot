import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHomeStore } from "../src/execution/home.js";
import { HomeWorkspaceBackend } from "../src/execution/home-backend.js";
import { detectDrift, readUsageBaseline, writeUsageBaseline } from "../src/execution/home-drift.js";
import { WorkspaceQuota, WorkspaceQuotaError } from "../src/execution/quota.js";
import { WorkspaceSandbox } from "../src/execution/workspace.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

const tempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

const sandboxFor = async (root: string): Promise<WorkspaceSandbox> =>
  WorkspaceSandbox.create(root, { allowAncestorLinks: true });

describe("scoped workspace quota (melhoria 6)", () => {
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

describe("home drift (melhoria 6)", () => {
  it("reports drift when files change outside the app and refreshes the baseline", async () => {
    const store = await AgentHomeStore.create(await tempDir("openbot-drift-store-"));
    const home = await store.ensure("agent-a");
    await writeFile(join(home.root, "Documents", "a.txt"), "one");

    // No baseline yet: first audit records one and reports no drift.
    const first = await store.auditUsage("agent-a");
    expect(first.baseline).toBeNull();
    expect(first.drifted).toBe(false);

    // External change: +1 file, small bytes (below byte ratio, above file count? no).
    await writeFile(join(home.root, "Documents", "b.txt"), "two");
    const second = await store.driftReport("agent-a");
    expect(second.driftFiles).toBe(1);
    expect(second.drifted).toBe(false); // one file is under the absolute threshold

    // Many external files cross the threshold.
    for (let index = 0; index < 60; index += 1) {
      await writeFile(join(home.root, "Documents", `ext-${index}.txt`), "x");
    }
    const third = await store.driftReport("agent-a");
    expect(third.drifted).toBe(true);
    expect(third.driftFiles).toBeGreaterThanOrEqual(60);

    // Audit reports the accumulated drift against the old baseline, then refreshes it.
    const fourth = await store.auditUsage("agent-a");
    expect(fourth.drifted).toBe(true);
    const baseline = await readUsageBaseline(home.root);
    expect(baseline).not.toBeNull();
    // a.txt + b.txt + 60 externos + 2 Bem-vindo.md (conteúdo do bot).
    expect(baseline!.files).toBe(64);
    // With the refreshed baseline, the next audit sees no drift.
    const fifth = await store.auditUsage("agent-a");
    expect(fifth.drifted).toBe(false);
  });

  it("repair refreshes the usage baseline", async () => {
    const store = await AgentHomeStore.create(await tempDir("openbot-drift-repair-"));
    const home = await store.ensure("agent-a");
    await writeFile(join(home.root, "Documents", "a.txt"), "one");
    await store.auditUsage("agent-a");
    await writeFile(join(home.root, "Documents", "b.txt"), "two");
    await store.repair("agent-a");
    const baseline = await readUsageBaseline(home.root);
    expect(baseline!.files).toBe(4); // a + b + 2 Bem-vindo.md
  });

  it("detectDrift treats a missing baseline as no drift", () => {
    const report = detectDrift(null, { bytes: 10, files: 2, directories: 1, entries: 3 });
    expect(report.drifted).toBe(false);
    expect(report.baseline).toBeNull();
  });

  it("writes a readable baseline file", async () => {
    const root = await tempDir("openbot-drift-file-");
    await mkdir(join(root, ".openbot"), { recursive: true });
    await writeUsageBaseline(root, { bytes: 123, files: 4, directories: 5, entries: 9 });
    const baseline = await readUsageBaseline(root);
    expect(baseline).toMatchObject({ version: 1, bytes: 123, files: 4, directories: 5 });
    await expect(readFile(join(root, ".openbot", "usage.json"), "utf8")).resolves.toContain("checkedAt");
  });
});
