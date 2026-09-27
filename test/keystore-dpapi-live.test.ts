import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { dpapiCurrentUserBackend } from "../src/keystore/dpapi.js";
import { createKeystore } from "../src/keystore/index.js";
import { TempRoots } from "./helpers/temp-roots.js";

const temp = new TempRoots();
afterEach(async () => {
  await temp.cleanup();
});

describe("DPAPI CurrentUser", () => {
  it.skipIf(process.platform !== "win32" || process.env.OPENBOT_RUN_DPAPI_LIVE !== "1")("live: write, restart, reveal, delete e plaintext ausente do disco", async () => {
    const npmCli = process.env.npm_execpath;
    expect(npmCli).toBeTruthy();
    for (const script of ["build", "verify:backend-artifacts", "verify:dpapi-artifacts"]) {
      execFileSync(process.execPath, [npmCli!, "run", script], { stdio: "pipe" });
    }
    const root = await temp.makeAsync("openbot-dpapi-live-");
    const addonPath = path.resolve("native", "dpapi", `win32-${process.arch}`, "openbot-dpapi.node");
    expect(existsSync(addonPath)).toBe(true);
    const backend = dpapiCurrentUserBackend();
    const first = createKeystore({ dir: root, writeBackend: backend, legacyReadBackend: backend });
    await first.upsert("openai", "live-secret-not-on-disk");
    const raw = await readFile(first.getFile(), "utf8");
    expect(raw).not.toContain("live-secret-not-on-disk");
    const child = execFileSync(process.execPath, ["-e", [
      "import { createKeystore } from './dist/keystore/index.js';",
      "const ks = createKeystore({ dir: process.env.OPENBOT_LIVE_DIR });",
      "const value = await ks.reveal('openai');",
      "if (value !== 'live-secret-not-on-disk') throw new Error('unexpected reveal value');",
      "process.stdout.write('REVEALED');",
    ].join("\n")], { env: { ...process.env, OPENBOT_LIVE_DIR: root, OPENBOT_KEYSTORE_MEMORY: undefined, VITEST: undefined, NODE_ENV: "production" }, encoding: "utf8" });
    expect(child).toBe("REVEALED");
    expect(await first.delete("openai")).toBe(true);
    expect(await first.reveal("openai")).toBeNull();
  });
});
