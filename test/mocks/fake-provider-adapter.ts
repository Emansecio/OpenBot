/**
 * T5 — Adapter FAKE de teste para o roteador (src/providers/router.ts).
 *
 * NENHUM adapter concreto vive no router (isso é T6+); este fake implementa o
 * contrato `ProviderAdapter` em memória para os unit tests do roteador:
 *   - emite deltas na ordem configurada (simula o SSE do provider);
 *   - opcionalmente emite tool-calls/tool-results;
 *   - opcionalmente lança um erro (para testar o mapeamento transiente vs
 *     permanente);
 *   - respeita `req.signal`: abort dispara `AbortError` — igual ao fetch de
 *     um adapter real quando o consumidor cancela o turno.
 *
 * O mock vive em test/mocks/ e NÃO casa com o `include` do vitest.config.ts
 * (`test/**\/*.test.ts`), então não roda como suíte — é importado pelos testes
 * do roteador (test/router.test.ts).
 */

import type { ProviderAdapter, ProviderChatRequest, ProviderStreamEvent } from "../../src/providers/router.js";

/** Cenário de comportamento do fake: o que ele "streama" por turno. */
export interface FakeStreamScript {
  /** Deltas de texto emitidos em sequência (cada um = um frame SSE do provider). */
  deltas?: string[];
  /** Tool calls emitidas (entre os deltas, na ordem em que aparecem no array). */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments?: string;
  }>;
  /** Tool results emitidos (espelham os tool_calls do provider). */
  toolResults?: Array<{
    toolCallId: string;
    content: string;
  }>;
  /** Erro a lançar do stream (simula falha do transporte/HTTP do provider). */
  error?: unknown;
  /** Nome do erro (AbortError para simular cancelamento). */
  errorName?: string;
  /** ms de atraso entre deltas (default 0 — síncrono, determinístico). */
  deltaDelayMs?: number;
}

/** Registro de invocações do fake (asserções nos testes). */
export interface FakeInvocation {
  req: ProviderChatRequest;
  deltasEmitted: string[];
  toolCallsEmitted: number;
  toolResultsEmitted: number;
  aborted: boolean;
}

export interface FakeProviderAdapterOptions {
  name?: string;
  script?: FakeStreamScript;
}

/** Adapter fake do roteador (T5 — teste). */
export class FakeProviderAdapter implements ProviderAdapter {
  readonly name: string;
  readonly script: FakeStreamScript;
  readonly invocations: FakeInvocation[] = [];
  /** Instância do AbortController criada para o último turno (para aborts manuais). */
  lastController: AbortController | null = null;

  constructor(opts: FakeProviderAdapterOptions = {}) {
    this.name = opts.name ?? "fake";
    this.script = opts.script ?? {};
  }

  /** Aborta o último turno como o consumidor faria (encerra o stream). */
  abort(): void {
    this.lastController?.abort();
  }

  async streamChat(
    req: ProviderChatRequest,
    emit: (event: ProviderStreamEvent) => void,
  ): Promise<void> {
    const controller = new AbortController();
    this.lastController = controller;

    const invocation: FakeInvocation = {
      req,
      deltasEmitted: [],
      toolCallsEmitted: 0,
      toolResultsEmitted: 0,
      aborted: false,
    };
    this.invocations.push(invocation);

    // Abort do consumidor chegando ANTES do stream começar.
    if (req.signal?.aborted) {
      const err = new Error("fake: aborted before start");
      err.name = "AbortError";
      throw err;
    }

    const waitForDelay = (milliseconds: number): Promise<void> => {
      const signal = req.signal;
      if (signal === undefined) {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
      }
      return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          if (error === undefined) resolve();
          else reject(error);
        };
        const onAbort = () => {
          invocation.aborted = true;
          const error = new Error("fake: aborted");
          error.name = "AbortError";
          finish(error);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        else timer = setTimeout(() => finish(), milliseconds);
      });
    };
    // Pipeline: intercala deltas com tool-calls na ordem dos scripts.
    const pipeline: Array<
      | { kind: "delta"; text: string }
      | { kind: "tool-call"; id: string; name: string; arguments: string }
      | { kind: "tool-result"; toolCallId: string; content: string }
    > = [];
    const deltas = this.script.deltas ?? [];
    for (let i = 0; i < deltas.length; i++) {
      pipeline.push({ kind: "delta", text: deltas[i] ?? "" });
    }
    for (const tc of this.script.toolCalls ?? []) {
      pipeline.push({
        kind: "tool-call",
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments ?? "{}",
      });
    }
    for (const tr of this.script.toolResults ?? []) {
      pipeline.push({ kind: "tool-result", toolCallId: tr.toolCallId, content: tr.content });
    }

    for (const step of pipeline) {
      if (req.signal?.aborted) {
        invocation.aborted = true;
        const err = new Error("fake: aborted mid-stream");
        err.name = "AbortError";
        throw err;
      }
      switch (step.kind) {
        case "delta":
          invocation.deltasEmitted.push(step.text);
          emit({ type: "delta", delta: step.text });
          break;
        case "tool-call":
          invocation.toolCallsEmitted++;
          emit({
            type: "tool-call",
            call: { id: step.id, type: "function", function: { name: step.name, arguments: step.arguments } },
          });
          break;
        case "tool-result":
          invocation.toolResultsEmitted++;
          emit({ type: "tool-result", result: { toolCallId: step.toolCallId, content: step.content } });
          break;
      }
      // Erro programado: lança DEPOIS de emitir o passo — simula o provider que
      // streama conteúdo parcial e então falha (429/5xx/4xx no meio do SSE).
      if (this.script.error) {
        throw this.script.error;
      }
      if (this.script.deltaDelayMs && this.script.deltaDelayMs > 0) {
        await waitForDelay(this.script.deltaDelayMs);
      }
    }
  }
}

/** Conveniência: cria um fake registrado (ex.: provider "fake"). */
export function createFakeAdapter(name = "fake", script: FakeStreamScript = {}): FakeProviderAdapter {
  return new FakeProviderAdapter({ name, script });
}
