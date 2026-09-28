import { readFileSync } from "node:fs";
import { resolve, win32 } from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error executable launcher helpers have no declaration file.
import { electronArguments, electronEnvironment } from "../scripts/launch.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const main = readFileSync(resolve(root, "client/extracted/dist/electron-main/main.cjs"), "utf8");
const settings = readFileSync(resolve(root, "client/extracted/dist/renderer/assets/openbot-local-settings.js"), "utf8");
const preload = readFileSync(resolve(root, "client/extracted/dist/electron-preload/preload.cjs"), "utf8");
const launcher = readFileSync(resolve(root, "scripts/openbot-desktop.cmd"), "utf8");
const launchSource = readFileSync(resolve(root, "scripts/launch.mjs"), "utf8");
const hiddenLauncher = readFileSync(resolve(root, "scripts/openbot-desktop.vbs"), "utf8");
const shortcutSmoke = readFileSync(resolve(root, "scripts/smoke-shortcut.ps1"), "utf8");
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
  it.each([false, true])("sets the window and taskbar identity before loading main (retired install variables=%s)", installed => {
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
    const expectedIcon = "C:\\OpenBot Test\\assets\\openbot.ico";
    expect(icon).toBe(windowImage);
    expect(loadedImages).toEqual([expectedIcon.replace(/\.ico$/, ".png"), expectedIcon]);
    expect(details).toEqual({
      appId: "OpenBot.Desktop", appIconPath: expectedIcon, appIconIndex: 0,
      relaunchCommand: '"C:\\Windows\\System32\\wscript.exe" "C:\\OpenBot Test\\scripts\\openbot-desktop.vbs"',
      relaunchDisplayName: "OpenBot",
    });
    expect(electronArguments({ root: "C:\\OpenBot Test", userData: "C:\\profile", logsRoot: "C:\\logs" }).at(-1))
      .toBe(win32.join("C:\\OpenBot Test", "scripts", "openbot-electron.cjs"));
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

  it("confirms the Start-menu taskbar registration as part of every launch", () => {
    // Behaviour (failure stops the launch and its gateway) is covered in desktop-launcher.test.ts.
    expect(launchSource).toContain("ensureTaskbarShortcutCached({ root, electronPath })");
    expect(readFileSync(resolve(root, "scripts/setup-desktop-shortcut.mjs"), "utf8")).toContain('args["taskbar-only"] ? ensureTaskbarShortcut()');
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
    expect(packageJson.scripts["desktop:shortcut"]).toBe("node scripts/setup-desktop-shortcut.mjs");
    expect(packageJson.scripts["verify:desktop-identity"]).toContain("test/desktop-identity.test.ts");
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
    // Provider catalogs are read once per session; only the explicit refresh forces a new read.
    const loadCatalog = between(settings, "const loadCatalog = async", 'catalogRefresh.addEventListener("click"');
    expect(loadCatalog).toContain("if (cached?.catalog) {");
    expect(loadCatalog).toContain("await updateCatalog();");
    expect(settings).toContain('catalogRefresh.addEventListener("click", () => void updateCatalog(true));');
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
    // Autosave replaces the save button: only user-made, unblocked changes are written.
    expect(settings).not.toContain('id="openbot-save"');
    // ...and never while the selected provider's catalog (reasoning/Fast limits) is still loading.
    expect(settings).toContain("if (userTouched && catalogPendingFor !== providerEl.value && selection() !== persisted && !blockedReason())");
    expect(settings).toContain("const AUTOSAVE_DELAY_MS = 300;");
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
    const desktopEnv = electronEnvironment({ SAND_DEV_CAPABILITY: "1", SAND_DEV_CONTROL_PORT: "62150" }, { root: "C:\\Repo", url: "http://127.0.0.1:1340", userData: "C:\\u" });
    expect(desktopEnv).not.toHaveProperty("SAND_DEV_CAPABILITY");
    expect(desktopEnv).not.toHaveProperty("SAND_DEV_CONTROL_PORT");
    expect(desktopEnv.OPENBOT_LOCAL_GATEWAY).toBe("1");
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
    expect(settings).toContain("Abrir Projetos");
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
    expect(settings).toContain('id="openbot-runtime-repair" class="ob-button">Reparar</button>');
    // Runtime states are shown in pt-BR, never as raw identifiers.
    expect(settings).toContain('stopped: "Parado"');
    expect(settings).toContain('ready: "Em execução"');
    expect(settings).toContain('RUNTIME_STATE_LABELS[state] || "Estado desconhecido"');
    expect(settings).toContain('show(status, "Verificado")');
  });

  it("bridges the persisted local profile through guarded IPC", () => {
    expect(main).toContain('ipcMain.handle("sand:local-profile-get"');
    expect(main).toMatch(/"sand:local-profile-set"[\s\S]{0,250}assertTrustedSecretsSender[\s\S]{0,180}assertOpenBotLocalMode/);
    expect(main).toContain('callOpenBotProviderRpc("getLocalProfile")');
    expect(main).toContain('callOpenBotProviderRpc("updateLocalProfile", profile ?? {})');
    expect(preload).toContain('invoke("sand:local-profile-get")');
    expect(preload).toContain('invoke("sand:local-profile-set", profile)');
  });

  it("launches hidden through one Node launcher and never kills from the shell", () => {
    expect(hiddenLauncher).toContain('BuildPath(scriptsDirectory, "openbot-desktop.cmd")');
    expect(hiddenLauncher).toContain("shell.Run(command, 0, True)");
    expect(hiddenLauncher).toContain("fileSystem.GetTempName");
    expect(hiddenLauncher).toContain("MsgBox");
    const operational = launcher.split(/\r?\n/u).filter((line) => !/^\s*rem\b/iu.test(line)).join("\n");
    expect(operational).toContain('node "%CD%\\scripts\\launch.mjs" %*');
    expect(operational).toMatch(/if errorlevel 1 \([\s\S]{0,200}exit \/b 5/u);
    expect(operational).not.toMatch(/\btaskkill(?:\.exe)?\b|^timeout /imu);
    // Readiness is proven through /health of this checkout; ownership lives in gateway-control.mjs.
    expect(launchSource).toContain("waitForGateway(url, child.pid, { watch, rootId");
    expect(launchSource).toContain('detached: true');
    expect(launchSource).toContain("child.unref()");
  });

  it("validates the checkout shortcut identity, proves port release by binding, and verifies cleanup", () => {
    expect(shortcutSmoke).toContain("Shortcut does not target this checkout's hidden launcher");
    expect(shortcutSmoke).toContain(String.raw`$gatewayScript = Join-Path $repoRoot 'dist\entry.js'`);
    expect(shortcutSmoke).not.toMatch(/state\.json|launch\.mjs'\) --preflight/u);
    expect(shortcutSmoke).toContain("$portProbe.Server.ExclusiveAddressUse = $true");
    expect(shortcutSmoke).toMatch(/\$portProbe\.Start\(\)[\s\S]{0,120}\$portReleased = \$true/);
    expect(shortcutSmoke).not.toMatch(/Invoke-RestMethod[\s\S]{0,200}\$portReleased = \$true/);
    expect(shortcutSmoke).toMatch(/Remove-Item -LiteralPath \$smokeFull[\s\S]{0,180}Test-Path -LiteralPath \$smokeFull/);
  });
});
