import { lstat, mkdir, readFile, readdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentHomeStore } from "../src/execution/home.js";
import type { HomeAclAdapter } from "../src/execution/home-acl.js";
import { DEFAULT_HOME_INVENTORY_MAX_ENTRIES } from "../src/execution/home-inventory.js";
import { DEFAULT_WORKSPACE_QUOTA } from "../src/execution/quota.js";
import { TempRoots } from "./helpers/temp-roots.js";

const tempRoots = new TempRoots();
const temp = () => tempRoots.makeAsync("openbot-home-lifecycle-");

afterEach(async () => {
  await tempRoots.cleanup();
});

describe("AgentHomeStore lifecycle", () => {
  it("mantém o inventário alinhado ao teto de entradas permitido pela quota", () => {
    expect(DEFAULT_HOME_INVENTORY_MAX_ENTRIES).toBe(DEFAULT_WORKSPACE_QUOTA.maxEntries);
  });

  it("descarta no boot só staging órfão antigo e preserva o recente e arquivos soltos", async () => {
    const root = await temp();
    const first = await AgentHomeStore.create(root);
    const stale = join(first.stagingRoot, "create-crashed-00000000");
    const recent = join(first.stagingRoot, "create-inflight-11111111");
    await mkdir(join(stale, "Documents"), { recursive: true });
    await writeFile(join(stale, "Documents", "partial.txt"), "partial");
    await mkdir(recent);
    await writeFile(join(first.stagingRoot, "note.txt"), "not a stage");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    await utimes(stale, twoDaysAgo, twoDaysAgo);

    const second = await AgentHomeStore.create(root);
    expect((await readdir(second.stagingRoot)).sort()).toEqual(["create-inflight-11111111", "note.txt"]);
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

  it("exclui, restaura, repara e purga uma home com junction sem seguir o link", async () => {
    const root = await temp();
    const outside = await temp();
    await writeFile(join(outside, "external.txt"), "keep-outside");
    const store = await AgentHomeStore.create(root);
    const home = await store.ensure("linked");
    await mkdir(join(home.root, "Projects", "app"), { recursive: true });
    await symlink(outside, join(home.root, "Projects", "app", "node_modules"), "junction");

    const repaired = await store.repair("linked");
    expect(repaired.inventory.entries.some((entry) => entry.path.includes("node_modules"))).toBe(false);
    expect(repaired.inventory.complete).toBe(false);
    const quarantineId = await store.remove("linked");
    expect(quarantineId).toEqual(expect.any(String));
    const restored = await store.restore("linked", quarantineId);
    expect((await lstat(join(restored.root, "Projects", "app", "node_modules"))).isSymbolicLink()).toBe(true);
    await store.remove("linked");
    await store.purgeDeletedAgentData("linked");
    expect(await readFile(join(outside, "external.txt"), "utf8")).toBe("keep-outside");
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

  it("quarentena home com manifesto corrompido em vez de prender o agente", async () => {
    const store = await AgentHomeStore.create(await temp());
    const home = await store.ensure("corrupt-manifest");
    await writeFile(join(home.root, ".openbot", "home.json"), "{not-json");

    const quarantineId = await store.remove("corrupt-manifest");

    expect(quarantineId).toBeDefined();
    const entries = await store.listQuarantineMetadata();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agentId).toBe("corrupt-manifest");
    // Os dados ficam preservados em quarentena; o restore continua fail-closed
    // enquanto o manifesto não comprovar a identidade.
    await expect(store.restore("corrupt-manifest", quarantineId)).rejects.toMatchObject({ code: "integrity_error" });
  });

  it("quarentena home sem o diretório .openbot", async () => {
    const store = await AgentHomeStore.create(await temp());
    const home = await store.ensure("no-openbot-dir");
    await rm(join(home.root, ".openbot"), { recursive: true, force: true });

    const quarantineId = await store.remove("no-openbot-dir");

    expect(quarantineId).toBeDefined();
    const entries = await store.listQuarantineMetadata();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agentId).toBe("no-openbot-dir");
  });

  it("recusa quarentena quando o manifesto prova conteúdo de outro agente", async () => {
    const store = await AgentHomeStore.create(await temp());
    const home = await store.ensure("claimed-id");
    await writeFile(
      join(home.root, ".openbot", "home.json"),
      JSON.stringify({ agentId: "other-agent", createdAt: "2026-01-01T00:00:00.000Z", layoutVersion: 2 }),
    );

    await expect(store.remove("claimed-id")).rejects.toMatchObject({ code: "integrity_error" });
    expect(await store.listQuarantineMetadata()).toEqual([]);
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

  it("applies ACL to the workspace root once, covering the lifecycle directories inside it", async () => {
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

    expect(calls).toEqual(expect.arrayContaining([`create:${store.root}`]));
    expect(calls).not.toContain(`create:${store.quarantineRoot}`);
    expect(calls).not.toContain(`create:${store.stagingRoot}`);
    for (const lifecycleRoot of [store.quarantineRoot, store.stagingRoot]) {
      expect(lifecycleRoot.startsWith(`${store.root}\\`)).toBe(true);
    }
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

  it("restaura e purga um bot mesmo com a quarentena danificada de outro bot", async () => {
    const store = await AgentHomeStore.create(await temp());
    await store.ensure("damaged-other");
    await store.remove("damaged-other");
    const damaged = (await readdir(store.quarantineRoot))[0]!;
    await writeFile(join(store.quarantineRoot, damaged, ".openbot", "quarantine.json"), "not-json");
    const home = await store.ensure("healthy");
    await writeFile(join(home.root, "Documents", "keep.txt"), "keep");
    await store.remove("healthy");

    const restored = await store.restore("healthy");
    expect(await readFile(join(restored.root, "Documents", "keep.txt"), "utf8")).toBe("keep");
    await store.remove("healthy");
    await expect(store.purgeDeletedAgentData("healthy")).resolves.toMatchObject({ quarantinesRemoved: 1 });
    // The damaged entry stays on disk and the full listing still reports it.
    expect(await readdir(store.quarantineRoot)).toEqual([damaged]);
    await expect(store.listQuarantine()).rejects.toMatchObject({ code: "integrity_error" });
  });
});
