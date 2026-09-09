import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.):/, "$1:"));
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
