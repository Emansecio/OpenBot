/**
 * T1 — Smoke trivial: o bootstrap sobe e derruba o servidor.
 * A porta de produto continua fixa em 1340, mas estes testes usam porta
 * efêmera / ocupação controlada para não depender da 1340 estar livre.
 */

import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { GATEWAY_HOST, startServer, stopServer } from "../src/main.js";
import { defaultRegistry } from "../src/providers/router.js";
import { ProviderAdmissionScheduler } from "../src/providers/admission.js";
import { McpManager } from "../src/mcp/manager.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { MemoryReflectionWorker } from "../src/memory/reflection.js";

function isolated(root: string, overrides: Record<string, unknown> = {}) {
  return {
    configPath: join(root, "config.json"),
    storePath: join(root, "store.db"),
    keystoreDir: join(root, "keystore"),
    runtimeRoot: join(root, "runtime"),
    browserRoot: join(root, "browser"),
    disableAgentHome: true,
    allowUnauthenticatedLocalGateway: true,
    ...overrides,
  };
}

function listen(port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(port, GATEWAY_HOST, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: actual,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

function requestStatus(handle: Awaited<ReturnType<typeof startServer>>, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://${GATEWAY_HOST}:${handle.port}/api/countAgents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      agent: false,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end("{}");
  });
}

function requestPath(handle: Awaited<ReturnType<typeof startServer>>, path: string, body = "{}"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://${GATEWAY_HOST}:${handle.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      agent: false,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("bootstrap (T1)", () => {
  it("rejeita paths locais default em testes antes de tocar o estado injetado", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-bootstrap-local-paths-"));
    const configPath = join(root, "config.json");
    try {
      await expect(startServer(0, {
        configPath,
        storePath: join(root, "store.db"),
        keystoreDir: join(root, "keystore"),
        disableAgentHome: true,
        allowUnauthenticatedLocalGateway: true,
      })).rejects.toThrow(/local runtime\/workspace\/browser paths/i);
      expect(existsSync(configPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sobe e derruba o servidor numa porta livre", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-bootstrap-port-"));
    let handle: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      handle = await startServer(0, isolated(root));
      expect(handle.server.listening).toBe(true);
      const addr = handle.server.address();
      expect(typeof addr).not.toBe("string");
      if (addr && typeof addr === "object") {
        expect(addr.port).toBeGreaterThan(0);
        expect(addr.address).toBe(GATEWAY_HOST);
      }
    } finally {
      if (handle) await stopServer(handle);
      rmSync(root, { recursive: true, force: true });
    }
    expect(handle?.server.listening).toBe(false);
  });

  it("inicia sem bots e não cria a home openbot-default", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-bootstrap-zero-"));
    const workspacesRoot = join(root, "workspaces");
    let handle: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      handle = await startServer(0, {
        ...isolated(root, {
          disableAgentHome: false,
          workspacesRoot,
        }),
      });
      expect(handle.config.snapshot().agents).toEqual([]);
      expect(handle.homes).toBeDefined();
      expect(existsSync(join(workspacesRoot, "openbot-default"))).toBe(false);
    } finally {
      if (handle) await stopServer(handle);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("isola o registry de providers entre instâncias sem tocar no defaultRegistry", async () => {
    const defaultNames = defaultRegistry.names();
    const firstRoot = mkdtempSync(join(tmpdir(), "openbot-bootstrap-registry-1-"));
    const first = await startServer(0, isolated(firstRoot));
    const firstRegistry = first.registry;
    try {
      expect(firstRegistry.has("openai")).toBe(true);
      expect(firstRegistry.has("xai")).toBe(true);
      expect(defaultRegistry.names()).toEqual(defaultNames);
    } finally {
      await stopServer(first);
      rmSync(firstRoot, { recursive: true, force: true });
    }

    const secondRoot = mkdtempSync(join(tmpdir(), "openbot-bootstrap-registry-2-"));
    const second = await startServer(0, isolated(secondRoot));
    try {
      expect(second.registry).not.toBe(firstRegistry);
      expect(second.registry.has("openai")).toBe(true);
      expect(defaultRegistry.names()).toEqual(defaultNames);
    } finally {
      await stopServer(second);
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it("rejeita com erro claro quando a porta pedida já está em uso (sem fallback dinâmico)", async () => {
    const occupied = await listen();
    const root = mkdtempSync(join(tmpdir(), "openbot-bootstrap-occupied-"));
    try {
      await expect(startServer(occupied.port, isolated(root))).rejects.toThrow(/já está em uso/);
    } finally {
      await occupied.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fecha admission, waiters e leases ativos quando o listen falha", async () => {
    const occupied = await listen();
    const root = mkdtempSync(join(tmpdir(), "openbot-bootstrap-admission-listen-error-"));
    const admission = new ProviderAdmissionScheduler({ maxActive: 1, maxQueued: 1 });
    const active = await admission.acquire("preexisting");
    const waiting = admission.acquire("queued").catch((error: unknown) => error);
    try {
      await expect(startServer(occupied.port, {
        ...isolated(root),
        providerAdmission: admission,
      })).rejects.toThrow(/já está em uso/);
      // O lease ativo segura a fila até o shutdown do listen-failure dispensar
      // o waiter — liberar por timer corria contra a duração do bootstrap.
      expect(await waiting).toMatchObject({ code: "shutdown" });
      active.release();
      await admission.drain();
      expect(admission.metrics()).toMatchObject({ active: 0, waiting: 0 });
      await expect(admission.acquire("after-failure")).rejects.toMatchObject({ code: "shutdown" });
    } finally {
      active.release();
      await occupied.close();
      // O reject do listen dispara no timeout enquanto o cleanup ainda solta o
      // handle do SQLite — no Windows o unlink pode chegar antes do close.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try { rmSync(root, { recursive: true, force: true }); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
    }
  });

  it("rejeita listen bounded e posterga stores enquanto lease não libera", async () => {
    const occupied = await listen();
    const root = mkdtempSync(join(tmpdir(), "openbot-bootstrap-admission-deferred-"));
    const admission = new ProviderAdmissionScheduler({ maxActive: 1, maxQueued: 1 });
    const active = await admission.acquire("provider-ignora-abort");
    const waiting = admission.acquire("queued").catch((error: unknown) => error);
    const store = new SqliteTranscriptStore({ path: join(root, "store.db") });
    const closeStore = store.close.bind(store);
    let storeClosed = 0;
    let resolveStoreClosed!: () => void;
    const storeClosedSignal = new Promise<void>((resolve) => {
      resolveStoreClosed = resolve;
    });
    store.close = () => {
      storeClosed += 1;
      closeStore();
      resolveStoreClosed();
    };
    const mcpManager = new McpManager({ servers: [] });
    const closeMcp = mcpManager.close.bind(mcpManager);
    let mcpClosed = 0;
    let resolveMcpClosed!: () => void;
    const mcpClosedSignal = new Promise<void>((resolve) => {
      resolveMcpClosed = resolve;
    });
    mcpManager.close = async () => {
      mcpClosed += 1;
      await closeMcp();
      resolveMcpClosed();
    };
    const reflectionClose = vi.spyOn(MemoryReflectionWorker.prototype, "close");
    try {
      const startedAt = Date.now();
      await expect(startServer(occupied.port, {
        ...isolated(root),
        store,
        mcpManager,
        providerAdmission: admission,
      })).rejects.toThrow(/já está em uso/);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(await waiting).toMatchObject({ code: "shutdown" });
      expect(reflectionClose).toHaveBeenCalled();
      expect(storeClosed).toBe(0);
      expect(mcpClosed).toBe(0);

      active.release();
      await Promise.all([storeClosedSignal, mcpClosedSignal]);
      expect(storeClosed).toBe(1);
      expect(mcpClosed).toBe(1);
      expect(admission.metrics()).toMatchObject({ active: 0, waiting: 0 });
    } finally {
      active.release();
      await occupied.close();
      rmSync(root, { recursive: true, force: true });
      reflectionClose.mockRestore();
    }
  });

  it("rejeita gatewayToken vazio em teste sem a flag explícita", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-bootstrap-empty-token-"));
    try {
      await expect(startServer(0, {
        stateRoot: root,
        runtimeRoot: join(root, "runtime"),
        browserRoot: join(root, "browser"),
        workspacesRoot: join(root, "workspaces"),
        disableAgentHome: true,
        gatewayToken: "",
      })).rejects.toThrow(/gatewayToken explícito vazio/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("em boot não-test com configPath custom cria token ao lado do config e exige Bearer", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-bootstrap-custom-auth-"));
    const previousNodeEnv = process.env.NODE_ENV;
    let handle: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      process.env.NODE_ENV = "production";
      handle = await startServer(0, {
        configPath: join(root, "custom-config.json"),
        storePath: join(root, "custom-store.db"),
        keystoreDir: join(root, "keys"),
        runtimeRoot: join(root, "runtime"),
        browserRoot: join(root, "browser"),
        workspacesRoot: join(root, "workspaces"),
        disableAgentHome: true,
      });
      expect(existsSync(join(root, "gateway.token"))).toBe(true);
      expect(handle.gatewayToken).toMatch(/\S{16,}/);
      await expect(requestStatus(handle)).resolves.toBe(401);
      await expect(requestStatus(handle, handle.gatewayToken)).resolves.toBe(200);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (handle) await stopServer(handle);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("em boot não-test com OPENBOT_DATA_ROOT usa o token no env root mesmo com configPath custom", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-bootstrap-env-root-auth-"));
    const dataRoot = join(root, "env-root");
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDataRoot = process.env.OPENBOT_DATA_ROOT;
    let handle: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      process.env.NODE_ENV = "production";
      process.env.OPENBOT_DATA_ROOT = dataRoot;
      handle = await startServer(0, {
        configPath: join(root, "custom-config.json"),
        storePath: join(root, "custom-store.db"),
        keystoreDir: join(root, "keys"),
        runtimeRoot: join(root, "runtime"),
        browserRoot: join(root, "browser"),
        workspacesRoot: join(root, "workspaces"),
        disableAgentHome: true,
      });
      expect(existsSync(join(dataRoot, "gateway.token"))).toBe(true);
      expect(existsSync(join(root, "gateway.token"))).toBe(false);
      await expect(requestStatus(handle)).resolves.toBe(401);
      await expect(requestStatus(handle, handle.gatewayToken)).resolves.toBe(200);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousDataRoot === undefined) delete process.env.OPENBOT_DATA_ROOT;
      else process.env.OPENBOT_DATA_ROOT = previousDataRoot;
      if (handle) await stopServer(handle);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tenta todos os cleanups quando abortAllTurns falha e preserva o erro original", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-bootstrap-shutdown-"));
    const handle = await startServer(0, isolated(root, { disableAgentHome: false, workspacesRoot: join(root, "workspaces") }));
    const calls: string[] = [];
    const runner = handle.runner as typeof handle.runner & { abortAllTurns: () => Promise<void> };
    runner.abortAllTurns = async () => {
      calls.push("abort");
      throw new Error("abort failed");
    };
    const runtimeClose = handle.runtimeManager.close.bind(handle.runtimeManager);
    handle.runtimeManager.close = async () => { calls.push("runtime"); await runtimeClose(); };
    const mcpClose = handle.mcpManager?.close.bind(handle.mcpManager);
    if (handle.mcpManager && mcpClose) handle.mcpManager.close = async () => { calls.push("mcp"); await mcpClose(); };
    const browserClose = handle.browserSessionManager?.close.bind(handle.browserSessionManager);
    if (handle.browserSessionManager && browserClose) handle.browserSessionManager.close = async () => { calls.push("browser"); await browserClose(); };
    const gatewayClose = handle.gateway.close.bind(handle.gateway);
    handle.gateway.close = () => { calls.push("gateway"); gatewayClose(); };
    const storeClose = handle.store.close.bind(handle.store);
    handle.store.close = () => { calls.push("store"); storeClose(); };
    const configClose = handle.config.close.bind(handle.config);
    handle.config.close = () => { calls.push("config"); configClose(); };
    try {
      await expect(stopServer(handle)).rejects.toThrow("abort failed");
      expect(calls).toEqual(expect.arrayContaining(["abort", "runtime", "mcp", "browser", "gateway", "store", "config"]));
      expect(handle.server.listening).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stopServer concorrente compartilha a mesma promessa e fecha recursos uma vez", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-bootstrap-shutdown-once-"));
    const handle = await startServer(0, isolated(root));
    const calls = new Map<string, number>();
    const count = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);
    const runner = handle.runner as typeof handle.runner & { abortAllTurns: () => Promise<void> };
    runner.abortAllTurns = async () => { count("abort"); };
    for (const [name, resource] of [
      ["runtime", handle.runtimeManager],
      ["mcp", handle.mcpManager],
      ["browser", handle.browserSessionManager],
    ] as const) {
      if (resource) {
        const close = resource.close.bind(resource);
        resource.close = async () => { count(name); await close(); };
      }
    }
    const gatewayClose = handle.gateway.close.bind(handle.gateway);
    handle.gateway.close = () => { count("gateway"); gatewayClose(); };
    const storeClose = handle.store.close.bind(handle.store);
    handle.store.close = () => { count("store"); storeClose(); };
    const conversationClose = handle.conversationStore.close.bind(handle.conversationStore);
    handle.conversationStore.close = () => { count("conversation"); conversationClose(); };
    const configClose = handle.config.close.bind(handle.config);
    handle.config.close = () => { count("config"); configClose(); };
    const serverClose = handle.server.close.bind(handle.server);
    handle.server.close = ((callback?: (err?: Error) => void) => {
      count("server");
      return serverClose(callback);
    });

    try {
      const first = stopServer(handle);
      const second = stopServer(handle);
      expect(second).toBe(first);
      await Promise.all([first, second]);
      for (const value of calls.values()) expect(value).toBe(1);
      expect(calls).toEqual(new Map([
        ["abort", 1], ["runtime", 1], ["mcp", 1], ["gateway", 1],
        ["store", 1], ["conversation", 1], ["config", 1], ["server", 1],
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("timeout de abort aguarda drain antes de fechar dependências", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-bootstrap-shutdown-drain-"));
    const handle = await startServer(0, isolated(root, {
      disableAgentHome: false,
      workspacesRoot: join(root, "workspaces"),
    }));
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const calls: string[] = [];
    const runner = handle.runner as typeof handle.runner & {
      abortAllTurns: () => Promise<void>;
      waitForDrain: () => Promise<void>;
    };
    runner.abortAllTurns = async () => { throw new Error("turn shutdown timed out"); };
    runner.waitForDrain = () => drain;
    const resources = [
      ["reflection", handle.reflectionWorker],
      ["broker", handle.executionBroker],
      ["mcp", handle.mcpManager],
      ["browser", handle.browserSessionManager],
      ["runtime", handle.runtimeManager],
    ] as const;
    for (const [name, resource] of resources) {
      if (resource) {
        const close = resource.close.bind(resource);
        resource.close = async () => { calls.push(name); await close(); };
      }
    }
    const storeClose = handle.store.close.bind(handle.store);
    handle.store.close = () => { calls.push("store"); storeClose(); };
    const configClose = handle.config.close.bind(handle.config);
    handle.config.close = () => { calls.push("config"); configClose(); };
    const shutdown = stopServer(handle, { turnTimeoutMs: 1 });
    await waitForCondition(() => !handle.server.listening, 1_000);
    expect(handle.server.listening).toBe(false);
    expect(calls).toEqual([]);
    releaseDrain();
    await expect(shutdown).rejects.toThrow("turn shutdown timed out");
    expect(calls).toEqual(expect.arrayContaining(["reflection", "broker", "mcp", "browser", "runtime", "store", "config"]));
    const storeIndex = calls.indexOf("store");
    for (const dependency of ["reflection", "broker", "mcp", "browser", "runtime"]) {
      expect(calls.indexOf(dependency), `${dependency} before store`).toBeLessThan(storeIndex);
    }
    expect(calls.indexOf("config")).toBeGreaterThan(storeIndex);
    rmSync(root, { recursive: true, force: true });
  });

  it("stopServer entra em quiescência antes do abort e bloqueia mutador concorrente", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-bootstrap-shutdown-quiescence-"));
    const handle = await startServer(0, isolated(root));
    let releaseAbort!: () => void;
    const abort = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const runner = handle.runner as typeof handle.runner & { abortAllTurns: () => Promise<void> };
    runner.abortAllTurns = () => abort;
    const shutdown = stopServer(handle);
    await expect(requestPath(handle, "/api/createConversation", "{malformed")).resolves.toBe(503);
    releaseAbort();
    await shutdown;
    rmSync(root, { recursive: true, force: true });
  });

  it("drain sem fim atinge deadline e não fecha dependências para o fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-bootstrap-shutdown-drain-deadline-"));
    const handle = await startServer(0, isolated(root, {
      disableAgentHome: false,
      workspacesRoot: join(root, "workspaces"),
    }));
    const calls: string[] = [];
    const runner = handle.runner as typeof handle.runner & {
      abortAllTurns: () => Promise<void>;
      waitForDrain: () => Promise<void>;
    };
    runner.abortAllTurns = async () => { throw new Error("turn shutdown timed out"); };
    runner.waitForDrain = () => new Promise<void>(() => {});
    const manualClose: Array<() => void | Promise<void>> = [];
    for (const [name, resource] of [
      ["reflection", handle.reflectionWorker],
      ["broker", handle.executionBroker],
      ["mcp", handle.mcpManager],
      ["browser", handle.browserSessionManager],
      ["runtime", handle.runtimeManager],
    ] as const) {
      if (resource) {
        const close = resource.close.bind(resource);
        manualClose.push(close);
        resource.close = async () => { calls.push(name); await close(); };
      }
    }
    const storeClose = handle.store.close.bind(handle.store);
    manualClose.push(storeClose);
    handle.store.close = () => { calls.push("store"); storeClose(); };
    const configClose = handle.config.close.bind(handle.config);
    manualClose.push(configClose);
    handle.config.close = () => { calls.push("config"); configClose(); };
    let shutdownError: unknown;
    try {
      await stopServer(handle, { turnTimeoutMs: 1, drainTimeoutMs: 20 });
    } catch (error) {
      shutdownError = error;
    }
    expect(shutdownError).toBeInstanceOf(AggregateError);
    expect((shutdownError as AggregateError).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringMatching(/turn drain timed out/i) }),
    ]));
    expect(calls).toEqual([]);
    for (const close of manualClose) await close();
    rmSync(root, { recursive: true, force: true });
  });
});

async function waitForCondition(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`condition timeout after ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
