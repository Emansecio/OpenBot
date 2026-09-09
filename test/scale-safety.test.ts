import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConfigStore,
  MAX_LOCAL_AGENTS,
  type LocalAgent,
} from "../src/config/store.js";
import { AgentHomeStore } from "../src/execution/home.js";
import {
  migrateLegacyAgentAvatars,
  migrateLegacyProfileAvatar,
  registerRosterHandlers,
} from "../src/rpc/roster.js";
import type { Gateway } from "../src/server/gateway.js";
import { SqliteTranscriptStore } from "../src/store/index.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function agent(index: number, extra: Partial<LocalAgent> = {}): LocalAgent {
  return {
    id: `agent-${index}`,
    name: `Agent ${index}`,
    avatarId: `avatar-${index}`,
    ...extra,
  };
}

type TestHandler = (body: unknown) => unknown | Promise<unknown>;

function testGateway(): { gateway: Gateway; handlers: Map<string, TestHandler> } {
  const handlers = new Map<string, TestHandler>();
  const gateway = {
    registerHandler(name: string, handler: TestHandler) {
      handlers.set(name, handler);
    },
    publish() {
      // no-op
    },
  } as unknown as Gateway;
  return { gateway, handlers };
}

describe("scale safety", () => {
  it("externaliza avatar legado no home e remove bytes do JSON", async () => {
    const root = temporaryRoot("openbot-avatar-migration-");
    const configPath = join(root, "config.json");
    const config = new ConfigStore({ configPath });
    const pngBase64 = Buffer.from("89504e470d0a1a0a00000000", "hex").toString("base64");
    config.update({
      profile: { avatarPngBase64: pngBase64 },
      agents: [agent(1, { avatarPngBase64: pngBase64 })],
    });
    const homes = await AgentHomeStore.create(join(root, "workspaces"), { parentAclVerified: true });

    const profileResult = await migrateLegacyProfileAvatar(config);
    const result = await migrateLegacyAgentAvatars(config, homes);

    expect(profileResult).toEqual({ migrated: true });
    expect(readFileSync(join(root, "profile-avatar.png"))).toEqual(Buffer.from(pngBase64, "base64"));
    expect(config.snapshot().profile).toMatchObject({ hasCustomAvatar: true });
    expect(config.snapshot().profile.avatarPngBase64).toBeUndefined();
    expect(result).toEqual({ migrated: ["agent-1"], failed: [] });
    expect(readFileSync(join(homes.pathFor("agent-1"), ".openbot", "avatar.png"))).toEqual(Buffer.from(pngBase64, "base64"));
    expect(config.snapshot().agents[0]).toMatchObject({ hasCustomAvatar: true });
    expect(config.snapshot().agents[0]?.avatarPngBase64).toBeUndefined();
    expect(readFileSync(configPath, "utf8")).not.toContain(pngBase64);
    await expect(migrateLegacyProfileAvatar(config)).resolves.toEqual({ migrated: false });
    await expect(migrateLegacyAgentAvatars(config, homes)).resolves.toEqual({ migrated: [], failed: [] });
  });

  it("impõe teto global de 128 agentes no config e no CRUD", async () => {
    const root = temporaryRoot("openbot-agent-cap-");
    const config = new ConfigStore({ configPath: join(root, "config.json") });
    const fullRoster = Array.from({ length: MAX_LOCAL_AGENTS }, (_, index) => agent(index));
    config.update({ agents: fullRoster });

    expect(() => config.update({ agents: [...fullRoster, agent(MAX_LOCAL_AGENTS)] }))
      .toThrow(`limite de ${MAX_LOCAL_AGENTS}`);
    expect(config.snapshot().agents).toHaveLength(MAX_LOCAL_AGENTS);

    const { gateway, handlers } = testGateway();
    registerRosterHandlers(gateway, config);
    await expect(handlers.get("createAgent")!({ id: "overflow", name: "Overflow" }))
      .rejects.toMatchObject({ status: 409 });
    await expect(handlers.get("duplicateAgent")!({ id: "agent-0" }))
      .rejects.toMatchObject({ status: 409 });
    expect(config.snapshot().agents).toHaveLength(MAX_LOCAL_AGENTS);
  });

  it("deleteAgents usa uma limpeza batch para múltiplos agentes", async () => {
    const root = temporaryRoot("openbot-roster-batch-");
    const config = new ConfigStore({ configPath: join(root, "config.json") });
    config.update({ agents: [agent(1), agent(2)] });
    const { gateway, handlers } = testGateway();
    const store = {
      clear: vi.fn(),
      clearAgents: vi.fn(),
    };
    registerRosterHandlers(gateway, config, undefined, undefined, undefined, undefined, store as never);

    await expect(handlers.get("deleteAgents")!({ ids: ["agent-1", "agent-2", "agent-1"] }))
      .resolves.toEqual({ ok: true, ids: ["agent-1", "agent-2"] });
    expect(store.clearAgents).toHaveBeenCalledTimes(1);
    expect(store.clearAgents).toHaveBeenCalledWith(["agent-1", "agent-2"]);
    expect(store.clear).not.toHaveBeenCalled();
    expect(config.snapshot().agents).toEqual([]);
  });

  it("SQLite limpa lote atomicamente e reconstrói FTS uma vez", () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      for (const agentId of ["agent-a", "agent-b"]) {
        const conversation = store.conversationStore.ensureDefault(agentId);
        store.append(agentId, [{ kind: "notice", id: `notice:${agentId}`, text: agentId }], conversation.id);
      }
      const rebuild = vi.spyOn(store.memoryStore, "rebuildFts");

      expect(() => store.clearAgents(["agent-a", ""])).toThrow();
      expect(store.getEntries("agent-a", store.conversationStore.getActive("agent-a")!.id)).toHaveLength(1);
      expect(rebuild).not.toHaveBeenCalled();

      store.clearAgents(["agent-a", "agent-b", "agent-a"]);

      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(store.conversationStore.getActive("agent-a")).toBeNull();
      expect(store.conversationStore.getActive("agent-b")).toBeNull();
    } finally {
      store.close();
    }
  });
});
