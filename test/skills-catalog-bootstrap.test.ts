import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", { spy: true });

import { createSafeSkillCatalog } from "../src/main.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(prefix = "openbot-skills-bootstrap-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

describe("safe SkillCatalog bootstrap", () => {
  it("omits invalid roots and scans each accepted skill once", () => {
    const rootPath = root();
    const skillPath = join(rootPath, "accepted");
    mkdirSync(skillPath, { recursive: true });
    writeFileSync(
      join(skillPath, "SKILL.md"),
      "---\nname: Accepted\ndescription: valid\n---\nInstructions\n",
      "utf8",
    );
    const invalidRoot = join(root(), "missing-root");
    const openSpy = vi.mocked(fs.openSync);
    openSpy.mockClear();

    const catalog = createSafeSkillCatalog([
      { path: invalidRoot, source: "invalid" },
      { path: rootPath, source: "valid" },
    ]);

    expect(catalog.list()).toEqual([
      { id: "accepted", name: "Accepted", description: "valid", source: "valid" },
    ]);
    expect(openSpy).toHaveBeenCalledTimes(1);
  });
});
