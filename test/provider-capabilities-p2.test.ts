import { describe, expect, it } from "vitest";

type Capability = {
  streaming: boolean;
  tools: boolean;
  images: boolean;
  cancellation: "abort-signal" | "process-tree" | "none";
  authentication: "keystore-api-key" | "external-cli-session" | "none";
  usage: "stream-events" | "response-metadata" | "none";
  resume: "cursor" | "none";
  reasoning: boolean;
};

type CapabilitiesModule = {
  resolveProviderCapabilities(provider: string, model?: string): Capability;
  registerOptionalProviders(options: { registry: unknown; enabled?: readonly string[]; credentials?: unknown }): readonly string[];
};

async function loadCapabilities(): Promise<CapabilitiesModule | null> {
  const moduleName = "../src/providers/capabilities.js";
  try {
    return await import(moduleName);
  } catch {
    return null;
  }
}

describe("P2.5 RED — capability matrix and optional registration", () => {
  it("exports the complete capabilities for each known optional provider pair", async () => {
    const module = await loadCapabilities();
    expect(module, "P2.5 RED: src/providers/capabilities.ts is not implemented").not.toBeNull();
    if (module === null) return;

    const expected = [
      ["openrouter", "openrouter/auto", { streaming: true, tools: true, images: true, cancellation: "abort-signal", authentication: "keystore-api-key", usage: "stream-events", resume: "none", reasoning: false }],
      ["codex-cli", "codex-cli:default", { streaming: true, tools: true, images: false, cancellation: "process-tree", authentication: "external-cli-session", usage: "stream-events", resume: "none", reasoning: false }],
      ["claude-code", "claude-code:default", { streaming: true, tools: true, images: false, cancellation: "process-tree", authentication: "external-cli-session", usage: "stream-events", resume: "none", reasoning: false }],
      ["opencode-go", "opencode-go/minimax-m3", { streaming: true, tools: true, images: true, cancellation: "abort-signal", authentication: "keystore-api-key", usage: "stream-events", resume: "none", reasoning: false }],
    ] as const;
    for (const [provider, model, capability] of expected) {
      expect(module.resolveProviderCapabilities(provider, model)).toEqual(capability);
    }
  });

  it("fails closed for unknown providers and unknown model capabilities", async () => {
    const module = await loadCapabilities();
    expect(module, "P2.5 RED: capability resolver is missing").not.toBeNull();
    if (module === null) return;

    const capability = module.resolveProviderCapabilities("provider-that-does-not-exist", "model-that-does-not-exist");
    expect(capability).toEqual({
      streaming: false,
      tools: false,
      images: false,
      cancellation: "none",
      authentication: "none",
      usage: "none",
      resume: "none",
      reasoning: false,
    });

    const unknownModel = module.resolveProviderCapabilities("openrouter", "model-that-is-not-in-the-catalog");
    expect(unknownModel).toEqual({
      streaming: false,
      tools: false,
      images: false,
      cancellation: "none",
      authentication: "none",
      usage: "none",
      resume: "none",
      reasoning: false,
    });
  });

  it("does not register optional providers by default", async () => {
    const module = await loadCapabilities();
    expect(module, "P2.5 RED: optional registration boundary is missing").not.toBeNull();
    if (module === null) return;

    const names = module.registerOptionalProviders({ registry: { register() {} } });
    expect(names).toEqual([]);
  });

  it("rejects enabled providers without valid scoped opaque credentials", async () => {
    const module = await loadCapabilities();
    expect(module, "P2.5 RED: optional registration boundary is missing").not.toBeNull();
    if (module === null) return;

    const registrations: string[] = [];
    const registry = { register(adapter: { name: string }) { registrations.push(adapter.name); } };
    expect(module.registerOptionalProviders({
      registry,
      enabled: ["openrouter"],
      credentials: { openrouter: { scope: "agent-a" } },
    })).toEqual([]);
    expect(registrations).toEqual([]);
  });

  it("registers only explicitly enabled providers with a valid config and opaque ref", async () => {
    const module = await loadCapabilities();
    expect(module, "P2.5 RED: optional registration boundary is missing").not.toBeNull();
    if (module === null) return;

    const registrations: string[] = [];
    const registry = { register(adapter: { name: string }) { registrations.push(adapter.name); } };
    const names = module.registerOptionalProviders({
      registry,
      enabled: ["openrouter"],
      credentials: { openrouter: { scope: "agent-a", ref: "openrouter:key:fixture-v1" } },
    });
    expect(names).toContain("openrouter");
    expect(registrations).toContain("openrouter");
  });
});
