import { createHash } from "node:crypto";
import type { TranscriptEntry } from "../shared/contracts.js";

/** P2.6: provider cursors are opaque to OpenBot and bounded before storage/use. */
export const MAX_RESUME_CURSOR_BYTES = 2_048;
export const MAX_RESUME_EFFECT_IDS = 128;
export const MAX_RESUME_RESULT_BYTES = 64 * 1024;
export const MAX_RESUME_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1_000;

export type ResumeFailureCode =
  | "resume_unavailable"
  | "missing_cursor"
  | "invalid_cursor"
  | "expired_checkpoint"
  | "foreign_checkpoint"
  | "unsafe_effect"
  | "resume_aborted"
  | "resume_budget_exhausted";

export class ResumeProtocolError extends Error {
  readonly code: ResumeFailureCode;

  constructor(code: ResumeFailureCode, message: string) {
    super(message);
    this.name = "ResumeProtocolError";
    this.code = code;
  }
}

/** Validate only the transport/storage boundary; provider-specific syntax stays in the adapter. */
export function validateOpaqueResumeCursor(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ResumeProtocolError("invalid_cursor", "resume cursor must be a non-empty string");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_RESUME_CURSOR_BYTES || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new ResumeProtocolError("invalid_cursor", "resume cursor exceeds the bounded opaque format");
  }
  return value;
}

/** Hashes the stable turn identity and canonical semantic fingerprint; raw arguments are never persisted. */
export function stableResumeEffectId(turnId: string, semanticFingerprint: string): string {
  if (typeof turnId !== "string" || turnId.length === 0 || typeof semanticFingerprint !== "string" || semanticFingerprint.length === 0) {
    throw new ResumeProtocolError("unsafe_effect", "resume effect identity is incomplete");
  }
  return `effect:v1:${createHash("sha256").update(turnId, "utf8").update("\u0000", "utf8").update(semanticFingerprint, "utf8").digest("hex")}`;
}

export function resumeFingerprintHash(semanticFingerprint: string): string {
  if (typeof semanticFingerprint !== "string" || semanticFingerprint.length === 0) {
    throw new ResumeProtocolError("unsafe_effect", "resume effect fingerprint is incomplete");
  }
  return createHash("sha256").update(semanticFingerprint, "utf8").digest("hex");
}

export function boundedResumeResult(value: unknown): unknown {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ResumeProtocolError("unsafe_effect", "resume effect outcome is not serializable");
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESUME_RESULT_BYTES) {
    throw new ResumeProtocolError("unsafe_effect", "resume effect outcome exceeds the bounded ledger limit");
  }
  return JSON.parse(encoded) as unknown;
}

export interface ResumeBudgetSnapshot {
  readonly maxProviderAttempts: number;
  readonly providerAttemptsUsed: number;
  readonly maxToolRounds: number;
  readonly toolRoundsUsed: number;
  readonly maxToolCalls: number;
  readonly toolCallsUsed: number;
}

export interface ResumeCheckpointScope {
  readonly agentId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly provider: string;
  readonly model: string;
}

export interface ResumeCheckpoint extends ResumeCheckpointScope {
  readonly checkpointId: string;
  readonly cursor: string;
  readonly safeSequenceId: number;
  readonly completedEffectIds: readonly string[];
  readonly expiresAtMs: number;
  readonly version: number;
  readonly budget: ResumeBudgetSnapshot;
}

export type ResumeEffectStatus = "prepared" | "started" | "completed" | "unsafe";

export interface ResumeEffectRecord {
  readonly agentId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly effectId: string;
  readonly fingerprintHash: string;
  readonly status: ResumeEffectStatus;
  readonly result?: unknown;
  readonly createdAtMs: number;
  readonly startedAtMs?: number;
  readonly completedAtMs?: number;
}

export interface ResumeEffectCommit {
  readonly scope: ResumeCheckpointScope;
  readonly effectId: string;
  readonly fingerprintHash: string;
  readonly result: unknown;
  readonly transcriptEntries?: readonly TranscriptEntry[];
  readonly checkpoint: {
    readonly expectedVersion: number;
    readonly cursor: string;
    readonly safeSequenceId: number;
    readonly completedEffectIds: readonly string[];
    readonly expiresAtMs: number;
    readonly budget: ResumeBudgetSnapshot;
  };
}

export function checkpointMatchesScope(checkpoint: ResumeCheckpointScope, scope: ResumeCheckpointScope): boolean {
  return checkpoint.agentId === scope.agentId
    && checkpoint.conversationId === scope.conversationId
    && checkpoint.turnId === scope.turnId
    && checkpoint.provider === scope.provider
    && checkpoint.model === scope.model;
}

export function assertCheckpointUsable(checkpoint: ResumeCheckpoint, scope: ResumeCheckpointScope, nowMs: number): void {
  if (!checkpointMatchesScope(checkpoint, scope)) {
    throw new ResumeProtocolError("foreign_checkpoint", "resume checkpoint scope does not match the turn");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs >= checkpoint.expiresAtMs) {
    throw new ResumeProtocolError("expired_checkpoint", "resume checkpoint has expired");
  }
  validateOpaqueResumeCursor(checkpoint.cursor);
}
