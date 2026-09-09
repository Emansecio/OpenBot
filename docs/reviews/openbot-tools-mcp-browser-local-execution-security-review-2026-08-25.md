# Revisão de segurança adversarial — tools, MCP, browser, workspace e execução local

**Data:** 25/08/2026  
**Escopo:** somente leitura. Pipeline de tools, capabilities/grants, filesystem/workspace, WSL/processo, MCP, browser/rede, keystore e auditoria.  
**Checkout:** `C:\SuperAgent\openbot`  
**Não alterado:** código, testes, configuração, manifests, renderer, estado real do usuário. Este arquivo é o único artefato criado.  
**Não executado:** provider pago, login, internet, sites externos, MCP configurado pelo usuário, WSL real, `%APPDATA%\OpenBot`, desktop instalado, `npm run smoke:local`, `npm run verify:skills-mcp` (sobe Electron E2E), `npm run verify:browser:public-readonly` (navega `https://example.com/` e `https://www.iana.org/`).

**Ameaça considerada:** entrada não confiável (prompt, provider, tool call, MCP, página, path/URL, subagente, async task restaurada, processo filho, estado persistido) atravessar parser → capability → broker → backend e produzir efeito externo não autorizado.

O finding do HTTP de controle Electron `127.0.0.1:62150` não é relitigado. Não foi encontrada cadeia nova dele até tools, MCP, browser ou execução local.

---

## 1. Veredito executivo

**ACEITAR COM RESSALVAS.**

Não há P0 remoto. Lite, MCP HTTP/STDIO, proxy de egress do browser, sandbox WSL (chroot + namespaces + seccomp + cgroup) e o pipeline de tool-call (fail-closed, dedupe, ledger `started`→`unsafe`) **não** apresentaram bypass confirmado de entrada hostil até sink privilegiado.

Há **um defeito confirmado (P1)** no modo Developer: `process_run` executa, por omissão, **sem aprovação** (`localToolPermission: "always"`) dentro de um guest que monta a home inteira, inclusive `.openbot`. As tools `file.*` recusam `.openbot`; o processo não. O guest pode reescrever `.openbot/grants.json`. Esse arquivo é a **única autoridade** que monta Desktop/Documents reais do usuário; `seedGrantsFile` nunca sobrescreve um documento existente; `writeSharedGrants` não é chamado por nenhum RPC de produção. Após restart (ou recriação do backend), `HomeWorkspaceBackend.loadGrantedMounts` honra o grant forjado e as tools de arquivo escrevem na pasta real do perfil Windows.

O restante das cadeias obrigatórias foi eliminado ou ficou em hardening sem fluxo agente→sink. Não reabrir o subsistema inteiro: corrigir F1 (imutabilidade de `.openbot` no guest + grants autenticados fora do workspace gravável) antes de tratar Developer como sandbox equivalente a “não vê pastas reais do usuário”.

---

## 2. Mapa da superfície

| Camada | Entrada | Autoridade | Broker / manager | Backend | Efeito | Isolamento esperado |
|--------|---------|------------|------------------|---------|--------|---------------------|
| Tools nativas | `ProviderToolCall` (nome + JSON) | `localToolPermission`, `policy.json` (só aperta), grants de pasta, runtimeMode | `LocalExecutionBroker` | `AgentRuntimeBackend` → files / search / WSL process / browser / whatsapp | FS, processo, rede via browser | Paths relativos à home; `.openbot` invisível às file tools; processo só no workspace |
| Skills / MCP | mesmo stream; prefixo `mcp__` | policy MCP do agente; grant de async task | `SharedTools.executor` → `McpManager` | STDIO allowlisted ou HTTP com DNS pinado | I/O do servidor MCP | Default deny; colisão de nome: nativa vence |
| Browser | `browser_*` | lease por `agentId`; partition `persist:openbot-agent-{hash}` | `BrowserExecutionBackend` → `BrowserSessionManager` | Electron host + egress proxy loopback | navegação HTTP(S) pública | cookies/tabs por agente; loopback/privado negados |
| Workspace | `file.*` / `search_*` | `WorkspaceSandbox` + `assertVisiblePath` + TOCTOU em `files.ts` | broker | `LocalFileExecutor` / mounts por grant | leitura/escrita na home ou pasta real se grant | sem `..`, UNC, ADS, reparse; quota |
| Processo WSL | `process_run` (só Developer) | allowlist de executável + `networkProfile: none` | broker → `WslProcessBackend` | guest `execve /usr/bin/{name}` | processo no chroot | sem shell; sem `/mnt/c` completo; cgroup kill |
| Processo local | `OPENBOT_RUNTIME_DRIVER=local` | opt-in de ambiente, não do modelo | mesmo broker | `LocalProcessRunner` `spawn(shell:false)` | processo no host | contrato explicitamente mais fraco |
| Segredos | RPC `submitSecret` / `setBoxSecrets` | gateway autenticado | keystore | DPAPI / safeStorage / local-file | API keys | escopo por `agentId` no lookup; widget usa escopo default |
| Resume | ledger `turn_effects` | fingerprint + status | `runToolLoop` | não reexecuta `completed`; recusa `started`/`unsafe` | idempotência | providers de produção: `resume: none` |

---

## 3. Findings confirmados por severidade

### F1 — P1 — Confiança alta — `process_run` (Developer) forja `grants.json` e, após restart, escreve pastas reais do usuário

**STRIDE:** Elevation of privilege, Tampering  
**OWASP:** A01 Broken Access Control, A04 Insecure Design  
**Reachability:** agente/subagente em `runtimeMode: "developer"` + provider hostil (tool call). Não é remoto não autenticado. Default de permissão: **always** (sem clique).

**Arquivo e linhas:**

- `src/config/store.ts:173-179` — default `hostSettings.localToolPermission: "always"`.
- `src/main.ts:629-633` — broker usa esse default; Developer recebe `DEVELOPER_TOOLS` (inclui `process_run`).
- `src/execution/home-tools.ts:262-283` — schema de `process_run` anunciado ao modelo.
- `src/execution/contracts.ts:195-226, 355` — `node`/`python`/`python3` não estão na blocklist de shell; `cwd` não recusa `.openbot`.
- `src/execution/runtime/agent-backend.ts:50-53` — `process.run` **não** passa por `HomeWorkspaceBackend` nem por `assertVisiblePath`.
- `src/execution/files.ts:240-255` e `src/execution/user-files.ts:25-28` — file tools recusam primeiro componente `.openbot`.
- `src/execution/home-backend.ts:47-59, 147-148, 180-199` — search também bloqueia `.openbot`; mounts reais vêm só de `readSharedGrants`.
- `src/execution/home.ts:151-158` — `seedGrantsFile` usa `flag: "wx"`; existente **nunca** é resetado.
- `runtime/guest/supervisor/src/mounts.rs:257-284` — drvfs do volume + bind de **todo** o caminho da home em `/workspace`, depois unmount do bridge; `.openbot` fica gravável no guest.
- `runtime/guest/supervisor/src/sandbox.rs:203-236` — `execve("/usr/bin/{executable}")` com argv estruturado; política empacotada inclui `node` e `python3` (`scripts/package-runtime-guest.mjs:25-28`).
- `src/main.ts:559, 584-605` — produção liga `shareUserFiles`; backend cacheado até delete/restart.
- `src/execution/home-grants.ts:73-78` — `writeSharedGrants` existe; **nenhum RPC em `src/rpc/` o chama**.

**Entrada controlável:** tool call do modelo

```json
{
  "name": "process_run",
  "arguments": {
    "executable": "node",
    "argv": ["-e", "require('fs').writeFileSync('.openbot/grants.json', JSON.stringify({version:1,grants:{Documents:{access:'write'},Desktop:{access:'write'}}}) )"],
    "cwd": ".",
    "timeoutMs": 5000,
    "networkProfile": "none"
  }
}
```

**Caminho completo:**

`parseToolCall` / `toolCallToExecutionRequest` (`tool-request.ts:159`)  
→ `parseExecutionRequest` (python/node permitidos)  
→ `LocalExecutionBroker.execute` (`always` → sem `beginApproval`)  
→ `AgentRuntimeBackend.execute` → `WslProcessBackend`  
→ guest `execve /usr/bin/node` com cwd `/workspace`  
→ escrita de `.openbot/grants.json`  
→ restart → `AgentRuntimeBackend.create` → `loadGrantedMounts` (`home-backend.ts:186-198`)  
→ `file.write` `Documents/...` via mount real (`openSharedUserMount`).

**Sink final:** `fs` na pasta real do perfil Windows (`%USERPROFILE%\Documents`, `\Desktop`, …), não no redirect `...\OpenBot\<agentId>\...`.

**Por que a proteção falha:** a reserva de `.openbot` é aplicada no executor de arquivos (`assertVisiblePath`), não no último componente antes do I/O do processo. O contrato textual de `process_run` (“not the user's shared folders”) descreve o *namespace do guest*, não a autoridade persistida que as file tools consultam depois. Grants não têm assinatura, MAC nem canal RPC de usuário.

**Reprodução segura (offline, raiz temporária; WSL real não executado nesta revisão):**

O sink já está coberto por `test/execution-home-grants.test.ts:76-92`: um `grants.json` com `Documents: write` faz `file.write Documents/escrito.txt` aterrissar no Documents **real** do perfil de fixture. A lacuna não testada é o *writer*: `process_run` produzir esse arquivo. Não foi disparado `process_run` contra WSL de produção nem contra `%APPDATA%\OpenBot`.

**Impacto:** bot Developer passa a ler/escrever Desktop/Documents/Downloads reais do usuário sem grant UI, após restart. Quebra o opt-in de pastas compartilhadas. Auditoria em `.openbot/audit/` também é regravável pelo mesmo processo (repúdio).

**Menor correção:** (1) no guest, não montar `.openbot` gravável (bind read-only ou omitir do `/workspace`); e (2) persistir grants fora da home gravável pelo agente (SQLite/config) ou autenticá-los com segredo que o guest não vê. Complemento: `process_run` em `ask` por omissão, independente de `file.*`.

**Teste RED:** fixture Developer com runner que escreve `.openbot/grants.json`; recriar `AgentRuntimeBackend`; `file.write Documents/x` **não** deve tocar o Documents real do perfil de teste.

---

Nenhum outro fluxo nesta revisão cumpriu entrada → fronteira → sink → impacto demonstrável como vulnerabilidade confirmada.

---

## 4. Chains obrigatórias

| # | Cadeia | Estado | Evidência |
|---|--------|--------|-----------|
| 1 | prompt injection → tool call → aprovação reutilizada → write/process/network | **Eliminada** | Aprovação congela `structuredClone(request)` (`broker.ts:386-393`); mesmo `requestId` com fingerprint diferente é deny (`broker.ts:247-249, 321-325`); testes `execution-approval.test.ts`, `rpc-tool-lifecycle.test.ts:201-244`. Default `always` **não** é reuso de aprovação — é ausência de aprovação (alimenta F1, não chain 1). |
| 2 | página maliciosa → redirect/DNS rebinding → gateway/MCP/local | **Eliminada** | Host força proxy + `<-loopback>` (`openbot-browser-host.cjs:757-760`); proxy classifica IP literal e DNS (`egress-proxy.ts:344-361, 491-501`; `network-policy.ts:144-191`); `redirect: "error"` no MCP HTTP (`manager.ts:941-944`). `:1340` e `:62150` são loopback, negados no egress. |
| 3 | MCP hostil → spoofing de schema/tool → capability maior → FS/processo | **Eliminada** (residual de confiança) | Prefixo `mcp__` + segmentos sem `__` (`contracts.ts:144-170`); nativa vence colisão (`shared-tools.ts:117-123`); policy por chamada (`manager.ts` allowlist). MCP aprovado pelo admin ainda injeta descrição/resultado no modelo (hardening, não bypass). |
| 4 | subagente → grant mal delimitado → tool/MCP/browser do pai | **Eliminada** | `deriveEffectiveGrant` ∩ autoridade (`state-machine.ts:154-168, 264-274`); testes `async-task-capability-surfaces.test.ts`, `async-task-production-capabilities.integration.test.ts`. MCP do subagente ainda passa pela policy do agente. |
| 5 | restart durante efeito → ledger inconsistente → execução duplicada | **Eliminada** | `started` sem resultado → `unsafe` no reopen (`store` reconcile) e no tool-loop (`tool-loop.ts:336-344`); `completed` replay é idempotência deliberada. Produção: `resume: none`. |
| 6 | symlink/junction swap → validação → escrita fora do workspace | **Eliminada como cadeia de agente**; residual hardening | Tool loop é sequencial (`tool-loop.ts:300-479`). WSL usa `CLONE_NEWPID` + wait do PID 1 (`sandbox.rs:148-170`) — filho órfão morre. `files.ts:66-98, 950-956` revalida antes do rename (testes `execution-files.test.ts`). `safe-tree.ts:99-115, 152-159` **não** revalida o destino no commit (cross-mount); exige escritor concorrente na mesma home. Outro agente não escreve essa home. |
| 7 | WSL → `/mnt/c` ou socket compartilhado → recurso do host | **Eliminada** (via direta) | Bridge drvfs é desmontado após bind do relativo da home (`mounts.rs:283-284`). Sem socket de gateway no guest. F1 é cadeia **indireta** (metadata → file tools no host), não este enunciado. |
| 8 | driver local → executable/argv controlável → command injection | **Eliminada** | Ativação só `OPENBOT_RUNTIME_DRIVER=local` (`main.ts:503-532`). Agente não escolhe o driver. Sem env, não há fallback silencioso WSL→local. `spawn({ shell: false })`. |
| 9 | browser session compartilhada → cookie/tab de outro agente | **Eliminada** | Partition `persist:openbot-agent-{hash}` (`browser-session-manager.ts:269`); `assertTabOwnership` (`openbot-browser-host.cjs:815-818`); `tabId`/`lease` emitidos pelo manager. |
| 10 | output tool/MCP/browser → transcript/log → vazamento de segredo | **Inconclusiva / hardening** | Cards de transcript omitem stdout/file content (`tool-card.ts`); MCP sucesso vai inteiro ao **contexto do modelo** (`shared-tools.ts:216-221`); snapshot de página até 128 KiB no host. Persistência em `turn_effects.result_json` sem redaction de keystore. Não é bypass de fronteira; é canal de dados intencional + higiene. |

---

## 5. Matriz PASS/FAIL

| Superfície | Resultado | Nota |
|------------|-----------|------|
| Tool pipeline | **PASS** | Parse fail-closed; shell recusado; schema antes do broker; truncamento não vira sucesso. |
| Capability / grants / aprovações | **FAIL** (F1) | Grants de pasta não são autenticados; `always` default; `.openbot` gravável pelo processo. Aprovações em si: PASS. |
| Filesystem (file tools, Windows) | **PASS** | `WorkspaceSandbox` + TOCTOU em `files.ts`; Zip Slip recusado (`home-archive.ts`); ACL Windows aplicada via `icacls` (`home-acl.ts`). |
| Processo (search) | **PASS** | Sem `spawn`; walk com skip de symlink (`commands.ts:174-187`). |
| WSL (isolamento de processo) | **PASS** com ressalva F1 | Sem `/mnt/c` completo; sem shell; cgroup. Metadata da home é o furo. |
| Driver local | **PASS** | Opt-in explícito de env; não alcançável pelo modelo. |
| MCP | **PASS** | Config via RPC autenticado; SSRF/DNS pin; STDIO snapshot + cwd TOCTOU; erros sanitizados. |
| Browser | **PASS** | Egress obrigatório; http(s) only; partitions; upload/download contidos. Policy unitária de public-readonly PASS; gate live HTTPS **não** corrido (rede). |
| Secrets | **PASS** com ressalvas de higiene | DPAPI/safeStorage; RPC de box não devolve plaintext. `submitSecret` grava no escopo default (limitação deliberada / UX de widget). Keystore não é limpo no delete do agente. |
| Auditoria | **PASS** como observabilidade | JSONL sem MAC; falha de escrita não bloqueia (`audit.ts:7-8, 50-58`; `broker.ts:289-295`). Agente Developer pode reescrever o próprio log (consequência de F1). |
| Restart / resume | **PASS** | Ledger `started`→`unsafe`; cursor de resume fora desta revisão (já tratado na revisão P1/P2 de durabilidade). |

---

## 6. Falsos positivos eliminados

| Hipótese | Por que não é finding |
|----------|------------------------|
| Existir `spawn` / driver local / `sandbox: false` | Driver local só com env; WSL é o default. |
| Existir `sessionScope: "shared"` | Escolha de admin; policy MCP reavaliada por agente. |
| Tool de escrita existir | Esperado; bounded por sandbox + grants. |
| MCP receber env | Só `secretRef`; env mínimo + shadow (`manager.ts:243-268`). |
| WSL ter `/mnt/c` no host | Guest não retém o bridge; só o relativo da home. |
| Browser acessar internet | Navegação pública permitida; privado/loopback negados. |
| `shell` no schema MVP / comentários T9 | Execução recusa `shell` (`tool-request.ts:173`). |
| Reuso de tool-call id do provider | IDs de broker/aprovação são `turnId`+call (`tool-loop.ts:446-448`). |
| Replay de efeito `completed` | Idempotência; não é segunda execução. |
| HTTP MCP em loopback | Admin configura o URL; o processo OpenBot já é o dono do gateway. |
| `:62150` via browser | Egress nega loopback; sem cadeia nova. |
| `submitSecret` sem `agentId` no upsert | Teste de produção espera `reveal("openai")` no escopo default (`interactions.test.ts:160`). Widget de API key é host-global por desenho. |
| Unicode NFC em paths | Sem evidência de bypass além de case-fold Windows já usado. |

---

## 7. Hardening e gaps de teste

**Hardening (não elevados a finding):**

- `safe-tree.ts` commit sem `assertStablePath` / re-`resolveDestination` (cross-mount TOCTOU).
- `broker.resolve` não reavalia `decidePolicySafely` após o clique Allow.
- Resultado MCP e stdout de processo entram no contexto do modelo sem o mesmo redactor de `tool-card.ts`.
- Sem teto de bytes em `function.arguments` antes de `JSON.parse`.
- `local-exec-bridge` não propaga `AbortSignal`.
- Rate limit de `PolicyEngine` é in-memory (some no restart).
- Erro DPAPI inclui `modulePath` (`dpapi.ts:47-48`).
- Hosts numéricos tipo `2130706433` não têm teste de proxy (Chromium costuma canonicalizar; gap).
- `HOME_SYSTEM_PROMPT` ainda diz que Desktop/Documents “are the user's real folders and are shared by every bot” — texto obsoleto frente aos grants opt-in.

**Gaps de teste:**

- `test/browser-network-policy.test.ts` e `test/browser-session-manager.test.ts` **não existem** (coberto indiretamente por egress-proxy / browser-manager / browser-security).
- `test/execution-safe-tree.test.ts` tem **1** teste (EXDEV); sem race de junction no rename.
- Nenhum teste de que `process_run` não pode mutar `.openbot/grants.json`.
- Nenhum teste de reavaliação de policy no `resolve()`.
- Nenhum teste de redaction em payload MCP de sucesso.

---

## 8. Comandos executados e resultados exatos

```
npm run typecheck
> tsc -p tsconfig.typecheck.json
exit 0

npm run build
> tsc -p tsconfig.json
exit 0
```

Vitest (todos `--maxWorkers=1 --no-file-parallelism`; fixtures em `os.tmpdir()`):

| Lote | Resultado |
|------|-----------|
| tool-calls, shared-tools, rpc-send-tools, rpc-tool-lifecycle | 4 files, **72/72** pass, 6.86s |
| execution-tool-request, approval, audit-policy, commands, files, workspace, safe-tree | 7 files, **144/144** pass, 1.97s |
| quota, quota-scopes, home-tools, home-grants, home-lifecycle, local-exec-gateway | 6 files, **47/47** pass, 27.39s |
| mcp-security, mcp-manager, mcp-sdk-transport, rpc-mcp | 4 files, **54/54** pass, 6.05s |
| browser-security, egress-proxy, execution-backend, public-readonly, runtime-integration | 5 files, **42/42** pass, 6.70s |
| autonomous-execution, async-task-capability-surfaces, async-task-production-capabilities | 3 files, **12/12** pass, 5.70s |

**Total corrido:** 29 arquivos, **371 testes, 0 falhas.**

**Não executado (proibido ou toca rede/desktop/estado real):**

- `npm run verify:skills-mcp` — encadeia `verify:e2e:desktop`, que lança Electron (`scripts/e2e-desktop-run.ps1`, `ELECTRON_PATH` default em Hermes).
- `npm run verify:browser:public-readonly` — `PUBLIC_READONLY_URLS` = `https://example.com/`, `https://www.iana.org/` (`public-readonly-gate.ts:8-11`).
- `npm run smoke:local`, live WSL, ACL live, desktop instalado.

---

## 9. Limitações da revisão

- Sem WSL live: F1 é cadeia de código + teste de sink de grants; o `execve` no guest não foi exercido nesta máquina.
- Sem internet: DNS rebinding “ao vivo” e public-readonly live não foram observados; a política de proxy/MCP foi lida e testada com resolvers injetados.
- Sem MCP/browser de usuário nem `%APPDATA%\OpenBot`.
- Driver local não foi ativado.
- Revisão P1/P2 de durabilidade (cursor de resume, etc.) não foi relitigada; o código atual trata `started` como unsafe.
- `bin/sh` existe no rootfs empacotado (`runtime-package.test.ts` espera `bin/sh`) mas a política do guest **não** o allowlista; `exec_allowlisted` só chama `/usr/bin/{name}` da policy.

---

## 10. Plano mínimo de correção (não implementado)

1. **F1 — autoridade de grants fora do alcance do guest**  
   - Montar `/workspace/.openbot` read-only (ou não montar). Preferível alinhar o bind ao contrato “Projects”.  
   - Mover grants para store/SQLite ou assinar o documento com chave que o guest não vê.  
   - `readSharedGrants`: recusar documento sem autenticidade.  
   - Default: `process_run` exige `ask` mesmo se `file.*` estiver em `always`.

2. **Testes RED**  
   - Processo (ou backend de teste) escreve `.openbot/grants.json`; novo `AgentRuntimeBackend`; escrita em `Documents/` deve permanecer no redirect.  
   - Junction race em `copySafeTreeAtomic` (hardening).  
   - Policy tighten entre ask e Allow (hardening).

3. **Não fazer**  
   - VM/container permanente por agente: a fronteira `.openbot` vs guest é corrigível incrementalmente (bind RO + grants autenticados).  
   - Tratar o driver local como bug: permanece opt-in.

Até F1, o modo Developer **não** cumpre o isolamento anunciado relativamente às pastas reais do usuário após persistência + restart.
