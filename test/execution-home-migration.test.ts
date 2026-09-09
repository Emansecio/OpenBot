import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHomeStore } from "../src/execution/home.js";
import { readSharedGrants } from "../src/execution/home-grants.js";

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-home-migration-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("home layout migration", () => {
  it("migrates a v1 home to the current layout without touching user files", async () => {
    const store = await AgentHomeStore.create(await temp());
    const homeRoot = store.pathFor("legacy-bot");
    // Simulate a v1 home exactly as the previous release seeded it.
    for (const name of ["Desktop", "Documents", "Downloads", "Projects", ".openbot"]) {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(join(homeRoot, name), { recursive: true }));
    }
    const userFile = join(homeRoot, "Documents", "nota.md");
    await writeFile(userFile, "keep-me");
    const welcome = join(homeRoot, "Desktop", "Bem-vindo.md");
    await writeFile(welcome, "# Computador do OpenBot\n\n(gerado na v1)\n");
    await writeFile(join(homeRoot, ".openbot", "home.json"), `${JSON.stringify({
      agentId: "legacy-bot",
      createdAt: "2026-08-13T00:00:00.000Z",
      layoutVersion: 1,
    }, null, 2)}\n`);

    await store.ensure("legacy-bot");

    const manifest = JSON.parse(await readFile(join(homeRoot, ".openbot", "home.json"), "utf8")) as {
      agentId: string;
      createdAt: string;
      layoutVersion: number;
      migratedAt?: string;
      migrationLog?: string[];
      welcomeHash?: string;
    };
    expect(manifest.layoutVersion).toBe(2);
    expect(manifest.createdAt).toBe("2026-08-13T00:00:00.000Z");
    expect(manifest.migratedAt).toEqual(expect.any(String));
    expect(manifest.migrationLog?.join("\n")).toMatch(/v2/);
    expect(manifest.welcomeHash).toEqual(expect.any(String));
    await expect(readFile(userFile, "utf8")).resolves.toBe("keep-me");
    // Welcome was user-edited in v1; migration must never rewrite it.
    await expect(readFile(welcome, "utf8")).resolves.toBe("# Computador do OpenBot\n\n(gerado na v1)\n");
    // Migration seeds an empty grants document: no implicit access.
    const grantsPath = join(homeRoot, ".openbot", "grants.json");
    expect(JSON.parse(await readFile(grantsPath, "utf8"))).toEqual({ version: 1, grants: {} });
    const grants = await readSharedGrants(homeRoot);
    expect(grants).toEqual({ version: 1, grants: {} });
  });

  it("is idempotent: a second ensure does not append another migration entry", async () => {
    const store = await AgentHomeStore.create(await temp());
    await store.ensure("idempotent-bot");
    await writeFile(store.pathFor("idempotent-bot"), "", { flag: "r" }).catch(() => undefined);
    // Force the manifest back to v1 to run the migration twice.
    const manifestPath = join(store.pathFor("idempotent-bot"), ".openbot", "home.json");
    const first = JSON.parse(await readFile(manifestPath, "utf8")) as { migrationLog?: string[] };
    await writeFile(manifestPath, `${JSON.stringify({
      agentId: "idempotent-bot",
      createdAt: "2026-08-13T00:00:00.000Z",
      layoutVersion: 1,
    }, null, 2)}\n`);
    await store.ensure("idempotent-bot");
    await store.ensure("idempotent-bot");
    const second = JSON.parse(await readFile(manifestPath, "utf8")) as { layoutVersion: number; migrationLog?: string[] };
    expect(second.layoutVersion).toBe(2);
    expect(second.migrationLog).toHaveLength(1);
    void first;
  });

  it("rejects a version above the current layout instead of downgrading", async () => {
    const store = await AgentHomeStore.create(await temp());
    const homeRoot = store.pathFor("future-bot");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(homeRoot, ".openbot"), { recursive: true }));
    await writeFile(join(homeRoot, ".openbot", "home.json"), `${JSON.stringify({
      agentId: "future-bot",
      createdAt: "2026-08-13T00:00:00.000Z",
      layoutVersion: 999,
    }, null, 2)}\n`);
    await expect(store.ensure("future-bot")).rejects.toMatchObject({ code: "integrity_error" });
  });
});
