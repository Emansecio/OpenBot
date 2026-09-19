import { createHash, randomBytes } from "node:crypto";
import http, { type Server } from "node:http";

import type { Keystore } from "../keystore/index.js";
import { RpcError, type Gateway } from "../server/gateway.js";

export type ProviderOAuthName = "openai" | "xai";
export type ProviderOAuthStatus = {
  provider: ProviderOAuthName;
  state: "disconnected" | "pending" | "connected" | "error";
  accountId?: string;
  authorizationUrl?: string;
  userCode?: string;
  message?: string;
};

export type ProviderOAuthCredential = {
  accessToken: string;
  accountId?: string;
};

type StoredCredential = {
  connectionId?: string;
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  rejected?: boolean;
};

type PendingLogin = {
  controller: AbortController;
  status: ProviderOAuthStatus;
  server?: Server;
  generation: number;
};

export interface ProviderOAuthManagerOptions {
  keystore: Keystore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  pollDelay?: (ms: number, signal: AbortSignal) => Promise<void>;
  requestTimeoutMs?: number;
  callbackHost?: string;
  callbackPort?: number;
  onConnectionChanged?: (provider: ProviderOAuthName) => void;
}

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_AUTH_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const CODEX_CLAIM = "https://api.openai.com/auth";
const REFRESH_SKEW_MS = 60_000;
const DEFAULT_OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const MAX_OAUTH_REQUEST_TIMEOUT_MS = 2_147_483_647;

function storageKey(provider: ProviderOAuthName): string {
  return `${provider}-oauth`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`OAuth response missing ${field}`);
  return value;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oauthRequestTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OAUTH_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OAUTH_REQUEST_TIMEOUT_MS) {
    throw new Error("OAuth request timeout must be a positive safe integer");
  }
  return value;
}

/**
 * Falha de transporte/resposta do endpoint OAuth. `transient` distingue falhas
 * temporárias (rede, 429, 5xx, resposta inválida) de rejeições OAuth
 * explicitamente invalidantes. Somente erros de concessão/token confirmados
 * podem invalidar a credencial persistida — uma resposta ambígua nunca a
 * desconecta.
 */
export class OAuthRequestError extends Error {
  readonly status?: number;
  readonly oauthError?: string;
  readonly transient: boolean;
  constructor(message: string, options: { status?: number; oauthError?: string; transient: boolean }) {
    super(message);
    this.name = "OAuthRequestError";
    this.status = options.status;
    this.oauthError = options.oauthError;
    this.transient = options.transient;
  }
}

function isTransientOAuthFailure(status: number | undefined, oauthError: string | undefined): boolean {
  if (oauthError === "temporarily_unavailable" || oauthError === "server_error") return true;
  if (status === undefined || status === 429 || status >= 500) return true;
  return oauthError !== "invalid_grant" && oauthError !== "invalid_token";
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Login cancelled"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Login cancelled"));
    }, { once: true });
  });
}

function validateHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("OAuth returned an untrusted URL");
  return url.toString();
}

export function decodeCodexAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const claim = record(payload[CODEX_CLAIM]);
    return requiredString(claim?.chatgpt_account_id, "accountId");
  } catch {
    throw new Error("Failed to extract accountId from OAuth token");
  }
}

export class ProviderOAuthManager {
  private readonly keystore: Keystore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly pollDelay: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly callbackHost: string;
  private readonly callbackPort: number;
  private readonly onConnectionChanged?: ProviderOAuthManagerOptions["onConnectionChanged"];
  private readonly refreshing = new Map<string, Promise<ProviderOAuthCredential>>();
  private readonly pending = new Map<ProviderOAuthName, PendingLogin>();
  /**
   * Serializa somente as decisões/persistência de uma conexão. Refreshes e
   * logins fazem a rede fora deste lock; a geração invalida respostas antigas
   * enquanto a rede está em andamento.
   */
  private readonly mutationLocks = new Map<ProviderOAuthName, Promise<void>>();
  private readonly generations = new Map<ProviderOAuthName, number>();

  constructor(options: ProviderOAuthManagerOptions) {
    this.keystore = options.keystore;
    this.onConnectionChanged = options.onConnectionChanged;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.pollDelay = options.pollDelay ?? delay;
    this.requestTimeoutMs = oauthRequestTimeout(options.requestTimeoutMs);
    this.callbackHost = options.callbackHost ?? "127.0.0.1";
    this.callbackPort = options.callbackPort ?? 1455;
  }

  async start(provider: ProviderOAuthName): Promise<ProviderOAuthStatus> {
    await this.cancel(provider);
    const generation = await this.withMutationLock(provider, () => this.bumpGeneration(provider));
    return provider === "openai" ? this.startOpenAi(generation) : this.startXai(generation);
  }

  async status(provider: ProviderOAuthName): Promise<ProviderOAuthStatus> {
    const pending = this.pending.get(provider);
    if (pending) return { ...pending.status };
    const credential = await this.read(provider);
    if (credential?.rejected) return { provider, state: "error", message: "Sessão recusada pelo provedor. Entre novamente." };
    if (!credential) return { provider, state: "disconnected" };
    if (credential.expires <= this.now() + REFRESH_SKEW_MS) {
      // Refresh proativo em background, deduplicado via this.refreshing:
      // status() nunca bloqueia em I/O de rede. Falha transitória mantém a
      // credencial; falha definitiva a remove — a próxima leitura reporta o
      // estado real em vez de um "connected" mentiroso.
      const generation = this.currentGeneration(provider);
      void this.refreshCredentialAtGeneration(provider, credential.accountId, generation)
        .catch((error) => this.dropIfDefinitive(provider, credential, error, generation))
        .catch(() => undefined);
    }
    return { provider, state: "connected", ...(credential.accountId ? { accountId: credential.accountId } : {}) };
  }

  /**
   * Leitura somente local (keystore), sem refresh de rede. Usada por
   * cancel/disconnect — uma renovação in-flight de terceiros não pode
   * bloquear a desconexão.
   */
  private async statusLocal(provider: ProviderOAuthName): Promise<ProviderOAuthStatus> {
    const credential = await this.read(provider);
    if (credential?.rejected) return { provider, state: "error", message: "Sessão recusada pelo provedor. Entre novamente." };
    if (!credential) return { provider, state: "disconnected" };
    return { provider, state: "connected", ...(credential.accountId ? { accountId: credential.accountId } : {}) };
  }

  async cancel(provider: ProviderOAuthName): Promise<ProviderOAuthStatus> {
    await this.withMutationLock(provider, () => {
      // Invalidate every in-flight login, including the initial device/token
      // request that has not populated `pending` yet.
      this.bumpGeneration(provider);
      const pending = this.pending.get(provider);
      pending?.controller.abort();
      pending?.server?.close();
      this.pending.delete(provider);
    });
    return this.statusLocal(provider);
  }

  async disconnect(provider: ProviderOAuthName): Promise<ProviderOAuthStatus> {
    await this.cancel(provider);
    await this.withMutationLock(provider, async () => {
      this.bumpGeneration(provider);
      await this.keystore.delete(storageKey(provider));
      await this.keystore.delete(`${storageKey(provider)}-rejection`);
      this.onConnectionChanged?.(provider);
    });
    return { provider, state: "disconnected" };
  }

  async resolveCredential(provider: ProviderOAuthName): Promise<ProviderOAuthCredential> {
    const credential = await this.read(provider);
    if (!credential) throw new RpcError(401, `${provider} não está conectado`);
    if (credential.rejected) throw new RpcError(401, `sessão ${provider} recusada; entre novamente`);
    if (credential.expires <= this.now() + REFRESH_SKEW_MS) {
      const generation = this.currentGeneration(provider);
      try {
        return await this.refreshCredentialAtGeneration(provider, credential.accountId, generation);
      } catch (error) {
        if (!(error instanceof OAuthRequestError && error.transient)) {
          await this.dropIfDefinitive(provider, credential, error, generation);
          throw new RpcError(401, `sessão ${provider} expirou: ${safeMessage(error)}`);
        }
        throw new RpcError(503, `sessão ${provider} não renovada agora: ${safeMessage(error)}`);
      }
    }
    return {
      accessToken: credential.access,
      ...(credential.accountId ? { accountId: credential.accountId } : {}),
    };
  }

  /**
   * Apaga a credencial persistida somente para falhas definitivas e quando a
   * credencial gravada ainda é a mesma que falhou — um refresh concorrente ou
   * uma nova conexão nunca são apagados por um erro atrasado. Retorna true
   * quando a credencial foi removida.
   */
  private async dropIfDefinitive(provider: ProviderOAuthName, failed: StoredCredential, error: unknown, expectedGeneration?: number): Promise<boolean> {
    if (error instanceof OAuthRequestError && error.transient) return false;
    return this.withMutationLock(provider, async () => {
      if (expectedGeneration !== undefined && this.currentGeneration(provider) !== expectedGeneration) return false;
      const current = await this.read(provider);
      if (current?.access !== failed.access || current.refresh !== failed.refresh) return false;
      this.bumpGeneration(provider);
      await this.keystore.delete(storageKey(provider));
      await this.keystore.delete(`${storageKey(provider)}-rejection`);
      this.onConnectionChanged?.(provider);
      return true;
    });
  }

  /**
   * Verdadeiro quando há credencial OAuth válida e não rejeitada. Sem I/O de
   * rede — leitura local usada pelo catálogo para distinguir "desconectado"
   * de "catálogo indisponível".
   */
  async hasCredential(provider: ProviderOAuthName): Promise<boolean> {
    const credential = await this.read(provider);
    return credential !== undefined && credential.rejected !== true;
  }

  async catalogConnectionKey(provider: ProviderOAuthName): Promise<string> {
    const credential = await this.read(provider);
    if (!credential) return createHash("sha256").update(`${provider}:disconnected`).digest("hex");
    const identity = credential.connectionId ?? createHash("sha256").update(credential.refresh).digest("hex");
    return createHash("sha256").update(identity).update(credential.accountId ?? "").digest("hex");
  }

  async refreshCredential(provider: ProviderOAuthName, expectedAccountId?: string): Promise<ProviderOAuthCredential> {
    return this.refreshCredentialAtGeneration(provider, expectedAccountId, this.currentGeneration(provider));
  }

  private async refreshCredentialAtGeneration(provider: ProviderOAuthName, expectedAccountId: string | undefined, generation: number): Promise<ProviderOAuthCredential> {
    const previous = await this.read(provider);
    if (!previous || previous.rejected || (expectedAccountId && previous.accountId !== expectedAccountId)) {
      throw new RpcError(401, previous === undefined
        ? `sessão ${provider} não está conectada; entre novamente`
        : previous.rejected
          ? `sessão ${provider} recusada pelo provedor; entre novamente`
          : `conta ${provider} mudou durante a sessão; entre novamente`);
    }
    const key = provider + ":" + generation + ":" + createHash("sha256").update(previous.access).digest("hex");
    const pending = this.refreshing.get(key);
    if (pending) return pending;
    const operation = this.refreshCredentialOnce(provider, previous, expectedAccountId, generation);
    this.refreshing.set(key, operation);
    try { return await operation; } finally {
      if (this.refreshing.get(key) === operation) this.refreshing.delete(key);
    }
  }

  private async refreshCredentialOnce(provider: ProviderOAuthName, previous: StoredCredential, expectedAccountId: string | undefined, generation: number): Promise<ProviderOAuthCredential> {
    const next = await this.refresh(provider, previous);
    if (expectedAccountId && next.accountId !== expectedAccountId) throw new RpcError(401, "Conta OAuth mudou durante a renovação");
    return this.withMutationLock(provider, async () => {
      if (this.currentGeneration(provider) !== generation) {
        throw new RpcError(401, "Conexão OAuth mudou durante a renovação");
      }
      const current = await this.read(provider);
      if (!current || current.access !== previous.access || current.refresh !== previous.refresh) {
        throw new RpcError(401, "Conexão OAuth mudou durante a renovação");
      }
      await this.write(provider, next);
      return { accessToken: next.access, ...(next.accountId ? { accountId: next.accountId } : {}) };
    });
  }

  async rejectCredential(provider: ProviderOAuthName, accessToken: string): Promise<void> {
    // Persist rejection separately, but only while the same connection is
    // still current. A delayed response after disconnect/re-authentication
    // must not leave a marker for a newer connection.
    await this.withMutationLock(provider, async () => {
      const current = await this.read(provider);
      if (!current || current.access !== accessToken) return;
      await this.keystore.upsert(`${storageKey(provider)}-rejection`, createHash("sha256").update(accessToken).digest("hex"));
    });
  }

  private currentGeneration(provider: ProviderOAuthName): number {
    return this.generations.get(provider) ?? 0;
  }

  private bumpGeneration(provider: ProviderOAuthName): number {
    const generation = this.currentGeneration(provider) + 1;
    this.generations.set(provider, generation);
    return generation;
  }

  private async withMutationLock<T>(provider: ProviderOAuthName, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.mutationLocks.get(provider) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.mutationLocks.set(provider, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationLocks.get(provider) === tail) this.mutationLocks.delete(provider);
    }
  }

  private async commitCredential(provider: ProviderOAuthName, credential: StoredCredential, generation: number): Promise<void> {
    await this.withMutationLock(provider, async () => {
      if (this.currentGeneration(provider) !== generation) {
        throw new RpcError(401, "Conexão OAuth mudou durante a autenticação");
      }
      await this.write(provider, credential);
    });
  }

  private clearPending(provider: ProviderOAuthName, generation: number, server?: Server): void {
    const pending = this.pending.get(provider);
    if (!pending || pending.generation !== generation || (server !== undefined && pending.server !== server)) return;
    pending.server?.close();
    this.pending.delete(provider);
  }

  private async startOpenAi(generation: number): Promise<ProviderOAuthStatus> {
    const controller = new AbortController();
    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("hex");
    let redirectUri = "";

    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Invalid OAuth callback.");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Missing authorization code.");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("OpenBot conectado. Você pode fechar esta janela.");
      void this.finishOpenAi(code, verifier, redirectUri, controller.signal, server, generation);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.callbackPort, this.callbackHost, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("OAuth callback server unavailable");
    redirectUri = `http://localhost:${address.port}/auth/callback`;

    const url = new URL(OPENAI_AUTH_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: OPENAI_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "openbot",
    }).toString();
    const status: ProviderOAuthStatus = { provider: "openai", state: "pending", authorizationUrl: url.toString() };
    const accepted = await this.withMutationLock("openai", () => {
      if (this.currentGeneration("openai") !== generation) return false;
      this.pending.set("openai", { controller, server, status, generation });
      return true;
    });
    if (!accepted) {
      controller.abort();
      server.close();
      return this.statusLocal("openai");
    }
    return { ...status };
  }

  private async finishOpenAi(code: string, verifier: string, redirectUri: string, signal: AbortSignal, server: Server, generation: number) {
    try {
      const json = await this.postToken(OPENAI_TOKEN_URL, {
        grant_type: "authorization_code",
        client_id: OPENAI_CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }, signal);
      const credential = this.credential(json, undefined, true);
      await this.commitCredential("openai", credential, generation);
      this.clearPending("openai", generation, server);
    } catch (error) {
      if (!signal.aborted) this.setError("openai", error, generation, server);
    } finally {
      server.close();
    }
  }

  private async startXai(generation: number): Promise<ProviderOAuthStatus> {
    const controller = new AbortController();
    const response = await this.postForm(XAI_DEVICE_URL, {
      client_id: XAI_CLIENT_ID,
      scope: "openid profile email offline_access grok-cli:access api:access",
      referrer: "openbot",
    }, controller.signal);
    const deviceCode = requiredString(response.device_code, "device_code");
    const userCode = requiredString(response.user_code, "user_code");
    const authorizationUrl = validateHttpsUrl(requiredString(response.verification_uri_complete ?? response.verification_uri, "verification_uri"));
    const expiresIn = typeof response.expires_in === "number" ? response.expires_in : 600;
    const interval = typeof response.interval === "number" && response.interval > 0 ? response.interval : 5;
    const status: ProviderOAuthStatus = { provider: "xai", state: "pending", authorizationUrl, userCode };
    const accepted = await this.withMutationLock("xai", () => {
      if (this.currentGeneration("xai") !== generation) return false;
      this.pending.set("xai", { controller, status, generation });
      return true;
    });
    if (!accepted) {
      controller.abort();
      return this.statusLocal("xai");
    }
    void this.pollXai(deviceCode, expiresIn, interval, controller.signal, generation);
    return { ...status };
  }

  private async pollXai(deviceCode: string, expiresIn: number, intervalSeconds: number, signal: AbortSignal, generation: number) {
    const deadline = this.now() + expiresIn * 1000;
    try {
      while (this.now() < deadline) {
        await this.pollDelay(intervalSeconds * 1000, signal);
        const response = await this.postForm(XAI_TOKEN_URL, {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: XAI_CLIENT_ID,
          device_code: deviceCode,
        }, signal, true);
        if (response.error === "authorization_pending") continue;
        if (response.error === "slow_down") {
          intervalSeconds += 5;
          continue;
        }
        if (response.error) throw new Error(requiredString(response.error_description ?? response.error, "error"));
        await this.commitCredential("xai", this.credential(response), generation);
        this.clearPending("xai", generation);
        return;
      }
      throw new Error("Código de login xAI expirou");
    } catch (error) {
      if (!signal.aborted) this.setError("xai", error, generation);
    }
  }

  private async refresh(provider: ProviderOAuthName, previous: StoredCredential): Promise<StoredCredential> {
    const json = await this.postToken(provider === "openai" ? OPENAI_TOKEN_URL : XAI_TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: previous.refresh,
      client_id: provider === "openai" ? OPENAI_CLIENT_ID : XAI_CLIENT_ID,
    });
    let credential: StoredCredential;
    try {
      credential = this.credential(json, previous.refresh, provider === "openai");
    } catch (error) {
      // A successful HTTP response with an unusable token body is still
      // inconclusive; preserve the previous refresh material for a retry.
      throw new OAuthRequestError(`OAuth response invalid: ${safeMessage(error)}`, { transient: true });
    }
    return { ...credential, connectionId: previous.connectionId ?? createHash("sha256").update(previous.refresh).digest("hex") };
  }

  private credential(json: Record<string, unknown>, previousRefresh?: string, codex = false): StoredCredential {
    const access = requiredString(json.access_token, "access_token");
    const refresh = typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : previousRefresh;
    if (!refresh) throw new Error("OAuth response missing refresh_token");
    const expiresIn = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
    return {
      type: "oauth",
      connectionId: randomBytes(24).toString("hex"),
      access,
      refresh,
      expires: this.now() + expiresIn * 1000,
      ...(codex ? { accountId: decodeCodexAccountId(access) } : {}),
    };
  }

  private async postToken(url: string, fields: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.postForm(url, fields, signal);
  }

  private async postForm(url: string, fields: Record<string, string>, signal?: AbortSignal, allowError = false): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
    const transportController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeSourceAbort: (() => void) | undefined;
    const request = Promise.resolve().then(async () => {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
        signal: transportController.signal,
      });
      const json = record(await response.json().catch(() => undefined));
      return { response, json };
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = new OAuthRequestError(`OAuth request timed out after ${this.requestTimeoutMs} ms`, { transient: true });
        transportController.abort(error);
        reject(error);
      }, this.requestTimeoutMs);
    });
    const sourceAbortPromise = signal === undefined ? undefined : new Promise<never>((_, reject) => {
      const onAbort = () => {
        const reason = signal.reason ?? new DOMException("This operation was aborted", "AbortError");
        transportController.abort(reason);
        reject(reason);
      };
      removeSourceAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    let response: Response;
    let json: Record<string, unknown> | undefined;
    try {
      const result = await Promise.race([
        request,
        timeoutPromise,
        ...(sourceAbortPromise === undefined ? [] : [sourceAbortPromise]),
      ]);
      response = result.response;
      json = result.json;
    } catch (error) {
      if (error instanceof OAuthRequestError) throw error;
      throw new OAuthRequestError(safeMessage(error), { transient: true });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (signal !== undefined && removeSourceAbort !== undefined) signal.removeEventListener("abort", removeSourceAbort);
    }
    if (!json) {
      // A status code without a parseable OAuth body does not prove token
      // revocation; keep the stored refresh material for a later retry.
      throw new OAuthRequestError(`OAuth returned invalid JSON (${response.status})`, {
        status: response.status, transient: true,
      });
    }
    if (!response.ok && !allowError) {
      const oauthError = typeof json.error === "string" ? json.error : undefined;
      throw new OAuthRequestError(requiredString(json.error_description ?? json.error ?? `HTTP ${response.status}`, "error"), {
        status: response.status, oauthError, transient: isTransientOAuthFailure(response.status, oauthError),
      });
    }
    return json;
  }

  private async read(provider: ProviderOAuthName): Promise<StoredCredential | undefined> {
    const raw = await this.keystore.reveal(storageKey(provider));
    if (!raw) return undefined;
    try {
      const value = record(JSON.parse(raw));
      if (value?.type !== "oauth") return undefined;
      const access = requiredString(value.access, "access");
      const rejected = await this.keystore.reveal(`${storageKey(provider)}-rejection`)
        === createHash("sha256").update(access).digest("hex");
      return {
        type: "oauth",
        ...(typeof value.connectionId === "string" ? { connectionId: value.connectionId } : {}),
        access,
        refresh: requiredString(value.refresh, "refresh"),
        expires: typeof value.expires === "number" ? value.expires : 0,
        ...(rejected ? { rejected: true } : {}),
        ...(typeof value.accountId === "string" ? { accountId: value.accountId } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private async write(provider: ProviderOAuthName, credential: StoredCredential): Promise<void> {
    const previous = await this.read(provider);
    await this.keystore.upsert(storageKey(provider), JSON.stringify(credential));
    const identityChanged = previous === undefined
      || previous.connectionId !== credential.connectionId
      || previous.access !== credential.access
      || previous.refresh !== credential.refresh
      || previous.accountId !== credential.accountId;
    if (identityChanged) await this.keystore.delete(`${storageKey(provider)}-rejection`);
    const previousId = previous?.connectionId ?? (previous ? createHash("sha256").update(previous.refresh).digest("hex") : undefined);
    if (previousId !== credential.connectionId || previous?.accountId !== credential.accountId) this.onConnectionChanged?.(provider);
  }

  private setError(provider: ProviderOAuthName, error: unknown, generation?: number, server?: Server): void {
    const pending = this.pending.get(provider);
    if (!pending || (generation !== undefined && pending.generation !== generation) || (server !== undefined && pending.server !== server)) return;
    pending.server?.close();
    pending.status = { provider, state: "error", message: safeMessage(error) };
  }
}

function providerFrom(body: unknown): ProviderOAuthName {
  const provider = record(body)?.provider;
  if (provider !== "openai" && provider !== "xai") throw new RpcError(400, "provider OAuth inválido");
  return provider;
}

export function registerProviderOAuthHandlers(gateway: Gateway, manager: ProviderOAuthManager): void {
  gateway.registerHandler("startProviderOAuth", (body) => manager.start(providerFrom(body)));
  gateway.registerHandler("getProviderOAuthStatus", (body) => manager.status(providerFrom(body)));
  gateway.registerHandler("cancelProviderOAuth", (body) => manager.cancel(providerFrom(body)));
  gateway.registerHandler("disconnectProviderOAuth", (body) => manager.disconnect(providerFrom(body)));
}
