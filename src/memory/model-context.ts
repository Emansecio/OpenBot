import type { ModelCatalogEntry, ModelTokenizerStrategy, ProviderKind } from "../shared/contracts.js";
import type { ProviderChatMessage } from "../providers/router.js";
import { MODEL_CATALOG } from "../config/models.js";
import { providerRequestBodyBytes } from "../providers/request-bodies.js";

/** Safe finite defaults for a model whose tokenizer/capabilities are unknown. */
export const DEFAULT_UNKNOWN_MODEL_CAPABILITIES: ModelCapabilities = Object.freeze({
  contextWindow: 16_384,
  maxOutputTokens: 2_048,
  maxRequestBytes: 256 * 1024,
  tokenizerStrategy: "estimated",
  safetyMargin: 0.2,
});

export interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  maxRequestBytes?: number;
  tokenizerStrategy: ModelTokenizerStrategy | "fake" | "bytes";
  safetyMargin: number;
}

export interface ContextTokenizer {
  readonly strategy: ModelCapabilities["tokenizerStrategy"];
  count(text: string): number;
}

/** A deliberately boring tokenizer for deterministic tests and safe fallback. */
export function createFakeTokenizer(options: { tokensPerCharacter?: number } = {}): ContextTokenizer {
  const tokensPerCharacter = options.tokensPerCharacter ?? 0.25;
  if (!Number.isFinite(tokensPerCharacter) || !Number.isSafeInteger(Math.ceil(tokensPerCharacter * 1_000_000)) || tokensPerCharacter <= 0 || tokensPerCharacter > 1000) {
    throw new Error("tokensPerCharacter must be a finite positive number");
  }
  return {
    strategy: "fake",
    count(text: string): number {
      if (typeof text !== "string" || text.length === 0) return 0;
      const output = Math.max(1, Math.ceil([...text].length * tokensPerCharacter));
      if (!Number.isSafeInteger(output)) throw new Error("fake tokenizer output is not a safe integer");
      return output;
    },
  };
}

export function createContextTokenizer(strategy: ContextTokenizer["strategy"] = "estimated"): ContextTokenizer {
  if (strategy === "fake") return createFakeTokenizer();
  if (strategy === "provider") throw new Error("provider tokenizer is not configured");
  if (strategy === "estimated") {
    return {
      strategy,
      count(text: string): number {
        if (text.length === 0) return 0;
        let tokens = 0;
        for (const segment of text.matchAll(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]+/gu)) {
          const value = segment[0];
          if (/^\s+$/u.test(value)) tokens += Math.ceil(value.length / 8);
          else if (/^[\x00-\x7F]+$/u.test(value)) tokens += Math.ceil(value.length / 3);
          else tokens += Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 2));
        }
        if (!Number.isSafeInteger(tokens)) throw new Error("estimated tokenizer output is not a safe integer");
        return tokens;
      },
    };
  }
  return {
    strategy: "bytes",
    count(text: string): number {
      return Buffer.byteLength(text, "utf8");
    },
  };
}

function assertFinitePositive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive safe integer`);
}

/** Validates catalog input at the configuration boundary. Legacy optional fields remain valid. */
export function validateModelCatalogEntry(entry: ModelCatalogEntry): void {
  if (typeof entry.id !== "string" || entry.id.trim().length === 0) throw new Error("model id is required");
  if (entry.contextWindow !== undefined) assertFinitePositive(entry.contextWindow, "contextWindow");
  if (entry.maxOutputTokens !== undefined) assertFinitePositive(entry.maxOutputTokens, "maxOutputTokens");
  if (entry.maxRequestBytes !== undefined) assertFinitePositive(entry.maxRequestBytes, "maxRequestBytes");
  if (entry.contextWindow !== undefined && entry.maxOutputTokens !== undefined && entry.maxOutputTokens > entry.contextWindow) {
    throw new Error("maxOutputTokens must not exceed contextWindow");
  }
  if (entry.tokenizerStrategy !== undefined && !["estimated", "provider"].includes(entry.tokenizerStrategy)) {
    throw new Error("tokenizerStrategy is invalid");
  }
  if (entry.safetyMargin !== undefined && (!Number.isFinite(entry.safetyMargin) || entry.safetyMargin < 0 || entry.safetyMargin >= 0.5)) {
    throw new Error("safetyMargin must be finite and in [0, 0.5)");
  }
}

export function normalizeModelCapabilities(entry: ModelCatalogEntry): ModelCapabilities {
  validateModelCatalogEntry(entry);
  const capabilities: ModelCapabilities = {
    contextWindow: entry.contextWindow ?? DEFAULT_UNKNOWN_MODEL_CAPABILITIES.contextWindow,
    maxOutputTokens: entry.maxOutputTokens ?? DEFAULT_UNKNOWN_MODEL_CAPABILITIES.maxOutputTokens,
    maxRequestBytes: entry.maxRequestBytes ?? DEFAULT_UNKNOWN_MODEL_CAPABILITIES.maxRequestBytes,
    tokenizerStrategy: entry.tokenizerStrategy ?? DEFAULT_UNKNOWN_MODEL_CAPABILITIES.tokenizerStrategy,
    safetyMargin: entry.safetyMargin ?? DEFAULT_UNKNOWN_MODEL_CAPABILITIES.safetyMargin,
  };
  if (capabilities.maxOutputTokens > capabilities.contextWindow) throw new Error("model output exceeds context window");
  return capabilities;
}

export function resolveModelCapabilities(
  model: string | ModelCatalogEntry,
  provider?: ProviderKind | string,
  catalog: readonly ModelCatalogEntry[] = MODEL_CATALOG,
): ModelCapabilities {
  if (typeof model !== "string") return normalizeModelCapabilities(model);
  const entry = catalog.find((candidate) => candidate.id === model);
  if (entry !== undefined) return normalizeModelCapabilities(entry);
  const providerFallback = provider === "openai-compat"
    ? catalog.find((candidate) => candidate.id === "openai-compatible")
    : undefined;
  return providerFallback === undefined ? { ...DEFAULT_UNKNOWN_MODEL_CAPABILITIES } : normalizeModelCapabilities(providerFallback);
}

export interface ModelContextComponents {
  system: string | number;
  tools: string | number;
  transcript: string | number;
  memory: string | number;
  attachments: string | number;
}

export interface ModelContextBudgetInput {
  capabilities: ModelCapabilities;
  tokenizer?: ContextTokenizer;
  components?: ModelContextComponents;
  system?: string | number;
  tools?: string | number;
  transcript?: string | number;
  memory?: string | number;
  attachments?: string | number;
  requestedOutputTokens?: number;
}

export interface ModelContextBudget {
  contextWindowTokens: number;
  outputReserveTokens: number;
  inputBudgetTokens: number;
  availableContentTokens: number;
  used: { system: number; tools: number; transcript: number; memory: number; attachments: number };
  truncated: boolean;
}

export interface ProviderRoundPreparation {
  request: import("../providers/router.js").ProviderChatRequest;
  budget: ModelContextBudget;
  telemetry: {
    estimatedInputTokens: number;
    serializedRequestBytes: number;
    retainedTurns: number;
    droppedTurns: number;
    truncationReason: "token_budget" | "wire_byte_budget" | "token_and_wire_byte_budget" | null;
  };
  exhausted: boolean;
}

export { providerRequestBodyBytes };

export function canonicalProviderRequestBytes(request: import("../providers/router.js").ProviderChatRequest): number {
  const envelope = {
    model: request.model,
    ...(request.system === undefined ? {} : { system: request.system }),
    messages: request.messages,
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
  };
  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

function count(value: string | number, tokenizer: ContextTokenizer): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("context component count is invalid");
    return value;
  }
  const result = tokenizer.count(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("tokenizer output is invalid");
  return result;
}

function countTokens(tokenizer: ContextTokenizer, text: string): number {
  return count(text, tokenizer);
}

export function computeModelContextBudget(input: ModelContextBudgetInput): ModelContextBudget {
  const capabilities = input.capabilities;
  if (!Number.isSafeInteger(capabilities.contextWindow) || capabilities.contextWindow <= 0) throw new Error("contextWindow is invalid");
  if (!Number.isSafeInteger(capabilities.maxOutputTokens) || capabilities.maxOutputTokens <= 0) throw new Error("maxOutputTokens is invalid");
  if (!Number.isFinite(capabilities.safetyMargin) || capabilities.safetyMargin < 0 || capabilities.safetyMargin >= 0.5) throw new Error("safetyMargin is invalid");
  const tokenizer = input.tokenizer ?? createContextTokenizer(capabilities.tokenizerStrategy);
  const raw = input.components ?? {
    system: input.system ?? 0,
    tools: input.tools ?? 0,
    transcript: input.transcript ?? 0,
    memory: input.memory ?? 0,
    attachments: input.attachments ?? 0,
  };
  const used = {
    system: count(raw.system, tokenizer),
    tools: count(raw.tools, tokenizer),
    transcript: count(raw.transcript, tokenizer),
    memory: count(raw.memory, tokenizer),
    attachments: count(raw.attachments, tokenizer),
  };
  const safeWindow = Math.floor(capabilities.contextWindow * (1 - capabilities.safetyMargin));
  if (!Number.isSafeInteger(safeWindow) || safeWindow <= 0) throw new Error("safe context window is invalid");
  const requestedOutput = input.requestedOutputTokens ?? capabilities.maxOutputTokens;
  if (!Number.isSafeInteger(requestedOutput) || requestedOutput <= 0) throw new Error("requestedOutputTokens is invalid");
  const fixedTokens = used.system + used.tools;
  const contentUsed = used.transcript + used.memory + used.attachments;
  // Never spend the complete post-system/tool window on output. A provider
  // request without any retained user content is not actionable, especially
  // for unknown/custom models whose conservative fallback window is smaller.
  const remainingAfterFixed = Math.max(0, safeWindow - fixedTokens);
  const minimumContentTokens = contentUsed > 0 ? Math.min(48, remainingAfterFixed) : 0;
  const outputReserveTokens = Math.max(0, Math.min(
    capabilities.maxOutputTokens,
    safeWindow,
    Math.max(1, requestedOutput),
    Math.max(0, remainingAfterFixed - minimumContentTokens),
  ));
  const inputBudgetTokens = Math.max(0, safeWindow - outputReserveTokens);
  const availableContentTokens = Math.max(0, inputBudgetTokens - fixedTokens);
  return {
    contextWindowTokens: capabilities.contextWindow,
    outputReserveTokens,
    inputBudgetTokens,
    availableContentTokens,
    used,
    truncated: fixedTokens > inputBudgetTokens || contentUsed > availableContentTokens,
  };
}

/** Single final gate used before every provider round, including tool rounds. */
export function prepareProviderRound(
  request: import("../providers/router.js").ProviderChatRequest,
  options: {
    capabilities: ModelCapabilities;
    maxBytes: number;
    requestedOutputTokens?: number;
    provider?: string;
    serializeRequest?: (request: import("../providers/router.js").ProviderChatRequest) => string;
  },
): ProviderRoundPreparation {
  const tokenizer = createContextTokenizer(options.capabilities.tokenizerStrategy);
  const system = request.system ?? "";
  const tools = JSON.stringify(request.tools ?? []);
  const budget = computeModelContextBudget({
    capabilities: options.capabilities,
    tokenizer,
    system,
    tools,
    transcript: countProviderMessageTokens(request.messages, tokenizer),
    memory: 0,
    attachments: 0,
    requestedOutputTokens: options.requestedOutputTokens ?? request.maxTokens ?? options.capabilities.maxOutputTokens,
  });
  const tokenFitted = selectCompleteMessageGroups(request.messages, tokenizer, budget.availableContentTokens);
  const tokenTruncated = JSON.stringify(tokenFitted) !== JSON.stringify(request.messages);
  const requestWithOutput = {
    ...request,
    messages: [],
    ...(budget.outputReserveTokens > 0 ? { maxTokens: budget.outputReserveTokens } : {}),
  };
  const emptyRequest = { ...requestWithOutput, messages: [] };
  const measure = (candidate: import("../providers/router.js").ProviderChatRequest): number => options.serializeRequest !== undefined
    ? Buffer.byteLength(options.serializeRequest(candidate), "utf8")
    : options.provider === undefined
      ? canonicalProviderRequestBytes(candidate)
      : providerRequestBodyBytes(options.provider, candidate);
  const envelopeEmptyBytes = measure(emptyRequest);
  let byteBudget = Math.max(0, options.maxBytes - envelopeEmptyBytes + 2);
  let fitted = fitProviderMessagesToByteBudget(tokenFitted, byteBudget);
  let finalRequest = { ...requestWithOutput, messages: fitted };
  for (let attempt = 0; attempt < 32 && measure(finalRequest) > options.maxBytes && byteBudget > 0; attempt += 1) {
    const over = measure(finalRequest) - options.maxBytes;
    byteBudget = Math.max(0, byteBudget - Math.max(1, over));
    fitted = fitProviderMessagesToByteBudget(tokenFitted, byteBudget);
    finalRequest = { ...requestWithOutput, messages: fitted };
  }
  const finalBudget: ModelContextBudget = {
    ...budget,
    used: {
      ...budget.used,
      ...classifyProviderMessageTokens(fitted, tokenizer),
    },
    truncated: JSON.stringify(fitted) !== JSON.stringify(request.messages) || budget.truncated,
  };
  const finalBodyBytes = measure(finalRequest);
  const wireTruncated = JSON.stringify(fitted) !== JSON.stringify(tokenFitted);
  const messageTokens = classifyProviderMessageTokens(fitted, tokenizer);
  const originalTurns = request.messages.filter((message) => message.role === "user").length;
  const retainedTurns = fitted.filter((message) => message.role === "user").length;
  const exhausted = envelopeEmptyBytes > options.maxBytes || finalBodyBytes > options.maxBytes || budget.outputReserveTokens <= 0 || (request.messages.length > 0 && fitted.length === 0 && byteBudget > 0);
  return {
    request: finalRequest,
    budget: finalBudget,
    telemetry: {
      estimatedInputTokens: budget.used.system + budget.used.tools + messageTokens.transcript + messageTokens.memory + messageTokens.attachments,
      serializedRequestBytes: finalBodyBytes,
      retainedTurns,
      droppedTurns: Math.max(0, originalTurns - retainedTurns),
      truncationReason: tokenTruncated && wireTruncated
        ? "token_and_wire_byte_budget"
        : tokenTruncated ? "token_budget" : wireTruncated ? "wire_byte_budget" : null,
    },
    exhausted,
  };
}

export const MODEL_CONTEXT_TRUNCATION_MARKER = "\n[context truncated by OpenBot]";
export const ATTACHMENT_TRUNCATION_END = "\n[[OPENBOT_UNTRUSTED_ATTACHMENT_END]]";
export const TOOL_OUTPUT_TRUNCATION_END = "\n[[OPENBOT_UNTRUSTED_TOOL_HISTORY_END]]";
const HISTORY_OMISSION_MARKER = "[OpenBot omitiu turnos anteriores por limite de contexto]";

function providerMessageBytes(message: ProviderChatMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

function shrinkProviderMessage(message: ProviderChatMessage, maxBytes: number): ProviderChatMessage | undefined {
  if (providerMessageBytes(message) <= maxBytes) return message;
  if (message.role === "user" && Array.isArray(message.content)) {
    let parts = message.content.map((part) => part.type === "image_url"
      ? { type: "text" as const, text: "[image omitted by context byte budget]" }
      : part);
    let candidate: ProviderChatMessage = { ...message, content: parts };
    while (providerMessageBytes(candidate) > maxBytes && parts.length > 1) {
      parts = parts.slice(0, -1);
      candidate = { ...message, content: parts };
    }
    if (providerMessageBytes(candidate) <= maxBytes) return candidate;
    parts = parts.map((part) => part.type === "text"
      ? { ...part, text: truncateProviderText(part.text, Math.max(0, maxBytes), createContextTokenizer("bytes")) }
      : part);
    candidate = { ...message, content: parts };
    return providerMessageBytes(candidate) <= maxBytes ? candidate : undefined;
  }
  if (typeof message.content !== "string") return undefined;
  const tokenizer = createContextTokenizer("bytes");
  let contentBudget = Math.max(0, maxBytes - providerMessageBytes({ ...message, content: "" }));
  let candidate: ProviderChatMessage = { ...message, content: truncateProviderText(message.content, contentBudget, tokenizer) };
  while (providerMessageBytes(candidate) > maxBytes && contentBudget > 0) {
    contentBudget = Math.floor(contentBudget / 2);
    candidate = { ...message, content: truncateProviderText(message.content, contentBudget, tokenizer) };
  }
  return providerMessageBytes(candidate) <= maxBytes ? candidate : undefined;
}

function shrinkProviderGroup(group: readonly ProviderChatMessage[], maxBytes: number): ProviderChatMessage[] {
  let candidate = group.map((message) => isMultimodalUser(message) ? replaceOversizedImages(message, BYTE_IMAGE_MARKER) : message);
  if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes) return candidate;
  candidate = candidate.map((message) => message.role === "tool" && typeof message.content === "string"
    ? { ...message, content: truncateProviderText(message.content, Math.max(0, Math.floor(maxBytes / 2)), createContextTokenizer("bytes")) }
    : message);
  if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes) return candidate;
  const prompt = candidate.find((message) => message.role === "user" && typeof message.content === "string");
  if (prompt?.role === "user" && typeof prompt.content === "string") {
    const otherBytes = Buffer.byteLength(JSON.stringify(candidate.filter((message) => message !== prompt)), "utf8");
    candidate = candidate.map((message) => message === prompt
      ? shrinkProviderMessage(message, Math.max(0, maxBytes - otherBytes - 1)) ?? message
      : message);
  }
  if (candidate.some((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0)
    && candidate.some((message) => message.role === "tool")) {
    return Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes ? candidate : [];
  }
  return Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes
    ? candidate
    : candidate.filter((message) => message.role === "user" && typeof message.content === "string").slice(0, 1);
}

/** Final absolute UTF-8 cap for every provider message shape, including images. */
export function fitProviderMessagesToByteBudget(messages: readonly ProviderChatMessage[], maxBytes: number): ProviderChatMessage[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return [];
  const groups: ProviderChatMessage[][] = [];
  for (const message of messages) {
    const current = groups.at(-1);
    const continuationImage = isMultimodalUser(message) && current !== undefined && groupHasToolResult(current);
    if ((message.role === "user" && !continuationImage) || groups.length === 0) groups.push([]);
    groups.at(-1)?.push(message);
  }
  if (groups.every(hasCompleteToolExchange) && Buffer.byteLength(JSON.stringify(messages), "utf8") <= maxBytes) return [...messages];
  const selected: ProviderChatMessage[][] = [];
  let used = 2;
  let omitted = false;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index] ?? [];
    if (!hasCompleteToolExchange(group)) {
      omitted = true;
      break;
    }
    const groupBytes = Buffer.byteLength(JSON.stringify(group), "utf8");
    if (selected.length > 0 && used + groupBytes > maxBytes) {
      omitted = true;
      break;
    }
    if (selected.length === 0 && used + groupBytes > maxBytes) {
      const fitted = shrinkProviderGroup(group, Math.max(0, maxBytes - used));
      if (fitted.length > 0) selected.unshift(fitted);
      omitted = index > 0 || fitted.length === 0;
      break;
    }
    selected.unshift(group);
    used += groupBytes;
  }
  let flattened = selected.flat();
  if (omitted) {
    const marker: ProviderChatMessage = { role: "system", content: HISTORY_OMISSION_MARKER };
    if (selected.length === 0) {
      flattened = [];
    } else {
      while (selected.length > 1 && Buffer.byteLength(JSON.stringify([marker, ...selected.flat()]), "utf8") > maxBytes) {
        selected.shift();
      }
      flattened = [marker, ...selected.flat()];
      if (Buffer.byteLength(JSON.stringify(flattened), "utf8") > maxBytes && selected.length === 1) {
        const markerBytes = Buffer.byteLength(JSON.stringify([marker]), "utf8");
        const fitted = shrinkProviderGroup(selected[0] ?? [], Math.max(0, maxBytes - markerBytes + 1));
        flattened = fitted.length > 0 ? [marker, ...fitted] : [];
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(flattened), "utf8") <= maxBytes) return flattened;
  const last = flattened.at(-1);
  const prefixBytes = Buffer.byteLength(JSON.stringify(flattened.slice(0, -1)), "utf8");
  const fittedLast = last === undefined ? undefined : shrinkProviderMessage(last, Math.max(0, maxBytes - prefixBytes - 1));
  const result = fittedLast === undefined ? flattened.slice(0, -1) : [...flattened.slice(0, -1), fittedLast];
  return Buffer.byteLength(JSON.stringify(result), "utf8") <= maxBytes ? result : [];
}

export function countProviderMessageTokens(messages: readonly ProviderChatMessage[], tokenizer: ContextTokenizer): number {
  return messages.reduce((total, message) => {
    const content = typeof message.content === "string"
      ? message.content
      : message.content.map((part) => part.type === "text" ? part.text : part.image_url.url).join(" ");
    const calls = message.role === "assistant" ? (message.toolCalls ?? []).reduce((sum, call) => sum + countTokens(tokenizer, `${call.id}${call.function.name}${call.function.arguments}`), 0) : 0;
    return total + countTokens(tokenizer, content) + calls + 1;
  }, 0);
}

export function classifyProviderMessageTokens(
  messages: readonly ProviderChatMessage[],
  tokenizer: ContextTokenizer,
): { transcript: number; memory: number; attachments: number } {
  return messages.reduce((used, message) => {
    const content = typeof message.content === "string"
      ? message.content
      : message.content.map((part) => part.type === "text" ? part.text : part.image_url.url).join(" ");
    const tokens = countTokens(tokenizer, content) + 1;
    if (content.includes("OPENBOT_UNTRUSTED_MEMORY_CONTEXT_BEGIN")) used.memory += tokens;
    else if (content.includes("OPENBOT_UNTRUSTED_ATTACHMENT_BEGIN")) used.attachments += tokens;
    else used.transcript += tokens;
    return used;
  }, { transcript: 0, memory: 0, attachments: 0 });
}

function isToolResult(message: ProviderChatMessage): message is Extract<ProviderChatMessage, { role: "tool" }> {
  return message.role === "tool";
}

const TOKEN_IMAGE_MARKER = "[image omitted by context token budget]";
const BYTE_IMAGE_MARKER = "[image omitted by context byte budget]";

function isMultimodalUser(message: ProviderChatMessage): message is Extract<ProviderChatMessage, { role: "user" }> {
  return message.role === "user" && Array.isArray(message.content);
}

function groupHasToolResult(group: readonly ProviderChatMessage[]): boolean {
  return group.some((message) => message.role === "tool");
}

function hasCompleteToolExchange(group: readonly ProviderChatMessage[]): boolean {
  const callIds = new Set(group.flatMap((message) => message.role === "assistant"
    ? (message.toolCalls ?? []).map((call) => call.id)
    : []));
  const resultIds = new Set(group.flatMap((message) => message.role === "tool" && message.toolCallId !== undefined
    ? [message.toolCallId]
    : []));
  return [...callIds].every((id) => resultIds.has(id)) && [...resultIds].every((id) => callIds.has(id));
}

function replaceOversizedImages(message: Extract<ProviderChatMessage, { role: "user" }>, marker: string): ProviderChatMessage {
  if (!Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((part) => part.type === "image_url" ? { type: "text" as const, text: marker } : part),
  };
}

function fitNewestGroupToTokenBudget(group: readonly ProviderChatMessage[], budgetTokens: number, tokenizer: ContextTokenizer): ProviderChatMessage[] {
  let candidate = group.map((message) => isMultimodalUser(message) ? replaceOversizedImages(message, TOKEN_IMAGE_MARKER) : message);
  if (countProviderMessageTokens(candidate, tokenizer) <= budgetTokens) return candidate;
  candidate = candidate.map((message) => message.role === "tool" && typeof message.content === "string"
    ? { ...message, content: truncateProviderText(message.content, Math.max(0, Math.floor(budgetTokens / 2)), tokenizer) }
    : message);
  if (countProviderMessageTokens(candidate, tokenizer) <= budgetTokens) return candidate;
  const prompt = candidate.find((message) => message.role === "user" && typeof message.content === "string");
  if (prompt?.role === "user" && typeof prompt.content === "string") {
    const promptBudget = Math.max(0, budgetTokens - countProviderMessageTokens(candidate.filter((message) => message !== prompt), tokenizer));
    candidate = candidate.map((message) => message === prompt && message.role === "user" && typeof message.content === "string"
      ? { ...message, content: truncateProviderText(message.content, promptBudget, tokenizer) }
      : message);
  }
  if (candidate.some((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0)
    && candidate.some((message) => message.role === "tool")) {
    return countProviderMessageTokens(candidate, tokenizer) <= budgetTokens ? candidate : [];
  }
  return countProviderMessageTokens(candidate, tokenizer) <= budgetTokens
    ? candidate
    : candidate.filter((message) => message.role === "user" && typeof message.content === "string").slice(0, 1);
}

/** Groups complete user turns, retaining assistant tool calls with their results. */
export function selectCompleteMessageGroups(messages: readonly ProviderChatMessage[], tokenizer: ContextTokenizer, budgetTokens: number): ProviderChatMessage[] {
  const groups: ProviderChatMessage[][] = [];
  for (const message of messages) {
    const current = groups.at(-1);
    const continuationImage = isMultimodalUser(message) && current !== undefined && groupHasToolResult(current);
    if ((message.role === "user" && !continuationImage) || groups.length === 0) groups.push([]);
    groups.at(-1)?.push(message);
  }
  const selected: ProviderChatMessage[][] = [];
  let used = 0;
  let omitted = false;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index] ?? [];
    if (!hasCompleteToolExchange(group)) {
      omitted = true;
      break;
    }
    const groupTokens = countProviderMessageTokens(group, tokenizer);
    if (selected.length > 0 && used + groupTokens > budgetTokens) {
      omitted = true;
      break;
    }
    if (selected.length === 0 && groupTokens > budgetTokens) {
      const fitted = fitNewestGroupToTokenBudget(group, Math.max(0, budgetTokens), tokenizer);
      if (fitted.length > 0) selected.unshift(fitted);
      omitted = index > 0 || fitted.length === 0;
      break;
    }
    selected.unshift(group);
    used += groupTokens;
  }
  let flattened = selected.flat();
  if (omitted) {
    const marker: ProviderChatMessage = { role: "system", content: HISTORY_OMISSION_MARKER };
    if (selected.length === 0) {
      flattened = [];
    } else {
      while (selected.length > 1 && countProviderMessageTokens([marker, ...selected.flat()], tokenizer) > budgetTokens) {
        selected.shift();
      }
      flattened = [marker, ...selected.flat()];
      if (countProviderMessageTokens(flattened, tokenizer) > budgetTokens && selected.length === 1) {
        const markerTokens = countProviderMessageTokens([marker], tokenizer);
        const fitted = fitNewestGroupToTokenBudget(selected[0] ?? [], Math.max(0, budgetTokens - markerTokens), tokenizer);
        flattened = fitted.length > 0 ? [marker, ...fitted] : [];
      }
    }
  }
  const callIds = new Set(flattened.flatMap((message) => message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.id) : []));
  return flattened.filter((message) => !isToolResult(message) || message.toolCallId === undefined || callIds.has(message.toolCallId));
}

export function truncateProviderText(text: string, budgetTokens: number, tokenizer: ContextTokenizer): string {
  if (budgetTokens <= 0) return "";
  if (tokenizer.count(text) <= budgetTokens) return text;
  const marker = text.includes("[[OPENBOT_UNTRUSTED_ATTACHMENT_BEGIN]]")
    ? `${ATTACHMENT_TRUNCATION_END}${MODEL_CONTEXT_TRUNCATION_MARKER}`
    : text.includes("[[OPENBOT_UNTRUSTED_TOOL_HISTORY_BEGIN]]")
      ? `${TOOL_OUTPUT_TRUNCATION_END}${MODEL_CONTEXT_TRUNCATION_MARKER}`
      : MODEL_CONTEXT_TRUNCATION_MARKER;
  let prefix = [...text].slice(0, Math.max(0, Math.floor(budgetTokens / 1.1))).join("");
  if (tokenizer.count(marker) > budgetTokens) return "";
  let result = `${prefix}${marker}`;
  while (tokenizer.count(result) > budgetTokens && prefix.length > 0) {
    prefix = prefix.slice(0, Math.floor(prefix.length / 2));
    result = `${prefix}${marker}`;
  }
  return result;
}
