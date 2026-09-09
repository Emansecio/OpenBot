# Convergência de prontidão do OpenBot

Data da execução final: 2026-08-23  
Veredito: **APTO no escopo da matriz verificada**

## Resultado executivo

O workflow `ETAPA 1 > ETAPA 2 > ETAPA 3 > revisão > correção > checkup completo` foi concluído. Foram corrigidos 42 bugs confirmados. Depois da última correção, o checkup obrigatório terminou com os 13 gates GREEN e as revisões Luna dos fronts alterados terminaram CLEAN.

Isso não significa ausência absoluta de defeitos fora do escopo testado. Significa que não restou bug ou gargalo reproduzível na matriz local, live e de release descrita neste relatório.

## Etapas executadas

| Etapa | Escopo | Resultado |
| --- | --- | --- |
| 1 | Runner de prontidão, isolamento de paths, typecheck, build, paridade de artefatos, shutdown e clean profile | GREEN |
| 2 | Segredos, DPAPI, ACL, Local Exec, approvals e operações locais | GREEN |
| 3 | WSL real, browser Electron/público, lifecycle de release e inventário final | GREEN |
| Revisão iterativa | RED determinístico, correção mínima, GREEN focado e repetição do checkup completo | CLEAN após 42 correções |

## Checkup final

Comando: `npm run verify:readiness`

- Início: `2026-08-23T22:05:47.115Z`
- Fim: `2026-08-23T22:20:00.157Z`
- Duração: `853042 ms`
- Status: `GREEN`
- Veredito: `APTO`
- Cleanup: `temp-root-removed`

| Gate | Verificação | Resultado |
| ---: | --- | --- |
| 1 | Sentinela de isolamento de paths | GREEN |
| 2 | Typecheck | GREEN |
| 3 | Build e paridade de artefatos backend/client | GREEN |
| 4 | Suíte Vitest serial completa | GREEN — 124 arquivos, 1480 aprovados, 3 skips |
| 5 | Core acceptance, resiliência de chat e Skills/MCP | GREEN |
| 6 | Local Exec e approvals | GREEN |
| 7 | Browser Electron offline e público somente leitura | GREEN |
| 8 | Desktop clean-profile em duas rodadas | GREEN |
| 9 | ACL live | GREEN — 7/7 |
| 10 | WSL live | GREEN |
| 11 | Lifecycle de release | GREEN — 29/29 |
| 12 | DPAPI CurrentUser live e restart | GREEN — 5/5 |
| 13 | Inventário final | GREEN — sem issues |

Os três skips da suíte genérica são deliberados: o caso live de ACL é executado no gate 9, o caso live de DPAPI no gate 12 e o teste de WhatsApp depende de ambiente explicitamente habilitado. O runner registrou zero skips inesperados.

Inventário inicial e final:

- porta 1340 livre;
- nenhuma distro transitória;
- nenhum processo pertencente ao TempRoot;
- nenhuma entrada temporária residual;
- nenhum operation lock local ou global;
- nenhuma raiz de readiness obsoleta;
- sentinelas reais de `sand-secrets.json` e `.master.key` inalteradas.

Instalação e atalho reais:

- versão ativa `0.1.0` em `%LOCALAPPDATA%\OpenBot\install`;
- atalho `C:\Users\User\Desktop\OpenBot.lnk` preservado com SHA-256 `16B4F31ED55CBD4A0F3412791943987B310B085A9938C5FC88DB595480F1A47C` antes/depois do checkup;
- smoke pelo próprio atalho: gateway saudável, janela principal visível, nenhum console, segunda abertura controlada, fechamento gracioso, porta 1340 liberada e nenhum token em log;
- 104 diretórios históricos vazios `OpenBotRuntimeLive-*` foram validados e removidos do Menu Iniciar; a contagem final permaneceu zero.

## Bugs confirmados e corrigidos

| # | Falha confirmada | Correção aplicada | Evidência principal |
| ---: | --- | --- | --- |
| 1 | Traversal na versão de launch | Validação e confinamento da versão | `test/desktop-lifecycle-hardening.test.ts` |
| 2 | Rollback aceitava traversal e validava tarde | Validação antecipada e fail-closed | `test/release-lifecycle.test.ts` |
| 3 | Uninstall confiava em paths persistidos de atalhos | Paths derivados somente de raiz confiável | `test/desktop-lifecycle-hardening.test.ts` |
| 4 | Cliente WSL ignorava cleanup `{ok:false}` | Release só confirma cleanup aceito | `test/runtime-wsl.test.ts` |
| 5 | Runner herdava credenciais e variáveis `OPENBOT_*` | Ambiente filho sanitizado | `test/readiness-runner.test.ts` |
| 6 | Signer WebAuthn herdava o ambiente completo | Allowlist mínima de ambiente | `test/webauthn-bridge.test.ts` |
| 7 | Inventário não via `.openbot-operation.lock` | Busca ampliada para locks locais | `test/readiness-runner.test.ts` |
| 8 | Processos só eram encontrados pelo TempRoot no argv | Inventário por ownership e descendência | `test/readiness-runner.test.ts` |
| 9 | Prefixos longos colidiam no usuário guest | Identidade Linux determinística e sem colisão | `test/runtime-guest-users.test.ts` |
| 10 | Retry de cleanup WSL tinha corrida | Serialização e confirmação de teardown | `test/runtime-wsl.test.ts` |
| 11 | Provisionamento concorrente duplicava usuário guest | Provisionamento serializado | `test/runtime-guest-users.test.ts` |
| 12 | Identidade de sandbox divergente era aceita | Correspondência obrigatória de identidade | `test/runtime-wsl.test.ts` |
| 13 | Egress proxy tinha corrida entre close/start | Estado de lifecycle serializado | `test/browser-egress-proxy.test.ts` |
| 14 | Inventário WSL ignorava arquivo regular | Raiz validada fail-closed | `test/runtime-wsl-live-inventory.test.ts` |
| 15 | Mudança em distro WSL permanente não reprovava | Snapshot de estado antes/depois obrigatório | `test/runtime-build-pipeline.test.ts` |
| 16 | IPv6 site-local `fec0::/10` escapava da política | Classificação como rede privada | `test/browser-egress-proxy.test.ts` |
| 17 | Filhos do readiness e cache npm deixavam resíduos | Ambiente controlado, compile cache desligado e cleanup final | `test/readiness-runner.test.ts` |
| 18 | Raiz customizada de atalhos podia ser reutilizada sem prova | Root explícita, validada e transportada no wrapper | `test/release-lifecycle.test.ts` |
| 19 | Raiz do inventário WSL como arquivo passava GREEN | Verificação de diretório obrigatória | `test/runtime-wsl-live-inventory.test.ts` |
| 20 | Filtro de processos WSL ignorava executáveis arbitrários de usuários `ob-*` | Seleção por owner gerenciado | `test/runtime-wsl-live-inventory.test.ts` |
| 21 | IP de plataforma Azure `168.63.129.16` não era bloqueado | Inclusão explícita na política de metadata | `test/browser-egress-proxy.test.ts` |
| 22 | Raiz do inventário WSL como symlink passava GREEN | Detecção de link antes de existência/diretório | `test/runtime-wsl-live-inventory.test.ts` |
| 23 | Raiz stale `openbot-readiness-*` não diretório era ignorada | Inventário considera qualquer tipo de entrada | `test/readiness-runner.test.ts` |
| 24 | NAT64 podia transportar IPv4 privado/metadata | IPv4 embutido reclassificado e prefixo local-use bloqueado | `test/browser-egress-proxy.test.ts` |
| 25 | `EACCES` em subtree de locks virava inventário vazio | Apenas `ENOENT` é tolerado; demais erros propagam | `test/readiness-runner.test.ts` |
| 26 | Gate WSL coletava sockets, mas não reprovava socket residual | Snapshot normalizado, baseline multiset e falha para socket novo | `test/runtime-wsl-live-inventory.test.ts` e gate WSL live |
| 27 | Pacote de release omitia `shutdown-gateway.mjs`, exigido pelo launcher instalado | Dependência incluída no pacote | `test/release-lifecycle.test.ts` |
| 28 | Preflight central não exigia `shutdown-gateway.mjs` | Arquivo incluído na lista obrigatória | `test/release-lifecycle.test.ts` |
| 29 | Readiness herdava o perfil real e podia remover o atalho do Desktop | Atalhos isolados por `OPENBOT_SHORTCUT_ROOT` | `test/readiness-runner.test.ts` |
| 30 | Gate WSL deixava pastas vazias de distros temporárias no Menu Iniciar | Cleanup exato, seguro e verificado | `test/runtime-build-pipeline.test.ts` e gate WSL live |
| 31 | Repair da mesma versão não restaurava atalho ausente | Reconciliação dos atalhos no repair idempotente | `test/release-lifecycle.test.ts` |
| 32 | Uninstall podia remover um atalho e falhar no segundo | Snapshot e rollback transacional dos atalhos | `test/desktop-lifecycle-hardening.test.ts` |
| 33 | Falha no cleanup diferido podia deixar instalação e atalhos quebrados | Transação conjunta de atalhos, relocação e cleanup | `test/desktop-lifecycle-hardening.test.ts` |
| 34 | Repair com outra raiz de atalhos deixava links órfãos | Raiz divergente rejeitada contra o estado gerenciado | `test/release-lifecycle.test.ts` |
| 35 | Arquivo texto chamado `.lnk` era aceito como atalho válido | Atalhos da mesma versão são recriados e verificados | `test/release-lifecycle.test.ts` |
| 36 | Recriação de atalhos da mesma versão não era transacional | Snapshot e restauração em qualquer falha | `test/release-lifecycle.test.ts` |
| 37 | Isolar `USERPROFILE` quebrava o Electron e deixava resíduos | Perfil real preservado; somente raízes de dados/atalhos são isoladas | `test/readiness-runner.test.ts` e `test/browser-e2e.integration.test.ts` |
| 38 | Smoke aceitava apenas o launcher do repositório e rejeitava o atalho instalado | Resolução explícita dos dois layouts e dos paths efetivos | `scripts/smoke-shortcut.ps1` |
| 39 | Erro HTTP podia ser confundido com porta 1340 liberada | Liberação provada por bind TCP exclusivo | `test/electron-windows-patches.test.ts` e smoke real |
| 40 | Smoke validava insuficientemente a identidade da instalação | Estado, raiz, produto, versão e manifesto conferidos | `test/electron-windows-patches.test.ts` |
| 41 | Falha ao apagar a raiz temporária do smoke podia passar GREEN | Ausência da raiz agora é obrigatória | `test/electron-windows-patches.test.ts` e smoke real |
| 42 | Junction ou árvore adulterada podia contornar a checagem textual do smoke | Preflight central rejeita reparse e recalcula SHA-256 da árvore antes da execução | `scripts/smoke-shortcut.ps1` e lifecycle de release |

## Revisão final

As revisões Luna de runtime/WSL, browser, release, segredos, cleanup e smoke do atalho terminaram CLEAN. No front de sockets, a validação live confirmou que o inventário antes/depois permaneceu idêntico, com cinco sockets de baseline e nenhum residual. A revisão final do smoke confirmou preflight canônico, rejeição de reparse, integridade recalculada, bind exclusivo da porta e cleanup comprovado.

## Limites da conclusão

- A matriz usa providers offline/locais; não constitui prova de integração com provider comercial real.
- Browser público foi exercitado somente em navegação de leitura autorizada.
- O veredito vale para o ambiente, artefatos e matriz executados acima; mudanças posteriores exigem novo checkup.

## Documentos de origem

- [Especificação de convergência](superpowers/specs/2026-08-22-openbot-readiness-convergence-design.md)
- [Plano de implementação](superpowers/plans/2026-08-22-openbot-readiness-convergence.md)
- [Gates de verificação](verification-gates.md)
