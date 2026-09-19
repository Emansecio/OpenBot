import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  commitRuntimeActivation,
  createManagedRuntimeLayout,
  readPreviousRuntimeActivation,
  readRuntimeActivation,
  recoverRuntimeActivation,
} from "../src/execution/runtime/wsl/installer.js";
import {
  classifyWslDistroTermination,
  createWslCommandRunner,
  RuntimeInstallationError,
  WslProvisioner,
  decodeWslOutput,
  type WslCommandResult,
  type WslCommandRunner,
} from "../src/execution/runtime/wsl/provisioner.js";
import type { RuntimeGuestPackageManifest,RuntimeActivationManifest } from "../src/execution/runtime/wsl/installer.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeRunner implements WslCommandRunner {
  readonly calls: string[][] = [];
  responses: WslCommandResult[] = [];

  async run(args: readonly string[]): Promise<WslCommandResult> {
    this.calls.push([...args]);
    return this.responses.shift() ?? { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

class ExportingRunner extends FakeRunner {
  override async run(args: readonly string[]): Promise<WslCommandResult> {
    const result = await super.run(args);
    if (args[0] === "--export" && typeof args[2] === "string") await writeFile(args[2], "previous-runtime-archive");
    return result;
  }
}

class AbortDuringImportRunner implements WslCommandRunner {
  readonly calls: Array<{ args: string[]; aborted: boolean }> = [];

  constructor(private readonly controller: AbortController) {}

  async run(args: readonly string[], signal?: AbortSignal): Promise<WslCommandResult> {
    this.calls.push({ args: [...args], aborted: signal?.aborted === true });
    if (args[0] === "--import") {
      this.controller.abort();
      throw new Error("import interrupted after candidate registration");
    }
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

describe("WSL provisioning boundary", () => {
  it("recovery de ativação restaura archives junto com os manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-provision-activation-archives-"));
    roots.push(root);
    const layout = await createManagedRuntimeLayout(root);
    const oldCurrent: RuntimeActivationManifest = {
      schemaVersion: 1,
      runtimeVersion: "1.0.0",
      supervisorVersion: "0.1.0",
      supervisorDigest: `sha256:${"c".repeat(64)}`,
      rootfsDigest: `sha256:${"d".repeat(64)}`,
      distroName: "OpenBotRuntime",
      activatedAt: "2026-08-15T00:00:00.000Z",
    };
    const oldPrevious: RuntimeActivationManifest = { ...oldCurrent, runtimeVersion: "0.9.0", activatedAt: "2026-08-14T00:00:00.000Z" };
    const next: RuntimeActivationManifest = { ...oldCurrent, runtimeVersion: "1.1.0", activatedAt: "2026-08-16T00:00:00.000Z" };
    const currentSnapshot = join(layout.staging, "current-before.tar");
    const previousSnapshot = join(layout.staging, "previous-before.tar");
    await writeFile(currentSnapshot, "old-current");
    await writeFile(previousSnapshot, "old-previous");
    await writeFile(join(layout.current, "runtime-package.tar"), "new-current");
    await writeFile(join(layout.previous, "runtime-package.tar"), "new-previous");
    await writeFile(join(layout.current, "manifest.json"), JSON.stringify(next));
    await writeFile(join(layout.previous, "manifest.json"), JSON.stringify(next));
    await writeFile(join(layout.state, "activation-transaction.json"), JSON.stringify({
      schemaVersion: 1,
      phase: "prepared",
      transactionId: "tx-archives",
      previousCurrent: oldCurrent,
      previousPrevious: oldPrevious,
      nextCurrent: next,
      archives: {
        current: { snapshotPath: currentSnapshot, existed: true },
        previous: { snapshotPath: previousSnapshot, existed: true },
      },
    }));

    await recoverRuntimeActivation(layout);

    await expect(readRuntimeActivation(layout)).resolves.toMatchObject({ runtimeVersion: "1.0.0" });
    await expect(readPreviousRuntimeActivation(layout)).resolves.toMatchObject({ runtimeVersion: "0.9.0" });
    await expect(readFile(join(layout.current, "runtime-package.tar"), "utf8")).resolves.toBe("old-current");
    await expect(readFile(join(layout.previous, "runtime-package.tar"), "utf8")).resolves.toBe("old-previous");
  });

  it("recusa abort já sinalizado sem iniciar wsl.exe", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn() as unknown as typeof import("node:child_process").spawn;

    await expect(createWslCommandRunner("wsl.exe", spawn).run([], controller.signal)).rejects.toThrow(/aborted/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("aguarda close do processo depois de matar um comando abortado", async () => {
    const child = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>;
    child.stdin = { end: vi.fn() } as never;
    child.stdout = new EventEmitter() as never;
    child.stderr = new EventEmitter() as never;
    child.kill = vi.fn(() => true);
    const spawn = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const controller = new AbortController();
    const pending = createWslCommandRunner("wsl.exe", spawn).run([], controller.signal);
    controller.abort();
    let settled = false;
    void pending.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);

    child.emit("close", null);
    await expect(pending).rejects.toThrow(/aborted/i);
  });

  it("escala para SIGKILL e rejeita quando wsl.exe ignora close", async () => {
    const child = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>;
    child.stdin = { end: vi.fn() } as never;
    child.stdout = new EventEmitter() as never;
    child.stderr = new EventEmitter() as never;
    child.kill = vi.fn(() => true);
    const spawn = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const controller = new AbortController();
    const pending = createWslCommandRunner("wsl.exe", spawn, 10).run([], controller.signal);

    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
    expect(child.kill).toHaveBeenNthCalledWith(1);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("distingue distro ausente/parada de uma falha de término", () => {
    const result = (stderr: string, exitCode = 1): WslCommandResult => ({
      exitCode,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(stderr),
    });
    expect(classifyWslDistroTermination(result("There is no distribution with the supplied name."))).toBe("absent");
    expect(classifyWslDistroTermination({
      ...result("Wsl/Service/WSL_E_DISTRO_NOT_FOUND", 0xffff_ffff),
      stdout: Buffer.from("Wsl/Service/WSL_E_DISTRO_NOT_FOUND", "utf16le"),
      stderr: Buffer.alloc(0),
    })).toBe("absent");
    expect(classifyWslDistroTermination(result("The distribution is already stopped."))).toBe("already-stopped");
    expect(() => classifyWslDistroTermination(result("Access is denied."))).toThrow(/termination failed/i);
  });

  it("decodifica saída UTF-16LE e UTF-8 do wsl.exe", () => {
    expect(decodeWslOutput(Buffer.from("Default Version: 2\r\n", "utf16le"))).toContain("Default Version: 2");
    expect(decodeWslOutput(Buffer.from("OpenBotRuntime\n", "utf8"))).toBe("OpenBotRuntime\n");
  });

  it("inspeciona WSL e não importa nem inicia a distro pessoal", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-provision-"));
    roots.push(root);
    const layout = await createManagedRuntimeLayout(root);
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from("Default Version: 2\n"), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from("Ubuntu\n"), stderr: Buffer.alloc(0) },
    ];
    const provisioner = new WslProvisioner({ layout, runner });

    await expect(provisioner.inspect()).resolves.toMatchObject({ supported: true, dedicatedDistroPresent: false });
    expect(runner.calls).toEqual([["--status"], ["--list", "--quiet"]]);
    expect(runner.calls.flat()).not.toContain("Ubuntu");
  });

  it("limpa uma candidata parcial mesmo quando o sinal do chamador foi abortado", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-provision-abort-cleanup-"));
    roots.push(root);
    const layout = await createManagedRuntimeLayout(root);
    const archive = join(layout.staging, "runtime-package.tar");
    await writeFile(archive, "archive");
    const manifest: RuntimeGuestPackageManifest = {
      schemaVersion: 1,
      runtimeVersion: "1.0.0",
      supervisorVersion: "0.1.0",
      supervisorDigest: `sha256:${"c".repeat(64)}`,
      rootfsDigest: `sha256:${"d".repeat(64)}`,
    };
    const controller = new AbortController();
    const runner = new AbortDuringImportRunner(controller);
    const provisioner = new WslProvisioner({ layout, runner });

    await expect(provisioner.installManagedGuestPackage(archive, manifest, controller.signal))
      .rejects.toThrow(/installation failed/i);

    const cleanup = runner.calls.filter(({ args }) => args[0] === "--terminate" || args[0] === "--unregister");
    expect(cleanup.map(({ args }) => args[0])).toEqual(["--terminate", "--unregister"]);
    expect(cleanup.every(({ aborted }) => !aborted)).toBe(true);
  });

  it("valida o manifesto do guest antes de importar e verifica o binário no guest", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-provision-guest-"));
    roots.push(root);
    const layout = await createManagedRuntimeLayout(root);
    const archive = join(layout.staging, "runtime-package.tar");
    await writeFile(archive, "archive");
    const manifest: RuntimeGuestPackageManifest = {
      schemaVersion: 1,
      runtimeVersion: "1.0.0",
      supervisorVersion: "0.1.0",
      supervisorDigest: `sha256:${"c".repeat(64)}`,
      rootfsDigest: `sha256:${"d".repeat(64)}`,
    };
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // --list
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // import candidate
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: "0.1.0", supervisorDigest: `sha256:${"c".repeat(64)}` })), stderr: Buffer.alloc(0) }, // candidate version
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "candidate-boot", runtimeVersion: "1.0.0", imageDigest: `sha256:${"d".repeat(64)}` })), stderr: Buffer.alloc(0) }, // candidate start
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) }, // candidate health
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // terminate candidate
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // import final
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: "0.1.0", supervisorDigest: `sha256:${"c".repeat(64)}` })), stderr: Buffer.alloc(0) }, // final version
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "final-boot", runtimeVersion: "1.0.0", imageDigest: `sha256:${"d".repeat(64)}` })), stderr: Buffer.alloc(0) }, // final start
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) }, // final health
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // terminate candidate
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // unregister candidate
    ];
    const provisioner = new WslProvisioner({ layout, runner });

    await provisioner.importManagedGuestPackage(archive, manifest);

    await expect(readRuntimeActivation(layout)).resolves.toMatchObject({
      runtimeVersion: "1.0.0",
      distroName: "OpenBotRuntime",
      archiveDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    await expect(readPreviousRuntimeActivation(layout)).resolves.toBeNull();

    expect(runner.calls).toContainEqual(["--import", "OpenBotRuntimeCandidate", expect.stringContaining("distro-candidate"), archive, "--version", "2"]);
    expect(runner.calls).toContainEqual(["--import", "OpenBotRuntime", layout.distro, archive, "--version", "2"]);
    expect(runner.calls).toContainEqual(["-d", "OpenBotRuntimeCandidate", "--user", "root", "--", "/usr/lib/openbot/supervisor", "--protocol-version", "1", "version"]);
    expect(runner.calls).toContainEqual(["-d", "OpenBotRuntimeCandidate", "--user", "root", "--", "/usr/lib/openbot/supervisor", "--protocol-version", "1", "health", "candidate-boot"]);
    expect(runner.calls.flat()).not.toContain("Ubuntu");
    await expect(provisioner.importManagedGuestPackage(archive, { ...manifest, supervisorDigest: "sha256:bad" })).rejects.toThrow(/manifest/i);
  });

  it("recusa guest bootado com runtime ou rootfs divergente do manifesto", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-provision-boot-mismatch-"));
    roots.push(root);
    const layout = await createManagedRuntimeLayout(root);
    const archive = join(layout.staging, "runtime-package.tar");
    await writeFile(archive, "archive");
    const manifest: RuntimeGuestPackageManifest = {
      schemaVersion: 1,
      runtimeVersion: "1.0.0",
      supervisorVersion: "0.1.0",
      supervisorDigest: `sha256:${"c".repeat(64)}`,
      rootfsDigest: `sha256:${"d".repeat(64)}`,
    };
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: "0.1.0", supervisorDigest: manifest.supervisorDigest })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "candidate-boot", runtimeVersion: "0.9.0", imageDigest: manifest.rootfsDigest })), stderr: Buffer.alloc(0) },
    ];

    await expect(new WslProvisioner({ layout, runner }).installManagedGuestPackage(archive, manifest))
      .rejects.toThrow(/installation/i);
    expect(runner.calls.some((args) => args.at(-1) === "health")).toBe(false);
  });

  it("importa somente OpenBotRuntime com archive dentro do staging administrado", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-provision-import-"));
    roots.push(root);
    const layout = await createManagedRuntimeLayout(root);
    const archive = join(layout.staging, "runtime.tar");
    await writeFile(archive, "archive");
    const runner = new FakeRunner();
    runner.responses = [{ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }];
    const provisioner = new WslProvisioner({ layout, runner });

    await provisioner.importManagedDistro(archive);

    expect(runner.calls).toEqual([["--import", "OpenBotRuntime", layout.distro, archive, "--version", "2"]]);
    await expect(provisioner.importManagedDistro(join(root, "..", "personal.tar"))).rejects.toThrow(/outside/i);
  });

  it("recusa digest externo divergente antes de chamar qualquer comando WSL", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-provision-digest-"));
    roots.push(root);
    const layout = await createManagedRuntimeLayout(root);
    const archive = join(layout.staging, "runtime.tar");
    await writeFile(archive, "archive");
    const manifest: RuntimeGuestPackageManifest = {
      schemaVersion: 1,
      runtimeVersion: "1.0.0",
      supervisorVersion: "0.1.0",
      supervisorDigest: `sha256:${"c".repeat(64)}`,
      rootfsDigest: `sha256:${"d".repeat(64)}`,
      archiveDigest: `sha256:${"e".repeat(64)}`,
    };
    const runner = new FakeRunner();
    const provisioner = new WslProvisioner({ layout, runner });

    await expect(provisioner.installManagedGuestPackage(archive, manifest)).rejects.toThrow(/digest/i);
    expect(runner.calls).toEqual([]);
  });

  it("permite override live somente para uma distro OpenBotRuntimeLive e nunca cria candidata separada", async () => {
    vi.stubEnv("OPENBOT_RUNTIME_WSL_LIVE_TEST", "1");
    const root = await mkdtemp(join(tmpdir(), "openbot-provision-live-"));
    roots.push(root);
    const layout = await createManagedRuntimeLayout(root);
    const archive = join(layout.staging, "runtime.tar");
    await writeFile(archive, "archive");
    const manifest: RuntimeGuestPackageManifest = {
      schemaVersion: 1,
      runtimeVersion: "1.0.0",
      supervisorVersion: "0.1.0",
      supervisorDigest: `sha256:${"c".repeat(64)}`,
      rootfsDigest: `sha256:${"d".repeat(64)}`,
    };
    const distro = "OpenBotRuntimeLive-12345678-1234-1234-1234-123456789abc";
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // list
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // import candidate/final
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: "0.1.0", supervisorDigest: `sha256:${"c".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "candidate-boot", runtimeVersion: "1.0.0", imageDigest: `sha256:${"d".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // terminate candidate
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // unregister candidate before promotion
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // import final
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: "0.1.0", supervisorDigest: `sha256:${"c".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "final-boot", runtimeVersion: "1.0.0", imageDigest: `sha256:${"d".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) },
    ];
    try {
      await new WslProvisioner({ layout, runner, testOnlyDistroName: distro }).installManagedGuestPackage(archive, manifest);
      expect(runner.calls.flat()).not.toContain("OpenBotRuntime");
      expect(runner.calls.flat()).not.toContain("OpenBotRuntimeCandidate");
      expect(runner.calls.filter((args) => args[0] === "--import").map((args) => args[1])).toEqual([distro, distro]);
      expect(runner.calls).toContainEqual(["--unregister", distro]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("mantém distro ativa intacta quando a candidata falha no health", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-provision-candidate-failure-"));
    roots.push(root);
    const layout = await createManagedRuntimeLayout(root);
    const archive = join(layout.staging, "runtime.tar");
    await writeFile(archive, "archive");
    const manifest: RuntimeGuestPackageManifest = {
      schemaVersion: 1,
      runtimeVersion: "1.0.0",
      supervisorVersion: "0.1.0",
      supervisorDigest: `sha256:${"c".repeat(64)}`,
      rootfsDigest: `sha256:${"d".repeat(64)}`,
    };
    const runner = new ExportingRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from("OpenBotRuntime\nUbuntu\n"), stderr: Buffer.alloc(0) }, // --list
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // export old
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // import candidate
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: "0.1.0", supervisorDigest: `sha256:${"c".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "candidate-boot", runtimeVersion: "1.0.0", imageDigest: `sha256:${"d".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: false })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // terminate candidate cleanup
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // unregister candidate cleanup
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // terminate old final for rollback
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // unregister old final for rollback
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // import previous final
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: "0.1.0", supervisorDigest: `sha256:${"c".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "old-boot", runtimeVersion: "1.0.0", imageDigest: `sha256:${"d".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) },
    ];
    const provisioner = new WslProvisioner({ layout, runner });

    await expect(provisioner.installManagedGuestPackage(archive, manifest)).rejects.toThrow(/installation/i);
    expect(runner.calls).toContainEqual(["--unregister", "OpenBotRuntime"]);
    expect(runner.calls).toContainEqual(["--export", "OpenBotRuntime", expect.stringContaining("previous-runtime" )]);
    expect(runner.calls).toContainEqual(["--import", "OpenBotRuntime", layout.distro, expect.stringContaining("previous-runtime"), "--version", "2"]);
    expect(runner.calls.flat()).not.toContain("Ubuntu");
  });

  it("tenta rollback mesmo quando a limpeza da candidata falha", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-provision-candidate-cleanup-failure-"));
    roots.push(root);
    const layout = await createManagedRuntimeLayout(root);
    const archive = join(layout.staging, "runtime-package.tar");
    await writeFile(archive, "archive");
    await writeFile(join(layout.current, "runtime-package.tar"), "current-runtime");
    await writeFile(join(layout.previous, "runtime-package.tar"), "previous-runtime");
    const manifest: RuntimeGuestPackageManifest = {
      schemaVersion: 1,
      runtimeVersion: "1.0.0",
      supervisorVersion: "0.1.0",
      supervisorDigest: `sha256:${"c".repeat(64)}`,
      rootfsDigest: `sha256:${"d".repeat(64)}`,
    };
    const runner = new ExportingRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from("OpenBotRuntime\n"), stderr: Buffer.alloc(0) }, // list
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // export old
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // import candidate
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: manifest.supervisorVersion, supervisorDigest: manifest.supervisorDigest })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "candidate-boot", runtimeVersion: manifest.runtimeVersion, imageDigest: manifest.rootfsDigest })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: false })), stderr: Buffer.alloc(0) }, // candidate health
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // candidate terminate
      { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("Access is denied.") }, // candidate unregister fails
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // rollback final terminate
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // rollback final unregister
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // import previous final
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: manifest.supervisorVersion, supervisorDigest: manifest.supervisorDigest })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "old-boot", runtimeVersion: manifest.runtimeVersion, imageDigest: manifest.rootfsDigest })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) },
    ];

    await expect(new WslProvisioner({ layout, runner }).installManagedGuestPackage(archive, manifest))
      .rejects.toThrow(/installation/i);
    expect(runner.calls).toContainEqual(["--import", "OpenBotRuntime", layout.distro, expect.stringContaining("previous-runtime"), "--version", "2"]);
    const recoveryArtifacts = (await readdir(layout.staging)).filter((name) => /^\.(?:previous-runtime|current-runtime-before|previous-runtime-before)-[0-9a-f-]+\.tar$/u.test(name));
    expect(recoveryArtifacts).toHaveLength(3);
    for (const artifact of recoveryArtifacts) await expect(readFile(join(layout.staging, artifact), "utf8")).resolves.toBeTruthy();
  });

  it("restaura a versão anterior quando a ativação final falha", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-provision-rollback-"));
    roots.push(root);
    const layout = await createManagedRuntimeLayout(root);
    const archive = join(layout.staging, "runtime.tar");
    await writeFile(archive, "new-runtime");
    await writeFile(join(layout.current, "runtime-package.tar"), "current-runtime");
    await writeFile(join(layout.previous, "runtime-package.tar"), "previous-runtime");
    const oldManifest: RuntimeGuestPackageManifest = {
      schemaVersion: 1,
      runtimeVersion: "1.0.0",
      supervisorVersion: "0.1.0",
      supervisorDigest: `sha256:${"c".repeat(64)}`,
      rootfsDigest: `sha256:${"d".repeat(64)}`,
    };
    const olderManifest: RuntimeGuestPackageManifest = { ...oldManifest, runtimeVersion: "0.9.0" };
    await commitRuntimeActivation(layout, olderManifest, new Date("2026-08-14T00:00:00.000Z"));
    await commitRuntimeActivation(layout, oldManifest, new Date("2026-08-15T00:00:00.000Z"));

    const runner = new ExportingRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from("OpenBotRuntime\nUbuntu\n"), stderr: Buffer.alloc(0) }, // list
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // export previous
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // import candidate
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: "0.1.0", supervisorDigest: `sha256:${"c".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "candidate-boot", runtimeVersion: "1.0.0", imageDigest: `sha256:${"d".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // terminate candidate
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // terminate old final
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // unregister old final
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // import new final
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: "0.1.0", supervisorDigest: `sha256:${"c".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "new-boot", runtimeVersion: "1.0.0", imageDigest: `sha256:${"d".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: false })), stderr: Buffer.alloc(0) }, // final health fails
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // cleanup candidate terminate
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // cleanup candidate unregister
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // rollback final terminate
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // rollback final unregister
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // import previous final
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: "0.1.0", supervisorDigest: `sha256:${"c".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "old-boot", runtimeVersion: "1.0.0", imageDigest: `sha256:${"d".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) },
    ];
    const provisioner = new WslProvisioner({ layout, runner });

    await expect(provisioner.installManagedGuestPackage(archive, oldManifest)).rejects.toThrow(/installation/i);
    await expect(readRuntimeActivation(layout)).resolves.toMatchObject({ runtimeVersion: "1.0.0" });
    await expect(readPreviousRuntimeActivation(layout)).resolves.toMatchObject({ runtimeVersion: "0.9.0" });
    expect(runner.calls.filter((args) => args[0] === "--unregister").map((args) => args[1])).toEqual([
      "OpenBotRuntime",
      "OpenBotRuntimeCandidate",
      "OpenBotRuntime",
    ]);
    expect(runner.calls.flat()).not.toContain("Ubuntu");
    const recoveryArtifacts = (await readdir(layout.staging)).filter((name) => /^\.(?:previous-runtime|current-runtime-before|previous-runtime-before)-[0-9a-f-]+\.tar$/u.test(name));
    expect(recoveryArtifacts).toEqual([]);
  });

  it("preserva artefatos e journal quando promoção e rollback falham", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-provision-rollback-preserve-"));
    roots.push(root);
    const layout = await createManagedRuntimeLayout(root);
    const archive = join(layout.staging, "runtime.tar");
    await writeFile(archive, "new-runtime");
    await writeFile(join(layout.current, "runtime-package.tar"), "current-runtime");
    await writeFile(join(layout.previous, "runtime-package.tar"), "previous-runtime");
    const oldManifest: RuntimeGuestPackageManifest = {
      schemaVersion: 1,
      runtimeVersion: "1.0.0",
      supervisorVersion: "0.1.0",
      supervisorDigest: `sha256:${"c".repeat(64)}`,
      rootfsDigest: `sha256:${"d".repeat(64)}`,
    };
    const olderManifest: RuntimeGuestPackageManifest = { ...oldManifest, runtimeVersion: "0.9.0" };
    await commitRuntimeActivation(layout, olderManifest, new Date("2026-08-14T00:00:00.000Z"));
    await commitRuntimeActivation(layout, oldManifest, new Date("2026-08-15T00:00:00.000Z"));
    const previousCurrent = await readRuntimeActivation(layout);
    if (previousCurrent === null) throw new Error("expected an existing activation");
    const journalPath = join(layout.state, "activation-transaction.json");
    const journal = `${JSON.stringify({
      schemaVersion: 1,
      phase: "prepared",
      transactionId: "pre-existing-rollback",
      previousCurrent,
      previousPrevious: null,
      nextCurrent: previousCurrent,
    })}\n`;
    await writeFile(journalPath, journal);

    const runner = new ExportingRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from("OpenBotRuntime\nUbuntu\n"), stderr: Buffer.alloc(0) }, // list
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // export previous
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // import candidate
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: oldManifest.supervisorVersion, supervisorDigest: oldManifest.supervisorDigest })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "candidate-boot", runtimeVersion: oldManifest.runtimeVersion, imageDigest: oldManifest.rootfsDigest })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // terminate candidate
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // terminate old final
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // unregister old final
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // import new final
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: oldManifest.supervisorVersion, supervisorDigest: oldManifest.supervisorDigest })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "new-boot", runtimeVersion: oldManifest.runtimeVersion, imageDigest: oldManifest.rootfsDigest })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: false })), stderr: Buffer.alloc(0) }, // final health fails
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // cleanup candidate terminate
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // cleanup candidate unregister
      { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("Access is denied.") }, // rollback terminate fails
    ];

    let installationError: unknown;
    try {
      await new WslProvisioner({ layout, runner }).installManagedGuestPackage(archive, oldManifest);
    } catch (error) {
      installationError = error;
    }

    expect(installationError).toBeInstanceOf(RuntimeInstallationError);
    const recoveryArtifacts = (await readdir(layout.staging)).filter((name) => /^\.(?:previous-runtime|current-runtime-before|previous-runtime-before)-[0-9a-f-]+\.tar$/u.test(name));
    expect(recoveryArtifacts).toHaveLength(3);
    const recoveryPaths = recoveryArtifacts.map((name) => join(layout.staging, name));
    const message = (installationError as RuntimeInstallationError).message;
    for (const recoveryPath of recoveryPaths) {
      await expect(readFile(recoveryPath, "utf8")).resolves.toBeTruthy();
      expect(message).toContain(recoveryPath);
    }
    await expect(readFile(journalPath, "utf8")).resolves.toBe(journal);
  });
});
