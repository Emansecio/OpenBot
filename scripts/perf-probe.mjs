// Baseline measurement harness — measures startup + hot-path costs with isolated data root.
// Usage: node scripts/perf-probe.mjs [cold|warm|hotpath] [iterations]
import { performance } from "node:perf_hooks";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2] ?? "hotpath";
const ITER = Number(process.argv[3] ?? 5);
const ownsDataRoot = !process.env.OPENBOT_DATA_ROOT;
const dataRoot = process.env.OPENBOT_DATA_ROOT || join(tmpdir(), "openbot-perf-" + Date.now());

process.env.NODE_ENV = "test";
process.env.OPENBOT_DATA_ROOT = dataRoot;
await mkdir(dataRoot, { recursive: true });

let stopServerForCleanup = null;
let activeHandle = null;

try {
  const { startServer, stopServer } = await import("../dist/main.js");
  stopServerForCleanup = stopServer;

  async function measureStartup(label) {
    const t0 = performance.now();
    const handle = await startServer(0, {
      configPath: join(dataRoot, "openbot-config.json"),
      storePath: join(dataRoot, "store.db"),
      keystoreDir: join(dataRoot, "keystore"),
      stateRoot: dataRoot,
      workspacesRoot: join(dataRoot, "workspaces"),
      runtimeRoot: join(dataRoot, "runtime"),
      browserRoot: join(dataRoot, "browser"),
      disableAgentHome: true,
      sharedIntegrationsEnabled: false,
    });
    activeHandle = handle;
    return { handle, ms: performance.now() - t0, label };
  }

  if (mode === "cold" || mode === "warm") {
    const runs = [];
    for (let i = 0; i < ITER; i++) {
      const { handle, ms } = await measureStartup(i === 0 ? "cold" : "warm");
      runs.push({ run: i + 1, kind: i === 0 ? "cold" : "warm", startupMs: +ms.toFixed(1) });
      await stopServer(handle);
      activeHandle = null;
    }
    console.log(JSON.stringify({ mode, runs }, null, 0));
  } else {
    // hotpath: streaming turn with fake provider, measure publish-path costs
    const { handle, ms: startupMs } = await measureStartup("hotpath");
    const results = { startupMs: +startupMs.toFixed(1) };

    // 1) agentPeer/humanAuthor cost (called per published entry)
    {
      const { structuredClone } = globalThis;
      const cfg = handle.config.snapshot();
      const t0 = performance.now();
      let clones = 0;
      // simulate the streaming publish cadence: 10 publishes/s over 60s turn = 600 publishes,
      // each doing agentPeer() + humanAuthor() => 2 snapshots
      for (let i = 0; i < 1200; i++) { structuredClone(cfg); clones++; }
      const per = (performance.now() - t0) / clones;
      results.configSnapshotMs = +per.toFixed(4);
      results.publishPathSnapshotOverheadMs = +(per * 2 * 600).toFixed(1); // per 60s turn @100ms cadence
    }

    // 2) store: append+getEntries scan cost vs recentEntries
    {
      const store = handle.store;
      const agentId = "openbot-default";
      const entries = [];
      for (let i = 0; i < 5000; i++) {
        entries.push({ kind: "message", id: "m" + i, role: i % 2 ? "assistant" : "user", content: "x".repeat(200), timestampMs: 1 });
      }
      const t0 = performance.now();
      store.append(agentId, entries);
      const appendMs = performance.now() - t0;

      const R = 50;
      const t2 = performance.now();
      for (let i = 0; i < R; i++) store.getEntries(agentId);
      const fullScanMs = (performance.now() - t2) / R;
      const t3 = performance.now();
      for (let i = 0; i < R; i++) store.getRecentEntries(agentId, { limit: 80 });
      const recentMs = (performance.now() - t3) / R;
      const t4 = performance.now();
      for (let i = 0; i < R; i++) store.openAgentTail(agentId, 500);
      const tailMs = (performance.now() - t4) / R;
      results.store = { seededEntries: 5000, appendMs: +appendMs.toFixed(1), fullScanMs: +fullScanMs.toFixed(2), recent80Ms: +recentMs.toFixed(2), tail500Ms: +tailMs.toFixed(2) };
    }

    await stopServer(handle);
    activeHandle = null;
    console.log(JSON.stringify(results, null, 0));
  }
} finally {
  if (activeHandle != null && stopServerForCleanup != null) {
    await stopServerForCleanup(activeHandle).catch(() => undefined);
  }
  if (ownsDataRoot) await rm(dataRoot, { recursive: true, force: true });
}
