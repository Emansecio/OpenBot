import type { ReasoningEffort } from "../shared/contracts.js";

export type OpenCodeGoProtocol = "responses" | "chat" | "messages";

export interface OpenCodeGoModelMetadata {
  protocol: OpenCodeGoProtocol;
  contextWindow: number;
  maxOutputTokens: number;
  supportsVision: boolean;
  /**
   * Esforços aceitos no wire por este modelo. Declarar só com evidência
   * verificada do relay — modelos "chat" sem declaração nunca recebem
   * `reasoning_effort`; modelos "messages" (Anthropic) nunca recebem.
   */
  supportedReasoningEfforts?: ReasoningEffort[];
}

export const OPENCODE_GO_MODEL_PREFIX = "opencode-go/" as const;

/** Infixo que marca modelos servidos pelo endpoint Zen (`/zen/v1`), não Go. */
export const OPENCODE_ZEN_PREFIX = "zen/" as const;

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

/**
 * Tier gratuito do OpenCode Zen (`/zen/v1`), verificado ao vivo: o endpoint
 * rejeita modelos free sem `x-opencode-session` (o adapter já envia esse
 * header em todo request). Modelos `*-free`/`big-pickle`/`contributor` só
 * existem no Zen; os limites não são publicados, então onde um irmão Go
 * existe seus valores são herdados e o resto fica conservador.
 */
export const OPENCODE_ZEN_MODELS: Readonly<Record<string, OpenCodeGoModelMetadata>> = {
  "big-pickle": { protocol: "chat", contextWindow: 131_072, maxOutputTokens: 16_384, supportsVision: false },
  "deepseek-v4-flash-free": { protocol: "chat", contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsVision: false },
  "ling-3.0-flash-fin-free": { protocol: "chat", contextWindow: 131_072, maxOutputTokens: 16_384, supportsVision: false },
  "mimo-v2.5-free": { protocol: "chat", contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsVision: true },
  "muse-spark-1.2-contributor-free": { protocol: "responses", contextWindow: 1_048_576, maxOutputTokens: 131_072, supportsVision: true },
  "muse-spark-1.3-contributor-free": { protocol: "responses", contextWindow: 1_048_576, maxOutputTokens: 131_072, supportsVision: true },
  "nemotron-3-ultra-free": { protocol: "chat", contextWindow: 262_144, maxOutputTokens: 16_384, supportsVision: false },
  "nemotron-3.5-lightning-free": { protocol: "chat", contextWindow: 262_144, maxOutputTokens: 16_384, supportsVision: false },
};

export function openCodeGoCatalogId(remoteId: string): string {
  return `${OPENCODE_GO_MODEL_PREFIX}${remoteId}`;
}

export function openCodeZenCatalogId(remoteId: string): string {
  return `${OPENCODE_GO_MODEL_PREFIX}${OPENCODE_ZEN_PREFIX}${remoteId}`;
}

/** True quando o id de catálogo é servido pelo endpoint Zen (`/zen/v1`). */
export function isOpenCodeZenModel(modelId: string): boolean {
  return modelId.startsWith(`${OPENCODE_GO_MODEL_PREFIX}${OPENCODE_ZEN_PREFIX}`);
}

export function openCodeGoRemoteId(modelId: string): string {
  let id = modelId.startsWith(OPENCODE_GO_MODEL_PREFIX) ? modelId.slice(OPENCODE_GO_MODEL_PREFIX.length) : modelId;
  if (id.startsWith(OPENCODE_ZEN_PREFIX)) id = id.slice(OPENCODE_ZEN_PREFIX.length);
  return id;
}

/** Metadata estática do modelo — por catalog id (`opencode-go/...`) ou id remoto. */
export function openCodeModelMetadata(modelId: string): OpenCodeGoModelMetadata | undefined {
  const remote = openCodeGoRemoteId(modelId);
  return (isOpenCodeZenModel(modelId) ? OPENCODE_ZEN_MODELS : OPENCODE_GO_MODELS)[remote];
}
