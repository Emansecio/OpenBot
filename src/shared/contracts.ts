/**
 * Contratos congelados do OpenBot (Fase 1 MVP) — espelho local do
 * gateway-protocol do host (mapa-funcoes §4.5) e dos shapes consumidos pela
 * UI (mapa-frontend §3.2/§3.3). CONTRATO CONGELADO em T2: qualquer mudança
 * de shape exige atualizar fixtures + revisão.
 */

/** Página cronológica do tail; `nextBeforeSeq` aponta para entries mais antigas. */
export interface SandTranscriptPage {
  entries: TranscriptEntry[];
  nextBeforeSeq?: number;
}

/** Kinds observados de `TranscriptEntry` (mapa-frontend §3.3). */
export type TranscriptEntryKind =
  | "message"
  | "send-message"
  | "user-attachment"
  | "tool-call"
  | "notice"
  | "event"
  | "widget"
  | "tool-request";

/** Union `message.type` dos cards de `send-message` (mapa-frontend §3.3) — "nenhum card missing". */
export type SendMessageType =
  | "text"
  | "attachment"
  | "widget"
  | "cursor-agent"
  | "secret-request"
  | "email-draft"
  | "slack-draft"
  | "permission-request"
  | "auto-review-approval"
  | "local-tool-permission"
  | "connector"
  | "connectors"
  | "listener-connect";

/** Payload do card (union discriminada por `type`). */
export type SendMessagePayload =
  | { type: "text"; text?: string; content?: string }
  | { type: "attachment"; url?: string; file_name?: string }
  | { type: "widget"; prompt?: string }
  | { type: "cursor-agent"; title?: string }
  | { type: "secret-request"; label?: string }
  | { type: "email-draft"; subject?: string; body?: string }
  | { type: "slack-draft"; body?: string }
  | { type: "permission-request"; title?: string }
  | { type: "auto-review-approval"; approval?: { summary?: string } }
  | { type: "local-tool-permission"; ask: { status: "pending" | "expired"; requestId: string; action: "run-command" | "send-input" | "read-file" | "list-directory" | "write-file"; target: string; expiresAtMs?: number } }
  | { type: "connector"; variant?: string; connected?: boolean }
  | { type: "connectors" }
  | { type: "listener-connect"; platform?: "slack" | "github" };

/** Peer que a UI do Grok Bot lê como `toAgent`/`fromAgent` (`id` + `name` obrigatórios). */
export interface TranscriptAgentRef {
  kind: "agent";
  id: string;
  name: string;
}

/** Autor humano. A UI lê `fromUser.name` e `fromUser.authId` — boolean `true` crasha o render. */
export interface TranscriptUserRef {
  name: string;
  authId: string;
}

export type TranscriptEntry =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      content: string;
      clientNonce?: string;
      turnId?: string;
      provider?: string;
      model?: string;
      reasoningEffort?: ReasoningEffort;
      serviceTierOutcome?: { requested: "priority" | "default"; actual: Array<"priority" | "default" | "unknown"> };
      modelResolution?: import("../providers/model-catalog.js").ModelResolution;
      retryOfClientNonce?: string;
      fromAgent?: string | TranscriptAgentRef;
      fromUser?: boolean | TranscriptUserRef;
      toAgent?: string | TranscriptAgentRef;
      timestampMs: number;
      streaming?: boolean;
      isStreaming?: boolean;
      completionState?: "complete" | "interrupted";
      memoryContextSources?: readonly import("../memory/types.js").MemoryContextSource[];
    }
  | {
      kind: "send-message";
      id?: string;
      message: SendMessagePayload;
      author?: string | TranscriptAgentRef;
      streaming?: boolean;
    }
  | {
      kind: "user-attachment";
      id?: string;
      file_name: string;
      file_path: string;
      clientNonce?: string;
      turnId?: string;
      extractedText?: string;
      skipped?: string;
    }
  | {
      kind: "tool-call";
      id?: string;
      name: string;
      summary: string;
      status: "pending" | "running" | "completed" | "failed";
      result?: ToolCallResult;
      [key: string]: unknown;
    }
  | {
      kind: "notice";
      [key: string]: unknown;
    }
  | {
      kind: "event";
      type?: string;
      [key: string]: unknown;
    }
  | {
      kind: "widget" | "tool-request";
      [key: string]: unknown;
    };

export function transcriptAgentRef(id: string, name?: string): TranscriptAgentRef {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return { kind: "agent", id, name: trimmed.length > 0 ? trimmed : id };
}

export function transcriptUserRef(name?: string, authId?: string): TranscriptUserRef {
  const trimmedName = typeof name === "string" ? name.trim() : "";
  const trimmedAuth = typeof authId === "string" ? authId.trim() : "";
  return {
    name: trimmedName.length > 0 ? trimmedName : "You",
    authId: trimmedAuth.length > 0 ? trimmedAuth : "local-user",
  };
}

function asAgentRef(value: unknown, fallbackName?: string): TranscriptAgentRef | undefined {
  if (typeof value === "string" && value.trim()) return transcriptAgentRef(value, fallbackName);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as { id?: unknown; name?: unknown };
    if (typeof record.id === "string" && record.id.trim()) {
      return transcriptAgentRef(record.id, typeof record.name === "string" ? record.name : fallbackName);
    }
  }
  return undefined;
}

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** O renderer projeta rowId com `entry.id`; string vazia/undefined vira TypeError em `.length`. */
export function ensureTranscriptEntryId(entry: TranscriptEntry): string {
  const raw = (entry as { id?: unknown }).id;
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (entry.kind === "message") {
    return `message:${entry.role}:${entry.timestampMs}:${fingerprint(entry.content)}`;
  }
  if (entry.kind === "send-message") {
    return `send:${fingerprint(JSON.stringify(entry.message ?? null))}`;
  }
  if (entry.kind === "user-attachment") {
    return `att:${fingerprint(`${entry.file_path}\0${entry.file_name}\0${entry.clientNonce ?? ""}`)}`;
  }
  if (entry.kind === "notice") {
    return `notice:${fingerprint(String((entry as { text?: unknown }).text ?? ""))}`;
  }
  if (entry.kind === "tool-call") {
    return `tool:${fingerprint(`${entry.name}\0${entry.summary}`)}`;
  }
  return `${entry.kind}:${fingerprint(JSON.stringify(entry))}`;
}

/** Reescreve entries antigas para o shape que o renderer espera (id, peers, isStreaming). */
export function normalizeTranscriptEntry(
  entry: TranscriptEntry,
  ctx: { agentName?: string; userName?: string; userAuthId?: string } = {},
): TranscriptEntry {
  if (entry.kind === "send-message") {
    const author = asAgentRef(entry.author, ctx.agentName);
    const payload = entry.message;
    let textPayload = payload;
    if (payload?.type === "text") {
      const text = typeof payload.text === "string"
        ? payload.text
        : typeof payload.content === "string"
          ? payload.content
          : "";
      textPayload = { type: "text" as const, content: text };
    }
    return {
      ...entry,
      id: ensureTranscriptEntryId(entry),
      message: textPayload,
      ...(author ? { author } : {}),
    };
  }
  if (entry.kind === "user-attachment") {
    return { ...entry, id: ensureTranscriptEntryId(entry) };
  }
  if (entry.kind === "notice" || entry.kind === "event" || entry.kind === "widget" || entry.kind === "tool-request") {
    return { ...entry, id: ensureTranscriptEntryId(entry) };
  }
  if (entry.kind === "tool-call") {
    return { ...entry, id: ensureTranscriptEntryId(entry) };
  }
  if (entry.kind !== "message") return entry;
  const next: Extract<TranscriptEntry, { kind: "message" }> = {
    ...entry,
    id: ensureTranscriptEntryId(entry),
    isStreaming: entry.isStreaming ?? entry.streaming === true,
  };
  const toAgent = asAgentRef(entry.toAgent, ctx.agentName);
  if (toAgent) next.toAgent = toAgent;
  const fromAgent = asAgentRef(entry.fromAgent, ctx.agentName);
  if (fromAgent) next.fromAgent = fromAgent;
  if (entry.fromUser === true) {
    next.fromUser = transcriptUserRef(ctx.userName, ctx.userAuthId);
  } else if (typeof entry.fromUser === "object" && entry.fromUser !== null) {
    next.fromUser = transcriptUserRef(entry.fromUser.name, entry.fromUser.authId);
  }
  if (typeof next.content !== "string") next.content = "";
  return next;
}

/** Args de `sendPrompt` (mapa-frontend §3.4 / mapa-funcoes §5.1). */
export interface SandSendPromptArgs {
  agentId: string;
  /** Conversa alvo; omitido mantém compatibilidade e usa a conversa ativa. */
  conversationId?: string;
  prompt: string;
  text?: string;
  trimmedPrompt?: string;
  id?: string;
  richText?: string;
  attachments?: { path: string; name: string }[];
  clientNonce?: string;
  retryOfClientNonce?: string;
  retryFailureTurnId?: string;
  composedAtMs?: number;
  enterEpochMs?: number;
  userMessageId?: string;
  /** P2.3 closed reply contract: an opaque persisted entry id scoped to one conversation. Client-quoted text is display-only; the server resolves the durable entry. */
  replyContext?: { replyToId: string; conversationId: string };
  isFork?: boolean;
  selectedImages?: string[];
  selectedVideos?: string[];
  fileAttachmentPaths?: string[];
  attachedFileSizes?: number[];
  awaitTurn?: boolean;
}

/** Explicit opt-in request for the hidden, bounded onboarding turn (P2.8). */
export interface KickstartAgentArgs {
  agentId: string;
  clientNonce: string;
  mode: "onboarding";
}

export type KickstartRunStatus =
  | "queued"
  | "running"
  | "retryable"
  | "completed"
  | "interrupted"
  | "cancelled"
  | "failed";

export interface KickstartAgentResult {
  accepted: true;
  isIntroductionInFlight: boolean;
  status: KickstartRunStatus;
  clientNonce: string;
  attempt: number;
  result?: { text: string };
}

/** Resposta de aceitação durável do `sendPrompt` (mapa-funcoes §4.5/§5.1). */
export type SandSendPromptResult = { accepted: true } | void;

/** Envelopes RPC `{ok,value}` / `{ok:false,failure}` (mapa-frontend §3.2). */
export interface RpcEnvelopeOk<T> {
  ok: true;
  value: T;
}
export interface RpcEnvelopeFailure {
  ok: false;
  failure: string;
}
export type RpcEnvelope<T> = RpcEnvelopeOk<T> | RpcEnvelopeFailure;

/** Evento SSE `{channel, payload}` (mapa-funcoes §4.5). */
export interface SseEvent<C extends string = string, P = unknown> {
  channel: C;
  payload: P;
}

export interface ToolCallResult {
  ok: boolean;
  operation?: string;
  memoryId?: string;
  canonicalKey?: string;
  code?: string;
  message?: string;
  bytes?: number;
  path?: string;
  count?: number;
  command?: string;
  exitCode?: number | null;
}

/** Eventos do canal `transcript`: `snapshot` (reset), `appended` (tail) e `updated` (mesma entry). */
export type TranscriptEventPayload =
  | { type: "snapshot"; agentId: string; activeAgentId: string; conversationId?: string; entries: TranscriptEntry[]; ordered?: TranscriptEventOrder }
  | { type: "appended"; agentId: string; conversationId?: string; entry: TranscriptEntry; ordered?: TranscriptEventOrder }
  | { type: "delta"; agentId: string; conversationId?: string; entryId: string; fragment: string; ordered: TranscriptEventOrder }
  | { type: "updated"; agentId: string; conversationId?: string; entry: TranscriptEntry; ordered?: TranscriptEventOrder; throughSequence?: number; final?: boolean; resyncRequired?: boolean };

export interface TranscriptEventOrder {
  replicaKey: string;
  epoch: string;
  sequence: number;
}

/** Canais SSE do gateway (mapa-funcoes §4.5). */
export const SSE_CHANNELS = [
  "transcript",
  "agents",
  "agent-upserted",
  "outline",
  "subagents",
  "async-tasks",
  "a2a",
  "reasoning",
  "memory",
  "automations",
  "workflows",
  "tray",
  "forever-box",
  "teach-recording",
  "box-disk-pressure",
  "computer-action",
  "mcp-oauth-pending",
  "mcp-servers",
  "sharing",
  "host-settings",
  "reactions",
] as const;

export type SseChannel = (typeof SSE_CHANNELS)[number];

/** Stub inerte do forever box (Decisão §8.4 confirmada em 11/08/2026). */
export interface SandForeverBoxStatus {
  vncUrl: null;
  windows: SandForeverBoxWindow[];
}

export interface SandForeverBoxWindow {
  id?: string;
  title?: string;
  [key: string]: unknown;
}

/** `SandHostSettings` (mapa-funcoes §4.5): timezone, pinned/sections, flags locais. */
export interface SandHostSettings {
  timezone?: string;
  pinnedAgents?: string[];
  sidebarSections?: unknown;
  autoReviewEnabled?: boolean;
  localToolPermission?: "ask" | "always" | "never";
  webauthnProxy?: boolean;
  mcpCustomInstructions?: string;
  mcpDisabledTools?: string[];
  featureFlagOverrides?: Record<string, unknown>;
}

/** Catálogo estático de modelos (Decisão §8.3 confirmada em 11/08/2026). */
export type ProviderKind = "openai" | "xai" | "opencode-go" | "openai-compat";

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

/** Token counting strategy used for model-window accounting. */
export type ModelTokenizerStrategy = "estimated" | "provider";

export interface ModelCatalogEntry {
  id: string;
  provider: ProviderKind;
  displayName: string;
  description?: string;
  contextWindow?: number;
  /** Maximum completion tokens advertised by the model, when known. */
  maxOutputTokens?: number;
  /** Maximum serialized request body accepted by the local provider route. */
  maxRequestBytes?: number;
  /** Token counting strategy. Entries may omit this and use the conservative estimator. */
  tokenizerStrategy?: ModelTokenizerStrategy;
  /** Fraction reserved as a safety margin; finite and in [0, 0.5). */
  safetyMargin?: number;
  supportsVision?: boolean;
  default?: boolean;
}

/** Shapes de secrets do box — só nomes trafegam, nunca valores (mapa-funcoes §4.5). */
export interface BoxSecretsStatus {
  /** Alias usado pelo painel local injetado. */
  secrets: string[];
  /** Shape validado pelo coordinator/renderer original. */
  keys: string[];
  isApplied: boolean;
  lastAppliedAtMs: number | null;
}

/**
 * P2.2 — native first-party projection of async tasks / subagents for the
 * renderer. This is the closed allowlist consumed by OpenBot overlays: the
 * projection adapter (src/tasks/projection.ts) is the ONLY producer and never
 * emits full inputs, internal lineage, grants, credential references, lease
 * ownership, secrets, arbitrary objects or unknown fields.
 */
export type NativeAsyncTaskProjectionChannel = "async-tasks" | "subagents";

export interface NativeAsyncTaskProjectionProgress {
  readonly phase: string;
  readonly summary: string;
  readonly completedUnits: number | null;
  readonly totalUnits: number | null;
}

export interface NativeAsyncTaskProjectionError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface NativeAsyncTaskProjectionResult {
  readonly kind: "inline" | "ref";
  readonly text?: string;
  readonly resultRef?: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

export type NativeAsyncTaskProjectionAction = "abort" | "steer";

/** One sanitized task/subagent row for the renderer. */
export interface NativeAsyncTaskProjectionItem {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly label: string;
  readonly detail: string;
  readonly startedAtMs: number | null;
  /** Current attempt counter; present only while a retry can be observed. */
  readonly attempt?: number;
  readonly progress?: NativeAsyncTaskProjectionProgress | null;
  readonly error?: NativeAsyncTaskProjectionError | null;
  readonly result?: NativeAsyncTaskProjectionResult | null;
  /** Only present when the current state really permits the action. */
  readonly allowedActions?: readonly NativeAsyncTaskProjectionAction[];
}

/**
 * One SSE frame for `async-tasks` / `subagents`. Snapshots carry the full
 * native list under `tasks` / `subagents`; live outbox events carry a single
 * item. Every frame preserves the durable `agentId`, `parentAgentId`,
 * `channel`, `epoch` and `sequence`.
 */
export interface NativeAsyncTaskProjectionEvent {
  readonly type: "snapshot" | "update" | "resync";
  readonly agentId: string;
  readonly parentAgentId: string;
  readonly channel: NativeAsyncTaskProjectionChannel;
  readonly epoch?: string;
  readonly sequence?: number;
  readonly tasks?: NativeAsyncTaskProjectionItem[];
  readonly subagents?: NativeAsyncTaskProjectionItem[];
  readonly resyncRequired?: boolean;
  readonly reason?: string;
}

/** Immutable summary of a client cursor for one projection channel. */
export interface NativeAsyncTaskClientCursor {
  readonly channel: NativeAsyncTaskProjectionChannel;
  readonly epoch: string;
  readonly sequence: number;
}

/**
 * Pure client state machine for a projection channel (P2.2 reconnect). A
 * snapshot replaces the whole local list; an update upserts by `id` and only
 * advances a monotonic sequence; stale/gap/ahead/epoch-mismatch frames are
 * rejected or marked as requiring an authoritative resync from SQLite. It
 * never merges snapshots and never creates duplicate task identities.
 */
export interface NativeAsyncTaskClientState {
  readonly agentId: string;
  readonly channel: NativeAsyncTaskProjectionChannel;
  readonly items: readonly NativeAsyncTaskProjectionItem[];
  readonly epoch: string | null;
  readonly sequence: number;
  readonly eventsApplied: number;
  readonly resyncRequired: boolean;
}

export interface NativeAsyncTaskClientStateTransition {
  readonly state: NativeAsyncTaskClientState;
  readonly handled: boolean;
  readonly resyncRequired: boolean;
  readonly reason: string | null;
}
