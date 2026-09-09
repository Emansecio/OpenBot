# OpenBot — Programa de otimização dos 16 achados

**Data:** 2026-08-14  
**Status:** design aprovado para especificação  
**Origem:** `analysis_outputs/SUMMARY.md`  
**Compatibilidade:** contratos RPC/SSE atuais preservados  
**Entrega:** quatro ondas incrementais, sempre testáveis

## Objetivo

Implementar os 16 achados da auditoria de performance e qualidade sem substituir SQLite, sem quebrar o cliente Electron atual, sem apagar a árvore forense em `client/` e sem introduzir serviços externos.

## Decisões aprovadas

1. Eventos existentes (`snapshot`, `appended`, `updated`) mantêm seus shapes. Os snapshots redundantes do início do turno e da conclusão de tools serão removidos; envelopes, nomes e payloads dos eventos restantes não mudam.
2. O estado de resposta live fica em memória; SQLite recebe início, checkpoints de no mínimo 1 segundo e finalização.
3. Atualizações completas compatíveis com o renderer são publicadas no máximo a cada 100 ms.
4. Uma resposta live é limitada a 192 KiB para ficar abaixo do frame SSE de 256 KiB.
5. O contexto passa a ser limitado por tokens, não por número fixo de mensagens.
6. Anexos: máximo 8 por turno, concorrência 4 e leitura limitada antes da alocação.
7. Tool/search output: máximo 128 KiB com marcador de truncamento.
8. Retry: até 2 novas tentativas, apenas antes do primeiro delta/tool call.
9. Timeouts default: conexão 30 s, inatividade 120 s e total 300 s.
10. Avatares base64 legados migram de forma idempotente para arquivo e só são removidos do config após escrita bem-sucedida.
11. A árvore `client/` original permanece intacta; o pacote limpo é uma cópia nova.
12. Cada mudança de comportamento segue teste vermelho → implementação mínima → verde.

## Decomposição

1. [`2026-08-14-openbot-transcript-streaming-optimization-design.md`](2026-08-14-openbot-transcript-streaming-optimization-design.md)
2. [`2026-08-14-openbot-context-execution-optimization-design.md`](2026-08-14-openbot-context-execution-optimization-design.md)
3. [`2026-08-14-openbot-provider-config-optimization-design.md`](2026-08-14-openbot-provider-config-optimization-design.md)
4. [`2026-08-14-openbot-build-performance-design.md`](2026-08-14-openbot-build-performance-design.md)

## Cobertura dos 16 achados

| Achado | Onda | Resultado exigido |
|---|---|---|
| OB-PERF-01 | 1 | remover snapshots integrais do hot path e impedir frames acima do teto |
| OB-PERF-02 | 1 | separar atualização live de persistência durável |
| OB-PERF-03 | 1 | queries limitadas para contexto/preview/tools |
| OB-PERF-04 | 4 | substituir `Array.shift()` por fila com cursor |
| OB-PERF-05 | 1 | cachear statements e podar nonces em uma query |
| OB-PERF-06 | 2 | limitar arquivo antes da leitura e agregar limites de anexos |
| OB-PERF-07 | 2 | budget único para histórico/anexos/tool output |
| OB-PERF-08 | 2 | concorrência limitada para busca e lotes read-only |
| OB-PERF-09 | 3 | timeout `ETIMEDOUT` e retry seguro |
| OB-PERF-10 | 3 | transporte OpenAI-like compartilhado |
| OB-PERF-11 | 3 | selectors/revisão, identidade por turno e avatar fora do JSON |
| OB-QUALITY-01 | 3 | capabilities reais e remoção de parâmetros cosméticos |
| OB-PERF-12 | 2 | descoberta local paralela |
| OB-BUILD-01 | 4 | pacote runtime limpo em nova árvore |
| OB-BUILD-02 | 4 | builds dev/prod separados |
| OB-PERF-13 | 4 | suíte de regressão de performance |

## Ordem e dependências

- Onda 1 cria as APIs limitadas de transcript usadas pela Onda 2.
- Onda 2 cria `ContextBudget`, consumido pela Onda 3 para `maxTokens` e capabilities.
- Onda 3 estabiliza provider/config antes do smoke de pacote da Onda 4.
- A Onda 4 encerra com verificação integral e relatório de métricas.

## Invariantes globais

- Nenhum retry após saída observável.
- Nenhuma tool mutável executada em paralelo.
- Nenhum corte de contexto no meio de uma sequência assistant-tool/tool-result.
- Nenhuma truncagem silenciosa.
- Nenhuma migração remove o dado legado antes de confirmar o novo dado.
- Nenhum script de pacote modifica `client/`.
- Nenhum teste de performance depende de sleeps reais ou limites frágeis de milissegundos.

## Verificação final

```bash
npx tsc -p tsconfig.json --noEmit
npm test -- --reporter=dot
npm run build:prod
npm run smoke:local
npm run package:runtime -- --out <diretorio-temporario>
```

O programa está aceito quando todos os testes existentes e novos passam, os budgets estruturais são respeitados e o pacote temporário não contém os artefatos proibidos.