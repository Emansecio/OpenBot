import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { resolveElectronExecutable } from "./electron-executable.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(process.env.OPENBOT_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const exe = resolveElectronExecutable(repoRoot);
const electronMain = process.env.OPENBOT_ELECTRON_MAIN || join(repoRoot, "client", "extracted", "dist", "electron-main", "main.cjs");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not allocate a free port");
  return port;
}

async function waitCdp(cdpUrl, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const targets = await (await fetch(cdpUrl)).json();
      const page = targets.find((target) => target.title === "OpenBot" && target.type === "page");
      if (page) return page;
    } catch {}
    await sleep(400);
  }
  throw new Error("CDP OpenBot page not found");
}

async function stopProcessTree(child, exited) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } catch {}
  } else if (!child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  await Promise.race([exited, sleep(5000)]);
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let next = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });
  const send = (method, params = {}) => {
    const id = next++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return { ws, ready, send };
}

function createGatewayState() {
  const now = Date.now();
  return {
    activeAgentId: "agent-a",
    calls: [],
    conversationsByAgent: {
      "agent-a": [
        { id: "conv-a-1", agentId: "agent-a", title: "Nova conversa", titleSource: "auto", temporary: false, archivedAtMs: null, createdAtMs: now - 10_000, updatedAtMs: now - 10_000, lastMessageAtMs: null },
      ],
      "agent-b": [
        { id: "conv-b-1", agentId: "agent-b", title: "Nova conversa", titleSource: "auto", temporary: false, archivedAtMs: null, createdAtMs: now - 9_000, updatedAtMs: now - 9_000, lastMessageAtMs: null },
      ],
    },
    activeConversationByAgent: {
      "agent-a": "conv-a-1",
      "agent-b": "conv-b-1",
    },
    memorySettings: {
      "agent-a": { agentId: "agent-a", mode: "automatic", updatedAtMs: now - 2_000, internalOnly: "ignore" },
      "agent-b": { agentId: "agent-b", mode: "off", updatedAtMs: now - 1_500, internalOnly: "ignore" },
    },
    memoriesByAgent: {
      "agent-a": [
        { id: "mem-a-1", kind: "fact", canonicalKey: "mem-a-1", text: "memória real A", trust: "verified_tool", status: "active", importance: 50, confidence: 1, pinned: false, sourceConversationId: "conv-a-1", sourceEntryIds: [{ conversationId: "conv-a-1", entryId: "entry-a-1" }], validFromMs: now - 5_000, validToMs: null, expiresAtMs: null, createdAtMs: now - 5_000, updatedAtMs: now - 5_000 },
        { id: "mem-a-2", kind: "fact", canonicalKey: "mem-a-2", text: "memória antiga A", trust: "verified_tool", status: "forgotten", importance: 20, confidence: 0.5, pinned: false, sourceConversationId: "conv-a-1", sourceEntryIds: [{ conversationId: "conv-a-1", entryId: "entry-a-2" }], validFromMs: now - 8_000, validToMs: null, expiresAtMs: null, createdAtMs: now - 8_000, updatedAtMs: now - 7_000 },
      ],
      "agent-b": [
        { id: "mem-b-1", kind: "preference", canonicalKey: "mem-b-1", text: "memória real B", trust: "user", status: "active", importance: 75, confidence: 1, pinned: true, sourceConversationId: "conv-b-1", sourceEntryIds: [{ conversationId: "conv-b-1", entryId: "entry-b-1" }], validFromMs: now - 4_000, validToMs: null, expiresAtMs: null, createdAtMs: now - 4_000, updatedAtMs: now - 4_000 },
      ],
    },
    summariesByConversation: {
      "conv-a-1": { conversationId: "conv-a-1", throughSequenceId: 7, revision: 2, updatedAtMs: now - 1_000, renderedText: "resumo real A" },
      "conv-b-1": { conversationId: "conv-b-1", throughSequenceId: 3, revision: 1, updatedAtMs: now - 900, renderedText: "resumo real B" },
    },
    historyMessagesByAgent: {
      "agent-a": [
        { conversationId: "conv-a-1", sequenceId: 11, content: "mensagem real A" },
      ],
      "agent-b": [
        { conversationId: "conv-b-1", sequenceId: 21, content: "mensagem real B" },
      ],
    },
    jobStatusByAgent: {
      "agent-a": {
        pending: 1,
        running: 0,
        retry: 1,
        deadSample: [{ id: "job-a-dead-1", conversationId: "conv-a-1", attempts: 3, lastErrorCode: "timeout" }],
      },
      "agent-b": {
        pending: 0,
        running: 0,
        retry: 0,
        deadSample: [],
      },
    },
  };
}

function json(res, statusCode, value) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function envelope(value) {
  return { ok: true, value };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function failure(message, statusCode = 400) {
  return { statusCode, body: { ok: false, failure: { message } } };
}

function requireAgent(state, request) {
  const agentId = typeof request?.agentId === "string" && request.agentId ? request.agentId : state.activeAgentId;
  if (agentId !== state.activeAgentId) return { error: failure(`stale agent ${agentId}`, 409) };
  return { agentId };
}

function listPage(state, agentId) {
  const items = [...(state.conversationsByAgent[agentId] ?? [])]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs || right.id.localeCompare(left.id));
  return { items: clone(items), nextCursor: null };
}

function getConversation(state, agentId, conversationId) {
  return (state.conversationsByAgent[agentId] ?? []).find((item) => item.id === conversationId) ?? null;
}

function getLiveConversations(state, agentId) {
  return (state.conversationsByAgent[agentId] ?? []).filter((item) => item.archivedAtMs === null);
}

function getActiveConversation(state, agentId) {
  return getConversation(state, agentId, state.activeConversationByAgent[agentId]) ?? null;
}

function getMemoryStatusPayload(state, agentId, conversationId) {
  const memories = state.memoriesByAgent[agentId] ?? [];
  const active = memories.filter((memory) => memory.status === "active");
  const inactive = memories.filter((memory) => memory.status !== "active");
  const jobs = state.jobStatusByAgent[agentId] ?? { pending: 0, running: 0, retry: 0, deadSample: [] };
  const summary = conversationId ? state.summariesByConversation[conversationId] ?? null : null;
  return {
    agentId,
    settings: clone(state.memorySettings[agentId]),
    conversationId: conversationId ?? null,
    summary: summary === null ? null : {
      conversationId: summary.conversationId,
      throughSequenceId: summary.throughSequenceId,
      revision: summary.revision,
      updatedAtMs: summary.updatedAtMs,
      renderedTextBytes: Buffer.byteLength(summary.renderedText, "utf8"),
    },
    counts: {
      active: active.length,
      pinned: active.filter((memory) => memory.pinned).length,
      inactive: inactive.length,
      jobs: {
        pending: jobs.pending,
        running: jobs.running,
        retry: jobs.retry,
        dead: jobs.deadSample.length,
      },
    },
    jobs: {
      pending: jobs.pending,
      running: jobs.running,
      retry: jobs.retry,
      dead: clone(jobs.deadSample),
      deadCount: jobs.deadSample.length,
    },
  };
}

function searchHistory(state, agentId, query, conversationId, limit) {
  const normalized = String(query || "").trim().toLocaleLowerCase();
  const matchesConversation = (value) => conversationId === undefined || value === conversationId;
  const results = [];
  for (const memory of state.memoriesByAgent[agentId] ?? []) {
    if (!matchesConversation(memory.sourceConversationId) || !memory.text.toLocaleLowerCase().includes(normalized)) continue;
    results.push({
      kind: "memory",
      snippet: memory.text,
      score: 10,
      agentId,
      conversationId: memory.sourceConversationId,
      sequenceId: null,
      provenance: {
        source: "memory",
        memoryId: memory.id,
        sourceEntryIds: clone(memory.sourceEntryIds ?? []),
      },
      memory: clone(memory),
    });
  }
  for (const [id, summary] of Object.entries(state.summariesByConversation)) {
    if (!matchesConversation(id) || !summary.renderedText.toLocaleLowerCase().includes(normalized)) continue;
    results.push({
      kind: "summary",
      snippet: summary.renderedText,
      score: 8,
      agentId,
      conversationId: id,
      sequenceId: summary.throughSequenceId,
      provenance: { source: "summary" },
      summary: {
        conversationId: id,
        agentId,
        revision: summary.revision,
        throughSequenceId: summary.throughSequenceId,
        summaryJson: { preview: true },
        renderedText: summary.renderedText,
        updatedAtMs: summary.updatedAtMs,
        retained: false,
      },
    });
  }
  for (const message of state.historyMessagesByAgent[agentId] ?? []) {
    if (!matchesConversation(message.conversationId) || !message.content.toLocaleLowerCase().includes(normalized)) continue;
    results.push({
      kind: "message",
      snippet: message.content,
      score: 6,
      agentId,
      conversationId: message.conversationId,
      sequenceId: message.sequenceId,
      provenance: { source: "transcript" },
    });
  }
  return clone(results.slice(0, limit));
}

function buildGateway(state, token) {
  return createServer(async (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      json(res, 401, { ok: false, failure: { message: "unauthorized" } });
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const method = url.pathname.replace(/^\/api\//, "");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8") || "{}";
    const body = JSON.parse(raw);
    state.calls.push({ method, body: JSON.parse(JSON.stringify(body || {})) });
    if (method === "getProviderConfig") return json(res, 200, envelope(state.providerConfigs?.[body.agentId || state.activeAgentId] || { agentId: state.activeAgentId, provider: "xai", model: "grok-4.6", reasoningEffort: "medium" }));
    if (method === "setProviderConfig") {
      const saved = { ...body, agentId: body.agentId ?? state.activeAgentId };
      (state.providerConfigs ||= {})[saved.agentId] = saved;
      return json(res, 200, envelope(saved));
    }
    if (method === "getPromptStatus") return json(res, 200, envelope({ isBusy: false, canCancel: false, agentId: state.activeAgentId }));
    if (method === "getAgentDefaultModel") return json(res, 200, envelope({ model: "grok-4.6" }));
    if (method === "getAvailableModels") return json(res, 200, envelope([{ id: "grok-4.6", name: "grok-4.6", default: true, provider: "xai" }, { id: "gpt-5.6-sol", provider: "openai" }, { id: "opencode-go/glm-5.3", provider: "opencode-go" }]));
    if (method === "getProviderOAuthStatus") return json(res, 200, envelope({ provider: body.provider, state: "connected" }));
    if (method === "setBoxSecrets") return json(res, 200, envelope({ synced: true, upserted: ["opencode-go"], deleted: [] }));
    if (method === "getBoxSecretsStatus") return json(res, 200, envelope({ keys: ["opencode-go"] }));
    if (method === "getProviderModelCatalog") {
      const provider = body.provider;
      const mode = state.catalogMode?.[provider] || "fresh";
      const ids = { xai: "grok-4.6", openai: "gpt-5.6-sol", "opencode-go": "opencode-go/glm-5.3" };
      const result = { provider, state: mode === "error" ? "stale" : mode === "removed" ? "fresh" : mode === "slow" ? "fresh" : mode, source: "remote", access: provider === "opencode-go" ? "public" : "connection", updatedAt: Date.now(), models: mode === "empty" ? [] : [{ id: ids[provider], provider, displayName: ids[provider], selectable: mode !== "removed", ...(mode === "removed" ? { reason: "Modelo ausente do último catálogo recebido." } : {}), ...(provider === "openai" ? { supportedReasoningEfforts: ["high"], serviceTiers: mode === "no-fast" ? [] : ["priority"] } : {}) }, { id: provider + "/pending", provider, selectable: false, reason: "Metadados pendentes" }], ...(mode === "error" ? { error: "Falha local de catálogo" } : {}) };
      if (mode === "slow") await sleep(500);
      return json(res, 200, envelope(result));
    }
    if (method === "getHostSettings") return json(res, 200, envelope({ pinnedAgents: [], sidebarSections: [] }));

    if (["listConversations", "getActiveConversation", "createConversation", "activateConversation", "getMemorySettings", "setMemorySettings", "listMemories", "listMemoriesPage"].includes(method)) {
      const checked = requireAgent(state, body);
      if (checked.error) return json(res, checked.error.statusCode, checked.error.body);
      const agentId = checked.agentId;
      if (method === "listConversations") return json(res, 200, envelope(listPage(state, agentId)));
      if (method === "getActiveConversation") return json(res, 200, envelope(clone(getActiveConversation(state, agentId))));
      if (method === "createConversation") {
        const now = Date.now();
        const id = `conv-${agentId}-${randomUUID().slice(0, 8)}`;
        const conversation = {
          id,
          agentId,
          title: typeof body?.title === "string" && body.title.trim() ? body.title.trim() : "Nova conversa",
          titleSource: typeof body?.title === "string" && body.title.trim() ? "manual" : "auto",
          temporary: body?.temporary === true,
          archivedAtMs: null,
          createdAtMs: now,
          updatedAtMs: now,
          lastMessageAtMs: null,
        };
        state.conversationsByAgent[agentId] = [conversation, ...(state.conversationsByAgent[agentId] || [])];
        state.activeConversationByAgent[agentId] = id;
        return json(res, 200, envelope({ conversation: clone(conversation), page: listPage(state, agentId) }));
      }
      if (method === "activateConversation") {
        state.activeConversationByAgent[agentId] = body.conversationId;
        return json(res, 200, envelope({ conversation: clone(getConversation(state, agentId, body.conversationId)), page: listPage(state, agentId) }));
      }
      if (method === "getMemorySettings") return json(res, 200, envelope(clone(state.memorySettings[agentId])));
      if (method === "setMemorySettings") {
        state.memorySettings[agentId] = { agentId, mode: body.mode, updatedAtMs: Date.now(), internalOnly: "ignore" };
        return json(res, 200, envelope(clone(state.memorySettings[agentId])));
      }
      if (method === "listMemories") {
        const includeInactive = body?.includeInactive === true;
        const items = (state.memoriesByAgent[agentId] || []).filter((memory) => includeInactive || memory.status === "active");
        return json(res, 200, envelope(clone(items.slice(0, body?.limit ?? 100))));
      }
      if (method === "listMemoriesPage") {
        const includeInactive = body?.includeInactive === true;
        const query = String(body?.query || "").trim().toLocaleLowerCase();
        const offset = typeof body?.cursor === "string" && /^memory:\d+$/.test(body.cursor)
          ? Number(body.cursor.slice("memory:".length))
          : 0;
        const limit = Math.max(1, Math.min(200, Number(body?.limit) || 20));
        const items = (state.memoriesByAgent[agentId] || [])
          .filter((memory) => includeInactive || memory.status === "active")
          .filter((memory) => !query || memory.text.toLocaleLowerCase().includes(query));
        const pageItems = items.slice(offset, offset + limit);
        const nextOffset = offset + pageItems.length;
        return json(res, 200, envelope({
          items: clone(pageItems),
          ...(nextOffset < items.length ? { nextCursor: `memory:${nextOffset}` } : {}),
        }));
      }
    }
    if (["renameConversation", "archiveConversation", "deleteConversation", "updateMemory", "deleteMemory", "getMemoryStatus", "searchMemoryHistory"].includes(method)) {
      const checked = requireAgent(state, body);
      if (checked.error) return json(res, checked.error.statusCode, checked.error.body);
      const agentId = checked.agentId;
      if (method === "renameConversation") {
        const now = Date.now();
        const conversation = getConversation(state, agentId, body.conversationId);
        if (!conversation) return json(res, 404, { ok: false, failure: { message: "conversation not found" } });
        conversation.title = body.title.trim();
        conversation.titleSource = "manual";
        conversation.updatedAtMs = now;
        return json(res, 200, envelope(clone(conversation)));
      }
      if (method === "archiveConversation") {
        const now = Date.now();
        const conversation = getConversation(state, agentId, body.conversationId);
        if (!conversation) return json(res, 404, { ok: false, failure: { message: "conversation not found" } });
        conversation.archivedAtMs = now;
        conversation.updatedAtMs = now;
        if (state.activeConversationByAgent[agentId] === conversation.id) {
          const next = getLiveConversations(state, agentId).find((item) => item.id !== conversation.id) ?? null;
          if (next) state.activeConversationByAgent[agentId] = next.id;
        }
        return json(res, 200, envelope({ conversation: clone(conversation), page: listPage(state, agentId) }));
      }
      if (method === "deleteConversation") {
        const index = (state.conversationsByAgent[agentId] || []).findIndex((item) => item.id === body.conversationId);
        if (index < 0) return json(res, 404, { ok: false, failure: { message: "conversation not found" } });
        state.conversationsByAgent[agentId].splice(index, 1);
        if (state.activeConversationByAgent[agentId] === body.conversationId) {
          state.activeConversationByAgent[agentId] = getLiveConversations(state, agentId)[0]?.id ?? null;
        }
        return json(res, 200, envelope({
          conversationId: body.conversationId,
          memoryPolicy: body.memoryPolicy ?? "delete-derived",
          conversation: clone(getActiveConversation(state, agentId)),
          page: listPage(state, agentId),
        }));
      }
      if (method === "updateMemory") {
        const memory = (state.memoriesByAgent[agentId] || []).find((item) => item.id === body.memoryId);
        if (!memory) return json(res, 404, { ok: false, failure: { message: "memory not found" } });
        memory.text = typeof body.text === "string" && body.text.trim() ? body.text.trim() : memory.text;
        memory.pinned = typeof body.pinned === "boolean" ? body.pinned : memory.pinned;
        memory.importance = Number.isInteger(body.importance) ? body.importance : memory.importance;
        memory.trust = "user";
        memory.updatedAtMs = Date.now();
        return json(res, 200, envelope(clone(memory)));
      }
      if (method === "deleteMemory") {
        const memory = (state.memoriesByAgent[agentId] || []).find((item) => item.id === body.memoryId);
        if (!memory) return json(res, 404, { ok: false, failure: { message: "memory not found" } });
        memory.status = "forgotten";
        memory.updatedAtMs = Date.now();
        return json(res, 200, envelope(clone(memory)));
      }
      if (method === "getMemoryStatus") return json(res, 200, envelope(getMemoryStatusPayload(state, agentId, body?.conversationId)));
      if (method === "searchMemoryHistory") return json(res, 200, envelope(searchHistory(state, agentId, body?.query, body?.conversationId, body?.limit ?? 10)));
    }
    return json(res, 404, { ok: false, failure: { message: `unknown method ${method}` } });
  });
}

export async function runBridgeRealVerify() {
  let runRoot;
  let evidenceDir;
  let child;
  let exited = Promise.resolve();
  const state = createGatewayState();
  const token = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 24);
  const gateway = buildGateway(state, token);
  try {
    runRoot = mkdtempSync(join(tmpdir(), "openbot-bridge-real-"));
    const userData = join(runRoot, "user-data");
    const appData = join(runRoot, "appdata");
    const localAppData = join(runRoot, "localappdata");
    const dataRoot = join(runRoot, "data-root");
    mkdirSync(join(repoRoot, "logs"), { recursive: true });
    evidenceDir = mkdtempSync(join(repoRoot, "logs", "bridge-real-verify-"));
    mkdirSync(userData, { recursive: true });
    mkdirSync(appData, { recursive: true });
    mkdirSync(localAppData, { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(join(dataRoot, "gateway.token"), `${token}\n`, "utf8");
    const gatewayPort = await getFreePort();
    await new Promise((resolve, reject) => {
      gateway.once("error", reject);
      gateway.listen(gatewayPort, "127.0.0.1", resolve);
    });

    const cdpPort = await getFreePort();
    const cdpUrl = `http://127.0.0.1:${cdpPort}/json/list`;
    child = spawn(exe, [
      `--user-data-dir=${userData}`,
      "--no-sandbox",
      "--disable-gpu",
      `--remote-debugging-port=${cdpPort}`,
      electronMain,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        OPENBOT_USER_DATA: userData,
        OPENBOT_DATA_ROOT: dataRoot,
        OPENBOT_LOCAL_GATEWAY: "1",
        OPENBOT_VISUAL_TEST: "1",
        SAND_HOST_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
        SAND_HOST_GATEWAY_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exited = new Promise((resolve) => child.once("close", resolve));
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));

    const page = await waitCdp(cdpUrl);
    const { ws, ready, send } = connect(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    await send("Page.enable");
    await sleep(2500);
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };

    await evaluate(`document.getElementById("openbot-welcome-continue")?.click()`);
    await sleep(400);
    const bridge = await evaluate(`({
      hasDesktop: typeof window.desktop === "object",
      hasAgent: typeof window.desktop?.agent === "object",
      createConversation: typeof window.desktop?.agent?.createConversation === "function",
      listConversations: typeof window.desktop?.agent?.listConversations === "function",
      activateConversation: typeof window.desktop?.agent?.activateConversation === "function",
      getMemorySettings: typeof window.desktop?.agent?.getMemorySettings === "function",
      setMemorySettings: typeof window.desktop?.agent?.setMemorySettings === "function",
      listMemories: typeof window.desktop?.agent?.listMemories === "function",
      listMemoriesPage: typeof window.desktop?.agent?.listMemoriesPage === "function",
    })`);
    if (!bridge?.hasDesktop || !bridge?.hasAgent || !bridge?.createConversation || !bridge?.listConversations || !bridge?.activateConversation || !bridge?.getMemorySettings || !bridge?.setMemorySettings || !bridge?.listMemories || !bridge?.listMemoriesPage) {
      throw new Error(`desktop bridge incomplete: ${JSON.stringify(bridge)}`);
    }

    const call = async (method, args) => {
      const reload = ["createConversation", "activateConversation", "archiveConversation", "deleteConversation"].includes(method);
      const before = reload ? await evaluate("performance.timeOrigin") : null;
      const expression = `(async () => {
        const value = await window.desktop.agent[${JSON.stringify(method)}](${JSON.stringify(args)});
        ${reload ? 'sessionStorage.setItem("openbot-bridge-result", JSON.stringify(value));' : ""}
        return value;
      })()`;
      const result = await evaluate(expression).catch((error) => {
        if (!reload || !/Inspected target navigated or closed|Execution context was destroyed/u.test(error.message)) throw error;
      });
      if (!reload) return result;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const ready = await evaluate(`performance.timeOrigin !== ${before} && typeof window.desktop?.agent === "object"`).catch(() => false);
        if (ready) return evaluate('JSON.parse(sessionStorage.getItem("openbot-bridge-result"))');
        await sleep(50);
      }
      throw new Error(`renderer did not reload after ${method}`);
    };
    const providerA = await call("getProviderConfig");
    const providerSaved = await call("setProviderConfig", { agentId: "agent-a", provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "high" });
    const memoryStatusBefore = await call("getMemoryStatus", { agentId: "agent-a", expectedAgentId: "agent-a", conversationId: "conv-a-1" });
    const created = await call("createConversation", { agentId: "agent-a", expectedAgentId: "agent-a", title: "Bridge Real A" });
    const activeAfterCreate = await call("getActiveConversation", { agentId: "agent-a", expectedAgentId: "agent-a" });
    const renamed = await call("renameConversation", { agentId: "agent-a", expectedAgentId: "agent-a", conversationId: created.conversation.id, title: "Bridge Real Renamed" });
    const listed = await call("listConversations", { agentId: "agent-a", expectedAgentId: "agent-a", limit: 50 });
    const activated = await call("activateConversation", { agentId: "agent-a", expectedAgentId: "agent-a", conversationId: created.conversation.id });
    const activeConversation = await call("getActiveConversation", { agentId: "agent-a", expectedAgentId: "agent-a" });
    const archived = await call("archiveConversation", { agentId: "agent-a", expectedAgentId: "agent-a", conversationId: created.conversation.id });
    const deletable = await call("createConversation", { agentId: "agent-a", expectedAgentId: "agent-a", title: "Delete Me" });
    const deleted = await call("deleteConversation", { agentId: "agent-a", expectedAgentId: "agent-a", conversationId: deletable.conversation.id, memoryPolicy: "retain" });
    const memoryBefore = await call("getMemorySettings", { agentId: "agent-a", expectedAgentId: "agent-a" });
    const memoryAfter = await call("setMemorySettings", { agentId: "agent-a", expectedAgentId: "agent-a", mode: "explicit" });
    const updatedMemory = await call("updateMemory", { agentId: "agent-a", expectedAgentId: "agent-a", memoryId: "mem-a-1", text: "memória editada real A", pinned: true, importance: 91 });
    const memories = await call("listMemories", { agentId: "agent-a", expectedAgentId: "agent-a", includeInactive: true, limit: 20 });
    const memoryPageOne = await call("listMemoriesPage", { agentId: "agent-a", expectedAgentId: "agent-a", includeInactive: true, limit: 1 });
    const memoryPageTwo = await call("listMemoriesPage", { agentId: "agent-a", expectedAgentId: "agent-a", includeInactive: true, limit: 1, cursor: memoryPageOne.nextCursor });
    const memoryStatusAfter = await call("getMemoryStatus", { agentId: "agent-a", expectedAgentId: "agent-a", conversationId: "conv-a-1" });
    const history = await call("searchMemoryHistory", { agentId: "agent-a", expectedAgentId: "agent-a", query: "real", limit: 10 });
    const deletedMemory = await call("deleteMemory", { agentId: "agent-a", expectedAgentId: "agent-a", memoryId: "mem-a-1" });
    const activeMemoriesAfterDelete = await call("listMemories", { agentId: "agent-a", expectedAgentId: "agent-a", limit: 20 });
    const allMemoriesAfterDelete = await call("listMemories", { agentId: "agent-a", expectedAgentId: "agent-a", includeInactive: true, limit: 20 });
    const realResult = { providerA, providerSaved, memoryStatusBefore, created, activeAfterCreate, renamed, listed, activated, activeConversation, archived, deletable, deleted, memoryBefore, memoryAfter, updatedMemory, memories, memoryPageOne, memoryPageTwo, memoryStatusAfter, history, deletedMemory, activeMemoriesAfterDelete, allMemoriesAfterDelete };

    if (realResult.providerA?.agentId !== "agent-a") throw new Error(`provider A mismatch: ${JSON.stringify(realResult.providerA)}`);
    if (realResult.providerSaved?.reasoningEffort !== "high") throw new Error(`reasoning effort bridge mismatch: ${JSON.stringify(realResult.providerSaved)}`);
    const providerSaveCalls = state.calls.filter((entry) => entry.method === "setProviderConfig");
    if (providerSaveCalls.length !== 1 || providerSaveCalls[0]?.body?.reasoningEffort !== "high") {
      throw new Error(`reasoning effort missing from gateway payload: ${JSON.stringify(providerSaveCalls)}`);
    }
    if (realResult.memoryStatusBefore?.summary?.renderedTextBytes !== Buffer.byteLength("resumo real A", "utf8")) {
      throw new Error(`memory status before mismatch: ${JSON.stringify(realResult.memoryStatusBefore)}`);
    }
    if (realResult.created?.conversation?.title !== "Bridge Real A") throw new Error(`create conversation failed: ${JSON.stringify(realResult.created)}`);
    if (realResult.activeAfterCreate?.id !== realResult.created.conversation.id || realResult.activeAfterCreate?.agentId !== "agent-a") {
      throw new Error(`create conversation did not become active immediately: ${JSON.stringify(realResult.activeAfterCreate)}`);
    }
    if (realResult.renamed?.title !== "Bridge Real Renamed" || realResult.renamed?.titleSource !== "manual") {
      throw new Error(`rename conversation failed: ${JSON.stringify(realResult.renamed)}`);
    }
    if (!Array.isArray(realResult.listed?.items) || !realResult.listed.items.some((item) => item.id === realResult.created.conversation.id)) {
      throw new Error(`list conversations failed: ${JSON.stringify(realResult.listed)}`);
    }
    if (realResult.activated?.conversation?.id !== realResult.created.conversation.id) throw new Error(`activate failed: ${JSON.stringify(realResult.activated)}`);
    if (realResult.activeConversation?.id !== realResult.created.conversation.id || realResult.activeConversation?.agentId !== "agent-a") {
      throw new Error(`get active conversation failed: ${JSON.stringify(realResult.activeConversation)}`);
    }
    if (realResult.archived?.conversation?.id !== realResult.created.conversation.id || realResult.archived?.conversation?.archivedAtMs === null) {
      throw new Error(`archive failed: ${JSON.stringify(realResult.archived)}`);
    }
    if (realResult.deleted?.conversationId !== realResult.deletable?.conversation?.id || realResult.deleted?.memoryPolicy !== "retain") {
      throw new Error(`delete failed: ${JSON.stringify(realResult.deleted)}`);
    }
    if (realResult.memoryBefore?.mode !== "automatic" || realResult.memoryAfter?.mode !== "explicit") throw new Error(`memory settings bridge failed: ${JSON.stringify({ before: realResult.memoryBefore, after: realResult.memoryAfter })}`);
    if ("internalOnly" in (realResult.memoryBefore || {}) || "internalOnly" in (realResult.memoryAfter || {})) throw new Error("memory settings leaked internal fields");
    if (realResult.updatedMemory?.text !== "memória editada real A" || realResult.updatedMemory?.pinned !== true || realResult.updatedMemory?.importance !== 91) {
      throw new Error(`update memory failed: ${JSON.stringify(realResult.updatedMemory)}`);
    }
    if (!Array.isArray(realResult.memories) || !realResult.memories.some((item) => item.text === "memória editada real A") || !realResult.memories.some((item) => item.status === "forgotten")) {
      throw new Error(`list memories failed: ${JSON.stringify(realResult.memories)}`);
    }
    if (realResult.memoryPageOne?.items?.length !== 1 || typeof realResult.memoryPageOne?.nextCursor !== "string" || realResult.memoryPageTwo?.items?.length !== 1 || realResult.memoryPageOne.items[0]?.id === realResult.memoryPageTwo.items[0]?.id) {
      throw new Error(`memory pagination failed: ${JSON.stringify({ pageOne: realResult.memoryPageOne, pageTwo: realResult.memoryPageTwo })}`);
    }
    if (realResult.memoryStatusAfter?.counts?.active !== 1 || realResult.memoryStatusAfter?.counts?.pinned !== 1 || realResult.memoryStatusAfter?.counts?.inactive !== 1) {
      throw new Error(`memory status counts mismatch: ${JSON.stringify(realResult.memoryStatusAfter)}`);
    }
    if (realResult.memoryStatusAfter?.jobs?.dead?.length !== 1 || realResult.memoryStatusAfter?.jobs?.dead?.[0]?.lastErrorCode !== "timeout") {
      throw new Error(`memory status jobs mismatch: ${JSON.stringify(realResult.memoryStatusAfter)}`);
    }
    if (!Array.isArray(realResult.history) || !["memory", "summary", "message"].every((kind) => realResult.history.some((item) => item.kind === kind))) {
      throw new Error(`history search failed: ${JSON.stringify(realResult.history)}`);
    }
    if (realResult.deletedMemory?.id !== "mem-a-1" || realResult.deletedMemory?.status !== "forgotten") {
      throw new Error(`delete memory failed: ${JSON.stringify(realResult.deletedMemory)}`);
    }
    if (realResult.activeMemoriesAfterDelete?.some((item) => item.id === "mem-a-1")) {
      throw new Error(`delete memory still visible in active list: ${JSON.stringify(realResult.activeMemoriesAfterDelete)}`);
    }
    if (!realResult.allMemoriesAfterDelete?.some((item) => item.id === "mem-a-1" && item.status === "forgotten")) {
      throw new Error(`delete memory missing from inactive list: ${JSON.stringify(realResult.allMemoriesAfterDelete)}`);
    }

    const createCallsBeforeMismatch = state.calls.filter((entry) => entry.method === "createConversation").length;
    state.activeAgentId = "agent-b";
    const mismatch = await evaluate(`window.desktop.agent.createConversation({ agentId: "agent-a", expectedAgentId: "agent-a", title: "stale attempt" }).then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, message: String(error?.message || error) }))`);
    if (mismatch.ok !== false || !/stale/i.test(mismatch.message || "")) throw new Error(`stale mismatch did not fail: ${JSON.stringify(mismatch)}`);
    const createCallsAfterMismatch = state.calls.filter((entry) => entry.method === "createConversation").length;
    if (createCallsAfterMismatch !== createCallsBeforeMismatch) throw new Error(`stale mismatch reached gateway createConversation: ${JSON.stringify({ before: createCallsBeforeMismatch, after: createCallsAfterMismatch })}`);
    const providerB = await evaluate(`window.desktop.agent.getProviderConfig()`);
    if (providerB?.agentId !== "agent-b") throw new Error(`provider B mismatch: ${JSON.stringify(providerB)}`);
    const deleteMemoryCalls = state.calls.filter((entry) => entry.method === "deleteMemory");
    if (deleteMemoryCalls.length !== 1 || deleteMemoryCalls[0]?.body?.memoryId !== "mem-a-1") {
      throw new Error(`delete memory call log mismatch: ${JSON.stringify(deleteMemoryCalls)}`);
    }

    const catalogUi = await verifyCatalogUi(evaluate, send, state, evidenceDir);
    const report = {
      catalogUi,
      bridge,
      realResult,
      mismatch,
      providerB,
      calls: state.calls,
    };
    writeFileSync(join(evidenceDir, "bridge-real-report.json"), JSON.stringify(report, null, 2), "utf8");
    console.log("BRIDGE_REAL_EVIDENCE_DIR", evidenceDir);
    console.log("BRIDGE_REAL_GREEN");
    ws.close();
    return { evidenceDir, report };
  } finally {
    await stopProcessTree(child, exited);
    if (gateway.listening) await new Promise((resolve) => gateway.close(resolve));
    if (runRoot) rmSync(runRoot, { recursive: true, force: true });
  }
}

async function verifyCatalogUi(evaluate, send, state, evidenceDir) {
  // The extracted app and real preload/main IPC remain active. Only the host
  // panel and remote catalog responses are fixtures; the overlay is unmodified.
  state.catalogMode = {};
  state.providerConfigs = {};
  await evaluate(`(() => {
    const dialog = document.createElement('div');
    dialog.id = 'catalog-ui-fixture'; dialog.setAttribute('role', 'dialog');
    dialog.style.cssText = 'position:fixed;inset:10px;z-index:99999;background:#202020;color:white;overflow:auto;padding:20px';
    dialog.innerHTML = '<div id="sand-settings-panel-general"><h2>General</h2></div>';
    (document.getElementById('root') || document.body).appendChild(dialog);
    window.__openbotLocalSettingsScan?.();
  })()`);
  const inspect = () => evaluate(`(() => {
    const model = document.getElementById('openbot-model');
    const reasoning = document.getElementById('openbot-reasoning');
    return { fixture: Boolean(document.getElementById("catalog-ui-fixture")), page: location.href, panel: document.getElementById("sand-settings-panel-general")?.outerHTML.slice(0,1000), provider: document.getElementById('openbot-provider')?.value, model: model?.value,
      disabled: model?.selectedOptions[0]?.disabled,
      options: [...(model?.options || [])].map(o => ({ id:o.value, disabled:o.disabled })),
      reasoning: [...(reasoning?.options || [])].map(o => ({ id:o.value, disabled:o.disabled })),
      status: document.getElementById('openbot-model-status')?.textContent,
      saveStatus: document.getElementById('openbot-status')?.textContent,
      busy: document.getElementById('openbot-model-refresh')?.disabled };
  })()`);
  const wait = async predicate => {
    const started = Date.now();
    let value;
    while (Date.now() - started < 8000) {
      value = await inspect();
      if (predicate(value)) return value;
      await sleep(80);
    }
    throw new Error(`Catalog UI did not settle: ${JSON.stringify(value)}`);
  };
  const switchProvider = provider => evaluate(`(() => {
    const select = document.getElementById('openbot-provider');
    select.value = ${JSON.stringify(provider)};
    select.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  const clickRefresh = async () => {
    const point = await evaluate(`(() => { const b = document.getElementById('openbot-model-refresh'); b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  };
  const initial = await wait(v => v.provider === "xai" && !v.busy && v.status?.includes("atualizado"));
  if (initial.model !== "grok-4.6" || !initial.options.some(o => o.id === "xai/pending" && o.disabled)) throw new Error("Catalog UI lost saved model or enabled pending model");
  state.catalogMode.xai = "removed";
  await clickRefresh();
  const removed = await wait(v => !v.busy && v.disabled === true);
  if (removed.model !== initial.model) throw new Error("Removed model selection was replaced");
  state.catalogMode.xai = "error";
  await clickRefresh();
  const error = await wait(v => !v.busy && v.status?.includes("Falha local"));
  state.catalogMode.xai = "empty";
  await clickRefresh();
  const empty = await wait(v => !v.busy && v.status?.includes("vazio confirmado"));
  if (empty.model !== initial.model || !empty.disabled) throw new Error("Empty catalog lost the saved selection");
  state.catalogMode.openai = "slow";
  await switchProvider("openai");
  await sleep(80);
  await switchProvider("opencode-go");
  const go = await wait(v => !v.busy && v.provider === "opencode-go" && v.status?.includes("Lista pública"));
  await sleep(600);
  await evaluate(`(() => { const field = document.getElementById("openbot-apikey"); field.value = "catalog-ui-fixture"; field.dispatchEvent(new Event("input", {bubbles:true})); document.getElementById("openbot-apikey-save").click(); })()`);
  await wait(v => !v.busy && v.saveStatus?.includes("Chave salva.") && v.provider === "opencode-go" && v.options.some(o => o.id === "opencode-go/pending" && o.disabled));
  const afterLate = await inspect();
  if (afterLate.provider !== "opencode-go" || afterLate.options.some(o => o.id.startsWith("gpt-"))) throw new Error("Late catalog crossed provider selection");
  await switchProvider("xai");
  const restoredSelection = await wait(v => !v.busy && v.provider === "xai" && v.status?.includes("vazio confirmado"));
  if (restoredSelection.model !== initial.model || !restoredSelection.disabled) throw new Error("Provider switching lost the saved removed model");
  state.catalogMode.openai = "fresh";
  await switchProvider("openai");
  const openai = await wait(v => !v.busy && v.provider === "openai" && v.status?.includes("atualizado"));
  if (!openai.reasoning.some(o => o.id === "medium" && o.disabled) || !openai.reasoning.some(o => o.id === "high" && !o.disabled)) throw new Error("Reasoning efforts were not constrained");
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(evidenceDir, "catalog-ui.png"), Buffer.from(screenshot.data, "base64"));
  await evaluate("document.getElementById('catalog-ui-fixture')?.remove()");
  const mountAgentSettings = () => evaluate(`(() => {
    document.getElementById('fast-ui-fixture')?.remove();
    const panel = document.createElement('div');
    panel.id = 'fast-ui-fixture';
    panel.style.cssText = 'position:fixed;right:20px;top:20px;width:400px;max-height:90vh;overflow:auto;padding:18px;background:#202020;z-index:99999';
    panel.innerHTML = '<label>Name</label><input value="Bot"><label>Description</label><textarea>Bot</textarea><label>Notifications</label><input type="checkbox">';
    document.body.appendChild(panel);
    window.__openbotLocalSettingsScan?.();
  })()`);
  await mountAgentSettings();
  await wait(v => v.provider === 'xai' && !v.busy);
  if (!await evaluate(`document.getElementById('openbot-speed-row').hidden`)) throw new Error('Fast shown for unsupported provider');
  await switchProvider('openai');
  await wait(v => v.provider === 'openai' && !v.busy && v.status?.includes('atualizado'));
  if (!await evaluate(`!document.getElementById('openbot-speed-row').hidden && !document.querySelector('#openbot-speed [value="priority"]').disabled`)) throw new Error('Fast missing for supported model');
  await evaluate(`(() => {
    const speed=document.getElementById('openbot-speed'), reasoning=document.getElementById('openbot-reasoning');
    reasoning.value='high'; reasoning.dispatchEvent(new Event('change',{bubbles:true}));
    speed.value='priority'; speed.dispatchEvent(new Event('change',{bubbles:true}));
    document.getElementById('openbot-save').click();
  })()`);
  await wait(v => v.saveStatus?.includes('salv') && !v.saveStatus?.includes('Salvando'));
  const fastSave = state.calls.filter(call => call.method === 'setProviderConfig').at(-1);
  if (fastSave?.body?.serviceTier !== 'priority' || fastSave.body.reasoningEffort !== 'high') throw new Error('Fast selection lost in real IPC');
  await mountAgentSettings();
  await wait(v => v.provider === 'openai' && !v.busy);
  if (!await evaluate(`document.getElementById('openbot-speed').value === 'priority'`)) throw new Error('Fast did not reload');
  state.catalogMode.openai = 'no-fast';
  await clickRefresh();
  await wait(v => !v.busy);
  if (!await evaluate(`document.querySelector('#openbot-speed [value="priority"]').disabled && document.getElementById('openbot-speed').value === 'priority' && document.getElementById('openbot-save').disabled`)) throw new Error('Unsupported saved Fast was silently replaced or allowed');
  await evaluate(`(() => {const speed=document.getElementById('openbot-speed');speed.value='default';speed.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('openbot-save').click();})()`);
  await wait(v => v.saveStatus?.includes('salv') && !v.saveStatus?.includes('Salvando'));
  if (state.calls.filter(call => call.method === 'setProviderConfig').at(-1)?.body?.serviceTier !== 'default') throw new Error('Standard selection lost in IPC');
  await evaluate("document.getElementById('fast-ui-fixture')?.remove()");
  console.log("FAST_UI_GREEN");
  console.log("CATALOG_UI_GREEN");
  return { initial, removed, error, empty, go, afterLate, restoredSelection, openai };
}

runBridgeRealVerify().catch((error) => {
  console.error(error);
  process.exit(1);
});
