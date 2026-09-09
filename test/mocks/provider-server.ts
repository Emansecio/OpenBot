/**
 * T6 — Mock de provider "OpenAI-like": servidor HTTP fake que fala
 * `chat.completions` SSE (plano §5.1 — mocks de provider sem rede; reusado
 * por T7 xAI e T8 OpenAI-compat).
 *
 * - Endpoint: `POST /v1/chat/completions` (base URL completa:
 *   `http://127.0.0.1:<porta>/v1`).
 * - Suporta os três "modos" de resposta do plano §5.1:
 *   - `script`: sequência determinística de deltas de texto e/ou tool_calls
 *     (paridade contra mock — 100% determinístico, zero custo de API);
 *   - `rawSse`: SSE bruto com `[DONE]` (fixtures de contrato);
 *   - `error`: resposta de erro com status HTTP (auth 401, rate-limit 429,
 *     5xx) para testes de classificação transiente vs permanente.
 * - Valida o Authorization header contra `expectedApiKey` (quando presente)
 *   e registra os corpos dos requests recebidos (`requests[]`) para
 *   asserções de contrato (model, tools, system, messages).
 * - Retorna SSE com `Content-Type: text/event-stream` e `Transfer-Encoding:
 *   chunked` (como a OpenAI real) — o cliente lê linha a linha.
 *
 * O mock vive em test/mocks/ e NÃO casa com o `include` do vitest.config.ts
 * (`test/**\/*.test.ts`), então não roda como suíte — é importado pelos testes
 * (test/providers.test.ts).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

// Fetch rejects these ports before opening a socket. An ephemeral listener can
// occasionally receive one on Windows, so test servers must retry instead of
// turning a provider assertion into a nondeterministic "bad port" failure.
const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526,
  530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

/** Um chunk de tool_call no SSE da OpenAI (delta fragmentado por índice). */
export interface MockToolCallChunk {
  id?: string;
  index?: number;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

/** Script determinístico de deltas e tool calls (paridade, plano §5.1). */
export interface MockStreamScript {
  /** Deltas de texto emitidos em sequência (cada um = um frame SSE). */
  deltas?: string[];
  /** Tool calls emitidas como deltas fragmentados (na ordem do array). */
  toolCalls?: MockToolCallChunk[];
  /** Atraso entre frames (ms) — permite testar abort no meio do stream. */
  chunkDelayMs?: number;
}

export interface MockErrorSpec {
  /** Status HTTP do erro (401/403/429/5xx/400...). */
  status: number;
  /** Mensagem no corpo `{error:{message}}` (padrão OpenAI). */
  message: string;
}

export interface MockProviderServerOptions {
  /** Script de deltas/tool calls (default: um turno simples "Olá, mundo!"). */
  script?: MockStreamScript;
  /** SSE bruto a servir (sobrepoe `script`). Deve terminar com `data: [DONE]`. */
  rawSse?: string;
  /** Resposta de erro com status HTTP (sobrepoe script/rawSse). */
  error?: MockErrorSpec;
  /** Chave esperada no Authorization; request sem ela → 401. */
  expectedApiKey?: string;
}

/** Request capturado pelo mock (asserções de contrato). */
export interface MockProviderRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface MockProviderServer {
  server: http.Server;
  /** URL base: `http://127.0.0.1:<porta>/v1` (adapter monta `/chat/completions`). */
  baseUrl: string;
  /** Requests recebidos (corpo parseado) — para asserções de contrato. */
  requests: MockProviderRequest[];
  /** Contador de respostas servidas. */
  requestCount(): number;
  /** Fecha o servidor. */
  close(): Promise<void>;
}

/** Serializa um frame de chat.completions para SSE. */
function frame(choiceDelta: Record<string, unknown>): string {
  const payload = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: choiceDelta, finish_reason: null }] };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Serializa a mensagem de erro no formato OpenAI. */
function errorPayload(message: string): string {
  return JSON.stringify({ error: { message, type: "mock_error", param: null, code: null } });
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Sobe o servidor fake de provider. Escuta em 127.0.0.1 em porta efêmera.
 * Retorna `baseUrl` pronta para o adapter (`.../v1`).
 */
export function startMockProviderServer(opts: MockProviderServerOptions = {}): Promise<MockProviderServer> {
  const requests: MockProviderRequest[] = [];
  let count = 0;

  const server = http.createServer(async (req, res) => {
    count++;
    const captured: MockProviderRequest = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body: undefined,
    };
    try {
      captured.body = await readJsonBody(req);
    } catch {
      captured.body = undefined;
    }
    requests.push(captured);

    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "method not allowed" } }));
      return;
    }

    // Auth: chave esperada configurada → valida o Bearer.
    if (opts.expectedApiKey !== undefined) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${opts.expectedApiKey}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(errorPayload("invalid api key"));
        return;
      }
    }

    // Modo erro: status HTTP + corpo no formato OpenAI.
    if (opts.error !== undefined) {
      res.writeHead(opts.error.status, { "content-type": "application/json" });
      res.end(errorPayload(opts.error.message));
      return;
    }

    // Modo SSE bruto (fixtures de contrato).
    if (opts.rawSse !== undefined) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.end(opts.rawSse);
      return;
    }

    // Modo script determinístico (paridade).
    const script = opts.script ?? { deltas: ["Olá", ", ", "mundo", "!"] };
    const delayMs = script.chunkDelayMs ?? 0;
    const writeFrame = (body: string): Promise<void> =>
      new Promise((resolve) => {
        if (delayMs <= 0) {
          res.write(body);
          resolve();
          return;
        }
        setTimeout(() => {
          res.write(body);
          resolve();
        }, delayMs);
      });

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    void (async () => {
      for (const delta of script.deltas ?? []) {
        await writeFrame(frame({ content: delta }));
      }
      for (const toolCall of script.toolCalls ?? []) {
        await writeFrame(frame({ tool_calls: [toolCall] }));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const listen = () => server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      if (FETCH_FORBIDDEN_PORTS.has(addr.port)) {
        server.close((error) => {
          if (error) reject(error);
          else listen();
        });
        return;
      }
      const baseUrl = `http://127.0.0.1:${addr.port}/v1`;
      resolve({
        server,
        baseUrl,
        requests,
        requestCount: () => count,
        close: () =>
          new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
    listen();
  });
}
