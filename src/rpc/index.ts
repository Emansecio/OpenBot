/**
 * RPC dispatch (T3+) — mesa MVP: chat / transcript / tools / settings.
 *
 * T10: mesa de chat plugada aqui — `registerSendPromptHandler(gateway, opts)`
 * (src/rpc/send.ts) registra `POST /api/sendPrompt` no gateway (turn runner
 * mínimo: fila exclusiva por agente, dedupe por clientNonce, SSE transcript
 * snapshot/appended). T11+ pluga as mesas de transcript/tools/settings na
 * mesma superfície (`registerRpcHandlers`).
 */

export {
  DEFAULT_LEDGER_CAP,
  DEFAULT_SYSTEM_PROMPT,
  TurnRunner,
  createMemoryTranscriptStore,
  createTurnRunner,
  defaultResolveProvider,
  registerSendPromptHandler,
  type ResolvedProvider,
  type TranscriptStore,
  type TurnRunnerOptions,
} from "./send.js";

import type { Gateway, RpcHandler } from "../server/gateway.js";
import { RpcError } from "../server/gateway.js";
import {
  createMemoryTranscriptStore,
  registerSendPromptHandler,
  type ConversationStoreLike,
  type TranscriptStore,
  type TurnRunner,
  type TurnRunnerOptions,
} from "./send.js";
import { registerRosterHandlers, type BrowserAgentLifecycle } from "./roster.js";
export type { BrowserAgentLifecycle } from "./roster.js";
import type { ConfigStore } from "../config/store.js";
import type { AgentHomeStore } from "../execution/home.js";
import type { AgentRuntimeManager } from "../execution/runtime/contracts.js";
import { registerInteractionHandlers } from "./interactions.js";
import type { Keystore } from "../keystore/index.js";
import { AgentActivityStore, previewFromText } from "./activity.js";
import type { SkillCatalog } from "../skills/catalog.js";
import { registerSkillHandlers, type ResolveSkillPolicy } from "./skills.js";
import { registerMcpHandlers } from "./mcp.js";
import { registerAsyncTaskHandlers } from "./tasks.js";
import { registerP23Handlers } from "./p23.js";
import type { AttachmentStagingStore } from "../attachments/staging.js";
import { registerReactionHandlers } from "./reactions.js";
import type { ReactionStore } from "../reactions/store.js";
import type { AsyncTaskAuthorityResolver } from "./tasks.js";
import type { AsyncTaskRuntime } from "../tasks/runtime.js";
import type { AsyncTaskStore } from "../tasks/store.js";
import type { McpManager } from "../mcp/manager.js";
import type { ConversationPage } from "../conversations/store.js";
import type { HistorySearchResult, Memory, MemoryMode, MemoryStore } from "../memory/types.js";
import { USER_PROFILE_AGENT_ID } from "../memory/types.js";
import { registerA2AHandlers } from "./a2a.js";
import type { A2AStore } from "../a2a/store.js";
import type { A2ARuntime } from "../a2a/runtime.js";
import { defaultRegistry } from "../providers/router.js";
import { AgentLifecycleFence, rpcAgentIds, waitForDeletionDrain } from "./agent-lifecycle.js";

export {
  reconcileRosterHomes,
  type RosterHomeReconciliationResult,
} from "./roster-reconciliation.js";

const TRANSCRIPT_METHODS = ["getAgentTranscriptTail", "openAgentTail"] as const;

type DeletionJournalStore = TranscriptStore & {
  beginAgentDeletion?: (agentIds: readonly string[], startedAtMs?: number) => void;
  completeAgentDeletion?: (agentIds: readonly string[]) => void;
  hasPendingAgentDeletion?: (agentId: string) => boolean;
};

function bodyRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RpcError(400, "transcript: corpo deve ser um objeto");
  }
  return body as Record<string, unknown>;
}

function agentIdFrom(body: unknown): string {
  const record = bodyRecord(body);
  const value = record.agentId ?? record.id;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RpcError(400, "transcript: agentId/id deve ser uma string não vazia");
  }
  return value;
}

function pageArgs(body: unknown): { agentId: string; limit?: number; beforeSeq?: number; conversationId?: string; authoritativeResync?: boolean } {
  const record = bodyRecord(body);
  const agentId = agentIdFrom(body);
  const limit = record.limit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit))) {
    throw new RpcError(400, "transcript: limit deve ser um inteiro");
  }
  if (record.cursor !== undefined) throw new RpcError(400, "transcript: use beforeSeq numérico");
  const beforeSeq = record.beforeSeq;
  if (beforeSeq !== undefined && (typeof beforeSeq !== "number" || !Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) {
    throw new RpcError(400, "transcript: beforeSeq deve ser um inteiro positivo");
  }
  const conversationId = record.conversationId;
  if (conversationId !== undefined && (typeof conversationId !== "string" || conversationId.trim().length === 0)) {
    throw new RpcError(400, "transcript: conversationId deve ser uma string não vazia");
  }
  const authoritativeResync = record.authoritativeResync;
  if (authoritativeResync !== undefined && typeof authoritativeResync !== "boolean") {
    throw new RpcError(400, "transcript: authoritativeResync deve ser booleano");
  }
  if (authoritativeResync === true && beforeSeq !== undefined) {
    throw new RpcError(400, "transcript: authoritativeResync não aceita beforeSeq");
  }
  return {
    agentId,
    ...(limit !== undefined ? { limit } : {}),
    ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(authoritativeResync === true ? { authoritativeResync: true } : {}),
  };
}

function registerTranscriptHandlers(
  gateway: Gateway,
  store: TranscriptStore,
  runner?: TurnRunner,
  activateAgent?: (agentId: string) => void,
): void {
  const pageHandler = (method: typeof TRANSCRIPT_METHODS[number]): RpcHandler => (body) => {
    const args = pageArgs(body);
    try {
      if (args.authoritativeResync === true && method !== "getAgentTranscriptTail") {
        throw new RpcError(400, "transcript: authoritativeResync só é válido para getAgentTranscriptTail");
      }
      if (method === "getAgentTranscriptTail" && args.authoritativeResync === true) runner?.rotateTranscriptEpoch(args.agentId);
      const page = method === "getAgentTranscriptTail"
        ? store.getAgentTranscriptTail(args.agentId, args.limit, args.beforeSeq, args.conversationId)
        : store.openAgentTail(args.agentId, args.limit, args.beforeSeq, args.conversationId);
      // A desktop open must acknowledge the host selection before it settles.
      // Background reads and older-page loads must never switch the active chat.
      if (method === "openAgentTail" && args.beforeSeq === undefined) activateAgent?.(args.agentId);
      return page;
    } catch (error) {
      throw new RpcError(400, error instanceof Error ? error.message : "transcript: argumentos inválidos");
    }
  };

  for (const method of TRANSCRIPT_METHODS) gateway.registerHandler(method, pageHandler(method));

  gateway.registerHandler("getConversationOutline", (body) => {
    try {
      const record = bodyRecord(body);
      const conversationId = record.conversationId;
      if (conversationId !== undefined && (typeof conversationId !== "string" || conversationId.trim().length === 0)) {
        throw new RpcError(400, "transcript: conversationId deve ser uma string não vazia");
      }
      return [store.getConversationOutline(agentIdFrom(body), conversationId)];
    } catch (error) {
      throw new RpcError(400, error instanceof Error ? error.message : "transcript: argumentos inválidos");
    }
  });
}

function conversationRecord(body: unknown, method: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RpcError(400, `${method}: corpo deve ser um objeto`);
  }
  return body as Record<string, unknown>;
}

function requiredConversationAgentId(body: unknown, method: string): string {
  const record = conversationRecord(body, method);
  const value = record.agentId ?? record.id;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RpcError(400, `${method}: agentId é obrigatório`);
  }
  return value.trim();
}

function requiredConversationId(body: unknown, method: string): string {
  const record = conversationRecord(body, method);
  const value = record.conversationId;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RpcError(400, `${method}: conversationId é obrigatório`);
  }
  return value.trim();
}

function conversationPage(store: ConversationStoreLike, agentId: string): ConversationPage {
  return store.list(agentId);
}

function mapConversationError(method: string, error: unknown): never {
  if (error instanceof RpcError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const status = /não encontrada|não encontrado|ownership|agente/iu.test(message) ? 404
    : /arquivada|única|última|ativa/iu.test(message) ? 409
      : 400;
  throw new RpcError(status, `${method}: ${message}`);
}

function registerConversationHandlers(
  gateway: Gateway,
  store: ConversationStoreLike,
  runner: ReturnType<typeof registerSendPromptHandler>,
  config?: ConfigStore,
  onConversationArchived?: (agentId: string, conversationId: string) => void,
  onConversationDeleted?: (agentId: string, conversationId: string) => void,
): void {
  const bindPublisher = (ctx: { publish: (channel: string, payload: unknown) => void }): void => {
    runner.setPublish(ctx.publish);
  };
  const assertAgent = (agentId: string, method: string): void => {
    if (config && !config.snapshot().agents.some((agent) => agent.id === agentId)) {
      throw new RpcError(404, `${method}: agente não encontrado`);
    }
  };
  const guardIdle = (agentId: string, method: string): void => {
    if (runner.promptStatus(agentId).isBusy) throw new RpcError(409, `${method}: agente está ocupado`);
  };
  const publishActive = (agentId: string): void => {
    const active = store.getActive(agentId);
    runner.publishConversationSnapshot(agentId, active?.id);
  };

  gateway.registerHandler("listConversations", (body) => {
    const method = "listConversations";
    const agentId = requiredConversationAgentId(body, method);
    assertAgent(agentId, method);
    const record = conversationRecord(body, method);
    const limit = record.limit;
    if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)) {
      throw new RpcError(400, `${method}: limit inválido`);
    }
    const cursor = record.cursor;
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0)) {
      throw new RpcError(400, `${method}: cursor inválido`);
    }
    try {
      return store.list(agentId, { ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) });
    } catch (error) {
      return mapConversationError(method, error);
    }
  });

  gateway.registerHandler("getActiveConversation", (body) => {
    const method = "getActiveConversation";
    const agentId = requiredConversationAgentId(body, method);
    assertAgent(agentId, method);
    try {
      return store.getActive(agentId) ?? store.ensureDefault(agentId);
    } catch (error) {
      return mapConversationError(method, error);
    }
  });

  gateway.registerHandler("createConversation", (body, ctx) => {
    const method = "createConversation";
    bindPublisher(ctx);
    const record = conversationRecord(body, method);
    const agentId = requiredConversationAgentId(body, method);
    assertAgent(agentId, method);
    guardIdle(agentId, method);
    if (record.title !== undefined && (typeof record.title !== "string" || record.title.trim().length === 0)) {
      throw new RpcError(400, `${method}: title inválido`);
    }
    if (record.temporary !== undefined && typeof record.temporary !== "boolean") {
      throw new RpcError(400, `${method}: temporary deve ser boolean`);
    }
    try {
      const conversation = store.create
        ? store.create(agentId, {
          ...(record.title === undefined ? {} : { title: record.title.trim() }),
          ...(record.temporary === undefined ? {} : { temporary: record.temporary }),
        })
        : (() => { throw new Error("conversation store não suporta create"); })();
      const page = conversationPage(store, agentId);
      // The renderer can update the newly created chat immediately; the
      // conversation id keeps this empty snapshot from being mistaken for a
      // different chat by legacy agent-only consumers.
      runner.publishConversationSnapshot(agentId, conversation.id);
      return { conversation, page };
    } catch (error) {
      return mapConversationError(method, error);
    }
  });

  gateway.registerHandler("activateConversation", (body, ctx) => {
    const method = "activateConversation";
    bindPublisher(ctx);
    const agentId = requiredConversationAgentId(body, method);
    const conversationId = requiredConversationId(body, method);
    assertAgent(agentId, method);
    try {
      const conversation = store.activate
        ? store.activate(agentId, conversationId)
        : (() => { throw new Error("conversation store não suporta activate"); })();
      const page = conversationPage(store, agentId);
      runner.publishConversationSnapshot(agentId, conversation.id);
      return { conversation, page };
    } catch (error) {
      return mapConversationError(method, error);
    }
  });

  gateway.registerHandler("renameConversation", (body, ctx) => {
    const method = "renameConversation";
    bindPublisher(ctx);
    const agentId = requiredConversationAgentId(body, method);
    const conversationId = requiredConversationId(body, method);
    const record = conversationRecord(body, method);
    if (typeof record.title !== "string" || record.title.trim().length === 0) throw new RpcError(400, `${method}: title inválido`);
    assertAgent(agentId, method);
    guardIdle(agentId, method);
    try {
      return store.rename
        ? store.rename(agentId, conversationId, record.title)
        : (() => { throw new Error("conversation store não suporta rename"); })();
    } catch (error) {
      return mapConversationError(method, error);
    }
  });

  gateway.registerHandler("archiveConversation", (body, ctx) => {
    const method = "archiveConversation";
    bindPublisher(ctx);
    const agentId = requiredConversationAgentId(body, method);
    const conversationId = requiredConversationId(body, method);
    assertAgent(agentId, method);
    guardIdle(agentId, method);
    try {
      const conversation = store.archive
        ? store.archive(agentId, conversationId)
        : (() => { throw new Error("conversation store não suporta archive"); })();
      onConversationArchived?.(agentId, conversationId);
      const page = conversationPage(store, agentId);
      publishActive(agentId);
      return { conversation, page };
    } catch (error) {
      return mapConversationError(method, error);
    }
  });

  gateway.registerHandler("deleteConversation", (body, ctx) => {
    const method = "deleteConversation";
    bindPublisher(ctx);
    const agentId = requiredConversationAgentId(body, method);
    const conversationId = requiredConversationId(body, method);
    const record = conversationRecord(body, method);
    const memoryPolicy = record.memoryPolicy === undefined ? "delete-derived" : record.memoryPolicy;
    if (memoryPolicy !== "delete-derived" && memoryPolicy !== "retain") throw new RpcError(400, `${method}: memoryPolicy inválido`);
    assertAgent(agentId, method);
    guardIdle(agentId, method);
    try {
      const result = store.delete
        ? store.delete(agentId, conversationId, { memoryPolicy })
        : (() => { throw new Error("conversation store não suporta delete"); })();
      onConversationDeleted?.(agentId, conversationId);
      const page = conversationPage(store, agentId);
      const conversation = store.getActive(agentId);
      runner.publishConversationSnapshot(agentId, conversation?.id);
      return { ...result, conversation, page };
    } catch (error) {
      return mapConversationError(method, error);
    }
  });
}

function memoryStoreFrom(store: TranscriptStore): MemoryStore | undefined {
  return (store as TranscriptStore & { memoryStore?: MemoryStore }).memoryStore;
}

function registerMemoryHandlers(gateway: Gateway, store: TranscriptStore, config?: ConfigStore): void {
  const memoryStore = memoryStoreFrom(store);
  if (memoryStore === undefined) return;
  const assertMemoryAgent = (agentId: string, method: string): void => {
    if (config && !config.snapshot().agents.some((agent) => agent.id === agentId)) {
      throw new RpcError(404, `${method}: agente não encontrado`);
    }
  };
  const requireMemoryAgentId = (body: unknown, method: string): string => {
    const agentId = requiredConversationAgentId(body, method);
    assertMemoryAgent(agentId, method);
    return agentId;
  };
  const memoryTargetAgentId = (body: unknown, method: string): string => {
    const record = conversationRecord(body, method);
    const agentId = requireMemoryAgentId(body, method);
    if (record.scope === undefined) return agentId;
    if (record.scope === "user") return USER_PROFILE_AGENT_ID;
    if (record.scope === "agent") return agentId;
    throw new RpcError(400, `${method}: scope inválido`);
  };
  const requireMemoryId = (body: unknown, method: string): string => {
    const record = conversationRecord(body, method);
    const value = record.memoryId;
    if (typeof value !== "string" || value.trim().length === 0) throw new RpcError(400, `${method}: memoryId é obrigatório`);
    return value.trim();
  };
  const optionalConversationId = (agentId: string, body: unknown, method: string): string | undefined => {
    const record = conversationRecord(body, method);
    if (record.conversationId === undefined) return undefined;
    if (typeof record.conversationId !== "string" || record.conversationId.trim().length === 0) {
      throw new RpcError(400, `${method}: conversationId inválido`);
    }
    const conversationId = record.conversationId.trim();
    try {
      store.validateConversation?.(agentId, conversationId);
    } catch (error) {
      throw new RpcError(404, `${method}: ${error instanceof Error ? error.message : "conversation inválida"}`);
    }
    return conversationId;
  };
  const parseMode = (value: unknown, method: string): MemoryMode => {
    if (value !== "automatic" && value !== "explicit" && value !== "off") throw new RpcError(400, `${method}: mode inválido`);
    return value;
  };
  const memoryUiItem = (memory: Memory) => ({
    id: memory.id,
    scope: memory.agentId === USER_PROFILE_AGENT_ID ? "user" : "agent",
    kind: memory.kind,
    text: memory.text,
    trust: memory.trust,
    status: memory.status,
    importance: memory.importance,
    confidence: memory.confidence,
    pinned: memory.pinned,
    sourceConversationId: memory.sourceConversationId,
    validFromMs: memory.validFromMs,
    validToMs: memory.validToMs,
    expiresAtMs: memory.expiresAtMs,
    createdAtMs: memory.createdAtMs,
    updatedAtMs: memory.updatedAtMs,
  });
  const historyUiItem = (result: HistorySearchResult) => ({
    kind: result.kind,
    snippet: result.snippet,
    score: result.score,
    agentId: result.agentId,
    conversationId: result.conversationId,
    sequenceId: result.sequenceId,
    provenance: {
      source: result.provenance.source,
      ...(result.provenance.memoryId === undefined ? {} : { memoryId: result.provenance.memoryId }),
    },
    ...(result.memory === undefined ? {} : { memory: memoryUiItem(result.memory) }),
    ...(result.summary === undefined ? {} : {
      summary: {
        conversationId: result.summary.conversationId,
        revision: result.summary.revision,
        throughSequenceId: result.summary.throughSequenceId,
        updatedAtMs: result.summary.updatedAtMs,
      },
    }),
  });

  gateway.registerHandler("getMemorySettings", (body) => {
    const method = "getMemorySettings";
    return memoryStore.getSettings(requireMemoryAgentId(body, method));
  });

  gateway.registerHandler("setMemorySettings", (body) => {
    const method = "setMemorySettings";
    const record = conversationRecord(body, method);
    return memoryStore.setSettings(requireMemoryAgentId(body, method), parseMode(record.mode, method));
  });

  gateway.registerHandler("listMemories", (body) => {
    const method = "listMemories";
    const record = conversationRecord(body, method);
    const limit = record.limit === undefined ? 100 : record.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) {
      throw new RpcError(400, `${method}: limit inválido`);
    }
    if (record.includeInactive !== undefined && typeof record.includeInactive !== "boolean") {
      throw new RpcError(400, `${method}: includeInactive deve ser boolean`);
    }
    return memoryStore.listMemories(memoryTargetAgentId(body, method), {
      limit: limit as number,
      includeInactive: record.includeInactive === true,
    }).map(memoryUiItem);
  });

  gateway.registerHandler("listMemoriesPage", (body) => {
    const method = "listMemoriesPage";
    const record = conversationRecord(body, method);
    const limit = record.limit === undefined ? 50 : record.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) {
      throw new RpcError(400, `${method}: limit inválido`);
    }
    if (record.includeInactive !== undefined && typeof record.includeInactive !== "boolean") {
      throw new RpcError(400, `${method}: includeInactive deve ser boolean`);
    }
    if (record.cursor !== undefined && (typeof record.cursor !== "string" || record.cursor.length === 0 || record.cursor.length > 4_096)) {
      throw new RpcError(400, `${method}: cursor inválido`);
    }
    if (record.query !== undefined && (typeof record.query !== "string" || Buffer.byteLength(record.query, "utf8") > 512)) {
      throw new RpcError(400, `${method}: query inválida`);
    }
    const page = memoryStore.listMemoriesPage(memoryTargetAgentId(body, method), {
      limit: limit as number,
      includeInactive: record.includeInactive === true,
      ...(typeof record.cursor === "string" ? { cursor: record.cursor } : {}),
      ...(typeof record.query === "string" ? { query: record.query } : {}),
    });
    return {
      items: page.items.map(memoryUiItem),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  });

  gateway.registerHandler("updateMemory", (body) => {
    const method = "updateMemory";
    const target = memoryTargetAgentId(body, method);
    const memoryId = requireMemoryId(body, method);
    const record = conversationRecord(body, method);
    const current = memoryStore.getMemory(target, memoryId);
    if (current === null) throw new RpcError(404, `${method}: memória não encontrada`);
    if (current.status !== "active") throw new RpcError(409, `${method}: apenas memórias ativas podem ser editadas`);
    if (record.text !== undefined && (typeof record.text !== "string" || record.text.trim().length === 0)) {
      throw new RpcError(400, `${method}: text inválido`);
    }
    if (record.pinned !== undefined && typeof record.pinned !== "boolean") {
      throw new RpcError(400, `${method}: pinned deve ser boolean`);
    }
    if (record.importance !== undefined && (!Number.isInteger(record.importance) || (record.importance as number) < 0 || (record.importance as number) > 100)) {
      throw new RpcError(400, `${method}: importance inválida`);
    }
    return memoryUiItem(memoryStore.upsertMemory(target, {
      id: current.id,
      kind: current.kind,
      canonicalKey: current.canonicalKey,
      text: typeof record.text === "string" ? record.text.trim() : current.text,
      valueJson: current.valueJson,
      trust: "user",
      pinned: typeof record.pinned === "boolean" ? record.pinned : current.pinned,
      importance: typeof record.importance === "number" ? record.importance : current.importance,
      confidence: current.confidence,
      sourceConversationId: current.sourceConversationId,
      sourceEntryIds: current.sourceEntryIds,
      validFromMs: current.validFromMs,
      validToMs: current.validToMs,
      expiresAtMs: current.expiresAtMs,
    }, { kind: "user", expectedRevision: current.revision }));
  });

  gateway.registerHandler("deleteMemory", (body) => {
    const method = "deleteMemory";
    return memoryUiItem(memoryStore.forgetMemory(memoryTargetAgentId(body, method), requireMemoryId(body, method), { kind: "user" }, "user-delete"));
  });

  gateway.registerHandler("getMemoryStatus", (body) => {
    const method = "getMemoryStatus";
    const agentId = requireMemoryAgentId(body, method);
    const conversationId = optionalConversationId(agentId, body, method);
    const counts = memoryStore.getStatusCounts(agentId);
    const settings = memoryStore.getSettings(agentId);
    const summary = conversationId === undefined ? null : memoryStore.getSummary(agentId, conversationId);
    return {
      agentId,
      settings,
      conversationId: conversationId ?? null,
      summary: summary === null ? null : {
        conversationId: summary.conversationId,
        throughSequenceId: summary.throughSequenceId,
        revision: summary.revision,
        updatedAtMs: summary.updatedAtMs,
        renderedTextBytes: Buffer.byteLength(summary.renderedText, "utf8"),
      },
      counts: {
        active: counts.active,
        pinned: counts.pinned,
        inactive: counts.inactive,
        jobs: {
          pending: counts.jobs.pending,
          running: counts.jobs.running,
          retry: counts.jobs.retry,
          dead: counts.jobs.dead,
        },
      },
      jobs: {
        pending: counts.jobs.pending,
        running: counts.jobs.running,
        retry: counts.jobs.retry,
        dead: counts.jobs.deadSample,
        deadCount: counts.jobs.dead,
      },
    };
  });

  gateway.registerHandler("searchMemoryHistory", (body) => {
    const method = "searchMemoryHistory";
    const agentId = requireMemoryAgentId(body, method);
    const record = conversationRecord(body, method);
    const query = typeof record.query === "string" ? record.query.trim() : "";
    if (query.length === 0) throw new RpcError(400, `${method}: query é obrigatória`);
    const limit = record.limit === undefined ? 10 : record.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 20) {
      throw new RpcError(400, `${method}: limit inválido`);
    }
    const conversationId = optionalConversationId(agentId, body, method);
    return memoryStore.searchHistory(agentId, query, {
      limit: limit as number,
      ...(conversationId === undefined ? {} : { conversationId }),
    }).map(historyUiItem);
  });
}

/**
 * Mesa RPC da Onda 2 (T10 agora; T11+ estende). Plugada no bootstrap
 * (src/main.ts) — cada mesa registra seus métodos via `gateway.registerHandler`
 * (tabela de rota explícita do T3).
 */
export function registerRpcHandlers(
  gateway: Gateway,
  opts: TurnRunnerOptions & {
    onConversationArchived?: (agentId: string, conversationId: string) => void;
    onConversationDeleted?: (agentId: string, conversationId: string) => void;
    store?: TranscriptStore;
    conversationStore?: ConversationStoreLike;
    config?: ConfigStore;
    keystore?: Keystore;
    runtimeManager?: AgentRuntimeManager;
    homes?: AgentHomeStore;
    /** Shared browser lifecycle seam; teardown runs before home/config deletion. */
    browserLifecycle?: BrowserAgentLifecycle;
    homeLifecycleFence?: <T>(agentId: string, operation: () => Promise<T>) => Promise<T>;
    /** Shared local Skills catalog projected into the native composer. */
    skillCatalog?: SkillCatalog;
    /** Optional per-agent narrowing policy for Skills. */
    resolveSkillPolicy?: ResolveSkillPolicy;
    /** One lazy MCP manager shared by every bot and narrowed by policy. */
    mcpManager?: McpManager;
    /** Cleanup for caches that is safe only after deleteAgents commits. */
    onDeleteAgentsCommitted?: (agentIds: readonly string[]) => void;
    /** Clears bootstrap's per-agent pending-home fence after committed recovery. */
    onAgentHomeReady?: (agentId: string) => void;
    asyncTaskStore?: AsyncTaskStore;
    asyncTaskRuntime?: AsyncTaskRuntime;
    resolveAsyncTaskAuthority?: AsyncTaskAuthorityResolver;
    a2aStore?: A2AStore;
    a2aRuntime?: A2ARuntime;
    attachmentStaging?: AttachmentStagingStore;
    reactionStore?: ReactionStore;
    /** Publisher for the ordered `reactions` SSE projection. */
    publishReaction?: (agentId: string, event: { reaction: unknown; reason: string }) => { accepted: boolean };
    assertManagedDiskBudget?: (extraBytes?: number) => Promise<void>;
  } = {},
): { runner: ReturnType<typeof registerSendPromptHandler>; store: TranscriptStore } {
  const store = opts.store ?? createMemoryTranscriptStore();
  const activity = opts.activity ?? new AgentActivityStore();
  for (const agent of opts.config?.snapshot().agents ?? []) {
    const latest = store.getLatestAssistant(agent.id);
    if (latest?.content.trim()) {
      activity.patch(agent.id, {
        lastMessageId: latest.id,
        lastMessagePreview: latest.content,
        lastEntry: previewFromText(latest.content),
      }, false);
    }
  }
  const conversationStore = opts.conversationStore ?? store.conversationStore;
  const kickstartReadiness = opts.resolveKickstartReadiness ?? (async (agentId, inference) => {
    const registry = opts.registry ?? defaultRegistry;
    if (registry.get(inference.provider) === undefined) throw new Error("provider não registrado");
    const agent = opts.config?.snapshot().agents.find((entry) => entry.id === agentId);
    if (agent === undefined) throw new Error("agente não encontrado");
    if (opts.homes === undefined) throw new Error("home readiness indisponível");
    await opts.homes.inventory(agentId);
    if (opts.runtimeManager === undefined) throw new Error("runtime readiness indisponível");
    const runtime = await opts.runtimeManager.status(agentId, agent.runtimeMode ?? "developer");
    if (!["lite-ready", "ready", "busy"].includes(runtime.state)) throw new Error(`runtime não está pronto (${runtime.state})`);
    if (inference.provider !== "openai-compat") {
      if (opts.keystore === undefined || await opts.keystore.reveal(inference.provider) === null) throw new Error("credential indisponível");
    }
  });
  const lifecycleFence = new AgentLifecycleFence();
  const deletionJournal = store as DeletionJournalStore;
  const runner = registerSendPromptHandler(gateway, { ...opts, store, activity, conversationStore, resolveKickstartReadiness: kickstartReadiness });
  const homeLifecycleFence = opts.homeLifecycleFence ?? (async <T>(agentId: string, operation: () => Promise<T>): Promise<T> => {
    runner.fenceAgents([agentId]);
    let releaseAsyncFence: (() => void) | undefined;
    let releaseRuntimeFence: (() => void) | undefined;
    let releaseBrokerFence: (() => void) | undefined;
    try {
      releaseAsyncFence = opts.asyncTaskRuntime?.fenceAgent(agentId);
      releaseRuntimeFence = opts.runtimeManager?.fenceAgentMaintenance?.(agentId);
      releaseBrokerFence = opts.executionBroker?.fenceAgent(agentId);
      await Promise.all([
        opts.asyncTaskRuntime?.drainAgent(agentId),
        opts.executionBroker?.drainAgent(agentId, 5_000),
      ]);
      await runner.flush(agentId);
      // Workspace lifecycle operations must not leave a tab, profile lock, or
      // browser lease pointing at the home while it is restored/imported/
      // repaired/exported. The public lifecycle seam also makes this ordering
      // testable without coupling RPC to browser internals.
      await opts.browserLifecycle?.teardownAgent(agentId);
      // Home import/repair/restore/export must not race a live runtime process
      // that still has the workspace as its cwd or open file set.
      await opts.runtimeManager?.stop(agentId, "manual");
      return await operation();
    } finally {
      runner.releaseAgentFence([agentId]);
      releaseBrokerFence?.();
      releaseRuntimeFence?.();
      releaseAsyncFence?.();
    }
  });
  const deletionAsyncFences = new Map<string, () => void>();
  const deletionBrokerFences = new Map<string, () => void>();
  const deletionDrains = new Map<string, Promise<void>>();
  const deletionReleaseScheduled = new Set<Promise<void>>();
  const releaseDeletion = (agentIds: readonly string[]): void => {
    runner.releaseAgentFence(agentIds);
    for (const agentId of agentIds) {
      deletionAsyncFences.get(agentId)?.();
      deletionAsyncFences.delete(agentId);
      deletionBrokerFences.get(agentId)?.();
      deletionBrokerFences.delete(agentId);
      deletionDrains.delete(agentId);
      opts.asyncTaskStore?.clearAgentFence(agentId);
      opts.a2aStore?.clearAgentFence(agentId);
    }
    const roster = new Set(opts.config!.snapshot().agents.map((agent) => agent.id.toLowerCase()));
    const rolledBack = agentIds.filter((agentId) => roster.has(agentId.toLowerCase()));
    if (rolledBack.length > 0) deletionJournal.completeAgentDeletion?.(rolledBack);
    lifecycleFence.endDeletion(agentIds);
  };
  registerMemoryHandlers(gateway, store, opts.config);
  if (conversationStore) registerConversationHandlers(
    gateway,
    conversationStore,
    runner,
    opts.config,
    opts.onConversationArchived,
    opts.onConversationDeleted,
  );
  registerSkillHandlers(gateway, {
    catalog: opts.skillCatalog,
    resolveSkillPolicy: opts.resolveSkillPolicy,
  });
  registerMcpHandlers(gateway, {
    mcpManager: opts.mcpManager,
    config: opts.config,
    keystore: opts.keystore,
  });
  let activateAgent: ((agentId: string) => void) | undefined;
  if (opts.config) {
    const roster = registerRosterHandlers(
      gateway,
      opts.config,
      opts.homes,
      opts.keystore,
      activity,
      opts.registry,
      store,
      async (agentIds) => {
        await waitForDeletionDrain(Promise.all(agentIds.map((agentId) => {
          const drain = deletionDrains.get(agentId);
          if (!drain) throw new RpcError(503, "Encerramento do bot não foi iniciado com segurança.");
          return drain;
        })).then(() => undefined));
      },
      async (agentIds) => {
        if (opts.browserLifecycle) {
          for (const agentId of agentIds) {
            try {
              await opts.browserLifecycle.teardownAgent(agentId);
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              throw new RpcError(503, `deleteAgents: browser teardown failed for ${agentId}: ${detail}`);
            }
          }
        }
      },
      async (agentIds) => {
        if (agentIds.some((agentId) => deletionDrains.has(agentId))) {
          throw new RpcError(409, "O encerramento anterior ainda está pendente. O bot não foi excluído.");
        }
        deletionJournal.beginAgentDeletion?.(agentIds);
        const admittedDrain = lifecycleFence.beginDeletion(agentIds);
        runner.fenceAgents(agentIds);
        for (const agentId of agentIds) {
          const release = opts.asyncTaskRuntime?.fenceAgent(agentId);
          if (release !== undefined) deletionAsyncFences.set(agentId, release);
          const releaseBroker = opts.executionBroker?.fenceAgent(agentId);
          if (releaseBroker !== undefined) deletionBrokerFences.set(agentId, releaseBroker);
          opts.asyncTaskStore?.fenceAgent(agentId);
          opts.a2aStore?.fenceAgent(agentId);
          opts.asyncTaskStore?.terminalizeAgentTasks(agentId);
        }
        for (const agentId of agentIds) runner.cancelPrompt(agentId);
        const drain = (async () => {
          const results = await Promise.allSettled([
            admittedDrain,
            ...agentIds.map((agentId) => runner.flush(agentId)),
            ...agentIds.map((agentId) => opts.asyncTaskRuntime?.drainAgent(agentId)),
            ...agentIds.map((agentId) => opts.executionBroker?.drainAgent(agentId, 5_000)),
            ...agentIds.map((agentId) => opts.runtimeManager?.stop(agentId, "agent-delete")),
          ]);
          const failed = results.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        })();
        for (const agentId of agentIds) deletionDrains.set(agentId, drain);
        // A failed drain is deliberately retained: no proof that late writers stopped.
        void drain.catch(() => undefined);
      },
      (agentIds) => {
        const drains = [...new Set(agentIds.map((agentId) => deletionDrains.get(agentId)).filter((drain) => drain !== undefined))];
        if (drains.length === 0) return releaseDeletion(agentIds);
        // A retry while the previous drain is pending must not schedule a second release.
        if (drains.some((drain) => deletionReleaseScheduled.has(drain))) return;
        for (const drain of drains) deletionReleaseScheduled.add(drain);
        void Promise.all(drains).then(() => releaseDeletion(agentIds)).catch(() => undefined)
          .finally(() => { for (const drain of drains) deletionReleaseScheduled.delete(drain); });
      },
      async (agentIds) => {
        const cleanupFailures: unknown[] = [];
        try {
          runner.cleanupDeletedAgents(agentIds);
        } catch (error) {
          cleanupFailures.push(error);
        }
        for (const agentId of agentIds) {
          for (const cleanup of [
            () => opts.asyncTaskStore?.purgeAgentTasks(agentId),
            () => opts.a2aStore?.retireAgent(agentId),
            () => opts.a2aStore?.clearAgentFence(agentId),
            () => opts.reactionStore?.purgeAgent(agentId),
          ]) {
            try {
              cleanup();
            } catch (error) {
              cleanupFailures.push(error);
            }
          }
        }
        const settleCleanup = async (operations: readonly Promise<unknown>[]): Promise<void> => {
          const results = await Promise.allSettled(operations);
          for (const result of results) {
            if (result.status === "rejected") cleanupFailures.push(result.reason);
          }
        };
        await settleCleanup(agentIds.map((agentId) => Promise.resolve().then(() => opts.attachmentStaging?.purgeAgent(agentId))));
        await settleCleanup(agentIds.map((agentId) => Promise.resolve().then(() => opts.keystore?.purgeScope(agentId))));
        await settleCleanup(agentIds.map((agentId) => Promise.resolve().then(() => opts.browserLifecycle?.purgeAgent(agentId))));
        try {
          opts.onDeleteAgentsCommitted?.(agentIds);
        } catch (error) {
          cleanupFailures.push(error);
        }
        if (cleanupFailures.length > 0) {
          throw cleanupFailures.length === 1
            ? cleanupFailures[0]
            : new AggregateError(cleanupFailures, "deleteAgents: falhas na limpeza pós-commit");
        }
        deletionJournal.completeAgentDeletion?.(agentIds);
      },
      opts.runtimeManager,
      homeLifecycleFence,
      conversationStore,
      opts.onAgentHomeReady,
      (args) => runner.kickstartAgent(args),
      (agentId) => deletionJournal.hasPendingAgentDeletion?.(agentId) ?? false,
      opts.assertManagedDiskBudget,
    );
    activateAgent = roster.activateAgent;
  }
  registerTranscriptHandlers(gateway, store, runner, activateAgent);
  if (opts.a2aStore) registerA2AHandlers(gateway, {
    store: opts.a2aStore,
    activeAgents: opts.config ? () => opts.config!.snapshot().agents.map((agent) => agent.id) : undefined,
    wake: () => opts.a2aRuntime?.wake(),
  });
  if (opts.asyncTaskStore && opts.config) {
    registerAsyncTaskHandlers(gateway, {
      store: opts.asyncTaskStore,
      config: opts.config,
      wake: () => opts.asyncTaskRuntime?.wake(),
      resolveAuthority: opts.resolveAsyncTaskAuthority,
    });
  }
  if (opts.keystore && "getInteractionDecision" in store) {
    registerInteractionHandlers(gateway, store as never, opts.keystore, opts.executionBroker);
  }
  const memoryForP23 = memoryStoreFrom(store);
  registerP23Handlers(gateway, {
    staging: opts.attachmentStaging,
    ...(memoryForP23 === undefined ? {} : { memory: memoryForP23 }),
    config: opts.config,
  });
  if (opts.reactionStore) {
    registerReactionHandlers(gateway, {
      store: opts.reactionStore,
      config: opts.config,
      publish: opts.publishReaction,
    });
  }

  // Apply one process-wide lifecycle admission fence after every first-party
  // table has registered. Direct test calls through listHandlers receive the
  // same guard as HTTP dispatch. deleteAgents owns begin/drain/end itself.
  for (const [method, handler] of [...gateway.listHandlers()]) {
    if (method === "deleteAgents") continue;
    gateway.registerHandler(method, (body, context) => {
      const agentIds = rpcAgentIds(method, body);
      const invoke = () => handler(body, context);
      return method === "createAgent"
        ? lifecycleFence.runWhenAvailable(agentIds, invoke)
        : lifecycleFence.run(agentIds, invoke);
    });
  }
  return { runner, store };
}
