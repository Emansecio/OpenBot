import { createHash } from "node:crypto";
import type { LocalExecutionBroker, LocalToolPermission } from "./broker.js";
import type { ExecutionRequest, ExecutionResult } from "./contracts.js";
import { makeToolCallEntry, stableToolCallId, toolCallLocalId, toolCallResult, toolCallSummary, type ToolCallEntry } from "./tool-card.js";
import { toolCallToExecutionRequest } from "./tool-request.js";
import { BROWSER_CAPTURE_TEXT_PREFIX, buildToolTurnMessages, type ToolResultInput } from "../providers/tool-calls.js";
import { ProviderError, type ProviderAssistantMessage, type ProviderChatMessage, type ProviderChatRequest, type ProviderStreamEvent, type ProviderToolCall, type StreamChatResult } from "../providers/router.js";
import { MAX_LIVE_RESPONSE_BYTES, MAX_TRANSCRIPT_DELTA_BYTES } from "../rpc/stream-state.js";
import type { ToolCallResult } from "../shared/contracts.js";
import { resumeFingerprintHash, stableResumeEffectId, type ResumeEffectRecord } from "../providers/resume.js";

/**
 * Safety defaults for requests that do not carry a resolved model capability.
 * These are deliberately generous enough for normal multi-step work; the
 * provider/model-aware budget below raises them further when the model allows.
 */
export const MAX_TOOL_ROUNDS = 16;
export const MAX_TOOL_CALLS_PER_ROUND = 32;
/** Hard safety cap for the number of tool rounds admitted in one turn. */
export const MAX_TOOL_TOTAL_ROUNDS = 128;
/** Hard safety cap for actual tool executions admitted in one turn. */
export const MAX_TOOL_TOTAL_CALLS = 128;
/** Wall-clock guard for a single tool turn (checked before admitting work). */
export const MAX_TOOL_LOOP_WALL_TIME_MS = 30 * 60 * 1_000;
/** Keep tool payloads bounded independently of provider request size. */
export const MAX_TOOL_RESULT_BYTES_PER_ROUND = 128 * 1024;
export const TOOL_RESULT_TRUNCATION_MARKER = "\n[output truncated by OpenBot]";

export interface ToolLoopBudget {
  maxRounds: number;
  maxCallsPerRound: number;
  maxResultBytes: number;
  /** Hard round ceiling used when default soft-window extension is enabled. */
  maxTotalRounds: number;
  /** Hard aggregate execution ceiling (aliases/cache hits do not consume it). */
  maxTotalCalls: number;
}

export interface ToolLoopBudgetOverrides {
  maxRounds?: number;
  maxCallsPerRound?: number;
  maxResultBytes?: number;
}

const MAX_ADAPTIVE_TOOL_CALLS_PER_ROUND = 64;

function positiveBound(value: number, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

/**
 * Derives a tool-loop budget from the resolved model instead of imposing one
 * small ceiling on every provider. Unknown models retain a bounded default.
 */
export function resolveToolLoopBudget(
  request: Pick<ProviderChatRequest, "modelResolution">,
  overrides: ToolLoopBudgetOverrides = {},
): ToolLoopBudget {
  const contextWindow = request.modelResolution?.entry.contextWindow;
  const baselineRounds = contextWindow === undefined
    ? MAX_TOOL_ROUNDS
    : contextWindow >= 400_000 ? 32 : contextWindow >= 128_000 ? 24 : MAX_TOOL_ROUNDS;
  const baselineCalls = contextWindow !== undefined && contextWindow >= 400_000
    ? MAX_ADAPTIVE_TOOL_CALLS_PER_ROUND
    : MAX_TOOL_CALLS_PER_ROUND;
  const hasExplicitRoundLimit = Number.isSafeInteger(overrides.maxRounds) && overrides.maxRounds! > 0;
  const maxRounds = positiveBound(overrides.maxRounds ?? baselineRounds, baselineRounds, MAX_TOOL_TOTAL_ROUNDS);
  return {
    maxRounds,
    maxCallsPerRound: positiveBound(overrides.maxCallsPerRound ?? baselineCalls, baselineCalls, MAX_ADAPTIVE_TOOL_CALLS_PER_ROUND),
    // Tool payloads stay on the shared byte budget even when a provider accepts larger requests.
    maxResultBytes: positiveBound(overrides.maxResultBytes ?? MAX_TOOL_RESULT_BYTES_PER_ROUND, MAX_TOOL_RESULT_BYTES_PER_ROUND, MAX_TOOL_RESULT_BYTES_PER_ROUND),
    // An explicit round override is intentionally strict; default windows may
    // extend only while successful observations demonstrate progress.
    maxTotalRounds: hasExplicitRoundLimit ? maxRounds : MAX_TOOL_TOTAL_ROUNDS,
    maxTotalCalls: MAX_TOOL_TOTAL_CALLS,
  };
}
export const STALE_TOOL_RESULT_PREVIEW_BYTES = 256;
/** Stale tool output at or below this size stays verbatim: it is cheap to resend and needed to compare observations across rounds. */
export const STALE_TOOL_RESULT_KEEP_BYTES = 1_024;
/** Masking only activates once accumulated stale tool output is large enough to matter against a request budget. */
export const STALE_TOOL_RESULT_MASK_MIN_BYTES = 16 * 1024;
const READ_ONLY_TOOL_NAMES = new Set([
  "workspace_info",
  "search_files",
  "search_text",
  "browser_snapshot",
  "browser_screenshot",
  "memory_search",
  "search_skills",
  "search_mcp_tools",
]);
const FILE_READ_OPS = new Set(["list", "stat", "read"]);
export interface ToolProgress {
  entry: ToolCallEntry;
}
export interface ToolLoopOptions {
  agentId: string;
  conversationId?: string;
  request: ProviderChatRequest;
  broker?: LocalExecutionBroker;
  resolveHostPermission?: (agentId: string, request: ExecutionRequest) => LocalToolPermission | undefined;
  /** Executor de extensões compartilhadas (Skills/MCP). `handled:false` mantém o fallback local fechado. */
  executeTool?: ToolCallExecutor;
  stream: (
    request: ProviderChatRequest,
    onEvent: (event: ProviderStreamEvent) => void,
    metadata?: { finalization?: boolean },
  ) => Promise<StreamChatResult>;
  /** Rebuilds the bounded request after tool calls/results are appended. */
  prepareRequest?: (
    messages: readonly ProviderChatMessage[],
    requestOverride?: ProviderChatRequest,
  ) => ProviderChatRequest;
  onEvent: (event: ProviderStreamEvent) => void;
  /**
   * Atividade real do provedor observada antes da retenção do texto da rodada.
   * Serve apenas ao estado ao vivo: não publica texto nem altera o transcript.
   */
  onProviderActivity?: (kind: "response" | "reasoning") => void;
  /** Hold round text until calls are known; discard it when one of these tools runs. */
  deferTextUntilToolResultFor?: readonly string[];
  onProgress?: (progress: ToolProgress) => void;
  /** Durable P2.6 effect ledger; omitted for non-resumable turns. */
  resumableEffects?: ToolLoopResumableEffects;
  turnId?: string;
  contextOverflowRetry?: {
    isOverflow(error: unknown): boolean;
    messages(): ProviderChatMessage[];
  };
  /** Optional explicit override for the provider/model-derived tool budget. */
  toolLoopBudget?: ToolLoopBudgetOverrides;
}

export interface ToolLoopResumableEffects {
  prepare(effectId: string, fingerprintHash: string): ResumeEffectRecord;
  markStarted(effectId: string): ResumeEffectRecord | undefined;
  markUnsafe?(effectId: string): ResumeEffectRecord | undefined;
  complete(effectId: string, fingerprintHash: string, result: unknown): ResumeEffectRecord;
}

export interface ToolExecutionContext {
  agentId: string;
  call: ProviderToolCall;
  signal?: AbortSignal;
}

export type ToolExecutionResult =
  | { handled: false }
  | { handled: true; ok: boolean; content: string; error?: string; result?: ToolCallResult };

export interface ToolCallExecutor {
  (context: ToolExecutionContext): Promise<ToolExecutionResult>;
  /** Permite publicar `running` antes da execução compartilhada começar. */
  canHandle?: (toolName: string) => boolean;
}

interface ToolOutcome {
  ok: boolean;
  content: string;
  error?: string;
  result: ToolCallResult;
  visual?: { mimeType: "image/png"; dataBase64: string; width: number; height: number };
}

function persistedOutcome(value: unknown): value is ToolOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.ok === "boolean"
    && typeof record.content === "string"
    && typeof record.result === "object"
    && record.result !== null;
}

type BrowserVisual = { mimeType: "image/png"; dataBase64: string; width: number; height: number };

function browserVisual(result: ExecutionResult): BrowserVisual | undefined {
  if (!result.ok) return undefined;
  if (result.operation === "browser.snapshot") return result.snapshot?.screenshot;
  if (result.operation === "browser.screenshot") return result.screenshot;
  return undefined;
}

function resultText(result: ExecutionResult, visualAvailable: boolean): string {
  if (!result.ok || (result.operation !== "browser.snapshot" && result.operation !== "browser.screenshot")) {
    return JSON.stringify(result);
  }
  if (result.operation === "browser.snapshot") {
    if (result.snapshot?.screenshot === undefined) return JSON.stringify(result);
    const image = result.snapshot.screenshot;
    return JSON.stringify({
      ...result,
      visualAvailable,
      snapshot: {
        ...result.snapshot,
        screenshot: { mimeType: image.mimeType, width: image.width, height: image.height },
      },
    });
  }
  if (result.screenshot === undefined) return JSON.stringify(result);
  const image = result.screenshot;
  return JSON.stringify({
    ...result,
    visualAvailable,
    screenshot: { mimeType: image.mimeType, width: image.width, height: image.height },
  });
}
function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let usedBytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > maxBytes) break;
    usedBytes += characterBytes;
    end += character.length;
  }
  return value.slice(0, end);
}

export function isReadOnlyToolCall(call: ProviderToolCall): boolean {
  if (READ_ONLY_TOOL_NAMES.has(call.function.name)) return true;
  if (call.function.name !== "file") return false;
  try {
    const args: unknown = JSON.parse(call.function.arguments);
    if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
    return FILE_READ_OPS.has(String((args as { op?: unknown }).op ?? ""));
  } catch {
    return false;
  }
}

function isVisualCaptureMessage(message: ProviderChatMessage): boolean {
  if (message.role !== "user" || !Array.isArray(message.content)) return false;
  // Only messages produced by buildToolTurnMessages carry the capture marker;
  // user-attached images share the image_url shape but are durable content.
  return message.content.some(
    (part) => part.type === "text" && typeof part.text === "string" && part.text.startsWith(BROWSER_CAPTURE_TEXT_PREFIX),
  );
}

export function maskStaleToolResultContent(name: string | undefined, content: string, toolCallId?: string): string {
  const originalBytes = Buffer.byteLength(content, "utf8");
  return JSON.stringify({
    openbotOmitted: true,
    ...(name === undefined ? {} : { name }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    originalBytes,
    preview: utf8Prefix(content, STALE_TOOL_RESULT_PREVIEW_BYTES),
    hint: "partial read-only output; repeat the same read-only tool call to retrieve the complete result",
  });
}

/**
 * Keep the latest tool round intact; compact only older read-only output.
 * Mutating/unknown results remain verbatim because replaying them could apply
 * the same side effect twice.
 */
export function maskStaleToolResults(
  messages: readonly ProviderChatMessage[],
  keepLastRounds = 1,
): ProviderChatMessage[] {
  if (!Number.isSafeInteger(keepLastRounds) || keepLastRounds < 1) {
    throw new Error("keepLastRounds must be a positive integer");
  }
  const roundStarts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) roundStarts.push(index);
  }
  if (roundStarts.length <= keepLastRounds) return [...messages];
  const keepFrom = roundStarts[roundStarts.length - keepLastRounds]!;
  let staleToolBytes = 0;
  let staleVisualCapture = false;
  for (let index = 0; index < keepFrom; index += 1) {
    const message = messages[index];
    if (message?.role === "tool") staleToolBytes += Buffer.byteLength(message.content, "utf8");
    else if (message !== undefined && isVisualCaptureMessage(message)) staleVisualCapture = true;
  }
  // No reduction without real pressure; browser captures are always reduced.
  if (!staleVisualCapture && staleToolBytes <= STALE_TOOL_RESULT_MASK_MIN_BYTES) return [...messages];
  // Resolve each tool result against the immediately preceding assistant
  // message. Provider call IDs may repeat across rounds, so a global id map
  // could misclassify an older write as a later read and hide its effect.
  const metadataByToolMessage = new Map<number, { name: string; readOnly: boolean }>();
  let activeCalls = new Map<string, { name: string; readOnly: boolean }>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      activeCalls = new Map(
        (message.toolCalls ?? []).map((call) => [call.id, { name: call.function.name, readOnly: isReadOnlyToolCall(call) }]),
      );
    } else if (message?.role === "tool" && message.toolCallId !== undefined) {
      const metadata = activeCalls.get(message.toolCallId);
      if (metadata !== undefined) metadataByToolMessage.set(index, metadata);
    }
  }
  return messages.map((message, index) => {
    if (index >= keepFrom) return message;
    if (message.role === "tool") {
      if (Buffer.byteLength(message.content, "utf8") <= STALE_TOOL_RESULT_KEEP_BYTES) return message;
      const metadata = metadataByToolMessage.get(index);
      if (metadata?.readOnly !== true) return message;
      return { ...message, content: maskStaleToolResultContent(metadata.name, message.content, message.toolCallId) };
    }
    if (isVisualCaptureMessage(message)) {
      return { role: "user", content: "Untrusted browser capture omitted after it was already used in this turn." };
    }
    return message;
  });
}

export function truncateToolResult(value: string, maxBytes: number = MAX_TOOL_RESULT_BYTES_PER_ROUND): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  try {
    JSON.parse(value);
    const originalBytes = Buffer.byteLength(value, "utf8");
    const base = { openbotTruncated: true, originalBytes };
    const baseJson = JSON.stringify(base);
    if (Buffer.byteLength(baseJson, "utf8") > maxBytes) return maxBytes >= 4 ? "null" : "";
    let preview = utf8Prefix(value, Math.max(0, maxBytes - Buffer.byteLength(baseJson, "utf8") - 64));
    let encoded = JSON.stringify({ ...base, preview, previewFormat: "json-prefix" });
    while (preview.length > 0 && Buffer.byteLength(encoded, "utf8") > maxBytes) {
      preview = preview.slice(0, Math.floor(preview.length / 2));
      encoded = JSON.stringify({ ...base, preview, previewFormat: "json-prefix" });
    }
    return Buffer.byteLength(encoded, "utf8") <= maxBytes ? encoded : baseJson;
  } catch {
    // Plain-text tool output remains readable when it is not JSON.
  }
  const markerBytes = Buffer.byteLength(TOOL_RESULT_TRUNCATION_MARKER, "utf8");
  if (maxBytes <= markerBytes) return utf8Prefix(TOOL_RESULT_TRUNCATION_MARKER, maxBytes);
  return `${utf8Prefix(value, maxBytes - markerBytes)}${TOOL_RESULT_TRUNCATION_MARKER}`;
}

const abortedResult = (): StreamChatResult => ({
  aborted: true,
  error: new ProviderError("tool loop aborted", { kind: "aborted" }),
});
const localId = (turnId: string | undefined, toolCallId: string): string | undefined =>
  turnId === undefined ? undefined : toolCallLocalId(turnId, toolCallId);
const normalizeToolCall = (call: ProviderToolCall): ProviderToolCall =>
  call.id.length > 0 ? call : { ...call, id: stableToolCallId(call.id, call.function.name, call.function.arguments) };

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const semanticFingerprint = (call: ProviderToolCall): string => {
  const execution = toolCallToExecutionRequest(call).request;
  if (execution !== undefined) return `execution\0${canonicalJson(execution)}`;
  let args = call.function.arguments.trim();
  try {
    args = canonicalJson(JSON.parse(args) as unknown);
  } catch {
    // Invalid JSON is still fingerprinted by its exact trimmed representation.
  }
  return `${call.function.name}\0${args}`;
};

/**
 * Canonicalizes successful tool output for progress accounting. Status and
 * record IDs are intentionally retained: for polling tools they are often the
 * observation that changed. Only JSON key order and plain-text whitespace are
 * normalized, so semantically equal payloads do not renew a window by chance.
 */
const normalizedOutcomeContent = (content: string): string => {
  const trimmed = content.trim();
  if (trimmed.length === 0) return "";
  try {
    return canonicalJson(JSON.parse(trimmed) as unknown);
  } catch {
    return trimmed.replace(/\s+/gu, " ");
  }
};

const outcomeContentHash = (content: string): string =>
  createHash("sha256").update(normalizedOutcomeContent(content), "utf8").digest("hex");

const validToolExecutionResult = (value: unknown): value is ToolExecutionResult => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { handled?: unknown; ok?: unknown; content?: unknown };
  if (candidate.handled === false) return true;
  return candidate.handled === true && typeof candidate.ok === "boolean" && typeof candidate.content === "string";
};

const repeatedOutcome = (): ToolOutcome => {
  const message = "repeated tool call blocked; use the previous result and provide the final answer";
  return {
    ok: false,
    content: message,
    error: message,
    result: { ok: false, code: "invalid_request", message },
  };
};

const blockedExecutionOutcome = (message: string): ToolOutcome => ({
  ok: false,
  content: message,
  error: message,
  result: { ok: false, code: "invalid_request", message },
});

const TOOL_LOOP_FINALIZATION_INSTRUCTION =
  "O limite seguro de chamadas de ferramentas deste turno foi atingido. Não chame nenhuma ferramenta. " +
  "Responda agora com honestidade, separando o que foi concluído do que ficou pendente.";

const MAX_PARTIAL_REPORT_TOOL_NAMES = 8;
const MAX_PARTIAL_REPORT_TOOL_NAME_CHARS = 64;

function boundedToolName(name: string): string {
  const normalized = name.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return "tool desconhecida";
  return [...normalized].slice(0, MAX_PARTIAL_REPORT_TOOL_NAME_CHARS).join("");
}

function distinctToolNames(
  results: readonly ToolResultInput[],
  ok: boolean,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (result.ok !== ok) continue;
    const name = boundedToolName(result.name);
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= MAX_PARTIAL_REPORT_TOOL_NAMES) break;
  }
  return names;
}

function deterministicPartialFinalResult(
  results: readonly ToolResultInput[],
  pendingCalls: readonly ProviderToolCall[] = [],
): StreamChatResult {
  const completed = distinctToolNames(results, true);
  const failed = distinctToolNames(results, false);
  const pending = [...new Set(pendingCalls.map((call) => boundedToolName(call.function.name)))].slice(0, MAX_PARTIAL_REPORT_TOOL_NAMES);
  const lines = [
    "Não foi possível concluir esta solicitação com segurança.",
    "A resposta é parcial; nenhuma nova ferramenta será executada neste turno.",
  ];
  if (completed.length > 0) lines.push(`Ferramentas concluídas: ${completed.join(", ")}.`);
  if (failed.length > 0) lines.push(`Ferramentas com falha ou bloqueadas: ${failed.join(", ")}.`);
  if (pending.length > 0) lines.push(`Ferramentas pendentes: ${pending.join(", ")}.`);
  if (completed.length === 0 && failed.length === 0 && pending.length === 0) {
    lines.push("Nenhuma ferramenta teve resultado confirmável; a solicitação permanece pendente.");
  }
  return { aborted: false, message: { role: "assistant", content: lines.join("\n") } };
}

function withFinalizationInstruction(system: string | undefined): string {
  const base = typeof system === "string" ? system.trim() : "";
  if (base.includes(TOOL_LOOP_FINALIZATION_INSTRUCTION)) return base;
  return base.length === 0
    ? TOOL_LOOP_FINALIZATION_INSTRUCTION
    : `${base}\n\n${TOOL_LOOP_FINALIZATION_INSTRUCTION}`;
}

function emitFinalizationResult(options: ToolLoopOptions, result: StreamChatResult): StreamChatResult {
  if (result.aborted || options.request.signal?.aborted || result.message === undefined) return result;
  if (result.cursor !== undefined) options.onEvent({ type: "resume-cursor", cursor: result.cursor });
  options.onEvent({ type: "message", message: result.message });
  options.onEvent({ type: "done" });
  return result;
}

/**
 * Gives the provider one bounded, tool-free chance to turn completed work into
 * an answer. This is not another tool round: tools are removed before the
 * request is prepared, tool-call events are ignored, and only a non-empty final
 * message is accepted. If preparation or the rescue stream cannot complete,
 * return a bounded deterministic partial report instead of a generic limit.
 */
async function tryFinalizeToolLoop(
  options: ToolLoopOptions,
  messages: readonly ProviderChatMessage[],
  results: readonly ToolResultInput[],
  pendingCalls: readonly ProviderToolCall[] = [],
): Promise<StreamChatResult> {
  const fallback = (): StreamChatResult => {
    if (options.request.signal?.aborted) return abortedResult();
    return emitFinalizationResult(options, deterministicPartialFinalResult(results, pendingCalls));
  };
  if (options.request.signal?.aborted) return abortedResult();
  const finalizationMessages = maskStaleToolResults(messages);
  const requestOverride: ProviderChatRequest = {
    ...options.request,
    messages: finalizationMessages,
    tools: [],
    system: withFinalizationInstruction(options.request.system),
  };
  let prepared: ProviderChatRequest;
  try {
    // The override is supplied before context budgeting so the preparer can
    // account for the removed tool schemas and the finalization instruction.
    prepared = options.prepareRequest?.(finalizationMessages, requestOverride) ?? requestOverride;
  } catch {
    return fallback();
  }
  if (options.request.signal?.aborted) return abortedResult();
  const request: ProviderChatRequest = {
    ...prepared,
    tools: [],
    system: withFinalizationInstruction(prepared.system),
  };
  try {
    // Do not replay partial deltas or terminal errors from the rescue attempt:
    // only a complete tool-free text response is accepted as the final answer.
    const result = await options.stream(request, () => {}, { finalization: true });
    if (result.aborted || options.request.signal?.aborted) return abortedResult();
    if (
      result.error === undefined
      && result.message !== undefined
      && (result.message.toolCalls?.length ?? 0) === 0
      && result.message.content.trim().length > 0
    ) {
      return emitFinalizationResult(options, {
        aborted: false,
        message: result.message,
        ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
      });
    }
  } catch {
    // Context preparation and provider failures must not turn a controlled
    // limit into an unexpected thrown error.
  }
  return fallback();
}

export async function runToolLoop(options: ToolLoopOptions): Promise<StreamChatResult> {
  const messages: ProviderChatMessage[] = [...options.request.messages];
  const budget = resolveToolLoopBudget(options.request, options.toolLoopBudget);
  const initialMessageCount = messages.length;
  const turnStartedAt = Date.now();
  let previousRoundFingerprints = new Set<string>();
  const warnedFingerprints = new Set<string>();
  /** Read-only fingerprints whose cached outcomes remain valid only while no mutation runs. */
  const observationFingerprints = new Set<string>();
  /** Per-turn count of actual executions per fingerprint — distinguishes resumable occurrences. */
  const executionCounts = new Map<string, number>();
  /** Bounded-by-round tool outcomes retained for a deterministic final report. */
  const turnToolResults: ToolResultInput[] = [];
  /** Successful output hashes already observed; identical output never renews a window. */
  const successfulOutcomeHashes = new Set<string>();
  /** Consecutive successful read observations by semantic call fingerprint. */
  const readObservationStreaks = new Map<string, { hash: string; count: number }>();
  let activeRoundLimit = budget.maxRounds;
  let progressSinceWindowStart = false;
  let actualToolExecutions = 0;
  let contextOverflowRetried = false;

  const wallClockExpired = (): boolean => Date.now() - turnStartedAt >= MAX_TOOL_LOOP_WALL_TIME_MS;
  const admitToolExecution = (): "aborted" | "limit" | true => {
    if (options.request.signal?.aborted) return "aborted";
    if (actualToolExecutions >= budget.maxTotalCalls || wallClockExpired()) return "limit";
    actualToolExecutions += 1;
    return true;
  };
  const finalizeBlockedCalls = async (
    assistant: ProviderAssistantMessage,
    calls: readonly ProviderToolCall[],
    reason: string,
    cardReason = reason,
  ): Promise<StreamChatResult> => {
    const results: ToolResultInput[] = [];
    for (const call of calls) {
      const id = stableToolCallId(call.id, call.function.name, call.function.arguments);
      options.onProgress?.({
        entry: makeToolCallEntry(id, call.function.name, toolCallSummary(call.function.name, call.function.arguments), "failed", {
          ok: false,
          code: "invalid_request",
          message: cardReason,
        }, localId(options.turnId, id)),
      });
      results.push({ toolCallId: id, name: call.function.name, content: reason, ok: false, error: reason });
    }
    turnToolResults.push(...results);
    messages.push(...buildToolTurnMessages({ ...assistant, toolCalls: [...calls] }, results));
    return tryFinalizeToolLoop(options, messages, turnToolResults);
  };

  for (let round = 0; round <= activeRoundLimit; round += 1) {
    if (options.request.signal?.aborted) return abortedResult();
    if (wallClockExpired()) return tryFinalizeToolLoop(options, messages, turnToolResults);
    let observedText = false;
    const deferredErrors: ProviderStreamEvent[] = [];
    // Text is held until the provider result tells us whether this round is a
    // tool round. Keep a bounded coalesced buffer instead of retaining one
    // array item per provider delta (a provider may emit thousands of tiny
    // fragments before its terminal message).
    const stagedDeltaChunks: string[] = [];
    let stagedDeltaBytes = 0;
    let stagedMessage: Extract<ProviderStreamEvent, { type: "message" }> | undefined;
    let stagedTextLimited = false;
    let stagedDone = false;
    let observedToolCallEvent = false;
    const responseLimitError = (): ProviderError =>
      new ProviderError("response size limit reached", { kind: "aborted", code: "response_limit" });
    const isResponseLimitError = (error: unknown): error is ProviderError =>
      error instanceof ProviderError && error.code === "response_limit";
    const appendStagedDelta = (delta: string): void => {
      const availableBytes = MAX_LIVE_RESPONSE_BYTES - stagedDeltaBytes;
      if (availableBytes <= 0) {
        if (delta.length > 0) stagedTextLimited = true;
        return;
      }
      const accepted = utf8Prefix(delta, availableBytes);
      if (accepted.length !== delta.length) stagedTextLimited = true;
      let offset = 0;
      while (offset < accepted.length) {
        const lastIndex = stagedDeltaChunks.length - 1;
        const last = lastIndex >= 0 ? stagedDeltaChunks[lastIndex] : undefined;
        const room = MAX_TRANSCRIPT_DELTA_BYTES - Buffer.byteLength(last ?? "", "utf8");
        if (room <= 0) {
          stagedDeltaChunks.push("");
          continue;
        }
        const piece = utf8Prefix(accepted.slice(offset), room);
        // A multi-byte code point may not fit in the remaining room even when
        // the room is positive; start the next bounded fragment in that case.
        if (piece.length === 0) {
          stagedDeltaChunks.push("");
          continue;
        }
        if (last === undefined) stagedDeltaChunks.push(piece);
        else stagedDeltaChunks[lastIndex] = `${last}${piece}`;
        offset += piece.length;
      }
      stagedDeltaBytes += Buffer.byteLength(accepted, "utf8");
    };
    const receiveEvent = (event: ProviderStreamEvent): void => {
      if (event.type === "delta") observedText = true;
      // Sinais de atividade real do provedor, reportados ANTES da retenção do
      // texto: o estado ao vivo precisa refletir que o provedor está
      // respondendo mesmo quando o texto da rodada ainda está retido.
      if (event.type === "delta" || event.type === "message" || event.type === "tool-call") {
        try { options.onProviderActivity?.("response"); } catch { /* status observation cannot change inference */ }
      }
      else if (event.type === "reasoning-start" || event.type === "reasoning-progress") {
        try { options.onProviderActivity?.("reasoning"); } catch { /* status observation cannot change inference */ }
      }
      if (event.type === "error") {
        deferredErrors.push(event);
        return;
      }
      if (event.type === "delta") {
        appendStagedDelta(event.delta);
        if (stagedTextLimited) throw responseLimitError();
        return;
      }
      if (event.type === "message") {
        if ((event.message.toolCalls?.length ?? 0) > 0) observedToolCallEvent = true;
        const content = utf8Prefix(event.message.content, MAX_LIVE_RESPONSE_BYTES);
        if (content.length !== event.message.content.length) stagedTextLimited = true;
        stagedMessage = { type: "message", message: { ...event.message, content } };
        if (stagedTextLimited) throw responseLimitError();
        return;
      }
      if (event.type === "done") {
        // `done` is terminal and must follow the final message. Hold it next
        // to the text so a tool round cannot close the consumer before the
        // loop has identified and processed the tool calls.
        stagedDone = true;
        return;
      }
      if (event.type === "tool-call") observedToolCallEvent = true;
      // Lifecycle, tool-card, cursor, and completion events remain observable
      // while text narration waits to see whether this round has tool calls.
      options.onEvent(event);
    };
    const flushRoundEvents = (
      suppressText: boolean,
      emitDone: boolean,
      terminalError?: ProviderError,
    ): ProviderError | undefined => {
      if (!suppressText) {
        const delta = stagedDeltaChunks.join("");
        if (delta.length > 0) options.onEvent({ type: "delta", delta });
        // A response-limit terminal never publishes a possibly truncated
        // `message`; only the accepted delta prefix is retained.
        if (terminalError === undefined && !stagedTextLimited && stagedMessage !== undefined) options.onEvent(stagedMessage);
      }
      for (const event of deferredErrors) options.onEvent(event);
      if (terminalError !== undefined) {
        options.onEvent({ type: "error", error: terminalError });
        return terminalError;
      }
      if (emitDone && stagedDone && deferredErrors.length === 0) options.onEvent({ type: "done" });
      return undefined;
    };
    const responseLimitResult = (error: ProviderError): StreamChatResult => {
      // The router may have stopped forwarding events after the observer threw
      // this known limit. Drop any duplicate adapter error and publish exactly
      // one terminal error after the bounded prefix (or no text for a tool round).
      deferredErrors.length = 0;
      flushRoundEvents(observedToolCallEvent, false, error);
      return { aborted: false, error };
    };
    const prepare = (nextMessages: readonly ProviderChatMessage[]): ProviderChatRequest => {
      const masked = maskStaleToolResults(nextMessages);
      return options.prepareRequest?.(masked) ?? { ...options.request, messages: masked };
    };
    let preparedRequest: ProviderChatRequest;
    try {
      preparedRequest = prepare(messages);
    } catch (error) {
      // Once a tool has completed, a context-preparation failure should still
      // receive the same bounded tool-free finalization as an exhausted loop.
      // Before any work exists, preserve the original preparation error.
      if (turnToolResults.length > 0) return tryFinalizeToolLoop(options, messages, turnToolResults);
      throw error;
    }
    let result: StreamChatResult;
    try {
      result = await options.stream(preparedRequest, receiveEvent);
    } catch (error) {
      if (!isResponseLimitError(error)) throw error;
      return responseLimitResult(error);
    }
    if (
      result.error && !result.aborted && (!observedText || observedToolCallEvent) && !contextOverflowRetried &&
      options.contextOverflowRetry?.isOverflow(result.error)
    ) {
      contextOverflowRetried = true;
      const suffix = messages.slice(initialMessageCount);
      messages.splice(0, messages.length, ...options.contextOverflowRetry.messages(), ...suffix);
      observedText = false;
      deferredErrors.length = 0;
      stagedDeltaChunks.length = 0;
      stagedDeltaBytes = 0;
      stagedMessage = undefined;
      stagedTextLimited = false;
      stagedDone = false;
      observedToolCallEvent = false;
      try {
        preparedRequest = prepare(messages);
      } catch (error) {
        if (turnToolResults.length > 0) return tryFinalizeToolLoop(options, messages, turnToolResults);
        throw error;
      }
      try {
        result = await options.stream(preparedRequest, receiveEvent);
      } catch (error) {
        if (!isResponseLimitError(error)) throw error;
        return responseLimitResult(error);
      }
    }
    if (result.error || result.aborted || !result.message) {
      if (result.error !== undefined && isResponseLimitError(result.error)) return responseLimitResult(result.error);
      flushRoundEvents(observedToolCallEvent, false);
      return result;
    }
    const rawCalls = result.message.toolCalls?.map(normalizeToolCall) ?? [];
    if (stagedTextLimited) return responseLimitResult(responseLimitError());
    flushRoundEvents(rawCalls.length > 0 || observedToolCallEvent, true);
    if (rawCalls.length === 0) return result;
    if (rawCalls.length > budget.maxCallsPerRound) {
      const limitMessage = "Tool call batch limit reached before these calls could run.";
      const limitResults: ToolResultInput[] = [];
      // Close every pending card before attempting the bounded rescue. The
      // calls are deliberately not executed: the provider exceeded the
      // per-round admission limit before any side effect was authorized.
      for (const call of rawCalls) {
        const id = stableToolCallId(call.id, call.function.name, call.function.arguments);
        options.onProgress?.({
          entry: makeToolCallEntry(id, call.function.name, toolCallSummary(call.function.name, call.function.arguments), "failed", {
            ok: false,
            code: "invalid_request",
            message: "tool call limit exceeded",
          }, localId(options.turnId, id)),
        });
        limitResults.push({
          toolCallId: id,
          name: call.function.name,
          content: limitMessage,
          ok: false,
          error: limitMessage,
        });
      }
      turnToolResults.push(...limitResults);
      messages.push(...buildToolTurnMessages({ ...result.message, toolCalls: rawCalls }, limitResults));
      return tryFinalizeToolLoop(options, messages, turnToolResults);
    }

    const calls: ProviderToolCall[] = [];
    const seenIds = new Set<string>();
    for (const call of rawCalls) {
      const id = stableToolCallId(call.id, call.function.name, call.function.arguments);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      calls.push(call);
    }
    const normalizedMessage = { ...result.message, toolCalls: calls };

    if (round === activeRoundLimit) {
      if (activeRoundLimit < budget.maxTotalRounds && progressSinceWindowStart) {
        // Default windows are soft: a successful, previously unseen outcome in
        // the preceding window earns one more bounded window of work.
        activeRoundLimit = Math.min(activeRoundLimit + budget.maxRounds, budget.maxTotalRounds);
        progressSinceWindowStart = false;
      } else {
        const limitMessage =
          "Tool execution budget reached before this call could run. Do not call more tools; " +
          "summarize completed work and clearly state what remains pending.";
        return finalizeBlockedCalls(normalizedMessage, calls, limitMessage, "tool round limit exceeded");
      }
    }
    if (actualToolExecutions >= budget.maxTotalCalls || wallClockExpired()) {
      const limitMessage =
        actualToolExecutions >= budget.maxTotalCalls
          ? "Tool execution total limit reached before this call could run."
          : "Tool execution wall-clock limit reached before this call could run.";
      return finalizeBlockedCalls(normalizedMessage, calls, limitMessage);
    }

    const currentRoundFingerprints = new Set<string>();
    const roundOutcomes = new Map<string, ToolOutcome>();
    const toolResults: ToolResultInput[] = [];
    const finishedCallIds = new Set<string>();
    let noProgressObservation = false;
    let toolResultBytes = 0;

    const finish = (
      call: ProviderToolCall,
      id: string,
      summary: string,
      fingerprint: string,
      outcome: ToolOutcome,
    ): void => {
      options.onProgress?.({
        entry: makeToolCallEntry(
          id,
          call.function.name,
          summary,
          outcome.ok ? "completed" : "failed",
          outcome.result,
          localId(options.turnId, id),
        ),
      });
      const wireContent = outcome.ok
        ? outcome.content
        : (outcome.error ?? outcome.content) || "erro desconhecido na execução";
      const content = truncateToolResult(wireContent, budget.maxResultBytes - toolResultBytes);
      toolResultBytes += Buffer.byteLength(content, "utf8");
      const toolResult: ToolResultInput = {
        toolCallId: id,
        name: call.function.name,
        content,
        ok: outcome.ok,
        ...(!outcome.ok ? { error: content } : {}),
        ...(outcome.visual === undefined ? {} : { visual: outcome.visual }),
      };
      toolResults.push(toolResult);
      turnToolResults.push(toolResult);
      finishedCallIds.add(id);
      currentRoundFingerprints.add(fingerprint);
      roundOutcomes.set(fingerprint, outcome);
    };

    type PendingCall = {
      call: ProviderToolCall;
      id: string;
      summary: string;
      fingerprint: string;
      resumableClaim?: { effectId: string; fingerprintHash: string };
    };

    const persistOutcome = (item: PendingCall, outcome: ToolOutcome): void => {
      if (item.resumableClaim === undefined) return;
      try {
        options.resumableEffects?.complete(item.resumableClaim.effectId, item.resumableClaim.fingerprintHash, outcome);
      } catch (error) {
        options.resumableEffects?.markUnsafe?.(item.resumableClaim.effectId);
        throw error;
      }
    };

    const invalidateReadObservations = (): void => {
      for (const observation of observationFingerprints) {
        previousRoundFingerprints.delete(observation);
        warnedFingerprints.delete(observation);
        currentRoundFingerprints.delete(observation);
        roundOutcomes.delete(observation);
      }
      observationFingerprints.clear();
      readObservationStreaks.clear();
    };

    const recordSuccessfulOutcome = (item: PendingCall, outcome: ToolOutcome): boolean => {
      if (!outcome.ok) {
        // A failed/blocked read is not a consecutive observation and must not
        // contribute to either progress or the no-progress cutoff.
        if (isReadOnlyToolCall(item.call)) readObservationStreaks.delete(item.fingerprint);
        return false;
      }
      const normalized = normalizedOutcomeContent(outcome.content);
      const readOnly = isReadOnlyToolCall(item.call);
      if (normalized.length === 0) {
        if (!readOnly) return false;
        const previous = readObservationStreaks.get(item.fingerprint);
        const count = previous?.hash === "" ? previous.count + 1 : 1;
        readObservationStreaks.set(item.fingerprint, { hash: "", count });
        return count >= 3;
      }
      const hash = outcomeContentHash(outcome.content);
      const freshOutcome = !successfulOutcomeHashes.has(hash);
      const hadPriorSuccessfulOutcome = successfulOutcomeHashes.size > 0;
      successfulOutcomeHashes.add(hash);
      // The first observation establishes a baseline; only a later distinct
      // successful outcome is evidence that the turn is making progress.
      if (freshOutcome && hadPriorSuccessfulOutcome) progressSinceWindowStart = true;
      if (!readOnly) return false;
      const previous = readObservationStreaks.get(item.fingerprint);
      const count = previous?.hash === hash ? previous.count + 1 : 1;
      readObservationStreaks.set(item.fingerprint, { hash, count });
      return count >= 3;
    };

    const executePending = async (item: PendingCall): Promise<ToolOutcome> => {
      const { call, id, summary } = item;
      // Reserve the durable effect only at the point where this admitted item
      // is about to execute. Queued parallel siblings remain merely prepared,
      // so a later boundary cannot strand `started` claims.
      if (item.resumableClaim !== undefined) {
        options.resumableEffects?.markStarted(item.resumableClaim.effectId);
      }
      let extensionResult: ToolExecutionResult = { handled: false };
      const extensionExpected = options.executeTool?.canHandle?.(call.function.name) ?? false;
      if (extensionExpected) {
        options.onProgress?.({
          entry: makeToolCallEntry(id, call.function.name, summary, "running", undefined, localId(options.turnId, id)),
        });
      }
      if (options.executeTool) {
        try {
          const candidate: unknown = await options.executeTool({
            agentId: options.agentId,
            call,
            signal: options.request.signal,
          });
          extensionResult = validToolExecutionResult(candidate)
            ? candidate
            : {
                handled: true,
                ok: false,
                content: "",
                error: "shared tool returned an invalid result",
                result: { ok: false, code: "io_error", message: "Shared tool returned an invalid result." },
              };
        } catch (error) {
          const message = error instanceof Error ? error.message : "shared tool failed";
          extensionResult = {
            handled: true,
            ok: false,
            content: "",
            error: message,
            result: { ok: false, code: "io_error", message },
          };
        }
      }
      if (extensionResult.handled) {
        if (!extensionExpected) {
          options.onProgress?.({
            entry: makeToolCallEntry(id, call.function.name, summary, "running", undefined, localId(options.turnId, id)),
          });
        }
        if (!isReadOnlyToolCall(call)) invalidateReadObservations();
        const extensionContent = extensionResult.ok
          ? extensionResult.content
          : extensionResult.error ?? extensionResult.content;
        return {
          ok: extensionResult.ok,
          content: extensionContent,
          ...(!extensionResult.ok ? { error: extensionContent } : {}),
          result: extensionResult.result ?? (extensionResult.ok
            ? { ok: true }
            : { ok: false, code: "io_error", message: extensionResult.error ?? "shared tool failed" }),
        };
      }
      const parsed = toolCallToExecutionRequest(call);
      if (!parsed.request) {
        const error = parsed.error ?? "tool request is invalid";
        return {
          ok: false,
          content: error,
          error,
          result: { ok: false, code: "invalid_request", message: error },
        };
      }
      options.onProgress?.({
        entry: makeToolCallEntry(id, call.function.name, summary, "running", undefined, localId(options.turnId, id)),
      });
      if (!options.broker) {
        const error = "local execution broker is unavailable";
        return {
          ok: false,
          content: error,
          error,
          result: { ok: false, code: "unavailable", message: error },
        };
      }
      const executionRequestId = localId(options.turnId, id) ?? id;
      const hostPermission = options.resolveHostPermission?.(options.agentId, parsed.request);
      let executed;
      try {
        executed = await options.broker.execute(
          options.agentId,
          executionRequestId,
          parsed.request,
          options.request.signal,
          hostPermission === undefined && options.conversationId === undefined
            ? undefined
            : {
              ...(hostPermission === undefined ? {} : { permission: hostPermission }),
              ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
            },
        );
      } catch (error) {
        if (item.resumableClaim !== undefined) options.resumableEffects?.markUnsafe?.(item.resumableClaim.effectId);
        throw error;
      }
      // Any mutating or unknown-effect execution invalidates cached read
      // observations: a read issued before a write must not satisfy a read
      // issued after it. Conservative by design — the cost of a stale
      // observation is wrong data, the cost of re-reading is one extra call.
      if (!isReadOnlyToolCall(call)) {
        invalidateReadObservations();
      }
      const visual = browserVisual(executed);
      const includeVisual = visual !== undefined && options.request.acceptsImages === true;
      const cardResult = toolCallResult(executed, parsed.request);
      const content = executed.ok && !cardResult.ok
        ? JSON.stringify({ ...executed, ok: false, code: cardResult.code, message: cardResult.message })
        : resultText(executed, includeVisual);
      return {
        ok: cardResult.ok,
        content,
        ...(!cardResult.ok ? { error: content } : {}),
        result: cardResult,
        ...(includeVisual ? { visual } : {}),
      };
    };

    const applyOutcome = (item: PendingCall, outcome: ToolOutcome): StreamChatResult | undefined => {
      persistOutcome(item, outcome);
      if (recordSuccessfulOutcome(item, outcome)) noProgressObservation = true;
      finish(item.call, item.id, item.summary, item.fingerprint, outcome);
      if (options.request.signal?.aborted) return abortedResult();
      return undefined;
    };

    const parallelReadOnlyRound = calls.length > 1 && calls.every((call) => isReadOnlyToolCall(call));
    // Reserve a whole parallel batch before creating resumable claims. If the
    // aggregate cap or wall clock cannot admit every sibling, close the batch
    // together so no `started` claim is left without an execution.
    const parallelExecutionCount = new Set(calls.map(semanticFingerprint)).size;
    if (parallelReadOnlyRound && (actualToolExecutions + parallelExecutionCount > budget.maxTotalCalls || wallClockExpired())) {
      const reason = actualToolExecutions + parallelExecutionCount > budget.maxTotalCalls
        ? "Tool execution total limit reached before this call could run."
        : "Tool execution wall-clock limit reached before this call could run.";
      return finalizeBlockedCalls(normalizedMessage, calls, reason);
    }
    const pending: PendingCall[] = [];
    const aliasesByFingerprint = new Map<string, PendingCall[]>();

    for (const call of calls) {
      const summary = toolCallSummary(call.function.name, call.function.arguments);
      const id = stableToolCallId(call.id, call.function.name, call.function.arguments);
      const fingerprint = semanticFingerprint(call);
      if (isReadOnlyToolCall(call)) {
        observationFingerprints.add(fingerprint);
      }
      const sameRound = roundOutcomes.get(fingerprint);
      if (sameRound !== undefined) {
        finish(call, id, summary, fingerprint, sameRound);
        continue;
      }
      if (previousRoundFingerprints.has(fingerprint)) {
        if (!isReadOnlyToolCall(call)) {
          if (warnedFingerprints.has(fingerprint)) {
            finish(call, id, summary, fingerprint, repeatedOutcome());
            // Keep the assistant call/result contract complete before the
            // tool-free rescue. Calls after the repeated one are blocked too;
            // none of them may start while finalization is being attempted.
            for (const pendingCall of calls) {
              const pendingId = stableToolCallId(pendingCall.id, pendingCall.function.name, pendingCall.function.arguments);
              if (finishedCallIds.has(pendingId)) continue;
              finish(
                pendingCall,
                pendingId,
                toolCallSummary(pendingCall.function.name, pendingCall.function.arguments),
                semanticFingerprint(pendingCall),
                repeatedOutcome(),
              );
            }
            messages.push(...buildToolTurnMessages(normalizedMessage, toolResults));
            return tryFinalizeToolLoop(options, messages, turnToolResults);
          }
          warnedFingerprints.add(fingerprint);
          finish(call, id, summary, fingerprint, repeatedOutcome());
          continue;
        }
        // Read-only calls are polling observations: execute them again so a
        // changing status/result can provide genuine progress. The same
        // successful output is tracked below and stops after three repeats.
      }

      // A provider may finish emitting a tool call after cancellation. Never
      // start or durably claim a side effect once the turn is already aborted.
      if (options.request.signal?.aborted) return abortedResult();

      if (parallelReadOnlyRound) {
        const queued = pending.find((item) => item.fingerprint === fingerprint);
        if (queued !== undefined) {
          const aliases = aliasesByFingerprint.get(fingerprint) ?? [];
          aliases.push({ call, id, summary, fingerprint });
          aliasesByFingerprint.set(fingerprint, aliases);
          continue;
        }
      }

      const admissionBlocked = actualToolExecutions >= budget.maxTotalCalls || wallClockExpired();
      if (admissionBlocked) {
        const reason = actualToolExecutions >= budget.maxTotalCalls
          ? "Tool execution total limit reached before this call could run."
          : "Tool execution wall-clock limit reached before this call could run.";
        finish(call, id, summary, fingerprint, blockedExecutionOutcome(reason));
        for (const pendingCall of calls) {
          const pendingId = stableToolCallId(pendingCall.id, pendingCall.function.name, pendingCall.function.arguments);
          if (finishedCallIds.has(pendingId)) continue;
          finish(
            pendingCall,
            pendingId,
            toolCallSummary(pendingCall.function.name, pendingCall.function.arguments),
            semanticFingerprint(pendingCall),
            blockedExecutionOutcome(reason),
          );
        }
        messages.push(...buildToolTurnMessages(normalizedMessage, toolResults));
        return tryFinalizeToolLoop(options, messages, turnToolResults);
      }

      let resumableClaim: PendingCall["resumableClaim"];
      if (options.resumableEffects !== undefined) {
        // Distinct executions of the same fingerprint are distinct effects:
        // read → write → read must not inherit the pre-mutation outcome.
        const occurrence = executionCounts.get(fingerprint) ?? 0;
        executionCounts.set(fingerprint, occurrence + 1);
        const effectId = stableResumeEffectId(options.turnId ?? "", occurrence === 0 ? fingerprint : `${fingerprint}\0occurrence:${occurrence}`);
        const fingerprintHash = resumeFingerprintHash(fingerprint);
        const previous = options.resumableEffects.prepare(effectId, fingerprintHash);
        if (previous.status === "completed") {
          if (!persistedOutcome(previous.result)) throw new ProviderError("persisted resume effect outcome is invalid", { kind: "validation", code: "unsafe_effect" });
          finish(call, id, summary, fingerprint, previous.result);
          continue;
        }
        if (previous.status === "unsafe" || previous.status === "started") {
          if (previous.status === "started") options.resumableEffects.markUnsafe?.(effectId);
          finish(call, id, summary, fingerprint, {
            ok: false,
            content: "resume effect is unsafe after restart",
            error: "resume effect is unsafe after restart",
            result: { ok: false, code: "io_error", message: "Resume effect is unsafe after restart." },
          });
          return { aborted: false, error: new ProviderError("resume effect is unsafe after restart", { kind: "validation", code: "unsafe_effect" }) };
        }
        resumableClaim = { effectId, fingerprintHash };
      }
      const item: PendingCall = { call, id, summary, fingerprint, ...(resumableClaim === undefined ? {} : { resumableClaim }) };
      const admission = admitToolExecution();
      if (admission === "aborted") return abortedResult();
      if (admission === "limit") {
        const reason = actualToolExecutions >= budget.maxTotalCalls
          ? "Tool execution total limit reached before this call could run."
          : "Tool execution wall-clock limit reached before this call could run.";
        if (parallelReadOnlyRound) {
          // A wall-clock boundary may arrive after an earlier sibling was
          // reserved. Those claims never started an effect; close their cards
          // without converting them into durable `started` claims.
          for (const queued of pending) {
            if (!finishedCallIds.has(queued.id)) {
              finish(queued.call, queued.id, queued.summary, queued.fingerprint, blockedExecutionOutcome(reason));
            }
            for (const alias of aliasesByFingerprint.get(queued.fingerprint) ?? []) {
              if (finishedCallIds.has(alias.id)) continue;
              finish(alias.call, alias.id, alias.summary, alias.fingerprint, blockedExecutionOutcome(reason));
            }
          }
        }
        finish(item.call, item.id, item.summary, item.fingerprint, blockedExecutionOutcome(reason));
        for (const pendingCall of calls) {
          const pendingId = stableToolCallId(pendingCall.id, pendingCall.function.name, pendingCall.function.arguments);
          if (finishedCallIds.has(pendingId)) continue;
          finish(
            pendingCall,
            pendingId,
            toolCallSummary(pendingCall.function.name, pendingCall.function.arguments),
            semanticFingerprint(pendingCall),
            blockedExecutionOutcome(reason),
          );
        }
        messages.push(...buildToolTurnMessages(normalizedMessage, toolResults));
        return tryFinalizeToolLoop(options, messages, turnToolResults);
      }
      if (parallelReadOnlyRound) {
        pending.push(item);
        continue;
      }
      const outcome = await executePending(item);
      const aborted = applyOutcome(item, outcome);
      if (aborted) return aborted;
      if (noProgressObservation) {
        for (const pendingCall of calls) {
          const pendingId = stableToolCallId(pendingCall.id, pendingCall.function.name, pendingCall.function.arguments);
          if (finishedCallIds.has(pendingId)) continue;
          finish(
            pendingCall,
            pendingId,
            toolCallSummary(pendingCall.function.name, pendingCall.function.arguments),
            semanticFingerprint(pendingCall),
            repeatedOutcome(),
          );
        }
        messages.push(...buildToolTurnMessages(normalizedMessage, toolResults));
        return tryFinalizeToolLoop(options, messages, turnToolResults);
      }
    }

    if (parallelReadOnlyRound) {
      // Every started sibling reaches a terminal state: a failed or cancelled
      // read must not discard the recorded outcomes of its siblings — their
      // transcript cards and resumable claims still need finish()/complete()
      // or they would poison the next resume.
      const settled = await Promise.all(pending.map(async (item) => {
        try {
          return { item, outcome: await executePending(item), error: undefined as unknown };
        } catch (error) {
          return { item, outcome: undefined as ToolOutcome | undefined, error };
        }
      }));
      let aborted: StreamChatResult | undefined;
      let firstError: unknown;
      for (const entry of settled) {
        try {
          const { item } = entry;
          let outcome = entry.outcome;
          if (outcome === undefined) {
            // A rejected sibling is still terminal work: close its card and
            // mark its claim unsafe instead of leaking `started` forever.
            firstError ??= entry.error;
            if (item.resumableClaim !== undefined) options.resumableEffects?.markUnsafe?.(item.resumableClaim.effectId);
            const message = entry.error instanceof Error ? entry.error.message : String(entry.error);
            outcome = {
              ok: false,
              content: message,
              error: message,
              result: { ok: false, code: "io_error", message },
            };
            finish(item.call, item.id, item.summary, item.fingerprint, outcome);
            if (options.request.signal?.aborted) aborted ??= abortedResult();
          } else {
            const abortedNow = applyOutcome(item, outcome);
            aborted ??= abortedNow;
          }
          for (const alias of aliasesByFingerprint.get(item.fingerprint) ?? []) {
            finish(alias.call, alias.id, alias.summary, alias.fingerprint, outcome);
          }
        } catch (error) {
          // A persist/progress failure on one sibling still leaves the others
          // unrecorded; keep applying and surface the first failure after.
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
      if (aborted !== undefined) return aborted;
      if (noProgressObservation) {
        for (const call of calls) {
          const id = stableToolCallId(call.id, call.function.name, call.function.arguments);
          if (finishedCallIds.has(id)) continue;
          finish(call, id, toolCallSummary(call.function.name, call.function.arguments), semanticFingerprint(call), repeatedOutcome());
        }
        messages.push(...buildToolTurnMessages(normalizedMessage, toolResults));
        return tryFinalizeToolLoop(options, messages, turnToolResults);
      }
    }
    messages.push(...buildToolTurnMessages(normalizedMessage, toolResults));
    previousRoundFingerprints = currentRoundFingerprints;
  }
  throw new Error("unreachable tool loop state");
}
