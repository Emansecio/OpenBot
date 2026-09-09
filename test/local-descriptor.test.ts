import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

describe("local gateway descriptor", () => {
  it("writes a loopback descriptor with the gateway token", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-descriptor-"));
    try {
      const file = join(dir, "descriptor.json");
      const token = "local-test-token-123456789";
      mkdirSync(join(dir, "OpenBot"));
      writeFileSync(join(dir, "OpenBot", "gateway.token"), `${token}\n`);
      execFileSync(process.execPath, ["scripts/local-descriptor.mjs", file], {
        cwd: new URL("..", import.meta.url).pathname.replace(/^\/(.):/, "$1:"),
        env: { ...process.env, APPDATA: dir, SAND_HOST_GATEWAY_TOKEN: "", OPENBOT_GATEWAY_TOKEN: "", OPENBOT_GATEWAY_PORT: "1340" },
      });
      const descriptor = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(descriptor).toMatchObject({
        version: 1,
        gatewayUrl: "http://127.0.0.1:1340",
        networkToken: null,
        local: true,
        env: {
          SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1340",
          SAND_HOST_GATEWAY_TOKEN: token,
          SAND_HOST_GATEWAY_NETWORK_TOKEN: "",
        },
      });
      expect(JSON.stringify(descriptor)).not.toMatch(/apiKey|secret|tokenValue/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to emit an unauthenticated descriptor when the token is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-descriptor-empty-"));
    try {
      const file = join(dir, "descriptor.json");
      expect(() => execFileSync(process.execPath, ["scripts/local-descriptor.mjs", file], {
        cwd: new URL("..", import.meta.url).pathname.replace(/^\/(.):/, "$1:"),
        env: { ...process.env, APPDATA: dir, SAND_HOST_GATEWAY_TOKEN: "", OPENBOT_GATEWAY_TOKEN: "" },
        stdio: "pipe",
      })).toThrow();
      expect(() => readFileSync(file, "utf8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the token from an explicit OpenBot data root", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-descriptor-root-"));
    try {
      const file = join(dir, "descriptor.json");
      const dataRoot = join(dir, "custom-data");
      const token = "custom-root-token-123456789";
      mkdirSync(dataRoot);
      writeFileSync(join(dataRoot, "gateway.token"), `${token}\n`);
      execFileSync(process.execPath, ["scripts/local-descriptor.mjs", file], {
        cwd: new URL("..", import.meta.url).pathname.replace(/^\/(.):/, "$1:"),
        env: {
          ...process.env,
          APPDATA: join(dir, "unused-appdata"),
          OPENBOT_DATA_ROOT: dataRoot,
          SAND_HOST_GATEWAY_TOKEN: "",
          OPENBOT_GATEWAY_TOKEN: "",
        },
      });
      const descriptor = JSON.parse(readFileSync(file, "utf8")) as { env: { SAND_HOST_GATEWAY_TOKEN: string } };
      expect(descriptor.env.SAND_HOST_GATEWAY_TOKEN).toBe(token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers OPENBOT_GATEWAY_TOKEN_PATH over the data root", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-descriptor-token-path-"));
    try {
      const file = join(dir, "descriptor.json");
      const tokenFile = join(dir, "tokens", "gateway.token");
      const token = "explicit-token-path-123456789";
      mkdirSync(join(dir, "tokens"), { recursive: true });
      mkdirSync(join(dir, "data-root"), { recursive: true });
      writeFileSync(tokenFile, `${token}\n`);
      writeFileSync(join(dir, "data-root", "gateway.token"), "stale-data-root-token-123456789\n");
      execFileSync(process.execPath, ["scripts/local-descriptor.mjs", file], {
        cwd: new URL("..", import.meta.url).pathname.replace(/^\/(.):/, "$1:"),
        env: {
          ...process.env,
          OPENBOT_GATEWAY_TOKEN_PATH: tokenFile,
          OPENBOT_DATA_ROOT: join(dir, "data-root"),
          SAND_HOST_GATEWAY_TOKEN: "",
          OPENBOT_GATEWAY_TOKEN: "",
        },
      });
      const descriptor = JSON.parse(readFileSync(file, "utf8")) as { env: { SAND_HOST_GATEWAY_TOKEN: string } };
      expect(descriptor.env.SAND_HOST_GATEWAY_TOKEN).toBe(token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores stale token env values when OPENBOT_GATEWAY_TOKEN_PATH is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-descriptor-token-path-vs-env-"));
    try {
      const file = join(dir, "descriptor.json");
      const tokenFile = join(dir, "tokens", "gateway.token");
      const token = "fresh-file-token-123456789";
      mkdirSync(join(dir, "tokens"), { recursive: true });
      writeFileSync(tokenFile, `${token}\n`);
      execFileSync(process.execPath, ["scripts/local-descriptor.mjs", file], {
        cwd: new URL("..", import.meta.url).pathname.replace(/^\/(.):/, "$1:"),
        env: {
          ...process.env,
          OPENBOT_GATEWAY_TOKEN_PATH: tokenFile,
          SAND_HOST_GATEWAY_TOKEN: "stale-env-token-123456789",
          OPENBOT_GATEWAY_TOKEN: "other-stale-env-token-123456789",
        },
      });
      const descriptor = JSON.parse(readFileSync(file, "utf8")) as { env: { SAND_HOST_GATEWAY_TOKEN: string } };
      expect(descriptor.env.SAND_HOST_GATEWAY_TOKEN).toBe(token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
