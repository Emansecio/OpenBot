import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const memoryOverlay = readFileSync("client/extracted/dist/renderer/assets/openbot-memory-ui.js", "utf8");
const taskStart = memoryOverlay.indexOf("// ---- P2.2 tasks/subagents overlay");
if (taskStart < 0) throw new Error("Task overlay section missing");
const tasksSource = memoryOverlay.slice(taskStart);
const settings = readFileSync("client/extracted/dist/renderer/assets/openbot-local-settings.js", "utf8");
function functions(source: string, names: string[]) {
  const ast = ts.createSourceFile("overlay.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const bodies = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) bodies.set(node.name.text, node.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect([...bodies.keys()].sort()).toEqual([...names].sort());
  return [...bodies.values()].join("\n");
}
const taskFunctions = functions(tasksSource, ["loadRows", "applyFrame", "terminalStatus", "pendingAbortRow", "reconcileAbortPending", "rowHtml", "esc", "humanize"]);
function fixture() {
  let resolve!: (rows: unknown[]) => void;
  const pending = new Promise<unknown[]>(done => { resolve = done; });
  const state = { agentId: "a", root: { isConnected: true }, closed: false, rows: [] as Array<{ id: string; status: string }>,
    seqByEpoch: {}, epoch: null, listToken: 0, status: "loading", resyncRequired: false, resyncDirty: false, pendingList: null,
    abortPending: {}, steerTaskId: null, steerDrafts: {}, resyncRequestToken: 0 };
  const api = runInNewContext(`${taskFunctions}\n({ loadRows, applyFrame, rowHtml })`, {
    state, TASK_LIST_LIMIT: 100, bridge: () => ({ getAsyncTasks: () => pending }),
    renderBody: () => {}, renderTaskUpdates: () => true,
    STATUS_TEXT: { running: "Em andamento", failed: "Falhou", completed: "Concluída" },
  });
  return { state, api, resolve };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const frame = (type: string, sequence: number, status: string) => ({ type, channel: "async-tasks", agentId: "a", epoch: "one", sequence, tasks: [{ id: "t", status }] });

describe("task overlay stream/list ordering", () => {
  it.each(["load", "resync", "retry"])("keeps a newer completion when an older %s list arrives", async kind => {
    const { state, api, resolve } = fixture();
    api.loadRows(state, kind); await settle();
    api.applyFrame(state, frame("snapshot", 1, "running"));
    api.applyFrame(state, frame("update", 2, "completed"));
    resolve([{ id: "t", status: "running" }]); await settle();
    expect(state.rows).toEqual([{ id: "t", status: "completed" }]);
    expect(state.status).toBe("ready");
    expect(state.resyncRequired).toBe(false);
  });
  it("replays updates even when no stream snapshot arrived during the initial list", async () => {
    const { state, api, resolve } = fixture();
    api.loadRows(state, "load"); await settle();
    api.applyFrame(state, frame("update", 2, "completed"));
    resolve([{ id: "other", status: "running" }, { id: "t", status: "running" }]); await settle();
    expect(state.rows.find(row => row.id === "t")?.status).toBe("completed");
    expect(state.rows.find(row => row.id === "other")?.status).toBe("running");
  });
  it("accepts the production wrapper, rejects foreign scope and stale snapshots", () => {
    const { state, api } = fixture();
    api.applyFrame(state, { channel: "async-tasks", payload: frame("snapshot", 4, "completed") });
    api.applyFrame(state, frame("snapshot", 2, "running"));
    api.applyFrame(state, { ...frame("update", 5, "failed"), agentId: "b" });
    api.applyFrame(state, { ...frame("snapshot", 6, "failed"), channel: "subagents" });
    expect(state.rows).toEqual([{ id: "t", status: "completed" }]);
  });
  it("generates actual badge classes and one duration for terminal failures", () => {
    const { state, api } = fixture();
    const html = api.rowHtml(state, { id: "t", status: "failed", startedAtMs: 1000, finishedAtMs: 39000, allowedActions: [] });
    expect(html).toContain('class="obp22-badge is-failed"');
    expect(html).toContain("Duração: 38s");
    expect(html).not.toContain("há ");
    expect(api.rowHtml(state, { id: "t", status: "running", startedAtMs: 1000 })).toContain('class="obp22-badge is-active"');
  });
});

describe("incremental transcript decoration", () => {
  it("does no whole-transcript work for text deltas and deduplicates affected rows per animation frame", () => {
    class ElementFixture {
      isConnected = true;
      constructor(readonly row: ElementFixture | null = null) {}
      closest(selector: string) { return selector === ".sand-transcript-row" ? this.row ?? this : null; }
      querySelectorAll() { return []; }
    }
    const callbacks: Array<() => void> = [];
    const visits: number[] = [];
    let scans = 0;
    const nodes = Array.from({ length: 500 }, () => new ElementFixture());
    const prefix = settings.slice(settings.indexOf("  const pendingTranscriptRows ="), settings.indexOf("  function reconcileConfirmedDeliveries("));
    const queue = runInNewContext(`${prefix}\nqueueTranscriptReconciliation`, {
      Element: ElementFixture, selectedAgentRow: () => null, profileState: { name: "User" }, localUiClosed: false,
      document: { querySelectorAll: () => { scans++; return nodes; } },
      window: { requestAnimationFrame: (fn: () => void) => { callbacks.push(fn); return callbacks.length; } },
      classifyTranscriptRowSet: (rows: unknown[]) => visits.push(rows.length), reconcileMessageAvatarSet: () => {},
      schedulePromptRecovery: () => {},
    });
    queue([]); callbacks.shift()!(); // Initial appearance establishes the baseline once.
    expect(scans).toBe(1);
    for (let i = 0; i < 200; i++) queue([{ type: "characterData", target: { parentElement: nodes[0] } }]);
    expect(callbacks).toHaveLength(0);
    expect(scans).toBe(1);
    for (let i = 0; i < 200; i++) queue([{ type: "childList", addedNodes: [new ElementFixture(nodes[0])] }]);
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!();
    expect(visits).toEqual([500, 1]);
    expect(scans).toBe(1);
  });
});


describe("aggregated prompt status", () => {
  it("uses one status RPC for multiple bots", async () => {
    const callbacks: Array<() => Promise<void>> = [];
    const calls: unknown[] = [];
    const busyAgentIds = new Set(["a", "b"]);
    const promptStates = new Map();
    const poll = runInNewContext(`${functions(settings, ["schedulePromptStatus"])}\nschedulePromptStatus`, {
      localUiClosed: false, promptStatusTimer: 0, promptStatusRevision: 0, promptStatusFailures: 0,
      optimisticGeneration: false, optimisticAgentId: null, lastSendAt: 0,
      busyAgentIds, promptStates, cancellingAgentIds: new Set(), unknownAgentIds: new Set(),
      clearLocalTimeout: () => {}, setLocalTimeout: (fn: () => Promise<void>) => { callbacks.push(fn); return callbacks.length; },
      refreshActivePromptAgent: async () => "a", syncGenerating: () => {}, ensureStop: () => {}, document: { querySelector: () => null },
      desktop: () => ({ agent: { getPromptStatus: async (args: unknown) => {
        calls.push(args);
        return { isBusy: false, agentId: null, agents: [{ agentId: "a", isBusy: false, queued: [] }, { agentId: "b", isBusy: false, queued: [] }] };
      } } }),
    });
    poll(0); await callbacks.shift()!();
    expect(calls).toEqual([{ agentIds: ["a", "b"] }]);
    expect(busyAgentIds.size).toBe(0);
    expect([...promptStates.keys()]).toEqual(["a", "b"]);
    expect(callbacks).toHaveLength(0);
  });
});
