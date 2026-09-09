import type { ConfigStore } from "../config/store.js";
import type { Conversation } from "../conversations/store.js";
import type { LocalExecutionBroker } from "../execution/broker.js";
import type { ToolCallExecutor, ToolLoopOptions, ToolLoopResumableEffects } from "../execution/tool-loop.js";
import type { ProviderAdmissionScheduler } from "../providers/admission.js";
import type {
    ResumeBudgetSnapshot,
    ResumeCheckpoint,
    ResumeCheckpointScope,
    ResumeEffectCommit,
    ResumeEffectRecord,
} from "../providers/resume.js";
import { assertCheckpointUsable, boundedResumeResult, ResumeProtocolError } from "../providers/resume.js";
import type {
    ProviderChatMessage,
    ProviderChatRequest,
    ProviderError,
    ProviderRegistry,
    ProviderTool,
    ProviderStreamEvent,
    ProviderUserContentPart as RouterProviderUserContentPart,
} from "../providers/router.js";
import type { Gateway, RpcHandler } from "../server/gateway.js";
import type {
    KickstartAgentArgs,
    KickstartAgentResult,
    KickstartRunStatus,
    SandSendPromptArgs as ContractSandSendPromptArgs,
    ToolCallResult,
    TranscriptEntry,
} from "../shared/contracts.js";
import type { AgentActivityStore } from "./activity.js";
import type { ExtractedAttachment } from "./attachments.js";
import type { ResolvedProvider as IdentityResolvedProvider } from "./identity.js";
import type { ContextAssemblyResult, ConversationContextInfo } from "../memory/context.js";
import type { MemoryContextSource, MemoryMode, MemoryStore } from "../memory/types.js";

export type SandSendPromptArgs = ContractSandSendPromptArgs;
export type ProviderUserContentPart = RouterProviderUserContentPart;
export type ResolvedProvider = IdentityResolvedProvider;

export interface TurnContextResolution {
    source: "reference" | "text-command" | "other";
    context: string;
    normalizedPrompt?: string;
    error?: string;
}

export interface RecentEntriesOptions {
    limit: number;
    kinds?: readonly TranscriptEntry["kind"][];
    afterSequenceId?: number;
}

export interface TranscriptInteractionDecision {
    requestId: string;
    kind: string;
    decision: string;
    createdAtMs: number;
}

export type TurnAttemptPhase = "preparing" | "provider-pending" | "streaming";

export interface TurnAttemptRecord {
    turnId: string;
    agentId: string;
    conversationId?: string;
    clientNonce?: string;
    retryOfClientNonce?: string;
    retryFailureTurnId?: string;
    provider: string;
    model: string;
    phase: TurnAttemptPhase;
    startedAtMs: number;
}

export interface TurnAttemptCompletion {
    turnId: string;
    completedAtMs: number;
}

export interface KickstartRunRecord {
    agentId: string;
    clientNonce: string;
    conversationId?: string;
    origin: "kickstart";
    version: 1;
    attempt: number;
    turnId?: string;
    provider?: string;
    model?: string;
    status: KickstartRunStatus;
    observableOutput: boolean;
    result?: { text: string };
    error?: string;
    createdAtMs: number;
    updatedAtMs: number;
}

export interface KickstartClaim {
    run: KickstartRunRecord;
    claimed: boolean;
}

export interface TranscriptAgentSnapshot {
    entries: TranscriptEntry[];
    acceptedNonces: string[];
    interactionDecisions: TranscriptInteractionDecision[];
    conversationEntries?: Array<{ conversationId?: string; entries: TranscriptEntry[] }>;
    activeConversationId?: string | null;
    conversations?: Conversation[];
    acceptedNonceBindings?: Array<{ nonce: string; conversationId?: string }>;
    completedNonceBindings?: Array<{
        nonce: string;
        conversationId?: string;
        turnId: string;
        completedAtMs: number;
    }>;
    kickstartRuns?: KickstartRunRecord[];
}

export interface TranscriptPage {
    entries: TranscriptEntry[];
    nextBeforeSeq?: number;
}

export interface ConversationStoreLike {
    ensureDefault(agentId: string): Conversation;
    getActive(agentId: string): Conversation | null;
    get?(agentId: string, conversationId: string): Conversation | null;
    list(agentId: string, options?: { limit?: number; cursor?: string }): { items: Conversation[]; nextCursor?: string };
    updateAutoTitle(agentId: string, conversationId: string, firstUserText: string): Conversation;
    create?(agentId: string, options?: { title?: string; temporary?: boolean }): Conversation;
    activate?(agentId: string, conversationId: string): Conversation;
    rename?(agentId: string, conversationId: string, title: string): Conversation;
    archive?(agentId: string, conversationId: string): Conversation;
    delete?(
        agentId: string,
        conversationId: string,
        options: { memoryPolicy: "delete-derived" | "retain" },
    ): { conversationId: string; memoryPolicy: "delete-derived" | "retain" };
    clear?(agentId: string): void;
}

export interface TranscriptStore {
    getEntries(agentId: string, conversationId?: string): readonly TranscriptEntry[];
    append(agentId: string, entries: readonly TranscriptEntry[], conversationId?: string, consumeStagedAttachments?: boolean): void;
    beginTurnAttempt(attempt: TurnAttemptRecord): void;
    updateTurnAttempt(agentId: string, turnId: string, phase: TurnAttemptPhase): void;
    finishTurnAttempt(agentId: string, turnId: string): void;
    hasCompletedTurnForNonce?(agentId: string, nonce: string, conversationId?: string): boolean;
    clear(agentId: string): void;
    /** Clears multiple agents atomically when the backing store supports batching. */
    clearAgents?(agentIds: readonly string[]): void;
    hasAcceptedNonce(agentId: string, nonce: string, conversationId?: string): boolean;
    claimAcceptedNonce(agentId: string, nonce: string, conversationId?: string): boolean;
    rememberAcceptedNonce(agentId: string, nonce: string, conversationId?: string): void;
    forgetAcceptedNonce(agentId: string, nonce: string, conversationId?: string): void;
    findAcceptedNonceConversations?(agentId: string, nonce: string): readonly (string | undefined)[];
    getActiveConversationId?(agentId: string): string | undefined;
    getLatestSequenceId?(agentId: string, conversationId?: string): number | null;
    setActiveConversationId?(agentId: string, conversationId?: string): void;
    conversationStore?: ConversationStoreLike;
    validateConversation?(agentId: string, conversationId: string): void;
    trimAcceptedNonces(agentId: string, cap: number): void;
    getAgentTranscriptTail(agentId: string, limit?: number, beforeSeq?: number, conversationId?: string): TranscriptPage;
    openAgentTail(agentId: string, limit?: number, beforeSeq?: number, conversationId?: string): TranscriptPage;
    openDurableAgentTail?(agentId: string, limit?: number, beforeSeq?: number, conversationId?: string): TranscriptPage;
    getConversationOutline(agentId: string, conversationId?: string): { title: string | null; lastMessage: string | null };
    getRecentEntries(agentId: string, options: RecentEntriesOptions, conversationId?: string): readonly TranscriptEntry[];
    getEarliestUser(agentId: string, conversationId?: string): Extract<TranscriptEntry, { kind: "message" }> | undefined;
    getLatestAssistant(agentId: string, conversationId?: string): Extract<TranscriptEntry, { kind: "message" }> | undefined;
    getOpenToolCalls(agentId: string, conversationId?: string): readonly Extract<TranscriptEntry, { kind: "tool-call" }>[];
    findToolCallByLocalId?(
        agentId: string,
        localToolCallId: string,
        conversationId?: string,
    ): Extract<TranscriptEntry, { kind: "tool-call" }> | undefined;
    replaceToolCallByLocalId?(
        agentId: string,
        localToolCallId: string,
        entry: Extract<TranscriptEntry, { kind: "tool-call" }>,
        conversationId?: string,
    ): boolean;
    replace(agentId: string, entryId: string, entry: TranscriptEntry, conversationId?: string): boolean;
    setLiveEntry?(agentId: string, entry: TranscriptEntry, conversationId?: string): void;
    clearLiveEntry?(agentId: string, entryId: string, conversationId?: string): void;
    snapshotAgent?(agentId: string): TranscriptAgentSnapshot;
    restoreAgent?(agentId: string, snapshot: TranscriptAgentSnapshot): void;
    findUserEchoByNonce?(agentId: string, nonce: string, conversationId?: string): TranscriptEntry | undefined;
    findRetryableErrorNotice?(agentId: string, turnId: string, conversationId?: string): TranscriptEntry | undefined;
    createResumeCheckpoint?(checkpoint: ResumeCheckpoint): boolean;
    findResumeCheckpoint?(agentId: string, conversationId: string, turnId: string): ResumeCheckpoint | undefined;
    getResumeCheckpoint?(scope: ResumeCheckpointScope): ResumeCheckpoint | undefined;
    advanceResumeCheckpoint?(scope: ResumeCheckpointScope, expectedVersion: number, update: Pick<ResumeCheckpoint, "cursor" | "safeSequenceId" | "completedEffectIds" | "expiresAtMs" | "budget">): ResumeCheckpoint;
    prepareResumeEffect?(scope: ResumeCheckpointScope, effectId: string, fingerprintHash: string): ResumeEffectRecord;
    markResumeEffectStarted?(scope: ResumeCheckpointScope, effectId: string): ResumeEffectRecord | undefined;
    markResumeEffectUnsafe?(scope: ResumeCheckpointScope, effectId: string): ResumeEffectRecord | undefined;
    getResumeEffect?(scope: ResumeCheckpointScope, effectId: string): ResumeEffectRecord | undefined;
    hasUnsafeResumeEffect?(scope: ResumeCheckpointScope): boolean;
    completeResumeEffect?(scope: ResumeCheckpointScope, effectId: string, fingerprintHash: string, result: unknown): ResumeEffectRecord;
    commitResumeEffectAndCheckpoint?(input: ResumeEffectCommit): ResumeCheckpoint;
    reconcileResumeEffects?(agentId: string, nowMs?: number): number;
    getKickstartRun?(agentId: string, clientNonce: string): KickstartRunRecord | undefined;
    claimKickstartRun?(input: Omit<KickstartRunRecord, "attempt" | "status" | "observableOutput" | "createdAtMs" | "updatedAtMs">): KickstartClaim;
    updateKickstartRun?(agentId: string, clientNonce: string, update: Partial<Pick<KickstartRunRecord, "status" | "turnId" | "provider" | "model" | "observableOutput" | "result" | "error">>): KickstartRunRecord | undefined;
    cancelKickstartRun?(agentId: string, clientNonce: string): KickstartRunRecord | undefined;
    reconcileKickstartRuns?(nowMs?: number): number;
}

export interface ProviderContextResult {
    messages: ProviderChatMessage[];
    truncated: boolean;
    modelBudget?: ModelContextBudget;
}

type TranscriptSnapshotPayload = {
    type: "snapshot";
    agentId: string;
    activeAgentId: string;
    conversationId?: string;
    entries: TranscriptEntry[];
    truncated?: boolean;
    resyncRequired?: boolean;
    method?: "openAgentTail";
    ordered?: { replicaKey: string; epoch: string; sequence: number };
};

interface TurnReasoningState {
    enabled: boolean;
    open: boolean;
    ended: boolean;
    seenContent: boolean;
    bytes: number;
}

interface TurnMetadata extends ResolvedProvider {
    serviceTierActual?: Array<"priority" | "default" | "unknown">;
    memoryContextSources?: MemoryContextSource[];
    turnId: string;
    conversationId?: string;
    clientNonce?: string;
    retryOfClientNonce?: string;
    phase: TurnAttemptPhase;
    responseLimited?: boolean;
    contextNoticePublished?: boolean;
    streamController?: AbortController;
    finalized?: boolean;
    contentStarted?: boolean;
    reasoning?: TurnReasoningState;
    isResume?: boolean;
    resumeCursor?: string;
    providerAttemptsUsed?: number;
    toolRoundsUsed?: number;
    toolCallsUsed?: number;
    completedEffectIds?: string[];
}

interface LiveAssistantState {
    id: string;
    content: string;
    lastPublishMs: number;
    lastPersistMs: number;
    limited: boolean;
    replicaKey: string;
    epoch: string;
    sequence: number;
    lastSnapshotSequence: number;
    needsBaseline?: boolean;
}

type TranscriptMemoryStore = MemoryStore;
type MemoryCapableTranscriptStore = TranscriptStore & {
    memoryStore?: TranscriptMemoryStore;
    getLatestSequenceId?: (agentId: string, conversationId?: string) => number | null;
};
interface MemoryTurnContext {
    mode: MemoryMode;
    conversation: ConversationContextInfo;
}

type TurnOrigin =
    | { kind: "user" }
    | { kind: "agent"; agentId: string };

type MutableResumeEffectRecord = {
    -readonly [Key in keyof ResumeEffectRecord]: ResumeEffectRecord[Key];
} & Pick<ResumeCheckpointScope, "provider" | "model">;

export interface TurnRunnerOptions {
    store?: TranscriptStore;
    conversationStore?: ConversationStoreLike;
    registry?: ProviderRegistry;
    admission?: ProviderAdmissionScheduler;
    publish?: (channel: string, payload: unknown) => void;
    systemPrompt?: (agentId: string) => string;
    resolveProvider?: (agentId: string, args: SandSendPromptArgs) => ResolvedProvider;
    config?: ConfigStore;
    now?: () => number;
    newId?: (role: "user" | "assistant") => string;
    ledgerCap?: number;
    executionBroker?: LocalExecutionBroker;
    resolveHostPermission?: ToolLoopOptions["resolveHostPermission"];
    toolExecutor?: ToolCallExecutor;
    tools?: ProviderTool[] | ((agentId: string, signal?: AbortSignal) => ProviderTool[] | Promise<ProviderTool[]>);
    toolDiscoveryNotice?: (agentId: string) => string | undefined;
    activity?: AgentActivityStore;
    readAttachments?: (
        agentId: string,
        attachments: SandSendPromptArgs["attachments"],
        signal?: AbortSignal,
        extras?: { provider?: string; model?: string; conversationId?: string; retry?: boolean },
    ) => Promise<ExtractedAttachment[]>;
    resolveTurnContext?: (
        agentId: string,
        args: SandSendPromptArgs,
        signal?: AbortSignal,
    ) => Promise<string | TurnContextResolution>;
    wakeMemoryWorker?: () => void;
    /** Read-only, fail-closed readiness gate run before a kickstart claim. */
    resolveKickstartReadiness?: (agentId: string, inference: ResolvedProvider) => void | Promise<void>;
}
/**
 * T10 — Turn runner mínimo (plano §3 T10; spec §3.1/§3.2; mapa-frontend §3.3/§3.4).
 *
 * Pipeline envio → stream → transcript → SSE:
 *   POST /api/sendPrompt ({agentId, prompt, richText?, attachments?, clientNonce?})
 *     → {accepted:true} após persistir o transcript (envelope RPC {ok,value});
 *   - fila EXCLUSIVA por agente: turns do MESMO agente serializam; agentes
 *     diferentes rodam em paralelo;
 *   - dedupe por clientNonce (ledger de aceitação, mapa-funcoes §5.1/§5.3): o
 *     retry do MESMO nonce retorna accepted SEM rodar de novo;
 *   - monta system prompt + transcript (entries kind "message" → mensagens do
 *     diálogo) e chama `streamChat` do roteador (T5);
 *   - emite eventos SSE `transcript`: `snapshot` no início (reset) e `appended`
 *     no tail, com entries `message`/`send-message`/`user-attachment`/
 *     `tool-call`/`notice` nos kinds e `message.type` EXATOS do contrato;
 *     respostas de texto do assistente usam uma única entry `message`, enquanto
 *     cards `send-message` continuam reservados para payloads não textuais.
 *     (src/shared/contracts.ts + fixtures golden — "nenhum card missing").
 *
 * Persistência: EM MEMÓRIA nesta tarefa (store sqlite = T11). O runner só
 * depende da interface `TranscriptStore` (getEntries/append), INJETÁVEL:
 * T11 pluga a implementação sqlite sem tocar no runner.
 *
 * Registro no gateway: `registerSendPromptHandler(gateway, opts)` (aqui) e
 * `registerRpcHandlers(gateway, opts)` (src/rpc/index.ts — mesa da Onda 2).
 */
import { createHash, randomUUID } from "node:crypto";
import { isCatalogProvider, type ModelResolution } from "../providers/model-catalog.js";
import { MODEL_CATALOG } from "../config/models.js";
import { makeToolCallEntry, stableToolCallId, toolCallLocalId, toolCallSummary } from "../execution/tool-card.js";
import { MAX_TOOL_ROUNDS, runToolLoop } from "../execution/tool-loop.js";
import { previewFromText } from "./activity.js";
import { MAX_LIVE_RESPONSE_BYTES, STREAM_PERSIST_INTERVAL_MS, STREAM_PUBLISH_INTERVAL_MS, splitTranscriptFragments, } from "./stream-state.js";
import { DEFAULT_SYSTEM_PROMPT, resolveAgentInference } from "./identity.js";
import { MAX_ATTACHMENTS_PER_TURN, formatAttachmentContext } from "./attachments.js";
import { composeToolExecutors } from "../integrations/shared-tools.js";
import { buildMemorySystemGuidance, ContextAssembler, CONTEXT_HARD_LIMIT_BYTES, CONVERSATION_COMPACTION_SEQUENCE_INTERVAL, createMemoryForgetTool, createMemoryRememberTool, createMemorySearchTool, executeMemoryForgetTool, executeMemoryRememberTool, executeMemorySearchTool, isContextOverflowError, isExplicitMemoryIntent, MEMORY_FORGET_TOOL_NAME, MEMORY_REMEMBER_TOOL_NAME, MEMORY_SEARCH_TOOL_NAME, OPENBOT_UNTRUSTED_MEMORY_CONTEXT_BEGIN, OPENBOT_UNTRUSTED_MEMORY_CONTEXT_NOTE, planReflectionJob, shouldCompactConversationContext, } from "../memory/context.js";
import { providerSupportsImages, providerSupportsReasoning, resolveProviderCapabilities } from "../providers/capabilities.js";
import { sanitizeDisplayFilename } from "../attachments/staging.js";
import { computeModelContextBudget, classifyProviderMessageTokens, createContextTokenizer, fitProviderMessagesToByteBudget, prepareProviderRound, resolveModelCapabilities, selectCompleteMessageGroups, type ModelContextBudget, } from "../memory/model-context.js";
const DEFAULT_TRANSCRIPT_PAGE_LIMIT = 50;
const MAX_TRANSCRIPT_PAGE_LIMIT = 1000;
const SNAPSHOT_PAGE_LIMIT = 500;
import { defaultRegistry, streamChat, } from "../providers/router.js";
import { RpcError, SSE_MAX_FRAME_BYTES } from "../server/gateway.js";
import { transcriptAgentRef, transcriptUserRef, normalizeTranscriptEntry, } from "../shared/contracts.js";
/** Implementação em memória do `TranscriptStore` (T10 — persistência mínima). */
export function createMemoryTranscriptStore(): TranscriptStore {
    const DEFAULT_CONVERSATION = "__default__";
    const byAgent = new Map<string, Map<string, TranscriptEntry[]>>();
    const acceptedNonces = new Map<string, Map<string, Set<string>>>();
    const acceptedNonceOrder = new Map<string, Array<{ nonce: string; conversationId: string }>>();
    const completedNonces = new Map<string, Map<string, Map<string, TurnAttemptCompletion>>>();
    const kickstartRuns = new Map<string, KickstartRunRecord>();
    const toolCallIds = new Map<string, Map<string, Map<string, string>>>();
    const liveEntries = new Map<string, Map<string, Map<string, TranscriptEntry>>>();
    const activeConversations = new Map<string, string>();
    const conversationsByAgent = new Map<string, Map<string, Conversation>>();
    const now = () => Date.now();
    const createConversationRecord = (agentId: string, id: string, title = "Nova conversa", titleSource: "auto" | "manual" = "auto", temporary = false): Conversation => ({
        id,
        agentId,
        title,
        titleSource,
        temporary,
        archivedAtMs: null,
        createdAtMs: now(),
        updatedAtMs: now(),
        lastMessageAtMs: null,
    });
    const conversationFor = (agentId: string, conversationId: string): Conversation | undefined => conversationsByAgent.get(agentId)?.get(conversationId);
    const validateMemoryConversation = (agentId: string, conversationId?: string): void => {
        if (conversationId !== undefined && !conversationFor(agentId, conversationId)) {
            throw new Error("conversation não encontrada para o agente");
        }
    };
    const ensureConversationRecord = (agentId: string, conversationId: string): Conversation => {
        let conversations = conversationsByAgent.get(agentId);
        if (conversations === undefined) {
            conversations = new Map();
            conversationsByAgent.set(agentId, conversations);
        }
        let conversation = conversations.get(conversationId);
        if (conversation === undefined) {
            conversation = createConversationRecord(agentId, conversationId);
            conversations.set(conversationId, conversation);
        }
        return conversation;
    };
    const turnAttempts = new Map<string, TurnAttemptRecord>();
    const resumeCheckpoints = new Map<string, ResumeCheckpoint>();
    const resumeEffects = new Map<string, MutableResumeEffectRecord>();
    const conversationKey = (conversationId?: string): string => conversationId ?? DEFAULT_CONVERSATION;
    const resumeScopeKey = (scope: ResumeCheckpointScope): string =>
        `${scope.agentId}\u0000${scope.conversationId}\u0000${scope.turnId}`;
    const resumeEffectKey = (scope: ResumeCheckpointScope, effectId: string): string =>
        `${resumeScopeKey(scope)}\u0000${effectId}`;
    const entriesFor = (agentId: string, conversationId?: string, create = false): TranscriptEntry[] => {
        let conversations = byAgent.get(agentId);
        if (conversations === undefined) {
            if (!create)
                return [];
            conversations = new Map();
            byAgent.set(agentId, conversations);
        }
        const key = conversationKey(conversationId ?? activeConversations.get(agentId));
        let entries = conversations.get(key);
        if (entries === undefined) {
            if (!create)
                return [];
            entries = [];
            conversations.set(key, entries);
        }
        return entries;
    };
    const liveFor = (agentId: string, conversationId?: string, create = false): Map<string, TranscriptEntry> | undefined => {
        let conversations = liveEntries.get(agentId);
        if (conversations === undefined) {
            if (!create)
                return undefined;
            conversations = new Map();
            liveEntries.set(agentId, conversations);
        }
        const key = conversationKey(conversationId ?? activeConversations.get(agentId));
        let entries = conversations.get(key);
        if (entries === undefined && create) {
            entries = new Map();
            conversations.set(key, entries);
        }
        return entries;
    };
    const mergeLive = (agentId: string, conversationId: string | undefined, entries: readonly TranscriptEntry[]): TranscriptEntry[] => {
        const live = liveFor(agentId, conversationId);
        if (live === undefined || live.size === 0)
            return entries.map((entry) => normalizeTranscriptEntry(entry));
        const consumed = new Set<string>();
        const merged = entries.map((entry) => {
            const id = typeof entry.id === "string" ? entry.id : undefined;
            const preview = id === undefined ? undefined : live.get(id);
            if (id !== undefined && preview !== undefined)
                consumed.add(id);
            return normalizeTranscriptEntry(preview ?? entry);
        });
        for (const [id, preview] of live)
            if (!consumed.has(id))
                merged.push(normalizeTranscriptEntry(preview));
        return merged;
    };
    const indexEntries = (agentId: string, conversationId: string | undefined, entries: readonly TranscriptEntry[]): void => {
        let byConversation = toolCallIds.get(agentId);
        if (byConversation === undefined) {
            byConversation = new Map();
            toolCallIds.set(agentId, byConversation);
        }
        const resolvedConversationId = conversationId ?? activeConversations.get(agentId);
        let ids = byConversation.get(conversationKey(resolvedConversationId));
        if (ids === undefined) {
            ids = new Map();
            byConversation.set(conversationKey(resolvedConversationId), ids);
        }
        for (const entry of entries) {
            const localToolCallId = entry.kind === "tool-call" && typeof entry.localToolCallId === "string"
                ? entry.localToolCallId
                : undefined;
            if (localToolCallId === undefined || typeof entry.id !== "string")
                continue;
            ids ??= new Map();
            ids.set(localToolCallId, entry.id);
        }
    };
    const activeConversation = (agentId: string): Conversation | null => {
        const activeId = activeConversations.get(agentId);
        const active = activeId === undefined ? undefined : conversationFor(agentId, activeId);
        if (active && active.archivedAtMs === null)
            return active;
        const fallback = [...(conversationsByAgent.get(agentId)?.values() ?? [])]
            .filter((conversation) => conversation.archivedAtMs === null)
            .sort((left, right) => right.updatedAtMs - left.updatedAtMs || right.id.localeCompare(left.id))[0];
        if (fallback) {
            activeConversations.set(agentId, fallback.id);
            return fallback;
        }
        return null;
    };
    const memoryConversationStore: ConversationStoreLike = {
        ensureDefault(agentId) {
            const current = activeConversation(agentId);
            if (current)
                return current;
            const id = DEFAULT_CONVERSATION;
            const created = ensureConversationRecord(agentId, id);
            activeConversations.set(agentId, id);
            return created;
        },
        getActive(agentId) {
            return activeConversation(agentId);
        },
        list(agentId, options = {}) {
            const items = [...(conversationsByAgent.get(agentId)?.values() ?? [])]
                .sort((left, right) => right.updatedAtMs - left.updatedAtMs || right.id.localeCompare(left.id));
            const limit = options.limit ?? 50;
            return { items: items.slice(0, limit) };
        },
        create(agentId, options = {}) {
            const id = randomUUID();
            const title = options.title?.trim() || "Nova conversa";
            const conversation = createConversationRecord(agentId, id, title, options.title ? "manual" : "auto", options.temporary === true);
            const conversations = conversationsByAgent.get(agentId) ?? new Map();
            conversations.set(id, conversation);
            conversationsByAgent.set(agentId, conversations);
            activeConversations.set(agentId, id);
            return conversation;
        },
        activate(agentId, conversationId) {
            const conversation = conversationFor(agentId, conversationId);
            if (!conversation)
                throw new Error("conversation não encontrada para o agente");
            if (conversation.archivedAtMs !== null)
                throw new Error("não é possível ativar conversa arquivada");
            activeConversations.set(agentId, conversationId);
            return conversation;
        },
        rename(agentId, conversationId, title) {
            const conversation = conversationFor(agentId, conversationId);
            if (!conversation)
                throw new Error("conversation não encontrada para o agente");
            conversation.title = title.trim();
            conversation.titleSource = "manual";
            conversation.updatedAtMs = now();
            return conversation;
        },
        archive(agentId, conversationId) {
            const conversation = conversationFor(agentId, conversationId);
            if (!conversation)
                throw new Error("conversation não encontrada para o agente");
            const live = [...(conversationsByAgent.get(agentId)?.values() ?? [])].filter((item) => item.archivedAtMs === null);
            if (conversation.archivedAtMs === null && live.length <= 1)
                throw new Error("não é possível arquivar a única conversa restante");
            conversation.archivedAtMs = now();
            conversation.updatedAtMs = conversation.archivedAtMs;
            if (activeConversations.get(agentId) === conversationId) {
                const next = live.find((item) => item.id !== conversationId && item.archivedAtMs === null);
                if (next)
                    activeConversations.set(agentId, next.id);
            }
            return conversation;
        },
        delete(agentId, conversationId, options) {
            const conversation = conversationFor(agentId, conversationId);
            if (!conversation)
                throw new Error("conversation não encontrada para o agente");
            const all = conversationsByAgent.get(agentId);
            if (!all || all.size <= 1)
                throw new Error("não é possível deletar a única conversa restante");
            const live = [...all.values()].filter((item) => item.archivedAtMs === null);
            if (conversation.archivedAtMs === null && live.length <= 1)
                throw new Error("não é possível deletar a última conversa não arquivada");
            all.delete(conversationId);
            byAgent.get(agentId)?.delete(conversationId);
            toolCallIds.get(agentId)?.delete(conversationId);
            liveEntries.get(agentId)?.delete(conversationId);
            const byNonce = acceptedNonces.get(agentId);
            for (const [nonce, conversations] of byNonce ?? []) {
                conversations.delete(conversationId);
                if (conversations.size === 0)
                    byNonce?.delete(nonce);
            }
            acceptedNonceOrder.set(agentId, (acceptedNonceOrder.get(agentId) ?? []).filter((item) => item.conversationId !== conversationId));
            const completedByNonce = completedNonces.get(agentId);
            for (const [nonce, conversations] of completedByNonce ?? []) {
                conversations.delete(conversationId);
                if (conversations.size === 0)
                    completedByNonce?.delete(nonce);
            }
            for (const [key, run] of kickstartRuns) {
                if (run.agentId === agentId && run.conversationId === conversationId) kickstartRuns.delete(key);
            }
            if (activeConversations.get(agentId) === conversationId) {
                const next = [...all.values()].filter((item) => item.archivedAtMs === null).sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
                if (next)
                    activeConversations.set(agentId, next.id);
            }
            return { conversationId, memoryPolicy: options.memoryPolicy };
        },
        updateAutoTitle(agentId, conversationId, firstUserText) {
            const conversation = conversationFor(agentId, conversationId);
            if (!conversation)
                throw new Error("conversation não encontrada para o agente");
            const text = firstUserText.trim();
            if (text && conversation.titleSource === "auto" && ["Nova conversa", "New conversation", "New chat"].includes(conversation.title)) {
                conversation.title = text;
                conversation.updatedAtMs = now();
            }
            return conversation;
        },
        clear(agentId) {
            conversationsByAgent.delete(agentId);
            byAgent.delete(agentId);
            acceptedNonces.delete(agentId);
            acceptedNonceOrder.delete(agentId);
            completedNonces.delete(agentId);
            for (const [key, run] of kickstartRuns)
                if (run.agentId === agentId) kickstartRuns.delete(key);
            toolCallIds.delete(agentId);
            liveEntries.delete(agentId);
            activeConversations.delete(agentId);
            for (const [turnId, attempt] of turnAttempts)
                if (attempt.agentId === agentId)
                    turnAttempts.delete(turnId);
        },
    };
    return {
        conversationStore: memoryConversationStore,
        getEntries(agentId, conversationId) {
            return mergeLive(agentId, conversationId, entriesFor(agentId, conversationId));
        },
        validateConversation(agentId, conversationId) {
            if (!conversationFor(agentId, conversationId))
                throw new Error("conversation não encontrada para o agente");
        },
        append(agentId, entries, conversationId) {
            const list = entriesFor(agentId, conversationId, true);
            list.push(...entries);
            indexEntries(agentId, conversationId, entries);
            const resolvedConversationId = conversationId ?? activeConversations.get(agentId);
            const domainId = resolvedConversationId ?? DEFAULT_CONVERSATION;
            const conversation = ensureConversationRecord(agentId, domainId);
            const timestamps = entries
                .map((entry) => entry.kind === "message" ? entry.timestampMs : undefined)
                .filter((timestamp) => typeof timestamp === "number" && Number.isFinite(timestamp));
            const latest = timestamps.at(-1) ?? now();
            conversation.updatedAtMs = Math.max(conversation.updatedAtMs, latest);
            if (entries.some((entry) => entry.kind === "message"))
                conversation.lastMessageAtMs = Math.max(conversation.lastMessageAtMs ?? 0, latest);
        },
        getActiveConversationId(agentId) {
            return activeConversations.get(agentId);
        },
        setActiveConversationId(agentId, conversationId) {
            if (conversationId === undefined)
                activeConversations.delete(agentId);
            else
                activeConversations.set(agentId, conversationId);
        },
        beginTurnAttempt(attempt) {
            turnAttempts.set(attempt.turnId, structuredClone(attempt));
        },
        updateTurnAttempt(agentId, turnId, phase) {
            const attempt = turnAttempts.get(turnId);
            if (attempt?.agentId === agentId)
                turnAttempts.set(turnId, { ...attempt, phase });
        },
        finishTurnAttempt(agentId, turnId) {
            const attempt = turnAttempts.get(turnId);
            if (attempt?.agentId !== agentId)
                return;
            if (attempt.clientNonce !== undefined) {
                const resolvedConversationId = conversationKey(attempt.conversationId ?? activeConversations.get(agentId));
                if (acceptedNonces.get(agentId)?.get(attempt.clientNonce)?.has(resolvedConversationId)) {
                    let byNonce = completedNonces.get(agentId);
                    if (byNonce === undefined) {
                        byNonce = new Map();
                        completedNonces.set(agentId, byNonce);
                    }
                    const conversations = byNonce.get(attempt.clientNonce) ?? new Map();
                    conversations.set(resolvedConversationId, { turnId, completedAtMs: now() });
                    byNonce.set(attempt.clientNonce, conversations);
                }
            }
            turnAttempts.delete(turnId);
        },
        createResumeCheckpoint(checkpoint) {
            const key = resumeScopeKey(checkpoint);
            if (resumeCheckpoints.has(key))
                return false;
            resumeCheckpoints.set(key, structuredClone(checkpoint));
            return true;
        },
        getResumeCheckpoint(scope) {
            const checkpoint = resumeCheckpoints.get(resumeScopeKey(scope));
            if (checkpoint === undefined) return undefined;
            if (checkpoint.provider !== scope.provider || checkpoint.model !== scope.model)
                return undefined;
            return structuredClone(checkpoint);
        },
        findResumeCheckpoint(agentId, conversationId, turnId) {
            const checkpoint = resumeCheckpoints.get(resumeScopeKey({ agentId, conversationId, turnId, provider: "", model: "" }));
            return checkpoint === undefined ? undefined : structuredClone(checkpoint);
        },
        advanceResumeCheckpoint(scope, expectedVersion, update) {
            const checkpoint = resumeCheckpoints.get(resumeScopeKey(scope));
            if (checkpoint === undefined)
                throw new Error("resume checkpoint not found");
            if (checkpoint.version !== expectedVersion || update.safeSequenceId < checkpoint.safeSequenceId)
                throw new Error("resume checkpoint CAS rejected");
            const next = { ...checkpoint, ...update, version: checkpoint.version + 1 };
            resumeCheckpoints.set(resumeScopeKey(scope), next);
            return structuredClone(next);
        },
        prepareResumeEffect(scope, effectId, fingerprintHash) {
            const key = resumeEffectKey(scope, effectId);
            const existing = resumeEffects.get(key);
            if (existing !== undefined) {
                if (existing.fingerprintHash !== fingerprintHash)
                    throw new Error("resume effect key reused with different fingerprint");
                return structuredClone(existing);
            }
            const record: MutableResumeEffectRecord = {
                ...scope,
                effectId,
                fingerprintHash,
                status: "prepared",
                createdAtMs: now(),
            };
            resumeEffects.set(key, record);
            return structuredClone(record);
        },
        markResumeEffectStarted(scope, effectId) {
            const key = resumeEffectKey(scope, effectId);
            const existing = resumeEffects.get(key);
            if (existing === undefined)
                return undefined;
            if (existing.status === "prepared") {
                existing.status = "started";
                existing.startedAtMs = now();
            }
            return structuredClone(existing);
        },
        markResumeEffectUnsafe(scope, effectId) {
            const key = resumeEffectKey(scope, effectId);
            const existing = resumeEffects.get(key);
            if (existing === undefined)
                return undefined;
            if (existing.status === "prepared" || existing.status === "started")
                existing.status = "unsafe";
            return structuredClone(existing);
        },
        getResumeEffect(scope, effectId) {
            const existing = resumeEffects.get(resumeEffectKey(scope, effectId));
            return existing === undefined ? undefined : structuredClone(existing);
        },
        hasUnsafeResumeEffect(scope) {
            for (const effect of resumeEffects.values()) {
                if (effect.agentId === scope.agentId &&
                    effect.conversationId === scope.conversationId &&
                    effect.turnId === scope.turnId &&
                    effect.provider === scope.provider &&
                    effect.model === scope.model &&
                    effect.status === "unsafe") return true;
            }
            return false;
        },
        completeResumeEffect(scope, effectId, fingerprintHash, result) {
            const existing = resumeEffects.get(resumeEffectKey(scope, effectId));
            if (existing === undefined)
                throw new Error("resume effect is not claimed");
            if (existing.fingerprintHash !== fingerprintHash)
                throw new Error("resume effect fingerprint conflict");
            if (existing.status === "unsafe")
                throw new Error("resume effect is unsafe");
            existing.status = "completed";
            existing.result = boundedResumeResult(result);
            existing.completedAtMs = now();
            return structuredClone(existing);
        },
        commitResumeEffectAndCheckpoint(input) {
            const checkpoint = resumeCheckpoints.get(resumeScopeKey(input.scope));
            if (checkpoint === undefined)
                throw new Error("resume checkpoint not found");
            const effect = resumeEffects.get(resumeEffectKey(input.scope, input.effectId));
            if (effect === undefined)
                throw new Error("resume effect is not claimed");
            if (effect.fingerprintHash !== input.fingerprintHash)
                throw new Error("resume effect fingerprint conflict");
            if (effect.status === "unsafe")
                throw new Error("resume effect is unsafe");
            if (checkpoint.version !== input.checkpoint.expectedVersion)
                throw new Error("resume checkpoint CAS rejected");
            if (input.checkpoint.safeSequenceId < checkpoint.safeSequenceId)
                throw new Error("resume checkpoint sequence regressed");
            const completedEffectIds = [...new Set(input.checkpoint.completedEffectIds)];
            if (!completedEffectIds.includes(input.effectId) || completedEffectIds.length > 128)
                throw new Error("resume checkpoint effect ledger inválido");
            const boundedResult = boundedResumeResult(input.result);
            if (effect.status !== "completed") {
                effect.status = "completed";
                effect.result = boundedResult;
                effect.completedAtMs = now();
                for (const entry of input.transcriptEntries ?? []) {
                    const list = entriesFor(input.scope.agentId, input.scope.conversationId, true);
                    list.push(entry);
                    indexEntries(input.scope.agentId, input.scope.conversationId, [entry]);
                }
            }
            const next = { ...checkpoint, cursor: input.checkpoint.cursor, safeSequenceId: input.checkpoint.safeSequenceId, completedEffectIds, expiresAtMs: input.checkpoint.expiresAtMs, version: checkpoint.version + 1, budget: input.checkpoint.budget };
            resumeCheckpoints.set(resumeScopeKey(input.scope), next);
            return structuredClone(next);
        },
        reconcileResumeEffects(agentId, nowMs = now()) {
            let changed = 0;
            for (const effect of resumeEffects.values()) {
                if (effect.agentId === agentId && effect.status === "started") {
                    effect.status = "unsafe";
                    changed += 1;
                }
            }
            for (const [key, checkpoint] of resumeCheckpoints) {
                if (checkpoint.agentId === agentId && checkpoint.expiresAtMs <= nowMs)
                    resumeCheckpoints.delete(key);
            }
            return changed;
        },
        hasCompletedTurnForNonce(agentId, nonce, conversationId) {
            validateMemoryConversation(agentId, conversationId);
            const resolvedConversationId = conversationKey(conversationId ?? activeConversations.get(agentId));
            return completedNonces.get(agentId)?.get(nonce)?.has(resolvedConversationId) ?? false;
        },
        clear(agentId) {
            byAgent.delete(agentId);
            acceptedNonces.delete(agentId);
            acceptedNonceOrder.delete(agentId);
            completedNonces.delete(agentId);
            toolCallIds.delete(agentId);
            liveEntries.delete(agentId);
            activeConversations.delete(agentId);
            conversationsByAgent.delete(agentId);
            for (const [turnId, attempt] of turnAttempts)
                if (attempt.agentId === agentId)
                    turnAttempts.delete(turnId);
            for (const [key, checkpoint] of resumeCheckpoints)
                if (checkpoint.agentId === agentId) resumeCheckpoints.delete(key);
            for (const [key, effect] of resumeEffects)
                if (effect.agentId === agentId) resumeEffects.delete(key);
            for (const [key, run] of kickstartRuns)
                if (run.agentId === agentId) kickstartRuns.delete(key);
        },
        snapshotAgent(agentId) {
            const partitions = [...(byAgent.get(agentId)?.entries() ?? [])].map(([conversationId, entries]) => ({
                ...(conversationId === DEFAULT_CONVERSATION ? {} : { conversationId }),
                entries: entries.map((entry) => normalizeTranscriptEntry(entry)),
            }));
            const bindings: Array<{ nonce: string; conversationId?: string }> = [];
            for (const [nonce, conversations] of acceptedNonces.get(agentId) ?? []) {
                for (const conversationId of conversations)
                    bindings.push({
                        nonce,
                        ...(conversationId === DEFAULT_CONVERSATION ? {} : { conversationId }),
                    });
            }
            return {
                entries: partitions.flatMap((partition) => partition.entries),
                acceptedNonces: bindings.map((binding) => binding.nonce),
                interactionDecisions: [],
                conversationEntries: partitions,
                activeConversationId: activeConversations.get(agentId) ?? null,
                conversations: [...(conversationsByAgent.get(agentId)?.values() ?? [])].map((conversation) => ({ ...conversation })),
                acceptedNonceBindings: bindings,
                completedNonceBindings: [...(completedNonces.get(agentId)?.entries() ?? [])].flatMap(([nonce, conversations]) => ([...conversations.entries()].map(([conversationId, completion]) => ({
                    nonce,
                    ...(conversationId === DEFAULT_CONVERSATION ? {} : { conversationId }),
                    ...completion,
                })))),
                kickstartRuns: [...kickstartRuns.values()]
                    .filter((run) => run.agentId === agentId)
                    .map((run) => structuredClone(run)),
            };
        },
        restoreAgent(agentId, snapshot) {
            liveEntries.delete(agentId);
            const partitions: Array<[string, TranscriptEntry[]]> = snapshot.conversationEntries?.map((partition) => [
                conversationKey(partition.conversationId),
                partition.entries.map((entry) => normalizeTranscriptEntry(entry)),
            ] as [string, TranscriptEntry[]]) ?? (snapshot.entries.length > 0
                ? [[DEFAULT_CONVERSATION, snapshot.entries.map((entry) => normalizeTranscriptEntry(entry))]]
                : []);
            if (partitions.length > 0)
                byAgent.set(agentId, new Map(partitions));
            else
                byAgent.delete(agentId);
            conversationsByAgent.delete(agentId);
            if (snapshot.conversations !== undefined) {
                conversationsByAgent.set(agentId, new Map(snapshot.conversations.map((conversation) => [conversation.id, { ...conversation }])));
            }
            else {
                const inferred = new Map<string, Conversation>();
                for (const [conversationId] of partitions) {
                    const id = conversationId;
                    inferred.set(id, createConversationRecord(agentId, id));
                }
                if (inferred.size > 0)
                    conversationsByAgent.set(agentId, inferred);
            }
            toolCallIds.delete(agentId);
            for (const [conversationId, entries] of partitions)
                indexEntries(agentId, conversationId, entries);
            activeConversations.delete(agentId);
            if (snapshot.activeConversationId !== undefined && snapshot.activeConversationId !== null) {
                activeConversations.set(agentId, snapshot.activeConversationId);
            }
            acceptedNonces.delete(agentId);
            acceptedNonceOrder.delete(agentId);
            completedNonces.delete(agentId);
            const bindings: Array<{ nonce: string; conversationId?: string }> = snapshot.acceptedNonceBindings
                ?? snapshot.acceptedNonces.map((nonce) => ({ nonce }));
            for (const binding of bindings) {
                const conversationId = conversationKey(binding.conversationId);
                let byNonce = acceptedNonces.get(agentId);
                if (byNonce === undefined) {
                    byNonce = new Map();
                    acceptedNonces.set(agentId, byNonce);
                }
                let conversations = byNonce.get(binding.nonce);
                if (conversations === undefined) {
                    conversations = new Set();
                    byNonce.set(binding.nonce, conversations);
                }
                if (!conversations.has(conversationId)) {
                    conversations.add(conversationId);
                    const order = acceptedNonceOrder.get(agentId) ?? [];
                    order.push({ nonce: binding.nonce, conversationId });
                    acceptedNonceOrder.set(agentId, order);
                }
            }
            for (const completion of snapshot.completedNonceBindings ?? []) {
                const conversationId = conversationKey(completion.conversationId);
                let byNonce = completedNonces.get(agentId);
                if (byNonce === undefined) {
                    byNonce = new Map();
                    completedNonces.set(agentId, byNonce);
                }
                const conversations = byNonce.get(completion.nonce) ?? new Map();
                conversations.set(conversationId, { turnId: completion.turnId, completedAtMs: completion.completedAtMs });
                byNonce.set(completion.nonce, conversations);
            }
            for (const run of snapshot.kickstartRuns ?? []) {
                if (run.agentId !== agentId) continue;
                kickstartRuns.set(`${agentId}\u0000${run.clientNonce}`, structuredClone(run));
            }
        },
        hasAcceptedNonce(agentId, nonce, conversationId) {
            validateMemoryConversation(agentId, conversationId);
            const byNonce = acceptedNonces.get(agentId);
            const conversations = byNonce?.get(nonce);
            return conversations?.has(conversationKey(conversationId ?? activeConversations.get(agentId))) ?? false;
        },
        findAcceptedNonceConversations(agentId, nonce) {
            const conversations = acceptedNonces.get(agentId)?.get(nonce);
            return [...(conversations ?? [])];
        },
        claimAcceptedNonce(agentId, nonce, conversationId) {
            validateMemoryConversation(agentId, conversationId);
            const resolvedConversationId = conversationKey(conversationId ?? activeConversations.get(agentId));
            let byNonce = acceptedNonces.get(agentId);
            if (byNonce === undefined) {
                byNonce = new Map();
                acceptedNonces.set(agentId, byNonce);
            }
            let conversations = byNonce.get(nonce);
            if (conversations === undefined) {
                conversations = new Set();
                byNonce.set(nonce, conversations);
            }
            if (conversations.has(resolvedConversationId))
                return false;
            conversations.add(resolvedConversationId);
            const order = acceptedNonceOrder.get(agentId) ?? [];
            order.push({ nonce, conversationId: resolvedConversationId });
            acceptedNonceOrder.set(agentId, order);
            return true;
        },
        rememberAcceptedNonce(agentId, nonce, conversationId) {
            validateMemoryConversation(agentId, conversationId);
            const resolvedConversationId = conversationKey(conversationId ?? activeConversations.get(agentId));
            let byNonce = acceptedNonces.get(agentId);
            if (byNonce === undefined) {
                byNonce = new Map();
                acceptedNonces.set(agentId, byNonce);
            }
            let conversations = byNonce.get(nonce);
            if (conversations === undefined) {
                conversations = new Set();
                byNonce.set(nonce, conversations);
            }
            if (conversations.has(resolvedConversationId))
                return;
            conversations.add(resolvedConversationId);
            const order = acceptedNonceOrder.get(agentId) ?? [];
            order.push({ nonce, conversationId: resolvedConversationId });
            acceptedNonceOrder.set(agentId, order);
        },
        forgetAcceptedNonce(agentId, nonce, conversationId) {
            validateMemoryConversation(agentId, conversationId);
            const resolvedConversationId = conversationKey(conversationId ?? activeConversations.get(agentId));
            const byNonce = acceptedNonces.get(agentId);
            const conversations = byNonce?.get(nonce);
            conversations?.delete(resolvedConversationId);
            if (conversations?.size === 0)
                byNonce?.delete(nonce);
            const completed = completedNonces.get(agentId)?.get(nonce);
            completed?.delete(resolvedConversationId);
            if (completed?.size === 0)
                completedNonces.get(agentId)?.delete(nonce);
        },
        getKickstartRun(agentId, clientNonce) {
            const run = kickstartRuns.get(`${agentId}\u0000${clientNonce}`);
            return run === undefined ? undefined : structuredClone(run);
        },
        claimKickstartRun(input) {
            const key = `${input.agentId}\u0000${input.clientNonce}`;
            const existing = kickstartRuns.get(key);
            const nowMs = now();
            if (existing !== undefined) {
                if (existing.status === "retryable" && !existing.observableOutput) {
                    const next = {
                        ...existing,
                        ...input,
                        attempt: existing.attempt + 1,
                        status: "queued" as const,
                        turnId: undefined,
                        observableOutput: false,
                        result: undefined,
                        error: undefined,
                        updatedAtMs: nowMs,
                    };
                    kickstartRuns.set(key, next);
                    return { run: structuredClone(next), claimed: true };
                }
                return { run: structuredClone(existing), claimed: false };
            }
            const created: KickstartRunRecord = {
                ...input,
                version: 1,
                attempt: 1,
                status: "queued",
                observableOutput: false,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
            };
            kickstartRuns.set(key, created);
            return { run: structuredClone(created), claimed: true };
        },
        updateKickstartRun(agentId, clientNonce, update) {
            const key = `${agentId}\u0000${clientNonce}`;
            const current = kickstartRuns.get(key);
            if (current === undefined) return undefined;
            const next = { ...current, ...update, updatedAtMs: now() };
            if (next.result?.text !== undefined) next.result = { text: utf8Prefix(next.result.text, MAX_KICKSTART_RESULT_BYTES) };
            kickstartRuns.set(key, next);
            return structuredClone(next);
        },
        cancelKickstartRun(agentId, clientNonce) {
            const key = `${agentId}\u0000${clientNonce}`;
            const current = kickstartRuns.get(key);
            if (current === undefined) return undefined;
            const status = current.observableOutput ? "interrupted" : "cancelled";
            const next = { ...current, status: status as KickstartRunStatus, error: "cancelled", updatedAtMs: now() };
            kickstartRuns.set(key, next);
            return structuredClone(next);
        },
        reconcileKickstartRuns(nowMs = now()) {
            let changed = 0;
            for (const [key, current] of kickstartRuns) {
                if (current.status !== "running") continue;
                const next = {
                    ...current,
                    status: current.observableOutput ? "interrupted" as const : "retryable" as const,
                    error: current.observableOutput ? "restart-after-output" : "restart-before-output",
                    updatedAtMs: nowMs,
                };
                kickstartRuns.set(key, next);
                changed += 1;
            }
            return changed;
        },
        trimAcceptedNonces(agentId, cap) {
            const order = acceptedNonceOrder.get(agentId);
            const byNonce = acceptedNonces.get(agentId);
            if (order === undefined || byNonce === undefined)
                return;
            while (order.length > cap) {
                const oldest = order.shift();
                if (oldest === undefined)
                    break;
                const conversations = byNonce.get(oldest.nonce);
                conversations?.delete(oldest.conversationId);
                if (conversations?.size === 0)
                    byNonce.delete(oldest.nonce);
                const completed = completedNonces.get(agentId)?.get(oldest.nonce);
                completed?.delete(oldest.conversationId);
                if (completed?.size === 0)
                    completedNonces.get(agentId)?.delete(oldest.nonce);
            }
        },
        getAgentTranscriptTail(agentId, limit = DEFAULT_TRANSCRIPT_PAGE_LIMIT, beforeSeq, conversationId) {
            const entries = entriesFor(agentId, conversationId);
            if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSCRIPT_PAGE_LIMIT)
                throw new Error("limit inválido");
            if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1))
                throw new Error("beforeSeq inválido");
            const end = beforeSeq === undefined ? entries.length : Math.min(entries.length, beforeSeq - 1);
            const start = Math.max(0, end - limit);
            const page: TranscriptPage = {
                entries: entries.slice(start, end).map((entry) => normalizeTranscriptEntry(entry)),
            };
            if (start > 0)
                page.nextBeforeSeq = start + 1;
            return page;
        },
        openAgentTail(agentId, limit, beforeSeq, conversationId) {
            const page = this.getAgentTranscriptTail(agentId, limit, beforeSeq, conversationId);
            if (beforeSeq !== undefined)
                return page;
            const resolvedLimit = limit ?? DEFAULT_TRANSCRIPT_PAGE_LIMIT;
            return { ...page, entries: mergeLive(agentId, conversationId, page.entries).slice(-resolvedLimit) };
        },
        openDurableAgentTail(agentId, limit, beforeSeq, conversationId) {
            return this.getAgentTranscriptTail(agentId, limit, beforeSeq, conversationId);
        },
        setLiveEntry(agentId, entry, conversationId) {
            const id = typeof entry.id === "string" ? entry.id : undefined;
            if (id === undefined || id.length === 0)
                return;
            liveFor(agentId, conversationId, true)?.set(id, normalizeTranscriptEntry(entry));
        },
        clearLiveEntry(agentId, entryId, conversationId) {
            liveFor(agentId, conversationId)?.delete(entryId);
        },
        getConversationOutline(agentId, conversationId) {
            const entries = entriesFor(agentId, conversationId);
            const messages = entries.filter((entry) => entry.kind === "message");
            const firstUser = messages.find((entry) => entry.role === "user" && entry.content.trim().length > 0);
            const last = [...messages].reverse().find((entry) => entry.content.trim().length > 0);
            return { title: firstUser?.content ?? null, lastMessage: last?.content ?? null };
        },
        getRecentEntries(agentId, options, conversationId) {
            if (!Number.isInteger(options.limit) || options.limit < 1)
                throw new Error("limit inválido");
            const kinds = options.kinds === undefined ? undefined : new Set(options.kinds);
            const base = entriesFor(agentId, conversationId);
            const entries = kinds === undefined
                ? base
                : base.filter((entry) => kinds.has(entry.kind));
            return entries.slice(-options.limit).map((entry) => normalizeTranscriptEntry(entry));
        },
        getEarliestUser(agentId, conversationId) {
            const entry = entriesFor(agentId, conversationId).find((candidate) =>
                candidate.kind === "message" && candidate.role === "user" && candidate.content.trim().length > 0,
            );
            return entry?.kind === "message"
                ? normalizeTranscriptEntry(entry) as Extract<TranscriptEntry, { kind: "message" }>
                : undefined;
        },
        getLatestAssistant(agentId, conversationId) {
            const entries = entriesFor(agentId, conversationId);
            for (let i = entries.length - 1; i >= 0; i -= 1) {
                const entry = entries[i];
                if (entry?.kind === "message" && entry.role === "assistant") {
                    return normalizeTranscriptEntry(entry) as Extract<TranscriptEntry, { kind: "message" }>;
                }
            }
            return undefined;
        },
        getOpenToolCalls(agentId, conversationId) {
            return entriesFor(agentId, conversationId)
                .filter((entry): entry is Extract<TranscriptEntry, { kind: "tool-call" }> =>
                    entry.kind === "tool-call" && (entry.status === "pending" || entry.status === "running"),
                )
                .map((entry) => normalizeTranscriptEntry(entry) as Extract<TranscriptEntry, { kind: "tool-call" }>);
        },
        findToolCallByLocalId(agentId, localToolCallId, conversationId) {
            const byConversation = toolCallIds.get(agentId);
            const key = conversationKey(conversationId ?? activeConversations.get(agentId));
            const entryId = byConversation?.get(key)?.get(localToolCallId);
            if (entryId === undefined)
                return undefined;
            const entry = [...entriesFor(agentId, conversationId)].reverse().find((candidate) => candidate.id === entryId);
            if (entry?.kind !== "tool-call" || entry.localToolCallId !== localToolCallId) {
                byConversation?.get(key)?.delete(localToolCallId);
                return undefined;
            }
            return normalizeTranscriptEntry(entry) as Extract<TranscriptEntry, { kind: "tool-call" }>;
        },
        replaceToolCallByLocalId(agentId, localToolCallId, entry, conversationId) {
            const list = entriesFor(agentId, conversationId);
            if (list === undefined)
                return false;
            let index = -1;
            for (let candidate = list.length - 1; candidate >= 0; candidate -= 1) {
                const current = list[candidate];
                if (current?.kind === "tool-call" && current.localToolCallId === localToolCallId) {
                    index = candidate;
                    break;
                }
            }
            if (index < 0)
                return false;
            list[index] = entry;
            indexEntries(agentId, conversationId, [entry]);
            return true;
        },
        replace(agentId, entryId, entry, conversationId) {
            const list = entriesFor(agentId, conversationId);
            if (list === undefined)
                return false;
            let index = -1;
            for (let candidate = list.length - 1; candidate >= 0; candidate -= 1) {
                const id = list[candidate]?.id;
                if (typeof id === "string" && id === entryId) {
                    index = candidate;
                    break;
                }
            }
            if (index < 0)
                return false;
            const previous = list[index];
            if (previous?.kind === "tool-call" && typeof previous.localToolCallId === "string"
                && toolCallIds.get(agentId)?.get(conversationKey(conversationId ?? activeConversations.get(agentId)))?.get(previous.localToolCallId) === entryId) {
                toolCallIds.get(agentId)?.get(conversationKey(conversationId ?? activeConversations.get(agentId)))?.delete(previous.localToolCallId);
            }
            list[index] = entry;
            indexEntries(agentId, conversationId, [entry]);
            return true;
        },
    };
}
// ── Configuração default ──────────────────────────────────────────────────────
export { DEFAULT_SYSTEM_PROMPT } from "./identity.js";
/** Capacidade máxima do ledger de nonces por agente (FIFO — evita crescimento sem limite). */
export const DEFAULT_LEDGER_CAP = 1000;
/** Máximo de turnos enfileirados por agente (além do que está rodando). */
export const MAX_SEND_QUEUE_PER_AGENT = 8;
/** Máximo de mensagens de diálogo enviadas ao provider por turno. */
export const MAX_PROVIDER_TRANSCRIPT_MESSAGES = 80;
/** Wire-byte budget do modelo xAI default; modelos diferentes usam sua própria capability. */
export const MAX_PROVIDER_TEXT_CONTEXT_BYTES = 1024 * 1024;
/** Bounded operational result for hidden kickstart runs; never transcript text. */
export const MAX_KICKSTART_RESULT_BYTES = 4 * 1024;
export const MAX_KICKSTART_NONCE_BYTES = 256;
export const KICKSTART_PROMPT_VERSION = 1;
export const KICKSTART_INTERNAL_PROMPT = "Apresente-se brevemente ao usuário, em uma única resposta útil e concisa.";
function logContextTelemetry(provider: string, model: string, telemetry: ReturnType<typeof prepareProviderRound>["telemetry"]): void {
    if (process.env.NODE_ENV === "test")
        return;
    console.info(`[openbot][context] ${JSON.stringify({ provider, model, ...telemetry })}`);
}
/** Intervalo mínimo entre SSE `updated` de um stream incremental. */
export const STREAM_UPDATE_MIN_MS = STREAM_PUBLISH_INTERVAL_MS;
/** Avoid turning periodic full repair snapshots into another O(n²) stream. */
const STREAM_SNAPSHOT_MIN_FRAGMENTS = 32;
const utf8Prefix = (text: string, maxBytes: number): string => {
    if (maxBytes <= 0)
        return "";
    let bytes = 0;
    let result = "";
    for (const character of text) {
        const size = Buffer.byteLength(character, "utf8");
        if (bytes + size > maxBytes)
            break;
        result += character;
        bytes += size;
    }
    return result;
};
function fitProviderMessagesToBudget(messages: readonly ProviderChatMessage[], maxBytes: number): ProviderChatMessage[] {
    return fitProviderMessagesToByteBudget(messages, maxBytes);
}
function fitProviderMessagesWithAnchor(messages: readonly ProviderChatMessage[], anchorContent: string | undefined, maxBytes: number, maxMessages: number): ProviderContextResult {
    if (!anchorContent) {
        const candidates = messages.slice(-maxMessages);
        const fitted = fitProviderMessagesToBudget(candidates, maxBytes);
        return { messages: fitted, truncated: fitted.length < messages.length };
    }
    let initialCandidates = messages.slice(-maxMessages);
    while (initialCandidates[0]?.role === "assistant")
        initialCandidates = initialCandidates.slice(1);
    const carriesAnchor = (message: ProviderChatMessage): boolean => message.role === "user" && typeof message.content === "string" && (message.content === anchorContent || message.content.startsWith(`${anchorContent}\n\n`));
    const initiallyFitted = fitProviderMessagesToBudget(initialCandidates, maxBytes);
    if (initiallyFitted.some(carriesAnchor)) {
        return { messages: initiallyFitted, truncated: initialCandidates.length < messages.length || initiallyFitted.length < initialCandidates.length };
    }
    const anchorLimit = Math.max(256, Math.min(8 * 1024, Math.floor(maxBytes / 4)));
    const boundedAnchor = utf8Prefix(anchorContent, anchorLimit);
    const anchor: ProviderChatMessage = { role: "user", content: boundedAnchor };
    let skippedAnchor = false;
    const withoutAnchor = messages.filter((message) => {
        if (!skippedAnchor && carriesAnchor(message)) {
            skippedAnchor = true;
            return false;
        }
        return true;
    });
    let candidates = withoutAnchor.slice(-Math.max(0, maxMessages - 1));
    while (candidates[0]?.role === "assistant")
        candidates = candidates.slice(1);
    const anchorBytes = Buffer.byteLength(JSON.stringify([anchor]), "utf8");
    const fittedTail = fitProviderMessagesToBudget(candidates, Math.max(256, maxBytes - anchorBytes - 1));
    const anchored = fitProviderMessagesToByteBudget([anchor, ...fittedTail], maxBytes);
    return {
        messages: anchored,
        truncated: boundedAnchor !== anchorContent || candidates.length < withoutAnchor.length || fittedTail.length < candidates.length || anchored.length < 1 + fittedTail.length,
    };
}
function transcriptSnapshot(agentId: string, entries: readonly TranscriptEntry[], conversationId?: string, hasEarlierPages = false): TranscriptSnapshotPayload {
    const base = {
        type: "snapshot" as const,
        agentId,
        activeAgentId: agentId,
        ...(conversationId === undefined ? {} : { conversationId }),
    };
    const frameBytes = (payload: TranscriptSnapshotPayload): number => Buffer.byteLength(`data: ${JSON.stringify({ channel: "transcript", payload })}\n\n`, "utf8");
    const complete: TranscriptSnapshotPayload = {
        ...base,
        entries: [...entries],
        ...(hasEarlierPages ? { truncated: true, resyncRequired: true, method: "openAgentTail" } : {}),
    };
    if (frameBytes(complete) <= SSE_MAX_FRAME_BYTES)
        return complete;
    // Preserve the newest complete entries and let the client use the existing
    // paginated `openAgentTail` RPC for the omitted history.
    const selected: TranscriptEntry[] = [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry === undefined)
            continue;
        const candidate = [entry, ...selected];
        const partial: TranscriptSnapshotPayload = {
            ...base,
            entries: candidate,
            truncated: true,
            resyncRequired: true,
            method: "openAgentTail",
        };
        if (frameBytes(partial) > SSE_MAX_FRAME_BYTES)
            break;
        selected.splice(0, selected.length, ...candidate);
    }
    const bounded: TranscriptSnapshotPayload = {
        ...base,
        entries: selected,
        truncated: true,
        resyncRequired: true,
        method: "openAgentTail",
    };
    // Keep the transport invariant even when a single entry is itself huge.
    return frameBytes(bounded) <= SSE_MAX_FRAME_BYTES
        ? bounded
        : { ...base, entries: [], truncated: true, resyncRequired: true, method: "openAgentTail" };
}
function providerFailureText(error: ProviderError): string {
    switch (error.kind) {
        case "rate-limit":
            return "O provedor atingiu o limite de uso. Aguarde e tente novamente.";
        case "network":
            return error.code === "ETIMEDOUT"
                ? "O provedor demorou demais para responder. Você pode tentar novamente."
                : "Não foi possível conectar ao provedor. Verifique a internet ou o serviço local e tente novamente.";
        case "server":
            return "O provedor está temporariamente indisponível. Você pode tentar novamente.";
        case "auth":
            return "A autenticação foi recusada pelo provedor. Reconecte a conta ou revise a chave nas configurações.";
        case "validation":
            return "O provedor rejeitou a solicitação ou o modelo selecionado. Revise as configurações.";
        default:
            return "Não foi possível gerar a resposta. Revise o provedor e tente novamente.";
    }
}
function retryableTurnNotice(turn: TurnMetadata, suffix: string, text: string): TranscriptEntry {
    return {
        kind: "notice",
        id: `notice:${turn.turnId}:${suffix}`,
        text,
        level: "error",
        turnId: turn.turnId,
        provider: turn.provider,
        model: turn.model,
        retryable: true,
        ...(turn.clientNonce !== undefined ? { clientNonce: turn.clientNonce } : {}),
        ...(turn.retryOfClientNonce !== undefined ? { retryOfClientNonce: turn.retryOfClientNonce } : {}),
    };
}
/**
 * Resolve o provider/modelo do turno. Default: o modelo default do catálogo
 * estático (`grok-4.6` → xai, Decisão §8.3). T13 troca pelo modelo global.
 */
export function defaultResolveProvider(_agentId: string, _args: SandSendPromptArgs): ResolvedProvider {
    const entry = MODEL_CATALOG.find((m) => m.default) ?? MODEL_CATALOG[0];
    if (!entry) {
        throw new RpcError(500, "sendPrompt: catálogo de modelos vazio");
    }
    return { provider: entry.provider, model: entry.id, reasoningEffort: "medium" };
}
function requestSerializerFor(
    registry: ProviderRegistry,
    provider: string,
): ((request: ProviderChatRequest) => string) | undefined {
    const adapter = registry.get(provider);
    if (adapter?.serializeRequest === undefined)
        return undefined;
    return (request) => adapter.serializeRequest!(request);
}
/**
 * Turn runner mínimo (T10): aceita `sendPrompt`, serializa por agente, dedupe
 * por nonce, monta o diálogo e streama via roteador, emitindo SSE `transcript`
 * (snapshot/appended) com os shapes exatos do contrato.
 */
export class TurnRunner {
    private readonly pendingAcceptances = new Map<string, Promise<{ accepted: true }>>();
    private readonly store: TranscriptStore;
    private readonly conversationStore?: ConversationStoreLike;
    private readonly registry: ProviderRegistry;
    private readonly admission?: ProviderAdmissionScheduler;
    private readonly systemPromptFn: (agentId: string) => string;
    private readonly resolveProviderFn: (agentId: string, args: SandSendPromptArgs) => ResolvedProvider;
    private readonly nowFn: () => number;
    private readonly newIdFn: (role: "user" | "assistant") => string;
    private readonly ledgerCap: number;
    private readonly executionBroker?: LocalExecutionBroker;
    private readonly resolveHostPermission?: ToolLoopOptions["resolveHostPermission"];
    private readonly toolExecutor?: ToolCallExecutor;
    private readonly tools?: ProviderTool[] | ((agentId: string, signal?: AbortSignal) => ProviderTool[] | Promise<ProviderTool[]>);
    private readonly toolDiscoveryNoticeFn?: (agentId: string) => string | undefined;
    private readonly config?: ConfigStore;
    private readonly preparingCatalog = new Map<string, Set<Promise<unknown>>>();
    private readonly activity?: AgentActivityStore;
    private readonly readAttachmentsFn?: TurnRunnerOptions["readAttachments"];
    private readonly resolveTurnContextFn?: TurnRunnerOptions["resolveTurnContext"];
    private readonly resolveKickstartReadinessFn?: TurnRunnerOptions["resolveKickstartReadiness"];
    private readonly wakeMemoryWorker?: TurnRunnerOptions["wakeMemoryWorker"];
    private publishFn: (channel: string, payload: unknown) => void;
    private readonly liveAssistant = new Map<string, LiveAssistantState>();
    /** Independent ordered namespaces: one stable default stream plus one per live entry. */
    private readonly transcriptOrderByKey = new Map<string, { epoch: string; sequence: number }>();
    /** P2.4: independent ordered namespace for sanitized reasoning progress (never persisted). */
    private readonly reasoningOrderByKey = new Map<string, { epoch: string; sequence: number }>();
    /** Fila exclusiva por agente (encadeamento de promises — serialização). */
    private readonly queues = new Map<string, Promise<unknown>>();
    private readonly pendingCounts = new Map<string, number>();
    private readonly agentGenerations = new Map<string, number>();
    private readonly queuedNonces = new Map<string, Set<string>>();
    private readonly queuedConversationIds = new Map<string, Map<string, string | undefined>>();
    private readonly turnControllers = new Map<string, AbortController>();
    private readonly kickstartQueued = new Map<string, Set<string>>();
    private readonly kickstartActive = new Set<string>();
    private readonly kickstartActiveNonce = new Map<string, string>();
    private readonly resumeTurns = new Set<string>();
    private readonly fencedAgents = new Map<string, number>();
    private runningTurns = 0;
    private shuttingDown = false;
    constructor(opts: TurnRunnerOptions = {}) {
        this.store = opts.store ?? createMemoryTranscriptStore();
        this.conversationStore = opts.conversationStore ?? opts.store?.conversationStore;
        this.registry = opts.registry ?? defaultRegistry;
        this.admission = opts.admission;
        this.systemPromptFn = opts.systemPrompt ?? (() => DEFAULT_SYSTEM_PROMPT);
        this.resolveProviderFn = opts.resolveProvider ?? (opts.config
            ? (agentId) => resolveAgentInference(opts.config!.snapshot(), agentId)
            : defaultResolveProvider);
        this.nowFn = opts.now ?? (() => Date.now());
        this.newIdFn = opts.newId ?? ((role) => `${role}:${randomUUID()}`);
        this.ledgerCap = opts.ledgerCap ?? DEFAULT_LEDGER_CAP;
        this.executionBroker = opts.executionBroker;
        this.resolveHostPermission = opts.resolveHostPermission;
        this.toolExecutor = opts.toolExecutor;
        this.tools = opts.tools;
        this.toolDiscoveryNoticeFn = opts.toolDiscoveryNotice;
        this.config = opts.config;
        this.activity = opts.activity;
        this.readAttachmentsFn = opts.readAttachments;
        this.resolveTurnContextFn = opts.resolveTurnContext;
        this.resolveKickstartReadinessFn = opts.resolveKickstartReadiness;
        this.wakeMemoryWorker = opts.wakeMemoryWorker;
        this.publishFn = opts.publish ?? (() => { });
    }
    async toolsFor(agentId: string, signal?: AbortSignal): Promise<ProviderTool[] | undefined> {
        return typeof this.tools === "function" ? await this.tools(agentId, signal) : this.tools;
    }
    /**
     * A nonce is only a committed turn once its user echo is durable.  Release
     * an acceptance left by preparation failures, but preserve it whenever the
     * echo exists (or the store cannot answer), so a retry can never duplicate
     * an already persisted turn.
     */
    forgetNonceIfNoUserEcho(agentId: string, nonce: string, conversationId?: string): void {
        try {
            // Direct indexed lookup when available; scan fallback keeps the
            // contract for stores without the optimized query.
            const hasEcho = this.store.findUserEchoByNonce !== undefined
                ? this.store.findUserEchoByNonce(agentId, nonce, conversationId) !== undefined
                : this.store.getEntries(agentId, conversationId).some((entry) => ((entry.kind === "message" && entry.role === "user" && entry.clientNonce === nonce) ||
                    (entry.kind === "notice" && entry.type === "retry-attempt" && entry.clientNonce === nonce)));
            if (!hasEcho)
                this.store.forgetAcceptedNonce(agentId, nonce, conversationId);
        }
        catch {
            // An unavailable store must keep the acceptance for crash-safe
            // reconciliation rather than risk a duplicate turn.
        }
    }
    agentPeer(agentId: string) {
        // Hot path (per published entry): read the name without cloning the
        // whole config (snapshot() is a full structuredClone, expensive when a
        // bot carries a large base64 avatar).
        const name = typeof this.config?.agentName === "function"
            ? this.config.agentName(agentId)
            : this.config?.snapshot().agents.find((entry) => entry.id === agentId)?.name;
        return transcriptAgentRef(agentId, name);
    }
    humanAuthor() {
        const configLike = this.config;
        const profile = typeof configLike?.profileName === "function"
            ? {
                name: configLike.profileName(),
                machineId: configLike.profileMachineId(),
            }
            : this.config?.snapshot().profile;
        return transcriptUserRef(profile?.name, profile?.machineId);
    }
    private memoryStore(): TranscriptMemoryStore | undefined {
        return (this.store as MemoryCapableTranscriptStore).memoryStore;
    }
    resolveMemoryTurnContext(agentId: string, conversationId?: string): MemoryTurnContext {
        const memoryStore = this.memoryStore();
        const mode = memoryStore?.getSettings(agentId).mode ?? "off";
        const conversation = conversationId === undefined
            ? this.conversationStore?.getActive(agentId)
            : this.conversationById(agentId, conversationId);
        return {
            mode,
            conversation: { temporary: conversation?.temporary === true },
        };
    }
    private enqueueReflectionJob(
        agentId: string,
        provider: string,
        model: string,
        prompt: string,
        conversationId: string | undefined,
        memoryContext: MemoryTurnContext,
        contextPressure: boolean,
        reasoningEffort?: ResolvedProvider["reasoningEffort"],
    ): void {
        const memoryStore = this.memoryStore();
        const transcript = this.store;
        if (!memoryStore || !conversationId || transcript.getLatestSequenceId === undefined)
            return;
        const throughSequenceId = transcript.getLatestSequenceId(agentId, conversationId);
        if (throughSequenceId === null)
            return;
        const currentSummary = memoryStore.getSummary(agentId, conversationId, true);
        const summaryBoundary = currentSummary?.throughSequenceId ?? -1;
        const summaryRequested = contextPressure || throughSequenceId - summaryBoundary >= CONVERSATION_COMPACTION_SEQUENCE_INTERVAL;
        const plan = planReflectionJob(memoryContext.mode, memoryContext.conversation, prompt, summaryRequested);
        if (plan === null)
            return;
        const memoryBoundary = memoryStore.getLatestCompletedJobBoundary(agentId, conversationId, "memory") ?? -1;
        const effectiveSummaryRequested = plan.summaryRequested && throughSequenceId > summaryBoundary;
        const effectiveMemoryRequested = plan.memoryRequested && throughSequenceId > memoryBoundary;
        if (!effectiveSummaryRequested && !effectiveMemoryRequested)
            return;
        const starts = [];
        if (effectiveSummaryRequested)
            starts.push(summaryBoundary + 1);
        if (effectiveMemoryRequested)
            starts.push(memoryBoundary + 1);
        const fromSequenceId = Math.max(0, Math.min(...starts));
        memoryStore.enqueueJob({
            agentId,
            conversationId,
            provider,
            model,
            fromSequenceId,
            throughSequenceId,
            summaryRequested: effectiveSummaryRequested,
            memoryRequested: effectiveMemoryRequested,
            reasoningEffort,
        });
        this.wakeMemoryWorker?.();
    }
    /** Troca o publicador SSE (o handler do gateway pluga o ctx.publish). */
    setPublish(fn: (channel: string, payload: unknown) => void): void {
        this.publishFn = fn;
    }
    /** Public lifecycle seam used by conversation RPCs when the active chat changes. */
    publishConversationSnapshot(agentId: string, conversationId?: string): void {
        this.publishTranscriptSnapshot(agentId, conversationId ?? this.conversationStore?.getActive(agentId)?.id);
    }
    /**
     * Fences the ordered transcript namespace before an authoritative reconnect
     * snapshot. A live turn keeps its text in memory and re-baselines on the
     * next provider fragment so a durable snapshot never has to include preview
     * state.
     */
    rotateTranscriptEpoch(agentId: string): string {
        const replicaKey = `transcript:${agentId}`;
        const epoch = randomUUID();
        this.transcriptOrderByKey.set(replicaKey, { epoch, sequence: 0 });
        const live = this.liveAssistant.get(agentId);
        if (live !== undefined) {
            live.epoch = epoch;
            live.sequence = 0;
            live.lastSnapshotSequence = 0;
            live.needsBaseline = true;
        }
        return epoch;
    }
    /**
     * Aceita um `sendPrompt` → `{accepted:true}`. O ack é IMEDIATO e DURÁVEL:
     * o nonce entra no ledger de aceitação ANTES do turno rodar — retry do mesmo
     * nonce (mesmo concorrente, durante o turno em curso) retorna accepted SEM
     * rodar de novo. O turno roda em background na fila exclusiva do agente.
     */
    sendPrompt(raw: SandSendPromptArgs): Promise<{ accepted: true }> {
        const args = normalizeSendPrompt(raw);
        delete args.retryOfClientNonce;
        delete args.retryFailureTurnId;
        return this.acceptPrompt(args, undefined, undefined, { kind: "user" });
    }

    /** Internal A2A entrypoint; unlike the public RPC it never grants user authority. */
    sendAgentPrompt(raw: SandSendPromptArgs, senderAgentId: string): Promise<{ accepted: true }> {
        if (typeof senderAgentId !== "string" || senderAgentId.trim().length === 0)
            throw new RpcError(400, "sendAgentPrompt: senderAgentId é obrigatório");
        const args = normalizeSendPrompt(raw);
        delete args.retryOfClientNonce;
        delete args.retryFailureTurnId;
        return this.acceptPrompt(args, undefined, undefined, { kind: "agent", agentId: senderAgentId.trim() });
    }

    private kickstartResult(run: KickstartRunRecord): KickstartAgentResult {
        const inFlight = run.status === "queued" || run.status === "running";
        return {
            accepted: true,
            isIntroductionInFlight: inFlight,
            status: run.status,
            clientNonce: run.clientNonce,
            attempt: run.attempt,
            ...(run.result === undefined ? {} : { result: { text: utf8Prefix(run.result.text, MAX_KICKSTART_RESULT_BYTES) } }),
        };
    }

    /** Explicit P2.8 opt-in. This path never appends, publishes, or executes tools. */
    async kickstartAgent(raw: KickstartAgentArgs): Promise<KickstartAgentResult> {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw))
            throw new RpcError(400, "kickstartAgent: corpo deve ser um objeto");
        const agentId = typeof raw.agentId === "string" ? raw.agentId.trim() : "";
        const clientNonce = typeof raw.clientNonce === "string" ? raw.clientNonce.trim() : "";
        if (raw.mode !== "onboarding" || agentId.length === 0 || clientNonce.length === 0 || Buffer.byteLength(clientNonce, "utf8") > MAX_KICKSTART_NONCE_BYTES)
            throw new RpcError(400, "kickstartAgent: exige agentId, clientNonce e mode=onboarding");
        if (this.shuttingDown) throw new RpcError(503, "kickstartAgent: servidor em encerramento");
        if (this.fencedAgents.has(agentId)) throw new RpcError(409, "kickstartAgent: agente em exclusão");
        if (this.config && !this.config.snapshot().agents.some((entry) => entry.id === agentId))
            throw new RpcError(400, "kickstartAgent: agente não encontrado");
        if (this.store.getKickstartRun === undefined || this.store.claimKickstartRun === undefined || this.store.updateKickstartRun === undefined)
            throw new RpcError(503, "kickstartAgent: store sem suporte durável");

        const conversationId = this.resolveConversation(agentId, undefined, false);
        const existing = this.store.getKickstartRun(agentId, clientNonce);
        if (existing !== undefined && existing.status !== "retryable") return this.kickstartResult(existing);
        if (this.resolveKickstartReadinessFn === undefined)
            throw new RpcError(503, "kickstartAgent: readiness indisponível");

        const inference = this.resolveProviderFn(agentId, {
            agentId,
            conversationId,
            prompt: KICKSTART_INTERNAL_PROMPT,
            clientNonce,
        });
        if (!inference || typeof inference.provider !== "string" || typeof inference.model !== "string")
            throw new RpcError(503, "kickstartAgent: provider indisponível");
        if (this.config?.modelCatalog && isCatalogProvider(inference.provider)) {
            await this.config.modelCatalog.synchronize(inference.provider);
            inference.modelResolution = this.config.modelCatalog.resolve(inference.provider, inference.model, inference.reasoningEffort, inference.serviceTier);
        }
        try {
            await this.resolveKickstartReadinessFn(agentId, inference);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new RpcError(503, `kickstartAgent: readiness rejeitada: ${detail}`);
        }
        if (this.shuttingDown || this.fencedAgents.has(agentId))
            throw new RpcError(409, "kickstartAgent: agente em exclusão");

        const claim = this.store.claimKickstartRun({
            agentId,
            clientNonce,
            ...(conversationId === undefined ? {} : { conversationId }),
            origin: "kickstart",
            version: 1,
            provider: inference.provider,
            model: inference.model,
        });
        if (!claim.claimed) return this.kickstartResult(claim.run);

        const queued = this.kickstartQueued.get(agentId) ?? new Set<string>();
        queued.add(clientNonce);
        this.kickstartQueued.set(agentId, queued);
        const pending = this.pendingCounts.get(agentId) ?? 0;
        this.pendingCounts.set(agentId, pending + 1);
        const generation = this.agentGenerations.get(agentId) ?? 0;
        this.enqueue(agentId, async () => {
            this.kickstartQueued.get(agentId)?.delete(clientNonce);
            if (this.kickstartQueued.get(agentId)?.size === 0) this.kickstartQueued.delete(agentId);
            try {
                if (this.shuttingDown || this.fencedAgents.has(agentId) || (this.agentGenerations.get(agentId) ?? 0) !== generation) {
                    this.store.cancelKickstartRun?.(agentId, clientNonce);
                    return;
                }
                await this.runKickstart(agentId, clientNonce, claim.run, inference);
            }
            finally {
                const next = (this.pendingCounts.get(agentId) ?? 1) - 1;
                if (next <= 0) this.pendingCounts.delete(agentId);
                else this.pendingCounts.set(agentId, next);
            }
        }, undefined, conversationId);
        return this.kickstartResult(claim.run);
    }

    private async runKickstart(agentId: string, clientNonce: string, claimed: KickstartRunRecord, inference: ResolvedProvider): Promise<void> {
        const turnId = `kickstart:${randomUUID()}`;
        const controller = new AbortController();
        const streamController = new AbortController();
        const abortStream = () => streamController.abort(controller.signal.reason);
        controller.signal.addEventListener("abort", abortStream, { once: true });
        this.turnControllers.set(agentId, controller);
        this.kickstartActive.add(agentId);
        this.kickstartActiveNonce.set(agentId, clientNonce);
        this.runningTurns += 1;
        this.store.updateKickstartRun?.(agentId, clientNonce, { status: "running", turnId, provider: inference.provider, model: inference.model });
        let observableOutput = false;
        let output = "";
        const appendOutput = (value: unknown) => {
            if (typeof value !== "string" || value.length === 0) return;
            observableOutput = true;
            output = utf8Prefix(output + value, MAX_KICKSTART_RESULT_BYTES);
            this.store.updateKickstartRun?.(agentId, clientNonce, { observableOutput: true, result: { text: output } });
        };
        try {
            const capabilities = resolveModelCapabilities(inference.modelResolution?.entry ?? inference.model, inference.provider);
            const serializeRequest = requestSerializerFor(this.registry, inference.provider);
            const prepared = prepareProviderRound({
                model: inference.model,
                modelResolution: inference.modelResolution,
                purpose: "turn",
                sessionId: createHash("sha256").update(JSON.stringify([agentId, "kickstart", clientNonce])).digest("hex"),
                system: this.systemPromptFn(agentId),
                messages: [{ role: "user", content: KICKSTART_INTERNAL_PROMPT }],
                maxTokens: capabilities.maxOutputTokens,
                signal: streamController.signal,
            }, {
                capabilities,
                maxBytes: capabilities.maxRequestBytes ?? CONTEXT_HARD_LIMIT_BYTES,
                provider: inference.provider,
                ...(serializeRequest === undefined ? {} : { serializeRequest }),
            });
            logContextTelemetry(inference.provider, inference.model, prepared.telemetry);
            if (prepared.exhausted) throw new Error("provider context budget exhausted");
            const result = await streamChat(inference.provider, prepared.request, (event: ProviderStreamEvent) => {
                if (event.type === "delta") appendOutput(event.delta);
                else if (event.type === "message" && !observableOutput) appendOutput(event.message.content);
                else if (event.type === "tool-call") {
                    appendOutput("[tool-call disabled]");
                    controller.abort();
                }
            }, { registry: this.registry, admission: this.admission, agentId });
            if (result.message?.content && !observableOutput) appendOutput(result.message.content);
            const errorText = result.error?.message;
            if (result.aborted || result.error !== undefined) {
                const cancelled = result.error?.kind === "aborted" && controller.signal.aborted && !observableOutput;
                const status: KickstartRunStatus = observableOutput
                    ? "interrupted"
                    : cancelled ? "cancelled" : result.error?.retryable ? "retryable" : "failed";
                this.store.updateKickstartRun?.(agentId, clientNonce, {
                    status,
                    error: errorText ?? (cancelled ? "cancelled" : "kickstart failed"),
                    ...(output.length > 0 ? { result: { text: output } } : {}),
                });
                return;
            }
            this.store.updateKickstartRun?.(agentId, clientNonce, { status: "completed", result: { text: output } });
        }
        catch (error) {
            this.store.updateKickstartRun?.(agentId, clientNonce, {
                status: observableOutput ? "interrupted" : "retryable",
                observableOutput,
                ...(output.length > 0 ? { result: { text: output } } : {}),
                error: error instanceof Error ? error.message : String(error),
            });
        }
        finally {
            controller.signal.removeEventListener("abort", abortStream);
            this.kickstartActive.delete(agentId);
            if (this.kickstartActiveNonce.get(agentId) === clientNonce) this.kickstartActiveNonce.delete(agentId);
            if (this.turnControllers.get(agentId) === controller) this.turnControllers.delete(agentId);
            this.runningTurns = Math.max(0, this.runningTurns - 1);
        }
    }
    listConversations(agentId: string): Conversation[] {
        if (this.conversationStore === undefined)
            return [];
        const result: Conversation[] = [];
        let cursor: string | undefined;
        do {
            const page = this.conversationStore.list(agentId, { limit: 200, ...(cursor === undefined ? {} : { cursor }) });
            result.push(...page.items);
            cursor = page.nextCursor;
        } while (cursor !== undefined);
        return result;
    }
    private conversationById(agentId: string, conversationId: string): Conversation | null {
        if (this.conversationStore === undefined)
            return null;
        if (this.conversationStore.get !== undefined)
            return this.conversationStore.get(agentId, conversationId);
        let cursor: string | undefined;
        do {
            const page = this.conversationStore.list(agentId, { limit: 200, ...(cursor === undefined ? {} : { cursor }) });
            const found = page.items.find((item) => item.id === conversationId);
            if (found !== undefined)
                return found;
            cursor = page.nextCursor;
        } while (cursor !== undefined);
        return null;
    }
    publishTranscriptSnapshot(agentId: string, conversationId?: string): void {
        const page = this.store.openDurableAgentTail !== undefined
            ? this.store.openDurableAgentTail(agentId, SNAPSHOT_PAGE_LIMIT, undefined, conversationId)
            : this.store.openAgentTail(agentId, SNAPSHOT_PAGE_LIMIT, undefined, conversationId);
        this.publishFn("transcript", {
            ...transcriptSnapshot(agentId, page.entries, conversationId, page.nextBeforeSeq !== undefined),
            ordered: this.nextTranscriptOrder(agentId),
        });
    }
    nextTranscriptOrder(agentId: string, replicaKey = `transcript:${agentId}`): { replicaKey: string; epoch: string; sequence: number } {
        const current = this.transcriptOrderByKey.get(replicaKey) ?? { epoch: randomUUID(), sequence: 0 };
        const next = { epoch: current.epoch, sequence: current.sequence + 1 };
        this.transcriptOrderByKey.set(replicaKey, next);
        return { replicaKey, ...next };
    }
    sanitizeReasoningFragment(value: unknown, maxBytes: number): string {
        if (typeof value !== "string") return "";
        const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007f]/g, " ").replace(/\s+/g, " ").trim();
        if (cleaned.length === 0) return "";
        return utf8Prefix(cleaned, maxBytes);
    }
    nextReasoningOrder(agentId: string): { replicaKey: string; epoch: string; sequence: number } {
        const replicaKey = "reasoning:" + agentId;
        const current = this.reasoningOrderByKey.get(agentId) ?? { epoch: randomUUID(), sequence: 0 };
        const next = { epoch: current.epoch, sequence: current.sequence + 1 };
        this.reasoningOrderByKey.set(agentId, next);
        return { replicaKey, ...next };
    }
    /**
     * Publishes a bounded reasoning frame to the `reasoning` SSE channel. Frames
     * carry ordered (epoch/sequence) metadata for reconnect dedupe but are never
     * persisted to the transcript or SQLite.
     */
    publishReasoning(agentId: string, turn: any, frame: { type: "start" | "progress" | "end"; summary?: string; reason?: string }): void {
        if (!turn?.reasoning || !turn.reasoning.enabled) return;
        this.publishFn("reasoning", {
            type: frame.type,
            agentId,
            ...(turn.conversationId === undefined ? {} : { conversationId: turn.conversationId }),
            turnId: turn.turnId,
            ...(frame.summary !== undefined ? { summary: frame.summary } : {}),
            ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
            ordered: this.nextReasoningOrder(agentId),
        });
    }
    /** Terminalizes an open reasoning state (abort/error/completion); idempotent. */
    terminalizeReasoning(agentId: string, turn: any, reason: string): void {
        if (!turn?.reasoning || !turn.reasoning.open) return;
        turn.reasoning.open = false;
        turn.reasoning.ended = true;
        this.publishReasoning(agentId, turn, { type: "end", reason });
    }

    /** Resolve and validate before a prompt can enter the per-agent queue. */
    resolveConversation(agentId: string, requestedId: string | undefined, allowInactive = false): string | undefined {
        const normalized = requestedId === undefined ? undefined : requestedId.trim();
        if (requestedId !== undefined && (normalized === undefined || normalized.length === 0)) {
            throw new RpcError(400, "conversationId deve ser uma string não vazia");
        }
        if (this.conversationStore === undefined)
            return normalized;
        const active = this.conversationStore.getActive(agentId);
        if (normalized === undefined) {
            if (active === null)
                return this.conversationStore.ensureDefault(agentId).id;
            return active.id;
        }
        const conversation = this.conversationById(agentId, normalized);
        if (conversation === null)
            throw new RpcError(404, "conversation não encontrada para o agente");
        if (conversation.archivedAtMs !== null)
            throw new RpcError(409, "conversation arquivada");
        if (!allowInactive && active?.id !== normalized) {
            throw new RpcError(409, "conversation não está ativa");
        }
        return normalized;
    }
    acceptPrompt(
        args: SandSendPromptArgs,
        pinnedInference?: ResolvedProvider,
        pinnedConversationId?: string,
        origin: TurnOrigin = { kind: "user" },
    ): Promise<{ accepted: true }> {
        this.validate(args);
        const { agentId, clientNonce } = args;
        if (this.shuttingDown)
            throw new RpcError(503, "sendPrompt: servidor em encerramento");
        if (this.fencedAgents.has(agentId)) {
            throw new RpcError(409, "sendPrompt: agente em exclusão");
        }
        if (this.config && !this.config.snapshot().agents.some((entry) => entry.id === agentId)) {
            throw new RpcError(400, "sendPrompt: agente não encontrado");
        }
        if (clientNonce !== undefined && this.conversationStore !== undefined) {
            const requested = pinnedConversationId ?? args.conversationId;
            const scopes = requested === undefined
                ? this.store.findAcceptedNonceConversations?.(agentId, clientNonce) ?? []
                : this.store.hasAcceptedNonce(agentId, clientNonce, requested) ? [requested] : [];
            if (scopes.length > 1) throw new RpcError(409, "sendPrompt: conversationId é ambíguo");
            if (scopes.length === 1) {
                if (scopes[0] !== undefined) this.validateAcceptanceConversation(agentId, scopes[0]);
                return this.confirmedAcceptance(agentId, clientNonce, scopes[0]);
            }
        }
        const conversationId = this.resolveConversation(agentId, pinnedConversationId ?? args.conversationId, pinnedConversationId !== undefined);
        const pinnedArgs: SandSendPromptArgs = conversationId === undefined
            ? args
            : { ...args, conversationId };
        const inference = pinnedInference ?? this.resolveProviderFn(agentId, pinnedArgs);
        const catalog = this.config?.modelCatalog;
        if (catalog && isCatalogProvider(inference.provider) && !inference.modelResolution) {
            const generation = this.agentGenerations.get(agentId) ?? 0;
            const preparation = (inference.serviceTier === "priority" ? catalog.get(inference.provider) : catalog.synchronize(inference.provider)).then(() => {
                if ((this.agentGenerations.get(agentId) ?? 0) !== generation) throw new RpcError(409, "Envio cancelado durante a validação do modelo");
                return this.acceptPrompt(pinnedArgs, {
                    ...inference, modelResolution: catalog.resolve(inference.provider, inference.model, inference.reasoningEffort, inference.serviceTier),
                }, conversationId, origin);
            });
            const pending = this.preparingCatalog.get(agentId) ?? new Set<Promise<unknown>>();
            pending.add(preparation);
            this.preparingCatalog.set(agentId, pending);
            const cleanup = () => { pending.delete(preparation); if (!pending.size) this.preparingCatalog.delete(agentId); };
            void preparation.then(cleanup, cleanup);
            return preparation;
        }
        const acceptanceKey = JSON.stringify([agentId, conversationId, clientNonce ?? randomUUID()]);
        if (clientNonce !== undefined && this.store.hasAcceptedNonce(agentId, clientNonce, conversationId)) {
            return this.confirmedAcceptance(agentId, clientNonce, conversationId);
        }
        const pending = this.pendingCounts.get(agentId) ?? 0;
        if (pending >= MAX_SEND_QUEUE_PER_AGENT) {
            throw new RpcError(429, `sendPrompt: fila cheia para o agente (${MAX_SEND_QUEUE_PER_AGENT})`);
        }
        // A aceitação só é persistida depois que há vaga; o claim atômico impede
        // duas instâncias de enfileirarem o mesmo nonce.
        if (clientNonce !== undefined) {
            if (!this.store.claimAcceptedNonce(agentId, clientNonce, conversationId)) {
                return this.confirmedAcceptance(agentId, clientNonce, conversationId);
            }
            this.store.trimAcceptedNonces(agentId, this.ledgerCap);
            const queued = this.queuedNonces.get(agentId) ?? new Set();
            queued.add(clientNonce);
            this.queuedNonces.set(agentId, queued);
            const conversations = this.queuedConversationIds.get(agentId) ?? new Map();
            conversations.set(clientNonce, conversationId);
            this.queuedConversationIds.set(agentId, conversations);
        }
        this.pendingCounts.set(agentId, pending + 1);
        let confirm!: () => void;
        let reject!: (error: unknown) => void;
        const acceptance = new Promise<{ accepted: true }>((resolve, fail) => {
            confirm = () => resolve({ accepted: true });
            reject = fail;
        });
        // Internal producers can wait for the whole turn with flush(). The RPC
        // still observes this rejection, while fire-and-forget callers are safe.
        void acceptance.catch(() => undefined);
        this.pendingAcceptances.set(acceptanceKey, acceptance);
        const generation = this.agentGenerations.get(agentId) ?? 0;
        this.enqueue(agentId, async () => {
            if (clientNonce !== undefined) {
                const queued = this.queuedNonces.get(agentId);
                queued?.delete(clientNonce);
                if (queued?.size === 0)
                    this.queuedNonces.delete(agentId);
                this.queuedConversationIds.get(agentId)?.delete(clientNonce);
                if (this.queuedConversationIds.get(agentId)?.size === 0)
                    this.queuedConversationIds.delete(agentId);
            }
            try {
                if (this.shuttingDown || (this.agentGenerations.get(agentId) ?? 0) !== generation) {
                    if (clientNonce !== undefined)
                        this.store.forgetAcceptedNonce(agentId, clientNonce, conversationId);
                    reject(new RpcError(409, "Envio cancelado antes de ser salvo. O conteúdo permanece na pendência local."));
                    return;
                }
                await this.runTurn(pinnedArgs, inference, origin, { confirm, reject });
            }
            catch (error) {
                reject(error);
                throw error;
            }
            finally {
                this.pendingAcceptances.delete(acceptanceKey);
                const next = (this.pendingCounts.get(agentId) ?? 1) - 1;
                if (next <= 0) {
                    this.pendingCounts.delete(agentId);
                    if (this.activity?.get(agentId).isRunning)
                        this.activity.patch(agentId, { isRunning: false });
                }
                else {
                    this.pendingCounts.set(agentId, next);
                }
                this.wakeMemoryWorker?.();
            }
        }, clientNonce === undefined
            ? undefined
            : () => this.forgetNonceIfNoUserEcho(agentId, clientNonce, conversationId), conversationId);
        return acceptance;
    }
    private confirmedAcceptance(agentId: string, nonce: string, conversationId?: string): Promise<{ accepted: true }> {
        const pending = this.pendingAcceptances.get(JSON.stringify([agentId, conversationId, nonce]));
        if (pending) return pending;
        if (this.acceptanceStatus(agentId, nonce, conversationId).outcome === "found")
            return Promise.resolve({ accepted: true });
        throw new RpcError(503, "Envio ainda sem confirmação de persistência. Consulte a pendência antes de reenviar.");
    }
    retryPrompt(agentId: string, requestedConversationId?: string): Promise<{ accepted: true }> {
        if (typeof agentId !== "string" || agentId.trim().length === 0) {
            throw new RpcError(400, "retryPrompt: agentId é obrigatório");
        }
        let selectedConversationId: string | undefined;
        let entries: readonly TranscriptEntry[] = [];
        let failure: Extract<TranscriptEntry, { kind: "notice" }> | undefined;
        const inspectCandidate = (candidate: string | undefined): boolean => {
            const scoped = this.store.getEntries(agentId, candidate);
            const found = [...scoped].reverse().find((entry) => (entry.kind === "notice" &&
                entry.level === "error" &&
                entry.retryable === true &&
                typeof entry.turnId === "string" &&
                typeof entry.provider === "string" &&
                typeof entry.model === "string"));
            if (found?.kind === "notice") {
                selectedConversationId = candidate;
                entries = scoped;
                failure = found;
                return true;
            }
            return false;
        };
        if (requestedConversationId !== undefined) {
            let requested;
            try {
                requested = this.resolveConversation(agentId, requestedConversationId, true);
            }
            catch (error) {
                if (error instanceof RpcError && error.status === 409 && /arquivada/i.test(error.message)) {
                    throw new RpcError(409, "retryPrompt: conversation arquivada");
                }
                throw error;
            }
            inspectCandidate(requested);
        }
        else if (this.conversationStore === undefined) {
            inspectCandidate(undefined);
        }
        else {
            let cursor: string | undefined;
            search: do {
                const page = this.conversationStore.list(agentId, { limit: 200, ...(cursor === undefined ? {} : { cursor }) });
                for (const conversation of page.items) {
                    if (conversation.archivedAtMs === null && inspectCandidate(conversation.id))
                        break search;
                }
                cursor = page.nextCursor;
            } while (cursor !== undefined);
        }
        if (failure?.kind !== "notice" ||
            typeof failure.turnId !== "string" ||
            typeof failure.provider !== "string" ||
            typeof failure.model !== "string") {
            throw new RpcError(409, "retryPrompt: nenhuma falha recuperável atual");
        }
        const failureTurnId = failure.turnId;
        const retryNonce = `retry:${failureTurnId}`;
        if (this.store.hasAcceptedNonce(agentId, retryNonce, selectedConversationId))
            return this.confirmedAcceptance(agentId, retryNonce, selectedConversationId);
        const failureIndex = entries.lastIndexOf(failure);
        const conversationAdvanced = entries.slice(failureIndex + 1).some((entry) => (entry.kind === "message" && (entry.role === "user" || (entry.role === "assistant" && entry.turnId !== failureTurnId))));
        if (conversationAdvanced)
            throw new RpcError(409, "retryPrompt: a conversa avançou; a falha não é mais atual");
        const originalNonce = typeof failure.retryOfClientNonce === "string"
            ? failure.retryOfClientNonce
            : typeof failure.clientNonce === "string" ? failure.clientNonce : undefined;
        const user = [...entries].reverse().find((entry) => (entry.kind === "message" && entry.role === "user" && (entry.turnId === failureTurnId || (originalNonce !== undefined && entry.clientNonce === originalNonce))));
        if (user?.kind !== "message" || user.role !== "user") {
            throw new RpcError(409, "retryPrompt: mensagem original não encontrada");
        }
        if (entries.some((entry) => entry.kind === "tool-call"
            && (entry.status === "completed" || (entry.result?.ok === false && ["process_aborted", "process_failed", "aborted"].includes(entry.result.code ?? "")))
            && typeof entry.localToolCallId === "string"
            && (entry.localToolCallId.startsWith(`${failureTurnId}\0`)
                || (user.turnId !== undefined && entry.localToolCallId.startsWith(`${user.turnId}\0`))))) {
            throw new RpcError(409, "Este turno já executou ferramentas ou foi interrompido durante uma operação. Confira os resultados e possíveis efeitos e envie uma nova instrução para continuar.");
        }
        let retryOrigin: TurnOrigin;
        if (user.fromAgent !== undefined) {
            retryOrigin = { kind: "agent", agentId: typeof user.fromAgent === "string" ? user.fromAgent : user.fromAgent.id };
        }
        else if (originalNonce?.startsWith("a2a:")) {
            retryOrigin = { kind: "agent", agentId: "legacy-a2a" };
        }
        else if (typeof user.fromUser === "object" && user.fromUser !== null) {
            retryOrigin = { kind: "user" };
        }
        else {
            throw new RpcError(409, "retryPrompt: origem da mensagem não é confiável");
        }
        return this.acceptPrompt({
            agentId,
            prompt: user.content,
            attachments: entries.flatMap((entry) => entry.kind === "user-attachment"
                && ((user.turnId !== undefined && entry.turnId === user.turnId)
                    || (user.clientNonce !== undefined && entry.clientNonce === user.clientNonce))
                && entry.extractedText === undefined && entry.skipped === undefined
                ? [{ name: entry.file_name, path: entry.file_path }]
                : []),
            clientNonce: retryNonce,
            ...(originalNonce !== undefined ? { retryOfClientNonce: originalNonce } : {}),
            retryFailureTurnId: failureTurnId,
        }, {
            provider: failure.provider,
            model: failure.model,
            modelResolution: user.modelResolution,
            reasoningEffort: user.reasoningEffort ?? this.resolveProviderFn(agentId, { agentId, prompt: user.content }).reasoningEffort,
        }, selectedConversationId, retryOrigin);
    }
    resumePrompt(agentId: string, turnId: string, requestedConversationId?: string): { accepted: true } {
        if (typeof agentId !== "string" || agentId.trim().length === 0 || typeof turnId !== "string" || turnId.trim().length === 0)
            throw new RpcError(400, "resumePrompt: agentId e turnId são obrigatórios");
        if (this.shuttingDown)
            throw new RpcError(503, "resumePrompt: servidor em encerramento");
        if (this.fencedAgents.has(agentId))
            throw new RpcError(409, "resumePrompt: agente em exclusão");
        if (this.config && !this.config.snapshot().agents.some((entry) => entry.id === agentId))
            throw new RpcError(400, "resumePrompt: agente não encontrado");
        if (typeof this.store.getResumeCheckpoint !== "function")
            throw new RpcError(409, "resumePrompt: store sem suporte a checkpoint");
        const conversationId = this.resolveConversation(agentId, requestedConversationId, true);
        if (conversationId === undefined)
            throw new RpcError(409, "resumePrompt: conversa persistida obrigatória");
        const entries = this.store.getEntries(agentId, conversationId);
        const user = [...entries].reverse().find((entry): entry is Extract<TranscriptEntry, { kind: "message" }> =>
            entry.kind === "message" && entry.role === "user" && entry.turnId === turnId,
        );
        const selected = this.store.findResumeCheckpoint?.(agentId, conversationId, turnId)
            ?? (user?.kind === "message" && user.provider !== undefined && user.model !== undefined
                ? this.store.getResumeCheckpoint({ agentId, conversationId, turnId, provider: user.provider, model: user.model })
                : undefined);
        if (selected === undefined)
            return this.finishResumeFailure(agentId, conversationId, turnId, "missing_cursor", "Nenhum checkpoint resumível foi encontrado.");
        if (user?.kind === "message" && ((user.provider !== undefined && user.provider !== selected.provider) || (user.model !== undefined && user.model !== selected.model)))
            return this.finishResumeFailure(agentId, conversationId, turnId, "foreign_checkpoint", "O checkpoint pertence a outro provider/modelo.");
        const completed = entries.some((entry) => entry.kind === "message" && entry.role === "assistant" && entry.turnId === turnId && entry.completionState !== "interrupted" && entry.streaming !== true);
        if (completed)
            return this.finishResumeFailure(agentId, conversationId, turnId, "resume_aborted", "O turno já foi concluído; nenhum replay foi executado.");
        const selectedScope: ResumeCheckpointScope = {
            agentId,
            conversationId,
            turnId,
            provider: selected.provider,
            model: selected.model,
        };
        if (this.resumeTurns.has(`${agentId}\u0000${conversationId}\u0000${turnId}`)) return { accepted: true };
        try {
            assertCheckpointUsable(selected, selectedScope, this.nowFn());
        }
        catch (error) {
            const code = error instanceof ResumeProtocolError && error.code === "invalid_cursor"
                ? "invalid_cursor"
                : error instanceof ResumeProtocolError && error.code === "expired_checkpoint"
                    ? "expired_checkpoint"
                    : "foreign_checkpoint";
            return this.finishResumeFailure(agentId, conversationId, turnId, code, code === "expired_checkpoint" ? "O checkpoint de resume expirou." : "O checkpoint de resume não é válido para este turno.");
        }
        if (typeof this.store.hasUnsafeResumeEffect !== "function" || this.store.hasUnsafeResumeEffect(selectedScope))
            return this.finishResumeFailure(agentId, conversationId, turnId, "unsafe_effect", "O turno possui um efeito sem resultado durável; nenhum replay foi executado.");
        if (this.resumeBudgetExhausted(selected.budget))
            return this.finishResumeFailure(agentId, conversationId, turnId, "resume_budget_exhausted", "O budget original do turno foi consumido.");
        this.resumeTurns.add(`${agentId}\u0000${conversationId}\u0000${turnId}`);
        this.pendingCounts.set(agentId, (this.pendingCounts.get(agentId) ?? 0) + 1);
        const generation = this.agentGenerations.get(agentId) ?? 0;
        this.enqueue(agentId, async () => {
            try {
                if (this.shuttingDown || this.fencedAgents.has(agentId) || (this.agentGenerations.get(agentId) ?? 0) !== generation) {
                    this.finishResumeFailure(agentId, conversationId, turnId, "resume_aborted", "O resume foi cancelado porque o agente foi isolado.");
                    return;
                }
                await this.runResumeTurn(agentId, conversationId, selected, user?.content ?? "");
            }
            finally {
                this.resumeTurns.delete(`${agentId}\u0000${conversationId}\u0000${turnId}`);
                const next = (this.pendingCounts.get(agentId) ?? 1) - 1;
                if (next <= 0) this.pendingCounts.delete(agentId);
                else this.pendingCounts.set(agentId, next);
            }
        }, undefined, conversationId);
        return { accepted: true };
    }
    private finishResumeFailure(
        agentId: string,
        conversationId: string,
        turnId: string,
        code: string,
        text: string,
    ): { accepted: true } {
        this.closeOpenToolCalls(agentId, { ok: false, code: "aborted", message: text }, conversationId);
        const id = `notice:${turnId}:resume-${code}`;
        if (!this.store.getEntries(agentId, conversationId).some((entry) => entry.kind === "notice" && entry.id === id)) {
            this.appendAndPublish(agentId, [{ kind: "notice", id, type: "restart-interrupted", text, level: "error", retryable: false, turnId }], conversationId);
        }
        return { accepted: true };
    }
    private async runResumeTurn(
        agentId: string,
        conversationId: string,
        checkpoint: ResumeCheckpoint,
        prompt: string,
    ): Promise<void> {
        const controller = new AbortController();
        const streamController = new AbortController();
        const abort = () => streamController.abort(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
        this.turnControllers.set(agentId, controller);
        this.runningTurns += 1;
        const turn: TurnMetadata = {
            turnId: checkpoint.turnId,
            conversationId,
            provider: checkpoint.provider,
            model: checkpoint.model,
            modelResolution: this.store.getEntries(agentId, conversationId).find(
                (entry): entry is Extract<TranscriptEntry, { kind: "message" }> => entry.kind === "message" && entry.role === "user" && entry.turnId === checkpoint.turnId,
            )?.modelResolution,
            reasoningEffort: [...this.store.getEntries(agentId, conversationId)].reverse().find(
                (entry): entry is Extract<TranscriptEntry, { kind: "message" }> =>
                    entry.kind === "message" && entry.turnId === checkpoint.turnId && entry.reasoningEffort !== undefined,
            )?.reasoningEffort ?? this.resolveProviderFn(agentId, { agentId, prompt }).reasoningEffort,
            phase: "provider-pending",
            isResume: true,
            clientNonce: this.store.getEntries(agentId, conversationId).find(
                (entry): entry is Extract<TranscriptEntry, { kind: "message" }> =>
                    entry.kind === "message" && entry.role === "user" && entry.turnId === checkpoint.turnId,
            )?.clientNonce,
        };
        const partial = [...this.store.getEntries(agentId, conversationId)].reverse().find((entry) => entry.kind === "message" && entry.role === "assistant" && entry.turnId === checkpoint.turnId && entry.completionState === "interrupted");
        if (partial?.kind === "message") {
            this.liveAssistant.set(agentId, {
                id: partial.id,
                content: partial.content,
                lastPublishMs: this.nowFn(),
                lastPersistMs: this.nowFn(),
                limited: false,
                replicaKey: `transcript:${agentId}`,
                epoch: randomUUID(),
                sequence: 0,
                lastSnapshotSequence: 0,
            });
        }
        turn.streamController = streamController;
        try {
            const selectedScope = { agentId, conversationId, turnId: checkpoint.turnId, provider: checkpoint.provider, model: checkpoint.model };
            const liveCheckpoint = this.store.findResumeCheckpoint?.(agentId, conversationId, checkpoint.turnId)
                ?? this.store.getResumeCheckpoint?.(selectedScope)
                ?? checkpoint;
            try {
                assertCheckpointUsable(liveCheckpoint, selectedScope, this.nowFn());
            }
            catch (error) {
                const code = error instanceof ResumeProtocolError && error.code === "expired_checkpoint"
                    ? "expired_checkpoint"
                    : error instanceof ResumeProtocolError && error.code === "invalid_cursor"
                        ? "invalid_cursor"
                        : "foreign_checkpoint";
                this.finishResumeFailure(agentId, conversationId, checkpoint.turnId, code, code === "expired_checkpoint" ? "O checkpoint de resume expirou." : "O checkpoint de resume não é válido para este turno.");
                return;
            }
            if (typeof this.store.hasUnsafeResumeEffect !== "function" || this.store.hasUnsafeResumeEffect(selectedScope)) {
                this.finishResumeFailure(agentId, conversationId, checkpoint.turnId, "unsafe_effect", "O turno possui um efeito sem resultado durável; nenhum replay foi executado.");
                return;
            }
            if (this.resumeBudgetExhausted(liveCheckpoint.budget)) {
                this.finishResumeFailure(agentId, conversationId, checkpoint.turnId, "resume_budget_exhausted", "O budget original do turno foi consumido.");
                return;
            }
            this.updateTurnPhase(agentId, turn, "provider-pending");
            const context = this.toProviderMessages(agentId, prompt, "", undefined, liveCheckpoint.turnId, conversationId, "", undefined, 1, liveCheckpoint.model, liveCheckpoint.provider, [], undefined, turn.modelResolution);
            const result = await streamChat(liveCheckpoint.provider, {
                model: liveCheckpoint.model,
                modelResolution: turn.modelResolution,
                purpose: "turn",
                sessionId: createHash("sha256").update(JSON.stringify([agentId, conversationId ?? "legacy"])).digest("hex"),
                system: this.systemPromptFn(agentId),
                messages: context.messages,
                maxTokens: resolveModelCapabilities(turn.modelResolution?.entry ?? liveCheckpoint.model, liveCheckpoint.provider).maxOutputTokens,
                reasoningEffort: turn.reasoningEffort,
                signal: streamController.signal,
                resume: { cursor: liveCheckpoint.cursor },
            }, (event) => {
                if (event.type === "tool-call") {
                    this.finishResumeFailure(agentId, conversationId, liveCheckpoint.turnId, "unsafe_effect", "Resume não executa tools; o turno permanece sem replay.");
                    streamController.abort();
                    return;
                }
                this.onStreamEvent(agentId, event, turn, false);
            }, {
                registry: this.registry,
                admission: this.admission,
                agentId,
            });
            if (result.error !== undefined || result.aborted) {
                this.finalizeAssistant(agentId, this.liveAssistant.get(agentId)?.content, { keepPartial: true }, turn);
                this.finishResumeFailure(agentId, conversationId, checkpoint.turnId, result.error?.code ?? "resume_aborted", "O resume foi interrompido sem replay.");
                return;
            }
            if (typeof this.store.advanceResumeCheckpoint === "function") {
                const scope = { agentId, conversationId, turnId: liveCheckpoint.turnId, provider: liveCheckpoint.provider, model: liveCheckpoint.model };
                this.store.advanceResumeCheckpoint(scope, liveCheckpoint.version, {
                    cursor: result.cursor ?? liveCheckpoint.cursor,
                    safeSequenceId: typeof this.store.getLatestSequenceId === "function" ? this.store.getLatestSequenceId(agentId, conversationId) ?? liveCheckpoint.safeSequenceId : liveCheckpoint.safeSequenceId,
                    completedEffectIds: liveCheckpoint.completedEffectIds,
                    expiresAtMs: liveCheckpoint.expiresAtMs,
                    budget: { ...liveCheckpoint.budget, providerAttemptsUsed: liveCheckpoint.budget.providerAttemptsUsed + 1 },
                });
            }
        }
        catch {
            this.finishResumeFailure(agentId, conversationId, checkpoint.turnId, "resume_aborted", "O resume foi interrompido sem replay.");
        }
        finally {
            controller.signal.removeEventListener("abort", abort);
            this.turnControllers.delete(agentId);
            this.runningTurns = Math.max(0, this.runningTurns - 1);
        }
    }
    /** Bloqueia novos turnos durante uma operação de exclusão do agente. */
    fenceAgents(agentIds: readonly string[]): void {
        for (const agentId of agentIds) {
          this.fencedAgents.set(agentId, (this.fencedAgents.get(agentId) ?? 0) + 1);
          this.agentGenerations.set(agentId, (this.agentGenerations.get(agentId) ?? 0) + 1);
          for (const nonce of this.kickstartQueued.get(agentId) ?? []) this.store.cancelKickstartRun?.(agentId, nonce);
          const activeNonce = this.kickstartActiveNonce.get(agentId);
          if (activeNonce !== undefined) this.store.cancelKickstartRun?.(agentId, activeNonce);
          if (this.kickstartActive.has(agentId)) this.turnControllers.get(agentId)?.abort();
        }
    }
    /** Libera uma fence adquirida por uma operação de exclusão. */
    releaseAgentFence(agentIds: readonly string[]): void {
        for (const agentId of agentIds) {
            const remaining = (this.fencedAgents.get(agentId) ?? 0) - 1;
            if (remaining > 0)
                this.fencedAgents.set(agentId, remaining);
            else
                this.fencedAgents.delete(agentId);
        }
    }
    /**
     * Drops per-agent lifecycle state only after the roster deletion committed.
     * A rollback deliberately leaves the generation fence available to the
     * restored agent, while a successful deletion must not retain one forever.
     */
    cleanupDeletedAgents(agentIds: readonly string[]): void {
        for (const agentId of agentIds) {
            if (this.queues.has(agentId) ||
                this.pendingCounts.has(agentId) ||
                this.queuedNonces.has(agentId) ||
                this.queuedConversationIds.has(agentId) ||
                this.kickstartQueued.has(agentId) ||
                this.kickstartActive.has(agentId) ||
                this.turnControllers.has(agentId))
                continue;
            this.agentGenerations.delete(agentId);
            this.liveAssistant.delete(agentId);
            for (const key of this.transcriptOrderByKey.keys()) {
                if (key === `transcript:${agentId}` || key.startsWith(`transcript:${agentId}:entry:`))
                    this.transcriptOrderByKey.delete(key);
            }
        }
    }
    validateAcceptanceConversation(agentId: string, conversationId: string): void {
        try {
            if (this.conversationStore !== undefined) {
                // Acceptance lookup may inspect an inactive chat, but never an
                // archived, foreign, or otherwise unknown one.
                this.resolveConversation(agentId, conversationId, true);
                return;
            }
            this.store.validateConversation?.(agentId, conversationId);
        }
        catch (error) {
            if (error instanceof RpcError && error.status === 404)
                throw error;
            const message = error instanceof Error ? error.message : "conversation não encontrada para o agente";
            throw new RpcError(404, `promptAcceptanceStatus: ${message}`);
        }
    }
    acceptanceStatus(
        agentId: string,
        nonce: string,
        conversationId?: string,
    ): { outcome: "not-found" | "unknown-durability" } | { outcome: "found"; record: { status: "accepted"; echoEntryId?: string } } {
        if (conversationId !== undefined)
            this.validateAcceptanceConversation(agentId, conversationId);
        const resolvedScopes = conversationId !== undefined
            ? [conversationId]
            : this.store.findAcceptedNonceConversations?.(agentId, nonce) ?? (this.store.hasAcceptedNonce(agentId, nonce) ? [undefined] : []);
        if (resolvedScopes.length === 0)
            return { outcome: "not-found" };
        if (conversationId === undefined && resolvedScopes.length !== 1) {
            throw new RpcError(409, "promptAcceptanceStatus: conversationId é ambíguo");
        }
        const scopes = resolvedScopes;
        if (!this.store.hasAcceptedNonce(agentId, nonce, scopes[0]))
            return { outcome: "not-found" };
        let echo: TranscriptEntry | undefined;
        for (const scope of scopes) {
            echo = this.store.findUserEchoByNonce !== undefined
                ? this.store.findUserEchoByNonce(agentId, nonce, scope)
                : this.store.getEntries(agentId, scope).find((entry) => (entry.kind === "message" && entry.role === "user" && entry.clientNonce === nonce) ||
                    (entry.kind === "notice" && entry.type === "retry-attempt" && entry.clientNonce === nonce));
            if (echo !== undefined)
                break;
        }
        const echoEntryId = echo && typeof echo.id === "string" ? echo.id : undefined;
        if (echoEntryId === undefined) return { outcome: "unknown-durability" };
        return { outcome: "found", record: { status: "accepted", ...(echoEntryId ? { echoEntryId } : {}) } };
    }
    /**
     * Durable consumer barrier used by A2A. Absence or ambiguity fails closed:
     * an accepted nonce/user echo alone is not proof that the turn completed.
     */
    isPromptCompleted(agentId: string, nonce: string, conversationId?: string): boolean {
        if (this.store.hasCompletedTurnForNonce === undefined)
            return false;
        if (conversationId !== undefined) {
            this.validateAcceptanceConversation(agentId, conversationId);
            return this.store.hasCompletedTurnForNonce(agentId, nonce, conversationId);
        }
        const scopes = this.store.findAcceptedNonceConversations?.(agentId, nonce) ?? (this.store.hasAcceptedNonce(agentId, nonce) ? [undefined] : []);
        return scopes.length === 1 && this.store.hasCompletedTurnForNonce(agentId, nonce, scopes[0]);
    }
    findAgentIdByNonce(nonce: string): string | undefined {
        const ids = this.config?.snapshot().agents.map((entry) => entry.id) ?? [];
        if (!ids.includes("openbot-default"))
            ids.push("openbot-default");
        const matches = ids.filter((id) => ((this.store.findAcceptedNonceConversations?.(id, nonce).length ??
            (this.store.hasAcceptedNonce(id, nonce) ? 1 : 0)) > 0));
        if (matches.length > 1)
            throw new RpcError(409, "promptAcceptanceStatus: nonce é ambíguo");
        return matches[0];
    }
    /** Aguarda a fila do agente esvaziar (turnos já enfileirados até agora). */
    async flush(agentId: string): Promise<void> {
        await Promise.allSettled([...(this.preparingCatalog.get(agentId) ?? [])]);
        const tail = this.queues.get(agentId);
        return tail === undefined ? Promise.resolve() : tail.then(() => undefined);
    }
    /** Captures the current queue tails. Shutdown forbids new turns before using it. */
    async waitForDrain(): Promise<void> {
        await Promise.allSettled([...this.preparingCatalog.values()].flatMap(p => [...p]));
        const pending = [...this.queues.values()];
        return pending.length === 0
            ? Promise.resolve()
            : Promise.allSettled(pending).then(() => undefined);
    }
    /** Estado de ocupação (T13 pluga no /health do gateway). */
    getStatus(): {
        isBusy: boolean;
        activeAgentId: string | null;
        busyAgentIds: string[];
        runningTurns: number;
    } {
        const busyAgentIds = [...new Set([...this.turnControllers.keys(), ...this.pendingCounts.keys()])];
        return {
            isBusy: busyAgentIds.length > 0,
            activeAgentId: busyAgentIds[0] ?? null,
            busyAgentIds,
            runningTurns: this.runningTurns,
        };
    }
    cancelPrompt(agentId?: string): { cancelled: boolean; agentIds: string[] } {
        const known = new Set([...this.turnControllers.keys(), ...this.pendingCounts.keys()]);
        const ids = agentId ? (known.has(agentId) ? [agentId] : []) : known.size === 1 ? [...known] : [];
        for (const id of ids) {
            this.agentGenerations.set(id, (this.agentGenerations.get(id) ?? 0) + 1);
            for (const nonce of this.queuedNonces.get(id) ?? []) {
                this.store.forgetAcceptedNonce(id, nonce, this.queuedConversationIds.get(id)?.get(nonce));
            }
            this.queuedNonces.delete(id);
            this.queuedConversationIds.delete(id);
            for (const nonce of this.kickstartQueued.get(id) ?? []) this.store.cancelKickstartRun?.(id, nonce);
            const activeKickstartNonce = this.kickstartActiveNonce.get(id);
            if (activeKickstartNonce !== undefined) this.store.cancelKickstartRun?.(id, activeKickstartNonce);
            this.kickstartQueued.delete(id);
            this.turnControllers.get(id)?.abort();
        }
        return { cancelled: ids.length > 0, agentIds: ids };
    }
    async abortAllTurns(timeoutMs = 5_000): Promise<void> {
        this.shuttingDown = true;
        for (const controller of this.turnControllers.values())
            controller.abort();
        const drain = this.waitForDrain();
        if (this.queues.size === 0)
            return;
        let timedOut = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
            timeoutHandle = setTimeout(() => {
                timedOut = true;
                resolve();
            }, timeoutMs);
        });
        try {
            await Promise.race([drain, timeout]);
        }
        finally {
            if (timeoutHandle !== undefined)
                clearTimeout(timeoutHandle);
        }
        if (timedOut)
            throw new Error(`turn shutdown timed out after ${timeoutMs}ms`);
    }
    promptStatus(agentId?: string): { isBusy: boolean; canCancel: boolean; agentId: string | null; cancelRequested?: true } {
        if (agentId !== undefined) {
            const isBusy = (this.pendingCounts.get(agentId) ?? 0) > 0 || this.turnControllers.has(agentId);
            const cancelRequested = this.turnControllers.get(agentId)?.signal.aborted === true;
            return { isBusy, canCancel: isBusy && !cancelRequested, agentId, ...(cancelRequested ? { cancelRequested: true as const } : {}) };
        }
        const status = this.getStatus();
        return { isBusy: status.isBusy, canCancel: status.isBusy, agentId: status.activeAgentId };
    }
    // ── pipeline do turno ───────────────────────────────────────────────────────
    async runTurn(args: SandSendPromptArgs, inference: ResolvedProvider, origin: TurnOrigin = { kind: "user" }, acceptance?: { confirm(): void; reject(error: unknown): void }): Promise<void> {
        const { agentId, prompt, attachments, clientNonce, conversationId } = args;
        const turnId = `turn:${randomUUID()}`;
        const turn: TurnMetadata = {
            turnId,
            ...(conversationId === undefined ? {} : { conversationId }),
            ...inference,
            phase: "preparing",
            ...(clientNonce !== undefined ? { clientNonce } : {}),
            ...(args.retryOfClientNonce !== undefined ? { retryOfClientNonce: args.retryOfClientNonce } : {}),
        };
        this.store.beginTurnAttempt({
            turnId,
            agentId,
            ...(conversationId === undefined ? {} : { conversationId }),
            ...(clientNonce !== undefined ? { clientNonce } : {}),
            ...(args.retryOfClientNonce !== undefined ? { retryOfClientNonce: args.retryOfClientNonce } : {}),
            ...(args.retryFailureTurnId !== undefined ? { retryFailureTurnId: args.retryFailureTurnId } : {}),
            provider: inference.provider,
            model: inference.model,
            phase: "preparing",
            startedAtMs: this.nowFn(),
        });
        const controller = new AbortController();
        this.turnControllers.set(agentId, controller);
        this.runningTurns += 1;
        this.activity?.patch(agentId, {
            isRunning: true,
            lastEntry: previewFromText(prompt),
            lastMessagePreview: prompt,
        });
        let echoPersisted = false;
        try {
            // 1) snapshot no início (reset — contrato transcript, mapa-frontend §3.3)
            this.publishTranscriptSnapshot(agentId, conversationId);
            const isRetry = args.retryFailureTurnId !== undefined;
            const extracted = this.readAttachmentsFn
                ? await this.readAttachmentsFn(agentId, attachments, controller.signal, {
                    provider: inference.provider,
                    model: inference.model,
                    conversationId,
                    retry: isRetry,
                })
                : [];
            if (isRetry && (attachments ?? []).some((_, index) => extracted[index]?.imageDataUrl === undefined)) {
                throw new Error("Não foi possível recuperar a imagem da mensagem original. Anexe a imagem novamente para continuar.");
            }
            const unavailable = extracted.filter((entry) => entry.skipped !== undefined && entry.skipped !== "unsupported_feature");
            if (unavailable.length > 0) {
                throw new Error(`Anexos indisponíveis: ${unavailable.map((entry) => `${sanitizeDisplayFilename(entry.name)} (${entry.skipped})`).join(", ")}. Selecione esses arquivos novamente ou remova-os antes de enviar.`);
            }
            // P2.3 image gate: an image attachment is only acceptable when the exact
            // provider/model declares image support. Otherwise the turn fails with an
            // explicit `unsupported_feature` BEFORE any provider call — we never
            // silently coerce an image into an incompatible payload.
            const declaredImages = inference.provider && inference.model
                ? (inference.modelResolution?.capabilities.images ?? providerSupportsImages(inference.provider, inference.model))
                : false;
            const anyImageRequested = (attachments ?? []).length > 0
                && extracted.some((entry) => entry.kind === "image" || entry.imageDataUrl !== undefined || entry.skipped === "unsupported_feature");
            if (anyImageRequested && !declaredImages) {
                const imageError = Object.assign(new Error("unsupported_feature"), { code: "unsupported_feature" });
                throw imageError;
            }
            const imageAttachments = extracted.flatMap((entry) => entry.imageDataUrl === undefined
                ? []
                : [{ name: entry.name, dataUrl: entry.imageDataUrl }]);
            // P2.3 reply: resolve the durable persisted entry server-side. Client
            // quoted text is display-only; missing/temporary/foreign targets fail.
            const reply = args.replyContext === undefined
                ? undefined
                : this.resolveReply(agentId, args.replyContext, conversationId);
            const resolvedTurnContext: string | TurnContextResolution = this.resolveTurnContextFn
                ? await this.resolveTurnContextFn(agentId, args, controller.signal)
                : { source: "other", context: "" };
            if (typeof resolvedTurnContext !== "string" && resolvedTurnContext.error !== undefined) {
                throw new Error(`Skill context unavailable: ${resolvedTurnContext.error}`);
            }
            const turnContext = typeof resolvedTurnContext === "string"
                ? resolvedTurnContext
                : resolvedTurnContext.context;
            // The transcript remains the exact user input. Only the explicitly
            // tagged textual-command resolution may supply a normalized task to the
            // provider. Chip/workflow and other context never trigger this rewrite.
            const normalizedSkillPrompt = typeof resolvedTurnContext !== "string" && resolvedTurnContext.source === "text-command"
                ? resolvedTurnContext.normalizedPrompt
                : undefined;
            // 2) mensagem do usuário (+ anexos) no tail → appended
            const userEntry: TranscriptEntry = {
                kind: "message",
                id: this.newIdFn("user"),
                role: "user",
                content: prompt,
                timestampMs: this.nowFn(),
                ...(origin.kind === "user"
                    ? { fromUser: this.humanAuthor() }
                    : { fromAgent: this.agentPeer(origin.agentId) }),
                streaming: false,
                isStreaming: false,
                turnId,
                provider: inference.provider,
                model: inference.model,
                modelResolution: inference.modelResolution,
                reasoningEffort: inference.reasoningEffort ?? "medium",
                ...(clientNonce !== undefined ? { clientNonce } : {}),
                ...(reply !== undefined ? { replyTo: { replyToId: reply.replyToId, quotedText: reply.quotedText } } : {}),
            };
            const appended: TranscriptEntry[] = [userEntry];
            for (const [index, attachment] of (attachments ?? []).entries()) {
                // readTurnAttachments preserva a ordem. Associação posicional evita
                // que dois arquivos homônimos recebam ambos o conteúdo do primeiro.
                const read = extracted[index];
                const isOpaque = typeof attachment.path === "string" && attachment.path.startsWith("attachment:");
                const safeFileName = typeof read?.name === "string" && read.name.trim().length > 0 ? read.name : sanitizeDisplayFilename(attachment.name);
                appended.push({
                    kind: "user-attachment",
                    id: `att:${this.newIdFn("user")}`,
                    file_name: safeFileName,
                    file_path: attachment.path,
                    ...(isOpaque ? { attachment_id: attachment.path.slice("attachment:".length) } : {}),
                    clientNonce,
                    turnId,
                    ...(read?.text !== undefined ? { extractedText: read.text } : {}),
                    ...(read?.skipped !== undefined ? { skipped: read.skipped, skippedImage: read.kind === "image" && read.imageDataUrl === undefined && read.skipped === "unsupported_feature" } : {}),
                });
            }
            if (isRetry) {
                this.appendAndPublish(agentId, [{
                        kind: "notice",
                        type: "retry-attempt",
                        id: `retry-attempt:${turnId}`,
                        text: "Nova tentativa iniciada.",
                        level: "info",
                        turnId,
                        clientNonce,
                        retryOfClientNonce: args.retryOfClientNonce,
                        retryFailureTurnId: args.retryFailureTurnId,
                        provider: inference.provider,
                        model: inference.model,
                    }], conversationId);
            }
            else {
                this.appendAndPublish(agentId, appended, conversationId, true);
                if (conversationId !== undefined && prompt.trim().length > 0) {
                    this.conversationStore?.updateAutoTitle(agentId, conversationId, prompt);
                }
            }
            echoPersisted = true;
            // The user echo is the durable commit point for the acceptance ledger.
            // If the process dies before this point, SQLite startup reconciliation
            // removes the pending nonce and a retry may safely enqueue the turn.
            if (clientNonce !== undefined)
                this.store.rememberAcceptedNonce(agentId, clientNonce, conversationId);
            acceptance?.confirm();
            this.updateTurnPhase(agentId, turn, "provider-pending");
            const { provider, model } = inference;
            const memoryContext = this.resolveMemoryTurnContext(agentId, conversationId);
            const baseTools = await this.toolsFor(agentId, controller.signal);
            if (controller.signal.aborted) {
                this.closeOpenToolCalls(agentId, {
                    ok: false,
                    code: "aborted",
                    message: "turn aborted",
                }, conversationId);
                this.appendAndPublish(agentId, [retryableTurnNotice(turn, "aborted-after-echo", "O turno foi interrompido depois que sua mensagem foi aceita.")], conversationId);
                return;
            }
            const toolDiscoveryNotice = this.toolDiscoveryNoticeFn?.(agentId);
            if (toolDiscoveryNotice) {
                this.appendAndPublish(agentId, [{
                        kind: "notice",
                        id: `notice:${turnId}:tool-discovery`,
                        text: toolDiscoveryNotice,
                        level: "info",
                        turnId,
                        provider,
                        model,
                    }], conversationId);
            }
            const memoryStore = this.memoryStore();
            const explicitMemoryIntent = origin.kind === "user" && isExplicitMemoryIntent(prompt);
            const memorySourceEntryId = isRetry
                ? [...this.store.getEntries(agentId, conversationId)].reverse().find((entry) => (entry.kind === "message" &&
                    entry.role === "user" &&
                    (entry.turnId === args.retryFailureTurnId ||
                        (args.retryOfClientNonce !== undefined && entry.clientNonce === args.retryOfClientNonce))))
                    ?.id
                : userEntry.id;
            const memoryGuidance = buildMemorySystemGuidance(memoryContext.mode, memoryContext.conversation, explicitMemoryIntent);
            const memorySystemPrompt = [this.systemPromptFn(agentId), memoryGuidance].filter((value) => value.length > 0).join("\n\n");
            const memorySearchTool = memoryStore
                ? createMemorySearchTool({ memoryStore, mode: memoryContext.mode, agentId, conversation: memoryContext.conversation })
                : undefined;
            const memoryRememberOptions = memoryStore === undefined ? undefined : {
                contextSources: turn.memoryContextSources = [],
                memoryStore,
                mode: memoryContext.mode,
                agentId,
                conversation: memoryContext.conversation,
                conversationId,
                sourceEntryId: typeof memorySourceEntryId === "string" ? memorySourceEntryId : undefined,
                explicitIntent: explicitMemoryIntent,
            };
            const memoryRememberTool = memoryRememberOptions === undefined ? undefined : createMemoryRememberTool(memoryRememberOptions);
            const memoryForgetTool = memoryRememberOptions === undefined ? undefined : createMemoryForgetTool(memoryRememberOptions);
            const memoryTools = [memorySearchTool, memoryRememberTool, memoryForgetTool].filter((tool) => tool !== undefined);
            const tools = [...(baseTools ?? []), ...memoryTools];
            const memoryToolExecutor = memoryStore === undefined
                ? undefined
                : Object.assign(async (context: Parameters<ToolCallExecutor>[0]) => {
                    if (memoryRememberOptions !== undefined) {
                        const remembered = await executeMemoryRememberTool(context, memoryRememberOptions);
                        if (remembered.handled)
                            return remembered;
                        const forgotten = await executeMemoryForgetTool(context, memoryRememberOptions);
                        if (forgotten.handled)
                            return forgotten;
                    }
                    return executeMemorySearchTool(context, {
                        onContextSources: (sources) => turn.memoryContextSources?.push(...sources),
                        memoryStore,
                        mode: memoryContext.mode,
                        agentId,
                        conversation: memoryContext.conversation,
                    });
                }, { canHandle: (toolName: string) => toolName === MEMORY_SEARCH_TOOL_NAME || toolName === MEMORY_REMEMBER_TOOL_NAME || toolName === MEMORY_FORGET_TOOL_NAME });
            const executeTool = composeToolExecutors(memoryToolExecutor, this.toolExecutor);
            let conversationCompactionNeeded = false;
            const runProviderAttempt = async (budgetScale: number, buffered: boolean) => {
                const providerTools = tools.length > 0 ? tools : undefined;
                const playback: Array<() => void> = [];
                let observableCount = 0;
                let playbackFlushed = !buffered;
                const queuePlayback = (action: () => void, observable = false) => {
                    if (playbackFlushed) {
                        action();
                        return;
                    }
                    playback.push(action);
                    if (!observable)
                        return;
                    playbackFlushed = true;
                    while (playback.length > 0)
                        playback.shift()?.();
                };
                const attachmentContext = [formatAttachmentContext(extracted), turnContext]
                    .filter((value) => value.trim().length > 0)
                    .join("\n\n");
                const toolText = JSON.stringify(providerTools ?? []);
                const buildContext = (scale: number) => {
                    const context = this.toProviderMessages(agentId, prompt, attachmentContext, normalizedSkillPrompt === undefined ? undefined : { original: prompt, normalized: normalizedSkillPrompt }, args.retryFailureTurnId, conversationId, toolText, memoryContext, scale, model, provider, imageAttachments, memorySystemPrompt, inference.modelResolution);
                    turn.memoryContextSources?.push(...context.memoryContextSources ?? []);
                    return context;
                };
                const publishContextNotice = (context: ProviderContextResult) => {
                    if (!context.truncated || turn.contextNoticePublished)
                        return;
                    turn.contextNoticePublished = true;
                    const budget = context.modelBudget;
                    this.appendAndPublish(agentId, [{
                            kind: "notice",
                            id: `notice:${turnId}:context-truncated`,
                            text: "O histórico antigo foi resumido ou omitido para caber no contexto.",
                            level: "info",
                            turnId,
                            provider,
                            model,
                            ...(budget === undefined ? {} : {
                                contextCategories: {
                                    used: budget.used,
                                    availableTokens: budget.availableContentTokens,
                                },
                            }),
                        }], conversationId);
                };
                const context = buildContext(budgetScale);
                conversationCompactionNeeded ||= shouldCompactConversationContext(context);
                publishContextNotice(context);
                const messages = context.messages;
                const streamController = new AbortController();
                const abortStream = () => streamController.abort(controller.signal.reason);
                if (controller.signal.aborted)
                    abortStream();
                else
                    controller.signal.addEventListener("abort", abortStream, { once: true });
                turn.streamController = streamController;
                let request: ProviderChatRequest = {
                    model,
                    modelResolution: inference.modelResolution,
                    purpose: "turn",
                    sessionId: createHash("sha256").update(JSON.stringify([agentId, conversationId ?? "legacy"])).digest("hex"),
                    acceptsImages: inference.modelResolution?.capabilities.images ?? MODEL_CATALOG.find((entry) => entry.id === model)?.supportsVision === true,
                    system: messages.some((message) => message.role === "user" && typeof message.content === "string" && message.content.includes(OPENBOT_UNTRUSTED_MEMORY_CONTEXT_BEGIN))
                        ? `${memorySystemPrompt}\n\n${OPENBOT_UNTRUSTED_MEMORY_CONTEXT_NOTE}`
                        : memorySystemPrompt,
                    messages,
                    ...(providerTools === undefined ? {} : { tools: providerTools }),
                    maxTokens: context.modelBudget?.outputReserveTokens ?? resolveModelCapabilities(inference.modelResolution?.entry ?? model, provider).maxOutputTokens,
                    reasoningEffort: inference.reasoningEffort ?? "medium",
                    signal: streamController.signal,
                };
                const hasToolLoop = (this.executionBroker !== undefined || executeTool !== undefined) && (providerTools?.length ?? 0) > 0;
                const serializeRequest = requestSerializerFor(this.registry, provider);
                const capabilities = resolveModelCapabilities(inference.modelResolution?.entry ?? model, provider);
                const initialPrepared = prepareProviderRound(request, {
                    capabilities,
                    maxBytes: capabilities.maxRequestBytes ?? CONTEXT_HARD_LIMIT_BYTES,
                    provider,
                    ...(serializeRequest === undefined ? {} : { serializeRequest }),
                });
                logContextTelemetry(provider, model, initialPrepared.telemetry);
                if (initialPrepared.exhausted)
                    throw new Error("provider context budget exhausted");
                request = initialPrepared.request;
                const onEvent = (event: ProviderStreamEvent) => {
                    const observable = event.type !== "error";
                    if (observable)
                        observableCount += 1;
                    const action = () => this.onStreamEvent(agentId, event, turn, hasToolLoop);
                    queuePlayback(action, observable);
                };
                try {
                    if (hasToolLoop && providerTools) {
                        return {
                            kind: "tool",
                            playback,
                            observableCount,
                            result: await runToolLoop({
                                agentId,
                                ...(conversationId === undefined ? {} : { conversationId }),
                                request,
                                broker: this.executionBroker,
                                resolveHostPermission: this.resolveHostPermission,
                                executeTool,
                                ...(memoryRememberTool === undefined ? {} : { deferTextUntilToolResultFor: [MEMORY_REMEMBER_TOOL_NAME, MEMORY_FORGET_TOOL_NAME] }),
                                resumableEffects: this.resumableEffectsFor(agentId, conversationId, turnId, provider, model, turn),
                                onEvent,
                                onProgress: ({ entry }) => {
                                    observableCount += 1;
                                    const action = () => this.publishToolCall(agentId, entry, conversationId);
                                    queuePlayback(action, true);
                                },
                                turnId,
                                ...(budgetScale < 1 ? {} : {
                                    contextOverflowRetry: {
                                        isOverflow: isContextOverflowError,
                                        messages: () => {
                                            const reduced = buildContext(0.5);
                                            publishContextNotice(reduced);
                                            return reduced.messages;
                                        },
                                    },
                                }),
                                stream: (next, emit) => {
                                    if ((turn.providerAttemptsUsed ?? 0) > 0) {
                                        turn.toolRoundsUsed = (turn.toolRoundsUsed ?? 0) + 1;
                                    }
                                    turn.providerAttemptsUsed = (turn.providerAttemptsUsed ?? 0) + 1;
                                    return streamChat(provider, next, emit, {
                                        registry: this.registry,
                                        admission: this.admission,
                                        agentId,
                                    });
                                },
                                prepareRequest: (nextMessages) => {
                                    const capabilities = resolveModelCapabilities(inference.modelResolution?.entry ?? model, provider);
                                    const prepared = prepareProviderRound({ ...request, messages: [...nextMessages] }, {
                                        capabilities,
                                        maxBytes: capabilities.maxRequestBytes ?? CONTEXT_HARD_LIMIT_BYTES,
                                        provider,
                                        ...(serializeRequest === undefined ? {} : { serializeRequest }),
                                    });
                                    logContextTelemetry(provider, model, prepared.telemetry);
                                    if (prepared.exhausted)
                                        throw new Error("provider context budget exhausted");
                                    return prepared.request;
                                },
                            }),
                        };
                    }
                    turn.providerAttemptsUsed = (turn.providerAttemptsUsed ?? 0) + 1;
                    return {
                        kind: "stream",
                        playback,
                        observableCount,
                        result: await streamChat(provider, request, onEvent, {
                            registry: this.registry,
                            admission: this.admission,
                            agentId,
                        }),
                    };
                }
                finally {
                    controller.signal.removeEventListener("abort", abortStream);
                    if (turn.streamController === streamController)
                        delete turn.streamController;
                }
            };
            let providerAttempt = await runProviderAttempt(1, true);
            const retryableOverflow = providerAttempt.kind === "stream"
                && providerAttempt.observableCount === 0
                && ! providerAttempt.result.aborted
                && providerAttempt.result.error !== undefined
                && isContextOverflowError(providerAttempt.result.error);
            if (retryableOverflow) {
                providerAttempt = await runProviderAttempt(0.5, false);
            }
            else {
                for (const action of providerAttempt.playback)
                    action();
            }
            this.persistResumeCheckpoint(agentId, turn, conversationId, providerAttempt.result?.cursor ?? turn.resumeCursor);
            const ensureAbortedNotice = () => {
                // Direct lookup when available; full-scan fallback preserves behavior.
                const alreadyPublished = this.store.findRetryableErrorNotice !== undefined
                    ? this.store.findRetryableErrorNotice(agentId, turn.turnId, conversationId) !== undefined
                    : this.store.getEntries(agentId, conversationId).some((entry) => (entry.kind === "notice" && entry.turnId === turn.turnId && entry.retryable === true));
                if (alreadyPublished)
                    return;
                this.finalizeAssistant(agentId, this.liveAssistant.get(agentId)?.content, { keepPartial: true }, turn);
                this.appendAndPublish(agentId, [retryableTurnNotice(turn, "aborted", "Geração interrompida.")], conversationId);
            };
            if (providerAttempt.kind === "tool") {
                const loopResult = providerAttempt.result;
                if (loopResult.aborted || loopResult.error) {
                    this.closeOpenToolCalls(agentId, {
                        ok: false,
                        code: loopResult.aborted ? "aborted" : "io_error",
                        message: loopResult.error?.message ?? "turn aborted",
                    }, conversationId);
                    if (loopResult.aborted)
                        ensureAbortedNotice();
                    if (!loopResult.aborted && ["tool_call_limit", "tool_round_limit", "tool_repetition_limit"].includes(loopResult.error?.code ?? "")) {
                        this.appendAndPublish(agentId, [retryableTurnNotice(turn, "tool-loop-limit", "Não foi possível concluir: o modelo excedeu o limite seguro de ferramentas.")], conversationId);
                    }
                }
                else if ((loopResult.message?.content.trim().length ?? 0) === 0) {
                    this.appendAndPublish(agentId, [retryableTurnNotice(turn, "empty-provider-response", "O provedor concluiu sem retornar conteúdo.")], conversationId);
                }
                else {
                    this.enqueueReflectionJob(agentId, provider, model, origin.kind === "user" ? prompt : "", conversationId, memoryContext, conversationCompactionNeeded, inference.reasoningEffort ?? "medium");
                }
            }
            else {
                const streamResult = providerAttempt.result;
                if (streamResult.aborted)
                    ensureAbortedNotice();
                if (!streamResult.aborted && !streamResult.error && (streamResult.message?.content.trim().length ?? 0) === 0) {
                    this.appendAndPublish(agentId, [retryableTurnNotice(turn, "empty-provider-response", "O provedor concluiu sem retornar conteúdo.")], conversationId);
                }
                else if (!streamResult.aborted && !streamResult.error) {
                    this.enqueueReflectionJob(agentId, provider, model, origin.kind === "user" ? prompt : "", conversationId, memoryContext, conversationCompactionNeeded, inference.reasoningEffort ?? "medium");
                }
            }
        }
        catch (err) {
            if (!echoPersisted) acceptance?.reject(new RpcError(500, `Envio não salvo: ${err instanceof Error ? err.message : String(err)}`));
            // streamChat nunca lança (erros viram evento `error`); este catch é a rede
            // de segurança para falhas inesperadas — notifica via notice e segue.
            if (clientNonce !== undefined)
                this.forgetNonceIfNoUserEcho(agentId, clientNonce, conversationId);
            const text = `Falha ao processar o turno: ${err instanceof Error ? err.message : String(err)}`;
            if (echoPersisted) {
                this.closeOpenToolCalls(agentId, { ok: false, code: "io_error", message: text }, conversationId);
                this.finalizeAssistant(agentId, this.liveAssistant.get(agentId)?.content, { keepPartial: true }, turn);
                this.appendAndPublish(agentId, [retryableTurnNotice(turn, "turn-error", text)], conversationId);
            }
            else {
                this.appendAndPublish(agentId, [{ kind: "notice", text: `Envio não salvo: ${err instanceof Error ? err.message : String(err)}`, level: "error" }], conversationId);
            }
        }
        finally {
            try {
                this.closeOpenToolCalls(agentId, { ok: false, code: "aborted", message: "Turn ended before tool completion." }, conversationId);
            }
            catch {
                // Transcript cleanup must not prevent turn/controller teardown.
            }
            this.finalizeAssistant(agentId, this.liveAssistant.get(agentId)?.content, { silent: true }, turn);
            this.runningTurns = Math.max(0, this.runningTurns - 1);
            this.turnControllers.delete(agentId);
            const live = this.latestAssistantPreview(agentId, conversationId);
            this.activity?.patch(agentId, {
                isRunning: (this.pendingCounts.get(agentId) ?? 0) > 1,
                ...(live ? { lastMessageId: live.id, lastMessagePreview: live.content, lastEntry: previewFromText(live.content) } : {}),
            });
            this.store.finishTurnAttempt(agentId, turnId);
        }
    }
    /**
     * P2.3 reply resolution. Resolves the durable persisted entry the reply
     * references; the client's quoted text is never treated as authority.
     * Rejects missing targets, temporary conversations, and foreign-agent /
     * foreign-conversation references.
     */
    private resolveReply(
        agentId: string,
        replyContext: NonNullable<SandSendPromptArgs["replyContext"]>,
        turnConversationId?: string,
    ): { replyToId: string; quotedText: string } {
        const targetConversation = replyContext.conversationId;
        if (turnConversationId !== undefined && turnConversationId !== targetConversation) {
            throw new Error("reply_conversa_estrangeira");
        }
        if (typeof this.store.validateConversation === "function") {
            try {
                this.store.validateConversation(agentId, targetConversation);
            }
            catch {
                throw new Error("reply_conversa_inexistente");
            }
        }
        if (this.conversationStore) {
            let temporary = false;
            try {
                let cursor: string | undefined;
                do {
                    const page = this.conversationStore.list(agentId, { limit: 200, ...(cursor === undefined ? {} : { cursor }) });
                    const conversation = page.items.find((entry) => entry.id === targetConversation);
                    if (conversation !== undefined) {
                        temporary =  conversation.temporary;
                        break;
                    }
                    cursor = page.nextCursor;
                } while (cursor !== undefined);
            }
            catch {
                temporary = false;
            }
            if (temporary)
                throw new Error("reply_conversa_temporaria");
        }
        const entries = this.store.getEntries(agentId, targetConversation);
        if (entries.length === 0)
            throw new Error("reply_alvo_inexistente");
        const entry = entries.find((candidate) => candidate.id === replyContext.replyToId);
        if (entry === undefined)
            throw new Error("reply_alvo_inexistente");
        let text = "";
        if (entry.kind === "message")
            text = typeof entry.content === "string" ? entry.content : "";
        else if (entry.kind === "user-attachment")
            text = entry.extractedText ?? "";
        const quoted = text.trim().slice(0, 400);
        return { replyToId: replyContext.replyToId, quotedText: quoted };
    }
    updateTurnPhase(agentId: string, turn: TurnMetadata, phase: TurnAttemptPhase): void {
        if (turn.phase === phase)
            return;
        this.store.updateTurnAttempt(agentId, turn.turnId, phase);
        turn.phase = phase;
    }
    private persistResumeCheckpoint(
        agentId: string,
        turn: TurnMetadata,
        conversationId: string | undefined,
        cursor: string | undefined,
    ): void {
        if (typeof cursor !== "string" || cursor.length === 0 || typeof this.store.createResumeCheckpoint !== "function")
            return;
        const adapter = this.registry.get(turn.provider);
        if (adapter?.resumeChat === undefined)
            return;
        const resolvedConversationId = conversationId ?? this.conversationStore?.ensureDefault(agentId)?.id;
        if (typeof resolvedConversationId !== "string" || resolvedConversationId.length === 0)
            return;
        const safeSequenceId = typeof this.store.getLatestSequenceId === "function"
            ? this.store.getLatestSequenceId(agentId, resolvedConversationId) ?? 0
            : this.store.getEntries(agentId, resolvedConversationId).length;
        const existing = this.store.findResumeCheckpoint?.(agentId, resolvedConversationId, turn.turnId);
        if (existing !== undefined) {
            if (existing.cursor === cursor && existing.safeSequenceId >= safeSequenceId)
                return;
            this.store.advanceResumeCheckpoint?.({
                agentId,
                conversationId: resolvedConversationId,
                turnId: turn.turnId,
                provider: turn.provider,
                model: turn.model,
            }, existing.version, {
                cursor,
                safeSequenceId: Math.max(existing.safeSequenceId, safeSequenceId),
                completedEffectIds: [...new Set([...existing.completedEffectIds, ...(turn.completedEffectIds ?? [])])],
                expiresAtMs: existing.expiresAtMs,
                budget: this.resumeBudgetSnapshot(turn, existing.budget),
            });
            return;
        }
        this.store.createResumeCheckpoint({
            checkpointId: `checkpoint:${turn.turnId}`,
            agentId,
            conversationId: resolvedConversationId,
            turnId: turn.turnId,
            provider: turn.provider,
            model: turn.model,
            cursor,
            safeSequenceId,
            completedEffectIds: turn.completedEffectIds ?? [],
            expiresAtMs: this.nowFn() + 24 * 60 * 60 * 1_000,
            version: 1,
            budget: this.resumeBudgetSnapshot(turn),
        });
    }
    private resumeBudgetSnapshot(turn: TurnMetadata, previous?: ResumeBudgetSnapshot): ResumeBudgetSnapshot {
        return {
            maxProviderAttempts: previous?.maxProviderAttempts ?? 3,
            providerAttemptsUsed: Math.max(previous?.providerAttemptsUsed ?? 0, turn.providerAttemptsUsed ?? 1),
            maxToolRounds: previous?.maxToolRounds ?? MAX_TOOL_ROUNDS,
            toolRoundsUsed: Math.max(previous?.toolRoundsUsed ?? 0, turn.toolRoundsUsed ?? 0),
            maxToolCalls: previous?.maxToolCalls ?? 128,
            toolCallsUsed: Math.max(previous?.toolCallsUsed ?? 0, turn.toolCallsUsed ?? 0),
        };
    }
    private resumeBudgetExhausted(budget: ResumeBudgetSnapshot): boolean {
        return budget.providerAttemptsUsed >= budget.maxProviderAttempts
            || budget.toolRoundsUsed >= budget.maxToolRounds
            || budget.toolCallsUsed >= budget.maxToolCalls;
    }
    private resumableEffectsFor(
        agentId: string,
        conversationId: string | undefined,
        turnId: string,
        provider: string,
        model: string,
        turn: TurnMetadata,
    ): ToolLoopResumableEffects | undefined {
        if (typeof this.store.prepareResumeEffect !== "function"
            || typeof this.store.markResumeEffectStarted !== "function"
            || typeof this.store.completeResumeEffect !== "function"
            || (turn.modelResolution?.capabilities.resume ?? resolveProviderCapabilities(provider, model).resume) !== "cursor")
            return undefined;
        const scopeConversationId = conversationId ?? this.conversationStore?.ensureDefault(agentId)?.id;
        if (typeof scopeConversationId !== "string" || scopeConversationId.length === 0)
            return undefined;
        const scope = { agentId, conversationId: scopeConversationId, turnId, provider, model };
        const ledger: ToolLoopResumableEffects = {
            prepare: (effectId, fingerprintHash) => this.store.prepareResumeEffect!(scope, effectId, fingerprintHash),
            markStarted: (effectId) => this.store.markResumeEffectStarted!(scope, effectId),
            markUnsafe: (effectId) => this.store.markResumeEffectUnsafe?.(scope, effectId),
            complete: (effectId, fingerprintHash, result) => {
                turn.toolCallsUsed = (turn.toolCallsUsed ?? 0) + 1;
                const completedEffectIds = [...new Set([...(turn.completedEffectIds ?? []), effectId])];
                turn.completedEffectIds = completedEffectIds;
                const checkpoint = this.store.findResumeCheckpoint?.(agentId, scopeConversationId, turnId);
                if (checkpoint !== undefined && typeof this.store.commitResumeEffectAndCheckpoint === "function") {
                    this.store.commitResumeEffectAndCheckpoint({
                        scope,
                        effectId,
                        fingerprintHash,
                        result,
                        checkpoint: {
                            expectedVersion: checkpoint.version,
                            cursor: checkpoint.cursor,
                            safeSequenceId: checkpoint.safeSequenceId,
                            completedEffectIds,
                            expiresAtMs: checkpoint.expiresAtMs,
                            budget: this.resumeBudgetSnapshot(turn, checkpoint.budget),
                        },
                    });
                }
                return this.store.completeResumeEffect!(scope, effectId, fingerprintHash, result);
            },
        };
        return ledger;
    }
    /** Entries kind "message" → mensagens do diálogo (system fica à parte). */
    private toProviderMessages(
        agentId: string,
        promptText: string,
        currentAttachmentContext = "",
        currentPromptOverride?: { original: string; normalized: string },
        omittedAssistantTurnId?: string,
        conversationId?: string,
        toolText = "",
        memoryContext?: MemoryTurnContext,
        budgetScale = 1,
        model?: string,
        provider?: string,
        imageAttachments: readonly { name: string; dataUrl: string }[] = [],
        systemTextOverride?: string,
        modelResolution?: ModelResolution,
    ): ContextAssemblyResult {
        const anchorEntry = this.store.getEarliestUser(agentId, conversationId);
        const anchorContent = anchorEntry?.content;
        const memoryStore = this.memoryStore();
        const resolvedSystemText = systemTextOverride ?? this.systemPromptFn(agentId);
        if (memoryStore && memoryContext) {
            const assembler = new ContextAssembler();
            const assembled = assembler.assemble({
                agentId,
                conversationId,
                prompt: currentPromptOverride?.normalized ?? currentPromptOverride?.original ?? promptText,
                currentAttachmentContext,
                currentPromptOverride,
                omittedAssistantTurnId,
                recentStore: this.store,
                memoryStore,
                mode: memoryContext.mode,
                conversation: memoryContext.conversation,
                systemText: resolvedSystemText,
                toolText,
                systemNoteText: memoryStore === undefined ? "" : OPENBOT_UNTRUSTED_MEMORY_CONTEXT_NOTE,
                budgetScale,
                modelCapabilities: model === undefined ? undefined : resolveModelCapabilities(modelResolution?.entry ?? model, provider),
            });
            // A summary replaces the compacted prefix, including the initial request.
            // Reinjecting that request can revive values superseded by later corrections.
            const summarized = conversationId !== undefined && Boolean(memoryStore.getSummary(agentId, conversationId, true)?.renderedText.trim());
            const anchored = fitProviderMessagesWithAnchor(assembled.messages, summarized ? undefined : anchorContent, assembled.availableBytes, MAX_PROVIDER_TRANSCRIPT_MESSAGES);
            const capabilities = model === undefined ? undefined : resolveModelCapabilities(modelResolution?.entry ?? model, provider);
            const tokenizer = capabilities === undefined ? undefined : createContextTokenizer(capabilities.tokenizerStrategy);
            const tokenFitted = capabilities === undefined || tokenizer === undefined
                ? anchored.messages
                : selectCompleteMessageGroups(anchored.messages, tokenizer, assembled.modelBudget?.availableContentTokens ?? 0);
            const finalMessages = fitProviderMessagesToByteBudget(tokenFitted, assembled.availableBytes);
            const finalBudget = assembled.modelBudget === undefined || tokenizer === undefined
                ? undefined
                : {
                    ...assembled.modelBudget,
                    used: {
                        ...assembled.modelBudget.used,
                        ...classifyProviderMessageTokens(finalMessages, tokenizer),
                    },
                    truncated: assembled.modelBudget.truncated || anchored.truncated || JSON.stringify(finalMessages) !== JSON.stringify(anchored.messages),
                };
            const withImages = this.attachImageParts(finalMessages, imageAttachments);
            return {
                messages: withImages,
                memoryContextSources: [
                    ...assembled.memoryContextSources ?? [],
                    ...(anchorEntry && conversationId && finalMessages.some((message) => message.role === "user" && typeof message.content === "string" && message.content.includes(anchorEntry.content))
                        ? [{ conversationId, entryId: anchorEntry.id }] : []),
                ],
                bytes: Buffer.byteLength(JSON.stringify(withImages), "utf8"),
                availableBytes: assembled.availableBytes,
                truncated: assembled.truncated || anchored.truncated || JSON.stringify(withImages) !== JSON.stringify(anchored.messages),
                modelBudget: finalBudget,
            };
        }
        const messages: ProviderChatMessage[] = [];
        let pendingUser: string | undefined;
        const flushUser = () => {
            if (pendingUser === undefined)
                return;
            messages.push({ role: "user", content: pendingUser });
            pendingUser = undefined;
        };
        const recent = this.store.getRecentEntries(agentId, {
            limit: MAX_PROVIDER_TRANSCRIPT_MESSAGES * 2,
            kinds: ["message", "user-attachment"],
        }, conversationId);
        for (const entry of recent) {
            if (entry.kind === "message" && entry.role === "user") {
                flushUser();
                pendingUser = entry.content;
                continue;
            }
            if (entry.kind === "user-attachment") {
                if (entry.extractedText && pendingUser !== undefined) {
                    const attachmentContext = formatAttachmentContext([{
                            name: entry.file_name,
                            path: entry.file_path,
                            text: entry.extractedText,
                        }]);
                    pendingUser = `${pendingUser}\n\n${attachmentContext}`;
                }
                continue;
            }
            if (entry.kind === "message" && entry.role === "assistant") {
                flushUser();
                const omittedByRetry = omittedAssistantTurnId !== undefined && entry.turnId === omittedAssistantTurnId;
                if (!entry.streaming && entry.completionState !== "interrupted" && !omittedByRetry) {
                    messages.push({ role: "assistant", content: entry.content });
                }
            }
        }
        flushUser();
        if (currentPromptOverride !== undefined && messages.length > 0) {
            const last = messages[messages.length - 1];
            if (last?.role === "user" && typeof last.content === "string" && (last.content === currentPromptOverride.original || last.content.startsWith(`${currentPromptOverride.original}\n\n`))) {
                last.content = `${currentPromptOverride.normalized}${last.content.slice(currentPromptOverride.original.length)}`;
            }
        }
        if (currentAttachmentContext && messages.length > 0) {
            const last = messages[messages.length - 1];
            if (last?.role === "user" && typeof last.content === "string" && !last.content.includes("[[OPENBOT_UNTRUSTED_ATTACHMENT_BEGIN]]")) {
                last.content = last.content.length > 0
                    ? `${last.content}\n\n${currentAttachmentContext}`
                    : currentAttachmentContext;
            }
        }
        const capabilities = model === undefined ? undefined : resolveModelCapabilities(modelResolution?.entry ?? model, provider);
        const tokenizer = capabilities === undefined ? undefined : createContextTokenizer(capabilities.tokenizerStrategy);
        const systemText = `${resolvedSystemText}${memoryStore === undefined ? "" : OPENBOT_UNTRUSTED_MEMORY_CONTEXT_NOTE}`;
        const fixedSystemBytes = Buffer.byteLength(systemText, "utf8");
        const toolBytes = Buffer.byteLength(toolText, "utf8");
        const maxRequestBytes = capabilities?.maxRequestBytes ?? CONTEXT_HARD_LIMIT_BYTES;
        const byteBudget = Math.max(0, Math.floor((maxRequestBytes - fixedSystemBytes - toolBytes) * Math.max(0.25, Math.min(1, budgetScale))));
        const anchored = fitProviderMessagesWithAnchor(messages, anchorContent, byteBudget, MAX_PROVIDER_TRANSCRIPT_MESSAGES);
        if (capabilities === undefined || tokenizer === undefined) {
            return {
                ...anchored,
                bytes: Buffer.byteLength(JSON.stringify(anchored.messages), "utf8"),
                availableBytes: byteBudget,
            };
        }
        const tokenBudget = computeModelContextBudget({
            capabilities,
            tokenizer,
            system: systemText,
            tools: toolText,
            transcript: 0,
            memory: 0,
            attachments: 0,
        });
        const tokenFitted = selectCompleteMessageGroups(anchored.messages, tokenizer, tokenBudget.availableContentTokens);
        const finalMessages = fitProviderMessagesToByteBudget(tokenFitted, byteBudget);
        const finalBudget = {
            ...tokenBudget,
            used: {
                ...tokenBudget.used,
                ...classifyProviderMessageTokens(finalMessages, tokenizer),
            },
            truncated: anchored.truncated || JSON.stringify(finalMessages) !== JSON.stringify(anchored.messages),
        };
        const withImages = this.attachImageParts(finalMessages, imageAttachments);
        return {
            messages: withImages,
            bytes: Buffer.byteLength(JSON.stringify(withImages), "utf8"),
            availableBytes: byteBudget,
            truncated: anchored.truncated || JSON.stringify(withImages) !== JSON.stringify(anchored.messages),
            modelBudget: finalBudget,
        };
    }
    /**
     * P2.3 — attaches image data-URL parts to the final current-prompt user
     * message so image-capable providers receive the bytes. Images are only
     * present here after the `providerSupportsImages` gate passed; a provider
     * without image support fails earlier with `unsupported_feature`.
     */
    private attachImageParts(
        messages: readonly ProviderChatMessage[],
        imageAttachments: readonly { name: string; dataUrl: string }[],
    ): ProviderChatMessage[] {
        if (imageAttachments.length === 0)
            return [...messages];
        const index = [...messages].reverse().findIndex((message) => message.role === "user");
        if (index === -1)
            return [...messages];
        const target = messages.length - 1 - index;
        const next = [...messages];
        const message = next[target];
        if (message?.role !== "user")
            return [...messages];
        const baseText = typeof message.content === "string" ? message.content : "";
        // Defensive image-byte cap: never append unbounded image data past the
        // context budget. Anything beyond the cap is dropped (the downstream
        // context gate also marker-replaces oversized images).
        const IMAGE_BYTE_CAP = 2 * 1024 * 1024;
        const parts: ProviderUserContentPart[] = baseText.length > 0
            ? [{ type: "text", text: baseText }]
            : [];
        let imageBytes = 0;
        for (const image of imageAttachments) {
            if (imageBytes >= IMAGE_BYTE_CAP)
                break;
            parts.push({ type: "image_url", image_url: { url: image.dataUrl, detail: "auto" } });
            imageBytes += Buffer.byteLength(image.dataUrl, "utf8");
        }
        next[target] = { ...message, content: parts };
        return next;
    }
    /** Traduz eventos do roteador em entries de transcript (shapes do contrato). */
    onStreamEvent(agentId: string, event: ProviderStreamEvent, turn: TurnMetadata, hasToolLoop = false): void {
        if (turn.finalized)
            return;
        const appended: TranscriptEntry[] = [];
        if (event.type === "delta" || event.type === "tool-call" || event.type === "message") {
            this.updateTurnPhase(agentId, turn, "streaming");
            turn.contentStarted = true;
            if (turn.reasoning) turn.reasoning.seenContent = true;
        }
        switch (event.type) {
            case "service-tier": {
                turn.serviceTierActual = [...new Set([...(turn.serviceTierActual ?? []), event.actual])];
                break;
            }
            case "reasoning-start": {
                if (!(turn.modelResolution?.capabilities.reasoning ?? providerSupportsReasoning(turn.provider, turn.model)) || turn.finalized) break;
                if (turn.contentStarted || turn.reasoning?.ended || turn.reasoning?.seenContent) break;
                if (!turn.reasoning) turn.reasoning = { enabled: true, open: false, ended: false, seenContent: false, bytes: 0 };
                const startSummary = this.sanitizeReasoningFragment((event).summary, 256);
                turn.reasoning.open = true;
                turn.reasoning.bytes = Buffer.byteLength(startSummary || "", "utf8");
                this.publishReasoning(agentId, turn, { type: "start", ...(startSummary ? { summary: startSummary } : {}) });
                break;
            }
            case "reasoning-progress": {
                if (!(turn.modelResolution?.capabilities.reasoning ?? providerSupportsReasoning(turn.provider, turn.model)) || turn.finalized) break;
                if (turn.contentStarted || !turn.reasoning?.open || turn.reasoning.ended || turn.reasoning.seenContent) break;
                const fragment = this.sanitizeReasoningFragment((event).summary, 512);
                if (!fragment) break;
                if (turn.reasoning.bytes + Buffer.byteLength(fragment, "utf8") > 4096) break;
                turn.reasoning.bytes += Buffer.byteLength(fragment, "utf8");
                this.publishReasoning(agentId, turn, { type: "progress", summary: fragment });
                break;
            }
            case "reasoning-end": {
                if (!turn.reasoning?.open) break;
                const endSummary = this.sanitizeReasoningFragment((event).summary, 256);
                turn.reasoning.open = false;
                turn.reasoning.ended = true;
                this.publishReasoning(agentId, turn, { type: "end", ...(endSummary ? { summary: endSummary } : {}) });
                break;
            }
            case "tool-call": {
                const { call } = event;
                const id = stableToolCallId(call.id, call.function.name, call.function.arguments);
                this.publishToolCall(agentId, makeToolCallEntry(id, call.function.name, toolCallSummary(call.function.name, call.function.arguments), hasToolLoop ? "pending" : "completed", undefined, toolCallLocalId(turn.turnId, id)), turn.conversationId);
                break;
            }
            case "delta": {
                this.applyDelta(agentId, event.delta, turn);
                break;
            }
            case "discard-round-text": {
                const live = this.liveAssistant.get(agentId);
                if (live === undefined || live.content.length === 0)
                    break;
                live.content = "";
                const entry = this.assistantMessage(agentId, live.id, "", true, turn);
                this.publishStreamSnapshot(agentId, entry, turn.conversationId, live);
                this.replaceWithoutPublish(agentId, entry, turn.conversationId);
                const now = this.nowFn();
                live.lastPublishMs = now;
                live.lastSnapshotSequence = live.sequence;
                break;
            }
            case "message": {
                if (hasToolLoop && (event.message.toolCalls?.length ?? 0) > 0) break;
                const live = this.liveAssistant.get(agentId);
                const text = turn.isResume && live !== undefined
                    ? (live.content.endsWith(event.message.content) ? live.content : `${live.content}${event.message.content}`)
                    : event.message.content;
                if (text.length === 0 && !this.liveAssistant.has(agentId))
                    break;
                this.finalizeAssistant(agentId, text, {}, turn);
                break;
            }
            case "error": {
                const { error } = event;
                this.terminalizeReasoning(agentId, turn, error.kind === "aborted" ? "interrupted" : "error");
                if (error.kind === "aborted") {
                    this.finalizeAssistant(agentId, this.liveAssistant.get(agentId)?.content, { keepPartial: true }, turn);
                    appended.push(retryableTurnNotice(turn, turn.responseLimited ? "response-limit" : "aborted", turn.responseLimited
                        ? "A resposta atingiu o limite seguro de tamanho."
                        : "Geração interrompida."));
                    break;
                }
                this.finalizeAssistant(agentId, this.liveAssistant.get(agentId)?.content, { keepPartial: true }, turn);
                appended.push({
                    kind: "notice",
                    id: `notice:${turn.turnId}:provider-error`,
                    text: providerFailureText(error),
                    level: "error",
                    turnId: turn.turnId,
                    provider: turn.provider,
                    model: turn.model,
                    retryable: error.retryable,
                    providerErrorKind: error.kind,
                    ...(error.code !== undefined ? { providerErrorCode: error.code } : {}),
                    ...(turn.clientNonce !== undefined ? { clientNonce: turn.clientNonce } : {}),
                    ...(turn.retryOfClientNonce !== undefined ? { retryOfClientNonce: turn.retryOfClientNonce } : {}),
                    ...(error.status !== undefined ? { status: error.status } : {}),
                });
                break;
            }
            case "tool-result":
            case "done":
                this.terminalizeReasoning(agentId, turn, "completed");
                break;
            case "resume-cursor":
                turn.resumeCursor = event.cursor;
                this.persistResumeCheckpoint(agentId, turn, turn.conversationId, event.cursor);
                break;
        }
        if (appended.length > 0)
            this.appendAndPublish(agentId, appended, turn.conversationId);
    }
    applyDelta(agentId: string, delta: string, turn: TurnMetadata): void {
        if (!delta || turn.responseLimited)
            return;
        const now = this.nowFn();
        let live = this.liveAssistant.get(agentId);
        const currentBytes = live ? Buffer.byteLength(live.content, "utf8") : 0;
        const accepted = utf8Prefix(delta, MAX_LIVE_RESPONSE_BYTES - currentBytes);
        const limited = accepted.length !== delta.length || currentBytes + Buffer.byteLength(accepted, "utf8") >= MAX_LIVE_RESPONSE_BYTES;
        if (!live) {
            const id = this.newIdFn("assistant");
            const replicaKey = `transcript:${agentId}`;
            const currentOrder = this.transcriptOrderByKey.get(replicaKey);
            const epoch = currentOrder?.epoch ?? randomUUID();
            const sequence = currentOrder?.sequence ?? 0;
            live = {
                id,
                // The initial appended entry is deliberately empty.  Its text is
                // carried exactly once by ordered `transcript.delta` fragments.
                content: "",
                lastPublishMs: now,
                lastPersistMs: now,
                limited,
                replicaKey,
                epoch,
                sequence,
                lastSnapshotSequence: sequence,
            };
            this.liveAssistant.set(agentId, live);
            this.transcriptOrderByKey.set(replicaKey, { epoch, sequence });
            this.appendAndPublish(agentId, [this.assistantMessage(agentId, live.id, "", true, turn)], turn.conversationId);
        }
        if (live.needsBaseline === true) {
            const baselineOrder = this.nextTranscriptOrder(agentId, live.replicaKey);
            live.sequence = baselineOrder.sequence;
            live.needsBaseline = false;
            this.publishFn("transcript", {
                type: "appended",
                agentId,
                ...(turn.conversationId === undefined ? {} : { conversationId: turn.conversationId }),
                entry: this.assistantMessage(agentId, live.id, live.content, true, turn),
                ordered: baselineOrder,
            });
        }
        if (accepted)
            live.content += accepted;
        if (limited && !live.limited)
            live.limited = true;
        if (limited) {
            turn.responseLimited = true;
            turn.streamController?.abort(new Error("response size limit reached"));
        }
        if (!accepted)
            return;
        // Keep one bounded process-local preview for RPC readers.  This is not a
        // SQLite checkpoint and is replaced in place, so it cannot grow without
        // bound or turn each provider fragment into a durable write.
        this.store.setLiveEntry?.(agentId, this.assistantMessage(agentId, live.id, live.content, true, turn), turn.conversationId);
        // Public deltas are cheap append-only transport frames.  Never send the
        // accumulated assistant text once per provider fragment (the old path was
        // O(n²) in both bytes and serialization work).
        for (const fragment of splitTranscriptFragments(accepted)) {
            const order = this.nextTranscriptOrder(agentId, live.replicaKey);
            live.sequence = order.sequence;
            this.publishFn("transcript", {
                type: "delta",
                agentId,
                ...(turn.conversationId === undefined ? {} : { conversationId: turn.conversationId }),
                entryId: live.id,
                fragment,
                ordered: order,
            });
        }
        // Full snapshots remain periodic and bounded.  They are a client repair
        // point, not a second copy of every fragment and not a durable write.
        const shouldPublish = now - live.lastPublishMs >= STREAM_UPDATE_MIN_MS
            && live.sequence - live.lastSnapshotSequence >= STREAM_SNAPSHOT_MIN_FRAGMENTS;
        const shouldPersist = now - live.lastPersistMs >= STREAM_PERSIST_INTERVAL_MS;
        const entry = this.assistantMessage(agentId, live.id, live.content, true, turn);
        if (shouldPublish)
            this.publishStreamSnapshot(agentId, entry, turn.conversationId, live);
        if (shouldPersist)
            this.replaceWithoutPublish(agentId, entry, turn.conversationId);
        if (shouldPublish) {
            live.lastPublishMs = now;
            live.lastSnapshotSequence = live.sequence;
        }
        if (shouldPersist)
            live.lastPersistMs = now;
        if (shouldPublish)
            this.activity?.patch(agentId, {
                isRunning: true,
                lastMessageId: live.id,
                lastMessagePreview: live.content,
                lastEntry: previewFromText(live.content),
            }, false);
    }
    finalizeAssistant(agentId: string, text: string | undefined, opts: { silent?: boolean; keepPartial?: boolean } = {}, turn?: TurnMetadata): void {
        const live = this.liveAssistant.get(agentId);
        const rawContent = (text !== undefined && text.length > 0 ? text : live?.content) ?? "";
        const content = utf8Prefix(rawContent, MAX_LIVE_RESPONSE_BYTES);
        if (live && turn !== undefined)
            turn.finalized = true;
        this.liveAssistant.delete(agentId);
        if (content.length === 0) {
            return;
        }
        const id = live?.id ?? this.newIdFn("assistant");
        const interrupted = opts.keepPartial === true || live?.limited === true || turn?.responseLimited === true;
        const entry = this.assistantMessage(agentId, id, content, false, turn, interrupted ? "interrupted" : undefined);
        if (live)
            this.finalizeStreamSnapshot(agentId, entry, turn?.conversationId, live);
        else
            this.appendAndPublish(agentId, [entry], turn?.conversationId);
        // A resposta textual já foi persistida/publicada como `message` acima.
        // Não a replique em um card `send-message`: o renderer exibe ambos os
        // kinds e isso transformaria uma única resposta em duas bolhas idênticas.
        // `send-message` segue válido para cards não textuais (aprovação,
        // attachment, widget etc.), publicados pelos fluxos que os originam.
        this.activity?.patch(agentId, {
            lastMessageId: id,
            lastMessagePreview: content,
            lastEntry: previewFromText(content),
        }, false);
    }
    assistantMessage(agentId: string, id: string, content: string, streaming: boolean, turn?: TurnMetadata, completionState?: "interrupted"): TranscriptEntry {
        return {
            kind: "message",
            id,
            role: "assistant",
            content,
            timestampMs: this.nowFn(),
            streaming,
            isStreaming: streaming,
            ...(completionState === undefined ? {} : { completionState }),
            ...(turn === undefined ? {} : {
                turnId: turn.turnId,
                provider: turn.provider,
                model: turn.model,
                ...(turn.memoryContextSources?.length ? { memoryContextSources: [...new Map(turn.memoryContextSources.map((source) => [JSON.stringify(source), source])).values()] } : {}),
                reasoningEffort: turn.reasoningEffort ?? "medium",
                ...(turn.modelResolution?.serviceTier ? { serviceTierOutcome: { requested: turn.modelResolution.serviceTier, actual: turn.serviceTierActual ?? ["unknown" as const] } } : {}),
                ...(turn.retryOfClientNonce !== undefined ? { retryOfClientNonce: turn.retryOfClientNonce } : {}),
            }),
        };
    }
    latestAssistantPreview(agentId: string, conversationId?: string): { id: string; content: string } | undefined {
        const live = this.liveAssistant.get(agentId);
        if (live)
            return live;
        const entry = this.store.getLatestAssistant(agentId, conversationId);
        return entry && entry.content.trim()
            ? { id: entry.id, content: entry.content }
            : undefined;
    }
    replaceAndPublish(agentId: string, entry: TranscriptEntry, conversationId?: string): void {
        const normalized = normalizeTranscriptEntry(entry, {
            agentName: this.agentPeer(agentId).name,
            userName: this.humanAuthor().name,
            userAuthId: this.humanAuthor().authId,
        });
        const id = normalized.id;
        if (typeof id === "string" && this.store.replace(agentId, id, normalized, conversationId)) {
            this.store.clearLiveEntry?.(agentId, id, conversationId);
            this.publishFn("transcript", { type: "updated", agentId, ...(conversationId === undefined ? {} : { conversationId }), entry: normalized, ordered: this.nextTranscriptOrder(agentId) });
            return;
        }
        if (typeof id === "string")
            this.store.clearLiveEntry?.(agentId, id, conversationId);
        this.appendAndPublish(agentId, [normalized], conversationId);
    }
    /** Publishes a periodic authoritative-shaped preview without a SQLite write. */
    publishStreamSnapshot(agentId: string, entry: TranscriptEntry, conversationId: string | undefined, live: LiveAssistantState): void {
        const normalized = normalizeTranscriptEntry(entry, {
            agentName: this.agentPeer(agentId).name,
            userName: this.humanAuthor().name,
            userAuthId: this.humanAuthor().authId,
        });
        this.store.setLiveEntry?.(agentId, normalized, conversationId);
        this.publishFn("transcript", {
            type: "updated",
            agentId,
            ...(conversationId === undefined ? {} : { conversationId }),
            entry: normalized,
            ordered: this.nextTranscriptOrder(agentId, live.replicaKey),
            throughSequence: live.sequence,
            final: false,
        });
    }
    /** Commits and publishes one final snapshot; no delta is repeated here. */
    finalizeStreamSnapshot(agentId: string, entry: TranscriptEntry, conversationId: string | undefined, live: LiveAssistantState): void {
        try {
            const normalized = normalizeTranscriptEntry(entry, {
                agentName: this.agentPeer(agentId).name,
                userName: this.humanAuthor().name,
                userAuthId: this.humanAuthor().authId,
            });
            const id = normalized.id;
            if (typeof id !== "string" || !this.store.replace(agentId, id, normalized, conversationId)) {
                this.store.append(agentId, [normalized], conversationId);
            }
            this.store.clearLiveEntry?.(agentId, live.id, conversationId);
            this.publishFn("transcript", {
                type: "updated",
                agentId,
                ...(conversationId === undefined ? {} : { conversationId }),
                entry: normalized,
                ordered: this.nextTranscriptOrder(agentId, live.replicaKey),
                throughSequence: live.sequence,
                final: true,
            });
        }
        finally {
            // The order namespace is per agent lifetime. It must survive a turn so
            // the renderer's `transcript:${agentId}` cursor remains monotonic.
        }
    }
    replaceWithoutPublish(agentId: string, entry: TranscriptEntry, conversationId?: string): void {
        const normalized = normalizeTranscriptEntry(entry, {
            agentName: this.agentPeer(agentId).name,
            userName: this.humanAuthor().name,
            userAuthId: this.humanAuthor().authId,
        });
        const id = normalized.id;
        if (typeof id === "string" && this.store.replace(agentId, id, normalized, conversationId)) {
            this.store.clearLiveEntry?.(agentId, id, conversationId);
            return;
        }
        if (typeof id === "string")
            this.store.clearLiveEntry?.(agentId, id, conversationId);
        this.store.append(agentId, [normalized], conversationId);
    }
    publishUpdate(agentId: string, entry: TranscriptEntry, conversationId?: string): void {
        const normalized = normalizeTranscriptEntry(entry, {
            agentName: this.agentPeer(agentId).name,
            userName: this.humanAuthor().name,
            userAuthId: this.humanAuthor().authId,
        });
        this.store.setLiveEntry?.(agentId, normalized, conversationId);
        this.publishFn("transcript", {
            type: "updated",
            agentId,
            ...(conversationId === undefined ? {} : { conversationId }),
            entry: normalized,
            ordered: this.nextTranscriptOrder(agentId),
        });
    }
    appendAndPublish(agentId: string, entries: readonly TranscriptEntry[], conversationId?: string, consumeStagedAttachments = false): void {
        const normalized = entries.map((entry) => normalizeTranscriptEntry(entry, {
            agentName: this.agentPeer(agentId).name,
            userName: this.humanAuthor().name,
            userAuthId: this.humanAuthor().authId,
        }));
        if (consumeStagedAttachments) this.store.append(agentId, normalized, conversationId, true);
        else this.store.append(agentId, normalized, conversationId);
        for (const entry of normalized) {
            const id = typeof entry.id === "string" ? entry.id : undefined;
            if (id !== undefined)
                this.store.clearLiveEntry?.(agentId, id, conversationId);
            this.publishFn("transcript", { type: "appended", agentId, ...(conversationId === undefined ? {} : { conversationId }), entry, ordered: this.nextTranscriptOrder(agentId) });
        }
    }
    closeOpenToolCalls(agentId: string, result: ToolCallResult, conversationId?: string): void {
        for (const entry of this.store.getOpenToolCalls(agentId, conversationId)) {
            this.publishToolCall(agentId, { ...entry, status: "failed", result }, conversationId);
        }
    }
    publishToolCall(agentId: string, entry: Extract<TranscriptEntry, { kind: "tool-call" }>, conversationId?: string): void {
        const localToolCallId = entry.localToolCallId;
        if (typeof localToolCallId === "string" && localToolCallId.length > 0) {
            const existing = this.store.findToolCallByLocalId !== undefined
                ? this.store.findToolCallByLocalId(agentId, localToolCallId, conversationId)
                : this.store.getEntries(agentId, conversationId).find((candidate) => candidate.kind === "tool-call" &&
                    candidate.localToolCallId === localToolCallId);
            const existingId = existing?.kind === "tool-call" && typeof existing.id === "string" ? existing.id : undefined;
            const replaced = this.store.replaceToolCallByLocalId !== undefined
                ? this.store.replaceToolCallByLocalId(agentId, localToolCallId, entry, conversationId)
                : existingId !== undefined && this.store.replace(agentId, existingId, entry, conversationId);
            if (replaced) {
                this.publishFn("transcript", { type: "updated", agentId, ...(conversationId === undefined ? {} : { conversationId }), entry, ordered: this.nextTranscriptOrder(agentId) });
                if (entry.status === "completed" || entry.status === "failed") {
                    this.publishTranscriptSnapshot(agentId, conversationId);
                }
                return;
            }
            this.appendAndPublish(agentId, [entry], conversationId);
            return;
        }
        const id = typeof entry.id === "string" ? entry.id : "";
        if (id.length > 0 && this.store.replace(agentId, id, entry, conversationId)) {
            this.publishFn("transcript", { type: "updated", agentId, ...(conversationId === undefined ? {} : { conversationId }), entry, ordered: this.nextTranscriptOrder(agentId) });
            if (entry.status === "completed" || entry.status === "failed") {
                this.publishTranscriptSnapshot(agentId, conversationId);
            }
            return;
        }
        this.appendAndPublish(agentId, [entry], conversationId);
    }
    // ── fila exclusiva por agente ───────────────────────────────────────────────
    enqueue(agentId: string, task: () => Promise<void>, onError?: () => void, conversationId?: string): void {
        const prev = this.queues.get(agentId) ?? Promise.resolve();
        const next: Promise<unknown> = prev.then(task, task).catch((err) => {
            // Reporting must never poison the queue tail or leak into another chat.
            onError?.();
            const text = `turno falhou: ${err instanceof Error ? err.message : String(err)}`;
            try {
                this.appendAndPublish(agentId, [{ kind: "notice", text, level: "error" }], conversationId);
            }
            catch {
                // A later queued turn must still execute even if transcript I/O failed.
            }
        });
        this.queues.set(agentId, next);
        void next.finally(() => {
            if (this.queues.get(agentId) === next)
                this.queues.delete(agentId);
        });
    }
    validate(args: SandSendPromptArgs): void {
        if (typeof args.agentId !== "string" || args.agentId.trim().length === 0) {
            throw new RpcError(400, "sendPrompt: agentId é obrigatório (string não vazia)");
        }
        if (typeof args.prompt !== "string" || args.prompt.trim().length === 0) {
            throw new RpcError(400, "sendPrompt: prompt é obrigatório (string não vazia)");
        }
        if (args.conversationId !== undefined && (typeof args.conversationId !== "string" || args.conversationId.trim().length === 0)) {
            throw new RpcError(400, "sendPrompt: conversationId deve ser uma string não vazia");
        }
        if (args.attachments !== undefined) {
            if (!Array.isArray(args.attachments)) {
                throw new RpcError(400, "sendPrompt: attachments deve ser um array");
            }
            if (args.attachments.length > MAX_ATTACHMENTS_PER_TURN) {
                throw new RpcError(400, `sendPrompt: máximo de ${MAX_ATTACHMENTS_PER_TURN} anexos por turno`);
            }
            for (const attachment of args.attachments) {
                if (typeof attachment !== "object" ||
                    attachment === null ||
                    typeof attachment.path !== "string" ||
                    typeof attachment.name !== "string") {
                    throw new RpcError(400, "sendPrompt: cada attachment exige path e name (strings)");
                }
            }
        }
        if (args.clientNonce !== undefined &&
            (typeof args.clientNonce !== "string" || args.clientNonce.trim().length === 0)) {
            throw new RpcError(400, "sendPrompt: clientNonce deve ser uma string não vazia");
        }
        if (args.replyContext !== undefined) {
            const reply = args.replyContext;
            if (typeof reply !== "object" || reply === null)
                throw new RpcError(400, "sendPrompt: replyContext deve ser um objeto");
            if (typeof reply.replyToId !== "string" || reply.replyToId.trim().length === 0) {
                throw new RpcError(400, "sendPrompt: replyContext.replyToId é obrigatório (string não vazia)");
            }
            if (typeof reply.conversationId !== "string" || reply.conversationId.trim().length === 0) {
                throw new RpcError(400, "sendPrompt: replyContext.conversationId é obrigatório (string não vazia)");
            }
        }
    }
}
export function normalizeSendPrompt(body: SandSendPromptArgs | Record<string, unknown>): SandSendPromptArgs {
    const record = body as Record<string, unknown>;
    const agentId = record.agentId ?? record.id;
    const prompt = record.prompt ?? record.text ?? record.trimmedPrompt;
    const attachments = normalizeSendAttachments(record);
    return {
        ...(body as SandSendPromptArgs),
        agentId: typeof agentId === "string" ? agentId : "",
        prompt: typeof prompt === "string" ? prompt : "",
        ...(attachments !== undefined ? { attachments } : {}),
    };
}
function normalizeSendAttachments(record: Record<string, unknown>): SandSendPromptArgs["attachments"] | undefined {
    if (Array.isArray(record.attachments))
        return record.attachments as SandSendPromptArgs["attachments"];
    if (!Array.isArray(record.attachmentPaths))
        return undefined;
    const names = Array.isArray(record.attachmentNames) ? record.attachmentNames : [];
    return record.attachmentPaths.map((path, index) => {
        const resolved = typeof path === "string" ? path : "";
        const name = typeof names[index] === "string" ? names[index] : resolved.split(/[\\/]/).pop() ?? "attachment";
        return { path: resolved, name };
    });
}
// ── integração ao gateway (plano §3 T10: "Registre no gateway via registerHandler") ──
/**
 * Cria um TurnRunner e pluga `POST /api/sendPrompt` no gateway
 * (`gateway.registerHandler` — rota já declarada na RPC_METHOD_TABLE do T3).
 * O publicador SSE do runner é o `ctx.publish` do gateway (mesma função para
 * todas as requisições — sem corrida).
 */
export function registerSendPromptHandler(gateway: Gateway, opts: TurnRunnerOptions = {}): TurnRunner {
    const runner = new TurnRunner(opts);
    const handler: RpcHandler = (body, ctx) => {
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
            throw new RpcError(400, "sendPrompt: corpo deve ser um objeto");
        }
        runner.setPublish(ctx.publish);
        return runner.sendPrompt(normalizeSendPrompt(body as Record<string, unknown>));
    };
    gateway.registerHandler("sendPrompt", handler);
    const cancel = (body: unknown) => {
        const record = (body ?? {}) as Record<string, unknown>;
        const agentId = typeof record.agentId === "string" ? record.agentId
            : typeof record.id === "string" ? record.id
                : undefined;
        return runner.cancelPrompt(agentId && agentId.trim() ? agentId : undefined);
    };
    gateway.registerHandler("cancelPrompt", cancel);
    gateway.registerHandler("abortPrompt", cancel);
    gateway.registerHandler("retryPrompt", (body: unknown) => {
        const record = (body ?? {}) as Record<string, unknown>;
        const agentId = typeof record.agentId === "string" ? record.agentId
            : typeof record.id === "string" ? record.id
                : "";
        const conversationId = typeof record.conversationId === "string" ? record.conversationId : undefined;
        return runner.retryPrompt(agentId, conversationId);
    });
    gateway.registerHandler("resumePrompt", (body: unknown) => {
        const record = (body ?? {}) as Record<string, unknown>;
        const agentId = typeof record.agentId === "string" ? record.agentId
            : typeof record.id === "string" ? record.id
                : "";
        const turnId = typeof record.turnId === "string" ? record.turnId : "";
        const conversationId = typeof record.conversationId === "string" ? record.conversationId : undefined;
        return runner.resumePrompt(agentId, turnId, conversationId);
    });
    gateway.registerHandler("getPromptStatus", (body: unknown) => {
        const record = (body ?? {}) as Record<string, unknown>;
        const agentId = typeof record.agentId === "string" && record.agentId.trim().length > 0
            ? record.agentId
            : undefined;
        return runner.promptStatus(agentId);
    });
    gateway.registerHandler("promptAcceptanceStatus", (body) => {
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
            throw new RpcError(400, "promptAcceptanceStatus: corpo deve ser um objeto");
        }
        const record = body as Record<string, unknown>;
        const nonce = typeof record.clientNonce === "string" ? record.clientNonce : "";
        const inferredAgentId = typeof record.agentId !== "string" && typeof record.id !== "string" && nonce
            ? runner.findAgentIdByNonce(nonce)
            : undefined;
        if (nonce && typeof record.agentId !== "string" && typeof record.id !== "string" && inferredAgentId === undefined) {
            return { outcome: "not-found" };
        }
        const agentId = typeof record.agentId === "string" ? record.agentId
            : typeof record.id === "string" ? record.id
                : inferredAgentId
                    ? inferredAgentId
                    : "";
        if (!nonce)
            throw new RpcError(400, "promptAcceptanceStatus: clientNonce é obrigatório");
        if (!agentId)
            throw new RpcError(400, "promptAcceptanceStatus: agentId e clientNonce são obrigatórios");
        if (record.conversationId !== undefined && (typeof record.conversationId !== "string" || record.conversationId.trim().length === 0)) {
            throw new RpcError(400, "promptAcceptanceStatus: conversationId inválido");
        }
        const conversationId = typeof record.conversationId === "string" ? record.conversationId.trim() : undefined;
        return runner.acceptanceStatus(agentId, nonce, conversationId);
    });
    return runner;
}
/** Factory ergonômica (bootstrap/tests). */
export function createTurnRunner(opts: TurnRunnerOptions = {}): TurnRunner {
    return new TurnRunner(opts);
}
