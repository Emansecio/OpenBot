/**
 * Runtime compartilhado dos gates e2e/Electron.
 *
 * Reúne três invariantes que antes existiam duplicadas (e incompletas) em cada
 * script:
 *
 * 1. connectCdp(url): websocket CDP com timeout no handshake (`ready`), timeout
 *    por chamada em `send()` e rejeição de calls pendentes quando o socket
 *    fecha. Sem isso, um Runtime.evaluate sem resposta trava o gate para
 *    sempre — um deadline loop externo não ajuda porque o await interno nunca
 *    resolve.
 *
 * 2. cleanE2eEnvironment(extra): copia process.env removendo variáveis que
 *    quebram ou contaminam o filho (ELECTRON_RUN_AS_NODE transforma o Electron
 *    em Node e todo spawn falha com "bad option"; vars de VITEST, NODE_OPTIONS
 *    e GATEWAY apontam o app para o estado errado). Os callers passam os
 *    overrides próprios via `extra`.
 *
 * 3. startE2eWatchdog(budgetMs, onTimeout): orçamento global do gate. Ao
 *    estourar, roda o cleanup (matar o filho) e sai com 124 — um gate nunca
 *    pode travar em silêncio.
 */

const STRIPPED_ENV_KEYS = [
  // Runner de teste que vaza para o filho
  "VITEST", "VITEST_WORKER_ID", "VITEST_POOL_ID",
  // Flags de Node/Electron que mudam o comportamento do processo spawnado
  "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE",
  // Estado do OpenBot que apontaria o filho para dados do usuário real
  "OPENBOT_DATA_ROOT", "OPENBOT_LOCAL_DATA_ROOT", "OPENBOT_LOCAL_GATEWAY",
  "OPENBOT_USER_DATA", "OPENBOT_LOG_DIR", "OPENBOT_INSTALL_ROOT",
  "OPENBOT_GATEWAY_TOKEN", "OPENBOT_GATEWAY_NETWORK_TOKEN", "OPENBOT_GATEWAY_TOKEN_PATH",
  // Gateway/controle que o script define explicitamente via extra
  "GATEWAY_TOKEN", "E2E_GATEWAY_TOKEN",
  "SAND_HOST_GATEWAY_URL", "SAND_HOST_GATEWAY_TOKEN", "SAND_HOST_GATEWAY_NETWORK_TOKEN",
  "SAND_DEV_BOX_CONTROL_PLANE", "SAND_USER_DATA_DIR", "SAND_DATA_ROOT",
];

export function cleanE2eEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  return { ...env, ...extra };
}

export function connectCdp(url, { readyTimeoutMs = 10_000, callTimeoutMs = 30_000 } = {}) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  let socketClosed = false;

  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error(`CDP websocket não abriu em ${readyTimeoutMs}ms`)),
      readyTimeoutMs,
    );
    const settle = (fn, value) => { clearTimeout(timer); fn(value); };
    socket.addEventListener("open", () => settle(resolveReady), { once: true });
    socket.addEventListener("error", () => settle(rejectReady, new Error("CDP websocket falhou ao conectar")), { once: true });
    socket.addEventListener("close", () => settle(rejectReady, new Error("CDP websocket fechou antes de abrir")), { once: true });
  });
  // A promise `ready` pode rejeitar antes de alguém a aguardar; evita
  // unhandledRejection encerrando o gate pelo motivo errado.
  ready.catch(() => undefined);

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const entry = pending.get(message?.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  socket.addEventListener("close", () => {
    socketClosed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("CDP websocket closed"));
    }
    pending.clear();
  });

  const send = (method, params = {}, timeoutMs = callTimeoutMs) => {
    if (socketClosed) return Promise.reject(new Error(`CDP websocket fechado antes de ${method}`));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} sem resposta em ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  };

  const close = () => {
    try { socket.close(); } catch { /* best-effort */ }
  };

  return { ws: socket, ready, send, close };
}

/**
 * Orçamento global do gate. Retorna função que desarma o timer (chamar ao
 * concluir com sucesso). `onTimeout` é awaited antes do exit — use para matar
 * o processo filho.
 */
export function startE2eWatchdog(budgetMs, onTimeout) {
  const timer = setTimeout(async () => {
    console.error(`e2e: orçamento de ${Math.round(budgetMs / 1000)}s excedido — gate abortado (exit 124)`);
    try {
      await onTimeout?.();
    } catch {
      // Cleanup best-effort; o exit acontece de qualquer forma.
    }
    process.exit(124);
  }, budgetMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}
