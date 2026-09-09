import { DEFAULT_AGENT_ID } from "../rpc/roster.js";
import { HomeAuditLogger } from "./audit.js";
import type { AuditEntry } from "./audit.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "./contracts.js";
import { extractRequestPaths, PolicyEngine, readHomePolicy, type PolicyEffect } from "./policy.js";
import { lstat } from "node:fs/promises";

export type LocalToolPermission = "ask" | "always" | "never";
export interface ExecutionApprovalRequest {
  requestId: string;
  agentId: string;
  conversationId?: string;
  request: ExecutionRequest;
  expiresAtMs: number;
}
export type ApprovalDecision = "allow" | "deny";
export type ApprovalResolutionStatus = "resolved" | "expired" | "not-found";

/** Audit entry routed by agent; the sink strips agentId before persisting. */
export type BrokerAuditEntry = AuditEntry & { agentId: string };

export interface PolicyEvaluation {
  effect: PolicyEffect;
  ruleIndex?: number;
}

export interface LocalBrokerHooks {
  /**
   * Extra policy layer evaluated after the global permission. Return
   * undefined to defer to the global setting; a returned effect only ever
   * tightens the decision (deny > ask > allow).
   */
  decidePolicy?: (agentId: string, request: ExecutionRequest) => Promise<PolicyEvaluation | undefined> | PolicyEvaluation | undefined;
  /** Write-ahead audit sink: decision before execution, outcome after. */
  audit?: (entry: BrokerAuditEntry) => Promise<void> | void;
}

interface PendingApproval {
  approval: ExecutionApprovalRequest;
  signal?: AbortSignal;
  resolve: (result: ExecutionResult) => void;
  abortListener?: () => void;
  timeout?: NodeJS.Timeout;
}

interface ExecutionRecord {
  fingerprint: string;
  promise: Promise<ExecutionResult>;
}

interface CompletedExecution {
  fingerprint: string;
  result: ExecutionResult;
}

interface ExpiredApproval {
  requestId: string;
  agentId: string;
  forgetAtMs: number;
}

const denied = (request: ExecutionRequest, message: string): ExecutionResult => ({
  ok: false,
  operation: request.operation,
  code: "permission_denied",
  message,
});

type EffectiveDecision = "allow" | "ask" | "deny";
const DECISION_RANK: Record<EffectiveDecision, number> = { allow: 0, ask: 1, deny: 2 };
const stricter = (left: EffectiveDecision, right: EffectiveDecision): EffectiveDecision =>
  DECISION_RANK[left] >= DECISION_RANK[right] ? left : right;

const aborted = (request: ExecutionRequest): ExecutionResult => ({
  ok: false,
  operation: request.operation,
  code: "aborted",
  message: "Execution was aborted.",
});

const pendingKey = (agentId: string, requestId: string): string => JSON.stringify([agentId, requestId]);
const MAX_COMPLETED_EXECUTIONS = 1_024;
const EXPIRED_APPROVAL_TTL_MS = 10_000;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const finiteNonNegative = (value: unknown): value is number => (
  typeof value === "number" && Number.isFinite(value) && value >= 0
);
const stringValue = (value: unknown): value is string => typeof value === "string";
const nullableExitCode = (value: unknown): value is number | null => value === null || Number.isInteger(value);
const validProcessOutput = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return stringValue(result.stdout) && stringValue(result.stderr) && nullableExitCode(result.exitCode) &&
    finiteNonNegative(result.durationMs) && typeof result.stdoutTruncated === "boolean" &&
    typeof result.stderrTruncated === "boolean" && (result.signal === undefined || stringValue(result.signal));
};
const browserImage = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const image = value as Record<string, unknown>;
  return image.mimeType === "image/png" && stringValue(image.dataBase64) &&
    finiteNonNegative(image.width) && finiteNonNegative(image.height);
};

const validSuccess = (result: Record<string, unknown>, request: ExecutionRequest): boolean => {
  switch (request.operation) {
  case "workspace.info":
    return stringValue(result.homeRoot) && Array.isArray(result.sharedFolders) && Array.isArray(result.legacyFolders) &&
      result.sharedFolders.every((entry) => entry !== null && typeof entry === "object" &&
        stringValue(entry.name) && stringValue(entry.path) && ["read", "write"].includes(entry.access)) &&
      result.legacyFolders.every((entry) => entry !== null && typeof entry === "object" && stringValue(entry.name) && stringValue(entry.path));
  case "file.list":
    return Array.isArray(result.entries) && result.entries.every((entry) => (
      typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
      stringValue((entry as Record<string, unknown>).name) &&
      ["file", "directory", "other"].includes(String((entry as Record<string, unknown>).kind))
    ));
  case "file.stat":
    return ["file", "directory", "other"].includes(String(result.kind)) && finiteNonNegative(result.bytes);
  case "file.mkdir": return typeof result.created === "boolean";
  case "file.copy": return finiteNonNegative(result.bytes) && finiteNonNegative(result.entries);
  case "file.move": return true;
  case "file.trash": return stringValue(result.trashId);
  case "file.restore": return stringValue(result.path);
  case "file.read":
    return stringValue(result.content) && ["utf8", "base64"].includes(String(result.encoding)) && finiteNonNegative(result.bytes);
  case "file.write": return finiteNonNegative(result.bytes);
  case "command.run":
    return stringValue(result.command) && stringValue(result.stdout) && stringValue(result.stderr) &&
      nullableExitCode(result.exitCode) && finiteNonNegative(result.durationMs);
  case "process.run":
    return validProcessOutput(result);
  case "whatsapp":
    return result.op === request.op && stringValue(result.stdout) && stringValue(result.stderr) &&
      nullableExitCode(result.exitCode) && finiteNonNegative(result.durationMs) &&
      typeof result.stdoutTruncated === "boolean" && typeof result.stderrTruncated === "boolean";
  default: {
    const command = request.operation.slice("browser.".length);
    if (result.command !== command || !stringValue(result.tabId)) return false;
    if (request.operation === "browser.snapshot") {
      if (typeof result.snapshot !== "object" || result.snapshot === null || Array.isArray(result.snapshot)) return false;
      const snapshot = result.snapshot as Record<string, unknown>;
      const viewport = snapshot.viewport as Record<string, unknown> | undefined;
      return stringValue(snapshot.url) && stringValue(snapshot.title) && browserImage(snapshot.screenshot) &&
        viewport !== undefined && finiteNonNegative(viewport.width) && finiteNonNegative(viewport.height) &&
        finiteNonNegative(viewport.deviceScaleFactor);
    }
    if (request.operation === "browser.screenshot") return browserImage(result.screenshot);
    if (request.operation === "browser.upload") {
      if (typeof result.upload !== "object" || result.upload === null || Array.isArray(result.upload)) return false;
      const upload = result.upload as Record<string, unknown>;
      return stringValue(upload.selector) && stringValue(upload.fileName) && finiteNonNegative(upload.bytes);
    }
    return true;
  }
  }
};

const validResult = (value: unknown, request: ExecutionRequest): value is ExecutionResult => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (typeof result.ok !== "boolean" || result.operation !== request.operation) return false;
  return result.ok
    ? validSuccess(result, request)
    : stringValue(result.code) && stringValue(result.message) &&
      (result.partialOutput === undefined || (request.operation === "process.run" && validProcessOutput(result.partialOutput)));
};

export type ExecutionBackendSource =
  | ExecutionBackend
  | ((agentId: string) => ExecutionBackend | Promise<ExecutionBackend>);

export class LocalExecutionBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly inFlight = new Map<string, ExecutionRecord>();
  private readonly completed = new Map<string, CompletedExecution>();
  private readonly expired = new Map<string, ExpiredApproval>();
  private approvalListener?: (approval: ExecutionApprovalRequest) => void;
  private approvalExpiryListener?: (approval: ExecutionApprovalRequest) => void;
  private readonly hooks?: LocalBrokerHooks;
  private closed = false;

  constructor(
    private readonly backend: ExecutionBackendSource,
    private readonly permission: (agentId?: string, request?: ExecutionRequest) => LocalToolPermission,
    onApprovalRequired?: (approval: ExecutionApprovalRequest) => void,
    private readonly approvalTimeoutMs = 5 * 60_000,
    hooks?: LocalBrokerHooks,
  ) {
    if (!Number.isFinite(approvalTimeoutMs) || approvalTimeoutMs <= 0) {
      throw new Error("approvalTimeoutMs must be positive");
    }
    this.approvalListener = onApprovalRequired;
    this.hooks = hooks;
  }

  setApprovalListener(listener?: (approval: ExecutionApprovalRequest) => void): void {
    this.approvalListener = listener;
  }

  setApprovalExpiryListener(listener?: (approval: ExecutionApprovalRequest) => void): void {
    this.approvalExpiryListener = listener;
  }

  localPolicy(agentId?: string, request?: ExecutionRequest): LocalToolPermission {
    return this.permission(agentId, request);
  }

  private resolveBackend(agentId: string): Promise<ExecutionBackend> {
    return Promise.resolve(typeof this.backend === "function" ? this.backend(agentId) : this.backend);
  }

  private failed(request: ExecutionRequest): ExecutionResult {
    return { ok: false, operation: request.operation, code: "io_error", message: "Execution backend failed." };
  }

  private run(agentId: string, request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    return this.resolveBackend(agentId).then(
      (backend) => backend.execute(request, signal),
      () => this.failed(request),
    ).then(
      (result) => validResult(result, request) ? result : this.failed(request),
      () => this.failed(request),
    );
  }

  private rememberCompleted(key: string, fingerprint: string, result: ExecutionResult): void {
    if (this.closed) return;
    this.completed.delete(key);
    this.completed.set(key, { fingerprint, result: structuredClone(result) });
    while (this.completed.size > MAX_COMPLETED_EXECUTIONS) {
      const oldest = this.completed.keys().next().value;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
  }

  private runIdempotently(
    key: string,
    agentId: string,
    request: ExecutionRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const approvedRequest = structuredClone(request);
    const fingerprint = canonicalJson(approvedRequest);
    const cached = this.completed.get(key);
    if (cached !== undefined) {
      return Promise.resolve(cached.fingerprint === fingerprint
        ? structuredClone(cached.result)
        : denied(approvedRequest, "Execution request ID was reused with different arguments."));
    }
    const active = this.inFlight.get(key);
    if (active !== undefined) {
      return active.fingerprint === fingerprint
        ? active.promise.then((result) => structuredClone(result))
        : Promise.resolve(denied(approvedRequest, "Execution request ID was reused with different arguments."));
    }
    const promise = this.run(agentId, approvedRequest, signal).then((result) => {
      this.rememberCompleted(key, fingerprint, result);
      return result;
    }).finally(() => {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, { fingerprint, promise });
    return promise.then((result) => structuredClone(result));
  }

  /** Runs the request and appends the audit outcome entry. */
  private async runWithAudit(
    key: string,
    agentId: string,
    requestId: string,
    request: ExecutionRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const result = await this.runIdempotently(key, agentId, request, signal);
    await this.emitAudit({
      kind: "outcome",
      agentId,
      requestId,
      operation: request.operation,
      outcome: result.ok ? "ok" : "error",
      ...(result.ok ? {} : { code: result.code }),
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  private async emitAudit(entry: BrokerAuditEntry): Promise<void> {
    if (this.hooks?.audit === undefined) return;
    try {
      await this.hooks.audit(entry);
    } catch {
      // Audit is observability: a broken sink never blocks execution.
    }
  }

  /** Evaluates the hook policy layer; evaluation failures fail closed. */
  private async decidePolicySafely(agentId: string, request: ExecutionRequest): Promise<PolicyEvaluation | undefined> {
    if (this.hooks?.decidePolicy === undefined) return undefined;
    try {
      return await this.hooks.decidePolicy(agentId, request);
    } catch {
      return { effect: "deny" };
    }
  }

  async execute(
    agentId: string,
    requestId: string,
    request: ExecutionRequest,
    signal?: AbortSignal,
    options?: { permission?: LocalToolPermission; conversationId?: string },
  ): Promise<ExecutionResult> {
    if (this.closed || signal?.aborted) return aborted(request);
    const configuredPermission = this.permission(agentId, request);
    if (configuredPermission === "never") return denied(request, "Local tools are disabled.");
    const policy = options?.permission ?? configuredPermission;
    if (policy === "never") return denied(request, "Local tools are disabled.");
    const key = pendingKey(agentId, requestId);
    const fingerprint = canonicalJson(request);
    const cached = this.completed.get(key);
    if (cached !== undefined) {
      return cached.fingerprint === fingerprint
        ? structuredClone(cached.result)
        : denied(request, "Execution request ID was reused with different arguments.");
    }
    const active = this.inFlight.get(key);
    if (active !== undefined) {
      return active.fingerprint === fingerprint
        ? active.promise.then((result) => structuredClone(result))
        : denied(request, "Execution request ID was reused with different arguments.");
    }
    if (this.hooks === undefined) {
      if (policy === "always") return this.runIdempotently(key, agentId, request, signal);
      return this.beginApproval(key, agentId, requestId, request, signal, options?.conversationId);
    }
    // Audit + policy path (melhoria 2): decide, record write-ahead, then act.
    let effect: EffectiveDecision = policy === "always" ? "allow" : "ask";
    let source: "global" | "policy" = "global";
    let ruleIndex: number | undefined;
    const evaluation = await this.decidePolicySafely(agentId, request);
    if (evaluation !== undefined) {
      source = "policy";
      ruleIndex = evaluation.ruleIndex;
      effect = stricter(effect, evaluation.effect);
    }
    await this.emitAudit({
      kind: "decision",
      agentId,
      requestId,
      operation: request.operation,
      paths: extractRequestPaths(request),
      decision: effect,
      source,
      ...(ruleIndex === undefined ? {} : { ruleIndex }),
    });
    if (effect === "deny") {
      await this.emitAudit({
        kind: "outcome",
        agentId,
        requestId,
        operation: request.operation,
        outcome: "error",
        code: "permission_denied",
        durationMs: 0,
      });
      return denied(request, "Local tool request was denied by policy.");
    }
    if (effect === "ask") return this.beginApproval(key, agentId, requestId, request, signal, options?.conversationId);
    return this.runWithAudit(key, agentId, requestId, request, signal);
  }

  private beginApproval(
    key: string,
    agentId: string,
    requestId: string,
    request: ExecutionRequest,
    signal?: AbortSignal,
    conversationId?: string,
  ): Promise<ExecutionResult> {
    this.pruneExpired();
    if (this.expired.has(key)) return Promise.resolve(denied(request, "Approval request expired and cannot be reused yet."));
    if (this.pending.has(key)) return Promise.resolve(denied(request, "Approval request already exists."));

    return new Promise((resolve) => {
      const approvedRequest = structuredClone(request);
      const approval: ExecutionApprovalRequest = {
        requestId,
        agentId,
        ...(conversationId === undefined ? {} : { conversationId }),
        request: approvedRequest,
        expiresAtMs: Date.now() + this.approvalTimeoutMs,
      };
      const item: PendingApproval = { approval, signal, resolve };
      if (signal) {
        item.abortListener = () => {
          if (this.pending.get(key) !== item) return;
          this.finish(item, aborted(approvedRequest));
        };
        signal.addEventListener("abort", item.abortListener, { once: true });
      }
      this.pending.set(key, item);
      item.timeout = setTimeout(() => {
        if (this.pending.get(key) === item) {
          this.expired.set(key, { requestId, agentId, forgetAtMs: Date.now() + EXPIRED_APPROVAL_TTL_MS });
          try {
            this.approvalExpiryListener?.(item.approval);
          } catch {
            // Expiry UI is observational.
          }
          void this.emitAudit({
            kind: "outcome",
            agentId,
            requestId,
            operation: request.operation,
            outcome: "error",
            code: "approval_timeout",
            durationMs: this.approvalTimeoutMs,
          });
          this.finish(item, denied(approvedRequest, "Approval request timed out."));
        }
      }, this.approvalTimeoutMs);
      item.timeout.unref();
      if (this.approvalListener) {
        try {
          this.approvalListener({ ...approval, request: structuredClone(approvedRequest) });
        } catch {
          // UI publication is observational. Keep approval pending so a retry
          // or external resolver can still complete the request.
        }
      }
    });
  }

  pendingRequestIds(): string[] {
    return [...this.pending.values()].map(({ approval }) => approval.requestId);
  }

  peekPending(requestId: string, agentId?: string): ExecutionRequest | undefined {
    return this.peekPendingApproval(requestId, agentId)?.request;
  }

  peekPendingApproval(requestId: string, agentId?: string): ExecutionApprovalRequest | undefined {
    this.pruneExpired();
    const matches = agentId === undefined
      ? [...this.pending.values()].filter((item) => item.approval.requestId === requestId)
      : [this.pending.get(pendingKey(agentId, requestId))].filter((item): item is PendingApproval => item !== undefined);
    const approval = matches.length === 1 ? matches[0]?.approval : undefined;
    return approval === undefined ? undefined : { ...approval, request: structuredClone(approval.request) };
  }

  resolve(requestId: string, decision: ApprovalDecision, agentId?: string): boolean {
    return this.resolutionStatus(requestId, decision, agentId) === "resolved";
  }

  resolutionStatus(requestId: string, decision: ApprovalDecision, agentId?: string): ApprovalResolutionStatus {
    this.pruneExpired();
    const matches = agentId === undefined
      ? [...this.pending.entries()].filter(([, item]) => item.approval.requestId === requestId)
      : [[pendingKey(agentId, requestId), this.pending.get(pendingKey(agentId, requestId))] as const]
        .filter((entry): entry is readonly [string, PendingApproval] => entry[1] !== undefined);
    if (matches.length !== 1) {
      const expiredMatches = agentId === undefined
        ? [...this.expired.values()].filter((item) => item.requestId === requestId)
        : [this.expired.get(pendingKey(agentId, requestId))].filter((item): item is ExpiredApproval => item !== undefined);
      return expiredMatches.length === 1 ? "expired" : "not-found";
    }
    const match = matches[0];
    if (!match) return "not-found";
    const [key, item] = match;
    this.pending.delete(key);
    this.detach(item);
    if (decision === "deny") {
      void this.emitAudit({
        kind: "outcome",
        agentId: item.approval.agentId,
        requestId: item.approval.requestId,
        operation: item.approval.request.operation,
        outcome: "error",
        code: "permission_denied",
        durationMs: 0,
      });
      item.resolve(denied(item.approval.request, "Local tool request was denied."));
    } else if (this.permission(item.approval.agentId, item.approval.request) === "never") {
      item.resolve(denied(item.approval.request, "Local tools are disabled."));
    } else {
      void this.runWithAudit(key, item.approval.agentId, item.approval.requestId, item.approval.request, item.signal).then(item.resolve);
    }
    return "resolved";
  }

  get pendingCount(): number { return this.pending.size; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of [...this.pending.values()]) this.finish(item, aborted(item.approval.request));
    this.completed.clear();
    this.expired.clear();
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, item] of this.expired) {
      if (item.forgetAtMs <= now) this.expired.delete(key);
    }
  }

  private finish(item: PendingApproval, result: ExecutionResult): void {
    this.pending.delete(pendingKey(item.approval.agentId, item.approval.requestId));
    this.detach(item);
    item.resolve(result);
  }

  private detach(item: PendingApproval): void {
    if (item.signal && item.abortListener) item.signal.removeEventListener("abort", item.abortListener);
    if (item.timeout) clearTimeout(item.timeout);
  }
}

const unregistered = (request: ExecutionRequest): ExecutionResult => ({
  ok: false,
  operation: request.operation,
  code: "permission_denied",
  message: "Agent is not registered.",
});

export function createAgentHomeBroker(
  store: { backendFor(agentId: string): Promise<ExecutionBackend>; pathFor?(agentId: string): string },
  options: {
    allowedAgentIds?: readonly string[] | (() => readonly string[]);
    permission?: (agentId?: string, request?: ExecutionRequest) => LocalToolPermission;
    onApprovalRequired?: (approval: ExecutionApprovalRequest) => void;
    approvalTimeoutMs?: number;
    /** Disable the per-home audit trail (default: on when pathFor exists). */
    audit?: boolean;
    /** Disable the per-home declarative policy (default: on when pathFor exists). */
    policy?: boolean;
  } = {},
): LocalExecutionBroker {
  const permission = options.permission ?? (() => "always");
  const pathFor = store.pathFor?.bind(store);
  const allowedIds = () => {
    const ids = typeof options.allowedAgentIds === "function"
      ? options.allowedAgentIds()
      : (options.allowedAgentIds ?? [DEFAULT_AGENT_ID]);
    return new Set(ids);
  };
  // Never audit or evaluate policy for unregistered agents: touching their
  // home root would materialize folders that must not exist.
  const hooks = buildHomeBrokerHooks(pathFor, {
    ...options,
    isAllowed: (agentId) => allowedIds().has(agentId),
  });
  return new LocalExecutionBroker(
    (agentId) => {
      if (!allowedIds().has(agentId)) {
        return { execute: async (request) => unregistered(request) };
      }
      return store.backendFor(agentId);
    },
    permission,
    options.onApprovalRequired,
    options.approvalTimeoutMs,
    hooks,
  );
}

const HOME_POLICY_CACHE_TTL_MS = 30_000;

/** Wires the per-home audit logger and declarative policy (melhoria 2). */
export function buildHomeBrokerHooks(
  pathFor: ((agentId: string) => string) | undefined,
  options: { audit?: boolean; policy?: boolean; isAllowed?: (agentId: string) => boolean },
): LocalBrokerHooks | undefined {
  if (pathFor === undefined || (options.audit === false && options.policy === false)) return undefined;
  const loggers = new Map<string, HomeAuditLogger>();
  const policies = new Map<string, { at: number; engine: PolicyEngine }>();
  const hooks: LocalBrokerHooks = {};
  if (pathFor !== undefined && options.audit !== false) {
    // Homes that do not exist yet (blocked/quarantined agents) must stay
    // unmaterialized: auditing never creates the folder it records.
    const existingHomes = new Set<string>();
    const homeExists = async (agentId: string): Promise<boolean> => {
      const cached = existingHomes.has(agentId);
      if (cached) return true;
      const root = pathFor(agentId);
      const metadata = await lstat(root).catch(() => undefined);
      if (metadata?.isDirectory() === true) {
        existingHomes.add(agentId);
        return true;
      }
      return false;
    };
    hooks.audit = async ({ agentId, ...entry }) => {
      if (options.isAllowed !== undefined && !options.isAllowed(agentId)) return;
      if (!(await homeExists(agentId))) return;
      let logger = loggers.get(agentId);
      if (logger === undefined) {
        logger = new HomeAuditLogger(pathFor(agentId), agentId);
        loggers.set(agentId, logger);
      }
      await logger.record(entry);
    };
  }
  if (pathFor !== undefined && options.policy !== false) {
    hooks.decidePolicy = async (agentId, request) => {
      if (options.isAllowed !== undefined && !options.isAllowed(agentId)) return undefined;
      const now = Date.now();
      const cached = policies.get(agentId);
      let engine: PolicyEngine;
      if (cached !== undefined && now - cached.at < HOME_POLICY_CACHE_TTL_MS) {
        engine = cached.engine;
      } else {
        engine = new PolicyEngine(await readHomePolicy(pathFor(agentId)));
        policies.set(agentId, { at: now, engine });
      }
      const decision = engine.evaluate(agentId, request.operation, extractRequestPaths(request), now);
      // "allow" defers to the global setting: policy only tightens.
      if (decision.effect === "allow") return undefined;
      return { effect: decision.effect, ruleIndex: decision.ruleIndex ?? undefined };
    };
  }
  return hooks;
}
