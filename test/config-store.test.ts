import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigConflictError,
  ConfigStore,
  defaultConfigPath,
  resolveAgentMcpPolicy,
  resolveAgentSkillPolicy,
} from "../src/config/store.js";
import { MODEL_CATALOG } from "../src/config/models.js";
import { MAX_MCP_RESULT_BYTES, MAX_MCP_TIMEOUT_MS } from "../src/mcp/security.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "openbot-config-"));
  tempDirs.push(dir);
  return join(dir, "openbot-config.json");
}

describe("ConfigStore", () => {
  it("creates and persists the version 1 defaults on first boot", () => {
    const path = configPath();
    const store = new ConfigStore({ configPath: path });

    expect(store.snapshot()).toMatchObject({
      version: 1,
      profile: { name: "OpenBot Local", avatarId: "openbot-default" },
      agents: [],
      activeProvider: "xai",
      globalModel: "grok-4.6",
      compatBaseUrl: null,
      hostSettings: {
        timezone: "America/Sao_Paulo",
        pinnedAgents: [],
        sidebarSections: [],
        autoReviewEnabled: false,
        localToolPermission: "always",
      },
      flags: {
        isAgentNetworkEnabled: false,
        isGlobalSearchEnabled: true,
        isEgressTunnelAvailable: false,
      },
    });
    expect(store.snapshot().profile.machineId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(store.snapshot());
  });

  it("mantém agents vazio ao reabrir uma configuração sem bots", () => {
    const path = configPath();
    const first = new ConfigStore({ configPath: path });

    expect(first.snapshot().agents).toEqual([]);
    expect(new ConfigStore({ configPath: path }).snapshot().agents).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")).agents).toEqual([]);
  });

  it("migra o nome legado do perfil local", () => {
    const path = configPath();
    const fresh = new ConfigStore({ configPath: path }).snapshot();
    writeFileSync(path, JSON.stringify({
      ...fresh,
      profile: { ...fresh.profile, name: "Local User" },
    }));

    expect(new ConfigStore({ configPath: path }).snapshot().profile.name).toBe("OpenBot Local");
  });

  it("migra modelos obsoletos globais e por agente antes da validação", () => {
    const path = configPath();
    const fresh = new ConfigStore({ configPath: path }).snapshot();
    writeFileSync(path, JSON.stringify({
      ...fresh,
      activeProvider: "xai",
      globalModel: "grok-4.5",
      agents: [
        { id: "grok", name: "Grok", avatarId: "a", provider: "xai", model: "grok-4.5" },
        { id: "gpt", name: "GPT", avatarId: "b", provider: "openai", model: "gpt-4.1-mini" },
      ],
    }));

    expect(new ConfigStore({ configPath: path }).snapshot()).toMatchObject({
      activeProvider: "xai",
      globalModel: "grok-4.6",
      agents: [
        { provider: "xai", model: "grok-4.6" },
        { provider: "openai", model: "gpt-5.6-sol" },
      ],
    });

    writeFileSync(path, JSON.stringify({
      ...fresh,
      activeProvider: "openai",
      globalModel: "gpt-4.1",
    }));
    expect(new ConfigStore({ configPath: path }).snapshot()).toMatchObject({
      activeProvider: "openai",
      globalModel: "gpt-5.6-sol",
    });
  });

  it("persists a model change and synchronizes its compatible provider", () => {
    const path = configPath();
    const first = new ConfigStore({ configPath: path });

    first.setGlobalModel("gpt-5.6-terra");

    const reopened = new ConfigStore({ configPath: path });
    expect(reopened.snapshot()).toMatchObject({
      globalModel: "gpt-5.6-terra",
      activeProvider: "openai",
    });
    expect(reopened.snapshot().profile.machineId).toBe(first.snapshot().profile.machineId);
  });

  it("persists the OpenAI-compatible base URL", () => {
    const path = configPath();
    const first = new ConfigStore({ configPath: path });

    first.update({
      globalModel: "openai-compatible",
      activeProvider: "openai-compat",
      compatBaseUrl: "http://127.0.0.1:1234/v1",
    });

    expect(new ConfigStore({ configPath: path }).snapshot()).toMatchObject({
      globalModel: "openai-compatible",
      activeProvider: "openai-compat",
      compatBaseUrl: "http://127.0.0.1:1234/v1",
    });
  });

  it("merges profile and host settings updates without dropping existing fields", () => {
    const path = configPath();
    const first = new ConfigStore({ configPath: path });
    const machineId = first.snapshot().profile.machineId;

    first.update({ profile: { name: "Thiago", avatarId: "avatar-local" } });
    first.setHostSettings({ autoReviewEnabled: true });

    const reopened = new ConfigStore({ configPath: path }).snapshot();
    expect(reopened.profile).toEqual({ name: "Thiago", avatarId: "avatar-local", machineId });
    expect(reopened.hostSettings).toMatchObject({
      timezone: "America/Sao_Paulo",
      pinnedAgents: [],
      sidebarSections: [],
      autoReviewEnabled: true,
      localToolPermission: "always",
    });
  });

  it("preserva patches feitos por instâncias diferentes", () => {
    const path = configPath();
    const first = new ConfigStore({ configPath: path });
    const second = new ConfigStore({ configPath: path });

    first.update({ profile: { name: "Primeira instância" } });
    second.update({ flags: { isAgentNetworkEnabled: true } });

    expect(new ConfigStore({ configPath: path }).snapshot()).toMatchObject({
      profile: { name: "Primeira instância" },
      flags: { isAgentNetworkEnabled: true },
    });
  });

  it("runs collection mutators against the latest locked revision", () => {
    const path = configPath();
    const first = new ConfigStore({ configPath: path });
    const second = new ConfigStore({ configPath: path });

    first.mutate((current) => ({
      agents: [...current.agents, { id: "agent-a", name: "Agent A", avatarId: "a" }],
    }));
    second.mutate((current) => ({
      agents: [...current.agents, { id: "agent-b", name: "Agent B", avatarId: "b" }],
    }));

    const reopened = new ConfigStore({ configPath: path }).snapshot();
    expect(reopened.agents.map((agent) => agent.id)).toEqual(["agent-a", "agent-b"]);
    expect(reopened.revision).toBe(2);
  });

  it("rejects stale compare-and-swap revisions without overwriting newer state", () => {
    const path = configPath();
    const first = new ConfigStore({ configPath: path });
    const second = new ConfigStore({ configPath: path });
    const staleRevision = first.snapshot().revision!;
    second.update({ profile: { name: "newer" } });

    expect(() => first.update(
      { flags: { isAgentNetworkEnabled: true } },
      { expectedRevision: staleRevision },
    )).toThrow(ConfigConflictError);

    expect(new ConfigStore({ configPath: path }).snapshot()).toMatchObject({
      revision: staleRevision + 1,
      profile: { name: "newer" },
      flags: { isAgentNetworkEnabled: false },
    });
  });

  it("persists every catalog model with its compatible provider across reopen", () => {
    const path = configPath();
    const first = new ConfigStore({ configPath: path });
    for (const entry of MODEL_CATALOG) {
      first.setGlobalModel(entry.id);
      const reopened = new ConfigStore({ configPath: path });
      expect(reopened.snapshot()).toMatchObject({ globalModel: entry.id, activeProvider: entry.provider });
    }
  });

  it("rejects unknown models and providers incompatible with the current model", () => {
    const path = configPath();
    const store = new ConfigStore({ configPath: path });

    expect(() => store.setGlobalModel("missing-model")).toThrow(/modelo não suportado/);
    expect(() => store.setActiveProvider("openai")).toThrow(/incompatível/);
    expect(store.snapshot()).toMatchObject({ activeProvider: "xai", globalModel: "grok-4.6" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ activeProvider: "xai", globalModel: "grok-4.6" });
  });

  it("rejects corrupt JSON and unknown config versions during boot", () => {
    const corruptPath = configPath();
    writeFileSync(corruptPath, "{not-json", "utf8");
    expect(() => new ConfigStore({ configPath: corruptPath })).toThrow(/JSON corrompido/);

    const versionPath = configPath();
    writeFileSync(versionPath, JSON.stringify({ version: 2 }), "utf8");
    expect(() => new ConfigStore({ configPath: versionPath })).toThrow(/versão não suportada/);
  });

  it("rejects duplicate and structurally invalid agents", () => {
    const path = configPath();
    const store = new ConfigStore({ configPath: path });
    const agent = { id: "fixture-agent", name: "Fixture", avatarId: "fixture" };
    const invalidUpdates: Array<[string, () => void, RegExp]> = [
      ["exact duplicate agent id", () => store.update({ agents: [agent, { ...agent }] }), /duplicado/],
      ["case-insensitive duplicate agent id", () => store.update({ agents: [agent, { ...agent, id: agent.id.toUpperCase() }] }), /duplicado/],
      ["path traversal agent id", () => store.update({ agents: [{ ...agent, id: "../escape" }] }), /agent.id/],
      ["reserved Windows agent id", () => store.update({ agents: [{ ...agent, id: "con.logs" }] }), /reservado/],
      ["trailing-dot agent id", () => store.update({ agents: [{ ...agent, id: "agent." }] }), /agent.id/],
      ["blank agent title", () => store.update({ agents: [{ ...agent, title: "   " }] }), /agent.title/],
      ["non-string agent title", () => store.update({ agents: [{ ...agent, title: 42 } as never] }), /agent.title/],
      ["oversized agent id", () => store.update({ agents: [{ ...agent, id: `a${"b".repeat(63)}` }] }), /agent.id/],
      ["provider incompatible with model", () => store.update({ agents: [{ ...agent, model: "gpt-5.6-sol", provider: "xai" }] }), /incompatível/],
      ["unsupported agent model", () => store.update({ agents: [{ ...agent, model: "custom-model", provider: "openai" }] }), /não suportado/],
      ["non-HTTP compatible URL", () => store.update({ compatBaseUrl: "file:///tmp/model" }), /http\/https/],
      ["non-loopback compatible URL", () => store.update({ compatBaseUrl: "http://example.com/v1" }), /não-loopback/],
      ["credentials in compatible URL", () => store.update({ compatBaseUrl: "https://user:secret@example.com/v1" }), /credenciais/],
      ["malformed local tool permission", () => store.update({ hostSettings: { localToolPermission: ["never"] } as never }), /localToolPermission/],
    ];

    for (const [label, update, error] of invalidUpdates) {
      expect(update, label).toThrow(error);
    }
  });

  it("rejects oversized or NUL-containing agent identity fields", () => {
    const path = configPath();
    const store = new ConfigStore({ configPath: path });
    const base = { id: "fixture-agent", name: "Fixture", avatarId: "fixture", model: "grok-4.6", provider: "xai" as const };

    expect(() => store.update({ agents: [{ ...base, name: "a".repeat(121) }] })).toThrow(/agent.name/);
    expect(() => store.update({ agents: [{ ...base, name: "a\0b" }] })).toThrow(/agent.name/);
    expect(() => store.update({ agents: [{ ...base, description: "x".repeat(16 * 1024 + 1) }] })).toThrow(/agent.description/);
    expect(() => store.update({ agents: [{ ...base, description: "x\0" }] })).toThrow(/agent.description/);
  });

  it("uses the Windows roaming OpenBot config location by default", () => {
    const previousDataRoot = process.env.OPENBOT_DATA_ROOT;
    const previousAppData = process.env.APPDATA;
    try {
      delete process.env.OPENBOT_DATA_ROOT;
      process.env.APPDATA = "C:\\Users\\fixture\\AppData\\Roaming";
      expect(defaultConfigPath()).toBe("C:\\Users\\fixture\\AppData\\Roaming\\OpenBot\\openbot-config.json");
    } finally {
      if (previousDataRoot === undefined) delete process.env.OPENBOT_DATA_ROOT;
      else process.env.OPENBOT_DATA_ROOT = previousDataRoot;
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
    }
  });

  it("removes atomic temporary files after successful and failed writes", () => {
    const path = configPath();
    const parent = join(path, "..");
    const store = new ConfigStore({ configPath: path });
    store.setHostSettings({ timezone: "UTC" });
    expect(readdirSync(parent).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    rmSync(path);
    mkdirSync(path);
    expect(() => store.setHostSettings({ timezone: "Europe/London" })).toThrow();
    expect(store.snapshot().hostSettings.timezone).toBe("UTC");
    expect(readdirSync(parent).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("applies safe per-agent integration defaults and keeps the policies isolated", () => {
    const path = configPath();
    const store = new ConfigStore({ configPath: path });
    const base = { name: "Bot", avatarId: "bot", model: "grok-4.6", provider: "xai" as const };
    store.update({
      agents: [
        {
          ...base,
          id: "bot-a",
          integrations: {
            skills: { enabled: false, disabledIds: ["research", "research"] },
            mcp: {
              enabled: true,
              serverAllowlist: ["browser", "browser"],
              toolAllowlist: ["browser/search", "browser/search"],
            },
          },
        },
        { ...base, id: "bot-b" },
      ],
      mcpServers: [{ id: "browser", transport: "http", url: "http://127.0.0.1:8787/mcp" }],
    });

    expect(resolveAgentSkillPolicy(store.snapshot(), "bot-a")).toEqual({ enabled: false, disabledIds: ["research"] });
    expect(resolveAgentMcpPolicy(store.snapshot(), "bot-a")).toEqual({
      enabled: true,
      serverAllowlist: ["browser"],
      toolAllowlist: ["browser/search"],
    });
    expect(resolveAgentSkillPolicy(store.snapshot(), "bot-b")).toEqual({ enabled: true, disabledIds: [] });
    expect(resolveAgentMcpPolicy(store.snapshot(), "bot-b")).toEqual({ enabled: false, serverAllowlist: [] });
  });

  it("accepts and strips the removed per-agent WhatsApp preference from legacy configs", () => {
    const path = configPath();
    const store = new ConfigStore({ configPath: path });
    store.update({
      agents: [{
        id: "legacy-bot",
        name: "Legacy",
        avatarId: "legacy",
        model: "grok-4.6",
        provider: "xai",
        integrations: { whatsapp: { enabled: false } },
      } as never],
    });

    expect(store.snapshot().agents[0]?.integrations).toBeUndefined();
    expect(readFileSync(path, "utf8")).not.toContain('"whatsapp"');
  });

  it("loads a pre-integration config without rewriting it", () => {
    const path = configPath();
    const original = new ConfigStore({ configPath: path });
    const before = readFileSync(path, "utf8");
    const reopened = new ConfigStore({ configPath: path });

    expect(reopened.snapshot().mcpServers).toBeUndefined();
    expect(reopened.snapshot().agents).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(() => resolveAgentMcpPolicy(reopened.snapshot(), "missing")).toThrow(/agente não encontrado/);
    expect(original.snapshot().version).toBe(1);
  });

  it("preserves shared MCP servers when an update omits the field", () => {
    const path = configPath();
    const store = new ConfigStore({ configPath: path });
    const server = { id: "browser", transport: "http" as const, url: "http://127.0.0.1:8787/mcp" };
    store.update({ mcpServers: [server] });
    store.update({ flags: { isAgentNetworkEnabled: true } });

    expect(new ConfigStore({ configPath: path }).snapshot().mcpServers).toEqual([server]);
  });

  it("persiste sessionScope agent e mantém shared como default compatível", () => {
    const path = configPath();
    const store = new ConfigStore({ configPath: path });
    store.update({
      mcpServers: [
        { id: "stateful", transport: "http", url: "http://127.0.0.1:8787/mcp", sessionScope: "agent" },
        { id: "stateless", transport: "http", url: "http://127.0.0.1:8788/mcp" },
      ],
    });

    expect(new ConfigStore({ configPath: path }).snapshot().mcpServers).toEqual([
      expect.objectContaining({ id: "stateful", sessionScope: "agent" }),
      { id: "stateless", transport: "http", url: "http://127.0.0.1:8788/mcp" },
    ]);
  });

  it("rejects inline secrets, malformed transports, duplicate servers and invalid policy references", () => {
    const path = configPath();
    const store = new ConfigStore({ configPath: path });
    const base = { id: "bot-a", name: "Bot", avatarId: "bot", model: "grok-4.6", provider: "xai" as const };

    expect(() => store.update({ mcpServers: [{ id: "inline", transport: "http", url: "https://example.com/mcp", headers: { authorization: "Bearer secret" } } as never] })).toThrow(/secretRef/);
    expect(() => store.update({ mcpServers: [{ id: "empty", transport: "http", url: "https://example.com/mcp", headers: { authorization: { secretRef: " " } } } as never] })).toThrow(/secretRef/);
    expect(() => store.update({ mcpServers: [{ id: "wrong", transport: "ftp", url: "https://example.com/mcp" } as never] })).toThrow(/transport/);
    expect(() => store.update({ mcpServers: [{ id: "bad-url", transport: "http", url: "http://example.com/mcp" } as never] })).toThrow(/url/);
    expect(() => store.update({ mcpServers: [{ id: "scope", transport: "http", url: "https://example.com/mcp", sessionScope: "session" } as never] })).toThrow(/sessionScope/);
    expect(() => store.update({ mcpServers: [{ id: "query-secret", transport: "http", url: "https://example.com/mcp?token=inline" }] })).toThrow(/url/);
    expect(() => store.update({ mcpServers: [
      { id: "same", transport: "http", url: "https://example.com/mcp" },
      { id: "same", transport: "http", url: "http://127.0.0.1:8788/mcp" },
    ] })).toThrow(/duplicado/);
    expect(() => store.update({
      mcpServers: [{ id: "known", transport: "http", url: "http://127.0.0.1:8787/mcp" }],
      agents: [{ ...base, integrations: { mcp: { enabled: true, serverAllowlist: ["missing"] } } }],
    })).toThrow(/servidor desconhecido/);
  });

  it("validates stdio command fields and rejects hidden inline environment values", () => {
    const path = configPath();
    const store = new ConfigStore({ configPath: path });

    expect(() => store.update({ mcpServers: [{ id: "runner", transport: "stdio", command: "node", cwd: "", args: [] }] })).toThrow(/cwd/);
    expect(() => store.update({ mcpServers: [{ id: "runner", transport: "stdio", command: "node", cwd: "C:\\OpenBot", args: ["" ] }] })).toThrow(/args/);
    expect(() => store.update({ mcpServers: [{ id: "runner", transport: "stdio", command: "node", cwd: "C:\\OpenBot", env: { TOKEN: "inline" } } as never] })).toThrow(/secretRef/);
  });

  it("rejects MCP values above the manager hard limits before persistence", () => {
    const path = configPath();
    const store = new ConfigStore({ configPath: path });
    expect(() => store.update({ mcpServers: [{ id: "slow", transport: "http", url: "http://127.0.0.1:8787/mcp", timeoutMs: MAX_MCP_TIMEOUT_MS + 1 }] })).toThrow(/timeoutMs/);
    expect(() => store.update({ mcpServers: [{ id: "large", transport: "http", url: "http://127.0.0.1:8787/mcp", maxResultBytes: MAX_MCP_RESULT_BYTES + 1 }] })).toThrow(/maxResultBytes/);
  });
});
