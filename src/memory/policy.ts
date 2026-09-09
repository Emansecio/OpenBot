import type { MemoryKind, MemoryTrust, MemoryUpsertInput } from "./types.js";

export const MEMORY_POLICY_LIMITS = {
  canonicalKeyBytes: 256,
  textBytes: 16 * 1024,
  valueJsonBytes: 32 * 1024,
  sourceEntryIds: 128,
  sourceEntryIdBytes: 512,
  reflectionItems: 32,
  renderedSummaryBytes: 32 * 1024,
} as const;

export interface MemoryPolicyOptions {
  secretValues?: readonly string[] | (() => readonly string[]);
  maxItems?: number;
  allowPinned?: boolean;
  allowUserTrust?: boolean;
}

export interface ReflectionCandidate {
  kind: MemoryKind;
  canonicalKey: string;
  text: string;
  trust: MemoryTrust;
  valueJson?: unknown | null;
  sourceEntryIds?: readonly unknown[];
  sourceConversationId?: string | null;
  importance?: number;
  confidence?: number;
  pinned?: boolean;
  validFromMs?: number;
  validToMs?: number | null;
  expiresAtMs?: number | null;
}

export type MemoryReflectionCandidate = ReflectionCandidate;

export interface PolicyRejection {
  index: number;
  code: string;
  message: string;
}

export interface PolicyValidationResult {
  accepted: MemoryUpsertInput[];
  rejected: PolicyRejection[];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "";
  }
}

function secretValuesFrom(options?: MemoryPolicyOptions): readonly string[] {
  if (options?.secretValues === undefined) return [];
  try {
    const values = typeof options.secretValues === "function" ? options.secretValues() : options.secretValues;
    return values.filter((value) => typeof value === "string" && value.length >= 6);
  } catch {
    return [];
  }
}

function normalizeForMatching(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

/** Conservative detector: it avoids treating ordinary words such as "token" as secrets. */
export function containsSensitiveSecret(value: unknown, options?: MemoryPolicyOptions): boolean {
  const text = typeof value === "string" ? value : stringifyJson(value);
  if (text.length === 0) return false;
  const known = secretValuesFrom(options);
  if (known.some((secret) => secret.length > 0 && text.includes(secret))) return true;
  return /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i.test(text)
    || /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i.test(text)
    || /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|cookie|secret|authorization)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i.test(text)
    || /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(text)
    || /\b(?:sk|xai|ghp|github_pat|AKIA)[-_A-Za-z0-9]{12,}\b/.test(text);
}

function isDirectiveLike(value: string): boolean {
  const normalized = normalizeForMatching(value);
  const authorityTerm = String.raw`(?:you|assistant|asistente|assistente|voce|tu|usted|system|developer|model|modelo|sistema|desarrollador)`;
  const instructionPhrase = String.raw`(?:these|this|estas?|estos?)\s+(?:instructions?|instrucciones?|instrucoes?)`;
  const sensitiveRevealPhrase = String.raw`(?:do not|dont|nao|no)\s+(?:reveal|revele|reveles|share|compartilhe|compartas)\b[\s,:-]{0,12}(?:these|this|estas?|estos?)\s+(?:instructions?|instrucciones?|instrucoes?|prompts?|mensajes?|mensagens?)`;
  return /\b(?:ignore|disregard|override|desconsidere|ignora|omite)\s+(?:all\s+)?(?:the\s+|las?\s+|los\s+|as\s+|os\s+)?(?:previous|prior|earlier|previas?|previos?|anteriores?|system|developer|sistema|desarrollador)\s+(?:instructions?|messages?|prompts?|instrucciones?|instrucoes?|mensajes?|mensagens?)\b/u.test(normalized)
    || /\b(?:ignore|disregard|override|desconsidere|ignora|omite)\s+(?:all\s+)?(?:the\s+|las?\s+|los\s+|as\s+|os\s+)?(?:instructions?|messages?|prompts?|instrucciones?|instrucoes?|mensajes?|mensagens?)\s+(?:previous|prior|earlier|previas?|previos?|anteriores?|system|developer|sistema|desarrollador)\b/u.test(normalized)
    || /\b(?:system|developer|sistema|desarrollador)\s*:\s*(?:you|assistant|asistente|voce|tu|usted|must|should|deve|debes|no|nao|follow|siga|sigue)\b/u.test(normalized)
    || /<\/?(?:system|developer|instruction|instructions|policy|policies|sistema|desarrollador|instrucciones?|instrucoes?|politica|politicas)\b/u.test(normalized)
    || /\b(?:you|assistant|asistente|voce|tu|usted)\s+(?:must|should|deve|debes|deberias?)\s+(?:follow|ignore|obey|reveal|share|siga|sigue|ignora|obedeca|obedece|revela|reveles|compartilhe|compartas)\b/u.test(normalized)
    || new RegExp(String.raw`\b${sensitiveRevealPhrase}\b`, "u").test(normalized)
    || new RegExp(String.raw`\b${authorityTerm}\b[\s,:-]{0,12}(?:please\s+|por favor\s+)?(?:follow|siga|sigue)\s+${instructionPhrase}\b`, "u").test(normalized)
    || new RegExp(String.raw`\b(?:follow|siga|sigue)\s+${instructionPhrase}\b[\s,:-]{0,12}\b${authorityTerm}\b`, "u").test(normalized);
}

export function assertNoMemoryInstructionContent(value: unknown): void {
  const text = typeof value === "string" ? value : stringifyJson(value);
  if (isDirectiveLike(text)) throw new Error("conteúdo com instruções externas não é memória");
}

function validKind(value: unknown): value is MemoryKind {
  return value === "identity" || value === "preference" || value === "constraint" || value === "decision"
    || value === "fact" || value === "procedure" || value === "open_loop";
}

function validTrust(value: unknown): value is MemoryTrust {
  return value === "user" || value === "verified_tool" || value === "external_observation";
}

function validSourceEntry(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0 && byteLength(value) <= MEMORY_POLICY_LIMITS.sourceEntryIdBytes;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => key === "conversationId" || key === "entryId")
    && typeof record.conversationId === "string"
    && record.conversationId.trim().length > 0
    && byteLength(record.conversationId) <= MEMORY_POLICY_LIMITS.sourceEntryIdBytes
    && typeof record.entryId === "string"
    && record.entryId.trim().length > 0
    && byteLength(record.entryId) <= MEMORY_POLICY_LIMITS.sourceEntryIdBytes;
}

const CANDIDATE_KEYS = new Set([
  "id", "agentId", "kind", "canonicalKey", "text", "trust", "valueJson", "status", "importance", "confidence", "pinned",
  "sourceConversationId", "sourceEntryIds", "validFromMs", "validToMs", "expiresAtMs", "nowMs",
]);

function toSafeInput(candidate: ReflectionCandidate): MemoryUpsertInput {
  return {
    kind: candidate.kind,
    canonicalKey: candidate.canonicalKey,
    text: candidate.text,
    valueJson: candidate.valueJson ?? null,
    trust: candidate.trust,
    importance: candidate.importance ?? 50,
    confidence: candidate.confidence ?? 0.5,
    pinned: candidate.pinned ?? false,
    sourceConversationId: candidate.sourceConversationId ?? null,
    sourceEntryIds: [...(candidate.sourceEntryIds ?? [])] as MemoryUpsertInput["sourceEntryIds"],
    validFromMs: candidate.validFromMs,
    validToMs: candidate.validToMs,
    expiresAtMs: candidate.expiresAtMs,
  };
}

/**
 * Validates untrusted reflection output. Rejections are returned per item so a
 * single unsafe candidate does not discard safe memories from the same turn.
 */
export function validateReflectionCandidates(
  candidates: readonly unknown[],
  options?: MemoryPolicyOptions,
): PolicyValidationResult {
  const accepted: MemoryUpsertInput[] = [];
  const rejected: PolicyRejection[] = [];
  const maxItems = options?.maxItems ?? MEMORY_POLICY_LIMITS.reflectionItems;
  if (!Array.isArray(candidates)) throw new Error("candidatos de memória devem ser uma lista");
  if (candidates.length > maxItems) throw new Error(`limite de ${maxItems} memórias excedido`);
  candidates.forEach((raw, index) => {
    const candidate = raw as Partial<ReflectionCandidate>;
    const reject = (code: string, message: string) => rejected.push({ index, code, message });
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      reject("invalid_candidate", "candidato deve ser um objeto");
      return;
    }
    for (const key of Object.keys(candidate)) {
      if (!CANDIDATE_KEYS.has(key)) {
        reject("extra_field", `campo não suportado: ${key}`);
        return;
      }
    }
    if (!validKind(candidate.kind) || typeof candidate.canonicalKey !== "string" || typeof candidate.text !== "string" || !validTrust(candidate.trust)) {
      reject("invalid_shape", "kind, canonicalKey, text e trust são obrigatórios");
      return;
    }
    if (candidate.pinned === true && options?.allowPinned === false) {
      reject("pinned_forbidden", "reflection automática nunca pode criar memórias pinned");
      return;
    }
    if (candidate.trust === "user" && options?.allowUserTrust === false) {
      reject("user_trust_requires_intent", "trust:user exige pedido explícito do usuário para memorizar");
      return;
    }
    const serialized = `${candidate.canonicalKey}\n${candidate.text}\n${stringifyJson(candidate.valueJson)}`;
    try {
      assertNoMemoryInstructionContent(serialized);
    } catch {
      reject("external_directive", "conteúdo com instruções externas não é memória");
      return;
    }
    if (containsSensitiveSecret(serialized, options)) {
      reject("secret", "segredos e credenciais não podem ser persistidos");
      return;
    }
    if (byteLength(candidate.canonicalKey) === 0 || byteLength(candidate.canonicalKey) > MEMORY_POLICY_LIMITS.canonicalKeyBytes) {
      reject("canonical_key_limit", "canonicalKey excede o limite");
      return;
    }
    if (byteLength(candidate.text) === 0 || byteLength(candidate.text) > MEMORY_POLICY_LIMITS.textBytes) {
      reject("text_limit", "text excede o limite");
      return;
    }
    const valueJson = stringifyJson(candidate.valueJson ?? null);
    if (byteLength(valueJson) > MEMORY_POLICY_LIMITS.valueJsonBytes) {
      reject("value_limit", "valueJson excede o limite");
      return;
    }
    if (candidate.sourceEntryIds !== undefined && (!Array.isArray(candidate.sourceEntryIds) || candidate.sourceEntryIds.length > MEMORY_POLICY_LIMITS.sourceEntryIds)) {
      reject("source_limit", "sourceEntryIds excede o limite");
      return;
    }
    if (candidate.sourceEntryIds?.some((source) => !validSourceEntry(source))) {
      reject("source_invalid", "sourceEntryIds contém referência inválida");
      return;
    }
    if (candidate.importance !== undefined && (!Number.isInteger(candidate.importance) || candidate.importance < 0 || candidate.importance > 100)) {
      reject("importance", "importance deve estar entre 0 e 100");
      return;
    }
    if (candidate.confidence !== undefined && (typeof candidate.confidence !== "number" || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1)) {
      reject("confidence", "confidence deve estar entre 0 e 1");
      return;
    }
    accepted.push(toSafeInput(candidate as ReflectionCandidate));
  });
  return { accepted, rejected };
}

/** Singular convenience used by the SQLite store and callers that want a hard gate. */
export function validateMemoryCandidate(candidate: unknown, options?: MemoryPolicyOptions): MemoryUpsertInput {
  const result = validateReflectionCandidates([candidate], options);
  const rejection = result.rejected[0];
  if (rejection !== undefined) throw new Error(`${rejection.code}: ${rejection.message}`);
  return result.accepted[0]!;
}

export const validateReflectionCandidate = validateMemoryCandidate;

export function assertNoSensitiveMemoryContent(value: unknown, options?: MemoryPolicyOptions): void {
  if (containsSensitiveSecret(value, options)) throw new Error("memória contém segredo ou credencial");
}
