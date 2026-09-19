/**
 * T3 — Testes de integração HTTP do gateway (src/server/gateway.ts) montado
 * pelo bootstrap (src/main.ts).
 *
 * Cobertura por rota (plano §3 T3 / spec §4.5):
 *   - GET /api/events        SSE (content-type, retry, heartbeat :ping, filtro ?channels=)
 *   - POST /api/<method>     envelope RPC {ok,value}/{ok:false,failure}; 404 método
 *                            desconhecido; 501 método conhecido sem mesa plugada
 *   - GET /health            {ok,pid,isBusy,activeAgentId,startedAt}
 *   - POST /prepare-upgrade  {quiescing:true, runningTurns:0}
 *   - GET /avatars/<id>      placeholder (image/svg+xml)
 *   - POST /local-exec/* → 501; /webauthn/register → 404; ceremony autenticada → envelope 400
 *   - CSRF: Origin estranha → 403; Origin loopback → ok; Host estranho → 403
 *   - gzip: resposta comprimida com accept-encoding: gzip
 *   - roteador extensível: registerHandler pluga uma mesa fake e responde RPC
 */

import * as childProcess from "node:child_process";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", { spy: true });

import {
  GATEWAY_HOST,
  startServer,
  stopServer,
  type ServerHandle,
} from "../src/main.js";
import {
  createGateway,
  GZIP_MIN_BYTES,
  RPC_METHOD_TABLE,
  SSE_HEARTBEAT_MS,
  SSE_MAX_FRAME_BYTES,
} from "../src/server/gateway.js";
import { SSE_CHANNELS } from "../src/shared/contracts.js";

let activeHandles: ServerHandle[] = [];
let tmpDirs: string[] = [];
const sseResponseBuffers = new WeakMap<http.IncomingMessage, string>();
const sseChunkQueues = new WeakMap<http.IncomingMessage, {
  chunks: string[];
  waiters: Array<(chunk: string) => void>;
}>();

afterEach(async () => {
  const handles = activeHandles;
  activeHandles = [];
  await Promise.all(handles.map((h) => stopServer(h)));
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(heartbeatMs?: number, configPath?: string, gatewayToken?: string): Promise<ServerHandle> {
  const root = mkdtempSync(join(tmpdir(), "openbot-gateway-"));
  tmpDirs.push(root);
  // Porta efêmera (0): os testes de integração cobrem as ROTAS do gateway; o
  // contrato de porta FIXA 1340 + EADDRINUSE é coberto por test/bootstrap.test.ts
  // (que roda em outro worker do vitest — usar 1340 aqui colidiria com ele).
  const handle = await startServer(0, {
    startedAt: "2026-08-11T00:00:00.000Z",
    sseHeartbeatMs: heartbeatMs,
    disableAgentHome: true,
    configPath: configPath ?? join(root, "config.json"),
    storePath: join(root, "store.db"),
    keystoreDir: join(root, "keystore"),
    runtimeRoot: join(root, "runtime"),
    browserRoot: join(root, "browser"),
    workspacesRoot: join(root, "workspaces"),
    ...(gatewayToken ? { gatewayToken } : {}),
  });
  activeHandles.push(handle);
  return handle;
}

function baseUrl(handle: ServerHandle): string {
  return `http://${GATEWAY_HOST}:${handle.port}`;
}

async function request(
  handle: ServerHandle,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    withAuth?: boolean;
  } = {},
): Promise<http.IncomingMessage> {
  const headers = { ...(init.headers ?? {}) };
  if (init.withAuth !== false && headers.authorization === undefined && handle.gatewayToken) {
    headers.authorization = `Bearer ${handle.gatewayToken}`;
  }
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request(
      baseUrl(handle) + path,
      {
        method: init.method ?? "GET",
        headers,
        // Sem reuso de socket keep-alive: cada teste sobe/derruba o servidor
        // na MESMA porta (1340) e o pool global do Node guardaria sockets
        // stale do servidor anterior — requests iam para conexão morta e
        // travavam em testes alternados.
        agent: false,
      },
      (res) => resolve(res),
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

describe("T3 gateway — rotas HTTP (integração)", () => {
  it("exposes authenticated content-free execution counters without starting agent work", async () => {
    const handle = await boot(undefined, undefined, "diagnostics-fixture-token");
    const denied = await request(handle, "/api/getExecutionDiagnostics", { method: "POST", body: "{}", withAuth: false });
    await readBody(denied);
    expect(denied.statusCode).toBe(401);
    const response = await request(handle, "/api/getExecutionDiagnostics", { method: "POST", body: "{}" });
    const result = JSON.parse(await readBody(response));
    expect(response.statusCode).toBe(200);
    expect(result).toMatchObject({ ok: true, value: {
      version: 1,
      provider: { active: 0, waiting: 0, admitted: 0 },
      workspaces: [],
      gateway: { memoryBytes: { rss: expect.any(Number) }, eventLoop: { samples: expect.any(Number) } },
    } });
    expect(handle.runner.getStatus().isBusy).toBe(false);
    expect(JSON.stringify(result)).not.toContain("diagnostics-fixture-token");
    handle.gateway.beginQuiescence();
    const quiescent = await request(handle, "/api/getExecutionDiagnostics", { method: "POST", body: "{}" });
    await readBody(quiescent);
    expect(quiescent.statusCode).toBe(200);
  });

  it("GET /health → 200 {ok,pid,isBusy,activeAgentId,startedAt}", async () => {
    const h = await boot();
    const res = await request(h, "/health");
    const body = await readBody(res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    const json = JSON.parse(body) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.pid).toBe(process.pid);
    expect(json.isBusy).toBe(false);
    expect(json.activeAgentId).toBeNull();
    expect(json.startedAt).toBe("2026-08-11T00:00:00.000Z");
  });

  it("roster/provider RPC persiste seleção e devolve config sem secret", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-roster-rpc-"));
    tmpDirs.push(dir);
    const h = await boot(undefined, join(dir, "openbot-config.json"));
    const created = await request(h, "/api/createAgent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "openbot-default", name: "Test Default" }),
    });
    expect(created.statusCode).toBe(200);
    const get = await request(h, "/api/getActiveProvider", { method: "POST", body: "{}" });
    expect((await readJson(get) as { value: unknown }).value).toEqual({ provider: "xai" });
    const set = await request(h, "/api/setAgentDefaultModel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol" }),
    });
    expect((await readJson(set) as { value: unknown }).value).toMatchObject({ model: "gpt-5.6-sol", modelId: "gpt-5.6-sol" });
    const config = await request(h, "/api/getProviderConfig", { method: "POST", body: "{}" });
    const configValue = (await readJson(config) as { value: unknown }).value;
    expect(configValue).toMatchObject({ provider: "openai", model: "gpt-5.6-sol" });
    expect(JSON.stringify(configValue)).not.toMatch(/apiKey|secret|token/i);
  });

  it("POST /api/sendPrompt com handler fake → envelope RPC {ok,value} (contrato)", async () => {
    const h = await boot();
    const calls: unknown[] = [];
    h.gateway.registerHandler("sendPrompt", (body, ctx) => {
      calls.push({ body, ctx });
      const b = body as { prompt?: unknown };
      return { accepted: true, echo: b.prompt ?? null };
    });
    const res = await request(h, "/api/sendPrompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "olá" }),
    });
    expect(res.statusCode).toBe(200);
    const json = (await readJson(res)) as { ok: true; value: unknown };
    expect(json.ok).toBe(true);
    expect(json.value).toEqual({ accepted: true, echo: "olá" });
    expect(calls).toHaveLength(1);
  });

  it("POST /api/<método desconhecido> → 404 {error} (tabela de rota explícita)", async () => {
    const h = await boot();
    const res = await request(h, "/api/naoExiste", {
      method: "POST",
      body: "{}",
    });
    expect(res.statusCode).toBe(404);
    const json = (await readJson(res)) as { error: string };
    expect(typeof json.error).toBe("string");
  });

  it("POST /api/<método conhecido> com corpo inválido → 400 {ok:false,failure}", async () => {
    const h = await boot();
    expect(RPC_METHOD_TABLE.has("sendPrompt")).toBe(true);
    expect(RPC_METHOD_TABLE.has("getAgentWorkflows")).toBe(true);
    expect(RPC_METHOD_TABLE.has("getAvailableSkills")).toBe(true);
    expect(RPC_METHOD_TABLE.has("refreshSkills")).toBe(true);
    const res = await request(h, "/api/sendPrompt", {
      method: "POST",
      body: "{}",
    });
    expect(res.statusCode).toBe(400);
    const json = (await readJson(res)) as { ok: false; failure: string };
    expect(json.ok).toBe(false);
    expect(typeof json.failure).toBe("string");
  });

  it("POST /api/sendPrompt com JSON inválido → 400 {error}", async () => {
    const h = await boot();
    const res = await request(h, "/api/sendPrompt", {
      method: "POST",
      body: "{json:quebrado",
    });
    expect(res.statusCode).toBe(400);
    const json = (await readJson(res)) as { error: string };
    expect(json.error).toMatch(/invalid-json/);
  });

  it("POST /api/sendPrompt com handler que lança → envelope {ok:false,failure} (500)", async () => {
    const h = await boot();
    h.gateway.registerHandler("sendPrompt", () => {
      throw new Error("boom");
    });
    const res = await request(h, "/api/sendPrompt", {
      method: "POST",
      body: "{}",
    });
    expect(res.statusCode).toBe(500);
    const json = (await readJson(res)) as { ok: false; failure: string };
    expect(json.ok).toBe(false);
    expect(json.failure).toContain("boom");
  });

  it("POST /prepare-upgrade entra em quiescência e rejeita novos sendPrompt", async () => {
    const h = await boot();
    const res = await request(h, "/prepare-upgrade", { method: "POST" });
    expect(res.statusCode).toBe(200);
    const json = (await readJson(res)) as { quiescing: boolean; runningTurns: number };
    expect(json).toEqual({ quiescing: true, runningTurns: 0 });

    const rejected = await request(h, "/api/sendPrompt", { method: "POST", body: "{}" });
    expect(rejected.statusCode).toBe(503);
    expect(await readJson(rejected)).toEqual({ ok: false, failure: "gateway quiescing" });
  });

  it("quiescência bloqueia mutadores antes do body e preserva leituras/cancelamento", async () => {
    const h = await boot();
    const created = await request(h, "/api/createAgent", {
      method: "POST",
      body: JSON.stringify({ id: "openbot-default", name: "Quiescence test" }),
    });
    expect(created.statusCode).toBe(200);
    await readBody(created);
    const called: string[] = [];
    for (const method of [
      "createConversation", "setProviderConfig", "deleteAgents",
      "countAgents", "getProviderConfig", "getPromptStatus", "cancelPrompt", "abortPrompt",
    ]) {
      h.gateway.registerHandler(method, () => { called.push(method); return { method }; });
    }
    expect((await request(h, "/prepare-upgrade", { method: "POST" })).statusCode).toBe(200);

    for (const method of ["createConversation", "setProviderConfig", "deleteAgents"]) {
      const res = await request(h, `/api/${method}`, {
        method: "POST",
        body: "{malformed",
      });
      expect(res.statusCode).toBe(503);
      expect(await readJson(res)).toEqual({ ok: false, failure: "gateway quiescing" });
    }
    for (const method of ["countAgents", "getProviderConfig", "getPromptStatus", "getAgentAvatar", "discoverLocalProviders", "cancelPrompt", "abortPrompt"]) {
      const body = method === "getAgentAvatar" ? JSON.stringify({ agentId: "openbot-default" }) : "{}";
      const res = await request(h, `/api/${method}`, { method: "POST", body });
      expect(res.statusCode, method).toBe(200);
      await readJson(res);
    }
    expect(called).toEqual(expect.arrayContaining(["countAgents", "getProviderConfig", "getPromptStatus", "cancelPrompt", "abortPrompt"]));
  });

  it("POST /prepare-upgrade aplica os mesmos guards CSRF e token do RPC", async () => {
    const h = await boot(undefined, undefined, "upgrade-secret");
    const csrf = await request(h, "/prepare-upgrade", {
      method: "POST",
      headers: { host: "evil.example", authorization: "Bearer upgrade-secret" },
    });
    expect(csrf.statusCode).toBe(403);
    await readBody(csrf);

    const unauthorized = await request(h, "/prepare-upgrade", { method: "POST", withAuth: false });
    expect(unauthorized.statusCode).toBe(401);
    await readBody(unauthorized);

    const allowed = await request(h, "/prepare-upgrade", {
      method: "POST",
      headers: { authorization: "Bearer upgrade-secret" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(await readJson(allowed)).toEqual({ quiescing: true, runningTurns: 0 });
  });

  it("POST /shutdown aplica auth/CSRF, GET retorna 405 e encerra uma vez sob concorrência", async () => {
    const h = await boot(undefined, undefined, "shutdown-secret");

    const unauthorized = await request(h, "/shutdown", { method: "POST", withAuth: false });
    expect(unauthorized.statusCode).toBe(401);
    await readBody(unauthorized);

    const csrf = await request(h, "/shutdown", {
      method: "POST",
      headers: { origin: "https://evil.example", authorization: "Bearer shutdown-secret" },
    });
    expect(csrf.statusCode).toBe(403);
    await readBody(csrf);

    const get = await request(h, "/shutdown", { method: "GET" });
    expect(get.statusCode).toBe(405);
    await readBody(get);

    const responses = await Promise.all([
      request(h, "/shutdown", { method: "POST" }),
      request(h, "/shutdown", { method: "POST" }),
    ]);
    for (const res of responses) {
      expect(res.statusCode).toBe(202);
      expect(await readJson(res)).toEqual({ ok: true, shuttingDown: true });
    }

    await waitForServerClosed(h);
    activeHandles = activeHandles.filter((handle) => handle !== h);
  });

  it("agenda shutdown quando o cliente fecha a resposta antes de finish, sem duplicar", async () => {
    const calls: string[] = [];
    const gateway = createGateway({
      gatewayToken: "close-secret",
      shutdownHandler: () => { calls.push("shutdown"); },
    });
    const response = new EventEmitter() as EventEmitter & {
      writableEnded: boolean;
      headersSent: boolean;
      statusCode: number;
      setHeader: (name: string, value: string) => void;
      end: (body?: string) => void;
    };
    response.writableEnded = false;
    response.headersSent = false;
    response.statusCode = 200;
    response.setHeader = () => {};
    response.end = () => { response.writableEnded = true; };
    gateway.createHandler()({
      method: "POST",
      url: "/shutdown",
      headers: { host: "127.0.0.1", authorization: "Bearer close-secret" },
    } as http.IncomingMessage, response as unknown as http.ServerResponse);
    await flushTurn();
    expect(calls).toEqual([]);
    response.emit("close");
    await flushTurn();
    expect(calls).toEqual(["shutdown"]);
    response.emit("finish");
    await flushTurn();
    expect(calls).toEqual(["shutdown"]);
  });

  it("payload RPC acima de 1 MB recebe 413 sem resetar o socket", async () => {
    const h = await boot();
    const res = await request(h, "/api/sendPrompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x".repeat(1_000_001) }),
    });
    expect(res.statusCode).toBe(413);
    expect(await readJson(res)).toEqual({ error: "payload-too-large" });
    expect((await request(h, "/health")).statusCode).toBe(200);
  });

  it("avatar com percent-encoding inválido retorna 400 sem derrubar o gateway", async () => {
    const h = await boot();
    const res = await request(h, "/avatars/%");
    expect(res.statusCode).toBe(400);
    expect(await readJson(res)).toEqual({ error: "invalid-avatar-id" });
    expect((await request(h, "/health")).statusCode).toBe(200);
  });

  it("GET /avatars/<id> → placeholder 200 image/svg+xml com x-avatar-id", async () => {
    const h = await boot();
    const res = await request(h, "/avatars/openbot-default");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/svg\+xml/);
    expect(res.headers["x-avatar-id"]).toBe("openbot-default");
    const body = await readBody(res);
    expect(body).toContain("<svg");
  });

  it("POST /local-exec/* → 501 {error:not-implemented}", async () => {
    const h = await boot();
    const res = await request(h, "/local-exec/foo", { method: "POST", body: "{}" });
    expect(res.statusCode).toBe(501);
    const json = (await readJson(res)) as { error: string };
    expect(json.error).toBe("not-implemented");
  });

  it("POST /webauthn/register → 404 envelope failure", async () => {
    const h = await boot();
    const res = await request(h, "/webauthn/register", { method: "POST", body: "{}" });
    expect(res.statusCode).toBe(404);
    const json = (await readJson(res)) as { ok: boolean; failure: string };
    expect(json.ok).toBe(false);
    expect(json.failure).toContain("webauthn route not found");
  });

  it("POST /webauthn/ceremony autenticado com body vazio → 400 no envelope sem executar signer", async () => {
    const h = await boot(undefined, undefined, "test-gateway-token");
    const spawnSpy = vi.mocked(childProcess.spawn);
    spawnSpy.mockClear();
    const res = await request(h, "/webauthn/ceremony", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.statusCode).toBe(400);
    const json = (await readJson(res)) as { ok: boolean; failure: string };
    expect(json.ok).toBe(false);
    expect(json.failure).toContain("webauthn");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("GET /rota-desconhecida → 404 {error:not-found}", async () => {
    const h = await boot();
    const res = await request(h, "/xyz");
    expect(res.statusCode).toBe(404);
    const json = (await readJson(res)) as { error: string };
    expect(json.error).toBe("not-found");
  });
});

describe("T3 gateway — SSE /api/events", () => {
  it("negocia SSE (accept: text/event-stream) → 200 text/event-stream + retry:1000", async () => {
    const h = await boot();
    const res = await request(h, "/api/events", {
      headers: { accept: "text/event-stream" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.headers["cache-control"]).toContain("no-cache");

    const first = await readChunk(res);
    expect(first).toContain("retry: 1000");
    expect(first).toContain('"reason":"stream-connected"');
    expect(first).toContain('"method":"openAgentTail"');
    res.destroy();
  });

  it("Last-Event-ID recebe instrução explícita de resync", async () => {
    const h = await boot();
    const res = await request(h, "/api/events?channels=transcript", {
      headers: { accept: "text/event-stream", "last-event-id": "42" },
    });
    let data = await readChunk(res);
    if (!data.includes('"type":"resync"')) data += await readChunk(res);
    expect(data).toContain('"reason":"last-event-id"');
    expect(data).toContain('"lastEventId":"42"');
    expect(data).toContain('"method":"openAgentTail"');
    res.destroy();
  });

  it("reconecta transcript com snapshot sem namespace sintética e converge no próximo cursor do agente", async () => {
    const h = await boot();
    h.gateway.setTranscriptSnapshotProvider((agentId) => ({
      agentId,
      activeAgentId: agentId,
      entries: [{ kind: "message", id: "durable-1", role: "assistant", content: "durable", timestampMs: 1 }],
    }));
    const res = await request(h, "/api/events?channels=transcript&agentId=agent-a", {
      headers: {
        accept: "text/event-stream",
        "last-event-id": "transcript:transcript%3Aagent-a:old-epoch:4",
      },
    });
    const initial = await readChunk(res);
    expect(initial).toContain('"type":"snapshot"');
    expect(initial).toContain('"reason":"cursor-stale-or-gap"');
    expect(initial).not.toContain('"ordered"');
    expect(initial).not.toContain("id: transcript:");

    const nextPromise = readChunk(res);
    h.gateway.publish("transcript", {
      type: "appended",
      agentId: "agent-a",
      entry: { kind: "message", id: "live-1", role: "user", content: "live", timestampMs: 2 },
      ordered: { replicaKey: "transcript:agent-a", epoch: "live-epoch", sequence: 1 },
    });
    const next = await nextPromise;
    expect(next).toContain("id: transcript:transcript%3Aagent-a:live-epoch:1");
    expect(next).toContain('"replicaKey":"transcript:agent-a"');
    res.destroy();
  });

  it("aceita /events, endpoint usado pelo coordinator", async () => {
    const h = await boot();
    const res = await request(h, "/events", { headers: { accept: "text/event-stream" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(await readChunk(res)).toContain("retry: 1000");
    res.destroy();
  });

  it("stopServer encerra mesmo com SSE aberto", async () => {
    const h = await boot();
    const res = await request(h, "/api/events", { headers: { accept: "text/event-stream" } });
    await readChunk(res);
    await expect(Promise.race([
      stopServer(h),
      new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown timeout")), 1_000)),
    ])).resolves.toBeUndefined();
    activeHandles = activeHandles.filter((handle) => handle !== h);
  });

  it("stopServer força fechamento de body parcial", async () => {
    const h = await boot();
    const socket = net.createConnection({ host: GATEWAY_HOST, port: h.port });
    await once(socket, "connect");
    socket.write(["POST /api/countAgents HTTP/1.1", "Host: 127.0.0.1", "Content-Type: application/json", "Content-Length: 1000000", "", "{"].join("\r\n"));
    await expect(Promise.race([
      stopServer(h),
      new Promise((_, reject) => setTimeout(() => reject(new Error("partial body shutdown timeout")), 3_000)),
    ])).resolves.toBeUndefined();
    socket.destroy();
    activeHandles = activeHandles.filter((handle) => handle !== h);
  });

  it("GET /api/events sem accept de SSE → 400 {error}", async () => {
    const h = await boot();
    const res = await request(h, "/api/events");
    expect(res.statusCode).toBe(400);
    const json = (await readJson(res)) as { error: string };
    expect(json.error).toBe("expected-event-stream");
  });

  it("heartbeat :ping chega a cada 15s (SSE_HEARTBEAT_MS é 15s)", async () => {
    const h = await boot();
    const res = await request(h, "/api/events", {
      headers: { accept: "text/event-stream" },
    });
    await readChunk(res); // retry:
    // 15s real não é esperável num teste de unidade — a CADÊNCIA do heartbeat
    // é coberta abaixo com intervalo curto injetado (bootEphemeral); aqui
    // garantimos o contrato: o intervalo default é 15.000ms.
    expect(SSE_HEARTBEAT_MS).toBe(15_000);
    res.destroy();
  });

  it("heartbeat :ping com intervalo curto injetado (cadência real do stream)", async () => {
    const h = await boot(60); // sseHeartbeatMs: 60
    const res = await request(h, "/api/events", {
      headers: { accept: "text/event-stream" },
    });
    await readChunk(res); // consome retry:
    const pings: string[] = [];
    for (let i = 0; i < 2; i++) {
      const chunk = await readChunk(res);
      pings.push(chunk);
    }
    expect(pings.every((c) => c === ":ping\n\n")).toBe(true);
    res.destroy();
  });

  it("filtro ?channels=: evento de canal fora da lista não chega; dentro chega", async () => {
    const h = await boot();
    const res = await request(h, "/api/events?channels=agents", {
      headers: { accept: "text/event-stream" },
    });
    await readChunk(res); // retry:
    const dataPromise = readChunk(res);
    // Publica em canal filtrado (não deve aparecer) e em canal permitido.
    h.gateway.publish("transcript", { type: "appended", entries: [] });
    h.gateway.publish("agents", { type: "agent-upserted", agent: { id: "a" } });
    const data = await dataPromise;
    expect(data).toContain('"channel":"agents"');
    expect(data).not.toContain('"channel":"transcript"');
    res.destroy();
  });

  it("publish → frame SSE data: {channel,payload} (contrato SseEvent)", async () => {
    const h = await boot();
    const res = await request(h, "/api/events", {
      headers: { accept: "text/event-stream" },
    });
    await readChunk(res); // retry:
    const dataPromise = readChunk(res);
    h.gateway.publish("transcript", { type: "appended", entries: [] });
    const data = await dataPromise;
    expect(data).toContain("data: ");
    const parsed = JSON.parse(data.slice("data: ".trim().length)) as {
      channel: string;
      payload: { type: string };
    };
    expect(parsed.channel).toBe("transcript");
    expect(parsed.payload.type).toBe("appended");
    res.destroy();
  });

  it("isola reasoning por agente", async () => {
    const h = await boot(30);
    const a = await request(h, "/api/events?channels=reasoning&agentId=agent-a", {
      headers: { accept: "text/event-stream" },
    });
    const b = await request(h, "/api/events?channels=reasoning&agentId=agent-b", {
      headers: { accept: "text/event-stream" },
    });
    await readChunk(a);
    await readChunk(b);
    const aDataPromise = readChunk(a);
    const bDataPromise = readChunk(b);
    h.gateway.publish("reasoning", { agentId: "agent-b", epoch: "epoch-1", sequence: 1, summary: "private-b" });
    expect(await bDataPromise).toContain("private-b");
    expect(await aDataPromise).toBe(":ping\n\n");
    a.destroy();
    b.destroy();
  });

  it("substitui item de task oversized por snapshot utilizável e limitado", async () => {
    const h = await boot(30);
    h.gateway.setTaskSnapshotProvider((agentId, channel) => ({
      agentId,
      channel,
      epoch: "epoch-1",
      sequence: 1,
      items: [{ id: "task-oversized", label: "x".repeat(300 * 1024) }],
    }));
    const res = await request(h, "/api/events?channels=async-tasks&agentId=agent-a", {
      headers: { accept: "text/event-stream" },
    });
    const frames: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = await readSseFrame(res);
      frames.push(candidate);
      if (candidate.includes('"id":"task-oversized"')) break;
    }
    const frame = frames.find((candidate) => candidate.includes('"id":"task-oversized"'));
    expect(frame, JSON.stringify(frames)).toBeDefined();
    expect(Buffer.byteLength(frame!, "utf8")).toBeLessThanOrEqual(SSE_MAX_FRAME_BYTES);
    expect(frame).toContain('"id":"task-oversized"');
    expect(frame).toContain('"truncated":true');
    expect(frame).not.toContain('"label"');
    res.destroy();
  });

  it("envia um único snapshot recente quando a janela de tasks excede um frame", async () => {
    const h = await boot(30);
    h.gateway.setTaskSnapshotProvider((agentId, channel) => ({
      agentId,
      channel,
      epoch: "epoch-window",
      sequence: 40,
      items: Array.from({ length: 40 }, (_value, index) => ({ id: `task-${index}`, label: "x".repeat(20 * 1024) })),
    }));
    const res = await request(h, "/api/events?channels=async-tasks&agentId=agent-a", {
      headers: { accept: "text/event-stream" },
    });
    const frames: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = await readSseFrame(res);
      frames.push(candidate);
      if (candidate.includes('"id":"task-39"')) break;
    }
    const frame = frames.find((candidate) => candidate.includes('"id":"task-39"')) ?? "";
    expect(frame, JSON.stringify(frames)).not.toBe("");
    expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(SSE_MAX_FRAME_BYTES);
    expect(frame).toContain('"truncated":true');
    expect(frame).toContain('"id":"task-39"');
    expect(frame).not.toContain('"id":"task-0"');
    res.destroy();
  });

  it("sem ?channels= → recebe todos os canais do contrato (SseChannel)", async () => {
    const h = await boot();
    const res = await request(h, "/api/events?agentId=agent-a", {
      headers: { accept: "text/event-stream" },
    });
    await readChunk(res);
    for (const channel of SSE_CHANNELS) {
      const dataPromise = readChunk(res);
      h.gateway.publish(channel, { type: "contract-probe", agentId: "agent-a" });
      expect(await dataPromise).toContain(`"channel":"${channel}"`);
    }
    res.destroy();
  });
});

describe("T3 gateway — CSRF (Host/Origin loopback)", () => {
  it("POST /api/<method> com Origin estranha → 403 {error:csrf}", async () => {
    const h = await boot();
    const res = await request(h, "/api/sendPrompt", {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
      body: "{}",
      withAuth: false,
    });
    expect(res.statusCode).toBe(403);
    const json = (await readJson(res)) as { error: string };
    expect(json.error).toBe("csrf");
  });

  it("POST /api/<method> com Origin loopback → 200 (passa o guard)", async () => {
    const h = await boot();
    h.gateway.registerHandler("sendPrompt", () => ({ accepted: true }));
    const res = await request(h, "/api/sendPrompt", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3000" },
      body: "{}",
    });
    expect(res.statusCode).toBe(200);
    await readBody(res);
  });

  it("aceita Host e Origin IPv6 de loopback com porta", async () => {
    const h = await boot();
    h.gateway.registerHandler("sendPrompt", () => ({ accepted: true }));
    const res = await request(h, "/api/sendPrompt", {
      method: "POST",
      headers: { host: "[::1]:1340", origin: "http://[::1]:3000" },
      body: "{}",
    });
    expect(res.statusCode).toBe(200);
    await readBody(res);
  });

  it("POST /api/<method> com Host estranho → 403 {error:csrf}", async () => {
    const h = await boot();
    const res = await request(h, "/api/sendPrompt", {
      method: "POST",
      headers: { host: "evil.example.com" },
      body: "{}",
      withAuth: false,
    });
    expect(res.statusCode).toBe(403);
    const json = (await readJson(res)) as { error: string };
    expect(json.error).toBe("csrf");
  });

  it("GET /health ignora Origin estranha (rota sem CSRF) → 200", async () => {
    const h = await boot();
    const res = await request(h, "/health", {
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.statusCode).toBe(200);
    await readBody(res);
  });
});

describe("T3 gateway — gzip", () => {
  it("resposta grande com accept-encoding: gzip → content-encoding gzip + payload íntegro", async () => {
    const h = await boot();
    h.gateway.registerHandler("sendPrompt", () => ({
      big: "x".repeat(GZIP_MIN_BYTES * 4),
    }));
    const res = await request(h, "/api/sendPrompt", {
      method: "POST",
      headers: { "accept-encoding": "gzip" },
      body: "{}",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    const inflated = zlib.gunzipSync(await readBodyBuffer(res)).toString("utf8");
    const json = JSON.parse(inflated) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it("gzip;q=0 recusa compressão mesmo para resposta grande", async () => {
    const h = await boot();
    h.gateway.registerHandler("sendPrompt", () => ({ big: "x".repeat(GZIP_MIN_BYTES * 4) }));
    const res = await request(h, "/api/sendPrompt", {
      method: "POST",
      headers: { "accept-encoding": "br, gzip;q=0, *;q=1" },
      body: "{}",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(await readBody(res))).toMatchObject({ ok: true });
  });

  it("resposta grande sem accept-encoding → sem content-encoding (json puro)", async () => {
    const h = await boot();
    h.gateway.registerHandler("sendPrompt", () => ({
      big: "x".repeat(GZIP_MIN_BYTES * 4),
    }));
    const res = await request(h, "/api/sendPrompt", {
      method: "POST",
      body: "{}",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    await readBody(res);
  });
});

// --- helpers de leitura ---

async function readBody(res: http.IncomingMessage): Promise<string> {
  return (await readBodyBuffer(res)).toString("utf8");
}

async function readBodyBuffer(res: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(res: http.IncomingMessage): Promise<unknown> {
  return JSON.parse(await readBody(res)) as unknown;
}

async function flushTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForServerClosed(handle: ServerHandle, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (handle.server.listening) {
    if (Date.now() >= deadline) throw new Error(`server close timeout after ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** Lê o próximo chunk do stream de resposta (o próximo frame SSE). */
async function readChunk(res: http.IncomingMessage): Promise<string> {
  const [chunk] = await once(res, "data");
  return (chunk as Buffer).toString("utf8");
}

async function readSseFrame(res: http.IncomingMessage): Promise<string> {
  let buffered = sseResponseBuffers.get(res) ?? "";
  let queue = sseChunkQueues.get(res);
  if (queue === undefined) {
    queue = { chunks: [], waiters: [] };
    sseChunkQueues.set(res, queue);
    res.on("data", (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      const waiter = queue!.waiters.shift();
      if (waiter === undefined) queue!.chunks.push(text);
      else waiter(text);
    });
  }
  while (true) {
    const delimiter = buffered.indexOf("\n\n");
    if (delimiter >= 0) {
      const frame = buffered.slice(0, delimiter + 2);
      sseResponseBuffers.set(res, buffered.slice(delimiter + 2));
      return frame;
    }
    const queued = queue.chunks.shift();
    buffered += queued ?? await new Promise<string>((resolve) => queue.waiters.push(resolve));
  }
}
