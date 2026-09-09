import { describe, expect, it, vi } from "vitest";

import {
  RuntimeManager,
  RuntimeManagerError,
  type RuntimeDriver,
  type RuntimeLeaseRequest,
} from "../src/execution/runtime/manager.js";
import { MemoryRuntimeLeaseJournal } from "../src/execution/runtime/recovery.js";
import { RuntimeScheduler } from "../src/execution/runtime/scheduler.js";
import type {
  RuntimeBoot,
  RuntimeCapability,
  RuntimeDriverLease,
  RuntimeHealth,
} from "../src/execution/runtime/contracts.js";

class FakeDriver implements RuntimeDriver {
  starts = 0;
  stops = 0;
  acquired: RuntimeLeaseRequest[] = [];
  released: string[] = [];
  nextBoot = 1;
  healthState: RuntimeHealth = { ok: true };
  releaseFailures = 0;

  async start(): Promise<RuntimeBoot> {
    this.starts += 1;
    return { runtimeBootId: `boot-${this.nextBoot++}`, runtimeVersion: "test", imageDigest: "sha256:test" };
  }

  async health(): Promise<RuntimeHealth> {
    return this.healthState;
  }

  async acquire(request: RuntimeLeaseRequest): Promise<RuntimeDriverLease> {
    this.acquired.push(request);
    return { sandboxId: `sandbox-${this.acquired.length}` };
  }

  async release(lease: RuntimeDriverLease): Promise<void> {
    if (lease.leaseId === undefined) throw new Error("fake driver lease id is missing");
    if (this.releaseFailures > 0) {
      this.releaseFailures -= 1;
      throw new Error("driver release failed");
    }
    this.released.push(lease.leaseId);
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }
}

class BlockingStartDriver extends FakeDriver {
  readonly startGate = deferred<void>();

  override async start(): Promise<RuntimeBoot> {
    await this.startGate.promise;
    return super.start();
  }
}

class BlockingStartAndStopDriver extends BlockingStartDriver {
  readonly stopGate = deferred<void>();
  readonly stopStarted = deferred<void>();

  override async stop(): Promise<void> {
    this.stopStarted.resolve();
    await this.stopGate.promise;
    return super.stop();
  }
}

class BlockingHealthDriver extends FakeDriver {
  readonly healthStarted = deferred<void>();

  override async health(): Promise<RuntimeHealth> {
    this.healthStarted.resolve();
    return new Promise<RuntimeHealth>(() => undefined);
  }
}

class GatedHealthDriver extends FakeDriver {
  readonly healthGate = deferred<RuntimeHealth>();
  readonly healthStarted = deferred<void>();

  override async health(): Promise<RuntimeHealth> {
    this.healthStarted.resolve();
    return this.healthGate.promise;
  }
}

class BlockingAcquireDriver extends FakeDriver {
  readonly acquireGate = deferred<RuntimeDriverLease>();
  readonly acquireStarted = deferred<void>();

  override async acquire(request: RuntimeLeaseRequest): Promise<RuntimeDriverLease> {
    this.acquired.push(request);
    this.acquireStarted.resolve();
    return this.acquireGate.promise;
  }
}

class AcquireFailureDriver extends FakeDriver {
  compensated: RuntimeLeaseRequest[] = [];

  override async acquire(_request: RuntimeLeaseRequest): Promise<RuntimeDriverLease> {
    throw new Error("guest response lost after lease commit");
  }

  async compensateAcquire(request: RuntimeLeaseRequest): Promise<void> {
    this.compensated.push(request);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class JournalThatFailsOnce extends MemoryRuntimeLeaseJournal {
  private puts = 0;

  override async put(record: Parameters<MemoryRuntimeLeaseJournal["put"]>[0]): Promise<void> {
    this.puts += 1;
    if (this.puts === 2) throw new Error("journal write failed");
    await super.put(record);
  }
}

const capability = (): RuntimeCapability => ({ kind: "process.run", networkProfile: "none" });

describe("RuntimeManager", () => {
  it("inicia o runtime uma vez para ensures concorrentes e só publica ready após health", async () => {
    const driver = new GatedHealthDriver();
    const manager = new RuntimeManager({ driver });

    let firstSettled = false;
    let secondSettled = false;
    const firstEnsure = manager.ensure("agent-a", "developer").then((status) => {
      firstSettled = true;
      return status;
    });
    const secondEnsure = manager.ensure("agent-a", "developer").then((status) => {
      secondSettled = true;
      return status;
    });
    await driver.healthStarted.promise;

    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    expect((await manager.status("agent-a")).state).toBe("starting");

    driver.healthGate.resolve({ ok: true });
    const [first, second] = await Promise.all([firstEnsure, secondEnsure]);

    expect(first.state).toBe("ready");
    expect(second.runtimeBootId).toBe(first.runtimeBootId);
    expect(driver.starts).toBe(1);
    expect((await manager.status("agent-a")).state).toBe("ready");
    await manager.close();
  });

  it("invalida um startup pendente quando stop acontece antes do boot", async () => {
    const driver = new BlockingStartDriver();
    const manager = new RuntimeManager({ driver });

    const ensuring = manager.ensure("agent-a", "developer");
    await Promise.resolve();
    const stopping = manager.stop("agent-a", "manual");
    driver.startGate.resolve();

    const [stopped, ensured] = await Promise.all([stopping, ensuring]);
    expect(stopped.state).toBe("stopped");
    expect(ensured.state).toBe("stopped");
    expect(driver.stops).toBe(1);
    expect((await manager.status("agent-a")).state).toBe("stopped");
    await manager.close();
  });

  it("não deixa um health travado impedir o cancelamento do startup", async () => {
    const driver = new BlockingHealthDriver();
    const manager = new RuntimeManager({ driver });

    const ensuring = manager.ensure("agent-a", "developer");
    await driver.healthStarted.promise;

    await expect(manager.stop("agent-a", "manual")).resolves.toMatchObject({ state: "stopped" });
    await expect(ensuring).resolves.toMatchObject({ state: "stopped" });
    expect(driver.stops).toBe(1);
    await manager.close();
  });

  it("abre uma nova geração quando ensure chega após invalidar o startup", async () => {
    const driver = new BlockingStartDriver();
    const manager = new RuntimeManager({ driver });

    const first = manager.ensure("agent-a", "developer");
    await Promise.resolve();
    const stopping = manager.stop("agent-a", "manual");
    const second = manager.ensure("agent-a", "developer");
    driver.startGate.resolve();

    await expect(stopping).resolves.toMatchObject({ state: "stopped" });
    await expect(first).resolves.toMatchObject({ state: "stopped" });
    await expect(second).resolves.toMatchObject({ state: "ready" });
    expect(driver.starts).toBe(2);
    expect(driver.stops).toBe(1);
    await manager.close();
  });

  it("só resolve stop depois do cleanup de um boot tardio", async () => {
    const driver = new BlockingStartAndStopDriver();
    const manager = new RuntimeManager({ driver });

    const ensuring = manager.ensure("agent-a", "developer");
    await Promise.resolve();
    const stopping = manager.stop("agent-a", "manual");
    driver.startGate.resolve();
    await driver.stopStarted.promise;

    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    driver.stopGate.resolve();
    await expect(stopping).resolves.toMatchObject({ state: "stopped" });
    await expect(ensuring).resolves.toMatchObject({ state: "stopped" });
    expect(driver.stops).toBe(1);
    await manager.close();
  });

  it("aguarda acquire pendente antes de parar e não publica lease após stop", async () => {
    const driver = new BlockingAcquireDriver();
    const manager = new RuntimeManager({ driver });

    const acquiring = manager.acquire("agent-a", capability());
    await driver.acquireStarted.promise;
    const stopping = manager.stop("agent-a", "manual");
    let stopSettled = false;
    void stopping.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    driver.acquireGate.resolve({ sandboxId: "late-sandbox" });
    await expect(acquiring).rejects.toMatchObject({ code: "runtime_unavailable" });
    await expect(stopping).resolves.toMatchObject({ state: "stopped" });
    expect(driver.released).toHaveLength(1);
    expect((await manager.status("agent-a")).activeLeaseCount).toBe(0);
    expect(driver.stops).toBe(1);
    await manager.close();
  });

  it("libera lease tardio quando acquire ignora abort", async () => {
    const driver = new BlockingAcquireDriver();
    const manager = new RuntimeManager({ driver });
    const controller = new AbortController();

    const acquiring = manager.acquire("agent-a", capability(), controller.signal);
    await driver.acquireStarted.promise;
    controller.abort();
    driver.acquireGate.resolve({ sandboxId: "aborted-sandbox" });

    await expect(acquiring).rejects.toMatchObject({ name: "AbortError" });
    expect(driver.released).toHaveLength(1);
    expect((await manager.status("agent-a")).activeLeaseCount).toBe(0);
    await manager.close();
  });

  it("falha fechado quando o health check não passa", async () => {
    const driver = new FakeDriver();
    driver.healthState = { ok: false, code: "runtime_unhealthy", message: "guest unhealthy" };
    const manager = new RuntimeManager({ driver });

    const status = await manager.ensure("agent-a", "developer");

    expect(status.state).toBe("unhealthy");
    await expect(manager.acquire("agent-a", capability())).rejects.toMatchObject({ code: "runtime_unhealthy" });
  });

  it("vincula leases ao agente e não permite adquirir depois do fence", async () => {
    const driver = new FakeDriver();
    const manager = new RuntimeManager({ driver });

    const a = await manager.acquire("agent-a", capability());
    const b = await manager.acquire("agent-b", capability());
    expect(a.agentId).toBe("agent-a");
    expect(b.agentId).toBe("agent-b");
    expect(a.leaseId).not.toBe(b.leaseId);
    expect(driver.acquired.map((entry) => entry.agentId)).toEqual(["agent-a", "agent-b"]);

    manager.fenceAgent("agent-a");
    await expect(manager.acquire("agent-a", capability())).rejects.toMatchObject({ code: "agent_fenced" });
    await expect(manager.acquire("agent-b", capability())).resolves.toBeDefined();
  });

  it("libera o sandbox do lease e para o runtime quando o agente é removido", async () => {
    const driver = new FakeDriver();
    const manager = new RuntimeManager({ driver });
    const lease = await manager.acquire("agent-a", capability());

    const finalStatus = await manager.stop("agent-a", "agent-delete");

    expect(driver.released).toEqual([lease.leaseId]);
    expect(driver.stops).toBe(1);
    expect(finalStatus.state).toBe("stopped");
    expect((await manager.status("agent-a")).state).toBe("lite-ready");
    await expect(manager.acquire("agent-a", capability())).rejects.toMatchObject({ code: "agent_fenced" });
  });

  it("mantém lease e capacidade para retry quando o teardown falha", async () => {
    const driver = new FakeDriver();
    driver.releaseFailures = 1;
    const manager = new RuntimeManager({ driver, maxActiveLeases: 1 });
    const lease = await manager.acquire("agent-a", capability());

    await expect(lease.release()).rejects.toMatchObject({ code: "runtime_unhealthy" });
    expect(lease.released).toBe(false);
    expect((await manager.status("agent-a")).activeLeaseCount).toBe(1);

    await lease.release();
    expect(lease.released).toBe(true);
    expect((await manager.status("agent-a")).activeLeaseCount).toBe(0);
    expect(driver.released).toEqual([lease.leaseId]);
    await manager.close();
  });

  it("preserva no journal um acquire que não conseguiu compensar o guest", async () => {
    const driver = new FakeDriver();
    driver.releaseFailures = 1;
    const journal = new JournalThatFailsOnce();
    const manager = new RuntimeManager({ driver, journal });

    await expect(manager.acquire("agent-a", capability())).rejects.toMatchObject({ code: "runtime_unhealthy" });
    await expect(journal.list()).resolves.toHaveLength(1);
    await manager.close();
  });

  it("chama a compensação opcional quando acquire falha antes de devolver a identidade", async () => {
    const driver = new AcquireFailureDriver();
    const manager = new RuntimeManager({ driver });

    await expect(manager.acquire("agent-a", capability())).rejects.toMatchObject({ code: "runtime_protocol_error" });
    expect(driver.compensated).toHaveLength(1);
    expect(driver.compensated[0]).toMatchObject({ agentId: "agent-a", capability: capability() });
    await manager.close();
  });

  it("release é idempotente e close encerra todos os leases", async () => {
    const driver = new FakeDriver();
    const manager = new RuntimeManager({ driver });
    const releasedExplicitly = await manager.acquire("agent-a", capability());
    const releasedByClose = await manager.acquire("agent-b", capability());

    await releasedExplicitly.release();
    await releasedExplicitly.release();
    await manager.close();

    expect(releasedExplicitly.released).toBe(true);
    expect(releasedByClose.released).toBe(true);
    expect(driver.released).toEqual([releasedExplicitly.leaseId, releasedByClose.leaseId]);
    expect(driver.stops).toBe(1);
    expect((await manager.status("agent-a")).state).toBe("stopped");
  });

  it("permite repetir close quando a liberação de um lease falha", async () => {
    const driver = new FakeDriver();
    driver.releaseFailures = 1;
    const manager = new RuntimeManager({ driver });
    const lease = await manager.acquire("agent-a", capability());

    await expect(manager.close()).rejects.toMatchObject({ code: "runtime_unhealthy" });
    expect(lease.released).toBe(false);
    await expect(manager.acquire("agent-b", capability())).rejects.toMatchObject({ code: "runtime_closed" });

    await expect(manager.close()).resolves.toBeUndefined();
    expect(lease.released).toBe(true);
    expect(driver.released).toEqual([lease.leaseId]);
    expect(driver.stops).toBe(1);
  });

  it("grava pending no journal antes de pedir o lease ao guest e o completa depois", async () => {
    const driver = new BlockingAcquireDriver();
    const journal = new MemoryRuntimeLeaseJournal();
    const manager = new RuntimeManager({ driver, journal });

    const acquire = manager.acquire("agent-a", capability());
    await driver.acquireStarted.promise;
    const pending = await journal.list();
    expect(pending).toMatchObject([{
      agentId: "agent-a",
      runtimeBootId: "boot-1",
      pending: true,
    }]);
    expect(pending[0]).not.toHaveProperty("sandboxId");

    driver.acquireGate.resolve({ sandboxId: "sandbox-from-guest" });
    const lease = await acquire;
    await expect(journal.list()).resolves.toMatchObject([{
      leaseId: lease.leaseId,
      sandboxId: "sandbox-from-guest",
    }]);
    await lease.release();
    await manager.close();
  });

  it("registra e remove leases no journal para recuperação após crash", async () => {
    const journal = new MemoryRuntimeLeaseJournal();
    const manager = new RuntimeManager({ driver: new FakeDriver(), journal });
    const lease = await manager.acquire("agent-a", capability());
    await expect(journal.list()).resolves.toMatchObject([{ leaseId: lease.leaseId, agentId: "agent-a", sandboxId: lease.sandboxId }]);
    await lease.release();
    await expect(journal.list()).resolves.toEqual([]);
  });

  it("repair falha fechado até nova prova, preserva journal e só então fica ready", async () => {
    const journal = new MemoryRuntimeLeaseJournal();
    await journal.put({
      leaseId: "stale",
      agentId: "agent-a",
      runtimeBootId: "boot-old",
      sandboxId: "sandbox-stale",
      temporaryId: "tmp-stale",
    });
    const driver = new FakeDriver();
    let proofPasses = false;
    const manager = new RuntimeManager({
      driver,
      journal,
      reconciler: {
        killSandbox: async () => {
          if (!proofPasses) throw new Error("proof missing");
        },
        removeTemporary: async () => undefined,
      },
    });

    await expect(manager.recover("boot-1")).resolves.toMatchObject({ complete: false });
    await expect(manager.ensure("agent-a", "developer")).resolves.toMatchObject({ state: "repair-required" });
    await expect(manager.acquire("agent-a", capability())).rejects.toMatchObject({ code: "runtime_unhealthy" });
    expect(driver.starts).toBe(0);

    await expect(manager.repair("agent-a")).resolves.toMatchObject({
      agentId: "agent-a",
      state: "repair-required",
      lastError: { code: "runtime_unhealthy", message: "Runtime recovery requires repair." },
    });
    expect(driver.starts).toBe(1);
    await expect(journal.list()).resolves.toHaveLength(1);
    await expect(manager.acquire("agent-a", capability())).rejects.toMatchObject({ code: "runtime_unhealthy" });

    proofPasses = true;
    await expect(manager.repair("agent-a")).resolves.toMatchObject({ agentId: "agent-a", state: "ready", runtimeBootId: "boot-2" });
    expect(driver.starts).toBe(2);
    await expect(journal.list()).resolves.toEqual([]);
    const lease = await manager.acquire("agent-a", capability());
    await lease.release();
    await manager.close();
  });

  it("repair retorna status do agente solicitado mesmo quando outro agente foi registrado primeiro", async () => {
    const driver = new FakeDriver();
    driver.healthState = { ok: false, code: "runtime_unhealthy", message: "guest unhealthy" };
    const manager = new RuntimeManager({ driver });
    await manager.status("first-agent");
    await manager.ensure("first-agent", "developer");
    driver.healthState = { ok: true };

    await expect(manager.repair("requested-agent")).resolves.toMatchObject({
      agentId: "requested-agent",
      mode: "developer",
      state: "ready",
    });
    await manager.close();
  });

  it("rejeita capabilities ainda não implementadas", async () => {
    const manager = new RuntimeManager({ driver: new FakeDriver() });
    await expect(manager.acquire("agent-a", { kind: "browser.start" } as never)).rejects.toMatchObject({
      name: "RuntimeManagerError",
      code: "unsupported_capability",
    } satisfies Partial<RuntimeManagerError>);
    await manager.close();
  });

  it("limita dois leases por agente sem bloquear capacidade de outro agente", async () => {
    const scheduler = new RuntimeScheduler({ maxActiveLeases: 4, maxActiveLeasesPerOwner: 2, admissionTimeoutMs: 100 });
    await scheduler.reserveOrWaitFor("a-1", "agent-a");
    await scheduler.reserveOrWaitFor("a-2", "agent-a");
    let thirdSettled = false;
    const third = scheduler.reserveOrWaitFor("a-3", "agent-a").then(() => { thirdSettled = true; });
    await Promise.resolve();
    expect(thirdSettled).toBe(false);

    await expect(scheduler.reserveOrWaitFor("b-1", "agent-b")).resolves.toBeUndefined();
    scheduler.release("a-1");
    await third;
    scheduler.release("a-2");
    scheduler.release("a-3");
    scheduler.release("b-1");
  });

  it("aplica o cap por agente no acquire sem consumir slots dos outros", async () => {
    const manager = new RuntimeManager({
      driver: new FakeDriver(),
      maxActiveLeases: 4,
      maxActiveLeasesPerAgent: 2,
      admissionTimeoutMs: 100,
    });
    const first = await manager.acquire("agent-a", capability());
    const second = await manager.acquire("agent-a", capability());
    const waiting = manager.acquire("agent-a", capability());
    const other = await manager.acquire("agent-b", capability());

    expect(other.agentId).toBe("agent-b");
    await first.release();
    await expect(waiting).resolves.toMatchObject({ agentId: "agent-a" });
    await second.release();
    await other.release();
    await manager.close();
  });

  it("limita leases ativos e libera a capacidade após release", async () => {
    const driver = new FakeDriver();
    const manager = new RuntimeManager({ driver, maxActiveLeases: 1, maxQueuedLeases: 1 });
    const first = await manager.acquire("agent-a", capability());

    const waiting = manager.acquire("agent-b", capability());
    await expect(manager.acquire("agent-c", capability())).rejects.toMatchObject({ code: "runtime_capacity_exceeded" });
    await first.release();
    const second = await waiting;

    expect(second.agentId).toBe("agent-b");
    await second.release();
    await manager.close();
  });

  it("aguarda o quinto lease em ordem FIFO até uma capacidade ficar disponível", async () => {
    const driver = new FakeDriver();
    const manager = new RuntimeManager({ driver });
    const leases = await Promise.all([
      manager.acquire("agent-1", capability()),
      manager.acquire("agent-2", capability()),
      manager.acquire("agent-3", capability()),
      manager.acquire("agent-4", capability()),
    ]);

    const admitted: string[] = [];
    const fifth = manager.acquire("agent-5", capability()).then((lease) => {
      admitted.push(lease.agentId);
      return lease;
    });
    let sixthSettled = false;
    const sixth = manager.acquire("agent-6", capability()).then((lease) => {
      sixthSettled = true;
      admitted.push(lease.agentId);
      return lease;
    });
    await Promise.resolve();
    expect(admitted).toEqual([]);

    await leases[0].release();
    const fifthLease = await fifth;
    expect(fifthLease.agentId).toBe("agent-5");
    expect(sixthSettled).toBe(false);
    expect(admitted).toEqual(["agent-5"]);

    await leases[1].release();
    await expect(sixth).resolves.toMatchObject({ agentId: "agent-6" });
    expect(admitted).toEqual(["agent-5", "agent-6"]);
    await manager.close();
  });

  it("cancela uma admissão enfileirada e não consome capacidade", async () => {
    const driver = new FakeDriver();
    const manager = new RuntimeManager({ driver, maxActiveLeases: 1, admissionTimeoutMs: 100 });
    const first = await manager.acquire("agent-a", capability());
    const controller = new AbortController();
    const pending = manager.acquire("agent-b", capability(), controller.signal);
    const following = manager.acquire("agent-c", capability());

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect((await manager.status("agent-a")).activeLeaseCount).toBe(1);
    await first.release();
    const admitted = await following;
    expect(admitted.agentId).toBe("agent-c");
    expect(driver.acquired.map((request) => request.agentId)).toEqual(["agent-a", "agent-c"]);
    await manager.close();
  });

  it("revalida o fence do agente quando uma admissão deixa a fila", async () => {
    const driver = new FakeDriver();
    const manager = new RuntimeManager({ driver, maxActiveLeases: 1 });
    const first = await manager.acquire("agent-a", capability());
    const waiting = manager.acquire("agent-b", capability());

    await manager.stop("agent-b", "agent-delete");
    await first.release();
    await expect(waiting).rejects.toMatchObject({ code: "agent_fenced" });
    await manager.close();
  });

  it("faz o segundo ensure observar abort enquanto o primeiro startup continua compartilhado", async () => {
    const driver = new BlockingStartDriver();
    const manager = new RuntimeManager({ driver });
    const first = manager.ensure("agent-a", "developer");
    await Promise.resolve();
    const controller = new AbortController();
    const second = manager.ensure("agent-a", "developer", controller.signal);
    controller.abort();

    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    driver.startGate.resolve(undefined);
    await expect(first).resolves.toMatchObject({ state: "ready" });
    await manager.close();
  });

  it("usa keep-warm padrão de cinco minutos", async () => {
    const manager = new RuntimeManager({ driver: new FakeDriver() });
    expect((manager as unknown as { idleStopMs: number }).idleStopMs).toBe(5 * 60_000);
    await manager.close();
  });

  it("mantém o runtime quente e para WSL após o idle configurado", async () => {
    vi.useFakeTimers();
    const driver = new FakeDriver();
    const manager = new RuntimeManager({ driver, idleStopMs: 5 });
    try {
      const lease = await manager.acquire("agent-a", capability());
      await lease.release();

      expect(driver.stops).toBe(0);
      await vi.advanceTimersByTimeAsync(5);
      expect(driver.stops).toBe(1);
      expect((await manager.status("agent-a")).state).toBe("stopped");
      await manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("varre leases expirados sem exigir novo acquire ou status", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const driver = new FakeDriver();
    const manager = new RuntimeManager({ driver, now: () => now, leaseTtlMs: 10, leaseSweepIntervalMs: 5 });
    try {
      const active = await manager.acquire("agent-a", capability());

      now = 1_010;
      await vi.advanceTimersByTimeAsync(5);
      expect(active.released).toBe(true);
      expect(driver.released).toEqual([active.leaseId]);
      await manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("expira lease, libera o driver e devolve a capacidade", async () => {
    let now = 1_000;
    const driver = new FakeDriver();
    const manager = new RuntimeManager({ driver, now: () => now, leaseTtlMs: 10, maxActiveLeases: 1 });
    const first = await manager.acquire("agent-a", capability());

    now = 1_010;
    const status = await manager.status("agent-a");

    expect(first.released).toBe(true);
    expect(status.activeLeaseCount).toBe(0);
    expect(driver.released).toEqual([first.leaseId]);
    const second = await manager.acquire("agent-b", capability());
    await second.release();
    await manager.close();
  });
});
