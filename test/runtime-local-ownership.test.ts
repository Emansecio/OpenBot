import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalProcessRunner, LocalRuntimeDriver, LocalRuntimeReconciler } from "../src/execution/runtime/local/driver.js";
import { nativeEnvironment } from "../src/execution/runtime/local/environment.js";
import { nativeJobName, nativeSandboxId, WindowsJobProcess } from "../src/execution/runtime/local/windows-job.js";
import { FileRuntimeLeaseJournal, MemoryRuntimeLeaseJournal, reconcileRuntimeLeases, type RuntimeLeaseRecord } from "../src/execution/runtime/recovery.js";
import { RuntimeManager } from "../src/execution/runtime/manager.js";
import { NativeJobHelperCache } from "../src/execution/runtime/local/helper-cache.js";
import { RuntimeScheduler } from "../src/execution/runtime/scheduler.js";
import type { RuntimeLease } from "../src/execution/runtime/contracts.js";

const roots: string[] = [];
const managers: RuntimeManager[] = [];
const jobs: WindowsJobProcess[] = [];
afterEach(async () => {
  await Promise.all(jobs.splice(0).map((job) => job.stop()));
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
async function fixture(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "openbot-native-ownership-")); roots.push(root); return root; }
const record = (): RuntimeLeaseRecord => { const leaseId = randomUUID(); return { recoveryKind: "native-job-v1", leaseId, agentId: "fixture", runtimeBootId: randomUUID(), temporaryId: `tmp-${leaseId}`, sandboxId: nativeSandboxId(leaseId) }; };

it("measures only admission waits with bounded aggregate counters", async () => {
  const scheduler = new RuntimeScheduler({ maxActiveLeases: 1, maxQueuedLeases: 1 });
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  await scheduler.reserveOrWaitFor("a", "a");
  const pending = scheduler.reserveOrWaitFor("b", "b");
  await expect(scheduler.reserveOrWaitFor("c", "c")).rejects.toThrow("queue is full");
  clock.mockReturnValue(160);
  scheduler.release("a"); await pending;
  const abort = new AbortController(); abort.abort();
  await expect(scheduler.reserveOrWaitFor("d", "d", abort.signal)).rejects.toThrow();
  expect(scheduler.metrics()).toEqual({ active: 1, waiting: 0, admitted: 2, rejected: 1, aborted: 1, waitMeanMs: 30, waitMaxMs: 60 });
  clock.mockReturnValue(900); scheduler.release("b");
  expect(scheduler.metrics().waitMaxMs).toBe(60);
});

describe.runIf(process.platform === "win32")("native owned foreground processes", () => {
  it("compiles a managed source-keyed helper once, reuses it, and rejects a corrupted binary", async () => {
    const parent = await fixture();
    const state = join(parent, "usuário-缓存-🚀"); await mkdir(state);
    const cache = new NativeJobHelperCache(state);
    const started = performance.now(); const executable = await cache.executable(); const coldMs = performance.now() - started;
    const warm = performance.now(); expect(await new NativeJobHelperCache(state).executable()).toBe(executable); const warmMs = performance.now() - warm;
    console.info(JSON.stringify({ nativeHelperFixture: { coldCompileMs: Math.round(coldMs), warmVerifyMs: Math.round(warmMs) } }));
    const identity = record(); const job = new WindowsJobProcess(nativeJobName(identity.runtimeBootId, identity.leaseId), process.env, executable); jobs.push(job);
    const ready = performance.now(); await job.start(); console.info(JSON.stringify({ nativeHelperFixture: { cachedReadyMs: Math.round(performance.now() - ready) } }));
    await job.stop();
    await writeFile(executable, "tampered fixture");
    await expect(new NativeJobHelperCache(state).executable()).rejects.toThrow("could not be verified");
  }, 15_000);

  it("resolves relative and bare executables in request cwd instead of the gateway directory", async () => {
    const home = await fixture(), host = await fixture(), state = await fixture();
    const executable = await new NativeJobHelperCache(state).executable();
    await copyFile(executable, join(host, "fixture.exe"));
    const runner = new LocalProcessRunner("fixture", home);
    const exitLease = { agentId: "fixture", capability: { networkProfile: "host" } } as RuntimeLease;
    await expect(runner.run(exitLease, { operation: "process.run", executable: process.execPath, argv: ["-e", "process.exit(-1)"], cwd: host, timeoutMs: 3000, networkProfile: "host" }, new AbortController().signal)).resolves.toMatchObject({ ok: true, exitCode: 4294967295 });
    for (const command of [".\\fixture.exe", "fixture.exe"]) {
      const lease = { agentId: "fixture", capability: { networkProfile: "host" } } as RuntimeLease;
      const result = await runner.run(lease, { operation: "process.run", executable: command, argv: [], cwd: host,
        stdin: JSON.stringify({ mode: "inspect", name: nativeJobName(randomUUID(), randomUUID()) }) + "\n", timeoutMs: 3000, networkProfile: "host" }, new AbortController().signal);
      expect(result).toMatchObject({ ok: true, stdout: "absent\r\n", exitCode: 0 });
    }
  }, 15_000);

  it("closes supervisor and a silent child promptly after a forced gateway-owner exit", async () => {
    const home = await fixture(); const state = await fixture();
    const executable = await new NativeJobHelperCache(state).executable();
    const identity = record(); const name = nativeJobName(identity.runtimeBootId, identity.leaseId);
    const ownerCode = `const {spawn}=require('child_process');const {createInterface}=require('readline');
      const [helper,name,cwd]=process.argv.slice(1);
      const supervisor=spawn(helper,[],{stdio:['pipe','pipe','ignore'],windowsHide:true});
      const frames=createInterface({input:supervisor.stdout});
      frames.on('line',line=>{ const frame=JSON.parse(line);
        if(frame.kind==='ready') supervisor.stdin.write(JSON.stringify({command:JSON.stringify(process.execPath)+' -e '+JSON.stringify("process.stdout.write('started');setTimeout(()=>require('fs').writeFileSync('late','orphan'),2500);setInterval(()=>{},1000)"),cwd,stdin:'',env:process.env})+'\\n');
        if(frame.kind==='stdout' && Buffer.from(frame.data,'base64').toString().includes('started')) process.exit(17);
      });
      supervisor.stdin.write(JSON.stringify({mode:'create',name})+'\\n');`;
    const owner = spawn(process.execPath, ["-e", ownerCode, executable, name, home], { stdio: "ignore", windowsHide: true });
    const closed = new Promise<number | null>((resolve) => owner.once("close", resolve));
    try {
      expect(await closed).toBe(17);
      const inspect = async (): Promise<string> => new Promise((resolve, reject) => {
        const probe = spawn(executable, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
        let result = ""; probe.stdout.on("data", (bytes: Buffer) => { result += bytes.toString(); });
        probe.once("error", reject); probe.once("close", (code) => code === 0 ? resolve(result.trim()) : reject(new Error("probe failed")));
        probe.stdin.end(JSON.stringify({ mode: "inspect", name }) + "\n");
      });
      // Read-only inspection must see absence BEFORE any reconciler can kill it.
      await vi.waitFor(async () => expect(await inspect()).toBe("absent"), { timeout: 2000 });
      await new Promise((resolve) => setTimeout(resolve, 2700));
      await expect(readFile(join(home, "late"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      owner.kill();
      await new LocalRuntimeReconciler({ runtimeRoot: state }).reconcileLease(identity);
    }
  }, 15_000);

  it("keeps overlapping maintenance fences separate from permanent agent deletion", async () => {
    const manager = new RuntimeManager({ driver: new LocalRuntimeDriver() }); managers.push(manager);
    const first = manager.fenceAgentMaintenance("fixture");
    const second = manager.fenceAgentMaintenance("fixture");
    first(); first();
    await expect(manager.acquire("fixture", { kind: "process.run", networkProfile: "host" })).rejects.toMatchObject({ code: "agent_fenced" });
    second();
    const lease = await manager.acquire("fixture", { kind: "process.run", networkProfile: "host" });
    await lease.release();
    const final = manager.fenceAgentMaintenance("fixture");
    await manager.stop("fixture", "agent-delete");
    final();
    await expect(manager.acquire("fixture", { kind: "process.run", networkProfile: "host" })).rejects.toMatchObject({ code: "agent_fenced" });
  });

  it("creates per-home operational paths without replacing credentials/profile, honoring explicit case-insensitive env", async () => {
    const a = await fixture(), b = await fixture(), shared = await fixture();
    await writeFile(join(shared, "sentinel"), "untouched");
    const [left, right] = await Promise.all([nativeEnvironment(a), nativeEnvironment(b)]);
    expect(left.TEMP).not.toBe(right.TEMP);
    expect(left.npm_config_cache).not.toBe(right.npm_config_cache);
    for (const key of ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "PATH"]) expect(left[key]).toBe(process.env[key]);
    const overridden = await nativeEnvironment(a, { temp: shared, NPM_CONFIG_CACHE: shared, FIXTURE_TOKEN: "synthetic" });
    expect(Object.keys(overridden).filter((key) => key.toLowerCase() === "temp")).toEqual(["temp"]);
    expect(overridden.temp).toBe(shared); expect(overridden.NPM_CONFIG_CACHE).toBe(shared);
    expect(overridden.FIXTURE_TOKEN).toBe("synthetic");
    await expect(readFile(join(shared, "sentinel"), "utf8")).resolves.toBe("untouched");
    const controller = new AbortController(); controller.abort();
    const canceled = await fixture();
    await expect(nativeEnvironment(canceled, {}, controller.signal)).rejects.toThrow();
    await expect(readFile(join(canceled, ".openbot-runtime"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects operational junctions and non-directories before creating paths outside home", async () => {
    const home = await fixture(), outside = await fixture();
    await symlink(outside, join(home, ".openbot-runtime"), "junction");
    await expect(nativeEnvironment(home)).rejects.toThrow();
    await expect(readFile(join(outside, "Temp"))).rejects.toMatchObject({ code: "ENOENT" });
    const state = await fixture();
    await symlink(outside, join(state, "native-helper-cache"), "junction");
    await expect(new NativeJobHelperCache(state).executable()).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
    const other = await fixture(); await mkdir(join(other, ".openbot-runtime"));
    await writeFile(join(other, ".openbot-runtime", "Temp"), "sentinel");
    await expect(nativeEnvironment(other)).rejects.toThrow();
    await expect(readFile(join(other, ".openbot-runtime", "Temp"), "utf8")).resolves.toBe("sentinel");
  });

  it("fails closed on legacy or mismatched identities, and cleans versioned empty pending records", async () => {
    const current = record();
    const legacy = { ...current }; delete legacy.recoveryKind;
    const bad = { ...record(), sandboxId: "native-unrelated" };
    const pending = record(); delete (pending as Partial<{ sandboxId: string }>).sandboxId;
    const journal = new MemoryRuntimeLeaseJournal([legacy, bad, { ...pending, pending: true }]);
    const result = await reconcileRuntimeLeases(journal, randomUUID(), new LocalRuntimeReconciler());
    expect(result).toMatchObject({ inspected: 3, cleaned: 1, failed: 2, complete: false });
    expect(await journal.list()).toHaveLength(2);
  }, 15_000);

  it("reopens the durable journal and terminates only its named supervisor and descendants", async () => {
    const home = await fixture(), other = await fixture(), state = await fixture();
    const journal = new FileRuntimeLeaseJournal(state);
    const driver = new LocalRuntimeDriver({ runtimeRoot: state });
    const manager = new RuntimeManager({ driver, journal, reconciler: new LocalRuntimeReconciler({ runtimeRoot: state }) }); managers.push(manager);
    const a = await manager.acquire("a", { kind: "process.run", networkProfile: "host" });
    const b = await manager.acquire("b", { kind: "process.run", networkProfile: "host" });
    const request = { operation: "process.run" as const, executable: process.execPath, argv: ["-e", "console.log('ready');setInterval(()=>{},1000)"], cwd: ".", timeoutMs: 15_000, networkProfile: "host" as const };
    const readyPath = join(home, "ready");
    const latePath = join(home, "late");
    const descendant = "setTimeout(()=>require('fs').writeFileSync(process.argv[1],'leaked'),5000)";
    const script = "require('child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{detached:true,stdio:'ignore'});require('fs').writeFileSync(process.argv[3],'ready');setInterval(()=>{},1000)";
    const running = driver.processRunner("a", home).run(a, { ...request, argv: ["-e", script, descendant, latePath, readyPath] }, new AbortController().signal);
    await vi.waitFor(async () => expect(await readFile(readyPath, "utf8")).toBe("ready"), { timeout: 3000 });
    // A second journal instance simulates recovery after losing the host's in-memory tables.
    const restarted = new FileRuntimeLeaseJournal(state);
    const persisted = (await restarted.list()).find((item) => item.leaseId === a.leaseId)!;
    await new LocalRuntimeReconciler({ runtimeRoot: state }).reconcileLease(persisted);
    await restarted.delete(a.leaseId);
    await expect(running).resolves.toMatchObject({ ok: false, code: "io_error" });
    await expect(driver.processRunner("b", other).run(b, { ...request, argv: ["-e", "process.stdout.write('other-alive')"] }, new AbortController().signal)).resolves.toMatchObject({ ok: true, stdout: "other-alive" });
    await a.release(); await b.release();
    expect(await restarted.list()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 5100));
    await expect(readFile(latePath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("owns the supervisor before allowing a command, and refuses a command after external recovery", async () => {
    const identity = record();
    const job = new WindowsJobProcess(nativeJobName(identity.runtimeBootId, identity.leaseId)); jobs.push(job);
    await job.start();
    await new LocalRuntimeReconciler().reconcileLease(identity);
    const home = await fixture();
    const frames: unknown[] = [];
    await job.run({ executable: process.execPath, argv: ["-e", "require('fs').writeFileSync('unexpected','bad')"], cwd: home, env: process.env }, (frame) => frames.push(frame));
    expect(frames).toEqual([]);
    await expect(readFile(join(home, "unexpected"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("cleans descendants after a natural parent exit rather than supporting an unmanaged daemon escape", async () => {
    const home = await fixture();
    const runner = new LocalProcessRunner("fixture", home);
    const lease = { agentId: "fixture", capability: { networkProfile: "host" } } as RuntimeLease;
    const child = "setTimeout(()=>require('fs').writeFileSync('late','escaped'),1500)";
    const result = await runner.run(lease, { operation: "process.run", executable: process.execPath,
      argv: ["-e", "require('child_process').spawn(process.execPath,['-e',process.argv[1]],{detached:true,stdio:'ignore'}).unref();process.stdout.write('root-exit')", child],
      cwd: ".", timeoutMs: 3000, networkProfile: "host" }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, stdout: "root-exit", exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 1700));
    await expect(readFile(join(home, "late"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);
});
