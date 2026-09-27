/**
 * T8 — Adapter OpenAI-compatible com baseURL custom (plano §3 T8).
 *
 * Para servidores que falam a API OpenAI `chat.completions` com `stream:true`
 * em um endpoint custom configurado pelo usuário.
 *
 * Design (mesmo padrão do T6/T7 — implementa `ProviderAdapter` do roteador):
 *   1. `baseUrl` CONFIGURÁVEL e OBRIGATÓRIA no adapter (não há default sensato
 *      para "compatible"); validada no construtor (fail-fast);
 *   2. chave de API OPCIONAL: resolvida via keystore (namespace
 *      `scoped:v1:provider:openai-compat:apiKey` — `reveal`) ou `apiKey`
 *      direta (testes/mocks); SEM chave o request sai SEM header Authorization
 *      (endpoints custom podem não exigir chave);
 *   3. REUSA os helpers de openai-helpers.ts (T6): `buildChatBody` (system
 *      inline + tools + max_tokens), `OpenAiToolCallAccumulator` (tool calls),
 *      `normalizeOpenAiError`/`ApiError`/`extractOpenAiErrorMessage` (erros);
 *   4. erros de transporte/HTTP são normalizados e LANÇADOS — o roteador os
 *      classifica (transiente vs permanente, spec §3.1).
 *
 * ENDEREÇAMENTO DO MODELO — escolha documentada (plano §3 T8: "<baseURL>/<model>
 * OU par baseURL+model; siga o contrato do router"):
 *   **Par baseURL + model**: a `baseUrl` é a RAÍZ da API (config do adapter) e o
 *   `req.model` do contrato do roteador (string) vai no CORPO do chat.completions.
 *   O endpoint é sempre `{baseUrl}/chat/completions`; o model NUNCA é
 *   interpolado no path da URL. Razões: (a) o contrato do roteador
 *   (`ProviderChatRequest.model`) modela o modelo como string de catálogo, não
 *   como path de URL — interpolá-lo na URL quebraria o contrato e o catálogo
 *   estático (Decisão §8.3); (b) servidores OpenAI-compatible endereçam o modelo
 *   exclusivamente no corpo (`{"model": ...}`);
 *   (c) segurança: nenhuma injeção de path possível via nome de modelo.
 *
 * VALIDAÇÃO DE URL (segurança default):
 *   - apenas esquemas http/https (qualquer outro → erro validation 400);
 *   - http para host NÃO-loopback é BLOQUEADO por default (ex.: expor credenciais
 *     em texto claro na LAN); liberável com `allowNonLoopbackHttp: true`;
 *   - https remoto é PERMITIDO (cifrado de ponta a ponta; TLS estrito do fetch
 *     nativo do Node — `rejectUnauthorized` não é configurável aqui de propósito;
 *     fixtures de teste injetam um `fetchImpl` próprio para o cert self-signed);
 *   - loopback = `localhost`, `::1` e `127.0.0.0/8` (`isLoopbackHost`).
 *
 * REGISTRO: o boot e `setBoxSettings` (rpc/roster.ts) registram o adapter
 * como "openai-compat" só quando há uma baseURL configurada.
 */

import type { Keystore } from "../keystore/index.js";
import {
  defaultRegistry,
  type ProviderAdapter,
  type ProviderChatRequest,
  type ProviderStreamEvent,
} from "./router.js";
import {
  ApiError,
  buildChatBody,
  createChatCompletionsStreamHandler,
  normalizeOpenAiError,
  providerHttpError,
  raceWithAbort,
  readSseFrames,
  startProviderDeadline,
} from "./openai-helpers.js";

/** Nome canônico do provider no registry e no namespace da keystore. */
export const OPENAI_COMPAT_PROVIDER_NAME = "openai-compat" as const;

/**
 * True para hosts de loopback: `localhost`, `::1` e qualquer `127.x.x.x`
 * (127.0.0.0/8). `[::1]` com colchetes também é aceito (URL parseada).
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    // 127.0.0.0/8 — cada octeto dentro de 0-255 (expressão já garante dígitos).
    return h.split(".").every((octet) => Number(octet) <= 255);
  }
  return false;
}

export interface CompatBaseUrlValidation {
  /** URL parseada (base da API, ex.: `http://127.0.0.1:1234/v1`). */
  url: URL;
  /** True se o host é loopback (localhost/127.0.0.0/8/::1). */
  isLoopback: boolean;
}

/**
 * Valida uma baseURL custom para o adapter OpenAI-compatible (fail-fast no
 * construtor). Regras (segurança default, configurável):
 *   - apenas http/https (outro esquema → ApiError 400);
 *   - http para host NÃO-loopback → bloqueado por default
 *     (`allowNonLoopbackHttp: true` libera); https remoto sempre permitido.
 */
export function validateCompatBaseUrl(
  raw: string,
  opts: { allowNonLoopbackHttp?: boolean } = {},
): CompatBaseUrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(
      `openai-compat: baseURL inválida: "${raw}" — URL absoluta http/https esperada`,
      400,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiError(
      `openai-compat: baseURL "${raw}" usa protocolo "${url.protocol}" — apenas http/https`,
      400,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ApiError(`openai-compat: baseURL não pode conter credenciais`, 400);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ApiError(
      `openai-compat: baseURL "${raw}" não pode conter query ou hash`,
      400,
    );
  }
  const isLoopback = isLoopbackHost(url.hostname);
  if (url.protocol === "http:" && !isLoopback && !(opts.allowNonLoopbackHttp ?? false)) {
    throw new ApiError(
      `openai-compat: baseURL http para host não-loopback "${url.hostname}" bloqueada ` +
        `por segurança (use https ou allowNonLoopbackHttp: true)`,
      400,
    );
  }
  return { url, isLoopback };
}

export interface OpenAiCompatAdapterOptions {
  /**
   * URL base da API compatível (OBRIGATÓRIA). O adapter anexa
   * `/chat/completions` e envia `req.model` no corpo (par baseURL+model).
   */
  baseUrl?: string;
  /** Provider "nomeado" no registry (default "openai-compat"). */
  name?: string;
  /** Chave de API fornecida diretamente (testes/mocks). Sobrepoe a keystore. */
  apiKey?: string;
  /** Keystore (T4) para `reveal` da chave por namespace scoped:v1:provider:<name>:apiKey. */
  keystore?: Keystore;
  /** Idle timeout reset on every response body chunk. Default 120_000 ms. */
  timeoutMs?: number;
  /** Absolute request duration cap. Default 900_000 ms. */
  maxDurationMs?: number;
  /** `fetch` injetável (testes usam o do Node; prod usa globalThis.fetch). */
  fetchImpl?: typeof fetch;
  /**
   * Libera http para host não-loopback (default false — bloqueio de segurança;
   * https remoto SEMPRE permitido).
   */
  allowNonLoopbackHttp?: boolean;
  /**
   * Opt-in do usuário: envia `reasoning_effort` no corpo chat.completions.
   * Default false — endpoints estritos podem rejeitar parâmetros desconhecidos
   * com HTTP 400 (normalizado como erro de validação na UI).
   */
  sendReasoningEffort?: boolean;
}

/**
 * Adapter OpenAI-compatible (chat.completions stream com baseURL custom) —
 * implementa `ProviderAdapter`. `streamChat` emite `delta` e `tool-call` e
 * resolve ao fim do stream; erros são LANÇADOS e o roteador os converte em
 * evento `error` (nunca lança para o consumidor final).
 *
 * Chave OPCIONAL: sem `apiKey` e sem registro na keystore, o request sai sem
 * header Authorization (endpoints custom podem não exigir chave).
 */
export class OpenAiCompatAdapter implements ProviderAdapter {
  readonly tracksTransport = true;
  readonly name: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxDurationMs: number;
  readonly allowNonLoopbackHttp: boolean;
  private readonly apiKey?: string;
  private readonly keystore?: Keystore;
  private readonly sendReasoningEffort: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiCompatAdapterOptions = {}) {
    this.name = opts.name ?? OPENAI_COMPAT_PROVIDER_NAME;
    // Validação de URL no construtor (fail-fast): apenas http/https, http
    // não-loopback bloqueado por default, https remoto permitido.
    const { url } = validateCompatBaseUrl(opts.baseUrl ?? "", {
      allowNonLoopbackHttp: opts.allowNonLoopbackHttp,
    });
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxDurationMs = opts.maxDurationMs ?? Math.max(900_000, this.timeoutMs);
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("OpenAI-compatible idle timeout is invalid");
    if (!Number.isSafeInteger(this.maxDurationMs) || this.maxDurationMs < this.timeoutMs) throw new Error("OpenAI-compatible max duration is invalid");
    this.allowNonLoopbackHttp = opts.allowNonLoopbackHttp ?? false;
    this.apiKey = opts.apiKey;
    this.keystore = opts.keystore;
    this.sendReasoningEffort = opts.sendReasoningEffort ?? false;
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  serializeRequest(req: ProviderChatRequest): string {
    const body = buildChatBody(req);
    if (this.sendReasoningEffort && req.reasoningEffort !== undefined) body.reasoning_effort = req.reasoningEffort;
    return JSON.stringify(body);
  }

  /**
   * Resolve a chave de API: direta (testes) ou keystore (namespace scoped:v1).
   * Retorna `undefined` quando NÃO há chave configurada — para
   * OpenAI-compatible a chave é OPCIONAL (o request segue sem Authorization).
   */
  private async resolveApiKey(): Promise<string | undefined> {
    if (this.apiKey !== undefined) return this.apiKey;
    if (this.keystore !== undefined) {
      const revealed = await this.keystore.reveal(this.name);
      if (revealed !== null && revealed.length > 0) return revealed;
    }
    return undefined;
  }

  /** Chat Completions SSE through the shared handler (same wire as OpenAI). */
  private async readStream(
    body: ReadableStream<Uint8Array>,
    emit: (event: ProviderStreamEvent) => void,
    signal: AbortSignal,
    onActivity: () => void,
  ): Promise<void> {
    const handler = createChatCompletionsStreamHandler("openai-compat", emit);
    if (!await readSseFrames(body, signal, onActivity, "openai-compat", (frame) => handler.dispatchFrame(frame))) {
      throw new ApiError("openai-compat: stream terminou antes de [DONE]", 502);
    }
    handler.finish();
  }

  async streamChat(
    req: ProviderChatRequest,
    emit: (event: ProviderStreamEvent) => void,
  ): Promise<void> {
    const deadline = startProviderDeadline(req.signal, this.timeoutMs, this.maxDurationMs);
    const signal = deadline.signal;
    let response: Response | undefined;
    let succeeded = false;

    try {
      // Chave OPCIONAL, mas sua resolução também respeita abort/timeout.
      const apiKey = await raceWithAbort(this.resolveApiKey(), signal);
      const endpoint = new URL(this.baseUrl);
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/chat/completions`;
      const url = endpoint.toString();

      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "text/event-stream",
        "x-openbot-purpose": req.purpose ?? "turn",
      };
      if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;

      try {
        const body = this.serializeRequest(req);
        signal.throwIfAborted();
        req.onTransportStart?.("chat");
        response = await raceWithAbort(this.fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal,
        }), signal);
        deadline.resetIdle();
      } catch (err) {
        if (deadline.timeoutError !== undefined) throw deadline.timeoutError;
        throw normalizeOpenAiError(err);
      }

      if (!response.ok) throw await providerHttpError("openai-compat", response, signal, deadline.resetIdle);

      if (response.body === null) {
        throw new ApiError("openai-compat: resposta sem corpo (stream vazio)", 502);
      }

      await this.readStream(response.body, emit, signal, deadline.resetIdle);
      succeeded = true;
    } catch (err) {
      if (deadline.timeoutError !== undefined) throw deadline.timeoutError;
      throw err;
    } finally {
      deadline.dispose();
      const responseBody = response?.body;
      if (!succeeded && responseBody !== undefined && responseBody !== null && !responseBody.locked) {
        await responseBody.cancel().catch(() => undefined);
      }
    }
  }
}

export function unregisterOpenAiCompatAdapter(name = OPENAI_COMPAT_PROVIDER_NAME): boolean {
  return defaultRegistry.unregister(name);
}
