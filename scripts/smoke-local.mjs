import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer } from "../dist/main.js";
import { createProviderRegistry } from "../dist/providers/router.js";

const dir = mkdtempSync(join(tmpdir(), "openbot-smoke-"));
const storePath = join(dir, "store.db");
const configPath = join(dir, "openbot-config.json");
const keystoreDir = join(dir, "keys");
let handle;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const post = async (port, token, method, body) => {
  assert(typeof token === "string" && token.length > 0, `gateway token ausente para ${method}`);
  const response = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const envelope = await response.json();
  assert(response.ok && envelope.ok === true, `${method}: ${JSON.stringify(envelope)}`);
  return envelope.value;
};
const registry = createProviderRegistry();
let turnCalls = 0;
let reflectionCalls = 0;
registry.register({
  name: "xai",
  async streamChat(request, emit) {
    const purpose = request?.purpose ?? "turn";
    if (purpose === "memory-reflection") {
      reflectionCalls += 1;
      emit({
        type: "delta",
        delta: JSON.stringify({
          summary: {
            throughSequenceId: 2,
            summaryJson: { safe: true, source: "smoke-local" },
            renderedText: "safe smoke summary",
          },
          operations: [],
        }),
      });
      return;
    }
    turnCalls += 1;
    emit({ type: "delta", delta: "smoke " });
    emit({ type: "delta", delta: "ok" });
  },
});
try {
  handle = await startServer(0, { registry, storePath, configPath, keystoreDir, workspacesRoot: join(dir, "workspaces") });
  assert(typeof handle.gatewayToken === "string" && handle.gatewayToken.length > 0, "gateway token ausente no primeiro boot");
  const initial = await post(handle.port, handle.gatewayToken, "listAgents", {});
  assert(Array.isArray(initial) && initial.length === 0, "smoke iniciou com bots inesperados");
  const created = await post(handle.port, handle.gatewayToken, "createAgent", { id: "smoke-agent", name: "Smoke Bot", origin: "test" });
  const agentId = created.agent.id;
  assert(agentId === "smoke-agent", `id do bot temporário inesperado: ${agentId}`);
  const body = { agentId, prompt: "ping", clientNonce: "smoke-nonce" };
  assert((await post(handle.port, handle.gatewayToken, "sendPrompt", body)).accepted === true, "prompt não aceito");
  await handle.runner.flush(agentId);
  await post(handle.port, handle.gatewayToken, "sendPrompt", body);
  await handle.runner.flush(agentId);
  assert(turnCalls === 1, `dedupe falhou: ${turnCalls} chamadas de turno`);
  const first = await post(handle.port, handle.gatewayToken, "getAgentTranscriptTail", { agentId, limit: 20 });
  assert(first.entries.some((e) => e.content === "smoke ok"), "resposta ausente no transcript");
  await stopServer(handle); handle = undefined;
  handle = await startServer(0, { registry, storePath, configPath, keystoreDir, workspacesRoot: join(dir, "workspaces") });
  assert(typeof handle.gatewayToken === "string" && handle.gatewayToken.length > 0, "gateway token ausente após restart");
  const afterRestart = await post(handle.port, handle.gatewayToken, "listAgents", {});
  assert(afterRestart.length === 1 && afterRestart[0].id === agentId, "bot temporário não persistiu após restart");
  const reopened = await post(handle.port, handle.gatewayToken, "getAgentTranscriptTail", { agentId, limit: 20 });
  assert(reopened.entries.some((e) => e.content === "smoke ok"), "transcript não persistiu após restart");
  const deleted = await post(handle.port, handle.gatewayToken, "deleteAgents", { ids: [agentId] });
  assert(Array.isArray(deleted.ids) && deleted.ids.length === 1 && deleted.ids[0] === agentId, "deleteAgents não removeu o bot temporário");
  const empty = await post(handle.port, handle.gatewayToken, "listAgents", {});
  assert(Array.isArray(empty) && empty.length === 0, "roster não voltou a zero após exclusão");
  await stopServer(handle); handle = undefined;
  handle = await startServer(0, { registry, storePath, configPath, keystoreDir, workspacesRoot: join(dir, "workspaces") });
  assert(typeof handle.gatewayToken === "string" && handle.gatewayToken.length > 0, "gateway token ausente após restart final");
  const afterDeleteRestart = await post(handle.port, handle.gatewayToken, "listAgents", {});
  assert(Array.isArray(afterDeleteRestart) && afterDeleteRestart.length === 0, "bot foi recriado após restart pós-exclusão");
  console.log(JSON.stringify({
    ok: true,
    turnCalls,
    reflectionCalls,
    entries: reopened.entries.length,
    restartPersisted: true,
    deletedAgent: agentId,
    zeroAgentAfterRestart: true,
  }));
} finally {
  if (handle) await stopServer(handle);
  rmSync(dir, { recursive: true, force: true });
}
