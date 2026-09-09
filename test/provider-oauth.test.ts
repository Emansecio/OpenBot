import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createKeystore } from "../src/keystore/index.js";
import { localFileBackend } from "../src/keystore/backend.js";
import { OpenAiAdapter } from "../src/providers/openai.js";
import {
  ProviderOAuthManager,
  decodeCodexAccountId,
  type ProviderOAuthStatus,
} from "../src/providers/oauth.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function manager(fetchImpl: typeof fetch, now = () => Date.now()) {
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
});
