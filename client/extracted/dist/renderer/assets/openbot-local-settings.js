(() => {
  // openbot-local-settings-v60-settings-redesign
  window.performance?.mark?.("openbot:local-settings-evaluated");
  const ROOT_ID = "openbot-provider-settings";
  const MODAL_LAYER_SELECTOR = '.ui-menu__backdrop,[role="menu"],[role="dialog"][aria-modal="true"],[role="alertdialog"]';
  const EMPTY_ID = "openbot-empty-agent-state";
  const STOP_ID = "openbot-stop-turn";
  const STYLE_ID = "openbot-local-ui-style";
  const WELCOME_ID = "openbot-welcome";
  const WELCOME_SESSION_KEY = "openbot.welcome.completed.session.v1";
  const PROFILE_ID = "openbot-local-profile";
  const CREATE_ID = "openbot-create-agent";
  const FOOTER_PROFILE_EDITOR_ID = "openbot-footer-profile-editor";
  const PROFILE_KEY = "openbot.profile.name.v1";
  const PROFILE_DEFAULT_NAME = "OpenBot Local";
  const PROFILE_MAX_AVATAR_BYTES = 716800;
  const PROFILE_DEFAULT_COLOR = "#52525b";
  const MOTION_EASING = "cubic-bezier(.22,1,.36,1)";
  const MOTION = {
    surface: { duration: 220, from: "translate3d(0,6px,0) scale(.985)" },
    panel: { duration: 260 },
    settings: { duration: 180 },
    disclosure: { duration: 160, from: "translate3d(0,-4px,0)" },
    message: { duration: 280, from: "translate3d(0,8px,0) scale(.97)", easing: "cubic-bezier(.2,.9,.3,1.15)" },
    status: { duration: 180, from: "translate3d(0,0,0)" },
  };
  const localTimers = new Set();
  let draftPersistenceState = "saved";
  let draftPersistenceRevision = 0;
  let draftRecoveryError = "";
  let unsubscribeDraftStatus;
  let unsubscribePromptDelivery;

  function renderDraftPersistence() {
    const shell = document.querySelector(".sand-prompt-shell");
    if (!shell) return;
    let notice = document.getElementById("openbot-draft-persistence");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "openbot-draft-persistence";
      notice.setAttribute("role", "status");
      notice.style.cssText = "font-size:12px;line-height:18px;padding:4px 10px;color:var(--cursor-text-secondary,#aaa)";
      notice.appendChild(document.createElement("span"));
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Salvar rascunho novamente";
      retry.style.marginLeft = "8px";
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        try { await desktop()?.clientPersistence?.flush(); }
        catch { draftPersistenceState = "failed"; }
        finally { retry.disabled = false; renderDraftPersistence(); }
      });
      notice.appendChild(retry);
      shell.after(notice);
    }
    // Routine autosaves must not add/remove a row below the composer while typing.
    notice.hidden = !draftRecoveryError && draftPersistenceState !== "failed" && draftPersistenceState !== "journal-failed";
    const message = draftRecoveryError || (draftPersistenceState === "failed"
      ? "Rascunho não salvo. Mantenha a janela aberta ou copie o texto."
      : draftPersistenceState === "journal-failed"
      ? "Não foi possível salvar a pendência de envio neste computador. O conteúdo foi mantido; tente novamente."
      : "");
    if (notice.firstChild.textContent !== message) notice.firstChild.textContent = message;
    notice.lastChild.hidden = draftPersistenceState !== "failed";
    for (const actions of document.querySelectorAll(".sand-failed-send-actions")) {
      if (actions.querySelector("[data-openbot-recover-draft]")) continue;
      const nonce = actions.closest("[data-row-key]")?.getAttribute("data-row-key")?.replace(/^nonce:/, "");
      if (!nonce) continue;
      const recover = document.createElement("button");
      recover.type = "button";
      recover.textContent = "Editar rascunho";
      recover.className = actions.querySelector("button")?.className ?? "";
      recover.dataset.openbotRecoverDraft = nonce;
      recover.addEventListener("click", async () => {
        recover.disabled = true;
        draftRecoveryError = "";
        try {
          await desktop()?.clientPersistence?.recoverFailedSend({ nonce, agentId: selectedAgentRow()?.getAttribute("data-agent-id") });
        } catch (error) {
          recover.disabled = false;
          draftRecoveryError = userFacingError(error, "Não foi possível recuperar o rascunho. Tente novamente.");
          renderDraftPersistence();
        }
      });
      actions.appendChild(recover);
    }
  }

  function setLocalTimeout(callback, delay) {
    if (localUiClosed) return 0;
    const timer = window.setTimeout(() => {
      localTimers.delete(timer);
      if (localUiClosed) return;
      callback();
    }, delay);
    localTimers.add(timer);
    return timer;
  }

  function clearLocalTimeout(timer) {
    window.clearTimeout(timer);
    localTimers.delete(timer);
  }

  const css = `
#${STYLE_ID}-noop{display:none}
#${ROOT_ID}{--ob-stroke:var(--cursor-stroke-secondary,rgba(252,252,252,.15));--ob-text-2:var(--cursor-text-secondary,rgba(252,252,252,.6));--ob-text-3:var(--cursor-text-tertiary,rgba(252,252,252,.4));--ob-control-h:30px;--ob-control-r:6px;--ob-control-bg:var(--cursor-bg-input,var(--cursor-bg-editor,#070707));--ob-control-border:var(--cursor-stroke-secondary,rgba(252,252,252,.15));--ob-label-col:64px;--ob-menu-r:8px;display:flex;min-width:0;box-sizing:border-box;flex-direction:column;gap:14px;margin:4px 0 0;padding:0;border:0;color:var(--cursor-text-primary,currentColor);font:inherit;font-size:var(--cursor-font-size-base,13px);line-height:18px}
#${ROOT_ID}[data-scope="global"]{--ob-control-h:28px;--ob-control-r:8px;--ob-control-bg:var(--cursor-bg-tertiary,rgba(119,119,119,.17));--ob-control-border:rgba(252,252,252,.05);--ob-menu-r:10px;flex:1 1 calc(100% - 64px);width:calc(100% - 64px);max-width:calc(100% - 64px);margin:20px 32px 24px;gap:24px}
#${ROOT_ID}[data-scope="global"][data-native-section="1"]{flex:0 0 auto;width:100%;max-width:100%;margin:0}
#${ROOT_ID},#${EMPTY_ID},#${STOP_ID}{color-scheme:dark}
#${ROOT_ID} [hidden]{display:none!important}
#${ROOT_ID} .ob-group{display:flex;min-width:0;flex-direction:column}
#${ROOT_ID} .ob-group-label{display:block;box-sizing:border-box;margin:0;padding:0 8px 6px;color:var(--ob-text-2);font-size:var(--cursor-font-size-sm,12px);font-weight:400;line-height:16px}
#${ROOT_ID}[data-scope="global"] .ob-group-label{margin:0 0 8px;padding:0 4px 0 8px}
#${ROOT_ID} .ob-group-help{margin:-2px 0 8px;padding:0 8px;color:var(--ob-text-3);font-size:var(--cursor-font-size-sm,12px);line-height:16px;text-wrap:pretty}
#${ROOT_ID}[data-scope="global"] .ob-group-help{margin:-4px 0 10px}
#${ROOT_ID} .ob-card{min-width:0;box-sizing:border-box;border:1px solid var(--ob-stroke);border-radius:6px;padding:0 10px;background:transparent}
#${ROOT_ID}[data-scope="global"] .ob-card{border:0;border-radius:14px;padding:0 14px;background:var(--cursor-bg-tertiary,rgba(119,119,119,.17))}
#${ROOT_ID} .ob-field-row{display:grid;grid-template-columns:var(--ob-label-col) minmax(0,1fr);align-items:center;column-gap:10px;min-height:46px;box-sizing:border-box;padding:8px 0;border-top:1px solid var(--ob-stroke)}
#${ROOT_ID} .ob-card>.ob-field-row:first-child{border-top:0}
#${ROOT_ID}[data-scope="global"] .ob-field-row{grid-template-columns:minmax(0,1fr) auto;column-gap:16px;min-height:52px;padding:10px 0}
#${ROOT_ID} .ob-auth-row,#${ROOT_ID} .ob-advanced .ob-field-row{grid-template-columns:auto minmax(0,1fr)}
#${ROOT_ID} .ob-field-row.ob-stack-row,#${ROOT_ID}[data-scope="global"] .ob-field-row.ob-stack-row{grid-template-columns:minmax(0,1fr);row-gap:8px}
#${ROOT_ID} .ob-row-label{display:block;min-width:0;margin:0;overflow:hidden;color:var(--ob-text-2);font-size:var(--cursor-font-size-sm,12px);font-weight:400;line-height:16px;text-overflow:ellipsis;white-space:nowrap}
#${ROOT_ID}[data-scope="global"] .ob-row-label{color:var(--cursor-text-primary,currentColor);font-size:var(--cursor-font-size-base,13px);line-height:18px}
#${ROOT_ID} .ob-row-control{display:flex;min-width:0;align-items:center;justify-content:flex-end;gap:6px}
#${ROOT_ID} .ob-auth-control{gap:8px}
#${ROOT_ID} .ob-row-note{grid-column:1/-1;min-width:0;margin:6px 0 0;color:var(--ob-text-2);font-size:var(--cursor-font-size-sm,12px);line-height:16px;overflow-wrap:anywhere;text-wrap:pretty}
#${ROOT_ID} .ob-row-note.err{color:var(--cursor-danger,#ff5667)}
#${ROOT_ID} .ob-row-note.is-reserved{visibility:hidden}
#${ROOT_ID} .ob-native-select{position:absolute!important;width:1px!important;height:1px!important;min-height:1px!important;margin:0!important;padding:0!important;border:0!important;opacity:0!important;pointer-events:none!important}
#${ROOT_ID} .ob-select{position:relative;display:flex;min-width:0;flex:1 1 auto}
#${ROOT_ID}[data-scope="global"] .ob-select{flex:0 1 auto;max-width:320px}
#${ROOT_ID} .ob-select-trigger{display:flex;width:100%;min-width:0;height:var(--ob-control-h);box-sizing:border-box;align-items:center;gap:6px;margin:0;border:1px solid var(--ob-control-border);border-radius:var(--ob-control-r);padding:0 8px;background:var(--ob-control-bg);color:var(--cursor-text-primary,currentColor);font:inherit;font-size:var(--cursor-font-size-base,13px);font-weight:400;line-height:18px;text-align:left;cursor:pointer;touch-action:manipulation;transition:border-color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease),background-color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease)}
#${ROOT_ID}[data-scope="global"] .ob-select-trigger{padding:0 5px 0 8px}
#${ROOT_ID} .ob-select-value{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${ROOT_ID} .ob-select-trigger::after{content:"";flex:none;width:5px;height:5px;margin:0 3px 3px 2px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;opacity:.6;transform:rotate(45deg);transition:transform var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease)}
#${ROOT_ID} .ob-select-trigger[aria-expanded="true"]::after{margin-bottom:-2px;transform:rotate(225deg)}
#${ROOT_ID} .ob-select-trigger:hover:not(:disabled),#${ROOT_ID} .ob-select-trigger[aria-expanded="true"]{border-color:var(--cursor-stroke-primary,rgba(252,252,252,.24))}
#${ROOT_ID} .ob-select-trigger:disabled{cursor:default;opacity:.5}
#${ROOT_ID}[data-loading="1"] .ob-select-trigger:disabled{opacity:1}
#${ROOT_ID}[data-loading="1"] .ob-select-value,#${ROOT_ID}[data-loading="1"] #openbot-auth-action{visibility:hidden}
#${ROOT_ID} .ob-select-menu{position:absolute;z-index:80;top:calc(100% + 4px);right:0;min-width:100%;width:max-content;max-width:min(320px,calc(100vw - 32px));max-height:240px;box-sizing:border-box;overflow-y:auto;padding:4px;border:1px solid var(--cursor-stroke-primary,rgba(252,252,252,.18));border-radius:var(--ob-menu-r);background:var(--cursor-bg-elevated,#1f1f1f);box-shadow:0 12px 30px rgba(0,0,0,.38)}
#${ROOT_ID} .ob-select.is-open-up .ob-select-menu{top:auto;bottom:calc(100% + 4px)}
#${ROOT_ID} .ob-select-option{display:grid;width:100%;grid-template-columns:minmax(0,1fr) 14px;align-items:center;gap:8px;min-height:28px;box-sizing:border-box;margin:0;border:0;border-radius:calc(var(--ob-menu-r) - 3px);padding:4px 8px;background:transparent;color:var(--cursor-text-primary,currentColor);font:inherit;font-size:var(--cursor-font-size-base,13px);font-weight:400;line-height:18px;text-align:left;white-space:nowrap;cursor:pointer}
#${ROOT_ID} .ob-select-option:hover:not(:disabled),#${ROOT_ID} .ob-select-option:focus-visible{background:var(--cursor-bg-secondary,rgba(252,252,252,.1));outline:0}
#${ROOT_ID} .ob-select-option[aria-selected="true"]{background:color-mix(in srgb,currentColor 8%,transparent)}
#${ROOT_ID} .ob-select-option[aria-selected="true"]::after{content:"✓";justify-self:center;font-size:12px}
#${ROOT_ID} .ob-select-option:disabled{opacity:.5;cursor:not-allowed}
#${ROOT_ID} .ob-button{display:inline-flex;flex:none;height:var(--ob-control-h);min-width:0;box-sizing:border-box;align-items:center;justify-content:center;margin:0;border:1px solid var(--ob-control-border);border-radius:var(--ob-control-r);padding:0 10px;background:var(--cursor-button-secondary-background,var(--cursor-bg-tertiary,rgba(252,252,252,.08)));color:var(--cursor-button-secondary-foreground,var(--cursor-text-primary,currentColor));font:inherit;font-size:var(--cursor-font-size-base,13px);font-weight:400;line-height:18px;white-space:nowrap;cursor:pointer;touch-action:manipulation;transition:transform var(--cursor-duration-fast,.1s) var(--cursor-easing-default,ease),background-color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease),border-color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease)}
#${ROOT_ID} .ob-button:hover:not(:disabled){border-color:var(--cursor-stroke-primary,rgba(252,252,252,.24));background:var(--cursor-button-secondary-hover-background,var(--cursor-bg-secondary,rgba(252,252,252,.14)))}
#${ROOT_ID} .ob-button:active:not(:disabled){transform:scale(.96)}
#${ROOT_ID} .ob-button:disabled{opacity:.5;cursor:default;transform:none}
#${ROOT_ID} .ob-icon-button{width:var(--ob-control-h);padding:0;color:var(--ob-text-2)}
#${ROOT_ID} .ob-icon-button:hover:not(:disabled){color:var(--cursor-text-primary,currentColor)}
#${ROOT_ID} .ob-icon-button svg{display:block;width:14px;height:14px}
#${ROOT_ID} .ob-icon-button.is-busy:disabled{opacity:1}
#${ROOT_ID} .ob-icon-button.is-busy svg{animation:ob-settings-spin .9s linear infinite}
@keyframes ob-settings-spin{to{transform:rotate(360deg)}}
#${ROOT_ID} .ob-link-button{display:inline;height:auto;margin:0;border:0;padding:0;background:transparent;color:var(--cursor-text-primary,currentColor);font:inherit;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
#${ROOT_ID} :is(.ob-button,.ob-select-trigger,.ob-link-button,.ob-advanced>summary):focus-visible{outline:2px solid var(--cursor-focus,var(--cursor-base,#f0f0f0));outline-offset:2px}
#${ROOT_ID} .ob-input{width:100%;min-width:0;height:var(--ob-control-h);box-sizing:border-box;border:1px solid var(--ob-control-border);border-radius:var(--ob-control-r);outline:none;padding:0 8px;background:var(--ob-control-bg);color:var(--cursor-text-primary,currentColor);font:inherit;font-size:var(--cursor-font-size-base,13px);line-height:18px;transition:border-color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease)}
#${ROOT_ID} .ob-input:hover{border-color:var(--cursor-stroke-primary,rgba(252,252,252,.24))}
#${ROOT_ID} .ob-input:focus-visible,#${EMPTY_ID} input:focus-visible{outline:2px solid var(--cursor-focus,var(--cursor-base,#f0f0f0));outline-offset:2px;border-color:var(--cursor-focus,var(--cursor-base,#f0f0f0))}
#${ROOT_ID} .ob-input[aria-invalid="true"]{border-color:var(--cursor-danger,#ff5667)}
#${ROOT_ID} .compat{display:none}
#${ROOT_ID}.compat-on .compat{display:block}
#${ROOT_ID} .ob-found{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0}
#${ROOT_ID} .ob-found button{min-height:28px;padding:4px 8px;font-size:var(--cursor-font-size-sm,12px)}
#${ROOT_ID} .ob-remove{color:var(--cursor-danger,#e34671)}
#${ROOT_ID} .ob-secret-row{display:flex;min-width:0;align-items:center;gap:6px}
#${ROOT_ID} .ob-secret-row .ob-input{flex:1 1 auto}
#${ROOT_ID} .ob-key-status{display:inline-flex;min-width:0;align-items:center;gap:6px;color:var(--ob-text-2);font-size:var(--cursor-font-size-sm,12px);line-height:16px;white-space:nowrap}
#${ROOT_ID}[data-scope="global"] .ob-key-status{font-size:var(--cursor-font-size-base,13px);line-height:18px}
#${ROOT_ID} .ob-key-status::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:var(--ob-text-3)}
#${ROOT_ID} .ob-key-status[data-state="loading"]::before{background:var(--ob-stroke)}
#${ROOT_ID} .ob-key-status[data-state="connected"]::before{background:var(--cursor-green,#00c972);box-shadow:0 0 0 2px color-mix(in srgb,var(--cursor-green,#00c972) 18%,transparent)}
#${ROOT_ID} .ob-key-status[data-state="pending"]::before{background:transparent;box-shadow:inset 0 0 0 1.5px var(--ob-text-2)}
#${ROOT_ID} .ob-key-status[data-state="error"]::before{background:var(--cursor-danger,#ff5667)}
#${ROOT_ID} .ob-group-head{display:flex;min-width:0;box-sizing:border-box;flex-wrap:wrap;align-items:baseline;justify-content:space-between;column-gap:12px;row-gap:2px;padding:0 8px 6px}
#${ROOT_ID}[data-scope="global"] .ob-group-head{margin:0 0 8px;padding:0 4px 0 8px}
#${ROOT_ID} .ob-group-head>.ob-group-label,#${ROOT_ID}[data-scope="global"] .ob-group-head>.ob-group-label{flex:none;margin:0;padding:0}
#${ROOT_ID} .ob-group-status{display:flex;min-width:0;align-items:baseline;justify-content:flex-end;flex-wrap:wrap;column-gap:8px;margin:0;padding:0;color:var(--ob-text-2);font-size:var(--cursor-font-size-sm,12px);line-height:16px;text-align:right;overflow-wrap:anywhere}
#${ROOT_ID} .ob-group-status.ok .ob-status-text::before{content:"✓";margin-right:5px;color:var(--cursor-green,#00c972)}
#${ROOT_ID} .ob-group-status.err{color:var(--cursor-danger,#ff5667)}
#${ROOT_ID} .ob-group-head>.ob-group-status:is(.err,.warn){flex:1 0 100%;justify-content:flex-start;text-align:left}
#${ROOT_ID} .ob-group-status.err .ob-link-button{color:var(--cursor-text-primary,currentColor)}
#${ROOT_ID} .ob-advanced{min-width:0}
#${ROOT_ID} .ob-advanced>summary{display:flex;width:max-content;max-width:100%;box-sizing:border-box;align-items:center;gap:6px;padding:0 8px 6px;border-radius:4px;color:var(--ob-text-2);font-size:var(--cursor-font-size-sm,12px);line-height:16px;cursor:pointer;list-style:none;user-select:none;touch-action:manipulation;transition:color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease)}
#${ROOT_ID} .ob-advanced>summary::-webkit-details-marker{display:none}
#${ROOT_ID} .ob-advanced>summary::after{content:"";width:5px;height:5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;opacity:.8;transform:translateY(-1px) rotate(-45deg);transition:transform var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease)}
#${ROOT_ID} .ob-advanced[open]>summary::after{transform:translateY(-2px) rotate(45deg)}
@media (hover:hover) and (pointer:fine){#${ROOT_ID} .ob-advanced>summary:hover{color:var(--cursor-text-primary,currentColor)}}
#${ROOT_ID} .ob-folder-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
#${ROOT_ID} .ob-folder-actions .ob-button{width:100%;padding:0 6px;font-size:var(--cursor-font-size-sm,12px)}
#${ROOT_ID} .ob-lifecycle-status{min-width:0;color:var(--cursor-text-primary,currentColor);font-size:var(--cursor-font-size-sm,12px);line-height:16px;text-align:right;text-wrap:pretty}
#${ROOT_ID} .ob-lifecycle-status.err{color:var(--cursor-danger,#ff5667)}
#${ROOT_ID} .ob-runtime-actions{display:flex;justify-content:flex-end;min-height:46px;box-sizing:border-box;align-items:center;border-top:1px solid var(--ob-stroke)}
#${ROOT_ID} .ob-advanced-status{justify-content:flex-start;margin:6px 0 0;padding:0 8px;text-align:left}
#${ROOT_ID} .ob-advanced-status:empty,#${ROOT_ID} .ob-advanced-status:has(.ob-status-text:empty){margin:0}
[data-placeholder*="Sign in to Cursor in settings" i]::before{content:"Crie ou selecione um bot para começar."!important}
[data-openbot-p23-launch]{display:none!important}
[data-openbot-sand-restore-wall="1"]{display:none!important}
#${WELCOME_ID}{position:fixed;inset:0;z-index:2147483600;display:grid;place-items:center;box-sizing:border-box;overflow:hidden;padding:clamp(24px,6vw,80px);color:var(--cursor-text-primary,#ececec);background:var(--cursor-bg-editor,#181818);font-family:var(--cursor-font-family-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;opacity:0;transition:opacity 220ms cubic-bezier(.22,1,.36,1)}
#${WELCOME_ID}:focus{outline:none}
#${WELCOME_ID} .ob-welcome-art,#${WELCOME_ID} .ob-welcome-light,#${WELCOME_ID} .ob-welcome-shade,#${WELCOME_ID} .ob-welcome-grain{display:none}
#${WELCOME_ID} .ob-welcome-content{display:grid;width:min(520px,100%);justify-items:center;gap:18px;text-align:center}
#${WELCOME_ID} .ob-welcome-kicker,#${WELCOME_ID} h1,#${WELCOME_ID} .ob-welcome-copy,#${WELCOME_ID} .ob-welcome-note,#${WELCOME_ID} button{opacity:0;transform:translateY(8px);transition:opacity 260ms cubic-bezier(.22,1,.36,1),transform 260ms cubic-bezier(.22,1,.36,1)}
#${WELCOME_ID} .ob-welcome-kicker{display:none}
#${WELCOME_ID} h1{margin:0;color:var(--cursor-text-primary,#ececec);font:600 clamp(28px,4vw,36px)/1.15 var(--cursor-font-family-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);letter-spacing:-.025em;text-wrap:balance;transition-delay:40ms}
#${WELCOME_ID} .ob-welcome-copy{max-width:520px;margin:0;color:var(--cursor-text-secondary,#aaa);font-size:14px;font-weight:400;line-height:1.55;text-wrap:pretty;transition-delay:70ms}
#${WELCOME_ID} .ob-welcome-note{margin:-8px 0 0;color:var(--cursor-text-tertiary,#888);font-size:12px;font-weight:400;line-height:1.5;text-wrap:pretty;transition-delay:100ms}
#${WELCOME_ID} button{min-width:112px;min-height:36px;margin-top:4px;border:0;border-radius:999px;padding:8px 18px;background:var(--cursor-bg-accent,#ececec);color:var(--cursor-text-on-color,#171717);font:500 13px/1.4 var(--cursor-font-family-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);cursor:pointer;box-shadow:none;touch-action:manipulation;transition:opacity 220ms cubic-bezier(.22,1,.36,1) 120ms,transform 120ms ease,background-color 150ms ease}
#${WELCOME_ID} button:hover{background:var(--cursor-bg-accent-hover,#fff);transform:translateY(-1px)}
#${WELCOME_ID} button:active{transform:scale(.96)}
#${WELCOME_ID} button:focus{outline:none}
#${WELCOME_ID}.is-keyboard-navigation button:focus-visible{outline:2px solid var(--cursor-focus,#f0f0f0);outline-offset:2px}
#${WELCOME_ID}.is-ready{opacity:1}
#${WELCOME_ID}.is-ready .ob-welcome-kicker,#${WELCOME_ID}.is-ready h1,#${WELCOME_ID}.is-ready .ob-welcome-copy,#${WELCOME_ID}.is-ready .ob-welcome-note,#${WELCOME_ID}.is-ready button{opacity:1;transform:translateY(0)}
#${WELCOME_ID}.is-leaving{opacity:0;pointer-events:none}
#${WELCOME_ID}.is-leaving .ob-welcome-content{transform:translateY(-6px) scale(.985);transition:transform 220ms cubic-bezier(.4,0,1,1)}
#${PROFILE_ID}{box-sizing:border-box;width:100%;padding:0;border-radius:0;background:transparent;box-shadow:none;color:var(--cursor-text-primary,currentColor);color-scheme:dark;font:inherit}
#${PROFILE_ID}[data-native-account]{padding:16px}
#${PROFILE_ID}[data-native-account] .ob-profile-header{margin-bottom:0}
#${PROFILE_ID} .ob-profile-editor{margin-top:10px;interpolate-size:allow-keywords}
#${PROFILE_ID} .ob-profile-editor summary{width:max-content;cursor:pointer;font-size:12px;color:var(--cursor-text-secondary,#aaa)}
#${PROFILE_ID} .ob-profile-editor::details-content{block-size:0;opacity:0;overflow:clip;transition:block-size 180ms var(--cursor-easing-default,ease),opacity 180ms ease,content-visibility 180ms;transition-behavior:allow-discrete}
#${PROFILE_ID} .ob-profile-editor[open]::details-content{block-size:auto;opacity:1}
#${PROFILE_ID} #openbot-profile-form{padding-top:12px}
#${PROFILE_ID} fieldset{border:0;padding:0;margin:0;min-width:0}
#${PROFILE_ID} #openbot-profile-save{width:112px;flex:none}
@media(prefers-reduced-motion:reduce){#${PROFILE_ID} .ob-profile-editor::details-content{transition:none}}
#${PROFILE_ID} .ob-profile-header{display:flex;align-items:center;gap:12px;margin-bottom:14px}
#${PROFILE_ID} .ob-profile-avatar{display:grid;overflow:hidden;flex:0 0 36px;width:36px;height:36px;place-items:center;border-radius:50%;background:var(--ob-profile-color,var(--cursor-bg-secondary,color-mix(in srgb,currentColor 8%,transparent)));color:#fff;font-size:12px;font-weight:650;letter-spacing:.02em;box-shadow:inset 0 0 0 1px var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 14%,transparent))}
#${PROFILE_ID} .ob-profile-avatar[data-shape="rounded"]{border-radius:9px}
#${PROFILE_ID} .ob-profile-avatar[data-shape="square"]{border-radius:4px}
#${PROFILE_ID} .ob-profile-avatar{position:relative}
#${PROFILE_ID} .ob-profile-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.sand-agents-sidebar__account .ob-account-avatar{position:absolute;inset:0;z-index:1;display:grid;place-items:center;overflow:hidden;border-radius:50%;background:var(--ob-profile-color,#52525b);color:#fff;font-size:12px;pointer-events:none}
.sand-agents-sidebar__account .ob-account-avatar[data-shape="rounded"]{border-radius:7px}
.sand-agents-sidebar__account .ob-account-avatar[data-shape="square"]{border-radius:4px}
.sand-agents-sidebar__account .ob-account-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
#${PROFILE_ID} .ob-profile-title{font-size:var(--cursor-font-size-lg,14px);font-weight:var(--cursor-font-weight-semibold,600);line-height:1.35;text-wrap:balance}
#${PROFILE_ID} .ob-profile-help{margin:2px 0 0;color:var(--cursor-text-tertiary,color-mix(in srgb,currentColor 60%,transparent));font-size:var(--cursor-font-size-xs,11px);line-height:1.4;text-wrap:pretty}
#${PROFILE_ID} label{display:block;margin:0 0 5px;color:var(--cursor-text-secondary,color-mix(in srgb,currentColor 74%,transparent));font-size:var(--cursor-font-size-sm,12px)}
#${PROFILE_ID} .ob-profile-row{display:flex;align-items:center;gap:8px}
#${PROFILE_ID} input{min-width:0;height:30px;min-height:30px;flex:1;box-sizing:border-box;border:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 12%,transparent));border-radius:6px;outline:none;background:var(--cursor-bg-editor,var(--cursor-editor,transparent));color:var(--cursor-text-primary,currentColor);padding:4px 8px;font:inherit;line-height:20px;transition:border-color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease),background-color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease)}
#${PROFILE_ID} input:hover{border-color:var(--cursor-stroke-primary,color-mix(in srgb,currentColor 20%,transparent))}
#${PROFILE_ID} input:focus-visible{outline:2px solid var(--cursor-focus,var(--cursor-base,#f0f0f0));outline-offset:2px;border-color:var(--cursor-focus,var(--cursor-base,#f0f0f0))}
#${PROFILE_ID} button{display:inline-flex;height:30px;min-height:30px;box-sizing:border-box;align-items:center;justify-content:center;gap:6px;border:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 14%,transparent));border-radius:6px;padding:4px 9px;background:var(--cursor-button-secondary-background,var(--cursor-bg-secondary,color-mix(in srgb,currentColor 7%,transparent)));color:var(--cursor-button-secondary-foreground,var(--cursor-text-secondary,currentColor));font:inherit;line-height:20px;font-weight:550;cursor:pointer;touch-action:manipulation;transition:transform var(--cursor-duration-fast,.1s) var(--cursor-easing-default,ease),background-color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease),border-color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease),color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease)}
#${PROFILE_ID} button svg{width:15px;height:15px;flex:none;stroke-width:1.8}
#${PROFILE_ID} button:hover:not(:disabled){border-color:var(--cursor-stroke-primary,color-mix(in srgb,currentColor 24%,transparent));background:var(--cursor-button-secondary-hover-background,var(--cursor-bg-tertiary,color-mix(in srgb,currentColor 11%,transparent)));color:var(--cursor-text-primary,currentColor)}
#${PROFILE_ID} button:active{transform:scale(.96)}
#${PROFILE_ID} button:focus-visible{outline:2px solid var(--cursor-focus,currentColor);outline-offset:2px}
#${PROFILE_ID} button:disabled{opacity:.42;cursor:default;transform:none}
#${PROFILE_ID} #openbot-profile-save:not(.is-saved):not(:disabled){border-color:var(--cursor-text-primary,#f0f0f0);background:var(--cursor-text-primary,#f0f0f0);color:#171717}
#${PROFILE_ID} button.is-saved{border-color:color-mix(in srgb,var(--cursor-green,#45a557) 34%,transparent);background:color-mix(in srgb,var(--cursor-green,#45a557) 10%,transparent);color:var(--cursor-green,#62b574)}
#${PROFILE_ID} .ob-profile-appearance{margin:14px 0 0;padding-top:14px;border-top:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 10%,transparent))}
#${PROFILE_ID} .ob-profile-appearance-title{margin-bottom:8px;color:var(--cursor-text-secondary,currentColor);font-size:12px;font-weight:600}
#${PROFILE_ID} .ob-profile-options{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:7px 0 11px}
#${PROFILE_ID} .ob-profile-options button{min-width:36px;min-height:30px;padding:4px 9px}
#${PROFILE_ID} .ob-profile-options button[aria-pressed="true"]{border-color:var(--cursor-focus,currentColor);box-shadow:inset 0 0 0 1px var(--cursor-focus,currentColor);color:var(--cursor-text-primary,currentColor)}
#${PROFILE_ID} .ob-profile-color{width:30px!important;min-width:30px!important;height:30px;min-height:30px!important;border-radius:50%!important;padding:0!important;background:var(--swatch)!important}
#${PROFILE_ID} .ob-profile-upload-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#${PROFILE_ID} .ob-profile-status{min-height:17px;margin-top:7px;color:var(--cursor-text-tertiary,color-mix(in srgb,currentColor 60%,transparent));font-size:var(--cursor-font-size-xs,11px);line-height:1.4}
#${PROFILE_ID} .ob-profile-status.ok{color:var(--cursor-green,#45a557)}
#${PROFILE_ID} .ob-profile-status.err{color:var(--cursor-danger,#e34671)}
#${FOOTER_PROFILE_EDITOR_ID}{display:flex;width:100%;min-width:0;margin:0;padding:0 8px 2px}
#${FOOTER_PROFILE_EDITOR_ID} input{width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 14%,transparent));border-radius:6px;outline:none;background:var(--cursor-bg-input,var(--cursor-bg-editor,#181818));color:var(--cursor-text-primary,currentColor);padding:4px 6px;font:inherit}
#${FOOTER_PROFILE_EDITOR_ID} input:focus-visible{outline:2px solid var(--cursor-focus,var(--cursor-icon-accent-primary,currentColor));outline-offset:1px}
#${FOOTER_PROFILE_EDITOR_ID} input[aria-invalid="true"]{border-color:var(--cursor-danger,#e34671)}
@media (max-width:720px){#${ROOT_ID}[data-scope="global"]{flex-basis:calc(100% - 32px);width:calc(100% - 32px);max-width:calc(100% - 32px);margin-inline:16px}#${ROOT_ID}[data-scope="global"][data-native-section="1"]{flex-basis:auto;width:100%;max-width:100%;margin:0}#${ROOT_ID}[data-scope="global"] .ob-field-row{grid-template-columns:minmax(0,1fr);row-gap:8px}#${ROOT_ID}[data-scope="global"] .ob-row-control{justify-content:stretch}#${ROOT_ID}[data-scope="global"] .ob-select{flex:1 1 auto;max-width:none}}
@media (max-width:520px){#${ROOT_ID} .ob-secret-row{flex-wrap:wrap}#${ROOT_ID} .ob-secret-row>*{flex-basis:100%}}
@media (max-width:520px){#${PROFILE_ID} .ob-profile-row{align-items:stretch;flex-direction:column}#${PROFILE_ID} button{width:100%}}
@media (max-width:520px){#${WELCOME_ID}{padding:28px 22px}#${WELCOME_ID} .ob-welcome-copy{line-height:1.5}#${WELCOME_ID} button{width:min(260px,100%)}}
@media (prefers-reduced-motion:reduce){#${ROOT_ID} :is(.ob-button,.ob-select-trigger,.ob-input,.ob-advanced>summary),#${ROOT_ID} .ob-advanced>summary::after,#${EMPTY_ID} button,#${PROFILE_ID} input,#${PROFILE_ID} button,#${STOP_ID},#${WELCOME_ID},#${WELCOME_ID} .ob-welcome-kicker,#${WELCOME_ID} h1,#${WELCOME_ID} .ob-welcome-copy,#${WELCOME_ID} .ob-welcome-note,#${WELCOME_ID} button,#${WELCOME_ID}.is-leaving .ob-welcome-content,.sand-info-pane__top :is(button,[role="button"]),.sand-agent-item[data-layout="expanded"],#${CREATE_ID} .ob-create-avatar,#${ROOT_ID} .ob-select-trigger::after{transition:none}#${ROOT_ID} .ob-icon-button.is-busy svg,#${EMPTY_ID} .ob-empty-character{animation:none}}
#${STOP_ID}{position:fixed;z-index:2147483000;display:grid;place-items:center;box-sizing:border-box;border:1px solid var(--cursor-stroke-secondary,rgba(255,255,255,.14));border-radius:8px;padding:0;background:#262626;color:var(--cursor-text-primary,#ececec);font-size:0;cursor:pointer;transition:transform var(--cursor-duration-fast,.1s) var(--cursor-easing-default,ease),background-color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease)}
#${STOP_ID}::before{content:"";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:8px;height:8px;border-radius:2px;background:currentColor}
#${STOP_ID}:hover{background:var(--cursor-button-secondary-background,#333)}
#${STOP_ID}:focus-visible{outline:2px solid var(--cursor-focus,currentColor);outline-offset:2px}
#${STOP_ID}:active{transform:scale(.96)}
#${STOP_ID}[disabled]{opacity:.5;cursor:default;transform:none}
#${STOP_ID}[hidden]{display:none !important}
#openbot-prompt-queue{display:flex;flex-direction:column;gap:5px;margin:0 0 8px;color:var(--cursor-text-secondary,#aaa);font:inherit;font-size:12px}
#openbot-prompt-queue:empty{display:none}
#openbot-prompt-queue{max-height:220px;overflow-y:auto}
#openbot-prompt-queue .ob-queued-row{flex-wrap:wrap}
#openbot-prompt-queue .ob-queued-info{flex:1;min-width:0}
#openbot-prompt-queue .ob-queued-origin{font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#openbot-prompt-queue .ob-queued-error{flex-basis:100%;color:var(--cursor-text-primary,#eee);white-space:normal;overflow-wrap:anywhere}
#openbot-queue-recovery{width:min(620px,calc(100vw - 40px));max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;border:1px solid var(--cursor-stroke-secondary,#444);border-radius:14px;padding:24px;background:var(--cursor-bg-elevated,#191919);color:var(--cursor-text-primary,#eee);font:inherit}
#openbot-queue-recovery::backdrop{background:rgba(0,0,0,.55)}
#openbot-queue-recovery h2{font-size:17px;margin:0 0 12px}
#openbot-queue-recovery p{font-size:13px;line-height:1.5;overflow-wrap:anywhere}
#openbot-queue-recovery textarea{display:block;width:100%;box-sizing:border-box;resize:vertical;min-height:120px;max-height:40vh;margin-top:8px;padding:10px;border:1px solid var(--cursor-stroke-secondary,#444);border-radius:8px;background:var(--cursor-bg-secondary,#222);color:inherit;font:inherit}
#openbot-queue-recovery .ob-recovery-file,#openbot-queue-recovery .ob-recovery-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px}
#openbot-queue-recovery .ob-recovery-file span{flex:1;min-width:0;overflow-wrap:anywhere}
#openbot-queue-recovery button{padding:7px 12px;min-height:32px;border:1px solid var(--cursor-stroke-secondary,#444);border-radius:7px;background:var(--cursor-bg-secondary,#222);color:inherit;font:inherit;cursor:pointer}
#openbot-queue-recovery button:disabled{opacity:.6;cursor:default}
#openbot-queue-recovery :focus-visible{outline:2px solid var(--cursor-focus,currentColor);outline-offset:2px}
#openbot-queue-recovery input[type=file]{display:block;max-width:100%;font-size:12px}
#openbot-queue-recovery .ob-recovery-controls>label{flex:1;min-width:160px;font-size:12px}
#openbot-queue-recovery .ob-recovery-status{min-height:20px}

#openbot-prompt-queue .ob-queued-row{display:flex;align-items:center;gap:8px;min-width:0;padding:6px 8px;border:1px solid var(--cursor-stroke-secondary,#333);border-radius:8px;background:var(--cursor-bg-secondary,#222)}
#openbot-prompt-queue .ob-queued-copy{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#openbot-prompt-queue button{flex:none;min-width:28px;min-height:28px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer}
#openbot-prompt-queue button:hover{background:var(--cursor-bg-tertiary,#333)}
#openbot-prompt-queue button:focus-visible{outline:2px solid var(--cursor-focus,currentColor);outline-offset:2px}
.sand-prompt-send:is([aria-label="Start voice input"],[aria-label="Stop dictation"]){visibility:hidden!important;pointer-events:none!important}
#openbot-turn-status{font-size:12px;line-height:18px;color:var(--cursor-text-secondary,#aaa);padding:0 0 6px;pointer-events:none}
#openbot-turn-status[hidden]{display:none !important}
[data-openbot-recovery-signature],[data-openbot-recovery-signature] *{color:var(--cursor-text-secondary,#aaa)!important}
[data-openbot-recovery-highlight="1"]{outline:1px solid var(--cursor-stroke-primary,color-mix(in srgb,currentColor 24%,transparent));outline-offset:2px;border-radius:8px}
.ob-recovery-note{display:block;width:100%;box-sizing:border-box;margin:6px 0 0;color:var(--cursor-text-secondary,color-mix(in srgb,currentColor 74%,transparent));font:inherit;font-size:var(--cursor-font-size-sm,12px);line-height:1.45;overflow-wrap:anywhere}
.ob-activity-detail{font-variant-numeric:tabular-nums}
#openbot-turn-status .ob-turn-detail{display:block;font-variant-numeric:tabular-nums}
.sand-notice:has(.ob-retry-generation){min-width:0;max-width:100%;box-sizing:border-box}
.ob-retry-generation,.ob-recovery-inspect{display:flex;width:max-content;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere;align-items:center;min-height:30px;margin:8px auto 0;border:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 18%,transparent));border-radius:6px;padding:4px 10px;background:var(--cursor-button-secondary-background,var(--cursor-bg-tertiary,color-mix(in srgb,currentColor 8%,transparent)));color:var(--cursor-text-primary,currentColor);font:inherit;font-size:var(--cursor-font-size-sm,12px);cursor:pointer;transition:transform 160ms cubic-bezier(.22,1,.36,1),background-color 180ms ease,border-color 180ms ease}
.ob-retry-generation:hover,.ob-recovery-inspect:hover{border-color:var(--cursor-stroke-primary,color-mix(in srgb,currentColor 28%,transparent))}
.ob-retry-generation:active,.ob-recovery-inspect:active{transform:scale(.96)}
.ob-retry-generation:focus-visible,.ob-recovery-inspect:focus-visible{outline:2px solid var(--cursor-focus,currentColor);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.ob-retry-generation,.ob-recovery-inspect{transition:none}.ob-retry-generation:active,.ob-recovery-inspect:active{transform:none}}
.ob-retry-generation[disabled]{opacity:.6;cursor:default}
[data-openbot-hide="1"]{display:none !important}
#sand-conversation-details:has(.sand-computer-stage__placeholder){display:none!important}
.sand-chat-header__computer{display:none!important}
[role="menu"][aria-label="More message actions"] [role="menuitem"]:has([data-icon-name="chat-bubbles"]),[role="menu"][aria-label="Message actions"] [role="menuitem"]:has([data-icon-name="chat-bubbles"]){display:none!important}
[data-openbot-agent-settings-host="1"][data-openbot-simple-fields="1"]{display:grid!important;grid-template-columns:minmax(0,1fr)!important;align-content:start!important;gap:6px!important;padding:12px!important;overflow:auto!important}
[data-openbot-agent-settings-host="1"][data-openbot-simple-fields="1"]>label{margin:4px 0 0;color:var(--cursor-text-secondary,currentColor);font-size:var(--cursor-font-size-sm,12px);line-height:1.4}
[data-openbot-agent-settings-host="1"][data-openbot-simple-fields="1"]>input:not([type="checkbox"]),[data-openbot-agent-settings-host="1"][data-openbot-simple-fields="1"]>textarea{width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 12%,transparent));border-radius:6px;outline:none;background:var(--cursor-bg-input,var(--cursor-bg-editor,#181818));color:var(--cursor-text-primary,currentColor);padding:6px 8px;font:inherit}
[data-openbot-agent-settings-host="1"][data-openbot-simple-fields="1"]>input:not([type="checkbox"]){min-height:30px}
[data-openbot-agent-settings-host="1"][data-openbot-simple-fields="1"]>textarea{min-height:72px;resize:vertical}
[data-openbot-agent-settings-host="1"][data-openbot-simple-fields="1"]>input:focus-visible,[data-openbot-agent-settings-host="1"][data-openbot-simple-fields="1"]>textarea:focus-visible{outline:2px solid var(--cursor-focus,var(--cursor-icon-accent-primary,currentColor));outline-offset:2px}
[data-openbot-agent-settings-host="1"][data-openbot-simple-fields="1"]>#${ROOT_ID}{width:100%;min-width:0}
.sand-info-pane__nav-root{min-height:0;background:var(--cursor-bg-editor,#181818)}
.sand-info-pane__top{box-sizing:border-box;flex:0 0 54px!important;width:100%;height:54px!important;min-height:54px!important;gap:4px!important;padding:0 8px 0 10px!important;background:var(--cursor-bg-editor,#181818);border-bottom:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 11%,transparent))}
.sand-info-pane__back,.sand-info-pane__actions{display:flex;align-items:center;gap:4px}
.sand-info-pane__top :is(button,[role="button"]){display:grid;width:30px;height:30px;min-width:30px;min-height:30px;place-items:center;border:0;border-radius:6px;padding:0;background:transparent;color:var(--cursor-text-secondary,currentColor);transition:background-color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease),color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease),transform var(--cursor-duration-fast,.1s) var(--cursor-easing-default,ease)}
.sand-info-pane__top :is(button,[role="button"]):hover{background:var(--cursor-bg-secondary,color-mix(in srgb,currentColor 8%,transparent));color:var(--cursor-text-primary,currentColor)}
.sand-info-pane__top :is(button,[role="button"]):focus-visible{outline:2px solid var(--cursor-focus,var(--cursor-icon-accent-primary,currentColor));outline-offset:1px}
.sand-info-pane__top :is(button,[role="button"]):active{transform:scale(.94)}
.sand-info-pane__subpage-title{min-width:max-content!important;flex:1 1 auto;overflow:visible!important;color:var(--cursor-text-primary,currentColor);font-size:var(--cursor-font-size-base,13px);font-weight:var(--cursor-font-weight-semibold,600);line-height:20px;white-space:nowrap}
.sand-info-pane__window-controls-divider{display:none!important}
/* Keep the centered settings surface below native controls, including zoom/resize.
   Without a controls overlay, the original 48px vertical margin is preserved. */
.sand-settings-dialog .sand-settings-layout{height:min(700px,calc(100dvh - 2 * max(48px,calc(env(titlebar-area-height,0px) + 16px))))!important}
.sand-settings-nav[data-openbot-single-nav="1"]{display:none!important}
.ob-readonly-status{display:inline-flex;align-items:center;color:var(--cursor-text-secondary,rgba(252,252,252,.6));font-size:var(--cursor-font-size-base,13px);line-height:18px;white-space:nowrap}
.sand-info-pane__section-content{min-height:0;scrollbar-gutter:stable}
.sand-agent-settings{display:flex!important;flex-direction:column!important;gap:12px!important;padding:12px!important}
.sand-agent-settings input,.sand-agent-settings textarea{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 12%,transparent));border-radius:6px;background:var(--cursor-bg-input,var(--cursor-bg-editor,#181818));color:var(--cursor-text-primary,currentColor);font:inherit}
.sand-agent-settings input{height:30px!important;min-height:30px!important;border-radius:6px!important;padding:6px 8px!important}
.sand-agent-settings textarea{min-height:72px!important;border-radius:6px!important;padding:6px 8px!important;resize:vertical}
.sand-agent-settings__card{border:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 11%,transparent))!important;border-radius:6px!important;padding:10px!important;background:transparent!important;box-shadow:none!important}
.sand-agent-settings__row{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:12px!important}
.sand-agent-settings__text{display:flex!important;min-width:0;flex:1 1 auto;flex-direction:column;gap:2px;line-height:1.35}
.sand-agent-settings__text :is(strong,small){display:block}
.sand-agent-settings__control{flex:0 0 auto}
.sand-agents-sidebar__header{box-sizing:border-box;height:50px!important;padding:0 12px 0 16px!important;border-bottom:0!important}
.sand-agents-section[data-openbot-empty-section="1"],.sand-agents-sections[data-openbot-flat="1"] .sand-agents-section__header{display:none!important}
.sand-agents-list__rows{gap:2px!important;padding:4px 8px 8px!important}
.sand-agents-list__rows:has(.sand-agent-item[data-layout="collapsed"]){padding-inline:0!important}
.sand-agent-item[data-layout="collapsed"]{margin-inline:auto!important;justify-content:center!important;padding-inline:0!important;gap:0!important;transform:none!important}
.sand-agent-item[data-layout="expanded"]{display:grid!important;box-sizing:border-box;width:100%;min-height:58px;grid-template-columns:34px minmax(0,1fr);align-items:center;gap:9px!important;padding:8px!important;border:0;border-radius:var(--cursor-radius-lg,9px)!important;text-align:left;transition:background-color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease),transform var(--cursor-duration-fast,.1s) var(--cursor-easing-default,ease)}
.sand-agent-item[data-layout="expanded"]:hover{background:var(--cursor-bg-secondary,color-mix(in srgb,currentColor 8%,transparent))}
.sand-agent-item[data-layout="expanded"]:is([aria-current="page"],[data-active="true"]){background:var(--cursor-bg-secondary,color-mix(in srgb,currentColor 8%,transparent))}
.sand-agent-item[data-layout="expanded"]:focus-visible{outline:2px solid var(--cursor-focus,var(--cursor-icon-accent-primary,currentColor));outline-offset:-2px}
.sand-agents-sidebar :is(.sand-agents-sidebar__new,button[aria-label="New"],button[aria-label="Novo"]):focus-visible{outline:2px solid var(--cursor-focus,var(--cursor-icon-accent-primary,#f0f0f0))!important;outline-offset:2px!important}
.sand-agent-item[data-layout="expanded"]:active{transform:scale(.985)}
.sand-agent-item__avatar{display:grid!important;flex:0 0 34px!important;width:34px!important;height:34px!important;place-items:center;align-self:center;overflow:visible}
.sand-agent-item__avatar-disc{display:grid!important;width:34px!important;height:34px!important;place-items:center;overflow:hidden;border-radius:var(--cursor-radius-lg,9px)}
.sand-agent-item__avatar :is(svg,img){display:block;width:34px!important;height:34px!important;max-width:none}
.sand-agent-item__body{display:grid!important;width:auto!important;min-width:0!important;overflow:hidden;flex:1 1 auto!important;justify-content:stretch;gap:4px!important}
.sand-agent-item__title{display:flex!important;width:auto!important;min-width:0!important;align-items:baseline!important;gap:6px!important}
.sand-agent-item__name{min-width:0;overflow:hidden;font-weight:var(--cursor-font-weight-semibold,600);text-overflow:ellipsis;white-space:nowrap}
.sand-agent-item__title-badge{max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sand-agent-item__time{flex:0 0 auto;margin-left:auto;color:var(--cursor-text-tertiary,color-mix(in srgb,currentColor 60%,transparent))}
body .ui-menu__content{color-scheme:dark!important;background:var(--cursor-bg-elevated,#1f1f1f)!important;border-color:var(--cursor-stroke-secondary,#414141)!important;color:var(--cursor-text-primary,#ececec)!important}
body .ui-menu__content [role="menuitem"]{border-color:transparent!important;background:transparent!important;color:var(--cursor-text-primary,#ececec)!important}
body .ui-menu__content [role="menuitem"]:is(:hover,:focus-visible){background:var(--cursor-bg-hover,var(--cursor-bg-secondary,#303030))!important;color:var(--cursor-text-primary,#fff)!important}
body :is(.sand-workflow-listbox,.sand-reference-menu,.sand-mention-menu,.sand-pr-menu,.sand-emoji-menu,.sand-new-chat-menu){color-scheme:dark!important;background:var(--cursor-bg-elevated,#1f1f1f)!important;border-color:var(--cursor-stroke-secondary,#414141)!important;color:var(--cursor-text-primary,#ececec)!important}
body :is(.sand-workflow-listbox,.sand-reference-menu,.sand-mention-menu,.sand-pr-menu,.sand-emoji-menu,.sand-new-chat-menu) :is([role="option"],button){color:var(--cursor-text-primary,#ececec)!important}
body :is(.sand-workflow-listbox,.sand-reference-menu,.sand-mention-menu,.sand-pr-menu,.sand-emoji-menu,.sand-new-chat-menu) :is([role="option"],button):is(:hover,:focus-visible,[aria-selected="true"]){background:var(--cursor-bg-hover,var(--cursor-bg-secondary,#303030))!important}
body:not(.ob-dialog-open):not(:has(${MODAL_LAYER_SELECTOR})) :is([aria-hidden="true"],[inert]) #${ROOT_ID}{display:none!important}
@media (max-width:900px){#sand-conversation-details[data-openbot-responsive-settings="1"]{position:fixed!important;inset:0 0 0 auto!important;z-index:2147482500!important;display:block!important;width:min(360px,100vw)!important;min-width:min(360px,100vw)!important;max-width:min(360px,100vw)!important;height:100vh!important;max-height:100vh!important;overflow:hidden!important;visibility:visible!important;opacity:1!important;background:var(--cursor-bg-editor,#181818)!important;box-shadow:-18px 0 42px rgba(0,0,0,.38)!important}#sand-conversation-details[data-openbot-responsive-settings="1"] .sand-info-pane__inner{position:absolute!important;inset:0!important;display:flex!important;width:auto!important;min-width:0!important;max-width:none!important;height:auto!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important}#sand-conversation-details[data-openbot-responsive-settings="1"] .sand-info-pane__nav-root{width:100%!important;min-width:0!important;max-width:100%!important;height:100%!important;flex:1 1 100%!important}#sand-conversation-details[data-openbot-responsive-settings="1"] :is(.sand-info-pane__section-content,[data-openbot-agent-settings-host="1"],#${ROOT_ID}){width:100%!important;min-width:0!important;max-width:100%!important;box-sizing:border-box!important}#sand-conversation-details[data-openbot-responsive-settings="1"] #${ROOT_ID}{display:block!important}}
.sand-agent-item__preview-row{min-width:0}
.sand-agent-item__preview,.sand-agent-item__activity{display:block;overflow:hidden;color:var(--cursor-text-secondary,color-mix(in srgb,currentColor 74%,transparent));text-overflow:ellipsis;white-space:nowrap}
.sand-agent-item__body:not(:has(.sand-agent-item__preview-row))::after{content:"Pronto para conversar";display:block;overflow:hidden;color:var(--cursor-text-tertiary,color-mix(in srgb,currentColor 58%,transparent));font-size:var(--cursor-font-size-sm,12px);line-height:16px;text-overflow:ellipsis;white-space:nowrap}
.sand-chat-header{box-sizing:border-box;min-height:51px!important;padding:0 16px!important;border-bottom:none!important}header.sand-toolbar:has(>.sand-chat-header){border-bottom:1px solid var(--cursor-stroke-tertiary,color-mix(in srgb,currentColor 10%,transparent))}
.sand-transcript-row[data-role="user"],.sand-transcript-row[data-openbot-side="user"]{align-items:flex-end!important}
.sand-transcript-row[data-role="assistant"],.sand-transcript-row[data-openbot-side="assistant"]{align-items:flex-start!important}
.sand-transcript-row[data-role="user"]>:not([hidden]),.sand-transcript-row[data-openbot-side="user"]>:not([hidden]){display:flex!important;flex-direction:column!important;align-items:flex-end!important;box-sizing:border-box;max-width:min(82%,640px)!important;width:100%!important;margin-inline-start:auto!important}
.sand-transcript-row:is([data-role="user"],[data-openbot-side="user"]) .sand-author-run{justify-content:flex-end!important}
.sand-transcript-row:is([data-role="user"],[data-openbot-side="user"]) .sand-author-run__column{flex:0 1 auto!important;max-width:calc(100% - 30px)!important;align-items:flex-end!important}
.sand-transcript-row:is([data-role="user"],[data-openbot-side="user"]) .sand-author-run__column .sand-message-block{align-items:flex-end!important}
.sand-transcript-row:is([data-role="user"],[data-openbot-side="user"]) .sand-author-run__column .sand-message-action-anchor{max-width:none!important}
.sand-transcript-row[data-role="assistant"]>:not([hidden]),.sand-transcript-row[data-openbot-side="assistant"]>:not([hidden]){box-sizing:border-box;max-width:min(82%,720px)!important;margin-inline-end:auto!important}
.sand-transcript-row[data-openbot-side="assistant"]>.sand-row-content{position:relative!important;padding-inline-start:30px!important}
.openbot-message-avatar{position:absolute;top:19px;inset-inline-start:0;display:grid;width:22px;height:22px;place-items:center;pointer-events:none}
.openbot-message-avatar .sand-agent-avatar{--fg:var(--openbot-message-avatar-fg)!important}
.openbot-message-avatar .sand-agent-avatar,.openbot-message-avatar :is(svg,img){display:block;width:22px!important;height:22px!important;max-width:none}
.sand-chat-input-dock{display:flex!important;width:100%!important;min-width:0;box-sizing:border-box;flex:0 0 auto;flex-direction:column;padding:8px max(24px,calc((100% - 700px)/2)) 18px!important;background:var(--cursor-bg-editor,#181818)!important}
.sand-prompt-form{width:100%!important}
.sand-prompt-shell{position:relative;height:auto!important;min-height:88px!important;padding:9px!important;border:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 14%,transparent))!important;border-radius:16px!important;background:var(--cursor-bg-input-surface,var(--cursor-bg-input,var(--cursor-bg-editor,#181818)))!important;box-shadow:var(--cursor-box-shadow-sm,0 1px 3px rgba(0,0,0,.22))!important}
.sand-prompt-shell .sand-prompt-pad{height:auto!important;min-height:68px!important;padding:0!important;justify-content:flex-start!important}
.sand-prompt-shell .sand-prompt-field-host{height:auto!important;min-height:48px!important}
.sand-prompt-shell .sand-prompt-field{position:relative!important;inset:auto!important;display:block;box-sizing:border-box;width:100%!important;height:auto!important;min-height:48px!important;padding:3px 2px 0!important;overflow-y:auto!important;resize:none;color:var(--cursor-text-primary,currentColor);background:transparent;border:0;outline:none;line-height:20px!important}
.sand-prompt-shell .sand-prompt-field:not(:has(p.is-editor-empty[data-placeholder])){padding-bottom:40px!important}
.sand-prompt-shell:has(.sand-prompt-reply-pill){min-height:118px!important;overflow:visible!important}
.sand-prompt-reply-pill{position:relative!important;z-index:2!important}
.sand-prompt-attachments{margin-top:3px!important;margin-bottom:3px!important;overflow:visible!important}
.sand-prompt-attachment{opacity:1;transform:translateY(0);transition:opacity 160ms cubic-bezier(.23,1,.32,1),transform 160ms cubic-bezier(.23,1,.32,1)}
@starting-style{.sand-prompt-attachment{opacity:0;transform:translateY(2px)}}
@media (prefers-reduced-motion:reduce){.sand-prompt-attachment{transform:none!important;transition:opacity 120ms linear}@starting-style{.sand-prompt-attachment{opacity:0;transform:none!important}}}
.sand-prompt-field:has(p.is-editor-empty[data-placeholder]){caret-color:var(--cursor-text-primary,currentColor)!important;overflow-y:hidden!important}
.sand-prompt-field p.is-editor-empty[data-placeholder]{min-height:20px!important;margin:0!important;line-height:20px!important}
.sand-prompt-field p.is-editor-empty[data-placeholder]::before{content:"Escreva uma mensagem"!important;display:block!important;top:2px!important;right:0!important;left:2px!important;height:22px!important;overflow:visible!important;color:var(--cursor-text-secondary,rgba(252,252,252,.62))!important;line-height:20px!important;opacity:1!important}
.sand-prompt-actions-row{display:flex;align-items:center;justify-content:space-between}
.sand-prompt-attach,.sand-prompt-send{box-sizing:border-box;width:30px!important;height:30px!important;min-width:30px!important;min-height:30px!important;padding:0!important;border-radius:50%!important}
.sand-prompt-send{display:grid!important;place-items:center;border:0!important}
.sand-onboarding__meet .sand-onboarding__composer p{position:relative;color:transparent!important}
.sand-onboarding__meet .sand-onboarding__composer p::after{content:"Dê uma tarefa ao seu time de bots";position:absolute;top:0;left:0;color:var(--cursor-text-primary,#ececec);white-space:nowrap}
.sand-onboarding__meet [data-openbot-onboarding-title="1"]{color:#f4f4f4!important;font-weight:500!important;text-shadow:0 0 .4px #f4f4f4;opacity:1!important}
.sand-onboarding__meet [data-openbot-onboarding-continue="1"]{border-color:#f4f4f4!important;background-color:#f4f4f4!important;background-image:linear-gradient(#f4f4f4,#f4f4f4)!important;color:#171717!important;box-shadow:inset 0 0 0 999px #f4f4f4!important;opacity:1!important}
.sand-transcript-row[data-openbot-delivery-confirmed="1"] .sand-failed-send-actions{display:none!important}
.sand-transcript-row[data-pending="true"] .sand-row-timestamp::after{content:" · Pendente de confirmação";white-space:nowrap}
.sand-virtual-transcript__inset[aria-hidden="true"]{pointer-events:none}
#openbot-timezone-filter{display:grid;gap:6px;margin:6px 8px 8px}
#openbot-timezone-filter input{height:30px;border:1px solid var(--cursor-stroke-secondary,#414141);border-radius:6px;outline:0;padding:0 9px;background:var(--cursor-bg-input,var(--cursor-bg-editor,#181818));color:var(--cursor-text-primary,#ececec);font:inherit}
#openbot-timezone-filter input:focus-visible{outline:2px solid var(--cursor-focus,#f0f0f0);outline-offset:1px}
#openbot-timezone-filter [role="status"]{min-height:14px;color:var(--cursor-text-tertiary,#888);font-size:11px}
body .obp23-panel{display:flex;flex-direction:column;box-sizing:border-box;width:min(860px,calc(100vw - 32px));height:min(620px,calc(100vh - 32px));max-height:min(620px,calc(100vh - 32px));margin:16px auto;background:var(--cursor-bg-elevated,#202020);color:var(--cursor-text-primary,#ececec);border-color:var(--cursor-stroke-secondary,#414141);border-radius:14px;padding:0;overflow:hidden;font:13px/1.4 var(--cursor-font-family-sans,Inter,system-ui,sans-serif)}
body .obp23-head{box-sizing:border-box;min-height:54px;padding:0 14px 0 24px;border-bottom:1px solid var(--cursor-stroke-secondary,#383838)}
body .obp23-head h2{margin:0;font-size:15px;font-weight:600}
body .obp23-body{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;min-height:0;padding:24px;overflow:auto}
body .obp23-panel button{min-height:30px;margin:0;border:1px solid var(--cursor-stroke-tertiary,#494949);border-radius:6px;padding:5px 9px;background:var(--cursor-button-secondary-background,var(--cursor-bg-secondary,#292929));color:var(--cursor-text-primary,#ececec);font:inherit}
body .obp23-panel .obp23-close{width:30px;min-width:30px;border:0;background:transparent!important;font-size:20px;line-height:1}
body .obp23-card>div,body .obp23-replies>div,body .obp23-pager{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
body .obp23-panel :is(#obp23-sendatt,#obp23-sendreply,[data-act="p23-search"]):not(:disabled){border-color:var(--cursor-text-primary,#f0f0f0);background:var(--cursor-text-primary,#f0f0f0);color:#171717;font-weight:600}
body .obp23-panel input,body .obp23-panel textarea{min-height:30px;border-color:var(--cursor-stroke-secondary,#414141);border-radius:6px;background:var(--cursor-bg-input,var(--cursor-bg-editor,#181818));color:var(--cursor-text-primary,#ececec);font:inherit}
body .obp23-card,body .obp23-replies{border:0;border-radius:0;padding:14px 0;background:transparent}
body .obp23-card+.obp23-card,body .obp23-card+.obp23-replies{border-top:1px solid var(--cursor-stroke-secondary,#414141)}
body .obp23-body>.obp23-hint,body .obp23-card h3,body .obp23-replies h3{margin-top:0}
body .obp23-body>.obp23-hint{margin-bottom:0}
body .obp23-panel :is(button,input,textarea,[role="button"]):focus-visible{outline:2px solid var(--cursor-stroke-focused,var(--cursor-focus,#f0f0f0));outline-offset:1px}
#openbot-tasks-dialog{position:fixed!important;inset:0!important;z-index:2147483500!important;pointer-events:none}
#openbot-tasks-dialog .obp22-backdrop{pointer-events:auto;background:rgba(0,0,0,.58)!important}
#openbot-tasks-dialog .obp22-panel{box-sizing:border-box!important;top:50%!important;width:min(860px,calc(100vw - 32px))!important;height:min(620px,calc(100vh - 32px))!important;max-height:min(620px,calc(100vh - 32px))!important;transform:translate(-50%,-50%)!important;overflow:hidden;pointer-events:auto;background:var(--cursor-bg-elevated,#202020)!important;border:1px solid var(--cursor-stroke-secondary,#414141)!important;border-radius:14px!important;box-shadow:0 26px 70px rgba(0,0,0,.4)!important}
#openbot-tasks-dialog .obp22-head{position:relative;z-index:2;box-sizing:border-box;min-height:54px!important;flex:0 0 54px!important;padding:0 14px 0 24px!important;background:transparent!important;color:var(--cursor-text-primary,#f0f0f0)!important;border-bottom:1px solid var(--cursor-stroke-secondary,#414141)!important}
#openbot-tasks-dialog .obp22-body{position:relative;z-index:1;box-sizing:border-box;min-height:0!important;flex:1 1 auto!important;padding:24px!important;overflow:auto!important;background:transparent!important}
#openbot-tasks-dialog .ob-task-item{border-radius:9px!important}
#openbot-tasks-dialog .ob-task-item button,#openbot-tasks-dialog .obp22-steer input{border-radius:6px!important}
#openbot-tasks-dialog .obp22-close{display:grid;width:30px!important;height:30px!important;min-width:30px!important;min-height:30px!important;place-items:center;margin:0!important;border:0!important;border-radius:6px!important;padding:0!important;background:transparent!important;font-size:0!important}
#openbot-tasks-dialog .obp22-close::before{content:"×";font-size:20px;line-height:1}
body :is(.ob-dialog .ob-close,.obp23-panel .obp23-close,#openbot-tasks-dialog .obp22-close){color:var(--cursor-text-secondary,#a0a0a0)!important}
body :is(.ob-dialog .ob-close,.obp23-panel .obp23-close,#openbot-tasks-dialog .obp22-close):hover{background:var(--cursor-bg-tertiary,rgba(255,255,255,.08))!important;color:var(--cursor-text-primary,#f0f0f0)!important}
body :is(.ob-dialog .ob-close,.obp23-panel .obp23-close,#openbot-tasks-dialog .obp22-close):focus-visible{outline:2px solid var(--cursor-stroke-focused,var(--cursor-focus,#f0f0f0));outline-offset:1px}
body :is(.ob-dialog .ob-close,.obp23-panel .obp23-close,#openbot-tasks-dialog .obp22-close):active{transform:scale(.96)}
#${CREATE_ID}{position:fixed;inset:0;z-index:2147483646;display:grid;grid-template-rows:52px minmax(0,1fr);box-sizing:border-box;color:var(--cursor-text-primary,#f2f2f2);background:var(--cursor-bg-editor,#090909);font-family:var(--cursor-font-family-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);-webkit-font-smoothing:antialiased}
#${CREATE_ID} *{box-sizing:border-box}
#${CREATE_ID}{opacity:1;transition:opacity 180ms ease}
#${CREATE_ID} .ob-create-form{transform:translateY(0);transition:transform 180ms ease}
@starting-style{#${CREATE_ID}{opacity:0}#${CREATE_ID} .ob-create-form{transform:translateY(4px)}}
#${CREATE_ID}.is-leaving{opacity:0;pointer-events:none}
#${CREATE_ID}.is-leaving .ob-create-form{transform:translateY(4px)}
@media (prefers-reduced-motion:reduce){#${CREATE_ID},#${CREATE_ID} .ob-create-form{transition:none}}
#${CREATE_ID} .ob-create-header{display:flex;min-width:0;align-items:center;gap:8px;padding:0 16px;border-bottom:1px solid var(--cursor-stroke-secondary,#262626);font-size:13px;font-weight:600}
#${CREATE_ID} .ob-create-header .ob-create-mini{width:20px;height:20px}
#${CREATE_ID} .ob-create-close{display:grid;width:30px;height:30px;min-width:30px;place-items:center;margin-left:auto;margin-right:138px;border:0;border-radius:6px;background:transparent;color:var(--cursor-text-secondary,#a0a0a0);font-size:20px;line-height:1;cursor:pointer;-webkit-app-region:no-drag}
#${CREATE_ID} .ob-create-close:hover{background:var(--cursor-bg-secondary,#242424);color:var(--cursor-text-primary,#fff)}
#${CREATE_ID} .ob-create-scroll{min-height:0;overflow:auto;overscroll-behavior:contain}
#${CREATE_ID} .ob-create-stage{display:flex;min-height:100%;flex-direction:column;align-items:center;padding:clamp(44px,8vh,92px) 24px 24px}
#${CREATE_ID} .ob-create-form{display:grid;width:min(360px,100%);justify-items:center;gap:18px}
#${CREATE_ID} .ob-create-avatar{position:relative;display:block;width:60px;height:60px;background:var(--ob-avatar,#0b84f3);transition:background-color 140ms ease,border-radius 140ms ease,clip-path 140ms ease}
#${CREATE_ID} .ob-create-avatar[data-shape="circle"]{border-radius:50%}
#${CREATE_ID} .ob-create-avatar[data-shape="blob"]{border-radius:46% 54% 52% 48%/52% 43% 57% 48%}
#${CREATE_ID} .ob-create-avatar[data-shape="pebble"]{border-radius:58% 42% 50% 50%/45% 55% 45% 55%}
#${CREATE_ID} .ob-create-avatar[data-shape="squircle"]{border-radius:30%}
#${CREATE_ID} .ob-create-avatar[data-shape="tablet"]{border-radius:42% 42% 28% 28%/50% 50% 38% 38%}
#${CREATE_ID} .ob-create-avatar[data-shape="wedge"]{clip-path:polygon(50% 0,100% 82%,76% 100%,24% 100%,0 82%);border-radius:18%}
#${CREATE_ID} .ob-create-avatar[data-shape="hex"]{clip-path:polygon(25% 6%,75% 6%,100% 50%,75% 94%,25% 94%,0 50%)}
#${CREATE_ID} .ob-create-avatar[data-shape="cloud"]{border-radius:54% 46% 38% 62%/56% 42% 58% 44%}
#${CREATE_ID} .ob-create-avatar[data-shape="teardrop"]{border-radius:58% 42% 58% 42%/42% 42% 58% 58%;transform:rotate(45deg)}
#${CREATE_ID} .ob-create-avatar::before,#${CREATE_ID} .ob-create-avatar::after{content:"";position:absolute;top:55%;width:7px;height:16px;border-radius:6px;background:#0a0a0a;transform:translateY(-50%) rotate(16deg)}
#${CREATE_ID} .ob-create-avatar::before{left:19px}
#${CREATE_ID} .ob-create-avatar::after{right:19px}
#${CREATE_ID} .ob-create-avatar[data-shape="teardrop"]::before,#${CREATE_ID} .ob-create-avatar[data-shape="teardrop"]::after{transform:translateY(-50%) rotate(-29deg)}
@media (prefers-reduced-motion:reduce){#${CREATE_ID} .ob-create-avatar{transition:none}}
#${CREATE_ID} .ob-create-choices{display:flex;flex-wrap:wrap;justify-content:center;gap:10px}
#${CREATE_ID} .ob-create-choice{display:grid;width:22px;height:22px;min-width:22px;place-items:center;border:0;border-radius:50%;padding:0;background:var(--choice,#777);cursor:pointer;box-shadow:0 0 0 1px transparent}
#${CREATE_ID} .ob-create-choice[aria-pressed="true"]{box-shadow:0 0 0 2px var(--cursor-bg-editor,#090909),0 0 0 3px var(--cursor-text-secondary,#aaa)}
#${CREATE_ID} .ob-create-shape{width:24px;height:24px;background:transparent}
#${CREATE_ID} .ob-create-shape .ob-create-avatar{width:22px;height:22px}
#${CREATE_ID} .ob-create-shape .ob-create-avatar::before,#${CREATE_ID} .ob-create-shape .ob-create-avatar::after{top:54%;width:3px;height:6px}
#${CREATE_ID} .ob-create-shape .ob-create-avatar::before{left:7px}
#${CREATE_ID} .ob-create-shape .ob-create-avatar::after{right:7px}
#${CREATE_ID} .ob-create-field{display:grid;width:100%;gap:6px;margin-top:2px}
#${CREATE_ID} .ob-create-field label{color:var(--cursor-text-secondary,#b4b4b4);font-size:12px}
#${CREATE_ID} .ob-create-field input{width:100%;height:34px;border:1px solid var(--cursor-stroke-secondary,#303030);border-radius:6px;outline:0;padding:0 10px;background:var(--cursor-bg-editor,#111);color:var(--cursor-text-primary,#f2f2f2);font:inherit;font-size:13px}
#${CREATE_ID} .ob-create-field input:focus-visible{outline:2px solid var(--cursor-focus,#f0f0f0);outline-offset:2px;border-color:var(--cursor-focus,#f0f0f0)}
#${CREATE_ID} .ob-create-submit{min-width:104px;height:34px;border:0;border-radius:6px;padding:0 14px;background:var(--cursor-text-primary,#f3f3f3);color:#171717;font:inherit;font-size:13px;font-weight:500;cursor:pointer}
#${CREATE_ID} .ob-create-submit:disabled{opacity:.28;cursor:default}
#${CREATE_ID}[aria-busy="true"] .ob-create-submit{display:inline-flex;align-items:center;justify-content:center;gap:8px;opacity:1;cursor:progress}
#${CREATE_ID}[aria-busy="true"] .ob-create-submit::before{content:"";width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:ob-create-spin 800ms linear infinite}
@keyframes ob-create-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){#${CREATE_ID}[aria-busy="true"] .ob-create-submit::before{animation:none}}
#${CREATE_ID} .ob-create-status{min-height:17px;margin:-8px 0 0;color:var(--cursor-danger,#e35d6a);font-size:12px;text-align:center}
#${CREATE_ID} .ob-create-suggestions{width:min(920px,100%);margin-top:auto;padding-top:clamp(46px,12vh,120px)}
#${CREATE_ID} .ob-create-suggestions h2{margin:0 0 8px;color:var(--cursor-text-secondary,#b4b4b4);font-size:12px;font-weight:400}
#${CREATE_ID} .ob-create-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
#${CREATE_ID} .ob-create-card{display:grid;grid-template-columns:42px minmax(0,1fr);align-items:center;gap:12px;min-height:94px;border:1px solid var(--cursor-stroke-secondary,#292929);border-radius:16px;padding:14px 18px;background:transparent;color:inherit;text-align:left;cursor:pointer}
#${CREATE_ID} .ob-create-card:hover{border-color:var(--cursor-stroke-primary,#424242);background:var(--cursor-bg-secondary,#141414)}
#${CREATE_ID} .ob-create-card[aria-pressed="true"]{border-color:var(--cursor-focus,#f0f0f0);background:var(--cursor-bg-secondary,#141414)}
#${CREATE_ID} .ob-create-card .ob-create-avatar{width:36px;height:36px}
#${CREATE_ID} .ob-create-card .ob-create-avatar::before,#${CREATE_ID} .ob-create-card .ob-create-avatar::after{width:4px;height:9px}
#${CREATE_ID} .ob-create-card .ob-create-avatar::before{left:11px}
#${CREATE_ID} .ob-create-card .ob-create-avatar::after{right:11px}
#${CREATE_ID} .ob-create-card strong{display:block;margin-bottom:4px;font-size:15px;font-weight:600}
#${CREATE_ID} .ob-create-card span:last-child{display:block;color:var(--cursor-text-secondary,#a6a6a6);font-size:13px;line-height:1.35}
#${CREATE_ID} :is(.ob-create-close,.ob-create-choice,.ob-create-shape,.ob-create-card,.ob-create-submit):focus-visible{outline:2px solid var(--cursor-focus,#f0f0f0);outline-offset:2px}
#${CREATE_ID} :is(.ob-create-close,.ob-create-choice,.ob-create-card,.ob-create-submit){transition:background-color 120ms ease,border-color 120ms ease,box-shadow 120ms ease,transform 100ms ease}
#${CREATE_ID} :is(.ob-create-close,.ob-create-choice,.ob-create-card,.ob-create-submit):active:not(:disabled){transform:scale(.98)}
#${CREATE_ID} .ob-create-choice:hover:not(:disabled){box-shadow:0 0 0 2px var(--cursor-bg-editor,#090909),0 0 0 3px var(--cursor-text-primary,#f2f2f2)}
@media (prefers-reduced-motion:reduce){#${CREATE_ID} :is(.ob-create-close,.ob-create-choice,.ob-create-card,.ob-create-submit){transition:none}#${CREATE_ID} :is(.ob-create-close,.ob-create-choice,.ob-create-card,.ob-create-submit):active:not(:disabled){transform:none}}
@media (max-width:850px){#${CREATE_ID} .ob-create-close{margin-right:138px}#${CREATE_ID} .ob-create-cards{grid-template-columns:1fr}#${CREATE_ID} .ob-create-suggestions{padding-top:46px}}
`;

  const desktop = () => window.__openbotLocalSettingsDesktop || window.desktop;
  const profileAgent = () => window.__openbotLocalProfileAgent || desktop()?.agent;
  const textOf = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  // Single normalizer for every failure this overlay shows: strips Electron IPC
  // and Error prefixes, maps known transport/contract failures to short pt-BR
  // copy and falls back to the caller's operation message for anything that is
  // still technical or not Portuguese. It never turns a failure into success copy.
  const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']*':\s*/i;
  const KNOWN_ERRORS = [
    [/Descoberta indispon[ií]vel/i, "A lista de modelos não pode ser consultada neste ambiente."],
    [/stale-active-agent|active agent changed|stale request|o bot ativo mudou|bot selecionado mudou/i, "O bot selecionado mudou. Reabra as configurações."],
    [/ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed|Failed to fetch|NetworkError|socket hang up/i, "O OpenBot local não respondeu. Tente novamente."],
    [/\btimed? ?out\b|timeout|AbortError|operation was aborted/i, "A operação demorou demais. Tente novamente."],
    [/configuração alterada; tente novamente|\b409\b/i, "A configuração mudou em outro lugar. Tente novamente."],
    [/unauthorized|forbidden|not-signed-in|\b40[13]\b/i, "O OpenBot local recusou a solicitação. Reinicie o aplicativo e tente novamente."],
    [/OpenBot local mode is required/i, "Disponível apenas no modo local do OpenBot."],
    [/Invalid (?:OAuth )?(?:provider|service tier|reasoning effort)/i, "Opção não suportada por este provedor."],
  ];
  const PORTUGUESE_HINT = /[ãõçáéíóúâêôà]|\b(?:não|nao|de|do|da|para|com|sem|está|foi|falha|erro|modelo|conta|chave|bot|tente)\b/i;
  const userFacingError = (error, fallback) => {
    const raw = (error instanceof Error ? error.message : typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "").trim();
    for (const [pattern, text] of KNOWN_ERRORS) if (pattern.test(raw)) return text;
    const message = raw.replace(IPC_ERROR_PREFIX, "").replace(/^(?:[A-Za-z]*Error:\s*)+/, "").replace(/^[a-z][A-Za-z]+:\s+/, "").trim();
    if (!message || /invoking remote method|gateway-command-failed|\bsand:|[{}<>]|\bat\s+\S+\s*\(|https?:\/\/|\b[a-z]\w*\.[a-z]\w*/i.test(message) || !PORTUGUESE_HINT.test(message)) return fallback;
    return message.charAt(0).toLocaleUpperCase("pt-BR") + message.slice(1);
  };
  const SETTINGS_LABELS = /^(Name|Nome|Title|Título|Titulo|Description|Descrição|Descricao|Notifications|Notificações|Notificacoes)$/i;
  // Help Center opens cursor.com and Send Feedback posts to the Cursor backend
  // with a Cursor token; neither works in the local build, in any language.
  const UNAVAILABLE_NAV_LABELS = /^(Help Center|Send Feedback|Updates|Central de ajuda|Enviar feedback)$/i;
  const UNSUPPORTED_COMMAND_LABELS = /^(Start a thread|Iniciar (?:uma )?thread|Settings: Updates|Plugins|Feature Flags…?|Capture Backend RPC Trace(?: \(2 min\))?|Update OpenBot(?:'s|’s) Computer)$/i;
  const UNSAFE_SECTION_ACTION = /^(Move to new section|Mover para nova seção)$/i;
  const LEGACY_SCREEN_LABELS = /^(?:Can't reach .+ screen|.+['’]s screen)$/i;
  const LEGACY_CURSOR_COMPOSER = /Sign in to Cursor in settings,\s*then ask anything\.?/i;
  const OPENBOT_EMPTY_COMPOSER = "Crie ou selecione um bot para começar.";
  const NATIVE_CREATE_LABEL = /^(?:Create new(?: Bot)?|New Bot|Novo(?: bot)?)(?:\s|$)/i;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function hideMatching(el) {
    const target = el.closest("li, [role='listitem'], [role='menuitem']") || el;
    target.setAttribute("data-openbot-hide", "1");
  }

  function isSidebarNewControl(control) {
    if (!(control instanceof Element)) return false;
    if (control.matches(".sand-agents-sidebar__new")) return true;
    const aria = (control.getAttribute("aria-label") || "").trim();
    const title = (control.getAttribute("title") || "").trim();
    return (/^New$/i.test(aria) || /^New chat$/i.test(title)) && Boolean(control.closest(".sand-agents-sidebar"));
  }

  const CREATE_COLORS = ["#a8733a", "#ff3151", "#ff7600", "#ff9f0a", "#12c98a", "#19b8ae", "#1689f5", "#8b5cf6", "#ef3d98", "#7d7d7d"];
  const CREATE_SHAPES = ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop"];
  const CREATE_SUGGESTIONS = [
    { name: "Turno da noite", description: "Trabalha durante a noite e prepara seu resumo da manhã.", color: "#ff7600", shape: "blob" },
    { name: "Triagem da caixa", description: "Organiza seus e-mails e prepara respostas no seu estilo.", color: "#ef3d98", shape: "cloud" },
    { name: "Chefe de gabinete", description: "Coordena seus outros bots e chama você para decisões.", color: "#ff3151", shape: "tablet" },
  ];

  function createAvatarMarkup(color, shape, className = "") {
    return `<span class="ob-create-avatar ${className}" data-shape="${shape}" style="--ob-avatar:${color}" aria-hidden="true"></span>`;
  }

  function closeCreateAgent() {
    const root = document.getElementById(CREATE_ID);
    if (!root || root.classList.contains("is-leaving")) return;
    root.inert = true;
    root.classList.add("is-leaving");
    if (motionReduced()) root.remove();
    else setLocalTimeout(() => root.remove(), 180);
  }

  function selectCreatedAgent(name, id) {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      const attempt = () => {
        const rows = [...document.querySelectorAll(".sand-agent-item[data-layout='expanded']")];
        const row = rows.find((candidate) => {
          const candidateId = candidate.getAttribute("data-agent-id") || candidate.querySelector("[data-agent-id]")?.getAttribute("data-agent-id");
          if (id && candidateId) return candidateId === id;
          return candidate.querySelector(".sand-agent-item__name")?.textContent?.trim() === name;
        });
        if (row instanceof HTMLElement) {
          row.click();
          resolve(true);
          return;
        }
        if (performance.now() - startedAt >= 2500) {
          resolve(false);
          return;
        }
        setLocalTimeout(attempt, 40);
      };
      attempt();
    });
  }

  function openCreateAgent() {
    const current = document.getElementById(CREATE_ID);
    // A surface still fading out from a cancel is about to be removed; reusing
    // it would make the new one disappear. Start a fresh one instead.
    if (current?.classList.contains("is-leaving")) current.remove();
    else if (current) {
      current.querySelector("input[name='name']")?.focus({ preventScroll: true });
      return current;
    }
    ensureStyle();
    document.getElementById(ROOT_ID)?.remove();
    const root = document.createElement("section");
    root.id = CREATE_ID;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Criar novo bot");
    root.innerHTML = `
      <header class="ob-create-header">
        ${createAvatarMarkup("#1689f5", "blob", "ob-create-mini")}
        <span>Novo bot</span>
        <button class="ob-create-close" type="button" data-action="cancel" aria-label="Cancelar criação">×</button>
      </header>
      <div class="ob-create-scroll">
        <main class="ob-create-stage">
          <form class="ob-create-form" novalidate>
            ${createAvatarMarkup("#1689f5", "blob", "ob-create-preview")}
            <div class="ob-create-choices" role="group" aria-label="Cor do bot">
              ${CREATE_COLORS.map((color) => `<button class="ob-create-choice" type="button" aria-label="Cor ${color}" aria-pressed="${color === "#1689f5"}" data-color="${color}" style="--choice:${color}"></button>`).join("")}
            </div>
            <div class="ob-create-choices" role="group" aria-label="Formato do bot">
              ${CREATE_SHAPES.map((shape) => `<button class="ob-create-choice ob-create-shape" type="button" aria-label="Formato ${shape}" aria-pressed="${shape === "blob"}" data-shape="${shape}">${createAvatarMarkup("#1689f5", shape)}</button>`).join("")}
            </div>
            <div class="ob-create-field"><label for="openbot-create-name">Nome</label><input id="openbot-create-name" name="name" type="text" maxlength="80" placeholder="Novo bot" autocomplete="off" spellcheck="false"></div>
            <button class="ob-create-submit" type="submit" data-action="submit" disabled>Começar</button>
            <p class="ob-create-status" role="status" aria-live="polite"></p>
          </form>
          <section class="ob-create-suggestions" aria-label="Sugestões">
            <h2>Sugestões</h2>
            <div class="ob-create-cards">
              ${CREATE_SUGGESTIONS.map((item, index) => `<button class="ob-create-card" type="button" data-suggestion="${index}">${createAvatarMarkup(item.color, item.shape)}<span><strong>${item.name}</strong><span>${item.description}</span></span></button>`).join("")}
            </div>
          </section>
        </main>
      </div>`;
    let color = "#1689f5";
    let shape = "blob";
    let description = "";
    let submitting = false;
    const form = root.querySelector("form");
    const input = root.querySelector("input[name='name']");
    const submit = root.querySelector("[data-action='submit']");
    const status = root.querySelector(".ob-create-status");
    const preview = root.querySelector(".ob-create-preview");
    const headerAvatar = root.querySelector(".ob-create-mini");
    const update = () => {
      const name = input?.value.trim() || "";
      root.setAttribute("aria-busy", String(submitting));
      for (const control of root.querySelectorAll("button, input")) control.disabled = submitting;
      if (submit) submit.disabled = submitting || !name;
      for (const card of root.querySelectorAll("[data-suggestion]")) {
        const suggestion = CREATE_SUGGESTIONS[Number(card.dataset.suggestion)];
        card.setAttribute("aria-pressed", String(Boolean(suggestion && name === suggestion.name && color === suggestion.color && shape === suggestion.shape && description === suggestion.description)));
      }
      for (const avatar of root.querySelectorAll(".ob-create-shape .ob-create-avatar")) avatar.style.setProperty("--ob-avatar", color);
      for (const avatar of [preview, headerAvatar]) {
        avatar?.style.setProperty("--ob-avatar", color);
        if (avatar) avatar.dataset.shape = shape;
      }
    };
    root.querySelector("[data-action='cancel']")?.addEventListener("click", () => {
      if (!submitting) closeCreateAgent();
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        closeCreateAgent();
      }
    });
    input?.addEventListener("input", update);
    for (const button of root.querySelectorAll("[data-color]")) {
      button.addEventListener("click", () => {
        color = button.dataset.color;
        root.querySelectorAll("[data-color]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        update();
      });
    }
    for (const button of root.querySelectorAll(".ob-create-shape[data-shape]")) {
      button.addEventListener("click", () => {
        shape = button.dataset.shape;
        root.querySelectorAll(".ob-create-shape[data-shape]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        update();
      });
    }
    for (const button of root.querySelectorAll("[data-suggestion]")) {
      button.addEventListener("click", () => {
        const item = CREATE_SUGGESTIONS[Number(button.dataset.suggestion)];
        if (!item || !input) return;
        input.value = item.name;
        color = item.color;
        shape = item.shape;
        description = item.description;
        root.querySelectorAll("[data-color]").forEach((choice) => choice.setAttribute("aria-pressed", String(choice.dataset.color === color)));
        root.querySelectorAll(".ob-create-shape[data-shape]").forEach((choice) => choice.setAttribute("aria-pressed", String(choice.dataset.shape === shape)));
        update();
        input.focus({ preventScroll: true });
      });
    }
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = input?.value.trim() || "";
      if (!name || submitting) return;
      submitting = true;
      update();
      if (submit) submit.textContent = "Criando…";
      if (status) status.textContent = "";
      try {
        const api = desktop()?.agent;
        if (typeof api?.createAgent !== "function") throw new Error("Criação de bot indisponível");
        const created = await api.createAgent({ name, description, origin: "user", avatarColor: color, avatarShape: shape });
        await selectCreatedAgent(created?.agent?.name || name, created?.agent?.id || null);
        if (root.isConnected) closeCreateAgent();
      } catch (error) {
        submitting = false;
        if (submit) submit.textContent = "Começar";
        if (status) status.textContent = userFacingError(error, "Não foi possível criar este bot. Tente novamente.");
        update();
      }
    });
    document.body.append(root);
    update();
    window.performance?.mark?.("openbot:create-agent-visible");
    setLocalTimeout(() => input?.focus({ preventScroll: true }), 0);
    return root;
  }

  function handleSidebarNewClick(event) {
    const control = event.target?.closest?.("button, [role='button'], a");
    if (!isSidebarNewControl(control)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openCreateAgent();
  }

  function restoreAppAfterWelcome() {
    const appRoot = document.getElementById("root");
    if (appRoot) appRoot.inert = false;
  }

  function normalizeProfileName(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  let profileState = {
    name: PROFILE_DEFAULT_NAME,
    avatarId: "openbot-default",
    avatarShape: "circle",
    avatarColor: PROFILE_DEFAULT_COLOR,
    avatarPngBase64: null,
  };

  function legacyProfileName() {
    try { return normalizeProfileName(localStorage.getItem(PROFILE_KEY)); }
    catch { return ""; }
  }

  function getProfileName() {
    return profileState.name;
  }

  function normalizeProfileState(profile) {
    return {
      name: normalizeProfileName(profile?.name) || PROFILE_DEFAULT_NAME,
      avatarId: typeof profile?.avatarId === "string" && profile.avatarId ? profile.avatarId : "openbot-default",
      avatarShape: ["circle", "rounded", "square"].includes(profile?.avatarShape) ? profile.avatarShape : "circle",
      avatarColor: /^#[0-9a-f]{6}$/i.test(profile?.avatarColor || "") ? profile.avatarColor : PROFILE_DEFAULT_COLOR,
      avatarPngBase64: typeof profile?.avatarPngBase64 === "string" && profile.avatarPngBase64 ? profile.avatarPngBase64 : null,
    };
  }

  let profileLoaded = false;
  let profileLoadPromise = null;
  let profileRetryAfter = 0;
  let profileRevision = 0;
  let profileWriteSequence = 0;
  let profileAppliedWrite = 0;

  async function persistLocalProfile(patch) {
    const api = profileAgent();
    if (typeof api?.updateLocalProfile !== "function") throw new Error("Perfil local indisponível");
    const sequence = ++profileWriteSequence;
    profileRevision += 1;
    const saved = normalizeProfileState(await api.updateLocalProfile(patch));
    const expected = normalizeProfileState({ ...profileState, ...patch });
    if (Object.keys(patch).some((key) => saved[key] !== expected[key])) throw new Error("O perfil salvo não foi confirmado");
    if (sequence > profileAppliedWrite) {
      profileAppliedWrite = sequence;
      profileRevision += 1;
      profileState = saved;
      profileLoaded = true;
      applyProfileName();
    }
    return saved;
  }

  function ensureLocalProfileLoaded() {
    if (profileLoaded || profileLoadPromise || Date.now() < profileRetryAfter) return;
    const api = profileAgent();
    if (typeof api?.getLocalProfile !== "function") return;
    const loadRevision = profileRevision;
    profileLoadPromise = Promise.resolve(api.getLocalProfile())
      .then((profile) => {
        if (profileRevision !== loadRevision) return;
        profileState = normalizeProfileState(profile);
        profileLoaded = true;
        applyProfileName(profileState.name);
      })
      .catch(() => {
        profileRetryAfter = Date.now() + 3000;
      })
      .finally(() => {
        profileLoadPromise = null;
      });
  }

  function profileInitials(name) {
    const parts = normalizeProfileName(name).split(" ").filter(Boolean);
    if (parts.length === 0) return "OL";
    return `${parts[0][0] || ""}${parts.length > 1 ? parts[parts.length - 1][0] || "" : ""}`.toLocaleUpperCase("pt-BR");
  }

  function renderAvatar(avatar, profile) {
    if (avatar.dataset.shape !== profile.avatarShape) avatar.dataset.shape = profile.avatarShape;
    if (avatar.style.getPropertyValue("--ob-profile-color") !== profile.avatarColor) avatar.style.setProperty("--ob-profile-color", profile.avatarColor);
    const source = profile.avatarPngBase64 ? `data:image/png;base64,${profile.avatarPngBase64}` : "";
    if (avatar._profileSource !== source) {
      avatar._profileSource = source;
      if (source) {
        const image = new Image();
        image.alt = "";
        image.src = source;
        void image.decode().then(() => {
          if (!avatar.isConnected || avatar._profileSource !== source) return;
          avatar.appendChild(image);
          const animation = animateOnce(image, "status");
          const settle = () => { if (avatar._profileSource === source) avatar.replaceChildren(image); };
          if (animation) void animation.finished.then(settle, settle);
          else settle();
        }).catch(() => { /* Preserve the previous preview if decoding fails. */ });
      } else avatar.textContent = profileInitials(profile.name);
    } else if (!source && avatar.textContent !== profileInitials(profile.name)) avatar.textContent = profileInitials(profile.name);
  }

  function renderProfileAvatar(root, profile) {
    const title = root.querySelector(".ob-profile-title");
    if (title && title.textContent !== profile.name) title.textContent = profile.name;
    const avatar = root.querySelector("#openbot-profile-avatar");
    if (avatar) renderAvatar(avatar, profile);
    const colors = root.querySelector(".ob-profile-colors");
    if (colors) colors.hidden = Boolean(profile.avatarPngBase64);
    for (const button of root.querySelectorAll("[data-avatar-shape]")) {
      button.setAttribute("aria-pressed", String(button.dataset.avatarShape === profile.avatarShape));
    }
    for (const button of root.querySelectorAll("[data-avatar-color]")) {
      button.setAttribute("aria-pressed", String(button.dataset.avatarColor === profile.avatarColor));
    }
    const remove = root.querySelector("#openbot-profile-avatar-remove");
    if (remove) remove.disabled = !profile.avatarPngBase64;
  }

  let profileSaveResetTimer = 0;

  function isLegacySignOutControl(el) {
    const label = `${el.getAttribute?.("aria-label") || ""} ${textOf(el)}`.replace(/\s+/g, " ").trim();
    return /^(Sign out|Log out|Sair)$/i.test(label) || /(?:^| )(Sign out|Log out|Sair)$/i.test(label);
  }

  function blockLegacyAuthClick(event) {
    const control = event.target?.closest?.("button, [role='button'], [role='menuitem'], a");
    if (!control || !isLegacySignOutControl(control)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    hideMatching(control);
  }

  let localAccountSettingsOpened = false;
  function handleLocalAccountClick(event) {
    const control = event.target?.closest?.('[aria-label^="Open account menu"]');
    if (control) localAccountSettingsOpened = true;
  }

  function sanitizePlaceholderCopy(element) {
    for (const attribute of ["data-placeholder", "aria-placeholder", "placeholder"]) {
      const value = element.getAttribute(attribute);
      if (value && LEGACY_CURSOR_COMPOSER.test(value)) {
        element.setAttribute(attribute, value.replace(LEGACY_CURSOR_COMPOSER, OPENBOT_EMPTY_COMPOSER));
      } else if (value === "What this agent is for") {
        element.setAttribute(attribute, "Descreva a função deste bot");
      } else if (value === "Describe what your agent does") {
        element.setAttribute(attribute, "Descreva o que este bot faz");
      } else if (value === "New Bot") {
        element.setAttribute(attribute, "Novo bot");
      } else if (value === "Bob") {
        element.setAttribute(attribute, "Nome do bot");
      }
    }
  }

  function sanitizeComposerCopy() {
    for (const element of document.querySelectorAll("[data-placeholder], [aria-placeholder], [placeholder]")) {
      sanitizePlaceholderCopy(element);
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const value = node.textContent || "";
      if (LEGACY_CURSOR_COMPOSER.test(value)) node.textContent = value.replace(LEGACY_CURSOR_COMPOSER, OPENBOT_EMPTY_COMPOSER);
      node = walker.nextNode();
    }
  }

  function polishNativeOnboarding() {
    const meet = document.querySelector(".sand-onboarding__meet");
    if (!(meet instanceof HTMLElement)) return;
    meet.setAttribute("lang", "pt-BR");
    const replacements = new Map([
      ["Meet OpenBot", "Conheça o OpenBot"],
      ["Welcome to OpenBot", "Comece com o OpenBot"],
      ["Hand off any task to your team of agents", "Dê uma tarefa ao seu time de bots"],
      ["Next", "Continuar"],
    ]);
    const title = [...meet.querySelectorAll("h1, h2, [role='heading']")]
      .find((element) => /^(?:Meet|Conheça|Welcome|Comece)/i.test(textOf(element)));
    if (title) title.dataset.openbotOnboardingTitle = "1";
    const continueButton = [...meet.querySelectorAll("button")]
      .find((button) => /^(?:Next|Continuar)$/i.test(textOf(button)));
    if (continueButton) continueButton.dataset.openbotOnboardingContinue = "1";
    const composerCopy = meet.querySelector(".sand-onboarding__composer p");
    if (composerCopy) {
      composerCopy.setAttribute("aria-label", "Dê uma tarefa ao seu time de bots");
      if (composerCopy.textContent?.trim() !== "Dê uma tarefa ao seu time de bots") {
        composerCopy.textContent = "Dê uma tarefa ao seu time de bots";
      }
    }
    const walker = document.createTreeWalker(meet, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const value = (node.textContent || "").trim();
      const replacement = replacements.get(value);
      if (replacement) node.textContent = (node.textContent || "").replace(value, replacement);
      node = walker.nextNode();
    }
  }

  function replaceExactText(root, replacements) {
    if (!(root instanceof Element)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (node.parentElement?.closest(`#${ROOT_ID}`)) continue;
      const value = (node.textContent || "").trim();
      const replacement = replacements.get(value);
      if (replacement) node.textContent = (node.textContent || "").replace(value, replacement);
    }
  }

  function firstVisibleLine(element) {
    return (element?.innerText || textOf(element)).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  }

  const COMMAND_TRANSLATIONS = new Map([
    ["All", "Tudo"],
    ["Messages", "Mensagens"],
    ["Agents", "Bots"],
    ["Groups", "Grupos"],
    ["Files", "Arquivos"],
    ["Routines", "Rotinas"],
    ["Actions", "Ações"],
    ["Agent", "Bot"],
    ["Chat Settings", "Configurações da conversa"],
    ["Current chat", "Conversa atual"],
    ["Settings: General", "Configurações: Geral"],
    ["Settings", "Configurações"],
    ["Action", "Ação"],
    ["Skill", "Habilidade"],
    ["Theme: System", "Tema: Sistema"],
    ["Theme: Light", "Tema: Claro"],
    ["Theme: Dark", "Tema: Escuro"],
    ["Settings · Appearance", "Configurações · Aparência"],
  ]);
  const TOOLTIP_TRANSLATIONS = new Map([
    // The only "New chat" tooltip is the sidebar "+", which opens bot creation.
    ["New chat", "Novo bot"],
  ]);

  function polishCommandPalette() {
    // The slash menu lists the same native actions as the palette.
    for (const menu of document.querySelectorAll(".sand-workflow-listbox")) {
      for (const option of menu.querySelectorAll("[role='option']")) {
        if (UNSUPPORTED_COMMAND_LABELS.test(firstVisibleLine(option))) hideMatching(option);
      }
      replaceExactText(menu, COMMAND_TRANSLATIONS);
      const listbox = menu.querySelector("[role='listbox']");
      if (listbox?.getAttribute("aria-label") === "Reference a skill") listbox.setAttribute("aria-label", "Comandos e habilidades");
    }
    for (const palette of document.querySelectorAll(".sand-command-palette")) {
      palette.setAttribute("aria-label", "Buscar");
      for (const option of palette.querySelectorAll("[role='option']")) {
        if (UNSUPPORTED_COMMAND_LABELS.test(firstVisibleLine(option))) hideMatching(option);
      }
      replaceExactText(palette, COMMAND_TRANSLATIONS);
      for (const input of palette.querySelectorAll("input")) {
        if (/^Search$/i.test(input.getAttribute("placeholder") || "")) input.setAttribute("placeholder", "Buscar");
        if (/^Search$/i.test(input.getAttribute("aria-label") || "")) input.setAttribute("aria-label", "Buscar");
      }
      const listbox = palette.querySelector("[role='listbox']");
      if (listbox?.getAttribute("aria-label") === "Results") listbox.setAttribute("aria-label", "Resultados");
      const tabs = palette.querySelector("[role='tablist']");
      if (tabs?.getAttribute("aria-label") === "Filter results") tabs.setAttribute("aria-label", "Filtrar resultados");
    }
  }

  // A hidden unsupported option can still be the keyboard-active one; Enter on
  // it would run an action the local build does not offer.
  function blockHiddenCommandActivation(event) {
    if (event.key !== "Enter" && event.key !== "Tab") return;
    const active = document.querySelector(".sand-workflow-listbox [role='option'][aria-selected='true'], .sand-command-palette [role='option'][aria-selected='true']");
    if (!active?.closest('[data-openbot-hide="1"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function polishTooltips(scope = document) {
    const tooltips = scope instanceof Element && scope.matches('[role="tooltip"]') ? [scope] : [...(scope.querySelectorAll?.('[role="tooltip"]') || [])];
    for (const tooltip of tooltips) replaceExactText(tooltip, TOOLTIP_TRANSLATIONS);
  }

  function polishAccountMenu() {
    for (const menu of document.querySelectorAll('[role="menu"][aria-label="Account"],[role="menu"][aria-label="Conta"]')) {
      for (const item of menu.querySelectorAll("[role='menuitem']")) {
        if (UNAVAILABLE_NAV_LABELS.test(unavailableNavigationLabel(item)) || isLegacySignOutControl(item)) hideMatching(item);
      }
      // A section whose items are all hidden would leave only its divider behind.
      for (const group of menu.querySelectorAll("[role='group']")) {
        const items = [...group.querySelectorAll("[role='menuitem']")];
        const empty = items.length > 0 && items.every((item) => item.closest('[data-openbot-hide="1"]'));
        if (empty && group.getAttribute("data-openbot-hide") !== "1") group.setAttribute("data-openbot-hide", "1");
        else if (!empty && group.getAttribute("data-openbot-hide") === "1") group.removeAttribute("data-openbot-hide");
      }
    }
  }

  function polishSettingsNavigation() {
    for (const nav of document.querySelectorAll(".sand-settings-nav")) {
      const controls = [...nav.querySelectorAll("button, [role='button'], a")];
      for (const control of controls) {
        if (UNAVAILABLE_NAV_LABELS.test(unavailableNavigationLabel(control))) hideMatching(control);
      }
      // A navigation with a single destination is only an empty column.
      const single = controls.filter((control) => !control.hidden && !control.closest('[data-openbot-hide="1"]')).length === 1;
      if (single && nav.dataset.openbotSingleNav !== "1") nav.dataset.openbotSingleNav = "1";
      else if (!single && nav.hasAttribute("data-openbot-single-nav")) nav.removeAttribute("data-openbot-single-nav");
    }
  }

  // Local tools run without a per-action prompt in this build: show the current
  // native policy read-only instead of an unlabeled row, and never re-enable it.
  function polishLocalExecutionSetting() {
    for (const control of document.querySelectorAll('button[aria-label="Execution on Local Computer"]')) {
      const cell = control.parentElement;
      const row = cell?.parentElement;
      if (!cell || !row || row === document.body) continue;
      if (control.getAttribute("data-openbot-hide") !== "1") control.setAttribute("data-openbot-hide", "1");
      const policy = cell.querySelector("input[aria-hidden='true']")?.value;
      let status = cell.querySelector(".ob-readonly-status");
      if (policy !== "always") {
        status?.remove();
        if (row.getAttribute("data-openbot-hide") !== "1") row.setAttribute("data-openbot-hide", "1");
        continue;
      }
      if (row.getAttribute("data-openbot-hide") === "1") row.removeAttribute("data-openbot-hide");
      if (!status) {
        status = document.createElement("span");
        status.className = "ob-readonly-status";
        status.textContent = "Sempre permitida";
        cell.appendChild(status);
      }
    }
  }

  function polishNativeLanguage() {
    if (document.documentElement.lang !== "pt-BR") document.documentElement.lang = "pt-BR";
    polishCommandPalette();
    polishTooltips();
    polishAccountMenu();
    polishSettingsNavigation();
    polishLocalExecutionSetting();
    const replacements = new Map([
      ["Settings", "Configurações"],
      ["About", "Sobre"],
      ["Help Center", "Central de ajuda"],
      ["Send Feedback", "Enviar feedback"],
      ["Log out", "Sair"],
      ["General", "Geral"],
      ["Account", "Conta"],
      ["Cursor", "OpenBot"],
      ["Signed in to Cursor", "Conectado ao OpenBot"],
      ["Sign Out", "Sair"],
      ["Appearance", "Aparência"],
      ["Theme", "Tema"],
      ["Follow System", "Seguir sistema"],
      ["Agent", "Bot"],
      ["Elon-Only Settings", "Configurações avançadas"],
      ["Model", "Modelo"],
      ["Timezone", "Fuso horário"],
      ["Execution on Local Computer", "Execução no computador local"],
      ["Let the assistant open files and run tasks on your computer. Auto-review still checks everything first.", "O bot pode abrir arquivos e executar tarefas neste computador."],
      ["Ask every time", "Perguntar sempre"],
      ["Auto-review", "Revisão automática"],
      ["OpenBot checks each action before it runs and asks you first when needed. Add rules to customize what it can do automatically.", "O OpenBot verifica cada ação antes de executar e pede sua confirmação quando necessário."],
      ["Auto-review Rules", "Regras de revisão automática"],
      ["Write one short, natural-language rule for each action. \"Ask first\" takes priority if rules conflict.", "Escreva uma regra curta para cada ação. \"Perguntar primeiro\" tem prioridade em caso de conflito."],
      ["When OpenBot wants to:", "Quando o OpenBot quiser:"],
      ["It should:", "A ação deve:"],
      ["Allow automatically", "Permitir automaticamente"],
      ["Add Rule", "Adicionar regra"],
      ["These rules apply only to you. Built-in safety checks always apply.", "Estas regras valem apenas para você. As verificações de segurança continuam ativas."],
      ["Security Key", "Chave de segurança"],
      ["Use hardware security keys", "Usar chaves de segurança físicas"],
      ["Allow OpenBot to use a security key (such as a YubiKey) connected to your computer. You’ll be asked to approve each use.", "Permita que o OpenBot use uma chave de segurança conectada ao computador. Cada uso exigirá sua aprovação."],
      ["Generate", "Gerar"],
      ["Upload", "Enviar arquivo"],
      ["Copy version info", "Copiar informações da versão"],
    ]);
    const surfaces = document.querySelectorAll(".sand-about-dialog,[role='dialog'][aria-label='OpenBot settings'],[role='dialog'][aria-label='Configurações do OpenBot'],[role='menu'][aria-label='Account'],[role='menu'][aria-label='Conta']");
    for (const surface of surfaces) replaceExactText(surface, replacements);
    for (const dialog of document.querySelectorAll("[role='dialog']")) {
      const copy = textOf(dialog);
      if (/\bBot\b/.test(copy) && /\b(?:Generate|Gerar)\b/.test(copy) && /\b(?:Upload|Enviar arquivo)\b/.test(copy)) replaceExactText(dialog, replacements);
    }
    for (const about of document.querySelectorAll(".sand-about-dialog")) {
      replaceExactText(about, new Map([
        ["Version 0.16.0", "Versão 0.1.1 · build source"],
        ["Copyright © 2026 SpaceXAI", "Copyright © 2026 OpenBot"],
      ]));
    }
    for (const control of document.querySelectorAll("[aria-label]")) {
      const label = control.getAttribute("aria-label");
      if (label === "OpenBot settings") control.setAttribute("aria-label", "Configurações do OpenBot");
      else if (label === "Account") control.setAttribute("aria-label", "Conta");
      else if (label === "Open account menu") control.setAttribute("aria-label", "Abrir menu da conta");
      else if (label === "Close") control.setAttribute("aria-label", "Fechar");
      else if (label === "Timezone") control.setAttribute("aria-label", "Fuso horário");
      else if (label === "New") control.setAttribute("aria-label", "Novo");
    }
    for (const separator of document.querySelectorAll(".sand-transcript-time-separator")) {
      const value = separator.textContent || "";
      if (value.startsWith("Yesterday ")) separator.textContent = value.replace(/^Yesterday /, "Ontem ");
      else if (value.startsWith("Today ")) separator.textContent = value.replace(/^Today /, "Hoje ");
    }
    for (const button of document.querySelectorAll("button[aria-label='Fuso horário'],button[aria-label='Timezone']")) {
      const value = textOf(button);
      if (!value.startsWith("Auto-detect (")) continue;
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if ((node.textContent || "").startsWith("Auto-detect (")) {
          node.textContent = node.textContent.replace(/^Auto-detect /, "Detectar automaticamente ");
          break;
        }
        node = walker.nextNode();
      }
    }
    for (const avatar of document.querySelectorAll(".sand-account-card__avatar:not([data-empty])")) {
      if (avatar.querySelector("img")) continue;
      const text = (avatar.textContent || "").trim();
      if (text.length !== 1) continue;
      const initial = (getProfileName()[0] || "O").toUpperCase();
      if (text !== initial) avatar.textContent = initial;
    }
  }

  function polishAgentSettingsCopy(host) {
    if (!(host instanceof Element)) return;
    const surface = host.closest(".sand-info-pane__nav-root") || host;
    replaceExactText(surface, new Map([
      ["Settings", "Configurações"],
      ["Name", "Nome"],
      ["Title", "Título"],
      ["Description", "Descrição"],
      ["Notifications", "Notificações"],
      ["Get notified when this agent finishes or needs input", "Avise quando este bot concluir ou precisar de você"],
    ]));
    const ariaLabels = new Map([
      ["Back to details", "Voltar aos detalhes"],
      ["Close details", "Fechar detalhes"],
      ["Agent name", "Nome do bot"],
      ["Agent title", "Título do bot"],
      ["Agent description", "Descrição do bot"],
      ["Notifications", "Notificações"],
    ]);
    for (const element of surface.querySelectorAll("[aria-label]")) {
      const replacement = ariaLabels.get((element.getAttribute("aria-label") || "").trim());
      if (replacement) element.setAttribute("aria-label", replacement);
    }
  }

  function polishSidebarCopy() {
    const sidebar = document.querySelector(".sand-agents-sidebar");
    if (!sidebar) return;
    for (const list of sidebar.querySelectorAll(".sand-agents-sections")) {
      let hasCustomSection = false;
      for (const section of list.querySelectorAll(".sand-agents-section")) {
        if (section.dataset.sectionId === "__agents__") continue;
        const header = section.querySelector(".sand-agents-section__header");
        const emptyDefault = /^(New section|Nova seção)$/.test(textOf(header?.firstElementChild))
          && Boolean(section.querySelector(".sand-agents-section__empty"));
        if (emptyDefault) {
          if (section.dataset.openbotEmptySection !== "1") section.dataset.openbotEmptySection = "1";
        } else {
          if (section.hasAttribute("data-openbot-empty-section")) section.removeAttribute("data-openbot-empty-section");
          hasCustomSection = true;
        }
      }
      if (hasCustomSection) {
        if (list.hasAttribute("data-openbot-flat")) list.removeAttribute("data-openbot-flat");
      } else {
        const header = list.querySelector('.sand-agents-section[data-section-id="__agents__"] .sand-agents-section__header');
        if (header?.getAttribute("aria-expanded") === "false") header.click();
        if (list.dataset.openbotFlat !== "1") list.dataset.openbotFlat = "1";
      }
    }
    replaceExactText(sidebar, new Map([
      ["Search", "Buscar"],
    ]));
    for (const badge of sidebar.querySelectorAll(".sand-agent-item__title-badge")) {
      const item = badge.closest(".sand-agent-item");
      const name = textOf(item?.querySelector(".sand-agent-item__name"));
      const badgeText = textOf(badge);
      if (name && badgeText === name) {
        if (!badge.hidden) badge.hidden = true;
        if (badge.getAttribute("data-openbot-hide") !== "1") badge.setAttribute("data-openbot-hide", "1");
        badge.dataset.openbotRedundantBadge = "1";
      } else {
        if (badge.dataset.openbotRedundantBadge === "1") {
          badge.hidden = false;
          badge.removeAttribute("data-openbot-hide");
          delete badge.dataset.openbotRedundantBadge;
        }
        if (badgeText === "New Bot") badge.textContent = "Novo";
      }
    }
    const search = sidebar.querySelector("input[placeholder]");
    if (search?.getAttribute("placeholder")?.trim() === "Search") search.setAttribute("placeholder", "Buscar");
    for (const control of document.querySelectorAll(".sand-new-chat-row, [role='option']")) {
      if (!/^(?:Create new(?: Bot)?|New Bot|Novo)$/i.test(textOf(control))) continue;
      replaceExactText(control, new Map([
        ["Create new", "Novo bot"],
        ["Create new Bot", "Novo bot"],
        ["New Bot", "Novo bot"],
        ["Novo", "Novo bot"],
      ]));
    }
  }

  function polishNativeDeleteConfirmation() {
    for (const dialog of document.querySelectorAll(".sand-alert-dialog, [role='dialog']")) {
      const title = [...dialog.querySelectorAll("h2, h3")].find((element) => /^Delete [“\"]/.test(textOf(element)));
      if (!title) continue;
      dialog.setAttribute("role", "alertdialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", textOf(title));
    }
  }

  function polishNativeBotActions() {
    const replacements = new Map([
      ["Pin", "Fixar"],
      ["Unpin", "Desafixar"],
      ["Move to", "Mover para"],
      ["Move to new section", "Mover para nova seção"],
      ["Unassigned", "Sem seção"],
      ["Mark as Unread", "Marcar como não lido"],
      ["Mark as Read", "Marcar como lido"],
      ["Edit Profile", "Editar perfil"],
      ["Duplicate", "Duplicar"],
      ["Copy conversation ID", "Copiar ID da conversa"],
      ["Hide from sidebar", "Ocultar da barra lateral"],
      ["Delete", "Excluir"],
      ["Cancel", "Cancelar"],
      ["Deleting...", "Encerrando e excluindo..."],
      ["Deleting failed. Check your connection and try again.", "Não foi possível concluir a exclusão. Aguarde o encerramento das tarefas e tente novamente. Se persistir, reinicie o OpenBot para recuperar o estado pendente."],
      ["This permanently deletes the agent and its chat history. This can't be undone.", "Isso exclui permanentemente o bot e o histórico da conversa. Esta ação não pode ser desfeita."],
    ]);
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      if (!/Hide from sidebar|Copy conversation ID|Ocultar da barra lateral|Copiar ID da conversa/.test(textOf(menu))) continue;
      for (const item of menu.querySelectorAll("[role='menuitem'],button")) {
        if (UNSAFE_SECTION_ACTION.test(firstVisibleLine(item))) hideMatching(item);
      }
      replaceExactText(menu, replacements);
      if (menu.getAttribute("aria-label") === "Agent actions") menu.setAttribute("aria-label", "Ações do bot");
    }
    for (const item of document.querySelectorAll('[role="menuitem"]')) {
      if (item.querySelector('[data-icon-name="folder-plus"]')) hideMatching(item);
    }
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      if (menu.querySelector('[data-icon-name="folder-plus"]')) replaceExactText(menu, new Map([["Unassigned", "Sem seção"]]));
    }
    for (const dialog of document.querySelectorAll('.sand-alert-dialog, [role="alertdialog"]')) {
      const title = [...dialog.querySelectorAll("h2, h3")].find((element) => /^(?:Delete|Excluir) [“\"]/.test(textOf(element)));
      if (!title) continue;
      const currentTitle = textOf(title);
      if (currentTitle.startsWith("Delete ")) title.textContent = currentTitle.replace(/^Delete /, "Excluir ");
      replaceExactText(dialog, replacements);
      dialog.setAttribute("aria-label", textOf(title));
    }
  }

  function polishLocalFeatureCopy() {
    const p23 = document.querySelector(".obp23-dialog");
    if (p23) {
      p23.removeAttribute("role");
      p23.removeAttribute("aria-modal");
      const panel = p23.querySelector(".obp23-panel");
      const title = panel?.querySelector("h2");
      if (title && !title.id) title.id = "openbot-local-tools-title";
      if (panel && title && panel.getAttribute("aria-labelledby") !== title.id) panel.setAttribute("aria-labelledby", title.id);
      const close = panel?.querySelector(".obp23-close");
      if (close) {
        if (textOf(close) !== "×") close.textContent = "×";
        close.setAttribute("aria-label", "Fechar");
        close.setAttribute("title", "Fechar");
      }
      const hint = p23.querySelector(".obp23-body > .obp23-hint");
      const friendlyHint = "Os anexos ficam disponíveis apenas nesta conversa e são descartados ao fechar.";
      if (hint && textOf(hint) !== friendlyHint) hint.textContent = friendlyHint;
      const drop = p23.querySelector("#obp23-drop-zone");
      if (drop) {
        const dropCopy = "Arraste e solte um arquivo aqui ou clique para escolher";
        if (textOf(drop) !== dropCopy) drop.textContent = dropCopy;
        if (drop.getAttribute("aria-label") !== "Adicionar arquivo") drop.setAttribute("aria-label", "Adicionar arquivo");
      }
      const search = p23.querySelector("#obp23-query");
      if (search?.getAttribute("placeholder") !== "Buscar na conversa") search?.setAttribute("placeholder", "Buscar na conversa");
      if (search?.getAttribute("aria-label") !== "Buscar na conversa") search?.setAttribute("aria-label", "Buscar na conversa");
      const reply = p23.querySelector("#obp23-reply");
      if (reply?.getAttribute("placeholder") !== "Escreva sua resposta") reply?.setAttribute("placeholder", "Escreva sua resposta");
      if (reply?.getAttribute("aria-label") !== "Resposta") reply?.setAttribute("aria-label", "Resposta");
      const target = p23.querySelector("#obp23-target");
      if (target && /^nenhum$/i.test(textOf(target))) target.textContent = "Nenhuma mensagem selecionada";
      const actionLabels = new Map([
        ["p23-stage", "Adicionar texto"],
        ["p23-sendatt", "Enviar anexos"],
      ]);
      for (const [action, label] of actionLabels) {
        const button = p23.querySelector(`[data-act="${action}"]`);
        if (button && textOf(button) !== label) button.textContent = label;
      }
    }
    for (const close of document.querySelectorAll(".ob-dialog .ob-close")) {
      if (textOf(close) !== "×") close.textContent = "×";
      close.setAttribute("aria-label", "Fechar");
      close.setAttribute("title", "Fechar");
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const value = (node.textContent || "").trim();
      if (/^Anexos e Busca \(P2\.3\)$/i.test(value)) {
        node.textContent = (node.textContent || "").replace(/Anexos e Busca \(P2\.3\)/i, "Anexos e busca");
      } else if (/^Buscar no transcript \(FTS scoped, snippets limitados\)$/i.test(value)) {
        node.textContent = "Buscar na conversa";
      } else if (/^Responder \(replyToId resolvido server-side\)$/i.test(value)) {
        node.textContent = "Responder a uma mensagem";
      } else if (/^Alvo:$/i.test(value)) {
        node.textContent = "Mensagem selecionada:";
      } else if (/^Bot ativo indisponível\.?$/i.test(value)) {
        node.textContent = "Selecione um bot para usar anexos e busca.";
      } else if (/^Em staging:/i.test(value)) {
        node.textContent = "Anexo pronto para enviar.";
      }
      node = walker.nextNode();
    }
  }

  function trapLocalModalFocus(event) {
    if (event.key !== "Tab" || document.getElementById("openbot-queue-recovery")?.open) return;
    const panel = document.querySelector(".obp23-dialog .obp23-panel");
    if (!(panel instanceof HTMLElement)) return;
    const focusable = [...panel.querySelectorAll("button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[href],[tabindex]:not([tabindex='-1'])")]
      .filter((element) => element instanceof HTMLElement && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
    if (focusable.length === 0) {
      event.preventDefault();
      panel.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  function sanitizeLegacyAuth() {
    for (const control of document.querySelectorAll("button, [role='button'], [role='menuitem'], a")) {
      if (control.closest(`#${PROFILE_ID}`)) continue;
      if (isLegacySignOutControl(control)) hideMatching(control);
    }
    for (const dialog of document.querySelectorAll("[role='dialog'], [aria-modal='true']")) {
      const copy = textOf(dialog);
      if (!/use your Cursor account|conta do Cursor/i.test(copy) && !/^Sign out\?/i.test(copy)) continue;
      const cancel = [...dialog.querySelectorAll("button, [role='button']")].find((button) => /^(Cancel|Cancelar)$/i.test(textOf(button)));
      cancel?.click();
      dialog.setAttribute("data-openbot-hide", "1");
    }
  }

  function findLegacyAccountCard() {
    const localCard = document.querySelector("#sand-settings-panel-general .sand-account-card");
    if (localCard) return localCard;
    const identities = [...document.querySelectorAll("div, span, p")].filter((el) => {
      if (el.closest(`#${PROFILE_ID}`)) return false;
      const text = textOf(el);
      return text === PROFILE_DEFAULT_NAME || text === getProfileName() || text === "local@openbot.invalid";
    });
    identities.sort((left, right) => Number(textOf(right) === "local@openbot.invalid") - Number(textOf(left) === "local@openbot.invalid"));
    for (const identity of identities) {
      for (let node = identity.parentElement; node && node !== document.body; node = node.parentElement) {
        const controls = [...node.querySelectorAll("button, [role='button'], [role='menuitem']")];
        if (controls.some(isLegacySignOutControl)) return node;
      }
    }
    return null;
  }

  function applyProfileName(name = getProfileName()) {
    for (const nativeAvatar of document.querySelectorAll(".sand-agents-sidebar__account .sand-kit-base-avatar")) {
      let avatar = nativeAvatar.querySelector(".ob-account-avatar");
      if (!avatar) {
        avatar = document.createElement("span");
        avatar.className = "ob-account-avatar";
        avatar.setAttribute("aria-hidden", "true");
        nativeAvatar.appendChild(avatar);
      }
      renderAvatar(avatar, profileState);
    }
    const profileRoot = document.getElementById(PROFILE_ID);
    const profileInput = profileRoot?.querySelector("#openbot-profile-name");
    const profileSave = profileRoot?.querySelector("#openbot-profile-save");
    if (profileInput && profileInput.value !== name && document.activeElement !== profileInput && profileSave?.disabled !== false && profileRoot.dataset.profileDirty !== "1") {
      profileInput.value = name;
      renderProfileAvatar(profileRoot, profileState);
    }
    for (const control of document.querySelectorAll(".sand-agents-sidebar__account-name")) {
      if (control.closest(`#${FOOTER_PROFILE_EDITOR_ID}`) || control instanceof HTMLInputElement) continue;
      const label = [...control.querySelectorAll("span")]
        .find((entry) => textOf(entry) && !entry.querySelector("svg, [data-icon-name]"));
      if (label && textOf(label) !== name) label.textContent = name;
      else if (!label && !control.querySelector("svg, [data-icon-name]") && textOf(control) !== name) control.textContent = name;
      if (control.dataset.openbotProfileName !== name) control.dataset.openbotProfileName = name;
      const ariaLabel = `Editar nome: ${name}`;
      if (control.matches("button, [role='button']") && control.getAttribute("aria-label") !== ariaLabel) control.setAttribute("aria-label", ariaLabel);
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      if (parent && !parent.closest(`#${PROFILE_ID}, #${WELCOME_ID}, [data-openbot-hide='1']`)) {
        const value = (node.textContent || "").trim();
        if (/^(OpenBot Local|Enter your name)$/i.test(value) && value !== name) node.textContent = (node.textContent || "").replace(value, name);
        else if (value === "local@openbot.invalid" && parent.getAttribute("data-openbot-hide") !== "1") parent.setAttribute("data-openbot-hide", "1");
      }
      node = walker.nextNode();
    }
  }

  function renderLocalProfile() {
    const legacyCard = findLegacyAccountCard();
    let root = document.getElementById(PROFILE_ID);
    if (!legacyCard) {
      if (root) applyProfileName();
      return;
    }
    legacyCard.setAttribute("data-openbot-hide", "1");
    const mount = legacyCard.parentElement;
    if (!mount) return;
    const accountHeading = exactParent("Account");
    if (accountHeading && mount.contains(accountHeading)) accountHeading.textContent = "Perfil local";
    if (!root || !root.isConnected) {
      root = document.createElement("section");
      root.id = PROFILE_ID;
      root.setAttribute("lang", "pt-BR");
      root.innerHTML = `
        <div class="ob-profile-header">
          <div id="openbot-profile-avatar" class="ob-profile-avatar" aria-hidden="true"></div>
          <div>
            <div class="ob-profile-title">Seu perfil neste computador</div>
            <p class="ob-profile-help">Perfil local</p>
          </div>
        </div>
        <details class="ob-profile-editor" open><summary>Editar perfil</summary>
        <form id="openbot-profile-form">
          <fieldset>
          <label for="openbot-profile-name">Seu nome</label>
          <div class="ob-profile-row">
            <input id="openbot-profile-name" name="openbot-profile-name" type="text" maxlength="80" autocomplete="name" spellcheck="false" />
            <button id="openbot-profile-save" type="submit" aria-label="Salvar perfil" disabled>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true"><path d="m5 10 3 3 7-7" stroke-linecap="round" stroke-linejoin="round" /></svg>
              <span class="ob-profile-save-label">Salvar</span>
            </button>
          </div>
          <div class="ob-profile-appearance">
            <div class="ob-profile-appearance-title">Aparência</div>
            <label>Formato do avatar</label>
            <div class="ob-profile-options" role="group" aria-label="Formato do avatar">
              <button type="button" data-avatar-shape="circle" aria-pressed="true">Círculo</button>
              <button type="button" data-avatar-shape="rounded" aria-pressed="false">Arredondado</button>
              <button type="button" data-avatar-shape="square" aria-pressed="false">Quadrado</button>
            </div>
            <div class="ob-profile-colors"><label>Cor do avatar</label>
            <div class="ob-profile-options" role="group" aria-label="Cor do avatar">
              <button type="button" class="ob-profile-color" data-avatar-color="#52525b" style="--swatch:#52525b" aria-label="Cinza" aria-pressed="true"></button>
              <button type="button" class="ob-profile-color" data-avatar-color="#2563eb" style="--swatch:#2563eb" aria-label="Azul" aria-pressed="false"></button>
              <button type="button" class="ob-profile-color" data-avatar-color="#7c3aed" style="--swatch:#7c3aed" aria-label="Violeta" aria-pressed="false"></button>
              <button type="button" class="ob-profile-color" data-avatar-color="#059669" style="--swatch:#059669" aria-label="Verde" aria-pressed="false"></button>
              <button type="button" class="ob-profile-color" data-avatar-color="#dc2626" style="--swatch:#dc2626" aria-label="Vermelho" aria-pressed="false"></button>
            </div>
            </div><input id="openbot-profile-avatar-file" type="file" accept="image/png,image/jpeg,image/webp" hidden />
            <div class="ob-profile-upload-row">
              <button id="openbot-profile-avatar-choose" type="button">Escolher foto</button>
              <button id="openbot-profile-avatar-remove" type="button">Remover imagem</button>
            </div>
          </div>
          </fieldset><div id="openbot-profile-status" role="status" aria-live="polite" class="ob-profile-status"></div>
        </form></details>`;
      if (legacyCard.matches(".sand-account-card")) {
        root.dataset.nativeAccount = "1";
        root.querySelector("details").open = false;
      }
      mount.insertBefore(root, legacyCard);
      const form = root.querySelector("#openbot-profile-form");
      const input = root.querySelector("#openbot-profile-name");
      const saveButton = root.querySelector("#openbot-profile-save");
      const saveLabel = root.querySelector(".ob-profile-save-label");
      const status = root.querySelector("#openbot-profile-status");
      const fileInput = root.querySelector("#openbot-profile-avatar-file");
      const chooseAvatar = root.querySelector("#openbot-profile-avatar-choose");
      const removeAvatar = root.querySelector("#openbot-profile-avatar-remove");
      let draft = { ...profileState };
      let savedProfile = { ...profileState };
      const editedFields = new Set();
      let photoRevision = 0;
      let photoPending = false;
      let saving = false;
      const fields = form.querySelector("fieldset");
      const hasChanges = () => Object.keys(savedProfile).some((key) => draft[key] !== savedProfile[key]);
      const syncSaveButton = () => {
        root.dataset.profileDirty = hasChanges() ? "1" : "0";
        saveButton.disabled = saving || photoPending || !hasChanges();
      };
      let draftRevision = 0;
      const markDirty = (field) => {
        if (field) editedFields.add(field);
        draftRevision += 1;
        clearLocalTimeout(profileSaveResetTimer);
        saveButton?.classList.remove("is-saved");
        if (saveLabel) saveLabel.textContent = "Salvar";
        if (status) {
          status.className = "ob-profile-status";
          status.textContent = photoPending ? "Preparando foto…" : "";
        }
        syncSaveButton();
        renderProfileAvatar(root, draft);
      };
      input?.addEventListener("input", () => {
        draft.name = normalizeProfileName(input.value) || input.value;
        markDirty("name");
      });
      for (const button of root.querySelectorAll("[data-avatar-shape]")) {
        button.addEventListener("click", () => {
          draft.avatarShape = button.dataset.avatarShape;
          markDirty("avatarShape");
        });
      }
      for (const button of root.querySelectorAll("[data-avatar-color]")) {
        button.addEventListener("click", () => {
          draft.avatarColor = button.dataset.avatarColor;
          markDirty("avatarColor");
        });
      }
      chooseAvatar?.addEventListener("click", () => fileInput?.click());
      removeAvatar?.addEventListener("click", () => {
        photoRevision += 1;
        photoPending = false;
        draft.avatarPngBase64 = null;
        if (fileInput) fileInput.value = "";
        markDirty("avatarPngBase64");
      });
      fileInput?.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        const selectionRevision = ++photoRevision;
        draftRevision += 1;
        photoPending = true;
        status.className = "ob-profile-status";
        status.textContent = "Preparando foto…";
        syncSaveButton();
        try {
          if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error("Escolha uma foto PNG, JPEG ou WebP de até 10 MiB.");
          const bitmap = await createImageBitmap(file).catch(() => { throw new Error("Não foi possível abrir essa foto. Escolha outra imagem."); });
          let dataUrl;
          try {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 256;
            const size = Math.min(bitmap.width, bitmap.height);
            canvas.getContext("2d").drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 256, 256);
            dataUrl = canvas.toDataURL("image/png");
          } finally { bitmap.close(); }
          if (!root.isConnected || photoRevision !== selectionRevision) return;
          const base64 = dataUrl.split(",")[1];
          if (!base64 || base64.length > Math.ceil(PROFILE_MAX_AVATAR_BYTES * 4 / 3)) throw new Error("A foto excedeu o tamanho permitido.");
          draft.avatarPngBase64 = base64;
          photoPending = false;
          markDirty("avatarPngBase64");
        } catch (error) {
          if (!root.isConnected || photoRevision !== selectionRevision) return;
          status.className = "ob-profile-status err";
          status.textContent = userFacingError(error, "Não foi possível abrir essa foto. Escolha outra imagem.");
          queueChangedStatus(status);
        } finally {
          if (photoRevision === selectionRevision) {
            photoPending = false;
            syncSaveButton();
            fileInput.value = "";
          }
        }
      });
      form?.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (saving || photoPending || !hasChanges()) return;
        const nextName = normalizeProfileName(input?.value);
        if (!nextName) {
          status.className = "ob-profile-status err";
          status.textContent = "Digite um nome antes de salvar.";
          queueChangedStatus(status);
          input?.focus();
          return;
        }
        const submitRevision = ++draftRevision;
        saving = true;
        fields.disabled = true;
        saveButton.disabled = true;
        status.className = "ob-profile-status";
        status.textContent = "Salvando…";
        saveLabel.textContent = "Salvando…";
        try {
          draft.name = nextName;
          const patch = Object.fromEntries(Object.entries(draft).filter(([key, value]) => editedFields.has(key) && value !== savedProfile[key]));
          await persistLocalProfile(patch);
          if (!root.isConnected || draftRevision !== submitRevision) return;
          draft = { ...profileState };
          savedProfile = { ...profileState };
          editedFields.clear();
          input.value = profileState.name;
          renderProfileAvatar(root, profileState);
          try { localStorage.removeItem(PROFILE_KEY); } catch {}
          status.className = "ob-profile-status ok";
          status.textContent = "Perfil salvo neste computador.";
          queueChangedStatus(status);
          saveButton.classList.add("is-saved");
          saveLabel.textContent = "Salvo";
          clearLocalTimeout(profileSaveResetTimer);
          profileSaveResetTimer = setLocalTimeout(() => {
            if (!saveButton.isConnected) return;
            saveButton.classList.remove("is-saved");
            saveLabel.textContent = "Salvar";
          }, 1800);
          applyProfileName(profileState.name);
        } catch (error) {
          if (!root.isConnected || draftRevision !== submitRevision) return;
          status.className = "ob-profile-status err";
          status.textContent = userFacingError(error, "Não foi possível salvar este perfil. Tente novamente.");
          queueChangedStatus(status);
          saveButton.disabled = false;
          saveLabel.textContent = "Salvar";
        } finally {
          saving = false;
          fields.disabled = false;
          syncSaveButton();
        }
      });
      void (async () => {
        let loadProfileRevision = profileRevision;
        try {
          const api = profileAgent();
          if (typeof api?.getLocalProfile !== "function") throw new Error("Perfil local indisponível");
          let loaded = normalizeProfileState(await api.getLocalProfile());
          if (!root.isConnected || profileRevision !== loadProfileRevision) return;
          const legacyName = legacyProfileName();
          if (legacyName && legacyName !== PROFILE_DEFAULT_NAME && loaded.name === PROFILE_DEFAULT_NAME && !editedFields.has("name") && typeof api.updateLocalProfile === "function") {
            const migration = persistLocalProfile({ name: legacyName });
            loadProfileRevision = profileRevision;
            loaded = await migration;
            if (!root.isConnected || profileState !== loaded) return;
          } else {
            profileState = loaded;
            profileLoaded = true;
          }
          savedProfile = { ...loaded };
          for (const key of Object.keys(loaded)) if (!editedFields.has(key)) draft[key] = loaded[key];
          if (!editedFields.has("name")) input.value = draft.name;
          syncSaveButton();
          renderProfileAvatar(root, draft);
          applyProfileName(loaded.name);
          try { localStorage.removeItem(PROFILE_KEY); } catch {}
        } catch (error) {
          if (!root.isConnected || profileRevision !== loadProfileRevision) return;
          status.className = "ob-profile-status err";
          status.textContent = userFacingError(error, "Não foi possível carregar este perfil. Tente novamente.");
          queueChangedStatus(status);
        }
      })();
    } else if (root.parentElement !== mount) {
      mount.insertBefore(root, legacyCard);
    }
    const name = getProfileName();
    const input = root.querySelector("#openbot-profile-name");
    const saveButton = root.querySelector("#openbot-profile-save");
    if (input && document.activeElement !== input && saveButton?.disabled !== false && root.dataset.profileDirty !== "1") input.value = name;
    const avatar = root.querySelector("#openbot-profile-avatar");
    if (avatar && avatar.childNodes.length === 0) renderProfileAvatar(root, profileState);
    applyProfileName(name);
  }

  function clearForcedConversationDetailsState(details) {
    if (!(details instanceof HTMLElement)) return;
    delete details.dataset.openbotResponsiveSettings;
    let current = details;
    for (let depth = 0; depth < 4 && current instanceof HTMLElement; depth += 1) {
      if (current.dataset.openbotForcedVisible === "1") {
        for (const property of ["display", "visibility", "width", "max-width", "max-height", "overflow", "flex"]) {
          current.style.removeProperty(property);
        }
        delete current.dataset.openbotForcedVisible;
      }
      current = current.parentElement;
    }
  }

  function closeConversationDetails(details, fallbackControl = null) {
    if (!(details instanceof HTMLElement)) return false;
    const close = [...details.querySelectorAll("button, [role='button']")]
      .find((element) => /^(?:Close details|Fechar detalhes)$/i.test(element.getAttribute("aria-label") || ""));
    const trigger = fallbackControl || [...document.querySelectorAll('[aria-label="View agent settings"]')]
      .find((element) => element.getAttribute("aria-expanded") === "true" && element.getAttribute("aria-controls") === details.id);
    const control = close || trigger;
    clearForcedConversationDetailsState(details);
    details.setAttribute("data-openbot-hide", "1");
    if (!(control instanceof HTMLElement)) return false;
    control.click();
    return true;
  }

  function hideLegacyScreenPane(el) {
    const details = el.closest("#sand-conversation-details");
    const localSettings = document.getElementById(ROOT_ID);
    const isPrepaintHiddenScreen = el.matches?.(".sand-computer-stage__placeholder") || el.querySelector?.(".sand-computer-stage__placeholder");
    if (details instanceof HTMLElement && (isVisibleElement(el) || isPrepaintHiddenScreen) && !(localSettings && details.contains(localSettings) && isVisibleElement(localSettings))) {
      details.dataset.openbotLegacyScreen = "1";
      closeConversationDetails(details);
      return;
    }
    const pane = el.closest("aside, [class*='computer'], [class*='monitor'], [class*='screen']")
      || el.closest("section")
      || el.parentElement;
    if (!pane || pane === document.body) return;
    pane.setAttribute("data-openbot-hide", "1");
    const close = pane.querySelector("[aria-label='Close'], [aria-label='close'], [aria-label='Fechar']");
    if (close instanceof HTMLElement) close.click();
  }

  function isComputerChrome(aria, label) {
    return /computer$/i.test(aria) || /computer$/i.test(label)
      || /^Open computer$/i.test(aria) || /^Open computer$/i.test(label);
  }

  function isScreenHeading(text) {
    return LEGACY_SCREEN_LABELS.test(text)
      || /can't reach .+ screen/i.test(text)
      || /['’]s screen$/i.test(text)
      || /['’]s computer$/i.test(text);
  }

  function visibleLegacyScreenIn(root) {
    if (!(root instanceof Element)) return null;
    const placeholder = root.querySelector(".sand-computer-stage__placeholder");
    if (placeholder && isScreenHeading(textOf(placeholder).slice(0, 160))) return placeholder;
    return [...root.querySelectorAll("div, span, p, h1, h2, h3, [role='heading']")]
      .find((element) => isVisibleElement(element) && isScreenHeading(textOf(element).slice(0, 160))) || null;
  }

  function unavailableNavigationLabel(el) {
    return `${el.getAttribute?.("aria-label") || ""} ${textOf(el)}`.replace(/\s+/g, " ").trim();
  }

  function activateGeneralSettings() {
    const general = [...document.querySelectorAll("button, [role='button'], [role='menuitem'], a")]
      .find((el) => /^General$/i.test(unavailableNavigationLabel(el)));
    if (general instanceof HTMLElement) general.click();
  }

  function blockUnavailableNavigation(event) {
    const control = event.target?.closest?.("button, [role='button'], [role='menuitem'], a");
    if (!control) return;
    const primary = firstVisibleLine(control);
    const legacyLabel = unavailableNavigationLabel(control);
    const unavailable = UNAVAILABLE_NAV_LABELS.test(legacyLabel) || UNSUPPORTED_COMMAND_LABELS.test(primary) || UNSAFE_SECTION_ACTION.test(primary) || Boolean(control.querySelector('[data-icon-name="folder-plus"]'));
    if (!unavailable) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (/^(?:Updates|Settings: Updates)$/i.test(primary) || /^Updates$/i.test(legacyLabel)) activateGeneralSettings();
    hideMatching(control);
  }

  function removeUnavailableNavigation() {
    const controls = [...document.querySelectorAll("button, [role='button'], [role='menuitem'], a")];
    for (const control of controls) {
      const label = unavailableNavigationLabel(control);
      const primary = firstVisibleLine(control);
      if (UNAVAILABLE_NAV_LABELS.test(label) || UNSUPPORTED_COMMAND_LABELS.test(primary) || UNSAFE_SECTION_ACTION.test(primary)) hideMatching(control);
    }
    const updateTrack = [...document.querySelectorAll("div, span, p, h1, h2, h3")]
      .find((el) => {
        const text = textOf(el);
        return text === "Update Track" && ![...el.children].some((child) => textOf(child) === "Update Track");
      });
    if (!updateTrack) return;
    activateGeneralSettings();
    let pane = updateTrack.parentElement;
    while (pane && pane !== document.body && !/Check for Updates/i.test(textOf(pane))) pane = pane.parentElement;
    if (pane && pane !== document.body) pane.setAttribute("data-openbot-hide", "1");
  }

  function hideUnavailableAutoReview() {
    const surfaces = document.querySelectorAll('[role="dialog"][aria-label="OpenBot settings"], [role="dialog"][aria-label="Configurações do OpenBot"]');
    for (const surface of surfaces) {
      for (const label of surface.querySelectorAll("label, span, div, h3")) {
        if (label.children.length || !/^(Auto-review|Revisão automática|Auto-review Rules|Regras de revisão automática)$/.test(textOf(label))) continue;
        if (/^(Auto-review Rules|Regras de revisão automática)$/.test(textOf(label))) {
          const rules = label.parentElement?.parentElement;
          if (rules && rules !== surface && !rules.contains(surface) && rules.querySelector("textarea, input, button")) rules.setAttribute("data-openbot-hide", "1");
          continue;
        }
        for (let row = label.parentElement; row && row !== surface && !row.matches("section"); row = row.parentElement) {
          if (row.querySelector('[role="switch"], input[type="checkbox"]')) {
            row.setAttribute("data-openbot-hide", "1");
            break;
          }
        }
      }
    }
  }

  function hideChrome() {
    hideUnavailableAutoReview();
    for (const el of document.querySelectorAll("button, [role='button'], [role='menuitem'], [role='option'], a")) {
      if (el.closest(`#${ROOT_ID}`) || el.id === STOP_ID) continue;
      const aria = (el.getAttribute("aria-label") || "").trim();
      const label = textOf(el);
      if (isComputerChrome(aria, label)) hideMatching(el);
      else if (/^Plugins$/i.test(aria) || /^Plugins$/i.test(label) || UNSUPPORTED_COMMAND_LABELS.test(firstVisibleLine(el))) hideMatching(el);
      else if (/^(Sign out|Log out|Sair)$/i.test(label)) hideMatching(el);
      else if (!el.matches(".sand-prompt-send") && (/start voice input|microphone|microfone/i.test(aria) || /start voice input/i.test(label))) hideMatching(el);
      else if (el.matches(".sand-new-chat-row, [role='option']") && NATIVE_CREATE_LABEL.test(label)) {
        hideMatching(el);
      }
    }
    for (const el of document.querySelectorAll("aside, [class*='computer'], [class*='monitor'], [class*='screen'], h1, h2, h3, [role='heading']")) {
      const heading = textOf(el.querySelector?.("h1, h2, h3, [role='heading']") || el).slice(0, 80);
      if (isScreenHeading(heading) || isScreenHeading(textOf(el).slice(0, 80))) hideLegacyScreenPane(el);
    }
  }

  function smallestCommon(first, second) {
    const seen = new Set();
    for (let node = first; node; node = node.parentElement) seen.add(node);
    for (let node = second; node; node = node.parentElement) {
      if (seen.has(node)) return node;
    }
    return null;
  }

  // Native menus and modal dialogs mark the rest of the app aria-hidden while they
  // are open. That is transient: the settings pane is still there underneath.
  function modalLayerOpen() {
    if (document.body.classList.contains("ob-dialog-open")) return true;
    return [...document.querySelectorAll(MODAL_LAYER_SELECTOR)].some((layer) => layer.getClientRects().length > 0);
  }

  function isVisibleElement(el) {
    if (!el?.isConnected || el.closest('[hidden], [aria-hidden="true"], [data-openbot-hide="1"]')) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
  }

  const animatedElements = new WeakSet();
  const activeAnimations = new Set();
  const elementAnimations = new WeakMap();
  const avatarPauseStates = new WeakMap();
  const pendingMotion = new Map();
  let motionFrame = 0;
  let localUiClosed = false;
  let localUiReadyMarked = false;
  let firstInteractionMarked = false;

  function motionReduced() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  }

  function reconcileAgentAvatars() {
    const pauseForWindow = document.visibilityState !== "visible" || !document.hasFocus();
    for (const svg of document.querySelectorAll("svg[data-state]")) {
      const paused = pauseForWindow || svg.dataset.state === "sleeping";
      if (avatarPauseStates.get(svg) === paused) continue;
      avatarPauseStates.set(svg, paused);
      svg.dataset.openbotAvatarPaused = paused ? "1" : "0";
      for (const element of [svg, ...svg.querySelectorAll("*")]) {
        element.style.animationPlayState = paused ? "paused" : "";
      }
      try {
        if (paused) svg.pauseAnimations?.();
        else svg.unpauseAnimations?.();
      } catch {}
    }
  }

  function openFooterProfileEditor(control) {
    if (!(control instanceof HTMLElement) || document.getElementById(FOOTER_PROFILE_EDITOR_ID)) return;
    const form = document.createElement("form");
    form.id = FOOTER_PROFILE_EDITOR_ID;
    form.setAttribute("aria-label", "Editar nome local");
    const input = document.createElement("input");
    input.className = "sand-agents-sidebar__account-name-input";
    input.type = "text";
    input.maxLength = 80;
    input.autocomplete = "name";
    input.spellcheck = false;
    input.placeholder = "Seu nome";
    input.value = profileState.name === PROFILE_DEFAULT_NAME ? "" : profileState.name;
    form.appendChild(input);
    control.replaceWith(form);

    let saving = false;
    const restore = () => {
      if (form.isConnected) form.replaceWith(control);
      applyProfileName(profileState.name);
    };
    const commit = async () => {
      if (saving) return;
      const name = normalizeProfileName(input.value);
      if (!name) {
        input.setAttribute("aria-invalid", "true");
        input.title = "Digite um nome antes de salvar.";
        input.focus();
        return;
      }
      saving = true;
      input.disabled = true;
      try {
        const saved = await persistLocalProfile({ name });
        if (saved.name !== name) throw new Error("O nome salvo não foi confirmado");
        restore();
      } catch (error) {
        saving = false;
        input.disabled = false;
        input.setAttribute("aria-invalid", "true");
        input.title = userFacingError(error, "Não foi possível salvar este perfil. Tente novamente.");
        input.focus();
      }
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void commit();
    });
    form.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("input", () => {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("title");
    });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key !== "Escape") return;
      event.preventDefault();
      restore();
    });
    input.addEventListener("blur", () => {
      setLocalTimeout(() => {
        if (form.isConnected && !saving) void commit();
      }, 0);
    });
    input.focus({ preventScroll: true });
    input.select();
  }

  function handleFooterProfileClick(event) {
    const control = event.target?.closest?.("button.sand-agents-sidebar__account-name, [role='button'].sand-agents-sidebar__account-name");
    if (!(control instanceof HTMLElement) || !control.closest(".sand-agents-sidebar__account")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openFooterProfileEditor(control);
  }

  function handleVisibilityChange() {
    reconcileAgentAvatars();
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    // Retorno/reconexão: reconsulta o estado autoritativo (leitura pura). Nenhuma
    // mensagem é reenviada e nenhuma operação é executada por esta consulta.
    promptStatusRevision += 1;
    promptRecoverySignature = "";
    schedulePromptStatus(0);
    schedulePromptRecovery(0);
  }

  function markFirstInteraction() {
    if (firstInteractionMarked) return;
    firstInteractionMarked = true;
    window.performance?.mark?.("openbot:first-interaction");
    window.removeEventListener("pointerdown", markFirstInteraction, true);
    window.removeEventListener("keydown", markFirstInteraction, true);
  }

  function animateOnce(element, kind = "surface") {
    if (!(element instanceof Element) || animatedElements.has(element)) return null;
    animatedElements.add(element);
    const config = MOTION[kind] || MOTION.surface;
    element.dataset.openbotMotion = kind;
    element.dataset.openbotMotionDuration = String(config.duration);
    element.dataset.openbotMotionRuns = String(Number(element.dataset.openbotMotionRuns || 0) + 1);
    if (motionReduced() || document.visibilityState !== "visible" || !document.hasFocus() || !isVisibleElement(element) || typeof element.animate !== "function") return null;
    const baseTransform = kind === "message" ? element.style.transform.trim() : "";
    const keyframes = kind === "panel" || kind === "settings"
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
        { opacity: 0, transform: baseTransform ? `${baseTransform} ${config.from}` : config.from },
        { opacity: 1, transform: baseTransform || "translate3d(0,0,0) scale(1)" },
      ];
    const animation = element.animate(keyframes, {
      duration: config.duration,
      easing: config.easing || MOTION_EASING,
      fill: "none",
    });
    activeAnimations.add(animation);
    elementAnimations.set(element, animation);
    let guardTimer = 0;
    const release = () => {
      clearLocalTimeout(guardTimer);
      activeAnimations.delete(animation);
      if (elementAnimations.get(element) === animation) elementAnimations.delete(element);
    };
    animation.addEventListener("finish", release, { once: true });
    animation.addEventListener("cancel", release, { once: true });
    guardTimer = setLocalTimeout(() => {
      if (animation.playState === "running" || animation.playState === "pending") animation.cancel();
    }, config.duration + 20);
    return animation;
  }

  function queueMotionTarget(element, kind) {
    if (localUiClosed || !(element instanceof Element) || !element.isConnected) return;
    if (kind === "settings") {
      pendingMotion.delete(element);
      animateOnce(element, kind);
      return;
    }
    const previous = pendingMotion.get(element);
    if (!previous || (previous === "message" && kind !== "message")) pendingMotion.set(element, kind);
    if (!motionFrame) motionFrame = window.requestAnimationFrame(flushMotionQueue);
  }

  function queueChangedStatus(element) {
    if (!(element instanceof Element) || !textOf(element)) return;
    animatedElements.delete(element);
    queueMotionTarget(element, "status");
  }

  function messageMotionRoots(elements) {
    const pending = new Set(elements);
    return elements.filter((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (pending.has(parent)) return false;
      }
      return true;
    });
  }

  function stampMessageMotion(element) {
    if (!(element instanceof Element) || animatedElements.has(element)) return;
    animatedElements.add(element);
    const config = MOTION.message;
    element.dataset.openbotMotion = "message";
    element.dataset.openbotMotionDuration = String(config.duration);
    element.dataset.openbotMotionRuns = String(Number(element.dataset.openbotMotionRuns || 0) + 1);
  }

  // Records that an element had its entrance handled without starting another
  // animation (the surface around it is already animating it into view).
  function stampMotion(element, kind) {
    if (!(element instanceof Element) || animatedElements.has(element)) return;
    animatedElements.add(element);
    const config = MOTION[kind] || MOTION.surface;
    element.dataset.openbotMotion = kind;
    element.dataset.openbotMotionDuration = String(config.duration);
    element.dataset.openbotMotionRuns = String(Number(element.dataset.openbotMotionRuns || 0) + 1);
  }

  function ancestorMotionActive(element) {
    for (let node = element?.parentElement; node; node = node.parentElement) {
      if (pendingMotion.has(node) || elementAnimations.has(node)) return true;
    }
    return false;
  }

  function flushMotionQueue() {
    motionFrame = 0;
    const entries = [...pendingMotion.entries()];
    pendingMotion.clear();
    const connected = entries.filter(([element]) => element.isConnected);
    for (const [element, kind] of connected) {
      if (kind !== "message") animateOnce(element, kind);
    }
    const messages = connected.filter(([, kind]) => kind === "message").map(([element]) => element);
    if (messages.length === 0) return;
    const roots = messageMotionRoots(messages);
    if (roots.length !== 1) {
      const target = roots.at(-1);
      if (target) animateOnce(target, "message");
      for (const element of messages) {
        if (element !== target) animatedElements.add(element);
      }
      return;
    }
    animateOnce(roots[0], "message");
    for (const element of messages) {
      if (element !== roots[0]) stampMessageMotion(element);
    }
  }

  const SURFACE_SELECTOR = [
    ".sand-workflow-listbox",
    ".sand-mention-listbox",
    ".sand-pr-listbox",
    ".sand-emoji-listbox",
    ".sand-new-chat-menu",
    ".sand-reference-menu",
    ".sand-mention-menu",
    ".sand-pr-menu",
    ".sand-emoji-menu",
    '[role="menu"]',
    '[role="listbox"]',
  ].join(",");
  const PANEL_SELECTOR = [
    ".sand-dialog",
    ".sand-agent-settings",
    ".sand-conversation-details",
    ".sand-outline-panel",
    ".sand-virtual-transcript",
    '[role="dialog"]',
  ].join(",");
  const MESSAGE_SELECTOR = [
    // Transcript rows use the native data-enter marker and CSS animation.
    // DOM insertion alone also happens during history hydration/virtualization.
    ".sand-local-tool-permission-dock",
    ".sand-local-tool-permission-outcome",
    ".sand-chat-transcript-loading",
    ".sand-chat-transcript-error",
  ].join(",");

  function queueSemanticMotion(element) {
    if (!(element instanceof Element) || element.closest(`#${WELCOME_ID}`)) return;
    if (element.closest(".ob-dialog, #openbot-tasks-dialog, .obp23-dialog")) return;
    if (element.id === ROOT_ID) {
      queueMotionTarget(element, "settings");
      return;
    }
    if (element.id === EMPTY_ID || element.id === PROFILE_ID) {
      queueMotionTarget(element, "surface");
      return;
    }
    if (element.id === STOP_ID || element.classList.contains("ob-retry-generation")) return;
    if (element.id === "openbot-status" || element.id === "openbot-profile-status") {
      queueMotionTarget(element, "status");
      return;
    }
    const message = element.matches(MESSAGE_SELECTOR) ? element : element.closest(MESSAGE_SELECTOR);
    if (message?.closest("main.sand-chat")) {
      queueMotionTarget(message, "message");
      return;
    }
    const menuSurfaceSelector = ".sand-workflow-listbox,.sand-reference-menu,.sand-mention-menu,.sand-pr-menu,.sand-emoji-menu,.sand-new-chat-menu";
    const menuSurface = element.matches(menuSurfaceSelector) ? element : element.closest(menuSurfaceSelector);
    if (menuSurface) {
      queueMotionTarget(menuSurface, "surface");
      return;
    }
    if (element.matches(PANEL_SELECTOR) && element.id !== WELCOME_ID) {
      queueMotionTarget(element, "panel");
      return;
    }
    if (element.matches(SURFACE_SELECTOR)) queueMotionTarget(element, "surface");
    else if (element.matches("main.sand-chat")) queueMotionTarget(element, "surface");
  }

  function collectMotionTargets(node) {
    const element = node instanceof Element ? node : node?.parentElement;
    if (!(element instanceof Element) || document.getElementById(WELCOME_ID)) return;
    queueSemanticMotion(element);
    for (const candidate of element.querySelectorAll(`${PANEL_SELECTOR},${SURFACE_SELECTOR},main.sand-chat,${MESSAGE_SELECTOR},#${ROOT_ID},#${EMPTY_ID},#${PROFILE_ID},.ob-retry-generation`)) {
      queueSemanticMotion(candidate);
    }
  }

  function exactParent(value) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let last = null;
    let node = walker.nextNode();
    while (node) {
      if ((node.textContent || "").trim() === value && isVisibleElement(node.parentElement)) last = node.parentElement;
      node = walker.nextNode();
    }
    return last;
  }

  function exactWithin(root, value) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if ((node.textContent || "").trim() === value && node.parentElement) return node.parentElement;
      node = walker.nextNode();
    }
    return null;
  }

  function findGlobalSettingsMount() {
    const panel = document.getElementById("sand-settings-panel-general");
    if (!(panel instanceof HTMLElement) || !isVisibleElement(panel)) return null;
    return panel.closest('[role="dialog"], [aria-modal="true"]') ? panel : null;
  }

  function prepareGlobalSettingsMount(host) {
    const legacyAccounts = new Set([...host.querySelectorAll('[role="status"]')]
      .filter((element) => /Cursor|conta do Cursor/i.test(textOf(element))));
    for (const control of host.querySelectorAll("button, [role='button'], a")) {
      if (!/^Sign (?:In with|Out of) Cursor$/i.test(textOf(control))) continue;
      legacyAccounts.add(control.closest('[role="status"]') || control);
    }
    const legacyAccount = legacyAccounts.values().next().value || null;
    const accountHeading = exactWithin(host, "Account");
    if (accountHeading) accountHeading.textContent = "Provedores e modelos";
    const generalHeading = exactWithin(host, "General");
    if (generalHeading) generalHeading.textContent = "Geral";
    const appearanceHeading = exactWithin(host, "Appearance");
    if (appearanceHeading) appearanceHeading.textContent = "Aparência";
    const legacyHeading = exactWithin(host, "Elon-Only Settings") || exactWithin(host, "Configurações avançadas");
    const legacySection = legacyHeading?.closest("section");
    const legacyTarget = legacySection && legacySection !== host && host.contains(legacySection) ? legacySection : legacyHeading;
    legacyTarget?.setAttribute("data-openbot-hide", "1");
    const modelLabel = exactWithin(host, "Model") || exactWithin(host, "Modelo");
    if (modelLabel && !modelLabel.closest(`#${ROOT_ID}`)) {
      let row = modelLabel.parentElement;
      for (let depth = 0; depth < 3 && row && row !== host; depth += 1) {
        if (row.querySelector("button, select")) break;
        row = row.parentElement;
      }
      row?.setAttribute("data-openbot-hide", "1");
    }
    for (const element of legacyAccounts) element.setAttribute("data-openbot-hide", "1");
    const botSection = exactWithin(host, "Bot")?.closest("section") || null;
    return { legacyAccount, content: botSection?.parentElement || null, before: botSection };
  }

  function findSettingsLabels() {
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = (node.textContent || "").trim();
      if (SETTINGS_LABELS.test(text) && isVisibleElement(node.parentElement)) found.push(node.parentElement);
      node = walker.nextNode();
    }
    return found.filter(Boolean);
  }

  function findAgentSettingsMount() {
    const nameLabel = exactParent("Name") || exactParent("Nome");
    const descLabel = exactParent("Description") || exactParent("Descrição") || exactParent("Descricao");
    const notifyLabel = exactParent("Notifications") || exactParent("Notificações") || exactParent("Notificacoes");
    if (nameLabel && descLabel && notifyLabel) {
      const mount = smallestCommon(descLabel, notifyLabel);
      if (mount && mount.contains(nameLabel) && mount !== document.body && mount !== document.documentElement && mount.id !== "root") {
        return mount;
      }
    }
    const labels = findSettingsLabels();
    if (labels.length < 2) return null;
    let mount = labels[0];
    for (const label of labels.slice(1)) mount = smallestCommon(mount, label);
    if (!mount || mount === document.body || mount === document.documentElement || mount.id === "root") return null;
    if (mount.querySelector("input, textarea, select")) return mount;
    return null;
  }

  function findExpandedConversationDetailsMount() {
    const button = [...document.querySelectorAll('[aria-label="View agent settings"]')]
      .find((element) => isVisibleElement(element) && element.getAttribute("aria-expanded") === "true");
    const panelId = button?.getAttribute("aria-controls");
    const panel = panelId ? document.getElementById(panelId) : null;
    if (!(panel instanceof HTMLElement) || panel === document.body || panel === document.documentElement) return null;
    const text = textOf(panel);
    if (!/(^|\\s)(Settings|Name|Nome|Title|Description|Notifications)(\\s|$)/i.test(text)) return null;
    return panel;
  }

  function closeEmptyConversationDetails() {
    const button = [...document.querySelectorAll('[aria-label="View agent settings"]')]
      .find((element) => isVisibleElement(element) && element.getAttribute("aria-expanded") === "true");
    const panelId = button?.getAttribute("aria-controls");
    const panel = panelId ? document.getElementById(panelId) : null;
    const details = panel?.matches("#sand-conversation-details") ? panel : panel?.closest("#sand-conversation-details");
    if (!(panel instanceof HTMLElement) || !(details instanceof HTMLElement)) return false;
    const localSettings = document.getElementById(ROOT_ID);
    if (localSettings && panel.contains(localSettings) && isVisibleElement(localSettings)) return false;
    const panelCopy = textOf(panel);
    const hasLegacyScreen = /Can't reach .+ screen|.+['’]s screen/i.test(panelCopy);
    const hasVisibleControl = [...panel.querySelectorAll("input,textarea,select,iframe,webview,canvas,img,video,[role='status'],[role='alert']")]
      .some((element) => isVisibleElement(element));
    if (!hasLegacyScreen && ((panel.innerText || "").trim() || hasVisibleControl)) return false;
    return closeConversationDetails(details, button);
  }

  function ensureConversationDetailsVisible() {
    const button = [...document.querySelectorAll('[aria-label="View agent settings"]')]
      .find((element) => isVisibleElement(element));
    const panelId = button?.getAttribute("aria-controls");
    const panel = panelId ? document.getElementById(panelId) : null;
    if (!(panel instanceof HTMLElement)) return;
    const localSettings = document.getElementById(ROOT_ID);
    const responsiveOpen = window.innerWidth <= 900 && localSettings?.dataset.scope === "agent" && panel.contains(localSettings);
    const details = panel.matches("#sand-conversation-details") ? panel : panel.closest("#sand-conversation-details");
    const legacyScreen = visibleLegacyScreenIn(details);
    if (legacyScreen) {
      hideLegacyScreenPane(legacyScreen);
      return;
    }
    if (details instanceof HTMLElement && details.dataset.openbotLegacyScreen === "1") {
      if (button?.getAttribute("aria-expanded") === "true") {
        closeConversationDetails(details, button);
        return;
      }
      delete details.dataset.openbotLegacyScreen;
    }
    if (responsiveOpen && details instanceof HTMLElement) {
      details.dataset.openbotResponsiveSettings = "1";
      if (details.getAttribute("aria-hidden") === "true") details.setAttribute("aria-hidden", "false");
      if (details.inert) details.inert = false;
      const inner = details.querySelector(".sand-info-pane__inner");
      if (inner instanceof HTMLElement) {
        if (inner.getAttribute("aria-hidden") === "true") inner.setAttribute("aria-hidden", "false");
        if (inner.inert) inner.inert = false;
      }
    } else if (details instanceof HTMLElement) {
      delete details.dataset.openbotResponsiveSettings;
    }
    const expanded = button?.getAttribute("aria-expanded") === "true" || responsiveOpen;
    if (!expanded) {
      let current = panel;
      for (let depth = 0; depth < 4 && current instanceof HTMLElement; depth += 1) {
        if (current.dataset.openbotForcedVisible === "1") {
          current.style.removeProperty("display");
          current.style.removeProperty("visibility");
          current.style.removeProperty("width");
          current.style.removeProperty("max-width");
          current.style.removeProperty("max-height");
          current.style.removeProperty("overflow");
          current.style.removeProperty("flex");
          delete current.dataset.openbotForcedVisible;
        }
        current = current.parentElement;
      }
      return;
    }
    panel.removeAttribute("data-openbot-hide");
    const style = getComputedStyle(panel);
    const rect = panel.getBoundingClientRect();
    if (style.display !== "none" && rect.width > 0 && rect.height > 0) return;
    let current = panel;
    for (let depth = 0; depth < 4 && current instanceof HTMLElement; depth += 1) {
      const currentStyle = getComputedStyle(current);
      const currentRect = current.getBoundingClientRect();
      if (currentStyle.display === "none" || currentRect.width === 0 || currentRect.height === 0) {
        current.dataset.openbotForcedVisible = "1";
        current.style.setProperty("display", "block", "important");
        current.style.setProperty("visibility", "visible", "important");
        if (depth === 0) {
          current.style.setProperty("width", "min(360px, calc(100vw - 32px))", "important");
          current.style.setProperty("max-width", "min(360px, calc(100vw - 32px))", "important");
          current.style.setProperty("max-height", "calc(100vh - 68px)", "important");
          current.style.setProperty("overflow", "auto", "important");
          current.style.setProperty("flex", "0 0 auto", "important");
          current.removeAttribute("aria-hidden");
        } else if (currentRect.width === 0) {
          current.style.setProperty("width", "100%", "important");
        }
      }
      current = current.parentElement;
    }
    if (!document.getElementById(ROOT_ID) && /(^|\\s)(Settings|Name|Nome|Title|Description|Notifications)(\\s|$)/i.test(textOf(panel))) {
      renderSettings(panel);
    }
  }

  function option(value, label, selected) {
    const el = document.createElement("option");
    el.value = value;
    el.textContent = label;
    if (selected) el.selected = true;
    return el;
  }

  const styledSelects = new WeakMap();
  let openStyledSelect = null;

  function refreshStyledSelect(select) {
    styledSelects.get(select)?.render();
  }

  // One custom select for every OpenBot settings context. The native <select>
  // stays the source of truth: value, disabled state and "change" events keep
  // flowing through it, so gates and handlers can keep dispatching on it.
  function enhanceStyledSelect(select) {
    if (!(select instanceof HTMLSelectElement) || styledSelects.has(select)) return;
    const shell = document.createElement("div");
    const trigger = document.createElement("button");
    const value = document.createElement("span");
    const menu = document.createElement("div");
    const triggerId = `${select.id}-trigger`;
    const menuId = `${select.id}-menu`;
    shell.className = "ob-select";
    trigger.type = "button";
    trigger.id = triggerId;
    trigger.className = "ob-select-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", menuId);
    value.className = "ob-select-value";
    menu.id = menuId;
    menu.className = "ob-select-menu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    trigger.appendChild(value);
    shell.append(trigger, menu);
    select.classList.add("ob-native-select");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    select.insertAdjacentElement("afterend", shell);
    const label = select.closest(".ob-field-row")?.querySelector(`label[for="${select.id}"]`);
    if (label) {
      label.setAttribute("for", triggerId);
      if (!label.id) label.id = `${select.id}-label`;
      trigger.setAttribute("aria-labelledby", `${label.id} ${triggerId}`);
      menu.setAttribute("aria-labelledby", label.id);
    }

    const close = (restoreFocus = false) => {
      if (menu.hidden) return;
      menu.hidden = true;
      shell.classList.remove("is-open-up");
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", onOutside, true);
      if (openStyledSelect?.select === select) openStyledSelect = null;
      if (restoreFocus) trigger.focus({ preventScroll: true });
    };
    const onOutside = (event) => {
      if (!shell.isConnected || !shell.contains(event.target)) close();
    };
    const commit = (nextValue) => {
      if (select.value !== nextValue) {
        select.value = nextValue;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      render();
      close(true);
    };
    const render = () => {
      const options = [...select.options];
      const selected = options.find((entry) => entry.selected) || options[0];
      const text = selected?.textContent || (options.length ? "" : "Sem opções");
      if (value.textContent !== text) value.textContent = text;
      trigger.title = selected?.title || text;
      trigger.disabled = select.disabled || options.length === 0;
      menu.replaceChildren(...options.map((entry) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "ob-select-option";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(entry.value === select.value));
        item.disabled = entry.disabled;
        item.title = entry.title;
        item.dataset.value = entry.value;
        item.textContent = entry.textContent || entry.value;
        item.addEventListener("click", () => commit(entry.value));
        return item;
      }));
    };
    const boundsOf = () => {
      // Open towards the side with room inside the surface that clips it:
      // the settings dialog, the scrolling bot pane or the window.
      let bottom = window.innerHeight;
      let top = 0;
      for (let node = shell.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.matches('[role="dialog"], [aria-modal="true"]') || /(auto|scroll|hidden)/.test(style.overflowY)) {
          const rect = node.getBoundingClientRect();
          bottom = Math.min(bottom, rect.bottom);
          top = Math.max(top, rect.top);
          break;
        }
      }
      return { top, bottom };
    };
    const open = (focusOffset = 0) => {
      if (trigger.disabled || !menu.children.length) return;
      if (openStyledSelect && openStyledSelect.select !== select) openStyledSelect.close();
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      shell.classList.remove("is-open-up");
      const triggerRect = trigger.getBoundingClientRect();
      const bounds = boundsOf();
      const needed = menu.scrollHeight + 8;
      if (needed > bounds.bottom - triggerRect.bottom && triggerRect.top - bounds.top > bounds.bottom - triggerRect.bottom) shell.classList.add("is-open-up");
      openStyledSelect = { select, close };
      document.addEventListener("pointerdown", onOutside, true);
      const options = [...menu.querySelectorAll(".ob-select-option:not(:disabled)")];
      const selectedIndex = Math.max(0, options.findIndex((entry) => entry.getAttribute("aria-selected") === "true"));
      const target = options[Math.min(options.length - 1, Math.max(0, selectedIndex + focusOffset))];
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: "nearest" });
    };
    trigger.addEventListener("click", () => menu.hidden ? open() : close());
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !menu.hidden) {
        event.preventDefault();
        event.stopPropagation();
        return close(true);
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) return;
      event.preventDefault();
      const offset = event.key === "ArrowUp" ? -1 : event.key === "End" ? select.options.length : event.key === "Home" ? -select.options.length : 0;
      open(offset);
    });
    menu.addEventListener("keydown", (event) => {
      const options = [...menu.querySelectorAll(".ob-select-option:not(:disabled)")];
      const index = options.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : Math.min(options.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
        options[next]?.focus({ preventScroll: true });
        options[next]?.scrollIntoView?.({ block: "nearest" });
      } else if (event.key === "Tab") close();
    });
    select.addEventListener("change", render);
    styledSelects.set(select, { render, close });
    render();
  }

  let availableModelsCache = { expiresAt: 0, value: null };
  async function getAvailableModelsCached(api, force = false) {
    if (!force && availableModelsCache.value && Date.now() < availableModelsCache.expiresAt) return availableModelsCache.value;
    const value = await api.agent.getAvailableModels().catch(() => ({ models: [] }));
    availableModelsCache = { expiresAt: Date.now() + 30_000, value };
    return value;
  }

  async function loadState(agentId, allowGlobal = false) {
    const api = desktop();
    if (!api?.agent) throw new Error("desktop.agent indisponível");
    const config = await api.agent.getProviderConfig(agentId);
    if (!config?.agentId && !allowGlobal) throw new Error("Não foi possível identificar o bot ativo.");
    const [modelsRaw, xaiOAuth, openaiOAuth, secrets] = await Promise.all([
      getAvailableModelsCached(api),
      api.agent.getProviderOAuthStatus?.("xai").catch(() => ({ provider: "xai", state: "error", message: "Não foi possível verificar a conexão." })),
      api.agent.getProviderOAuthStatus?.("openai").catch(() => ({ provider: "openai", state: "error", message: "Não foi possível verificar a conexão." })),
      api.agent.getProviderSecretsStatus?.(),
    ]);
    const provider = config.provider;
    const secretNames = Array.isArray(secrets?.keys) ? secrets.keys : Array.isArray(secrets?.secrets) ? secrets.secrets : [];
    return {
      models: Array.isArray(modelsRaw?.models) ? modelsRaw.models : [],
      modelId: config.provider === provider ? config.model : undefined,
      reasoningEffort: config.reasoningEffort || "medium",
      serviceTier: config.serviceTier || "default",
      lastServiceTier: config.lastServiceTier,
      provider,
      oauth: { xai: xaiOAuth, openai: openaiOAuth },
      openCodeConfigured: secretNames.includes("opencode-go"),
      agentId: config.agentId,
    };
  }

  function openNativeFirstBotOnboarding() {
    document.getElementById(EMPTY_ID)?.remove();
    if (document.querySelector(".sand-onboarding__meet")) return true;
    const trigger = [...document.querySelectorAll("button, [role='button'], a")].find((element) => {
      const aria = (element.getAttribute("aria-label") || "").trim();
      const title = (element.getAttribute("title") || "").trim();
      return /^(new|new chat)$/i.test(aria) || /^new chat$/i.test(title);
    });
    if (!trigger) return false;
    trigger.click();
    return true;
  }

  let emptyAgentCheckInFlight = false;
  let emptyAgentLastCheck = 0;
  let emptyAgentRetryTimer = 0;
  let emptyAgentRetryAttempts = 0;

  function scheduleEmptyAgentStateRetry() {
    if (emptyAgentRetryTimer || emptyAgentRetryAttempts >= 5) return;
    const delay = Math.min(1600, 100 * (2 ** emptyAgentRetryAttempts));
    emptyAgentRetryAttempts += 1;
    emptyAgentRetryTimer = setLocalTimeout(() => {
      emptyAgentRetryTimer = 0;
      emptyAgentLastCheck = 0;
      void checkEmptyAgentState();
    }, delay);
  }

  async function checkEmptyAgentState() {
    if (emptyAgentCheckInFlight) return;
    if (Date.now() - emptyAgentLastCheck < 2000) return;
    const api = desktop()?.agent;
    if (typeof api?.getProviderConfig !== "function") {
      scheduleEmptyAgentStateRetry();
      return;
    }
    emptyAgentLastCheck = Date.now();
    emptyAgentCheckInFlight = true;
    try {
      const config = await api.getProviderConfig();
      emptyAgentRetryAttempts = 0;
      try { sessionStorage.setItem(WELCOME_SESSION_KEY, "1"); } catch {}
      const legacyWelcome = document.getElementById(WELCOME_ID);
      if (legacyWelcome) {
        legacyWelcome.remove();
        restoreAppAfterWelcome();
      }
      if (config?.agentId) {
        document.getElementById(EMPTY_ID)?.remove();
        return;
      }
      const showNativeOnboarding = () => {
        if (localAccountSettingsOpened) return;
        openNativeFirstBotOnboarding();
        polishNativeOnboarding();
      };
      showNativeOnboarding();
      for (const delay of [80, 220, 500, 1000]) {
        setLocalTimeout(showNativeOnboarding, delay);
      }
    } catch {
      document.getElementById(EMPTY_ID)?.remove();
      scheduleEmptyAgentStateRetry();
    } finally {
      emptyAgentCheckInFlight = false;
    }
  }

  const RUNTIME_STATE_LABELS = {
    "lite-ready": "Modo leve (sem isolamento)",
    "runtime-unavailable": "Indisponível",
    "runtime-installing": "Instalando…",
    stopped: "Parado",
    starting: "Iniciando…",
    ready: "Em execução",
    busy: "Em execução",
    "waiting-approval": "Aguardando aprovação",
    stopping: "Parando…",
    unhealthy: "Com problemas",
    "quota-exceeded": "Sem espaço disponível",
    "repair-required": "Reparo necessário",
  };
  // Loading copy only appears when data is slower than this; fast loads go
  // straight from the neutral skeleton to the final state.
  const SLOW_FEEDBACK_MS = 150;
  const AUTOSAVE_DELAY_MS = 300;
  const SAVED_VISIBLE_MS = 2000;
  const CATALOG_FAILURE_TTL_MS = 60_000;
  const SPEED_HELP = "Mais rápido, consome mais franquia.";
  const MEMORY_SLOT_HEIGHT_KEY = "openbot.settings.memory-slot-height.v1";
  const DEFAULT_MEMORY_SLOT_HEIGHT = 121;
  const MODEL_REFRESH_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71"/><path d="M13.25 2.75v3h-3"/></svg>';
  // Session memory (renderer lifetime): catalogs per provider (explicit refresh
  // forces a new read), the row layout last shown for each bot so the skeleton
  // reserves the final height, and choices that could not be applied yet.
  const providerCatalogCache = new Map();
  const SETTINGS_LAYOUT_KEY = "openbot.settings.layout.v1";
  let settingsLayoutMemory = null;
  const pendingProviderSelections = new Map();
  let memorySlotHeight = 0;

  // The last layout per bot is also kept for this viewer across restarts, so
  // even the first open of a session starts at its final height.
  function layoutMemory() {
    if (!settingsLayoutMemory) {
      settingsLayoutMemory = new Map();
      try {
        for (const [key, value] of Object.entries(JSON.parse(localStorage.getItem(SETTINGS_LAYOUT_KEY) || "{}"))) {
          if (value && typeof value === "object") settingsLayoutMemory.set(key, value);
        }
      } catch { /* start without remembered layouts */ }
    }
    return settingsLayoutMemory;
  }

  function rememberSettingsLayout(key, value) {
    const memory = layoutMemory();
    if (JSON.stringify(memory.get(key)) === JSON.stringify(value)) return;
    memory.delete(key);
    memory.set(key, value);
    while (memory.size > 50) memory.delete(memory.keys().next().value);
    try { localStorage.setItem(SETTINGS_LAYOUT_KEY, JSON.stringify(Object.fromEntries(memory))); } catch { /* per-viewer convenience only */ }
  }

  function reservedMemorySlotHeight() {
    if (!memorySlotHeight) {
      try { memorySlotHeight = Number(localStorage.getItem(MEMORY_SLOT_HEIGHT_KEY)) || 0; } catch { memorySlotHeight = 0; }
    }
    return memorySlotHeight || DEFAULT_MEMORY_SLOT_HEIGHT;
  }

  // Called from the shared observer when the memory overlay fills the slot: the
  // reservation is released and the real height is remembered for next time.
  function settleMemorySlot() {
    const slot = document.getElementById("openbot-memory-slot");
    if (!(slot instanceof HTMLElement) || !slot.firstElementChild) return;
    if (slot.style.minHeight) slot.style.minHeight = "";
    const height = Math.round(slot.getBoundingClientRect().height);
    if (!height || height === memorySlotHeight) return;
    memorySlotHeight = height;
    try { localStorage.setItem(MEMORY_SLOT_HEIGHT_KEY, String(height)); } catch { /* per-viewer convenience only */ }
  }

  function syncRepairVisibility(repairEl) {
    const row = repairEl?.closest(".ob-runtime-actions");
    if (row) row.hidden = repairEl.disabled && repairEl.dataset.busy !== "1";
  }

  async function updateLifecycleStatus(root, agentId) {
    const status = root.querySelector("#openbot-lifecycle-status");
    const runtimeStatus = root.querySelector("#openbot-runtime-status");
    const repairEl = root.querySelector("#openbot-runtime-repair");
    const advancedStatus = root.querySelector("#openbot-advanced-status");
    const api = desktop()?.agent;
    const updates = [];
    const failures = [];
    let runtimeState = null;
    const show = (element, text, failed = false) => {
      if (element.textContent !== text) element.textContent = text;
      element.classList.toggle("err", failed);
    };
    const slow = setLocalTimeout(() => {
      for (const element of [status, runtimeStatus]) if (element && !element.textContent) show(element, "Verificando…");
    }, SLOW_FEEDBACK_MS);
    if (status) {
      updates.push((async () => {
        if (typeof api?.getWorkspaceInventory !== "function") return show(status, "Indisponível neste aplicativo");
        try {
          const inventory = await api.getWorkspaceInventory({ agentId });
          const entries = Array.isArray(inventory) ? inventory : inventory?.entries;
          if (!Array.isArray(entries)) throw new Error("O gateway não retornou um inventário verificável.");
          show(status, "Verificado");
          status.title = `${entries.length} ${entries.length === 1 ? "item verificado" : "itens verificados"}`;
        } catch (error) {
          show(status, "Falha na verificação", true);
          failures.push(userFacingError(error, "Não foi possível verificar os arquivos do bot."));
        }
      })());
    }
    if (runtimeStatus) {
      updates.push((async () => {
        if (typeof api?.getLocalRuntimeStatus !== "function") {
          show(runtimeStatus, "Indisponível neste aplicativo");
          if (repairEl) repairEl.disabled = true;
          return;
        }
        try {
          const runtime = await api.getLocalRuntimeStatus({ agentId });
          const state = typeof runtime?.state === "string" ? runtime.state : "unknown";
          runtimeState = state;
          show(runtimeStatus, RUNTIME_STATE_LABELS[state] || "Estado desconhecido", state === "repair-required" || state === "unhealthy");
          if (repairEl) repairEl.disabled = state !== "repair-required" && state !== "unhealthy";
          syncRepairVisibility(repairEl);
        } catch (error) {
          show(runtimeStatus, "Falha na verificação", true);
          failures.push(userFacingError(error, "Não foi possível consultar o ambiente de execução."));
          if (repairEl) repairEl.disabled = false;
          syncRepairVisibility(repairEl);
        }
      })());
    }
    await Promise.all(updates);
    clearLocalTimeout(slow);
    if (failures.length && advancedStatus && root.isConnected) {
      advancedStatus.className = "ob-group-status ob-advanced-status err";
      advancedStatus.firstElementChild.textContent = failures.join(" ");
    }
    return runtimeState;
  }

  function settingsContextKey(_host, scope) {
    return `${scope}|${location.href}|${selectedAgentRow()?.getAttribute("data-agent-id") || ""}`;
  }

  function prepareAgentSettingsHost(host) {
    host.dataset.openbotAgentSettingsHost = "1";
    polishAgentSettingsCopy(host);
    const directLabels = [...host.children].filter((element) => element.matches("label"));
    const directFields = [...host.children].filter((element) => element.matches("input, textarea, select"));
    const translatedLabels = new Map([
      ["Name", "Nome"],
      ["Description", "Descrição"],
      ["Notifications", "Notificações"],
    ]);
    for (const label of directLabels) {
      const translated = translatedLabels.get(textOf(label));
      if (translated) label.textContent = translated;
    }
    if (directLabels.length >= 2 && directFields.length >= 2) host.dataset.openbotSimpleFields = "1";
  }

  // The sidebar row can sit under a modal (aria-hidden), so the name is read
  // from the current row itself rather than from the visible-row lookup.
  function currentAgentRow(agentId = "") {
    if (agentId) {
      const exact = [...document.querySelectorAll(".sand-agent-item[data-agent-id]")].find((row) => row.getAttribute("data-agent-id") === agentId);
      if (exact) return exact;
    }
    return selectedAgentRow() || document.querySelector('.sand-agent-item[data-agent-id][aria-current="page"], .sand-agent-item[data-agent-id][data-active="true"]');
  }

  function botDisplayName(row) {
    return textOf(row?.querySelector(".sand-agent-item__name")) || row?.getAttribute("aria-label") || "";
  }

  function modelGroupCopy(globalScope, agentId, botName) {
    if (!globalScope) return { label: "Modelo", help: "" };
    // The gateway applies these fields to the selected bot whenever one exists;
    // only without bots do they become the default that new bots inherit.
    return agentId
      ? { label: "Provedor e modelo do bot", help: `Vale para o bot selecionado${botName ? ` (${botName})` : ""}. Cada bot tem a sua configuração.` }
      : { label: "Provedor e modelo padrão", help: "Bots novos usam esta configuração." };
  }

  function renderSettings(host, scope = "agent") {
    const globalScope = scope === "global";
    if (!globalScope) prepareAgentSettingsHost(host);
    const contextKey = settingsContextKey(host, scope);
    const existing = document.getElementById(ROOT_ID);
    if (existing && host.contains(existing) && existing.dataset.contextKey === contextKey) {
      return;
    }
    // Agent settings can reuse the same React surface or move it between bots.
    // A fresh node avoids carrying provider/model state and event handlers over.
    existing?.remove();
    ensureStyle();
    const selectedRow = selectedAgentRow();
    const selectedId = selectedRow?.getAttribute("data-agent-id") || "";
    // The complete final skeleton goes in now, in the same frame as the native
    // pane; hydration only fills it in. Rows the bot showed last time keep
    // their space so the panel height does not jump when data arrives.
    const layout = layoutMemory().get(`${scope}|${selectedId}`) || {};
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("lang", "pt-BR");
    root.dataset.scope = scope;
    root.dataset.contextKey = contextKey;
    root.dataset.loading = "1";
    root.dataset.saveState = "idle";
    root.innerHTML = `
      <section class="ob-group" data-group="model" aria-labelledby="openbot-model-group-label">
        <div class="ob-group-head">
          <div id="openbot-model-group-label" class="ob-group-label"></div>
          <div id="openbot-status" class="ob-group-status" role="status" aria-live="polite"><span class="ob-status-text"></span><button type="button" id="openbot-status-action" class="ob-link-button" hidden></button></div>
        </div>
        <p id="openbot-model-group-help" class="ob-group-help" hidden></p>
        <div class="ob-card ob-provider-card">
          <div class="ob-field-row" data-row="provider">
            <label class="ob-row-label" for="openbot-provider">Provedor</label>
            <div class="ob-row-control">
              <select id="openbot-provider">
                <option value="xai">xAI</option>
                <option value="openai">OpenAI Codex</option>
                <option value="opencode-go">OpenCode Go</option>
              </select>
            </div>
          </div>
          <div class="ob-field-row ob-auth-row" data-row="account">
            <span class="ob-row-label">Conta</span>
            <div class="ob-row-control ob-auth-control">
              <span id="openbot-auth-status" class="ob-key-status" data-state="loading" role="status" aria-live="polite"></span>
              <button type="button" id="openbot-auth-action" class="ob-button">Entrar</button>
            </div>
            <p id="openbot-auth-note" class="ob-row-note" hidden></p>
          </div>
          <div id="openbot-api-key-row" class="ob-field-row ob-stack-row" data-row="api-key"${layout.apiKey ? "" : " hidden"}>
            <label class="ob-row-label" for="openbot-apikey">Chave de API do OpenCode Go</label>
            <div class="ob-secret-row">
              <input id="openbot-apikey" type="password" class="ob-input" maxlength="8192" autocomplete="off" spellcheck="false" placeholder="Cole a chave" />
              <button type="button" id="openbot-apikey-save" class="ob-button">Salvar chave</button>
            </div>
          </div>
          <div class="ob-field-row" data-row="model">
            <label class="ob-row-label" for="openbot-model">Modelo</label>
            <div class="ob-row-control ob-model-control">
              <select id="openbot-model"></select>
              <button type="button" id="openbot-model-refresh" class="ob-button ob-icon-button" aria-label="Atualizar lista de modelos" title="Atualizar lista de modelos">${MODEL_REFRESH_ICON}</button>
            </div>
            <p id="openbot-model-status" class="ob-row-note${layout.modelNote ? " is-reserved" : ""}" aria-live="polite"${layout.modelNote ? ` style="min-height:${Math.min(96, Number(layout.modelNote) || 16)}px"` : " hidden"}>${layout.modelNote ? "&nbsp;" : ""}</p>
          </div>
          <div id="openbot-reasoning-row" class="ob-field-row" data-row="reasoning"${layout.reasoning ? "" : " hidden"}>
            <label class="ob-row-label" for="openbot-reasoning">Raciocínio</label>
            <div class="ob-row-control">
              <select id="openbot-reasoning">
                <option value="minimal">Mínimo</option>
                <option value="low">Baixo</option>
                <option value="medium">Médio</option>
                <option value="high">Alto</option>
                <option value="xhigh">Muito alto</option>
              </select>
            </div>
          </div>
          <div id="openbot-speed-row" class="ob-field-row" data-row="speed"${layout.speed ? "" : " hidden"}>
            <label class="ob-row-label" for="openbot-speed">Velocidade</label>
            <div class="ob-row-control">
              <select id="openbot-speed"><option value="default">Padrão</option><option value="priority">Fast</option></select>
            </div>
            <p id="openbot-speed-help" class="ob-row-note">${SPEED_HELP}</p>
            <p id="openbot-speed-result" class="ob-row-note" hidden></p>
          </div>
        </div>
      </section>${globalScope ? "" : `
      <section class="ob-group" data-group="memory" aria-labelledby="openbot-memory-group-label">
        <div id="openbot-memory-group-label" class="ob-group-label">Memória</div>
        <div id="openbot-memory-slot" class="ob-card" data-openbot-memory-slot="1"></div>
      </section>
      <section class="ob-group" data-group="advanced">
        <details id="openbot-advanced" class="ob-advanced">
          <summary>Avançado</summary>
          <div class="ob-advanced-body">
            <div class="ob-card">
              <div class="ob-field-row ob-stack-row" data-row="files">
                <span class="ob-row-label">Arquivos do bot</span>
                <div class="ob-folder-actions">
                  <button type="button" id="openbot-open-documents" class="ob-button">Abrir Documentos</button>
                  <button type="button" id="openbot-open-workspace" class="ob-button">Abrir Projetos</button>
                </div>
              </div>
              <div class="ob-field-row" data-row="workspace">
                <span class="ob-row-label">Espaço de trabalho</span>
                <span id="openbot-lifecycle-status" class="ob-lifecycle-status" aria-live="polite"></span>
              </div>
              <div class="ob-field-row" data-row="runtime">
                <span class="ob-row-label">Ambiente de execução</span>
                <span id="openbot-runtime-status" class="ob-lifecycle-status" aria-live="polite"></span>
              </div>
              <div class="ob-runtime-actions" hidden>
                <button type="button" id="openbot-runtime-repair" class="ob-button">Reparar</button>
              </div>
            </div>
            <div id="openbot-advanced-status" class="ob-group-status ob-advanced-status" role="status" aria-live="polite"><span class="ob-status-text"></span></div>
          </div>
        </details>
      </section>`}
    `;
    const currentRow = selectedRow || (globalScope ? currentAgentRow() : null);
    const copy = modelGroupCopy(globalScope, currentRow?.getAttribute("data-agent-id") || "", botDisplayName(currentRow));
    root.querySelector("#openbot-model-group-label").textContent = copy.label;
    const groupHelp = root.querySelector("#openbot-model-group-help");
    groupHelp.textContent = copy.help;
    groupHelp.hidden = !copy.help;
    const memorySlot = root.querySelector("#openbot-memory-slot");
    if (memorySlot instanceof HTMLElement) memorySlot.style.minHeight = `${reservedMemorySlotHeight()}px`;
    const globalMount = globalScope ? prepareGlobalSettingsMount(host) : null;
    host.dataset.openbotMotionSurface = "settings";
    if (globalMount?.content instanceof HTMLElement) {
      root.dataset.nativeSection = "1";
      globalMount.content.insertBefore(root, globalMount.before?.parentElement === globalMount.content ? globalMount.before : null);
    } else if (globalMount?.legacyAccount?.parentElement) globalMount.legacyAccount.parentElement.insertBefore(root, globalMount.legacyAccount);
    else host.appendChild(root);
    // One entrance motion: when the native surface is already fading in (or the
    // panel is only re-rendering for another bot), the section rides along
    // instead of starting a second, offset fade.
    if (host.dataset.openbotSettingsShown === "1" || ancestorMotionActive(root)) stampMotion(root, "settings");
    else queueMotionTarget(root, "settings");
    host.dataset.openbotSettingsShown = "1";
    window.dispatchEvent(new Event("openbot:settings-mounted"));
    void hydrateOAuthSettings(root, () => {
      root.remove();
      renderSettings(host, scope);
    });
  }

  async function hydrateOAuthSettings(root, reload = () => undefined) {
    const globalScope = root.dataset.scope === "global";
    const status = root.querySelector("#openbot-status");
    const statusText = status.querySelector(".ob-status-text");
    const statusAction = root.querySelector("#openbot-status-action");
    const advancedStatus = root.querySelector("#openbot-advanced-status");
    const groupLabelEl = root.querySelector("#openbot-model-group-label");
    const groupHelpEl = root.querySelector("#openbot-model-group-help");
    const providerEl = root.querySelector("#openbot-provider");
    const modelEl = root.querySelector("#openbot-model");
    const catalogStatus = root.querySelector("#openbot-model-status");
    const catalogRefresh = root.querySelector("#openbot-model-refresh");
    const modelSelections = new Map();
    let shownProvider;
    let catalogGeneration = 0;
    const reasoningEl = root.querySelector("#openbot-reasoning");
    const reasoningRowEl = root.querySelector("#openbot-reasoning-row");
    const speedEl = root.querySelector("#openbot-speed");
    const speedRow = root.querySelector("#openbot-speed-row");
    const speedHelp = root.querySelector("#openbot-speed-help");
    const speedResult = root.querySelector("#openbot-speed-result");
    const authStatusEl = root.querySelector("#openbot-auth-status");
    const authActionEl = root.querySelector("#openbot-auth-action");
    const authNoteEl = root.querySelector("#openbot-auth-note");
    const apiKeyRow = root.querySelector("#openbot-api-key-row");
    const apiKeyEl = root.querySelector("#openbot-apikey");
    const apiKeySaveEl = root.querySelector("#openbot-apikey-save");
    const openWorkspaceEl = root.querySelector("#openbot-open-workspace");
    const openDocumentsEl = root.querySelector("#openbot-open-documents");
    const repairRuntimeEl = root.querySelector("#openbot-runtime-repair");
    const advancedEl = root.querySelector("#openbot-advanced");
    const advancedBodyEl = root.querySelector(".ob-advanced-body");
    const selects = [providerEl, modelEl, reasoningEl, speedEl];
    const loadingControls = [providerEl, modelEl, reasoningEl, speedEl, authActionEl, apiKeyEl, apiKeySaveEl];
    selects.forEach(enhanceStyledSelect);
    const setControlsDisabled = (disabled) => {
      loadingControls.forEach((control) => { control.disabled = disabled; });
      selects.forEach(refreshStyledSelect);
    };
    setControlsDisabled(true);
    for (const button of [repairRuntimeEl, openWorkspaceEl, openDocumentsEl]) if (button) button.disabled = true;
    let activeAgentId;
    let oauth = {};
    let openCodeConfigured = false;
    let stateModels = [];
    let pollToken = 0;
    let saving = false;
    let savePromise = null;
    let authBusy = false;
    let persisted = "";
    let loaded = false;
    let userTouched = false;
    let saveError = null;
    let notice = null;
    let lastSavedAt = 0;
    let savedMessage = "Salvo";
    let autosaveTimer = 0;
    let savedTimer = 0;
    let statusActionRun = null;
    let catalogPendingFor = "";
    const selectedId = selectedAgentRow()?.getAttribute("data-agent-id") || null;
    const layoutKey = `${root.dataset.scope}|${selectedId || ""}`;
    const isCurrent = () => root.isConnected && root.dataset.contextKey === settingsContextKey(null, root.dataset.scope);
    const selection = () => JSON.stringify([providerEl.value, modelEl.value, reasoningEl.value, speedEl.value]);
    const catalogFor = (provider) => providerCatalogCache.get(provider)?.catalog;
    const setStatus = (kind, text, action = null) => {
      if (!isCurrent()) return;
      // The retry link already says it; do not repeat "Tente novamente." before it.
      if (action?.label === "Tentar novamente") text = text.replace(/s*Tente novamente.?$/i, "");
      const changed = statusText.textContent !== text || (status.dataset.kind || "") !== kind;
      status.dataset.kind = kind;
      status.className = `ob-group-status${kind ? ` ${kind}` : ""}`;
      if (statusText.textContent !== text) statusText.textContent = text;
      statusActionRun = action?.run || null;
      statusAction.hidden = !action;
      if (statusAction.textContent !== (action?.label || "")) statusAction.textContent = action?.label || "";
      if (changed && text) queueChangedStatus(status);
    };
    statusAction.addEventListener("click", () => statusActionRun?.());
    const setAdvancedStatus = (kind, text) => {
      if (!advancedStatus || !isCurrent()) return;
      advancedStatus.className = `ob-group-status ob-advanced-status${kind ? ` ${kind}` : ""}`;
      advancedStatus.firstElementChild.textContent = text;
      if (text) queueChangedStatus(advancedStatus);
    };
    let modelNoteHeight = 0;
    const rememberLayout = () => {
      if (!loaded) return;
      rememberSettingsLayout(layoutKey, { reasoning: !reasoningRowEl.hidden, speed: !speedRow.hidden, apiKey: !apiKeyRow.hidden, modelNote: catalogStatus.hidden ? 0 : modelNoteHeight || 16 });
    };
    const blockedReason = () => {
      const provider = providerEl.value;
      if (!["openai", "xai", "opencode-go"].includes(provider)) return "Este provedor não pode ser alterado aqui.";
      const authenticated = provider === "opencode-go" ? openCodeConfigured : oauth[provider]?.state === "connected";
      if (!authenticated) return provider === "opencode-go" ? "Salve a chave de API para aplicar." : "Entre na conta para aplicar.";
      if (!modelEl.value) return "Nenhum modelo disponível.";
      if (modelEl.selectedOptions[0]?.disabled) return "Modelo indisponível; escolha outro.";
      if (reasoningEl.selectedOptions[0]?.disabled) return "Raciocínio não aceito por este modelo.";
      if (speedEl.selectedOptions[0]?.disabled) return "Fast indisponível; escolha Padrão.";
      return "";
    };
    // One status line for the group, by precedence: saving, a failed save (with
    // retry), an account/key notice, what blocks a pending choice, then "Salvo".
    const syncSave = () => {
      if (!isCurrent() || !loaded) return;
      const dirty = selection() !== persisted;
      if (dirty && userTouched) pendingProviderSelections.set(activeAgentId || "", selection());
      else if (!dirty) pendingProviderSelections.delete(activeAgentId || "");
      if (saving) {
        root.dataset.saveState = "saving";
        return setStatus("", "Salvando…");
      }
      if (saveError && saveError.selection === selection()) {
        root.dataset.saveState = "error";
        return setStatus("err", saveError.message, { label: "Tentar novamente", run: () => { saveError = null; void persistSelection(); } });
      }
      const reason = dirty ? blockedReason() : "";
      if (notice) {
        root.dataset.saveState = dirty ? (reason ? "blocked" : "pending") : root.dataset.saveState === "saved" ? "saved" : "idle";
        return setStatus(notice.kind, notice.text, notice.action || null);
      }
      if (dirty) {
        root.dataset.saveState = reason ? "blocked" : "pending";
        return setStatus(reason ? "warn" : "", reason);
      }
      if (lastSavedAt) {
        root.dataset.saveState = "saved";
        return setStatus(Date.now() - lastSavedAt < SAVED_VISIBLE_MS ? "ok" : "", Date.now() - lastSavedAt < SAVED_VISIBLE_MS ? savedMessage : "");
      }
      root.dataset.saveState = "idle";
      setStatus("", "");
    };
    // Changes save on their own after a short pause; nothing is written for a
    // difference the user did not make.
    const scheduleAutosave = (delay = AUTOSAVE_DELAY_MS) => {
      clearLocalTimeout(autosaveTimer);
      autosaveTimer = 0;
      if (!isCurrent() || !loaded) return;
      // While the selected provider's catalog is still loading, its limits
      // (reasoning levels, Fast) are unknown: wait for it before writing.
      if (userTouched && catalogPendingFor !== providerEl.value && selection() !== persisted && !blockedReason()) {
        autosaveTimer = setLocalTimeout(() => {
          autosaveTimer = 0;
          void persistSelection();
        }, delay);
      }
      syncSave();
    };
    const fillModels = (models, provider, selected) => {
      const usable = models.filter((model) => (model.vendorName || model.provider) === provider);
      modelEl.replaceChildren();
      for (const model of usable) {
        const id = model.name || model.id;
        const entry = option(id, model.clientDisplayName || model.displayName || id, id === selected);
        entry.disabled = model.selectable === false;
        entry.title = model.reason ? userFacingError(model.reason, "Modelo indisponível no momento.") : "";
        if (entry.disabled) entry.textContent += " (indisponível)";
        modelEl.appendChild(entry);
      }
      if (selected && ![...modelEl.options].some((entry) => entry.value === selected)) {
        const missing = option(selected, `${selected} (fora da lista atual)`, true);
        missing.disabled = true;
        missing.title = "Este modelo não aparece na lista atual do provedor.";
        modelEl.appendChild(missing);
      }
      if (selected) modelEl.value = selected;
      if (![...modelEl.options].some((entry) => entry.selected) && modelEl.options[0]) modelEl.selectedIndex = 0;
      refreshStyledSelect(modelEl);
    };
    // OpenAI always takes an effort; other providers only when the selected model declares its levels.
    const reasoningAvailable = () => {
      if (providerEl.value === "openai") return true;
      const efforts = catalogFor(providerEl.value)?.models?.find(m => m.id === modelEl.value)?.supportedReasoningEfforts;
      return Array.isArray(efforts) && efforts.length > 0;
    };
    const syncReasoning = () => {
      const supportsFast = Boolean(activeAgentId) && providerEl.value === "openai" && catalogFor("openai")?.models?.find(m => m.id === modelEl.value)?.serviceTiers?.includes("priority");
      speedEl.querySelector('[value="priority"]').disabled = !supportsFast;
      speedRow.hidden = !supportsFast && speedEl.value !== "priority";
      const unsupportedFast = speedEl.value === "priority" && !supportsFast;
      const help = unsupportedFast ? "Fast indisponível para este modelo. Escolha Padrão." : SPEED_HELP;
      if (speedHelp.textContent !== help) speedHelp.textContent = help;
      speedHelp.classList.toggle("err", unsupportedFast);
      refreshStyledSelect(speedEl);
      const efforts = catalogFor(providerEl.value)?.models?.find(m => m.id === modelEl.value)?.supportedReasoningEfforts;
      for (const entry of reasoningEl.options) entry.disabled = Array.isArray(efforts) && !efforts.includes(entry.value);
      if (["openai", "xai", "opencode-go"].includes(providerEl.value)) reasoningRowEl.hidden = !reasoningAvailable();
      refreshStyledSelect(reasoningEl);
      rememberLayout();
    };
    const renderCatalogNote = (provider, catalog, failure = "") => {
      const labels = { stale: "Lista de modelos desatualizada.", empty: "Nenhum modelo disponível para este provedor.", unavailable: "Lista de modelos ainda não confirmada." };
      const selected = catalog?.models?.find((model) => model.id === modelEl.value);
      const text = [
        failure || (catalog?.error ? userFacingError(catalog.error, "Não foi possível atualizar a lista de modelos.") : labels[catalog?.state] || ""),
        selected?.reason ? userFacingError(selected.reason, "Este modelo não está disponível agora.") : "",
        provider === "opencode-go" && catalog ? "Lista pública; o acesso da sua conta não foi confirmado." : "",
      ].filter(Boolean).join(" ");
      catalogStatus.dataset.catalogState = failure ? "error" : catalog?.state || "";
      catalogStatus.classList.remove("is-reserved");
      catalogStatus.style.removeProperty("min-height");
      if (catalogStatus.textContent !== text) catalogStatus.textContent = text;
      catalogStatus.hidden = !text;
      modelNoteHeight = text ? Math.round(catalogStatus.getBoundingClientRect().height) : 0;
      catalogRefresh.title = catalog?.updatedAt
        ? `Atualizar lista de modelos (atualizada em ${new Date(catalog.updatedAt).toLocaleString("pt-BR")})`
        : "Atualizar lista de modelos";
      rememberLayout();
    };
    const updateCatalog = async (refresh) => {
      const provider = providerEl.value;
      const api = desktop()?.agent;
      if (!api?.getProviderModelCatalog || !["openai", "xai", "opencode-go"].includes(provider)) return;
      const generation = ++catalogGeneration;
      catalogPendingFor = provider;
      catalogRefresh.disabled = true;
      catalogRefresh.classList.add("is-busy");
      catalogRefresh.setAttribute("aria-busy", "true");
      try {
        const catalog = await api.getProviderModelCatalog({ provider, refresh });
        providerCatalogCache.set(provider, { catalog, at: Date.now() });
        if (!isCurrent() || generation !== catalogGeneration || providerEl.value !== provider) return;
        fillModels(catalog.models || [], provider, modelEl.value);
        syncReasoning();
        renderCatalogNote(provider, catalog);
      } catch (error) {
        const failure = userFacingError(error, "Não foi possível atualizar a lista de modelos.");
        if (!catalogFor(provider)) providerCatalogCache.set(provider, { failure, at: Date.now() });
        if (isCurrent() && generation === catalogGeneration && providerEl.value === provider) renderCatalogNote(provider, catalogFor(provider), failure);
      } finally {
        if (isCurrent() && generation === catalogGeneration) {
          catalogPendingFor = "";
          catalogRefresh.disabled = false;
          catalogRefresh.classList.remove("is-busy");
          catalogRefresh.removeAttribute("aria-busy");
          scheduleAutosave();
        }
      }
    };
    // First use of a provider in this session reads the local catalog and then
    // lets the gateway refresh it if stale; later opens reuse that result.
    const loadCatalog = async (provider) => {
      const cached = providerCatalogCache.get(provider);
      if (cached?.catalog) {
        fillModels(cached.catalog.models || [], provider, modelEl.value);
        syncReasoning();
        renderCatalogNote(provider, cached.catalog);
        return;
      }
      if (cached?.failure && Date.now() - cached.at < CATALOG_FAILURE_TTL_MS) {
        renderCatalogNote(provider, undefined, cached.failure);
        return;
      }
      await updateCatalog();
      if (isCurrent() && providerEl.value === provider && catalogFor(provider)) await updateCatalog(false);
    };
    catalogRefresh.addEventListener("click", () => void updateCatalog(true));
    const setAuthState = (state, text, note = "", noteIsError = false) => {
      authStatusEl.dataset.state = state;
      if (authStatusEl.textContent !== text) authStatusEl.textContent = text;
      if (authNoteEl.textContent !== note) authNoteEl.textContent = note;
      authNoteEl.classList.toggle("err", noteIsError);
      authNoteEl.hidden = !note;
    };
    const syncAuth = () => {
      authActionEl.disabled = !loaded || authBusy;
      if (!["openai", "xai", "opencode-go"].includes(providerEl.value)) {
        apiKeyRow.hidden = true;
        reasoningRowEl.hidden = true;
        authActionEl.hidden = true;
        setAuthState("error", "Fora deste painel");
        rememberLayout();
        syncSave();
        return;
      }
      const openCode = providerEl.value === "opencode-go";
      reasoningRowEl.hidden = !reasoningAvailable();
      apiKeyRow.hidden = !openCode;
      apiKeySaveEl.disabled = saving || authBusy || !openCode || !apiKeyEl.value.trim();
      apiKeyEl.placeholder = openCodeConfigured ? "Cole uma nova chave" : "Cole a chave";
      if (openCode) {
        setAuthState(openCodeConfigured ? "connected" : "disconnected", openCodeConfigured ? "Chave salva" : "Sem chave");
        authActionEl.hidden = !openCodeConfigured;
        authActionEl.textContent = "Remover chave";
        rememberLayout();
        syncSave();
        return;
      }
      authActionEl.hidden = false;
      const current = oauth[providerEl.value] || { state: "disconnected" };
      if (current.state === "connected") {
        setAuthState("connected", "Conectado");
        authActionEl.textContent = "Desconectar";
      } else if (current.state === "pending") {
        setAuthState("pending", "Aguardando login", current.userCode ? `Digite o código ${current.userCode} no navegador para concluir.` : "Conclua o login no navegador.");
        authActionEl.textContent = "Cancelar";
      } else if (current.state === "error" || current.message) {
        setAuthState("error", "Não conectado", userFacingError(current.message, "Não foi possível verificar a conexão."), true);
        authActionEl.textContent = "Entrar";
      } else {
        setAuthState("disconnected", "Não conectado");
        authActionEl.textContent = "Entrar";
      }
      rememberLayout();
      syncSave();
    };
    const persistSelection = async (message = "Salvo") => {
      if (saving || authBusy || !isCurrent()) return;
      const provider = providerEl.value;
      const authenticated = provider === "opencode-go"
        ? openCodeConfigured
        : oauth[provider]?.state === "connected";
      if (!authenticated || !modelEl.value || modelEl.selectedOptions[0]?.disabled || reasoningEl.selectedOptions[0]?.disabled || speedEl.selectedOptions[0]?.disabled) return syncSave();
      if (selection() === persisted) return syncSave();
      saving = true;
      saveError = null;
      const submitted = selection();
      syncSave();
      let settle;
      savePromise = new Promise((resolve) => { settle = resolve; });
      try {
        const saved = await desktop().agent.setProviderConfig({ agentId: activeAgentId, provider, model: modelEl.value, reasoningEffort: reasoningEl.value, ...(activeAgentId ? { serviceTier: speedEl.value } : {}) });
        if (!isCurrent()) return;
        if (saved?.agentId !== activeAgentId || JSON.stringify([saved?.provider, saved?.model, saved?.reasoningEffort, saved?.serviceTier || "default"]) !== submitted) {
          throw new Error("A persistência não confirmou a seleção enviada.");
        }
        persisted = submitted;
        lastSavedAt = Date.now();
        savedMessage = message;
        notice = null;
        return saved;
      } catch (error) {
        if (!isCurrent()) return;
        saveError = { selection: submitted, message: userFacingError(error, "Não foi possível salvar as alterações.") };
      } finally {
        saving = false;
        settle();
        if (isCurrent()) {
          syncAuth();
          // A choice made while the previous save was in flight is saved next.
          if (!saveError && selection() !== persisted) scheduleAutosave(0);
          else if (lastSavedAt && !saveError) {
            clearLocalTimeout(savedTimer);
            savedTimer = setLocalTimeout(syncSave, SAVED_VISIBLE_MS + 20);
          }
        }
      }
    };
    const pollOAuth = async (provider, token) => {
      let failures = 0;
      let delayMs = 1000;
      while (isCurrent() && token === pollToken && oauth[provider]?.state === "pending") {
        await new Promise((resolve) => setLocalTimeout(resolve, delayMs));
        if (!isCurrent() || token !== pollToken) return;
        try {
          const current = await desktop().agent.getProviderOAuthStatus(provider);
          if (!isCurrent() || token !== pollToken) return;
          oauth[provider] = current;
          failures = 0;
          delayMs = 1000;
        } catch (error) {
          if (!isCurrent() || token !== pollToken) return;
          failures += 1;
          if (failures >= 5) {
            oauth[provider] = { state: "error", message: userFacingError(error, "Não foi possível confirmar o login.") };
          } else {
            delayMs = Math.min(8000, 1000 * (2 ** failures));
          }
        }
        if (providerEl.value === provider) {
          syncAuth();
          if (oauth[provider]?.state === "connected") applyAfterConnect();
        }
      }
    };
    const bindFolderOpen = (button, opener, okText) => button.addEventListener("click", async () => {
      const original = button.textContent;
      button.disabled = true;
      button.textContent = "Abrindo…";
      try {
        await opener();
        setAdvancedStatus("ok", okText);
      } catch (error) {
        setAdvancedStatus("err", userFacingError(error, "Não foi possível abrir a pasta. Verifique o acesso aos arquivos do bot."));
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    });
    // After a login or a saved key, the choice the user was waiting to apply
    // goes through the same guarded save; nothing else is written.
    const applyAfterConnect = () => {
      notice = { kind: "ok", text: "Conta conectada." };
      syncSave();
      void updateCatalog(true).then(() => {
        if (!isCurrent()) return;
        if (userTouched && selection() !== persisted) notice = null;
        scheduleAutosave(0);
      });
    };
    if (!globalScope && advancedEl && advancedBodyEl) advancedEl.addEventListener("toggle", () => {
      if (!advancedEl.open) {
        elementAnimations.get(advancedBodyEl)?.cancel();
        animatedElements.delete(advancedBodyEl);
        return;
      }
      animatedElements.delete(advancedBodyEl);
      queueMotionTarget(advancedBodyEl, "disclosure");
    });
    if (!globalScope) bindFolderOpen(openWorkspaceEl, async () => desktop().agent.openWorkspace(), "Pasta Projetos aberta no Explorador de Arquivos.");
    if (!globalScope) bindFolderOpen(openDocumentsEl, async () => desktop().agent.openUserDocuments(), "Pasta Documentos aberta no Explorador de Arquivos.");
    if (!globalScope) repairRuntimeEl?.addEventListener("click", async () => {
      const original = repairRuntimeEl.textContent;
      repairRuntimeEl.disabled = true;
      repairRuntimeEl.dataset.busy = "1";
      repairRuntimeEl.textContent = "Reparando…";
      setAdvancedStatus("", "");
      try {
        const repaired = await desktop().agent.repairLocalRuntime({ agentId: activeAgentId });
        const runtimeState = await updateLifecycleStatus(root, activeAgentId);
        if (!["ready", "busy"].includes(repaired?.state) || !["ready", "busy", "lite-ready"].includes(runtimeState)) {
          throw new Error(repaired?.state === "repair-required" || runtimeState === "repair-required" ? "O ambiente ainda precisa de reparo." : "Não foi possível confirmar o reparo do ambiente.");
        }
        setAdvancedStatus("ok", "Ambiente reparado.");
      } catch (error) {
        repairRuntimeEl.disabled = false;
        setAdvancedStatus("err", userFacingError(error, "Não foi possível reparar o ambiente. Tente novamente."));
      } finally {
        delete repairRuntimeEl.dataset.busy;
        repairRuntimeEl.textContent = original;
        syncRepairVisibility(repairRuntimeEl);
      }
    });
    const slowLoad = setLocalTimeout(() => {
      if (!loaded && isCurrent()) setStatus("", "Carregando…");
    }, SLOW_FEEDBACK_MS);
    try {
      const state = await loadState(selectedId || undefined, globalScope);
      if (!isCurrent()) return;
      if (selectedId && state.agentId !== selectedId) throw new Error("O bot selecionado mudou. Reabra as configurações.");
      clearLocalTimeout(slowLoad);
      activeAgentId = state.agentId;
      root.dataset.agentId = activeAgentId;
      const copy = modelGroupCopy(globalScope, activeAgentId, botDisplayName(currentAgentRow(activeAgentId)));
      if (groupLabelEl.textContent !== copy.label) groupLabelEl.textContent = copy.label;
      if (groupHelpEl.textContent !== copy.help) groupHelpEl.textContent = copy.help;
      groupHelpEl.hidden = !copy.help;
      oauth = state.oauth;
      openCodeConfigured = state.openCodeConfigured;
      stateModels = state.models;
      if (![...providerEl.options].some((entry) => entry.value === state.provider)) providerEl.appendChild(option(state.provider, `${state.provider} (salvo)`, true));
      providerEl.value = state.provider;
      shownProvider = state.provider;
      modelSelections.set(state.provider, state.modelId);
      fillModels(catalogFor(state.provider)?.models || state.models, state.provider, state.modelId);
      reasoningEl.value = state.reasoningEffort || "medium";
      speedEl.value = activeAgentId ? state.serviceTier : "default";
      const actual = state.lastServiceTier?.actual;
      speedResult.textContent = !actual?.length ? ""
        : actual.length > 1 ? "Última resposta: velocidade mista ou parcialmente confirmada."
        : actual[0] === "priority" ? "Última resposta: Fast confirmado pelo provedor."
        : actual[0] === "default" ? "Última resposta: velocidade Padrão."
        : "Última resposta: o provedor não confirmou a velocidade.";
      speedResult.hidden = !speedResult.textContent;
      persisted = JSON.stringify([state.provider, state.modelId || "", state.reasoningEffort || "medium", speedEl.value]);
      // A choice made earlier in this session that could not be applied yet
      // (for example before signing in) is shown again instead of dropped.
      const pending = pendingProviderSelections.get(activeAgentId || "");
      if (pending && pending !== persisted) {
        try {
          const [provider, model, reasoning, speed] = JSON.parse(pending);
          if ([...providerEl.options].some((entry) => entry.value === provider)) {
            providerEl.value = provider;
            shownProvider = provider;
            modelSelections.set(provider, model);
            fillModels(catalogFor(provider)?.models || state.models, provider, model);
            reasoningEl.value = reasoning;
            speedEl.value = speed;
            userTouched = true;
          }
        } catch {
          pendingProviderSelections.delete(activeAgentId || "");
        }
      }
      loaded = true;
      setControlsDisabled(false);
      delete root.dataset.loading;
      syncReasoning();
      syncAuth();
      void loadCatalog(providerEl.value);
      if (oauth[providerEl.value]?.state === "pending") void pollOAuth(providerEl.value, pollToken);
      if (!globalScope) {
        openWorkspaceEl.disabled = false;
        openDocumentsEl.disabled = false;
        void updateLifecycleStatus(root, activeAgentId);
      }
      providerEl.addEventListener("change", () => {
        userTouched = true;
        notice = null;
        speedEl.value = "default";
        speedResult.textContent = "";
        speedResult.hidden = true;
        pollToken += 1;
        modelSelections.set(shownProvider, modelEl.value);
        shownProvider = providerEl.value;
        fillModels(catalogFor(providerEl.value)?.models || stateModels, providerEl.value, modelSelections.get(providerEl.value));
        syncReasoning();
        syncAuth();
        void loadCatalog(providerEl.value);
        if (oauth[providerEl.value]?.state === "pending") void pollOAuth(providerEl.value, pollToken);
        scheduleAutosave();
      });
      for (const control of [modelEl, reasoningEl, speedEl]) control.addEventListener("change", () => {
        userTouched = true;
        notice = null;
        if (control === modelEl) {
          speedEl.value = "default";
          speedResult.textContent = "";
          speedResult.hidden = true;
          const catalog = catalogFor(providerEl.value);
          if (catalog) renderCatalogNote(providerEl.value, catalog);
        }
        syncReasoning();
        scheduleAutosave();
      });
      apiKeyEl.addEventListener("input", () => {
        apiKeyEl.removeAttribute("aria-invalid");
        syncAuth();
      });
      apiKeySaveEl.addEventListener("click", async () => {
        if (authBusy || !isCurrent()) return;
        if (saving) await savePromise;
        if (authBusy || saving || !isCurrent()) return;
        const apiKey = apiKeyEl.value.trim();
        if (!apiKey) {
          apiKeyEl.setAttribute("aria-invalid", "true");
          apiKeyEl.focus({ preventScroll: true });
          notice = { kind: "err", text: "Informe a chave de API do OpenCode Go." };
          return syncSave();
        }
        authBusy = true;
        notice = null;
        setControlsDisabled(true);
        syncAuth();
        try {
          await desktop().agent.setProviderApiKey("opencode-go", apiKey);
          if (!isCurrent()) return;
          openCodeConfigured = true;
          apiKeyEl.value = "";
          await updateCatalog(true);
          if (!isCurrent()) return;
          notice = { kind: "ok", text: "Chave salva." };
        } catch (error) {
          if (!isCurrent()) return;
          notice = { kind: "err", text: userFacingError(error, "Não foi possível salvar a chave. Confira se ela está correta."), action: { label: "Tentar novamente", run: () => apiKeySaveEl.click() } };
        } finally {
          authBusy = false;
          if (isCurrent()) {
            setControlsDisabled(false);
            syncAuth();
            scheduleAutosave(0);
          }
        }
      });
      authActionEl.addEventListener("click", async () => {
        if (authBusy || !isCurrent()) return;
        if (saving) await savePromise;
        if (authBusy || !isCurrent()) return;
        const provider = providerEl.value;
        const current = oauth[provider] || { state: "disconnected" };
        authBusy = true;
        notice = null;
        setControlsDisabled(true);
        syncAuth();
        try {
          pollToken += 1;
          if (provider === "opencode-go") {
            await desktop().agent.removeProviderSecret(provider);
            openCodeConfigured = false;
          } else if (current.state === "connected") oauth[provider] = await desktop().agent.disconnectProviderOAuth(provider);
          else if (current.state === "pending") oauth[provider] = await desktop().agent.cancelProviderOAuth(provider);
          else oauth[provider] = await desktop().agent.startProviderOAuth(provider);
          if (provider === "opencode-go" || current.state === "connected") {
            providerCatalogCache.delete(provider);
            await updateCatalog();
          }
          if (!isCurrent()) return;
          if (oauth[provider]?.state === "pending") void pollOAuth(provider, pollToken);
          else if (oauth[provider]?.state === "connected" && current.state !== "connected") applyAfterConnect();
        } catch (error) {
          if (!isCurrent()) return;
          const fallback = provider === "opencode-go" ? "Não foi possível remover a chave."
            : current.state === "connected" ? "Não foi possível desconectar a conta."
            : current.state === "pending" ? "Não foi possível cancelar o login."
            : "Não foi possível iniciar o login.";
          notice = { kind: "err", text: userFacingError(error, fallback), action: { label: "Tentar novamente", run: () => authActionEl.click() } };
        } finally {
          authBusy = false;
          if (isCurrent()) {
            setControlsDisabled(false);
            syncAuth();
          }
        }
      });
    } catch (error) {
      clearLocalTimeout(slowLoad);
      if (!isCurrent()) return;
      delete root.dataset.loading;
      authStatusEl.dataset.state = "error";
      setStatus("err", userFacingError(error, "Não foi possível carregar as configurações de IA."), { label: "Tentar novamente", run: reload });
    }
  }


  let generating = false;
  let lastSendAt = 0;
  let promptStatusTimer = 0;
  let promptStatusFailures = 0;
  let cachedSendAction = null;
  let cachedComposer = null;
  let optimisticGeneration = false;
  let optimisticAgentId = null;
  let optimisticConversationId = null;
  let optimisticNonce = null;
  let lastSubmitAction = null;
  let promptStatusRevision = 0;
  let activePromptAgentId = null;
  let activePromptConversationId = null;
  const busyAgentIds = new Set();
  const cancellingAgentIds = new Set();
  const unknownAgentIds = new Set();
  const promptStates = new Map();
  let stopAnchorRect = null;

  function syncGenerating() {
    generating = activePromptAgentId !== null && ((optimisticGeneration && optimisticAgentId === activePromptAgentId
      && optimisticConversationId !== null && optimisticConversationId === activePromptConversationId)
      || (busyAgentIds.has(activePromptAgentId) && promptStateForActiveConversation(activePromptAgentId) !== undefined));
  }

  function selectedAgentRow() {
    return [...document.querySelectorAll(".sand-agent-item[data-agent-id]")].find((row) =>
      isVisibleElement(row) && (row.getAttribute("aria-current") === "page" || row.dataset.active === "true")) || null;
  }

  async function refreshActivePromptAgent() {
    activePromptAgentId = selectedAgentRow()?.getAttribute("data-agent-id") || null;
    activePromptConversationId = null;
    if (activePromptAgentId) {
      try {
        const active = await desktop()?.agent?.getActiveConversation?.({ agentId: activePromptAgentId });
        activePromptConversationId = typeof active?.id === "string" && active.id.trim() ? active.id : null;
      } catch {
        activePromptConversationId = null;
      }
    }
    return activePromptAgentId;
  }

  function promptStateForActiveConversation(agentId) {
    const state = promptStates.get(agentId);
    if (!state || !activePromptConversationId) return undefined;
    const conversationId = state.conversationId || state.lastTurn?.conversationId;
    return conversationId === activePromptConversationId ? state : undefined;
  }

  function handleAgentSelectionClick(event) {
    const row = event.target?.closest?.(".sand-agent-item[data-agent-id]");
    if (!(row instanceof Element)) return;
    activePromptAgentId = row.getAttribute("data-agent-id") || null;
    activePromptConversationId = null;
    ensureStop(cachedSendAction);
    // Trocar de bot não pode misturar estados: cada bot mantém o seu próprio
    // estado confirmado e a sua própria consulta de recuperação.
    promptRecoverySignature = "";
    ensureRetryActions();
    schedulePromptStatus(0);
    schedulePromptRecovery(0);
    scheduleSettingsScan(0);
    setLocalTimeout(() => refreshActivePromptAgent()
      .then(() => window.dispatchEvent(new Event("openbot:memory-ui-rescan")))
      .catch(() => undefined), 0);
  }
  function updateStopAnchor(send) {
    if (!send?.isConnected) return;
    const rect = send.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    stopAnchorRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  function updateStopAnchorFromComposer(composer) {
    if (!composer?.isConnected) return;
    const shell = composer.closest?.(".sand-prompt-shell") || composer;
    const rect = shell.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const size = 30;
    const inset = shell === composer ? 0 : 9;
    stopAnchorRect = { left: rect.right - inset - size, top: rect.bottom - inset - size, width: size, height: size };
  }

  // ── Estado real da execução ────────────────────────────────────────────────
  // Cada etapa abaixo só é exibida quando o backend confirma o acontecimento
  // correspondente. Polling, heartbeat e a atualização deste contador NÃO
  // provam progresso; a ausência de eventos nunca é tratada como travamento.
  const EXECUTION_PHASE_LABELS = {
    "preparing": "Preparando mensagem e contexto",
    "awaiting-slot": "Aguardando vaga para chamar o provedor",
    "awaiting-provider": "Aguardando resposta do provedor",
    "receiving": "Recebendo resposta",
    "tool": "Executando ferramenta",
  };
  const ACTIVITY_LABELS = {
    "provider-request": "requisição",
    "provider-stream": "resposta",
    "tool": "ferramenta",
    "reasoning": "raciocínio",
  };
  const TURN_TERMINAL_LABELS = { success: "Resposta concluída.", partial: "Resposta parcial — a tarefa não foi concluída.", aborted: "Turno interrompido.", error: "Falha confirmada." };
  const TURN_STALE_AFTER_MS = 20000;
  let turnStatusTicker = 0;

  function formatElapsed(milliseconds) {
    const total = Math.max(0, Math.round(milliseconds / 1000));
    if (total < 60) return `${total}s`;
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  }

  function describeTurnStatus(agentId, state, now) {
    if (!agentId) return "";
    if (unknownAgentIds.has(agentId)) return "Conexão indisponível — o estado pode estar desatualizado.";
    if (state === undefined) return "";
    if (busyAgentIds.has(agentId)) {
      if (cancellingAgentIds.has(agentId)) return "Cancelamento solicitado — aguardando confirmação do término.";
      const execution = state?.execution;
      if (!execution || typeof execution.phase !== "string") {
        return `Preparando mensagem e contexto${state?.queued?.length ? ` · ${state.queued.length} na fila` : ""}`;
      }
      const phase = EXECUTION_PHASE_LABELS[execution.phase] || "Executando";
      const parts = [execution.phase === "tool" && execution.toolName ? `${phase}: ${execution.toolName}` : phase];
      if (typeof execution.startedAtMs === "number" && now >= execution.startedAtMs) parts.push(formatElapsed(now - execution.startedAtMs));
      const activityAt = typeof execution.lastActivityAtMs === "number" ? execution.lastActivityAtMs : execution.startedAtMs;
      if (typeof activityAt === "number" && now >= activityAt) {
        const idle = now - activityAt;
        parts.push(idle >= TURN_STALE_AFTER_MS
          ? `sem atualização há ${formatElapsed(idle)}`
          : `atividade: ${ACTIVITY_LABELS[execution.lastActivity] || "recebida"} há ${formatElapsed(idle)}`);
      }
      if (state?.queued?.length) parts.push(`${state.queued.length} na fila`);
      return parts.join(" · ");
    }
    const last = state?.lastTurn;
    return typeof last?.outcome === "string" && TURN_TERMINAL_LABELS[last.outcome] ? TURN_TERMINAL_LABELS[last.outcome] : "";
  }

  // O indicador nativo de atividade é a superfície única enquanto está visível:
  // etapa, tempo e última atividade real entram NELE, sem uma segunda linha.
  function nativeActivityRow() {
    return [...document.querySelectorAll('[data-row-key="sand-typing-indicator"]')].find((element) =>
      element instanceof Element && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().height > 0) || null;
  }

  /**
   * Acomoda o detalhe real no rótulo nativo. Devolve true quando o indicador
   * nativo está presente e a linha local não deve ser usada.
   */
  function integrateNativeActivityDetail(description) {
    const row = nativeActivityRow();
    if (!row) {
      clearNativeActivityDetail();
      return false;
    }
    const label = row.querySelector(".sand-activity-label__text") || row;
    let detail = label.querySelector(":scope > [data-openbot-activity-detail]");
    if (!detail) {
      detail = document.createElement("span");
      detail.className = "ob-activity-detail";
      detail.setAttribute("data-openbot-activity-detail", "1");
      label.append(detail);
    }
    detail.textContent = description ? ` · ${description}` : "";
    return true;
  }

  function clearNativeActivityDetail() {
    for (const detail of document.querySelectorAll("[data-openbot-activity-detail]")) detail.remove();
  }

  function syncTurnStatusTicker(active) {
    if (active && !turnStatusTicker) {
      turnStatusTicker = window.setInterval(() => {
        if (localUiClosed) return;
        ensureStop(document.querySelector('[data-openbot-send="1"]'));
      }, 1000);
      localTimers.add(turnStatusTicker);
    } else if (!active && turnStatusTicker) {
      clearLocalTimeout(turnStatusTicker);
      turnStatusTicker = 0;
    }
  }

  function ensureStop(send) {
    syncGenerating();
    let liveAction = [send, cachedSendAction].find((element) => element instanceof HTMLElement && element.id !== STOP_ID && element.closest(".sand-prompt-shell") && isVisibleElement(element));
    if (!liveAction) {
      liveAction = [...document.querySelectorAll(".sand-prompt-send")]
        .find((element) => element instanceof HTMLElement && element.id !== STOP_ID && isVisibleElement(element));
    }
    if (liveAction) cachedSendAction = liveAction;
    let fallbackComposer = cachedComposer?.isConnected && isVisibleElement(cachedComposer) ? cachedComposer : null;
    if (!fallbackComposer) {
      let widest = 0;
      for (const element of document.querySelectorAll("textarea, [contenteditable='true'], .sand-prompt-field")) {
        if (!isVisibleElement(element)) continue;
        const width = element.getBoundingClientRect().width;
        if (width > widest) {
          widest = width;
          fallbackComposer = element;
        }
      }
      cachedComposer = fallbackComposer;
    }
    if (liveAction) updateStopAnchor(liveAction);
    else if (fallbackComposer) {
      updateStopAnchorFromComposer(fallbackComposer);
    }
    let button = document.getElementById(STOP_ID);
    if (!button) {
      button = document.createElement("button");
      button.id = STOP_ID;
      button.type = "button";
      button.textContent = "Parar";
      button.setAttribute("aria-label", "Parar geração");
      button.title = "Parar geração";
      button.hidden = true;
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        const agentId = await refreshActivePromptAgent();
        const current = promptStateForActiveConversation(agentId);
        try {
          if (!agentId || !current?.turnId || !current?.conversationId) throw new Error("Turno da geração indisponível");
          promptStatusRevision += 1;
          cancellingAgentIds.add(agentId);
          ensureStop(cachedSendAction);
          const result = await desktop()?.agent?.cancelPrompt?.({ agentId, conversationId: current.conversationId, turnId: current.turnId, scope: "current" });
          if (!result?.cancelled) throw new Error("Nenhuma geração foi cancelada");
          busyAgentIds.add(agentId);
          if (optimisticAgentId === agentId) optimisticGeneration = false;
        } catch {
          cancellingAgentIds.delete(agentId);
          unknownAgentIds.add(agentId);
          button.textContent = "Tentar parar";
          button.setAttribute("aria-label", "Tentar parar a geração");
          button.title = "Tentar parar a geração";
        } finally {
          ensureStop(cachedSendAction);
          schedulePromptStatus(0);
        }
      });
      document.body.appendChild(button);
    }
    if (stopAnchorRect) {
      const size = Math.max(28, Math.min(36, Math.round(Math.min(stopAnchorRect.width, stopAnchorRect.height))));
      button.style.left = `${Math.round(stopAnchorRect.left - size - 8)}px`;
      button.style.top = `${Math.round(stopAnchorRect.top + (stopAnchorRect.height - size) / 2)}px`;
      button.style.width = `${size}px`;
      button.style.height = `${size}px`;
    }
    button.dataset.openbotActiveAgent = activePromptAgentId ?? "";
    button.dataset.openbotBusyAgents = [...busyAgentIds].join(",");
    button.dataset.openbotOptimistic = optimisticGeneration ? "1" : "0";
    const rawState = promptStates.get(activePromptAgentId);
    const currentState = promptStateForActiveConversation(activePromptAgentId);
    const shouldHide = !busyAgentIds.has(activePromptAgentId) || !stopAnchorRect || !currentState?.turnId;
    button.hidden = shouldHide;
    button.disabled = cancellingAgentIds.has(activePromptAgentId) || !currentState?.canCancel;
    button.textContent = unknownAgentIds.has(activePromptAgentId) ? "Tentar parar" : "Parar";
    button.setAttribute("aria-label", cancellingAgentIds.has(activePromptAgentId) ? "Cancelamento solicitado" : `${button.textContent} geração`);
    button.title = button.getAttribute("aria-label");
    let status = document.getElementById("openbot-turn-status");
    if (!status) {
      status = document.createElement("span");
      status.id = "openbot-turn-status";
      status.setAttribute("role", "status");
      status.hidden = true;
    }
    const description = describeTurnStatus(activePromptAgentId, currentState, Date.now());
    const integrated = integrateNativeActivityDetail(description);
    status.textContent = integrated ? "" : description;
    // Só há linha a atualizar enquanto o turno está vivo; o término confirmado
    // é um estado estável e não mantém contador rodando.
    syncTurnStatusTicker(description !== "" && (busyAgentIds.has(activePromptAgentId) || unknownAgentIds.has(activePromptAgentId)));
    const dock = (liveAction || fallbackComposer)?.closest(".sand-chat-input-dock");
    if (dock && status.parentElement !== dock) dock.prepend(status);
    status.hidden = !status.textContent;
    renderPromptQueue(dock, activePromptAgentId, rawState);
  }

  async function openQueueRecovery(agentId, item, trigger) {
    const api = desktop()?.agent;
    if (!api?.getQueuedPrompt || !api?.reviseQueuedPrompt) throw new Error("Controles de recuperação indisponíveis nesta versão do aplicativo.");
    const original = await api.getQueuedPrompt({ agentId, conversationId: item.conversationId, clientNonce: item.clientNonce });
    if (localUiClosed || selectedAgentRow()?.getAttribute("data-agent-id") !== agentId) throw new Error("O bot selecionado mudou.");
    if (document.getElementById("openbot-queue-recovery")) return;
    const dialog = document.createElement("dialog");
    dialog.id = "openbot-queue-recovery";
    dialog.setAttribute("aria-labelledby", "openbot-queue-recovery-title");
    dialog.innerHTML = '<h2 id="openbot-queue-recovery-title">Revisar mensagem não enviada</h2><p class="ob-recovery-help"></p><label>Mensagem<textarea rows="7" aria-label="Mensagem recuperada"></textarea></label><div class="ob-recovery-files"></div><p class="ob-recovery-status" role="status" aria-live="polite"></p><div class="ob-recovery-controls"><label>Adicionar anexos<input type="file" multiple aria-label="Adicionar anexos à mensagem recuperada"></label><button type="button" data-recovery="close">Fechar</button><button type="button" data-recovery="send">Enviar revisão</button></div>';
    dialog.querySelector(".ob-recovery-help").textContent = `Conversa: ${item.conversationTitle || item.conversationId}. Revise o texto e remova ou substitua anexos indisponíveis. A mensagem só será executada ao confirmar o envio.`;
    const editor = dialog.querySelector("textarea"); editor.value = original.prompt;
    const files = dialog.querySelector(".ob-recovery-files");
    const upload = dialog.querySelector("input[type=file]");
    const status = dialog.querySelector(".ob-recovery-status");
    const submit = dialog.querySelector('[data-recovery="send"]');
    const close = dialog.querySelector('[data-recovery="close"]');
    const attachments = (original.attachments || []).map(attachment => ({ ...attachment }));
    const stagedIds = [];
    let busy = false;
    let attempted = false;
    let accepted = false;
    let request = null;
    let requestSignature = "";
    const setBusy = value => {
      busy = value;
      for (const control of dialog.querySelectorAll("button,input,textarea")) control.disabled = value;
      dialog.setAttribute("aria-busy", String(value));
    };
    const renderAttachments = () => {
      files.replaceChildren();
      attachments.forEach((attachment, index) => {
        const row = document.createElement("div"); row.className = "ob-recovery-file";
        const name = document.createElement("span"); name.textContent = attachment.name || "Anexo";
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Remover"; remove.disabled = busy;
        remove.setAttribute("aria-label", `Remover anexo ${attachment.name || index + 1}`);
        remove.addEventListener("click", () => { attachments.splice(index, 1); renderAttachments(); });
        row.append(name, remove); files.append(row);
      });
    };
    upload.addEventListener("change", async () => {
      if (busy) return;
      const selected = [...(upload.files || [])]; upload.value = "";
      if (!selected.length) return;
      if (attachments.length + selected.length > 16) { status.textContent = "Use no máximo 16 anexos."; return; }
      if (selected.some(file => file.size > 2 * 1024 * 1024)) { status.textContent = "Cada anexo deve ter no máximo 2 MiB; arquivos de texto têm limite de 256 KiB."; return; }
      setBusy(true); status.textContent = "Preparando anexos…";
      try {
        const bridge = desktop()?.p23;
        if (!bridge?.stageAttachmentBytes) throw new Error("Envio de anexos indisponível.");
        for (const file of selected) {
          if (!dialog.isConnected) break;
          const result = await bridge.stageAttachmentBytes(agentId, file.name, new Uint8Array(await file.arrayBuffer()));
          if (typeof result?.attachmentId !== "string" || !result.attachmentId) throw new Error("O anexo não foi confirmado.");
          stagedIds.push(result.attachmentId);
          if (!dialog.isConnected) { await bridge.discardStagedAttachment(agentId, result.attachmentId); continue; }
          attachments.push({ path: `attachment:${result.attachmentId}`, name: result.name || file.name });
        }
        status.textContent = "Anexos preparados.";
      } catch (error) { status.textContent = userFacingError(error, "Não foi possível preparar o anexo."); }
      finally { setBusy(false); renderAttachments(); }
    });
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
    submit.addEventListener("click", async () => {
      if (busy || (!editor.value.trim() && !attachments.length)) return;
      const payload = { agentId, conversationId: item.conversationId, prompt: editor.value, attachments: attachments.map(attachment => ({ ...attachment })),
        ...(original.replyContext ? { replyContext: original.replyContext } : {}),
        ...(original.richText && editor.value === original.prompt ? { richText: original.richText } : {}) };
      const signature = JSON.stringify(payload);
      if (!request || signature !== requestSignature) {
        requestSignature = signature;
        request = { ...payload, originalNonce: item.clientNonce, clientNonce: window.crypto.randomUUID() };
      }
      setBusy(true); attempted = true; status.textContent = "Confirmando envio…";
      try {
        const result = await api.reviseQueuedPrompt(request);
        if (!result?.accepted) throw new Error("O envio ainda não foi confirmado.");
        accepted = true;
        busyAgentIds.add(agentId);
        queueActionErrors.delete(JSON.stringify([agentId, item.conversationId, item.clientNonce]));
        dialog.close();
      } catch (error) {
        status.textContent = `${userFacingError(error, "Não foi possível confirmar o envio.")} O texto foi mantido. Repetir sem editar verifica o mesmo pedido.`;
      } finally { setBusy(false); schedulePromptStatus(0); }
    });
    const pageHide = () => dialog.close();
    dialog.addEventListener("close", () => {
      window.removeEventListener("pagehide", pageHide);
      dialog.remove();
      // Unknown acceptance keeps staged files until reconciliation/expiry, never deletes a live send.
      if (!attempted || accepted) for (const id of stagedIds) Promise.resolve(desktop()?.p23?.discardStagedAttachment?.(agentId, id)).catch(() => undefined);
      const focus = trigger?.isConnected ? trigger : document.querySelector('[aria-label="Prompt"]');
      focus?.focus({ preventScroll: true });
    }, { once: true });
    window.addEventListener("pagehide", pageHide, { once: true });
    document.body.append(dialog); renderAttachments(); dialog.showModal(); editor.focus({ preventScroll: true });
  }

  const queueActionErrors = new Map();

  function renderPromptQueue(dock, agentId, state) {
    if (!dock) return;
    let list = document.getElementById("openbot-prompt-queue");
    if (!list) { list = document.createElement("div"); list.id = "openbot-prompt-queue"; list.setAttribute("aria-label", "Mensagens na fila e pendências de revisão"); }
    if (list.parentElement !== dock) dock.prepend(list);
    const items = state?.queued || [];
    const recoverable = state?.recoverable || [];
    for (const send of dock.querySelectorAll('.sand-prompt-send[aria-label="Send message"]')) send.title = state?.isBusy ? "Adicionar à fila" : "Enviar mensagem";
    const signature = JSON.stringify([agentId, items, recoverable, state?.recoverableTruncated]);
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature;
    list.replaceChildren();
    const appendRow = (item, index, recovery) => {
      const key = JSON.stringify([agentId, item.conversationId, item.clientNonce]);
      const row = document.createElement("div"); row.className = "ob-queued-row"; row.dataset.nonce = item.clientNonce;
      const info = document.createElement("div"); info.className = "ob-queued-info";
      const copy = document.createElement("div"); copy.className = "ob-queued-copy";
      copy.textContent = `${recovery ? (item.canReview ? "Não enviada" : "Interrompida") : index + 1}. ${item.preview || "Mensagem com anexo"}`; copy.title = copy.textContent;
      const origin = document.createElement("div"); origin.className = "ob-queued-origin"; origin.textContent = item.conversationTitle || item.conversationId; origin.title = origin.textContent;
      const error = document.createElement("div"); error.className = "ob-queued-error"; error.setAttribute("role", "alert"); error.textContent = queueActionErrors.get(key) || ""; error.hidden = !error.textContent;
      const showError = message => {
        queueActionErrors.set(key, message);
        while (queueActionErrors.size > 128) queueActionErrors.delete(queueActionErrors.keys().next().value);
        error.textContent = message; error.hidden = false;
      };
      info.append(copy, origin); row.append(info);
      if (recovery && item.canReview) {
        const review = document.createElement("button"); review.type = "button"; review.textContent = "Revisar";
        review.addEventListener("click", async () => {
          review.disabled = true;
          try { await openQueueRecovery(agentId, item, review); }
          catch (failure) { showError(userFacingError(failure, "Não foi possível abrir a revisão.")); }
          finally { review.disabled = false; }
        });
        row.append(review);
      } else if (recovery) {
        const hint = document.createElement("span"); hint.textContent = "Confira os resultados no histórico."; hint.className = "ob-queued-origin"; info.append(hint);
      }
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", recovery ? "Dispensar pendência de revisão" : `Remover mensagem ${index + 1} da fila`);
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          const result = await desktop()?.agent?.cancelPrompt?.({ scope: "queued", agentId, conversationId: item.conversationId, clientNonce: item.clientNonce });
          if (!result?.cancelled) throw new Error("Remoção não confirmada.");
          queueActionErrors.delete(key);
        } catch { remove.disabled = false; showError("Não foi possível remover esta mensagem. Tente novamente."); }
        schedulePromptStatus(0);
      });
      row.append(remove, error); list.append(row);
    };
    items.forEach((item, index) => appendRow(item, index, false));
    recoverable.forEach((item, index) => appendRow(item, index, true));
    if (state?.recoverableTruncated) {
      const more = document.createElement("p"); more.textContent = "Mostrando as primeiras 100 pendências. Resolva ou dispense estas para exibir as demais."; list.append(more);
    }
  }

  function schedulePromptStatus(delay = 250) {
    if (localUiClosed) return;
    clearLocalTimeout(promptStatusTimer);
    promptStatusTimer = setLocalTimeout(async () => {
      promptStatusTimer = 0;
      const revision = promptStatusRevision;
      try {
        const activeAgentId = await refreshActivePromptAgent();
        const candidates = new Set(busyAgentIds);
        if (activeAgentId) candidates.add(activeAgentId);
        const snapshot = await desktop()?.agent?.getPromptStatus?.({ agentIds: [...candidates] });
        if (revision !== promptStatusRevision) return schedulePromptStatus(0);
        // Older gateways remain usable during an upgrade; current gateways return one snapshot.
        const statuses = Array.isArray(snapshot?.agents)
          ? snapshot.agents.map(status => ({ status: "fulfilled", value: { agentId: status.agentId, status } }))
          : await Promise.allSettled([...new Set([...candidates, ...(snapshot?.isBusy && snapshot.agentId ? [snapshot.agentId] : [])])]
              .map(async (agentId) => ({ agentId, status: await desktop()?.agent?.getPromptStatus?.({ agentId }) })));
        if (revision !== promptStatusRevision) return schedulePromptStatus(0);
        for (const outcome of statuses) {
          if (outcome.status !== "fulfilled") continue;
          const { agentId, status } = outcome.value;
          if (typeof status?.isBusy !== "boolean") throw new Error("Estado da execução indisponível");
          unknownAgentIds.delete(agentId);
          promptStates.set(agentId, status);
          if (status.isBusy) {
            busyAgentIds.add(agentId);
            if (status.cancelRequested) cancellingAgentIds.add(agentId);
            else cancellingAgentIds.delete(agentId);
          } else {
            busyAgentIds.delete(agentId);
            cancellingAgentIds.delete(agentId);
          }
        }
        if (statuses.some((outcome) => outcome.status === "rejected")) throw new Error("Estado da execução indisponível");
        promptStatusFailures = 0;
        if (activeAgentId && busyAgentIds.has(activeAgentId)) optimisticGeneration = false;
        else if (optimisticGeneration && Date.now() - lastSendAt > 5000) {
          optimisticGeneration = false;
          lastSendAt = 0;
        }
      } catch {
        if (revision !== promptStatusRevision) return schedulePromptStatus(0);
        promptStatusFailures += 1;
        for (const agentId of busyAgentIds) unknownAgentIds.add(agentId);
        if (optimisticGeneration && optimisticAgentId) unknownAgentIds.add(optimisticAgentId);
      }
      syncGenerating();
      ensureStop(document.querySelector('[data-openbot-send="1"]'));
      if (!localUiClosed && (optimisticGeneration || busyAgentIds.size > 0)) schedulePromptStatus(Math.min(8000, 1000 * (2 ** promptStatusFailures)));
    }, delay);
  }

  // ── Recuperação determinada pelo backend ───────────────────────────────────
  // Nenhuma ação é deduzida do texto exibido. O backend responde, por
  // identificadores reais, quais ações são possíveis para a falha atual; a
  // revalidação acontece de novo no clique. Sem esse contrato, ou sem
  // confirmação, o fallback é conservador: nenhuma ação automática.
  const RECOVERY_RETRY = "retry";
  const RECOVERY_INSPECT = "inspect";
  const RECOVERY_INSPECT_HINT = "Este turno já executou ferramentas ou foi interrompido durante uma operação. Confira os resultados e possíveis efeitos no histórico e envie uma nova instrução para continuar.";
  const RECOVERY_ROW_ATTR = "data-openbot-recovery-signature";
  const RECOVERY_HIGHLIGHT_ATTR = "data-openbot-recovery-highlight";
  let promptRecoveryTimer = 0;
  let promptRecoverySignature = "";
  const promptRecovery = new Map();
  const promptRecoveryTokens = new Map();

  function currentAgentId() {
    return activePromptAgentId || selectedAgentRow()?.getAttribute("data-agent-id") || null;
  }

  function failureRowEntryId(row) {
    return row?.getAttribute("data-entry-id") || row?.getAttribute("data-row-key") || "";
  }

  function recoveryRows() {
    return [...document.querySelectorAll('.sand-transcript-row[role="note"]')]
      .filter((row) => row instanceof Element && !row.closest(`#${ROOT_ID}, #${EMPTY_ID}`));
  }

  function recoveryHostFor(row) {
    const next = row.nextElementSibling;
    return next instanceof Element && next.hasAttribute("data-openbot-recovery") ? next : null;
  }

  function schedulePromptRecovery(delay = 200) {
    if (localUiClosed) return;
    clearLocalTimeout(promptRecoveryTimer);
    promptRecoveryTimer = setLocalTimeout(() => {
      promptRecoveryTimer = 0;
      const agentId = currentAgentId();
      if (!agentId) return;
      // Assinatura barata: só a mudança real do transcript (incluindo o avanço
      // da conversa) dispara uma nova consulta autoritativa.
      const signature = JSON.stringify([agentId, document.querySelectorAll(".sand-transcript-row").length, recoveryRows().map(failureRowEntryId)]);
      if (signature === promptRecoverySignature) return;
      promptRecoverySignature = signature;
      void refreshPromptRecovery(agentId);
    }, delay);
  }

  async function refreshPromptRecovery(agentId) {
    const api = desktop()?.agent;
    if (typeof api?.getPromptRecovery !== "function" || typeof api?.getActiveConversation !== "function") {
      promptRecovery.delete(agentId);
      ensureRetryActions();
      return;
    }
    const token = (promptRecoveryTokens.get(agentId) || 0) + 1;
    promptRecoveryTokens.set(agentId, token);
    try {
      const active = await api.getActiveConversation({ agentId });
      const conversationId = typeof active?.id === "string" && active.id.trim() ? active.id : "";
      if (!conversationId) throw new Error("Conversa indisponível");
      const result = await api.getPromptRecovery({ agentId, conversationId });
      if (promptRecoveryTokens.get(agentId) !== token) return;
      const failure = result?.failure;
      const entryId = typeof failure?.entryId === "string" ? failure.entryId : "";
      const actions = Array.isArray(failure?.actions) ? failure.actions.filter((action) => action === RECOVERY_RETRY || action === RECOVERY_INSPECT) : [];
      const historyEntryIds = Array.isArray(failure?.historyEntryIds)
        ? failure.historyEntryIds.filter((id) => typeof id === "string" && id.length > 0)
        : [];
      promptRecovery.set(agentId, entryId && actions.length ? { entryId, actions, historyEntryIds } : null);
    } catch {
      if (promptRecoveryTokens.get(agentId) !== token) return;
      promptRecovery.set(agentId, null);
    }
    ensureRetryActions();
  }

  function ensureRetryActions() {
    if (localUiClosed) return;
    const agentId = currentAgentId();
    const confirmed = agentId ? promptRecovery.get(agentId) || null : null;
    for (const row of recoveryRows()) {
      const entryId = failureRowEntryId(row);
      const actions = confirmed && entryId && entryId === confirmed.entryId ? confirmed.actions : [];
      const signature = actions.join("+");
      if ((row.getAttribute(RECOVERY_ROW_ATTR) || "") === signature) continue;
      recoveryHostFor(row)?.remove();
      if (!signature) {
        row.removeAttribute(RECOVERY_ROW_ATTR);
        continue;
      }
      row.setAttribute(RECOVERY_ROW_ATTR, signature);
      const host = actions.includes(RECOVERY_RETRY) ? createRetryAction(row, entryId) : createInspectAction(row, confirmed?.historyEntryIds ?? []);
      row.insertAdjacentElement("afterend", host);
    }
    // Uma linha que perdeu o papel de aviso deixaria a ação órfã.
    for (const host of document.querySelectorAll("[data-openbot-recovery]")) {
      const previous = host.previousElementSibling;
      if (!(previous instanceof Element) || previous.getAttribute("role") !== "note") host.remove();
    }
  }

  function createInspectAction(row, historyEntryIds) {
    const inspect = document.createElement("button");
    inspect.type = "button";
    inspect.className = "ob-recovery-inspect";
    inspect.setAttribute("data-openbot-recovery", RECOVERY_INSPECT);
    inspect.textContent = "Conferir resultados e possíveis efeitos";
    inspect.setAttribute("aria-label", "Destacar os resultados e possíveis efeitos deste turno sem reenviar o pedido");
    inspect.title = "Destaca o histórico relevante. Nada é reenviado.";
    let report = null;
    inspect.addEventListener("click", () => {
      const located = revealFailureContext(historyEntryIds);
      if (!report) {
        report = document.createElement("p");
        report.className = "ob-recovery-note";
        report.setAttribute("role", "status");
        report.setAttribute("aria-live", "polite");
        inspect.insertAdjacentElement("afterend", report);
      }
      report.textContent = located > 0
        ? `${RECOVERY_INSPECT_HINT} Histórico deste turno destacado (${located} linha${located === 1 ? "" : "s"}).`
        : `${RECOVERY_INSPECT_HINT} Os resultados deste turno não estão visíveis nesta conversa.`;
      document.querySelector('main.sand-chat [contenteditable="true"], main.sand-chat textarea')?.focus?.({ preventScroll: false });
    });
    return inspect;
  }

  /**
   * Localiza o histórico do turno por IDENTIDADE — os identificadores reais das
   * entries informados pelo backend — nunca pela posição das linhas visíveis.
   * Somente apresentação: nada é reenviado e nenhuma operação é executada.
   */
  function revealFailureContext(historyEntryIds) {
    const wanted = new Set(Array.isArray(historyEntryIds) ? historyEntryIds.filter((id) => typeof id === "string" && id.length > 0) : []);
    if (wanted.size === 0) return 0;
    const rows = [...document.querySelectorAll(".sand-transcript-row")].filter((element) => {
      const key = failureRowEntryId(element);
      return key.length > 0 && wanted.has(key);
    });
    if (rows.length === 0) return 0;
    for (const element of rows) element.setAttribute(RECOVERY_HIGHLIGHT_ATTR, "1");
    // Rola somente quando o trecho relevante está fora da vista: mover a
    // leitura de quem já está olhando o histórico não ajudaria.
    const first = rows[0];
    const container = first.closest(".sand-virtual-transcript");
    const firstRect = first.getBoundingClientRect();
    const viewRect = (container ?? document.documentElement).getBoundingClientRect();
    if (firstRect.top < viewRect.top || firstRect.bottom > viewRect.bottom) first.scrollIntoView?.({ block: "nearest" });
    return rows.length;
  }

  function createRetryAction(row, entryId) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "ob-retry-generation";
    retry.setAttribute("data-openbot-recovery", RECOVERY_RETRY);
    retry.textContent = "Tentar novamente";
    retry.setAttribute("aria-label", "Tentar gerar a resposta novamente");
    let report = null;
    const reportError = (message) => {
      if (!report) {
        report = document.createElement("p");
        report.className = "ob-recovery-inspect";
        report.setAttribute("role", "status");
        report.setAttribute("aria-live", "polite");
        retry.insertAdjacentElement("afterend", report);
      }
      report.textContent = message;
    };
    retry.addEventListener("click", async () => {
      if (retry.disabled) return;
      const hadFocus = document.activeElement === retry;
      retry.disabled = true;
      retry.textContent = "Tentando…";
      try {
        const expectedFailureEntryId = failureRowEntryId(row);
        const agentId = await refreshActivePromptAgent();
        if (!agentId) throw new Error("Bot da tentativa indisponível");
        if (!expectedFailureEntryId) throw new Error("Não foi possível identificar a falha. Reabra a conversa.");
        const active = await desktop()?.agent?.getActiveConversation?.({ agentId });
        const conversationId = typeof active?.id === "string" && active.id.trim() ? active.id : undefined;
        if (!conversationId) throw new Error("Não foi possível confirmar a conversa. Tente novamente.");
        if (!row.isConnected || selectedAgentRow()?.getAttribute("data-agent-id") !== agentId || failureRowEntryId(row) !== expectedFailureEntryId) {
          throw new Error("A conversa mudou. Use a ação da conversa atual.");
        }
        const result = await desktop()?.agent?.retryPrompt?.({
          agentId, conversationId, expectedFailureEntryId,
        });
        if (!result?.accepted) throw new Error("A nova tentativa não foi aceita.");
        busyAgentIds.add(agentId);
        optimisticGeneration = false;
        lastSendAt = Date.now();
        syncGenerating();
        ensureStop(document.querySelector('[data-openbot-send="1"]'));
        schedulePromptStatus();
        retry.textContent = "Tentativa iniciada";
      } catch (error) {
        retry.disabled = false;
        retry.textContent = "Tentar novamente";
        reportError(userFacingError(error, "Não foi possível tentar novamente."));
        // A recusa e a rejeição de uma ação antiga vêm do backend: reconsulta
        // as ações reais em vez de interpretar a mensagem de erro.
        schedulePromptRecovery(0);
        if (hadFocus && retry.isConnected && document.activeElement === document.body) {
          retry.focus({ preventScroll: true });
        }
      }
    });
    return retry;
  }

  function handlePromptSubmit(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const send = target.closest(".sand-prompt-send");
    // Voice input is unavailable, including when React reuses the send control.
    if (send && /^(Start voice input|Stop dictation)$/.test(send.getAttribute("aria-label") || "")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const keyboard = event.type === "keydown" && event.key === "Enter" && !event.shiftKey && !event.isComposing
      && target.matches("[contenteditable='true'][aria-label='Prompt'], textarea[aria-label='Prompt']")
      && (target.value || target.textContent || "").trim();
    const click = event.type === "click" && send && !send.disabled && send.getAttribute("aria-label") === "Send message";
    if (!keyboard && !click) return;
    if (click) lastSubmitAction = send;
    promptStatusRevision += 1;
    activePromptAgentId = selectedAgentRow()?.getAttribute("data-agent-id") || null;
    optimisticAgentId = activePromptAgentId;
    optimisticConversationId = activePromptConversationId;
    optimisticNonce = null;
    optimisticGeneration = true;
    lastSendAt = Date.now();
    ensureStop(send);
    schedulePromptStatus(0);
  }

  function handlePromptDelivery(state) {
    if (localUiClosed || typeof state?.agentId !== "string" || typeof state.nonce !== "string") return;
    if (state.phase === "sending") {
      if (optimisticGeneration && optimisticAgentId === state.agentId) optimisticNonce = state.nonce;
      return;
    }
    if (state.phase !== "accepted") return;
    promptStatusRevision += 1;
    if (optimisticAgentId === state.agentId && optimisticNonce === state.nonce) optimisticGeneration = false;
    // Acceptance is not completion. Check status after this acknowledgement,
    // including when an entire fast turn happened between status polls.
    busyAgentIds.add(state.agentId);
    unknownAgentIds.delete(state.agentId);
    ensureStop(cachedSendAction);
    schedulePromptStatus(0);
  }

  function watchComposer() {
    const controls = [...document.querySelectorAll(".sand-prompt-shell button, .sand-prompt-shell [role='button']")];
    const send = controls.find((el) => /^Send message$/i.test(el.getAttribute("aria-label") || "") || /^Send message$/i.test(textOf(el)));
    const anchor = send ?? controls.find((el) => /^(Stop|Cancel|Parar)( generation| geração)?$/i.test(el.getAttribute("aria-label") || textOf(el)));
    const composer = [...document.querySelectorAll("textarea, [contenteditable='true'], .sand-prompt-field")].find((element) => {
      if (element.getAttribute("aria-label") !== "Prompt" && !element.classList.contains("sand-prompt-field")) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    cachedSendAction = send ?? anchor ?? cachedSendAction;
    cachedComposer = composer ?? cachedComposer;
    if (anchor) updateStopAnchor(anchor);
    else updateStopAnchorFromComposer(composer);
    if (send) send.dataset.openbotSend = "1";
    ensureStop(anchor);
    ensureRetryActions();
    schedulePromptRecovery();
    if (promptStatusTimer === 0) schedulePromptStatus(50);
  }

  let missingMount = 0;
  let settingsOpenGraceUntil = 0;
  function hideSandRestoreWall() {
    let found = false;
    for (const alert of document.querySelectorAll('[role="alert"]')) {
      if (!(alert.textContent || "").includes("Couldn't Restore Your Session")) continue;
      found = true;
      let wall = alert;
      while (wall.parentElement && wall.parentElement !== document.body && wall.parentElement.id !== "root") {
        wall = wall.parentElement;
      }
      if (wall.getAttribute("data-openbot-sand-restore-wall") === "1") continue;
      wall.setAttribute("data-openbot-sand-restore-wall", "1");
      wall.setAttribute("hidden", "");
      wall.setAttribute("aria-hidden", "true");
    }
    return found;
  }

  function recoverCrash() {
    const banner = [...document.querySelectorAll("button")].find((el) => /^Reload$/i.test(textOf(el)));
    if (!banner) return;
    const around = textOf(banner.parentElement || banner);
    if (!/something went wrong/i.test(around) && !/unexpected error/i.test(document.body.innerText || "")) return;
    let already = "1";
    try { already = sessionStorage.getItem("openbot-autoreload") || ""; } catch { already = "1"; }
    if (already === "1") return;
    try { sessionStorage.setItem("openbot-autoreload", "1"); } catch { return; }
    banner.click();
  }

  function classifyTranscriptRows() {
    classifyTranscriptRowSet(document.querySelectorAll(".sand-transcript-row"));
  }

  function classifyTranscriptRowSet(rows) {
    const name = String(profileState?.name || "").trim();
    for (const row of rows) {
      const role = row.getAttribute("data-role");
      let side = role === "user" || role === "assistant" ? role : "";
      const labelledBy = row.getAttribute("aria-labelledby") || "";
      if (!side && labelledBy.includes("entry-user")) side = "user";
      if (!side && labelledBy.includes("entry-assistant")) side = "assistant";
      if (!side) {
        const nestedRole = row.querySelector(".sand-message[data-role]")?.getAttribute("data-role");
        if (nestedRole === "user" || nestedRole === "assistant") side = nestedRole;
      }
      if (!side && name) {
        const firstLine = (row.innerText || "").trim().split(/\r?\n/, 1)[0].trim();
        if (firstLine === name) side = "user";
      }
      if (side && row.getAttribute("data-openbot-side") !== side) row.setAttribute("data-openbot-side", side);
    }
  }

  const messageAvatarSources = new WeakMap();
  function reconcileAssistantMessageAvatars() {
    reconcileMessageAvatarSet(document.querySelectorAll(".sand-transcript-row"));
  }

  function reconcileMessageAvatarSet(rows) {
    const selected = selectedAgentRow();
    const source = selected?.querySelector(".sand-agent-item__avatar-disc .sand-agent-avatar");
    const agentId = selected?.getAttribute("data-agent-id") || "";
    const sourceFg = source instanceof HTMLElement ? source.style.getPropertyValue("--fg") : "";
    for (const row of rows) {
      const existing = row.querySelector(":scope > .sand-row-content > .openbot-message-avatar");
      if (row.getAttribute("data-openbot-side") !== "assistant") {
        existing?.remove();
        continue;
      }
      const content = row.querySelector(":scope > .sand-row-content");
      if (!(content instanceof HTMLElement) || !(source instanceof HTMLElement)) continue;
      if (existing instanceof HTMLElement && existing.dataset.agentId === agentId && messageAvatarSources.get(existing) === source) {
        if (existing.style.getPropertyValue("--openbot-message-avatar-fg") !== sourceFg)
          existing.style.setProperty("--openbot-message-avatar-fg", sourceFg);
        continue;
      }
      existing?.remove();
      const avatar = document.createElement("span");
      avatar.className = "openbot-message-avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.dataset.agentId = agentId;
      avatar.style.setProperty("--openbot-message-avatar-fg", sourceFg);
      avatar.append(source.cloneNode(true));
      messageAvatarSources.set(avatar, source);
      content.prepend(avatar);
    }
  }

  const pendingTranscriptRows = new Set();
  let transcriptReconcileFrame = 0;
  let transcriptReconcileAll = false;
  let transcriptAvatarSource = null;
  let transcriptAppearanceKey = "";

  function queueTranscriptReconciliation(mutations) {
    const selected = selectedAgentRow();
    const source = selected?.querySelector(".sand-agent-item__avatar-disc .sand-agent-avatar");
    const appearance = JSON.stringify([selected?.getAttribute("data-agent-id"), profileState?.name, source?.style.getPropertyValue("--fg")]);
    if (source !== transcriptAvatarSource || appearance !== transcriptAppearanceKey) {
      transcriptReconcileAll = true;
      transcriptAvatarSource = source;
      transcriptAppearanceKey = appearance;
    }
    const collect = node => {
      const element = node instanceof Element ? node : node?.parentElement;
      if (!(element instanceof Element) || element.closest(".openbot-message-avatar")) return;
      const row = element.closest(".sand-transcript-row");
      if (row) pendingTranscriptRows.add(row);
      else for (const child of element.querySelectorAll(".sand-transcript-row")) pendingTranscriptRows.add(child);
    };
    for (const mutation of mutations) {
      // Streaming text changes neither author classification nor avatar identity.
      if (mutation.type === "characterData") continue;
      if (mutation.type === "attributes") collect(mutation.target);
      else for (const node of mutation.addedNodes) collect(node);
    }
    if (transcriptReconcileFrame || (!transcriptReconcileAll && !pendingTranscriptRows.size)) return;
    transcriptReconcileFrame = window.requestAnimationFrame(() => {
      transcriptReconcileFrame = 0;
      if (localUiClosed) return;
      const rows = transcriptReconcileAll ? [...document.querySelectorAll(".sand-transcript-row")]
        : [...pendingTranscriptRows].filter(row => row.isConnected);
      transcriptReconcileAll = false;
      pendingTranscriptRows.clear();
      classifyTranscriptRowSet(rows);
      reconcileMessageAvatarSet(rows);
      schedulePromptRecovery();
    });
  }

  function reconcileConfirmedDeliveries() {
    const rows = [...document.querySelectorAll(".sand-transcript-row")]
      .sort((left, right) => Number(left.dataset.index || 0) - Number(right.dataset.index || 0));
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.getAttribute("data-failed") !== "true" || row.getAttribute("data-role") !== "user") continue;
      let confirmed = false;
      for (const next of rows.slice(index + 1)) {
        const side = next.getAttribute("data-role") || next.getAttribute("data-openbot-side") || "";
        const key = next.getAttribute("data-row-key") || "";
        if (side === "user") break;
        if (side === "assistant" || key.startsWith("assistant:") || next.querySelector(".sand-message[data-role='assistant']")) {
          confirmed = true;
          break;
        }
      }
      if (confirmed) {
        row.dataset.openbotDeliveryConfirmed = "1";
        row.querySelector(".sand-failed-send-actions")?.setAttribute("aria-hidden", "true");
      } else {
        delete row.dataset.openbotDeliveryConfirmed;
        row.querySelector(".sand-failed-send-actions")?.removeAttribute("aria-hidden");
      }
      const actions = row.querySelector(".sand-failed-send-actions");
      if (actions) replaceExactText(actions, new Map([
        ["Failed to send", "Falha no envio"],
        ["Resend", "Reenviar"],
        ["Delete", "Excluir"],
      ]));
    }
  }

  function optimizeTimezoneListbox() {
    const listbox = document.querySelector("[role='listbox'][aria-label='Timezone'],[role='listbox'][aria-label='Fuso horário']");
    if (!(listbox instanceof HTMLElement) || listbox.dataset.openbotTimezoneOptimized === "1") return;
    const allOptions = [...listbox.querySelectorAll(":scope > [role='option']")];
    if (allOptions.length <= 80) return;
    listbox.dataset.openbotTimezoneOptimized = "1";
    listbox.setAttribute("aria-label", "Fuso horário");
    if (!listbox.id) listbox.id = "openbot-timezone-listbox";
    const filter = document.createElement("div");
    filter.id = "openbot-timezone-filter";
    filter.innerHTML = `<input type="search" autocomplete="off" spellcheck="false" placeholder="Buscar fuso horário" aria-label="Buscar fuso horário" aria-controls="${listbox.id}"><span role="status" aria-live="polite"></span>`;
    listbox.parentElement?.insertBefore(filter, listbox);
    const input = filter.querySelector("input");
    const status = filter.querySelector("[role='status']");
    const entries = allOptions.map((node) => ({ node, label: textOf(node).toLocaleLowerCase("pt-BR") }));
    const render = () => {
      const query = (input?.value || "").trim().toLocaleLowerCase("pt-BR");
      const matches = query ? entries.filter((entry) => entry.label.includes(query)) : entries;
      const selected = entries.find((entry) => entry.node.getAttribute("aria-selected") === "true");
      const visible = matches.slice(0, 60);
      if (!query && selected && !visible.includes(selected)) {
        visible.unshift(selected);
        visible.length = 60;
      }
      const fragment = document.createDocumentFragment();
      visible.forEach((entry, index) => {
        entry.node.setAttribute("aria-posinset", String(index + 1));
        entry.node.setAttribute("aria-setsize", String(matches.length));
        fragment.appendChild(entry.node);
      });
      listbox.replaceChildren(fragment);
      status.textContent = matches.length > visible.length
        ? `${visible.length} de ${matches.length} fusos · continue digitando`
        : `${matches.length} ${matches.length === 1 ? "fuso" : "fusos"}`;
    };
    const focusOption = (delta) => {
      const visible = [...listbox.querySelectorAll(":scope > [role='option']")];
      if (!visible.length) return;
      const current = visible.indexOf(document.activeElement);
      visible[Math.max(0, Math.min(visible.length - 1, current + delta))]?.focus({ preventScroll: true });
    };
    input?.addEventListener("input", render);
    input?.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      listbox.querySelector(":scope > [role='option']")?.focus({ preventScroll: true });
    });
    listbox.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      focusOption(event.key === "ArrowDown" ? 1 : -1);
    }, true);
    render();
    input?.focus({ preventScroll: true });
  }

  function scan() {
    ensureStyle();
    classifyTranscriptRows();
    reconcileAssistantMessageAvatars();
    reconcileConfirmedDeliveries();
    void checkEmptyAgentState();
    sanitizeLegacyAuth();
    sanitizeComposerCopy();
    renderDraftPersistence();
    polishNativeOnboarding();
    polishSidebarCopy();
    polishNativeDeleteConfirmation();
    polishNativeBotActions();
    polishNativeLanguage();
    optimizeTimezoneListbox();
    polishLocalFeatureCopy();
    removeUnavailableNavigation();
    ensureLocalProfileLoaded();
    renderLocalProfile();
    applyProfileName();
    hideChrome();
    const restoredWallHidden = hideSandRestoreWall();
    recoverCrash();
    watchComposer();
    ensureConversationDetailsVisible();
    const globalMount = findGlobalSettingsMount();
    const mount = globalMount || findAgentSettingsMount() || findExpandedConversationDetailsMount();
    if (mount) {
      missingMount = 0;
      settingsOpenGraceUntil = 0;
      document.getElementById(EMPTY_ID)?.remove();
      renderSettings(mount, globalMount ? "global" : "agent");
    } else if (document.getElementById(ROOT_ID)?.isConnected && modalLayerOpen()) {
      // The pane is only aria-hidden behind an open menu or dialog; keep the section.
      scheduleSettingsScan(400);
    } else {
      missingMount += 1;
      if (missingMount > 1 && Date.now() >= settingsOpenGraceUntil) closeEmptyConversationDetails();
      if (missingMount > 4) {
        document.getElementById(ROOT_ID)?.remove();
      } else {
        scheduleSettingsScan(120);
      }
      if (restoredWallHidden || missingMount > 4) void checkEmptyAgentState();
    }
    reconcileAgentAvatars();
    if (!localUiReadyMarked && document.getElementById("root")?.childElementCount > 0) {
      localUiReadyMarked = true;
      window.performance?.mark?.("openbot:local-ui-ready");
    }
  }

  function scheduleSettingsScan(delay = 80) {
    clearLocalTimeout(scanTimer);
    scanTimer = setLocalTimeout(() => {
      scanTimer = 0;
      scan();
    }, delay);
  }

  function handleSettingsButtonClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const settingsButton = target.closest('[aria-label="View agent settings"]');
    if (!settingsButton) return;
    if (settingsButton.getAttribute("aria-expanded") !== "true") {
      const panelId = settingsButton.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      const details = panel?.matches("#sand-conversation-details") ? panel : panel?.closest("#sand-conversation-details");
      if (details instanceof HTMLElement) delete details.dataset.openbotLegacyScreen;
    }
    missingMount = 0;
    settingsOpenGraceUntil = settingsButton.getAttribute("aria-expanded") === "true" ? 0 : Date.now() + 1500;
    const retryToken = ++settingsRetryToken;
    // The first attempt runs in the next frame, after React commits the pane
    // and before it is painted; the later ones only cover slow native mounts.
    const delays = [0, 90, 220, 420, 760, 1200];
    const run = (index) => {
      if (retryToken !== settingsRetryToken || localUiClosed) return;
      ensureConversationDetailsVisible();
      const mount = findAgentSettingsMount() || findExpandedConversationDetailsMount();
      if (mount) {
        renderSettings(mount);
        return;
      }
      if (index > 0) scan();
      if (index + 1 < delays.length) setLocalTimeout(() => run(index + 1), delays[index + 1] - delays[index]);
    };
    window.requestAnimationFrame(() => run(0));
  }

  // Direct mounts for the observer: a settings surface that just appeared gets
  // its OpenBot section in the same frame, without waiting for the debounced scan.
  function mountAgentSettingsNow() {
    if (localUiClosed) return;
    // The native pane host is the mount the label search resolves to (the last
    // visible settings surface); using it directly avoids walking every text
    // node while the pane is opening.
    const native = [...document.querySelectorAll(".sand-agent-settings")]
      .filter((host) => host instanceof HTMLElement && host.querySelector("input, textarea") && isVisibleElement(host))
      .at(-1);
    const mount = native || findAgentSettingsMount() || findExpandedConversationDetailsMount();
    if (!mount) return;
    missingMount = 0;
    settingsOpenGraceUntil = 0;
    renderSettings(mount);
    ensureConversationDetailsVisible();
  }

  function mountGlobalSettingsNow() {
    if (localUiClosed) return;
    hideUnavailableAutoReview();
    removeUnavailableNavigation();
    polishNativeLanguage();
    const mount = findGlobalSettingsMount();
    if (mount) renderSettings(mount, "global");
  }

  function handleNativePortalTriggerClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const control = target.closest("button,[role='button'],[role='menuitem']");
    if (!control) return;
    const aria = (control.getAttribute("aria-label") || "").trim();
    const label = firstVisibleLine(control);
    if (/^(?:Open account menu|Abrir menu da conta|Timezone|Fuso horário)$/i.test(aria) || /^(?:Settings|Configurações|About|Sobre|Move to|Mover para)$/i.test(label)) {
      scheduleSettingsScan(120);
    }
  }

  function handleAgentContextMenu(event) {
    if (event.target instanceof Element && event.target.closest(".sand-agent-item")) scheduleSettingsScan(250);
  }

  let scanTimer = 0;
  let settingsRetryToken = 0;
  let observedRoot = null;
  const observedPortals = new WeakSet();
  const SETTINGS_SCAN_SELECTOR = ".sand-onboarding__meet,.sand-info-pane,.sand-prompt-field,.sand-agent-item,.sand-command-palette,.sand-about-dialog,[class*='computer'],[class*='screen'],[role='dialog'],[role='menu'],[role='listbox'][aria-label='Timezone'],textarea,[contenteditable='true'],[aria-label='View agent settings'],[aria-label^='Open account menu']";
  const SETTINGS_NAV_LABEL = /^(General|Updates|Help Center|Send Feedback)$/i;
  function mutationNeedsSettingsScan(node) {
    const element = node instanceof Element ? node : node?.parentElement;
    if (!(element instanceof Element)) return false;
    if (element.matches(SETTINGS_SCAN_SELECTOR) || element.querySelector(SETTINGS_SCAN_SELECTOR)) return true;
    return [...element.querySelectorAll("button,[role='button']")]
      .some((control) => SETTINGS_NAV_LABEL.test((control.textContent || "").trim()));
  }
  const observer = new MutationObserver((mutations) => {
    let localFeatureAdded = false;
    let avatarChanged = false;
    let settingsScanNeeded = false;
    let accountMenuAdded = false;
    let messageMenuAdded = false;
    let agentSettingsAdded = false;
    let globalSettingsAdded = false;
    let commandSurfaceChanged = false;
    let memorySlotChanged = false;
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        if (mutation.target instanceof Element && mutation.target.closest(".obp23-dialog")) localFeatureAdded = true;
        for (const node of mutation.addedNodes) {
          const element = node instanceof Element ? node : node.parentElement;
          if (element?.closest('[role="menu"][aria-label="More message actions"], [role="menu"][aria-label="Message actions"]') || element?.querySelector('[role="menu"][aria-label="More message actions"], [role="menu"][aria-label="Message actions"]')) messageMenuAdded = true;
          if (element?.closest('[role="menu"][aria-label="Account"], [role="menu"][aria-label="Conta"]') || element?.querySelector('[role="menu"][aria-label="Account"]')) accountMenuAdded = true;
          if (element instanceof Element) {
            if (!agentSettingsAdded && (element.matches(".sand-agent-settings") || element.querySelector(".sand-agent-settings"))) agentSettingsAdded = true;
            if (!globalSettingsAdded && (element.id === "sand-settings-panel-general" || element.querySelector("#sand-settings-panel-general"))) globalSettingsAdded = true;
            if (!commandSurfaceChanged && (element.closest(".sand-workflow-listbox,.sand-command-palette,[role='tooltip']") || element.querySelector(".sand-workflow-listbox,.sand-command-palette,[role='tooltip']"))) commandSurfaceChanged = true;
            if (!memorySlotChanged && element.closest("#openbot-memory-slot")) memorySlotChanged = true;
          }
          collectMotionTargets(node);
          if (node instanceof Element) {
            if (!promptStatusTimer && (node.matches(".sand-activity-label__text") || node.querySelector(".sand-activity-label__text"))) schedulePromptStatus(0);
            if (node.matches("[data-placeholder], [aria-placeholder], [placeholder]")) sanitizePlaceholderCopy(node);
            for (const field of node.querySelectorAll("[data-placeholder], [aria-placeholder], [placeholder]")) sanitizePlaceholderCopy(field);
          }
          if (!settingsScanNeeded && mutationNeedsSettingsScan(node)) settingsScanNeeded = true;
          if (node instanceof Element && (node.matches(".obp23-dialog") || node.querySelector(".obp23-dialog"))) localFeatureAdded = true;
          if (mutation.target === document.body) observePortalRoot(node);
          if (node instanceof Element && (node.matches("svg[data-state]") || node.querySelector("svg[data-state]"))) avatarChanged = true;
        }
        continue;
      }
      const target = mutation.target;
      if (!(target instanceof Element)) continue;
      if (mutationNeedsSettingsScan(target)) settingsScanNeeded = true;
      const hidden = target.hidden || target.getAttribute("aria-hidden") === "true";
      if (mutation.attributeName === "data-state" && target.matches("svg[data-state]")) avatarChanged = true;
      if (hidden) {
        elementAnimations.get(target)?.cancel();
        animatedElements.delete(target);
      } else {
        collectMotionTargets(target);
      }
    }
    // Mutation observers run before paint; do not defer menu localization to
    // the settings scan, which otherwise exposes the native English labels.
    if (messageMenuAdded) hideChrome();
    if (accountMenuAdded) {
      hideChrome();
      polishNativeLanguage();
    }
    if (commandSurfaceChanged) {
      polishCommandPalette();
      polishTooltips();
    }
    if (globalSettingsAdded) mountGlobalSettingsNow();
    if (agentSettingsAdded) mountAgentSettingsNow();
    if (memorySlotChanged) settleMemorySlot();
    if (localFeatureAdded) polishLocalFeatureCopy();
    if (avatarChanged) reconcileAgentAvatars();
    queueTranscriptReconciliation(mutations);
    bindObserver();
    if (settingsScanNeeded && !scanTimer) scheduleSettingsScan(120);
  });

  function observePortalRoot(node) {
    if (!(node instanceof Element) || observedPortals.has(node) || node.id === "root" || node.id === WELCOME_ID || node.id === STOP_ID) return;
    observedPortals.add(node);
    observer.observe(node, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "aria-hidden", "aria-expanded", "data-state", "data-placeholder", "data-role", "data-activity", "data-exiting", "data-typing", "data-active", "aria-current", "aria-labelledby"] });
  }

  function bindObserver() {
    const nextRoot = document.getElementById("root");
    const nextBody = document.body;
    const nextKey = nextRoot || nextBody || document.documentElement;
    if (observedRoot === nextKey) return;
    observer.disconnect();
    observedRoot = nextKey;
    if (nextRoot) {
      observer.observe(nextRoot, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "aria-hidden", "aria-expanded", "data-state", "data-placeholder", "data-role", "data-activity", "data-exiting", "data-typing", "data-active", "aria-current", "aria-labelledby"] });
      if (nextBody && nextBody !== nextRoot) {
        observer.observe(nextBody, { childList: true });
        for (const child of nextBody.children) observePortalRoot(child);
      }
    } else {
      observer.observe(nextKey, { childList: true });
    }
  }

  function handleWindowResize() {
    const active = document.activeElement;
    const localSettingsOpen = document.getElementById(ROOT_ID)?.dataset.scope === "agent";
    if (window.innerWidth <= 820 && active instanceof HTMLElement && active.closest(".sand-info-pane")) {
      active.blur();
      setLocalTimeout(() => {
        ensureConversationDetailsVisible();
        if (localSettingsOpen && active.isConnected) {
          active.focus?.({ preventScroll: true });
          return;
        }
        const composer = [...document.querySelectorAll("textarea, [contenteditable='true'], .sand-prompt-field")]
          .find((element) => isVisibleElement(element) && (element.getAttribute("aria-label") === "Prompt" || element.classList.contains("sand-prompt-field")));
        composer?.focus?.({ preventScroll: true });
      }, 0);
    }
    for (const delay of [0, 80, 220]) setLocalTimeout(ensureConversationDetailsVisible, delay);
    ensureStop(document.querySelector('[data-openbot-send="1"]'));
  }

  function releaseFocusBeforeDetailsClose(event) {
    const control = event.target?.closest?.('button[aria-label="Close details"], button[aria-label="Fechar detalhes"]');
    if (!control) return;
    const pane = control.closest(".sand-info-pane");
    const details = control.closest("#sand-conversation-details");
    const active = document.activeElement;
    if (pane && active instanceof HTMLElement && pane.contains(active)) active.blur();
    settingsRetryToken += 1;
    settingsOpenGraceUntil = 0;
    if (details instanceof HTMLElement) {
      clearForcedConversationDetailsState(details);
      details.setAttribute("data-openbot-hide", "1");
    }
    const localSettings = document.getElementById(ROOT_ID);
    if (localSettings?.dataset.scope === "agent") localSettings.remove();
  }

  function cleanupLocalUi() {
    if (localUiClosed) return;
    localUiClosed = true;
    unsubscribeDraftStatus?.();
    unsubscribePromptDelivery?.();
    observer.disconnect();
    if (transcriptReconcileFrame) window.cancelAnimationFrame(transcriptReconcileFrame);
    transcriptReconcileFrame = 0;
    pendingTranscriptRows.clear();
    observedRoot = null;
    document.removeEventListener("click", blockLegacyAuthClick, true);
    document.removeEventListener("click", blockUnavailableNavigation, true);
    document.removeEventListener("click", handleSidebarNewClick, true);
    document.removeEventListener("click", handleAgentSelectionClick, true);
    document.removeEventListener("click", handlePromptSubmit, true);
    document.removeEventListener("keydown", handlePromptSubmit, true);
    document.removeEventListener("click", handleSettingsButtonClick, true);
    document.removeEventListener("click", handleNativePortalTriggerClick, true);
    document.removeEventListener("contextmenu", handleAgentContextMenu, true);
    document.removeEventListener("pointerdown", handleAgentContextMenu, true);
    document.removeEventListener("click", handleLocalAccountClick, true);
    document.removeEventListener("click", handleFooterProfileClick, true);
    document.removeEventListener("click", releaseFocusBeforeDetailsClose, true);
    document.removeEventListener("keydown", trapLocalModalFocus, true);
    document.removeEventListener("keydown", blockHiddenCommandActivation, true);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("resize", handleWindowResize);
    window.removeEventListener("blur", handleVisibilityChange);
    window.removeEventListener("focus", handleVisibilityChange);
    window.removeEventListener("pointerdown", markFirstInteraction, true);
    window.removeEventListener("keydown", markFirstInteraction, true);
    for (const timer of [...localTimers]) clearLocalTimeout(timer);
    if (motionFrame) window.cancelAnimationFrame(motionFrame);
    motionFrame = 0;
    pendingMotion.clear();
    for (const animation of [...activeAnimations]) animation.cancel();
    activeAnimations.clear();
    for (const svg of document.querySelectorAll('svg[data-openbot-avatar-paused="1"]')) {
      for (const element of [svg, ...svg.querySelectorAll("*")]) element.style.animationPlayState = "";
      try { svg.unpauseAnimations?.(); } catch {}
      delete svg.dataset.openbotAvatarPaused;
    }
    if (window.__openbotLocalSettingsScan === scan) delete window.__openbotLocalSettingsScan;
  }

  function handleDomReady() {
    window.performance?.mark?.("openbot:dom-ready");
    const persistence = desktop()?.clientPersistence;
    unsubscribePromptDelivery = desktop()?.agent?.onPromptDelivery?.(handlePromptDelivery);
    unsubscribeDraftStatus = persistence?.onDraftStatus?.((state) => {
      draftPersistenceRevision += 1;
      draftPersistenceState = state;
      renderDraftPersistence();
    });
    const revision = draftPersistenceRevision;
    persistence?.getDraftStatus?.().then((state) => {
      if (localUiClosed || revision !== draftPersistenceRevision) return;
      draftPersistenceState = state;
      renderDraftPersistence();
    }).catch(() => undefined);
    scan();
  }

  window.__openbotLocalSettingsScan = scan;
  bindObserver();
  document.addEventListener("click", blockLegacyAuthClick, true);
  document.addEventListener("click", blockUnavailableNavigation, true);
  document.addEventListener("click", handleSidebarNewClick, true);
  document.addEventListener("click", handleAgentSelectionClick, true);
  document.addEventListener("click", handlePromptSubmit, true);
  document.addEventListener("keydown", handlePromptSubmit, true);
  document.addEventListener("click", handleSettingsButtonClick, true);
  document.addEventListener("click", handleNativePortalTriggerClick, true);
  document.addEventListener("contextmenu", handleAgentContextMenu, true);
  document.addEventListener("pointerdown", handleAgentContextMenu, true);
  document.addEventListener("click", handleLocalAccountClick, true);
  document.addEventListener("click", handleFooterProfileClick, true);
  document.addEventListener("click", releaseFocusBeforeDetailsClose, true);
  document.addEventListener("keydown", trapLocalModalFocus, true);
  document.addEventListener("keydown", blockHiddenCommandActivation, true);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("resize", handleWindowResize);
  window.addEventListener("blur", handleVisibilityChange);
  window.addEventListener("focus", handleVisibilityChange);
  window.addEventListener("pointerdown", markFirstInteraction, { once: true, capture: true });
  window.addEventListener("keydown", markFirstInteraction, { once: true, capture: true });
  window.addEventListener("pagehide", cleanupLocalUi, { once: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", handleDomReady, { once: true });
  else handleDomReady();
})();
