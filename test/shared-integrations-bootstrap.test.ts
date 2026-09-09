import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../src/config/store.js";
import { defaultSkillRoots, startServer, stopServer, type ServerHandle } from "../src/main.js";
import { McpManager } from "../src/mcp/manager.js";
import { createProviderRegistry, type ProviderAdapter, type ProviderChatRequest } from "../src/providers/router.js";
import { SkillCatalog } from "../src/skills/catalog.js";

const roots: string[] = [];
const handles: ServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const turnRequests = (requests: ProviderChatRequest[]) => requests.filter((request) => (request.purpose ?? "turn") === "turn");

describe("shared integrations bootstrap", () => {
  it("includes the known system and public shared Skill groups without recursive discovery", () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-shared-roots-"));
    roots.push(root);
    const project = join(root, "project");
    const profile = join(root, "profile");
    mkdirSync(join(project, ".agents", "skills"), { recursive: true });
    mkdirSync(join(profile, ".codex", "skills", ".system"), { recursive: true });
    mkdirSync(join(profile, ".codex", "skills", "public"), { recursive: true });
    mkdirSync(join(profile, ".codex", "skills", "arbitrary", "nested"), { recursive: true });

    expect(defaultSkillRoots(project, profile).map((entry) => entry.source)).toEqual([
      "project-agents",
      "profile-codex",
      "profile-codex-system",
      "profile-codex-public",
      "profile-openbot",
    ]);
    expect(existsSync(join(profile, ".openbot", "skills"))).toBe(true);
  });

  it("wires the native slash catalog, ephemeral Skill context, and autonomous tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-shared-bootstrap-"));
    roots.push(root);
    const skillRoot = join(root, "skills");
    const skillDir = join(skillRoot, "research-web");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: Web Research\ndescription: Visual web research\n---\nUse the visual browser carefully.\n", "utf8");

    const config = new ConfigStore({ configPath: join(root, "config.json") });
    config.update({ agents: [{ id: "bot", name: "Bot", avatarId: "bot" }] });
    const requests: ProviderChatRequest[] = [];
    const adapter: ProviderAdapter = {
      name: "xai",
      async streamChat(request, emit) {
        requests.push(request);
        emit({ type: "delta", delta: "ok" });
      },
    };
    const registry = createProviderRegistry();
    registry.register(adapter);
    const skillCatalog = new SkillCatalog({ roots: [{ path: skillRoot, source: "test" }] });
    const handle = await startServer(0, {
      config,
      stateRoot: join(root, "state"),
      runtimeRoot: join(root, "runtime"),
      browserRoot: join(root, "browser"),
      allowUnauthenticatedLocalGateway: true,
      registry,
      storePath: join(root, "store.db"),
      keystoreDir: join(root, "keys"),
      disableAgentHome: true,
      sharedIntegrationsEnabled: true,
      skillCatalog,
      mcpManager: new McpManager(),
    });
    handles.push(handle);

    const response = await fetch(`http://127.0.0.1:${handle.port}/api/getAgentWorkflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "bot" }),
    });
    const envelope = await response.json() as { ok: boolean; value: Array<Record<string, unknown>> };
    expect(envelope.value).toEqual([expect.objectContaining({ id: "skill:research-web", name: "Web Research", trigger: null })]);

    const richText = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "workflowReference", attrs: { id: "skill:research-web", label: "Web Research" } }] }],
    });
    handle.runner.sendPrompt({ agentId: "bot", prompt: "pesquise", richText });
    await handle.runner.flush("bot");

    expect(turnRequests(requests)[0]?.tools?.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["search_skills", "use_skill"]));
    expect(turnRequests(requests)[0]?.messages.at(-1)?.content).toContain("[[OPENBOT_SKILL_BEGIN:research-web]]");
    expect(turnRequests(requests)[0]?.system).toContain("autonomously search Skills");
    const transcript = handle.store.getEntries("bot");
    expect(transcript).toContainEqual(expect.objectContaining({ kind: "message", role: "user", content: "pesquise" }));
    expect(JSON.stringify(transcript)).not.toContain("Use the visual browser carefully");

    const commandPrompt = "/skill research-web pesquise o site oficial";
    handle.runner.sendPrompt({ agentId: "bot", prompt: commandPrompt });
    await handle.runner.flush("bot");
    expect(turnRequests(requests)[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("pesquise o site oficial"),
    });
    expect(turnRequests(requests)[1]?.messages.at(-1)?.content).not.toContain(commandPrompt);
    expect(requests.every((request) => ["turn", "memory-reflection", undefined].includes(request.purpose))).toBe(true);
    expect(handle.store.getEntries("bot")).toContainEqual(expect.objectContaining({
      kind: "message",
      role: "user",
      content: commandPrompt,
    }));
  });
});
