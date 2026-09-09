# OpenBot Readiness Convergence Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Concluir as três etapas de prontidão do OpenBot e obter um checkup integral sem bugs ou gargalos funcionais confirmados.

**Architecture:** A implementação mantém o gateway Node, Electron extraído e runtime WSL existentes. Acrescenta isolamento fail-closed para testes, paridade verificável de `dist`, shutdown autenticado, DPAPI CurrentUser nativo e um gate mestre totalmente temporário.

**Tech Stack:** TypeScript 5.8, Node.js 22, Vitest, Electron 41, PowerShell, SQLite, WSL2, Rust/C ou C++ apenas para o addon Node-API DPAPI.

---

## Ownership e ordem

As tarefas são sequenciais. Não executar dois implementadores simultaneamente na árvore compartilhada. Antes de cada tarefa, comparar os hashes atuais dos arquivos listados com o snapshot inicial. Não criar commits: este checkout não possui `.git`.

### Task 1: tornar a suíte incapaz de tocar o keystore real

**Files:**
- Modify: `src/keystore/index.ts`
- Modify: `test/rpc-send.test.ts`
- Test: `test/keystore.test.ts`

- [ ] Adicionar regressão que, com `NODE_ENV=test`, rejeita `createKeystore()` sem `dir` nem `OPENBOT_DATA_ROOT` isolado.
- [ ] Executar somente essa regressão e observar RED sem criar `sand-secrets.json` no AppData real.
- [ ] No construtor, lançar erro antes de criar diretório/chave quando o teste tenta usar a raiz default real.
- [ ] Alterar o teste de RPC para criar diretório com `mkdtemp`, injetá-lo em `createKeystore({dir})` e removê-lo em `finally`.
- [ ] Executar `vitest run test/keystore.test.ts test/rpc-send.test.ts --maxWorkers=1 --no-file-parallelism`; esperar zero falhas.
- [ ] Confirmar que `%APPDATA%\OpenBot\sand-secrets.json` e `.master.key` não tiveram mtime alterado durante o gate.

### Task 2: atualizar contratos e tornar `dist` verificável

**Files:**
- Modify: `test/gateway.integration.test.ts`
- Modify: `test/runtime-mode.test.ts`
- Create: `scripts/verify-backend-artifacts.mjs`
- Modify: `scripts/openbot-desktop.cmd`
- Modify: `scripts/release.mjs`
- Modify: `package.json`
- Generated: `dist/**`

- [ ] Atualizar WebAuthn para testar 404 em subrota desconhecida e 400 autenticado em `/webauthn/ceremony` com corpo inválido, sem iniciar signer.
- [ ] Atualizar runtime mode para esperar `browser` 200 e persistência somente no agente alvo.
- [ ] Executar ambos os testes e observar GREEN do contrato atual.
- [ ] Criar verificador que mapeia cada `src/**/*.ts` emitível para `dist/**/*.js`, exige os bridges/driver conhecidos e falha se saída estiver ausente ou mais antiga que a fonte.
- [ ] Testar o verificador contra uma árvore fixture stale e observar RED; testar contra fixture atual e observar GREEN.
- [ ] Fazer o launcher chamar o verificador antes de iniciar o gateway.
- [ ] Fazer `release:package` executar build + verificador antes de empacotar, preservando `distRoot` customizado dos testes de lifecycle.
- [ ] Executar `npm run typecheck`, testes focados, `npm run build`, `node scripts/verify-backend-artifacts.mjs`, `node --check dist/main.js` e `npm run verify:client-artifacts`.
- [ ] Fazer boot temporário de `dist/main.js` e verificar que as duas bridges não retornam o stub global 501.

### Task 3: implementar shutdown gracioso de produto

**Files:**
- Modify: `src/server/gateway.ts`
- Modify: `src/main.ts`
- Create: `scripts/shutdown-gateway.mjs`
- Modify: `scripts/openbot-desktop.cmd`
- Modify: `scripts/release-common.mjs`
- Modify: `scripts/launch.mjs`
- Modify: `scripts/update.mjs`
- Modify: `scripts/uninstall.mjs`
- Test: `test/gateway.integration.test.ts`
- Test: `test/bootstrap.test.ts`
- Test: `test/desktop-lifecycle-hardening.test.ts`
- Test: `test/release-lifecycle.test.ts`

- [ ] Escrever RED para `POST /shutdown`: 401 sem token, 403 com Origin externo, 405 para GET, 202 autenticado e callback único sob chamadas concorrentes.
- [ ] Implementar `shutdownHandler` opcional no gateway. Ele marca quiescência, responde 202 e agenda o callback após a resposta; nunca aguarda `stopServer` dentro da requisição.
- [ ] Tornar o shutdown de `main.ts` idempotente com uma única promise de teardown e preservar todas as tentativas de cleanup.
- [ ] Escrever RED do helper provando `request graceful → wait → ownership recheck → force fallback`, sem token em argv/log/process state.
- [ ] Implementar o helper usando o mesmo token root e as provas de processo existentes.
- [ ] Substituir o caminho saudável do launcher, launch, update e uninstall pelo helper; manter `/F` apenas como fallback comprovado.
- [ ] Rodar testes focados de gateway/bootstrap/lifecycle e confirmar que gateway adotado não é encerrado.
- [ ] Rodar um E2E temporário que fecha Electron normalmente e prova execução de todos os hooks de teardown.

### Task 4: criar primeiro boot/restart e documentação operacional atual

**Files:**
- Create: `scripts/verify-clean-profile.mjs`
- Test: `test/clean-profile.integration.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/verification-gates.md`

- [ ] Criar RED que falha se qualquer path efetivo escapar do TempRoot ou apontar para AppData/LocalAppData reais.
- [ ] Implementar o runner com APPDATA, LOCALAPPDATA, data root, local root, user data, install root e logs temporários; limpar variáveis herdadas sensíveis.
- [ ] Exercitar primeiro boot, fechamento, restart no mesmo root, persistência de token/configuração e ausência de bots inventados.
- [ ] Verificar porta/processos/process state antes/depois e remover o root apenas em GREEN; em RED, reportar caminho diagnóstico sem copiar segredos.
- [ ] Adicionar `verify:clean-profile` ao package e documentar rotas, modos, keystore efetivo e baseline gerada pelo gate, sem reescrever documentos históricos datados.
- [ ] Rodar o gate duas vezes para provar idempotência; a regra final de convergência continua sendo uma rodada integral limpa.

### Task 5: implementar DPAPI CurrentUser e migração

**Files:**
- Create: `native/dpapi/**`
- Create: `src/keystore/dpapi.ts`
- Modify: `src/keystore/backend.ts`
- Modify: `src/keystore/index.ts`
- Modify: `scripts/release.mjs`
- Modify: `scripts/release-common.mjs`
- Modify: `package.json`
- Test: `test/keystore.test.ts`
- Create: `test/keystore-dpapi-live.test.ts`

- [ ] Criar primeiro uma prova mínima Node-API que round-trips bytes por `CryptProtectData`/`CryptUnprotectData` no processo Node atual; se o toolchain local não produzir `.node`, parar esta tarefa como bloqueada sem trocar arquitetura silenciosamente.
- [ ] Escrever RED unitário para seleção `dpapi-current-user`, payload tagueado e fail-closed quando o addon não carrega.
- [ ] Implementar backend síncrono sem plaintext em argv, ambiente, stdout ou IPC e zerar buffers temporários quando possível.
- [ ] Escrever RED de migração com fixture `local-file`: falha injetada antes do rename preserva arquivo e chave; sucesso reabre todos os registros em DPAPI antes de retirar a chave antiga.
- [ ] Implementar migração atômica e compatibilidade de leitura apenas para registros legados.
- [ ] Incluir o binário nativo no package e no preflight por arquitetura.
- [ ] Rodar unitários e depois o teste Windows opt-in em diretório temporário: write, restart do processo, reveal, delete e ausência de plaintext no disco.

### Task 6: fechar WSL, browser e release avançados

**Files:**
- Modify: `scripts/verify-runtime-wsl-live.ps1`
- Modify: `scripts/run-runtime-wsl-live.mjs`
- Modify: `test/browser-e2e.integration.test.ts`
- Modify: `test/release-lifecycle.test.ts`
- Modify: `docs/verification-gates.md`

- [ ] Expandir WSL live para entrar pelo bootstrap/RPC real, usar distro/root aleatórios e cobrir dois agentes.
- [ ] Adicionar provas de UID/GID não-root, NoNewPrivs/seccomp, rede TCP/DNS bloqueada, quota, timeout, cancelamento, recovery e cleanup.
- [ ] Manter browser offline como gate obrigatório e adicionar navegação pública allowlisted separada, sem credenciais ou ações mutáveis.
- [ ] Expandir release temporário para package/install/preflight/repair/update/falha/rollback/uninstall e rejeição de reparse/junction.
- [ ] Fazer cada gate registrar inventário antes/depois e retornar RED para qualquer processo, porta, lease, cgroup, socket, distro ou root residual.
- [ ] Executar os três gates isoladamente e revisar seus efeitos colaterais.

### Task 7: criar checkup mestre e executar o loop de convergência

**Files:**
- Create: `scripts/verify-readiness.mjs`
- Modify: `package.json`
- Modify: `docs/verification-gates.md`
- Create: `docs/openbot-readiness-convergence-2026-08-22.md`

- [ ] Implementar runner fail-fast com TempRoot único, inventário inicial/final e subprocessos serializados para os treze gates da especificação.
- [ ] O runner deve classificar `GREEN`, `RED`, `BLOCKED_ENV` e nunca converter skip em sucesso. `BLOCKED_ENV` impede `APTO`.
- [ ] Executar revisões Luna independentes e somente leitura para runtime, browser, release, secrets e cleanup.
- [ ] Confirmar cada finding no agente principal; hipótese sem reprodução não entra na fila.
- [ ] Para o finding confirmado de maior severidade: criar RED, corrigir, obter GREEN focado e executar novamente `npm run verify:readiness` completo.
- [ ] Repetir auditoria → correção → checkup enquanto houver finding confirmado ou gate RED.
- [ ] Encerrar após uma rodada integral GREEN, sem skips não justificados, resíduos ou findings abertos.
- [ ] Registrar no relatório final comandos, contagens, efeitos colaterais, limitações e veredito `APTO` ou `NÃO APTO`.

