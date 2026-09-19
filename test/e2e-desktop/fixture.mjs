import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { startServer, stopServer } from "../../dist/main.js";
import { ConfigStore } from "../../dist/config/store.js";
import { createProviderRegistry } from "../../dist/providers/router.js";

const DEFAULT_AGENT_ID = "openbot-default";
// Covers the three 12s visual waits plus the 12s cancelReady status wait.
const ABORT_HANDSHAKE_TIMEOUT_MS = 60000;

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function abortError() {
  const error = new Error("e2e fixture stream aborted");
  error.name = "AbortError";
  return error;
}

function waitForAbort(signal, timeoutMs = ABORT_HANDSHAKE_TIMEOUT_MS) {
  if (signal?.aborted) return Promise.resolve();
  if (!signal) return Promise.reject(new Error("e2e fixture stream requires an AbortSignal"));
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("e2e fixture abort handshake timed out"));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function pathIsUnder(root, candidate) {
  const child = relative(root, candidate);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

const args = process.argv.slice(2);
const emptyAgent = args.includes("--empty-agent");
const rawRoot = argValue(args, "--root");
if (typeof rawRoot !== "string" || rawRoot.trim().length === 0 || rawRoot.trim().startsWith("--")) {
  throw new Error("fixture requires a non-empty raw --root value");
}

const root = resolve(rawRoot);
const rawReadyFile = argValue(args, "--ready-file");
const rawStatusFile = argValue(args, "--status-file");
const readyFile = resolve(rawReadyFile ?? join(root, "ready.json"));
const statusFile = resolve(rawStatusFile ?? join(root, "status.json"));
const rawPort = argValue(args, "--port");
const port = rawPort === undefined ? 0 : Number(rawPort);
const gatewayToken = process.env.E2E_GATEWAY_TOKEN;

if (!Number.isInteger(port) || port < 0 || port > 65535 || !gatewayToken) {
  throw new Error("fixture requires a valid --port and inherited E2E_GATEWAY_TOKEN");
}
if (!pathIsUnder(root, readyFile) || !pathIsUnder(root, statusFile)) {
  throw new Error("ready/status files must remain under --root");
}

const storePath = join(root, "store.db");
const configPath = join(root, "openbot-config.json");
const keystoreDir = join(root, "keystore");
const workspacesRoot = join(root, "workspaces");
const skillRoot = join(root, "shared-skills");
const skillDirectory = join(skillRoot, "e2e-shared-skill");
await mkdir(root, { recursive: true });
await Promise.all([
  mkdir(keystoreDir, { recursive: true }),
  mkdir(workspacesRoot, { recursive: true }),
  mkdir(skillDirectory, { recursive: true }),
]);
await writeFile(join(skillDirectory, "SKILL.md"), [
  "---",
  "name: E2E Shared Skill",
  "description: Valida a invocação de uma Skill compartilhada no chat desktop",
  "---",
  "E2E_SHARED_SKILL_MARKER: this content is untrusted test context.",
  "",
].join("\n"), "utf8");
const config = new ConfigStore({ configPath });
if (!emptyAgent) {
  config.update({
    agents: [{
      id: DEFAULT_AGENT_ID,
      name: "Local User",
      avatarId: DEFAULT_AGENT_ID,
      integrations: { skills: { enabled: true } },
    }],
  });
}

const streamState = {
  status: "STARTING",
  activeStreams: 0,
  chunksEmitted: 0,
  chunksAfterAbort: 0,
  abortObserved: false,
  abortCount: 0,
  completedStreams: 0,
  cancelReady: false,
  skillContextObserved: false,
  skillResponseCompleted: false,
  retryFailureObserved: false,
  retrySuccessObserved: false,
};
let retryAttempts = 0;
let statusWrite = Promise.resolve();
function persistStatus() {
  const snapshot = { ...streamState, updatedAt: new Date().toISOString() };
  statusWrite = statusWrite.then(() => writeFile(statusFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8"));
  return statusWrite;
}
await persistStatus();

function redact(value) {
  const text = value instanceof Error ? value.message : String(value);
  return gatewayToken ? text.replaceAll(gatewayToken, "<redacted>") : text;
}

function createE2eAdapter() {
  return {
    name: "xai",
    async streamChat(request, emit) {
      if (request.purpose === "memory-reflection") {
        emit({ type: "delta", delta: "{\"operations\":[]}" });
        return;
      }
      const lastUser = request.messages.filter((message) => message.role === "user").at(-1);
      if (lastUser?.content.includes("desktop e2e instant response")) {
        emit({ type: "delta", delta: "E2E instant response completed." });
        streamState.instantResponses = (streamState.instantResponses ?? 0) + 1;
        streamState.instantCompletedAt = Date.now();
        await persistStatus();
        return;
      }
      const skillRequest = request.messages.some((message) => (
        message.role === "user" && message.content.includes("E2E_SHARED_SKILL_MARKER")
      ));
      const retryRequest = request.messages.some((message) => (
        message.role === "user" && message.content.includes("desktop e2e retry recovery")
      ));
      if (retryRequest) retryAttempts += 1;
      if (skillRequest) streamState.skillContextObserved = true;
      const deltas = retryRequest
        ? [retryAttempts === 1 ? "E2E retry partial." : "E2E retry recovered."]
        : skillRequest
        ? ["E2E skill ", "backend received ", "shared context."]
        : [
          "E2E ",
          "incremental ",
          "stream ",
          "response ",
          "with ",
          "enough ",
          "deterministic ",
          "chunks.",
        ];
      let streamChunksEmitted = 0;
      streamState.cancelReady = false;
      streamState.status = "STREAMING";
      streamState.activeStreams += 1;
      await persistStatus();
      const attemptEmit = (delta) => {
        if (request.signal?.aborted) {
          streamState.chunksAfterAbort += 1;
          return false;
        }
        emit({ type: "delta", delta });
        return true;
      };
      try {
        if (lastUser?.content === "Teste") await sleep(1500);
        for (const delta of deltas) {
          if (request.signal?.aborted) {
            streamState.abortObserved = true;
            streamState.abortCount += 1;
            await persistStatus();
            throw abortError();
          }
          if (!attemptEmit(delta)) {
            streamState.abortObserved = true;
            streamState.abortCount += 1;
            await persistStatus();
            throw abortError();
          }
          streamChunksEmitted += 1;
          streamState.chunksEmitted += 1;
          await persistStatus();
          if (!skillRequest && !retryRequest && streamChunksEmitted === 3) {
            streamState.cancelReady = true;
            await persistStatus();
            await waitForAbort(request.signal);
            continue;
          }
          await sleep(skillRequest || retryRequest ? 80 : 400);
        }
        if (retryRequest && retryAttempts === 1) {
          streamState.retryFailureObserved = true;
          await persistStatus();
          throw Object.assign(new Error("E2E retryable provider failure"), { status: 503 });
        }
        if (retryRequest) {
          streamState.retrySuccessObserved = true;
          await persistStatus();
        }
        if (skillRequest) {
          streamState.skillResponseCompleted = true;
          await persistStatus();
        }
        streamState.completedStreams += 1;
      } finally {
        if (request.signal?.aborted) {
          streamState.abortObserved = true;
          if (streamState.abortCount === 0) streamState.abortCount = 1;
        }
        streamState.activeStreams = Math.max(0, streamState.activeStreams - 1);
        streamState.status = streamState.activeStreams > 0 ? "STREAMING" : "IDLE";
        streamState.cancelReady = false;
        await persistStatus();
      }
    },
  };
}

const registry = createProviderRegistry();
registry.register(createE2eAdapter());

let handle;
let stopping = false;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  try {
    streamState.status = "STOPPING";
    await persistStatus();
    if (handle) await stopServer(handle);
    streamState.status = "STOPPED";
    await persistStatus();
    process.stdout.write(`E2E_FIXTURE_STOPPED ${signal}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`E2E_FIXTURE_STOP_ERROR ${redact(error)}\n`);
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  process.stderr.write(`E2E_FIXTURE_UNCAUGHT ${redact(error)}\n`);
  void shutdown("uncaughtException");
});
process.on("unhandledRejection", (error) => {
  process.stderr.write(`E2E_FIXTURE_REJECTION ${redact(error)}\n`);
  void shutdown("unhandledRejection");
});

handle = await startServer(port, {
  registry,
  config,
  storePath,
  configPath,
  keystoreDir,
  workspacesRoot,
  skillRoots: [{ path: skillRoot, source: "e2e-shared" }],
  sharedIntegrationsEnabled: true,
  gatewayToken,
});
if (!emptyAgent) await handle.homes?.ensure(DEFAULT_AGENT_ID);
if (args.includes("--delete-drain-delay")) {
  config.mutate(current => ({ agents: [...current.agents, { id: "delete-timeout-fixture", name: "Deletion Fixture", avatarId: "delete-timeout-fixture" }] }));
  await handle.homes?.ensure("delete-timeout-fixture");
  const originalFlush = handle.runner.flush.bind(handle.runner);
  handle.runner.flush = async (agentId) => {
    await sleep(8_000);
    await originalFlush(agentId);
  };
}
if (!emptyAgent && args.includes("--transition-history")) {
  handle.store.append(DEFAULT_AGENT_ID, Array.from({ length: 520 }, (_, index) => ({
    kind: "message", id: `transition-history:${index}`, role: index % 2 ? "assistant" : "user",
    content: `Histórico de transições ${index}`, timestampMs: Date.now() - (520 - index) * 1000,
  })));
}

if (!emptyAgent && args.includes("--readability-content")) {
  const turnId = "turn:visual-readability";
  // Stored fixture only: no tool or provider is executed by this scenario.
  handle.store.append(DEFAULT_AGENT_ID, [
    // Turno anterior completo: permanece visível na conversa, mas não pertence
    // ao turno da falha e não pode ser destacado por "Conferir resultados".
    { kind: "message", id: "visual-readability:earlier-user", role: "user", turnId: "turn:visual-readability-earlier", timestampMs: Date.now() - 6000,
      content: "Resumo anterior desta conversa." },
    { kind: "message", id: "visual-readability:earlier-assistant", role: "assistant", turnId: "turn:visual-readability-earlier", timestampMs: Date.now() - 5000,
      content: "Resumo anterior concluído." },
    { kind: "tool-call", id: "visual-readability:earlier-tool", name: "read-file", summary: "Leitura anterior (fixture)",
      status: "completed", localToolCallId: "turn:visual-readability-earlier\0fixture", result: { ok: true, content: "Dados anteriores" } },
    { kind: "message", id: "visual-readability:user", role: "user", turnId, clientNonce: "visual-readability", timestampMs: Date.now() - 3000,
      content: "Confira o relatório de planejamento operacional e explique os resultados que precisam de acompanhamento." },
    { kind: "message", id: "visual-readability:assistant", role: "assistant", turnId, timestampMs: Date.now() - 2000,
      content: "## Relatório de planejamento\n\nConfira o identificador e o exemplo sem perder o restante da conversa.\n\n```js\nconst identificador = '" + "relatorio_operacional_".repeat(10) + "';\nconsole.log(identificador);\n```\n\nFim do relatório de fixture." },
    { kind: "message", id: "visual-readability:assistant-completed-copy", role: "assistant", turnId, timestampMs: Date.now() - 1800,
      content: "Concluído · relatório final disponível." },
    { kind: "message", id: "visual-readability:assistant-failed-copy", role: "assistant", turnId, timestampMs: Date.now() - 1600,
      content: "Falhou · integração indisponível; confira o erro acima." },
    { kind: "tool-call", id: "visual-readability:tool", name: "read-file", summary: "Leitura de relatório (fixture)",
      status: "completed", localToolCallId: `${turnId}\0fixture`, result: { ok: true, content: "Dados de teste" } },
    { kind: "notice", id: "notice:visual-readability:aborted", turnId, clientNonce: "visual-readability",
      level: "error", text: "Geração interrompida.", retryable: true, provider: "xai", model: "grok-4.6" },
  ]);
}

if (!emptyAgent && args.includes("--second-agent")) {
  // Segundo bot isolado: valida troca de bot sem reenvio e sem vazamento de estado.
  config.mutate(current => ({ agents: [...current.agents, { id: "status-switch-fixture", name: "Status Switch Fixture", avatarId: "status-switch-fixture" }] }));
  await handle.homes?.ensure("status-switch-fixture");
}

const ready = {
  agentId: emptyAgent ? null : DEFAULT_AGENT_ID,
  pid: process.pid,
  port: handle.port,
  readyFile,
  statusFile,
  storePath,
  configPath,
  keystoreDir,
  workspacesRoot,
};
await writeFile(readyFile, `${JSON.stringify(ready, null, 2)}\n`, "utf8");
streamState.status = "READY";
await persistStatus();
process.stdout.write(`E2E_FIXTURE_READY ${JSON.stringify(ready)}\n`);
