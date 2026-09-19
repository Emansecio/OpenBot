export interface ProviderUsage {
  /** Provider-reported totals; absent means unknown. Messages input excludes cache buckets. */
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

export function parseProviderUsage(value: unknown, protocol: "chat" | "responses" | "messages"): ProviderUsage | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const chat = protocol === "chat";
  const inputDetails = record(raw[chat ? "prompt_tokens_details" : "input_tokens_details"]);
  const outputDetails = record(raw[chat ? "completion_tokens_details" : "output_tokens_details"]);
  const fields: Record<keyof ProviderUsage, unknown> = {
    inputTokens: raw[chat ? "prompt_tokens" : "input_tokens"],
    outputTokens: raw[chat ? "completion_tokens" : "output_tokens"],
    totalTokens: raw.total_tokens,
    cachedInputTokens: protocol === "messages" ? raw.cache_read_input_tokens : inputDetails?.cached_tokens,
    cacheCreationInputTokens: raw.cache_creation_input_tokens,
    reasoningTokens: outputDetails?.reasoning_tokens,
  };
  const usage: ProviderUsage = {};
  for (const key of Object.keys(fields) as Array<keyof ProviderUsage>) {
    const count = fields[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) usage[key] = count;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}
