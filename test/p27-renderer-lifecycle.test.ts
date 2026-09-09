import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const testFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(testFile), "..");
const profilerPath = join(repoRoot, "scripts", "electron-p27-profile.mjs");
const profilerSource = readFileSync(profilerPath, "utf8");
const requireFromProject = createRequire(join(repoRoot, "package.json"));

function evaluateEvidence(runs: unknown[]): Promise<any> {
  const expression = `const module = await import(${JSON.stringify(pathToFileURL(profilerPath).href)}); process.stdout.write(JSON.stringify(module.evaluateEvidence(${JSON.stringify(runs)})));`;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", expression], { cwd: repoRoot, windowsHide: true, env: { ...process.env, VITEST: undefined, VITEST_WORKER_ID: undefined }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(stderr || "P27 evaluator child failed"));
      else {
        try { resolvePromise(JSON.parse(stdout)); } catch (error) { reject(error); }
      }
    });
  });
}

function passingSnapshot(): any {
  return {
    label: "idle",
    wallMs: 1000,
    documentTimeOrigin: 1,
    cpu: { measured: true, idlePercent: 1 },
    overlay: {
      observer: { measured: true, overlayInstances: 1, callbackDurationsMeasured: true, callbackP95Ms: 1, callbackMaxMs: 2, callbackTotalMs: 2 },
      scans: { measured: true, callbacks: 0, p95Ms: 1, maxMs: 2 },
      longTasks: { measured: true, count: 0 },
      eventLoopLag: { measured: true, p95Ms: 1, maxMs: 2 },
      listeners: { measured: true, active: 1 },
      timers: { measured: true, activeOverlay: 0 },
    },
    cdp: { measured: true, taskDuration: 0.01, jsHeapUsedSize: 100_000_000 },
  };
}

describe("P2.7 renderer lifecycle profiler contract", () => {
  it("keeps instrumentation outside the packaged renderer boundary", () => {
    expect(profilerSource).toContain("Page.addScriptToEvaluateOnNewDocument");
    expect(profilerSource).toContain("--remote-debugging-port=0");
    expect(profilerSource).toContain("taskkill");
    expect(profilerSource).toContain("mkdtempSync");
    expect(profilerSource).toContain("noPaidProvider: true");
    expect(profilerSource).not.toContain("index-DVUCYGay.js");
    expect(profilerSource).not.toContain("openbot-local-settings.js");
    expect(profilerSource).not.toContain("client-artifacts.manifest.json");
    expect(profilerSource).not.toContain("api.openai.com");
    expect(requireFromProject("electron")).toBeTruthy();
  });

  it("measures the complete duration of asynchronous overlay scans", () => {
    expect(profilerSource).toContain('typeof result.then === "function"');
    expect(profilerSource).toContain("Promise.resolve(result).finally(recordScan)");
  });

  it("returns GREEN only when every metric is actually measured and within contract", async () => {
    const first = passingSnapshot();
    const second = passingSnapshot();
    first.label = "idle-baseline";
    second.cdp.taskDuration = 0.011;
    second.cdp.jsHeapUsedSize = 100_100_000;
    const result = await evaluateEvidence([{ runIndex: 1, snapshots: [first, second] }]);
    expect(result.status).toBe("GREEN");
    expect(Object.values(result.checks as Record<string, { measured: boolean; pass: boolean }>).every((check) => check.measured && check.pass)).toBe(true);
  });

  it("fails closed when a requested renderer metric is not observable", async () => {
    const first = passingSnapshot();
    first.label = "idle-baseline";
    first.overlay.scans = { measured: false };
    const second = passingSnapshot();
    second.overlay.scans = { measured: false };
    const result = await evaluateEvidence([{ runIndex: 1, snapshots: [first, second] }]);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.checks.scans.measured).toBe(false);
    expect(result.checks.scans.pass).toBe(false);
  });

  it("marks a measured threshold breach RED rather than converting it to a hypothesis", async () => {
    const first = passingSnapshot();
    first.label = "idle-baseline";
    first.overlay.longTasks = { measured: true, count: 1 };
    const result = await evaluateEvidence([{ runIndex: 1, snapshots: [first, passingSnapshot()] }]);
    expect(result.status).toBe("RED");
    expect(result.checks.longTasks).toMatchObject({ measured: true, pass: false, value: 1 });
  });

  it("measures idle CPU from idle samples instead of active streaming", async () => {
    const baseline = passingSnapshot();
    baseline.label = "idle-baseline";
    baseline.wallMs = 1000;
    baseline.cdp.taskDuration = 1;
    const streaming = passingSnapshot();
    streaming.label = "stream";
    streaming.wallMs = 2000;
    streaming.cpu.idlePercent = 75;
    streaming.cdp.taskDuration = 1.75;
    const idle = passingSnapshot();
    idle.label = "idle";
    idle.wallMs = 5000;
    idle.cpu.idlePercent = 1;
    idle.cdp.taskDuration = 1.78;

    const result = await evaluateEvidence([{ runIndex: 1, snapshots: [baseline, streaming, idle] }]);

    expect(result.checks.cpu).toMatchObject({ measured: true, pass: true, value: 1 });
  });

  it("does not execute Electron as part of the focused contract test", () => {
    expect(profilerSource).toContain("async function main()");
    expect(profilerSource).toContain("if (resolve(process.argv[1] || \"\") === fileURLToPath(import.meta.url))");
  });
});
