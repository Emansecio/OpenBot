# T18 — Configuração local de provider na UI

> **Status atual (2026-08-12): documento histórico.** Este documento preserva o plano/design original. O estado executável atual está em [`../../phase-2-local-execution-progress.md`](../../phase-2-local-execution-progress.md) e no [`README`](../../../README.md).


## Estado descoberto

- O gateway local já expõe `getAvailableModels`, `getAgentDefaultModel`, `setAgentDefaultModel`, `getActiveProvider`, `setActiveProvider`, `getProviderConfig`, `setBoxSecrets` e `getBoxSecretsStatus`.
- O preload Electron já expõe `secrets.list/upsert/remove` e `agent.getDefaultModel/setDefaultModel/getAvailableModels`.
- O main Electron ainda resolve modelos via `fetchSandAvailableModels` e persiste default model via host settings.
- Não foi encontrado canal preload/main existente para `activeProvider` ou `getProviderConfig`.
- O renderer disponível é bundle compilado; não há fonte de UI correspondente no repositório.

## Decisão

Não inventar um canal IPC nem simular integração de UI sem fonte ou ponto de extensão verificável. A primeira fatia T18 deve alinhar contratos locais e adicionar testes; a integração visual fica bloqueada até existir fonte do renderer ou um ponto de extensão documentado.

## Critérios de aceite da fatia implementável

1. Configuração local de provider/modelo permanece persistente após restart.
2. Secrets usam somente API de nomes/status para leitura; valores nunca aparecem em resposta/log.
3. Provider/modelo inválidos são rejeitados pelo contrato local.
4. O fluxo RPC local pode executar: salvar secret → selecionar provider/modelo → obter configuração efetiva.
5. Testes cobrem persistência, validação e ausência de plaintext.
6. O bloqueio de UI é documentado, sem declarar o fluxo visual completo concluído.

## Fora desta fatia

- Rebuild do renderer compilado.
- Criação de canais Electron sem consumidor conhecido.
- Aceite com provider real (T19).
