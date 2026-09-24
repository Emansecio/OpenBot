import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", { spy: true });

import { SkillCatalog } from "../src/skills/catalog.js";
import { TempRoots } from "./helpers/temp-roots.js";

const temp = new TempRoots();

afterEach(async () => {
  await temp.cleanup();
});

function root(): string {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), "openbot-skills-cache-")));
  temp.track(path);
  return path;
}

function skill(rootPath: string, body: string): string {
  const directory = join(rootPath, "cached");
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, "SKILL.md");
  writeFileSync(filePath, `---\nname: Cached\ndescription: stable\n---\n${body}\n`, "utf8");
  return filePath;
}

describe("SkillCatalog cache", () => {
  it("reuses validated metadata/body until the file snapshot changes", () => {
    const rootPath = root();
    const filePath = skill(rootPath, "first body");
    const openSpy = vi.mocked(fs.openSync);
    const readSpy = vi.mocked(fs.readFileSync);
    openSpy.mockClear();
    readSpy.mockClear();

    const catalog = new SkillCatalog({ roots: [{ path: rootPath, source: "test" }] });
    const initialOpenCount = openSpy.mock.calls.length;
    const initialReadCount = readSpy.mock.calls.length;

    expect(catalog.read("cached")?.content).toBe("first body\n");
    expect(catalog.refresh()).toEqual([{ id: "cached", name: "Cached", description: "stable", source: "test" }]);
    expect(openSpy.mock.calls.length).toBe(initialOpenCount);
    expect(readSpy.mock.calls.length).toBe(initialReadCount);

    writeFileSync(filePath, "---\nname: Cached\ndescription: stable\n---\nsecond body\n", "utf8");
    expect(catalog.read("cached")?.content).toBe("second body\n");
    expect(openSpy.mock.calls.length).toBe(initialOpenCount + 1);
    expect(readSpy.mock.calls.length).toBe(initialReadCount + 1);
  });

  it("readAsync reloads a changed body without sync open/read", async () => {
    const rootPath = root();
    const filePath = skill(rootPath, "first body");
    const catalog = new SkillCatalog({ roots: [{ path: rootPath, source: "test" }] });
    const openSpy = vi.mocked(fs.openSync);
    const readSpy = vi.mocked(fs.readFileSync);
    openSpy.mockClear();
    readSpy.mockClear();

    expect((await catalog.readAsync("cached"))?.content).toBe("first body\n");
    const before = statSync(filePath);
    writeFileSync(filePath, "---\nname: Cached\ndescription: stable\n---\nasync body\n", "utf8");
    utimesSync(filePath, before.atime, new Date(before.mtimeMs + 2_000));
    expect(statSync(filePath).size).toBe(before.size);
    expect(statSync(filePath).mtimeMs).toBeGreaterThan(before.mtimeMs);
    expect((await catalog.readCachedValidated("cached"))?.content).toBe("async body\n");
    expect(openSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("revalidates every cached path component after discovery", async () => {
    const rootPath = root();
    skill(rootPath, "retained body");
    const catalog = new SkillCatalog({ roots: [{ path: rootPath, source: "test" }] });
    const retainedPath = join(rootPath, "retained");
    const cachedPath = join(rootPath, "cached");
    renameSync(join(rootPath, "cached"), retainedPath);
    symlinkSync(retainedPath, cachedPath, process.platform === "win32" ? "junction" : "dir");

    expect(await catalog.readCachedValidated("cached")).toBeUndefined();
    expect(await catalog.readAsync("cached")).toBeUndefined();
  });

});
