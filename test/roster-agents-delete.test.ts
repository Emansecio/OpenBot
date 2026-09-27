import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { ConfigStore } from "../src/config/store.js";
import type { ProviderAdapter, ProviderStreamEvent } from "../src/providers/router.js";
import type { TranscriptEntry } from "../src/shared/contracts.js";
import { McpManager } from "../src/mcp/manager.js";
import { SkillCatalog } from "../src/skills/catalog.js";
import { TempRoots } from "./helpers/temp-roots.js";

type RegisterCleanup = (cleanup: () => Promise<void>) => void;

// Concurrent tests must register cleanup on their own context, never the global hook.
async function boot(onTestFinished: RegisterCleanup, seedDefault = true) {
  const dir = mkdtempSync(join(tmpdir(), "openbot-roster-"));
  let handle: ServerHandle | undefined;
  onTestFinished(async () => {
    try {
      if (handle !== undefined) await stopServer(handle);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const configPath = join(dir, "config.json");
  if (seedDefault) {
    const config = new ConfigStore({ configPath });
    config.update({ agents: [{ id: "openbot-default", name: "Local User", avatarId: "openbot-default" }] });
  }
  handle = await startServer(0, {
    stateRoot: join(dir, "state"),
    allowUnauthenticatedLocalGateway: true,
    runtimeRoot: join(dir, "runtime"),
    browserRoot: join(dir, "browser"),
    workspacesRoot: join(dir, "workspaces"),
    storePath: join(dir, "store.db"),
    configPath,
    keystoreDir: join(dir, "keys"),
  });
  return handle;
}

const bootEmpty = (onTestFinished: RegisterCleanup) => boot(onTestFinished, false);

async function post(handle: ServerHandle, method: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as { ok: boolean; value?: unknown; failure?: string } };
}

function nextRpcRequest(handle: ServerHandle, method: string): Promise<void> {
  return new Promise((resolve) => {
    const listener = (request: IncomingMessage) => {
      if (request.url !== `/api/${method}`) return;
      handle.server.off("request", listener);
      resolve();
    };
    handle.server.on("request", listener);
  });
}


describe.concurrent("roster multi-agent", () => {

  it("excluir agente remove a home e preserva o bot ativo quando outro é apagado", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
    const victim = await post(handle, "createAgent", { id: "victim", name: "Victim" });
    expect(victim.status).toBe(200);
    const survivor = await post(handle, "createAgent", { id: "survivor", name: "Survivor" });
    expect(survivor.status).toBe(200);
    const victimRoot = handle.homes!.pathFor("victim");
    writeFileSync(join(victimRoot, "Documents", "private.txt"), "private");
    await post(handle, "openAgent", { id: "survivor" });
    const deleted = await post(handle, "deleteAgents", { ids: ["VICTIM"] });
    expect(deleted.status).toBe(200);
    expect(existsSync(victimRoot)).toBe(false);
    const listed = (await post(handle, "listAgents", {})).json.value as Array<{ id: string; isActive: boolean }>;
    expect(listed.find((agent) => agent.id === "survivor")?.isActive).toBe(true);
  });

  it("exclui bot cuja home tem manifesto corrompido em vez de prendê-lo", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);
    await post(handle, "createAgent", { id: "corrupt-victim", name: "Corrupt" });
    const victimRoot = handle.homes!.pathFor("corrupt-victim");
    writeFileSync(join(victimRoot, ".openbot", "home.json"), "{not-json");

    const deleted = await post(handle, "deleteAgents", { ids: ["corrupt-victim"] });

    expect(deleted.status).toBe(200);
    expect(handle.config.snapshot().agents).toEqual([]);
    expect(existsSync(victimRoot)).toBe(false);
    // Os bytes ficam contidos em quarentena — nada é destruído.
    const quarantined = await handle.homes!.listQuarantineMetadata();
    expect(quarantined.map((entry) => entry.agentId)).toEqual(["corrupt-victim"]);
  });

  it("reverte homes anteriores quando uma exclusão em lote falha", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);
    await post(handle, "createAgent", { id: "batch-first", name: "First" });
    await post(handle, "createAgent", { id: "batch-second", name: "Second" });
    const firstRoot = handle.homes!.pathFor("batch-first");
    const secondRoot = handle.homes!.pathFor("batch-second");
    // Manifesto que parseia mas declara outro agente prova conteúdo estranho —
    // a quarentena tolerante recusa (manifesto ilegível seria tolerado).
    writeFileSync(
      join(secondRoot, ".openbot", "home.json"),
      JSON.stringify({ agentId: "foreign-agent", createdAt: "2026-01-01T00:00:00.000Z", layoutVersion: 2 }),
    );

    const deleted = await post(handle, "deleteAgents", { ids: ["batch-first", "batch-second"] });
    expect(deleted.status).toBe(500);
    expect(handle.config.snapshot().agents.map((agent) => agent.id)).toEqual(["batch-first", "batch-second"]);
    expect(existsSync(firstRoot)).toBe(true);
    expect(existsSync(secondRoot)).toBe(true);
    expect(await handle.homes!.listQuarantine()).toEqual([]);
  });

  it("restaura a home quando o commit do roster falha", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);
    await post(handle, "createAgent", { id: "commit-victim", name: "Commit victim" });
    const home = handle.homes!.pathFor("commit-victim");
    const releaseFence = vi.spyOn(
      handle.runtimeManager as typeof handle.runtimeManager & { releaseAgentFence: (agentId: string) => void },
      "releaseAgentFence",
    );
    // Fail every commit path: roster mutations use both update() and mutate().
    const originalUpdate = handle.config.update.bind(handle.config);
    const originalMutate = handle.config.mutate.bind(handle.config);
    handle.config.update = (() => { throw new Error("config update failed"); });
    handle.config.mutate = (() => { throw new Error("config update failed"); });
    try {
      const failed = await post(handle, "deleteAgents", { ids: ["commit-victim"] });
      expect(failed.status).toBe(500);
    } finally {
      handle.config.update = originalUpdate;
      handle.config.mutate = originalMutate;
    }
    expect(existsSync(home)).toBe(true);
    expect(handle.config.snapshot().agents.map((agent) => agent.id)).toEqual(["commit-victim"]);
    expect(await handle.homes!.listQuarantine()).toEqual([]);
    expect(releaseFence).toHaveBeenCalledWith("commit-victim");
  });

  it("restaura transcript, nonces, decisões e atividade se store.clear falhar depois de limpar", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);
    await post(handle, "createAgent", { id: "partial-victim", name: "Partial victim" });
    const seedEntry: TranscriptEntry = {
      kind: "message",
      id: "seed:message",
      role: "user",
      content: "estado que não pode ser perdido",
      timestampMs: 123,
    };
    handle.store.append("partial-victim", [seedEntry]);
    handle.store.rememberAcceptedNonce("partial-victim", "seed:nonce");
    handle.store.rememberInteractionDecision("partial-victim", "seed:request", "tool", "allow");
    handle.registry.register({
      name: "xai",
      async streamChat(_request, emit) {
        emit({ type: "delta", delta: "atividade preservada" });
      },
    });
    handle.runner.sendPrompt({ agentId: "partial-victim", prompt: "atividade", clientNonce: "activity:1" });
    await handle.runner.flush("partial-victim");
    const beforeActivity = ((await post(handle, "listAgents", {})).json.value as Array<{
      id: string;
      lastMessagePreview: string | null;
    }>).find((agent) => agent.id === "partial-victim");
    const beforeEntries = [...handle.store.getEntries("partial-victim")];

    const originalClear = handle.store.clear.bind(handle.store);
    handle.store.clear = ((agentId: string) => {
      originalClear(agentId);
      throw new Error("store clear failed after deletion");
    });
    try {
      const failed = await post(handle, "deleteAgents", { ids: ["partial-victim"] });
      expect(failed.status).toBe(500);
    } finally {
      handle.store.clear = originalClear;
    }

    expect(handle.config.snapshot().agents.map((agent) => agent.id)).toEqual(["partial-victim"]);
    expect(existsSync(handle.homes!.pathFor("partial-victim"))).toBe(true);
    expect([...handle.store.getEntries("partial-victim")]).toEqual(beforeEntries);
    expect(handle.store.hasAcceptedNonce("partial-victim", "seed:nonce")).toBe(true);
    expect(handle.store.getInteractionDecision("partial-victim", "seed:request", "tool"))
      .toMatchObject({ decision: "allow" });
    const afterActivity = ((await post(handle, "listAgents", {})).json.value as Array<{
      id: string;
      lastMessagePreview: string | null;
    }>).find((agent) => agent.id === "partial-victim");
    expect(afterActivity?.lastMessagePreview).toBe(beforeActivity?.lastMessagePreview);
  });

  it("excluir o último bot deixa o roster vazio e não recria openbot-default", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);
    const created = await post(handle, "createAgent", { id: "last-bot", name: "Last bot" });
    expect(created.status).toBe(200);

    const deleted = await post(handle, "deleteAgents", { ids: ["last-bot"] });
    expect(deleted).toMatchObject({ status: 200, json: { ok: true, value: { ids: ["last-bot"] } } });
    expect(handle.config.snapshot().agents).toEqual([]);
    expect((await post(handle, "listAgents", {})).json).toMatchObject({ ok: true, value: [] });
    expect((await post(handle, "getAgent", { id: "openbot-default" })).status).toBe(400);
    expect((await post(handle, "ensureForeverBox", { id: "openbot-default" })).status).toBe(400);
  });

  it("deleteAgents aguarda o turno antes de limpar store e home", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
    const created = await post(handle, "createAgent", { id: "late-victim", name: "Late victim" });
    expect(created.status).toBe(200);
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const lateAdapter: ProviderAdapter = {
      name: "xai",
      async streamChat(_request, emit: (event: ProviderStreamEvent) => void) {
        startedResolve();
        await new Promise((resolve) => setTimeout(resolve, 20));
        emit({ type: "delta", delta: "late write" });
      },
    };
    handle.registry.register(lateAdapter);
    handle.runner.sendPrompt({ agentId: "late-victim", prompt: "run", clientNonce: "late:1" });
    await started;

    const deleted = await post(handle, "deleteAgents", { ids: ["late-victim"] });
    expect(deleted.status).toBe(200);
    await handle.runner.flush("late-victim");
    expect(existsSync(handle.homes!.pathFor("late-victim"))).toBe(false);
    expect(handle.store.getEntries("late-victim")).toEqual([]);
  });

  it("deleteAgents preserva criação e atualização concorrentes após o callback", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
    const survivor = await post(handle, "createAgent", { id: "survivor", name: "Survivor" });
    expect(survivor.status).toBe(200);

    let releaseFlush!: () => void;
    let flushStarted!: () => void;
    const flushReleased = new Promise<void>((resolve) => { releaseFlush = resolve; });
    const flushEntered = new Promise<void>((resolve) => { flushStarted = resolve; });
    const flush = vi.spyOn(handle.runner, "flush").mockImplementation(async () => {
      flushStarted();
      await flushReleased;
    });

    try {
      const deleting = post(handle, "deleteAgents", { ids: ["openbot-default"] });
      await flushEntered;

      const updated = await post(handle, "updateAgent", { agentId: "survivor", name: "Survivor updated" });
      expect(updated.status).toBe(200);
      const created = await post(handle, "createAgent", { id: "concurrent-create", name: "Concurrent create" });
      expect(created.status).toBe(200);

      releaseFlush();
      expect((await deleting).status).toBe(200);
    } finally {
      flush.mockRestore();
    }

    expect(handle.config.snapshot().agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "survivor", name: "Survivor updated" }),
      expect.objectContaining({ id: "concurrent-create", name: "Concurrent create" }),
    ]));
    expect(handle.config.snapshot().agents.some((agent) => agent.id === "openbot-default")).toBe(false);
  });

  it("serializa exclusões concorrentes antes de permitir recriar o mesmo id", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);
    expect((await post(handle, "createAgent", { id: "delete-recreate", name: "Original" })).status).toBe(200);
    const homes = handle.homes!;
    const originalRemove = homes.remove.bind(homes);
    let removeCalls = 0;
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const firstEntry = new Promise<void>((resolve) => { firstEntered = resolve; });
    homes.remove = (async (agentId: string) => {
      removeCalls += 1;
      if (removeCalls === 1) {
        firstEntered();
        await firstRelease;
      }
      return originalRemove(agentId);
    });

    const firstDelete = post(handle, "deleteAgents", { ids: ["delete-recreate"] });
    await firstEntry;
    const secondDeleteReceived = nextRpcRequest(handle, "deleteAgents");
    const secondDelete = post(handle, "deleteAgents", { ids: ["delete-recreate"] });
    const recreateReceived = nextRpcRequest(handle, "createAgent");
    const recreated = post(handle, "createAgent", { id: "delete-recreate", name: "Recreated" });
    try {
      await Promise.all([secondDeleteReceived, recreateReceived]);
    } finally {
      releaseFirst();
    }

    await expect(firstDelete).resolves.toMatchObject({ status: 200 });
    await expect(secondDelete).resolves.toMatchObject({ status: 200 });
    await expect(recreated).resolves.toMatchObject({ status: 200 });
    expect(handle.config.snapshot().agents).toEqual([
      expect.objectContaining({ id: "delete-recreate", name: "Recreated" }),
    ]);
    expect(removeCalls).toBe(1);
  });

  it("não ressuscita o agente quando avatar e exclusão concorrem", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);
    expect((await post(handle, "createAgent", { id: "avatar-delete", name: "Avatar delete" })).status).toBe(200);
    const homes = handle.homes!;
    const originalEnsure = homes.ensure.bind(homes);
    let releaseEnsure!: () => void;
    const ensureRelease = new Promise<void>((resolve) => { releaseEnsure = resolve; });
    let ensureEntered!: () => void;
    const ensureEntry = new Promise<void>((resolve) => { ensureEntered = resolve; });
    let blocked = false;
    homes.ensure = (async (agentId: string) => {
      if (agentId === "avatar-delete" && !blocked) {
        blocked = true;
        ensureEntered();
        await ensureRelease;
      }
      return originalEnsure(agentId);
    });
    const pngBase64 = Buffer.from("89504e470d0a1a0a00000000", "hex").toString("base64");

    const avatar = post(handle, "setAgentAvatarBytes", { id: "avatar-delete", pngBase64 });
    await ensureEntry;
    const deletionReceived = nextRpcRequest(handle, "deleteAgents");
    const deletion = post(handle, "deleteAgents", { ids: ["avatar-delete"] });
    try {
      await deletionReceived;
    } finally {
      releaseEnsure();
    }

    await expect(avatar).resolves.toMatchObject({ status: 200 });
    await expect(deletion).resolves.toMatchObject({ status: 200 });
    expect(handle.config.snapshot().agents).toEqual([]);
    expect(existsSync(handle.homes!.pathFor("avatar-delete"))).toBe(false);
  });

  it("rejeita sendPrompt enquanto deleteAgents aguarda o turno em voo", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
    const created = await post(handle, "createAgent", { id: "fenced-victim", name: "Fenced victim" });
    expect(created.status).toBe(200);

    let turn1StartedResolve!: () => void;
    const turn1Started = new Promise<void>((resolve) => { turn1StartedResolve = resolve; });
    let deletionAbortResolve!: () => void;
    const deletionAbort = new Promise<void>((resolve) => { deletionAbortResolve = resolve; });
    let releaseTurn1!: () => void;
    const turn1Release = new Promise<void>((resolve) => { releaseTurn1 = resolve; });
    let calls = 0;
    const adapter: ProviderAdapter = {
      name: "xai",
      async streamChat(request, emit) {
        calls += 1;
        if (calls === 1) {
          turn1StartedResolve();
          request.signal?.addEventListener("abort", deletionAbortResolve, { once: true });
          await turn1Release;
        }
        emit({ type: "delta", delta: `turn ${calls}` });
      },
    };
    handle.registry.register(adapter);
    handle.runner.sendPrompt({ agentId: "fenced-victim", prompt: "turn 1", clientNonce: "fence:1" });
    await turn1Started;

    const deleting = post(handle, "deleteAgents", { ids: ["fenced-victim"] });
    await deletionAbort;
    const send2 = await post(handle, "sendPrompt", {
      agentId: "fenced-victim",
      prompt: "turn 2",
      clientNonce: "fence:2",
    });

    releaseTurn1();
    const deleted = await deleting;
    await handle.runner.flush("fenced-victim");

    expect(send2.status).toBe(409);
    expect(deleted.status).toBe(200);
    expect(calls).toBe(1);
    expect(handle.store.getEntries("fenced-victim")).toEqual([]);
  });
});

describe("deleteAgents generation state", () => {
  const temp = new TempRoots();
  afterEach(async () => {
    await temp.cleanup();
  });

  it("cleans generation state after committed delete but preserves it on rollback", async () => {
    const root = temp.make("openbot-delete-lifecycle-");
    const config = new ConfigStore({ configPath: join(root, "config.json") });
    config.update({ agents: [
      { id: "committed-agent", name: "Committed", avatarId: "committed-agent" },
      { id: "rollback-agent", name: "Rollback", avatarId: "rollback-agent" },
    ] });
    const handle = await startServer(0, {
      config,
      storePath: join(root, "store.db"),
      keystoreDir: join(root, "keys"),
      runtimeRoot: join(root, "runtime"),
      disableAgentHome: true,
      allowUnauthenticatedLocalGateway: true,
      sharedIntegrationsEnabled: false,
      skillCatalog: new SkillCatalog({ roots: [] }),
      mcpManager: new McpManager(),
    });
    try {
      for (const agentId of ["committed-agent", "rollback-agent"]) {
        handle.runner.sendPrompt({ agentId, prompt: "queued", clientNonce: `nonce:${agentId}` });
        expect(handle.runner.cancelPrompt(agentId).cancelled).toBe(true);
        await handle.runner.flush(agentId);
      }
      const state = handle.runner as unknown as { agentGenerations: Map<string, number> };
      expect(state.agentGenerations.has("committed-agent")).toBe(true);
      expect(state.agentGenerations.has("rollback-agent")).toBe(true);

      const committedResponse = await fetch(`http://127.0.0.1:${handle.port}/api/deleteAgents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["committed-agent"] }),
      });
      expect(committedResponse.status).toBe(200);
      expect(state.agentGenerations.has("committed-agent")).toBe(false);

      const clear = vi.spyOn(handle.store, "clear").mockImplementation(() => {
        throw new Error("forced persistence rollback");
      });
      try {
        const rollbackResponse = await fetch(`http://127.0.0.1:${handle.port}/api/deleteAgents`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: ["rollback-agent"] }),
        });
        expect(rollbackResponse.status).toBe(500);
      } finally {
        clear.mockRestore();
      }
      expect(state.agentGenerations.has("rollback-agent")).toBe(true);
      expect(config.snapshot().agents.some((agent) => agent.id === "rollback-agent")).toBe(true);
    } finally {
      await stopServer(handle);
    }
  });
});
