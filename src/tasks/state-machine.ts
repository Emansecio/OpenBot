import { win32 as windowsPath } from "node:path";

import {
  AsyncTaskContractError,
  parseDelegatedBrowserOrigin,
  parseDelegatedCapabilityGrant,
  parseDelegatedWindowsPath,
  mcpGrantTools,
  type AsyncTaskStatus,
  type BrowserGrantCommandClass,
  type BudgetCounters,
  type BudgetReservation,
  type DelegatedCapabilityGrant,
  type DelegatedCapabilityOperation,
  type FilesystemGrantOperation,
  type GrantOperationContext,
  type LimitedTaskResult,
  type OpaqueSecretReference,
  type ProcessGrantNetworkProfile,
  type ProcessGrantOperation,
  type SubagentBudget,
  type SubagentBudgetRemaining,
  type SubagentBudgetUsage,
} from "./contracts.js";

const TRANSITIONS: Readonly<Record<AsyncTaskStatus, ReadonlySet<AsyncTaskStatus>>> = {
  queued: new Set(["admitted", "cancelled"]),
  admitted: new Set(["running", "cancelling", "abandoned"]),
  running: new Set(["completed", "failed", "retry_wait", "cancelling", "abandoned"]),
  retry_wait: new Set(["admitted", "failed", "cancelled"]),
  cancelling: new Set(["cancelled", "abandoned"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  abandoned: new Set(["retry_wait", "failed", "cancelled"]),
};

/** Maximum UTF-8 size accepted for a persisted caller idempotency nonce. */
export const MAX_TASK_CLIENT_NONCE_BYTES = 256;

export function assertTaskTransition(from: AsyncTaskStatus, to: AsyncTaskStatus): void {
  if (!TRANSITIONS[from].has(to)) {
    throw new AsyncTaskContractError("invalid_transition", `Task transition ${from} -> ${to} is not allowed.`);
  }
}

export function requireTaskClientNonce(value: unknown): string {
  if (typeof value !== "string" || /\p{Cc}/u.test(value)) {
    throw new AsyncTaskContractError("invalid_nonce", "Task client nonce is invalid.");
  }
  const normalized = value.trim().normalize("NFC");
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > MAX_TASK_CLIENT_NONCE_BYTES) {
    throw new AsyncTaskContractError("invalid_nonce", "Task client nonce is invalid.");
  }
  return normalized;
}

function capabilityDenied(): never {
  throw new AsyncTaskContractError("capability_denied", "Delegated capability does not authorize this operation.");
}

function deterministicStrings<T extends string>(values: readonly T[], caseInsensitive = false): T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    const key = caseInsensitive ? value.toLowerCase() : value;
    if (!unique.has(key)) unique.set(key, value);
  }
  return [...unique.values()].sort((left, right) => left.localeCompare(right, "en", { sensitivity: caseInsensitive ? "base" : "variant" }));
}

function stringIntersection(...arrays: readonly (readonly string[])[]): string[] {
  const [first, ...rest] = arrays;
  if (first === undefined) return [];
  return deterministicStrings(first.filter((entry) => rest.every((items) => items.includes(entry))));
}

function windowsPathWithin(root: string, candidate: string): boolean {
  const relative = windowsPath.relative(root, candidate);
  return relative === "" || (!windowsPath.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${windowsPath.sep}`));
}

function intersectRootPair(left: readonly string[], right: readonly string[]): string[] {
  const intersections: string[] = [];
  for (const leftRoot of left) {
    for (const rightRoot of right) {
      if (windowsPathWithin(leftRoot, rightRoot)) intersections.push(rightRoot);
      else if (windowsPathWithin(rightRoot, leftRoot)) intersections.push(leftRoot);
    }
  }
  return deterministicStrings(intersections, true);
}

function rootIntersection(...arrays: readonly (readonly string[])[]): string[] {
  const [first, ...rest] = arrays;
  if (first === undefined) return [];
  let current = [...first];
  for (const next of rest) current = intersectRootPair(current, next);
  return current;
}

function credentialIntersection(...arrays: readonly (readonly OpaqueSecretReference[])[]): OpaqueSecretReference[] {
  const refs = stringIntersection(...arrays.map((entries) => entries.map((entry) => entry.secretRef)));
  return refs.map((secretRef) => ({ secretRef }));
}

function mcpToolIntersection(...constraints: readonly import("./contracts.js").McpGrantConstraints[]): import("./contracts.js").McpToolGrant[] {
  const [first, ...rest] = constraints;
  if (first === undefined) return [];
  const allowed = new Set(rest.flatMap((constraint) => mcpGrantTools(constraint).map((tool) => `${tool.serverId}\u0000${tool.toolName}`)));
  return mcpGrantTools(first)
    .filter((tool) => rest.every((constraint) => allowed.has(`${tool.serverId}\u0000${tool.toolName}`) && mcpGrantTools(constraint).some((candidate) => candidate.serverId === tool.serverId && candidate.toolName === tool.toolName)))
    .sort((left, right) => left.serverId.localeCompare(right.serverId) || left.toolName.localeCompare(right.toolName));
}

function activeGrant(grant: DelegatedCapabilityGrant, now: number): boolean {
  return grant.issuedAt <= now && grant.expiresAt > now && (grant.revokedAt === undefined || grant.revokedAt > now);
}

function earliestRevocation(...grants: readonly DelegatedCapabilityGrant[]): number | undefined {
  const boundaries = grants
    .map((grant) => grant.revokedAt)
    .filter((value): value is number => value !== undefined);
  return boundaries.length === 0 ? undefined : Math.min(...boundaries);
}

function sameGrantAuthority(left: DelegatedCapabilityGrant, right: DelegatedCapabilityGrant): boolean {
  return left.kind === right.kind &&
    left.taskId === right.taskId &&
    left.parentAgentId === right.parentAgentId &&
    left.parentTurnId === right.parentTurnId &&
    left.childRunId === right.childRunId;
}

function intersectGrantConstraints(
  requested: DelegatedCapabilityGrant,
  parent: DelegatedCapabilityGrant,
  policy: DelegatedCapabilityGrant,
): DelegatedCapabilityGrant["constraints"] {
  switch (requested.kind) {
    case "provider":
      if (parent.kind !== "provider" || policy.kind !== "provider") capabilityDenied();
      return {
        adapters: stringIntersection(requested.constraints.adapters, parent.constraints.adapters, policy.constraints.adapters),
        models: stringIntersection(requested.constraints.models, parent.constraints.models, policy.constraints.models),
        credentialRefs: credentialIntersection(requested.constraints.credentialRefs, parent.constraints.credentialRefs, policy.constraints.credentialRefs),
        allowNoCredential: requested.constraints.allowNoCredential && parent.constraints.allowNoCredential && policy.constraints.allowNoCredential,
      };
    case "filesystem":
      if (parent.kind !== "filesystem" || policy.kind !== "filesystem") capabilityDenied();
      return {
        operations: stringIntersection(requested.constraints.operations, parent.constraints.operations, policy.constraints.operations) as FilesystemGrantOperation[],
        roots: rootIntersection(requested.constraints.roots, parent.constraints.roots, policy.constraints.roots),
      };
    case "process":
      if (parent.kind !== "process" || policy.kind !== "process") capabilityDenied();
      return {
        operations: stringIntersection(requested.constraints.operations, parent.constraints.operations, policy.constraints.operations) as ProcessGrantOperation[],
        executables: deterministicStrings(stringIntersection(requested.constraints.executables.map((entry) => entry.toLowerCase()), parent.constraints.executables.map((entry) => entry.toLowerCase()), policy.constraints.executables.map((entry) => entry.toLowerCase())), true),
        cwdRoots: rootIntersection(requested.constraints.cwdRoots, parent.constraints.cwdRoots, policy.constraints.cwdRoots),
        networkProfiles: stringIntersection(requested.constraints.networkProfiles, parent.constraints.networkProfiles, policy.constraints.networkProfiles) as ProcessGrantNetworkProfile[],
      };
    case "browser":
      if (parent.kind !== "browser" || policy.kind !== "browser") capabilityDenied();
      if (requested.constraints.partitionAgentId !== requested.parentAgentId || parent.constraints.partitionAgentId !== requested.parentAgentId || policy.constraints.partitionAgentId !== requested.parentAgentId) capabilityDenied();
      return {
        commandClasses: stringIntersection(requested.constraints.commandClasses, parent.constraints.commandClasses, policy.constraints.commandClasses) as BrowserGrantCommandClass[],
        origins: stringIntersection(requested.constraints.origins, parent.constraints.origins, policy.constraints.origins),
        partitionAgentId: requested.parentAgentId,
      };
    case "mcp":
      if (parent.kind !== "mcp" || policy.kind !== "mcp") capabilityDenied();
      {
        const tools = mcpToolIntersection(requested.constraints, parent.constraints, policy.constraints);
        return { tools };
      }
    case "skill":
      if (parent.kind !== "skill" || policy.kind !== "skill") capabilityDenied();
      return { skillIds: stringIntersection(requested.constraints.skillIds, parent.constraints.skillIds, policy.constraints.skillIds) };
  }
}

export function deriveEffectiveGrant(
  requestedValue: unknown,
  parentCurrentValue: unknown,
  hardPolicyValue: unknown,
  now: number,
): DelegatedCapabilityGrant {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new AsyncTaskContractError("invalid_contract", "now must be a non-negative safe integer.");
  }
  const requested = parseDelegatedCapabilityGrant(requestedValue);
  const parentCurrent = parseDelegatedCapabilityGrant(parentCurrentValue);
  const hardPolicy = parseDelegatedCapabilityGrant(hardPolicyValue);
  if (!sameGrantAuthority(requested, parentCurrent) || !sameGrantAuthority(requested, hardPolicy)) capabilityDenied();
  if (requested.version !== parentCurrent.version || hardPolicy.version !== parentCurrent.version) capabilityDenied();
  if (![requested, parentCurrent, hardPolicy].every((grant) => activeGrant(grant, now))) capabilityDenied();
  const constraints = intersectGrantConstraints(requested, parentCurrent, hardPolicy);
  const revokedAt = earliestRevocation(requested, parentCurrent, hardPolicy);
  const effectiveExpiresAt = Math.min(requested.expiresAt, parentCurrent.expiresAt, hardPolicy.expiresAt);
  const { revokedAt: _requestedRevocation, ...requestedWithoutRevocation } = requested;
  return {
    ...requestedWithoutRevocation,
    issuedAt: Math.max(requested.issuedAt, parentCurrent.issuedAt, hardPolicy.issuedAt),
    expiresAt: effectiveExpiresAt,
    ...(revokedAt === undefined || revokedAt > effectiveExpiresAt ? {} : { revokedAt }),
    version: parentCurrent.version,
    constraints,
  } as DelegatedCapabilityGrant;
}

function includesIgnoreCase(values: readonly string[], value: string): boolean {
  const normalized = value.toLowerCase();
  return values.some((entry) => entry.toLowerCase() === normalized);
}

function providerCredentialAllowed(grant: Extract<DelegatedCapabilityGrant, { kind: "provider" }>, value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const selection = value as { [key: string]: unknown };
  if (selection.kind === "none") {
    return Object.keys(selection).length === 1 && grant.constraints.allowNoCredential;
  }
  if (selection.kind === "secret_ref") {
    return Object.keys(selection).length === 2 &&
      typeof selection.secretRef === "string" &&
      grant.constraints.credentialRefs.some((entry) => entry.secretRef === selection.secretRef);
  }
  return false;
}

export function assertGrantAllowsOperation(
  grantValue: DelegatedCapabilityGrant | undefined,
  operation: DelegatedCapabilityOperation,
  context: GrantOperationContext,
): void {
  if (grantValue === undefined || !Number.isSafeInteger(context.now) || !Number.isSafeInteger(context.currentVersion)) capabilityDenied();
  let grant: DelegatedCapabilityGrant;
  try {
    grant = parseDelegatedCapabilityGrant(grantValue);
  } catch {
    capabilityDenied();
  }
  if (
    !activeGrant(grant, context.now) ||
    grant.version !== context.currentVersion ||
    grant.grantId !== context.expectedGrantId ||
    grant.taskId !== context.taskId ||
    grant.parentAgentId !== context.parentAgentId ||
    grant.parentTurnId !== context.parentTurnId ||
    grant.childRunId !== context.childRunId ||
    grant.kind !== operation.kind
  ) capabilityDenied();
  try {
    switch (operation.kind) {
      case "provider":
        if (grant.kind !== "provider" || !grant.constraints.adapters.includes(operation.adapter) || !grant.constraints.models.includes(operation.model)) capabilityDenied();
        if (!providerCredentialAllowed(grant, operation.credential)) capabilityDenied();
        return;
      case "filesystem": {
        if (grant.kind !== "filesystem" || !grant.constraints.operations.includes(operation.operation)) capabilityDenied();
        const target = parseDelegatedWindowsPath(operation.path);
        if (!grant.constraints.roots.some((root) => windowsPathWithin(root, target))) capabilityDenied();
        return;
      }
      case "process": {
        if (grant.kind !== "process" || !grant.constraints.operations.includes(operation.operation) || !includesIgnoreCase(grant.constraints.executables, operation.executable) || !grant.constraints.networkProfiles.includes(operation.networkProfile)) capabilityDenied();
        const cwd = parseDelegatedWindowsPath(operation.cwd);
        if (!grant.constraints.cwdRoots.some((root) => windowsPathWithin(root, cwd))) capabilityDenied();
        return;
      }
      case "browser":
        if (grant.kind !== "browser" || operation.partitionAgentId !== grant.parentAgentId || operation.partitionAgentId !== grant.constraints.partitionAgentId || !grant.constraints.commandClasses.includes(operation.commandClass) || !grant.constraints.origins.includes(parseDelegatedBrowserOrigin(operation.origin))) capabilityDenied();
        return;
      case "mcp":
        if (grant.kind !== "mcp" || !mcpGrantTools(grant.constraints).some((tool) => tool.serverId === operation.serverId && tool.toolName === operation.toolName)) capabilityDenied();
        return;
      case "skill":
        if (grant.kind !== "skill" || !grant.constraints.skillIds.includes(operation.skillId)) capabilityDenied();
        return;
    }
  } catch (error) {
    if (error instanceof AsyncTaskContractError && error.code === "capability_denied") throw error;
    capabilityDenied();
  }
}

const BUDGET_FIELDS = [
  "maxWallMs",
  "maxProviderCalls",
  "maxInputTokens",
  "maxOutputTokens",
  "maxToolRounds",
  "maxToolCalls",
  "maxMcpCalls",
  "maxBrowserCommands",
  "maxResultBytes",
  "maxWorkspaceWriteBytes",
] as const;

const COUNTER_FIELDS = [
  "providerCalls",
  "inputTokens",
  "outputTokens",
  "toolRounds",
  "toolCalls",
  "mcpCalls",
  "browserCommands",
  "resultBytes",
  "workspaceWriteBytes",
] as const;

const COUNTED_BUDGET_FIELDS = [
  ["providerCalls", "maxProviderCalls"],
  ["inputTokens", "maxInputTokens"],
  ["outputTokens", "maxOutputTokens"],
  ["toolRounds", "maxToolRounds"],
  ["toolCalls", "maxToolCalls"],
  ["mcpCalls", "maxMcpCalls"],
  ["browserCommands", "maxBrowserCommands"],
  ["resultBytes", "maxResultBytes"],
  ["workspaceWriteBytes", "maxWorkspaceWriteBytes"],
] as const;

type BudgetField = (typeof BUDGET_FIELDS)[number];
type CounterField = (typeof COUNTER_FIELDS)[number];
type UnknownBudgetObject = { [key: string]: unknown };

function invalidBudgetContract(message: string): never {
  throw new AsyncTaskContractError("invalid_contract", message);
}

function budgetExhausted(): never {
  throw new AsyncTaskContractError("budget_exhausted", "Subagent budget is exhausted.");
}

function exactBudgetObject(value: unknown, fields: readonly string[], name: string): UnknownBudgetObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidBudgetContract(`${name} must be an object.`);
  const object = value as UnknownBudgetObject;
  const allowed = new Set(fields);
  if (Object.keys(object).some((key) => !allowed.has(key)) || fields.some((key) => !(key in object))) {
    invalidBudgetContract(`${name} has an invalid shape.`);
  }
  return object;
}

function nonNegativeCounter(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalidBudgetContract(`${name} must be a safe non-negative integer.`);
  return value;
}

function parseBudget(value: unknown, allowZero: boolean, name: string): SubagentBudgetRemaining {
  const input = exactBudgetObject(value, [...BUDGET_FIELDS, "maxDepth"], name);
  if (input.maxDepth !== 1) invalidBudgetContract(`${name}.maxDepth must be exactly one.`);
  const parsed = {} as { [field in BudgetField]: number };
  for (const field of BUDGET_FIELDS) {
    const entry = nonNegativeCounter(input[field], `${name}.${field}`);
    if (!allowZero && entry === 0) invalidBudgetContract(`${name}.${field} must be positive.`);
    parsed[field] = entry;
  }
  return { ...parsed, maxDepth: 1 };
}

function parseCounters(value: unknown, name: string): BudgetCounters {
  const input = exactBudgetObject(value, COUNTER_FIELDS, name);
  const output = {} as { [field in CounterField]: number };
  for (const field of COUNTER_FIELDS) output[field] = nonNegativeCounter(input[field], `${name}.${field}`);
  return output;
}

function reservationIdentifier(value: unknown): string {
  if (typeof value !== "string" || /\p{Cc}/u.test(value)) invalidBudgetContract("reservationId is invalid.");
  const normalized = value.trim().normalize("NFC");
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > MAX_TASK_CLIENT_NONCE_BYTES) invalidBudgetContract("reservationId is invalid.");
  return normalized;
}

function addCounters(left: BudgetCounters, right: BudgetCounters): BudgetCounters {
  const output = {} as { [field in CounterField]: number };
  for (const field of COUNTER_FIELDS) {
    const sum = left[field] + right[field];
    if (!Number.isSafeInteger(sum)) invalidBudgetContract("Budget counter overflowed the safe integer range.");
    output[field] = sum;
  }
  return output;
}

function subtractCounters(left: BudgetCounters, right: BudgetCounters): BudgetCounters {
  const output = {} as { [field in CounterField]: number };
  for (const field of COUNTER_FIELDS) {
    const difference = left[field] - right[field];
    if (!Number.isSafeInteger(difference) || difference < 0) invalidBudgetContract("Budget counters cannot become negative.");
    output[field] = difference;
  }
  return output;
}

function parseReservation(value: unknown, name: string): BudgetReservation {
  const input = exactBudgetObject(value, ["reservationId", "amounts"], name);
  return {
    reservationId: reservationIdentifier(input.reservationId),
    amounts: parseCounters(input.amounts, `${name}.amounts`),
  };
}

function parseUsage(value: unknown): SubagentBudgetUsage {
  const input = exactBudgetObject(value, ["used", "reserved", "reservations"], "usage");
  const used = parseCounters(input.used, "usage.used");
  const reserved = parseCounters(input.reserved, "usage.reserved");
  if (!Array.isArray(input.reservations)) invalidBudgetContract("usage.reservations must be an array.");
  const reservations = input.reservations.map((entry, index) => parseReservation(entry, `usage.reservations[${index}]`));
  if (new Set(reservations.map((entry) => entry.reservationId)).size !== reservations.length) invalidBudgetContract("Budget reservation IDs must be unique.");
  let aggregate = emptyBudgetCounters();
  for (const reservation of reservations) aggregate = addCounters(aggregate, reservation.amounts);
  if (COUNTER_FIELDS.some((field) => aggregate[field] !== reserved[field])) invalidBudgetContract("Persisted reserved counters do not match reservations.");
  return { used, reserved, reservations };
}

export function emptyBudgetCounters(): BudgetCounters {
  return {
    providerCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolRounds: 0,
    toolCalls: 0,
    mcpCalls: 0,
    browserCommands: 0,
    resultBytes: 0,
    workspaceWriteBytes: 0,
  };
}

export function emptyBudgetUsage(): SubagentBudgetUsage {
  return { used: emptyBudgetCounters(), reserved: emptyBudgetCounters(), reservations: [] };
}

/** Crash recovery charges every outstanding reservation conservatively. */
export function liquidateBudgetReservations(usageValue: SubagentBudgetUsage): SubagentBudgetUsage {
  const usage = parseUsage(usageValue);
  return {
    used: addCounters(usage.used, usage.reserved),
    reserved: emptyBudgetCounters(),
    reservations: [],
  };
}

export function deriveEffectiveBudget(
  hardCapValue: unknown,
  parentRemainingValue: unknown,
  requestedValue: unknown,
): SubagentBudget {
  const hardCap = parseBudget(hardCapValue, false, "hardCap");
  const parentRemaining = parseBudget(parentRemainingValue, true, "parentRemaining");
  const requested = parseBudget(requestedValue, false, "requested");
  const effective = {} as { [field in BudgetField]: number };
  for (const field of BUDGET_FIELDS) {
    effective[field] = Math.min(hardCap[field], parentRemaining[field], requested[field]);
  }
  return { ...effective, maxDepth: 1 };
}

export function reserveBudget(
  budgetValue: SubagentBudget,
  usageValue: unknown,
  reservationValue: BudgetReservation,
): SubagentBudgetUsage {
  const budget = parseBudget(budgetValue, true, "budget");
  const usage = parseUsage(usageValue);
  const reservation = parseReservation(reservationValue, "reservation");
  if (usage.reservations.some((entry) => entry.reservationId === reservation.reservationId)) invalidBudgetContract("Budget reservation ID already exists.");
  for (const [counterField, budgetField] of COUNTED_BUDGET_FIELDS) {
    const total = usage.used[counterField] + usage.reserved[counterField] + reservation.amounts[counterField];
    if (!Number.isSafeInteger(total) || total > budget[budgetField]) budgetExhausted();
  }
  return {
    used: usage.used,
    reserved: addCounters(usage.reserved, reservation.amounts),
    reservations: [...usage.reservations, reservation],
  };
}

export function reconcileBudgetReservation(
  usageValue: SubagentBudgetUsage,
  reservationIdValue: string,
  actualValue: BudgetCounters,
): SubagentBudgetUsage {
  const usage = parseUsage(usageValue);
  const reservationId = reservationIdentifier(reservationIdValue);
  const actual = parseCounters(actualValue, "actual");
  const reservation = usage.reservations.find((entry) => entry.reservationId === reservationId);
  if (reservation === undefined) invalidBudgetContract("Budget reservation does not exist.");
  if (COUNTER_FIELDS.some((field) => actual[field] > reservation.amounts[field])) invalidBudgetContract("Actual usage cannot exceed its reservation.");
  return {
    used: addCounters(usage.used, actual),
    reserved: subtractCounters(usage.reserved, reservation.amounts),
    reservations: usage.reservations.filter((entry) => entry.reservationId !== reservationId),
  };
}

export function remainingBudget(
  budgetValue: SubagentBudget,
  usageValue: SubagentBudgetUsage,
  elapsedWallMs: number,
): SubagentBudgetRemaining {
  const budget = parseBudget(budgetValue, true, "budget");
  const usage = parseUsage(usageValue);
  const elapsed = nonNegativeCounter(elapsedWallMs, "elapsedWallMs");
  const result: SubagentBudgetRemaining = {
    maxWallMs: Math.max(0, budget.maxWallMs - elapsed),
    maxProviderCalls: 0,
    maxInputTokens: 0,
    maxOutputTokens: 0,
    maxToolRounds: 0,
    maxToolCalls: 0,
    maxMcpCalls: 0,
    maxBrowserCommands: 0,
    maxResultBytes: 0,
    maxWorkspaceWriteBytes: 0,
    maxDepth: 1,
  };
  const mutable = result as { -readonly [field in keyof SubagentBudgetRemaining]: SubagentBudgetRemaining[field] };
  for (const [counterField, budgetField] of COUNTED_BUDGET_FIELDS) {
    mutable[budgetField] = Math.max(0, budget[budgetField] - usage.used[counterField] - usage.reserved[counterField]);
  }
  return result;
}

export function assertTaskWithinWallBudget(
  task: { readonly createdAtMs: number },
  budgetValue: SubagentBudget,
  nowMs: number,
): void {
  const budget = parseBudget(budgetValue, true, "budget");
  const createdAtMs = nonNegativeCounter(task.createdAtMs, "task.createdAtMs");
  const now = nonNegativeCounter(nowMs, "nowMs");
  if (now < createdAtMs) invalidBudgetContract("nowMs cannot precede task creation.");
  if (now - createdAtMs >= budget.maxWallMs) budgetExhausted();
}

export const TASK_RESULT_TRUNCATION_MARKER = "\n[task result truncated]";
/** Explicit ASCII fallback that fits every valid positive result-byte cap. */
export const TASK_RESULT_MIN_TRUNCATION_MARKER = "~";

function utf8Prefix(value: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const codePoint of value) {
    const nextBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + nextBytes > maxBytes) break;
    output += codePoint;
    bytes += nextBytes;
  }
  return output;
}

export function limitTaskResultUtf8(value: string, maxResultBytes: number): LimitedTaskResult {
  if (typeof value !== "string") invalidBudgetContract("Task result must be a string.");
  const cap = nonNegativeCounter(maxResultBytes, "maxResultBytes");
  if (cap === 0) invalidBudgetContract("maxResultBytes must be positive.");
  const originalBytes = Buffer.byteLength(value, "utf8");
  if (originalBytes <= cap) return { text: value, bytes: originalBytes, truncated: false };
  const markerBytes = Buffer.byteLength(TASK_RESULT_TRUNCATION_MARKER, "utf8");
  const minimalMarkerBytes = Buffer.byteLength(TASK_RESULT_MIN_TRUNCATION_MARKER, "utf8");
  const text = cap >= markerBytes
    ? `${utf8Prefix(value, cap - markerBytes)}${TASK_RESULT_TRUNCATION_MARKER}`
    : `${utf8Prefix(value, cap - minimalMarkerBytes)}${TASK_RESULT_MIN_TRUNCATION_MARKER}`;
  return { text, bytes: Buffer.byteLength(text, "utf8"), truncated: true };
}
