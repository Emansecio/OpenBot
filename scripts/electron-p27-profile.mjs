/**
 * P2.7 renderer lifecycle profiler.
 *
 * The probe owns a temporary backend, Electron profile, gateway port and CDP
 * port. Instrumentation is injected into the document through CDP before a
 * reload; no renderer file is modified. A real paid provider is never used:
 * the backend child registers a deterministic in-process adapter.
 */
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(process.env.OPENBOT_ROOT || dirname(dirname(fileURLToPath(import.meta.url))));
const requireFromProject = createRequire(join(repoRoot, "package.json"));
const electronExecutable = process.env.ELECTRON_EXE || requireFromProject("electron");
const electronMain = process.env.OPENBOT_ELECTRON_MAIN || join(repoRoot, "client", "extracted", "dist", "electron-main", "main.cjs");
const backendEntry = join(repoRoot, "dist", "main.js");

export const THRESHOLDS = Object.freeze({
  observerInstances: 1,
  callbackP95Ms: 2,
  callbackMaxMs: 8,
  callbackShare: 0.05,
  scanP95Ms: 4,
  scanMaxMs: 16.7,
  longTaskMs: 50,
  eventLoopLagP95Ms: 50,
  eventLoopLagMaxMs: 100,
  idleCpuPercent: 10,
  idleScanCallbacks: 2,
  retainedHeapGrowthBytes: 2 * 1024 * 1024,
  retainedCountGrowthPercent: 10,
});

const INSTRUMENTATION_SOURCE = String.raw`(() => {
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeRaf = window.requestAnimationFrame?.bind(window);
  const nativeCancelRaf = window.cancelAnimationFrame?.bind(window);
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  const state = {
    version: 1,
    startedAt: performance.now(),
    observerConstructed: 0,
    overlayObserverConstructed: 0,
    overlayObserverConstructedByOverlay: {},
    observerObserveCalls: 0,
    observerDisconnects: 0,
    activeObservers: new Set(),
    activeOverlayObservers: new Map(),
    callbackCount: 0,
    callbackMutationRecords: 0,
    callbackDurations: [],
    callbackTotalMs: 0,
    overlayCallbackDurations: [],
    overlayCallbackTotalMs: 0,
    scanSignatureMatches: 0,
    scanCallbacks: 0,
    scanDurations: [],
    scanTotalMs: 0,
    scanQuerySelectorAllCalls: 0,
    scanQuerySelectorAllMs: 0,
    timerCreated: 0,
    timerFired: 0,
    timerCleared: 0,
    activeTimers: new Map(),
    rafCreated: 0,
    rafFired: 0,
    rafCancelled: 0,
    activeRafs: new Set(),
    listenerAdds: 0,
    listenerRemoves: 0,
    listenerNet: new Map(),
    overlayListenerAdds: 0,
    overlayListenerRemoves: 0,
    longTaskMeasured: false,
    longTaskCount: 0,
    longTaskTotalMs: 0,
    longTaskMaxMs: 0,
    lagMeasured: false,
    lagSamples: [],
    marks: [],
    phases: {},
    measurementStartedAt: performance.now(),
    querySelectorAllMeasured: true,
    samplerActive: true,
  };
  const overlaySource = /(?:scanTimer|scheduleSettingsScan|observePortalRoot|collectMotionTargets|localUiClosed|localTimers|promptStatusTimer|profileSaveResetTimer|checkEmptyAgentState)/u;
  const overlayName = (source) => /(?:scheduleSettingsScan|observePortalRoot|collectMotionTargets)/u.test(source) ? "local-settings" : /(?:scanTimer|localUiClosed|localTimers)/u.test(source) ? "memory-ui" : "overlay";
  const listenerIds = new WeakMap();
  const targetIds = new WeakMap();
  let nextListenerId = 1;
  let nextTargetId = 1;
  const sourceOf = (value) => {
    try { return Function.prototype.toString.call(value); } catch { return ""; }
  };
  const targetOf = (target) => target === window ? "window" : target === document ? "document" : target?.id ? "#" + target.id : target?.nodeName || "target";
  const targetId = (target) => {
    if (!targetIds.has(target)) targetIds.set(target, nextTargetId++);
    return targetIds.get(target);
  };
  const listenerId = (listener) => {
    if (!listenerIds.has(listener)) listenerIds.set(listener, nextListenerId++);
    return listenerIds.get(listener);
  };
  const captureOf = (options) => typeof options === "boolean" ? options : options?.capture === true;
  const listenerKey = (target, type, listener, options) => String(targetId(target)) + ":" + String(type) + ":" + String(listenerId(listener)) + ":" + (captureOf(options) ? "1" : "0");
  const percentile = (values, p) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  };
  const sourceLabel = (callback) => {
    const source = sourceOf(callback);
    // setLocalTimeout intentionally wraps the real callback, so the outer
    // function may expose only the overlay ownership signature. Count that
    // scheduled overlay work conservatively as scan/reconcile cost.
    if (/scanTimer|scheduleSettingsScan|scan\(\)/u.test(source) || overlaySource.test(source)) {
      state.scanSignatureMatches += 1;
      return "scan";
    }
    return "other";
  };
  const rememberDuration = (list, value, cap = 10000) => {
    list.push(Number(value.toFixed(4)));
    if (list.length > cap) list.shift();
  };

  if (typeof window.MutationObserver === "function") {
    const NativeMutationObserver = window.MutationObserver;
    window.MutationObserver = class P27MutationObserver extends NativeMutationObserver {
      constructor(callback) {
        const callbackSource = sourceOf(callback);
        const overlayOwned = overlaySource.test(callbackSource);
        const overlayKey = overlayOwned ? overlayName(callbackSource) : null;
        super((mutations, observer) => {
          const started = performance.now();
          state.callbackCount += 1;
          state.callbackMutationRecords += mutations.length;
          try { return callback(mutations, observer); }
          finally {
            const duration = performance.now() - started;
            rememberDuration(state.callbackDurations, duration);
            state.callbackTotalMs += duration;
            if (overlayOwned && duration >= 0) {
              rememberDuration(state.overlayCallbackDurations, duration);
              state.overlayCallbackTotalMs += duration;
            }
          }
        });
        state.observerConstructed += 1;
        state.activeObservers.delete(this);
        if (overlayOwned) {
          state.overlayObserverConstructed += 1;
          state.overlayObserverConstructedByOverlay[overlayKey] = (state.overlayObserverConstructedByOverlay[overlayKey] || 0) + 1;
          this.__p27OverlayOwned = true;
          this.__p27OverlayKey = overlayKey;
        }
      }
      observe(...args) {
        state.activeObservers.add(this);
        if (this.__p27OverlayOwned) {
          state.observerObserveCalls += 1;
          if (!state.activeOverlayObservers.has(this.__p27OverlayKey)) state.activeOverlayObservers.set(this.__p27OverlayKey, new Set());
          state.activeOverlayObservers.get(this.__p27OverlayKey).add(this);
        }
        return super.observe(...args);
      }
      disconnect(...args) {
        state.observerDisconnects += 1;
        state.activeObservers.delete(this);
        if (this.__p27OverlayOwned) state.activeOverlayObservers.get(this.__p27OverlayKey)?.delete(this);
        return super.disconnect(...args);
      }
    };
  }

  window.setTimeout = (callback, delay, ...args) => {
    const label = typeof callback === "function" ? sourceLabel(callback) : "other";
    let id;
    const wrapped = function p27Timer(...innerArgs) {
      state.timerFired += 1;
      state.activeTimers.delete(id);
      const started = performance.now();
      const recordScan = () => {
        const duration = performance.now() - started;
        state.scanCallbacks += 1;
        rememberDuration(state.scanDurations, duration);
        state.scanTotalMs += duration;
      };
      try {
        const result = typeof callback === "function" ? callback.apply(this, innerArgs) : undefined;
        if (label === "scan" && result && typeof result.then === "function") {
          Promise.resolve(result).finally(recordScan);
        } else if (label === "scan") recordScan();
        return result;
      } catch (error) {
        if (label === "scan") recordScan();
        throw error;
      }
    };
    id = nativeSetTimeout(wrapped, delay, ...args);
    state.timerCreated += 1;
    state.activeTimers.set(id, { overlay: overlaySource.test(sourceOf(callback)), label });
    return id;
  };
  window.clearTimeout = (id) => {
    if (state.activeTimers.delete(id)) state.timerCleared += 1;
    return nativeClearTimeout(id);
  };
  if (nativeRaf) {
    window.requestAnimationFrame = (callback) => {
      let id;
      id = nativeRaf((timestamp) => {
        state.rafFired += 1;
        state.activeRafs.delete(id);
        return callback(timestamp);
      });
      state.rafCreated += 1;
      state.activeRafs.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (state.activeRafs.delete(id)) state.rafCancelled += 1;
      return nativeCancelRaf?.(id);
    };
  }
  EventTarget.prototype.addEventListener = function p27Add(type, listener, options) {
    if (listener != null) {
      const key = listenerKey(this, type, listener, options);
      if (!state.listenerNet.has(key)) {
        state.listenerNet.set(key, { target: targetOf(this), type: String(type), overlay: overlaySource.test(sourceOf(listener)), once: options?.once === true });
        state.listenerAdds += 1;
        if (state.listenerNet.get(key).overlay) state.overlayListenerAdds += 1;
      }
    }
    return nativeAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function p27Remove(type, listener, options) {
    if (listener != null) {
      const key = listenerKey(this, type, listener, options);
      const entry = state.listenerNet.get(key);
      if (entry) {
        state.listenerNet.delete(key);
        state.listenerRemoves += 1;
        if (entry.overlay) state.overlayListenerRemoves += 1;
      }
    }
    return nativeRemove.call(this, type, listener, options);
  };
  try {
    const observer = new PerformanceObserver((list) => {
      state.longTaskMeasured = true;
      for (const entry of list.getEntries()) {
        if (entry.startTime < state.measurementStartedAt || entry.duration < 50) continue;
        state.longTaskCount += 1;
        state.longTaskTotalMs += entry.duration;
        state.longTaskMaxMs = Math.max(state.longTaskMaxMs, entry.duration);
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    state.longTaskMeasured = false;
  }
  let nextLagAt = performance.now() + 50;
  const sampleLag = () => {
    if (!state.samplerActive) return;
    const now = performance.now();
    state.lagMeasured = true;
    state.lagSamples.push(Math.max(0, now - nextLagAt));
    if (state.lagSamples.length > 10000) state.lagSamples.shift();
    nextLagAt = now + 50;
    nativeSetTimeout(sampleLag, 50);
  };
  nativeSetTimeout(sampleLag, 50);
  window.__openbotP27 = {
    begin(label) { state.phases[label] = { startedAt: performance.now() }; },
    end(label) { if (state.phases[label]) state.phases[label].endedAt = performance.now(); },
    stop() { state.samplerActive = false; },
    resetMeasurement() {
      state.measurementStartedAt = performance.now();
      state.callbackDurations.length = 0;
      state.overlayCallbackDurations.length = 0;
      state.callbackTotalMs = 0;
      state.overlayCallbackTotalMs = 0;
      state.scanSignatureMatches = 0;
      state.scanCallbacks = 0;
      state.scanDurations.length = 0;
      state.scanTotalMs = 0;
      state.scanQuerySelectorAllCalls = 0;
      state.scanQuerySelectorAllMs = 0;
      state.longTaskCount = 0;
      state.longTaskTotalMs = 0;
      state.longTaskMaxMs = 0;
      state.lagSamples.length = 0;
      state.lagMeasured = false;
      nextLagAt = performance.now() + 50;
      return state.measurementStartedAt;
    },
    snapshot() {
      const callbackDurations = [...state.overlayCallbackDurations];
      const scanDurations = [...state.scanDurations];
      const lagSamples = [...state.lagSamples];
      return {
        version: state.version,
        observer: {
          measured: typeof window.MutationObserver === "function",
          instances: state.activeObservers.size,
          constructed: state.observerConstructed,
          overlayInstances: Math.max(0, ...[...state.activeOverlayObservers.values()].map((items) => items.size)),
          overlayInstancesByOverlay: Object.fromEntries([...state.activeOverlayObservers.entries()].map(([key, items]) => [key, items.size])),
          overlayConstructed: state.overlayObserverConstructed,
          overlayConstructedByOverlay: { ...state.overlayObserverConstructedByOverlay },
          observeCalls: state.observerObserveCalls,
          disconnects: state.observerDisconnects,
          overlayActive: [...state.activeOverlayObservers.values()].reduce((sum, items) => sum + items.size, 0),
          callbackCount: state.callbackCount,
          mutationRecords: state.callbackMutationRecords,
          callbackP95Ms: percentile(callbackDurations, 0.95),
          callbackMaxMs: callbackDurations.length ? Math.max(...callbackDurations) : null,
          callbackTotalMs: Number(state.overlayCallbackTotalMs.toFixed(4)),
          callbackDurationsMeasured: callbackDurations.length > 0,
        },
        scans: {
          measured: state.scanSignatureMatches > 0,
          signatureMatches: state.scanSignatureMatches,
          callbacks: state.scanCallbacks,
          p95Ms: percentile(scanDurations, 0.95),
          maxMs: scanDurations.length ? Math.max(...scanDurations) : null,
          totalMs: Number(state.scanTotalMs.toFixed(4)),
          querySelectorAllCalls: state.scanQuerySelectorAllCalls,
          querySelectorAllMs: Number(state.scanQuerySelectorAllMs.toFixed(4)),
        },
        timers: { measured: true, created: state.timerCreated, fired: state.timerFired, cleared: state.timerCleared, active: state.activeTimers.size, activeOverlay: [...state.activeTimers.values()].filter((entry) => entry.overlay).length },
        raf: { measured: Boolean(nativeRaf), created: state.rafCreated, fired: state.rafFired, cancelled: state.rafCancelled, active: state.activeRafs.size },
        listeners: { measured: true, adds: state.listenerAdds, removes: state.listenerRemoves, active: state.listenerNet.size, overlayAdds: state.overlayListenerAdds, overlayRemoves: state.overlayListenerRemoves },
        longTasks: { measured: state.longTaskMeasured, count: state.longTaskCount, totalMs: Number(state.longTaskTotalMs.toFixed(4)), maxMs: state.longTaskMaxMs || null },
        eventLoopLag: { measured: state.lagMeasured && lagSamples.length > 0, samples: lagSamples.length, p95Ms: percentile(lagSamples, 0.95), maxMs: lagSamples.length ? Math.max(...lagSamples) : null },
        marks: performance.getEntriesByType("mark").map((entry) => ({ name: entry.name, startTime: Number(entry.startTime.toFixed(4)) })),
        phases: JSON.parse(JSON.stringify(state.phases)),
      };
    },
  };
})();`;

function sleep(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

function cleanEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of ["VITEST", "VITEST_WORKER_ID", "VITEST_POOL_ID", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "OPENBOT_DATA_ROOT", "OPENBOT_LOCAL_GATEWAY", "SAND_HOST_GATEWAY_URL", "SAND_HOST_GATEWAY_TOKEN", "SAND_DEV_BOX_CONTROL_PLANE", "GATEWAY_TOKEN"]) delete env[key];
  return { ...env, ...extra };
}

function spawnExit(child) {
  return new Promise((resolvePromise) => child.once("close", (code, signal) => resolvePromise({ code, signal }))); 
}

async function killTree(child) {
  if (!child?.pid) return true;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  if (process.platform === "win32") {
    try { await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch {}
  } else if (!child.killed) {
    try { child.kill("SIGTERM"); } catch {}
  }
  await Promise.race([spawnExit(child), sleep(5000)]);
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForFile(path, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
    if (child?.exitCode !== null) throw new Error(`child exited before ${path}`);
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${path}`);
}

async function waitForTextFile(path, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    if (child?.exitCode !== null) throw new Error(`child exited before ${path}`);
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${path}`);
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(`${url}/health`); if (response.ok && (await response.json()).ok === true) return true; } catch {}
    await sleep(100);
  }
  throw new Error(`gateway health timeout: ${url}`);
}

async function portReleased(port) {
  const server = createServer();
  try {
    await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolvePromise); });
    return true;
  } catch { return false; }
  finally { await new Promise((resolvePromise) => server.close(() => resolvePromise())); }
}

function connectCdp(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolvePromise, reject) => { ws.addEventListener("open", resolvePromise, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result || {});
  });
  ws.addEventListener("close", () => { for (const item of pending.values()) item.reject(new Error("CDP closed")); pending.clear(); });
  const send = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolvePromise, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, ready, send };
}

async function waitForTarget(cdpPort, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited with ${child.exitCode}`);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const page = targets.find((target) => target.type === "page" && target.title === "OpenBot") || targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(100);
  }
  throw new Error("CDP page timeout");
}

async function rpc(baseUrl, token, method, body) {
  const response = await fetch(`${baseUrl}/api/${method}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok || value?.ok === false) throw new Error(`${method} failed`);
  return value?.value ?? value;
}

async function waitUntil(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return true; await sleep(100); }
  throw new Error(`${label} timeout`);
}

async function cdpMetrics(send) {
  const performanceMetrics = await send("Performance.getMetrics").catch(() => null);
  const memory = await send("Memory.getDOMCounters").catch(() => null);
  const map = new Map((performanceMetrics?.metrics || []).map((entry) => [entry.name, entry.value]));
  return {
    measured: map.size > 0 || memory !== null,
    taskDuration: map.get("TaskDuration") ?? null,
    scriptDuration: map.get("ScriptDuration") ?? null,
    layoutDuration: map.get("LayoutDuration") ?? null,
    jsHeapUsedSize: map.get("JSHeapUsedSize") ?? null,
    jsHeapTotalSize: map.get("JSHeapTotalSize") ?? null,
    nodes: map.get("Nodes") ?? memory?.nodes ?? null,
    documents: map.get("Documents") ?? memory?.documents ?? null,
    jsEventListeners: map.get("JSEventListeners") ?? memory?.jsEventListeners ?? null,
  };
}

function percentile(values, p) {
  const valid = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return valid.length ? valid[Math.min(valid.length - 1, Math.floor((valid.length - 1) * p))] : null;
}

function evaluateEvidence(runs) {
  const snapshots = runs.flatMap((run) => run.snapshots || []);
  const latest = snapshots.at(-1);
  const observerSamples = snapshots.map((item) => item.overlay?.observer).filter(Boolean);
  const observer = observerSamples[0];
  const activeOverlayInstances = Math.max(0, ...observerSamples.map((item) => item.overlayInstances || 0));
  const callbackP95 = percentile(snapshots.map((item) => item.overlay?.observer?.callbackP95Ms), 0.95);
  const callbackMax = Math.max(0, ...snapshots.map((item) => item.overlay?.observer?.callbackMaxMs || 0));
  const callbackShare = snapshots.reduce((sum, item) => sum + (item.overlay?.observer?.callbackTotalMs || 0), 0) / Math.max(1, snapshots.reduce((sum, item) => sum + (item.wallMs || 0), 0));
  const scanSamples = snapshots.filter((item) => item.overlay?.scans?.measured);
  const scanP95 = percentile(scanSamples.map((item) => item.overlay.scans.p95Ms), 0.95);
  const scanMax = Math.max(0, ...scanSamples.map((item) => item.overlay.scans.maxMs || 0));
  const lagSamples = snapshots.filter((item) => item.overlay?.eventLoopLag?.measured);
  const lagP95 = percentile(lagSamples.map((item) => item.overlay.eventLoopLag.p95Ms), 0.95);
  const lagMax = Math.max(0, ...lagSamples.map((item) => item.overlay.eventLoopLag.maxMs || 0));
  const longTaskSamples = snapshots.filter((item) => item.overlay?.longTasks?.measured);
  const longTaskCount = Math.max(0, ...longTaskSamples.map((item) => item.overlay.longTasks.count || 0));
  const idleSnapshots = snapshots.filter((item) => item.label === "idle");
  const cpuSamples = idleSnapshots.map((item) => item.cpu?.idlePercent).filter(Number.isFinite);
  const idleCpu = cpuSamples.length ? Math.max(...cpuSamples) : null;
  const heapGrowths = runs.flatMap((run) => {
    const baseline = (run.snapshots || []).find((item) => item.label === "idle-baseline");
    const idle = (run.snapshots || []).find((item) => item.label === "idle");
    return Number.isFinite(baseline?.cdp?.jsHeapUsedSize) && Number.isFinite(idle?.cdp?.jsHeapUsedSize)
      ? [idle.cdp.jsHeapUsedSize - baseline.cdp.jsHeapUsedSize]
      : [];
  });
  const heapGrowth = heapGrowths.length ? Math.max(...heapGrowths) : null;
  const idleScanCallbacks = idleSnapshots.length ? Math.max(...idleSnapshots.map((item) => item.overlay?.scans?.callbacks ?? 0)) : null;
  const idlePairs = runs.flatMap((run) => {
    const baseline = (run.snapshots || []).find((item) => item.label === "idle-baseline");
    const idle = (run.snapshots || []).find((item) => item.label === "idle");
    return baseline && idle ? [{ baseline, idle }] : [];
  });
  const measured = {
    observer: Boolean(observer?.measured && observer.overlayInstances !== undefined),
    callbacks: Boolean(observer?.callbackDurationsMeasured),
    scans: scanSamples.length > 0,
    eventLoopLag: lagSamples.length > 0,
    longTasks: longTaskSamples.length > 0,
    cpu: Number.isFinite(idleCpu),
    memory: heapGrowths.length > 0,
    listeners: snapshots.some((item) => item.overlay?.listeners?.measured),
    timers: snapshots.some((item) => item.overlay?.timers?.measured),
    idleScans: Number.isFinite(idleScanCallbacks),
  };
  const checks = {
    observer: { measured: measured.observer, pass: measured.observer && activeOverlayInstances <= THRESHOLDS.observerInstances, value: activeOverlayInstances, threshold: `<=${THRESHOLDS.observerInstances} active per overlay` },
    callbacks: { measured: measured.callbacks, pass: measured.callbacks && callbackP95 <= THRESHOLDS.callbackP95Ms && callbackMax < THRESHOLDS.callbackMaxMs && callbackShare < THRESHOLDS.callbackShare, value: { p95Ms: callbackP95, maxMs: callbackMax, share: callbackShare }, threshold: { p95Ms: THRESHOLDS.callbackP95Ms, maxMs: THRESHOLDS.callbackMaxMs, share: THRESHOLDS.callbackShare } },
    scans: { measured: measured.scans, pass: measured.scans && scanP95 <= THRESHOLDS.scanP95Ms && scanMax < THRESHOLDS.scanMaxMs, value: { p95Ms: scanP95, maxMs: scanMax }, threshold: { p95Ms: THRESHOLDS.scanP95Ms, maxMs: THRESHOLDS.scanMaxMs } },
    longTasks: { measured: measured.longTasks, pass: measured.longTasks && longTaskCount === 0, value: longTaskCount, threshold: 0 },
    eventLoopLag: { measured: measured.eventLoopLag, pass: measured.eventLoopLag && lagP95 <= THRESHOLDS.eventLoopLagP95Ms && lagMax <= THRESHOLDS.eventLoopLagMaxMs, value: { p95Ms: lagP95, maxMs: lagMax }, threshold: { p95Ms: THRESHOLDS.eventLoopLagP95Ms, maxMs: THRESHOLDS.eventLoopLagMaxMs } },
    cpu: { measured: measured.cpu, pass: measured.cpu && idleCpu < THRESHOLDS.idleCpuPercent, value: idleCpu, threshold: THRESHOLDS.idleCpuPercent },
    memory: { measured: measured.memory, pass: measured.memory && heapGrowth <= THRESHOLDS.retainedHeapGrowthBytes, value: heapGrowth, threshold: THRESHOLDS.retainedHeapGrowthBytes },
    listeners: { measured: measured.listeners, pass: measured.listeners && snapshots.at(-1)?.overlay?.listeners?.active <= snapshots[0]?.overlay?.listeners?.active + 1, value: snapshots.at(-1)?.overlay?.listeners?.active ?? null, threshold: "stable after navigation" },
    timers: { measured: measured.timers, pass: measured.timers && (snapshots.at(-1)?.overlay?.timers?.activeOverlay ?? 1) === 0, value: snapshots.at(-1)?.overlay?.timers?.activeOverlay ?? null, threshold: 0 },
    idleScans: { measured: measured.idleScans, pass: measured.idleScans && idleScanCallbacks <= THRESHOLDS.idleScanCallbacks, value: idleScanCallbacks, threshold: THRESHOLDS.idleScanCallbacks },
  };
  if (idlePairs.length > 0) {
    const listenerGrowth = Math.max(...idlePairs.map(({ baseline, idle }) => (idle.overlay?.listeners?.active ?? 0) - (baseline.overlay?.listeners?.active ?? 0)));
    checks.listeners = { measured: true, pass: listenerGrowth <= 1, value: listenerGrowth, threshold: "<=1 during stabilized idle" };
    const activeOverlayTimers = Math.max(...idlePairs.map(({ idle }) => idle.overlay?.timers?.activeOverlay ?? 1));
    checks.timers = { measured: true, pass: activeOverlayTimers === 0, value: activeOverlayTimers, threshold: 0 };
  }
  const values = Object.values(checks);
  const status = values.some((check) => check.measured && !check.pass) ? "RED" : values.every((check) => check.measured && check.pass) ? "GREEN" : "INCOMPLETE";
  return { status, measured, checks, summary: { runs: runs.length, snapshots: snapshots.length, callbackP95, callbackMax, callbackShare, scanP95, scanMax, idleScanCallbacks, longTaskCount, lagP95, lagMax, idleCpu, heapGrowth } };
}

async function profileRun(runIndex, context) {
  const { send, evalExpr, shot, gatewayUrl, token } = context;
  await send("Page.reload", { ignoreCache: false });
  await waitUntil(async () => await evalExpr("document.readyState === 'complete' && Boolean(window.__openbotP27)") === true, 15000, "instrumented renderer ready");
  await sleep(1000);
  await evalExpr("window.__openbotP27.begin('boot')");
  await evalExpr("document.getElementById('openbot-welcome-continue')?.click(); true").catch(() => undefined);
  await sleep(1000);
  await evalExpr("window.__openbotP27.resetMeasurement()");
  // Trigger one representative observed DOM mutation inside the measured
  // window so callback/scan cost is measured instead of inferred from boot.
  await evalExpr(`(() => {
    const probe = document.createElement("div");
    probe.setAttribute("data-openbot-p27-probe", "1");
    document.body.appendChild(probe);
    probe.remove();
    return true;
  })()`);
  await sleep(300);
  const snapshots = [];
  const capture = async (label) => {
    await sleep(500);
    await send("HeapProfiler.collectGarbage").catch(() => undefined);
    const overlay = await evalExpr("window.__openbotP27.snapshot()");
    const cdp = await cdpMetrics(send);
    const wallMs = await evalExpr("performance.now()");
    const documentTimeOrigin = await evalExpr("performance.timeOrigin");
    const previous = snapshots.at(-1);
    const sameDocument = previous?.documentTimeOrigin === documentTimeOrigin;
    const cpuDelta = sameDocument && previous?.cdp?.taskDuration !== null && previous?.cdp?.taskDuration !== undefined && cdp.taskDuration !== null && cdp.taskDuration !== undefined
      ? cdp.taskDuration - previous.cdp.taskDuration
      : null;
    const wallDeltaSeconds = sameDocument && previous ? Math.max(0.001, (wallMs - previous.wallMs) / 1000) : null;
    snapshots.push({ label, documentTimeOrigin, wallMs, overlay, cdp, cpu: { measured: Number.isFinite(cpuDelta) && wallDeltaSeconds !== null, idlePercent: Number.isFinite(cpuDelta) && wallDeltaSeconds !== null ? (cpuDelta / wallDeltaSeconds) * 100 : null } });
    return snapshots.at(-1);
  };
  await capture("ready");
  await sleep(2000);
  await capture("idle-baseline");
  await evalExpr("window.__openbotP27.resetMeasurement()");
  await sleep(2500);
  await capture("idle");
  const fullNonce = `p27-full-${runIndex}`;
  await rpc(gatewayUrl, token, "sendPrompt", { agentId: "openbot-default", prompt: "p27 deterministic stream", clientNonce: fullNonce });
  await waitUntil(async () => (await rpc(gatewayUrl, token, "getPromptStatus", { agentId: "openbot-default" })).isBusy !== true, 30000, "full stream drain");
  await shot(`run-${runIndex}-stream`);
  await capture("stream");
  const cancelNonce = `p27-cancel-${runIndex}`;
  await rpc(gatewayUrl, token, "sendPrompt", { agentId: "openbot-default", prompt: "p27 deterministic cancel", clientNonce: cancelNonce });
  await sleep(300);
  await rpc(gatewayUrl, token, "cancelPrompt", { agentId: "openbot-default" }).catch(() => undefined);
  await waitUntil(async () => (await rpc(gatewayUrl, token, "getPromptStatus", { agentId: "openbot-default" })).isBusy !== true, 30000, "cancel drain");
  await shot(`run-${runIndex}-cancel`);
  await capture("cancel");
  for (let navigation = 1; navigation <= 2; navigation += 1) {
    await send("Page.reload", { ignoreCache: false });
    await waitUntil(async () => await evalExpr("document.readyState === 'complete' && Boolean(window.__openbotP27)") === true, 15000, "navigation renderer ready");
    await sleep(1500);
    await evalExpr("window.__openbotP27.resetMeasurement()");
    await capture(`navigation-${navigation}`);
  }
  await evalExpr("window.__openbotP27.stop()");
  return { runIndex, snapshots };
}

async function main() {
  const runsRequested = Math.max(1, Number(process.env.OPENBOT_P27_RUNS || process.argv[2] || 3));
  const runRoot = mkdtempSync(join(tmpdir(), "openbot-p27-"));
  const evidenceRoot = join(repoRoot, "logs");
  mkdirSync(evidenceRoot, { recursive: true });
  const evidenceDir = mkdtempSync(join(evidenceRoot, "electron-p27-profile-"));
  const dataRoot = join(runRoot, "data");
  const userData = join(runRoot, "user-data");
  const appData = join(runRoot, "appdata");
  const localAppData = join(runRoot, "localappdata");
  mkdirSync(dataRoot, { recursive: true }); mkdirSync(userData, { recursive: true }); mkdirSync(appData, { recursive: true }); mkdirSync(localAppData, { recursive: true });
  const readyPath = join(runRoot, "backend-ready.json");
  const backendCode = String.raw`import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, stopServer } from ${JSON.stringify(pathToFileURL(backendEntry).href)};
import { createProviderRegistry } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist", "providers", "router.js")).href)};
const root = process.env.P27_RUN_ROOT;
const registry = createProviderRegistry();
registry.register({ name: "openai", async streamChat(request, emit) {
  const count = Number(process.env.P27_STREAM_DELTAS || 200);
  const delay = Number(process.env.P27_STREAM_DELAY_MS || 10);
  for (let index = 0; index < count; index += 1) {
    if (request.signal?.aborted) { const error = new Error("p27 stream aborted"); error.name = "AbortError"; throw error; }
    emit({ type: "delta", delta: "p27-delta-" + index + " " });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
  }
} });
const handle = await startServer(0, { registry, configPath: join(root, "config.json"), storePath: join(root, "store.db"), keystoreDir: join(root, "keystore"), stateRoot: root, workspacesRoot: join(root, "workspaces"), runtimeRoot: join(root, "runtime"), browserRoot: join(root, "browser"), disableAgentHome: true, sharedIntegrationsEnabled: false });
writeFileSync(process.env.P27_READY_PATH, JSON.stringify({ port: handle.port, token: handle.gatewayToken, pid: process.pid }));
let stopping;
async function stop(signal) { if (stopping) return stopping; stopping = stopServer(handle).finally(() => process.exit(signal ? 0 : 1)); return stopping; }
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));`;
  let backend;
  let electron;
  let cdp;
  let report;
  try {
    backend = spawn(process.execPath, ["--input-type=module", "-e", backendCode], { cwd: repoRoot, detached: true, windowsHide: true, env: cleanEnvironment({ NODE_ENV: "test", OPENBOT_DATA_ROOT: dataRoot, P27_RUN_ROOT: runRoot, P27_READY_PATH: readyPath, P27_STREAM_DELTAS: "200", P27_STREAM_DELAY_MS: "10" }), stdio: ["ignore", "pipe", "pipe"] });
    backend.stdout?.on("data", (chunk) => appendFileSync(join(evidenceDir, "backend.stdout.log"), chunk));
    backend.stderr?.on("data", (chunk) => appendFileSync(join(evidenceDir, "backend.stderr.log"), chunk));
    const backendExited = spawnExit(backend);
    const backendReady = await waitForFile(readyPath, backend, 30000);
    const gatewayUrl = `http://127.0.0.1:${backendReady.port}`;
    await waitForHealth(gatewayUrl, 10000);
    // The isolated backend starts with no roster. Seed one agent against the
    // deterministic in-process adapter before Electron boots so the packaged
    // renderer has a real active bot and sendPrompt exercises streaming.
    await rpc(gatewayUrl, backendReady.token, "setActiveProvider", { provider: "openai" });
    await rpc(gatewayUrl, backendReady.token, "createAgent", { id: "openbot-default", name: "P27 Profiler" });
    await rpc(gatewayUrl, backendReady.token, "openAgent", { agentId: "openbot-default" });
    const devToolsPath = join(userData, "DevToolsActivePort");
    electron = spawn(electronExecutable, [`--user-data-dir=${userData}`, "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", electronMain], { cwd: repoRoot, windowsHide: true, env: cleanEnvironment({ APPDATA: appData, LOCALAPPDATA: localAppData, OPENBOT_USER_DATA: userData, OPENBOT_DATA_ROOT: dataRoot, OPENBOT_LOCAL_GATEWAY: "1", OPENBOT_VISUAL_TEST: "1", SAND_HOST_GATEWAY_URL: gatewayUrl, SAND_HOST_GATEWAY_TOKEN: backendReady.token, SAND_DEV_BOX_CONTROL_PLANE: "0", GATEWAY_TOKEN: backendReady.token }), stdio: ["ignore", "pipe", "pipe"] });
    electron.stdout?.on("data", (chunk) => appendFileSync(join(evidenceDir, "electron.stdout.log"), chunk));
    electron.stderr?.on("data", (chunk) => appendFileSync(join(evidenceDir, "electron.stderr.log"), chunk));
    const electronExited = spawnExit(electron);
    const devTools = await waitForTextFile(devToolsPath, electron, 30000);
    const cdpPort = Number(String(devTools).split(/\r?\n/u)[0]);
    if (!Number.isInteger(cdpPort) || cdpPort <= 0) throw new Error("Electron CDP port invalid");
    const target = await waitForTarget(cdpPort, electron, 30000);
    cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    const { send } = cdp;
    await send("Runtime.enable"); await send("Page.enable");
    const evalExpr = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "renderer evaluation failed");
      return result.result?.value;
    };
    await waitUntil(async () => await evalExpr("document.readyState === 'complete'") === true, 15000, "initial renderer ready");
    await sleep(750);
    await send("Performance.enable"); await send("Memory.enable").catch(() => undefined); await send("HeapProfiler.enable").catch(() => undefined);
    await send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENTATION_SOURCE });
    const shot = async (name) => { const image = await send("Page.captureScreenshot", { format: "png" }); const path = join(evidenceDir, `${name}.png`); writeFileSync(path, Buffer.from(image.data, "base64")); return path; };
    const runs = [];
    for (let index = 1; index <= runsRequested; index += 1) runs.push(await profileRun(index, { send, evalExpr, shot, gatewayUrl, token: backendReady.token }));
    report = { status: "PENDING", measured: true, thresholds: THRESHOLDS, runs, evidenceDir, boundary: { proprietaryRendererModified: false, injectedOverlayModified: false }, noPaidProvider: true };
    report.evaluation = evaluateEvidence(runs);
    report.status = report.evaluation.status;
    writeFileSync(join(evidenceDir, "p27-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`P27_RENDERER_REPORT ${JSON.stringify({ status: report.status, evidenceDir, runs: runs.length })}`);
    if (report.status !== "GREEN") process.exitCode = 2;
    await killTree(electron); await killTree(backend);
    await Promise.allSettled([electronExited, backendExited]);
  } catch (error) {
    report = { status: "ERROR", error: error instanceof Error ? error.message : String(error), evidenceDir, boundary: { proprietaryRendererModified: false, injectedOverlayModified: false }, noPaidProvider: true };
    writeFileSync(join(evidenceDir, "p27-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    throw error;
  } finally {
    try { cdp?.ws.close(); } catch {}
    await killTree(electron); await killTree(backend);
    rmSync(runRoot, { recursive: true, force: true });
  }
}

export { INSTRUMENTATION_SOURCE, evaluateEvidence };

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`P27_RENDERER_ERROR ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
