# Verification gates

`npm test` cobre os testes Vitest (`test/**/*.test.ts`), mas não executa os gates de aceitação que dependem de ambiente real Windows/desktop:

- E2E real do Electron, com fixture, gateway, CDP e renderer.
- E2E real do Electron para o backend de navegação visual, com fixture offline e partições isoladas.
- Aplicação e verificação real de DACL via `icacls`.

## Gate DPAPI CurrentUser

O addon nativo atualmente suportado é
`native/dpapi/win32-x64/openbot-dpapi.node` (arm64/ia32 falham fechados até
existirem binários produzidos) e usa
`CryptProtectData`/`CryptUnprotectData` no perfil CurrentUser. O binário não
recebe segredos por ambiente, argv, stdout ou IPC; o formato persistido usa a
tag `dpapi-current-user`. A migração de `.master.key` é atômica e arquiva a
chave antiga somente depois de reabrir e verificar todos os registros.

```powershell
npm run verify:dpapi-artifacts
npx vitest run test/keystore.test.ts test/keystore-gateway.integration.test.ts test/keystore-dpapi-live.test.ts --maxWorkers=1 --no-file-parallelism
$env:OPENBOT_RUN_DPAPI_LIVE = '1'
npx vitest run test/keystore-dpapi-live.test.ts --maxWorkers=1 --no-file-parallelism
```

O último comando é Windows-only, opt-in e usa uma raiz temporária. O release
inclui o addon da arquitetura selecionada e o preflight exige o caminho
declarado no manifest.

## Gate core de chat, providers e persistência

Execute:

```powershell
npm run verify:core:acceptance
```

Cada cenário mantém somente uma instância ativa do `startServer` de produção por vez, com estado temporário isolado. O cenário de persistência faz um restart controlado (`stopServer` completo seguido de uma nova instância nos mesmos caminhos), em vez de sobrepor handlers ou manter duas instâncias simultâneas. Ele cria o primeiro bot via RPC, configura Name/Title/Description, provider OpenAI-compatible, modelo, baseURL e chave cifrada sem expor o valor; valida um delta/evento SSE intermediário antes do final, prompt de sistema, modelo/Bearer, transcript final único, retry sem duplicação e cancelamento com readiness explícita, abort observado, conclusão natural impedida, zero chunks depois do abort e contadores estáveis após uma janela. Também verifica que o segredo não aparece no body enviado ao provider, transcript ou artefatos temporários relevantes, e verifica roster, provider, chave, transcript e nonce após o restart.

O provider é somente local (`127.0.0.1`) e a chave é um fixture descartável; o gate não usa credenciais comerciais nem estado real do usuário. O comando também roda o typecheck e o Vitest serializado para evitar interferência entre servidores HTTP efêmeros.

## Gate de resiliência do chat

Execute:

```powershell
npm run verify:chat-resilience
```

O gate cobre frames SSE estruturalmente inválidos, tool calls incompletas,
timeout sem repetição prolongada, `Retry-After` limitado, mensagens de erro
normalizadas, provider/model fixados no aceite, retry idempotente sem duplicar a
mensagem do usuário, exclusão do parcial no novo request, reconciliação do
marcador de retry no SQLite, journal de turnos em voo, crash após o echo,
parciais interrompidos, reutilização de PID e os contratos IPC/renderer de retry
e status.

Também recusa retry após falhas de I/O, timeout ou limite de saída que podem
ter deixado efeitos, antes e depois de reabrir o SQLite; os testes verificam
zero novas chamadas ao adapter e preservação da mensagem e do resultado da ferramenta.

Todos os providers e dados usados são fixtures locais descartáveis. O resultado
não comprova disponibilidade, limites ou comportamento de serviços comerciais
externos.

## Gate live de providers (opt-in)

```powershell
npm run verify:providers-live
# opcional: --provider xai | --provider openai | --provider opencode-go | --provider openai-compat
# opcional: --config <openbot-config.json> --state-root <dir-da-keystore>
```

O gate é **opt-in** e usa as credenciais reais configuradas na keystore e na
configuração local do usuário — as mesmas que o aplicativo usa. Nenhum token,
chave ou corpo de resposta é impresso; o relatório traz apenas PASS/SKIP/FAIL
por provider. Provider sem credencial configurada é reportado como `SKIP`
(nunca falso sucesso); provider configurado com falha é `FAIL` e zera o gate.

Cobertura por provider:

- `openai`: resolução OAuth + refresh proativo (sessão expirada não conta como
  saudável) e presença do `accountId` do Codex;
- `xai`: resolução OAuth + `GET /v1/models` autenticado retorna lista não
  vazia;
- `opencode-go`: chave na keystore + `GET /models` do relay;
- `openai-compat`: `compatBaseUrl` configurado + `GET /models` do endpoint;
- serialização: `reasoning_effort` aparece no corpo gerado somente onde o
  contrato o declara (xAI com esforço declarado, compat com opt-in) — check
  offline estrutural, executado em toda execução.

Os testes offline/mock seguem sendo o caminho normal de verificação; este gate
existe para conferir, com a rede real, identidade do provider, autenticação e
catálogo — nunca para substituir a suíte padrão.

## Gate real de recuperação de dados

Execute `npm run verify:data-recovery`. O gate cria em `%TEMP%` um SQLite real
em modo WAL, configuração, credenciais cifradas de fixture e workspace; depois
faz backup, verificação por SHA-256, mutação e restore. GREEN exige
`PRAGMA integrity_check=ok`, linhas e arquivos originais restaurados e rejeição
de backup adulterado antes de qualquer escrita no destino.

O operador pode consultar `npm run recovery:status`, criar backup com
`recovery:backup`, verificar com `recovery:verify -- --backup <pasta>` e
restaurar com `recovery:restore -- --backup <pasta> --yes`. Restore exige
gateway parado e cria um backup pré-restauração.

## Gate E2E do browser visual (v1)

Execute:

```powershell
npm run verify:e2e:browser
```

Esse gate compila o projeto e executa `test/browser-e2e.integration.test.ts`, `test/browser-security.test.ts` e `test/browser-host-fatal.test.ts` serialmente. O primeiro usa o Electron real fornecido pela dependência local; o segundo incorpora os negativos de proxy, SSRF/esquema, permissões, popups, limites de download/screenshot/upload e hardlink já cobertos pelo contrato de segurança; o terceiro injeta uma falha somente em ambiente de teste e prova que o host encerra sem aguardar diálogo nativo. Cada execução cria uma raiz temporária própria para homes, Downloads, perfis/partições e fixture HTTP offline; o fixture é acessado por um hostname de teste através do proxy de egress controlado, sem abrir CDP para o bot.

O gate também preserva o contrato de ambiente mínimo do host Electron: variáveis operacionais necessárias continuam disponíveis, enquanto API keys, tokens arbitrários e `ELECTRON_RUN_AS_NODE` não são herdados do processo pai.

## Isolamento entre bots

Os testes focados de isolamento cobrem:

- quota única para arquivos estruturados e `process.run`, incluindo recusa antes do lease e abort durante a execução;
- sessões MCP `shared` deduplicadas e sessões `agent` separadas, com cleanup seletivo na remoção do bot;
- persistência/validação de `sessionScope` e projeção RPC sem referências de segredo;
- ambiente mínimo do browser host e E2E com Electron real;
- WSL live com namespaces, identidade sem privilégio, seccomp, rede bloqueada, timeout, abort e remoção dos recursos do lease.

O cenário verifica, em dois bots simultâneos, open/navigate, snapshot com texto e viewport, click, type, screenshot de viewport e full-page, upload restrito à home, evento/download em `Downloads`, handoff visual, isolamento de `localStorage`/partição e limpeza de leases/host. Também verifica a rejeição de URL `file:`. O teardown fecha o manager, fixture e raiz temporária; o teste não usa credenciais, rede externa ou estado do usuário.

GREEN exige que o Electron real complete todos os comandos, que a falha injetada termine com código não-zero sem timeout/diálogo, e que, ao final, as duas leases sejam fechadas e o host compartilhado esteja parado. O tratamento fail-fast do host previne o diálogo nativo por contrato; a asserção de stderr permanece como evidência adicional, não como o mecanismo de prevenção. O comando é separado do teste padrão por ser um gate de processo/desktop e pode levar cerca de 20 segundos.

## Gate de homes e processos nativos

```powershell
npm run typecheck
npx vitest run test/runtime-local-ownership.test.ts test/runtime-process-backend.test.ts test/execution-quota.test.ts test/home-archive.test.ts test/home-snapshots.test.ts test/home-lifecycle-rpc.test.ts test/async-task-runtime.test.ts test/execution-diagnostics.test.ts --maxWorkers=1 --no-file-parallelism
npm run verify:e2e:browser
```

Os testes nativos exigem Windows e usam homes, journals, caches e processos de
fixture descartáveis. Cobrem ownership por Job Object, recuperação de leases,
ambiente operacional por home e admissão limitada. A execução fora de Windows
não comprova esse gate. A quota é cooperativa; os testes de agrupamento e
inventário medem trabalho interno, não throughput de bots reais.

O formato de arquivo v2 é exercitado com payload maior que o bloco de 256 KiB,
framing/checksums, limites e compatibilidade JSON legado. Isso não comprova
throughput ou RSS de um archive de 2 GiB. O gate Electron também verifica que
inventário, export e repair não apagam o armazenamento persistente do browser.
Nenhum desses gates deve apontar para homes, perfis ou journals reais.

## Gate público do browser (somente leitura)

Execute separadamente do gate offline:

```powershell
npm run verify:browser:public-readonly
```

Esse gate usa o caminho real `BrowserSessionManager` → proxy de egress → host
Electron e permite somente `open`, `navigate`, `snapshot` e `screenshot` em
`https://example.com/` e `https://www.iana.org/`. A allowlist é exata: não há
credenciais/userinfo, query, fragmento ou outros hosts. Forms, upload,
download, popup, click, type e qualquer outra ação mutável são rejeitados antes
de chegar ao Electron.

O runner usa raiz temporária, timeout curto e bounded, e comprova lease liberada,
host parado, proxy fechado e remoção da raiz. `GREEN` tem exit code 0;
`BLOCKED_ENV` (DNS/TLS/rede pública indisponível) é explícito, tem exit code 2
e nunca é convertido em sucesso; bugs e falhas de cleanup são `RED` (exit code
1). O gate não usa credenciais nem `fetch`/DOM stub. O teste hermético da
política/classificação está em `test/browser-public-readonly.test.ts`; não
altere o gate offline para obter evidência pública.

## E2E desktop isolado

Execute:

```powershell
npm run verify:e2e:desktop
```

O script compila o gateway e chama `scripts/e2e-desktop-run.ps1`. Se o Electron não estiver no caminho padrão do runner, informe-o assim:

```powershell
npm run verify:e2e:desktop -- -ElectronPath 'C:\caminho\para\electron.exe'
```

O runner cria uma raiz temporária própria e direciona `APPDATA`, `LOCALAPPDATA`, `OPENBOT_USER_DATA`, staging e os dados do gateway para ela. Também escolhe portas dinâmicas, inicia somente os processos da execução e grava evidências em `logs/e2e-desktop/`. O ownership da árvore valida PID + data de criação, ignora processos preexistentes atingidos por reutilização de PID e reenumera filhos tardios até duas leituras consecutivas vazias. A raiz temporária é removida após teardown completo; em falha de teardown ela é preservada para diagnóstico.

GREEN exige o processo terminar com sucesso e o resumo do runner indicar `status=GREEN`, `ownedProcessesAbsent=true`, `portsFree=true` e `cleanup=temp-root-removed`. O relatório CDP deve conter as verificações de carregamento, envio pelo composer real, streaming, troca de bot com controle ligado ao agente correto, reconnect forçado, cancelamento, fluxo de Skill, falha parcial retryable, botão de nova tentativa, recuperação sem duplicar a mensagem do usuário e ausência de erros do renderer.

## Infraestrutura dos gates e2e

Os scripts que falam CDP com o Electron real compartilham `scripts/e2e-runtime.mjs`:

- `connectCdp(url)`: timeout no handshake (`ready`), timeout por chamada em
  `send()` e rejeição de calls pendentes quando o websocket fecha. Uma chamada
  sem resposta não pode travar o gate.
- `cleanE2eEnvironment(extra)`: remove variáveis que quebram ou contaminam o
  filho spawnado — `ELECTRON_RUN_AS_NODE` transforma o Electron em Node e falha
  com `bad option`; vars de runner (`VITEST_*`, `NODE_OPTIONS`) e tokens/roots
  (`OPENBOT_*`, `SAND_*`, `GATEWAY_TOKEN`) não herdam para o aplicativo de teste.
- `startE2eWatchdog(budgetMs, onTimeout)`: orçamento global — ao estourar, roda
  o cleanup (mata o filho) e sai com código 124. O padrão é 10 minutos e pode
  ser ajustado por `OPENBOT_E2E_BUDGET_MS`.

`bridge-real-verify`, `memory-flow-e2e`, `verify-clean-profile`,
`electron-p27-profile` e `verify-legacy-screen-hidden` usam essas garantias.
`bridge-real-verify` também registra uma linha de fase por bridge call, então
um hang aponta exatamente onde ocorreu.

## Gate único de Skills/MCP

Para validar o incremento completo em uma única execução, use:

```powershell
npm run verify:skills-mcp
```

O comando é fail-fast e versionado no repositório. Ele executa, nesta ordem, o typecheck; os testes focados de Skills/MCP (incluindo os transports SDK reais HTTP/stdio, políticas, segredos, limites e transcript); o `verify:core:acceptance`; e o E2E desktop isolado. O último estágio já verifica o fluxo do seletor `/`, chip de Skill, uma resposta final e cleanup do Electron/gateway em raiz temporária própria. Uma etapa não-zero interrompe o gate e produz resultado não-zero; nenhum bot cria VM ou processo permanente.

## ACL live do Windows

Execute em Windows, com `icacls.exe` disponível:

```powershell
npm run verify:acl:live
```

O script define `OPENBOT_RUN_LIVE_ACL_TEST=1` e executa somente `test/home-acl.test.ts` serialmente. O teste live usa uma árvore em `%TEMP%\openbot-acl-live-*`, aplica a DACL nessa árvore, verifica o resultado com `icacls /verify`, grava um arquivo aninhado, acrescenta conteúdo e o remove. A árvore temporária é removida no `finally`.

GREEN exige que o teste live seja executado — não apenas skipped por plataforma ou ausência da variável — e que o adapter retorne `status=verified`. Esse gate pode alterar ACLs e arquivos dentro da pasta temporária; não o execute apontando para uma home real.

## Gate live do runtime WSL2

Execute em Windows com WSL2 e um pacote de guest já empacotado:

```powershell
npm run verify:runtime-wsl-live
```

O comando é versionado e usa exclusivamente uma distro descartável aleatória
`OpenBotRuntimeLive-<guid>` e um `TempRoot` próprio. Guardas de nome e caminho
são validadas antes de cada mutação; o gate captura WSL antes/depois e falha se
`OpenBotRuntime`, `Ubuntu`, `Ubuntu-24.04` ou outra distro existente mudar.
Ele executa o caminho de produção para manifest/digest, candidate/promotion,
falha/rollback, health/version, `process.run` real (UID/GID não-root,
NoNewPrivs, seccomp e rede bloqueada), abort/timeout com confirmação de
cleanup, cleanup parcial com cgroup já ausente, restart/recovery de lease órfã e cleanup final. O runtime de produção usa um reconciliador WSL padrão, valida os IDs persistidos e mantém o journal até obter prova positiva do teardown. O resultado é um
único JSON `GREEN`/`RED`; qualquer falha de cleanup mantém o resultado RED.

No aceite de 16/08/2026, o gate usou `OpenBotRuntimeLive-5916e39a-597b-4122-bedc-158346ff1d81`, digest de archive `sha256:b7653bcc9cfbd74a38ff040f0ab840891c780396baf5de39b8672beddc240266` e terminou `GREEN`. Antes e depois continham somente `Ubuntu-24.04`, `OpenBotRuntime` e `Ubuntu`, todas paradas; a distro e o `TempRoot` temporários ficaram ausentes.

Por padrão, o pacote é lido de `%LOCALAPPDATA%\OpenBot\runtime\staging`; para
um artefato específico, use `OPENBOT_GUEST_PACKAGE`. O gate nunca usa
`OpenBotBuild` e não importa, termina ou unregistera distros pessoais.

## Gate dos artefatos do cliente

Execute:

```powershell
npm run verify:client-artifacts
```

O gate valida versões, hashes, manifest e política dos artefatos `main`/`preload` usados pelo desktop. Source maps podem permanecer como evidência forense, mas os artefatos executados não podem referenciá-los. GREEN exige todas as verificações aprovadas e falha diante de tamper de versão ou conteúdo.

## Seleção após exclusão e controles nativos do Windows

```powershell
npm exec --offline -- vitest run test/desktop-selection.test.ts test/desktop-ui-regressions-live.test.ts test/desktop-tray.test.ts test/desktop-tray-live.test.ts --maxWorkers=1 --no-file-parallelism
npm run verify:client-artifacts
npm run verify:renderer-boundary
npm run verify:provenance
```

O teste live usa main/preload/renderer e controles nativos reais, com gateway em memória e perfil descartável. Exclui o bot selecionado pelo menu e confirmação da interface; exige seleção, cabeçalho e mensagens do sobrevivente sem clique adicional. Mede pixels da tela para comparar controles e cabeçalho normal/escurecido, verifica temas claro/escuro e testa geometria/foco do modal após resize, zoom de 125% e maximização. Precisa de sessão Windows interativa e abre uma janela temporária em primeiro plano. O teardown encerra somente a árvore da fixture e remove seus dados. Não usa bots, credenciais ou ACLs do perfil real; não substitui o gate de persistência/clean-profile. Os testes de contrato também exigem que leituras de fundo, paginação e falhas de abertura não alterem a seleção.

## Fechamento para bandeja do Windows

```powershell
npm exec --offline -- vitest run test/desktop-tray.test.ts test/desktop-tray-live.test.ts test/electron-windows-patches.test.ts --maxWorkers=1 --no-file-parallelism
npm run verify:clean-profile
```

O teste live usa Electron/Tray/Menu reais e perfil temporário, sem bots ou gateway reais. Envia `WM_CLOSE` ao HWND da própria fixture, verifica janela oculta e preservação do conteúdo ao reabrir, restauração após minimizar, segunda invocação, fechamento normal de janela auxiliar e saída diferida por `before-quit`, com destruição da bandeja. Aciona callbacks do menu real; não automatiza cliques no menu do Explorer. O entry extraído é substituído por fixture vazia nesse teste; `verify:clean-profile` complementa com bootstrap e encerramento do aplicativo/gateway reais em raízes descartáveis. Os testes unitários cobrem indisponibilidade da bandeja e eventos de encerramento da sessão Windows, sem efetuar logoff real.

## Gate de identidade do desktop Windows

```powershell
npm run verify:desktop-identity
npm exec --offline -- vitest run test/taskbar-shortcut.test.ts test/electron-windows-patches.test.ts --maxWorkers=1 --no-file-parallelism
npm run verify:release-lifecycle
npm run verify:visual-ui
```

O primeiro usa Electron real, perfil temporário e a ponte de produção, sem
carregar o aplicativo/bots reais. Compara os ícones nativos do HWND com uma
janela de referência PNG, lê `AppUserModelID` e metadados de relançamento do
Windows e lê o `.lnk` pela API nativa do Electron. Também abre um atalho
VBS de fixture a partir de `System32`, verificando a pasta de trabalho por
sentinela. Exige Windows; um skip em outra plataforma não comprova aceite.
O teste `taskbar-shortcut` usa um menu Iniciar descartável para reproduzir a
associação incorreta `Electron.lnk` → `OpenBot.Desktop`, conferir correção,
recorrência, idempotência e preservação de links de terceiros e após erro.
As propriedades corretas do HWND, sozinhas, não comprovam o ícone exibido pelo
Explorer: no aceite real, confira também a associação em `Get-StartApps` e o
nome/ícone do botão na barra de tarefas, sem limpar caches nem regravar o Desktop.
O gate de release valida destino VBS estável, ícone da versão e AppID nos
atalhos criados/recriados. Todo o arquivo de testes usa um
`OPENBOT_SHORTCUT_ROOT` temporário como fallback, inclusive nos subprocessos;
os testes não devem usar o Desktop/Start Menu real. A regressão de propriedade
cobre instalação sem atalhos, repair/update/rollback e uninstall, preservando
links de outra instalação e estados legados que registravam caminhos sem
ter criado os atalhos. Não apaga caches do Explorer nem inicia bots reais.

## Feedback e persistência do perfil

```powershell
npm exec --offline -- vitest run test/profile-persistence.test.ts test/rpc-send-preparation.test.ts test/rpc-retry-target.test.ts test/electron-windows-patches.test.ts --maxWorkers=1 --no-file-parallelism
node scripts/visual-ui-verify.mjs --profile-feedback-only
node scripts/visual-ui-verify.mjs --profile-only
```

Os testes de backend usam dados descartáveis para concorrência da foto,
rollback, leitura por uma nova instância e cancelamento durante a preparação
do envio. Os testes de perfil usam Electron e gateway de fixture: resposta de
leitura atrasada, nome em edição, foto preservada, confirmação após fechar o
painel e recarga do renderer. `--profile-only` também cobre JPEG, imagem inválida,
remoção da foto e preservação do rascunho após erro de gravação. Recarga do
renderer não equivale a encerrar e reabrir todos os processos do aplicativo.
O gate visual completo também exige que uma falha superada não ofereça nenhuma
ação (o backend só indica recuperação para a falha atual) e que a falha atual
continue recuperável. O E2E desktop seleciona o botão do erro correspondente, não
o primeiro botão do histórico.

## Gate visual da interface

Execute:

```powershell
npm run verify:visual-ui
```

O gate usa Electron real para conferir a tela de boas-vindas, animação, foco, perfil local persistente, layout de settings e CTAs neutros. Ele também impede o retorno dos elementos legados de conta/Sign out. No modo visual isolado, a ausência do gateway em `127.0.0.1:1340` pode produzir `ECONNREFUSED` esperado; o E2E desktop é a prova complementar com gateway real.

### Recuperação orientada pelo backend

```powershell
npm exec --offline -- vitest run test/turn-uncertain-effects.test.ts test/rpc-send-preparation.test.ts test/rpc-send.test.ts test/prompt-queue.test.ts test/rpc-send-gateway.integration.test.ts --maxWorkers=1 --no-file-parallelism
npm run verify:visual-ui
```

`promptStatus` publica o estado ao vivo do turno (`execution.phase`,
`execution.startedAtMs`, `execution.lastActivity*`, `execution.toolName`) e o
resultado confirmado do último turno (`lastTurn.outcome`). Cada transição vem de
um acontecimento real — preparação local, entrada/saída da admissão do provedor,
requisição entregue ao transporte, fragmentos do provedor e progresso do tool
loop. Polling, heartbeat e a atualização do contador não alteram a fase e a
ausência de eventos nunca é tratada como travamento; por isso o gate cobre um
intervalo sem eventos que não aborta nem publica aviso.

`getPromptRecovery` informa, por identificadores reais, quais ações são possíveis
para a falha atual: `retry`, `inspect` (repetir poderia duplicar efeitos) ou
nenhuma. Ele reutiliza a mesma avaliação de elegibilidade usada por
`retryPrompt`, então a ação indicada e a executada não divergem; o clique
revalida o `expectedFailureEntryId` no backend, e uma ação antiga nunca atua
sobre outro turno. Remover ou traduzir o texto do erro não muda as ações. A
resposta traz também `historyEntryIds`: as entries do turno resolvidas por
identidade (`turnId` ou `localToolCallId` prefixado por ele), para o cliente
destacar o histórico correto sem depender da posição das linhas visíveis.

Com ferramentas habilitadas o texto da rodada é retido até o fim da rodada (para
decidir se a narração deve ser descartada quando há chamadas). A retenção não
esconde a atividade: o tool loop reporta ao turno cada fragmento real do provedor
antes da retenção, então a etapa ao vivo muda para "Recebendo resposta" e a idade
da última atividade continua correta mesmo com o texto ainda não publicado. O
detalhe é acomodado na própria superfície nativa de atividade (sem uma segunda
linha concorrente) e a linha local só aparece quando não há indicador nativo.

```powershell
node scripts/visual-ui-verify.mjs --execution-status-only
```

Modo focado: envia um pedido pelo compositor real com ferramentas habilitadas e
resposta pausada, e exige que o indicador nativo exista, que a etapa real
(`Recebendo resposta`/`Executando ferramenta`) e a idade da última atividade
estejam integradas nele, que o texto da rodada siga retido, que a linha local
não duplique a superfície e que, ao reconectar o canal e trocar de bot, nenhum
pedido seja reenviado nem o estado de execução vaze para o outro bot.

### Legibilidade e foco da recuperação

```powershell
node scripts/visual-ui-verify.mjs --readability-only
```

Usa Electron e um transcript descartável com falha em um turno que já executou
uma ferramenta; nenhuma ferramenta é executada. O transcript inclui também um
turno anterior completo. Repetir o turno falho poderia
duplicar efeitos, então o backend indica apenas conferir os resultados: o gate
exige que **nenhum** botão de nova tentativa exista e que o controle curto
"Conferir resultados e possíveis efeitos" apareça. Ao acioná-lo, o gate exige que
o histórico relevante seja destacado **pelas identidades informadas pelo
backend** (nenhuma linha de outro turno pode ser destacada), que a orientação
longa fique contida na linha sem gerar overflow horizontal, que o compositor
receba o foco para a nova instrução e que **nada** seja reenviado (contagem de
linhas do transcript inalterada e nenhum stream iniciado no fixture). Também
exige contraste mínimo de 4,5:1 no aviso após as animações e geometria estável
após a resposta, mantendo o controle curto com sua altura original.
Exercita viewports CSS de 704×768 e 1024×768, densidades CDP de 1 e 1,25 e
movimento reduzido. Essa emulação não comprova escalas reais do Windows.
Execute gates com janelas visíveis em série, usando os perfis temporários do
runner; não use atalhos ou dados reais para esta verificação.
O modo `--empty-onboarding-only` confere a primeira tela sem bots e o avanço
por “Continuar”, em vez de depender de um marcador interno de sessão.

## Gate do lifecycle de release local

Execute:

```powershell
npm run verify:release-lifecycle
```

O gate hermético cobre package, ZIP real com hash SHA-256 recalculado, install, preflight, repair, stage, update transacional com rollback, atalhos e uninstall. O inventário before/after prova encerramento do processo e da porta do fixture, ausência de locks/logs/roots transitórios e preservação explícita das raízes de dados. Também valida contenção integrada contra reparse points/junctions com sentinelas externas intactas, ownership de PID, raiz de dados fora da instalação, remoção verificada do tombstone `install.removing-*` e que os arquivos nativos obrigatórios sejam arquivos regulares. O escopo é a distribuição local Windows sem assinatura pública.

## Gate de primeiro boot/restart isolado

Execute:

```powershell
npm run verify:clean-profile
```

O gate compila o backend, valida a sintaxe do runner e executa duas vezes o
bootstrap real do gateway e do Electron separado (CDP) em uma `TempRoot` aleatória. `APPDATA`,
`LOCALAPPDATA`, `OPENBOT_DATA_ROOT`, `OPENBOT_LOCAL_DATA_ROOT`,
`OPENBOT_USER_DATA`, `OPENBOT_INSTALL_ROOT`, instalação e logs são redirecionados para essa raiz;
variáveis herdadas de token/chave/segredo são removidas antes do boot. O
primeiro boot consulta o roster vazio, aguarda no CDP `readyState=complete`,
título `OpenBot` e um `#root` populado, fecha o Electron por `Browser.close` e
encerra o gateway pelo shutdown autenticado com ownership; o segundo usa
exatamente os mesmos caminhos e confirma token/configuração persistidos, sem
bots inventados. O install temporário contém apenas `dist` e o grafo runtime
de MCP/SQLite/undici (mais o `electron/cli.js` usado pelo launcher); nenhum
provider real é chamado.

A comparação preserva todos os valores da configuração e exige revisão CAS
inteira, não negativa e monotônica. A revisão pode aumentar em gravações
idempotentes do renderer; esse aumento sozinho não é perda de configuração.

GREEN exige dois conjuntos de evidências de renderer OpenBot, fechamento do
Electron não-forçado com código de saída zero, porta, processo/
estado de ownership e logs estejam sem resíduos ou segredos; a `TempRoot` é
removida. Em RED, ela é preservada e o output informa somente o caminho
diagnóstico. O backend atual do Node usa o fallback local de keystore quando
não há keyring injetado; DPAPI CurrentUser só será afirmado após a Etapa 3.

## Gate de performance estrutural

Execute:

```powershell
npm run benchmark:hot-paths
```

GREEN exige paginação de transcript dentro do limite, FIFO por agente, sobreposição entre agentes, quota sem oversubscription, cache MCP, admissão limitada do runtime e fairness do browser compartilhado.

## Checkup mestre de prontidão

Execute:

```powershell
npm run verify:readiness
```

O runner usa um único `TempRoot`, remove credenciais herdadas dos subprocessos e
executa serialmente os 13 gates da especificação: isolamento do keystore,
lint/typecheck, build/paridade (incluindo proveniência e fronteira do renderer),
suíte Vitest padrão serial e recuperação de dados, aceites, Local Exec, browser,
clean-profile duas vezes, ACL live, WSL live, release, DPAPI live/restart e
inventário final. `npm test` exclui os arquivos de release lifecycle, recuperação
de dados, DPAPI live, inventário WSL live e browser E2E. Esses fluxos são cobertos
separadamente pelos gates de recuperação de dados (4), browser (7), WSL (10),
release (11) e DPAPI (12); a etapa padrão não é uma suíte completa por si só.
Recuperação de dados e DPAPI exigem relatório JSON com o arquivo esperado
coletado e executado, sem skips e com testes aprovados; saída zero sozinha não basta.
A suíte padrão permite skips somente em ACL, DPAPI live e doctor do host WhatsApp.
ACL e DPAPI são executados depois com opt-in; o doctor depende de instalação externa.
Qualquer outro skip observado torna o gate `RED`.

O resultado é `GREEN`, `RED` ou `BLOCKED_ENV`. Falta comprovada de Windows,
WSL2, rede pública, `icacls` ou pacote guest é `BLOCKED_ENV` e impede o veredito
`APTO`. Falha funcional ou resíduo é `RED`. O inventário compara porta 1340,
processos ligados ao `TempRoot`, `operation.lock`, distros WSL temporárias,
arquivos temporários e sentinelas do keystore real. Em `GREEN`, o `TempRoot` é
removido; em falha, fica preservado somente para diagnóstico.

## Gate padrão

### Cancelamento e exclusão de bots

### Fila de mensagens e cancelamento por turno

```powershell
npm exec --offline -- vitest run test/prompt-queue.test.ts test/prompt-queue-recovery.test.ts test/queue-task-overlay-regressions.test.ts test/rpc-send.test.ts test/rpc-send-gateway.integration.test.ts --maxWorkers=1 --no-file-parallelism
node scripts/visual-ui-verify.mjs --prompt-queue-only
```

Com o agente ocupado, pedidos com nonce e conversa resolvida são persistidos na
fila SQLite antes do retorno de aceitação. O executor FIFO permanece único por
agente. Pedidos ainda aguardando são recuperados no boot; pedidos que já começaram
são marcados como interrompidos, sem replay automático de ferramentas. A migração
eleva o schema a 19: rollback para versões antigas exige o backup compatível.
Anexos opacos ficam retidos enquanto vinculados à fila; caminhos externos são
revalidados na execução, e falhas são relatadas sem chamar o provider.

`cancelPrompt` sem escopo preserva a semântica abrangente de manutenção.
`scope: current` exige agente, conversa e turno; `scope: queued` exige agente,
conversa e nonce. A UI mostra Parar separado do envio e permite remover pendências.
O gate visual usa fixture offline, confirma ausência de sobreposição, enfileiramento
pelo cliente sem abortar a primeira resposta e remoção independente de pendência.

### Recuperação da fila, retenção e projeção de tarefas

Falhas de preparação anteriores ao echo permanecem `interrupted`, com conteúdo
recuperável no editor “Revisar”. A revisão exige confirmação explícita e recebe
um novo nonce vinculado ao pedido original; repetir a mesma revisão depois de
perder o ACK não executa outro turno. Mensagens cujo echo já existe não entram
nesse fluxo: o usuário deve verificar o histórico e os possíveis efeitos.
Pedidos de conversa arquivada podem ser dispensados, mas não reexecutados.

O schema 19 recupera registros legados marcados `completed` sem echo antes de
compactá-los. Terminais `completed`/`cancelled` mantêm identidade, digest e vínculo
da revisão, sem payload integral; a transição compacta o pedido novo e o boot
compacta até 100 terminais antigos por execução. Interrompidos não são apagados
por essa compactação. Migração e validação usam apenas bancos descartáveis nos
testes; não apontar o gate para o banco real.

Cancelamento libera a vaga exatamente uma vez e reconcilia a atividade do bot.
O status agregado atende vários bots em uma RPC, preservando a consulta legada.
A UI identifica a conversa, mostra erros de remoção inline e limita a apresentação
a 100 pendências recuperáveis. O gate `--prompt-queue-only` usa main/preload e
SQLite reais de fixture: falha de anexo, abertura/foco do editor, substituição por
upload, envio explícito e exatamente uma resposta. O editor não altera o rascunho
do composer. Nenhum provider externo é chamado.

```powershell
node scripts/electron-p22-tasks-verify.mjs
npm run verify:client-artifacts
npm run verify:renderer-boundary
npm run verify:provenance
```

O gate de tarefas usa Electron e bridge de fixture, cobrindo listagem atrasada
após conclusão pelo stream, envelope real de eventos, classes dos indicadores e
duração distinta de tempo relativo. O teste de reconciliação do transcript mede
trabalho interno: 200 mutações de texto não refazem a decoração global e mudanças
da mesma linha são agrupadas por frame. Isso não comprova ganho de FPS no perfil
real. Execute gates com janelas em série e `ELECTRON_EXE` apontando ao Electron local.

### Encerramento seguro para exclusão

```powershell
npm exec --offline -- vitest run test/agent-deletion-lifecycle.test.ts test/roster-agents.test.ts test/electron-windows-patches.test.ts --maxWorkers=1 --no-file-parallelism
node scripts/visual-ui-verify.mjs --cancel-collapsed-only
node scripts/visual-ui-verify.mjs --delete-timeout-only
```

Os runners visuais usam perfis e bots descartáveis; configure `ELECTRON_EXE` para
o Electron local. A exclusão bloqueia novas operações, solicita cancelamento e
limita a espera inicial de encerramento a cinco segundos. Timeout não autoriza
limpeza: o bot e seus dados permanecem, e a proteção só é liberada após prova de
encerramento bem-sucedido. Falha no encerramento mantém a proteção até recuperação
por reinício. O teste de UI verifica erro recuperável e fechamento do diálogo;
o teste de cancelamento exige abort observado com a sidebar recolhida.

Para a verificação comum, use:

```powershell
npm run typecheck
npm test -- --maxWorkers=1 --no-file-parallelism
```

 Esses comandos não substituem os gates acima: o primeiro não inicializa Electron/Windows ACL, e o segundo não inclui a verificação E2E desktop nem força o teste ACL live.

O antigo aceite consolidado de 17/08/2026 foi retirado. A retificação e a evidência atual estão em [OpenBot — correção da auditoria de persistência e lifecycle](openbot-persistence-correction-2026-08-17.md).
