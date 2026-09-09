import { mkdtemp, rm,access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BrowserSessionManager,
  createEgressProxy,
  PUBLIC_READONLY_URLS,
  assertPublicReadonlyCommand,
  assertPublicReadonlyUrl,
  classifyPublicReadonlyFailure,
} from "../dist/browser/index.js";

const COMMAND_TIMEOUT_MS = 6_000;
const READY_TIMEOUT_MS = 8_000;
const CLEANUP_TIMEOUT_MS = 12_000;

const result = {
  gate: "browser-public-readonly",
  status: "RED",
  urls: [...PUBLIC_READONLY_URLS],
  actions: ["open", "navigate", "snapshot", "screenshot"],
  cleanup: {
    leaseReleased: false,
    hostStopped: false,
    proxyClosed: false,
    tempRootRemoved: false,
  },
};

let root;
let manager;
let proxy;
let lease;
let failure;

try {
  root = await mkdtemp(join(tmpdir(), "openbot-browser-public-readonly-"));
  const downloadsRoot = join(root, "downloads");
  const userDataRoot = join(root, "profiles");
  proxy = createEgressProxy({ connectTimeoutMs: 3_000, idleTimeoutMs: 6_000 });
  manager = new BrowserSessionManager({
    downloadsRoot,
    userDataRoot,
    egressProxy: proxy,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
    readyTimeoutMs: READY_TIMEOUT_MS,
    leaseTtlMs: 20_000,
    maxDownloadBytes: 1,
  });
  lease = await manager.acquire("public-readonly", { sessionId: "public-readonly-gate", ttlMs: 20_000 });

  const opened = await run(manager, lease, { command: "open", url: PUBLIC_READONLY_URLS[0] });
  assertPublicReadonlyUrl(opened.url);
  const navigated = await run(manager, lease, { command: "navigate", url: PUBLIC_READONLY_URLS[1] });
  assertPublicReadonlyUrl(navigated.url);
  const snapshot = await run(manager, lease, { command: "snapshot", includeText: true });
  if (!snapshot.snapshot || !snapshot.snapshot.url.startsWith("https://") || !snapshot.snapshot.title) {
    throw new Error("public browser snapshot did not return a loaded HTTPS document");
  }
  assertPublicReadonlyUrl(snapshot.snapshot.url);
  const screenshot = await run(manager, lease, { command: "screenshot", fullPage: false });
  if (screenshot.screenshot?.mimeType !== "image/png") {
    throw new Error("public browser screenshot did not return PNG evidence");
  }
  assertPublicReadonlyUrl(screenshot.url);
  result.status = "GREEN";
} catch (error) {
  failure = error;
  result.status = classifyPublicReadonlyFailure(error);
} finally {
  if (lease !== undefined) {
    try {
      await withTimeout(lease.release(), CLEANUP_TIMEOUT_MS, "browser lease cleanup timed out");
      result.cleanup.leaseReleased = manager?.activeLeaseCount === 0;
    } catch (error) {
      failure ??= error;
      result.status = "RED";
    }
  }
  if (manager !== undefined) {
    try {
      await withTimeout(manager.close(), CLEANUP_TIMEOUT_MS, "browser manager cleanup timed out");
      result.cleanup.leaseReleased ||= manager.activeLeaseCount === 0;
      result.cleanup.hostStopped = !manager.hostRunning;
    } catch (error) {
      failure ??= error;
      result.status = "RED";
    }
  }
  if (manager === undefined) {
    result.cleanup.leaseReleased = true;
    result.cleanup.hostStopped = true;
  }
  result.cleanup.proxyClosed = proxy === undefined || proxy.address === null;
  if (!result.cleanup.leaseReleased || !result.cleanup.hostStopped || !result.cleanup.proxyClosed) {
    result.status = "RED";
  }
  if (root !== undefined && result.cleanup.hostStopped && result.cleanup.proxyClosed) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      await access(root).then(
        () => { throw new Error("public browser temp root still exists after cleanup"); },
        () => undefined,
      );
      result.cleanup.tempRootRemoved = true;
    } catch (error) {
      failure ??= error;
      result.status = "RED";
    }
  } else {
    result.status = "RED";
  }
}

if (failure instanceof Error) result.error = `${failure.name}: ${failure.message.slice(0, 512)}`;
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.status === "GREEN" ? 0 : result.status === "BLOCKED_ENV" ? 2 : 1;

async function run(browserManager, browserLease, command) {
  assertPublicReadonlyCommand(command);
  return withTimeout(browserManager.execute(browserLease, command), COMMAND_TIMEOUT_MS + 2_000, `browser ${command.command} timed out`);
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
