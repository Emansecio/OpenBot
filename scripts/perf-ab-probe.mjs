// A/B probe: counts config.snapshot() calls during a full streaming turn.
import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "openbot-ab-"));
process.env.NODE_ENV = "test";
const { startServer, stopServer } = await import("../dist/main.js");

const handle = await startServer(0, {
  configPath: join(dir, "cfg.json"),
  storePath: join(dir, "store.db"),
  keystoreDir: join(dir, "ks"),
  stateRoot: dir,
  workspacesRoot: join(dir, "ws"),
  runtimeRoot: join(dir, "rt"),
  browserRoot: join(dir, "br"),
  disableAgentHome: true,
  sharedIntegrationsEnabled: false,
});

let snapCount = 0;
const orig = handle.config.snapshot.bind(handle.config);
handle.config.snapshot = () => { snapCount++; return orig(); };

const { defaultRegistry } = await import("../dist/providers/router.js");
defaultRegistry.register({
  name: "benchfake",
  async streamChat(_req, emit) {
    for (let i = 0; i < 200; i++) {
      emit({ type: "delta", delta: "chunk-" + i + " " });
      await new Promise((r) => setImmediate(r));
    }
  },
});

const token = handle.gatewayToken;
const port = handle.port;
async function rpc(method, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

// configure default agent to use openai-compat (custom provider path) — but
// config validation restricts provider kinds, so keep the default provider
// and instead measure the publish path directly: the snapshot() calls we
// optimized happen in agentPeer/humanAuthor during entry publication.
snapCount = 0;
const t0 = performance.now();
const ack = await rpc("sendPrompt", { agentId: "openbot-default", prompt: "hello bench", clientNonce: "ab-nonce-1" });
console.error("ACK:", JSON.stringify(ack));
// wait for turn completion by polling transcript for non-streaming assistant
let finalEntry = null;
for (let i = 0; i < 5000; i++) {
  const entries = handle.store.getEntries("openbot-default");
  const a = [...entries].reverse().find((e) => e.kind === "message" && e.role === "assistant" && e.streaming !== true);
  if (a && entries.some((e) => e.kind === "message" && e.role === "user")) { finalEntry = a; break; }
  await new Promise((r) => setImmediate(r));
}
const wallMs = performance.now() - t0;

console.log(JSON.stringify({
  accepted: ack?.accepted === true,
  gotAssistant: Boolean(finalEntry),
  snapshotCallsDuringTurn: snapCount,
  turnWallMs: +wallMs.toFixed(1),
}));

await stopServer(handle);
await rm(dir, { recursive: true, force: true });
process.exit(0);
