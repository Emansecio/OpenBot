import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SkillCatalog } from "../src/skills/catalog.js";
import { OPENBOT_SKILL_ROOT_SOURCE } from "../src/skills/contracts.js";
import {
  SKILL_TOOLS,
  SkillDispatcher,
  createSkillDispatcher,
  type SkillAgentPolicy,
} from "../src/skills/dispatcher.js";
import type { ProviderToolCall } from "../src/providers/router.js";
import type { ToolExecutionResult } from "../src/execution/tool-loop.js";

const roots: string[] = [];

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "openbot-skill-dispatcher-"));
  roots.push(path);
  return path;
}

function addSkill(rootPath: string, id: string, body: string, metadata = ""): void {
  const directory = join(rootPath, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: ${id} skill\ndescription: Skill for ${id}\n${metadata}---\n${body}\n`,
    "utf8",
  );
}

function call(name: string, args: unknown): ProviderToolCall {
  return { id: `${name}-1`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function handled(result: ToolExecutionResult): Exclude<ToolExecutionResult, { handled: false }> {
  if (!result.handled) throw new Error("expected Skill tool to be handled");
  return result;
}

function dispatcher(policyForAgent?: (agentId: string) => SkillAgentPolicy): SkillDispatcher {
  const path = root();
  addSkill(path, "browser", "Use the browser visually.");
  addSkill(path, "hidden", "Never return this.", "disable-model-invocation: true\n");
  addSkill(path, "private", "Bot policy denies this.");
  return createSkillDispatcher({
    catalog: new SkillCatalog({ roots: [{ path, source: "test" }] }),
    policyForAgent,
  });
}

describe("SkillDispatcher", () => {
  it("publica somente as duas tools compartilhadas com schemas fechados", () => {
    expect(SKILL_TOOLS.map((tool) => tool.function.name)).toEqual(["search_skills", "use_skill"]);
    for (const tool of SKILL_TOOLS) {
      expect(tool.type).toBe("function");
      expect(tool.function.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("busca apenas Skills model-invocáveis, aplica a policy do bot e não expõe paths", async () => {
    const instance = dispatcher(() => ({ enabled: true, disabledIds: ["private"] }));
    const result = await instance.execute({ agentId: "bot-a", call: call("search_skills", { query: "skill" }) });

    const success = handled(result);
    expect(success).toMatchObject({ handled: true, ok: true });
    expect(JSON.parse(success.content)).toEqual([
      { id: "browser", name: "browser skill", description: "Skill for browser", source: "test" },
    ]);
    expect(success.content).not.toContain("\\openbot-skill-dispatcher-");
  });

  it("recarrega o corpo alterado no caminho async sem chamar read síncrono", async () => {
    const path = root();
    addSkill(path, "browser", "Use the browser visually.");
    const catalog = new SkillCatalog({ roots: [{ path, source: "test" }] });
    catalog.read = () => { throw new Error("synchronous reread must not run"); };
    writeFileSync(
      join(path, "browser", "SKILL.md"),
      "---\nname: browser skill\ndescription: Skill for browser\n---\nUpdated browser instructions.\n",
      "utf8",
    );
    const instance = createSkillDispatcher({ catalog });

    const result = handled(await instance.execute({
      agentId: "bot-a",
      call: call("use_skill", { id: "browser" }),
    }));
    expect(result).toMatchObject({ handled: true, ok: true });
    expect(result.content).toContain("Updated browser instructions.");
  });

  it("usa o conteúdo pré-carregado sem reler SKILL.md no caminho da tool", async () => {
    const path = root();
    addSkill(path, "browser", "Use the browser visually.");
    const catalog = new SkillCatalog({ roots: [{ path, source: "test" }] });
    catalog.read = () => { throw new Error("synchronous reread must not run"); };
    catalog.readAsync = async () => { throw new Error("asynchronous reread must not run"); };
    const instance = createSkillDispatcher({ catalog });

    const result = handled(await instance.execute({
      agentId: "bot-a",
      call: call("use_skill", { id: "browser" }),
    }));
    expect(result).toMatchObject({ handled: true, ok: true });
    expect(result.content).toContain("Use the browser visually.");
  });

  it("não permite que o modelo carregue Skill marcada como manual-only", async () => {
    const path = root();
    addSkill(path, "manual-only", "Conteúdo para uso manual.", "auto-select: false\n");
    const instance = createSkillDispatcher({ catalog: new SkillCatalog({ roots: [{ path, source: "test" }] }) });

    const search = handled(await instance.execute({ agentId: "bot-a", call: call("search_skills", { query: "manual" }) }));
    expect(JSON.parse(search.content).map((entry: { id: string }) => entry.id)).not.toContain("manual-only");

    const use = handled(await instance.execute({ agentId: "bot-a", call: call("use_skill", { id: "manual-only" }) }));
    expect(use).toMatchObject({ handled: true, ok: false, error: "skill requires explicit user selection" });
    expect(use.content).toBe("");
  });

  it("usa o corpo somente por id catalogado e o delimita como untrusted", async () => {
    const instance = dispatcher();
    const result = await instance.execute({ agentId: "bot-a", call: call("use_skill", { id: "browser" }) });

    const success = handled(result);
    expect(success).toMatchObject({ handled: true, ok: true, result: { ok: true, operation: "skills.use" } });
    expect(success.content).toContain("[[OPENBOT_SKILL_BEGIN:browser]]");
    expect(success.content).toContain("Use the browser visually.");
    expect(success.content).toContain("[[OPENBOT_SKILL_END:browser]]");
  });

  it("fails closed for autonomous use when model invocation metadata changes after scan", async () => {
    const path = root();
    addSkill(path, "changing", "Do not use after metadata drift.");
    const catalog = new SkillCatalog({ roots: [{ path, source: "test" }] });
    const instance = createSkillDispatcher({ catalog });
    writeFileSync(
      join(path, "changing", "SKILL.md"),
      "---\nname: changing skill\ndescription: Skill for changing\ndisable-model-invocation: true\n---\nChanged\n",
      "utf8",
    );

    const result = handled(await instance.execute({ agentId: "bot-a", call: call("use_skill", { id: "changing" }) }));
    expect(result).toMatchObject({ handled: true, ok: false, error: "skill is unavailable" });
  });

  it("falha fechado para argumentos inválidos, Skill escondida e policy negada", async () => {
    const instance = dispatcher(() => ({ enabled: true, disabledIds: ["private"] }));
    const unknownField = await instance.execute({ agentId: "bot-a", call: call("use_skill", { id: "browser", extra: "x" }) });
    const malformed = await instance.execute({ agentId: "bot-a", call: { ...call("search_skills", {}), function: { name: "search_skills", arguments: "[]" } } });
    const hidden = await instance.execute({ agentId: "bot-a", call: call("use_skill", { id: "hidden" }) });
    const denied = await instance.execute({ agentId: "bot-a", call: call("use_skill", { id: "private" }) });

    for (const rawFailure of [unknownField, malformed, hidden, denied]) {
      const failure = handled(rawFailure);
      expect(failure).toMatchObject({ handled: true, ok: false, content: "" });
      expect(failure.error).not.toContain("\\openbot-skill-dispatcher-");
    }
  });

  it("limita bytes de conteúdo injetado e identifica somente suas tools", async () => {
    const path = root();
    addSkill(path, "large", "x".repeat(200));
    const instance = createSkillDispatcher({
      catalog: new SkillCatalog({ roots: [{ path, source: "test" }] }),
      maxInjectedBytes: 64,
    });

    expect(instance.canHandle("use_skill")).toBe(true);
    expect(instance.canHandle("search_skills")).toBe(true);
    expect(instance.canHandle("save_skill")).toBe(false);
    expect(instance.canHandle("file")).toBe(false);
    await expect(instance.execute({ agentId: "bot-a", call: call("use_skill", { id: "large" }) })).resolves.toMatchObject({
      handled: true,
      ok: false,
      error: "skill content exceeds the injection limit",
    });
  });

  it("save_skill grava no root profile-openbot, indexa e permite atualizar", async () => {
    const readOnly = root();
    const authoring = root();
    const instance = createSkillDispatcher({
      catalog: new SkillCatalog({
        roots: [
          { path: readOnly, source: "test" },
          { path: authoring, source: OPENBOT_SKILL_ROOT_SOURCE },
        ],
      }),
    });

    expect(instance.tools.map((tool) => tool.function.name)).toEqual(["search_skills", "use_skill", "save_skill"]);

    const first = handled(await instance.execute({
      agentId: "bot-a",
      call: call("save_skill", {
        id: "deploy-checklist",
        name: "Deploy checklist",
        description: "Use when preparing a production deploy with smoke tests.",
        body: "1. Run tests.\n2. Tag release.\n",
        triggers: ["deploy", "release"],
      }),
    }));
    expect(first).toMatchObject({ handled: true, ok: true, result: { ok: true, operation: "skills.save" } });
    expect(JSON.parse(first.content)).toEqual({
      ok: true,
      id: "deploy-checklist",
      created: true,
      path: `${OPENBOT_SKILL_ROOT_SOURCE}/deploy-checklist/SKILL.md`,
    });
    expect(existsSync(join(authoring, "deploy-checklist", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(authoring, "deploy-checklist", "SKILL.md"), "utf8")).toContain("Run tests.");

    const search = handled(await instance.execute({
      agentId: "bot-a",
      call: call("search_skills", { query: "smoke" }),
    }));
    expect(JSON.parse(search.content).map((entry: { id: string }) => entry.id)).toContain("deploy-checklist");

    const second = handled(await instance.execute({
      agentId: "bot-a",
      call: call("save_skill", {
        id: "deploy-checklist",
        name: "Deploy checklist",
        description: "Use when preparing a production deploy with smoke tests.",
        body: "1. Run full suite.\n2. Tag release.\n",
      }),
    }));
    expect(JSON.parse(second.content)).toMatchObject({ ok: true, id: "deploy-checklist", created: false });

    const use = handled(await instance.execute({
      agentId: "bot-a",
      call: call("use_skill", { id: "deploy-checklist" }),
    }));
    expect(use.content).toContain("Run full suite.");
  });

  it("save_skill recusa id pertencente a root somente leitura", async () => {
    const readOnly = root();
    const authoring = root();
    addSkill(readOnly, "browser", "Read-only body.");
    const skillPath = join(authoring, "browser", "SKILL.md");
    const instance = createSkillDispatcher({
      catalog: new SkillCatalog({
        roots: [
          { path: readOnly, source: "test" },
          { path: authoring, source: OPENBOT_SKILL_ROOT_SOURCE },
        ],
      }),
    });

    const result = handled(await instance.execute({
      agentId: "bot-a",
      call: call("save_skill", {
        id: "browser",
        name: "Browser",
        description: "Use when automating browser tasks.",
        body: "Attempted overwrite.",
      }),
    }));
    expect(result).toMatchObject({
      handled: true,
      ok: false,
      error: "skill id belongs to a read-only root",
      result: { ok: false, operation: "skills.save", code: "policy" },
    });
    expect(existsSync(skillPath)).toBe(false);
  });
});
