import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const main = readFileSync(resolve(root, "client/extracted/dist/electron-main/main.cjs"), "utf8");
const preload = readFileSync(resolve(root, "client/extracted/dist/electron-preload/preload.cjs"), "utf8");
const rendererHtml = readFileSync(resolve(root, "client/extracted/dist/renderer/index.html"), "utf8");
const memoryUi = readFileSync(resolve(root, "client/extracted/dist/renderer/assets/openbot-memory-ui.js"), "utf8");
const localSettings = readFileSync(resolve(root, "client/extracted/dist/renderer/assets/openbot-local-settings.js"), "utf8");
const visual = readFileSync(resolve(root, "scripts/visual-ui-verify.mjs"), "utf8");
const p22Fixture = readFileSync(resolve(root, "scripts/electron-p22-fixture.mjs"), "utf8");
const p23Verifier = readFileSync(resolve(root, "scripts/electron-p23-verify.mjs"), "utf8");
const memoryFlow = readFileSync(resolve(root, "scripts/memory-flow-e2e.mjs"), "utf8");
const packageJson = readFileSync(resolve(root, "package.json"), "utf8");

function exposedMethod(source: string, method: string): string {
  const start = source.indexOf(`async ${method}(`);
  expect(start, `${method} must be exposed`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n    },", start);
  expect(end, `${method} exposure must have a bounded body`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function ipcHandler(source: string, channel: string): string {
  const marker = `.ipcMain.handle("${channel}"`;
  const start = source.indexOf(marker);
  expect(start, `${channel} must be registered`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('.ipcMain.handle("', start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

const settle = () => new Promise<void>((done) => setImmediate(done));

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not bound ${name}`);
}

describe("Electron conversation/memory UI bridge", () => {
  it("injects the isolated renderer asset after local settings", () => {
    expect(rendererHtml).toContain('<script src="./assets/openbot-local-settings.js"></script>');
    expect(rendererHtml).toContain('<script src="./assets/openbot-memory-ui.js"></script>');
    expect(rendererHtml.indexOf("openbot-local-settings.js")).toBeLessThan(rendererHtml.indexOf("openbot-memory-ui.js"));
  });

  it("exposes the conversation and memory bridge methods from preload", () => {
    const methods = {
      listConversations: "sand:conversation-list",
      getActiveConversation: "sand:conversation-active",
      createConversation: "sand:conversation-create",
      activateConversation: "sand:conversation-activate",
      renameConversation: "sand:conversation-rename",
      archiveConversation: "sand:conversation-archive",
      deleteConversation: "sand:conversation-delete",
      getMemorySettings: "sand:memory-settings-get",
      setMemorySettings: "sand:memory-settings-set",
      listMemories: "sand:memory-list",
      listMemoriesPage: "sand:memory-list-page",
      updateMemory: "sand:memory-update",
      deleteMemory: "sand:memory-delete",
      getMemoryStatus: "sand:memory-status-get",
      searchMemoryHistory: "sand:memory-history-search",
    } as const;
    for (const [method, channel] of Object.entries(methods)) {
      const body = exposedMethod(preload, method);
      expect(body).toContain(`ipcRenderer.invoke("${channel}", args ?? {})`);
      expect(body).not.toMatch(/\(\s*agentId\s*\)/);
    }
  });

  it("guards every new IPC with the trusted sender and active-agent resolution", () => {
    expect(main).toContain("const ACTIVE_AGENT_TIMEOUT_MS = 2e3;");
    expect(main).toContain("const CONVERSATION_UI_TIMEOUT_MS = 5e3;");
    expect(main).toContain("const MEMORY_UI_TIMEOUT_MS = 3e3;");
    expect(main).toContain('callOpenBotProviderRpc("getProviderConfig", selectedAgentId ? { agentId: selectedAgentId } : {}, { timeoutMs: ACTIVE_AGENT_TIMEOUT_MS })');
    expect(main).toContain("next.agentId = active.agentId;");
    expect(main).toContain("const createStaleActiveAgentError");
    expect(main).toContain('error.code = "stale-active-agent"');
    expect(main).toContain("expectedAgentId");
    for (const channel of [
      '"sand:conversation-list"',
      '"sand:conversation-active"',
      '"sand:conversation-create"',
      '"sand:conversation-activate"',
      '"sand:conversation-rename"',
      '"sand:conversation-archive"',
      '"sand:conversation-delete"',
      '"sand:memory-settings-get"',
      '"sand:memory-settings-set"',
      '"sand:memory-list"',
      '"sand:memory-list-page"',
      '"sand:memory-update"',
      '"sand:memory-delete"',
      '"sand:memory-status-get"',
      '"sand:memory-history-search"',
    ]) {
      const handler = ipcHandler(main, channel.slice(1, -1));
      expect(handler).toContain("assertTrustedSecretsSender");
      expect(handler).toContain("assertOpenBotLocalMode()");
      expect(handler).toContain("withActiveOpenBotAgent");
      expect(handler.indexOf("assertTrustedSecretsSender")).toBeLessThan(handler.indexOf("withActiveOpenBotAgent"));
    }
    expect(main).toContain("sanitizeConversationPage");
    expect(main).toContain("sanitizeMemoryPage");
    expect(main).toContain("sanitizeMemoryStatus");
    expect(main).not.toContain("snapshotJson");
    expect(main).not.toContain("revisions:");
  });

  it("keeps the real renderer gate bounded, accessible, teardown-safe and neutral", () => {
    expect(memoryUi).toContain('const MOTION_EASING = "cubic-bezier(.22,1,.36,1)"');
    expect(memoryUi.match(/new MutationObserver/g)).toHaveLength(1);
    expect(memoryUi).toContain("@media (max-width:520px)");
    expect(memoryUi).not.toContain("--cursor-accent");
    expect(memoryUi).not.toContain("#599ce7");
    expect(memoryUi).not.toContain("linear-gradient");
    expect(visual).toContain("hasMemoryScript");
    expect(visual).not.toContain("buttonRect?.width");
    expect(visual).not.toContain("iconRect?.width");
    expect(visual).toContain("reducedState.transitionDuration !== \"0s\"");
    expect(p23Verifier).toContain('step("Escape closes the surface and releases the app root"');
    expect(p23Verifier).toContain('step("pagehide closes the surface and discards uncommitted staging"');
  });

  it("keeps idle mounting idempotent and ignores mutations produced by its own surfaces", () => {
    expect(functionBody(memoryUi, "renderMemorySection")).toContain("root.dataset.renderKey === renderKey");
    expect(functionBody(memoryUi, "startObserver")).toContain("!isOwnMutation(record)");
    expect(functionBody(memoryUi, "startObserver")).toContain("mutationNeedsMemoryScan(record)");
    expect(functionBody(memoryUi, "scan")).toContain("scanInFlight");
    expect(memoryUi).toContain("return scan();");
  });

  it("keeps the mounted memory section while a native menu or modal hides the app", () => {
    const start = memoryUi.indexOf("function ensureMemorySection(");
    const ensure = memoryUi.slice(start, memoryUi.indexOf("\n  function ", start + 1));
    expect(ensure.indexOf("if (existing?.isConnected && modalLayerOpen()) return existing;")).toBeGreaterThan(-1);
    expect(ensure.indexOf("modalLayerOpen()")).toBeLessThan(ensure.indexOf("existing?.remove();"));
    const layerOpen = (layers: Array<{ rects: number }>) => new Function("document", "MODAL_LAYER_SELECTOR", `${functionBody(memoryUi, "modalLayerOpen")}; return modalLayerOpen;`)(
      { querySelectorAll: (selector: string) => (selector.includes('[role="menu"]') ? layers.map(({ rects }) => ({ getClientRects: () => ({ length: rects }) })) : []) },
      '.ui-menu__backdrop,[role="menu"],[role="dialog"][aria-modal="true"],[role="alertdialog"]',
    )();
    expect(layerOpen([{ rects: 1 }])).toBe(true);
    expect(layerOpen([{ rects: 0 }])).toBe(false);
    expect(layerOpen([])).toBe(false);
  });

  it("loads the memory manager through bounded server pages", () => {
    expect(memoryUi).toContain("api.listMemoriesPage");
    expect(memoryUi).toContain('data-action="set-scope"');
    expect(memoryUi).toContain("state.nextCursor");
    expect(memoryUi).toContain('data-action="load-next-memory-page"');
    expect(memoryUi).not.toContain("api.listMemories({ limit: MEMORY_FETCH_LIMIT");
  });

  it("can mount the memory section either under the injected provider panel or the expanded native settings panel", () => {
    expect(memoryFlow).toContain("async function providerSettingsVisible(cdp)");
    expect(memoryFlow).toContain("async function memorySectionVisible(cdp)");
    expect(memoryFlow).toContain("waitForMemoryUiIfNativeSettingsVisible");
    expect(memoryFlow).toContain('state?.ariaExpanded !== "true"');
    expect(memoryFlow).not.toContain('window.dispatchEvent(new Event("openbot:memory-ui-rescan"))');
    expect(functionBody(memoryUi, "mutationNeedsMemoryScan")).toContain("#openbot-provider-settings");
    expect(functionBody(memoryUi, "startObserver")).toContain('attributeFilter: ["aria-expanded", "aria-current", "data-active"]');
  });

  it("forces the native conversation-details panel visible only when expanded and can use it as a settings mount", () => {
    const findMount = functionBody(localSettings, "findExpandedConversationDetailsMount");
    const ensureVisible = functionBody(localSettings, "ensureConversationDetailsVisible");
    const scan = functionBody(localSettings, "scan");
    const handleSettingsClick = functionBody(localSettings, "handleSettingsButtonClick");
    expect(findMount).toContain('element.getAttribute("aria-expanded") === "true"');
    expect(ensureVisible).toContain('const expanded = button?.getAttribute("aria-expanded") === "true" || responsiveOpen');
    expect(ensureVisible).toMatch(/if \(!expanded\)[\s\S]*removeProperty\("display"\)[\s\S]*delete current\.dataset\.openbotForcedVisible/);
    expect(ensureVisible.indexOf("if (!expanded)")).toBeLessThan(ensureVisible.indexOf('panel.removeAttribute("data-openbot-hide")'));
    expect(ensureVisible).toContain('current.style.setProperty("display", "block", "important")');
    expect(scan).toContain("Date.now() >= settingsOpenGraceUntil");
    expect(handleSettingsClick).toContain("Date.now() + 1500");
    expect(memoryFlow).toContain("controlledPanel.display === \"none\"");
    expect(memoryFlow).toContain("attempts[attempts.length - 1].opened = await waitForMemoryUiIfNativeSettingsVisible");
  });

  it("preserves a failed memory edit and discards a late section failure after switching bots", async () => {
    const state = { pendingMemoryId: null, alert: "", error: "", searchTimer: 0, loadToken: 0, editingId: "m1", editText: "rascunho", pendingFocus: null };
    const start = memoryUi.indexOf("const commit = async");
    const end = memoryUi.indexOf('body.addEventListener("input"', start);
    const commit = runInNewContext(`${memoryUi.slice(start, end)} commit`, {
      state, current: () => true, clearLocalTimeout: () => {}, render: () => {},
      ensureCurrentAgentBinding: async () => "alpha", sanitizeError: () => "offline",
    });
    await commit("m1", async () => { throw new Error("offline"); });
    expect(state).toMatchObject({ editText: "rascunho", editingId: "m1", error: "", alert: "offline", pendingMemoryId: null });

    let current = true;
    let reject!: (error: Error) => void;
    const sectionState = { agentId: "alpha", loading: false, error: "" };
    const section = { isConnected: true };
    const load = runInNewContext(`async ${functionBody(memoryUi, "loadMemorySection")} loadMemorySection`, {
      memorySectionState: sectionState, createAgentBinding: () => ({}), isBindingCurrent: () => current,
      document: { getElementById: () => section }, MEMORY_SECTION_ID: "memory",
      renderMemorySection: () => {}, sanitizeError: () => "late error",
      ensureCurrentAgentBinding: () => new Promise((_resolve, fail) => { reject = fail; }),
      desktopAgent: () => ({}),
    });
    const pending = load();
    current = false;
    Object.assign(sectionState, { agentId: "beta", loading: true, error: "" });
    reject(new Error("late error"));
    await pending;
    expect(sectionState).toEqual({ agentId: "beta", loading: true, error: "" });
  });

  it("mounts into the settings memory slot synchronously and keeps the standalone fallback", () => {
    expect(memoryUi).toContain('const MEMORY_SLOT_ID = "openbot-memory-slot"');
    expect(memoryUi).toContain('window.addEventListener("openbot:settings-mounted", () => mountMemorySectionNow())');
    const resolve = functionBody(memoryUi, "resolveMemoryMount");
    expect(resolve).toContain("findVisibleProviderSettingsRoot()");
    expect(resolve).toContain("providerRoot.querySelector(`#${MEMORY_SLOT_ID}`)");
    expect(resolve).toContain("{ parent: slot, slotted: true }");
    expect(resolve).toContain("{ parent: providerRoot, slotted: false }");
    expect(resolve).toContain("findExpandedNativeSettingsRoot()");
    const mountNow = functionBody(memoryUi, "mountMemorySectionNow");
    expect(mountNow).toContain("ensureMemorySection(mount, { fetch: false })");
    expect(mountNow).not.toContain("scheduleScan(80)");
    expect(functionBody(memoryUi, "startObserver")).toContain("if (memorySlotNeedsMount()) mountMemorySectionNow();");
    expect(functionBody(memoryUi, "mutationNeedsMemoryScan")).toContain("#${MEMORY_SLOT_ID}");
    const markup = functionBody(memoryUi, "memorySectionMarkup");
    expect(markup).toContain('variant === "standalone" ? `<h3 class="ob-mem-heading"');
    expect(markup).toContain('name="openbot-memory-mode"');
    expect(markup).toContain('data-action="open-memory-manager">Gerenciar<span class="ob-sr-only"> memória</span>');
    expect(markup).toContain('data-action="retry-memory-section"');
    // Loads once per mounted element; re-renders update the DOM in place without refetching.
    const ensure = memoryUi.slice(memoryUi.indexOf("function ensureMemorySection("), memoryUi.indexOf("function mountMemorySectionNow("));
    expect(ensure).toContain("!fetchedSections.has(root)");
    expect(ensure).toContain("fetchedSections.add(root)");
    expect(functionBody(memoryUi, "renderMemorySection")).not.toContain("innerHTML");
    expect(functionBody(memoryUi, "renderMemorySection")).not.toContain("loadMemorySection");
  });

  it("never shows raw IPC or technical errors and keeps human pt-BR messages", () => {
    const sanitize = runInNewContext(`${functionBody(memoryUi, "sanitizeError")} sanitizeError`, {
      Error,
      STALE_ACTIVE_AGENT_MESSAGE: "Bot ativo mudou; abra novamente.",
      TECHNICAL_ERROR_PATTERN: runInNewContext(memoryUi.match(/const TECHNICAL_ERROR_PATTERN = (\/.*\/i);/)![1]!),
      PT_BR_HINT_PATTERN: runInNewContext(memoryUi.match(/const PT_BR_HINT_PATTERN = (\/.*\/i);/)![1]!),
    });
    const fallback = "Não foi possível carregar a memória.";
    expect(sanitize(new Error("Error invoking remote method 'sand:memory-status-get': Error: connect ECONNREFUSED 127.0.0.1:9"), fallback)).toBe(fallback);
    expect(sanitize(new Error("Error invoking remote method 'sand:memory-settings-get': TypeError: Cannot read properties of undefined"), fallback)).toBe(fallback);
    expect(sanitize(new Error("Error invoking remote method 'sand:memory-list-page': Error: Memória não encontrada"), fallback)).toBe("Memória não encontrada");
    expect(sanitize(new Error("Error invoking remote method 'sand:memory-settings-set': Error: OpenBot active agent changed; stale request."), fallback)).toBe("Bot ativo mudou; abra novamente.");
    expect(sanitize(Object.assign(new Error("anything"), { code: "stale-active-agent" }), fallback)).toBe("Bot ativo mudou; abra novamente.");
    expect(sanitize(new Error("Error invoking remote method 'sand:memory-status-get': Error: RPC timed out after 3000ms"), fallback)).toBe("A memória demorou para responder. Tente novamente.");
    expect(sanitize("", fallback)).toBe(fallback);
    expect(sanitize({ message: "Error invoking remote method" }, fallback)).toBe(fallback);
  });

  it("summarizes memory status in one human line", () => {
    const helpers = runInNewContext(`${functionBody(memoryUi, "memoryCountLabel")}\n${functionBody(memoryUi, "memoryJobsLabel")}\n${functionBody(memoryUi, "summarizeMemoryStatus")}\n({ memoryCountLabel, memoryJobsLabel, summarizeMemoryStatus })`);
    const status = (active: number, jobs: Record<string, unknown> = {}) => ({ counts: { active }, jobs: { pending: 0, running: 0, retry: 0, dead: [], ...jobs } });
    expect(helpers.memoryCountLabel(status(0))).toBe("Sem memórias salvas");
    expect(helpers.memoryCountLabel(status(1))).toBe("1 memória salva");
    expect(helpers.memoryCountLabel(status(3))).toBe("3 memórias salvas");
    expect(helpers.memoryJobsLabel(status(3))).toBe("");
    expect(helpers.memoryJobsLabel(status(3, { pending: 1, running: 1, dead: [{ lastErrorText: "segredo interno" }] }))).toBe("2 em processamento · 1 com falha");
    expect(helpers.summarizeMemoryStatus(status(3, { retry: 1 }), "agent")).toBe("3 memórias salvas · 1 em processamento");
    expect(helpers.summarizeMemoryStatus(status(0), "agent")).toBe("");
    expect(helpers.summarizeMemoryStatus(status(2, { dead: [{}] }), "user")).toBe("1 com falha");
    for (const value of [status(0), status(2, { pending: 1, dead: [{ lastErrorText: "segredo interno do job" }] })]) {
      const text = `${helpers.memoryCountLabel(value)} ${helpers.memoryJobsLabel(value)} ${helpers.summarizeMemoryStatus(value)}`;
      expect(text).not.toMatch(/memórias ativas|Sem processamentos pendentes|segredo interno/);
    }
  });

  it("saves memory modes optimistically, coalesces rapid changes and reverts on failure", async () => {
    const pending: Array<{ mode: string; resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
    const renders: string[] = [];
    const state: Record<string, unknown> = { agentId: "alpha", loading: false, savingMode: false, mode: "off", confirmedMode: "off", modeRevision: 0, queuedMode: null, retryMode: null, status: { counts: { active: 0 } }, error: "" };
    const section = { isConnected: true };
    const context = {
      memorySectionState: state,
      MEMORY_SECTION_ID: "memory",
      MEMORY_MODE_VALUES: ["automatic", "explicit", "off"],
      HTMLInputElement: class {},
      document: { getElementById: () => section },
      createAgentBinding: () => ({ expectedAgentId: "alpha" }),
      isBindingCurrent: () => true,
      ensureCurrentAgentBinding: async () => "alpha",
      desktopAgent: () => ({ setMemorySettings: ({ mode }: { mode: string }) => new Promise((resolve, reject) => pending.push({ mode, resolve, reject })) }),
      renderMemorySection: () => renders.push(String(state.mode)),
      sanitizeError: (_error: unknown, fallback: string) => fallback,
    };
    const api = runInNewContext(`${functionBody(memoryUi, "normalizeMemoryMode")}\nasync ${functionBody(memoryUi, "saveMemoryMode")}\n${functionBody(memoryUi, "handleMemoryModeChange")}\n({ handleMemoryModeChange })`, context);
    const change = (value: string) => {
      const target = Object.assign(new context.HTMLInputElement(), { name: "openbot-memory-mode", value });
      api.handleMemoryModeChange({ target });
    };
    change("explicit");
    await settle();
    expect(state).toMatchObject({ mode: "explicit", savingMode: true });
    change("automatic");
    change("explicit");
    change("automatic");
    expect(pending).toHaveLength(1);
    expect(state).toMatchObject({ mode: "automatic", queuedMode: "automatic" });
    pending[0]!.resolve({ mode: "explicit" });
    await settle();
    expect(pending.map((call) => call.mode)).toEqual(["explicit", "automatic"]);
    expect(state).toMatchObject({ confirmedMode: "explicit", mode: "automatic", savingMode: true, queuedMode: null });
    pending[1]!.reject(new Error("Error invoking remote method 'sand:memory-settings-set': Error: boom"));
    await settle();
    expect(state).toMatchObject({ mode: "explicit", confirmedMode: "explicit", savingMode: false, retryMode: "automatic", error: "Não foi possível salvar o modo de memória." });
    expect(renders.at(-1)).toBe("explicit");
  });

  it("pins focus recovery and accessible memory UI announcements", () => {
    expect(visual).toContain("MEMORY_UI_MEMORY_FOCUS");
    expect(visual).toContain('memoryFocus.activeDataRole !== "memory-text"');
    expect(visual).toContain('memoryFocus.statusRole !== "status"');
    expect(visual).toContain("memoryFocus.describedBy?.includes(\"openbot-memory-dialog-status\")");
    expect(visual).toContain("MEMORY_UI_MEMORY_FORGET_FOCUS");
    expect(visual).toContain('forgetFocus.activeAction !== "forget-cancel"');
    expect(visual).toContain("MEMORY_UI_MEMORY_CLOSE_FOCUS");
    expect(visual).toContain('memoryValidation.invalid !== "true"');
    expect(visual).toContain('memoryValidation.alertRole !== "alert"');
  });

  it("ships a real bridge verifier without the renderer mock override", () => {
    const bridgeReal = readFileSync(resolve(root, "scripts/bridge-real-verify.mjs"), "utf8");
    expect(bridgeReal).toContain("const value = await window.desktop.agent[");
    expect(bridgeReal).toContain('call("createConversation",');
    expect(bridgeReal).toContain('call("getActiveConversation",');
    expect(bridgeReal).toContain('call("deleteMemory",');
    expect(bridgeReal).toContain('expectedAgentId: "agent-a"');
    expect(bridgeReal).toContain("BRIDGE_REAL_GREEN");
    expect(bridgeReal).not.toContain("__openbotMemoryUiAgent");
  });

  it("ships a memory-flow E2E verifier on the real bridge without renderer stubs", () => {
    expect(memoryFlow).toContain('import("../dist/main.js")');
    expect(memoryFlow).toContain("Input.insertText");
    expect(memoryFlow).toContain("Gerenciar memória");
    expect(memoryFlow).toContain("MEMORY_FLOW_E2E_GREEN");
    expect(memoryFlow).not.toContain("__openbotMemoryUi");
    expect(memoryFlow).not.toContain('setAttribute("aria-expanded"');
    expect(packageJson).toContain('"verify:memory-flow-e2e"');
  });

  it("P2.2 ships the typed async-task bridge in preload and main with guard rails", () => {
    const methods = {
      getAsyncTasks: "sand:async-task-list",
      getSubagents: "sand:async-task-list",
      listAsyncTasks: "sand:async-task-list",
      getAsyncTask: "sand:async-task-get",
      abortAsyncTask: "sand:async-task-abort",
      steerAsyncTask: "sand:async-task-steer",
      openStream: "sand:async-task-stream-start",
      closeStream: "sand:async-task-stream-stop",
    } as const;
    for (const [method, channel] of Object.entries(methods)) {
      expect(exposedMethod(preload, method)).toContain(`ipcRenderer.invoke("${channel}"`);
    }
    expect(preload).toContain("openbot:async-tasks-frame");
    for (const channel of ["sand:async-task-list", "sand:async-task-get", "sand:async-task-abort", "sand:async-task-steer", "sand:async-task-stream-start", "sand:async-task-stream-stop"]) {
      const handler = ipcHandler(main, channel);
      expect(handler).toContain("assertTrustedSecretsSender");
      expect(handler).toContain("assertOpenBotLocalMode()");
      const guardIndex = handler.indexOf("assertTrustedSecretsSender");
      if (channel !== "sand:async-task-stream-stop") {
        expect(handler.includes("withActiveOpenBotAgent") || handler.includes("resolveActiveOpenBotAgent")).toBe(true);
        const resolutionIndexes = [handler.indexOf("withActiveOpenBotAgent"), handler.indexOf("resolveActiveOpenBotAgent")].filter((index) => index >= 0);
        expect(guardIndex).toBeLessThan(Math.min(...resolutionIndexes));
      } else {
        expect(guardIndex).toBeLessThan(handler.indexOf("closeTaskStreams"));
      }
    }
    // Task control RPCs require the owning agent; the handlers send the validated active one.
    for (const [channel, method] of [["sand:async-task-abort", "abortAsyncTask"], ["sand:async-task-steer", "steerAsyncTask"]] as const) {
      expect(ipcHandler(main, channel)).toContain(`callOpenBotProviderRpc("${method}", { agentId: next.agentId,`);
    }
    expect(main).toContain("sanitizeAsyncTaskRecord");
    expect(main).toContain("closeTaskStreams");
    expect(main).toContain('headers["last-event-id"]');
    expect(main).toContain("openbot:async-tasks-frame");
    expect(main).not.toMatch(/async-task.*new EventSource/);
  });

  it("P2.2 keeps the overlay bounded, XSS-safe, polling-free and teardown-safe", () => {
    expect(visual).toContain('import { runP22TasksFixture } from "./electron-p22-fixture.mjs"');
    expect(visual).toContain("const p22Evidence = await runP22TasksFixture");
    expect(visual).toContain("if (!p22Evidence.ok)");
    expect(p22Fixture).toContain('step("tasks dialog opens with modal semantics"');
    expect(p22Fixture).toContain('step("malicious content rendered as text (XSS)"');
    expect(p22Fixture).toContain('mixed.pwned === null && !mixed.injectedImg && !mixed.injectedScript');
    expect(p22Fixture).toContain('step("resync snapshot replaces without duplicates"');
    expect(p22Fixture).toContain('step("Escape closes and restores focus"');
    expect(p22Fixture).toContain('step("pagehide closes dialog and stream"');
    expect(p22Fixture).toContain('step("pagehide tears down stream once (no accumulation)"');
    expect(p22Fixture).toContain('step("idle overlay does not poll or create interval timers"');
    expect(p22Fixture).toContain("afterIdle.listCalls === beforeIdle.listCalls && afterIdle.intervalCalls === 0");
  });
});
