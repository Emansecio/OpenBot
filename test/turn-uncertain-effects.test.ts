import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "../src/providers/router.js";
import { createTurnRunner } from "../src/rpc/send.js";
import type { TranscriptEntry } from "../src/shared/contracts.js";
import { SqliteTranscriptStore } from "../src/store/index.js";

describe.each(["io_error", "timed_out", "output_limit", "process_timeout", "process_output_limit"])("retry after uncertain effects (%s)", (code) => {
  it.each([false, true])("requires a new instruction (restart=%s)", async (restart) => {
    const root = mkdtempSync(join(tmpdir(), "openbot-uncertain-effect-"));
    const path = join(root, "store.db");
    let store = new SqliteTranscriptStore({ path });
    try {
      const conversationId = store.conversationStore.ensureDefault("a").id;
      const entries: TranscriptEntry[] = [
        { kind: "message", id: "user", role: "user", content: "fixture operation", timestampMs: 1,
          streaming: false, clientNonce: "nonce", turnId: "turn", provider: "xai", model: "grok-4.6",
          fromUser: { name: "Fixture", authId: "local" } },
        // Failed I/O or an interrupted process can leave earlier effects behind.
        // This fixture only seeds the transcript; it performs no tool operation.
        { kind: "tool-call", id: "tool", name: code === "io_error" ? "file.move" : "process.run", summary: "fixture", status: "failed",
          localToolCallId: "turn\0call", result: { ok: false, code, message: "Outcome uncertain" } },
        { kind: "notice", id: "failure", type: "provider-error", text: "Provider interrupted", level: "error",
          retryable: true, turnId: "turn", clientNonce: "nonce", provider: "xai", model: "grok-4.6" },
      ];
      store.beginTurnAttempt({ agentId: "a", conversationId, turnId: "turn", clientNonce: "nonce",
        provider: "xai", model: "grok-4.6", phase: "provider-pending", startedAtMs: 1 });
      store.append("a", entries, conversationId);
      store.rememberAcceptedNonce("a", "nonce", conversationId);
      if (restart) {
        store.close();
        store = new SqliteTranscriptStore({ path });
      } else {
        store.finishTurnAttempt("a", "turn");
      }
      let invocations = 0;
      const registry = createProviderRegistry();
      registry.register({ name: "xai", async streamChat(_request, emit) {
        invocations += 1;
        emit({ type: "delta", delta: "fixture response" });
      } });
      const runner = createTurnRunner({ store, registry });
      let rejection: unknown;
      try { await runner.retryPrompt("a", conversationId); } catch (error) { rejection = error; }
      await runner.flush("a");
      expect(rejection).toMatchObject({ status: 409, message: expect.stringContaining("possíveis efeitos") });
      expect(invocations).toBe(0);
      const actual = store.getEntries("a", conversationId);
      expect(actual.filter(entry => entry.kind === "message" && entry.role === "user")).toHaveLength(1);
      expect(actual.find(entry => entry.id === "tool")).toMatchObject(entries[1]!);
      if (restart) expect(actual.find(entry => entry.kind === "notice" && entry.type === "restart-interrupted"))
        .toMatchObject({ retryable: false });
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Semeia uma falha recuperável com efeitos opcionais, sem executar nada. */
function seedFailure(store: SqliteTranscriptStore, extra: TranscriptEntry[] = [], text = "Falha original") {
  const conversationId = store.conversationStore.ensureDefault("a").id;
  store.beginTurnAttempt({ agentId: "a", conversationId, turnId: "turn", clientNonce: "nonce",
    provider: "xai", model: "grok-4.6", phase: "provider-pending", startedAtMs: 1 });
  store.append("a", [
    { kind: "message", id: "user", role: "user", content: "fixture operation", timestampMs: 1,
      streaming: false, clientNonce: "nonce", turnId: "turn", provider: "xai", model: "grok-4.6",
      fromUser: { name: "Fixture", authId: "local" } },
    ...extra,
    { kind: "notice", id: "failure", type: "provider-error", text, level: "error",
      retryable: true, turnId: "turn", clientNonce: "nonce", provider: "xai", model: "grok-4.6" },
  ], conversationId);
  store.rememberAcceptedNonce("a", "nonce", conversationId);
  store.finishTurnAttempt("a", "turn");
  return conversationId;
}

describe("backend-provided recovery actions", () => {
  const withStore = async (extra: TranscriptEntry[], run: (store: SqliteTranscriptStore, conversationId: string) => Promise<void> | void) => {
    const root = mkdtempSync(join(tmpdir(), "openbot-recovery-"));
    const store = new SqliteTranscriptStore({ path: join(root, "store.db") });
    try { await run(store, seedFailure(store, extra)); }
    finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  };
  const registryFor = (counter: { calls: number }) => {
    const registry = createProviderRegistry();
    registry.register({ name: "xai", async streamChat(_request, emit) {
      counter.calls += 1;
      emit({ type: "delta", delta: "fixture response" });
    } });
    return registry;
  };

  it("indica somente conferir resultados quando repetir pode duplicar efeitos", async () => {
    await withStore([{ kind: "tool-call", id: "tool", name: "process.run", summary: "fixture", status: "failed",
      localToolCallId: "turn\0call", result: { ok: false, code: "timed_out", message: "Outcome uncertain" } }],
    async (store, conversationId) => {
      const counter = { calls: 0 };
      const runner = createTurnRunner({ store, registry: registryFor(counter) });
      expect(runner.getPromptRecovery("a", conversationId)).toEqual({
        conversationId,
        failure: { entryId: "failure", turnId: "turn", actions: ["inspect"],
          historyEntryIds: expect.arrayContaining(["user", "tool", "failure"]) },
      });
      // A consulta é somente leitura: nada é reenviado nem executado.
      expect(counter.calls).toBe(0);
      expect(store.getEntries("a", conversationId).filter(entry => entry.kind === "message" && entry.role === "user")).toHaveLength(1);
      expect(() => runner.retryPrompt("a", conversationId)).toThrow(/possíveis efeitos/);
      expect(counter.calls).toBe(0);
    });
  });

  it("indica tentar novamente quando as regras atuais permitem e não duplica o trabalho", async () => {
    await withStore([], async (store, conversationId) => {
      const counter = { calls: 0 };
      const runner = createTurnRunner({ store, registry: registryFor(counter) });
      expect(runner.getPromptRecovery("a", conversationId).failure).toMatchObject({ entryId: "failure", actions: ["retry"] });
      await expect(runner.retryPrompt("a", conversationId, "failure")).resolves.toEqual({ accepted: true });
      await runner.flush("a");
      expect(counter.calls).toBe(1);
      // Clique repetido: a mesma aceitação, sem novo turno.
      await expect(runner.retryPrompt("a", conversationId, "failure")).resolves.toEqual({ accepted: true });
      await runner.flush("a");
      expect(counter.calls).toBe(1);
      // O retry reusa o pedido original: uma única mensagem e um único turno novo.
      const entries = store.getEntries("a", conversationId);
      expect(entries.filter(entry => entry.kind === "message" && entry.role === "user")).toHaveLength(1);
      expect(entries.filter(entry => entry.kind === "notice" && entry.type === "retry-attempt")).toHaveLength(1);
    });
  });

  it("não oferece ação automática quando a conversa avançou e recusa a ação antiga", async () => {
    await withStore([], async (store, conversationId) => {
      const counter = { calls: 0 };
      const runner = createTurnRunner({ store, registry: registryFor(counter) });
      expect(runner.getPromptRecovery("a", conversationId).failure).toMatchObject({ actions: ["retry"] });
      store.append("a", [{ kind: "message", id: "later", role: "user", content: "nova instrução", timestampMs: 2,
        streaming: false, turnId: "turn:later", provider: "xai", model: "grok-4.6",
        fromUser: { name: "Fixture", authId: "local" } }], conversationId);
      // A falha continua identificável, mas nenhuma ação automática é segura.
      expect(runner.getPromptRecovery("a", conversationId)).toEqual({
        conversationId,
        failure: { entryId: "failure", turnId: "turn", actions: [], historyEntryIds: expect.arrayContaining(["failure"]) },
      });
      expect(() => runner.retryPrompt("a", conversationId, "failure")).toThrow(/avançou/);
      expect(counter.calls).toBe(0);
    });
  });

  it("mantém as mesmas ações quando a redação do erro muda", async () => {
    await withStore([], async (store, conversationId) => {
      const runner = createTurnRunner({ store, registry: registryFor({ calls: 0 }) });
      const before = runner.getPromptRecovery("a", conversationId);
      const failure = store.getEntries("a", conversationId).find(
        (entry): entry is Extract<TranscriptEntry, { kind: "notice" }> => entry.id === "failure",
      )!;
      store.replace("a", "failure", { ...failure, text: "Provider exhausted its quota. Try again later." });
      store.replace("a", "failure", { ...failure, text: "O provedor esgotou a cota. Tente novamente mais tarde." });
      expect(runner.getPromptRecovery("a", conversationId)).toEqual(before);
      expect(before.failure?.actions).toEqual(["retry"]);
    });
  });

  it("não confunde efeitos incertos com uma falha diferente", async () => {
    await withStore([{ kind: "tool-call", id: "tool", name: "file.read", summary: "fixture", status: "completed",
      localToolCallId: "other-turn\0call", result: { ok: true } }],
    async (store, conversationId) => {
      const runner = createTurnRunner({ store, registry: registryFor({ calls: 0 }) });
      // Efeito de outro turno não bloqueia a ação desta falha.
      expect(runner.getPromptRecovery("a", conversationId).failure).toMatchObject({ actions: ["retry"] });
    });
  });

  it("localiza o histórico pela identidade do turno, não pela posição na conversa", async () => {
    await withStore([{ kind: "tool-call", id: "tool", name: "process.run", summary: "fixture", status: "failed",
      localToolCallId: "turn\0call", result: { ok: false, code: "timed_out", message: "Outcome uncertain" } }],
    async (store, conversationId) => {
      const runner = createTurnRunner({ store, registry: registryFor({ calls: 0 }) });
      // Um turno posterior não pode contribuir com identidades para a falha anterior.
      store.append("a", [
        { kind: "message", id: "later-user", role: "user", content: "nova instrução", timestampMs: 5,
          streaming: false, turnId: "turn:later", provider: "xai", model: "grok-4.6",
          fromUser: { name: "Fixture", authId: "local" } },
        { kind: "message", id: "later-assistant", role: "assistant", content: "resposta posterior", timestampMs: 6,
          streaming: false, turnId: "turn:later", provider: "xai", model: "grok-4.6" },
        { kind: "tool-call", id: "later-tool", name: "file.read", summary: "fixture", status: "completed",
          localToolCallId: "turn:later\0call", result: { ok: true } },
      ], conversationId);
      const failure = runner.getPromptRecovery("a", conversationId).failure!;
      expect(failure.turnId).toBe("turn");
      expect(failure.historyEntryIds).toEqual(expect.arrayContaining(["user", "tool", "failure"]));
      for (const foreign of ["later-user", "later-assistant", "later-tool"]) {
        expect(failure.historyEntryIds).not.toContain(foreign);
      }
    });
  });

  it("reconsulta o backend sem executar nada quando o identificador não é a falha atual", async () => {
    await withStore([], async (store, conversationId) => {
      const counter = { calls: 0 };
      const runner = createTurnRunner({ store, registry: registryFor(counter) });
      expect(() => runner.retryPrompt("a", conversationId, "notice:outra")).toThrow(/não é mais a falha atual/);
      expect(counter.calls).toBe(0);
      expect(runner.getPromptRecovery("other-agent", conversationId)).toEqual({ conversationId, failure: null });
    });
  });
});
