"use strict";

// dune/src/internal/rpc/contract.ts
function declareRpcContract(edge, ...events) {
  return { edge, hasEvents: events.length > 0 };
}

// dune/src/internal/rpc/edge.ts
var EDGE_UNKNOWN_METHOD = "edge/unknown-method";
var EDGE_HANDLER_FAILED = "edge/handler-failed";
var EdgeCallFailure = class extends Error {
  code;
  detail;
  constructor(failure) {
    super(`${failure.code}: ${failure.detail}`);
    this.name = "EdgeCallFailure";
    this.code = failure.code;
    this.detail = failure.detail;
  }
};
function isEdgeReplyEnvelope(value) {
  if (typeof value !== "object" || value == null || !("ok" in value)) return false;
  return typeof value.ok === "boolean";
}
function methodChannel(edge, method) {
  return `sand-rpc:${edge}:m:${method}`;
}
function eventChannel(edge, event) {
  return `sand-rpc:${edge}:e:${event}`;
}
function bridgeEdge(contract, table, transport) {
  const bridge = {};
  const callMethod = async (method, payload) => {
    let reply;
    try {
      reply = await transport.invoke(methodChannel(contract.edge, method), payload);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new EdgeCallFailure({ code: EDGE_UNKNOWN_METHOD, detail });
    }
    if (!isEdgeReplyEnvelope(reply)) {
      throw new EdgeCallFailure({
        code: EDGE_HANDLER_FAILED,
        detail: "The edge replied outside its envelope."
      });
    }
    if (reply.ok) return reply.value;
    throw new EdgeCallFailure(reply.failure);
  };
  for (const [method, row] of Object.entries(table)) {
    bridge[method] = row.args === "none" ? () => callMethod(method, {}) : (args) => callMethod(method, args);
  }
  if (contract.hasEvents) {
    bridge.subscribe = (handlers) => {
      const unsubscribes = [];
      for (const [event, listener] of Object.entries(handlers)) {
        if (listener == null) continue;
        unsubscribes.push(
          transport.on(eventChannel(contract.edge, event), listener)
        );
      }
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    };
  }
  return bridge;
}

// dune/src/internal/scheduling/clock.ts
var realClock = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
  schedule(delayMs, fn) {
    assertDelay(delayMs);
    let active = true;
    const timer = globalThis.setTimeout(() => {
      if (!active) return;
      active = false;
      fn();
    }, delayMs);
    timer.unref?.();
    return {
      dispose() {
        if (!active) return;
        active = false;
        globalThis.clearTimeout(timer);
      }
    };
  }
};
function assertDelay(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError("delayMs must be a finite non-negative number");
  }
}

// dune/src/internal/scheduling/policies.ts
var DeadlineExceededError = class extends Error {
  constructor(policyName) {
    super(`Deadline exceeded for ${policyName}`);
    this.policyName = policyName;
    this.name = "DeadlineExceededError";
  }
  policyName;
  code = "deadline_exceeded";
};
function createDeadlinePolicy(clock, options) {
  assertName(options.name);
  assertDuration(options.timeoutMs, "timeoutMs");
  return {
    name: options.name,
    async run(work, signal) {
      if (signal?.aborted) throw abortReason(signal);
      const controller = new AbortController();
      let rejectTimeout = () => {
      };
      const timeout = new Promise((_, reject) => {
        rejectTimeout = reject;
      });
      let rejectCancellation = () => {
      };
      const cancellation = new Promise((_, reject) => {
        rejectCancellation = reject;
      });
      let removeAbortListener = () => {
      };
      if (signal != null) {
        const abort = () => {
          const reason = abortReason(signal);
          rejectCancellation(reason);
          controller.abort(reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      const deadline = clock.schedule(options.timeoutMs, () => {
        const error = new DeadlineExceededError(options.name);
        rejectTimeout(error);
        controller.abort(error);
      });
      try {
        return await Promise.race([work(controller.signal), timeout, cancellation]);
      } finally {
        deadline.dispose();
        removeAbortListener();
      }
    }
  };
}
function createPollingPolicy(clock, options) {
  assertName(options.name);
  assertDuration(options.intervalMs, "intervalMs");
  if (options.intervalMs === 0) {
    throw new RangeError("intervalMs must be greater than 0");
  }
  return {
    name: options.name,
    start(tick, signal) {
      let active = true;
      let scheduled;
      let removeAbortListener = () => {
      };
      const dispose = () => {
        if (!active) return;
        active = false;
        scheduled?.dispose();
        scheduled = void 0;
        removeAbortListener();
      };
      const run = () => {
        scheduled = void 0;
        if (!active) return;
        let completion;
        try {
          completion = tick();
        } catch {
          dispose();
          return;
        }
        void completion.then(
          () => {
            if (!active) return;
            scheduled = clock.schedule(options.intervalMs, run);
          },
          () => dispose()
        );
      };
      const polling = { dispose };
      if (signal?.aborted) {
        dispose();
        return polling;
      }
      if (signal != null) {
        signal.addEventListener("abort", dispose, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", dispose);
      }
      run();
      return polling;
    }
  };
}
function abortReason(signal) {
  return signal.reason ?? createAbortError();
}
function createAbortError() {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
function assertName(name, field = "name") {
  if (name.trim().length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
}
function assertDuration(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}

// dune/src/scheduling.ts
function createDeadlinePolicy2(options) {
  return createDeadlinePolicy(realClock, options);
}
function createPollingPolicy2(options) {
  return createPollingPolicy(realClock, options);
}

// src/shared/rpc/vnc.ts
var boxVncRpcContract = declareRpcContract("box-vnc");
var BOX_VNC_METHOD_TABLE = {
  readClipboard: { args: "none" },
  writeClipboard: { args: "object" },
  reportUserPresence: { args: "object" }
};

// src/shared/vnc-liveness.ts
var VNC_LIVENESS_CHANNEL = "sand:vnc-liveness";
var VNC_LIVENESS_WINDOW_MS = 1e4;
var VNC_LIVENESS_MIN_IMPACTFUL_INPUTS = 3;

// src/shared/vnc-viewer-visibility.ts
var VNC_VIEWER_VISIBLE_CHANNEL = "sand:vnc-viewer-visible";

// src/electron-preload/box-vnc-clipboard-paste.ts
function buildHostClipboardPasteScript(text) {
  const encodedText = JSON.stringify(text);
  return `
    import("./app/ui.js")
      .then(function (m) {
        var rfb = m && m.default && m.default.rfb;
        var text = ${encodedText};
        if (rfb && typeof rfb.clipboardPasteFrom === "function" && text) {
          rfb.clipboardPasteFrom(text);
          return true;
        }
        return false;
      })
      .catch(function () {
        return false;
      });
  `;
}
function resolveHostToBoxSync(text, didPaste) {
  return didPaste && text.length > 0 ? text : null;
}

// src/electron-preload/box-vnc-liveness.ts
var BEACON_GLOBAL = "__sandVncLivenessBeacon";
function buildVncLivenessBeaconScript() {
  return `
    (function () {
      if (window.${BEACON_GLOBAL}) return;
      var counters = { keys: 0, clicks: 0, moves: 0, drawOps: 0, inBytes: 0 };
      window.${BEACON_GLOBAL} = counters;
      var PRIMARY_BUTTON_MASK_BITS = 0x07;
      var lastButtonMask = 0;
      import("./core/rfb.js").then(function (m) {
        var messages = m.default.messages;
        var keyEvent = messages.keyEvent;
        messages.keyEvent = function (sock, keysym, down) {
          if (down) counters.keys += 1;
          return keyEvent.apply(this, arguments);
        };
        if (typeof messages.QEMUExtendedKeyEvent === "function") {
          var qemuKeyEvent = messages.QEMUExtendedKeyEvent;
          messages.QEMUExtendedKeyEvent = function (sock, keysym, down) {
            if (down) counters.keys += 1;
            return qemuKeyEvent.apply(this, arguments);
          };
        }
        var pointerEvent = messages.pointerEvent;
        messages.pointerEvent = function (sock, x, y, mask) {
          if (mask & ~lastButtonMask & PRIMARY_BUTTON_MASK_BITS) counters.clicks += 1;
          else counters.moves += 1;
          lastButtonMask = mask;
          return pointerEvent.apply(this, arguments);
        };
      }).catch(function () {});
      import("./core/display.js").then(function (m) {
        var damage = m.default.prototype._damage;
        m.default.prototype._damage = function () {
          counters.drawOps += 1;
          return damage.apply(this, arguments);
        };
      }).catch(function () {});
      import("./core/websock.js").then(function (m) {
        var recvMessage = m.default.prototype._recvMessage;
        m.default.prototype._recvMessage = function (e) {
          counters.inBytes += (e && e.data && e.data.byteLength) || 0;
          return recvMessage.apply(this, arguments);
        };
      }).catch(function () {});
    })();
  `;
}
function buildVncLivenessBeaconReadExpression() {
  return `JSON.stringify(window.${BEACON_GLOBAL} || null)`;
}
function isBeaconCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function parseVncLivenessBeaconCounters(raw) {
  if (typeof raw !== "string") return null;
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const counters = parsed;
  if (!isBeaconCount(counters.keys) || !isBeaconCount(counters.clicks) || !isBeaconCount(counters.moves) || !isBeaconCount(counters.drawOps) || !isBeaconCount(counters.inBytes)) {
    return null;
  }
  return {
    keys: counters.keys,
    clicks: counters.clicks,
    moves: counters.moves,
    drawOps: counters.drawOps,
    inBytes: counters.inBytes
  };
}
function createVncLivenessDetector() {
  let last = null;
  let samples = [];
  let coveredSinceMs = null;
  let episodeFired = false;
  function reset() {
    last = null;
    samples = [];
    coveredSinceMs = null;
    episodeFired = false;
  }
  function rebaseline(nowMs, counters) {
    reset();
    last = counters;
    coveredSinceMs = nowMs;
  }
  function sample(nowMs, counters) {
    if (last == null) {
      rebaseline(nowMs, counters);
      return null;
    }
    const delta = {
      atMs: nowMs,
      keys: counters.keys - last.keys,
      clicks: counters.clicks - last.clicks,
      moves: counters.moves - last.moves,
      drawOps: counters.drawOps - last.drawOps,
      inBytes: counters.inBytes - last.inBytes
    };
    if (delta.keys < 0 || delta.clicks < 0 || delta.moves < 0 || delta.drawOps < 0 || delta.inBytes < 0) {
      rebaseline(nowMs, counters);
      return null;
    }
    last = counters;
    samples.push(delta);
    const windowStartMs = nowMs - VNC_LIVENESS_WINDOW_MS;
    samples = samples.filter((entry) => entry.atMs > windowStartMs);
    if (delta.drawOps > 0) episodeFired = false;
    if (episodeFired) return null;
    if (coveredSinceMs == null || nowMs - coveredSinceMs < VNC_LIVENESS_WINDOW_MS) return null;
    let keys = 0;
    let clicks = 0;
    let moves = 0;
    let drawOps = 0;
    let inBytes = 0;
    for (const entry of samples) {
      keys += entry.keys;
      clicks += entry.clicks;
      moves += entry.moves;
      drawOps += entry.drawOps;
      inBytes += entry.inBytes;
    }
    if (keys + clicks < VNC_LIVENESS_MIN_IMPACTFUL_INPUTS) return null;
    if (drawOps > 0 || inBytes > 0) return null;
    episodeFired = true;
    const oldestUnansweredInput = samples.find((entry) => entry.keys + entry.clicks > 0);
    return {
      phase: "post_connect",
      stallMs: nowMs - (oldestUnansweredInput?.atMs ?? nowMs),
      keys,
      clicks,
      moves,
      inBytes
    };
  }
  return { sample, reset };
}

// src/electron-preload/box-vnc-visibility-gate.ts
function createViewerVisibilityGate() {
  let isVisible = false;
  return {
    isVisible: () => isVisible,
    update(value) {
      const next = value === true;
      const becameVisible = next && !isVisible;
      isVisible = next;
      return becameVisible;
    }
  };
}

// src/electron-preload/passkey-stall.ts
var PASSKEY_STALL_MS = 6e4;
function raceWithPasskeyStallDeadline(options) {
  return options.policy.run(() => options.call).catch((error) => {
    if (error instanceof DeadlineExceededError) {
      options.reportStall({ method: options.method, since: options.since });
      throw options.buildStallError();
    }
    throw error;
  });
}

// src/electron-preload/preload-browser-base.cts
var IDP_HOSTNAME_ALLOWLIST = [
  ".okta.com",
  ".okta-emea.com",
  ".oktapreview.com",
  ".duosecurity.com",
  ".login.microsoftonline.com",
  ".onelogin.com",
  ".auth0.com",
  ".pingidentity.com",
  ".rippling.com"
];
function getErrorMessage(error) {
  return error instanceof Error ? error.message : void 0;
}
function logWarn(...args) {
  console.warn("[sand-webview-preload]", ...args);
}
var electronLoaded = false;
var ipcRendererInstance = null;
var webFrameInstance = null;
function loadElectron() {
  if (electronLoaded) return;
  electronLoaded = true;
  try {
    const electronModule = require("electron");
    ipcRendererInstance = electronModule.ipcRenderer ?? null;
    webFrameInstance = electronModule.webFrame ?? null;
  } catch (err) {
    logWarn("electron module unavailable", getErrorMessage(err));
  }
}
function getIpcRenderer() {
  loadElectron();
  return ipcRendererInstance;
}
function getWebFrame() {
  loadElectron();
  return webFrameInstance;
}
function isAllowlistedIdpHost(hostname) {
  if (typeof hostname !== "string" || hostname.length === 0) return false;
  for (let i = 0; i < IDP_HOSTNAME_ALLOWLIST.length; i++) {
    if (hostname.endsWith(IDP_HOSTNAME_ALLOWLIST[i])) return true;
  }
  return false;
}
function injectLocalNetworkAccessPolyfill() {
  const frame = getWebFrame();
  if (frame == null) return;
  if (typeof location === "undefined") return;
  if (!isAllowlistedIdpHost(location.hostname)) return;
  const polyfill = `
    (function () {
      var permissions = navigator && navigator.permissions;
      if (!permissions || typeof permissions.query !== "function") return;
      if (permissions.__sandLocalNetworkPolyfill) return;
      permissions.__sandLocalNetworkPolyfill = true;
      var originalQuery = permissions.query.bind(permissions);
      permissions.query = function (descriptor) {
        var name = descriptor && descriptor.name;
        if (name === "local-network-access" || name === "local-network") {
          var status = new EventTarget();
          Object.defineProperties(status, {
            name: { value: name },
            state: { value: "granted" },
            onchange: { value: null, writable: true },
          });
          return Promise.resolve(status);
        }
        return originalQuery(descriptor);
      };
    })();
  `;
  frame.executeJavaScript(polyfill).catch((err) => {
    logWarn("local network polyfill injection failed", getErrorMessage(err));
  });
}
function buildPasskeyStallError() {
  try {
    return new DOMException("Passkey request stalled", "NotAllowedError");
  } catch (_err) {
    const fallback = new Error("Passkey request stalled");
    fallback.name = "NotAllowedError";
    return fallback;
  }
}
var passkeyStallDeadline = createDeadlinePolicy2({
  name: "sand-webview-passkey-stall",
  timeoutMs: PASSKEY_STALL_MS
});
function wrapCredentialMethod(renderer, method, originalFn) {
  return function patchedCredentialMethod(...args) {
    const since = Date.now();
    let callPromise;
    try {
      const result = originalFn.apply(navigator.credentials, args);
      callPromise = Promise.resolve(result);
    } catch (err) {
      return Promise.reject(err);
    }
    return raceWithPasskeyStallDeadline({
      policy: passkeyStallDeadline,
      method,
      since,
      call: callPromise,
      reportStall: (report) => {
        try {
          renderer.sendToHost("sand:browser-passkey-stalled", report);
        } catch (err) {
          logWarn("passkey stall send failed", getErrorMessage(err));
        }
      },
      buildStallError: buildPasskeyStallError
    });
  };
}
function installWebAuthnPolyfill() {
  if (typeof navigator === "undefined") return;
  const renderer = getIpcRenderer();
  if (renderer == null) return;
  if (!navigator.credentials) return;
  if (typeof navigator.credentials.create === "function") {
    const originalCreate = navigator.credentials.create.bind(navigator.credentials);
    navigator.credentials.create = wrapCredentialMethod(renderer, "create", originalCreate);
  }
  if (typeof navigator.credentials.get === "function") {
    const originalGet = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = wrapCredentialMethod(renderer, "get", originalGet);
  }
}
function installDialogStubs() {
  if (typeof window === "undefined") return;
  if (window.__sandDialogOverridesApplied === true) return;
  window.alert = function sandAlertStub() {
  };
  window.confirm = function sandConfirmStub() {
    return true;
  };
  window.prompt = function sandPromptStub() {
    return null;
  };
  window.__sandDialogOverridesApplied = true;
}
function installIpcWiring() {
  const renderer = getIpcRenderer();
  if (renderer == null) return;
  const activeRenderer = renderer;
  if (typeof window === "undefined" || typeof location === "undefined") {
    return;
  }
  const originalOrigin = location.origin;
  function sendPopupClosed() {
    try {
      activeRenderer.sendToHost("sand:browser-popup-closed", {
        url: location.href
      });
    } catch (err) {
      logWarn("popup-closed send failed", getErrorMessage(err));
    }
  }
  window.addEventListener("beforeunload", sendPopupClosed);
  window.addEventListener("pagehide", sendPopupClosed);
  window.addEventListener("pageshow", function onPageShow(event) {
    if (!event || event.persisted !== true) return;
    if (location.origin !== originalOrigin) return;
    try {
      activeRenderer.sendToHost("sand:browser-origin-return", {
        origin: originalOrigin,
        currentUrl: location.href
      });
    } catch (err) {
      logWarn("origin-return send failed", getErrorMessage(err));
    }
  });
}
function installSandBrowserPreload() {
  try {
    injectLocalNetworkAccessPolyfill();
  } catch (err) {
    logWarn("local network polyfill install failed", getErrorMessage(err));
  }
  try {
    installWebAuthnPolyfill();
  } catch (err) {
    logWarn("webauthn polyfill install failed", getErrorMessage(err));
  }
  try {
    installDialogStubs();
  } catch (err) {
    logWarn("dialog stubs install failed", getErrorMessage(err));
  }
  try {
    installIpcWiring();
  } catch (err) {
    logWarn("ipc wiring install failed", getErrorMessage(err));
  }
}

// src/electron-preload/preload-vnc.cts
function resolveBoxVncEdge() {
  const renderer = getIpcRenderer();
  if (renderer == null) return null;
  const transport = {
    invoke: (channel, payload) => renderer.invoke(channel, payload),
    on: (channel, listener) => {
      const wrapped = (_event, payload) => {
        listener(payload);
      };
      renderer.on(channel, wrapped);
      return () => {
        renderer.off(channel, wrapped);
      };
    }
  };
  return bridgeEdge(boxVncRpcContract, BOX_VNC_METHOD_TABLE, transport);
}
function isInteractiveVncPage() {
  if (typeof location === "undefined") return false;
  if (!location.pathname.endsWith("/vnc.html")) return false;
  try {
    return new URLSearchParams(location.search).get("sandInteractive") === "1";
  } catch (_err) {
    return false;
  }
}
function getVncClipboardTextarea() {
  if (typeof document === "undefined") return null;
  const el = document.getElementById("noVNC_clipboard_text");
  return el instanceof HTMLTextAreaElement ? el : null;
}
function installNoVncChromeHider() {
  if (typeof location === "undefined") return;
  if (!location.pathname.endsWith("/vnc.html")) return;
  const css = `
    #noVNC_control_bar,
    #noVNC_control_bar_handle,
    #noVNC_control_bar_anchor,
    #noVNC_status,
    .noVNC_logo {
      display: none !important;
      pointer-events: none !important;
      visibility: hidden !important;
    }
  `;
  try {
    getWebFrame()?.insertCSS(css);
  } catch (err) {
    logWarn("noVNC CSS injection failed", getErrorMessage(err));
  }
  function apply() {
    document.getElementById("noVNC_control_bar")?.classList.remove("noVNC_open");
  }
  if (typeof document === "undefined") return;
  apply();
  document.addEventListener("DOMContentLoaded", apply, { once: true });
  window.addEventListener("load", apply, { once: true });
}
function installVncClipboardBridge() {
  const renderer = getIpcRenderer();
  const bridge = resolveBoxVncEdge();
  if (renderer == null || bridge == null) return;
  const vncEdge = bridge;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (!isInteractiveVncPage()) return;
  const POLL_MS = 500;
  const GESTURE_THROTTLE_MS = 200;
  let lastBoxTextSentToHost = "";
  let lastHostTextSentToBox = "";
  let lastGestureAt = 0;
  const visibility = createViewerVisibilityGate();
  renderer.on(VNC_VIEWER_VISIBLE_CHANNEL, (_event, value) => {
    if (visibility.update(value)) mirrorHostClipboardToBox();
  });
  function mirrorBoxClipboardToHost() {
    if (!visibility.isVisible()) return;
    const textarea = getVncClipboardTextarea();
    if (textarea == null) return;
    const text = textarea.value;
    if (text.length === 0) return;
    if (text === lastHostTextSentToBox || text === lastBoxTextSentToHost) {
      return;
    }
    lastBoxTextSentToHost = text;
    void vncEdge.writeClipboard({ text }).catch((err) => {
      logWarn("vnc clipboard write failed", getErrorMessage(err));
    });
  }
  function mirrorHostClipboardToBox() {
    if (!visibility.isVisible()) return;
    const now = Date.now();
    if (now - lastGestureAt < GESTURE_THROTTLE_MS) return;
    lastGestureAt = now;
    vncEdge.readClipboard().then((text) => {
      if (text.length === 0) return;
      const frame = getWebFrame();
      if (frame == null) return;
      frame.executeJavaScript(buildHostClipboardPasteScript(text)).then((didPaste) => {
        const synced = resolveHostToBoxSync(text, didPaste === true);
        if (synced == null) return;
        lastHostTextSentToBox = synced;
        const textarea = getVncClipboardTextarea();
        if (textarea != null) textarea.value = synced;
      }).catch((err) => {
        logWarn("vnc clipboard paste failed", getErrorMessage(err));
      });
    }).catch((err) => {
      logWarn("vnc clipboard read failed", getErrorMessage(err));
    });
  }
  const clipboardPolling = createPollingPolicy2({
    name: "vnc-clipboard-mirror",
    intervalMs: POLL_MS
  }).start(async () => {
    mirrorBoxClipboardToHost();
  });
  window.addEventListener("focus", mirrorHostClipboardToBox);
  document.addEventListener("mousedown", mirrorHostClipboardToBox, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") mirrorHostClipboardToBox();
  });
  window.addEventListener("pagehide", () => clipboardPolling.dispose(), {
    once: true
  });
}
function installVncUserPresenceReporter() {
  const bridge = resolveBoxVncEdge();
  if (bridge == null) return;
  const vncEdge = bridge;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (!isInteractiveVncPage()) return;
  if (document.documentElement == null) {
    document.addEventListener("DOMContentLoaded", () => installVncUserPresenceReporter(), {
      once: true
    });
    return;
  }
  let lastSent = null;
  function report(isPresent) {
    if (isPresent === lastSent) return;
    lastSent = isPresent;
    void vncEdge.reportUserPresence({ isPresent }).catch((err) => {
      logWarn("vnc user presence report failed", getErrorMessage(err));
    });
  }
  const root = document.documentElement;
  root.addEventListener("mouseenter", () => report(true));
  root.addEventListener("mouseleave", () => report(false));
  document.addEventListener("mousemove", () => report(true), { passive: true });
  window.addEventListener("blur", () => report(false));
  window.addEventListener("pagehide", () => report(false), { once: true });
}
function installVncHostKeyForwarder() {
  const renderer = getIpcRenderer();
  if (renderer == null) return;
  if (typeof document === "undefined") return;
  if (!isInteractiveVncPage()) return;
  const FORWARDED_ARROWS = /* @__PURE__ */ new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
  document.addEventListener(
    "keydown",
    (event) => {
      if (FORWARDED_ARROWS.has(event.key)) {
        try {
          renderer.sendToHost("sand:vnc-host-key", event.key);
        } catch (err) {
          logWarn("vnc host key forward failed", getErrorMessage(err));
        }
      }
    },
    true
  );
}
function installVncRfbSessionReporter() {
  const renderer = getIpcRenderer();
  if (renderer == null) return;
  const activeRenderer = renderer;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (typeof location === "undefined") return;
  if (!location.pathname.endsWith("/vnc.html")) return;
  function report(phase, clean) {
    try {
      activeRenderer.sendToHost("sand:vnc-session", JSON.stringify({ phase, clean }));
    } catch (err) {
      logWarn("vnc session report failed", getErrorMessage(err));
    }
  }
  let connectCount = 0;
  let reportedConnected = false;
  let last = null;
  function currentState() {
    const c = document.documentElement.classList;
    if (c.contains("noVNC_connected")) return "connected";
    if (c.contains("noVNC_reconnecting")) return "reconnecting";
    if (c.contains("noVNC_connecting")) return "connecting";
    if (c.contains("noVNC_disconnecting")) return "disconnecting";
    return "disconnected";
  }
  function evaluate() {
    const state = currentState();
    if (state === last) return;
    last = state;
    if (state === "connected") {
      connectCount += 1;
      report(connectCount > 1 ? "reconnect" : "rfb_connect", true);
      reportedConnected = true;
    } else if (reportedConnected && state !== "connecting") {
      report("rfb_disconnect", state === "disconnecting");
      reportedConnected = false;
    }
  }
  function start() {
    const observer = new MutationObserver(evaluate);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"]
    });
    evaluate();
    window.addEventListener("pagehide", () => observer.disconnect(), {
      once: true
    });
  }
  if (document.documentElement == null) {
    document.addEventListener("DOMContentLoaded", () => start(), { once: true });
  } else {
    start();
  }
}
function installVncLivenessTripwire() {
  const renderer = getIpcRenderer();
  const frame = getWebFrame();
  if (renderer == null || frame == null) return;
  const activeRenderer = renderer;
  const activeFrame = frame;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (!isInteractiveVncPage()) return;
  activeFrame.executeJavaScript(buildVncLivenessBeaconScript()).catch((err) => {
    logWarn("vnc liveness beacon install failed", getErrorMessage(err));
  });
  const detector = createVncLivenessDetector();
  const readExpression = buildVncLivenessBeaconReadExpression();
  const polling = createPollingPolicy2({
    name: "vnc-liveness-sampler",
    intervalMs: 1e3
  }).start(async () => {
    if (document.documentElement?.classList.contains("noVNC_connected") !== true) {
      detector.reset();
      return;
    }
    try {
      const raw = await activeFrame.executeJavaScript(readExpression);
      const counters = parseVncLivenessBeaconCounters(raw);
      if (counters == null) return;
      const report = detector.sample(performance.now(), counters);
      if (report == null) return;
      activeRenderer.sendToHost(VNC_LIVENESS_CHANNEL, report);
    } catch (err) {
      logWarn("vnc liveness sample failed", getErrorMessage(err));
    }
  });
  window.addEventListener("pagehide", () => polling.dispose(), { once: true });
}
function installVncMacKeyMapping() {
  const frame = getWebFrame();
  if (frame == null) return;
  if (!isInteractiveVncPage()) return;
  const script = `
    (function () {
      if (window.__sandVncMacKeysInstalled) return;
      if (!/Mac/i.test((navigator && navigator.platform) || "")) return;
      window.__sandVncMacKeysInstalled = true;

      var SHORTCUTS = { KeyA: 0x61, KeyC: 0x63, KeyV: 0x76, KeyX: 0x78, KeyZ: 0x7a };
      var CONTROL_L = 0xffe3;
      var SHIFT_L = 0xffe1;
      var HELD_MODIFIERS = [
        [0xffe7, "MetaLeft"], [0xffe8, "MetaRight"],
        [0xffe9, "AltLeft"], [0xffea, "AltRight"],
        [0xffeb, "SuperLeft"], [0xffec, "SuperRight"]
      ];

      var ui = null;
      import("./app/ui.js")
        .then(function (m) { ui = m && m.default; })
        .catch(function () {});

      document.addEventListener("keydown", function (e) {
        if (!e.metaKey) return;
        var keysym = SHORTCUTS[e.code];
        if (keysym === undefined) return;
        var rfb = ui && ui.rfb;
        if (!rfb || typeof rfb.sendKey !== "function") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        // noVNC presses Meta/Alt down for Cmd, so release them first to avoid
        // sending Alt+Ctrl+key instead of a clean Ctrl+key.
        for (var i = 0; i < HELD_MODIFIERS.length; i++) {
          try { rfb.sendKey(HELD_MODIFIERS[i][0], HELD_MODIFIERS[i][1], false); } catch (_e) {}
        }
        rfb.sendKey(CONTROL_L, "ControlLeft", true);
        if (e.shiftKey) rfb.sendKey(SHIFT_L, "ShiftLeft", true);
        rfb.sendKey(keysym, e.code, true);
        rfb.sendKey(keysym, e.code, false);
        if (e.shiftKey) rfb.sendKey(SHIFT_L, "ShiftLeft", false);
        rfb.sendKey(CONTROL_L, "ControlLeft", false);
      }, true);
    })();
  `;
  frame.executeJavaScript(script).catch((err) => {
    logWarn("vnc mac key mapping injection failed", getErrorMessage(err));
  });
}
installSandBrowserPreload();
try {
  installNoVncChromeHider();
} catch (err) {
  logWarn("noVNC chrome hider install failed", getErrorMessage(err));
}
try {
  installVncClipboardBridge();
} catch (err) {
  logWarn("vnc clipboard bridge install failed", getErrorMessage(err));
}
try {
  installVncUserPresenceReporter();
} catch (err) {
  logWarn("vnc user presence reporter install failed", getErrorMessage(err));
}
try {
  installVncHostKeyForwarder();
} catch (err) {
  logWarn("vnc host key forwarder install failed", getErrorMessage(err));
}
try {
  installVncRfbSessionReporter();
} catch (err) {
  logWarn("vnc rfb session reporter install failed", getErrorMessage(err));
}
try {
  installVncMacKeyMapping();
} catch (err) {
  logWarn("vnc mac key mapping install failed", getErrorMessage(err));
}
try {
  installVncLivenessTripwire();
} catch (err) {
  logWarn("vnc liveness tripwire install failed", getErrorMessage(err));
}
//# sourceMappingURL=preload-vnc.cjs.map
