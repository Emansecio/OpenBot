/**
 * T2 — Testes de shape contra as fixtures golden authoradas dos mapas
 * (mapa-frontend §3.2/§3.3, mapa-funcoes §4.5). Verifica que TODA entry e
 * TODA variante de card são reconhecidas pelo contrato congelado — é isso que
 * garante "nenhum card missing" na UI (critério de DONE da Fase 1, plano §7).
 */

import { describe, expect, it } from "vitest";
import type {
  SendMessagePayload,
  SendMessageType,
  TranscriptEntryKind,
} from "../src/shared/contracts.js";
import { MODEL_CATALOG } from "../src/config/models.js";

import transcriptPageFixture from "./fixtures/transcript-page.json" with { type: "json" };
import sendMessageKindsFixture from "./fixtures/send-message-kinds.json" with { type: "json" };
import rpcEnvelopesFixture from "./fixtures/rpc-envelopes.json" with { type: "json" };
import sseEventsFixture from "./fixtures/sse-events.json" with { type: "json" };
import stubsFixture from "./fixtures/stubs-box-settings-models.json" with { type: "json" };

const sendMessageCardShapes = {
  kinds: ["message", "send-message", "user-attachment", "tool-call", "notice", "event", "widget", "tool-request"],
  types: [
    "text",
    "attachment",
    "widget",
    "cursor-agent",
    "secret-request",
    "email-draft",
    "slack-draft",
    "permission-request",
    "auto-review-approval",
    "local-tool-permission",
    "connector",
    "connectors",
    "listener-connect",
  ],
} as const satisfies { kinds: readonly TranscriptEntryKind[]; types: readonly SendMessageType[] };
const modelCatalogEntries = MODEL_CATALOG;

type MissingTranscriptEntryKind = Exclude<TranscriptEntryKind, typeof sendMessageCardShapes.kinds[number]>;
type MissingSendMessageType = Exclude<SendMessageType, typeof sendMessageCardShapes.types[number]>;

const transcriptKindsAreExhaustive: MissingTranscriptEntryKind extends never ? true : false = true;
const sendMessageTypesAreExhaustive: MissingSendMessageType extends never ? true : false = true;

function expectSendMessagePayload(value: unknown): asserts value is SendMessagePayload {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  const message = value as Record<string, unknown>;
  expect(message.type).toBeTypeOf("string");
  expect(sendMessageCardShapes.types).toContain(message.type);

  if (message.type === "local-tool-permission") {
    expect(message.ask).toEqual(expect.objectContaining({
      status: expect.stringMatching(/^(pending|expired)$/u),
      requestId: expect.any(String),
      action: expect.stringMatching(/^(run-command|send-input|read-file|list-directory|write-file)$/u),
      target: expect.any(String),
    }));
  }
}

describe("fixtures golden — shapes dos mapas (T2)", () => {
  it("transcript-page.json: SandTranscriptPage {entries[], nextBeforeSeq?}", () => {
    const page = transcriptPageFixture.value;
    expect(Array.isArray(page.entries)).toBe(true);
    expect(page).not.toHaveProperty("nextCursor");
    const nextBeforeSeq = Reflect.get(page, "nextBeforeSeq") as unknown;
    expect(nextBeforeSeq === undefined || typeof nextBeforeSeq === "number").toBe(true);
    expect(page.entries.length).toBeGreaterThan(0);
    expect(transcriptKindsAreExhaustive).toBe(true);

    for (const entry of page.entries) {
      expect(sendMessageCardShapes.kinds).toContain(entry.kind);
    }

    // kinds específicos do contrato congelado
    const firstEntry = page.entries[0];
    if (firstEntry === undefined) throw new Error("transcript fixture has no entries");
    expect(firstEntry.kind).toBe("message");
    expect(["user", "assistant"]).toContain(firstEntry.role);
    expect(typeof firstEntry.content).toBe("string");
    expect(typeof firstEntry.timestampMs).toBe("number");

    const attachment = page.entries.find((e) => e.kind === "user-attachment");
    if (attachment === undefined) throw new Error("transcript fixture has no attachment");
    expect(typeof attachment.file_name).toBe("string");
    expect(typeof attachment.file_path).toBe("string");

    const toolCall = page.entries.find((e) => e.kind === "tool-call");
    expect(["pending", "running", "completed", "failed"]).toContain(toolCall?.status);
  });

  it("send-message-kinds.json: todas as variantes de message.type da union são reconhecidas", () => {
    const entries = sendMessageKindsFixture.value.entries;
    expect(entries.map((entry) => entry.message.type)).toEqual(sendMessageCardShapes.types);
    expect(sendMessageTypesAreExhaustive).toBe(true);

    for (const entry of entries) {
      expect(entry.kind).toBe("send-message");
      expectSendMessagePayload(entry.message);
    }
  });

  it("rpc-envelopes.json: envelopes {ok,value} / {ok:false,failure}", () => {
    const env = rpcEnvelopesFixture.value;
    expect(env.ok.ok).toBe(true);
    expect("value" in env.ok).toBe(true);
    expect(env.failure.ok).toBe(false);
    expect(typeof env.failure.failure).toBe("string");
  });

  it("sse-events.json: {channel, payload} com snapshot/appended + heartbeat/retry", () => {
    const sse = sseEventsFixture.value;
    expect(typeof sse.event.channel).toBe("string");
    expect(typeof sse.event.payload.type).toBe("string");
    expect(sse.event.payload.type).toBe("appended");
    expect(sse.event.payload.agentId).toBe("openbot-default");
    expect(sse.event.payload.entry.kind).toBe("send-message");
    expect("entries" in sse.event.payload).toBe(false);

    expect(sse.snapshot.payload.type).toBe("snapshot");
    expect(sse.snapshot.payload.agentId).toBe("openbot-default");
    expect(Array.isArray(sse.snapshot.payload.entries)).toBe(true);
    expect(sse.heartbeat).toBe(":ping");
    expect(sse.retry).toBe(1000);
  });

  it("stubs-box-settings-models.json: box stub inerte + host settings + catálogo", () => {
    const stubs = stubsFixture.value;

    // Decisão §8.4: VNC stubs inertes
    expect(stubs.foreverBoxStatus.vncUrl).toBeNull();
    expect(Array.isArray(stubs.foreverBoxStatus.windows)).toBe(true);

    // SandHostSettings (mapa-funcoes §4.5)
    expect(typeof stubs.hostSettings.timezone).toBe("string");
    expect(Array.isArray(stubs.hostSettings.pinnedAgents)).toBe(true);
    expect(["ask", "always", "never"]).toContain(stubs.hostSettings.localToolPermission);

    // Catálogo estático (Decisão §8.3) — cada entrada bate com ModelCatalogEntry
    expect(Array.isArray(stubs.availableModels)).toBe(true);
    expect(stubs.availableModels).toEqual(modelCatalogEntries.filter(({ provider }) => provider !== "opencode-go").map(({ id, provider, displayName, default: isDefault }) => ({
      id,
      provider,
      displayName,
      ...(isDefault === undefined ? {} : { default: isDefault }),
    })));

    // Flags (T13)
    expect(stubs.flags.isAgentNetworkEnabled).toBe(false);
    expect(stubs.flags.isGlobalSearchEnabled).toBe(true);
    expect(stubs.flags.isEgressTunnelAvailable).toBe(false);
  });
});
