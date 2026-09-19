import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";

const AGENT_ID = "openbot-default";
const SECOND_AGENT_ID = "openbot-second";
const PROMPT = "desktop e2e incremental cancellation";
const STREAM_PREFIX = "E2E incremental stream";
const SKILL_NAME = "E2E Shared Skill";
const SKILL_PROMPT = "desktop e2e shared skill";
const SKILL_RESPONSE_PREFIX = "E2E skill backend received";
const SKILL_RESPONSE_TEXT = `${SKILL_RESPONSE_PREFIX} shared context.`;
const RETRY_PROMPT = "desktop e2e retry recovery";
const RETRY_RESPONSE = "E2E retry recovered.";
const RENDERER_STABLE_MARGIN_MS = 350;

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(value, token) {
  const text = value instanceof Error
    ? value.message
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
  const redacted = token ? text.replaceAll(token, "<redacted>") : text;
  if (typeof value === "string" || value instanceof Error) return redacted;
  try {
    return JSON.parse(redacted);
  } catch {
    return redacted;
  }
}

async function waitForTarget(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.title === "OpenBot");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Electron/CDP is still starting.
    }
    await sleep(250);
  }
  throw new Error("CDP OpenBot page not found");
}

function connectCdp(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  ws.addEventListener("close", () => {
    for (const entry of pending.values()) entry.reject(new Error("CDP websocket closed"));
    pending.clear();
  });
  const send = (method, params = {}) => {
    const id = nextId++;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    ws.send(JSON.stringify({ id, method, params }));
    return result;
  };
  return { ws, ready, send };
}

function requestJson(port, pathname, method, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
          authorization: `Bearer ${token}`,
        },
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(raw);
          } catch {
            reject(new Error(`gateway returned non-JSON status ${response.statusCode ?? 0}`));
            return;
          }
          resolve({ status: response.statusCode ?? 0, json });
        });
      },
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

class SseReader {
  constructor(response) {
    this.response = response;
    this.buffer = "";
    this.events = [];
    this.history = [];
    this.waiters = [];
    this.error = null;
    response.setEncoding("utf8");
    response.on("data", (chunk) => this.onData(chunk));
    response.on("error", (error) => this.fail(error));
    response.on("aborted", () => this.fail(new Error("SSE response aborted")));
  }

  onData(chunk) {
    this.buffer += chunk;
    let boundary;
    while ((boundary = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        this.push(JSON.parse(data));
      } catch {
        this.fail(new Error("SSE data was not JSON"));
        return;
      }
    }
  }

  push(event) {
    this.history.push(event);
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(event);
    else this.events.push(event);
  }

  fail(error) {
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(timeoutMs = 10000) {
    if (this.events.length > 0) return Promise.resolve(this.events.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("SSE event timeout"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close() {
    this.response.destroy();
  }
}

async function openEvents(port, token) {
  const response = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/events",
        method: "GET",
        headers: { accept: "text/event-stream", authorization: `Bearer ${token}` },
        agent: false,
      },
      resolve,
    );
    request.on("error", reject);
    request.end();
  });
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`gateway SSE status ${response.statusCode ?? 0}`);
  }
  return new SseReader(response);
}

async function waitForEvent(reader, predicate, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = await reader.next(Math.max(250, deadline - Date.now()));
    if (predicate(event)) return event;
  }
  throw new Error("expected SSE event not observed");
}

async function readStatus(statusFile) {
  return JSON.parse(await readFile(statusFile, "utf8"));
}

async function waitForStatus(statusFile, predicate, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const status = await readStatus(statusFile);
      if (predicate(status)) return status;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError ?? new Error("expected fixture status was not observed");
}

async function waitForStableStatus(statusFile, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  let lastSignature = null;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    try {
      const status = await readStatus(statusFile);
      if (predicate(status)) {
        const signature = JSON.stringify({
          chunksEmitted: status.chunksEmitted,
          chunksAfterAbort: status.chunksAfterAbort,
          activeStreams: status.activeStreams,
          completedStreams: status.completedStreams,
        });
        stableSamples = signature === lastSignature ? stableSamples + 1 : 1;
        lastSignature = signature;
        if (stableSamples >= 3) return status;
      } else {
        stableSamples = 0;
        lastSignature = null;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError ?? new Error("fixture post-abort counters did not stabilize");
}

function visibleElementExpression(selectorExpression) {
  return `(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.disabled && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const element = (${selectorExpression}).find(isVisible);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName,
      placeholder: element.getAttribute("placeholder"),
      ariaLabel: element.getAttribute("aria-label"),
      contentEditable: element.getAttribute("contenteditable"),
      className: typeof element.className === "string" ? element.className : null,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  })()`;
}

function mainPaneTextExpression(text) {
  const expected = JSON.stringify(text);
  return `(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
    };
    const describe = (element, textLimit = 400) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        role: element.getAttribute("role"),
        ariaLabel: element.getAttribute("aria-label"),
        className: typeof element.className === "string" ? element.className : null,
        text: (element.innerText ?? "").slice(0, textLimit),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        visible: true,
      };
    };
    const composer = [...document.querySelectorAll("textarea, input[type='text'], [contenteditable='true']")]
      .filter(isVisible)
      .find((candidate) => candidate.matches("textarea, [contenteditable='true']") || /message|prompt|mensagem/i.test((candidate.getAttribute("placeholder") ?? "") + " " + (candidate.getAttribute("aria-label") ?? "")));
    if (!composer) return { composer: null, pane: null, element: null };
    const composerText = "value" in composer ? composer.value : (composer.innerText ?? composer.textContent ?? "");
    const composerRect = composer.getBoundingClientRect();
    const panes = [];
    let ancestor = composer.parentElement;
    while (ancestor && ancestor !== document.documentElement) {
      if (isVisible(ancestor)) {
        const rect = ancestor.getBoundingClientRect();
        const containsComposer = rect.left <= composerRect.left && rect.right >= composerRect.right && rect.top <= composerRect.top && rect.bottom >= composerRect.bottom;
        const hasTranscriptRoom = rect.width > composerRect.width * 1.02 && rect.height > composerRect.height * 3;
        if (containsComposer && hasTranscriptRoom) panes.push(ancestor);
      }
      ancestor = ancestor.parentElement;
    }
    const pane = panes.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return (leftRect.width * leftRect.height) - (rightRect.width * rightRect.height);
    })[0] ?? null;
    if (!pane) return {
      composer: describe(composer, 200),
      composerText: String(composerText).slice(0, 200),
      composerEmpty: !String(composerText).trim(),
      pane: null,
      element: null,
    };
    const paneRect = pane.getBoundingClientRect();
    const elements = [pane, ...pane.querySelectorAll("*")].filter((element) => (
      element !== composer &&
      element !== document.body &&
      element !== document.documentElement &&
      isVisible(element) &&
      (element.innerText ?? "").includes(${expected})
    ));
    const isLateralAgentPreview = (candidate) => {
      const className = typeof candidate.className === "string" ? candidate.className : "";
      return /(?:^|\\s)(?:sand-)?agent-item(?:__preview)?(?:\\s|$)/i.test(className);
    };
    const findLateralAgentPreviewAncestor = (candidate) => {
      let ancestor = candidate;
      while (ancestor && ancestor !== pane) {
        if (isLateralAgentPreview(ancestor)) return ancestor;
        ancestor = ancestor.parentElement;
      }
      return null;
    };
    const hasLateralAgentPreviewAncestor = (candidate) => Boolean(findLateralAgentPreviewAncestor(candidate));
    const rejectedLateralPreviews = elements
      .filter((candidate) => isLateralAgentPreview(candidate) || hasLateralAgentPreviewAncestor(candidate))
      .slice(0, 8)
      .map((candidate) => ({
        candidate: describe(candidate, 200),
        sidebarAncestor: describe(findLateralAgentPreviewAncestor(candidate), 200),
      }));
    const isMainPaneTranscriptCandidate = (candidate) => {
      if (!pane.contains(candidate) || isLateralAgentPreview(candidate) || hasLateralAgentPreviewAncestor(candidate)) return false;
      const rect = candidate.getBoundingClientRect();
      const insidePane = rect.right > paneRect.left && rect.left < paneRect.right && rect.bottom > paneRect.top && rect.top < paneRect.bottom;
      const sharesComposerColumn = rect.right > composerRect.left && rect.left < composerRect.right;
      return insidePane && sharesComposerColumn;
    };
    const element = elements
      .filter(isMainPaneTranscriptCandidate)
      .sort((left, right) => left.childElementCount - right.childElementCount)
      .find((candidate) => ![...candidate.children].some((child) => isVisible(child) && (child.innerText ?? "").includes(${expected})));
    return {
      composer: describe(composer, 200),
      composerText: String(composerText).slice(0, 200),
      composerEmpty: !String(composerText).trim(),
      pane: describe(pane, 200),
      rejectedLateralPreviews,
      element: element ? describe(element) : null,
    };
  })()`;
}

function workflowListExpression() {
  return `(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
      const listbox = [...document.querySelectorAll('[aria-label="Reference a skill"], .sand-workflow-listbox')]
      .find((element) => isVisible(element));
    if (!listbox) return null;
    const rect = listbox.getBoundingClientRect();
    const items = [...listbox.querySelectorAll('button, [role="option"], [role="menuitem"], [data-workflow-id], *')]
      .filter((element) => isVisible(element) && String(element.innerText ?? element.textContent ?? "").trim().length > 0)
      .map((element) => {
        const itemRect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          role: element.getAttribute("role"),
          text: String(element.innerText ?? element.textContent ?? "").trim().slice(0, 240),
          workflowId: element.getAttribute("data-workflow-id") ?? element.getAttribute("data-id"),
          className: typeof element.className === "string" ? element.className : null,
          rect: { x: itemRect.x, y: itemRect.y, width: itemRect.width, height: itemRect.height },
          childElementCount: element.childElementCount,
        };
      });
    return {
      ariaLabel: listbox.getAttribute("aria-label"),
      className: typeof listbox.className === "string" ? listbox.className : null,
      text: String(listbox.innerText ?? listbox.textContent ?? "").trim().slice(0, 1000),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      items: items.slice(0, 40),
    };
  })()`;
}

function workflowItemRectExpression(name) {
  const expected = JSON.stringify(name);
  return `(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const listbox = [...document.querySelectorAll('[aria-label="Reference a skill"], .sand-workflow-listbox')]
      .find((element) => isVisible(element));
    if (!listbox) return null;
    const candidates = [...listbox.querySelectorAll('button, [role="option"], [role="menuitem"], [data-workflow-id], *')]
      .filter((element) => isVisible(element) && String(element.innerText ?? element.textContent ?? "").includes(${expected}))
      .sort((left, right) => {
        const rank = (element) => element.matches('button, [role="option"]') ? 0 : 1;
        return rank(left) - rank(right) || left.childElementCount - right.childElementCount;
      });
    const item = candidates[0];
    if (!item) return null;
    const rect = item.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: String(item.innerText ?? item.textContent ?? "").trim().slice(0, 240) };
  })()`;
}

function workflowChipExpression(name) {
  const expected = JSON.stringify(name);
  return `(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const composer = [...document.querySelectorAll('[contenteditable="true"]')]
      .find((element) => isVisible(element) && (element.classList.contains("sand-prompt-field") || element.getAttribute("aria-label") === "Prompt"));
    if (!composer) return null;
    const chip = [...composer.querySelectorAll('.sand-workflow-chip, [data-type="workflowReference"]')]
      .find((element) => isVisible(element) && String(element.innerText ?? element.textContent ?? "").includes(${expected}));
    if (!chip) return null;
    const rect = chip.getBoundingClientRect();
    return {
      text: String(chip.innerText ?? chip.textContent ?? "").trim(),
      dataType: chip.getAttribute("data-type"),
      workflowId: chip.getAttribute("data-id") ?? chip.getAttribute("data-workflow-id"),
      className: typeof chip.className === "string" ? chip.className : null,
      inComposer: composer.contains(chip),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  })()`;
}

function skillFinalResponseStateExpression(text) {
  const expected = JSON.stringify(text);
  return `(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
    };
    const describe = (element, textLimit = 400) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        role: element.getAttribute("role"),
        ariaLabel: element.getAttribute("aria-label"),
        className: typeof element.className === "string" ? element.className : null,
        text: String(element.innerText ?? element.textContent ?? "").trim().slice(0, textLimit),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        visible: true,
      };
    };
    const composer = [...document.querySelectorAll('[contenteditable="true"]')]
      .filter(isVisible)
      .find((candidate) => candidate.getAttribute("aria-label") === "Prompt" || candidate.classList.contains("sand-prompt-field"));
    if (!composer) return {
      pane: null,
      responseCount: 0,
      responseElements: [],
      busyMarkers: 0,
      activeCancelControls: 0,
      workingIndicators: [],
      quiescent: false,
    };
    const composerRect = composer.getBoundingClientRect();
    const panes = [];
    let ancestor = composer.parentElement;
    while (ancestor && ancestor !== document.documentElement) {
      if (isVisible(ancestor)) {
        const rect = ancestor.getBoundingClientRect();
        const containsComposer = rect.left <= composerRect.left && rect.right >= composerRect.right && rect.top <= composerRect.top && rect.bottom >= composerRect.bottom;
        const hasTranscriptRoom = rect.width > composerRect.width * 1.02 && rect.height > composerRect.height * 3;
        if (containsComposer && hasTranscriptRoom) panes.push(ancestor);
      }
      ancestor = ancestor.parentElement;
    }
    const pane = panes.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return (leftRect.width * leftRect.height) - (rightRect.width * rightRect.height);
    })[0] ?? null;
    if (!pane) return {
      pane: null,
      responseCount: 0,
      responseElements: [],
      busyMarkers: 0,
      activeCancelControls: 0,
      workingIndicators: [],
      quiescent: false,
    };
    const paneRect = pane.getBoundingClientRect();
    const isMainPaneCandidate = (candidate) => {
      if (candidate === composer || candidate === document.body || candidate === document.documentElement) return false;
      if (!pane.contains(candidate) || !isVisible(candidate)) return false;
      const className = typeof candidate.className === "string" ? candidate.className : "";
      let previewAncestor = candidate;
      while (previewAncestor && previewAncestor !== pane) {
        const ancestorClassName = typeof previewAncestor.className === "string" ? previewAncestor.className : "";
        if (/(?:^|\\s)(?:sand-)?agent-item(?:__preview)?(?:\\s|$)/i.test(ancestorClassName)) return false;
        previewAncestor = previewAncestor.parentElement;
      }
      if (/(?:^|\\s)(?:sand-)?agent-item(?:__preview)?(?:\\s|$)/i.test(className)) return false;
      const rect = candidate.getBoundingClientRect();
      const insidePane = rect.right > paneRect.left && rect.left < paneRect.right && rect.bottom > paneRect.top && rect.top < paneRect.bottom;
      const sharesComposerColumn = rect.right > composerRect.left && rect.left < composerRect.right;
      return insidePane && sharesComposerColumn;
    };
    const candidates = [pane, ...pane.querySelectorAll("*")].filter(isMainPaneCandidate);
    const responseCandidates = candidates.filter((candidate) => String(candidate.innerText ?? candidate.textContent ?? "").trim() === ${expected});
    const responseElements = responseCandidates
      .filter((candidate) => ![...candidate.children].some((child) => responseCandidates.includes(child)))
      .map((candidate) => describe(candidate));
    const workingCandidates = candidates.filter((candidate) => {
      const candidateText = String(candidate.innerText ?? candidate.textContent ?? "").trim();
      return candidateText.length > 0 && candidateText.length <= 120 && /(?:\\bis working\\b|\\bworking\\b|\\btrabalhando\\b|\\bem execução\\b)/i.test(candidateText);
    });
    const workingIndicators = workingCandidates
      .filter((candidate) => ![...candidate.children].some((child) => workingCandidates.includes(child)))
      .map((candidate) => describe(candidate, 160));
    const busyMarkers = [...document.querySelectorAll('[aria-busy="true"], [data-streaming="true"]')].filter(isVisible).length;
    const activeCancelControls = [...document.querySelectorAll("button")].filter((button) => isVisible(button) && !button.disabled && /cancelar|parar|stop/i.test(button.innerText ?? "")).length;
    return {
      pane: describe(pane, 1200),
      responseCount: responseElements.length,
      responseElements,
      busyMarkers,
      activeCancelControls,
      workingIndicators,
      quiescent: busyMarkers === 0 && activeCancelControls === 0 && workingIndicators.length === 0,
    };
  })()`;
}

async function main() {
  const args = process.argv.slice(2);
  const cdpPort = Number(argValue(args, "--cdp-port"));
  const gatewayPort = Number(argValue(args, "--gateway-port"));
  const evidenceDir = argValue(args, "--evidence-dir");
  const statusFile = argValue(args, "--status-file");
  const token = process.env.E2E_GATEWAY_TOKEN;
  if (!Number.isInteger(cdpPort) || !Number.isInteger(gatewayPort) || !evidenceDir || !statusFile || !token) {
    throw new Error("cdp-check requires --cdp-port, --gateway-port, --evidence-dir, --status-file and inherited E2E_GATEWAY_TOKEN");
  }

  const report = {
    status: "RED",
    checks: {},
    startedAt: new Date().toISOString(),
  };
  const runtimeExceptions = [];
  const runtimeConsoleErrors = [];
  const initialRuntimeExceptions = [];
  const initialRuntimeConsoleErrors = [];
  let cdp;
  let events;

  const saveScreenshot = async (name) => {
    if (!cdp) return false;
    const image = await cdp.send("Page.captureScreenshot", { format: "png" });
    await writeFile(`${evidenceDir}/${name}.png`, Buffer.from(image.data, "base64"));
    return true;
  };

  try {
    const target = await waitForTarget(cdpPort);
    cdp = connectCdp(target.webSocketDebuggerUrl);
    cdp.ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.method === "Runtime.exceptionThrown") {
          const details = message.params?.exceptionDetails ?? {};
          runtimeExceptions.push(redact({
            text: details.text,
            description: details.exception?.description,
            url: details.url,
            lineNumber: details.lineNumber,
            columnNumber: details.columnNumber,
          }, token));
        }
        if (message.method === "Runtime.consoleAPICalled") {
          const params = message.params ?? {};
          if (params.type === "error" || params.type === "assert" || params.level === "error") {
            const text = (params.args ?? [])
              .map((argument) => argument.value ?? argument.description ?? argument.unserializableValue ?? "")
              .join(" ");
            runtimeConsoleErrors.push(redact(text, token));
          }
        }
      } catch {
        runtimeConsoleErrors.push("unable to parse CDP runtime event");
      }
    });
    await cdp.ready;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text ?? "renderer evaluation failed");
      }
      return result.result?.value;
    };
    const rendererInfo = async () => evaluate(`({
      title: document.title,
      readyState: document.readyState,
      rootChildren: document.getElementById("root")?.childElementCount ?? 0,
      hasRoot: Boolean(document.getElementById("root")),
      documentMarker: document.documentElement?.getAttribute("data-e2e-cdp-old-document") ?? null,
    })`);
    const waitForRenderer = async (predicate, timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs;
      let info;
      while (Date.now() < deadline) {
        info = await rendererInfo();
        if (predicate(info)) return info;
        await sleep(250);
      }
      return info;
    };
    const waitForMainPaneTextElement = async (text, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await evaluate(mainPaneTextExpression(text));
        if (last?.element?.visible === true && last.element.rect?.width > 0 && last.element.rect?.height > 0) {
          return {
            ...last.element,
            composer: last.composer,
            pane: last.pane,
            rejectedLateralPreviews: last.rejectedLateralPreviews,
          };
        }
        await sleep(150);
      }
      report.checks.mainPaneTextAttempt = last ?? null;
      throw new Error(`visible renderer main-pane element not observed: ${text}`);
    };
    const waitForSendEvidence = async (text, timeoutMs = 12000) => {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await evaluate(mainPaneTextExpression(text));
        if (last?.composerEmpty === true && last.element?.visible === true && last.element.rect?.width > 0 && last.element.rect?.height > 0) {
          return { ...last, userMessage: last.element };
        }
        await sleep(150);
      }
      report.checks.sendAttempt = last ?? null;
      throw new Error(`real composer send evidence not observed (composerEmpty=${last?.composerEmpty ?? false}, mainPane=${Boolean(last?.pane)}, distinctUserMessage=${Boolean(last?.element)})`);
    };
    const waitForWorkflowList = async (timeoutMs = 12000) => {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await evaluate(workflowListExpression());
        if ((last?.ariaLabel === "Reference a skill" || last?.className?.includes("sand-workflow-listbox")) && last.items?.some((item) => item.text.includes(SKILL_NAME))) return last;
        await sleep(100);
      }
      report.checks.skillListAttempt = last ?? null;
      throw new Error(`native skill list was not visible with ${SKILL_NAME}`);
    };
    const waitForWorkflowChip = async (timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await evaluate(workflowChipExpression(SKILL_NAME));
        if (last?.inComposer === true) return last;
        await sleep(100);
      }
      report.checks.skillChipAttempt = last ?? null;
      throw new Error(`selected skill did not become a native composer chip: ${SKILL_NAME}`);
    };
    const assistantTranscriptEvidence = () => (events?.history ?? [])
      .filter((event) => (
        event?.channel === "transcript" &&
        event?.payload?.entry?.kind === "message" &&
        event?.payload?.entry?.role === "assistant"
      ))
      .map((event) => ({
        type: event.payload.type,
        id: event.payload.entry.id,
        role: event.payload.entry.role,
        streaming: event.payload.entry.streaming,
        content: String(event.payload.entry.content ?? ""),
      }));
    const waitForSkillResponseQuiescence = async (timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      let last;
      let stableSamples = 0;
      while (Date.now() < deadline) {
        last = await evaluate(skillFinalResponseStateExpression(SKILL_RESPONSE_TEXT));
        const finalState = last?.quiescent === true && last.responseCount === 1;
        stableSamples = finalState ? stableSamples + 1 : 0;
        if (stableSamples >= 3) return last;
        await sleep(150);
      }
      report.checks.skillFinalAttempt = last ?? null;
      const count = last?.responseCount ?? 0;
      if (last?.quiescent === true && count > 1) {
        report.checks.skillFinalAttempt.transcriptAssistantEvents = assistantTranscriptEvidence();
        try {
          report.checks.skillFinalAttempt.screenshot = await saveScreenshot("skill-final");
        } catch (captureError) {
          report.checks.skillFinalAttempt.screenshot = false;
          report.checks.skillFinalAttempt.screenshotError = redact(captureError, token);
        }
        throw new Error(`duplicate final Skill response remained after renderer quiescence (count=${count})`);
      }
      throw new Error(`final Skill response did not reach one visible MAIN response after renderer quiescence (count=${count}, busyMarkers=${last?.busyMarkers ?? "unknown"}, workingIndicators=${last?.workingIndicators?.length ?? "unknown"})`);
    };

    // Wait for the initial load to settle before reloading. This avoids racing loadFile/navigation.
    const initialRenderer = await waitForRenderer((info) => (
      info.readyState === "complete" &&
      info.title === "OpenBot" &&
      info.hasRoot &&
      info.rootChildren > 0
    ));
    if (!initialRenderer || initialRenderer.readyState !== "complete" || !initialRenderer.hasRoot || initialRenderer.rootChildren < 1) {
      throw new Error("OpenBot initial renderer load did not stabilize");
    }
    await sleep(RENDERER_STABLE_MARGIN_MS);

    report.checks.welcome = await evaluate(`(() => {
      const root = document.getElementById("openbot-welcome");
      const button = document.getElementById("openbot-welcome-continue");
      if (!root || !button) return { shown: false, dismissed: true };
      const title = document.getElementById("openbot-welcome-title")?.textContent ?? "";
      return { shown: true, dismissed: false, title, initialFocus: document.activeElement === button };
    })()`);
    if (report.checks.welcome.shown && report.checks.welcome.title !== "Bem-vindo ao OpenBot") {
      throw new Error("unexpected OpenBot launch welcome content");
    }
    if (report.checks.welcome.shown) {
      if (!report.checks.welcome.initialFocus) throw new Error("OpenBot welcome did not focus its primary action");
      for (const modifiers of [0, 8]) {
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Tab",
          code: "Tab",
          modifiers,
          windowsVirtualKeyCode: 9,
          nativeVirtualKeyCode: 9,
        });
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Tab",
          code: "Tab",
          modifiers,
          windowsVirtualKeyCode: 9,
          nativeVirtualKeyCode: 9,
        });
        const contained = await evaluate(`document.activeElement?.id === "openbot-welcome-continue"`);
        if (!contained) throw new Error(`OpenBot welcome leaked ${modifiers === 8 ? "Shift+Tab" : "Tab"} focus`);
      }
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
      report.checks.welcome.keyboard = { tabContained: true, shiftTabContained: true, dismissedWithEscape: true };
    }
    await sleep(500);
    const welcomePersistence = await evaluate(`({
      removed: !document.getElementById("openbot-welcome"),
      persisted: sessionStorage.getItem("openbot.welcome.completed.session.v1") === "1",
      appRestored: document.getElementById("root")?.inert === false,
    })`);
    report.checks.welcome = { ...report.checks.welcome, ...welcomePersistence };
    if (!welcomePersistence.removed || !welcomePersistence.persisted || !welcomePersistence.appRestored) {
      throw new Error("OpenBot launch welcome did not dismiss cleanly");
    }

    const oldDocumentNonce = `e2e-cdp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const markedNonce = await evaluate(`(() => {
      const nonce = ${JSON.stringify(oldDocumentNonce)};
      document.documentElement?.setAttribute("data-e2e-cdp-old-document", nonce);
      return document.documentElement?.getAttribute("data-e2e-cdp-old-document") ?? null;
    })()`);
    if (markedNonce !== oldDocumentNonce) throw new Error("could not mark initial renderer document");

    initialRuntimeExceptions.push(...runtimeExceptions);
    initialRuntimeConsoleErrors.push(...runtimeConsoleErrors);
    runtimeExceptions.length = 0;
    runtimeConsoleErrors.length = 0;

    // Reload only after Runtime/Page instrumentation and initial stabilization.
    report.checks.reload = {
      oldDocumentNonce,
      initialRenderer,
      initialStableMarginMs: RENDERER_STABLE_MARGIN_MS,
      requested: true,
    };
    await cdp.send("Page.reload", { ignoreCache: false });
    report.checks.window = await waitForRenderer((info) => (
      info.readyState === "complete" &&
      info.title === "OpenBot" &&
      info.hasRoot &&
      info.rootChildren > 0 &&
      info.documentMarker === null
    ), 30000);
    report.checks.reload.newRenderer = report.checks.window;
    if (
      !report.checks.window ||
      report.checks.window.readyState !== "complete" ||
      !report.checks.window.hasRoot ||
      report.checks.window.rootChildren < 1 ||
      report.checks.window.documentMarker !== null
    ) {
      throw new Error("OpenBot reloaded renderer document was not proven fresh and stable");
    }
    report.checks.bridge = await evaluate(`({
      hasDesktop: typeof window.desktop === "object",
      hasAgent: typeof window.desktop?.agent === "object",
      hasCancelPrompt: typeof window.desktop?.agent?.cancelPrompt === "function",
      hasRetryPrompt: typeof window.desktop?.agent?.retryPrompt === "function",
      hasPromptStatus: typeof window.desktop?.agent?.getPromptStatus === "function",
      hasLocalRuntimeStatus: typeof window.desktop?.agent?.getLocalRuntimeStatus === "function",
      hasRepairLocalRuntime: typeof window.desktop?.agent?.repairLocalRuntime === "function",
      hasAvailableModels: typeof window.desktop?.agent?.getAvailableModels === "function",
      hasWorkspaceInventory: typeof window.desktop?.agent?.getWorkspaceInventory === "function",
      hasSendPrompt: typeof window.desktop?.agent?.sendPrompt === "function",
    })`);
    if (!report.checks.bridge.hasDesktop || !report.checks.bridge.hasAgent || !report.checks.bridge.hasCancelPrompt || !report.checks.bridge.hasRetryPrompt || !report.checks.bridge.hasPromptStatus || !report.checks.bridge.hasWorkspaceInventory) {
      throw new Error("required desktop agent bridge is unavailable");
    }
    report.checks.gateway = {
      health: (await requestJson(gatewayPort, "/health", "GET", undefined, token)).json,
      activeProvider: await evaluate("window.desktop.agent.getActiveProvider()"),
      models: await evaluate("window.desktop.agent.getAvailableModels()"),
      workspaceInventory: await evaluate("window.desktop.agent.getWorkspaceInventory()"),
    };
    if (
      report.checks.gateway.health.ok !== true ||
      report.checks.gateway.activeProvider?.provider !== "xai" ||
      report.checks.gateway.workspaceInventory?.agentId !== "openbot-default" ||
      report.checks.gateway.workspaceInventory?.complete !== true
    ) {
      throw new Error("gateway health or fake provider bridge check failed");
    }
    report.checks.composer = await evaluate(visibleElementExpression(`[
      ...document.querySelectorAll("textarea, input[type='text'], [contenteditable='true']")
    ].filter((element) => {
      const placeholder = element.getAttribute("placeholder") ?? "";
      const label = element.getAttribute("aria-label") ?? "";
      return element.matches("textarea, [contenteditable='true']") || /message|prompt|mensagem/i.test(placeholder + " " + label);
    })`));
    if (!report.checks.composer) throw new Error("real composer was not observable");
    await saveScreenshot("window");

    events = await openEvents(gatewayPort, token);
    const focused = await evaluate(`(() => {
      const isVisible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return !element.disabled && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const elements = [...document.querySelectorAll("textarea, input[type='text'], [contenteditable='true']")];
      const element = elements.find((candidate) => isVisible(candidate) && (
        candidate.matches("textarea, [contenteditable='true']") || /message|prompt|mensagem/i.test((candidate.getAttribute("placeholder") ?? "") + " " + (candidate.getAttribute("aria-label") ?? ""))
      ));
      if (!element) return false;
      element.focus();
      element.click();
      return document.activeElement === element;
    })()`);
    if (!focused) throw new Error("real composer could not receive focus");
    await cdp.send("Input.insertText", { text: PROMPT });
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
    report.checks.send = { method: "real-composer+CDP-Input", promptLength: PROMPT.length };
    const sendEvidence = await waitForSendEvidence(PROMPT, 12000);
    report.checks.send = {
      method: "real-composer+CDP-Input",
      promptLength: PROMPT.length,
      composerEmpty: sendEvidence.composerEmpty,
      mainPane: sendEvidence.pane,
      rejectedLateralPreviews: sendEvidence.rejectedLateralPreviews,
      userMessage: sendEvidence.userMessage,
    };
    report.checks.userPromptVisible = true;

    const assistantEvent = await waitForEvent(events, (event) => (
      event?.channel === "transcript" &&
      event?.payload?.type === "appended" &&
      event?.payload?.entry?.kind === "message" &&
      event?.payload?.entry?.role === "assistant" &&
      event?.payload?.entry?.streaming === true
    ), 12000);
    const allRuntimeExceptions = [...initialRuntimeExceptions, ...runtimeExceptions];
    const allRuntimeConsoleErrors = [...initialRuntimeConsoleErrors, ...runtimeConsoleErrors];
    if (allRuntimeExceptions.length > 0 || allRuntimeConsoleErrors.length > 0) {
      throw new Error(`renderer runtime errors observed before visual stream (${allRuntimeExceptions.length} exceptions, ${allRuntimeConsoleErrors.length} console errors)`);
    }
    const streamElement = await waitForMainPaneTextElement(STREAM_PREFIX, 12000);
    const inspectStreamingRow = async () => evaluate(`(() => {
        const paragraph = [...document.querySelectorAll('main.sand-chat p')]
          .find((element) => (element.textContent || '').startsWith(${JSON.stringify(STREAM_PREFIX)}));
        const target = paragraph?.closest('.sand-transcript-row');
        if (!target) return null;
        window.__e2eStreamingRow ??= target;
        return {
          key: target.dataset.rowKey,
          sameNode: window.__e2eStreamingRow === target,
          top: target.getBoundingClientRect().top,
          overlayMotion: target.dataset.openbotMotion || null,
        };
    })()`);
    const rowBeforePause = await inspectStreamingRow();
    await sleep(RENDERER_STABLE_MARGIN_MS);
    const rowDuringPause = await inspectStreamingRow();
    // Entry motion belongs to native data-enter/CSS, not an additional overlay
    // animation on every transcript mount (which also happens for old history).
    if (!rowBeforePause || rowBeforePause.key !== assistantEvent.payload.entry.id
      || !rowDuringPause?.sameNode || rowDuringPause.key !== rowBeforePause.key
      || rowDuringPause.top !== rowBeforePause.top || rowDuringPause.overlayMotion !== null) {
      throw new Error(`streaming row identity/layout changed during pause: ${JSON.stringify({ rowBeforePause, rowDuringPause })}`);
    }
    const activity = await evaluate(`(() => ({
      indicatorVisible: [...document.querySelectorAll('[data-row-key="sand-typing-indicator"]')].some(element =>
        getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().height > 0),
      status: document.getElementById('openbot-turn-status')?.hidden === false
        ? document.getElementById('openbot-turn-status').textContent : '',
    }))()`);
    if (!activity.indicatorVisible || activity.status !== "") throw new Error(`native activity is missing or duplicated: ${JSON.stringify(activity)}`);
    report.checks.incremental = {
      activity,
      prefix: STREAM_PREFIX,
      domVisible: true,
      visibleElement: streamElement,
      mainPane: streamElement.pane,
      stability: { before: rowBeforePause, duringPause: rowDuringPause },
      screenshot: await saveScreenshot("incremental"),
      sseObserved: true,
      sseEntry: {
        role: assistantEvent.payload.entry.role,
        streaming: assistantEvent.payload.entry.streaming,
        contentLength: String(assistantEvent.payload.entry.content ?? "").length,
      },
    };

    const cancelReadyStatus = await waitForStatus(statusFile, (status) => (
      status.cancelReady === true &&
      status.status === "STREAMING" &&
      status.activeStreams > 0
    ), 12000);
    report.checks.cancelReady = {
      expected: { cancelReady: true, status: "STREAMING", activeStreams: ">0" },
      observed: cancelReadyStatus,
    };

    const createdSecond = await requestJson(gatewayPort, "/api/createAgent", "POST", { id: SECOND_AGENT_ID, name: "Second Bot" }, token);
    if (createdSecond.status !== 200) throw new Error("second bot could not be created for agent-bound control test");
    const waitForActiveAgent = async (expected, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = await evaluate("window.desktop.agent.getProviderConfig()");
        if (last?.agentId === expected) return last;
        await sleep(100);
      }
      throw new Error(`active agent did not become ${expected}: ${JSON.stringify(last)}`);
    };
    const stopVisibility = () => evaluate(`(() => {
      const button = document.getElementById("openbot-stop-turn");
      if (!button) return { present: false, visible: false };
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return { present: true, visible: !button.hidden && style.display !== "none" && rect.width > 0 && rect.height > 0, hidden: button.hidden, display: style.display, rect: { width: rect.width, height: rect.height }, activeAgent: button.dataset.openbotActiveAgent ?? "", busyAgents: button.dataset.openbotBusyAgents ?? "", optimistic: button.dataset.openbotOptimistic ?? "" };
    })()`);
    const waitForStopVisibility = async (expected, expectedAgent, timeoutMs = 6000) => {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = await stopVisibility();
        if (last?.visible === expected && (expectedAgent == null || last?.activeAgent === expectedAgent)) return last;
        await sleep(100);
      }
      return last;
    };
    const selectAgentInRenderer = async (agentId) => {
      let point = null;
      const deadline = Date.now() + 5000;
      while (!point && Date.now() < deadline) {
        point = await evaluate(`(() => {
          const row = [...document.querySelectorAll('.sand-agent-item[data-layout="expanded"]')]
            .find(element => element.dataset.agentId === ${JSON.stringify(agentId)});
          if (!row) return null;
          const rect = row.getBoundingClientRect();
          return rect.width && rect.height ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
        })()`);
        if (!point) await sleep(50);
      }
      if (!point) throw new Error(`agent row not visible: ${agentId}`);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    };
    await selectAgentInRenderer(SECOND_AGENT_ID);
    await waitForActiveAgent(SECOND_AGENT_ID);
    const stopOnSecond = await waitForStopVisibility(false, SECOND_AGENT_ID);
    await selectAgentInRenderer(AGENT_ID);
    await waitForActiveAgent(AGENT_ID);
    const stopOnOriginal = await waitForStopVisibility(true, AGENT_ID);
    await evaluate("window.desktop.forceGatewayReconnect()");
    await sleep(1500);
    const statusAfterReconnect = await evaluate(`window.desktop.agent.getPromptStatus({ agentId: ${JSON.stringify(AGENT_ID)} })`);
    const stopAfterReconnect = await waitForStopVisibility(true, AGENT_ID);
    report.checks.agentBoundControls = { stopOnSecond, stopOnOriginal, statusAfterReconnect, stopAfterReconnect };
    if (stopOnSecond.visible || !stopOnOriginal.visible) {
      throw new Error(`stop control followed the wrong bot: ${JSON.stringify(report.checks.agentBoundControls)}`);
    }
    if (statusAfterReconnect?.isBusy !== true || !stopAfterReconnect.visible) {
      throw new Error(`prompt control did not recover after reconnect: ${JSON.stringify(report.checks.agentBoundControls)}`);
    }

    const cancelClicked = await evaluate(`(() => {
      const button = document.getElementById("openbot-stop-turn");
      if (!button || button.hidden || button.disabled) return false;
      button.click();
      return true;
    })()`);
    if (!cancelClicked) throw new Error("agent-bound stop control could not be clicked");
    const cancel = { cancelled: true, agentIds: [AGENT_ID], via: "agent-bound-stop" };
    let notice = null;
    let noticeError = null;
    try {
      notice = await waitForEvent(events, (event) => (
        event?.channel === "transcript" &&
        event?.payload?.type === "appended" &&
        event?.payload?.entry?.kind === "notice" &&
        /interrompida/i.test(event.payload.entry.text ?? event.payload.entry.content ?? "")
      ), 12000);
    } catch (error) {
      noticeError = redact(error, token);
    }
    let statusAtCancel = null;
    let statusError = null;
    try {
      statusAtCancel = await waitForStatus(statusFile, (status) => (
        status.abortObserved === true &&
        status.abortCount > 0 &&
        status.activeStreams === 0 &&
        status.completedStreams === 0 &&
        status.chunksAfterAbort === 0
      ), 12000);
    } catch (error) {
      statusError = redact(error, token);
    }
    let statusAfterWindow = null;
    try {
      statusAfterWindow = await waitForStableStatus(statusFile, (status) => (
        status.abortObserved === true &&
        status.abortCount > 0 &&
        status.activeStreams === 0 &&
        status.completedStreams === 0 &&
        status.chunksAfterAbort === 0 &&
        statusAtCancel != null &&
        status.chunksEmitted === statusAtCancel.chunksEmitted
      ), 3000);
    } catch (error) {
      statusError = statusError ?? redact(error, token);
    }
    let rendererState = null;
    let rendererStateError = null;
    try {
      rendererState = await evaluate(`(() => {
      const isVisible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const busyMarkers = [...document.querySelectorAll('[aria-busy="true"], [data-streaming="true"]')].filter(isVisible).length;
      const activeCancelControls = [...document.querySelectorAll("button")].filter((button) => isVisible(button) && !button.disabled && /cancelar|parar|stop/i.test(button.innerText ?? "")).length;
      return { busyMarkers, activeCancelControls, streaming: busyMarkers > 0 || activeCancelControls > 0 };
      })()`);
    } catch (error) {
      rendererStateError = redact(error, token);
    }
    let rendererNoticeVisible = false;
    let rendererNoticeElement = null;
    try {
      rendererNoticeElement = await waitForMainPaneTextElement("interrompida", 5000);
      rendererNoticeVisible = true;
    } catch {
      rendererNoticeVisible = false;
    }
    report.checks.cancel = {
      bridgeResult: cancel,
      requestedAgent: "all-active",
      observedNotice: Boolean(notice),
      noticeError,
      rendererNoticeVisible,
      rendererNoticeElement,
      fixtureAtAbort: statusAtCancel,
      fixtureAfterQuiescence: statusAfterWindow,
      rendererState,
      rendererStateError,
      statusError,
      screenshot: await saveScreenshot("cancel"),
    };
    const cancelFailures = [];
    if (!cancel?.cancelled) cancelFailures.push("desktop bridge cancelPrompt did not cancel the turn");
    if (!Array.isArray(cancel?.agentIds) || cancel.agentIds.length === 0) cancelFailures.push("desktop bridge cancelPrompt returned no agent ids");
    if (!notice) cancelFailures.push("cancel notice was not observed");
    if (!statusAtCancel || !statusAfterWindow) cancelFailures.push("fixture abort status was not observable");
    if (statusAtCancel) {
      if (statusAtCancel.abortObserved !== true) cancelFailures.push("fixture did not observe the abort signal");
      if (!(statusAtCancel.abortCount > 0)) cancelFailures.push("fixture abort count was not positive");
      if (statusAtCancel.activeStreams !== 0) cancelFailures.push("fixture retained an active stream after cancellation");
      if (statusAtCancel.completedStreams !== 0) cancelFailures.push("fixture stream completed naturally before cancellation");
      if (statusAtCancel.chunksAfterAbort !== 0) cancelFailures.push("fixture emitted chunks after cancellation");
    }
    if (statusAtCancel && statusAfterWindow && (
      statusAfterWindow.chunksAfterAbort !== 0 ||
      statusAfterWindow.chunksEmitted !== statusAtCancel.chunksEmitted ||
      statusAfterWindow.completedStreams !== 0
    )) {
      cancelFailures.push("fixture post-abort counters were not stable");
    }
    if (!rendererState || rendererState.streaming) cancelFailures.push("renderer remained in streaming state after cancellation");
    if (!rendererNoticeVisible) cancelFailures.push("renderer cancellation notice was not visible");
    if (cancelFailures.length > 0) throw new Error(cancelFailures.join("; "));

    // Native shared-Skill flow: slash opens the renderer's own workflow list,
    // selection creates the native Tiptap chip, and Enter sends that turn.
    const skillFocused = await evaluate(`(() => {
      const element = [...document.querySelectorAll('[contenteditable="true"]')]
        .find((candidate) => candidate.getAttribute("aria-label") === "Prompt" || candidate.classList.contains("sand-prompt-field"));
      if (!element) return false;
      element.focus();
      return document.activeElement === element;
    })()`);
    if (!skillFocused) throw new Error("real composer could not receive focus for native skill flow");
    await cdp.send("Input.insertText", { text: "/" });
    const skillList = await waitForWorkflowList();
    let skillListMotion = null;
    const skillListMotionDeadline = Date.now() + 1500;
    while (Date.now() < skillListMotionDeadline) {
      skillListMotion = await evaluate(`(() => {
        const target = document.querySelector('.sand-workflow-listbox');
        if (!target) return null;
        const rect = target.getBoundingClientRect();
        return {
          kind: target.dataset.openbotMotion || null,
          duration: target.dataset.openbotMotionDuration || null,
          runs: target.dataset.openbotMotionRuns || null,
          activeAnimations: target.getAnimations().length,
          withinViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      })()`);
      if (skillListMotion?.runs) break;
      await sleep(25);
    }
    if (skillListMotion?.kind !== "surface" || skillListMotion.duration !== "220" || skillListMotion.runs !== "1" || !skillListMotion.withinViewport) {
      throw new Error(`workflow menu motion or edge placement failed: ${JSON.stringify(skillListMotion)}`);
    }
    report.checks.skillList = {
      method: "native-composer-slash",
      expectedNativeSurface: "Reference a skill / sand-workflow-listbox",
      observed: skillList,
      motion: skillListMotion,
      screenshot: await saveScreenshot("skill-menu"),
    };
    const skillItem = await evaluate(workflowItemRectExpression(SKILL_NAME));
    if (!skillItem) throw new Error(`native skill item was not selectable: ${SKILL_NAME}`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: skillItem.x, y: skillItem.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: skillItem.x, y: skillItem.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: skillItem.x, y: skillItem.y });
    const skillChip = await waitForWorkflowChip();
    report.checks.skillChip = {
      method: "native-workflow-reference",
      selectedItem: skillItem,
      chip: skillChip,
      screenshot: await saveScreenshot("skill-chip"),
    };
    const skillEditorFocused = await evaluate(`(() => {
      const element = [...document.querySelectorAll('[contenteditable="true"]')]
        .find((candidate) => candidate.getAttribute("aria-label") === "Prompt" || candidate.classList.contains("sand-prompt-field"));
      if (!element) return false;
      if (document.activeElement !== element) element.focus();
      return document.activeElement === element;
    })()`);
    if (!skillEditorFocused) throw new Error("composer lost focus after native skill selection");
    const describeSkillComposer = () => evaluate(`(() => {
      const composer = [...document.querySelectorAll('[contenteditable="true"]')]
        .find((candidate) => candidate.getAttribute("aria-label") === "Prompt" || candidate.classList.contains("sand-prompt-field"));
      if (!composer) return null;
      const selection = document.getSelection();
      const chip = composer.querySelector('.sand-workflow-chip, [data-type="workflowReference"]');
      const describeNode = (node) => node ? {
        nodeName: node.nodeName,
        text: String(node.textContent ?? "").slice(0, 240),
      } : null;
      return {
        active: document.activeElement === composer,
        innerText: String(composer.innerText ?? "").slice(0, 500),
        textContent: String(composer.textContent ?? "").slice(0, 500),
        innerHTML: String(composer.innerHTML ?? "").slice(0, 2000),
        chip: chip ? {
          text: String(chip.innerText ?? chip.textContent ?? "").trim(),
          dataType: chip.getAttribute("data-type"),
          className: typeof chip.className === "string" ? chip.className : null,
        } : null,
        selection: selection ? {
          collapsed: selection.isCollapsed,
          anchor: { node: describeNode(selection.anchorNode), offset: selection.anchorOffset },
          focus: { node: describeNode(selection.focusNode), offset: selection.focusOffset },
        } : null,
      };
    })()`);
    report.checks.skillComposerBeforePrompt = await describeSkillComposer();
    // A workflow reference is an atomic Tiptap node. End puts the caret after
    // that node before the real keyboard input appends the user's prompt.
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "End",
      code: "End",
      windowsVirtualKeyCode: 35,
      nativeVirtualKeyCode: 35,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "End",
      code: "End",
      windowsVirtualKeyCode: 35,
      nativeVirtualKeyCode: 35,
    });
    await cdp.send("Input.insertText", { text: ` ${SKILL_PROMPT}` });
    report.checks.skillComposerAfterPrompt = await describeSkillComposer();
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
    const skillSendEvidence = await waitForSendEvidence(SKILL_PROMPT, 12000);
    const skillBackendStatus = await waitForStatus(statusFile, (status) => (
      status.skillContextObserved === true &&
      status.skillResponseCompleted === true &&
      status.activeStreams === 0 &&
      status.completedStreams > 0
    ), 12000);
    const skillAssistantEvent = await waitForEvent(events, (event) => (
      event?.channel === "transcript" &&
      event?.payload?.type === "updated" &&
      event?.payload?.entry?.kind === "message" &&
      event?.payload?.entry?.role === "assistant" &&
      event?.payload?.entry?.streaming === false &&
      String(event.payload.entry.content ?? "").includes("E2E skill")
    ), 12000);
    const skillFinalState = await waitForSkillResponseQuiescence();
    const skillResponseElement = await waitForMainPaneTextElement(SKILL_RESPONSE_TEXT, 3000);
    report.checks.skill = {
      method: "native-chip+real-composer+CDP-Input",
      prompt: SKILL_PROMPT,
      sendEvidence: {
        composerEmpty: skillSendEvidence.composerEmpty,
        mainPane: skillSendEvidence.pane,
        userMessage: skillSendEvidence.userMessage,
      },
      backend: skillBackendStatus,
      assistantEvent: {
        role: skillAssistantEvent.payload.entry.role,
        content: skillAssistantEvent.payload.entry.content,
      },
      rendererQuiescence: {
        quiescent: skillFinalState.quiescent,
        busyMarkers: skillFinalState.busyMarkers,
        activeCancelControls: skillFinalState.activeCancelControls,
        workingIndicators: skillFinalState.workingIndicators,
      },
      finalResponse: {
        expected: SKILL_RESPONSE_TEXT,
        count: skillFinalState.responseCount,
        elements: skillFinalState.responseElements,
      },
      transcriptAssistantEvents: assistantTranscriptEvidence(),
      response: skillResponseElement,
      screenshot: await saveScreenshot("skill"),
    };

    await sleep(2000);
    await cdp.send("Performance.enable");
    const performanceBefore = await cdp.send("Performance.getMetrics");
    const idleWindowMs = 3000;
    await sleep(idleWindowMs);
    const performanceAfter = await cdp.send("Performance.getMetrics");
    const metric = (snapshot, name) => snapshot.metrics.find((entry) => entry.name === name)?.value || 0;
    const taskDurationDelta = metric(performanceAfter, "TaskDuration") - metric(performanceBefore, "TaskDuration");
    const rendererCpuPercent = (taskDurationDelta / (idleWindowMs / 1000)) * 100;
    const idleAnimations = await evaluate(`(() => ({
      activeOpenBotAnimations: [...document.querySelectorAll('[data-openbot-motion]')]
        .reduce((count, element) => count + element.getAnimations().length, 0),
      activeDocumentAnimations: document.getAnimations().length,
    }))()`);
    report.checks.idle = { idleWindowMs, taskDurationDelta, rendererCpuPercent, ...idleAnimations };
    if (idleAnimations.activeOpenBotAnimations !== 0 || rendererCpuPercent >= 10) {
      throw new Error(`idle motion/CPU gate failed: ${JSON.stringify(report.checks.idle)}`);
    }

    const retryComposerFocused = await evaluate(`(() => {
      const element = [...document.querySelectorAll("textarea, [contenteditable='true']")]
        .find((candidate) => candidate.getAttribute("aria-label") === "Prompt" || candidate.classList.contains("sand-prompt-field"));
      if (!element) return false;
      element.focus();
      element.click();
      return document.activeElement === element;
    })()`);
    if (!retryComposerFocused) throw new Error("composer could not receive focus for retry flow");
    await cdp.send("Input.insertText", { text: RETRY_PROMPT });
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
    const retrySendEvidence = await waitForSendEvidence(RETRY_PROMPT, 12000);
    const retryFailureStatus = await waitForStatus(statusFile, (status) => (
      status.retryFailureObserved === true && status.activeStreams === 0
    ), 12000);
    const retryErrorElement = await waitForMainPaneTextElement("O provedor está temporariamente indisponível", 12000);
    let retryButton = null;
    const retryButtonDeadline = Date.now() + 12000;
    while (Date.now() < retryButtonDeadline) {
      retryButton = await evaluate(`(() => {
        const button = [...document.querySelectorAll("button")].find((candidate) => {
          const style = getComputedStyle(candidate);
          const rect = candidate.getBoundingClientRect();
          return candidate.textContent?.trim() === "Tentar novamente" && candidate.previousElementSibling?.textContent?.startsWith("O provedor está temporariamente indisponível") && !candidate.disabled && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        });
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: button.textContent?.trim() ?? "" };
      })()`);
      if (retryButton) break;
      await sleep(100);
    }
    if (!retryButton) throw new Error("retry button was not visible after provider failure");
    const retryButtonFocused = await evaluate(`(() => {
      const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Tentar novamente" && candidate.previousElementSibling?.textContent?.startsWith("O provedor está temporariamente indisponível") && !candidate.disabled);
      if (!button) return false;
      button.focus();
      return document.activeElement === button;
    })()`);
    if (!retryButtonFocused) throw new Error("retry button could not receive keyboard focus");
    const retryActivated = await evaluate(`(() => {
      const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Tentar novamente" && candidate.previousElementSibling?.textContent?.startsWith("O provedor está temporariamente indisponível") && !candidate.disabled);
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!retryActivated) throw new Error("retry button handler could not be activated");
    const retrySuccessStatus = await waitForStatus(statusFile, (status) => (
      status.retrySuccessObserved === true && status.activeStreams === 0
    ), 12000);
    const retryResponseElement = await waitForMainPaneTextElement(RETRY_RESPONSE, 12000);
    const retryUserMessageCount = await evaluate(`(() => {
      const expected = ${JSON.stringify(RETRY_PROMPT)};
      return [...document.querySelectorAll("p")].filter((element) => element.textContent?.trim() === expected).length;
    })()`);
    if (retryUserMessageCount !== 1) throw new Error(`retry flow rendered ${retryUserMessageCount} copies of the user message`);
    report.checks.retry = {
      sendEvidence: {
        composerEmpty: retrySendEvidence.composerEmpty,
        mainPane: retrySendEvidence.pane,
        userMessage: retrySendEvidence.userMessage,
      },
      failure: retryFailureStatus,
      errorElement: retryErrorElement,
      button: retryButton,
      success: retrySuccessStatus,
      response: retryResponseElement,
      userMessageCount: retryUserMessageCount,
      screenshot: await saveScreenshot("retry"),
    };

    // Regression: a complete turn between polls must settle the send indicator.
    const instantPrompt = "desktop e2e instant response";
    await evaluate(`document.querySelector('[contenteditable="true"][aria-label="Prompt"]').focus()`);
    await cdp.send("Input.insertText", { text: instantPrompt });
    const actionPoint = async () => evaluate(`(() => {
      const button = document.querySelector('.sand-prompt-send');
      const rect = button.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    const clickAction = async (point, clickCount) => {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount, ...point });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount, ...point });
    };
    await clickAction(await actionPoint(), 1);
    const instantStatus = await waitForStatus(statusFile, (state) => state.instantResponses === 1, 12000);
    const settleDeadline = Date.now() + 1500;
    let instantSettled = false;
    while (Date.now() < settleDeadline) {
      instantSettled = await evaluate(`(() => {
        const status = document.getElementById('openbot-turn-status');
        return status?.hidden === true && document.querySelector('main')?.innerText.includes('E2E instant response completed.');
      })()`);
      if (instantSettled) break;
      await sleep(25);
    }
    if (!instantSettled) throw new Error("instant response retained the sending indicator after completion");
    const settledAfterCompletionMs = Date.now() - instantStatus.instantCompletedAt;
    // The native button has now changed to voice input, in the same click sequence.
    await clickAction(await actionPoint(), 2);
    await sleep(250);
    const instantUi = await evaluate(`(() => {
      const dock = document.querySelector('.sand-chat-input-dock');
      return {
        dictating: Boolean(document.querySelector('[aria-label="Stop dictation"]')),
        users: [...document.querySelectorAll('.sand-transcript-row')].filter(row =>
          row.querySelector('p')?.textContent?.trim() === ${JSON.stringify(instantPrompt)}).length,
        dockBackground: getComputedStyle(dock).backgroundColor,
        dockOpacity: getComputedStyle(dock).opacity,
      };
    })()`);
    if (instantUi.dictating || instantUi.users !== 1) throw new Error(`double-click send regression: ${JSON.stringify(instantUi)}`);
    if (!/^rgb\(/.test(instantUi.dockBackground) || instantUi.dockOpacity !== "1") throw new Error(`composer backing is not opaque: ${JSON.stringify(instantUi)}`);
    report.checks.instantResponse = { ...instantUi, settledAfterCompletionMs, providerResponses: instantStatus.instantResponses, screenshot: await saveScreenshot("instant-response") };

    report.checks.runtime = {
      exceptionThrown: [...initialRuntimeExceptions, ...runtimeExceptions],
      consoleErrors: [...initialRuntimeConsoleErrors, ...runtimeConsoleErrors],
      allowlist: [],
    };
    if (report.checks.runtime.exceptionThrown.length > 0 || report.checks.runtime.consoleErrors.length > 0) {
      throw new Error(`renderer runtime errors observed (${report.checks.runtime.exceptionThrown.length} exceptions, ${report.checks.runtime.consoleErrors.length} console errors)`);
    }
    report.status = "GREEN";
  } catch (error) {
    report.error = redact(error, token);
    report.checks.runtime = {
      exceptionThrown: [...initialRuntimeExceptions, ...runtimeExceptions],
      consoleErrors: [...initialRuntimeConsoleErrors, ...runtimeConsoleErrors],
      allowlist: [],
    };
    try {
      report.checks.failureScreenshot = await saveScreenshot("failure");
    } catch (captureError) {
      report.checks.failureScreenshot = false;
      report.checks.failureScreenshotError = redact(captureError, token);
    }
  } finally {
    events?.close();
    cdp?.ws.close();
    report.finishedAt = new Date().toISOString();
    await writeFile(`${evidenceDir}/cdp-report.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  process.stdout.write(`E2E_CDP_REPORT ${JSON.stringify({ status: report.status, checks: Object.keys(report.checks), error: report.error ?? null })}\n`);
  process.exit(report.status === "GREEN" ? 0 : 1);
}

main().catch((error) => {
  const token = process.env.E2E_GATEWAY_TOKEN;
  process.stderr.write(`E2E_CDP_FATAL ${redact(error, token)}\n`);
  process.exit(1);
});
