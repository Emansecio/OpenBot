# Tool-call lifecycle no transcript

> **Status:** aprovado para implementação (2026-08-13).
> **Ação:** o card `kind:"tool-call"` no chat reflete a execução real na home.

## Problema

O contrato já tem `status: pending | running | completed | failed`. O runner publica `completed` no instante em que o modelo *pede* a tool, antes de executar. O resultado não entra no card. A UI do Grok Bot renderiza o card, mas não vê o computador trabalhar.

## Decisão

Uma entry por `call.id`. Persistida uma vez, atualizada no lugar.

| Momento | Status | SSE |
|---|---|---|
| modelo emite `tool-call` e há broker | `pending` | `appended` |
| broker vai executar (request válido) | `running` | `updated` |
| `ExecutionResult.ok` | `completed` + `result` | `updated` + `snapshot` |
| falha / shell / parse / teto de rodadas | `failed` + `result` | `updated` + `snapshot` |
| sem broker (chat-only) | `completed` como hoje | `appended` |

`snapshot` após update: a UI que só conhece `snapshot`/`appended` recarrega o tail e vê **um** card no estado final. `updated` é extra para clientes que upsertam por `id`.

## Shape

```ts
{
  kind: "tool-call",
  id: string,          // id da tool call do provider
  name: string,
  summary: string,     // "write Documents/nota.md" — sem path absoluto
  status: "pending" | "running" | "completed" | "failed",
  result?: {
    ok: boolean,
    operation?: string,
    code?: string,
    message?: string,
    bytes?: number,
    path?: string,     // relativo
    count?: number,
    command?: string,
    exitCode?: number | null
  }
}
```

Campos novos cabem no `[key: string]: unknown` já existente. Sem path absoluto, sem dump de disco.

## Store

`TranscriptStore.replace(agentId, entryId, entry): boolean` — atualiza o JSON da row com aquele `entry_id`. SQLite e memória. Sem row → `false` (caller faz append).

## Fora de escopo

Tela nova, Explorer, VNC, `shell` real, segundo agente, helper nativo de junction.

## Aceite

- Prompt com write real: um card `pending` → `running` → `completed`, arquivo existe, `result.path` relativo.
- Escape `..\\` → um card `failed`, alvo de fora intacto.
- Restart: `getAgentTranscriptTail` devolve o card final (`completed`/`failed`), não três cópias.
- Chat-only (sem broker) continua publicando um `tool-call` `completed` (regressão T10).
- `npm test` e `npm run build` verdes.
