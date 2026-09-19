/**
 * Catálogo estático de modelos (Decisão §8.3 — lista estática local, sem rede).
 * Fase 1: modelo global único; default do produto mantido como `grok-*`.
 */

import type { ModelCatalogEntry } from "../shared/contracts.js";
import { OPENCODE_GO_MODELS, OPENCODE_ZEN_MODELS, openCodeGoCatalogId, openCodeZenCatalogId } from "../providers/opencode-go-models.js";

const MIB = 1024 * 1024;

const OPENCODE_GO_CATALOG: ModelCatalogEntry[] = Object.entries(OPENCODE_GO_MODELS).map(([id, metadata]) => ({
  id: openCodeGoCatalogId(id),
  provider: "opencode-go",
  displayName: id,
  description: "OpenCode Go",
  contextWindow: metadata.contextWindow,
  maxOutputTokens: metadata.maxOutputTokens,
  maxRequestBytes: 4 * MIB,
  tokenizerStrategy: "estimated",
  safetyMargin: 0.1,
  supportsVision: metadata.supportsVision,
  ...(metadata.supportedReasoningEfforts !== undefined ? { supportedReasoningEfforts: metadata.supportedReasoningEfforts } : {}),
}));

/** Tier gratuito do Zen — limites não publicados pelo endpoint, margem conservadora. */
const OPENCODE_ZEN_CATALOG: ModelCatalogEntry[] = Object.entries(OPENCODE_ZEN_MODELS).map(([id, metadata]) => ({
  id: openCodeZenCatalogId(id),
  provider: "opencode-go",
  displayName: `${id} (Zen free)`,
  description: "OpenCode Zen — gratuito",
  contextWindow: metadata.contextWindow,
  maxOutputTokens: metadata.maxOutputTokens,
  maxRequestBytes: 4 * MIB,
  tokenizerStrategy: "estimated",
  safetyMargin: 0.2,
  supportsVision: metadata.supportsVision,
  ...(metadata.supportedReasoningEfforts !== undefined ? { supportedReasoningEfforts: metadata.supportedReasoningEfforts } : {}),
}));

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  { id: "gpt-6-astra", provider: "openai", displayName: "GPT-6 Astra", description: "OpenAI", contextWindow: 272_000, maxOutputTokens: 16_384, maxRequestBytes: 2 * MIB, tokenizerStrategy: "estimated", safetyMargin: 0.1, supportsVision: true },
  { id: "grok-4.6", provider: "xai", displayName: "Grok 4.6", description: "Modelo default do produto", contextWindow: 500_000, maxOutputTokens: 32_768, maxRequestBytes: MIB, tokenizerStrategy: "estimated", safetyMargin: 0.1, supportsVision: true, supportedReasoningEfforts: ["low", "medium", "high", "xhigh"], default: true },
  { id: "gpt-5.6-luna", provider: "openai", displayName: "GPT-5.6 Luna", description: "OpenAI", contextWindow: 272_000, maxOutputTokens: 16_384, maxRequestBytes: 2 * MIB, tokenizerStrategy: "estimated", safetyMargin: 0.1, supportsVision: true },
  { id: "gpt-5.6-sol", provider: "openai", displayName: "GPT-5.6 Sol", description: "OpenAI", contextWindow: 272_000, maxOutputTokens: 16_384, maxRequestBytes: 2 * MIB, tokenizerStrategy: "estimated", safetyMargin: 0.1, supportsVision: true },
  { id: "gpt-5.6-terra", provider: "openai", displayName: "GPT-5.6 Terra", description: "OpenAI", contextWindow: 272_000, maxOutputTokens: 16_384, maxRequestBytes: 2 * MIB, tokenizerStrategy: "estimated", safetyMargin: 0.1, supportsVision: true },
  ...OPENCODE_GO_CATALOG,
  ...OPENCODE_ZEN_CATALOG,
  { id: "openai-compatible", provider: "openai-compat", displayName: "OpenAI-compatible", description: "Modelo configurado no endpoint custom", contextWindow: 128_000, maxOutputTokens: 16_384, maxRequestBytes: MIB, tokenizerStrategy: "estimated", safetyMargin: 0.2 },
];
