/**
 * T3 — Gateway HTTP+SSE do shim (plano §3 T3; spec §4.5).
 *
 * Superfície reproduzida do gateway original:
 *   GET  /api/events        SSE — heartbeat `:ping` a cada 15s, filtro ?channels=
 *   POST /api/<method>      RPC com tabela de rota EXPLÍCITA — método desconhecido → 404
 *                           (mesmo sendo POST, é "rota desconhecida", não método HTTP);
 *                           erro de handler → 500 {error}; payload inválido → 400 {error}
 *   GET  /health            {ok,pid,isBusy,activeAgentId,startedAt}
 *   POST /prepare-upgrade   ativa quiescência e informa os turnos em curso
 *   POST /shutdown          solicita shutdown gracioso após responder 202
 *   GET  /avatars/<id>      placeholder (SVG monograma; Content-Type image/svg+xml)
 *   POST /local-exec/execute → authenticated broker bridge
 *   POST /webauthn/ceremony  → authenticated native signer bridge
 *   GET  /                  → 404 {error:not-found}
 *
 * Guards:
 *   - CSRF: RPC e /prepare-upgrade exigem Host em loopback E,
 *     quando presente, Origin em loopback. Origin estranha → 403 {error:"csrf"}.
 *   - gzip: compressão para respostas JSON/text acima do limiar quando o cliente
 *     anuncia `accept-encoding: gzip` (Node cuida do flush do transform; quem
 *     dispara o `finish` do servidor é o res.end()).
 *
 * Roteador extensível: `registerHandler(method, fn)` — as mesas RPC de T10+
 * (chat/transcript/tools/settings) são plugadas aqui depois, sem tocar no
 * roteamento HTTP.
 *
 * Contratos (src/shared/contracts.ts): envelope RPC `{ok,value}`/`{ok:false,failure}`
 * e evento SSE `{channel,payload}` (heartbeat `:ping`, `retry:1000`).
 */

import http from "node:http";
import zlib from "node:zlib";

import type {
  RpcEnvelope,
  RpcEnvelopeFailure,
  SseEvent,
  TranscriptEventOrder,
} from "../shared/contracts.js";
import { tokenFromRequest } from "./auth.js";
import type { HealthResponse, PrepareUpgradeResponse } from "./types.js";

/** Intervalo do heartbeat do SSE (plano §3 T3: `:ping` a cada 15s). */
export const SSE_HEARTBEAT_MS = 15_000;
/** `retry:` enviado no início do stream SSE (fixture golden sse-events.json). */
export const SSE_RETRY_MS = 1000;
const SSE_MAX_PENDING_BYTES = 256 * 1024;
const SSE_MAX_CLIENTS = 32;
/** Limite por frame; oversized payloads recebem um resync compacto. */
export const SSE_MAX_FRAME_BYTES = 256 * 1024;
/** Aceita gzip para respostas com este tamanho ou maior. */
export const GZIP_MIN_BYTES = 1024;

export interface GatewayDeliveryReceipt {
  readonly accepted: boolean;
  readonly eligibleClients: number;
  readonly acceptedClients: number;
  readonly rejectedClients: number;
}

export interface GatewayTaskSnapshot {
  readonly agentId: string;
  readonly channel: "async-tasks" | "subagents";
  readonly epoch: string;
  readonly sequence: number;
  readonly items: readonly unknown[];
  readonly truncated?: boolean;
  /** Parent agent of the listed tasks; preserved on every snapshot frame. */
  readonly parentAgentId?: string;
}

export interface GatewayA2ASnapshot {
  readonly agentId: string;
  readonly epoch: string;
  readonly sequence: number;
  readonly items: readonly unknown[];
}

/** Authoritative transcript tail used only when an SSE client must resync. */
export interface GatewayTranscriptSnapshot {
  readonly agentId: string;
  readonly activeAgentId: string;
  readonly entries: readonly unknown[];
  readonly conversationId?: string;
}

/** Nomes de Host em loopback aceitos (CSRF; spec §4.5). */
const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "0:0:0:0:0:0:0:1",
]);

/**
 * Tabela explícita de métodos RPC do gateway (spec §4.5 / plano §3 T3).
 * A mesa de negócio de T10+ é registrada dinamicamente via registerHandler —
 * o `Map` daqui é apenas o conjunto "conhecido" usado para o 404 de método
 * desconhecido (o handler real pode estar ausente, ainda não plugado).
 */
export const RPC_METHOD_TABLE = new Set<string>([
  "sendPrompt",
  "resumePrompt",
  "searchTranscript",
  "addReaction",
  "removeReaction",
  "listReactions",
  "stageAttachment",
  "listStagedAttachments",
  "discardStagedAttachment",
  "commitStagedAttachments",
  "uploadAttachment",
  "promptAcceptanceStatus",
  "listAgents",
  "createAgent",
  "deleteAgents",
  "duplicateAgent",
  "openAgent",
  "kickstartAgent",
  "getAgent",
  "getAgentTranscriptTail",
  "openAgentTail",
  "getConversationOutline",
  "getMemorySettings",
  "setMemorySettings",
  "listMemories",
  "listMemoriesPage",
  "updateMemory",
  "deleteMemory",
  "getMemoryStatus",
  "searchMemoryHistory",
  "createConversation",
  "listConversations",
  "activateConversation",
  "renameConversation",
  "archiveConversation",
  "deleteConversation",
  "getActiveConversation",
  "getAgentWorkflows",
  "getAvailableSkills",
  "refreshSkills",
  "listMcpServers",
  "listMcpTools",
  "refreshMcp",
  "setAgentIntegrationPolicy",
  "upsertMcpServer",
  "removeMcpServer",
  "setMcpSecret",
  "getSubagents",
  "getAsyncTasks",
  "listAsyncTasks",
  "getAsyncTask",
  "dispatchAsyncTask",
  "steerAsyncTask",
  "abortAsyncTask",
  "settleAsyncTask",
  "sendAgentMessage",
  "listAgentMessages",
  "getAgentMessage",
  "ackAgentMessage",
  "getAvailableModels", "getProviderModelCatalog",
  "getAgentDefaultModel",
  "setAgentDefaultModel",
  "countAgents",
  "searchAgents",
  "getLocalProfile",
  "updateLocalProfile",
  "updateAgent",
  "setAgentAvatarBytes",
  "getAgentAvatar",
  "getActiveProvider",
  "setActiveProvider",
  "getProviderConfig",
  "setProviderConfig",
  "getForeverBoxStatus",
  "getLocalRuntimeStatus",
  "repairLocalRuntime",
  "ensureForeverBox",
  "handBackForeverBox",
  "isAgentNetworkEnabled",
  "isGlobalSearchEnabled",
  "isEgressTunnelAvailable",
  "getComputerCapabilities",
  "transcribeAudio",
  "getHostSettings",
  "setHostSettings",
  "respondToWidget",
  "dismissWidget",
  "submitSecret",
  "resolveLocalToolPermission",
  "resolveAutoReviewApproval",
  "setBoxSecrets",
  "getBoxSecretsStatus",
  "reactToMessage",
  "setAgentUnread",
  "setAgentHiddenFromSidebar",
  "setAgentNotificationsEnabled",
  "setAgentNotifyOnUpdates",
  "setAgentRuntimeMode",
  "listQuarantinedAgents",
  "restoreAgentHome",
  "exportAgentHome",
  "importAgentHome",
  "getWorkspaceInventory",
  "repairAgentHome",
  "cancelPrompt",
  "abortPrompt",
  "retryPrompt",
  "getPromptStatus",
  "discoverLocalProviders",
  "testProviderConnection",
  "startProviderOAuth",
  "getProviderOAuthStatus",
  "cancelProviderOAuth",
  "disconnectProviderOAuth",
]);

/** Reads/status remain available during shutdown; cancellation can reduce drain work. */
export const QUIESCENCE_ALLOWED_RPC_METHODS = new Set<string>([
  "promptAcceptanceStatus", "listAgents", "getAgent", "getAgentTranscriptTail", "openAgentTail",
  "getConversationOutline", "getMemorySettings", "listMemories", "listMemoriesPage", "getMemoryStatus", "searchMemoryHistory",
  "listConversations", "getActiveConversation", "getAgentWorkflows", "getAvailableSkills",
  "listMcpServers", "listMcpTools", "getSubagents", "getAsyncTasks", "listAsyncTasks", "getAsyncTask", "dispatchAsyncTask", "steerAsyncTask", "abortAsyncTask", "settleAsyncTask", "getAvailableModels", "getProviderModelCatalog",
  "getAgentDefaultModel", "countAgents", "searchAgents", "getLocalProfile", "getActiveProvider",
  "getProviderConfig", "getForeverBoxStatus", "getLocalRuntimeStatus",
  "isAgentNetworkEnabled", "isGlobalSearchEnabled", "isEgressTunnelAvailable", "getComputerCapabilities",
  "getHostSettings", "getBoxSecretsStatus", "listQuarantinedAgents", "getWorkspaceInventory",
  "getPromptStatus", "getAgentAvatar", "discoverLocalProviders", "getProviderOAuthStatus", "cancelProviderOAuth", "cancelPrompt", "abortPrompt",
]);

export interface GatewayDeps {
  /** Busy-state do gateway; undefined = nenhum turno em curso (T3 default). */
  getStatus?: () => { isBusy: boolean; activeAgentId: string | null; busyAgentIds?: string[]; runningTurns?: number };
}

export interface GatewayOptions {
  /** Marca de tempo do boot (String ISO). Default: momento da criação. */
  startedAt?: string;
  /** Canais SSE habilitados para o stream /api/events (T10+). */
  sseChannels?: ReadonlySet<string>;
  /** Intervalo do heartbeat `:ping` (ms). Default: SSE_HEARTBEAT_MS (15s). */
  sseHeartbeatMs?: number;
  /** Se definido, RPC e SSE exigem Bearer / x-openbot-token / ?token=. */
  gatewayToken?: string;
  /** Authenticated bridge for the structured local execution broker. */
  localExecHandler?: GatewayBridgeHandler;
  /** Authenticated bridge for the native WebAuthn signer. */
  webauthnHandler?: GatewayBridgeHandler;
  /** Schedules the owning server teardown after a successful /shutdown response. */
  shutdownHandler?: () => void | Promise<void>;
  taskSnapshot?: (agentId: string, channel: "async-tasks" | "subagents") => GatewayTaskSnapshot | null;
  a2aSnapshot?: (agentId: string) => GatewayA2ASnapshot | null;
  transcriptSnapshot?: (agentId: string) => GatewayTranscriptSnapshot | null;
}

export type GatewayBridgeHandler = (path: string, body: unknown) => unknown | Promise<unknown>;

interface HandlerContext {
  /** Consulta ativa do turno (T10+). Null no T3. */
  getStatus: () => { isBusy: boolean; activeAgentId: string | null; busyAgentIds?: string[]; runningTurns?: number };
  /** Publica um evento SSE em todos os streams ativos do canal. */
  publish: (channel: string, payload: unknown) => void;
  /** Método RPC sendo invocado (útil para dispatch de mesa em T10+). */
  method: string;
}

export type RpcHandler = (
  body: unknown,
  ctx: HandlerContext,
) => unknown | Promise<unknown>;

interface SseClient {
  res: http.ServerResponse;
  /** null = sem filtro (recebe todos os canais); Set = só os listados. */
  channels: ReadonlySet<string> | null;
  agentId: string | null;
  blocked: boolean;
  pending: string[];
  pendingBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resyncPayload(channel: string, payload: unknown, reason = "frame-too-large"): Record<string, unknown> {
  const source = isRecord(payload) ? payload : undefined;
  const agentId = typeof source?.agentId === "string" ? source.agentId : undefined;
  return {
    type: "resync",
    channel,
    reason,
    resyncRequired: true,
    ...(agentId === undefined ? {} : { agentId }),
    ...(channel === "transcript" ? { method: "openAgentTail" } : {}),
    ...((channel === "async-tasks" || channel === "subagents") ? { method: "listAsyncTasks" } : {}),
    ...(channel === "a2a" ? { method: "listAgentMessages" } : {}),
  };
}

function transcriptEventId(order: TranscriptEventOrder): string {
  // URI encoding keeps replica keys containing ':' unambiguous in Last-Event-ID.
  return `transcript:${encodeURIComponent(order.replicaKey)}:${encodeURIComponent(order.epoch)}:${order.sequence}`;
}

function parseTranscriptEventId(value: string | undefined): TranscriptEventOrder | null {
  if (value === undefined) return null;
  const match = /^transcript:([^:]+):([^:]+):(0|[1-9][0-9]*)$/u.exec(value.trim());
  if (match === null) return null;
  const sequence = Number(match[3]);
  if (!Number.isSafeInteger(sequence)) return null;
  try {
    return { replicaKey: decodeURIComponent(match[1]!), epoch: decodeURIComponent(match[2]!), sequence };
  } catch {
    return null;
  }
}

function parseProjectionCursor(value: string | undefined): { channel?: "async-tasks" | "subagents" | "a2a"; epoch: string; sequence: number } | null {
  if (value === undefined) return null;
  const match = /^(?:(?<channel>async-tasks|subagents|a2a):)?(?<epoch>[A-Za-z0-9_-]{1,128}):(?<sequence>0|[1-9][0-9]*)$/u.exec(value.trim());
  if (match?.groups === undefined) return null;
  const sequence = Number(match.groups.sequence);
  return Number.isSafeInteger(sequence)
    ? { ...(match.groups.channel === undefined ? {} : { channel: match.groups.channel as "async-tasks" | "subagents" | "a2a" }), epoch: match.groups.epoch!, sequence }
    : null;
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const value = hostHeader.trim().toLowerCase();
  let name: string;
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]");
    if (closingBracket < 0) return false;
    const suffix = value.slice(closingBracket + 1);
    if (suffix !== "" && !/^:\d+$/.test(suffix)) return false;
    name = value.slice(1, closingBracket);
  } else if (value.includes(":")) {
    // Um único `:` separa a porta; vários pertencem a um IPv6 sem colchetes.
    name = value.indexOf(":") === value.lastIndexOf(":")
      ? value.slice(0, value.lastIndexOf(":"))
      : value;
  } else {
    name = value;
  }
  return LOOPBACK_HOSTS.has(name);
}

function isLoopbackOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return false;
  try {
    const u = new URL(originHeader);
    return isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

function isSseRequest(req: http.IncomingMessage): boolean {
  const accept = req.headers.accept ?? "";
  return accept.toLowerCase().includes("text/event-stream");
}

function acceptsGzip(header: string | string[] | undefined): boolean {
  const values = Array.isArray(header) ? header : [header ?? ""];
  let gzipQuality: number | undefined;
  let wildcardQuality: number | undefined;
  for (const item of values.flatMap((value) => value.split(","))) {
    const [rawCoding, ...parameters] = item.split(";");
    const coding = rawCoding?.trim().toLowerCase();
    if (coding !== "gzip" && coding !== "*") continue;
    const qualityParameter = parameters.find((parameter) => parameter.trim().toLowerCase().startsWith("q="));
    const parsed = qualityParameter === undefined
      ? 1
      : Number(qualityParameter.trim().slice(2));
    const quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    if (coding === "gzip") gzipQuality = quality;
    else wildcardQuality = quality;
  }
  return (gzipQuality ?? wildcardQuality ?? 0) > 0;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(payload);
}

class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413, message: string) {
    super(message);
    this.name = "RequestBodyError";
  }
}

/** Erro de RPC — vira `{error: <mensagem>}` com status informado pelo handler. */
export class RpcError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.status = status;
  }
}

export class Gateway {
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly sseClients = new Set<SseClient>();
  private readonly startedAt: string;
  private readonly sseChannels: ReadonlySet<string>;
  private readonly sseHeartbeatMs: number;
  private readonly gatewayToken: string;
  private readonly localExecHandler?: GatewayBridgeHandler;
  private readonly webauthnHandler?: GatewayBridgeHandler;
  private readonly shutdownHandler?: () => void | Promise<void>;
  private taskSnapshot?: GatewayOptions["taskSnapshot"];
  private a2aSnapshot?: GatewayOptions["a2aSnapshot"];
  private transcriptSnapshot?: GatewayOptions["transcriptSnapshot"];
  private readonly deps: Required<Pick<GatewayDeps, "getStatus">>;
  private readonly state: { quiescing: boolean };
  private shutdownScheduled = false;
  private shutdownCallbackScheduled = false;

  constructor(opts: GatewayOptions = {}, deps: GatewayDeps = {}) {
    this.startedAt = opts.startedAt ?? new Date().toISOString();
    this.sseChannels = opts.sseChannels ?? new Set<string>();
    this.sseHeartbeatMs = opts.sseHeartbeatMs ?? SSE_HEARTBEAT_MS;
    this.gatewayToken = opts.gatewayToken ?? "";
    this.localExecHandler = opts.localExecHandler;
    this.webauthnHandler = opts.webauthnHandler;
    this.shutdownHandler = opts.shutdownHandler;
    this.taskSnapshot = opts.taskSnapshot;
    this.a2aSnapshot = opts.a2aSnapshot;
    this.transcriptSnapshot = opts.transcriptSnapshot;
    this.deps = {
      getStatus: deps.getStatus ?? (() => ({ isBusy: false, activeAgentId: null })),
    };
    this.state = { quiescing: false };
  }

  /**
   * Registra um handler RPC. Assinatura = contrato do dispatch de T10+:
   * `(body: unknown, ctx) => unknown`. Erros `RpcError` viram o status/body
   * pedidos; qualquer outro erro → 500 {error}.
   */
  registerHandler(method: string, fn: RpcHandler): void {
    this.handlers.set(method, fn);
  }

  setTaskSnapshotProvider(provider: GatewayOptions["taskSnapshot"]): void {
    this.taskSnapshot = provider;
  }

  setA2ASnapshotProvider(provider: GatewayOptions["a2aSnapshot"]): void {
    this.a2aSnapshot = provider;
  }

  setTranscriptSnapshotProvider(provider: GatewayOptions["transcriptSnapshot"]): void {
    this.transcriptSnapshot = provider;
  }

  /**
   * Publica um evento SSE {channel,payload} (contrato SseEvent) em todos os
   * streams ativos — usado pelas mesas RPC de T10+ para emitir snapshot/appended.
   */
  publish(channel: string, payload: unknown): GatewayDeliveryReceipt {
    const clients = [...this.sseClients].filter(
      (client) => {
        if (client.res.destroyed || (client.channels !== null && !client.channels.has(channel))) return false;
        if ((channel === "transcript" || channel === "reasoning") && client.agentId !== null) {
          return isRecord(payload) && payload.agentId === client.agentId;
        }
        if (channel !== "async-tasks" && channel !== "subagents" && channel !== "a2a") return true;
        return client.agentId !== null && isRecord(payload) && payload.agentId === client.agentId;
      },
    );
    // Evita inclusive executar toJSON de payloads caros quando ninguém ouvirá.
    if (clients.length === 0) return { accepted: false, eligibleClients: 0, acceptedClients: 0, rejectedClients: 0 };
    const source = isRecord(payload) ? payload : undefined;
    const eventId = channel === "transcript" && isRecord(source?.ordered)
      && typeof source.ordered.replicaKey === "string"
      && typeof source.ordered.epoch === "string"
      && typeof source.ordered.sequence === "number"
      ? transcriptEventId(source.ordered as unknown as TranscriptEventOrder)
      : typeof source?.epoch === "string" && typeof source.sequence === "number" && (channel === "async-tasks" || channel === "subagents" || channel === "a2a" || channel === "reasoning")
        ? `${channel}:${source.epoch}:${source.sequence}`
        : undefined;
    let frame = `${eventId === undefined ? "" : `id: ${eventId}\n`}data: ${JSON.stringify({ channel, payload } satisfies SseEvent)}\n\n`;
    let oversized = false;
    if (Buffer.byteLength(frame) > SSE_MAX_FRAME_BYTES) {
      oversized = true;
      // Um snapshot inteiro pode ser muito maior que o limite do transporte.
      // Mantenha a conexão viva e dê ao cliente uma instrução explícita para
      // refazer a leitura paginada, sem jamais escrever o frame original.
      frame = `${eventId === undefined ? "" : `id: ${eventId}\n`}data: ${JSON.stringify({
        channel,
        payload: resyncPayload(channel, payload),
      } satisfies SseEvent)}\n\n`;
      if (Buffer.byteLength(frame) > SSE_MAX_FRAME_BYTES) return { accepted: false, eligibleClients: clients.length, acceptedClients: 0, rejectedClients: clients.length };
    }
    const overflowFrame = `data: ${JSON.stringify({
      channel,
      payload: resyncPayload(channel, payload, "backpressure"),
    } satisfies SseEvent)}\n\n`;
    let acceptedClients = 0;
    for (const client of clients) if (this.writeSse(client, frame, false, overflowFrame)) acceptedClients += 1;
    return { accepted: !oversized && acceptedClients === clients.length && clients.length > 0, eligibleClients: clients.length, acceptedClients: oversized ? 0 : acceptedClients, rejectedClients: oversized ? clients.length : clients.length - acceptedClients };
  }

  private writeSse(client: SseClient, frame: string, heartbeat = false, overflowFrame?: string): boolean {
    if (client.res.destroyed) return false;
    const bytes = Buffer.byteLength(frame);
    if (bytes > SSE_MAX_FRAME_BYTES) return false;
    if (!client.blocked) {
      client.blocked = !client.res.write(frame);
      return !client.blocked;
    }
    if (heartbeat) return false;
    if (client.pendingBytes + bytes > SSE_MAX_PENDING_BYTES) {
      if (overflowFrame === undefined || Buffer.byteLength(overflowFrame) > SSE_MAX_PENDING_BYTES) return false;
      client.pending = [overflowFrame];
      client.pendingBytes = Buffer.byteLength(overflowFrame);
      return false;
    }
    client.pending.push(frame);
    client.pendingBytes += bytes;
    return false;
  }

  private flushSse(client: SseClient): void {
    client.blocked = false;
    while (!client.blocked && client.pending.length > 0 && !client.res.destroyed) {
      const frame = client.pending.shift()!;
      client.pendingBytes -= Buffer.byteLength(frame);
      client.blocked = !client.res.write(frame);
    }
  }

  /** Atualiza a fonte do estado exposto por `/health` (usado pelo runner RPC). */
  setStatusProvider(getStatus: GatewayDeps["getStatus"]): void {
    this.deps.getStatus = getStatus ?? (() => ({ isBusy: false, activeAgentId: null }));
  }

  /** Stops admission of mutating RPCs; safe to call repeatedly from any shutdown path. */
  beginQuiescence(): void {
    this.state.quiescing = true;
  }

  /** Reverts a quiescence started by a shutdown that failed; allows retry. */
  cancelQuiescence(): void {
    this.state.quiescing = false;
    this.shutdownScheduled = false;
    this.shutdownCallbackScheduled = false;
  }

  /** Handlers RPC registrados (para o main reutilizar em T10+). */
  listHandlers(): ReadonlyMap<string, RpcHandler> {
    return this.handlers;
  }

  /** Trusted in-process dispatch used by first-party tools without an HTTP self-call. */
  async invokeRegisteredHandler(method: string, body: unknown): Promise<unknown> {
    if (!RPC_METHOD_TABLE.has(method)) throw new RpcError(404, `unknown method: ${method}`);
    if (this.state.quiescing && !QUIESCENCE_ALLOWED_RPC_METHODS.has(method)) {
      throw new RpcError(503, "gateway quiescing");
    }
    const handler = this.handlers.get(method);
    if (handler === undefined) throw new RpcError(503, `method not wired: ${method}`);
    return handler(body, {
      getStatus: this.deps.getStatus,
      publish: (channel, payload) => this.publish(channel, payload),
      method,
    });
  }

  /** Constrói o listener HTTP completo do gateway. */
  createHandler(): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    return (req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: "internal-error" });
        } else if (!res.writableEnded) {
          res.destroy();
        }
      });
    };
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1:1340");
    const method = (req.method ?? "GET").toUpperCase();
    const path = url.pathname;

    if (method === "GET" && (path === "/events" || path === "/api/events")) {
      if (!this.tokenGuard(req, res, url.searchParams.get("token"))) return;
      this.handleSse(req, res, url);
      return;
    }
    if (method === "GET" && path === "/health") {
      this.handleHealth(res);
      return;
    }
    if (method === "POST" && path === "/prepare-upgrade") {
      if (!this.csrfGuard(req, res)) return;
      if (!this.tokenGuard(req, res)) return;
      this.handlePrepareUpgrade(res);
      return;
    }
    if (method === "GET" && path.startsWith("/avatars/")) {
      this.handleAvatar(path, res);
      return;
    }
    const bridge = path.startsWith("/local-exec/")
      ? this.localExecHandler
      : path.startsWith("/webauthn/")
        ? this.webauthnHandler
        : undefined;
    if (bridge !== undefined || path.startsWith("/local-exec/") || path.startsWith("/webauthn/")) {
      if (method !== "POST") {
        sendJson(res, 405, { error: "method-not-allowed" });
        return;
      }
      if (!this.csrfGuard(req, res)) return;
      if (!this.tokenGuard(req, res)) return;
      if (bridge === undefined) {
        sendJson(res, 501, { error: "not-implemented" });
        return;
      }
      let body: unknown;
      try {
        body = (await this.readJsonBody(req)) ?? {};
      } catch (err) {
        const message = err instanceof Error ? err.message : "invalid-json";
        const status = err instanceof RequestBodyError ? err.status : 400;
        sendJson(res, status, { error: status === 413 ? "payload-too-large" : "invalid-json: " + message });
        return;
      }
      try {
        this.sendJsonMaybeGzip(res, 200, { ok: true, value: await bridge(path, body) });
      } catch (err) {
        const status = err instanceof RpcError ? err.status : 500;
        this.sendJsonMaybeGzip(res, status, { ok: false, failure: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (path === "/shutdown") {
      if (method !== "POST") {
        sendJson(res, 405, { error: "method-not-allowed" });
        return;
      }
      if (!this.csrfGuard(req, res)) return;
      if (!this.tokenGuard(req, res)) return;
      this.handleShutdown(res);
      return;
    }
    if (method === "POST" && path.startsWith("/api/")) {
      if (!this.csrfGuard(req, res)) return;
      if (!this.tokenGuard(req, res)) return;
      await this.handleRpc(req, res, path);
      return;
    }

    sendJson(res, 404, { error: "not-found" });
  }

  private handleHealth(res: http.ServerResponse): void {
    const { isBusy, activeAgentId, busyAgentIds } = this.deps.getStatus();
    const body: HealthResponse = {
      ok: true,
      pid: process.pid,
      isBusy,
      activeAgentId: activeAgentId ?? null,
      busyAgentIds: busyAgentIds ?? [],
      startedAt: this.startedAt,
    };
    sendJson(res, 200, body);
  }

  private handlePrepareUpgrade(res: http.ServerResponse): void {
    this.beginQuiescence();
    const status = this.deps.getStatus();
    const body: PrepareUpgradeResponse = {
      quiescing: this.state.quiescing,
      runningTurns: status.runningTurns ?? (status.isBusy ? 1 : 0),
    };
    sendJson(res, 200, body);
  }

  private handleShutdown(res: http.ServerResponse): void {
    if (this.shutdownHandler === undefined) {
      sendJson(res, 501, { error: "shutdown-not-configured" });
      return;
    }
    this.beginQuiescence();
    if (!this.shutdownScheduled) {
      this.shutdownScheduled = true;
      const scheduleShutdown = () => {
        if (this.shutdownCallbackScheduled) return;
        this.shutdownCallbackScheduled = true;
        queueMicrotask(() => {
          void Promise.resolve().then(() => this.shutdownHandler!()).catch((error) => {
            console.error("[openbot] graceful shutdown failed:", error);
            this.cancelQuiescence();
          });
        });
      };
      res.once("finish", scheduleShutdown);
      res.once("close", scheduleShutdown);
    }
    sendJson(res, 202, { ok: true, shuttingDown: true });
  }

  private handleAvatar(path: string, res: http.ServerResponse): void {
    let id: string;
    try {
      id = decodeURIComponent(path.slice("/avatars/".length));
    } catch {
      sendJson(res, 400, { error: "invalid-avatar-id" });
      return;
    }
    if (/[\u0000-\u001f\u007f]/.test(id)) {
      sendJson(res, 400, { error: "invalid-avatar-id" });
      return;
    }
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">` +
      `<rect width="96" height="96" rx="16" fill="#0b0f19"/>` +
      `<circle cx="48" cy="40" r="16" fill="#e879f9"/>` +
      `<rect x="24" y="58" width="48" height="8" rx="4" fill="#a78bfa"/>` +
      `<rect x="32" y="70" width="32" height="6" rx="3" fill="#a78bfa"/>` +
      `</svg>`;
    const buf = Buffer.from(svg, "utf8");
    // Placeholder T3 — sem cache, mas com headers mínimos úteis para a UI.
    res.statusCode = 200;
    res.setHeader("content-type", "image/svg+xml; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-avatar-id", encodeURIComponent(id));
    res.end(buf);
  }

  close(): void {
    for (const client of this.sseClients) client.res.end();
    this.sseClients.clear();
  }

  private tokenGuard(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    queryToken?: string | null,
  ): boolean {
    if (!this.gatewayToken) return true;
    if (tokenFromRequest(req, queryToken) === this.gatewayToken) return true;
    sendJson(res, 401, { error: "unauthorized" });
    return false;
  }

  private csrfGuard(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): boolean {
    const host = req.headers.host;
    const origin = req.headers.origin;
    // Host ausente/não-loopback → 403 (não informamos por quê).
    if (!isLoopbackHost(host)) {
      sendJson(res, 403, { error: "csrf" });
      return false;
    }
    // Origin ausente (curl, clientes não-browser) → permitido.
    // Origin presente e não-loopback (XHR/fetch de site estranho) → 403.
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      sendJson(res, 403, { error: "csrf" });
      return false;
    }
    return true;
  }

  private handleSse(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): void {
    if (!isSseRequest(req)) {
      sendJson(res, 400, { error: "expected-event-stream" });
      return;
    }
    const allChannels = this.sseChannels;
    const requested = url.searchParams.get("channels");
    // Sem ?channels= → recebe TUDO (null = sem filtro); com ?channels= → só os
    // canais listados. O gateway é permissivo por default (T3 não tem mesa).
    const requestedNames = requested === null || requested.trim() === ""
      ? []
      : requested.split(",").map((c) => c.trim()).filter(Boolean);
    const taskChannelRequested = requestedNames.some((name) => name === "async-tasks" || name === "subagents" || name === "a2a");
    const projectionAgentId = url.searchParams.get("agentId")?.trim() || null;
    if (taskChannelRequested && projectionAgentId === null) {
      sendJson(res, 400, { error: "agentId is required for task SSE channels" });
      return;
    }
    const channels: ReadonlySet<string> | null =
      requestedNames.length === 0
        ? allChannels.size === 0
          ? null
          : allChannels
        : new Set(requestedNames.filter((name) => allChannels.size === 0 || allChannels.has(name)));
    const projectionChannels = (["async-tasks", "subagents", "a2a"] as const).filter((channel) => channels?.has(channel) ?? false);
    const lastEventId = typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : undefined;
    const projectionSnapshots = projectionAgentId === null
      ? []
      : projectionChannels.map((channel) => {
        const snapshot = channel === "a2a"
          ? this.a2aSnapshot?.(projectionAgentId)
          : this.taskSnapshot?.(projectionAgentId, channel);
        if (snapshot === null || snapshot === undefined) return null;
        return { channel, snapshot };
      });
    if (projectionSnapshots.some((entry) => entry === null)) {
      sendJson(res, 404, { error: "agent not found" });
      return;
    }

    if (this.sseClients.size >= SSE_MAX_CLIENTS) {
      sendJson(res, 429, { error: "too-many-sse-clients" });
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders();

    const client: SseClient = { res, channels, agentId: projectionAgentId, blocked: false, pending: [], pendingBytes: 0 };
    this.sseClients.add(client);
    res.on("drain", () => this.flushSse(client));
    let initialFrame = `retry: ${SSE_RETRY_MS}\n\n`;
    const transcriptSnapshot = (channels === null || channels.has("transcript")) && projectionAgentId !== null
      ? this.transcriptSnapshot?.(projectionAgentId) ?? null
      : null;
    if (channels === null || channels.has("transcript")) {
      if (transcriptSnapshot !== null) {
        const parsedCursor = parseTranscriptEventId(lastEventId);
        const reason = lastEventId === undefined
          ? "stream-connected"
          : parsedCursor === null ? "invalid-cursor" : "cursor-stale-or-gap";
        const base = {
          type: "snapshot" as const,
          agentId: transcriptSnapshot.agentId,
          activeAgentId: transcriptSnapshot.activeAgentId,
          ...(transcriptSnapshot.conversationId === undefined ? {} : { conversationId: transcriptSnapshot.conversationId }),
          resyncRequired: true,
          reason,
        };
        const entries = [...transcriptSnapshot.entries];
        while (entries.length > 0 && Buffer.byteLength(`data: ${JSON.stringify({ channel: "transcript", payload: { ...base, entries } } satisfies SseEvent)}\n\n`, "utf8") > SSE_MAX_FRAME_BYTES) entries.shift();
        const payload = { ...base, entries, ...(entries.length < transcriptSnapshot.entries.length ? { truncated: true, method: "openAgentTail" } : {}) };
        // The reconnect snapshot deliberately has no ordered namespace. The
        // next live event re-establishes the authoritative per-agent
        // `transcript:${agentId}` cursor; a synthetic `:resync` replica would
        // be interpreted by the active renderer as a different agent.
        initialFrame += `data: ${JSON.stringify({ channel: "transcript", payload } satisfies SseEvent)}\n\n`;
      } else {
        const payload = {
          ...resyncPayload("transcript", undefined, lastEventId === undefined ? "stream-connected" : "last-event-id"),
          ...(lastEventId === undefined ? {} : { lastEventId }),
        };
        initialFrame += `data: ${JSON.stringify({ channel: "transcript", payload } satisfies SseEvent)}\n\n`;
      }
    }
    const snapshotFrames: string[] = [];
    // P2.2: the task channels (`async-tasks` / `subagents`) emit the native
    // SQLite snapshot as a single first-party event carrying `tasks` and/or
    // `subagents` (the closed renderer allowlist), so a stream that requests
    // both channels gets one authoritative snapshot frame before live updates.
    // The a2a channel keeps its per-channel `items` frames unchanged.
    const taskProjectionChannels = (["async-tasks", "subagents"] as const).filter((channel) => projectionChannels.includes(channel));
    if (taskProjectionChannels.length > 0) {
      const primaryChannel = taskProjectionChannels.includes("async-tasks") ? "async-tasks" : "subagents";
      const taskSnapshots: Partial<Record<"async-tasks" | "subagents", GatewayTaskSnapshot>> = {};
      for (const channel of taskProjectionChannels) {
        const entry = projectionSnapshots.find((candidate) => candidate !== null && candidate.channel === channel);
        if (entry !== undefined && entry !== null && entry.snapshot !== undefined) taskSnapshots[channel] = entry.snapshot as GatewayTaskSnapshot;
      }
      const primarySnapshot = taskSnapshots[primaryChannel];
      if (primarySnapshot !== undefined) {
        const cursor = parseProjectionCursor(lastEventId);
        const cursorApplies = cursor !== null && (cursor.channel === undefined
          ? taskProjectionChannels.length === 1
          : (taskProjectionChannels as readonly string[]).includes(cursor.channel ?? ""));
        const reason = !cursorApplies
          ? (cursor === null
            ? (lastEventId === undefined ? "stream-connected" : "invalid-cursor")
            : "cursor-channel-mismatch")
          : cursor.epoch !== primarySnapshot.epoch
            ? "epoch-mismatch"
            : cursor.sequence < primarySnapshot.sequence
              ? "cursor-stale-or-gap"
              : cursor.sequence > primarySnapshot.sequence ? "cursor-ahead" : "cursor-current";
        const parentAgentId = primarySnapshot.parentAgentId ?? projectionAgentId ?? undefined;
        const payload = {
          type: "snapshot" as const,
          resyncRequired: reason !== "cursor-current",
          reason,
          agentId: projectionAgentId!,
          ...(parentAgentId === undefined ? {} : { parentAgentId }),
          channel: primaryChannel,
          epoch: primarySnapshot.epoch,
          sequence: primarySnapshot.sequence,
          cursor: { channel: primaryChannel, epoch: primarySnapshot.epoch, sequence: primarySnapshot.sequence },
          snapshotPart: 0,
          snapshotParts: 1,
          truncated: taskProjectionChannels.some((channel) => taskSnapshots[channel]?.truncated === true),
          ...(taskProjectionChannels.includes("async-tasks") ? { tasks: taskSnapshots["async-tasks"]?.items ?? [] } : {}),
          ...(taskProjectionChannels.includes("subagents") ? { subagents: taskSnapshots.subagents?.items ?? [] } : {}),
        };
        const frame = `id: ${primaryChannel}:${primarySnapshot.epoch}:${primarySnapshot.sequence}\ndata: ${JSON.stringify({ channel: primaryChannel, payload } satisfies SseEvent)}\n\n`;
        if (Buffer.byteLength(frame) <= SSE_MAX_FRAME_BYTES) {
          snapshotFrames.push(frame);
        } else {
          // Fallback for pathological lists: per-channel bounded frames keep
          // the transport safe and the keys canonical.
          for (const channel of taskProjectionChannels) {
            const snapshot = taskSnapshots[channel];
            if (snapshot === undefined) continue;
            const chunked: unknown[][] = [];
            let chunk: unknown[] = [];
            let needsFixedResync = false;
            const frameFor = (itemsValue: unknown[], truncatedValue = snapshot.truncated === true): string => `data: ${JSON.stringify({ channel, payload: { type: "snapshot", resyncRequired: true, reason: "frame-chunked", agentId: projectionAgentId!, ...(snapshot.parentAgentId === undefined ? {} : { parentAgentId: snapshot.parentAgentId }), channel, epoch: snapshot.epoch, sequence: snapshot.sequence, cursor: { channel, epoch: snapshot.epoch, sequence: snapshot.sequence }, snapshotPart: 0, snapshotParts: 1, truncated: truncatedValue, [channel === "async-tasks" ? "tasks" : "subagents"]: itemsValue } } satisfies SseEvent)}\n\n`;
            for (const item of snapshot.items) {
              const candidate = [...chunk, item];
              if (Buffer.byteLength(frameFor(candidate)) <= SSE_MAX_FRAME_BYTES) { chunk = candidate; continue; }
              if (chunk.length > 0) { chunked.push(chunk); chunk = []; }
              if (Buffer.byteLength(frameFor([item])) <= SSE_MAX_FRAME_BYTES) chunk = [item];
              else {
                const sourceItem = isRecord(item) ? item : {};
                const rawId = sourceItem.id ?? sourceItem.taskId;
                const placeholder = {
                  id: typeof rawId === "string" && rawId.length > 0 ? rawId.slice(0, 256) : "unknown",
                  agentId: projectionAgentId!.slice(0, 256),
                  truncated: true,
                };
                if (Buffer.byteLength(frameFor([placeholder])) <= SSE_MAX_FRAME_BYTES) chunk = [placeholder];
                else needsFixedResync = true;
              }
            }
            if (chunk.length > 0 || (chunked.length === 0 && !needsFixedResync)) chunked.push(chunk);
            // The renderer replaces task state on every snapshot frame, so a
            // multi-frame task snapshot would silently discard earlier parts.
            // Keep one bounded recent window and mark it truncated instead.
            const recentChunk = chunked.at(-1);
            if (recentChunk !== undefined) {
              const chunkFrame = frameFor(recentChunk, snapshot.truncated === true || chunked.length > 1);
              if (Buffer.byteLength(chunkFrame) <= SSE_MAX_FRAME_BYTES) snapshotFrames.push(chunkFrame);
              else needsFixedResync = true;
            }
            if (needsFixedResync) {
              const fixedResync = `data: ${JSON.stringify({
                channel,
                payload: resyncPayload(channel, { agentId: projectionAgentId!.slice(0, 256) }, "snapshot-too-large"),
              } satisfies SseEvent)}\n\n`;
              if (Buffer.byteLength(fixedResync) <= SSE_MAX_FRAME_BYTES) snapshotFrames.push(fixedResync);
            }
          }
        }
      }
    }
    for (const entry of projectionSnapshots) if (entry !== null && entry.channel === "a2a") {
      const projectionChannel = "a2a";
      const cursor = parseProjectionCursor(lastEventId);
      const snapshot = entry.snapshot;
      const cursorApplies = cursor !== null && (cursor.channel === undefined
        ? projectionChannels.length === 1
        : cursor.channel === projectionChannel);
      const reason = !cursorApplies
        ? (cursor === null
          ? (lastEventId === undefined ? "stream-connected" : "invalid-cursor")
          : "cursor-channel-mismatch")
        : cursor.epoch !== snapshot.epoch
          ? "epoch-mismatch"
          : cursor.sequence < snapshot.sequence
            ? "cursor-stale-or-gap"
            : cursor.sequence > snapshot.sequence ? "cursor-ahead" : "cursor-current";
      const chunks: unknown[][] = [];
      let chunk: unknown[] = [];
      let truncated = false;
      const frameFor = (items: unknown[], part: number, parts: number, wasTruncated: boolean): string => {
        const payload = {
          type: "snapshot", resyncRequired: reason !== "cursor-current", reason,
          agentId: projectionAgentId!, channel: projectionChannel,
          epoch: snapshot.epoch, sequence: snapshot.sequence,
          cursor: { channel: projectionChannel, epoch: snapshot.epoch, sequence: snapshot.sequence },
          snapshotPart: part, snapshotParts: parts, truncated: wasTruncated, items,
        };
        return `${part === 0 ? `id: ${projectionChannel}:${snapshot.epoch}:${snapshot.sequence}\n` : ""}data: ${JSON.stringify({ channel: projectionChannel, payload } satisfies SseEvent)}\n\n`;
      };
      for (const item of snapshot.items) {
        const candidate = [...chunk, item];
        if (Buffer.byteLength(frameFor(candidate, 0, 1, truncated)) <= SSE_MAX_FRAME_BYTES) {
          chunk = candidate;
          continue;
        }
        if (chunk.length > 0) {
          chunks.push(chunk);
          chunk = [];
        }
        if (Buffer.byteLength(frameFor([item], 0, 1, false)) <= SSE_MAX_FRAME_BYTES) {
          chunk = [item];
        } else {
          truncated = true;
        }
      }
      if (chunk.length > 0 || chunks.length === 0) chunks.push(chunk);
      const parts = chunks.length;
      for (let part = 0; part < parts; part += 1) snapshotFrames.push(frameFor(chunks[part]!, part, parts, truncated));
    }
    this.writeSse(client, initialFrame);
    for (const frame of snapshotFrames) this.writeSse(client, frame);

    const ping = setInterval(() => {
      if (res.destroyed) return;
      this.writeSse(client, ":ping\n\n", true);
    }, this.sseHeartbeatMs);
    ping.unref();

    res.on("close", () => {
      clearInterval(ping);
      this.sseClients.delete(client);
    });
  }

  private async handleRpc(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
  ): Promise<void> {
    const method = path.slice("/api/".length);
    if (method.length === 0 || !RPC_METHOD_TABLE.has(method)) {
      // 404 — método RPC desconhecido (contrato: mesmo POST, rota inexistente).
      sendJson(res, 404, { error: `unknown method: ${method}` });
      return;
    }

    if (this.state.quiescing && !QUIESCENCE_ALLOWED_RPC_METHODS.has(method)) {
      const failure: RpcEnvelopeFailure = { ok: false, failure: "gateway quiescing" };
      this.sendJsonMaybeGzip(res, 503, failure);
      req.resume();
      return;
    }

    let body: unknown;
    try {
      const raw = await this.readJsonBody(req);
      body = raw ?? {};
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid-json";
      const status = err instanceof RequestBodyError ? err.status : 400;
      sendJson(res, status, { error: status === 413 ? "payload-too-large" : `invalid-json: ${message}` });
      return;
    }

    const handler = this.handlers.get(method);
    if (!handler) {
      // Rota conhecida mas mesa ainda não plugada (T10+).
      sendJson(res, 501, { error: `method not wired: ${method}` });
      return;
    }

    const ctx: HandlerContext = {
      getStatus: this.deps.getStatus,
      publish: (channel, payload) => this.publish(channel, payload),
      method,
    };

    try {
      const value = await handler(body, ctx);
      const envelope: RpcEnvelope<unknown> = { ok: true, value };
      this.sendJsonMaybeGzip(res, 200, envelope);
    } catch (err) {
      const failure: RpcEnvelopeFailure = {
        ok: false,
        failure: err instanceof Error ? err.message : String(err),
      };
      const status = err instanceof RpcError ? err.status : 500;
      this.sendJsonMaybeGzip(res, status, failure);
    }
  }

  private readJsonBody(req: http.IncomingMessage): Promise<unknown | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      const declaredLength = Number(req.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > 1_000_000) {
        tooLarge = true;
        req.resume();
        reject(new RequestBodyError(413, "payload too large"));
      }
      req.on("data", (chunk: Buffer) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > 1_000_000) {
          tooLarge = true;
          chunks.length = 0;
          // Continue drenando a requisição para preservar a conexão e permitir
          // que o cliente receba o 413, em vez de provocar ECONNRESET.
          reject(new RequestBodyError(413, "payload too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (tooLarge) return;
        if (chunks.length === 0) {
          resolve(null);
          return;
        }
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(JSON.parse(text) as unknown);
        } catch {
          reject(new RequestBodyError(400, "malformed"));
        }
      });
      req.on("error", (err) => {
        if (!tooLarge) reject(err);
      });
    });
  }

  private sendJsonMaybeGzip(
    res: http.ServerResponse,
    status: number,
    body: unknown,
  ): void {
    const payload = JSON.stringify(body);
    if (res.writableEnded) return;
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    const wantsGzip =
      Buffer.byteLength(payload) >= GZIP_MIN_BYTES &&
      acceptsGzip(res.req.headers["accept-encoding"]);

    if (!wantsGzip) {
      res.end(payload);
      return;
    }

    res.setHeader("content-encoding", "gzip");
    const gz = zlib.createGzip();
    gz.on("error", () => {
      if (!res.headersSent) {
        res.removeHeader("content-encoding");
        res.setHeader("content-type", "application/json; charset=utf-8");
      }
      if (!res.writableEnded) res.end(payload);
    });
    gz.pipe(res);
    gz.end(payload);
  }
}

/** Factory ergonômica para o bootstrap (src/main.ts). */
export function createGateway(
  opts?: GatewayOptions,
  deps?: GatewayDeps,
): Gateway {
  return new Gateway(opts, deps);
}

/**
 * Cria um listener HTTP cru para os 2 stubs T1 (sobe/derruba o socket na porta
 * fixa), usado por `startServer` em src/main.ts — o gateway em si é montado
 * por `createGateway().createHandler()`.
 */
export function createNotImplementedHandler(): (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void {
  return (_req, res) => {
    if (res.writableEnded) return;
    res.writeHead(501, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not-implemented" }));
  };
}
