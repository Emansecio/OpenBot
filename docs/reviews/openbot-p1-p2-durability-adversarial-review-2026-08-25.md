# Revisão adversarial P1/P2 — durabilidade, isolamento e consistência documental

**Data:** 25/08/2026  
**Escopo:** somente leitura. Async tasks / subagentes, A2A, checkpoint/resume P2.6, effect ledger, kickstart P2.8, isolamento entre agentes/conversas/turnos/reencarnações, e consistência código ↔ testes ↔ documentos finais.  
**Checkout:** `C:\SuperAgent\openbot`  
**Não alterado:** código, manifests, banco, renderer, testes. Este arquivo é o único artefato criado.

**Nota de caminho:** `src/execution/turn-consumer.ts` não existe. O consumidor A2A está em `src/a2a/turn-consumer.ts`.

---

## 1. Veredito executivo

A revisão **não encontrou P0** (exploração imediata em produção com os pares atuais `resume:none`). Encontrou **bugs confirmados** na máquina P2.6 que o roadmap declara completa, um **furo de isolamento ao vivo** nas async tasks após delete/recreate do mesmo `agentId`, e **texto histórico apresentado como estado atual** na seção 4.6 do relatório consolidado.

A2A, o núcleo das async tasks (estados, lease CAS, budget, nonce, rejeição foreign) e o kickstart P2.8 estão, no código examinado, alinhados com os critérios de aceite. Os testes focados executados nesta revisão passaram. Isso **não** prova P2.6: os 8 testes de `p26-resume.test.ts` cobrem o fixture feliz e os guards imediatos; não cobrem cursor subsequente, fence, conversa apagada, `started` in-process nem integração resume↔tool-loop.

**Recomendação:** ACEITAR COM RESSALVAS. Não reabrir P1/P2 inteiro. Corrigir P2.6 e a reincarnação de tasks **antes** de qualquer adapter `resume:cursor` e antes de tratar o isolamento por `agentId` visível como invariante fechada.

Alcance dos bugs P2.6: em produção nenhum par declara `resume: "cursor"` (`src/providers/capabilities.ts:54-77`), e `persistResumeCheckpoint` recusa persistir sem `adapter.resumeChat` (`src/rpc/send.ts:2700-2702`). Os defeitos são reais na implementação aceita; não são exercitáveis por um provider de produção hoje.

---

## 2. Findings confirmados (por severidade)

### F1 — P1 — Bug confirmado — Cursor de resume congela no primeiro evento (`INSERT OR IGNORE`)

**Onde:**

- `src/rpc/send.ts:2697-2729` — `persistResumeCheckpoint` só chama `createResumeCheckpoint`.
- `src/rpc/send.ts:3004-3007` — cada evento `resume-cursor` chama essa persistência.
- `src/rpc/send.ts:2561` — o fim do turno chama a mesma função, não `advanceResumeCheckpoint`.
- `src/store/index.ts:1624-1644` — `INSERT OR IGNORE INTO turn_checkpoints`.

**Reprodução:**

1. Override de capability para `resume: "cursor"` e adapter com `resumeChat` (como em `test/p26-resume.test.ts:42-58`).
2. Adapter emite `resume-cursor: v1` e, mais tarde no mesmo turno, `resume-cursor: v2`.
3. A segunda inserção é ignorada (`createResumeCheckpoint` devolve `false`; o chamador ignora o retorno).
4. Abort + `resumePrompt` usa o cursor `v1`.

**Impacto:** resume fala com o provider num cursor obsoleto. Pode duplicar sufixo, perder tokens ou falhar no adapter. Contradiz o aceite P2.6 de checkpoint no boundary durável atualizado, não “primeiro cursor ganha para sempre”.

**Por que os testes não pegam:** o fixture emite um único cursor no turno inicial (`test/p26-resume.test.ts:236-240`). O teste de store prova que a segunda `createResumeCheckpoint` idêntica retorna `false` (`:91-92`), mas trata isso como idempotência desejada, não como perda de `v2`.

**Menor correção:** no segundo e seguintes cursores do mesmo `(agent, conversation, turn)`, chamar `advanceResumeCheckpoint` (CAS de versão) em vez de `createResumeCheckpoint`. `create` fica só para a primeira linha.

**RED sugerido:** turno com dois eventos `resume-cursor` distintos; abort; `findResumeCheckpoint` deve devolver o último cursor validado; `resumeChat` deve ser invocado com esse cursor.

---

### F2 — P1 — Bug confirmado — `resumePrompt` não replica fence/generation/shutdown do turno normal e não revalida expiry no boundary do provider

**Onde:**

- Aceite sem fence/shutdown/roster: `src/rpc/send.ts:1897-1946`.
- Job enfileirado sem capturar `agentGenerations` nem reconsultar o checkpoint: `src/rpc/send.ts:1935-1945` e `runResumeTurn` em `:1956-2002`.
- Contraste `sendPrompt`: shutdown/fence no aceite (`:1760-1764`) e generation no job (`:1794-1810`).
- Contraste kickstart: generation + fence + shutdown **antes** do provider (`:1578-1586`).
- Expiry só no aceite: `assertCheckpointUsable` em `src/providers/resume.ts:135-141`, usado em `src/rpc/send.ts:1922-1928`. `runResumeTurn` não chama de novo.

**Reprodução A (fence):**

1. Checkpoint válido (fixture `resume:cursor`).
2. Iniciar `deleteAgents` o suficiente para `fenceAgents` (`src/rpc/index.ts:637-643`).
3. `resumePrompt` ainda é aceito (`{ accepted: true }`) e o job não aborta por generation.
4. `runResumeTurn` chama `streamChat` com `resume.cursor` enquanto o agente está em exclusão.

**Reprodução B (expiry TOCTOU):**

1. Checkpoint com `expiresAtMs = now + 1000`.
2. Encher a fila do agente com um turno lento.
3. `resumePrompt` em T=0 passa em `assertCheckpointUsable`.
4. `runResumeTurn` em T>1000 chama o provider com cursor expirado.

**Impacto:** o fail-closed anunciado (“expired/unsafe/foreign falha antes do provider”) vale no instante do RPC, não no instante da chamada. Fence de exclusão, que bloqueia `sendPrompt` e kickstart, não cobre resume.

**Por que os testes não pegam:** `p26-resume.test.ts:173-195` usa `now: () => 2000` com expiry `1000` no mesmo tick, sem fila. Nenhum teste chama `resumePrompt` sob `fenceAgents`/`deleteAgents`.

**Menor correção:** em `resumePrompt`, rejeitar se `shuttingDown` ou `fencedAgents`; capturar `generation` no enqueue; no início de `runResumeTurn`, reler o checkpoint, repetir `assertCheckpointUsable` + `hasUnsafeResumeEffect` + fence/generation, e só então chamar `streamChat`.

**RED sugerido:** (1) expiry que atravessa um item de fila; `streamChat`/`resumeChat` invocations = 0. (2) `fenceAgents` depois do checkpoint; `resumePrompt` não chama o provider.

---

### F3 — P1 — Bug confirmado — Delete de conversa não apaga ledger P2.6/P2.8; `resumePrompt` não exige conversa viva

**Onde:**

- Delete de conversa limpa só um conjunto fixo: `src/conversations/store.ts:450-453` (`transcript_entries`, `accepted_nonces`, `pending_nonces`, `interaction_decisions`, `turn_attempts`, `turn_completions`). **Não** inclui `turn_checkpoints`, `turn_effects`, `kickstart_runs`.
- `resumePrompt` não passa por `resolveConversation` (existência/arquivo/ativo). Usa o `conversationId` do cliente ou o ativo: `src/rpc/send.ts:1902-1912`.
- Lookup do checkpoint é só SQL em `turn_checkpoints`: `src/store/index.ts:1662-1673`.

**Reprodução:**

1. Com `resume:cursor`, persistir checkpoint para `(agent-a, conversation-old, turn-x)`.
2. `deleteConversation` de `conversation-old` (há outra conversa viva).
3. Transcript da conversa some; a linha em `turn_checkpoints` permanece.
4. `resumePrompt({ agentId, turnId: turn-x, conversationId: conversation-old })`.
5. `getEntries` vem vazio → não há assistant completo → checkpoint ainda “usável”.
6. `runResumeTurn` chama o provider com o cursor antigo e prompt `""`.

**Impacto:** isolamento conversa/turno quebrado. Um id de conversa morto continua sendo chave de resume. Efeitos `completed` da conversa apagada também sobrevivem em `turn_effects`.

**Por que os testes não pegam:** nenhum teste P2.6 ou de conversations combina `deleteConversation` com `turn_checkpoints`. `p26-resume` usa conversa viva.

**Menor correção:** na mesma transação de `ConversationStore.delete`, `DELETE FROM turn_checkpoints / turn_effects / kickstart_runs WHERE agent_id=? AND conversation_id=?`. Em `resumePrompt`, resolver a conversa com as mesmas regras de `sendPrompt` (404/409 se morta ou arquivada).

**RED sugerido:** persistir checkpoint; deletar a conversa; `resumePrompt` com o id antigo não chama provider e não encontra checkpoint.

---

### F4 — P1 — Bug confirmado — Ledger trata `started` sem resultado como reexecutável no processo; commit atômico não está no caminho vivo

**Onde:**

- Tool-loop: `src/execution/tool-loop.ts:325-348` — só `completed` reutiliza e `unsafe` falha; qualquer outro status (incluindo `started`) cai em `markStarted` + executor.
- `markResumeEffectStarted` só transita `prepared → started`: `src/store/index.ts:1738-1742`. Já-`started` não vira `unsafe`.
- Reconcile `started`+`result_json IS NULL` → `unsafe` **só no reopen sem owner vivo**: `src/store/index.ts:1863-1871` e `:1431-1438`.
- Sequência viva: `markStarted` → efeito externo (`tool-loop.ts:359-463`) → `complete` (`:347-348`, `:402`, `:463`). Não há `try/finally` que marque `unsafe` se `broker.execute` lançar.
- `commitResumeEffectAndCheckpoint` (`src/store/index.ts:1795-1860`) existe e tem CAS, mas o único uso de produção em `src/` é o store em memória de teste em `src/rpc/send.ts:702`. `TurnRunner` nunca chama.

**Reprodução:**

1. Capability `resume:cursor` para ligar `resumableEffectsFor` (`src/rpc/send.ts:2731-2736`).
2. `prepare` + `markStarted`; o executor lança **antes** de `complete`.
3. Sem restart de processo (logo sem reconcile).
4. Reentrar `runToolLoop` para o mesmo `turnId` (retry in-process, ou segundo loop como em `p26-resume.test.ts:167-168` mas interrompendo antes de `complete`).
5. Status `started` não é `completed` nem `unsafe` → o executor roda de novo.

**Impacto:** efeito externo duplicado (fs/MCP/browser) no mesmo turno. O aceite P2.6 (“`started` sem resultado é `unsafe`”; “crash after effect start”) só é verdadeiro após reopen do SQLite.

**Por que os testes não pegam:** o teste de reuse (`p26-resume.test.ts:135-171`) completa o efeito na primeira corrida. O teste unsafe (`:198-224`) chama `reconcileResumeEffects` à mão. Nenhum teste deixa `started` e reentra o loop sem reconcile. Nenhum teste integra `resumePrompt` com tools.

**Menor correção:** no tool-loop, `started` sem `result` deve falhar fechado como `unsafe` (ou recusar resume do turno). Envolver o executor em `try/finally` que marca `unsafe` se não completou. No caminho vivo, completar efeito+checkpoint via `commitResumeEffectAndCheckpoint` (ou equivalente transacional).

**RED sugerido:** `markStarted` → executor lança → segundo `runToolLoop` do mesmo turno **sem** `reconcile`; executions deve permanecer 1 e o status deve ser `unsafe`. Segundo RED: `resumePrompt` após tool-call interrompido não pode marcar a tool como `completed` sem executar (`runResumeTurn` passa `hasToolLoop=false` em `:1998`).

Integração resume↔tools (mesmo finding, evidência extra): `runResumeTurn` (`src/rpc/send.ts:1990-2002`) só faz `streamChat` com cursor. Tool-calls no resume são publicados com `hasToolLoop=false` (`:1998`, `:2952-2956`), ou seja, `completed` **sem** broker/ledger.

---

### F5 — P1 — Bug confirmado — Async tasks não têm incarnation; delete/recreate do mesmo `agentId` herda o histórico

**Onde:**

- Tabela `async_tasks` chaveia por `agent_id` + nonce, sem incarnation: `src/store/schema.ts:191`.
- Delete roster terminaliza, não apaga: `src/tasks/store.ts:1076-1104`; `src/rpc/index.ts:637-657` chama `terminalizeAgentTasks` e `a2aStore.retireAgent`, **não** purge de tasks.
- Listagem após recreate: `src/tasks/store.ts:1258-1263` — `SELECT * FROM async_tasks WHERE agent_id = ?`.
- Recreate do mesmo id é caminho de produto: `src/rpc/roster.ts:438` só rejeita id ainda presente; testes de roster cobrem recriar o mesmo id.

**Reprodução:**

1. `createAgent({ id: "agent-a" })`, `dispatchAsyncTask` com objective/result.
2. `deleteAgents({ ids: ["agent-a"] })`. RPC `listAsyncTasks` passa a 404 (`test/async-task-rpc.integration.test.ts:187-189`) — o agente saiu do roster; a linha **permanece** (`getTask` ainda lê `cancelled`).
3. `createAgent({ id: "agent-a" })`.
4. `getAsyncTasks` / `listAsyncTasks` devolvem as tasks canceladas/completadas da encarnação anterior, inclusive objective/result/error.

**Impacto:** o invariante que A2A implementa (“delete/recreate com o mesmo id visível não herda mensagens”) **não** vale para tasks/subagentes. O novo agente vê trabalho, orçamentos de parent-turn e namespace de nonce (`UNIQUE(agent_id, client_nonce)`) do anterior.

**Por que os testes não pegam:** o RPC test para na exclusão (404) e não recria o id. A2A tem teste explícito de incarnation (`test/a2a-store.test.ts:255-275` e `test/a2a-rpc.integration.test.ts`). Tasks não.

**Menor correção:** na exclusão commitada, apagar ou selar tasks por incarnation (espelhar `a2a_agent_incarnations`). `listTasks` deve filtrar a incarnation ativa. Nonce único deve incluir incarnation.

**RED sugerido:** dispatch → deleteAgents → createAgent mesmo id → `listAsyncTasks` vazio; um nonce antigo não colide; `getAsyncTask` do id antigo é 404.

---

### F6 — P2 — Bug confirmado — Budget e `completedEffectIds` do checkpoint não refletem o turno original

**Onde:**

- Budget hardcoded no primeiro persist: `src/rpc/send.ts:2718-2728` (`maxProviderAttempts: 3`, `providerAttemptsUsed: 1`, tools zerados).
- Resume bem-sucedido copia `completedEffectIds` do snapshot, em geral `[]`: `src/rpc/send.ts:2010-2015`.
- Aceite P2.6: “Resume consumes the original turn identity, budget and admission path.”

Admission no `streamChat` de resume **existe** (`src/rpc/send.ts:1998-2001`) — isso passa. Budget e ledger de efeitos no checkpoint não.

**Reprodução:** turno com várias tool rounds e um cursor; abort; inspecionar `turn_checkpoints.budget_json` e `completed_effect_ids_json`.

**Impacto:** resume pode autorizar tentativas/tools que o turno original já tinha consumido; o campo de efeitos completos no checkpoint é morto no caminho vivo (a dedupe real, quando ligada, está em `turn_effects`, não nesse array).

**Por que os testes não pegam:** o checkpoint de teste é montado à mão com budget arbitrário; o turno fixture aborta antes de tools.

**Menor correção:** gravar o budget efetivo do turno (attempts/tool rounds já usados) e, a cada `complete`, atualizar `completedEffectIds` no mesmo CAS que o cursor.

**RED sugerido:** após N tool calls + cursor, o checkpoint persistido deve ter `toolCallsUsed >= N` e ids completos; resume com budget esgotado deve falhar fechado sem provider.

---

## 3. Gaps de testes

Estes **não** são bugs por si; são buracos que deixaram F1–F6 passarem, ou riscos residuais sem evidência de falha no código atual.

| Gap | O que existe | O que falta |
|-----|----------------|-------------|
| Cursores múltiplos no mesmo turno | `create` idempotente no store | Último cursor vence; resume usa v2 |
| Expiry após enqueue | Guard síncrono em `p26-resume.test.ts:173` | Fila lenta + expiry no `runResumeTurn` |
| Fence/delete vs resume | `sendPrompt` recusado sob delete (`roster-agents`) | `resumePrompt` no mesmo window |
| Conversa apagada vs checkpoint | Delete de conversa cobre transcript | Purge P2.6/P2.8 + resume 404 |
| `started` sem reconcile | Unsafe só após `reconcileResumeEffects` | Reentrada in-process do tool-loop |
| `resumePrompt` + tools | Tool reuse isolado em `runToolLoop` | Resume de turno com tool-call |
| `commitResumeEffectAndCheckpoint` | Store unitário `p26-resume.test.ts:98-127` | Chamada a partir de `TurnRunner` |
| Reincarnação de tasks | Delete → 404 RPC; A2A tem incarnation | Recreate mesmo id + list/nonce |
| Kickstart HTTP opt-in | Roster só testa no-op legado (`roster-agents.test.ts:821-824`) | `mode=onboarding` no gateway |
| `deleteAgents` + kickstart in-flight | Fence unitário em `p28-kickstart.test.ts:133` | Servidor real, mesmo fluxo do roster |
| Concorrência de nonce A2A/tasks | UNIQUE + CAS no SQLite | Stress de dispatch/claim paralelo |
| Stop A2A mid-consume | Lease recovery existe | `stop()` deixa `delivering` até o lease — timing |

**Não classificado como bug:** corrida `resumeTurns.has` / `.add` em `src/rpc/send.ts:1921-1933`. `resumePrompt` é síncrono até o `add`; num único processo Node as duas linhas não intercalam. A topologia congelada é um processo. Gap apenas se no futuro houver multi-processo no mesmo SQLite.

**Não classificado como bug de produção:** `restoreAgent` não apaga `turn_checkpoints`/`turn_effects` (`src/store/index.ts:1220-1236`), enquanto `clear` apaga (`:973-974`). O caller de produção é rollback **depois** de `clear` (`src/rpc/roster.ts:724-750`), então o rollback fica fail-closed (checkpoint já foi). O contrato de restore/overwrite continua incompleto — gap, não exploit atual.

---

## 4. Limitações deliberadas confirmadas

| Limitação | Evidência | Comentário |
|-----------|-----------|------------|
| Produção `resume:none` | `src/providers/capabilities.ts:54-77`; router `src/providers/router.ts:499-506`; teste `p26-resume.test.ts:21-38` | Ledger e checkpoint de tools **não** ligam em produção (`resumableEffectsFor` exige `resume === "cursor"`, `send.ts:2735`). Isto é o fail-closed P2.5/P2.6, não um stub escondido. |
| P2.6 aceito só com fixture offline | Roadmap e plano P2, status P2.6 | Correto. Os bugs F1–F4 são da máquina do fixture, não de um provider pago. |
| Kickstart legado é no-op | `src/rpc/roster.ts:399-406`; `test/p28-kickstart.test.ts:38-62`; `test/roster-agents.test.ts:821-824` | Intencional. Opt-in exige `mode: "onboarding"`. |
| Resultado do kickstart só no RPC | `src/rpc/send.ts:1523-1524`; schema `src/store/schema.ts:1110` | Fora de transcript/SSE. O caller do RPC vê o texto. |
| Subagente depth-1, runtime compartilhado | `src/tasks/store.ts:450-451,726`; frozen decisions do plano P2 | Sem VM/home/DB por filho. |
| Payload A2A fechado | `src/a2a/contracts.ts:15-17,140-158` | Só `text` / `task-result-ref`. Segredos conhecidos via `sensitiveValues` (produção liga keystore em `src/main.ts:830-835`). Texto arbitrário que não está no keystore pode persistir — limite do scanner, não campo estrutural de cookie/token. |
| Stop A2A deixa `delivering` até o lease | `src/a2a/runtime.ts:147-149` | Recovery por lease, não perda silenciosa. |
| Artifact `unsigned-local`; `// @ts-nocheck` em `send.ts` | Relatório consolidado, residual explícito | Fora do núcleo de durabilidade; mencionados só para não contradizer o residual oficial. |

---

## 5. Contradições documentais

### D1 — Seção 4.6 ainda afirma que multiagente “não existe”

**Tipo:** texto documental desatualizado (histórico apresentado como estado atual).

`docs/openbot-grokbot-018-consolidated-improvement-report-2026-08-24.md:276-287` titula **“Features multiagente que ainda não existem”** e afirma:

- `getSubagents` / `getAsyncTasks` retornam `[]`;
- não há publishers desses canais;
- não há `SendToAgent`, inbox, steer, abort ou wake;
- evidência `src/rpc/roster.ts:1119-1120`.

**Código atual:**

- `getAsyncTasks` / `getSubagents` estão em `src/rpc/tasks.ts:108-109` e listam o store durável.
- `sendAgentMessage`, inbox, ACK: `src/rpc/a2a.ts:42-80`.
- Steer/abort: `src/rpc/tasks.ts:138-162`.
- `roster.ts:1119` hoje é URL de `testProviderConnection`, não stubs de subagentes.

O **preâmbulo** do mesmo relatório (`:13-21`) e o roadmap já declaram P2.1–P2.8 fechados. A seção 4.6 não foi reescrita como fotografia histórica. Um agente que comece pela 4.6 conclui o oposto do exit audit.

**Kickstart na 4.6:** o no-op legado (`roster.ts:398-406`) continua verdadeiro para a chamada sem `mode`. A frase “não inicia um turno” é falsa para `{ mode: "onboarding" }` (`send.ts:1524-1587`).

### D2 — Números de testes

Os números citados (P2.6 8/8, P2.8 7/7, store 27/27, suíte 2.076/2 skip) **batem** com o que esta revisão executou nos arquivos focados: 8, 7 e 27. Não há contradição numérica nos suites reexecutados. A frase “452/452 testes P2” e “158 arquivos / 2.076” **não** foi revalidada aqui (suíte completa proibida no início). Não há evidência local de que estejam errados; também não há evidência nova de que ainda sejam verdade.

### D3 — Critérios P2.6 marcados `[x]` sem teste correspondente

O plano `docs/superpowers/plans/2026-08-24-openbot-grokbot-018-p2-product-expansion.md:174-179` marca GREEN para crash after effect start, duplicate effect, abort/resume e exactness. O arquivo `test/p26-resume.test.ts` cobre: cursor opaco, fail-closed sem capability, fixture de sufixo, CAS no **store**, reuse de tool **fora** de `resumePrompt`, expiry imediato, unsafe **após reconcile**, um resume de texto. Não cobre F1–F4. Checkbox completo ≠ cobertura.

Não foram encontrados stubs de runtime em `src/a2a/**` ou `src/tasks/**` reivindicando completeza sem implementação. A contradição é documental (4.6) e de aceite P2.6 vs testes, não um `getSubagents = []` ainda no código.

---

## 6. Matriz PASS/FAIL por subsistema

Perguntas obrigatórias. PASS significa: o código examinado aplica o invariante, com evidência de linha. FAIL/PARTIAL aponta finding.

### A. Checkpoint e resume

| Questão | Veredito | Evidência |
|---------|----------|-----------|
| Isolado por agente, conversa, turno, provider, modelo | **PASS** no tuple; **sem incarnation** (delete usa `clear`, que apaga checkpoints — recreate limpo **se** o delete completar) | `resume.ts:78-84,127-133`; `schema.ts:1074-1088`; `store/index.ts:973-974` |
| Cursor opaco, limitado, não controlado pelo cliente | **PASS** | `resume.ts:31-38`; RPC `send.ts:3426-3433` não aceita cursor |
| Checkpoint expirado falha antes do provider | **PARTIAL FAIL** — no aceite, não no `runResumeTurn` | F2; teste imediato PASS `p26-resume.test.ts:173-195` |
| Sem capability real → fail closed | **PASS** | `router.ts:487-506`; `capabilities.ts:54-77`; `p26-resume.test.ts:21-38` |
| Resume conserva identidade, budget, admission | **PARTIAL FAIL** | Identidade e admission PASS (`send.ts:1963-2001`); budget F6; fence F2 |
| Duas retomadas concorrentes no mesmo processo | **PASS** (síncrono até `resumeTurns.add`) | `send.ts:1921-1933`; topologia 1 processo |
| CAS impede lost update | **PASS** em `advance`/`commit`; **FAIL** no persist inicial (`INSERT OR IGNORE`) | F1; CAS store `p26-resume.test.ts:114-127` |
| Restart entre checkpoint e resume | **PASS** para `started`→`unsafe` no reopen | `store/index.ts:1431-1438,1863-1871`; `p26-resume.test.ts:198-224` |
| Checkpoint após delete/recreate do agente | **PASS** via `clear` no delete | `store/index.ts:973-974`; `roster.ts:724-725` |
| Checkpoint após delete da **conversa** | **FAIL** | F3 |
| Erro/abort/completion invalidam checkpoint | **PARTIAL** | Completed assistant bloqueia resume (`send.ts:1917-1919`); abort **mantém** checkpoint (necessário para resume); sucesso de resume **não** apaga a linha; expiry apaga no reconcile |

### B. Effect ledger

| Questão | Veredito | Evidência |
|---------|----------|-----------|
| Identidade estável e escopo | **PASS** | `resume.ts:42-47`; PK `schema.ts:1092-1103`; colisão de fingerprint `store/index.ts:1721-1723` |
| `completed` reutiliza sem repetir | **PASS** quando o ledger está ligado | `tool-loop.ts:330-333`; `p26-resume.test.ts:135-171` |
| `started` sem resultado → `unsafe` | **FAIL** in-process; **PASS** após reopen | F4 |
| `unsafe` impede resume antes do provider | **PASS** no aceite | `send.ts:1929-1930`; `p26-resume.test.ts:198-224` |
| Duas execuções concorrentes do mesmo efeito | **PASS** intra-processo (fila por agente + PK); **não** há claim exclusivo multi-writer | Fila `send.ts:3306-3318`; PK effects |
| Tools/MCP/browser/fs na fronteira | **PASS** no `runToolLoop` se `resumableEffects` definido; **FAIL** em produção (`resume:none`) e em `resumePrompt` | Limitação deliberada + F4 |
| Janela efeito real vs persistência | **FAIL** no caminho vivo | F4 |
| Truncamento/serialização vs dedupe | **PASS** na identidade (fingerprint de args); oversize de resultado rejeita (`resume.ts:56-66`) e pode deixar `started` | Relacionado a F4 |
| Cleanup/expiry permite repetir efeitos antigos | **PASS** no mesmo turno (expiry bloqueia resume); **FAIL** se a conversa for apagada e o ledger permanecer | F3 |

### C. Async tasks, subagentes, A2A

| Questão | Veredito | Evidência |
|---------|----------|-----------|
| Aceitação, delivery, wake, ACK, terminal distintos | **PASS** | Tasks: `tasks/store.ts` dispatch/outbox/ACK/commitTerminal; A2A: `contracts.ts:13`, `a2a/store.ts` send/claim/ack/projection |
| Restart não perde aceitos | **PASS** | SQLite + recover; `async-task-store` restart; `a2a-runtime` scan |
| Nonce/dedupe sob restart | **PASS** | UNIQUE tasks `schema.ts:191`; A2A `(sender, incarnation, nonce)` |
| Incarnation impede herança no recreate | **PASS A2A** / **FAIL tasks** | A2A `a2a-store.test.ts:255-275`; tasks F5 |
| Foreign agent/task rejeitado | **PASS** | `rpc/tasks.ts:42-46`; A2A recipient join |
| Retry não renova budget | **PASS** | `budget_json` no dispatch; testes runtime de usage |
| Lease expirado ≠ dois executores | **PASS** | Claim CAS `tasks/store.ts:1305+`; testes cross-connection |
| Cancel/steer sem terminal contraditório | **PASS** | `state-machine.ts` TRANSITIONS; testes abort/steer |
| Limites de bytes | **PASS** | Caps em `a2a/contracts.ts` e `tasks/state-machine.ts` |
| Sem segredos/cookies/paths arbitrários no contrato | **PASS** estrutural; scanner de valores conhecidos | Payload fechado; `main.ts` injeta keystore |

### D. Kickstart P2.8

| Questão | Veredito | Evidência |
|---------|----------|-----------|
| Legado no-op, zero provider | **PASS** | `roster.ts:399-406`; `p28-kickstart.test.ts:38-62` |
| Opt-in explícito | **PASS** | `roster.ts:407-412`; `send.ts:1528-1530` |
| Readiness antes do claim | **PASS** | `send.ts:1539-1571`; `p28-kickstart.test.ts:75-88` |
| Nonce limitado e deduplicado | **PASS** (sem cap de **quantidade** de nonces distintos) | `MAX_KICKSTART_NONCE_BYTES` `send.ts:1168`; PK `schema.ts:1113+` |
| Concorrência/restart não duplicam | **PASS** | `p28-kickstart.test.ts` Promise.all; reconcile `store/index.ts:1603-1611` |
| Fora de transcript e SSE | **PASS** | `p28-kickstart.test.ts` entries/publish vazios |
| Tools/efeitos externos proibidos | **PASS** | `send.ts:1618-1634`; abort em `tool-call` |
| Delete/fence/cancel impedem continuação | **PASS** no runner | `send.ts:1583-1586,2029-2037`; `p28-kickstart.test.ts:133+` |
| Retry só sem output | **PASS** | `store/index.ts:1540-1557` |
| Partial/interrupted não retoma implícito | **PASS** | `send.ts:1539-1540`; teste interrupted |

Divergência test-only: o store em memória reconcilia só `running` (`send.ts:996-1007`); SQLite reconcilia `queued` e `running`. Produção usa SQLite.

### E. Documentação

| Item | Veredito |
|------|----------|
| Seção 4.6 vs código | **FAIL** — D1 |
| Roadmap / plano P2 vs residual `resume:none` | **PASS** — honestos |
| Checkboxes P2.6 vs testes | **PARTIAL** — D3 |
| Contagens 8/8, 7/7, 27/27 reexecutadas | **PASS** nesta revisão |

---

## 7. Comandos executados e resultados

Somente leitura. Sem provider pago, login ou token.

```text
npx vitest run test/p26-resume.test.ts --maxWorkers=1 --no-file-parallelism
→ 1 file / 8 tests passed (87ms)

npx vitest run test/p28-kickstart.test.ts --maxWorkers=1 --no-file-parallelism
→ 1 file / 7 tests passed (66ms)

npx vitest run test/async-task-store.test.ts test/async-task-runtime.test.ts
         test/async-task-rpc.integration.test.ts test/a2a-store.test.ts
         test/a2a-runtime.test.ts test/a2a-rpc.integration.test.ts
         test/a2a-gateway.integration.test.ts test/a2a-contract.test.ts
         --maxWorkers=1 --no-file-parallelism
→ 8 files / 138 tests passed

npx vitest run test/store.test.ts test/turn-crash-recovery.test.ts
         test/roster-agents.test.ts test/gateway.integration.test.ts
         test/rpc-send.test.ts --maxWorkers=1 --no-file-parallelism
→ 5 files / 164 tests passed
  (store 27/27, roster 39/39, gateway.integration 41, rpc-send 56, crash-recovery 1)

npm run typecheck
→ tsc -p tsconfig.typecheck.json  exit 0
```

**Não executado (por regra da revisão):** suíte serial completa (2.076), `npm run build`, Electron, provenance, artifact gates, qualquer chamada de provider real.

Os 8+7+138+164 testes acima **passam e não falsificam F1–F6**; eles simplesmente não os exercitam.

---

## 8. Recomendação final

**ACEITAR COM RESSALVAS.**

Não reabrir P1/P2 como bloco. A2A, o state machine de async tasks, leases, budgets, rejeição foreign e P2.8 estão implementados de forma verificável. P0.x/P1.x fora deste recorte não foram reabertos.

Ressalvas que bloqueiam tratar P2.6 e o isolamento de reincarnação como fechados:

1. Corrigir F1–F4 **antes** de qualquer par `resume:cursor` (incluindo override que escape de teste).
2. Fechar F5 (incarnation ou purge de tasks no delete commitado) — este é o único finding **ao vivo** em produção com `resume:none`.
3. Reescrever a seção 4.6 do relatório consolidado como fotografia histórica de 24/08, ou apontar explicitamente para o roadmap como autoridade.

Reabrir só P2.6 (não o P2 inteiro) é justificado se a equipe quiser que “P2.6 complete” signifique a máquina de fixture, não apenas “produção continua `resume:none`”.
