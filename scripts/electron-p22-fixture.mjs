/**
 * P2.2 — deterministic Electron fixture for the async-task / subagent surface.
 *
 * Runs against the REAL OpenBot overlay (client/extracted/dist/renderer/assets/
 * openbot-memory-ui.js) inside the real Electron renderer through CDP. The
 * fixture supplies a controllable `window.__openbotTasksUiBridge` (same
 * interface as the production preload bridge) and exercises loading, empty,
 * error, retry, reconnect/resync, active/completed/failed rows, attempt,
 * duration, sanitized progress, limited results, abort/steer controls,
 * Escape/focus restoration, pagehide teardown, no polling, no EventSource
 * accumulation and XSS-safe rendering, capturing verifiable screenshots.
 */
export const P22_TASK_IDS = { running: "task-running", queued: "task-queued", completed: "task-completed", failed: "task-failed", malicious: "task-malicious" };

export function p22DefaultRows(nowMs) {
  const startedMs = nowMs - 95_000;
  return [
    { id: "task-running", kind: "subagent", status: "running", label: "Analisar relatório", detail: "Gerando síntese…", startedAtMs: startedMs, attempt: 2, progress: { phase: "análise", summary: "Lendo 12 páginas do relatório…", completedUnits: 5, totalUnits: 12 }, allowedActions: ["abort", "steer"] },
    { id: "task-queued", kind: "subagent", status: "queued", label: "Baixar anexos", detail: "Na fila", startedAtMs: null, allowedActions: ["abort"] },
    { id: "task-completed", kind: "subagent", status: "completed", label: "Resumir reunião", detail: "Resumo em 8 tópicos.", startedAtMs: startedMs - 400_000, result: { kind: "inline", text: "1. Decisão A 2. Decisão B 3. Prazos 4. Riscos 5. Donos 6. Próximos passos 7. Ações 8. Pendências", bytes: 128, truncated: true }, allowedActions: [] },
    { id: "task-failed", kind: "subagent", status: "failed", label: "Gerar deploy", detail: "Credencial de produção expirou.", startedAtMs: startedMs - 200_000, finishedAtMs: startedMs - 162_000, error: { code: "provider_error", message: "Credencial de produção expirou.", retryable: false }, allowedActions: [] },
    { id: "task-malicious", kind: "subagent", status: "queued", label: "<img src=x onerror=window.__pwned=1>", detail: "<script>window.__pwned=2</script> & quot;", startedAtMs: null, allowedActions: ["abort"] },
  ];
}

/**
 * ctx: { evalExpr, shot, sleep, log } — returns evidence { ok, steps, ... }.
 */
export async function runP22TasksFixture(ctx) {
  const { evalExpr, shot, sleep, send, log = console.log } = ctx;
  const evidence = { ok: true, steps: [], screenshots: [], streamCounters: null, controlCalls: null };
  const step = (name, pass, detail) => { evidence.steps.push({ name, pass: Boolean(pass), detail: String(detail) }); if (!pass) evidence.ok = false; };
  const waitFor = async (expression, timeoutMs = 2500, intervalMs = 20) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await evalExpr(expression);
      if (last) return last;
      await sleep(intervalMs);
    }
    throw new Error(`P2.2 condition timed out: ${expression}; last=${JSON.stringify(last)}`);
  };
  // 1) Install the fixture bridge + page-side driver.
  await evalExpr("(() => { const fixture = { rows: [], frames: [], listCalls: 0, abortCalls: [], steerInputCalls: [], steerCalls: [], intervalCalls: 0, openStreamCalls: 0, closeStreamCalls: 0, activeStreams: 0, streamControllers: [], listGate: null, failNextList: { value: false }, loadedAgentIds: [] }; const originalSetInterval = window.setInterval; const nativeSetInterval = originalSetInterval.bind(window); window.setInterval = (...args) => { fixture.intervalCalls += 1; return nativeSetInterval(...args); }; const boundedUtf8 = (value, maxBytes) => { let output = ''; let bytes = 0; for (const codePoint of String(value)) { const size = new TextEncoder().encode(codePoint).length; if (bytes + size > maxBytes) break; output += codePoint; bytes += size; } return output; }; const stream = { async openStream(opts) { fixture.openStreamCalls += 1; fixture.activeStreams += 1; const controller = new AbortController(); fixture.streamControllers.push(controller); fixture.activeController = controller; return { channels: (opts && opts.channels) || ['async-tasks'] }; }, async closeStream() { fixture.closeStreamCalls += 1; fixture.activeStreams = Math.max(0, fixture.activeStreams - 1); if (fixture.activeController) { try { fixture.activeController.abort(); } catch {} fixture.activeController = null; } }, onFrame(listener) { fixture.frames.push(listener); return () => { fixture.frames = fixture.frames.filter((entry) => entry !== listener); }; }, async getAsyncTasks(args) { fixture.listCalls += 1; if (args && args.agentId) fixture.loadedAgentIds.push(args.agentId); if (fixture.failNextList.value) { fixture.failNextList.value = false; throw new Error('falha simulada de rede'); } const snapshot = fixture.rows.slice(); if (fixture.listGate) await fixture.listGate; fixture.listSettled = (fixture.listSettled || 0) + 1; return snapshot; }, async abortAsyncTask(args) { fixture.abortCalls.push(args || {}); const id = args && args.taskId; fixture.rows = fixture.rows.map((row) => row.id === id ? { ...row, status: 'cancelled', allowedActions: [] } : row); return { taskId: id, status: 'cancelled' }; }, async steerAsyncTask(args) { fixture.steerInputCalls.push(args || {}); const bounded = { ...(args || {}), message: boundedUtf8(args && args.message, 4096) }; fixture.steerCalls.push(bounded); return { taskId: args && args.taskId, status: 'requested' }; }, emit(frame) { for (const listener of fixture.frames) { try { listener(frame); } catch {} } }, setRows(rows) { fixture.rows = rows.slice(); }, setGate(value) { fixture.listGate = value; }, tracks() { return { listCalls: fixture.listCalls, abortCalls: fixture.abortCalls, steerInputCalls: fixture.steerInputCalls, steerCalls: fixture.steerCalls, intervalCalls: fixture.intervalCalls, openStreamCalls: fixture.openStreamCalls, closeStreamCalls: fixture.closeStreamCalls, activeStreams: fixture.activeStreams, streamControllers: fixture.streamControllers.length, frames: fixture.frames.length }; } }; fixture.restoreSetInterval = () => { window.setInterval = originalSetInterval; }; fixture.setRows = stream.setRows; fixture.setGate = stream.setGate; fixture.tracks = stream.tracks; fixture.emit = stream.emit; window.__obP22 = { stream, fixture }; window.__openbotTasksUiBridge = stream; window.confirm = () => true; return true; })()");
  const tracks = () => evalExpr("window.__obP22.fixture.tracks()");
  const trackSummary = (value) => JSON.stringify({
    listCalls: value.listCalls,
    abortCalls: value.abortCalls.length,
    steerCalls: value.steerCalls.length,
    intervalCalls: value.intervalCalls,
    openStreamCalls: value.openStreamCalls,
    closeStreamCalls: value.closeStreamCalls,
    activeStreams: value.activeStreams,
    frames: value.frames,
  });

  const openTasksDialog = async () => {
    await evalExpr("(() => { let button = document.getElementById('openbot-p22-task-trigger'); if (!(button instanceof HTMLButtonElement)) { button = document.createElement('button'); button.id = 'openbot-p22-task-trigger'; button.type = 'button'; button.setAttribute('aria-label', 'Tarefas'); button.textContent = 'Tarefas'; button.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000'; document.body.appendChild(button); } if (typeof window.openbotTasks?.open !== 'function') return false; button.focus(); window.openbotTasks.open(button); return true; })()");
    await waitFor("Boolean(document.getElementById('openbot-tasks-dialog'))");
  };

  // 2) Loading and empty states through the real overlay flow.
  // The gate is installed BEFORE opening so the first load blocks on it and
  // the real overlay renders the loading state.
  await evalExpr("window.__obP22.fixture.setGate(new Promise((resolve) => { window.__obP22.__resolveGate = resolve; }))");
  await openTasksDialog();
  let dialogCheck = await evalExpr("(() => { const dialog = document.getElementById('openbot-tasks-dialog'); const panel = dialog && dialog.querySelector('[role=dialog]'); return { exists: Boolean(dialog), role: panel ? panel.getAttribute('role') : null, modal: panel ? panel.getAttribute('aria-modal') : null, bodyText: dialog ? (dialog.innerText || '') : '' }; })()");
  step("tasks dialog opens with modal semantics", dialogCheck.exists && dialogCheck.role === "dialog" && dialogCheck.modal === "true", JSON.stringify(dialogCheck));
  step("tasks loading state", /Carregando tarefas/.test(dialogCheck.bodyText), dialogCheck.bodyText.slice(0, 120));
  await evalExpr("window.__obP22.__resolveGate(null); window.__obP22.fixture.setGate(null)");
  await waitFor("Boolean(document.getElementById('openbot-tasks-empty'))");
  dialogCheck = await evalExpr("(() => { const dialog = document.getElementById('openbot-tasks-dialog'); return { bodyText: dialog ? (dialog.innerText || '') : '', empty: Boolean(dialog && document.getElementById('openbot-tasks-empty')) }; })()");
  step("tasks empty state", dialogCheck.empty && /Nenhuma tarefa/.test(dialogCheck.bodyText), JSON.stringify(dialogCheck));
  await evalExpr("document.querySelector('#openbot-tasks-dialog [data-action=close-dialog]')?.click()");
  await waitFor("!document.getElementById('openbot-tasks-dialog')");

  // 3) Error + retry (failure flag is armed BEFORE the dialog opens).
  await evalExpr("window.__obP22.fixture.failNextList.value = true");
  await openTasksDialog();
  await waitFor("Boolean(document.querySelector('#openbot-tasks-dialog [role=alert]'))");
  const errorState = await evalExpr("(() => { const dialog = document.getElementById('openbot-tasks-dialog'); return { alert: Boolean(dialog && dialog.querySelector('[role=alert]')), retry: Boolean(dialog && dialog.querySelector('[data-action=retry-tasks]')), text: dialog ? (dialog.innerText || '') : '' }; })()");
  step("tasks error + retry shown", errorState.alert && errorState.retry, JSON.stringify(errorState));
  await evalExpr("document.querySelector('#openbot-tasks-dialog [data-action=retry-tasks]')?.click()");
  await waitFor("Boolean(document.getElementById('openbot-tasks-empty'))");
  const retried = await evalExpr("(() => { const dialog = document.getElementById('openbot-tasks-dialog'); return { empty: Boolean(dialog && document.getElementById('openbot-tasks-empty')), alert: Boolean(dialog && dialog.querySelector('[role=alert]')) }; })()");
  step("tasks retry recovers", retried.empty && !retried.alert, JSON.stringify(retried));
  await evalExpr("document.querySelector('#openbot-tasks-dialog [data-action=close-dialog]')?.click()");
  await waitFor("!document.getElementById('openbot-tasks-dialog')");
  // An older initial RPC response must never undo a later stream completion.
  await evalExpr("window.__obP22.fixture.setRows([{id:'race-task',status:'running',label:'Delayed list fixture',allowedActions:[]}]); window.__obP22.fixture.setGate(new Promise(resolve=>window.__obP22.__releaseInitial=resolve)); window.__obP22.__settledBefore=window.__obP22.fixture.listSettled||0");
  await openTasksDialog();
  await waitFor("/Carregando tarefas/.test(document.getElementById('openbot-tasks-dialog')?.innerText||'')");
  await evalExpr(`(() => {
    const agentId=window.__obP22.fixture.loadedAgentIds.at(-1);
    window.__obP22.stream.emit({channel:'async-tasks',payload:{type:'snapshot',channel:'async-tasks',agentId,epoch:'initial-race',sequence:1,tasks:[{id:'race-task',status:'running',label:'Delayed list fixture',allowedActions:[]}]}});
    window.__obP22.stream.emit({channel:'async-tasks',payload:{type:'update',channel:'async-tasks',agentId,epoch:'initial-race',sequence:2,tasks:[{id:'race-task',status:'completed',label:'Delayed list fixture',allowedActions:[]}]}});
    window.__obP22.__releaseInitial(); window.__obP22.fixture.setGate(null);
  })()`);
  await waitFor("window.__obP22.fixture.listSettled > window.__obP22.__settledBefore");
  const initialRace = await evalExpr("document.querySelector('#openbot-tasks-dialog .ob-task-item')?.innerText || ''");
  step("late initial list preserves newer wrapped stream completion", /Concluída/.test(initialRace) && !/Em andamento/.test(initialRace), initialRace);
  await evalExpr("document.querySelector('#openbot-tasks-dialog [data-action=close-dialog]').click()");
  await waitFor("!document.getElementById('openbot-tasks-dialog')");

  // 4) Mixed states: active, completed, failed, queued, attempt, duration,
  //    sanitized progress, limited result and allowed actions.
  await evalExpr("window.__obP22.fixture.setRows(" + JSON.stringify(p22DefaultRows(Date.now())) + ")");
  const rowsSet = await evalExpr("window.__obP22.fixture.rows.length");
  log("P22_ROWS_SET", rowsSet);
  await openTasksDialog();
  await waitFor("document.querySelectorAll('#openbot-tasks-dialog .ob-task-item').length === 5");
  log("P22_DIALOG_4", await evalExpr("({ articles: document.querySelectorAll('#openbot-tasks-dialog .ob-task-item').length, rows: window.__obP22.fixture.rows.length, text: (document.getElementById('openbot-tasks-dialog') || {}).innerText?.slice(0, 220) ?? '' })"));
  const mixed = await evalExpr("(() => { const dialog = document.getElementById('openbot-tasks-dialog'); const text = dialog ? dialog.innerText : ''; const rows = [...(dialog ? dialog.querySelectorAll('.ob-task-item') : [])]; const byId = {}; for (const row of rows) byId[row.dataset.taskId] = row; const actionsOf = (id) => [...(byId[id] ? byId[id].querySelectorAll('[data-action=abort-task],[data-action=steer-task]') : [])].map((el) => el.getAttribute('data-action')); const pwned = typeof window.__pwned === 'number' ? window.__pwned : null; const injectedImg = Boolean(dialog && dialog.querySelector('.ob-task-item img')); const injectedScript = Boolean(dialog && dialog.querySelector('.ob-task-item script')); const malicious = byId['task-malicious'] ? (byId['task-malicious'].innerText || '') : ''; return { count: rows.length, hasRunning: /Analisar relatório/.test(text), hasCompleted: /Resumir reunião/.test(text), hasFailed: /Gerar deploy/.test(text), progress: /Lendo 12 páginas/.test(text), attempt: /Tentativa 2/.test(text), duration: /há 1m 35s/.test(text), resultTruncated: /…/.test(text), errorShown: /Credencial de produção expirou/.test(text), runningActions: actionsOf('task-running').join(','), queuedActions: actionsOf('task-queued').join(','), failedActions: actionsOf('task-failed').join(','), maliciousText: malicious, pwned, injectedImg, injectedScript, badgeFailed: Boolean(byId['task-failed']) && /Falhou/.test(byId['task-failed'].innerText || '') }; })()");
  log("P22_MIXED", JSON.stringify(mixed, null, 2));
  step("tasks mixed states render", mixed.count === 5 && mixed.hasRunning && mixed.hasCompleted && mixed.hasFailed && mixed.progress && mixed.attempt && mixed.duration && mixed.resultTruncated && mixed.errorShown && mixed.badgeFailed, JSON.stringify(mixed));
  const badges = await evalExpr("(() => {const active=document.querySelector('[data-task-id=task-running] .obp22-badge');const failed=document.querySelector('[data-task-id=task-failed]');return {active:active?.classList.contains('is-active'),failed:failed?.querySelector('.obp22-badge')?.classList.contains('is-failed'),duration:failed?.innerText.includes('Duração: 38s'),duplicate:failed?.innerText.includes('há ')}})()");
  step("badge classes and terminal duration are semantic DOM state", badges.active && badges.failed && badges.duration && !badges.duplicate, JSON.stringify(badges));
  step("controls respect allowedActions", mixed.runningActions.indexOf("abort") >= 0 && mixed.runningActions.indexOf("steer") >= 0 && mixed.queuedActions.indexOf("abort") >= 0 && mixed.queuedActions.indexOf("steer") < 0 && mixed.failedActions === "", JSON.stringify(mixed));
  step("malicious content rendered as text (XSS)", mixed.maliciousText.indexOf("<img src=") >= 0 && mixed.pwned === null && !mixed.injectedImg && !mixed.injectedScript, JSON.stringify(mixed));
  const modalGeometry = await evalExpr("(() => { const root = document.getElementById('openbot-tasks-dialog'); const panel = root?.querySelector('.obp22-panel'); const head = panel?.querySelector('.obp22-head'); const body = panel?.querySelector('.obp22-body'); const close = panel?.querySelector('.obp22-close'); const rect = panel?.getBoundingClientRect(); const panelStyle = panel ? getComputedStyle(panel) : null; const bodyStyle = body ? getComputedStyle(body) : null; const closeStyle = close ? getComputedStyle(close) : null; const topElement = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12) : null; return { width: rect?.width || 0, height: rect?.height || 0, fits: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight), radius: panelStyle?.borderRadius || null, headHeight: head?.getBoundingClientRect().height || 0, bodyPadding: bodyStyle?.padding || null, closeWidth: close?.getBoundingClientRect().width || 0, closeHeight: close?.getBoundingClientRect().height || 0, closeRadius: closeStyle?.borderRadius || null, topmost: Boolean(topElement?.closest('#openbot-tasks-dialog')) }; })()");
  step("tasks modal matches Grok geometry and stacking", Math.abs(modalGeometry.width - 860) <= 1 && Math.abs(modalGeometry.height - 620) <= 1 && modalGeometry.fits && modalGeometry.radius === "14px" && Math.abs(modalGeometry.headHeight - 54) <= 1 && modalGeometry.bodyPadding === "24px" && Math.abs(modalGeometry.closeWidth - 30) <= 1 && Math.abs(modalGeometry.closeHeight - 30) <= 1 && modalGeometry.closeRadius === "6px" && modalGeometry.topmost, JSON.stringify(modalGeometry));
  const modalHeader = await evalExpr("(() => { const head = document.querySelector('#openbot-tasks-dialog .obp22-head'); const title = head?.querySelector('h2'); const close = head?.querySelector('.obp22-close'); const titleStyle = title ? getComputedStyle(title) : null; const closeStyle = close ? getComputedStyle(close) : null; return { text: head?.innerText || '', titleVisible: Boolean(title && title.getClientRects().length && titleStyle?.visibility !== 'hidden' && titleStyle?.opacity !== '0'), closeVisible: Boolean(close && close.getClientRects().length && closeStyle?.visibility !== 'hidden' && closeStyle?.opacity !== '0') }; })()");
  step("tasks modal keeps header and close action visible after refresh", /Tarefas/.test(modalHeader.text) && modalHeader.titleVisible && modalHeader.closeVisible, JSON.stringify(modalHeader));
  await shot("p22-tasks-mixed");
  if (typeof send === "function") {
    await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 640, deviceScaleFactor: 1, mobile: false });
    await waitFor("innerWidth === 820 && innerHeight === 640");
    const compact = await evalExpr("(() => { const panel = document.querySelector('#openbot-tasks-dialog .obp22-panel'); const rect = panel?.getBoundingClientRect(); return rect ? { fits: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight, horizontalOverflow: panel.scrollWidth > panel.clientWidth, width: rect.width, height: rect.height } : null; })()");
    step("tasks modal stays contained in compact window", compact?.fits === true && compact?.horizontalOverflow === false, JSON.stringify(compact));
    await shot("p22-tasks-compact");
    await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    await waitFor("innerWidth === 1024 && innerHeight === 768");
  }

  // 5) Abort control through the typed bridge.
  await evalExpr("(() => { const row = document.querySelector('.ob-task-item[data-task-id=task-running]'); const button = row && row.querySelector('[data-action=abort-task]'); if (button) button.click(); return Boolean(button); })()");
  const abortPending = await waitFor("/Cancelamento solicitado/.test(document.querySelector('.ob-task-item[data-task-id=task-running]')?.innerText || '')");
  step("abort acknowledgement stays pending until a terminal frame", abortPending === true, String(abortPending));
  await evalExpr("window.__obP22.stream.emit({ type: 'update', channel: 'async-tasks', epoch: 'p22-abort-epoch', sequence: 1, tasks: [{ id: 'task-running', kind: 'subagent', status: 'cancelled', label: 'Analisar relatório', allowedActions: [] }] })");
  await waitFor("/Cancelada/.test(document.querySelector('.ob-task-item[data-task-id=task-running]')?.innerText || '')");
  let control = await tracks();
  step("abort reaches the typed bridge with ownership", control.abortCalls.length === 1 && control.abortCalls[0].taskId === "task-running" && control.abortCalls[0].reason === "user" && typeof control.abortCalls[0].agentId === "string" && Boolean(control.abortCalls[0].intentId), JSON.stringify(control.abortCalls));
  const afterAbort = await evalExpr("(() => { const dialog = document.getElementById('openbot-tasks-dialog'); const row = dialog && dialog.querySelector('.ob-task-item[data-task-id=task-running]'); return { status: row ? /Cancelada/.test(row.innerText || '') : false, abortGone: row ? !row.querySelector('[data-action=abort-task]') : true }; })()");
  step("aborted task is terminal and loses controls", afterAbort.status && afterAbort.abortGone, JSON.stringify(afterAbort));
  // Restore a steerable running task for the steer phase: refresh the list via
  // the real overlay flow (close + reopen pulls the restored rows).
  await evalExpr("document.querySelector('#openbot-tasks-dialog [data-action=close-dialog]')?.click()");
  await waitFor("!document.getElementById('openbot-tasks-dialog')");
  await evalExpr("window.__obP22.fixture.setRows(" + JSON.stringify(p22DefaultRows(Date.now())) + ")");
  await openTasksDialog();
  await waitFor("document.querySelectorAll('#openbot-tasks-dialog .ob-task-item').length === 5");

  // 6) Steer control with a bounded malicious message.
  await evalExpr("(() => { const row = document.querySelector('.ob-task-item[data-task-id=task-running]'); const button = row && row.querySelector('[data-action=steer-task]'); if (button) button.click(); return Boolean(button); })()");
  await waitFor("Boolean(document.getElementById('openbot-steer-input'))");
  const steerEditBefore = await evalExpr("(() => { const input = document.getElementById('openbot-steer-input'); if (!input) return null; input.value = 'draft steer'; input.focus(); input.setSelectionRange(2, 7); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('compositionstart', { bubbles: true })); return { value: input.value, focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd }; })()");
  await evalExpr("window.__obP22.stream.emit({ type: 'update', channel: 'async-tasks', epoch: 'p22-steer-epoch', sequence: 1, tasks: [{ id: 'task-running', kind: 'subagent', status: 'running', label: 'Analisar relatório atualizado', detail: 'Atualização durante composição', allowedActions: ['steer'] }] })");
  const steerEditAfter = await waitFor("(() => { const input = document.getElementById('openbot-steer-input'); return Boolean(input && input.value === 'draft steer' && document.activeElement === input && input.selectionStart === 2 && input.selectionEnd === 7); })()");
  step("steer draft focus selection and composition survive task update", Boolean(steerEditBefore && steerEditAfter), JSON.stringify({ before: steerEditBefore, after: await evalExpr("(() => { const input = document.getElementById('openbot-steer-input'); return input ? { value: input.value, focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd } : null; })()") }));
  await evalExpr("document.getElementById('openbot-steer-input')?.dispatchEvent(new Event('compositionend', { bubbles: true }))");
  const steerInput = await evalExpr("(() => { const input = document.getElementById('openbot-steer-input'); if (input) { input.value = '\u00e9'.repeat(2049) + '<script>window.__pwned=3</script>'; input.dispatchEvent(new Event('input', { bubbles: true })); } return Boolean(input); })()");
  step("steer opens bounded inline input", steerInput, "");
  await evalExpr("document.querySelector('#openbot-tasks-dialog [data-action=steer-send]')?.click()");
  await waitFor("window.__obP22.fixture.tracks().steerCalls.length === 1");
  control = await tracks();
  const rawSteerMessage = control.steerInputCalls[0]?.message ?? "";
  const boundedSteerMessage = control.steerCalls[0]?.message ?? "";
  step("steer reaches the typed bridge bounded by UTF-8 bytes", control.steerCalls.length === 1 && control.steerCalls[0].taskId === "task-running" && Buffer.byteLength(rawSteerMessage, "utf8") > 4096 && Buffer.byteLength(boundedSteerMessage, "utf8") <= 4096 && boundedSteerMessage.endsWith("\u00e9") && !boundedSteerMessage.includes("\ufffd"), JSON.stringify({ rawBytes: Buffer.byteLength(rawSteerMessage, "utf8"), boundedBytes: Buffer.byteLength(boundedSteerMessage, "utf8"), boundedEndsWith: boundedSteerMessage.slice(-1) }));
  const pwnedAfter = await evalExpr("window.__pwned ?? null");
  step("steer message never injects DOM", pwnedAfter === null, String(pwnedAfter));

  // 7) Reconnect / resync: snapshot replaces; monotonic update upserts;
  //    stale cursor deduped; resync marker surfaces; no polling anywhere.
  const syncPush = (frame) => evalExpr("window.__obP22.__pendingFrame = " + JSON.stringify(frame) + "; window.__obP22.__pendingFrame.agentId = window.__obP22.fixture.loadedAgentIds.at(-1); window.__obP22.__pendingFrame.parentAgentId = window.__obP22.__pendingFrame.agentId; window.__obP22.stream.emit(window.__obP22.__pendingFrame)");
  const rowsForSync = p22DefaultRows(Date.now() - 95_000).map((row) => (row.id === "task-running" ? { ...row, status: "cancelled", allowedActions: [] } : row));
  await syncPush({ type: "snapshot", channel: "async-tasks", agentId: "agent-a", parentAgentId: "agent-a", epoch: "p22-epoch-1", sequence: 7, tasks: rowsForSync, resyncRequired: true, reason: "cursor-stale-or-gap" });
  await waitFor("/Cancelada/.test(document.querySelector('.ob-task-item[data-task-id=task-running]')?.innerText || '')");
  const afterSnapshot = await evalExpr("(() => { const dialog = document.getElementById('openbot-tasks-dialog'); const rows = [...(dialog ? dialog.querySelectorAll('.ob-task-item') : [])]; const ids = rows.map((row) => row.dataset.taskId); return { count: rows.length, unique: new Set(ids).size, sync: /Sincronizando/.test(dialog ? dialog.innerText : ''), cancelled: rows.find((row) => row.dataset.taskId === 'task-running')?.innerText.includes('Cancelada') || false }; })()");
  step("resync snapshot replaces without duplicates", afterSnapshot.count === 5 && afterSnapshot.unique === 5 && afterSnapshot.cancelled && !afterSnapshot.sync, JSON.stringify(afterSnapshot));
  await syncPush({ type: "update", channel: "async-tasks", agentId: "agent-a", parentAgentId: "agent-a", epoch: "p22-epoch-1", sequence: 8, tasks: [{ id: "task-completed", kind: "subagent", status: "completed", label: "Resumir reunião", detail: "NOVA síntese", startedAtMs: 1, result: { kind: "inline", text: "Novo resumo limitado", bytes: 20, truncated: false } }], resyncRequired: false });
  await waitFor("/NOVA síntese/.test(document.querySelector('.ob-task-item[data-task-id=task-completed]')?.innerText || '')");
  const afterUpdate = await evalExpr("(() => { const dialog = document.getElementById('openbot-tasks-dialog'); const rows = [...(dialog ? dialog.querySelectorAll('.ob-task-item') : [])]; const done = rows.find((row) => row.dataset.taskId === 'task-completed'); return { count: rows.length, unique: new Set(rows.map((row) => row.dataset.taskId)).size, newText: done ? /NOVA síntese/.test(done.innerText || '') : false, resultText: done ? /Novo resumo limitado/.test(done.innerText || '') : false }; })()");
  step("monotonic update upserts by id", afterUpdate.count === 5 && afterUpdate.unique === 5 && afterUpdate.newText && afterUpdate.resultText, JSON.stringify(afterUpdate));
  await syncPush({ type: "update", channel: "async-tasks", agentId: "agent-a", parentAgentId: "agent-a", epoch: "p22-epoch-1", sequence: 4, tasks: [{ id: "task-queued", kind: "subagent", status: "failed", label: "STALE", detail: "must be ignored", startedAtMs: null }] });
  await waitFor("!/STALE/.test(document.querySelector('.ob-task-item[data-task-id=task-queued]')?.innerText || '')");
  const afterStale = await evalExpr("(() => { const dialog = document.getElementById('openbot-tasks-dialog'); const rows = [...(dialog ? dialog.querySelectorAll('.ob-task-item') : [])]; const queued = rows.find((row) => row.dataset.taskId === 'task-queued'); return { count: rows.length, staleGone: queued ? !/STALE/.test(queued.innerText || '') : true }; })()");
  step("stale cursor update is deduplicated", afterStale.count === 5 && afterStale.staleGone, JSON.stringify(afterStale));
  await evalExpr("window.__obP22.fixture.setGate(new Promise((resolve) => { window.__obP22.__resolveResync = resolve; }))");
  await syncPush({ type: "resync", channel: "async-tasks", agentId: "agent-a", parentAgentId: "agent-a", epoch: "p22-epoch-2", sequence: 1, resyncRequired: true, reason: "epoch-mismatch" });
  await waitFor("/Sincronizando/.test(document.getElementById('openbot-tasks-dialog')?.innerText || '')");
  const syncShown = await evalExpr("/Sincronizando/.test(document.getElementById('openbot-tasks-dialog')?.innerText || '')");
  step("resync marker surfaces the resync state", syncShown === true, String(syncShown));
  await evalExpr("window.__obP22.__resolveResync(); window.__obP22.fixture.setGate(null)");
  await waitFor("!/Sincronizando/.test(document.getElementById('openbot-tasks-dialog')?.innerText || '')");
  const syncCleared = await evalExpr("!/Sincronizando/.test(document.getElementById('openbot-tasks-dialog')?.innerText || '')");
  step("authoritative resync list clears the recovery state", syncCleared === true, String(syncCleared));

  // 8) Escape closes the dialog and restores focus.
  await evalExpr("(() => { const panel = document.querySelector('#openbot-tasks-dialog [role=dialog]'); if (panel) panel.focus({ preventScroll: true }); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true; })()");
  await waitFor("!document.getElementById('openbot-tasks-dialog')");
  const escaped = await evalExpr("(() => ({ open: Boolean(document.getElementById('openbot-tasks-dialog')), appInert: document.getElementById('root')?.inert === true, focusLabel: document.activeElement?.getAttribute('aria-label') || document.activeElement?.dataset?.action || null }))()");
  step("Escape closes and restores focus", escaped.open === false && escaped.appInert === false && (escaped.focusLabel === "Tarefas" || escaped.focusLabel === "tasks"), JSON.stringify(escaped));

  // 9) Close/reopen cycle keeps exactly one active stream (never duplicates).
  await evalExpr("window.__obP22.fixture.setRows([])");
  await evalExpr("document.querySelector('#openbot-tasks-dialog')?.remove()");
  await openTasksDialog();
  await waitFor("window.__obP22.fixture.tracks().activeStreams === 1");
  const reopened1 = await tracks();
  step("reopen keeps exactly one active stream", reopened1.activeStreams === 1 && reopened1.openStreamCalls >= 1, trackSummary(reopened1));
  await evalExpr("document.querySelector('#openbot-tasks-dialog [data-action=close-dialog]')?.click()");
  await waitFor("window.__obP22.fixture.tracks().activeStreams === 0");
  const afterClose = await tracks();
  step("close stops the stream", afterClose.activeStreams === 0 && afterClose.closeStreamCalls >= 1, trackSummary(afterClose));
  await openTasksDialog();
  await waitFor("window.__obP22.fixture.tracks().activeStreams === 1");
  const reopened2 = await tracks();
  step("second open has again a single active stream", reopened2.activeStreams === 1 && reopened2.closeStreamCalls >= 1 && reopened2.openStreamCalls > reopened1.openStreamCalls, trackSummary(reopened2));
  await evalExpr("document.querySelector('#openbot-tasks-dialog [data-action=close-dialog]')?.click()");
  await waitFor("window.__obP22.fixture.tracks().activeStreams === 0");

  // 10) Prove an idle open overlay neither polls nor creates interval timers.
  await openTasksDialog();
  await waitFor("window.__obP22.fixture.tracks().activeStreams === 1");
  const beforeIdle = await tracks();
  await sleep(350);
  const afterIdle = await tracks();
  step("idle overlay does not poll or create interval timers", afterIdle.listCalls === beforeIdle.listCalls && afterIdle.intervalCalls === 0, JSON.stringify({ beforeListCalls: beforeIdle.listCalls, afterListCalls: afterIdle.listCalls, intervalCalls: afterIdle.intervalCalls }));

  // 11) pagehide teardown: dialog, listeners and stream closed exactly once.
  const beforePagehide = await tracks();
  await evalExpr("window.dispatchEvent(new Event('pagehide'))");
  await waitFor("!document.getElementById('openbot-tasks-dialog') && window.__obP22.fixture.tracks().activeStreams === 0");
  const teardown = await tracks();
  const teardownDom = await evalExpr("(() => { const dialog = document.getElementById('openbot-tasks-dialog'); return { dialogOpen: Boolean(dialog), appInert: document.getElementById('root')?.inert === true }; })()");
  step("pagehide closes dialog and stream", teardownDom.dialogOpen === false && teardownDom.appInert === false, JSON.stringify(teardownDom));
  step("pagehide tears down stream once (no accumulation)", teardown.closeStreamCalls === beforePagehide.closeStreamCalls + 1 && teardown.activeStreams === 0 && teardown.frames === 0, `${trackSummary(beforePagehide)} -> ${trackSummary(teardown)}`);
  await evalExpr("(() => { window.__obP22?.fixture?.restoreSetInterval?.(); document.getElementById('openbot-p22-task-trigger')?.remove(); return true; })()");

  const finalTracks = await tracks().catch(() => null);
  evidence.streamCounters = finalTracks ? {
    listCalls: finalTracks.listCalls,
    intervalCalls: finalTracks.intervalCalls,
    openStreamCalls: finalTracks.openStreamCalls,
    closeStreamCalls: finalTracks.closeStreamCalls,
    activeStreams: finalTracks.activeStreams,
    frames: finalTracks.frames,
  } : null;
  evidence.controlCalls = {
    abort: finalTracks ? finalTracks.abortCalls.map(({ agentId, taskId, reason }) => ({ agentId, taskId, reason })) : null,
    steer: finalTracks ? finalTracks.steerCalls.map(({ agentId, taskId, message }) => ({ agentId, taskId, messageBytes: Buffer.byteLength(message || "", "utf8") })) : null,
  };
  evidence.screenshots = ["p22-tasks-mixed", "p22-tasks-compact"];
  return evidence;
}
