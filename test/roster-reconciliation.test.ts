import { cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigStore } from "../src/config/store.js";
import { AgentHomeStore } from "../src/execution/home.js";
import { WorkspaceQuotaError } from "../src/execution/quota.js";
import { registerRosterHandlers } from "../src/rpc/roster.js";
import { reconcileRosterHomes } from "../src/rpc/roster-reconciliation.js";
import { createGateway } from "../src/server/gateway.js";
import { createProviderRegistry } from "../src/providers/router.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function configFor(root: string, agents: Array<{ id: string; name: string }>): Promise<ConfigStore> {
  const config = new ConfigStore({ configPath: join(root, "config.json") });
  const now = Date.now();
  config.update({
    agents: agents.map((agent) => ({ ...agent, avatarId: agent.id, createdAt: now, updatedAt: now })),
  });
  return config;
}

describe("roster/home reconciliation", () => {
  it("restores a roster agent whose home was quarantined and is idempotent", async () => {
    const root = await tempRoot("openbot-roster-reconcile-");
    const config = await configFor(root, [{ id: "recoverable", name: "Recoverable" }]);
    const homes = await AgentHomeStore.create(join(root, "workspaces"));
    const home = await homes.ensure("recoverable");
    await writeFile(join(home.root, "Documents", "keep.txt"), "keep");
    await homes.remove("recoverable");

    const restartedHomes = await AgentHomeStore.create(homes.root);
    const first = await reconcileRosterHomes(config, restartedHomes);
    expect(first.restored).toEqual(["recoverable"]);
    expect(first.quarantined).toEqual([]);
    expect(await readFile(join(restartedHomes.pathFor("recoverable"), "Documents", "keep.txt"), "utf8")).toBe("keep");
    expect(await restartedHomes.listQuarantine()).toEqual([]);

    const second = await reconcileRosterHomes(config, restartedHomes);
    expect(second).toMatchObject({ restored: [], quarantined: [], created: [], pending: [] });
  });

  it("quarantines an active home left by a crashed creation without deleting data", async () => {
    const root = await tempRoot("openbot-roster-reconcile-orphan-");
    const config = await configFor(root, []);
    const homes = await AgentHomeStore.create(join(root, "workspaces"));
    const home = await homes.ensure("orphan");
    await writeFile(join(home.root, "Documents", "keep.txt"), "keep");

    const result = await reconcileRosterHomes(config, homes);
    expect(result.quarantined).toEqual(["orphan"]);
    expect(await homes.inventory()).toEqual([]);
    const quarantine = (await homes.listQuarantine()).find((entry) => entry.agentId === "orphan");
    expect(quarantine).toBeDefined();
    expect(await readFile(join(quarantine!.root, "Documents", "keep.txt"), "utf8")).toBe("keep");

    const second = await reconcileRosterHomes(config, homes);
    expect(second).toMatchObject({ restored: [], quarantined: [], created: [], pending: [] });
    expect(await readdir(homes.quarantineRoot)).toHaveLength(1);
  });

  it("quarentena orphan no recovery sem usar o remove com inventário profundo", async () => {
    const root = await tempRoot("openbot-roster-reconcile-orphan-lightweight-");
    const config = await configFor(root, []);
    const homes = await AgentHomeStore.create(join(root, "workspaces"));
    const home = await homes.ensure("orphan-lightweight");
    await writeFile(join(home.root, "Documents", "keep.txt"), "keep");
    vi.spyOn(homes, "remove").mockRejectedValue(new Error("deep remove must not run during recovery"));

    await expect(reconcileRosterHomes(config, homes)).resolves.toMatchObject({ quarantined: ["orphan-lightweight"] });
    await expect(lstat(home.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detecta quarantines duplicadas no recovery sem inventariar seu conteúdo", async () => {
    const root = await tempRoot("openbot-roster-reconcile-quarantine-lightweight-");
    const config = await configFor(root, [{ id: "duplicated", name: "Duplicated" }]);
    const homes = await AgentHomeStore.create(join(root, "workspaces"));
    await homes.ensure("duplicated");
    await homes.remove("duplicated");
    const firstId = (await readdir(homes.quarantineRoot))[0];
    const secondId = "duplicated-9999999999999-00000000-0000-4000-8000-000000000000";
    const secondRoot = join(homes.quarantineRoot, secondId);
    await cp(join(homes.quarantineRoot, firstId!), secondRoot, { recursive: true });
    const markerPath = join(secondRoot, ".openbot", "quarantine.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    await writeFile(markerPath, `${JSON.stringify({ ...marker, quarantineId: secondId }, null, 2)}\n`);
    vi.spyOn(homes, "listQuarantine").mockRejectedValue(new Error("deep quarantine inventory must not run during recovery"));

    await expect(reconcileRosterHomes(config, homes)).resolves.toMatchObject({
      pending: [{ agentId: "duplicated", reason: "mais de um home em quarantine corresponde ao agente" }],
    });
  });

  it("recreates a missing home for a roster agent without touching other state", async () => {
    const root = await tempRoot("openbot-roster-reconcile-missing-");
    const config = await configFor(root, [{ id: "missing-home", name: "Missing home" }]);
    const homes = await AgentHomeStore.create(join(root, "workspaces"));

    const result = await reconcileRosterHomes(config, homes);
    expect(result.created).toEqual(["missing-home"]);
    await expect(lstat(homes.pathFor("missing-home"))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    expect(await homes.listQuarantine()).toEqual([]);
  });

  it("settles a marker left on an active home by an interrupted quarantine", async () => {
    const root = await tempRoot("openbot-roster-reconcile-marker-");
    const config = await configFor(root, [{ id: "marked", name: "Marked" }]);
    const homes = await AgentHomeStore.create(join(root, "workspaces"));
    const home = await homes.ensure("marked");
    await writeFile(join(home.root, ".openbot", "quarantine.json"), `${JSON.stringify({
      agentId: "marked",
      quarantineId: "marked-crashed",
      quarantinedAt: new Date().toISOString(),
    })}\n`);

    const result = await reconcileRosterHomes(config, homes);
    expect(result).toMatchObject({ restored: [], quarantined: [], created: [], pending: [] });
    await expect(lstat(join(home.root, ".openbot", "quarantine.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(home.root)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("reports a corrupt active home as pending instead of declaring recovery healthy", async () => {
    const root = await tempRoot("openbot-roster-reconcile-corrupt-");
    const config = await configFor(root, [{ id: "corrupt-home", name: "Corrupt home" }]);
    const homes = await AgentHomeStore.create(join(root, "workspaces"));
    const home = await homes.ensure("corrupt-home");
    await writeFile(join(home.root, ".openbot", "home.json"), "{not-json");

    const result = await reconcileRosterHomes(config, homes);

    expect(result.pending).toEqual([
      { agentId: "corrupt-home", reason: "home ativo possui manifesto inválido" },
    ]);
    expect(result).toMatchObject({ restored: [], quarantined: [], created: [] });
  });

  it("isola marker ativo inválido por agente e continua reconciliando homes saudáveis", async () => {
    const root = await tempRoot("openbot-roster-reconcile-active-marker-");
    const config = await configFor(root, [
      { id: "marked-broken", name: "Marked broken" },
      { id: "healthy", name: "Healthy" },
    ]);
    const homes = await AgentHomeStore.create(join(root, "workspaces"));
    const broken = await homes.ensure("marked-broken");
    const healthy = await homes.ensure("healthy");
    await writeFile(join(broken.root, ".openbot", "quarantine.json"), "not-json");

    const result = await reconcileRosterHomes(config, homes);

    expect(result.pending).toEqual([
      { agentId: "marked-broken", reason: "home ativo possui integridade ou caminho inseguro" },
    ]);
    await expect(readFile(join(broken.root, ".openbot", "quarantine.json"), "utf8")).resolves.toBe("not-json");
    await expect(readFile(join(healthy.root, ".openbot", "home.json"), "utf8")).resolves.toContain("healthy");
  });

  it("preserva orphan com marker inválido e continua processando o roster", async () => {
    const root = await tempRoot("openbot-roster-reconcile-orphan-marker-");
    const config = await configFor(root, [{ id: "healthy", name: "Healthy" }]);
    const homes = await AgentHomeStore.create(join(root, "workspaces"));
    const orphan = await homes.ensure("orphan-broken");
    await writeFile(join(orphan.root, "Documents", "keep.txt"), "keep");
    await writeFile(join(orphan.root, ".openbot", "quarantine.json"), "not-json");

    const result = await reconcileRosterHomes(config, homes);

    expect(result.created).toEqual(["healthy"]);
    expect(result.pending).toContainEqual({
      agentId: "orphan-broken",
      reason: "home ativo possui integridade ou caminho inseguro",
    });
    await expect(readFile(join(orphan.root, "Documents", "keep.txt"), "utf8")).resolves.toBe("keep");
  });

  it("não faz inventário profundo do conteúdo da home durante o boot", async () => {
    const root = await tempRoot("openbot-roster-reconcile-no-deep-inventory-");
    const config = await configFor(root, [{ id: "healthy", name: "Healthy" }]);
    const homes = await AgentHomeStore.create(join(root, "workspaces"));
    const home = await homes.ensure("healthy");
    await writeFile(join(home.root, "Documents", "keep.txt"), "keep");
    vi.spyOn(homes, "inventory").mockRejectedValue(new Error("deep inventory must not run during recovery"));

    await expect(reconcileRosterHomes(config, homes)).resolves.toMatchObject({ pending: [] });
    await expect(readFile(join(home.root, "Documents", "keep.txt"), "utf8")).resolves.toBe("keep");
  });

  it("mantém erro global de I/O fatal", async () => {
    const root = await tempRoot("openbot-roster-reconcile-io-");
    const config = await configFor(root, [{ id: "io-failure", name: "I/O failure" }]);
    const homes = await AgentHomeStore.create(join(root, "workspaces"));
    await homes.ensure("io-failure");
    vi.spyOn(homes, "ensure").mockRejectedValueOnce(Object.assign(new Error("disk failed"), { code: "EIO" }));

    await expect(reconcileRosterHomes(config, homes)).rejects.toMatchObject({ code: "EIO" });
  });

  it("persists scoped provider and model changes with one config update", async () => {
    const root = await tempRoot("openbot-roster-provider-");
    const configPath = join(root, "config.json");
    const seed = new ConfigStore({ configPath });
    seed.update({ agents: [{ id: "openbot-default", name: "Local User", avatarId: "openbot-default" }] });
    seed.close();
    const gateway = createGateway();
    registerRosterHandlers(gateway, seed);
    const update = vi.spyOn(seed, "update");
    const handler = gateway.listHandlers().get("setProviderConfig")!;
    const value = await handler({ agentId: "openbot-default", provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" }, {} as never);

    expect(value).toMatchObject({ provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toMatchObject({ agents: [expect.objectContaining({ provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" })] });
    expect(new ConfigStore({ configPath }).snapshot().agents[0]).toMatchObject({ reasoningEffort: "high" });
  });

  it("rejects an OpenAI-compatible bot before creating its home when baseURL is absent", async () => {
    const root = await tempRoot("openbot-roster-create-compat-");
    const config = await configFor(root, []);
    const homes = await AgentHomeStore.create(join(root, "workspaces"));
    const ensureHome = vi.spyOn(homes, "ensure");
    const gateway = createGateway();
    registerRosterHandlers(gateway, config, homes);

    await expect(gateway.invokeRegisteredHandler("createAgent", { name: "Compat", model: "openai-compatible" }))
      .rejects.toThrow("openai-compat exige uma baseURL válida");
    expect(ensureHome).not.toHaveBeenCalled();
    expect(config.snapshot().agents).toEqual([]);
  });

  it("allows clearing compat baseURL when the same patch moves the effective provider away from compat", async () => {
    const root = await tempRoot("openbot-roster-provider-transition-");
    const config = await configFor(root, []);
    const baseURL = "http://127.0.0.1:1234/v1";
    config.update({ activeProvider: "openai-compat", globalModel: "openai-compatible", compatBaseUrl: baseURL });
    const gateway = createGateway();
    registerRosterHandlers(gateway, config);

    const handler = gateway.listHandlers().get("setProviderConfig")!;
    const value = await handler({ provider: "xai", model: "grok-4.6", baseURL: null }, {} as never);

    expect(value).toMatchObject({ provider: "xai", model: "grok-4.6", baseURL: null });
    expect(config.snapshot()).toMatchObject({ activeProvider: "xai", globalModel: "grok-4.6", compatBaseUrl: null });
  });

  it("does not commit config when compat adapter preparation fails", async () => {
    const root = await tempRoot("openbot-roster-provider-prepare-failure-");
    const config = await configFor(root, []);
    const before = config.snapshot();
    const registry = createProviderRegistry();
    vi.spyOn(registry, "register").mockImplementation(() => {
      throw new Error("adapter registration failed");
    });
    const gateway = createGateway();
    registerRosterHandlers(gateway, config, undefined, undefined, undefined, registry);

    const handler = gateway.listHandlers().get("setProviderConfig")!;
    await expect(Promise.resolve().then(() => handler({ provider: "openai-compat", model: "openai-compatible", baseURL: "http://127.0.0.1:1234/v1" }, {} as never)))
      .rejects.toThrow("adapter registration failed");
    expect(config.snapshot()).toEqual(before);
    expect(registry.has("openai-compat")).toBe(false);
  });

  it("restores the previous adapter when the config commit fails", async () => {
    const root = await tempRoot("openbot-roster-provider-commit-failure-");
    const config = await configFor(root, []);
    const before = config.snapshot();
    const registry = createProviderRegistry();
    const gateway = createGateway();
    registerRosterHandlers(gateway, config, undefined, undefined, undefined, registry);
    vi.spyOn(config, "update").mockImplementationOnce(() => {
      throw new Error("config commit failed");
    });

    const handler = gateway.listHandlers().get("setProviderConfig")!;
    await expect(Promise.resolve().then(() => handler({ provider: "openai-compat", model: "openai-compatible", baseURL: "http://127.0.0.1:1234/v1" }, {} as never)))
      .rejects.toThrow("config commit failed");
    expect(config.snapshot()).toEqual(before);
    expect(registry.has("openai-compat")).toBe(false);
  });

  it("createAgent recusa quando o orçamento global de disco estourou", async () => {
    const root = await tempRoot("openbot-roster-disk-budget-");
    const config = await configFor(root, []);
    const gateway = createGateway();
    registerRosterHandlers(
      gateway,
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => {
        throw new WorkspaceQuotaError();
      },
    );
    const handler = gateway.listHandlers().get("createAgent")!;
    await expect(Promise.resolve().then(() => handler({ name: "Disk full" }, {} as never)))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/disco/i) });
    expect(config.snapshot().agents).toEqual([]);
  });
});
