/**
 * T2 — Testes de shape do contrato congelado (src/shared/contracts.ts).
 * Expõe helpers de shape reutilizados pelos testes de fixtures golden.
 * Checklist de revisão das fixtures contra os mapas: ver README §T2.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeTranscriptEntry,
  type BoxSecretsStatus,
  type ModelCatalogEntry,
  type RpcEnvelope,
  type SandForeverBoxStatus,
  type SandHostSettings,
  type SandSendPromptArgs,
  type SandTranscriptPage,
  type SendMessagePayload,
  type SendMessageType,
  type SseEvent,
  type TranscriptEntry,
  type TranscriptEntryKind,
} from "../src/shared/contracts.js";
import { MODEL_CATALOG } from "../src/config/models.js";

function exhaustiveTranscriptEntryKinds<Values extends readonly TranscriptEntryKind[]>(
  values: Values & ([Exclude<TranscriptEntryKind, Values[number]>] extends [never] ? unknown : never),
): Values {
  return values;
}

function exhaustiveSendMessageTypes<Values extends readonly SendMessageType[]>(
  values: Values & ([Exclude<SendMessageType, Values[number]>] extends [never] ? unknown : never),
): Values {
  return values;
}

/** Shapes esperados pelo contrato (espelho do que a UI consome, mapa-frontend §3.3). */
export const sendMessageCardShapes = {
  kinds: exhaustiveTranscriptEntryKinds([
    "message",
    "send-message",
    "user-attachment",
    "tool-call",
    "notice",
    "event",
    "widget",
    "tool-request",
  ] as const),
  types: exhaustiveSendMessageTypes([
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
  ] as const),
} as const;

export const modelCatalogEntries = MODEL_CATALOG satisfies ModelCatalogEntry[];

describe("contrato congelado (T2) — shapes", () => {
  it("TranscriptEntryKind cobre os kinds observados do mapa (sem card missing)", () => {
    expect(sendMessageCardShapes.kinds).toHaveLength(8);
    expect(new Set(sendMessageCardShapes.kinds)).toHaveLength(8);
  });

  it("SendMessageType cobre a union message.type (13 variantes)", () => {
    expect(sendMessageCardShapes.types).toHaveLength(13);
    expect(new Set(sendMessageCardShapes.types)).toHaveLength(13);
  });

  it("tipos do contrato compilam contra os shapes dos mapas", () => {
    // SandTranscriptPage {entries[], nextCursor?} — mapa-frontend §3.3
    const page: SandTranscriptPage = {
      entries: [
        {
          kind: "message",
          id: "ai:1",
          role: "assistant",
          content: "oi",
          timestampMs: 1,
        },
        {
          kind: "send-message",
          message: { type: "text", text: "oi" },
          author: "openbot-default",
        },
        {
          kind: "user-attachment",
          file_name: "a.md",
          file_path: "C:\\a.md",
        },
        {
          kind: "tool-call",
          name: "shell",
          summary: "rodando",
          status: "pending",
        },
        { kind: "notice", text: "ok" },
        { kind: "event", type: "automation-changed" },
      ],
      nextBeforeSeq: 1,
    };
    expect(page.entries).toHaveLength(6);

    // sendPrompt args — mapa-frontend §3.4 / mapa-funcoes §5.1
    const sendArgs: SandSendPromptArgs = {
      agentId: "openbot-default",
      prompt: "olá",
      richText: "olá",
      attachments: [{ path: "C:\\a.md", name: "a.md" }],
      clientNonce: "nonce:abc",
    };
    expect(sendArgs.agentId).toBe("openbot-default");

    // Envelopes RPC — mapa-frontend §3.2
    const okEnv: RpcEnvelope<{ accepted: true }> = { ok: true, value: { accepted: true } };
    const failEnv: RpcEnvelope<unknown> = { ok: false, failure: "erro" };
    expect(okEnv.ok).toBe(true);
    expect(failEnv.ok).toBe(false);

    // Evento SSE {channel, payload} — mapa-funcoes §4.5
    const evt: SseEvent = { channel: "transcript", payload: { type: "snapshot", entries: [] } };
    expect(evt.channel).toBe("transcript");

    // Stubs inertes — Decisão §8.4
    const box: SandForeverBoxStatus = { vncUrl: null, windows: [] };
    expect(box.vncUrl).toBeNull();

    // SandHostSettings — mapa-funcoes §4.5
    const settings: SandHostSettings = { timezone: "America/Sao_Paulo", pinnedAgents: [], localToolPermission: "ask" };
    expect(settings.localToolPermission).toBe("ask");

    // Secrets — só nomes, nunca valores
    const secrets: BoxSecretsStatus = {
      secrets: ["openai"],
      keys: ["openai"],
      isApplied: false,
      lastAppliedAtMs: null,
    };
    expect(secrets.secrets).toEqual(["openai"]);
  });

  it("expõe o catálogo local e os modelos conhecidos do OpenCode Go", () => {
    expect(MODEL_CATALOG.filter(({ provider }) => provider !== "opencode-go").map(({ id, provider }) => ({ id, provider }))).toEqual([
      { id: "gpt-6-astra", provider: "openai" },
      { id: "grok-4.6", provider: "xai" },
      { id: "gpt-5.6-luna", provider: "openai" },
      { id: "gpt-5.6-sol", provider: "openai" },
      { id: "gpt-5.6-terra", provider: "openai" },
      { id: "openai-compatible", provider: "openai-compat" },
    ]);
    const openCode = MODEL_CATALOG.filter(({ provider }) => provider === "opencode-go");
    expect(openCode).toHaveLength(35);
    expect(openCode.filter((entry) => entry.id.startsWith("opencode-go/zen/"))).toHaveLength(8);
    expect(openCode.every((entry) => entry.contextWindow && entry.maxOutputTokens && entry.maxRequestBytes && entry.tokenizerStrategy === "estimated")).toBe(true);
    expect(MODEL_CATALOG).toContainEqual(expect.objectContaining({ id: "opencode-go/minimax-m3", provider: "opencode-go" }));
    expect(MODEL_CATALOG).toContainEqual(expect.objectContaining({ id: "opencode-go/qwen3.8-flash", provider: "opencode-go" }));
    expect(MODEL_CATALOG.find((entry) => entry.default)?.id).toBe("grok-4.6");
  });

  it("declara explicitamente quais modelos aceitam imagens", () => {
    expect(MODEL_CATALOG.filter((entry) => entry.supportsVision).map((entry) => entry.id)).toEqual([
      "gpt-6-astra",
      "grok-4.6",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "opencode-go/deepseek-v4-flash-vision-exp",
      "opencode-go/glm-5.3-flash",
      "opencode-go/gpt-5.6-luna",
      "opencode-go/grok-4.6",
      "opencode-go/kimi-k2.6",
      "opencode-go/kimi-k2.7-code",
      "opencode-go/kimi-k3",
      "opencode-go/mimo-v2.5",
      "opencode-go/minimax-m3",
      "opencode-go/muse-spark-1.2-contributor",
      "opencode-go/muse-spark-1.3-contributor",
      "opencode-go/muse-spark-1.3-contributor-free",
      "opencode-go/qwen3.6-plus",
      "opencode-go/qwen3.7-plus",
      "opencode-go/qwen3.8-flash",
      "opencode-go/qwen3.8-max",
      "opencode-go/zen/mimo-v2.5-free",
      "opencode-go/zen/muse-spark-1.2-contributor-free",
      "opencode-go/zen/muse-spark-1.3-contributor-free",
    ]);
    expect(MODEL_CATALOG.find((entry) => entry.id === "openai-compatible")?.supportsVision).not.toBe(true);
  });

  it("normalizeTranscriptEntry: toAgent/fromAgent string e fromUser boolean viram objetos", () => {
    const user = normalizeTranscriptEntry({
      kind: "message",
      id: "user:1",
      role: "user",
      content: "oi",
      timestampMs: 1,
      fromUser: true,
      toAgent: "agent-1",
    }, { agentName: "New Bot", userName: "Local User", userAuthId: "machine-1" });
    expect(user).toMatchObject({
      toAgent: { kind: "agent", id: "agent-1", name: "New Bot" },
      fromUser: { name: "Local User", authId: "machine-1" },
    });

    const assistant = normalizeTranscriptEntry({
      kind: "message",
      id: "ai:1",
      role: "assistant",
      content: "olá",
      timestampMs: 2,
      fromAgent: "agent-1",
    }, { agentName: "New Bot" });
    expect(assistant).toMatchObject({
      fromAgent: { kind: "agent", id: "agent-1", name: "New Bot" },
    });

    const card = normalizeTranscriptEntry({
      kind: "send-message",
      message: { type: "text", text: "olá" },
      author: "agent-1",
    }, { agentName: "New Bot" });
    expect(card).toMatchObject({
      author: { kind: "agent", id: "agent-1", name: "New Bot" },
    });
  });

  it("normalizeTranscriptEntry: toda entry ganha id não-vazio (rowId do renderer)", () => {
    const card = normalizeTranscriptEntry({
      kind: "send-message",
      message: { type: "text", text: "olá" },
    });
    expect(typeof (card as { id?: string }).id).toBe("string");
    expect((card as { id: string }).id.length).toBeGreaterThan(0);
    expect(card).toMatchObject({ message: { type: "text", content: "olá" } });
    expect((card as { message: object }).message).not.toHaveProperty("text");

    const att = normalizeTranscriptEntry({
      kind: "user-attachment",
      file_name: "notas.md",
      file_path: "C:\\a.md",
    });
    expect((att as { id: string }).id.startsWith("att:")).toBe(true);

    const notice = normalizeTranscriptEntry({ kind: "notice", text: "Geração interrompida.", level: "info" });
    expect((notice as { id: string }).id.startsWith("notice:")).toBe(true);

    const live = normalizeTranscriptEntry({
      kind: "message",
      id: "ai:live",
      role: "assistant",
      content: "oi",
      timestampMs: 1,
      streaming: true,
    });
    expect(live).toMatchObject({ id: "ai:live", isStreaming: true });
  });

  it("normalizeTranscriptEntry: text e content legados viram content canônico", () => {
    const textOnly = normalizeTranscriptEntry({
      kind: "send-message",
      message: { type: "text", text: "de-text" },
    });
    const contentOnly = normalizeTranscriptEntry({
      kind: "send-message",
      message: { type: "text", content: "de-content" },
    });

    expect(textOnly).toMatchObject({ message: { type: "text", content: "de-text" } });
    expect(contentOnly).toMatchObject({ message: { type: "text", content: "de-content" } });
    expect((textOnly as { message: object }).message).not.toHaveProperty("text");
    expect((contentOnly as { message: object }).message).not.toHaveProperty("text");
  });
});
