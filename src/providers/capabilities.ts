/**
 * Provider capability matrix: the fail-closed authority for what a
 * provider+model pair may do (streaming, tools, images, cancellation,
 * authentication, usage, reasoning).
 *
 * Unknown providers and unknown models resolve to the closed capability; there
 * is no optimistic inference by name or similarity.
 */
import { OPENCODE_GO_MODELS, OPENCODE_ZEN_MODELS, openCodeGoCatalogId, openCodeZenCatalogId } from "./opencode-go-models.js";

export type ProviderCapabilityCancellation = "abort-signal" | "none";
export type ProviderCapabilityAuthentication = "keystore-api-key" | "none";
export type ProviderCapabilityUsage = "stream-events" | "response-metadata" | "none";

export interface ProviderCapability {
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly images: boolean;
  readonly cancellation: ProviderCapabilityCancellation;
  readonly authentication: ProviderCapabilityAuthentication;
  readonly usage: ProviderCapabilityUsage;
  /** P2.4: true only when the adapter genuinely emits canonical reasoning events. Default false; core never infers reasoning from time/busy/loading. */
  readonly reasoning: boolean;
}

/** Fail-closed capability for unknown providers/models. */
export const CLOSED_CAPABILITY: ProviderCapability = {
  streaming: false,
  tools: false,
  images: false,
  cancellation: "none",
  authentication: "none",
  usage: "none",
  reasoning: false,
};

const STREAMING_API_KEY = { streaming: true, tools: true, cancellation: "abort-signal", authentication: "keystore-api-key", usage: "stream-events", reasoning: false } as const;

const KNOWN_CAPABILITIES: Record<string, Record<string, ProviderCapability>> = {
  openai: {
    "gpt-6-astra": { ...STREAMING_API_KEY, images: true },
    "gpt-6-sol": { ...STREAMING_API_KEY, images: true },
    "gpt-6-luna": { ...STREAMING_API_KEY, images: true },
    "gpt-5.6-luna": { ...STREAMING_API_KEY, images: true },
    "gpt-5.6-sol": { ...STREAMING_API_KEY, images: false },
    "gpt-5.6-terra": { ...STREAMING_API_KEY, images: false },
  },
  xai: {
    "grok-4.6": { ...STREAMING_API_KEY, images: true },
  },
  "opencode-go": Object.fromEntries([
    ...Object.keys(OPENCODE_GO_MODELS).map((id) => [openCodeGoCatalogId(id), OPENCODE_GO_MODELS[id]?.supportsVision === true]),
    ...Object.keys(OPENCODE_ZEN_MODELS).map((id) => [openCodeZenCatalogId(id), OPENCODE_ZEN_MODELS[id]?.supportsVision === true]),
  ].map(([catalogId, supportsVision]): [string, ProviderCapability] => [catalogId as string, { ...STREAMING_API_KEY, images: supportsVision === true }])),
  "openai-compat": {
    "openai-compatible": { ...STREAMING_API_KEY, images: false },
  },
};

/**
 * Test-only capability override seam. Only explicit provider+model pairs may
 * be patched (unknown pairs still fail closed); the patch is visible to the
 * resolver and is restored when the returned disposer runs. Used by P2.4
 * offline fixtures to exercise the reasoning protocol without ever claiming a
 * real provider supports it.
 */
const CAPABILITY_TEST_OVERRIDES = new Map<string, Partial<ProviderCapability>>();

export function overrideProviderCapability(provider: string, model: string, patch: Partial<ProviderCapability>): () => void {
  const key = provider + "\u0000" + model;
  const previous = CAPABILITY_TEST_OVERRIDES.get(key);
  const merged: Partial<ProviderCapability> = { ...previous, ...patch };
  if (merged.reasoning !== undefined) CAPABILITY_TEST_OVERRIDES.set(key, merged);
  else CAPABILITY_TEST_OVERRIDES.delete(key);
  return () => {
    if (previous === undefined) CAPABILITY_TEST_OVERRIDES.delete(key);
    else CAPABILITY_TEST_OVERRIDES.set(key, previous);
  };
}

/**
 * Resolves the capability for an exact provider+model pair. Fails closed for
 * unknown providers, unknown models and any pair without an explicit entry.
 */
export function resolveProviderCapabilities(provider: string, model?: string): ProviderCapability {
  if (typeof provider !== "string" || typeof model !== "string" || model.length === 0) return CLOSED_CAPABILITY;
  const byModel = KNOWN_CAPABILITIES[provider];
  if (byModel === undefined) return CLOSED_CAPABILITY;
  // OpenAI-compatible: o contrato chat.completions é o mesmo para qualquer
  // modelo servido pelo endpoint — a capacidade genérica cobre ids descobertos.
  const capability = byModel[model] ?? (provider === "openai-compat" ? byModel["openai-compatible"] : undefined);
  if (capability === undefined) return CLOSED_CAPABILITY;
  const override = CAPABILITY_TEST_OVERRIDES.get(provider + "\u0000" + model);
  return override === undefined ? capability : { ...capability, ...override };
}

/**
 * Capability for a model the provider listed for the current account but that
 * is not in the matrix yet (see ModelCatalogService). Same streaming/tool
 * contract as its provider's known models; images only when declared.
 */
export function discoveredModelCapability(images: boolean): ProviderCapability {
  return { ...STREAMING_API_KEY, images };
}

/** P2.3 image authority: exact pair must be known AND declare images. */
export function providerSupportsImages(provider: string, model: string): boolean {
  return resolveProviderCapabilities(provider, model).images;
}

/** P2.4 reasoning authority: exact pair must be known AND declare reasoning. */
export function providerSupportsReasoning(provider: string, model: string): boolean {
  return resolveProviderCapabilities(provider, model).reasoning;
}
