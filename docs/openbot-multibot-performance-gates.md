# OpenBot — gates estruturais de performance multi-bot

## Execução

```powershell
npm run benchmark:hot-paths
npx vitest run test/performance-regression.test.ts --maxWorkers=1 --no-file-parallelism
```

`benchmark:hot-paths` compila o código e imprime uma única linha JSON. O
benchmark usa estruturas em memória e diretórios temporários criados com
`mkdtemp`; o caso `longStream` usa um arquivo SQLite temporário real, fecha e
reabre o banco e remove a raiz no `finally`. Não usa AppData, WSL, Electron,
provider ou rede real. O fixture MCP usa `McpManager` com connector e DNS
injetados para loopback, sem abrir conexão.

## Gates cobertos

| Caso | Gate estrutural | Contadores relevantes |
| --- | --- | --- |
| `transcript` | 20.000 entradas são percorridas por cursor, em páginas de 128, e o evento snapshot fica abaixo de 128 KiB | `entries`, `pages`, `maxEventBytes`, `cursorExhausted` |
| `queues` | turnos de agentes distintos se sobrepõem; turnos do mesmo agente não se sobrepõem | `maxConcurrentIndependent`, `sameAgentStartsBeforeRelease`, flags `*Observed` |
| `quota` | uma segunda reserva concorrente permanece enfileirada enquanto a primeira mantém a reserva; após cancelamento, ela prossegue e a contabilidade volta a zero | `queuedUntilRelease`, `sequentialReservationsAfterRelease`, `postCancelBytes`, `oversubscriptionPrevented` |
| `mcpCache` | conexões e catálogo de tools compartilham cache entre chamadas concorrentes; a invocação continua sendo contabilizada | `connectorCalls`, `listToolsCalls`, `callToolCalls`, flags de cache |
| `runtimeAdmission` | capacidade cheia entra em fila limitada; a espera real é observada antes do abort, recebe `AbortSignal`, e um driver pendente também termina por cancelamento | `queuedWaitObserved`, `queuedCancelled`, `driverCancelled`, `driverAbortObserved`, `admissionBounded` |
| `browserFairness` | quatro agentes ocupam os quatro slots iniciais em ordem; cada agente mantém FIFO, e o backlog de `a` não bloqueia `b` | `initialOrder`, `started`, `completed`, `roundRobinObserved`, `fifoByAgent`, `headOfLineAvoided`, `schedulerSymbolsPresent` |
| `memoryContext` | corpus grande preserva o hard cap, não mistura agentes e exclui conversas temporárias | contagens do corpus, bytes/tokens aproximados e flags de invariantes |
| `longStream` | 2.048 deltas produzem conteúdo exato, medem SSE/TTFT/heap/event-loop e persistem checkpoints em SQLite verificáveis após reopen | `ttftMs`, bytes publicados, cardinalidades, `sqliteAppendMutationCount`, `sqliteReplaceMutationCount`, `livePreviewUpdateCount`, `persistenceVerified` |
| `maxAvatar` | PNG no limite público é aceito e reaparece no snapshot | `decodedBytes`, `cap`, `acceptedAtLimit` |
| `maxAttachments` | 16 anexos próximos do cap agregado entram no contexto formatado sem ultrapassar os limites | contagem, bytes de origem/texto/contexto e caps |
| `slowProviders` | providers lentos de quatro agentes distintos começam em paralelo e concluem exatamente uma vez | `startedBeforeRelease`, `maxConcurrent`, `providerCalls`, flags `*Observed` |

As barreiras do teste são promises, `setImmediate` e sinais explícitos. Não há
`sleep` para inferir que uma operação terminou.

## Interpretação honesta

Os `durationMs`, `ttftMs` e a metadata de CPU/memória são diagnósticos desta
execução hermética e servem para
detectar regressões grosseiras ou gates que deixam de terminar. Eles não são
SLO de produção, nem medem latência de Electron, filesystem real, WSL, rede,
MCP remoto ou modelo/provider. `maxEventBytes` mede o JSON do fixture, não o
framing HTTP/SSE em produção.

Os contadores `sqlite*MutationCount` registram mutações/checkpoints lógicos
bem-sucedidos na API do `SqliteTranscriptStore`, não writes físicos nem
transações internas do SQLite. A durabilidade é provada separadamente pelo
close/reopen e pela leitura do conteúdo final; `livePreviewUpdateCount` mede
somente previews em memória.

O cache MCP medido é o cache estrutural de sessão e de catálogo: nas versões
atuais, as três operações do cenário resultam em uma conexão, uma listagem e
uma chamada de tool. Isso demonstra deduplicação local; não demonstra ganho
de rede real nem validade do catálogo remoto.

O gate de browser usa `BrowserSessionManager` com um host fake in-process e
barreiras explícitas de liberação. A presença dos símbolos do scheduler no
host real ancora o contrato (`MAX_AGENT_QUEUE`, `MAX_TOTAL_QUEUE`, cursor e
`takeNextRequest`); a ordem dinâmica é verificada sem iniciar Electron. Isso
prova o comportamento estrutural do scheduler e não justiça sob carga real,
latência de Chromium ou saturação de stdout.
