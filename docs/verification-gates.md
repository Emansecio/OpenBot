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

Todos os providers e dados usados são fixtures locais descartáveis. O resultado
não comprova disponibilidade, limites ou comportamento de serviços comerciais
externos.

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

## Gate visual da interface

Execute:

```powershell
npm run verify:visual-ui
```

O gate usa Electron real para conferir a tela de boas-vindas, animação, foco, perfil local persistente, layout de settings e CTAs neutros. Ele também impede o retorno dos elementos legados de conta/Sign out. No modo visual isolado, a ausência do gateway em `127.0.0.1:1340` pode produzir `ECONNREFUSED` esperado; o E2E desktop é a prova complementar com gateway real.

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
typecheck, build/paridade, suíte Vitest completa, aceites, Local Exec, browser,
clean-profile duas vezes, ACL live, WSL live, release, DPAPI live/restart e
inventário final. A suíte isolada pode omitir somente ACL e DPAPI live — ambos
obrigatoriamente executados depois com os opt-ins ativos — e o doctor do host
WhatsApp, que depende de uma instalação externa fora da matriz temporária.
Qualquer outro skip torna o gate `RED`.

O resultado é `GREEN`, `RED` ou `BLOCKED_ENV`. Falta comprovada de Windows,
WSL2, rede pública, `icacls` ou pacote guest é `BLOCKED_ENV` e impede o veredito
`APTO`. Falha funcional ou resíduo é `RED`. O inventário compara porta 1340,
processos ligados ao `TempRoot`, `operation.lock`, distros WSL temporárias,
arquivos temporários e sentinelas do keystore real. Em `GREEN`, o `TempRoot` é
removido; em falha, fica preservado somente para diagnóstico.

## Gate padrão

Para a verificação comum, use:

```powershell
npm run typecheck
npm test -- --maxWorkers=1 --no-file-parallelism
```

 Esses comandos não substituem os gates acima: o primeiro não inicializa Electron/Windows ACL, e o segundo não inclui a verificação E2E desktop nem força o teste ACL live.

O antigo aceite consolidado de 17/08/2026 foi retirado. A retificação e a evidência atual estão em [OpenBot — correção da auditoria de persistência e lifecycle](openbot-persistence-correction-2026-08-17.md).
