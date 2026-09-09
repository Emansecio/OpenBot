import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SkillCatalog } from "../src/skills/catalog.js";
import { RpcError } from "../src/server/gateway.js";
import { registerSkillHandlers, type ResolveSkillPolicy, type SkillRpcHandler } from "../src/rpc/skills.js";

type Registered = Map<string, SkillRpcHandler>;

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function register(catalog: SkillCatalog, resolveSkillPolicy?: ResolveSkillPolicy): Registered {
  const handlers: Registered = new Map();
  registerSkillHandlers({ registerHandler(method: string, handler: SkillRpcHandler) {
    handlers.set(method, handler);
  }} as never, { catalog, ...(resolveSkillPolicy ? { resolveSkillPolicy } : {}) });
  return handlers;
}

function skillRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openbot-rpc-skills-"));
  tempRoots.push(root);
  return root;
}

function writeSkill(root: string, id: string, frontmatter: string, body = "Use the skill safely.\n"): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`, "utf8");
}

describe("skill RPC adapter", () => {
  it("projects only enabled skills into native slash workflows without leaking body or paths", () => {
    const root = skillRoot();
    writeSkill(root, "research-web", "name: Web Research\ndescription: Pesquisa na web\n");
    writeSkill(root, "hidden", "name: Hidden\ndescription: Não aparece\nuser-invocable: false\n");
    const catalog = new SkillCatalog({ roots: [{ path: root, source: "user" }] });
    const handlers = register(catalog, (agentId, skillId) => (
      agentId === "bot-a" && skillId === "hidden" ? { enabled: false } : undefined
    ));

    const workflows = handlers.get("getAgentWorkflows")!({ id: "bot-a" }, {} as never) as Array<Record<string, unknown>>;

    expect(workflows).toEqual([expect.objectContaining({
      id: "skill:research-web",
      name: "Web Research",
      description: "Pesquisa na web",
      body: "",
      filePath: "",
      trigger: null,
      source: "local-skill",
      isEnabledForAgent: true,
      disableModelInvocation: false,
    })]);
    expect(JSON.stringify(workflows)).not.toContain("Use the skill safely");
    expect(JSON.stringify(workflows)).not.toContain(root);
  });

  it("returns a public summary and applies an agent policy to available skills", () => {
    const root = skillRoot();
    writeSkill(root, "alpha", "name: Alpha\ndescription: Primeiro\n");
    writeSkill(root, "beta", "name: Beta\ndescription: Segundo\n");
    const catalog = new SkillCatalog({ roots: [{ path: root, source: "project" }] });
    const handlers = register(catalog, (_agentId, skillId) => skillId === "beta" ? { enabled: false } : undefined);

    const skills = handlers.get("getAvailableSkills")!({ agentId: "bot-a" }, {} as never) as Array<Record<string, unknown>>;
    expect(skills).toEqual([{ id: "alpha", name: "Alpha", description: "Primeiro", source: "project" }]);
    expect(JSON.stringify(skills)).not.toContain("content");
  });

  it("projects catalog model-invocation restrictions into disableModelInvocation", () => {
    const root = skillRoot();
    writeSkill(root, "manual-only", "name: Manual Only\ndescription: Exige referência explícita\ndisable-model-invocation: true\n");
    const catalog = new SkillCatalog({ roots: [{ path: root, source: "user" }] });
    const workflows = register(catalog).get("getAgentWorkflows")!({ id: "bot-a" }, {} as never) as Array<Record<string, unknown>>;

    expect(workflows).toEqual([expect.objectContaining({
      id: "skill:manual-only",
      disableModelInvocation: true,
      isEnabledForAgent: true,
    })]);
  });

  it("refreshes metadata and returns the refreshed public list", () => {
    const root = skillRoot();
    writeSkill(root, "first", "name: First\ndescription: Inicial\n");
    const catalog = new SkillCatalog({ roots: [{ path: root, source: "user" }] });
    const handlers = register(catalog);
    writeSkill(root, "second", "name: Second\ndescription: Depois\n");

    const skills = handlers.get("refreshSkills")!({ id: "bot-a" }, {} as never) as Array<Record<string, unknown>>;
    expect(skills.map((skill) => skill.id)).toEqual(["first", "second"]);
  });

  it("validates request bodies and returns an empty list without an installed catalog", () => {
    const handlers: Registered = new Map();
    registerSkillHandlers({ registerHandler(method: string, handler: SkillRpcHandler) {
      handlers.set(method, handler);
    }} as never);

    expect(handlers.get("getAgentWorkflows")!({ id: "bot-a" }, {} as never)).toEqual([]);
    expect(() => handlers.get("getAgentWorkflows")!(null, {} as never)).toThrowError(RpcError);
    let validationError: unknown;
    try {
      handlers.get("getAvailableSkills")!(null, {} as never);
    } catch (error) {
      validationError = error;
    }
    expect(validationError).toBeInstanceOf(RpcError);
    expect(validationError).toMatchObject({ status: 400 });
  });
});
