"use strict";

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

// src/electron-preload/preload-webview.cts
installSandBrowserPreload();
//# sourceMappingURL=preload-webview.cjs.map
