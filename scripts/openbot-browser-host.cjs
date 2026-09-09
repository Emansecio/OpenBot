// OpenBot's browser host is deliberately a small private service: commands
// arrive through an authenticated Windows named pipe and responses use the
// inherited stdout channel.
// It has no listening socket, no remote-debugging port, and never accepts
// arbitrary JavaScript from the caller. The manager supplies the auth token
// out-of-band in the environment and sends only structured commands.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
const { app, BrowserWindow, nativeImage, session } = require("electron");

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_SNAPSHOT_TEXT_BYTES = 128 * 1024;
// A screenshot is returned inside the authenticated JSON frame. Keep the
// encoded image comfortably below MAX_FRAME_BYTES so metadata and JSON
// escaping cannot turn an otherwise valid image into an oversized frame.
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_SCREENSHOT_DIMENSION = 8192;
const MAX_SCREENSHOT_PIXELS = 16 * 1024 * 1024;
const DEFAULT_MAX_DOWNLOAD_BYTES = 1024 * 1024;
const MAX_UPLOAD_PATH_BYTES = 4096;
const MAX_UPLOAD_SELECTOR_BYTES = 4096;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const INVALID_UPLOAD_COMPONENT = /[<>:"|?*\u0000-\u001f]/u;
const RESERVED_UPLOAD_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu;
const AUTH_TOKEN = process.env.OPENBOT_BROWSER_AUTH_TOKEN || "";
const USER_DATA_ROOT = process.env.OPENBOT_BROWSER_USER_DATA_ROOT || "";
const DOWNLOADS_ROOT = process.env.OPENBOT_BROWSER_DOWNLOADS_ROOT || "";
const COMMAND_PIPE = parseCommandPipe(process.env.OPENBOT_BROWSER_COMMAND_PIPE);
const PROXY_URL = process.env.OPENBOT_BROWSER_PROXY_URL || "";
const PROXY_TOKEN = process.env.OPENBOT_BROWSER_PROXY_TOKEN || "";
const MAX_DOWNLOAD_BYTES = parseDownloadLimit(process.env.OPENBOT_BROWSER_MAX_DOWNLOAD_BYTES);
const PROXY = parseProxy(PROXY_URL, PROXY_TOKEN);
const TABS = new Map();
const DOWNLOAD_SESSIONS = new WeakSet();
const DOWNLOAD_CONFIG = new WeakMap();
const SECURED_SESSIONS = new WeakSet();
const MAX_ACTIVE_REQUESTS = 4;
const MAX_AGENT_QUEUE = 16;
const MAX_TOTAL_QUEUE = 64;
const AGENT_QUEUES = new Map();
const REQUESTS = new Map();
const AGENT_ORDER = [];
let agentCursor = 0;
let activeRequestCount = 0;
let commandInput = null;
let inputPaused = false;
let outputTail = Promise.resolve();
let keepAliveWindow = null;
let shuttingDown = false;
let fatalErrorHandled = false;

// Electron's default uncaught-exception path can open a native error dialog
// on Windows. The browser host is a child owned by the manager, so a fatal
// host error must be serialized to stderr and terminate the child instead of
// waiting for UI interaction that the manager cannot observe.
process.on("uncaughtException", (error) => {
  failFastHost("uncaughtException", error);
});
process.on("unhandledRejection", (reason) => {
  failFastHost("unhandledRejection", reason);
});

function failFastHost(kind, error) {
  if (fatalErrorHandled) return;
  fatalErrorHandled = true;
  process.exitCode = 1;
  try {
    process.stderr.write(`OpenBot browser host ${kind}: ${sanitizeError(error)}\n`);
  } catch {
    // The process is already failing; stderr is best-effort only.
  }
  void shutdown().catch((shutdownError) => {
    try {
      process.stderr.write(`OpenBot browser host shutdown: ${sanitizeError(shutdownError)}\n`);
    } catch {
      // Preserve the non-zero fail-fast exit even when cleanup logging fails.
    }
  }).finally(() => {
    setImmediate(() => process.exit(1));
  });
}

// Test-only fault injection proves the fatal path is non-interactive. It is
// gated by NODE_ENV so production launches cannot enable it accidentally.
if (process.env.NODE_ENV === "test" && process.env.OPENBOT_BROWSER_TEST_INJECT_FATAL === "uncaught") {
  setImmediate(() => {
    throw new Error("injected browser host exception");
  });
}

// Register this before `ready`: a host starts without windows and must remain
// alive long enough to receive its first authenticated `open` command.
app.on("window-all-closed", () => {
  // The stdio manager owns host lifetime. A closed visible window must not
  // silently terminate other agents' tabs.
});
app.on("before-quit", (event) => {
  // Electron may decide to quit while the host is idle with zero windows.
  // Only the authenticated stdio owner is allowed to end the shared host.
  if (!shuttingDown) event.preventDefault();
});

// These switches are process-wide and must be applied before Chromium starts.
// They prevent network paths that do not honor the authenticated HTTP proxy.
app.commandLine.appendSwitch("disable-quic");
app.commandLine.appendSwitch("disable-features", "DnsOverHttps,UseDnsHttpsSvcbAlpn,AsyncDns,EncryptedClientHello");
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");

app.on("login", (event, _webContents, _request, authInfo, callback) => {
  event.preventDefault();
  if (
    PROXY !== null &&
    authInfo &&
    
    authInfo.isProxy &&
    authInfo.host === PROXY.host &&
    Number(authInfo.port) === PROXY.port
  ) {
    callback("openbot", PROXY.token);
    return;
  }
  // Never answer origin/server authentication challenges. In particular, do
  // not leak the proxy credential to an application login prompt.
  callback();
});

if (!AUTH_TOKEN || !USER_DATA_ROOT || !path.isAbsolute(USER_DATA_ROOT) || !DOWNLOADS_ROOT || !path.isAbsolute(DOWNLOADS_ROOT) || PROXY === null || MAX_DOWNLOAD_BYTES === null || COMMAND_PIPE === null) {
  process.stderr.write("OpenBot browser host requires authenticated launch configuration\n");
  process.exitCode = 78;
  setImmediate(() => process.exit(78));
} else {
  void main().catch((error) => {
    process.stderr.write(`${sanitizeError(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  // Electron persists `persist:` partitions below userData. Set it before
  // ready so no profile state can fall back to the process/default location.
  await ensureManagedUserDataRoot();
  app.setPath("userData", path.resolve(USER_DATA_ROOT));
  await app.whenReady();
  // Electron on Windows exits immediately when no BrowserWindow exists, even
  // if the stdio manager is still attached. Keep one hidden local window alive
  // so the authenticated owner controls host lifetime explicitly.
  keepAliveWindow = new BrowserWindow({
    show: false,
    frame: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    width: 1,
    height: 1,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      webSecurity: true,
    },
  });
  const commandSocket = await openCommandInput();
  send({ protocolVersion: PROTOCOL_VERSION, kind: "ready", hostVersion: "1.0.0" });
  const input = readline.createInterface({ input: commandSocket, crlfDelay: Infinity });
  commandInput = input;
  input.on("line", (line) => {
    void handleLine(line).catch((error) => {
      process.stderr.write(`${sanitizeError(error)}\n`);
    });
  });
  input.on("close", () => {
    void shutdown();
  });
}

async function handleLine(line) {
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    throw new Error("browser frame exceeds maximum size");
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    throw new Error("browser host received invalid JSON");
  }
  if (!isValidRequest(request) || !safeEqual(request.token, AUTH_TOKEN)) {
    if (isRecord(request) && typeof request.id === "string") {
      sendError(request.id, "BROWSER_UNAUTHORIZED", "browser request was not authorized");
    }
    return;
  }
  if (request.command.command === "cancel") {
    handleCancel(request);
    return;
  }
  enqueueRequest(request);
}

function enqueueRequest(request) {
  pruneEmptyAgentQueues();
  const existingQueue = AGENT_QUEUES.get(request.agentId);
  const queuedCount = AGENT_ORDER.reduce((total, agentId) => total + (AGENT_QUEUES.get(agentId)?.items.length ?? 0), 0);
  if ((existingQueue?.items.length ?? 0) >= MAX_AGENT_QUEUE || queuedCount >= MAX_TOTAL_QUEUE) {
    void sendError(request.id, "BROWSER_QUEUE_FULL", "browser host queue is full");
    maybeResumeInput();
    return;
  }
  const agentQueue = existingQueue ?? { items: [], active: null };
  if (existingQueue === undefined) {
    AGENT_QUEUES.set(request.agentId, agentQueue);
    AGENT_ORDER.push(request.agentId);
  }
  const item = {
    request,
    controller: new AbortController(),
    cancelled: false,
    responded: false,
  };
  agentQueue.items.push(item);
  REQUESTS.set(request.id, item);
  pumpScheduler();
  if (queuedCount + 1 >= MAX_TOTAL_QUEUE && commandInput !== null && !inputPaused) {
    inputPaused = true;
    commandInput.pause();
  }
}

function handleCancel(request) {
  const targetId = request.command.targetId;
  const item = REQUESTS.get(targetId);
  if (item !== undefined && ownsRequest(item.request, request)) {
    item.cancelled = true;
    item.controller.abort();
    if (item.request.id !== targetId) return;
    if (!item.responded) {
      item.responded = true;
      void sendError(item.request.id, "BROWSER_COMMAND_ABORTED", "browser command was aborted");
    }
    const queue = AGENT_QUEUES.get(item.request.agentId);
    if (queue?.active !== item) {
      if (queue !== undefined) queue.items = queue.items.filter((candidate) => candidate !== item);
      REQUESTS.delete(item.request.id);
    }
    // A cancelled active item still owns its scheduler slot until the
    // underlying browser operation returns through runScheduledRequest.
    pumpScheduler();
  }
  void send({
    protocolVersion: PROTOCOL_VERSION,
    kind: "response",
    id: request.id,
    ok: true,
    result: { command: "cancel", tabId: request.tabId, visible: false },
  });
}

function ownsRequest(target, cancel) {
  return target.agentId === cancel.agentId && target.sessionId === cancel.sessionId && target.tabId === cancel.tabId && target.partition === cancel.partition;
}

function pumpScheduler() {
  while (activeRequestCount < MAX_ACTIVE_REQUESTS) {
    const item = takeNextRequest();
    if (item === null) break;
    const queue = AGENT_QUEUES.get(item.request.agentId);
    if (queue === undefined) continue;
    queue.active = item;
    activeRequestCount += 1;
    void runScheduledRequest(item);
  }
  maybeResumeInput();
}

function takeNextRequest() {
  pruneEmptyAgentQueues();
  if (AGENT_ORDER.length === 0) return null;
  for (let offset = 0; offset < AGENT_ORDER.length; offset += 1) {
    const index = (agentCursor + offset) % AGENT_ORDER.length;
    const agentId = AGENT_ORDER[index];
    const queue = AGENT_QUEUES.get(agentId);
    if (queue === undefined || queue.active !== null || queue.items.length === 0) continue;
    agentCursor = (index + 1) % AGENT_ORDER.length;
    return queue.items.shift() || null;
  }
  return null;
}

async function runScheduledRequest(item) {
  try {
    const result = await execute(item.request, item.controller.signal);
    if (!item.responded && !item.cancelled) {
      item.responded = true;
      await send({ protocolVersion: PROTOCOL_VERSION, kind: "response", id: item.request.id, ok: true, result });
    }
  } catch (error) {
    if (!item.responded && !item.cancelled) {
      item.responded = true;
      await sendError(item.request.id, error && typeof error.code === "string" ? error.code : "BROWSER_COMMAND_FAILED", sanitizeError(error));
    }
  } finally {
    const queue = AGENT_QUEUES.get(item.request.agentId);
    if (queue?.active === item) queue.active = null;
    REQUESTS.delete(item.request.id);
    activeRequestCount = Math.max(0, activeRequestCount - 1);
    if (queue !== undefined && queue.items.length === 0 && queue.active === null) removeAgentQueue(item.request.agentId, queue);
    pumpScheduler();
  }
}

function pruneEmptyAgentQueues() {
  for (const [agentId, queue] of AGENT_QUEUES) {
    if (queue.active === null && queue.items.length === 0) removeAgentQueue(agentId, queue);
  }
}

function removeAgentQueue(agentId, queue) {
  if (AGENT_QUEUES.get(agentId) !== queue) return;
  AGENT_QUEUES.delete(agentId);
  const index = AGENT_ORDER.indexOf(agentId);
  if (index < 0) return;
  AGENT_ORDER.splice(index, 1);
  if (AGENT_ORDER.length === 0) {
    agentCursor = 0;
  } else {
    if (index < agentCursor) agentCursor -= 1;
    agentCursor %= AGENT_ORDER.length;
  }
}

function maybeResumeInput() {
  if (commandInput === null || !inputPaused) return;
  const queuedCount = AGENT_ORDER.reduce((total, agentId) => total + (AGENT_QUEUES.get(agentId)?.items.length ?? 0), 0);
  if (queuedCount < Math.floor(MAX_TOTAL_QUEUE / 2)) {
    inputPaused = false;
    commandInput.resume();
  }
}

async function execute(request, signal) {
  throwIfAborted(signal);
  switch (request.command.command) {
    case "open":
      return openTab(request, signal);
    case "navigate":
      return navigateTab(request, signal);
    case "snapshot":
      return snapshotTab(request, signal);
    case "click":
      return clickTab(request, signal);
    case "click_element":
      return clickElementTab(request, signal);
    case "scroll":
      return scrollTab(request, signal);
    case "press_key":
      return pressKeyTab(request, signal);
    case "type":
      return typeTab(request, signal);
    case "upload":
      return uploadTab(request, signal);
    case "screenshot":
      return screenshotTab(request, signal);
    case "close":
      return closeTab(request, signal);
    case "handoff":
      return handoffTab(request, signal);
    case "reset":
      return resetPartition(request, signal);
    default:
      throw browserError("BROWSER_COMMAND_INVALID", "browser command is not supported");
  }
}

async function openTab(request, signal) {
  throwIfAborted(signal);
  let tab = TABS.get(request.tabId);
  if (!tab) tab = await createTab(request, signal);
  assertTabOwnership(tab, request);
  const url = request.command.url || "about:blank";
  assertSafeUrl(url, true);
  assertWindowAlive(tab.window);
  if (tab.window.webContents.getURL() !== url) await loadUrl(tab.window, url, signal);
  throwIfAborted(signal);
  assertWindowAlive(tab.window);
  tab.window.show();
  return resultBase("open", request.tabId, tab.window, { visible: true });
}

async function navigateTab(request, signal) {
  throwIfAborted(signal);
  const tab = getTab(request);
  const url = request.command.url;
  assertSafeUrl(url, false);
  await loadUrl(tab.window, url, signal);
  throwIfAborted(signal);
  assertWindowAlive(tab.window);
  return resultBase("navigate", request.tabId, tab.window);
}

async function snapshotTab(request, signal) {
  throwIfAborted(signal);
  const tab = getTab(request);
  const screenshot = await capture(tab.window, false, signal);
  let text;
  if (request.command.includeText !== false) {
    text = await readVisibleText(tab.window, signal);
  }
  const elements = await readInteractiveElements(tab.window, signal);
  tab.actionElementIds = new Set(elements.map((element) => element.id));
  throwIfAborted(signal);
  assertWindowAlive(tab.window);
  return {
    command: "snapshot",
    tabId: request.tabId,
    snapshot: {
      url: tab.window.webContents.getURL(),
      title: tab.window.webContents.getTitle(),
      ...(text === undefined ? {} : { text }),
      elements,
      screenshot,
      viewport: {
        width: screenshot.width,
        height: screenshot.height,
        deviceScaleFactor: tab.window.webContents.getZoomFactor(),
      },
    },
  };
}

async function clickTab(request, signal) {
  throwIfAborted(signal);
  const tab = getTab(request);
  assertWindowAlive(tab.window);
  const bounds = tab.window.getContentBounds();
  const { x, y, button = "left", clickCount = 1 } = request.command;
  if (x > bounds.width || y > bounds.height) throw browserError("BROWSER_COORDINATES_INVALID", "click is outside the browser viewport");
  tab.window.show();
  tab.window.focus();
  tab.window.webContents.sendInputEvent({ type: "mouseDown", x, y, button, clickCount });
  tab.window.webContents.sendInputEvent({ type: "mouseUp", x, y, button, clickCount });
  throwIfAborted(signal);
  return resultBase("click", request.tabId, tab.window);
}

async function clickElementTab(request, signal) {
  throwIfAborted(signal);
  const tab = getTab(request);
  const id = request.command.elementId;
  if (!(tab.actionElementIds instanceof Set) || !tab.actionElementIds.has(id)) {
    throw browserError("BROWSER_ELEMENT_STALE", "browser element id is stale; take a new snapshot");
  }
  assertWindowAlive(tab.window);
  const point = await tab.window.webContents.executeJavaScript(`(() => {
    const id = ${JSON.stringify(id)};
    const element = document.querySelector('[data-openbot-element-id="' + id + '"]');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`, true);
  throwIfAborted(signal);
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw browserError("BROWSER_ELEMENT_STALE", "browser element is no longer actionable; take a new snapshot");
  }
  const bounds = tab.window.getContentBounds();
  if (point.x < 0 || point.y < 0 || point.x > bounds.width || point.y > bounds.height) {
    throw browserError("BROWSER_ELEMENT_OUTSIDE_VIEWPORT", "browser element is outside the viewport; scroll and take a new snapshot");
  }
  tab.window.show();
  tab.window.focus();
  tab.window.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
  tab.window.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
  return resultBase("click_element", request.tabId, tab.window);
}

async function scrollTab(request, signal) {
  throwIfAborted(signal);
  const tab = getTab(request);
  assertWindowAlive(tab.window);
  const { deltaX, deltaY } = request.command;
  await tab.window.webContents.executeJavaScript(`(() => {
    window.scrollBy({ left: ${Number(deltaX)}, top: ${Number(deltaY)}, behavior: 'auto' });
    return { x: window.scrollX, y: window.scrollY };
  })()`, true);
  throwIfAborted(signal);
  tab.actionElementIds = new Set();
  return resultBase("scroll", request.tabId, tab.window);
}

async function pressKeyTab(request, signal) {
  throwIfAborted(signal);
  const tab = getTab(request);
  assertWindowAlive(tab.window);
  const keyCodes = {
    ENTER: "Enter",
    TAB: "Tab",
    ESCAPE: "Escape",
    SPACE: "Space",
    ARROWUP: "ArrowUp",
    ARROWDOWN: "ArrowDown",
    ARROWLEFT: "ArrowLeft",
    ARROWRIGHT: "ArrowRight",
    BACKSPACE: "Backspace",
  };
  const keyCode = keyCodes[request.command.key];
  if (!keyCode) throw browserError("BROWSER_KEY_INVALID", "browser key is invalid");
  tab.window.show();
  tab.window.focus();
  tab.window.webContents.sendInputEvent({ type: "keyDown", keyCode });
  tab.window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  throwIfAborted(signal);
  return resultBase("press_key", request.tabId, tab.window);
}

async function typeTab(request, signal) {
  throwIfAborted(signal);
  const tab = getTab(request);
  assertWindowAlive(tab.window);
  tab.window.show();
  tab.window.focus();
  await tab.window.webContents.insertText(request.command.text);
  throwIfAborted(signal);
  assertWindowAlive(tab.window);
  return resultBase("type", request.tabId, tab.window);
}

async function uploadTab(request, signal) {
  throwIfAborted(signal);
  const tab = getTab(request);
  const source = await readUploadFile(request.homeRoot, request.command.path);
  throwIfAborted(signal);
  assertWindowAlive(tab.window);
  let assigned;
  try {
    assertWindowAlive(tab.window);
    assigned = await tab.window.webContents.executeJavaScript(`(() => {
      const selector = ${JSON.stringify(request.command.selector)};
      let input;
      try {
        input = document.querySelector(selector);
      } catch {
        return { ok: false, code: "BROWSER_UPLOAD_SELECTOR_INVALID" };
      }
      if (!(input instanceof HTMLInputElement) || input.type.toLowerCase() !== "file") {
        return { ok: false, code: "BROWSER_UPLOAD_INPUT_INVALID" };
      }
      try {
        const binary = atob(${JSON.stringify(source.dataBase64)});
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const file = new File([bytes], ${JSON.stringify(source.fileName)}, { type: "application/octet-stream" });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, bytes: file.size };
      } catch {
        return { ok: false, code: "BROWSER_UPLOAD_ASSIGN_FAILED" };
      }
    })()`, true);
  } catch {
    throw browserError("BROWSER_UPLOAD_EXECUTION_FAILED", "browser file upload could not be applied");
  }
  throwIfAborted(signal);
  assertWindowAlive(tab.window);
  if (!assigned || assigned.ok !== true || assigned.bytes !== source.bytes) {
    const code = assigned && typeof assigned.code === "string" ? assigned.code : "BROWSER_UPLOAD_ASSIGN_FAILED";
    const messages = {
      BROWSER_UPLOAD_SELECTOR_INVALID: "browser upload selector is invalid",
      BROWSER_UPLOAD_INPUT_INVALID: "browser upload target is not a file input",
      BROWSER_UPLOAD_ASSIGN_FAILED: "browser file upload could not be applied",
    };
    throw browserError(code, messages[code] || "browser file upload could not be applied");
  }
  return resultBase("upload", request.tabId, tab.window, {
    upload: {
      selector: request.command.selector,
      fileName: source.fileName,
      bytes: source.bytes,
    },
  });
}

async function screenshotTab(request, signal) {
  throwIfAborted(signal);
  const tab = getTab(request);
  assertWindowAlive(tab.window);
  return resultBase("screenshot", request.tabId, tab.window, {
    screenshot: await capture(tab.window, request.command.fullPage === true, signal),
  });
}

async function closeTab(request, signal) {
  throwIfAborted(signal);
  const tab = TABS.get(request.tabId);
  if (tab) {
    assertTabOwnership(tab, request);
    TABS.delete(request.tabId);
    if (!tab.window.isDestroyed()) tab.window.close();
  }
  return { command: "close", tabId: request.tabId, visible: false };
}

async function handoffTab(request, signal) {
  throwIfAborted(signal);
  const tab = getTab(request);
  assertWindowAlive(tab.window);
  tab.window.show();
  tab.window.focus();
  return resultBase("handoff", request.tabId, tab.window, { visible: true });
}

async function resetPartition(request, signal) {
  throwIfAborted(signal);
  for (const [tabId, tab] of TABS) {
    if (tab.partition !== request.partition) continue;
    TABS.delete(tabId);
    if (!tab.window.isDestroyed()) tab.window.destroy();
  }
  const browserSession = session.fromPartition(request.partition);
  await browserSession.clearStorageData();
  throwIfAborted(signal);
  if (typeof browserSession.clearCache === "function") await browserSession.clearCache();
  throwIfAborted(signal);
  await fsp.rm(partitionRootFor(request.partition), { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  return { command: "reset", tabId: request.tabId, visible: false };
}

async function createTab(request, signal) {
  throwIfAborted(signal);
  const downloadRoot = await ensureDownloadRoot(request.downloadRoot);
  const window = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    webPreferences: {
      partition: request.partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      plugins: false,
      enableWebSQL: false,
    },
  });
  try {
    // This is intentionally awaited before the first loadURL call. An
    // unconfigured session is never allowed to reach the network.
    await secureBrowserSession(window.webContents.session);
    throwIfAborted(signal);
    assertWindowAlive(window);
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
  const tab = {
    window,
    agentId: request.agentId,
    sessionId: request.sessionId,
    partition: request.partition,
    downloadRoot,
    actionElementIds: new Set(),
  };
  TABS.set(request.tabId, tab);
  const browserSession = window.webContents.session;
  let downloadConfigs = DOWNLOAD_CONFIG.get(browserSession);
  if (!DOWNLOAD_SESSIONS.has(browserSession)) {
    DOWNLOAD_SESSIONS.add(browserSession);
    downloadConfigs = new Map();
    DOWNLOAD_CONFIG.set(browserSession, downloadConfigs);
    browserSession.on("will-download", (_event, item, webContents) => {
      const config = downloadConfigs.get(webContents?.id);
      if (!config) return;
      const filename = safeFilename(item.getFilename());
      let savePath;
      try {
        savePath = uniqueDownloadPath(config.root, filename);
      } catch {
        item.cancel();
        return;
      }
      const expectedBytes = item.getTotalBytes();
      let limitExceeded = Number.isFinite(expectedBytes) && expectedBytes > MAX_DOWNLOAD_BYTES;
      let receivedBytes = 0;
      item.setSavePath(savePath);
      if (limitExceeded) item.cancel();
      item.on("updated", (_updatedEvent, state) => {
        receivedBytes = Math.max(receivedBytes, item.getReceivedBytes());
        if (state === "progressing" && receivedBytes > MAX_DOWNLOAD_BYTES && !limitExceeded) {
          limitExceeded = true;
          item.cancel();
        }
      });
      item.once("done", (_doneEvent, state) => {
        receivedBytes = Math.max(receivedBytes, item.getReceivedBytes());
        const lifecycle = limitExceeded ? "limit" : state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
        void (async () => {
          if (lifecycle !== "completed") await fsp.rm(savePath, { force: true }).catch(() => undefined);
          send({
            protocolVersion: PROTOCOL_VERSION,
            kind: "event",
            event: "download",
            tabId: config.tabId,
            path: savePath,
            state: lifecycle,
            bytes: receivedBytes,
          });
        })().catch(() => undefined);
      });
    });
  }
  // Electron can destroy webContents before emitting the BrowserWindow
  // `closed` callback. Capture the numeric id while it is still valid so
  // cleanup never dereferences a destroyed WebContents object.
  const webContentsId = window.webContents.id;
  downloadConfigs.set(webContentsId, {
    root: downloadRoot,
    tabId: request.tabId,
    agentId: request.agentId,
    sessionId: request.sessionId,
  });
  attachWindowSecurity(window);
  window.on("closed", () => {
    if (TABS.get(request.tabId)?.window === window) TABS.delete(request.tabId);
    downloadConfigs.delete(webContentsId);
  });
  return tab;
}

async function secureBrowserSession(browserSession) {
  if (SECURED_SESSIONS.has(browserSession)) return;
  if (PROXY === null) throw browserError("BROWSER_PROXY_UNAVAILABLE", "browser proxy configuration is invalid");
  // Chromium implicitly bypasses loopback unless this explicit negation rule
  // is present. Localhost must reach the proxy so its egress policy can deny
  // local, LAN, and metadata targets consistently.
  await browserSession.setProxy({
    mode: "fixed_servers",
    proxyRules: PROXY.rules,
    proxyBypassRules: "<-loopback>",
  });
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  if (typeof browserSession.setDevicePermissionHandler === "function") {
    browserSession.setDevicePermissionHandler(() => false);
  }
  // The scoped app login handler supplies proxy credentials. Injecting the
  // restricted Proxy-Authorization header breaks Chromium download requests.
  browserSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    let protocol = "";
    try {
      protocol = new URL(details.url).protocol.toLowerCase();
    } catch {
      callback({ cancel: true });
      return;
    }
    const mainFrameBlank = details.resourceType === "mainFrame" && details.url === "about:blank";
    const allowed = protocol === "http:" || protocol === "https:" || protocol === "blob:" || mainFrameBlank;
    callback({ cancel: !allowed });
  });
  SECURED_SESSIONS.add(browserSession);
}

function attachWindowSecurity(window) {
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  const validateNavigation = (event, url) => {
    if (!isNetworkUrl(url)) event.preventDefault();
  };
  contents.on("will-navigate", validateNavigation);
  contents.on("will-redirect", validateNavigation);
}

function isNetworkUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function getTab(request) {
  const tab = TABS.get(request.tabId);
  if (!tab) throw browserError("BROWSER_TAB_NOT_FOUND", "browser tab is not open");
  assertTabOwnership(tab, request);
  return tab;
}

function assertTabOwnership(tab, request) {
  if (tab.agentId !== request.agentId || tab.sessionId !== request.sessionId || tab.partition !== request.partition) {
    throw browserError("BROWSER_TAB_FORBIDDEN", "browser tab does not belong to this lease");
  }
}

async function loadUrl(window, url, signal) {
  throwIfAborted(signal);
  assertWindowAlive(window);
  let timeoutId;
  let abortHandler;
  let navigation;
  try {
    navigation = Promise.resolve().then(() => window.loadURL(url));
    await Promise.race([
      navigation,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          safeStopLoading(window);
          reject(browserError("BROWSER_NAVIGATION_TIMEOUT", "browser navigation timed out"));
        }, 45_000);
      }),
      new Promise((_, reject) => {
        if (signal === undefined) return;
        abortHandler = () => {
          safeStopLoading(window);
          reject(browserAbortError());
        };
        signal.addEventListener("abort", abortHandler, { once: true });
        if (signal.aborted) abortHandler();
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
    if (signal !== undefined && abortHandler !== undefined) signal.removeEventListener("abort", abortHandler);
  }
}

function delayWithAbort(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    let abortHandler;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal !== undefined && abortHandler !== undefined) signal.removeEventListener("abort", abortHandler);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    if (signal !== undefined) {
      abortHandler = () => {
        cleanup();
        reject(browserAbortError());
      };
      signal.addEventListener("abort", abortHandler, { once: true });
      if (signal.aborted) abortHandler();
    }
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw browserAbortError();
}

function browserAbortError() {
  return browserError("BROWSER_COMMAND_ABORTED", "browser command was aborted");
}

function assertWindowAlive(window) {
  try {
    if (!window || (typeof window.isDestroyed === "function" && window.isDestroyed()) || (window.webContents !== undefined && typeof window.webContents.isDestroyed === "function" && window.webContents.isDestroyed())) {
      throw browserError("BROWSER_TAB_CLOSED", "browser tab is no longer available");
    }
  } catch (error) {
    if (error && typeof error.code === "string") throw error;
    throw browserError("BROWSER_TAB_CLOSED", "browser tab is no longer available");
  }
}

function safeStopLoading(window) {
  try {
    if (!window || window.isDestroyed() || !window.webContents || window.webContents.isDestroyed()) return;
    if (typeof window.webContents.stop === "function") window.webContents.stop();
  } catch {
    // Cancellation races with window teardown are intentionally harmless.
  }
}

async function capture(window, fullPage, signal) {
  throwIfAborted(signal);
  if (fullPage) return captureFullPage(window, signal);
  return captureViewport(window, signal);
}

async function captureViewport(window, signal) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    throwIfAborted(signal);
    assertWindowAlive(window);
    let image;
    try {
      image = await window.webContents.capturePage();
    } catch (error) {
      // A newly opened window can have no compositor frame yet.
      if (!String(error?.message ?? error).includes("UnknownVizError") || attempt === 4) throw error;
      await delayWithAbort(50, signal);
      continue;
    }
    throwIfAborted(signal);
    const size = image.getSize();
    const png = image.toPNG();
    if (size.width > 0 && size.height > 0 && png.length > 0) {
      return formatScreenshot(png, size, "viewport");
    }
    await delayWithAbort(50, signal);
  }
  throw browserError("BROWSER_CAPTURE_EMPTY", "browser did not produce a non-empty frame");
}

async function captureFullPage(window, signal) {
  throwIfAborted(signal);
  assertWindowAlive(window);
  const metrics = await readPageMetrics(window, signal);
  assertScreenshotBounds(metrics.width, metrics.height, metrics.deviceScaleFactor, "full-page capture");

  // This is the in-process DevTools implementation exposed by Electron. It
  // does not open a debugging port or accept caller-supplied JavaScript; the
  // only command issued is the bounded, read-only screenshot operation.
  assertWindowAlive(window);
  const debuggerApi = window.webContents.debugger;
  if (!debuggerApi || typeof debuggerApi.attach !== "function" || typeof debuggerApi.sendCommand !== "function") {
    throw browserError("BROWSER_FULL_PAGE_UNAVAILABLE", "full-page browser capture is unavailable");
  }
  let attachedByUs = false;
  try {
    if (typeof debuggerApi.isAttached !== "function" || !debuggerApi.isAttached()) {
      debuggerApi.attach("1.3");
      attachedByUs = true;
    }
    throwIfAborted(signal);
    const result = await debuggerApi.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: metrics.width, height: metrics.height, scale: 1 },
    });
    throwIfAborted(signal);
    const encoded = result && typeof result.data === "string" ? result.data : "";
    const png = Buffer.from(encoded, "base64");
    const image = nativeImage.createFromBuffer(png);
    const size = image.getSize();
    return formatScreenshot(png, size, "full-page");
  } catch (error) {
    if (error && typeof error === "object" && typeof error.code === "string" && error.code.startsWith("BROWSER_")) throw error;
    throw browserError("BROWSER_FULL_PAGE_UNAVAILABLE", "full-page browser capture is unavailable");
  } finally {
    if (attachedByUs) {
      try {
        debuggerApi.detach();
      } catch {
        // The renderer may already have gone away; the host still tears down
        // the tab and profile through its normal lifecycle.
      }
    }
  }
}

async function readPageMetrics(window, signal) {
  let metrics;
  try {
    throwIfAborted(signal);
    assertWindowAlive(window);
    metrics = await window.webContents.executeJavaScript(`(() => {
      const root = document.documentElement;
      const body = document.body;
      const width = Math.max(root?.scrollWidth || 0, root?.clientWidth || 0, body?.scrollWidth || 0, window.innerWidth || 0);
      const height = Math.max(root?.scrollHeight || 0, root?.clientHeight || 0, body?.scrollHeight || 0, window.innerHeight || 0);
      return { width, height, deviceScaleFactor: window.devicePixelRatio || 1 };
    })()`, true);
  } catch (error) {
    if (error && typeof error.code === "string" && error.code === "BROWSER_COMMAND_ABORTED") throw error;
    throw browserError("BROWSER_FULL_PAGE_UNAVAILABLE", "could not measure the page for full-page capture");
  }
  if (!metrics || typeof metrics !== "object") throw browserError("BROWSER_FULL_PAGE_UNAVAILABLE", "could not measure the page for full-page capture");
  const width = Number(metrics.width);
  const height = Number(metrics.height);
  const deviceScaleFactor = Number(metrics.deviceScaleFactor);
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) {
    throw browserError("BROWSER_FULL_PAGE_UNAVAILABLE", "page dimensions are invalid for full-page capture");
  }
  return {
    width: Math.ceil(width),
    height: Math.ceil(height),
    deviceScaleFactor,
  };
}

function assertScreenshotBounds(width, height, deviceScaleFactor, context) {
  const physicalWidth = Math.ceil(width * deviceScaleFactor);
  const physicalHeight = Math.ceil(height * deviceScaleFactor);
  if (
    !Number.isSafeInteger(physicalWidth) ||
    !Number.isSafeInteger(physicalHeight) ||
    physicalWidth < 1 ||
    physicalHeight < 1 ||
    physicalWidth > MAX_SCREENSHOT_DIMENSION ||
    physicalHeight > MAX_SCREENSHOT_DIMENSION ||
    physicalWidth * physicalHeight > MAX_SCREENSHOT_PIXELS
  ) {
    throw browserError("BROWSER_SCREENSHOT_LIMIT", `${context} exceeds the safe screenshot dimensions`);
  }
}

function formatScreenshot(png, size, context) {
  if (!Buffer.isBuffer(png) || png.length === 0 || !size || size.width < 1 || size.height < 1) {
    throw browserError("BROWSER_CAPTURE_EMPTY", `${context} produced an empty frame`);
  }
  if (png.length > MAX_SCREENSHOT_BYTES) {
    throw browserError("BROWSER_SCREENSHOT_LIMIT", `${context} exceeds the safe screenshot byte limit`);
  }
  assertScreenshotBounds(size.width, size.height, 1, context);
  return {
    mimeType: "image/png",
    dataBase64: png.toString("base64"),
    width: size.width,
    height: size.height,
  };
}

async function readVisibleText(window, signal) {
  throwIfAborted(signal);
  assertWindowAlive(window);
  const value = await window.webContents.executeJavaScript(
    "(() => { const body = document.body; if (!body) return ''; let result = ''; let count = 0; for (const character of body.innerText || '') { if (count >= 131072) break; result += character; count += 1; } return result; })()",
    true,
  );
  throwIfAborted(signal);
  const text = typeof value === "string" ? value : "";
  return truncateUtf8(text, MAX_SNAPSHOT_TEXT_BYTES);
}

function truncateUtf8(value, maxBytes) {
  const characters = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    characters.push(character);
    bytes += characterBytes;
  }
  return characters.join("");
}

async function readInteractiveElements(window, signal) {
  throwIfAborted(signal);
  assertWindowAlive(window);
  const value = await window.webContents.executeJavaScript(`(() => {
    const attribute = 'data-openbot-element-id';
    document.querySelectorAll('[' + attribute + ']').forEach((element) => element.removeAttribute(attribute));
    const selector = 'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[tabindex]';
    const result = [];
    const roleFor = (element) => {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button') return 'button';
        return 'textbox';
      }
      return 'interactive';
    };
    for (const element of document.querySelectorAll(selector)) {
      if (result.length >= 200) break;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) continue;
      const id = 'ob-el-' + (result.length + 1);
      element.setAttribute(attribute, id);
      const name = (element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || element.innerText || element.value || '').replace(/\\s+/g, ' ').trim().slice(0, 256);
      result.push({
        id,
        role: roleFor(element),
        name,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        ...((element.disabled === true || element.getAttribute('aria-disabled') === 'true') ? { disabled: true } : {}),
      });
    }
    return result;
  })()`, true);
  throwIfAborted(signal);
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200);
}

function resultBase(command, tabId, window, extra = {}) {
  assertWindowAlive(window);
  return {
    command,
    tabId,
    url: window.webContents.getURL(),
    title: window.webContents.getTitle(),
    ...extra,
  };
}

async function ensureDownloadRoot(root) {
  const normalized = assertDownloadRoot(root);
  const base = path.resolve(DOWNLOADS_ROOT);
  await fsp.mkdir(base, { recursive: true });
  const baseMetadata = await fsp.lstat(base);
  if (baseMetadata.isSymbolicLink() || !baseMetadata.isDirectory()) {
    throw browserError("BROWSER_DOWNLOAD_ROOT_INVALID", "managed browser root is unsafe");
  }
  const realBase = await fsp.realpath(base);
  const relation = path.relative(realBase, normalized);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw browserError("BROWSER_DOWNLOAD_ROOT_INVALID", "download root is outside the managed browser root");
  }
  let current = realBase;
  for (const component of relation ? relation.split(path.sep) : []) {
    current = path.join(current, component);
    try {
      const metadata = await fsp.lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw browserError("BROWSER_DOWNLOAD_ROOT_INVALID", "download root contains an unsafe path component");
      }
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        await fsp.mkdir(current);
      } else {
        throw error;
      }
    }
  }
  return current;
}

async function ensureManagedUserDataRoot() {
  const normalized = path.resolve(USER_DATA_ROOT);
  const parsed = path.parse(normalized);
  await fsp.mkdir(normalized, { recursive: true });
  let current = parsed.root;
  const relation = path.relative(parsed.root, normalized);
  for (const component of relation ? relation.split(path.sep) : []) {
    current = path.join(current, component);
    const metadata = await fsp.lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw browserError("BROWSER_USER_DATA_ROOT_INVALID", "managed user-data root contains an unsafe path component");
    }
  }
  return normalized;
}

function assertDownloadRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw browserError("BROWSER_DOWNLOAD_ROOT_INVALID", "download root must be absolute");
  const base = path.resolve(DOWNLOADS_ROOT);
  const candidate = path.resolve(root);
  if (!isPathWithin(base, candidate)) {
    throw browserError("BROWSER_DOWNLOAD_ROOT_INVALID", "download root is outside the managed browser root");
  }
  return candidate;
}

async function readUploadFile(homeRoot, relativePath) {
  const resolved = await resolveUploadPath(homeRoot, relativePath);
  const candidate = resolved.candidate;
  let handle;
  try {
    handle = await fsp.open(candidate, "r");
    await assertUploadHandlePathSafety(resolved.canonicalRoot, candidate, handle);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw browserError("BROWSER_UPLOAD_PATH_INVALID", "browser upload path is not a regular file");
    assertUploadLinkSafety(metadata);
    if (!Number.isSafeInteger(metadata.size) || metadata.size > MAX_UPLOAD_BYTES) {
      throw browserError("BROWSER_UPLOAD_FILE_TOO_LARGE", "browser upload file exceeds the byte limit");
    }

    const contents = Buffer.allocUnsafe(MAX_UPLOAD_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < contents.length) {
      const result = await handle.read(contents, bytesRead, contents.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_UPLOAD_BYTES) throw browserError("BROWSER_UPLOAD_FILE_TOO_LARGE", "browser upload file exceeds the byte limit");
    const finalMetadata = await handle.stat();
    if (!finalMetadata.isFile()) throw browserError("BROWSER_UPLOAD_PATH_INVALID", "browser upload path is not a regular file");
    assertUploadLinkSafety(finalMetadata);
    if (!Number.isSafeInteger(finalMetadata.size) || finalMetadata.size > MAX_UPLOAD_BYTES) {
      throw browserError("BROWSER_UPLOAD_FILE_TOO_LARGE", "browser upload file exceeds the byte limit");
    }
    return {
      fileName: safeFilename(path.basename(candidate)),
      bytes: bytesRead,
      dataBase64: contents.subarray(0, bytesRead).toString("base64"),
    };
  } catch (error) {
    if (error && typeof error.code === "string" && error.code.startsWith("BROWSER_UPLOAD_")) throw error;
    if (error && typeof error.code === "string" && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw browserError("BROWSER_UPLOAD_FILE_NOT_FOUND", "browser upload file was not found");
    }
    if (error && typeof error.code === "string" && (error.code === "EACCES" || error.code === "EPERM")) {
      throw browserError("BROWSER_UPLOAD_ACCESS_DENIED", "browser upload file cannot be accessed");
    }
    throw browserError("BROWSER_UPLOAD_READ_FAILED", "browser upload file could not be read");
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

async function resolveUploadPath(homeRoot, relativePath) {
  assertUploadHomeRoot(homeRoot);
  assertUploadRelativePath(relativePath);
  const root = path.resolve(homeRoot);
  let rootMetadata;
  try {
    rootMetadata = await fsp.lstat(root);
  } catch (error) {
    if (error && typeof error.code === "string" && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw browserError("BROWSER_UPLOAD_FILE_NOT_FOUND", "browser upload file was not found");
    }
    throw browserError("BROWSER_UPLOAD_PATH_INVALID", "browser upload home is invalid or unsafe");
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw browserError("BROWSER_UPLOAD_PATH_INVALID", "browser upload home is invalid or unsafe");
  }

  let canonicalRoot;
  try {
    canonicalRoot = await fsp.realpath(root);
  } catch {
    throw browserError("BROWSER_UPLOAD_PATH_INVALID", "browser upload home is invalid or unsafe");
  }
  const candidate = path.resolve(canonicalRoot, relativePath);
  if (!isPathWithin(canonicalRoot, candidate) || path.resolve(candidate) === path.resolve(canonicalRoot)) {
    throw browserError("BROWSER_UPLOAD_PATH_INVALID", "browser upload path is invalid or unsafe");
  }

  const relation = path.relative(canonicalRoot, candidate);
  let current = canonicalRoot;
  const components = relation.split(path.sep);
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    let metadata;
    try {
      metadata = await fsp.lstat(current);
    } catch (error) {
      if (error && typeof error.code === "string" && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        throw browserError("BROWSER_UPLOAD_FILE_NOT_FOUND", "browser upload file was not found");
      }
      throw browserError("BROWSER_UPLOAD_PATH_INVALID", "browser upload path is invalid or unsafe");
    }
    if (metadata.isSymbolicLink()) throw browserError("BROWSER_UPLOAD_PATH_INVALID", "browser upload path is invalid or unsafe");
    if (index < components.length - 1 && !metadata.isDirectory()) {
      throw browserError("BROWSER_UPLOAD_PATH_INVALID", "browser upload path is invalid or unsafe");
    }
    try {
      if (!samePath(await fsp.realpath(current), current)) {
        throw browserError("BROWSER_UPLOAD_PATH_INVALID", "browser upload path is invalid or unsafe");
      }
    } catch (error) {
      if (error && typeof error.code === "string" && error.code.startsWith("BROWSER_UPLOAD_")) throw error;
      throw browserError("BROWSER_UPLOAD_PATH_INVALID", "browser upload path is invalid or unsafe");
    }
  }
  return { canonicalRoot, candidate };
}

async function assertUploadHandlePathSafety(canonicalRoot, candidate, handle) {
  let canonicalCandidate;
  try {
    canonicalCandidate = await fsp.realpath(candidate);
  } catch {
    throw browserError("BROWSER_UPLOAD_PATH_CHANGED", "browser upload path changed while it was opening");
  }
  if (!isPathWithin(canonicalRoot, canonicalCandidate) || samePath(canonicalRoot, canonicalCandidate)) {
    throw browserError("BROWSER_UPLOAD_PATH_CHANGED", "browser upload path changed outside the home");
  }

  let pathMetadata;
  let handleMetadata;
  try {
    [pathMetadata, handleMetadata] = await Promise.all([
      fsp.stat(canonicalCandidate, { bigint: true }),
      handle.stat({ bigint: true }),
    ]);
  } catch {
    throw browserError("BROWSER_UPLOAD_PATH_CHANGED", "browser upload file identity could not be confirmed");
  }
  if (
    typeof pathMetadata.dev !== "bigint" ||
    typeof pathMetadata.ino !== "bigint" ||
    typeof handleMetadata.dev !== "bigint" ||
    typeof handleMetadata.ino !== "bigint" ||
    pathMetadata.ino <= 0n ||
    handleMetadata.ino <= 0n ||
    pathMetadata.dev !== handleMetadata.dev ||
    pathMetadata.ino !== handleMetadata.ino
  ) {
    throw browserError("BROWSER_UPLOAD_PATH_CHANGED", "browser upload file identity changed while it was opening");
  }
}

function assertUploadHomeRoot(root) {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0") || /[\r\n]/u.test(root) || Buffer.byteLength(root, "utf8") > MAX_UPLOAD_PATH_BYTES || !path.isAbsolute(root)) {
    throw browserError("BROWSER_UPLOAD_HOME_UNAVAILABLE", "browser upload home is unavailable");
  }
}

function assertUploadRelativePath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    Buffer.byteLength(relativePath, "utf8") > MAX_UPLOAD_PATH_BYTES ||
    /^[\\/]/u.test(relativePath) ||
    /^[A-Za-z]:/u.test(relativePath)
  ) {
    throw browserError("BROWSER_UPLOAD_PATH_INVALID", "browser upload path is invalid or unsafe");
  }
  const components = relativePath.split(/[\\/]/u);
  if (components.some((component) => !isValidUploadComponent(component))) {
    throw browserError("BROWSER_UPLOAD_PATH_INVALID", "browser upload path is invalid or unsafe");
  }
}

function isValidUploadComponent(component) {
  if (component.length === 0 || component === "." || component === "..") return false;
  if (INVALID_UPLOAD_COMPONENT.test(component) || /[ .]$/u.test(component)) return false;
  const stem = component.split(".", 1)[0] || "";
  return !RESERVED_UPLOAD_DEVICE.test(stem);
}

function samePath(left, right) {
  return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
}

function assertUploadLinkSafety(metadata) {
  const linkCount = metadata && metadata.nlink;
  if (!Number.isSafeInteger(linkCount) || linkCount < 1) {
    throw browserError("BROWSER_UPLOAD_LINK_METADATA_UNAVAILABLE", "browser upload file link metadata is unavailable");
  }
  if (linkCount > 1) {
    throw browserError("BROWSER_UPLOAD_HARDLINK_UNSAFE", "browser upload file has multiple hard links");
  }
}

function uniqueDownloadPath(root, filename) {
  const normalizedRoot = assertDownloadRoot(root);
  const candidate = path.join(normalizedRoot, filename);
  if (downloadPathAvailable(candidate)) return candidate;
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  for (let index = 1; index < 10_000; index += 1) {
    const next = path.join(normalizedRoot, `${stem} (${index})${ext}`);
    if (downloadPathAvailable(next)) return next;
  }
  throw browserError("BROWSER_DOWNLOAD_LIMIT", "could not allocate a download path");
}

function downloadPathAvailable(candidate) {
  if (!isPathWithin(path.resolve(DOWNLOADS_ROOT), path.resolve(candidate))) {
    throw browserError("BROWSER_DOWNLOAD_ROOT_INVALID", "download path is outside the managed browser root");
  }
  if (!fs.existsSync(candidate)) return true;
  const metadata = fs.lstatSync(candidate);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw browserError("BROWSER_DOWNLOAD_ROOT_INVALID", "download path is not a regular file");
  }
  return false;
}

function safeFilename(filename) {
  const normalized = path.basename(typeof filename === "string" ? filename : "download").replace(/[\u0000-\u001f<>:"/\\|?*]/gu, "_").trim();
  if (!normalized || normalized === "." || normalized === "..") return "download";
  return normalized.slice(0, 180) || "download";
}

function assertSafeUrl(url, allowBlank) {
  if (typeof url !== "string" || url.length === 0 || url.length > 8192) throw browserError("BROWSER_URL_INVALID", "browser URL is invalid");
  if (allowBlank && url === "about:blank") return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw browserError("BROWSER_URL_INVALID", "browser URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw browserError("BROWSER_URL_PROTOCOL", "browser URL protocol is not allowed");
  return parsed.toString();
}

function isValidRequest(request) {
  if (!isRecord(request)) return false;
  const allowed = ["protocolVersion", "kind", "id", "token", "agentId", "sessionId", "tabId", "partition", "downloadRoot", "homeRoot", "command"];
  if (Object.keys(request).some((key) => !allowed.includes(key))) return false;
  if (request.protocolVersion !== PROTOCOL_VERSION || request.kind !== "request") return false;
  if (![request.id, request.token, request.agentId, request.sessionId, request.tabId, request.partition, request.downloadRoot].every((value) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\r\n]/u.test(value))) return false;
  if (request.homeRoot !== undefined && (typeof request.homeRoot !== "string" || request.homeRoot.length === 0 || request.homeRoot.length > MAX_UPLOAD_PATH_BYTES || request.homeRoot.includes("\0") || /[\r\n]/u.test(request.homeRoot) || !path.isAbsolute(request.homeRoot))) return false;
  if (!/^persist:openbot-agent-[a-f0-9]{32}$/u.test(request.partition)) return false;
  if (!isRecord(request.command) || typeof request.command.command !== "string") return false;
  if (!validateCommand(request.command)) return false;
  if (request.command.command === "upload" && request.homeRoot === undefined) return false;
  return true;
}

function validateCommand(command) {
  switch (command.command) {
    case "open": return exactKeys(command, ["command", "url"]) && (command.url === undefined || typeof command.url === "string");
    case "navigate": return exactKeys(command, ["command", "url"]) && typeof command.url === "string";
    case "snapshot": return exactKeys(command, ["command", "includeText"]) && (command.includeText === undefined || typeof command.includeText === "boolean");
    case "click": return exactKeys(command, ["command", "x", "y", "button", "clickCount"]) && Number.isFinite(command.x) && Number.isFinite(command.y) && command.x >= 0 && command.y >= 0 && (command.button === undefined || ["left", "middle", "right"].includes(command.button)) && (command.clickCount === undefined || (Number.isInteger(command.clickCount) && command.clickCount >= 1 && command.clickCount <= 3));
    case "click_element": return exactKeys(command, ["command", "elementId"]) && typeof command.elementId === "string" && /^ob-el-[1-9][0-9]{0,5}$/u.test(command.elementId);
    case "scroll": return exactKeys(command, ["command", "deltaX", "deltaY"]) && Number.isFinite(command.deltaX) && Number.isFinite(command.deltaY) && Math.abs(command.deltaX) <= 10000 && Math.abs(command.deltaY) <= 10000;
    case "press_key": return exactKeys(command, ["command", "key"]) && ["ENTER", "TAB", "ESCAPE", "SPACE", "ARROWUP", "ARROWDOWN", "ARROWLEFT", "ARROWRIGHT", "BACKSPACE"].includes(command.key);
    case "type": return exactKeys(command, ["command", "text"]) && typeof command.text === "string" && Buffer.byteLength(command.text, "utf8") <= MAX_TEXT_BYTES;
    case "upload": return exactKeys(command, ["command", "selector", "path"]) && isValidUploadSelector(command.selector) && isValidUploadRelativePath(command.path);
    case "screenshot": return exactKeys(command, ["command", "fullPage"]) && (command.fullPage === undefined || typeof command.fullPage === "boolean");
    case "close":
    case "handoff":
    case "reset": return exactKeys(command, ["command"]);
    case "cancel": return exactKeys(command, ["command", "targetId"]) && typeof command.targetId === "string" && command.targetId.length > 0 && command.targetId.length <= 256 && !/[\r\n]/u.test(command.targetId);
    default: return false;
  }
}

function isValidUploadSelector(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= MAX_UPLOAD_SELECTOR_BYTES;
}

function isValidUploadRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_UPLOAD_PATH_BYTES || /^[\\/]/u.test(value) || /^[A-Za-z]:/u.test(value)) return false;
  return value.split(/[\\/]/u).every((component) => isValidUploadComponent(component));
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function send(value) {
  const frame = JSON.stringify(value);
  if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) throw new Error("browser response exceeds maximum size");
  outputTail = outputTail.catch(() => undefined).then(() => new Promise((resolve, reject) => {
    const accepted = process.stdout.write(`${frame}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
    if (!accepted) process.stdout.once("drain", resolve);
  })).catch(() => undefined);
  return outputTail;
}

function sendError(id, code, message) {
  return send({ protocolVersion: PROTOCOL_VERSION, kind: "response", id, ok: false, error: { code, message } });
}

function openCommandInput() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(COMMAND_PIPE);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("browser command pipe connection timed out"));
    }, 10_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function browserError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sanitizeError(error) {
  if (error instanceof Error && error.message) return error.message.slice(0, 512);
  return "browser host operation failed";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathWithin(root, candidate) {
  const relation = path.relative(path.resolve(root), path.resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !path.isAbsolute(relation));
}

function parseDownloadLimit(raw) {
  if (raw === undefined || raw === "") return DEFAULT_MAX_DOWNLOAD_BYTES;
  if (!/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2 * 1024 * 1024 * 1024) return null;
  return value;
}

function parseCommandPipe(raw) {
  if (typeof raw !== "string" || raw.length < 20 || raw.length > 240 || raw.includes("\0")) return null;
  return /^\\\\\.\\pipe\\openbot-browser-[a-f0-9]{32}$/u.test(raw) ? raw : null;
}

function parseProxy(url, token) {
  if (typeof url !== "string" || typeof token !== "string" || token.length < 43 || /[\r\n]/u.test(token)) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !/^\d+$/.test(parsed.port) ||
    Number(parsed.port) < 1 ||
    Number(parsed.port) > 65_535 ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) return null;
  return {
    url: `http://127.0.0.1:${Number(parsed.port)}`,
    rules: `http=127.0.0.1:${Number(parsed.port)};https=127.0.0.1:${Number(parsed.port)}`,
    host: "127.0.0.1",
    port: Number(parsed.port),
    token,
  };
}

function partitionRootFor(partition) {
  const name = partition.startsWith("persist:") ? partition.slice("persist:".length) : partition;
  const root = path.resolve(USER_DATA_ROOT, "Partitions", name);
  const base = path.resolve(USER_DATA_ROOT, "Partitions");
  if (!isPathWithin(base, root)) throw browserError("BROWSER_PARTITION_INVALID", "browser partition path is invalid");
  return root;
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const item of REQUESTS.values()) {
    item.cancelled = true;
    item.controller.abort();
  }
  REQUESTS.clear();
  AGENT_QUEUES.clear();
  AGENT_ORDER.length = 0;
  activeRequestCount = 0;
  commandInput = null;
  inputPaused = false;
  for (const tab of TABS.values()) {
    try {
      if (!tab.window.isDestroyed()) tab.window.destroy();
    } catch {
      // Continue closing other tabs.
    }
  }
  TABS.clear();
  if (keepAliveWindow && !keepAliveWindow.isDestroyed()) {
    try {
      keepAliveWindow.destroy();
    } catch {
      // Keep shutdown best-effort and continue to quit.
    }
  }
  keepAliveWindow = null;
  if (app.isReady()) app.quit();
}
