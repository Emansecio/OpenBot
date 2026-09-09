/**
 * P2.2 — first-party native projection of async tasks / subagents for the
 * renderer.
 *
 * This module is the ONLY producer of the closed renderer allowlist defined in
 * src/shared/contracts.ts (NativeAsyncTaskProjection*). It converts durable
 * AsyncTaskRecord values (SQLite authority) into sanitized, bounded,
 * renderer-safe rows. It never publishes full inputs, internal lineage,
 * grants, credential references, lease ownership, secrets, arbitrary objects
 * or unknown fields.
 */
import type {
  NativeAsyncTaskProjectionAction,
  NativeAsyncTaskProjectionChannel,
  NativeAsyncTaskProjectionError,
  NativeAsyncTaskProjectionItem,
  NativeAsyncTaskProjectionProgress,
  NativeAsyncTaskProjectionResult,
} from "../shared/contracts.js";
import type { AsyncTaskRecord, AsyncTaskResult } from "./contracts.js";

/**
 * Live outbox event enriched with the native projection. Extends the durable
 * AsyncTaskProjectionEnvelope fields (epoch/sequence/agentId/channel) with the
 * renderer frame shape and keeps a single projected item per channel.
 */
export interface NativeAsyncTaskProjectionLiveEvent {
  readonly type: "update";
  readonly agentId: string;
  readonly parentAgentId: string;
  readonly channel: NativeAsyncTaskProjectionChannel;
  readonly epoch: string;
  readonly sequence: number;
  readonly tasks?: NativeAsyncTaskProjectionItem[];
  readonly subagents?: NativeAsyncTaskProjectionItem[];
}

/** UTF-8 byte caps applied recursively to every renderer-facing text field. */
export const PROJECTION_LABEL_MAX_BYTES = 512;
export const PROJECTION_DETAIL_MAX_BYTES = 4_096;
export const PROJECTION_PHASE_MAX_BYTES = 256;
export const PROJECTION_SUMMARY_MAX_BYTES = 4_096;
export const PROJECTION_ERROR_MESSAGE_MAX_BYTES = 4_096;
export const PROJECTION_RESULT_TEXT_MAX_BYTES = 4_096;
export const PROJECTION_RESULT_REF_MAX_BYTES = 2_048;

const LET_ANSI_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function utf8Prefix(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function boundedText(value: unknown, fallback: string, maxBytes: number): string {
  const raw = typeof value === "string" ? value.normalize("NFC") : fallback;
  const cleaned = LET_ANSI_CONTROL.test(raw) ? raw.replace(LET_ANSI_CONTROL, "") : raw;
  const bounded = Buffer.byteLength(cleaned, "utf8") <= maxBytes ? cleaned : utf8Prefix(cleaned, maxBytes);
  return bounded.length === 0 ? fallback : bounded;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function projectProgress(value: unknown): NativeAsyncTaskProjectionProgress | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  return {
    phase: boundedText(input.phase, "progress", PROJECTION_PHASE_MAX_BYTES),
    summary: boundedText(input.summary, "", PROJECTION_SUMMARY_MAX_BYTES),
    completedUnits: nullableNumber(input.completedUnits),
    totalUnits: nullableNumber(input.totalUnits),
  };
}

function projectFailure(value: unknown): NativeAsyncTaskProjectionError | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  return {
    code: typeof input.code === "string" ? input.code : "internal_error",
    message: boundedText(input.message, "Task failed.", PROJECTION_ERROR_MESSAGE_MAX_BYTES),
    retryable: input.retryable === true,
  };
}

function projectResult(value: unknown): NativeAsyncTaskProjectionResult | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  const kind = input.kind === "ref" ? "ref" : "inline";
  if (kind === "ref") {
    const resultRef = boundedText(input.resultRef, "", PROJECTION_RESULT_REF_MAX_BYTES);
    return { kind, resultRef, bytes: nullableNumber(input.bytes) ?? 0, truncated: input.truncated === true };
  }
  const text = boundedText(input.text, "", PROJECTION_RESULT_TEXT_MAX_BYTES);
  return {
    kind,
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    truncated: input.truncated === true || Buffer.byteLength(text, "utf8") < (typeof input.text === "string" ? Buffer.byteLength(input.text, "utf8") : 0),
  };
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "abandoned"]);

function allowedActions(record: AsyncTaskRecord): readonly NativeAsyncTaskProjectionAction[] {
  const actions: NativeAsyncTaskProjectionAction[] = [];
  if (!TERMINAL_STATUSES.has(record.status)) actions.push("abort");
  if (record.status === "running") actions.push("steer");
  return actions;
}

function detailFor(record: AsyncTaskRecord): string {
  switch (record.status) {
    case "queued": return "Na fila";
    case "admitted": return "Admitido";
    case "running": return record.progress?.summary ?? "Em execução";
    case "retry_wait": return record.error?.message ?? "Aguardando nova tentativa";
    case "cancelling": return "Cancelando";
    case "completed": return record.result === null ? "Concluída" : record.result.kind === "inline" ? record.result.text : "Concluída";
    case "failed": return record.error?.message ?? "Falhou";
    case "cancelled": return "Cancelada";
    case "abandoned": return "Abandonada";
  }
  return "";
}

/**
 * Converts one durable AsyncTaskRecord into the closed renderer allowlist.
 * The input is trusted (it came from SQLite parsing), but every text field is
 * still re-bounded and unknown/private fields are structurally dropped.
 */
export function projectAsyncTaskForRenderer(record: AsyncTaskRecord): NativeAsyncTaskProjectionItem {
  const progress = record.progress === null ? null : projectProgress(record.progress);
  const error = record.error === null ? null : projectFailure(record.error);
  const result = record.result === null ? null : projectResult(record.result);
  const objective = Array.isArray(record.input) ? "" : (record.input as { objective?: unknown })?.objective;
  const label = boundedText(objective, "Tarefa", PROJECTION_LABEL_MAX_BYTES);
  const actions = allowedActions(record);
  const item: NativeAsyncTaskProjectionItem = {
    id: record.taskId,
    kind: record.kind,
    status: record.status,
    label,
    detail: boundedText(detailFor(record), label, PROJECTION_DETAIL_MAX_BYTES),
    startedAtMs: record.startedAtMs,
    ...(record.attempt > 1 ? { attempt: record.attempt } : {}),
    ...(progress === null ? {} : { progress }),
    ...(error === null ? {} : { error }),
    ...(result === null ? {} : { result }),
    ...(actions.length > 0 ? { allowedActions: actions } : {}),
  };
  return item;
}

/** Converts a list of durable records, preserving SQLite order. */
export function projectAsyncTaskListForRenderer(records: readonly AsyncTaskRecord[]): NativeAsyncTaskProjectionItem[] {
  return records.map((record) => projectAsyncTaskForRenderer(record));
}

/** Derives a bounded inline-result preview used by bridge sanitizers. */
export function projectLimitedResultText(result: AsyncTaskResult | null | undefined, maxBytes = PROJECTION_RESULT_TEXT_MAX_BYTES): string {
  if (result === null || result === undefined) return "";
  if (result.kind === "ref") return result.resultRef;
  return boundedText(result.text, "", maxBytes);
}
