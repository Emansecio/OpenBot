import { describe, expect, it } from "vitest";
import { LocalExecutionBroker, type ExecutionApprovalRequest, type LocalToolPermission } from "../src/execution/broker.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../src/execution/contracts.js";

const request: ExecutionRequest = { operation: "file.list", path: "." };
class FakeBackend implements ExecutionBackend {
  calls = 0;
  async execute(input: ExecutionRequest): Promise<ExecutionResult> {
    this.calls += 1;
    return { ok: true, operation: "file.list", entries: [{ name: input.operation, kind: "file" }] };
  }
}
const setup = (initial: LocalToolPermission) => {
  let policy = initial;
  const backend = new FakeBackend();
  const approvals: ExecutionApprovalRequest[] = [];
  const broker = new LocalExecutionBroker(backend, () => policy, (approval) => approvals.push(approval));
  return { backend, approvals, broker, setPolicy: (next: LocalToolPermission) => { policy = next; } };
};

describe("LocalExecutionBroker", () => {
  it("ask não executa antes de allow e correlaciona requestId", async () => {
    const { backend, approvals, broker } = setup("ask");
    const pending = broker.execute("agent-a", "req-1", request);
    await Promise.resolve();
    expect(backend.calls).toBe(0);
    expect(broker.pendingCount).toBe(1);
    expect(approvals).toEqual([expect.objectContaining({
      requestId: "req-1",
      agentId: "agent-a",
      request,
      expiresAtMs: expect.any(Number),
    })]);
    expect(broker.resolve("req-1", "allow")).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(backend.calls).toBe(1);
    expect(broker.pendingCount).toBe(0);
  });

  it("fixa a aprovação à conversa que originou a execução", async () => {
    const { approvals, broker } = setup("ask");
    const pending = broker.execute("agent-a", "req-conversation", request, undefined, { conversationId: "conversation-a" });
    await Promise.resolve();

    expect(approvals[0]).toMatchObject({
      requestId: "req-conversation",
      agentId: "agent-a",
      conversationId: "conversation-a",
    });
    expect(broker.peekPendingApproval("req-conversation", "agent-a")).toMatchObject({
      conversationId: "conversation-a",
      request,
    });

    broker.resolve("req-conversation", "deny", "agent-a");
    await pending;
  });

  it("executa a cópia aprovada mesmo se o chamador ou callback mutarem o request", async () => {
    const seen: ExecutionRequest[] = [];
    const backend: ExecutionBackend = { execute: async (input) => { seen.push(input); return { ok: true, operation: "file.list", entries: [] }; } };
    const mutable: ExecutionRequest = { operation: "file.list", path: "safe" };
    const broker = new LocalExecutionBroker(backend, () => "ask", (approval) => { (approval.request as { path: string }).path = "callback"; });
    const pending = broker.execute("a", "immutable", mutable);
    mutable.path = "caller";
    broker.resolve("immutable", "allow");
    await pending;
    expect(seen).toEqual([{ operation: "file.list", path: "safe" }]);
  });

  it("sem callback aguarda resolução externa pelo requestId", async () => {
    const backend = new FakeBackend();
    const broker = new LocalExecutionBroker(backend, () => "ask");
    const pending = broker.execute("agent-a", "external-1", request);
    expect(broker.pendingRequestIds()).toEqual(["external-1"]);
    expect(backend.calls).toBe(0);
    expect(broker.resolve("external-1", "allow")).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(backend.calls).toBe(1);
  });

  it("aprovação externa expira com negação em vez de esperar indefinidamente", async () => {
    const backend = new FakeBackend();
    const broker = new LocalExecutionBroker(backend, () => "ask", undefined, 10);
    await expect(broker.execute("agent-a", "timeout-1", request)).resolves.toMatchObject({
      ok: false,
      code: "permission_denied",
      message: "Approval request timed out.",
    });
    expect(broker.pendingCount).toBe(0);
    expect(backend.calls).toBe(0);
    expect(broker.resolutionStatus("timeout-1", "allow", "agent-a")).toBe("expired");
  });

  it("deny e never nunca executam", async () => {
    const asked = setup("ask");
    const pending = asked.broker.execute("a", "deny", request);
    expect(asked.broker.resolve("deny", "deny")).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: false, code: "permission_denied" });
    expect(asked.backend.calls).toBe(0);

    const disabled = setup("never");
    await expect(disabled.broker.execute("a", "never", request)).resolves.toMatchObject({ ok: false, code: "permission_denied" });
    expect(disabled.backend.calls).toBe(0);
    expect(disabled.approvals).toEqual([]);
  });

  it("não resolve aprovação de outro agente", async () => {
    const { backend, broker } = setup("ask");
    const pending = broker.execute("agent-a", "cross-agent", request);
    expect(broker.resolve("cross-agent", "allow", "agent-b")).toBe(false);
    expect(backend.calls).toBe(0);
    expect(broker.resolve("cross-agent", "allow", "agent-a")).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("isola o mesmo requestId entre agentes diferentes", async () => {
    const { backend, approvals, broker } = setup("ask");
    const first = broker.execute("agent-a", "shared-id", request);
    const second = broker.execute("agent-b", "shared-id", request);

    expect(approvals.map(({ agentId }) => agentId)).toEqual(["agent-a", "agent-b"]);
    expect(broker.pendingCount).toBe(2);
    expect(broker.resolve("shared-id", "allow", "agent-a")).toBe(true);
    expect(broker.resolve("shared-id", "allow", "agent-b")).toBe(true);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(backend.calls).toBe(2);
  });

  it("per-request ask override does not change the global always policy", async () => {
    const whatsapp: ExecutionRequest = { operation: "whatsapp", op: "doctor" };
    const backend: ExecutionBackend = {
      async execute(input) {
        if (input.operation === "whatsapp") {
          return {
            ok: true,
            operation: "whatsapp",
            op: "doctor",
            stdout: "{}",
            stderr: "",
            exitCode: 0,
            durationMs: 1,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        return { ok: true, operation: "file.list", entries: [] };
      },
    };
    const approvals: ExecutionApprovalRequest[] = [];
    const broker = new LocalExecutionBroker(backend, () => "always", (approval) => approvals.push(approval));
    const listed = broker.execute("bot", "file-1", request);
    await expect(listed).resolves.toMatchObject({ ok: true, operation: "file.list" });
    expect(approvals).toHaveLength(0);
    const pending = broker.execute("bot", "wa-1", whatsapp, undefined, { permission: "ask" });
    expect(approvals[0]?.request).toEqual(whatsapp);
    expect(broker.peekPending("wa-1", "bot")).toEqual(whatsapp);
    expect(broker.resolve("wa-1", "allow", "bot")).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true, operation: "whatsapp" });
  });

  it("never global ganha de override always do WhatsApp", async () => {
    const { backend, broker, approvals } = setup("never");
    const whatsapp: ExecutionRequest = { operation: "whatsapp", op: "doctor" };
    await expect(broker.execute("bot", "wa-never", whatsapp, undefined, { permission: "always" }))
      .resolves.toMatchObject({ ok: false, code: "permission_denied", message: "Local tools are disabled." });
    expect(backend.calls).toBe(0);
    expect(approvals).toEqual([]);
  });

  it("notifica expiração da aprovação pendente", async () => {
    const expired: ExecutionApprovalRequest[] = [];
    const backend = new FakeBackend();
    const broker = new LocalExecutionBroker(backend, () => "ask", undefined, 10);
    broker.setApprovalExpiryListener((approval) => expired.push(approval));
    await expect(broker.execute("agent-a", "timeout-exp", request)).resolves.toMatchObject({
      ok: false,
      code: "permission_denied",
      message: "Approval request timed out.",
    });
    expect(expired).toEqual([expect.objectContaining({ requestId: "timeout-exp", agentId: "agent-a" })]);
    expect(backend.calls).toBe(0);
  });

  it("revoga allow pendente quando a política muda para never", async () => {
    const state = setup("ask");
    const pending = state.broker.execute("agent-a", "revoked", request);
    state.setPolicy("never");
    expect(state.broker.resolve("revoked", "allow", "agent-a")).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: false, code: "permission_denied" });
    expect(state.backend.calls).toBe(0);
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
    const broker = new LocalExecutionBroker(backend, () => "always");

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
    }, () => "always");

    const first = await broker.execute("a", "failed-idempotent", request);
    const retry = await broker.execute("a", "failed-idempotent", { ...request });
    const collision = await broker.execute("a", "failed-idempotent", { operation: "file.list", path: "other" });

    expect(retry).toEqual(first);
    expect(collision).toMatchObject({ ok: false, code: "permission_denied" });
    expect(calls).toBe(1);
  });

  it("falha fechado quando o mesmo requestId reaparece com outro payload", async () => {
    const { backend, broker } = setup("always");
    await expect(broker.execute("a", "collision", request)).resolves.toMatchObject({ ok: true });
    await expect(broker.execute("a", "collision", { operation: "file.list", path: "other" }))
      .resolves.toMatchObject({ ok: false, code: "permission_denied" });
    expect(backend.calls).toBe(1);
  });

  it("normaliza valor inválido resolvido pelo backend", async () => {
    const broker = new LocalExecutionBroker(
      { execute: async () => undefined as unknown as ExecutionResult },
      () => "always",
    );
    await expect(broker.execute("a", "invalid-result", request)).resolves.toMatchObject({
      ok: false,
      operation: "file.list",
      code: "io_error",
    });
  });

  it("rejeita sucesso com shape incompleto para a operação", async () => {
    const broker = new LocalExecutionBroker(
      { execute: async () => ({ ok: true, operation: "file.list" }) as unknown as ExecutionResult },
      () => "always",
    );
    await expect(broker.execute("a", "invalid-list", request)).resolves.toMatchObject({
      ok: false,
      operation: "file.list",
      code: "io_error",
    });
  });

  it("always executa imediatamente uma vez", async () => {
    const { backend, broker } = setup("always");
    await expect(broker.execute("a", "always", request)).resolves.toMatchObject({ ok: true });
    expect(backend.calls).toBe(1);
  });

  it("abort remove pedido pendente sem executar", async () => {
    const { backend, broker } = setup("ask");
    const controller = new AbortController();
    const pending = broker.execute("a", "abort", request, controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, code: "aborted" });
    expect(backend.calls).toBe(0);
    expect(broker.pendingCount).toBe(0);
    expect(broker.resolve("abort", "allow")).toBe(false);
  });

  it("rejeita requestId duplicado sem negar quando o callback de UI falha", async () => {
    const state = setup("ask");
    const first = state.broker.execute("a", "same", request);
    await expect(state.broker.execute("a", "same", request)).resolves.toMatchObject({ ok: false, code: "permission_denied" });
    state.broker.resolve("same", "deny");
    await first;

    const broken = new LocalExecutionBroker(state.backend, () => "ask", () => { throw new Error("boom"); });
    const pending = broken.execute("a", "broken", request);
    expect(broken.pendingCount).toBe(1);
    expect(broken.resolve("broken", "allow", "a")).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("resolve um backend por agentId quando o construtor recebe fábrica", async () => {
    const seen: string[] = [];
    const backends = new Map<string, FakeBackend>();
    const broker = new LocalExecutionBroker(
      (agentId) => {
        seen.push(agentId);
        const existing = backends.get(agentId);
        if (existing) return existing;
        const next = new FakeBackend();
        backends.set(agentId, next);
        return next;
      },
      () => "always",
      () => {},
    );
    await broker.execute("agent-a", "r1", request);
    await broker.execute("agent-b", "r2", request);
    expect(seen).toEqual(["agent-a", "agent-b"]);
    expect(backends.get("agent-a")?.calls).toBe(1);
    expect(backends.get("agent-b")?.calls).toBe(1);
  });

  it("always devolve io_error se a fábrica do backend rejeitar", async () => {
    const broker = new LocalExecutionBroker(
      () => Promise.reject(new Error("home.json corrompido")),
      () => "always",
      () => {},
    );
    await expect(broker.execute("openbot-default", "boom", request)).resolves.toMatchObject({
      ok: false,
      code: "io_error",
    });
  });
});
