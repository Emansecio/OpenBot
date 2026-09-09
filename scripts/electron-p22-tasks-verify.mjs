import { spawn,execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { promisify } from "node:util";

import { runP22TasksFixture } from "./electron-p22-fixture.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(process.env.OPENBOT_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const requireFromProject = createRequire(join(repoRoot, "package.json"));
const exe = process.env.ELECTRON_EXE || requireFromProject("electron");
const electronMain = process.env.OPENBOT_ELECTRON_MAIN || join(repoRoot, "client", "extracted", "dist", "electron-main", "main.cjs");
const backendFixture = join(repoRoot, "scripts", "electron-p23-backend-fixture.mjs");

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not allocate a free CDP port");
  return port;
}

async function waitCdp(cdpUrl, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const targets = await (await fetch(cdpUrl)).json();
      const page = targets.find((t) => t.title === "OpenBot" && t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(400);
  }
  throw new Error("CDP OpenBot page not found");
}

async function stopProcessTree(child, exited) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try { await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch {}
  } else if (!child.killed) {
    try { child.kill("SIGTERM"); } catch {}
  }
  await Promise.race([exited, sleep(5000)]);
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let next = 1;
  const ready = new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) => {
    const id = next++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return { ws, ready, send };
}

async function main() {
  let runRoot;
  let backend;
  let backendExited = Promise.resolve();
  let child;
  let exited = Promise.resolve();
  let evidenceDir;
  try {
    runRoot = mkdtempSync(join(tmpdir(), "openbot-p22-tasks-"));
    // The packaged app resolves its bridge through the real local gateway; the
    // gate is self-sufficient: it boots the OpenBot backend (like the P2.3
    // gate) so agent context, welcome dismissal and overlay mounting are real.
    const dataRoot = join(runRoot, "data");
    let gatewayPort = 0;
    mkdirSync(dataRoot, { recursive: true });
    const backendEnv = { ...process.env, OPENBOT_DATA_ROOT: dataRoot, OPENBOT_LOCAL_DATA_ROOT: join(runRoot, "local-data"), OPENBOT_LOG_DIR: join(runRoot, "logs"), OPENBOT_VISUAL_TEST: "1", NODE_ENV: "production" };
    // This script is also launched from Vitest. The backend must boot with a
    // production-like environment instead of inheriting worker hooks/options
    // that are meaningful only inside the parent test process.
    for (const name of ["VITEST", "VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]) {
      delete backendEnv[name];
    }
    async function bootBackend() {
      let backendLog = "";
      const readyPath = join(runRoot, "backend-ready.json");
      backend = spawn(process.execPath, [backendFixture, join(repoRoot, "dist", "main.js"), readyPath], { cwd: repoRoot, env: backendEnv, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      backendExited = new Promise((resolve) => backend.once("close", resolve));
      const capture = (data) => {
        const text = String(data);
        backendLog = (backendLog + text).slice(-16_384);
        process.stdout.write(text);
      };
      backend.stdout?.on("data", capture);
      backend.stderr?.on("data", capture);
      for (let wait = 0; wait < 60; wait += 1) {
        if (backend.exitCode !== null) {
          throw new Error(`P2.2 backend exited before health (code ${backend.exitCode}): ${backendLog}`);
        }
        try {
          if (existsSync(readyPath)) {
            const ready = JSON.parse(readFileSync(readyPath, "utf8"));
            gatewayPort = Number(ready.port);
            if (!Number.isInteger(gatewayPort) || gatewayPort <= 0) throw new Error("invalid fixture port");
            const health = await (await fetch("http://127.0.0.1:" + gatewayPort + "/health", { signal: AbortSignal.timeout(800) })).json();
            if (health?.ok === true) return;
          }
        } catch {}
        await sleep(300);
      }
      throw new Error(`P2.2 gate backend did not become healthy: ${backendLog}`);
    }
    await bootBackend();
    let token = "";
    for (let attempt = 0; attempt < 60 && !token; attempt += 1) {
      try { token = readFileSync(join(dataRoot, "gateway.token"), "utf8").trim(); } catch { await sleep(300); }
    }
    if (!token) {
      console.log("P22_DEBUG", JSON.stringify({ dataRoot, backendPid: backend?.pid, backendExit: backend?.exitCode }));
      throw new Error("P2.2 gate backend did not publish a gateway token at " + dataRoot);
    }
    const userData = join(runRoot, "user-data");
    const appData = join(runRoot, "appdata");
    const localAppData = join(runRoot, "localappdata");
    mkdirSync(join(repoRoot, "logs"), { recursive: true });
    evidenceDir = mkdtempSync(join(repoRoot, "logs", "electron-p22-verify-"));
    mkdirSync(userData, { recursive: true });
    mkdirSync(appData, { recursive: true });
    mkdirSync(localAppData, { recursive: true });
    const cdpPort = await getFreePort();
    const cdpUrl = `http://127.0.0.1:${cdpPort}/json/list`;
    child = spawn(exe, [
      `--user-data-dir=${userData}`,
      "--no-sandbox",
      "--disable-gpu",
      `--remote-debugging-port=${cdpPort}`,
      electronMain,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        OPENBOT_USER_DATA: userData,
        OPENBOT_DATA_ROOT: dataRoot,
        OPENBOT_LOCAL_DATA_ROOT: join(runRoot, "local-data"),
        OPENBOT_LOCAL_GATEWAY: "1",
        OPENBOT_VISUAL_TEST: "1",
        SAND_HOST_GATEWAY_URL: "http://127.0.0.1:" + gatewayPort,
        GATEWAY_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exited = new Promise((resolve) => child.once("close", resolve));
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    const page = await waitCdp(cdpUrl);
    const { ws, ready, send } = connect(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    await send("Page.enable");
    const evalExpr = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error("PAGE: " + (result.exceptionDetails.exception?.description || result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)));
      return result.result?.value;
    };
    const waitForEval = async (expression, timeoutMs = 6000, intervalMs = 25) => {
      const deadline = Date.now() + timeoutMs;
      let last = false;
      while (Date.now() < deadline) {
        last = await evalExpr(expression);
        if (last) return last;
        await sleep(intervalMs);
      }
      throw new Error(`P2.2 page condition timed out: ${expression}; last=${JSON.stringify(last)}`);
    };
    await waitForEval("document.readyState === 'complete' && Boolean(window.desktop?.agent) && Boolean(document.querySelector('script[src*=\"openbot-memory-ui\"]'))");
    const shot = async (name) => {
      const img = await send("Page.captureScreenshot", { format: "png" });
      const target = join(evidenceDir, `${name}.png`);
      writeFileSync(target, Buffer.from(img.data, "base64"));
      return target;
    };
    // Dismiss the welcome overlay so the native host surface is reachable,
    // then mount a settings-button host (same deterministic pattern used by
    // the existing visual gate) plus the memory agent fixture, so the real
    // overlay mounts its toolbar and tasks surface.
    try { await evalExpr("document.getElementById('openbot-welcome-continue')?.click()"); } catch {}
    await waitForEval("!document.getElementById('openbot-welcome')", 1000).catch(() => undefined);
    await evalExpr("(() => { const welcome = document.getElementById('openbot-welcome'); if (welcome) welcome.remove(); return true; })()");
    await evalExpr("(() => { window.__openbotMemoryUiAgent = { getProviderConfig: async () => ({ agentId: 'agent-a', provider: 'xai', model: 'test' }) }; document.getElementById('openbot-visual-tasks-host')?.remove(); for (const button of [...document.querySelectorAll('[aria-label=\"View agent settings\"]')]) { if (button.closest('#openbot-visual-tasks-host')) continue; button.style.display = 'none'; } const host = document.createElement('section'); host.id = 'openbot-visual-tasks-host'; host.style.cssText = 'position:fixed;left:24px;top:24px;padding:12px;background:#181818;color:#fff;border:1px solid #303030;border-radius:16px;z-index:2147482000'; host.innerHTML = '<div style=\"display:flex;align-items:center;gap:8px;flex-wrap:wrap\"><strong>Bot Visual</strong><button type=\"button\" aria-label=\"View agent settings\" style=\"min-height:40px;padding:8px 12px\">Configurações</button></div>'; document.body.prepend(host); window.dispatchEvent(new Event('openbot:memory-ui-rescan')); return true; })()");
    const bootDeadline = Date.now() + 12000;
    let info = null;
    while (Date.now() < bootDeadline) {
      info = await evalExpr("(() => ({ title: document.title, hasMemoryScript: Boolean(document.querySelector('script[src*=\"openbot-memory-ui\"]')) }))()");
      if (info?.hasMemoryScript) break;
      await sleep(250);
    }
    console.log("P22_BOOT", JSON.stringify(info, null, 2));
    if (!info?.hasMemoryScript) {
      throw new Error(`P2.2 overlay surface missing: ${JSON.stringify(info)}`);
    }
    const evidence = await runP22TasksFixture({ evalExpr, shot, sleep, evidenceDir, log: (line, value) => console.log(line, typeof value === "string" ? value : JSON.stringify(value ?? null)) });
    const evidencePath = join(evidenceDir, "p22-evidence.json");
    writeFileSync(evidencePath, JSON.stringify({ ...evidence, evidenceDir }, null, 2));
    console.log("P22_EVIDENCE", JSON.stringify({ ok: evidence.ok, steps: evidence.steps.length, screenshots: evidence.screenshots }));
    console.log("P22_EVIDENCE_DIR", evidenceDir);
    if (!evidence.ok) throw new Error("P2.2 Electron fixture assertions failed: " + JSON.stringify(evidence.steps.filter((s) => !s.pass)));
    console.log("ELECTRON_P22_GATE GREEN");
    ws.close();
  } finally {
    await stopProcessTree(child, exited);
    await stopProcessTree(backend, backendExited);
    if (runRoot) { for (let attempt = 0; attempt < 5; attempt += 1) { try { rmSync(runRoot, { recursive: true, force: true }); break; } catch { await sleep(200); } } }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
