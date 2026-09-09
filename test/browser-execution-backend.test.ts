import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserExecutionBackend } from "../src/browser/execution-backend.js";
import { BrowserSessionManager, type BrowserHostProcess } from "../src/browser/browser-session-manager.js";
import { encodeBrowserFrame } from "../src/browser/protocol.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../src/execution/contracts.js";

class FakeBrowserHost implements BrowserHostProcess {
  readonly stdout = new PassThrough();
  readonly requests: Array<Record<string, unknown>> = [];
  private exited = false;
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
      this.requests.push(request);
      const command = request.command as Record<string, unknown>;
      const result = {
        command: command.command,
        tabId: request.tabId,
        url: typeof command.url === "string" ? command.url : "https://example.com/",
        title: "Example",
        visible: command.command === "handoff" || command.command === "open" ? true : undefined,
        ...(command.command === "upload" ? {
          upload: {
            selector: command.selector,
            fileName: "report.txt",
            bytes: 11,
          },
        } : {}),
      };
      queueMicrotask(() => this.stdout.write(encodeBrowserFrame({ protocolVersion: 1, kind: "response", id: request.id, ok: true, result })));
      callback();
    },
    final: (callback) => {
      this.emitExit();
      callback();
    },
  });

  constructor() {
    queueMicrotask(() => this.stdout.write(encodeBrowserFrame({ protocolVersion: 1, kind: "ready", hostVersion: "test" })));
  }

  kill(): void {
    this.emitExit();
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }

  private emitExit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(0, null);
  }
}

const managers: BrowserSessionManager[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fileBackend: ExecutionBackend = {
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (request.operation !== "file.list") throw new Error("unexpected delegate request");
    return { ok: true, operation: "file.list", entries: [] };
  },
};

describe("BrowserExecutionBackend", () => {
  it("mantém uma lease por agente e traduz o resultado estruturado", async () => {
    const host = new FakeBrowserHost();
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      launchHost: () => host,
    });
    managers.push(manager);
    const backend = new BrowserExecutionBackend({ agentId: "agent-a", manager, delegate: fileBackend, sessionId: "session-a" });

    await expect(backend.execute({ operation: "browser.open", url: "https://example.com/" })).resolves.toMatchObject({
      ok: true,
      operation: "browser.open",
      command: "open",
      visible: true,
    });
    await expect(backend.execute({ operation: "browser.navigate", url: "https://example.com/next" })).resolves.toMatchObject({
      ok: true,
      operation: "browser.navigate",
      command: "navigate",
    });
    expect(manager.activeLeaseCount).toBe(1);
    expect(host.requests).toHaveLength(2);
  });

  it("serializa a primeira aquisição para não criar duas leases concorrentes", async () => {
    const host = new FakeBrowserHost();
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      launchHost: () => host,
    });
    managers.push(manager);
    const backend = new BrowserExecutionBackend({ agentId: "agent-a", manager, delegate: fileBackend, sessionId: "session-a" });

    const [opened, snapped] = await Promise.all([
      backend.execute({ operation: "browser.open", url: "https://example.com/" }),
      backend.execute({ operation: "browser.snapshot" }),
    ]);

    expect(opened).toMatchObject({ ok: true, operation: "browser.open" });
    expect(snapped).toMatchObject({ ok: true, operation: "browser.snapshot" });
    expect(manager.activeLeaseCount).toBe(1);
    expect(new Set(host.requests.map((request) => String(request.tabId))).size).toBe(1);
  });

  it("fecha a barreira antes de publicar uma aquisição que estava em voo", async () => {
    let releasePaths!: () => void;
    const pathsReady = new Promise<void>((resolve) => {
      releasePaths = resolve;
    });
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      resolveDownloadRoot: async () => {
        await pathsReady;
        return "C:\\Temp\\OpenBot\\downloads\\agent-a\\Downloads";
      },
      launchHost: () => new FakeBrowserHost(),
    });
    managers.push(manager);
    const backend = new BrowserExecutionBackend({ agentId: "agent-a", manager, delegate: fileBackend });

    const opening = backend.execute({ operation: "browser.open", url: "https://example.com/" });
    const closing = backend.teardown();
    releasePaths();

    await expect(opening).resolves.toMatchObject({ ok: false, code: "runtime_unavailable" });
    await closing;
    expect(manager.activeLeaseCount).toBe(0);
    expect(backend.activeLease).toBeUndefined();
    await expect(backend.execute({ operation: "browser.open", url: "https://example.com/" })).resolves.toMatchObject({
      ok: false,
      code: "runtime_unavailable",
    });
  });

  it("não mantém o teardown browser preso a um delegate não-browser pendente", async () => {
    let releaseDelegate!: () => void;
    const delegateReady = new Promise<void>((resolve) => {
      releaseDelegate = resolve;
    });
    const pendingDelegate: ExecutionBackend = {
      async execute(): Promise<ExecutionResult> {
        await delegateReady;
        return { ok: true, operation: "file.list", entries: [] };
      },
    };
    const host = new FakeBrowserHost();
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      launchHost: () => host,
    });
    managers.push(manager);
    const backend = new BrowserExecutionBackend({ agentId: "agent-a", manager, delegate: pendingDelegate });
    await expect(backend.execute({ operation: "browser.open", url: "https://example.com/" })).resolves.toMatchObject({ ok: true });

    const delegated = backend.execute({ operation: "file.list", path: "." });
    await backend.teardown();
    expect(manager.activeLeaseCount).toBe(0);

    releaseDelegate();
    await expect(delegated).resolves.toMatchObject({ ok: true, operation: "file.list" });
  });

  it("delega file/process e fecha a lease no close/teardown", async () => {
    const host = new FakeBrowserHost();
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      launchHost: () => host,
    });
    managers.push(manager);
    const backend = new BrowserExecutionBackend({ agentId: "agent-a", manager, delegate: fileBackend });
    await backend.execute({ operation: "browser.open", url: "https://example.com/" });
    await expect(backend.execute({ operation: "file.list", path: "." })).resolves.toMatchObject({ ok: true, operation: "file.list" });
    await expect(backend.execute({ operation: "browser.close" })).resolves.toMatchObject({ ok: true, operation: "browser.close", command: "close" });
    expect(manager.activeLeaseCount).toBe(0);
    await backend.teardown();
    expect(manager.activeLeaseCount).toBe(0);
  });

  it("fecha sem abrir host quando não existe lease e recusa browser após abort", async () => {
    let launches = 0;
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      launchHost: () => {
        launches += 1;
        return new FakeBrowserHost();
      },
    });
    managers.push(manager);
    const backend = new BrowserExecutionBackend({ agentId: "agent-a", manager, delegate: fileBackend });
    await expect(backend.execute({ operation: "browser.close" })).resolves.toMatchObject({ ok: true, operation: "browser.close", command: "close" });
    const controller = new AbortController();
    controller.abort();
    await expect(backend.execute({ operation: "browser.open", url: "https://example.com/" }, controller.signal)).resolves.toMatchObject({
      ok: false,
      operation: "browser.open",
      code: "aborted",
    });
    expect(launches).toBe(0);
  });

  it("libera a lease se o sinal abortar durante a aquisição assíncrona", async () => {
    let releasePaths!: () => void;
    const pathsReady = new Promise<void>((resolve) => {
      releasePaths = resolve;
    });
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      resolveDownloadRoot: async () => {
        await pathsReady;
        return "C:\\Temp\\OpenBot\\downloads\\agent-a\\Downloads";
      },
      launchHost: () => new FakeBrowserHost(),
    });
    managers.push(manager);
    const backend = new BrowserExecutionBackend({ agentId: "agent-a", manager, delegate: fileBackend });
    const controller = new AbortController();
    const opening = backend.execute({ operation: "browser.open", url: "https://example.com/" }, controller.signal);
    controller.abort();
    releasePaths();

    await expect(opening).resolves.toMatchObject({ ok: false, operation: "browser.open", code: "aborted" });
    expect(manager.activeLeaseCount).toBe(0);
    expect(backend.activeLease).toBeUndefined();
  });

  it("mantém a lease compartilhada quando somente uma operação aborta durante a aquisição", async () => {
    let releasePaths!: () => void;
    const pathsReady = new Promise<void>((resolve) => {
      releasePaths = resolve;
    });
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      resolveDownloadRoot: async () => {
        await pathsReady;
        return "C:\\Temp\\OpenBot\\downloads\\agent-a\\Downloads";
      },
      launchHost: () => new FakeBrowserHost(),
    });
    managers.push(manager);
    const backend = new BrowserExecutionBackend({ agentId: "agent-a", manager, delegate: fileBackend });
    const controller = new AbortController();
    const aborted = backend.execute({ operation: "browser.open", url: "https://example.com/aborted" }, controller.signal);
    await Promise.resolve();
    const survivor = backend.execute({ operation: "browser.snapshot" });

    controller.abort();
    releasePaths();

    await expect(aborted).resolves.toMatchObject({ ok: false, operation: "browser.open", code: "aborted" });
    await expect(survivor).resolves.toMatchObject({ ok: true, operation: "browser.snapshot", command: "snapshot" });
    expect(manager.activeLeaseCount).toBe(1);
    await backend.teardown();
    expect(manager.activeLeaseCount).toBe(0);
  });

  it("libera a aquisição compartilhada quando todos os consumidores abortam", async () => {
    let releasePaths!: () => void;
    const pathsReady = new Promise<void>((resolve) => {
      releasePaths = resolve;
    });
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      resolveDownloadRoot: async () => {
        await pathsReady;
        return "C:\\Temp\\OpenBot\\downloads\\agent-a\\Downloads";
      },
      launchHost: () => new FakeBrowserHost(),
    });
    managers.push(manager);
    const backend = new BrowserExecutionBackend({ agentId: "agent-a", manager, delegate: fileBackend });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = backend.execute({ operation: "browser.open", url: "https://example.com/first" }, firstController.signal);
    await Promise.resolve();
    const second = backend.execute({ operation: "browser.snapshot" }, secondController.signal);

    firstController.abort();
    secondController.abort();
    releasePaths();

    await expect(first).resolves.toMatchObject({ ok: false, operation: "browser.open", code: "aborted" });
    await expect(second).resolves.toMatchObject({ ok: false, operation: "browser.snapshot", code: "aborted" });
    expect(manager.activeLeaseCount).toBe(0);
    expect(backend.activeLease).toBeUndefined();
    await backend.teardown();
    expect(manager.activeLeaseCount).toBe(0);
  });

  it("recria a lease na próxima operação depois que o host cai", async () => {
    const launchedHosts: FakeBrowserHost[] = [];
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      launchHost: () => {
        const host = new FakeBrowserHost();
        launchedHosts.push(host);
        return host;
      },
    });
    managers.push(manager);
    const backend = new BrowserExecutionBackend({ agentId: "agent-a", manager, delegate: fileBackend });

    await expect(backend.execute({ operation: "browser.open", url: "https://example.com/" })).resolves.toMatchObject({ ok: true });
    launchedHosts[0]!.kill();

    await expect(backend.execute({ operation: "browser.open", url: "https://example.com/recovered" })).resolves.toMatchObject({
      ok: true,
      operation: "browser.open",
    });
    expect(launchedHosts).toHaveLength(2);
    expect(manager.activeLeaseCount).toBe(1);
  });

  it("valida o upload dentro da home e mantém o caminho do modelo relativo", async () => {
    const root = join(tmpdir(), `openbot-browser-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const homeRoot = join(root, "home");
    mkdirSync(homeRoot, { recursive: true });
    writeFileSync(join(homeRoot, "report.txt"), "hello world");
    roots.push(root);

    const host = new FakeBrowserHost();
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      resolveHomeRoot: () => homeRoot,
      launchHost: () => host,
    });
    managers.push(manager);
    const backend = new BrowserExecutionBackend({ agentId: "agent-a", manager, homeRoot });

    const uploadResult = await backend.execute({ operation: "browser.upload", selector: "input[type=file]", path: "report.txt" });
    expect(uploadResult).toMatchObject({
      ok: true,
      operation: "browser.upload",
      command: "upload",
      upload: { selector: "input[type=file]", fileName: "report.txt", bytes: 11 },
    });
    expect(JSON.stringify(uploadResult)).not.toContain(homeRoot);
    expect(host.requests[0]).toMatchObject({
      homeRoot,
      command: { command: "upload", selector: "input[type=file]", path: "report.txt" },
    });

    await expect(backend.execute({ operation: "browser.upload", selector: "input[type=file]", path: "../secret.txt" })).resolves.toMatchObject({
      ok: false,
      operation: "browser.upload",
      code: "invalid_request",
    });
    expect(host.requests).toHaveLength(1);
  });

  it("mantém o upload relativo na home e exige referência explícita para compartilhar", async () => {
    const root = join(tmpdir(), `openbot-browser-overlay-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const homeRoot = join(root, "home");
    const profile = join(root, "profile");
    const redirect = join(homeRoot, "Documents");
    mkdirSync(join(homeRoot, ".openbot"), { recursive: true });
    mkdirSync(join(profile, "Documents"), { recursive: true });
    mkdirSync(redirect, { recursive: true });
    writeFileSync(join(profile, "Documents", "report.txt"), "hello world");
    writeFileSync(join(redirect, "report.txt"), "private bot");
    writeFileSync(join(homeRoot, ".openbot", "grants.json"), JSON.stringify({ version: 1, grants: {} }));
    roots.push(root);

    const host = new FakeBrowserHost();
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\downloads",
      resolveHomeRoot: () => homeRoot,
      launchHost: () => host,
    });
    managers.push(manager);
    const backend = new BrowserExecutionBackend({ agentId: "agent-a", manager, homeRoot, userProfile: profile });
    const upload = { operation: "browser.upload" as const, selector: "input[type=file]", path: "Documents/report.txt" };

    await expect(backend.execute(upload)).resolves.toMatchObject({ ok: true, operation: "browser.upload" });
    expect(host.requests[0]).toMatchObject({
      homeRoot,
      command: { command: "upload", selector: "input[type=file]", path: "Documents/report.txt" },
    });

    writeFileSync(join(homeRoot, ".openbot", "grants.json"), JSON.stringify({
      version: 1,
      grants: { Documents: { access: "read" } },
    }));
    await expect(backend.execute({ ...upload, path: "shared://Documents/report.txt" })).resolves.toMatchObject({ ok: true, operation: "browser.upload" });
    expect(host.requests[1]).toMatchObject({
      homeRoot: join(profile, "Documents"),
      command: { command: "upload", selector: "input[type=file]", path: "report.txt" },
    });
    await expect(backend.execute(upload)).resolves.toMatchObject({ ok: true });
    expect(host.requests[2]).toMatchObject({ homeRoot, command: { path: "Documents/report.txt" } });
    writeFileSync(join(homeRoot, ".openbot", "grants.json"), JSON.stringify({ version: 1, grants: {} }));
    await expect(backend.execute({ ...upload, path: "shared://Documents/report.txt" }))
      .resolves.toMatchObject({ ok: false, code: "permission_denied" });
  });
});
