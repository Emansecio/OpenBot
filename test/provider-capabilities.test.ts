import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../src/config/store.js";
import { CLOSED_CAPABILITY, resolveProviderCapabilities } from "../src/providers/capabilities.js";
import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { TempRoots } from "./helpers/temp-roots.js";

const temp = new TempRoots();
const handles: ServerHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  await temp.cleanup();
});

const STREAMING = { streaming: true, tools: true, cancellation: "abort-signal", authentication: "keystore-api-key", usage: "stream-events", reasoning: false } as const;

describe("provider capability matrix", () => {
  it("exports the complete capabilities for each known provider pair", () => {
    const expected = [
      ["openai", "gpt-5.6-luna", { ...STREAMING, images: true }],
      ["openai", "gpt-5.6-sol", { ...STREAMING, images: false }],
      ["xai", "grok-4.6", { ...STREAMING, images: true }],
      ["openai-compat", "any-discovered-model", { ...STREAMING, images: false }],
      ["opencode-go", "opencode-go/minimax-m3", { ...STREAMING, images: true }],
    ] as const;
    for (const [provider, model, capability] of expected) {
      expect(resolveProviderCapabilities(provider, model), `${provider}/${model}`).toEqual(capability);
    }
  });

  it("fails closed for unknown providers, unknown models and missing models", () => {
    const closed = { streaming: false, tools: false, images: false, cancellation: "none", authentication: "none", usage: "none", reasoning: false };
    expect(CLOSED_CAPABILITY).toEqual(closed);
    expect(resolveProviderCapabilities("provider-that-does-not-exist", "model-that-does-not-exist")).toEqual(closed);
    expect(resolveProviderCapabilities("openai", "model-that-is-not-in-the-matrix")).toEqual(closed);
    expect(resolveProviderCapabilities("xai")).toEqual(closed);
    // Removed optional providers no longer resolve to anything but the closed capability.
    for (const provider of ["openrouter", "codex-cli", "claude-code"]) {
      expect(resolveProviderCapabilities(provider, `${provider}:default`)).toEqual(closed);
    }
  });
});

describe("removed optional providers and the matrix boundary", () => {
  it("legacy optionalProviders key is tolerated on load and stripped on persist", () => {
    const root = temp.make("openbot-p25-config-");
    const configPath = join(root, "config.json");
    const store = new ConfigStore({ configPath });
    const seeded = { ...store.snapshot(), optionalProviders: { openrouter: { enabled: true, credentialRef: "openrouter:key:fixture-v1" } } };
    writeFileSync(configPath, JSON.stringify(seeded));

    const reloaded = new ConfigStore({ configPath });
    // The removed surface is not revived: the key loads tolerantly and is
    // absent from the snapshot and from the next persisted write.
    expect(reloaded.snapshot()).not.toHaveProperty("optionalProviders");
    reloaded.update({ flags: {} });
    const onDisk = readFileSync(configPath, "utf8");
    expect(onDisk).not.toContain("optionalProviders");
    expect(onDisk).not.toContain("openrouter:key:fixture-v1");
  });

  it("bootstrap never registers optional providers, even from legacy config", async () => {
    const defaultRoot = temp.make("openbot-p25-boot-default-");
    const defaultHandle = await startServer(0, {
      configPath: join(defaultRoot, "config.json"), stateRoot: join(defaultRoot, "state"), runtimeRoot: join(defaultRoot, "runtime"),
      browserRoot: join(defaultRoot, "browser"), keystoreDir: join(defaultRoot, "keystore"), storePath: join(defaultRoot, "store.db"),
      allowUnauthenticatedLocalGateway: true,
    });
    handles.push(defaultHandle);
    expect(defaultHandle.registry.names()).not.toContain("openrouter");
    expect(defaultHandle.registry.names()).not.toContain("codex-cli");
    expect(defaultHandle.registry.names()).not.toContain("claude-code");

    // A legacy config that still carries the removed optionalProviders key
    // loads tolerantly but never registers the inert providers.
    const configuredRoot = temp.make("openbot-p25-boot-configured-");
    const configPath = join(configuredRoot, "config.json");
    const config = new ConfigStore({ configPath });
    writeFileSync(configPath, JSON.stringify({
      ...config.snapshot(),
      optionalProviders: {
        openrouter: { enabled: true, scope: "agent-a", credentialRef: "openrouter:key:fixture-v1" },
        "codex-cli": { enabled: true, scope: "agent-a", sessionRef: "cli:session:fixture-v1", executable: "node", args: ["-e", "1"], cwd: configuredRoot },
        "claude-code": { enabled: true, scope: "agent-a" },
      },
    }));
    const configuredHandle = await startServer(0, {
      configPath,
      stateRoot: join(configuredRoot, "state"), runtimeRoot: join(configuredRoot, "runtime"),
      browserRoot: join(configuredRoot, "browser"), keystoreDir: join(configuredRoot, "keystore"), storePath: join(configuredRoot, "store.db"),
      allowUnauthenticatedLocalGateway: true,
    });
    handles.push(configuredHandle);
    expect(configuredHandle.registry.names()).not.toContain("openrouter");
    expect(configuredHandle.registry.names()).not.toContain("codex-cli");
    expect(configuredHandle.registry.names()).not.toContain("claude-code");
  });

  it("the capability matrix never imports child_process, spawns or reads process.env", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const source = readFileSync(join(root, "src/providers/capabilities.ts"), "utf8");
    expect(source).not.toMatch(/node:child_process/u);
    expect(source).not.toContain("spawn(");
    expect(source).not.toMatch(/CODEX_AUTH_TOKEN|process.env/);
  });
});
