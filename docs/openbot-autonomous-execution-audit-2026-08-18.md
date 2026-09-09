# Auditoria da execução autônoma dos bots

**Data:** 18/08/2026  
**Escopo:** fluxo de chat real, seleção/uso de Skills, tools locais, browser, MCP, persistência de contexto, cancelamento e isolamento entre bots.  
**Objetivo:** tornar tarefas práticas multi-etapa mais confiáveis sem substituir o runtime existente nem criar um segundo orquestrador.

## Arquitetura efetivamente usada

O caminho de produção permanece:

1. `TurnRunner` recebe e serializa turnos por bot;
2. resolve contexto efêmero de Skill e as tools disponíveis;
3. chama o provider pelo `ProviderRegistry`;
4. `runToolLoop` interpreta tool calls e devolve resultados ao provider;
5. `SharedTools` atende Skills/MCP e o `LocalExecutionBroker` atende arquivo, processo e browser;
6. o transcript persiste mensagens, notices e cards de tool;
7. filas, workspaces, runtime e sessões de browser continuam particionados por `agentId`.

Não foi criado framework, DSL ou scheduler paralelo novo.

## Falhas reproduzidas

Antes das correções, reproduções determinísticas confirmaram:

- uma ação idêntica podia executar novamente com outro tool-call ID;
- o mesmo `requestId` concluído podia reexecutar no broker;
- resultados inválidos de backend atravessavam o broker e podiam causar `TypeError`;
- o contexto de 80 mensagens descartava a tarefa inicial e podia começar por resposta órfã;
- históricos pesados em anexos escapavam das garantias de âncora/fronteira;
- provider vazio e limites internos encerravam o turno sem explicação persistida;
- `use_skill` permitia seleção automática de Skill com `auto-select: false`;
- o teto de três rodadas impedia um fluxo sequencial legítimo de Skill → browser → arquivo;
- falhas concluídas não entravam no ledger idempotente;
- variantes como `file.write` sem `encoding` e com `encoding: "utf8"` escapavam do dedupe.

## Correções aplicadas

- ledger idempotente limitado por `(agentId, requestId)` e fingerprint do payload;
- reutilização de execuções em voo e concluídas, inclusive falhas ambíguas;
- colisão do mesmo ID com payload diferente falha fechado;
- validação estrutural do `ExecutionResult` por operação;
- fingerprint de ação local após normalização do request;
- dedupe na mesma rodada e bloqueio de repetição consecutiva;
- limites continuam finitos, com oito rodadas e códigos explícitos;
- notices persistidos para provider vazio e limites internos;
- contexto limitado a 80 mensagens, preservando tarefa inicial, anexos e fronteira de usuário;
- `use_skill` respeita `auto-select: false`; referência manual continua permitida;
- cancelamento é rechecado antes de novos rounds e propagado às integrações;
- teste E2E determinístico cobre o encadeamento autônomo completo.

## Cenários determinísticos adicionados

| Cenário | Chamadas de modelo | Tools | Resultado |
|---|---:|---:|---|
| Skill → browser → escrita → leitura → resposta | 6 | 5 | arquivo verificado e resposta final consistente |
| dois bots concorrentes | 6 no total | 4 | workspace e transcript sem mistura |
| MCP compartilhado por dois bots | 4 no total | 2 | uma sessão/cache, resultados correlacionados ao bot correto |
| ferramenta indisponível | 2 | 1 | explicação explícita, sem sucesso fictício |
| cancelamento cooperativo | 1 | 1 | sem efeito tardio e sem novo round |

A Skill usada no E2E contém token sentinela; o token chega ao provider durante o turno, mas não é persistido no transcript.

## Desempenho observado

Amostra hermética, não SLO:

- E2E autônomo completo: cinco cenários em aproximadamente 1,05 s na suíte final;
- cenário multi-bot: aproximadamente 0,90 s na suíte final;
- paginação de 20.000 entries: 10,8 ms;
- filas independentes: 8,8 ms, com concorrência observada e serialização por bot;
- cache MCP: 5,9 ms, uma conexão e uma listagem;
- scheduler de browser: 12 requests/4 bots, round-robin e FIFO por bot.

O custo dominante de produção continua sendo provider, browser/IO e inicialização do workspace; a orquestração adicionada é limitada a mapas, fingerprints canônicos e validações locais.

## Validação final

- `npm run build`: aprovado;
- `npm run typecheck`: aprovado;
- suíte integral serial: **96 arquivos, 1.039 testes aprovados, 1 ignorado, 0 falhas**, 180,17 s;
- browser Electron real: **17/17**;
- gate Skills/MCP: **157/157**;
- core acceptance: **3/3**;
- desktop Electron isolado: `GREEN`, processos encerrados, portas livres e temp removido;
- runtime WSL live: `GREEN`, com instalação, processo, identidade, recuperação após cancelamento e rollback aprovados; a distribuição temporária foi removida e `Ubuntu`, `Ubuntu-24.04` e `OpenBotRuntime` permaneceram inalteradas;
- smoke de provider local: `SKIP` explícito — LM Studio e Ollama não estavam ativos.

## Limitações restantes

- O E2E determinístico comprova plumbing, sequência, persistência e isolamento; não mede a qualidade semântica de um LLM real.
- Não houve teste live de provider local porque LM Studio e Ollama estavam inativos.
- Cancelamento é cooperativo: um executor externo que ignore `AbortSignal` pode continuar; não existe rollback universal.
- A âncora preserva a primeira tarefa do diálogo, não todas as instruções intermediárias antigas.
- Browser e MCP continuam compartilhando infraestrutura por eficiência, mas sessões, políticas, workspaces e resultados são correlacionados por bot.

## Arquivos centrais alterados

- `src/execution/broker.ts`
- `src/execution/tool-loop.ts`
- `src/rpc/send.ts`
- `src/store/index.ts`
- `src/skills/dispatcher.ts`
- `test/autonomous-execution.integration.test.ts`
- testes focados de broker, tool loop, contexto, transcript e Skills
