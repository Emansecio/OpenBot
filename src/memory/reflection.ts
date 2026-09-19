import { validateReflectionCandidates, MEMORY_POLICY_LIMITS, type PolicyRejection } from "./policy.js";
import { isExplicitMemoryIntent, type ReflectionExistingMemory, type ReflectionPreviousSummary } from "./context.js";
import { ProviderError } from "../providers/router.js";
import { ProviderAdmissionError } from "../providers/admission.js";
import type {
  ConversationSummaryInput,
  Memory,
  MemoryJob,
  MemoryMutationAuthority,
  MemoryStore,
  MemoryUpsertInput,
  MemoryScope,
} from "./types.js";
import { USER_PROFILE_AGENT_ID, USER_PROFILE_KINDS } from "./types.js";

export interface MemoryReflectionInput {
  agentId: string;
  conversationId: string;
  provider: string;
  model: string;
  reasoningEffort?: import("../shared/contracts.js").ReasoningEffort;
  modelResolution?: import("../providers/model-catalog.js").ModelResolution;
  fromSequenceId: number;
  throughSequenceId: number;
  summaryRequested?: boolean;
  memoryRequested?: boolean;
  previousSummary?: ReflectionPreviousSummary | null;
  expectedPreviousRevision?: number;
  transcriptFingerprint?: string;
  existingMemories?: readonly ReflectionExistingMemory[];
  userProfile?: readonly { canonicalKey: string; kind: MemoryUpsertInput["kind"]; text: string }[];
  entries: readonly unknown[];
  /** SequenceIds parallel to `entries`; enables contiguous coverage in the projection. */
  entrySequenceIds?: readonly number[];
  /**
   * Set by the reflect callback to the boundary the sent payload actually
   * covered (≤ throughSequenceId). The applied summary must land exactly here;
   * the worker defers the job to re-claim the omitted tail.
   */
  coveredThroughSequenceId?: number;
  /**
   * Set by the reflect callback to the entry ids actually present in the sent
   * payload. Source and trust:user evidence validation must use this set —
   * never the whole loaded batch — so a deferred tail cannot back a memory.
   */
  coveredEntryIds?: readonly string[];
}

export interface ReflectionSummary {
  throughSequenceId: number;
  summaryJson: unknown;
  renderedText: string;
}

export type ReflectionOperation =
  | { op: "upsert"; memory: MemoryUpsertInput; scope?: MemoryScope }
  | { op: "supersede"; memoryId: string; replacement?: MemoryUpsertInput; reason?: string }
  | { op: "forget"; memoryId: string; reason?: string };

export interface ReflectionResult {
  summary?: ReflectionSummary;
  operations: ReflectionOperation[];
}

export type ReflectCallback = (input: MemoryReflectionInput, signal: AbortSignal) => Promise<unknown> | unknown;

type ReflectionCancellationReason = "archived" | "deleted";

const SUMMARY_KEYS = new Set(["throughSequenceId", "summaryJson", "renderedText"]);
const OP_KEYS = new Set(["op", "type", "memory", "memoryId", "replacement", "reason", "scope"]);
const MEMORY_KEYS = new Set([
  "id", "kind", "canonicalKey", "text", "valueJson", "trust", "status", "importance", "confidence", "pinned",
  "sourceConversationId", "sourceEntryIds", "validFromMs", "validToMs", "expiresAtMs",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoExtras(record: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`${label}: campo não suportado: ${key}`);
}

function parseFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function parseUnknown(input: string | unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(parseFence(input)) as unknown;
  } catch {
    throw new Error("reflection: JSON inválido");
  }
}

function parseSummary(value: unknown): ReflectionSummary | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("reflection: summary deve ser objeto");
  assertNoExtras(value, SUMMARY_KEYS, "reflection summary");
  if (!Number.isSafeInteger(value.throughSequenceId) || (value.throughSequenceId as number) < 0) throw new Error("reflection: throughSequenceId inválido");
  if (typeof value.renderedText !== "string" || value.renderedText.trim().length === 0 || Buffer.byteLength(value.renderedText, "utf8") > MEMORY_POLICY_LIMITS.renderedSummaryBytes) throw new Error("reflection: renderedText inválido");
  if (!Object.prototype.hasOwnProperty.call(value, "summaryJson")) throw new Error("reflection: summaryJson obrigatório");
  return {
    throughSequenceId: value.throughSequenceId as number,
    summaryJson: value.summaryJson,
    renderedText: value.renderedText,
  };
}

function parseMemory(value: unknown): MemoryUpsertInput {
  if (!isRecord(value)) throw new Error("reflection: memory deve ser objeto");
  assertNoExtras(value, MEMORY_KEYS, "reflection memory");
  if (typeof value.kind !== "string" || typeof value.canonicalKey !== "string" || typeof value.text !== "string" || typeof value.trust !== "string") {
    throw new Error("reflection: memória incompleta");
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    kind: value.kind as MemoryUpsertInput["kind"],
    canonicalKey: value.canonicalKey,
    text: value.text,
    valueJson: value.valueJson,
    trust: value.trust as MemoryUpsertInput["trust"],
    ...(typeof value.status === "string" ? { status: value.status as MemoryUpsertInput["status"] } : {}),
    ...(value.importance === undefined ? {} : { importance: value.importance as number }),
    ...(value.confidence === undefined ? {} : { confidence: value.confidence as number }),
    ...(value.pinned === undefined ? {} : { pinned: value.pinned as boolean }),
    ...(value.sourceConversationId === undefined ? {} : { sourceConversationId: value.sourceConversationId as string | null }),
    ...(value.sourceEntryIds === undefined ? {} : { sourceEntryIds: value.sourceEntryIds as MemoryUpsertInput["sourceEntryIds"] }),
    ...(value.validFromMs === undefined ? {} : { validFromMs: value.validFromMs as number }),
    ...(value.validToMs === undefined ? {} : { validToMs: value.validToMs as number | null }),
    ...(value.expiresAtMs === undefined ? {} : { expiresAtMs: value.expiresAtMs as number | null }),
  };
}

function parseOperation(value: unknown): ReflectionOperation {
  if (!isRecord(value)) throw new Error("reflection: operação deve ser objeto");
  const opValue = value.op ?? value.type;
  if (opValue !== "upsert" && opValue !== "supersede" && opValue !== "forget") throw new Error("reflection: operação inválida");
  if (opValue === "upsert") {
    assertNoExtras(value, new Set([...OP_KEYS, ...MEMORY_KEYS]), "reflection operation");
    const flat = { ...value };
    delete flat.op;
    delete flat.type;
    delete flat.scope;
    const memory = value.memory === undefined ? parseMemory(flat) : parseMemory(value.memory);
    const scopeRaw = value.scope;
    if (scopeRaw !== undefined && scopeRaw !== "user" && scopeRaw !== "agent") throw new Error("reflection: scope inválido");
    const scope = scopeRaw === "user" ? "user" as const : scopeRaw === "agent" ? "agent" as const : undefined;
    return { op: "upsert", memory, ...(scope === undefined ? {} : { scope }) };
  }
  assertNoExtras(value, OP_KEYS, "reflection operation");
  if (typeof value.memoryId !== "string" || value.memoryId.trim().length === 0) throw new Error("reflection: memoryId obrigatório");
  if (opValue === "forget") return { op: "forget", memoryId: value.memoryId, ...(typeof value.reason === "string" ? { reason: value.reason } : {}) };
  return {
    op: "supersede",
    memoryId: value.memoryId,
    ...(value.replacement === undefined ? {} : { replacement: parseMemory(value.replacement) }),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

/** Strict JSON parser. Markdown fences are accepted, unknown fields are not. */
export function parseReflectionResult(input: string | unknown): ReflectionResult {
  const value = parseUnknown(input);
  if (!isRecord(value)) throw new Error("reflection: resultado deve ser objeto");
  const allowed = new Set(["summary", "ops", "operations"]);
  assertNoExtras(value, allowed, "reflection result");
  const rawOps = value.operations ?? value.ops ?? [];
  if (!Array.isArray(rawOps) || rawOps.length > MEMORY_POLICY_LIMITS.reflectionItems) throw new Error("reflection: limite de operações excedido");
  return {
    summary: parseSummary(value.summary),
    operations: rawOps.map(parseOperation),
  };
}

export const parseReflectionOutput = parseReflectionResult;

/**
 * Failure taxonomy for job retry: provider/admission errors keep their own
 * retryability, output-format errors are retryable (next attempt may parse),
 * and permanent conditions stop the job without burning every attempt.
 */
const classifyReflectionFailure = (error: unknown, aborted: boolean): { code: string; retryable: boolean } => {
  if (aborted) return { code: "timeout", retryable: true };
  if (error instanceof ProviderError) return { code: `provider_${error.kind}`, retryable: error.retryable };
  if (error instanceof ProviderAdmissionError) return { code: `admission_${error.code}`, retryable: error.retryable };
  if (error instanceof Error && error.message.includes("indisponível ou incompatível")) return { code: "reflection_input", retryable: false };
  if (error instanceof Error && error.message.startsWith("reflection:")) return { code: "reflection_format", retryable: true };
  return { code: "reflection_failed", retryable: true };
};

function validateInput(input: MemoryReflectionInput): void {
  if (typeof input.agentId !== "string" || input.agentId.trim().length === 0) throw new Error("reflection: agentId inválido");
  if (typeof input.conversationId !== "string" || input.conversationId.trim().length === 0) throw new Error("reflection: conversationId inválido");
  if (typeof input.provider !== "string" || input.provider.trim().length === 0) throw new Error("reflection: provider inválido");
  if (typeof input.model !== "string" || input.model.trim().length === 0) throw new Error("reflection: model inválido");
  if (!Number.isSafeInteger(input.fromSequenceId) || input.fromSequenceId < 0 || !Number.isSafeInteger(input.throughSequenceId) || input.throughSequenceId < input.fromSequenceId) throw new Error("reflection: intervalo inválido");
  if (input.summaryRequested !== undefined && typeof input.summaryRequested !== "boolean") throw new Error("reflection: summaryRequested inválido");
  if (input.memoryRequested !== undefined && typeof input.memoryRequested !== "boolean") throw new Error("reflection: memoryRequested inválido");
  if (input.summaryRequested === false && input.memoryRequested === false) throw new Error("reflection: job sem saída solicitada");
  if (input.expectedPreviousRevision !== undefined && (!Number.isSafeInteger(input.expectedPreviousRevision) || input.expectedPreviousRevision < 0)) throw new Error("reflection: expectedPreviousRevision inválido");
  if (input.transcriptFingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(input.transcriptFingerprint)) throw new Error("reflection: transcriptFingerprint inválido");
  if (!Array.isArray(input.entries)) throw new Error("reflection: entries deve ser lista");
}

function deriveJobSourceEntryIds(entries: readonly unknown[], conversationId: string): MemoryUpsertInput["sourceEntryIds"] {
  const derived: Array<Exclude<NonNullable<MemoryUpsertInput["sourceEntryIds"]>[number], string>> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (derived.length >= MEMORY_POLICY_LIMITS.sourceEntryIds) break;
    if (typeof entry !== "object" || entry === null) continue;
    const id = "id" in entry && typeof (entry as { id?: unknown }).id === "string"
      ? (entry as { id: string }).id.trim()
      : "";
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    derived.push({ conversationId, entryId: id });
  }
  return derived;
}

function explicitUserMemoryEntryIds(entries: readonly unknown[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (
      typeof entry !== "object"
      || entry === null
      || (entry as { kind?: unknown }).kind !== "message"
      || (entry as { role?: unknown }).role !== "user"
      || typeof (entry as { id?: unknown }).id !== "string"
      || typeof (entry as { content?: unknown }).content !== "string"
      || typeof (entry as { fromUser?: unknown }).fromUser !== "object"
      || (entry as { fromUser?: unknown }).fromUser === null
      || (entry as { fromAgent?: unknown }).fromAgent !== undefined
      || !isExplicitMemoryIntent((entry as { content: string }).content)
    ) continue;
    const id = (entry as { id: string }).id.trim();
    if (id.length > 0) ids.add(id);
  }
  return ids;
}

function latestHumanUserHasExplicitMemoryIntent(entries: readonly unknown[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      typeof entry !== "object"
      || entry === null
      || (entry as { kind?: unknown }).kind !== "message"
      || (entry as { role?: unknown }).role !== "user"
    ) continue;
    return typeof (entry as { content?: unknown }).content === "string"
      && typeof (entry as { fromUser?: unknown }).fromUser === "object"
      && (entry as { fromUser?: unknown }).fromUser !== null
      && (entry as { fromAgent?: unknown }).fromAgent === undefined
      && isExplicitMemoryIntent((entry as { content: string }).content);
  }
  return false;
}

function normalizeCanonicalKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu, " ");
}

function successfulRememberedCanonicalKeys(entries: readonly unknown[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (
      typeof entry !== "object"
      || entry === null
      || (entry as { kind?: unknown }).kind !== "tool-call"
      || (entry as { name?: unknown }).name !== "memory_remember"
      || (entry as { status?: unknown }).status !== "completed"
    ) continue;
    const raw = (entry as { result?: unknown }).result;
    let result = raw;
    if (typeof raw === "string") {
      try { result = JSON.parse(raw) as unknown; } catch { continue; }
    }
    if (
      typeof result !== "object"
      || result === null
      || (result as { ok?: unknown }).ok !== true
      || (result as { operation?: unknown }).operation !== "memory.remember"
      || typeof (result as { canonicalKey?: unknown }).canonicalKey !== "string"
    ) continue;
    keys.add(normalizeCanonicalKey((result as { canonicalKey: string }).canonicalKey));
  }
  return keys;
}

function candidateEvidenceSources(
  memory: MemoryUpsertInput,
  conversationId: string,
  jobSourceEntryIds: MemoryUpsertInput["sourceEntryIds"],
): NonNullable<MemoryUpsertInput["sourceEntryIds"]> | null {
  const jobEntryIds = new Set((jobSourceEntryIds ?? []).flatMap((source) => (
    typeof source === "string" ? [source] : [source.entryId]
  )));
  const normalized: Array<Exclude<NonNullable<MemoryUpsertInput["sourceEntryIds"]>[number], string>> = [];
  const seen = new Set<string>();
  const sources: unknown = memory.sourceEntryIds;
  if (sources !== undefined && !Array.isArray(sources)) return null;
  for (const source of sources ?? []) {
    const isRef = typeof source === "object" && source !== null && !Array.isArray(source)
      && typeof (source as { conversationId?: unknown }).conversationId === "string"
      && typeof (source as { entryId?: unknown }).entryId === "string";
    if (typeof source !== "string" && !isRef) return null;
    const entryId = typeof source === "string" ? source.trim() : (source as { entryId: string }).entryId.trim();
    const sourceConversationId = typeof source === "string" ? conversationId : (source as { conversationId: string }).conversationId;
    if (entryId.length === 0 || sourceConversationId !== conversationId || !jobEntryIds.has(entryId)) return null;
    if (seen.has(entryId)) continue;
    seen.add(entryId);
    normalized.push({ conversationId, entryId });
  }
  return normalized;
}

function jobScopedMemory(
  memory: MemoryUpsertInput,
  conversationId: string,
  sourceEntryIds: MemoryUpsertInput["sourceEntryIds"],
): MemoryUpsertInput {
  return {
    ...memory,
    sourceConversationId: conversationId,
    sourceEntryIds,
  };
}

function automaticAuthority(
  conversationId: string,
  sourceEntryIds: MemoryUpsertInput["sourceEntryIds"],
): MemoryMutationAuthority {
  return {
    kind: "automatic",
    conversationId,
    evidenceIds: (sourceEntryIds ?? []).flatMap((source) => typeof source === "string" ? [source] : [source.entryId]),
  };
}

function authorityRejection(error: unknown, index: number): PolicyRejection | undefined {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code !== "protected_target" && code !== "revision_conflict" && code !== "invalid_authority" && code !== "policy") return undefined;
  return {
    index,
    code,
    message: error instanceof Error ? error.message : "mutação automática rejeitada pela store",
  };
}

function hasConversationProvenance(memory: Memory, conversationId: string): boolean {
  if (memory.sourceConversationId === conversationId) return true;
  return memory.sourceEntryIds.some((source) => (
    typeof source === "object"
    && source !== null
    && "conversationId" in source
    && typeof source.conversationId === "string"
    && source.conversationId === conversationId
  ));
}

function validateReflectionTarget(
  store: MemoryStore,
  agentId: string,
  conversationId: string,
  memoryId: string,
  operationIndex: number,
): { memory?: Memory; rejection?: PolicyRejection } {
  const memory = store.getMemory(agentId, memoryId);
  if (memory === null) {
    return { rejection: { index: operationIndex, code: "missing_target", message: "memória alvo não encontrada" } };
  }
  if (memory.status !== "active") {
    return { rejection: { index: operationIndex, code: "inactive_target", message: "reflection automática só altera memórias ativas" } };
  }
  if (memory.pinned || memory.trust === "user") {
    return { rejection: { index: operationIndex, code: "protected_target", message: "reflection automática não altera memórias pinned ou trust:user" } };
  }
  if (!hasConversationProvenance(memory, conversationId)) {
    return { rejection: { index: operationIndex, code: "foreign_target", message: "reflection automática só altera memórias derivadas da conversa atual" } };
  }
  return { memory };
}

function validateReplacement(
  replacement: MemoryUpsertInput,
  operationIndex: number,
  conversationId: string,
  jobSourceEntryIds: MemoryUpsertInput["sourceEntryIds"],
): { replacement?: MemoryUpsertInput; rejection?: PolicyRejection } {
  const checked = validateReflectionCandidates([replacement]);
  const rejected = checked.rejected[0];
  if (rejected !== undefined) {
    return { rejection: { ...rejected, index: operationIndex } };
  }
  const accepted = checked.accepted[0];
  if (accepted === undefined) {
    return { rejection: { index: operationIndex, code: "invalid_replacement", message: "replacement inválida" } };
  }
  if (accepted.pinned || accepted.trust === "user") {
    return {
      rejection: {
        index: operationIndex,
        code: "replacement_protected",
        message: "replacement automática não pode usar pinned ou trust:user",
      },
    };
  }
  const sources = candidateEvidenceSources(accepted, conversationId, jobSourceEntryIds);
  if (sources === null || sources.length === 0) {
    return {
      rejection: {
        index: operationIndex,
        code: sources === null ? "source_invalid" : "source_missing",
        message: "replacement exige sourceEntryIds específicas do trecho examinado",
      },
    };
  }
  return { replacement: { ...accepted, sourceEntryIds: sources } };
}

/** Applies a parsed result in one logical store transaction. */
export function applyReflectionResult(store: MemoryStore, input: MemoryReflectionInput, result: ReflectionResult | string | unknown): { memories: Memory[]; rejected: PolicyRejection[] } {
  validateInput(input);
  const parsed = parseReflectionResult(result);
  const forgotten = store.getForgottenSourceIds(input.agentId, input.conversationId);
  if (input.entries.some((entry) => forgotten.has((entry as { id: string }).id))) {
    throw new Error("reflection: entrada contém fonte esquecida; recarregue o contexto");
  }
  if (input.summaryRequested === true && parsed.summary === undefined) throw new Error("reflection: summary solicitada não retornada");
  if (input.memoryRequested === false && parsed.operations.length > 0) throw new Error("reflection: operações de memória não solicitadas");
  const requestedSummary = input.summaryRequested === false ? undefined : parsed.summary;
  // Evidence may only come from the entries actually sent to the provider.
  // When the projection covered a strict prefix, the deferred tail stays
  // ineligible for sourceEntryIds and trust:user evidence alike.
  const coveredIds = input.coveredEntryIds === undefined ? undefined : new Set(input.coveredEntryIds);
  const coveredEntries = coveredIds === undefined
    ? input.entries
    : input.entries.filter((entry) => (
      typeof entry === "object" && entry !== null
      && coveredIds.has((entry as { id?: unknown }).id as string)
    ));
  const jobSourceEntryIds = deriveJobSourceEntryIds(coveredEntries, input.conversationId);
  const explicitEntryIds = explicitUserMemoryEntryIds(coveredEntries);
  const directlyRememberedKeys = successfulRememberedCanonicalKeys(input.entries);
  const usedExplicitEvidenceIds = new Set<string>();
  const candidates = parsed.operations.flatMap((operation, index) => (
    operation.op === "upsert" ? [{ candidate: operation.memory, index, scope: operation.scope ?? "agent" as MemoryScope }] : []
  ));
  const checked = candidates.reduce<{ accepted: MemoryUpsertInput[]; rejected: PolicyRejection[] }>((result, item) => {
    const { candidate, index } = item;
    let scopedCandidate = candidate;
    let userTrustSourceIds: string[] = [];
    if (directlyRememberedKeys.has(normalizeCanonicalKey(candidate.canonicalKey))) {
      result.rejected.push({
        index,
        code: "already_remembered",
        message: "memory_remember já persistiu esta chave canônica no turno",
      });
      return result;
    }
    if (candidate.trust === "user") {
      const sources = candidateEvidenceSources(candidate, input.conversationId, jobSourceEntryIds);
      if (sources === null || sources.length === 0 || sources.some((source) => (
        typeof source === "string" || !explicitEntryIds.has(source.entryId)
      ))) {
        result.rejected.push({
          index,
          code: "user_trust_requires_explicit_evidence",
          message: "trust:user exige proveniência da mensagem exata com pedido explícito para memorizar",
        });
        return result;
      }
      userTrustSourceIds = sources.map((source) => typeof source === "string" ? source : source.entryId);
      if (userTrustSourceIds.some((entryId) => usedExplicitEvidenceIds.has(entryId))) {
        result.rejected.push({
          index,
          code: "user_trust_evidence_reused",
          message: "cada pedido explícito do usuário pode autorizar no máximo uma memória trust:user",
        });
        return result;
      }
      scopedCandidate = { ...candidate, sourceEntryIds: sources };
    } else {
      // Precise provenance: an automatic memory keeps only the specific
      // examined entries the model cited — never the whole job batch, so a
      // forgotten topic cannot suppress unrelated memories later.
      const sources = candidateEvidenceSources(candidate, input.conversationId, jobSourceEntryIds);
      if (sources === null || sources.length === 0) {
        result.rejected.push({
          index,
          code: sources === null ? "source_invalid" : "source_missing",
          message: "upsert automático exige sourceEntryIds específicas do trecho examinado",
        });
        return result;
      }
      scopedCandidate = { ...candidate, sourceEntryIds: sources };
    }
    const validation = validateReflectionCandidates([scopedCandidate], {
      allowPinned: false,
      allowUserTrust: candidate.trust === "user",
    });
    const rejection = validation.rejected[0];
    if (rejection !== undefined) result.rejected.push({ ...rejection, index });
    else if (validation.accepted[0] !== undefined) {
      result.accepted.push(validation.accepted[0]);
      for (const entryId of userTrustSourceIds) usedExplicitEvidenceIds.add(entryId);
    }
    return result;
  }, { accepted: [], rejected: [] });
  const authority = automaticAuthority(input.conversationId, jobSourceEntryIds);
  const coveredThrough = input.coveredThroughSequenceId ?? input.throughSequenceId;
  if (requestedSummary !== undefined && requestedSummary.throughSequenceId !== coveredThrough) {
    throw new Error("reflection: summary solicitada deve alcançar o limite coberto do job");
  }
  if (requestedSummary !== undefined && (requestedSummary.throughSequenceId < input.fromSequenceId || requestedSummary.throughSequenceId > input.throughSequenceId)) {
    throw new Error("reflection: summary fora do intervalo do job");
  }
  const memories: Memory[] = [];
  const rejected: PolicyRejection[] = [...checked.rejected];
    let acceptedIndex = 0;
  const rejectedIndexes = new Set(checked.rejected.map((rejection) => rejection.index));
  store.transaction(() => {
    if (requestedSummary !== undefined) {
      const summary: ConversationSummaryInput = {
        conversationId: input.conversationId,
        throughSequenceId: requestedSummary.throughSequenceId,
        summaryJson: requestedSummary.summaryJson,
        renderedText: requestedSummary.renderedText,
        ...(input.expectedPreviousRevision === undefined ? {} : { expectedPreviousRevision: input.expectedPreviousRevision }),
      };
      store.upsertSummary(input.agentId, summary);
    }
    for (const [operationIndex, operation] of parsed.operations.entries()) {
      if (operation.op === "upsert") {
        const candidateRejected = rejectedIndexes.has(operationIndex);
        if (candidateRejected) continue;
        const memory = checked.accepted[acceptedIndex++];
        if (memory === undefined) throw new Error("reflection: candidato validado ausente");
        const scope = operation.scope ?? "agent";
        if (scope === "user" && !USER_PROFILE_KINDS.includes(memory.kind)) {
          rejected.push({
            index: operationIndex,
            code: "policy",
            message: "perfil de usuário aceita apenas identity e preference",
          });
          continue;
        }
        const targetAgentId = scope === "user" ? USER_PROFILE_AGENT_ID : input.agentId;
        try {
          memories.push(store.upsertMemory(targetAgentId, jobScopedMemory(memory, input.conversationId, memory.sourceEntryIds), authority));
        } catch (error) {
          const rejection = authorityRejection(error, operationIndex);
          if (rejection === undefined) throw error;
          rejected.push(rejection);
        }
      } else {
        const target = validateReflectionTarget(store, input.agentId, input.conversationId, operation.memoryId, operationIndex);
        if (target.rejection !== undefined) {
          rejected.push(target.rejection);
          continue;
        }
        if (operation.op === "supersede") {
          let replacement = operation.replacement;
          if (replacement !== undefined) {
            const checkedReplacement = validateReplacement(replacement, operationIndex, input.conversationId, jobSourceEntryIds);
            if (checkedReplacement.rejection !== undefined) {
              rejected.push(checkedReplacement.rejection);
              continue;
            }
            replacement = {
              ...jobScopedMemory(checkedReplacement.replacement!, input.conversationId, checkedReplacement.replacement!.sourceEntryIds),
            };
          }
          try {
            memories.push(store.supersedeMemory(input.agentId, operation.memoryId, authority, replacement, operation.reason));
          } catch (error) {
            const rejection = authorityRejection(error, operationIndex);
            if (rejection === undefined) throw error;
            rejected.push(rejection);
          }
        } else {
          try {
            memories.push(store.forgetMemory(input.agentId, operation.memoryId, authority, operation.reason));
          } catch (error) {
            const rejection = authorityRejection(error, operationIndex);
            if (rejection === undefined) throw error;
            rejected.push(rejection);
          }
        }
      }
    }
  });
  return { memories, rejected };
}

export interface MemoryReflectionWorkerOptions {
  store: MemoryStore;
  reflect: ReflectCallback;
  /** Rehydrates durable jobs after a process restart; it stays provider-agnostic. */
  loadInput?: (job: MemoryJob, signal: AbortSignal) => Promise<MemoryReflectionInput | null> | MemoryReflectionInput | null;
  concurrency?: number;
  perAgentConcurrency?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: readonly number[];
  /** Foreground turns have priority; false keeps this agent queued. */
  canRunAgent?: (agentId: string) => boolean;
  /**
   * Chamado quando um job esgota as tentativas e vira `dead` (ex.: credenciais
   * do provider inválidas). Superfície de visibilidade — o callback recebe
   * apenas código e texto de erro já sanitizados, nunca credenciais.
   */
  onJobDead?: (notice: { agentId: string; conversationId?: string; jobId: string; provider: string; model: string; error: { code: string; text: string } }) => void;
}

export interface MemoryReflectionWorkerEnqueueInput extends MemoryReflectionInput {
  id?: string;
}

/** Provider-agnostic durable reflection worker. It only receives a callback. */
export class MemoryReflectionWorker {
  private readonly store: MemoryStore;
  private readonly reflect: ReflectCallback;
  private readonly loadInput?: MemoryReflectionWorkerOptions["loadInput"];
  private readonly globalConcurrency: number;
  private readonly perAgentConcurrency: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: readonly number[];
  private readonly canRunAgent: (agentId: string) => boolean;
  private readonly onJobDead?: MemoryReflectionWorkerOptions["onJobDead"];
  private readonly queue: MemoryReflectionWorkerEnqueueInput[] = [];
  private readonly activeAgents = new Map<string, number>();
  private readonly activeControllers = new Map<AbortController, MemoryJob>();
  private active = 0;
  private closed = false;
  private pumping = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pendingClose: Array<() => void> = [];

  constructor(options: MemoryReflectionWorkerOptions) {
    this.store = options.store;
    this.reflect = options.reflect;
    this.loadInput = options.loadInput;
    this.globalConcurrency = options.concurrency ?? 2;
    this.perAgentConcurrency = options.perAgentConcurrency ?? 1;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoffMs = options.backoffMs ?? [5_000, 30_000, 300_000];
    this.canRunAgent = options.canRunAgent ?? (() => true);
    this.onJobDead = options.onJobDead;
    if (!Number.isInteger(this.globalConcurrency) || this.globalConcurrency < 1) throw new Error("concurrency inválida");
    if (!Number.isInteger(this.perAgentConcurrency) || this.perAgentConcurrency < 1) throw new Error("per-agent concurrency inválida");
  }

  /** Call once during process boot, before starting any workers sharing this store. */
  recoverAbandonedJobs(): number {
    if (this.closed) throw new Error("memory reflection worker fechado");
    return this.store.resetRunningJobs();
  }

  enqueue(input: MemoryReflectionWorkerEnqueueInput): MemoryReflectionWorkerEnqueueInput {
    if (this.closed) throw new Error("memory reflection worker fechado");
    const job = this.store.enqueueJob({
      id: input.id,
      agentId: input.agentId,
      conversationId: input.conversationId,
      provider: input.provider,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      fromSequenceId: input.fromSequenceId,
      throughSequenceId: input.throughSequenceId,
      summaryRequested: input.summaryRequested,
      memoryRequested: input.memoryRequested,
    });
    const queued = {
      ...input,
      id: job.id,
      provider: job.provider,
      model: job.model,
      reasoningEffort: job.reasoningEffort,
      fromSequenceId: job.fromSequenceId,
      throughSequenceId: job.throughSequenceId,
      summaryRequested: job.summaryRequested,
      memoryRequested: job.memoryRequested,
    };
    const existing = this.queue.findIndex((item) => item.agentId === queued.agentId && item.conversationId === queued.conversationId);
    if (existing < 0) this.queue.push(queued);
    else this.queue[existing] = queued;
    this.pump();
    return queued;
  }

  start(): void {
    if (this.closed) throw new Error("memory reflection worker fechado");
    this.pump();
  }

  cancelConversation(agentId: string, conversationId: string, reason: ReflectionCancellationReason = "archived"): void {
    const cancellationReason: ReflectionCancellationReason = reason === "deleted" ? "deleted" : "archived";
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const input = this.queue[index]!;
      if (input.agentId === agentId && input.conversationId === conversationId) this.queue.splice(index, 1);
    }
    for (const [controller, job] of this.activeControllers) {
      if (job.agentId === agentId && job.conversationId === conversationId) {
        controller.abort(new Error(`reflection conversation ${cancellationReason}`));
      }
    }
    this.pump();
  }

  private pump(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    queueMicrotask(() => {
      this.pumping = false;
      if (this.closed) {
        if (this.active === 0) this.resolveClose();
        return;
      }
      while (this.active < this.globalConcurrency) {
        const index = this.queue.findIndex((item) => (
          this.canRunAgent(item.agentId) && (this.activeAgents.get(item.agentId) ?? 0) < this.perAgentConcurrency
        ));
        const input = index < 0 ? undefined : this.queue.splice(index, 1)[0];
        const recovered = input === undefined && this.loadInput !== undefined
          ? this.store.listRunnableJobs(undefined, 100).find((job) => (
            this.canRunAgent(job.agentId) && (this.activeAgents.get(job.agentId) ?? 0) < this.perAgentConcurrency
          ))
          : undefined;
        if (input === undefined && recovered === undefined) break;
        const agentId = input?.agentId ?? recovered!.agentId;
        this.active += 1;
        this.activeAgents.set(agentId, (this.activeAgents.get(agentId) ?? 0) + 1);
        const task = input === undefined ? this.runRecovered(recovered!) : this.run(input);
        void task.finally(() => {
          this.active -= 1;
          const count = (this.activeAgents.get(agentId) ?? 1) - 1;
          if (count <= 0) this.activeAgents.delete(agentId); else this.activeAgents.set(agentId, count);
          this.pump();
          if (this.active === 0 && this.queue.length === 0) this.resolveClose();
        });
      }
      this.scheduleRetryWake();
      if (this.active === 0 && this.queue.length === 0) this.resolveClose();
    });
  }

  private scheduleRetryWake(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.closed || this.loadInput === undefined || this.active >= this.globalConcurrency) return;
    const now = Date.now();
    const deadlines = this.store.listRunnableJobs(Number.MAX_SAFE_INTEGER, 100)
      .filter((job) => job.nextAttemptAtMs > now && this.canRunAgent(job.agentId)
        && (this.activeAgents.get(job.agentId) ?? 0) < this.perAgentConcurrency)
      .map((job) => job.nextAttemptAtMs);
    if (deadlines.length === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.pump();
    }, Math.min(Math.min(...deadlines) - now, 2_147_483_647));
    this.retryTimer.unref?.();
  }

  private async run(input: MemoryReflectionWorkerEnqueueInput): Promise<void> {
    const job = this.store.claimJob(input.agentId, input.id);
    if (job === null) return;
    await this.runClaimed(job, async () => ({
      ...input,
      provider: input.provider ?? job.provider,
      model: input.model ?? job.model,
      reasoningEffort: job.reasoningEffort,
    }));
  }

  private async runRecovered(candidate: MemoryJob): Promise<void> {
    const job = this.store.claimJob(candidate.agentId, candidate.id);
    if (job === null) return;
    await this.runClaimed(job, async (signal) => this.loadInput!(job, signal));
  }

  private async runClaimed(job: MemoryJob, resolveInput: (signal: AbortSignal) => Promise<MemoryReflectionInput | null>): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.set(controller, job);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("reflection timeout"));
        reject(new Error("reflection timeout"));
      }, this.timeoutMs);
    });
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? new Error("reflection aborted")), { once: true });
    });
    try {
      const input = await Promise.race([resolveInput(controller.signal), timeout, aborted]);
      controller.signal.throwIfAborted();
      if (
        input === null ||
        input.agentId !== job.agentId ||
        input.conversationId !== job.conversationId ||
        input.provider !== job.provider ||
        input.model !== job.model ||
        input.fromSequenceId !== job.fromSequenceId ||
        input.throughSequenceId !== job.throughSequenceId
      ) {
        throw new Error("reflection input indisponível ou incompatível com job");
      }
      const reflected = await Promise.race([Promise.resolve(this.reflect(input, controller.signal)), timeout, aborted]);
      if (controller.signal.aborted) throw new Error("reflection timeout");
      const parsed = parseReflectionResult(reflected);
      if (this.loadInput !== undefined && input.transcriptFingerprint !== undefined) {
        const currentInput = await Promise.race([Promise.resolve(this.loadInput(job, controller.signal)), timeout, aborted]);
        if (
          currentInput === null
          || currentInput.transcriptFingerprint !== input.transcriptFingerprint
          || currentInput.expectedPreviousRevision !== input.expectedPreviousRevision
          || currentInput.summaryRequested !== input.summaryRequested
          || currentInput.memoryRequested !== input.memoryRequested
        ) {
          throw new Error("reflection: snapshot de entrada ficou stale");
        }
      }
      this.store.transaction(() => {
        const current = this.store.getJob(input.agentId, job.id);
        if (current?.status !== "running") return;
        if (!this.store.isConversationActive(input.agentId, input.conversationId)) return;
        const currentMode = this.store.getSettings(input.agentId).mode;
        const memoryWritesAllowed = currentMode === "automatic"
          || (currentMode === "explicit" && latestHumanUserHasExplicitMemoryIntent(input.entries));
        if (memoryWritesAllowed) {
          applyReflectionResult(this.store, input, parsed);
        } else if (input.summaryRequested === true) {
          applyReflectionResult(this.store, { ...input, memoryRequested: false }, { ...parsed, operations: [] });
        }
        // When the request payload could only cover a contiguous prefix of the
        // job range, the boundary advanced to the last examined entry. The
        // same job is then deferred to the first unexamined entry so the tail
        // is claimed again — enqueueing a fresh row would hit the
        // (agent, conversation, throughSequenceId) unique key and vanish.
        const coveredThrough = input.coveredThroughSequenceId ?? job.throughSequenceId;
        if (coveredThrough < job.throughSequenceId) {
          this.store.deferJob(input.agentId, job.id, Math.max(job.fromSequenceId, coveredThrough + 1));
        } else {
          this.store.completeJob(input.agentId, job.id);
        }
      });
    } catch (error) {
      if (this.closed) {
        // Return the claimed job to the durable queue instead of leaving it
        // `running` ownerless until the next boot recovery. Immediate retry
        // (no backoff): this is a shutdown handoff, not a failure, so the
        // next boot's worker must be able to pick it up at once.
        // Best-effort: the store may already be closed during shutdown.
        try {
          this.store.retryJob(job.agentId, job.id, { code: "aborted", text: "reflection worker fechado" }, undefined, {
            maxAttempts: this.maxAttempts,
            backoffMs: [0],
          });
        } catch {
          // Shutdown path: the next boot's recoverAbandonedJobs owns it.
        }
        return;
      }
      const text = error instanceof Error ? error.message : String(error);
      const failure = classifyReflectionFailure(error, controller.signal.aborted);
      const errorCode = failure.code;
      const current = this.store.getJob(job.agentId, job.id);
      if (current === null || current.status !== "running" || !this.store.isConversationActive(job.agentId, job.conversationId)) return;
      if (!failure.retryable || (current?.attempts ?? job.attempts) >= this.maxAttempts) {
        this.store.deadJob(job.agentId, job.id, { code: errorCode, text });
        try {
          this.onJobDead?.({ agentId: job.agentId, conversationId: job.conversationId, jobId: job.id, provider: job.provider, model: job.model, error: { code: errorCode, text } });
        } catch {
          // A notificação é best-effort; o estado `dead` já está persistido.
        }
      }
      else this.store.retryJob(job.agentId, job.id, { code: errorCode, text }, undefined, {
        maxAttempts: this.maxAttempts,
        backoffMs: this.backoffMs,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.activeControllers.delete(controller);
    }
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.queue.length = 0;
    for (const controller of this.activeControllers.keys()) controller.abort(new Error("reflection worker fechado"));
    if (this.active === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.pendingClose.push(resolve));
  }

  abort(): Promise<void> {
    return this.close();
  }

  waitForIdle(): Promise<void> {
    if (!this.pumping && this.active === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.pendingClose.push(resolve));
  }

  private resolveClose(): void {
    for (const resolve of this.pendingClose.splice(0)) resolve();
  }
}

export default MemoryReflectionWorker;
