import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveElectronExecutable } from "./electron-executable.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(process.env.OPENBOT_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const electronExe = resolveElectronExecutable(repoRoot);
const electronMain = process.env.OPENBOT_ELECTRON_MAIN || join(repoRoot, "client", "extracted", "dist", "electron-main", "main.cjs");
const rememberPrompt = "Lembre que minha campanha principal é Aurora.";
const followupPrompt = "campanha principal Aurora";
const memoryBlockMarker = "[[OPENBOT_UNTRUSTED_MEMORY_CONTEXT_BEGIN]]";
const memoryDialogTitle = "Memórias do bot";
const conversationTitle = "Campanha Aurora";
const agentId = "memory-flow-bot";
const gatewayToken = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 32);
const compatApiKey = "memory-flow-openai-compat-key";
const originalNodeEnv = process.env.NODE_ENV;

process.env.NODE_ENV = "test";

const [
  { startServer, stopServer, GATEWAY_HOST },
  { createProviderRegistry },
  { OpenAiCompatAdapter },
  { createKeystore },
  { localFileBackend },
] = await Promise.all([
  import("../dist/main.js"),
  import("../dist/providers/router.js"),
  import("../dist/providers/openai-compat.js"),
  import("../dist/keystore/index.js"),
  import("../dist/keystore/backend.js"),
]);

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
  if (!port) throw new Error("Could not allocate a free port");
  return port;
}

async function waitFor(read, predicate, timeoutMs, label) {
  const startedAt = Date.now();
  let lastValue;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await read();
    if (predicate(lastValue)) return lastValue;
    await sleep(100);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(lastValue)}`);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? undefined : JSON.parse(raw);
}

function sseFrame(delta) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-memory-flow",
    object: "chat.completion.chunk",
    created: 1,
    model: "openai-compatible",
    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
  })}\n\n`;
}

async function startCompatFixture(expectedApiKey) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const body = await readJsonBody(req).catch(() => undefined);
    const purposeHeader = Array.isArray(req.headers["x-openbot-purpose"])
      ? req.headers["x-openbot-purpose"][0] ?? "turn"
      : typeof req.headers["x-openbot-purpose"] === "string"
        ? req.headers["x-openbot-purpose"]
        : "turn";
    const request = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: { ...req.headers },
      body,
      purpose: purposeHeader,
      deltas: [],
    };
    requests.push(request);

    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${expectedApiKey}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const push = async (chunk) => {
      request.deltas.push(chunk);
      res.write(sseFrame(chunk));
      await sleep(20);
    };

    if (purposeHeader === "memory-reflection") {
      const payloadMessage = Array.isArray(body?.messages)
        ? body.messages.find((message) => message?.role === "user" && typeof message?.content === "string")
        : null;
      const payload = JSON.parse(String(payloadMessage?.content ?? "{}"));
      const explicitMemoryEntry = Array.isArray(payload.entries)
        ? payload.entries.find((entry) => entry?.kind === "message" && entry?.role === "user" && typeof entry?.id === "string" && /\blembre\b/iu.test(String(entry?.content || "")))
        : null;
      const response = JSON.stringify({
        summary: {
          throughSequenceId: payload.throughSequenceId,
          summaryJson: {
            kind: "explicit-intent",
            subject: "campanha-principal",
            value: "Aurora",
          },
          renderedText: "Campanha principal registrada: Aurora.",
        },
        operations: [{
          op: "upsert",
          memory: {
            kind: "fact",
            canonicalKey: "campanha-principal",
            text: "Minha campanha principal é Aurora.",
            trust: "user",
            pinned: false,
            sourceEntryIds: explicitMemoryEntry ? [{ conversationId: payload.conversationId, entryId: explicitMemoryEntry.id }] : [],
          },
        }],
      });
      const step = Math.max(1, Math.ceil(response.length / 3));
      for (let index = 0; index < response.length; index += step) {
        await push(response.slice(index, index + step));
      }
      res.end("data: [DONE]\n\n");
      return;
    }

    const serializedMessages = JSON.stringify(body?.messages ?? []);
    const response = serializedMessages.includes(rememberPrompt)
      ? "Sua campanha principal é Aurora."
      : serializedMessages.includes(memoryBlockMarker) && serializedMessages.includes("Aurora")
        ? "Sua campanha principal é Aurora."
        : "Memória ausente.";
    for (const part of response.split(/(?<=\.)\s+/u)) {
      await push(part);
    }
    res.end("data: [DONE]\n\n");
  });

  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, GATEWAY_HOST, resolve);
  });
  return {
    baseUrl: `http://${GATEWAY_HOST}:${port}/v1`,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function rpc(port, token, method, body = {}) {
  const response = await fetch(`http://${GATEWAY_HOST}:${port}/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok || json?.ok !== true) {
    throw new Error(`RPC ${method} failed (${response.status}): ${JSON.stringify(json)}`);
  }
  return json.value;
}

async function waitForCdpTarget(cdpUrl, timeoutMs = 20000) {
  return waitFor(
    async () => {
      try {
        return await (await fetch(cdpUrl)).json();
      } catch {
        return [];
      }
    },
    (targets) => Array.isArray(targets) && targets.some((target) => target?.title === "OpenBot" && target?.type === "page"),
    timeoutMs,
    "CDP OpenBot page",
  ).then((targets) => targets.find((target) => target?.title === "OpenBot" && target?.type === "page"));
}

function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message?.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const entry of pending.values()) entry.reject(new Error("CDP websocket closed"));
    pending.clear();
  });
  const send = (method, params = {}) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return {
    ready,
    async close() {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    },
    send,
  };
}

async function stopProcessTree(child, exited) {
  if (!child?.pid) return;
  try {
    await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  } catch {}
  await Promise.race([exited, sleep(5000)]);
}

async function processAbsent(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (process.platform !== "win32") {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true });
    return !stdout.includes(`"${pid}"`);
  } catch {
    return true;
  }
}

function createTestKeystore(dir) {
  const backend = localFileBackend(Buffer.alloc(32, 7));
  return createKeystore({ dir, writeBackend: backend, legacyReadBackend: backend });
}

async function launchElectron({ label, evidenceDir, appData, localAppData, userData, dataRoot, gatewayPort, token }) {
  const cdpPort = await getFreePort();
  const stdoutPath = join(evidenceDir, `${label}.stdout.log`);
  const stderrPath = join(evidenceDir, `${label}.stderr.log`);
  const stdout = createWriteStream(stdoutPath, { flags: "a" });
  const stderr = createWriteStream(stderrPath, { flags: "a" });
  const closeLogs = async () => {
    await Promise.all([
      new Promise((resolve) => stdout.end(resolve)),
      new Promise((resolve) => stderr.end(resolve)),
    ]);
  };
  const env = { ...process.env };
  if (originalNodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = originalNodeEnv;
  env.APPDATA = appData;
  env.LOCALAPPDATA = localAppData;
  env.OPENBOT_USER_DATA = userData;
  env.OPENBOT_DATA_ROOT = dataRoot;
  env.OPENBOT_LOCAL_GATEWAY = "1";
  env.SAND_HOST_GATEWAY_URL = `http://${GATEWAY_HOST}:${gatewayPort}`;
  env.SAND_HOST_GATEWAY_TOKEN = token;
  let child;
  let exited = Promise.resolve();
  try {
    child = spawn(electronExe, [
      `--user-data-dir=${userData}`,
      "--no-sandbox",
      "--disable-gpu",
      `--remote-debugging-port=${cdpPort}`,
      electronMain,
    ], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(stdout);
    child.stderr?.pipe(stderr);
    exited = new Promise((resolve) => child.once("close", resolve));
    if (process.env.OPENBOT_MEMORY_FLOW_FORCE_LAUNCH_FAIL === "1") {
      throw new Error("forced launch failure after spawn");
    }
    const target = await waitForCdpTarget(`http://${GATEWAY_HOST}:${cdpPort}/json/list`);
    const cdp = connect(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Page.bringToFront");
    return {
      cdp,
      cdpPort,
      child,
      exited,
      stderrPath,
      stdoutPath,
      closeLogs,
    };
  } catch (error) {
    const pid = child?.pid ?? null;
    await stopProcessTree(child, exited);
    const absent = pid === null ? true : await processAbsent(pid);
    await closeLogs();
    if (process.env.OPENBOT_MEMORY_FLOW_FORCE_LAUNCH_FAIL === "1") {
      writeFileSync(join(evidenceDir, `${label}.launch-failure-cleanup.json`), `${JSON.stringify({ pid, processAbsent: absent }, null, 2)}\n`, "utf8");
    }
    throw error;
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

async function waitForEval(cdp, expression, predicate, timeoutMs, label) {
  return waitFor(() => evaluate(cdp, expression), predicate, timeoutMs, label);
}

async function dismissWelcome(cdp, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let clicked = false;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await evaluate(cdp, `(() => {
      const root = document.getElementById("openbot-welcome");
      const button = document.getElementById("openbot-welcome-continue");
      return {
        root: Boolean(root),
        button: Boolean(button),
        persisted: sessionStorage.getItem("openbot.welcome.completed.session.v1") === "1",
      };
    })()`);
    if (lastState?.button) {
      await evaluate(cdp, `document.getElementById("openbot-welcome-continue")?.click()`);
      clicked = true;
      await sleep(120);
      continue;
    }
    if (!lastState?.root && (lastState?.persisted || clicked)) return;
    await sleep(120);
  }
  if (lastState?.root) {
    throw new Error(`welcome dismissal did not finish: ${JSON.stringify(lastState)}`);
  }
}

async function waitForUiReady(cdp, expectedAgentId) {
  await waitForEval(
    cdp,
    `({
      readyState: document.readyState,
      title: document.title,
      hasRoot: Boolean(document.getElementById("root")),
      rootChildren: document.getElementById("root")?.children.length ?? 0,
    })`,
    (value) => value?.readyState === "complete" && value?.title === "OpenBot" && value?.hasRoot === true && value?.rootChildren > 0,
    20000,
    "renderer ready",
  );
  await waitForEval(
    cdp,
    `(() => {
      const settingsButton = [...document.querySelectorAll('[aria-label="View agent settings"]')]
        .find((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        });
      return {
        hasDesktop: typeof window.desktop?.agent === "object",
        providerAgentId: window.desktop?.agent ? null : null,
        hasSettingsButton: Boolean(settingsButton),
      };
    })()`,
    (value) => Boolean(value?.hasDesktop && value?.hasSettingsButton),
    20000,
    "desktop bridge and toolbar",
  );
  await waitForEval(
    cdp,
    `window.desktop.agent.getProviderConfig()`,
    (value) => value?.agentId === expectedAgentId,
    10000,
    "active agent",
  );
}

async function reconnectCdp(session) {
  const target = await waitForCdpTarget(`http://${GATEWAY_HOST}:${session.cdpPort}/json/list`);
  session.cdp = connect(target.webSocketDebuggerUrl);
  await session.cdp.ready;
  await session.cdp.send("Runtime.enable");
  await session.cdp.send("Page.enable");
  await session.cdp.send("DOM.enable");
  await session.cdp.send("Page.bringToFront");
}

async function reloadRenderer(session) {
  try {
    await session.cdp.send("Page.reload", { ignoreCache: false });
  } catch {}
  await session.cdp.close();
  await reconnectCdp(session);
  await waitForEval(
    session.cdp,
    `({
      readyState: document.readyState,
      title: document.title,
      hasRoot: Boolean(document.getElementById("root")),
      rootChildren: document.getElementById("root")?.children.length ?? 0,
      welcomePresent: Boolean(document.getElementById("openbot-welcome")),
    })`,
    (value) => value?.readyState === "complete" && value?.title === "OpenBot" && value?.hasRoot === true && value?.rootChildren > 0 && value?.welcomePresent === false,
    30000,
    "renderer reload",
  );
}

async function focusComposer(cdp) {
  const composerExpression = `(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.disabled && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const elements = [...document.querySelectorAll("textarea, input[type='text'], [contenteditable='true']")];
    const composer = elements.find((candidate) => {
      const placeholder = candidate.getAttribute("placeholder") ?? "";
      const label = candidate.getAttribute("aria-label") ?? "";
      return isVisible(candidate) && (
        candidate.matches("textarea, [contenteditable='true']") ||
        /message|prompt|mensagem/i.test(placeholder + " " + label)
      );
    });
    if (!composer) return null;
    composer.focus();
      if (composer.matches('[contenteditable="true"]')) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      composer.setAttribute("data-openbot-focus-target", "1");
      const rect = composer.getBoundingClientRect();
      const active = document.activeElement;
      return {
      focused: active === composer || composer.contains(active),
      activeTag: active?.tagName ?? null,
      composerTag: composer.tagName,
      centerX: rect.left + (rect.width / 2),
      centerY: rect.top + Math.min(rect.height / 2, 18),
    };
  })()`;
  await waitForEval(cdp, composerExpression, (value) => Boolean(value), 15000, "visible composer");
  const root = await cdp.send("DOM.getDocument", { depth: 1, pierce: true });
  const target = await cdp.send("DOM.querySelector", {
    nodeId: root.root.nodeId,
    selector: '[data-openbot-focus-target="1"]',
  });
  if (target?.nodeId) {
    try {
      await cdp.send("DOM.focus", { nodeId: target.nodeId });
    } catch {}
  }
  let lastProbe = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    lastProbe = await evaluate(cdp, composerExpression);
    if (lastProbe?.focused === true) return;
    if (Number.isFinite(lastProbe?.centerX) && Number.isFinite(lastProbe?.centerY)) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: lastProbe.centerX,
        y: lastProbe.centerY,
        button: "left",
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: lastProbe.centerX,
        y: lastProbe.centerY,
        button: "left",
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: lastProbe.centerX,
        y: lastProbe.centerY,
        button: "left",
        clickCount: 1,
      });
    }
    await sleep(150);
  }
  if (!lastProbe) throw new Error("Composer did not become available");
}

async function sendPromptThroughComposer(cdp, prompt) {
  await focusComposer(cdp);
  await cdp.send("Input.insertText", { text: prompt });
  const composerStateExpression = `(() => {
    const candidates = [...document.querySelectorAll("textarea, input[type='text'], [contenteditable='true']")];
    const composer = candidates.find((candidate) => {
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      const placeholder = candidate.getAttribute("placeholder") ?? "";
      const label = candidate.getAttribute("aria-label") ?? "";
      const visible = style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      const eligible = candidate.matches("textarea, [contenteditable='true']") || /message|prompt|mensagem/i.test(placeholder + " " + label);
      return visible && eligible;
    });
    const value = composer
      ? ("value" in composer ? composer.value : composer.innerText ?? composer.textContent ?? "")
      : "";
    return { hasText: String(value).trim().length > 0, value: String(value).slice(0, 500) };
  })()`;
  const inserted = await waitFor(
    () => evaluate(cdp, composerStateExpression),
    (value) => value?.hasText === true,
    1200,
    "composer text after Input.insertText",
  ).catch(() => null);
  if (inserted?.hasText !== true) {
    await evaluate(cdp, `(() => {
      const candidates = [...document.querySelectorAll("textarea, input[type='text'], [contenteditable='true']")];
      const composer = candidates.find((candidate) => {
        const style = getComputedStyle(candidate);
        const rect = candidate.getBoundingClientRect();
        const placeholder = candidate.getAttribute("placeholder") ?? "";
        const label = candidate.getAttribute("aria-label") ?? "";
        const visible = style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        const eligible = candidate.matches("textarea, [contenteditable='true']") || /message|prompt|mensagem/i.test(placeholder + " " + label);
        return visible && eligible;
      });
      if (!composer) return false;
      composer.focus();
      const fireInput = () => {
        try {
          composer.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: ${JSON.stringify(prompt)},
          }));
        } catch {
          composer.dispatchEvent(new Event("input", { bubbles: true }));
        }
      };
      if (composer.matches('[contenteditable="true"]')) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
        const commandWorked = typeof document.execCommand === "function"
          ? document.execCommand("insertText", false, ${JSON.stringify(prompt)})
          : false;
        if (!commandWorked) {
          composer.textContent = ${JSON.stringify(prompt)};
          fireInput();
        }
        return true;
      }
      if ("value" in composer) {
        composer.value = ${JSON.stringify(prompt)};
        fireInput();
        return true;
      }
      return false;
    })()`);
  }
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  const postEnter = await waitFor(
    () => evaluate(cdp, composerStateExpression),
    (value) => value?.hasText === false,
    1000,
    "composer clear after Enter",
  ).catch(() => null);
  if (postEnter?.hasText !== false) {
    const clickedSend = await evaluate(cdp, `(() => {
      const controls = [...document.querySelectorAll("button, [role='button']")];
      const send = controls.find((element) => /^Send message$/i.test(element.getAttribute("aria-label") || "") || /^Send message$/i.test((element.textContent || "").replace(/\\s+/g, " ").trim()));
      if (!(send instanceof HTMLElement)) return false;
      send.click();
      return true;
    })()`);
    if (!clickedSend) {
      throw new Error(`Enter did not submit and Send message button was unavailable: ${JSON.stringify(postEnter)}`);
    }
  }
  await waitForEval(
    cdp,
    `(() => {
      const mainText = document.querySelector("main.sand-chat")?.innerText || "";
      const candidates = [...document.querySelectorAll("textarea, input[type='text'], [contenteditable='true']")]
        .map((candidate) => {
          const style = getComputedStyle(candidate);
          const rect = candidate.getBoundingClientRect();
          const placeholder = candidate.getAttribute("placeholder") ?? "";
          const label = candidate.getAttribute("aria-label") ?? "";
          const visible = style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
          const eligible = candidate.matches("textarea, [contenteditable='true']") || /message|prompt|mensagem/i.test(placeholder + " " + label);
          return {
            tagName: candidate.tagName,
            visible,
            eligible,
            placeholder,
            label,
            className: candidate.className,
            text: ("value" in candidate ? candidate.value : candidate.textContent || "").slice(0, 200),
            rect: { width: rect.width, height: rect.height, left: rect.left, top: rect.top },
          };
        });
      const composer = [...document.querySelectorAll("textarea, input[type='text'], [contenteditable='true']")].find((candidate, index) => {
        const current = candidates[index];
        return current?.visible && current?.eligible;
      });
      const value = composer
        ? ("value" in composer ? composer.value : composer.textContent || "")
        : null;
      return {
        mainText,
        composerValue: value,
        activeTag: document.activeElement?.tagName ?? null,
        candidates,
      };
    })()`,
    (value) => value?.mainText?.includes(prompt) && value?.composerValue === "",
    15000,
    `prompt echo for ${prompt}`,
  );
}

async function clickAndWait(cdp, clickExpression, waitExpression, predicate, timeoutMs, label) {
  const clicked = await evaluate(cdp, clickExpression);
  if (!clicked) throw new Error(`Could not click ${label}`);
  return waitForEval(cdp, waitExpression, predicate, timeoutMs, label);
}

async function closeDialog(cdp, dialogId) {
  await evaluate(cdp, `(() => {
    const close = document.querySelector('#${dialogId} .ob-close');
    if (close instanceof HTMLElement) {
      close.click();
      return true;
    }
    return false;
  })()`);
  await waitForEval(cdp, `!document.getElementById(${JSON.stringify(dialogId)})`, Boolean, 5000, `close ${dialogId}`);
}

async function clickCenter(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "left",
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
}

async function providerSettingsVisible(cdp) {
  return waitForEval(
    cdp,
    `(() => {
      const root = document.getElementById("openbot-provider-settings");
      if (!(root instanceof HTMLElement)) return false;
      const style = getComputedStyle(root);
      const rect = root.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
    })()`,
    Boolean,
    1500,
    "provider settings section",
  ).catch(() => false);
}

async function memorySectionVisible(cdp) {
  return waitForEval(
    cdp,
    `(() => {
      const root = document.getElementById("openbot-memory-settings");
      if (!(root instanceof HTMLElement)) return false;
      const style = getComputedStyle(root);
      const rect = root.getBoundingClientRect();
      const button = [...root.querySelectorAll("button")].find((element) => /Gerenciar memória/i.test(element.textContent || ""));
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && button instanceof HTMLElement;
    })()`,
    Boolean,
    2000,
    "memory settings section",
  ).catch(() => false);
}

async function waitForMemoryUiIfNativeSettingsVisible(cdp, state) {
  if (state?.ariaExpanded !== "true") return false;
  if (!state?.controlledPanel || state.controlledPanel.display === "none" || (state.controlledPanel.rect?.width ?? 0) <= 0) return false;
  return waitForEval(
    cdp,
    `(() => {
      const root = document.getElementById("openbot-memory-settings");
      if (!(root instanceof HTMLElement)) return false;
      const style = getComputedStyle(root);
      const rect = root.getBoundingClientRect();
      const button = [...root.querySelectorAll("button")].find((element) => /Gerenciar memória/i.test(element.textContent || ""));
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && button instanceof HTMLElement;
    })()`,
    Boolean,
    3500,
    "memory settings section after opening native settings",
  ).catch(() => false);
}

async function inspectSettingsButtons(cdp) {
  return evaluate(cdp, `(() => {
    const describe = (element) => {
      if (!(element instanceof Element)) return null;
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        text: (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200),
        ariaLabel: element.getAttribute("aria-label"),
        role: element.getAttribute("role"),
        className: typeof element.className === "string" ? element.className : null,
        id: element.id || null,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      };
    };
    const buttons = [...document.querySelectorAll('[aria-label="View agent settings"]')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .map((button) => {
        const rect = button.getBoundingClientRect();
        const centerX = rect.left + (rect.width / 2);
        const centerY = rect.top + (rect.height / 2);
        const hit = document.elementFromPoint(centerX, centerY);
        const ancestors = [];
        let parent = button;
        for (let depth = 0; depth < 5 && parent; depth += 1) {
          ancestors.push(describe(parent));
          parent = parent.parentElement;
        }
        return {
          centerX,
          centerY,
          outerHTML: button.outerHTML.slice(0, 500),
          button: describe(button),
          hit: describe(hit),
          ancestors,
        };
      });
    return buttons;
  })()`);
}

async function inspectControlledSettingsState(cdp) {
  return evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('[aria-label="View agent settings"]')]
      .find((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
    const controlledId = button?.getAttribute("aria-controls") || null;
    const panel = controlledId ? document.getElementById(controlledId) : null;
    const describe = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        id: element.id || null,
        className: typeof element.className === "string" ? element.className : null,
        text: (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500),
        display: style.display,
        visibility: style.visibility,
        hidden: element.hidden,
        ariaHidden: element.getAttribute("aria-hidden"),
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      };
    };
    return {
      ariaExpanded: button?.getAttribute("aria-expanded") || null,
      controlledId,
      controlledPanel: describe(panel),
      providerPanel: describe(document.getElementById("openbot-provider-settings")),
    };
  })()`);
}

function recordCleanup(report, key, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      report.cleanup[key] = { ok: true };
    })
    .catch((error) => {
      report.cleanup[key] = { ok: false, error: error instanceof Error ? error.message : String(error) };
      throw error;
    });
}

export async function runMemoryFlowE2e() {
  let tempRoot = null;
  let evidenceDir = null;
  let firstHandle = null;
  let secondHandle = null;
  let firstSession = null;
  let secondSession = null;
  let provider = null;
  const report = {
    status: "running",
    prompts: {
      rememberPrompt,
      followupPrompt,
    },
    cleanup: {},
    firstBoot: {},
    secondBoot: {},
  };
  mkdirSync(join(repoRoot, "logs"), { recursive: true });
  evidenceDir = mkdtempSync(join(repoRoot, "logs", "memory-flow-e2e-"));
  try {
    tempRoot = mkdtempSync(join(tmpdir(), "openbot-memory-flow-e2e-"));
    const stateRoot = join(tempRoot, "state-root");
    const keystoreDir = join(stateRoot, "keys");
    const appData = join(tempRoot, "appdata");
    const localAppData = join(tempRoot, "localappdata");
    const userData = join(tempRoot, "user-data");
    mkdirSync(stateRoot, { recursive: true });
    mkdirSync(keystoreDir, { recursive: true });
    mkdirSync(appData, { recursive: true });
    mkdirSync(localAppData, { recursive: true });
    mkdirSync(userData, { recursive: true });
    provider = await startCompatFixture(compatApiKey);
    report.provider = { baseUrl: provider.baseUrl };
    const keystore = createTestKeystore(keystoreDir);
    const firstRegistry = createProviderRegistry();
    firstRegistry.register(new OpenAiCompatAdapter({ baseUrl: provider.baseUrl, keystore }));
    firstHandle = await startServer(0, {
      stateRoot,
      registry: firstRegistry,
      gatewayToken,
      keystore,
    });
    await rpc(firstHandle.port, gatewayToken, "setBoxSecrets", {
      entries: [{ provider: "openai-compat", apiKey: compatApiKey }],
    });
    await rpc(firstHandle.port, gatewayToken, "setProviderConfig", {
      provider: "openai-compat",
      model: "openai-compatible",
      baseURL: provider.baseUrl,
    });

    const createdAgent = await rpc(firstHandle.port, gatewayToken, "createAgent", {
      id: agentId,
      name: "Memory Flow Bot",
      origin: "test",
    });
    await rpc(firstHandle.port, gatewayToken, "openAgent", { id: agentId });
    const seededConversation = await rpc(firstHandle.port, gatewayToken, "createConversation", {
      agentId,
      title: conversationTitle,
    });
    const activeAfterCreate = await rpc(firstHandle.port, gatewayToken, "getActiveConversation", { agentId });
    if (activeAfterCreate?.id !== seededConversation.conversation.id) {
      throw new Error(`createConversation did not become active immediately: ${JSON.stringify(activeAfterCreate)}`);
    }
    report.firstBoot.setup = {
      agent: createdAgent.agent,
      seededConversationId: seededConversation.conversation.id,
      activeAfterCreate,
    };

    firstSession = await launchElectron({
      label: "electron-first",
      evidenceDir,
      appData,
      localAppData,
      userData,
      dataRoot: stateRoot,
      gatewayPort: firstHandle.port,
      token: gatewayToken,
    });
    await dismissWelcome(firstSession.cdp);
    await waitForUiReady(firstSession.cdp, agentId);
    const firstConversationId = seededConversation.conversation.id;
    try {
      await sendPromptThroughComposer(firstSession.cdp, rememberPrompt);
    } catch (error) {
      report.firstBoot.sendFailure = {
        requests: provider.requests,
        runnerStatus: firstHandle.runner.getStatus(),
        activeConversation: firstHandle.conversationStore.getActive(agentId),
        entries: firstHandle.store.getEntries(agentId, firstConversationId),
      };
      throw error;
    }

    await waitFor(
      async () => firstHandle.runner.getStatus(),
      (status) => status?.isBusy === false,
      20000,
      "first turn idle",
    );
    const completedJob = await waitFor(
      async () => firstHandle.store.memoryStore.listJobs(agentId, { limit: 10 }),
      (jobs) => jobs.some((job) => job.status === "complete"),
      20000,
      "memory reflection completion",
    );
    const firstSummary = firstHandle.store.memoryStore.getSummary(agentId, firstConversationId);
    const firstMemory = firstHandle.store.memoryStore.searchMemories(agentId, "Aurora")[0]?.memory
      ?? firstHandle.store.memoryStore.listMemories(agentId, { limit: 20 }).find((memory) => /Aurora/u.test(memory.text));
    if (firstSummary !== null) {
      throw new Error(`Unsolicited summary persisted: ${JSON.stringify(firstSummary)}`);
    }
    if (!firstMemory || firstMemory.trust !== "user" ||  firstMemory.pinned || !/Aurora/u.test(firstMemory.text)) {
      throw new Error(`Memory did not persist trust:user Aurora: ${JSON.stringify(firstMemory)}`);
    }
    const firstBootRequests = provider.requests.filter((request) => (
      request.headers["x-openbot-purpose"] === "turn" || request.headers["x-openbot-purpose"] === "memory-reflection"
    ));
    const firstTurnRequest = firstBootRequests.find((request) => JSON.stringify(request.body?.messages ?? []).includes(rememberPrompt));
    const firstReflectionRequest = firstBootRequests.find((request) => request.headers["x-openbot-purpose"] === "memory-reflection");
    if (firstTurnRequest?.headers.authorization !== `Bearer ${compatApiKey}`) {
      throw new Error(`turn request authorization mismatch: ${JSON.stringify(firstTurnRequest?.headers)}`);
    }
    if (firstTurnRequest?.body?.model !== "openai-compatible") {
      throw new Error(`turn request model mismatch: ${JSON.stringify(firstTurnRequest?.body)}`);
    }
    if (!firstReflectionRequest || firstReflectionRequest.headers.authorization !== `Bearer ${compatApiKey}` || firstReflectionRequest.deltas.length < 2) {
      throw new Error(`reflection request/stream mismatch: ${JSON.stringify(firstReflectionRequest)}`);
    }
    report.firstBoot.memory = {
      summary: firstSummary,
      memory: firstMemory,
      jobs: completedJob,
      requests: firstBootRequests,
    };

    await stopProcessTree(firstSession.child, firstSession.exited);
    await firstSession.cdp.close();
    await firstSession.closeLogs();
    firstSession = null;
    await stopServer(firstHandle);
    firstHandle = null;

    const secondRegistry = createProviderRegistry();
    secondRegistry.register(new OpenAiCompatAdapter({ baseUrl: provider.baseUrl, keystore }));
    secondHandle = await startServer(0, {
      stateRoot,
      registry: secondRegistry,
      gatewayToken,
      keystore,
    });
    await rpc(secondHandle.port, gatewayToken, "openAgent", { id: agentId });

    secondSession = await launchElectron({
      label: "electron-second",
      evidenceDir,
      appData,
      localAppData,
      userData,
      dataRoot: stateRoot,
      gatewayPort: secondHandle.port,
      token: gatewayToken,
    });
    await dismissWelcome(secondSession.cdp);
    await waitForUiReady(secondSession.cdp, agentId);

    const restartState = await evaluate(secondSession.cdp, `window.desktop.agent.getActiveConversation({ agentId: ${JSON.stringify(agentId)}, expectedAgentId: ${JSON.stringify(agentId)} })`);
    if (restartState?.id !== firstConversationId) {
      throw new Error(`Restart did not preserve the active conversation: ${JSON.stringify(restartState)}`);
    }

    await evaluate(secondSession.cdp,
      `window.desktop.agent.createConversation({ title: "Nova conversa", agentId: ${JSON.stringify(agentId)}, expectedAgentId: ${JSON.stringify(agentId)} })`,
    ).catch((error) => {
      if (!/Inspected target navigated or closed|Execution context was destroyed/u.test(error.message)) throw error;
    });
    const afterNewChatClick = await waitFor(
      () => evaluate(secondSession.cdp,
        `window.desktop?.agent?.getActiveConversation({ agentId: ${JSON.stringify(agentId)}, expectedAgentId: ${JSON.stringify(agentId)} })`,
      ).catch((error) => {
        if (!/Inspected target navigated or closed|Execution context was destroyed/u.test(error.message)) throw error;
        return undefined;
      }),
      (value) => Boolean(value?.id) && value.id !== firstConversationId,
      5000,
      "active conversation after new chat",
    );
    report.secondBoot.newChatClick = {
      activeBefore: restartState,
      activeAfter: afterNewChatClick,
    };

    let newConversationState = afterNewChatClick;
    if (newConversationState?.id === firstConversationId) {
      const alternateConversation = await evaluate(secondSession.cdp, `(async () => {
        const agentId = ${JSON.stringify(agentId)};
        const page = await window.desktop.agent.listConversations({ limit: 20, agentId, expectedAgentId: agentId });
        return (Array.isArray(page?.items) ? page.items : []).find((item) => item.id !== ${JSON.stringify(firstConversationId)}) || null;
      })()`);
      if (!alternateConversation?.id) {
        throw new Error("No alternate conversation available after new chat");
      }
      newConversationState = await waitForEval(
        secondSession.cdp,
        `(async () => {
          const agentId = ${JSON.stringify(agentId)};
          const conversationId = ${JSON.stringify(alternateConversation.id)};
          await window.desktop.agent.activateConversation({ conversationId, agentId, expectedAgentId: agentId });
          return window.desktop.agent.getActiveConversation({ agentId, expectedAgentId: agentId });
        })()`,
        (value) => Boolean(value?.id) && value.id !== firstConversationId,
        10000,
        "alternate conversation activation",
      );
    }
    const settledActiveConversationId = await waitFor(
      async () => secondHandle.conversationStore.getActive(agentId)?.id,
      (value) => typeof value === "string" && value.length > 0 && value !== firstConversationId,
      10000,
      "active conversation settle after history activation",
    );
    const newConversationId = settledActiveConversationId;
    report.secondBoot.newConversation = {
      uiResult: newConversationState,
      settledActiveConversationId,
    };
    const settingsButtons = await waitFor(
      () => inspectSettingsButtons(secondSession.cdp),
      (value) => Array.isArray(value) && value.length > 0,
      10000,
      "settings button coordinates",
    );
    report.secondBoot.settingsButtons = settingsButtons;
    let settingsOpened = false;
    for (const [index, button] of settingsButtons.entries()) {
      const attempts = [];
      const domClicked = await evaluate(secondSession.cdp, `(() => {
        const buttons = [...document.querySelectorAll('[aria-label="View agent settings"]')]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          });
        const target = buttons[${index}];
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      })()`);
      attempts.push({
        kind: "dom-click",
        ok: domClicked,
        opened: await memorySectionVisible(secondSession.cdp),
        state: await inspectControlledSettingsState(secondSession.cdp),
      });
      if (!attempts.at(-1)?.opened) {
        attempts[attempts.length - 1].opened = await waitForMemoryUiIfNativeSettingsVisible(secondSession.cdp, attempts.at(-1)?.state);
      }
      if (attempts.at(-1)?.opened) {
        settingsOpened = true;
        report.secondBoot.settingsOpenAttempt = { buttonIndex: index, attempts };
        break;
      }
      const focused = await evaluate(secondSession.cdp, `(() => {
        const buttons = [...document.querySelectorAll('[aria-label="View agent settings"]')]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          });
        const target = buttons[${index}];
        if (!(target instanceof HTMLElement)) return false;
        target.focus();
        return document.activeElement === target;
      })()`);
      if (focused) {
        await secondSession.cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
        await secondSession.cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
      }
      attempts.push({
        kind: "focus-enter",
        ok: focused,
        opened: await memorySectionVisible(secondSession.cdp),
        state: await inspectControlledSettingsState(secondSession.cdp),
      });
      if (!attempts.at(-1)?.opened) {
        attempts[attempts.length - 1].opened = await waitForMemoryUiIfNativeSettingsVisible(secondSession.cdp, attempts.at(-1)?.state);
      }
      if (attempts.at(-1)?.opened) {
        settingsOpened = true;
        report.secondBoot.settingsOpenAttempt = { buttonIndex: index, attempts };
        break;
      }
      await clickCenter(secondSession.cdp, button.centerX, button.centerY);
      attempts.push({
        kind: "cdp-click",
        ok: true,
        opened: await memorySectionVisible(secondSession.cdp),
        state: await inspectControlledSettingsState(secondSession.cdp),
      });
      if (!attempts.at(-1)?.opened) {
        attempts[attempts.length - 1].opened = await waitForMemoryUiIfNativeSettingsVisible(secondSession.cdp, attempts.at(-1)?.state);
      }
      if (attempts.at(-1)?.opened) {
        settingsOpened = true;
        report.secondBoot.settingsOpenAttempt = { buttonIndex: index, attempts };
        break;
      }
      report.secondBoot.settingsOpenAttempt = { buttonIndex: index, attempts };
    }
    if (!settingsOpened) {
      report.secondBoot.latentSettings = await inspectControlledSettingsState(secondSession.cdp);
      throw new Error(`provider settings section did not open from any visible settings button: ${JSON.stringify(settingsButtons)}`);
    }
    await waitForEval(
      secondSession.cdp,
      `(() => {
        const root = document.getElementById("openbot-memory-settings");
        if (!(root instanceof HTMLElement)) return false;
        const style = getComputedStyle(root);
        const rect = root.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
      })()`,
      Boolean,
      10000,
      "memory settings section",
    );

    const memorySectionState = await clickAndWait(
      secondSession.cdp,
      `(() => {
        const button = document.querySelector('#openbot-memory-settings [data-action="open-memory-manager"]');
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()`,
      `(() => {
        const dialog = document.getElementById("openbot-memory-dialog");
        return dialog ? {
          open: true,
          title: document.querySelector('#openbot-memory-dialog .ob-dialog-title')?.textContent || "",
          text: dialog.innerText || "",
        } : { open: false, title: "", text: "" };
      })()`,
      (value) => value?.open === true && value?.text?.includes("Aurora"),
      10000,
      "memory manager dialog",
    );
    if (!String(memorySectionState.title || "").includes(memoryDialogTitle)) {
      throw new Error(`Unexpected memory dialog title: ${JSON.stringify(memorySectionState)}`);
    }
    report.secondBoot.memoryDialog = memorySectionState;
    await closeDialog(secondSession.cdp, "openbot-memory-dialog");

    const followupRequestStart = provider.requests.length;
    let followupPersisted = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await sendPromptThroughComposer(secondSession.cdp, followupPrompt);
      followupPersisted = await waitFor(
        async () => secondHandle.store.getEntries(agentId, newConversationId),
        (entries) => entries.some((entry) => entry.kind === "message" && entry.role === "user" && entry.content === followupPrompt),
        attempt === 0 ? 5000 : 10000,
        `follow-up user entry after send ${attempt + 1}`,
      ).catch(() => null);
      if (followupPersisted) break;
    }
    if (!followupPersisted) throw new Error("Follow-up user entry did not persist through the real composer");
    await waitFor(
      async () => secondHandle.runner.getStatus(),
      (status) => status?.isBusy === false,
      20000,
      "followup turn idle",
    );

    const invocationSnapshot = provider.requests.slice(followupRequestStart);
    let followupRequest = null;
    for (let index = invocationSnapshot.length - 1; index >= 0; index -= 1) {
      const candidate = invocationSnapshot[index];
      if (candidate?.purpose === "memory-reflection") continue;
      if (JSON.stringify(candidate?.body?.messages ?? []).includes(followupPrompt)) {
        followupRequest = candidate;
        break;
      }
    }
    if (!followupRequest) {
      report.secondBoot.followupDiagnostics = {
        invocations: invocationSnapshot,
        runnerStatus: secondHandle.runner.getStatus(),
        activeConversation: secondHandle.conversationStore.getActive(agentId),
        firstConversationEntries: secondHandle.store.getEntries(agentId, firstConversationId),
        newConversationEntries: secondHandle.store.getEntries(agentId, newConversationId),
      };
      for (let index = invocationSnapshot.length - 1; index >= 0; index -= 1) {
        const candidate = invocationSnapshot[index];
        if (candidate?.purpose !== "memory-reflection") {
          followupRequest = candidate;
          break;
        }
      }
      if (!followupRequest) {
        throw new Error("Follow-up primary request was not recorded");
      }
    }
    await waitFor(
      async () => secondHandle.store.getEntries(agentId, newConversationId),
      (entries) => entries.some((entry) => entry.kind === "message" && entry.role === "user" && entry.content === followupPrompt),
      10000,
      "new conversation follow-up persistence",
    );
    await waitFor(
      async () => secondHandle.conversationStore.getActive(agentId),
      (conversation) => conversation?.id === newConversationId && conversation?.lastMessageAtMs !== null,
      10000,
      "active conversation metadata after follow-up",
    ).catch(() => null);
    const followupSerialized = JSON.stringify(followupRequest.body?.messages ?? []);
    if (followupRequest.headers.authorization !== `Bearer ${compatApiKey}` || followupRequest.headers["x-openbot-purpose"] !== "turn") {
      throw new Error(`Follow-up request headers mismatch: ${JSON.stringify(followupRequest.headers)}`);
    }
    if (followupRequest.body?.model !== "openai-compatible" || !followupSerialized.includes(memoryBlockMarker) || !followupSerialized.includes("Aurora")) {
      throw new Error(`Follow-up request did not include memory block with Aurora: ${JSON.stringify(followupRequest.body)}`);
    }

    const activeConversation = secondHandle.conversationStore.getActive(agentId);
    const oldEntries = secondHandle.store.getEntries(agentId, firstConversationId);
    const newEntries = secondHandle.store.getEntries(agentId, newConversationId);
    if (activeConversation?.id !== newConversationId) {
      throw new Error(`Active conversation drifted from the new chat: ${JSON.stringify(activeConversation)}`);
    }
    if (!oldEntries.some((entry) => entry.kind === "message" && entry.role === "user" && entry.content === rememberPrompt)) {
      throw new Error("Old conversation lost the original user prompt");
    }
    if (oldEntries.some((entry) => entry.kind === "message" && entry.role === "user" && entry.content === followupPrompt)) {
      throw new Error("Old conversation leaked the follow-up prompt");
    }
    if (!newEntries.some((entry) => entry.kind === "message" && entry.role === "user" && entry.content === followupPrompt)) {
      throw new Error("New conversation did not receive the follow-up prompt");
    }
    if (newEntries.some((entry) => entry.kind === "message" && entry.role === "user" && entry.content === rememberPrompt)) {
      throw new Error("New conversation leaked the original prompt");
    }

    report.secondBoot.followup = {
      request: followupRequest,
      activeConversation,
      firstConversationId,
      newConversationId,
      oldUserEntries: oldEntries.filter((entry) => entry.kind === "message" && entry.role === "user"),
      newUserEntries: newEntries.filter((entry) => entry.kind === "message" && entry.role === "user"),
      allInvocations: invocationSnapshot,
    };
    report.status = "green";
  } catch (error) {
    report.status = "red";
    report.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
    throw error;
  } finally {
    let cleanupError = null;
    const cleanupFailures = [];
    const captureCleanup = async (key, fn) => {
      try {
        await recordCleanup(report, key, fn);
      } catch (error) {
        cleanupFailures.push(error);
      }
    };
    if (secondSession) {
      await captureCleanup("electron-second", async () => {
        await stopProcessTree(secondSession.child, secondSession.exited);
        await secondSession.cdp.close();
        await secondSession.closeLogs();
      });
    }
    if (firstSession) {
      await captureCleanup("electron-first", async () => {
        await stopProcessTree(firstSession.child, firstSession.exited);
        await firstSession.cdp.close();
        await firstSession.closeLogs();
      });
    }
    if (secondHandle) await captureCleanup("server-second", () => stopServer(secondHandle));
    if (firstHandle) await captureCleanup("server-first", () => stopServer(firstHandle));
    if (provider) await captureCleanup("provider-fixture", () => provider.close());
    if (tempRoot) {
      await captureCleanup("temp-root", async () => {
        rmSync(tempRoot, { recursive: true, force: true });
      });
    }
    if (cleanupFailures.length > 0) {
      cleanupError = cleanupFailures.length === 1
        ? cleanupFailures[0]
        : new AggregateError(cleanupFailures, `memory-flow-e2e cleanup failed in ${cleanupFailures.length} steps`);
      if (report.status === "green") {
        report.status = "red";
        report.error = {
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          stack: cleanupError instanceof Error ? cleanupError.stack : undefined,
        };
      }
    }
    if (evidenceDir) {
      writeFileSync(join(evidenceDir, "memory-flow-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log("MEMORY_FLOW_E2E_EVIDENCE_DIR", evidenceDir);
    }
    if (cleanupError) throw cleanupError;
  }
  console.log("MEMORY_FLOW_E2E_GREEN");
}

runMemoryFlowE2e().catch((error) => {
  console.error(error);
  process.exit(1);
});
