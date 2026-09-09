import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SkillCatalog } from "../src/skills/catalog.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(prefix = "openbot-skills-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

function skill(rootPath: string, id: string, content: string): string {
  const directory = join(rootPath, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), content, "utf8");
  return directory;
}

function frontmatter(name: string, description: string, body = "Instructions") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

function linkDirectory(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

describe("SkillCatalog", () => {
  it("scans only immediate SKILL.md files, applies root precedence, and never exposes paths", () => {
    const high = root("openbot-skills-high-");
    const low = root("openbot-skills-low-");
    skill(high, "shared", frontmatter("High", "from high"));
    skill(high, "only-high", frontmatter("Only high", "high"));
    const nested = join(high, "nested-only");
    mkdirSync(join(nested, "child"), { recursive: true });
    writeFileSync(join(nested, "child", "SKILL.md"), frontmatter("Nested", "must be ignored"), "utf8");
    skill(low, "shared", frontmatter("Low", "from low"));
    skill(low, "only-low", frontmatter("Only low", "low"));

    const catalog = new SkillCatalog({
      roots: [
        { path: high, source: "project" },
        { path: low, source: "profile" },
      ],
    });

    expect(catalog.list()).toEqual([
      { id: "only-high", name: "Only high", description: "high", source: "project" },
      { id: "only-low", name: "Only low", description: "low", source: "profile" },
      { id: "shared", name: "High", description: "from high", source: "project" },
    ]);
    expect(JSON.stringify(catalog.list())).not.toContain(high);
    expect(JSON.stringify(catalog.list())).not.toContain(low);
    expect(catalog.list("LOW")).toEqual([
      { id: "only-low", name: "Only low", description: "low", source: "profile" },
    ]);
  });

  it("reloads the body on demand and marks it as untrusted, delimited content", () => {
    const rootPath = root();
    const directory = skill(rootPath, "reader", frontmatter("Reader", "read me", "First body"));
    const catalog = new SkillCatalog({ roots: [{ path: rootPath, source: "user" }] });

    writeFileSync(join(directory, "SKILL.md"), frontmatter("Reader", "read me", "Second body"), "utf8");
    const result = catalog.read("reader");

    expect(result).toMatchObject({
      id: "reader",
      name: "Reader",
      description: "read me",
      source: "user",
      content: "Second body\n",
      trust: "untrusted",
      invocation: {
        modelInvocable: true,
        userInvocable: true,
        autoSelect: true,
        triggers: [],
      },
    });
    expect(result?.delimiters.start).toContain("reader");
    expect(result?.delimiters.end).toContain("reader");
    expect(result?.content).not.toContain("C:\\");
  });

  it("encontra e ranqueia uma Skill com uma consulta natural não contígua", () => {
    const rootPath = root();
    skill(rootPath, "local-auditor", frontmatter("Local Project Auditor", "Audit local projects for confirmed bugs and bottlenecks"));
    skill(rootPath, "generic-project", frontmatter("Project Notes", "Organize project documentation"));
    const catalog = new SkillCatalog({ roots: [{ path: rootPath, source: "user" }] });

    expect(catalog.list("audit this local project for real bugs").map((entry) => entry.id)).toEqual([
      "local-auditor",
      "generic-project",
    ]);
  });

  it("rejects invocation metadata drift until refresh while allowing body changes", () => {
    const rootPath = root();
    const directory = skill(rootPath, "drift", frontmatter("Drift", "stable", "Original body"));
    const catalog = new SkillCatalog({ roots: [{ path: rootPath, source: "user" }] });

    writeFileSync(
      join(directory, "SKILL.md"),
      ["---", "name: Drift", "description: stable", "user-invocable: false", "---", "Changed body", ""].join("\n"),
      "utf8",
    );
    expect(catalog.read("drift")).toBeUndefined();

    catalog.refresh();
    expect(catalog.read("drift")).toMatchObject({ content: "Changed body\n", invocation: { userInvocable: false } });

    writeFileSync(
      join(directory, "SKILL.md"),
      ["---", "name: Drift", "description: stable", "disable-model-invocation: true", "---", "Body after model drift", ""].join("\n"),
      "utf8",
    );
    expect(catalog.read("drift")).toBeUndefined();
  });

  it("accepts known invocation fields but rejects unknown frontmatter", () => {
    const rootPath = root();
    skill(
      rootPath,
      "invocation",
      [
        "---",
        "name: Invocation",
        "description: known fields",
        "disable-model-invocation: true",
        "user-invocable: false",
        "auto-select: false",
        "triggers: [forms, browser]",
        "argument-hint: optional request",
        "metadata:",
        "  author: test",
        "---",
        "Body",
        "",
      ].join("\n"),
    );
    skill(rootPath, "unknown", "---\nname: Unknown\ndescription: bad\nnot-allowed: yes\n---\nBody\n");

    const catalog = new SkillCatalog({ roots: [{ path: rootPath, source: "user" }] });

    expect(catalog.list()).toEqual([
      { id: "invocation", name: "Invocation", description: "known fields", source: "user" },
    ]);
    expect(catalog.read("invocation")?.invocation).toEqual({
      modelInvocable: false,
      userInvocable: false,
      autoSelect: false,
      triggers: ["forms", "browser"],
      argumentHint: "optional request",
    });
    expect(catalog.read("unknown")).toBeUndefined();
  });

  it("fails closed for invalid UTF-8, oversized files, and a bounded candidate count", () => {
    const rootPath = root();
    const invalid = skill(rootPath, "invalid-utf8", frontmatter("Invalid", "bytes"));
    writeFileSync(join(invalid, "SKILL.md"), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xc3, 0x28]));
    skill(rootPath, "too-large", frontmatter("Large", "bytes", "x".repeat(100)));
    skill(rootPath, "valid", frontmatter("Valid", "kept"));

    const catalog = new SkillCatalog({
      roots: [{ path: rootPath, source: "user" }],
      limits: { maxSkillBytes: 80, maxCandidates: 2 },
    });

    expect(catalog.list()).toEqual([]);
    expect(catalog.read("invalid-utf8")).toBeUndefined();
    expect(catalog.read("too-large")).toBeUndefined();
  });

  it("rejects symlink/junction roots and skill components before reading", () => {
    const real = root("openbot-skills-real-");
    const linkedRoot = join(root("openbot-skills-parent-"), "linked-root");
    linkDirectory(real, linkedRoot);
    expect(() => new SkillCatalog({ roots: [{ path: linkedRoot, source: "linked" }] })).toThrow(
      /symlink|junction|reparse|link/i,
    );

    const rootPath = root();
    const target = root("openbot-skills-target-");
    skill(target, "outside", frontmatter("Outside", "must not load"));
    linkDirectory(join(target, "outside"), join(rootPath, "outside"));
    expect(new SkillCatalog({ roots: [{ path: rootPath, source: "user" }] }).list()).toEqual([]);
    expect(lstatSync(join(rootPath, "outside")).isSymbolicLink()).toBe(true);
  });

  it("rejects traversal-like and invalid ids without touching other entries", () => {
    const rootPath = root();
    skill(rootPath, "safe-id", frontmatter("Safe", "valid"));
    const escaped = join(rootPath, "..", "escape");
    tempRoots.push(escaped);
    mkdirSync(escaped, { recursive: true });
    const catalog = new SkillCatalog({ roots: [{ path: rootPath, source: "user" }] });

    expect(catalog.read("../escape")).toBeUndefined();
    expect(catalog.read("safe id")).toBeUndefined();
    expect(catalog.list()).toEqual([{ id: "safe-id", name: "Safe", description: "valid", source: "user" }]);
  });

  it("indexes folded block scalar descriptions in frontmatter", () => {
    const rootPath = root();
    skill(rootPath, "folded-desc", `---
name: Folded
description: >-
  first folded line
  second folded line
---
Instructions
`);
    const catalog = new SkillCatalog({ roots: [{ path: rootPath, source: "user" }] });
    expect(catalog.list()).toEqual([
      { id: "folded-desc", name: "Folded", description: "first folded line second folded line", source: "user" },
    ]);
  });

  it("revalidates the descriptor target when a skill directory is replaced after discovery", () => {
    const rootPath = root();
    const original = skill(rootPath, "replace-me", frontmatter("Replace", "original"));
    const outside = root("openbot-skills-replacement-");
    skill(outside, "replacement", frontmatter("Replacement", "outside"));
    const catalog = new SkillCatalog({ roots: [{ path: rootPath, source: "user" }] });

    rmSync(original, { recursive: true, force: true });
    linkDirectory(join(outside, "replacement"), original);

    expect(catalog.read("replace-me")).toBeUndefined();
  });
});
