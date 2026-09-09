import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalFileLogger, installLocalFileLoggerFromEnvironment, redactLogText } from "../src/local-logger.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bounded local logger", () => {
  it("rotates during the same process and keeps bounded retention", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-logger-"));
    temporaryRoots.push(root);
    const path = join(root, "gateway.log");
    const logger = createLocalFileLogger({ path, maxBytes: 96, backups: 2 });

    for (let index = 0; index < 20; index += 1) logger.write("INFO", `event-${index}-${"x".repeat(24)}`);

    const files = (await readdir(root)).sort();
    expect(files).toEqual(["gateway.log", "gateway.log.1", "gateway.log.2"]);
    for (const name of files) expect((await stat(join(root, name))).size).toBeLessThanOrEqual(96);
    expect(await readFile(path, "utf8")).toContain("event-19");
  });

  it("redacts bearer, token, secret, password, API key, and explicit values", () => {
    const explicit = "fixture-explicit-secret";
    const input = [
      "Authorization: Bearer bearer-value",
      "token=token-value",
      "secret: secret-value",
      "password=password-value",
      "api_key=api-key-value",
      '{"apiKey":"json-api-key","token":"json-token"}',
      explicit,
    ].join(" ");

    const output = redactLogText(input, [explicit]);

    expect(output).not.toMatch(/bearer-value|token-value|secret-value|password-value|api-key-value|json-api-key|json-token|fixture-explicit-secret/);
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(8);
  });

  it("does not install a logger when the destination cannot be created", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-logger-fail-"));
    temporaryRoots.push(root);
    const file = join(root, "not-a-directory");
    await writeFile(file, "occupied");
    const target = { log() {}, info() {}, warn() {}, error() {} };

    expect(installLocalFileLoggerFromEnvironment({ OPENBOT_LOG_DIR: file }, target)).toMatchObject({ installed: false });
  });
});
