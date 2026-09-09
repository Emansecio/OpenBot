# Conversas e memória durável por bot

**Data:** 18/08/2026  
**Status:** fechamento final consolidado.

## Comportamento consolidado

Cada bot mantém isolamento de conversa, transcript, memória e jobs por `agentId`.  
`createConversation()` cria e ativa o chat novo automaticamente.

Em **Settings → Memória**:

- `automatic`: reflexão após turno permanente.
- `explicit`: reflete apenas com intenção explícita do usuário.
- `off`: sem memória entre chats e sem `memory_search`.

Não há `pinned` automático; `trust:user` só por intenção explícita.
Reflexão suporta PT/ES/EN.

## Correções finais e comportamento de execução

- Jobs de memória de conversa arquivada são **cancelados/ignorados atômicamente**.
- Worker revalida conversa ativa antes de executar reflexão.
- Jobs com status não contabilizam conversas já arquivadas.
- `enqueueMemoryReflection` é idempotente e race-safe.
- Fila e estado de jobs/queue usam comportamento seguro para reentrada concorrente.
- Summaries de tools só entram por allowlist e sem argumentos, segredos ou caminhos (`path`) expostos.
- ACL compartilhada por raiz do runtime é serializada; falha de serialização é tratada como **fail-closed**.
- Testes de persistência validam redaction de resumos (`safe summaries`) para paths/secrets.

## Segurança e retenção

- Redaction de tokens, secrets, cookies, chaves, padrão `authorization` e caminhos de anexo antes de persistir.
- `deleteConversation` e exclusões de memória são atômicas (transação).
- FTS5 reconstruível com backfill incremental de migração de schema.
- `delete-derived`: remove memórias dependentes da conversa.
- `retain`: mantém memórias e summaries com marcação `retained`.
- Tool summaries de anexos são tratados sem expor payload/paths e sem segredos.

## Montagem de contexto e fluxo

O fluxo de contexto monta por orçamento:

1. memórias fixadas/relevantes  
2. resumo do chat atual  
3. trechos relevantes de outros chats  
4. mensagens recentes  
5. mensagem atual como último `user`

`memory_search` é read-only; retorno da tool limitado a **32 KiB**.
Follow-ups preservam resultados de tool-call e anexos para continuidade.
Contexto histórico é tratado como evidência não confiável; nunca vira instrução de sistema.

## RPC, ponte e estabilidade

Operações RPC de conversa/memória validam sender e bot ativo.  
Fallback local de settings permanece ativo.

## Evidências de gate

Arquivo de validação:

- `npm run verify:bot-memory`
- `npm run verify:client-artifacts`
- `npm run verify:memory-flow-e2e`
- `node scripts/bridge-real-verify.mjs`

Estado de fechamento:

- `verify:bot-memory`: **7 arquivos / 100 testes**
- `CLIENT_ARTIFACTS_GREEN`
- `BRIDGE_REAL_GREEN` (`logs/bridge-real-verify-eB4r3l/`)
- `MEMORY_FLOW_E2E_GREEN` (`logs/memory-flow-e2e-SxUjCk/`)
- `VISUAL_UI_GATE_GREEN` (`logs/visual-ui-verify-BaUhGs/`)
- `Skills/MCP 164/164`
- `Core 3/3`
- `desktop e2e green` (`logs/e2e-desktop/run-20260818-221145-126260/`)
- Browser **17/17**
- WSL live green

Resultados agregados de suíte:

- **103 arquivos, 1187 pass, 1 skipped, 0 failures** (serial).
- `bench`: hot paths em estado verde conforme relatório interno.
- Smoke local com `turn1/reflection1`: verde.

## Limitações

- Sem provider comercial externo no ciclo atual.
- `OpenAiCompatAdapter` usado localmente por HTTP/SSE com fixture local para E2E.
- Sem banco vetorial; recuperação por FTS5.
