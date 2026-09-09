# OpenBot — ambiente prático completo por bot

> **Status:** execução autorizada pelo usuário em 15/08/2026, sem gates de confirmação.
> **Meta:** partir de zero bots reais, criar bots sob demanda e entregar workspace, runtime Developer, recuperação e navegação web visual completos.

## Decisões

- Os 27 bots atuais são dados de teste descartáveis. Antes da limpeza haverá backup verificável; a remoção será recuperável por quarentena.
- O produto deve aceitar `agents: []`. Nenhum `openbot-default` será criado silenciosamente.
- Cada bot mantém home, perfil de navegador, downloads, transcript, quota e estado próprios.
- Processos Linux usam uma única distro WSL2 gerenciada `OpenBotRuntime`, iniciada sob demanda. `Ubuntu` e `Ubuntu-24.04` nunca são alvos de comandos mutáveis.
- O runtime é empacotado por uma distro de build descartável `OpenBotBuild`, com supervisor estático, rootfs versionado, manifests/hash e ativação transacional com rollback.
- O navegador visual usa um único host Electron/Chromium Windows sob demanda. Cada bot recebe uma `partition` persistente exclusiva, janela própria quando ativa e downloads em sua home. Isso é isolamento de aplicação/Chromium, não kernel separado.
- Todo tráfego do navegador passa por proxy local autenticado. O proxy resolve DNS e bloqueia loopback, LAN, link-local, multicast e metadata cloud em cada conexão/redirecionamento. CDP e portas internas nunca são expostos ao modelo, renderer ou LAN.
- Lite continua funcional se WSL ou navegador estiverem indisponíveis.

## Fluxo prático

1. Primeiro boot mostra estado vazio e ação de criar bot.
2. Criação persiste config somente depois de criar e validar a home.
3. Lite oferece arquivos, busca e navegador visual; Developer adiciona `process.run` no guest.
4. Browser abre visivelmente, mantém cookies apenas daquele bot e permite navegação, snapshot acessível, clique, digitação, screenshot, download, upload da home e handoff ao usuário.
5. Delete bloqueia novos turnos, aborta tool calls, fecha browser, destrói leases/processos, faz flush do transcript e move dados para quarentena.
6. Restore/import/export validam identidade, hashes, tamanho e paths antes da ativação.
7. Boot reconcilia leases e browsers órfãos de modo conservador e nunca apaga workspace válido automaticamente.

## Superfícies

- `ConfigStore`: zero-agent válido; sem fallback implícito.
- `AgentHomeStore`: inventário, DACL, export, import, restore, repair e quarentena.
- `RuntimeManager/WslProvisioner`: recovery no boot, package externo coerente, integridade real, staging/current/previous e rollback.
- `BrowserSessionManager`: leases por `agentId/sessionId/tabId`, controle estruturado e teardown.
- `LocalExecutionBroker`: operações browser usam a mesma permissão/fence dos tools locais.
- RPC/UI: onboarding vazio, status factual, ações de lifecycle e painel/handoff do navegador.

## Gates obrigatórios

1. Boot limpo com zero bots e criação pela UI/RPC.
2. Dois bots sem leitura cruzada de homes, transcripts, cookies, tabs ou downloads.
3. Lite funciona sem WSL; Developer executa binário no guest real com seccomp ativo.
4. Empacotamento reproduzível, hash do rootfs verificado, install transacional e rollback comprovado.
5. Crash/restart não deixa lease, cgroup, mount, browser ou CDP residual.
6. Navegação visual real, screenshot, interação, download e handoff por bot.
7. Proxy bloqueia SSRF/LAN/metadata, inclusive redirect e DNS rebinding.
8. Delete é recuperável; restore/export/import/repair passam casos adversariais.
9. Snapshot WSL antes/depois prova que distros pessoais não foram alteradas.
10. Typecheck, suíte completa, E2E desktop e ensaio final em estado isolado ficam verdes.

## Fora da declaração de segurança

- WSL2 compartilha um kernel; não equivale a VM por bot.
- Partições Chromium separam estado web, mas não equivalem a kernel separado.
- Código deliberadamente hostil continua fora do perfil Developer compartilhado e exige `isolated-vm` futuro.
