# OpenBot — Fork 100% local (Windows-only) do Grok Bot 0.16.0

Fork **100% local, Windows-only** do Grok Bot (identidade interna
sand/Cursor/Anysphere 0.16.0). A Fase 1 (MVP) está aceita e a Fase 2 entrega o
ambiente por bot: home NTFS, runtime nativo Windows e browser visual. Um **shim** em TypeScript/Node substitui o par
"host original + backend Cursor": emula o gateway HTTP+SSE (`gateway-protocol.ts`,
mapa-funcoes §4.5) e a mesa RPC mínima, e faz inferência sobre providers abertos
(OpenAI, xAI/Grok, OpenAI-compatible com baseURL custom). O cliente original (UI)
se conecta ao shim via `EnvDescriptorHostConnector` na porta local — a UI não sabe
que o backend mudou (estratégia do plano §2). A execução local usa broker próprio,
processos no host Windows, um host Electron sob demanda e catálogos compartilhados de Skills/MCP. O runtime WSL anterior foi removido; comandos dos bots rodam no host sob Job Objects.

> Skills autônomas, seletor `/` nativo e MCP compartilhado: [`docs/shared-skills-mcp-chat.md`](docs/shared-skills-mcp-chat.md).
>
> Fronteiras de confiança e configuração segura: [`SECURITY.md`](SECURITY.md).

> Referências históricas externas: `plano-fase1-mvp.md`, `mapa-frontend.md` e `mapa-funcoes.md`. Esses arquivos não estão disponíveis nos caminhos anteriormente referenciados; as menções a suas seções abaixo registram a origem histórica, não uma dependência de leitura atual.

## Desenvolvimento com GPT-6 Astra

O [AGENTS.md](AGENTS.md) define o fluxo de trabalho do agente que mantém este
checkout. Foi ajustado ao [guia oficial do Astra](https://developers.openai.com/api/docs/guides/latest-model)
consultado em 04/09/2026, preservando o escopo mínimo, a execução em um único
agente por padrão e a confirmação por senha para operações irreversíveis.

Esta orientação de desenvolvimento não altera os modelos dos bots. O catálogo
continua em [src/config/models.ts](src/config/models.ts), sem entrada para
`gpt-6-astra` nesta revisão. O [adapter OpenAI](src/providers/openai.ts) já possui
transporte Responses, mas a seleção automática por nome cobre `gpt-5.6-*`;
também existem overrides explícitos de protocolo. Para Astra, ferramentas exigem
Responses API. Uma integração do modelo no produto precisa validar catálogo,
seleção de transporte e parâmetros; esta atualização é apenas documental.

## Decisões históricas do MVP (11/08/2026)

A tabela registra o escopo original. Para comportamento atual, consulte o fluxo operacional abaixo e a implementação; não trate fases antigas como restrições novas.

| # | Decisão | Valor congelado |
|---|---|---|
| §8.3 | Catálogo de modelos | **Estático local** (`src/config/models.ts` → JSON versionado; sem rede; fetch dinâmico só na Fase 4) |
| §8.7 | Porta do gateway | **Fixa `127.0.0.1:1340`** — sem fallback dinâmico; porta ocupada = erro claro |
| §8.6 | Persistência | **SQLite particionado por agente** (`better-sqlite3`); boot válido com zero bots; **roster multi-agente** via `createAgent` nativo |
| §8.4 | VNC/cloud computer | **Stubs inertes**: `getForeverBoxStatus → {vncUrl:null, windows:[]}`; botão Computer / Plugins / Log out ocultos no cliente local |
| §8.5 | Transcribe de áudio | **Off (no-op)** no MVP |

Modelo **por bot** (fallback global `grok-4.6`). Catálogo OpenAI: `gpt-5.6-luna`,
`gpt-5.6-sol` e `gpt-5.6-terra`. Sem conta/backend/cloud; chaves do usuário via
safeStorage/DPAPI (T4+). Telemetria/updates: off (T17+).

## Arquitetura (plano §1)

```
src/
├─ main.ts            # bootstrap: porta fixa 1340, descritor local, spawn/lifecycle
├─ shared/            # CONTRATOS congelados (espelho do gateway-protocol): types de
│                     #   transcript/transcript-page/sendPrompt/envelopes/eventos SSE
├─ server/            # gateway HTTP+SSE (T3+): GET /api/events, POST /api/<method>,
│                     #   /health, /prepare-upgrade, /avatars, CSRF loopback, gzip
├─ rpc/               # dispatch da mesa MVP (T3+): chat / transcript / tools / settings
├─ providers/         # roteador unificado streamChat (T5+) + adapters
├─ keystore/          # safeStorage/DPAPI (T4+): sand-secrets.json em %APPDATA%\OpenBot\
├─ execution/         # sandbox Windows, arquivos, busca, broker e tool loop
├─ skills/            # catálogo seguro e dispatcher autônomo/explicito
├─ mcp/               # manager compartilhado HTTP/stdio, policies e limites
├─ integrations/      # composição das tools locais, Skills e MCP
├─ store/             # sqlite por agente: transcript, ledger e decisões
└─ config/            # catálogo estático de modelos, perfil local, flags (JSON)
test/                 # unit + contrato RPC + e2e com mocks de provider
scripts/              # launcher, recovery, smoke e gates (docs/verification-gates.md)
patches/              # registro dos patches locais no cliente extraído
```

**Estratégia de conexão app ↔ shim (plano §2):** renderer ↔ main ↔ coordinator INTACTA
(zero patch); coordinator ↔ gateway via `EnvDescriptorHostConnector` com
`SAND_HOST_GATEWAY_URL=http://127.0.0.1:1340` + token local aleatório (patch de 1 ponto,
T16); gateway HTTP+SSE reproduzido no shim (spec §4.5); inferência via roteador novo
(adapters OpenAI/xAI/OpenAI-compat, T5–T8); UI sem rebuild do renderer.

## Comandos

```bash
npm install          # deps mínimas: typescript, vitest, better-sqlite3, @types/*
npm run build        # tsc → dist/ (verde)
npm test             # vitest run
npm run smoke:local  # build + prompt/SSE/dedupe/restart sem rede externa
npm start            # só o gateway (supervisor + worker) em http://127.0.0.1:1340 (Ctrl+C derruba)
npm run desktop      # o app completo, pelo mesmo caminho do atalho (ELECTRON_EXE/ELECTRON_PATH sobrescrevem o Electron)
npm run verify:launcher       # launcher do desktop: posse do gateway, teardown, entradas cmd/vbs
npm run verify:data-recovery  # SQLite WAL + backup/checksum/restore em %TEMP%
npm run verify:clean-profile  # primeiro boot/restart isolados, sem provider real
npm run verify:chat-resilience # falhas, retry, cancelamento e troca de provider/modelo
npm run verify:bot-memory     # conversas, memória, contexto, worker e ponte Electron
npm run verify:client-artifacts # artefatos de validação de cliente e contratos
npm run verify:memory-flow-e2e # fluxo de memória real com OpenAiCompatAdapter (HTTP/SSE local)
npm run recovery:status       # estado do checkout, dos dados locais e do gateway
npm run diagnostics:execution # contadores do gateway local já em execução
```

`verify:clean-profile` usa uma `TempRoot` própria para APPDATA, dados, logs,
user-data e uma cópia isolada do checkout, inicia gateway e Electron reais, e verifica token/
configuração persistidos, roster vazio e teardown sem processos/porta
residuais. O keystore Node atual usa fallback local quando não há keyring
injetado; DPAPI/safeStorage não é afirmado por este gate e fica para a Etapa 3.

Há um único caminho de execução, o do checkout: `scripts/openbot-desktop.vbs` (atalho, sem terminal) → `scripts/openbot-desktop.cmd` (escolhe `runtime\node`) → `scripts/launch.mjs`. O launcher verifica o build do backend, garante um gateway deste checkout em 127.0.0.1:1340 (verificando o cliente Electron e o atalho do menu Iniciar enquanto ele sobe), abre o Electron e, ao fechar, encerra o gateway somente se for o dono dele. O `/health` do gateway informa `rootId` e `build`; o launcher adota apenas um gateway deste checkout, recusa a porta ocupada por outro processo, substitui um gateway órfão de build anterior e deixa intacto o gateway de uma janela já aberta (a segunda abertura só foca essa janela). A posse fica em `process.json` na raiz; parada forçada exige o handle do processo iniciado ou evidência de identidade (PID, horário de criação, executável e raiz) coletada na inicialização. O VBS usa um log exclusivo por invocação, apaga esse log no sucesso, retém falhas por até 7 dias e mostra uma mensagem por código de saída (2 build, 3 Electron, 4 gateway/porta, 5 Node, 6 teardown). `OPENBOT_STARTUP_TRACE=1` imprime os tempos de cada etapa. Os gates e ferramentas de desenvolvimento estão listados em [`docs/verification-gates.md`](docs/verification-gates.md); não fazem parte do fluxo de produto.

`OPENBOT_DATA_ROOT` controla os dados roaming (configuração, conversas, credenciais; padrão `%APPDATA%\OpenBot`) e `OPENBOT_LOCAL_DATA_ROOT` controla workspaces, runtime e o perfil do Electron (padrão `%LOCALAPPDATA%\OpenBot`).

O Recovery Center local, sem telemetria: `npm run recovery:status`, `recovery:backup`, `recovery:verify -- --backup <pasta>`, `recovery:restore -- --backup <pasta> --yes` e `recovery:diagnostics -- --output <arquivo>` (`--data-root`/`--local-data-root` apontam para outros dados). Backup e restore recusam um gateway ativo, inclusive um supervisor registrado em `process.json` durante o reinício do worker. O backup cobre os dados roaming e os workspaces, com checksum por entrada; restore valida o backup uma vez, cria um backup pré-restauração e, se a troca falhar no meio, devolve cada pasta substituída (o erro diz onde ficou a cópia anterior se a devolução também falhar). Backups ficam em `%LOCALAPPDATA%\OpenBot\backups` por padrão.

Runbook operacional: [`docs/openbot-recovery-runbook.md`](docs/openbot-recovery-runbook.md).

Esquecimento e retenção da memória: [`docs/memory-forget-retention.md`](docs/memory-forget-retention.md).

Comportamento do chat sob falhas: [`docs/chat-provider-resilience.md`](docs/chat-provider-resilience.md).

Requisitos: Node.js ≥ 20 (testado em v22), Windows (keystore DPAPI a partir de T4).

O launcher do checkout prioriza `runtime/node/node.exe`, quando presente, sem
alterar o PATH do Windows. O runtime local e os módulos nativos devem ser
compatíveis; nesta instalação, Node 22 usa o SQLite nativo de ABI 127. O Electron
fica em `node_modules/electron/dist`. Esses binários locais não são versionados.
Para usar os comandos npm acima no PowerShell desta pasta:
`$env:PATH = "$PWD\runtime\node;$env:PATH"`.

## Fluxo operacional do checkout

### Fase 2 concluída — ambiente prático por bot

> Caminho atual de execução: [bootstrap](src/main.ts) e [driver local](src/execution/runtime/local/driver.ts).

- `src/execution/` implementa contratos estritos, paths confinados para ferramentas estruturadas e operações `file.list`, `file.read`, `file.write`, `search.files` e `search.text`. Processos nativos confiáveis continuam com acesso à conta Windows, fora dessa fronteira de paths.
- `process.run` executa processos nativos no host Windows confiável (conta do usuário, ambiente herdado, rede do host, qualquer executável instalado). Pedidos passam por contrato estruturado; a bridge HTTP `/local-exec/*` reutiliza o mesmo parser e broker, sem shell arbitrário.
- O boot aceita roster vazio. Ao criar um bot, `startServer` usa `%LOCALAPPDATA%\OpenBot\workspaces\<agentId>\` (Desktop/Documents/Downloads/Projects) e liga arquivos, busca, browser visual e o runtime local confiável.
- `localToolPermission` é fixo em `always` e `runtimeMode` em `developer` para todos os agentes; não há modo Lite selecionável. Aprovações RPC continuam para brokers injetados.
- O `TurnRunner` publica um card `tool-call` por chamada (`pending` → `running` → `completed`/`failed`) com `result` sanitizado, além do loop tool-result para o provider.
- Cada bot pode descobrir Skills sozinho ou recebê-las pelo seletor `/` e chip nativo do chat. MCP é compartilhado/lazy, mas fica deny-all até configuração e allowlist explícitas por bot.
- Create/customização usam o seletor nativo do Grok Bot (`+` → Create new Bot → View agent settings). Provider/chave ficam só nesse painel. Entries de transcript expõem `toAgent`/`fromAgent`/`fromUser` como objetos (`id`+`name`), o shape que o renderer espera.


### Operação das homes e diagnóstico de execução

- Manutenção de home fecha sessões do navegador sem apagar cookies, login ou armazenamento persistente. A exclusão explícita do bot usa uma operação de purge separada. A manutenção bloqueia novas execuções do bot e aguarda as operações em andamento; falha de drenagem impede a mutação da home.
- A exclusão cancela também as compactações em andamento. A pasta vai para quarentena para permitir recuperação, inclusive quando ultrapassou a quota; a validação de caminhos continua obrigatória. A criação prepara os arquivos em staging antes de publicar a pasta ativa e descarta a preparação se uma escrita falhar.
- A limpeza definitiva usa o RPC local `purgeDeletedAgentData` com `{ "agentId": "id-do-bot", "confirm": true }`. Ele remove as quarentenas e os snapshots desse ID e libera o espaço; recusa bots cadastrados, homes ativas e exclusões ainda pendentes de reconciliação. É irreversível e nunca roda automaticamente. Para listar os IDs sem ler o conteúdo das pastas, use `listQuarantinedAgents` com `{ "includeInventory": false }`; a listagem padrão com inventário permanece disponível.
- Processos nativos usam Job Objects com recuperação por identidade versionada. O helper compilado fica no cache gerenciado do runtime; o primeiro uso compila, e os seguintes verificam e reutilizam o binário. Temporários e caches de ferramentas recebem defaults por home em `.openbot-runtime`, sem trocar o perfil/credenciais do usuário; `env` explícito prevalece. Isso controla o ciclo de vida, não isola permissões do Windows nem fornece serviços persistentes.
- Processos sobrepostos na mesma home compartilham um observador de quota. Eventos repetidos são agrupados; a fila de paths é limitada. Há inventário inicial, reconciliação periódica enquanto há processos e reconciliação final. Isso não é quota rígida do NTFS nem desfaz arquivos já gravados.
- `workspace_info` expõe os limites efetivos em `quota.global` e `quota.folders` sem varrer a home. O consumo não faz parte dessa resposta. Os defaults permanecem 2 GiB por workspace, 256 MiB em `Downloads`, 1,5 GiB em `Projects` e 64 MiB em `.openbot`, com os limites de arquivos/entradas definidos no backend.
- A quota persistente por bot usa o campo opcional `workspaceQuota` dos RPCs existentes `createAgent` e `updateAgent`. Ele aceita overrides parciais `maxBytes`, `maxFiles`, `maxEntries` e `folders` (`Downloads`, `Projects` ou `.openbot`); `workspaceQuota: null` remove o override. Em `updateAgent`, a resposta só retorna depois que o fence de manutenção drena arquivos/processos, para e invalida o backend anterior; o limite novo vale na próxima operação. Reduzir um limite não remove dados existentes.
- Novos exports/snapshots usam arquivo binário v2, com payload transferido em blocos de 256 KiB. A importação reconhece o formato pelo conteúdo e aceita o JSON/Base64 legado; somente o v2 limita a memória do payload independentemente do tamanho total. Metadados continuam proporcionais ao número de entradas e têm limite próprio. Os limites de quota continuam valendo.
- `npm run diagnostics:execution` lê `getExecutionDiagnostics` no gateway local autenticado, sem executar bots, iniciar processos ou varrer homes. Mostra admissão/fila de provider e runtime, contadores de quota das homes inicializadas, memória e event loop do gateway. Contadores são locais ao processo e reiniciam no bootstrap; não são medição de capacidade máxima. O comando precisa de um gateway que já contenha esta versão.
- Concorrência e limites padrão não foram ampliados indiscriminadamente. Bots existentes e novos usam o mesmo fluxo no próximo bootstrap atualizado; não é necessário recriar os bots. Atualizar o código não reinicia uma instância já em execução.


### Fechamento e bandeja do Windows

Fechar a janela pelo **X** ou **Alt+F4** mantém o OpenBot em execução na bandeja, sem interromper os bots. Clique com o botão direito no ícone para **Reabrir OpenBot** ou **Encerrar OpenBot**. Um clique no ícone, ou abrir novamente pelo atalho, restaura a mesma janela. Minimizar continua usando a barra de tarefas.

**Encerrar OpenBot** usa o encerramento normal: salva rascunhos pendentes e deixa o launcher limpar o gateway que iniciou. Um gateway externo/adotado continua sob responsabilidade de seu iniciador. Se a bandeja não puder ser criada, fechar a janela mantém o comportamento anterior de saída, sem deixar uma janela oculta inacessível.

### Ícone e atalho do desktop

No checkout, `npm run desktop:shortcut` cria ou corrige somente `OpenBot.lnk` no Desktop real do Windows (inclusive Desktop redirecionado). O destino é `scripts/openbot-desktop.vbs`, os argumentos ficam vazios e a pasta de trabalho é a raiz do checkout. O comando não inicia nem reinicia bots.

Ao abrir pelo launcher, o OpenBot também confirma `Programs\OpenBot.lnk` no menu Iniciar enquanto o gateway sobe; uma falha encerra a abertura e o gateway iniciado. A confirmação fica registrada em `logs/taskbar-shortcut.json` e só é refeita quando o checkout, o Electron ou os atalhos mudam. O registro usa o VBS e o ícone do checkout. A associação legada `Electron.lnk` só é removida se tiver `OpenBot.Desktop`, apontar para o runtime Electron em uso e não tiver argumentos; a substituição é criada e verificada primeiro. Um atalho de outro aplicativo não é sobrescrito. O Desktop não é alterado nessa etapa. Para executar somente essa correção: `node scripts/setup-desktop-shortcut.mjs --taskbar-only`.

O ponto de entrada `scripts/openbot-electron.cjs` valida os ícones próprios e aplica PNG à janela e ICO à barra de tarefas. Ícones ausentes/inválidos causam erro, não fallback silencioso para Electron. Não edite o ícone em `node_modules`: a próxima atualização da dependência substituiria essa correção. Os verificadores de desktop usam o mesmo ponto de entrada.

`npm run verify:desktop-identity` verifica o ícone real do HWND, a identidade de tarefa e um atalho/VBS real em fixture isolada. Essas verificações detectam regressões cobertas; não são uma garantia contra alterações arbitrárias futuras ou caches externos do Windows.
