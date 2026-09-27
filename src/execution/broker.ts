import { DEFAULT_AGENT_ID } from "../rpc/roster.js";
import { HomeAuditLogger } from "./audit.js";
import type { AuditEntry } from "./audit.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "./contracts.js";
import { extractRequestPaths } from "./request-paths.js";
import { lstat } from "node:fs/promises";

/** Audit entry routed by agent; the sink strips agentId before persisting. */
export type BrokerAuditEntry = AuditEntry & { agentId: string };

export interface LocalBrokerHooks {
  /** Write-ahead audit sink: decision before execution, outcome after. */
  audit?: (entry: BrokerAuditEntry) => Promise<void> | void;
}

interface AdmittedEffect {
  controller?: AbortController;
  done: Promise<void>;
}

export class ExecutionDrainError extends Error {
  constructor() {
    super("Agent execution did not drain before the deadline.");
    this.name = "ExecutionDrainError";
  }
}

interface ExecutionRecord {
  fingerprint: string;
  promise: Promise<ExecutionResult>;
}

interface CompletedExecution {
  fingerprint: string;
  result?: ExecutionResult;
  bytes: number;
}

const denied = (request: ExecutionRequest, message: string): ExecutionResult => ({
  ok: false,
  operation: request.operation,
  code: "permission_denied",
  message,
});

const aborted = (request: ExecutionRequest): ExecutionResult => ({
  ok: false,
  operation: request.operation,
  code: "aborted",
  message: "Execution was aborted.",
});

const executionKey = (agentId: string, requestId: string): string => JSON.stringify([agentId, requestId]);
const MAX_COMPLETED_EXECUTIONS = 1_024;
const MAX_COMPLETED_EXECUTION_BYTES = 8 * 1024 * 1024;

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
const validQuotaLimit = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const limit = value as Record<string, unknown>;
  return Number.isSafeInteger(limit.maxBytes) && (limit.maxBytes as number) >= 1 &&
    Number.isSafeInteger(limit.maxFiles) && (limit.maxFiles as number) >= 1 &&
    Number.isSafeInteger(limit.maxEntries) && (limit.maxEntries as number) >= 1;
};
const validWorkspaceQuota = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const quota = value as Record<string, unknown>;
  if (!validQuotaLimit(quota.global) || typeof quota.folders !== "object" || quota.folders === null || Array.isArray(quota.folders)) return false;
  return Object.values(quota.folders as Record<string, unknown>).every(validQuotaLimit);
};
const validProcessOutput = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return stringValue(result.stdout) && stringValue(result.stderr) && nullableExitCode(result.exitCode) &&
    finiteNonNegative(result.durationMs) && typeof result.stdoutTruncated === "boolean" &&
    typeof result.stderrTruncated === "boolean" && (result.signal === undefined || stringValue(result.signal));
};

const completedResultBytes = (result: ExecutionResult): number => {
  try {
    const serialized = JSON.stringify(result);
    return serialized === undefined ? 0 : Buffer.byteLength(serialized);
  } catch {
    return MAX_COMPLETED_EXECUTION_BYTES + 1;
  }
};

const completedResultUnavailable = (request: ExecutionRequest): ExecutionResult => ({
  ok: false,
  operation: request.operation,
  code: "io_error",
  message: "Execution result is no longer cached; request ID cannot be reused.",
});
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
      result.legacyFolders.every((entry) => entry !== null && typeof entry === "object" && stringValue(entry.name) && stringValue(entry.path)) &&
      validWorkspaceQuota(result.quota);
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

/**
 * Runs bot tool requests against their home backend. Local tools are trusted
 * host access by design (the bot runs as the Windows user); the broker adds
 * idempotent request IDs, fences for lifecycle work, and a write-ahead audit.
 */
export class LocalExecutionBroker {
  private readonly inFlight = new Map<string, ExecutionRecord>();
  private readonly completed = new Map<string, CompletedExecution>();
  private completedBytes = 0;
  private readonly agentFences = new Map<string, number>();
  private readonly failedDrains = new Set<string>();
  private readonly admitted = new Map<string, Set<AdmittedEffect>>();
  private closed = false;

  constructor(
    private readonly backend: ExecutionBackendSource,
    private readonly hooks?: LocalBrokerHooks,
  ) {}

  /** Block new requests before any lifecycle awaits. */
  fenceAgent(agentId: string): () => void {
    this.agentFences.set(agentId, (this.agentFences.get(agentId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.agentFences.get(agentId) ?? 1) - 1;
      if (remaining === 0) this.agentFences.delete(agentId);
      else this.agentFences.set(agentId, remaining);
    };
  }

  /** Wait for actual admitted effects, not an abort-race result. */
  async drainAgent(agentId: string, deadlineMs = 5_000): Promise<void> {
    if (!this.agentFences.has(agentId)) throw new Error("Agent must be fenced before draining execution.");
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new Error("Execution drain deadline must be positive.");
    const settle = async (): Promise<void> => {
      while (true) {
        const effects = [...(this.admitted.get(agentId) ?? [])];
        if (effects.length === 0) return;
        for (const effect of effects) effect.controller?.abort();
        await Promise.all(effects.map((effect) => effect.done));
      }
    };
    let timeout!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        settle(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new ExecutionDrainError()), deadlineMs);
        }),
      ]);
      this.failedDrains.delete(agentId);
    } catch (error) {
      // Releasing the caller's fence after failure must not admit a late writer.
      this.failedDrains.add(agentId);
      throw error;
    } finally { clearTimeout(timeout); }
  }

  private isFenced(agentId: string): boolean {
    return this.agentFences.has(agentId) || this.failedDrains.has(agentId);
  }

  private trackEffect(agentId: string, controller?: AbortController): () => void {
    let effects = this.admitted.get(agentId);
    if (effects === undefined) { effects = new Set(); this.admitted.set(agentId, effects); }
    let settled!: () => void;
    const effect: AdmittedEffect = { controller, done: new Promise<void>((resolve) => { settled = resolve; }) };
    effects.add(effect);
    return () => {
      if (!effects.delete(effect)) return;
      settled();
      if (effects.size === 0 && this.admitted.get(agentId) === effects) this.admitted.delete(agentId);
    };
  }

  private resolveBackend(agentId: string): Promise<ExecutionBackend> {
    return Promise.resolve(typeof this.backend === "function" ? this.backend(agentId) : this.backend);
  }

  private failed(request: ExecutionRequest): ExecutionResult {
    return { ok: false, operation: request.operation, code: "io_error", message: "Execution backend failed." };
  }

  private async run(agentId: string, request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    try {
      if (this.closed || signal?.aborted) return aborted(request);
      if (this.isFenced(agentId)) return denied(request, "Agent execution is fenced.");
      const backend = await this.resolveBackend(agentId);
      // Backend resolution may itself provision a home. Drain tracks that
      // resolution, and an abort must prevent the next effect from starting.
      if (this.closed || signal?.aborted) return aborted(request);
      if (this.isFenced(agentId)) return denied(request, "Agent execution is fenced.");
      const result = await backend.execute(request, signal);
      return validResult(result, request) ? result : this.failed(request);
    } catch { return this.failed(request); }
  }

  private rememberCompleted(key: string, fingerprint: string, result: ExecutionResult): void {
    if (this.closed) return;
    const previous = this.completed.get(key);
    if (previous !== undefined) this.completedBytes -= previous.bytes;
    this.completed.delete(key);
    const bytes = completedResultBytes(result);
    this.completed.set(key, {
      fingerprint,
      bytes: bytes <= MAX_COMPLETED_EXECUTION_BYTES ? bytes : 0,
      ...(bytes <= MAX_COMPLETED_EXECUTION_BYTES ? { result: structuredClone(result) } : {}),
    });
    this.completedBytes += bytes <= MAX_COMPLETED_EXECUTION_BYTES ? bytes : 0;
    while (this.completed.size > MAX_COMPLETED_EXECUTIONS || this.completedBytes > MAX_COMPLETED_EXECUTION_BYTES) {
      const oldest = this.completed.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.completed.get(oldest);
      if (evicted !== undefined && this.completedBytes > MAX_COMPLETED_EXECUTION_BYTES && evicted.result !== undefined) {
        this.completedBytes -= evicted.bytes;
        this.completed.delete(oldest);
        this.completed.set(oldest, { fingerprint: evicted.fingerprint, bytes: 0 });
        continue;
      }
      if (evicted !== undefined) this.completedBytes -= evicted.bytes;
      this.completed.delete(oldest);
    }
  }

  private replayCompleted(cached: CompletedExecution, request: ExecutionRequest, fingerprint: string): ExecutionResult {
    if (cached.fingerprint !== fingerprint) return denied(request, "Execution request ID was reused with different arguments.");
    return cached.result === undefined ? completedResultUnavailable(request) : structuredClone(cached.result);
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
      return Promise.resolve(this.replayCompleted(cached, approvedRequest, fingerprint));
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
    const settled = this.trackEffect(entry.agentId);
    try {
      await this.hooks.audit(entry);
    } catch {
      // Audit is observability: a broken sink never blocks execution.
    } finally { settled(); }
  }

  async execute(
    agentId: string,
    requestId: string,
    request: ExecutionRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    if (this.closed || signal?.aborted) return aborted(request);
    if (this.isFenced(agentId)) return denied(request, "Agent execution is fenced.");
    const controller = new AbortController();
    const abortListener = (): void => controller.abort();
    signal?.addEventListener("abort", abortListener, { once: true });
    // Register before invoking audit or backend factories: both can touch
    // the home before the backend's execute() promise exists.
    const settled = this.trackEffect(agentId, controller);
    try {
      return await this.executeAdmitted(agentId, requestId, request, controller.signal);
    } finally {
      signal?.removeEventListener("abort", abortListener);
      settled();
    }
  }

  private async executeAdmitted(
    agentId: string,
    requestId: string,
    request: ExecutionRequest,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    if (this.closed || signal.aborted) return aborted(request);
    const key = executionKey(agentId, requestId);
    const fingerprint = canonicalJson(request);
    const cached = this.completed.get(key);
    if (cached !== undefined) {
      return this.replayCompleted(cached, request, fingerprint);
    }
    const active = this.inFlight.get(key);
    if (active !== undefined) {
      return active.fingerprint === fingerprint
        ? active.promise.then((result) => structuredClone(result))
        : denied(request, "Execution request ID was reused with different arguments.");
    }
    if (this.hooks === undefined) return this.runIdempotently(key, agentId, request, signal);
    // Audit path: record the decision write-ahead, then act.
    await this.emitAudit({
      kind: "decision",
      agentId,
      requestId,
      operation: request.operation,
      paths: extractRequestPaths(request),
      decision: "allow",
      source: "global",
    });
    const stopped = this.closed || signal.aborted ? aborted(request)
      : this.isFenced(agentId) ? denied(request, "Agent execution is fenced.") : undefined;
    if (stopped !== undefined) {
      await this.emitAudit({ kind: "outcome", agentId, requestId, operation: request.operation,
        outcome: "error", code: stopped.ok ? undefined : stopped.code, durationMs: 0 });
      return stopped;
    }
    return this.runWithAudit(key, agentId, requestId, request, signal);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const effects of this.admitted.values()) for (const effect of effects) effect.controller?.abort();
    this.completed.clear();
    this.completedBytes = 0;
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
    /** Disable the per-home audit trail (default: on when pathFor exists). */
    audit?: boolean;
  } = {},
): LocalExecutionBroker {
  const pathFor = store.pathFor?.bind(store);
  const allowedIds = () => {
    const ids = typeof options.allowedAgentIds === "function"
      ? options.allowedAgentIds()
      : (options.allowedAgentIds ?? [DEFAULT_AGENT_ID]);
    return new Set(ids);
  };
  // Never audit unregistered agents: touching their home root would
  // materialize folders that must not exist.
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
    hooks,
  );
}

/** Wires the per-home audit logger (melhoria 2). */
export function buildHomeBrokerHooks(
  pathFor: ((agentId: string) => string) | undefined,
  options: { audit?: boolean; isAllowed?: (agentId: string) => boolean },
): LocalBrokerHooks | undefined {
  if (pathFor === undefined || options.audit === false) return undefined;
  const loggers = new Map<string, HomeAuditLogger>();
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
  return {
    audit: async ({ agentId, ...entry }) => {
      if (options.isAllowed !== undefined && !options.isAllowed(agentId)) return;
      if (!(await homeExists(agentId))) return;
      let logger = loggers.get(agentId);
      if (logger === undefined) {
        logger = new HomeAuditLogger(pathFor(agentId), agentId);
        loggers.set(agentId, logger);
      }
      await logger.record(entry);
    },
  };
}
