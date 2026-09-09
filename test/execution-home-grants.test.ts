import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHomeStore } from "../src/execution/home.js";
import { HomeWorkspaceBackend } from "../src/execution/home-backend.js";
import { writeSharedGrants } from "../src/execution/home-grants.js";
import { agentSharedDirectoryRoot, SHARED_USER_DIRECTORIES } from "../src/execution/user-files.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function seedProfile(): Promise<string> {
  const profile = await tempDir("openbot-grants-profile-");
  for (const name of SHARED_USER_DIRECTORIES) await mkdir(join(profile, name), { recursive: true });
  return profile;
}

function grantedBackend(profile: string, store: AgentHomeStore, agentId: string) {
  return HomeWorkspaceBackend.create(store.pathFor(agentId), { userProfile: profile, agentId });
}

describe("grant-based shared user folders", () => {
  it("refreshes revoked and expired grants on a cached backend", async () => {
    const profile = await seedProfile();
    const store = await AgentHomeStore.create(await tempDir("openbot-grants-revoke-"));
    await store.ensure("agent-a");
    const home = store.pathFor("agent-a");
    await writeSharedGrants(home, { version: 1, grants: { Documents: { access: "write" } } });
    const backend = await grantedBackend(profile, store, "agent-a");
    await writeFile(join(profile, "Documents", "keep.txt"), "original");
    await writeSharedGrants(home, { version: 1, grants: { Documents: { access: "read" } } });
    await expect(backend.execute({ operation: "file.write", path: "shared://Documents/keep.txt", content: "changed", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: false, code: "access_denied" });
    await writeSharedGrants(home, { version: 1, grants: { Documents: { access: "write", expiresAt: new Date(0).toISOString() } } });
    await expect(backend.execute({ operation: "file.read", path: "shared://Documents/keep.txt", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: false, code: "access_denied" });
    await expect(readFile(join(profile, "Documents", "keep.txt"), "utf8")).resolves.toBe("original");
  });

  it("writes directly to the physical home without creating profile redirects", async () => {
    const profile = await seedProfile();
    const store = await AgentHomeStore.create(await tempDir("openbot-grants-lazy-"));
    await store.ensure("agent-a");
    const backend = await grantedBackend(profile, store, "agent-a");
    const listed = await backend.execute({ operation: "file.list", path: "." });
    expect(listed).toMatchObject({ ok: true });
    if (listed.ok && listed.operation === "file.list") {
      expect(listed.entries.map((entry) => entry.name)).toEqual(expect.arrayContaining([...SHARED_USER_DIRECTORIES]));
    }
    await expect(lstat(agentSharedDirectoryRoot(profile, "Documents", "agent-a"))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(backend.execute({
      operation: "file.write",
      path: "Documents/nota.txt",
      content: "bot-file",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(store.pathFor("agent-a"), "Documents", "nota.txt"), "utf8")).resolves.toBe("bot-file");
  });

  it("keeps ordinary folders private when no grant exists", async () => {
    const profile = await seedProfile();
    await writeFile(join(profile, "Documents", "real.txt"), "user-file");
    const store = await AgentHomeStore.create(await tempDir("openbot-grants-homes-"));
    await store.ensure("agent-a");
    const backend = await grantedBackend(profile, store, "agent-a");

    await expect(backend.execute({
      operation: "file.write",
      path: "Documents/nota.txt",
      content: "bot-file",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: true });
    // Real user folder untouched; content landed in the physical home.
    await expect(readFile(join(profile, "Documents", "real.txt"), "utf8")).resolves.toBe("user-file");
    await expect(readFile(join(profile, "Documents", "nota.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const redirect = join(store.pathFor("agent-a"), "Documents");
    await expect(readFile(join(redirect, "nota.txt"), "utf8")).resolves.toBe("bot-file");

    const listed = await backend.execute({ operation: "file.list", path: "Documents" });
    expect(listed).toMatchObject({ ok: true });
    if (listed.ok && listed.operation === "file.list") {
      expect(listed.entries.map((entry) => entry.name)).toContain("nota.txt");
      expect(listed.entries.map((entry) => entry.name)).not.toContain("real.txt");
    }
  });

  it("isolates physical folders between two bots", async () => {
    const profile = await seedProfile();
    const store = await AgentHomeStore.create(await tempDir("openbot-grants-iso-"));
    await store.ensure("agent-a");
    await store.ensure("agent-b");
    const a = await grantedBackend(profile, store, "agent-a");
    const b = await grantedBackend(profile, store, "agent-b");

    await expect(a.execute({ operation: "file.write", path: "Desktop/segredo.txt", content: "a", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: true });
    await expect(b.execute({ operation: "file.read", path: "Desktop/segredo.txt", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(readFile(join(agentSharedDirectoryRoot(profile, "Desktop", "agent-b"), "segredo.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("mounts the real folder read-write with a write grant", async () => {
    const profile = await seedProfile();
    const store = await AgentHomeStore.create(await tempDir("openbot-grants-write-"));
    await store.ensure("agent-a");
    await writeSharedGrants(store.pathFor("agent-a"), {
      version: 1,
      grants: { Documents: { access: "write" } },
    });
    const backend = await grantedBackend(profile, store, "agent-a");

    await expect(backend.execute({
      operation: "file.write",
      path: "shared://Documents/escrito.txt",
      content: "real",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(profile, "Documents", "escrito.txt"), "utf8")).resolves.toBe("real");
    // Ordinary relative folders remain private.
    await expect(backend.execute({ operation: "file.write", path: "Desktop/x.txt", content: "x", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: true });
    await expect(readFile(join(profile, "Desktop", "x.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("mounts the real folder read-only with a read grant and blocks mutations", async () => {
    const profile = await seedProfile();
    await writeFile(join(profile, "Documents", "relatorio.txt"), "read-me");
    const store = await AgentHomeStore.create(await tempDir("openbot-grants-read-"));
    await store.ensure("agent-a");
    await writeSharedGrants(store.pathFor("agent-a"), {
      version: 1,
      grants: { Documents: { access: "read" } },
    });
    const backend = await grantedBackend(profile, store, "agent-a");

    await expect(backend.execute({ operation: "file.read", path: "shared://Documents/relatorio.txt", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: true, content: "read-me" });
    for (const request of [
      { operation: "file.write" as const, path: "shared://Documents/novo.txt", content: "x", encoding: "utf8" as const },
      { operation: "file.mkdir" as const, path: "shared://Documents/nova-pasta" },
      { operation: "file.trash" as const, path: "shared://Documents/relatorio.txt" },
    ]) {
      await expect(backend.execute(request)).resolves.toMatchObject({ ok: false, code: "access_denied" });
    }
    await expect(backend.execute({
      operation: "file.copy",
      source: "shared://Documents/relatorio.txt",
      destination: "shared://Documents/copia.txt",
    })).resolves.toMatchObject({ ok: false, code: "access_denied" });
    await expect(readFile(join(profile, "Documents", "relatorio.txt"), "utf8")).resolves.toBe("read-me");
    // Copy OUT of the read-only mount into the private home is allowed.
    await expect(backend.execute({
      operation: "file.copy",
      source: "shared://Documents/relatorio.txt",
      destination: "Projects/relatorio.txt",
    })).resolves.toMatchObject({ ok: true });
    await expect(backend.execute({ operation: "file.move", source: "shared://Documents/relatorio.txt",
      destination: "Projects/moved.txt" })).resolves.toMatchObject({ ok: false, code: "access_denied" });
    await expect(readFile(join(profile, "Documents", "relatorio.txt"), "utf8")).resolves.toBe("read-me");
  });

  it("discovers current physical paths and preserves older redirected files", async () => {
    const profile = await seedProfile();
    const store = await AgentHomeStore.create(await tempDir("openbot-grants-discovery-"));
    const home = await store.ensure("agent-a");
    const legacy = agentSharedDirectoryRoot(profile, "Documents", "agent-a");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "old.txt"), "older-file");
    await writeSharedGrants(home.root, { version: 1, grants: { Documents: { access: "read" } } });
    const backend = await grantedBackend(profile, store, "agent-a");
    await expect(backend.execute({ operation: "workspace.info" })).resolves.toMatchObject({
      ok: true, homeRoot: home.root,
      sharedFolders: [{ name: "shared://Documents", path: join(profile, "Documents"), access: "read" }],
      legacyFolders: expect.arrayContaining([{ name: "Documents", path: legacy }]),
    });
    await expect(backend.execute({ operation: "file.read", path: join(legacy, "old.txt"), encoding: "utf8" }))
      .resolves.toMatchObject({ ok: true, content: "older-file" });
    await expect(lstat(join(home.root, "Documents", "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats an expired grant as no grant", async () => {
    const profile = await seedProfile();
    const store = await AgentHomeStore.create(await tempDir("openbot-grants-exp-"));
    await store.ensure("agent-a");
    await writeSharedGrants(store.pathFor("agent-a"), {
      version: 1,
      grants: { Documents: { access: "write", expiresAt: "2000-01-01T00:00:00.000Z" } },
    });
    const backend = await grantedBackend(profile, store, "agent-a");
    await expect(backend.execute({ operation: "file.write", path: "Documents/x.txt", content: "x", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: true });
    await expect(readFile(join(profile, "Documents", "x.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when grants.json is corrupt", async () => {
    const profile = await seedProfile();
    const store = await AgentHomeStore.create(await tempDir("openbot-grants-corrupt-"));
    const home = await store.ensure("agent-a");
    await writeFile(join(home.root, ".openbot", "grants.json"), "{corrupt");
    const backend = await grantedBackend(profile, store, "agent-a");
    await expect(backend.execute({ operation: "file.list", path: "shared://Documents" }))
      .resolves.toMatchObject({ ok: false, code: "access_denied" });
    await expect(backend.execute({ operation: "file.write", path: "Documents/private.txt", content: "private", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: true });
  });

  it("keeps the legacy shared mode when no agentId is provided", async () => {
    const profile = await seedProfile();
    const store = await AgentHomeStore.create(await tempDir("openbot-grants-legacy-"));
    const home = await store.ensure("agent-a");
    const backend = await HomeWorkspaceBackend.create(home.root, { userProfile: profile });
    await expect(backend.execute({
      operation: "file.write",
      path: "shared://Documents/legado.txt",
      content: "shared",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(profile, "Documents", "legado.txt"), "utf8")).resolves.toBe("shared");
  });
});
