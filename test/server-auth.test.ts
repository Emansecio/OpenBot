import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsRace = vi.hoisted(() => ({ file: null as string | null, winningToken: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: unknown[]) => {
      const [file, , options] = args;
      if (typeof file === "string" && file === fsRace.file && typeof options === "object" && options !== null && Reflect.get(options, "flag") === "wx") {
        fsRace.file = null;
        actual.writeFileSync(file, `${fsRace.winningToken}\n`, "utf8");
      }
      return Reflect.apply(actual.writeFileSync, actual, args);
    },
  };
});

import { loadOrCreateGatewayToken, resolveGatewayTokenPath, tokenFromRequest } from "../src/server/auth.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const request = (headers: IncomingMessage["headers"]): IncomingMessage => ({ headers }) as IncomingMessage;

describe("gateway auth", () => {
  it("cria uma vez e relê o token vencedor", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-auth-"));
    dirs.push(dir);
    const file = join(dir, "gateway.token");
    fsRace.file = file;
    fsRace.winningToken = "token-created-by-competing-process";

    expect(loadOrCreateGatewayToken(file)).toBe(fsRace.winningToken);
    expect(readFileSync(file, "utf8").trim()).toBe(fsRace.winningToken);
  });

  it("aceita Bearer case-insensitive e rejeita Authorization cru", () => {
    expect(tokenFromRequest(request({ authorization: "bearer secret-token" }))).toBe("secret-token");
    expect(tokenFromRequest(request({ authorization: "secret-token" }))).toBe("");
    expect(tokenFromRequest(request({ "x-openbot-token": "header-token" }))).toBe("header-token");
  });

  it("falha quando o arquivo de token existente é vazio", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-auth-empty-"));
    dirs.push(dir);
    const file = join(dir, "gateway.token");
    writeFileSync(file, "\n", "utf8");
    expect(() => loadOrCreateGatewayToken(file)).toThrow(/invalid/i);
  });

  it("resolves the token path with explicit env, data root, state root, config path, then default", () => {
    const previousExplicit = process.env.OPENBOT_GATEWAY_TOKEN_PATH;
    const previousDataRoot = process.env.OPENBOT_DATA_ROOT;
    const previousAppData = process.env.APPDATA;
    try {
      process.env.OPENBOT_GATEWAY_TOKEN_PATH = "C:\\tokens\\explicit.token";
      process.env.OPENBOT_DATA_ROOT = "C:\\tokens\\data-root";
      expect(resolveGatewayTokenPath({ stateRoot: "C:\\tokens\\state", configPath: "C:\\tokens\\config\\openbot-config.json" }))
        .toBe("C:\\tokens\\explicit.token");

      delete process.env.OPENBOT_GATEWAY_TOKEN_PATH;
      expect(resolveGatewayTokenPath({ stateRoot: "C:\\tokens\\state", configPath: "C:\\tokens\\config\\openbot-config.json" }))
        .toBe("C:\\tokens\\data-root\\gateway.token");

      delete process.env.OPENBOT_DATA_ROOT;
      expect(resolveGatewayTokenPath({ stateRoot: "C:\\tokens\\state", configPath: "C:\\tokens\\config\\openbot-config.json" }))
        .toBe("C:\\tokens\\state\\gateway.token");
      expect(resolveGatewayTokenPath({ configPath: "C:\\tokens\\config\\openbot-config.json" }))
        .toBe("C:\\tokens\\config\\gateway.token");

      process.env.APPDATA = "C:\\Users\\fixture\\AppData\\Roaming";
      expect(resolveGatewayTokenPath()).toBe("C:\\Users\\fixture\\AppData\\Roaming\\OpenBot\\gateway.token");
    } finally {
      if (previousExplicit === undefined) delete process.env.OPENBOT_GATEWAY_TOKEN_PATH;
      else process.env.OPENBOT_GATEWAY_TOKEN_PATH = previousExplicit;
      if (previousDataRoot === undefined) delete process.env.OPENBOT_DATA_ROOT;
      else process.env.OPENBOT_DATA_ROOT = previousDataRoot;
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
    }
  });
});
