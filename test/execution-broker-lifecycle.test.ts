import { describe, expect, it, vi } from "vitest";
import { ExecutionDrainError, LocalExecutionBroker, type BrokerAuditEntry } from "../src/execution/broker.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../src/execution/contracts.js";

const request: ExecutionRequest = { operation: "file.list", path: "." };
const success = (): ExecutionResult => ({ ok: true, operation: "file.list", entries: [] });
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("broker lifecycle fences", () => {
  it("limita bytes do cache concluído sem permitir replay de efeito expulso", async () => {
    const payload = "x".repeat(5 * 1024 * 1024);
    let calls = 0;
    const backend: ExecutionBackend = {
      async execute(input) {
        calls += 1;
        return {
          ok: true,
          operation: "file.write",
          bytes: 1,
          detail: input.operation === "file.write" && input.path === "one.txt" ? payload : payload.replaceAll("x", "y"),
        };
      },
    };
    const broker = new LocalExecutionBroker(backend, () => "always");
    const one: ExecutionRequest = { operation: "file.write", path: "one.txt", content: "x", encoding: "utf8" };
    const two: ExecutionRequest = { operation: "file.write", path: "two.txt", content: "x", encoding: "utf8" };
    try {
      const first = await broker.execute("a", "one", one);
      const second = await broker.execute("a", "two", two);
      expect(first).toMatchObject({ ok: true, operation: "file.write", bytes: 1 });
      expect(second).toMatchObject({ ok: true, operation: "file.write", bytes: 1 });
      await expect(broker.execute("a", "one", one)).resolves.toMatchObject({
        ok: false,
        operation: "file.write",
        code: "io_error",
        message: expect.stringContaining("no longer cached"),
      });
      await expect(broker.execute("a", "two", two)).resolves.toEqual(second);
      expect(calls).toBe(2);
      const cache = broker as unknown as { completedBytes: number; completed: Map<string, { bytes: number }> };
      expect(cache.completedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect([...cache.completed.values()].every((entry) => entry.bytes <= 8 * 1024 * 1024)).toBe(true);
    } finally {
      broker.close();
    }
  });

  it("refcounts fences, revokes approvals and isolates other agents", async () => {
    const backend = { execute: vi.fn(async () => success()) };
    const broker = new LocalExecutionBroker(backend, () => "always");
    await broker.execute("a", "cached", request);
    const approval = broker.execute("a", "approval", request, undefined, { permission: "ask" });
    const releaseOne = broker.fenceAgent("a");
    const releaseTwo = broker.fenceAgent("a");
    try {
      await expect(approval).resolves.toMatchObject({ ok: false, code: "permission_denied" });
      expect(broker.resolve("approval", "allow", "a")).toBe(false);
      await expect(broker.execute("a", "cached", request)).resolves.toMatchObject({ ok: false, code: "permission_denied" });
      await expect(broker.execute("a", "new", request, undefined, { permission: "ask" })).resolves.toMatchObject({ ok: false });
      expect(broker.pendingCount).toBe(0);
      await expect(broker.execute("b", "other", request)).resolves.toMatchObject({ ok: true });
      releaseOne();
      releaseOne();
      await expect(broker.execute("a", "new", request)).resolves.toMatchObject({ ok: false });
      await broker.drainAgent("a");
      releaseTwo();
      await expect(broker.execute("a", "new", request)).resolves.toMatchObject({ ok: true });
      expect(backend.execute).toHaveBeenCalledTimes(3);
    } finally { releaseOne(); releaseTwo(); broker.close(); }
  });

  it("aborts but waits a non-cooperative admitted effect and preserves deduplication", async () => {
    const gate = deferred();
    const started = deferred<AbortSignal | undefined>();
    let effects = 0;
    const backend: ExecutionBackend = { execute: vi.fn(async (_request, signal) => {
      started.resolve(signal);
      await gate.promise;
      effects += 1;
      return success();
    }) };
    const broker = new LocalExecutionBroker(backend, () => "always");
    const first = broker.execute("a", "same", request);
    const duplicate = broker.execute("a", "same", request);
    const signal = await started.promise;
    const release = broker.fenceAgent("a");
    let drained = false;
    const drain = broker.drainAgent("a").then(() => { drained = true; });
    try {
      await Promise.resolve();
      expect(signal?.aborted).toBe(true);
      expect(drained).toBe(false);
      expect(effects).toBe(0);
      gate.resolve();
      await drain;
      expect(effects).toBe(1);
      expect(await first).toEqual(await duplicate);
      expect(backend.execute).toHaveBeenCalledTimes(1);
    } finally { gate.resolve(); await Promise.all([first, duplicate, drain]); release(); broker.close(); }
  });

  it("tracks delayed backend resolution and never executes a backend resolved after abort", async () => {
    const resolution = deferred<ExecutionBackend>();
    const entered = deferred();
    const backend = { execute: vi.fn(async () => success()) };
    const broker = new LocalExecutionBroker(() => { entered.resolve(); return resolution.promise; }, () => "always");
    const execution = broker.execute("a", "resolving", request);
    await entered.promise;
    const release = broker.fenceAgent("a");
    let drained = false;
    const drain = broker.drainAgent("a").then(() => { drained = true; });
    try {
      await Promise.resolve();
      expect(drained).toBe(false);
      resolution.resolve(backend);
      await expect(execution).resolves.toMatchObject({ ok: false, code: "aborted" });
      await drain;
      expect(backend.execute).not.toHaveBeenCalled();
    } finally { resolution.resolve(backend); await Promise.all([execution, drain]); release(); broker.close(); }
  });

  it("fails closed on timeout until a subsequent fenced drain succeeds", async () => {
    const gate = deferred();
    const started = deferred();
    const broker = new LocalExecutionBroker({ execute: async () => { started.resolve(); await gate.promise; return success(); } }, () => "always");
    const execution = broker.execute("a", "slow", request);
    await started.promise;
    const release = broker.fenceAgent("a");
    try {
      await expect(broker.drainAgent("a", 5)).rejects.toBeInstanceOf(ExecutionDrainError);
      release();
      await expect(broker.execute("a", "blocked", request)).resolves.toMatchObject({ ok: false, code: "permission_denied" });
      gate.resolve();
      await execution;
      await expect(broker.execute("a", "still-blocked", request)).resolves.toMatchObject({ ok: false });
      const releaseRetry = broker.fenceAgent("a");
      try { await broker.drainAgent("a"); } finally { releaseRetry(); }
      await expect(broker.execute("a", "recovered", request)).resolves.toMatchObject({ ok: true });
    } finally { gate.resolve(); await execution; release(); broker.close(); }
  });

  it("tracks policy and audit awaits and does not publish a late approval", async () => {
    const gate = deferred();
    const entered = deferred();
    const audit: BrokerAuditEntry[] = [];
    const approvals = vi.fn();
    const backend = { execute: vi.fn(async () => success()) };
    const broker = new LocalExecutionBroker(backend, () => "always", approvals, 1_000, {
      decidePolicy: async () => { entered.resolve(); await gate.promise; return { effect: "ask" }; },
      audit: (entry) => { audit.push(entry); },
    });
    const execution = broker.execute("a", "policy", request);
    await entered.promise;
    const release = broker.fenceAgent("a");
    const drain = broker.drainAgent("a");
    try {
      gate.resolve();
      await drain;
      await expect(execution).resolves.toMatchObject({ ok: false, code: "aborted" });
      expect(approvals).not.toHaveBeenCalled();
      expect(backend.execute).not.toHaveBeenCalled();
      expect(audit.map((entry) => entry.kind)).toEqual(["decision", "outcome"]);
    } finally { gate.resolve(); await Promise.all([execution, drain]); release(); broker.close(); }
  });

  it("waits for an approval outcome audit even when the approval promise has settled", async () => {
    const gate = deferred();
    const entered = deferred();
    const broker = new LocalExecutionBroker({ execute: async () => success() }, () => "ask", undefined, 1_000, {
      audit: async (entry) => { if (entry.kind === "outcome") { entered.resolve(); await gate.promise; } },
    });
    const execution = broker.execute("a", "audit", request);
    await vi.waitFor(() => expect(broker.pendingCount).toBe(1));
    broker.resolve("audit", "deny", "a");
    await entered.promise;
    await execution;
    const release = broker.fenceAgent("a");
    let drained = false;
    const drain = broker.drainAgent("a").then(() => { drained = true; });
    try {
      await Promise.resolve();
      expect(drained).toBe(false);
      gate.resolve();
      await drain;
    } finally { gate.resolve(); await drain; release(); broker.close(); }
  });

  it("requires a held fence and a positive drain deadline", async () => {
    const broker = new LocalExecutionBroker({ execute: async () => success() }, () => "always");
    await expect(broker.drainAgent("a")).rejects.toThrow(/fenced/);
    const release = broker.fenceAgent("a");
    try { await expect(broker.drainAgent("a", 0)).rejects.toThrow(/positive/); }
    finally { release(); broker.close(); }
  });
});
