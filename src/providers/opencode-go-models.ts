export type OpenCodeGoProtocol = "responses" | "chat" | "messages";

export interface OpenCodeGoModelMetadata {
  protocol: OpenCodeGoProtocol;
  contextWindow: number;
  maxOutputTokens: number;
  supportsVision: boolean;
}

export const OPENCODE_GO_MODEL_PREFIX = "opencode-go/" as const;

export const OPENCODE_GO_MODELS: Readonly<Record<string, OpenCodeGoModelMetadata>> = {
  "deepseek-v4-flash": { protocol: "chat", contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsVision: false },
  "deepseek-v4-flash-vision-exp": { protocol: "chat", contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsVision: true },
  "deepseek-v4-pro": { protocol: "chat", contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsVision: false },
  "glm-5.1": { protocol: "chat", contextWindow: 202_752, maxOutputTokens: 32_768, supportsVision: false },
  "glm-5.2": { protocol: "chat", contextWindow: 1_000_000, maxOutputTokens: 131_072, supportsVision: false },
  "glm-5.3": { protocol: "chat", contextWindow: 1_000_000, maxOutputTokens: 131_072, supportsVision: false },
  "glm-5.3-flash": { protocol: "chat", contextWindow: 1_000_000, maxOutputTokens: 131_072, supportsVision: true },
  "gpt-5.6-luna": { protocol: "responses", contextWindow: 1_050_000, maxOutputTokens: 128_000, supportsVision: true },
  "grok-4.6": { protocol: "responses", contextWindow: 500_000, maxOutputTokens: 500_000, supportsVision: true },
  hy3: { protocol: "chat", contextWindow: 256_000, maxOutputTokens: 64_000, supportsVision: false },
  "hy4-preview": { protocol: "chat", contextWindow: 1_024_000, maxOutputTokens: 64_000, supportsVision: false },
  "kimi-k2.6": { protocol: "chat", contextWindow: 262_144, maxOutputTokens: 65_536, supportsVision: true },
  "kimi-k2.7-code": { protocol: "chat", contextWindow: 262_144, maxOutputTokens: 262_144, supportsVision: true },
  "kimi-k3": { protocol: "chat", contextWindow: 1_048_576, maxOutputTokens: 131_072, supportsVision: true },
  "longcat-2.0": { protocol: "chat", contextWindow: 1_000_000, maxOutputTokens: 131_072, supportsVision: false },
  "mimo-v2.5": { protocol: "chat", contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsVision: true },
  "mimo-v2.5-pro": { protocol: "chat", contextWindow: 1_048_576, maxOutputTokens: 128_000, supportsVision: false },
  "minimax-m2.7": { protocol: "messages", contextWindow: 204_800, maxOutputTokens: 131_072, supportsVision: false },
  "minimax-m3": { protocol: "messages", contextWindow: 1_000_000, maxOutputTokens: 131_072, supportsVision: true },
  "muse-spark-1.2-contributor": { protocol: "responses", contextWindow: 1_048_576, maxOutputTokens: 131_072, supportsVision: true },
  "muse-spark-1.3-contributor": { protocol: "responses", contextWindow: 1_048_576, maxOutputTokens: 131_072, supportsVision: true },
  "muse-spark-1.3-contributor-free": { protocol: "responses", contextWindow: 1_048_576, maxOutputTokens: 131_072, supportsVision: true },
  "qwen3.6-plus": { protocol: "messages", contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsVision: true },
  "qwen3.7-max": { protocol: "messages", contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsVision: false },
  "qwen3.7-plus": { protocol: "messages", contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsVision: true },
  "qwen3.8-flash": { protocol: "messages", contextWindow: 1_000_000, maxOutputTokens: 131_072, supportsVision: true },
  "qwen3.8-max": { protocol: "messages", contextWindow: 1_000_000, maxOutputTokens: 131_072, supportsVision: true },
};

export function openCodeGoCatalogId(remoteId: string): string {
  return `${OPENCODE_GO_MODEL_PREFIX}${remoteId}`;
}

export function openCodeGoRemoteId(modelId: string): string {
  return modelId.startsWith(OPENCODE_GO_MODEL_PREFIX) ? modelId.slice(OPENCODE_GO_MODEL_PREFIX.length) : modelId;
}
