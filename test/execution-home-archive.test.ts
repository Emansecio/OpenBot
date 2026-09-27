import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHomeStore } from "../src/execution/home.js";
import { readSharedGrants, writeSharedGrants } from "../src/execution/home-grants.js";
import { TempRoots } from "./helpers/temp-roots.js";

const tempRoots = new TempRoots();
const temp = async () => {
  const root = await tempRoots.makeAsync("openbot-home-lifecycle-");
  return root;
};

afterEach(async () => {
  await tempRoots.cleanup();
});


describe("AgentHomeStore lifecycle", () => {

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

  it("reseeds grants on foreign import but preserves them on snapshot restore", async () => {
    const source = await temp();
    const archiveRoot = await temp();
    const target = await temp();
    const sourceStore = await AgentHomeStore.create(source);
    const sourceHome = await sourceStore.ensure("portable");
    await writeSharedGrants(sourceHome.root, {
      version: 1,
      grants: { Desktop: { access: "write" }, Documents: { access: "read" } },
    });

    const archivePath = join(archiveRoot, "portable.obhome");
    await sourceStore.exportArchive("portable", archivePath);
    const targetStore = await AgentHomeStore.create(target);
    const imported = await targetStore.importArchive("portable", archivePath);
    // A foreign archive must not carry pre-approved access to real folders.
    expect(Object.keys((await readSharedGrants(imported.root)).grants)).toHaveLength(0);
  });

  it("rejects a tampered archive before creating an active home", async () => {
    const source = await temp();
    const target = await temp();
    const archiveRoot = await temp();
    const sourceStore = await AgentHomeStore.create(source);
    await sourceStore.ensure("tampered");
    const archivePath = join(archiveRoot, "tampered.json");
    await sourceStore.exportArchive("tampered", archivePath);
    const archive = await readFile(archivePath);
    archive[archive.length - 1] = archive[archive.length - 1]! ^ 1;
    await writeFile(archivePath, archive);

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
    const { manifest } = await store.exportArchive("unsafe", archivePath);
    manifest.entries[0]!.path = "../outside.txt";
    await writeFile(archivePath, JSON.stringify({ format: "openbot-home-archive", version: 1, manifest }));
    const targetStore = await AgentHomeStore.create(target);
    await expect(targetStore.importArchive("unsafe", archivePath)).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readdir(targetStore.stagingRoot)).toEqual([]);
  });
});
