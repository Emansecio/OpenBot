import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import type { ProviderOAuthManager } from "./oauth.js";
import { CatalogDiscoveryError, type CatalogSource, type DiscoveredModel } from "./model-catalog.js";
import { codexCatalogPage, discoveryRecord } from "./model-discovery.js";

/** Resolve only installed binaries. Renderer input is never used as a command. */
export function resolveCodexExecutable(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const direct = join(directory, process.platform === "win32" ? "codex.exe" : "codex");
    if (existsSync(direct)) return direct;
    const packages = join(directory, "node_modules", "@openai", "codex", "node_modules", "@openai");
    if (!existsSync(packages)) continue;
    for (const name of readdirSync(packages).filter(n => n.startsWith("codex-"))) {
      const vendor = join(packages, name, "vendor");
      if (!existsSync(vendor)) continue;
      for (const target of readdirSync(vendor)) {
        for (const folder of ["bin", "codex"]) {
          const executable = join(vendor, target, folder, process.platform === "win32" ? "codex.exe" : "codex");
          if (existsSync(executable)) return executable;
        }
      }
    }
  }
  throw new CatalogDiscoveryError("Codex instalado não encontrado. A descoberta requer Codex App Server compatível.");
}

export function createCodexCatalogSource(options: {
  oauth: Pick<ProviderOAuthManager, "catalogConnectionKey" | "resolveCredential" | "refreshCredential">;
  stateDirectory: string;
  resolveExecutable?: () => string;
  spawnProcess?: (executable: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
}): CatalogSource {
  return {
    connectionKey: () => options.oauth.catalogConnectionKey("openai"),
    async discover(signal) {
      const executable = (options.resolveExecutable ?? resolveCodexExecutable)();
      const credential = await options.oauth.resolveCredential("openai").catch(() => {
        throw new CatalogDiscoveryError("Conecte sua conta OpenAI para atualizar o catálogo.");
      });
      if (!credential.accountId) throw new CatalogDiscoveryError("A conexão OpenAI não informa a conta ChatGPT.");
      if (signal.aborted) throw new CatalogDiscoveryError("Consulta Codex cancelada.");
      mkdirSync(options.stateDirectory, { recursive: true });
      const env: NodeJS.ProcessEnv = { CODEX_HOME: options.stateDirectory };
      for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT"]) {
        if (process.env[key]) env[key] = process.env[key];
      }
      const child = options.spawnProcess
        ? options.spawnProcess(executable, ["app-server", "--listen", "stdio://"], env)
        : spawn(executable, ["app-server", "--listen", "stdio://"], { env, cwd: options.stateDirectory, windowsHide: true, stdio: "pipe" });
      const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
      let sequence = 0;
      let stopped = false;
      const failure = () => new CatalogDiscoveryError("Codex App Server indisponível ou incompatível com a descoberta de modelos.");
      const stop = () => {
        if (stopped) return;
        stopped = true;
        for (const request of pending.values()) request.reject(failure());
        pending.clear();
        child.stdin.destroy();
        child.kill();
      };
      signal.addEventListener("abort", stop, { once: true });
      child.on("error", stop);
      child.on("exit", stop);
      child.stdin.on("error", stop);
      // Drain diagnostics without logging: app-server output may contain account data.
      child.stderr.resume();
      const send = (value: unknown) => { if (!stopped) child.stdin.write(`${JSON.stringify(value)}\n`); };
      const rpc = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
        if (stopped) return reject(failure());
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      });
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", line => {
        if (line.length > 2_000_000) return stop();
        let message: Record<string, unknown> | undefined;
        try { message = discoveryRecord(JSON.parse(line)); } catch { return stop(); }
        if (!message) return stop();
        if (message.method === "account/chatgptAuthTokens/refresh" && message.id !== undefined) {
          const requestId = message.id;
          void options.oauth.refreshCredential("openai", credential.accountId).then(next => {
            send({ id: requestId, result: { accessToken: next.accessToken, chatgptAccountId: next.accountId } });
          }, () => { send({ id: requestId, error: { code: -32000, message: "OAuth renewal unavailable" } }); stop(); });
          return;
        }
        if (message.method !== undefined) {
          if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not supported" } });
          return;
        }
        if (typeof message.id !== "number") return;
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(failure()); else request.resolve(message.result);
      });
      try {
        await rpc("initialize", { clientInfo: { name: "openbot", version: "0.1.1" }, capabilities: { experimentalApi: true } });
        send({ method: "initialized", params: {} });
        await rpc("account/login/start", { type: "chatgptAuthTokens", accessToken: credential.accessToken, chatgptAccountId: credential.accountId });
        const models: DiscoveredModel[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = codexCatalogPage(await rpc("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }));
          models.push(...page.models);
          cursor = page.nextCursor;
          if (models.length > 2048 || (cursor && cursors.has(cursor))) throw failure();
          if (cursor) cursors.add(cursor);
        } while (cursor);
        return models;
      } finally {
        lines.close();
        stop();
        signal.removeEventListener("abort", stop);
      }
    },
  };
}
