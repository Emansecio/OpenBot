(() => {
  // openbot-memory-ui-v13-ordered-task-list
  const STYLE_ID = "openbot-memory-ui-style";
  const MEMORY_SECTION_ID = "openbot-memory-settings";
  const MEMORY_DIALOG_ID = "openbot-memory-dialog";
  const MOTION_EASING = "cubic-bezier(.22,1,.36,1)";
  const DIALOG_PAGE_SIZE = 20;
  const MEMORY_PAGE_LIMIT = 20;
  const STALE_ACTIVE_AGENT_MESSAGE = "Bot ativo mudou; abra novamente.";
  const LOCAL_TIMERS = new Set();
  const ACTIVE_DIALOG_CLASS = "ob-dialog-open";

  let localUiClosed = false;
  let observer = null;
  let scanTimer = 0;
  let scanInFlight = false;
  let scanPending = false;
  let dialogState = null;
  let restoreFocusTimer = 0;
  let toolbarState = {
    agentId: null,
  };
  let agentContext = {
    token: 0,
    generation: 0,
    loading: false,
    loaded: false,
    agentId: null,
    refreshedAtMs: 0,
  };
  let memorySectionState = {
    agentId: null,
    loading: false,
    savingMode: false,
    mode: "automatic",
    status: null,
    error: "",
  };

  const css = `
#${STYLE_ID}-noop{display:none}
#${MEMORY_SECTION_ID} .ob-button,
.ob-dialog .ob-button{min-height:30px;border:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 14%,transparent));border-radius:6px;padding:5px 9px;background:var(--cursor-button-secondary-background,var(--cursor-bg-tertiary,color-mix(in srgb,currentColor 8%,transparent)));color:var(--cursor-button-secondary-foreground,var(--cursor-text-primary,currentColor));font:inherit;font-size:var(--cursor-font-size-base,13px);line-height:1.35;cursor:pointer;touch-action:manipulation;transition:transform var(--cursor-duration-fast,.1s) var(--cursor-easing-default,ease),background-color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease),border-color var(--cursor-duration-normal,.15s) var(--cursor-easing-default,ease)}
#${MEMORY_SECTION_ID} .ob-button:hover,
.ob-dialog .ob-button:hover{border-color:var(--cursor-stroke-primary,color-mix(in srgb,currentColor 22%,transparent));background:var(--cursor-button-secondary-hover-background,var(--cursor-bg-secondary,color-mix(in srgb,currentColor 12%,transparent)))}
#${MEMORY_SECTION_ID} .ob-button:focus-visible,
.ob-dialog .ob-button:focus-visible,
#${MEMORY_SECTION_ID} input:focus-visible,
#${MEMORY_SECTION_ID} textarea:focus-visible,
#${MEMORY_SECTION_ID} select:focus-visible,
.ob-dialog input:focus-visible,
.ob-dialog textarea:focus-visible,
.ob-dialog select:focus-visible,
.ob-dialog summary:focus-visible{outline:2px solid var(--cursor-focus,var(--cursor-base,#f0f0f0));outline-offset:2px;border-color:var(--cursor-focus,var(--cursor-base,#f0f0f0))}
#${MEMORY_SECTION_ID} .ob-button:active,
.ob-dialog .ob-button:active{transform:scale(.96)}
.ob-dialog .ob-button[aria-pressed="true"]{border-color:var(--cursor-stroke-primary,color-mix(in srgb,currentColor 22%,transparent));background:color-mix(in srgb,currentColor 14%,transparent);font-weight:600}
#${MEMORY_SECTION_ID} .ob-button[disabled],
.ob-dialog .ob-button[disabled]{opacity:.55;cursor:default;transform:none}
.ob-dialog .ob-button:is([data-action="rename-save"],[data-action="save-memory"],[data-action="activate"]):not(:disabled){border-color:var(--cursor-text-primary,#f0f0f0);background:var(--cursor-text-primary,#f0f0f0);color:#171717;font-weight:600}
.ob-dialog .ob-button:is([data-action="delete-request"],[data-action="forget-request"]){color:var(--cursor-danger,#e34671)}
.ob-dialog .ob-button:is([data-action="delete-confirm"],[data-action="forget-confirm"]):not(:disabled){border-color:color-mix(in srgb,var(--cursor-danger,#e34671) 52%,transparent);background:color-mix(in srgb,var(--cursor-danger,#e34671) 18%,transparent);color:var(--cursor-danger,#f07a9a);font-weight:600}
#${MEMORY_SECTION_ID}{margin-top:14px;padding-top:14px;border-top:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 12%,transparent));color:var(--cursor-text-primary,currentColor);font:inherit}
#${MEMORY_SECTION_ID} .ob-memory-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
#${MEMORY_SECTION_ID} .ob-memory-title{margin:0;font-size:var(--cursor-font-size-base,13px);font-weight:var(--cursor-font-weight-semibold,600);line-height:1.35}
#${MEMORY_SECTION_ID} .ob-memory-help{margin:2px 0 0;color:var(--cursor-text-tertiary,color-mix(in srgb,currentColor 60%,transparent));font-size:var(--cursor-font-size-sm,12px);line-height:1.45;text-wrap:pretty}
#${MEMORY_SECTION_ID} .ob-memory-modes{display:grid;gap:0;margin-top:8px;border-block:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 10%,transparent))}
#${MEMORY_SECTION_ID} .ob-memory-mode{display:grid;grid-template-columns:16px minmax(0,1fr);align-items:center;gap:9px;min-height:44px;box-sizing:border-box;padding:6px 4px;border:0;border-top:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 8%,transparent));border-radius:0;background:transparent;cursor:pointer;transition:background-color var(--cursor-duration-fast,.1s) var(--cursor-easing-default,ease)}
#${MEMORY_SECTION_ID} .ob-memory-mode:first-child{border-top:0}
#${MEMORY_SECTION_ID} .ob-memory-mode:has(input:checked){background:color-mix(in srgb,currentColor 3%,transparent)}
#${MEMORY_SECTION_ID} .ob-memory-mode:active{background:color-mix(in srgb,currentColor 6%,transparent)}
#${MEMORY_SECTION_ID} .ob-memory-mode>span{min-width:0}
#${MEMORY_SECTION_ID} .ob-memory-mode input[type="radio"]{appearance:none;flex:none;width:16px!important;height:16px!important;min-width:16px!important;min-height:16px!important;max-width:16px!important;max-height:16px!important;margin:0!important;padding:0!important;border:1px solid var(--cursor-stroke-primary,color-mix(in srgb,currentColor 32%,transparent));border-radius:50%!important;background:transparent;box-shadow:none!important;cursor:pointer}
#${MEMORY_SECTION_ID} .ob-memory-mode input[type="radio"]:checked{border-color:var(--cursor-focus,var(--cursor-text-primary,currentColor));background:radial-gradient(circle,var(--cursor-focus,var(--cursor-text-primary,currentColor)) 0 3px,transparent 3.5px)}
#${MEMORY_SECTION_ID} .ob-memory-mode input[type="radio"]:disabled{opacity:.55;cursor:default}
#${MEMORY_SECTION_ID} .ob-memory-mode-label{font-size:var(--cursor-font-size-sm,12px);font-weight:var(--cursor-font-weight-semibold,600);line-height:1.25}
#${MEMORY_SECTION_ID} .ob-memory-mode-copy{overflow:hidden;margin-top:1px;color:var(--cursor-text-tertiary,color-mix(in srgb,currentColor 60%,transparent));font-size:var(--cursor-font-size-xs,11px);line-height:1.3;text-overflow:ellipsis;white-space:nowrap}
@media (hover:hover) and (pointer:fine){#${MEMORY_SECTION_ID} .ob-memory-mode:hover{background:color-mix(in srgb,currentColor 5%,transparent)}}
#${MEMORY_SECTION_ID} .ob-memory-status{min-height:18px;margin-top:10px;color:var(--cursor-text-tertiary,color-mix(in srgb,currentColor 60%,transparent));font-size:var(--cursor-font-size-sm,12px);line-height:1.4}
#${MEMORY_SECTION_ID} .ob-memory-status.is-error,
.ob-dialog .ob-error{color:var(--cursor-danger,#e34671)}
#${MEMORY_SECTION_ID} .ob-memory-status.is-ok,
.ob-dialog .ob-ok{color:var(--cursor-green,#45a557)}
.ob-dialog-backdrop{position:fixed;inset:0;z-index:0;background:rgba(0,0,0,.58);pointer-events:auto}
.ob-dialog{position:fixed;inset:0;z-index:2147483401;display:flex;justify-content:flex-end;pointer-events:none}
.ob-dialog[data-kind="memory"]{justify-content:center;align-items:center;padding:16px}
.ob-dialog .ob-panel{position:relative;z-index:1;pointer-events:auto;display:flex;flex-direction:column;width:min(520px,100vw);max-height:100vh;border-left:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 12%,transparent));background:#202020;color:var(--cursor-text-primary,currentColor);box-shadow:-16px 0 40px rgba(0,0,0,.28)}
.ob-dialog[data-kind="memory"] .ob-panel{box-sizing:border-box;width:min(860px,calc(100vw - 32px));height:min(620px,calc(100vh - 32px));max-height:min(620px,calc(100vh - 32px));border:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 12%,transparent));border-radius:14px;box-shadow:0 26px 70px rgba(0,0,0,.4)}
.ob-dialog[data-kind="memory"] .ob-dialog-head{box-sizing:border-box;min-height:54px;padding:0 14px 0 24px}
.ob-dialog[data-kind="memory"] .ob-dialog-body{padding:24px}
.ob-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px 14px;border-bottom:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 12%,transparent))}
.ob-dialog-title{margin:0;font-size:var(--cursor-font-size-lg,15px);font-weight:var(--cursor-font-weight-semibold,600);line-height:1.35}
.ob-dialog-subtitle{margin:4px 0 0;color:var(--cursor-text-tertiary,color-mix(in srgb,currentColor 60%,transparent));font-size:var(--cursor-font-size-sm,12px);line-height:1.45}
.ob-dialog-body{display:flex;flex:1;flex-direction:column;min-height:0;padding:18px 20px 20px;overflow:auto}
.ob-dialog-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ob-dialog .ob-field,
.ob-dialog textarea,
.ob-dialog select{width:100%;box-sizing:border-box;border:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 12%,transparent));border-radius:6px;background:var(--cursor-bg-editor,var(--cursor-editor,transparent));color:var(--cursor-text-primary,currentColor);padding:6px 9px;font:inherit;line-height:1.45}
.ob-dialog .ob-field::placeholder,
.ob-dialog textarea::placeholder{color:var(--cursor-text-tertiary,color-mix(in srgb,currentColor 58%,transparent))}
.ob-dialog textarea{min-height:96px;resize:vertical}
.ob-dialog .ob-list{display:grid;gap:12px}
.ob-dialog .ob-item{padding:13px;border:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 12%,transparent));border-radius:9px;background:var(--cursor-bg-tertiary,color-mix(in srgb,currentColor 7%,transparent))}
.ob-dialog .ob-item-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.ob-dialog .ob-item-title{margin:0;font-size:var(--cursor-font-size-base,13px);font-weight:var(--cursor-font-weight-semibold,600);line-height:1.4}
.ob-dialog .ob-item-meta{margin-top:4px;color:var(--cursor-text-tertiary,color-mix(in srgb,currentColor 60%,transparent));font-size:var(--cursor-font-size-sm,12px);line-height:1.45}
.ob-dialog .ob-item-copy{margin-top:10px;color:var(--cursor-text-primary,currentColor);font-size:var(--cursor-font-size-base,13px);line-height:1.5;white-space:pre-wrap;word-break:break-word}
.ob-dialog .ob-item-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}
.ob-dialog .ob-item-actions .ob-button{min-height:30px}
.ob-dialog .ob-badge{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:4px 9px;border:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 12%,transparent));border-radius:999px;background:var(--cursor-bg-editor,var(--cursor-editor,transparent));color:var(--cursor-text-secondary,currentColor);font-size:var(--cursor-font-size-sm,12px);line-height:1.2}
.ob-dialog .ob-badge.is-active{color:#111;background:var(--cursor-text-primary,#f0f0f0)}
.ob-dialog .ob-badge.is-danger{color:var(--cursor-danger,#e34671)}
.ob-dialog .ob-split{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr))}
.ob-dialog .ob-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ob-dialog .ob-space{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ob-dialog .ob-empty,.ob-dialog .ob-loading{padding:24px;border:1px dashed var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 16%,transparent));border-radius:9px;color:var(--cursor-text-tertiary,color-mix(in srgb,currentColor 60%,transparent));text-align:center;line-height:1.5}
.ob-dialog .ob-inline-confirm{margin-top:12px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--cursor-danger,#e34671) 30%,transparent);border-radius:var(--cursor-radius-base,8px);background:color-mix(in srgb,var(--cursor-danger,#e34671) 7%,transparent)}
.ob-dialog .ob-inline-confirm-copy{margin:0 0 10px;font-size:var(--cursor-font-size-sm,12px);line-height:1.45}
.ob-dialog .ob-inline-confirm .ob-row{justify-content:flex-end}
.ob-dialog details{border:1px solid var(--cursor-stroke-secondary,color-mix(in srgb,currentColor 12%,transparent));border-radius:var(--cursor-radius-lg,10px);background:var(--cursor-bg-tertiary,color-mix(in srgb,currentColor 6%,transparent))}
.ob-dialog summary{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none;padding:14px 16px}
.ob-dialog summary::-webkit-details-marker{display:none}
.ob-dialog .ob-archive-body{padding:0 14px 14px}
.ob-dialog .ob-pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:16px}
.ob-dialog .ob-status{min-height:18px;margin-top:10px;color:var(--cursor-text-tertiary,color-mix(in srgb,currentColor 60%,transparent));font-size:var(--cursor-font-size-sm,12px);line-height:1.4}
.ob-dialog .ob-close{width:30px;min-width:30px;min-height:30px;border:0;border-radius:6px;padding:0;background:transparent;font-size:20px;line-height:1}
body.${ACTIVE_DIALOG_CLASS}{overflow:hidden}
.ob-dialog.is-closing{opacity:0;transition:opacity 140ms ease;pointer-events:none}
@media (max-width:520px){
  #${MEMORY_SECTION_ID} .ob-memory-head,
  .ob-dialog .ob-space,
  .ob-dialog .ob-item-head{align-items:stretch}
  .ob-dialog .ob-split{grid-template-columns:1fr}
  .ob-dialog{justify-content:stretch}
  .ob-dialog .ob-panel{width:100vw;max-height:100vh}
  .ob-dialog[data-kind="memory"]{padding:0}
  .ob-dialog[data-kind="memory"] .ob-panel{width:100vw;max-height:100vh;border-radius:0}
}
@media (prefers-reduced-motion:reduce){
  #${MEMORY_SECTION_ID} .ob-button,
  .ob-dialog .ob-button,
  .ob-dialog .ob-panel{transition:none}
}
`;

  function desktopAgent() {
    return window.__openbotMemoryUiAgent ?? window.desktop?.agent ?? null;
  }

  function setLocalTimeout(callback, delay) {
    if (localUiClosed) return 0;
    const timer = window.setTimeout(() => {
      LOCAL_TIMERS.delete(timer);
      if (localUiClosed) return;
      return callback();
    }, delay);
    LOCAL_TIMERS.add(timer);
    return timer;
  }

  function clearLocalTimeout(timer) {
    if (!timer) return;
    window.clearTimeout(timer);
    LOCAL_TIMERS.delete(timer);
  }

  function clearLocalTimers() {
    for (const timer of [...LOCAL_TIMERS]) clearLocalTimeout(timer);
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function textOf(node) {
    return (node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function motionReduced() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  }

  function isVisibleElement(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    if (element.closest("[hidden], [aria-hidden='true'], [data-openbot-hide='1']")) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function animatePanel(element) {
    if (!(element instanceof Element) || motionReduced() || typeof element.animate !== "function" || !isVisibleElement(element)) return;
    element.dataset.openbotMotionSurface = "panel";
    element.animate(
      [
        { opacity: 0, transform: "translate3d(0,6px,0) scale(.985)" },
        { opacity: 1, transform: "translate3d(0,0,0) scale(1)" },
      ],
      {
        duration: 220,
        easing: MOTION_EASING,
        fill: "none",
      },
    );
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function queueLocalMicrotask(callback) {
    if (typeof callback !== "function" || localUiClosed) return;
    if (typeof window.queueMicrotask === "function") {
      window.queueMicrotask(() => {
        if (!localUiClosed) callback();
      });
      return;
    }
    Promise.resolve().then(() => {
      if (!localUiClosed) callback();
    }).catch(() => {});
  }

  function scheduleAfterRender(callback) {
    queueLocalMicrotask(() => {
      window.requestAnimationFrame(() => {
        if (!localUiClosed) callback();
      });
    });
  }

  function focusElement(target, { selectText = false } = {}) {
    if (!(target instanceof HTMLElement) || !target.isConnected || !isVisibleElement(target)) return false;
    if ("disabled" in target && target.disabled) return false;
    if (typeof target.focus === "function") target.focus({ preventScroll: true });
    if (selectText && "select" in target && typeof target.select === "function") {
      try { target.select(); } catch {}
    }
    return document.activeElement === target;
  }

  function focusSoon(getTarget, options) {
    const attempt = () => {
      const target = typeof getTarget === "function" ? getTarget() : getTarget;
      return focusElement(target, options);
    };
    if (attempt()) return;
    scheduleAfterRender(() => {
      if (attempt()) return;
      scheduleAfterRender(attempt);
    });
  }

  function renderPendingFocus(root, pendingFocus) {
    if (!pendingFocus || !(root instanceof HTMLElement)) return;
    focusSoon(() => {
      if (!root.isConnected) return null;
      if (typeof pendingFocus.selector === "string" && pendingFocus.selector) {
        const target = root.querySelector(pendingFocus.selector);
        return target instanceof HTMLElement ? target : null;
      }
      if (typeof pendingFocus.resolve === "function") {
        const target = pendingFocus.resolve(root);
        return target instanceof HTMLElement ? target : null;
      }
      return null;
    }, { selectText: pendingFocus.selectText === true });
  }

  function describeBy(...ids) {
    return ids.filter((value) => typeof value === "string" && value.trim()).join(" ");
  }

  function statusMarkup(id, message, className = "ob-status") {
    return `<div id="${id}" class="${className}" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(message || "")}</div>`;
  }

  function alertMarkup(id, message) {
    if (!message) return "";
    return `<div id="${id}" class="ob-error" role="alert" aria-atomic="true">${escapeHtml(message)}</div>`;
  }

  function sanitizeError(error, fallback = "Não foi possível concluir agora.") {
    const message = error instanceof Error ? error.message : String(error || "");
    const trimmed = message.replace(/\s+/g, " ").trim();
    if (!trimmed) return fallback;
    return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
  }

  function formatDateTime(value) {
    if (!Number.isFinite(value)) return "";
    try {
      return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(value));
    } catch {
      return "";
    }
  }

  const MEMORY_MODE_LABELS = Object.freeze({ automatic: "Automática", explicit: "Explícita", off: "Desligada" });
  const MEMORY_KIND_LABELS = Object.freeze({
    identity: "Identidade",
    preference: "Preferência",
    constraint: "Restrição",
    decision: "Decisão",
    fact: "Fato",
    procedure: "Procedimento",
    open_loop: "Pendência",
  });
  const MEMORY_STATUS_LABELS = Object.freeze({ active: "Ativa", superseded: "Substituída", forgotten: "Esquecida", expired: "Expirada" });

  function localizedMemoryValue(labels, value, fallback) {
    const key = typeof value === "string" ? value.trim() : "";
    return key && Object.hasOwn(labels, key) ? labels[key] : key || fallback;
  }

  function memoryModeLabel(value) {
    return localizedMemoryValue(MEMORY_MODE_LABELS, value, "Automática");
  }

  function memoryKindLabel(value) {
    return localizedMemoryValue(MEMORY_KIND_LABELS, value, "Memória");
  }

  function memoryStatusLabel(value) {
    return localizedMemoryValue(MEMORY_STATUS_LABELS, value, "Estado desconhecido");
  }
  function summarizeJobStatus(status) {
    if (!status || typeof status !== "object") return "Status de memória indisponível.";
    const jobs = status.jobs || {};
    const bits = [];
    if (Number.isInteger(jobs.pending) && jobs.pending > 0) bits.push(`${jobs.pending} pendente${jobs.pending > 1 ? "s" : ""}`);
    if (Number.isInteger(jobs.running) && jobs.running > 0) bits.push(`${jobs.running} em execução`);
    if (Number.isInteger(jobs.retry) && jobs.retry > 0) bits.push(`${jobs.retry} em nova tentativa`);
    if (Array.isArray(jobs.dead) && jobs.dead.length > 0) bits.push(`${jobs.dead.length} com falha`);
    const counts = status.counts || {};
    const memories = Number.isInteger(counts.active) ? `${counts.active} memória${counts.active === 1 ? "" : "s"} ativa${counts.active === 1 ? "" : "s"}` : "Memórias ativas indisponíveis";
    return bits.length > 0 ? `${memories}. Processamentos internos: ${bits.join(", ")}.` : `${memories}. Sem processamentos pendentes.`;
  }

  async function getAuthoritativeProviderConfig() {
    const api = desktopAgent();
    if (!api?.getProviderConfig) return null;
    return await api.getProviderConfig();
  }

  function selectedBotId() {
    return document.querySelector('.sand-agent-item[data-layout="expanded"][aria-current="page"]')?.getAttribute("data-agent-id") || null;
  }

  async function refreshAgentContext(force = false) {
    if (!force && agentContext.loaded && Date.now() - agentContext.refreshedAtMs < 500) return agentContext.agentId;
    if (agentContext.loading) return agentContext.agentId;
    agentContext.loading = true;
    const token = agentContext.token + 1;
    agentContext.token = token;
    const previousAgentId = agentContext.agentId;
    const hadLoaded = agentContext.loaded;
    try {
      const config = await getAuthoritativeProviderConfig();
      if (token !== agentContext.token) return agentContext.agentId;
      const nextAgentId = typeof config?.agentId === "string" && config.agentId ? config.agentId : null;
      const changed = hadLoaded && previousAgentId !== nextAgentId;
      agentContext.loaded = true;
      agentContext.agentId = nextAgentId;
      agentContext.refreshedAtMs = Date.now();
      toolbarState.agentId = nextAgentId;
      if (memorySectionState.agentId !== nextAgentId) {
        memorySectionState = {
          agentId: nextAgentId,
          loading: false,
          savingMode: false,
          mode: "automatic",
          status: null,
          error: "",
        };
      }
      if (changed) handleActiveAgentChange(nextAgentId, "");
      return nextAgentId;
    } catch {
      if (token === agentContext.token) {
        agentContext.loaded = true;
        agentContext.agentId = null;
        agentContext.refreshedAtMs = Date.now();
        toolbarState.agentId = null;
      }
      return null;
    } finally {
      if (token === agentContext.token) agentContext.loading = false;
    }
  }

  function createAgentBinding(agentId = toolbarState.agentId) {
    return {
      expectedAgentId: typeof agentId === "string" && agentId ? agentId : null,
      generation: agentContext.generation,
    };
  }

  function isBindingCurrent(binding) {
    return !!binding
      && typeof binding.expectedAgentId === "string"
      && binding.expectedAgentId.length > 0
      && binding.generation === agentContext.generation
      && binding.expectedAgentId === toolbarState.agentId
      && (!selectedBotId() || binding.expectedAgentId === selectedBotId());
  }

  function handleActiveAgentChange(nextAgentId, message = STALE_ACTIVE_AGENT_MESSAGE) {
    agentContext.generation += 1;
    agentContext.agentId = typeof nextAgentId === "string" && nextAgentId ? nextAgentId : null;
    toolbarState.agentId = agentContext.agentId;
    memorySectionState.agentId = agentContext.agentId;
    memorySectionState.loading = false;
    memorySectionState.savingMode = false;
    memorySectionState.status = null;
    memorySectionState.error = "";
    if (dialogState) closeDialog();
  }

  async function ensureCurrentAgentBinding(binding) {
    if (!binding || typeof binding.expectedAgentId !== "string" || !binding.expectedAgentId) {
      throw new Error("Bot ativo indisponível.");
    }
    const config = await getAuthoritativeProviderConfig();
    const activeAgentId = typeof config?.agentId === "string" && config.agentId ? config.agentId : null;
    if (!activeAgentId || !isBindingCurrent(binding) || activeAgentId !== binding.expectedAgentId) {
      handleActiveAgentChange(activeAgentId);
      const error = new Error(STALE_ACTIVE_AGENT_MESSAGE);
      error.code = "stale-active-agent";
      throw error;
    }
    return activeAgentId;
  }

  function findVisibleProviderSettingsRoot() {
    const root = document.getElementById("openbot-provider-settings");
    return root instanceof Element && root.dataset.scope !== "global" && isVisibleElement(root) ? root : null;
  }

  function isMountablePanel(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function findExpandedNativeSettingsRoot() {
    const button = [...document.querySelectorAll('[aria-label="View agent settings"]')]
      .find((candidate) => isVisibleElement(candidate) && candidate.getAttribute("aria-expanded") === "true");
    const panelId = button?.getAttribute("aria-controls") || "";
    const panel = panelId ? document.getElementById(panelId) : null;
    if (!(panel instanceof HTMLElement) || !isMountablePanel(panel)) return null;
    const text = textOf(panel);
    if (!/Name|Nome/i.test(text) || !/Description|Descrição|Descricao/i.test(text) || !/Notifications|Notificações|Notificacoes/i.test(text)) {
      return null;
    }
    return panel;
  }

  function findMemorySectionMountRoot() {
    return findVisibleProviderSettingsRoot() || findExpandedNativeSettingsRoot();
  }

  function closeDialog({ immediate = false, restoreFocus: shouldRestoreFocus = true } = {}) {
    if (!dialogState) return;
    if (dialogState.finishClose) {
      if (immediate) dialogState.finishClose(shouldRestoreFocus);
      return;
    }
    const state = dialogState;
    const { root, restoreFocus, restoreFocusFallback, keydownHandler, backdropHandler, appRoot } = dialogState;
    const resolveRestoreFocus = () => {
      if (dialogState || localUiClosed) return null;
      if (restoreFocus instanceof HTMLElement && restoreFocus.isConnected && isVisibleElement(restoreFocus)) return restoreFocus;
      if (typeof restoreFocusFallback === "function") {
        const fallback = restoreFocusFallback();
        return fallback instanceof HTMLElement ? fallback : null;
      }
      return null;
    };
    let timer = 0;
    state.finishClose = (restore = shouldRestoreFocus) => {
      clearLocalTimeout(timer);
      window.removeEventListener("keydown", keydownHandler, true);
      root.removeEventListener("mousedown", backdropHandler, true);
      root.remove();
      if (dialogState !== state) return;
      dialogState = null;
      document.body.classList.remove(ACTIVE_DIALOG_CLASS);
      if (appRoot instanceof HTMLElement) appRoot.inert = false;
      if (!localUiClosed) scheduleScan(0);
      if (restore && !localUiClosed) restoreFocusTimer = setLocalTimeout(() => {
        restoreFocusTimer = 0;
        focusSoon(resolveRestoreFocus);
      }, 80);
    };
    if (immediate || motionReduced() || localUiClosed) {
      state.finishClose();
      return;
    }
    root.inert = true;
    for (const animation of state.panel.getAnimations()) animation.cancel();
    root.classList.add("is-closing");
    timer = setLocalTimeout(() => state.finishClose(), 140);
  }

  function trapFocus(event, root) {
    if (event.key !== "Tab") return;
    const focusables = [...root.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((node) => isVisibleElement(node));
    if (focusables.length === 0) {
      event.preventDefault();
      root.focus({ preventScroll: true });
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      event.stopImmediatePropagation();
      for (let index = focusables.length - 1; index >= 0; index -= 1) {
        focusables[index].focus({ preventScroll: true });
        if (document.activeElement === focusables[index]) break;
      }
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      event.stopImmediatePropagation();
      for (let index = 0; index < focusables.length; index += 1) {
        focusables[index].focus({ preventScroll: true });
        if (document.activeElement === focusables[index]) break;
      }
    }
  }

  function openDialog(options) {
    clearLocalTimeout(restoreFocusTimer);
    restoreFocusTimer = 0;
    closeDialog({ immediate: true, restoreFocus: false });
    ensureStyle();
    const appRoot = document.getElementById("root");
    if (appRoot instanceof HTMLElement) appRoot.inert = true;
    document.body.classList.add(ACTIVE_DIALOG_CLASS);
    const restoreFocus = options.restoreFocusTarget instanceof HTMLElement
      ? options.restoreFocusTarget
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const root = document.createElement("div");
    root.id = options.id;
    root.className = "ob-dialog";
    root.dataset.kind = options.kind;
    root.setAttribute("lang", "pt-BR");
    root.innerHTML = `
      <div class="ob-dialog-backdrop" aria-hidden="true"></div>
      <section class="ob-panel" role="dialog" aria-modal="true" aria-labelledby="${options.id}-title" tabindex="-1">
        <header class="ob-dialog-head">
          <div>
            <h2 class="ob-dialog-title" id="${options.id}-title">${escapeHtml(options.title)}</h2>
            <p class="ob-dialog-subtitle">${escapeHtml(options.subtitle || "")}</p>
          </div>
          <button type="button" class="ob-button ob-close" data-action="close-dialog" aria-label="Fechar">Fechar</button>
        </header>
        <div class="ob-dialog-body"></div>
      </section>
    `;
    const panel = root.querySelector(".ob-panel");
    const body = root.querySelector(".ob-dialog-body");
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) return;
    document.body.appendChild(root);
    animatePanel(panel);
    const keydownHandler = (event) => {
      if (!dialogState || dialogState.root !== root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeDialog();
        return;
      }
      trapFocus(event, panel);
    };
    const backdropHandler = (event) => {
      if (event.target instanceof Element && event.target.classList.contains("ob-dialog-backdrop")) closeDialog();
    };
    window.addEventListener("keydown", keydownHandler, true);
    root.addEventListener("mousedown", backdropHandler, true);
    root.querySelector('[data-action="close-dialog"]')?.addEventListener("click", closeDialog);
    dialogState = { id: options.id, root, panel, body, appRoot, restoreFocus, restoreFocusFallback: options.restoreFocusFallback, keydownHandler, backdropHandler };
    panel.focus({ preventScroll: true });
    options.mount(body, panel);
  }

  async function loadMemorySection() {
    if (!memorySectionState.agentId || memorySectionState.loading) return;
    memorySectionState.loading = true;
    memorySectionState.error = "";
    const binding = createAgentBinding(memorySectionState.agentId);
    const section = document.getElementById(MEMORY_SECTION_ID);
    const current = () => isBindingCurrent(binding) && section?.isConnected && document.getElementById(MEMORY_SECTION_ID) === section;
    renderMemorySection();
    try {
      const api = desktopAgent();
      const agentId = await ensureCurrentAgentBinding(binding);
      const [settings, status] = await Promise.all([
        api.getMemorySettings({ agentId, expectedAgentId: binding.expectedAgentId }),
        api.getMemoryStatus({ agentId, expectedAgentId: binding.expectedAgentId }),
      ]);
      if (!current()) return;
      memorySectionState.mode = settings?.mode || "automatic";
      memorySectionState.status = status;
    } catch (error) {
      if (!current()) return;
      memorySectionState.error = sanitizeError(error, "Memória indisponível.");
    } finally {
      if (current()) {
        memorySectionState.loading = false;
        renderMemorySection();
      }
    }
  }

  function ensureMemorySection() {
    const settingsRoot = findMemorySectionMountRoot();
    const existing = document.getElementById(MEMORY_SECTION_ID);
    if (!(settingsRoot instanceof Element)) {
      existing?.remove();
      return;
    }
    let root = existing;
    if (!root || root.parentElement !== settingsRoot) {
      root?.remove();
      root = document.createElement("section");
      root.id = MEMORY_SECTION_ID;
      root.setAttribute("lang", "pt-BR");
      settingsRoot.appendChild(root);
      root.addEventListener("change", handleMemoryModeChange);
      root.addEventListener("click", handleMemorySectionClick);
      memorySectionState.loading = false;
      memorySectionState.status = null;
      memorySectionState.error = toolbarState.agentId ? "" : "Não foi possível identificar o bot. Tente novamente.";
    }
    if (memorySectionState.agentId !== toolbarState.agentId) {
      memorySectionState.agentId = toolbarState.agentId;
      memorySectionState.mode = "automatic";
      memorySectionState.status = null;
      memorySectionState.error = "";
      memorySectionState.loading = false;
      memorySectionState.savingMode = false;
    }
    if (!toolbarState.agentId) memorySectionState.error = "Não foi possível identificar o bot. Tente novamente.";
    renderMemorySection();
    if (!memorySectionState.loading && memorySectionState.status == null && !memorySectionState.error) void loadMemorySection();
  }

  function renderMemorySection() {
    const root = document.getElementById(MEMORY_SECTION_ID);
    if (!(root instanceof HTMLElement)) return;
    const statusText = memorySectionState.error || (memorySectionState.savingMode ? "Salvando preferência…" : memorySectionState.loading ? "Carregando memória…" : memorySectionState.status ? summarizeJobStatus(memorySectionState.status) : "Carregando memória…");
    const renderKey = JSON.stringify([memorySectionState.agentId, memorySectionState.mode, memorySectionState.loading, memorySectionState.savingMode, memorySectionState.error, statusText]);
    if (root.dataset.renderKey === renderKey) return;
    let pendingFocus = null;
    if (document.activeElement instanceof HTMLElement && root.contains(document.activeElement)) {
      if (document.activeElement.dataset.action === "open-memory-manager") {
        pendingFocus = { selector: '[data-action="open-memory-manager"]' };
      } else if (document.activeElement instanceof HTMLInputElement && document.activeElement.name === "openbot-memory-mode") {
        pendingFocus = { selector: `input[name="openbot-memory-mode"][value="${escapeHtml(document.activeElement.value)}"]` };
      }
    }
    const statusClass = memorySectionState.error ? "ob-memory-status is-error" : "ob-memory-status";
    const options = [
      { value: "automatic", label: "Automática", copy: "Lembra automaticamente o que for útil." },
      { value: "explicit", label: "Explícita", copy: "Só salva memória quando você pedir." },
      { value: "off", label: "Desligada", copy: "Não salva memória entre conversas." },
    ];
    root.innerHTML = `
      <div class="ob-memory-head">
        <div>
          <h3 class="ob-memory-title">Memória deste bot</h3>
          <p class="ob-memory-help">Escolha como este bot guarda contexto útil entre conversas.</p>
        </div>
        <button type="button" class="ob-button" data-action="open-memory-manager"${!memorySectionState.agentId ? " disabled" : ""}>Gerenciar memória</button>
      </div>
      <div class="ob-memory-modes">
        ${options.map((option) => `
          <label class="ob-memory-mode">
            <input type="radio" name="openbot-memory-mode" value="${option.value}"${memorySectionState.status && memorySectionState.mode === option.value ? " checked" : ""}${memorySectionState.savingMode || memorySectionState.loading || !memorySectionState.status ? " disabled" : ""}>
            <span>
              <div class="ob-memory-mode-label">${option.label}</div>
              <div class="ob-memory-mode-copy">${option.copy}</div>
            </span>
          </label>
        `).join("")}
      </div>
      <div id="${MEMORY_SECTION_ID}-status" class="${statusClass}" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(statusText)}</div>
      ${memorySectionState.error ? '<button type="button" class="ob-button" data-action="retry-memory-section">Tentar novamente</button>' : ""}
    `;
    root.dataset.renderKey = renderKey;
    renderPendingFocus(root, pendingFocus);
  }

  async function handleMemoryModeChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.name !== "openbot-memory-mode") return;
    if (memorySectionState.savingMode || memorySectionState.loading || !memorySectionState.status) return;
    const nextMode = target.value;
    if (!["automatic", "explicit", "off"].includes(nextMode)) return;
    const previousMode = memorySectionState.mode;
    memorySectionState.savingMode = true;
    memorySectionState.error = "";
    const binding = createAgentBinding(memorySectionState.agentId);
    const section = document.getElementById(MEMORY_SECTION_ID);
    const current = () => isBindingCurrent(binding) && section?.isConnected && document.getElementById(MEMORY_SECTION_ID) === section;
    renderMemorySection();
    try {
      const agentId = await ensureCurrentAgentBinding(binding);
      const updated = await desktopAgent().setMemorySettings({ mode: nextMode, agentId, expectedAgentId: binding.expectedAgentId });
      if (!current()) return;
      if (updated?.mode !== nextMode) throw new Error("A persistência não confirmou a preferência enviada.");
      memorySectionState.mode = updated.mode;
    } catch (error) {
      if (!current()) return;
      memorySectionState.mode = previousMode;
      memorySectionState.error = sanitizeError(error, "Não foi possível salvar o modo de memória.");
    } finally {
      if (current()) {
        memorySectionState.savingMode = false;
        renderMemorySection();
      }
    }
  }

  function handleMemorySectionClick(event) {
    const action = event.target instanceof Element ? event.target.closest("[data-action]")?.dataset.action : null;
    if (action === "retry-memory-section") {
      void refreshAgentContext(true).then(() => loadMemorySection());
    }
    if (action === "open-memory-manager") {
      const opener = event.target instanceof Element ? event.target.closest("[data-action='open-memory-manager']") : null;
      void openMemoryDialog(opener instanceof HTMLElement ? opener : null);
    }
  }

  async function openMemoryDialog(opener = null) {
    await refreshAgentContext();
    if (!toolbarState.agentId) throw new Error("Bot ativo indisponível.");
    const binding = createAgentBinding();
    const state = {
      binding,
      scope: "agent",
      loading: true,
      error: "",
      alert: "",
      items: [],
      query: "",
      page: 1,
      editingId: null,
      editText: "",
      editImportance: 50,
      pendingMemoryId: null,
      confirmForgetId: null,
      status: null,
      pendingFocus: null,
      nextCursor: null,
      pageCursors: [null],
      loadToken: 0,
      searchTimer: 0,
      notice: "",
    };
    openDialog({
      id: MEMORY_DIALOG_ID,
      kind: "memory",
      title: "Memórias do bot",
      subtitle: "Revise, ajuste ou esqueça o que este bot guardou.",
      restoreFocusTarget: opener,
      restoreFocusFallback: () => document.querySelector(`#${MEMORY_SECTION_ID} [data-action="open-memory-manager"]`),
      mount(body) {
        const current = () => body.isConnected && isBindingCurrent(state.binding);
        const scopeSubtitle = (scope) => scope === "user"
          ? "Perfil compartilhado por todos os bots: quem você é e como prefere ser atendido. Não define a tarefa de cada bot."
          : "Revise, ajuste ou esqueça o que este bot guardou.";
        const emptyStateCopy = (scope) => scope === "user"
          ? "Nenhuma memória no perfil compartilhado ainda. Os bots adicionam identidade e preferências suas automaticamente, ou peça: \"lembre que…\"."
          : "Nenhuma memória corresponde ao filtro atual.";
        const render = () => {
          if (!current()) return;
          const activeEditor = body.querySelector('textarea[data-role="memory-text"]');
          const editorSelection = activeEditor instanceof HTMLTextAreaElement && document.activeElement === activeEditor
            ? [activeEditor.selectionStart, activeEditor.selectionEnd, activeEditor.selectionDirection] : null;
          const activeSearch = body.querySelector('input[type="search"]');
          const searchSelection = activeSearch instanceof HTMLInputElement && document.activeElement === activeSearch
            ? [activeSearch.selectionStart, activeSearch.selectionEnd, activeSearch.selectionDirection]
            : null;
          const visibleItems = state.items;
          const statusId = `${MEMORY_DIALOG_ID}-status`;
          const alertId = `${MEMORY_DIALOG_ID}-alert`;
          const asyncMessage = state.loading ? "Carregando memórias…" : state.pendingMemoryId ? "Atualizando memória…" : state.error || state.notice || (state.status ? summarizeJobStatus(state.status) : "");
          const statusClass = state.error ? "ob-status ob-error" : "ob-status";
          const subtitle = document.querySelector(`#${MEMORY_DIALOG_ID} .ob-dialog-subtitle`);
          if (subtitle) subtitle.textContent = scopeSubtitle(state.scope);
          body.innerHTML = `
            <div class="ob-space">
              <input class="ob-field" type="search" maxlength="128" value="${escapeHtml(state.query)}" placeholder="Buscar por texto, tipo ou origem" aria-label="Buscar memória" aria-describedby="${statusId}">
              <div class="ob-row">
                <button type="button" class="ob-button" data-action="set-scope" data-scope="agent" aria-pressed="${state.scope === "agent" ? "true" : "false"}">Deste bot</button>
                <button type="button" class="ob-button" data-action="set-scope" data-scope="user" aria-pressed="${state.scope === "user" ? "true" : "false"}">Perfil compartilhado</button>
                <div class="ob-badge">${escapeHtml(memoryModeLabel(memorySectionState.mode))}</div>
              </div>
            </div>
            ${statusMarkup(statusId, asyncMessage, statusClass)}
            ${alertMarkup(alertId, state.alert)}
            ${!state.loading && state.error ? `<div class="ob-status"><button type="button" class="ob-button" data-action="retry-memory-load">Tentar novamente</button></div>` : ""}
            ${!state.loading && !state.error && visibleItems.length === 0 ? `<div class="ob-empty">${escapeHtml(emptyStateCopy(state.scope))}</div>` : ""}
            ${!state.loading && !state.error && visibleItems.length > 0 ? `
              <div class="ob-list">
                ${visibleItems.map((item) => {
                  const isEditing = state.editingId === item.id;
                  const when = formatDateTime(item.updatedAtMs || item.createdAtMs);
                  const origin = state.scope === "user"
                    ? "Origem: perfil compartilhado"
                    : item.sourceConversationId ? `Origem: conversa ${item.sourceConversationId.slice(0, 8)}` : "Origem: manual";
                  const describedBy = describeBy(statusId, isEditing ? alertId : "");
                  return `
                    <article class="ob-item" data-memory-id="${escapeHtml(item.id)}">
                      <div class="ob-item-head">
                        <div>
                          <h3 class="ob-item-title">${escapeHtml(memoryKindLabel(item.kind))} ${item.pinned ? '<span class="ob-badge">Fixada</span>' : ""}</h3>
                          <div class="ob-item-meta">
                            <span>${escapeHtml(origin)}</span>
                            ${when ? `<span>${escapeHtml(when)}</span>` : ""}
                            <span>${escapeHtml(memoryStatusLabel(item.status))}</span>
                            <span>Importância: ${escapeHtml(String(item.importance))}</span>
                          </div>
                        </div>
                      </div>
                      ${isEditing
                        ? `
                          <div class="ob-split" style="margin-top:12px">
                            <div style="grid-column:1 / -1">
                              <label class="ob-item-meta" for="memory-text-${escapeHtml(item.id)}">Texto</label>
                              <textarea id="memory-text-${escapeHtml(item.id)}" data-role="memory-text" aria-describedby="${describedBy}" aria-invalid="${state.alert ? "true" : "false"}">${escapeHtml(state.editText)}</textarea>
                            </div>
                            <div>
                              <label class="ob-item-meta" for="memory-importance-${escapeHtml(item.id)}">Importância</label>
                              <select id="memory-importance-${escapeHtml(item.id)}" data-role="memory-importance" aria-describedby="${describedBy}">
                                ${[0, 25, 50, 75, 100].map((value) => `<option value="${value}"${value === state.editImportance ? " selected" : ""}>${value}</option>`).join("")}
                              </select>
                            </div>
                          </div>
                        `
                        : `<div class="ob-item-copy">${escapeHtml(item.text)}</div>`
                      }
                      <div class="ob-item-actions">
                        ${item.status === "active" ? `<button type="button" class="ob-button" data-action="toggle-pin" data-memory-id="${escapeHtml(item.id)}"${state.pendingMemoryId === item.id ? " disabled" : ""}>${item.pinned ? "Desafixar" : "Fixar"}</button>` : ""}
                        ${item.status === "active" && !isEditing ? `<button type="button" class="ob-button" data-action="edit-memory" data-memory-id="${escapeHtml(item.id)}">Editar</button>` : ""}
                        ${isEditing ? `
                          <button type="button" class="ob-button" data-action="save-memory" data-memory-id="${escapeHtml(item.id)}"${state.pendingMemoryId === item.id ? " disabled" : ""}>Salvar</button>
                          <button type="button" class="ob-button" data-action="cancel-edit">Cancelar</button>
                        ` : ""}
                        ${item.status === "active" ? `<button type="button" class="ob-button" data-action="forget-request" data-memory-id="${escapeHtml(item.id)}"${state.pendingMemoryId === item.id ? " disabled" : ""}>Esquecer</button>` : ""}
                      </div>
                      ${state.confirmForgetId === item.id ? `
                        <div class="ob-inline-confirm" aria-describedby="${statusId}">
                          <p class="ob-inline-confirm-copy">Esquecer esta memória agora? Ela e as fontes vinculadas deixam de ser usadas automaticamente, incluindo respostas, resumos e memórias derivadas automaticamente. Conversas e arquivos continuam no histórico. Isso não apaga o texto da conversa aberta nem o que já foi enviado ao provedor. Você pode informar o fato novamente. Cópias antigas sem vínculo de origem podem continuar disponíveis.</p>
                          <div class="ob-row">
                            <button type="button" class="ob-button" data-action="forget-cancel">Cancelar</button>
                            <button type="button" class="ob-button" data-action="forget-confirm" data-memory-id="${escapeHtml(item.id)}"${state.pendingMemoryId === item.id ? " disabled" : ""}>Esquecer</button>
                          </div>
                        </div>
                      ` : ""}
                    </article>
                  `;
                }).join("")}
              </div>
              <div class="ob-pagination">
                <span class="ob-item-meta">Página ${state.page}${state.nextCursor ? " · mais resultados" : ""}</span>
                <div class="ob-row">
                  <button type="button" class="ob-button" data-action="prev-page"${state.loading || state.page <= 1 ? " disabled" : ""}>Anterior</button>
                  <button type="button" class="ob-button" data-action="load-next-memory-page"${state.loading || !state.nextCursor ? " disabled" : ""}>Próxima</button>
                </div>
              </div>
            ` : ""}
          `;
          const search = body.querySelector('input[type="search"]');
          if (search instanceof HTMLInputElement && search.value !== state.query) search.value = state.query;
          const pendingFocus = state.pendingFocus;
          state.pendingFocus = null;
          renderPendingFocus(body, pendingFocus);
          if (!pendingFocus && searchSelection && search instanceof HTMLInputElement) {
            search.focus({ preventScroll: true });
            search.setSelectionRange(...searchSelection);
          }
          const editor = body.querySelector('textarea[data-role="memory-text"]');
          if (!pendingFocus && editorSelection && editor instanceof HTMLTextAreaElement) {
            editor.focus({ preventScroll: true });
            editor.setSelectionRange(...editorSelection);
          }
          if (state.pendingMemoryId) body.querySelectorAll("button, input, textarea, select").forEach((control) => { control.disabled = true; });
        };

        const loadPage = async (pageNumber, cursor = null, reset = false) => {
          if (!current() || state.pendingMemoryId) return;
          const loadToken = ++state.loadToken;
          state.loading = true;
          state.error = "";
          state.alert = "";
          state.notice = "";
          render();
          try {
            const api = desktopAgent();
            const agentId = await ensureCurrentAgentBinding(state.binding);
            const [pageResult, status] = await Promise.all([
              api.listMemoriesPage({
                limit: MEMORY_PAGE_LIMIT,
                includeInactive: true,
                query: state.query.trim(),
                scope: state.scope,
                ...(cursor ? { cursor } : {}),
                agentId,
                expectedAgentId: state.binding.expectedAgentId,
              }),
              api.getMemoryStatus({ agentId, expectedAgentId: state.binding.expectedAgentId }),
            ]);
            if (loadToken !== state.loadToken || !current()) return;
            if (reset) state.pageCursors = [null];
            state.page = pageNumber;
            state.items = Array.isArray(pageResult?.items) ? pageResult.items : [];
            state.nextCursor = typeof pageResult?.nextCursor === "string" ? pageResult.nextCursor : null;
            state.status = status;
            memorySectionState.status = status;
            renderMemorySection();
          } catch (error) {
            if (loadToken !== state.loadToken || !current()) return;
            state.error = sanitizeError(error, "Não foi possível carregar as memórias.");
          } finally {
            if (loadToken !== state.loadToken || !current()) return;
            state.loading = false;
            render();
          }
        };

        const reload = async () => {
          state.pageCursors = [null];
          state.nextCursor = null;
          await loadPage(1, null, true);
        };

        const commit = async (memoryId, callback) => {
          if (!current() || state.pendingMemoryId) return;
          clearLocalTimeout(state.searchTimer);
          const commitToken = ++state.loadToken;
          state.pendingMemoryId = memoryId;
          state.alert = "";
          render();
          try {
            const agentId = await ensureCurrentAgentBinding(state.binding);
            const updated = await callback(agentId);
            if (!current()) return;
            if (updated?.id !== memoryId) throw new Error("A operação não confirmou a persistência.");
            state.items = state.items.map((item) => item.id === memoryId ? updated : item);
            state.editingId = null;
            state.confirmForgetId = null;
            state.notice = updated.status === "forgotten" ? "Memória esquecida." : "Memória atualizada.";
            void desktopAgent().getMemoryStatus({ agentId, expectedAgentId: state.binding.expectedAgentId }).then((status) => {
              if (!current() || commitToken !== state.loadToken) return;
              state.status = status;
              memorySectionState.status = status;
              renderMemorySection();
            }).catch(() => {
              if (!current() || commitToken !== state.loadToken) return;
              memorySectionState.error = "Memória atualizada; não foi possível atualizar o resumo. Tente novamente.";
              renderMemorySection();
            });
          } catch (error) {
            if (!current()) return;
            state.alert = sanitizeError(error, "Não foi possível atualizar a memória.");
            state.pendingFocus = { selector: state.editingId ? 'textarea[data-role="memory-text"]' : '[data-action="forget-confirm"]' };
          } finally {
            state.pendingMemoryId = null;
            render();
          }
        };

        body.addEventListener("input", (event) => {
          const target = event.target;
          if (target instanceof HTMLInputElement && target.type === "search") {
            state.query = target.value;
            clearLocalTimeout(state.searchTimer);
            state.searchTimer = setLocalTimeout(() => {
              state.searchTimer = 0;
              void reload();
            }, 180);
          }
          if (target instanceof HTMLTextAreaElement && target.dataset.role === "memory-text") {
            state.editText = target.value;
            if (state.alert) {
              state.alert = "";
              render();
            }
          }
        });

        body.addEventListener("change", (event) => {
          const target = event.target;
          if (target instanceof HTMLSelectElement && target.dataset.role === "memory-importance") {
            state.editImportance = Number(target.value) || 0;
          }
        });

        body.addEventListener("click", (event) => {
          if (!current() || state.pendingMemoryId) return;
          const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
          if (!(target instanceof HTMLElement)) return;
          const action = target.dataset.action;
          const memoryId = target.dataset.memoryId || null;
          if (action === "retry-memory-load") void reload();
          if (action === "set-scope") {
            const nextScope = target.dataset.scope;
            if (nextScope !== "agent" && nextScope !== "user") return;
            if (nextScope === state.scope) return;
            state.scope = nextScope;
            state.pageCursors = [null];
            state.page = 1;
            state.editingId = null;
            state.confirmForgetId = null;
            state.alert = "";
            void reload();
          }
          if (action === "prev-page" && !state.loading && state.page > 1) {
            const targetPage = state.page - 1;
            void loadPage(targetPage, state.pageCursors[targetPage - 1] || null);
          }
          if (action === "load-next-memory-page" && !state.loading && state.nextCursor) {
            const targetPage = state.page + 1;
            state.pageCursors[targetPage - 1] = state.nextCursor;
            void loadPage(targetPage, state.nextCursor);
          }
          if (action === "edit-memory" && memoryId) {
            const current = state.items.find((item) => item.id === memoryId);
            if (!current) return;
            state.editingId = memoryId;
            state.editText = current.text;
            state.editImportance = current.importance;
            state.confirmForgetId = null;
            state.alert = "";
            state.pendingFocus = { selector: 'textarea[data-role="memory-text"]', selectText: true };
            render();
          }
          if (action === "cancel-edit") {
            state.editingId = null;
            state.alert = "";
            render();
          }
          if (action === "toggle-pin" && memoryId) {
            const current = state.items.find((item) => item.id === memoryId);
            if (!current) return;
            void commit(memoryId, (agentId) => desktopAgent().updateMemory({ memoryId, pinned: !current.pinned, scope: state.scope, agentId, expectedAgentId: state.binding.expectedAgentId }));
          }
          if (action === "save-memory" && memoryId) {
            const text = (state.editText || "").trim();
            if (!text) {
              state.alert = "O texto da memória não pode ficar vazio.";
              state.pendingFocus = { selector: 'textarea[data-role="memory-text"]', selectText: true };
              render();
              return;
            }
            void commit(memoryId, (agentId) => desktopAgent().updateMemory({ memoryId, text, importance: state.editImportance, scope: state.scope, agentId, expectedAgentId: state.binding.expectedAgentId }));
          }
          if (action === "forget-request" && memoryId) {
            state.confirmForgetId = memoryId;
            state.alert = "";
            state.pendingFocus = { selector: '[data-action="forget-cancel"]' };
            render();
          }
          if (action === "forget-cancel") {
            state.confirmForgetId = null;
            state.alert = "";
            render();
          }
          if (action === "forget-confirm" && memoryId) {
            void commit(memoryId, (agentId) => desktopAgent().deleteMemory({ memoryId, scope: state.scope, agentId, expectedAgentId: state.binding.expectedAgentId }));
          }
        });

        void reload();
      },
    });
  }

  function scheduleScan(delay = 80) {
    if (localUiClosed) return;
    if (scanInFlight) {
      scanPending = true;
      return;
    }
    clearLocalTimeout(scanTimer);
    scanTimer = setLocalTimeout(() => {
      scanTimer = 0;
      return scan();
    }, delay);
  }

  async function scan() {
    if (localUiClosed || !document.body) return;
    if (scanInFlight) {
      scanPending = true;
      return;
    }
    scanInFlight = true;
    try {
      ensureStyle();
      if (!findMemorySectionMountRoot() && !dialogState) {
        const section = document.getElementById(MEMORY_SECTION_ID);
        if (section || memorySectionState.status || memorySectionState.loading) {
          handleActiveAgentChange(null, "");
          agentContext.token += 1;
          agentContext.loaded = false;
          agentContext.loading = false;
        }
        section?.remove();
        return;
      }
      await refreshAgentContext();
      ensureMemorySection();
    } finally {
      scanInFlight = false;
      if (scanPending) {
        scanPending = false;
        scheduleScan();
      }
    }
  }

  function isOwnMutation(record) {
    const target = record.target;
    const selector = `#${MEMORY_SECTION_ID},#${MEMORY_DIALOG_ID},#openbot-tasks-dialog,.obp22-backdrop,.obp23-backdrop`;
    if (target instanceof Element && target.closest(selector)) return true;
    const changed = [...record.addedNodes, ...record.removedNodes].filter((node) => node instanceof Element);
    return changed.length > 0 && changed.every((node) => node.matches(selector) || Boolean(node.closest(selector)));
  }

  function mutationNeedsMemoryScan(record) {
    const selector = "#openbot-provider-settings,main.sand-chat,.sand-info-pane,.sand-agent-item,.sand-onboarding__meet,[aria-label='View agent settings']";
    if (record.type === "attributes") return record.target instanceof Element && record.target.matches(selector);
    return [...record.addedNodes, ...record.removedNodes].some((node) => {
      const element = node instanceof Element ? node : node.parentElement;
      return element instanceof Element && (element.matches(selector) || Boolean(element.querySelector(selector)));
    });
  }

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver((records) => {
      if (localUiClosed) return;
      const touched = records.some((record) => !isOwnMutation(record) && mutationNeedsMemoryScan(record));
      if (touched) scheduleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-expanded", "aria-current", "data-active"] });
  }

  function cleanupLocalUi() {
    if (localUiClosed) return;
    localUiClosed = true;
    clearLocalTimeout(scanTimer);
    clearLocalTimers();
    observer?.disconnect();
    observer = null;
    closeDialog({ immediate: true, restoreFocus: false });
    document.getElementById(MEMORY_SECTION_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
  }

  function boot() {
    if (localUiClosed) return;
    startObserver();
    void scan();
  }

  window.addEventListener("openbot:settings-mounted", () => scheduleScan(0));

  window.addEventListener("openbot:memory-ui-rescan", () => {
    if (localUiClosed) return;
    handleActiveAgentChange(null, "");
    agentContext.token += 1;
    agentContext.loading = false;
    agentContext.loaded = false;
    agentContext.refreshedAtMs = 0;
    scheduleScan(0);
    for (const delay of [180, 500]) setLocalTimeout(() => scheduleScan(0), delay);
  });
  window.addEventListener("pagehide", cleanupLocalUi, { once: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();

// ---- P2.3 self-contained surface (server-side attachment staging + find + reply) ----
// Renders only escaped text; the renderer never sends an arbitrary path (only
// opaque attachment:<id> refs). Escape/pagehide/close/backdrop discard any
// uncommitted staging through the server-side authority. No bytes or paths are
// persisted in localStorage; reply targets resolve server-side.
(function () {
  if (window.__openbotP23Installed) return;
  window.__openbotP23Installed = true;

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function bridge() { return window.__openbotP23Bridge || (window.desktop && window.desktop.p23 ? window.desktop.p23 : null); }
  function activeAgent() {
    var a = window.__openbotMemoryUiAgent;
    if (a && typeof a === "object" && a.getProviderConfig) return a.getProviderConfig().then(function (cfg) { return cfg && typeof cfg.agentId === "string" ? cfg.agentId : null; }).catch(function () { return null; });
    if (a && typeof a === "object" && a.agentId) return Promise.resolve(a.agentId);
    return Promise.resolve(window.desktop && window.desktop.agent && window.desktop.agent.agentId ? window.desktop.agent.agentId : null);
  }
  function nonce(prefix) { return prefix + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10); }
  function textPreview(bytes, max) {
    try {
      var text = new TextDecoder("utf-8").decode(bytes);
      var cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").replace(/\s+/g, " ").trim();
      if (cleaned.length > max) cleaned = cleaned.slice(0, max) + "\u2026";
      return cleaned;
    } catch (e) { return ""; }
  }

  var STYLE = ".obp23-dialog{position:fixed;inset:0;z-index:2147483000}.obp23-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55)}.obp23-panel{position:relative;margin:6vh auto;width:min(800px,94vw);max-height:84vh;overflow:auto;background:#141414;color:#eee;border:1px solid #333;border-radius:16px;padding:16px;box-shadow:0 26px 70px rgba(0,0,0,.4)}.obp23-head{display:flex;justify-content:space-between;align-items:center}.obp23-card,.obp23-replies{border:1px solid #2c2c2c;border-radius:12px;padding:12px}.obp23-item{display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid #222;flex-wrap:wrap}.obp23-preview{color:#c9c9c9;font-size:12px;white-space:pre-wrap;word-break:break-word;width:100%}.obp23-meta{color:#9a9a9a;font-size:12px}.obp23-status{color:#7ec8ff;min-height:16px;font-size:12px}.obp23-error{color:#e34671}.obp23-hint{color:#9a9a9a;font-size:12px}.obp23-drop{border:1px dashed #4a6da8;border-radius:8px;padding:14px;text-align:center;color:#9ab8e8;font-size:13px;cursor:pointer}.obp23-drop.obp23-over{border-color:#7ec8ff;background:rgba(126,200,255,.08)}.obp23-panel textarea{width:100%;box-sizing:border-box;background:#0d0d0d;color:#eee;border:1px solid #333;border-radius:8px;padding:6px;margin:4px 0;min-height:60px}.obp23-panel input{width:100%;box-sizing:border-box;background:#0d0d0d;color:#eee;border:1px solid #333;border-radius:8px;padding:6px;margin:4px 0}.obp23-panel button{background:#2a6fd6;color:#fff;border:0;border-radius:8px;padding:6px 10px;margin:4px 2px;cursor:pointer}.obp23-panel button[disabled]{opacity:.5}.obp23-panel code{color:#9feea0}.obp23-close{background:#333!important}.obp23-pager{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.obp23-pager span{font-size:12px;color:#9a9a9a}";

  var state = null;
  function cleanup() {
    var s = state;
    state = null;
    if (!s) return;
    s.closed = true;
    if (s.root && s.root.parentNode) s.root.parentNode.removeChild(s.root);
    if (s.style && s.style.parentNode) s.style.parentNode.removeChild(s.style);
    if (typeof s.onKeyDown === "function") document.removeEventListener("keydown", s.onKeyDown, true);
    if (typeof s.onPageHide === "function") window.removeEventListener("pagehide", s.onPageHide);
    if (s.appRoot instanceof HTMLElement && s.appRoot.inert) s.appRoot.inert = false;
    var b = bridge();
    var a = s.agentId;
    for (var i = 0; i < s.staged.length; i += 1) {
      if (b && a) { try { b.discardStagedAttachment(a, s.staged[i].id); } catch (_e) {} }
    }
    s.staged = [];
    if (s.trigger instanceof HTMLElement && s.trigger.isConnected) {
      try { s.trigger.focus({ preventScroll: true }); } catch (_e) {}
    }
    if (typeof openbotP23._closedHook === "function") { try { openbotP23._closedHook(); } catch (_e) {} }
  }
  function isCurrent(s) {
    return !!(s && state === s && !s.closed && s.root && s.root.isConnected);
  }
  function sessionStatus(s, id, msg, isError) {
    if (isCurrent(s)) setStatus(id, msg, isError);
  }
  function discardStaged(s, id) {
    if (!s || !id) return;
    var b = bridge();
    if (b && s.agentId) {
      try {
        var result = b.discardStagedAttachment(s.agentId, id);
        if (result && typeof result.catch === "function") result.catch(function () {});
      } catch (_e) {}
    }
  }
  function setStatus(id, msg, isError) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("obp23-error", isError === true);
  }
  function renderStaged(s) {
    var el = document.getElementById("obp23-staged");
    if (!el) return;
    if (s.staged.length === 0) { el.innerHTML = "<li class=obp23-meta>Nenhum anexo em staging.</li>"; return; }
    el.innerHTML = s.staged.map(function (item) {
      var preview = item.preview ? "<div class=obp23-preview>" + esc(item.preview) + "</div>" : "";
      return "<li class=obp23-item data-id=\"" + esc(item.id) + "\"><span><strong>" + esc(item.name) + "</strong> <span class=obp23-meta>(" + esc(item.kind || "desconhecido") + ", " + esc(String(item.sizeBytes || 0)) + " B)</span></span><code>" + esc((item.sha256 || "").slice(0, 12)) + "</code><span class=obp23-meta>expirado em " + esc(String(item.expiresAtMs || 0)) + "</span><button type=button class=obp23-remove data-act=p23-remove data-id=\"" + esc(item.id) + "\">Remover</button>" + preview + "</li>";
    }).join("");
  }
  function renderResults(s) {
    var list = document.getElementById("obp23-results");
    var info = document.getElementById("obp23-search-info");
    if (list) {
      list.innerHTML = s.search.items.length
        ? s.search.items.map(function (it) {
            return "<li class=obp23-item data-entry=\"" + esc(it.entryId || "") + "\"><span>" + esc(it.snippet || "") + "</span><span class=obp23-meta>" + esc(it.kind || "message") + "</span><button type=button data-act=p23-pickt data-entry=\"" + esc(it.entryId || "") + "\" data-conv=\"" + esc(it.conversationId || "") + "\">responder</button></li>";
          }).join("")
        : "<li class=obp23-meta>Sem resultados.</li>";
    }
    if (info) info.textContent = s.search.pageLabel || "";
    var prev = document.getElementById("obp23-search-prev");
    var next = document.getElementById("obp23-search-next");
    if (prev) prev.disabled = s.search.pageHistory.length === 0;
    if (next) next.disabled = !s.search.nextCursor;
  }
  function bodyMarkup() {
    return "" +
      "<p class=obp23-hint>Staging seguro: anexos saem do renderer apenas como attachment:&lt;id&gt; e são descartados no Escape/pagehide/fechar. Nenhum caminho arbitrário é enviado e nada é persistido em localStorage.</p>" +
      "<section class=obp23-card><h3>Anexos</h3>" +
      "<label class=obp23-hint>Cole o texto do anexo</label><textarea id=obp23-paste aria-label='texto do anexo' placeholder='Cole o anexo de texto aqui'></textarea>" +
      "<div id=obp23-drop-zone class=obp23-drop tabindex=0 role=button aria-label='Adicionar arquivo'>Arraste e solte um arquivo aqui ou clique para escolher</div>" +
      "<div><button type=button data-act=p23-stage>Adicionar texto anexo</button><button type=button data-act=p23-sendatt disabled id=obp23-sendatt>Enviar anexos no prompt</button></div>" +
      "<ul id=obp23-staged></ul><p id=obp23-stage-status class=obp23-status></p></section>" +
      "<section class=obp23-card><h3>Buscar no transcript (FTS scoped, snippets limitados)</h3>" +
      "<input id=obp23-query aria-label='busca' placeholder='termo de busca'><div class=obp23-pager><button type=button data-act=p23-search>Buscar</button><button type=button data-act=p23-search-prev id=obp23-search-prev disabled>Anterior</button><button type=button data-act=p23-search-next id=obp23-search-next disabled>Próxima</button><span id=obp23-search-info class=obp23-meta></span></div>" +
      "<ul id=obp23-results></ul><p id=obp23-search-status class=obp23-status></p></section>" +
      "<section class=obp23-replies><h3>Responder (replyToId resolvido server-side)</h3>" +
      "<p class=obp23-status>Alvo: <code id=obp23-target>nenhum</code></p>" +
      "<textarea id=obp23-reply aria-label='resposta' placeholder='Escreva a reply valida'></textarea>" +
      "<div><button type=button data-act=p23-reply disabled id=obp23-sendreply>Enviar resposta</button></div>" +
      "<p id=obp23-reply-status class=obp23-status></p></section>";
  }
  function doSearch(s, query, options) {
    var b = bridge();
    var a = s.agentId;
    if (!isCurrent(s)) return;
    if (!b || !a) { sessionStatus(s, "obp23-search-status", "Bot ativo indisponível.", true); return; }
    var cursor = options && typeof options.cursor === "string" ? options.cursor : undefined;
    if (!options || options.reset) { s.search.pageHistory = []; s.search.nextCursor = undefined; s.search.current = null; }
    sessionStatus(s, "obp23-search-status", "Buscando\u2026");
    var request = cursor === undefined
      ? b.searchTranscript(a, query, s.search.conversationId)
      : b.searchTranscript(a, query, s.search.conversationId, cursor);
    Promise.resolve(request).then(function (page) {
      if (!isCurrent(s)) return;
      var items = page && Array.isArray(page.items) ? page.items : [];
      s.search.items = items;
      s.search.nextCursor = page && typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      if (options && options.history) s.search.pageHistory.push(options.history);
      const labelPage = (options && options.reset) ? 1 : s.search.pageHistory.length + 1;
      s.search.pageLabel = "p\u00e1gina " + labelPage + " (" + items.length + ")";
      s.search.pageLabel = (options && options.reset && items.length === 0) ? "" : s.search.pageLabel;
      renderResults(s);
      sessionStatus(s, "obp23-search-status", "" + items.length + " resultado(s)");
    }).catch(function (e) {
      if (!isCurrent(s)) return;
      if (cursor !== undefined && s.search.noCursorBridge) {
        s.search.nextCursor = undefined;
        renderResults(s);
        sessionStatus(s, "obp23-search-status", "Paginação indisponível nesta superfície.", true);
        return;
      }
      sessionStatus(s, "obp23-search-status", String(e && e.message ? e.message : e), true);
    });
  }
  function handleAction(s, act, btn) {
    var b = bridge();
    var a = s.agentId;
    if (act === "p23-stage") {
      var ta = document.getElementById("obp23-paste");
      var val = ta ? ta.value : "";
      if (!val || !val.trim()) { setStatus("obp23-stage-status", "Cole um texto primeiro.", true); return; }
      if (!b || !a) { setStatus("obp23-stage-status", "Bot ativo indisponível.", true); return; }
      var bytes = new TextEncoder().encode(val);
      b.stageAttachmentBytes(a, "anexo-p23.txt", bytes).then(function (res) {
        if (!isCurrent(s)) {
          if (res && res.attachmentId) discardStaged(s, res.attachmentId);
          return;
        }
        if (res && res.attachmentId) {
          s.staged.push({ id: res.attachmentId, name: res.name || "anexo-p23.txt", kind: res.kind || "text", sizeBytes: res.sizeBytes || bytes.length, sha256: res.sha256 || "", expiresAtMs: res.expiresAtMs || 0, preview: textPreview(bytes, 200) });
          renderStaged(s);
          if (ta) ta.value = "";
          setStatus("obp23-stage-status", "Em staging: " + res.attachmentId);
          var send = document.getElementById("obp23-sendatt"); if (send) send.disabled = false;
        } else { setStatus("obp23-stage-status", "Falha ao adicionar anexo.", true); }
      }).catch(function (e) { sessionStatus(s, "obp23-stage-status", String(e && e.message ? e.message : e), true); });
      return;
    }
    if (act === "p23-pick-file") {
      var picker = document.getElementById("obp23-file-input");
      if (picker) picker.click();
      return;
    }
    if (act === "p23-remove") {
      var id = btn && btn.dataset ? (btn.dataset.id || "") : (document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id || "" : "");
      s.staged = s.staged.filter(function (it) { return it.id !== id; });
      renderStaged(s);
      if (b && a && id) { try { b.discardStagedAttachment(a, id); } catch (_e) {} }
      var send = document.getElementById("obp23-sendatt");
      if (send) send.disabled = s.staged.length === 0;
      return;
    }
    if (act === "p23-sendatt") {
      if (!b || !a || s.staged.length === 0) return;
      var atts = s.staged.map(function (it) { return { path: "attachment:" + it.id, name: it.name }; });
      b.sendPrompt(a, "Envio com anexo: " + atts[0].name, { attachments: atts, clientNonce: nonce("p23att") })
        .then(function (out) {
          if (!isCurrent(s)) return out;
          setStatus("obp23-stage-status", "Enviado (aceito): " + JSON.stringify(out).slice(0, 120));
          s.staged = [];
          renderStaged(s);
          var send = document.getElementById("obp23-sendatt"); if (send) send.disabled = true;
          return out;
        })
        .catch(function (e) { sessionStatus(s, "obp23-stage-status", String(e && e.message ? e.message : e), true); });
      return;
    }
    if (act === "p23-search" || act === "p23-search-prev" || act === "p23-search-next") {
      var inq = document.getElementById("obp23-query");
      var q = inq ? inq.value.trim() : "";
      if (!q) { setStatus("obp23-search-status", "Digite uma busca.", true); return; }
      if (act === "p23-search-next") {
        if (!s.search.nextCursor) return;
        doSearch(s, q, { cursor: s.search.nextCursor, history: { items: s.search.items.slice(), nextCursor: s.search.nextCursor } });
      } else if (act === "p23-search-prev") {
        if (s.search.pageHistory.length === 0) return;
        var previous = s.search.pageHistory.pop();
        s.search.items = previous.items;
        s.search.nextCursor = previous.nextCursor;
        s.search.pageLabel = "p\u00e1gina " + (s.search.pageHistory.length + 1) + " (" + previous.items.length + ")";
        renderResults(s);
        setStatus("obp23-search-status", "" + previous.items.length + " resultado(s)");
      } else {
        doSearch(s, q, { reset: true });
      }
      return;
    }
    if (act === "p23-pickt") {
      var pick = btn || document.activeElement;
      if (!pick || !pick.dataset) return;
      s.reply = { replyToId: pick.dataset.entry || "", conversationId: pick.dataset.conv || "" };
      var target = document.getElementById("obp23-target"); if (target) target.textContent = s.reply.replyToId + " @ " + s.reply.conversationId;
      var sr = document.getElementById("obp23-sendreply"); if (sr) sr.disabled = false;
      var rr = document.getElementById("obp23-reply"); if (rr) rr.focus();
      return;
    }
    if (act === "p23-reply") {
      var ri = document.getElementById("obp23-reply");
      var prompt = ri ? ri.value.trim() : "";
      if (!prompt) { setStatus("obp23-reply-status", "Escreva a resposta.", true); return; }
      if (!b || !a || !s.reply) { setStatus("obp23-reply-status", "Selecione um alvo primeiro.", true); return; }
      b.sendPrompt(a, prompt, { clientNonce: nonce("p23reply"), conversationId: s.reply.conversationId, replyContext: { replyToId: s.reply.replyToId, conversationId: s.reply.conversationId } })
        .then(function (out) { sessionStatus(s, "obp23-reply-status", "Resposta enviada: " + JSON.stringify(out).slice(0, 120)); })
        .catch(function (e) { sessionStatus(s, "obp23-reply-status", String(e && e.message ? e.message : e), true); });
      return;
    }
    if (act === "p23-close") { cleanup(); }
  }
  function open(trigger) {
    if (state) cleanup();
    var root = document.createElement("div");
    root.className = "obp23-dialog";
    root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true");
    root.innerHTML = "<div class=obp23-backdrop></div><section class=obp23-panel role=dialog aria-modal=true tabindex=-1><header class=obp23-head><h2>Anexos e Busca (P2.3)</h2><button type=button class=obp23-close data-act=p23-close aria-label='Fechar'>Fechar</button></header><div class=obp23-body>" + bodyMarkup() + "</div></section>";
    var style = document.createElement("style"); style.textContent = STYLE;
    document.body.appendChild(style); document.body.appendChild(root);
    var appRoot = document.getElementById("root");
    if (appRoot instanceof HTMLElement) appRoot.inert = true;
    var s = {
      root: root, style: style, trigger: trigger instanceof Element ? trigger : null, appRoot: appRoot,
      staged: [], reply: null, agentId: null,
      search: { items: [], nextCursor: undefined, pageHistory: [], pageLabel: "", conversationId: undefined, current: null },
      closed: false,
    };
    var panel = root.querySelector(".obp23-panel"); if (panel) panel.focus({ preventScroll: true });
    var fileInput = document.createElement("input");
    fileInput.id = "obp23-file-input";
    fileInput.type = "file";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", function () {
      if (state !== s || s.closed || !fileInput.files || fileInput.files.length === 0) return;
      stageFiles(s, fileInput.files);
      fileInput.value = "";
    });
    root.appendChild(fileInput);
    var dropZone = root.querySelector("#obp23-drop-zone");
    if (dropZone) {
      dropZone.addEventListener("click", function () { fileInput.click(); });
      dropZone.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        fileInput.click();
      });
      dropZone.addEventListener("dragover", function (e) { e.preventDefault(); dropZone.classList.add("obp23-over"); });
      dropZone.addEventListener("dragleave", function () { dropZone.classList.remove("obp23-over"); });
      dropZone.addEventListener("drop", function (e) {
        e.preventDefault();
        dropZone.classList.remove("obp23-over");
        if (state === s && !s.closed && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) stageFiles(s, e.dataTransfer.files);
      });
    }
    s.onKeyDown = function (e) { if (e.key === "Escape") { e.preventDefault(); cleanup(); } };
    s.onPageHide = function () { cleanup(); };
    state = s;
    document.addEventListener("keydown", s.onKeyDown, true);
    window.addEventListener("pagehide", s.onPageHide);
    root.addEventListener("mousedown", function (e) { if (e.target instanceof Element && e.target.classList.contains("obp23-backdrop")) cleanup(); });
    root.addEventListener("click", function (e) {
      var btn = e.target instanceof Element ? e.target.closest("button[data-act]") : null;
      if (btn && state === s && !s.closed) handleAction(s, btn.getAttribute("data-act"), btn);
    });
    activeAgent().then(function (agentId) {
      if (state !== s || s.closed) return;
      s.agentId = agentId || null;
      if (!agentId) setStatus("obp23-stage-status", "Bot ativo indisponível.", true);
    });
  }
  function stageFiles(s, files) {
    if (!isCurrent(s) || !files || typeof files.length !== "number") return;
    var b = bridge();
    var a = s.agentId;
    if (!b || !a) { sessionStatus(s, "obp23-stage-status", "Bot ativo indisponível.", true); return; }
    var count = 0;
    var queue = Promise.resolve();
    for (var i = 0; i < files.length && count < 4; i += 1) {
      var file = files[i];
      if (typeof File === "undefined" || !(file instanceof File) || !file.name) continue;
      var lowerName = file.name.toLowerCase();
      var maxBytes = file.type.indexOf("image/") === 0 || lowerName.endsWith(".pdf") ? 2 * 1024 * 1024 : 256 * 1024;
      if (file.size > maxBytes) {
        sessionStatus(s, "obp23-stage-status", "Arquivo excede o limite permitido: " + file.name, true);
        continue;
      }
      count += 1;
      (function (file) {
        queue = queue.then(function () {
          if (!isCurrent(s)) return null;
          return file.arrayBuffer();
        }).then(function (buf) {
          if (!buf || !isCurrent(s)) return null;
          var bytes = new Uint8Array(buf);
          return b.stageAttachmentBytes(a, file.name, bytes).then(function (res) {
            if (!isCurrent(s)) {
              if (res && res.attachmentId) discardStaged(s, res.attachmentId);
              return;
            }
            if (res && res.attachmentId) {
              s.staged.push({ id: res.attachmentId, name: res.name || file.name, kind: res.kind || "desconhecido", sizeBytes: res.sizeBytes || bytes.length, sha256: res.sha256 || "", expiresAtMs: res.expiresAtMs || 0, preview: res.kind === "text" ? textPreview(bytes, 200) : (res.kind === "image" ? "Imagem anexada (sem preview de bytes)." : "Anexo " + (res.kind || "arquivo") + " (sem preview de texto).") });
              renderStaged(s);
              var send = s.root.querySelector("#obp23-sendatt"); if (send) send.disabled = false;
              sessionStatus(s, "obp23-stage-status", "Em staging: " + res.attachmentId);
            } else { sessionStatus(s, "obp23-stage-status", "Falha ao adicionar arquivo.", true); }
          }).catch(function (e) { sessionStatus(s, "obp23-stage-status", String(e && e.message ? e.message : e), true); });
        }).catch(function (e) { sessionStatus(s, "obp23-stage-status", String(e && e.message ? e.message : e), true); });
      })(file);
    }
  }
  var openbotP23 = window.openbotP23 || {};
  window.openbotP23 = Object.assign(openbotP23, { open: open, cleanup: cleanup, _closedHook: null });
  var launch = document.createElement("button");
  launch.textContent = "P2.3";
  launch.setAttribute("data-openbot-p23-launch", "1");
  launch.style.cssText = "position:fixed;left:24px;bottom:24px;z-index:2147482900;min-height:36px;padding:6px 12px";
  launch.addEventListener("click", function () { open(launch); });
  function mountLaunch() {
    if (document.body && !launch.parentNode) document.body.appendChild(launch);
  }
  // The overlay runs synchronously in <head> before <body> exists; defer the
  // launch-button mount so the real surface is reachable after load.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountLaunch, { once: true });
  else mountLaunch();
  window.addEventListener("openbot:p23-open", open);
})();

// ---- P2.2 tasks/subagents overlay surface (reauthorized) ----
// One initial RPC load, then SSE frames only (no continuous polling). Loading,
// empty, error+retry, resync states; abort/steer only through the typed bridge;
// single stream across reopens; Escape/focus/pagehide teardown; XSS-safe text.
(function () {
  if (window.__openbotTasksInstalled) return;
  window.__openbotTasksInstalled = true;
  var TASK_LIST_LIMIT = 100;

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function bridge() { return window.__openbotTasksUiBridge || (window.desktop && window.desktop.tasks ? window.desktop.tasks : null); }
  function memoryAgent() {
    var a = window.__openbotMemoryUiAgent;
    if (a && typeof a === "object" && a.getProviderConfig) return a.getProviderConfig().then(function (cfg) { return cfg && typeof cfg.agentId === "string" ? cfg.agentId : null; }).catch(function () { return null; });
    if (a && typeof a === "object" && a.agentId) return Promise.resolve(a.agentId);
    return Promise.resolve(window.desktop && window.desktop.agent && window.desktop.agent.agentId ? window.desktop.agent.agentId : null);
  }
  function intentId() {
    return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ("int-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10));
  }
  function humanize(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return "h\u00e1 " + s + "s";
    var m = Math.floor(s / 60);
    var r = s % 60;
    if (m < 60) return "h\u00e1 " + m + "m " + r + "s";
    var h = Math.floor(m / 60);
    return "h\u00e1 " + h + "h " + (m % 60) + "m";
  }
  var STATUS_TEXT = { running: "Em andamento", queued: "Na fila", completed: "Conclu\u00edda", failed: "Falhou", cancelled: "Cancelada", interrupted: "Interrompida" };
  var STYLE = "#openbot-tasks-dialog{z-index:2147483500}#openbot-tasks-dialog .obp22-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.58)}#openbot-tasks-dialog .obp22-panel{position:fixed;left:50%;top:8vh;transform:translateX(-50%);width:min(720px,94vw);max-height:82vh;display:flex;flex-direction:column;background:#161616;color:var(--cursor-text-primary,#f0f0f0);border:1px solid var(--cursor-stroke-secondary,#2c2c2c);border-radius:14px;box-shadow:0 26px 70px rgba(0,0,0,.4)}#openbot-tasks-dialog .obp22-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px 12px;border-bottom:1px solid var(--cursor-stroke-secondary,#2c2c2c)}#openbot-tasks-dialog .obp22-body{padding:14px 18px 18px;overflow:auto;min-height:0}#openbot-tasks-dialog h2{margin:0;font-size:15px;font-weight:600}#openbot-tasks-dialog .obp22-status{min-height:18px;margin:6px 0;color:var(--cursor-text-secondary,#a0a0a0);font-size:12px}#openbot-tasks-dialog .obp22-alert{color:#e34671}#openbot-tasks-dialog .obp22-list{display:grid;gap:10px;margin-top:10px}#openbot-tasks-dialog .ob-task-item{padding:12px;border:1px solid var(--cursor-stroke-secondary,#2c2c2c);border-radius:10px;background:color-mix(in srgb,currentColor 6%,transparent)}#openbot-tasks-dialog .ob-task-item .obp22-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}#openbot-tasks-dialog .ob-task-item .obp22-label{font-weight:600}#openbot-tasks-dialog .ob-task-item .obp22-detail{margin:6px 0 0;color:#c9c9c9;font-size:12px;white-space:pre-wrap;word-break:break-word}#openbot-tasks-dialog .ob-task-item .obp22-meta{color:#9a9a9a;font-size:12px}#openbot-tasks-dialog .ob-task-item .obp22-badge{display:inline-flex;align-items:center;min-height:22px;padding:2px 8px;border:1px solid var(--cursor-stroke-secondary,#2c2c2c);border-radius:999px;font-size:12px}#openbot-tasks-dialog .ob-task-item .obp22-badge.is-failed{color:#e34671}#openbot-tasks-dialog .ob-task-item .obp22-badge.is-active{color:#7ec8ff}#openbot-tasks-dialog .ob-task-item button{min-height:30px;margin-top:8px;margin-right:6px;border:1px solid var(--cursor-stroke-secondary,#2c2c2c);border-radius:8px;padding:4px 10px;background:color-mix(in srgb,currentColor 10%,transparent);color:inherit;font:inherit;font-size:12px;cursor:pointer}#openbot-tasks-dialog .obp22-steer{display:flex;align-items:center;gap:8px;margin-top:8px}#openbot-tasks-dialog .obp22-steer input{flex:1;min-width:0;border:1px solid var(--cursor-stroke-secondary,#2c2c2c);border-radius:8px;background:#0d0d0d;color:inherit;padding:6px 8px;font:inherit;font-size:12px}#openbot-tasks-dialog .obp22-close,#openbot-tasks-dialog .obp22-retry{background:color-mix(in srgb,currentColor 12%,transparent)!important}";

  var state = null;
  function closeNow() {
    var s = state;
    state = null;
    if (!s) return;
    s.closed = true;
    if (typeof s.onKeyDown === "function") document.removeEventListener("keydown", s.onKeyDown, true);
    if (typeof s.onPageHide === "function") window.removeEventListener("pagehide", s.onPageHide);
    if (s.root && s.root.parentNode) s.root.parentNode.removeChild(s.root);
    if (s.style && s.style.parentNode) s.style.parentNode.removeChild(s.style);
    if (s.appRoot instanceof HTMLElement && s.appRoot.inert) s.appRoot.inert = false;
    closeStreamSafe(s);
    var target = s.trigger instanceof HTMLElement && s.trigger.isConnected ? s.trigger : null;
    if (target instanceof HTMLElement) { try { target.focus({ preventScroll: true }); } catch (_e) {} }
  }
  function openStream(s) {
    var b = bridge();
    if (!b || s.streamOpened) return;
    s.streamOpened = true;
    var opened = b.openStream ? Promise.resolve().then(function () { return b.openStream({ channels: ["async-tasks"] }); }) : Promise.resolve(null);
    opened.catch(function () { s.streamOpened = false; });
    if (typeof b.onFrame === "function") {
      try {
        s.unsubscribe = b.onFrame(function (frame) { applyFrame(s, frame); });
      } catch (_e) { s.unsubscribe = null; }
    }
  }
  function closeStreamSafe(s) {
    var b = bridge();
    s.streamOpened = false;
    if (s.unsubscribe) { try { s.unsubscribe(); } catch (_e) {} s.unsubscribe = null; }
    if (b && typeof b.closeStream === "function") { try { var p = b.closeStream(); if (p && typeof p.then === "function") p.catch(function () {}); } catch (_e) {} }
  }
  function terminalStatus(status) {
    return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
  }
  function pendingAbortRow(s, row) {
    if (!row || !row.id || !s.abortPending[row.id] || terminalStatus(row.status)) return row;
    return Object.assign({}, row, { status: "cancelling", allowedActions: [] });
  }
  function reconcileAbortPending(s, rows) {
    if (!Array.isArray(rows)) return rows;
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (row && row.id && terminalStatus(row.status)) delete s.abortPending[row.id];
    }
    return rows.map(function (row) { return pendingAbortRow(s, row); });
  }
  function loadRows(s, kind) {
    var b = bridge();
    if (!b || !s.agentId) {
      s.status = "error"; s.error = "Bot ativo indispon\u00edvel.";
      renderBody(s);
      return;
    }
    s.status = kind === "resync" ? "resync" : "loading";
    s.error = "";
    var token = (s.listToken = (s.listToken || 0) + 1);
    const pending = { token: token, snapshot: null, updates: new Map() };
    s.pendingList = pending;
    if (kind === "resync") {
      s.resyncRequired = true;
      s.resyncDirty = false;
      s.resyncRequestToken = token;
    }
    renderBody(s);
    Promise.resolve().then(function () { return b.getAsyncTasks({ agentId: s.agentId, limit: TASK_LIST_LIMIT }); }).then(function (rows) {
      if (!state || token !== s.listToken || s.closed) return;
      // Replay events received while the cursorless list was in flight.
      // An intervening snapshot replaces that older list altogether.
      const base = pending.snapshot || (Array.isArray(rows) ? rows.slice(-TASK_LIST_LIMIT) : []);
      const merged = new Map(base.map(row => [row.id, row]));
      for (const [id, row] of pending.updates) merged.set(id, row);
      s.rows = reconcileAbortPending(s, Array.from(merged.values()).slice(-TASK_LIST_LIMIT));
      s.pendingList = null;
      if (kind === "resync" && s.resyncRequestToken === token) {
        s.resyncDirty = false;
        s.resyncRequired = false;
        s.resyncRequestToken = 0;
        s.status = s.rows.length === 0 ? "empty" : "ready";
      } else if (s.status !== "resync") s.status = s.rows.length === 0 ? "empty" : "ready";
      renderBody(s);
    }).catch(function (err) {
      if (!state || token !== s.listToken || s.closed) return;
      s.pendingList = null;
      if (pending.snapshot) return;
      s.error = err && err.message ? err.message : String(err);
      s.status = "error";
      renderBody(s);
    });
  }
  function applyFrame(s, frame) {
    if (frame && frame.payload && typeof frame.payload === "object") frame = Object.assign({ channel: frame.channel }, frame.payload);
    if (frame && ((frame.channel && frame.channel !== "async-tasks") || (frame.agentId && frame.agentId !== s.agentId))) return;
    if (!frame || s.closed || !s.root || !s.root.isConnected || typeof frame.type !== "string") return;
    var type = frame.type;
    var epoch = typeof frame.epoch === "string" && frame.epoch ? frame.epoch : (s.epoch || "");
    var seq = typeof frame.sequence === "number" ? frame.sequence : -1;
    var items = Array.isArray(frame.tasks) ? frame.tasks : Array.isArray(frame.subagents) ? frame.subagents : null;
    if (type === "snapshot") {
      if (!s.resyncRequired && s.epoch === epoch && (s.seqByEpoch[epoch] ?? -1) >= seq) return;
      if (s.pendingList) {
        s.pendingList.snapshot = items ? items.slice(-TASK_LIST_LIMIT) : [];
        s.pendingList.updates.clear();
      }
      s.epoch = epoch;
      if (epoch) s.seqByEpoch[epoch] = seq;
      s.rows = reconcileAbortPending(s, items ? items.slice(-TASK_LIST_LIMIT) : []);
      s.resyncRequired = false;
      s.resyncDirty = false;
      s.resyncRequestToken = 0;
      s.status = s.rows.length === 0 ? "empty" : "ready";
      renderBody(s);
      return;
    }
    if (type === "update") {
      if (epoch && (s.seqByEpoch[epoch] ?? -1) >= seq) return;
      if (s.resyncRequired) s.resyncDirty = true;
      if (epoch) s.seqByEpoch[epoch] = seq;
      if (!items) return;
      if (s.pendingList) {
        for (const row of items) {
          s.pendingList.updates.delete(row.id);
          s.pendingList.updates.set(row.id, row);
        }
        while (s.pendingList.updates.size > TASK_LIST_LIMIT) s.pendingList.updates.delete(s.pendingList.updates.keys().next().value);
      }
      var byId = new Map();
      for (var i = 0; i < s.rows.length; i += 1) byId.set(s.rows[i].id, s.rows[i]);
      var nextItems = reconcileAbortPending(s, items);
      for (var j = 0; j < nextItems.length; j += 1) byId.set(nextItems[j].id, nextItems[j]);
      s.rows = Array.from(byId.values()).slice(-TASK_LIST_LIMIT);
      if (s.status !== "resync") s.status = s.rows.length === 0 ? "empty" : "ready";
      if (!renderTaskUpdates(s, nextItems)) renderBody(s);
      return;
    }
    if (type === "resync") {
      s.resyncRequired = true;
      s.resyncDirty = false;
      s.status = "resync";
      s.error = "";
      renderBody(s);
      loadRows(s, "resync");
    }
  }
  function activeSteerInput(s) {
    return s.root && s.root.querySelector ? s.root.querySelector(".obp22-steer input[data-task-id]") : null;
  }
  function rememberSteerEdit(s) {
    var input = activeSteerInput(s);
    if (!input) return;
    var id = input.getAttribute("data-task-id") || s.steerTaskId || "";
    if (!id) return;
    s.steerDrafts[id] = input.value;
    s.steerEdit = {
      taskId: id,
      focused: document.activeElement === input,
      start: typeof input.selectionStart === "number" ? input.selectionStart : null,
      end: typeof input.selectionEnd === "number" ? input.selectionEnd : null,
      direction: input.selectionDirection || "none",
      composing: Boolean(input.isComposing || s.steerComposing),
    };
  }
  function restoreSteerEdit(s) {
    var edit = s.steerEdit;
    if (!edit || !edit.taskId) return;
    var input = null;
    if (s.root && s.root.querySelectorAll) {
      input = Array.from(s.root.querySelectorAll(".obp22-steer input[data-task-id]")).find(function (candidate) {
        return candidate.getAttribute("data-task-id") === edit.taskId;
      }) || null;
    }
    if (!input) return;
    if (Object.prototype.hasOwnProperty.call(s.steerDrafts, edit.taskId)) input.value = s.steerDrafts[edit.taskId];
    if (!edit.focused || edit.composing) return;
    try {
      input.focus({ preventScroll: true });
      if (edit.start !== null && edit.end !== null && typeof input.setSelectionRange === "function") input.setSelectionRange(edit.start, edit.end, edit.direction);
    } catch (_e) {}
  }
  function patchRowPreservingSteer(existing, next) {
    var currentActions = existing.querySelector(".obp22-actions");
    var currentChildren = Array.from(existing.children);
    var nextChildren = Array.from(next.children);
    var nextActions = next.querySelector(".obp22-actions");
    if (!currentActions || !nextActions) {
      existing.replaceWith(next);
      return;
    }
    for (var i = 0; i < currentChildren.length; i += 1) {
      if (currentChildren[i] !== currentActions) currentChildren[i].remove();
    }
    for (var j = 0; j < nextChildren.length; j += 1) {
      if (nextChildren[j] !== nextActions) existing.insertBefore(nextChildren[j].cloneNode(true), currentActions);
    }
    existing.setAttribute("data-task-id", next.getAttribute("data-task-id") || "");
  }
  STATUS_TEXT.cancelling = "Cancelamento solicitado";
  function rowHtml(s, row) {
    var id = row.id || "";
    var status = STATUS_TEXT[row.status] || row.status || "Desconhecida";
    var parts = [];
    parts.push('<span class="obp22-badge' + (row.status === "failed" ? " is-failed" : (row.status === "running" || row.status === "queued" || row.status === "cancelling" ? " is-active" : "")) + '">' + esc(status) + "</span>");
    if (typeof row.attempt === "number" && row.attempt > 1) parts.push("<span class=obp22-meta>Tentativa " + row.attempt + "</span>");
    if (typeof row.startedAtMs === "number" && row.startedAtMs > 0) {
      if (terminalStatus(row.status)) {
        if (typeof row.finishedAtMs === "number" && row.finishedAtMs >= row.startedAtMs)
          parts.push("<span class=obp22-meta>Duração: " + esc(humanize(row.finishedAtMs - row.startedAtMs).replace(/^há /, "")) + "</span>");
      } else parts.push("<span class=obp22-meta>Iniciada " + esc(humanize(Date.now() - row.startedAtMs)) + "</span>");
    }
    var actions = "";
    var allowed = Array.isArray(row.allowedActions) ? row.allowedActions : [];
    if (row.status === "running" || row.status === "queued") {
      if (allowed.indexOf("abort") >= 0) actions += "<button type=button data-action=abort-task data-task-id=\"" + esc(id) + "\">Abortar</button>";
      if (allowed.indexOf("steer") >= 0) actions += "<button type=button data-action=steer-task data-task-id=\"" + esc(id) + "\">Redirecionar</button>";
    }
    var detail = (typeof row.detail === "string" && row.detail) ? "<div class=obp22-detail>" + esc(row.detail) + "</div>" : "";
    var progress = (row.progress && typeof row.progress.summary === "string" && row.progress.summary) ? "<div class=obp22-detail>" + esc(row.progress.summary) + "</div>" : "";
    var result = (row.result && row.result.kind === "inline" && typeof row.result.text === "string" && row.result.text) ? "<div class=obp22-detail>" + esc(row.result.text) + (row.result.truncated ? " \u2026" : "") + "</div>" : "";
    var error = (row.error && typeof row.error.message === "string" && row.error.message) ? "<div class=obp22-detail>" + esc(row.error.message) + "</div>" : "";
    var steer = "";
    if (s.steerTaskId === id) {
      var draft = Object.prototype.hasOwnProperty.call(s.steerDrafts, id) ? s.steerDrafts[id] : "";
      steer = "<div class=obp22-steer><input id=openbot-steer-input data-task-id=\"" + esc(id) + "\" aria-label='mensagem de redirecionamento' maxlength=4096 value=\"" + esc(draft) + "\" placeholder='Instru\u00e7\u00f5es adicionais (m\u00e1x. 4096)'>" +
        "<button type=button data-action=steer-send data-task-id=\"" + esc(id) + "\">Enviar</button>" +
        "<button type=button data-action=steer-cancel data-task-id=\"" + esc(id) + "\">Cancelar</button></div>";
    }
    return "<article class=ob-task-item data-task-id=\"" + esc(id) + "\"><div class=obp22-row><span class=obp22-label>" + esc(row.label || "") + "</span>" + parts.join("") + "</div>" + detail + progress + result + error + "<div class=obp22-actions>" + actions + steer + "</div></article>";
  }
  function renderTaskUpdates(s, items) {
    var body = s.root && s.root.querySelector ? s.root.querySelector(".obp22-body") : null;
    var list = body && body.querySelector ? body.querySelector(".obp22-list") : null;
    if (!list || !Array.isArray(items)) return false;
    rememberSteerEdit(s);
    var edit = s.steerEdit;
    for (var i = 0; i < items.length; i += 1) {
      var row = items[i];
      var wrapper = document.createElement("div");
      wrapper.innerHTML = rowHtml(s, row);
      var next = wrapper.firstElementChild;
      if (!next) continue;
      var existing = Array.from(list.children).find(function (child) { return child.getAttribute("data-task-id") === row.id; });
      if (existing && edit && edit.composing && edit.taskId === row.id) patchRowPreservingSteer(existing, next);
      else if (existing) existing.replaceWith(next);
      else list.appendChild(next);
    }
    var activeIds = new Set(s.rows.map(function (row) { return row.id; }));
    for (var child of Array.from(list.children)) {
      if (!activeIds.has(child.getAttribute("data-task-id"))) child.remove();
    }
    if (!s.steerComposing) restoreSteerEdit(s);
    return true;
  }
  function renderBody(s) {
    if (!state || !s.root || !s.root.isConnected) return;
    var body = s.root.querySelector(".obp22-body");
    if (!body) return;
    if (s.steerComposing && activeSteerInput(s)) { s.pendingRender = true; return; }
    rememberSteerEdit(s);
    var html = "";
    if (s.status === "resync") html += "<p class=obp22-status>Sincronizando\u2026</p>";
    if (s.status === "loading") html += "<p class=obp22-status>Carregando tarefas\u2026</p>";
    if (s.status === "error") html += "<p class=\"obp22-status obp22-alert\" role=alert>" + esc(s.error) + "</p><button type=button class=obp22-retry data-action=retry-tasks>Tentar novamente</button>";
    var rows = s.rows || [];
    if (s.status === "empty" || (rows.length === 0 && (s.status === "ready" || s.status === "resync"))) {
      html += "<p id=openbot-tasks-empty class=obp22-status>Nenhuma tarefa.</p>";
    } else if (rows.length > 0) {
      html += "<div class=obp22-list>" + rows.map(function (row) { return rowHtml(s, row); }).join("") + "</div>";
    }
    body.innerHTML = html;
    s.pendingRender = false;
    restoreSteerEdit(s);
  }
  function handleControl(s, action, btn) {
    var b = bridge();
    var id = btn && btn.dataset ? (btn.dataset.taskId || btn.dataset.taskid || "") : "";
    if (!b || !s.agentId) return;
    if (action === "abort-task") {
      if (!id || s.abortPending[id]) return;
      var previous = s.rows.find(function (row) { return row.id === id; });
      if (!previous || terminalStatus(previous.status)) return;
      s.abortPending[id] = true;
      s.abortPrevious[id] = previous;
      s.rows = s.rows.map(function (row) { return row.id === id ? Object.assign({}, row, { status: "cancelling", allowedActions: [] }) : row; });
      renderBody(s);
      var intent = intentId();
      Promise.resolve(b.abortAsyncTask({ agentId: s.agentId, taskId: id, intentId: intent, reason: "user" })).then(function () {
        // The RPC acknowledges acceptance only. Keep the row in cancelling
        // until a terminal status arrives through the authoritative list or
        // stream frame.
        if (!state || s.closed || !s.abortPending[id]) return;
      }).catch(function (err) {
        if (!state || s.closed) return;
        var current = s.rows.find(function (row) { return row.id === id; });
        if (current && terminalStatus(current.status)) { delete s.abortPending[id]; delete s.abortPrevious[id]; return; }
        delete s.abortPending[id];
        var restored = s.abortPrevious[id];
        delete s.abortPrevious[id];
        if (restored) s.rows = s.rows.map(function (row) { return row.id === id ? restored : row; });
        s.error = err && err.message ? err.message : String(err);
        s.status = "error";
        renderBody(s);
      });
      return;
    }
    if (action === "steer-task") { rememberSteerEdit(s); s.steerTaskId = id; s.steerEdit = null; renderBody(s); return; }
    if (action === "steer-cancel") { delete s.steerDrafts[id || s.steerTaskId || ""]; s.steerTaskId = null; s.steerEdit = null; renderBody(s); return; }
    if (action === "steer-send") {
      var input = document.getElementById("openbot-steer-input");
      rememberSteerEdit(s);
      var message = input ? input.value : "";
      if (!message) return;
      message = String(message).slice(0, 4096);
      var intent2 = intentId();
      Promise.resolve(b.steerAsyncTask({ agentId: s.agentId, taskId: id, intentId: intent2, message: message })).then(function () {
        if (!state || s.closed) return;
        delete s.steerDrafts[id];
        s.steerEdit = null;
        s.steerTaskId = null;
        renderBody(s);
      }).catch(function (err) {
        if (!state || s.closed) return;
        s.error = err && err.message ? err.message : String(err);
        s.status = "error";
        renderBody(s);
      });
      return;
    }
  }
  function open(trigger) {
    if (state) closeNow();
    var root = document.createElement("div");
    root.id = "openbot-tasks-dialog";
    root.innerHTML = "<div class=obp22-backdrop></div><section class=obp22-panel role=dialog aria-modal=true tabindex=-1><header class=obp22-head><h2>Tarefas</h2><button type=button class=\"obp22-close ob-toolbar-button\" data-action=close-dialog aria-label='Fechar'>Fechar</button></header><div class=obp22-body></div></section>";
    var style = document.createElement("style"); style.textContent = STYLE;
    document.body.appendChild(style); document.body.appendChild(root);
    var appRoot = document.getElementById("root");
    if (appRoot instanceof HTMLElement) appRoot.inert = true;
    var panel = root.querySelector(".obp22-panel"); if (panel) panel.focus({ preventScroll: true });
    var s = {
      root: root, style: style, trigger: trigger instanceof Element ? trigger : null, appRoot: appRoot,
      agentId: null, rows: [], status: "loading", error: "", seqByEpoch: {}, epoch: null,
      streamOpened: false, unsubscribe: null, closed: false, listToken: 0, pendingList: null, resyncRequired: false, resyncDirty: false, resyncRequestToken: 0, steerTaskId: null, steerDrafts: Object.create(null), steerEdit: null, steerComposing: false, pendingRender: false, abortPending: Object.create(null), abortPrevious: Object.create(null),
      onKeyDown: function (e) { if (e.key === "Escape") { e.preventDefault(); closeNow(); } },
      onPageHide: function () { closeNow(); },
    };
    state = s;
    document.addEventListener("keydown", s.onKeyDown, true);
    window.addEventListener("pagehide", s.onPageHide);
    root.addEventListener("mousedown", function (e) { if (e.target instanceof Element && e.target.classList.contains("obp22-backdrop")) closeNow(); });
    root.addEventListener("click", function (e) {
      var btn = e.target instanceof Element ? e.target.closest("button[data-action]") : null;
      if (!btn) return;
      var action = btn.getAttribute("data-action");
      if (action === "close-dialog") { closeNow(); return; }
      if (action === "retry-tasks") { loadRows(s, "retry"); return; }
      if (action === "abort-task" || action === "steer-task" || action === "steer-send" || action === "steer-cancel") { handleControl(s, action, btn); return; }
    });
    root.addEventListener("input", function (e) {
      var input = e.target instanceof Element ? e.target.closest(".obp22-steer input[data-task-id]") : null;
      if (!input || !s.root.contains(input)) return;
      rememberSteerEdit(s);
    });
    root.addEventListener("compositionstart", function (e) {
      var input = e.target instanceof Element ? e.target.closest(".obp22-steer input[data-task-id]") : null;
      if (!input || !s.root.contains(input)) return;
      s.steerComposing = true;
      rememberSteerEdit(s);
    });
    root.addEventListener("compositionend", function (e) {
      var input = e.target instanceof Element ? e.target.closest(".obp22-steer input[data-task-id]") : null;
      if (!input || !s.root.contains(input)) return;
      rememberSteerEdit(s);
      s.steerComposing = false;
      renderBody(s);
    });
    memoryAgent().then(function (agentId) {
      if (!state || s.closed) return;
      s.agentId = agentId || null;
      if (!agentId) {
        s.status = "error"; s.error = "Bot ativo indispon\u00edvel.";
        renderBody(s);
        return;
      }
      openStream(s);
      loadRows(s, "load");
    });
  }
  // The toolbar button lives in the v1 overlay markup (the same IIFE that
  // renders the toolbar), so re-renders never orphan it; this surface only
  // owns the dialog. No DOM observer is used here: v1 re-renders the toolbar
  // innerHTML on body mutations, and an insertion loop would fight it.
  window.openbotTasks = { open: open };
})();
