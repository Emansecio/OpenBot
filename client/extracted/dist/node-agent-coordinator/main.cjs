const __mod=require('node:module');const __p=require('node:path');const __depsDir=__p.join(__dirname,'..','deps');process.env.NODE_PATH=__depsDir+(process.env.NODE_PATH?__p.delimiter+process.env.NODE_PATH:'');__mod.Module._initPaths();const __import_meta_url=require('node:url').pathToFileURL(__filename).href;
"use strict";

// src/node-agent-coordinator/main.ts
var import_node_os = require("node:os");
var { createTranscriptAdapter, createTranscriptSnapshotGate, projectTranscriptForRenderer } = require("./openbot-transcript-adapter.cjs");

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
      const timeout = new Promise((_, reject2) => {
        rejectTimeout = reject2;
      });
      let rejectCancellation = () => {
      };
      const cancellation = new Promise((_, reject2) => {
        rejectCancellation = reject2;
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
function createRetryPolicy(clock, options) {
  assertName(options.name);
  assertPositiveInteger(options.maxAttempts, "maxAttempts");
  assertDuration(options.initialDelayMs, "initialDelayMs");
  assertDuration(options.maxDelayMs, "maxDelayMs");
  if (options.maxDelayMs < options.initialDelayMs) {
    throw new RangeError("maxDelayMs must be at least initialDelayMs");
  }
  const backoffFactor = options.backoffFactor ?? 2;
  if (!Number.isFinite(backoffFactor) || backoffFactor < 1) {
    throw new RangeError("backoffFactor must be a finite number at least 1");
  }
  const shouldRetry = options.shouldRetry ?? (() => true);
  const policy = {
    name: options.name,
    schedule(attempt, signal) {
      assertPositiveInteger(attempt, "attempt");
      const growth = Math.min(backoffFactor ** (attempt - 1), Number.MAX_VALUE);
      const delayMs = Math.min(options.maxDelayMs, options.initialDelayMs * growth);
      return createDelay(clock, delayMs, signal);
    },
    async runWithRetry(work, signal) {
      const workSignal = signal ?? new AbortController().signal;
      let rejectCancellation = () => {
      };
      const cancellation = new Promise((_, reject2) => {
        rejectCancellation = reject2;
      });
      let removeAbortListener = () => {
      };
      if (signal != null) {
        const abort = () => rejectCancellation(abortReason(signal));
        signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      try {
        for (let attempt = 1; ; attempt += 1) {
          if (signal?.aborted) throw abortReason(signal);
          try {
            return await Promise.race([work(attempt, workSignal), cancellation]);
          } catch (error) {
            if (signal?.aborted) throw abortReason(signal);
            if (attempt >= options.maxAttempts || !shouldRetry(error, attempt)) {
              throw error;
            }
            const delay = policy.schedule(attempt, signal);
            try {
              await delay.elapsed;
            } finally {
              delay.dispose();
            }
          }
        }
      } finally {
        removeAbortListener();
      }
    }
  };
  return policy;
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
function createIdleWatchdogPolicy(clock, options) {
  assertName(options.name, "name");
  assertDuration(options.idleMs, "idleMs");
  return {
    name: options.name,
    arm(onIdle) {
      let active = true;
      let scheduled;
      const rearm = () => {
        scheduled?.dispose();
        scheduled = clock.schedule(options.idleMs, () => {
          scheduled = void 0;
          onIdle();
        });
      };
      rearm();
      return {
        kick() {
          if (!active) return;
          rearm();
        },
        dispose() {
          if (!active) return;
          active = false;
          scheduled?.dispose();
          scheduled = void 0;
        }
      };
    }
  };
}
function createExpiryPolicy(clock, options) {
  assertName(options.name, "name");
  assertDuration(options.ttlMs, "ttlMs");
  const pending = /* @__PURE__ */ new Map();
  return {
    name: options.name,
    arm(key, onExpire) {
      pending.get(key)?.dispose();
      const scheduled = clock.schedule(options.ttlMs, () => {
        pending.delete(key);
        onExpire();
      });
      pending.set(key, scheduled);
      return {
        dispose() {
          const isCurrentArming = pending.get(key) === scheduled;
          if (!isCurrentArming) return;
          pending.delete(key);
          scheduled.dispose();
        }
      };
    }
  };
}
function createDelay(clock, delayMs, signal) {
  let settled = false;
  let resolveElapsed = () => {
  };
  let rejectElapsed = () => {
  };
  const elapsed = new Promise((resolve, reject2) => {
    resolveElapsed = resolve;
    rejectElapsed = reject2;
  });
  void elapsed.catch(() => {
  });
  let removeAbortListener = () => {
  };
  const scheduled = clock.schedule(delayMs, () => {
    if (settled) return;
    settled = true;
    removeAbortListener();
    resolveElapsed();
  });
  const cancel = (reason) => {
    if (settled) return;
    settled = true;
    scheduled.dispose();
    removeAbortListener();
    rejectElapsed(reason);
  };
  if (signal?.aborted) {
    cancel(abortReason(signal));
  } else if (signal != null) {
    const abort = () => cancel(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
  }
  return {
    elapsed,
    dispose: () => cancel(createAbortError())
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
function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

// dune/src/scheduling.ts
function createDeadlinePolicy2(options) {
  return createDeadlinePolicy(realClock, options);
}
function createRetryPolicy2(options) {
  return createRetryPolicy(realClock, options);
}
function createPollingPolicy2(options) {
  return createPollingPolicy(realClock, options);
}
function createIdleWatchdogPolicy2(options) {
  return createIdleWatchdogPolicy(realClock, options);
}
function createExpiryPolicy2(options) {
  return createExpiryPolicy(realClock, options);
}

// src/shared/webauthn-gateway.ts
var GATEWAY_WEBAUTHN_REQUESTS_PATH = "/webauthn/requests";
var GATEWAY_WEBAUTHN_RESPONSES_PATH = "/webauthn/responses";
var SAND_WEBAUTHN_HEARTBEAT_INTERVAL_MS = 1e4;

// src/node-agent-coordinator/gateway/sse-block-decoder.ts
var LF = 10;
var SseBlockDecoder = class {
  constructor(onBlock) {
    this.onBlock = onBlock;
  }
  onBlock;
  decoder = new TextDecoder();
  parts = [];
  prevEndedWithLf = false;
  push(bytes) {
    const chunk = this.decoder.decode(bytes, { stream: true });
    if (chunk.length === 0) return;
    let start = 0;
    if (this.prevEndedWithLf && chunk.charCodeAt(0) === LF) {
      const joined = this.parts.length === 1 ? this.parts[0] ?? "" : this.parts.join("");
      this.onBlock(joined.slice(0, joined.length - 1));
      this.parts.length = 0;
      start = 1;
    }
    let separator = chunk.indexOf("\n\n", start);
    while (separator >= 0) {
      if (this.parts.length === 0) {
        this.onBlock(chunk.slice(start, separator));
      } else {
        this.parts.push(chunk.slice(start, separator));
        this.onBlock(this.parts.join(""));
        this.parts.length = 0;
      }
      start = separator + 2;
      separator = chunk.indexOf("\n\n", start);
    }
    const tail = start === 0 ? chunk : chunk.slice(start);
    if (tail.length > 0) this.parts.push(tail);
    const last = this.parts.length > 0 ? this.parts[this.parts.length - 1] ?? "" : "";
    this.prevEndedWithLf = last.length > 0 && last.charCodeAt(last.length - 1) === LF;
  }
};

// src/node-agent-coordinator/webauthn/provider.ts
var WebAuthnChannelError = class extends Error {
  name = "WebAuthnChannelError";
};
function createWebAuthnProvider(options) {
  const log = options.log ?? (() => {
  });
  let lifetime;
  let providerId;
  const inFlight = /* @__PURE__ */ new Map();
  function headersFor(connection) {
    return {
      ...connection.headers ?? {},
      ...connection.token === void 0 ? {} : { authorization: `Bearer ${connection.token}` }
    };
  }
  async function postFrames(connection, frames, signal) {
    const batch = providerId === void 0 ? { frames } : { providerId, frames };
    const response = await fetch(`${connection.baseUrl}${GATEWAY_WEBAUTHN_RESPONSES_PATH}`, {
      method: "POST",
      headers: {
        ...headersFor(connection),
        "content-type": "application/json"
      },
      body: JSON.stringify(batch),
      ...signal === void 0 ? {} : { signal }
    });
    if (!response.ok) {
      throw new WebAuthnChannelError(`webauthn response POST rejected: HTTP ${response.status}`);
    }
  }
  async function runCeremony(connection, requestId, ceremony) {
    const attempt = new AbortController();
    inFlight.set(requestId, attempt);
    log(`ceremony ${requestId}: ${ceremony.kind} for ${ceremony.origin}`);
    let failedStageIfThrown = options.consent === void 0 ? { stage: "sign", outcome: "failed" } : { stage: "grant", outcome: "failed" };
    let frames;
    try {
      const consent = await options.consent?.requestConsent(ceremony, attempt.signal);
      if (consent !== void 0 && !consent.approved) {
        await postFrames(connection, [
          { kind: "stage", requestId, stage: "grant", outcome: "declined" },
          {
            kind: "error",
            requestId,
            name: "NotAllowedError",
            message: "The security key request was declined on your computer."
          }
        ]);
        inFlight.delete(requestId);
        return;
      }
      if (consent !== void 0) {
        failedStageIfThrown = { stage: "sign", outcome: "failed" };
        await postFrames(
          connection,
          [{ kind: "stage", requestId, stage: "grant", outcome: "ok" }],
          attempt.signal
        ).catch((error) => log(`grant stage frame failed: ${String(error)}`));
      }
      if (attempt.signal.aborted) {
        return;
      }
      const result = await options.signer.sign(ceremony, attempt.signal, consent);
      if (result.ok) {
        frames = [
          { kind: "stage", requestId, stage: "sign", outcome: "ok" },
          { kind: "result", requestId, credentialJson: result.credentialJson }
        ];
      } else {
        frames = [
          { kind: "stage", requestId, stage: "sign", outcome: "failed" },
          {
            kind: "error",
            requestId,
            name: result.error.name,
            message: result.error.message,
            ...result.error.code === void 0 ? {} : { code: result.error.code }
          }
        ];
      }
    } catch (error) {
      frames = [
        { kind: "stage", requestId, ...failedStageIfThrown },
        {
          kind: "error",
          requestId,
          name: "NotAllowedError",
          message: `the security key could not complete the request: ${error instanceof Error ? error.message : String(error)}`
        }
      ];
    } finally {
      options.consent?.finish();
      inFlight.delete(requestId);
    }
    if (attempt.signal.aborted) {
      return;
    }
    try {
      await (options.deliveryPolicy === void 0 ? postFrames(connection, frames) : options.deliveryPolicy.runWithRetry(
        () => postFrames(connection, frames),
        attempt.signal
      ));
    } catch (error) {
      log(`ceremony ${requestId} result could not be delivered: ${String(error)}`);
    }
  }
  function handleFrame(connection, frame) {
    switch (frame.kind) {
      case "welcome":
        providerId = frame.providerId;
        void postFrames(connection, [
          {
            kind: "hello",
            ...options.computerId === void 0 ? {} : { computerId: options.computerId },
            ...options.label === void 0 ? {} : { label: options.label }
          }
        ]).catch((error) => log(`hello frame failed: ${String(error)}`));
        break;
      case "ceremony":
        void runCeremony(connection, frame.requestId, frame.ceremony);
        break;
      case "cancel":
        inFlight.get(frame.requestId)?.abort();
        inFlight.delete(frame.requestId);
        break;
    }
  }
  async function connectOnce(signal) {
    const connection = await options.resolveConnection();
    const response = await fetch(`${connection.baseUrl}${GATEWAY_WEBAUTHN_REQUESTS_PATH}`, {
      headers: headersFor(connection),
      signal
    });
    if (!response.ok || response.body == null) {
      throw new WebAuthnChannelError(`webauthn request stream refused: HTTP ${response.status}`);
    }
    log("webauthn request stream open");
    providerId = void 0;
    const decoder = new SseBlockDecoder((block) => {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          handleFrame(
            connection,
            JSON.parse(line.slice("data:".length).trim())
          );
        } catch (error) {
          log(`dropped an unparseable request frame: ${String(error)}`);
        }
      }
    });
    const heartbeat = options.heartbeatPolicy.start(async () => {
      try {
        await postFrames(connection, [{ kind: "ping" }]);
      } catch (error) {
        log(`heartbeat failed: ${String(error)}`);
      }
    }, signal);
    try {
      for await (const chunk of response.body) {
        decoder.push(chunk);
      }
    } finally {
      heartbeat.dispose();
      for (const attempt of inFlight.values()) attempt.abort();
      inFlight.clear();
    }
    throw new WebAuthnChannelError("webauthn request stream closed");
  }
  return {
    start() {
      if (lifetime !== void 0) return;
      const controller = new AbortController();
      lifetime = controller;
      void options.reconnectPolicy.runWithRetry(async (_attempt, signal) => {
        await connectOnce(signal);
      }, controller.signal).catch((error) => {
        if (controller.signal.aborted) return;
        log(`webauthn provider gave up: ${String(error)}`);
      });
    },
    stop() {
      lifetime?.abort();
      lifetime = void 0;
    }
  };
}

// src/node-agent-coordinator/webauthn/signer.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var SIGNER_EVENT_PREFIX = "[signer-event] ";
function describeSignerEventAsStatus(event) {
  switch (event.kind) {
    case "presence-required":
      return "Touch your security key now";
    case "select-device":
      return "Touch the security key you want to use";
    case "pin-not-set":
      return "This security key has no PIN set, but the site asked for one";
    case "pin-blocked":
      return "Your security key is locked";
    case "uv-blocked":
      return "Your security key's fingerprint check is locked";
    case "uv-invalid":
      return "That didn't match \u2014 try again on the key";
    case "pin-required":
    case "pin-invalid":
      return void 0;
  }
}
function failure(error) {
  return { ok: false, error };
}
var SIGNER_BINARY = process.platform === "win32" ? "sand-webauthn-signer.exe" : "sand-webauthn-signer";
function devRepoRoot(override) {
  if (override !== void 0) return override;
  return (0, import_node_path.join)(__dirname, "..", "..", "..");
}
function resolveWebAuthnSignerPath(options) {
  const override = process.env.SAND_WEBAUTHN_SIGNER_PATH;
  if (override !== void 0 && override.length > 0) {
    return (0, import_node_fs.existsSync)(override) ? override : void 0;
  }
  const candidates = options.isPackaged ? [
    (0, import_node_path.join)(
      process.resourcesPath ?? "",
      // asarUnpack keeps dist/native out of the archive.
      "app.asar.unpacked",
      "dist",
      "native",
      SIGNER_BINARY
    )
  ] : [
    (0, import_node_path.join)(devRepoRoot(options.repoRoot), "target", "release", SIGNER_BINARY),
    (0, import_node_path.join)(devRepoRoot(options.repoRoot), "target", "debug", SIGNER_BINARY)
  ];
  return candidates.find((candidate) => (0, import_node_fs.existsSync)(candidate));
}
function parseSignerEvent(body, log) {
  try {
    return JSON.parse(body);
  } catch (error) {
    log(`unreadable signer event ${body}: ${String(error)}`);
    return void 0;
  }
}
function createSpawnedWebAuthnSigner(options) {
  const log = options.log ?? (() => {
  });
  return {
    sign(ceremony, signal, approved) {
      return new Promise((resolve) => {
        const child = (0, import_node_child_process.spawn)(options.binaryPath, [], { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        };
        function onAbort() {
          child.kill("SIGTERM");
          settle(
            failure({
              name: "NotAllowedError",
              code: "cancelled_or_timeout",
              message: "the security key request was cancelled"
            })
          );
        }
        signal.addEventListener("abort", onAbort, { once: true });
        child.stdin.on("error", (error) => log(`signer stdin: ${error.message}`));
        const send = (reply) => {
          if (settled || child.stdin.destroyed) return;
          child.stdin.write(`${JSON.stringify(reply)}
`);
        };
        let promptsInOrder = Promise.resolve();
        const promptId = approved?.promptId ?? void 0;
        const answerPin = (request) => {
          promptsInOrder = promptsInOrder.then(async () => {
            const pin = promptId === void 0 ? void 0 : await options.onPinRequest?.(request, promptId);
            send(pin === void 0 || pin === "" ? { kind: "cancel" } : { kind: "pin", pin });
          }).catch((error) => {
            log(`pin prompt failed: ${String(error)}`);
            send({ kind: "cancel" });
          });
        };
        const handleEvent = (event) => {
          if (event.kind === "pin-required") {
            answerPin({ invalid: false });
            return;
          }
          if (event.kind === "pin-invalid") {
            answerPin({
              invalid: true,
              ...event.retries == null ? {} : { retries: event.retries }
            });
            return;
          }
          const status = describeSignerEventAsStatus(event);
          if (status !== void 0) options.onStatus?.(status);
        };
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        let pendingLine = "";
        child.stderr.on("data", (chunk) => {
          const text = String(chunk);
          stderr += text;
          pendingLine += text;
          let newline = pendingLine.indexOf("\n");
          while (newline >= 0) {
            const line = pendingLine.slice(0, newline).trim();
            pendingLine = pendingLine.slice(newline + 1);
            newline = pendingLine.indexOf("\n");
            if (!line.startsWith(SIGNER_EVENT_PREFIX)) continue;
            const event = parseSignerEvent(line.slice(SIGNER_EVENT_PREFIX.length), log);
            if (event === void 0) continue;
            handleEvent(event);
          }
        });
        child.on("error", (error) => {
          settle(
            failure({
              name: "NotAllowedError",
              code: "helper_spawn_failed",
              message: `could not start the security key helper: ${error.message}`
            })
          );
        });
        child.on("close", (code) => {
          if (stderr.length > 0) log(`signer stderr: ${stderr.trim()}`);
          if (stdout.length === 0) {
            settle(
              failure({
                name: "NotAllowedError",
                code: "helper_no_result",
                message: `the security key helper exited with code ${code} and no result`
              })
            );
            return;
          }
          try {
            settle(JSON.parse(stdout));
          } catch (error) {
            settle(
              failure({
                name: "NotAllowedError",
                code: "helper_no_result",
                message: `unreadable result from the security key helper: ${String(error)}`
              })
            );
          }
        });
        const windowHandle = approved?.windowHandle;
        child.stdin.write(
          `${JSON.stringify(windowHandle === void 0 ? ceremony : { ...ceremony, windowHandle })}
`
        );
      });
    }
  };
}

// dune/src/internal/rpc/contract.ts
function declareRpcContract(edge, ...events) {
  return { edge, hasEvents: events.length > 0 };
}

// src/shared/rpc/coordinator-main.ts
var coordinatorMainRpcContract = declareRpcContract("coordinator-main");
var COORDINATOR_MAIN_METHOD_TABLE = {
  uploadAttachment: { args: "object" },
  readAttachmentImage: { args: "object" },
  readAttachmentText: { args: "object" },
  readAttachmentChunk: { args: "object" },
  getHostSettings: { args: "none" },
  setHostSettings: { args: "object" },
  setBoxSecrets: { args: "object" },
  refreshMcp: { args: "object" },
  listBoxMcpServers: { args: "object" },
  updateForeverBox: { args: "object" },
  setWindowFocused: { args: "object" },
  getHostStatus: { args: "none" },
  // DEV-ONLY rows: the agent-data legs behind the control-sand driver's
  // sandDev capability. They exist so the driver's setup capability
  // survives the bridge deletion — main.cts registers the sand:dev-*
  // handlers onto the legs facade only under its unpackaged +
  // SAND_DEV_CAPABILITY dual gate, and preload-sand-dev.cts is their only
  // caller, so packaged builds never expose the callers. Each row is ALSO
  // a renderer-table member (the renderer's own roster/outline/subagent
  // reads are these same gateway methods): the one sanctioned overlap
  // between the two data-port tables, pinned by coordinator-main.test.ts.
  listAgents: { args: "none" },
  createAgent: { args: "object" },
  deleteAgents: { args: "object" },
  getConversationOutline: { args: "object" },
  getSubagents: { args: "object" },
  setDevGatewayOffline: { args: "object" },
  setGatewayPaused: { args: "object" }
};
function isCoordinatorMainMethod(name) {
  return Object.hasOwn(COORDINATOR_MAIN_METHOD_TABLE, name);
}

// src/shared/rpc/coordinator-port.ts
var COORDINATOR_PROTOCOL_VERSION = 1;
var COORDINATOR_UNKNOWN_METHOD = "unknown-method";
var COORDINATOR_CANCELLED = "cancelled";
function reject(detail) {
  return { accepted: false, rejection: { code: "malformed-frame", detail } };
}
function accept(frame) {
  return { accepted: true, frame };
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function parseCoordinatorFrame(value) {
  if (!isRecord(value)) return reject("frame must be an object");
  switch (value.kind) {
    case "lifecycle":
      return parseLifecycle(value);
    case "request": {
      if (!isNonEmptyString(value.requestId)) {
        return reject("request.requestId must be a non-empty string");
      }
      if (!isNonEmptyString(value.method)) {
        return reject("request.method must be a non-empty string");
      }
      if (!("args" in value)) return reject("request.args is missing");
      return accept({
        kind: "request",
        requestId: value.requestId,
        method: value.method,
        args: value.args
      });
    }
    case "cancel": {
      if (!isNonEmptyString(value.requestId)) {
        return reject("cancel.requestId must be a non-empty string");
      }
      return accept({ kind: "cancel", requestId: value.requestId });
    }
    case "reply": {
      if (!isNonEmptyString(value.requestId)) {
        return reject("reply.requestId must be a non-empty string");
      }
      const outcome = parseReplyOutcome(value.outcome);
      if (outcome == null) return reject("reply.outcome is not a valid outcome");
      return accept({ kind: "reply", requestId: value.requestId, outcome });
    }
    case "event": {
      if (!isNonEmptyString(value.family)) {
        return reject("event.family must be a non-empty string");
      }
      if (!("payload" in value)) return reject("event.payload is missing");
      return accept({ kind: "event", family: value.family, payload: value.payload });
    }
    default:
      return reject("frame.kind must be lifecycle, request, cancel, reply, or event");
  }
}
function parseLifecycle(value) {
  switch (value.phase) {
    case "hello":
    case "ready": {
      if (typeof value.protocolVersion !== "number") {
        return reject(`lifecycle.${value.phase}.protocolVersion must be a number`);
      }
      return accept({
        kind: "lifecycle",
        phase: value.phase,
        protocolVersion: value.protocolVersion
      });
    }
    case "shutdown": {
      if (value.reason !== "requested" && value.reason !== "protocol-error") {
        return reject("lifecycle.shutdown.reason must be requested or protocol-error");
      }
      if (value.reason === "protocol-error") {
        if (typeof value.detail !== "string" || value.detail.length === 0) {
          return reject(
            "lifecycle.shutdown.detail must name the breach for a protocol-error shutdown"
          );
        }
      } else if (value.detail !== null) {
        return reject("lifecycle.shutdown.detail must be null for a requested shutdown");
      }
      return accept({
        kind: "lifecycle",
        phase: "shutdown",
        reason: value.reason,
        detail: value.detail
      });
    }
    default:
      return reject("lifecycle.phase must be hello, ready, or shutdown");
  }
}
function parseReplyOutcome(value) {
  if (!isRecord(value)) return null;
  if (value.status === "ok") {
    if (!("value" in value)) return null;
    return { status: "ok", value: value.value };
  }
  if (value.status === "failed") {
    if (!isRecord(value.failure)) return null;
    const { code, message, transportKind } = value.failure;
    if (!isNonEmptyString(code) || typeof message !== "string") return null;
    return {
      status: "failed",
      failure: {
        code,
        message,
        ...isNonEmptyString(transportKind) ? { transportKind } : {}
      }
    };
  }
  return null;
}
function parseCoordinatorBootstrap(value) {
  if (!isRecord(value) || !isRecord(value.processConfig)) {
    return {
      accepted: false,
      rejection: { code: "malformed-frame", detail: "bootstrap.processConfig must be an object" }
    };
  }
  const rejectField = (detail) => ({
    accepted: false,
    rejection: { code: "malformed-frame", detail }
  });
  const { appVersion, isPackaged, dataDir } = value.processConfig;
  if (!isNonEmptyString(appVersion)) {
    return rejectField("bootstrap.processConfig.appVersion must be a non-empty string");
  }
  if (typeof isPackaged !== "boolean") {
    return rejectField("bootstrap.processConfig.isPackaged must be a boolean");
  }
  if (!isNonEmptyString(dataDir)) {
    return rejectField("bootstrap.processConfig.dataDir must be a non-empty string");
  }
  return {
    accepted: true,
    bootstrap: { processConfig: { appVersion, isPackaged, dataDir } }
  };
}
var COORDINATOR_TRANSPORT_STATE_FAMILY = "coordinator-transport-state";
var COORDINATOR_CONTROL_CHANNEL = "coordinator-control";
function asCoordinatorControlEnvelope(value) {
  if (!isRecord(value) || value.channel !== COORDINATOR_CONTROL_CHANNEL) return null;
  if (!("frame" in value)) return null;
  return { channel: COORDINATOR_CONTROL_CHANNEL, frame: value.frame };
}
var COORDINATOR_MAIN_DATA_CHANNEL = "coordinator-main-data";
function asCoordinatorMainDataEnvelope(value) {
  if (!isRecord(value) || value.channel !== COORDINATOR_MAIN_DATA_CHANNEL) return null;
  if (!("frame" in value)) return null;
  return { channel: COORDINATOR_MAIN_DATA_CHANNEL, frame: value.frame };
}

// src/shared/send-acceptance.ts
var HOST_ACCOUNT_SLOT = "host";

// src/node-agent-coordinator/carrier.ts
var BOOTSTRAP_FLAG = "--bootstrap=";
function isPortLike(value) {
  if (typeof value !== "object" || value == null) return false;
  const candidate = value;
  return typeof candidate.postMessage === "function" && typeof candidate.on === "function";
}
function adoptForkIpc(argv) {
  const argument = argv.find((value) => value.startsWith(BOOTSTRAP_FLAG));
  if (argument == null) {
    return { adopted: false, rejection: { detail: "missing --bootstrap argument" } };
  }
  let parsed;
  try {
    parsed = JSON.parse(argument.slice(BOOTSTRAP_FLAG.length));
  } catch {
    return { adopted: false, rejection: { detail: "--bootstrap is not valid JSON" } };
  }
  const intake = parseCoordinatorBootstrap(parsed);
  if (!intake.accepted) {
    return { adopted: false, rejection: { detail: intake.rejection.detail } };
  }
  const send = process.send?.bind(process);
  if (send == null) {
    return {
      adopted: false,
      rejection: { detail: "no renderer data channel was transferred" }
    };
  }
  let channelClosed = false;
  const closeChannel = () => {
    if (channelClosed) return;
    channelClosed = true;
    if (process.connected) process.disconnect();
  };
  const post = (value) => {
    try {
      send(value, () => {
      });
    } catch {
    }
  };
  let bound = false;
  return {
    adopted: true,
    carrier: {
      kind: "fork-ipc",
      bootstrap: intake.bootstrap,
      control: {
        post: (frame) => post({ channel: COORDINATOR_CONTROL_CHANNEL, frame }),
        close: closeChannel
      },
      data: { post, close: closeChannel },
      mainData: {
        post: (frame) => post({ channel: COORDINATOR_MAIN_DATA_CHANNEL, frame }),
        close: closeChannel
      },
      exitProcess(exitCode) {
        process.exitCode = exitCode;
      },
      bind(intakeHandlers) {
        if (bound) return;
        bound = true;
        process.on("message", (value) => {
          const controlEnvelope = asCoordinatorControlEnvelope(value);
          if (controlEnvelope != null) {
            intakeHandlers.onControlFrame(controlEnvelope.frame);
            return;
          }
          const mainDataEnvelope = asCoordinatorMainDataEnvelope(value);
          if (mainDataEnvelope != null) {
            intakeHandlers.onMainDataFrame(mainDataEnvelope.frame);
            return;
          }
          intakeHandlers.onDataFrame(value);
        });
        process.on("disconnect", () => {
          channelClosed = true;
          intakeHandlers.onClosed();
        });
      }
    }
  };
}
function adoptParentPort(parentPort, handoff) {
  void parentPort;
  const body = handoff.data;
  const intake = parseCoordinatorBootstrap(
    typeof body === "object" && body != null && "bootstrap" in body ? body.bootstrap : null
  );
  if (!intake.accepted) {
    return { adopted: false, rejection: { detail: intake.rejection.detail } };
  }
  const [controlPort, dataPort, mainDataPort] = handoff.ports;
  if (!isPortLike(controlPort) || !isPortLike(dataPort) || !isPortLike(mainDataPort)) {
    return {
      adopted: false,
      rejection: { detail: "parent handoff did not transfer three message ports" }
    };
  }
  const closed = { control: false, data: false, mainData: false };
  const closePort = (port, key) => {
    if (closed[key]) return;
    closed[key] = true;
    port.close?.();
  };
  const postTo = (port, key, value) => {
    if (closed[key]) return;
    try {
      port.postMessage(value);
    } catch {
    }
  };
  let bound = false;
  return {
    adopted: true,
    carrier: {
      kind: "parent-port",
      bootstrap: intake.bootstrap,
      control: {
        post: (frame) => postTo(controlPort, "control", frame),
        close: () => closePort(controlPort, "control")
      },
      data: {
        post: (value) => postTo(dataPort, "data", value),
        close: () => closePort(dataPort, "data")
      },
      mainData: {
        post: (value) => postTo(mainDataPort, "mainData", value),
        close: () => closePort(mainDataPort, "mainData")
      },
      exitProcess(exitCode) {
        process.exitCode = exitCode;
        process.exit(exitCode);
      },
      bind(intakeHandlers) {
        if (bound) return;
        bound = true;
        controlPort.on("message", (event) => intakeHandlers.onControlFrame(event.data));
        controlPort.on("close", () => {
          closed.control = true;
          intakeHandlers.onClosed();
        });
        dataPort.on("message", (event) => intakeHandlers.onDataFrame(event.data));
        dataPort.on("close", () => {
          closed.data = true;
          intakeHandlers.onClosed();
        });
        mainDataPort.on("message", (event) => intakeHandlers.onMainDataFrame(event.data));
        mainDataPort.on("close", () => {
          closed.mainData = true;
          intakeHandlers.onClosed();
        });
        controlPort.start?.();
        dataPort.start?.();
        mainDataPort.start?.();
      }
    }
  };
}
function adoptCarrier() {
  const parentPort = process.parentPort;
  if (parentPort != null && isPortLike(parentPort)) {
    return new Promise((resolve) => {
      parentPort.on("message", (event) => {
        resolve(
          adoptParentPort(parentPort, {
            data: event.data,
            ports: event.ports ?? []
          })
        );
      });
      parentPort.start?.();
    });
  }
  return Promise.resolve(adoptForkIpc(process.argv));
}

// src/node-agent-coordinator/control-port-client.ts
var ControlPortCallError = class extends Error {
  code;
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ControlPortCallError";
    this.code = code;
  }
};
function createControlPortClient(endpoint) {
  let phase = "serving";
  let readyObserved = false;
  let nextRequestId = 0;
  const pending = /* @__PURE__ */ new Map();
  const { promise: settled, resolve: resolveSettled } = Promise.withResolvers();
  const settle = (settlement) => {
    if (phase === "settled") return;
    phase = "settled";
    for (const call2 of pending.values()) {
      call2.reject(new Error(`control port settled (${settlement.outcome}) before the reply`));
    }
    pending.clear();
    endpoint.close();
    resolveSettled(settlement);
  };
  const breach = (detail) => {
    if (phase === "settled") return;
    endpoint.post({ kind: "lifecycle", phase: "shutdown", reason: "protocol-error", detail });
    settle({ outcome: "protocol-breach", detail });
  };
  endpoint.post({
    kind: "lifecycle",
    phase: "hello",
    protocolVersion: COORDINATOR_PROTOCOL_VERSION
  });
  const call = (method, args) => {
    if (phase === "settled") {
      return Promise.reject(new Error(`control port settled before ${method} was posted`));
    }
    nextRequestId += 1;
    const requestId = `c-${nextRequestId}`;
    const outcome = new Promise((resolve, reject2) => {
      pending.set(requestId, { resolve, reject: reject2 });
    });
    endpoint.post({ kind: "request", requestId, method, args });
    return outcome;
  };
  const commands = new Proxy({}, {
    get(_target, property) {
      if (typeof property !== "string") return void 0;
      return (args) => call(property, args);
    }
  });
  const settleReply = (requestId, outcome) => {
    const waiting = pending.get(requestId);
    if (waiting == null) return;
    pending.delete(requestId);
    if (outcome.status === "ok") {
      waiting.resolve(outcome.value);
      return;
    }
    waiting.reject(new ControlPortCallError(outcome.failure.code, outcome.failure.message));
  };
  const handleFrame = (frame) => {
    if (frame.kind === "lifecycle" && frame.phase === "shutdown") {
      settle(
        frame.reason === "requested" ? { outcome: "shutdown-requested" } : { outcome: "protocol-breach", detail: frame.detail ?? "peer reported a breach" }
      );
      return;
    }
    if (frame.kind === "lifecycle" && frame.phase === "ready") {
      if (readyObserved) {
        breach("ready repeated on a live control session");
        return;
      }
      if (frame.protocolVersion !== COORDINATOR_PROTOCOL_VERSION) {
        breach(
          `ready.protocolVersion ${frame.protocolVersion} is not the supported ${COORDINATOR_PROTOCOL_VERSION}`
        );
        return;
      }
      readyObserved = true;
      return;
    }
    if (frame.kind === "reply") {
      settleReply(frame.requestId, frame.outcome);
      return;
    }
    breach(`main posted a client-direction ${frame.kind} frame`);
  };
  return {
    commands,
    postEvent(family, payload) {
      if (phase === "settled") return;
      endpoint.post({ kind: "event", family, payload });
    },
    handleMessage(value) {
      if (phase === "settled") return;
      const intake = parseCoordinatorFrame(value);
      if (!intake.accepted) {
        breach(intake.rejection.detail);
        return;
      }
      handleFrame(intake.frame);
    },
    handlePortClosed() {
      settle({ outcome: "port-closed" });
    },
    shutdown() {
      if (phase === "settled") return;
      endpoint.post({ kind: "lifecycle", phase: "shutdown", reason: "requested", detail: null });
      settle({ outcome: "shutdown-requested" });
    },
    settled
  };
}

// src/shared/gateway-reachability.ts
var GATEWAY_NO_STORAGE_MESSAGE_MARKER = "sand box access blocked by privacy mode (no_storage)";
var GATEWAY_ACCESS_DENIED_MESSAGE_MARKER = "sand box access refused by backend access gate (access_denied)";
var GATEWAY_BOX_BLOCKED_PREFIX = "sand box blocked by kill switch: ";
var UNIT_SEPARATOR_NEVER_IN_COPY = "";
function encodeSandBoxBlockedMessage(info) {
  const fields = [info.reason, info.title, info.detail].join(UNIT_SEPARATOR_NEVER_IN_COPY);
  return `${GATEWAY_BOX_BLOCKED_PREFIX}${fields}`;
}
function hasSandBoxBlockedMarker(message) {
  return message.includes(GATEWAY_BOX_BLOCKED_PREFIX);
}
var SAND_CLIENT_PAUSE_REASON = "SAND_CLIENT_PAUSE";
var SAND_CLIENT_PAUSE_BLOCKED_MESSAGE = encodeSandBoxBlockedMessage({
  reason: SAND_CLIENT_PAUSE_REASON,
  title: "",
  detail: ""
});
function findSandBoxBlockedMessage(error) {
  const seen = /* @__PURE__ */ new Set();
  let current = error;
  while (current != null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const node = current;
    if (typeof node.message === "string") {
      const start = node.message.indexOf(GATEWAY_BOX_BLOCKED_PREFIX);
      if (start !== -1) return node.message.slice(start);
    }
    current = node.cause;
  }
  return null;
}

// src/shared/gateway-wire.ts
var GATEWAY_API_PREFIX = "/api";
var GATEWAY_EVENTS_PATH = "/events";
var GATEWAY_HEALTH_PATH = "/health";
var GATEWAY_AUTH_SCHEME = "Bearer";
var GATEWAY_SLIM_AVATARS_HEADER = "x-sand-slim-avatars";
var GATEWAY_TRACEPARENT_HEADER = "traceparent";

// src/shared/observability/send-trace.ts
var HEX_TRACE_ID = /^[0-9a-f]{32}$/;
var HEX_SPAN_ID = /^[0-9a-f]{16}$/;
var HEX_FLAGS = /^[0-9a-f]{2}$/;
var ZERO_TRACE_ID = "0".repeat(32);
var ZERO_SPAN_ID = "0".repeat(16);
function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
function deriveChildTraceparent(parent) {
  const parsed = parseTraceparent(parent);
  if (parsed === void 0) return void 0;
  try {
    const spanId = randomHex(8);
    const flags = (parsed.traceFlags & 1) === 1 ? "01" : "00";
    return { traceparent: `00-${parsed.traceId}-${spanId}-${flags}`, spanId };
  } catch {
    return void 0;
  }
}
function parseTraceparent(traceparent) {
  if (typeof traceparent !== "string") return void 0;
  const parts = traceparent.trim().split("-");
  if (parts.length !== 4) return void 0;
  const [version = "", traceId = "", spanId = "", flags = ""] = parts;
  if (version !== "00") return void 0;
  if (!HEX_TRACE_ID.test(traceId) || traceId === ZERO_TRACE_ID) return void 0;
  if (!HEX_SPAN_ID.test(spanId) || spanId === ZERO_SPAN_ID) return void 0;
  if (!HEX_FLAGS.test(flags)) return void 0;
  const traceFlags = Number.parseInt(flags, 16);
  if (Number.isNaN(traceFlags)) return void 0;
  return { traceId, spanId, traceFlags };
}

// ../packages/constants/dist/sand-box.js
var SAND_BOX_IMAGE_TAG_PREFIX = "sand-box-";
var SAND_BOX_IMAGE_TAG_LATEST = `${SAND_BOX_IMAGE_TAG_PREFIX}latest`;
var SAND_BOX_PRIMARY_NOVNC_PORT = 6080;
var SAND_BOX_FORK_NOVNC_PORT = 6081;
var SAND_SPECIAL_TREATMENT_NOVNC_PATH = "sand-special-treatment-v1/vnc.html";
function buildSandBoxNoVncUrl(proxyBaseUrl, networkToken, token, specialTreatment = false) {
  const wake = "resume_lower_s=900&resume_upper_s=18000";
  const tokenParam = token === void 0 ? "" : `token=${token}&`;
  const websockifyPath = `websockify?${tokenParam}network_token=${networkToken}&${wake}`;
  const viewerPath = specialTreatment ? SAND_SPECIAL_TREATMENT_NOVNC_PATH : "vnc.html";
  return `${proxyBaseUrl}/${viewerPath}?network_token=${networkToken}&${wake}&path=${encodeURIComponent(websockifyPath)}`;
}
function isSandSpecialTreatmentNoVncUrl(value) {
  try {
    return new URL(value).pathname.endsWith(`/${SAND_SPECIAL_TREATMENT_NOVNC_PATH}`);
  } catch (_a) {
    return false;
  }
}

// src/node-agent-coordinator/gateway/box-vnc-proxy.ts
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "localhost"]);
function proxifyBoxVncUrl(vncUrl, vncProxy) {
  let parsed;
  try {
    parsed = new URL(vncUrl);
  } catch {
    return vncUrl;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname) || !parsed.pathname.endsWith("/vnc.html")) {
    return vncUrl;
  }
  const port = Number.parseInt(parsed.port, 10);
  if (port === SAND_BOX_PRIMARY_NOVNC_PORT) {
    return vncProxy.primaryUrl;
  }
  if (port === SAND_BOX_FORK_NOVNC_PORT) {
    return buildSandBoxNoVncUrl(
      vncProxy.forkBaseUrl,
      vncProxy.networkToken,
      forkDisplayToken(parsed),
      isSandSpecialTreatmentNoVncUrl(vncProxy.primaryUrl)
    );
  }
  return vncUrl;
}
function forkDisplayToken(parsed) {
  const path = parsed.searchParams.get("path");
  const queryIndex = path?.indexOf("?") ?? -1;
  if (path == null || queryIndex < 0) return void 0;
  const token = new URLSearchParams(path.slice(queryIndex + 1)).get("token");
  return token != null && token.length > 0 ? token : void 0;
}
function proxifyForeverBoxStatus(status, vncProxy) {
  if (vncProxy == null) return status;
  const proxified = {
    ...status,
    vncUrl: status.vncUrl != null ? proxifyBoxVncUrl(status.vncUrl, vncProxy) : status.vncUrl
  };
  if (status.windows == null) return proxified;
  return {
    ...proxified,
    windows: status.windows.map((window) => ({
      ...window,
      vncUrl: proxifyBoxVncUrl(window.vncUrl, vncProxy)
    }))
  };
}

// src/shared/system-errno.ts
function findSystemErrno(error) {
  const seen = /* @__PURE__ */ new Set();
  let current = error;
  while (current != null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = current.code;
    if (typeof code === "string" && /^E[A-Z_]+$/.test(code)) return code;
    current = current.cause;
  }
  return void 0;
}

// src/node-agent-coordinator/gateway/gateway-reachability.ts
var SandGatewayUnreachableError = class extends Error {
  kind;
  httpStatus;
  causeSummary;
  constructor(kind, message, options) {
    super(message, options?.cause !== void 0 ? { cause: options.cause } : void 0);
    this.name = "SandGatewayUnreachableError";
    this.kind = kind;
    if (options?.httpStatus !== void 0) this.httpStatus = options.httpStatus;
    if (options?.causeSummary !== void 0) this.causeSummary = options.causeSummary;
  }
};
function outcomeForHttpStatus(status) {
  if (status >= 500) return "http_5xx";
  if (status === 401 || status === 403) return "access_denied";
  return void 0;
}
function hasFetchTimeoutSignal(error) {
  const seen = /* @__PURE__ */ new Set();
  let current = error;
  while (current != null && typeof current === "object" && !seen.has(current)) {
    if (current instanceof DeadlineExceededError) return true;
    seen.add(current);
    const node = current;
    if (typeof node.name === "string" && (node.name === "AbortError" || node.name === "TimeoutError" || /TimeoutError$/.test(node.name))) {
      return true;
    }
    if (typeof node.code === "string" && /TIMEOUT/.test(node.code)) return true;
    current = node.cause;
  }
  return false;
}
function hasMarkerInCauseChain(error, matches) {
  const seen = /* @__PURE__ */ new Set();
  let current = error;
  while (current != null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const node = current;
    if (typeof node.message === "string" && matches(node.message)) {
      return true;
    }
    current = node.cause;
  }
  return false;
}
function classifyGatewayFetchFailure(error) {
  const errno = findSystemErrno(error);
  const name = error instanceof Error ? error.name : "";
  const causeSummary = [name, errno].filter((part) => part != null && part.length > 0).join("/") || "unknown";
  if (hasMarkerInCauseChain(error, (message) => message.includes(GATEWAY_NO_STORAGE_MESSAGE_MARKER))) {
    return { outcome: "no_storage", causeSummary };
  }
  if (hasMarkerInCauseChain(error, hasSandBoxBlockedMarker)) {
    return { outcome: "box_blocked", causeSummary };
  }
  if (hasMarkerInCauseChain(
    error,
    (message) => message.includes(GATEWAY_ACCESS_DENIED_MESSAGE_MARKER)
  )) {
    return { outcome: "access_denied", causeSummary };
  }
  if (errno === "ECONNREFUSED") return { outcome: "refused", causeSummary };
  if (errno === "ENOTFOUND" || errno === "EAI_AGAIN") {
    return { outcome: "dns", causeSummary };
  }
  if (errno === "ETIMEDOUT" || hasFetchTimeoutSignal(error)) {
    return { outcome: "timeout", causeSummary };
  }
  return { outcome: "network", causeSummary };
}
function classifyStreamDown(input) {
  if (input.clientPaused) return { reason: "box_blocked", cause: "client-paused" };
  if (input.stalled) return { reason: "stall-timeout", cause: null };
  if (input.forced || input.devInducedOffline) {
    return {
      reason: "forced-reconnect",
      cause: input.devInducedOffline ? "dev-induced-offline" : null
    };
  }
  const classified = classifyGatewayFetchFailure(input.error);
  return { reason: classified.outcome, cause: classified.causeSummary };
}
function classifyGatewayError(error) {
  if (error instanceof SandGatewayUnreachableError) {
    const classified = { outcome: error.kind };
    if (error.httpStatus !== void 0) classified.httpStatus = error.httpStatus;
    if (error.causeSummary !== void 0) classified.causeSummary = error.causeSummary;
    return classified;
  }
  return classifyGatewayFetchFailure(error);
}
function classifyBaseUrlKind(baseUrl) {
  if (baseUrl == null || baseUrl.length === 0) return "unknown";
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]" ? "loopback" : "pod_proxy";
  } catch {
    return "unknown";
  }
}

// src/node-agent-coordinator/gateway/gateway-client.ts
var PERMANENT_REFUSAL_KINDS = /* @__PURE__ */ new Set([
  "no_storage",
  "box_blocked"
]);
var SSE_RECONNECT_MIN_MS = 1e3;
var SSE_RECONNECT_MAX_MS = 1e4;
var SSE_STALL_TIMEOUT_MS = 35e3;
var SSE_CONNECT_TIMEOUT_MS = 15e3;
function extractGatewayErrorMessage(body) {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed.error === "string" && parsed.error.length > 0 ? parsed.error : null;
  } catch {
    return null;
  }
}
function unwrapGatewayEnvelope(payload) {
  if (payload == null || typeof payload !== "object" || !("ok" in payload)) return payload;
  if (payload.ok === true) return payload.value;
  const failure = payload.failure;
  const message = typeof failure === "string" ? failure : failure?.message;
  throw new SandGatewayCommandError(message ?? "gateway command failed");
}
var SandGatewayCommandError = class extends Error {
};
var SEND_POST_TIMEOUT_MS = 15e3;
var DISABLE_SEND_ACCEPT_RETURN_ENV = "SAND_DISABLE_SEND_ACCEPT_RETURN";
var SEND_POST_TIMEOUT_ENV = "SAND_SEND_POST_TIMEOUT_MS";
var ROSTER_READ_TIMEOUT_MS = 15e3;
var ROSTER_READ_TIMEOUT_ENV = "SAND_ROSTER_READ_TIMEOUT_MS";
var DISABLE_SLIM_AVATARS_ENV = "SAND_DISABLE_SLIM_AVATARS";
var TRACE_WINDOW_ROOT_CACHE_MS = 5e3;
function createCoordinatorGatewayClientTiming() {
  const overrideMs = Number(process.env[SEND_POST_TIMEOUT_ENV]);
  const sendPostTimeoutMs = Number.isFinite(overrideMs) && overrideMs > 0 ? overrideMs : SEND_POST_TIMEOUT_MS;
  const rosterReadOverrideMs = Number(process.env[ROSTER_READ_TIMEOUT_ENV]);
  const rosterReadTimeoutMs = Number.isFinite(rosterReadOverrideMs) && rosterReadOverrideMs > 0 ? rosterReadOverrideMs : ROSTER_READ_TIMEOUT_MS;
  return {
    clock: realClock,
    // The reconnect loop is unbounded and floor-resetting: it retries
    // forever (a box outage must never strand the desktop) and resets to
    // the floor on every established stream, so only schedule(attempt) fits
    // — runWithRetry's finite maxAttempts does not. The policy still
    // requires a bound; MAX_SAFE_INTEGER records "unbounded by design".
    reconnectBackoff: createRetryPolicy2({
      name: "gateway-sse-reconnect-backoff",
      maxAttempts: Number.MAX_SAFE_INTEGER,
      initialDelayMs: SSE_RECONNECT_MIN_MS,
      maxDelayMs: SSE_RECONNECT_MAX_MS,
      backoffFactor: 2
    }),
    connectDeadline: createDeadlinePolicy2({
      name: "gateway-sse-connect",
      timeoutMs: SSE_CONNECT_TIMEOUT_MS
    }),
    stallWatchdog: createIdleWatchdogPolicy2({
      name: "gateway-sse-stall",
      idleMs: SSE_STALL_TIMEOUT_MS
    }),
    sendPostDeadline: createDeadlinePolicy2({
      name: "gateway-send-post",
      timeoutMs: sendPostTimeoutMs
    }),
    rosterReadDeadline: createDeadlinePolicy2({
      name: "gateway-roster-read",
      timeoutMs: rosterReadTimeoutMs
    })
  };
}
function withAuth(headers, connection) {
  const merged = { ...headers, ...connection.headers };
  if (connection.token != null && connection.token.length > 0) {
    merged.authorization = `${GATEWAY_AUTH_SCHEME} ${connection.token}`;
  }
  return merged;
}
var CoordinatorGatewayClient = class {
  isClosed = false;
  devInducedOffline = false;
  clientPaused = false;
  transportState = "initial";
  // The event loop is single-owner: start() is idempotent, and a manual
  // reconnect interrupts whichever phase is active (stream/connect or backoff)
  // instead of spawning a competing loop.
  eventLoopPromise;
  activeEventLoopController;
  reconnectGeneration = 0;
  pendingForcedReconnect;
  connectionCount = 0;
  sendAcceptReturnDisabled;
  slimAvatarsDisabled;
  cachedTraceWindowRoot;
  inflightTraceWindowRoot;
  spanSinkBroken = false;
  options;
  upstreamResolveConnection;
  constructor(options) {
    const { resolveConnection, ...rest } = options;
    this.options = rest;
    this.upstreamResolveConnection = resolveConnection;
    this.sendAcceptReturnDisabled = process.env[DISABLE_SEND_ACCEPT_RETURN_ENV] === "1";
    this.slimAvatarsDisabled = process.env[DISABLE_SLIM_AVATARS_ENV] === "1";
  }
  // Every gateway request's headers: the connection's auth plus this client's
  // capability advertisements — today the slim-avatar header, which tells the
  // host to serve summaries with `avatarDataUrl: null` + `avatarVersion` so
  // roster payloads stop re-shipping inline image bytes (the client resolves
  // avatars through getAgentAvatar instead). An older host ignores it.
  requestHeaders(base, connection) {
    const headers = withAuth(base, connection);
    if (!this.slimAvatarsDisabled) {
      headers[GATEWAY_SLIM_AVATARS_HEADER] = "1";
    }
    return headers;
  }
  // Stale-while-revalidate, never awaited: main can never park a command.
  traceWindowRoot() {
    const resolve = this.options.resolveTraceWindowTraceparent;
    if (resolve === void 0) return void 0;
    const now = this.options.timing.clock.monotonicNow();
    const cached = this.cachedTraceWindowRoot;
    const isFresh = cached !== void 0 && now < cached.expiresAtMonotonicMs;
    if (!isFresh && this.inflightTraceWindowRoot === void 0) {
      const inflight = this.pullTraceWindowRoot(resolve).finally(() => {
        if (this.inflightTraceWindowRoot === inflight) {
          this.inflightTraceWindowRoot = void 0;
        }
      });
      this.inflightTraceWindowRoot = inflight;
    }
    return cached?.root;
  }
  async pullTraceWindowRoot(resolve) {
    try {
      const root = await resolve() ?? void 0;
      this.cachedTraceWindowRoot = {
        expiresAtMonotonicMs: this.options.timing.clock.monotonicNow() + TRACE_WINDOW_ROOT_CACHE_MS,
        root
      };
    } catch {
      this.cachedTraceWindowRoot = void 0;
    }
  }
  start() {
    if (this.isClosed || this.eventLoopPromise != null) return;
    this.eventLoopPromise = this.runEventLoop().finally(() => {
      this.eventLoopPromise = void 0;
    });
  }
  // Tear down the current stream/connect attempt without terminally closing the
  // client, then resolve only after the one event loop has established a fresh
  // stream. Concurrent calls share one recovery so repeated Retry clicks cannot
  // stack streams. The owner invalidates its health cache before calling this,
  // making the fresh attempt re-resolve instead of trusting the endpoint whose
  // stream wedged.
  forceReconnect() {
    if (this.isClosed) {
      return Promise.reject(new Error("gateway client is closed"));
    }
    if (this.pendingForcedReconnect != null) {
      this.reconnectGeneration += 1;
      this.interruptEventLoopAttempt();
      return this.pendingForcedReconnect.promise;
    }
    const { promise, resolve, reject: reject2 } = Promise.withResolvers();
    this.reconnectGeneration += 1;
    this.pendingForcedReconnect = {
      generation: this.reconnectGeneration,
      promise,
      resolve,
      reject: reject2
    };
    this.interruptEventLoopAttempt();
    return promise;
  }
  interruptEventLoopAttempt() {
    if (this.transportState !== "connected") this.notifyDisconnected("forced-reconnect", null);
    this.activeEventLoopController?.abort();
    this.start();
  }
  emitTransportEvent(event) {
    this.options.onTransportEvent?.(event);
  }
  setDevInducedOffline(induced) {
    if (this.devInducedOffline !== induced) {
      this.devInducedOffline = induced;
      this.activeEventLoopController?.abort();
    }
    return { induced: this.devInducedOffline };
  }
  setClientPaused(paused) {
    if (this.clientPaused !== paused) {
      this.clientPaused = paused;
      this.activeEventLoopController?.abort();
    }
    return { paused: this.clientPaused };
  }
  async resolveConnection(signal) {
    if (this.clientPaused) {
      throw new SandGatewayUnreachableError("box_blocked", SAND_CLIENT_PAUSE_BLOCKED_MESSAGE, {
        causeSummary: "client-paused"
      });
    }
    if (this.devInducedOffline) {
      throw new SandGatewayUnreachableError("network", "gateway offline: induced by dev controls", {
        causeSummary: "dev-induced-offline"
      });
    }
    return await this.upstreamResolveConnection(signal);
  }
  notifyDisconnected(reason, cause) {
    if (this.isClosed || this.transportState === "disconnected") return;
    this.transportState = "disconnected";
    this.emitTransportEvent({
      family: "transport-down",
      payload: { generation: this.connectionCount, reason, cause }
    });
  }
  close() {
    this.isClosed = true;
    this.activeEventLoopController?.abort();
    this.pendingForcedReconnect?.reject(new Error("gateway client closed"));
    this.pendingForcedReconnect = void 0;
  }
  // Report a classified reachability result to the observability sink, if wired.
  // Best-effort: telemetry must never throw into (or slow) the command path.
  reportReachability(report, baseUrl) {
    if (this.clientPaused) return;
    try {
      this.options.onReachability?.(report, baseUrl);
    } catch {
    }
  }
  // Deliver one nonce-correlated send stage to the injected recorder in the
  // control port's frozen shape. Stages are keyed by (accountSlot,
  // clientNonce) — the durable acceptance ledger's identity — so a nonce-less
  // legacy send records nothing (main's span pipeline is fail-closed on the
  // missing traceparent anyway). Best-effort, like reportReachability.
  recordSendStage(stage) {
    const recorder = this.options.recordTransportStage;
    if (recorder == null) return;
    if (stage.clientNonce == null || stage.clientNonce.length === 0) return;
    try {
      recorder({
        accountSlot: HOST_ACCOUNT_SLOT,
        clientNonce: stage.clientNonce,
        stage: stage.stage,
        attempt: stage.attempt,
        traceparent: stage.traceparent ?? null,
        startEpochMs: stage.startEpochMs,
        durationMs: stage.durationMs,
        isError: stage.isError === true
      });
    } catch {
    }
  }
  reportCommandSpan(method, commandTrace, settle) {
    if (commandTrace === void 0) return;
    const sink = this.options.recordGatewayCommandSpan;
    if (sink == null || this.spanSinkBroken) return;
    try {
      sink({
        method,
        rootTraceparent: commandTrace.root,
        spanId: commandTrace.child.spanId,
        startEpochMs: settle.startEpochMs,
        durationMs: settle.durationMs,
        isError: settle.isError
      });
    } catch {
      this.spanSinkBroken = true;
    }
  }
  async request(method, args, init) {
    const startMonotonicMs = this.options.timing.clock.monotonicNow();
    let connection;
    let commandTrace;
    let fetchStartMonotonicMs = startMonotonicMs;
    let fetchStartEpochMs = 0;
    try {
      connection = await this.resolveConnection(init?.signal);
      const root = this.traceWindowRoot();
      const child = root !== void 0 && this.options.recordGatewayCommandSpan != null ? deriveChildTraceparent(root) : void 0;
      if (root !== void 0 && child !== void 0) {
        commandTrace = { root, child };
      }
      const traceparent = child?.traceparent ?? root;
      fetchStartMonotonicMs = this.options.timing.clock.monotonicNow();
      fetchStartEpochMs = this.options.timing.clock.now();
      const response = await fetch(`${connection.baseUrl}${GATEWAY_API_PREFIX}/${method}`, {
        method: "POST",
        headers: this.requestHeaders(
          {
            "content-type": "application/json",
            ...traceparent !== void 0 ? { [GATEWAY_TRACEPARENT_HEADER]: traceparent } : {}
          },
          connection
        ),
        body: JSON.stringify(args ?? {}),
        ...init?.signal != null ? { signal: init.signal } : {}
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => response.statusText);
        const message = extractGatewayErrorMessage(detail) ?? `gateway ${method} failed: ${detail}`;
        if (response.status < 500) throw new SandGatewayCommandError(message);
        throw new SandGatewayUnreachableError("http_5xx", message, {
          httpStatus: response.status
        });
      }
      const result = unwrapGatewayEnvelope(await response.json());
      this.reportCommandSpan(method, commandTrace, {
        startEpochMs: fetchStartEpochMs,
        durationMs: this.options.timing.clock.monotonicNow() - fetchStartMonotonicMs,
        isError: false
      });
      return { result, connection };
    } catch (error) {
      this.reportCommandSpan(method, commandTrace, {
        startEpochMs: fetchStartEpochMs,
        durationMs: this.options.timing.clock.monotonicNow() - fetchStartMonotonicMs,
        isError: true
      });
      if (error instanceof SandGatewayCommandError) throw error;
      const classified = classifyGatewayError(error);
      this.reportReachability(
        {
          outcome: classified.outcome,
          method,
          latencyMs: this.options.timing.clock.monotonicNow() - startMonotonicMs,
          baseUrlKind: classifyBaseUrlKind(connection?.baseUrl),
          ...classified.httpStatus !== void 0 ? { httpStatus: classified.httpStatus } : {},
          ...classified.causeSummary !== void 0 ? { causeSummary: classified.causeSummary } : {}
        },
        connection?.baseUrl
      );
      if (error instanceof SandGatewayUnreachableError) throw error;
      const blocked = findSandBoxBlockedMessage(error);
      throw new SandGatewayUnreachableError(
        classified.outcome,
        blocked == null ? `gateway ${method} unreachable (${classified.outcome})` : `gateway ${method} unreachable (${classified.outcome}): ${blocked}`,
        {
          cause: error,
          ...classified.causeSummary !== void 0 ? { causeSummary: classified.causeSummary } : {}
        }
      );
    }
  }
  async command(method, args, init) {
    return (await this.request(method, args, init)).result;
  }
  /**
   * The generic entry BOTH port servers dispatch request frames through
   * (typed over the renderer-plus-main served union,
   * shared/rpc/coordinator-main.ts; each session's dispatch scopes itself
   * to its own table's membership first): every contract method is the
   * same call shape — POST /api/<name> with the single argument as the
   * JSON body — so this routes off the method NAME, keyed by the shared
   * contract tables the servers already checked membership against. Only
   * methods with a BEHAVIORAL override (the bounded send, the noVNC
   * rewrite, the bounded boot-blocking roster reads) leave the uniform
   * path; a new contract entry is served with zero edits here. `signal`
   * cancels the uniform POST; the send path
   * deliberately ignores it (aborting a possibly-accepted send buys
   * nothing — the reply settles as cancelled at the envelope layer and the
   * nonce ledger dedupes).
   */
  dispatchCommand(method, args, init) {
    if (method === "sendPrompt") {
      return this.sendPrompt(args);
    }
    if (method === "getForeverBoxStatus" || method === "ensureForeverBox") {
      return this.foreverBoxStatusCommand(method, args, init);
    }
    if (method === "listAgents" || method === "countAgents") {
      return this.boundedRosterRead(method, init);
    }
    if (method === "setDevGatewayOffline") {
      const induced = args.induced === true;
      return Promise.resolve(this.setDevInducedOffline(induced));
    }
    if (method === "setGatewayPaused") {
      const paused = args.paused === true;
      return Promise.resolve(this.setClientPaused(paused));
    }
    return this.command(method, args, init);
  }
  /** The uniform POST path for the one legacy command outside the shared contract tables. */
  async dispatchLegacyCommand(method, args) {
    await this.command(method, args);
  }
  // The boot-blocking roster reads (why: ROSTER_READ_TIMEOUT_MS) get the
  // bounded attempt plus ONE idempotent retry on a fresh resolve + socket.
  // Mutations never auto-retry: a timed-out reply may already be applied.
  async boundedRosterRead(method, init) {
    try {
      return await this.boundedRosterReadAttempt(method, init);
    } catch (error) {
      const isRetryable = !this.isClosed && init?.signal?.aborted !== true && !(error instanceof SandGatewayCommandError) && !(error instanceof SandGatewayUnreachableError && PERMANENT_REFUSAL_KINDS.has(error.kind));
      if (!isRetryable) throw error;
      try {
        this.options.onTransportRetry?.();
      } catch {
      }
      return await this.boundedRosterReadAttempt(method, init);
    }
  }
  async boundedRosterReadAttempt(method, init) {
    try {
      return await this.options.timing.rosterReadDeadline.run(
        async (signal) => await this.command(method, {}, { signal }),
        init?.signal
      );
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        throw new SandGatewayUnreachableError(
          "timeout",
          `gateway ${method} unreachable (timeout)`,
          { cause: error }
        );
      }
      throw error;
    }
  }
  // Base URLs of every gateway whose sendPrompt reply carried
  // `accepted: true` — the NEW host's acceptance-return marker, which also
  // means the host dedupes retries by clientNonce. This is the capability
  // probe gating the idempotent retry: a retry that re-POSTs a possibly-
  // already-received send against an OLD (turn-scoped, dedupe-less) host could
  // double-send, so such a retry only ever targets a base URL that has PROVEN
  // dedupe on a prior response. A set (not a single slot) so bouncing between
  // proven endpoints (e.g. loopback dev + a pod URL) never forgets one.
  // Bounded by construction: connections rotate rarely (box recreates).
  sendDedupeProvenBaseUrls = /* @__PURE__ */ new Set();
  // The send command leaves the uniform path (see dispatchCommand) so the
  // latency-critical send POST — the user's gray→ack path — gets:
  //
  //   - a BOUNDED deadline (the gateway-send-post policy): the host resolves
  //     the send at durable acceptance, so a response past the bound is a
  //     wedged connection, not a slow send — fail fast instead of graying
  //     forever;
  //   - ONE idempotent retry on a TRANSPORT failure (connect refused/reset,
  //     the deadline above): the host dedupes by clientNonce, so a retry of an
  //     already-accepted send is a no-op success, never a double-send. A reply
  //     the gateway actually made (SandGatewayCommandError) is never retried;
  //     a send without a nonce, or against a host that has not PROVEN the
  //     dedupe capability (an older turn-scoped host), is never retried;
  //   - nonce-correlated stage reports (`gateway-connect`, `gateway-post`) to
  //     the injected recorder, so the transport share of the ack window is
  //     measured per stage instead of assumed.
  //
  // Kill-switch parity: with SAND_DISABLE_SEND_ACCEPT_RETURN=1 this reverts to
  // the plain unbounded command path (no timeout, no retry, no stage reports).
  //
  // The host's acceptance result flows through to the caller: `accepted:
  // true` is the durable-acceptance marker (an older host resolves void),
  // which the renderer's source adapter forwards to the Client journal. Same
  // value the dedupe probe below already reads off the reply.
  async sendPrompt(args) {
    if (this.sendAcceptReturnDisabled) {
      return await this.command("sendPrompt", args);
    }
    const firstAttempt = { baseUrl: void 0, postStarted: false };
    try {
      return await this.sendPromptAttempt(args, 0, firstAttempt);
    } catch (error) {
      const postNeverDispatched = !firstAttempt.postStarted;
      const dedupeProven = firstAttempt.baseUrl != null && this.sendDedupeProvenBaseUrls.has(firstAttempt.baseUrl);
      const isRetryable = !this.isClosed && args.clientNonce != null && args.clientNonce.length > 0 && !(error instanceof SandGatewayCommandError) && (postNeverDispatched || dedupeProven);
      if (!isRetryable) throw error;
      try {
        this.options.onTransportRetry?.();
      } catch {
      }
      return await this.sendPromptAttempt(
        args,
        1,
        { baseUrl: void 0, postStarted: false },
        postNeverDispatched ? void 0 : firstAttempt.baseUrl
      );
    }
  }
  async sendPromptAttempt(args, attempt, state, requiredBaseUrl) {
    const clock = this.options.timing.clock;
    const connectStartEpochMs = clock.now();
    const connectStartMonotonicMs = clock.monotonicNow();
    const connection = await this.resolveConnection();
    state.baseUrl = connection.baseUrl;
    if (requiredBaseUrl != null && connection.baseUrl !== requiredBaseUrl) {
      throw new Error("send retry aborted: the gateway endpoint changed mid-send");
    }
    this.recordSendStage({
      stage: "gateway-connect",
      attempt,
      clientNonce: args.clientNonce,
      traceparent: args.traceparent,
      startEpochMs: connectStartEpochMs,
      durationMs: clock.monotonicNow() - connectStartMonotonicMs
    });
    const postStartEpochMs = clock.now();
    const postStartMonotonicMs = clock.monotonicNow();
    try {
      state.postStarted = true;
      const result = await this.options.timing.sendPostDeadline.run(async (signal) => {
        const response = await fetch(`${connection.baseUrl}${GATEWAY_API_PREFIX}/sendPrompt`, {
          method: "POST",
          headers: this.requestHeaders({ "content-type": "application/json" }, connection),
          body: JSON.stringify(args),
          signal
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => response.statusText);
          throw new SandGatewayCommandError(
            extractGatewayErrorMessage(detail) ?? `gateway sendPrompt failed: ${detail}`
          );
        }
        return unwrapGatewayEnvelope(await response.json());
      });
      if (result?.accepted === true) {
        this.sendDedupeProvenBaseUrls.add(connection.baseUrl);
      }
      this.recordSendStage({
        stage: "gateway-post",
        attempt,
        clientNonce: args.clientNonce,
        traceparent: args.traceparent,
        startEpochMs: postStartEpochMs,
        durationMs: clock.monotonicNow() - postStartMonotonicMs
      });
      return result ?? void 0;
    } catch (error) {
      this.recordSendStage({
        stage: "gateway-post",
        attempt,
        clientNonce: args.clientNonce,
        traceparent: args.traceparent,
        startEpochMs: postStartEpochMs,
        durationMs: clock.monotonicNow() - postStartMonotonicMs,
        isError: true
      });
      throw error;
    }
  }
  async foreverBoxStatusCommand(method, args, init) {
    const { result, connection } = await this.request(
      method,
      args,
      init
    );
    return result == null ? null : proxifyForeverBoxStatus(result, connection.vncProxy);
  }
  async runEventLoop() {
    let failedAttempts = 0;
    while (!this.isClosed) {
      const attemptGeneration = this.reconnectGeneration;
      try {
        await this.streamEvents(() => {
          failedAttempts = 0;
        }, attemptGeneration);
      } catch {
      }
      if (this.isClosed) break;
      if (attemptGeneration !== this.reconnectGeneration) {
        failedAttempts = 0;
        continue;
      }
      const backoffController = new AbortController();
      this.activeEventLoopController = backoffController;
      if (attemptGeneration !== this.reconnectGeneration) {
        this.activeEventLoopController = void 0;
        failedAttempts = 0;
        continue;
      }
      failedAttempts += 1;
      const wait = this.options.timing.reconnectBackoff.schedule(
        failedAttempts,
        backoffController.signal
      );
      try {
        await wait.elapsed;
      } catch {
      } finally {
        wait.dispose();
      }
      if (this.activeEventLoopController === backoffController) {
        this.activeEventLoopController = void 0;
      }
      if (attemptGeneration !== this.reconnectGeneration) {
        failedAttempts = 0;
        continue;
      }
    }
  }
  async streamEvents(resetBackoff, attemptGeneration) {
    const controller = new AbortController();
    this.activeEventLoopController = controller;
    const connectStartMonotonicMs = this.options.timing.clock.monotonicNow();
    let connection;
    let didConnect = false;
    try {
      let handshake;
      try {
        handshake = await this.options.timing.connectDeadline.run(async (deadlineSignal) => {
          const resolved = await this.resolveConnection(deadlineSignal);
          connection = resolved;
          const response = await fetch(`${resolved.baseUrl}${GATEWAY_EVENTS_PATH}`, {
            headers: this.requestHeaders({ accept: "text/event-stream" }, resolved),
            signal: controller.signal
          });
          if (controller.signal.aborted || attemptGeneration !== this.reconnectGeneration) {
            void response.body?.cancel().catch(() => {
            });
            throw new Error("gateway connect superseded");
          }
          if (!response.ok || response.body == null) {
            throw new SandGatewayUnreachableError(
              outcomeForHttpStatus(response.status) ?? "network",
              `gateway events failed: ${response.status}`,
              { httpStatus: response.status }
            );
          }
          return { connection: resolved, reader: response.body.getReader() };
        }, controller.signal);
      } catch (error) {
        if (error instanceof DeadlineExceededError) controller.abort();
        throw error;
      }
      const { reader } = handshake;
      resetBackoff();
      this.connectionCount += 1;
      didConnect = true;
      this.transportState = "connected";
      const { vncProxy } = handshake.connection;
      const blocks = new SseBlockDecoder((block) => this.dispatchEventBlock(block, vncProxy));
      let stalled = false;
      const stallWatchdog = this.options.timing.stallWatchdog.arm(() => {
        stalled = true;
        controller.abort();
      });
      let down = { reason: "stream-ended", cause: null };
      try {
        this.reportReachability(
          {
            outcome: "ok",
            method: "events",
            latencyMs: this.options.timing.clock.monotonicNow() - connectStartMonotonicMs,
            baseUrlKind: classifyBaseUrlKind(handshake.connection.baseUrl)
          },
          handshake.connection.baseUrl
        );
        const forcedReconnect = this.pendingForcedReconnect != null && this.pendingForcedReconnect.generation <= attemptGeneration;
        this.emitTransportEvent({
          family: "transport-connected",
          payload: { generation: this.connectionCount }
        });
        if (forcedReconnect) {
          this.pendingForcedReconnect?.resolve();
          this.pendingForcedReconnect = void 0;
        }
        for (; ; ) {
          const result = await reader.read();
          if (result.done) break;
          stallWatchdog.kick();
          blocks.push(result.value);
        }
      } catch (error) {
        down = classifyStreamDown({
          stalled,
          forced: attemptGeneration !== this.reconnectGeneration,
          devInducedOffline: this.devInducedOffline,
          clientPaused: this.clientPaused,
          error
        });
        throw error;
      } finally {
        stallWatchdog.dispose();
        controller.abort();
        this.notifyDisconnected(down.reason, down.cause);
      }
    } catch (error) {
      if (!didConnect && !this.isClosed && attemptGeneration === this.reconnectGeneration) {
        const classified = classifyGatewayError(error);
        this.reportReachability(
          {
            outcome: classified.outcome,
            method: "events",
            latencyMs: this.options.timing.clock.monotonicNow() - connectStartMonotonicMs,
            baseUrlKind: classifyBaseUrlKind(connection?.baseUrl),
            ...classified.httpStatus !== void 0 ? { httpStatus: classified.httpStatus } : {},
            ...classified.causeSummary !== void 0 ? { causeSummary: classified.causeSummary } : {}
          },
          connection?.baseUrl
        );
      }
      throw error;
    } finally {
      if (this.activeEventLoopController === controller) {
        this.activeEventLoopController = void 0;
      }
    }
  }
  dispatchEventBlock(block, vncProxy) {
    const dataLines = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).trim());
    if (dataLines.length === 0) return;
    try {
      const event = JSON.parse(dataLines.join("\n"));
      if (typeof event.channel !== "string" || event.channel.length === 0) return;
      if (event.channel === "forever-box") {
        this.options.onEvent({
          channel: "forever-box",
          payload: proxifyForeverBoxStatus(event.payload, vncProxy)
        });
        return;
      }
      this.options.onEvent({ channel: event.channel, payload: event.payload });
    } catch {
    }
  }
};

// src/node-agent-coordinator/gateway/gateway-dns-diagnostics.ts
var import_node_crypto = require("node:crypto");
var import_promises = require("node:dns/promises");
var DNS_PROBE_TIMEOUT_MS = 2e3;
var DNS_PROBE_MIN_INTERVAL_MS = 6e4;
var GENERAL_CONTROL_HOSTNAME = "api2.cursor.sh";
function isAllowedCluster(value) {
  return value === "dev4" || value === "us8";
}
function dnsTargetFromBaseUrl(baseUrl, createWildcardLabel) {
  if (baseUrl == null) return void 0;
  try {
    const url = new URL(baseUrl);
    const labels = url.hostname.split(".");
    if (url.protocol !== "https:" || labels.length !== 4 || labels[0] == null || labels[0].length === 0 || labels[1] == null || labels[2] !== "cursorvm" || labels[3] !== "com" || !isAllowedCluster(labels[1])) {
      return void 0;
    }
    const cluster = labels[1];
    const wildcardLabel = createWildcardLabel();
    if (!/^[a-z0-9-]{1,63}$/.test(wildcardLabel)) return void 0;
    return {
      endpointHostname: url.hostname,
      wildcardHostname: `${wildcardLabel}.${cluster}.cursorvm.com`,
      cluster
    };
  } catch {
    return void 0;
  }
}
function classifyProbeError(error) {
  if (error instanceof DeadlineExceededError) return "timeout";
  switch (findSystemErrno(error)) {
    case "ENOTFOUND":
    case "ENODATA":
      return "not_found";
    case "EAI_AGAIN":
    case "ESERVFAIL":
    case "EREFUSED":
      return "temporary_failure";
    case "ETIMEOUT":
    case "ETIMEDOUT":
      return "timeout";
    default:
      return "error";
  }
}
function classifyDnsDiagnosis(results) {
  if (results.systemExact === "resolved" && results.independentExact === "resolved") {
    return "resolved_before_probe";
  }
  if (results.systemExact !== "resolved" && results.independentExact === "resolved") {
    return "system_path_failure";
  }
  if (results.systemExact === "resolved" && results.independentExact !== "resolved") {
    return "independent_path_failure";
  }
  if (results.independentExact !== "resolved" && results.independentWildcard === "resolved") {
    return "endpoint_failure";
  }
  if (results.independentExact !== "resolved" && results.independentWildcard !== "resolved" && results.independentGeneral === "resolved") {
    return "cursorvm_failure";
  }
  if (results.independentGeneral !== "resolved") return "general_dns_failure";
  return "inconclusive";
}
function triggerFromCause(causeSummary) {
  if (causeSummary?.includes("ENOTFOUND") === true) return "not_found";
  if (causeSummary?.includes("EAI_AGAIN") === true) return "temporary_failure";
  return "unknown";
}
var GatewayDnsDiagnosticReporter = class {
  constructor(options) {
    this.options = options;
  }
  options;
  episodeActive = false;
  probeInFlight = false;
  lastProbeStartedAtMs = Number.NEGATIVE_INFINITY;
  observe(report, baseUrl) {
    if (report.outcome === "ok") {
      this.episodeActive = false;
      return;
    }
    if (report.outcome !== "dns" || this.episodeActive) return;
    const target = dnsTargetFromBaseUrl(baseUrl, this.options.createWildcardLabel);
    if (target == null) return;
    const now = this.options.clock.monotonicNow();
    if (this.probeInFlight || now - this.lastProbeStartedAtMs < DNS_PROBE_MIN_INTERVAL_MS) {
      return;
    }
    this.episodeActive = true;
    this.probeInFlight = true;
    this.lastProbeStartedAtMs = now;
    void this.run(target, triggerFromCause(report.causeSummary)).then(
      (diagnostic) => {
        this.probeInFlight = false;
        try {
          this.options.onDiagnostic(diagnostic);
        } catch {
          return;
        }
      },
      () => {
        this.probeInFlight = false;
      }
    );
  }
  async run(target, trigger) {
    const probe = async (resolve) => {
      try {
        await this.options.deadline.run(() => resolve());
        return "resolved";
      } catch (error) {
        return classifyProbeError(error);
      }
    };
    const [systemExact, independentExact, independentWildcard, independentGeneral] = await Promise.all([
      probe(() => this.options.systemLookup(target.endpointHostname)),
      probe(() => this.options.independentLookup(target.endpointHostname)),
      probe(() => this.options.independentLookup(target.wildcardHostname)),
      probe(() => this.options.independentLookup(GENERAL_CONTROL_HOSTNAME))
    ]);
    const results = {
      systemExact,
      independentExact,
      independentWildcard,
      independentGeneral
    };
    return {
      cluster: target.cluster,
      trigger,
      diagnosis: classifyDnsDiagnosis(results),
      ...results
    };
  }
};
function createGatewayDnsDiagnosticReporter(onDiagnostic) {
  const resolver = new import_promises.Resolver({ timeout: DNS_PROBE_TIMEOUT_MS, tries: 1 });
  return new GatewayDnsDiagnosticReporter({
    clock: realClock,
    deadline: createDeadlinePolicy2({
      name: "gateway-dns-diagnostic",
      timeoutMs: DNS_PROBE_TIMEOUT_MS
    }),
    systemLookup: (hostname2) => (0, import_promises.lookup)(hostname2),
    independentLookup: (hostname2) => resolver.resolve4(hostname2),
    createWildcardLabel: () => `sand-dns-probe-${(0, import_node_crypto.randomUUID)()}`,
    onDiagnostic
  });
}

// src/node-agent-coordinator/gateway/gateway-event-families.ts
var SSE_CHANNEL_BY_FAMILY = {
  transcript: "transcript",
  agents: "agents",
  "agent-upserted": "agent-upserted",
  tray: "tray",
  "agents-workflow": "workflows",
  subagents: "subagents",
  "async-tasks": "async-tasks",
  "agents-automation": "automations",
  "mcp-servers-updated": "mcp-servers",
  "forever-box": "forever-box",
  "teach-recording": "teach-recording",
  "box-disk-pressure": "box-disk-pressure",
  "computer-action": "computer-action",
  outline: "outline",
  sharing: "sharing",
  "host-settings": "host-settings"
};
var FAMILY_BY_SSE_CHANNEL = new Map(
  Object.entries(SSE_CHANNEL_BY_FAMILY).map(
    ([family, channel]) => [channel, family]
  )
);
function coordinatorEventFamilyForSseChannel(channel) {
  return FAMILY_BY_SSE_CHANNEL.get(channel) ?? null;
}

// src/shared/rpc/coordinator.ts
var coordinatorRpcContract = declareRpcContract(
  "coordinator",
  "events"
);
var COORDINATOR_METHOD_TABLE = {
  getAgentTranscriptTail: { args: "object", reply: "transcript-page" },
  openAgentTail: { args: "object", reply: "transcript-page" },
  sendPrompt: { args: "object", reply: "send-result" },
  promptAcceptanceStatus: { args: "object", reply: "acceptance-lookup" },
  respondToWidget: { args: "object", reply: "record-or-null" },
  resolveAutoReviewApproval: { args: "object", reply: "void" },
  resolveLocalToolPermission: { args: "object", reply: "void" },
  dismissWidget: { args: "object", reply: "record" },
  submitSecret: { args: "object", reply: "void" },
  reactToMessage: { args: "object", reply: "void" },
  listAgents: { args: "none", reply: "array" },
  countAgents: { args: "none", reply: "count" },
  searchAgents: { args: "object", reply: "array" },
  searchMedia: { args: "object", reply: "array" },
  createAgent: { args: "object", reply: "record" },
  createGroup: { args: "object", reply: "record" },
  setGroupMembers: { args: "object", reply: "record-or-null" },
  updateAgent: { args: "object", reply: "record-or-null" },
  deleteAgents: { args: "object", reply: "record" },
  duplicateAgent: { args: "object", reply: "record" },
  kickstartAgent: { args: "object", reply: "record-or-null" },
  requestDiskSaverAudit: { args: "object", reply: "record-or-null" },
  broadcastToAgents: { args: "object", reply: "record" },
  getCloudAgentInfo: { args: "object", reply: "record-or-null" },
  getListenerIntegrations: { args: "none", reply: "record" },
  getListenerConnectUrl: { args: "object", reply: "connect-url" },
  setAgentUnread: { args: "object", reply: "void" },
  setAgentHiddenFromSidebar: { args: "object", reply: "void" },
  setAgentNotificationsEnabled: { args: "object", reply: "void" },
  setAgentNotifyOnUpdates: { args: "object", reply: "void" },
  setAgentAvatarBytes: { args: "object", reply: "record-or-null" },
  getAgentAvatar: { args: "object", reply: "record" },
  getAgentWorkflows: { args: "object", reply: "array" },
  createAgentWorkflow: { args: "object", reply: "array" },
  updateAgentWorkflow: { args: "object", reply: "array" },
  setAgentWorkflowEnabled: { args: "object", reply: "array" },
  deleteAgentWorkflow: { args: "object", reply: "array" },
  runAgentWorkflowNow: { args: "object", reply: "void" },
  importAgentWorkflowText: { args: "object", reply: "import-result" },
  importAgentWorkflowUrl: { args: "object", reply: "import-result" },
  portAgentLocalSkills: { args: "object", reply: "import-result" },
  getConversationOutline: { args: "object", reply: "array" },
  getActiveConversation: { args: "object", reply: "record-or-null" },
  getProviderConfig: { args: "object", reply: "record" },
  skillsCatalog: { args: "none", reply: "array" },
  syncPluginSkills: { args: "none", reply: "array" },
  getPluginSyncStatus: { args: "none", reply: "record" },
  getSkillPublishTargets: { args: "none", reply: "record" },
  publishSkill: { args: "object", reply: "record" },
  resyncPublishedSkill: { args: "object", reply: "record" },
  unpublishSkill: { args: "object", reply: "record" },
  getSubagents: { args: "object", reply: "array" },
  getAsyncTasks: { args: "object", reply: "array" },
  getForeverBoxStatus: { args: "object", reply: "box-status" },
  ensureForeverBox: { args: "object", reply: "box-status" },
  handBackForeverBox: { args: "object", reply: "void" },
  startTeachRecording: { args: "object", reply: "record" },
  stopTeachRecording: { args: "object", reply: "record" },
  getTeachRecordingStatus: { args: "none", reply: "record" },
  getTrays: { args: "none", reply: "array" },
  dismissTray: { args: "object", reply: "void" },
  clearTrays: { args: "none", reply: "void" },
  getAgentChannels: { args: "object", reply: "channels-view" },
  connectChannel: { args: "object", reply: "channels-view" },
  disconnectChannel: { args: "object", reply: "channels-view" },
  refreshChannel: { args: "object", reply: "channels-view" },
  getBoxSecretsStatus: { args: "none", reply: "box-secrets" },
  getAgentAutomations: { args: "object", reply: "array" },
  listAllAutomations: { args: "none", reply: "array" },
  isAgentNetworkEnabled: { args: "none", reply: "boolean" },
  isGlobalSearchEnabled: { args: "none", reply: "boolean" },
  isEgressTunnelAvailable: { args: "none", reply: "boolean" },
  getSharingState: { args: "none", reply: "record" },
  createRoomFromAgent: { args: "object", reply: "record" },
  createRoomInvite: { args: "object", reply: "record" },
  joinSharedRoom: { args: "object", reply: "record" },
  respondToRoomJoinRequest: { args: "object", reply: "record" },
  createSharedRoom: { args: "object", reply: "record" },
  addOwnAgentToSharedRoom: { args: "object", reply: "record" },
  removeOwnAgentFromSharedRoom: { args: "object", reply: "record" },
  setSharedRoomTyping: { args: "object", reply: "void" },
  leaveSharedRoom: { args: "object", reply: "record" },
  setAgentAutomationEnabled: { args: "object", reply: "array" },
  createAgentAutomation: { args: "object", reply: "array" },
  updateAgentAutomation: { args: "object", reply: "array" },
  deleteAgentAutomation: { args: "object", reply: "array" },
  runAgentAutomationNow: { args: "object", reply: "void" }
};
function isCoordinatorMethod(name) {
  return Object.hasOwn(COORDINATOR_METHOD_TABLE, name);
}

// src/node-agent-coordinator/gateway/gateway-request-dispatcher.ts
var GATEWAY_COMMAND_FAILED = "gateway-command-failed";
var GATEWAY_UNREACHABLE = "gateway-unreachable";
var GATEWAY_TRANSPORT_FAILED = "gateway-transport-failed";
function failureFor(error) {
  if (error instanceof SandGatewayCommandError) {
    return { code: GATEWAY_COMMAND_FAILED, message: error.message };
  }
  if (error instanceof SandGatewayUnreachableError) {
    return { code: GATEWAY_UNREACHABLE, message: error.message, transportKind: error.kind };
  }
  return {
    code: GATEWAY_TRANSPORT_FAILED,
    message: error instanceof Error ? error.message : String(error)
  };
}
function createGatewayRequestDispatch(client, serves = isCoordinatorMethod) {
  return async (method, args, signal) => {
    if (!serves(method)) {
      return {
        status: "failed",
        failure: {
          code: COORDINATOR_UNKNOWN_METHOD,
          message: `no coordinator method named ${method}`
        }
      };
    }
    try {
      const value = await client.dispatchCommand(
        method,
        args,
        { signal }
      );
      return { status: "ok", value };
    } catch (error) {
      return { status: "failed", failure: failureFor(error) };
    }
  };
}

// src/node-agent-coordinator/gateway/host-supervisor.ts
var HEALTH_TIMEOUT_MS = 1500;
var HEALTH_PROBE_TTL_MS = 5e3;
var DISABLE_HEALTH_TTL_ENV = "SAND_DISABLE_GATEWAY_HEALTH_TTL";
var DISABLE_STREAM_LIVENESS_ENV = "SAND_DISABLE_GATEWAY_STREAM_LIVENESS";
function createCoordinatorHostSupervisorTiming() {
  return {
    clock: realClock,
    healthProbeDeadline: createDeadlinePolicy2({
      name: "gateway-health-probe",
      timeoutMs: HEALTH_TIMEOUT_MS
    })
  };
}
var GatewayConnectResolveAbandonedError = class extends Error {
  constructor() {
    super("the gateway connection resolve was abandoned before it answered");
    this.name = "GatewayConnectResolveAbandonedError";
  }
};
async function fetchHealth(timing, baseUrl, headers, onReachability) {
  const startMonotonicMs = timing.clock.monotonicNow();
  const report = (r) => {
    try {
      onReachability?.(r, baseUrl);
    } catch {
    }
  };
  try {
    const response = await timing.healthProbeDeadline.run(
      (signal) => fetch(`${baseUrl}${GATEWAY_HEALTH_PATH}`, {
        signal,
        ...headers != null ? { headers: { ...headers } } : {}
      })
    );
    if (!response.ok) {
      report({
        outcome: outcomeForHttpStatus(response.status) ?? "network",
        method: "health",
        latencyMs: timing.clock.monotonicNow() - startMonotonicMs,
        baseUrlKind: classifyBaseUrlKind(baseUrl),
        httpStatus: response.status
      });
      return null;
    }
    const health = await response.json();
    return health.ok === true ? health : null;
  } catch (error) {
    const { outcome, causeSummary } = classifyGatewayFetchFailure(error);
    report({
      outcome,
      method: "health",
      latencyMs: timing.clock.monotonicNow() - startMonotonicMs,
      baseUrlKind: classifyBaseUrlKind(baseUrl),
      causeSummary
    });
    return null;
  }
}
var SandHostSupervisor = class {
  constructor(options) {
    this.options = options;
    this.healthTtlDisabled = process.env[DISABLE_HEALTH_TTL_ENV] === "1";
    this.streamLivenessDisabled = process.env[DISABLE_STREAM_LIVENESS_ENV] === "1";
  }
  options;
  connection;
  lastHealthyAtMs = Number.NEGATIVE_INFINITY;
  healthEpoch = 0;
  latestConnectionAttempt;
  healthTtlDisabled;
  streamLivenessDisabled;
  getOrStartConnectionAttempt(healthEpoch) {
    const currentAttempt = this.latestConnectionAttempt;
    if (currentAttempt != null && currentAttempt.healthEpoch === healthEpoch && currentAttempt.state === "pending" && !currentAttempt.isRetired) {
      return currentAttempt;
    }
    let release = () => {
    };
    const retirement = new Promise((_resolve, reject2) => {
      release = () => reject2(new GatewayConnectResolveAbandonedError());
    });
    void retirement.catch(() => {
    });
    const attempt = {
      healthEpoch,
      promise: this.options.resolveGatewayConnection(),
      state: "pending",
      isRetired: false,
      hasWaiter: false,
      retirement,
      retire: () => {
        if (attempt.isRetired) return;
        attempt.isRetired = true;
        release();
      }
    };
    this.latestConnectionAttempt = attempt;
    const markSettled = () => {
      attempt.state = "settled";
    };
    void attempt.promise.then(markSettled, markSettled);
    return attempt;
  }
  getLatestAttemptForCurrentEpoch() {
    const currentAttempt = this.latestConnectionAttempt;
    if (currentAttempt != null && currentAttempt.healthEpoch === this.healthEpoch && !currentAttempt.isRetired) {
      return currentAttempt;
    }
    return this.getOrStartConnectionAttempt(this.healthEpoch);
  }
  async awaitAttempt(attempt, signal) {
    if (signal == null) {
      attempt.hasWaiter = true;
      return await Promise.race([attempt.promise, attempt.retirement]);
    }
    if (signal.aborted) {
      if (!attempt.hasWaiter) attempt.retire();
      throw new GatewayConnectResolveAbandonedError();
    }
    attempt.hasWaiter = true;
    const onAbort = () => attempt.retire();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([attempt.promise, attempt.retirement]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  invalidateHealthCache() {
    this.healthEpoch += 1;
    this.lastHealthyAtMs = Number.NEGATIVE_INFINITY;
    this.latestConnectionAttempt?.retire();
  }
  async ensureConnection(signal) {
    const cached = this.connection;
    if (cached != null) {
      if (!this.streamLivenessDisabled && this.options.isTransportLive?.() === true) {
        return cached;
      }
      if (!this.healthTtlDisabled && this.options.timing.clock.monotonicNow() - this.lastHealthyAtMs < HEALTH_PROBE_TTL_MS) {
        return cached;
      }
      const epochAtProbe = this.healthEpoch;
      if (await fetchHealth(
        this.options.timing,
        cached.baseUrl,
        cached.headers,
        this.options.onReachability
      ) != null) {
        if (epochAtProbe === this.healthEpoch) {
          this.lastHealthyAtMs = this.options.timing.clock.monotonicNow();
        }
        return cached;
      }
    }
    const epochAtConnect = this.healthEpoch;
    let attempt = this.getOrStartConnectionAttempt(epochAtConnect);
    for (; ; ) {
      try {
        const connection = await this.awaitAttempt(attempt, signal);
        const supersedingAttempt = this.latestConnectionAttempt;
        if (attempt.healthEpoch !== this.healthEpoch) {
          attempt = this.getLatestAttemptForCurrentEpoch();
          continue;
        }
        if (supersedingAttempt !== attempt) {
          if (supersedingAttempt == null) {
            throw new Error("latest gateway connection attempt is missing");
          }
          attempt = supersedingAttempt;
          continue;
        }
        this.connection = connection;
        this.lastHealthyAtMs = Number.NEGATIVE_INFINITY;
        return connection;
      } catch (error) {
        const supersedingAttempt = this.latestConnectionAttempt;
        if (attempt.healthEpoch !== this.healthEpoch) {
          attempt = this.getLatestAttemptForCurrentEpoch();
          continue;
        }
        if (supersedingAttempt === attempt || supersedingAttempt == null) {
          throw error;
        }
        attempt = supersedingAttempt;
      }
    }
  }
};

// src/node-agent-coordinator/local-exec/daemon-files.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");

// src/shared/local-exec-daemon.ts
var LOCAL_EXEC_DAEMON_CONNECTION_FILENAME = "local-exec-daemon-connection.json";
var LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME = "local-exec-daemon.json";
var LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME = "local-exec-daemon-credential.json";
var LOCAL_EXEC_DAEMON_LOG_FILENAME = "local-exec-daemon.log";
var LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME = "local-exec-supervisor.json";

// src/node-agent-coordinator/local-exec/daemon-files.ts
function resolveLocalExecDaemonPaths(dataDir) {
  return {
    connectionPath: (0, import_node_path2.join)(dataDir, LOCAL_EXEC_DAEMON_CONNECTION_FILENAME),
    discoveryPath: (0, import_node_path2.join)(dataDir, LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME),
    credentialPath: (0, import_node_path2.join)(dataDir, LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME),
    logPath: (0, import_node_path2.join)(dataDir, LOCAL_EXEC_DAEMON_LOG_FILENAME),
    supervisorHeartbeatPath: (0, import_node_path2.join)(dataDir, LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME)
  };
}
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}
function isInteger(value) {
  return typeof value === "number" && Number.isInteger(value);
}
function parseDiscovery(value) {
  if (!isRecord2(value)) return null;
  const { pid, startedAt, inflightCount } = value;
  if (!isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== "number" || Number.isNaN(startedAt)) return null;
  if (inflightCount === void 0) return { pid, startedAt };
  if (!isInteger(inflightCount) || inflightCount < 0) return null;
  return { pid, startedAt, inflightCount };
}
function isFileMissing(error) {
  return isRecord2(error) && error.code === "ENOENT";
}
async function readLocalExecDaemonDiscovery(path) {
  let raw;
  try {
    raw = await import_node_fs2.promises.readFile(path, "utf8");
  } catch (error) {
    if (isFileMissing(error)) return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseDiscovery(parsed);
}
async function writeSecretJsonFile(path, data) {
  await import_node_fs2.promises.mkdir((0, import_node_path2.dirname)(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  await import_node_fs2.promises.writeFile(tempPath, JSON.stringify(data), { encoding: "utf8", mode: 384 });
  await import_node_fs2.promises.rename(tempPath, path);
}
function writeLocalExecDaemonConnection(connection, path) {
  return writeSecretJsonFile(path, connection);
}
function writeLocalExecDaemonCredential(credential, path) {
  return writeSecretJsonFile(path, credential);
}
function writeLocalExecSupervisorHeartbeat(path) {
  const heartbeat = { pid: process.pid, at: Date.now() };
  return writeSecretJsonFile(path, heartbeat);
}
async function removeLocalExecDaemonFile(path) {
  try {
    await import_node_fs2.promises.unlink(path);
  } catch (error) {
    if (!isFileMissing(error)) throw error;
  }
}

// src/node-agent-coordinator/local-exec/supervisor.ts
var LOCAL_EXEC_DAEMON_REFRESH_INTERVAL_MS = 3e4;
var LOCAL_EXEC_DAEMON_RESPAWN_LIMIT = 10;
function createLocalExecDaemonRefreshPolicy() {
  return createPollingPolicy2({
    name: "local-exec-daemon-refresh",
    intervalMs: LOCAL_EXEC_DAEMON_REFRESH_INTERVAL_MS
  });
}
function decideLocalExecDaemonAction(existing) {
  if (existing == null) return { kind: "spawn" };
  if ((existing.inflightCount ?? 0) > 0) return { kind: "adopt", pid: existing.pid };
  return { kind: "replace", pid: existing.pid };
}
function failureReason(error) {
  return error instanceof Error ? error.message : String(error);
}
function isClientPauseRefusal(error) {
  return error instanceof Error && error.message.includes(SAND_CLIENT_PAUSE_REASON);
}
function createLocalExecDaemonSupervisor(options) {
  const paths = resolveLocalExecDaemonPaths(options.dataDir);
  let state = { phase: "absent" };
  let started = false;
  let credentialHandedOff = false;
  let disposed = false;
  let polling;
  let refreshSequence = 0;
  let descriptorWrite = Promise.resolve();
  let paused = false;
  let refusedForClientPause = false;
  let pauseIntent = 0;
  let pauseTransition = Promise.resolve();
  const refreshConnection = async () => {
    if (disposed || paused) return;
    const refreshId = ++refreshSequence;
    try {
      const connection = await options.control.resolveGatewayConnection({});
      const write = descriptorWrite.then(async () => {
        if (disposed || refreshId !== refreshSequence) return;
        await writeLocalExecDaemonConnection(connection, paths.connectionPath);
      });
      descriptorWrite = write.then(
        () => void 0,
        () => void 0
      );
      await write;
      await writeLocalExecSupervisorHeartbeat(paths.supervisorHeartbeatPath);
      refusedForClientPause = false;
    } catch (error) {
      if (!isClientPauseRefusal(error)) return;
      refusedForClientPause = true;
      await retireDaemonForPause();
    }
  };
  const refreshCredential = async () => {
    if (credentialHandedOff || disposed || paused) return;
    try {
      const credential = await options.control.mintLocalExecDaemonCredential({});
      if (credential == null || disposed) return;
      await writeLocalExecDaemonCredential(credential, paths.credentialPath);
      credentialHandedOff = true;
    } catch {
    }
  };
  const spawnDaemon = async () => {
    if (paused || refusedForClientPause) return;
    await options.control.spawnLocalExecDaemon({
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        SAND_PACKAGED: options.isPackaged ? "1" : "0"
      },
      logPath: paths.logPath
    });
    state = { phase: "active", daemon: { origin: "spawned" } };
  };
  const queuePauseTransition = async (apply) => {
    const intent = ++pauseIntent;
    const applied = pauseTransition.then(async () => {
      if (disposed || intent !== pauseIntent) return;
      await apply();
    });
    pauseTransition = applied.then(
      () => void 0,
      () => void 0
    );
    await applied;
  };
  const retireDaemonWhileStillPaused = async () => {
    if (paused || refusedForClientPause) await retireDaemonForPause();
  };
  const retireDaemonForPause = async () => {
    refreshSequence += 1;
    try {
      const existing = await readLocalExecDaemonDiscovery(paths.discoveryPath);
      if (existing != null) await options.control.terminateProcess({ pid: existing.pid });
      await removeLocalExecDaemonFile(paths.connectionPath);
      state = { phase: "absent" };
    } catch (error) {
      state = { phase: "failed", reason: failureReason(error) };
    }
  };
  const establishDaemon = async () => {
    if (paused || refusedForClientPause) return;
    try {
      const existing = await readLocalExecDaemonDiscovery(paths.discoveryPath);
      if (disposed) return;
      const action = decideLocalExecDaemonAction(existing);
      if (action.kind === "adopt") {
        state = { phase: "adopting", pid: action.pid };
        const alive = await options.control.isProcessAlive({ pid: action.pid });
        if (disposed) return;
        if (alive) {
          state = { phase: "active", daemon: { origin: "adopted", pid: action.pid } };
          return;
        }
        await spawnDaemon();
        return;
      }
      if (action.kind === "replace") {
        state = { phase: "replacing", pid: action.pid };
        await options.control.terminateProcess({ pid: action.pid });
        if (disposed) return;
      }
      await spawnDaemon();
    } catch (error) {
      state = { phase: "failed", reason: failureReason(error) };
    }
  };
  const probeDaemonForHeal = async () => {
    let discovery;
    try {
      discovery = await readLocalExecDaemonDiscovery(paths.discoveryPath);
    } catch {
      return "unknowable";
    }
    if (discovery == null || disposed) return "unknowable";
    try {
      return await options.control.isProcessAlive({ pid: discovery.pid }) ? "alive" : "dead";
    } catch {
      return "unknowable";
    }
  };
  let consecutiveRespawns = 0;
  const healDaemon = async () => {
    if (paused || refusedForClientPause) {
      if (await probeDaemonForHeal() === "alive") {
        await queuePauseTransition(retireDaemonWhileStillPaused);
      }
      return;
    }
    if (state.phase === "absent") {
      consecutiveRespawns = 0;
      await establishDaemon();
      return;
    }
    const probed = await probeDaemonForHeal();
    if (disposed || probed === "unknowable") return;
    if (probed === "alive") {
      consecutiveRespawns = 0;
      return;
    }
    if (consecutiveRespawns >= LOCAL_EXEC_DAEMON_RESPAWN_LIMIT) {
      state = { phase: "failed", reason: "respawn limit reached" };
      return;
    }
    consecutiveRespawns += 1;
    await establishDaemon();
  };
  return {
    async start() {
      if (started || disposed) return;
      started = true;
      await refreshConnection();
      await refreshCredential();
      if (disposed) return;
      await establishDaemon();
      if (disposed) return;
      let absorbedImmediateTick = false;
      polling = options.refreshPolicy.start(async () => {
        if (!absorbedImmediateTick) {
          absorbedImmediateTick = true;
          return;
        }
        await refreshConnection();
        await refreshCredential();
        await healDaemon();
      });
    },
    refreshConnection,
    async setPaused(next) {
      if (disposed || paused === next) return;
      paused = next;
      await queuePauseTransition(async () => {
        if (next) {
          await retireDaemonForPause();
          return;
        }
        if (!started) return;
        await refreshConnection();
        await refreshCredential();
        await establishDaemon();
      });
    },
    state: () => state,
    dispose() {
      if (disposed) return;
      disposed = true;
      polling?.dispose();
      polling = void 0;
    }
  };
}

// src/shared/errors.ts
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/shared/mcp-oauth-callback-page.ts
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function renderCallbackPage(args) {
  const { title, message, hint } = args;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    "html,body{margin:0;min-height:100%;}",
    'body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0c0c0d;color:#f4f4f5;}',
    ".page{display:flex;min-height:100vh;flex:1;align-items:center;justify-content:center;}",
    ".content{text-align:center;}",
    ".message{font-size:1.125rem;line-height:1.75rem;margin:0;font-weight:400;}",
    ".hint{margin:0.5rem 0 0;font-size:1rem;line-height:1.5rem;color:#a1a1aa;}",
    "</style>",
    "</head>",
    "<body>",
    '<main class="page">',
    '<div class="content">',
    `<p class="message">${escapeHtml(message)}</p>`,
    `<p class="hint">${escapeHtml(hint)}</p>`,
    "</div>",
    "</main>",
    "</body>",
    "</html>"
  ].join("");
}
function renderMcpOAuthSuccessPage(args) {
  const serverName = args?.serverName?.trim();
  const hasName = serverName != null && serverName.length > 0;
  return renderCallbackPage({
    title: hasName ? `${serverName} connected` : "Authentication complete",
    message: "Authorization complete!",
    hint: "You can close this tab."
  });
}
function renderMcpOAuthErrorPage(args) {
  const serverName = args?.serverName?.trim();
  const hasName = serverName != null && serverName.length > 0;
  return renderCallbackPage({
    title: hasName ? `${serverName} \u2014 Authentication failed` : "Authentication failed",
    message: "OAuth callback failed.",
    hint: "Close this tab and try connecting again."
  });
}

// src/node-agent-coordinator/oauth/mcp-oauth-callback-listener.ts
async function startMcpOAuthCallbackListener(args, registry) {
  const redirectUrl = new URL(args.redirectUrl);
  const release = await registry.acquire(redirectUrl, async (requestUrl, _request, response) => {
    if (requestUrl.pathname !== redirectUrl.pathname) {
      return false;
    }
    const state = requestUrl.searchParams.get("state");
    const pending = state != null ? args.resolve(state) : void 0;
    if (state == null || pending == null) {
      return false;
    }
    const serverName = pending.serverName;
    try {
      const error = requestUrl.searchParams.get("error");
      if (error != null) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderMcpOAuthErrorPage({ serverName }));
        return true;
      }
      const code = requestUrl.searchParams.get("code");
      if (code == null || code.length === 0) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderMcpOAuthErrorPage({ serverName }));
        return true;
      }
      await args.onCallback({ code, state });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderMcpOAuthSuccessPage({ serverName }));
      return true;
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderMcpOAuthErrorPage({ serverName }));
      args.log.warn({ kind: "callback-forward-failed", detail: errorMessage(error) });
      return true;
    } finally {
      args.onSettled(state);
    }
  });
  return {
    close() {
      void release();
    }
  };
}

// src/node-agent-coordinator/oauth/mcp-oauth-loopback-registry.ts
var import_node_http = require("node:http");
function closeHttpServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
}
function parseLoopbackRedirect(redirectUrl) {
  if (redirectUrl.protocol !== "http:" || redirectUrl.hostname !== "127.0.0.1" && redirectUrl.hostname !== "localhost") {
    throw new Error("MCP OAuth redirect_uri must be a localhost HTTP URL.");
  }
  const port = Number.parseInt(redirectUrl.port, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("MCP OAuth redirect_uri must include a port.");
  }
  return { port };
}
function loopbackBindHosts(redirectHost) {
  return redirectHost === "localhost" ? ["127.0.0.1", "::1"] : [redirectHost];
}
var McpOAuthLoopbackRegistry = class {
  constructor(log) {
    this.log = log;
  }
  log;
  origins = /* @__PURE__ */ new Map();
  async acquire(redirectUrl, handler) {
    const { port } = parseLoopbackRedirect(redirectUrl);
    const origin = redirectUrl.origin;
    let entryPromise = this.origins.get(origin);
    if (entryPromise == null) {
      entryPromise = this.bindOrigin(origin, port, redirectUrl.hostname);
      this.origins.set(origin, entryPromise);
      const pending = entryPromise;
      void pending.catch(() => {
        if (this.origins.get(origin) === pending) {
          this.origins.delete(origin);
        }
      });
    }
    const entry = await entryPromise;
    entry.handlers.add(handler);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      entry.handlers.delete(handler);
      if (entry.handlers.size === 0) {
        if (this.origins.get(origin) === entryPromise) {
          this.origins.delete(origin);
        }
        await this.closeServers(entry.servers);
      }
    };
  }
  async bindOrigin(origin, port, redirectHost) {
    const servers = [];
    const errors = [];
    for (const host of loopbackBindHosts(redirectHost)) {
      const server = (0, import_node_http.createServer)((request, response) => {
        void this.dispatch(origin, request, response);
      });
      try {
        await new Promise((resolve, reject2) => {
          const onError = (error) => reject2(error);
          server.once("error", onError);
          server.listen(port, host, () => {
            server.off("error", onError);
            resolve();
          });
        });
        servers.push(server);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
        server.close();
      }
    }
    if (servers.length === 0) {
      throw errors[0] ?? new Error(`MCP OAuth loopback callback could not bind port ${port}.`);
    }
    return { servers, handlers: /* @__PURE__ */ new Set() };
  }
  async closeServers(servers) {
    await Promise.all(servers.filter((server) => server.listening).map(closeHttpServer));
  }
  async dispose() {
    const entryPromises = [...this.origins.values()];
    this.origins.clear();
    for (const entryPromise of entryPromises) {
      try {
        const entry = await entryPromise;
        entry.handlers.clear();
        await this.closeServers(entry.servers);
      } catch {
      }
    }
  }
  async dispatch(origin, request, response) {
    const entryPromise = this.origins.get(origin);
    if (entryPromise == null) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    let entry;
    try {
      entry = await entryPromise;
    } catch {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? "/", origin);
    } catch {
      response.writeHead(400);
      response.end("Bad request");
      return;
    }
    for (const handler of [...entry.handlers]) {
      try {
        if (await handler(requestUrl, request, response)) {
          return;
        }
      } catch (error) {
        this.log.warn({ kind: "callback-handler-failed", detail: errorMessage(error) });
        if (response.headersSent) return;
      }
    }
    if (!response.headersSent) {
      response.writeHead(404);
      response.end("Not found");
    }
  }
};

// src/node-agent-coordinator/oauth/mcp-oauth-forwarder.ts
var MCP_OAUTH_PENDING_TTL_MS = 11 * 60 * 1e3;
function expiryKey(origin, state) {
  return JSON.stringify([origin, state]);
}
var OAuthPendingRegistry = class {
  byOrigin = /* @__PURE__ */ new Map();
  add(origin, state, auth) {
    let states = this.byOrigin.get(origin);
    if (states == null) {
      states = /* @__PURE__ */ new Map();
      this.byOrigin.set(origin, states);
    }
    states.set(state, auth);
  }
  resolve(origin, state) {
    return this.byOrigin.get(origin)?.get(state)?.serverName;
  }
  remove(origin, state) {
    const states = this.byOrigin.get(origin);
    const auth = states?.get(state);
    if (states == null || auth == null) return void 0;
    states.delete(state);
    if (states.size === 0) this.byOrigin.delete(origin);
    return auth;
  }
  removeServer(serverName) {
    const removed = [];
    for (const [origin, states] of [...this.byOrigin]) {
      for (const [state, auth] of [...states]) {
        if (auth.serverName !== serverName) continue;
        states.delete(state);
        removed.push(auth);
      }
      if (states.size === 0) this.byOrigin.delete(origin);
    }
    return removed;
  }
  removeAll() {
    const removed = [...this.byOrigin.values()].flatMap((states) => [...states.values()]);
    this.byOrigin.clear();
    return removed;
  }
  hasPendingFor(origin) {
    return this.byOrigin.has(origin);
  }
};
var McpOAuthForwarder = class {
  listeners = /* @__PURE__ */ new Map();
  pending = new OAuthPendingRegistry();
  loopbackPool;
  subscription;
  completion;
  log;
  pendingExpiry;
  startListener;
  constructor(deps) {
    this.completion = deps.completion;
    this.log = deps.log;
    this.pendingExpiry = deps.pendingExpiry ?? createExpiryPolicy2({ name: "mcp-oauth-pending", ttlMs: MCP_OAUTH_PENDING_TTL_MS });
    this.startListener = deps.startListener ?? startMcpOAuthCallbackListener;
    this.loopbackPool = new McpOAuthLoopbackRegistry(deps.log);
    this.subscription = deps.pendingEvents.subscribe((pending) => {
      void this.handlePending(pending);
    });
  }
  async handlePending(payload) {
    let origin;
    try {
      origin = new URL(payload.redirectUrl).origin;
    } catch (error) {
      this.log.warn({
        kind: "invalid-redirect-url",
        serverName: payload.serverName,
        detail: errorMessage(error)
      });
      return;
    }
    this.track(origin, payload.state, payload.serverName);
    if (this.listeners.has(origin)) return;
    try {
      const listener = await this.startListener(
        {
          redirectUrl: payload.redirectUrl,
          resolve: (state) => {
            const serverName = this.pending.resolve(origin, state);
            return serverName != null ? { serverName } : void 0;
          },
          onCallback: async ({ code, state }) => {
            await this.completion.completeMcpOAuth({ code, state });
          },
          onSettled: (state) => {
            this.forget(origin, state);
          },
          log: this.log
        },
        this.loopbackPool
      );
      if (this.listeners.has(origin)) {
        listener.close();
      } else {
        this.listeners.set(origin, listener);
        this.closeDrainedListeners();
      }
    } catch (error) {
      this.forget(origin, payload.state);
      this.log.warn({
        kind: "listener-start-failed",
        serverName: payload.serverName,
        detail: errorMessage(error)
      });
    }
  }
  dispose() {
    this.subscription.dispose();
    for (const listener of this.listeners.values()) {
      listener.close();
    }
    this.listeners.clear();
    for (const auth of this.pending.removeAll()) {
      auth.expiry.dispose();
    }
    void this.loopbackPool.dispose();
  }
  track(origin, state, serverName) {
    const superseded = this.pending.removeServer(serverName);
    for (const auth of superseded) auth.expiry.dispose();
    this.pending.remove(origin, state)?.expiry.dispose();
    const expiry = this.pendingExpiry.arm(expiryKey(origin, state), () => {
      this.forget(origin, state);
    });
    this.pending.add(origin, state, { serverName, expiry });
    this.closeDrainedListeners();
  }
  forget(origin, state) {
    const auth = this.pending.remove(origin, state);
    if (auth == null) return;
    auth.expiry.dispose();
    this.closeDrainedListeners();
  }
  closeDrainedListeners() {
    for (const [origin, listener] of [...this.listeners]) {
      if (this.pending.hasPendingFor(origin)) continue;
      listener.close();
      this.listeners.delete(origin);
    }
  }
};

// src/node-agent-coordinator/renderer-port-server.ts
function createRendererPortServer(port, options = {}) {
  let phase = "awaiting-hello";
  let resolveSettled = () => {
  };
  const settled = new Promise((resolve) => {
    resolveSettled = resolve;
  });
  const inFlight = /* @__PURE__ */ new Map();
  const settle = (settlement) => {
    if (phase === "settled") return;
    phase = "settled";
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
    port.close();
    resolveSettled(settlement);
  };
  const breach = (detail) => {
    if (phase === "settled") return;
    port.post({ kind: "lifecycle", phase: "shutdown", reason: "protocol-error", detail });
    settle({ outcome: "protocol-breach", detail });
  };
  const reply = (requestId, outcome) => {
    port.post({ kind: "reply", requestId, outcome });
  };
  const dispatchRequest = (requestId, method, args) => {
    const dispatch = options.dispatchRequest;
    if (dispatch == null) {
      reply(requestId, {
        status: "failed",
        failure: {
          code: COORDINATOR_UNKNOWN_METHOD,
          message: "no method table serves this session yet"
        }
      });
      return;
    }
    const controller = new AbortController();
    inFlight.set(requestId, controller);
    void dispatch(method, args, controller.signal).then(
      (outcome) => {
        if (phase !== "serving" || inFlight.get(requestId) !== controller) return;
        inFlight.delete(requestId);
        reply(requestId, outcome);
      },
      () => {
        breach(`request ${requestId} dispatch rejected instead of settling`);
      }
    );
  };
  const handleFrame = (frame) => {
    if (frame.kind === "lifecycle" && frame.phase === "shutdown") {
      settle({ outcome: "shutdown-requested" });
      return;
    }
    if (frame.kind === "reply" || frame.kind === "event") {
      breach(`client posted a server-direction ${frame.kind} frame`);
      return;
    }
    if (frame.kind === "lifecycle" && frame.phase === "ready") {
      breach("client posted a server-direction ready frame");
      return;
    }
    if (phase === "awaiting-hello") {
      if (frame.kind !== "lifecycle") {
        breach(`${frame.kind} frame before hello`);
        return;
      }
      if (frame.protocolVersion !== COORDINATOR_PROTOCOL_VERSION) {
        breach(
          `hello.protocolVersion ${frame.protocolVersion} is not the supported ${COORDINATOR_PROTOCOL_VERSION}`
        );
        return;
      }
      phase = "serving";
      port.post({
        kind: "lifecycle",
        phase: "ready",
        protocolVersion: COORDINATOR_PROTOCOL_VERSION
      });
      options.onServing?.();
      return;
    }
    if (frame.kind === "lifecycle") {
      breach("hello repeated on a live session");
      return;
    }
    if (frame.kind === "request") {
      if (inFlight.has(frame.requestId)) {
        breach(`request.requestId ${frame.requestId} reused while in flight`);
        return;
      }
      dispatchRequest(frame.requestId, frame.method, frame.args);
      return;
    }
    const controller = inFlight.get(frame.requestId);
    if (controller == null) return;
    inFlight.delete(frame.requestId);
    controller.abort();
    reply(frame.requestId, {
      status: "failed",
      failure: { code: COORDINATOR_CANCELLED, message: "request cancelled" }
    });
  };
  return {
    handleMessage(value) {
      if (phase === "settled") return;
      const intake = parseCoordinatorFrame(value);
      if (!intake.accepted) {
        breach(intake.rejection.detail);
        return;
      }
      handleFrame(intake.frame);
    },
    handlePortClosed() {
      settle({ outcome: "port-closed" });
    },
    postEvent(family, payload) {
      if (phase !== "serving") return;
      port.post({ kind: "event", family, payload });
    },
    settled
  };
}

// src/node-agent-coordinator/telemetry/transport-stage-recorder.ts
var SSE_ECHO_STAGE = "echo-coordinator-sse";
var MAX_IN_FLIGHT_TRANSPORT_REPORTS = 64;
var PENDING_SEND_ECHO_MAX = 64;
var PENDING_SEND_ECHO_TTL_MS = 12e4;
var INERT_STAGE = {
  complete() {
  },
  fail() {
  }
};
var INERT_TRACE = {
  beginStage: () => INERT_STAGE,
  markStage() {
  }
};
function sendKeyOf(key) {
  return `${key.accountSlot}\0${key.clientNonce}`;
}
function createTransportStageRecorder(options) {
  const { clock, egress } = options;
  let inFlightReports = 0;
  const forward = (dispatch) => {
    if (inFlightReports >= MAX_IN_FLIGHT_TRANSPORT_REPORTS) return;
    inFlightReports += 1;
    const settle = () => {
      inFlightReports -= 1;
    };
    try {
      void dispatch().then(settle, settle);
    } catch {
      settle();
    }
  };
  const forwardStage = (report) => {
    forward(() => egress.reportTransportStage(report));
  };
  const pendingEchoes = /* @__PURE__ */ new Map();
  const armEcho = (key, traceparent) => {
    const nowMonotonicMs = clock.monotonicNow();
    for (const [armedKey, pending] of pendingEchoes) {
      if (nowMonotonicMs - pending.armedAtMonotonicMs > PENDING_SEND_ECHO_TTL_MS) {
        pendingEchoes.delete(armedKey);
      }
    }
    if (pendingEchoes.size >= PENDING_SEND_ECHO_MAX) {
      const oldest = pendingEchoes.keys().next().value;
      if (oldest !== void 0) pendingEchoes.delete(oldest);
    }
    pendingEchoes.set(sendKeyOf(key), { traceparent, armedAtMonotonicMs: nowMonotonicMs });
  };
  return {
    beginSend(identity) {
      const { accountSlot, clientNonce, traceparent } = identity;
      if (clientNonce == null || clientNonce === "") return INERT_TRACE;
      const sampledTraceparent = traceparent == null || traceparent === "" ? null : traceparent;
      if (sampledTraceparent != null) {
        armEcho({ accountSlot, clientNonce }, sampledTraceparent);
      }
      return {
        beginStage(stage, attempt) {
          const startEpochMs = clock.now();
          const startMonotonicMs = clock.monotonicNow();
          let settled = false;
          const settle = (isError) => {
            if (settled) return;
            settled = true;
            forwardStage({
              accountSlot,
              clientNonce,
              stage,
              attempt,
              traceparent: sampledTraceparent,
              startEpochMs,
              durationMs: clock.monotonicNow() - startMonotonicMs,
              isError
            });
          };
          return {
            complete: () => settle(false),
            fail: () => settle(true)
          };
        },
        markStage(stage, attempt) {
          forwardStage({
            accountSlot,
            clientNonce,
            stage,
            attempt,
            traceparent: sampledTraceparent,
            startEpochMs: clock.now(),
            durationMs: 0,
            isError: false
          });
        }
      };
    },
    recordSendEcho(key) {
      const armedKey = sendKeyOf(key);
      const pending = pendingEchoes.get(armedKey);
      if (pending == null) return;
      pendingEchoes.delete(armedKey);
      forwardStage({
        accountSlot: key.accountSlot,
        clientNonce: key.clientNonce,
        stage: SSE_ECHO_STAGE,
        attempt: 0,
        traceparent: pending.traceparent,
        startEpochMs: clock.now(),
        durationMs: 0,
        isError: false
      });
    },
    recordTransportStage(report) {
      forwardStage(report);
    },
    recordGatewayCommandSpan(report) {
      forward(() => egress.reportGatewayCommandSpan(report));
    },
    recordGatewayReachability(report) {
      forward(() => egress.reportGatewayReachability(report));
    },
    recordGatewayDnsDiagnostic(report) {
      forward(() => egress.reportGatewayDnsDiagnostic(report));
    }
  };
}

// src/node-agent-coordinator/main.ts
function createWebAuthnReconnectPolicy() {
  return createRetryPolicy2({
    name: "sand-webauthn-reconnect",
    maxAttempts: Number.MAX_SAFE_INTEGER,
    initialDelayMs: 1e3,
    maxDelayMs: 3e4
  });
}
async function composeCoordinator() {
  const carrierIntake = await adoptCarrier();
  if (!carrierIntake.adopted) {
    process.stderr.write(`node-agent-coordinator: ${carrierIntake.rejection.detail}
`);
    process.exit(2);
  }
  const carrier = carrierIntake.carrier;
  const bootstrap = carrier.bootstrap;
  const controlClient = createControlPortClient({
    post: (frame) => carrier.control.post(frame),
    close: () => carrier.control.close()
  });
  const recorder = createTransportStageRecorder({
    clock: realClock,
    egress: controlClient.commands
  });
  const dnsDiagnostics = createGatewayDnsDiagnosticReporter(
    (report) => recorder.recordGatewayDnsDiagnostic(report)
  );
  const reportReachability = (report, baseUrl) => {
    recorder.recordGatewayReachability(report);
    dnsDiagnostics.observe(report, baseUrl);
  };
  let isGatewayStreamLive = false;
  const hostSupervisor = new SandHostSupervisor({
    resolveGatewayConnection: () => controlClient.commands.resolveGatewayConnection({}),
    timing: createCoordinatorHostSupervisorTiming(),
    isTransportLive: () => isGatewayStreamLive,
    onReachability: reportReachability
  });
  const oauthPendingHandlers = /* @__PURE__ */ new Set();
  function asMcpOAuthPending(payload) {
    if (typeof payload !== "object" || payload == null) return null;
    const { serverName, redirectUrl, state } = payload;
    if (typeof serverName !== "string" || serverName.length === 0) return null;
    if (typeof redirectUrl !== "string" || redirectUrl.length === 0) return null;
    if (typeof state !== "string" || state.length === 0) return null;
    return { serverName, redirectUrl, state };
  }
  function recordEchoIfUserEcho(payload) {
    if (typeof payload !== "object" || payload == null) return;
    const event = payload;
    if (event.type !== "appended") return;
    const entry = event.entry;
    if (typeof entry?.clientNonce !== "string" || entry.clientNonce.length === 0) return;
    const isUserEcho = entry.kind === "message" && entry.role === "user" || entry.kind === "user-attachment";
    if (!isUserEcho) return;
    recorder.recordSendEcho({ accountSlot: HOST_ACCOUNT_SLOT, clientNonce: entry.clientNonce });
  }
  const activeConversationByAgent = /* @__PURE__ */ new Map();
  const knownAgentIds = /* @__PURE__ */ new Set();
  const transcriptSnapshotGate = createTranscriptSnapshotGate();
  let transcriptAdapter;
  let dispatchGatewayCommand = async () => {
    throw new Error("gateway dispatch is not ready");
  };
  function transcriptAgentId(payload) {
    if (typeof payload !== "object" || payload == null) return;
    const agentId = payload.agentId ?? payload.activeAgentId;
    return typeof agentId === "string" && agentId.length > 0 ? agentId : void 0;
  }
  function disposeTranscriptAgent(agentId) {
    transcriptAdapter?.disposeAgent(agentId);
    transcriptSnapshotGate.disposeAgent(agentId);
    activeConversationByAgent.delete(agentId);
    knownAgentIds.delete(agentId);
  }
  function observeAgentsRoster(payload) {
    if (typeof payload !== "object" || payload == null || !Array.isArray(payload.agents)) return;
    const currentIds = new Set(payload.agents.flatMap((agent) => typeof agent?.id === "string" && agent.id.length > 0 ? [agent.id] : []));
    for (const knownAgentId of knownAgentIds) {
      if (!currentIds.has(knownAgentId)) disposeTranscriptAgent(knownAgentId);
    }
    knownAgentIds.clear();
    for (const agentId of currentIds) knownAgentIds.add(agentId);
  }
  function shouldForwardTranscript(payload) {
    if (typeof payload !== "object" || payload == null) return true;
    if (payload.type === "resync" || payload.resyncRequired === true && payload.type !== "snapshot") return false;
    const agentId = transcriptAgentId(payload);
    const conversationId = payload.conversationId;
    if (agentId == null) return true;
    const hasConversation = typeof conversationId === "string" && conversationId.length > 0;
    const active = activeConversationByAgent.get(agentId);
    if (!hasConversation) return active === void 0;
    if (payload.type === "snapshot") {
      if (active !== void 0 && active !== conversationId && payload.ordered === void 0) return false;
      activeConversationByAgent.set(agentId, conversationId);
      transcriptSnapshotGate.begin(agentId, conversationId);
      return true;
    }
    if (active === void 0) {
      activeConversationByAgent.set(agentId, conversationId);
      return true;
    }
    return active === conversationId;
  }
  function beginTranscriptSnapshot(agentId, conversationId) {
    const request = transcriptSnapshotGate.begin(agentId, conversationId);
    if (typeof conversationId === "string" && conversationId.length > 0) activeConversationByAgent.set(agentId, conversationId);
    return request;
  }
  async function publishTranscriptSnapshot(agentId, conversationId, request = beginTranscriptSnapshot(agentId, conversationId)) {
    const page = await dispatchGatewayCommand("getAgentTranscriptTail", {
      agentId,
      limit: 500,
      authoritativeResync: true,
      ...typeof conversationId === "string" && conversationId.length > 0 ? { conversationId } : {}
    });
    if (!transcriptSnapshotGate.isCurrent(request)) return false;
    const active = activeConversationByAgent.get(agentId);
    if (typeof conversationId === "string" && conversationId.length > 0 && active !== void 0 && active !== conversationId) return false;
    const entries = Array.isArray(page?.entries) ? page.entries : [];
    const snapshotPayload = {
      type: "snapshot",
      agentId,
      activeAgentId: agentId,
      ...typeof conversationId === "string" && conversationId.length > 0 ? { conversationId } : {},
      entries,
      ...page?.nextBeforeSeq !== void 0 ? { truncated: true, method: "openAgentTail" } : {}
    };
    if (transcriptAdapter) transcriptAdapter.reset(snapshotPayload, { allowConversationSwitch: true });
    else server.postEvent("transcript", snapshotPayload);
    return true;
  }
  function handleTranscriptResync(payload) {
    const agentId = transcriptAgentId(payload);
    if (agentId == null) return;
    transcriptAdapter?.markResync(payload, payload?.reason ?? "server-resync");
    const conversationId = typeof payload?.conversationId === "string" ? payload.conversationId : activeConversationByAgent.get(agentId);
    const request = beginTranscriptSnapshot(agentId, conversationId);
    void publishTranscriptSnapshot(agentId, conversationId, request).catch(() => {
    });
  }
  transcriptAdapter = createTranscriptAdapter({
    onEmit: (payload) => server.postEvent("transcript", payload),
    onResync: (payload) => handleTranscriptResync(payload),
    coalesce: true
  });
  async function seedActiveTranscript() {
    try {
      const config = await dispatchGatewayCommand("getProviderConfig", {});
      const agentId = typeof config?.agentId === "string" ? config.agentId : void 0;
      if (agentId == null) return;
      let conversationId = activeConversationByAgent.get(agentId);
      if (conversationId == null) {
        const active = await dispatchGatewayCommand("getActiveConversation", { agentId }).catch(() => null);
        conversationId = typeof active?.id === "string" ? active.id : void 0;
      }
      const request = beginTranscriptSnapshot(agentId, conversationId);
      await publishTranscriptSnapshot(agentId, conversationId, request);
    } catch {
    }
  }
  function handleGatewaySseEvent(event) {
    if (event.channel === "mcp-oauth-pending") {
      const pending = asMcpOAuthPending(event.payload);
      if (pending == null) return;
      for (const handler of oauthPendingHandlers) handler(pending);
      return;
    }
    if (event.channel === "transcript") {
      recordEchoIfUserEcho(event.payload);
      if (event.payload?.type === "snapshot" && event.payload?.resyncRequired === true && event.payload?.ordered === void 0) {
        transcriptAdapter.markResync(event.payload, event.payload?.reason ?? "server-resync");
        handleTranscriptResync(event.payload);
        return;
      }
      if (event.payload?.type === "resync" || event.payload?.resyncRequired === true && event.payload?.type !== "snapshot") {
        transcriptAdapter.markResync(event.payload, event.payload?.reason ?? "server-resync");
        handleTranscriptResync(event.payload);
        return;
      }
      if (!shouldForwardTranscript(event.payload)) return;
      transcriptAdapter.accept(event.payload);
      return;
    }
    if (event.channel === "agents") {
      observeAgentsRoster(event.payload);
      controlClient.postEvent("agents-event", {
        kind: "agents",
        event: event.payload
      });
    }
    if (event.channel === "agent-upserted") {
      const upsertedAgentId = typeof event.payload?.id === "string" ? event.payload.id : typeof event.payload?.agent?.id === "string" ? event.payload.agent.id : void 0;
      if (upsertedAgentId !== void 0) knownAgentIds.add(upsertedAgentId);
      controlClient.postEvent("agents-event", {
        kind: "agent-upserted",
        event: event.payload
      });
    }
    const family = coordinatorEventFamilyForSseChannel(event.channel);
    if (family == null) return;
    server.postEvent(family, event.payload);
  }
  async function seedAgentsRosterToMain() {
    try {
      const agents = await gatewayClient.dispatchCommand("listAgents", {});
      observeAgentsRoster({ agents });
      controlClient.postEvent("agents-roster-seed", { agents });
    } catch (error) {
      process.stderr.write(
        `node-agent-coordinator: agents roster seed skipped: ${String(error)}
`
      );
    }
  }
  function handleTransportEvent(event) {
    controlClient.postEvent(event.family, event.payload);
    if (event.family === "transport-down") {
      isGatewayStreamLive = false;
      hostSupervisor.invalidateHealthCache();
      server.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "down" });
      return;
    }
    isGatewayStreamLive = true;
    void localExecSupervisor.refreshConnection();
    void seedAgentsRosterToMain();
    void seedActiveTranscript();
    server.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "connected" });
  }
  const gatewayTiming = createCoordinatorGatewayClientTiming();
  const gatewayClient = new CoordinatorGatewayClient({
    resolveConnection: (signal) => hostSupervisor.ensureConnection(signal),
    onEvent: handleGatewaySseEvent,
    onTransportEvent: handleTransportEvent,
    onTransportRetry: () => hostSupervisor.invalidateHealthCache(),
    recordTransportStage: (report) => recorder.recordTransportStage(report),
    onReachability: reportReachability,
    resolveTraceWindowTraceparent: () => controlClient.commands.getRpcTraceWindowTraceparent({}),
    recordGatewayCommandSpan: (report) => recorder.recordGatewayCommandSpan(report),
    timing: gatewayTiming
  });
  dispatchGatewayCommand = (method, args) => gatewayClient.dispatchCommand(method, args);
  const oauthForwarder = new McpOAuthForwarder({
    pendingEvents: {
      subscribe(handler) {
        oauthPendingHandlers.add(handler);
        return {
          dispose() {
            oauthPendingHandlers.delete(handler);
          }
        };
      }
    },
    completion: {
      completeMcpOAuth: (args) => gatewayClient.dispatchLegacyCommand("completeMcpOAuth", args)
    },
    log: {
      warn(warning) {
        process.stderr.write(`node-agent-coordinator: mcp-oauth ${JSON.stringify(warning)}
`);
      }
    }
  });
  const localExecSupervisor = createLocalExecDaemonSupervisor({
    control: controlClient.commands,
    dataDir: bootstrap.processConfig.dataDir,
    isPackaged: bootstrap.processConfig.isPackaged,
    refreshPolicy: createLocalExecDaemonRefreshPolicy()
  });
  let webauthnProvider;
  const webauthnSignerPath = resolveWebAuthnSignerPath({
    isPackaged: bootstrap.processConfig.isPackaged
  });
  if (webauthnSignerPath !== void 0) {
    const reportWebAuthnProgress = (status) => {
      void controlClient.commands.updateWebAuthnConsent({ status });
    };
    webauthnProvider = createWebAuthnProvider({
      resolveConnection: () => controlClient.commands.resolveGatewayConnection({}),
      consent: {
        requestConsent: async (ceremony) => {
          const options = JSON.parse(ceremony.optionsJson);
          return await controlClient.commands.requestWebAuthnConsent({
            origin: ceremony.origin,
            rpId: options.rpId ?? options.rp?.id ?? ceremony.origin
          });
        },
        reportProgress: reportWebAuthnProgress,
        finish: () => {
          void controlClient.commands.finishWebAuthnConsent({});
        }
      },
      signer: createSpawnedWebAuthnSigner({
        binaryPath: webauthnSignerPath,
        onStatus: reportWebAuthnProgress,
        onPinRequest: async (request, promptId) => {
          const { pin } = await controlClient.commands.requestWebAuthnPin({
            promptId,
            invalid: request.invalid,
            ...request.retries === void 0 ? {} : { retries: request.retries }
          });
          return pin ?? void 0;
        }
      }),
      heartbeatPolicy: createPollingPolicy2({
        name: "sand-webauthn-heartbeat",
        intervalMs: SAND_WEBAUTHN_HEARTBEAT_INTERVAL_MS
      }),
      reconnectPolicy: createWebAuthnReconnectPolicy(),
      deliveryPolicy: createRetryPolicy2({
        name: "sand-webauthn-delivery",
        maxAttempts: 5,
        initialDelayMs: 250,
        maxDelayMs: 4e3
      }),
      label: (0, import_node_os.hostname)()
    });
    webauthnProvider.start();
  }
  const gatewayDispatch = createGatewayRequestDispatch(gatewayClient);
  const dispatchRequest = async (method, args, signal) => {
    if (method === "sendPrompt" && typeof args === "object" && args != null) {
      const { clientNonce, traceparent } = args;
      recorder.beginSend({
        accountSlot: HOST_ACCOUNT_SLOT,
        clientNonce: typeof clientNonce === "string" ? clientNonce : null,
        traceparent: typeof traceparent === "string" ? traceparent : null
      });
    }
    const result = await gatewayDispatch(method, args, signal);
    if (result.status === "ok" && (method === "getAgentTranscriptTail" || method === "openAgentTail")) {
      return { ...result, value: projectTranscriptForRenderer(result.value) };
    }
    return result;
  };
  const server = createRendererPortServer(
    {
      post: (frame) => carrier.data.post(frame),
      close: () => carrier.data.close()
    },
    {
      dispatchRequest,
      onServing: () => {
        if (isGatewayStreamLive) return;
        server.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "down" });
      }
    }
  );
  const mainDispatch = createGatewayRequestDispatch(gatewayClient, isCoordinatorMainMethod);
  const applyPauseToOwnersHoldingTheirOwnBoxConnection = (isPaused) => {
    void localExecSupervisor.setPaused(isPaused);
    if (isPaused) webauthnProvider?.stop();
    else webauthnProvider?.start();
  };
  const dispatchMainRequest = (method, args, signal) => {
    if (method === "setGatewayPaused" && typeof args === "object" && args != null) {
      const { paused } = args;
      applyPauseToOwnersHoldingTheirOwnBoxConnection(paused === true);
    }
    return mainDispatch(method, args, signal);
  };
  const mainServer = createRendererPortServer(
    {
      post: (frame) => carrier.mainData.post(frame),
      close: () => carrier.mainData.close()
    },
    { dispatchRequest: dispatchMainRequest }
  );
  let exitSettled = false;
  function settleProcess(exitCode) {
    if (exitSettled) return;
    exitSettled = true;
    gatewayClient.close();
    localExecSupervisor.dispose();
    oauthForwarder.dispose();
    controlClient.shutdown();
    server.handlePortClosed();
    mainServer.handlePortClosed();
    carrier.control.close();
    carrier.data.close();
    carrier.mainData.close();
    carrier.exitProcess(exitCode);
  }
  void server.settled.then((settlement) => {
    if (settlement.outcome === "protocol-breach") {
      process.stderr.write(`node-agent-coordinator: protocol breach: ${settlement.detail}
`);
      settleProcess(1);
      return;
    }
    settleProcess(0);
  });
  void mainServer.settled.then((settlement) => {
    if (settlement.outcome === "protocol-breach") {
      process.stderr.write(
        `node-agent-coordinator: main-data protocol breach: ${settlement.detail}
`
      );
      settleProcess(1);
      return;
    }
    settleProcess(0);
  });
  void controlClient.settled.then((settlement) => {
    if (settlement.outcome === "protocol-breach") {
      process.stderr.write(
        `node-agent-coordinator: control protocol breach: ${settlement.detail}
`
      );
      settleProcess(1);
      return;
    }
    settleProcess(0);
  });
  const settleOnCrash = (kind, value) => {
    const error = value instanceof Error ? value : new Error(String(value));
    process.stderr.write(`node-agent-coordinator: ${kind}: ${error.stack ?? String(error)}
`);
    void controlClient.commands.reportProcessCrash({
      kind,
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack ?? null
    }).catch((reportError) => {
      process.stderr.write(
        `node-agent-coordinator: crash report undelivered: ${String(reportError)}
`
      );
    });
    settleProcess(1);
  };
  process.on("uncaughtException", (value) => settleOnCrash("uncaughtException", value));
  process.on("unhandledRejection", (value) => settleOnCrash("unhandledRejection", value));
  carrier.bind({
    onControlFrame: (frame) => controlClient.handleMessage(frame),
    onDataFrame: (value) => server.handleMessage(value),
    onMainDataFrame: (value) => mainServer.handleMessage(value),
    onClosed: () => {
      controlClient.handlePortClosed();
      server.handlePortClosed();
      mainServer.handlePortClosed();
    }
  });
  void localExecSupervisor.start();
  gatewayClient.start();
}
composeCoordinator().catch((error) => {
  process.stderr.write(`node-agent-coordinator: composition failure: ${String(error)}
`);
  process.exit(1);
});
//# sourceMappingURL=main.cjs.map
