# OpenBot — correção da auditoria de persistência e lifecycle

**Data:** 17/08/2026  
**Status:** correções implementadas; aceite absoluto de 100/100 retirado.

> Este relatório preserva a rodada de correção. O baseline e os comandos atuais estão no [runbook de recuperação e prontidão](openbot-recovery-readiness-2026-08-17.md).

## Motivo da retificação

A nota anterior de 100/100 foi incorreta: ela transformou gates conhecidos em uma garantia absoluta. Uma revisão posterior encontrou dez falhas reproduzíveis de concorrência, identidade persistida, compensação e teardown. O resultado correto deve separar evidência executada de confiança estimada.

## Falhas confirmadas e correções

1. Criações concorrentes com o mesmo ID podiam quarentenar a home vencedora. A criação agora é serializada por ID e revalida duplicidade dentro da região crítica.
2. Cancelamento posterior ao commit podia registrar uma ação concluída como abortada. O resultado da execução é publicado antes de observar o cancelamento tardio.
3. Um card de aprovação com ID colidente podia substituir a linha errada do transcript. A substituição agora usa `localToolCallId` exato no SQLite e no store em memória.
4. IDs brutos reutilizados pelo provider em turnos diferentes podiam compartilhar decisão de aprovação. A identidade de execução e aprovação agora inclui o ID do turno.
5. O mesmo `AbortSignal` cancelado era reutilizado na limpeza/rollback WSL. Trabalho compensatório agora usa um sinal independente.
6. `RuntimeManager.close()` não permitia retry depois de falha ao liberar lease. O encerramento mantém o fence, preserva leases não liberados e permite nova tentativa.
7. Um teardown antigo do browser podia apagar o perfil de uma nova lease do mesmo bot. Acquire e teardown agora são serializados por agente.
8. O inventário de home usava limite de entradas inferior à quota permitida. Os defaults agora derivam da mesma quota.
9. O marker de quarentena podia ser observado parcialmente gravado. A publicação agora usa arquivo temporário sincronizado e link atômico sem sobrescrita.
10. Diferença apenas de capitalização no ID podia impedir restore/ensure no Windows. Comparações de identidade persistida agora são case-insensitive.

## Regressões adicionadas

- create concorrente do mesmo ID;
- restore com capitalização equivalente e marker sem temporário residual;
- colisão entre tool-call e card de aprovação;
- reutilização de ID do provider entre turnos;
- cancelamento depois do commit;
- cleanup WSL depois de abort;
- retry de `close()` após falha;
- acquire do browser durante teardown do mesmo agente;
- alinhamento entre quota e inventário;
- fluxo integrado da aprovação com request ID por turno.

## Evidência executada

- `npm run typecheck`: GREEN.
- bloco focado: **9 arquivos, 146 testes, 0 falhas**.
- integração de aprovação após ajuste: **3 arquivos, 24 testes, 0 falhas**.
- a primeira repetição da suíte integral encontrou um teste integrado desatualizado, que ainda esperava o ID bruto do provider; o teste foi corrigido para validar e usar a identidade pública por turno.
- uma repetição posterior revelou flake do harness quando `fetch` recebeu do sistema uma porta aleatória bloqueada pela lista de portas inseguras do Node. O helper do teste passou a usar HTTP nativo; o cenário passou três vezes consecutivas.
- repetição integral final: **89 arquivos aprovados, 955 testes aprovados, 1 ignorado, 0 falhas**.
- não se deve inferir 100/100 apenas desses gates: eles comprovam os cenários exercitados nesta versão e ambiente.

## Regra de prontidão corrigida

O projeto pode ser chamado de pronto para uso local somente quando os gates relevantes estiverem verdes. Isso não equivale a ausência universal de bugs. A nota 100/100 fica proibida sem uma matriz finita de critérios explicitamente delimitada; para o produto como um todo, deve-se informar o estado dos gates e os riscos residuais.
