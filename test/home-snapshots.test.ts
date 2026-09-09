import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHomeStore } from "../src/execution/home.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "openbot-snapshots-"));
  roots.push(dir);
  return dir;
};

describe("home snapshots", () => {
  it("captures a snapshot, lists it and restores it over a changed home", async () => {
    const store = await AgentHomeStore.create(await tempDir());
    const home = await store.ensure("agent-a");
    await writeFile(join(home.root, "Documents", "v1.txt"), "one");

    const first = await store.snapshot("agent-a");
    expect(first.seq).toBe(1);

    // Mutate the home after the snapshot.
    await writeFile(join(home.root, "Documents", "v1.txt"), "two");
    await writeFile(join(home.root, "Documents", "v2.txt"), "added");

    const listed = await store.listSnapshots("agent-a");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ seq: 1, entryCount: expect.any(Number) });

    const restored = await store.restoreSnapshot("agent-a", 1);
    expect(restored.root).toBe(home.root);
    await expect(readFile(join(restored.root, "Documents", "v1.txt"), "utf8")).resolves.toBe("one");
    await expect(readFile(join(restored.root, "Documents", "v2.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the active home untouched when the snapshot does not exist", async () => {
    const store = await AgentHomeStore.create(await tempDir());
    const home = await store.ensure("agent-a");
    await writeFile(join(home.root, "Documents", "keep.txt"), "keep");
    await expect(store.restoreSnapshot("agent-a", 99)).rejects.toMatchObject({ code: "not_found" });
    await expect(readFile(join(home.root, "Documents", "keep.txt"), "utf8")).resolves.toBe("keep");
  });

  it("rolls back to the previous home when the snapshot import fails", async () => {
    const store = await AgentHomeStore.create(await tempDir());
    const home = await store.ensure("agent-a");
    await store.snapshot("agent-a");
    // Corrupt the snapshot so import fails after quarantine.
    const snapshotPath = (await store.listSnapshots("agent-a"))[0]!.path;
    await writeFile(snapshotPath, "{corrupt");
    await writeFile(join(home.root, "Documents", "atual.txt"), "atual");

    await expect(store.restoreSnapshot("agent-a", 1)).rejects.toBeTruthy();
    await expect(readFile(join(home.root, "Documents", "atual.txt"), "utf8")).resolves.toBe("atual");
  });

  it("prunes old snapshots beyond the retention limit", async () => {
    const store = await AgentHomeStore.create(await tempDir());
    const home = await store.ensure("agent-a");
    for (let index = 0; index < 7; index += 1) {
      await writeFile(join(home.root, "Documents", `gen-${index}.txt`), String(index));
      const snapshot = await store.snapshot("agent-a");
      expect(snapshot.seq).toBe(index + 1);
    }
    const listed = await store.listSnapshots("agent-a");
    expect(listed).toHaveLength(AgentHomeStore.MAX_SNAPSHOTS_PER_AGENT);
    expect(listed.map((entry) => entry.seq)).toEqual([3, 4, 5, 6, 7]);
  });

  it("stores snapshots outside every agent home and outside the inventory", async () => {
    const root = await tempDir();
    const store = await AgentHomeStore.create(root);
    const home = await store.ensure("agent-a");
    await store.snapshot("agent-a");
    const snapshots = await store.listSnapshots("agent-a");
    // Snapshots live under the workspaces root but never inside a bot's home.
    expect(snapshots[0]!.path.toLowerCase().startsWith(root.toLowerCase())).toBe(true);
    expect(snapshots[0]!.path.toLowerCase().startsWith(home.root.toLowerCase())).toBe(false);
    const inventory = await store.inventory("agent-a");
    expect(inventory.entries.some((entry) => entry.path.includes(".snapshots"))).toBe(false);
  });
});
