import { afterEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexCatalogSource, resolveCodexExecutable } from "../src/providers/codex-catalog.js";
import { ModelCatalogService } from "../src/providers/model-catalog.js";
import { connectionFingerprint } from "../src/providers/model-discovery.js";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise<void>(resolve => child.once("exit", () => resolve()));
    }
  }
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

it.each(["bin", "codex"])("finds an npm Codex executable in the %s layout", folder => {
  const directory = mkdtempSync(join(tmpdir(), "openbot-codex-path-"));
  roots.push(directory);
  const binaryDir = join(directory, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", folder);
  mkdirSync(binaryDir, { recursive: true });
  const executable = join(binaryDir, process.platform === "win32" ? "codex.exe" : "codex");
  writeFileSync(executable, "fixture");
  vi.stubEnv("PATH", directory);
  expect(resolveCodexExecutable()).toBe(executable);
});

function fixture(mode = "success") {
  const directory = mkdtempSync(join(tmpdir(), "openbot-codex-catalog-"));
  roots.push(directory);
  const methods = join(directory, "methods.jsonl");
  const script = join(directory, "fixture.cjs");
  writeFileSync(script, `
    const { createInterface } = require('node:readline');
    const { appendFileSync } = require('node:fs');
    const reply = value => process.stdout.write(JSON.stringify(value) + '\\n');
    let waiting;
    createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.method) appendFileSync(${JSON.stringify(methods)}, JSON.stringify(request.method) + '\\n');
      if (${JSON.stringify(mode)} === 'timeout') return;
      if (${JSON.stringify(mode)} === 'incompatible') return reply({id:request.id,error:{message:'private-sensitive-diagnostic'}});
      if (request.method === 'initialize') return reply({ id: request.id, result: {} });
      if (request.method === 'initialized') return;
      if (request.method === 'account/login/start') {
        if (request.params.type !== 'chatgptAuthTokens' || !request.params.accessToken || !request.params.chatgptAccountId) return process.exit(3);
        waiting = request.id; return reply({ id:'renew', method:'account/chatgptAuthTokens/refresh', params:{reason:'unauthorized'} });
      }
      if (request.id === 'renew') {
        if (!request.result?.accessToken) return process.exit(4);
        return reply({ id: waiting, result: {} });
      }
      if (request.method === 'model/list') {
        if(request.params.includeHidden !== false) return process.exit(5);
        return reply({ id: request.id, result: { data:[{model:request.params.cursor ? 'gpt-5.6-luna' : 'gpt-5.6-sol',displayName:'Model',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'ultra'}],inputModalities:['text','image']}],nextCursor:request.params.cursor ? null:'page2' } });
      }
      process.exit(6);
    });
  `);
  const oauth = {
    catalogConnectionKey: async () => connectionFingerprint("codex-fixture"),
    resolveCredential: vi.fn(async () => ({ accessToken: "fixture-access-secret", accountId: "fixture-account" })),
    refreshCredential: vi.fn(async () => ({ accessToken: "fixture-renewed-secret", accountId: "fixture-account" })),
  };
  const source = createCodexCatalogSource({
    stateDirectory: join(directory, "state"), oauth, resolveExecutable: () => process.execPath,
    spawnProcess: (executable, args, env) => {
      expect(args).toEqual(["app-server", "--listen", "stdio://"]);
      expect(JSON.stringify({ args, env })).not.toMatch(/fixture-access-secret|fixture-renewed-secret/);
      expect(env.CODEX_HOME).toBe(join(directory, "state"));
      expect(env.OPENAI_API_KEY).toBeUndefined();
      const child = spawn(executable, [script], { env, windowsHide: true, stdio: "pipe" });
      children.push(child);
      return child;
    },
  });
  return { source, oauth, methods };
}

it("uses only catalog RPCs, external tokens, pagination and renewal, then stops the process", async () => {
  const { source, oauth, methods } = fixture();
  const models = await source.discover(new AbortController().signal);
  expect(models.map(m => m.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);
  expect(models[0]?.supportedReasoningEfforts).toEqual(["high"]);
  expect(oauth.refreshCredential).toHaveBeenCalledWith("openai", "fixture-account");
  expect(readFileSync(methods, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([
    "initialize", "initialized", "account/login/start", "model/list", "model/list",
  ]);
  expect(children[0]?.killed).toBe(true);
});

it.each(["incompatible", "timeout"])("sanitizes %s and terminates its process", async mode => {
  const { source } = fixture(mode);
  const service = new ModelCatalogService({ sources: { openai: source }, timeoutMs: mode === "timeout" ? 80 : 1000 });
  const result = await service.get("openai");
  expect(result.state).toBe("unavailable");
  expect(result.error).toBeTruthy();
  expect(JSON.stringify(result)).not.toMatch(/private-sensitive-diagnostic|fixture-access-secret|fixture-renewed-secret/);
  expect(children[0]?.killed).toBe(true);
  service.close();
});

it("reports missing executable without launching or authenticating", async () => {
  const oauth = { catalogConnectionKey: async () => connectionFingerprint("none"), resolveCredential: vi.fn(), refreshCredential: vi.fn() };
  const source = createCodexCatalogSource({ oauth, stateDirectory: "unused", resolveExecutable: () => { throw new Error("Codex não encontrado"); } });
  await expect(source.discover(new AbortController().signal)).rejects.toThrow("Codex não encontrado");
  expect(oauth.resolveCredential).not.toHaveBeenCalled();
});
