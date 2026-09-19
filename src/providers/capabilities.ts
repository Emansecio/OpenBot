/**
 * P2.5 — provider capability matrix and optional-provider registration boundary.
 *
 * The matrix is the fail-closed authority for what a provider+model pair may
 * do: streaming, tools, images, cancellation, authentication, usage and the
 * `resume` dimension (declared only; real checkpoint/resume is P2.6 and is
 * never advertised as `cursor`).
 *
 * Rules:
 *  - unknown providers and unknown models resolve to the closed capability
 *    (no optimistic inference by name or similarity);
 *  - optional providers (`openrouter`, `codex-cli`, `claude-code`) are
 *    registered ONLY when explicitly enabled, the configuration is valid, an
 *    opaque credential/session reference with an agent scope is present and
 *    the adapter is actually constructible;
 *  - registration is skipped (never partial) when any prerequisite is missing.
 */
import type { ProviderAdapter } from "./router.js";
import type { LocalExecutionBroker } from "../execution/broker.js";
import { OpenRouterAdapter, createCliProviderAdapter } from "./optional-adapters.js";
import { OPENCODE_GO_MODELS, OPENCODE_ZEN_MODELS, openCodeGoCatalogId, openCodeZenCatalogId } from "./opencode-go-models.js";

export type ProviderCapabilityCancellation = "abort-signal" | "process-tree" | "none";
export type ProviderCapabilityAuthentication = "keystore-api-key" | "external-cli-session" | "none";
export type ProviderCapabilityUsage = "stream-events" | "response-metadata" | "none";
export type ProviderCapabilityResume = "cursor" | "none";

export interface ProviderCapability {
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly images: boolean;
  readonly cancellation: ProviderCapabilityCancellation;
  readonly authentication: ProviderCapabilityAuthentication;
  readonly usage: ProviderCapabilityUsage;
  readonly resume: ProviderCapabilityResume;
  /** P2.4: true only when the adapter genuinely emits canonical reasoning events. Default false; core never infers reasoning from time/busy/loading. */
  readonly reasoning: boolean;
}

export const OPTIONAL_PROVIDER_NAMES = ["openrouter", "codex-cli", "claude-code"] as const;
export type OptionalProviderName = (typeof OPTIONAL_PROVIDER_NAMES)[number];

/** Fail-closed capability for unknown providers/models. */
export const CLOSED_CAPABILITY: ProviderCapability = {
  streaming: false,
  tools: false,
  images: false,
  cancellation: "none",
  authentication: "none",
  usage: "none",
  resume: "none",
  reasoning: false,
};

const KNOWN_CAPABILITIES: Record<string, Record<string, ProviderCapability>> = {
  openai: {
    "gpt-6-astra": { streaming: true, tools: true, images: true, cancellation: "abort-signal", authentication: "keystore-api-key", usage: "stream-events", resume: "none", reasoning: false },
    "gpt-5.6-luna": { streaming: true, tools: true, images: true, cancellation: "abort-signal", authentication: "keystore-api-key", usage: "stream-events", resume: "none", reasoning: false },
    "gpt-5.6-sol": { streaming: true, tools: true, images: false, cancellation: "abort-signal", authentication: "keystore-api-key", usage: "stream-events", resume: "none", reasoning: false },
    "gpt-5.6-terra": { streaming: true, tools: true, images: false, cancellation: "abort-signal", authentication: "keystore-api-key", usage: "stream-events", resume: "none", reasoning: false },
  },
  xai: {
    "grok-4.6": { streaming: true, tools: true, images: true, cancellation: "abort-signal", authentication: "keystore-api-key", usage: "stream-events", resume: "none", reasoning: false },
  },
  "opencode-go": Object.fromEntries([
    ...Object.keys(OPENCODE_GO_MODELS).map((id) => [openCodeGoCatalogId(id), OPENCODE_GO_MODELS[id]?.supportsVision === true]),
    ...Object.keys(OPENCODE_ZEN_MODELS).map((id) => [openCodeZenCatalogId(id), OPENCODE_ZEN_MODELS[id]?.supportsVision === true]),
  ].map(([catalogId, supportsVision]): [string, ProviderCapability] => [catalogId as string, {
    streaming: true,
    tools: true,
    images: supportsVision === true,
    cancellation: "abort-signal",
    authentication: "keystore-api-key",
    usage: "stream-events",
    resume: "none",
    reasoning: false,
  }])),
  "openai-compat": {
    "openai-compatible": { streaming: true, tools: true, images: false, cancellation: "abort-signal", authentication: "keystore-api-key", usage: "stream-events", resume: "none", reasoning: false },
  },
  openrouter: {
    // OpenRouter models are declared by the deployed catalog; capability is
    // never inferred. These are the deterministic offline fixtures.
    "openrouter-small": { streaming: true, tools: true, images: false, cancellation: "abort-signal", authentication: "keystore-api-key", usage: "stream-events", resume: "none", reasoning: false },
    "openrouter/auto": { streaming: true, tools: true, images: true, cancellation: "abort-signal", authentication: "keystore-api-key", usage: "stream-events", resume: "none", reasoning: false },
  },
  "codex-cli": {
    "codex-cli:default": { streaming: true, tools: true, images: false, cancellation: "process-tree", authentication: "external-cli-session", usage: "stream-events", resume: "none", reasoning: false },
  },
  "claude-code": {
    "claude-code:default": { streaming: true, tools: true, images: false, cancellation: "process-tree", authentication: "external-cli-session", usage: "stream-events", resume: "none", reasoning: false },
  },
};

/**
 * Test-only capability override seam. Only explicit provider+model pairs may
 * be patched (unknown pairs still fail closed); the patch is visible to the
 * resolver and is restored when the returned disposer runs. Used by P2.4/P2.6
 * offline fixtures to exercise the reasoning/resume protocol without ever
 * claiming a real provider supports it.
 */
const CAPABILITY_TEST_OVERRIDES = new Map<string, Partial<ProviderCapability>>();

export function overrideProviderCapability(provider: string, model: string, patch: Partial<ProviderCapability>): () => void {
  const key = provider + "\u0000" + model;
  const previous = CAPABILITY_TEST_OVERRIDES.get(key);
  const merged: Partial<ProviderCapability> = { ...previous, ...patch };
  if (merged.reasoning !== undefined || merged.resume !== undefined) CAPABILITY_TEST_OVERRIDES.set(key, merged);
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

/** True only when the exact pair is known and supports streaming. */
export function providerSupportsStreaming(provider: string, model: string): boolean {
  return resolveProviderCapabilities(provider, model).streaming;
}

/** P2.3 image authority: exact pair must be known AND declare images. */
export function providerSupportsImages(provider: string, model: string): boolean {
  return resolveProviderCapabilities(provider, model).images;
}

/** P2.4 reasoning authority: exact pair must be known AND declare reasoning. */
export function providerSupportsReasoning(provider: string, model: string): boolean {
  return resolveProviderCapabilities(provider, model).reasoning;
}

export interface OptionalProviderCredential {
  /** Opaque keystore reference — never a secret value. */
  readonly ref: string;
  /** Agent scope that owns the reference. */
  readonly scope: string;
}

export interface OptionalCliAdapterOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
}

export interface RegisterOptionalProvidersOptions {
  /** Provider registry (provider registry boundary). */
  registry: { register(adapter: ProviderAdapter): void };
  /** Explicitly enabled optional providers. */
  enabled?: readonly string[];
  /** Opaque credentials/session references per provider. */
  credentials?: Record<string, { scope: string; ref?: string }>;
  /** CLI execution requirements (broker + process definition). */
  execution?: Record<string, OptionalCliAdapterOptions & { executionBroker: Pick<LocalExecutionBroker, "execute"> }>;
  /** Per-provider extra adapter options (e.g., OpenRouter endpoint/referer). */
  adapterOptions?: Record<string, Record<string, unknown>>;
  /** Shared usage collector (optional). */
  usageCollector?: { record(usage: { inputTokens: number; outputTokens: number; totalTokens: number; provider: string; model: string }): void };
}

function validOpaqueRef(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/\s/u.test(value);
}

function validScope(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

/**
 * Registers exactly the explicitly enabled optional providers that are fully
 * valid. Returns the registered names. Never registers a partially configured
 * provider; unknown providers are ignored (fail-closed).
 */
export function registerOptionalProviders(options: RegisterOptionalProvidersOptions): string[] {
  const registered: string[] = [];
  const enabled = Array.isArray(options.enabled) ? options.enabled : [];
  const registry = options.registry;
  for (const provider of enabled) {
    if (!(OPTIONAL_PROVIDER_NAMES as readonly string[]).includes(provider)) continue;
    const credential = options.credentials?.[provider];
    if (credential === undefined || !validScope(credential.scope) || !validOpaqueRef(credential.ref)) continue;
    try {
      if (provider === "openrouter") {
        const adapter = new OpenRouterAdapter({
          agentId: credential.scope,
          credentialRef: credential.ref,
          ...(options.adapterOptions?.[provider] ?? {}),
        });
        registry.register(adapter);
        registered.push(provider);
        continue;
      }
      // CLI providers require the local execution broker — they never spawn.
      const cli = options.execution?.[provider];
      if (cli === undefined || cli.executionBroker === undefined) continue;
      const adapter = createCliProviderAdapter({
        provider,
        agentId: credential.scope,
        sessionRef: credential.ref,
        executionBroker: cli.executionBroker,
        executable: cli.executable,
        args: [...cli.args],
        cwd: cli.cwd,
        timeoutMs: cli.timeoutMs,
        usageCollector: options.usageCollector,
        ...(options.adapterOptions?.[provider] ?? {}),
      });
      registry.register(adapter);
      registered.push(provider);
    } catch {
      // Invalid configuration never produces a partial registration.
    }
  }
  return registered;
}
