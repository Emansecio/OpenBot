/**
 * T10 — Integração HTTP do turn runner (src/rpc/send.ts) com o gateway:
 * POST /api/sendPrompt aceita (dedupe por clientNonce provado por retry do
 * mesmo nonce) e o canal SSE `transcript` entrega snapshot + appended com os
 * kinds/message.type exatos do contrato (mapa-frontend §3.3).
 *
 * Cenário (fake provider, sem rede): usuário envia "olá" → ack {accepted:true}
 * → snapshot (reset) → appended com message do usuário e resposta textual
 * única do assistente; retry do MESMO nonce → accepted SEM novo turno.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GATEWAY_HOST, startServer, stopServer, type ServerHandle } from "../src/main.js";
import { createProviderRegistry, type ProviderAdapter, type ProviderChatRequest } from "../src/providers/router.js";
import { registerRpcHandlers } from "../src/rpc/index.js";
import { DEFAULT_AGENT_ID } from "../src/rpc/roster.js";
import { registerSendPromptHandler } from "../src/rpc/send.js";
import { createFakeAdapter } from "./mocks/fake-provider-adapter.js";

let activeHandles: ServerHandle[] = [];
let activeTempDirs: string[] = [];
const turnInvocations = (adapter: { invocations: Array<{ req: { purpose?: string; messages?: unknown[] } }> }) =>
  adapter.invocations.filter((invocation): invocation is { req: { purpose?: string; messages: unknown[] } } => (
    (invocation.req.purpose ?? "turn") === "turn"
  ));

/**
 * Todas as instâncias deste arquivo precisam ser completamente descartáveis.
 * O estado do servidor fica em um diretório irmão, nunca dentro de
 * `workspacesRoot`: AgentHomeStore interpreta cada entrada dessa árvore como
 * um possível id de agente.
 */
function isolatedServerOptions(workspacesRoot: string): {
  configPath: string;
  storePath: string;
  keystoreDir: string;
  runtimeRoot: string;
  browserRoot: string;
  workspacesRoot: string;
  allowUnauthenticatedLocalGateway: true;
} {
  const stateRoot = mkdtempSync(join(dirname(workspacesRoot), "openbot-state-"));
  activeTempDirs.push(stateRoot);
  return {
    configPath: join(stateRoot, "config.json"),
    storePath: join(stateRoot, "store.db"),
    keystoreDir: join(stateRoot, "keys"),
    runtimeRoot: join(stateRoot, "runtime"),
    browserRoot: join(stateRoot, "browser"),
    workspacesRoot,
    allowUnauthenticatedLocalGateway: true,
  };
}

afterEach(async () => {
  const handles = activeHandles;
  activeHandles = [];
  await Promise.all(handles.map((h) => stopServer(h)));
  for (const dir of activeTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Sobe o gateway com o turn runner plugado via registerRpcHandlers (T10). */
async function boot(opts: { deltas?: string[] } = {}): Promise<{
  handle: ServerHandle;
  adapter: ReturnType<typeof createFakeAdapter>;
}> {
  const registry = createProviderRegistry();
  const adapter = createFakeAdapter("xai", { deltas: opts.deltas ?? ["Olá, ", "mundo!"] });
  registry.register(adapter);

  const workspacesRoot = mkdtempSync(join(tmpdir(), "openbot-ws-"));
  activeTempDirs.push(workspacesRoot);
  const handle = await startServer(0, {
    startedAt: "2026-08-11T00:00:00.000Z",
    ...isolatedServerOptions(workspacesRoot),
  });
  registerRpcHandlers(handle.gateway, { registry });
  activeHandles.push(handle);
  return { handle, adapter };
}

function baseUrl(handle: ServerHandle): string {
  return `http://${GATEWAY_HOST}:${handle.port}`;
}

async function getJson(
  handle: ServerHandle,
  pathname: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: GATEWAY_HOST, port: handle.port, path: pathname, method: "GET", agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function postJson(
  handle: ServerHandle,
  pathname: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: GATEWAY_HOST,
        port: handle.port,
        path: pathname,
        method: "POST",
        headers: { "content-type": "application/json" },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) as Record<string, unknown> });
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

async function createAgent(handle: ServerHandle, id = DEFAULT_AGENT_ID, name = "Test Default"): Promise<void> {
  const created = await postJson(handle, "/api/createAgent", { id, name });
  if (created.status === 200) {
    expect(created.json).toMatchObject({ ok: true, value: { agent: { id } } });
    return;
  }
  expect(created.status).toBe(400);
  expect(created.json).toMatchObject({ ok: false, failure: "createAgent: id já existe" });
}

interface SseEvent {
  id?: string;
  channel: string;
  payload: {
    type: string;
    agentId: string;
    entries?: unknown[];
    entry?: unknown;
    fragment?: string;
    ordered?: { replicaKey: string; epoch: string; sequence: number };
    final?: boolean;
  };
}

/** Leitor de frames SSE com fila — chunks podem coalescer (não conta com 1 frame/chunk). */
class SseReader {
  private readonly buffer: SseEvent[] = [];
  private readonly waiters: Array<(event: SseEvent) => void> = [];
  private pending = "";

  constructor(private readonly res: http.IncomingMessage) {
    res.on("data", (chunk: Buffer) => {
      this.pending += chunk.toString("utf8");
      const frames = this.pending.split(/\r?\n\r?\n/u);
      this.pending = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).replace(/^ /u, ""))
          .join("\n");
        if (data.length === 0) continue; // retry/comments/empty SSE frame
        const idLine = frame.split(/\r?\n/u).find((line) => line.startsWith("id:"));
        const event = JSON.parse(data) as SseEvent;
        if (idLine !== undefined) event.id = idLine.slice("id:".length).trim();
        if (this.waiters.length > 0) this.waiters.shift()!(event);
        else this.buffer.push(event);
      }
    });
  }

  /** Próximo frame `data:` (JSON {channel,payload}). */
  next(): Promise<SseEvent> {
    const queued = this.buffer.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  unread(event: SseEvent): void {
    this.buffer.unshift(event);
  }

  destroy(): void {
    this.res.destroy();
  }
}

/** Abre um stream SSE em /api/events (sem filtro de canal) e consome o retry:. */
async function openSse(handle: ServerHandle): Promise<SseReader> {
  const res = await new Promise<http.IncomingMessage>((resolve) => {
    const req = http.request(
      {
        host: GATEWAY_HOST,
        port: handle.port,
        path: "/api/events",
        method: "GET",
        headers: { accept: "text/event-stream" },
        agent: false,
      },
      (r) => resolve(r),
    );
    req.on("error", () => {});
    req.end();
  });
  const reader = new SseReader(res);
  // The unscoped legacy stream starts with a transport resync instruction;
  // the turn runner publishes the authoritative transcript snapshot after
  // sendPrompt is accepted. Keep that control frame out of this old flow's
  // event assertions while preserving all later resync frames.
  const first = await reader.next();
  if (first.payload.type !== "resync") reader.unread(first);
  return reader;
}

describe("T10 gateway — POST /api/sendPrompt (turn runner plugado)", () => {
  it("startServer registra sendPrompt automaticamente", async () => {
    const workspacesRoot = mkdtempSync(join(tmpdir(), "openbot-ws-"));
    activeTempDirs.push(workspacesRoot);
    const handle = await startServer(0, {
      startedAt: "2026-08-11T00:00:00.000Z",
      ...isolatedServerOptions(workspacesRoot),
    });
    activeHandles.push(handle);
    await createAgent(handle);

    const res = await postJson(handle, "/api/sendPrompt", {
      agentId: DEFAULT_AGENT_ID,
      prompt: "boot automático",
    });

    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.value).toEqual({ accepted: true });
  });

  it("corpo inválido → 400 {ok:false,failure}", async () => {
    const { handle } = await boot();
    const res = await postJson(handle, "/api/sendPrompt", { agentId: "", clientNonce: 42 });
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
  });

  it("rejeita todos os formatos inválidos de clientNonce com um único bootstrap", async () => {
    const { handle } = await boot();
    for (const [clientNonce, label] of [
      ["", "vazio"],
      ["   ", "whitespace"],
      [null, "null"],
      [42, "número"],
    ] as const) {
      const res = await postJson(handle, "/api/sendPrompt", {
        agentId: "a",
        prompt: "olá",
        clientNonce,
      });
      expect(res.status, label).toBe(400);
      expect(res.json, label).toMatchObject({ ok: false });
    }
  });

  it("dedupe por clientNonce via HTTP: retry do mesmo nonce → accepted SEM turno novo", async () => {
    const { handle, adapter } = await boot({ deltas: ["resposta"] });
    const body = { agentId: "a", prompt: "olá", clientNonce: "nonce:abc" };

    const first = await postJson(handle, "/api/sendPrompt", body);
    expect(first.status).toBe(200);
    expect(first.json.value).toEqual({ accepted: true });
    const retry = await postJson(handle, "/api/sendPrompt", body);
    expect(retry.status).toBe(200);

    // Aguarda o turno terminar (a fila do runner esvazia).
    await waitFor(() => turnInvocations(adapter).length === 1);

    // 1 turno apenas (ledger de aceitação — o retry não rodou de novo).
    expect(turnInvocations(adapter)).toHaveLength(1);
    expect(turnInvocations(adapter)[0]?.req.messages).toEqual([{ role: "user", content: "olá" }]);
    expect(adapter.invocations.every((invocation) => ["turn", "memory-reflection", undefined].includes(invocation.req.purpose))).toBe(true);
  });

  it("retryPrompt HTTP é idempotente e não duplica a mensagem persistida", async () => {
    const registry = createProviderRegistry();
    const requests: unknown[] = [];
    let attempt = 0;
    registry.register({
      name: "xai",
      async streamChat(request, emit) {
        requests.push(request);
        attempt += 1;
        emit({ type: "delta", delta: attempt === 1 ? "parcial" : "recuperado" });
        if (attempt === 1) throw Object.assign(new Error("temporary"), { status: 503 });
      },
    });
    const workspacesRoot = mkdtempSync(join(tmpdir(), "openbot-retry-http-"));
    activeTempDirs.push(workspacesRoot);
    const handle = await startServer(0, { registry, ...isolatedServerOptions(workspacesRoot) });
    activeHandles.push(handle);
    await createAgent(handle);

    await postJson(handle, "/api/sendPrompt", {
      agentId: DEFAULT_AGENT_ID,
      prompt: "pergunta",
      clientNonce: "nonce:original",
    });
    await handle.runner.flush(DEFAULT_AGENT_ID);
    expect(await postJson(handle, "/api/retryPrompt", { agentId: DEFAULT_AGENT_ID }))
      .toMatchObject({ status: 200, json: { ok: true, value: { accepted: true } } });
    await handle.runner.flush(DEFAULT_AGENT_ID);
    expect(await postJson(handle, "/api/retryPrompt", { agentId: DEFAULT_AGENT_ID }))
      .toMatchObject({ status: 200, json: { ok: true, value: { accepted: true } } });
    await handle.runner.flush(DEFAULT_AGENT_ID);

    expect(requests.filter((request): request is ProviderChatRequest => typeof request === "object" && request !== null && (request as ProviderChatRequest).purpose !== "memory-reflection")).toHaveLength(2);
    const transcript = await postJson(handle, "/api/openAgentTail", { agentId: DEFAULT_AGENT_ID, limit: 50 });
    const entries = (transcript.json.value as { entries: Array<{ kind: string; role?: string; type?: string; content?: string }> }).entries;
    expect(entries.filter((entry) => entry.kind === "message" && entry.role === "user")).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === "notice" && entry.type === "retry-attempt")).toHaveLength(1);
    expect(entries.some((entry) => entry.kind === "message" && entry.content === "recuperado")).toBe(true);
  });
});

describe("T10 gateway — /health reflete o runner", () => {
  it("mostra agente ativo durante o turno e volta a inativo ao terminar", async () => {
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("xai", { deltas: ["ok"], deltaDelayMs: 80 });
    registry.register(adapter);
    const workspacesRoot = mkdtempSync(join(tmpdir(), "openbot-ws-"));
    activeTempDirs.push(workspacesRoot);
    const handle = await startServer(0, {
      startedAt: "2026-08-11T00:00:00.000Z",
      registry,
      ...isolatedServerOptions(workspacesRoot),
    });
    activeHandles.push(handle);
    await createAgent(handle);

    const accepted = await postJson(handle, "/api/sendPrompt", {
      agentId: DEFAULT_AGENT_ID,
      prompt: "aguarde",
    });
    expect(accepted.status).toBe(200);
    await waitFor(() => turnInvocations(adapter).length === 1);

    const active = await getJson(handle, "/health");
    expect(active.json).toMatchObject({ ok: true, isBusy: true, activeAgentId: DEFAULT_AGENT_ID });

    const runner = handle.runner;
    await runner.flush(DEFAULT_AGENT_ID);
    const idle = await getJson(handle, "/health");
    expect(idle.json).toMatchObject({ ok: true, isBusy: false, activeAgentId: null });
  });

  it("expõe estado cancelável por agente para o renderer", async () => {
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("xai", { deltas: ["ok"], deltaDelayMs: 80 });
    registry.register(adapter);
    const workspacesRoot = mkdtempSync(join(tmpdir(), "openbot-status-"));
    activeTempDirs.push(workspacesRoot);
    const handle = await startServer(0, { registry, ...isolatedServerOptions(workspacesRoot) });
    activeHandles.push(handle);
    await createAgent(handle);

    await postJson(handle, "/api/sendPrompt", { agentId: DEFAULT_AGENT_ID, prompt: "aguarde" });
    await waitFor(() => turnInvocations(adapter).length === 1);
    const active = await postJson(handle, "/api/getPromptStatus", { agentId: DEFAULT_AGENT_ID });
    expect(active).toMatchObject({ status: 200, json: { ok: true, value: { isBusy: true, canCancel: true } } });
    await handle.runner.flush(DEFAULT_AGENT_ID);
    const idle = await postJson(handle, "/api/getPromptStatus", { agentId: DEFAULT_AGENT_ID });
    expect(idle).toMatchObject({ status: 200, json: { ok: true, value: { isBusy: false, canCancel: false } } });
  });
});

describe("T11 gateway — rotas de transcript SQLite", () => {
  it("lê o transcript persistido por sendPrompt e expõe outline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-rpc-store-"));
    activeTempDirs.push(dir);
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("xai", { deltas: ["resposta"] });
    registry.register(adapter);
    const handle = await startServer(0, {
      registry,
      ...isolatedServerOptions(join(dir, "workspaces")),
      storePath: join(dir, "store.db"),
    });
    activeHandles.push(handle);
    await createAgent(handle);

    const accepted = await postJson(handle, "/api/sendPrompt", {
      agentId: DEFAULT_AGENT_ID,
      prompt: "pergunta",
      clientNonce: "nonce-persisted",
    });
    expect(accepted.status).toBe(200);
    await handle.runner.flush(DEFAULT_AGENT_ID);

    const page = await postJson(handle, "/api/getAgentTranscriptTail", {
      agentId: DEFAULT_AGENT_ID,
      limit: 10,
    });
    expect(page.status).toBe(200);
    expect(page.json).toMatchObject({ ok: true });
    const pageValue = page.json.value as { entries: Array<{ kind: string; content?: string }> };
    expect(pageValue.entries.some((entry) => entry.kind === "message" && entry.content === "pergunta")).toBe(true);
    expect(pageValue.entries.some((entry) => entry.kind === "message" && entry.content === "resposta")).toBe(true);

    const orderMap = (handle.runner as unknown as { transcriptOrderByKey: Map<string, { epoch: string }> }).transcriptOrderByKey;
    const beforeResyncEpoch = orderMap.get(`transcript:${DEFAULT_AGENT_ID}`)?.epoch;
    const resync = await postJson(handle, "/api/getAgentTranscriptTail", {
      agentId: DEFAULT_AGENT_ID,
      limit: 10,
      authoritativeResync: true,
    });
    expect(resync.status).toBe(200);
    expect(orderMap.get(`transcript:${DEFAULT_AGENT_ID}`)?.epoch).not.toBe(beforeResyncEpoch);

    const outline = await postJson(handle, "/api/getConversationOutline", { agentId: DEFAULT_AGENT_ID });
    expect(outline.status).toBe(200);
    expect(outline.json).toMatchObject({
      ok: true,
      value: [{ title: "pergunta", lastMessage: "resposta" }],
    });
  });

  it("authoritativeResync retorna SQLite, gira epoch e rebaseia o stream ativo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-authoritative-resync-"));
    activeTempDirs.push(dir);
    const registry = createProviderRegistry();
    let releaseSecondDelta: () => void = () => undefined;
    const secondDelta = new Promise<void>((resolve) => {
      releaseSecondDelta = resolve;
    });
    const adapter: ProviderAdapter = {
      name: "xai",
      async streamChat(request, emit) {
        emit({ type: "delta", delta: "parcial" });
        const aborted = new Promise<never>((_, reject) => {
          const signal = request.signal;
          if (signal === undefined) return;
          const onAbort = () => {
            const error = new Error("barrier provider aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
        await Promise.race([secondDelta, aborted]);
        emit({ type: "delta", delta: " final" });
      },
    };
    registry.register(adapter);
    const handle = await startServer(0, {
      registry,
      ...isolatedServerOptions(join(dir, "workspaces")),
      storePath: join(dir, "store.db"),
    });
    activeHandles.push(handle);
    await createAgent(handle);
    const sse = await openSse(handle);

    const accepted = await postJson(handle, "/api/sendPrompt", {
      agentId: DEFAULT_AGENT_ID,
      prompt: "stream ativo",
      clientNonce: "nonce-authoritative-resync",
    });
    expect(accepted.status).toBe(200);

    let firstDelta: SseEvent | undefined;
    for (;;) {
      const event = await sse.next();
      if (event.payload.type === "delta") {
        firstDelta = event;
        break;
      }
    }
    expect(firstDelta?.payload.fragment).toBe("parcial");
    const firstOrder = firstDelta?.payload.ordered;
    expect(firstOrder).toMatchObject({
      replicaKey: `transcript:${DEFAULT_AGENT_ID}`,
    });
    expect(firstOrder?.sequence).toBeGreaterThan(0);
    const orderMap = (handle.runner as unknown as {
      transcriptOrderByKey: Map<string, { epoch: string; sequence: number }>;
    }).transcriptOrderByKey;
    const firstEpoch = firstOrder?.epoch;
    expect(firstEpoch).toBe(orderMap.get(`transcript:${DEFAULT_AGENT_ID}`)?.epoch);

    // A normal durable read is observational: it must not fence the active
    // ordered namespace.
    const normal = await postJson(handle, "/api/getAgentTranscriptTail", {
      agentId: DEFAULT_AGENT_ID,
      limit: 50,
    });
    expect(normal.status).toBe(200);
    expect(orderMap.get(`transcript:${DEFAULT_AGENT_ID}`)?.epoch).toBe(firstEpoch);

    const live = await postJson(handle, "/api/openAgentTail", {
      agentId: DEFAULT_AGENT_ID,
      limit: 50,
    });
    const liveEntries = (live.json.value as { entries: Array<{ role?: string; content?: string }> }).entries;
    expect(liveEntries.some((entry) => entry.role === "assistant" && entry.content === "parcial")).toBe(true);

    const resync = await postJson(handle, "/api/getAgentTranscriptTail", {
      agentId: DEFAULT_AGENT_ID,
      limit: 50,
      authoritativeResync: true,
    });
    expect(resync.status).toBe(200);
    const durableEntries = (resync.json.value as { entries: Array<{ role?: string; content?: string }> }).entries;
    expect(durableEntries.some((entry) => entry.role === "assistant" && entry.content?.includes("parcial"))).toBe(false);
    expect(orderMap.get(`transcript:${DEFAULT_AGENT_ID}`)?.epoch).not.toBe(firstEpoch);
    const rotatedEpoch = orderMap.get(`transcript:${DEFAULT_AGENT_ID}`)?.epoch;

    // The reconnect cursor is a full authoritative snapshot, not a paginated
    // historical read. Rejecting beforeSeq prevents a partial fence from
    // being mistaken for a complete resync.
    const invalidResync = await postJson(handle, "/api/getAgentTranscriptTail", {
      agentId: DEFAULT_AGENT_ID,
      limit: 50,
      beforeSeq: 1,
      authoritativeResync: true,
    });
    expect(invalidResync.status).toBe(400);
    expect(orderMap.get(`transcript:${DEFAULT_AGENT_ID}`)?.epoch).toBe(rotatedEpoch);

    const invalidLegacyResync = await postJson(handle, "/api/openAgentTail", {
      agentId: DEFAULT_AGENT_ID,
      limit: 50,
      authoritativeResync: true,
    });
    expect(invalidLegacyResync.status).toBe(400);
    expect(orderMap.get(`transcript:${DEFAULT_AGENT_ID}`)?.epoch).toBe(rotatedEpoch);

    // The live turn is not discarded by the fence. Its next provider fragment
    // first publishes a fresh-epoch baseline, then the ordered delta.
    releaseSecondDelta();
    let rebased: SseEvent | undefined;
    for (;;) {
      const event = await sse.next();
      if (event.payload.ordered?.epoch === rotatedEpoch) {
        rebased = event;
        break;
      }
    }
    expect(rebased?.payload.type).toBe("appended");
    expect(rebased?.payload.ordered).toMatchObject({
      replicaKey: `transcript:${DEFAULT_AGENT_ID}`,
      epoch: rotatedEpoch,
      sequence: 1,
    });
    expect((rebased?.payload.entry as { content?: string } | undefined)?.content).toBe("parcial");

    await handle.runner.flush(DEFAULT_AGENT_ID);
    sse.destroy();
  });

  it("reabre o mesmo store e deduplica nonce após restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-restart-store-"));
    activeTempDirs.push(dir);
    const storePath = join(dir, "store.db");
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("xai", { deltas: ["uma vez"] });
    registry.register(adapter);
    const workspacesRoot = join(dir, "workspaces");
    const isolated = isolatedServerOptions(workspacesRoot);
    const first = await startServer(0, { registry, ...isolated, storePath });
    await createAgent(first);
    await postJson(first, "/api/sendPrompt", {
      agentId: DEFAULT_AGENT_ID,
      prompt: "persistir",
      clientNonce: "restart-nonce",
    });
    await first.runner.flush(DEFAULT_AGENT_ID);
    await stopServer(first);

    const second = await startServer(0, { registry, ...isolated, storePath });
    activeHandles.push(second);
    const retry = await postJson(second, "/api/sendPrompt", {
      agentId: DEFAULT_AGENT_ID,
      prompt: "persistir",
      clientNonce: "restart-nonce",
    });
    expect(retry.status).toBe(200);
    await second.runner.flush(DEFAULT_AGENT_ID);
    expect(turnInvocations(adapter)).toHaveLength(1);

    const page = await postJson(second, "/api/openAgentTail", { agentId: DEFAULT_AGENT_ID });
    expect(page.status).toBe(200);
    // user + assistant; a resposta textual não ganha um card `send-message`
    // paralelo.
    expect((page.json.value as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it("valida argumentos das rotas de transcript", async () => {
    const workspacesRoot = mkdtempSync(join(tmpdir(), "openbot-ws-"));
    activeTempDirs.push(workspacesRoot);
    const handle = await startServer(0, isolatedServerOptions(workspacesRoot));
    activeHandles.push(handle);
    const invalidAgent = await postJson(handle, "/api/getAgentTranscriptTail", { agentId: "" });
    expect(invalidAgent.status).toBe(400);
    const invalidLimit = await postJson(handle, "/api/openAgentTail", { agentId: "a", limit: 0 });
    expect(invalidLimit.status).toBe(400);
    const invalidCursor = await postJson(handle, "/api/getAgentTranscriptTail", { agentId: "a", cursor: "nope" });
    expect(invalidCursor.status).toBe(400);
  });
});

describe("T10 gateway — SSE transcript: snapshot + appended (kinds/message.type exatos)", () => {
  it("fluxo completo: snapshot (reset) → message user + resposta textual única", async () => {
    const { handle } = await boot();
    const sse = await openSse(handle);

    const accepted = await postJson(handle, "/api/sendPrompt", {
      agentId: "openbot-default",
      prompt: "olá",
    });
    expect(accepted.status).toBe(200);

    // 1º evento: snapshot (reset) — histórico vazio no início.
    const snapshot = await sse.next();
    expect(snapshot.channel).toBe("transcript");
    expect(snapshot.payload.type).toBe("snapshot");
    expect(snapshot.payload.entries).toEqual([]);

    // 2º evento: appended — message do usuário.
    const appendedUser = await sse.next();
    expect(appendedUser.payload.type).toBe("appended");
    expect(appendedUser.payload.agentId).toBe("openbot-default");
    const user = appendedUser.payload.entry as Record<string, unknown>;
    expect(user).toMatchObject({
      kind: "message",
      role: "user",
      content: "olá",
      fromUser: { name: "You", authId: "local-user" },
      streaming: false,
    });
    expect(user).not.toHaveProperty("toAgent");

    // 3º evento: appended — message do assistente em streaming; o texto fecha em updated.
    const appendedAssistant = await sse.next();
    expect(appendedAssistant.payload.type).toBe("appended");
    const assistant = appendedAssistant.payload.entry as Record<string, unknown>;
    expect(assistant).toMatchObject({
      kind: "message",
      role: "assistant",
      streaming: true,
    });
    expect(assistant).not.toHaveProperty("fromAgent");
    let finalAssistant: { kind?: string; content?: string; streaming?: boolean } | undefined;
    let textCard: { kind: string; message?: { type: string; content?: string } } | undefined;
    let finalText = String(assistant.content ?? "");
    for (let i = 0; i < 8; i += 1) {
      const next = await sse.next();
      if (next.payload.type === "delta") continue;
      const entry = next.payload.entry as { kind?: string; content?: string; streaming?: boolean; message?: { type: string; content?: string } };
      if (next.payload.type === "updated" && entry.kind === "message") {
        finalText = String(entry.content ?? finalText);
        if (entry.streaming === false) {
          finalAssistant = entry;
          break;
        }
        continue;
      }
      if (entry.kind === "send-message") {
        if (entry.message?.type === "text") textCard = entry as { kind: string; message?: { type: string; content?: string } };
      }
    }
    expect(finalText).toContain("mundo");
    expect(finalAssistant).toMatchObject({ kind: "message", content: "Olá, mundo!", streaming: false });
    expect(textCard).toBeUndefined();

    sse.destroy();
  });

  it("todos os kinds emitidos são reconhecidos pelo contrato (nenhum card missing)", async () => {
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("xai", {
      deltas: ["Vou ", "executar"],
      toolCalls: [{ id: "call_1", name: "shell", arguments: '{"cmd":"dir"}' }],
    });
    registry.register(adapter);
    const workspacesRoot = mkdtempSync(join(tmpdir(), "openbot-ws-"));
    activeTempDirs.push(workspacesRoot);
    const handle = await startServer(0, {
      startedAt: "2026-08-11T00:00:00.000Z",
      ...isolatedServerOptions(workspacesRoot),
    });
    registerSendPromptHandler(handle.gateway, { registry });
    activeHandles.push(handle);

    const sse = await openSse(handle);
    await postJson(handle, "/api/sendPrompt", {
      agentId: "a",
      prompt: "rode",
      attachments: [{ path: "C:\\docs\\a.txt", name: "a.txt" }],
    });

    const seenKinds = new Set<string>();
    let sawAssistant = false;
    for (;;) {
      const evt = await sse.next();
      if (evt.payload.type === "delta") continue;
      const entry = evt.payload.entry;
      if (entry === undefined) continue;
      const e = entry as { kind: string; role?: string; streaming?: boolean };
      if (evt.payload.type === "appended") {
        seenKinds.add(e.kind);
        if (e.kind === "message" && e.role === "assistant") sawAssistant = true;
      }
      // O último evento é `updated` com a mesma message/assistant fechada.
      if (evt.payload.type === "updated" && sawAssistant && e.kind === "message" && e.streaming === false) break;
    }
    sse.destroy();

    // kinds emitidos pelo runner (mapa-frontend §3.3):
    // message / user-attachment / tool-call — todos emitidos por este fluxo.
    expect(seenKinds).toEqual(new Set(["message", "user-attachment", "tool-call"]));
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** Lê o próximo chunk do stream de resposta (o próximo frame SSE). */
async function readChunk(res: http.IncomingMessage): Promise<string> {
  const [chunk] = await once(res, "data");
  return (chunk as Buffer).toString("utf8");
}

/** Espera até a condição ser verdadeira (poll barato com limite de tempo). */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timeout aguardando condição");
    await new Promise((r) => setTimeout(r, 5));
  }
}
