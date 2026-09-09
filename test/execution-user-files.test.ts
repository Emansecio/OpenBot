import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHomeStore } from "../src/execution/home.js";
import { HomeWorkspaceBackend } from "../src/execution/home-backend.js";
import { inventoryHome } from "../src/execution/home-inventory.js";
import {
  agentSharedDownloadRoot,
  classifyAgentPath,
  isBlockedUserRoot,
  isReservedHomeRelative,
  loadSharedUserMounts,
  SHARED_USER_DIRECTORIES,
} from "../src/execution/user-files.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function seedProfile(names: readonly string[] = SHARED_USER_DIRECTORIES): Promise<string> {
  const profile = await tempDir("openbot-user-profile-");
  for (const name of names) await mkdir(join(profile, name), { recursive: true });
  return profile;
}

describe("classifyAgentPath", () => {
  it("routes known user folders and keeps Projects private", () => {
    expect(classifyAgentPath(".")).toEqual({ kind: "root" });
    expect(classifyAgentPath("shared://Documents")).toEqual({ kind: "shared", mount: "Documents", relative: "." });
    expect(classifyAgentPath("shared://documents/note.md")).toEqual({ kind: "shared", mount: "Documents", relative: "note.md" });
    expect(classifyAgentPath("Projects/secret.md")).toEqual({ kind: "home", relative: "Projects\\secret.md" });
    expect(() => classifyAgentPath("shared://Documents/../Windows")).toThrow(/outside/i);
    expect(isReservedHomeRelative(".openbot/home.json")).toBe(true);
    expect(isReservedHomeRelative("Projects/note.md")).toBe(false);
    expect(agentSharedDownloadRoot("C:\\Users\\User", "agent-a").toLowerCase().endsWith("\\downloads\\openbot\\agent-a\\downloads")).toBe(true);
  });

  it("blocks system and AppData roots but not Temp test trees", () => {
    expect(isBlockedUserRoot("C:\\")).toBe(true);
    expect(isBlockedUserRoot("C:\\Users")).toBe(true);
    expect(isBlockedUserRoot("C:\\Users\\")).toBe(true);
    expect(isBlockedUserRoot("C:\\Windows\\System32")).toBe(true);
    expect(isBlockedUserRoot("C:\\Program Files\\App")).toBe(true);
    expect(isBlockedUserRoot("C:\\Users\\User\\AppData\\Roaming\\OpenBot")).toBe(true);
    expect(isBlockedUserRoot("C:\\Users\\User\\AppData\\Local\\OpenBot\\workspaces")).toBe(true);
    expect(isBlockedUserRoot("C:\\Users\\User\\AppData\\Local\\Temp\\openbot-user-profile")).toBe(false);
    expect(isBlockedUserRoot("C:\\Users\\User\\Documents")).toBe(false);
  });
});

describe("loadSharedUserMounts", () => {
  it("reuses the same mount map within the cache window", async () => {
    const profile = await seedProfile();
    const first = await loadSharedUserMounts(profile);
    const second = await loadSharedUserMounts(profile);
    expect(second).toBe(first);
    expect(first.get("Documents")?.root.toLowerCase()).toBe(join(profile, "Documents").toLowerCase());
  });
});

describe("HomeWorkspaceBackend user files", () => {
  it("shares Desktop/Documents/Downloads across agents and keeps Projects isolated", async () => {
    const profile = await seedProfile();
    const store = await AgentHomeStore.create(await tempDir("openbot-user-homes-"));
    const firstHome = await store.ensure("agent-a");
    const secondHome = await store.ensure("agent-b");
    const a = await HomeWorkspaceBackend.create(firstHome.root, { userProfile: profile });
    const b = await HomeWorkspaceBackend.create(secondHome.root, { userProfile: profile });

    await expect(a.execute({
      operation: "file.write",
      path: "shared://Documents/shared.txt",
      content: "visible",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(profile, "Documents", "shared.txt"), "utf8")).resolves.toBe("visible");

    const listed = await b.execute({ operation: "file.list", path: "shared://Documents" });
    expect(listed).toMatchObject({ ok: true });
    if (listed.ok && listed.operation === "file.list") {
      expect(listed.entries.map((entry) => entry.name)).toContain("shared.txt");
    }
    await expect(b.execute({ operation: "file.read", path: "shared://Documents/shared.txt", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: true, content: "visible" });

    await expect(a.execute({
      operation: "file.write",
      path: "Projects/secret.txt",
      content: "private",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: true });
    const otherProjects = await b.execute({ operation: "file.list", path: "Projects" });
    expect(otherProjects).toMatchObject({ ok: true });
    if (otherProjects.ok && otherProjects.operation === "file.list") {
      expect(otherProjects.entries.map((entry) => entry.name)).not.toContain("secret.txt");
    }
    await expect(readFile(join(firstHome.root, "Projects", "secret.txt"), "utf8")).resolves.toBe("private");
  });

  it("lists physical folders at the home root and refuses escape", async () => {
    const profile = await seedProfile();
    await writeFile(join(profile, "Pictures", "shot.png"), "png");
    const store = await AgentHomeStore.create(await tempDir("openbot-user-list-"));
    const home = await store.ensure("agent-a");
    const backend = await HomeWorkspaceBackend.create(home.root, { userProfile: profile });

    const listed = await backend.execute({ operation: "file.list", path: "." });
    expect(listed).toMatchObject({ ok: true });
    if (listed.ok && listed.operation === "file.list") {
      expect(listed.entries.map((entry) => entry.name)).toEqual(expect.arrayContaining([
        "Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music", "Projects",
      ]));
      expect(listed.entries.map((entry) => entry.name)).not.toContain(".openbot");
    }

    const outside = join(profile, "outside.txt");
    await writeFile(outside, "untouched");
    await expect(backend.execute({
      operation: "file.write",
      path: "shared://Documents\\..\\outside.txt",
      content: "pwned",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: false, code: "outside_workspace" });
    await expect(readFile(outside, "utf8")).resolves.toBe("untouched");
    await expect(backend.execute({ operation: "file.list", path: "AppData" }))
      .resolves.toMatchObject({ ok: false, code: "not_found" });
  });

  it("searches the real Documents folder and copies into private Projects", async () => {
    const profile = await seedProfile();
    await writeFile(join(profile, "Documents", "invoice.txt"), "needle-42");
    const store = await AgentHomeStore.create(await tempDir("openbot-user-search-"));
    const home = await store.ensure("agent-a");
    const backend = await HomeWorkspaceBackend.create(home.root, { userProfile: profile });

    const found = await backend.execute({
      operation: "command.run",
      command: "search.text",
      cwd: ".",
      params: { pattern: "needle-42", mode: "fixed", paths: ["shared://Documents"] },
    });
    expect(found).toMatchObject({ ok: true });
    if (found.ok && found.operation === "command.run") {
      expect(found.stdout).toContain("Documents/invoice.txt");
    }

    await expect(backend.execute({
      operation: "file.copy",
      source: "shared://Documents/invoice.txt",
      destination: "Projects/invoice.txt",
    })).resolves.toMatchObject({ ok: true, entries: 1 });
    await expect(readFile(join(home.root, "Projects", "invoice.txt"), "utf8")).resolves.toBe("needle-42");
  });

  it("copies a shared directory into Projects and refuses a junction in the tree", async () => {
    const profile = await seedProfile();
    await mkdir(join(profile, "Documents", "inbox"), { recursive: true });
    await writeFile(join(profile, "Documents", "inbox", "a.txt"), "one");
    await writeFile(join(profile, "Documents", "inbox", "b.txt"), "two");
    const store = await AgentHomeStore.create(await tempDir("openbot-user-dircopy-"));
    const home = await store.ensure("agent-a");
    const backend = await HomeWorkspaceBackend.create(home.root, { userProfile: profile });

    const copied = await backend.execute({
      operation: "file.copy",
      source: "shared://Documents/inbox",
      destination: "Projects/inbox",
    });
    expect(copied).toMatchObject({ ok: true, operation: "file.copy", entries: 3 });
    await expect(readFile(join(home.root, "Projects", "inbox", "a.txt"), "utf8")).resolves.toBe("one");

    const outside = await tempDir("openbot-user-outside-");
    await writeFile(join(outside, "secret.txt"), "nope");
    await symlink(outside, join(profile, "Documents", "inbox", "leak"), "junction");
    await expect(backend.execute({
      operation: "file.copy",
      source: "shared://Documents/inbox",
      destination: "Projects/leaky",
    })).resolves.toMatchObject({ ok: false, code: "outside_workspace" });
    await expect(readFile(join(home.root, "Projects", "leaky", "leak", "secret.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(home.root, "Projects", "leaky"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to copy shared files into .openbot and does not leak home.json", async () => {
    const profile = await seedProfile();
    await writeFile(join(profile, "Documents", "note.txt"), "visible");
    const store = await AgentHomeStore.create(await tempDir("openbot-user-reserved-"));
    const home = await store.ensure("agent-a");
    const backend = await HomeWorkspaceBackend.create(home.root, { userProfile: profile });

    await expect(backend.execute({
      operation: "file.copy",
      source: "shared://Documents/note.txt",
      destination: ".openbot/note.txt",
    })).resolves.toMatchObject({ ok: false, code: "access_denied" });
    await expect(backend.execute({
      operation: "file.copy",
      source: ".openbot/home.json",
      destination: "shared://Documents/home.json",
    })).resolves.toMatchObject({ ok: false, code: "access_denied" });
    await expect(readFile(join(profile, "Documents", "home.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a missing shared mount instead of silently returning an incomplete search", async () => {
    const profile = await seedProfile(["Desktop", "Documents", "Downloads"]);
    await writeFile(join(profile, "Documents", "hit.txt"), "keep-searching");
    const store = await AgentHomeStore.create(await tempDir("openbot-user-search-miss-"));
    const home = await store.ensure("agent-a");
    const backend = await HomeWorkspaceBackend.create(home.root, { userProfile: profile });

    const found = await backend.execute({
      operation: "command.run",
      command: "search.text",
      cwd: ".",
      params: { pattern: "keep-searching", mode: "fixed", paths: ["shared://Documents", "shared://Pictures"] },
    });
    expect(found).toMatchObject({ ok: false, code: "access_denied" });
    await expect(backend.execute({ operation: "command.run", command: "search.text", cwd: ".",
      params: { pattern: "keep-searching", mode: "fixed", paths: ["shared://Documents"] } }))
      .resolves.toMatchObject({ ok: true, stdout: expect.stringContaining("shared://Documents/hit.txt") });
  });

  it("counts shared trash against the home quota surface and omits payloads from inventory", async () => {
    const profile = await seedProfile();
    await writeFile(join(profile, "Downloads", "keep.bin"), "payload");
    const store = await AgentHomeStore.create(await tempDir("openbot-user-inv-"));
    const home = await store.ensure("agent-a");
    const backend = await HomeWorkspaceBackend.create(home.root, { userProfile: profile });

    const baseline = await backend.quota.usage();
    const trashReservationBytes = Buffer.byteLength("payload")
      + Buffer.byteLength(JSON.stringify({ version: 1, path: "shared://Downloads/keep.bin" }));
    const quotaBound = await HomeWorkspaceBackend.create(home.root, {
      userProfile: profile,
      quota: {
        maxBytes: baseline.bytes + trashReservationBytes - 1,
        maxFiles: baseline.files + 2,
        maxEntries: baseline.entries + 3,
      },
    });
    await expect(quotaBound.execute({ operation: "file.trash", path: "shared://Downloads/keep.bin" }))
      .rejects.toThrow(/quota exceeded/i);
    await expect(readFile(join(profile, "Downloads", "keep.bin"), "utf8")).resolves.toBe("payload");

    const trashed = await backend.execute({ operation: "file.trash", path: "shared://Downloads/keep.bin" });
    expect(trashed).toMatchObject({ ok: true });
    const inventory = await inventoryHome(home.root, "agent-a");
    expect(inventory.entries.some((entry) => entry.path.toLowerCase().startsWith(".openbot/trash/") && entry.path.toLowerCase() !== ".openbot/trash")).toBe(false);
  });

  it("does not fall through to the isolated ghost folder when a shared mount is missing", async () => {
    const profile = await seedProfile(["Desktop", "Downloads"]);
    const store = await AgentHomeStore.create(await tempDir("openbot-user-ghost-"));
    const home = await store.ensure("agent-a");
    const backend = await HomeWorkspaceBackend.create(home.root, { userProfile: profile });

    const listed = await backend.execute({ operation: "file.list", path: "." });
    expect(listed).toMatchObject({ ok: true });
    if (listed.ok && listed.operation === "file.list") {
      expect(listed.entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(["Desktop", "Downloads", "Projects"]));
      expect(listed.entries.map((entry) => entry.name)).toContain("Documents");
    }
    await expect(backend.execute({
      operation: "file.write",
      path: "shared://Documents/ghost.txt",
      content: "nope",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: false, code: "access_denied" });
    await expect(readFile(join(home.root, "Documents", "ghost.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to restore over an existing shared file and honors abort", async () => {
    const profile = await seedProfile();
    await writeFile(join(profile, "Downloads", "keep.bin"), "payload");
    await writeFile(join(profile, "Downloads", "other.bin"), "existing");
    const store = await AgentHomeStore.create(await tempDir("openbot-user-restore-"));
    const home = await store.ensure("agent-a");
    const backend = await HomeWorkspaceBackend.create(home.root, { userProfile: profile });

    const trashed = await backend.execute({ operation: "file.trash", path: "shared://Downloads/keep.bin" });
    expect(trashed).toMatchObject({ ok: true });
    if (!trashed.ok || trashed.operation !== "file.trash") throw new Error("expected trash id");
    await expect(backend.execute({
      operation: "file.restore",
      trashId: trashed.trashId,
      path: "shared://Downloads/other.bin",
    })).resolves.toMatchObject({ ok: false, code: "invalid_path" });
    await expect(readFile(join(profile, "Downloads", "other.bin"), "utf8")).resolves.toBe("existing");

    const aborted = new AbortController();
    aborted.abort();
    await expect(backend.execute({
      operation: "file.copy",
      source: "shared://Downloads/other.bin",
      destination: "Projects/other.bin",
    }, aborted.signal)).resolves.toMatchObject({ ok: false, code: "aborted" });
  });

  it("trashes and restores a shared file without leaving the user folder", async () => {
    const profile = await seedProfile();
    await writeFile(join(profile, "Downloads", "keep.bin"), "payload");
    const store = await AgentHomeStore.create(await tempDir("openbot-user-trash-"));
    const home = await store.ensure("agent-a");
    const backend = await HomeWorkspaceBackend.create(home.root, { userProfile: profile });

    const trashed = await backend.execute({ operation: "file.trash", path: "shared://Downloads/keep.bin" });
    expect(trashed).toMatchObject({ ok: true });
    if (!trashed.ok || trashed.operation !== "file.trash") throw new Error("expected trash id");
    await expect(readFile(join(profile, "Downloads", "keep.bin"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await expect(backend.execute({ operation: "file.restore", trashId: trashed.trashId }))
      .resolves.toMatchObject({ ok: true, path: "shared://Downloads/keep.bin" });
    await expect(readFile(join(profile, "Downloads", "keep.bin"), "utf8")).resolves.toBe("payload");
  });

  it("follows a Documents junction and skips folders that are not present", async () => {
    const profile = await tempDir("openbot-user-junction-");
    const actual = await tempDir("openbot-user-onedrive-");
    await mkdir(join(actual, "inbox"), { recursive: true });
    await writeFile(join(actual, "inbox", "mail.txt"), "from-onedrive");
    await symlink(actual, join(profile, "Documents"), "junction");
    await mkdir(join(profile, "Desktop"));
    await mkdir(join(profile, "Downloads"));

    const mounts = await loadSharedUserMounts(profile);
    expect([...mounts.keys()]).toEqual(["Desktop", "Documents", "Downloads"]);

    const store = await AgentHomeStore.create(await tempDir("openbot-user-jhome-"));
    const home = await store.ensure("agent-a");
    const backend = await HomeWorkspaceBackend.create(home.root, { userProfile: profile });
    await expect(backend.execute({ operation: "file.read", path: "shared://Documents/inbox/mail.txt", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: true, content: "from-onedrive" });
    await expect(backend.execute({ operation: "file.list", path: "shared://Pictures" }))
      .resolves.toMatchObject({ ok: false, code: "access_denied" });
  });

  it("keeps HomeWorkspaceBackend.create isolated when no profile is provided", async () => {
    const store = await AgentHomeStore.create(await tempDir("openbot-user-isolated-"));
    const home = await store.ensure("agent-a");
    const backend = await HomeWorkspaceBackend.create(home.root);
    await expect(backend.execute({
      operation: "file.write",
      path: "Documents/local-only.txt",
      content: "sandbox",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(home.root, "Documents", "local-only.txt"), "utf8")).resolves.toBe("sandbox");
  });
});
