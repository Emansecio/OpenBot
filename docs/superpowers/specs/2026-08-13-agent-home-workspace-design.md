# Agent Home — computador local por agente

> **Status:** implementado (2026-08-13); estado vivo em 2026-08-14.
> **Leitor:** engenheiro do OpenBot.
> **Nota:** o slice original falava em um agente só. O runtime atual cria home para **cada** `agentId` em `createAgent` / `duplicateAgent` / `ensureForeverBox`. O plano em `docs/superpowers/plans/2026-08-13-agent-home-workspace.md` é histórico.

Substitui o forever-box remoto (VM Linux + VNC em `*.cursorvm.com`) por uma home NTFS privada por `agentId`, criada sozinha no boot, sem wizard, sem feature do Windows e sem tela nova.

## 1. Decisão

O computador de cada bot é uma pasta isolada:

```
%LOCALAPPDATA%\OpenBot\workspaces\<agentId>\
```

Não é VM, WSL, Hyper-V, Windows Sandbox, AppContainer nem o home do usuário. É o `WorkspaceSandbox` que a Fase 2 já tem, com um root por agente e layout de “casa” semeado uma vez.

A UI do Grok Bot não muda: o usuário abre o app e conversa. O boot de `startServer` e o RPC `ensureForeverBox` materializam essa pasta. `probeBox` **não existe** no gateway local (fora deste slice). `getForeverBoxStatus` continua no contrato congelado `{ vncUrl: null, windows: [] }`. A tela VNC permanece oculta (decisão §8.4).

## 2. Regras de produto (não negociáveis neste slice)

1. **Zero burocracia.** Nenhum picker de pasta, nenhum “habilite o WSL”, nenhum card pedindo permissão para o bot escrever na própria home.
2. **Tudo interno.** O processo cria a home. O usuário não configura workspace.
3. **Frontend igual ao Grok Bot.** Chat, cards de tool, roster nativo (New chat / Create new Bot). Sem tela de “computador”, sem Explorer obrigatório, sem onboarding extra.
4. **Windows-only e local.** Paths com semântica win32. Sem Linux guest.
5. **Identidade por bot.** Arquivos do agente A nunca são visíveis no root do agente B.
6. **Disco do usuário fica de fora.** `C:\`, UNC, home do Windows e junctions para fora são recusa do sandbox. Grant futuro para pasta do usuário é outro slice.
7. **Sem shell.** Schemas publicados: `file`, `search_files`, `search_text`. `shell` continua recusado em `tool-request`.
8. **`/local-exec/*` continua 501.** Execução só pelo tool loop do turn runner.

## 3. Layout no disco

Criado por `AgentHomeStore.ensure(agentId)` de forma idempotente:

```
<workspacesRoot>\<agentId>\
  Desktop\
    Bem-vindo.md
  Documents\
  Downloads\
  Projects\
  .openbot\
    home.json
```

`home.json`:

```json
{
  "agentId": "openbot-default",
  "createdAt": "2026-08-13T00:00:00.000Z",
  "layoutVersion": 1
}
```

Regras de seed:

- cria o root do agente e as quatro pastas + `.openbot` se faltarem;
- escreve `home.json` só se não existir;
- escreve `Desktop/Bem-vindo.md` só se não existir;
- nunca apaga nem sobrescreve arquivo do bot num `ensure` seguinte;
- se `home.json` existir com `agentId` diferente do pedido, falha com erro claro (pasta reutilizada);
- se `home.json` existir e não for JSON válido, ou não tiver `agentId` string, falha com erro claro (não reseed silencioso);
- se `layoutVersion` for menor ou uma pasta do layout faltar, só completa diretórios em falta (nunca apaga arquivos).

`workspacesRoot` default: `%LOCALAPPDATA%\OpenBot\workspaces` (fallback `homedir()/AppData/Local/OpenBot/workspaces`). Workspace é Local, não Roaming: não viaja no perfil e não infla backup.

Config, keystore e `store.db` continuam em `%APPDATA%\OpenBot\`. Transcript já é particionado por `agentId` no SQLite; este slice não mexe no schema do banco.

## 4. Identidade do `agentId` no filesystem

`sanitizeAgentId` aceita só `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$` e rejeita nomes de dispositivo Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), inclusive com extensão.

O default do roster continua `openbot-default`. Exportar essa constante de `roster.ts` e usá-la no bootstrap. O store é genérico: qualquer id válido ganha uma home. A UI nativa lista todos os agentes do config.

## 5. Isolamento e segurança

Reusa `WorkspaceSandbox` sem relaxar regras:

- paths relativos ao root da home;
- bloqueio de `..`, absoluto, UNC, ADS, device names, trailing dot/space;
- containment case-insensitive;
- o **pai** `workspacesRoot` não é um `WorkspaceSandbox`: só `mkdir` + recusa se **ele mesmo** for junction/symlink;
- a home do agente (`...\workspaces\<agentId>`) é o sandbox; ancestrais do SO (`AppData\Local` redirecionado) são permitidos (`allowAncestorLinks`); o leaf da home não pode ser link;
- symlink e junction recusados em todo path resolvido **dentro** da home;
- tetos existentes: 1 MiB por arquivo, 1000 entries em list, limites de busca, 3 rodadas de tool.

O backend composto (`HomeWorkspaceBackend`) roteia `file.*` para `LocalFileExecutor` e `command.run` (`search.files` / `search.text`) para `LocalCommandExecutor`, os dois sobre o **mesmo** `WorkspaceSandbox`.

Cache: um backend por `agentId` dentro do processo. `backendFor(agentId)` chama `ensure` na primeira vez.

## 6. Permissão

O broker da home mapeia `ask` → `always` (zero card na própria home) e honra `never` como kill-switch. O default novo de `hostSettings.localToolPermission` é `always`. JSON antigo com `ask` executa sem perguntar.

O broker de produção aceita os ids de `config.agents` (fallback: `openbot-default`). `createAgent` / `duplicateAgent` chamam `homes.ensure`. `sendPrompt` com id desconhecido não materializa pasta.

Rede da tool e `shell` continuam bloqueados na tradução, não na política de aprovação.

## 7. Módulos

| Módulo | Responsabilidade |
|---|---|
| `src/execution/home.ts` | `defaultWorkspacesRoot`, `sanitizeAgentId`, `AgentHomeStore.ensure` / `pathFor` / `backendFor`, seed, manifesto |
| `src/execution/home-backend.ts` | `HomeWorkspaceBackend` (composite `ExecutionBackend`) |
| `src/execution/home-tools.ts` | `SAFE_HOME_TOOLS` e `HOME_SYSTEM_PROMPT` |
| `src/execution/broker.ts` | aceitar `ExecutionBackend` **ou** `(agentId) => backend` (síncrono ou Promise). Instância única continua válida — testes atuais não quebram |
| `src/execution/commands.ts` | `fromWorkspace(sandbox)` para não reabrir o sandbox |
| `src/rpc/roster.ts` | `ensureForeverBox` chama `homes.ensure`; exporta `DEFAULT_AGENT_ID` |
| `src/rpc/send.ts` | sem mudança; já aceita `systemPrompt` injetado |
| `src/main.ts` | no boot padrão: cria store, `ensure("openbot-default")`, injeta broker + schemas + `DEFAULT_SYSTEM_PROMPT` + `HOME_SYSTEM_PROMPT`. Sem isso o app volta a ser chat-only |

Contratos HTTP de `SandForeverBoxStatus` **não mudam**. Campos extras no status são proibidos neste slice (fixture golden + decisão §8.4).

`ExecutionBackend.execute` continua sem `agentId`. O roteamento por agente mora no broker via fábrica.

## 8. Bootstrap

`startServer` ganha:

- `workspacesRoot?: string` — override de teste (obrigatório em teste; produção omite e usa `%LOCALAPPDATA%`);
- `disableAgentHome?: boolean` — hatch de teste para chat-only;
- `homes?: AgentHomeStore` — injeção;
- `systemPrompt?: (agentId: string) => string` — override; default na home é prompt base + `HOME_SYSTEM_PROMPT`.

Comportamento default (`disableAgentHome` ausente/false):

1. abre `AgentHomeStore` no root default ou injetado;
2. `ensure(DEFAULT_AGENT_ID)` **antes** de `listen` — se o disco falhar, o boot falha com erro claro;
3. se o chamador **não** passou `executionBroker`, cria `createAgentHomeBroker(homes)` e `SAFE_HOME_TOOLS`;
4. se o chamador **não** passou `systemPrompt`, concatena `DEFAULT_SYSTEM_PROMPT` + `HOME_SYSTEM_PROMPT`;
5. passa `homes` ao roster para `ensureForeverBox`.

Se o teste passou `executionBroker`, não substitui o broker; ainda assim cria a home (a menos que `disableAgentHome`), para o RPC de box não ser teatro vazio.

`ServerHandle` expõe `homes?: AgentHomeStore` e o `executionBroker` efetivo.

`npm start` / `main()` não ganha flag nova. Ligar o app já cria a home.

Testes que chamam `startServer` devem passar `workspacesRoot` apontando para um temp dir, para não escrever em `%LOCALAPPDATA%` de verdade. `scripts/smoke-local.mjs` idem.

## 9. Tools e prompt

`SAFE_HOME_TOOLS` (nunca incluir `shell` nem `delete`):

- `file` — `op`: `list` | `read` | `write`; `path`; `content` e `encoding` opcionais no write;
- `search_files` — `paths`, `cwd` opcional;
- `search_text` — `pattern`, `mode` (`fixed` | `regex`), `paths`, `cwd` opcional.

As descrições dizem ao modelo: paths relativos à home; `Desktop`, `Documents`, `Downloads`, `Projects` já existem; não pedir pasta ao usuário.

`HOME_SYSTEM_PROMPT` (inglês, igual ao prompt atual) afirma a mesma coisa. **Não inclui o path absoluto** da home (não vazar disco do usuário para o provider).

## 10. RPC

| Método | Comportamento |
|---|---|
| `ensureForeverBox` | `ensure(agentId \|\| DEFAULT_AGENT_ID)` → `{ ok: true }`. Id desconhecido (≠ default) continua 400 “agente não encontrado”. Sem `homes` (hatch), no-op `{ ok: true }` |
| `getForeverBoxStatus` | `{ vncUrl: null, windows: [] }` inalterado |
| `handBackForeverBox` | `{ ok: true }` inalterado |
| `getComputerCapabilities` | `{ local: true, remoteExecution: false, audioTranscription: false }` inalterado |

Nenhum método novo. Nenhuma família SSE nova. Nenhum patch de renderer. `probeBox` continua inexistente neste gateway.

## 11. Fora de escopo

- segundo agente na UI / roster multi-bot (o mecanismo já é por `agentId`);
- VNC, desktop visual, `windows[]` reais;
- WSL2 / container (adapter futuro do mesmo `ExecutionBackend`);
- grant para pasta do usuário e `ask` associado;
- Explorer “abrir pasta do bot” (atalho futuro, não requisito);
- shell, delete, rede da tool, `/local-exec/*`;
- helper nativo contra TOCTOU de junction;
- quota / `box-disk-pressure`.

## 12. Aceite

- boot limpo cria a home do `openbot-default`; restart não reseed nem apaga arquivos do bot;
- `file.write` em `Documents/nota.md` grava de verdade no root daquele agente;
- `..\\..\\Windows\\...` é recusado e o alvo de fora permanece intacto;
- dois `agentId` em teste não se enxergam;
- `ensureForeverBox` é idempotente e não pede input;
- produção (`startServer()` sem opts) cria a home e executa tools (política `always`); testes passam `workspacesRoot` temporário e nunca escrevem em `%LOCALAPPDATA%`;
- schemas enviados ao provider não incluem `shell`;
- contrato `getForeverBoxStatus` e fixture golden intactos;
- smoke local (dedupe + persistência) continua verde com `workspacesRoot` temporário;
- `npm run build` e `npm test` verdes;
- zero feature do Windows, zero egress novo.

## 13. Compatibilidade

O `LocalExecutionBroker` atual construído com um `ExecutionBackend` concreto permanece válido. Testes de aprovação (`ask` / `always` / `never`) não mudam de semântica.

A Fase 2 documentou estes itens como próximos passos; este slice fecha os itens 1–3 de `docs/phase-2-local-execution-progress.md` (home automática, backend composto no bootstrap, schemas seguros). Itens 4–6 ficam para depois.
