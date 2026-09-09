# T13+T14 Config Roster Implementation Plan

> **Status atual (2026-08-12): documento histórico.** Este documento preserva o plano/design original. O estado executável atual está em [`../../phase-2-local-execution-progress.md`](../../phase-2-local-execution-progress.md) e no [`README`](../../../README.md).


> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Implementar configuração local persistente, agente default, roster, modelo/provider global, settings e stubs RPC.

**Architecture:** `ConfigStore` gerencia `openbot-config.json` com defaults, validação e gravação atômica. `RosterRpc` expõe as mesas T13/T14 e o `TurnRunner` resolve o provider/modelo dinamicamente a cada turno. O SQLite e a keystore permanecem separados.

**Tech Stack:** TypeScript, Node.js, better-sqlite3 já existente, Vitest, JSON local.

---

### Task 1: ConfigStore persistente

**Files:**
- Create: `src/config/store.ts`
- Create: `test/config-store.test.ts`

- [ ] Escrever testes para boot sem arquivo, defaults, restart, atualização de modelo/provider/settings e rejeição de JSON corrompido/versão desconhecida.
- [ ] Rodar `npm test -- --run test/config-store.test.ts` e confirmar falha por módulo ausente.
- [ ] Implementar `ConfigStore` com tipos `OpenBotConfig`, `LocalProfile`, `ConfigStoreOptions`, `defaultConfigPath` e defaults do fixture T13.
- [ ] Validar modelo/provider compatíveis contra `MODEL_CATALOG`; gerar `machineId` com UUID.
- [ ] Implementar `update`, `setGlobalModel`, `setActiveProvider`, `setHostSettings` e `snapshot`.
- [ ] Salvar atomicamente em arquivo temporário e rename; remover temporário no erro.
- [ ] Rodar os testes de config e build.

### Task 2: Roster e RPCs T13/T14

**Files:**
- Create: `src/rpc/roster.ts`
- Modify: `src/rpc/index.ts`
- Modify: `src/server/gateway.ts`
- Create: `test/roster.test.ts`

- [ ] Escrever testes unitários dos métodos de roster, modelos, settings, provider config e stubs.
- [ ] Adicionar todos os nomes RPC necessários à `RPC_METHOD_TABLE`.
- [ ] Implementar `RosterRpc` com agente único `openbot-default`, list/count/get/search/update.
- [ ] Implementar `get/setAgentDefaultModel`, `getAvailableModels`, `get/setActiveProvider`, `getProviderConfig` sem secrets.
- [ ] Implementar `get/setHostSettings` com merge parcial e persistência.
- [ ] Implementar forever-box, capabilities, flags e transcribe no-op com shapes do fixture.
- [ ] Validar corpos e converter entradas inválidas em `RpcError(400)`.
- [ ] Rodar testes unitários focados.

### Task 3: Resolver dinâmico e bootstrap

**Files:**
- Modify: `src/rpc/send.ts`
- Modify: `src/rpc/index.ts`
- Modify: `src/main.ts`
- Modify: `test/rpc-send.test.ts`
- Modify: `test/rpc-send-gateway.integration.test.ts`
- Modify: `test/bootstrap.test.ts`

- [ ] Escrever teste mostrando que alteração do modelo/provider muda o próximo request ao adapter sem restart.
- [ ] Expor `resolveProvider` baseado no ConfigStore no bootstrap e preservar overrides de teste.
- [ ] Criar/abrir ConfigStore em `startServer`, registrar RosterRpc e expor `config` no `ServerHandle`.
- [ ] Fechar ConfigStore em `stopServer` após o store SQLite.
- [ ] Testar restart preservando perfil/modelo/provider/settings e agente default.
- [ ] Rodar testes focados e corrigir regressões T10/T11.

### Task 4: Verificação final e documentação

**Files:**
- Modify: `README.md`

- [ ] Atualizar README com T13/T14 DONE e localização do JSON.
- [ ] Rodar `npm run build`.
- [ ] Rodar `npm test` completo.
- [ ] Fazer probe HTTP real das RPCs de roster/modelo/settings/stubs.
- [ ] Conferir que nenhuma API key aparece na configuração ou respostas de provider config.
- [ ] Remover arquivos temporários de teste e confirmar que não há `openbot-config.json` de execução no repositório.
