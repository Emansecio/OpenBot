/**
 * P2.3 real-Electron gate (UI-driven). Boots the OpenBot backend and the
 * packaged Electron renderer, and interacts with the REAL overlay surface
 * (openbot-memory-ui.js P2.3 block) through CDP: open, paste, drop, preview,
 * remove/discard, send, search, pagination, select result, reply, Escape
 * teardown and pagehide teardown, using only opaque staging IDs over the real
 * preload bridge. Records DOM + screenshot + JSON evidence under
 * logs/electron-p23-verify/.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(process.env.OPENBOT_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const requireFromProject = createRequire(join(repoRoot, "package.json"));
const exe = process.env.ELECTRON_EXE || requireFromProject("electron");
const electronMain = process.env.OPENBOT_ELECTRON_MAIN || join(repoRoot, "client", "extracted", "dist", "electron-main", "main.cjs");
const backendFixture = join(repoRoot, "scripts", "electron-p23-backend-fixture.mjs");
let activeStageSignal;

function sleep(ms, signal = activeStageSignal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function withTimeout(label, timeoutMs, operation, externalSignal) {
  const controller = new AbortController();
  const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
  const abortFromExternal = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  try {
    const value = await operationPromise;
    controller.signal.throwIfAborted();
    return value;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
    await operationPromise.catch(() => undefined);
  }
}

async function waitForHealth(url, timeoutMs, signal) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const h = await (await fetch(url + "/health", { signal: AbortSignal.any([signal, AbortSignal.timeout(800)]) })).json(); if (h && h.ok === true) return h; } catch {}
    await sleep(200, signal);
  }
  throw new Error("backend health timeout " + url);
}

async function stopTree(child, exited) {
  if (!child?.pid) return true;
  if (process.platform === "win32") { try { await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch {} }
  else if (!child.killed) { try { child.kill("SIGTERM"); } catch {} }
  return withTimeout(`process ${child.pid} exit`, 5000, (signal) => new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    exited.then(() => resolve(true), reject).finally(() => signal.removeEventListener("abort", onAbort));
  })).catch(() => false);
}

async function portIsReleased(port, label) {
  const server = createServer();
  try {
    await withTimeout(`${label} port ${port} release`, 5000, (signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    }));
    return true;
  } catch {
    return false;
  } finally {
    await new Promise((resolve) => server.close(() => resolve())).catch(() => undefined);
  }
}

function connect(url, commandTimeoutMs = 10000) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let next = 1;
  const ready = new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
    }
  });
  const send = (method, params = {}) => {
    const id = next++;
    ws.send(JSON.stringify({ id, method, params }));
    return withTimeout(`CDP ${method}`, commandTimeoutMs, (signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      pending.set(id, { resolve, reject });
    }), activeStageSignal)
      .finally(() => pending.delete(id));
  };
  ws.addEventListener("close", () => {
    for (const { reject } of pending.values()) reject(new Error("CDP socket closed"));
    pending.clear();
  });
  return { ws, ready, send };
}

async function waitCdp(cdpUrl, timeoutMs = 60000, signal) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const targets = await (await fetch(cdpUrl, { signal })).json();
      const page = targets.find((t) => t.type === "page" && t.title === "OpenBot") || targets.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(400, signal);
  }
  throw new Error("CDP page not found");
}

async function main() {
  let runRoot, backend, child, evidenceDir, ws, gatewayPort, cdpPort;
  let seededCount = 0;
  let backendExited = Promise.resolve();
  let electronExited = Promise.resolve();
  let failure;
  const steps = [];
  const stages = [];
  const cleanup = { electronExited: false, backendExited: false, gatewayPortReleased: false, cdpPortReleased: false, runRootRemoved: false };
  const runStage = async (name, timeoutMs, operation) => {
    const startedAt = Date.now();
    try {
      const value = await withTimeout(name, timeoutMs, async (signal) => {
        activeStageSignal = signal;
        try { return await operation(signal); }
        finally { activeStageSignal = undefined; }
      });
      stages.push({ name, ok: true, timeoutMs, durationMs: Date.now() - startedAt });
      return value;
    } catch (error) {
      stages.push({ name, ok: false, timeoutMs, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
  try {
    runRoot = mkdtempSync(join(tmpdir(), "openbot-p23-"));
    const dataRoot = join(runRoot, "data");
    const userData = join(runRoot, "user-data");
    const appData = join(runRoot, "appdata");
    const localAppData = join(runRoot, "localappdata");
    mkdirSync(dataRoot, { recursive: true }); mkdirSync(join(repoRoot, "logs"), { recursive: true });
    evidenceDir = mkdtempSync(join(repoRoot, "logs", "electron-p23-verify-"));
    mkdirSync(userData, { recursive: true }); mkdirSync(appData, { recursive: true }); mkdirSync(localAppData, { recursive: true });

    const backendReadyPath = join(runRoot, "backend-ready.json");
    const backendEnv = { ...process.env, OPENBOT_DATA_ROOT: dataRoot, OPENBOT_LOG_DIR: join(runRoot, "logs"), OPENBOT_VISUAL_TEST: "1" };
    backend = spawn(process.execPath, [backendFixture, join(repoRoot, "dist", "main.js"), backendReadyPath], { cwd: repoRoot, env: backendEnv, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    backendExited = new Promise((resolve) => backend.once("close", resolve));
    backend.stdout?.on("data", (d) => process.stdout.write(d)); backend.stderr?.on("data", (d) => process.stderr.write(d));
    const backendReady = await runStage("backend-owned-port", 20000, async (signal) => {
      while (!existsSync(backendReadyPath)) {
        if (backend.exitCode !== null) throw new Error(`backend exited with code ${backend.exitCode}`);
        await sleep(100, signal);
      }
      return JSON.parse(readFileSync(backendReadyPath, "utf8"));
    });
    gatewayPort = Number(backendReady.port);
    if (!Number.isInteger(gatewayPort) || gatewayPort <= 0) throw new Error("backend did not report an owned gateway port");
    const gatewayUrl = "http://127.0.0.1:" + gatewayPort;
    await runStage("backend-health", 5000, (signal) => waitForHealth(gatewayUrl, 5000, signal));
    const token = await runStage("gateway-token", 5000, async (signal) => {
      const tokenPath = join(dataRoot, "gateway.token");
      while (true) {
        try { const value = readFileSync(tokenPath, "utf8").trim(); if (value) return value; } catch {}
        await sleep(100, signal);
      }
    });

    const devToolsPortPath = join(userData, "DevToolsActivePort");
    child = spawn(exe, ["--user-data-dir=" + userData, "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", electronMain], {
      cwd: repoRoot,
      env: { ...process.env, APPDATA: appData, LOCALAPPDATA: localAppData, OPENBOT_USER_DATA: userData,
        OPENBOT_DATA_ROOT: dataRoot, OPENBOT_LOCAL_GATEWAY: "1", OPENBOT_VISUAL_TEST: "1",
        SAND_HOST_GATEWAY_URL: gatewayUrl, GATEWAY_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    electronExited = new Promise((resolve) => child.once("close", resolve));
    child.stdout.on("data", (d) => process.stdout.write(d)); child.stderr.on("data", (d) => process.stderr.write(d));

    cdpPort = await runStage("electron-owned-cdp-port", 20000, async (signal) => {
      while (!existsSync(devToolsPortPath)) {
        if (child.exitCode !== null) throw new Error(`Electron exited with code ${child.exitCode}`);
        await sleep(100, signal);
      }
      const port = Number(readFileSync(devToolsPortPath, "utf8").split(/\r?\n/u)[0]);
      if (!Number.isInteger(port) || port <= 0) throw new Error("Electron did not report an owned CDP port");
      return port;
    });
    const cdpUrl = "http://127.0.0.1:" + cdpPort + "/json/list";
    const page = await runStage("electron-openbot-page", 20000, (signal) => waitCdp(cdpUrl, 20000, signal));
    const connection = connect(page.webSocketDebuggerUrl);
    ws = connection.ws;
    const { ready, send } = connection;
    await runStage("cdp-session", 10000, async (signal) => { await abortable(ready, signal); await send("Runtime.enable"); await send("Page.enable"); });
    const evalExpr = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error("PAGE: " + (result.exceptionDetails.exception?.description || result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)));
      return result.result?.value;
    };
    const shot = async (name) => { const img = await send("Page.captureScreenshot", { format: "png" }); const target = join(evidenceDir, name + ".png"); writeFileSync(target, Buffer.from(img.data, "base64")); return target; };

    await runStage("renderer-ready", 10000, async () => {
      while (await evalExpr("document.readyState") !== "complete") await sleep(100);
    });
    await runStage("renderer-fixture-binding", 5000, async () => {
      try { await evalExpr("document.getElementById('openbot-welcome-continue')?.click()"); } catch {}
      await evalExpr("(() => { const welcome = document.getElementById('openbot-welcome'); if (welcome) welcome.remove(); return true; })()");
      // Deterministic agent binding for the overlay surface (same pattern as the
      // P2.2 visual host): the overlay reads __openbotMemoryUiAgent first.
      await evalExpr("window.__openbotMemoryUiAgent = { getProviderConfig: async () => ({ agentId: 'agent-a', provider: 'xai', model: 'test' }) }");
    });

    const step = (name, pass, detail) => steps.push({ name, pass: !!pass, detail: detail ?? null });
    const agentId = "agent-a";
    const api = gatewayUrl + "/api";
    const rpc = async (method, body = {}, tk = token) => {
      const signal = activeStageSignal
        ? AbortSignal.any([activeStageSignal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000);
      const res = await (await fetch(api + "/" + method, { method: "POST", headers: { "content-type": "application/json", ...(tk ? { authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(body), signal })).json();
      if (res && res.ok === false) throw new Error(method + " failed: " + res.failure);
      return res && res.ok === true ? res.value : res;
    };
    await runStage("agent-bootstrap", 10000, async () => {
      try { await rpc("createAgent", { id: agentId, name: "P23" }); } catch {}
      await rpc("openAgent", { agentId });
    });

    // Wait until the per-agent turn queue drains (provider calls without
    // credentials fail fast, but the queue is serial) so later UI staging/send
    // commits deterministically.
    const waitDrain = async (label) => {
      let busy = true;
      while (busy) {
        const status = await rpc("getPromptStatus", { agentId }).catch(() => ({ isBusy: true }));
        busy = status?.isBusy === true;
        if (busy) await sleep(200);
      }
      console.log("P23_DRAIN", label, "busy=" + busy);
    };

    // Seed transcript for search + pagination: durable user echoes land in FTS
    // even without a provider credential (echo is the acceptance commit point).
    await runStage("search-seed-persisted", 20000, async () => {
    for (let n = 0; n < 21; n += 1) {
      await rpc("sendPrompt", { agentId, prompt: "pg buscavel conteudo nº " + n + " alfa", clientNonce: "p23-seed-" + n }).catch(() => undefined);
    }
    // Wait until the durable user echoes are FTS-searchable (echo is the turn
    // acceptance commit point; provider failures are non-blocking).
    seededCount = 0;
    for (let i = 0; i < 80 && seededCount < 21; i += 1) {
      seededCount = (await rpc("searchTranscript", { agentId, query: "pg", limit: 50 }).catch(() => ({ items: [] }))).items?.length ?? 0;
      if (seededCount < 21) await sleep(200);
    }
    });
    step("seed persisted for search (>= 21 matches to page)", seededCount >= 21, JSON.stringify({ count: seededCount }).slice(0, 120));
    await runStage("search-seed-queue-drained", 20000, () => waitDrain("seed"));

    await runStage("real-renderer-workflow", 75000, async () => {
    // 1) The engine is present, but its internal milestone launcher is not user-facing.
    const surface = await evalExpr("(() => { const launch = document.querySelector('[data-openbot-p23-launch]'); return { launched: Boolean(launch), visible: launch ? getComputedStyle(launch).display !== 'none' : false, memoryScript: Boolean(document.querySelector('script[src*=\"openbot-memory-ui\"]')), bridge: Boolean(window.desktop && window.desktop.p23) }; })()");
    step("P2.3 engine present and internal launcher hidden", !!(surface.launched && !surface.visible && surface.memoryScript && surface.bridge), JSON.stringify(surface));

    // 2) Open through the internal event contract used by the fixture.
    await evalExpr("window.dispatchEvent(new Event('openbot:p23-open'))");
    await sleep(300);
    const opened = await evalExpr("(() => { const d = document.querySelector('.obp23-dialog'); const panel = d && d.querySelector('.obp23-panel'); return { open: Boolean(d), dialog: panel ? panel.getAttribute('role') : null, modal: panel ? panel.getAttribute('aria-modal') : null }; })()");
    step("surface opens as modal dialog", !!(opened.open && opened.dialog === "dialog" && opened.modal === "true"), JSON.stringify(opened));

    // 3) Paste -> stage -> preview through the real bridge.
    await evalExpr("(() => { const ta = document.getElementById('obp23-paste'); if (ta) ta.value = 'ui staged note content for p23 evidence'; const b = document.querySelector('.obp23-dialog [data-act=p23-stage]'); if (b) b.click(); return true; })()");
    let stagedUi = null;
    for (let i = 0; i < 40; i += 1) {
      stagedUi = await evalExpr("(() => { const items = [...document.querySelectorAll('#obp23-staged .obp23-item')]; return { count: items.length, text: items.length ? (items[0].innerText || '') : '' }; })()");
      if (stagedUi?.count >= 1) break;
      await sleep(200);
    }
    step("paste stages an opaque attachment with preview", stagedUi?.count === 1 && /ui staged note content/.test(stagedUi.text || ""), JSON.stringify(stagedUi));
    const backendStaged1 = await rpc("listStagedAttachments", { agentId }).catch(() => []);
    step("staged attachment registered server-side", Array.isArray(backendStaged1) && backendStaged1.length === 1 && (backendStaged1[0]?.attachmentId ?? "").startsWith("att-"), JSON.stringify(backendStaged1).slice(0, 160));
    await shot("p23-ui-staged");

    // 4) Drop a file onto the drop zone.
    const dropResult = await evalExpr("(async () => {" +
      "const zone = document.getElementById('obp23-drop-zone');" +
      "if (!zone) return { missing: true };" +
      "const bytes = new TextEncoder().encode('dropped file note for p23 evidence');" +
      "const file = new File([bytes], 'dropped-note.txt', { type: 'text/plain' });" +
      "const dt = new DataTransfer();" +
      "dt.items.add(file);" +
      "zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));" +
      "zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));" +
      "return { dispatched: true };" +
      "})()");
    step("drop dispatched on real drop zone", dropResult && dropResult.dispatched === true, JSON.stringify(dropResult));
    let stagedUi2 = null;
    for (let i = 0; i < 40; i += 1) {
      stagedUi2 = await evalExpr("(() => { const items = [...document.querySelectorAll('#obp23-staged .obp23-item')]; return { count: items.length, text: items.map((el) => el.innerText || '').join(' | ') }; })()");
      if (stagedUi2?.count >= 2 && /dropped file note/.test(stagedUi2.text || "")) break;
      await sleep(200);
    }
    step("drop stages a second opaque attachment with preview", stagedUi2?.count === 2 && /dropped file note/.test(stagedUi2.text || ""), JSON.stringify(stagedUi2));
    await shot("p23-ui-staged-drop");

    // 5) Remove one staged attachment (server-side discard path).
    await evalExpr("document.querySelector('#obp23-staged .obp23-item button.obp23-remove')?.click()");
    await sleep(500);
    const removedUi = await evalExpr("document.querySelectorAll('#obp23-staged .obp23-item').length");
    const backendStaged2 = await rpc("listStagedAttachments", { agentId }).catch(() => []);
    step("remove deletes the staged attachment server-side", removedUi === 1 && Array.isArray(backendStaged2) && backendStaged2.length === 1, JSON.stringify({ removedUi, backend: backendStaged2.length }));

    // 6) Send the remaining attachment through the UI (opaque refs only).
    await evalExpr("document.querySelector('#obp23-sendatt')?.click()");
    let sendStatus = "";
    for (let i = 0; i < 40; i += 1) {
      sendStatus = await evalExpr("document.getElementById('obp23-stage-status')?.textContent || ''");
      if (/Enviado/.test(sendStatus)) break;
      await sleep(200);
    }
    step("UI send reaches the gateway with opaque staging refs", /Enviado/.test(sendStatus), sendStatus.slice(0, 160));
    // The attach turn commits staging asynchronously; poll the authoritative
    // server-side registry until it clears (bounded).
    // The send consumes the opaque staging (state -> consumed); the server
    // keeps the bounded row until expiry, so assert consumption, not deletion.
    let consumedAfterSend = false;
    for (let i = 0; i < 120 && !consumedAfterSend; i += 1) {
      const stagedAfterSend = await rpc("listStagedAttachments", { agentId }).catch(() => []);
      consumedAfterSend = Array.isArray(stagedAfterSend) && stagedAfterSend.length > 0
        ? stagedAfterSend.every((item) => typeof item.state === "string" && item.state !== "staged")
        : stagedAfterSend.length === 0;
      if (!consumedAfterSend) {
        await rpc("getPromptStatus", { agentId }).catch(() => undefined);
        await sleep(300);
      }
    }
    step("sent staging consumed by the turn (state leaves staged)", consumedAfterSend, JSON.stringify({ consumedAfterSend }));

    // 7) Search with pagination through the UI.
    await evalExpr("(() => { const q = document.getElementById('obp23-query'); if (q) q.value = 'pg'; document.querySelector('.obp23-dialog [data-act=p23-search]')?.click(); return true; })()");
    let searchUi = null;
    for (let i = 0; i < 60; i += 1) {
      searchUi = await evalExpr("(() => { const list = document.getElementById('obp23-results'); const next = document.getElementById('obp23-search-next'); const prev = document.getElementById('obp23-search-prev'); const items = list ? list.querySelectorAll('.obp23-item').length : 0; return { items, nextDisabled: next ? next.disabled : true, prevDisabled: prev ? prev.disabled : true }; })()");
      if ((searchUi?.items ?? 0) > 0) break;
      await sleep(250);
    }
    step("search renders results in the UI", (searchUi?.items ?? 0) > 0, JSON.stringify(searchUi));
    step("pagination next available on page 1 (stable cursor)", searchUi?.nextDisabled === false, JSON.stringify(searchUi));
    await shot("p23-ui-search");
    await evalExpr("document.getElementById('obp23-search-next')?.click()");
    await sleep(600);
    const page2 = await evalExpr("(() => { const list = document.getElementById('obp23-results'); return { items: list ? list.querySelectorAll('.obp23-item').length : 0, prevDisabled: document.getElementById('obp23-search-prev')?.disabled ?? true }; })()");
    step("next page navigates (cursor) and prev becomes available", (page2?.items ?? 0) > 0 && page2?.prevDisabled === false, JSON.stringify(page2));
    await evalExpr("document.getElementById('obp23-search-prev')?.click()");
    await sleep(600);
    const backPage1 = await evalExpr("document.querySelectorAll('#obp23-results .obp23-item').length");
    step("previous page returns to page 1", backPage1 === 20, String(backPage1));

    // 8) Select a result and reply (replyToId resolved server-side).
    await evalExpr("document.querySelector('#obp23-results .obp23-item [data-act=p23-pickt]')?.click()");
    await sleep(200);
    const target = await evalExpr("document.getElementById('obp23-target')?.textContent || ''");
    step("search result selected as reply target", /@/.test(target) && target.indexOf("nenhum") < 0, target.slice(0, 120));
    await evalExpr("(() => { const ri = document.getElementById('obp23-reply'); if (ri) ri.value = 'resposta p23 pela UI'; document.querySelector('#obp23-sendreply')?.click(); return true; })()");
    let replyStatus = "";
    for (let i = 0; i < 40; i += 1) {
      replyStatus = await evalExpr("document.getElementById('obp23-reply-status')?.textContent || ''");
      if (/enviada/.test(replyStatus)) break;
      await sleep(200);
    }
    step("UI reply accepted with server-resolved target", /enviada/.test(replyStatus), replyStatus.slice(0, 160));
    await shot("p23-ui-reply");

    // 9) Escape closes the surface and releases the app root.
    await evalExpr("(() => { const panel = document.querySelector('.obp23-dialog .obp23-panel'); if (panel) panel.focus({ preventScroll: true }); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true; })()");
    await sleep(300);
    const closedEscape = await evalExpr("(() => ({ open: Boolean(document.querySelector('.obp23-dialog')), inert: document.getElementById('root')?.inert === true }))()");
    step("Escape closes the surface and releases the app root", closedEscape.open === false && closedEscape.inert === false, JSON.stringify(closedEscape));

    // 10) pagehide teardown discards uncommitted staging server-side.
    await evalExpr("window.dispatchEvent(new Event('openbot:p23-open'))");
    await sleep(300);
    await evalExpr("(() => { const ta = document.getElementById('obp23-paste'); if (ta) ta.value = 'to be discarded on pagehide'; document.querySelector('.obp23-dialog [data-act=p23-stage]')?.click(); return true; })()");
    let stagedBeforeHide = 0;
    for (let i = 0; i < 40; i += 1) {
      stagedBeforeHide = await evalExpr("document.querySelectorAll('#obp23-staged .obp23-item').length");
      if (stagedBeforeHide >= 1) break;
      await sleep(200);
    }
    const backendBeforeHide = await rpc("listStagedAttachments", { agentId }).catch(() => []);
    await evalExpr("window.dispatchEvent(new Event('pagehide'))");
    const stagedIdsBeforeHide = new Set((backendBeforeHide ?? []).filter((item) => item?.state === "staged").map((item) => item.attachmentId));
    let closedHide = true;
    let backendAfterHide = backendBeforeHide;
    for (let i = 0; i < 40; i += 1) {
      closedHide = await evalExpr("Boolean(document.querySelector('.obp23-dialog'))");
      backendAfterHide = await rpc("listStagedAttachments", { agentId }).catch(() => backendBeforeHide);
      if (!closedHide && [...stagedIdsBeforeHide].every((id) => !backendAfterHide.some((item) => item.attachmentId === id && item.state === "staged"))) break;
      await sleep(100);
    }
    const discardedOnHide = stagedIdsBeforeHide.size > 0 && [...stagedIdsBeforeHide].every((id) => !backendAfterHide.some((item) => item.attachmentId === id && item.state === "staged"));
    step("pagehide closes the surface and discards uncommitted staging", stagedBeforeHide >= 1 && ! closedHide && discardedOnHide, JSON.stringify({ stagedBeforeHide, stagedIdsBeforeHide: [...stagedIdsBeforeHide], backendAfter: (backendAfterHide ?? []).length }));
    await shot("p23-transcript");
    });
    if (!steps.every((entry) => entry.pass)) throw new Error("P2.3 Electron assertions failed: " + JSON.stringify(steps.filter((entry) => !entry.pass)));
  } catch (error) {
    failure = error;
  } finally {
    try { ws?.close(); } catch {}
    cleanup.electronExited = await stopTree(child, electronExited);
    cleanup.backendExited = await stopTree(backend, backendExited);
    cleanup.gatewayPortReleased = gatewayPort ? await portIsReleased(gatewayPort, "gateway") : true;
    cleanup.cdpPortReleased = cdpPort ? await portIsReleased(cdpPort, "CDP") : true;
    if (runRoot) {
      for (let i = 0; i < 5 && existsSync(runRoot); i += 1) {
        try { rmSync(runRoot, { recursive: true, force: true }); } catch { await sleep(200); }
      }
      cleanup.runRootRemoved = !existsSync(runRoot);
    } else cleanup.runRootRemoved = true;
    const cleanupOk = Object.values(cleanup).every(Boolean);
    const evidence = {
      ok: failure === undefined && steps.every((entry) => entry.pass) && cleanupOk,
      steps,
      stages,
      seededCount,
      runtime: { gatewayRequestedPort: 0, gatewayPort, cdpRequestedPort: 0, cdpPort, electronExecutable: exe },
      cleanup,
      error: failure instanceof Error ? failure.message : failure === undefined ? null : String(failure),
      evidenceDir,
    };
    if (evidenceDir) {
      writeFileSync(join(evidenceDir, "p23-evidence.json"), JSON.stringify(evidence, null, 2));
      console.log("P23_EVIDENCE_DIR", evidenceDir);
      console.log("P23_EVIDENCE", JSON.stringify({ ok: evidence.ok, steps: evidence.steps.length, stages: evidence.stages.length, cleanup: evidence.cleanup }));
    }
    if (!cleanupOk && failure === undefined) failure = new Error("P2.3 cleanup evidence failed: " + JSON.stringify(cleanup));
  }
  if (failure !== undefined) throw failure;
  console.log("ELECTRON_P23_GATE GREEN");
}

main().catch((error) => { console.error(error); process.exit(1); });
