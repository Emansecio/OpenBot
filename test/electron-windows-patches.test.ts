import { readFileSync } from "node:fs";
import { resolve, win32 } from "node:path";
import { runInNewContext } from "node:vm";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.):/, "$1:"));
const main = readFileSync(resolve(root, "client/extracted/dist/electron-main/main.cjs"), "utf8");
const settings = readFileSync(resolve(root, "client/extracted/dist/renderer/assets/openbot-local-settings.js"), "utf8");
const rendererHtml = readFileSync(resolve(root, "client/extracted/dist/renderer/index.html"), "utf8");
const preload = readFileSync(resolve(root, "client/extracted/dist/electron-preload/preload.cjs"), "utf8");
const launcher = readFileSync(resolve(root, "scripts/openbot-desktop.cmd"), "utf8");
const gatewayHealth = readFileSync(resolve(root, "scripts/gateway-health.mjs"), "utf8");
const gatewayStarter = readFileSync(resolve(root, "scripts/start-gateway.mjs"), "utf8");
const hiddenLauncher = readFileSync(resolve(root, "scripts/openbot-desktop.vbs"), "utf8");
const shortcutSmoke = readFileSync(resolve(root, "scripts/smoke-shortcut.ps1"), "utf8");
const coordinator = readFileSync(resolve(root, "client/extracted/dist/node-agent-coordinator/main.cjs"), "utf8");
const cleanProfile = readFileSync(resolve(root, "scripts/verify-clean-profile.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

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
      isVisibleElement: () => true,
      document: { querySelectorAll: (selector: string) => selector === ".sand-agent-item[data-agent-id]" ? [row] : [] },
    });
    return expect(resolveSelected()).resolves.toBe("selected-bot");
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
  it.each([false, true])("sets the window and taskbar identity before loading main (installed=%s)", installed => {
    const bootstrap = readFileSync(resolve(root, "scripts/openbot-electron.cjs"), "utf8");
    const events: string[] = [];
    const windowImage = { isEmpty: () => false };
    const loadedImages: string[] = [];
    let created: (_event: unknown, window: { setIcon: (image: unknown) => void; setAppDetails: (details: unknown) => void; webContents: { on: (event: string, handler: () => void) => void } }) => void;
    let icon: unknown;
    let details: unknown;
    runInNewContext(bootstrap, {
      __dirname: "C:\\OpenBot Test\\scripts",
      process: { platform: "win32", env: { SystemRoot: "C:\\Windows", ...(installed ? { OPENBOT_RELEASE_ROOT: "C:\\Installed\\versions\\v1", OPENBOT_INSTALL_ROOT: "C:\\Installed" } : {}) } },
      require(id: string) {
        if (id === "node:path") return win32;
        if (id === "node:url") return { pathToFileURL };
        if (id === "electron") return { nativeImage: {
          createFromPath(path: string) { loadedImages.push(path); return windowImage; },
        }, app: {
          setName(name: string) { events.push(name); },
          setAppUserModelId(appId: string) { events.push(appId); },
          on(event: string, handler: typeof created) { if (event === "browser-window-created") created = handler; },
        } };
        expect(id).toBe("../client/extracted/dist/electron-main/main.cjs");
        events.push("main");
        created(null, { setIcon(value) { icon = value; }, setAppDetails(value) { details = value; }, webContents: { on() {} } });
      },
    });
    expect(events).toEqual(["OpenBot", "OpenBot.Desktop", "main"]);
    const expectedIcon = installed ? "C:\\Installed\\versions\\v1\\assets\\openbot.ico" : "C:\\OpenBot Test\\assets\\openbot.ico";
    expect(icon).toBe(windowImage);
    expect(loadedImages).toEqual([expectedIcon.replace(/\.ico$/, ".png"), expectedIcon]);
    expect(details).toEqual({
      appId: "OpenBot.Desktop", appIconPath: expectedIcon, appIconIndex: 0,
      relaunchCommand: installed ? '"C:\\Windows\\System32\\wscript.exe" "C:\\Installed\\OpenBot.vbs"' : '"C:\\Windows\\System32\\wscript.exe" "C:\\OpenBot Test\\scripts\\openbot-desktop.vbs"',
      relaunchDisplayName: "OpenBot",
    });
    expect(launcher).toContain('"%CD%\\scripts\\openbot-electron.cjs"');
  });

  it.each([".ico", ".png"])("refuses missing %s branding instead of using Electron defaults", extension => {
    const bootstrap = readFileSync(resolve(root, "scripts/openbot-electron.cjs"), "utf8");
    let mainLoaded = false;
    expect(() => runInNewContext(bootstrap, {
      __dirname: "C:/OpenBot/scripts",
      process: { platform: "win32", env: {} },
      require(id: string) {
        if (id === "node:path") return win32;
        if (id === "node:url") return { pathToFileURL };
        if (id === "electron") return {
          app: {}, nativeImage: { createFromPath: (path: string) => ({ isEmpty: () => path.endsWith(extension) }) },
        };
        mainLoaded = true;
      },
    })).toThrow(/icons are missing or invalid/);
    expect(mainLoaded).toBe(false);
  });

  it("confirms Start-menu taskbar registration before starting the gateway", () => {
    expect(launcher).toContain('setup-desktop-shortcut.mjs" --taskbar-only');
    expect(launcher.indexOf('setup-desktop-shortcut.mjs" --taskbar-only')).toBeLessThan(launcher.indexOf('set "GATEWAY_STARTED=0"'));
    expect(launcher).toMatch(/--taskbar-only\r?\nif errorlevel 1 \([\s\S]*?exit \/b 1/);
  });

  it("routes maintained desktop verification through the branded production entrypoint", () => {
    for (const script of [
      "visual-ui-verify.mjs", "bridge-real-verify.mjs", "electron-p22-tasks-verify.mjs",
      "electron-p23-verify.mjs", "electron-p27-profile.mjs", "memory-flow-e2e.mjs",
      "verify-clean-profile.mjs", "e2e-desktop-run.ps1",
    ]) {
      const source = readFileSync(resolve(root, "scripts", script), "utf8");
      expect(source, script).toMatch(/(?:const electronMain|\$electronMain)[^\r\n]*openbot-electron\.cjs/);
      if (script === "e2e-desktop-run.ps1") expect(source).toContain("Stop-OwnTree -ProcessId $electronProcess.Id -ExpectedCommandPart $electronMain -ExpectedRoot $userData");
    }
    expect(readFileSync(resolve(root, "scripts/visual-electron.cmd"), "utf8"))
      .toContain('scripts\\openbot-electron.cjs');
    expect(packageJson.scripts["desktop:shortcut"]).toBe("node scripts/setup-desktop-shortcut.mjs");
    expect(packageJson.scripts["verify:desktop-identity"]).toContain("test/desktop-identity.test.ts");
  });

  it("aligns user and assistant chat bubbles on opposite sides", () => {
    expect(settings).toContain('.sand-transcript-row[data-role="user"],.sand-transcript-row[data-openbot-side="user"]{align-items:flex-end!important}');
    expect(settings).toContain('.sand-transcript-row[data-role="assistant"],.sand-transcript-row[data-openbot-side="assistant"]{align-items:flex-start!important}');
    expect(settings).toContain('.sand-transcript-row:is([data-role="user"],[data-openbot-side="user"]) .sand-author-run{justify-content:flex-end!important}');
    expect(settings).toContain('.sand-transcript-row:is([data-role="user"],[data-openbot-side="user"]) .sand-author-run__column{flex:0 1 auto!important;max-width:calc(100% - 30px)!important;align-items:flex-end!important}');
    expect(settings).toContain("function classifyTranscriptRows()");
  });

  it("persists a real OpenAI reasoning effort from bot settings", () => {
    expect(settings).toContain('id="openbot-reasoning"');
    expect(settings).toContain('reasoningEffort: reasoningEl.value');
    expect(settings).toContain('reasoningEl.value = state.reasoningEffort || "medium"');
  });

  it("bounds OAuth status retries and caches model catalog reads", () => {
    const oauthPoll = between(settings, "const pollOAuth = async", "const bindFolderOpen");
    expect(oauthPoll).toContain("catch (error)");
    expect(oauthPoll).toContain("failures >= 5");
    expect(oauthPoll).toContain("Math.min(8000");
    expect(settings).toContain("getAvailableModelsCached");
    expect(settings).toContain("Date.now() + 30_000");
  });

  it("guards the real remote MCP marketplace path only in explicit local mode", () => {
    expect(main).toMatch(/async function fetchMarketplaceMcpPlugins[\s\S]{0,1200}client\.listMarketplacePlugins/);
    expect(main).toMatch(/async getCatalog\(getAccessToken, options\) \{[\s\S]{0,300}OPENBOT_LOCAL_GATEWAY === "1"\) return \[\];[\s\S]{0,500}fetchMarketplaceMcpPlugins/);
    expect(main).toMatch(/fillCatalogCacheBeforeRendererReads\(\) \{[\s\S]{0,250}OPENBOT_LOCAL_GATEWAY === "1"\) return;/);
    expect(main).toContain("new BrokeredHostConnector");
    expect(main).not.toContain('OPENBOT_LOCAL_GATEWAY !== "0"');
    expect(main).toContain('OPENBOT_LOCAL_GATEWAY !== "1" && process.env.VITE_DEV_SERVER_URL');
    expect(main).toMatch(/pollAuthenticationStatus[\s\S]{0,300}OPENBOT_LOCAL_GATEWAY === "1"\) return null/);
  });

  it("keeps auth local while adapting the legacy renderer account slot", () => {
    expect(main).toMatch(/getStatus: async \(\) => \(\{ kind: "local" \}\)/);
    expect(main).toContain('getStatus -> {kind:"local"}');
    expect(main).toMatch(/function cursorRendererStatus\(status\) \{\s+if \(status\.kind === "local"\) return \{ kind: "logged-in", authId: "openbot-local" \};/);
    expect(main).toContain('deps.broadcast("sand:cursor-auth-event", cursorRendererStatus(status));');
    expect(main).toMatch(/"sand:cursor-auth-status"[\s\S]{0,250}return cursorRendererStatus\(await service\.getStatus\(\)\)/);
    expect(main).toContain("OpenBot: no Cursor credentials (T15 local profile)");
    expect(main).toMatch(/function cursorAccountSlot\(status\) \{\s+if \(status\.kind === "local"\) return "openbot-local";/);
  });

  it("exposes client persistence on the renderer agent bridge", () => {
    const persistence = between(preload, "var clientPersistence = {", "var desktop = {");
    expect(persistence).toContain("migrateFromLocalStorage(entries)");
    expect(preload).toMatch(/agent: \{\s+clientPersistence,/);
    expect(preload).toContain("\n  clientPersistence,\n");
  });

  it("routes default-model RPCs through the authenticated local helper", () => {
    const settingsIpc = between(main, "function registerSettingsIpc(deps)", "function registerToolPermissionsIpc");
    const localRpc = between(main, "const callOpenBotProviderRpc = async", "const assertOpenBotLocalMode");
    const settingsWiring = between(main, "registerSettingsIpc({", "registerToolPermissionsIpc({");

    expect(settingsIpc).toMatch(/"sand:agent-default-model-get"[\s\S]{0,250}callOpenBotProviderRpc2\("getAgentDefaultModel"\)/);
    expect(settingsIpc).toMatch(/"sand:agent-default-model-set"[\s\S]{0,300}callOpenBotProviderRpc2\("setAgentDefaultModel", \{ model: modelId \}\)/);
    expect(settingsWiring).toContain("callOpenBotProviderRpc,");
    expect(localRpc).toMatch(/if \(token\) headers\.Authorization = `Bearer \$\{token\}`;[\s\S]{0,250}fetch\(new URL\(`\/api\/\$\{method\}`/);
    expect(settingsIpc).not.toMatch(/fetch\(/);
  });

  it("reads local gateway credentials from the explicit OpenBot data root", () => {
    const connector = between(main, "function createRemoteHostConnector", "// src/electron-main/box/box-migration-watcher.ts");
    const localRpc = between(main, "const callOpenBotProviderRpc = async", "const assertOpenBotLocalMode");

    expect(connector).toMatch(/const tokenRoot = env\.OPENBOT_DATA_ROOT\?\.trim\(\)[\s\S]{0,180}path\.join\(tokenRoot, "gateway\.token"\)/);
    expect(localRpc).toMatch(/const tokenRoot = process\.env\.OPENBOT_DATA_ROOT\?\.trim\(\)[\s\S]{0,180}path\.join\(tokenRoot, "gateway\.token"\)/);
  });

  it("hydrates the local gateway token before accepting an explicit loopback URL", () => {
    const connectorStart = main.indexOf("function createRemoteHostConnector");
    const localModeBranch = main.indexOf('if (env.OPENBOT_LOCAL_GATEWAY === "1")', connectorStart);
    const explicitUrlBranch = main.indexOf('if ((env[GATEWAY_URL_ENV]?.trim() ?? "").length > 0)', connectorStart);

    expect(connectorStart).toBeGreaterThanOrEqual(0);
    expect(localModeBranch).toBeGreaterThan(connectorStart);
    expect(explicitUrlBranch).toBeGreaterThan(localModeBranch);
    const localMode = main.slice(localModeBranch, explicitUrlBranch);
    expect(localMode).toMatch(/let localToken = env\[GATEWAY_TOKEN_ENV\][\s\S]{0,500}readFileSync\(tokenFile, "utf8"\)\.trim\(\)/);
    expect(localMode).toMatch(/\[GATEWAY_URL_ENV\]: env\[GATEWAY_URL_ENV\]\?\.trim\(\) \|\| "http:\/\/127\.0\.0\.1:1340"/);
    expect(localMode).toMatch(/return new EnvDescriptorHostConnector\([\s\S]{0,280}\[GATEWAY_TOKEN_ENV\]: localToken/);
  });

  it("captures a stable agent/provider for settings operations", async () => {
    expect(settings).toContain("settingsContextKey(host, scope)");
    expect(settings).toContain("root.dataset.agentId = activeAgentId");
    expect(settings).toContain("getProviderConfig(agentId)");
    expect(settings).toContain("agentId: activeAgentId, provider, model: modelEl.value");
    expect(settings).toContain("const provider = providerEl.value");
    expect(settings).toContain("oauth[provider]");
    expect(settings).toContain(".catch(() => undefined)");
    expect(settings).toContain("saveEl.disabled = true");
    expect(settings).toMatch(/loadState\([^;\n]*globalScope\)/);
    expect(settings).not.toContain("api.agent.getDefaultModel().catch");
    expect(settings).not.toContain("api.agent.getActiveProvider().catch");
    expect(settings).not.toContain('value="openai-compat"');
    expect(settings).toContain('root.dataset.contextKey === settingsContextKey(null, root.dataset.scope)');
    expect(settings).toContain('selectedAgentRow()?.getAttribute("data-agent-id")');
    expect(settings).toContain('document.getElementById("sand-settings-panel-general")');
    expect(settings).toContain('renderSettings(mount, globalMount ? "global" : "agent")');
    expect(settings).toContain('turnId: current.turnId, scope: "current"');
    expect(settings).toContain('button.textContent = "Tentar parar"');
    let selected = "agent-a";
    let save!: (event: unknown, request: Record<string, unknown>) => Promise<unknown>;
    let writes = 0;
    runInNewContext(`${between(main, "const normalizeOpenBotUiRequest =", "const sanitizeConversation =")}
      ${between(main, 'import_electron50.ipcMain.handle("sand:provider-config-set"', "const validateOAuthProvider =")}`, {
      import_electron50: { ipcMain: { handle: (_name: string, callback: typeof save) => { save = callback; } } },
      senderGuards: { assertTrustedSecretsSender: () => {} }, assertOpenBotLocalMode: () => {},
      mainWindow: { isDestroyed: () => false, webContents: { executeJavaScript: async () => selected } },
      ACTIVE_AGENT_TIMEOUT_MS: 2000,
      callOpenBotProviderRpc: async (method: string, args: Record<string, unknown>) => {
        if (method === "getProviderConfig") return { agentId: args.agentId ?? "agent-b" };
        if (args.requireActive && args.agentId !== "agent-b") throw new Error("stale gateway selection");
        writes += 1;
        return args;
      },
    });
    const request = { agentId: "agent-a", provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" };
    expect(await save(null, request)).toMatchObject(request);
    selected = "agent-b";
    await expect(save(null, request)).rejects.toThrow("stale request");
    expect(writes).toBe(1);
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
    const scope = { selectedAgentRow: () => ({ getAttribute: () => "agent-a" }), activePromptAgentId: "agent-b" };
    const refresh = runInNewContext(`${between(settings, "async function refreshActivePromptAgent()", "function handleAgentSelectionClick")} refreshActivePromptAgent`, scope);
    expect(await refresh()).toBe("agent-a");
    scope.selectedAgentRow = () => ({ getAttribute: () => "agent-b" });
    expect(await refresh()).toBe("agent-b");
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
      activePromptAgentId: null, promptStatusRevision: 0, lastSendAt: 0,
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

  it("bounds prompt-control IPC and tracks generation per agent", () => {
    expect(main).toContain("PROMPT_CONTROL_TIMEOUT_MS");
    expect(main).toMatch(/callOpenBotProviderRpc\("cancelPrompt", request3 \?\? \{\}, \{ timeoutMs: PROMPT_CONTROL_TIMEOUT_MS \}\)/);
    expect(main).toMatch(/callOpenBotProviderRpc\("retryPrompt", request3 \?\? \{\}, \{ timeoutMs: PROMPT_CONTROL_TIMEOUT_MS \}\)/);
    expect(main).toMatch(/callOpenBotProviderRpc\("getPromptStatus", request3 \?\? \{\}, \{ timeoutMs: PROMPT_STATUS_TIMEOUT_MS \}\)/);
    expect(main).toMatch(/signal: options\.timeoutMs[\s\S]{0,120}AbortSignal\.timeout\(options\.timeoutMs\)/);
    expect(settings).toContain("busyAgentIds");
    expect(settings).toContain("activePromptAgentId");
    expect(settings).toContain("busyAgentIds.has(activePromptAgentId)");
    expect(settings).not.toMatch(/cancelPrompt\?\.\(\{ agentId: config\?\.agentId \}\)/);
  });

  it("bridges OAuth login and the isolated OpenCode Go key through guarded Electron IPC", () => {
    for (const action of ["start", "status", "cancel", "disconnect"]) {
      expect(main).toContain(`"sand:provider-oauth-${action}"`);
      expect(preload).toContain(`"sand:provider-oauth-${action}"`);
    }
    expect(main).toMatch(/"sand:provider-oauth-start"[\s\S]{0,250}assertTrustedSecretsSender[\s\S]{0,300}startProviderOAuth/);
    expect(main).toContain("shell.openExternal(result.authorizationUrl)");
    const providerSave = main.slice(main.indexOf('"sand:provider-config-set"'), main.indexOf('const validateOAuthProvider'));
    expect(providerSave).toContain('if (!["openai", "xai", "opencode-go"].includes(provider))');
    expect(providerSave).not.toContain("apiKey");
    expect(providerSave).not.toContain("setBoxSecrets");
    expect(providerSave).toContain("const reasoningEffort = next.reasoningEffort");
    expect(providerSave).toContain('["minimal", "low", "medium", "high", "xhigh"].includes(reasoningEffort)');
    expect(providerSave).toMatch(/model,\s+reasoningEffort/);
    expect(providerSave).toContain("withActiveOpenBotAgent(next, (bound) => persist(bound.agentId))");
    expect(providerSave).toContain("persist(void 0, true)");
    expect(providerSave).toContain("assertOpenBotLocalMode()");
    expect(main).toMatch(/"sand:(?:active-provider-set|create-agent|cancel-prompt)"[\s\S]{0,220}assertTrustedSecretsSender[\s\S]{0,180}assertOpenBotLocalMode/);
    expect(main).toContain('next.host === here.host');
    expect(settings).toContain("getProviderOAuthStatus");
    expect(settings).toContain("startProviderOAuth(provider)");
    expect(settings).toContain("disconnectProviderOAuth(provider)");
    expect(main).toMatch(/"sand:provider-secret-set"[\s\S]{0,250}assertTrustedSecretsSender[\s\S]{0,350}provider !== "opencode-go"/);
    expect(main).toContain('{ entries: [{ provider: "opencode-go", apiKey }] }');
    expect(preload).toContain('invoke("sand:provider-secret-set", { provider, apiKey })');
    expect(settings).toContain('value="opencode-go"');
    expect(settings).toContain('id="openbot-apikey" type="password"');
    expect(settings).toContain('setProviderApiKey("opencode-go", apiKey)');
    expect(settings).not.toContain('value="openai-compat"');
    expect(settings).not.toContain("api.secrets?.list");
  });

  it("keeps unpackaged HTTP development controls explicit and out of local mode", () => {
    const devWiring = between(main, "function registerDevWiring(deps)", "// src/electron-main/downloads/download-path.ts");
    expect(devWiring).toMatch(/if \(!deps\.isPackaged && process\.env\[SAND_DEV_CAPABILITY_ENV\] === "1" && process\.env\.OPENBOT_LOCAL_GATEWAY !== "1"\) \{\r?\n    startDevControlServer\(/u);
    expect(launcher).toContain('set "SAND_DEV_CAPABILITY="');
    expect(launcher).toContain('set "SAND_DEV_CONTROL_PORT="');
    expect(cleanProfile).toContain("const devControlPort = await freePort(0)");
    expect(cleanProfile).toContain("SAND_DEV_CONTROL_PORT: String(devControlPort)");
    expect(cleanProfile).toContain("await assertDevControlPortFree(electron.devControlPort)");
  });

  it("keeps plaintext secret values out of the renderer bridge", () => {
    const secretBridge = between(preload, "  secrets: {", "  agent: {");
    expect(secretBridge).toMatch(/async reveal\(_key\) \{\r?\n      return null;\r?\n    \}/u);
    expect(preload).not.toContain('"sand:secrets-reveal"');
    expect(main).not.toContain('"sand:secrets-reveal"');
  });

  it("runs the live ACL verification without composing duplicate test-runner options", () => {
    const command = packageJson.scripts["verify:acl:live"];
    expect(command).toContain("npm exec -- vitest run test/home-acl.test.ts");
    expect(command).not.toContain("npm test -- test/home-acl.test.ts");
  });

  it("opens only the canonical active-bot workspace through a guarded bridge", () => {
    expect(main).toMatch(/"sand:open-agent-workspace"[\s\S]{0,250}assertTrustedSecretsSender[\s\S]{0,500}getProviderConfig[\s\S]{0,500}ensureForeverBox/);
    expect(main).toMatch(/const workspace = ensured\?\.root[\s\S]{0,500}path2\.isAbsolute[\s\S]{0,500}path2\.basename[\s\S]{0,500}shell\.openPath/);
    expect(preload).toContain('invoke("sand:open-agent-workspace")');
    expect(preload).not.toContain('invoke("sand:open-agent-workspace", { agentId })');
    expect(settings).toContain("openWorkspace()");
    expect(settings).toContain("openUserDocuments()");
    expect(settings).not.toContain("openWorkspace(activeAgentId)");
    expect(settings).toContain("Abrir Projects");
  });

  it("keeps user-document actions and removes the dedicated WhatsApp setting", () => {
    expect(settings).toContain("openUserDocuments()");
    expect(settings).toContain("Abrir Documents");
    expect(preload).toContain('invoke("sand:open-user-documents")');
    expect(main).toContain('"sand:open-user-documents"');
    expect(settings).not.toMatch(/whatsapp|wacli/i);
    expect(preload).not.toMatch(/agent-whatsapp|getAgentWhatsapp|setAgentWhatsapp/i);
    expect(main).not.toMatch(/agent-whatsapp|getAgentWhatsapp|setAgentWhatsapp/i);
    expect(settings).toContain("Arquivos e runtime");
  });

  it("opens Documents in the active bot's canonical physical home", async () => {
    const marker = '  import_electron50.ipcMain.handle("sand:open-user-documents"';
    const start = main.indexOf(marker);
    const end = main.indexOf('\n  import_electron50.ipcMain.handle(', start + marker.length);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    let handler!: (event: unknown) => Promise<unknown>;
    let agentId = "bot-a";
    let workspace = "C:\\fixture\\workspaces\\bot-a";
    let shellError = "";
    const opened: string[] = [];
    const checked: string[] = [];
    const calls: unknown[] = [];
    runInNewContext(main.slice(start, end), {
      import_electron50: {
        ipcMain: { handle: (_name: string, callback: typeof handler) => { handler = callback; } },
        shell: { openPath: async (path: string) => { opened.push(path); return shellError; } },
      },
      senderGuards: { assertTrustedSecretsSender: (event: unknown) => { expect(event).toBe("trusted"); } },
      process: { env: { OPENBOT_LOCAL_GATEWAY: "1" } },
      callOpenBotProviderRpc: async (method: string, args: unknown) => {
        calls.push([method, args]);
        return method === "getProviderConfig" ? { agentId } : { root: workspace };
      },
      require: (name: string) => name === "node:path" ? win32 : { lstatSync: (path: string) => checked.push(path) },
    });
    await expect(handler("trusted")).resolves.toMatchObject({ ok: true, agentId: "bot-a" });
    agentId = "bot-b";
    workspace = "C:\\fixture\\workspaces\\bot-b";
    await expect(handler("trusted")).resolves.toMatchObject({ ok: true, agentId: "bot-b" });
    expect(opened).toEqual(["C:\\fixture\\workspaces\\bot-a\\Documents", "C:\\fixture\\workspaces\\bot-b\\Documents"]);
    expect(checked).toEqual(opened);
    expect(calls).toContainEqual(["ensureForeverBox", { agentId: "bot-b" }]);
    workspace = "C:\\fixture\\workspaces\\bot-a";
    await expect(handler("trusted")).rejects.toThrow("invalid workspace");
    expect(opened).toHaveLength(2);
    workspace = "C:\\fixture\\workspaces\\bot-b";
    shellError = "unavailable";
    await expect(handler("trusted")).rejects.toThrow("Could not open Documents");
  });

  it("keeps runtime status and repair on their guarded bridges", () => {
    expect(main).toContain('"sand:runtime-status"');
    expect(main).toContain('"sand:runtime-repair"');
    expect(main).toMatch(/"sand:runtime-status"[\s\S]{0,250}assertTrustedSecretsSender[\s\S]{0,250}getLocalRuntimeStatus/);
    expect(main).toMatch(/"sand:runtime-repair"[\s\S]{0,250}assertTrustedSecretsSender[\s\S]{0,250}repairLocalRuntime/);
    expect(preload).toContain('invoke("sand:runtime-status", args ?? {})');
    expect(preload).toContain('invoke("sand:runtime-repair", args ?? {})');
    expect(settings).toContain("getLocalRuntimeStatus");
    expect(settings).toContain("repairLocalRuntime");
    expect(settings).toContain("Reparar runtime");
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

  it("adapts ordered transcript deltas at the approved coordinator seam", () => {
    expect(coordinator).toContain('require("./openbot-transcript-adapter.cjs")');
    expect(coordinator).toContain("createTranscriptSnapshotGate");
    expect(coordinator).toContain("transcriptAdapter.accept");
    expect(coordinator).toContain("coalesce: true");
    expect(coordinator).toContain("transcriptAdapter.markResync");
    expect(coordinator).toContain("transcriptAdapter?.disposeAgent(agentId)");
    expect(readFileSync(resolve(root, "client/extracted/dist/node-agent-coordinator/openbot-transcript-adapter.cjs"), "utf8")).toContain("rendererSequence");
  });

  it("declares responsive, reduced-motion and ARIA affordances for the new actions", () => {
    expect(settings).toContain('class="ob-secret-row"');
    expect(settings).toContain('class="ob-actions"');
    expect(settings).toContain('aria-live="polite"');
    expect(settings).toContain('id="openbot-auth-status"');
    expect(settings).toContain('id="openbot-auth-action"');
    expect(settings).toContain("Escolha o provedor, conecte sua conta e selecione o modelo.");
    expect(settings).toContain('id="openbot-advanced"');
    expect(settings).toContain("@media (max-width:520px)");
    expect(settings).toContain("@media (prefers-reduced-motion:reduce)");
    expect(settings).toContain("var(--cursor-stroke-secondary");
    expect(settings).toContain("var(--cursor-bg-editor");
    expect(settings).toContain("var(--cursor-button-secondary-background");
    expect(settings).not.toContain("--cursor-accent");
    expect(settings).not.toContain("#599ce7");
    expect(settings).toContain("updateStopAnchor(anchor)");
    expect(settings).toContain('button.setAttribute("aria-label", "Parar geração")');
    expect(settings).toContain("isVisibleElement(node.parentElement)");
    expect(settings).toContain("el.getClientRects().length > 0");
    expect(settings).not.toMatch(/position\s*:\s*(?:fixed|absolute)[^}]*ob-(?:secret|workspace)/);
  });

  it("adds bounded, reduced-motion-safe entrance polish without duplicating observers", () => {
    expect(settings).toContain('const MOTION_EASING = "cubic-bezier(.22,1,.36,1)"');
    expect(settings).toContain("surface: { duration: 220");
    expect(settings).toContain("panel: { duration: 260");
    expect(settings).toContain("message: { duration: 280");
    expect(settings).toContain('from: "translate3d(0,8px,0) scale(.97)"');
    expect(settings).toContain('easing: "cubic-bezier(.2,.9,.3,1.15)"');
    expect(settings).toContain("easing: config.easing || MOTION_EASING");
    expect(settings).toContain("function messageMotionRoots");
    expect(settings).toContain("function stampMessageMotion");
    expect(settings).toContain("roots.length !== 1");
    expect(settings).toContain("const target = roots.at(-1)");
    expect(settings).toContain("status: { duration: 180");
    expect(settings).toContain("const animatedElements = new WeakSet()");
    expect(settings).toContain('matchMedia?.("(prefers-reduced-motion: reduce)")');
    expect(settings).toContain("element.animate(keyframes");
    expect(settings).toContain('const keyframes = kind === "panel"');
    expect(settings).toContain('[{ opacity: 0 }, { opacity: 1 }]');
    expect(settings).toContain('const baseTransform = kind === "message" ? element.style.transform.trim() : ""');
    expect(settings).toContain('baseTransform ? `${baseTransform} ${config.from}` : config.from');
    expect(settings).toContain('baseTransform || "translate3d(0,0,0) scale(1)"');
    expect(settings).toContain("requestAnimationFrame(flushMotionQueue)");
    expect(settings).toContain("for (const child of nextBody.children) observePortalRoot(child)");
    expect(settings).toContain('window.addEventListener("pagehide", cleanupLocalUi');
    expect(settings).toContain("addedNodes");
    expect(settings.match(/new MutationObserver/g)).toHaveLength(1);
    expect(settings).not.toContain("transition:all");
    expect(settings).not.toContain("message: { duration: 200");
  });

  it("bridges the persisted local profile through guarded IPC", () => {
    expect(main).toContain('ipcMain.handle("sand:local-profile-get"');
    expect(main).toMatch(/"sand:local-profile-set"[\s\S]{0,250}assertTrustedSecretsSender[\s\S]{0,180}assertOpenBotLocalMode/);
    expect(main).toContain('callOpenBotProviderRpc("getLocalProfile")');
    expect(main).toContain('callOpenBotProviderRpc("updateLocalProfile", profile ?? {})');
    expect(preload).toContain('invoke("sand:local-profile-get")');
    expect(preload).toContain('invoke("sand:local-profile-set", profile)');
  });

  it("applies confirmed profile saves after unmount without accepting stale acknowledgements", async () => {
    const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
    const scope = {
      profileRevision: 0, profileWriteSequence: 0, profileAppliedWrite: 0,
      profileState: { name: "Before" }, profileLoaded: false,
      normalizeProfileState: (value: unknown) => value,
      profileAgent: () => ({ updateLocalProfile: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }),
      applyProfileName: vi.fn(),
    };
    const persist = runInNewContext(`${between(settings, "async function persistLocalProfile(", "function ensureLocalProfileLoaded()")} persistLocalProfile`, scope);
    const first = persist({ name: "First" });
    const second = persist({ name: "Second" });
    pending[1]!.resolve({ name: "Second" });
    await second;
    pending[0]!.resolve({ name: "First" });
    await first;
    expect(scope.profileState).toEqual({ name: "Second" });
    expect(scope.profileLoaded).toBe(true);
    expect(scope.applyProfileName).toHaveBeenCalledTimes(1);
    const unconfirmed = persist({ name: "Not stored" });
    pending[2]!.resolve({ name: "Second" });
    await expect(unconfirmed).rejects.toThrow("O perfil salvo não foi confirmado");
    expect(scope.profileState).toEqual({ name: "Second" });
  });

  it("persists the local profile name through the profile RPC", () => {
    expect(settings).toContain('const PROFILE_KEY = "openbot.profile.name.v1"');
    expect(settings).toContain('root.id = PROFILE_ID');
    expect(settings).toContain('<form id="openbot-profile-form"');
    expect(settings).toContain('<label for="openbot-profile-name">Seu nome</label>');
    expect(settings).toContain('maxlength="80"');
    expect(settings).toContain('aria-label="Salvar perfil"');
    expect(settings).toContain('<span class="ob-profile-save-label">Salvar</span>');
    expect(settings).toContain('const markDirty = (field) => {');
    expect(settings).toContain('saveLabel.textContent = "Salvo"');
    expect(settings).toContain('id="openbot-profile-status" role="status" aria-live="polite"');
    expect(settings).toContain("getLocalProfile()");
    expect(settings).toContain("updateLocalProfile(");
    expect(settings).not.toContain('localStorage.setItem(PROFILE_KEY, name)');
    expect(settings).not.toContain("transition:all");
  });

  it("supports bounded local avatar customization", () => {
    expect(settings).toContain('id="openbot-profile-avatar-file"');
    expect(settings).toContain('data-avatar-shape="circle"');
    expect(settings).toContain('data-avatar-shape="rounded"');
    expect(settings).toContain('data-avatar-shape="square"');
    expect(settings).toContain('data-avatar-color="#7c3aed"');
    expect(settings).toContain('id="openbot-profile-avatar-remove"');
    expect(settings).toContain("716800");
  });

  it("removes inherited account logout controls and dialogs", () => {
    expect(settings).toContain('sanitizeLegacyAuth()');
    expect(settings).toMatch(/\^\(Sign out\|Log out\|Sair\)\$/i);
    expect(settings).toContain('/use your Cursor account|conta do Cursor/i');
    expect(settings).toContain('cancel?.click()');
  });

  it("replaces disconnected Cursor auth with native global provider settings", () => {
    expect(settings).toContain('^Sign (?:In with|Out of) Cursor$');
    expect(settings).toContain('document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)');
    expect(settings).toContain('class="ob-field-row"');
  });

  it("does not duplicate the native first-agent form", () => {
    expect(settings).not.toContain("openbot-empty-agent-form");
    expect(settings).not.toContain("openbot-empty-agent-create");
  });

  it("opens bot setup before creating from the sidebar", () => {
    const clickHandler = between(settings, "function handleSidebarNewClick", "function restoreAppAfterWelcome");
    const createScreen = between(settings, "function openCreateAgent", "function handleSidebarNewClick");

    expect(clickHandler).toContain("openCreateAgent();");
    expect(clickHandler).not.toContain("createAgent(");
    expect(createScreen).toContain('root.id = CREATE_ID');
    expect(createScreen).toContain('aria-label="Cor do bot"');
    expect(createScreen).toContain('aria-label="Formato do bot"');
    expect(settings).toContain('const CREATE_SHAPES = ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop"]');
    expect(createScreen).toContain('aria-pressed="${shape === "blob"}"');
    expect(createScreen).toContain('placeholder="Novo bot"');
    expect(createScreen).toContain('data-action="submit" disabled');
    expect(createScreen).toContain('api.createAgent({ name, description, origin: "user", avatarColor: color, avatarShape: shape })');
    expect(createScreen).toContain("if (!name || submitting) return;");
    expect(settings).not.toContain("activateNativeCreate");
  });

  it("keeps the internal P2.3 launcher out of the product UI", () => {
    expect(settings).toContain('[data-openbot-p23-launch]{display:none!important}');
  });

  it("opens the native first-bot onboarding instead of rendering a duplicate surface", () => {
    const emptyState = between(settings, "async function checkEmptyAgentState()", "async function updateLifecycleStatus");
    const scan = between(settings, "function scan()", "function scheduleSettingsScan");

    expect(settings).toContain("function openNativeFirstBotOnboarding()");
    expect(settings).toContain('.sand-onboarding__meet');
    expect(settings).toContain('/^(new|new chat)$/i');
    expect(settings).toMatch(/composerCopy\.textContent = "Dê uma tarefa ao seu time de bots"/);
    expect(emptyState).toContain("scheduleEmptyAgentStateRetry();");
    expect(emptyState).toContain('sessionStorage.setItem(WELCOME_SESSION_KEY, "1")');
    expect(emptyState).toContain("const legacyWelcome = document.getElementById(WELCOME_ID);");
    expect(emptyState).not.toContain("ensureWelcome();");
    expect(emptyState).toContain("openNativeFirstBotOnboarding();");
    expect(emptyState).toContain("polishNativeOnboarding();");
    expect(emptyState).toContain("for (const delay of [80, 220, 500, 1000])");
    expect(scan).toContain("void checkEmptyAgentState();");
    expect(scan).not.toContain("ensureWelcome();");
    expect(settings).not.toContain("function renderEmptyAgentState");
    expect(settings).not.toContain('class="ob-empty-character"');
  });

  it("marks the active document and custom surfaces as Brazilian Portuguese", () => {
    expect(rendererHtml).toContain('<html lang="en">');
    expect(settings).toContain('document.documentElement.lang = "pt-BR"');
    expect(settings).toMatch(/root\.id = ROOT_ID;\s*root\.setAttribute\("lang", "pt-BR"\);/);
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
    expect(main).toContain('if (import_node_path39.default.isAbsolute(source)) return source;');
  });

  it("uses a high-contrast focus ring and dark native controls for custom surfaces", () => {
    expect(settings).toContain("color-scheme:dark");
    expect(settings).toMatch(/:focus-visible\{outline:2px solid var\(--cursor-focus,var\(--cursor-base,#f0f0f0\)\);outline-offset:2px;border-color:var\(--cursor-focus,var\(--cursor-base,#f0f0f0\)\)\}/);
    expect(settings).toContain('.sand-agents-sidebar :is(.sand-agents-sidebar__new,button[aria-label="New"],button[aria-label="Novo"]):focus-visible');
  });

  it("does not ship mojibake in generation controls", () => {
    expect(settings).not.toContain("geraÃ§Ã£o");
    expect(settings).toContain('button.setAttribute("aria-label", "Parar geração")');
    expect(settings).toContain('button.title = "Parar geração"');
    expect(settings).toContain('button.setAttribute("aria-label", "Tentar parar a geração")');
    expect(settings).toContain('button.title = "Tentar parar a geração"');
  });

  it("removes unsupported Help, Feedback and Updates surfaces", () => {
    expect(settings).toContain("UNAVAILABLE_NAV_LABELS");
    expect(settings).toContain("Help Center|Send Feedback|Updates");
    expect(settings).toContain("blockUnavailableNavigation");
    expect(settings).toContain("removeUnavailableNavigation()");
    expect(settings).toContain('document.addEventListener("click", blockUnavailableNavigation, true)');
    expect(settings).toContain('document.removeEventListener("click", blockUnavailableNavigation, true)');
    expect(settings).toContain('text === "Update Track"');
    expect(settings).toContain('/^General$/i');
    expect(settings).toContain("UNSUPPORTED_COMMAND_LABELS");
    expect(settings).toContain("UNSAFE_SECTION_ACTION");
  });

  it("repairs the confirmed inherited UI inconsistencies without changing provider routing", () => {
    expect(settings).toContain("function reconcileConfirmedDeliveries()");
    expect(settings).toContain('data-openbot-delivery-confirmed="1"');
    expect(settings).toContain("function optimizeTimezoneListbox()");
    expect(settings).toContain("function handleNativePortalTriggerClick(event)");
    expect(settings).toContain("function handleAgentContextMenu(event)");
    expect(settings).toContain('data-icon-name="folder-plus"');
    expect(settings).toContain("matches.slice(0, 60)");
    expect(settings).toContain('["Version 0.16.0", "Versão 0.1.1 · build source"]');
    expect(settings).toContain('["Copyright © 2026 SpaceXAI", "Copyright © 2026 OpenBot"]');
    expect(settings).toContain('.sand-prompt-shell{position:relative;height:auto!important;min-height:88px!important');
    expect(settings).not.toContain('.sand-prompt-shell{position:relative;height:88px!important');
    expect(settings).toContain('.sand-prompt-shell:has(.sand-prompt-reply-pill){min-height:118px!important');
    expect(settings).toContain('.sand-prompt-shell .sand-prompt-pad{height:auto!important;min-height:68px!important;padding:0!important;justify-content:flex-start!important}');
    expect(settings).toContain('.sand-prompt-shell .sand-prompt-field-host{height:auto!important;min-height:48px!important}');
    expect(settings).toContain('.sand-prompt-shell .sand-prompt-field{position:relative!important;inset:auto!important');
    expect(settings).toContain('.sand-prompt-shell .sand-prompt-field:not(:has(p.is-editor-empty[data-placeholder])){padding-bottom:40px!important}');
    expect(settings).toContain('@starting-style{.sand-prompt-attachment{opacity:0;transform:translateY(2px)}}');
    expect(settings).toContain('@media (prefers-reduced-motion:reduce){.sand-prompt-attachment{transform:none!important');
    expect(settings).not.toContain('caret-color:transparent!important');
    expect(settings).toContain('.sand-prompt-field:has(p.is-editor-empty[data-placeholder]){caret-color:var(--cursor-text-primary,currentColor)!important;overflow-y:hidden!important}');
    expect(settings).toContain('p.is-editor-empty[data-placeholder]{min-height:20px!important;margin:0!important;line-height:20px!important}');
    expect(settings).toContain('p.is-editor-empty[data-placeholder]::before{content:"Escreva uma mensagem"!important;display:block!important;top:2px!important;right:0!important;left:2px!important;height:22px!important;overflow:visible!important');
    expect(settings).toContain('apiKeySaveEl.disabled = saving || authBusy || !openCode || !apiKeyEl.value.trim()');
    expect(settings).toContain('data-openbot-onboarding-continue="1"');
    expect(settings).toContain('reasoningEffort: reasoningEl.value');
  });

  it("hides detected inherited Grok computer screen panes", () => {
    const ensureVisible = between(settings, "function ensureConversationDetailsVisible()", "function option(");
    expect(settings).toContain("LEGACY_SCREEN_LABELS");
    expect(settings).toContain("isComputerChrome");
    expect(settings).toContain("isScreenHeading");
    expect(settings).toContain("visibleLegacyScreenIn");
    expect(settings).toContain("[class*='computer'],[class*='screen']");
    expect(settings).toContain('#sand-conversation-details:has(.sand-computer-stage__placeholder){display:none!important}');
    expect(settings).toContain('.sand-chat-header__computer{display:none!important}');
    expect(settings).toMatch(/Can't reach \.\+ screen\|\.\+\['’\]s screen/);
    expect(settings).toContain("hideLegacyScreenPane(el)");
    expect(settings).toContain('details.dataset.openbotLegacyScreen = "1"');
    expect(settings).toContain('el.closest("aside, [class*=\'computer\'], [class*=\'monitor\'], [class*=\'screen\']")');
    expect(settings).toContain("function clearForcedConversationDetailsState(details)");
    expect(settings).toContain("function closeConversationDetails(details, fallbackControl = null)");
    expect(settings).toContain('const details = el.closest("#sand-conversation-details")');
    expect(settings).toContain("return closeConversationDetails(details, button)");
    expect(ensureVisible).toContain("const legacyScreen = visibleLegacyScreenIn(details)");
    expect(ensureVisible.indexOf("if (legacyScreen)")).toBeLessThan(ensureVisible.indexOf('panel.removeAttribute("data-openbot-hide")'));
    expect(ensureVisible).toContain('details.dataset.openbotLegacyScreen === "1"');
    expect(settings).toContain('details.setAttribute("data-openbot-hide", "1")');
    expect(main.includes('path2.join(workspace, "Documents")')).toBe(true);
  });

  it("uses health readiness and owns only the gateway process it starts", () => {
    expect(launcher).toContain("/health");
    expect(launcher).toContain('set "ELECTRON_RUN_AS_NODE="');
    expect(launcher).toContain('set "GATEWAY_STARTED=0"');
    expect(launcher).toContain('set "GATEWAY_STARTED=1"');
    expect(launcher).toContain('set "GATEWAY_ADOPTED=1"');
    expect(gatewayStarter).toContain("waitForReady: true");
    expect(gatewayStarter).toContain("gatewayEvidenceMatches(evidence, pid, installRoot)");
    expect(launcher).toContain('start-gateway.mjs"');
    expect(gatewayHealth).toContain("health.pid === expectedPid");
    expect(gatewayHealth).toContain("queryProcessEvidence(health.pid)");
    expect(gatewayHealth).toContain("expectedGatewayScript.toLowerCase()");
    expect(gatewayHealth).toContain('AbortSignal.timeout(1_000)');
    expect(gatewayStarter).toContain("OPENBOT_LOG_DIR: logs");
    expect(gatewayStarter).toContain('stdio: "ignore"');
    expect(gatewayStarter).toContain("detached: true");
    expect(gatewayStarter).toContain("gateway.unref()");
    expect(hiddenLauncher).toContain('BuildPath(scriptsDirectory, "openbot-desktop.cmd")');
    expect(hiddenLauncher).toContain("shell.Run(command, 0, True)");
    expect(hiddenLauncher).toContain("fileSystem.GetTempName");
    expect(hiddenLauncher).toContain("MsgBox");
    expect(launcher).toContain('set "SAND_HOST_GATEWAY_URL="');
    expect(launcher).toContain('set "SAND_HOST_GATEWAY_URL=http://127.0.0.1:1340"');
    expect(launcher).toContain('set "SAND_DEV_BOX_CONTROL_PLANE=0"');
    expect(launcher.indexOf('set "SAND_HOST_GATEWAY_URL="')).toBeLessThan(
      launcher.indexOf('set "SAND_HOST_GATEWAY_URL=http://127.0.0.1:1340"'),
    );
    expect(launcher.indexOf('set "SAND_HOST_GATEWAY_URL=http://127.0.0.1:1340"')).toBeLessThan(
      launcher.indexOf('"%ELECTRON_PATH%" --user-data-dir='),
    );
    expect(launcher).toContain('set "SAND_HOST_GATEWAY_TOKEN="');
    expect(launcher).toContain('set "VITE_DEV_SERVER_URL="');
    expect(launcher).toContain('set "OPENBOT_ROOT=%CD%"');
    expect(gatewayStarter).toContain("dirname(dirname(fileURLToPath(import.meta.url)))");
    expect(launcher).toMatch(/if errorlevel 1 \([\s\S]{0,300}exit \/b 1/);
    const operationalLauncher = launcher.split(/\r?\n/u).filter((line) => !/^\s*rem\b/iu.test(line)).join("\n");
    expect(operationalLauncher).toMatch(/start-gateway\.mjs" --root[\s\S]{0,500}if not defined GATEWAY_PID[\s\S]{0,150}exit \/b 1/iu);
    expect(operationalLauncher).toMatch(/shutdown-gateway\.mjs" --root[\s\S]{0,300}--remove-state/iu);
    expect(operationalLauncher).toMatch(/if\s+"?%GATEWAY_STARTED%"?\s*==\s*"1"[\s\S]{0,300}shutdown-gateway\.mjs/iu);
    expect(operationalLauncher).not.toMatch(/gateway-health\.mjs"\s+(?:check|pid)\b/iu);
    expect(operationalLauncher).not.toMatch(/\btaskkill(?:\.exe)?\b/iu);
    expect(launcher).toContain('set "ELECTRON_STDIO_LOG=%CD%\\logs\\electron-secondary-%RANDOM%-%RANDOM%.log"');
    expect(launcher).toMatch(/if "%ELECTRON_EXIT%"=="23" \([\s\S]{0,160}del \/q "%ELECTRON_STDIO_LOG%"/);
    expect(launcher).not.toMatch(/^timeout /im);
  });

  it("validates an installed shortcut identity, proves port release by binding, and verifies cleanup", () => {
    expect(shortcutSmoke).toContain("state.installRoot");
    expect(shortcutSmoke).toMatch(/launch\.mjs'\) --preflight --root \$releaseRoot/);
    expect(shortcutSmoke).toContain("manifest.contentSha256 -cne [string]$state.manifestSha256");
    expect(shortcutSmoke).toContain("$portProbe.Server.ExclusiveAddressUse = $true");
    expect(shortcutSmoke).toMatch(/\$portProbe\.Start\(\)[\s\S]{0,120}\$portReleased = \$true/);
    expect(shortcutSmoke).not.toMatch(/Invoke-RestMethod[\s\S]{0,200}\$portReleased = \$true/);
    expect(shortcutSmoke).toMatch(/Remove-Item -LiteralPath \$smokeFull[\s\S]{0,180}Test-Path -LiteralPath \$smokeFull/);
  });
});
