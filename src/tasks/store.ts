import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { migrateOpenBotSchema } from "../store/schema.js";
import type {
  AsyncTaskAbortIntent,
  AsyncTaskAttemptRecord,
  AsyncTaskFailure,
  AsyncTaskLease,
  AsyncTaskOutboxEvent,
  AsyncTaskProgress,
  AsyncTaskProjectionEnvelope,
  AsyncTaskRecord,
  AsyncTaskResult,
  AsyncTaskStatus,
  AsyncTaskSteerIntent,
  AsyncTaskWakeKind,
  AsyncTaskWakePayload,
  BudgetReservation,
  ClaimAsyncTaskInput,
  ClaimAsyncTaskResult,
  CommitAsyncTaskTerminalInput,
  CommitAsyncTaskTerminalResult,
  DelegatedCapabilityGrant,
  DispatchAsyncTaskInput,
  DispatchAsyncTaskResult,
  SubagentBudget,
  SubagentBudgetUsage,
  TaskInputV1,
} from "./contracts.js";
import { AsyncTaskContractError, parseDelegatedCapabilityGrant, parseTaskInputV1 } from "./contracts.js";
import {
  assertTaskTransition,
  emptyBudgetUsage,
  reconcileBudgetReservation,
  liquidateBudgetReservations,
  requireTaskClientNonce,
  reserveBudget,
  deriveEffectiveBudget,
  remainingBudget,
  limitTaskResultUtf8,
  TASK_RESULT_MIN_TRUNCATION_MARKER,
  TASK_RESULT_TRUNCATION_MARKER,
} from "./state-machine.js";

export interface AsyncTaskStoreOptions {
  readonly path: string;
  readonly database?: Database.Database;
  readonly now?: () => number;
  readonly sensitiveValues: () => readonly string[];
}

export interface AsyncTaskBudgetLeaseFence {
  readonly leaseOwnerId: string;
  readonly attempt: number;
  readonly expectedTaskVersion: number;
}

export interface AsyncTaskBudgetState {
  readonly budget: SubagentBudget;
  readonly parentBudget?: SubagentBudget;
  readonly usage: SubagentBudgetUsage;
  readonly version: number;
}

function budgetReservationForTask(taskId: string, budget: SubagentBudget): BudgetReservation {
  return {
    reservationId: taskId,
    amounts: {
      providerCalls: budget.maxProviderCalls,
      inputTokens: budget.maxInputTokens,
      outputTokens: budget.maxOutputTokens,
      toolRounds: budget.maxToolRounds,
      toolCalls: budget.maxToolCalls,
      mcpCalls: budget.maxMcpCalls,
      browserCommands: budget.maxBrowserCommands,
      resultBytes: budget.maxResultBytes,
      workspaceWriteBytes: budget.maxWorkspaceWriteBytes,
    },
  };
}

function usageIncludingReservations(usage: SubagentBudgetUsage): SubagentBudgetUsage["used"] {
  return {
    providerCalls: usage.used.providerCalls + usage.reserved.providerCalls,
    inputTokens: usage.used.inputTokens + usage.reserved.inputTokens,
    outputTokens: usage.used.outputTokens + usage.reserved.outputTokens,
    toolRounds: usage.used.toolRounds + usage.reserved.toolRounds,
    toolCalls: usage.used.toolCalls + usage.reserved.toolCalls,
    mcpCalls: usage.used.mcpCalls + usage.reserved.mcpCalls,
    browserCommands: usage.used.browserCommands + usage.reserved.browserCommands,
    resultBytes: usage.used.resultBytes + usage.reserved.resultBytes,
    workspaceWriteBytes: usage.used.workspaceWriteBytes + usage.reserved.workspaceWriteBytes,
  };
}

function parentWallReservations(value: unknown): Record<string, number> {
  if (!isUnknownObject(value)) throw new AsyncTaskContractError("invalid_contract", "Parent wall reservations are invalid.");
  const output: Record<string, number> = {};
  for (const [taskId, amount] of Object.entries(value)) {
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) throw new AsyncTaskContractError("invalid_contract", "Parent wall reservation is invalid.");
    output[taskId] = amount;
  }
  return output;
}

export interface AsyncTaskProjectionSnapshot {
  readonly agentId: string;
  readonly channel: "async-tasks" | "subagents";
  readonly epoch: string;
  readonly sequence: number;
  readonly items: readonly AsyncTaskRecord[];
  readonly truncated: boolean;
}

export interface StartAsyncTaskInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly leaseOwnerId: string;
  readonly attempt: number;
  readonly startedAtMs: number;
}

export interface HeartbeatAsyncTaskInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly leaseOwnerId: string;
  readonly attempt: number;
  readonly nowMs: number;
  readonly leaseDurationMs: number;
}

export interface RecordAsyncTaskProgressInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly leaseOwnerId: string;
  readonly attempt: number;
  readonly progress: AsyncTaskProgress;
}

export interface TransitionAsyncTaskInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly to: AsyncTaskStatus;
  readonly atMs: number;
  readonly leaseOwnerId?: string;
  readonly attempt?: number;
  readonly nextAttemptAtMs?: number;
  readonly error?: AsyncTaskFailure | null;
}

export interface SteerAsyncTaskInput {
  readonly taskId: string;
  readonly agentId: string;
  readonly parentTurnId: string;
  readonly intentId: string;
  readonly expectedSteerVersion: number;
  readonly requestedAtMs: number;
  readonly message: string;
}

export interface AbortAsyncTaskInput {
  readonly taskId: string;
  readonly agentId: string;
  readonly parentTurnId: string;
  readonly intentId: string;
  readonly expectedAbortVersion: number;
  readonly requestedAtMs: number;
  readonly reason: AsyncTaskAbortIntent["reason"];
}

type UnknownObject = { [key: string]: unknown };

function isUnknownObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface TaskRow {
  task_id: string;
  agent_id: string;
  parent_turn_id: string;
  kind: string;
  status: string;
  attempt: number;
  version: number;
  client_nonce: string;
  depth: number;
  created_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  settled_at_ms: number | null;
  settlement_nonce: string | null;
  next_attempt_at_ms: number | null;
  lease_owner: string | null;
  lease_expires_at_ms: number | null;
  lease_attempt: number | null;
  lease_version: number | null;
  progress_json: string | null;
  result_json: string | null;
  error_json: string | null;
  steer_intent_json: string | null;
  steer_version: number;
  abort_intent_json: string | null;
  abort_version: number;
  lineage_json: string;
  input_json: string | null;
}

interface AttemptRow {
  attempt_id: string;
  task_id: string;
  attempt: number;
  status: string;
  version: number;
  created_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  lease_owner: string | null;
  lease_expires_at_ms: number | null;
  lease_version: number | null;
  error_json: string | null;
}

interface OutboxRow {
  outbox_id: string;
  task_id: string;
  transition_version: number;
  wake_kind: string;
  payload_json: string;
  created_at_ms: number;
  delivered_at_ms: number | null;
}

interface ProjectionRow {
  projection_id: string;
  source_outbox_id: string;
  agent_id: string;
  channel: string;
  epoch: string;
  sequence: number;
  task_id: string;
  snapshot_version: number;
  kind: string;
  payload_json: string;
  created_at_ms: number;
  delivered_at_ms: number | null;
}

interface ParentBudgetRow {
  budget_json: string;
  usage_json: string;
  wall_used_ms: number;
  wall_reserved_ms: number;
  wall_reservations_json: string;
  version: number;
}

interface GrantRow {
  grant_id: string;
  grant_json: string;
  version: number;
  revoked_at_ms: number | null;
}

interface BudgetStateRow {
  budget_json: string;
  usage_json: string;
  version: number;
}

interface ProjectionStateRow {
  epoch: string;
  next_sequence: number;
}

const TASK_STATUSES = ["queued", "admitted", "running", "retry_wait", "cancelling", "completed", "failed", "cancelled", "abandoned"] as const;
const WAKE_KINDS = ["task_created", "task_progress", "task_terminal", "task_steer", "task_abort", "task_recovered"] as const;
const FAILURE_CODES = ["budget_exhausted", "capability_denied", "aborted", "provider_error", "tool_error", "invalid_result", "internal_error"] as const;
const ABORT_REASONS = ["user", "parent", "shutdown", "budget_exhausted"] as const;
const TASK_STATUS_SET: ReadonlySet<string> = new Set(TASK_STATUSES);
const WAKE_KIND_SET: ReadonlySet<string> = new Set(WAKE_KINDS);
const FAILURE_CODE_SET: ReadonlySet<string> = new Set(FAILURE_CODES);
const ABORT_REASON_SET: ReadonlySet<string> = new Set(ABORT_REASONS);
const MAX_PERSISTED_TEXT_BYTES = 64 * 1024;
const BUDGET_FIELDS = [
  "maxWallMs",
  "maxProviderCalls",
  "maxInputTokens",
  "maxOutputTokens",
  "maxToolRounds",
  "maxToolCalls",
  "maxMcpCalls",
  "maxBrowserCommands",
  "maxResultBytes",
  "maxWorkspaceWriteBytes",
] as const;

function invalid(message: string): never {
  throw new AsyncTaskContractError("invalid_contract", message);
}

function isTaskStatus(value: unknown): value is AsyncTaskStatus {
  return typeof value === "string" && TASK_STATUS_SET.has(value);
}

function isWakeKind(value: unknown): value is AsyncTaskWakeKind {
  return typeof value === "string" && WAKE_KIND_SET.has(value);
}

function isFailureCode(value: unknown): value is AsyncTaskFailure["code"] {
  return typeof value === "string" && FAILURE_CODE_SET.has(value);
}

function isAbortReason(value: unknown): value is AsyncTaskAbortIntent["reason"] {
  return typeof value === "string" && ABORT_REASON_SET.has(value);
}

function casRejected(message: string): never {
  throw new AsyncTaskContractError("invalid_transition", message);
}

function objectValue(value: unknown, name: string): UnknownObject {
  if (!isUnknownObject(value)) invalid(`${name} must be an object.`);
  return value;
}

function exactFields(value: UnknownObject, fields: readonly string[], name: string): void {
  const allowed = new Set(fields);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid(`${name} contains an unsupported field.`);
}

function identifier(value: unknown, name: string, maxBytes = 256): string {
  if (typeof value !== "string" || /\p{Cc}/u.test(value)) invalid(`${name} is invalid.`);
  const normalized = value.trim().normalize("NFC");
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > maxBytes) invalid(`${name} is invalid.`);
  return normalized;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(`${name} must be a non-negative safe integer.`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = nonNegativeInteger(value, name);
  if (parsed === 0) invalid(`${name} must be positive.`);
  return parsed;
}

function parseBudgetLeaseFence(value: unknown): AsyncTaskBudgetLeaseFence {
  const input = objectValue(value, "budget lease fence");
  exactFields(input, ["leaseOwnerId", "attempt", "expectedTaskVersion"], "budget lease fence");
  return {
    leaseOwnerId: identifier(input.leaseOwnerId, "budget lease fence.leaseOwnerId"),
    attempt: positiveInteger(input.attempt, "budget lease fence.attempt"),
    expectedTaskVersion: positiveInteger(input.expectedTaskVersion, "budget lease fence.expectedTaskVersion"),
  };
}

function nullableInteger(value: unknown, name: string): number | null {
  return value === null ? null : nonNegativeInteger(value, name);
}

function nullableString(value: unknown, name: string, maxBytes = MAX_PERSISTED_TEXT_BYTES): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || /\p{Cc}/u.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) invalid(`${name} is invalid.`);
  return value.normalize("NFC");
}

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

const REDACTED_TEXT = "[redacted]";
const SENSITIVE_TEXT_KEYS = new Set([
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "authorization",
  "password",
  "passwd",
  "cookie",
  "token",
  "secret",
]);

function redactKnownValues(value: string, sensitiveValues: readonly string[]): string {
  return value.split(REDACTED_TEXT).map((segment) => {
    let redacted = segment;
    for (const sensitiveValue of sensitiveValues) redacted = redacted.split(sensitiveValue).join(REDACTED_TEXT);
    return redacted;
  }).join(REDACTED_TEXT);
}

function assertNoKnownSensitiveValue(
  value: unknown,
  sensitiveValues: readonly string[],
  name: string,
  depth = 0,
  state: { nodes: number; seen: Set<object> } = { nodes: 0, seen: new Set<object>() },
): void {
  state.nodes += 1;
  if (depth > 32 || state.nodes > 10_000) invalid(`${name} exceeds the sensitive-value validation limit.`);
  if (typeof value === "string") {
    const normalized = value.normalize("NFC").split(REDACTED_TEXT).join("");
    if (sensitiveValues.some((sensitiveValue) => sensitiveValue !== REDACTED_TEXT && normalized.includes(sensitiveValue))) {
      invalid(`${name} contains sensitive material.`);
    }
    return;
  }
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value !== "object") invalid(`${name} contains an unsupported value.`);
  if (state.seen.has(value)) invalid(`${name} contains a cyclic value.`);
  state.seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) assertNoKnownSensitiveValue(child, sensitiveValues, name, depth + 1, state);
  state.seen.delete(value);
}

function redactPlainText(value: string, sensitiveValues: readonly string[]): string {
  return redactKnownValues(value
    .replace(/["']?\b(?:client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|password|passwd|cookie|token|secret)\b["']?\s*[:=]\s*(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;"']+)/giu, REDACTED_TEXT)
    .replace(/\bbearer\s+(?:"[^"]*"|'[^']*'|[A-Za-z0-9._~+=/-]+)/giu, REDACTED_TEXT)
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/giu, REDACTED_TEXT), sensitiveValues);
}

function sensitiveJsonKey(value: string): boolean {
  return SENSITIVE_TEXT_KEYS.has(value.replace(/[_-]/gu, "").toLowerCase());
}

function sanitizeJsonValue(value: unknown, depth: number, state: { nodes: number }, sensitiveValues: readonly string[]): unknown {
  state.nodes += 1;
  if (depth > 32 || state.nodes > 10_000) invalid("Text JSON exceeds the sanitization complexity limit.");
  if (typeof value === "string") return redactPlainText(value, sensitiveValues);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeJsonValue(entry, depth + 1, state, sensitiveValues));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      redactKnownValues(key, sensitiveValues),
      sensitiveJsonKey(key) ? REDACTED_TEXT : sanitizeJsonValue(entry, depth + 1, state, sensitiveValues),
    ]));
  }
  return invalid("Text JSON contains an unsupported value.");
}

function redactSensitiveText(value: string, sensitiveValues: readonly string[]): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return redactPlainText(value, sensitiveValues);
    }
    if (typeof parsed === "object" && parsed !== null) {
      return JSON.stringify(sanitizeJsonValue(parsed, 0, { nodes: 0 }, sensitiveValues));
    }
  }
  return redactPlainText(value, sensitiveValues);
}

function sanitizedText(value: unknown, name: string, maxBytes: number, allowEmpty = false, sensitiveValues: readonly string[] = []): string {
  if (typeof value !== "string" || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) invalid(`${name} is invalid.`);
  const normalized = value.normalize("NFC");
  if (!allowEmpty && normalized.trim().length === 0) invalid(`${name} is invalid.`);
  const redacted = redactSensitiveText(normalized, sensitiveValues);
  if (Buffer.byteLength(redacted, "utf8") <= maxBytes) return redacted;
  return utf8Prefix(redacted, maxBytes);
}

function nullableSanitizedText(value: unknown, name: string, maxBytes: number, sensitiveValues: readonly string[] = []): string | null {
  return value === null ? null : sanitizedText(value, name, maxBytes, true, sensitiveValues);
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return invalid(`${name} contains invalid JSON.`);
  }
}

function parseStatus(value: unknown): AsyncTaskStatus {
  if (!isTaskStatus(value)) invalid("Task status is invalid.");
  return value;
}

function parseLineage(value: unknown): AsyncTaskRecord["lineage"] {
  const input = objectValue(value, "lineage");
  exactFields(input, ["parentAgentId", "parentTurnId", "parentTaskId", "childRunId", "depth"], "lineage");
  if (input.depth !== 1) invalid("Task lineage depth must be one.");
  return {
    parentAgentId: identifier(input.parentAgentId, "lineage.parentAgentId"),
    parentTurnId: identifier(input.parentTurnId, "lineage.parentTurnId"),
    parentTaskId: input.parentTaskId === null ? null : identifier(input.parentTaskId, "lineage.parentTaskId"),
    childRunId: identifier(input.childRunId, "lineage.childRunId"),
    depth: 1,
  };
}

function parseFailure(value: unknown, sensitiveValues: readonly string[] = []): AsyncTaskFailure {
  const input = objectValue(value, "failure");
  exactFields(input, ["code", "message", "retryable"], "failure");
  if (!isFailureCode(input.code)) invalid("Failure code is invalid.");
  if (typeof input.retryable !== "boolean") invalid("Failure retryable flag is invalid.");
  return { code: input.code, message: sanitizedText(input.message, "failure.message", 4_096, false, sensitiveValues), retryable: input.retryable };
}

function parseProgress(value: unknown, sensitiveValues: readonly string[] = []): AsyncTaskProgress {
  const input = objectValue(value, "progress");
  exactFields(input, ["phase", "summary", "completedUnits", "totalUnits", "updatedAtMs"], "progress");
  const completedUnits = nullableInteger(input.completedUnits, "progress.completedUnits");
  const totalUnits = nullableInteger(input.totalUnits, "progress.totalUnits");
  if (completedUnits !== null && totalUnits !== null && completedUnits > totalUnits) invalid("Progress exceeds total units.");
  return {
    phase: sanitizedText(input.phase, "progress.phase", 256, false, sensitiveValues),
    summary: sanitizedText(input.summary, "progress.summary", 4_096, false, sensitiveValues),
    completedUnits,
    totalUnits,
    updatedAtMs: nonNegativeInteger(input.updatedAtMs, "progress.updatedAtMs"),
  };
}

function parseResult(value: unknown, sensitiveValues: readonly string[] = [], allowOversizeInline = false): AsyncTaskResult {
  const input = objectValue(value, "result");
  if (input.kind === "inline") {
    exactFields(input, ["kind", "text", "bytes", "truncated"], "inline result");
    if (typeof input.text !== "string" || typeof input.truncated !== "boolean") invalid("Inline result is invalid.");
    const bytes = nonNegativeInteger(input.bytes, "result.bytes");
    if (Buffer.byteLength(input.text, "utf8") !== bytes) invalid("Inline result byte count is invalid.");
    if (input.truncated
      && !input.text.endsWith(TASK_RESULT_TRUNCATION_MARKER)
      && !input.text.endsWith(TASK_RESULT_MIN_TRUNCATION_MARKER)) {
      invalid("Truncated inline result is missing its explicit marker.");
    }
    const sanitized = sanitizedText(input.text, "result.text", Number.MAX_SAFE_INTEGER, true, sensitiveValues);
    const sanitizedBytes = Buffer.byteLength(sanitized, "utf8");
    if (!allowOversizeInline && sanitizedBytes > MAX_PERSISTED_TEXT_BYTES) invalid("Persisted inline result exceeds its durable cap.");
    return { kind: "inline", text: sanitized, bytes: sanitizedBytes, truncated: input.truncated };
  }
  if (input.kind === "ref") {
    exactFields(input, ["kind", "resultRef", "bytes", "truncated"], "referenced result");
    if (typeof input.truncated !== "boolean") invalid("Referenced result is invalid.");
    const resultRef = identifier(input.resultRef, "result.resultRef", 2_048);
    if (sanitizedText(resultRef, "result.resultRef", 2_048, false, sensitiveValues) !== resultRef) invalid("Result reference contains sensitive material.");
    return { kind: "ref", resultRef, bytes: nonNegativeInteger(input.bytes, "result.bytes"), truncated: input.truncated };
  }
  return invalid("Result kind is invalid.");
}

function parseSteerIntent(value: unknown, sensitiveValues: readonly string[] = []): AsyncTaskSteerIntent {
  const input = objectValue(value, "steer intent");
  exactFields(input, ["intentId", "version", "requestedAtMs", "message", "consumedAtMs"], "steer intent");
  return {
    intentId: identifier(input.intentId, "steer.intentId"),
    version: positiveInteger(input.version, "steer.version"),
    requestedAtMs: nonNegativeInteger(input.requestedAtMs, "steer.requestedAtMs"),
    message: sanitizedText(input.message, "steer.message", 4_096, false, sensitiveValues),
    consumedAtMs: nullableInteger(input.consumedAtMs, "steer.consumedAtMs"),
  };
}

function parseAbortIntent(value: unknown): AsyncTaskAbortIntent {
  const input = objectValue(value, "abort intent");
  exactFields(input, ["intentId", "version", "requestedAtMs", "reason", "consumedAtMs"], "abort intent");
  if (!isAbortReason(input.reason)) invalid("Abort reason is invalid.");
  return {
    intentId: identifier(input.intentId, "abort.intentId"),
    version: positiveInteger(input.version, "abort.version"),
    requestedAtMs: nonNegativeInteger(input.requestedAtMs, "abort.requestedAtMs"),
    reason: input.reason,
    consumedAtMs: nullableInteger(input.consumedAtMs, "abort.consumedAtMs"),
  };
}

function parseWakePayload(value: unknown, sensitiveValues: readonly string[] = []): AsyncTaskWakePayload {
  const input = objectValue(value, "wake payload");
  exactFields(input, ["status", "attempt", "summary", "code", "resultRef"], "wake payload");
  const code = input.code === null ? null : parseFailure({ code: input.code, message: "wake", retryable: false }, sensitiveValues).code;
  const resultRef = nullableString(input.resultRef, "wake.resultRef", 2_048);
  if (resultRef !== null && sanitizedText(resultRef, "wake.resultRef", 2_048, false, sensitiveValues) !== resultRef) invalid("Wake result reference contains sensitive material.");
  return {
    status: parseStatus(input.status),
    attempt: nonNegativeInteger(input.attempt, "wake.attempt"),
    summary: nullableSanitizedText(input.summary, "wake.summary", 4_096, sensitiveValues),
    code,
    resultRef,
  };
}

function parseLease(row: TaskRow | AttemptRow): AsyncTaskLease | null {
  if (row.lease_owner === null && row.lease_expires_at_ms === null && row.lease_version === null) return null;
  if (row.lease_owner === null || row.lease_expires_at_ms === null || row.lease_version === null) invalid("Persisted lease is incomplete.");
  const attempt = "lease_attempt" in row ? row.lease_attempt : row.attempt;
  if (attempt === null) invalid("Persisted lease attempt is missing.");
  return {
    ownerId: identifier(row.lease_owner, "lease.ownerId"),
    expiresAtMs: nonNegativeInteger(row.lease_expires_at_ms, "lease.expiresAtMs"),
    attempt: positiveInteger(attempt, "lease.attempt"),
    version: positiveInteger(row.lease_version, "lease.version"),
  };
}

function parseOptionalJson<T>(value: string | null, name: string, parser: (input: unknown) => T): T | null {
  return value === null ? null : parser(parseJson(value, name));
}

function taskFromRow(row: TaskRow, sensitiveValues: readonly string[] = []): AsyncTaskRecord {
  if (row.kind !== "subagent" || row.depth !== 1) invalid("Persisted task contract is invalid.");
  const lineage = parseLineage(parseJson(row.lineage_json, "task lineage"));
  if (row.input_json === null) invalid("Persisted task input is missing.");
  const input = parseTaskInputV1(parseJson(row.input_json, "task input"));
  if (lineage.parentAgentId !== row.agent_id || lineage.parentTurnId !== row.parent_turn_id) invalid("Persisted task lineage is inconsistent.");
  const attempt = nonNegativeInteger(row.attempt, "task.attempt");
  const lease = parseLease(row);
  if (lease !== null && lease.attempt !== attempt) invalid("Persisted lease attempt is inconsistent.");
  const record: AsyncTaskRecord = {
    taskId: identifier(row.task_id, "task.taskId"),
    agentId: identifier(row.agent_id, "task.agentId"),
    parentTurnId: identifier(row.parent_turn_id, "task.parentTurnId"),
    kind: "subagent",
    status: parseStatus(row.status),
    attempt,
    version: positiveInteger(row.version, "task.version"),
    clientNonce: requireTaskClientNonce(row.client_nonce),
    depth: 1,
    createdAtMs: nonNegativeInteger(row.created_at_ms, "task.createdAtMs"),
    startedAtMs: nullableInteger(row.started_at_ms, "task.startedAtMs"),
    finishedAtMs: nullableInteger(row.finished_at_ms, "task.finishedAtMs"),
    settledAtMs: nullableInteger(row.settled_at_ms, "task.settledAtMs"),
    nextAttemptAtMs: nullableInteger(row.next_attempt_at_ms, "task.nextAttemptAtMs"),
    lease,
    progress: parseOptionalJson(row.progress_json, "task progress", (value) => parseProgress(value, sensitiveValues)),
    result: parseOptionalJson(row.result_json, "task result", (value) => parseResult(value, sensitiveValues)),
    error: parseOptionalJson(row.error_json, "task error", (value) => parseFailure(value, sensitiveValues)),
    steerIntent: parseOptionalJson(row.steer_intent_json, "task steer intent", (value) => parseSteerIntent(value, sensitiveValues)),
    steerVersion: nonNegativeInteger(row.steer_version, "task.steerVersion"),
    abortIntent: parseOptionalJson(row.abort_intent_json, "task abort intent", parseAbortIntent),
    abortVersion: nonNegativeInteger(row.abort_version, "task.abortVersion"),
    lineage,
    input,
  };
  if (record.status === "queued" && record.attempt !== 0) invalid("Persisted queued task has an attempt.");
  if (record.status !== "queued" && record.status !== "cancelled" && record.attempt === 0) invalid("Persisted task status requires a current attempt.");
  const mustHaveLease = record.status === "admitted" || record.status === "running" || record.status === "cancelling";
  if (mustHaveLease !== (record.lease !== null)) invalid("Persisted task lease does not match its status.");
  if ((record.status === "retry_wait") !== (record.nextAttemptAtMs !== null)) invalid("Persisted retry timestamp does not match task status.");
  const terminal = record.status === "completed" || record.status === "failed" || record.status === "cancelled";
  if (terminal !== (record.finishedAtMs !== null)) invalid("Persisted task finish timestamp does not match its status.");
  if (record.startedAtMs !== null && record.startedAtMs < record.createdAtMs) invalid("Persisted task starts before creation.");
  if (record.finishedAtMs !== null && record.finishedAtMs < (record.startedAtMs ?? record.createdAtMs)) invalid("Persisted task finishes before it starts.");
  if (record.settledAtMs !== null && (record.finishedAtMs === null || record.settledAtMs < record.finishedAtMs || row.settlement_nonce === null)) invalid("Persisted settlement is incoherent.");
  if (record.settledAtMs === null && row.settlement_nonce !== null) invalid("Persisted settlement nonce has no settlement timestamp.");
  if (record.status === "completed" && (record.result === null || record.error !== null)) invalid("Persisted completed task has incoherent result state.");
  if (record.status === "failed" && record.error === null) invalid("Persisted failed task is missing its error.");
  if (record.status === "abandoned" && record.error === null) invalid("Persisted abandoned task is missing its error.");
  if (record.status === "cancelled" && (record.error === null || (record.error.code !== "aborted" && record.error.code !== "budget_exhausted" && record.error.code !== "capability_denied"))) {
    invalid("Persisted cancelled task has an incoherent error.");
  }
  if ((record.steerIntent === null) !== (record.steerVersion === 0) || (record.steerIntent !== null && record.steerIntent.version !== record.steerVersion)) invalid("Persisted steer version is inconsistent.");
  if ((record.abortIntent === null) !== (record.abortVersion === 0) || (record.abortIntent !== null && record.abortIntent.version !== record.abortVersion)) invalid("Persisted abort version is inconsistent.");
  return record;
}

function attemptFromRow(row: AttemptRow, sensitiveValues: readonly string[] = []): AsyncTaskAttemptRecord {
  const status = parseStatus(row.status);
  if (status === "queued") invalid("Persisted attempt cannot be queued.");
  const record: AsyncTaskAttemptRecord = {
    attemptId: identifier(row.attempt_id, "attempt.attemptId"),
    taskId: identifier(row.task_id, "attempt.taskId"),
    attempt: positiveInteger(row.attempt, "attempt.attempt"),
    status,
    version: positiveInteger(row.version, "attempt.version"),
    createdAtMs: nonNegativeInteger(row.created_at_ms, "attempt.createdAtMs"),
    startedAtMs: nullableInteger(row.started_at_ms, "attempt.startedAtMs"),
    finishedAtMs: nullableInteger(row.finished_at_ms, "attempt.finishedAtMs"),
    lease: parseLease(row),
    error: parseOptionalJson(row.error_json, "attempt error", (value) => parseFailure(value, sensitiveValues)),
  };
  const mustHaveLease = record.status === "admitted" || record.status === "running" || record.status === "cancelling";
  if (mustHaveLease !== (record.lease !== null)) invalid("Persisted attempt lease does not match its status.");
  const finished = record.status === "retry_wait" || record.status === "completed" || record.status === "failed" || record.status === "cancelled" || record.status === "abandoned";
  if (finished !== (record.finishedAtMs !== null)) invalid("Persisted attempt finish timestamp does not match its status.");
  if (record.startedAtMs !== null && record.startedAtMs < record.createdAtMs) invalid("Persisted attempt starts before creation.");
  if (record.finishedAtMs !== null && record.finishedAtMs < (record.startedAtMs ?? record.createdAtMs)) invalid("Persisted attempt finishes before it starts.");
  if (record.status === "failed" && record.error === null) invalid("Persisted failed attempt is missing its error.");
  if (record.status === "abandoned" && record.error === null) invalid("Persisted abandoned attempt is missing its error.");
  if (record.status === "cancelled" && (record.error === null || (record.error.code !== "aborted" && record.error.code !== "budget_exhausted" && record.error.code !== "capability_denied"))) {
    invalid("Persisted cancelled attempt has an incoherent error.");
  }
  return record;
}

function outboxFromRow(row: OutboxRow, sensitiveValues: readonly string[] = []): AsyncTaskOutboxEvent {
  if (!isWakeKind(row.wake_kind)) invalid("Persisted wake kind is invalid.");
  const event: AsyncTaskOutboxEvent = {
    outboxId: identifier(row.outbox_id, "outbox.outboxId"),
    taskId: identifier(row.task_id, "outbox.taskId"),
    transitionVersion: positiveInteger(row.transition_version, "outbox.transitionVersion"),
    wakeKind: row.wake_kind,
    payload: parseWakePayload(parseJson(row.payload_json, "outbox payload"), sensitiveValues),
    createdAtMs: nonNegativeInteger(row.created_at_ms, "outbox.createdAtMs"),
    deliveredAtMs: nullableInteger(row.delivered_at_ms, "outbox.deliveredAtMs"),
  };
  if (event.deliveredAtMs !== null && event.deliveredAtMs < event.createdAtMs) invalid("Persisted outbox delivery precedes event creation.");
  const { payload } = event;
  if (event.wakeKind === "task_created" && (event.transitionVersion !== 1 || payload.status !== "queued" || payload.attempt !== 0 || payload.code !== null || payload.resultRef !== null)) {
    invalid("Persisted task-created wake payload is incoherent.");
  }
  if (event.wakeKind === "task_terminal") {
    if (payload.status !== "completed" && payload.status !== "failed" && payload.status !== "cancelled") invalid("Persisted terminal wake is not terminal.");
    if (payload.status === "completed" && payload.code !== null) invalid("Persisted completed wake contains an error code.");
    if (payload.status === "failed" && payload.code === null) invalid("Persisted failed wake is missing an error code.");
    if (payload.status === "cancelled" && payload.code !== "aborted" && payload.code !== "budget_exhausted" && payload.code !== "capability_denied") invalid("Persisted cancelled wake has an incoherent error code.");
  }
  if (event.wakeKind === "task_abort" && (payload.status !== "cancelling" && payload.status !== "cancelled")) invalid("Persisted abort wake has an incoherent status.");
  if (event.wakeKind === "task_abort" && payload.status === "cancelling" && payload.attempt === 0) invalid("Persisted cancelling wake is missing its attempt.");
  if (event.wakeKind === "task_recovered" && (payload.status !== "abandoned" || payload.attempt === 0 || payload.code !== "internal_error")) {
    invalid("Persisted recovered wake has an incoherent payload.");
  }
  if (event.wakeKind === "task_steer" && ((payload.status !== "admitted" && payload.status !== "running") || payload.attempt === 0)) {
    invalid("Persisted steer wake has an incoherent payload.");
  }
  if (event.wakeKind === "task_progress" && ((payload.status !== "admitted" && payload.status !== "running" && payload.status !== "cancelling") || payload.attempt === 0)) {
    invalid("Persisted progress wake has an incoherent status.");
  }
  return event;
}

function canonicalBudget(value: unknown): SubagentBudget {
  const input = objectValue(value, "budget");
  exactFields(input, [...BUDGET_FIELDS, "maxDepth"], "budget");
  if (input.maxDepth !== 1) invalid("budget.maxDepth must be one.");
  return {
    maxWallMs: nonNegativeInteger(input.maxWallMs, "budget.maxWallMs"),
    maxProviderCalls: nonNegativeInteger(input.maxProviderCalls, "budget.maxProviderCalls"),
    maxInputTokens: nonNegativeInteger(input.maxInputTokens, "budget.maxInputTokens"),
    maxOutputTokens: nonNegativeInteger(input.maxOutputTokens, "budget.maxOutputTokens"),
    maxToolRounds: nonNegativeInteger(input.maxToolRounds, "budget.maxToolRounds"),
    maxToolCalls: nonNegativeInteger(input.maxToolCalls, "budget.maxToolCalls"),
    maxMcpCalls: nonNegativeInteger(input.maxMcpCalls, "budget.maxMcpCalls"),
    maxBrowserCommands: nonNegativeInteger(input.maxBrowserCommands, "budget.maxBrowserCommands"),
    maxResultBytes: nonNegativeInteger(input.maxResultBytes, "budget.maxResultBytes"),
    maxWorkspaceWriteBytes: nonNegativeInteger(input.maxWorkspaceWriteBytes, "budget.maxWorkspaceWriteBytes"),
    maxDepth: 1,
  };
}

function validateDispatchInput(input: DispatchAsyncTaskInput): {
  readonly taskId: string;
  readonly agentId: string;
  readonly parentTurnId: string;
  readonly clientNonce: string;
  readonly createdAtMs: number;
  readonly lineage: AsyncTaskRecord["lineage"];
  readonly grant: DelegatedCapabilityGrant;
  readonly budget: SubagentBudget;
  readonly parentBudget?: SubagentBudget;
  readonly input: TaskInputV1;
} {
  if (input.kind !== "subagent") invalid("Task kind is invalid.");
  const taskId = identifier(input.taskId, "taskId");
  const agentId = identifier(input.agentId, "agentId");
  const parentTurnId = identifier(input.parentTurnId, "parentTurnId");
  const clientNonce = requireTaskClientNonce(input.clientNonce);
  const createdAtMs = nonNegativeInteger(input.createdAtMs, "createdAtMs");
  const lineage = parseLineage(input.lineage);
  const grant = parseDelegatedCapabilityGrant(input.grant);
  const budget = canonicalBudget(input.budget);
  const parentBudget = input.parentBudget === undefined ? undefined : canonicalBudget(input.parentBudget);
  const taskInput = parseTaskInputV1(input.input);
  if (grant.revokedAt !== undefined && (grant.revokedAt < grant.issuedAt || grant.revokedAt > grant.expiresAt)) {
    invalid("Capability grant revocation is outside its lifetime.");
  }
  if (lineage.parentAgentId !== agentId || lineage.parentTurnId !== parentTurnId) invalid("Task lineage does not match task scope.");
  if (lineage.parentTaskId !== null || lineage.depth !== 1) invalid("Depth-1 tasks cannot have a parent task.");
  if (grant.taskId !== taskId || grant.parentAgentId !== agentId || grant.parentTurnId !== parentTurnId || grant.childRunId !== lineage.childRunId || grant.depth !== lineage.depth) {
    invalid("Capability grant does not match task lineage.");
  }
  if (grant.issuedAt > createdAtMs || grant.expiresAt <= createdAtMs || (grant.revokedAt !== undefined && grant.revokedAt <= createdAtMs)) {
    invalid("Capability grant is not active at task creation.");
  }
  const taskDeadlineMs = createdAtMs + budget.maxWallMs;
  const grantBoundaryMs = Math.min(grant.expiresAt, grant.revokedAt ?? grant.expiresAt);
  if (!Number.isSafeInteger(taskDeadlineMs) || (budget.maxWallMs > 0 && grantBoundaryMs > taskDeadlineMs)) {
    invalid("Capability grant cannot outlive the task wall budget.");
  }
  if (taskInput.source.agentId !== agentId) invalid("Task input source agent does not match task scope.");
  return { taskId, agentId, parentTurnId, clientNonce, createdAtMs, lineage, grant, budget, parentBudget, input: taskInput };
}

export class AsyncTaskStore {
  private readonly db: Database.Database;
  private readonly ownsDatabase: boolean;
  private readonly nowFn: () => number;
  private readonly sensitiveValuesFn: () => readonly string[];
  readonly path: string;
  private closed = false;

  constructor(opts: AsyncTaskStoreOptions) {
    if (typeof opts.path !== "string" || opts.path.length === 0) invalid("Async task store path is required.");
    if (typeof opts.sensitiveValues !== "function") invalid("Async task store sensitiveValues callback is required.");
    this.sensitiveValuesFn = opts.sensitiveValues;
    this.sensitiveValues();
    if (opts.path !== ":memory:") fs.mkdirSync(path.dirname(opts.path), { recursive: true });
    this.path = opts.path;
    this.nowFn = opts.now ?? Date.now;
    let database = opts.database;
    this.ownsDatabase = database === undefined;
    try {
      database ??= new Database(opts.path);
      this.db = database;
      this.db.pragma("foreign_keys = ON");
      if (this.ownsDatabase) {
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
        this.db.pragma("busy_timeout = 5000");
      }
      migrateOpenBotSchema(this.db);
    } catch (error) {
      if (this.ownsDatabase) database?.close();
      throw error;
    }
  }

  private ensureOpen(): void {
    if (this.closed) invalid("Async task store is closed.");
  }

  private now(): number {
    return nonNegativeInteger(this.nowFn(), "clock");
  }

  private sensitiveValues(): readonly string[] {
    let values: readonly string[];
    try {
      values = this.sensitiveValuesFn();
    } catch {
      invalid("Async task store sensitiveValues callback failed.");
    }
    if (!Array.isArray(values)) invalid("Async task store sensitiveValues callback must return an array.");
    const normalized = values.map((value) => {
      if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001F\u007F]/u.test(value)) invalid("Sensitive values must be safe strings.");
      const result = value.normalize("NFC");
      const bytes = Buffer.byteLength(result, "utf8");
      if (bytes < 4 || bytes > 4_096 || result.includes(REDACTED_TEXT)) {
        invalid("Sensitive values must contain between 4 and 4096 UTF-8 bytes and cannot contain the redaction marker.");
      }
      return result;
    });
    return [...new Set(normalized)].sort((left, right) => Buffer.byteLength(right, "utf8") - Buffer.byteLength(left, "utf8"));
  }

  private taskFromRow(row: TaskRow): AsyncTaskRecord {
    const sensitiveValues = this.sensitiveValues();
    const task = taskFromRow(row, sensitiveValues);
    assertNoKnownSensitiveValue(task, sensitiveValues, "Persisted task aggregate");
    return task;
  }

  private attemptFromRow(row: AttemptRow): AsyncTaskAttemptRecord {
    const sensitiveValues = this.sensitiveValues();
    const attempt = attemptFromRow(row, sensitiveValues);
    assertNoKnownSensitiveValue(attempt, sensitiveValues, "Persisted task attempt");
    return attempt;
  }

  private outboxFromRow(row: OutboxRow): AsyncTaskOutboxEvent {
    const sensitiveValues = this.sensitiveValues();
    const event = outboxFromRow(row, sensitiveValues);
    assertNoKnownSensitiveValue(event, sensitiveValues, "Persisted outbox event");
    return event;
  }

  private projectionFromRow(row: ProjectionRow): AsyncTaskProjectionEnvelope {
    const payload = parseWakePayload(parseJson(row.payload_json, "projection payload"), this.sensitiveValues());
    if ((row.channel !== "async-tasks" && row.channel !== "subagents") || !isWakeKind(row.kind)) {
      invalid("Persisted projection envelope is invalid.");
    }
    return {
      projectionId: identifier(row.projection_id, "projectionId"),
      epoch: identifier(row.epoch, "projection epoch"),
      sequence: positiveInteger(row.sequence, "projection sequence"),
      agentId: identifier(row.agent_id, "projection agentId"),
      taskId: identifier(row.task_id, "projection taskId"),
      snapshotVersion: positiveInteger(row.snapshot_version, "projection snapshotVersion"),
      channel: row.channel,
      kind: row.kind,
      payload,
    };
  }

  private operationNow(metadataMs: number, name: string): number {
    const operationNow = this.now();
    if (metadataMs > operationNow) invalid(`${name} timestamp cannot be in the future.`);
    return operationNow;
  }

  private validateOutboxAgainstTask(event: AsyncTaskOutboxEvent): AsyncTaskOutboxEvent {
    const task = this.getTask(event.taskId);
    if (task === null) invalid("Persisted outbox event has no task.");
    if (event.transitionVersion > task.version || event.payload.attempt > task.attempt) {
      invalid("Persisted outbox event is ahead of its task aggregate.");
    }
    if (event.transitionVersion === task.version
      && (event.payload.status !== task.status || event.payload.attempt !== task.attempt)) {
      invalid("Latest persisted outbox event does not match its task aggregate.");
    }
    if (event.wakeKind === "task_terminal") {
      const taskResultRef = task.result?.kind === "ref" ? task.result.resultRef : null;
      if ((task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled")
        || event.transitionVersion !== task.version
        || event.payload.status !== task.status
        || event.payload.attempt !== task.attempt
        || event.payload.code !== (task.error?.code ?? null)
        || event.payload.resultRef !== taskResultRef) {
        invalid("Persisted terminal outbox event does not exactly match its immutable task.");
      }
    }
    return event;
  }

  private revokeGrantInTransaction(taskId: string, operationNow: number, clipLease = true): DelegatedCapabilityGrant {
    const current = this.getGrant(taskId);
    if (current === null) invalid("Task capability grant does not exist.");
    const revokedAt = Math.min(current.revokedAt ?? operationNow, operationNow, current.expiresAt);
    const revoked = parseDelegatedCapabilityGrant({ ...current, revokedAt, version: current.version + 1 });
    const changed = this.db.prepare(`
      UPDATE async_task_grants
      SET grant_json = ?, version = ?, revoked_at_ms = ?, updated_at_ms = ?
      WHERE task_id = ? AND version = ?
    `).run(JSON.stringify(revoked), revoked.version, revokedAt, operationNow, taskId, current.version);
    if (changed.changes !== 1) casRejected("Grant authority fence lost its compare-and-swap version.");
    if (clipLease) {
      this.db.prepare(`
        UPDATE async_tasks SET lease_expires_at_ms = MIN(lease_expires_at_ms, ?)
        WHERE task_id = ? AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms > ?
      `).run(revokedAt, taskId, revokedAt);
      this.db.prepare(`
        UPDATE async_task_attempts SET lease_expires_at_ms = MIN(lease_expires_at_ms, ?)
        WHERE task_id = ? AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms > ?
      `).run(revokedAt, taskId, revokedAt);
    }
    return revoked;
  }

  private insertOutbox(
    taskId: string,
    transitionVersion: number,
    wakeKind: AsyncTaskWakeKind,
    payload: AsyncTaskWakePayload,
    createdAtMs: number,
  ): AsyncTaskOutboxEvent {
    const outboxId = randomUUID();
    const sensitiveValues = this.sensitiveValues();
    const parsedPayload = parseWakePayload(payload, sensitiveValues);
    assertNoKnownSensitiveValue({ outboxId, taskId, wakeKind, payload: parsedPayload }, sensitiveValues, "Outbox event");
    this.db.prepare(`
      INSERT INTO async_task_outbox(outbox_id, task_id, transition_version, wake_kind, payload_json, created_at_ms, delivered_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(outboxId, taskId, transitionVersion, wakeKind, JSON.stringify(parsedPayload), createdAtMs);
    const row = this.db.prepare<unknown[], OutboxRow>("SELECT * FROM async_task_outbox WHERE outbox_id = ?").get(outboxId)
      ?? invalid("Inserted outbox event is missing.");
    return this.validateOutboxAgainstTask(this.outboxFromRow(row));
  }

  private operationalWindow(task: AsyncTaskRecord): {
    readonly budgetDeadlineMs: number;
    readonly effectDeadlineMs: number;
    readonly revokedAtMs: number | null;
  } {
    const grant = this.getGrant(task.taskId);
    const budgetState = this.getBudgetState(task.taskId);
    if (grant === null || budgetState === null) invalid("Task grant or budget state is missing.");
    const wallDeadline = task.createdAtMs + budgetState.budget.maxWallMs;
    if (!Number.isSafeInteger(wallDeadline)) invalid("Task wall deadline is outside the safe integer range.");
    const budgetDeadlineMs = Math.min(wallDeadline, grant.expiresAt);
    const revokedAtMs = grant.revokedAt ?? null;
    return {
      budgetDeadlineMs,
      effectDeadlineMs: Math.min(budgetDeadlineMs, revokedAtMs ?? budgetDeadlineMs),
      revokedAtMs,
    };
  }

  private assertBudgetLeaseAuthorityInTransaction(
    taskId: string,
    fence: AsyncTaskBudgetLeaseFence,
    operationNow: number,
  ): AsyncTaskRecord {
    const task = this.requireTask(taskId);
    if (task.status !== "admitted" && task.status !== "running") {
      invalid("Budget authority requires an admitted or running task.");
    }
    if (task.version !== fence.expectedTaskVersion || task.attempt !== fence.attempt
      || task.lease === null || task.lease.ownerId !== fence.leaseOwnerId
      || task.lease.attempt !== fence.attempt || task.lease.version !== task.version
      || task.lease.expiresAtMs <= operationNow) {
      casRejected("Budget operation lost its current task and live lease fence.");
    }
    if (operationNow < this.currentAttemptFence(task)) {
      invalid("Budget operation precedes the current attempt fence.");
    }
    const window = this.operationalWindow(task);
    if (window.revokedAtMs !== null && operationNow >= window.revokedAtMs) {
      throw new AsyncTaskContractError("capability_denied", "Task capability grant is revoked.");
    }
    if (operationNow >= window.budgetDeadlineMs) {
      throw new AsyncTaskContractError("budget_exhausted", "Task grant or wall budget has expired.");
    }
    return task;
  }

  private currentAttemptFence(task: AsyncTaskRecord): number {
    if (task.attempt === 0) {
      if (task.status !== "queued" && task.status !== "cancelled") invalid("Task without attempts has an incoherent status.");
      if (task.lease !== null) invalid("Task without attempts cannot hold a lease.");
      return task.createdAtMs;
    }
    const row = this.db.prepare<unknown[], AttemptRow>("SELECT * FROM async_task_attempts WHERE task_id = ? AND attempt = ?")
      .get(task.taskId, task.attempt);
    if (row === undefined) invalid("Current task attempt is missing.");
    const attempt = this.attemptFromRow(row);
    if (attempt.taskId !== task.taskId || attempt.attempt !== task.attempt || attempt.createdAtMs < task.createdAtMs) {
      invalid("Current task attempt does not match its task.");
    }
    const activeStatuses: readonly AsyncTaskStatus[] = ["admitted", "running", "cancelling"];
    if (activeStatuses.includes(task.status) && attempt.status !== task.status) invalid("Active task and attempt statuses diverge.");
    if (task.status === "retry_wait" && attempt.status !== "retry_wait" && attempt.status !== "abandoned") invalid("Retry-wait task has an incoherent current attempt.");
    if (task.status === "abandoned" && attempt.status !== "abandoned") invalid("Abandoned task and attempt statuses diverge.");
    if ((task.status === "completed" || task.status === "failed" || task.status === "cancelled")
      && attempt.status !== task.status && attempt.status !== "retry_wait" && attempt.status !== "abandoned") {
      invalid("Terminal task has an incoherent current attempt.");
    }
    if ((task.lease === null) !== (attempt.lease === null)) invalid("Task and current attempt lease presence diverge.");
    if (task.lease !== null && attempt.lease !== null
      && (task.lease.ownerId !== attempt.lease.ownerId || task.lease.expiresAtMs !== attempt.lease.expiresAtMs
        || task.lease.attempt !== attempt.lease.attempt || task.lease.version !== attempt.lease.version)) {
      invalid("Task and current attempt lease fences diverge.");
    }
    return Math.max(
      task.createdAtMs,
      attempt.createdAtMs,
      attempt.startedAtMs ?? 0,
      attempt.finishedAtMs ?? 0,
    );
  }

  private assertTimestampAtOrAfterCurrentAttempt(task: AsyncTaskRecord, atMs: number, operation: string): void {
    if (atMs < this.currentAttemptFence(task)) invalid(`${operation} timestamp precedes the current attempt fence.`);
  }

  private expireBudgetExhaustedTasksInTransaction(operationNow: number): AsyncTaskRecord[] {
    const rows = this.db.prepare<unknown[], TaskRow>(`
      SELECT * FROM async_tasks
      WHERE status IN ('queued', 'retry_wait')
      ORDER BY created_at_ms, task_id
    `).all();
    const expired: AsyncTaskRecord[] = [];
    for (const row of rows) {
      let current: AsyncTaskRecord;
      let window: { readonly budgetDeadlineMs: number; readonly effectDeadlineMs: number; readonly revokedAtMs: number | null };
      try {
        current = this.taskFromRow(row);
        window = this.operationalWindow(current);
        if (operationNow < window.effectDeadlineMs) continue;
        this.assertTimestampAtOrAfterCurrentAttempt(current, operationNow, "Budget expiry");
      } catch (error) {
        // A single unreadable row must not abort expiry for every other task.
        if (error instanceof AsyncTaskContractError) continue;
        throw error;
      }
      assertTaskTransition(current.status, "cancelled");
      const nextVersion = current.version + 1;
      const revoked = window.revokedAtMs !== null && operationNow >= window.revokedAtMs;
      const error: AsyncTaskFailure = {
        code: revoked ? "capability_denied" : "budget_exhausted",
        message: revoked
          ? "Task capability grant was revoked before admission."
          : "Task wall budget expired before admission.",
        retryable: false,
      };
      const changed = this.db.prepare(`
        UPDATE async_tasks
        SET status = 'cancelled', version = ?, finished_at_ms = ?, next_attempt_at_ms = NULL,
            lease_owner = NULL, lease_expires_at_ms = NULL, lease_attempt = NULL, lease_version = NULL,
            error_json = ?
        WHERE task_id = ? AND status = ? AND version = ?
      `).run(nextVersion, operationNow, JSON.stringify(parseFailure(error, this.sensitiveValues())), current.taskId, current.status, current.version);
      if (changed.changes !== 1) continue;
      this.revokeGrantInTransaction(current.taskId, operationNow);
      this.insertOutbox(current.taskId, nextVersion, "task_terminal", {
        status: "cancelled",
        attempt: current.attempt,
        summary: error.message,
        code: error.code,
        resultRef: null,
      }, operationNow);
      const terminalTask = this.requireTask(current.taskId);
      this.settleParentBudgetInTransaction(terminalTask, operationNow);
      expired.push(terminalTask);
    }
    return expired;
  }

  sharesDatabase(database: Database.Database): boolean {
    return this.db === database;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDatabase) this.db.close();
  }

  isAgentFenced(agentIdValue: string): boolean {
    this.ensureOpen();
    const agentId = identifier(agentIdValue, "agentId");
    return this.db.prepare("SELECT 1 AS present FROM async_task_agent_fences WHERE agent_id = ?").get(agentId) !== undefined;
  }

  fenceAgent(agentIdValue: string, atMs = this.now()): void {
    this.ensureOpen();
    const agentId = identifier(agentIdValue, "agentId");
    const now = nonNegativeInteger(atMs, "fence timestamp");
    this.db.prepare("INSERT INTO async_task_agent_fences(agent_id, fenced_at_ms) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET fenced_at_ms = excluded.fenced_at_ms").run(agentId, now);
  }

  clearAgentFence(agentIdValue: string): void {
    this.ensureOpen();
    this.db.prepare("DELETE FROM async_task_agent_fences WHERE agent_id = ?").run(identifier(agentIdValue, "agentId"));
  }

  /** Atomically terminalizes every child before roster/home deletion. */
  terminalizeAgentTasks(agentIdValue: string, atMs = this.now()): AsyncTaskRecord[] {
    this.ensureOpen();
    const agentId = identifier(agentIdValue, "agentId");
    const operationNow = this.operationNow(nonNegativeInteger(atMs, "terminalization timestamp"), "Agent task terminalization");
    const operation = this.db.transaction(() => {
      const rows = this.db.prepare<unknown[], TaskRow>("SELECT * FROM async_tasks WHERE agent_id = ? AND status NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at_ms, task_id").all(agentId);
      const terminalized: AsyncTaskRecord[] = [];
      for (const row of rows) {
        const current = this.taskFromRow(row);
        const nextVersion = current.version + 1;
        const error: AsyncTaskFailure = { code: "aborted", message: "Parent agent was deleted.", retryable: false };
        const changed = this.db.prepare(`UPDATE async_tasks SET status = 'cancelled', version = ?, finished_at_ms = ?, next_attempt_at_ms = NULL,
          lease_owner = NULL, lease_expires_at_ms = NULL, lease_attempt = NULL, lease_version = NULL, error_json = ?
          WHERE task_id = ? AND version = ? AND status NOT IN ('completed', 'failed', 'cancelled')`).run(nextVersion, operationNow, JSON.stringify(error), current.taskId, current.version);
        if (changed.changes !== 1) continue;
        if (current.attempt > 0) {
          this.db.prepare(`UPDATE async_task_attempts SET status = 'cancelled', version = version + 1, finished_at_ms = ?,
            lease_owner = NULL, lease_expires_at_ms = NULL, lease_version = NULL, error_json = ?
            WHERE task_id = ? AND attempt = ? AND status NOT IN ('completed', 'failed', 'cancelled')`).run(operationNow, JSON.stringify(error), current.taskId, current.attempt);
        }
        this.revokeGrantInTransaction(current.taskId, operationNow);
        this.insertOutbox(current.taskId, nextVersion, "task_terminal", {
          status: "cancelled", attempt: current.attempt, summary: error.message, code: error.code, resultRef: null,
        }, operationNow);
        const terminalTask = this.requireTask(current.taskId);
        this.settleParentBudgetInTransaction(terminalTask, operationNow);
        terminalized.push(terminalTask);
      }
      return terminalized;
    });
    return operation.immediate();
  }

  /** Removes every durable task row for a committed agent deletion so a recreated id starts empty. */
  purgeAgentTasks(agentIdValue: string): void {
    this.ensureOpen();
    const agentId = identifier(agentIdValue, "agentId");
    const operation = this.db.transaction(() => {
      this.db.prepare("DELETE FROM async_tasks WHERE agent_id = ?").run(agentId);
      this.db.prepare("DELETE FROM async_task_parent_budget_usage WHERE agent_id = ?").run(agentId);
      this.db.prepare("DELETE FROM async_task_projection_state WHERE agent_id = ?").run(agentId);
      this.db.prepare("DELETE FROM async_task_agent_fences WHERE agent_id = ?").run(agentId);
    });
    operation.immediate();
  }

  private reserveParentBudgetInTransaction(validated: ReturnType<typeof validateDispatchInput>): SubagentBudget {
    if (validated.parentBudget === undefined) return validated.budget;
    const existing = this.db.prepare<unknown[], ParentBudgetRow>("SELECT budget_json, usage_json, wall_used_ms, wall_reserved_ms, wall_reservations_json, version FROM async_task_parent_budget_usage WHERE agent_id = ? AND parent_turn_id = ?")
      .get(validated.agentId, validated.parentTurnId);
    const parentBudget = existing === undefined ? validated.parentBudget : canonicalBudget(parseJson(existing.budget_json, "parent budget"));
    const parentUsage = existing === undefined ? emptyBudgetUsage() : this.validateBudgetUsage(parentBudget, parseJson(existing.usage_json, "parent budget usage"));
    const remaining = { ...remainingBudget(parentBudget, parentUsage, 0), maxWallMs: Math.max(0, parentBudget.maxWallMs - (existing?.wall_used_ms ?? 0) - (existing?.wall_reserved_ms ?? 0)) };
    const effective = deriveEffectiveBudget(parentBudget, remaining, validated.budget);
    const reservation = budgetReservationForTask(validated.taskId, effective);
    const nextUsage = reserveBudget(parentBudget, parentUsage, reservation);
    const wallReservations = parentWallReservations(existing === undefined ? {} : parseJson(existing.wall_reservations_json, "parent wall reservations"));
    wallReservations[validated.taskId] = effective.maxWallMs;
    const nextWallReserved = (existing?.wall_reserved_ms ?? 0) + effective.maxWallMs;
    if (existing === undefined) {
      this.db.prepare(`INSERT INTO async_task_parent_budget_usage(agent_id, parent_turn_id, budget_json, usage_json, wall_used_ms, wall_reserved_ms, wall_reservations_json, version, updated_at_ms) VALUES (?, ?, ?, ?, 0, ?, ?, 1, ?)`)
        .run(validated.agentId, validated.parentTurnId, JSON.stringify(parentBudget), JSON.stringify(nextUsage), nextWallReserved, JSON.stringify(wallReservations), validated.createdAtMs);
    } else {
      const changed = this.db.prepare(`UPDATE async_task_parent_budget_usage SET usage_json = ?, wall_reserved_ms = ?, wall_reservations_json = ?, version = ?, updated_at_ms = ? WHERE agent_id = ? AND parent_turn_id = ? AND version = ?`)
        .run(JSON.stringify(nextUsage), nextWallReserved, JSON.stringify(wallReservations), existing.version + 1, validated.createdAtMs, validated.agentId, validated.parentTurnId, existing.version);
      if (changed.changes !== 1) casRejected("Parent budget reservation lost its compare-and-swap fence.");
    }
    return effective;
  }

  private settleParentBudgetInTransaction(task: AsyncTaskRecord, atMs: number): void {
    const row = this.db.prepare<unknown[], ParentBudgetRow>("SELECT budget_json, usage_json, wall_used_ms, wall_reserved_ms, wall_reservations_json, version FROM async_task_parent_budget_usage WHERE agent_id = ? AND parent_turn_id = ?")
      .get(task.agentId, task.parentTurnId);
    if (row === undefined) return;
    const budget = canonicalBudget(parseJson(row.budget_json, "parent budget"));
    const usage = this.validateBudgetUsage(budget, parseJson(row.usage_json, "parent budget usage"));
    if (!usage.reservations.some((reservation) => reservation.reservationId === task.taskId)) return;
    const child = this.getBudgetState(task.taskId);
    const actual = child === null ? emptyBudgetUsage().used : usageIncludingReservations(child.usage);
    const nextUsage = reconcileBudgetReservation(usage, task.taskId, actual);
    const wallReservations = parentWallReservations(parseJson(row.wall_reservations_json, "parent wall reservations"));
    const reservedWall = wallReservations[task.taskId] ?? 0;
    delete wallReservations[task.taskId];
    const elapsed = Math.max(0, Math.min(reservedWall, atMs - task.createdAtMs));
    const changed = this.db.prepare("UPDATE async_task_parent_budget_usage SET usage_json = ?, wall_used_ms = ?, wall_reserved_ms = ?, wall_reservations_json = ?, version = ?, updated_at_ms = ? WHERE agent_id = ? AND parent_turn_id = ? AND version = ?")
      .run(JSON.stringify(nextUsage), row.wall_used_ms + elapsed, Math.max(0, row.wall_reserved_ms - reservedWall), JSON.stringify(wallReservations), row.version + 1, atMs, task.agentId, task.parentTurnId, row.version);
    if (changed.changes !== 1) casRejected("Parent budget settlement lost its compare-and-swap fence.");
  }

  private validateBudgetUsage(budget: SubagentBudget, value: unknown): SubagentBudgetUsage {
    const validationId = `validate-parent-${randomUUID()}`;
    const validation = reserveBudget(budget, value, { reservationId: validationId, amounts: {
      providerCalls: 0, inputTokens: 0, outputTokens: 0, toolRounds: 0, toolCalls: 0, mcpCalls: 0, browserCommands: 0, resultBytes: 0, workspaceWriteBytes: 0,
    } });
    return { used: validation.used, reserved: validation.reserved, reservations: validation.reservations.filter((entry) => entry.reservationId !== validationId) };
  }

  dispatch(input: DispatchAsyncTaskInput): DispatchAsyncTaskResult {
    this.ensureOpen();
    const validated = validateDispatchInput(input);
    if (this.isAgentFenced(validated.agentId)) throw new AsyncTaskContractError("capability_denied", "Agent task dispatch is fenced.");
    const createdOutboxId = randomUUID();
    assertNoKnownSensitiveValue({
      taskId: validated.taskId,
      agentId: validated.agentId,
      parentTurnId: validated.parentTurnId,
      clientNonce: validated.clientNonce,
      lineage: validated.lineage,
      grant: validated.grant,
      createdOutboxId,
    }, this.sensitiveValues(), "Dispatch aggregate");
    const operation = this.db.transaction(() => {
      const existing = this.db.prepare<unknown[], TaskRow>("SELECT * FROM async_tasks WHERE agent_id = ? AND client_nonce = ?")
        .get(validated.agentId, validated.clientNonce);
      if (existing !== undefined) {
        const task = this.taskFromRow(existing);
        if (this.getGrant(task.taskId) === null || this.getBudgetState(task.taskId) === null) invalid("Deduplicated task aggregate is incomplete.");
        const createdEvent = this.db.prepare<unknown[], OutboxRow>(`
          SELECT * FROM async_task_outbox WHERE task_id = ? AND transition_version = 1 AND wake_kind = 'task_created'
        `).get(task.taskId);
        if (createdEvent === undefined || this.outboxFromRow(createdEvent).payload.status !== "queued") invalid("Deduplicated task is missing its creation event.");
        if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
          const terminalEvent = this.db.prepare<unknown[], OutboxRow>(`
            SELECT * FROM async_task_outbox WHERE task_id = ? AND transition_version = ? AND wake_kind = 'task_terminal'
          `).get(task.taskId, task.version);
          if (terminalEvent === undefined) invalid("Deduplicated terminal task is missing its terminal event.");
          this.validateOutboxAgainstTask(this.outboxFromRow(terminalEvent));
        }
        return { task, created: false };
      }
      const effectiveBudget = this.reserveParentBudgetInTransaction(validated);
      this.db.prepare(`
        INSERT INTO async_tasks
          (task_id, agent_id, parent_turn_id, kind, status, attempt, version, client_nonce, depth,
           created_at_ms, started_at_ms, finished_at_ms, next_attempt_at_ms,
           lease_owner, lease_expires_at_ms, lease_attempt, lease_version,
           progress_json, result_json, error_json, steer_intent_json, steer_version,
           abort_intent_json, abort_version, lineage_json, input_json)
        VALUES (?, ?, ?, 'subagent', 'queued', 0, 1, ?, 1, ?, NULL, NULL, NULL,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, 0, ?, ?)
      `).run(validated.taskId, validated.agentId, validated.parentTurnId, validated.clientNonce, validated.createdAtMs, JSON.stringify(validated.lineage), JSON.stringify(validated.input));
      this.db.prepare(`
        INSERT INTO async_task_grants(task_id, grant_id, grant_json, version, revoked_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(validated.taskId, validated.grant.grantId, JSON.stringify(validated.grant), validated.grant.version, validated.grant.revokedAt ?? null, validated.createdAtMs);
      this.db.prepare(`
        INSERT INTO async_task_budget_usage(task_id, budget_json, usage_json, version, updated_at_ms)
        VALUES (?, ?, ?, 1, ?)
      `).run(validated.taskId, JSON.stringify(effectiveBudget), JSON.stringify(emptyBudgetUsage()), validated.createdAtMs);
      const payload: AsyncTaskWakePayload = { status: "queued", attempt: 0, summary: null, code: null, resultRef: null };
      this.db.prepare(`
        INSERT INTO async_task_outbox(outbox_id, task_id, transition_version, wake_kind, payload_json, created_at_ms, delivered_at_ms)
        VALUES (?, ?, 1, 'task_created', ?, ?, NULL)
      `).run(createdOutboxId, validated.taskId, JSON.stringify(payload), validated.createdAtMs);
      if (effectiveBudget.maxWallMs === 0) {
        const error = parseFailure({
          code: "budget_exhausted",
          message: "Task has no remaining wall-clock budget.",
          retryable: false,
        }, this.sensitiveValues());
        const changed = this.db.prepare(`
          UPDATE async_tasks
          SET status = 'cancelled', version = 2, finished_at_ms = ?, error_json = ?
          WHERE task_id = ? AND status = 'queued' AND version = 1 AND attempt = 0
        `).run(validated.createdAtMs, JSON.stringify(error), validated.taskId);
        if (changed.changes !== 1) casRejected("Zero-wall task could not be finalized atomically.");
        this.revokeGrantInTransaction(validated.taskId, validated.createdAtMs);
        this.insertOutbox(validated.taskId, 2, "task_terminal", {
          status: "cancelled",
          attempt: 0,
          summary: error.message,
          code: error.code,
          resultRef: null,
        }, validated.createdAtMs);
      }
      const task = this.requireTask(validated.taskId);
      if (task.status === "cancelled") this.settleParentBudgetInTransaction(task, validated.createdAtMs);
      return { task, created: true };
    });
    return operation.immediate();
  }

  getTask(taskIdValue: string): AsyncTaskRecord | null {
    this.ensureOpen();
    const taskId = identifier(taskIdValue, "taskId");
    const row = this.db.prepare<unknown[], TaskRow>("SELECT * FROM async_tasks WHERE task_id = ?").get(taskId);
    return row === undefined ? null : this.taskFromRow(row);
  }

  private requireTask(taskId: string): AsyncTaskRecord {
    const task = this.getTask(taskId);
    if (task === null) invalid("Async task does not exist.");
    return task;
  }

  listTasks(agentIdValue?: string, options: { readonly limit?: number } = {}): AsyncTaskRecord[] {
    this.ensureOpen();
    const limit = options.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) invalid("Task list limit must be an integer between 1 and 200.");
    const rows = limit === undefined
      ? agentIdValue === undefined
        ? this.db.prepare<unknown[], TaskRow>("SELECT * FROM async_tasks ORDER BY created_at_ms, task_id").all()
        : this.db.prepare<unknown[], TaskRow>("SELECT * FROM async_tasks WHERE agent_id = ? ORDER BY created_at_ms, task_id").all(identifier(agentIdValue, "agentId"))
      : agentIdValue === undefined
        ? this.db.prepare<unknown[], TaskRow>("SELECT * FROM (SELECT * FROM async_tasks ORDER BY created_at_ms DESC, task_id DESC LIMIT ?) ORDER BY created_at_ms, task_id").all(limit)
        : this.db.prepare<unknown[], TaskRow>("SELECT * FROM (SELECT * FROM async_tasks WHERE agent_id = ? ORDER BY created_at_ms DESC, task_id DESC LIMIT ?) ORDER BY created_at_ms, task_id").all(identifier(agentIdValue, "agentId"), limit);
    return rows.map((row) => this.taskFromRow(row));
  }

  listAttempts(taskIdValue: string): AsyncTaskAttemptRecord[] {
    this.ensureOpen();
    const taskId = identifier(taskIdValue, "taskId");
    return this.db.prepare<unknown[], AttemptRow>("SELECT * FROM async_task_attempts WHERE task_id = ? ORDER BY attempt").all(taskId)
      .map((row) => this.attemptFromRow(row));
  }

  claimNext(agentIdValue: string, input: ClaimAsyncTaskInput): ClaimAsyncTaskResult | null {
    this.ensureOpen();
    const agentId = identifier(agentIdValue, "agentId");
    const ownerId = identifier(input.ownerId, "ownerId");
    const attemptId = randomUUID();
    assertNoKnownSensitiveValue({ ownerId, attemptId }, this.sensitiveValues(), "Claim structure");
    const nowMs = nonNegativeInteger(input.nowMs, "nowMs");
    const leaseDurationMs = positiveInteger(input.leaseDurationMs, "leaseDurationMs");
    const claim = this.db.transaction((): ClaimAsyncTaskResult | null => {
      const operationNow = this.operationNow(nowMs, "Claim");
      this.expireBudgetExhaustedTasksInTransaction(operationNow);
      const listCandidates = this.db.prepare<unknown[], TaskRow>(`
        SELECT * FROM async_tasks
        WHERE agent_id = ?
          AND (status = 'queued' OR (status = 'retry_wait' AND next_attempt_at_ms IS NOT NULL AND next_attempt_at_ms <= ?))
        ORDER BY COALESCE(next_attempt_at_ms, created_at_ms), created_at_ms, task_id
        LIMIT 64 OFFSET ?
      `);
      let candidate: TaskRow | undefined;
      let offset = 0;
      while (candidate === undefined) {
        const candidates = listCandidates.all(agentId, operationNow, offset);
        candidate = candidates.find((row) => {
          try {
            const task = this.taskFromRow(row);
            const window = this.operationalWindow(task);
            return operationNow >= this.currentAttemptFence(task) && operationNow < window.effectDeadlineMs;
          } catch (error) {
            // An unreadable candidate is skipped so one bad row cannot stall every claim.
            if (error instanceof AsyncTaskContractError) return false;
            throw error;
          }
        });
        if (candidate !== undefined || candidates.length < 64) break;
        offset += candidates.length;
      }
      if (candidate === undefined) return null;
      const candidateTask = this.taskFromRow(candidate);
      const window = this.operationalWindow(candidateTask);
      this.assertTimestampAtOrAfterCurrentAttempt(candidateTask, nowMs, "Claim");
      if (operationNow < this.currentAttemptFence(candidateTask) || operationNow >= window.effectDeadlineMs) return null;
      const requestedLeaseExpiresAtMs = operationNow + leaseDurationMs;
      if (!Number.isSafeInteger(requestedLeaseExpiresAtMs)) invalid("Lease expiry is outside the safe integer range.");
      const leaseExpiresAtMs = Math.min(requestedLeaseExpiresAtMs, window.effectDeadlineMs);
      const nextAttempt = candidate.attempt + 1;
      const nextVersion = candidate.version + 1;
      const changed = this.db.prepare(`
        UPDATE async_tasks
        SET status = 'admitted', attempt = ?, version = ?, next_attempt_at_ms = NULL,
            lease_owner = ?, lease_expires_at_ms = ?, lease_attempt = ?, lease_version = ?,
            progress_json = NULL, result_json = NULL, error_json = NULL
        WHERE task_id = ? AND status = ? AND version = ?
          AND (status = 'queued' OR (status = 'retry_wait' AND next_attempt_at_ms IS NOT NULL AND next_attempt_at_ms <= ?))
      `).run(nextAttempt, nextVersion, ownerId, leaseExpiresAtMs, nextAttempt, nextVersion,
        candidate.task_id, candidate.status, candidate.version, operationNow);
      if (changed.changes !== 1) return null;
      this.db.prepare(`
        INSERT INTO async_task_attempts
          (attempt_id, task_id, attempt, status, version, created_at_ms, started_at_ms, finished_at_ms,
           lease_owner, lease_expires_at_ms, lease_version, error_json)
        VALUES (?, ?, ?, 'admitted', 1, ?, NULL, NULL, ?, ?, ?, NULL)
      `).run(attemptId, candidate.task_id, nextAttempt, operationNow, ownerId, leaseExpiresAtMs, nextVersion);
      const task = this.requireTask(candidate.task_id);
      const attemptRow = this.db.prepare<unknown[], AttemptRow>("SELECT * FROM async_task_attempts WHERE attempt_id = ?").get(attemptId)
        ?? invalid("Claimed task attempt is missing.");
      const attempt = this.attemptFromRow(attemptRow);
      if (task.lease === null) invalid("Claim did not persist a lease.");
      this.currentAttemptFence(task);
      return { task, attempt, lease: task.lease };
    });
    return claim.immediate();
  }

  expireBudgetExhaustedTasks(nowMsValue = this.now()): AsyncTaskRecord[] {
    this.ensureOpen();
    const nowMs = nonNegativeInteger(nowMsValue, "nowMs");
    return this.db.transaction(() => {
      const operationNow = this.operationNow(nowMs, "Budget expiry");
      return this.expireBudgetExhaustedTasksInTransaction(operationNow);
    }).immediate();
  }

  start(input: StartAsyncTaskInput): AsyncTaskRecord {
    this.ensureOpen();
    const taskId = identifier(input.taskId, "taskId");
    const expectedVersion = positiveInteger(input.expectedVersion, "expectedVersion");
    const leaseOwnerId = identifier(input.leaseOwnerId, "leaseOwnerId");
    assertNoKnownSensitiveValue(leaseOwnerId, this.sensitiveValues(), "Start leaseOwnerId");
    const attempt = positiveInteger(input.attempt, "attempt");
    const startedAtMs = nonNegativeInteger(input.startedAtMs, "startedAtMs");
    assertTaskTransition("admitted", "running");
    const operation = this.db.transaction(() => {
      const operationNow = this.operationNow(startedAtMs, "Start");
      const current = this.requireTask(taskId);
      this.assertTimestampAtOrAfterCurrentAttempt(current, startedAtMs, "Start");
      const window = this.operationalWindow(current);
      if (window.revokedAtMs !== null && operationNow >= window.revokedAtMs) throw new AsyncTaskContractError("capability_denied", "Task capability grant is revoked.");
      if (operationNow >= window.budgetDeadlineMs) throw new AsyncTaskContractError("budget_exhausted", "Task grant or wall budget has expired.");
      const nextVersion = expectedVersion + 1;
      const changed = this.db.prepare(`
        UPDATE async_tasks
        SET status = 'running', version = ?, started_at_ms = COALESCE(started_at_ms, ?), lease_version = ?
        WHERE task_id = ? AND status = 'admitted' AND version = ? AND attempt = ?
          AND lease_owner = ? AND lease_attempt = ? AND lease_expires_at_ms > ?
      `).run(nextVersion, operationNow, nextVersion, taskId, expectedVersion, attempt, leaseOwnerId, attempt, operationNow);
      if (changed.changes !== 1) casRejected("Start lost its task version or lease ownership fence.");
      const attemptChanged = this.db.prepare(`
        UPDATE async_task_attempts
        SET status = 'running', version = version + 1, started_at_ms = COALESCE(started_at_ms, ?), lease_version = ?
        WHERE task_id = ? AND attempt = ? AND status = 'admitted' AND lease_owner = ?
      `).run(operationNow, nextVersion, taskId, attempt, leaseOwnerId);
      if (attemptChanged.changes !== 1) casRejected("Start could not advance the current attempt.");
      return this.requireTask(taskId);
    });
    return operation.immediate();
  }

  heartbeat(input: HeartbeatAsyncTaskInput): AsyncTaskRecord {
    this.ensureOpen();
    const taskId = identifier(input.taskId, "taskId");
    const expectedVersion = positiveInteger(input.expectedVersion, "expectedVersion");
    const leaseOwnerId = identifier(input.leaseOwnerId, "leaseOwnerId");
    assertNoKnownSensitiveValue(leaseOwnerId, this.sensitiveValues(), "Heartbeat leaseOwnerId");
    const attempt = positiveInteger(input.attempt, "attempt");
    const nowMs = nonNegativeInteger(input.nowMs, "nowMs");
    const leaseDurationMs = positiveInteger(input.leaseDurationMs, "leaseDurationMs");
    const operation = this.db.transaction(() => {
      const operationNow = this.operationNow(nowMs, "Heartbeat");
      const current = this.requireTask(taskId);
      this.assertTimestampAtOrAfterCurrentAttempt(current, nowMs, "Heartbeat");
      const window = this.operationalWindow(current);
      if (window.revokedAtMs !== null && operationNow >= window.revokedAtMs) throw new AsyncTaskContractError("capability_denied", "Task capability grant is revoked.");
      if (operationNow >= window.budgetDeadlineMs) throw new AsyncTaskContractError("budget_exhausted", "Task grant or wall budget has expired.");
      const requestedExpiresAtMs = operationNow + leaseDurationMs;
      if (!Number.isSafeInteger(requestedExpiresAtMs)) invalid("Lease expiry is outside the safe integer range.");
      const expiresAtMs = Math.min(requestedExpiresAtMs, window.effectDeadlineMs);
      const nextVersion = expectedVersion + 1;
      const changed = this.db.prepare(`
        UPDATE async_tasks
        SET version = ?, lease_expires_at_ms = ?, lease_version = ?
        WHERE task_id = ? AND status IN ('admitted', 'running', 'cancelling')
          AND version = ? AND attempt = ? AND lease_owner = ? AND lease_attempt = ?
          AND lease_expires_at_ms > ?
      `).run(nextVersion, expiresAtMs, nextVersion, taskId, expectedVersion, attempt, leaseOwnerId, attempt, operationNow);
      if (changed.changes !== 1) casRejected("Heartbeat lost its task version or lease ownership fence.");
      const attemptChanged = this.db.prepare(`
        UPDATE async_task_attempts
        SET version = version + 1, lease_expires_at_ms = ?, lease_version = ?
        WHERE task_id = ? AND attempt = ? AND status IN ('admitted', 'running', 'cancelling') AND lease_owner = ?
      `).run(expiresAtMs, nextVersion, taskId, attempt, leaseOwnerId);
      if (attemptChanged.changes !== 1) casRejected("Heartbeat could not renew the current attempt.");
      return this.requireTask(taskId);
    });
    return operation.immediate();
  }

  recordProgress(input: RecordAsyncTaskProgressInput): AsyncTaskRecord {
    this.ensureOpen();
    const taskId = identifier(input.taskId, "taskId");
    const expectedVersion = positiveInteger(input.expectedVersion, "expectedVersion");
    const leaseOwnerId = identifier(input.leaseOwnerId, "leaseOwnerId");
    assertNoKnownSensitiveValue(leaseOwnerId, this.sensitiveValues(), "Progress leaseOwnerId");
    const attempt = positiveInteger(input.attempt, "attempt");
    const parsedProgress = parseProgress(input.progress, this.sensitiveValues());
    const operation = this.db.transaction(() => {
      const operationNow = this.operationNow(parsedProgress.updatedAtMs, "Progress");
      const current = this.requireTask(taskId);
      this.assertTimestampAtOrAfterCurrentAttempt(current, parsedProgress.updatedAtMs, "Progress");
      if (current.status !== "admitted" && current.status !== "running") invalid("Only an admitted or running task can record progress.");
      const window = this.operationalWindow(current);
      if (window.revokedAtMs !== null && operationNow >= window.revokedAtMs) {
        throw new AsyncTaskContractError("capability_denied", "Task capability grant is revoked.");
      }
      if (operationNow >= window.budgetDeadlineMs) throw new AsyncTaskContractError("budget_exhausted", "Task grant or wall budget has expired.");
      const progress: AsyncTaskProgress = { ...parsedProgress, updatedAtMs: operationNow };
      const nextVersion = expectedVersion + 1;
      const changed = this.db.prepare(`
        UPDATE async_tasks
        SET version = ?, progress_json = ?, lease_version = ?
        WHERE task_id = ? AND status IN ('admitted', 'running') AND version = ? AND attempt = ?
          AND lease_owner = ? AND lease_attempt = ? AND lease_expires_at_ms > ?
      `).run(nextVersion, JSON.stringify(progress), nextVersion, taskId, expectedVersion, attempt, leaseOwnerId, attempt, operationNow);
      if (changed.changes !== 1) casRejected("Progress lost its task version or live lease ownership fence.");
      const attemptChanged = this.db.prepare(`
        UPDATE async_task_attempts SET version = version + 1, lease_version = ?
        WHERE task_id = ? AND attempt = ? AND status = ? AND lease_owner = ? AND lease_expires_at_ms > ?
      `).run(nextVersion, taskId, attempt, current.status, leaseOwnerId, operationNow);
      if (attemptChanged.changes !== 1) casRejected("Progress could not fence the active attempt.");
      this.insertOutbox(taskId, nextVersion, "task_progress", {
        status: current.status,
        attempt,
        summary: progress.summary,
        code: null,
        resultRef: null,
      }, operationNow);
      return this.requireTask(taskId);
    });
    return operation.immediate();
  }

  transition(input: TransitionAsyncTaskInput): AsyncTaskRecord {
    this.ensureOpen();
    const taskId = identifier(input.taskId, "taskId");
    const expectedVersion = positiveInteger(input.expectedVersion, "expectedVersion");
    const to = parseStatus(input.to);
    const atMs = nonNegativeInteger(input.atMs, "atMs");
    const leaseOwnerId = input.leaseOwnerId === undefined ? undefined : identifier(input.leaseOwnerId, "leaseOwnerId");
    if (leaseOwnerId !== undefined) assertNoKnownSensitiveValue(leaseOwnerId, this.sensitiveValues(), "Transition leaseOwnerId");
    const error = input.error === undefined || input.error === null ? null : parseFailure(input.error, this.sensitiveValues());
    const operation = this.db.transaction(() => {
      const operationNow = this.operationNow(atMs, "Transition");
      const current = this.requireTask(taskId);
      if (current.version !== expectedVersion) casRejected("Task version is stale.");
      assertTaskTransition(current.status, to);
      const supported = (current.status === "running" && to === "retry_wait")
        || (current.status === "retry_wait" && to === "failed")
        || (current.status === "abandoned" && (to === "retry_wait" || to === "failed" || to === "cancelled"));
      if (!supported) invalid("This transition must use its dedicated store operation.");
      if (atMs < current.createdAtMs || (current.startedAtMs !== null && atMs < current.startedAtMs)) {
        invalid("Transition timestamp precedes task creation or start.");
      }
      this.assertTimestampAtOrAfterCurrentAttempt(current, atMs, "Transition");
      const owned = current.status === "running";
      if (owned) {
        if (leaseOwnerId === undefined) invalid("leaseOwnerId is required for an owned transition.");
        const attempt = positiveInteger(input.attempt, "attempt");
        if (current.lease === null || current.lease.ownerId !== leaseOwnerId || current.attempt !== attempt || current.lease.attempt !== attempt || current.lease.expiresAtMs <= operationNow) {
          casRejected("Transition lost its task lease ownership fence.");
        }
      }
      const nextAttemptAtMs = to === "retry_wait"
        ? nonNegativeInteger(input.nextAttemptAtMs, "nextAttemptAtMs")
        : null;
      if (nextAttemptAtMs !== null && nextAttemptAtMs < operationNow) invalid("nextAttemptAtMs cannot precede the authoritative transition time.");
      if (to === "retry_wait") {
        const window = this.operationalWindow(current);
        if (window.revokedAtMs !== null && operationNow >= window.revokedAtMs) {
          throw new AsyncTaskContractError("capability_denied", "A revoked task cannot be retried.");
        }
        if (operationNow >= window.budgetDeadlineMs) throw new AsyncTaskContractError("budget_exhausted", "An expired task cannot be retried.");
        if (nextAttemptAtMs === null || nextAttemptAtMs >= window.effectDeadlineMs) {
          if (window.revokedAtMs !== null && window.revokedAtMs <= window.budgetDeadlineMs) {
            throw new AsyncTaskContractError("capability_denied", "Retry must occur before the task capability deadline.");
          }
          throw new AsyncTaskContractError("budget_exhausted", "Retry must occur before the task wall or grant expiry deadline.");
        }
      }
      if (to === "retry_wait" && error !== null && !error.retryable) invalid("Retry-wait requires a retryable error.");
      if (to === "failed" && error === null) invalid("Failed transition requires an error.");
      if (to === "cancelled" && (error === null || (error.code !== "aborted" && error.code !== "budget_exhausted" && error.code !== "capability_denied"))) invalid("Cancelled transition has an incoherent error.");
      const terminal = to === "failed" || to === "cancelled";
      const clearsLease = to === "retry_wait" || terminal;
      const nextVersion = expectedVersion + 1;
      const changed = this.db.prepare(`
        UPDATE async_tasks
        SET status = ?, version = ?, finished_at_ms = ?, next_attempt_at_ms = ?, error_json = ?,
            lease_owner = CASE WHEN ? = 1 THEN NULL ELSE lease_owner END,
            lease_expires_at_ms = CASE WHEN ? = 1 THEN NULL ELSE lease_expires_at_ms END,
            lease_attempt = CASE WHEN ? = 1 THEN NULL ELSE lease_attempt END,
            lease_version = CASE WHEN ? = 1 THEN NULL ELSE ? END
        WHERE task_id = ? AND status = ? AND version = ?
      `).run(to, nextVersion, terminal ? operationNow : null, nextAttemptAtMs, error === null ? null : JSON.stringify(error),
        clearsLease ? 1 : 0, clearsLease ? 1 : 0, clearsLease ? 1 : 0, clearsLease ? 1 : 0, nextVersion,
        taskId, current.status, expectedVersion);
      if (changed.changes !== 1) casRejected("Task transition lost its compare-and-swap fence.");

      if (owned && current.attempt > 0) {
        const attemptStatus = to;
        const attemptChanged = this.db.prepare(`
          UPDATE async_task_attempts
          SET status = ?, version = version + 1, finished_at_ms = ?, error_json = ?,
              lease_owner = CASE WHEN ? = 1 THEN NULL ELSE lease_owner END,
              lease_expires_at_ms = CASE WHEN ? = 1 THEN NULL ELSE lease_expires_at_ms END,
              lease_version = CASE WHEN ? = 1 THEN NULL ELSE ? END
          WHERE task_id = ? AND attempt = ? AND status = ?
        `).run(attemptStatus, to === "retry_wait" || terminal ? operationNow : null, error === null ? null : JSON.stringify(error),
          clearsLease ? 1 : 0, clearsLease ? 1 : 0, clearsLease ? 1 : 0, nextVersion,
          taskId, current.attempt, current.status);
        if (attemptChanged.changes !== 1) casRejected("Task transition could not advance the current attempt.");
      }

      if (terminal) {
        this.revokeGrantInTransaction(taskId, operationNow);
        const payload: AsyncTaskWakePayload = { status: to, attempt: current.attempt, summary: error?.message ?? null, code: error?.code ?? null, resultRef: null };
        this.insertOutbox(taskId, nextVersion, "task_terminal", payload, operationNow);
        this.settleParentBudgetInTransaction(this.requireTask(taskId), operationNow);
      }
      return this.requireTask(taskId);
    });
    return operation.immediate();
  }

  steer(input: SteerAsyncTaskInput): AsyncTaskRecord {
    this.ensureOpen();
    const taskId = identifier(input.taskId, "taskId");
    const agentId = identifier(input.agentId, "agentId");
    const parentTurnId = identifier(input.parentTurnId, "parentTurnId");
    const intentId = identifier(input.intentId, "intentId");
    assertNoKnownSensitiveValue(intentId, this.sensitiveValues(), "Steer intentId");
    const expectedSteerVersion = nonNegativeInteger(input.expectedSteerVersion, "expectedSteerVersion");
    const requestedAtMs = nonNegativeInteger(input.requestedAtMs, "requestedAtMs");
    const message = sanitizedText(input.message, "steer.message", 4_096, false, this.sensitiveValues());
    const operation = this.db.transaction(() => {
      const operationNow = this.operationNow(requestedAtMs, "Steer");
      const current = this.requireTask(taskId);
      this.currentAttemptFence(current);
      if (current.agentId !== agentId || current.parentTurnId !== parentTurnId) casRejected("Steer scope does not own this task.");
      if (current.steerIntent?.intentId === intentId) {
        if (current.steerIntent.message !== message) invalid("Steer intent ID was reused with a different payload.");
        return current;
      }
      if (current.steerVersion !== expectedSteerVersion) casRejected("Steer version is stale.");
      if (current.status !== "admitted" && current.status !== "running") invalid("Only an admitted or running task can be steered.");
      this.assertTimestampAtOrAfterCurrentAttempt(current, requestedAtMs, "Steer");
      if (current.lease === null || current.lease.expiresAtMs <= operationNow) casRejected("Steer lost its live lease fence.");
      const steerVersion = current.steerVersion + 1;
      const nextVersion = current.version + 1;
      const intent: AsyncTaskSteerIntent = { intentId, version: steerVersion, requestedAtMs: operationNow, message, consumedAtMs: null };
      const changed = this.db.prepare(`
        UPDATE async_tasks
        SET version = ?, steer_intent_json = ?, steer_version = ?, lease_version = ?
        WHERE task_id = ? AND agent_id = ? AND parent_turn_id = ? AND version = ? AND steer_version = ?
      `).run(nextVersion, JSON.stringify(intent), steerVersion, nextVersion, taskId, agentId, parentTurnId, current.version, expectedSteerVersion);
      if (changed.changes !== 1) casRejected("Steer lost its compare-and-swap fence.");
      const attemptChanged = this.db.prepare(`
        UPDATE async_task_attempts SET version = version + 1, lease_version = ?
        WHERE task_id = ? AND attempt = ? AND status = ?
      `).run(nextVersion, taskId, current.attempt, current.status);
      if (attemptChanged.changes !== 1) casRejected("Steer could not fence the active attempt.");
      this.insertOutbox(taskId, nextVersion, "task_steer", {
        status: current.status,
        attempt: current.attempt,
        summary: message,
        code: null,
        resultRef: null,
      }, operationNow);
      return this.requireTask(taskId);
    });
    return operation.immediate();
  }

  abort(input: AbortAsyncTaskInput): AsyncTaskRecord {
    this.ensureOpen();
    const taskId = identifier(input.taskId, "taskId");
    const agentId = identifier(input.agentId, "agentId");
    const parentTurnId = identifier(input.parentTurnId, "parentTurnId");
    const intentId = identifier(input.intentId, "intentId");
    const expectedAbortVersion = nonNegativeInteger(input.expectedAbortVersion, "expectedAbortVersion");
    const requestedAtMs = nonNegativeInteger(input.requestedAtMs, "requestedAtMs");
    if (!(ABORT_REASONS as readonly string[]).includes(input.reason)) invalid("Abort reason is invalid.");
    const reason = input.reason;
    assertNoKnownSensitiveValue({ intentId, reason }, this.sensitiveValues(), "Abort intent structure");
    const operation = this.db.transaction(() => {
      const operationNow = this.operationNow(requestedAtMs, "Abort");
      const current = this.requireTask(taskId);
      this.currentAttemptFence(current);
      if (current.agentId !== agentId || current.parentTurnId !== parentTurnId) casRejected("Abort scope does not own this task.");
      if (current.abortIntent?.intentId === intentId) {
        if (current.abortIntent.reason !== reason) invalid("Abort intent ID was reused with a different payload.");
        return current;
      }
      if (current.abortVersion !== expectedAbortVersion) casRejected("Abort version is stale.");
      if (requestedAtMs < current.createdAtMs || (current.startedAtMs !== null && requestedAtMs < current.startedAtMs)) {
        invalid("Abort timestamp precedes task creation or start.");
      }
      this.assertTimestampAtOrAfterCurrentAttempt(current, requestedAtMs, "Abort");
      const activeAttempt = current.status === "admitted" || current.status === "running";
      const terminal = current.status === "queued" || current.status === "retry_wait" || current.status === "abandoned";
      if (!activeAttempt && !terminal) invalid("This task status cannot accept a new abort intent.");
      const nextStatus = activeAttempt ? "cancelling" : "cancelled";
      assertTaskTransition(current.status, nextStatus);
      const abortVersion = current.abortVersion + 1;
      const nextVersion = current.version + 1;
      const intent: AsyncTaskAbortIntent = { intentId, version: abortVersion, requestedAtMs: operationNow, reason, consumedAtMs: null };
      const terminalError: AsyncTaskFailure | null = terminal
        ? { code: reason === "budget_exhausted" ? "budget_exhausted" : "aborted", message: `Task aborted: ${reason}.`, retryable: false }
        : null;
      const changed = this.db.prepare(`
        UPDATE async_tasks
        SET status = ?, version = ?, abort_intent_json = ?, abort_version = ?,
            finished_at_ms = ?, next_attempt_at_ms = CASE WHEN ? = 1 THEN NULL ELSE next_attempt_at_ms END,
            error_json = CASE WHEN ? = 1 THEN ? ELSE error_json END,
            lease_owner = CASE WHEN ? = 1 THEN NULL ELSE lease_owner END,
            lease_expires_at_ms = CASE WHEN ? = 1 THEN NULL ELSE lease_expires_at_ms END,
            lease_attempt = CASE WHEN ? = 1 THEN NULL ELSE lease_attempt END,
            lease_version = CASE WHEN ? = 1 THEN NULL ELSE ? END
        WHERE task_id = ? AND agent_id = ? AND parent_turn_id = ? AND status = ? AND version = ? AND abort_version = ?
      `).run(nextStatus, nextVersion, JSON.stringify(intent), abortVersion,
        terminal ? operationNow : null, terminal ? 1 : 0,
        terminal ? 1 : 0, terminalError === null ? null : JSON.stringify(terminalError),
        terminal ? 1 : 0, terminal ? 1 : 0, terminal ? 1 : 0, terminal ? 1 : 0, nextVersion,
        taskId, agentId, parentTurnId, current.status, current.version, expectedAbortVersion);
      if (changed.changes !== 1) casRejected("Abort lost its compare-and-swap fence.");
      if (activeAttempt) {
        const attemptChanged = this.db.prepare(`
          UPDATE async_task_attempts SET status = 'cancelling', version = version + 1, lease_version = ?
          WHERE task_id = ? AND attempt = ? AND status = ?
        `).run(nextVersion, taskId, current.attempt, current.status);
        if (attemptChanged.changes !== 1) casRejected("Abort could not advance the active attempt.");
      }
      this.revokeGrantInTransaction(taskId, operationNow, !activeAttempt);
      this.insertOutbox(taskId, nextVersion, "task_abort", {
        status: nextStatus,
        attempt: current.attempt,
        summary: reason,
        code: terminalError?.code ?? null,
        resultRef: null,
      }, operationNow);
      if (terminal && terminalError !== null) {
        this.insertOutbox(taskId, nextVersion, "task_terminal", {
          status: "cancelled",
          attempt: current.attempt,
          summary: terminalError.message,
          code: terminalError.code,
          resultRef: null,
        }, operationNow);
      }
      const result = this.requireTask(taskId);
      if (terminal) this.settleParentBudgetInTransaction(result, operationNow);
      return result;
    });
    return operation.immediate();
  }

  commitTerminal(input: CommitAsyncTaskTerminalInput): CommitAsyncTaskTerminalResult {
    this.ensureOpen();
    const taskId = identifier(input.taskId, "taskId");
    const expectedVersion = positiveInteger(input.expectedVersion, "expectedVersion");
    const leaseOwnerId = identifier(input.leaseOwnerId, "leaseOwnerId");
    assertNoKnownSensitiveValue(leaseOwnerId, this.sensitiveValues(), "Terminal leaseOwnerId");
    const attemptNumber = positiveInteger(input.attempt, "attempt");
    const finishedAtMs = nonNegativeInteger(input.finishedAtMs, "finishedAtMs");
    if (input.wakeKind !== "task_terminal") invalid("Terminal commit requires task_terminal wake kind.");
    const status = input.status;
    const sensitiveValues = this.sensitiveValues();
    const result = input.result === null ? null : parseResult(input.result, sensitiveValues, true);
    const error = input.error === null ? null : parseFailure(input.error, sensitiveValues);
    const wakePayload = parseWakePayload(input.wakePayload, sensitiveValues);
    if (status === "completed" && (result === null || error !== null)) invalid("Completed tasks require a result and no error.");
    if (status === "failed" && error === null) invalid("Failed tasks require an error.");
    if (status === "cancelled" && (error === null || (error.code !== "aborted" && error.code !== "budget_exhausted" && error.code !== "capability_denied"))) {
      invalid("Cancelled tasks require an aborted, budget_exhausted, or capability_denied error.");
    }
    if (wakePayload.status !== status || wakePayload.attempt !== attemptNumber || wakePayload.code !== (error?.code ?? null)) {
      invalid("Terminal wake payload does not match the terminal record.");
    }
    const resultRef = result?.kind === "ref" ? result.resultRef : null;
    if (wakePayload.resultRef !== resultRef) invalid("Terminal wake result reference is inconsistent.");

    const operation = this.db.transaction((): CommitAsyncTaskTerminalResult => {
      const operationNow = this.operationNow(finishedAtMs, "Terminal commit");
      const current = this.requireTask(taskId);
      if (current.version !== expectedVersion || current.attempt !== attemptNumber || current.lease?.ownerId !== leaseOwnerId
        || current.lease.attempt !== attemptNumber || current.lease.expiresAtMs <= operationNow) {
        casRejected("Terminal commit lost its task version or lease ownership fence.");
      }
      assertTaskTransition(current.status, status);
      if (finishedAtMs < current.createdAtMs || (current.startedAtMs !== null && finishedAtMs < current.startedAtMs)) invalid("Terminal timestamp precedes task execution.");
      this.assertTimestampAtOrAfterCurrentAttempt(current, finishedAtMs, "Terminal commit");
      const budgetState = this.getBudgetState(taskId);
      if (budgetState === null) invalid("Task budget state is missing.");
      let persistedResult = result;
      if (result?.kind === "inline") {
        const effectiveCap = Math.min(MAX_PERSISTED_TEXT_BYTES, budgetState.budget.maxResultBytes);
        if (effectiveCap === 0 && result.bytes > 0) {
          throw new AsyncTaskContractError("budget_exhausted", "A non-empty task result cannot fit a zero-byte result budget.");
        }
        if (effectiveCap > 0) {
          const limited = limitTaskResultUtf8(result.text, effectiveCap);
          persistedResult = {
            kind: "inline",
            text: limited.text,
            bytes: limited.bytes,
            truncated: result.truncated || limited.truncated,
          };
        }
      } else if (result !== null && result.bytes > budgetState.budget.maxResultBytes) {
        throw new AsyncTaskContractError("budget_exhausted", "Task result exceeds maxResultBytes.");
      }
      const nextVersion = expectedVersion + 1;
      const changed = this.db.prepare(`
        UPDATE async_tasks
        SET status = ?, version = ?, finished_at_ms = ?, next_attempt_at_ms = NULL,
            lease_owner = NULL, lease_expires_at_ms = NULL, lease_attempt = NULL, lease_version = NULL,
            result_json = ?, error_json = ?
        WHERE task_id = ? AND status = ? AND version = ? AND attempt = ? AND lease_owner = ?
      `).run(status, nextVersion, operationNow, persistedResult === null ? null : JSON.stringify(persistedResult), error === null ? null : JSON.stringify(error),
        taskId, current.status, expectedVersion, attemptNumber, leaseOwnerId);
      if (changed.changes !== 1) casRejected("Terminal task update lost its compare-and-swap fence.");
      const attemptChanged = this.db.prepare(`
        UPDATE async_task_attempts
        SET status = ?, version = version + 1, finished_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
            lease_version = NULL, error_json = ?
        WHERE task_id = ? AND attempt = ? AND status = ? AND lease_owner = ?
      `).run(status, operationNow, error === null ? null : JSON.stringify(error), taskId, attemptNumber, current.status, leaseOwnerId);
      if (attemptChanged.changes !== 1) casRejected("Terminal attempt update lost its ownership fence.");
      this.revokeGrantInTransaction(taskId, operationNow);
      const outboxEvent = this.insertOutbox(taskId, nextVersion, "task_terminal", wakePayload, operationNow);
      const task = this.requireTask(taskId);
      this.settleParentBudgetInTransaction(task, operationNow);
      const attemptRow = this.db.prepare<unknown[], AttemptRow>("SELECT * FROM async_task_attempts WHERE task_id = ? AND attempt = ?").get(taskId, attemptNumber)
        ?? invalid("Committed task attempt is missing.");
      return { task, attempt: this.attemptFromRow(attemptRow), outboxEvent };
    });
    return operation.immediate();
  }

  getGrant(taskIdValue: string): DelegatedCapabilityGrant | null {
    this.ensureOpen();
    const taskId = identifier(taskIdValue, "taskId");
    const row = this.db.prepare<unknown[], GrantRow>("SELECT grant_id, grant_json, version, revoked_at_ms FROM async_task_grants WHERE task_id = ?").get(taskId);
    if (row === undefined) return null;
    const grant = parseDelegatedCapabilityGrant(parseJson(row.grant_json, "persisted capability grant"));
    assertNoKnownSensitiveValue(grant, this.sensitiveValues(), "Persisted capability grant");
    if (grant.taskId !== taskId || grant.grantId !== row.grant_id || grant.version !== row.version || (grant.revokedAt ?? null) !== row.revoked_at_ms) invalid("Persisted grant columns do not match its canonical payload.");
    if (grant.revokedAt !== undefined && (grant.revokedAt < grant.issuedAt || grant.revokedAt > grant.expiresAt)) invalid("Persisted grant revocation is outside its lifetime.");
    const task = this.getTask(taskId);
    if (task === null || grant.parentAgentId !== task.agentId || grant.parentTurnId !== task.parentTurnId
      || grant.childRunId !== task.lineage.childRunId || grant.depth !== task.depth) invalid("Persisted grant does not match task lineage.");
    return grant;
  }

  revokeGrant(taskIdValue: string, expectedVersionValue: number, revokedAtMsValue = this.now()): DelegatedCapabilityGrant {
    this.ensureOpen();
    const taskId = identifier(taskIdValue, "taskId");
    const expectedVersion = positiveInteger(expectedVersionValue, "expectedVersion");
    const revokedAtMs = nonNegativeInteger(revokedAtMsValue, "revokedAtMs");
    const operation = this.db.transaction(() => {
      const current = this.getGrant(taskId);
      if (current === null) invalid("Task capability grant does not exist.");
      if (current.version !== expectedVersion) casRejected("Capability grant version is stale.");
      if (current.revokedAt !== undefined) casRejected("Capability grant is already revoked.");
      const task = this.requireTask(taskId);
      if (revokedAtMs < Math.max(current.issuedAt, task.createdAtMs) || revokedAtMs > current.expiresAt) invalid("Grant revocation timestamp is outside its task lifetime.");
      const revoked = parseDelegatedCapabilityGrant({ ...current, revokedAt: revokedAtMs, version: expectedVersion + 1 });
      const changed = this.db.prepare(`
        UPDATE async_task_grants SET grant_json = ?, version = ?, revoked_at_ms = ?, updated_at_ms = ?
        WHERE task_id = ? AND version = ? AND revoked_at_ms IS NULL
      `).run(JSON.stringify(revoked), revoked.version, revokedAtMs, revokedAtMs, taskId, expectedVersion);
      if (changed.changes !== 1) casRejected("Grant revocation lost its compare-and-swap fence.");
      this.db.prepare(`
        UPDATE async_tasks
        SET lease_expires_at_ms = MIN(lease_expires_at_ms, ?)
        WHERE task_id = ? AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms > ?
      `).run(revokedAtMs, taskId, revokedAtMs);
      if (task.attempt > 0) {
        this.db.prepare(`
          UPDATE async_task_attempts
          SET lease_expires_at_ms = MIN(lease_expires_at_ms, ?)
          WHERE task_id = ? AND attempt = ? AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms > ?
        `).run(revokedAtMs, taskId, task.attempt, revokedAtMs);
      }
      // A grant that is revoked now cannot remain queued or retryable: no
      // worker may claim it later and discover the denial only after the
      // queue has become permanently non-claimable. Future scheduled
      // revocations retain their queue semantics until their boundary.
      const operationNow = this.now();
      if ((task.status === "queued" || task.status === "retry_wait") && revokedAtMs <= operationNow) {
        const nextVersion = task.version + 1;
        const failure: AsyncTaskFailure = {
          code: "capability_denied",
          message: "Task capability grant was revoked before admission.",
          retryable: false,
        };
        const changedTask = this.db.prepare(`
          UPDATE async_tasks
          SET status = 'cancelled', version = ?, finished_at_ms = ?, next_attempt_at_ms = NULL,
              lease_owner = NULL, lease_expires_at_ms = NULL, lease_attempt = NULL, lease_version = NULL,
              error_json = ?
          WHERE task_id = ? AND status = ? AND version = ?
        `).run(nextVersion, operationNow, JSON.stringify(parseFailure(failure, this.sensitiveValues())), taskId, task.status, task.version);
        if (changedTask.changes !== 1) casRejected("Revoked queued task terminalization lost its compare-and-swap fence.");
        if (task.attempt > 0) {
          this.db.prepare(`
            UPDATE async_task_attempts
            SET status = 'cancelled', version = version + 1, finished_at_ms = ?,
                lease_owner = NULL, lease_expires_at_ms = NULL, lease_version = NULL, error_json = ?
            WHERE task_id = ? AND attempt = ? AND status = ?
          `).run(operationNow, JSON.stringify(failure), taskId, task.attempt, task.status);
        }
        this.insertOutbox(taskId, nextVersion, "task_terminal", {
          status: "cancelled", attempt: task.attempt, summary: failure.message,
          code: failure.code, resultRef: null,
        }, operationNow);
        this.settleParentBudgetInTransaction(this.requireTask(taskId), operationNow);
      }
      return revoked;
    });
    return operation.immediate();
  }

  getBudgetState(taskIdValue: string): AsyncTaskBudgetState | null {
    this.ensureOpen();
    const taskId = identifier(taskIdValue, "taskId");
    const row = this.db.prepare<unknown[], BudgetStateRow>("SELECT budget_json, usage_json, version FROM async_task_budget_usage WHERE task_id = ?").get(taskId);
    if (row === undefined) return null;
    const budgetValue = parseJson(row.budget_json, "persisted task budget");
    const usageValue = parseJson(row.usage_json, "persisted budget usage");
    const budget = canonicalBudget(budgetValue);
    // A zero reservation validates the entire persisted usage object through the public pure contract.
    const validationReservation: BudgetReservation = { reservationId: `validate-${randomUUID()}`, amounts: {
      providerCalls: 0, inputTokens: 0, outputTokens: 0, toolRounds: 0, toolCalls: 0,
      mcpCalls: 0, browserCommands: 0, resultBytes: 0, workspaceWriteBytes: 0,
    } };
    const validatedUsage = reserveBudget(budget, usageValue, validationReservation);
    const usage: SubagentBudgetUsage = {
      used: validatedUsage.used,
      reserved: validatedUsage.reserved,
      reservations: validatedUsage.reservations.filter((entry) => entry.reservationId !== validationReservation.reservationId),
    };
    const state = { budget, usage, version: positiveInteger(row.version, "budget version") };
    assertNoKnownSensitiveValue(state, this.sensitiveValues(), "Persisted budget state");
    return state;
  }

  liquidateAbandonedBudget(taskIdValue: string, atMs = this.now()): AsyncTaskBudgetState | null {
    this.ensureOpen();
    const taskId = identifier(taskIdValue, "taskId");
    const operationNow = this.operationNow(nonNegativeInteger(atMs, "budget recovery timestamp"), "Budget recovery");
    const operation = this.db.transaction(() => {
      const current = this.getBudgetState(taskId);
      if (current === null || current.usage.reservations.length === 0) return current;
      const usage = liquidateBudgetReservations(current.usage);
      const changed = this.db.prepare("UPDATE async_task_budget_usage SET usage_json = ?, version = ?, updated_at_ms = ? WHERE task_id = ? AND version = ?")
        .run(JSON.stringify(usage), current.version + 1, operationNow, taskId, current.version);
      if (changed.changes !== 1) casRejected("Budget recovery lost its compare-and-swap fence.");
      return { budget: current.budget, usage, version: current.version + 1 };
    });
    return operation.immediate();
  }

  reserveTaskBudget(
    taskIdValue: string,
    expectedVersionValue: number,
    reservation: BudgetReservation,
    fenceValue: AsyncTaskBudgetLeaseFence,
    updatedAtMsValue = this.now(),
  ): AsyncTaskBudgetState {
    this.ensureOpen();
    const taskId = identifier(taskIdValue, "taskId");
    const expectedVersion = positiveInteger(expectedVersionValue, "expectedVersion");
    const fence = parseBudgetLeaseFence(fenceValue);
    assertNoKnownSensitiveValue({ reservation, fence }, this.sensitiveValues(), "Budget reservation structure");
    const updatedAtMs = nonNegativeInteger(updatedAtMsValue, "updatedAtMs");
    const operation = this.db.transaction(() => {
      const operationNow = this.operationNow(updatedAtMs, "Budget reservation");
      this.assertBudgetLeaseAuthorityInTransaction(taskId, fence, operationNow);
      const current = this.getBudgetState(taskId);
      if (current === null) invalid("Task budget state does not exist.");
      if (current.version !== expectedVersion) casRejected("Budget version is stale.");
      const usage = reserveBudget(current.budget, current.usage, reservation);
      const nextVersion = expectedVersion + 1;
      const changed = this.db.prepare(`
        UPDATE async_task_budget_usage SET usage_json = ?, version = ?, updated_at_ms = ?
        WHERE task_id = ? AND version = ?
      `).run(JSON.stringify(usage), nextVersion, operationNow, taskId, expectedVersion);
      if (changed.changes !== 1) casRejected("Budget reservation lost its compare-and-swap fence.");
      return { budget: current.budget, usage, version: nextVersion };
    });
    return operation.immediate();
  }

  reconcileTaskBudget(
    taskIdValue: string,
    expectedVersionValue: number,
    reservationIdValue: string,
    actual: SubagentBudgetUsage["used"],
    fenceValue: AsyncTaskBudgetLeaseFence,
    updatedAtMsValue = this.now(),
  ): AsyncTaskBudgetState {
    this.ensureOpen();
    const taskId = identifier(taskIdValue, "taskId");
    const expectedVersion = positiveInteger(expectedVersionValue, "expectedVersion");
    const reservationId = identifier(reservationIdValue, "reservationId");
    const fence = parseBudgetLeaseFence(fenceValue);
    assertNoKnownSensitiveValue({ reservationId, fence }, this.sensitiveValues(), "Budget reconciliation structure");
    const updatedAtMs = nonNegativeInteger(updatedAtMsValue, "updatedAtMs");
    const operation = this.db.transaction(() => {
      const operationNow = this.operationNow(updatedAtMs, "Budget reconciliation");
      this.assertBudgetLeaseAuthorityInTransaction(taskId, fence, operationNow);
      const current = this.getBudgetState(taskId);
      if (current === null) invalid("Task budget state does not exist.");
      if (current.version !== expectedVersion) casRejected("Budget version is stale.");
      const usage = reconcileBudgetReservation(current.usage, reservationId, actual);
      const nextVersion = expectedVersion + 1;
      const changed = this.db.prepare(`
        UPDATE async_task_budget_usage SET usage_json = ?, version = ?, updated_at_ms = ?
        WHERE task_id = ? AND version = ?
      `).run(JSON.stringify(usage), nextVersion, operationNow, taskId, expectedVersion);
      if (changed.changes !== 1) casRejected("Budget reconciliation lost its compare-and-swap fence.");
      return { budget: current.budget, usage, version: nextVersion };
    });
    return operation.immediate();
  }

  listUndeliveredOutbox(limit = 100): AsyncTaskOutboxEvent[] {
    this.ensureOpen();
    const parsedLimit = positiveInteger(limit, "outbox limit");
    return this.db.prepare<unknown[], OutboxRow>(`
      SELECT * FROM async_task_outbox
      WHERE delivered_at_ms IS NULL
      ORDER BY created_at_ms, task_id, transition_version,
        CASE wake_kind WHEN 'task_abort' THEN 0 WHEN 'task_terminal' THEN 1 ELSE 0 END,
        outbox_id
      LIMIT ?
    `).all(parsedLimit).map((row) => this.validateOutboxAgainstTask(this.outboxFromRow(row)));
  }

  /** Materializes the SQLite outbox into ordered, agent-scoped projection envelopes. */
  projectUndelivered(limit = 100): AsyncTaskProjectionEnvelope[] {
    this.ensureOpen();
    const parsedLimit = positiveInteger(limit, "projection limit");
    const operation = this.db.transaction(() => {
      const events = this.db.prepare<unknown[], OutboxRow & { agent_id: string }>(`SELECT o.*, t.agent_id FROM async_task_outbox o JOIN async_tasks t ON t.task_id = o.task_id
        WHERE o.delivered_at_ms IS NULL ORDER BY o.created_at_ms, o.task_id, o.transition_version, o.outbox_id LIMIT ?`).all(parsedLimit);
      const output: AsyncTaskProjectionEnvelope[] = [];
      for (const event of events) {
        const parsed = this.validateOutboxAgainstTask(this.outboxFromRow(event));
        for (const channel of ["async-tasks", "subagents"] as const) {
          const existing = this.db.prepare<unknown[], ProjectionRow>("SELECT * FROM async_task_projection_outbox WHERE source_outbox_id = ? AND channel = ?").get(event.outbox_id, channel);
          if (existing !== undefined) {
            if (existing.delivered_at_ms === null) output.push(this.projectionFromRow(existing));
            continue;
          }
          const state = this.db.prepare<unknown[], ProjectionStateRow>("SELECT epoch, next_sequence FROM async_task_projection_state WHERE agent_id = ? AND channel = ?").get(event.agent_id, channel);
          const epoch = state?.epoch ?? randomUUID();
          const sequence = state?.next_sequence ?? 1;
          this.db.prepare(`INSERT INTO async_task_projection_state(agent_id, channel, epoch, next_sequence) VALUES (?, ?, ?, ?)
            ON CONFLICT(agent_id, channel) DO UPDATE SET epoch = excluded.epoch, next_sequence = excluded.next_sequence`).run(event.agent_id, channel, epoch, sequence + 1);
          const projectionId = randomUUID();
          this.db.prepare(`INSERT INTO async_task_projection_outbox(projection_id, source_outbox_id, agent_id, channel, epoch, sequence, task_id, snapshot_version, kind, payload_json, created_at_ms, delivered_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(projectionId, event.outbox_id, event.agent_id, channel, epoch, sequence, event.task_id, event.transition_version, event.wake_kind, event.payload_json, event.created_at_ms);
          output.push({ projectionId, epoch, sequence, agentId: event.agent_id, taskId: event.task_id, snapshotVersion: event.transition_version, channel, kind: parsed.wakeKind, payload: parsed.payload });
        }
      }
      return output;
    });
    return operation.immediate();
  }

  listUndeliveredProjections(limit = 100): AsyncTaskProjectionEnvelope[] {
    this.ensureOpen();
    const rows = this.db.prepare<unknown[], ProjectionRow>(`SELECT * FROM async_task_projection_outbox WHERE delivered_at_ms IS NULL ORDER BY agent_id, channel, epoch, sequence LIMIT ?`).all(positiveInteger(limit, "projection limit"));
    return rows.map((row) => this.projectionFromRow(row));
  }

  getProjectionSnapshot(agentIdValue: string, channel: "async-tasks" | "subagents", options: { readonly limit?: number } = {}): AsyncTaskProjectionSnapshot | null {
    this.ensureOpen();
    const agentId = identifier(agentIdValue, "agentId");
    if (channel !== "async-tasks" && channel !== "subagents") invalid("Projection channel is invalid.");
    const state = this.db.prepare<unknown[], ProjectionStateRow>("SELECT epoch, next_sequence FROM async_task_projection_state WHERE agent_id = ? AND channel = ?").get(agentId, channel);
    const epoch = state?.epoch ?? randomUUID();
    const sequence = Math.max(0, (state?.next_sequence ?? 1) - 1);
    if (state === undefined) {
      this.db.prepare("INSERT INTO async_task_projection_state(agent_id, channel, epoch, next_sequence) VALUES (?, ?, ?, 1)").run(agentId, channel, epoch);
    }
    const items = this.listTasks(agentId, options);
    const total = options.limit === undefined
      ? items.length
      : (this.db.prepare<unknown[], { count: number }>("SELECT COUNT(*) AS count FROM async_tasks WHERE agent_id = ?").get(agentId)
        ?? invalid("Task count query returned no row.")).count;
    return {
      agentId,
      channel,
      epoch,
      sequence,
      items,
      truncated: total > items.length,
    };
  }

  acknowledgeProjection(projectionIdValue: string, accepted: boolean, deliveredAtMs = this.now()): boolean {
    this.ensureOpen();
    if (!accepted) return false;
    const projectionId = identifier(projectionIdValue, "projectionId");
    const operation = this.db.transaction(() => {
      const deliveredAtMsValidated = nonNegativeInteger(deliveredAtMs, "projection delivery timestamp");
      const projection = this.db.prepare<unknown[], { source_outbox_id: string }>("SELECT source_outbox_id FROM async_task_projection_outbox WHERE projection_id = ? AND delivered_at_ms IS NULL").get(projectionId);
      if (projection === undefined || projection.source_outbox_id === undefined) return false;
      const changed = this.db.prepare("UPDATE async_task_projection_outbox SET delivered_at_ms = ? WHERE projection_id = ? AND delivered_at_ms IS NULL").run(deliveredAtMsValidated, projectionId);
      if (changed.changes !== 1) return false;
      const pending = this.db.prepare<unknown[], { count: number }>("SELECT COUNT(*) AS count FROM async_task_projection_outbox WHERE source_outbox_id = ? AND channel IN ('async-tasks', 'subagents') AND delivered_at_ms IS NULL").get(projection.source_outbox_id)
        ?? invalid("Pending projection count query returned no row.");
      const delivered = this.db.prepare<unknown[], { count: number; channels: number }>("SELECT COUNT(*) AS count, COUNT(DISTINCT channel) AS channels FROM async_task_projection_outbox WHERE source_outbox_id = ? AND channel IN ('async-tasks', 'subagents') AND delivered_at_ms IS NOT NULL").get(projection.source_outbox_id)
        ?? invalid("Delivered projection count query returned no row.");
      // Source delivery is acknowledged only when one delivered row exists
      // for each required channel, never merely because two rows happen to
      // exist.
      if (delivered.count === 2 && delivered.channels === 2 && pending.count === 0) {
        this.db.prepare("UPDATE async_task_outbox SET delivered_at_ms = ? WHERE outbox_id = ? AND delivered_at_ms IS NULL").run(deliveredAtMsValidated, projection.source_outbox_id);
      }
      return true;
    });
    return operation.immediate();
  }

  settleTask(taskIdValue: string, agentIdValue: string, nonceValue: string, atMs = this.now()): AsyncTaskRecord {
    this.ensureOpen();
    const taskId = identifier(taskIdValue, "taskId");
    const agentId = identifier(agentIdValue, "agentId");
    const nonce = requireTaskClientNonce(nonceValue);
    const operationNow = this.operationNow(nonNegativeInteger(atMs, "settlement timestamp"), "Settlement");
    const operation = this.db.transaction(() => {
      const current = this.requireTask(taskId);
      if (current.agentId !== agentId) casRejected("Settlement scope does not own this task.");
      if (current.status !== "completed" && current.status !== "failed" && current.status !== "cancelled") invalid("Only terminal tasks can be settled.");
      const row = this.db.prepare<unknown[], { settled_at_ms: number | null; settlement_nonce: string | null }>("SELECT settled_at_ms, settlement_nonce FROM async_tasks WHERE task_id = ?").get(taskId)
        ?? invalid("Task settlement row is missing.");
      if (row.settled_at_ms !== null) {
        if (row.settlement_nonce !== nonce) invalid("Settlement nonce was reused with a different value.");
        return current;
      }
      const changed = this.db.prepare("UPDATE async_tasks SET settled_at_ms = ?, settlement_nonce = ? WHERE task_id = ? AND settled_at_ms IS NULL").run(operationNow, nonce, taskId);
      if (changed.changes !== 1) casRejected("Settlement lost its compare-and-swap fence.");
      return this.requireTask(taskId);
    });
    return operation.immediate();
  }

  consumeAbortIntent(taskIdValue: string, leaseOwnerIdValue: string, attemptValue: number, atMs = this.now()): AsyncTaskRecord {
    this.ensureOpen();
    const taskId = identifier(taskIdValue, "taskId");
    const owner = identifier(leaseOwnerIdValue, "leaseOwnerId");
    const attempt = positiveInteger(attemptValue, "attempt");
    const now = this.operationNow(nonNegativeInteger(atMs, "abort consumption timestamp"), "Abort consumption");
    const operation = this.db.transaction(() => {
      const current = this.requireTask(taskId);
      if (current.abortIntent === null || current.abortIntent.consumedAtMs !== null) return current;
      if (current.lease?.ownerId !== owner || current.lease.attempt !== attempt || current.lease.expiresAtMs <= now) casRejected("Abort consumption lost its lease fence.");
      const nextVersion = current.version + 1;
      const intent = { ...current.abortIntent, consumedAtMs: now };
      const changed = this.db.prepare(`UPDATE async_tasks SET version = ?, abort_intent_json = ?, lease_version = ?
        WHERE task_id = ? AND version = ? AND lease_owner = ? AND lease_attempt = ? AND lease_expires_at_ms > ?`).run(nextVersion, JSON.stringify(intent), nextVersion, taskId, current.version, owner, attempt, now);
      if (changed.changes !== 1) casRejected("Abort consumption lost its compare-and-swap fence.");
      const attemptChanged = this.db.prepare("UPDATE async_task_attempts SET version = version + 1, lease_version = ? WHERE task_id = ? AND attempt = ? AND lease_owner = ?").run(nextVersion, taskId, attempt, owner);
      if (attemptChanged.changes !== 1) casRejected("Abort consumption could not fence the attempt.");
      return this.requireTask(taskId);
    });
    return operation.immediate();
  }

  consumeSteerIntent(taskIdValue: string, leaseOwnerIdValue: string, attemptValue: number, atMs = this.now()): AsyncTaskRecord {
    this.ensureOpen();
    const taskId = identifier(taskIdValue, "taskId");
    const owner = identifier(leaseOwnerIdValue, "leaseOwnerId");
    const attempt = positiveInteger(attemptValue, "attempt");
    const now = this.operationNow(nonNegativeInteger(atMs, "steer consumption timestamp"), "Steer consumption");
    const operation = this.db.transaction(() => {
      const current = this.requireTask(taskId);
      if (current.steerIntent === null || current.steerIntent.consumedAtMs !== null) return current;
      if (current.lease?.ownerId !== owner || current.lease.attempt !== attempt || current.lease.expiresAtMs <= now) casRejected("Steer consumption lost its lease fence.");
      const nextVersion = current.version + 1;
      const intent = { ...current.steerIntent, consumedAtMs: now };
      const changed = this.db.prepare(`UPDATE async_tasks SET version = ?, steer_intent_json = ?, lease_version = ?
        WHERE task_id = ? AND version = ? AND lease_owner = ? AND lease_attempt = ? AND lease_expires_at_ms > ?`).run(nextVersion, JSON.stringify(intent), nextVersion, taskId, current.version, owner, attempt, now);
      if (changed.changes !== 1) casRejected("Steer consumption lost its compare-and-swap fence.");
      const attemptChanged = this.db.prepare("UPDATE async_task_attempts SET version = version + 1, lease_version = ? WHERE task_id = ? AND attempt = ? AND lease_owner = ?").run(nextVersion, taskId, attempt, owner);
      if (attemptChanged.changes !== 1) casRejected("Steer consumption could not fence the attempt.");
      return this.requireTask(taskId);
    });
    return operation.immediate();
  }

  acknowledgeOutbox(outboxIdValue: string, deliveredAtMsValue = this.now()): AsyncTaskOutboxEvent | null {
    this.ensureOpen();
    const outboxId = identifier(outboxIdValue, "outboxId");
    const deliveredAtMs = nonNegativeInteger(deliveredAtMsValue, "deliveredAtMs");
    return this.db.transaction(() => {
      const existing = this.db.prepare<unknown[], OutboxRow>("SELECT * FROM async_task_outbox WHERE outbox_id = ?").get(outboxId);
      if (existing === undefined) return null;
      this.validateOutboxAgainstTask(this.outboxFromRow(existing));
      if (deliveredAtMs < existing.created_at_ms) invalid("Outbox delivery timestamp precedes event creation.");
      if (existing.delivered_at_ms === null) {
        this.db.prepare("UPDATE async_task_outbox SET delivered_at_ms = ? WHERE outbox_id = ? AND delivered_at_ms IS NULL")
          .run(deliveredAtMs, outboxId);
      }
      const row = this.db.prepare<unknown[], OutboxRow>("SELECT * FROM async_task_outbox WHERE outbox_id = ?").get(outboxId)
        ?? invalid("Acknowledged outbox event is missing.");
      return this.validateOutboxAgainstTask(this.outboxFromRow(row));
    }).immediate();
  }

  recoverExpiredLeases(nowMsValue = this.now(), agentIdValue?: string): AsyncTaskRecord[] {
    this.ensureOpen();
    const nowMs = nonNegativeInteger(nowMsValue, "nowMs");
    const agentId = agentIdValue === undefined ? undefined : identifier(agentIdValue, "agentId");
    const operation = this.db.transaction(() => {
      const operationNow = this.operationNow(nowMs, "Lease recovery");
      const candidates = this.db.prepare<unknown[], TaskRow>(`
        SELECT * FROM async_tasks
        WHERE status IN ('admitted', 'running', 'cancelling')
          AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?
          ${agentId === undefined ? "" : "AND agent_id = ?"}
        ORDER BY lease_expires_at_ms, task_id
      `).all(operationNow, ...(agentId === undefined ? [] : [agentId]));
      const recovered: AsyncTaskRecord[] = [];
      for (const row of candidates) {
        let current: AsyncTaskRecord;
        try {
          current = this.taskFromRow(row);
          this.assertTimestampAtOrAfterCurrentAttempt(current, nowMs, "Lease recovery");
        } catch (error) {
          // A single unreadable row must not abort recovery for every other task.
          if (error instanceof AsyncTaskContractError) continue;
          throw error;
        }
        const from = current.status;
        assertTaskTransition(from, "abandoned");
        const nextVersion = current.version + 1;
        const error: AsyncTaskFailure = { code: "internal_error", message: "Task lease expired.", retryable: true };
        const changed = this.db.prepare(`
          UPDATE async_tasks
          SET status = 'abandoned', version = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
              lease_attempt = NULL, lease_version = NULL, error_json = ?
          WHERE task_id = ? AND status = ? AND version = ? AND lease_expires_at_ms <= ?
        `).run(nextVersion, JSON.stringify(parseFailure(error, this.sensitiveValues())), current.taskId, from, current.version, operationNow);
        if (changed.changes !== 1) continue;
        const attemptChanged = this.db.prepare(`
          UPDATE async_task_attempts
          SET status = 'abandoned', version = version + 1, finished_at_ms = ?, lease_owner = NULL,
              lease_expires_at_ms = NULL, lease_version = NULL, error_json = ?
          WHERE task_id = ? AND attempt = ? AND status = ?
        `).run(operationNow, JSON.stringify(parseFailure(error, this.sensitiveValues())), current.taskId, current.attempt, from);
        if (attemptChanged.changes !== 1) casRejected("Recovery could not abandon the current attempt.");
        this.insertOutbox(current.taskId, nextVersion, "task_recovered", {
          status: "abandoned",
          attempt: current.attempt,
          summary: error.message,
          code: error.code,
          resultRef: null,
        }, operationNow);
        recovered.push(this.requireTask(current.taskId));
      }
      return recovered;
    });
    return operation.immediate();
  }
}
