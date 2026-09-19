import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MODEL_CATALOG } from "../config/models.js";
import { REASONING_EFFORTS, type ModelCatalogEntry, type ReasoningEffort } from "../shared/contracts.js";
import { writeFileAtomicSync } from "../shared/fs-atomic.js";
import { resolveProviderCapabilities, type ProviderCapability } from "./capabilities.js";
import { resolveModelCapabilities } from "../memory/model-context.js";

export const CATALOG_PROVIDERS = ["openai", "xai", "opencode-go", "openai-compat"] as const;
export type CatalogProvider = typeof CATALOG_PROVIDERS[number];
export type ModelProtocol = "codex" | "chat" | "responses" | "messages";
export type ServiceTier = "default" | "priority";

export interface DiscoveredModel {
  serviceTiers?: ServiceTier[];
  id: string;
  displayName?: string;
  aliases?: string[];
  inputModalities?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  maxRequestBytes?: number;
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

/** Host-owned snapshot, retained with a turn so refreshes cannot change its contract. */
export interface ModelResolution {
  serviceTier?: ServiceTier;
  entry: ModelCatalogEntry;
  capabilities: ProviderCapability;
  supportedReasoningEfforts?: ReasoningEffort[];
  protocol: ModelProtocol;
}

export interface CatalogModel extends ModelCatalogEntry {
  serviceTiers?: ServiceTier[];
  selectable: boolean;
  availability: "listed" | "unverified" | "removed";
  reason?: string;
  aliases: string[];
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export interface ProviderModelCatalog {
  provider: CatalogProvider;
  state: "fresh" | "stale" | "unavailable" | "empty";
  source: "remote" | "cache" | "local";
  access: "public" | "connection";
  /** false quando a fonte reporta ausência de credencial/conexão utilizável. */
  connected?: boolean;
  updatedAt: number | null;
  error?: string;
  models: CatalogModel[];
}

export interface CatalogSource {
  /** Opaque connection fingerprint, never a token. Must not perform network I/O. */
  connectionKey(): Promise<string>;
  /** True quando há credencial/conexão utilizável. Sem I/O de rede — leitura local. */
  hasConnection?(): Promise<boolean>;
  discover(signal: AbortSignal): Promise<DiscoveredModel[]>;
}

interface SavedCatalog {
  version: 1;
  connection: string;
  updatedAt: number;
  models: DiscoveredModel[];
}
interface ProviderState {
  connection?: string;
  /** Resultado do último hasConnection() do source; undefined = desconhecido. */
  connected?: boolean;
  saved?: SavedCatalog;
  source: "remote" | "cache" | "local";
  error?: string;
  generation: number;
  pending?: Promise<ProviderModelCatalog>;
  controller?: AbortController;
}

export function isCatalogProvider(value: unknown): value is CatalogProvider {
  return typeof value === "string" && (CATALOG_PROVIDERS as readonly string[]).includes(value);
}

export function validModelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value);
}

function cleanModel(value: DiscoveredModel): DiscoveredModel {
  if (!value || !validModelId(value.id)) throw new Error("Catálogo contém um identificador inválido.");
  const text = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(s);
  return {
    id: value.id,
    ...(Array.isArray(value.serviceTiers) ? { serviceTiers: [...new Set(value.serviceTiers.filter(tier => tier === "priority" || tier === "default"))] } : {}),
    ...(text(value.displayName) ? { displayName: value.displayName } : {}),
    ...(Array.isArray(value.aliases) ? { aliases: [...new Set(value.aliases.filter(validModelId))].slice(0, 64) } : {}),
    ...(Array.isArray(value.inputModalities) ? { inputModalities: [...new Set(value.inputModalities.filter(text))].slice(0, 16) } : {}),
    ...(Number.isSafeInteger(value.contextWindow) && value.contextWindow! > 0 ? { contextWindow: value.contextWindow } : {}),
    ...(Number.isSafeInteger(value.maxOutputTokens) && value.maxOutputTokens! > 0 ? { maxOutputTokens: value.maxOutputTokens } : {}),
    ...(Number.isSafeInteger(value.maxRequestBytes) && value.maxRequestBytes! > 0 ? { maxRequestBytes: value.maxRequestBytes } : {}),
    ...(Array.isArray(value.supportedReasoningEfforts) ? { supportedReasoningEfforts: [...new Set(value.supportedReasoningEfforts.filter(e => REASONING_EFFORTS.includes(e)))] } : {}),
    ...(REASONING_EFFORTS.includes(value.defaultReasoningEffort!) ? { defaultReasoningEffort: value.defaultReasoningEffort } : {}),
  };
}

export class ModelCatalogService {
  private readonly states = new Map<CatalogProvider, ProviderState>();
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly options: {
    directory?: string;
    sources: Partial<Record<CatalogProvider, CatalogSource>>;
    technicalModels?: readonly ModelCatalogEntry[];
    resolveCapabilities?: (provider: string, model: string) => ProviderCapability;
    protocols?: Readonly<Record<string, ModelProtocol>>;
    now?: () => number;
    timeoutMs?: number;
  }) {
    this.now = options.now ?? Date.now;
    for (const provider of CATALOG_PROVIDERS) {
      const state: ProviderState = { source: "local", generation: 0 };
      if (options.directory) {
        try {
          const raw = JSON.parse(readFileSync(join(options.directory, `${provider}.json`), "utf8")) as SavedCatalog;
          if (raw.version === 1 && typeof raw.connection === "string" && /^[a-f0-9]{64}$/u.test(raw.connection)
            && Number.isSafeInteger(raw.updatedAt) && raw.updatedAt > 0 && raw.updatedAt <= this.now()
            && Array.isArray(raw.models) && raw.models.length <= 2048) {
            state.saved = { ...raw, models: raw.models.map(cleanModel) };
            state.source = "cache";
          }
        } catch { /* A missing or invalid cache cannot prevent opening the app. */ }
      }
      this.states.set(provider, state);
    }
  }

  private local(provider: string): ModelCatalogEntry[] {
    return (this.options.technicalModels ?? MODEL_CATALOG).filter(m => m.provider === provider);
  }

  private protocol(provider: string, id: string): ModelProtocol | undefined {
    return this.options.protocols?.[`${provider}:${id}`]
      ?? (provider === "openai" ? "codex"
        : provider === "xai" || provider === "openai-compat" ? "chat" : undefined);
  }

  private capability(provider: string, id: string): ProviderCapability {
    return (this.options.resolveCapabilities ?? resolveProviderCapabilities)(provider, id);
  }

  async synchronize(provider: CatalogProvider): Promise<void> {
    const state = this.states.get(provider)!;
    const source = this.options.sources[provider];
    if (!source) return;
    const generation = state.generation;
    const connection = await source.connectionKey();
    const connected = source.hasConnection === undefined ? true : await source.hasConnection.call(source);
    if (this.closed) return;
    if (state.generation !== generation) return this.synchronize(provider);
    if (!/^[a-f0-9]{64}$/u.test(connection)) throw new Error("Identidade de conexão inválida.");
    if (state.connection !== undefined && state.connection !== connection) this.invalidate(provider);
    state.connection = connection;
    state.connected = connected;
    if (state.saved && state.saved.connection !== connection) {
      state.saved = undefined;
      state.source = "local";
      this.removeSaved(provider);
    }
  }

  async initialize(): Promise<void> {
    await Promise.all(CATALOG_PROVIDERS.map(provider => this.synchronize(provider)));
  }

  peek(provider: CatalogProvider): ProviderModelCatalog {
    const state = this.states.get(provider)!;
    const saved = state.connection !== undefined && state.saved?.connection === state.connection ? state.saved : undefined;
    const discovered = new Map(saved?.models.map(m => [m.id, m]));
    const local = new Map(this.local(provider).map(m => [m.id, m]));
    const ids = new Set([...discovered.keys(), ...local.keys()]);
    const models = [...ids].map((id): CatalogModel => {
      const known = local.get(id);
      const remote = discovered.get(id);
      const removed = saved !== undefined && remote === undefined;
      const capability = this.capability(provider, id);
      const compatFallback = provider === "openai-compat" && !known
        ? local.get("openai-compatible")
        : undefined;
      const entry: ModelCatalogEntry = {
        ...(compatFallback ? { ...compatFallback, id, displayName: id } : known ?? { id, provider, displayName: id }),
        ...(remote?.displayName ? { displayName: remote.displayName } : {}),
        ...(remote?.contextWindow ? { contextWindow: remote.contextWindow } : {}),
        ...(remote?.maxOutputTokens ? { maxOutputTokens: remote.maxOutputTokens } : {}),
        ...(remote?.maxRequestBytes ? { maxRequestBytes: remote.maxRequestBytes } : {}),
        ...(remote?.inputModalities ? { supportsVision: capability.images && remote.inputModalities.includes("image") } : {}),
      };
      let reason: string | undefined;
      // `!known` só bloqueia quando o modelo também não veio do endpoint — um
      // id descoberto com limites + protocolo + capacidade resolvidos é
      // selecionável (é assim que modelos openai-compat entram no catálogo).
      if ((!known && remote === undefined) || !this.protocol(provider, id) || !capability.streaming || !capability.tools
        || !entry.contextWindow || !entry.maxOutputTokens) reason = "Suporte pendente: protocolo, limites ou capacidades não confirmados.";
      else {
        try { resolveModelCapabilities(entry); } catch { reason = "Suporte pendente: limites do modelo inconsistentes."; }
      }
      if (provider === "openai" && remote && !remote.supportedReasoningEfforts?.length) reason = "Suporte pendente: esforços de raciocínio incompatíveis.";
      if (removed) reason = "Modelo ausente do último catálogo recebido.";
      // Modelo já bloqueado + conta desconectada: a ação correta é reconectar,
      // não "atualizar catálogo". Seleção continua baseada em capability —
      // `resolve()` é usado para admissão de config e deve tolerar a conta
      // ainda não conectada.
      if (reason && state.connected === false) reason = "Conecte a conta do provedor para usar este modelo.";
      return {
        ...entry, selectable: !reason, availability: removed ? "removed" : remote ? "listed" : "unverified",
        ...(remote?.serviceTiers ? { serviceTiers: remote.serviceTiers } : {}),
        ...(reason ? { reason } : {}), aliases: remote?.aliases ?? [],
        ...(remote?.supportedReasoningEfforts ? { supportedReasoningEfforts: remote.supportedReasoningEfforts } : {}),
        ...(remote?.defaultReasoningEffort ? { defaultReasoningEffort: remote.defaultReasoningEffort } : {}),
      };
    });
    const fresh = saved !== undefined && this.now() - saved.updatedAt < 30_000 && !state.error && state.source === "remote";
    return structuredClone({
      provider, state: saved ? fresh ? saved.models.length ? "fresh" : "empty" : "stale" : "unavailable",
      source: saved ? state.source : "local", access: provider === "opencode-go" ? "public" : "connection",
      ...(state.connected !== undefined ? { connected: state.connected } : {}),
      updatedAt: saved?.updatedAt ?? null, ...(state.error ? { error: state.error } : {}), models,
    });
  }

  async get(provider: CatalogProvider, refresh = false): Promise<ProviderModelCatalog> {
    await this.synchronize(provider);
    if (this.closed) return this.peek(provider);
    const state = this.states.get(provider)!;
    if (state.pending) return state.pending;
    const snapshot = this.peek(provider);
    if (!refresh && (snapshot.state === "fresh" || snapshot.state === "empty")) return snapshot;
    const source = this.options.sources[provider];
    if (!source) { state.error = "Descoberta indisponível neste backend."; return this.peek(provider); }
    const generation = state.generation;
    const controller = new AbortController();
    state.controller = controller;
    const timeoutMs = this.options.timeoutMs ?? (provider === "openai" ? 15_000 : 10_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    state.pending = (async () => {
      try {
        const result = await new Promise<DiscoveredModel[]>((resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("Atualização do catálogo cancelada ou excedeu o tempo limite.")), { once: true });
          void source.discover(controller.signal).then(resolve, reject);
        });
        if (!Array.isArray(result) || result.length > 2048) throw new Error("Catálogo recebido é inválido.");
        const models = [...new Map(result.map(cleanModel).map(m => [m.id, m])).values()];
        await this.synchronize(provider);
        if (state.generation !== generation || this.closed) return this.peek(provider);
        const saved: SavedCatalog = { version: 1, connection: state.connection!, updatedAt: this.now(), models };
        this.persist(provider, saved);
        state.saved = saved;
        state.source = "remote";
        state.error = undefined;
      } catch (error) {
        if (state.generation === generation && !this.closed) {
          // Sources emit bounded host-authored errors, never response bodies or credentials.
          state.error = error instanceof CatalogDiscoveryError ? error.message
            : controller.signal.aborted ? "Atualização do catálogo cancelada ou excedeu o tempo limite."
              : "Não foi possível atualizar o catálogo. A última lista válida foi preservada.";
        }
      } finally {
        clearTimeout(timer);
        if (state.generation === generation) { state.pending = undefined; state.controller = undefined; }
      }
      return this.peek(provider);
    })();
    return state.pending;
  }

  available(): ModelCatalogEntry[] {
    return CATALOG_PROVIDERS.flatMap(p => this.peek(p).models.filter(m => m.selectable).map(model => {
      const { selectable: _selectable, availability: _availability, reason: _reason, aliases: _aliases,
        supportedReasoningEfforts: _efforts, defaultReasoningEffort: _defaultEffort, ...entry } = model;
      return entry;
    }));
  }

  find(model: string, provider?: string): ModelCatalogEntry | undefined {
    return this.available().find(m => m.id === model && (provider === undefined || m.provider === provider));
  }

  resolve(provider: string, model: string, effort?: ReasoningEffort, serviceTier?: ServiceTier): ModelResolution {
    if (!isCatalogProvider(provider)) throw new Error("Provedor fora do catálogo gerenciado.");
    const state = this.states.get(provider)!;
    let entry = this.peek(provider).models.find(m => m.id === model);
    if (entry === undefined && provider === "openai-compat" && state.saved === undefined) {
      // Endpoint nunca consultado: um id de modelo custom usa os limites
      // conservadores da entrada genérica (comportamento anterior à
      // descoberta). Com catálogo descoberto, o modelo precisa constar na
      // lista do endpoint.
      const generic = this.local("openai-compat").find(m => m.id === "openai-compatible");
      if (generic) entry = { ...generic, id: model, displayName: model, selectable: true, availability: "unverified", aliases: [] };
    }
    if (!entry?.selectable) throw new Error(entry?.reason ?? "Modelo não validado. Atualize o catálogo nas configurações.");
    if (serviceTier === "priority" && (provider !== "openai" || !entry.serviceTiers?.includes("priority"))) {
      throw new Error("Fast não confirmado para este modelo. Atualize o catálogo ou selecione Padrão.");
    }
    if (effort && entry.supportedReasoningEfforts && !entry.supportedReasoningEfforts.includes(effort)) {
      throw new Error("O esforço de raciocínio salvo não é suportado por este modelo. Revise as configurações.");
    }
    return structuredClone({ entry, ...(provider === "openai" && serviceTier ? { serviceTier } : {}), capabilities: { ...this.capability(provider, model), images: entry.supportsVision === true },
      protocol: this.protocol(provider, model)!, ...(entry.supportedReasoningEfforts ? { supportedReasoningEfforts: entry.supportedReasoningEfforts } : {}) });
  }

  invalidate(provider: CatalogProvider): void {
    const state = this.states.get(provider)!;
    state.generation++;
    state.controller?.abort();
    state.pending = undefined;
    state.controller = undefined;
    state.saved = undefined;
    state.source = "local";
    state.error = undefined;
    this.removeSaved(provider);
  }

  close(): void {
    this.closed = true;
    for (const state of this.states.values()) { state.generation++; state.controller?.abort(); }
  }

  private removeSaved(provider: CatalogProvider): void {
    if (this.options.directory) rmSync(join(this.options.directory, `${provider}.json`), { force: true });
  }

  private persist(provider: CatalogProvider, saved: SavedCatalog): void {
    if (!this.options.directory) return;
    writeFileAtomicSync(join(this.options.directory, `${provider}.json`), JSON.stringify(saved));
  }
}

export class CatalogDiscoveryError extends Error {}
