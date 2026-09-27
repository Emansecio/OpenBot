import { describe, expect, it } from "vitest";
import { LocalExecutionBroker } from "../src/execution/broker.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../src/execution/contracts.js";

const request: ExecutionRequest = { operation: "file.list", path: "." };
class FakeBackend implements ExecutionBackend {
  calls = 0;
  async execute(input: ExecutionRequest): Promise<ExecutionResult> {
    this.calls += 1;
    return { ok: true, operation: "file.list", entries: [{ name: input.operation, kind: "file" }] };
  }
}

describe("LocalExecutionBroker", () => {
  it("executa imediatamente uma vez", async () => {
    const backend = new FakeBackend();
    const broker = new LocalExecutionBroker(backend);
    await expect(broker.execute("a", "always", request)).resolves.toMatchObject({ ok: true });
    expect(backend.calls).toBe(1);
  });

  it("isola o mesmo requestId entre agentes diferentes", async () => {
    const backend = new FakeBackend();
    const broker = new LocalExecutionBroker(backend);
    await expect(Promise.all([
      broker.execute("agent-a", "shared-id", request),
      broker.execute("agent-b", "shared-id", request),
    ])).resolves.toHaveLength(2);
    expect(backend.calls).toBe(2);
  });

  it("reutiliza execução em voo e concluída para o mesmo requestId e payload", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const backend = new FakeBackend();
    const execute = backend.execute.bind(backend);
    backend.execute = async (input) => {
      await gate;
      return execute(input);
    };
    const broker = new LocalExecutionBroker(backend);

    const first = broker.execute("a", "idempotent", request);
    const concurrent = broker.execute("a", "idempotent", { ...request });
    await Promise.resolve();
    release();
    const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
    const completedRetry = await broker.execute("a", "idempotent", { ...request });

    expect(concurrentResult).toEqual(firstResult);
    expect(completedRetry).toEqual(firstResult);
    expect(backend.calls).toBe(1);
  });

  it("reutiliza falha concluída para evitar retry ambíguo com efeito duplicado", async () => {
    let calls = 0;
    const broker = new LocalExecutionBroker({
      async execute(input) {
        calls += 1;
        return { ok: false, operation: input.operation, code: "io_error", message: "ambiguous backend failure" };
      },
    });

    const first = await broker.execute("a", "failed-idempotent", request);
    const retry = await broker.execute("a", "failed-idempotent", { ...request });
    const collision = await broker.execute("a", "failed-idempotent", { operation: "file.list", path: "other" });

    expect(retry).toEqual(first);
    expect(collision).toMatchObject({ ok: false, code: "permission_denied" });
    expect(calls).toBe(1);
  });

  it("falha fechado quando o mesmo requestId reaparece com outro payload", async () => {
    const backend = new FakeBackend();
    const broker = new LocalExecutionBroker(backend);
    await expect(broker.execute("a", "collision", request)).resolves.toMatchObject({ ok: true });
    await expect(broker.execute("a", "collision", { operation: "file.list", path: "other" }))
      .resolves.toMatchObject({ ok: false, code: "permission_denied" });
    expect(backend.calls).toBe(1);
  });

  it("normaliza valor inválido resolvido pelo backend", async () => {
    const broker = new LocalExecutionBroker({ execute: async () => undefined as unknown as ExecutionResult });
    await expect(broker.execute("a", "invalid-result", request)).resolves.toMatchObject({
      ok: false,
      operation: "file.list",
      code: "io_error",
    });
  });

  it("rejeita sucesso com shape incompleto para a operação", async () => {
    const broker = new LocalExecutionBroker({ execute: async () => ({ ok: true, operation: "file.list" }) as unknown as ExecutionResult });
    await expect(broker.execute("a", "invalid-list", request)).resolves.toMatchObject({
      ok: false,
      operation: "file.list",
      code: "io_error",
    });
  });

  it("não executa um pedido já abortado", async () => {
    const backend = new FakeBackend();
    const broker = new LocalExecutionBroker(backend);
    const controller = new AbortController();
    controller.abort();
    await expect(broker.execute("a", "abort", request, controller.signal)).resolves.toMatchObject({ ok: false, code: "aborted" });
    expect(backend.calls).toBe(0);
  });

  it("resolve um backend por agentId quando o construtor recebe fábrica", async () => {
    const seen: string[] = [];
    const backends = new Map<string, FakeBackend>();
    const broker = new LocalExecutionBroker((agentId) => {
      seen.push(agentId);
      const existing = backends.get(agentId);
      if (existing) return existing;
      const next = new FakeBackend();
      backends.set(agentId, next);
      return next;
    });
    await broker.execute("agent-a", "r1", request);
    await broker.execute("agent-b", "r2", request);
    expect(seen).toEqual(["agent-a", "agent-b"]);
    expect(backends.get("agent-a")?.calls).toBe(1);
    expect(backends.get("agent-b")?.calls).toBe(1);
  });

  it("devolve io_error se a fábrica do backend rejeitar", async () => {
    const broker = new LocalExecutionBroker(() => Promise.reject(new Error("home.json corrompido")));
    await expect(broker.execute("openbot-default", "boom", request)).resolves.toMatchObject({
      ok: false,
      code: "io_error",
    });
  });
});
