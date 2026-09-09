# T13+T14 — Roster, catálogo, settings e configuração local

> **Status atual (2026-08-12): documento histórico.** Este documento preserva o plano/design original. O estado executável atual está em [`../../phase-2-local-execution-progress.md`](../../phase-2-local-execution-progress.md) e no [`README`](../../../README.md).


## Objetivo

Adicionar a mesa RPC local necessária para o OpenBot operar com um agente default, catálogo estático de modelos, provider/modelo global, capabilities/stubs locais e configuração persistente em `openbot-config.json`.

A interface original não será inicializada nesta etapa; o escopo é a superfície RPC testável e pronta para a integração posterior da UI.

## Arquitetura

`src/config/store.ts` será responsável por carregar, validar, normalizar, migrar e salvar atomicamente a configuração local. O JSON vive separado do `store.db`, que continua responsável pelo transcript e ledger.

`src/rpc/roster.ts` implementará o agente default e as mesas de roster, modelos, settings e capabilities. `src/rpc/index.ts` somente registrará essas mesas junto das rotas T10/T11.

O `TurnRunner` receberá um resolver dinâmico de provider/modelo, consultando a configuração a cada turno. Assim, alterar provider ou modelo afeta o próximo `sendPrompt` sem reiniciar o processo.

## Configuração persistida

Formato versão 1:

```json
{
  "version": 1,
  "profile": {
    "name": "Local User",
    "avatarId": "openbot-default",
    "machineId": "..."
  },
  "activeProvider": "xai",
  "globalModel": "grok-4.5",
  "hostSettings": {
    "timezone": "America/Sao_Paulo",
    "pinnedAgents": [],
    "sidebarSections": [],
    "autoReviewEnabled": false,
    "localToolPermission": "ask"
  },
  "flags": {
    "isAgentNetworkEnabled": false,
    "isGlobalSearchEnabled": true,
    "isEgressTunnelAvailable": false
  }
}
```

O diretório default é `%APPDATA%\\OpenBot\\`; testes poderão injetar um arquivo/caminho. Ausência do arquivo cria defaults. JSON corrompido ou versão desconhecida impede o boot com erro claro.

Escritas usam arquivo temporário e rename/substituição atômica. O temporário é removido no caminho de erro.

O `machineId` será gerado uma vez com UUID local e não conterá credenciais.

## Regras de validação

- `globalModel` deve existir no catálogo estático.
- `activeProvider` deve ser um provider suportado.
- provider ativo e modelo global devem ser compatíveis.
- settings parciais fazem merge e preservam campos ausentes.
- nenhuma configuração ou rota retorna valores de API keys.
- mudanças são persistidas antes da resposta de sucesso.

## RPCs

### Roster

- `listAgents`
- `countAgents`
- `getAgent`
- `searchAgents`
- `updateAgent`

Há exatamente um agente default: `openbot-default`. Nome e avatar são persistidos no config.

### Modelos e provider

- `getAvailableModels` → catálogo estático local.
- `getAgentDefaultModel` → modelo global atual.
- `setAgentDefaultModel` → valida, persiste e sincroniza provider compatível.
- `getActiveProvider` / `setActiveProvider` → provider global com validação.
- `getProviderConfig` → provider, modelo e baseURL configurada; nunca secrets.

### Settings e capabilities

- `getHostSettings` / `setHostSettings`.
- `getForeverBoxStatus` → `{vncUrl:null, windows:[]}`.
- `ensureForeverBox` / `handBackForeverBox` → `{ok:true}`.
- `isAgentNetworkEnabled` → `false`.
- `isGlobalSearchEnabled` → `true`.
- `isEgressTunnelAvailable` → `false`.
- `getComputerCapabilities` → capacidades locais limitadas sem execução remota.
- `transcribeAudio` → no-op explícito.

Corpos inválidos retornam `RpcError(400)`. Falhas de persistência retornam HTTP 500 sem expor caminhos ou conteúdo interno.

## Integração

`startServer` abrirá o config store, registrará as novas rotas e injetará o resolver dinâmico no `TurnRunner`. O `ServerHandle` exporá o config store e o fechará no shutdown.

O bootstrap continuará abrindo o SQLite T11 e a keystore T4 separadamente.

## Testes

- boot limpo cria defaults;
- restart preserva nome, avatar, modelo, provider e settings;
- modelo/provider inválidos são rejeitados;
- merge parcial de settings;
- roster/list/count/search/update;
- catálogo e provider config sem secrets;
- stubs de forever-box, capabilities e transcribe;
- próximo `sendPrompt` usa modelo/provider alterados;
- JSON corrompido e versão desconhecida rejeitam boot;
- escrita atômica remove temporário em sucesso/erro.

Aceite:

```text
npm run build
npm test
```
