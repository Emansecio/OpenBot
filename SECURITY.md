# Segurança do OpenBot

Este documento define as fronteiras de confiança do OpenBot para uso pessoal local no Windows. Ele ajuda o operador a escolher o modo correto para cada bot e evita interpretar controles de aplicação como uma VM completa.

## Modelo de ameaça

O OpenBot é um aplicativo single-user. A conta Windows, o processo principal, a instalação local e as configurações aprovadas pelo usuário são confiáveis. Prompts, páginas web, respostas de providers, conteúdo de arquivos e resultados MCP podem ser não confiáveis.

O produto não promete isolamento entre usuários hostis na mesma máquina, execução segura de plugins arbitrários, resistência a falhas do kernel/hipervisor ou contenção integral do aplicativo em relação ao host.

## Fronteiras por componente

### Dados e homes dos bots

Transcript, nonces, configurações, autorizações, workspace e perfil de navegador são particionados por `agentId`. Cada home possui manifesto de identidade, paths confinados, proteção contra traversal e links, operações limitadas e DACL verificada para a conta atual, SYSTEM e administradores.

A DACL protege os dados contra outras contas do Windows; ela não separa bots executados sob a mesma conta. A separação entre bots depende do broker, da validação de paths e dos mounts exclusivos do runtime.

### Ferramentas estruturadas

Leitura, escrita, organização e busca passam por contratos estritos, workspace canônico e quota compartilhada. Esses controles reduzem a autoridade entregue ao modelo, mas continuam dentro do processo Node confiável.

### Runtime Developer

Todos os bots usam `runtimeMode: developer`. `process.run` executa processos nativos no host Windows confiável, sob a conta do usuário, via `LocalRuntimeDriver` e `LocalProcessRunner`. O pedido passa por contrato estruturado (`executable`, `argv`, `cwd`, `env`); não há shell arbitrário na bridge HTTP. O processo preserva o perfil e as credenciais do usuário. Herda o ambiente do OpenBot sem variáveis cujo nome indique credencial (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASSPHRASE`, `CREDENTIAL`) e sem a configuração interna `OPENBOT_*`/`SAND_*` (incluindo o token do gateway), acrescenta defaults de temporários/cache em `.openbot-runtime` na home do bot e aplica `env` explícito por último (nomes sem distinção de maiúsculas no Windows), pode invocar qualquer executável instalado, usar `cwd` relativo no workspace do agente ou `cwd` absoluto em qualquer unidade montada, e usa rede do host (`networkProfile` aceita somente `"host"`). Não há contenção de kernel, sandbox WSL2 nem allowlist de binários em produção; a fronteira é a confiança no operador, no provider e no prompt.

Os dados do próprio OpenBot (`%APPDATA%\OpenBot`, `%LOCALAPPDATA%\OpenBot` com instalação, backups, perfil Electron, runtime e navegador, além de configuração, `store.db` e token do gateway) e as homes de outros bots são caminhos protegidos: as ferramentas de arquivo e busca os recusam por caminho absoluto, alias 8.3 ou junction, a busca a partir de um ancestral os pula, e `process.run` recusa `cwd` ou executável dentro deles. A própria home do bot continua acessível, exceto sua pasta interna `.openbot` (grants, auditoria, lixeira), que a busca e o upload do navegador também recusam. Caminhos UNC que voltam para esta máquina (`\\localhost`, `\\127.0.0.1`, o próprio nome) ou compartilhamentos administrativos (`C$`, `ADMIN$`) são recusados, porque contornariam os caminhos protegidos; compartilhamentos remotos comuns continuam acessíveis. Como o processo roda sob a mesma conta, um programa ainda pode abrir esses arquivos pelos seus argumentos; o bloqueio remove os caminhos diretos das ferramentas e o prompt instrui o modelo a não usá-los, mas não é uma fronteira do sistema operacional.

Os grants de pastas do usuário (`shared://Documents` etc.) organizam atalhos por bot; não restringem acesso, já que caminhos absolutos do host são abertos a todos os bots.

Job Objects nomeados e identidades versionadas no journal permitem encerrar e reconciliar árvores de processos gerenciadas sem terminar processos por PID isolado. Registros legados sem prova de ownership permanecem bloqueados para recuperação manual. Job Objects controlam o ciclo de vida, não reduzem as permissões da conta Windows. O runtime continua de primeiro plano e limitado; não fornece uma API de daemons livres ou serviços persistentes.

A quota do workspace é verificada antes, durante e depois do processo, com observador compartilhado por home e reconciliação periódica/final; excedê-la aborta a execução e bloqueia novas enquanto o workspace permanecer acima do limite. Operações que não aumentam o uso (mover para a lixeira, sobrescrever com um arquivo menor) continuam permitidas acima do limite, para o bot liberar espaço. A lixeira do bot não conta na quota. NTFS não fornece quota transacional por pasta para bots sob a mesma conta: pode existir pequena ultrapassagem entre uma escrita e a próxima medição, e arquivos já gravados não são revertidos automaticamente.

### Navegador

O host Electron é compartilhado e iniciado sob demanda. Cada bot recebe partição persistente, downloads e leases próprios. Páginas usam renderer sandboxed, `contextIsolation`, `nodeIntegration: false`, permissões negadas e proxy autenticado que bloqueia loopback, redes privadas, endereços especiais e rebinding. O processo auxiliar recebe uma allowlist mínima de ambiente; chaves de provider e tokens arbitrários do pai não são herdados. Os tokens do pipe e do proxy saem do ambiente do host logo após a leitura, para não chegarem aos processos do Chromium. O proxy exige autenticação de todo cliente, inclusive local; WebSockets passam por ele como o resto do tráfego.

Certificados de cliente (mTLS) e seletores de Bluetooth, HID, serial e USB são sempre recusados; diálogos `alert`/`confirm` são desativados. Os nomes de elementos no snapshot nunca trazem o valor de campos de senha, ocultos, de cartão ou de código de uso único, e os scripts de leitura rodam num mundo JavaScript isolado da página. Popups e links `target=_blank` abrem na mesma aba.

A janela do bot abre atrás das janelas do usuário e nunca toma o foco; só `handoff` a traz para frente. Durante o handoff a aba fica sob controle do usuário: comandos do agente são recusados até o usuário sair da janela (ou em 60 s, se ele não a ativar), e a lease não expira nesse período. O título mostra a origem da página, não o título que ela declara. Fora do handoff, a página não consegue gravar na área de transferência do Windows em reação a um clique do agente.

Downloads ficam na pasta `Downloads` da home, revalidada a cada download contra junctions, com no máximo 20 por aba e 200 MB por sessão além do limite por arquivo; downloads concluídos contam na quota da home, e o que a estoura é removido.

Manutenção fecha e drena sessões sem apagar o estado persistente da partição. Apagar esse estado é uma operação separada, usada na exclusão explícita do bot; se outro bot mantém o host aberto, cookies e armazenamento são limpos na hora e a pasta da partição é apagada quando o host para.

Partições separam estado web normal, mas o processo principal do browser continua compartilhado sob a conta Windows. Isso não equivale a um processo ou VM por bot e não promete proteção contra comprometimento do Electron/Chromium.

### MCP

Servidores MCP ficam deny-all até receberem allowlist explícita por bot. HTTP exige HTTPS, exceto loopback, com validação e pinagem de DNS. Stdio usa apenas o runtime Node empacotado com o OpenBot (outros lançadores, como npx, python e uvx, são recusados ao salvar o servidor), ambiente mínimo e referências de segredo resolvidas somente no host. Endereços IPv6 de transição que alcançam IPv4 privado (6to4, Teredo, NAT64) são recusados como destino HTTP.

Cada servidor escolhe o escopo da sessão:

- `shared` ou campo omitido: uma sessão lazy é reutilizada entre bots autorizados; use apenas para servidores stateless ou cujo estado compartilhado seja intencional;
- `agent`: conexão e cache são separados por bot e encerrados quando o bot é removido; use para servidores stateful ou com contexto por sessão.

No transporte HTTP, `agent` separa o cliente local, mas o serviço remoto ainda pode compartilhar estado por credencial ou conta. MCP stdio continua sendo código confiável escolhido pelo operador e executado sob a conta Windows, sem sandbox.

### Skills e credenciais

Skills locais são descobertas e lidas através de paths validados, limites de tamanho e rejeição de symlink/junction. Elas orientam o modelo, mas não são uma fronteira de segurança.

Chaves de provider ficam no keystore e são descriptografadas somente no host confiável. Valores não voltam por RPC, transcript ou cards. O runtime Developer herda o ambiente do processo OpenBot e mescla variáveis explícitas do pedido validado.

## Componentes compartilhados

Para manter baixo consumo, os bots compartilham o processo Node, o banco SQLite, o host Electron, o proxy de egress, o catálogo de Skills e o manager MCP. O estado persistente e as leases são particionados; compartilhar infraestrutura não cria uma fronteira de kernel entre bots.

## Configuração recomendada

- Ative bots somente com providers e prompts confiáveis: o modelo pode executar qualquer comando na sua conta Windows.
- Trate `process.run` como execução nativa no host, não como sandbox isolado.
- Use `sessionScope: agent` em MCP stateful; mantenha `shared` apenas quando o compartilhamento é esperado.
- Não encaminhe segredos ao workspace, aos argumentos do processo ou a servidores MCP que não sejam confiáveis.
- Preserve backups e use o Recovery Center antes de mudanças importantes.

## Verificação local

Os gates relevantes são:

```powershell
npm run typecheck
npm run verify:skills-mcp
npm run verify:e2e:browser
npm test -- --no-file-parallelism
```

Testes usam AppData e homes temporários.

## Relato responsável

Ao relatar um problema ao mantenedor local, inclua a reprodução mínima, o componente, o modo do bot, o resultado esperado e o observado. Remova API keys, tokens, cookies, prompts privados, homes reais e conteúdo de conversas antes de anexar logs ou diagnósticos.
