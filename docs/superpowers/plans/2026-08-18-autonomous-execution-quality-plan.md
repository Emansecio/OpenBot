# Autonomous Execution Quality Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Corrigir falhas reproduzíveis de duplicação, contexto longo, Skills manuais e encerramentos silenciosos, adicionando provas determinísticas ponta a ponta.

**Architecture:** Preservar TurnRunner, tool loop, broker e stores atuais. Acrescentar idempotência e validação nas fronteiras existentes, sem processo/VM por bot nem chamadas extras de modelo para compactação.

**Tech Stack:** TypeScript 5.8, Node.js 22, Vitest 3, SQLite/better-sqlite3, providers e MCP simulados.

---

### Task 1: Bloquear repetição e resultados inválidos

**Files:**
- Modify: `test/execution-approval.test.ts`
- Modify: `test/rpc-send-tools.test.ts`
- Modify: `src/execution/broker.ts`
- Modify: `src/execution/tool-loop.ts`

- [ ] Adicionar teste de mesmo `(agentId, requestId, payload)` em voo/concluído executar backend uma vez; payload diferente deve falhar.
- [ ] Adicionar teste de backend e executor compartilhado que resolvem `undefined`; o resultado deve ser falha sanitizada.
- [ ] Adicionar testes para chamadas semanticamente iguais com IDs diferentes na mesma rodada e em rodadas consecutivas.
- [ ] Rodar `npx vitest run test/execution-approval.test.ts test/rpc-send-tools.test.ts --maxWorkers=1 --no-file-parallelism` e registrar as falhas esperadas.
- [ ] Implementar cache limitado por chave composta no broker, com fingerprint do payload, reuso de promise/resultado e limpeza no `close()`.
- [ ] Validar a forma de `ExecutionResult` e `ToolExecutionResult` antes de acessar campos.
- [ ] Canonicalizar argumentos JSON para fingerprint semântica; executar duplicata da mesma rodada uma vez, avisar repetição consecutiva e encerrar se o modelo ignorar o aviso.
- [ ] Garantir que `assistant.toolCalls` e mensagens `tool` permaneçam 1:1 após normalização.
- [ ] Repetir o comando focado e exigir zero falhas.

### Task 2: Preservar contexto longo coerente

**Files:**
- Modify: `test/rpc-send.test.ts`
- Modify: `test/transcript-optimization.test.ts`
- Modify: `src/rpc/send.ts`
- Modify: `src/store/index.ts`

- [ ] Adicionar teste com mais de 80 mensagens provando que a primeira instrução do usuário continua no request e o total permanece limitado.
- [ ] Adicionar teste provando que o contexto enviado não começa por `assistant` órfã.
- [ ] Adicionar semântica equivalente para store em memória e SQLite ao consultar a primeira mensagem do usuário.
- [ ] Rodar `npx vitest run test/rpc-send.test.ts test/transcript-optimization.test.ts --maxWorkers=1 --no-file-parallelism` e registrar RED.
- [ ] Acrescentar `getEarliestUser()` ao contrato/store, com query indexada no SQLite.
- [ ] Montar `[âncora original + tail recente]` dentro do teto de 80 e cortar o tail na primeira fronteira `user`.
- [ ] Repetir o comando focado e exigir zero falhas.

### Task 3: Tornar Skills manuais realmente manuais

**Files:**
- Modify: `test/skill-dispatcher.test.ts`
- Modify: `src/skills/dispatcher.ts`

- [ ] Alterar o teste de `auto-select:false`: `search_skills` não sugere e `use_skill` do modelo recusa; referências explícitas continuam cobertas pelos testes RPC existentes.
- [ ] Rodar `npx vitest run test/skill-dispatcher.test.ts test/skill-references.test.ts test/rpc-skills.test.ts --maxWorkers=1 --no-file-parallelism` e registrar RED.
- [ ] Fazer `SkillDispatcher.use()` exigir `autoSelect:true`, com erro sanitizado.
- [ ] Repetir o comando focado e exigir zero falhas.

### Task 4: Explicar términos sem resposta

**Files:**
- Modify: `test/rpc-send.test.ts`
- Modify: `test/rpc-send-tools.test.ts`
- Modify: `src/rpc/send.ts`
- Modify: `src/execution/tool-loop.ts`

- [ ] Adicionar teste de provider que conclui sem evento: deve haver notice explícito e nenhuma mensagem assistente fictícia.
- [ ] Adicionar teste de limite interno do tool loop: cards fechados e notice explícito.
- [ ] Rodar os dois testes focados e registrar RED.
- [ ] Identificar erros internos do tool loop por código estável e persistir notice sanitizado uma única vez.
- [ ] Após sucesso do stream, detectar ausência de texto/tool final e persistir notice de resposta vazia.
- [ ] Repetir os testes e exigir zero falhas.

### Task 5: Provar fluxos práticos integrados

**Files:**
- Create: `test/autonomous-execution.integration.test.ts`

- [ ] Criar provider roteirizado que executa `search_skills → use_skill → browser_snapshot → file.write/read → resposta final`, medindo chamadas e garantindo que corpo da Skill não persiste.
- [ ] Criar cenário de tool indisponível/resultado vazio que termina com explicação útil, sem sucesso fingido.
- [ ] Criar dois bots concorrentes usando o mesmo tool-call ID e `Documents/result.txt`, com conteúdos diferentes e homes/transcripts isolados.
- [ ] Criar cenário de cancelamento cooperativo durante tool lenta e confirmar nenhuma continuação/provider call posterior.
- [ ] Rodar `npx vitest run test/autonomous-execution.integration.test.ts --maxWorkers=1 --no-file-parallelism` e exigir zero falhas.

### Task 6: Validação completa e smoke isolado

**Files:**
- No production changes.

- [ ] Rodar todos os testes focados alterados serialmente.
- [ ] Rodar `npm run typecheck`.
- [ ] Rodar `npm run build`.
- [ ] Rodar `npm test -- --maxWorkers=1 --no-file-parallelism`.
- [ ] Rodar `npm run verify:core:acceptance`.
- [ ] Rodar `npm run verify:skills-mcp` se o gate desktop estiver disponível.
- [ ] Rodar `npm run verify:e2e:browser`.
- [ ] Rodar `npm run smoke:local` com suas raízes temporárias.
- [ ] Rodar `npm run verify:local-provider-live`; aceitar `SKIP` somente por ausência factual de provider local.
- [ ] Conferir portas 1340/debug, processos Electron/Node pertencentes aos gates e diretórios temporários; não tocar AppData real.
- [ ] Relatar resultados exatos, falsos positivos, limitações e nenhuma nota 100/100.
