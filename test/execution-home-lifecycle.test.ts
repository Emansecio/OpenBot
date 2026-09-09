import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentHomeStore, HomeLifecycleError } from "../src/execution/home.js";
import type { HomeAclAdapter } from "../src/execution/home-acl.js";
import { DEFAULT_HOME_INVENTORY_MAX_ENTRIES } from "../src/execution/home-inventory.js";
import { DEFAULT_WORKSPACE_QUOTA } from "../src/execution/quota.js";

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-home-lifecycle-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("AgentHomeStore lifecycle", () => {
  it("mantém o inventário alinhado ao teto de entradas permitido pela quota", () => {
    expect(DEFAULT_HOME_INVENTORY_MAX_ENTRIES).toBe(DEFAULT_WORKSPACE_QUOTA.maxEntries);
  });

  it("lists quarantine and restores without overwriting an active home", async () => {
    const root = await temp();
    const store = await AgentHomeStore.create(root);
    const home = await store.ensure("recoverable");
    await writeFile(join(home.root, "Documents", "keep.txt"), "recover-me");
    await store.remove("recoverable");

    const entries = await store.listQuarantine();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agentId).toBe("recoverable");
    const restored = await store.restore("recoverable", entries[0]!.quarantineId);
    expect(await readFile(join(restored.root, "Documents", "keep.txt"), "utf8")).toBe("recover-me");
    expect(await readdir(store.quarantineRoot)).toEqual([]);
    await expect(store.restore("recoverable")).rejects.toMatchObject({ code: "conflict" });
  });

  it("restaura ids de agente com capitalização equivalente", async () => {
    const store = await AgentHomeStore.create(await temp());
    await store.ensure("Agent-A");
    await store.remove("Agent-A");

    const restored = await store.restore("agent-a");

    expect(restored.agentId).toBe("agent-a");
    expect(await store.listQuarantine()).toEqual([]);
    await expect(store.inventory("agent-a")).resolves.toMatchObject({ agentId: "agent-a" });
  });

  it("publica marker completo sem deixar temporários de preparação", async () => {
    const store = await AgentHomeStore.create(await temp());
    await store.ensure("atomic-marker");
    await store.remove("atomic-marker");
    const entry = (await store.listQuarantine())[0]!;
    const metadataNames = await readdir(join(entry.root, ".openbot"));
    const marker = JSON.parse(await readFile(join(entry.root, ".openbot", "quarantine.json"), "utf8")) as { agentId: string };

    expect(marker.agentId).toBe("atomic-marker");
    expect(metadataNames.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("repairs a missing canonical folder and never rewrites user files", async () => {
    const store = await AgentHomeStore.create(await temp());
    const home = await store.ensure("repairable");
    await rm(join(home.root, "Documents"), { recursive: true, force: true });
    await writeFile(join(home.root, "Desktop", "user.txt"), "keep");

    const result = await store.repair("repairable");
    expect(result.repaired).toBe(true);
    expect(result.actions).toContain("created-Documents");
    expect(await readFile(join(home.root, "Desktop", "user.txt"), "utf8")).toBe("keep");
  });

  it("exports an archive with content hashes and imports it atomically", async () => {
    const source = await temp();
    const archiveRoot = await temp();
    const target = await temp();
    const sourceStore = await AgentHomeStore.create(source);
    const sourceHome = await sourceStore.ensure("portable");
    await writeFile(join(sourceHome.root, "Projects", "hello.txt"), "hello");
    const archivePath = join(archiveRoot, "portable.obhome.json");
    const exported = await sourceStore.exportArchive("portable", archivePath);
    expect(exported.manifest.entries.find((entry) => entry.path === "Projects/hello.txt")?.sha256).toMatch(/^[a-f0-9]{64}$/);

    const targetStore = await AgentHomeStore.create(target);
    const imported = await targetStore.importArchive("portable", archivePath);
    expect(await readFile(join(imported.root, "Projects", "hello.txt"), "utf8")).toBe("hello");
    await expect(targetStore.importArchive("portable", archivePath)).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects a tampered archive before creating an active home", async () => {
    const source = await temp();
    const target = await temp();
    const archiveRoot = await temp();
    const sourceStore = await AgentHomeStore.create(source);
    await sourceStore.ensure("tampered");
    const archivePath = join(archiveRoot, "tampered.json");
    await sourceStore.exportArchive("tampered", archivePath);
    const archive = JSON.parse(await readFile(archivePath, "utf8")) as { manifest: { entries: Array<{ path: string; type: string; size: number; sha256: string; contentBase64?: string }> } };
    const entry = archive.manifest.entries.find((candidate) => candidate.path === "Desktop/Bem-vindo.md")!;
    entry.contentBase64 = Buffer.from("tampered").toString("base64");
    await writeFile(archivePath, JSON.stringify(archive));

    const targetStore = await AgentHomeStore.create(target);
    await expect(targetStore.importArchive("tampered", archivePath)).rejects.toMatchObject({ code: "integrity_error" });
    await expect(targetStore.inventory("tampered")).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects archive traversal before touching the staging area", async () => {
    const source = await temp();
    const archiveRoot = await temp();
    const target = await temp();
    const store = await AgentHomeStore.create(source);
    await store.ensure("unsafe");
    const archivePath = join(archiveRoot, "unsafe.json");
    await store.exportArchive("unsafe", archivePath);
    const archive = JSON.parse(await readFile(archivePath, "utf8")) as { manifest: { entries: Array<{ path: string }> } };
    archive.manifest.entries[0]!.path = "../outside.txt";
    await writeFile(archivePath, JSON.stringify(archive));
    const targetStore = await AgentHomeStore.create(target);
    await expect(targetStore.importArchive("unsafe", archivePath)).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readdir(targetStore.stagingRoot)).toEqual([]);
  });

  it("makes ACL behavior injectable and reports failures without loosening permissions", async () => {
    const apply = vi.fn<HomeAclAdapter["apply"]>().mockResolvedValue({
      status: "failed",
      platform: "linux",
      message: "helper unavailable",
    });
    const acl: HomeAclAdapter = { apply };
    const store = await AgentHomeStore.create(await temp(), { acl });
    const home = await store.ensure("acl-agent");
    expect(apply).toHaveBeenCalledWith(home.root, { agentId: "acl-agent", operation: "create" });
    expect(home.acl).toMatchObject({ status: "failed" });
  });

  it("applies ACL to the workspace root and lifecycle directories", async () => {
    const root = await temp();
    const calls: string[] = [];
    const acl: HomeAclAdapter = {
      async apply(target, context) {
        calls.push(`${context.operation}:${target}`);
        return { status: "not-applicable", platform: "linux" };
      },
    };
    const store = await AgentHomeStore.create(root, { acl });
    const afterCreate = calls.length;
    const home = await store.ensure("acl-agent");
    expect(calls.slice(afterCreate)).toEqual([`create:${home.root}`]);

    await store.ensure("acl-agent");
    expect(calls).toHaveLength(afterCreate + 1);

    expect(calls).toEqual(expect.arrayContaining([
      `create:${store.root}`,
      `create:${store.quarantineRoot}`,
      `create:${store.stagingRoot}`,
    ]));
  });

  it("falha fechado no Windows quando o ACL não pode ser verificado", async () => {
    const root = await temp();
    const apply = vi.fn<HomeAclAdapter["apply"]>().mockResolvedValue({
      status: "failed",
      platform: "win32",
      message: "icacls indisponível",
    });

    await expect(AgentHomeStore.create(root, { acl: { apply } })).rejects.toMatchObject({ code: "access_denied" });
    await expect(readdir(join(root, "windows-acl-agent"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(root, ".quarantine"))).toEqual([]);
  });

  it("falha fechado no restore, import e repair quando o ACL Windows falha", async () => {
    const sourceRoot = await temp();
    const archiveRoot = await temp();
    const targetRoot = await temp();
    const acl: HomeAclAdapter = {
      async apply(_root, context) {
        return context.operation === "create"
          ? { status: "verified", platform: "win32" }
          : { status: "failed", platform: "win32", message: `${context.operation} ACL failed` };
      },
    };
    const source = await AgentHomeStore.create(sourceRoot);
    await source.ensure("lifecycle-acl");
    const archivePath = join(archiveRoot, "lifecycle-acl.json");
    await source.exportArchive("lifecycle-acl", archivePath);

    const restoreStore = await AgentHomeStore.create(await temp(), { acl });
    const restoreHome = await restoreStore.ensure("lifecycle-acl");
    await restoreStore.remove("lifecycle-acl");
    const quarantine = (await restoreStore.listQuarantine())[0]!;
    await expect(restoreStore.restore("lifecycle-acl", quarantine.quarantineId)).rejects.toMatchObject({ code: "access_denied" });
    await expect(lstat(restoreHome.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await restoreStore.listQuarantine()).toHaveLength(1);

    const importStore = await AgentHomeStore.create(targetRoot, { acl });
    await expect(importStore.importArchive("lifecycle-acl", archivePath)).rejects.toMatchObject({ code: "access_denied" });
    await expect(importStore.inventory("lifecycle-acl")).rejects.toMatchObject({ code: "not_found" });

    const repairStore = await AgentHomeStore.create(await temp(), { acl });
    const repairHome = await repairStore.ensure("lifecycle-acl");
    await rm(join(repairHome.root, "Documents"), { recursive: true, force: true });
    await expect(repairStore.repair("lifecycle-acl")).rejects.toMatchObject({ code: "access_denied" });
    expect(await lstat(repairHome.root)).toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("reverts quarantine when marker preparation fails", async () => {
    const root = await temp();
    const writeMarker = vi.fn<(path: string, contents: string) => Promise<void>>()
      .mockRejectedValue(new Error("marker write failed"));
    const store = await AgentHomeStore.create(root, { quarantineMarkerWriter: writeMarker });
    const home = await store.ensure("marker-failure");
    await writeFile(join(home.root, "Documents", "preserve.txt"), "still-here");

    await expect(store.remove("marker-failure")).rejects.toThrow("marker write failed");
    expect(writeMarker).toHaveBeenCalledTimes(1);
    await expect(readFile(join(home.root, "Documents", "preserve.txt"), "utf8")).resolves.toBe("still-here");
    expect(await readdir(store.quarantineRoot)).toEqual([]);
    await expect(store.listQuarantine()).resolves.toEqual([]);
  });

  it("rolls restore back to quarantine when marker cleanup fails", async () => {
    const root = await temp();
    const removeMarker = vi.fn<(path: string) => Promise<void>>()
      .mockImplementation(async (path) => {
        await unlink(path);
        throw new Error("marker cleanup failed");
      });
    const store = await AgentHomeStore.create(root, { quarantineMarkerRemover: removeMarker });
    const home = await store.ensure("restore-failure");
    await writeFile(join(home.root, "Documents", "preserve.txt"), "still-here");
    await store.remove("restore-failure");
    const entry = (await store.listQuarantine())[0]!;

    await expect(store.restore("restore-failure", entry.quarantineId)).rejects.toThrow("marker cleanup failed");
    await expect(lstat(home.root)).rejects.toMatchObject({ code: "ENOENT" });
    const restoredQuarantine = await store.listQuarantine();
    expect(restoredQuarantine).toHaveLength(1);
    await expect(readFile(join(restoredQuarantine[0]!.root, "Documents", "preserve.txt"), "utf8")).resolves.toBe("still-here");
    expect(removeMarker).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a quarantine marker is malformed", async () => {
    const store = await AgentHomeStore.create(await temp());
    const home = await store.ensure("broken-marker");
    await store.remove("broken-marker");
    const quarantine = (await readdir(store.quarantineRoot))[0];
    await writeFile(join(store.quarantineRoot, quarantine!, ".openbot", "quarantine.json"), "not-json");
    await expect(store.listQuarantine()).rejects.toMatchObject({ code: "integrity_error" });
    // The data remains recoverable on disk; no destructive cleanup is hidden in
    // inventory/list operations.
    await expect(readFile(join(store.quarantineRoot, quarantine!, "Desktop", "Bem-vindo.md"), "utf8")).resolves.toContain("Computador");
    expect(home.root).not.toBe(join(store.quarantineRoot, quarantine!));
  });
});
