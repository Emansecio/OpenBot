# Plano T18 — Configuração local de provider/modelo na UI

> **Status atual (2026-08-12): documento histórico.** Este documento preserva o plano/design original. O estado executável atual está em [`../../phase-2-local-execution-progress.md`](../../phase-2-local-execution-progress.md) e no [`README`](../../../README.md).


## Objetivo

Permitir que o cliente local configure provider, modelo e secrets sem login Cursor, reutilizando os RPCs do gateway e os canais já expostos pelo preload, sem expor valores secretos.

## Critérios de aceite

1. `getBoxSecretsStatus`/`setBoxSecrets` continuam retornando somente nomes e metadados; nenhum valor secreto aparece em resposta, log ou transcript.
2. Provider ativo e modelo global são persistidos no `openbot-config.json` por meio dos handlers existentes.
3. A superfície Electron usa apenas canais existentes ou uma extensão explícita e documentada do preload; não são criados endpoints Cursor.
4. O seletor de modelos não depende de `fetchSandAvailableModels` remoto quando o gateway local está ativo.
5. Estados de conta Cursor e VNC permanecem ocultos/inertes no perfil local.
6. Build, suíte completa e testes específicos de contrato passam.

## Fases

### Fase 1 — Contratos e wiring local

- Confirmar `listAgents`, `getAvailableModels`, `getAgentDefaultModel`, `setAgentDefaultModel`, `getActiveProvider`, `setActiveProvider`, `getProviderConfig`, `setBoxSecrets` e `getBoxSecretsStatus`.
- Corrigir qualquer registro ausente no bootstrap do gateway.
- Garantir que `sendPrompt` resolve provider/modelo a partir do `ConfigStore` e do keystore.
- Adicionar testes que confirmem persistência e que respostas de secrets nunca contêm API keys.

### Fase 2 — Adapter Electron/preload

- Mapear os canais reais do preload e do main bundle.
- Se houver ponto de extensão seguro, fazer o canal de modelos usar catálogo local quando `OPENBOT_LOCAL_GATEWAY=1`.
- Expor provider ativo/configuração somente como metadados não secretos.
- Não alterar o renderer empacotado sem um ponto de integração verificável.

### Fase 3 — UI e bloqueios

- Se os assets do renderer contiverem uma superfície de settings reutilizável, aplicar patch mínimo e testável.
- Caso contrário, registrar bloqueio: sem fonte do renderer não há integração UI segura nesta wave; entregar contratos/backend e handoff para rebuild do renderer.
- Não simular aceite do fluxo visual.

### Fase 4 — Verificação

- `npm run build`
- `npm test`
- `node --check client/extracted/dist/electron-main/main.cjs`
- `node scripts/audit-local-client.cjs`
- testes específicos de provider/secrets/UI contract.

## Fora do escopo

- Chaves reais ou smoke test contra provider externo.
- Rebuild amplo do renderer.
- Login Cursor, VNC, updates ou telemetria.
- Aceite T19.
