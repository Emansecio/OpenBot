import { createHash } from "node:crypto";
import { REASONING_EFFORTS, type ReasoningEffort } from "../shared/contracts.js";
import type { ProviderOAuthManager } from "./oauth.js";
import { CatalogDiscoveryError, validModelId, type CatalogSource, type DiscoveredModel } from "./model-catalog.js";
import { OPENCODE_GO_BASE_URL } from "./opencode-go.js";
import { openCodeGoCatalogId, openCodeGoRemoteId } from "./opencode-go-models.js";

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

export function createXaiCatalogSource(options: {
  oauth: Pick<ProviderOAuthManager, "resolveCredential" | "rejectCredential" | "catalogConnectionKey">;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): CatalogSource {
  return {
    connectionKey: () => options.oauth.catalogConnectionKey("xai"),
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
          return [{ ...information.get(model.id), ...model }];
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
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): CatalogSource {
  return {
    connectionKey: options.connectionKey,
    async discover(signal) {
      const payload = await readCatalog(options.fetchImpl ?? fetch, `${options.baseUrl ?? OPENCODE_GO_BASE_URL}/models`, signal);
      return parseDiscoveredModels(payload, "data").map(m => ({ ...m, id: openCodeGoCatalogId(openCodeGoRemoteId(m.id)) }));
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
