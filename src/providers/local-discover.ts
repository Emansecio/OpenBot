import { validateCompatBaseUrl } from "./openai-compat.js";

export interface ConnectionTestResult {
  ok: boolean;
  baseURL: string;
  latencyMs: number | null;
  models: Array<{ id: string; name: string }>;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelName(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  if (typeof value.id === "string" && value.id.trim()) return value.id.trim();
  if (typeof value.name === "string" && value.name.trim()) return value.name.trim();
  if (typeof value.model === "string" && value.model.trim()) return value.model.trim();
  return undefined;
}

function parseModels(payload: unknown): Array<{ id: string; name: string }> {
  const rows = isRecord(payload) && Array.isArray(payload.data)
    ? payload.data
    : isRecord(payload) && Array.isArray(payload.models)
      ? payload.models
      : Array.isArray(payload) ? payload : [];
  const models: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = modelName(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const display = isRecord(row) && typeof row.name === "string" ? row.name : id;
    models.push({ id, name: display });
  }
  return models;
}

async function fetchJson(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  apiKey?: string,
): Promise<{ ok: true; json: unknown; ms: number } | { ok: false; error: string; ms: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey !== undefined && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(url, { signal: controller.signal, headers });
    const ms = Date.now() - started;
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, ms };
    return { ok: true, json: await response.json(), ms };
  } catch (error) {
    const ms = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: /abort/i.test(message) ? "timeout" : message, ms };
  } finally {
    clearTimeout(timer);
  }
}

export async function testCompatConnection(
  baseURL: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch; apiKey?: string } = {},
): Promise<ConnectionTestResult> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let parsedBase: URL;
  try {
    parsedBase = validateCompatBaseUrl(baseURL).url;
  } catch (error) {
    return {
      ok: false,
      baseURL,
      latencyMs: null,
      models: [],
      error: error instanceof Error ? error.message : "baseURL inválida",
    };
  }
  parsedBase.pathname = `${parsedBase.pathname.replace(/\/+$/, "")}/models`;
  const hit = await fetchJson(parsedBase.toString(), timeoutMs, fetchImpl, opts.apiKey);
  if (!hit.ok) {
    return { ok: false, baseURL, latencyMs: hit.ms, models: [], error: hit.error };
  }
  return { ok: true, baseURL, latencyMs: hit.ms, models: parseModels(hit.json) };
}
