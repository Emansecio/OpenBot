import { Buffer } from "node:buffer";

export const A2A_MAX_PAYLOAD_BYTES = 32 * 1024;
export const A2A_MAX_ENVELOPE_BYTES = 64 * 1024;
export const A2A_MAX_HOPS = 4;
export const A2A_MAX_MESSAGES_PER_PARENT_TURN = 32;
export const A2A_MAX_BYTES_PER_PARENT_TURN = 256 * 1024;
export const A2A_MAX_RECIPIENTS_PER_PARENT_TURN = 8;
export const A2A_MAX_PENDING_PER_RECIPIENT = 128;
export const A2A_MAX_DELIVERY_ATTEMPTS = 3;

export type A2APriority = "normal" | "high";
export type A2AMessageStatus = "queued" | "delivering" | "acked" | "rejected" | "dead" | "cancelled";

export type A2APayload =
  | { version: 1; kind: "text"; text: string }
  | { version: 1; kind: "task-result-ref"; taskId: string; summary: string };

export interface A2AEnvelope {
  version: 1;
  messageId: string;
  senderAgentId: string;
  senderIncarnation: string;
  recipientAgentId: string;
  recipientIncarnation: string;
  nonce: string;
  parentTaskId: string | null;
  parentTurnId: string;
  priority: A2APriority;
  hopCount: number;
  payload: A2APayload;
  createdAtMs: number;
  availableAtMs: number;
  expiresAtMs: number | null;
  status?: A2AMessageStatus;
  attempt?: number;
  versionNumber?: number;
  ackNonce?: string | null;
}

export type A2ASendInput = Omit<A2AEnvelope, "senderIncarnation" | "recipientIncarnation" | "status" | "attempt" | "versionNumber" | "ackNonce">;

export class A2AContractError extends Error {
  readonly code: string;
  constructor(message: string, code = "invalid-a2a-envelope") {
    super(message);
    this.name = "A2AContractError";
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new A2AContractError("envelope must be an object");
  return value as Record<string, unknown>;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { index += 1; continue; }
      return true;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) return true;
  }
  return false;
}

function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string") {
    throw new A2AContractError(`${name} must be bounded UTF-8 text`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || hasUnpairedSurrogate(trimmed)) throw new A2AContractError(`${name} must be bounded UTF-8 text`);
  return trimmed;
}

function safeInteger(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new A2AContractError(`${name} must be a non-negative integer`);
  return value as number;
}

function safeJsonByteLength(value: unknown): number {
  const seen = new WeakSet();
  const clone = (current: unknown): unknown => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number" && Number.isFinite(current)) return current;
    if (typeof current !== "object") throw new A2AContractError("envelope contains a non-JSON value");
    if (seen.has(current)) throw new A2AContractError("envelope contains a cycle");
    seen.add(current);
    try {
      const isArray = Array.isArray(current);
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== null && prototype !== (isArray ? Array.prototype : Object.prototype)) {
        throw new A2AContractError("envelope contains custom serialization");
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key === "symbol") || Object.hasOwn(descriptors, "toJSON")) {
        throw new A2AContractError("envelope contains custom serialization");
      }
      for (const key of keys) {
        const descriptor = descriptors[key as keyof typeof descriptors];
        if (descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined)) {
          throw new A2AContractError("envelope contains an accessor");
        }
      }
      if (isArray) {
        const length = (descriptors.length?.value ?? 0) as number;
        const result: unknown[] = [];
        Object.defineProperty(result, "toJSON", { value: undefined });
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined) throw new A2AContractError("envelope contains a sparse array");
          result.push(clone(descriptor.value));
        }
        return result;
      }
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(descriptors)) {
        const descriptor = descriptors[key];
        if (descriptor?.enumerable) result[key] = clone(descriptor.value);
      }
      return result;
    } finally {
      seen.delete(current);
    }
  };

  try {
    return Buffer.byteLength(JSON.stringify(clone(value)), "utf8");
  } catch (error) {
    if (error instanceof A2AContractError) throw error;
    throw new A2AContractError("envelope is not safely JSON serializable");
  }
}

function parsePayload(value: unknown): A2APayload {
  const payload = record(value);
  if (payload.version !== 1 || (payload.kind !== "text" && payload.kind !== "task-result-ref")) throw new A2AContractError("payload kind is not allowed");
  if (payload.kind === "text") {
    rejectUnknown(payload, new Set(["version", "kind", "text"]));
    const parsed = { version: 1 as const, kind: "text" as const, text: typeof payload.text === "string" ? payload.text.trim() : "" };
    if (parsed.text.length === 0 || hasUnpairedSurrogate(parsed.text)) throw new A2AContractError("payload text is invalid UTF-8");
    if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > A2A_MAX_PAYLOAD_BYTES) throw new A2AContractError("payload text exceeds the UTF-8 cap");
    return parsed;
  }
  rejectUnknown(payload, new Set(["version", "kind", "taskId", "summary"]));
  const parsed = {
    version: 1 as const,
    kind: "task-result-ref" as const,
    taskId: text(payload.taskId, "payload.taskId"),
    summary: typeof payload.summary === "string" ? payload.summary.trim() : "",
  };
  if (parsed.summary.length === 0 || hasUnpairedSurrogate(parsed.summary)) throw new A2AContractError("payload summary is invalid UTF-8");
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > A2A_MAX_PAYLOAD_BYTES) throw new A2AContractError("payload summary exceeds the UTF-8 cap");
  return parsed;
}

function rejectUnknown(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new A2AContractError(`unknown envelope field: ${key}`, "unknown-field");
}

const baseFields = new Set(["version", "messageId", "senderAgentId", "recipientAgentId", "nonce", "parentTaskId", "parentTurnId", "priority", "hopCount", "payload", "createdAtMs", "availableAtMs", "expiresAtMs"]);

export function parseA2ASendInput(value: unknown): A2ASendInput {
  const source = record(value);
  rejectUnknown(source, baseFields);
  const parsed: A2ASendInput = {
    version: source.version === 1 ? 1 : (() => { throw new A2AContractError("version must be 1"); })(),
    messageId: text(source.messageId, "messageId"),
    senderAgentId: text(source.senderAgentId, "senderAgentId"),
    recipientAgentId: text(source.recipientAgentId, "recipientAgentId"),
    nonce: text(source.nonce, "nonce"),
    parentTaskId: source.parentTaskId === null ? null : text(source.parentTaskId, "parentTaskId"),
    parentTurnId: text(source.parentTurnId, "parentTurnId"),
    priority: source.priority === "high" || source.priority === "normal" ? source.priority : (() => { throw new A2AContractError("priority is invalid"); })(),
    hopCount: safeInteger(source.hopCount, "hopCount"),
    payload: parsePayload(source.payload),
    createdAtMs: safeInteger(source.createdAtMs, "createdAtMs"),
    availableAtMs: safeInteger(source.availableAtMs, "availableAtMs"),
    expiresAtMs: source.expiresAtMs === null ? null : safeInteger(source.expiresAtMs, "expiresAtMs"),
  };
  if (parsed.senderAgentId === parsed.recipientAgentId) throw new A2AContractError("self-send is not allowed", "self-send");
  if (parsed.hopCount > A2A_MAX_HOPS) throw new A2AContractError("hop cap exceeded", "hop-cap");
  if (parsed.availableAtMs < parsed.createdAtMs) throw new A2AContractError("availableAtMs precedes createdAtMs");
  if (parsed.expiresAtMs !== null && parsed.expiresAtMs < parsed.availableAtMs) throw new A2AContractError("expiresAtMs precedes availableAtMs");
  return parsed;
}

export function parseA2AEnvelope(value: unknown): A2AEnvelope {
  const source = record(value);
  if (safeJsonByteLength(source) > A2A_MAX_ENVELOPE_BYTES) throw new A2AContractError("envelope exceeds the UTF-8 cap", "envelope-cap");
  const allowed = new Set([...baseFields, "senderIncarnation", "recipientIncarnation", "status", "attempt", "versionNumber", "ackNonce"]);
  rejectUnknown(source, allowed);
  const { senderIncarnation: _senderIncarnation, recipientIncarnation: _recipientIncarnation, status: _status, attempt: _attempt, versionNumber: _versionNumber, ackNonce: _ackNonce, ...sendSource } = source;
  const input = parseA2ASendInput(sendSource);
  const senderIncarnation = text(source.senderIncarnation, "senderIncarnation");
  const recipientIncarnation = text(source.recipientIncarnation, "recipientIncarnation");
  const envelope: A2AEnvelope = { ...input, senderIncarnation, recipientIncarnation };
  if (source.status !== undefined) {
    if (source.status !== "queued" && source.status !== "delivering" && source.status !== "acked" && source.status !== "rejected" && source.status !== "dead" && source.status !== "cancelled") throw new A2AContractError("status is invalid");
    envelope.status = source.status;
  }
  if (source.attempt !== undefined) envelope.attempt = safeInteger(source.attempt, "attempt");
  if (source.versionNumber !== undefined) envelope.versionNumber = safeInteger(source.versionNumber, "versionNumber", 1);
  if (source.ackNonce !== undefined) envelope.ackNonce = source.ackNonce === null ? null : text(source.ackNonce, "ackNonce");
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > A2A_MAX_ENVELOPE_BYTES) throw new A2AContractError("envelope exceeds the UTF-8 cap", "envelope-cap");
  return envelope;
}
