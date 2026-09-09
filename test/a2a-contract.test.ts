import { describe, expect, it } from "vitest";

import {
  A2A_MAX_ENVELOPE_BYTES,
  A2A_MAX_HOPS,
  A2A_MAX_MESSAGES_PER_PARENT_TURN,
  A2A_MAX_BYTES_PER_PARENT_TURN,
  A2A_MAX_RECIPIENTS_PER_PARENT_TURN,
  A2A_MAX_PENDING_PER_RECIPIENT,
  A2A_MAX_DELIVERY_ATTEMPTS,
  A2A_MAX_PAYLOAD_BYTES,
  A2AContractError,
  parseA2AEnvelope,
  type A2AEnvelope,
} from "../src/a2a/contracts.js";

function envelope(overrides: Partial<A2AEnvelope> = {}): A2AEnvelope {
  return {
    version: 1,
    messageId: "message-1",
    senderAgentId: "agent-a",
    senderIncarnation: "inc-a-1",
    recipientAgentId: "agent-b",
    recipientIncarnation: "inc-b-1",
    nonce: "nonce-1",
    parentTaskId: null,
    parentTurnId: "turn-1",
    priority: "normal",
    hopCount: 0,
    payload: { version: 1, kind: "text", text: "hello" },
    createdAtMs: 1_000,
    availableAtMs: 1_000,
    expiresAtMs: null,
    ...overrides,
  };
}

function envelopeWithJsonBytes(targetBytes: number): A2AEnvelope {
  const source = envelope({ nonce: "" });
  const remaining = targetBytes - Buffer.byteLength(JSON.stringify(source), "utf8");
  source.nonce = `${"é".repeat(Math.floor(remaining / 2))}${remaining % 2 === 0 ? "" : "x"}`;
  return source;
}

describe("P2.1 A2A envelope contract", () => {
  it("publishes the frozen default safety caps", () => {
    expect(A2A_MAX_PAYLOAD_BYTES).toBe(32 * 1024);
    expect(A2A_MAX_ENVELOPE_BYTES).toBe(64 * 1024);
    expect(A2A_MAX_HOPS).toBe(4);
    expect(A2A_MAX_MESSAGES_PER_PARENT_TURN).toBe(32);
    expect(A2A_MAX_BYTES_PER_PARENT_TURN).toBe(256 * 1024);
    expect(A2A_MAX_RECIPIENTS_PER_PARENT_TURN).toBe(8);
    expect(A2A_MAX_PENDING_PER_RECIPIENT).toBe(128);
    expect(A2A_MAX_DELIVERY_ATTEMPTS).toBe(3);
  });

  it("canonicalizes a bounded text envelope and preserves lineage/incarnations", () => {
    const parsed = parseA2AEnvelope({ ...envelope(), payload: { version: 1, kind: "text", text: "  hello  " } });
    expect(parsed).toMatchObject({
      senderAgentId: "agent-a",
      senderIncarnation: "inc-a-1",
      recipientAgentId: "agent-b",
      recipientIncarnation: "inc-b-1",
      parentTaskId: null,
      parentTurnId: "turn-1",
    });
    expect(parsed.payload).toEqual({ version: 1, kind: "text", text: "hello" });
  });

  it("accepts valid non-BMP Unicode while rejecting whitespace-only identifiers", () => {
    expect(parseA2AEnvelope(envelope({ payload: { version: 1, kind: "text", text: "olá 👋" } })).payload)
      .toEqual({ version: 1, kind: "text", text: "olá 👋" });
    expect(() => parseA2AEnvelope(envelope({ nonce: "   " }))).toThrow(A2AContractError);
    const { nonce: _nonce, ...withoutNonce } = envelope();
    expect(() => parseA2AEnvelope(withoutNonce)).toThrow(A2AContractError);
    expect(() => parseA2AEnvelope(envelope({ senderIncarnation: "   " }))).toThrow(A2AContractError);
  });

  it.each([
    ["self send", { senderAgentId: "agent-a", recipientAgentId: "agent-a" }],
    ["missing parent turn", { parentTurnId: "" }],
    ["invalid priority", { priority: "urgent" as never }],
    ["negative hop", { hopCount: -1 }],
    ["too many hops", { hopCount: A2A_MAX_HOPS + 1 }],
    ["invalid timestamp", { createdAtMs: -1 }],
  ])("rejects %s", (_label, patch) => {
    expect(() => parseA2AEnvelope(envelope(patch))).toThrow(A2AContractError);
  });

  it("rejects arbitrary JSON, inline secret-shaped fields and invalid UTF-8", () => {
    expect(() => parseA2AEnvelope(envelope({ payload: { version: 1, kind: "json", value: { apiKey: "secret" } } as never }))).toThrow(A2AContractError);
    expect(() => parseA2AEnvelope(envelope({ payload: { version: 1, kind: "text", text: "hello", apiKey: "secret" } as never }))).toThrow(A2AContractError);
    expect(() => parseA2AEnvelope(envelope({ payload: { version: 1, kind: "text", text: "\uD800" } }))).toThrow(A2AContractError);
  });

  it("enforces UTF-8 payload and complete envelope caps", () => {
    expect(Buffer.byteLength("x".repeat(A2A_MAX_PAYLOAD_BYTES + 1), "utf8")).toBeGreaterThan(A2A_MAX_PAYLOAD_BYTES);
    expect(() => parseA2AEnvelope(envelope({ payload: { version: 1, kind: "text", text: "x".repeat(A2A_MAX_PAYLOAD_BYTES + 1) } }))).toThrow(A2AContractError);
    expect(() => parseA2AEnvelope(envelope({
      payload: { version: 1, kind: "task-result-ref", taskId: "t".repeat(256), summary: "x".repeat(A2A_MAX_PAYLOAD_BYTES) },
    }))).toThrow(A2AContractError);

    const oversizedEnvelope = envelope({ nonce: `${" ".repeat(A2A_MAX_ENVELOPE_BYTES)}nonce-1` });
    expect(Buffer.byteLength(JSON.stringify(oversizedEnvelope), "utf8")).toBeGreaterThan(A2A_MAX_ENVELOPE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(oversizedEnvelope.payload), "utf8")).toBeLessThanOrEqual(A2A_MAX_PAYLOAD_BYTES);
    let envelopeError: unknown;
    try {
      parseA2AEnvelope(oversizedEnvelope);
    } catch (error) {
      envelopeError = error;
    }
    expect(envelopeError).toMatchObject({ code: "envelope-cap" });
  });

  it("reports unsafe serialization inputs as contract errors", () => {
    const cyclic = envelope() as A2AEnvelope & { cycle?: unknown };
    cyclic.cycle = cyclic;
    const accessor = envelope();
    Object.defineProperty(accessor, "nonce", {
      enumerable: true,
      get() { throw new Error("attacker getter"); },
    });
    const customSerialization = Object.assign(envelope(), {
      toJSON() { throw new Error("attacker toJSON"); },
    });

    for (const unsafe of [cyclic, envelope({ createdAtMs: 1n as never }), accessor, customSerialization]) {
      expect(() => parseA2AEnvelope(unsafe)).toThrow(A2AContractError);
    }
  });

  it("measures the complete envelope cap at the exact UTF-8 byte boundary", () => {
    const atLimit = envelopeWithJsonBytes(A2A_MAX_ENVELOPE_BYTES);
    const aboveLimit = envelopeWithJsonBytes(A2A_MAX_ENVELOPE_BYTES + 1);
    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(A2A_MAX_ENVELOPE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(aboveLimit), "utf8")).toBe(A2A_MAX_ENVELOPE_BYTES + 1);
    expect(() => parseA2AEnvelope(atLimit)).toThrow(expect.objectContaining({ code: "invalid-a2a-envelope" }));
    expect(() => parseA2AEnvelope(aboveLimit)).toThrow(expect.objectContaining({ code: "envelope-cap" }));
  });

  it("validates persisted status and timestamp ordering", () => {
    expect(() => parseA2AEnvelope({ ...envelope(), status: "invented" })).toThrow(A2AContractError);
    expect(() => parseA2AEnvelope(envelope({ availableAtMs: 999 }))).toThrow(A2AContractError);
    expect(() => parseA2AEnvelope(envelope({ expiresAtMs: 999 }))).toThrow(A2AContractError);
  });

  it("accepts a bounded task lineage/reference payload but rejects malformed references", () => {
    expect(parseA2AEnvelope(envelope({
      parentTaskId: "task-1",
      payload: { version: 1, kind: "task-result-ref", taskId: "task-1", summary: "done" },
    }))).toMatchObject({ parentTaskId: "task-1" });
    expect(() => parseA2AEnvelope(envelope({
      payload: { version: 1, kind: "task-result-ref", taskId: "", summary: "done" },
    }))).toThrow(A2AContractError);
  });
});
