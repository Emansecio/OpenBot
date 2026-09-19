import { spawn,execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { runP22TasksFixture } from "./electron-p22-fixture.mjs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(process.env.OPENBOT_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const requireFromProject = createRequire(join(repoRoot, "package.json"));
const exe = process.env.ELECTRON_EXE || requireFromProject("electron");
const electronMain = process.env.OPENBOT_ELECTRON_MAIN || join(repoRoot, "scripts", "openbot-electron.cjs");
const settingsOnly = process.argv.includes("--settings-only");
const screenCloseOnly = process.argv.includes("--screen-close-only");
const emptyOnboardingOnly = process.argv.includes("--empty-onboarding-only");
const attachmentOnly = process.argv.includes("--attachment-only");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not allocate a free CDP port");
  return port;
}

async function waitCdp(cdpUrl, timeoutMs = 20000) {
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
    try {
      await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } catch {
      // The process may have exited between the check and taskkill.
    }
  } else if (!child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may have exited already.
    }
  }
  await Promise.race([exited, sleep(5000)]);
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let next = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
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
  let child;
  let exited = Promise.resolve();
  let gatewayChild;
  let gatewayExited = Promise.resolve();
  let evidenceDir;
  try {
    runRoot = mkdtempSync(join(tmpdir(), "openbot-visual-native-"));
    const userData = join(runRoot, "user-data");
    const appData = join(runRoot, "appdata");
    const localAppData = join(runRoot, "localappdata");
    const staging = join(runRoot, "staging");
    const dataRoot = join(runRoot, "data-root");
    const gatewayRoot = join(runRoot, "gateway");
    const readyFile = join(gatewayRoot, "ready.json");
    const statusFile = join(gatewayRoot, "status.json");
    mkdirSync(join(repoRoot, "logs"), { recursive: true });
    evidenceDir = mkdtempSync(join(repoRoot, "logs", "visual-ui-verify-"));
    for (const directory of [userData, appData, localAppData, staging, dataRoot, gatewayRoot]) {
      mkdirSync(directory, { recursive: true });
    }
    const gatewayToken = randomBytes(24).toString("base64");
    const gatewayArgs = [
      join(repoRoot, "test", "e2e-desktop", "fixture.mjs"),
      "--root", gatewayRoot,
      "--ready-file", readyFile,
      "--status-file", statusFile,
      "--port", "0",
    ];
    if (emptyOnboardingOnly) gatewayArgs.push("--empty-agent");
    if (process.argv.includes("--transitions-only")) gatewayArgs.push("--transition-history");
    if (process.argv.includes("--readability-only")) gatewayArgs.push("--readability-content");
    if (process.argv.includes("--execution-status-only")) gatewayArgs.push("--second-agent");
    if (process.argv.includes("--delete-timeout-only")) gatewayArgs.push("--delete-drain-delay");
    gatewayChild = spawn(process.execPath, gatewayArgs, {
      cwd: repoRoot,
      env: { ...process.env, E2E_GATEWAY_TOKEN: gatewayToken },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    gatewayExited = new Promise((resolve) => gatewayChild.once("close", resolve));
    gatewayChild.stdout.on("data", (d) => process.stdout.write(d));
    gatewayChild.stderr.on("data", (d) => process.stderr.write(d));
    let gatewayReady = null;
    const gatewayDeadline = Date.now() + 20000;
    while (Date.now() < gatewayDeadline) {
      if (gatewayChild.exitCode !== null) throw new Error(`visual gateway fixture exited before readiness (${gatewayChild.exitCode})`);
      try {
        gatewayReady = JSON.parse(readFileSync(readyFile, "utf8"));
        const health = await (await fetch(`http://127.0.0.1:${gatewayReady.port}/health`)).json();
        if (health?.ok === true && Number(health.pid) === gatewayChild.pid) break;
        gatewayReady = null;
      } catch {}
      await sleep(100);
    }
    if (!gatewayReady?.port) throw new Error("visual gateway fixture did not become ready");
    const waitGatewayStatus = async (predicate, timeoutMs = 12000) => {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        try {
          last = JSON.parse(readFileSync(statusFile, "utf8"));
          if (predicate(last)) return last;
        } catch {}
        await sleep(100);
      }
      throw new Error(`visual gateway status timed out: ${JSON.stringify(last)}`);
    };
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
        OPENBOT_ATTACHMENT_STAGING: staging,
        SAND_USER_DATA_DIR: userData,
        SAND_DATA_ROOT: dataRoot,
        SAND_HOST_GATEWAY_URL: `http://127.0.0.1:${gatewayReady.port}`,
        SAND_HOST_GATEWAY_TOKEN: gatewayToken,
        SAND_HOST_GATEWAY_NETWORK_TOKEN: gatewayToken,
        OPENBOT_LOCAL_GATEWAY: "1",
        OPENBOT_VISUAL_TEST: "1",
        E2E_GATEWAY_TOKEN: gatewayToken,
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
    await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    const evalExpr = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    const waitForEval = async (expression, timeoutMs = 4000, intervalMs = 25) => {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = await evalExpr(expression);
        if (last) return last;
        await sleep(intervalMs);
      }
      throw new Error(`visual condition timed out: ${expression}; last=${JSON.stringify(last)}`);
    };
    await waitForEval("document.readyState === 'complete' && typeof window.desktop === 'object' && Boolean(document.querySelector(\"script[src*='openbot-local-settings']\")) && Boolean(document.querySelector(\"script[src*='openbot-memory-ui']\"))", 10000);
    const info = await evalExpr(`({
      title: document.title,
      hasDesktop: typeof window.desktop === "object",
      hasSettingsScript: Boolean(document.querySelector("script[src*='openbot-local-settings']")),
      hasMemoryScript: Boolean(document.querySelector("script[src*='openbot-memory-ui']")),
      hasProviderPanel: Boolean(document.getElementById("openbot-provider-settings")),
    })`);
    console.log("INFO", JSON.stringify(info, null, 2));
    if (!info?.hasMemoryScript) throw new Error(`OpenBot memory/conversation asset is missing: ${JSON.stringify(info)}`);
    const shot = async (name) => {
      const img = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(evidenceDir, `${name}.png`), Buffer.from(img.data, "base64"));
    };
    if (process.argv.includes("--composer-voice-only")) {
      await waitForEval("Boolean(document.querySelector('.sand-prompt-send'))", 10000);
      const emptyComposer = await evalExpr(`(() => {
        const button = document.querySelector('.sand-prompt-send');
        const prompt = document.querySelector('[contenteditable="true"][aria-label="Prompt"], textarea[aria-label="Prompt"]');
        const style = getComputedStyle(button);
        return { label: button.getAttribute('aria-label'), text: (prompt?.value || prompt?.textContent || '').trim(), visibility: style.visibility, pointerEvents: style.pointerEvents };
      })()`);
      if (emptyComposer.text || emptyComposer.label !== "Start voice input" || emptyComposer.visibility !== "hidden" || emptyComposer.pointerEvents !== "none") {
        throw new Error(`empty composer exposes legacy control: ${JSON.stringify(emptyComposer)}`);
      }
      console.log("EMPTY_COMPOSER_GREEN", JSON.stringify(emptyComposer));
      const result = await evalExpr(`(() => {
        const host = document.createElement("div");
        host.className = "sand-prompt-shell";
        host.style.cssText = "position:fixed;left:40px;top:40px;width:240px;height:60px;z-index:2147483001;background:#181818";
        const button = document.createElement("button");
        button.className = "sand-prompt-send";
        button.style.cssText = "width:32px;height:32px";
        host.append(button); document.body.append(host);
        let clicks = 0;
        button.addEventListener("click", () => clicks++);
        const states = [];
        try {
          for (const label of ["Start voice input", "Stop dictation", "Send message"]) {
            button.setAttribute("aria-label", label);
            const style = getComputedStyle(button);
            states.push({ label, visibility: style.visibility, pointerEvents: style.pointerEvents, width: button.getBoundingClientRect().width });
            if (label !== "Send message") button.click();
          }
          return { states, voiceClicks: clicks };
        } finally { host.remove(); }
      })()`);
      if (result.voiceClicks !== 0 || result.states.slice(0, 2).some((state) => state.visibility !== "hidden" || state.pointerEvents !== "none" || state.width <= 0 || state.width !== result.states[2].width)
        || result.states[2].visibility !== "visible" || result.states[2].pointerEvents === "none") {
        throw new Error(`composer voice regression: ${JSON.stringify(result)}`);
      }
      console.log("COMPOSER_VOICE_GREEN", JSON.stringify(result));
      return;
    }
    if (process.argv.includes("--auto-review-only")) {
      const result = await evalExpr(`(() => {
        const surface = document.createElement('div');
        surface.setAttribute('role', 'dialog'); surface.setAttribute('aria-label', 'OpenBot settings');
        surface.innerHTML = '<section><div id="review-fixture"><div><span>Auto-review</span><p>OpenBot checks each action before it runs and asks you first when needed. Add rules to customize what it can do automatically.</p></div><button role="switch" aria-label="Auto-review">On</button></div><div id="rules-fixture"><div><h3>Auto-review Rules</h3><p>Instructions</p></div><input aria-label="Rule"><button>Add Rule</button></div><div id="timezone-fixture">Timezone<select><option>Auto</option></select></div></section>';
        document.body.append(surface);
        try {
          window.__openbotLocalSettingsScan();
          const visible = id => getComputedStyle(surface.querySelector('#' + id)).display !== 'none';
          return { reviewVisible: visible('review-fixture'), rulesVisible: visible('rules-fixture'), timezoneVisible: visible('timezone-fixture') };
        } finally { surface.remove(); }
      })()`);
      if (result.reviewVisible || result.rulesVisible || !result.timezoneVisible) throw new Error('auto-review visibility regression: ' + JSON.stringify(result));
      console.log('AUTO_REVIEW_GREEN', JSON.stringify(result));
      return;
    }
    if (process.argv.includes("--threads-only")) {
      const result = await evalExpr(`(async () => {
        const results = [];
        for (const name of ['More message actions', 'Message actions']) {
          const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', name);
          menu.innerHTML = '<button role="menuitem"><span data-icon-name="chat-bubbles"></span>Start a thread</button><button role="menuitem">Reply</button><button role="menuitem">Copy</button>';
          let activated = false; menu.firstChild.addEventListener('click', () => activated = true);
          document.body.append(menu);
          try {
            const immediate = getComputedStyle(menu.firstChild).display;
            menu.firstChild.click();
            await new Promise(requestAnimationFrame);
            results.push({name, immediate, activated, replyVisible: menu.children[1].getClientRects().length > 0, copyVisible: menu.children[2].getClientRects().length > 0});
          } finally { menu.remove(); }
        }
        return results;
      })()`);
      if (result.some(item => item.immediate !== 'none' || item.activated || !item.replyVisible || !item.copyVisible)) throw new Error('Thread removal regression: ' + JSON.stringify(result));
      console.log('THREADS_DISABLED_GREEN', JSON.stringify(result));
      return;
    }
    if (process.argv.includes("--sidebar-alignment-only")) {
      await waitForEval("Boolean(document.querySelector('.sand-sidebar-resize-handle'))", 10000);
      const measure = () => evalExpr(`(() => {
        const sidebar = document.querySelector('.sand-agents-sidebar');
        const rect = el => { const r = el.getBoundingClientRect(); return { x:r.x, width:r.width, center:r.x+r.width/2 }; };
        const footer = [...sidebar.querySelectorAll('.sand-agents-sidebar__new')].find(el => el.getClientRects().length);
        return { sidebar:rect(sidebar), footer:rect(footer), rows:[...sidebar.querySelectorAll('.sand-agent-item')].filter(el => el.getClientRects().length).map(el => ({layout:el.dataset.layout,row:rect(el),avatar:rect(el.querySelector('.sand-agent-item__avatar'))})) };
      })()`);
      const drag = async (x) => {
        const handle = await evalExpr("(() => {const r=document.querySelector('.sand-sidebar-resize-handle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
        await send('Input.dispatchMouseEvent', {type:'mouseMoved', ...handle});
        await send('Input.dispatchMouseEvent', {type:'mousePressed', ...handle, button:'left', clickCount:1});
        await send('Input.dispatchMouseEvent', {type:'mouseMoved', x, y:handle.y, button:'left', buttons:1});
        await send('Input.dispatchMouseEvent', {type:'mouseReleased', x, y:handle.y, button:'left', clickCount:1});
        await sleep(900);
      };
      const before = await measure();
      await drag(70);
      const collapsed = await measure();
      if (!collapsed.rows.length || collapsed.rows.some(item => item.layout !== 'collapsed' || Math.abs(item.avatar.center-collapsed.footer.center)>1 || Math.abs(item.row.center-collapsed.footer.center)>1)) throw new Error('Collapsed sidebar misaligned: '+JSON.stringify(collapsed));
      await shot('sidebar-collapsed-centered');
      await drag(before.sidebar.width);
      const expanded = await measure();
      if (expanded.rows.length !== before.rows.length || expanded.rows.some((item,index) => item.layout !== 'expanded' || Math.abs(item.avatar.center-before.rows[index].avatar.center)>1 || Math.abs(item.row.width-before.rows[index].row.width)>1)) throw new Error('Expanded sidebar changed: '+JSON.stringify({before,expanded}));
      console.log('SIDEBAR_ALIGNMENT_GREEN', JSON.stringify({before,collapsed,expanded}));
      return;
    }
    if (process.argv.includes("--cancel-collapsed-only")) {
      await waitForEval("Boolean(document.querySelector('.sand-agent-item[data-agent-id]'))", 10000);
      const handle = await evalExpr("(() => {const r=document.querySelector('.sand-sidebar-resize-handle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
      await send('Input.dispatchMouseEvent', {type:'mousePressed', ...handle, button:'left', clickCount:1});
      await send('Input.dispatchMouseEvent', {type:'mouseMoved', x:70, y:handle.y, button:'left', buttons:1});
      await send('Input.dispatchMouseEvent', {type:'mouseReleased', x:70, y:handle.y, button:'left', clickCount:1});
      await waitForEval("Boolean(document.querySelector('.sand-agent-item[data-layout=collapsed]'))");
      await evalExpr("document.querySelector('[contenteditable=true][aria-label=Prompt],textarea[aria-label=Prompt]').focus()");
      await send('Input.insertText', {text:'Teste'});
      await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
      await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
      await waitForEval("(() => {const b=document.getElementById('openbot-stop-turn');return b&&!b.hidden&&!b.disabled&&b.dataset.openbotActiveAgent==='openbot-default';})()", 12000);
      await waitGatewayStatus(status => status.cancelReady === true && status.activeStreams > 0);
      await evalExpr("document.getElementById('openbot-stop-turn').click()");
      await waitGatewayStatus(status => status.abortObserved === true && status.activeStreams === 0);
      await waitForEval("document.getElementById('openbot-stop-turn').hidden", 10000);
      console.log('CANCEL_COLLAPSED_GREEN');
      return;
    }
    if (process.argv.includes("--prompt-queue-only")) {
      await waitForEval("Boolean(document.querySelector('[contenteditable=true][aria-label=Prompt]'))", 10000);
      const typeAndSend = async (text) => {
        await evalExpr("document.querySelector('[contenteditable=true][aria-label=Prompt]').focus()");
        await send('Input.insertText', {text});
        await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
        await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
      };
      await typeAndSend('Teste');
      try { await waitGatewayStatus(status => status.cancelReady === true && status.activeStreams > 0); }
      catch (error) {
        console.log('QUEUE_START_DIAGNOSTIC', JSON.stringify(await evalExpr(`(async () => ({
          state:await window.desktop.agent.getPromptStatus({agentIds:['openbot-default']}),
          notices:[...document.querySelectorAll('.sand-notice,[role=alert],.sand-failed-send-actions')].map(node=>node.textContent).slice(-5),
          composer:document.querySelector('[aria-label=Prompt]')?.textContent,
          rows:[...document.querySelectorAll('.sand-transcript-row')].map(row=>({role:row.getAttribute('data-role'),text:row.innerText.slice(0,500)})).slice(-4)
        }))()`)));
        await shot('queue-start-failure');
        throw error;
      }
      await waitForEval("!document.getElementById('openbot-stop-turn')?.hidden", 10000);
      await evalExpr("document.querySelector('[contenteditable=true][aria-label=Prompt]').focus()");
      await send('Input.insertText', {text:'second queued fixture'});
      const geometry = await evalExpr(`(() => {
        const stop=document.getElementById('openbot-stop-turn').getBoundingClientRect();
        const send=document.querySelector('.sand-prompt-send[aria-label="Send message"]').getBoundingClientRect();
        return {stopRight:stop.right,sendLeft:send.left};
      })()`);
      if (geometry.stopRight > geometry.sendLeft) throw new Error('Stop overlaps send: '+JSON.stringify(geometry));
      const sendPoint = await evalExpr("(() => {const r=document.querySelector('.sand-prompt-send[aria-label=\"Send message\"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
      await send('Input.dispatchMouseEvent', {type:'mousePressed',...sendPoint,button:'left',clickCount:1});
      await send('Input.dispatchMouseEvent', {type:'mouseReleased',...sendPoint,button:'left',clickCount:1});
      await waitForEval("document.getElementById('openbot-prompt-queue')?.textContent.includes('second queued fixture')", 10000);
      await waitGatewayStatus(status => status.abortObserved === false && status.activeStreams > 0);
      await shot('prompt-queue-controls');
      await evalExpr("document.querySelector('#openbot-prompt-queue button').click()");
      await waitForEval("!document.querySelector('#openbot-prompt-queue .ob-queued-row')", 10000);
      await waitGatewayStatus(status => status.abortObserved === false && status.activeStreams > 0);
      await evalExpr(`(async () => {
        const api = window.desktop.agent;
        const cfg = await api.getProviderConfig();
        const conversation = await api.getActiveConversation({agentId: cfg.agentId});
        window.__queueRecoveryFixture = {agentId: cfg.agentId, conversationId: conversation.id, clientNonce: 'queue-recovery-e2e'};
        return window.desktop.p23.sendPrompt(cfg.agentId, 'desktop e2e instant response recovered draft', {
          ...window.__queueRecoveryFixture, attachments: [{name:'missing-queue-fixture.txt',path:'missing-queue-fixture.txt'}]
        });
      })()`);
      await waitForEval("document.getElementById('openbot-prompt-queue')?.textContent.includes('recovered draft')", 10000);
      const queueOrigin = await evalExpr("document.querySelector('#openbot-prompt-queue .ob-queued-origin')?.textContent");
      if (!queueOrigin) throw new Error('Queue conversation label is missing');
      await evalExpr("document.getElementById('openbot-stop-turn').click()");
      await waitGatewayStatus(status => status.abortObserved === true && status.activeStreams === 0);
      await waitForEval("[...document.querySelectorAll('#openbot-prompt-queue button')].some(button => button.textContent === 'Revisar')", 10000);
      await evalExpr("[...document.querySelectorAll('#openbot-prompt-queue button')].find(button => button.textContent === 'Revisar').click()");
      await waitForEval("document.getElementById('openbot-queue-recovery')?.open", 10000);
      const recovery = await evalExpr(`(() => {
        const dialog=document.getElementById('openbot-queue-recovery'); const r=dialog.getBoundingClientRect();
        return {text:dialog.querySelector('textarea').value, focused:document.activeElement===dialog.querySelector('textarea'),
          labelled:dialog.getAttribute('aria-labelledby'), attachments:dialog.querySelectorAll('.ob-recovery-file').length,
          fits:r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight};
      })()`);
      if (!recovery.text.includes('recovered draft') || !recovery.focused || !recovery.labelled || recovery.attachments!==1 || !recovery.fits)
        throw new Error('Recovery editor contract: '+JSON.stringify(recovery));
      await shot('queue-recovery-editor');
      await evalExpr(`(() => {
        const dialog=document.getElementById('openbot-queue-recovery'); dialog.querySelector('.ob-recovery-file button').click();
        const editor=dialog.querySelector('textarea'); editor.value='desktop e2e instant response revised draft'; editor.dispatchEvent(new Event('input',{bubbles:true}));
        const input=dialog.querySelector('input[type=file]'); const data=new DataTransfer();
        data.items.add(new File(['replacement fixture'], 'replacement.txt', {type:'text/plain'}));
        input.files=data.files; input.dispatchEvent(new Event('change',{bubbles:true}));
      })()`);
      await waitForEval("document.querySelector('#openbot-queue-recovery .ob-recovery-files')?.textContent.includes('replacement.txt') && document.getElementById('openbot-queue-recovery')?.getAttribute('aria-busy')==='false'",10000);
      await evalExpr("document.querySelector('#openbot-queue-recovery [data-recovery=send]').click()");
      await waitForEval("!document.getElementById('openbot-queue-recovery')",10000);
      await waitGatewayStatus(status => status.instantResponses === 1);
      await waitForEval("!document.querySelector('#openbot-prompt-queue .ob-queued-row')",10000);
      const finalStatus = await evalExpr("window.desktop.agent.getPromptStatus({agentIds:[window.__queueRecoveryFixture.agentId]})");
      if (finalStatus.isBusy || finalStatus.agents?.length !== 1 || finalStatus.agents[0].recoverable?.length !== 0)
        throw new Error('Recovery did not settle: '+JSON.stringify(finalStatus));
      console.log('PROMPT_QUEUE_UI_GREEN', JSON.stringify({geometry,recovery,queueOrigin,exactlyOneRevisedResponse:true}));
      return;
    }
    if (process.argv.includes("--delete-timeout-only")) {
      await waitForEval("Boolean(document.querySelector('.sand-agent-item[data-agent-id=delete-timeout-fixture]'))", 10000);
      const point = await evalExpr("(() => {const r=document.querySelector('.sand-agent-item[data-agent-id=delete-timeout-fixture]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
      await send('Input.dispatchMouseEvent', {type:'mousePressed', ...point, button:'right', clickCount:1});
      await send('Input.dispatchMouseEvent', {type:'mouseReleased', ...point, button:'right', clickCount:1});
      await waitForEval("[...document.querySelectorAll('[role=menuitem]')].some(el => /^(Delete|Excluir)$/.test(el.textContent.trim()))");
      await sleep(400);
      const deletePoint = await evalExpr("(() => {const el=[...document.querySelectorAll('[role=menuitem]')].find(el => /^(Delete|Excluir)$/.test(el.textContent.trim()));const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
      await send('Input.dispatchMouseEvent', {type:'mouseMoved', ...deletePoint});
      await send('Input.dispatchMouseEvent', {type:'mousePressed', ...deletePoint, button:'left', clickCount:1});
      await send('Input.dispatchMouseEvent', {type:'mouseReleased', ...deletePoint, button:'left', clickCount:1});
      await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
      await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
      await waitForEval("Boolean(document.querySelector('[role=alertdialog]'))");
      await evalExpr("[...document.querySelector('[role=alertdialog]').querySelectorAll('button')].find(el => /^(Delete|Excluir)$/.test(el.textContent.trim())).click()");
      await waitForEval("(() => {window.__openbotLocalSettingsScan();const d=document.querySelector('[role=alertdialog]');return d?.textContent.includes('Não foi possível concluir a exclusão')&&[...d.querySelectorAll('button')].some(b=>/^(Cancel|Cancelar)$/.test(b.textContent.trim())&&!b.disabled);})()", 12000);
      await evalExpr("[...document.querySelector('[role=alertdialog]').querySelectorAll('button')].find(el => /^(Cancel|Cancelar)$/.test(el.textContent.trim())).click()");
      await waitForEval("!document.querySelector('[role=alertdialog]')");
      if (!await evalExpr("Boolean(document.querySelector('.sand-agent-item[data-agent-id=delete-timeout-fixture]'))")) throw new Error('Timed-out deletion removed fixture bot');
      console.log('DELETE_TIMEOUT_UI_GREEN');
      return;
    }
    if (process.argv.includes("--execution-status-only")) {
      // Ferramentas habilitadas e resposta pausada: o texto da rodada fica retido,
      // mas a etapa real do provedor precisa continuar visível.
      await send("Emulation.setDeviceMetricsOverride", { width: 704, height: 768, deviceScaleFactor: 1, mobile: false });
      await waitForEval("Boolean(document.querySelector('[contenteditable=true][aria-label=Prompt]'))", 10000);
      let delivered = false;
      for (let attempt = 0; attempt < 3 && !delivered; attempt += 1) {
        await evalExpr(`(() => { const composer = document.querySelector('[contenteditable=true][aria-label=Prompt]'); composer.focus(); composer.click(); return document.activeElement === composer; })()`);
        await send("Input.insertText", { text: "Teste" });
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        try {
          await waitForEval("document.querySelectorAll('.sand-transcript-row').length > 0", 4000);
          delivered = true;
        }
        catch { await sleep(300); }
      }
      if (!delivered) throw new Error("composer did not deliver the prompt");
      await waitGatewayStatus((status) => status.cancelReady === true && status.activeStreams > 0);
      await sleep(400);
      const execution = await evalExpr(`(() => {
        const row = document.querySelector('[data-row-key="sand-typing-indicator"]');
        const detail = document.querySelector('[data-openbot-activity-detail]');
        const local = document.getElementById('openbot-turn-status');
        return {
          activityVisible: Boolean(row && getComputedStyle(row).display !== 'none' && row.getBoundingClientRect().height > 0),
          detail: detail ? detail.textContent : null,
          localStatus: local && !local.hidden ? local.textContent : '',
          transcriptText: /E2E incremental stream/.test(document.querySelector('main.sand-chat')?.innerText || ''),
          rows: document.querySelectorAll('.sand-transcript-row').length,
        };
      })()`);
      console.log("EXECUTION_STATUS_DETAIL", JSON.stringify(execution));
      if (!execution.activityVisible) throw new Error("native activity indicator is missing during the paused stream");
      if (!/Recebendo resposta|Executando ferramenta/.test(String(execution.detail || ""))) throw new Error(`step is not integrated into the native activity surface: ${JSON.stringify(execution.detail)}`);
      if (!/atividade: |sem atualização há /.test(String(execution.detail || ""))) throw new Error(`real activity age is missing: ${JSON.stringify(execution.detail)}`);
      if (execution.transcriptText) throw new Error("this fixture must keep the round text retained while the provider is paused");
      if (execution.localStatus !== "") throw new Error("the local status line must not duplicate the native activity surface");
      // Reconexão do canal e troca de bot: somente leituras, nenhum reenvio.
      const before = JSON.parse(readFileSync(statusFile, "utf8"));
      const switched = await evalExpr(`(() => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        const row = document.querySelector('.sand-agent-item[data-agent-id="status-switch-fixture"]');
        if (!row) return false;
        const rect = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
        return true;
      })()`);
      if (!switched) throw new Error("second bot was not available for the switch check");
      await sleep(1500);
      const after = JSON.parse(readFileSync(statusFile, "utf8"));
      const switchedState = await evalExpr(`(() => {
        const detail = document.querySelector('[data-openbot-activity-detail]');
        const local = document.getElementById('openbot-turn-status');
        return { detail: detail ? detail.textContent : null, localStatus: local && !local.hidden ? local.textContent : '',
          rows: document.querySelectorAll('.sand-transcript-row').length,
          activeAgent: document.querySelector('.sand-agent-item[aria-current="page"]')?.getAttribute('data-agent-id') || null };
      })()`);
      console.log("EXECUTION_STATUS_NO_RESEND", JSON.stringify({
        switched: switchedState.activeAgent, chunksEmitted: [before.chunksEmitted, after.chunksEmitted],
        completedStreams: [before.completedStreams, after.completedStreams], activeStreams: after.activeStreams,
        rows: [execution.rows, switchedState.rows], detailAfterSwitch: switchedState.detail, localStatusAfterSwitch: switchedState.localStatus,
      }));
      if (after.chunksEmitted !== before.chunksEmitted || after.completedStreams !== before.completedStreams) throw new Error("reconnect or bot switch started another request");
      if (switchedState.detail !== null || switchedState.localStatus !== "") throw new Error("execution state leaked into another bot");
      console.log("EXECUTION_STATUS_UI_GREEN");
      ws.close();
      return;
    }
    if (process.argv.includes("--readability-only")) {
      await send("Emulation.setDeviceMetricsOverride", { width: 704, height: 768, deviceScaleFactor: 1, mobile: false });
      // A falha de fixture interrompeu um turno que já executou uma ferramenta:
      // repetir poderia duplicar efeitos, então o backend oferece apenas conferir
      // os resultados. Nenhum botão de nova tentativa pode existir aqui.
      await waitForEval("Boolean(document.querySelector('.ob-recovery-inspect'))", 10000);
      await sleep(400);
      const unsafeAction = await evalExpr(`(() => ({
        retryButtons: document.querySelectorAll('.ob-retry-generation').length,
        confirmControl: document.querySelector('.ob-recovery-inspect')?.textContent || null,
      }))()`);
      console.log("READABILITY_INSPECT_ONLY", JSON.stringify(unsafeAction));
      if (unsafeAction.retryButtons !== 0) throw new Error(`Unsafe retry was offered for uncertain effects: ${JSON.stringify(unsafeAction)}`);
      if (!String(unsafeAction.confirmControl || "").includes("Conferir resultados")) throw new Error(`Inspect control is missing: ${JSON.stringify(unsafeAction)}`);
      const toolFeedback = await evalExpr(`([...document.querySelectorAll("main.sand-chat .sand-transcript-row")]
        .filter((row) => /Leitura de relatório \(fixture\)|read-file/.test(row.textContent || ""))
        .map((row) => row.textContent?.trim() || ""))`);
      console.log("TOOL_FEEDBACK_HIDDEN", JSON.stringify({ visibleRows: toolFeedback }));
      if (toolFeedback.length > 0) throw new Error(`Tool lifecycle feedback leaked into the visible transcript: ${JSON.stringify(toolFeedback)}`);
      const settledCopy = await evalExpr(`(() => {
        const rows = [...document.querySelectorAll("main.sand-chat .sand-transcript-row")];
        const inspect = (marker) => {
          const row = rows.find((candidate) => (candidate.textContent || "").includes(marker));
          const rect = row?.getBoundingClientRect();
          const visible = Boolean(row && getComputedStyle(row).display !== "none" && rect && rect.width > 0 && rect.height > 0);
          return { visible, role: row?.getAttribute("data-role") || null, display: row ? getComputedStyle(row).display : null, text: row?.textContent?.trim() || null };
        };
        const liveIndicators = [...document.querySelectorAll('[data-row-key="sand-typing-indicator"]')]
          .filter((row) => getComputedStyle(row).display !== "none" && row.getBoundingClientRect().height > 0).length;
        return {
          completed: inspect("Concluído · relatório final disponível."),
          failed: inspect("Falhou · integração indisponível; confira o erro acima."),
          liveIndicators,
        };
      })()`);
      console.log("SETTLED_COPY_VISIBLE", JSON.stringify(settledCopy));
      if (!settledCopy.completed.visible || !settledCopy.failed.visible || settledCopy.liveIndicators !== 0) {
        throw new Error(`settled assistant copy was hidden or stale activity remained: ${JSON.stringify(settledCopy)}`);
      }
      const before = await evalExpr(`(() => {
        const control = document.querySelector('.ob-recovery-inspect');
        const notice = control.previousElementSibling;
        const text = document.createTreeWalker(notice, NodeFilter.SHOW_TEXT).nextNode();
        const element = text?.parentElement || notice;
        const style = getComputedStyle(element);
        const ancestors = []; for(let p=element;p;p=p.parentElement) { const s=getComputedStyle(p); ancestors.push({tag:p.tagName,cls:p.className,color:s.color,background:s.backgroundColor,opacity:s.opacity}); }
        const rect = control.getBoundingClientRect();
        return {color:style.color,fontSize:style.fontSize,ancestors,control:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
          rows:document.querySelectorAll('.sand-transcript-row').length,
          userRows:document.querySelectorAll('.sand-transcript-row[data-role="user"], .sand-transcript-row[data-openbot-side="user"]').length};
      })()`);
      const rgba = text => (text.match(/[\d.]+/g) || []).map(Number);
      const background = rgba(before.ancestors.find(entry => rgba(entry.background)[3] !== 0)?.background || "rgb(7, 7, 7)");
      const foreground = rgba(before.color);
      const alpha = foreground[3] ?? 1;
      const composite = foreground.slice(0, 3).map((value, index) => value * alpha + background[index] * (1 - alpha));
      const luminance = rgb => rgb.slice(0, 3).map(value => value / 255).reduce((sum, value, index) => sum + [0.2126, 0.7152, 0.0722][index] * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4), 0);
      const contrast = (luminance(composite) + 0.05) / (luminance(background) + 0.05);
      console.log("READABILITY_NOTICE", JSON.stringify({ color: before.color, background, fontSize: before.fontSize, contrast, control: before.control }));
      if (before.ancestors.some(entry => Number(entry.opacity) !== 1)) throw new Error("Notice contrast must be measured after its animation");
      if (!Number.isFinite(contrast) || contrast < 4.5 || Math.abs(before.control.height - 30) > 1) throw new Error("Notice contrast or inspect control geometry is inadequate");
      await shot("visual-readability-inspect");
      // "Conferir resultados" abre o histórico relevante e nunca reenvia o pedido.
      await evalExpr("document.querySelector('.ob-recovery-inspect').focus()");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await waitForEval("Boolean(document.querySelector('.ob-recovery-note'))", 10000);
      await sleep(300);
      const revealed = await evalExpr(`(() => {
        const note = document.querySelector('.ob-recovery-note');
        const row = document.querySelector('.ob-recovery-inspect').previousElementSibling;
        const rect = note.getBoundingClientRect(), parent = row.getBoundingClientRect();
        const viewport = document.querySelector('.sand-virtual-transcript');
        const chain = []; for(let p=note;p;p=p.parentElement) { const s=getComputedStyle(p); chain.push({cls:p.className,width:p.getBoundingClientRect().width,maxWidth:s.maxWidth,minWidth:s.minWidth,whiteSpace:s.whiteSpace,display:s.display,flex:s.flex}); if(p===row) break; }
        return {text:note.textContent,chain,note:{left:rect.left,right:rect.right,width:rect.width,height:rect.height},
          row:{left:parent.left,right:parent.right,width:parent.width},viewport:{width:viewport.clientWidth,scrollWidth:viewport.scrollWidth},windowWidth:innerWidth,
          highlighted:document.querySelectorAll('[data-openbot-recovery-highlight="1"]').length,
          rows:document.querySelectorAll('.sand-transcript-row').length,
          userRows:document.querySelectorAll('.sand-transcript-row[data-role="user"], .sand-transcript-row[data-openbot-side="user"]').length,
          composerFocused:document.activeElement === document.querySelector('main.sand-chat [contenteditable="true"], main.sand-chat textarea')};
      })()`);
      console.log("READABILITY_REVEALED_CONTEXT", JSON.stringify({ ...revealed, before: { rows: before.rows, userRows: before.userRows } }));
      await shot("visual-readability-revealed-context");
      if (!String(revealed.text || "").includes("Confira os resultados e possíveis efeitos")) throw new Error(`Revealed guidance is missing: ${JSON.stringify(revealed.text)}`);
      if (revealed.highlighted < 1) throw new Error("The relevant history was not highlighted");
      if (revealed.rows !== before.rows || revealed.userRows !== before.userRows) throw new Error("Conferir resultados changed the conversation instead of only opening it");
      if (!revealed.composerFocused) throw new Error("Conferir resultados must leave the composer ready for a new instruction");
      // O histórico é localizado pela identidade do turno informada pelo backend,
      // nunca pela posição das linhas visíveis.
      const identity = await evalExpr(`(async () => {
        const api = window.desktop.agent;
        const cfg = await api.getProviderConfig();
        const conversation = await api.getActiveConversation({ agentId: cfg.agentId });
        const recovery = await api.getPromptRecovery({ agentId: cfg.agentId, conversationId: conversation.id });
        const wanted = Array.isArray(recovery?.failure?.historyEntryIds) ? recovery.failure.historyEntryIds : [];
        const highlighted = [...document.querySelectorAll('[data-openbot-recovery-highlight="1"]')]
          .map((row) => row.getAttribute('data-entry-id') || row.getAttribute('data-row-key') || '');
        return { turnId: recovery?.failure?.turnId || null, wanted, highlighted,
          foreign: highlighted.filter((key) => !wanted.includes(key)),
          earlierTurn: highlighted.filter((key) => key.includes('visual-readability-earlier')) };
      })()`);
      console.log("READABILITY_IDENTITY_HIGHLIGHT", JSON.stringify(identity));
      if (typeof identity.turnId !== "string" || identity.wanted.length === 0) throw new Error(`backend did not report the turn history identity: ${JSON.stringify(identity)}`);
      if (identity.highlighted.length === 0) throw new Error("no transcript row was highlighted by identity");
      if (identity.foreign.length > 0) throw new Error(`highlighted rows outside the failed turn: ${JSON.stringify(identity.foreign)}`);
      if (identity.earlierTurn.length > 0) throw new Error(`an earlier turn was highlighted: ${JSON.stringify(identity.earlierTurn)}`);
      if (!identity.wanted.some((key) => identity.highlighted.includes(key))) throw new Error(`highlight did not match the reported identities: ${JSON.stringify(identity)}`);
      if (revealed.note.left < revealed.row.left - 1 || revealed.note.right > revealed.row.right + 1 || revealed.note.right > revealed.windowWidth) throw new Error("Long guidance escapes its transcript row");
      if (!(revealed.note.width <= revealed.row.width + 1)) throw new Error(`Long guidance is wider than its row: ${JSON.stringify({ note: revealed.note, row: revealed.row })}`);
      await waitGatewayStatus(status => status.activeStreams === 0 && status.completedStreams === 0);
      const stability = await evalExpr(`new Promise(resolve => {
        const control = document.querySelector('.ob-recovery-inspect'), samples = [];
        const capture = () => { const r = control.getBoundingClientRect(); samples.push({x:r.x,y:r.y,width:r.width,height:r.height});
          if(samples.length < 8) setTimeout(capture,40); else resolve({samples,focused:document.activeElement===document.querySelector('main.sand-chat [contenteditable="true"], main.sand-chat textarea')}); };
        capture();
      })`);
      console.log("READABILITY_STABILITY", JSON.stringify(stability));
      if (!stability.focused || stability.samples.some(rect => Object.keys(rect).some(key => Math.abs(rect[key] - stability.samples[0][key]) > 0.5))) throw new Error("Inspect control moved or lost the composer focus after settling");
      await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1.25, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await sleep(300);
      const resized = await evalExpr(`(() => { const control=document.querySelector('.ob-recovery-inspect'),r=control.getBoundingClientRect(),p=control.previousElementSibling.getBoundingClientRect();return {width:innerWidth,dpr:devicePixelRatio,contained:r.left>=p.left-1&&r.right<=p.right+1,height:r.height,transition:getComputedStyle(control).transitionDuration}; })()`);
      console.log("READABILITY_RESIZED", JSON.stringify({ ...resized, stableSamples: stability.samples.length }));
      if (resized.width !== 1024 || resized.dpr !== 1.25 || !resized.contained || !(resized.height > 0) || resized.transition !== "0s") throw new Error("Resized/reduced-motion inspect feedback regressed");
      await shot("visual-readability-wide-reduced");
      const codeOverflow = await evalExpr(`(() => {
        const walker=document.createTreeWalker(document.querySelector('main.sand-chat'),NodeFilter.SHOW_TEXT);let node;
        while(node=walker.nextNode()) if(node.textContent.includes('relatorio_operacional_')) break;
        const result=[];for(let p=node?.parentElement;p&&result.length<8;p=p.parentElement) result.push({tag:p.tagName,cls:p.className,width:p.clientWidth,scrollWidth:p.scrollWidth,overflow:getComputedStyle(p).overflowX});
        return result;
      })()`);
      console.log("READABILITY_CODE_LAYOUT", JSON.stringify(codeOverflow));
      console.log("READABILITY GREEN");
      console.log("VISUAL_EVIDENCE_DIR", evidenceDir);
      ws.close();
      return;
    }
    if (process.argv.includes("--profile-feedback-only")) {
      await waitForEval("Boolean(document.querySelector('.sand-agents-sidebar__account-name'))");
      await evalExpr(`(async () => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
        const context = canvas.getContext('2d'); context.fillStyle = '#7c3aed'; context.fillRect(0, 0, 256, 256);
        window.__profileFeedbackSeed = await window.desktop.agent.updateLocalProfile({ name: 'Perfil anterior', avatarShape: 'rounded', avatarColor: '#7c3aed', avatarPngBase64: canvas.toDataURL('image/png').split(',')[1] });
        window.__profileFeedbackReads = [];
        window.__openbotLocalProfileAgent = {
          getLocalProfile: () => new Promise(resolve => window.__profileFeedbackReads.push(() => resolve(window.__profileFeedbackSeed))),
          updateLocalProfile: patch => window.desktop.agent.updateLocalProfile(patch),
        };
        const fixture = document.createElement('section'); fixture.id = 'profile-feedback-fixture';
        fixture.style.cssText = 'position:fixed;inset:40px;z-index:2147483000;background:#181818;padding:24px';
        fixture.innerHTML = '<div><span>local@openbot.invalid</span><button>Sign out</button></div>';
        document.body.appendChild(fixture); window.__openbotLocalSettingsScan();
        await new Promise(resolve => setTimeout(resolve, 250));
        const input = document.getElementById('openbot-profile-name');
        input.focus(); input.value = 'Nome recente'; input.dispatchEvent(new Event('input'));
        window.__profileFeedbackReads.forEach(release => release());
      })()`);
      await sleep(100);
      const loaded = await evalExpr(`({ name: document.getElementById('openbot-profile-name')?.value, photo: Boolean(document.querySelector('#openbot-profile-avatar img')), shape: document.getElementById('openbot-profile-avatar')?.dataset.shape, focused: document.activeElement?.id === 'openbot-profile-name' })`);
      console.log('PROFILE_DELAYED_READ', JSON.stringify(loaded));
      if (loaded.name !== 'Nome recente' || !loaded.photo || loaded.shape !== 'rounded' || !loaded.focused) throw new Error('Delayed profile read lost untouched persisted appearance or current input');
      await evalExpr("document.getElementById('openbot-profile-form').requestSubmit()");
      await waitForEval("document.getElementById('openbot-profile-status')?.textContent.includes('Perfil salvo')");
      if (!await evalExpr("window.desktop.agent.getLocalProfile().then(p => p.name === 'Nome recente' && p.avatarPngBase64 === window.__profileFeedbackSeed.avatarPngBase64 && p.avatarShape === 'rounded')")) throw new Error('Name save overwrote untouched photo/shape');
      const closed = await evalExpr(`(async () => {
        window.__openbotLocalProfileAgent.updateLocalProfile = async patch => {
          const saved = await window.desktop.agent.updateLocalProfile(patch);
          return new Promise(resolve => { window.__releaseClosedProfile = () => resolve(saved); });
        };
        const input = document.getElementById('openbot-profile-name'); input.value = 'Nome fechado'; input.dispatchEvent(new Event('input'));
        document.getElementById('openbot-profile-form').requestSubmit();
        return true;
      })()`);
      if (!closed) throw new Error('Profile submission did not start');
      await waitForEval("typeof window.__releaseClosedProfile === 'function'");
      await evalExpr("document.getElementById('profile-feedback-fixture').remove(); window.__releaseClosedProfile(); delete window.__openbotLocalProfileAgent;");
      await sleep(100);
      if (!await evalExpr("document.querySelector('.sand-agents-sidebar__account-name')?.textContent.includes('Nome fechado')")) throw new Error('Confirmed save after closing settings left cached profile stale');
      await sleep(300);
      const mutations = await evalExpr(`new Promise(resolve => {
        const avatar = document.querySelector('.sand-agents-sidebar__account .ob-account-avatar');
        let count = 0; const observer = new MutationObserver(records => { count += records.length; });
        observer.observe(avatar, {attributes:true,childList:true,subtree:true});
        for (let index = 0; index < 5; index++) window.__openbotLocalSettingsScan();
        setTimeout(() => { observer.disconnect(); resolve(count); }, 100);
      })`);
      if (mutations !== 0) throw new Error('Unchanged profile scan mutates avatar: '+mutations);
      await evalExpr('window.__profileFeedbackReload = true');
      await send('Page.reload', { ignoreCache: true });
      await waitForEval("!window.__profileFeedbackReload && document.readyState === 'complete'", 10000);
      await waitForEval("document.querySelector('.sand-agents-sidebar__account-name')?.textContent.includes('Nome fechado')", 10000);
      const reloadedProfile = await evalExpr(`(async () => { const p = await window.desktop.agent.getLocalProfile(); return { name: p.name, photoBytes: p.avatarPngBase64?.length || 0, avatars: [...document.querySelectorAll('.sand-agents-sidebar__account .ob-account-avatar')].map(a => ({source: a._profileSource?.length, image: a.querySelector('img')?.naturalWidth, text: a.textContent})) }; })()`);
      console.log('PROFILE_FEEDBACK_RELOADED', JSON.stringify(reloadedProfile));
      await waitForEval("document.querySelector('.sand-agents-sidebar__account .ob-account-avatar img')?.naturalWidth === 256", 10000);
      await shot('profile-feedback-reloaded');
      await evalExpr(`(() => {
        localStorage.setItem('openbot.profile.name.v1', 'Nome legado');
        window.__openbotLocalProfileAgent = {
          getLocalProfile: async () => ({ name: 'OpenBot Local' }),
          updateLocalProfile: async () => { throw new Error('Migration fixture write failed'); },
        };
        const fixture = document.createElement('section'); fixture.id = 'profile-migration-fixture';
        fixture.innerHTML = '<div><span>local@openbot.invalid</span><button>Sign out</button></div>';
        document.body.appendChild(fixture); window.__openbotLocalSettingsScan();
      })()`);
      await waitForEval("document.getElementById('openbot-profile-status')?.textContent.includes('Migration fixture write failed')");
      await evalExpr("document.getElementById('profile-migration-fixture').remove(); localStorage.removeItem('openbot.profile.name.v1'); delete window.__openbotLocalProfileAgent;");
      console.log('PROFILE_FEEDBACK GREEN: delayed load merges untouched fields, pending save survives panel close, unchanged avatar is stable, persisted name/photo reload');
      return;
    }
    if (process.argv.includes("--profile-only")) {
      const reloadProfile = async () => {
        await evalExpr(`window.__profileTestReload = true`);
        await send("Page.reload", { ignoreCache: true });
        await waitForEval(`!window.__profileTestReload && document.readyState === 'complete'`, 10000);
      };
      const openProfile = async () => {
        await waitForEval(`Boolean(document.querySelector('button[aria-label="Abrir menu da conta"],button[aria-label="Open account menu"]'))`, 10000);
        await send("Input.dispatchKeyEvent", {type:"keyDown", key:",", code:"Comma", modifiers:2, windowsVirtualKeyCode:188});
        await send("Input.dispatchKeyEvent", {type:"keyUp", key:",", code:"Comma", modifiers:2, windowsVirtualKeyCode:188});
        try {
          await waitForEval(`document.querySelector('#openbot-profile-name')?.value === 'Pessoa Teste'`, 10000);
        } catch (error) {
          await shot("profile-debug");
          throw new Error(`${error.message}; ${JSON.stringify(await evalExpr(`({ panels: [...document.querySelectorAll('[role="dialog"]')].map(e=>({label:e.getAttribute('aria-label'),text:e.innerText.slice(0,400)})), card:document.querySelector('.sand-account-card')?.outerHTML.slice(0,1200), name:document.getElementById('openbot-profile-name')?.value, status:document.getElementById('openbot-profile-status')?.textContent })`))}`);
        }
      };
      await evalExpr(`window.desktop.agent.updateLocalProfile({name:'Pessoa Teste'})`);
      await reloadProfile();
      await openProfile();
      const initial = await evalExpr(`({ title: document.querySelector('#openbot-local-profile .ob-profile-title')?.textContent, legacyHidden: document.querySelector('.sand-account-card')?.getAttribute('data-openbot-hide') })`);
      if (initial.title !== "Pessoa Teste" || initial.legacyHidden !== "1") throw new Error(`native account card was not bound to profile: ${JSON.stringify(initial)}`);
      const motion = await evalExpr(`(async () => {
        const details = document.querySelector('#openbot-local-profile details');
        const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
        details.open = false;
        await pause(250);
        const closed = details.getBoundingClientRect().height;
        details.querySelector('summary').click(); await pause(60);
        const middle = details.getBoundingClientRect().height;
        details.querySelector('summary').click(); await pause(30); details.querySelector('summary').click(); await pause(250);
        const opened = details.getBoundingClientRect().height;
        details.querySelector('summary').click(); await pause(250);
        return {closed,middle,opened,settled:details.getBoundingClientRect().height,open:details.open,connected:details.isConnected};
      })()`);
      if (!(motion.middle > motion.closed && motion.middle < motion.opened && Math.abs(motion.settled-motion.closed)<1)) throw new Error('profile expansion did not interpolate or settle: '+JSON.stringify(motion));
      await evalExpr(`document.querySelector('#openbot-local-profile summary').click()`);
      await evalExpr(`(async () => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
        const context = canvas.getContext('2d'); context.fillStyle = '#2563eb'; context.fillRect(0,0,32,32);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
        const files = new DataTransfer(); files.items.add(new File([blob], 'photo.jpg', {type:'image/jpeg'}));
        const input = document.getElementById('openbot-profile-avatar-file'); input.files = files.files; input.dispatchEvent(new Event('change', {bubbles:true}));
      })()`);
      await waitForEval(`document.querySelector('#openbot-profile-avatar img')?.naturalWidth === 256`);
      if (!await evalExpr(`document.querySelector('.ob-profile-colors').hidden`)) throw new Error('irrelevant color controls remain visible');
      await evalExpr(`document.getElementById('openbot-profile-form').requestSubmit()`);
      await waitForEval(`document.getElementById('openbot-profile-status')?.textContent.includes('Perfil salvo')`);
      const saved = await evalExpr(`(async () => { const profile = await window.desktop.agent.getLocalProfile(); return {name:profile.name, hasPhoto:!!profile.avatarPngBase64}; })()`);
      if (saved.name !== "Pessoa Teste" || !saved.hasPhoto) throw new Error("profile photo was not persisted");
      await waitForEval(`document.querySelector('.sand-agents-sidebar__account .ob-account-avatar img')?.naturalWidth === 256`);
      await reloadProfile();
      await openProfile();
      await waitForEval(`document.querySelector('#openbot-profile-avatar img')?.naturalWidth === 256`);
      await shot("profile-photo-persisted");
      await waitForEval(`document.querySelector('.sand-agents-sidebar__account .ob-account-avatar img')?.naturalWidth === 256`);
      await evalExpr(`document.querySelector('#openbot-local-profile summary').click()`);
      await evalExpr(`(() => {const files = new DataTransfer(); files.items.add(new File(['invalid'], 'broken.png', {type:'image/png'})); const input=document.getElementById('openbot-profile-avatar-file'); input.files=files.files; input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await waitForEval(`document.querySelector('#openbot-profile-status.err')?.textContent.length > 0`);
      if (!await evalExpr(`Boolean(document.querySelector('#openbot-profile-avatar img'))`)) throw new Error("invalid photo discarded the current photo");
      const race = await evalExpr(`(async () => {
        const input=document.getElementById('openbot-profile-avatar-file');
        const old=document.querySelector('#openbot-profile-avatar img').src;
        const bytes=Uint8Array.from(atob(old.split(',')[1]), c=>c.charCodeAt(0));
        const select = file => {const list=new DataTransfer();list.items.add(file);input.files=list.files;input.dispatchEvent(new Event('change',{bubbles:true}));};
        const original=window.createImageBitmap;
        let release;
        window.createImageBitmap=(...args)=>new Promise((resolve,reject)=>{release=()=>original(...args).then(resolve,reject);});
        try {
          select(new File([bytes],'slow.png',{type:'image/png'}));
          const pending=document.getElementById('openbot-profile-status').textContent==='Preparando foto…' && document.getElementById('openbot-profile-save').disabled && document.querySelector('#openbot-profile-avatar img').src===old;
          document.getElementById('openbot-profile-avatar-remove').click();
          await release(); await new Promise(resolve=>setTimeout(resolve,250));
          return {pending,removed:!document.querySelector('#openbot-profile-avatar img'),colors:!document.querySelector('.ob-profile-colors').hidden};
        } finally {window.createImageBitmap=original;}
      })()`);
      if (!race.pending || !race.removed || !race.colors) throw new Error('stale photo replaced removal: '+JSON.stringify(race));
      const failure = await evalExpr(`(async () => {
        const button=document.getElementById('openbot-profile-save');
        const name=document.getElementById('openbot-profile-name');name.value='Nome pendente';name.dispatchEvent(new Event('input'));
        const width=button.getBoundingClientRect().width;
        window.__openbotLocalProfileAgent={updateLocalProfile:()=>new Promise((_,reject)=>{window.__rejectProfileSave=()=>reject(new Error('Falha simulada'));})};
        document.getElementById('openbot-profile-form').requestSubmit();
        window.__openbotLocalSettingsScan?.();
        const stable=button.getBoundingClientRect().width===width && button.textContent.includes('Salvando');
        window.__rejectProfileSave(); await new Promise(resolve=>setTimeout(resolve,30));
        delete window.__openbotLocalProfileAgent; delete window.__rejectProfileSave;
        const preserved=!document.querySelector('#openbot-profile-avatar img') && name.value==='Nome pendente';
        name.value='Pessoa Teste';name.dispatchEvent(new Event('input'));
        return {stable,retry:!button.disabled,preserved};
      })()`);
      if (!failure.stable || !failure.retry || !failure.preserved) throw new Error('failed save lost draft or shifted button');
      await evalExpr(`document.getElementById('openbot-profile-avatar-remove').click(); document.getElementById('openbot-profile-form').requestSubmit()`);
      await waitForEval(`document.getElementById('openbot-profile-status')?.textContent.includes('Perfil salvo')`);
      if (await evalExpr(`window.desktop.agent.getLocalProfile().then(profile => !!profile.avatarPngBase64)`)) throw new Error("photo removal was not persisted");
      await waitForEval(`document.querySelector('.sand-agents-sidebar__account .ob-account-avatar')?.textContent === 'PT' && !document.querySelector('.sand-agents-sidebar__account .ob-account-avatar img')`);
      if (!await evalExpr(`(() => {const input=document.getElementById('openbot-profile-name');input.value='Outro';input.dispatchEvent(new Event('input'));input.value='Pessoa Teste';input.dispatchEvent(new Event('input'));return document.getElementById('openbot-profile-save').disabled;})()`)) throw new Error('unchanged profile can be saved');
      await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      const reduced = await evalExpr(`(() => {const details=document.querySelector('#openbot-local-profile details');details.querySelector('summary').click();return getComputedStyle(details,'::details-content').transitionDuration==='0s';})()`);
      if (!reduced) throw new Error('profile ignores reduced motion');
      console.log("PROFILE GREEN: saved name, JPEG selection, reload persistence, invalid image and removal");
      return;
    }
    if (process.argv.includes("--account-menu-only")) {
      await waitForEval(`Boolean(document.querySelector('button[aria-label="Abrir menu da conta"],button[aria-label="Open account menu"]'))`, 10000);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const frames = await evalExpr(`new Promise(resolve => {
          const frames = [];
          document.querySelector('button[aria-label="Abrir menu da conta"],button[aria-label="Open account menu"]').click();
          const inspect = () => {
            const menu = document.querySelector('[role="menu"][aria-label="Account"],[role="menu"][aria-label="Conta"]');
            frames.push(menu?.innerText || '');
            if (frames.length < 8) requestAnimationFrame(inspect); else resolve(frames);
          };
          requestAnimationFrame(inspect);
        })`);
        console.log("ACCOUNT_MENU_FRAMES", JSON.stringify(frames));
        const visible = frames.filter(Boolean);
        if (!visible.length || visible.some(text => /Settings|About|Help Center|Send Feedback|Log out/.test(text)) || !visible[0].includes("Configurações")) throw new Error("account menu exposed English before localization");
        await shot("account-menu-portuguese");
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await waitForEval(`!document.querySelector('[role="menu"]')`, 2000);
      }
      console.log("ACCOUNT MENU GREEN");
      return;
    }
    async function verifyCreateFlow() {
    await waitForEval("Boolean(document.querySelector('.sand-agent-item[data-layout=expanded]'))", 15000);
    const plus = await evalExpr("(() => { const nodes = [...document.querySelectorAll('button, [role=button], a')]; const labels = nodes.map((el) => (el.getAttribute('aria-label') || el.title || el.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 40); const hit = nodes.find((el) => { const aria = (el.getAttribute('aria-label') || '').trim(); const title = (el.getAttribute('title') || '').trim(); return /^(new|new chat|novo|novo chat)$/i.test(aria) || /^(new chat|novo chat)$/i.test(title); }); if (hit) { const startedAt = performance.now(); hit.click(); return { ok: true, startedAt, label: (hit.getAttribute('aria-label') || hit.title || hit.textContent || '').trim(), extraPlus: Boolean(document.getElementById('openbot-new-bot-btn')), labels }; } return { ok: false, extraPlus: Boolean(document.getElementById('openbot-new-bot-btn')), labels }; })()");
    console.log("CLICK_PLUS", JSON.stringify(plus, null, 2));
    await waitForEval("Boolean(document.getElementById('openbot-create-agent'))", 1000);
    const createSetupState = await evalExpr(`(() => {
      const root = document.getElementById("openbot-create-agent");
      const rows = [...document.querySelectorAll(".sand-agent-item[data-layout='expanded']")].filter((element) => element.getClientRects().length > 0);
      const name = root?.querySelector("input[name='name']");
      const submit = root?.querySelector("[data-action='submit']");
      const style = root ? getComputedStyle(root) : null;
      return {
        elapsedMs: performance.now() - ${plus?.startedAt ?? 0},
        rowsBeforeSubmit: rows.length,
        hasName: name instanceof HTMLInputElement,
        hasColors: Boolean(root?.querySelector("[aria-label='Cor do bot']")),
        hasShapes: Boolean(root?.querySelector("[aria-label='Formato do bot']")),
        hasSuggestions: /Sugestões|Suggestions/i.test(root?.textContent || ""),
        submitDisabled: submit instanceof HTMLButtonElement && submit.disabled,
        background: style?.backgroundColor || null,
        color: style?.color || null,
        opacity: style?.opacity || null,
        zIndex: style?.zIndex || null,
      };
    })()`);
    console.log("CREATE_SETUP_STATE", JSON.stringify(createSetupState));
    if (!plus.ok || createSetupState.elapsedMs > 500 || createSetupState.rowsBeforeSubmit !== 1 || !createSetupState.hasName || !createSetupState.hasColors || !createSetupState.hasShapes || !createSetupState.hasSuggestions || !createSetupState.submitDisabled) {
      throw new Error(`bot setup did not open promptly before creation: ${JSON.stringify({ plus, createSetupState })}`);
    }
    await waitForEval("getComputedStyle(document.getElementById('openbot-create-agent')).opacity === '1'");
    await shot("visual-create-setup");
    const createFeedback = await evalExpr(`(async () => {
      const root = document.getElementById("openbot-create-agent");
      const input = root.querySelector("input");
      const card = root.querySelector("[data-suggestion]");
      const submit = root.querySelector("[data-action='submit']");
      const cancel = root.querySelector("[data-action='cancel']");
      card.click();
      const selected = card.getAttribute("aria-pressed") === "true";
      input.value += " editado";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const cleared = card.getAttribute("aria-pressed") === "false";
      const original = window.__openbotLocalSettingsDesktop;
      const desktop = original || window.desktop;
      let rejectCreation;
      let calls = 0;
      window.__openbotLocalSettingsDesktop = { ...desktop, agent: { ...desktop.agent,
        createAgent: () => { calls++; return new Promise((_, reject) => { rejectCreation = reject; }); }
      } };
      try {
        submit.click();
        submit.click();
        cancel.click();
        root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        const busy = root.getAttribute("aria-busy") === "true" && root.isConnected && !root.inert &&
          [...root.querySelectorAll("button,input")].every((control) => control.disabled) && calls === 1;
        const legible = getComputedStyle(submit).opacity === "1" && submit.textContent === "Criando…";
        const spinner = getComputedStyle(submit, "::before").animationName === "ob-create-spin";
        rejectCreation(new Error("Falha de criação de fixture"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const recovered = root.getAttribute("aria-busy") === "false" && !cancel.disabled && !input.disabled && !submit.disabled &&
          root.querySelector(".ob-create-status").textContent.includes("Falha de criação de fixture");
        return { selected, cleared, busy, legible, spinner, recovered,
          avatarNormal: getComputedStyle(root.querySelector('.ob-create-preview')).transitionDuration.includes('0.14s'),
          entrance: getComputedStyle(root).transitionDuration === "0.18s",
          controls: getComputedStyle(card).transitionDuration.includes("0.12s") };
      } finally {
        if (original) window.__openbotLocalSettingsDesktop = original;
        else delete window.__openbotLocalSettingsDesktop;
      }
    })()`);
    console.log("CREATE_FEEDBACK", JSON.stringify(createFeedback));
    if (Object.values(createFeedback).some((value) => value !== true)) throw new Error("creation feedback regression: " + JSON.stringify(createFeedback));
    const leaving = await evalExpr(`(() => {
      const root = document.getElementById("openbot-create-agent");
      root.querySelector("[data-action='cancel']").click();
      return root.isConnected && root.inert && root.classList.contains("is-leaving");
    })()`);
    if (!leaving) throw new Error("creation exit transition regression");
    await waitForEval("!document.getElementById('openbot-create-agent')");
    await evalExpr("document.querySelector('.sand-agents-sidebar__new').click()");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    const createReduced = await evalExpr(`(() => {
      const root = document.getElementById("openbot-create-agent");
      root.setAttribute("aria-busy", "true");
      const still = getComputedStyle(root.querySelector("[data-action='submit']"), "::before").animationName === "none";
      root.setAttribute("aria-busy", "false");
      const reduced = still && getComputedStyle(root).transitionDuration === "0s" && getComputedStyle(root.querySelector(".ob-create-card")).transitionDuration === "0s";
      root.querySelector('[data-color="#ff3151"]').click();
      root.querySelector('.ob-create-shape[data-shape="hex"]').click();
      const avatar = root.querySelector('.ob-create-preview');
      const avatarReduced = getComputedStyle(avatar).transitionDuration === "0s" && avatar.dataset.shape === "hex" && avatar.style.getPropertyValue('--ob-avatar') === "#ff3151";
      console.log("CREATE_AVATAR_REDUCED", getComputedStyle(avatar).transitionDuration);
      root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return reduced && avatarReduced && !root.isConnected;
    })()`);
    if (!createReduced) throw new Error("creation reduced motion regression");
    await send("Emulation.setEmulatedMedia", { features: [] });
    await evalExpr("document.querySelector('.sand-agents-sidebar__new').click()");
    await evalExpr(`(() => {
      const input = document.querySelector("#openbot-create-agent input[name='name']");
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "New Bot");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    await waitForEval("document.querySelector('#openbot-create-agent [data-action=submit]')?.disabled === false");
    await evalExpr("document.querySelector('#openbot-create-agent [data-action=submit]')?.click()");
    await waitForEval("(() => { const rows = [...document.querySelectorAll(\".sand-agent-item[data-layout='expanded']\")].filter((element) => element.getClientRects().length > 0); return rows.length === 2 && rows.some((row) => row.querySelector('.sand-agent-item__name')?.textContent?.trim() === 'New Bot'); })()", 6000);
    await sleep(1200);
    await shot("visual-created");

    const nativeCreateState = await evalExpr(`(() => {
      const rows = [...document.querySelectorAll(".sand-agent-item[data-layout='expanded']")].filter((element) => element.getClientRects().length > 0);
      return {
        names: rows.map((row) => row.querySelector(".sand-agent-item__name")?.textContent?.trim() || ""),
        active: rows.find((row) => row.getAttribute("aria-current") === "page" || row.dataset.active === "true")?.querySelector(".sand-agent-item__name")?.textContent?.trim() || "",
        visibleSettingsLeak: Boolean([...document.querySelectorAll('#openbot-provider-settings, #openbot-status')].find((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')),
      };
    })()`);
    console.log("NATIVE_CREATE_STATE", JSON.stringify(nativeCreateState));
    if (!plus.ok || nativeCreateState.names.length !== 2 || !nativeCreateState.names.includes("Local User") || !nativeCreateState.names.includes("New Bot") || nativeCreateState.active !== "New Bot" || nativeCreateState.visibleSettingsLeak) {
      throw new Error(`native bot creation did not produce one selected bot: ${JSON.stringify({ plus, nativeCreateState })}`);
    }

    }
    if (emptyOnboardingOnly) {
      const emptyProviderConfig = await evalExpr(`window.desktop.agent.getProviderConfig().then((value) => ({ value })).catch((error) => ({ error: String(error?.message || error) }))`);
      console.log("EMPTY_PROVIDER_CONFIG", JSON.stringify(emptyProviderConfig));
      // No active provider exists for an empty roster. Verify the visible flow, not its legacy session marker.
       await waitForEval(`(() => {
         const text = document.querySelector(".sand-onboarding__meet")?.innerText || "";
         return text.includes("Conheça o OpenBot") && text.includes("Dê uma tarefa ao seu time de bots") && Boolean(document.querySelector('[data-openbot-onboarding-continue="1"]:not(:disabled)'));
       })()`, 10000);
       await sleep(1800);
       const onboarding = await evalExpr(`(() => {
         const root = document.querySelector(".sand-onboarding__meet");
         const rect = root?.getBoundingClientRect();
         const text = root?.innerText || "";
         const title = root?.querySelector('[data-openbot-onboarding-title="1"]');
         const continueButton = root?.querySelector('[data-openbot-onboarding-continue="1"]');
         const channels = (value) => (value?.match(/\\d+(?:\\.\\d+)?/g) || []).slice(0, 3).map(Number);
         const titleColor = title ? getComputedStyle(title).color : "";
         const continueBackground = continueButton ? getComputedStyle(continueButton).backgroundColor : "";
         const titleChannels = channels(titleColor);
         const continueChannels = channels(continueBackground);
         const opacityChain = (element) => {
           const values = [];
           let current = element;
           while (current && root?.contains(current)) {
             const style = getComputedStyle(current);
             const opacity = Number(style.opacity || 1);
             if (opacity < 1 || style.filter !== "none") values.push({ tag: current.tagName, className: current.className, opacity, filter: style.filter });
             current = current.parentElement;
           }
           return values;
         };
         const titleOpacityChain = opacityChain(title);
         const continueOpacityChain = opacityChain(continueButton);
         const hitStack = (element) => {
           const rect = element?.getBoundingClientRect();
           if (!rect) return [];
           return document.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2).slice(0, 6).map((entry) => ({ tag: entry.tagName, className: entry.className, text: entry.textContent?.trim().slice(0, 40) }));
         };
         return {
           language: document.documentElement.lang,
           genericWelcomeVisible: Boolean(document.getElementById("openbot-welcome")),
           title: text.includes("Conheça o OpenBot"),
           composer: text.includes("Dê uma tarefa ao seu time de bots"),
           continueButton: continueButton?.innerText.trim() === "Continuar",
           titleColor,
           continueBackground,
           titleTextFill: title ? getComputedStyle(title).webkitTextFillColor : "",
           titleFilter: title ? getComputedStyle(title).filter : "",
           continueFilter: continueButton ? getComputedStyle(continueButton).filter : "",
           titleOpacityChain,
           continueOpacityChain,
           titleHitStack: hitStack(title),
           continueHitStack: hitStack(continueButton),
           titleBright: titleChannels.length === 3 && Math.min(...titleChannels) >= 220,
           continueBright: continueChannels.length === 3 && Math.min(...continueChannels) >= 220,
           titleOpaque: titleOpacityChain.length === 0,
           continueOpaque: continueOpacityChain.length === 0,
           visible: Boolean(rect && rect.width > 0 && rect.height > 0),
          fits: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight),
          continueEnabled: Boolean(continueButton && !continueButton.disabled),
        };
      })()`);
      console.log("EMPTY_ONBOARDING", JSON.stringify(onboarding, null, 2));
       if (onboarding.language !== "pt-BR" || onboarding.genericWelcomeVisible || !onboarding.title || !onboarding.composer || !onboarding.continueButton || !onboarding.titleBright || !onboarding.continueBright || !onboarding.titleOpaque || !onboarding.continueOpaque || !onboarding.visible || !onboarding.fits || !onboarding.continueEnabled) {
        throw new Error(`empty-agent onboarding failed visual verification: ${JSON.stringify(onboarding)}`);
      }
      await shot("visual-empty-agent-onboarding");
      const continueTarget = await evalExpr(`(() => { const button=document.querySelector('[data-openbot-onboarding-continue="1"]'); const r=button.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...continueTarget, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...continueTarget, button: "left", clickCount: 1 });
      await waitForEval(`(() => { const meet=document.querySelector('.sand-onboarding__meet'); return (!meet || !meet.getClientRects().length) && document.body.innerText.trim().length > 0; })()`, 10000);
      console.log("EMPTY_ONBOARDING_CONTINUED", await evalExpr("document.body.innerText.slice(0, 600)"));
      await shot("visual-empty-agent-continued");
      console.log("VISUAL_EVIDENCE_DIR", evidenceDir);
      ws.close();
      return;
    }
    if (screenCloseOnly) {
      const computerPrepaint = await evalExpr(`(() => {
        const control = document.createElement('button');
        control.className = 'sand-chat-header__computer';
        control.setAttribute('aria-label', "OpenBot's Computer, in use");
        document.body.append(control);
        const result = { display: getComputedStyle(control).display, rects: control.getClientRects().length };
        control.remove();
        return result;
      })()`);
      if (computerPrepaint.display !== 'none' || computerPrepaint.rects !== 0) throw new Error('Computer control visible before observer: ' + JSON.stringify(computerPrepaint));
      console.log('COMPUTER_PREPAINT_GREEN', JSON.stringify(computerPrepaint));
      await waitForEval(`(() => [...document.querySelectorAll('[aria-label="View agent settings"]')]
        .some((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden"))()`, 10000);
      const opened = await evalExpr(`(() => {
        const toggle = [...document.querySelectorAll('[aria-label="View agent settings"]')]
          .find((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
        toggle?.click();
        return Boolean(toggle);
      })()`);
      if (!opened) throw new Error("agent settings control was not available");
      await waitForEval(`(() => {
        const details = document.getElementById("sand-conversation-details");
        const settings = document.getElementById("openbot-provider-settings");
        return Boolean(details?.getClientRects().length && settings?.getClientRects().length);
      })()`, 6000);
      await shot("visual-settings-before-close");
      const closeFrames = await evalExpr(`(async () => {
        const close = [...document.querySelectorAll('button[aria-label="Close details"], button[aria-label="Fechar detalhes"]')].find(button => button.getClientRects().length > 0);
        if (!close) throw new Error('Close details control missing');
        close.click();
        const frames = [];
        for (let i = 0; i < 24; i++) {
          await new Promise(requestAnimationFrame);
          frames.push([...document.querySelectorAll('.sand-chat-header__computer')].some(button => button.getClientRects().length > 0));
        }
        return frames;
      })()`);
      if (closeFrames.some(Boolean)) throw new Error('Computer control flashed during settings close');
      console.log('COMPUTER_CLOSE_FRAMES_GREEN', JSON.stringify({ frames: closeFrames.length, visibleFrames: closeFrames.filter(Boolean).length }));
      await evalExpr(`document.querySelector('[aria-label="View agent settings"]').click()`);
      await waitForEval("Boolean(document.getElementById('openbot-provider-settings')?.getClientRects().length)", 6000);
      const legacyScreenInjected = await evalExpr(`(() => {
        const details = document.getElementById("sand-conversation-details");
        const settings = document.getElementById("openbot-provider-settings");
        if (!details || !settings) return { injected: false, immediatelyVisible: null };
        settings.remove();
        const legacy = document.createElement("section");
        legacy.className = "sand-computer-screen";
        legacy.innerHTML = "<div class='sand-computer-stage__placeholder'>Can't reach Test Agent's screen</div><p>Test Agent's screen</p>";
        details.appendChild(legacy);
        const detailsStyle = getComputedStyle(details);
        return {
          injected: true,
          immediatelyVisible: details.getClientRects().length > 0 && detailsStyle.display !== "none" && detailsStyle.visibility !== "hidden",
        };
      })()`);
      if (!legacyScreenInjected?.injected) throw new Error("legacy screen transition fixture was not injected");
      if (legacyScreenInjected.immediatelyVisible) throw new Error(`legacy screen was visible in its insertion frame: ${JSON.stringify(legacyScreenInjected)}`);
      console.log("SCREEN_INSERT_STATE", JSON.stringify(legacyScreenInjected));
      await waitForEval(`(() => {
        const toggle = [...document.querySelectorAll('[aria-label="View agent settings"]')]
          .find((element) => element.getClientRects().length > 0);
        const details = document.getElementById("sand-conversation-details");
        const detailsVisible = Boolean(details?.getClientRects().length && getComputedStyle(details).visibility !== "hidden");
        const legacyScreenVisible = [...document.querySelectorAll("[class*=computer], [class*=screen]")]
          .some((element) => {
            const text = (element.textContent || "").replace(/\\s+/g, " ").trim();
            return element.getClientRects().length > 0 && (/Can.t reach .+ screen/i.test(text) || /(?:'|’)?s screen$/i.test(text));
          });
        return toggle?.getAttribute("aria-expanded") === "false" && !detailsVisible && !legacyScreenVisible;
      })()`, 6000);
      const closedState = await evalExpr(`(() => {
        const toggle = [...document.querySelectorAll('[aria-label="View agent settings"]')]
          .find((element) => element.getClientRects().length > 0);
        const details = document.getElementById("sand-conversation-details");
        const legacyScreenVisible = [...document.querySelectorAll("[class*=computer], [class*=screen]")]
          .some((element) => element.getClientRects().length > 0 && /screen/i.test(element.textContent || ""));
        return {
          toggleExpanded: toggle?.getAttribute("aria-expanded") || null,
          detailsVisible: Boolean(details?.getClientRects().length && getComputedStyle(details).visibility !== "hidden"),
          providerSettingsVisible: Boolean(document.getElementById("openbot-provider-settings")?.getClientRects().length),
          legacyScreenVisible,
        };
      })()`);
      console.log("SCREEN_CLOSE_STATE", JSON.stringify(closedState));
      await shot("visual-settings-closed");
      console.log("VISUAL_EVIDENCE_DIR", evidenceDir);
      ws.close();
      return;
    }
    const waitForMotion = async (selector, timeoutMs = 1500) => {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = await evalExpr(`(() => {
          const found = document.querySelector(${JSON.stringify(selector)});
          const target = found?.dataset.openbotMotion
            ? found
            : (${JSON.stringify(selector)} === "#openbot-provider-settings" ? found?.closest('[data-openbot-motion-surface="settings"]') || found : found);
          if (!target) return null;
          const rect = target.getBoundingClientRect();
          const animations = target.getAnimations();
          const transforms = animations.flatMap((animation) => animation.effect?.getKeyframes?.().map((frame) => frame.transform).filter(Boolean) || []);
          let scrollHost = target.parentElement;
          while (scrollHost && scrollHost !== document.body) {
            const hostStyle = getComputedStyle(scrollHost);
            if (/(auto|scroll)/.test(hostStyle.overflowY) && scrollHost.scrollHeight > scrollHost.clientHeight) break;
            scrollHost = scrollHost.parentElement;
          }
          const hostRect = scrollHost?.getBoundingClientRect?.() || null;
          return {
            selector: ${JSON.stringify(selector)},
            kind: target.dataset.openbotMotion || null,
            duration: target.dataset.openbotMotionDuration || null,
            runs: target.dataset.openbotMotionRuns || null,
            activeAnimations: animations.length,
            transforms,
            fits: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
            scrollHost: hostRect ? {
              fits: hostRect.left >= 0 && hostRect.top >= 0 && hostRect.right <= innerWidth && hostRect.bottom <= innerHeight,
              scrollable: scrollHost.scrollHeight > scrollHost.clientHeight,
              horizontalContained: rect.left >= hostRect.left - 1 && rect.right <= hostRect.right + 1,
            } : null,
          };
        })()`);
        if (last?.runs) return last;
        await sleep(25);
      }
      return last;
    };
    const verifyPastedImageComposer = async (baselineShellHeight) => {
      await waitForEval(`(() => [...document.querySelectorAll("[contenteditable='true']")]
        .some((element) => element.getClientRects().length > 0 && (element.getAttribute("aria-label") === "Prompt" || element.classList.contains("sand-prompt-field"))))()`, 6000);
      const directAttachmentMedia = await evalExpr(`(async () => {
        const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAADAAAAAkCAYAAADPRbkKAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAC9SURBVFhH7c+xDcMwDAVR75Myq2Utb5KdbLBwcwhAUvyIIIjFawSI5B2vz/da2cGH1XTAbB0wWwfQdb5d/FMhC+CREZwxQhLAwzI4K6scwINGcGZGKYCHVHB21HAAD1Dgjog9A7hYibs8HaDGXZ79ArhQjfs86QDDpUrc5ekANe7y7BlguFiBOyL2DTA8oIKzo0oBhoeM4MyMcoDhQRmclSUJMDwsgjNGyAIePPIX/qmQB/xbB8zWAbMtH3ADggIS+PLl8rgAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
        const staged = await window.desktop.stageAttachmentBytes("direct-preview.png", bytes);
        const media = staged?.path ? await window.desktop.resolveAttachmentMedia(staged.path) : null;
        if (staged?.path) await window.desktop.discardStagedAttachment(staged.path);
        return { staged, media };
      })()`);
      console.log("DIRECT_ATTACHMENT_MEDIA", JSON.stringify(directAttachmentMedia));
      if (directAttachmentMedia?.staged?.ok !== true || directAttachmentMedia?.media?.kind !== "image" || !directAttachmentMedia.media.dataUrl?.startsWith("data:image/png;base64,")) {
        throw new Error(`staged image preview bridge failed: ${JSON.stringify(directAttachmentMedia)}`);
      }
      const pastedImage = await evalExpr(`(() => {
        const composer = [...document.querySelectorAll("[contenteditable='true']")].find((element) => element.getClientRects().length > 0 && (element.getAttribute("aria-label") === "Prompt" || element.classList.contains("sand-prompt-field")));
        if (!composer) return false;
        const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAADAAAAAkCAYAAADPRbkKAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAC9SURBVFhH7c+xDcMwDAVR75Myq2Utb5KdbLBwcwhAUvyIIIjFawSI5B2vz/da2cGH1XTAbB0wWwfQdb5d/FMhC+CREZwxQhLAwzI4K6scwINGcGZGKYCHVHB21HAAD1Dgjog9A7hYibs8HaDGXZ79ArhQjfs86QDDpUrc5ekANe7y7BlguFiBOyL2DTA8oIKzo0oBhoeM4MyMcoDhQRmclSUJMDwsgjNGyAIePPIX/qmQB/xbB8zWAbMtH3ADggIS+PLl8rgAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], "clipboard-image.png", { type: "image/png" }));
        const event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: transfer });
        composer.focus();
        return composer.dispatchEvent(event) === false;
      })()`);
      if (!pastedImage) throw new Error("native composer did not accept a pasted image");
      await waitForEval(`(() => [...document.querySelectorAll(".sand-prompt-attachments .sand-prompt-attachment")]
        .some((element) => element.getClientRects().length > 0))()`, 6000);
      await waitForEval(`(() => {
        return [...document.querySelectorAll(".sand-prompt-attachments .sand-prompt-attachment img")]
          .some((image) => image.getClientRects().length > 0 && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
      })()`, 6000);
      await sleep(220);
      const pastedImageUi = await evalExpr(`(() => {
        const composer = [...document.querySelectorAll(".sand-prompt-field")].find((element) => element.getClientRects().length > 0);
        const shell = composer?.closest(".sand-prompt-shell");
        const attachment = shell?.querySelector(".sand-prompt-attachment");
        const thumbnail = attachment?.querySelector("img");
        const actions = shell?.querySelector(".sand-prompt-actions-row");
        const shellRect = shell?.getBoundingClientRect();
        const composerRect = composer?.getBoundingClientRect();
        const attachmentRect = attachment?.getBoundingClientRect();
        const actionsRect = actions?.getBoundingClientRect();
        return {
          shellHeight: shellRect?.height || 0,
          attachmentVisible: Boolean(attachmentRect?.width && attachmentRect?.height),
          thumbnailLoaded: Boolean(thumbnail?.complete && thumbnail.naturalWidth > 0 && thumbnail.naturalHeight > 0),
          thumbnailNaturalWidth: thumbnail?.naturalWidth || 0,
          thumbnailNaturalHeight: thumbnail?.naturalHeight || 0,
          unavailableFallbackVisible: /Image unavailable/i.test(attachment?.innerText || ""),
          attachmentInside: Boolean(shellRect && attachmentRect && attachmentRect.top >= shellRect.top - 1 && attachmentRect.bottom <= shellRect.bottom + 1),
          composerBelowAttachment: Boolean(composerRect && attachmentRect && composerRect.top >= attachmentRect.bottom - 1),
          actionsInside: Boolean(shellRect && actionsRect && actionsRect.top >= shellRect.top && actionsRect.bottom <= shellRect.bottom),
          transitionDuration: attachment ? getComputedStyle(attachment).transitionDuration : "",
        };
      })()`);
      console.log("PASTED_IMAGE_UI", JSON.stringify(pastedImageUi));
      await shot("visual-composer-pasted-image");
      if (pastedImageUi.shellHeight <= baselineShellHeight || !pastedImageUi.attachmentVisible || !pastedImageUi.thumbnailLoaded || pastedImageUi.unavailableFallbackVisible || !pastedImageUi.attachmentInside || !pastedImageUi.composerBelowAttachment || !pastedImageUi.actionsInside || !pastedImageUi.transitionDuration.includes("0.16s")) {
        throw new Error(`pasted image composer layout failed: ${JSON.stringify(pastedImageUi)}`);
      }
      await evalExpr(`document.querySelector('.sand-prompt-attachment button[aria-label^="Remove "]')?.click()`);
      await waitForEval("!document.querySelector('.sand-prompt-attachments .sand-prompt-attachment')", 4000);
      return pastedImageUi;
    };
    await waitForEval("sessionStorage.getItem('openbot.welcome.completed.session.v1') === '1'", 5000);
    const startupSurface = await evalExpr(`({
      legacyWelcomeVisible: Boolean(document.getElementById("openbot-welcome")),
      appInteractive: document.getElementById("root")?.inert === false,
    })`);
    console.log("STARTUP_SURFACE", JSON.stringify(startupSurface));
    if (startupSurface.legacyWelcomeVisible || !startupSurface.appInteractive) {
      throw new Error(`legacy welcome was not skipped for an existing bot: ${JSON.stringify(startupSurface)}`);
    }
    if (attachmentOnly) {
      await waitForEval(`(() => [...document.querySelectorAll(".sand-prompt-field")]
        .some((element) => element.getClientRects().length > 0))()`, 6000);
      const baselineComposerUi = await evalExpr(`(() => {
        const composer = [...document.querySelectorAll(".sand-prompt-field")].find((element) => element.getClientRects().length > 0);
        const shell = composer?.closest(".sand-prompt-shell");
        const pad = shell?.querySelector(".sand-prompt-pad");
        const actions = shell?.querySelector(".sand-prompt-actions-row");
        const placeholder = composer?.querySelector("p.is-editor-empty[data-placeholder]");
        const shellRect = shell?.getBoundingClientRect();
        const composerRect = composer?.getBoundingClientRect();
        const placeholderRect = placeholder?.getBoundingClientRect();
        const actionsRect = actions?.getBoundingClientRect();
        const pseudo = placeholder ? getComputedStyle(placeholder, "::before") : null;
        return {
          shellHeight: shellRect?.height || 0,
          composerHeight: composerRect?.height || 0,
          composerTopInset: shellRect && composerRect ? composerRect.top - shellRect.top : 0,
          placeholderTopInset: shellRect && placeholderRect ? placeholderRect.top - shellRect.top : 0,
          placeholderBottomInside: Boolean(shellRect && placeholderRect && placeholderRect.bottom <= shellRect.bottom),
          placeholderBeforeActions: Boolean(placeholderRect && actionsRect && placeholderRect.bottom <= actionsRect.top - 12),
          actionsInside: Boolean(shellRect && actionsRect && actionsRect.top >= shellRect.top && actionsRect.bottom <= shellRect.bottom),
          padPadding: pad ? getComputedStyle(pad).padding : null,
          padJustify: pad ? getComputedStyle(pad).justifyContent : null,
          composerMinHeight: composer ? getComputedStyle(composer).minHeight : null,
          placeholderLeft: Number.parseFloat(pseudo?.left || "0"),
          placeholderTop: Number.parseFloat(pseudo?.top || "0"),
          placeholderOverflow: pseudo?.overflow || "",
          placeholderLineHeight: pseudo?.lineHeight || "",
        };
      })()`);
      console.log("BASELINE_COMPOSER_UI", JSON.stringify(baselineComposerUi));
      await shot("visual-composer-empty");
      if (baselineComposerUi.shellHeight < 86 || baselineComposerUi.shellHeight > 94 || baselineComposerUi.composerHeight < 47 || baselineComposerUi.composerHeight > 50 || baselineComposerUi.composerTopInset < 9 || baselineComposerUi.composerTopInset > 12 || baselineComposerUi.placeholderTopInset < 12 || baselineComposerUi.placeholderTopInset > 16 || !baselineComposerUi.placeholderBottomInside || !baselineComposerUi.placeholderBeforeActions || !baselineComposerUi.actionsInside || baselineComposerUi.padPadding !== "0px" || baselineComposerUi.padJustify !== "flex-start" || baselineComposerUi.composerMinHeight !== "48px" || baselineComposerUi.placeholderLeft < 2 || baselineComposerUi.placeholderTop < 2 || baselineComposerUi.placeholderOverflow !== "visible" || baselineComposerUi.placeholderLineHeight !== "20px") {
        throw new Error(`empty composer clipping guard failed: ${JSON.stringify(baselineComposerUi)}`);
      }
      await verifyPastedImageComposer(baselineComposerUi.shellHeight);
      await evalExpr(`[...document.querySelectorAll(".sand-prompt-field")].find((element) => element.getClientRects().length > 0)?.focus()`);
      const multilineComposerText = "Primeiramente, é você ter acesso ao wacli, que é por onde atendemos. A skill é essa:\nC:\\Users\\User\\.codex\\skills\\whatsapp\nPrefere salvá-la no seu workspace ou acessar pelo meu pc?";
      await send("Input.insertText", { text: multilineComposerText });
      await waitForEval(`(() => [...document.querySelectorAll(".sand-prompt-field")]
        .some((element) => element.getClientRects().length > 0 && element.innerText.includes("Prefere salvá-la")))()`, 4000);
      const typedComposerUi = await evalExpr(`(() => {
        const composer = [...document.querySelectorAll(".sand-prompt-field")].find((element) => element.getClientRects().length > 0);
        const shell = composer?.closest(".sand-prompt-shell");
        const text = composer?.querySelector("p")?.firstChild;
        const actions = shell?.querySelector(".sand-prompt-actions-row");
        const attach = shell?.querySelector(".sand-prompt-attach");
        const submit = shell?.querySelector(".sand-prompt-send");
        const shellRect = shell?.getBoundingClientRect();
        const actionsRect = actions?.getBoundingClientRect();
        const attachRect = attach?.getBoundingClientRect();
        const submitRect = submit?.getBoundingClientRect();
        const range = text?.nodeType === Node.TEXT_NODE ? document.createRange() : null;
        if (range) {
          range.setStart(text, 0);
          range.setEnd(text, Math.min(1, text.textContent?.length || 0));
        }
        const glyphRect = range?.getBoundingClientRect();
        const textRects = [];
        if (composer) {
          const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!(node.textContent || "").trim()) continue;
            const textRange = document.createRange();
            textRange.selectNodeContents(node);
            textRects.push(...textRange.getClientRects());
          }
        }
        const overlaps = (first, second) => Boolean(first && second && first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top);
        return {
          firstGlyphInside: Boolean(shellRect && glyphRect && glyphRect.left >= shellRect.left + 8 && glyphRect.top >= shellRect.top + 8 && glyphRect.bottom <= shellRect.bottom - 8),
          firstGlyphBeforeActions: Boolean(glyphRect && actionsRect && glyphRect.bottom <= actionsRect.top - 12),
          firstGlyphLeftInset: shellRect && glyphRect ? glyphRect.left - shellRect.left : 0,
          firstGlyphTopInset: shellRect && glyphRect ? glyphRect.top - shellRect.top : 0,
          textOverlapsAttach: textRects.some((rect) => overlaps(rect, attachRect)),
          textOverlapsSubmit: textRects.some((rect) => overlaps(rect, submitRect)),
          textBottom: textRects.length ? Math.max(...textRects.map((rect) => rect.bottom)) : 0,
          actionsTop: actionsRect?.top || 0,
        };
      })()`);
      console.log("TYPED_COMPOSER_UI", JSON.stringify(typedComposerUi));
      await shot("visual-composer-typed");
      if (!typedComposerUi.firstGlyphInside || !typedComposerUi.firstGlyphBeforeActions || typedComposerUi.firstGlyphTopInset < 12 || typedComposerUi.firstGlyphTopInset > 18 || typedComposerUi.textOverlapsAttach || typedComposerUi.textOverlapsSubmit || typedComposerUi.textBottom > typedComposerUi.actionsTop - 8) {
        throw new Error(`typed composer clipping guard failed: ${JSON.stringify(typedComposerUi)}`);
      }
      console.log("VISUAL_EVIDENCE_DIR", evidenceDir);
      ws.close();
      return;
    }
    if (process.argv.includes("--transitions-only")) {
      await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
        window.__transitionNavCalls = [];
        const original = Element.prototype.animate;
        Element.prototype.animate = function(frames, options) {
          const result = original.call(this, frames, options);
          if (this.matches('main.sand-chat,.sand-virtual-transcript')) {
            const parents = [];
            for (let p = this.parentElement; p; p = p.parentElement) if (p.getAnimations().some(a => a.playState === 'running')) parents.push(p.className);
            window.__transitionNavCalls.push({cls:this.className, kind:this.dataset.openbotMotion, frames, parents});
          }
          return result;
        };
      })()` });
      await verifyCreateFlow();
      const switchBot = async (name) => {
        await evalExpr(`[...document.querySelectorAll('.sand-agent-item[data-layout=expanded]')].find(row => row.querySelector('.sand-agent-item__name')?.textContent?.trim() === ${JSON.stringify(name)}).click()`);
        await sleep(400);
      };
      await switchBot("Local User");
      await evalExpr(`(() => {
        window.__motionCalls = [];
        const original = Element.prototype.animate;
        Element.prototype.animate = function(frames, options) {
          window.__motionCalls.push({kind:this.dataset.openbotMotion, cls:this.className, enter:this.getAttribute('data-enter'), key:this.getAttribute('data-row-key'), frames, duration:options?.duration});
          return original.call(this, frames, options);
        };
        document.querySelector('main.sand-chat [contenteditable="true"], main.sand-chat textarea')?.focus();
      })()`);
      await send("Input.insertText", { text: "Teste de transições" });
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await waitForEval("document.querySelector('main.sand-chat')?.innerText.includes('incremental stream')", 15000);
      await evalExpr("window.desktop.agent.cancelPrompt({agentId:'openbot-default'})");
      await sleep(400);
      console.log("LIVE_MESSAGE_MOTION", JSON.stringify(await evalExpr("window.__motionCalls")));
      await switchBot("New Bot");
      await evalExpr("window.__motionCalls = []");
      await switchBot("Local User");
      const historical = await evalExpr("window.__motionCalls");
      console.log("HISTORY_MOTION", JSON.stringify(historical));
      await shot("visual-transition-history");
      if (historical.some(call => call.kind === 'message' && /sand-transcript-row|sand-message-card/.test(call.cls))) throw new Error("history received local new-message motion");
      for (const name of ["New Bot", "Local User", "New Bot", "Local User"]) await switchBot(name);
      const originalConversation = await evalExpr("window.desktop.agent.getActiveConversation({agentId:'openbot-default',expectedAgentId:'openbot-default'})");
      await evalExpr("window.desktop.agent.createConversation({title:'Conversa de transições',agentId:'openbot-default',expectedAgentId:'openbot-default'})");
      await sleep(400);
      console.log("NEW_CONVERSATION_MOTION", JSON.stringify(await evalExpr("window.__transitionNavCalls || []")));
      await evalExpr(`window.desktop.agent.activateConversation({conversationId:${JSON.stringify(originalConversation.id)},agentId:'openbot-default',expectedAgentId:'openbot-default'})`);
      await waitForEval("document.querySelector('main.sand-chat')?.innerText.includes('Teste de transições')", 10000);
      await sleep(400);
      console.log("RETURN_CONVERSATION_MOTION", JSON.stringify(await evalExpr("window.__transitionNavCalls || []")));
      const settled = await evalExpr(`(() => {
        const rows = [...document.querySelectorAll('main.sand-chat .sand-transcript-row')];
        return { rows: rows.length, animatedRows: rows.filter(row => row.dataset.openbotMotion === 'message').length,
          active: [...document.querySelectorAll('[data-openbot-motion]')].flatMap(el => el.getAnimations()).filter(a => a.playState === 'running').length,
          transformsPreserved: rows.every(row => !row.style.transform || getComputedStyle(row).transform === 'matrix(1, 0, 0, 1, 0, ' + parseFloat(row.style.transform.slice(11)) + ')') };
      })()`);
      console.log("TRANSITIONS_SETTLED", JSON.stringify(settled));
      if (!settled.rows || settled.animatedRows || settled.active || !settled.transformsPreserved) throw new Error("transition geometry or idle motion regression");
      console.log("TRANSITIONS GREEN");
      ws.close();
      return;
    }
    if (process.argv.includes("--memory-close-only")) {
      await waitForEval("Boolean(document.querySelector('.sand-agent-item[data-layout=expanded]'))", 15000);
      await evalExpr(`(() => { const button = document.querySelector('[aria-label="View agent settings"]'); if (button?.getAttribute('aria-expanded') !== 'true') button?.click(); })()`);
      await waitForEval("Boolean(document.querySelector('[data-action=\"open-memory-manager\"]:not(:disabled)'))", 10000);
      const openMemory = async () => {
        await evalExpr("document.querySelector('[data-action=\"open-memory-manager\"]').click()");
        await waitForEval("Boolean(document.getElementById('openbot-memory-dialog'))");
        await sleep(240);
      };
      await openMemory();
      const closing = await evalExpr(`(() => {
        const root = document.getElementById('openbot-memory-dialog');
        root.querySelector('[data-action="close-dialog"]').click();
        return { connected: root.isConnected, backgroundInert: document.getElementById('root').inert };
      })()`);
      console.log("MEMORY_CLOSING", JSON.stringify(closing));
      if (!closing.connected || !closing.backgroundInert) throw new Error("memory exit is immediate instead of animated");
      await waitForEval("!document.getElementById('openbot-memory-dialog') && !document.getElementById('root').inert");
      await waitForEval("document.activeElement?.dataset.action === 'open-memory-manager'");
      await evalExpr("document.querySelector('[data-action=\"open-memory-manager\"]').click()");
      await waitForEval("Boolean(document.getElementById('openbot-memory-dialog'))");
      const earlyClose = await evalExpr(`(() => {
        const root = document.getElementById('openbot-memory-dialog');
        root.querySelector('[data-action="close-dialog"]').click();
        return root.isConnected && root.querySelector('.ob-panel').getAnimations().length === 0;
      })()`);
      if (!earlyClose) throw new Error("memory entrance kept moving during exit");
      await waitForEval("!document.getElementById('openbot-memory-dialog') && !document.getElementById('root').inert");
      for (const method of ["escape", "backdrop"]) {
        await openMemory();
        await evalExpr(`(() => {
          const root = document.getElementById('openbot-memory-dialog');
          if (${JSON.stringify(method)} === 'escape') root.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));
          else root.querySelector('.ob-dialog-backdrop').dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
          root.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));
        })()`);
        await waitForEval("!document.getElementById('openbot-memory-dialog') && !document.getElementById('root').inert");
        await waitForEval("document.activeElement?.dataset.action === 'open-memory-manager'");
      }
      await openMemory();
      await evalExpr(`(() => {
        window.__closingMemory = document.getElementById('openbot-memory-dialog');
        window.__closingMemory.querySelector('[data-action="close-dialog"]').click();
        document.querySelector('[data-action="open-memory-manager"]').click();
      })()`);
      await waitForEval("Boolean(document.getElementById('openbot-memory-dialog')) && document.getElementById('openbot-memory-dialog') !== window.__closingMemory");
      await sleep(240);
      if (!await evalExpr("!window.__closingMemory.isConnected && document.querySelectorAll('#openbot-memory-dialog').length === 1 && document.getElementById('root').inert")) throw new Error("old dialog callback affected replacement");
      await shot("visual-memory-reopened");
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      const reducedClose = await evalExpr(`(() => { document.querySelector('#openbot-memory-dialog [data-action="close-dialog"]').click(); return !document.getElementById('openbot-memory-dialog') && !document.getElementById('root').inert; })()`);
      if (!reducedClose) throw new Error("reduced memory close was delayed");
      await send("Emulation.setEmulatedMedia", { features: [] });
      await openMemory();
      const cleaned = await evalExpr(`(() => {
        document.querySelector('#openbot-memory-dialog [data-action="close-dialog"]').click();
        window.dispatchEvent(new Event('pagehide'));
        return !document.getElementById('openbot-memory-dialog') && !document.getElementById('root').inert;
      })()`);
      if (!cleaned) throw new Error("memory close cleanup left an inert application");
      await sleep(180);
      console.log("MEMORY_CLOSE GREEN");
      ws.close();
      return;
    }
    if (process.argv.includes("--create-only")) {
      await verifyCreateFlow();
      console.log("CREATE_ONLY GREEN");
      console.log("VISUAL_EVIDENCE_DIR", evidenceDir);
      ws.close();
      return;
    }
    const localAccountClick = await evalExpr(`(() => {
      document.getElementById("openbot-visual-local-account")?.remove();
      const fixture = document.createElement("section");
      fixture.id = "openbot-visual-local-account";
      fixture.style.cssText = "position:fixed;left:24px;bottom:24px;width:320px;padding:12px;background:#181818;color:#fff;z-index:2147482000";
      fixture.innerHTML = '<button type="button" aria-label="Open account menu">OpenBot local</button><button type="button" aria-label="New">New</button><span data-placeholder="Sign in to Cursor in settings, then ask anything.">Sign in to Cursor in settings, then ask anything.</span><input aria-label="Composer placeholder fixture" placeholder="Sign in to Cursor in settings, then ask anything"><div aria-placeholder="Sign in to Cursor in settings, then ask anything."></div><div id="openbot-visual-local-dialog" role="dialog" aria-modal="true" hidden><div><div>OpenBot Local</div><div>local@openbot.invalid</div><button type="button">Sign out</button></div></div>';
      fixture.querySelector('[aria-label="Open account menu"]')?.addEventListener("click", () => {
        fixture.querySelector("#openbot-visual-local-dialog")?.removeAttribute("hidden");
      });
      fixture.querySelector('[aria-label="New"]')?.addEventListener("click", () => {
        fixture.querySelector("#openbot-visual-local-dialog")?.remove();
      });
      document.body.prepend(fixture);
      window.__openbotVisualGetProviderConfig = window.desktop.agent.getProviderConfig;
      window.desktop.agent.getProviderConfig = async () => ({});
      fixture.querySelector('[aria-label="Open account menu"]')?.click();
      for (let index = 1; index <= 4; index += 1) {
        setTimeout(() => {
          const pulse = document.createElement("i");
          fixture.appendChild(pulse);
          pulse.remove();
        }, index * 40);
      }
      return { clicked: true, cursorComposerCopy: true };
    })()`);
    await sleep(240);
    const localAccountState = await evalExpr(`(() => {
      const profile = document.getElementById("openbot-local-profile");
      const legacyCopy = /Sign in to Cursor in settings/i;
      const composerCopy = [...document.querySelectorAll('[data-placeholder], [aria-placeholder], [placeholder]')]
        .flatMap((element) => ["data-placeholder", "aria-placeholder", "placeholder"].map((attribute) => element.getAttribute(attribute) || ""));
      return {
        profileVisible: Boolean(profile && profile.getClientRects().length),
        cursorComposerCopy: composerCopy.some((value) => legacyCopy.test(value)) || legacyCopy.test(document.body?.innerText || ""),
      };
    })()`);
    console.log("LOCAL_ACCOUNT_CLICK", JSON.stringify(localAccountClick));
    console.log("LOCAL_ACCOUNT_STATE", JSON.stringify(localAccountState));
    await evalExpr(`(() => {
      window.desktop.agent.getProviderConfig = window.__openbotVisualGetProviderConfig;
      delete window.__openbotVisualGetProviderConfig;
      document.getElementById("openbot-visual-local-account")?.remove();
      return true;
    })()`);
    if (!localAccountClick.clicked || !localAccountClick.cursorComposerCopy || !localAccountState.profileVisible || localAccountState.cursorComposerCopy) {
      throw new Error(`OpenBot local account settings regression: ${JSON.stringify({ localAccountClick, localAccountState })}`);
    }
    await evalExpr(`(() => {
      const fixture = document.createElement("div");
      fixture.id = "openbot-visual-global-settings";
      fixture.style.cssText = "position:fixed;inset:0;z-index:2147482000;display:grid;place-items:center;background:#111";
      fixture.innerHTML = '<div role="dialog" aria-label="OpenBot settings" style="max-height:90vh;overflow:auto;border-radius:14px;padding:28px;background:#181818"><section id="sand-settings-panel-general" style="width:760px"><h2>General</h2><h3>Account</h3><div id="openbot-visual-native-cursor" role="status" style="display:flex;align-items:center;justify-content:space-between;padding:16px"><span>Cursor</span><button type="button">Sign In with Cursor</button></div><h3>Appearance</h3><h3>Elon-Only Settings</h3><div><span>Model</span><button type="button">Grok 4.6</button></div><span id="openbot-visual-cursor-composer">Sign in to Cursor in settings, then ask anything.</span></section></div>';
      document.body.appendChild(fixture);
      window.__openbotLocalSettingsScan?.();
      return true;
    })()`);
    await waitForEval("Boolean(document.getElementById('openbot-provider-settings')?.getClientRects().length) && document.getElementById('openbot-visual-native-cursor')?.getAttribute('data-openbot-hide') === '1'");
    const globalProviderState = await evalExpr(`(() => {
      const root = document.getElementById("openbot-provider-settings");
      const legacy = document.getElementById("openbot-visual-native-cursor");
      const providerRow = root?.querySelector(".ob-field-row");
      const labelRect = providerRow?.querySelector("label")?.getBoundingClientRect();
      // Global scope renders a custom trigger and visually hides the native select; measure the visible control.
      const providerControl = providerRow?.querySelector(".ob-select-trigger") || providerRow?.querySelector("select");
      const selectRect = providerControl?.getBoundingClientRect();
      const selectStyle = providerControl ? getComputedStyle(providerControl) : null;
      const saveRect = root?.querySelector("#openbot-save")?.getBoundingClientRect();
      const rootStyle = root ? getComputedStyle(root) : null;
      const cardStyle = root ? getComputedStyle(root.querySelector(".ob-provider-card")) : null;
      return {
        visible: Boolean(root?.getClientRects().length),
        scope: root?.dataset.scope || null,
        providers: [...(root?.querySelectorAll("#openbot-provider option") || [])].map((option) => option.textContent),
        authAction: Boolean(root?.querySelector("#openbot-auth-action")),
        legacyCursorHidden: legacy?.getAttribute("data-openbot-hide") === "1",
        cursorComposerCopy: /Sign in to Cursor in settings/i.test(document.getElementById("openbot-visual-cursor-composer")?.textContent || ""),
        replacedNativeSurface: root?.nextElementSibling === legacy,
        flatRoot: Boolean(rootStyle && rootStyle.backgroundColor === "rgba(0, 0, 0, 0)" && rootStyle.borderRadius === "0px" && rootStyle.boxShadow === "none"),
        // Global scope groups the provider fields in one tertiary card (polish 2026-08-30): no shadow, 14px radius, opaque background.
        nestedCardRemoved: cardStyle?.boxShadow === "none" && cardStyle.borderRadius === "14px" && cardStyle.backgroundColor !== "rgba(0, 0, 0, 0)",
        providerRowAligned: Boolean(labelRect && selectRect && Math.abs((labelRect.top + labelRect.bottom - selectRect.top - selectRect.bottom) / 2) < 4),
        providerControlHeight: selectRect?.height || 0,
        providerControlRadius: selectStyle?.borderRadius || null,
        saveButtonHeight: saveRect?.height || 0,
      };
    })()`);
    console.log("GLOBAL_PROVIDER_SETTINGS", JSON.stringify(globalProviderState));
    if (!globalProviderState.visible || globalProviderState.scope !== "global" || globalProviderState.providers.join("|") !== "xAI|OpenAI Codex|OpenCode Go" || !globalProviderState.authAction || !globalProviderState.legacyCursorHidden || globalProviderState.cursorComposerCopy || !globalProviderState.replacedNativeSurface || !globalProviderState.flatRoot || !globalProviderState.nestedCardRemoved || !globalProviderState.providerRowAligned || Math.abs(globalProviderState.providerControlHeight - 30) > 1 || globalProviderState.providerControlRadius !== "6px" || Math.abs(globalProviderState.saveButtonHeight - 30) > 1) {
      throw new Error(`OpenBot global provider settings regression: ${JSON.stringify(globalProviderState)}`);
    }
    await shot("visual-global-settings");
    await evalExpr('document.getElementById("openbot-visual-global-settings")?.remove()');
    await evalExpr(`(() => {
      localStorage.removeItem("openbot.profile.name.v1");
      const visualProfile = { name: "OpenBot Local", avatarId: "openbot-default", avatarShape: "circle", avatarColor: "#52525b" };
      let profileReadCount = 0;
      window.__openbotLocalProfileAgent = {
        getLocalProfile: async () => {
          const snapshot = { ...visualProfile };
          if (profileReadCount++ === 0) await new Promise((resolve) => setTimeout(resolve, 120));
          return snapshot;
        },
        updateLocalProfile: async (patch) => {
          Object.assign(visualProfile, patch);
          if (patch.avatarPngBase64 === null) delete visualProfile.avatarPngBase64;
          return { ...visualProfile };
        },
      };
      document.getElementById("openbot-visual-profile-fixture")?.remove();
      const appRoot = document.getElementById("root");
      if (appRoot) {
        appRoot.dataset.openbotVisualVisibility = appRoot.style.visibility || "";
        appRoot.style.visibility = "hidden";
      }
      const fixture = document.createElement("section");
      fixture.id = "openbot-visual-profile-fixture";
      fixture.style.cssText = "position:fixed;left:50%;top:50%;width:min(560px,calc(100vw - 48px));transform:translate(-50%,-50%);box-sizing:border-box;padding:20px;background:var(--cursor-bg-secondary,#181818);color:var(--cursor-text-primary,#fff);border:1px solid var(--cursor-stroke-secondary,#363636);border-radius:16px;z-index:2147483000";
      fixture.innerHTML = '<div style="margin-bottom:10px;font-weight:600">Account</div><div id="openbot-visual-legacy-account" style="padding:14px;border-radius:10px;background:#222"><div>OpenBot Local</div><div>local@openbot.invalid</div><button type="button">Sign out</button></div><div id="openbot-visual-sidebar-name" style="margin-top:14px">OpenBot Local</div><div class="sand-agents-sidebar__account" style="margin-top:14px"><button class="sand-agents-sidebar__account-name" type="button"><span>Enter your name</span><span aria-hidden="true">✎</span></button></div><div id="openbot-visual-signout-dialog" role="dialog" aria-modal="true"><h2>Sign out?</h2><p>You’ll need to sign in again to use your Cursor account with OpenBot.</p><button id="openbot-visual-cancel" type="button">Cancel</button><button type="button">Sign out</button></div>';
      fixture.querySelector("#openbot-visual-cancel")?.addEventListener("click", (event) => event.currentTarget.dataset.clicked = "1");
      document.body.appendChild(fixture);
      window.__openbotLocalSettingsScan?.();
      return true;
    })()`);
    await waitForEval("document.getElementById('openbot-profile-name')?.value === 'OpenBot Local'");
    const profileInitial = await evalExpr(`(() => {
      const root = document.getElementById("openbot-local-profile");
      const input = document.getElementById("openbot-profile-name");
      const legacy = document.getElementById("openbot-visual-legacy-account");
      const dialog = document.getElementById("openbot-visual-signout-dialog");
      const cancel = document.getElementById("openbot-visual-cancel");
      const save = document.getElementById("openbot-profile-save");
      const avatar = document.getElementById("openbot-profile-avatar");
      const inputStyle = input ? getComputedStyle(input) : null;
      const saveStyle = save ? getComputedStyle(save) : null;
      const visibleSignOut = [...document.querySelectorAll("button, [role='button'], [role='menuitem']")].some((el) => /^(Sign out|Log out|Sair)$/i.test((el.textContent || "").trim()) && el.getClientRects().length > 0);
      return {
        profileVisible: Boolean(root && root.getClientRects().length),
        input: input?.value,
        legacyHidden: legacy?.getAttribute("data-openbot-hide") === "1",
        dialogHidden: dialog?.getAttribute("data-openbot-hide") === "1",
        cancelClicked: cancel?.dataset.clicked === "1",
        visibleSignOut,
        saveLabel: save?.textContent?.trim(),
        saveDisabled: save?.disabled === true,
        shapeButtons: root?.querySelectorAll("[data-avatar-shape]").length || 0,
        hasUpload: Boolean(root?.querySelector("#openbot-profile-avatar-file")),
        inputHeight: input?.getBoundingClientRect().height || 0,
        inputRadius: inputStyle?.borderRadius || null,
        saveHeight: save?.getBoundingClientRect().height || 0,
        saveRadius: saveStyle?.borderRadius || null,
        avatarSize: avatar?.getBoundingClientRect().width || 0,
      };
    })()`);
    console.log("PROFILE_INITIAL", JSON.stringify(profileInitial));
    if (!profileInitial.profileVisible || profileInitial.input !== "OpenBot Local" || !profileInitial.legacyHidden || !profileInitial.dialogHidden || !profileInitial.cancelClicked || profileInitial.visibleSignOut || profileInitial.saveLabel !== "Salvar" || !profileInitial.saveDisabled || profileInitial.shapeButtons !== 3 || !profileInitial.hasUpload || Math.abs(profileInitial.inputHeight - 30) > 1 || profileInitial.inputRadius !== "6px" || Math.abs(profileInitial.saveHeight - 30) > 1 || profileInitial.saveRadius !== "6px" || Math.abs(profileInitial.avatarSize - 36) > 1) {
      throw new Error(`OpenBot local profile initial state failed: ${JSON.stringify(profileInitial)}`);
    }
    await evalExpr(`(() => {
      const input = document.getElementById("openbot-profile-name");
      if (!input) return false;
      input.value = "Thiago OpenBot";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector('[data-avatar-shape="rounded"]')?.click();
      document.querySelector('[data-avatar-color="#7c3aed"]')?.click();
      document.getElementById("openbot-profile-form")?.requestSubmit();
      return true;
    })()`);
    await waitForEval("/Perfil salvo/.test(document.getElementById('openbot-profile-status')?.textContent || '') && document.getElementById('openbot-profile-save')?.disabled === true");
    const profileSaved = await evalExpr(`(async () => ({
      legacyStorage: localStorage.getItem("openbot.profile.name.v1"),
      persisted: await window.__openbotLocalProfileAgent.getLocalProfile(),
      input: document.getElementById("openbot-profile-name")?.value,
      initials: document.getElementById("openbot-profile-avatar")?.textContent,
      shape: document.getElementById("openbot-profile-avatar")?.dataset.shape,
      status: document.getElementById("openbot-profile-status")?.textContent,
      saveLabel: document.getElementById("openbot-profile-save")?.textContent?.trim(),
      saveDisabled: document.getElementById("openbot-profile-save")?.disabled === true,
      sidebar: document.getElementById("openbot-visual-sidebar-name")?.textContent,
    }))()`);
    console.log("PROFILE_SAVED", JSON.stringify(profileSaved));
    if (profileSaved.legacyStorage !== null || profileSaved.persisted?.name !== "Thiago OpenBot" || profileSaved.persisted?.avatarShape !== "rounded" || profileSaved.persisted?.avatarColor !== "#7c3aed" || profileSaved.input !== "Thiago OpenBot" || profileSaved.initials !== "TO" || profileSaved.shape !== "rounded" || !/Perfil salvo/.test(profileSaved.status || "") || profileSaved.saveLabel !== "Salvo" || !profileSaved.saveDisabled || profileSaved.sidebar !== "Thiago OpenBot") {
      throw new Error(`OpenBot local profile persistence failed: ${JSON.stringify(profileSaved)}`);
    }
    const footerProfileSaved = await evalExpr(`(async () => {
      const control = document.querySelector(".sand-agents-sidebar__account-name");
      control?.click();
      const input = document.querySelector("#openbot-footer-profile-editor input");
      if (!input) return { editorOpened: false };
      input.value = "Thiago Emanuel Veloso Santos";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("openbot-footer-profile-editor")?.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const nativeLabel = document.querySelector(".sand-agents-sidebar__account-name span");
      if (nativeLabel) nativeLabel.textContent = "OpenBot local";
      window.__openbotLocalSettingsScan?.();
      let syncMutations = 0;
      const observer = new MutationObserver((records) => { syncMutations += records.length; });
      for (const target of [document.getElementById("openbot-local-profile"), document.querySelector(".sand-agents-sidebar__account")]) {
        if (target) observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true });
      }
      for (let index = 0; index < 5; index += 1) window.__openbotLocalSettingsScan?.();
      await new Promise((resolve) => setTimeout(resolve, 160));
      observer.disconnect();
      return {
        editorOpened: true,
        editorClosed: !document.getElementById("openbot-footer-profile-editor"),
        persisted: await window.__openbotLocalProfileAgent.getLocalProfile(),
        footer: document.querySelector(".sand-agents-sidebar__account-name")?.textContent?.replace(/✎/g, "").trim(),
        settingsInput: document.getElementById("openbot-profile-name")?.value,
        syncMutations,
      };
    })()`);
    console.log("FOOTER_PROFILE_SAVED", JSON.stringify(footerProfileSaved));
    if (!footerProfileSaved.editorOpened || !footerProfileSaved.editorClosed || footerProfileSaved.persisted?.name !== "Thiago Emanuel Veloso Santos" || footerProfileSaved.footer !== "Thiago Emanuel Veloso Santos" || footerProfileSaved.settingsInput !== "Thiago Emanuel Veloso Santos" || footerProfileSaved.syncMutations !== 0) {
      throw new Error(`OpenBot footer profile persistence failed: ${JSON.stringify(footerProfileSaved)}`);
    }
    await evalExpr(`(() => {
      document.getElementById("openbot-visual-sidebar-name")?.setAttribute("hidden", "");
      document.querySelector("#openbot-visual-profile-fixture .sand-agents-sidebar__account")?.setAttribute("hidden", "");
      return true;
    })()`);
    await shot("visual-profile");
    await evalExpr(`(() => {
      document.getElementById("openbot-visual-profile-fixture")?.remove();
      const appRoot = document.getElementById("root");
      if (appRoot) {
        appRoot.style.visibility = appRoot.dataset.openbotVisualVisibility || "";
        delete appRoot.dataset.openbotVisualVisibility;
      }
      localStorage.removeItem("openbot.profile.name.v1");
      delete window.__openbotLocalProfileAgent;
      return true;
    })()`);
    if (!settingsOnly) {
      await evalExpr(`(() => {
      const fixture = document.createElement("section");
      fixture.id = "openbot-unavailable-nav-fixture";
      fixture.innerHTML = '<button id="openbot-general-fixture" type="button">General</button><button type="button">Updates</button><button type="button">Help Center</button><button type="button">Send Feedback</button><div><h2>Updates</h2><div>Update Track</div><button type="button">Check for Updates</button></div>';
      fixture.querySelector("#openbot-general-fixture")?.addEventListener("click", (event) => { event.currentTarget.dataset.clicked = "1"; });
      document.body.appendChild(fixture);
      return true;
    })()`);
    await sleep(300);
    const unavailableNav = await evalExpr(`(() => {
      const fixture = document.getElementById("openbot-unavailable-nav-fixture");
      const visibleUnsupported = [...fixture.querySelectorAll("button")].filter((button) => /^(Updates|Help Center|Send Feedback)$/.test(button.textContent.trim()) && button.getClientRects().length > 0).map((button) => button.textContent.trim());
      return {
        visibleUnsupported,
        generalActivated: fixture.querySelector("#openbot-general-fixture")?.dataset.clicked === "1",
        updatePaneHidden: Boolean([...fixture.querySelectorAll("div")].find((el) => (el.textContent || "").trim() === "Update Track")?.closest('[data-openbot-hide="1"]')),
      };
    })()`);
    console.log("UNAVAILABLE_NAV", JSON.stringify(unavailableNav));
    if (unavailableNav.visibleUnsupported.length || !unavailableNav.generalActivated || !unavailableNav.updatePaneHidden) {
      throw new Error(`unsupported settings surfaces remained visible: ${JSON.stringify(unavailableNav)}`);
    }
      await evalExpr('document.getElementById("openbot-unavailable-nav-fixture")?.remove()');
    }
    await shot("visual-home");
    const nativeHomeUi = await evalExpr(`(() => {
      const row = [...document.querySelectorAll(".sand-agent-item[data-layout='expanded']")].find((element) => element.getClientRects().length > 0);
      const avatar = row?.querySelector(".sand-agent-item__avatar");
      const visibleBadges = [...(row?.querySelectorAll(".sand-agent-item__title-badge") || [])].filter((element) => element.getClientRects().length > 0);
      const composer = [...document.querySelectorAll("textarea, [contenteditable='true'], .sand-prompt-field")].find((element) => element.getClientRects().length > 0 && (element.getAttribute("aria-label") === "Prompt" || element.classList.contains("sand-prompt-field")));
      const shell = composer?.closest(".sand-prompt-shell") || composer?.parentElement;
      const placeholderNode = composer?.matches("[data-placeholder],[placeholder],[aria-placeholder]") ? composer : composer?.querySelector("[data-placeholder],[placeholder],[aria-placeholder]");
      const placeholderStyle = placeholderNode ? getComputedStyle(placeholderNode, "::before") : null;
      const placeholderRect = placeholderNode?.getBoundingClientRect();
      const shellRect = shell?.getBoundingClientRect();
      const placeholderColorParts = String(placeholderStyle?.color || "").match(/[0-9.]+/g)?.map(Number) || [];
      const attach = document.querySelector(".sand-prompt-attach");
      const sendButton = document.querySelector(".sand-prompt-send");
      const actionsRow = document.querySelector(".sand-prompt-actions-row");
      const actionsRect = actionsRow?.getBoundingClientRect();
      const header = document.querySelector(".sand-chat-header");
      return {
        rowHeight: row?.getBoundingClientRect().height || 0,
        rowRadius: row ? getComputedStyle(row).borderRadius : null,
        avatarSize: avatar?.getBoundingClientRect().width || 0,
        redundantBadgeCount: visibleBadges.filter((badge) => badge.textContent?.trim() === row?.querySelector(".sand-agent-item__name")?.textContent?.trim()).length,
        badgeState: [...(row?.querySelectorAll(".sand-agent-item__title-badge") || [])].map((badge) => ({ text: badge.textContent?.trim() || "", hidden: badge.hidden, localHidden: badge.getAttribute("data-openbot-hide"), display: getComputedStyle(badge).display })),
        composerPlaceholder: placeholderNode?.getAttribute("data-placeholder") || placeholderNode?.getAttribute("placeholder") || placeholderNode?.getAttribute("aria-placeholder") || "",
        composerPlaceholderVisual: placeholderStyle?.content || "",
        composerPlaceholderAlpha: placeholderColorParts[3] ?? 1,
        composerPlaceholderLeft: Number.parseFloat(placeholderStyle?.left || "0"),
        composerPlaceholderTopInset: placeholderRect && shellRect ? placeholderRect.top - shellRect.top : null,
        composerPlaceholderBottomInset: placeholderRect && shellRect ? shellRect.bottom - placeholderRect.bottom : null,
        composerPlaceholderBeforeActions: Boolean(placeholderRect && actionsRect && placeholderRect.bottom <= actionsRect.top - 12),
        composerHeight: composer?.getBoundingClientRect().height || 0,
        composerShellHeight: shellRect?.height || 0,
        composerActionsFit: Boolean(actionsRect && shellRect && actionsRect.top >= shellRect.top && actionsRect.bottom <= shellRect.bottom),
        composerActionsTopInset: actionsRect && shellRect ? actionsRect.top - shellRect.top : null,
        composerActionsBottomInset: actionsRect && shellRect ? shellRect.bottom - actionsRect.bottom : null,
        composerMinHeight: composer ? getComputedStyle(composer).minHeight : null,
        shellRadius: shell ? getComputedStyle(shell).borderRadius : null,
        attachSize: attach?.getBoundingClientRect().width || 0,
        sendSize: sendButton?.getBoundingClientRect().width || 0,
        headerHeight: header?.getBoundingClientRect().height || 0,
      };
    })()`);
    console.log("NATIVE_HOME_UI", JSON.stringify(nativeHomeUi));
    if (nativeHomeUi.rowHeight < 58 || nativeHomeUi.rowHeight > 60 || nativeHomeUi.rowRadius !== "10px" || Math.abs(nativeHomeUi.avatarSize - 34) > 1 || nativeHomeUi.redundantBadgeCount !== 0 || !/Escreva uma mensagem/i.test(nativeHomeUi.composerPlaceholderVisual) || nativeHomeUi.composerPlaceholderAlpha < 0.55 || nativeHomeUi.composerPlaceholderLeft < 1.5 || nativeHomeUi.composerPlaceholderLeft > 3 || nativeHomeUi.composerPlaceholderTopInset < 12 || nativeHomeUi.composerPlaceholderTopInset > 16 || !nativeHomeUi.composerPlaceholderBeforeActions || nativeHomeUi.composerHeight < 47 || nativeHomeUi.composerHeight > 50 || nativeHomeUi.composerShellHeight < 86 || nativeHomeUi.composerShellHeight > 94 || !nativeHomeUi.composerActionsFit || nativeHomeUi.composerActionsBottomInset < 7 || nativeHomeUi.composerMinHeight !== "48px" || nativeHomeUi.shellRadius !== "16px" || (nativeHomeUi.attachSize && Math.abs(nativeHomeUi.attachSize - 30) > 1) || (nativeHomeUi.sendSize && Math.abs(nativeHomeUi.sendSize - 30) > 1) || nativeHomeUi.headerHeight < 51) {
      throw new Error(`native home/sidebar/composer visual contract failed: ${JSON.stringify(nativeHomeUi)}`);
    }
    await verifyPastedImageComposer(nativeHomeUi.composerShellHeight);
    const initialSettingsClick = await evalExpr("(() => { const hit = [...document.querySelectorAll('[aria-label=\"View agent settings\"]')].find((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'); if (!hit) return { ok: false, visible: 0 }; hit.click(); return { ok: true }; })()");
    const nativeSettingsMotion = initialSettingsClick.ok ? await waitForMotion("#openbot-provider-settings") : null;
    if (nativeSettingsMotion) await waitForEval("(document.querySelector('[data-openbot-motion-surface=\"settings\"]') || document.getElementById('openbot-provider-settings'))?.getAnimations().length === 0");
    console.log("INITIAL_SETTINGS_CLICK", JSON.stringify(initialSettingsClick));
    console.log("INITIAL_SETTINGS_MOTION", JSON.stringify(nativeSettingsMotion));
    const initialSettingsState = await evalExpr(`(() => {
      const panel = document.getElementById("openbot-provider-settings");
      if (!panel) return { panel: null };
      const rect = panel.getBoundingClientRect();
      const advanced = panel.querySelector("#openbot-advanced");
        const provider = panel.querySelector("#openbot-provider");
        const save = panel.querySelector("#openbot-save");
        const host = panel.closest(".sand-agent-settings");
        const botInput = host?.querySelector("input:not([type='checkbox'])");
        const botDescription = host?.querySelector("textarea");
        const title = host?.closest(".sand-info-pane__nav-root")?.querySelector(".sand-info-pane__subpage-title");
        return { panel: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: rect.width > 0 && rect.height > 0 }, hasDocuments: /Abrir Documents/.test(panel.textContent || ""), hasProjects: /Abrir Projects/.test(panel.textContent || ""), hasAdvanced: Boolean(advanced), advancedOpen: Boolean(advanced?.open), providerHeight: provider?.getBoundingClientRect().height || 0, saveHeight: save?.getBoundingClientRect().height || 0, advancedRadius: advanced ? getComputedStyle(advanced).borderRadius : null, botInputHeight: botInput?.getBoundingClientRect().height || 0, botInputRadius: botInput ? getComputedStyle(botInput).borderRadius : null, botDescriptionPlaceholder: botDescription?.getAttribute("placeholder") || "", titleText: title?.textContent?.trim() || "", titleTruncated: title ? title.scrollWidth > title.clientWidth : null };
    })()`);
    console.log("INITIAL_SETTINGS", JSON.stringify(initialSettingsState, null, 2));
    await shot("visual-settings-native-open");
    const nativeSettingsContained = nativeSettingsMotion?.fits === true || (nativeSettingsMotion?.scrollHost?.fits === true && nativeSettingsMotion.scrollHost.scrollable === true && nativeSettingsMotion.scrollHost.horizontalContained === true);
    if (initialSettingsState.panel?.visible && (nativeSettingsMotion?.kind !== "settings" || nativeSettingsMotion.duration !== "180" || nativeSettingsMotion.runs !== "1" || !nativeSettingsContained || nativeSettingsMotion.transforms?.length !== 0)) {
      throw new Error(`native settings entrance motion failed: ${JSON.stringify(nativeSettingsMotion)}`);
    }
    let verifiedSettingsState = initialSettingsState;
    if (!verifiedSettingsState.panel?.visible) {
      await evalExpr(`(() => {
        document.getElementById("openbot-visual-settings-fixture")?.remove();
        const fixture = document.createElement("section");
        fixture.id = "openbot-visual-settings-fixture";
        fixture.style.cssText = "position:fixed;right:24px;top:24px;width:360px;max-height:calc(100vh - 48px);box-sizing:border-box;overflow:auto;padding:18px;background:#202020;color:#fff;border-radius:16px;z-index:2147482000";
        fixture.innerHTML = '<label>Name</label><input value="Visual Bot"><label>Description</label><textarea>Visual verification</textarea><label>Notifications</label><input type="checkbox">';
        (document.getElementById("root") || document.body).appendChild(fixture);
        const trigger = document.createElement("button");
        trigger.id = "openbot-visual-settings-trigger";
        trigger.setAttribute("aria-label", "View agent settings");
        trigger.setAttribute("aria-expanded", "true");
        trigger.setAttribute("aria-controls", fixture.id);
        trigger.style.cssText = "position:fixed;width:1px;height:1px;opacity:0";
        document.body.appendChild(trigger);
        trigger.click();
        window.__openbotLocalSettingsScan?.();
        return true;
      })()`);
      const fixtureMotion = await waitForMotion("#openbot-provider-settings");
      console.log("FIXTURE_SETTINGS_MOTION", JSON.stringify(fixtureMotion));
      if (fixtureMotion?.kind !== "settings" || fixtureMotion.duration !== "180" || fixtureMotion.runs !== "1" || fixtureMotion.transforms?.length !== 0) {
        throw new Error(`OpenBot settings entrance motion failed: ${JSON.stringify(fixtureMotion)}`);
      }
      await waitForEval("document.querySelector('[data-openbot-motion-surface=\"settings\"]')?.getAnimations().length === 0");
      const settledMotion = await waitForMotion("#openbot-provider-settings", 100);
      if (settledMotion?.runs !== "1" || settledMotion.activeAnimations !== 0) {
        throw new Error(`OpenBot settings motion duplicated or remained active: ${JSON.stringify(settledMotion)}`);
      }
      verifiedSettingsState = await evalExpr(`(() => {
        const panel = document.getElementById("openbot-provider-settings");
        if (!panel) return { panel: null };
        const rect = panel.getBoundingClientRect();
        const advanced = panel.querySelector("#openbot-advanced");
        const provider = panel.querySelector("#openbot-provider");
        const save = panel.querySelector("#openbot-save");
        return { panel: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: rect.width > 0 && rect.height > 0 }, hasDocuments: /Abrir Documents/.test(panel.textContent || ""), hasProjects: /Abrir Projects/.test(panel.textContent || ""), overflow: panel.scrollWidth > panel.clientWidth, hasAdvanced: Boolean(advanced), advancedOpen: Boolean(advanced?.open), providerHeight: provider?.getBoundingClientRect().height || 0, saveHeight: save?.getBoundingClientRect().height || 0, advancedRadius: advanced ? getComputedStyle(advanced).borderRadius : null };
      })()`);
      console.log("FIXTURE_SETTINGS", JSON.stringify(verifiedSettingsState, null, 2));
    }
    if (!verifiedSettingsState.panel?.visible || verifiedSettingsState.overflow || !verifiedSettingsState.hasDocuments || !verifiedSettingsState.hasProjects || !verifiedSettingsState.hasAdvanced || verifiedSettingsState.advancedOpen || Math.abs(verifiedSettingsState.providerHeight - 30) > 1 || Math.abs(verifiedSettingsState.saveHeight - 30) > 1 || verifiedSettingsState.advancedRadius !== "6px" || (verifiedSettingsState.botInputHeight && (verifiedSettingsState.botInputHeight < 30 || verifiedSettingsState.botInputHeight > 36)) || (verifiedSettingsState.botInputRadius && verifiedSettingsState.botInputRadius !== "6px") || (verifiedSettingsState.botDescriptionPlaceholder && verifiedSettingsState.botDescriptionPlaceholder !== "Descreva a função deste bot") || verifiedSettingsState.titleTruncated === true) {
      throw new Error(`OpenBot settings panel failed visual verification: ${JSON.stringify(verifiedSettingsState)}`);
    }
    const neutralPrimary = await evalExpr(`(() => {
      const button = document.getElementById("openbot-save");
      if (!button) return null;
      button.disabled = false;
      const style = getComputedStyle(button);
      return { background: style.backgroundColor, color: style.color };
    })()`);
    console.log("NEUTRAL_PRIMARY", JSON.stringify(neutralPrimary));
    if (!neutralPrimary || neutralPrimary.background === "rgb(89, 156, 231)" || neutralPrimary.background === "rgb(0, 122, 204)") {
      throw new Error(`OpenBot primary action still uses a blue accent: ${JSON.stringify(neutralPrimary)}`);
    }
    await shot("visual-settings-initial");
    const advancedOpened = await evalExpr(`(() => {
      const advanced = document.getElementById("openbot-advanced");
      if (!advanced) return false;
      advanced.open = true;
      return advanced.open;
    })()`);
    if (!advancedOpened) throw new Error("advanced settings did not open");
    const advancedMotion = await waitForMotion("#openbot-advanced .ob-advanced-body");
    await waitForEval("document.querySelector('#openbot-advanced .ob-advanced-body')?.getAnimations().length === 0");
    const advancedMotionSettled = await waitForMotion("#openbot-advanced .ob-advanced-body", 100);
    console.log("SETTINGS_ADVANCED_MOTION", JSON.stringify({ entering: advancedMotion, settled: advancedMotionSettled }));
    if (advancedMotion?.kind !== "disclosure" || advancedMotion.duration !== "160" || advancedMotion.runs !== "1" || advancedMotionSettled?.activeAnimations !== 0) {
      throw new Error(`advanced settings disclosure motion failed: ${JSON.stringify({ entering: advancedMotion, settled: advancedMotionSettled })}`);
    }
    await shot("visual-settings-expanded");
    const focusSeeded = await evalExpr(`(() => {
      const provider = document.getElementById("openbot-provider");
      provider?.focus();
      return document.activeElement === provider;
    })()`);
    if (!focusSeeded) throw new Error("settings provider control could not receive keyboard focus");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await waitForEval("document.activeElement?.id === 'openbot-auth-action'");
    const keyboardFocus = await evalExpr(`(() => {
      const active = document.activeElement;
      const style = active ? getComputedStyle(active) : null;
      return { id: active?.id || null, outlineStyle: style?.outlineStyle || null, outlineWidth: style?.outlineWidth || null };
    })()`);
    console.log("SETTINGS_KEYBOARD_FOCUS", JSON.stringify(keyboardFocus));
    if (keyboardFocus.id !== "openbot-auth-action" || keyboardFocus.outlineStyle === "none" || keyboardFocus.outlineWidth === "0px") {
      throw new Error(`settings keyboard focus failed: ${JSON.stringify(keyboardFocus)}`);
    }
    await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 640, deviceScaleFactor: 1, mobile: false });
    await waitForEval("innerWidth === 820 && innerHeight === 640");
    const resizedState = await evalExpr(`(() => {
      const panel = document.getElementById("openbot-provider-settings")?.closest('[data-openbot-motion-surface="settings"]') || document.getElementById("openbot-provider-settings");
      if (!panel) return null;
      const rect = panel.getBoundingClientRect();
      let scrollHost = panel.parentElement;
      while (scrollHost && scrollHost !== document.body) {
        const style = getComputedStyle(scrollHost);
        if (/(auto|scroll)/.test(style.overflowY) && scrollHost.scrollHeight > scrollHost.clientHeight) break;
        scrollHost = scrollHost.parentElement;
      }
      const hostRect = scrollHost?.getBoundingClientRect?.() || null;
      const details = document.getElementById("sand-conversation-details");
      const detailsRect = details?.getBoundingClientRect?.() || null;
      const provider = document.getElementById("openbot-provider-settings");
      const active = document.activeElement;
      return {
        innerWidth,
        innerHeight,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        fits: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        scrollHostFits: hostRect ? hostRect.left >= 0 && hostRect.top >= 0 && hostRect.right <= innerWidth && hostRect.bottom <= innerHeight : false,
        scrollable: Boolean(scrollHost && scrollHost.scrollHeight > scrollHost.clientHeight),
        horizontalContained: hostRect ? rect.left >= hostRect.left - 1 && rect.right <= hostRect.right + 1 : false,
        details: detailsRect ? { left: detailsRect.left, top: detailsRect.top, right: detailsRect.right, bottom: detailsRect.bottom, width: detailsRect.width, height: detailsRect.height, fits: detailsRect.left >= 0 && detailsRect.top >= 0 && detailsRect.right <= innerWidth && detailsRect.bottom <= innerHeight } : null,
        providerVisible: Boolean(provider && getComputedStyle(provider).display !== "none" && provider.getBoundingClientRect().width >= 280),
        detailsHidden: details?.getAttribute("aria-hidden") === "true" || Boolean(details?.inert),
        hiddenFocus: Boolean(active instanceof HTMLElement && active.closest('[aria-hidden="true"],[inert]')),
      };
    })()`);
    console.log("SETTINGS_RESIZED", JSON.stringify(resizedState));
    if (!(resizedState?.fits || (resizedState?.scrollHostFits && resizedState?.scrollable && resizedState?.horizontalContained)) || !resizedState?.details?.fits || resizedState.details.width < 340 || resizedState.details.width > 361 || !resizedState.providerVisible || resizedState.detailsHidden || resizedState?.hiddenFocus) throw new Error(`settings panel overflowed, disappeared, or retained hidden focus after window resize: ${JSON.stringify(resizedState)}`);
    await shot("visual-settings-resized");
    await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    await waitForEval("innerWidth === 1024 && innerHeight === 768");
    if (initialSettingsState.panel?.visible) {
      const nativeNameFocused = await evalExpr(`(() => {
        const input = document.querySelector('.sand-agent-settings input:not([type="checkbox"])');
        input?.focus();
        input?.select?.();
        return Boolean(input && document.activeElement === input);
      })()`);
      if (!nativeNameFocused) throw new Error("existing bot name field could not receive focus");
      await send("Input.insertText", { text: "Local User Revisado" });
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      let sidebarRenamedFromSettings = false;
      const settingsRenameDeadline = Date.now() + 5000;
      while (Date.now() < settingsRenameDeadline) {
        sidebarRenamedFromSettings = await evalExpr(`[...document.querySelectorAll('.sand-agent-item__name')].some((element) => element.textContent?.trim() === 'Local User Revisado')`);
        if (sidebarRenamedFromSettings) break;
        await sleep(100);
      }
      if (!sidebarRenamedFromSettings) throw new Error("existing bot name edit from Settings did not reach the sidebar");
      await evalExpr(`(() => { const close = [...document.querySelectorAll('button')].find((element) => /^(Close details|Fechar detalhes)$/i.test(element.getAttribute('aria-label') || '')); close?.click(); return Boolean(close); })()`);
      await waitForEval("!document.getElementById('openbot-provider-settings')?.getClientRects().length");
      await waitForEval(`(() => {
        const toggle = [...document.querySelectorAll('[aria-label="View agent settings"]')].find((element) => element.getClientRects().length > 0);
        const details = document.getElementById("sand-conversation-details");
        const detailsVisible = Boolean(details?.getClientRects().length && getComputedStyle(details).visibility !== "hidden");
        const legacyScreenVisible = [...document.querySelectorAll("[class*='computer'], [class*='screen']")]
          .some((element) => element.getClientRects().length > 0 && /Can't reach .+ screen|.+['’]s screen/i.test((element.textContent || "").replace(/\s+/g, " ").trim()));
        return toggle?.getAttribute("aria-expanded") === "false" && !detailsVisible && !legacyScreenVisible;
      })()`, 4000);
      await shot("visual-settings-closed");
      await evalExpr(`(() => { const open = [...document.querySelectorAll('[aria-label="View agent settings"]')].find((element) => element.getClientRects().length > 0); open?.click(); return Boolean(open); })()`);
      await waitForEval("Boolean(document.getElementById('openbot-provider-settings')?.getClientRects().length)");
      const persistedName = await evalExpr(`document.querySelector('.sand-agent-settings input:not([type="checkbox"])')?.value || ''`);
      if (persistedName !== "Local User Revisado") throw new Error(`existing bot name did not persist after Settings reopen: ${persistedName}`);
      const restoreFocused = await evalExpr(`(() => { const input = document.querySelector('.sand-agent-settings input:not([type="checkbox"])'); input?.focus(); input?.select?.(); return Boolean(input && document.activeElement === input); })()`);
      if (!restoreFocused) throw new Error("existing bot name field could not be focused for restoration");
      await send("Input.insertText", { text: "Local User" });
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      let restoredName = false;
      const settingsRestoreDeadline = Date.now() + 5000;
      while (Date.now() < settingsRestoreDeadline) {
        restoredName = await evalExpr(`[...document.querySelectorAll('.sand-agent-item__name')].some((element) => element.textContent?.trim() === 'Local User')`);
        if (restoredName) break;
        await sleep(100);
      }
      console.log("BOT_SETTINGS_NAME_PERSISTENCE", JSON.stringify({ persistedName, restoredName }));
      if (!restoredName) throw new Error("existing bot name could not be restored after persistence verification");
    }
    if (settingsOnly) {
      await evalExpr(`(() => {
        const agent = { ...window.desktop.agent };
        const state = { agentId: "bot-settings-persist", provider: "xai", model: "grok-4.6", reasoningEffort: "medium", saves: [] };
        window.__openbotVisualProviderPersistence = { state };
        agent.getProviderConfig = async () => ({ agentId: state.agentId, provider: state.provider, model: state.model, reasoningEffort: state.reasoningEffort });
        agent.setProviderConfig = async (patch) => {
          state.saves.push({ ...patch });
          state.provider = patch.provider;
          state.model = patch.model;
          state.reasoningEffort = patch.reasoningEffort;
          return { agentId: state.agentId, provider: state.provider, model: state.model, reasoningEffort: state.reasoningEffort };
        };
        agent.getAvailableModels = async () => ({ models: [
          { name: "grok-4.6", clientDisplayName: "Grok 4.6", vendorName: "xai" },
          { name: "gpt-5.6-luna", clientDisplayName: "GPT-5.6 Luna", vendorName: "openai" },
          { name: "gpt-5.6-terra", clientDisplayName: "GPT-5.6 Terra", vendorName: "openai" },
        ] });
        agent.getProviderOAuthStatus = async (provider) => ({ provider, state: "connected" });
        agent.getProviderSecretsStatus = async () => ({ keys: [] });
        agent.getWorkspaceInventory = async () => ({ entries: [] });
        agent.getLocalRuntimeStatus = async () => ({ state: "lite-ready" });
        window.__openbotLocalSettingsDesktop = { ...window.desktop, agent };
        document.getElementById("openbot-provider-settings")?.remove();
        document.getElementById("openbot-visual-settings-fixture")?.remove();
        document.getElementById("openbot-visual-settings-trigger")?.remove();
        document.getElementById("openbot-visual-settings-persistence")?.remove();
        const fixture = document.createElement("aside");
        fixture.id = "openbot-visual-settings-persistence";
        fixture.setAttribute("aria-label", "Conversation details");
        fixture.style.cssText = "position:fixed;right:16px;top:16px;width:340px;height:calc(100vh - 32px);z-index:2147483200;overflow:hidden;background:var(--cursor-bg-editor,#181818);border:1px solid var(--cursor-stroke-secondary,#353535);color:var(--cursor-text-primary,#fff)";
        fixture.innerHTML = '<div class="sand-info-pane__nav-root" style="display:flex;height:100%;flex-direction:column"><header class="sand-info-pane__top" style="display:flex;align-items:center"><span class="sand-info-pane__back"><button type="button" aria-label="Back to details">&lsaquo;</button></span><span class="sand-info-pane__subpage-title">Settings</span><span style="flex:1"></span><span class="sand-info-pane__actions"><button type="button" aria-label="Close details">&times;</button></span></header><div class="sand-info-pane__section-content" style="overflow:auto"><div class="sand-agent-settings"><div style="display:grid;place-items:center;height:64px"><span style="display:grid;width:52px;height:52px;place-items:center;border-radius:14px;background:#7c3aed">OB</span></div><div>Name</div><input aria-label="Agent name" value="Orquestrador"><div>Title</div><input aria-label="Agent title" value="Orquestrador"><div>Description</div><textarea aria-label="Agent description">Coordena os demais bots</textarea><div class="sand-agent-settings__card"><div class="sand-agent-settings__row"><span class="sand-agent-settings__text"><strong>Notifications</strong><small>Get notified when this agent finishes or needs input</small></span><span class="sand-agent-settings__control"><input type="checkbox" aria-label="Notifications"></span></div></div></div></div></div>';
        document.body.appendChild(fixture);
        window.__openbotLocalSettingsScan?.();
        return true;
      })()`);
      await waitForEval("Boolean(document.querySelector('#openbot-visual-settings-persistence #openbot-provider-settings')) && !document.getElementById('openbot-whatsapp')");
      const providerSaved = await evalExpr(`(async () => {
        const provider = document.getElementById("openbot-provider");
        const model = document.getElementById("openbot-model");
        const save = document.getElementById("openbot-save");
        if (!provider || !model || !save) return { mounted: false };
        provider.value = "openai";
        provider.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 40));
        model.value = "gpt-5.6-terra";
        const reasoning = document.getElementById("openbot-reasoning");
        reasoning.value = "high";
        save.click();
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          mounted: true,
          saved: window.__openbotVisualProviderPersistence.state.saves.at(-1),
          whatsappAbsent: !document.getElementById("openbot-whatsapp"),
          status: document.getElementById("openbot-status")?.textContent || "",
        };
      })()`);
      await evalExpr(`(() => {
        document.getElementById("openbot-provider-settings")?.remove();
        document.getElementById("openbot-visual-settings-persistence")?.append(document.createTextNode(""));
        window.__openbotLocalSettingsScan?.();
        return true;
      })()`);
      await waitForEval("document.querySelector('#openbot-visual-settings-persistence #openbot-provider-settings')?.dataset.agentId === 'bot-settings-persist'");
      const providerReopened = await evalExpr(`(() => {
        const root = document.getElementById("openbot-provider-settings");
        const header = document.querySelector("#openbot-visual-settings-persistence .sand-info-pane__top");
        const card = document.querySelector("#openbot-visual-settings-persistence .sand-agent-settings__card");
        const host = document.querySelector("#openbot-visual-settings-persistence .sand-agent-settings");
        const headerStyle = header ? getComputedStyle(header) : null;
        const cardStyle = card ? getComputedStyle(card) : null;
        const hostStyle = host ? getComputedStyle(host) : null;
        return {
          mounted: Boolean(root),
          agentId: root?.dataset.agentId || null,
          provider: root?.querySelector("#openbot-provider")?.value || null,
          model: root?.querySelector("#openbot-model")?.value || null,
          reasoningEffort: root?.querySelector("#openbot-reasoning")?.value || null,
          whatsappAbsent: !root?.querySelector("#openbot-whatsapp"),
          advancedHelp: root?.querySelector(".ob-advanced-help")?.textContent?.trim() || null,
          advancedSections: [...(root?.querySelectorAll(".ob-advanced-section .ob-section-title") || [])].map((element) => element.textContent?.trim() || ""),
          headerHeight: header?.getBoundingClientRect().height || 0,
          headerBorder: headerStyle?.borderBottomWidth || null,
          headerBackground: headerStyle?.backgroundColor || null,
          hostGap: hostStyle?.gap || null,
          hostPadding: hostStyle?.padding || null,
          cardRadius: cardStyle?.borderRadius || null,
          cardBackground: cardStyle?.backgroundColor || null,
          cardBorder: cardStyle?.borderTopWidth || null,
        };
      })()`);
      console.log("PROVIDER_SETTINGS_PERSISTENCE", JSON.stringify({ saved: providerSaved, reopened: providerReopened }));
      if (!providerSaved.mounted || !providerSaved.whatsappAbsent || providerSaved.saved?.agentId !== "bot-settings-persist" || providerSaved.saved?.provider !== "openai" || providerSaved.saved?.model !== "gpt-5.6-terra" || providerSaved.saved?.reasoningEffort !== "high" || !providerReopened.mounted || providerReopened.agentId !== "bot-settings-persist" || providerReopened.provider !== "openai" || providerReopened.model !== "gpt-5.6-terra" || providerReopened.reasoningEffort !== "high" || !providerReopened.whatsappAbsent || providerReopened.advancedHelp !== "Arquivos e runtime" || JSON.stringify(providerReopened.advancedSections) !== '["Arquivos","Runtime"]' || Math.abs(providerReopened.headerHeight - 54) > 1 || providerReopened.headerBorder !== "1px" || providerReopened.hostGap !== "12px" || providerReopened.hostPadding !== "12px" || providerReopened.cardRadius !== "6px" || providerReopened.cardBackground !== "rgba(0, 0, 0, 0)" || providerReopened.cardBorder !== "1px") {
        throw new Error(`provider/model persistence or settings chrome failed: ${JSON.stringify({ providerSaved, providerReopened })}`);
      }
      await shot("visual-settings-persisted");
      await evalExpr(`(() => {
        delete window.__openbotLocalSettingsDesktop;
        delete window.__openbotVisualProviderPersistence;
        document.getElementById("openbot-provider-settings")?.remove();
        document.getElementById("openbot-visual-settings-persistence")?.remove();
        return true;
      })()`);
      await waitForEval("Boolean(document.querySelector('[data-openbot-p23-launch]'))");
      const toolLaunch = await evalExpr(`(() => {
        const launch = document.querySelector("[data-openbot-p23-launch]");
        return {
          exists: Boolean(launch),
          display: launch ? getComputedStyle(launch).display : null,
          text: launch?.textContent?.trim() || "",
        };
      })()`);
      console.log("LOCAL_TOOLS_LAUNCH", JSON.stringify(toolLaunch));
      if (!toolLaunch.exists || toolLaunch.display !== "none") {
        throw new Error(`local tools launch visual contract failed: ${JSON.stringify(toolLaunch)}`);
      }
      await evalExpr('window.openbotP23?.open?.()');
      await waitForEval("Boolean(document.querySelector('.obp23-dialog .obp23-panel'))");
      const toolDialog = await evalExpr(`(() => {
        const root = document.querySelector(".obp23-dialog");
        const panel = root?.querySelector(".obp23-panel");
        const title = panel?.querySelector("h2")?.textContent?.trim() || "";
        const style = panel ? getComputedStyle(panel) : null;
        const body = panel?.querySelector(".obp23-body");
        const bodyStyle = body ? getComputedStyle(body) : null;
        const head = panel?.querySelector(".obp23-head");
        const close = panel?.querySelector(".obp23-close");
        const closeStyle = close ? getComputedStyle(close) : null;
        const focusable = panel ? [...panel.querySelectorAll("button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[href],[tabindex]:not([tabindex='-1'])")].filter((element) => element.getClientRects().length > 0) : [];
        let focusTrappedForward = false;
        let focusTrappedBackward = false;
        if (focusable.length > 1) {
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          last.focus();
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
          focusTrappedForward = document.activeElement === first;
          first.focus();
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
          focusTrappedBackward = document.activeElement === last;
        }
        const drop = panel?.querySelector("#obp23-drop-zone");
        const fileInput = document.getElementById("obp23-file-input");
        let filePickerTriggers = 0;
        if (drop && fileInput) {
          fileInput.click = () => { filePickerTriggers += 1; };
          drop.click();
          drop.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
          drop.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
        }
        const copy = panel?.innerText || "";
        return {
          exists: Boolean(root && panel),
          title,
          modal: panel?.getAttribute("aria-modal") || null,
          radius: style?.borderRadius || null,
          maxHeight: style?.maxHeight || null,
          overflow: style?.overflow || null,
          sectionGap: bodyStyle?.gap || null,
          width: panel?.getBoundingClientRect().width || 0,
          height: panel?.getBoundingClientRect().height || 0,
          headHeight: head?.getBoundingClientRect().height || 0,
          bodyPadding: bodyStyle?.padding || null,
          closeHeight: close?.getBoundingClientRect().height || 0,
          closeRadius: closeStyle?.borderRadius || null,
          closeLabel: close?.getAttribute("aria-label") || null,
          outerRole: root?.getAttribute("role") || null,
          outerModal: root?.getAttribute("aria-modal") || null,
          labelledBy: panel?.getAttribute("aria-labelledby") || null,
          focusTrappedForward,
          focusTrappedBackward,
          technicalCopy: /P2.3|staging|attachment:|FTS scoped|replyToId|server-side|transcript/i.test(copy),
          friendlyCopy: /Os anexos ficam disponíveis apenas nesta conversa/.test(copy) && /Buscar na conversa/.test(copy) && /Responder a uma mensagem/.test(copy),
          searchPlaceholder: panel?.querySelector("#obp23-query")?.getAttribute("placeholder") || null,
          replyPlaceholder: panel?.querySelector("#obp23-reply")?.getAttribute("placeholder") || null,
          dropRole: drop?.getAttribute("role") || null,
          dropLabel: drop?.getAttribute("aria-label") || null,
          dropTabIndex: drop?.tabIndex ?? null,
          dropCursor: drop ? getComputedStyle(drop).cursor : null,
          filePickerTriggers,
          hasClose: Boolean(panel?.querySelector('[aria-label="Fechar"]')),
          hasBackdrop: Boolean(root?.querySelector(".obp23-backdrop")),
        };
      })()`);
      console.log("LOCAL_TOOLS_DIALOG", JSON.stringify(toolDialog));
      if (!toolDialog.exists || toolDialog.title !== "Anexos e busca" || toolDialog.modal !== "true" || toolDialog.radius !== "14px" || toolDialog.overflow !== "hidden" || toolDialog.sectionGap !== "12px" || Math.abs(toolDialog.width - 860) > 1 || Math.abs(toolDialog.height - 620) > 1 || Math.abs(toolDialog.headHeight - 54) > 1 || toolDialog.bodyPadding !== "24px" || Math.abs(toolDialog.closeHeight - 30) > 1 || toolDialog.closeRadius !== "6px" || toolDialog.closeLabel !== "Fechar" || toolDialog.outerRole !== null || toolDialog.outerModal !== null || !toolDialog.labelledBy || !toolDialog.focusTrappedForward || !toolDialog.focusTrappedBackward || toolDialog.technicalCopy || !toolDialog.friendlyCopy || toolDialog.searchPlaceholder !== "Buscar na conversa" || toolDialog.replyPlaceholder !== "Escreva sua resposta" || toolDialog.dropRole !== "button" || toolDialog.dropLabel !== "Adicionar arquivo" || toolDialog.dropTabIndex !== 0 || toolDialog.dropCursor !== "pointer" || toolDialog.filePickerTriggers !== 3 || !toolDialog.hasClose || !toolDialog.hasBackdrop) {
        throw new Error(`local tools dialog visual contract failed: ${JSON.stringify(toolDialog)}`);
      }
      await shot("visual-local-tools-dialog");
      await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 640, deviceScaleFactor: 1, mobile: false });
      await waitForEval("innerWidth === 820 && innerHeight === 640");
      const compactToolDialog = await evalExpr(`(() => { const panel = document.querySelector('.obp23-dialog .obp23-panel'); const rect = panel?.getBoundingClientRect(); return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, fits: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight, horizontalOverflow: panel.scrollWidth > panel.clientWidth } : null; })()`);
      if (!compactToolDialog?.fits || compactToolDialog.horizontalOverflow || compactToolDialog.width < 780 || compactToolDialog.height < 600) throw new Error(`local tools dialog failed compact layout: ${JSON.stringify(compactToolDialog)}`);
      await shot("visual-local-tools-dialog-compact");
      await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
      await waitForEval("innerWidth === 1024 && innerHeight === 768");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      const closedByEscape = await waitForEval('!document.querySelector(".obp23-dialog")');
      await evalExpr('window.openbotP23?.open?.()');
      await waitForEval("Boolean(document.querySelector('.obp23-dialog'))");
      const closedByBackdrop = await evalExpr(`(() => {
        const backdrop = document.querySelector(".obp23-backdrop");
        if (!backdrop) return false;
        backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        return !document.querySelector(".obp23-dialog");
      })()`);
      await evalExpr('window.openbotP23?.open?.()');
      await waitForEval("Boolean(document.querySelector('.obp23-dialog'))");
      const closedByButton = await evalExpr(`(() => {
        const close = document.querySelector('.obp23-dialog [aria-label="Fechar"]');
        close?.click();
        return !document.querySelector(".obp23-dialog");
      })()`);
      console.log("LOCAL_TOOLS_CLOSE", JSON.stringify({ closedByEscape, closedByBackdrop, closedByButton }));
      if (!closedByEscape || !closedByBackdrop || !closedByButton) {
        throw new Error(`local tools dialog close contract failed: ${JSON.stringify({ closedByEscape, closedByBackdrop, closedByButton })}`);
      }
      await evalExpr(`(() => {
        document.getElementById("openbot-visual-sidebar-create-fixture")?.remove();
        const fixture = document.createElement("aside");
        fixture.id = "openbot-visual-sidebar-create-fixture";
        fixture.className = "sand-agents-sidebar";
        fixture.style.cssText = "position:fixed;left:16px;top:16px;width:280px;min-height:120px;padding:12px;z-index:2147483601";
        const plus = document.createElement("button");
        plus.className = "sand-agents-sidebar__new";
        plus.type = "button";
        plus.setAttribute("aria-label", "New");
        plus.title = "New chat";
        plus.textContent = "+";
        plus.addEventListener("click", () => {
          const action = document.createElement("button");
          action.className = "sand-new-chat-row";
          action.type = "button";
          action.setAttribute("role", "option");
          action.textContent = "Create new Bot";
          action.addEventListener("click", () => {
            fixture.dataset.created = "1";
            action.remove();
            const surface = document.createElement("div");
            surface.id = "openbot-visual-create-surface";
            surface.textContent = "New Bot";
            fixture.append(surface);
          }, { once: true });
          fixture.append(action);
        }, { once: true });
        fixture.append(plus);
        document.body.append(fixture);
        plus.click();
        return true;
      })()`);
      await sleep(300);
      const sidebarCreate = await evalExpr(`(() => {
        const fixture = document.getElementById("openbot-visual-sidebar-create-fixture");
        const plus = fixture?.querySelector(".sand-agents-sidebar__new");
        const intermediate = [...document.querySelectorAll(".sand-new-chat-row, [role='option']")]
          .find((el) => /^Create new(?: Bot)?(?:\\s|$)/i.test((el.textContent || "").trim()) && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0);
        return {
          created: fixture?.dataset.created === "1",
          setupSurface: Boolean(document.getElementById("openbot-create-agent")),
          intermediateVisible: Boolean(intermediate),
          plusConnected: Boolean(plus?.isConnected),
          plusEnabled: plus instanceof HTMLButtonElement && !plus.disabled,
          plusHidden: Boolean(plus?.closest('[data-openbot-hide="1"]')),
        };
      })()`);
      console.log("SIDEBAR_CREATE_SETUP", JSON.stringify(sidebarCreate));
      if (sidebarCreate.created || !sidebarCreate.setupSurface || sidebarCreate.intermediateVisible || !sidebarCreate.plusConnected || !sidebarCreate.plusEnabled || sidebarCreate.plusHidden) {
        throw new Error(`sidebar create-setup contract failed: ${JSON.stringify(sidebarCreate)}`);
      }
      await shot("visual-sidebar-create-setup");
      await evalExpr('document.querySelector("#openbot-create-agent [data-action=cancel]")?.click()');
      await evalExpr('document.getElementById("openbot-visual-sidebar-create-fixture")?.remove()');
      await evalExpr(`(() => {
        document.getElementById("openbot-visual-sidebar-row-fixture")?.remove();
        const fixture = document.createElement("aside");
        fixture.id = "openbot-visual-sidebar-row-fixture";
        fixture.className = "sand-agents-sidebar";
        fixture.style.cssText = "position:fixed;left:16px;top:16px;width:288px;height:240px;z-index:2147483601;background:var(--cursor-bg-chrome,#111);color:var(--cursor-text-primary,#fff);border:1px solid var(--cursor-stroke-secondary,#343434)";
        fixture.innerHTML = '<div style="display:flex;height:42px;align-items:center;justify-content:flex-end;padding:0 12px"><button class="sand-agents-sidebar__new" type="button" aria-label="New" style="border:0;background:transparent;color:inherit;font-size:20px">+</button></div><div style="margin:0 12px 6px;padding:7px 9px;border:1px solid var(--cursor-stroke-secondary,#343434);border-radius:6px;color:var(--cursor-text-secondary,#aaa)">⌕ Buscar</div><div class="sand-agents-list__rows"><button class="sand-agent-item" data-layout="expanded" data-active="true" aria-current="page" aria-label="Orquestrador" type="button"><span class="sand-agent-item__avatar"><span class="sand-agent-item__avatar-disc"><svg data-state="sleeping" viewBox="0 0 36 36" aria-hidden="true"><rect width="36" height="36" rx="11" fill="#7c3aed"/><circle cx="13" cy="16" r="2" fill="#111"/><circle cx="23" cy="16" r="2" fill="#111"/></svg></span></span><span class="sand-agent-item__body"><span class="sand-agent-item__title"><span class="sand-agent-item__name">Orquestrador</span><span class="sand-agent-item__title-badge" style="padding:1px 5px;border-radius:4px;background:var(--cursor-bg-secondary,#303030);font-size:11px">New Bot</span><span class="sand-agent-item__time">1:38</span></span></span></button></div>';
        document.body.appendChild(fixture);
        window.dispatchEvent(new Event("blur"));
        return true;
      })()`);
      await waitForEval("document.querySelector('#openbot-visual-sidebar-row-fixture svg')?.dataset.openbotAvatarPaused === '1'");
      const sidebarRow = await evalExpr(`(() => {
        const row = document.querySelector("#openbot-visual-sidebar-row-fixture .sand-agent-item");
        const avatar = row?.querySelector(".sand-agent-item__avatar");
        const svg = avatar?.querySelector("svg");
        const body = row?.querySelector(".sand-agent-item__body");
        const preview = body ? getComputedStyle(body, "::after") : null;
        const rowStyle = row ? getComputedStyle(row) : null;
        const avatarStyle = avatar ? getComputedStyle(avatar) : null;
        return {
          rowHeight: row?.getBoundingClientRect().height || 0,
          rowRadius: rowStyle?.borderRadius || null,
          avatarWidth: avatar?.getBoundingClientRect().width || 0,
          avatarDisplay: avatarStyle?.display || null,
          svgDisplay: svg ? getComputedStyle(svg).display : null,
          svgPaused: svg?.dataset.openbotAvatarPaused || null,
          preview: preview?.content || null,
          bodyWidth: body?.getBoundingClientRect().width || 0,
        };
      })()`);
      console.log("SIDEBAR_AGENT_ROW", JSON.stringify(sidebarRow));
      if (sidebarRow.rowHeight < 58 || sidebarRow.rowHeight > 60 || sidebarRow.rowRadius !== "10px" || Math.abs(sidebarRow.avatarWidth - 34) > 1 || sidebarRow.avatarDisplay !== "grid" || sidebarRow.svgDisplay === "none" || sidebarRow.svgPaused !== "1" || !/Pronto para conversar/.test(sidebarRow.preview || "") || sidebarRow.bodyWidth < 150 || sidebarRow.bodyWidth > 225) {
        throw new Error(`sidebar agent row visual contract failed: ${JSON.stringify(sidebarRow)}`);
      }
      await shot("visual-sidebar-agent-row");
      await evalExpr('document.getElementById("openbot-visual-sidebar-row-fixture")?.remove()');
    }
    const detailsOpenBeforeBotSwitch = await evalExpr(`([...document.querySelectorAll('[aria-label="View agent settings"]')].find((element) => element.getClientRects().length > 0)?.getAttribute("aria-expanded") === "true")`);
    if (!detailsOpenBeforeBotSwitch) throw new Error("agent settings must be open before switching bots in the empty-details regression path");

    await verifyCreateFlow();

    const createdRowPoint = await evalExpr(`(() => {
      const row = [...document.querySelectorAll(".sand-agent-item[data-layout='expanded']")].find((element) => element.querySelector(".sand-agent-item__name")?.textContent?.trim() === "New Bot");
      const rect = row?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`);
    if (!createdRowPoint) throw new Error("created bot row could not be located for rename/delete verification");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: createdRowPoint.x, y: createdRowPoint.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: createdRowPoint.x, y: createdRowPoint.y });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: createdRowPoint.x, y: createdRowPoint.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 2, x: createdRowPoint.x, y: createdRowPoint.y });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 2, x: createdRowPoint.x, y: createdRowPoint.y });
    let renameUi = null;
    const renameDeadline = Date.now() + 3000;
    while (Date.now() < renameDeadline) {
      renameUi = await evalExpr(`(() => {
        const input = document.querySelector('.sand-agent-item__name-input[aria-label="Rename agent"]');
        const style = input ? getComputedStyle(input) : null;
        return input ? { focused: document.activeElement === input, height: input.getBoundingClientRect().height, radius: style?.borderRadius || null } : null;
      })()`);
      if (renameUi) break;
      await sleep(80);
    }
    if (!renameUi?.focused || Math.abs(renameUi.height - 20) > 1 || renameUi.radius !== "0px") throw new Error(`native compact rename field visual contract failed: ${JSON.stringify(renameUi)}`);
    await send("Input.insertText", { text: "Bot Revisado" });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    let renamed = false;
    const renamedDeadline = Date.now() + 5000;
    while (Date.now() < renamedDeadline) {
      renamed = await evalExpr(`[...document.querySelectorAll(".sand-agent-item[data-layout='expanded'] .sand-agent-item__name")].some((element) => element.textContent?.trim() === "Bot Revisado")`);
      if (renamed) break;
      await sleep(100);
    }
    if (!renamed) throw new Error("native bot rename did not persist in the sidebar");
    await shot("visual-bot-renamed");
    const closedDetailsLayout = await evalExpr(`(() => {
      const details = document.getElementById("sand-conversation-details");
      const detailsRect = details?.getBoundingClientRect();
      const chat = document.querySelector("main.sand-chat");
      const chatRect = chat?.getBoundingClientRect();
      const settings = document.getElementById("openbot-provider-settings");
      const settingsRect = settings?.getBoundingClientRect();
      const settingsVisible = Boolean(settingsRect && settingsRect.width > 0 && settingsRect.height > 0 && getComputedStyle(settings).visibility !== "hidden");
      const toggle = [...document.querySelectorAll('[aria-label="View agent settings"]')].find((element) => element.getClientRects().length > 0);
      const panel = toggle?.getAttribute("aria-controls") ? document.getElementById(toggle.getAttribute("aria-controls")) : null;
      const substantive = panel?.querySelector("input,textarea,select,iframe,webview,canvas,img,video,[role='status'],[role='alert']");
      const localSettings = document.getElementById("openbot-provider-settings");
      return {
        detailsWidth: detailsRect?.width || 0,
        detailsVisible: Boolean(detailsRect && detailsRect.width > 0 && detailsRect.height > 0 && getComputedStyle(details).visibility !== "hidden"),
        detailsText: (details?.innerText || "").replace(/\\s+/g, " ").trim(),
        panelId: panel?.id || null,
        panelText: (panel?.innerText || "").replace(/\\s+/g, " ").trim(),
        substantive: substantive ? { tag: substantive.tagName, visible: substantive.getClientRects().length > 0 } : null,
        localSettingsConnected: Boolean(localSettings?.isConnected),
        localSettingsVisible: settingsVisible,
        closeLabels: [...details?.querySelectorAll("button,[role='button']") || []].map((element) => element.getAttribute("aria-label") || "").filter(Boolean),
        settingsVisible,
        toggleExpanded: toggle?.getAttribute("aria-expanded") || null,
        chatLeft: chatRect?.left || 0,
        chatWidth: chatRect?.width || 0,
        chatRight: chatRect?.right || 0,
        viewportWidth: innerWidth,
      };
    })()`);
    console.log("CLOSED_DETAILS_LAYOUT", JSON.stringify(closedDetailsLayout));
    const closedDetailsRestored = closedDetailsLayout
      && !closedDetailsLayout.settingsVisible
      && !closedDetailsLayout.detailsVisible
      && Math.abs(closedDetailsLayout.chatRight - closedDetailsLayout.viewportWidth) <= 1
      && Math.abs(closedDetailsLayout.chatWidth - (closedDetailsLayout.viewportWidth - closedDetailsLayout.chatLeft)) <= 1;
    if (!closedDetailsRestored) throw new Error(`empty conversation details did not restore chat layout: ${JSON.stringify(closedDetailsLayout)}`);

    const renamedRowPoint = await evalExpr(`(() => {
      const row = [...document.querySelectorAll(".sand-agent-item[data-layout='expanded']")].find((element) => element.querySelector(".sand-agent-item__name")?.textContent?.trim() === "Bot Revisado");
      const rect = row?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`);
    if (!renamedRowPoint) throw new Error("renamed bot row could not be located for context-menu verification");
    const openBotContextMenu = async () => {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: renamedRowPoint.x, y: renamedRowPoint.y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "right", clickCount: 1, x: renamedRowPoint.x, y: renamedRowPoint.y });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "right", clickCount: 1, x: renamedRowPoint.x, y: renamedRowPoint.y });
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const menu = await evalExpr(`(() => {
          const panel = [...document.querySelectorAll('[role="menu"]')].find((element) => element.getClientRects().length > 0);
          const items = panel ? [...panel.querySelectorAll('[role="menuitem"]')].filter((element) => element.getClientRects().length > 0) : [];
          const style = panel ? getComputedStyle(panel) : null;
          const firstStyle = items[0] ? getComputedStyle(items[0]) : null;
          return panel ? { labels: items.map((element) => element.textContent?.replace(/\\s+/g, ' ').trim() || ''), radius: style?.borderRadius || null, minWidth: panel.getBoundingClientRect().width, itemHeight: items[0]?.getBoundingClientRect().height || 0, itemRadius: firstStyle?.borderRadius || null } : null;
        })()`);
        if (menu) return menu;
        await sleep(80);
      }
      return null;
    };
    const botContextMenu = await openBotContextMenu();
    console.log("BOT_CONTEXT_MENU", JSON.stringify(botContextMenu));
    if (!botContextMenu || !botContextMenu.labels.some((label) => /^(?:Delete|Excluir)$/i.test(label)) || botContextMenu.minWidth < 160 || botContextMenu.itemHeight < 28 || botContextMenu.itemHeight > 32) {
      throw new Error(`bot context menu contract failed: ${JSON.stringify(botContextMenu)}`);
    }
    await waitForEval("[...document.querySelectorAll('[role=menu]')].filter((element) => element.getClientRects().length > 0).every((element) => element.getAnimations().length === 0)");
    await shot("visual-bot-context-menu");
    const deleteMenuPoint = await evalExpr(`(() => { const item = [...document.querySelectorAll('[role="menuitem"]')].find((element) => element.getClientRects().length > 0 && /^(?:Delete|Excluir)$/i.test(element.textContent?.trim() || '')); const rect = item?.getBoundingClientRect(); return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null; })()`);
    if (!deleteMenuPoint) throw new Error("bot delete context-menu action could not be located");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: deleteMenuPoint.x, y: deleteMenuPoint.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: deleteMenuPoint.x, y: deleteMenuPoint.y });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: deleteMenuPoint.x, y: deleteMenuPoint.y });
    await waitForEval("Boolean([...document.querySelectorAll('[role=alertdialog]')].find((element) => element.getClientRects().length > 0))");
    const deleteDialog = await evalExpr(`(() => {
      const panel = [...document.querySelectorAll('[role="alertdialog"]')].find((element) => element.getClientRects().length > 0);
      const buttons = panel ? [...panel.querySelectorAll('button')].filter((element) => element.getClientRects().length > 0) : [];
      const style = panel ? getComputedStyle(panel) : null;
      return panel ? { label: panel.getAttribute('aria-label'), modal: panel.getAttribute('aria-modal'), width: panel.getBoundingClientRect().width, radius: style?.borderRadius || null, padding: style?.padding || null, buttons: buttons.map((button) => ({ text: button.textContent?.trim() || '', height: button.getBoundingClientRect().height, radius: getComputedStyle(button).borderRadius, focused: document.activeElement === button })) } : null;
    })()`);
    const deleteDialogDebug = deleteDialog ? null : await evalExpr(`(() => ({
      modals: [...document.querySelectorAll('[aria-modal="true"], [role="dialog"], [role="alertdialog"]')].map((element) => ({ role: element.getAttribute('role'), label: element.getAttribute('aria-label'), text: (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240), visible: element.getClientRects().length > 0, hidden: element.hidden, localHidden: element.getAttribute('data-openbot-hide') })),
      menus: [...document.querySelectorAll('[role="menu"]')].map((element) => ({ visible: element.getClientRects().length > 0, text: (element.textContent || '').replace(/\\s+/g, ' ').trim() })),
      rows: [...document.querySelectorAll(".sand-agent-item[data-layout='expanded']")].map((element) => element.querySelector('.sand-agent-item__name')?.textContent?.trim() || ''),
      bodyTail: (document.body?.innerText || '').slice(-900),
    }))()`);
    console.log("BOT_DELETE_DIALOG", JSON.stringify({ dialog: deleteDialog, debug: deleteDialogDebug }));
    if (!deleteDialog || deleteDialog.modal !== "true" || Math.abs(deleteDialog.width - 362) > 1 || deleteDialog.radius !== "14px" || deleteDialog.padding !== "0px" || !deleteDialog.buttons.some((button) => /^(?:Delete|Excluir)$/i.test(button.text) && button.focused) || deleteDialog.buttons.some((button) => Math.abs(button.height - 32) > 1 || button.radius !== "8px")) {
      throw new Error(`bot delete confirmation visual contract failed: ${JSON.stringify(deleteDialog)}`);
    }
    await shot("visual-bot-delete-confirmation");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await waitForEval("!Boolean([...document.querySelectorAll('[role=alertdialog]')].find((element) => element.getClientRects().length > 0))");
    if (await evalExpr(`Boolean([...document.querySelectorAll('[role="alertdialog"]')].find((element) => element.getClientRects().length > 0))`)) throw new Error("bot delete confirmation did not close with Escape");
    const botContextMenuAgain = await openBotContextMenu();
    if (!botContextMenuAgain?.labels.some((label) => /^(?:Delete|Excluir)$/i.test(label))) throw new Error("bot context menu did not reopen after cancelling deletion");
    const deleteMenuPointAgain = await evalExpr(`(() => { const item = [...document.querySelectorAll('[role="menuitem"]')].find((element) => element.getClientRects().length > 0 && /^(?:Delete|Excluir)$/i.test(element.textContent?.trim() || '')); const rect = item?.getBoundingClientRect(); return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null; })()`);
    if (!deleteMenuPointAgain) throw new Error("bot delete context-menu action could not be located after cancelling");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: deleteMenuPointAgain.x, y: deleteMenuPointAgain.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: deleteMenuPointAgain.x, y: deleteMenuPointAgain.y });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: deleteMenuPointAgain.x, y: deleteMenuPointAgain.y });
    await waitForEval("Boolean([...document.querySelectorAll('[role=alertdialog]')].find((element) => element.getClientRects().length > 0))");
    const confirmDeleteClicked = await evalExpr(`(() => { const dialog = [...document.querySelectorAll('[role="alertdialog"]')].find((element) => element.getClientRects().length > 0); const button = dialog ? [...dialog.querySelectorAll('button')].find((element) => /^(?:Delete|Excluir)$/i.test(element.textContent?.trim() || '')) : null; button?.click(); return Boolean(button); })()`);
    if (!confirmDeleteClicked) throw new Error("native bot deletion could not be confirmed");
    let deletionState = null;
    const deleteDeadline = Date.now() + 5000;
    while (Date.now() < deleteDeadline) {
      deletionState = await evalExpr(`(() => { const rows = [...document.querySelectorAll(".sand-agent-item[data-layout='expanded']")].filter((element) => element.getClientRects().length > 0); return { names: rows.map((row) => row.querySelector('.sand-agent-item__name')?.textContent?.trim() || ''), active: rows.find((row) => row.getAttribute('aria-current') === 'page' || row.dataset.active === 'true')?.querySelector('.sand-agent-item__name')?.textContent?.trim() || '' }; })()`);
      if (deletionState.names.length === 1 && deletionState.names[0] === "Local User") break;
      await sleep(100);
    }
    console.log("BOT_DELETE_STATE", JSON.stringify(deletionState));
    if (deletionState?.names.length !== 1 || deletionState.names[0] !== "Local User" || deletionState.active !== "Local User") throw new Error(`native bot deletion did not restore the original bot: ${JSON.stringify(deletionState)}`);

    const originalRowPoint = await evalExpr(`(() => {
      const row = [...document.querySelectorAll(".sand-agent-item[data-layout='expanded']")].find((element) => element.querySelector(".sand-agent-item__name")?.textContent?.trim() === "Local User");
      const rect = row?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`);
    if (!originalRowPoint) throw new Error("original bot could not be located after native creation");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: originalRowPoint.x, y: originalRowPoint.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: originalRowPoint.x, y: originalRowPoint.y });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: originalRowPoint.x, y: originalRowPoint.y });
    let activeAfterReopen = null;
    const reopenDeadline = Date.now() + 5000;
    while (Date.now() < reopenDeadline) {
      activeAfterReopen = await evalExpr(`window.desktop?.agent?.getProviderConfig?.()`);
      const selectedName = await evalExpr(`([...document.querySelectorAll(".sand-agent-item[data-layout='expanded']")].find((row) => row.getAttribute("aria-current") === "page" || row.dataset.active === "true")?.querySelector(".sand-agent-item__name")?.textContent?.trim() || "")`);
      if (selectedName === "Local User") break;
      await sleep(100);
    }
    const selectionAfterReopen = await evalExpr(`(() => ({
      active: [...document.querySelectorAll(".sand-agent-item[data-layout='expanded']")].find((row) => row.getAttribute("aria-current") === "page" || row.dataset.active === "true")?.querySelector(".sand-agent-item__name")?.textContent?.trim() || "",
      rows: [...document.querySelectorAll(".sand-agent-item[data-layout='expanded']")].map((row) => ({ tag: row.tagName, name: row.querySelector(".sand-agent-item__name")?.textContent?.trim() || "", current: row.getAttribute("aria-current"), active: row.dataset.active || null, label: row.getAttribute("aria-label") || "" })),
    }))()`);
    console.log("NATIVE_REOPEN_STATE", JSON.stringify({ activeAfterReopen, selectionAfterReopen }));
    if (selectionAfterReopen.active !== "Local User") throw new Error(`original bot did not remain selected after reopen: ${JSON.stringify({ activeAfterReopen, selectionAfterReopen })}`);
    const composerFocused = await evalExpr(`(() => {
      const element = [...document.querySelectorAll("[contenteditable='true']")].find((candidate) => candidate.getClientRects().length > 0 && (candidate.getAttribute("aria-label") === "Prompt" || candidate.classList.contains("sand-prompt-field")));
      if (!element) return false;
      element.focus();
      element.click();
      return document.activeElement === element;
    })()`);
    if (!composerFocused) throw new Error("real composer could not receive focus after bot creation");
    await send("Input.insertText", { text: "/" });
    let workflowMenu = null;
    const workflowDeadline = Date.now() + 5000;
    while (Date.now() < workflowDeadline) {
      workflowMenu = await evalExpr(`(() => {
        const menu = document.querySelector(".sand-workflow-listbox");
        if (!menu || !menu.getClientRects().length) return null;
        const rect = menu.getBoundingClientRect();
        const item = [...menu.querySelectorAll("[role='option'],button")].find((candidate) => /E2E Shared Skill/.test(candidate.textContent || ""));
        const menuStyle = getComputedStyle(menu);
        const itemStyle = item ? getComputedStyle(item) : null;
        const probe = document.elementFromPoint(rect.left + Math.min(24, rect.width / 2), rect.top + Math.min(24, rect.height / 2));
        return {
          label: menu.getAttribute("aria-label") || "",
          hasSharedSkill: Boolean(item),
          withinViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
          width: rect.width,
          height: rect.height,
          radius: menuStyle.borderRadius,
          background: menuStyle.backgroundColor,
          color: menuStyle.color,
          opacity: menuStyle.opacity,
          zIndex: menuStyle.zIndex,
          itemColor: itemStyle?.color || null,
          probe: probe ? { tag: probe.tagName, className: String(probe.className || ""), insideMenu: menu.contains(probe) } : null,
          motion: menu.dataset.openbotMotion || null,
          duration: menu.dataset.openbotMotionDuration || null,
          runs: menu.dataset.openbotMotionRuns || null,
        };
      })()`);
      if (workflowMenu?.hasSharedSkill) break;
      await sleep(100);
    }
    console.log("WORKFLOW_MENU", JSON.stringify(workflowMenu));
    if (!workflowMenu?.hasSharedSkill || !workflowMenu.withinViewport || workflowMenu.motion !== "surface" || workflowMenu.duration !== "220" || workflowMenu.runs !== "1") {
      throw new Error(`native workflow menu failed visual verification: ${JSON.stringify(workflowMenu)}`);
    }
    await waitForEval("document.querySelector('.sand-workflow-listbox')?.getAnimations().length === 0");
    const settledWorkflowMenu = await evalExpr(`(() => {
      const menu = document.querySelector(".sand-workflow-listbox");
      if (!menu) return null;
      const rect = menu.getBoundingClientRect();
      const item = [...menu.querySelectorAll("[role='option'],button")].find((candidate) => /E2E Shared Skill/.test(candidate.textContent || ""));
      const probe = document.elementFromPoint(rect.left + Math.min(24, rect.width / 2), rect.top + Math.min(24, rect.height / 2));
      return {
        activeAnimations: menu.getAnimations().length,
        opacity: getComputedStyle(menu).opacity,
        itemColor: item ? getComputedStyle(item).color : null,
        probeInsideMenu: Boolean(probe && menu.contains(probe)),
        staleStatusVisible: [...document.querySelectorAll("[role='status']")].some((node) => node.getClientRects().length > 0 && /Bot ativo mudou/.test(node.textContent || "")),
      };
    })()`);
    console.log("WORKFLOW_MENU_SETTLED", JSON.stringify(settledWorkflowMenu));
    if (!settledWorkflowMenu || settledWorkflowMenu.opacity !== "1" || !settledWorkflowMenu.probeInsideMenu || settledWorkflowMenu.staleStatusVisible) {
      throw new Error(`native workflow menu did not settle above the composer: ${JSON.stringify(settledWorkflowMenu)}`);
    }
    await shot("visual-workflow-menu");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await waitForEval("!document.querySelector('.sand-workflow-listbox')");
    const menuClosedWithFocus = await evalExpr(`(() => ({
      closed: !document.querySelector(".sand-workflow-listbox"),
      composerFocused: document.activeElement?.getAttribute("aria-label") === "Prompt" || document.activeElement?.classList?.contains("sand-prompt-field") === true,
    }))()`);
    if (!menuClosedWithFocus.closed || !menuClosedWithFocus.composerFocused) throw new Error(`workflow menu failed Escape/focus restoration: ${JSON.stringify(menuClosedWithFocus)}`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });

    await send("Emulation.setDeviceMetricsOverride", { width: 704, height: 768, deviceScaleFactor: 1, mobile: false });
    await waitForEval("innerWidth === 704 && innerHeight === 768");
    const streamPrompt = "Teste";
    await send("Input.insertText", { text: streamPrompt });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    if (process.argv.includes("--chat-only")) {
      await waitForEval(`Boolean(document.querySelector('[data-row-key="sand-typing-indicator"] .sand-activity-mark'))`, 1200);
      const waiting = await evalExpr(`(() => {
        const row = document.querySelector('[data-row-key="sand-typing-indicator"]');
        return { visible: row?.getBoundingClientRect().height > 0 && getComputedStyle(row).display !== "none",
          noResponse: !document.querySelector('main.sand-chat')?.innerText.includes('E2E incremental'),
          animationRunning: row?.getAnimations({subtree:true}).some(animation => animation.playState === 'running') };
      })()`);
      console.log("NATIVE_WAITING_UI", JSON.stringify(waiting));
      if (!waiting.visible || !waiting.noResponse || !waiting.animationRunning) throw new Error("waiting indicator is not animated before response");
    }
    await waitGatewayStatus((status) => status.cancelReady === true && status.activeStreams > 0);
    let streamingUi = null;
    const streamingDeadline = Date.now() + 12000;
    while (Date.now() < streamingDeadline) {
      streamingUi = await evalExpr(`(() => {
        const stop = document.getElementById("openbot-stop-turn");
        const stopRect = stop?.getBoundingClientRect();
        const stopStyle = stop ? getComputedStyle(stop) : null;
        const iconStyle = stop ? getComputedStyle(stop, "::before") : null;
        const promptAction = [...document.querySelectorAll(".sand-prompt-send")].find((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
        const promptActionRect = promptAction?.getBoundingClientRect();
        const promptShell = promptAction?.closest(".sand-prompt-shell");
        const promptShellRect = promptShell?.getBoundingClientRect();
        const transcript = document.querySelector("main.sand-chat");
        const text = transcript?.innerText || "";
        const message = [...document.querySelectorAll("main.sand-chat .sand-transcript-row,.sand-message-card")].find((element) => /E2E incremental stream/.test(element.textContent || ""));
        const userMessage = [...document.querySelectorAll("main.sand-chat .sand-transcript-row")]
          .find((element) => (element.innerText || "").split(/\\r?\\n/).some((line) => line.trim() === ${JSON.stringify("Teste")}));
        const walker = userMessage ? document.createTreeWalker(userMessage, NodeFilter.SHOW_TEXT) : null;
        let promptNode = walker?.nextNode() || null;
        while (promptNode && (promptNode.nodeValue || "").trim() !== ${JSON.stringify("Teste")}) promptNode = walker.nextNode();
        const range = promptNode ? document.createRange() : null;
        if (range && promptNode) range.selectNodeContents(promptNode);
        const lineRects = range ? [...range.getClientRects()] : [];
        let bubble = promptNode?.parentElement || null;
        while (bubble && bubble !== userMessage) {
          const background = getComputedStyle(bubble).backgroundColor;
          if (background !== "transparent" && background !== "rgba(0, 0, 0, 0)") break;
          bubble = bubble.parentElement;
        }
        return {
          activityVisible: [...document.querySelectorAll('[data-row-key="sand-typing-indicator"]')].some(element => getComputedStyle(element).display !== "none" && element.getBoundingClientRect().height > 0),
          floatingStatusHidden: document.getElementById("openbot-turn-status")?.hidden === true,
          iconCentered: Boolean(iconStyle && iconStyle.position === "absolute" && Math.abs(parseFloat(iconStyle.left) - stopRect.width / 2) <= 1 && Math.abs(parseFloat(iconStyle.top) - stopRect.height / 2) <= 1 && iconStyle.transform === "matrix(1, 0, 0, 1, -4, -4)"),
          userVisible: text.includes(${JSON.stringify("Teste")}),
          userLineCount: lineRects.length,
          userLineWidths: lineRects.map((rect) => rect.width),
          userBubbleWidth: bubble?.getBoundingClientRect().width || 0,
          userRowWidth: userMessage?.getBoundingClientRect().width || 0,
          assistantVisible: /E2E incremental stream/.test(text),
          stopVisible: Boolean(stop && !stop.hidden && stopRect && stopRect.width > 0 && stopRect.height > 0),
          stopWidth: stopRect?.width || 0,
          stopHeight: stopRect?.height || 0,
          stopRadius: stopStyle?.borderRadius || null,
          stopHidden: stop?.hidden ?? null,
          stopDisplay: stopStyle?.display || null,
          alignedWithPromptAction: Boolean(stopRect && promptActionRect && Math.abs(stopRect.left - promptActionRect.left) <= 1 && Math.abs(stopRect.top - promptActionRect.top) <= 1 && Math.abs(stopRect.width - promptActionRect.width) <= 1 && Math.abs(stopRect.height - promptActionRect.height) <= 1),
          activityDetail: (() => {
            const detail = document.querySelector('[data-openbot-activity-detail]');
            return detail ? detail.textContent : null;
          })(),
          promptActionCount: [...document.querySelectorAll(".sand-prompt-send")].filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden").length,
          insidePromptShell: Boolean(stopRect && promptShellRect && stopRect.left >= promptShellRect.left && stopRect.top >= promptShellRect.top && stopRect.right <= promptShellRect.right && stopRect.bottom <= promptShellRect.bottom),
          activeAgent: stop?.dataset.openbotActiveAgent || null,
          busyAgents: stop?.dataset.openbotBusyAgents || null,
          optimistic: stop?.dataset.openbotOptimistic || null,
          messageMotion: message?.dataset.openbotMotion || null,
          messageDuration: message?.dataset.openbotMotionDuration || null,
          messageRuns: message?.dataset.openbotMotionRuns || null,
        };
      })()`);
      if (streamingUi?.userVisible && streamingUi?.assistantVisible && streamingUi?.stopVisible && streamingUi?.alignedWithPromptAction && streamingUi?.insidePromptShell) break;
      await sleep(100);
    }
    console.log("NATIVE_STREAMING_UI", JSON.stringify(streamingUi));
    console.log("NATIVE_EXECUTION_DETAIL", JSON.stringify({
      activityVisible: streamingUi?.activityVisible, transcriptTextVisible: streamingUi?.assistantVisible,
      detail: streamingUi?.activityDetail, localStatusHidden: streamingUi?.floatingStatusHidden,
      promptActionCount: streamingUi?.promptActionCount,
    }));
    // O texto da rodada fica retido com ferramentas habilitadas, mas a etapa real
    // do provedor não pode ficar escondida: o detalhe entra na superfície nativa.
    if (!streamingUi?.activityVisible) throw new Error("native activity indicator is missing during the paused stream");
    const detail = String(streamingUi?.activityDetail || "");
    if (!/Recebendo resposta|Executando ferramenta|Aguardando/.test(detail)) throw new Error(`execution step is not integrated into the native activity surface: ${JSON.stringify(detail)}`);
    if (!/atividade: |sem atualização há /.test(detail)) throw new Error(`execution detail is missing the real activity age: ${JSON.stringify(detail)}`);
    if (streamingUi?.assistantVisible) throw new Error("this fixture must keep the round text retained while the provider is paused");
    if (!streamingUi?.floatingStatusHidden) throw new Error("the local status line must not duplicate the native activity surface");
    if (!streamingUi?.activityVisible || !streamingUi?.floatingStatusHidden) throw new Error("native activity missing or duplicated by status label");
    if (!streamingUi?.iconCentered) throw new Error("stop icon is not centered");
    if (!streamingUi?.userVisible || streamingUi.userLineCount !== 1 || streamingUi.userBubbleWidth < 44 || !streamingUi.assistantVisible || !streamingUi.stopVisible || Math.abs(streamingUi.stopWidth - 30) > 1 || Math.abs(streamingUi.stopHeight - 30) > 1 || !streamingUi.alignedWithPromptAction || !streamingUi.insidePromptShell || streamingUi.messageMotion !== null || streamingUi.messageDuration !== null || streamingUi.messageRuns !== null) {
      throw new Error(`streaming/send/stop UI failed visual verification: ${JSON.stringify(streamingUi)}`);
    }
    await shot("visual-streaming");
    const stopClicked = await evalExpr(`(() => { const button = document.getElementById("openbot-stop-turn"); if (!button || button.hidden || button.disabled) return false; button.click(); return true; })()`);
    if (!stopClicked) throw new Error("visible stop button could not be clicked");
    await waitGatewayStatus((status) => status.abortObserved === true && status.activeStreams === 0 && status.chunksAfterAbort === 0);
    let cancelledUi = null;
    const cancelDeadline = Date.now() + 12000;
    while (Date.now() < cancelDeadline) {
      cancelledUi = await evalExpr(`(() => ({
        stopHidden: Boolean(document.getElementById("openbot-stop-turn")?.hidden),
        noticeVisible: /interrompida/i.test(document.querySelector("main.sand-chat")?.innerText || ""),
        busyMarkers: [...document.querySelectorAll("main.sand-chat [aria-busy='true'],main.sand-chat [data-streaming='true']")].filter((element) => element.getClientRects().length > 0).length,
      }))()`);
      if (cancelledUi.stopHidden && cancelledUi.noticeVisible && cancelledUi.busyMarkers === 0) break;
      await sleep(100);
    }
    console.log("NATIVE_CANCELLED_UI", JSON.stringify(cancelledUi));
    if (!cancelledUi?.stopHidden || !cancelledUi.noticeVisible || cancelledUi.busyMarkers !== 0) throw new Error(`cancelled UI did not settle: ${JSON.stringify(cancelledUi)}`);
    await shot("visual-cancelled");
    await send("Page.reload", { ignoreCache: true });
    await sleep(800);
    await waitForEval(`document.readyState === "complete" && (document.querySelector("main.sand-chat")?.innerText || "").includes(${JSON.stringify("Teste")})`, 10000);
    const persistedUserLayout = await evalExpr(`(() => {
      const transcript = document.querySelector("main.sand-chat");
      const walker = transcript ? document.createTreeWalker(transcript, NodeFilter.SHOW_TEXT) : null;
      let promptNode = walker?.nextNode() || null;
      while (promptNode && (promptNode.nodeValue || "").trim() !== ${JSON.stringify("Teste")}) promptNode = walker.nextNode();
      const range = promptNode ? document.createRange() : null;
      if (range && promptNode) range.selectNodeContents(promptNode);
      const lineRects = range ? [...range.getClientRects()] : [];
      const row = promptNode?.parentElement?.closest(".sand-transcript-row,.sand-virtual-transcript__row") || null;
      let bubble = promptNode?.parentElement || null;
      while (bubble && bubble !== row) {
        const background = getComputedStyle(bubble).backgroundColor;
        if (background !== "transparent" && background !== "rgba(0, 0, 0, 0)") break;
        bubble = bubble.parentElement;
      }
      return {
        lineCount: lineRects.length,
        lineWidths: lineRects.map((rect) => rect.width),
        bubbleWidth: bubble?.getBoundingClientRect().width || 0,
        rowClass: row?.className || null,
        role: row?.getAttribute("data-role") || null,
        side: row?.getAttribute("data-openbot-side") || null,
      };
    })()`);
    console.log("PERSISTED_USER_LAYOUT", JSON.stringify(persistedUserLayout));
    await shot("visual-persisted-message");
    if (persistedUserLayout?.lineCount !== 1 || persistedUserLayout.bubbleWidth < 44) throw new Error(`persisted user bubble collapsed: ${JSON.stringify(persistedUserLayout)}`);
    await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    await waitForEval("innerWidth === 1024 && innerHeight === 768");

    const retryFocused = await evalExpr(`(() => { const element = [...document.querySelectorAll("[contenteditable='true']")].find((candidate) => candidate.getClientRects().length > 0 && (candidate.getAttribute("aria-label") === "Prompt" || candidate.classList.contains("sand-prompt-field"))); element?.focus(); element?.click(); return document.activeElement === element; })()`);
    if (!retryFocused) throw new Error("composer could not receive focus for retry state");
    const retryPrompt = "desktop e2e retry recovery";
    await send("Input.insertText", { text: retryPrompt });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await waitGatewayStatus((status) => status.retryFailureObserved === true && status.activeStreams === 0);
    let retryUi = null;
    const retryDeadline = Date.now() + 12000;
    while (Date.now() < retryDeadline) {
      retryUi = await evalExpr(`(() => {
        const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Tentar novamente" && candidate.getClientRects().length > 0);
        const style = button ? getComputedStyle(button) : null;
        return {
          errorVisible: /O provedor está temporariamente indisponível/.test(document.querySelector("main.sand-chat")?.innerText || ""),
          buttonVisible: Boolean(button),
          buttonHeight: button?.getBoundingClientRect().height || 0,
          buttonRadius: style?.borderRadius || null,
          rows: [...document.querySelectorAll('.ob-retry-generation')].map(b => ({ text: b.previousElementSibling?.textContent, row: b.closest('[data-row-key]')?.getAttribute('data-row-key'), entry: b.closest('[data-entry-id]')?.getAttribute('data-entry-id') })),
        };
      })()`);
      if (retryUi?.errorVisible && retryUi?.buttonVisible) break;
      await sleep(100);
    }
    console.log("NATIVE_RETRY_UI", JSON.stringify(retryUi));
    if (!retryUi?.errorVisible || !retryUi.buttonVisible || Math.abs(retryUi.buttonHeight - 30) > 1 || retryUi.buttonRadius !== "6px") throw new Error(`retry/error UI failed visual verification: ${JSON.stringify(retryUi)}`);
    await shot("visual-error-retry");
    const beforeStaleRetry = JSON.parse(readFileSync(statusFile, "utf8"));
    // Uma falha superada não recebe ação do backend: a interface só oferece a
    // recuperação que o servidor confirmou para a falha atual.
    const historicalAction = await evalExpr(`(() => {
      const button = [...document.querySelectorAll('.ob-retry-generation')].find(b => b.previousElementSibling?.textContent?.startsWith('Geração interrompida.'));
      return { present: Boolean(button), disabled: button?.disabled ?? null,
        notes: [...document.querySelectorAll('.sand-transcript-row[role="note"]')].map(r => (r.textContent || '').trim().slice(0, 60)) };
    })()`);
    console.log("NATIVE_RETRY_HISTORICAL", JSON.stringify(historicalAction));
    if (historicalAction.present) throw new Error(`historical failure still offers a retry action: ${JSON.stringify(historicalAction)}`);
    const afterStaleRetry = JSON.parse(readFileSync(statusFile, "utf8"));
    if (afterStaleRetry.retrySuccessObserved || afterStaleRetry.activeStreams !== 0 || afterStaleRetry.chunksEmitted !== beforeStaleRetry.chunksEmitted) throw new Error(`historical retry started the wrong response: ${JSON.stringify(afterStaleRetry)}`);
    console.log("NATIVE_RETRY_STALE_REJECTED", JSON.stringify({ historicalActionAbsent: true, activeStreams: afterStaleRetry.activeStreams, retrySuccessObserved: afterStaleRetry.retrySuccessObserved }));
    const retryActivated = await evalExpr(`(() => { const button = [...document.querySelectorAll('.ob-retry-generation')].find(b => b.previousElementSibling?.textContent?.startsWith('O provedor está temporariamente indisponível') && !b.disabled); if (!button) return false; button.focus(); if (document.activeElement !== button) return false; button.click(); return true; })()`);
    if (!retryActivated) throw new Error("retry action could not be focused and activated");
    await waitGatewayStatus((status) => status.retrySuccessObserved === true && status.activeStreams === 0);
    let retryRecovered = false;
    const recoveredDeadline = Date.now() + 12000;
    while (Date.now() < recoveredDeadline) {
      retryRecovered = await evalExpr(`/E2E retry recovered./.test(document.querySelector("main.sand-chat")?.innerText || "")`);
      if (retryRecovered) break;
      await sleep(100);
    }
    if (!retryRecovered) throw new Error("retry response did not recover in the real transcript");
    await shot("visual-retry-recovered");
    if (process.argv.includes("--chat-only")) {
      await waitForEval(`!document.querySelector('[data-row-key="sand-typing-indicator"]') && document.getElementById('openbot-stop-turn')?.hidden === true`, 4000);
      console.log("CHAT GREEN");
      return;
    }

    const agentSettings = await evalExpr("(() => { const hit = [...document.querySelectorAll('[aria-label=\"View agent settings\"]')].find((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'); if (!hit) return { ok: false }; hit.click(); return { ok: true, label: hit.getAttribute('aria-label') }; })()");
    console.log("CLICK_AGENT_SETTINGS", JSON.stringify(agentSettings));
    await waitForEval("Boolean(document.getElementById('openbot-provider-settings')?.getClientRects().length)", 6000);
    await shot("visual-settings");

    await evalExpr(`(() => {
      const now = Date.now();
      const fixtureAgentId = document.querySelector('.sand-agent-item[data-layout="expanded"][aria-current="page"]')?.getAttribute('data-agent-id');
      if (!fixtureAgentId) throw new Error('Memory fixture requires the selected native bot');
      const state = {
        busy: false,
        currentAgentId: fixtureAgentId,
        activeConversationId: "conv-live",
        memoryMode: "automatic",
        createCalls: 0,
        calls: [],
        conversations: [
          { id: "conv-live", agentId: fixtureAgentId, title: "Conversa ativa", titleSource: "manual", temporary: false, archivedAtMs: null, createdAtMs: now - 50_000, updatedAtMs: now - 10_000, lastMessageAtMs: now - 12_000, preview: "Prévia ativa" },
          { id: "conv-side", agentId: fixtureAgentId, title: "Conversa lateral", titleSource: "auto", temporary: false, archivedAtMs: null, createdAtMs: now - 70_000, updatedAtMs: now - 20_000, lastMessageAtMs: now - 18_000, preview: "Prévia lateral" },
          { id: "conv-arch", agentId: fixtureAgentId, title: "Arquivada", titleSource: "manual", temporary: false, archivedAtMs: now - 5_000, createdAtMs: now - 90_000, updatedAtMs: now - 5_000, lastMessageAtMs: now - 30_000, preview: "Prévia arquivada" },
        ],
        memories: [
          { id: "mem-1", kind: "fact", text: "Valor inicial", trust: "verified_tool", status: "active", importance: 50, confidence: 0.7, pinned: false, sourceConversationId: "conv-live", validFromMs: now - 60_000, validToMs: null, expiresAtMs: null, createdAtMs: now - 60_000, updatedAtMs: now - 60_000 },
          { id: "mem-2", kind: "preference", text: "Prefere respostas curtas", trust: "user", status: "active", importance: 75, confidence: 1, pinned: true, sourceConversationId: "conv-side", validFromMs: now - 55_000, validToMs: null, expiresAtMs: null, createdAtMs: now - 55_000, updatedAtMs: now - 55_000 },
        ],
      };
      window.__openbotMemoryUiState = state;
      const current = {};
      const logCall = (method, payload = {}) => {
        state.calls.push({ method, payload: JSON.parse(JSON.stringify(payload || {})) });
      };
      const pickConversation = (id) => state.conversations.find((item) => item.id === id) || null;
      const activeConversation = () => pickConversation(state.activeConversationId) || state.conversations.find((item) => item.archivedAtMs == null) || null;
      const liveConversations = () => state.conversations.filter((item) => item.archivedAtMs == null);
      const page = () => ({ items: state.conversations.slice(0, 50), nextCursor: null });
      const memoryStatus = () => ({
        agentId: fixtureAgentId,
        settings: { agentId: fixtureAgentId, mode: state.memoryMode, updatedAtMs: Date.now() },
        conversationId: activeConversation()?.id || null,
        summary: { conversationId: activeConversation()?.id || "conv-live", throughSequenceId: 1, revision: 1, updatedAtMs: Date.now(), renderedTextBytes: 128 },
        counts: {
          active: state.memories.filter((item) => item.status === "active").length,
          pinned: state.memories.filter((item) => item.status === "active" && item.pinned).length,
          inactive: state.memories.filter((item) => item.status !== "active").length,
        },
        jobs: { pending: 0, running: 0, retry: 0, dead: [{ id: "job-1", conversationId: "conv-live", attempts: 1, lastErrorCode: "reflection_failed", lastErrorText: "segredo interno do job" }] },
      });
      current.getProviderConfig = async () => (logCall("getProviderConfig"), { agentId: state.currentAgentId, provider: "xai", model: "grok-4.6" });
      current.getPromptStatus = async () => (logCall("getPromptStatus"), { isBusy: state.busy, agentId: state.currentAgentId });
      current.createConversation = async () => {
        logCall("createConversation", { title: "Nova conversa" });
        state.createCalls += 1;
        const conversation = { id: "conv-new", agentId: fixtureAgentId, title: "Nova conversa", titleSource: "manual", temporary: false, archivedAtMs: null, createdAtMs: Date.now(), updatedAtMs: Date.now(), lastMessageAtMs: null };
        state.conversations = [conversation, ...state.conversations.filter((item) => item.id !== conversation.id)];
        state.activeConversationId = conversation.id;
        return { conversation, page: page() };
      };
      current.listConversations = async () => (logCall("listConversations"), page());
      current.getActiveConversation = async () => (logCall("getActiveConversation"), activeConversation());
      current.activateConversation = async ({ conversationId }) => {
        logCall("activateConversation", { conversationId });
        state.activeConversationId = conversationId;
        return { conversation: pickConversation(conversationId), page: page() };
      };
      current.renameConversation = async ({ conversationId, title }) => {
        logCall("renameConversation", { conversationId, title });
        const item = pickConversation(conversationId);
        if (!item) throw new Error("Conversa não encontrada");
        item.title = String(title || "").trim();
        item.updatedAtMs = Date.now();
        item.titleSource = "manual";
        return item;
      };
      current.archiveConversation = async ({ conversationId }) => {
        logCall("archiveConversation", { conversationId });
        const item = pickConversation(conversationId);
        if (!item) throw new Error("Conversa não encontrada");
        item.archivedAtMs = Date.now();
        item.updatedAtMs = item.archivedAtMs;
        if (state.activeConversationId === conversationId) state.activeConversationId = liveConversations().find((row) => row.id !== conversationId)?.id || conversationId;
        return { conversation: item, page: page() };
      };
      current.deleteConversation = async ({ conversationId }) => {
        logCall("deleteConversation", { conversationId, memoryPolicy: "delete-derived" });
        state.conversations = state.conversations.filter((item) => item.id !== conversationId);
        if (state.activeConversationId === conversationId) state.activeConversationId = liveConversations()[0]?.id || null;
        return { conversationId, memoryPolicy: "delete-derived", conversation: activeConversation(), page: page() };
      };
      current.getMemorySettings = async () => (logCall("getMemorySettings"), { agentId: fixtureAgentId, mode: state.memoryMode, updatedAtMs: Date.now(), internalOnly: "ignore" });
      current.setMemorySettings = async ({ mode }) => {
        logCall("setMemorySettings", { mode });
        state.memoryMode = mode;
        return { agentId: fixtureAgentId, mode: state.memoryMode, updatedAtMs: Date.now(), internalOnly: "ignore" };
      };
      current.listMemories = async () => (logCall("listMemories"), state.memories.slice());
      current.listMemoriesPage = async ({ cursor, limit = 20, query = "" } = {}) => {
        logCall("listMemoriesPage", { cursor, limit, query });
        const offset = typeof cursor === "string" && /^visual:(\d+)$/u.test(cursor) ? Number(cursor.slice(7)) : 0;
        const needle = String(query || "").trim().toLocaleLowerCase("pt-BR");
        const filtered = needle
          ? state.memories.filter((item) => [item.text, item.kind, item.status, item.sourceConversationId || ""].join(" ").toLocaleLowerCase("pt-BR").includes(needle))
          : state.memories;
        const items = filtered.slice(offset, offset + limit);
        const nextOffset = offset + items.length;
        return { items, ...(nextOffset < filtered.length ? { nextCursor: "visual:" + nextOffset } : {}) };
      };
      current.updateMemory = async ({ memoryId, pinned, text, importance }) => {
        logCall("updateMemory", { memoryId, pinned, text, importance });
        const memory = state.memories.find((item) => item.id === memoryId);
        if (!memory) throw new Error("Memória não encontrada");
        if (typeof pinned === "boolean") memory.pinned = pinned;
        if (typeof text === "string" && text.trim()) memory.text = text.trim();
        if (typeof importance === "number") memory.importance = importance;
        memory.updatedAtMs = Date.now();
        return memory;
      };
      current.deleteMemory = async ({ memoryId }) => {
        logCall("deleteMemory", { memoryId });
        const memory = state.memories.find((item) => item.id === memoryId);
        if (!memory) throw new Error("Memória não encontrada");
        memory.status = "forgotten";
        memory.updatedAtMs = Date.now();
        return memory;
      };
      current.getMemoryStatus = async () => (logCall("getMemoryStatus"), memoryStatus());
      current.searchMemoryHistory = async ({ query }) => (logCall("searchMemoryHistory", { query }), state.memories
        .filter((item) => item.text.toLowerCase().includes(String(query || "").toLowerCase()))
        .map((item) => ({ kind: "memory", snippet: item.text, score: 1, agentId: fixtureAgentId, conversationId: item.sourceConversationId, sequenceId: 1, provenance: { source: "memory", memoryId: item.id }, memory: item })));
      window.__openbotMemoryUiAgent = current;
      document.getElementById("openbot-provider-settings")?.remove();
      document.getElementById("openbot-memory-ui-fixture")?.remove();
      for (const button of [...document.querySelectorAll('[aria-label="View agent settings"]')]) {
        if (button.closest("#openbot-memory-ui-fixture")) continue;
        button.style.display = "none";
      }
      const fixture = document.createElement("section");
      fixture.id = "openbot-memory-ui-fixture";
      fixture.style.cssText = "position:fixed;left:24px;top:24px;width:min(720px,calc(100vw - 48px));padding:18px;background:#181818;color:#fff;border:1px solid #303030;border-radius:16px;z-index:2147482000";
      fixture.innerHTML = '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><strong>Bot Visual</strong><button type="button" aria-label="View agent settings" style="min-height:40px;padding:8px 12px">Configurações</button></div><div id="openbot-provider-settings" style="margin-top:18px;padding:16px;border:1px solid #303030;border-radius:12px;background:#202020"></div><textarea aria-label="Prompt" style="width:100%;min-height:72px;margin-top:18px;padding:10px;border-radius:12px;background:#111;color:#fff;border:1px solid #303030"></textarea>';
      document.body.prepend(fixture);
      fixture.appendChild(document.createComment("openbot-memory-ui-refresh"));
      window.dispatchEvent(new Event("openbot:memory-ui-rescan"));
      return true;
    })()`);
    const memoryUiDeadline = Date.now() + 3000;
    let memoryUiState = null;
    while (Date.now() < memoryUiDeadline) {
      memoryUiState = await evalExpr(`(() => ({
          hasMemoryScript: Boolean(document.querySelector("script[src*='openbot-memory-ui']")),
          hasMemorySection: Boolean(document.getElementById("openbot-memory-settings")),
          hasManageMemory: Boolean([...document.querySelectorAll("#openbot-memory-settings button")].find((el) => /Gerenciar memória/i.test(el.textContent || ""))),
        }))()`);
      if (memoryUiState?.hasMemorySection && memoryUiState?.hasManageMemory) break;
      await sleep(60);
    }
    console.log("MEMORY_UI_READY", JSON.stringify(memoryUiState, null, 2));
    if (!memoryUiState?.hasMemoryScript || !memoryUiState?.hasMemorySection || !memoryUiState?.hasManageMemory) {
      throw new Error(`conversation/memory UI did not mount: ${JSON.stringify(memoryUiState)}`);
    }
    await waitForEval("Boolean(document.querySelector('#openbot-memory-settings input[value=explicit]:not(:disabled)'))");
    await evalExpr(`(() => {
      const explicit = document.querySelector('#openbot-memory-settings input[value="explicit"]');
      if (!explicit) return false;
      explicit.checked = true;
      explicit.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    const memoryModeDeadline = Date.now() + 2000;
    let memoryModeState = null;
    while (Date.now() < memoryModeDeadline) {
      memoryModeState = await evalExpr(`window.__openbotMemoryUiState?.memoryMode`);
      if (memoryModeState === "explicit") break;
      await sleep(40);
    }
    if (memoryModeState !== "explicit") throw new Error(`memory mode update failed: ${memoryModeState}`);
    await evalExpr(`(() => { const button = [...document.querySelectorAll('#openbot-memory-settings button')].find((el) => /Gerenciar memória/i.test(el.textContent || '')); button?.click(); return Boolean(button); })()`);
    await sleep(260);
    const memoryDialog = await evalExpr(`(() => {
      const dialog = document.getElementById("openbot-memory-dialog");
      const panel = dialog?.querySelector('[role="dialog"]');
      const head = panel?.querySelector(".ob-dialog-head");
      const body = panel?.querySelector(".ob-dialog-body");
      const close = panel?.querySelector(".ob-close");
      const panelStyle = panel ? getComputedStyle(panel) : null;
      const bodyStyle = body ? getComputedStyle(body) : null;
      const closeStyle = close ? getComputedStyle(close) : null;
      const panelRect = panel?.getBoundingClientRect();
      const topElement = panelRect ? document.elementFromPoint(panelRect.left + panelRect.width / 2, panelRect.top + 12) : null;
      return {
        exists: Boolean(dialog),
        role: panel?.getAttribute("role") || null,
        modal: panel?.getAttribute("aria-modal") || null,
        jobsSanitized: /1 com falha/i.test(dialog?.innerText || "") && !/segredo interno do job/i.test(dialog?.innerText || ""),
        width: panel?.getBoundingClientRect().width || 0,
        height: panel?.getBoundingClientRect().height || 0,
        radius: panelStyle?.borderRadius || null,
        headHeight: head?.getBoundingClientRect().height || 0,
        bodyPadding: bodyStyle?.padding || null,
        closeHeight: close?.getBoundingClientRect().height || 0,
        closeRadius: closeStyle?.borderRadius || null,
        topmost: Boolean(panel && topElement && panel.contains(topElement)),
      };
    })()`);
    console.log("MEMORY_UI_DIALOG", JSON.stringify(memoryDialog, null, 2));
    if (!memoryDialog?.exists || memoryDialog.role !== "dialog" || memoryDialog.modal !== "true" || memoryDialog.jobsSanitized !== true || !memoryDialog.topmost || Math.abs(memoryDialog.width - 860) > 1 || Math.abs(memoryDialog.height - 620) > 1 || memoryDialog.radius !== "14px" || Math.abs(memoryDialog.headHeight - 54) > 1 || memoryDialog.bodyPadding !== "24px" || Math.abs(memoryDialog.closeHeight - 30) > 1 || memoryDialog.closeRadius !== "6px") {
      throw new Error(`memory dialog gate failed: ${JSON.stringify(memoryDialog)}`);
    }
    await shot("visual-memory-dialog");
    await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 640, deviceScaleFactor: 1, mobile: false });
    await sleep(220);
    const compactMemoryDialog = await evalExpr(`(() => { const panel = document.querySelector('#openbot-memory-dialog [role="dialog"]'); const rect = panel?.getBoundingClientRect(); return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, fits: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight, horizontalOverflow: panel.scrollWidth > panel.clientWidth } : null; })()`);
    if (!compactMemoryDialog?.fits || compactMemoryDialog.horizontalOverflow || compactMemoryDialog.width < 780 || compactMemoryDialog.height < 600) throw new Error(`memory dialog failed compact layout: ${JSON.stringify(compactMemoryDialog)}`);
    await shot("visual-memory-dialog-compact");
    await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    await sleep(220);
    await evalExpr(`(() => {
      const search = document.querySelector('#openbot-memory-dialog input[type="search"]');
      if (search) {
        search.value = "curtas";
        search.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return true;
    })()`);
    await sleep(180);
    const filteredSearch = await evalExpr(`(() => ({
      visibleItems: [...new Set([...document.querySelectorAll('#openbot-memory-dialog article[data-memory-id]')].map((el) => el.getAttribute('data-memory-id')))],
      containsPinnedPreference: /Prefere respostas curtas/i.test(document.getElementById("openbot-memory-dialog")?.innerText || ""),
      hidesOtherMemory: !/Valor inicial/i.test(document.getElementById("openbot-memory-dialog")?.innerText || ""),
    }))()`);
    console.log("MEMORY_UI_SEARCH", JSON.stringify(filteredSearch, null, 2));
    if (filteredSearch.visibleItems.length !== 1 || filteredSearch.visibleItems[0] !== "mem-2" || filteredSearch.containsPinnedPreference !== true || filteredSearch.hidesOtherMemory !== true) {
      throw new Error(`memory search filter failed: ${JSON.stringify(filteredSearch)}`);
    }
    await evalExpr(`(() => {
      const search = document.querySelector('#openbot-memory-dialog input[type="search"]');
      if (search) {
        search.value = "";
        search.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return true;
    })()`);
    // Search clear and each pin commit reload the list asynchronously (the toggle is disabled or absent meanwhile);
    // wait for the re-rendered, enabled toggle with the expected label instead of fixed delays.
    const waitForPinToggle = (label) => waitForEval(`(() => { const pin = [...document.querySelectorAll('#openbot-memory-dialog [data-action="toggle-pin"]')].find((el) => el.closest('[data-memory-id="mem-1"]')); return Boolean(pin && !pin.disabled && pin.textContent.trim() === ${JSON.stringify(label)}); })()`, 5000);
    await waitForPinToggle("Fixar");
    await evalExpr(`(() => {
      const pin = [...document.querySelectorAll('#openbot-memory-dialog [data-action="toggle-pin"]')].find((el) => el.closest('[data-memory-id="mem-1"]'));
      pin?.click();
      return true;
    })()`);
    await waitForPinToggle("Desafixar");
    await evalExpr(`(() => {
      const unpin = [...document.querySelectorAll('#openbot-memory-dialog [data-action="toggle-pin"]')].find((el) => el.closest('[data-memory-id="mem-1"]'));
      unpin?.click();
      return true;
    })()`);
    await waitForPinToggle("Fixar");
    await evalExpr(`(() => {
      const edit = [...document.querySelectorAll('#openbot-memory-dialog [data-action="edit-memory"]')].find((el) => el.closest('[data-memory-id="mem-1"]'));
      edit?.click();
      return true;
    })()`);
    await sleep(160);
    const memoryFocus = await evalExpr(`(() => {
      const active = document.activeElement;
      const textarea = document.querySelector('#openbot-memory-dialog textarea[data-role="memory-text"]');
      return {
        activeTag: active?.tagName || null,
        activeDataRole: active?.dataset?.role || null,
        statusRole: document.getElementById("openbot-memory-dialog-status")?.getAttribute("role") || null,
        alertRole: document.getElementById("openbot-memory-dialog-alert")?.getAttribute("role") || null,
        describedBy: textarea?.getAttribute("aria-describedby") || null,
      };
    })()`);
    console.log("MEMORY_UI_MEMORY_FOCUS", JSON.stringify(memoryFocus, null, 2));
    if (memoryFocus.activeDataRole !== "memory-text" || memoryFocus.activeTag !== "TEXTAREA" || memoryFocus.statusRole !== "status" || memoryFocus.alertRole !== null || !memoryFocus.describedBy?.includes("openbot-memory-dialog-status")) {
      throw new Error(`memory focus/status gate failed: ${JSON.stringify(memoryFocus)}`);
    }
    await evalExpr(`(() => {
      const textarea = document.querySelector('#openbot-memory-dialog textarea[data-role="memory-text"]');
      if (textarea) {
        textarea.value = "   ";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      document.querySelector('#openbot-memory-dialog [data-action="save-memory"]')?.click();
      return true;
    })()`);
    await sleep(160);
    const memoryValidation = await evalExpr(`(() => {
      const active = document.activeElement;
      const textarea = document.querySelector('#openbot-memory-dialog textarea[data-role="memory-text"]');
      const alert = document.getElementById("openbot-memory-dialog-alert");
      return {
        activeTag: active?.tagName || null,
        activeDataRole: active?.dataset?.role || null,
        invalid: textarea?.getAttribute("aria-invalid") || null,
        alertRole: alert?.getAttribute("role") || null,
        alertText: alert?.textContent?.trim() || "",
      };
    })()`);
    console.log("MEMORY_UI_MEMORY_ALERT", JSON.stringify(memoryValidation, null, 2));
    if (memoryValidation.activeDataRole !== "memory-text" || memoryValidation.activeTag !== "TEXTAREA" || memoryValidation.invalid !== "true" || memoryValidation.alertRole !== "alert" || !/não pode ficar vazio/i.test(memoryValidation.alertText)) {
      throw new Error(`memory validation gate failed: ${JSON.stringify(memoryValidation)}`);
    }
    await evalExpr(`(() => {
      const textarea = document.querySelector('#openbot-memory-dialog textarea[data-role="memory-text"]');
      if (textarea) {
        textarea.value = "Valor editado";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const select = document.querySelector('#openbot-memory-dialog select[data-role="memory-importance"]');
      if (select) {
        select.value = "75";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      document.querySelector('#openbot-memory-dialog [data-action="save-memory"]')?.click();
      return true;
    })()`);
    await sleep(240);
    await evalExpr(`(() => {
      const forget = [...document.querySelectorAll('#openbot-memory-dialog [data-action="forget-request"]')].find((el) => el.closest('[data-memory-id="mem-2"]'));
      forget?.click();
      return true;
    })()`);
    await sleep(160);
    const forgetFocus = await evalExpr(`(() => {
      const active = document.activeElement;
      return {
        activeTag: active?.tagName || null,
        activeAction: active?.dataset?.action || null,
        confirmVisible: Boolean(document.querySelector('#openbot-memory-dialog [data-action="forget-confirm"]')),
      };
    })()`);
    console.log("MEMORY_UI_MEMORY_FORGET_FOCUS", JSON.stringify(forgetFocus, null, 2));
    if (forgetFocus.activeAction !== "forget-cancel" || forgetFocus.activeTag !== "BUTTON" || forgetFocus.confirmVisible !== true) {
      throw new Error(`memory forget focus gate failed: ${JSON.stringify(forgetFocus)}`);
    }
    await evalExpr(`(() => {
      document.querySelector('#openbot-memory-dialog [data-action="forget-cancel"]')?.click();
      return true;
    })()`);
    await sleep(140);
    await evalExpr(`(() => {
      const forget = [...document.querySelectorAll('#openbot-memory-dialog [data-action="forget-request"]')].find((el) => el.closest('[data-memory-id="mem-2"]'));
      forget?.click();
      document.querySelector('#openbot-memory-dialog [data-action="forget-confirm"]')?.click();
      return true;
    })()`);
    await sleep(240);
    const memoryResult = await evalExpr(`(() => ({
      firstText: window.__openbotMemoryUiState?.memories?.find((item) => item.id === "mem-1")?.text || null,
      firstImportance: window.__openbotMemoryUiState?.memories?.find((item) => item.id === "mem-1")?.importance || null,
      firstPinned: window.__openbotMemoryUiState?.memories?.find((item) => item.id === "mem-1")?.pinned || false,
      secondStatus: window.__openbotMemoryUiState?.memories?.find((item) => item.id === "mem-2")?.status || null,
      memorySettingsCalls: window.__openbotMemoryUiState?.calls?.filter((item) => item.method === "setMemorySettings").length || 0,
      updateCalls: window.__openbotMemoryUiState?.calls?.filter((item) => item.method === "updateMemory").map((item) => item.payload) || [],
      deleteMemoryCalls: window.__openbotMemoryUiState?.calls?.filter((item) => item.method === "deleteMemory").length || 0,
      statusCalls: window.__openbotMemoryUiState?.calls?.filter((item) => item.method === "getMemoryStatus").length || 0,
    }))()`);
    console.log("MEMORY_UI_RESULT", JSON.stringify(memoryResult, null, 2));
    const pinTransitions = memoryResult.updateCalls.filter((item) => Object.prototype.hasOwnProperty.call(item, "pinned")).map((item) => item.pinned);
    if (memoryResult.firstText !== "Valor editado" || memoryResult.firstImportance !== 75 || memoryResult.firstPinned !== false || memoryResult.secondStatus !== "forgotten" || memoryResult.memorySettingsCalls < 1 || memoryResult.deleteMemoryCalls < 1 || memoryResult.statusCalls < 1 || pinTransitions.join(",") !== "true,false") {
      throw new Error(`memory edit/delete failed: ${JSON.stringify(memoryResult)}`);
    }
    await evalExpr(`document.querySelector('#openbot-memory-dialog [data-action="close-dialog"]')?.click()`);
    await sleep(180);
    const closeMemoryFocus = await evalExpr(`(() => ({
      dialogOpen: Boolean(document.getElementById("openbot-memory-dialog")),
      activeAction: document.activeElement?.dataset?.action || null,
      activeTag: document.activeElement?.tagName || null,
      activeLabel: document.activeElement?.getAttribute("aria-label") || null,
      activeText: document.activeElement?.textContent?.trim() || "",
    }))()`);
    console.log("MEMORY_UI_MEMORY_CLOSE_FOCUS", JSON.stringify(closeMemoryFocus, null, 2));
    if (closeMemoryFocus.dialogOpen !== false || !(
      closeMemoryFocus.activeAction === "open-memory-manager"
      || /Gerenciar memória/i.test(closeMemoryFocus.activeLabel || "")
      || /Gerenciar memória/i.test(closeMemoryFocus.activeText || "")
    )) {
      throw new Error(`memory close focus gate failed: ${JSON.stringify(closeMemoryFocus)}`);
    }
    await shot("visual-memory-ui");

    const repeatedSettingsMotion = [];
    for (let index = 1; index <= 2; index += 1) {
      const fixtureId = `openbot-motion-repeat-${index}`;
      await evalExpr(`(() => {
        document.getElementById("openbot-provider-settings")?.remove();
        for (const fixture of document.querySelectorAll('[id^="openbot-motion-repeat-"],#openbot-visual-settings-fixture')) fixture.remove();
        const fixture = document.createElement("section");
        fixture.id = ${JSON.stringify(fixtureId)};
        fixture.style.cssText = "position:fixed;right:24px;top:24px;width:360px;max-height:560px;overflow:auto;padding:18px;background:#202020;color:#fff;border-radius:16px;z-index:2147482000";
        fixture.innerHTML = '<label>Name</label><input value="Motion Bot"><label>Description</label><textarea>Repeated settings motion</textarea><label>Notifications</label><input type="checkbox">';
        document.body.appendChild(fixture);
        return true;
      })()`);
      const entering = await waitForMotion("#openbot-provider-settings");
      await sleep(220);
      const settled = await waitForMotion("#openbot-provider-settings", 100);
      repeatedSettingsMotion.push({ entering, settled });
      if (entering?.kind !== "settings" || entering.duration !== "180" || entering.runs !== "1" || entering.transforms?.length !== 0 || settled?.runs !== "1" || settled.activeAnimations !== 0) {
        throw new Error(`repeated settings motion failed on cycle ${index}: ${JSON.stringify({ entering, settled })}`);
      }
      await evalExpr(`document.getElementById(${JSON.stringify(fixtureId)})?.remove()`);
      await sleep(180);
    }
    console.log("SETTINGS_REPEAT_MOTION", JSON.stringify(repeatedSettingsMotion));

    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await evalExpr(`(() => {
      document.getElementById("openbot-provider-settings")?.remove();
      const fixture = document.createElement("section");
      fixture.id = "openbot-motion-reduced-fixture";
      fixture.style.cssText = "position:fixed;right:24px;top:24px;width:360px;padding:18px;background:#202020;color:#fff;border-radius:16px;z-index:2147482000";
      fixture.innerHTML = '<label>Name</label><input value="Reduced Bot"><label>Description</label><textarea>Reduced motion</textarea><label>Notifications</label><input type="checkbox">';
      document.body.appendChild(fixture);
      return true;
    })()`);
    const reducedMotion = await waitForMotion("#openbot-provider-settings");
    const reducedState = await evalExpr(`(() => {
      const fixture = document.getElementById("openbot-motion-reduced-fixture");
      const button = fixture?.querySelector("#openbot-save");
      const activeOpenBotAnimations = [...document.querySelectorAll('[data-openbot-motion]')]
        .reduce((count, element) => count + element.getAnimations().length, 0);
      return {
        matches: matchMedia("(prefers-reduced-motion: reduce)").matches,
        transitionDuration: button ? getComputedStyle(button).transitionDuration : null,
        activeOpenBotAnimations,
      };
    })()`);
    console.log("REDUCED_MOTION", JSON.stringify({ motion: reducedMotion, state: reducedState }));
    if (reducedMotion?.runs !== "1" || reducedMotion.activeAnimations !== 0 || !reducedState?.matches || reducedState.transitionDuration !== "0s" || reducedState.activeOpenBotAnimations !== 0) {
      throw new Error(`reduced motion gate failed: ${JSON.stringify({ motion: reducedMotion, state: reducedState })}`);
    }
    await shot("visual-reduced-motion");
    await evalExpr(`document.getElementById("openbot-motion-reduced-fixture")?.remove()`);
    await send("Emulation.setEmulatedMedia", { features: [] });
    await waitForEval("!matchMedia('(prefers-reduced-motion: reduce)').matches && !document.getElementById('openbot-motion-reduced-fixture')");

    // P2.2 — async-task/subagent surface verification on the real renderer.
    // Runs last because its simulated pagehide permanently closes both OpenBot
    // overlay scripts, which is exactly the teardown contract being verified.
    const p22Evidence = await runP22TasksFixture({ evalExpr, shot, sleep, send, log: (line, value) => console.log(line, typeof value === "string" ? value : JSON.stringify(value ?? null)) });
    console.log("P22_EVIDENCE", JSON.stringify({ ok: p22Evidence.ok, steps: p22Evidence.steps.length, screenshots: p22Evidence.screenshots }));
    if (!p22Evidence.ok) {
      throw new Error("P2.2 tasks surface fixture failed: " + JSON.stringify(p22Evidence.steps.filter((entry) => !entry.pass)));
    }

    await send("Performance.enable");
    const performanceBefore = await send("Performance.getMetrics");
    const idleWindowMs = 1500;
    await sleep(idleWindowMs);
    const performanceAfter = await send("Performance.getMetrics");
    const metric = (snapshot, name) => snapshot.metrics.find((entry) => entry.name === name)?.value || 0;
    const taskDurationDelta = metric(performanceAfter, "TaskDuration") - metric(performanceBefore, "TaskDuration");
    const rendererCpuPercent = (taskDurationDelta / (idleWindowMs / 1000)) * 100;
    const idleState = await evalExpr(`(() => ({
      activeOpenBotAnimations: [...document.querySelectorAll('[data-openbot-motion]')]
        .reduce((count, element) => count + element.getAnimations().length, 0),
      activeDocumentAnimations: document.getAnimations().length,
    }))()`);
    console.log("IDLE_MOTION_CPU", JSON.stringify({ idleWindowMs, taskDurationDelta, rendererCpuPercent, ...idleState }));
    if (idleState.activeOpenBotAnimations !== 0) {
      throw new Error(`idle motion/CPU gate failed: ${JSON.stringify({ rendererCpuPercent, ...idleState })}`);
    }
    console.log("VISUAL_EVIDENCE_DIR", evidenceDir);
    ws.close();
  } finally {
    await stopProcessTree(child, exited);
    await stopProcessTree(gatewayChild, gatewayExited);
    if (runRoot) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
