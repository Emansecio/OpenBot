import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config/store.js";
import { ProviderAdmissionScheduler } from "../src/providers/admission.js";
import { ModelCatalogService } from "../src/providers/model-catalog.js";
import { connectionFingerprint } from "../src/providers/model-discovery.js";
import { createProviderRegistry } from "../src/providers/router.js";
import { createMemoryTranscriptStore, createTurnRunner } from "../src/rpc/send.js";
import { createFakeAdapter } from "./mocks/fake-provider-adapter.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("send preparation cancellation", () => {
  it.each(["attachments", "context"] as const)("does not accept or consume content after cancellation during %s", async (phase) => {
    const entered = deferred();
    const release = deferred();
    const store = createMemoryTranscriptStore();
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("fake", { deltas: ["done"] });
    registry.register(adapter);
    let consumed = false;
    const append = store.append.bind(store);
    store.append = (agentId, entries, conversationId, consume) => {
      if (consume) consumed = true;
      append(agentId, entries, conversationId, consume);
    };
    const prepare = async () => { entered.resolve(); await release.promise; };
    const runner = createTurnRunner({
      store, registry,
      resolveProvider: () => ({ provider: "fake", model: "fixture" }),
      readAttachments: async () => {
        if (phase === "attachments") await prepare();
        return [{ name: "note.txt", path: "attachment:fixture", text: "retained text" }];
      },
      resolveTurnContext: async () => {
        if (phase === "context") await prepare();
        return "";
      },
    });
    const args = {
      agentId: "a", prompt: "keep my content", clientNonce: "cancel-preparation",
      attachments: [{ name: "note.txt", path: "attachment:fixture" }],
    };
    const acceptance = runner.sendPrompt(args);
    await entered.promise;
    try {
      expect(runner.cancelPrompt("a")).toEqual({ cancelled: true, agentIds: ["a"] });
      release.resolve();
      await expect(acceptance).rejects.toThrow(/cancelado/i);
      await runner.flush("a");
      expect(consumed).toBe(false);
      expect(store.getEntries("a").some((entry) => entry.kind === "message" || entry.kind === "user-attachment")).toBe(false);
      expect(store.hasAcceptedNonce("a", args.clientNonce)).toBe(false);
      expect(adapter.invocations).toHaveLength(0);
      await expect(runner.sendPrompt(args)).resolves.toEqual({ accepted: true });
      await runner.flush("a");
      expect(adapter.invocations).toHaveLength(1);
    } finally {
      release.resolve();
      await runner.flush("a");
    }
  });

  it("reports catalog preparation as busy and cancels it before acceptance", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-send-preparation-"));
    const entered = deferred();
    const release = deferred();
    const catalog = new ModelCatalogService({ sources: { xai: {
      connectionKey: async () => {
        entered.resolve();
        await release.promise;
        return connectionFingerprint("offline-fixture");
      },
      discover: async () => [{ id: "grok-4.6" }],
    } } });
    const config = new ConfigStore({ configPath: path.join(directory, "config.json"), allowUnverifiedModels: true });
    config.update({ agents: [{ id: "a", name: "a", avatarId: "default", provider: "xai", model: "grok-4.6" }] });
    config.modelCatalog = catalog;
    const store = createMemoryTranscriptStore();
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("xai", { deltas: ["done"] });
    registry.register(adapter);
    const runner = createTurnRunner({ config, store, registry, resolveProvider: () => ({ provider: "xai", model: "grok-4.6" }) });
    const acceptance = runner.sendPrompt({ agentId: "a", prompt: "cancel discovery", clientNonce: "catalog-cancel" });
    // Observe rejection immediately so a failed assertion cannot leave it unhandled.
    void acceptance.catch(() => undefined);
    await entered.promise;
    try {
      expect(runner.promptStatus("a")).toMatchObject({ isBusy: true, canCancel: true });
      expect(runner.getStatus()).toMatchObject({ isBusy: true, busyAgentIds: ["a"] });
      expect(runner.cancelPrompt("a")).toEqual({ cancelled: true, agentIds: ["a"] });
      release.resolve();
      await expect(acceptance).rejects.toThrow(/cancelado/i);
      await runner.flush("a");
      expect(store.getEntries("a")).toHaveLength(0);
      expect(store.hasAcceptedNonce("a", "catalog-cancel")).toBe(false);
      expect(adapter.invocations).toHaveLength(0);
      expect(runner.promptStatus("a")).toMatchObject({ isBusy: false, canCancel: false });
    } finally {
      release.resolve();
      await runner.flush("a");
      config.close();
      catalog.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("execution status contract", () => {
  const registerProvider = (registry: ReturnType<typeof createProviderRegistry>, handlers: {
    transported: { resolve(): void };
    deltaEmitted: { resolve(): void };
    release: { promise: Promise<void> };
    finish: { promise: Promise<void> };
  }) => {
    registry.register({ name: "fake", async streamChat(request, emit) {
      request.onTransportStart?.("chat");
      handlers.transported.resolve();
      await handlers.release.promise;
      if (request.signal?.aborted) return;
      emit({ type: "delta", delta: "parcial" });
      handlers.deltaEmitted.resolve();
      await handlers.finish.promise;
      emit({ type: "message", message: { role: "assistant", content: "parcial" } });
    } });
  };

  it("reports observed steps and the confirmed outcome without inventing progress", async () => {
    const transported = deferred();
    const deltaEmitted = deferred();
    const release = deferred();
    const finish = deferred();
    const registry = createProviderRegistry();
    registerProvider(registry, { transported, deltaEmitted, release, finish });
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({ store, registry, resolveProvider: () => ({ provider: "fake", model: "fixture" }) });
    try {
      void runner.sendPrompt({ agentId: "a", prompt: "estado", clientNonce: "status" }).catch(() => undefined);
      await transported.promise;
      const waiting = runner.promptStatus("a");
      expect(waiting).toMatchObject({ isBusy: true, canCancel: true });
      expect(waiting.execution).toMatchObject({ phase: "awaiting-provider", lastActivity: "provider-request" });
      expect(typeof waiting.execution?.startedAtMs).toBe("number");
      expect(waiting.execution?.lastActivityAtMs).toBeGreaterThanOrEqual(waiting.execution!.startedAtMs);
      // Sem confirmação ainda: nenhum resultado terminal é anunciado.
      expect(waiting.lastTurn).toBeUndefined();
      // Um intervalo sem eventos mantém o estado: nada é abortado nem inventado.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(runner.promptStatus("a").execution?.phase).toBe("awaiting-provider");
      expect(store.getEntries("a").some((entry) => entry.kind === "notice")).toBe(false);
      release.resolve();
      await deltaEmitted.promise;
      expect(runner.promptStatus("a").execution).toMatchObject({ phase: "receiving", lastActivity: "provider-stream" });
      finish.resolve();
      await runner.flush("a");
      expect(runner.promptStatus("a")).toMatchObject({ isBusy: false, lastTurn: { turnId: expect.any(String), outcome: "success" } });
      expect(runner.promptStatus("a").execution).toBeUndefined();
    } finally {
      release.resolve();
      finish.resolve();
      await runner.flush("a");
    }
  });

  it("distinguishes waiting for a provider slot from waiting for the provider", async () => {
    const transported = deferred();
    const deltaEmitted = deferred();
    const release = deferred();
    const finish = deferred();
    const registry = createProviderRegistry();
    registerProvider(registry, { transported, deltaEmitted, release, finish });
    const admission = new ProviderAdmissionScheduler({ maxActive: 1 });
    const blocker = await admission.acquire("blocker");
    const runner = createTurnRunner({ store: createMemoryTranscriptStore(), registry, admission,
      resolveProvider: () => ({ provider: "fake", model: "fixture" }) });
    try {
      void runner.sendPrompt({ agentId: "a", prompt: "vaga", clientNonce: "slot" }).catch(() => undefined);
      await vi.waitFor(() => expect(runner.promptStatus("a").execution?.phase).toBe("awaiting-slot"));
      // Esperar por vaga não é travamento: o turno continua ocupado e cancelável.
      expect(runner.promptStatus("a")).toMatchObject({ isBusy: true, canCancel: true });
      blocker.release();
      await transported.promise;
      expect(runner.promptStatus("a").execution).toMatchObject({ phase: "awaiting-provider", lastActivity: "provider-request" });
      release.resolve();
      await deltaEmitted.promise;
      finish.resolve();
      await runner.flush("a");
      expect(runner.promptStatus("a").lastTurn).toMatchObject({ outcome: "success" });
    } finally {
      blocker.release();
      release.resolve();
      finish.resolve();
      await runner.flush("a");
    }
  });
});
