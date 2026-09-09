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
};

export interface ProviderOAuthManagerOptions {
  keystore: Keystore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  pollDelay?: (ms: number, signal: AbortSignal) => Promise<void>;
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
  private readonly callbackHost: string;
  private readonly callbackPort: number;
  private readonly onConnectionChanged?: ProviderOAuthManagerOptions["onConnectionChanged"];
  private readonly refreshing = new Map<string, Promise<ProviderOAuthCredential>>();
  private readonly pending = new Map<ProviderOAuthName, PendingLogin>();

  constructor(options: ProviderOAuthManagerOptions) {
    this.keystore = options.keystore;
    this.onConnectionChanged = options.onConnectionChanged;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.pollDelay = options.pollDelay ?? delay;
    this.callbackHost = options.callbackHost ?? "127.0.0.1";
    this.callbackPort = options.callbackPort ?? 1455;
  }

  async start(provider: ProviderOAuthName): Promise<ProviderOAuthStatus> {
    await this.cancel(provider);
    return provider === "openai" ? this.startOpenAi() : this.startXai();
  }

  async status(provider: ProviderOAuthName): Promise<ProviderOAuthStatus> {
    const pending = this.pending.get(provider);
    if (pending) return { ...pending.status };
    const credential = await this.read(provider);
    if (credential?.rejected) return { provider, state: "error", message: "Sessão recusada pelo provedor. Entre novamente." };
    return credential
      ? { provider, state: "connected", ...(credential.accountId ? { accountId: credential.accountId } : {}) }
      : { provider, state: "disconnected" };
  }

  async cancel(provider: ProviderOAuthName): Promise<ProviderOAuthStatus> {
    const pending = this.pending.get(provider);
    pending?.controller.abort();
    pending?.server?.close();
    this.pending.delete(provider);
    return this.status(provider);
  }

  async disconnect(provider: ProviderOAuthName): Promise<ProviderOAuthStatus> {
    await this.cancel(provider);
    await this.keystore.delete(storageKey(provider));
    await this.keystore.delete(`${storageKey(provider)}-rejection`);
    this.onConnectionChanged?.(provider);
    return { provider, state: "disconnected" };
  }

  async resolveCredential(provider: ProviderOAuthName): Promise<ProviderOAuthCredential> {
    const credential = await this.read(provider);
    if (!credential) throw new RpcError(401, `${provider} não está conectado`);
    if (credential.rejected) throw new RpcError(401, `sessão ${provider} recusada; entre novamente`);
    if (credential.expires <= this.now() + REFRESH_SKEW_MS) {
      try {
        return await this.refreshCredential(provider, credential.accountId);
      } catch (error) {
        const current = await this.read(provider);
        if (current?.access === credential.access && current.refresh === credential.refresh) {
          await this.keystore.delete(storageKey(provider));
          this.onConnectionChanged?.(provider);
        }
        throw new RpcError(401, `sessão ${provider} expirou: ${safeMessage(error)}`);
      }
    }
    return {
      accessToken: credential.access,
      ...(credential.accountId ? { accountId: credential.accountId } : {}),
    };
  }

  async catalogConnectionKey(provider: ProviderOAuthName): Promise<string> {
    const credential = await this.read(provider);
    if (!credential) return createHash("sha256").update(`${provider}:disconnected`).digest("hex");
    const identity = credential.connectionId ?? createHash("sha256").update(credential.refresh).digest("hex");
    return createHash("sha256").update(identity).update(credential.accountId ?? "").digest("hex");
  }

  async refreshCredential(provider: ProviderOAuthName, expectedAccountId?: string): Promise<ProviderOAuthCredential> {
    const previous = await this.read(provider);
    if (!previous || previous.rejected || (expectedAccountId && previous.accountId !== expectedAccountId)) {
      throw new RpcError(401, "Conexão OAuth mudou; atualize o catálogo novamente");
    }
    const key = provider + ":" + createHash("sha256").update(previous.access).digest("hex");
    const pending = this.refreshing.get(key);
    if (pending) return pending;
    const operation = this.refreshCredentialOnce(provider, previous, expectedAccountId);
    this.refreshing.set(key, operation);
    try { return await operation; } finally { this.refreshing.delete(key); }
  }

  private async refreshCredentialOnce(provider: ProviderOAuthName, previous: StoredCredential, expectedAccountId?: string): Promise<ProviderOAuthCredential> {
    const next = await this.refresh(provider, previous);
    if (expectedAccountId && next.accountId !== expectedAccountId) throw new RpcError(401, "Conta OAuth mudou durante a renovação");
    const current = await this.read(provider);
    if (!current || current.access !== previous.access || current.refresh !== previous.refresh) {
      throw new RpcError(401, "Conexão OAuth mudou durante a renovação");
    }
    await this.write(provider, next);
    return { accessToken: next.access, ...(next.accountId ? { accountId: next.accountId } : {}) };
  }

  async rejectCredential(provider: ProviderOAuthName, accessToken: string): Promise<void> {
    // Persist rejection separately: a delayed response must never overwrite a newer credential.
    await this.keystore.upsert(`${storageKey(provider)}-rejection`, createHash("sha256").update(accessToken).digest("hex"));

  }

  private async startOpenAi(): Promise<ProviderOAuthStatus> {
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
      void this.finishOpenAi(code, verifier, redirectUri, controller.signal, server);
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
    this.pending.set("openai", { controller, server, status });
    return { ...status };
  }

  private async finishOpenAi(code: string, verifier: string, redirectUri: string, signal: AbortSignal, server: Server) {
    try {
      const json = await this.postToken(OPENAI_TOKEN_URL, {
        grant_type: "authorization_code",
        client_id: OPENAI_CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }, signal);
      const credential = this.credential(json, undefined, true);
      await this.write("openai", credential);
      this.pending.delete("openai");
    } catch (error) {
      if (!signal.aborted) this.setError("openai", error);
    } finally {
      server.close();
    }
  }

  private async startXai(): Promise<ProviderOAuthStatus> {
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
    this.pending.set("xai", { controller, status });
    void this.pollXai(deviceCode, expiresIn, interval, controller.signal);
    return { ...status };
  }

  private async pollXai(deviceCode: string, expiresIn: number, intervalSeconds: number, signal: AbortSignal) {
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
        await this.write("xai", this.credential(response));
        this.pending.delete("xai");
        return;
      }
      throw new Error("Código de login xAI expirou");
    } catch (error) {
      if (!signal.aborted) this.setError("xai", error);
    }
  }

  private async refresh(provider: ProviderOAuthName, previous: StoredCredential): Promise<StoredCredential> {
    const json = await this.postToken(provider === "openai" ? OPENAI_TOKEN_URL : XAI_TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: previous.refresh,
      client_id: provider === "openai" ? OPENAI_CLIENT_ID : XAI_CLIENT_ID,
    });
    return { ...this.credential(json, previous.refresh, provider === "openai"), connectionId: previous.connectionId ?? createHash("sha256").update(previous.refresh).digest("hex") };
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
    return this.postForm(url, fields, signal ?? new AbortController().signal);
  }

  private async postForm(url: string, fields: Record<string, string>, signal: AbortSignal, allowError = false): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      signal,
    });
    const json = record(await response.json().catch(() => undefined));
    if (!json) throw new Error(`OAuth returned invalid JSON (${response.status})`);
    if (!response.ok && !allowError) throw new Error(requiredString(json.error_description ?? json.error ?? `HTTP ${response.status}`, "error"));
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
    const previousId = previous?.connectionId ?? (previous ? createHash("sha256").update(previous.refresh).digest("hex") : undefined);
    if (previousId !== credential.connectionId || previous?.accountId !== credential.accountId) this.onConnectionChanged?.(provider);
  }

  private setError(provider: ProviderOAuthName, error: unknown): void {
    const pending = this.pending.get(provider);
    if (!pending) return;
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
