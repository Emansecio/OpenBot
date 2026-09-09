export const RUNTIME_PROTOCOL_VERSION = 1 as const;
export const MAX_RUNTIME_FRAME_BYTES = 64 * 1024;

export type RuntimeFrameType = "start" | "health" | "acquire" | "run" | "release" | "stop";

export interface RuntimeFrame {
  protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  type: RuntimeFrameType;
  runtimeBootId: string | null;
  leaseId: string | null;
  agentId: string | null;
  nonce: string;
  deadline: number;
  policyDigest: string;
  payload: Record<string, unknown>;
}

const exact = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("runtime frame contains unsupported fields");
};

const record = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
};

const identifier = (value: unknown, name: string, nullable = false): string | null => {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) throw new Error(`${name} is invalid`);
  return value;
};

export function parseRuntimeFrame(encoded: string): RuntimeFrame {
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > MAX_RUNTIME_FRAME_BYTES) {
    throw new Error("runtime frame exceeds the byte limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("runtime frame is not valid JSON");
  }
  const input = record(parsed, "runtime frame must be an object");
  exact(input, [
    "protocolVersion",
    "type",
    "runtimeBootId",
    "leaseId",
    "agentId",
    "nonce",
    "deadline",
    "policyDigest",
    "payload",
  ]);
  if (input.protocolVersion !== RUNTIME_PROTOCOL_VERSION) throw new Error("runtime protocol version is unsupported");
  if (!["start", "health", "acquire", "run", "release", "stop"].includes(input.type as string)) throw new Error("runtime frame type is unsupported");
  const nonce = identifier(input.nonce, "nonce");
  if (nonce === null) throw new Error("nonce is invalid");
  if (typeof input.deadline !== "number" || !Number.isSafeInteger(input.deadline) || input.deadline <= Date.now()) {
    throw new Error("runtime frame deadline is invalid");
  }
  if (typeof input.policyDigest !== "string" || !/^[a-f0-9]{64}$/u.test(input.policyDigest)) {
    throw new Error("runtime policy digest is invalid");
  }
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    type: input.type as RuntimeFrameType,
    runtimeBootId: identifier(input.runtimeBootId, "runtimeBootId", true),
    leaseId: identifier(input.leaseId, "leaseId", true),
    agentId: identifier(input.agentId, "agentId", true),
    nonce,
    deadline: input.deadline,
    policyDigest: input.policyDigest,
    payload: record(input.payload, "runtime frame payload must be an object"),
  };
}

export function encodeRuntimeFrame(frame: RuntimeFrame): string {
  const normalized = parseRuntimeFrame(JSON.stringify(frame));
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RUNTIME_FRAME_BYTES) throw new Error("runtime frame exceeds the byte limit");
  return encoded;
}

export class ReplayGuard {
  private readonly seen = new Set<string>();

  constructor(private readonly maxEntries = 4096) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be positive");
  }

  accept(nonce: string): boolean {
    if (this.seen.has(nonce)) return false;
    this.seen.add(nonce);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }
}
