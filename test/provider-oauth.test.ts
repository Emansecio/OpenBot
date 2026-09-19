import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createKeystore, type Keystore } from "../src/keystore/index.js";
import { localFileBackend } from "../src/keystore/backend.js";
import { OpenAiAdapter } from "../src/providers/openai.js";
import { raceWithAbort } from "../src/providers/openai-helpers.js";
import {
  ProviderOAuthManager,
  decodeCodexAccountId,
  type ProviderOAuthStatus,
} from "../src/providers/oauth.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function manager(fetchImpl: typeof fetch, now = () => Date.now(), requestTimeoutMs?: number) {
  const root = await mkdtemp(join(tmpdir(), "openbot-oauth-"));
  roots.push(root);
  const key = Buffer.alloc(32, 7);
  const keystore = createKeystore({
    dir: root,
    writeBackend: localFileBackend(key),
    legacyReadBackend: localFileBackend(key),
  });
  return new ProviderOAuthManager({
    keystore,
    fetchImpl,
    now,
    requestTimeoutMs,
    callbackPort: 0,
    pollDelay: async () => undefined,
  });
}

async function managerWithKeystore(fetchImpl: typeof fetch, keystore: Keystore, now = () => Date.now(), requestTimeoutMs?: number) {
  return new ProviderOAuthManager({
    keystore,
    fetchImpl,
    now,
    requestTimeoutMs,
    callbackPort: 0,
    pollDelay: async () => undefined,
  });
}

function jwt(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.x`;
}

async function waitForConnected(oauth: ProviderOAuthManager, provider: "openai" | "xai"): Promise<ProviderOAuthStatus> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await oauth.status(provider);
    if (status.state === "connected" || status.state === "error") return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("OAuth did not settle");
}

describe("ProviderOAuthManager", () => {
  it("extracts the ChatGPT account id without exposing the token", () => {
    expect(decodeCodexAccountId(jwt("acct-123"))).toBe("acct-123");
    expect(() => decodeCodexAccountId("invalid")).toThrow("accountId");
  });

  it("completes Codex PKCE callback and stores only encrypted credentials", async () => {
    const access = jwt("acct-codex");
    const oauth = await manager(async (input, init) => {
      expect(String(input)).toBe("https://auth.openai.com/oauth/token");
      expect(String(init?.body)).toContain("grant_type=authorization_code");
      return Response.json({ access_token: access, refresh_token: "refresh-codex", expires_in: 3600 });
    });

    const started = await oauth.start("openai");
    expect(started.state).toBe("pending");
    const authorization = new URL(started.authorizationUrl!);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    expect((await fetch(callback)).status).toBe(200);

    expect(await waitForConnected(oauth, "openai")).toMatchObject({ state: "connected", accountId: "acct-codex" });
    expect(await oauth.resolveCredential("openai")).toMatchObject({ accessToken: access, accountId: "acct-codex" });
    await oauth.rejectCredential("openai", "older-session");
    expect(await oauth.status("openai")).toMatchObject({ state: "connected" });
    const adapter = new OpenAiAdapter({
      credentialResolver: () => oauth.resolveCredential("openai"),
      onCredentialRejected: (token) => oauth.rejectCredential("openai", token),
      fetchImpl: async () => Response.json({ error: { message: "revoked" } }, { status: 401 }),
    });
    await expect(adapter.streamChat({ model: "fixture", messages: [] }, () => {})).rejects.toMatchObject({ status: 401 });
    const reopened = new ProviderOAuthManager({ keystore: createKeystore({
      dir: roots.at(-1)!,
      writeBackend: localFileBackend(Buffer.alloc(32, 7)),
      legacyReadBackend: localFileBackend(Buffer.alloc(32, 7)),
    }) });
    expect(await reopened.status("openai")).toMatchObject({ state: "error", message: expect.stringContaining("Entre novamente") });
    await expect(reopened.resolveCredential("openai")).rejects.toMatchObject({ status: 401 });
  });

  it("completes xAI device login and refreshes an expired token", async () => {
    let nowMs = 1_000_000;
    let tokenCalls = 0;
    const oauth = await manager(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/device/code")) {
        return Response.json({
          device_code: "device",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.x.ai/device",
          expires_in: 600,
          interval: 1,
        });
      }
      tokenCalls += 1;
      const body = String(init?.body);
      if (body.includes("device_code")) {
        return Response.json({ access_token: "xai-access-1", refresh_token: "xai-refresh", expires_in: 1 });
      }
      expect(body).toContain("grant_type=refresh_token");
      return Response.json({ access_token: "xai-access-2", refresh_token: "xai-refresh-2", expires_in: 3600 });
    }, () => nowMs);

    const started = await oauth.start("xai");
    expect(started).toMatchObject({ state: "pending", userCode: "ABCD-EFGH", authorizationUrl: "https://auth.x.ai/device" });
    expect(await waitForConnected(oauth, "xai")).toMatchObject({ state: "connected" });
    const connectionKey = await oauth.catalogConnectionKey("xai");
    nowMs += 2_000;
    expect(await Promise.all([oauth.resolveCredential("xai"), oauth.resolveCredential("xai")])).toEqual([
      { accessToken: "xai-access-2" }, { accessToken: "xai-access-2" },
    ]);
    expect(tokenCalls).toBe(2);
    expect(await oauth.catalogConnectionKey("xai")).toBe(connectionKey);

    await oauth.disconnect("xai");
    expect(await oauth.status("xai")).toEqual({ provider: "xai", state: "disconnected" });
    expect(await oauth.catalogConnectionKey("xai")).not.toBe(connectionKey);
  });

  it("keeps the credential and reports connected on a transient refresh failure", async () => {
    let nowMs = 1_000_000;
    const oauth = await manager(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/device/code")) {
        return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://auth.x.ai/device", interval: 1 });
      }
      const body = String(init?.body);
      if (body.includes("device_code")) {
        return Response.json({ access_token: "xai-access-1", refresh_token: "xai-refresh", expires_in: 1 });
      }
      // Falha de transporte no refresh — transitória por definição.
      throw new TypeError("fetch failed");
    }, () => nowMs);

    await oauth.start("xai");
    expect(await waitForConnected(oauth, "xai")).toMatchObject({ state: "connected" });
    nowMs += 5_000;

    await expect(oauth.resolveCredential("xai")).rejects.toMatchObject({ status: 503 });
    expect(await oauth.hasCredential("xai")).toBe(true);
    expect(await oauth.status("xai")).toMatchObject({ state: "connected" });
  });

  it.each([
    ["malformed JSON with HTTP 200", () => new Response("not-json", { status: 200 })],
    ["HTML with HTTP 502", () => new Response("<html>temporarily unavailable</html>", { status: 502 })],
  ])("keeps the credential when refresh returns %s", async (_label, response) => {
    let nowMs = 1_000_000;
    const oauth = await manager(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/device/code")) {
        return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://auth.x.ai/device", interval: 1 });
      }
      const body = String(init?.body);
      if (body.includes("device_code")) {
        return Response.json({ access_token: "xai-access-1", refresh_token: "xai-refresh", expires_in: 1 });
      }
      return response();
    }, () => nowMs);

    await oauth.start("xai");
    expect(await waitForConnected(oauth, "xai")).toMatchObject({ state: "connected" });
    nowMs += 5_000;

    await expect(oauth.resolveCredential("xai")).rejects.toMatchObject({ status: 503 });
    expect(await oauth.hasCredential("xai")).toBe(true);
    expect(await oauth.status("xai")).toMatchObject({ state: "connected" });
  });

  it("keeps the credential when a successful refresh body omits the access token", async () => {
    let nowMs = 1_000_000;
    const oauth = await manager(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/device/code")) {
        return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://auth.x.ai/device", interval: 1 });
      }
      const body = String(init?.body);
      if (body.includes("device_code")) {
        return Response.json({ access_token: "xai-access-1", refresh_token: "xai-refresh", expires_in: 1 });
      }
      return Response.json({ expires_in: 3600 }, { status: 200 });
    }, () => nowMs);

    await oauth.start("xai");
    expect(await waitForConnected(oauth, "xai")).toMatchObject({ state: "connected" });
    nowMs += 5_000;

    await expect(oauth.resolveCredential("xai")).rejects.toMatchObject({ status: 503 });
    expect(await oauth.hasCredential("xai")).toBe(true);
    expect(await oauth.status("xai")).toMatchObject({ state: "connected" });
  });

  it("drops the credential and reports disconnected on a definitive refresh rejection", async () => {
    let nowMs = 1_000_000;
    const oauth = await manager(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/device/code")) {
        return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://auth.x.ai/device", interval: 1 });
      }
      const body = String(init?.body);
      if (body.includes("device_code")) {
        return Response.json({ access_token: "xai-access-1", refresh_token: "xai-refresh", expires_in: 1 });
      }
      return Response.json({ error: "invalid_grant", error_description: "refresh token revoked" }, { status: 400 });
    }, () => nowMs);

    await oauth.start("xai");
    expect(await waitForConnected(oauth, "xai")).toMatchObject({ state: "connected" });
    nowMs += 5_000;

    await expect(oauth.resolveCredential("xai")).rejects.toMatchObject({ status: 401 });
    expect(await oauth.hasCredential("xai")).toBe(false);
    expect(await oauth.status("xai")).toMatchObject({ state: "disconnected" });
  });

  it("keeps the credential on an OAuth error that does not identify token invalidation", async () => {
    let nowMs = 1_000_000;
    const oauth = await manager(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/device/code")) {
        return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://auth.x.ai/device", interval: 1 });
      }
      const body = String(init?.body);
      if (body.includes("device_code")) {
        return Response.json({ access_token: "xai-access-1", refresh_token: "xai-refresh", expires_in: 1 });
      }
      return Response.json({ error: "invalid_client" }, { status: 400 });
    }, () => nowMs);

    await oauth.start("xai");
    expect(await waitForConnected(oauth, "xai")).toMatchObject({ state: "connected" });
    nowMs += 5_000;

    await expect(oauth.resolveCredential("xai")).rejects.toMatchObject({ status: 503 });
    expect(await oauth.hasCredential("xai")).toBe(true);
    expect(await oauth.status("xai")).toMatchObject({ state: "connected" });
  });

  it("does not restore credentials when disconnect races token renewal", async () => {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const renewing = new Promise<void>(resolve => { started = resolve; });
    const oauth = await manager(async (input, init) => {
      if (String(input).endsWith("/device/code")) return Response.json({ device_code: "device", user_code: "TEST", verification_uri: "https://auth.x.ai/device", interval: 1 });
      if (String(init?.body).includes("refresh_token")) {
        started(); await pending;
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
      }
      return Response.json({ access_token: "old-access", refresh_token: "old-refresh", expires_in: 1 });
    });
    await oauth.start("xai");
    expect(await waitForConnected(oauth, "xai")).toMatchObject({ state: "connected" });
    const resolution = oauth.resolveCredential("xai");
    const rejected = expect(resolution).rejects.toMatchObject({ status: 401 });
    await renewing;
    await oauth.disconnect("xai");
    release();
    await rejected;
    expect(await oauth.status("xai")).toMatchObject({ state: "disconnected" });
  });

  it("does not create a session when cancel races the initial device request", async () => {
    let releaseDevice!: (response: Response) => void;
    let deviceStarted!: () => void;
    const deviceResponse = new Promise<Response>(resolve => { releaseDevice = resolve; });
    const deviceRequestStarted = new Promise<void>(resolve => { deviceStarted = resolve; });
    const oauth = await manager(async (input) => {
      if (String(input).endsWith("/device/code")) {
        deviceStarted();
        return deviceResponse;
      }
      return Response.json({ access_token: "late-access", refresh_token: "late-refresh", expires_in: 3600 });
    });

    const starting = oauth.start("xai");
    await deviceRequestStarted;
    await expect(oauth.cancel("xai")).resolves.toMatchObject({ provider: "xai", state: "disconnected" });
    releaseDevice(Response.json({ device_code: "late-device", user_code: "LATE", verification_uri: "https://auth.x.ai/device", interval: 1 }));

    await expect(starting).resolves.toMatchObject({ provider: "xai", state: "disconnected" });
    expect(await oauth.status("xai")).toMatchObject({ state: "disconnected" });
    expect(await oauth.hasCredential("xai")).toBe(false);
  });

  it("serializes a late refresh commit with disconnect", async () => {
    let nowMs = 1_000_000;
    let refreshStarted!: () => void;
    const refreshEntered = new Promise<void>(resolve => { refreshStarted = resolve; });
    let refreshWritePaused!: () => void;
    const refreshWriteEntered = new Promise<void>(resolve => { refreshWritePaused = resolve; });
    let releaseRefreshWrite!: () => void;
    const release = new Promise<void>(resolve => { releaseRefreshWrite = resolve; });
    const root = await mkdtemp(join(tmpdir(), "openbot-oauth-late-commit-"));
    roots.push(root);
    const keystore = createKeystore({
      dir: root,
      writeBackend: localFileBackend(Buffer.alloc(32, 7)),
      legacyReadBackend: localFileBackend(Buffer.alloc(32, 7)),
    });
    const realUpsert = keystore.upsert.bind(keystore);
    let pauseRefreshWrite = false;
    keystore.upsert = async (provider: string, value: string, agentId?: string) => {
      if (pauseRefreshWrite && provider === "xai-oauth" && value.includes("new-access")) {
        refreshWritePaused();
        await release;
      }
      return realUpsert(provider, value, agentId);
    };
    const oauth = await managerWithKeystore(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/device/code")) {
        return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://auth.x.ai/device", interval: 1 });
      }
      const body = String(init?.body);
      if (body.includes("device_code")) {
        return Response.json({ access_token: "old-access", refresh_token: "old-refresh", expires_in: 3600 });
      }
      refreshStarted();
      pauseRefreshWrite = true;
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    }, keystore, () => nowMs);

    await oauth.start("xai");
    expect(await waitForConnected(oauth, "xai")).toMatchObject({ state: "connected" });
    nowMs += 5_000_000;

    const resolution = oauth.resolveCredential("xai");
    await refreshEntered;
    await refreshWriteEntered;
    let disconnectSettled = false;
    const disconnecting = oauth.disconnect("xai").then((status) => {
      disconnectSettled = true;
      return status;
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(disconnectSettled).toBe(false);
    releaseRefreshWrite();
    await expect(resolution).resolves.toMatchObject({ accessToken: "new-access" });
    await expect(disconnecting).resolves.toEqual({ provider: "xai", state: "disconnected" });
    expect(await oauth.status("xai")).toMatchObject({ state: "disconnected" });
  });

  it("does not let a refresh response overwrite a newer authentication", async () => {
    let nowMs = 1_000_000;
    let deviceCalls = 0;
    let refreshStarted!: () => void;
    const refreshEntered = new Promise<void>(resolve => { refreshStarted = resolve; });
    let releaseRefresh!: () => void;
    const refreshRelease = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const oauth = await manager(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/device/code")) {
        deviceCalls += 1;
        return Response.json({ device_code: `device-${deviceCalls}`, user_code: "ABCD-EFGH", verification_uri: "https://auth.x.ai/device", interval: 1 });
      }
      const body = String(init?.body);
      if (body.includes("device-1")) return Response.json({ access_token: "old-access", refresh_token: "old-refresh", expires_in: 3600 });
      if (body.includes("device-2")) return Response.json({ access_token: "reauth-access", refresh_token: "reauth-refresh", expires_in: 3600 });
      refreshStarted();
      await refreshRelease;
      return Response.json({ access_token: "stale-refresh-access", refresh_token: "stale-refresh", expires_in: 3600 });
    }, () => nowMs);

    await oauth.start("xai");
    expect(await waitForConnected(oauth, "xai")).toMatchObject({ state: "connected" });
    nowMs += 5_000_000;
    const staleRefresh = oauth.resolveCredential("xai");
    await refreshEntered;

    await oauth.start("xai");
    expect(await waitForConnected(oauth, "xai")).toMatchObject({ state: "connected" });
    expect(await oauth.resolveCredential("xai")).toMatchObject({ accessToken: "reauth-access" });
    releaseRefresh();
    await expect(staleRefresh).rejects.toMatchObject({ status: 401 });
    expect(await oauth.resolveCredential("xai")).toMatchObject({ accessToken: "reauth-access" });
  });

  it("clears an old rejection marker on reauthentication and ignores stale rejection", async () => {
    let deviceCalls = 0;
    const oauth = await manager(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/device/code")) {
        deviceCalls += 1;
        return Response.json({ device_code: `device-${deviceCalls}`, user_code: "ABCD-EFGH", verification_uri: "https://auth.x.ai/device", interval: 1 });
      }
      const body = String(init?.body);
      return body.includes("device-1")
        ? Response.json({ access_token: "old-access", refresh_token: "old-refresh", expires_in: 3600 })
        : Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    });

    await oauth.start("xai");
    expect(await waitForConnected(oauth, "xai")).toMatchObject({ state: "connected" });
    await oauth.rejectCredential("xai", "old-access");
    expect(await oauth.status("xai")).toMatchObject({ state: "error" });

    await oauth.start("xai");
    expect(await waitForConnected(oauth, "xai")).toMatchObject({ state: "connected" });
    await oauth.rejectCredential("xai", "old-access");
    expect(await oauth.status("xai")).toMatchObject({ state: "connected" });
    await expect(oauth.resolveCredential("xai")).resolves.toMatchObject({ accessToken: "new-access" });
  });

  it("releases the mutation lock after rejection write and disconnect delete failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-oauth-lock-failure-"));
    roots.push(root);
    const keystore = createKeystore({
      dir: root,
      writeBackend: localFileBackend(Buffer.alloc(32, 7)),
      legacyReadBackend: localFileBackend(Buffer.alloc(32, 7)),
    });
    const realUpsert = keystore.upsert.bind(keystore);
    const realDelete = keystore.delete.bind(keystore);
    let rejectionWriteEntered!: () => void;
    const rejectionWriteStarted = new Promise<void>(resolve => { rejectionWriteEntered = resolve; });
    let releaseRejectionWrite!: () => void;
    const rejectionWriteRelease = new Promise<void>(resolve => { releaseRejectionWrite = resolve; });
    let failRejectionWrite = true;
    let failCredentialDelete = true;
    keystore.upsert = async (provider: string, value: string, agentId?: string) => {
      if (failRejectionWrite && provider === "xai-oauth-rejection") {
        failRejectionWrite = false;
        rejectionWriteEntered();
        await rejectionWriteRelease;
        throw new Error("injected rejection write failure");
      }
      return realUpsert(provider, value, agentId);
    };
    keystore.delete = async (provider: string, agentId?: string) => {
      if (failCredentialDelete && provider === "xai-oauth") {
        failCredentialDelete = false;
        throw new Error("injected credential delete failure");
      }
      return realDelete(provider, agentId);
    };
    const oauth = await managerWithKeystore(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/device/code")) {
        return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://auth.x.ai/device", interval: 1 });
      }
      return Response.json({ access_token: "xai-access", refresh_token: "xai-refresh", expires_in: 3600 });
    }, keystore);
    await oauth.start("xai");
    expect(await waitForConnected(oauth, "xai")).toMatchObject({ state: "connected" });

    const rejecting = oauth.rejectCredential("xai", "xai-access");
    await rejectionWriteStarted;
    let disconnectSettled = false;
    const disconnecting = oauth.disconnect("xai").finally(() => { disconnectSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(disconnectSettled).toBe(false);
    releaseRejectionWrite();
    await expect(rejecting).rejects.toThrow("injected rejection write failure");
    await expect(disconnecting).rejects.toThrow("injected credential delete failure");
    await expect(oauth.disconnect("xai")).resolves.toEqual({ provider: "xai", state: "disconnected" });
  });

  it("aborts a hung refresh at the transport deadline and permits a later attempt", async () => {
    let nowMs = 1_000_000;
    let refreshCalls = 0;
    let transportAbortCount = 0;
    let refreshStarted!: () => void;
    const started = new Promise<void>(resolve => { refreshStarted = resolve; });
    const oauth = await manager(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/device/code")) {
        return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://auth.x.ai/device", expires_in: 3600, interval: 1 });
      }
      const body = String(init?.body);
      if (body.includes("device_code")) {
        return Response.json({ access_token: "xai-access-1", refresh_token: "xai-refresh", expires_in: 3600 });
      }
      refreshCalls += 1;
      if (refreshCalls === 1) {
        refreshStarted();
        await new Promise<never>((_, reject) => {
          const signal = init?.signal;
          const onAbort = () => {
            transportAbortCount += 1;
            reject(signal?.reason ?? new Error("transport aborted"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
      }
      return Response.json({ access_token: `xai-access-${refreshCalls + 1}`, refresh_token: "xai-refresh-next", expires_in: 3600 });
    }, () => nowMs, 20);

    await oauth.start("xai");
    expect(await waitForConnected(oauth, "xai")).toMatchObject({ state: "connected" });
    nowMs += 3_600_001;

    const first = oauth.resolveCredential("xai");
    await started;
    await expect(first).rejects.toMatchObject({ status: 503 });
    expect(transportAbortCount).toBe(1);
    expect(refreshCalls).toBe(1);

    await expect(oauth.resolveCredential("xai")).resolves.toMatchObject({ accessToken: "xai-access-3" });
    expect(refreshCalls).toBe(2);
  });

  it("lets one shared refresh waiter abort without cancelling another consumer", async () => {
    let nowMs = 1_000_000;
    let refreshCalls = 0;
    let transportAborted = false;
    let refreshStarted!: () => void;
    let releaseRefresh!: () => void;
    const started = new Promise<void>(resolve => { refreshStarted = resolve; });
    const refreshResponse = new Promise<Response>(resolve => { releaseRefresh = () => resolve(Response.json({ access_token: "xai-access-2", refresh_token: "xai-refresh-2", expires_in: 3600 })); });
    const oauth = await manager(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/device/code")) {
        return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://auth.x.ai/device", expires_in: 3600, interval: 1 });
      }
      const body = String(init?.body);
      if (body.includes("device_code")) {
        return Response.json({ access_token: "xai-access-1", refresh_token: "xai-refresh", expires_in: 3600 });
      }
      refreshCalls += 1;
      init?.signal?.addEventListener("abort", () => { transportAborted = true; }, { once: true });
      refreshStarted();
      return refreshResponse;
    }, () => nowMs, 1_000);

    await oauth.start("xai");
    expect(await waitForConnected(oauth, "xai")).toMatchObject({ state: "connected" });
    nowMs += 3_600_001;

    const consumerAbort = new AbortController();
    const abandoned = raceWithAbort(oauth.resolveCredential("xai"), consumerAbort.signal);
    await started;
    const surviving = oauth.resolveCredential("xai");
    consumerAbort.abort(new Error("consumer abandoned"));
    await expect(abandoned).rejects.toThrow("consumer abandoned");
    expect(transportAborted).toBe(false);
    releaseRefresh();
    await expect(surviving).resolves.toMatchObject({ accessToken: "xai-access-2" });
    expect(refreshCalls).toBe(1);
  });
});
