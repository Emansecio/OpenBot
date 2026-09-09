import type { LocalExecutionBroker, LocalToolPermission } from "./broker.js";
import type { ExecutionRequest, ExecutionResult } from "./contracts.js";
import { makeToolCallEntry, stableToolCallId, toolCallLocalId, toolCallResult, toolCallSummary, type ToolCallEntry } from "./tool-card.js";
import { toolCallToExecutionRequest } from "./tool-request.js";
import { buildToolTurnMessages, type ToolResultInput } from "../providers/tool-calls.js";
import { ProviderError, type ProviderChatMessage, type ProviderChatRequest, type ProviderStreamEvent, type ProviderToolCall, type StreamChatResult } from "../providers/router.js";
import type { ToolCallResult } from "../shared/contracts.js";
import { resumeFingerprintHash, stableResumeEffectId, type ResumeEffectRecord } from "../providers/resume.js";

export const MAX_TOOL_ROUNDS = 8;
export const MAX_TOOL_CALLS_PER_ROUND = 16;
export const MAX_TOOL_RESULT_BYTES_PER_ROUND = 128 * 1024;
export const TOOL_RESULT_TRUNCATION_MARKER = "\n[output truncated by OpenBot]";
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
  stream: (request: ProviderChatRequest, onEvent: (event: ProviderStreamEvent) => void) => Promise<StreamChatResult>;
  /** Rebuilds the bounded request after tool calls/results are appended. */
  prepareRequest?: (messages: readonly ProviderChatMessage[]) => ProviderChatRequest;
  onEvent: (event: ProviderStreamEvent) => void;
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

export async function runToolLoop(options: ToolLoopOptions): Promise<StreamChatResult> {
  const messages: ProviderChatMessage[] = [...options.request.messages];
  const initialMessageCount = messages.length;
  const deferredTextTools = new Set(options.deferTextUntilToolResultFor ?? []);
  let previousRoundFingerprints = new Set<string>();
  const warnedFingerprints = new Set<string>();
  const browserObservationFingerprints = new Set<string>();
  let contextOverflowRetried = false;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    if (options.request.signal?.aborted) return abortedResult();
    let observedText = false;
    const stageRoundEvents = deferredTextTools.size > 0;
    const deferredErrors: ProviderStreamEvent[] = [];
    const stagedEvents: ProviderStreamEvent[] = [];
    const receiveEvent = (event: ProviderStreamEvent): void => {
      if (event.type === "delta") observedText = true;
      if (event.type === "error") deferredErrors.push(event);
      else if (stageRoundEvents) {
        stagedEvents.push(event);
        if (event.type !== "message") options.onEvent(event);
      } else options.onEvent(event);
    };
    const targetsDeferredTool = (calls: readonly ProviderToolCall[]): boolean =>
      calls.some((call) => deferredTextTools.has(call.function.name));
    const stagedTargetsDeferredTool = (): boolean => stagedEvents.some((event) =>
      event.type === "tool-call" && deferredTextTools.has(event.call.function.name));
    const flushRoundEvents = (suppressText: boolean): void => {
      if (suppressText) options.onEvent({ type: "discard-round-text" });
      else {
        for (const event of stagedEvents) {
          if (event.type === "message") options.onEvent(event);
        }
      }
      for (const event of deferredErrors) options.onEvent(event);
    };
    const prepare = (nextMessages: readonly ProviderChatMessage[]): ProviderChatRequest => options.prepareRequest?.(nextMessages) ?? { ...options.request, messages: [...nextMessages] };
    let result = await options.stream(prepare(messages), receiveEvent);
    if (
      result.error && !result.aborted && (!observedText || stagedTargetsDeferredTool()) && !contextOverflowRetried &&
      options.contextOverflowRetry?.isOverflow(result.error)
    ) {
      contextOverflowRetried = true;
      const suffix = messages.slice(initialMessageCount);
      messages.splice(0, messages.length, ...options.contextOverflowRetry.messages(), ...suffix);
      observedText = false;
      deferredErrors.length = 0;
      stagedEvents.length = 0;
      result = await options.stream(prepare(messages), receiveEvent);
    }
    if (result.error || result.aborted || !result.message) {
      flushRoundEvents(stagedTargetsDeferredTool());
      return result;
    }
    const rawCalls = result.message.toolCalls?.map(normalizeToolCall) ?? [];
    flushRoundEvents(targetsDeferredTool(rawCalls));
    if (rawCalls.length === 0) return result;
    if (rawCalls.length > MAX_TOOL_CALLS_PER_ROUND) {
      return {
        aborted: false,
        error: new ProviderError("tool call limit exceeded", { kind: "validation", code: "tool_call_limit" }),
      };
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

    if (round === MAX_TOOL_ROUNDS) {
      for (const call of calls) {
        const summary = toolCallSummary(call.function.name, call.function.arguments);
        const id = stableToolCallId(call.id, call.function.name, call.function.arguments);
        options.onProgress?.({
          entry: makeToolCallEntry(id, call.function.name, summary, "failed", {
            ok: false,
            code: "invalid_request",
            message: "tool round limit exceeded",
          }, localId(options.turnId, id)),
        });
      }
      return {
        aborted: false,
        error: new ProviderError("tool round limit exceeded", { kind: "validation", code: "tool_round_limit" }),
      };
    }

    const currentRoundFingerprints = new Set<string>();
    const roundOutcomes = new Map<string, ToolOutcome>();
    const toolResults: ToolResultInput[] = [];
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
      const content = truncateToolResult(outcome.content, MAX_TOOL_RESULT_BYTES_PER_ROUND - toolResultBytes);
      toolResultBytes += Buffer.byteLength(content, "utf8");
      toolResults.push({
        toolCallId: id,
        name: call.function.name,
        content,
        ok: outcome.ok,
        ...(!outcome.ok ? { error: outcome.error ?? content } : {}),
        ...(outcome.visual === undefined ? {} : { visual: outcome.visual }),
      });
      currentRoundFingerprints.add(fingerprint);
      roundOutcomes.set(fingerprint, outcome);
    };

    for (const call of calls) {
      const summary = toolCallSummary(call.function.name, call.function.arguments);
      const id = stableToolCallId(call.id, call.function.name, call.function.arguments);
      const fingerprint = semanticFingerprint(call);
      if (call.function.name === "browser_snapshot" || call.function.name === "browser_screenshot") {
        browserObservationFingerprints.add(fingerprint);
      }
      const sameRound = roundOutcomes.get(fingerprint);
      if (sameRound !== undefined) {
        finish(call, id, summary, fingerprint, sameRound);
        continue;
      }
      if (previousRoundFingerprints.has(fingerprint)) {
        if (warnedFingerprints.has(fingerprint)) {
          const outcome = repeatedOutcome();
          finish(call, id, summary, fingerprint, outcome);
          return {
            aborted: false,
            error: new ProviderError("repeated tool call limit exceeded", {
              kind: "validation",
              code: "tool_repetition_limit",
            }),
          };
        }
        warnedFingerprints.add(fingerprint);
        finish(call, id, summary, fingerprint, repeatedOutcome());
        continue;
      }

      // A provider may finish emitting a tool call after cancellation. Never
      // start or durably claim a side effect once the turn is already aborted.
      if (options.request.signal?.aborted) return abortedResult();

      let resumableClaim: { effectId: string; fingerprintHash: string } | undefined;
      if (options.resumableEffects !== undefined) {
        const effectId = stableResumeEffectId(options.turnId ?? "", fingerprint);
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
        options.resumableEffects.markStarted(effectId);
        resumableClaim = { effectId, fingerprintHash };
      }
      const persistOutcome = (outcome: ToolOutcome): void => {
        if (resumableClaim === undefined) return;
        try {
          options.resumableEffects?.complete(resumableClaim.effectId, resumableClaim.fingerprintHash, outcome);
        } catch (error) {
          options.resumableEffects?.markUnsafe?.(resumableClaim.effectId);
          throw error;
        }
      };

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
        const extensionContent = extensionResult.ok
          ? extensionResult.content
          : extensionResult.error ?? extensionResult.content;
        const outcome: ToolOutcome = {
          ok: extensionResult.ok,
          content: extensionContent,
          ...(!extensionResult.ok ? { error: extensionContent } : {}),
          result: extensionResult.result ?? (extensionResult.ok
            ? { ok: true }
            : { ok: false, code: "io_error", message: extensionResult.error ?? "shared tool failed" }),
        };
        persistOutcome(outcome);
        finish(call, id, summary, fingerprint, outcome);
        // Once an executor returns a result, that result is the durable truth
        // even if cancellation raced with its final commit.
        if (options.request.signal?.aborted) return abortedResult();
        continue;
      }
      if (options.request.signal?.aborted) return abortedResult();
      const parsed = toolCallToExecutionRequest(call);
      if (!parsed.request) {
        const error = parsed.error ?? "tool request is invalid";
        const outcome: ToolOutcome = {
          ok: false,
          content: error,
          error,
          result: { ok: false, code: "invalid_request", message: error },
        };
        persistOutcome(outcome);
        finish(call, id, summary, fingerprint, outcome);
        continue;
      }
      options.onProgress?.({
        entry: makeToolCallEntry(id, call.function.name, summary, "running", undefined, localId(options.turnId, id)),
      });
      if (!options.broker) {
        const error = "local execution broker is unavailable";
        const outcome: ToolOutcome = {
          ok: false,
          content: error,
          error,
          result: { ok: false, code: "unavailable", message: error },
        };
        persistOutcome(outcome);
        finish(call, id, summary, fingerprint, outcome);
        continue;
      }
      // Provider tool-call IDs are not guaranteed unique across turns. The
      // turn-scoped ID is also used by approval cards and persisted decisions.
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
        if (resumableClaim !== undefined) options.resumableEffects?.markUnsafe?.(resumableClaim.effectId);
        throw error;
      }
      if (parsed.request.operation.startsWith("browser.")
          && parsed.request.operation !== "browser.snapshot" && parsed.request.operation !== "browser.screenshot") {
        // A browser action can change the page even when it reports a failure.
        // Observations from before that action must be allowed to run again.
        for (const observation of browserObservationFingerprints) {
          previousRoundFingerprints.delete(observation);
          warnedFingerprints.delete(observation);
          currentRoundFingerprints.delete(observation);
          roundOutcomes.delete(observation);
        }
        browserObservationFingerprints.clear();
      }
      const visual = browserVisual(executed);
      const includeVisual = visual !== undefined && options.request.acceptsImages === true;
      const cardResult = toolCallResult(executed, parsed.request);
      const content = executed.ok && !cardResult.ok
        ? JSON.stringify({ ...executed, ok: false, code: cardResult.code, message: cardResult.message })
        : resultText(executed, includeVisual);
      const outcome: ToolOutcome = {
        ok: cardResult.ok,
        content,
        ...(!cardResult.ok ? { error: content } : {}),
        result: cardResult,
        ...(includeVisual ? { visual } : {}),
      };
      persistOutcome(outcome);
      finish(call, id, summary, fingerprint, outcome);
      if (options.request.signal?.aborted) return abortedResult();
    }
    messages.push(...buildToolTurnMessages(normalizedMessage, toolResults));
    previousRoundFingerprints = currentRoundFingerprints;
  }
  throw new Error("unreachable tool loop state");
}
