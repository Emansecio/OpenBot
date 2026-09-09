/**
 * T8 — Testes do adapter OpenAI-compatible com baseURL custom
 * (src/providers/openai-compat.ts), contra o mock de provider (reuso T6,
 * test/mocks/provider-server.ts) e as DUAS FIXTURES de baseURL do plano §3 T8:
 *   1. LOOPBACK — endpoint custom simulada em `http://127.0.0.1:<porta>/v1`
 *      (servidor fake do mock de provider);
 *   2. HTTPS FAKE — endpoint remoto `https://localhost:<porta>/v1` com
 *      TLS self-signed (cert/Key PEM em test/fixtures/, gerados por openssl)
 *      servido por `node:https` + fetch injetado que confia no cert de teste.
 *
 * Cobertura (plano §3 T8 — Done):
 *   - chave OPCIONAL via keystore (namespace `scoped:v1:provider:openai-compat:apiKey`);
 *     sem chave → request SEM header Authorization (endpoint custom local não exige);
 *   - REUSO dos helpers de openai-helpers.ts (T6): corpo chat.completions
 *     (system inline + tools + stream:true) via buildChatBody; tool_calls
 *     fragmentadas → `tool-call` via OpenAiToolCallAccumulator;
 *   - endereçamento par baseURL+model: model no CORPO, endpoint
 *     `{baseUrl}/chat/completions` (escolha documentada no adapter);
 *   - validação de URL: apenas http/https; http não-loopback BLOQUEADO por
 *     default (configurável); https remoto permitido;
 *   - registro como "openai-compat" no registry (boot sem baseURL não registra);
 *   - erros HTTP classificados (401 auth / 429 rate-limit / 500 server);
 *   - abort encerra o stream.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OPENAI_COMPAT_PROVIDER_NAME,
  OpenAiCompatAdapter,
  isLoopbackHost,
  openaiCompatApiKeyKey,
  registerOpenAiCompatAdapter,
  validateCompatBaseUrl,
} from "../src/providers/openai-compat.js";
import { ApiError } from "../src/providers/openai-helpers.js";
import { defaultRegistry, streamChat } from "../src/providers/router.js";
import type { ProviderChatRequest, ProviderStreamEvent, RouterOptions } from "../src/providers/router.js";
import { createKeystore } from "../src/keystore/index.js";
import type { KeystoreOptions } from "../src/keystore/index.js";

import {
  startMockProviderServer,
  type MockProviderServer,
} from "./mocks/provider-server.js";

type FetchInput = Parameters<typeof fetch>[0];

/** PEM do cert self-signed de teste (fixture T8 — gerado por openssl). */
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const TEST_CERT_PEM = fs.readFileSync(path.join(FIXTURES_DIR, "localhost-cert.pem"), "utf8");
const TEST_KEY_PEM = fs.readFileSync(path.join(FIXTURES_DIR, "localhost-key.pem"), "utf8");

let activeServers: MockProviderServer[] = [];
let activeHttpsServers: https.Server[] = [];
let activeKeystoreDirs: string[] = [];

afterEach(async () => {
  const servers = activeServers;
  activeServers = [];
  await Promise.all(servers.map((s) => s.close()));
  for (const s of activeHttpsServers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const dir of activeKeystoreDirs.splice(0)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  defaultRegistry.clear();
});

async function bootMock(opts: Parameters<typeof startMockProviderServer>[0] = {}): Promise<MockProviderServer> {
  const mock = await startMockProviderServer(opts);
  activeServers.push(mock);
  return mock;
}

function memoryKeystore(opts: Partial<KeystoreOptions> = {}): ReturnType<typeof createKeystore> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-openai-compat-keystore-"));
  activeKeystoreDirs.push(dir);
  return createKeystore({ writeBackend: undefined, legacyReadBackend: undefined, ...opts, dir });
}

function baseRequest(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    model: "compat-test-model",
    messages: [{ role: "user", content: "olá" }],
    ...overrides,
  };
}

function collectEvents(
  adapter: OpenAiCompatAdapter,
  req: ProviderChatRequest,
  opts: RouterOptions = {},
): { events: ProviderStreamEvent[]; result: Promise<Awaited<ReturnType<typeof streamChat>>> } {
  // O roteador resolve o adapter por NOME no registry (contrato T5).
  defaultRegistry.register(adapter);
  const events: ProviderStreamEvent[] = [];
  const result = streamChat(adapter.name, req, (e) => events.push(e), opts);
  return { events, result };
}

/**
 * FIXTURE 2 — endpoint HTTPS fake: servidor TLS self-signed que fala
 * `chat.completions` SSE (mesma semântica do mock HTTP). O adapter usa o
 * fetch do Node — que exige certificado válido — então injetamos um
 * `fetchImpl` com `ca: <cert de teste>` (apenas o teste confia no cert).
 */
function startHttpsMock(opts: {
  expectedApiKey?: string;
  script?: { deltas?: string[] };
} = {}): Promise<{ baseUrl: string; requests: Array<{ headers: Record<string, unknown>; body: unknown }> }> {
  const requests: Array<{ headers: Record<string, unknown>; body: unknown }> = [];
  const server = https.createServer(
    { key: TEST_KEY_PEM, cert: TEST_CERT_PEM },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: unknown = undefined;
        try {
          body = raw.length > 0 ? JSON.parse(raw) : undefined;
        } catch {
          body = undefined;
        }
        requests.push({ headers: req.headers, body });

        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "method not allowed" } }));
          return;
        }
        if (opts.expectedApiKey !== undefined) {
          const auth = req.headers.authorization ?? "";
          if (auth !== `Bearer ${opts.expectedApiKey}`) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "invalid api key" } }));
            return;
          }
        }
        const script = opts.script ?? { deltas: ["resposta ", "https"] };
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const delta of script.deltas ?? []) {
          const payload = {
            id: "chatcmpl-tls",
            object: "chat.completion.chunk",
            created: 1,
            model: "mock",
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    },
  );
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      activeHttpsServers.push(server);
      resolve({ baseUrl: `https://localhost:${addr.port}/v1`, requests });
    });
  });
}

/**
 * fetch injetado que confia APENAS no cert self-signed de teste (fixture):
 * implementação própria sobre `node:https.request` com `ca: <cert>` e
 * `rejectUnauthorized: true` — o fetch nativo do Node (undici) não aceita
 * `https.Agent` via opção `agent`, então o teste injeta este shim respeitando
 * o contrato `fetchImpl` do adapter (só o teste confia no cert de teste).
 */
function tlsTrustingFetch(caPem: string): typeof fetch {
  return ((input: FetchInput, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    return new Promise<Response>((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port === "" ? undefined : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          headers: (init?.headers as Record<string, string> | undefined) ?? undefined,
          ca: caPem,
          rejectUnauthorized: true,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === "string") headers.set(k, v);
              else if (Array.isArray(v)) for (const item of v) headers.append(k, item);
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 200,
                statusText: res.statusMessage,
                headers,
              }),
            );
          });
        },
      );
      req.on("error", reject);
      if (init?.body !== undefined && init.body !== null) req.write(String(init.body));
      req.end();
    });
  });
}

describe("T8 openai-compat — validação de URL (apenas http/https, loopback default)", () => {
  it("aceita http loopback (endpoint custom 127.0.0.1) — isLoopback true", () => {
    const { url, isLoopback } = validateCompatBaseUrl("http://127.0.0.1:1234/v1");
    expect(url.toString()).toBe("http://127.0.0.1:1234/v1");
    expect(isLoopback).toBe(true);
  });

  it("aceita https remoto (Groq) — isLoopback false, mas permitido", () => {
    const { url, isLoopback } = validateCompatBaseUrl("https://api.groq.com/openai/v1");
    expect(url.toString()).toBe("https://api.groq.com/openai/v1");
    expect(isLoopback).toBe(false);
  });

  it("rejeita http para host não-loopback por default (segurança) e aceita com allowNonLoopbackHttp", () => {
    expect(() => validateCompatBaseUrl("http://192.168.0.10:8080/v1")).toThrow(/não-loopback/);
    expect(() => validateCompatBaseUrl("http://meu-servidor.lan/v1")).toThrow(/não-loopback/);
    const ok = validateCompatBaseUrl("http://192.168.0.10:8080/v1", { allowNonLoopbackHttp: true });
    expect(ok.isLoopback).toBe(false);
    // O adapter respeita a flag na configuração.
    const adapter = new OpenAiCompatAdapter({
      baseUrl: "http://192.168.0.10:8080/v1",
      allowNonLoopbackHttp: true,
      apiKey: "sk-test",
    });
    expect(adapter.baseUrl).toBe("http://192.168.0.10:8080/v1");
  });

  it("rejeita esquema que não seja http/https (ftp, file, sem esquema)", () => {
    expect(() => validateCompatBaseUrl("ftp://host/v1")).toThrow(/apenas http\/https/);
    expect(() => validateCompatBaseUrl("file:///etc/v1")).toThrow(/apenas http\/https/);
    // "localhost:1234/v1" é parseado com protocolo "localhost:" → rejeitado como
    // esquema inválido (mensagem de protocolo), nunca tratado como URL absoluta.
    expect(() => validateCompatBaseUrl("localhost:1234/v1")).toThrow(/apenas http\/https|URL absoluta/);
    expect(() => validateCompatBaseUrl("")).toThrow(/URL absoluta/);
  });

  it("construtor sem baseURL → erro validation (fail-fast, ApiError 400)", () => {
    let thrown: unknown;
    try {
      new OpenAiCompatAdapter({ apiKey: "sk-test" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown).toMatchObject({ status: 400, message: expect.stringMatching(/baseURL/) });
    expect(() => new OpenAiCompatAdapter({ baseUrl: "http://127.0.0.1:1234" })).not.toThrow();
  });

  it("isLoopbackHost: localhost/::1/127.0.0.0/8 true; IPs externos/domínios false", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.8.9.10")).toBe(true);
    expect(isLoopbackHost("192.168.0.1")).toBe(false);
    expect(isLoopbackHost("api.groq.com")).toBe(false);
    expect(isLoopbackHost("localhost.evil.com")).toBe(false);
  });
});

describe("OpenAI-compatible error body bounds", () => {
  it("trunca corpo UTF-8 sem corromper caractere multibyte e cancela o restante", async () => {
    const limit = 64 * 1024;
    const intactPrefix = "x".repeat(limit - 1);
    let cancelled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${intactPrefix}界${"x".repeat(1024)}`));
        closeTimer = setTimeout(() => controller.close(), 50);
      },
      cancel() {
        cancelled = true;
        if (closeTimer !== undefined) clearTimeout(closeTimer);
      },
    });
    const adapter = new OpenAiCompatAdapter({
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "sk-test",
      fetchImpl: async () => new Response(body, { status: 500 }),
    });

    let caught: unknown;
    try {
      await adapter.streamChat(baseRequest(), () => undefined);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const error = caught as ApiError;
    expect(error.message).toContain("corpo de erro truncado");
    expect(error.body).toEqual(expect.any(String));
    expect((error.body as string).slice(0, intactPrefix.length)).toBe(intactPrefix);
    expect(error.body as string).not.toContain("�");
    expect(Buffer.byteLength(error.body as string, "utf8")).toBeLessThanOrEqual(limit + 128);
    expect(error.body as string).toContain("corpo de erro truncado");
    expect(cancelled).toBe(true);
  });
});

describe("T8 openai-compat — FIXTURE 1: baseURL loopback (endpoint custom simulada)", () => {
  it("paridade contra mock: deltas viram message COMPLETA via roteador; model no corpo, endpoint {baseUrl}/chat/completions", async () => {
    const mock = await bootMock({ script: { deltas: ["Olá", ", ", "endpoint ", "custom", "!"] } });
    const adapter = new OpenAiCompatAdapter({ baseUrl: mock.baseUrl, apiKey: "custom-sk" });
    const { events, result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error).toBeUndefined();
    expect(out.aborted).toBe(false);
    expect(out.message).toEqual({ role: "assistant", content: "Olá, endpoint custom!" });

    const types = events.map((e) => e.type);
    expect(types).toEqual(["delta", "delta", "delta", "delta", "delta", "message", "done"]);
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { delta: string }).delta)).toEqual([
      "Olá",
      ", ",
      "endpoint ",
      "custom",
      "!",
    ]);

    // Endereçamento par baseURL+model: POST em {baseUrl}/chat/completions,
    // model NO CORPO (nunca interpolado no path da URL).
    expect(mock.requests).toHaveLength(1);
    const req = mock.requests[0];
    if (req === undefined) throw new Error("mock provider received no request");
    expect(req.url).toBe("/v1/chat/completions");
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe("Bearer custom-sk");
    const body = req.body as { stream: boolean; model: string };
    expect(body.stream).toBe(true);
    expect(body.model).toBe("compat-test-model");
  });

  it("chave OPCIONAL: sem apiKey e sem keystore → request SEM header Authorization (endpoint custom local)", async () => {
    const mock = await bootMock({ script: { deltas: ["sem ", "chave"] } });
    const adapter = new OpenAiCompatAdapter({ baseUrl: mock.baseUrl });
    const { result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error).toBeUndefined();
    expect(out.message?.content).toBe("sem chave");
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("chave via keystore: reveal por namespace openai-compat:apiKey → request autenticado", async () => {
    const mock = await bootMock({ expectedApiKey: "sk-compat-secreta", script: { deltas: ["ok"] } });
    const keystore = memoryKeystore();
    await keystore.upsert("openai-compat", "sk-compat-secreta");

    const adapter = new OpenAiCompatAdapter({ baseUrl: mock.baseUrl, keystore });
    const { result } = collectEvents(adapter, baseRequest());
    const out = await result;

    expect(out.error).toBeUndefined();
    expect(out.message?.content).toBe("ok");
    // Namespace do contrato T4.
    expect(openaiCompatApiKeyKey()).toBe("scoped:v1:provider:openai-compat:apiKey");
  });

  it("reuso dos helpers T6: corpo chat.completions com system inline + tools (contrato)", async () => {
    const mock = await bootMock({ script: { deltas: ["ok"] } });
    const adapter = new OpenAiCompatAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });
    const { result } = collectEvents(
      adapter,
      baseRequest({
        system: "você é o OpenBot",
        temperature: 0.5,
        maxTokens: 128,
        tools: [
          { type: "function", function: { name: "shell", description: "executa", parameters: { type: "object" } } },
        ],
      }),
    );
    await result;

    const body = mock.requests[0]?.body as {
      stream: boolean;
      messages: unknown[];
      tools?: unknown[];
      temperature: number;
      max_tokens: number;
    };
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "você é o OpenBot" },
      { role: "user", content: "olá" },
    ]);
    expect((body.tools?.[0] as { function: { name: string } }).function.name).toBe("shell");
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(128);
  });

  it("tool_calls fragmentadas do SSE viram evento tool-call completo (reuso OpenAiToolCallAccumulator)", async () => {
    const mock = await bootMock({
      script: {
        deltas: ["Vou ", "listar"],
        toolCalls: [
          { index: 0, id: "call_9Y5h", type: "function", function: { name: "shell", arguments: "" } },
          { index: 0, function: { arguments: '{"cmd":"dir"}' } },
        ],
      },
    });
    const adapter = new OpenAiCompatAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });
    const { events, result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error).toBeUndefined();
    expect(out.message).toEqual({
      role: "assistant",
      content: "Vou listar",
      toolCalls: [
        { id: "call_9Y5h", type: "function", function: { name: "shell", arguments: '{"cmd":"dir"}' } },
      ],
    });
    const callEvents = events.filter((e) => e.type === "tool-call");
    expect(callEvents).toHaveLength(1);
    expect((callEvents[0] as { call: { id: string } }).call.id).toBe("call_9Y5h");
  });
});

describe("T8 openai-compat — FIXTURE 2: endpoint HTTPS fake (remoto permitido)", () => {
  it("stream HTTPS fake completo (TLS self-signed, fetch injetado confiando no cert de teste)", async () => {
    const mock = await startHttpsMock({ script: { deltas: ["resposta ", "https"] } });
    const adapter = new OpenAiCompatAdapter({
      baseUrl: mock.baseUrl, // https://localhost:<porta>/v1 — remoto? não: loopback, mas HTTPS
      apiKey: "sk-https",
      fetchImpl: tlsTrustingFetch(TEST_CERT_PEM),
    });
    const { events, result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error).toBeUndefined();
    expect(out.message?.content).toBe("resposta https");
    expect(events.at(-1)?.type).toBe("done");

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.headers.authorization).toBe("Bearer sk-https");
    const body = mock.requests[0]?.body as { model: string; stream: boolean };
    expect(body.model).toBe("compat-test-model");
    expect(body.stream).toBe(true);
  });

  it("chave opcional no HTTPS: sem chave → sem Authorization, stream ok", async () => {
    const mock = await startHttpsMock({ script: { deltas: ["tls ", "anon"] } });
    const adapter = new OpenAiCompatAdapter({
      baseUrl: mock.baseUrl,
      fetchImpl: tlsTrustingFetch(TEST_CERT_PEM),
    });
    const { result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error).toBeUndefined();
    expect(out.message?.content).toBe("tls anon");
    expect(mock.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("HTTPS com chave esperada: 401 sem chave → auth (permanente); com chave → stream ok", async () => {
    const mock = await startHttpsMock({ expectedApiKey: "sk-tls-ok", script: { deltas: ["autenticado"] } });

    const badAdapter = new OpenAiCompatAdapter({
      baseUrl: mock.baseUrl,
      fetchImpl: tlsTrustingFetch(TEST_CERT_PEM),
    });
    const badEvents: ProviderStreamEvent[] = [];
    defaultRegistry.register(badAdapter);
    const badOut = await streamChat(badAdapter.name, baseRequest(), (e) => badEvents.push(e));
    expect(badOut.error?.kind).toBe("auth");
    expect(badOut.error?.retryable).toBe(false);
    expect(badOut.error?.status).toBe(401);

    const goodAdapter = new OpenAiCompatAdapter({
      baseUrl: mock.baseUrl,
      apiKey: "sk-tls-ok",
      fetchImpl: tlsTrustingFetch(TEST_CERT_PEM),
    });
    defaultRegistry.register(goodAdapter);
    const goodOut = await streamChat(goodAdapter.name, baseRequest());
    expect(goodOut.error).toBeUndefined();
    expect(goodOut.message?.content).toBe("autenticado");
    // 2 requests: um 401 + um ok.
    expect(mock.requests).toHaveLength(2);
  });
});

describe("T8 openai-compat — erros HTTP classificados (transiente vs permanente)", () => {
  it("401 → auth (permanente), nunca retryable", async () => {
    const mock = await bootMock({ error: { status: 401, message: "invalid api key" } });
    const adapter = new OpenAiCompatAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-ruim" });
    const { events, result } = collectEvents(adapter, baseRequest());

    const out = await result;
    expect(out.error?.kind).toBe("auth");
    expect(out.error?.retryable).toBe(false);
    expect(out.error?.status).toBe(401);
    expect(out.error?.message).toContain("invalid api key");
    expect(events.map((e) => e.type)).toEqual(["error"]);
  });

  it("429 → rate-limit (retryable)", async () => {
    const mock = await bootMock({ error: { status: 429, message: "rate limit exceeded" } });
    const adapter = new OpenAiCompatAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });
    const { result } = collectEvents(adapter, baseRequest(), { maxRetries: 0 });

    const out = await result;
    expect(out.error?.kind).toBe("rate-limit");
    expect(out.error?.retryable).toBe(true);
    expect(out.error?.status).toBe(429);
    expect(mock.requestCount()).toBe(1);
  });

  it("500 → server (retryable)", async () => {
    const mock = await bootMock({ error: { status: 500, message: "internal error" } });
    const adapter = new OpenAiCompatAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });
    const { result } = collectEvents(adapter, baseRequest(), { maxRetries: 0 });

    const out = await result;
    expect(out.error?.kind).toBe("server");
    expect(out.error?.retryable).toBe(true);
    expect(mock.requestCount()).toBe(1);
  });
});

describe("T8 openai-compat — abort encerra o stream", () => {
  it("abort no meio do SSE → error aborted (não retryable), nenhuma message/done", async () => {
    const controller = new AbortController();
    const mock = await bootMock({
      script: { deltas: ["início", "meio"], chunkDelayMs: 40 },
    });
    const adapter = new OpenAiCompatAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });
    defaultRegistry.register(adapter);
    const events: ProviderStreamEvent[] = [];
    let releaseFirstDelta!: () => void;
    const firstDelta = new Promise<void>((resolve) => { releaseFirstDelta = resolve; });
    const result = streamChat(adapter.name, baseRequest({ signal: controller.signal }), (event) => {
      events.push(event);
      if (event.type === "delta") releaseFirstDelta();
    });

    await firstDelta;
    expect(events).toContainEqual({ type: "delta", delta: "início" });
    controller.abort();

    const out = await result;
    expect(out.aborted).toBe(true);
    expect(out.error?.kind).toBe("aborted");
    expect(out.error?.retryable).toBe(false);
    const hasTerminal = events.some((e) => e.type === "message" || e.type === "done");
    expect(hasTerminal).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});

describe("T8 registro — adapter OpenAI-compat como 'openai-compat' no registry", () => {
  it("registerOpenAiCompatAdapter registra com nome 'openai-compat' e streamChat resolve", async () => {
    const mock = await bootMock({ script: { deltas: ["registrado"] } });
    const adapter = registerOpenAiCompatAdapter({ baseUrl: mock.baseUrl, apiKey: "sk-test" });

    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("openai-compat");
    expect(OPENAI_COMPAT_PROVIDER_NAME).toBe("openai-compat");
    expect(defaultRegistry.has("openai-compat")).toBe(true);
    expect(defaultRegistry.get("openai-compat")).toBe(adapter);

    const events: ProviderStreamEvent[] = [];
    const result = await streamChat("openai-compat", baseRequest(), (e) => events.push(e));
    expect(result.message?.content).toBe("registrado");
    expect(events.at(-1)?.type).toBe("done");
  });

  it("sem baseURL → NÃO registra (retorna undefined) — boot sem baseURL custom não quebra", () => {
    const before = defaultRegistry.names().length;
    const adapter = registerOpenAiCompatAdapter({});
    expect(adapter).toBeUndefined();
    expect(defaultRegistry.has("openai-compat")).toBe(false);
    expect(defaultRegistry.names().length).toBe(before);
  });
});
