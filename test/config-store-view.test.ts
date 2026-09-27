import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../src/config/store.js";
import { ModelCatalogService } from "../src/providers/model-catalog.js";
import { TempRoots } from "./helpers/temp-roots.js";

const temp = new TempRoots();

afterEach(async () => {
  await temp.cleanup();
});

function configPath(): string {
  return join(temp.make("openbot-config-view-"), "openbot-config.json");
}

const agent = (id: string) => ({ id, name: id, avatarId: "default" });

describe("ConfigStore read views", () => {
  it("exposes a frozen shared view and keeps snapshots independent", () => {
    const store = new ConfigStore({ configPath: configPath() });
    store.update({ agents: [agent("alpha"), agent("beta")] });

    const view = store.view();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.agents[0])).toBe(true);
    expect(() => { (view.agents as unknown[]).push(agent("gamma")); }).toThrow(TypeError);
    expect(store.view()).toBe(view);

    const copy = store.snapshot();
    copy.agents.push(agent("gamma"));
    expect(store.agentIds()).toEqual(["alpha", "beta"]);
    expect(store.hasAgent("beta")).toBe(true);
    expect(store.hasAgent("gamma")).toBe(false);
  });

  it("replaces the view on commit", () => {
    const store = new ConfigStore({ configPath: configPath() });
    const before = store.view();
    store.update({ agents: [agent("alpha")] });
    expect(store.view()).not.toBe(before);
    expect(before.agents).toEqual([]);
    expect(store.agentIds()).toEqual(["alpha"]);
  });

  it("commits on top of an external write instead of the stale in-memory state", () => {
    const path = configPath();
    const first = new ConfigStore({ configPath: path });
    const second = new ConfigStore({ configPath: path });

    second.update({ profile: { name: "Outro processo" } });
    first.update({ agents: [agent("alpha")] });

    const reopened = new ConfigStore({ configPath: path }).snapshot();
    expect(reopened.profile.name).toBe("Outro processo");
    expect(reopened.agents.map((entry) => entry.id)).toEqual(["alpha"]);
    expect(reopened.revision).toBe(2);
  });

  it("names the file and keeps the cause when the config JSON is corrupt", () => {
    const path = configPath();
    new ConfigStore({ configPath: path });
    writeFileSync(path, "{not json");
    let error: unknown;
    try { new ConfigStore({ configPath: path }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(path);
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
  });
});

describe("ConfigStore Fast (priority) validation", () => {
  it("accepts Fast for an agent inheriting a discovered OpenAI model and still loads it on reboot", async () => {
    const path = configPath();
    const catalog = new ModelCatalogService({ sources: { openai: {
      connectionKey: async () => "a".repeat(64),
      discover: async () => [{ id: "gpt-6-astra", serviceTiers: ["priority"], supportedReasoningEfforts: ["medium", "high"] }],
    } } });
    try {
      await catalog.get("openai");
      const store = new ConfigStore({ configPath: path, allowUnverifiedModels: true });
      store.modelCatalog = catalog;
      store.update({ activeProvider: "openai", globalModel: "gpt-6-astra", globalReasoningEffort: "medium" });

      store.update({ agents: [{ ...agent("alpha"), serviceTier: "priority" }] });

      const reopened = new ConfigStore({ configPath: path, allowUnverifiedModels: true });
      expect(reopened.snapshot().agents).toMatchObject([{ id: "alpha", serviceTier: "priority" }]);
    } finally {
      catalog.close();
    }
  });

  it("still rejects Fast for a statically known non-OpenAI model", () => {
    const store = new ConfigStore({ configPath: configPath() });
    expect(() => store.update({ agents: [{ ...agent("alpha"), serviceTier: "priority" }] }))
      .toThrow(/Fast requer um modelo OpenAI/);
  });
});
