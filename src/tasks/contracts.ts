import { win32 as windowsPath } from "node:path";

export type AsyncTaskStatus =
  | "queued"
  | "admitted"
  | "running"
  | "retry_wait"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned";

export type AsyncTaskContractErrorCode =
  | "invalid_transition"
  | "invalid_nonce"
  | "capability_denied"
  | "budget_exhausted"
  | "invalid_contract";

export class AsyncTaskContractError extends Error {
  constructor(
    public readonly code: AsyncTaskContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AsyncTaskContractError";
  }
}

export const DELEGATED_CAPABILITY_KINDS = [
  "provider",
  "filesystem",
  "process",
  "browser",
  "mcp",
  "skill",
] as const;
export type DelegatedCapabilityKind = (typeof DELEGATED_CAPABILITY_KINDS)[number];

export const MAX_DELEGATED_GRANT_STRING_BYTES = 4096;
export const MAX_DELEGATED_GRANT_ARRAY_ITEMS = 128;

/**
 * Namespaced opaque keystore identifier, never credential material. Its
 * existence is resolved by the effect boundary (P0.3B), not by this contract.
 */
export interface OpaqueSecretReference {
  readonly secretRef: string;
}

export interface ProviderGrantConstraints {
  readonly adapters: readonly string[];
  readonly models: readonly string[];
  readonly credentialRefs: readonly OpaqueSecretReference[];
  /** Explicit opt-in for providers that genuinely require no credential. */
  readonly allowNoCredential: boolean;
}

export type ProviderCredentialSelection =
  | { readonly kind: "secret_ref"; readonly secretRef: string }
  | { readonly kind: "none" };

export type FilesystemGrantOperation = "read" | "write" | "list";
export interface FilesystemGrantConstraints {
  readonly operations: readonly FilesystemGrantOperation[];
  readonly roots: readonly string[];
}

export type ProcessGrantOperation = "run";
export type ProcessGrantNetworkProfile = "none" | "host";
export interface ProcessGrantConstraints {
  readonly operations: readonly ProcessGrantOperation[];
  readonly executables: readonly string[];
  readonly cwdRoots: readonly string[];
  readonly networkProfiles: readonly ProcessGrantNetworkProfile[];
}

export type BrowserGrantCommandClass =
  | "navigate"
  | "observe"
  | "interact"
  | "input"
  | "upload"
  | "download"
  | "handoff";
export interface BrowserGrantConstraints {
  readonly commandClasses: readonly BrowserGrantCommandClass[];
  readonly origins: readonly string[];
  readonly partitionAgentId: string;
}

export interface McpToolGrant {
  readonly serverId: string;
  readonly toolName: string;
}
export interface McpGrantConstraints {
  /** Exact server/tool pairs. Legacy arrays are accepted only as a safely zipped migration shape. */
  readonly tools?: readonly McpToolGrant[];
  readonly serverIds?: readonly string[];
  readonly toolNames?: readonly string[];
}

export interface SkillGrantConstraints {
  readonly skillIds: readonly string[];
}

export interface DelegatedCapabilityGrantBase {
  readonly grantId: string;
  readonly taskId: string;
  readonly parentAgentId: string;
  readonly parentTurnId: string;
  readonly childRunId: string;
  readonly kind: DelegatedCapabilityKind;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt?: number;
  readonly version: number;
  readonly depth: 1;
}

export interface ProviderCapabilityGrant extends DelegatedCapabilityGrantBase {
  readonly kind: "provider";
  readonly constraints: ProviderGrantConstraints;
}
export interface FilesystemCapabilityGrant extends DelegatedCapabilityGrantBase {
  readonly kind: "filesystem";
  readonly constraints: FilesystemGrantConstraints;
}
export interface ProcessCapabilityGrant extends DelegatedCapabilityGrantBase {
  readonly kind: "process";
  readonly constraints: ProcessGrantConstraints;
}
export interface BrowserCapabilityGrant extends DelegatedCapabilityGrantBase {
  readonly kind: "browser";
  readonly constraints: BrowserGrantConstraints;
}
export interface McpCapabilityGrant extends DelegatedCapabilityGrantBase {
  readonly kind: "mcp";
  readonly constraints: McpGrantConstraints;
}
export interface SkillCapabilityGrant extends DelegatedCapabilityGrantBase {
  readonly kind: "skill";
  readonly constraints: SkillGrantConstraints;
}

export type DelegatedCapabilityGrant =
  | ProviderCapabilityGrant
  | FilesystemCapabilityGrant
  | ProcessCapabilityGrant
  | BrowserCapabilityGrant
  | McpCapabilityGrant
  | SkillCapabilityGrant;

export type DelegatedCapabilityOperation =
  | {
      readonly kind: "provider";
      readonly adapter: string;
      readonly model: string;
      readonly credential: ProviderCredentialSelection;
    }
  | { readonly kind: "filesystem"; readonly operation: FilesystemGrantOperation; readonly path: string }
  | {
      readonly kind: "process";
      readonly operation: ProcessGrantOperation;
      readonly executable: string;
      readonly cwd: string;
      readonly networkProfile: ProcessGrantNetworkProfile;
    }
  | {
      readonly kind: "browser";
      readonly commandClass: BrowserGrantCommandClass;
      readonly origin: string;
      readonly partitionAgentId: string;
    }
  | { readonly kind: "mcp"; readonly serverId: string; readonly toolName: string }
  | { readonly kind: "skill"; readonly skillId: string };

export interface GrantOperationContext {
  readonly now: number;
  readonly currentVersion: number;
  readonly expectedGrantId: string;
  readonly taskId: string;
  readonly parentAgentId: string;
  readonly parentTurnId: string;
  readonly childRunId: string;
}

export interface SubagentBudget {
  readonly maxWallMs: number;
  readonly maxProviderCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxToolRounds: number;
  readonly maxToolCalls: number;
  readonly maxMcpCalls: number;
  readonly maxBrowserCommands: number;
  readonly maxResultBytes: number;
  readonly maxWorkspaceWriteBytes: number;
  readonly maxDepth: 1;
}

/** Same dimensions as a budget, but each remaining value may be zero. */
export interface SubagentBudgetRemaining {
  readonly maxWallMs: number;
  readonly maxProviderCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxToolRounds: number;
  readonly maxToolCalls: number;
  readonly maxMcpCalls: number;
  readonly maxBrowserCommands: number;
  readonly maxResultBytes: number;
  readonly maxWorkspaceWriteBytes: number;
  readonly maxDepth: 1;
}

export interface BudgetCounters {
  readonly providerCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolRounds: number;
  readonly toolCalls: number;
  readonly mcpCalls: number;
  readonly browserCommands: number;
  readonly resultBytes: number;
  readonly workspaceWriteBytes: number;
}

export interface BudgetReservation {
  readonly reservationId: string;
  readonly amounts: BudgetCounters;
}

export interface SubagentBudgetUsage {
  readonly used: BudgetCounters;
  readonly reserved: BudgetCounters;
  readonly reservations: readonly BudgetReservation[];
}

export interface LimitedTaskResult {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

export type AsyncTaskKind = "subagent";

/** Immutable, deliberately text-only input captured at dispatch time. */
export interface TaskInputV1 {
  readonly version: 1;
  readonly objective: string;
  readonly source: {
    readonly kind: "parent_turn";
    readonly agentId: string;
    readonly conversationId?: string;
    readonly turnEntryId?: string;
  };
}

export const MAX_TASK_OBJECTIVE_BYTES = 32 * 1024;

export interface AsyncTaskLineage {
  readonly parentAgentId: string;
  readonly parentTurnId: string;
  readonly parentTaskId: string | null;
  readonly childRunId: string;
  readonly depth: 1;
}

export interface AsyncTaskLease {
  readonly ownerId: string;
  readonly expiresAtMs: number;
  readonly attempt: number;
  readonly version: number;
}

export interface AsyncTaskProgress {
  readonly phase: string;
  readonly summary: string;
  readonly completedUnits: number | null;
  readonly totalUnits: number | null;
  readonly updatedAtMs: number;
}

export type AsyncTaskResult =
  | {
      readonly kind: "inline";
      readonly text: string;
      readonly bytes: number;
      readonly truncated: boolean;
    }
  | {
      readonly kind: "ref";
      readonly resultRef: string;
      readonly bytes: number;
      readonly truncated: boolean;
    };

export type AsyncTaskFailureCode =
  | "budget_exhausted"
  | "capability_denied"
  | "aborted"
  | "provider_error"
  | "tool_error"
  | "invalid_result"
  | "internal_error";

export interface AsyncTaskFailure {
  readonly code: AsyncTaskFailureCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface AsyncTaskSteerIntent {
  readonly intentId: string;
  readonly version: number;
  readonly requestedAtMs: number;
  readonly message: string;
  readonly consumedAtMs: number | null;
}

export type AsyncTaskAbortReason = "user" | "parent" | "shutdown" | "budget_exhausted";
export interface AsyncTaskAbortIntent {
  readonly intentId: string;
  readonly version: number;
  readonly requestedAtMs: number;
  readonly reason: AsyncTaskAbortReason;
  readonly consumedAtMs: number | null;
}

export interface AsyncTaskRecord {
  readonly taskId: string;
  readonly agentId: string;
  readonly parentTurnId: string;
  readonly kind: AsyncTaskKind;
  readonly status: AsyncTaskStatus;
  readonly attempt: number;
  readonly version: number;
  readonly clientNonce: string;
  readonly depth: 1;
  readonly createdAtMs: number;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly settledAtMs: number | null;
  readonly nextAttemptAtMs: number | null;
  readonly lease: AsyncTaskLease | null;
  readonly progress: AsyncTaskProgress | null;
  readonly result: AsyncTaskResult | null;
  readonly error: AsyncTaskFailure | null;
  readonly steerIntent: AsyncTaskSteerIntent | null;
  readonly steerVersion: number;
  readonly abortIntent: AsyncTaskAbortIntent | null;
  readonly abortVersion: number;
  readonly lineage: AsyncTaskLineage;
  readonly input: TaskInputV1;
}

export interface AsyncTaskAttemptRecord {
  readonly attemptId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly status: AsyncTaskStatus;
  readonly version: number;
  readonly createdAtMs: number;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly lease: AsyncTaskLease | null;
  readonly error: AsyncTaskFailure | null;
}

export type AsyncTaskWakeKind =
  | "task_created"
  | "task_progress"
  | "task_terminal"
  | "task_steer"
  | "task_abort"
  | "task_recovered";

export interface AsyncTaskWakePayload {
  readonly status: AsyncTaskStatus;
  readonly attempt: number;
  readonly summary: string | null;
  readonly code: AsyncTaskFailureCode | null;
  readonly resultRef: string | null;
}

export interface AsyncTaskOutboxEvent {
  readonly outboxId: string;
  readonly taskId: string;
  readonly transitionVersion: number;
  readonly wakeKind: AsyncTaskWakeKind;
  readonly payload: AsyncTaskWakePayload;
  readonly createdAtMs: number;
  readonly deliveredAtMs: number | null;
}

export interface AsyncTaskProjectionEnvelope {
  readonly epoch: string;
  readonly sequence: number;
  readonly agentId: string;
  readonly taskId: string;
  readonly snapshotVersion: number;
  readonly channel: "async-tasks" | "subagents";
  readonly kind: AsyncTaskWakeKind;
  readonly payload: AsyncTaskWakePayload;
  readonly projectionId: string;
}

export interface DispatchAsyncTaskInput {
  readonly taskId: string;
  readonly agentId: string;
  readonly parentTurnId: string;
  readonly kind: AsyncTaskKind;
  readonly clientNonce: string;
  readonly createdAtMs: number;
  readonly lineage: AsyncTaskLineage;
  readonly grant: DelegatedCapabilityGrant;
  readonly budget: SubagentBudget;
  /** Durable cap inherited from the parent turn; omitted only for legacy direct callers. */
  readonly parentBudget?: SubagentBudget;
  /** Canonical immutable task input. Legacy persisted rows are migrated at schema-open time. */
  readonly input: TaskInputV1;
}

export interface DispatchAsyncTaskResult {
  readonly task: AsyncTaskRecord;
  readonly created: boolean;
}

export interface ClaimAsyncTaskInput {
  readonly ownerId: string;
  readonly nowMs: number;
  readonly leaseDurationMs: number;
}

export interface ClaimAsyncTaskResult {
  readonly task: AsyncTaskRecord;
  readonly attempt: AsyncTaskAttemptRecord;
  readonly lease: AsyncTaskLease;
}

export type AsyncTaskTerminalStatus = "completed" | "failed" | "cancelled";
export interface CommitAsyncTaskTerminalInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly leaseOwnerId: string;
  readonly attempt: number;
  readonly status: AsyncTaskTerminalStatus;
  readonly finishedAtMs: number;
  readonly result: AsyncTaskResult | null;
  readonly error: AsyncTaskFailure | null;
  readonly wakeKind: "task_terminal";
  readonly wakePayload: AsyncTaskWakePayload;
}

export interface CommitAsyncTaskTerminalResult {
  readonly task: AsyncTaskRecord;
  readonly attempt: AsyncTaskAttemptRecord;
  readonly outboxEvent: AsyncTaskOutboxEvent;
}

type UnknownObject = { [key: string]: unknown };

function invalidContract(message: string): never {
  throw new AsyncTaskContractError("invalid_contract", message);
}

function taskIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || /\p{Cc}/u.test(value)) invalidContract(`${name} is invalid.`);
  if (hasLoneSurrogate(value)) invalidContract(`${name} is invalid.`);
  const normalized = value.normalize("NFC");
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > 256) invalidContract(`${name} is invalid.`);
  return normalized;
}

function hasLoneSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

/** Parse and canonicalize the immutable text-only task input boundary. */
export function parseTaskInputV1(value: unknown): TaskInputV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidContract("Task input must be an object.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["version", "objective", "source"].includes(key))) invalidContract("Task input contains an unsupported field.");
  if (input.version !== 1 || typeof input.objective !== "string") invalidContract("Task input version/objective is invalid.");
  const objective = input.objective.normalize("NFC").trim();
  if (hasLoneSurrogate(input.objective) || objective.length === 0 || Buffer.byteLength(objective, "utf8") > MAX_TASK_OBJECTIVE_BYTES) {
    invalidContract("Task objective must be valid NFC text between 1 and 32768 UTF-8 bytes.");
  }
  // Text-only means no secret-bearing prompt-shaped values. Actual configured
  // secret values are checked again by AsyncTaskStore before persistence.
  if (/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|cookie|authorization|bearer\s+|sk-[A-Za-z0-9_-]{8,})/iu.test(objective)) {
    invalidContract("Task objective appears to contain secret material.");
  }
  if (typeof input.source !== "object" || input.source === null || Array.isArray(input.source)) invalidContract("Task input source is invalid.");
  const source = input.source as Record<string, unknown>;
  if (Object.keys(source).some((key) => !["kind", "agentId", "conversationId", "turnEntryId"].includes(key))) invalidContract("Task input source contains an unsupported field.");
  if (source.kind !== "parent_turn") invalidContract("Task input source kind is invalid.");
  const agentId = taskIdentifier(source.agentId, "Task input source agentId");
  const conversationId = source.conversationId === undefined ? undefined : taskIdentifier(source.conversationId, "Task input source conversationId");
  const turnEntryId = source.turnEntryId === undefined ? undefined : taskIdentifier(source.turnEntryId, "Task input source turnEntryId");
  return {
    version: 1,
    objective,
    source: {
      kind: "parent_turn",
      agentId,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(turnEntryId === undefined ? {} : { turnEntryId }),
    },
  };
}

function objectValue(value: unknown, name: string): UnknownObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidContract(`${name} must be an object.`);
  return value as UnknownObject;
}

function exactFields(value: UnknownObject, fields: readonly string[], name: string): void {
  const allowed = new Set(fields);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalidContract(`${name} contains an unsupported field.`);
}

function assertNoInlineSecretFields(value: unknown, seen = new WeakSet()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertNoInlineSecretFields(entry, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[-_]/gu, "");
    if (normalized !== "secretref" && ["token", "apikey", "cookie", "secret"].includes(normalized)) {
      invalidContract("Inline secret fields are forbidden in delegated grants.");
    }
    assertNoInlineSecretFields(entry, seen);
  }
}

function boundedString(value: unknown, name: string, maxBytes = MAX_DELEGATED_GRANT_STRING_BYTES): string {
  if (typeof value !== "string" || /\p{Cc}/u.test(value)) invalidContract(`${name} is invalid.`);
  const normalized = value.trim().normalize("NFC");
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > maxBytes) invalidContract(`${name} is invalid.`);
  return normalized;
}

function safeInteger(value: unknown, name: string, allowZero: boolean): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    invalidContract(`${name} must be a safe ${allowZero ? "non-negative" : "positive"} integer.`);
  }
  return value;
}

function deterministicStrings<T extends string>(values: readonly T[], caseInsensitive = false): T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    const key = caseInsensitive ? value.toLowerCase() : value;
    if (!unique.has(key)) unique.set(key, value);
  }
  return [...unique.values()].sort((left, right) => left.localeCompare(right, "en", { sensitivity: caseInsensitive ? "base" : "variant" }));
}

function stringArray<T extends string>(
  value: unknown,
  name: string,
  allowed?: readonly T[],
  normalize: (entry: string) => string = (entry) => entry,
): T[] {
  if (!Array.isArray(value) || value.length > MAX_DELEGATED_GRANT_ARRAY_ITEMS) invalidContract(`${name} is invalid.`);
  const output = value.map((entry) => normalize(boundedString(entry, `${name} item`)));
  if (allowed !== undefined && output.some((entry) => !(allowed as readonly string[]).includes(entry))) invalidContract(`${name} is invalid.`);
  return deterministicStrings(output as T[]);
}

function mcpLegacyArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_DELEGATED_GRANT_ARRAY_ITEMS) invalidContract(`${name} is invalid.`);
  return value.map((entry) => boundedString(entry, `${name} item`));
}

function normalizeWindowsRoot(value: string): string {
  if (!windowsPath.isAbsolute(value) || (!/^[A-Za-z]:[\\/]/u.test(value) && !/^\\\\[^\\]+\\[^\\]+/u.test(value))) {
    invalidContract("A delegated root must be an absolute Windows path.");
  }
  const normalized = windowsPath.normalize(value).replace(/^([a-z]):/iu, (_match, drive: string) => `${drive.toUpperCase()}:`);
  const parsedRoot = windowsPath.parse(normalized).root;
  return normalized.length > parsedRoot.length ? normalized.replace(/[\\/]+$/u, "") : normalized;
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalidContract("Browser origin is invalid.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "" || parsed.origin === "null") {
    invalidContract("Browser origin is invalid.");
  }
  return parsed.origin;
}

export function parseDelegatedWindowsPath(value: unknown): string {
  return normalizeWindowsRoot(boundedString(value, "delegated Windows path"));
}

export function parseDelegatedBrowserOrigin(value: unknown): string {
  return normalizeOrigin(boundedString(value, "delegated browser origin"));
}

export function mcpGrantTools(constraints: McpGrantConstraints): McpToolGrant[] {
  if (constraints.tools !== undefined) return constraints.tools.map((tool) => ({ serverId: tool.serverId, toolName: tool.toolName }));
  const serverIds = constraints.serverIds ?? [];
  const toolNames = constraints.toolNames ?? [];
  if (serverIds.length !== toolNames.length) return [];
  return serverIds.map((serverId, index) => ({ serverId, toolName: toolNames[index]! }));
}

function credentialReferences(value: unknown): OpaqueSecretReference[] {
  if (!Array.isArray(value) || value.length > MAX_DELEGATED_GRANT_ARRAY_ITEMS) invalidContract("credentialRefs is invalid.");
  const refs = value.map((entry) => {
    const object = objectValue(entry, "credentialRef");
    exactFields(object, ["secretRef"], "credentialRef");
    const secretRef = boundedString(object.secretRef, "secretRef");
    if (!/^[a-z][a-z0-9._-]*\/[a-z][a-z0-9._-]*(?:\/[a-z][a-z0-9._-]*)*$/u.test(secretRef)) {
      invalidContract("secretRef must be a canonical namespaced keystore identifier");
    }
    return { secretRef };
  });
  const unique = new Map(refs.map((entry) => [entry.secretRef, entry]));
  return [...unique.values()].sort((left, right) => left.secretRef.localeCompare(right.secretRef));
}

const BASE_GRANT_FIELDS = [
  "grantId",
  "taskId",
  "parentAgentId",
  "parentTurnId",
  "childRunId",
  "kind",
  "constraints",
  "issuedAt",
  "expiresAt",
  "revokedAt",
  "version",
  "depth",
] as const;

function parseGrantBase(value: UnknownObject): DelegatedCapabilityGrantBase {
  const kind = boundedString(value.kind, "kind");
  if (!(DELEGATED_CAPABILITY_KINDS as readonly string[]).includes(kind)) invalidContract("Grant kind is invalid.");
  const issuedAt = safeInteger(value.issuedAt, "issuedAt", true);
  const expiresAt = safeInteger(value.expiresAt, "expiresAt", false);
  if (expiresAt <= issuedAt) invalidContract("Grant expiry must be after issuance.");
  const revokedAt = value.revokedAt === undefined ? undefined : safeInteger(value.revokedAt, "revokedAt", true);
  if (revokedAt !== undefined && (revokedAt < issuedAt || revokedAt > expiresAt)) {
    invalidContract("Grant revocation must fall within the grant lifetime.");
  }
  if (value.depth !== 1) invalidContract("Delegated grant depth must be exactly one.");
  return {
    grantId: boundedString(value.grantId, "grantId", 256),
    taskId: boundedString(value.taskId, "taskId", 256),
    parentAgentId: boundedString(value.parentAgentId, "parentAgentId", 256),
    parentTurnId: boundedString(value.parentTurnId, "parentTurnId", 256),
    childRunId: boundedString(value.childRunId, "childRunId", 256),
    kind: kind as DelegatedCapabilityKind,
    issuedAt,
    expiresAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
    version: safeInteger(value.version, "version", false),
    depth: 1,
  };
}

export function parseDelegatedCapabilityGrant(value: unknown): DelegatedCapabilityGrant {
  assertNoInlineSecretFields(value);
  const input = objectValue(value, "grant");
  exactFields(input, BASE_GRANT_FIELDS, "grant");
  const base = parseGrantBase(input);
  const constraints = objectValue(input.constraints, "constraints");
  switch (base.kind) {
    case "provider":
      exactFields(constraints, ["adapters", "models", "credentialRefs", "allowNoCredential"], "provider constraints");
      if (constraints.allowNoCredential !== undefined && typeof constraints.allowNoCredential !== "boolean") {
        invalidContract("allowNoCredential must be boolean.");
      }
      return {
        ...base,
        kind: "provider",
        constraints: {
          adapters: stringArray(constraints.adapters, "adapters"),
          models: stringArray(constraints.models, "models"),
          credentialRefs: credentialReferences(constraints.credentialRefs),
          allowNoCredential: constraints.allowNoCredential ?? false,
        },
      };
    case "filesystem":
      exactFields(constraints, ["operations", "roots"], "filesystem constraints");
      return {
        ...base,
        kind: "filesystem",
        constraints: {
          operations: stringArray(constraints.operations, "operations", ["read", "write", "list"] as const),
          roots: deterministicStrings(stringArray(constraints.roots, "roots", undefined, normalizeWindowsRoot), true),
        },
      };
    case "process":
      exactFields(constraints, ["operations", "executables", "cwdRoots", "networkProfiles"], "process constraints");
      return {
        ...base,
        kind: "process",
        constraints: {
          operations: stringArray(constraints.operations, "operations", ["run"] as const),
          executables: deterministicStrings(stringArray(constraints.executables, "executables"), true),
          cwdRoots: deterministicStrings(stringArray(constraints.cwdRoots, "cwdRoots", undefined, normalizeWindowsRoot), true),
          networkProfiles: stringArray(constraints.networkProfiles, "networkProfiles", ["none", "host"] as const),
        },
      };
    case "browser": {
      exactFields(constraints, ["commandClasses", "origins", "partitionAgentId"], "browser constraints");
      const partitionAgentId = boundedString(constraints.partitionAgentId, "partitionAgentId", 256);
      if (partitionAgentId !== base.parentAgentId) invalidContract("Browser partition must be bound to the parent agent.");
      return {
        ...base,
        kind: "browser",
        constraints: {
          commandClasses: stringArray(constraints.commandClasses, "commandClasses", ["navigate", "observe", "interact", "input", "upload", "download", "handoff"] as const),
          origins: deterministicStrings(stringArray(constraints.origins, "origins", undefined, normalizeOrigin)),
          partitionAgentId,
        },
      };
    }
    case "mcp": {
      const allowedFields = new Set(["tools", "serverIds", "toolNames"]);
      if (Object.keys(constraints).some((key) => !allowedFields.has(key))) invalidContract("mcp constraints has an invalid shape.");
      const parsedTools: Array<{ serverId: string; toolName: string }> = constraints.tools === undefined
        ? (() => {
          if (constraints.serverIds === undefined || constraints.toolNames === undefined) invalidContract("mcp tools are required.");
          const serverIds = mcpLegacyArray(constraints.serverIds, "serverIds");
          const toolNames = mcpLegacyArray(constraints.toolNames, "toolNames");
          if (serverIds.length !== toolNames.length) invalidContract("mcp server/tool arrays must have matching lengths.");
          return serverIds.map((serverId, index) => ({ serverId, toolName: toolNames[index]! }));
        })()
        : (() => {
          if (!Array.isArray(constraints.tools) || constraints.tools.length > MAX_DELEGATED_GRANT_ARRAY_ITEMS) invalidContract("tools is invalid.");
          return constraints.tools.map((entry) => {
            const tool = objectValue(entry, "mcp tool");
            exactFields(tool, ["serverId", "toolName"], "mcp tool");
            return { serverId: boundedString(tool.serverId, "serverId"), toolName: boundedString(tool.toolName, "toolName") };
          });
        })();
      const unique = new Map(parsedTools.map((tool) => [`${tool.serverId}\u0000${tool.toolName}`, tool]));
      const tools = [...unique.values()].sort((left, right) => left.serverId.localeCompare(right.serverId) || left.toolName.localeCompare(right.toolName));
      if (constraints.tools !== undefined && (constraints.serverIds !== undefined || constraints.toolNames !== undefined)) invalidContract("mcp constraints cannot mix exact tools with legacy arrays.");
      return { ...base, kind: "mcp", constraints: { tools } };
    }
    case "skill":
      exactFields(constraints, ["skillIds"], "skill constraints");
      return { ...base, kind: "skill", constraints: { skillIds: stringArray(constraints.skillIds, "skillIds") } };
  }
}
