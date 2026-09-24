import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const main = readFileSync(resolve(root, "client/extracted/dist/electron-main/main.cjs"), "utf8");
const settings = readFileSync(resolve(root, "client/extracted/dist/renderer/assets/openbot-local-settings.js"), "utf8");
const rendererHtml = readFileSync(resolve(root, "client/extracted/dist/renderer/index.html"), "utf8");
const preload = readFileSync(resolve(root, "client/extracted/dist/electron-preload/preload.cjs"), "utf8");
const launcher = readFileSync(resolve(root, "scripts/openbot-desktop.cmd"), "utf8");

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}


describe("Electron/Windows local integration patches", () => {

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
});
