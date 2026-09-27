
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createProviderRegistry } from "../src/providers/router.js";
import { createFakeAdapter } from "./mocks/fake-provider-adapter.js";
import { MAX_PROVIDER_TEXT_CONTEXT_BYTES, MAX_PROVIDER_TRANSCRIPT_MESSAGES, createMemoryTranscriptStore, createTurnRunner } from "../src/rpc/send.js";
import type { TranscriptEntry } from "../src/shared/contracts.js";
import { collectPublish, makeRunner, fakeXai } from "./helpers/turn-runner.js";

/** Todas as entries dos eventos appended do canal transcript. */
function allAppended(events: ReturnType<typeof collectPublish>["events"]): TranscriptEntry[] {
  return events
    .filter((e) => e.channel === "transcript" && (e.payload as { type: string }).type === "appended")
    .map((e) => (e.payload as { entry: TranscriptEntry }).entry);
}

describe("T10 montagem do diálogo (system + transcript → streamChat)", () => {
  it("system prompt + mensagens do transcript chegam ao provider na ordem", async () => {
    const { registry, adapter } = fakeXai();
    const { runner } = makeRunner({ registry, systemPrompt: () => "SYS-OPENBOT" });

    runner.sendPrompt({ agentId: "a", prompt: "primeira" });
    await runner.flush("a");
    runner.sendPrompt({ agentId: "a", prompt: "segunda" });
    await runner.flush("a");

    expect(adapter.invocations).toHaveLength(2);
    const first = adapter.invocations[0]?.req;
    expect(first?.system).toBe("SYS-OPENBOT");
    expect(first?.model).toBe("grok-4.6"); // default do catálogo estático (Decisão §8.3)
    expect(first?.messages).toEqual([{ role: "user", content: "primeira" }]);

    // segundo turno: histórico completo (user+assistant do turno anterior)
    const second = adapter.invocations[1]?.req;
    expect(second?.messages).toEqual([
      { role: "user", content: "primeira" },
      { role: "assistant", content: "resposta" },
      { role: "user", content: "segunda" },
    ]);
  });

  it("usa a query de tail limitada para montar o contexto do provider", async () => {
    const store = createMemoryTranscriptStore();
    store.append("a", Array.from({ length: 200 }, (_, index) => ({
      kind: "message" as const,
      id: `m${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `m${index}`,
      timestampMs: index,
      streaming: false,
    })));
    let fullReads = 0;
    let recentReads = 0;
    let tailReads = 0;
    const getEntries = store.getEntries.bind(store);
    const getRecentEntries = store.getRecentEntries.bind(store);
    const openDurableAgentTail = store.openDurableAgentTail!.bind(store);
    store.getEntries = (agentId) => { fullReads += 1; return getEntries(agentId); };
    store.getRecentEntries = (agentId, options) => { recentReads += 1; return getRecentEntries(agentId, options); };
    store.openDurableAgentTail = (agentId, limit, beforeSeq, conversationId) => {
      tailReads += 1;
      return openDurableAgentTail(agentId, limit, beforeSeq, conversationId);
    };
    const { registry, adapter } = fakeXai();
    const { runner } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "atual" });
    await runner.flush("a");

    expect(adapter.invocations[0]?.req.messages).toHaveLength(80);
    expect(adapter.invocations[0]?.req.messages.at(-1)).toEqual({ role: "user", content: "atual" });
    expect(recentReads).toBe(1);
    expect(tailReads).toBe(1);
    expect(fullReads).toBe(0);
  });

  it("preserva a primeira instrução e começa o restante recente em uma mensagem do usuário", async () => {
    const store = createMemoryTranscriptStore();
    store.append("a", Array.from({ length: MAX_PROVIDER_TRANSCRIPT_MESSAGES + 20 }, (_, index) => ({
      kind: "message" as const,
      id: `long-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: index === 0 ? "IMPORTANTE: responda sempre em português" : `long-${index}`,
      timestampMs: index,
      streaming: false,
    })));
    const { registry, adapter } = fakeXai();
    const { runner } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "pergunta final" });
    await runner.flush("a");

    const messages = adapter.invocations[0]?.req.messages ?? [];
    expect(messages.length).toBeLessThanOrEqual(MAX_PROVIDER_TRANSCRIPT_MESSAGES);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toEqual({ role: "user", content: "IMPORTANTE: responda sempre em português" });
    expect(messages[1]).toEqual({ role: "user", content: "long-22" });
    expect(messages[2]).toEqual({ role: "assistant", content: "long-23" });
    expect(messages.at(-1)).toEqual({ role: "user", content: "pergunta final" });
    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
      kind: "notice",
      level: "info",
      text: "O histórico antigo foi resumido ou omitido para caber no contexto.",
    }));
  });

  it("limita o histórico por tokens e bytes e preserva a solicitação atual", async () => {
    const store = createMemoryTranscriptStore();
    store.append("a", Array.from({ length: 60 }, (_, index) => ({
      kind: "message" as const,
      id: `large-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `${index}:`.padEnd(24 * 1024, "x"),
      timestampMs: index,
      streaming: false,
    })));
    const { registry, adapter } = fakeXai();
    const { runner } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "PEDIDO ATUAL PRESERVADO" });
    await runner.flush("a");

    const messages = adapter.invocations[0]?.req.messages ?? [];
    const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
    expect(bytes).toBeLessThanOrEqual(MAX_PROVIDER_TEXT_CONTEXT_BYTES);
    expect(bytes).toBeGreaterThan(256 * 1024);
    expect(messages.length).toBeGreaterThan(12);
    expect(messages.length).toBeLessThan(61);
    expect(messages[0]?.role).toBe("user");
    expect(typeof messages[0]?.content).toBe("string");
    expect((messages[0] as { content: string }).content).toMatch(/^\d+:/u);
    expect(messages.at(-1)).toEqual({ role: "user", content: "PEDIDO ATUAL PRESERVADO" });
  });

  it("falha fechado antes do provider quando o overhead fixo esgota o envelope", async () => {
    const { registry, adapter } = fakeXai();
    const { runner, events } = makeRunner({
      registry,
      systemPrompt: () => "s".repeat(MAX_PROVIDER_TEXT_CONTEXT_BYTES + 1_024),
    });

    runner.sendPrompt({ agentId: "a", prompt: "pedido" });
    await runner.flush("a");

    expect(adapter.invocations).toHaveLength(0);
    expect(allAppended(events).some((entry) => entry.kind === "notice" && entry.level === "error")).toBe(true);
  });

  it("preserva a âncora global e mantém a fronteira de usuário quando anexos esgotam o tail", async () => {
    const store = createMemoryTranscriptStore();
    store.append("a", [{
      kind: "message",
      id: "attachment-anchor",
      role: "user",
      content: "TAREFA ORIGINAL COM ANEXOS",
      timestampMs: 1,
      streaming: false,
    }]);
    const history: TranscriptEntry[] = [];
    for (let index = 0; index < 60; index += 1) {
      history.push(
        { kind: "message", id: `u-${index}`, role: "user", content: `u-${index}`, timestampMs: index * 4 + 2, streaming: false },
        { kind: "user-attachment", id: `a1-${index}`, file_name: `a1-${index}.txt`, file_path: `a1-${index}.txt`, extractedText: "x" },
        { kind: "user-attachment", id: `a2-${index}`, file_name: `a2-${index}.txt`, file_path: `a2-${index}.txt`, extractedText: "y" },
        { kind: "message", id: `r-${index}`, role: "assistant", content: `r-${index}`, timestampMs: index * 4 + 5, streaming: false },
      );
    }
    store.append("a", history);
    const { registry, adapter } = fakeXai();
    const { runner } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "pergunta após anexos" });
    await runner.flush("a");

    const messages = adapter.invocations[0]?.req.messages ?? [];
    expect(messages.length).toBeLessThanOrEqual(MAX_PROVIDER_TRANSCRIPT_MESSAGES);
    expect(messages[0]).toEqual({ role: "user", content: "TAREFA ORIGINAL COM ANEXOS" });
    expect(messages[1]).toEqual({
      role: "user",
      content: "u-21\n\n[[OPENBOT_UNTRUSTED_ATTACHMENT_BEGIN]]\nname: \"a1-21.txt\"\ncontent:\nx\n[[OPENBOT_UNTRUSTED_ATTACHMENT_END]]\n\n[[OPENBOT_UNTRUSTED_ATTACHMENT_BEGIN]]\nname: \"a2-21.txt\"\ncontent:\ny\n[[OPENBOT_UNTRUSTED_ATTACHMENT_END]]",
    });
    expect(messages[2]).toEqual({ role: "assistant", content: "r-21" });
    expect(messages.at(-1)).toEqual({ role: "user", content: "pergunta após anexos" });
  });

  it("não envia resposta interrompida por crash como histórico concluído", async () => {
    const store = createMemoryTranscriptStore();
    store.append("a", [
      { kind: "message", id: "old-user", role: "user", content: "pergunta antiga", timestampMs: 1, streaming: false },
      { kind: "message", id: "old-partial", role: "assistant", content: "resposta truncada", timestampMs: 2, streaming: false, isStreaming: false, completionState: "interrupted", turnId: "turn:old" },
    ]);
    const { registry, adapter } = fakeXai(["nova"]);
    const { runner } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "próxima" });
    await runner.flush("a");

    expect(adapter.invocations[0]?.req.messages).toEqual([
      { role: "user", content: "pergunta antiga" },
      { role: "user", content: "próxima" },
    ]);
  });

  it("resolveProvider custom (modelo global) é respeitado", async () => {
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("fake", { deltas: ["r"] });
    registry.register(adapter);
    const { runner } = makeRunner({
      registry,
      resolveProvider: () => ({ provider: "fake", model: "gpt-5.6-sol" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    expect(adapter.invocations[0]?.req.model).toBe("gpt-5.6-sol");
  });

  it("fixa provider e modelo no aceite mesmo se a configuração mudar durante a preparação", async () => {
    const registry = createProviderRegistry();
    const oldAdapter = createFakeAdapter("old", { deltas: ["old"] });
    const newAdapter = createFakeAdapter("new", { deltas: ["new"] });
    registry.register(oldAdapter);
    registry.register(newAdapter);
    let selected = { provider: "old", model: "old-model" };
    let releasePreparation!: () => void;
    let preparationStarted!: () => void;
    const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const started = new Promise<void>((resolve) => { preparationStarted = resolve; });
    const runner = createTurnRunner({
      registry,
      resolveProvider: () => selected,
      readAttachments: async () => {
        preparationStarted();
        await preparationGate;
        return [];
      },
    });

    runner.sendPrompt({ agentId: "a", prompt: "usar escolha atual", attachments: [{ path: "temp", name: "temp" }] });
    await started;
    selected = { provider: "new", model: "new-model" };
    releasePreparation();
    await runner.flush("a");

    expect(oldAdapter.invocations).toHaveLength(1);
    expect(oldAdapter.invocations[0]?.req.model).toBe("old-model");
    expect(newAdapter.invocations).toHaveLength(0);
  });

  it("provider que conclui vazio gera explicação explícita", async () => {
    const registry = createProviderRegistry();
    registry.register({ name: "empty", async streamChat() {} });
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      resolveProvider: () => ({ provider: "empty", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "responda", clientNonce: "nonce:empty" });
    await runner.flush("a");

    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
      kind: "notice",
      level: "error",
      text: "O provedor concluiu sem retornar conteúdo.",
      retryable: true,
      provider: "empty",
      model: "fake",
      clientNonce: "nonce:empty",
      turnId: expect.any(String),
    }));
    expect(store.getEntries("a").some((entry) => entry.kind === "message" && entry.role === "assistant")).toBe(false);
  });

  it("provider não registrado → notice de erro no transcript (sem quebrar a fila)", async () => {
    const registry = createProviderRegistry(); // vazio
    const store = createMemoryTranscriptStore();
    const { runner, events } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    // notice de erro no tail (kind "notice") — a fila não quebra
    const appended = allAppended(events);
    expect(appended.some((e) => e.kind === "notice")).toBe(true);
    expect(appended.some((e) => e.kind === "message" && e.role === "assistant")).toBe(false);

    // o agente continua aceitando novos turns
    const result = runner.sendPrompt({ agentId: "a", prompt: "de novo" });
    expect(await result).toEqual({ accepted: true });
    await runner.flush("a");
    const entries = store.getEntries("a");
    expect(entries.flatMap((entry) => entry.kind === "message" && entry.role === "user" ? [entry.content] : []))
      .toEqual(["p", "de novo"]);
    expect(entries.filter((entry) => entry.kind === "notice" && entry.level === "error")).toHaveLength(2);
  });
});
