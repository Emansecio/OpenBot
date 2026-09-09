import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SkillCatalog } from "../src/skills/catalog.js";
import { resolveSkillContext,parseSkillReferences,parseSkillCommand } from "../src/skills/references.js";

const roots: string[] = [];

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixtureCatalog(): SkillCatalog {
  const path = mkdtempSync(join(tmpdir(), "openbot-skill-references-"));
  roots.push(path);
  for (const [id, body] of [["browser", "Browser body"], ["research", "Research body"], ["hidden", "Hidden body"]] as const) {
    const directory = join(path, id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "SKILL.md"),
      `---\nname: ${id}\ndescription: ${id} description\n${id === "hidden" ? "user-invocable: false\n" : ""}---\n${body}\n`,
      "utf8",
    );
  }
  return new SkillCatalog({ roots: [{ path, source: "test" }] });
}

describe("explicit Skill references", () => {
  it("percorre Tiptap recursivamente, aceita somente skill:<id> e deduplica", () => {
    const richText = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "workflowReference", attrs: { id: "skill:Browser" } },
            { type: "text", text: " pedido " },
            { type: "blockquote", content: [{ type: "workflowReference", attrs: { id: "skill:browser" } }] },
            { type: "workflowReference", attrs: { id: "not-a-skill:research" } },
          ],
        },
        { type: "workflowReference", attrs: { id: "skill:research" } },
      ],
    });

    expect(parseSkillReferences(richText)).toEqual(["browser", "research"]);
    expect(parseSkillReferences("<span data-id=skill:browser>fake</span>")).toEqual([]);
  });

  it("só reconhece /skill no começo do prompt e normaliza o texto restante", () => {
    expect(parseSkillCommand("/skill browser pesquise o site")).toEqual({ skillId: "browser", prompt: "pesquise o site" });
    expect(parseSkillCommand("/skill browser")).toEqual({ skillId: "browser", prompt: "" });
    expect(parseSkillCommand("antes /skill browser pedido")).toBeUndefined();
    expect(parseSkillCommand("/skill ../outside pedido")).toBeUndefined();
  });

  it("resolve referências válidas com user policy e não persiste o conteúdo no prompt", async () => {
    const catalog = fixtureCatalog();
    const richText = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "workflowReference", attrs: { id: "skill:browser" } }] }],
    });
    const result = await resolveSkillContext({
      catalog,
      prompt: "/skill research faça uma busca",
      richText,
      policy: { enabled: true },
    });

    expect(result.skillIds).toEqual(["browser", "research"]);
    expect(result.prompt).toBe("faça uma busca");
    expect(result.context).toContain("Browser body");
    expect(result.context).toContain("Research body");
    expect(result.context).not.toContain("C:\\");
  });

  it("falha fechado para referência manual quando user-invocable muda após o scan", async () => {
    const path = mkdtempSync(join(tmpdir(), "openbot-skill-reference-drift-"));
    roots.push(path);
    const directory = join(path, "browser");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), "---\nname: browser\ndescription: browser description\n---\nBrowser body\n", "utf8");
    const catalog = new SkillCatalog({ roots: [{ path, source: "test" }] });
    writeFileSync(join(directory, "SKILL.md"), "---\nname: browser\ndescription: browser description\nuser-invocable: false\n---\nBrowser body\n", "utf8");

    const result = await resolveSkillContext({ catalog, prompt: "/skill browser pedido", policy: { enabled: true } });
    expect(result).toMatchObject({ prompt: "pedido", skillIds: [], rejectedIds: ["browser"], context: "" });
  });

  it("omite Skills desconhecidas, não user-invocáveis ou negadas e não vaza paths", async () => {
    const result = await resolveSkillContext({
      catalog: fixtureCatalog(),
      prompt: "/skill hidden pedido",
      richText: JSON.stringify({ type: "doc", content: [{ type: "workflowReference", attrs: { id: "skill:missing" } }] }),
      policy: { enabled: true, disabledIds: ["browser"] },
    });

    expect(result.skillIds).toEqual([]);
    expect(result.rejectedIds).toEqual(["missing", "hidden"]);
    expect(result.context).toBe("");
    expect(result).not.toHaveProperty("path");
    expect(JSON.stringify(result)).not.toContain("openbot-skill-references-");
  });
});
