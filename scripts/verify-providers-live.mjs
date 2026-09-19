#!/usr/bin/env node
/**
 * verify-providers-live — gate OPT-IN que exercita providers reais com as
 * credenciais configuradas localmente (keystore + config do usuário).
 *
 * Uso:
 *   npm run build && node scripts/verify-providers-live.mjs [--provider <id>] [--config <path>] [--state-root <dir>]
 *
 * Garantias:
 *  - nunca imprime tokens, chaves ou corpos de resposta do provider;
 *  - provider sem credencial configurada => SKIP (nunca falso sucesso);
 *  - provider configurado com falha => FAIL (exit != 0);
 *  - os testes offline/mock permanecem o caminho normal de verificação;
 *    este script só é útil com credenciais reais instaladas.
 *
 * O que cada check valida:
 *  - openai:      OAuth resolve + refresh (accountId do Codex presente);
 *  - xai:         OAuth resolve + GET /v1/models autenticado retorna lista;
 *  - opencode-go: chave na keystore + GET /models retorna modelos;
 *  - openai-compat: compatBaseUrl configurado + GET /models responde;
 *  - serialização: o corpo gerado por cada adapter carrega `reasoning_effort`
 *    somente onde o contrato o declara (F-05, fail-closed).
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(REPO_ROOT, "dist");
// import() exige URL — no Windows um path absoluto "C:\..." não é specifier válido.
const distImport = (rel) => import(pathToFileURL(join(DIST, rel)).href);

if (!existsSync(join(DIST, "providers", "oauth.js"))) {
  console.error("dist/ ausente — execute `npm run build` antes deste gate.");
  process.exit(2);
}

const {
  ConfigStore,
} = await distImport("config/store.js");
const { createKeystore } = await distImport("keystore/index.js");
const { ProviderOAuthManager } = await distImport("providers/oauth.js");
const { XaiAdapter } = await distImport("providers/xai.js");
const { OpenAiAdapter } = await distImport("providers/openai.js");
const { OpenAiCompatAdapter } = await distImport("providers/openai-compat.js");
const { OpenCodeGoAdapter } = await distImport("providers/opencode-go.js");
const { testCompatConnection } = await distImport("providers/local-discover.js");

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const onlyProvider = argValue("provider");
const configPath = argValue("config");
const stateRoot = argValue("state-root");

const results = [];
const report = (id, status, detail) => {
  results.push({ id, status, detail });
  console.log(`${status === "PASS" ? "✓" : status === "SKIP" ? "-" : "✗"} [${status}] ${id}${detail ? ` — ${detail}` : ""}`);
};

const config = new ConfigStore(configPath !== undefined ? { configPath } : {});
const keystore = createKeystore(stateRoot !== undefined ? { dir: stateRoot } : {});
const oauth = new ProviderOAuthManager({ keystore });
const snapshot = config.snapshot();

const run = async (id, fn) => {
  if (onlyProvider && onlyProvider !== id) return;
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Nunca propaga corpos de resposta: mensagens ApiError podem conter texto
    // do endpoint; reporta só a primeira linha sem dados sensíveis.
    report(id, "FAIL", message.split("\n")[0].slice(0, 200));
  }
};

await run("openai", async () => {
  const status = await oauth.status("openai");
  if (status.state !== "connected") {
    return report("openai", "SKIP", `sessão ${status.state}`);
  }
  const credential = await oauth.resolveCredential("openai");
  if (!credential.accountId) return report("openai", "FAIL", "credencial sem accountId Codex");
  report("openai", "PASS", "OAuth resolve e accountId presente");
});

await run("xai", async () => {
  const status = await oauth.status("xai");
  if (status.state !== "connected") {
    return report("xai", "SKIP", `sessão ${status.state}`);
  }
  const credential = await oauth.resolveCredential("xai");
  const response = await fetch("https://api.x.ai/v1/models", {
    headers: { accept: "application/json", authorization: `Bearer ${credential.accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return report("xai", "FAIL", `GET /models HTTP ${response.status}`);
  const json = await response.json().catch(() => undefined);
  const count = Array.isArray(json?.data) ? json.data.length : 0;
  if (count === 0) return report("xai", "FAIL", "GET /models retornou lista vazia");
  report("xai", "PASS", `${count} modelos listados`);
});

await run("opencode-go", async () => {
  const key = await keystore.reveal("opencode-go");
  if (typeof key !== "string" || key.length === 0) {
    return report("opencode-go", "SKIP", "sem chave na keystore");
  }
  const adapter = new OpenCodeGoAdapter({ keystore });
  const models = await adapter.discoverModels(AbortSignal.timeout(15_000));
  if (models.length === 0) return report("opencode-go", "FAIL", "GET /models retornou lista vazia");
  report("opencode-go", "PASS", `${models.length} modelos listados`);
});

await run("openai-compat", async () => {
  const baseURL = snapshot.compatBaseUrl;
  if (typeof baseURL !== "string" || baseURL.length === 0) {
    return report("openai-compat", "SKIP", "compatBaseUrl não configurado");
  }
  const { wrapKeystoreForCompat } = await distImport("providers/compat-presets.js");
  const scoped = wrapKeystoreForCompat(baseURL, keystore);
  const apiKey = (await scoped?.reveal("openai-compat")) ?? undefined;
  const tested = await testCompatConnection(baseURL, { apiKey, timeoutMs: 5_000 });
  if (!tested.ok) return report("openai-compat", "FAIL", `endpoint: ${tested.error ?? "falha"}`);
  report("openai-compat", "PASS", `${tested.models.length} modelos listados`);
});

// Serialização (offline, sem rede): o contrato de reasoning_effort é
// fail-closed — presente só onde o adapter o declara suportado.
if (onlyProvider === undefined || onlyProvider === "serialization") {
  const request = {
    model: "grok-4.6",
    messages: [{ role: "user", content: "ping" }],
    reasoningEffort: "low",
  };
  const declared = {
    ...request,
    modelResolution: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
  };
  const bodies = {
    "xai (declarado)": new XaiAdapter({ apiKey: "x" }).serializeRequest(declared),
    "xai (não declarado)": new XaiAdapter({ apiKey: "x" }).serializeRequest(request),
    "openai (chat)": new OpenAiAdapter({ apiKey: "x" }).serializeRequest(request),
    "openai-compat (opt-in)": new OpenAiCompatAdapter({ baseUrl: "https://127.0.0.1:9/v1", apiKey: "x", sendReasoningEffort: true }).serializeRequest(request),
    "openai-compat (default)": new OpenAiCompatAdapter({ baseUrl: "https://127.0.0.1:9/v1", apiKey: "x" }).serializeRequest(request),
  };
  const expect = {
    "xai (declarado)": true,
    "xai (não declarado)": false,
    "openai (chat)": false,
    "openai-compat (opt-in)": true,
    "openai-compat (default)": false,
  };
  for (const [label, body] of Object.entries(bodies)) {
    const has = JSON.parse(body).reasoning_effort === "low";
    if (has !== expect[label]) {
      report(`serialization:${label}`, "FAIL", `reasoning_effort ${has ? "presente" : "ausente"}, esperado ${expect[label] ? "presente" : "ausente"}`);
    } else {
      report(`serialization:${label}`, "PASS");
    }
  }
}

config.close();

const failures = results.filter((r) => r.status === "FAIL").length;
const passed = results.filter((r) => r.status === "PASS").length;
const skipped = results.filter((r) => r.status === "SKIP").length;
console.log(`\n${passed} PASS, ${skipped} SKIP, ${failures} FAIL`);
process.exit(failures > 0 ? 1 : 0);
