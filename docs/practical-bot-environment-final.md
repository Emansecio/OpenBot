# OpenBot — ambiente prático final dos bots

> **Registro histórico:** este documento descreve o aceite de agosto de 2026, incluindo WSL e estado local daquela execução. O checkout usa runtime nativo Windows por padrão; WSL é restrito ao bootstrap de testes. Consulte o [README atual](../README.md) e o [bootstrap](../src/main.ts). Resultados abaixo não comprovam a revisão atual.

**Estado:** concluído em 15/08/2026  
**Leitor:** usuário do OpenBot e mantenedor local  
**Objetivo operacional:** iniciar com zero bots, criar somente bots reais sob demanda e usar arquivos, processos Linux e navegação web visual sem compartilhar o estado privado de um bot com outro.

## 1. Resultado entregue

O OpenBot está pronto para uso prático com roster vazio. Os 27 bots anteriores eram dados de teste; eles não aparecem mais como bots ativos e suas homes foram preservadas em quarentena recuperável. Nenhum bot default é recriado no boot.

Cada novo bot recebe:

- home persistente e identificada;
- pastas Desktop, Documents, Downloads e Projects;
- quota, inventário e DACL da home;
- transcript e estado operacional particionados pelo identificador do bot;
- perfil persistente exclusivo do Chromium;
- navegação web visual;
- ferramentas estruturadas de arquivos e busca;
- `process.run` no modo Developer, executado no guest Linux gerenciado;
- lifecycle de repair, export, import, quarentena e restore.

Não existe uma VM por bot. O desenho usa serviços compartilhados e lazy para reduzir consumo, mantendo o estado persistente separado por bot.

## 2. Arquitetura final

```text
OpenBot desktop
├─ gateway local e store compartilhado
│  ├─ configuração e roster
│  ├─ transcript particionado por agentId
│  └─ broker de permissões e lifecycle
├─ homes NTFS
│  └─ uma árvore persistente por bot
├─ OpenBotRuntime (WSL2, compartilhado e lazy)
│  └─ um sandbox Linux por execução Developer
└─ host Electron/Chromium (compartilhado e lazy)
   └─ partition, janela, tabs e downloads por bot
```

| Recurso | Compartilhado | Separado por bot |
|---|---|---|
| Gateway Node/TypeScript | um processo local | filas, turns e ownership por `agentId` |
| SQLite | um arquivo operacional | transcripts, nonces, decisões e runtime owners |
| WSL2 | uma distro `OpenBotRuntime` | workspace, processo, cgroup, mounts e leases |
| Browser | um host Electron sob demanda | partition persistente, janela, tabs e downloads |
| Arquivos | mesma instalação do OpenBot | home NTFS canônica e DACL |

Os serviços pesados não ficam abertos por bot. WSL e Electron iniciam quando necessários e encerram quando não há mais leases.

## 3. Lifecycle de um bot

### 3.1 Criação

1. O usuário seleciona **New chat**.
2. No seletor **To: Search or create Bots**, escolhe **Create new Bot**.
3. A home é criada e validada antes de a configuração do bot ser confirmada.
4. O bot passa a aparecer no roster somente depois do bootstrap consistente.

Uma instalação nova aceita `agents: []`. Não há fallback para `openbot-default`.

### 3.2 Uso

- Lite fornece chat, arquivos, busca e browser visual.
- Developer adiciona execução Linux por `process.run`.
- Turns do mesmo bot são serializados; bots diferentes podem trabalhar em paralelo.
- Browser, processos e ferramentas obedecem ao mesmo fence de lifecycle e permissões.

### 3.3 Exclusão

A exclusão:

1. impede novos turns;
2. aborta operações em andamento;
3. encerra leases e processos;
4. fecha tabs e estado de browser ativo;
5. faz flush do estado persistente;
6. grava e valida o marcador de quarentena;
7. move a home por rename atômico;
8. remove o bot do roster.

Na exclusão em lote, se uma home posterior falhar, as homes já movidas são restauradas. A remoção não é tratada como concluída com estado parcial.

### 3.4 Restore, repair, export e import

- **Restore:** devolve uma home válida da quarentena. Se a limpeza do marcador falhar, a operação volta para a quarentena. O restore não recria o bot, transcript, configuração de provider nem perfil persistente do browser.
- **Repair:** recria somente diretórios canônicos ausentes; não reescreve arquivos do usuário.
- **Export:** produz arquivo com manifesto, identidade, tamanhos e hashes.
- **Import:** valida paths, identidade, hashes e limites antes de promover a home.

Fluxo exato para recuperar uma home e voltar a usá-la:

1. chame `listQuarantinedAgents` com `{}` e selecione o `quarantineId` correto;
2. chame `restoreAgentHome` com `{ "agentId": "<id>", "quarantineId": "<quarantineId>" }`;
3. recrie o bot com `createAgent`, usando o mesmo `id` e informando novamente nome, modo e metadados desejados;
4. configure provider/modelo e abra um novo chat, se necessário.

O terceiro passo apenas reassocia o roster à home já restaurada: `createAgent` chama `ensure` para validar/reutilizar a home existente. Use a mesma identidade somente depois do restore; uma home ativa impede restauração por cima e um bot ativo impede criação duplicada.

## 4. Home e ferramentas locais

A raiz operacional é `%LOCALAPPDATA%\OpenBot\workspaces`. Cada bot usa exatamente `%LOCALAPPDATA%\OpenBot\workspaces\<agentId>`.

Operações disponíveis:

| Operação | Função | Limite principal |
|---|---|---|
| `file.list` | listar diretórios | somente dentro da home |
| `file.read` | ler arquivo | UTF-8/base64 e limite de tamanho |
| `file.write` | escrita atômica | parent válido dentro da home |
| `search.files` | localizar arquivos | sem processo externo |
| `search.text` | buscar conteúdo | ignora binários e aplica limites |
| `browser.*` | browser visual | lease e partition do bot |
| `process.run` | processo Linux | somente no modo Developer |

Paths absolutos, traversal, ADS, nomes de device Windows, symlinks, junctions e reparse points inseguros são rejeitados. A home passada ao WSL deve ser exatamente a raiz canônica do bot, não apenas uma pasta com o mesmo nome.

## 5. Modos Lite e Developer

### Lite

Lite não depende do WSL para chat, arquivos, busca ou browser. Se a distro estiver indisponível, o bot continua utilizável nessas capacidades.

### Developer

Developer publica `process.run`. A execução ocorre dentro do guest Linux com:

- rootfs versionado e verificado;
- supervisor Rust estático;
- seccomp obrigatório (`Seccomp: 2`);
- cgroup por execução;
- mounts controlados;
- `/dev` mínimo;
- workspace canônico do bot;
- abort, timeout, release e teardown;
- limpeza de processos, mounts e cgroups residuais.

O guest suporta subprocessos legítimos, inclusive `spawnSync`, sem liberar syscall ou path host arbitrário.

## 6. Runtime WSL2 gerenciado

### 6.1 Distros

- `OpenBotRuntime`: distro de execução instalada, compartilhada e parada quando ociosa.
- `OpenBotBuild`: distro descartável usada apenas para construir/validar o pacote; removida após o gate.
- `Ubuntu` e `Ubuntu-24.04`: distros pessoais; não são usadas como alvo mutável pelo OpenBot.

### 6.2 Pacote e promoção

O pacote contém supervisor, rootfs, policy, manifesto e configuração WSL. A promoção é transacional:

1. pacote e manifesto entram em staging;
2. tipo do binário, versão e hashes são verificados;
3. a imagem candidata é instalada e testada;
4. `current` é promovido;
5. a imagem anterior fica disponível para rollback;
6. falha interrompe a promoção e preserva a versão válida anterior.

Digests do gate final:

| Artefato | SHA-256 |
|---|---|
| Supervisor | `35cc7499f7df729ccf440f0f230b4196ad3ef7c792346a9707d29775198308cc` |
| Rootfs | `9997f75923a62c24ada384f6dc1659e0374d9d9689faafd14c5e5585755fec63` |
| Archive | `b7653bcc9cfbd74a38ff040f0ab840891c780396baf5de39b8672beddc240266` |

### 6.3 Gate real

Foram validados no `OpenBotRuntime`:

- start e health;
- `process.run` e subprocesso;
- escrita confinada no workspace;
- seccomp ativo;
- abort;
- release e teardown;
- ausência de resíduos após encerramento.

## 7. Navegação web visual completa

O browser é headed: a janela pode ser entregue ao usuário por handoff. O bot controla somente comandos estruturados; não recebe CDP, porta de debugging ou acesso genérico ao Electron.

O runner E2E isolado é a única exceção: ele inicia a sua própria instância temporária com `--remote-debugging-port` para inspecionar a UI durante o teste e confirma que a porta foi liberada no teardown. Esse argumento não pertence ao startup de produção e não expõe CDP ao bot.

Operações:

- abrir e navegar;
- snapshot acessível com texto visível;
- clique por coordenadas;
- digitação;
- screenshot de viewport;
- screenshot full-page real;
- download para a home;
- upload de arquivo da home;
- fechar tab;
- handoff visual ao usuário.

### 7.1 Isolamento por bot

Cada bot recebe uma partition persistente derivada do seu identificador. Cookies, storage, cache, tabs e downloads não são reutilizados por outro bot. No teardown do agente, a partition correspondente é removida.

Leases expirados fecham a tab antes de serem descartados. Se o host for compartilhado com outros bots, somente a sessão expirada é limpa; o host é encerrado quando não há mais leases.

### 7.2 Canal de controle

O manager e o host usam named pipe Windows privado e autenticado. Cada frame exige token de sessão. Respostas seguem pelo stdout herdado do processo. Não existe listener CDP externo.

### 7.3 Egress e SSRF

Todo tráfego passa por proxy local autenticado. O proxy:

- resolve DNS antes de conectar;
- fixa a resolução usada na conexão;
- bloqueia loopback, LAN, link-local, multicast e metadata cloud;
- repete validações em redirect;
- não encaminha credencial do proxy para a origem;
- impede bypass direto do browser.

### 7.4 Screenshot full-page

A captura usa `Page.captureScreenshot` somente dentro do processo Electron. Não abre porta de remote debugging. Limites:

- 8192 px por eixo;
- 16 megapixels;
- PNG de até 5 MiB.

### 7.5 Upload seguro

O upload aceita somente path relativo dentro da home e arquivo regular de até 4 MiB. O backend e o host validam o caminho. O host abre o arquivo e verifica o mesmo descritor antes e depois da leitura.

São rejeitados:

- path absoluto ou traversal;
- ADS e componentes Windows inválidos;
- symlink, junction ou reparse point;
- arquivo fora da home;
- arquivo especial ou acima do limite;
- hardlink com `nlink > 1`;
- filesystem que não forneça metadado de links confiável.

A regressão final cria um hardlink real dentro da home apontando para um arquivo externo e confirma a rejeição sem vazar o path do alvo.

## 8. Segurança e limites honestos

### Garantias implementadas

- homes canônicas com DACL e containment;
- validação duplicada em fronteiras críticas;
- operações estruturadas em vez de shell host arbitrário;
- secrets locais protegidos pelo backend seguro do Electron/DPAPI;
- browser sem CDP exposto;
- egress web mediado;
- runtime Linux com seccomp, cgroups e mounts;
- quarentena recuperável e operações de promoção atômicas;
- erros sanitizados sem paths privados.

### O que não é isolamento de kernel por bot

- bots compartilham o mesmo Windows e a mesma identidade do usuário;
- `OpenBotRuntime` compartilha uma distro e kernel WSL2;
- partitions Chromium separam estado web, mas não são VMs;
- código deliberadamente hostil não deve ser tratado como seguro apenas por estar no modo Developer.

Esse limite é intencional para manter o computador leve. Uma VM/container permanente por bot não faz parte da arquitetura entregue.

## 9. Estado real após a preparação

| Item | Estado final verificado |
|---|---:|
| Bots ativos | 0 |
| Homes ativas | 0 |
| Homes em quarentena | 27 |
| Quarentenas sem marcador/manifesto | 0 |
| Transcripts | 0 |
| Nonces aceitos | 0 |
| Decisões de interação | 0 |
| Runtime owners | 0 |
| Partitions de browser ativas | 0 |
| Processos Electron residuais | 0 |
| `OpenBotBuild` | removida |
| `OpenBotRuntime` | instalada e parada |

As distros pessoais `Ubuntu` e `Ubuntu-24.04` permaneceram instaladas e paradas.

## 10. Backups dos 27 bots de teste

### Backup pré-limpeza

`%LOCALAPPDATA%\OpenBot\backups\pre-practical-final-20260815-213052`

- 27 agentes;
- 27 homes ativas;
- 56 arquivos;
- zero divergências de hash;
- manifesto SHA-256 `e340cd702f407e116dd01d1de5ee09f03346e1858fba34f56d796b355a2d9b45`.

### Snapshot pós-limpeza

`%LOCALAPPDATA%\OpenBot\backups\pre-practical-final-20260815-213401`

- zero agentes ativos;
- 85 arquivos manifestados;
- zero divergências de hash;
- manifesto em `meta\manifest.json`;
- manifesto SHA-256 `03379688495ec7b00de20c511fed917a70cd46164657780d311565e4df5c34ec`.

As 27 homes também permanecem na quarentena operacional. Nada foi descartado de forma irrecuperável.

## 11. Evidência de aceite

### Automação

| Gate | Resultado final |
|---|---|
| suíte Vitest serial | 81 arquivos, 806 testes passando, 1 skipped |
| `npm run typecheck` | verde |
| `npm run build` | verde |
| `npm run verify:core:acceptance` | 3/3 cenários integrados |
| `npm run verify:acl:live` | 6/6 testes reais de ACL Windows |
| `npm run verify:e2e:desktop` | `GREEN`; inventário real, streaming, cancelamento e Skill; teardown completo |
| `npm run verify:e2e:browser` | 10/10; Electron real, dois bots, segurança e fail-fast |
| `npm audit --omit=dev` | 0 vulnerabilidades com Electron 41.10.5 |
| `npm run smoke:local` | create/delete/restart e `zeroAgentAfterRestart: true` |
| Sintaxe do host Electron | verde |
| `npm run verify:skills-mcp` | `GREEN`; 132 testes focados, 3 cenários core e Electron isolado |
| Electron Skills | `GREEN`; menu `/`, chip, 1 resposta final, renderer ocioso |
| `npm run verify:runtime-wsl-live` | `GREEN`; install, identidade, seccomp, rede, timeout, abort, recovery, rollback e cleanup |
| Supervisor Rust | 16 testes no build oficial do guest |
| Re-review funcional | sem bloqueio crítico/importante |
| Re-review de segurança | vetores concretos fechados; limite teórico de `cwd` documentado |

Comandos reproduzíveis do gate comum:

```powershell
npm run typecheck
npm test -- --maxWorkers=1 --no-file-parallelism
npm run build
npm run smoke:local
npm run verify:skills-mcp
npm run verify:runtime-wsl-live
```

A revisão consolidada de interface/backend, correções e evidências está em [`openbot-polish-review-2026-08-16.md`](openbot-polish-review-2026-08-16.md). Os gates Windows/desktop e seus efeitos estão descritos em [`verification-gates.md`](verification-gates.md).

Gate Electron isolado, usando o Electron instalado no próprio projeto:

```powershell
npm run build
$electronExe = (Resolve-Path 'node_modules\electron\dist\electron.exe').Path
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\e2e-desktop-run.ps1 -ElectronPath $electronExe
```

O resultado esperado contém `E2E_RUNNER_SUMMARY` com `status: "GREEN"`, `ownedProcessesAbsent: true`, `portsFree: true` e `cleanup: "temp-root-removed"`. Esse runner usa AppData e user-data temporários.

Contratos automatizados do runtime guest:

```powershell
npm test -- --run test/runtime-build-pipeline.test.ts test/runtime-package.test.ts test/runtime-provisioning.test.ts test/runtime-driver.test.ts test/runtime-guest-host.test.ts test/runtime-process-backend.test.ts
npm run build:runtime-guest
wsl.exe -l -v
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build-runtime-guest.ps1 -Action Cleanup
npm run verify:runtime-wsl-live
```

Pré-condições do build WSL: WSL2 funcional e PowerShell executado no checkout. O build pode usar `OpenBotBuild` somente no pipeline de empacotamento e deve produzir `%LOCALAPPDATA%\OpenBot\runtime\staging\openbot-runtime-package.tar`. O gate live usa uma distro aleatória própria `OpenBotRuntimeLive-<guid>` e nunca importa, termina ou unregistera `OpenBotBuild` ou uma distro pessoal.

O runner versionado `npm run verify:runtime-wsl-live` cobre o gate live completo de `process.run`/seccomp/abort/rollback e emite um resumo JSON. O browser visual também possui o gate reproduzível `npm run verify:e2e:browser`, incluindo upload e screenshot full-page.

#### Limite de rastreabilidade do gate live WSL

O resultado é reproduzível pelo comando acima: ele usa somente `OpenBotRuntimeLive-<guid>` e `TempRoot` próprio, valida package/digest, install/promotion/rollback, `process.run`, seccomp, abort, teardown e recuperação de lease órfã, e registra a prova WSL before/after. Qualquer falha de cleanup deixa o resumo `RED`.

### Não interferência no estado real

Antes e depois da suíte completa foram comparados path, tamanho e SHA-256 dos 353 arquivos existentes no AppData do OpenBot. O conjunto permaneceu idêntico. Os testes de integração usam config, SQLite, keystore, runtime, browser e workspaces temporários.

### Browser real

O gate versionado `npm run verify:e2e:browser` usa Electron real, fixture HTTP offline e dois bots isolados. Ele confirmou:

- open/navigate, snapshot/texto, click e type;
- screenshots de viewport e full-page;
- upload restrito à home e download/evento em `Downloads`;
- handoff visual e isolamento de partição/armazenamento entre dois bots;
- negativos de proxy, SSRF/esquema, permissões, popup, limites e hardlink;
- zero leases após release;
- zero processo Electron residual;
- remoção do perfil temporário.

Durante o aceite, o gate revelou `TypeError: Object has been destroyed` no callback de fechamento do host. O acesso passou a usar o ID capturado enquanto o `webContents` ainda estava vivo. O host também ganhou fail-fast para `uncaughtException` e `unhandledRejection`, com teste de injeção controlada que exige saída não-zero sem diálogo nativo bloqueante.

### Rehearsal prático

Em AppData isolado foram exercitados:

1. boot com zero bots;
2. criação de bot;
3. arquivo roundtrip;
4. browser visual;
5. exclusão e quarentena;
6. restart;
7. confirmação de zero bots e zero resíduos.

## 12. Uso diário a partir de agora

### Iniciar

```powershell
npm run desktop
```

### Criar o primeiro bot real

1. Abra **New chat**.
2. Use **To: Search or create Bots**.
3. Selecione **Create new Bot**.
4. Configure Name, Title, Description, provider, modelo e chave no painel nativo. O bot nasce com Title igual ao Name, mas os três campos passam a ser independentes e persistem ao sair do campo; Title é metadado visual, enquanto Name + Description compõem a identidade enviada ao modelo.
5. Deixe o bot em Lite para chat, arquivos e browser; ative Developer somente quando precisar de `process.run`.

### Skills e MCP no chat

- O bot pode descobrir sozinho uma Skill adequada por `search_skills` e carregá-la com `use_skill`; não é necessário digitar comando.
- Para escolher manualmente, digite `/`, selecione **Reference a skill** e continue escrevendo com o chip nativo no composer.
- O fallback textual `/skill <id> <pedido>` também é aceito sem alterar a mensagem preservada no transcript.
- Ferramentas MCP autorizadas entram automaticamente no mesmo loop do chat. O catálogo/conexões são compartilhados e lazy, mas a allowlist continua separada por bot e deny-all por padrão.
- A administração de servidores MCP usa as RPCs/configuração locais documentadas; nenhum segredo é exibido no chat ou devolvido pela RPC.

### Encerrar

Fechar o desktop encerra gateway, leases e hosts lazy. A home, transcript e partition persistente do bot continuam disponíveis para o próximo boot.

## 13. Diagnóstico e recuperação

### Browser não abre

Verifique se não há outro gateway ocupando `127.0.0.1:1340`. O host Electron deve iniciar somente na primeira operação de browser.

As janelas de erro vistas durante os primeiros gates não eram Java. Eram janelas Electron/JavaScript de tentativas em que host/proxy ainda falhavam no startup. O problema foi corrigido; os gates finais terminaram sem processo ou janela residual.

### Developer indisponível

```powershell
wsl.exe -l -v
```

`OpenBotRuntime` deve existir. Ela pode aparecer como `Stopped`; isso é normal quando ociosa. Lite continua operacional mesmo se o runtime Developer precisar de repair.

### Home inconsistente

Use inventário e repair antes de restaurar manualmente arquivos. Repair não deve alterar conteúdo do usuário.

### Exclusão acidental

Use a listagem de quarentena e restore. Não copie pastas manualmente para a raiz ativa, porque identidade, markers, DACL e manifesto fazem parte da validação.

## 14. Gates para alterações futuras

Antes de considerar uma mudança pronta:

```powershell
npm run typecheck
npm run build
npx vitest run --maxWorkers=1 --no-file-parallelism
npm run verify:core:acceptance
npm run verify:acl:live
npm run verify:e2e:desktop
npm run verify:e2e:browser
```

Mudanças em browser precisam repetir o gate Electron real. Mudanças em runtime precisam repetir package, manifest/hash, install/rollback, seccomp, subprocesso, abort e teardown. Testes nunca devem usar AppData real.

Mudanças em Skills/MCP precisam repetir os transportes reais HTTP/stdio, a suíte focada, o gate `/`/chip e a comprovação de uma única resposta final no painel principal.

O runtime de produção também injeta por padrão um reconciliador WSL que valida os identificadores persistidos, prova teardown de sandbox/temporários e só remove o registro do journal após cleanup confirmado. Cgroup já ausente após cleanup parcial é idempotente; erro de permissão, objeto inseguro ou ausência de prova continua fail-closed.

## 15. Pendências não bloqueantes

Não existe P0 aberta para o escopo prático entregue. Evoluções futuras possíveis:

- isolamento por VM para código deliberadamente hostil;
- políticas de aprovação mais granulares na UI;
- mais operações estruturadas de arquivo;
- observabilidade histórica de runtime e browser;
- automação visual adicional sem expor script genérico ou CDP.

Esses itens ampliam o produto; não são necessários para criar e usar os bots reais agora.

## 16. Documentos relacionados

- [Estado final da Fase 2](phase-2-local-execution-status.md)
- [Avaliação final de prontidão operacional em 17/08/2026](openbot-readiness-assessment-2026-08-17.md)
- [Aceite 100/100 dos três pilares](openbot-three-pillars-100-acceptance-2026-08-16.md)
- [Aceite 100/100 de Skills/MCP e Runtime/WSL](openbot-skills-mcp-runtime-100-acceptance-2026-08-16.md)
- [Progresso e fechamento](phase-2-local-execution-progress.md)
- [Runtime guest](../runtime/guest/README.md)
- [Design do ambiente prático](superpowers/specs/2026-08-15-openbot-practical-bots-complete-design.md)
- [Plano executado](superpowers/plans/2026-08-15-openbot-practical-bots-complete-plan.md)
- [Skills e MCP compartilhados no chat](shared-skills-mcp-chat.md)
