import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-ignore local runner is intentionally JavaScript.
const runner: any = await import("../scripts/verify-clean-profile.mjs");
const { assertCleanProfilePaths, buildCleanProfileEnvironment, cleanProfileDpapiAddonRelativePath, copyInstall, createCleanProfilePaths, ensureRoots, isElectronReadyEvidence, runCleanProfile, waitChildExit } = runner;
const testProductPort = 20_000 + (process.pid % 20_000);

function runIsolatedCleanProfile(options: Record<string, unknown> = {}) {
  return runCleanProfile({ ...options, productPort: testProductPort });
}

function isolatedRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `openbot-clean-profile-${label}-`));
}

function realTcpLifecycle() {
  const token = "clean-profile-first-boot-token-123456";
  let server: ReturnType<typeof createServer> | undefined;
  let bootCount = 0;
  return {
    async startGateway(paths: any) {
      bootCount += 1;
      await mkdir(paths.dataRoot, { recursive: true });
      await mkdir(paths.logs, { recursive: true });
      await writeFile(join(paths.logs, `boot-${bootCount}.log`), paths.tempRoot, "utf8");
      const tokenPath = join(paths.dataRoot, "gateway.token");
      if (bootCount === 1) await writeFile(tokenPath, `${token}\n`, "utf8");
      try { await readFile(paths.configPath, "utf8"); } catch { await writeFile(paths.configPath, JSON.stringify({ version: 1, revision: 0, agents: [] }), "utf8"); }
      await writeFile(paths.processStatePath, JSON.stringify({ pid: process.pid, root: paths.installRoot }), "utf8");
      server = createServer((request, response) => {
        if (request.url === "/health") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true, pid: process.pid }));
          return;
        }
        if (request.url === "/api/listAgents") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true, value: [] }));
          return;
        }
        response.writeHead(404); response.end();
      });
      await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(testProductPort, "127.0.0.1", resolve); });
      return { pid: process.pid, adopted: false };
    },
    async launchElectron() { return { realTcpSeam: true, readyEvidence: { title: "OpenBot", readyState: "complete", hasRoot: true, rootChildren: 1 } }; },
    async closeElectron() { return { forced: false, graceful: true }; },
    async stopGateway(paths: any) {
      await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
      server = undefined;
      await rm(paths.processStatePath, { force: true });
      return { ok: true, teardownProven: true, forced: false, gracefulAccepted: true };
    },
    get bootCount() { return bootCount; },
  };
}

describe("clean profile gate", () => {
  it("aceita somente revisão monotônica com todos os valores preservados", () => {
    const first = { revision: 8, agents: [], hostSettings: { timezone: "UTC" }, globalModel: "fixture" };
    expect(runner.isPersistedConfigStable(first, { ...first, revision: 16 })).toBe(true);
    expect(runner.isPersistedConfigStable(first, first)).toBe(true);
    for (const revision of [undefined, -1, 7, 8.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(runner.isPersistedConfigStable(first, { ...first, revision })).toBe(false);
    }
    expect(runner.isPersistedConfigStable(first, { ...first, revision: 16, globalModel: "changed" })).toBe(false);
    expect(runner.isPersistedConfigStable(first, { ...first, revision: 16, hostSettings: { timezone: "changed" } })).toBe(false);
    expect(runner.isPersistedConfigStable(first, { ...first, revision: 16, agents: [{ id: "invented" }] })).toBe(false);
  });
  it("copia o addon DPAPI real da arquitetura efetiva para o install isolado", async () => {
    const root = isolatedRoot("dpapi-addon");
    try {
      const paths = createCleanProfilePaths(root);
      await ensureRoots(paths);
      await copyInstall(paths);
      await expect(stat(join(paths.installRoot, cleanProfileDpapiAddonRelativePath()))).resolves.toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("REDs before lifecycle when a junction/reparse path escapes TempRoot", async () => {
    const root = isolatedRoot("junction-red");
    const outside = isolatedRoot("junction-outside");
    try {
      const paths = createCleanProfilePaths(root);
      symlinkSync(outside, paths.logs, "junction");
      await expect(assertCleanProfilePaths(paths)).rejects.toThrow(/reparse|escapes/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("substitui OPENBOT_INSTALL_ROOT externo e remove segredos herdados", () => {
    const root = isolatedRoot("env");
    try {
      const paths = createCleanProfilePaths(root);
      const env = buildCleanProfileEnvironment({
        OPENBOT_INSTALL_ROOT: "C:\\real\\OpenBot",
        APPDATA: "C:\\real\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\real\\AppData\\Local",
        OPENAI_API_KEY: "secret-value-should-not-inherit",
        NODE_PATH: "C:\\external\\node_modules",
        NODE_OPTIONS: "--require C:\\outside\\inject.cjs",
        Node_Options: "--require C:\\outside\\mixed.cjs",
        oPeNbOt_Install_Root: "C:\\outside\\install",
        sAnD_HoSt_GaTeWaY_ToKeN: "mixed-token-secret",
        Aws_Access_Key_Id: "AKIA-MIXED",
        AWS_PROFILE: "default",
        AWS_SHARED_CREDENTIALS_FILE: "C:\\outside\\credentials",
        PATH: "safe",
      }, paths);
      expect(env.OPENBOT_INSTALL_ROOT).toBe(paths.installRoot);
      expect(env.APPDATA).toBe(paths.appData);
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.NODE_PATH).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.Node_Options).toBeUndefined();
      expect(env.oPeNbOt_Install_Root).toBeUndefined();
      expect(env.sAnD_HoSt_GaTeWaY_ToKeN).toBeUndefined();
      expect(env.Aws_Access_Key_Id).toBeUndefined();
      expect(env.AWS_PROFILE).toBeUndefined();
      expect(env.AWS_SHARED_CREDENTIALS_FILE).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("valida reparse antes de criar qualquer root efetivo", async () => {
    const root = isolatedRoot("preflight-junction-red");
    const outside = isolatedRoot("preflight-junction-outside");
    try {
      const paths = createCleanProfilePaths(root);
      symlinkSync(outside, paths.logs, "junction");
      await expect(ensureRoots(paths)).rejects.toThrow(/reparse|escapes/i);
      expect(await readFile(join(outside, "marker"), "utf8").catch(() => null)).toBeNull();
      expect(await readFile(join(root, "appdata", "marker"), "utf8").catch(() => null)).toBeNull();
      expect(await readFile(join(root, "localappdata", "marker"), "utf8").catch(() => null)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejeita child Electron com código não-zero ou sinal", async () => {
    await expect(waitChildExit({ exitCode: 1, signalCode: null })).rejects.toThrow(/exit|code/i);
    await expect(waitChildExit({ exitCode: null, signalCode: "SIGTERM" })).rejects.toThrow(/signal/i);
  });

  it("aceita somente evidência renderer OpenBot completa e populada", () => {
    expect(isElectronReadyEvidence({ readyState: "loading", title: "OpenBot", hasRoot: true, rootChildren: 1 })).toBe(false);
    expect(isElectronReadyEvidence({ readyState: "complete", title: "Error", hasRoot: true, rootChildren: 1 })).toBe(false);
    expect(isElectronReadyEvidence({ readyState: "complete", title: "OpenBot", hasRoot: false, rootChildren: 0 })).toBe(false);
    expect(isElectronReadyEvidence({ readyState: "complete", title: "OpenBot", hasRoot: true, rootChildren: 0 })).toBe(false);
    expect(isElectronReadyEvidence({ readyState: "complete", title: "OpenBot", hasRoot: true, rootChildren: 1 })).toBe(true);
  });

  it("compara a configuração estável depois da inicialização do renderer", async () => {
    const root = isolatedRoot("renderer-config-init");
    const lifecycle = realTcpLifecycle();
    const launch: any = lifecycle.launchElectron;
    let launches = 0;
    (lifecycle as any).launchElectron = async (paths: any, ...args: any[]) => {
      launches += 1;
      const config = JSON.parse(await readFile(paths.configPath, "utf8"));
      if (launches === 1) {
        config.hostSettings = { initializedByRenderer: true };
      }
      config.revision += 1;
      await writeFile(paths.configPath, JSON.stringify(config), "utf8");
      return launch(paths, ...args);
    };
    try {
      await expect(runIsolatedCleanProfile({ tempRoot: root, lifecycle })).resolves.toMatchObject({ status: "GREEN", boots: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("não aceita apenas título OpenBot como evidência de renderer", async () => {
    const root = isolatedRoot("title-only-red");
    const lifecycle = realTcpLifecycle();
    (lifecycle as any).launchElectron = async () => ({ readyEvidence: { title: "OpenBot" } });
    try {
      await expect(runIsolatedCleanProfile({ tempRoot: root, lifecycle })).rejects.toThrow(/diagnosticRoot=/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejeita shutdown sem ok verdadeiro", async () => {
    const root = isolatedRoot("shutdown-not-ok-red");
    const lifecycle = realTcpLifecycle();
    const stop: any = lifecycle.stopGateway;
    let stops = 0;
    (lifecycle as any).stopGateway = async (...args: any[]) => {
      if (stops++ > 0) return { ok: false, teardownProven: true, forced: false };
      const result = await stop(...args);
      return { ...result, ok: false };
    };
    try {
      await expect(runIsolatedCleanProfile({ tempRoot: root, lifecycle })).rejects.toThrow(/diagnosticRoot=/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejeita teardown stale sem shutdown autenticado", async () => {
    const root = isolatedRoot("stale-shutdown-red");
    const lifecycle = realTcpLifecycle();
    const stopOriginal: any = lifecycle.stopGateway;
    let stops = 0;
    (lifecycle as any).stopGateway = async (paths: any) => {
      if (stops++ > 0) return { ok: true, teardownProven: true, forced: false, gracefulAccepted: false, reason: "stale" };
      await stopOriginal(paths);
      return { ok: true, teardownProven: true, forced: false, gracefulAccepted: false, reason: "stale" };
    };
    try {
      await expect(runIsolatedCleanProfile({ tempRoot: root, lifecycle })).rejects.toThrow(/diagnosticRoot=/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejeita closeElectron sem graceful explícito", async () => {
    const root = isolatedRoot("close-not-graceful-red");
    const lifecycle = realTcpLifecycle();
    (lifecycle as any).closeElectron = async () => undefined;
    try {
      await expect(runIsolatedCleanProfile({ tempRoot: root, lifecycle })).rejects.toThrow(/diagnosticRoot=/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("não termina processo externo que apenas contém TempRoot no argv", async () => {
    const root = isolatedRoot("external-process-red");
    const external = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)", root], { stdio: "ignore", windowsHide: true });
    try {
      await expect(runIsolatedCleanProfile({ tempRoot: root, lifecycle: { startGateway: async () => { throw new Error("forced RED"); } } })).rejects.toThrow(/diagnosticRoot=/u);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      expect(external.exitCode).toBeNull();
    } finally {
      external.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserva a root quando o segundo boot não entrega evidência de renderer", async () => {
    const lifecycle = realTcpLifecycle();
    const launch: any = lifecycle.launchElectron;
    let launches = 0;
    lifecycle.launchElectron = async (...args: any[]) => {
      launches += 1;
      const session = await launch(...args);
      if (launches === 2) delete (session).readyEvidence;
      return session;
    };
    let diagnosticRoot = "";
    try {
      await runIsolatedCleanProfile({ lifecycle });
    } catch (error: any) {
      const message = String(error.message);
      expect(message).toContain("stage=restart.renderer-ready");
      diagnosticRoot = message.split("diagnosticRoot=")[1] ?? "";
    }
    try {
      expect(diagnosticRoot).toMatch(/openbot-clean-profile-/u);
      expect(await readFile(join(diagnosticRoot, "logs", "boot-1.log"), "utf8")).toContain(diagnosticRoot);
      expect(await readFile(join(diagnosticRoot, "data-root", "gateway.token"), "utf8")).toBeTruthy();
    } finally {
      if (diagnosticRoot) rmSync(diagnosticRoot, { recursive: true, force: true });
    }
  });

  it("não vaza segredo na mensagem RED", async () => {
    const root = isolatedRoot("secret-red");
    const secret = "arbitrary-secret-value-123456";
    const originalEnvironment = process.env;
    try {
      await expect(runIsolatedCleanProfile({
        tempRoot: root,
        lifecycle: { startGateway: async () => { throw new Error(secret); } },
      })).rejects.toSatisfy((error: Error) => !error.message.includes(secret) && error.message.includes("diagnosticRoot="));
      expect(process.env).toBe(originalEnvironment);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prova TCP, marker, token somente no primeiro boot e roots/logs distintos", async () => {
    const firstRoot = isolatedRoot("tcp-a");
    const secondRoot = isolatedRoot("tcp-b");
    try {
      const firstLifecycle = realTcpLifecycle();
      const originalEnvironment = process.env;
      const first = await runIsolatedCleanProfile({ tempRoot: firstRoot, lifecycle: firstLifecycle });
      expect(process.env).toBe(originalEnvironment);
      const secondLifecycle = realTcpLifecycle();
      const second = await runIsolatedCleanProfile({ tempRoot: secondRoot, lifecycle: secondLifecycle });
      expect(first).toMatchObject({ status: "GREEN", cleanup: "preserved-by-caller", boots: 2, electronReal: true, rendererEvidence: [{ title: "OpenBot" }, { title: "OpenBot" }] });
      expect(second).toMatchObject({ status: "GREEN", cleanup: "preserved-by-caller", boots: 2, electronReal: true, rendererEvidence: [{ title: "OpenBot" }, { title: "OpenBot" }] });
      expect(firstLifecycle.bootCount).toBe(2);
      expect(secondLifecycle.bootCount).toBe(2);
      expect(first.tempRoot).not.toBe(second.tempRoot);
      expect(first.tempRoot).toContain("tcp-a");
      expect(second.tempRoot).toContain("tcp-b");
      expect(await readFile(join(firstRoot, "logs", "boot-1.log"), "utf8")).toContain(firstRoot);
      expect(await readFile(join(secondRoot, "logs", "boot-1.log"), "utf8")).toContain(secondRoot);
      expect(await readFile(join(firstRoot, "logs", "boot-1.log"), "utf8")).not.toContain(secondRoot);
      expect(await readFile(join(secondRoot, "logs", "boot-1.log"), "utf8")).not.toContain(firstRoot);
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });
});
