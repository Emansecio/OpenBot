import { createHash } from "node:crypto";
import { REASONING_EFFORTS, type ReasoningEffort } from "../shared/contracts.js";
import type { ProviderOAuthManager } from "./oauth.js";
import { CatalogDiscoveryError, validModelId, type CatalogSource, type DiscoveredModel } from "./model-catalog.js";
import { OPENCODE_GO_BASE_URL, OPENCODE_ZEN_BASE_URL } from "./opencode-go.js";
import { openCodeGoCatalogId, openCodeGoRemoteId, openCodeZenCatalogId } from "./opencode-go-models.js";
import { normalizeCompatBaseUrl } from "./compat-presets.js";
import { validateCompatBaseUrl } from "./openai-compat.js";

export function connectionFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function discoveryRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseDiscoveredModels(value: unknown, field: "data" | "models"): DiscoveredModel[] {
  const list = discoveryRecord(value)?.[field];
  if (!Array.isArray(list) || list.length > 2048) throw new CatalogDiscoveryError("O provedor retornou um catálogo inválido.");
  return list.map(item => {
    const model = discoveryRecord(item);
    const id = model?.id;
    if (!validModelId(id)) throw new CatalogDiscoveryError("O provedor retornou um modelo inválido.");
    return {
      id,
      ...(typeof model?.display_name === "string" ? { displayName: model.display_name } : {}),
      ...(Array.isArray(model?.aliases) ? { aliases: model.aliases.filter(validModelId) } : {}),
      ...(Array.isArray(model?.input_modalities) ? { inputModalities: model.input_modalities.filter((s): s is string => typeof s === "string") } : {}),
      ...(typeof model?.context_length === "number" ? { contextWindow: model.context_length } : {}),
    };
  });
}

async function readCatalog(fetchImpl: typeof fetch, url: string, signal: AbortSignal, token?: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "OpenBot/0.1.1", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal, redirect: "error",
  });
  if (!response.ok) throw new CatalogDiscoveryError(response.status === 401 || response.status === 403
    ? `Acesso ao catálogo recusado (HTTP ${response.status}). Revise a conexão do provedor.`
    : `Falha ao consultar o catálogo (HTTP ${response.status}).`);
  return response.json();
}

/**
 * Esforços de `reasoning_effort` verificados na API xAI (/v1/chat/completions).
 * Modelos sem entrada nunca recebem o parâmetro (fail-closed). A lista cobre
 * modelos de raciocínio documentados; "minimal" não existe na xAI e "none" não
 * é um ReasoningEffort do host.
 */
const XAI_MODEL_REASONING_EFFORTS: Readonly<Record<string, ReasoningEffort[]>> = {
  "grok-4.6": ["low", "medium", "high", "xhigh"],
  "grok-4.5": ["low", "medium", "high"],
  "grok-4.3": ["low", "medium", "high"],
  "grok-3-mini": ["low", "high"],
  "grok-3-mini-fast": ["low", "high"],
  "grok-3-mini-high": ["high"],
};

export function createXaiCatalogSource(options: {
  oauth: Pick<ProviderOAuthManager, "resolveCredential" | "rejectCredential" | "catalogConnectionKey" | "hasCredential">;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): CatalogSource {
  return {
    connectionKey: () => options.oauth.catalogConnectionKey("xai"),
    hasConnection: () => options.oauth.hasCredential("xai"),
    async discover(signal) {
      let credential;
      try { credential = await options.oauth.resolveCredential("xai"); }
      catch { throw new CatalogDiscoveryError("Conecte sua conta xAI para atualizar o catálogo."); }
      const base = options.baseUrl ?? "https://api.x.ai/v1";
      try {
        const [language, basic] = await Promise.all([
          readCatalog(options.fetchImpl ?? fetch, `${base}/language-models`, signal, credential.accessToken),
          readCatalog(options.fetchImpl ?? fetch, `${base}/models`, signal, credential.accessToken),
        ]);
        const information = new Map(parseDiscoveredModels(basic, "data").map(m => [m.id, m]));
        const languageModels = parseDiscoveredModels(language, "models");
        const rawModels = discoveryRecord(language)!.models as unknown[];
        return languageModels.flatMap((model, index) => {
          const output = discoveryRecord(rawModels[index])?.output_modalities;
          if (Array.isArray(output) && !output.includes("text")) return [];
          const efforts = XAI_MODEL_REASONING_EFFORTS[model.id];
          return [{ ...information.get(model.id), ...model, ...(efforts ? { supportedReasoningEfforts: [...efforts] } : {}) }];
        });
      } catch (error) {
        if (error instanceof CatalogDiscoveryError && error.message.includes("HTTP 401")) {
          await options.oauth.rejectCredential("xai", credential.accessToken);
        }
        throw error;
      }
    },
  };
}

export function createOpenCodeCatalogSource(options: {
  connectionKey: () => Promise<string>;
  hasConnection?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Endpoint Zen e ids declarados free — descobertos como `opencode-go/zen/<id>`. */
  zenBaseUrl?: string;
  zenRemoteIds?: readonly string[];
}): CatalogSource {
  return {
    connectionKey: options.connectionKey,
    ...(options.hasConnection !== undefined ? { hasConnection: options.hasConnection } : {}),
    async discover(signal) {
      const fetchImpl = options.fetchImpl ?? fetch;
      const payload = await readCatalog(fetchImpl, `${options.baseUrl ?? OPENCODE_GO_BASE_URL}/models`, signal);
      const models = parseDiscoveredModels(payload, "data").map(m => ({ ...m, id: openCodeGoCatalogId(openCodeGoRemoteId(m.id)) }));
      if (!options.zenRemoteIds?.length) return models;
      // Falha do tier Zen não pode derrubar a descoberta do Go.
      try {
        const wanted = new Set(options.zenRemoteIds);
        const zenPayload = await readCatalog(fetchImpl, `${options.zenBaseUrl ?? OPENCODE_ZEN_BASE_URL}/models`, signal);
        const zen = parseDiscoveredModels(zenPayload, "data")
          .filter(m => wanted.has(openCodeGoRemoteId(m.id)))
          .map(m => ({ ...m, id: openCodeZenCatalogId(openCodeGoRemoteId(m.id)) }));
        return [...models, ...zen];
      } catch {
        return models;
      }
    },
  };
}

export function codexCatalogPage(value: unknown): { models: DiscoveredModel[]; nextCursor?: string } {
  const page = discoveryRecord(value);
  if (!Array.isArray(page?.data) || page.data.length > 2048) throw new CatalogDiscoveryError("Codex retornou um catálogo incompatível.");
  const models = page.data.flatMap(item => {
    const row = discoveryRecord(item);
    if (row?.hidden === true) return [];
    const id = row?.model ?? row?.id;
    if (!validModelId(id)) throw new CatalogDiscoveryError("Codex retornou um modelo inválido.");
    const supportedReasoningEfforts = Array.isArray(row?.supportedReasoningEfforts)
      ? row.supportedReasoningEfforts.map(item => discoveryRecord(item)?.reasoningEffort)
        .filter((e): e is ReasoningEffort => (REASONING_EFFORTS as readonly unknown[]).includes(e)) : undefined;
    return [{
      id,
      serviceTiers: Array.isArray(row?.serviceTiers)
        ? row.serviceTiers.flatMap(tier => discoveryRecord(tier)?.id === "priority" ? ["priority" as const] : [])
        : Array.isArray(row?.additionalSpeedTiers) && row.additionalSpeedTiers.includes("fast") ? ["priority" as const] : [],
      ...(typeof row?.displayName === "string" ? { displayName: row.displayName } : {}),
      ...(Array.isArray(row?.inputModalities) ? { inputModalities: row.inputModalities.filter((s): s is string => typeof s === "string") } : {}),
      ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
      ...(typeof row?.defaultReasoningEffort === "string" && (REASONING_EFFORTS as readonly string[]).includes(row.defaultReasoningEffort)
        ? { defaultReasoningEffort: row.defaultReasoningEffort as ReasoningEffort } : {}),
    }];
  });
  if (page.nextCursor != null && (typeof page.nextCursor !== "string" || page.nextCursor.length > 4096)) throw new CatalogDiscoveryError("Paginação Codex inválida.");
  return { models, ...(typeof page.nextCursor === "string" && page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Interpreta a resposta de `GET {base}/models` de um endpoint
 * OpenAI-compatible. Campos de contexto variam por servidor — reconhece os
 * nomes usados por OpenRouter (`context_length`, `top_provider`), vLLM
 * (`max_model_len`), LM Studio (`context_length`, `max_loaded_models` não
 * aplica) e genéricos (`context_window`, `max_output_tokens`,
 * `max_completion_tokens`). Nada é inventado: campos ausentes ficam
 * ausentes e o catálogo aplica o fallback conservador.
 */
export function parseCompatModels(value: unknown): DiscoveredModel[] {
  const container = discoveryRecord(value);
  const rows = Array.isArray(value) ? value
    : Array.isArray(container?.data) ? container.data
    : Array.isArray(container?.models) ? container.models
    : undefined;
  if (!rows || rows.length > 2048) throw new CatalogDiscoveryError("O endpoint retornou um catálogo inválido.");
  const models = rows.flatMap(item => {
    const model = discoveryRecord(item);
    const rawId = model?.id ?? model?.model ?? model?.name;
    if (!validModelId(rawId)) return [];
    const provider = discoveryRecord(model?.top_provider);
    const contextWindow = positiveInt(model?.context_length)
      ?? positiveInt(model?.context_window)
      ?? positiveInt(model?.max_context_length)
      ?? positiveInt(model?.max_model_len)
      ?? positiveInt(model?.n_ctx)
      ?? positiveInt(provider?.context_length);
    const maxOutputTokens = positiveInt(model?.max_output_tokens)
      ?? positiveInt(model?.max_completion_tokens)
      ?? positiveInt(provider?.max_completion_tokens)
      ?? (contextWindow !== undefined ? Math.min(contextWindow, 16_384) : undefined);
    const modalities = Array.isArray(model?.input_modalities) ? model.input_modalities
      : Array.isArray(model?.modalities) ? model.modalities
      : Array.isArray(discoveryRecord(model?.architecture)?.input_modalities) ? discoveryRecord(model?.architecture)!.input_modalities as unknown[]
      : undefined;
    return [{
      id: rawId,
      ...(typeof model?.display_name === "string" ? { displayName: model.display_name }
        : typeof model?.name === "string" && model.name !== rawId ? { displayName: model.name } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined && contextWindow !== undefined
        ? { maxOutputTokens: Math.min(maxOutputTokens, contextWindow) } : {}),
      ...(contextWindow !== undefined
        ? { maxRequestBytes: Math.min(Math.max(contextWindow * 4, 1024 * 1024), 8 * 1024 * 1024) } : {}),
      ...(modalities !== undefined ? { inputModalities: modalities.filter((s): s is string => typeof s === "string") } : {}),
    }];
  });
  const seen = new Set<string>();
  return models.filter(model => seen.size < 2048 && !seen.has(model.id) && seen.add(model.id));
}

/**
 * Catálogo do provider openai-compat: `GET {baseUrl}/models` do endpoint
 * configurado pelo usuário. A baseUrl é lida dinamicamente (getter) porque o
 * usuário pode trocar o endpoint sem reiniciar; a identidade de conexão é o
 * hash de base normalizada + chave — nunca o segredo.
 */
export function createCompatCatalogSource(options: {
  baseUrl: () => string | null | undefined;
  apiKey?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
}): CatalogSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    connectionKey: async () => {
      const base = normalizeCompatBaseUrl(options.baseUrl() ?? "");
      const key = (await options.apiKey?.()) ?? "";
      return connectionFingerprint(`${base}|${key}`);
    },
    hasConnection: async () => {
      const base = options.baseUrl();
      return typeof base === "string" && base.trim().length > 0;
    },
    async discover(signal) {
      const base = options.baseUrl()?.trim();
      if (!base) throw new CatalogDiscoveryError("Endpoint OpenAI-compatible não configurado.");
      let url: URL;
      try {
        url = validateCompatBaseUrl(base).url;
      } catch {
        throw new CatalogDiscoveryError("Endpoint OpenAI-compatible inválido nas configurações.");
      }
      url.pathname = `${url.pathname.replace(/\/+$/u, "")}/models`;
      const token = await options.apiKey?.();
      const payload = await readCatalog(fetchImpl, url.toString(), signal, token);
      return parseCompatModels(payload);
    },
  };
}
