/**
 * T7 — Adapter xAI/Grok (plano §3 T7; spec §3.1/§3.2).
 *
 * API OpenAI-compatible em `https://api.x.ai/v1` (endpoint
 * `POST /v1/chat/completions` com `stream:true` e parâmetro `tools` opcional —
 * mesmo wire format do T6). O modelo default do PRODUTO (`grok-*`) é o default
 * do catálogo estático (src/config/models.ts — "Modelo default do produto").
 *
 * O adapter REUSA 100% dos helpers compartilhados de T6
 * (src/providers/openai-helpers.ts):
 *   - `buildChatBody` — corpo JSON do chat.completions (system inline + tools
 *     + temperature + max_tokens);
 *   - parser SSE linha-a-linha + `OpenAiToolCallAccumulator` — normalização
 *     de tool calls fragmentadas;
 *   - `normalizeOpenAiError` + `extractOpenAiErrorMessage` — erros de
 *     transporte/HTTP normalizados para o `classifyProviderError` do roteador
 *     (429/5xx/rede = transiente; 4xx auth/validação = permanente).
 *
 * Em vez de duplicar a implementação do T6, o adapter xAI HERDA de
 * `OpenAiAdapter` (a classe é a "base comum" dos adapters OpenAI-like) e
 * apenas fixa o nome do provider e a base URL:
 *   - name: "xai" (registry do roteador — contrato ProviderAdapter de T5);
 *   - baseUrl: `https://api.x.ai/v1` (API OpenAI-compatible da xAI).
 *
 * A chave de API é resolvida via keystore com namespace
 * `scoped:v1:provider:xai:apiKey` (T4) — `reveal`, nunca lida de config/env.
 * O construtor aceita `apiKey`/`keystore`/`baseUrl` (override para o mock de
 * teste) e `fetchImpl` injetável — mesmas opções do OpenAiAdapter.
 */

import { OpenAiAdapter, type OpenAiAdapterOptions } from "./openai.js";
import { defaultRegistry } from "./router.js";

/** Nome canônico do provider no registry e no namespace da keystore. */
export const XAI_PROVIDER_NAME = "xai" as const;

/** Endpoint default da xAI — API OpenAI-compatible (plano §3 T7). */
export const XAI_API_BASE_URL = "https://api.x.ai/v1" as const;

/** Chave da keystore: `scoped:v1:provider:xai:apiKey` (T4). */
export function xaiApiKeyKey(): string {
  return `scoped:v1:provider:${XAI_PROVIDER_NAME}:apiKey`;
}

export interface XaiAdapterOptions extends OpenAiAdapterOptions {
  /** Força o nome do provider como "xai" (baseUrl/apiKey/keystore seguem o OpenAiAdapter). */
  name?: string;
}

/**
 * Adapter xAI/Grok (chat.completions stream) — implementa `ProviderAdapter`
 * herdando a base OpenAI-like de T6 (wire format idêntico; apenas nome + base
 * URL trocam). `streamChat` emite `delta` e `tool-call` e resolve ao fim do
 * stream; erros são lançados e o roteador os converte em evento `error`
 * (nunca lança para o consumidor final).
 */
export class XaiAdapter extends OpenAiAdapter {
  constructor(opts: XaiAdapterOptions = {}) {
    // Nome fixo "xai" — a base (OpenAiAdapter) usa opts.name ?? "openai".
    // A API xAI aceita `reasoning_effort` no chat.completions para modelos de
    // raciocínio; o envio fica restrito a esforços declarados no catálogo.
    super({
      ...opts,
      name: opts.name ?? XAI_PROVIDER_NAME,
      baseUrl: opts.baseUrl ?? XAI_API_BASE_URL,
      reasoningEffortPolicy: opts.reasoningEffortPolicy ?? "declared",
    });
  }
}

/**
 * Registra o adapter xAI no registry default do roteador como "xai"
 * (contrato `ProviderRegistry.register` de T5). Retorna a instância criada.
 * Chamado no boot (T7 — main.ts, mesmo padrão do registerOpenAiAdapter) e
 * pelos testes.
 */
export function registerXaiAdapter(opts: XaiAdapterOptions = {}): XaiAdapter {
  const adapter = new XaiAdapter(opts);
  defaultRegistry.register(adapter);
  return adapter;
}
