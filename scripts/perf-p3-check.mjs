
import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTranscriptStore } from "../dist/store/index.js";

const dir = await mkdtemp(join(tmpdir(), "openbot-p3-"));
const store = new SqliteTranscriptStore({ path: join(dir, "t.db") });
const agentId = "openbot-default";
// seed: 5000 entries, some with clientNonce
const entries = [];
for (let i = 0; i < 5000; i++) {
  const e = { kind: "message", id: "m"+i, role: i%2 ? "assistant" : "user", content: "x".repeat(200), timestampMs: 1 };
  if (i % 500 === 0) e.clientNonce = "nonce-" + i;
  entries.push(e);
}
store.append(agentId, entries);
// one retryable notice
store.append(agentId, [{ kind: "notice", id: "n1", text: "boom", level: "error", retryable: true, turnId: "turn-42", timestampMs: 1 }]);

// correctness: direct lookup must match scan for every seeded nonce
let mismatches = 0;
for (let i = 0; i < 5000; i += 500) {
  const direct = store.findUserEchoByNonce(agentId, "nonce-"+i);
  const scan = store.getEntries(agentId).find((e) => e.clientNonce === "nonce-"+i && e.kind === "message" && e.role === "user");
  if (!direct || direct.id !== scan.id) mismatches++;
}
const noticeDirect = store.findRetryableErrorNotice(agentId, "turn-42");
const noticeScan = store.getEntries(agentId).find((e) => e.kind === "notice" && e.turnId === "turn-42" && e.retryable === true);
if (!noticeDirect || noticeDirect.id !== noticeScan.id) mismatches++;
// miss case
if (store.findUserEchoByNonce(agentId, "nope") !== undefined) mismatches++;
if (store.findRetryableErrorNotice(agentId, "nope") !== undefined) mismatches++;

// perf
const R = 200;
let t = performance.now();
for (let i = 0; i < R; i++) store.findUserEchoByNonce(agentId, "nonce-2500");
const directMs = (performance.now()-t)/R;
t = performance.now();
for (let i = 0; i < R; i++) store.getEntries(agentId).some((e) => e.clientNonce === "nonce-2500");
const scanMs = (performance.now()-t)/R;
t = performance.now();
for (let i = 0; i < R; i++) store.findRetryableErrorNotice(agentId, "turn-42");
const noticeMs = (performance.now()-t)/R;

// resolveConversationId improvement: explicit conversation validation loop
t = performance.now();
for (let i = 0; i < R; i++) store.getEntries(agentId);
const getEntriesCachedStmtMs = (performance.now()-t)/R;

console.log(JSON.stringify({ mismatches, directEchoMs: +directMs.toFixed(4), scanEchoMs: +scanMs.toFixed(4), speedup: +(scanMs/directMs).toFixed(1), retryableNoticeMs: +noticeMs.toFixed(4), getEntriesExplicitConvMs: +getEntriesCachedStmtMs.toFixed(3) }));
store.close();
await rm(dir, { recursive: true, force: true });
