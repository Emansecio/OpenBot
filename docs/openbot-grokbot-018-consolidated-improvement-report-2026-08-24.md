# OpenBot + Grok Bot 0.18 reconstruído — relatório consolidado de melhorias

**Data da consolidação:** 24/08/2026  
**OpenBot analisado:** `C:\SuperAgent\openbot`  
**Concorrente analisado:** `b-nnett/grok-bot-0.18-reconstructed`, commit fixado `a9f633e09d49a85829b8236331b9e21f7e612634`  
**Documento histórico incorporado:** `analysis_outputs/SUMMARY.md`, de 14/08/2026, especialmente seus P0, P1 e P2  
**Modo:** análise estática e revalidação do código atual. Nenhum script não confiável do concorrente foi executado.

> **Resultado em uma frase:** o OpenBot deve aproveitar do concorrente a ideia de um plano de controle multiagente observável, mas deve construí-lo sobre sua persistência SQLite, filas, isolamento e renderer atuais; copiar o runtime, o frontend reconstruído ou os artefatos 0.18 causaria regressão técnica e risco de procedência.

---

## Estado de execução posterior à análise

Depois da consolidação deste relatório, a implementação integral foi autorizada em um fluxo separado. Este documento continua sendo a especificação e a análise de origem; o estado operacional verificável fica no [roadmap de execução](superpowers/plans/2026-08-24-openbot-grokbot-018-execution-roadmap.md) e o detalhe da etapa atual fica no [plano P2](superpowers/plans/2026-08-24-openbot-grokbot-018-p2-product-expansion.md).

Snapshot histórico de 24/08/2026: P0.1–P0.4, P1.1–P1.5, P2.1, P2.2 e P2.5 estavam concluídos nessa etapa. P2.1 passou em 51/51 testes focados e 487/487 integrados; P2.2 passou em 326/326 testes focados, com gate Electron real de 24/24 passos e três screenshots; P2.5 passou no contrato RED 25/25, suplemento 13/13 e matriz de 15 arquivos / 219 testes. A execução serial desse snapshot ficou em 1.968 aprovados, 2 ignorados e 4 falhas ambientais reproduzidas em `release-lifecycle` e `windows-artifact-gate`; esse número não é o resultado do exit audit final.

Fechamento final em 25/08/2026: P2.1–P2.8 e o exit audit estão completos. P2.6 passou em 8/8 testes focados e 13/13 no gateway, com checkpoint/CAS/effect ledger e guards explícitos para checkpoint expirado e efeito `unsafe`; pares de produção continuam `resume:none`. P2.7 registrou no-change GREEN em três execuções Electron reais (15 snapshots): um observer ativo por overlay, callbacks p95/máximo de 0,1 ms, scans p95/máximo de 0,3/0,4 ms, zero long tasks, event-loop lag p95/máximo de 14,1/33,4 ms, CPU 1,741%, heap +28.836 B, listeners estáveis em 169 e timers 0; evidência em `logs/electron-p27-profile-ycxqHH/p27-report.json`, com renderer e overlay intocados. P2.8 passou em 7/7 focados e 130/130 nos regressions de roster/send/store/crash, cobrindo schema 13, readiness, dedupe, restart, hidden result, ausência de tools e delete/fence.

O exit audit passou inicialmente em 452/452 testes P2, batches P0/P1 de 330/330 e 152/152, core 3/3, chat resilience 165/165 e suíte serial completa de 158 arquivos / 2.076 aprovados / 2 ignorados / 0 falhas. Depois foi acrescentado o guard fail-closed final de P2.6; a superfície alterada foi revalidada em 48/48 (`p26-resume` 8/8, store 27/27 e gateway 13/13), além de typecheck/build. `benchmark:hot-paths` retornou `ok`, provenance retornou `true`, o aggregate de renderer `8be890dd0e54aa5b31fb2821b08c89dcc3bba6a6faa28c11de8ea613089d460d` permaneceu imutável, client-artifacts passou em 12 checks e visual artifacts-only ficou GREEN. O pacote final `OpenBot-0.1.0-win32-x64` foi regerado com o guard; o Windows artifact gate passou com diretório, ZIP, sidecar e clean root; preflight empacotado, smoke local e release lifecycle 30/30 passaram.

Limitações residuais honestas: o artefato é `unsigned-local` (SHA-256 comprova integridade, não autenticidade); pares de produção permanecem `resume:none`; `src/rpc/send.ts` ainda contém o histórico `// @ts-nocheck`; não houve provider pago, login ou token real; P2.7 não alterou código de UI.

---

## 1. Para quem este documento foi escrito

O leitor esperado é um agente ou engenheiro que chega sem nenhuma memória desta investigação.

Depois de ler, ele deve conseguir:

1. explicar como o OpenBot funciona hoje;
2. distinguir código ativo, stub, reconstrução experimental e artefato proprietário;
3. saber quais itens históricos estavam abertos na análise e como foram encerrados ou mantidos como limitação no roadmap final;
4. escolher uma recomendação P0, P1 ou P2 sem violar decisões congeladas;
5. produzir um plano de implementação verificável sem copiar código do concorrente;
6. reconhecer as invariantes que não podem ser quebradas.

Este relatório não autoriza implementação. Ele é o mapa técnico consolidado que deve preceder planos e patches.

### 1.1 Significado das prioridades

As prioridades abaixo são **ordem de execução**, não uma classificação automática de bugs:

- **P0 — pré-condição:** deve estar verdadeiro antes de ampliar o produto. Não significa que existe um incidente crítico aberto.
- **P1 — núcleo de maior retorno:** próxima capacidade estrutural recomendada.
- **P2 — expansão condicionada:** só deve começar depois dos P0/P1 correspondentes e quando houver necessidade de produto.

### 1.2 Rótulos de evidência

- **CONFIRMADO — OPENBOT LOCAL:** observado diretamente no checkout `C:\SuperAgent\openbot`.
- **CONFIRMADO — SNAPSHOT EXTERNO:** observado no checkout read-only do concorrente fixado no commit citado; prova o conteúdo daquele snapshot, não o comportamento do produto oficial upstream.
- **PARCIAL:** existe uma implementação real, mas ela não fecha todo o objetivo original.
- **HIPÓTESE A MEDIR:** mecanismo suspeito sem evidência runtime suficiente para chamá-lo de bug.
- **NÃO ADOTAR:** copiar o padrão reduziria segurança, durabilidade, portabilidade ou manutenibilidade.
- **FORA DO ESCOPO:** não foi provado nesta análise.

As referências `arquivo:linha` são deliberadamente específicas deste snapshot datado. Antes de editar, o implementador deve relocalizar o símbolo com `rg`, porque linhas mudam.

Durante a auditoria, o concorrente foi clonado fora do OpenBot em `C:\Users\User\AppData\Local\Temp\grok-bot-018-audit-907ca2b7601d43dcbfb3a5faed944ea3\competitor`; `git rev-parse HEAD` confirmou `a9f633e...`. Esse diretório temporário não é dependência do projeto e pode desaparecer. Para reproduzir um achado, abra o link GitHub fixado ou faça um novo checkout somente leitura do mesmo commit. Nenhum arquivo do concorrente foi copiado para o OpenBot.

### 1.3 Glossário operacional

| Termo | Significado neste relatório |
|---|---|
| ACK | Confirmação rápida de que o comando foi aceito para processamento; não significa conclusão e, sozinho, não garante deduplicação após retry/restart |
| `clientNonce` | Identificador estável criado pelo chamador para tornar um dispatch idempotente; repetir o mesmo nonce deve devolver a mesma operação lógica |
| CAS | Compare-and-swap: só altera um registro se estado e versão ainda forem os esperados |
| Lease | Posse temporária e renovável de uma task por um executor; expirar o lease permite recovery sem dois donos válidos |
| Outbox | Eventos gravados na mesma transação do estado e entregues depois; evita perder wakes/SSE entre commit e crash |
| Wake | Sinal idempotente ao pai de que um evento persistido está disponível; não carrega a autoridade do estado |
| Lineage | Vínculo imutável task → pai → turno → agente, usado para autorização, auditoria e cleanup |
| Fence | Barreira de versão/estado que invalida trabalho antigo, especialmente durante exclusão, abort ou recovery |
| Capability grant | Permissão delegada, limitada e revogável; responde **se** o filho pode executar uma classe de operação |
| Budget | Limite quantitativo persistido; responde **quanto** tempo, tokens, chamadas, efeitos ou bytes o filho pode consumir |
| Clean-room | Reimplementar comportamento/contrato a partir de observação e requisitos próprios, sem copiar código, assets, prompts ou binários do concorrente |

---

## 2. Veredito executivo

### 2.1 O que mudou desde a primeira análise

A auditoria histórica de 14/08 identificou gargalos reais no caminho:

```text
provider → deltas → transcript → SQLite → SSE → renderer
```

O código atual já incorporou uma parte grande desse trabalho:

- transcript paginado e eventos de snapshot limitados;
- queries SQLite específicas para contexto recente, último assistant e tool calls abertas;
- estado de resposta em streaming mantido em memória;
- publicação e persistência em cadências diferentes;
- limites agregados de anexos e resultados de tools;
- contexto com hard cap, reserva de saída, summaries e memória isolada por agente;
- benchmarks estruturais para transcript grande, filas, runtime, browser e memória.

Portanto, repetir os antigos P1/P2 como se nada existisse seria incorreto.

### 2.2 Onde está o maior ganho restante

O maior ganho novo não é trocar bibliotecas nem importar o renderer 0.18. É acrescentar um **plano de controle multiagente durável**:

```text
aceitação idempotente por nonce obrigatório
    ↓
admission control global e justo
    ↓
async task persistida
    ↓
subagente depth-1 no runtime compartilhado
    ↓
status / steer / abort / settlement
    ↓
wake durável do agente pai
    ↓
projeção SSE/UI
```

O concorrente expõe boas ideias de lifecycle, subagentes, wakes e mensagens agente→agente. Porém, o snapshot reconstruído não demonstra essas capacidades como um runtime de produção completo: há partes inativas, filas em memória, cobertura de testes pequena e um caminho de child runner sem shell de produção.

### 2.3 Decisão recomendada

**Adotar por clean-room:** contratos, estados, observabilidade, limites, testes e experiência de uso.  
**Preservar do OpenBot:** SQLite, nonce durável, filas por agente, WSL2, cgroups, proteção de paths, DPAPI, preload explícito e renderer atual.  
**Recusar:** código/assets/binários do concorrente, renderer 0.18, transcript JSON, inbox em memória, worker/processo por agente, `5000` passos e marketplace remoto.

### 2.4 Verificação focada executada nesta consolidação

Depois da revalidação estática, foram executados apenas gates locais relacionados às afirmações centrais:

```text
npx vitest run test/performance-regression.test.ts test/transcript-optimization.test.ts test/stream-state.test.ts test/roster-agents.test.ts --reporter=dot
→ 4 arquivos / 57 testes passaram

npx vitest run test/memory-context.test.ts test/rpc-send.test.ts --reporter=dot
→ 2 arquivos / 65 testes passaram

npx vitest run test/fidelity-windows.test.ts --reporter=dot
→ 1 arquivo / 15 testes passaram
```

Total focado: **7 arquivos / 137 testes aprovados**. Isso valida os contratos exercitados; não equivale à suíte completa, provider live ou teste visual do concorrente.

---

## 3. Fronteiras técnicas que não podem ser confundidas

### 3.1 O OpenBot não é um frontend React convencional

O renderer ativo é o bundle extraído 0.16 carregado por:

- `client/extracted/dist/renderer/index.html:11-14`;
- `client/extracted/dist/renderer/assets/index-DVUCYGay.js`;
- overlays locais `client/extracted/dist/renderer/assets/openbot-local-settings.js` e `client/extracted/dist/renderer/assets/openbot-memory-ui.js`.

A seam suportada para ajustes estreitos continua sendo:

```text
client/extracted/dist/renderer/assets/openbot-local-settings.js
```

A decisão já registrada em `docs/openbot-visual-parity-grokbot-2026-08-19.md:27-38,112-122,268-278` é:

- não reconstruir o React do produto;
- não trocar o cliente por 0.18;
- não editar chunks, CSS minificado ou sourcemaps proprietários;
- manter Computer, Plugins e rotinas fora enquanto não forem decisões explícitas de produto.

Este relatório **não reabre essa decisão**.

### 3.2 O `frontend/` do concorrente não é o renderer empacotado

O próprio concorrente descreve `frontend/` como reconstrução parcial e workspace de design. O empacotamento de fidelidade continua usando o renderer publicado, fixado por checksum, com transformação estreita.

Evidências:

- [README — natureza híbrida e frontend parcial](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/README.md#L180-L210)
- [build.mjs — renderer fixado](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/scripts/build.mjs#L1-L5)
- [clean-build.mjs — renderer de fidelidade](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/scripts/lib/clean-build.mjs#L75-L83)

Consequência: uma página bonita no diretório **frontend/src/** do snapshot concorrente prova apenas uma ideia reconstruída. Não prova que a página está no pacote, funciona no bundle final ou é compatível com o OpenBot.

### 3.3 “Reconstructed” não significa “Open Source reutilizável”

O repositório concorrente não possui `LICENSE`. Seu `NOTICE` declara que nenhuma licença upstream é concedida, e `PROVENANCE` confirma a retenção de instaladores, renderer otimizado e artefatos publicados.

- [NOTICE](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/NOTICE.md#L7-L15)
- [PROVENANCE](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/PROVENANCE.md#L13-L35)

O OpenBot também declara `"private": true` e `"license": "UNLICENSED"` em `package.json:2-8`, além de manter artefatos extraídos registrados em `client/client-artifacts.manifest.json`.

Conclusão técnica, não parecer jurídico: nenhum dos conjuntos deve ser chamado de Open Source integral ou redistribuído sem separar autoria, licença e procedência de cada componente.

---

## 4. Como o OpenBot funciona hoje

### 4.1 Mapa de componentes

```text
Renderer extraído + overlays locais
            │ RPC HTTP + SSE, loopback/token
            ▼
Gateway / handlers RPC
            │
            ├─ Roster/config por agente
            ├─ Conversation/transcript/memory em SQLite
            ├─ TurnRunner e fila exclusiva por agente
            ├─ Provider router
            ├─ Tool loop / approvals / MCP / Skills
            ├─ Browser compartilhado com partição por agente
            └─ Runtime WSL2 compartilhado com leases e workspace por agente
```

### 4.2 O que é um agente no OpenBot

Um agente permanente é um registro de produto, não um processo isolado:

- identidade, nome e descrição;
- provider e modelo;
- modo de runtime;
- avatar e preferências;
- home/workspace;
- conversa default, transcript e memória associados.

Referência: `src/rpc/roster.ts:56-96`.

A criação em `src/rpc/roster.ts:409-482` coordena config, home, conversa default e publicação de roster. A exclusão em `src/rpc/roster.ts:662-806` instala fence, cancela ou aguarda turns, fecha recursos e possui compensação/rollback.

### 4.3 Como um turno é aceito e executado

```text
sendPrompt
  1. valida agente, conversa, anexos e nonce
  2. se recebeu clientNonce, faz claim/dedupe durável
  3. responde {accepted:true}
  4. entra na fila exclusiva do agente
  5. prepara contexto/provider/tools
  6. executa stream
  7. publica atualizações SSE
  8. persiste checkpoints/final
  9. fecha turn attempt e acorda reflection quando aplicável
```

O contrato do ACK é descrito em `src/rpc/send.ts:1222-1228`; a persistência/claim atômico do nonce ocorre efetivamente em `src/rpc/send.ts:1306-1317`. Porém, `clientNonce` é opcional no contrato atual (`src/shared/contracts.ts:76`). Portanto, um ACK **sem nonce** confirma aceitação para processamento, mas não oferece deduplicação durável de retries; com nonce, o claim impede que o mesmo turno lógico seja executado duas vezes. A UI atual deve continuar enviando nonce, e as novas APIs de async task/subagente propostas neste relatório devem torná-lo obrigatório.

### 4.4 Concorrência atual

- Uma Promise-chain por agente: `src/rpc/send.ts:1083-1091`.
- Máximo de oito prompts pendentes por agente: `src/rpc/send.ts:743-750,1309-1354`.
- O mesmo agente é serializado.
- Agentes diferentes podem usar providers simultaneamente: `test/performance-regression.test.ts:301-365`.
- O scheduler em `src/execution/runtime/scheduler.ts` limita leases de execução, **não** turns de provider.

Essa última distinção é a razão da recomendação de admission control global antes de subagentes.

### 4.5 Persistência atual

O OpenBot usa um SQLite compartilhado, particionado logicamente por `agent_id` e `conversation_id`. Ele armazena:

- roster/config em stores próprios;
- conversas e conversa ativa;
- transcript ordenado;
- ledger de nonces;
- turn attempts;
- summaries, memórias e reflection jobs.

Referências: `src/main.ts:670-739`, `src/store/index.ts`, `src/store/schema.ts`, `src/memory/sqlite-store.ts`.

Migrar para um DB/processo por agente não é recomendação confirmada. Primeiro seria necessário demonstrar contenção real do SQLite atual.

### 4.6 Features multiagente — fotografia histórica de 24/08/2026

Esta seção descrevia o estado **antes** do fechamento P2.1–P2.8. Não é o estado atual. A autoridade de aceite é o roadmap (`docs/superpowers/plans/2026-08-24-openbot-grokbot-018-execution-roadmap.md`) e o código citado abaixo.

**O que o texto de 24/08 afirmava (obsoleto):** `getSubagents` / `getAsyncTasks` retornavam `[]`; não havia publishers dos canais `subagents`/`async-tasks`; não havia SendToAgent, inbox, steer, abort ou wake. A evidência apontada (`src/rpc/roster.ts:1119-1120`) era um stub já removido — essa linha hoje pertence a `testProviderConnection`.

**Estado atual:**

- `getAsyncTasks`, `getSubagents` e `listAsyncTasks` listam o store durável (`src/rpc/tasks.ts:108-110`).
- Steer/abort: `steerAsyncTask` / `abortAsyncTask` (`src/rpc/tasks.ts:138-157`).
- A2A: `sendAgentMessage`, inbox e ACK (`src/rpc/a2a.ts:42-80`).
- `kickstartAgent` sem `mode` continua no-op legado (`src/rpc/roster.ts:399-406`). Com `{ mode: "onboarding" }` inicia um turno (`src/rpc/send.ts:1524-1587`).

---

## 5. Revalidação dos P0, P1 e P2 históricos

O documento `analysis_outputs/SUMMARY.md` foi escrito em 14/08. Esta seção evita transformar dívida histórica em backlog falso.

### 5.1 Resumo de status

| Prioridade histórica | Objetivo original | Estado atual | Decisão consolidada |
|---|---|---|---|
| P0 | Baseline e proteção contra regressão | **PARCIAL NA ANÁLISE HISTÓRICA; FECHADO NO EXIT AUDIT** | A análise original registrava métricas incompletas; o fechamento final passou os batches P0/P1 e o benchmark estrutural |
| P1 | Transcript e streaming | **ESSENCIALMENTE IMPLEMENTADO; FECHADO NO EXIT AUDIT** | Preservar; o update completo limitado foi a alternativa compatível prevista no plano |
| P2 | Gerenciador de contexto | **PARCIAL NA ANÁLISE HISTÓRICA; P2.1–P2.8 FECHADOS NO ROADMAP** | A dívida histórica de precisão por modelo permanece registrada; a expansão P2 foi aceita com as limitações residuais acima |

### 5.2 P0 histórico — baseline e proteção contra regressão

#### P0-H1 — benchmarks para transcript grande

**Implementado:**

- `test/performance-regression.test.ts:35-37,271-299` pagina 20.000 entries e exige evento limitado a 128 KiB;
- `scripts/benchmark-hot-paths.mjs:20-33,107-132` mede o mesmo domínio;
- `scripts/benchmark-hot-paths.mjs:434-558` monta contexto com 20.000 entries, 2.000 memórias e sentinelas de isolamento.

#### P0-H2 — medir todo o hot path

**Parcial:** os benchmarks medem duração, bytes de evento, paginação, fairness, capacidade de runtime e cap de contexto. Ainda não existe um gate único que meça, no caminho Electron real:

- tempo até primeiro token;
- event-loop lag;
- writes SQLite por turno;
- bytes SSE acumulados por turno;
- pico de memória;
- tamanho exato do request ao provider;
- resposta longa com muitos deltas;
- avatar máximo no hot path;
- múltiplos anexos no limite;
- provider lento sob vários agentes.

#### P0-H3 — budgets por hardware-alvo

**Decisão substituída, com gap diagnóstico residual:** o projeto adotou gates estruturais determinísticos, explicitamente sem transformar uma máquina específica em SLO (`docs/openbot-multibot-performance-gates.md:30-36`). Isso é mais estável para regressão. Um perfil Windows real pode ser acrescentado como diagnóstico/versionamento do ambiente, mas não deve virar blocker variável sem um plano separado.

### 5.3 P1 histórico — transcript e streaming

#### P1-H1 — queries limitadas no store

**Implementado:**

- statements preparados para páginas, entries recentes, último assistant e tool calls abertas: `src/store/index.ts:623-679`;
- APIs: `getRecentEntries`, `getLatestAssistant` e `getOpenToolCalls`: `src/store/index.ts:1324-1355`;
- montagem de contexto consome apenas entries recentes: `src/rpc/send.ts:2007-2035`.

#### P1-H2 — remover snapshot integral

**Implementado por estratégia equivalente, não literalmente removido:**

- o início do turno ainda publica `snapshot`: `src/rpc/send.ts:1626-1627`;
- porém ele usa `openAgentTail` com página limitada: `src/rpc/send.ts:1247-1252`;
- quando há páginas anteriores, o cliente recebe truncamento/resync em vez de payload ilimitado.

Isso fecha o risco do snapshot de vários MiB sem quebrar o contrato do renderer.

#### P1-H3 — separar estado live da persistência

**Implementado:**

- `liveAssistant` mantém o texto em memória: `src/rpc/send.ts:1080`;
- publicação a cada 100 ms e persistência a cada 1 s: `src/rpc/stream-state.ts:1-3`;
- aplicação do delta e checkpoints: `src/rpc/send.ts:2131-2185`;
- resposta live limitada a 192 KiB.

#### P1-H4 — delta/adaptive update

**Implementado pela alternativa compatível prevista:** a cadência é adaptativa e `publishUpdate` envia a mesma entry acumulada no máximo a cada 100 ms: `src/rpc/send.ts:2153-2161,2249-2278`. Não existe evento `delta` dedicado, mas o plano histórico permitia explicitamente uma atualização completa menos frequente quando o cliente não aceitasse delta.

O protocolo só deve mudar novamente se um benchmark do renderer real demonstrar custo material. Ausência de `delta` não é, sozinha, dívida ou bug.

#### P1-H5 — prepared statements

**Implementado no hot path principal:** `src/store/index.ts:559-734`. Há `.prepare()` ad hoc em operações administrativas e snapshots, mas isso não prova gargalo do turno.

### 5.4 P2 histórico — gerenciador de contexto

#### P2-H1 — catálogo de capacidades do modelo

**Parcial:** `src/config/models.ts:8-12` já registra `contextWindow` e suporte a visão. Ainda faltam capacidades uniformes como:

- limite de saída;
- suporte a tools/reasoning;
- tokenizer/estimador selecionado;
- suporte seguro a resume/checkpoint.

Além disso, o `contextWindow` catalogado ainda não dirige o hard cap do assembler.

#### P2-H2 — budget com reserva de saída

**Implementado em bytes, não em tokens/modelo:**

- hard cap de 256 KiB;
- reserva de saída de 24 KiB;
- desconto de system prompt e schemas de tools;
- redução progressiva de histórico, memórias, summaries e mensagens recentes.

Referências: `src/memory/context.ts:7-13,791-899`.

É uma proteção real e conservadora. A dívida restante é precisão por modelo, não ausência de controle.

#### P2-H3 — limites agregados para anexos e tools

**Implementado como limites por bytes:**

- 16 anexos, 4 MiB totais, cap por texto/PDF: `src/rpc/attachments.ts:5-8,179-202`;
- `stat` antes da leitura integral: `src/rpc/attachments.ts:137-149`;
- 128 KiB de tool results por round, com truncamento JSON válido: `src/execution/tool-loop.ts:9-12,104-130,250-270`.

Ainda não é um orçamento único por tokens compartilhado entre transcript, anexos e tools.

#### P2-H4 — summary incremental e retrieval de anexos

**Parcial:** summaries e reflection jobs duráveis existem e possuem recovery. Não há um armazenamento/chunk retrieval de anexos equivalente; o texto extraído ainda entra no contexto/transcript limitado.

Conclusão: manter summaries/memória atuais e avaliar chunking apenas com casos reais de arquivos grandes. Não introduzir vector DB por reflexo arquitetural.

---

## 6. Como o concorrente funciona de ponta a ponta

> Nesta seção e nas seções 8–9, qualquer shorthand iniciado por `concorrente:` pertence ao snapshot externo fixado, não ao checkout OpenBot. Os links GitHub são a referência reproduzível.

### 6.1 Build e produto final

```text
instalador upstream fixado por hash
          ↓
extração/verificação
          ↓
runtimes reconstruídos em TypeScript
          +
renderer upstream otimizado
          +
transformação estreita de settings/router
          ↓
aplicação macOS ad-hoc signed
```

O alvo suportado é macOS Apple Silicon. O instalador Windows preservado é evidência de pesquisa, não um target de build suportado.

### 6.2 Roteamento de inferência

O coordenador intercepta requests e escolhe entre o caminho nativo e providers roteados. O router experimental oferece Cursor, Claude Code, Codex e OpenRouter.

No caminho não-Cursor:

- mantém transcript JSON por agente;
- limita o histórico local aos últimos 200 registros;
- chama provider/API/CLI;
- projeta tools por bridge.

Referências:

- [coordinator main](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/node-agent-coordinator/main.ts#L213-L230)
- [inference router](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/node-agent-coordinator/inference-router.ts#L60-L184)

Esse shim é útil como adapter experimental, mas é inferior ao transcript SQLite/conversas/paginação do OpenBot.

### 6.3 Estado do agente

O `agent-store` reconstruído modela:

- modos `default`, `plan`, `debug` e `search`;
- modo de aprovação;
- metadata do agente;
- informação de subagente;
- checkpoints content-addressed;
- conversa e estado dos filhos.

Referência: [agent-store](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent-kv/agent-store.ts).

A ideia útil é a explicitação dos estados. O backend de storage não deve substituir o SQLite atual.

### 6.4 Lifecycle e kickstart

O lifecycle concorrente cria/abre sessão, marca introdução pendente e pode executar um hidden turn. Isso é diferente do no-op deliberado do OpenBot.

Referência: [agent-lifecycle](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/extensions/transcript/agent-lifecycle.ts#L41-L180).

Não há necessidade de importar kickstart apenas para atingir paridade. Ele só vale se onboarding autônomo voltar a ser requisito.

### 6.5 Subagentes

O runtime reconstruído mantém maps de sessões, runs, metadata, outlines, steer pendente, aborts e settlement. A API conceitual oferece:

- dispatch em background;
- consulta de status;
- transcript/path da execução;
- steer;
- abort;
- wake do pai quando o filho termina.

Referência: [subagent-runtime](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/runner/subagent-runtime.ts#L152-L317).

#### Limitação crítica confirmada

Na composição do child runner, `productionTurnRunShell` fica indefinido. O `run()` pode terminar sem objeto de resultado, enquanto o chamador exige esse objeto e lança erro.

Referência: [host-runner-composition](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/host-runner-composition.ts#L2441-L2469).

Logo, o concorrente oferece um desenho de subagentes, não uma implementação production-proven que possa ser copiada.

### 6.6 Mensageria agente→agente

O `AgentToAgentMessaging` valida origem/alvo, registra mensagens no transcript, mantém fila inbound por destinatário e pode acordar o receptor. Mensagens prioritárias preemptam somente lanes não-user.

Referência: [agent-to-agent-messaging](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/extensions/transcript/agent-to-agent-messaging.ts#L47-L272).

Problemas que impedem adoção direta:

- inbox pendente em memória;
- persistência outbound pode ocorrer antes da entrega inbound;
- crash entre essas etapas pode perder a entrega;
- não foi encontrado ACK durável;
- não há limite rígido confirmado de hop, loops, fan-out ou concorrência;
- policy no prompt não é enforcement.

### 6.7 Wakes

O concorrente usa filas de wake para mensagens inbound, eventos e conclusão de filhos. A ideia é valiosa: o agente pai não deve fazer polling contínuo.

Referência: [background-wakes](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/extensions/transcript/background-wakes.ts#L175-L268).

No OpenBot, wake genérico deve ser durável e idempotente. O padrão já demonstrado pelos reflection jobs pode inspirar recovery, sem misturar os domínios.

### 6.8 Workers e limites

O pool concorrente aceita até 64 workers e tenta remover workers ociosos ([agent-worker-pool](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/agent-isolation/agent-worker-pool.ts#L259-L319)). O runner também admite até `5000` passos em uma composição ([turn-agent-composition](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/runner/turn-agent-composition.ts#L130-L150)).

Esses números não devem ser transplantados:

- per-agent workers/processes pesariam o PC e contradizem o runtime compartilhado do OpenBot;
- milhares de passos sem orçamento de custo, tempo e efeitos ampliam risco de loops;
- limites devem nascer de benchmark no hardware-alvo.

---

## 7. Comparação do runtime de agentes

| Capacidade | OpenBot atual | Concorrente reconstruído | Decisão |
|---|---|---|---|
| Identidade/config por agente | Persistente e ativa | Presente | Preservar OpenBot |
| Transcript | SQLite, conversas, paginação, nonce e resync | JSON local no router; store reconstruído em outro caminho | Não substituir OpenBot |
| Fila do mesmo agente | Exclusiva e limitada | Promise-chain/lane | Equivalente no princípio |
| Concorrência entre agentes | Livre entre filas, sem cap global de provider | Sem orçamento rígido confirmado | Adicionar admission control global |
| Async tasks genéricas | Canal/stub; reflection é job real separado | Registry/wakes reconstruídos | Criar camada durável no OpenBot |
| Subagentes | Stub vazio | API rica, caminho incompleto | Reimplementar depth-1 clean-room |
| Steer/abort do filho | Ausente | Presente em memória | Adicionar estados idempotentes |
| Agente→agente | Ausente | Inbox/wake, durabilidade insuficiente | Só após subagentes duráveis |
| Kickstart | No-op deliberado e testado | Hidden turn real | Opcional, não blocker |
| Provider adapters | OpenAI, xAI, OpenAI-compatible | Cursor, Claude Code, Codex, OpenRouter | Adapters opcionais P2 |
| Resume pós-saída | Retry só antes de saída observável | Checkpoint/resume experimental | Só com idempotência comprovada |
| Isolamento de execução | WSL2, network deny, cgroup, paths resistentes a race | Pode cair em modos menos isolados | Preservar OpenBot |
| Segredos Windows | DPAPI/safeStorage | Abstração reconstruída | Preservar OpenBot |

### 7.1 Definições para não confundir entidades

- **Agente permanente:** identidade/config/home/memória de produto.
- **Turno:** uma solicitação de usuário aceita por nonce.
- **Async task:** registro durável de trabalho em background, independentemente de quem o executa.
- **Subagente:** um executor temporário vinculado a uma async task e a um pai.
- **Mensagem A2A:** envelope durável enviado entre agentes permanentes.
- **Wake:** sinal idempotente de que existe trabalho/evento persistido a consumir.

Um subagente **não deve criar automaticamente um novo processo, DB ou home permanente**. Por padrão, ele é um run temporário no runtime compartilhado, com escopo e orçamento derivados do pai.

---

## 8. Páginas e navegação

### 8.1 Mapa das superfícies reconstruídas do concorrente

`concorrente:frontend/src/production/ProductionRenderer.tsx` concentra aproximadamente 3.700 linhas e compõe:

- gates de login, onboarding, privacidade e update;
- sidebar, conversa, transcript e composer;
- org chart e computer;
- settings do agente e avatar;
- grupos/salas, canais e rotinas;
- outline/subagents e async tasks;
- settings, plugins e hidden chats;
- command palette, find, confirmações, mídia, PDF e planilha.

A navegação é state-driven, apropriada a um desktop Electron. Não existe justificativa para introduzir um router web no OpenBot apenas por paridade.

### 8.2 Dívidas confirmadas no frontend reconstruído

#### Manifesto de rota obsoleto

[O manifesto do concorrente](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/manifests/reconstruction/renderer-closure.json#L2141-L2148) registra `features/chat/workspace/entrypoint.ts`, mas a composição real usa `conversation/workspace`, e o arquivo listado não existe. A validação atual confere metadados/contagens, não resolução de cada route entry.

#### Fallback vazio

Org chart, hidden chats e computer usam `Suspense fallback={null}` em [concorrente:ProductionRenderer.tsx](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/frontend/src/production/ProductionRenderer.tsx#L3475-L3480), também em `:3630,3731`. Em loading/falha, a superfície aparenta estar vazia.

#### Erros de rotinas silenciados

[A view de rotinas do concorrente](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/frontend/src/recovered/features/automations/routines/view.tsx#L184-L220), também em `:302`, engole rejeições de create/update/toggle/remove/run e pode renderizar status vazio em falha.

Esses são achados da reconstrução legível, não prova de bug no renderer empacotado upstream.

### 8.3 Regra para novas páginas OpenBot

Antes de criar qualquer painel de subagentes/async tasks:

1. implementar o contrato backend e os eventos;
2. testar persistência, ordenação, reconnect e teardown;
3. verificar se o renderer 0.16 ativo já consome `getSubagents`, `getAsyncTasks` e os canais correspondentes;
4. se a superfície nativa existir, alimentar o contrato esperado;
5. se não existir, não editar chunks para “forçar” a página;
6. qualquer overlay novo deve ser uma decisão explícita, estreita e coberta por Electron E2E.

### 8.4 Estados mínimos de uma página de async tasks

Uma implementação aceitável precisa distinguir:

- loading;
- vazio legítimo;
- indisponível/não implementado;
- erro sem dados;
- erro com dados anteriores preservados;
- running;
- retry agendado;
- failed com motivo sanitizado;
- completed/cancelled;
- reconnect/resync.

`fallback={null}` e `.catch(() => {})` não são padrões aceitáveis.

---

## 9. Effects, hooks e lifecycle

### 9.1 Inventário do concorrente

Contagem lexical em `concorrente:frontend/src/**/*.{ts,tsx}`:

- 239 `useEffect`;
- 10 `useLayoutEffect`;
- 54 `useSyncExternalStore`;
- 197 ocorrências de `subscribe`;
- 9 `setInterval`;
- 26 `setTimeout`;
- 11 `requestAnimationFrame`;
- 5 `ResizeObserver`;
- 1 `IntersectionObserver`;
- nenhum `MutationObserver`.

Contagem lexical não equivale a instâncias runtime e não prova leak.

### 9.2 O que está bem feito

- bootstrap sob `React.StrictMode`: [concorrente:bootstrap.tsx](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/frontend/src/production/bootstrap.tsx#L32-L35);
- guards de atividade/geração em operações assíncronas;
- subscriptions com cleanup;
- guard específico de disposal para replay do StrictMode: [strict-mode-disposal](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/frontend/src/production/strict-mode-disposal.ts#L9-L26).

Não foi confirmado um vazamento generalizado, stale closure sistêmico ou ausência ampla de cleanup.

### 9.3 Dívida de performance confirmada

Um effect em [concorrente:ProductionRenderer.tsx](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/frontend/src/production/ProductionRenderer.tsx#L1662-L1707) consulta todos os `.sand-file-attachment-chip`, restaura atributos e reinstala listeners quando `entries` muda. O transcript atualiza `entries` durante streaming em `:2355-2408`.

Impacto: scans DOM e churn de listeners mesmo quando os anexos não mudaram.

Correção recomendada para uma implementação própria:

- assinatura estável baseada apenas nos anexos; ou
- um listener delegado no container;
- teste com 100 atualizações de texto e conjunto de anexos constante.

Esse achado não justifica portar o componente para o OpenBot.

### 9.4 OpenBot override

O override ativo não usa hooks React. Ele possui:

- um `MutationObserver`: `openbot-local-settings.js:1952-1997`;
- timers rastreados;
- cleanup de observers, listeners, timers, RAF e animações em `:2004-2025`;
- teardown em `pagehide`.

Há uma **hipótese a medir**: `reconcileAgentAvatars()` faz `querySelectorAll("svg[data-state]")` e é chamado em callbacks do observer (`:771-782,1952-1973`). Em mutation storm, isso pode custar CPU. O cleanup está correto; não alterar antes de medir frequência e custo no renderer real.

### 9.5 Invariantes de lifecycle

1. Todo observer/listener/timer/RAF criado deve ter cleanup.
2. Promises tardias devem validar generation/active antes de atualizar estado.
3. `useSyncExternalStore` deve receber `subscribe` estável e snapshot consistente.
4. Um chip não pode acumular múltiplos pares de listeners.
5. `pagehide` deve tornar callbacks posteriores inertes.
6. StrictMode mount/unmount/replay precisa de teste explícito em qualquer frontend próprio futuro.

---

## 10. Segurança e execução: o que o OpenBot já faz melhor

O concorrente não oferece motivo para substituir estes componentes:

### 10.1 Isolamento

O OpenBot usa por **default** WSL2, rede negada, supervisor/cgroups e runtime compartilhado sob demanda. Existe um runner nativo opt-in quando `OPENBOT_RUNTIME_DRIVER=local` (`src/main.ts:434-463`); ele preserva argv/cwd/allowlists, mas declara explicitamente não ser sandbox de kernel (`src/execution/runtime/local/driver.ts:72-75`). O concorrente possui caminhos que podem operar com isolamento mais fraco. Não normalizar fallback inseguro nem descrever o modo nativo como equivalente ao WSL2.

### 10.2 Filesystem

`src/execution/workspace.ts` e `src/execution/commands.ts` verificam realpath, links/reparse points e identidade do arquivo antes do uso. Copiar um containment apenas lexical/realpath reduziria resistência a TOCTOU.

### 10.3 Segredos

O backend Windows usa DPAPI/safeStorage e limpa buffers sensíveis. Não substituir por um armazenamento reconstruído genérico.

### 10.4 Preload/IPC

O preload do OpenBot expõe uma bridge explícita. Não ampliar para canais arbitrários ou `any` para obter paridade rápida.

### 10.5 Transcript e recuperação

O OpenBot possui ledger de nonce, turn attempts, recovery, paginação e resync. Não substituir pelo JSON dos últimos 200 eventos do inference router concorrente.

---

## 11. Roadmap consolidado P0/P1/P2

### P0 — pré-condições

#### P0.1 — ledger de procedência e regra clean-room

**Objetivo:** impedir que uma implementação use código/artefato sem autorização ou confunda reconstrução com fonte original.

**Estado atual:** manifests e hashes existem, mas não há uma licença de conjunto nem uma allowlist de reutilização.

**Entrega mínima:**

- registrar origem de cada componente usado;
- classificar `código próprio`, `dependência licenciada`, `artefato extraído`, `referência observacional` e `não reutilizável`;
- exigir que qualquer ideia do concorrente seja reimplementada sem copiar código, prompt, asset ou patch;
- manter commit/arquivo usado como evidência comportamental.

**Critérios de aceite:**

- nenhum arquivo do concorrente entra no diff;
- nenhuma mudança em chunk/CSS/sourcemap proprietário;
- relatório de autoria aponta quem escreveu a implementação local;
- revisão separa integridade por hash de autenticidade/licença.

#### P0.2 — completar baseline do hot path

**Objetivo:** medir antes de otimizar streaming, contexto ou concorrência global.

**Reaproveitar:** `test/performance-regression.test.ts` e `scripts/benchmark-hot-paths.mjs`.

**Adicionar:**

- resposta longa com milhares de deltas;
- contagem de updates SSE e writes SQLite;
- bytes acumulados e tamanho final;
- TTFT e event-loop lag;
- pico de heap;
- avatar máximo;
- 16 anexos próximos do cap agregado;
- provider lento com múltiplos agentes;
- perfil do hardware/Node/Electron no artefato, como metadata diagnóstica.

**Critério principal:** o gate estrutural deve falhar por budget objetivo, não por comparação casual de uma execução. Metadata de hardware não deve, sozinha, criar um SLO dependente desta máquina; qualquer benchmark live/hardware-specific exige um plano separado.

#### P0.3 — contrato de async task/subagente antes da UI

**Objetivo:** impedir que UI, scheduler e persistência inventem estados diferentes.

**State machine mínima recomendada:**

```text
queued → admitted → running → completed
                 ├→ retry_wait → admitted
                 ├→ failed
                 ├→ cancelling → cancelled
                 └→ abandoned (detectado no recovery)
```

| Estado | Autoridade para avançar | Próximos estados permitidos |
|---|---|---|
| `queued` | dispatcher/scheduler | `admitted`, `cancelled` |
| `admitted` | dono do lease ou recovery | `running`, `cancelling`, `abandoned` |
| `running` | executor dono do lease | `completed`, `failed`, `retry_wait`, `cancelling`, `abandoned` |
| `retry_wait` | retry scheduler | `admitted`, `failed`, `cancelled` |
| `cancelling` | executor/reaper | `cancelled`, `abandoned` |
| `abandoned` | recovery worker | `retry_wait`, `failed`, `cancelled` |
| terminal | ninguém | imutável; só metadados não semânticos podem ser anexados |

Toda transição deve usar compare-and-swap de versão/status. Um callback em memória nunca é autoridade suficiente.

**Campos conceituais mínimos:**

- `taskId`, `agentId`, `parentTurnId`;
- `kind`, `status`, `attempt`, `version`;
- `createdAt`, `startedAt`, `finishedAt`;
- `progress` sanitizado;
- `resultRef` ou resultado limitado;
- erro sanitizado/retryable;
- nonce/dedupe;
- ownership/lineage.

**Separação mínima de registros:**

- a **task lógica** possui identidade e lineage imutáveis e é criada idempotentemente uma vez;
- cada retry cria ou atualiza um **attempt** separado, sem fingir que a task foi executada uma única vez;
- eventos SSE e wakes saem de uma **outbox durável**, não de callbacks em memória.

**Contrato transacional mínimo:**

1. **Dispatch:** exigir `clientNonce` não vazio e, numa transação, inserir a task com unicidade por `(agentId, clientNonce)` e registrar o evento `task-created`; colisão retorna a task existente, não cria outra. O endpoint novo não deve herdar a opcionalidade do `sendPrompt` atual.
2. **Claim:** usar compare-and-swap de `status + version`; somente `queued` ou `retry_wait` elegível pode virar `admitted`.
3. **Significado de `admitted`:** um executor recebeu um lease exclusivo, com `leaseOwner`, `leaseExpiresAt` e attempt atual, mas ainda não confirmou `running`.
4. **Start/heartbeat:** apenas o `leaseOwner` e a versão atual podem marcar `running` ou renovar o lease. Heartbeat não altera lineage nem cria outro wake.
5. **Steer/abort:** gravar a intenção/version primeiro; somente pai/usuário autorizado no mesmo escopo pode emiti-la. Repetir a mesma operação retorna o estado atual.
6. **Terminal:** resultado limitado, estado terminal e evento/wake de outbox entram na mesma transação.
7. **Wake:** entrega física pode ser at-least-once; a unicidade `(taskId, transitionVersion, wakeKind)` garante efeito lógico único no pai.
8. **Recovery:** lease expirado em `admitted/running/cancelling` vira `abandoned` por CAS e, conforme política/budget, segue para `retry_wait`, `failed` ou `cancelled`. Nenhum processo interrompido pode continuar sendo dono válido.
9. **Autorização:** RPC user-side exige gateway autenticado e task do agente selecionado; comando agent-side exige `parentAgentId/parentTurnId` compatível. Um filho não pode steer/abort task alheia.

**Índices/invariantes mínimos:**

- unique `(agent_id, client_nonce)`;
- índice de claim por `(status, next_attempt_at)`;
- índice por pai/lineage;
- no máximo um lease ativo por task;
- outbox única por transição e índice de eventos não entregues.

**Contrato conceitual de delegação de capacidades:**

```ts
type DelegatedCapabilityGrant = {
  grantId: string;
  taskId: string;
  parentAgentId: string;
  parentTurnId: string;
  childRunId: string;
  kind: "provider" | "filesystem" | "process" | "browser" | "mcp" | "skill";
  constraints: Record<string, unknown>; // validado por schema fechado para cada kind
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
  version: number;
};
```

Esse tipo é um contrato de arquitetura, não código já existente. As regras de enforcement são:

1. **Default deny:** sem grant válido, a operação é recusada. O grant efetivo é a interseção entre pedido do filho, permissões atuais do pai e política dura do produto; nunca uma cópia irrestrita do ambiente do pai.
2. **Sem segredos no registro:** persistir apenas referências opacas a credenciais/provider já protegidas. Token, cookie, API key e conteúdo DPAPI descriptografado não entram em task, grant, transcript ou wake.
3. **Constraints tipadas por fronteira:** provider restringe adapter/modelos; filesystem/process restringe operações, raiz de workspace, perfil de rede e executáveis; browser restringe classes de comando, origens e partição do agente pai; MCP restringe servidores/tools; skill restringe IDs de skills permitidas. `Record<string, unknown>` acima não autoriza campos arbitrários: cada `kind` precisa de schema fechado.
4. **Enforcement no ponto do efeito:** validar o grant em toda chamada no broker de execução, adapter de provider, browser service, dispatcher MCP e loader de skills. Instrução no system prompt é orientação, não controle de segurança.
5. **Expiração e revogação:** grant expira no máximo com task/lease; abort, fence/exclusão do pai ou revogação incrementam versão por CAS e bloqueiam novos efeitos. Operação já iniciada recebe cancelamento quando o subsistema suportar.
6. **Sem escalada/delegação recursiva:** filho depth-1 não pode ampliar constraints nem emitir grants para outro filho.
7. **Auditoria:** registrar `grantId`, decisão allow/deny, fronteira, operação sanitizada, task/attempt e timestamp; nunca o segredo ou payload sensível integral.

**Contrato conceitual de orçamento do subagente:**

```ts
type SubagentBudget = {
  maxWallMs: number;
  maxProviderCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolRounds: number;
  maxToolCalls: number;
  maxMcpCalls: number;
  maxBrowserCommands: number;
  maxResultBytes: number;
  maxWorkspaceWriteBytes: number;
  maxDepth: 1;
};
```

Também é um contrato proposto. O budget efetivo é o menor valor entre caps duros do produto, saldo restante do pai e pedido do dispatch. Ele é persistido com a task; todos os attempts e retries compartilham os mesmos contadores e **não** recebem saldo novo. `maxWallMs` conta desde a criação até o estado terminal, incluindo fila e `retry_wait`; lease/heartbeat possui TTL operacional separado e menor. Antes de provider/tool/MCP/browser/write, o executor reserva o pior custo contabilizável numa atualização transacional e reconcilia o uso real depois. Contagem de tokens desconhecida usa estimador conservador e falha fechada no limite. Resultado maior que `maxResultBytes` é truncado com marcador explícito. Esgotamento encerra como `budget_exhausted`/resultado parcial sanitizado, sem retry implícito. Concorrência pertence ao scheduler de P1.1, não a este objeto; limites já existentes do tool loop continuam como teto duro adicional. Custo monetário só deve virar gate quando o adapter produzir uso autoritativo, portanto não foi inventado um `maxCost` neste documento.

O nome exato das tabelas não está congelado neste relatório, mas uma implementação que não resolve essas semânticas ainda não está pronta para patch.

#### P0.4 — preservar a boundary do renderer

**Objetivo:** manter novas capacidades independentes do markup proprietário.

**Critérios:** contrato tipado → RPC/preload → fixture → Electron real → projeção visual. Nunca inverter essa ordem.

### P1 — núcleo recomendado

#### P1.1 — admission control global de turns

**Problema:** hoje cada agente tem sua fila limitada, mas agentes diferentes podem abrir streams de provider sem teto global.

**Unidade do limite:** uma chamada ativa a `ProviderAdapter.streamChat`, desde imediatamente antes do request até resolver/abortar. Preparação de contexto/SQLite não consome slot. Tool execution continua sob seus próprios limites; enquanto uma tool roda não há provider slot retido. O round seguinte e cada retry precisam readquirir o scheduler com fairness. Subagentes usam o mesmo scheduler.

**Escopo:** singleton no processo OpenBot atual. Uma futura arquitetura multiprocesso exigiria coordenação diferente e está fora deste relatório.

**Implementação recomendada:** envolver o início do provider attempt em um scheduler global com:

- limite configurável;
- fairness round-robin por agente;
- FIFO dentro de cada agente;
- remoção imediata de item abortado;
- shutdown/drain;
- métricas de espera, ativo e rejeitado;
- cap global de itens aguardando, além do cap de oito por agente;
- control path de cancelamento/steer não fica bloqueado atrás de uma chamada de provider; se ele próprio exigir nova inferência, readquire slot normalmente;
- nenhum controle preempta um stream ativo iniciado pelo usuário de outro agente.

O valor default de `N` não é inventado aqui. P0.2 deve fornecer a evidência e o plano de P1.1 deve registrar o default escolhido, override permitido e comportamento quando a fila global está cheia. Em testes, use valores pequenos determinísticos.

**Não fazer:** serializar todos os agentes globalmente ou reutilizar o scheduler de leases sem separar semânticas.

**Critérios de aceite:**

1. com limite `N`, nunca existem mais de `N` provider streams ativos;
2. mesmo agente continua serial;
3. agentes diferentes progridem sem starvation;
4. abort enquanto aguarda não consome slot;
5. falha não envenena a fila;
6. shutdown não deixa promises pendentes;
7. nonce continua aceito/deduplicado antes da espera.

#### P1.2 — async tasks duráveis e subagentes depth-1

**Problema:** contratos/canais existem, mas o backend retorna arrays vazios.

**Modelo recomendado:**

- `async task` é o registro autoritativo;
- `subagent run` é um executor temporário da task;
- depth máximo inicial = 1;
- runtime, browser e provider usam os serviços compartilhados existentes;
- nenhuma VM/processo/home permanente por subagente;
- filho recebe somente um `DelegatedCapabilityGrant` efetivo, tipado, revogável e validado nas fronteiras reais de efeito;
- cada task persiste um `SubagentBudget`, e retries consomem o mesmo saldo em vez de reiniciá-lo;
- pai recebe wake durável quando o estado terminal é persistido.

**API mínima:**
