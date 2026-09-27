import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const main = readFileSync(resolve(root, "client/extracted/dist/electron-main/main.cjs"), "utf8");
const settings = readFileSync(resolve(root, "client/extracted/dist/renderer/assets/openbot-local-settings.js"), "utf8");
const preload = readFileSync(resolve(root, "client/extracted/dist/electron-preload/preload.cjs"), "utf8");
const coordinator = readFileSync(resolve(root, "client/extracted/dist/node-agent-coordinator/main.cjs"), "utf8");

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}


describe("Electron/Windows local integration patches", () => {
  it.each(["expanded", "collapsed", "pinned"])("resolves the selected bot in %s layout", (layout) => {
    const row = { dataset: { active: "true", layout }, getAttribute: (key: string) => key === "data-agent-id" ? "selected-bot" : null };
    const resolveSelected = runInNewContext(`${between(settings, "function selectedAgentRow()", "function handleAgentSelectionClick")} refreshActivePromptAgent`, {
      activePromptAgentId: null,
      activePromptConversationId: null,
      isVisibleElement: () => true,
      document: { querySelectorAll: (selector: string) => selector === ".sand-agent-item[data-agent-id]" ? [row] : [] },
      desktop: () => ({ agent: { getActiveConversation: async () => ({ id: "conversation-selected" }) } }),
    });
    return expect(resolveSelected()).resolves.toBe("selected-bot");
  });
  it("filters prompt status by the active conversation", () => {
    const stateA = { conversationId: "conversation-a", turnId: "turn-a", isBusy: true };
    const stateB = { lastTurn: { conversationId: "conversation-b", outcome: "success" } };
    const scope = {
      activePromptConversationId: "conversation-b",
      promptStates: new Map<string, unknown>([["agent-a", stateA], ["agent-b", stateB]]),
    };
    const current = runInNewContext(`${between(settings, "function promptStateForActiveConversation", "function handleAgentSelectionClick")} promptStateForActiveConversation`, scope);
    expect(current("agent-a")).toBeUndefined();
    expect(current("agent-b")).toEqual(stateB);
  });
  it("keeps routine draft saves out of the composer layout while preserving failure feedback", () => {
    const notice = { hidden: true, firstChild: { textContent: "" }, lastChild: { hidden: true } };
    const context = {
      draftPersistenceState: "saved", draftRecoveryError: "",
      document: {
        querySelector: () => ({}), getElementById: () => notice, querySelectorAll: () => [],
      },
    };
    const render = runInNewContext(`${between(settings, "function renderDraftPersistence()", "function setLocalTimeout(")} renderDraftPersistence`, context);
    for (const state of ["saved", "saving", "saved", "saving", "saved"]) {
      context.draftPersistenceState = state;
      render();
      expect(notice.hidden).toBe(true);
      expect(notice.firstChild.textContent).toBe("");
    }
    context.draftPersistenceState = "failed";
    render();
    expect(notice.hidden).toBe(false);
    expect(notice.lastChild.hidden).toBe(false);
    expect(notice.firstChild.textContent).toContain("Rascunho não salvo");
    context.draftPersistenceState = "journal-failed";
    render();
    expect(notice.hidden).toBe(false);
    expect(notice.firstChild.textContent).toContain("pendência de envio");
    context.draftPersistenceState = "saved";
    context.draftRecoveryError = "Falha ao recuperar rascunho";
    render();
    expect(notice.hidden).toBe(false);
    expect(notice.firstChild.textContent).toBe(context.draftRecoveryError);
  });
  it("preserves legacy journal records without resolving deleted bots when saving a new send", async () => {
    const calls: string[] = [];
    const context = { process: { env: { OPENBOT_LOCAL_GATEWAY: "1" } }, resolveConversation: async (id: string) => {
      calls.push(id);
      if (id !== "current") throw new Error("getActiveConversation: agente não encontrado");
      return { id: "conversation-current" };
    } };
    const bind = runInNewContext(`${between(main, "var openBotComposerScopes =", "function registerSecretsIpc(deps)")} openBotGetDraftConversation = resolveConversation; scopeOpenBotClientValue`, context);
    const old = { agentId: "deleted", nonce: "old", failedAtMs: 123, draftRecovery: { prompt: "keep" } };
    const key = "sand.client.slice.account.send-journal";
    await bind(key, JSON.stringify({ value: { records: [old] } }), true);
    const next = { agentId: "current", nonce: "new" };
    const saved = JSON.parse(await bind(key, JSON.stringify({ value: { records: [old, next] } })));
    expect(saved.value.records[0]).toEqual(old);
    expect(saved.value.records[1].openbotConversationId).toBe("conversation-current");
    expect(calls).toEqual(["current"]);
    await expect(bind(key, JSON.stringify({ value: { records: [...saved.value.records, { agentId: "missing", nonce: "new-missing" }] } }))).rejects.toThrow("agente não encontrado");
  });

  it("aligns user and assistant chat bubbles on opposite sides", () => {
    expect(settings).toContain('.sand-transcript-row[data-role="user"],.sand-transcript-row[data-openbot-side="user"]{align-items:flex-end!important}');
    expect(settings).toContain('.sand-transcript-row[data-role="assistant"],.sand-transcript-row[data-openbot-side="assistant"]{align-items:flex-start!important}');
    expect(settings).toContain('.sand-transcript-row:is([data-role="user"],[data-openbot-side="user"]) .sand-author-run{justify-content:flex-end!important}');
    expect(settings).toContain('.sand-transcript-row:is([data-role="user"],[data-openbot-side="user"]) .sand-author-run__column{flex:0 1 auto!important;max-width:calc(100% - 30px)!important;align-items:flex-end!important}');
    expect(settings).toContain("function classifyTranscriptRows()");
  });

  it("hides the Sand session restore wall so local overlays remain usable", () => {
    expect(settings).toContain("function hideSandRestoreWall()");
    expect(settings).toContain("Couldn't Restore Your Session");
    expect(settings).toContain("data-openbot-sand-restore-wall");
    expect(settings).toContain('[data-openbot-sand-restore-wall="1"]{display:none!important}');
    expect(settings).toContain("const restoredWallHidden = hideSandRestoreWall();");
    expect(settings).toContain("if (restoredWallHidden || missingMount > 4) void checkEmptyAgentState();");
  });

  it("keeps retry and cancellation bound to the selected native bot", async () => {
    expect(main).toContain('"sand:retry-prompt"');
    expect(main).toContain('"sand:prompt-status"');
    expect(main).toMatch(/"sand:retry-prompt"[\s\S]{0,300}assertTrustedSecretsSender[\s\S]{0,300}retryPrompt/);
    expect(preload).toContain('invoke("sand:retry-prompt", args ?? {})');
    expect(preload).toContain('invoke("sand:prompt-status", args ?? {})');
    expect(settings).toContain("getPromptStatus");
    expect(settings).toContain("retryPrompt");
    expect(settings).toContain('retry.textContent = "Tentar novamente"');
    // A recuperação é decidida pelo backend: nenhuma ação depende do texto exibido.
    expect(settings).toContain("getPromptRecovery");
    expect(settings).not.toContain("RETRYABLE_NOTICES");
    expect(main).toContain('"sand:prompt-recovery"');
    expect(preload).toContain('invoke("sand:prompt-recovery", args ?? {})');
    expect(main).toMatch(/"sand:prompt-recovery"[\s\S]{0,300}assertTrustedSecretsSender[\s\S]{0,300}getPromptRecovery/);
    expect(settings).toContain("getActiveConversation");
    expect(settings).toContain("conversationId");
    const scope = {
      selectedAgentRow: () => ({ getAttribute: () => "agent-a" }),
      activePromptAgentId: "agent-b",
      activePromptConversationId: null,
      desktop: () => ({ agent: { getActiveConversation: async ({ agentId }: { agentId: string }) => ({ id: `conversation:${agentId}` }) } }),
    };
    const refresh = runInNewContext(`${between(settings, "async function refreshActivePromptAgent()", "function handleAgentSelectionClick")} refreshActivePromptAgent`, scope);
    expect(await refresh()).toBe("agent-a");
    scope.selectedAgentRow = () => ({ getAttribute: () => "agent-b" });
    expect(await refresh()).toBe("agent-b");
    expect(scope.activePromptConversationId).toBe("conversation:agent-b");
    const resolver = runInNewContext(`${between(main, "const resolveActiveOpenBotAgent =", "const withActiveOpenBotAgent =")} resolveActiveOpenBotAgent`, {
      mainWindow: { isDestroyed: () => false, webContents: { executeJavaScript: async () => "agent-a" } },
      ACTIVE_AGENT_TIMEOUT_MS: 2000,
      callOpenBotProviderRpc: async (_method: string, args: { agentId?: string }) => ({ agentId: args.agentId ?? "agent-b" }),
    });
    expect((await resolver()).agentId).toBe("agent-a");
    expect(settings).toMatch(/button\.addEventListener\("click"[\s\S]{0,220}await refreshActivePromptAgent\(\)/);
    expect(settings).toMatch(/function schedulePromptStatus[\s\S]{0,700}const activeAgentId = await refreshActivePromptAgent\(\)/);
    expect(settings).not.toContain("rememberSelectedAgent(selectedAgentRow(), globalStatus.agentId)");
    expect(settings).not.toContain("stopFallbackTimer");
    expect(settings).not.toContain("120000");
    const retryAction = between(settings, "function createRetryAction(", "function handlePromptSubmit(");
    expect(retryAction).toContain('getActiveConversation?.({ agentId })');
    expect(retryAction).toContain('agentId, conversationId, expectedFailureEntryId,');
  });

  it("observa Enter e clique no envio sem depender da montagem do botão e limita o otimismo ao bot selecionado", () => {
    class Element {
      textContent = "pergunta";
      closest() { return null; }
      matches() { return true; }
    }
    const scope = { Element, selectedAgentRow: () => ({ getAttribute: () => "a" }),
      activePromptAgentId: null as string | null, optimisticAgentId: null as string | null,
      activePromptConversationId: "conversation-a", optimisticConversationId: null as string | null,
      optimisticGeneration: false, optimisticNonce: null, lastSubmitAction: null, promptStatusRevision: 0,
      lastSendAt: 0, generating: false, busyAgentIds: new Set(),
      ensureStop: () => {}, schedulePromptStatus: () => {} };
    const submit = runInNewContext(`${between(settings, "function handlePromptSubmit(event)", "function watchComposer()")} handlePromptSubmit`, scope);
    const sync = runInNewContext(`${between(settings, "function syncGenerating()", "function selectedAgentRow()")} syncGenerating`, scope);
    submit({ type: "keydown", key: "Enter", target: new Element() });
    sync();
    expect(scope.generating).toBe(true);
    scope.activePromptAgentId = "b";
    sync();
    expect(scope.generating).toBe(false);
    scope.optimisticGeneration = false;
    const button = Object.assign(new Element(), { closest: () => ({ disabled: false, getAttribute: () => "Send message" }) });
    submit({ type: "click", target: button });
    expect(scope.optimisticAgentId).toBe("a");
    expect(scope.optimisticGeneration).toBe(true);
    expect(settings).toContain('document.addEventListener("keydown", handlePromptSubmit, true)');
  });

  it("does not turn a double-click send gesture into voice input", () => {
    let label = "Send message";
    const send = { disabled: false, getAttribute: () => label };
    class Element { closest() { return send; } }
    let prevented = 0;
    let stopped = 0;
    let submits = 0;
    const scope = { Element, selectedAgentRow: () => ({ getAttribute: () => "a" }),
      lastSubmitAction: null, optimisticAgentId: null, optimisticNonce: null, optimisticGeneration: false,
      activePromptAgentId: null, activePromptConversationId: "conversation-a", optimisticConversationId: null,
      promptStatusRevision: 0, lastSendAt: 0,
      ensureStop: () => { submits += 1; }, schedulePromptStatus: () => {} };
    const submit = runInNewContext(`${between(settings, "function handlePromptSubmit(event)", "function watchComposer()")} handlePromptSubmit`, scope);
    const event = (detail: number) => ({ type: "click", detail, target: new Element(),
      preventDefault: () => { prevented += 1; }, stopImmediatePropagation: () => { stopped += 1; } });
    submit(event(1));
    label = "Start voice input";
    submit(event(2));
    expect({ prevented, stopped, submits }).toEqual({ prevented: 1, stopped: 1, submits: 1 });
    submit(event(1)); // Voice input remains unavailable for deliberate clicks too.
    expect(prevented).toBe(2);
    label = "Stop dictation";
    submit(event(1));
    expect(prevented).toBe(3);
    label = "Send message";
    submit(event(1));
    expect(submits).toBe(2);
  });

  it("reports durable acceptance from the coordinator without leaking prompt content", () => {
    const handlers = new Map<string, Array<(event: unknown) => void>>();
    const delivered: unknown[] = [];
    const posted: unknown[] = [];
    const scope = { openBotPendingConversations: new Map(), port: {
      addEventListener: (kind: string, callback: (event: unknown) => void) => handlers.set(kind, [...(handlers.get(kind) ?? []), callback]),
      postMessage: (frame: unknown) => posted.push(frame), close: () => {}, start: () => {},
    } };
    const bridge = runInNewContext(`${between(preload, "const openBotPromptDeliveryListeners =", "// src/electron-preload/preload.cts")}
      ({ port: wrapTransferredCoordinatorPort(port), subscribe: (listener) => openBotPromptDeliveryListeners.add(listener) })`, scope);
    bridge.subscribe((state: unknown) => delivered.push(state));
    const respond = (requestId: string, value: unknown) => handlers.get("message")?.forEach((callback) => callback({ data: {
      kind: "reply", requestId, outcome: { status: "ok", value },
    } }));
    bridge.port.postMessage({ kind: "request", requestId: "1", method: "sendPrompt", args: { agentId: "a", clientNonce: "n", prompt: "private text" } });
    respond("unrelated", { accepted: true });
    expect(delivered).toEqual([{ agentId: "a", nonce: "n", phase: "sending" }]);
    respond("1", { accepted: true });
    expect(delivered).toEqual([{ agentId: "a", nonce: "n", phase: "sending" }, { agentId: "a", nonce: "n", phase: "accepted" }]);
    bridge.port.postMessage({ kind: "request", requestId: "2", method: "promptAcceptanceStatus", args: { agentId: "a", nonce: "n" } });
    respond("2", { outcome: "unknown-durability" });
    expect(delivered).toHaveLength(2);
    bridge.port.postMessage({ kind: "request", requestId: "3", method: "promptAcceptanceStatus", args: { agentId: "a", nonce: "n" } });
    respond("3", { outcome: "found", record: { status: "accepted" } });
    expect(delivered).toHaveLength(3);
    expect(JSON.stringify(delivered)).not.toContain("private text");
    expect(posted).toHaveLength(3);
  });

  it("settles a fast accepted send using fresh status and preserves an unaccepted newer send", async () => {
    const callbacks: Array<() => Promise<void>> = [];
    const scope = { localUiClosed: false, optimisticGeneration: true, optimisticAgentId: "a", optimisticNonce: "new",
      promptStatusRevision: 0, promptStatusTimer: 0, promptStatusFailures: 0, lastSendAt: Date.now(),
      busyAgentIds: new Set<string>(), cancellingAgentIds: new Set(), unknownAgentIds: new Set(),
      promptStates: new Map(),
      activePromptAgentId: "a", cachedSendAction: null, clearLocalTimeout: () => {},
      setLocalTimeout: (callback: () => Promise<void>) => { callbacks.push(callback); return callbacks.length; },
      desktop: () => ({ agent: { getPromptStatus: async () => ({ agentId: "a", isBusy: false }) } }),
      refreshActivePromptAgent: async () => "a", syncGenerating: () => {}, ensureStop: () => {},
      document: { querySelector: () => null },
    };
    const deliver = runInNewContext(`${between(settings, "function schedulePromptStatus", "const RECOVERY_RETRY")}
      ${between(settings, "function handlePromptDelivery", "function watchComposer")} handlePromptDelivery`, scope);
    deliver({ agentId: "a", nonce: "old", phase: "accepted" });
    expect(scope.optimisticGeneration).toBe(true);
    deliver({ agentId: "a", nonce: "new", phase: "accepted" });
    expect(scope.optimisticGeneration).toBe(false);
    expect(scope.busyAgentIds.has("a")).toBe(true); // Acceptance alone does not mean done.
    await callbacks.at(-1)!();
    expect(scope.busyAgentIds.size).toBe(0); // Fast completion does not wait five seconds.
    expect(scope.promptStatusFailures).toBe(0);
  });

  it("clears previous cancellation when a newer turn is busy and cancelable", async () => {
    const callbacks: Array<() => Promise<void>> = [];
    const scope = {
      localUiClosed: false, optimisticGeneration: false, optimisticAgentId: "a", lastSendAt: 0,
      promptStatusRevision: 0, promptStatusTimer: 0, promptStatusFailures: 0,
      busyAgentIds: new Set(["a"]), cancellingAgentIds: new Set(["a"]), unknownAgentIds: new Set(), promptStates: new Map(),
      clearLocalTimeout: () => {}, setLocalTimeout: (callback: () => Promise<void>) => { callbacks.push(callback); return callbacks.length; },
      desktop: () => ({ agent: { getPromptStatus: async () => ({ agentId: "a", isBusy: true, canCancel: true, turnId: "new-turn", conversationId: "conversation" }) } }),
      refreshActivePromptAgent: async () => "a", syncGenerating: () => {}, ensureStop: () => {}, document: { querySelector: () => null },
    };
    const schedule = runInNewContext(`${between(settings, "function schedulePromptStatus", "const RECOVERY_RETRY")} schedulePromptStatus`, scope);
    schedule(0);
    await callbacks[0]!();
    expect(scope.cancellingAgentIds.has("a")).toBe(false);
    expect(scope.promptStates.get("a")).toMatchObject({ turnId: "new-turn", canCancel: true });
  });

  it("turns SSE resync into an openAgentTail snapshot and drops other-conversation frames", () => {
    expect(coordinator).toContain("handleTranscriptResync");
    expect(coordinator).toContain("shouldForwardTranscript");
    expect(coordinator).toContain("seedActiveTranscript");
    expect(coordinator).toContain('dispatchGatewayCommand("getAgentTranscriptTail"');
    expect(coordinator).toContain("authoritativeResync: true");
    expect(coordinator).toContain('payload.type === "resync"');
    expect(coordinator).toContain("activeConversationByAgent");
    expect(coordinator).toContain("transcriptSnapshotGate");
    expect(coordinator).toContain("allowConversationSwitch: true");
    expect(coordinator).toContain("payload.ordered === void 0");
    expect(coordinator).toContain("observeAgentsRoster");
    expect(coordinator).toContain("disposeTranscriptAgent");
    expect(coordinator).toContain("activeConversationByAgent.delete(agentId)");
  });

  it("recupera resync após falhas da RPC e entrega o final sem reenviar prompts", async () => {
    vi.useFakeTimers();
    const helpers = createRequire(import.meta.url)("../client/extracted/dist/node-agent-coordinator/openbot-transcript-adapter.cjs");
    const finalEntry = { kind: "message", id: "assistant", role: "assistant", content: "resposta completa", streaming: false, isStreaming: false };
    const dispatch = vi.fn().mockRejectedValueOnce(new Error("temporary RPC failure")).mockRejectedValueOnce(new Error("temporary RPC failure")).mockResolvedValue({ entries: [finalEntry] });
    const postEvent = vi.fn();
    const warn = vi.fn();
    const api = runInNewContext(`${between(coordinator, "const activeConversationByAgent =", "async function seedActiveTranscript()")}
      dispatchGatewayCommand = dispatch;
      ({ handleTranscriptResync, transcriptAdapter, closeTranscriptResync });`, {
      ...helpers, dispatch, server: { postEvent }, setTimeout, clearTimeout, process: { stderr: { write: warn } },
    });
    try {
      api.transcriptAdapter.reset({ type: "snapshot", agentId: "a", conversationId: "c1", entries: [] });
      api.handleTranscriptResync({ agentId: "a", conversationId: "c1" });
      await vi.advanceTimersByTimeAsync(249);
      expect(dispatch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(dispatch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(500);
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(dispatch.mock.calls.every(([method]) => method === "getAgentTranscriptTail")).toBe(true);
      expect(postEvent).toHaveBeenLastCalledWith("transcript", expect.objectContaining({ entries: [finalEntry] }));
      expect(api.transcriptAdapter.getState("a").status).toBe("ready");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { api.closeTranscriptResync(); api.transcriptAdapter.dispose(); vi.useRealTimers(); }
  });

  it.each(["conversation", "delete", "shutdown"])("cancela retries antigos de resync em %s", async (action) => {
    vi.useFakeTimers();
    const helpers = createRequire(import.meta.url)("../client/extracted/dist/node-agent-coordinator/openbot-transcript-adapter.cjs");
    const dispatch = vi.fn().mockRejectedValue(new Error("RPC unavailable"));
    const api = runInNewContext(`${between(coordinator, "const activeConversationByAgent =", "async function seedActiveTranscript()")}
      dispatchGatewayCommand = dispatch;
      ({ handleTranscriptResync, beginTranscriptSnapshot, disposeTranscriptAgent, closeTranscriptResync, transcriptAdapter });`, {
      ...helpers, dispatch, server: { postEvent: vi.fn() }, setTimeout, clearTimeout, process: { stderr: { write: vi.fn() } },
    });
    try {
      api.handleTranscriptResync({ agentId: "a", conversationId: "c1" });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      if (action === "conversation") api.beginTranscriptSnapshot("a", "c2");
      else if (action === "delete") api.disposeTranscriptAgent("a");
      else api.closeTranscriptResync();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { api.closeTranscriptResync(); api.transcriptAdapter.dispose(); vi.useRealTimers(); }
  });

  it.each(["conversation", "delete", "shutdown"])("descarta resposta de resync em voo após %s", async (action) => {
    const helpers = createRequire(import.meta.url)("../client/extracted/dist/node-agent-coordinator/openbot-transcript-adapter.cjs");
    let resolveRpc!: (page: unknown) => void;
    const dispatch = vi.fn(() => new Promise(resolve => { resolveRpc = resolve; }));
    const postEvent = vi.fn();
    const api = runInNewContext(`${between(coordinator, "const activeConversationByAgent =", "async function seedActiveTranscript()")}
      dispatchGatewayCommand = dispatch;
      ({ handleTranscriptResync, beginTranscriptSnapshot, disposeTranscriptAgent, closeTranscriptResync, transcriptAdapter });`, {
      ...helpers, dispatch, server: { postEvent }, setTimeout, clearTimeout, process: { stderr: { write: vi.fn() } },
    });
    try {
      api.handleTranscriptResync({ agentId: "a", conversationId: "c1" });
      if (action === "conversation") api.beginTranscriptSnapshot("a", "c2");
      else if (action === "delete") api.disposeTranscriptAgent("a");
      else api.closeTranscriptResync();
      resolveRpc({ entries: [{ kind: "notice", id: "old", text: "stale" }] });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(postEvent).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { api.closeTranscriptResync(); api.transcriptAdapter.dispose(); }
  });

  it("adapts ordered transcript deltas at the approved coordinator seam", () => {
    expect(coordinator).toContain('require("./openbot-transcript-adapter.cjs")');
    expect(coordinator).toContain("createTranscriptSnapshotGate");
    expect(coordinator).toContain("transcriptAdapter.accept");
    expect(coordinator).toContain("coalesce: true");
    expect(coordinator).toContain("transcriptAdapter.markResync");
    expect(coordinator).toContain("transcriptAdapter?.disposeAgent(agentId)");
    expect(readFileSync(resolve(root, "client/extracted/dist/node-agent-coordinator/openbot-transcript-adapter.cjs"), "utf8")).toContain("rendererSequence");
  });

  it("keeps a failed settings draft, blocks duplicate saves and ignores a late bot response", async () => {
    let current = true;
    let resolveSave!: (value: unknown) => void;
    let rejectSave!: (error: Error) => void;
    let calls = 0;
    const statuses: string[] = [];
    const control = { value: "gpt-5.6-sol", disabled: false, selectedOptions: [{ disabled: false }] };
    const scope = {
      saving: false, authBusy: false, persisted: "previous", activeAgentId: "alpha", globalScope: false,
      speedEl: { value: "default", selectedOptions: [{ disabled: false }] },
      providerEl: { value: "openai" }, modelEl: control, reasoningEl: { value: "high", selectedOptions: [{ disabled: false }] },
      oauth: { openai: { state: "connected" } }, openCodeConfigured: false,
      loadingControls: [control], isCurrent: () => current,
      selection: () => JSON.stringify(["openai", control.value, "high", "default"]),
      syncSave: () => {}, syncAuth: () => {},
      setStatus: (_kind: string, text: string) => statuses.push(text),
      desktop: () => ({ agent: { setProviderConfig: () => {
        calls += 1;
        return new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
      } } }),
    };
    const start = settings.indexOf("const persistSelection = async");
    const end = settings.indexOf("const pollOAuth", start);
    const save = runInNewContext(`${settings.slice(start, end)} persistSelection`, scope);
    const failed = save("salvo");
    await save("duplicado");
    expect(calls).toBe(1);
    expect(control.disabled).toBe(true);
    rejectSave(new Error("offline"));
    await failed;
    expect(control.value).toBe("gpt-5.6-sol");
    expect(scope.persisted).toBe("previous");
    expect(statuses.at(-1)).toContain("Tente novamente");
    const retry = save("salvo");
    resolveSave({ agentId: "alpha", provider: "openai", model: control.value, reasoningEffort: "high" });
    await retry;
    expect(scope.persisted).toBe(scope.selection());
    expect(statuses.at(-1)).toBe("salvo");
    control.value = "gpt-5.6-luna";
    const late = save("resposta atrasada");
    current = false;
    resolveSave({ agentId: "alpha", provider: "openai", model: control.value, reasoningEffort: "high" });
    await late;
    expect(statuses).not.toContain("resposta atrasada");
  });

  it.each(["retry", "inspect", "none", "unknown-contract"])("offers recovery actions only when the backend confirms them (%s)", async (mode) => {
    const failureEntryId = "notice:turn:a:provider-error";
    const rows: unknown[] = [];
    const hosts: unknown[] = [];
    const created: Element[] = [];
    class Element {
      attributes = new Map<string, string>();
      next: Element | null = null;
      previousElementSibling: Element | null = null;
      isConnected = true;
      removed = false;
      disabled = false;
      textContent = "";
      className = "";
      type = "";
      handlers = new Map<string, () => Promise<void>>();
      get nextElementSibling() { return this.next; }
      getAttribute(name: string) { return this.attributes.get(name) ?? null; }
      setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
      removeAttribute(name: string) { this.attributes.delete(name); }
      hasAttribute(name: string) { return this.attributes.has(name); }
      closest() { return null; }
      remove() { this.removed = true; if (this.previousElementSibling) this.previousElementSibling.next = null; }
      insertAdjacentElement(_position: string, element: Element) { this.next = element; element.previousElementSibling = this; hosts.push(element); return element; }
      addEventListener(kind: string, handler: () => Promise<void>) { this.handlers.set(kind, handler); }
    }
    const row = new Element();
    row.setAttribute("role", "note");
    row.setAttribute("data-entry-id", failureEntryId);
    rows.push(row);
    const getPromptRecovery = mode === "unknown-contract" ? undefined : vi.fn(async () => ({
      conversationId: "current-conversation",
      failure: { entryId: failureEntryId, turnId: "turn:a", actions: mode === "retry" ? ["retry"] : mode === "inspect" ? ["inspect"] : [] },
    }));
    const scope = {
      ROOT_ID: "settings", EMPTY_ID: "empty",
      RECOVERY_RETRY: "retry", RECOVERY_INSPECT: "inspect",
      RECOVERY_INSPECT_HINT: "Este turno já executou ferramentas ou foi interrompido durante uma operação. Confira os resultados e possíveis efeitos no histórico e envie uma nova instrução para continuar.",
      RECOVERY_ROW_ATTR: "data-openbot-recovery-signature",
      localUiClosed: false, activePromptAgentId: "alpha", promptRecoveryTimer: 0, promptRecoverySignature: "",
      promptRecovery: new Map(), promptRecoveryTokens: new Map(),
      Element,
      document: {
        querySelectorAll: (selector: string) => selector === "[data-openbot-recovery]" ? [...hosts] : [...rows],
        createElement: () => { const element = new Element(); created.push(element); return element; },
        querySelector: () => null,
      },
      selectedAgentRow: () => ({ getAttribute: () => "alpha" }),
      refreshActivePromptAgent: async () => "alpha",
      desktop: () => ({ agent: { retryPrompt: async () => ({ accepted: true }), getActiveConversation: async () => ({ id: "current-conversation" }), getPromptRecovery } }),
      busyAgentIds: new Set<string>(), optimisticGeneration: false, lastSendAt: 0,
      syncGenerating() {}, ensureStop() {}, schedulePromptStatus() {},
      clearLocalTimeout() {}, setLocalTimeout: () => 1,
      userFacingError: (error: unknown, fallback: string) => (error instanceof Error ? error.message : String(error || "")) || fallback,
    };
    const api = runInNewContext(`${between(settings, "function currentAgentId()", "function handlePromptSubmit(")}
      ({ refreshPromptRecovery, ensureRetryActions })`, scope);
    await api.refreshPromptRecovery("alpha");
    api.ensureRetryActions();

    if (mode === "retry") {
      expect(getPromptRecovery).toHaveBeenCalledExactlyOnceWith({ agentId: "alpha", conversationId: "current-conversation" });
      expect(created).toHaveLength(1);
      expect(created[0]!.className).toBe("ob-retry-generation");
      expect(created[0]!.textContent).toBe("Tentar novamente");
      expect(row.getAttribute("data-openbot-recovery-signature")).toBe("retry");
      // Reprocessar a mesma falha não duplica a ação.
      api.ensureRetryActions();
      expect(created).toHaveLength(1);
      return;
    }
    expect(created.some((element) => element.className === "ob-retry-generation")).toBe(false);
    if (mode === "inspect") {
      expect(created).toHaveLength(1);
      expect(created[0]!.className).toBe("ob-recovery-inspect");
      expect(created[0]!.textContent).toBe("Conferir resultados e possíveis efeitos");
      expect(row.getAttribute("data-openbot-recovery-signature")).toBe("inspect");
      return;
    }
    // Nenhuma ação automática: contrato ausente ou falha sem recuperação segura.
    expect(created).toHaveLength(0);
    expect(row.getAttribute("data-openbot-recovery-signature")).toBeNull();
  });

  it("revalidates a retry click in the backend and re-reads the confirmed actions on refusal", async () => {
    const failureEntryId = "notice:turn:a:provider-error";
    const rows: unknown[] = [];
    const hosts: unknown[] = [];
    const created: Element[] = [];
    const scheduled: Array<() => void> = [];
    let activeElement: unknown;
    const body = {};
    class Element {
      attributes = new Map<string, string>();
      next: Element | null = null;
      previousElementSibling: Element | null = null;
      isConnected = true;
      textContent = "";
      className = "";
      type = "";
      handlers = new Map<string, () => Promise<void>>();
      focus: (options?: { preventScroll?: boolean }) => void = () => {};
      /** Desabilitar um botão focado tira o foco dele, como no navegador. */
      #disabled = false;
      get disabled() { return this.#disabled; }
      set disabled(value: boolean) { this.#disabled = value; if (value && activeElement === this) activeElement = body; }
      get nextElementSibling() { return this.next; }
      getAttribute(name: string) { return this.attributes.get(name) ?? null; }
      setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
      removeAttribute(name: string) { this.attributes.delete(name); }
      hasAttribute(name: string) { return this.attributes.has(name); }
      closest() { return null; }
      remove() { this.removed = true; }
      removed = false;
      insertAdjacentElement(_position: string, element: Element) { this.next = element; element.previousElementSibling = this; hosts.push(element); return element; }
      addEventListener(kind: string, handler: () => Promise<void>) { this.handlers.set(kind, handler); }
    }
    const row = new Element();
    row.setAttribute("role", "note");
    row.setAttribute("data-entry-id", failureEntryId);
    rows.push(row);
    const retryPrompt = vi.fn(async () => { throw new Error("Error invoking remote method 'sand:retry-prompt': Error: retryPrompt: a falha selecionada não é mais a falha atual"); });
    const scope = {
      ROOT_ID: "settings", EMPTY_ID: "empty",
      RECOVERY_RETRY: "retry", RECOVERY_INSPECT: "inspect",
      RECOVERY_INSPECT_HINT: "Confira os resultados e possíveis efeitos no histórico.",
      RECOVERY_ROW_ATTR: "data-openbot-recovery-signature",
      localUiClosed: false, activePromptAgentId: "alpha", promptRecoveryTimer: 0, promptRecoverySignature: "",
      promptRecovery: new Map([["alpha", { entryId: failureEntryId, actions: ["retry"] }]]), promptRecoveryTokens: new Map(),
      Element,
      document: {
        body,
        get activeElement() { return activeElement; },
        querySelectorAll: (selector: string) => selector === "[data-openbot-recovery]" ? [...hosts] : [...rows],
        createElement: () => { const element = new Element(); created.push(element); return element; },
        querySelector: () => null,
      },
      selectedAgentRow: () => ({ getAttribute: () => "alpha" }),
      refreshActivePromptAgent: async () => "alpha",
      desktop: () => ({ agent: { retryPrompt, getActiveConversation: async () => ({ id: "current-conversation" }), getPromptRecovery: async () => ({ conversationId: "current-conversation", failure: { entryId: failureEntryId, turnId: "turn:a", actions: ["inspect"] } }) } }),
      busyAgentIds: new Set<string>(), optimisticGeneration: false, lastSendAt: 0,
      syncGenerating() {}, ensureStop() {}, schedulePromptStatus() {},
      clearLocalTimeout() {}, setLocalTimeout: (callback: () => void) => { scheduled.push(callback); return scheduled.length; },
      userFacingError: (error: unknown, fallback: string) => {
        const message = error instanceof Error ? error.message : String(error || "");
        return /(?:invoking remote method|unauthorized|gateway-command-failed|\bsand:)/i.test(message) ? fallback : (message || fallback);
      },
    };
    const recovery = runInNewContext(`${between(settings, "function currentAgentId()", "function handlePromptSubmit(")} ensureRetryActions`, scope);
    recovery();
    const retry = created[0]!;
    const focus = vi.fn(() => { activeElement = retry; });
    retry.focus = focus;
    activeElement = retry;
    await retry.handlers.get("click")!();

    // A ação revalida pelo identificador real e nunca inventa um turno novo.
    expect(retryPrompt).toHaveBeenCalledExactlyOnceWith({ agentId: "alpha", conversationId: "current-conversation", expectedFailureEntryId: failureEntryId });
    // A recusa é sanitizada: nada de IPC, stack ou credencial na interface.
    expect(retry.disabled).toBe(false);
    expect(retry.textContent).toBe("Tentar novamente");
    const report = retry.nextElementSibling!;
    expect(report.textContent).toBe("Não foi possível tentar novamente.");
    expect(report.textContent).not.toContain("sand:retry-prompt");
    // Foco preservado e reconsulta autoritativa agendada.
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(scheduled).toHaveLength(1);
  });

  it("commits native attachments through the available upload RPC for the captured bot", async () => {
    const uploads: unknown[] = [];
    const commit = runInNewContext(`${between(main, "async function commitStagedAttachment(", "async function discardStagedAttachment(")} commitStagedAttachment`, {
      isSafeFilename: () => true,
      isExpired: () => false,
      import_node_fs19: { promises: { readFile: async () => Buffer.from("audit attachment") } },
      deps: {
        isWithinStagingDir: () => true,
        uploadAttachment: async (args: unknown) => { uploads.push(args); return { path: "attachment:att-a" }; },
      },
      reportEdgeFailure: () => undefined,
    });
    expect(await commit("staged.txt", "audit.txt", "agent-a")).toBe("attachment:att-a");
    expect(uploads).toEqual([{ agentId: "agent-a", filename: "audit.txt", bytesBase64: Buffer.from("audit attachment").toString("base64") }]);
    expect(main).toContain('message: "Não foi possível preparar o anexo para envio."');
  });

  it("reports connection and named missing-file failures instead of silently dropping the send", async () => {
    const handlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>();
    const alerts: unknown[] = [];
    let disconnected = true;
    const register = runInNewContext(`${between(main, "function registerAttachmentIpc(deps)", "// src/shared/gateway-reachability.ts")} registerAttachmentIpc`, {
      import_electron30: {
        ipcMain: { handle: (channel: string, handler: (event: unknown, args: unknown) => Promise<unknown>) => handlers.set(channel, handler) },
        dialog: { showMessageBox: async (_window: unknown, options: unknown) => { alerts.push(options); } },
      },
      errorClassOf2: () => "Error",
      setInterval: () => ({ unref() {} }),
      isSafeFilename: () => true,
      import_node_path39: { default: { basename: () => "staged.txt" } },
      import_node_fs19: { promises: { readFile: async () => { throw new Error("ENOENT"); } } },
    });
    register({
      getMainWindow: () => ({}),
      getActiveAgentId: async () => { if (disconnected) throw new Error("ECONNREFUSED"); return "agent-a"; },
      isWithinStagingDir: () => true,
      onEdgeFailure: () => undefined,
    });
    expect(await handlers.get("sand:attachment-commit")!(null, { paths: ["staged.txt"], filenames: ["audit.txt"] })).toBeNull();
    expect(alerts).toEqual([expect.objectContaining({ type: "error", message: "Não foi possível preparar o anexo para envio." })]);
    disconnected = false;
    expect(await handlers.get("sand:attachment-commit")!(null, { paths: ["staged.txt"], filenames: ["audit.txt"] })).toBeNull();
    expect(alerts.at(-1)).toEqual(expect.objectContaining({ detail: expect.stringContaining('"audit.txt"') }));
  });

  it("recovers a failed draft before removing its journal and refuses an unknown prior nonce", async () => {
    const key = "sand.client.slice.account.openbot-local.send-journal";
    const draftKey = key.replace("send-journal", "composer-drafts");
    const files = new Map([[key, JSON.stringify({ value: { records: [{ nonce: "new", priorNonces: ["prior"], agentId: "a", openbotConversationId: "c", failedAtMs: 1, draftRecovery: { prompt: "texto exato", attachments: [] } }] } })]]);
    const writes: string[] = [];
    const handlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>();
    let unknown = true;
    const register = runInNewContext(`${between(main, "function registerSecretsIpc(deps)", "// src/electron-main/startup/desktop-user-data-bootstrap.ts")} registerSecretsIpc`, {
      CLIENT_PERSISTENCE_CHANNELS: { read: "read", write: "write", remove: "remove", listKeys: "list", migrate: "migrate" },
      openBotGetDraftConversation: async () => ({ id: "c" }),
      openBotGetPromptAcceptance: async ({ clientNonce }: { clientNonce: string }) => ({ outcome: unknown && clientNonce === "prior" ? "unknown-durability" : "not-found" }),
      crypto: { randomUUID: () => "recovered" },
    });
    register({
      ipcMain: { handle: (name: string, handler: (event: unknown, args: unknown) => Promise<unknown>) => handlers.set(name, handler) },
      guards: { assertTrustedClientPersistenceSender() {} },
      stores: { clientPersistenceStore: {
        listKeys: async () => [key], read: async (name: string) => files.get(name) ?? null,
        write: async (name: string, value: string) => { files.set(name, value); writes.push(name); },
        flushDrafts: async () => { writes.push("flushed"); },
      } },
    });
    const recover = () => handlers.get("openbot:recover-failed-send")!(null, { agentId: "a", nonce: "new" });
    await expect(recover()).rejects.toThrow("ainda não permite");
    expect(writes).toEqual([]);
    unknown = false;
    await expect(recover()).resolves.toEqual({ restored: true });
    expect(writes).toEqual([draftKey, "flushed", key]);
    expect(JSON.parse(files.get(draftKey)!).value.agents.a.draft.prompt).toBe("texto exato");
    expect(JSON.parse(files.get(key)!).value.records).toEqual([]);
  });

  it("accepts absolute Windows paths when resolving a staged attachment preview", () => {
    expect(main).toMatch(/if \(\w+\.default\.isAbsolute\(source\)\) return source;/u);
  });
});
