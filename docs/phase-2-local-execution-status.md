# Fase 2 — estado final

> **Registro histórico:** este documento descreve o aceite de agosto de 2026, incluindo WSL e estado local daquela execução. O checkout usa runtime nativo Windows por padrão; WSL é restrito ao bootstrap de testes. Consulte o [README atual](../README.md) e o [bootstrap](../src/main.ts). Resultados abaixo não comprovam a revisão atual.

> Relatório operacional completo: [`practical-bot-environment-final.md`](practical-bot-environment-final.md).  
> Revisão de polimento final: [`openbot-polish-review-2026-08-16.md`](openbot-polish-review-2026-08-16.md).

**Data:** 2026-08-16  
**Status:** concluido para o ambiente pratico local dos bots.

## O que ficou pronto

- Runtime Linux compartilhado por WSL2 concluido em `OpenBotRuntime`, sem tocar `Ubuntu` ou `Ubuntu-24.04`.
- Guest Rust empacotado, validado e instalado com manifesto, digest, policy e rollback.
- `process.run` real funcionando dentro do guest com seccomp ativo (`Seccomp: 2`) e compatibilidade com `spawnSync`.
- Browser visual completo com Electron local, canal de comando por named pipe privado, proxy autenticado, sem CDP exposto e teardown por agente.
- O browser suporta `open`, `navigate`, `snapshot`, `click`, `type`, screenshot de viewport/full-page, download, upload restrito à home, `close` e `handoff`; o upload rejeita traversal, links simbólicos/junctions/reparse points e hardlinks.
- Homes por bot com DACL, quotas, quarentena atômica, restore/export/import/repair e inventário; exclusão em lote reverte homes anteriores se uma etapa falhar.
- O runtime WSL aceita somente a home canônica `<workspacesRoot>/<agentId>` e rejeita caminhos externos, symlinks, junctions e reparse points.
- Zero-agent bootstrap: o app pode iniciar com roster vazio e nao recria `openbot-default`.
- Skills compartilhadas integradas ao chat: descoberta autônoma por `search_skills`/`use_skill`, invocação explícita pelo seletor `/` e chip nativo, política por bot e conteúdo somente no turno.
- MCP compartilhado e lazy: Streamable HTTP/stdio pelo SDK oficial, secrets por referência no keystore, allowlist/denylist por bot e chamadas no mesmo lifecycle de tools.

## Evidencias finais

- Gate WSL real verde: `start`, `health`, `process.run`, identidade não-root, seccomp, rede bloqueada, timeout, abort, cleanup parcial, recovery, rollback, `release` e `teardown`.
- Gate visual real verde: navegação headed, texto visível, `click`, `type`, screenshot, full-page, upload real de `Documents/gate.txt` em um `<input type=file>`, `handoff` e remoção da partição do agente.
- Gate visual Skills verde: seletor `/` e lista nativa, chip no composer, envio real, contexto observado no backend, resposta no painel principal, zero erros de console/runtime e teardown limpo.
- O gate WSL live versionado `npm run verify:runtime-wsl-live` passou com distro e TempRoot aleatórios próprios; confirmou install/rollback, `process.run`, identidade, seccomp, rede, timeout, abort, cleanup parcial idempotente, recovery e prova before/after sem alterar distros pessoais.
- Ensaio isolado create/use/delete/restart verde: arquivo roundtrip, browser visual, delete, quarentena, restart com zero bots.
- Suite final acumulada: `81` arquivos, `806` testes passando, `1` skipped.
- Gate focado Skills/MCP/chat: `132` testes passando, incluindo transportes reais MCP Streamable HTTP e stdio pelo SDK oficial; gate integrado também passou 3 cenários core e Electron isolado.
- Supervisor Rust: `16` testes passando no build oficial do guest.
- `npm run typecheck` = verde.
- `npm run build` = verde.
- `npm run smoke:local` = create/delete/restart com `zeroAgentAfterRestart: true`.
- Gate Electron Skills final = `GREEN`, exatamente uma resposta final, renderer ocioso, zero erros de console/runtime e cleanup completo.
- Isolamento da suíte comprovado: caminhos, tamanhos e hashes dos `353` arquivos presentes no AppData real permaneceram idênticos antes/depois de `npm test`.
- `OpenBotBuild` e `OpenBotRuntimeLive-*` ausentes após build/gate; `OpenBotRuntime`, `Ubuntu` e `Ubuntu-24.04` permaneceram paradas.

## Estado pratico do usuario

- Roster real atual: `0` bots.
- Homes ativas reais: `0`.
- Quarentena real: `27` homes recuperaveis em `C:\Users\User\AppData\Local\OpenBot\workspaces\.quarantine`.
- Transcripts reais: `0`.
- `runtime_owners`: `0`.
- Browser partitions reais: `0`.
- `OpenBotRuntime`: instalado e parado.

## Backup e recuperação

- Backup pré-limpeza preservado em `C:\Users\User\AppData\Local\OpenBot\backups\pre-practical-final-20260815-213052`: 27 agentes, 27 homes ativas, 56 arquivos, zero divergências de hash; SHA-256 do manifesto `e340cd702f407e116dd01d1de5ee09f03346e1858fba34f56d796b355a2d9b45`.
- Snapshot pós-limpeza preservado em `C:\Users\User\AppData\Local\OpenBot\backups\pre-practical-final-20260815-213401`: zero agentes, 85 arquivos manifestados, zero divergências de hash; SHA-256 do manifesto `03379688495ec7b00de20c511fed917a70cd46164657780d311565e4df5c34ec`.
- Os 27 bots de teste não foram apagados de forma irrecuperável; foram movidos para quarentena.
- O restore agora pode ser feito por bot, quando voce quiser reaproveitar alguma home antiga.

## Arquitetura resultante

- Nao existe VM por bot.
- Existe um runtime WSL compartilhado e lazy para `process.run`.
- Existe um host Electron compartilhado e lazy para browser visual.
- Existe um catálogo de Skills e um manager MCP compartilhados e lazy; cada bot recebe somente sua projeção autorizada.
- Cada bot tem sua propria home, sua propria particao persistente do browser quando ativa e sua propria quarentena quando removido.

## Pendencias reais

- Nenhuma P0 aberta para o ambiente pratico local descrito neste documento.
- A última P0 de segurança do upload foi fechada com validação fail-closed de `nlink` no descritor aberto, antes e depois da leitura, e regressão com hardlink real.
- Itens futuros passam a ser expansao de produto, nao bloqueio de fechamento.

## Skills e MCP no chat

O contrato operacional, configuração, segurança, peso e evidências estão em [`shared-skills-mcp-chat.md`](shared-skills-mcp-chat.md).

O aceite técnico final de Skills/MCP e Runtime/WSL está em [`openbot-skills-mcp-runtime-100-acceptance-2026-08-16.md`](openbot-skills-mcp-runtime-100-acceptance-2026-08-16.md).
