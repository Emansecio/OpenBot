import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../src/config/store.js";
import { resolveProviderCapabilities, registerOptionalProviders } from "../src/providers/capabilities.js";
import { OpenRouterAdapter, createCliProviderAdapter } from "../src/providers/optional-adapters.js";
import { ProviderError, type ProviderAdapter,createProviderRegistry } from "../src/providers/router.js";
import { startServer, stopServer, type ServerHandle } from "../src/main.js";

const roots: string[] = [];
const handles: ServerHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function processResult(stdout: string, stderr = "", exitCode = 0) {
  return { ok: true, operation: "process.run", stdout, stderr, exitCode, durationMs: 1, stdoutTruncated: false, stderrTruncated: false };
}

describe("P2.5 supplement — capability matrix negatives and production boundaries", () => {
  it("fails closed per feature for unknown providers/models and exposes known pairs", () => {
    const unknown = resolveProviderCapabilities("does-not-exist", "any-model");
    expect(unknown).toEqual({ streaming: false, tools: false, images: false, cancellation: "none", authentication: "none", usage: "none", resume: "none", reasoning: false });
    const unknownModel = resolveProviderCapabilities("openrouter", "not-in-the-matrix");
    expect(unknownModel.streaming).toBe(false);
    expect(unknownModel.images).toBe(false);
    expect(unknownModel.resume).toBe("none");
    const known = resolveProviderCapabilities("openrouter", "openrouter-small");
    expect(known).toEqual({ streaming: true, tools: true, images: false, cancellation: "abort-signal", authentication: "keystore-api-key", usage: "stream-events", resume: "none", reasoning: false });
    const cli = resolveProviderCapabilities("codex-cli", "codex-cli:default");
    expect(cli.cancellation).toBe("process-tree");
    expect(cli.authentication).toBe("external-cli-session");
  });

  it("resume is never advertised as cursor (P2.6 is not implemented)", () => {
    const knownPairs = [
      ["openai", "gpt-5.6-luna"],
      ["openai", "gpt-5.6-sol"],
      ["openai", "gpt-5.6-terra"],
      ["xai", "grok-4.6"],
      ["openai-compat", "openai-compatible"],
      ["openrouter", "openrouter-small"],
      ["openrouter", "openrouter/auto"],
      ["codex-cli", "codex-cli:default"],
      ["claude-code", "claude-code:default"],
    ] as const;
    for (const [provider, model] of knownPairs) {
      expect(resolveProviderCapabilities(provider, model).resume, `${provider}/${model}`).toBe("none");
    }
  });

  it("registerOptionalProviders never registers partial CLI providers", () => {
    const registered: string[] = [];
    const registry = { register(adapter: { name: string }) { registered.push(adapter.name); } };
    const names = registerOptionalProviders({
      registry,
      enabled: ["codex-cli", "claude-code", "openrouter"],
      credentials: {
        "codex-cli": { scope: "agent-a", ref: "cli:session:fixture-v1" },
        "claude-code": { scope: "agent-a", ref: "cli:session:fixture-v1" },
        openrouter: { scope: "agent-a", ref: "openrouter:key:fixture-v1" },
      },
      adapterOptions: { openrouter: { resolveCredential: async () => "x" } },
    });
    // CLI providers are skipped without the local execution broker; openrouter registers.
    expect(names).toEqual(["openrouter"]);
    expect(registered).toEqual(["openrouter"]);
  });

  it("registerOptionalProviders registers CLI providers when the broker is provided", () => {
    const registered: string[] = [];
    const broker = { execute: async () => processResult("") };
    const names = registerOptionalProviders({
      registry: { register(adapter: { name: string }) { registered.push(adapter.name); } },
      enabled: ["codex-cli"],
      credentials: { "codex-cli": { scope: "agent-a", ref: "cli:session:fixture-v1" } },
      execution: { "codex-cli": { executable: "node", args: ["-e", "1"], cwd: ".", executionBroker: broker as never } },
      adapterOptions: { "codex-cli": { resolveSession: async () => ({ protocol: "codex-cli.v1" }) } },
    });
    expect(names).toEqual(["codex-cli"]);
    expect(registered).toEqual(["codex-cli"]);
  });

  it("createCliProviderAdapter fails closed without the required execution broker", () => {
    expect(() => createCliProviderAdapter({ provider: "codex-cli", executable: "node", args: [], cwd: "." } as never)).toThrow(ProviderError);
    expect(() => createCliProviderAdapter({ provider: "mystery-cli", executable: "node", args: [], cwd: "." } as never)).toThrow(ProviderError);
  });

  it("persisted optional provider config stores only opaque references, never secret values", () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-p25-config-"));
    roots.push(root);
    const secret = "sk-fixture-super-secret-value";
    const store = new ConfigStore({ configPath: join(root, "config.json") });
    store.update({ optionalProviders: {
      openrouter: {
        enabled: true,
        scope: "agent-a",
        credentialRef: "openrouter:key:fixture-v1",
        endpoint: "https://openrouter.example/api/v1",
        secret,
      } as never,
    } });
    const onDisk = readFileSync(join(root, "config.json"), "utf8");
    expect(onDisk).not.toContain(secret);
    expect(onDisk).toContain('"credentialRef": "openrouter:key:fixture-v1"');
    expect(store.snapshot().optionalProviders?.openrouter).toMatchObject({ enabled: true, credentialRef: "openrouter:key:fixture-v1" });
    expect(store.snapshot().optionalProviders?.openrouter).not.toHaveProperty("secret");
    // Only the known optional providers are accepted; an unknown key is rejected.
    expect(() => store.update({ optionalProviders: { "mystery-provider": { enabled: true } } as never })).toThrow(/config inválida/);
    store.close();
  });

  it("bootstrap registers routable optional providers and defers CLI providers without persisted routing", async () => {
    const defaultRoot = mkdtempSync(join(tmpdir(), "openbot-p25-boot-default-"));
    roots.push(defaultRoot);
    const defaultHandle = await startServer(0, {
      configPath: join(defaultRoot, "config.json"), stateRoot: join(defaultRoot, "state"), runtimeRoot: join(defaultRoot, "runtime"),
      browserRoot: join(defaultRoot, "browser"), keystoreDir: join(defaultRoot, "keystore"), storePath: join(defaultRoot, "store.db"),
      allowUnauthenticatedLocalGateway: true,
    });
    handles.push(defaultHandle);
    expect(defaultHandle.registry.names()).not.toContain("openrouter");
    expect(defaultHandle.registry.names()).not.toContain("codex-cli");
    expect(defaultHandle.registry.names()).not.toContain("claude-code");

    const configuredRoot = mkdtempSync(join(tmpdir(), "openbot-p25-boot-configured-"));
    roots.push(configuredRoot);
    const configPath = join(configuredRoot, "config.json");
    const config = new ConfigStore({ configPath });
    config.update({ optionalProviders: {
      openrouter: { enabled: true, scope: "agent-a", credentialRef: "openrouter:key:fixture-v1" },
      "codex-cli": {
        enabled: true,
        scope: "agent-a",
        sessionRef: "cli:session:fixture-v1",
        executable: "node",
        args: ["-e", "1"],
        cwd: configuredRoot,
      },
      "claude-code": { enabled: true, scope: "agent-a" },
    } });
    config.close();
    const configuredHandle = await startServer(0, {
      configPath,
      stateRoot: join(configuredRoot, "state"), runtimeRoot: join(configuredRoot, "runtime"),
      browserRoot: join(configuredRoot, "browser"), keystoreDir: join(configuredRoot, "keystore"), storePath: join(configuredRoot, "store.db"),
      allowUnauthenticatedLocalGateway: true,
    });
    handles.push(configuredHandle);
    expect(configuredHandle.registry.names()).toContain("openrouter");
    expect(configuredHandle.registry.names()).not.toContain("codex-cli");
    expect(configuredHandle.registry.names()).not.toContain("claude-code");
  });

  it("the optional adapter sources never import child_process or spawn directly", async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    for (const file of ["src/providers/optional-adapters.ts", "src/providers/capabilities.ts"]) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source).not.toMatch(/node:child_process/u);
      expect(source).not.toContain("spawn(");
      expect(source).not.toMatch(/CODEX_AUTH_TOKEN|process.env/);
    }
  });
});

describe("P2.5 supplement — CLI lifecycle, shutdown and registry", () => {
  it("propagates adapter close() to an in-flight broker execution", async () => {
    let aborted = false;
    const broker = {
      execute: async (_agentId: string, _requestId: string, _request: unknown, signal?: AbortSignal) => {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
        });
        return { ok: false, operation: "process.run", code: "process_aborted", message: "stopped" };
      },
    };
    const adapter = createCliProviderAdapter({
      provider: "codex-cli", agentId: "agent-a", sessionRef: "cli:session:fixture-v1",
      resolveSession: async () => ({ protocol: "codex-cli.v1" }),
      executable: "node", args: ["-e", "1"], executionBroker: broker as never, cwd: ".",
    });
    const pending = adapter.streamChat({ model: "codex-cli:default", messages: [{ role: "user", content: "hi" }] }, () => undefined).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    adapter.close?.();
    await pending;
    expect(aborted).toBe(true);
  });

  it("adapter backstop timeout rejects timed_out when the broker never settles", async () => {
    const broker = { execute: async () => new Promise<never>(() => undefined) };
    const adapter = createCliProviderAdapter({
      provider: "claude-code", agentId: "agent-a", sessionRef: "cli:session:fixture-v1",
      resolveSession: async () => ({ protocol: "claude-code.v1" }),
      executable: "node", args: ["-e", "1"], executionBroker: broker, cwd: ".", timeoutMs: 40,
    });
    await expect(adapter.streamChat({ model: "claude-code:default", messages: [{ role: "user", content: "hi" }] }, () => undefined))
      .rejects.toMatchObject({ code: "timed_out" });
  });

  it("resolves and scopes the opaque session before touching the broker", async () => {
    const calls: Array<{ ref: string; scope: { agentId: string } }> = [];
    const protocolOut = "{\"protocol\":\"claude-code.v1\",\"sequence\":1,\"type\":\"session\",\"sessionId\":\"s\"}\n{\"protocol\":\"claude-code.v1\",\"sequence\":2,\"type\":\"done\",\"cursor\":\"c\"}\n";
    const broker = { execute: async () => processResult(protocolOut) };
    const adapter = createCliProviderAdapter({
      provider: "claude-code", agentId: "agent-a", sessionRef: "cli:session:fixture-v1",
      resolveSession: async (ref, scope) => { calls.push({ ref: String(ref), scope: { agentId: String(scope.agentId) } }); return { protocol: "claude-code.v1" }; },
      executable: "node", args: ["-e", "1"], executionBroker: broker as never, cwd: ".",
    });
    await adapter.streamChat({ model: "claude-code:default", messages: [{ role: "user", content: "hi" }] }, () => undefined);
    expect(calls).toEqual([{ ref: "cli:session:fixture-v1", scope: { agentId: "agent-a" } }]);
  });

  it("wraps only the router API surface and keeps ProviderError shapes stable", async () => {
    const publicSurface: Record<keyof OpenRouterAdapter, true> = {
      name: true,
      serializeRequest: true,
      streamChat: true,
      close: true,
    };
    expect(Object.keys(publicSurface).sort()).toEqual(["close", "name", "serializeRequest", "streamChat"]);
    const adapter = new OpenRouterAdapter({ name: "openrouter", resolveCredential: async () => "x" });
    expect(adapter.name).toBe("openrouter");
    expect(typeof adapter.streamChat).toBe("function");
    expect(typeof adapter.close).toBe("function");
    const error = await adapter.streamChat({ model: "openrouter-small", messages: [{ role: "user", content: "hi" }] }, () => undefined)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "auth", status: 401, retryable: false, code: "auth" });
  });

  it("registry can hold the optional adapters without affecting existing providers", () => {
    const registry = createProviderRegistry();
    const existing: ProviderAdapter = {
      name: "existing",
      async streamChat() { /* fixture */ },
    };
    registry.register(existing);
    registry.register(new OpenRouterAdapter({ name: "openrouter", resolveCredential: async () => "x" }));
    expect(registry.names()).toEqual(["existing", "openrouter"]);
    expect(registry.get("existing")).toBe(existing);
    registry.unregister("openrouter");
    expect(registry.names()).toEqual(["existing"]);
    expect(registry.get("existing")).toBe(existing);
  });
});
