
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createProviderRegistry } from "../src/providers/router.js";
import { createFakeAdapter } from "./mocks/fake-provider-adapter.js";
import { createMemoryTranscriptStore, createTurnRunner } from "../src/rpc/send.js";
import type { TranscriptEntry } from "../src/shared/contracts.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { collectPublish, makeRunner, fakeXai } from "./helpers/turn-runner.js";

/** Todas as entries dos eventos appended do canal transcript. */
function allAppended(events: ReturnType<typeof collectPublish>["events"]): TranscriptEntry[] {
  return events
    .filter((e) => e.channel === "transcript" && (e.payload as { type: string }).type === "appended")
    .map((e) => (e.payload as { entry: TranscriptEntry }).entry);
}

describe("T10 eventos SSE transcript — snapshot no início / appended no tail", () => {
  it("snapshot com o histórico existente ANTES do turno (reset do cliente)", async () => {
    const store = createMemoryTranscriptStore();
    store.append("a", [
      { kind: "message", id: "id:prev", role: "assistant", content: "histórico", timestampMs: 1, streaming: false },
    ]);
    const { registry } = fakeXai();
    const { runner, events } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    const snapshots = events.filter((e) => e.channel === "transcript" && (e.payload as { type: string }).type === "snapshot");
    expect(snapshots).toHaveLength(1);
    const first = snapshots[0] as { payload: { type: "snapshot"; agentId: string; entries: TranscriptEntry[] } };
    expect(first.payload.agentId).toBe("a");
    expect(first.payload.entries).toHaveLength(1);
    const previous = first.payload.entries[0];
    expect(previous?.kind === "message" ? previous.id : undefined).toBe("id:prev");
  });

  it("limita snapshot grande e sinaliza resync sem perder appended do turno", async () => {
    const store = createMemoryTranscriptStore();
    store.append("a", Array.from({ length: 400 }, (_, index) => ({
      kind: "message" as const,
      id: `history:${index}`,
      role: "assistant" as const,
      content: "x".repeat(1024),
      timestampMs: index,
      streaming: false,
    })));
    const { registry } = fakeXai(["ok"]);
    const { runner, events } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    const snapshot = events.find((event) => (
      event.channel === "transcript" && (event.payload as { type?: string }).type === "snapshot"
    ))?.payload as {
      type: string;
      entries: TranscriptEntry[];
      truncated?: boolean;
      resyncRequired?: boolean;
    } | undefined;
    expect(snapshot?.entries.length).toBeLessThan(400);
    expect(snapshot?.truncated).toBe(true);
    expect(snapshot?.resyncRequired).toBe(true);
    expect(Buffer.byteLength(`data: ${JSON.stringify({ channel: "transcript", payload: snapshot })}\n\n`, "utf8"))
      .toBeLessThanOrEqual(256 * 1024);
    expect(allAppended(events).some((entry) => entry.kind === "message" && entry.role === "user" && entry.content === "p"))
      .toBe(true);
    // The trim is exact: the newest entries that fit are all kept, and one
    // more (older) entry would overflow the frame.
    const frameBytes = (payload: unknown) => Buffer.byteLength(`data: ${JSON.stringify({ channel: "transcript", payload })}\n\n`, "utf8");
    const firstKept = snapshot!.entries[0] as { id: string };
    const olderIndex = Number(firstKept.id.split(":")[1]) - 1;
    const older = store.getEntries("a").find((entry) => (entry as { id?: string }).id === `history:${olderIndex}`);
    expect(older).toBeDefined();
    expect(frameBytes({ ...snapshot, entries: [older, ...snapshot!.entries] })).toBeGreaterThan(256 * 1024);
  });

  it("appended: mensagem do usuário + resposta textual única do assistente", async () => {
    const { registry } = fakeXai(["Olá, ", "mundo!"]);
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "oi" });
    await runner.flush("a");

    const appended = allAppended(events);

    const user = appended.find((e) => e.kind === "message" && e.role === "user");
    expect(user).toMatchObject({
      kind: "message",
      role: "user",
      content: "oi",
      fromUser: { name: "You", authId: "local-user" },
      streaming: false,
    });
    expect(user).not.toHaveProperty("toAgent");
    expect(typeof (user as { id: string }).id).toBe("string");
    expect(typeof (user as { timestampMs: number }).timestampMs).toBe("number");

    const firstAssistant = appended.find((e) => e.kind === "message" && e.role === "assistant");
    expect(firstAssistant).toMatchObject({
      kind: "message",
      role: "assistant",
      streaming: true,
    });
    expect(firstAssistant).not.toHaveProperty("fromAgent");
    expect(firstAssistant).not.toHaveProperty("clientNonce");
    const updated = events
      .filter((e) => e.channel === "transcript" && (e.payload as { type?: string }).type === "updated")
      .map((e) => (e.payload as { entry: TranscriptEntry }).entry);
    const assistant = [...updated].reverse().find((e) => e.kind === "message" && e.role === "assistant" && e.streaming === false)
      ?? [...appended].reverse().find((e) => e.kind === "message" && e.role === "assistant" && e.streaming === false);
    expect(assistant).toMatchObject({
      kind: "message",
      role: "assistant",
      content: "Olá, mundo!",
      streaming: false,
    });
    expect(assistant).not.toHaveProperty("fromAgent");
    expect(assistant).not.toHaveProperty("clientNonce");

    // A mensagem final já é a entry `message` fechada. Um card textual
    // paralelo exibiria a mesma resposta novamente; cards não textuais não
    // são afetados por esta regra.
    expect(appended.filter((e) => e.kind === "send-message" && e.message.type === "text")).toHaveLength(0);
  });

  it("attachments → entries user-attachment com file_name/file_path (mapa-frontend §3.3)", async () => {
    const { registry } = fakeXai();
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({
      agentId: "a",
      prompt: "leia isto",
      attachments: [{ path: "C:\\docs\\notas.md", name: "notas.md" }],
      clientNonce: "nonce:att",
    });
    await runner.flush("a");

    const att = allAppended(events).find((e) => e.kind === "user-attachment");
    expect(att).toMatchObject({
      kind: "user-attachment",
      file_name: "notas.md",
      file_path: "C:\\docs\\notas.md",
      clientNonce: "nonce:att",
    });
  });

  it("associa anexos homônimos pela posição, sem reutilizar o primeiro conteúdo", async () => {
    const { registry } = fakeXai();
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      readAttachments: async () => [
        { name: "igual.md", path: "C:\\a\\igual.md", text: "primeiro" },
        { name: "igual.md", path: "C:\\b\\igual.md", text: "segundo" },
      ],
    });
    runner.sendPrompt({
      agentId: "a",
      prompt: "compare",
      attachments: [
        { path: "C:\\a\\igual.md", name: "igual.md" },
        { path: "C:\\b\\igual.md", name: "igual.md" },
      ],
    });
    await runner.flush("a");

    const attachments = store.getEntries("a").filter((entry) => entry.kind === "user-attachment");
    expect(attachments.map((entry) => entry.extractedText)).toEqual(["primeiro", "segundo"]);
  });

  it("tool-call do roteador → entry tool-call (name/summary/status) no transcript", async () => {
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("xai", {
      deltas: ["Vou executar"],
      toolCalls: [{ id: "call_1", name: "shell", arguments: '{"cmd":"dir"}' }],
    });
    registry.register(adapter);
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "rode" });
    await runner.flush("a");

    const tool = allAppended(events).find((e) => e.kind === "tool-call");
    expect(tool).toMatchObject({
      kind: "tool-call",
      id: "call_1",
      name: "shell",
      summary: "tool shell",
      status: "completed",
    });
    expect(JSON.stringify(tool)).not.toContain('{"cmd":"dir"}');
  });

  it("não sobrescreve cards quando o provider repete o id de tool call", async () => {
    const registry = createProviderRegistry();
    registry.register(createFakeAdapter("xai", {
      toolCalls: [
        { id: "same", name: "first", arguments: "{}" },
        { id: "same", name: "second", arguments: "{}" },
      ],
    }));
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "rode" });
    await runner.flush("a");

    const cards = allAppended(events).filter((entry) => entry.kind === "tool-call");
    expect(cards).toHaveLength(2);
    expect(cards.map(card => card.kind === "tool-call" ? card.id : "")).toEqual(["same", expect.stringMatching(/^anon:/u)]);
  });

  it("erro do provider → notice de erro (kind notice) no tail", async () => {
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("xai", {
      deltas: ["x"],
      error: Object.assign(new Error("chave inválida"), { status: 401 }),
    });
    registry.register(adapter);
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    const appended = allAppended(events);
    const notice = appended.find((e) => e.kind === "notice");
    expect(notice).toMatchObject({ kind: "notice", status: 401 });
    expect(notice?.kind === "notice" ? notice.text : "").toMatch(/chave.*configurações/i);
    // sem message/send-message falsos após o erro
    expect(appended.some((e) => e.kind === "send-message")).toBe(false);
  });

  it("erro retryable persiste mensagem clara e metadados da tentativa", async () => {
    const registry = createProviderRegistry();
    registry.register(createFakeAdapter("xai", {
      deltas: ["parcial"],
      error: Object.assign(new Error("raw provider rate limit"), { status: 429, code: "rate_limit" }),
    }));
    const store = createMemoryTranscriptStore();
    const { runner } = makeRunner({ registry, store });

    runner.sendPrompt({ agentId: "a", prompt: "p", clientNonce: "nonce:rate" });
    await runner.flush("a");

    const notice = store.getEntries("a").find((entry) => entry.kind === "notice");
    expect(notice).toMatchObject({
      kind: "notice",
      level: "error",
      retryable: true,
      providerErrorKind: "rate-limit",
      providerErrorCode: "rate_limit",
      provider: "xai",
      model: "grok-4.6",
      clientNonce: "nonce:rate",
    });
    expect(notice?.kind === "notice" ? notice.text : "").toMatch(/limite de uso/i);
    expect(notice?.kind === "notice" ? notice.turnId : undefined).toMatch(/^turn:/u);
  });

  it("snapshot vem ANTES de qualquer appended (ordem do canal)", async () => {
    const { registry } = fakeXai();
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    const transcriptEvents = events.filter((e) => e.channel === "transcript");
    expect(transcriptEvents[0]?.payload).toMatchObject({ type: "snapshot" });
    const appendedIdx = transcriptEvents.findIndex((e) => (e.payload as { type: string }).type === "appended");
    expect(appendedIdx).toBeGreaterThan(0);
  });
});

describe("T10 — stream incremental reusa o mesmo id", () => {
  it("openAgentTail expõe o preview live mais recente antes da persistência periódica", async () => {
    const registry = createProviderRegistry();
    let now = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    registry.register({
      name: "xai",
      async streamChat(_request, emit) {
        emit({ type: "delta", delta: "E2E " });
        now = 400;
        emit({ type: "delta", delta: "incremental " });
        now = 800;
        emit({ type: "delta", delta: "stream " });
        await blocked;
      },
    });
    const store = createMemoryTranscriptStore();
    const { runner, events } = makeRunner({ registry, store, now: () => now });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const assistant = store.openAgentTail("a").entries.find((entry) => (
        entry.kind === "message" && entry.role === "assistant"
      ));
      expect(assistant).toMatchObject({
        content: "E2E incremental stream ",
        streaming: true,
      });
      const orderedTranscriptEvents = events
        .filter((event) => event.channel === "transcript")
        .map((event) => event.payload as {
          type?: string;
          ordered?: { replicaKey: string; epoch: string; sequence: number };
          resyncRequired?: boolean;
        });
      expect(orderedTranscriptEvents.some((event) => event.type === "updated" && event.resyncRequired === true)).toBe(false);
      const nonDelta = orderedTranscriptEvents.filter((event) => event.type !== "delta");
      expect(nonDelta.some((event) => event.ordered?.replicaKey === "transcript:a")).toBe(true);
      const deltas = orderedTranscriptEvents.filter((event) => event.type === "delta");
      expect(deltas.every((event) => event.ordered?.replicaKey === "transcript:a")).toBe(true);
      const firstDeltaSequence = deltas[0]?.ordered?.sequence ?? 0;
      expect(deltas.map((event) => event.ordered?.sequence)).toEqual(
        deltas.map((_, index) => firstDeltaSequence + index),
      );
    } finally {
      release();
      await runner.flush("a");
    }
  });

  it("publica o primeiro delta antes do provider concluir", async () => {
    const registry = createProviderRegistry();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    registry.register({
      name: "xai",
      async streamChat(request, emit) {
        expect(request.tools).toBeUndefined();
        emit({ type: "delta", delta: "parcial" });
        await blocked;
        emit({ type: "delta", delta: " final" });
      },
    });
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const assistantBeforeDone = allAppended(events).find((entry) => entry.kind === "message" && entry.role === "assistant");
    expect(assistantBeforeDone).toMatchObject({
      kind: "message",
      role: "assistant",
      content: "",
      streaming: true,
    });
    expect(events.some((event) => (
      event.channel === "transcript" && (event.payload as { type?: string }).type === "delta"
    ))).toBe(true);

    release();
    await runner.flush("a");
  });

  it("usa openAgentTail limitado para o snapshot inicial do SQLite e preserva os 500 mais novos", async () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      store.append("a", Array.from({ length: 20_000 }, (_, index) => ({
        kind: "message" as const,
        id: `history:${index}`,
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `h${index}`,
        timestampMs: index,
        streaming: false,
      })));
      const getEntries = store.getEntries.bind(store);
      const openDurableAgentTail = store.openDurableAgentTail.bind(store);
      let tailReads = 0;
      store.getEntries = () => {
        throw new Error("full transcript snapshot");
      };
      store.openDurableAgentTail = (agentId, limit, beforeSeq, conversationId) => {
        tailReads += 1;
        return openDurableAgentTail(agentId, limit, beforeSeq, conversationId);
      };
      const { registry } = fakeXai(["ok"]);
      const { runner, events } = makeRunner({ registry, store });

      runner.sendPrompt({ agentId: "a", prompt: "final" });
      await runner.flush("a");

      const snapshot = events.find((event) => event.channel === "transcript" && (event.payload as { type?: string }).type === "snapshot")
        ?.payload as { entries: TranscriptEntry[]; truncated?: boolean; resyncRequired?: boolean; method?: string } | undefined;
      expect(tailReads).toBe(1);
      expect(snapshot?.entries).toHaveLength(500);
      expect(snapshot?.entries[0]).toMatchObject({ id: "history:19500" });
      expect(snapshot?.entries.at(-1)).toMatchObject({ id: "history:19999" });
      expect(snapshot).toMatchObject({ truncated: true, resyncRequired: true, method: "openAgentTail" });
      expect(() => getEntries("a")).not.toThrow();
    } finally {
      store.close();
    }
  });

  it("deltas geram uma entry streaming e o texto final fecha no mesmo id", async () => {
    const { registry } = fakeXai(["a", "b", "c"]);
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    const assistantMessages = allAppended(events).filter((e) => e.kind === "message" && e.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect((assistantMessages[0] as { streaming?: boolean }).streaming).toBe(true);
    const updated = events
      .filter((e) => e.channel === "transcript" && (e.payload as { type?: string }).type === "updated")
      .map((e) => (e.payload as { entry: TranscriptEntry }).entry)
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "message" }> => (
        entry.kind === "message" && entry.role === "assistant"
      ));
    const final = updated.reverse().find((entry) => entry.streaming === false);
    expect(final).toMatchObject({ content: "abc", id: (assistantMessages[0] as { id: string }).id });
    const deltaEvents = events
      .filter((event) => event.channel === "transcript" && (event.payload as { type?: string }).type === "delta")
      .map((event) => event.payload as { type: "delta"; entryId: string; fragment: string; ordered: { replicaKey: string; epoch: string; sequence: number } });
    expect(deltaEvents.map((event) => event.fragment).join("")).toBe("abc");
    expect(deltaEvents).toHaveLength(3);
    expect(new Set(deltaEvents.map((event) => event.entryId)).size).toBe(1);
    const orderedEvents = events
      .filter((event) => event.channel === "transcript" && (event.payload as { ordered?: unknown }).ordered !== undefined)
      .map((event) => (event.payload as { ordered: { replicaKey: string; epoch: string; sequence: number } }).ordered);
    expect(orderedEvents.every((event) => event.replicaKey === "transcript:a")).toBe(true);
    expect(new Set(orderedEvents.map((event) => event.epoch)).size).toBe(1);
    expect(orderedEvents.map((event) => event.sequence)).toEqual(
      orderedEvents.map((_, index) => index + 1),
    );
    const finalPayload = [...events].reverse().find((event) => (
      event.channel === "transcript" && (event.payload as { type?: string; final?: boolean }).type === "updated"
        && (event.payload as { final?: boolean }).final === true
    ))?.payload as { throughSequence?: number; final?: boolean; ordered?: { sequence: number } } | undefined;
    expect(finalPayload).toMatchObject({ final: true, throughSequence: deltaEvents.at(-1)!.ordered.sequence });
  });

  it("mantém uma única namespace ordenada por agente, sem mapa por turno", async () => {
    const { registry } = fakeXai(["ok"]);
    const { runner } = makeRunner({ registry });
    for (let index = 0; index < 24; index += 1) {
      runner.sendPrompt({ agentId: "a", prompt: `p-${index}` });
      await runner.flush("a");
    }

    const orderMap = (runner as unknown as { transcriptOrderByKey: Map<string, unknown> }).transcriptOrderByKey;
    expect([...orderMap.keys()]).toEqual(["transcript:a"]);
  });

  it("fenceia o epoch por agente antes de um resync autoritativo", async () => {
    const { registry } = fakeXai(["before"]);
    const { runner, events } = makeRunner({ registry });
    runner.sendPrompt({ agentId: "a", prompt: "before" });
    await runner.flush("a");
    const beforeEpoch = events
      .filter((event) => event.channel === "transcript")
      .map((event) => (event.payload as { ordered?: { epoch?: string } }).ordered?.epoch)
      .find((epoch): epoch is string => epoch !== undefined);

    runner.rotateTranscriptEpoch("a");
    runner.publishConversationSnapshot("a");
    const afterEpochs = events
      .filter((event) => event.channel === "transcript")
      .map((event) => (event.payload as { ordered?: { epoch?: string } }).ordered?.epoch)
      .filter((epoch): epoch is string => epoch !== undefined);
    expect(afterEpochs.at(-1)).toBeDefined();
    expect(afterEpochs.at(-1)).not.toBe(beforeEpoch);
    expect((events.at(-1)?.payload as { ordered?: { sequence?: number } }).ordered?.sequence).toBe(1);
  });

  it("todo snapshot emitido carrega activeAgentId igual a agentId", async () => {
    const { registry } = fakeXai();
    const { runner, events } = makeRunner({ registry });

    runner.sendPrompt({ agentId: "a", prompt: "p" });
    await runner.flush("a");

    const snapshots = events
      .filter((event) => event.channel === "transcript" && (event.payload as { type?: string }).type === "snapshot")
      .map((event) => event.payload as {
        type: "snapshot";
        agentId: string;
        activeAgentId: string;
        entries: TranscriptEntry[];
      });
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      expect(snapshot.agentId).toBe("a");
      expect(snapshot.activeAgentId).toBe("a");
      expect(snapshot.activeAgentId).toBe(snapshot.agentId);
    }
  });
});
