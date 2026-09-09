import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileRuntimeLeaseJournal,
  MemoryRuntimeLeaseJournal,
  reconcileRuntimeLeases,
  type RuntimeResourceReconciler,
} from "../src/execution/runtime/recovery.js";

const record = (leaseId: string) => ({
  leaseId,
  agentId: "agent-a",
  runtimeBootId: "old-boot",
  sandboxId: `sandbox-${leaseId}`,
  temporaryId: `tmp-${leaseId}`,
});

describe("runtime recovery", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("mata recursos órfãos e remove somente temporários identificados pelo lease", async () => {
    const journal = new MemoryRuntimeLeaseJournal([record("lease-1")]);
    const killed: string[] = [];
    const removed: string[] = [];
    const reconciler: RuntimeResourceReconciler = {
      killSandbox: async (sandboxId) => { killed.push(sandboxId); },
      removeTemporary: async (temporaryId) => { removed.push(temporaryId); },
    };

    const result = await reconcileRuntimeLeases(journal, "new-boot", reconciler);

    expect(result).toEqual({ inspected: 1, cleaned: 1, failed: 0, complete: true });
    expect(killed).toEqual(["sandbox-lease-1"]);
    expect(removed).toEqual(["tmp-lease-1"]);
    await expect(journal.list()).resolves.toEqual([]);
  });

  it("reconcilia pending sem sandbox pelo reconciliador de identidade completa", async () => {
  const pending = {
    leaseId: "lease-pending",
    agentId: "agent-a",
    runtimeBootId: "old-boot",
    temporaryId: "tmp-lease-pending",
    pending: true as const,
  };
  const journal = new MemoryRuntimeLeaseJournal([pending]);
  const seen: unknown[] = [];

  await expect(reconcileRuntimeLeases(journal, "new-boot", {
    reconcileLease: async (candidate) => { seen.push(candidate); },
    killSandbox: async () => { throw new Error("legacy cleanup must not run"); },
    removeTemporary: async () => { throw new Error("legacy cleanup must not run"); },
  })).resolves.toEqual({ inspected: 1, cleaned: 1, failed: 0, complete: true });
  expect(seen).toEqual([pending]);
  await expect(journal.list()).resolves.toEqual([]);
});

it("preserva pending quando reconciliador não sabe compensar por leaseId", async () => {
  const pending = {
    leaseId: "lease-pending",
    agentId: "agent-a",
    runtimeBootId: "old-boot",
    temporaryId: "tmp-lease-pending",
    pending: true as const,
  };
  const journal = new MemoryRuntimeLeaseJournal([pending]);

  await expect(reconcileRuntimeLeases(journal, "new-boot", {
    killSandbox: async () => undefined,
    removeTemporary: async () => undefined,
  })).resolves.toEqual({ inspected: 1, cleaned: 0, failed: 1, complete: false });
  await expect(journal.list()).resolves.toEqual([pending]);
});

it("preserva o registro quando o teardown falha e sinaliza reparo", async () => {
    const journal = new MemoryRuntimeLeaseJournal([record("lease-2")]);
    const reconciler: RuntimeResourceReconciler = {
      killSandbox: async () => { throw new Error("private detail"); },
      removeTemporary: async () => undefined,
    };

    await expect(reconcileRuntimeLeases(journal, "new-boot", reconciler)).resolves.toEqual({
      inspected: 1,
      cleaned: 0,
      failed: 1,
      complete: false,
    });
    await expect(journal.list()).resolves.toHaveLength(1);
  });

  it("não toca leases do boot atual e limpa duas vezes de forma idempotente", async () => {
    const journal = new MemoryRuntimeLeaseJournal([
      { ...record("current"), runtimeBootId: "current-boot" },
      record("old"),
    ]);
    const killed = new Set<string>();
    const removed = new Set<string>();
    const reconciler: RuntimeResourceReconciler = {
      killSandbox: async (sandboxId) => {
        if (killed.has(sandboxId)) throw Object.assign(new Error("already gone"), { code: "ESRCH" });
        killed.add(sandboxId);
      },
      removeTemporary: async (temporaryId) => {
        if (removed.has(temporaryId)) throw Object.assign(new Error("already gone"), { code: "ENOENT" });
        removed.add(temporaryId);
      },
    };

    await expect(reconcileRuntimeLeases(journal, "current-boot", reconciler)).resolves.toMatchObject({
      inspected: 2,
      cleaned: 1,
      failed: 0,
      complete: true,
    });
    await expect(journal.list()).resolves.toEqual([record("current")].map((item) => ({ ...item, runtimeBootId: "current-boot" })));
    const second = await reconcileRuntimeLeases(journal, "new-boot", reconciler);
    expect(second).toMatchObject({ inspected: 1, cleaned: 1, failed: 0, complete: true });
  });

  it("quarentena registro inválido e expõe relatório sem tentar limpar recursos", async () => {
    const journal = new MemoryRuntimeLeaseJournal([
      record("valid"),
      { ...record("unsafe"), sandboxId: "..\\outside" },
    ]);
    const killed: string[] = [];
    const result = await reconcileRuntimeLeases(journal, "new-boot", {
      killSandbox: async (sandboxId) => { killed.push(sandboxId); },
      removeTemporary: async () => undefined,
    });

    expect(result).toMatchObject({ inspected: 2, cleaned: 1, failed: 1, complete: false, quarantined: 1 });
    expect(killed).toEqual(["sandbox-valid"]);
    expect(journal.getLastReport()).toMatchObject({ quarantined: 1, issues: [{ reason: "invalid-record" }] });
    await expect(journal.list()).resolves.toEqual([]);
  });

  it("não repete a falha de um registro já reportado e quarantinado", async () => {
    const journal = new MemoryRuntimeLeaseJournal([{ ...record("unsafe"), temporaryId: "tmp/escape" }]);
    const reconciler: RuntimeResourceReconciler = {
      killSandbox: async () => undefined,
      removeTemporary: async () => undefined,
    };

    await expect(reconcileRuntimeLeases(journal, "new-boot", reconciler)).resolves.toMatchObject({
      inspected: 1,
      failed: 1,
      quarantined: 1,
      complete: false,
    });
    await expect(reconcileRuntimeLeases(journal, "newer-boot", reconciler)).resolves.toEqual({
      inspected: 0,
      cleaned: 0,
      failed: 0,
      complete: true,
    });
  });

  it("persiste em state, publica JSON via rename atômico e recupera após nova instância", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-runtime-state-"));
    temporaryDirectories.push(directory);
    const first = new FileRuntimeLeaseJournal(directory);
    await first.put(record("persisted"));

    const raw = JSON.parse(await readFile(join(directory, "runtime-leases.json"), "utf8")) as { schemaVersion: number; leases: unknown[] };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.leases).toEqual([record("persisted")]);
    await expect(new FileRuntimeLeaseJournal(directory).list()).resolves.toEqual([record("persisted")]);
    expect(await readdir(directory)).not.toContain(expect.stringMatching(/\.tmp$/));
  });

  it("persiste pending sem inventar sandboxId", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-runtime-pending-"));
  temporaryDirectories.push(directory);
  const pending = {
    leaseId: "pending",
    agentId: "agent-a",
    runtimeBootId: "old-boot",
    temporaryId: "tmp-pending",
    pending: true as const,
  };

  await new FileRuntimeLeaseJournal(directory).put(pending);
  await expect(new FileRuntimeLeaseJournal(directory).list()).resolves.toEqual([pending]);
});

it("move um journal corrompido para quarantine e não o trata como vazio saudável", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-runtime-corrupt-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "runtime-leases.json"), "{ broken", "utf8");
    const journal = new FileRuntimeLeaseJournal(directory);

    await expect(journal.list()).resolves.toEqual([]);
    expect(journal.getLastReport()).toMatchObject({ quarantined: 1, issues: [{ reason: "invalid-journal" }] });
    const quarantine = await readdir(join(directory, "quarantine", "runtime-leases"));
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]).toMatch(/^corrupt-/u);
  });

  it("remove registro inválido do journal ativo, mantendo o lease válido recuperável", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-runtime-record-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "runtime-leases.json"), JSON.stringify({
      schemaVersion: 1,
      leases: [record("valid"), { ...record("bad"), temporaryId: "tmp/escape" }],
    }), "utf8");
    const journal = new FileRuntimeLeaseJournal(directory);

    await expect(journal.list()).resolves.toEqual([record("valid")]);
    expect(journal.getLastReport()).toMatchObject({ quarantined: 1, issues: [{ reason: "invalid-record", leaseId: "bad" }] });
    await expect(new FileRuntimeLeaseJournal(directory).list()).resolves.toEqual([record("valid")]);
    expect(await readdir(join(directory, "quarantine", "runtime-leases"))).toHaveLength(1);
  });
});
