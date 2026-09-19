# Retenção de memória: tombstones permanentes (F-10/F-16)

## Invariante

`memory_forget` é um **tombstone lógico, não uma deleção física**. A memória
permanece no SQLite com status `forgotten`; ela deixa de aparecer no contexto,
em `memory_search` e na reflexão, mas o registro **não é apagado**.

Esse comportamento é obrigatório, não um acidente de implementação:

- `forgottenSources()` (`src/memory/sqlite-store.ts`) reconstrói o estado
  anti-recall percorrendo `memory_revisions` — incluindo revisões de memórias
  esquecidas e de seus descendentes superseded. Apagar o histórico de revisões
  faria fontes esquecidas voltarem a ser elegíveis como evidência.
- Qualquer retenção/prune geral que remova linhas de `memory_revisions` quebra
  essa garantia. Prune existe apenas para a fila de jobs (`memory_jobs` dead
  há mais de 7 dias), que não carrega conteúdo de memória.

## Regras vigentes

1. Nunca apagar linhas de `memory` ou `memory_revisions` como rotina de
   retenção. Uma política de retenção que precise remover essas linhas exige
   redesenhar o ledger anti-recall primeiro.
2. Texto exposto ao usuário/modelo deve dizer que a memória foi **esquecida /
   excluída do recall**, nunca "apagada permanentemente".
3. `delete-derived` na exclusão de conversa remove memórias derivadas — esse
   é o único caminho de remoção física e é explícito por escopo de conversa,
   não uma rotina temporal.

## Verificação

- `test/memory-core.test.ts` cobre `forgottenSources()` atravessando revisões
  superseded e esquecidas.
- `npm run verify:bot-memory` executa os gates de memória.
