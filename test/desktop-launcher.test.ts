import http from "node:http";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultConfigPath } from "../src/config/store.js";
import { defaultWorkspacesRoot } from "../src/execution/home.js";
import { defaultRuntimeRoot } from "../src/execution/runtime/local/environment.js";
import { defaultKeystoreDir } from "../src/keystore/index.js";
import { defaultGatewayTokenPath } from "../src/server/auth.js";
import { checkoutRootId as gatewayRootId } from "../src/server/build-identity.js";
import { withFileLock } from "../src/shared/file-lock.js";
import { defaultStoreDir } from "../src/store/index.js";
// @ts-expect-error executable launcher helpers have no declaration file.
import * as control from "../scripts/gateway-control.mjs";
// @ts-expect-error executable launcher helpers have no declaration file.
import * as launcher from "../scripts/launch.mjs";
// @ts-expect-error executable launcher helpers have no declaration file.
import { rotateLogFile } from "../scripts/common.mjs";
import { TempRoots } from "./helpers/temp-roots.js";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = new TempRoots();
const servers: http.Server[] = [];
// PIDs far above anything Windows or Linux hands out, so a real process is never touched.
let nextPid = 4_100_000_000;
const fakePid = () => (nextPid += 4);

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await temp.cleanup();
});

interface FakeGateway {
  url: string;
  health: Record<string, unknown> | null;
  shutdownAuth: string[];
  onShutdown: () => void;
}

async function fakeGateway(): Promise<FakeGateway> {
  const state: FakeGateway = { url: "", health: null, shutdownAuth: [], onShutdown: () => undefined };
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      if (state.health == null) { response.writeHead(503); response.end(); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(state.health));
      return;
    }
    if (request.url === "/shutdown" && request.method === "POST") {
      state.shutdownAuth.push(String(request.headers.authorization ?? ""));
      response.writeHead(202);
      response.end();
      setImmediate(() => state.onShutdown());
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  servers.push(server);
  const address = server.address();
  state.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return state;
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  unref = vi.fn();
  constructor(public pid: number | undefined) { super(); }
  kill = vi.fn(() => { this.exit(1); return true; });
  exit(code: number) {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

async function checkout(): Promise<{ root: string; rootId: string; build: string; tokenPath: string }> {
  const root = temp.make("openbot-launcher-");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "main.js"), "// build\n");
  const tokenPath = join(root, "data", "gateway.token");
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(tokenPath, "t".repeat(32));
  return { root, rootId: control.checkoutRootId(root), build: control.buildStamp(root), tokenPath };
}

const quietTrace = { mark: () => undefined };
const liveSet = (pids: Set<number>) => async (pid: number) => pids.has(pid);

function baseOptions(root: string, url: string, tokenPath: string, deps: Record<string, unknown>) {
  return {
    root, url, tokenPath, env: { PATH: process.env.PATH }, logsRoot: join(root, "logs"), trace: quietTrace,
    readyTimeoutMs: 3_000,
    deps: { withLock: withFileLock, portInUse: async () => false, readHealth: control.readHealth, ...deps },
  };
}

describe("gateway control", () => {
  it("computes the same checkout identity the gateway reports on /health", () => {
    for (const root of [repo, "C:\\Users\\Some One\\OpenBot", "c:/users/some one/openbot"]) {
      expect(control.checkoutRootId(root)).toBe(gatewayRootId(root));
    }
    expect(control.checkoutRootId("C:\\A\\OpenBot")).toBe(control.checkoutRootId("c:\\a\\openbot"));
  });

  it("reads a torn or foreign process record as no ownership", async () => {
    const { root } = await checkout();
    const path = control.processStatePath(root);
    await expect(control.readProcessState(path)).resolves.toBeNull();
    await writeFile(path, "{\"instanceId\":");
    await expect(control.readProcessState(path)).resolves.toBeNull();
    await writeFile(path, JSON.stringify({ instanceId: "a", gateway: {} }));
    await expect(control.readProcessState(path)).resolves.toBeNull();
    await writeFile(path, JSON.stringify({ instanceId: "a", gateway: { pid: 42 } }));
    await expect(control.readProcessState(path)).resolves.toMatchObject({ instanceId: "a" });
  });

  it("removes the process record only for the launcher instance that wrote it", async () => {
    const { root } = await checkout();
    const path = control.processStatePath(root);
    await control.writeProcessState(path, { instanceId: "newer", gateway: { pid: 42 } });
    await expect(control.removeProcessStateIfOwner(path, "older")).resolves.toBe(false);
    expect(existsSync(path)).toBe(true);
    await expect(control.removeProcessStateIfOwner(path, "newer")).resolves.toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("accepts only loopback gateway URLs", () => {
    expect(control.assertLoopbackUrl("http://127.0.0.1:1340/")).toBe("http://127.0.0.1:1340");
    for (const url of ["http://192.168.0.2:1340", "http://example.com", "file:///C:/x", "not a url"]) {
      expect(() => control.assertLoopbackUrl(url)).toThrow(/loopback|invalid/u);
    }
  });

  it("asks the proven gateway to shut down with its token and never forces after success", async () => {
    const { rootId, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    const pid = fakePid();
    const live = new Set([pid]);
    gateway.health = { ok: true, pid, rootId };
    gateway.onShutdown = () => live.delete(pid);
    const forceKill = vi.fn();
    let portOpen = true;
    gateway.onShutdown = () => { live.delete(pid); portOpen = false; };

    const result = await control.stopGateway({
      url: gateway.url, pid, rootId, tokenPath, isProcessRunning: liveSet(live), portInUse: async () => portOpen, forceKill,
    });

    expect(result).toMatchObject({ stopped: true, forced: false, gracefulAccepted: true });
    expect(gateway.shutdownAuth).toEqual([`Bearer ${"t".repeat(32)}`]);
    expect(forceKill).not.toHaveBeenCalled();
  });

  it.each([
    ["another PID", (pid: number, rootId: string) => ({ ok: true, pid: pid + 1, rootId })],
    ["another checkout", (pid: number) => ({ ok: true, pid, rootId: "0000000000000000" })],
  ])("never sends the token to a gateway that answers for %s", async (_label, health) => {
    const { rootId, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    const pid = fakePid();
    gateway.health = health(pid, rootId);
    const forceKill = vi.fn();

    await expect(control.stopGateway({
      url: gateway.url, pid, rootId, tokenPath, isProcessRunning: async () => true, portInUse: async () => true, forceKill,
    })).rejects.toThrow(/ownership cannot be proven/u);
    expect(gateway.shutdownAuth).toEqual([]);
    expect(forceKill).not.toHaveBeenCalled();
  });

  it("forces only after the bounded graceful wait and a fresh matching ownership proof", async () => {
    const { root, rootId, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    const pid = fakePid();
    const live = new Set([pid]);
    gateway.health = { ok: true, pid, rootId };
    const evidence = { pid, creationTime: "t0", executablePath: process.execPath, expectedRoot: root };
    const queried: number[] = [];
    const forceKill = vi.fn(async () => { live.delete(pid); });

    const result = await control.stopGateway({
      url: gateway.url, pid, rootId, tokenPath, evidence, timeoutMs: 150,
      isProcessRunning: liveSet(live), portInUse: async () => live.has(pid), forceKill,
      queryProcessEvidence: async (value: number) => {
        queried.push(value);
        return { pid, creationTime: "t0", executablePath: process.execPath, commandLine: `node ${join(root, "dist", "entry.js")}` };
      },
    });

    expect(result).toMatchObject({ stopped: true, forced: true, gracefulAccepted: true });
    expect(queried).toEqual([pid]);
    expect(forceKill).toHaveBeenCalledWith(pid);
  });

  it("leaves a recycled PID alone when its identity no longer matches the record", async () => {
    const { root, rootId, tokenPath } = await checkout();
    const pid = fakePid();
    const forceKill = vi.fn();
    await expect(control.stopGateway({
      url: "http://127.0.0.1:9", pid, rootId, tokenPath, timeoutMs: 50,
      evidence: { pid, creationTime: "t0", executablePath: process.execPath, expectedRoot: root },
      isProcessRunning: async () => true, portInUse: async () => true, forceKill,
      queryProcessEvidence: async () => ({ pid, creationTime: "t1", executablePath: process.execPath, commandLine: "other" }),
    })).rejects.toThrow(/left running/u);
    expect(forceKill).not.toHaveBeenCalled();
  });

  it("uses its own live child handle as proof when no evidence was captured", async () => {
    const { rootId, tokenPath } = await checkout();
    const child = new FakeChild(fakePid());
    const watch = control.watchChild(child);
    const forceKill = vi.fn(async () => child.exit(1));

    const result = await control.stopGateway({
      url: "http://127.0.0.1:9", pid: child.pid, rootId, tokenPath, watch, portInUse: async () => false, forceKill,
    });
    expect(result).toMatchObject({ stopped: true, forced: true, gracefulAccepted: false });
    expect(forceKill).toHaveBeenCalledOnce();
  });

  it("distinguishes an already-stopped gateway from a port taken by another process", async () => {
    const { rootId, tokenPath } = await checkout();
    const common = { url: "http://127.0.0.1:9", pid: fakePid(), rootId, tokenPath, isProcessRunning: async () => false };
    await expect(control.stopGateway({ ...common, portInUse: async () => false })).resolves.toMatchObject({ stopped: true, reason: "already-stopped" });
    await expect(control.stopGateway({ ...common, portInUse: async () => true })).resolves.toMatchObject({ stopped: false, reason: "port-held-by-other-process" });
  });

  it("waits only for this checkout's gateway and reports a dead child promptly", async () => {
    const gateway = await fakeGateway();
    const pid = fakePid();
    gateway.health = { ok: true, pid: pid + 1, rootId: "a" };
    await expect(control.waitForGateway(gateway.url, pid, { timeoutMs: 250 })).rejects.toThrow(/did not become ready/u);

    const child = new FakeChild(pid);
    const watch = control.watchChild(child);
    setTimeout(() => child.exit(7), 20);
    const started = Date.now();
    await expect(control.waitForGateway(gateway.url, pid, { watch, timeoutMs: 10_000, logHint: "gateway-error.log" }))
      .rejects.toThrow(/exited with code 7; see gateway-error\.log/u);
    expect(Date.now() - started).toBeLessThan(2_000);

    await expect(control.waitForGateway(gateway.url, pid, { timeoutMs: 10_000, isAlive: async () => false }))
      .rejects.toThrow(/stopped before becoming ready/u);

    gateway.health = { ok: true, pid, rootId: "other" };
    await expect(control.waitForGateway(gateway.url, pid, { rootId: "mine", timeoutMs: 1_000 })).rejects.toThrow(/does not belong/u);
  });

  it("rotates oversized logs with bounded retention", async () => {
    const directory = temp.make("openbot-log-rotation-");
    const log = join(directory, "electron.log");
    await writeFile(log, "x".repeat(128));
    await writeFile(`${log}.1`, "older");
    await writeFile(`${log}.2`, "oldest");
    await expect(rotateLogFile(log, { maxBytes: 64, backups: 2 })).resolves.toBe(true);
    await expect(readFile(`${log}.1`, "utf8")).resolves.toBe("x".repeat(128));
    await expect(readFile(`${log}.2`, "utf8")).resolves.toBe("older");
    expect(existsSync(`${log}.3`)).toBe(false);
    expect(existsSync(log)).toBe(false);
    await expect(rotateLogFile(log, { maxBytes: 64, backups: 2 })).resolves.toBe(false);
  });
});

describe("ensureGateway", () => {
  it("spawns one detached gateway, records ownership before readiness and checks the client while it boots", async () => {
    const { root, rootId, build, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    const statePath = control.processStatePath(root);
    const order: string[] = [];
    let spawned: FakeChild | undefined;
    const spawn = vi.fn((_command: string, _args: string[], options: { env: Record<string, string> }) => {
      spawned = new FakeChild(fakePid());
      order.push(`spawn:${options.env.OPENBOT_LOG_DIR === join(root, "logs")}`);
      setTimeout(() => { gateway.health = { ok: true, pid: spawned!.pid, rootId, build }; }, 60);
      return spawned;
    });
    const alongside = vi.fn(async () => {
      order.push(`alongside:recorded=${existsSync(statePath)}`);
    });

    const handle = await launcher.ensureGateway({ ...baseOptions(root, gateway.url, tokenPath, { spawn }), alongside });

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]![1]).toEqual([join(root, "dist", "entry.js")]);
    expect(spawn.mock.calls[0]![2]).toMatchObject({ detached: true, windowsHide: true, stdio: "ignore", cwd: root });
    expect(order).toEqual(["spawn:true", "alongside:recorded=true"]);
    expect(handle).toMatchObject({ pid: spawned!.pid, owned: true, adopted: false });
    expect(spawned!.unref).toHaveBeenCalled();
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state).toMatchObject({ instanceId: handle.instanceId, rootId, launcherPid: process.pid, gateway: { pid: spawned!.pid } });
    expect(JSON.stringify(state)).not.toContain("t".repeat(32));
  });

  it("fails closed when the port answers for another checkout", async () => {
    const { root, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    gateway.health = { ok: true, pid: fakePid(), rootId: "ffffffffffffffff", build: "1" };
    const spawn = vi.fn();
    await expect(launcher.ensureGateway(baseOptions(root, gateway.url, tokenPath, { spawn })))
      .rejects.toMatchObject({ exitCode: launcher.EXIT.GATEWAY, message: expect.stringMatching(/não é o gateway deste checkout/u) });
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(control.processStatePath(root))).toBe(false);
  });

  it("fails closed when the port is held by something that is not a gateway", async () => {
    const { root, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    const spawn = vi.fn();
    await expect(launcher.ensureGateway(baseOptions(root, gateway.url, tokenPath, { spawn, portInUse: async () => true })))
      .rejects.toMatchObject({ exitCode: launcher.EXIT.GATEWAY });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("adopts a current gateway another open launcher owns, without taking ownership", async () => {
    const { root, rootId, build, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    const pid = fakePid();
    const otherLauncher = fakePid();
    gateway.health = { ok: true, pid, rootId, build };
    const statePath = control.processStatePath(root);
    await control.writeProcessState(statePath, { instanceId: "primary", rootId, launcherPid: otherLauncher, gateway: { pid } });
    const spawn = vi.fn();

    const handle = await launcher.ensureGateway(baseOptions(root, gateway.url, tokenPath, {
      spawn, isProcessRunning: liveSet(new Set([pid, otherLauncher])),
    }));

    expect(handle).toMatchObject({ pid, owned: false, adopted: true });
    expect(spawn).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(statePath, "utf8")).instanceId).toBe("primary");
  });

  it("takes over an orphan gateway whose launcher is gone, so it is stopped with this window", async () => {
    const { root, rootId, build, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    const pid = fakePid();
    gateway.health = { ok: true, pid, rootId, build };
    const statePath = control.processStatePath(root);
    const evidence = { pid, creationTime: "t0", executablePath: process.execPath, expectedRoot: root };
    await control.writeProcessState(statePath, { instanceId: "orphan", rootId, launcherPid: fakePid(), gateway: { pid, evidence } });

    const handle = await launcher.ensureGateway(baseOptions(root, gateway.url, tokenPath, {
      spawn: vi.fn(), isProcessRunning: liveSet(new Set([pid])),
    }));

    expect(handle).toMatchObject({ pid, owned: true, adopted: true, evidence });
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state).toMatchObject({ instanceId: handle.instanceId, launcherPid: process.pid, gateway: { pid, evidence } });
  });

  it("replaces an orphan running an older build, but keeps one an open window still uses", async () => {
    const { root, rootId, build, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    const oldPid = fakePid();
    const statePath = control.processStatePath(root);
    const liveLauncher = fakePid();
    gateway.health = { ok: true, pid: oldPid, rootId, build: "older" };
    await control.writeProcessState(statePath, { instanceId: "old", rootId, launcherPid: liveLauncher, gateway: { pid: oldPid } });
    const stopGateway = vi.fn(async () => ({ stopped: true }));
    const spawn = vi.fn();

    const kept = await launcher.ensureGateway(baseOptions(root, gateway.url, tokenPath, {
      spawn, stopGateway, isProcessRunning: liveSet(new Set([oldPid, liveLauncher])),
    }));
    expect(kept).toMatchObject({ pid: oldPid, owned: false });
    expect(stopGateway).not.toHaveBeenCalled();

    const newPid = fakePid();
    stopGateway.mockImplementation(async () => {
      gateway.health = null;
      return { stopped: true };
    });
    spawn.mockImplementation(() => {
      setTimeout(() => { gateway.health = { ok: true, pid: newPid, rootId, build }; }, 30);
      return new FakeChild(newPid);
    });
    const replaced = await launcher.ensureGateway(baseOptions(root, gateway.url, tokenPath, {
      spawn, stopGateway, isProcessRunning: liveSet(new Set([oldPid])),
    }));
    expect(stopGateway).toHaveBeenCalledWith(expect.objectContaining({ pid: oldPid, rootId }));
    expect(replaced).toMatchObject({ pid: newPid, owned: true, adopted: false });
  });

  it("waits for its live supervisor while /health is down instead of spawning a second one", async () => {
    const { root, rootId, build, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    const pid = fakePid();
    const evidence = { pid, creationTime: "t0", executablePath: process.execPath, expectedRoot: root };
    await control.writeProcessState(control.processStatePath(root), { instanceId: "orphan", rootId, launcherPid: fakePid(), gateway: { pid, evidence } });
    setTimeout(() => { gateway.health = { ok: true, pid, rootId, build }; }, 80);
    const spawn = vi.fn();

    const handle = await launcher.ensureGateway(baseOptions(root, gateway.url, tokenPath, {
      spawn, isProcessRunning: liveSet(new Set([pid])),
      queryProcessEvidence: async () => ({ ...evidence, commandLine: `node ${join(root, "dist", "entry.js")}` }),
    }));
    expect(spawn).not.toHaveBeenCalled();
    expect(handle).toMatchObject({ pid, owned: true, adopted: true });
  });

  it("does not spawn a second supervisor when its recorded one stays alive but never answers", async () => {
    const { root, rootId, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    const pid = fakePid();
    const evidence = { pid, creationTime: "t0", executablePath: process.execPath, expectedRoot: root };
    await control.writeProcessState(control.processStatePath(root), { instanceId: "orphan", rootId, launcherPid: fakePid(), gateway: { pid, evidence } });
    const spawn = vi.fn();

    await expect(launcher.ensureGateway({
      ...baseOptions(root, gateway.url, tokenPath, {
        spawn, isProcessRunning: liveSet(new Set([pid])),
        queryProcessEvidence: async () => ({ ...evidence, commandLine: `node ${join(root, "dist", "entry.js")}` }),
      }),
      readyTimeoutMs: 200,
    })).rejects.toMatchObject({ exitCode: launcher.EXIT.GATEWAY, message: expect.stringMatching(/did not become ready/u) });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("starts a fresh gateway when the recorded supervisor dies while it waits", async () => {
    const { root, rootId, build, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    const pid = fakePid();
    const live = new Set([pid]);
    const evidence = { pid, creationTime: "t0", executablePath: process.execPath, expectedRoot: root };
    await control.writeProcessState(control.processStatePath(root), { instanceId: "orphan", rootId, launcherPid: fakePid(), gateway: { pid, evidence } });
    setTimeout(() => live.delete(pid), 50);
    const newPid = fakePid();
    const spawn = vi.fn(() => {
      setTimeout(() => { gateway.health = { ok: true, pid: newPid, rootId, build }; }, 30);
      return new FakeChild(newPid);
    });

    const handle = await launcher.ensureGateway(baseOptions(root, gateway.url, tokenPath, {
      spawn, isProcessRunning: liveSet(live),
      queryProcessEvidence: async () => ({ ...evidence, commandLine: `node ${join(root, "dist", "entry.js")}` }),
    }));
    expect(spawn).toHaveBeenCalledOnce();
    expect(handle).toMatchObject({ pid: newPid, owned: true });
  });

  it.each([
    ["a different creation time", { creationTime: "t1" }],
    ["a different executable", { executablePath: "C:\\Other\\node.exe" }],
    ["no process at all", null],
  ])("does not trust a recorded PID with %s", async (_label, override) => {
    const { root, rootId, build, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    const pid = fakePid();
    const evidence = { pid, creationTime: "t0", executablePath: process.execPath, expectedRoot: root };
    await control.writeProcessState(control.processStatePath(root), { instanceId: "stale", rootId, launcherPid: fakePid(), gateway: { pid, evidence } });
    const newPid = fakePid();
    const spawn = vi.fn(() => {
      setTimeout(() => { gateway.health = { ok: true, pid: newPid, rootId, build }; }, 20);
      return new FakeChild(newPid);
    });

    const handle = await launcher.ensureGateway(baseOptions(root, gateway.url, tokenPath, {
      spawn, isProcessRunning: liveSet(new Set([pid])),
      queryProcessEvidence: async () => override == null ? null : { ...evidence, commandLine: `node ${root}`, ...override },
    }));
    expect(spawn).toHaveBeenCalledOnce();
    expect(handle.pid).toBe(newPid);
  });

  it("surfaces a spawn error without recording ownership", async () => {
    const { root, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    const spawn = vi.fn(() => {
      const child = new FakeChild(undefined);
      queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" })));
      return child;
    });
    await expect(launcher.ensureGateway(baseOptions(root, gateway.url, tokenPath, { spawn })))
      .rejects.toMatchObject({ exitCode: launcher.EXIT.GATEWAY, message: expect.stringContaining("spawn node ENOENT") });
    expect(existsSync(control.processStatePath(root))).toBe(false);
  });

  it.each(["readiness", "client check"])("stops its own child and clears the record when the %s fails", async (failure) => {
    const { root, rootId, build, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    const child = new FakeChild(fakePid());
    const spawn = vi.fn(() => {
      if (failure === "readiness") setTimeout(() => child.exit(3), 30);
      else setTimeout(() => { gateway.health = { ok: true, pid: child.pid, rootId, build }; }, 30);
      return child;
    });
    const stopGateway = vi.fn(async () => ({ stopped: true }));
    const alongside = failure === "client check"
      ? async () => { throw new launcher.LaunchError("client stale", launcher.EXIT.BUILD); }
      : async () => undefined;

    const expected = failure === "readiness"
      ? { exitCode: launcher.EXIT.GATEWAY, message: expect.stringMatching(/exited with code 3/u) }
      : { exitCode: launcher.EXIT.BUILD };
    await expect(launcher.ensureGateway({ ...baseOptions(root, gateway.url, tokenPath, { spawn, stopGateway }), alongside }))
      .rejects.toMatchObject(expected);
    expect(stopGateway).toHaveBeenCalledWith(expect.objectContaining({ pid: child.pid, watch: expect.anything() }));
    expect(existsSync(control.processStatePath(root))).toBe(false);
  });

  it("serializes concurrent launchers so only one gateway is spawned", async () => {
    const { root, rootId, build, tokenPath } = await checkout();
    const gateway = await fakeGateway();
    const live = new Set<number>();
    const spawn = vi.fn(() => {
      const child = new FakeChild(fakePid());
      live.add(child.pid!);
      setTimeout(() => { gateway.health = { ok: true, pid: child.pid, rootId, build }; }, 40);
      return child;
    });
    const options = baseOptions(root, gateway.url, tokenPath, { spawn, isProcessRunning: liveSet(live) });

    const [first, second] = await Promise.all([launcher.ensureGateway(options), launcher.ensureGateway(options)]);
    expect(spawn).toHaveBeenCalledOnce();
    expect(first.pid).toBe(second.pid);
    // Same process for both calls, so the second one sees its own launcher as the recorded one.
    expect([first.owned, second.owned].filter(Boolean).length).toBeGreaterThanOrEqual(1);
  });
});

describe("launch", () => {
  it("emits opt-in monotonic startup telemetry without environment values", () => {
    const lines: string[] = [];
    let now = 100;
    const trace = launcher.createStartupTrace({ enabled: true, now: () => (now += 25), write: (line: string) => lines.push(line) });
    trace.mark("launcher-start");
    trace.mark("gateway-ready", { adopted: false });
    expect(lines.map((line) => JSON.parse(line.replace(/^\[openbot\]\[startup\] /u, "")))).toEqual([
      { event: "launcher-start", elapsedMs: 25 },
      { event: "gateway-ready", elapsedMs: 50, adopted: false },
    ]);
    const disabled: string[] = [];
    launcher.createStartupTrace({ enabled: false, write: (line: string) => disabled.push(line) }).mark("ignored");
    expect(disabled).toEqual([]);
  });

  it("clears remote/dev variables case-insensitively and pins Electron to the proven local gateway", () => {
    const env = launcher.electronEnvironment({
      PATH: "p", sand_host_gateway_url: "https://remote", SAND_HOST_GATEWAY_TOKEN: "secret", SAND_DEV_CAPABILITY: "1",
      SAND_DEV_CONTROL_PORT: "62150", VITE_DEV_SERVER_URL: "http://vite", Electron_Run_As_Node: "1",
      OPENBOT_INSTALL_ROOT: "C:\\old", OPENBOT_RELEASE_ROOT: "C:\\old\\v1",
    }, { root: "C:\\Repo", url: "http://127.0.0.1:1340", userData: "C:\\Profile\\electron" });
    expect(env).toEqual({
      PATH: "p",
      OPENBOT_LOCAL_GATEWAY: "1",
      OPENBOT_ROOT: "C:\\Repo",
      SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1340",
      SAND_DEV_BOX_CONTROL_PLANE: "0",
      SAND_DEV_APP_ICON: join("C:\\Repo", "assets", "openbot.ico"),
      OPENBOT_USER_DATA: "C:\\Profile\\electron",
    });
    const gatewayEnv = launcher.gatewayEnvironment({ SAND_HOST_GATEWAY_URL: "https://remote" }, "C:\\Repo", "C:\\Repo\\logs");
    expect(gatewayEnv).toEqual({ OPENBOT_LOCAL_GATEWAY: "1", OPENBOT_ROOT: "C:\\Repo", OPENBOT_LOG_DIR: "C:\\Repo\\logs" });
  });

  it("gives Electron the isolated profile, the GPU workaround and an optional loopback CDP port", () => {
    const base = { root: "C:\\Repo", userData: "C:\\Profile", logsRoot: "C:\\Repo\\logs" };
    expect(launcher.electronArguments(base)).toEqual([
      "--user-data-dir=C:\\Profile", "--disable-gpu", "--enable-logging",
      `--log-file=${join("C:\\Repo\\logs", "electron-chromium.log")}`, join("C:\\Repo", "scripts", "openbot-electron.cjs"),
    ]);
    expect(launcher.electronArguments({ ...base, cdpPort: 9333 })).toEqual(expect.arrayContaining([
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9333", "--remote-allow-origins=http://127.0.0.1:9333",
    ]));
    expect(launcher.parseCdpPort(undefined)).toBeNull();
    expect(launcher.parseCdpPort("9333")).toBe(9333);
    for (const invalid of ["0", "70000", "abc", "1.5"]) expect(() => launcher.parseCdpPort(invalid)).toThrow(/porta válida/u);
  });

  async function launchFixture(electronExit: number, options: { owned?: boolean; stopResult?: object; beforeLaunch?: (root: string) => Promise<void>; ensureTaskbar?: () => Promise<unknown> } = {}) {
    const { root, rootId, build } = await checkout();
    await options.beforeLaunch?.(root);
    const gateway = await fakeGateway();
    const gatewayPid = fakePid();
    const live = new Set<number>();
    if (options.owned === false) {
      const otherLauncher = fakePid();
      live.add(gatewayPid).add(otherLauncher);
      gateway.health = { ok: true, pid: gatewayPid, rootId, build };
      await control.writeProcessState(control.processStatePath(root), { instanceId: "primary", rootId, launcherPid: otherLauncher, gateway: { pid: gatewayPid } });
    }
    const electron = new FakeChild(fakePid());
    const spawn = vi.fn((command: string, _args?: string[], _options?: object) => {
      if (command === process.execPath) {
        live.add(gatewayPid);
        setTimeout(() => { gateway.health = { ok: true, pid: gatewayPid, rootId, build }; }, 20);
        return new FakeChild(gatewayPid);
      }
      setTimeout(() => electron.exit(electronExit), 20);
      return electron;
    });
    const stopGateway = vi.fn(async () => options.stopResult ?? { stopped: true, reason: "graceful" });
    const verifyClient = vi.fn(async () => ({ ok: true, errors: [] }));
    const run = launcher.launch({
      root, url: gateway.url,
      env: { OPENBOT_USER_DATA: join(root, "profile"), OPENBOT_DATA_ROOT: join(root, "data"), PATH: process.env.PATH },
      trace: quietTrace,
      resolveElectron: () => "C:\\electron.exe",
      verifyBackend: async () => ({ ok: true, errors: [] }),
      verifyClient,
      ensureTaskbar: options.ensureTaskbar ?? (async () => ({ cached: true })),
      deps: {
        spawn, stopGateway, withLock: withFileLock, portInUse: async () => false,
        isProcessRunning: liveSet(live), captureProcessEvidence: async (pid: number) => ({ pid, creationTime: "t0", executablePath: process.execPath, expectedRoot: root }),
      },
    });
    return { root, run, spawn, stopGateway, verifyClient, gatewayPid, electron };
  }

  it("stops a gateway it started once Electron exits, and clears its record", async () => {
    const fixture = await launchFixture(0);
    await expect(fixture.run).resolves.toBe(0);
    expect(fixture.verifyClient).toHaveBeenCalledOnce();
    expect(fixture.spawn.mock.calls[1]![2]).toMatchObject({ cwd: fixture.root, env: expect.objectContaining({ SAND_HOST_GATEWAY_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/u) }) });
    expect(fixture.stopGateway).toHaveBeenCalledOnce();
    expect(fixture.stopGateway).toHaveBeenCalledWith(expect.objectContaining({ pid: fixture.gatewayPid, evidence: expect.objectContaining({ creationTime: "t0" }) }));
    expect(existsSync(control.processStatePath(fixture.root))).toBe(false);
    expect(readFileSync(join(fixture.root, "logs", "electron.log"), "utf8")).toContain("OpenBot Electron launcher started");
  });

  it("bounds the Electron and Chromium logs before each launch", async () => {
    const fixture = await launchFixture(0, { beforeLaunch: async (root: string) => {
      await mkdir(join(root, "logs"), { recursive: true });
      await writeFile(join(root, "logs", "electron-chromium.log"), "x".repeat(2 * 1024 * 1024 + 16));
      await writeFile(join(root, "logs", "electron.log"), "y".repeat(2 * 1024 * 1024 + 16));
    } });
    await expect(fixture.run).resolves.toBe(0);
    expect(existsSync(join(fixture.root, "logs", "electron-chromium.log.1"))).toBe(true);
    expect(existsSync(join(fixture.root, "logs", "electron-chromium.log"))).toBe(false);
    expect(readFileSync(join(fixture.root, "logs", "electron.log.1"), "utf8")).toMatch(/^y+$/u);
  });

  it("never stops a gateway another open launcher owns", async () => {
    const fixture = await launchFixture(0, { owned: false });
    await expect(fixture.run).resolves.toBe(0);
    expect(fixture.stopGateway).not.toHaveBeenCalled();
    expect(fixture.spawn).toHaveBeenCalledOnce();
  });

  it("leaves the gateway to the already open window when Electron is a second instance", async () => {
    const fixture = await launchFixture(launcher.SECOND_INSTANCE_EXIT);
    await expect(fixture.run).resolves.toBe(0);
    expect(fixture.stopGateway).not.toHaveBeenCalled();
    expect(existsSync(control.processStatePath(fixture.root))).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("stops the launch and its gateway when the taskbar identity cannot be confirmed", async () => {
    const fixture = await launchFixture(0, { ensureTaskbar: async () => { throw new Error("Refusing to replace another application's shortcut"); } });
    await expect(fixture.run).rejects.toMatchObject({ exitCode: launcher.EXIT.FAILURE, message: expect.stringContaining("barra de tarefas") });
    expect(fixture.stopGateway).toHaveBeenCalledOnce();
    expect(fixture.spawn).toHaveBeenCalledOnce();
    expect(existsSync(control.processStatePath(fixture.root))).toBe(false);
  });

  it("reports a gateway that did not stop with its own exit code", async () => {
    const fixture = await launchFixture(0, { stopResult: { stopped: false, reason: "port-held-by-other-process" } });
    await expect(fixture.run).rejects.toMatchObject({ exitCode: launcher.EXIT.TEARDOWN });
  });

  it("does not start a gateway from a stale backend build or without Electron", async () => {
    const { root } = await checkout();
    const spawn = vi.fn();
    await expect(launcher.launch({
      root, env: {}, trace: quietTrace, resolveElectron: () => "C:\\electron.exe", deps: { spawn },
      verifyBackend: async () => ({ ok: false, errors: ["dist/main.js: output is older than source src/main.ts"] }),
    })).rejects.toMatchObject({ exitCode: launcher.EXIT.BUILD, message: expect.stringContaining("npm run build") });
    await expect(launcher.launch({
      root, env: {}, trace: quietTrace, deps: { spawn },
      resolveElectron: () => { throw new Error("Electron runtime not found"); },
    })).rejects.toMatchObject({ exitCode: launcher.EXIT.ELECTRON });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("desktop entry points", () => {
  it("keeps the shortcut launch hidden and explains each failure", () => {
    const hidden = readFileSync(join(repo, "scripts", "openbot-desktop.vbs"), "utf8");
    expect(hidden).toContain('BuildPath(scriptsDirectory, "openbot-desktop.cmd")');
    expect(hidden).toContain("exitCode = shell.Run(command, 0, True)");
    expect(hidden).toContain("fileSystem.GetTempName");
    expect(hidden).toContain("DateDiff");
    for (const code of [2, 3, 4, 5, 6]) expect(hidden).toMatch(new RegExp(`Case ${code}: reason = "`, "u"));
    expect(hidden).toMatch(/If exitCode = 0 Then\r?\n\s+If fileSystem\.FileExists\(logFile\) Then fileSystem\.DeleteFile logFile, True/u);
    expect(hidden).toContain("MsgBox reason");
  });

  it("delegates everything but the Node lookup to launch.mjs", () => {
    const command = readFileSync(join(repo, "scripts", "openbot-desktop.cmd"), "utf8");
    expect(command).toContain('node "%CD%\\scripts\\launch.mjs" %*');
    expect(command).toMatch(/exit \/b 5/u);
    expect(command).not.toMatch(/taskkill|start-gateway|shutdown-gateway|ELECTRON_PATH/iu);
  });

  it("uses explicit roaming and local data roots consistently", () => {
    vi.stubEnv("OPENBOT_DATA_ROOT", "C:\\OpenBot-Test\\roaming-custom");
    vi.stubEnv("OPENBOT_LOCAL_DATA_ROOT", "C:\\OpenBot-Test\\local-custom");
    expect(defaultConfigPath()).toBe("C:\\OpenBot-Test\\roaming-custom\\openbot-config.json");
    expect(defaultStoreDir()).toBe("C:\\OpenBot-Test\\roaming-custom");
    expect(defaultKeystoreDir()).toBe("C:\\OpenBot-Test\\roaming-custom");
    expect(defaultGatewayTokenPath()).toBe("C:\\OpenBot-Test\\roaming-custom\\gateway.token");
    expect(defaultWorkspacesRoot()).toBe("C:\\OpenBot-Test\\local-custom\\workspaces");
    expect(defaultRuntimeRoot()).toBe("C:\\OpenBot-Test\\local-custom\\runtime");
    expect(control.gatewayTokenPath("C:\\OpenBot-Test\\roaming-custom", {})).toBe(join("C:\\OpenBot-Test\\roaming-custom", "gateway.token"));
    expect(control.gatewayTokenPath("C:\\x", { OPENBOT_GATEWAY_TOKEN_PATH: "C:\\y\\token" })).toBe(resolve("C:\\y\\token"));
  });

  it("requests the Electron single-instance lock for local launches and marks secondary exits", () => {
    const main = readFileSync(join(repo, "client", "extracted", "dist", "electron-main", "main.cjs"), "utf8");
    expect(main).toMatch(/var isPrimaryInstance = process\.env\.OPENBOT_LOCAL_GATEWAY === "1" \|\| (\w+)\.app\.isPackaged \? \1\.app\.requestSingleInstanceLock\(\) : true;\r?\nif \(!isPrimaryInstance\) \1\.app\.exit\(23\);/u);
    expect(launcher.SECOND_INSTANCE_EXIT).toBe(23);
  });

  it("keeps the performance probe isolated and removes only roots it owns", () => {
    const probe = readFileSync(join(repo, "scripts", "perf-probe.mjs"), "utf8");
    expect(probe).toContain('process.env.NODE_ENV = "test"');
    expect(probe).toMatch(/const ownsDataRoot = !process\.env\.OPENBOT_DATA_ROOT;\r?\nconst dataRoot = process\.env\.OPENBOT_DATA_ROOT \|\| join\(tmpdir\(\), "openbot-perf-" \+ Date\.now\(\)\)/u);
    expect(probe.match(/\brm\(/gu)).toHaveLength(1);
    expect(probe).toMatch(/\} finally \{[\s\S]*if \(ownsDataRoot\) await rm\(dataRoot, \{ recursive: true, force: true \}\);\r?\n\}/u);
    expect(probe).not.toContain("process.exit(0)");
  });
});
