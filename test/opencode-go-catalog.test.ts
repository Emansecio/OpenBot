import { describe, expect, it, vi } from "vitest";

import { availableModelCatalog } from "../src/rpc/roster.js";
import { createProviderRegistry } from "../src/providers/router.js";

describe("OpenCode Go live catalog", () => {
  it("shows only models confirmed by live discovery", async () => {
    const registry = createProviderRegistry();
    registry.register({
      name: "opencode-go",
      discoverModels: async () => ["glm-5.3", "minimax-m3"],
      streamChat: async () => undefined,
    } as never);

    const models = await availableModelCatalog(registry);

    expect(models.filter((model) => model.provider === "opencode-go").map((model) => model.id)).toEqual([
      "opencode-go/glm-5.3",
      "opencode-go/minimax-m3",
    ]);
  });

  it("hides the provider catalog when discovery fails", async () => {
    const registry = createProviderRegistry();
    registry.register({
      name: "opencode-go",
      discoverModels: async () => { throw new Error("offline"); },
      streamChat: async () => undefined,
    } as never);

    expect((await availableModelCatalog(registry)).some((model) => model.provider === "opencode-go")).toBe(false);
  });

  it("deduplicates concurrent discovery and reuses the short-lived catalog cache", async () => {
    const registry = createProviderRegistry();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const discoverModels = vi.fn(async () => {
      await pending;
      return ["glm-5.3"];
    });
    registry.register({ name: "opencode-go", discoverModels, streamChat: async () => undefined } as never);

    const first = availableModelCatalog(registry);
    const second = availableModelCatalog(registry);
    release();
    await Promise.all([first, second]);
    await availableModelCatalog(registry);

    expect(discoverModels).toHaveBeenCalledTimes(1);
  });
});
