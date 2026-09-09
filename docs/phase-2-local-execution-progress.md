# Fase 2 — execução local restrita

> Relatório operacional completo: [`practical-bot-environment-final.md`](practical-bot-environment-final.md).

Data do estado: 2026-08-16
Status: ambiente prático completo por bot entregue e validado em estado isolado e no AppData real do usuário.

## Objetivo

Substituir o conceito de “PC Linux remoto” por execução Windows local confinada, mantendo um seam de backend que permita WSL2/container posteriormente sem alterar o agente ou a UI.

## Estado implementado

O diretório `src/execution/` contém:

- `contracts.ts`: requests/results discriminados e parser estrito;
- `workspace.ts`: sandbox de caminhos Windows;
- `files.ts`: `file.list`, `file.read` e `file.write` atômico;
- `commands.ts`: `search.files` e `search.text` internos;
- `broker.ts`: políticas e aprovações;
- `tool-request.ts`: tradução fechada de provider tool calls;
- `tool-loop.ts`: loop provider → tool → provider.

## Modelo de segurança

- paths sempre relativos ao workspace;
- bloqueio de traversal, paths absolutos, UNC/device paths, ADS, NUL, nomes reservados e trailing dot/space;
- containment case-insensitive;
- symlinks e junctions/reparse ancestors rejeitados;
- leitura/escrita/listagem limitadas;
- escrita por arquivo temporário exclusivo + rename atômico;
- busca limitada por arquivos, bytes e resultados;
- `AbortSignal` e shutdown limpam operações/aprovações pendentes;
- `localToolPermission`: default `always`; na home `ask` executa sem card e `never` é kill-switch; broker injetado ainda testa as três políticas;
- máximo de três rodadas de tools por turno;
- rejeições do backend viram `io_error` sanitizado.

## Capacidades disponíveis

| Operação | Estado | Observação |
|---|---|---|
| `file.list` | implementada | diretório validado, ordenação determinística |
| `file.read` | implementada | UTF-8/base64, limite de 1 MiB |
| `file.write` | implementada | parent existente, escrita atômica |
| `search.files` | implementada | busca interna, sem processo externo |
| `search.text` | implementada | fixed/regex, arquivos binários ignorados |
| shell/PowerShell | bloqueado | nenhum `spawn`, command string ou PATH herdado |
| delete | bloqueado | não exposto pelo executor seguro |
| rede da tool | bloqueada | nenhuma operação de rede implementada |
| VM/VNC | não implementada | stubs continuam inertes |

## Integração

O `TurnRunner` suporta:

1. provider emite `tool-call`;
2. tradução valida nome/JSON/shape;
3. broker aplica a política;
4. `ask` aguarda `resolveLocalToolPermission`;
5. executor produz resultado estruturado;
6. próximo request ecoa `assistant.tool_calls` e `role:"tool"`;
7. provider finaliza a resposta.

O bootstrap padrão cria a home do agente, injeta o broker e os schemas `file` / `search_files` / `search_text`. `disableAgentHome` é hatch de teste para chat-only. `/local-exec/*` continua retornando 501: execução direta por HTTP não foi aberta.

Spec: [`superpowers/specs/2026-08-13-agent-home-workspace-design.md`](superpowers/specs/2026-08-13-agent-home-workspace-design.md).

## UI local (2026-08-14)

- Um único `+` (New chat). Sem botão extra “Novo Bot”.
- Create usa o picker nativo: **To: Search or create Bots** → **Create new Bot**.
- **View agent settings** nativo (Name / Title / Description / Notifications) é a customização. Bots novos materializam `Title = Name` na criação e depois mantêm os campos independentes; registros antigos sem o campo usam `Name` como fallback até a primeira edição. Título vazio ou de tipo inválido é rejeitado.
- Modelo, provedor e API key entram só nesse painel — sem modal por cima do chat.
- Computer, Plugins e Log out ocultos (VNC/Cursor não fazem parte do produto local).
- Transcript: `toAgent` / `fromAgent` / `fromUser` como objetos. Entries antigas (string / `true`) são normalizadas na leitura.
- Cada bot tem prompt (Name + Description), Title visual e modelo/provider próprios. O toggle nativo de Notifications grava `notifyOnUpdatesEnabled`.
- Stream incremental (`updated` + `streaming`), botão Parar, `isRunning` / `lastEntry` no roster (toast Windows quando o notify está ligado e a janela não está em foco).
- Anexos `.md`/texto/PDF lidos da home ou do staging e enviados ao modelo.
- Descoberta LM Studio (`:1234`) e Ollama (`:11434`) + Testar conexão no painel. Microfone oculto.

## Aceite automatizado

- build TypeScript verde;
- suíte Vitest no repo (`npm test`); o corte histórico de 316 testes/24 arquivos ficou para trás;
- smoke local com dedupe e persistência após restart;
- E2E HTTP de aprovação e shutdown;
- escrita real dentro de workspace temporário;
- tentativa `../outside` rejeitada e arquivo externo preservado;
- smoke Electron com renderer `OpenBot` montado;
- nenhuma conexão não-loopback observada na árvore Electron;
- auditoria sem Cursor auth/API, Statsig ou Sentry executáveis.

## Estado detalhado

O ponto de parada, evidências, impacto no produto e backlog restante estão consolidados em [`phase-2-local-execution-status.md`](phase-2-local-execution-status.md).

## Fechamento desta fase

1. ~~Criar automaticamente `%LOCALAPPDATA%/OpenBot/workspaces/<agentId>`.~~ feito.
2. ~~Construir backend composto (arquivos + busca) no bootstrap padrão.~~ feito.
3. ~~Publicar schemas seguros `file`, `search_files` e `search_text`; nunca o schema legado `shell`.~~ feito.
4. ~~Exibir pedidos de aprovação e status `pending/running/completed/failed` na UI.~~ feito.
5. ~~Adicionar a fundação WSL2 com runtime gerenciado, recovery, package/versionamento e teardown seguro.~~ feito.
6. ~~Adicionar perfil Developer por bot e `process.run` somente nesse modo.~~ feito.
7. ~~Adicionar quotas, inventário e remoção segura por quarentena.~~ feito.
8. ~~Validar o guest WSL real com seccomp/cgroup/mounts/process/abort/delete.~~ feito.
9. ~~Adicionar egress mediado, navegador visual headed, perfis por bot e handoff visual.~~ feito.
10. ~~Implementar export/import/repair, DACLs e helper Windows para lifecycle seguro.~~ feito.
11. ~~Executar rehearsal isolado de create/use/delete/restart.~~ feito.
12. ~~Limpar o estado real do usuário com backup verificável, quarentena recuperável e restart sem bot default.~~ feito.
13. ~~Fechar quarentena/restore de forma atômica e reverter exclusão em lote quando uma etapa falhar.~~ feito.
14. ~~Restringir o guest WSL à home canônica gerenciada, rejeitando links/reparse e homes externas.~~ feito.
15. ~~Completar full-page, upload seguro da home e limpeza de leases expirados no browser visual.~~ feito.
16. ~~Isolar os testes de integração do AppData real do usuário.~~ feito.
17. ~~Integrar catálogo compartilhado de Skills com descoberta autônoma e invocação explícita no composer nativo.~~ feito.
18. ~~Integrar MCP compartilhado com políticas por bot, secrets no keystore e lifecycle comum de tools.~~ feito.

## Evidência adicional deste fechamento

- `OpenBotRuntime` preservada e parada após os gates reais.
- `OpenBotBuild` removida ao final do pipeline.
- Browser real validado com Electron local, proxy autenticado, full-page, upload real e teardown limpo.
- Estado real pós-limpeza: `0` bots, `0` homes ativas, `27` homes em quarentena, `0` transcripts e `0` runtime owners.
- Gate automatizado acumulado: `77` arquivos, `765` testes passando e `1` skipped; typecheck e build verdes.
- Gate focado Skills/MCP/chat: `71` testes verdes, incluindo HTTP e stdio reais pelo SDK oficial.
- Gate Electron Skills final: `GREEN`, menu `/`, chip nativo, contexto no backend, uma única resposta, renderer ocioso e zero erro runtime.
- Caminhos, tamanhos e hashes dos `353` arquivos reais presentes em AppData ficaram inalterados durante a suíte completa.
- O gate de segurança final rejeitou hardlink real da home para arquivo externo; o gate Electron real repetiu upload e screenshot full-page com teardown em zero leases.
- Skills/MCP: [`shared-skills-mcp-chat.md`](shared-skills-mcp-chat.md) registra o uso autônomo, o seletor `/`, a configuração MCP, os limites e a evidência.
