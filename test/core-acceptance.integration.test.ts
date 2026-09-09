/**
 * Core acceptance gate: one active production startServer at a time owns the
 * complete path from roster/config RPC through an OpenAI-compatible HTTP
 * stream and the SQLite transcript/nonce ledger; persistence uses a controlled
 * stop/restart on the same isolated paths.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GATEWAY_HOST, startServer, stopServer, type ServerHandle } from "../src/main.js";
import { localFileBackend } from "../src/keystore/backend.js";
import { createKeystore, type Keystore } from "../src/keystore/index.js";

const AGENT_ID = "core-gate-bot";
const API_KEY = "core-gate-local-key";
const CLIENT_NONCE = "core-gate-nonce-1";

interface AcceptanceRequest {
  headers: http.IncomingHttpHeaders;
  url: string;
  body: unknown;
  streamReady: boolean;
  chunksWritten: number;
  abortObserved: boolean;
  abortedAtChunks: number | undefined;
  chunksAfterAbort: number;
  completedNaturally: boolean;
}

interface AcceptanceProvider {
  baseUrl: string;
  requests: AcceptanceRequest[];
  close(): Promise<void>;
}

interface AcceptanceProviderOptions {
  failFirstStatus?: number;
  chunkDelayMs?: number;
}

const CANCEL_DELTAS = Array.from({ length: 20 }, (_unused, index) => `chunk-${index}`);

interface IsolatedPaths {
  stateRoot: string;
  configPath: string;
  storePath: string;
  keystoreDir: string;
  runtimeRoot: string;
  browserRoot: string;
  workspacesRoot: string;
  allowUnauthenticatedLocalGateway: true;
}

const activeHandles: ServerHandle[] = [];
const activeProviders: AcceptanceProvider[] = [];
const activeSseReaders: SseReader[] = [];
const activeTempDirs: string[] = [];

function requestPurpose(request: AcceptanceRequest): string {
  const value = request.headers["x-openbot-purpose"];
  if (Array.isArray(value)) return value[0] ?? "turn";
  return typeof value === "string" && value.length > 0 ? value : "turn";
}

function turnProviderRequests(provider: AcceptanceProvider): AcceptanceRequest[] {
  return provider.requests.filter((request) => requestPurpose(request) === "turn");
}

function isolatedPaths(workspacesRoot: string): IsolatedPaths {
  const stateRoot = mkdtempSync(join(dirname(workspacesRoot), "openbot-core-gate-state-"));
  activeTempDirs.push(stateRoot);
  return {
    stateRoot,
    configPath: join(stateRoot, "config.json"),
    storePath: join(stateRoot, "store.db"),
    keystoreDir: join(stateRoot, "keys"),
    runtimeRoot: join(stateRoot, "runtime"),
    browserRoot: join(stateRoot, "browser"),
    workspacesRoot,
    allowUnauthenticatedLocalGateway: true,
  };
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw.length === 0 ? undefined : JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function providerFrame(delta: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
}

function startAcceptanceProvider(
  deltas: readonly string[],
  options: AcceptanceProviderOptions = {},
): Promise<AcceptanceProvider> {
  const requests: AcceptanceRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const body = await readJsonBody(req);
    const request: AcceptanceRequest = {
      headers: req.headers,
      url: req.url ?? "",
      body,
      streamReady: false,
      chunksWritten: 0,
      abortObserved: false,
      abortedAtChunks: undefined,
      chunksAfterAbort: 0,
      completedNaturally: false,
    };
    requests.push(request);
    res.on("close", () => {
      if (!res.writableEnded) {
        request.abortObserved = true;
        request.abortedAtChunks = request.chunksWritten;
      }
    });

    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    if (options.failFirstStatus !== undefined && requests.length === 1) {
      res.writeHead(options.failFirstStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "transient acceptance failure" } }));
      return;
    }

    res.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    request.streamReady = true;
    for (const delta of deltas) {
      if (res.destroyed) return;
      if (request.abortObserved) {
        request.chunksAfterAbort += 1;
        return;
      }
      res.write(providerFrame(delta));
      request.chunksWritten += 1;
      if (options.chunkDelayMs !== undefined && options.chunkDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.chunkDelayMs));
      }
    }
    if (res.destroyed || request.abortObserved) return;
    request.completedNaturally = true;
    res.end("data: [DONE]\n\n");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, GATEWAY_HOST, () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("provider server did not expose an address"));
        return;
      }
      resolve({
        baseUrl: `http://${GATEWAY_HOST}:${address.port}/v1`,
        requests,
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve());
        }),
      });
    });
  });
}

function keystoreFor(paths: IsolatedPaths): Keystore {
  const master = Buffer.alloc(32, 7);
  const backend = localFileBackend(master);
  return createKeystore({ dir: paths.keystoreDir, writeBackend: backend, legacyReadBackend: backend });
}

function gatewayUrl(handle: ServerHandle): string {
  return `http://${GATEWAY_HOST}:${handle.port}`;
}

interface TranscriptSseEntry {
  id?: string;
  kind?: string;
  role?: string;
  content?: string;
  streaming?: boolean;
}

interface TranscriptSseEvent {
  channel: string;
  payload: {
    type: string;
    agentId: string;
    entry?: TranscriptSseEntry;
    entryId?: string;
    fragment?: string;
    ordered?: { replicaKey: string; epoch: string; sequence: number };
  };
}

/** Leitor SSE com timeout para provar eventos incrementais sem depender de flush. */
class SseReader {
  private readonly buffer: string[] = [];
  private pending = "";
  private readonly waiters: Array<{
    resolve: (frame: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(private readonly response: http.IncomingMessage) {
    response.on("data", (chunk: Buffer) => {
      this.pending += chunk.toString("utf8");
      this.consumeCompleteFrames();
    });
    response.on("error", (error) => this.rejectWaiters(error instanceof Error ? error : new Error(String(error))));
    response.on("end", () => this.flushFinalFrame());
    response.on("close", () => {
      this.flushFinalFrame();
      this.rejectWaiters(new Error("transcript SSE closed"));
    });
  }

  next(timeoutMs = 5000): Promise<TranscriptSseEvent> {
    const queued = this.buffer.shift();
    if (queued !== undefined) return Promise.resolve(JSON.parse(queued) as TranscriptSseEvent);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const waiter = {
        resolve: (frame: string) => {
          try {
            resolve(JSON.parse(frame) as TranscriptSseEvent);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        reject,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("timeout waiting for transcript SSE event"));
      }, timeoutMs);
      waiter.timer = timer;
      this.waiters.push(waiter);
    });
  }

  destroy(): void {
    this.rejectWaiters(new Error("transcript SSE destroyed"));
    this.response.destroy();
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private consumeCompleteFrames(): void {
    while (true) {
      const delimiter = /\r?\n\r?\n/.exec(this.pending);
      if (!delimiter || delimiter.index === undefined) return;
      const frame = this.pending.slice(0, delimiter.index);
      this.pending = this.pending.slice(delimiter.index + delimiter[0].length);
      this.enqueueFrame(frame);
    }
  }

  private flushFinalFrame(): void {
    const frame = this.pending;
    this.pending = "";
    if (frame.trim().length === 0) return;
    const data = this.frameData(frame);
    if (data.length === 0 || data === "[DONE]") return;
    try {
      JSON.parse(data);
    } catch {
      // A truncated final frame is discarded rather than handed to next().
      return;
    }
    this.enqueueData(data);
  }

  private enqueueFrame(frame: string): void {
    const data = this.frameData(frame);
    if (data.length === 0 || data === "[DONE]") return;
    this.enqueueData(data);
  }

  private frameData(frame: string): string {
    return frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
      .trim();
  }

  private enqueueData(data: string): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(data);
    } else {
      this.buffer.push(data);
    }
  }
}

async function openTranscriptSse(handle: ServerHandle): Promise<SseReader> {
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.request(
      {
        host: GATEWAY_HOST,
        port: handle.port,
        path: "/api/events?channels=transcript",
        method: "GET",
        headers: { accept: "text/event-stream" },
        agent: false,
      },
      resolve,
    );
    request.on("error", reject);
    request.end();
  });
  await once(response, "data");
  return new SseReader(response);
}

function listArtifactFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listArtifactFiles(path) : [path];
  });
}

function expectSecretAbsentFromArtifacts(root: string): void {
  const secret = Buffer.from(API_KEY, "utf8");
  for (const path of listArtifactFiles(root)) {
    expect(readFileSync(path).includes(secret), `${path} contains the provider secret`).toBe(false);
  }
}

async function rpc(
  handle: ServerHandle,
  method: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${gatewayUrl(handle)}/api/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

async function flush(handle: ServerHandle): Promise<void> {
  await handle.runner.flush(AGENT_ID);
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for core acceptance condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForStableCounter(read: () => number, windowMs: number): Promise<number> {
  const initial = read();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const final = read();
  expect(final).toBe(initial);
  return final;
}

afterEach(async () => {
  let primaryError: unknown;
  let hasPrimaryError = false;
  const rememberFirstRejection = (results: readonly PromiseSettledResult<unknown>[]): void => {
    if (hasPrimaryError) return;
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) {
      primaryError = rejected.reason;
      hasPrimaryError = true;
    }
  };

  try {
    rememberFirstRejection(await Promise.allSettled(
      activeSseReaders.map((reader) => Promise.resolve().then(() => reader.destroy())),
    ));
    rememberFirstRejection(await Promise.allSettled(
      activeHandles.map((handle) => stopServer(handle)),
    ));
    rememberFirstRejection(await Promise.allSettled(
      activeProviders.map((provider) => provider.close()),
    ));
    rememberFirstRejection(await Promise.allSettled(
      activeTempDirs.map((directory) => Promise.resolve().then(() => rmSync(directory, { recursive: true, force: true }))),
    ));
  } finally {
    // Keep the references until every cleanup attempt above has settled.
    activeSseReaders.length = 0;
    activeHandles.length = 0;
    activeProviders.length = 0;
    activeTempDirs.length = 0;
  }

  if (hasPrimaryError) throw primaryError;
});

describe("core acceptance gate", () => {
  it("runs the production chat path and persists roster, provider, transcript and nonce across restart", async () => {
    const workspacesRoot = mkdtempSync(join(tmpdir(), "openbot-core-gate-"));
    activeTempDirs.push(workspacesRoot);
    const paths = isolatedPaths(workspacesRoot);
    const provider = await startAcceptanceProvider(["Resposta ", "determinística"], { chunkDelayMs: 30 });
    activeProviders.push(provider);

    const first = await startServer(0, {
      ...paths,
      keystore: keystoreFor(paths),
      sharedIntegrationsEnabled: false,
    });
    activeHandles.push(first);
    const transcriptSse = await openTranscriptSse(first);
    activeSseReaders.push(transcriptSse);

    const emptyRoster = await rpc(first, "listAgents", {});
    expect(emptyRoster.status).toBe(200);
    expect(emptyRoster.json).toMatchObject({ ok: true, value: [] });

    const created = await rpc(first, "createAgent", {
      id: AGENT_ID,
      name: "Gate Name",
      title: "Gate Title",
      description: "Gate Description",
    });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({
      ok: true,
      value: { agent: { id: AGENT_ID, name: "Gate Name", title: "Gate Title", description: "Gate Description" } },
    });

    const secret = await rpc(first, "setBoxSecrets", {
      entries: [{ provider: "openai-compat", apiKey: API_KEY }],
    });
    expect(secret.status).toBe(200);
    expect(JSON.stringify(secret.json)).not.toContain(API_KEY);
    expect(readFileSync(first.keystore.getFile(), "utf8")).not.toContain(API_KEY);
    expect(readFileSync(paths.configPath, "utf8")).not.toContain(API_KEY);
    const secretStatus = await rpc(first, "getBoxSecretsStatus", {});
    expect(secretStatus.status).toBe(200);
    expect(secretStatus.json).toMatchObject({ ok: true, value: { secrets: ["openai-compat"] } });
    expect(JSON.stringify(secretStatus.json)).not.toContain(API_KEY);

    const configured = await rpc(first, "setProviderConfig", {
      agentId: AGENT_ID,
      provider: "openai-compat",
      model: "core-gate-model",
      baseURL: provider.baseUrl,
    });
    expect(configured.status).toBe(200);
    expect(configured.json).toMatchObject({
      ok: true,
      value: { agentId: AGENT_ID, provider: "openai-compat", model: "core-gate-model", baseURL: provider.baseUrl },
    });

    const sent = await rpc(first, "sendPrompt", {
      agentId: AGENT_ID,
      prompt: "Olá, gate",
      clientNonce: CLIENT_NONCE,
    });
    expect(sent.status).toBe(200);
    expect(sent.json).toMatchObject({ ok: true, value: { accepted: true } });
    await waitFor(() => turnProviderRequests(provider).length === 1);

    expect(turnProviderRequests(provider)).toHaveLength(1);
    const request = turnProviderRequests(provider)[0];
    expect(request?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(requestPurpose(request!)).toBe("turn");
    expect(request?.body).toMatchObject({ model: "core-gate-model", stream: true });
    expect(JSON.stringify(request?.body) ?? "").not.toContain(API_KEY);
    const messages = (request?.body as { messages?: Array<{ role: string; content: string }> }).messages ?? [];
    const system = messages.find((message) => message.role === "system")?.content;
    expect(system).toContain("Gate Name");
    expect(system).toContain("Gate Description");
    expect(messages.at(-1)).toEqual({ role: "user", content: "Olá, gate" });

    let intermediate = await transcriptSse.next();
    let assistantEntryId: string | undefined;
    let streamedText = "";
    let firstDeltaSeen = false;
    let lastDeltaSequence = 0;
    while (assistantEntryId === undefined || streamedText !== "Resposta determinística") {
      if (intermediate.channel !== "transcript" || intermediate.payload.agentId !== AGENT_ID) {
        intermediate = await transcriptSse.next();
        continue;
      }
      if (intermediate.payload.type === "appended" && intermediate.payload.entry?.kind === "message" && intermediate.payload.entry.role === "assistant") {
        expect(intermediate.payload.entry.streaming).toBe(true);
        expect(intermediate.payload.entry.content).toBe("");
        assistantEntryId = intermediate.payload.entry.id;
      } else if (intermediate.payload.type === "delta") {
        expect(assistantEntryId).toBeDefined();
        expect(intermediate.payload.entryId).toBe(assistantEntryId);
        expect(typeof intermediate.payload.fragment).toBe("string");
        expect(intermediate.payload.ordered?.sequence).toBeGreaterThan(lastDeltaSequence);
        lastDeltaSequence = intermediate.payload.ordered?.sequence ?? lastDeltaSequence;
        streamedText += intermediate.payload.fragment ?? "";
        if (!firstDeltaSeen) {
          expect(intermediate.payload.fragment).toBe("Resposta ");
          firstDeltaSeen = true;
        }
      }
      intermediate = await transcriptSse.next();
    }
    expect(firstDeltaSeen).toBe(true);
    expect(streamedText).toBe("Resposta determinística");
    await flush(first);

    const transcript = await rpc(first, "openAgentTail", { agentId: AGENT_ID, limit: 20 });
    expect(transcript.status).toBe(200);
    const entries = (transcript.json.value as { entries: Array<{ kind: string; role?: string; content?: string }> }).entries;
    expect(entries).toHaveLength(2);
    expect(entries.filter((entry) => entry.kind === "message" && entry.role === "assistant")).toHaveLength(1);
    expect(entries.find((entry) => entry.role === "assistant")?.content).toBe("Resposta determinística");
    expect(JSON.stringify(transcript.json)).not.toContain(API_KEY);
    expectSecretAbsentFromArtifacts(workspacesRoot);
    expect(await rpc(first, "promptAcceptanceStatus", { agentId: AGENT_ID, clientNonce: CLIENT_NONCE })).toMatchObject({
      status: 200,
      json: { ok: true, value: { outcome: "found", record: { status: "accepted" } } },
    });

    transcriptSse.destroy();
    await stopServer(first);
    activeSseReaders.splice(activeSseReaders.indexOf(transcriptSse), 1);
    activeHandles.splice(activeHandles.indexOf(first), 1);

    const second = await startServer(0, {
      ...paths,
      keystore: keystoreFor(paths),
      sharedIntegrationsEnabled: false,
    });
    activeHandles.push(second);
    expect(await rpc(second, "listAgents", {})).toMatchObject({
      status: 200,
      json: { ok: true, value: [{ id: AGENT_ID, name: "Gate Name", title: "Gate Title", description: "Gate Description" }] },
    });
    expect(await rpc(second, "getProviderConfig", { agentId: AGENT_ID })).toMatchObject({
      status: 200,
      json: { ok: true, value: { provider: "openai-compat", model: "core-gate-model", baseURL: provider.baseUrl } },
    });
    const persistedSecretStatus = await rpc(second, "getBoxSecretsStatus", {});
    expect(persistedSecretStatus).toMatchObject({
      status: 200,
      json: { ok: true, value: { secrets: ["openai-compat"] } },
    });
    expect(JSON.stringify(persistedSecretStatus.json)).not.toContain(API_KEY);

    const retry = await rpc(second, "sendPrompt", {
      agentId: AGENT_ID,
      prompt: "Olá, gate",
      clientNonce: CLIENT_NONCE,
    });
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ ok: true, value: { accepted: true } });
    await flush(second);
    expect(turnProviderRequests(provider)).toHaveLength(1);
    expect(await rpc(second, "promptAcceptanceStatus", { agentId: AGENT_ID, clientNonce: CLIENT_NONCE })).toMatchObject({
      status: 200,
      json: { ok: true, value: { outcome: "found", record: { status: "accepted" } } },
    });
    const persisted = await rpc(second, "openAgentTail", { agentId: AGENT_ID, limit: 20 });
    expect((persisted.json.value as { entries: unknown[] }).entries).toHaveLength(2);
    expect(JSON.stringify(persisted.json)).not.toContain(API_KEY);
    expectSecretAbsentFromArtifacts(workspacesRoot);
  });

  it("retries one transient provider failure without duplicating the accepted turn", async () => {
    const workspacesRoot = mkdtempSync(join(tmpdir(), "openbot-core-gate-retry-"));
    activeTempDirs.push(workspacesRoot);
    const paths = isolatedPaths(workspacesRoot);
    const provider = await startAcceptanceProvider(["retry success"], { failFirstStatus: 503 });
    activeProviders.push(provider);
    const handle = await startServer(0, {
      ...paths,
      keystore: keystoreFor(paths),
      sharedIntegrationsEnabled: false,
    });
    activeHandles.push(handle);

    await rpc(handle, "createAgent", { id: AGENT_ID, name: "Retry Bot", description: "Retry gate" });
    await rpc(handle, "setBoxSecrets", { entries: [{ provider: "openai-compat", apiKey: API_KEY }] });
    await rpc(handle, "setProviderConfig", {
      agentId: AGENT_ID,
      provider: "openai-compat",
      model: "core-gate-retry-model",
      baseURL: provider.baseUrl,
    });

    const sent = await rpc(handle, "sendPrompt", {
      agentId: AGENT_ID,
      prompt: "retry gate",
      clientNonce: "core-gate-retry-nonce",
    });
    expect(sent).toMatchObject({ status: 200, json: { ok: true, value: { accepted: true } } });
    await flush(handle);

    expect(turnProviderRequests(provider)).toHaveLength(2);
    expect(turnProviderRequests(provider)[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(turnProviderRequests(provider)[1]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    const transcript = await rpc(handle, "openAgentTail", { agentId: AGENT_ID, limit: 20 });
    const entries = (transcript.json.value as { entries: Array<{ kind: string; role?: string; content?: string }> }).entries;
    expect(entries.filter((entry) => entry.kind === "message" && entry.role === "user")).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === "message" && entry.role === "assistant")).toHaveLength(1);
    expect(entries.find((entry) => entry.role === "assistant")?.content).toBe("retry success");
  });

  it("observes provider abort on cancel and accepts the next turn", async () => {
    const workspacesRoot = mkdtempSync(join(tmpdir(), "openbot-core-gate-cancel-"));
    activeTempDirs.push(workspacesRoot);
    const paths = isolatedPaths(workspacesRoot);
    const provider = await startAcceptanceProvider(
      CANCEL_DELTAS,
      { chunkDelayMs: 25 },
    );
    activeProviders.push(provider);
    const handle = await startServer(0, {
      ...paths,
      keystore: keystoreFor(paths),
      sharedIntegrationsEnabled: false,
    });
    activeHandles.push(handle);

    await rpc(handle, "createAgent", { id: AGENT_ID, name: "Cancel Bot", description: "Cancel gate" });
    await rpc(handle, "setBoxSecrets", { entries: [{ provider: "openai-compat", apiKey: API_KEY }] });
    await rpc(handle, "setProviderConfig", {
      agentId: AGENT_ID,
      provider: "openai-compat",
      model: "core-gate-cancel-model",
      baseURL: provider.baseUrl,
    });

    expect(await rpc(handle, "sendPrompt", {
      agentId: AGENT_ID,
      prompt: "cancel gate",
      clientNonce: "core-gate-cancel-nonce",
    })).toMatchObject({ status: 200, json: { ok: true, value: { accepted: true } } });
    await waitFor(() => turnProviderRequests(provider).length === 1);
    const firstRequest = turnProviderRequests(provider)[0]!;
    await waitFor(() => (
      
      firstRequest?.streamReady &&
      firstRequest.chunksWritten > 0 &&
      firstRequest.chunksWritten < CANCEL_DELTAS.length &&
      !
      firstRequest.completedNaturally
    ));
    const chunksBeforeCancel = firstRequest?.chunksWritten ?? 0;
    expect(firstRequest?.streamReady).toBe(true);
    expect(chunksBeforeCancel).toBeGreaterThan(0);
    expect(chunksBeforeCancel).toBeLessThan(CANCEL_DELTAS.length);
    expect(firstRequest?.completedNaturally).toBe(false);

    const cancelled = await rpc(handle, "cancelPrompt", { agentId: AGENT_ID });
    expect(cancelled).toMatchObject({ status: 200, json: { ok: true, value: { cancelled: true, agentIds: [AGENT_ID] } } });
    await flush(handle);
    await waitFor(() =>  firstRequest?.abortObserved);
    expect(firstRequest?.completedNaturally).toBe(false);
    const chunksAtAbort = firstRequest?.abortedAtChunks;
    expect(chunksAtAbort).toBeGreaterThanOrEqual(chunksBeforeCancel);
    const stableChunks = await waitForStableCounter(() => firstRequest?.chunksWritten ?? 0, 120);
    expect(stableChunks).toBe(chunksAtAbort);
    expect(firstRequest?.chunksAfterAbort).toBe(0);

    const afterCancel = await rpc(handle, "openAgentTail", { agentId: AGENT_ID, limit: 50 });
    const cancelledEntries = (afterCancel.json.value as { entries: Array<{ kind: string; role?: string; content?: string; text?: string }> }).entries;
    expect(cancelledEntries.some((entry) => entry.kind === "notice" && entry.text === "Geração interrompida.")).toBe(true);
    expect(JSON.stringify(afterCancel.json)).not.toContain(API_KEY);

    expect(await rpc(handle, "sendPrompt", {
      agentId: AGENT_ID,
      prompt: "next gate",
      clientNonce: "core-gate-next-nonce",
    })).toMatchObject({ status: 200, json: { ok: true, value: { accepted: true } } });
    await flush(handle);
    expect(turnProviderRequests(provider)).toHaveLength(2);
    expect(turnProviderRequests(provider)[1]?.completedNaturally).toBe(true);
    expect(turnProviderRequests(provider)[1]?.chunksWritten).toBe(CANCEL_DELTAS.length);
    expect(turnProviderRequests(provider)[1]?.abortObserved).toBe(false);
    const afterNext = await rpc(handle, "openAgentTail", { agentId: AGENT_ID, limit: 50 });
    const nextEntries = (afterNext.json.value as { entries: Array<{ kind: string; role?: string; content?: string }> }).entries;
    expect(nextEntries.filter((entry) => entry.kind === "message" && entry.role === "user")).toHaveLength(2);
    expect(nextEntries.filter((entry) => entry.kind === "message" && entry.role === "assistant")).toHaveLength(2);
    expect(JSON.stringify(afterNext.json)).not.toContain(API_KEY);
    expectSecretAbsentFromArtifacts(workspacesRoot);
  });
});
