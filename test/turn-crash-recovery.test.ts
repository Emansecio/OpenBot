import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProviderRegistry } from "../src/providers/router.js";
import { createTurnRunner } from "../src/rpc/send.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { ModelCatalogService } from "../src/providers/model-catalog.js";

const roots: string[] = [];
const stores: SqliteTranscriptStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("turn crash recovery", () => {
  it("confirma somente o echo persistido e mantém o mesmo nonce durante a preparação", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-send-acceptance-"));
    roots.push(root);
    const path = join(root, "store.db");
    const store = new SqliteTranscriptStore({ path });
    stores.push(store);
    let release!: () => void;
    const preparation = new Promise<void>((resolve) => { release = resolve; });
    const runner = createTurnRunner({
      store,
      registry: createProviderRegistry(),
      resolveTurnContext: async () => { await preparation; return ""; },
    });
    const args = { agentId: "agent-a", prompt: "texto exato\ncom acento: ação", clientNonce: "durable-send" };
    let accepted = false;
    const ack = runner.sendPrompt(args);
    void ack.then(() => { accepted = true; });
    expect(runner.sendPrompt(args)).toBe(ack);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(accepted).toBe(false);
    expect(store.getEntries("agent-a")).toEqual([]);
    expect(runner.acceptanceStatus("agent-a", args.clientNonce)).toEqual({ outcome: "unknown-durability" });
    release();
    expect(await ack).toEqual({ accepted: true });
    expect(store.findUserEchoByNonce("agent-a", args.clientNonce)).toMatchObject({ content: args.prompt });
    await runner.flush("agent-a");
    store.close();
    const reopened = new SqliteTranscriptStore({ path });
    stores.push(reopened);
    expect(reopened.getEntries("agent-a").filter((entry) => entry.kind === "message" && entry.role === "user"))
      .toEqual([expect.objectContaining({ content: args.prompt, clientNonce: args.clientNonce })]);
  });

  it("reexecuta retry interrompido pelo crash sem duplicar a mensagem original", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-retry-crash-"));
    roots.push(root);
    const path = join(root, "store.db");
    const first = new SqliteTranscriptStore({ path });
    stores.push(first);
    const catalog = new ModelCatalogService({ sources: {} });
    const modelResolution = catalog.resolve("xai", "grok-4.6");
    modelResolution.entry.contextWindow = 320000;
    catalog.close();
    first.append("agent-a", [
      { kind: "message", id: "u", role: "user", content: "original", timestampMs: 1, streaming: false, clientNonce: "nonce:original", turnId: "turn:failed", provider: "xai", model: "grok-4.6", modelResolution, fromUser: { name: "Usuário", authId: "local" } },
      { kind: "notice", id: "failure", type: "provider-error", text: "Falha temporária.", level: "error", retryable: true, turnId: "turn:failed", provider: "xai", model: "grok-4.6", clientNonce: "nonce:original" },
    ]);
    first.beginTurnAttempt({
      turnId: "turn:retry-crashed",
      agentId: "agent-a",
      clientNonce: "retry:turn:failed",
      retryOfClientNonce: "nonce:original",
      retryFailureTurnId: "turn:failed",
      provider: "xai",
      model: "grok-4.6",
      phase: "provider-pending",
      startedAtMs: 2,
    });
    first.append("agent-a", [{ kind: "notice", id: "retry-marker", type: "retry-attempt", text: "Nova tentativa iniciada.", level: "info", clientNonce: "retry:turn:failed", retryOfClientNonce: "nonce:original", retryFailureTurnId: "turn:failed", turnId: "turn:retry-crashed", provider: "xai", model: "grok-4.6" }]);
    first.rememberAcceptedNonce("agent-a", "retry:turn:failed");
    first.close();

    const second = new SqliteTranscriptStore({ path });
    stores.push(second);
    let invocations = 0;
    const registry = createProviderRegistry();
    registry.register({
      name: "xai",
      async streamChat(_request, emit) {
        expect(_request.modelResolution?.entry.contextWindow).toBe(320000);
        invocations += 1;
        emit({ type: "delta", delta: "recuperado" });
      },
    });
    const runner = createTurnRunner({ store: second, registry, resolveProvider: () => ({ provider: "xai", model: "grok-4.6" }) });

    expect(await runner.retryPrompt("agent-a")).toEqual({ accepted: true });
    await runner.flush("agent-a");

    const entries = second.getEntries("agent-a");
    expect(invocations).toBe(1);
    expect(entries.filter((entry) => entry.kind === "message" && entry.role === "user")).toHaveLength(1);
    expect(entries.some((entry) => entry.kind === "message" && entry.role === "assistant" && entry.content === "recuperado")).toBe(true);
  });
});
