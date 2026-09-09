# Revisão de segurança — Electron, preload, gateway, renderer e anexos

**Data:** 25/08/2026  
**Escopo:** somente leitura. Fronteiras Electron/preload, RPC/HTTP/SSE, staging de anexos, XSS dos overlays e integridade do renderer.  
**Checkout:** `C:\SuperAgent\openbot`  
**Não alterado:** código, testes, manifests, renderer, artefatos proprietários. Este arquivo é o único artefato criado.  
**Não executado:** payload destrutivo, provider pago, login, internet, mutação de artefatos (nem cópia temporária).

**Ameaça considerada:** conteúdo não confiável (mensagem, SSE, provider, anexo, renderer) tentando invocar RPC/IPC, filesystem/processos, escapar agente/conversa, XSS, traversal/symlink/TOCTOU, vazar credenciais/paths, ou alterar artefatos proprietários sem o gate detectar.

---

## 1. Veredito

**ACEITAR COM RESSALVAS.**

Não há P0. O caminho opaco P2.3, o gateway loopback+token+CSRF, a allowlist RPC, o isolation do preload (`contextIsolation`, sem `invoke` genérico) e o boundary SHA-256 do renderer **não** apresentaram fluxo confirmado de conteúdo não confiável até sink privilegiado.

Há **um defeito confirmado (P1)** no runtime Electron que o OpenBot realmente lança: o processo main sobe **sempre unpackaged** (`scripts/openbot-desktop.cmd` aponta o `electron.exe` para `client/extracted/dist/electron-main/main.cjs`). O gate Sand `!app.isPackaged` liga um HTTP de controle em `127.0.0.1:62150` **sem token, Host ou CSRF**. Isso atravessa a fronteira main-process a partir de qualquer cliente local (e de GET CSRF via `openExternal` em um subconjunto das rotas).

Os overlays OpenBot escapam HTML dinâmico. XSS no chat proprietário (Streamdown/marked/Mermaid) **não foi confirmado** nesta passagem estática — fica como gap, não como finding. Anexos opacos, hash no consume, isolamento por `agentId` e o verifier de renderer passaram nos testes locais.

Corrigir F1 antes de tratar o desktop unpackaged como equivalente a um pacote Electron assinado. Não reabrir P2.3 nem o boundary do renderer por este resultado.

---

## 2. Findings confirmados (por severidade)

### F1 — P1 — Confiança alta — HTTP de controle Electron sempre ligado no launcher OpenBot

**Onde:**

- `scripts/openbot-desktop.cmd:6,75` — `OPENBOT_LOCAL_GATEWAY=1`; Electron executa `client\extracted\dist\electron-main\main.cjs` (não é `app.isPackaged`).
- `client/extracted/dist/electron-main/main.cjs:461798-461800` — `isDevControlsEnabled` = `!isPackaged`.
- `main.cjs:462387-462468` — `startDevControlServer`: `listen(port, "127.0.0.1")`, sem autenticação, sem `Host`/`Origin`.
- `main.cjs:462552-462567` e `472969-472985` — `registerDevWiring` chama o servidor sempre que unpackaged.

**Origem do dado / atacante:** processo local na mesma máquina; página guest de `<webview>`; (GET) URL `http://127.0.0.1:62150/...` aberta via `shell.openExternal` (protocolos `http:`/`https:` permitidos em `parseAllowedExternalUrl`, `main.cjs:407737-407758`).

**Fluxo completo:**

1. Utilizador abre o desktop OpenBot pelo launcher.
2. Main Electron não está empacotado → `startDevControlServer` liga `127.0.0.1:62150`.
3. Cliente HTTP sem token chama, por exemplo:
   - `GET /theme`, `GET /gateway-offline` (informação de sessão UI);
   - `GET` ou `POST /skip-onboarding` (mutação; GET é CSRF-ável);
   - `POST /reload` (recarrega a janela principal);
   - `POST /gateway-offline?induced=1` (induz gateway offline);
   - `POST /theme?preference=...`, `POST /box-rebuild-start`, `POST /widget-gallery?on=1`.
4. O handler corre no processo main (reload, settings store, broadcast IPC). Não passa pelo token do gateway em `:1340`.

**Por que a proteção falha:** o produto Sand assume “unpackaged = máquina do programador”. O OpenBot **nunca** empacota esse main; o mesmo bit liga o plano de controlo em uso real. O gateway em `:1340` exige token+CSRF; este servidor não. CSP do `index.html` (`connect-src 'self' ws: sand-media:`) impede o renderer principal de `fetch` para `:62150`; **não** impede processo local, webview guest, nem o browser do sistema após `openExternal`.

**Reprodução segura (não executada nesta revisão — sem lançar Electron):**

1. Subir o desktop pelo launcher.
2. `GET http://127.0.0.1:62150/theme` — JSON de tema, sem `Authorization`.
3. Não chamar `POST /reload` nem `/gateway-offline?induced=1` em sessão com trabalho real.

**Impacto:** disponibilidade e integridade da sessão UI (reload, onboarding, gateway “offline”, rebuild box). Não lê o keystore nem o `gateway.token` por si. Não é RCE.

**Menor correção:** no patch OpenBot de `registerDevWiring`, não chamar `startDevControlServer` quando `OPENBOT_LOCAL_GATEWAY === "1"`, **ou** exigir o mesmo token do gateway + Host loopback. Alternativa de launcher: não suficiente sozinha se o main continuar a ligar o porto.

**Teste RED:** com Electron unpackaged e `OPENBOT_LOCAL_GATEWAY=1`, `GET /theme` em `:62150` deve ser 404/401; hoje é 200.

---

Nenhum outro fluxo nesta revisão cumpriu entrada → fronteira → sink → impacto demonstrável.

---

## 3. Fronteiras examinadas

| Fronteira | Resultado | Nota |
|-----------|-----------|------|
| Electron webPreferences (janela principal) | **PASS** (com ressalva F1) | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`, `webSecurity` default true. `webviewTag: true` com `will-attach-webview` a forçar sandbox. |
| Preload `contextBridge` | **PASS** | `window.desktop` e `window.coordinatorPort` fixos. Sem `ipcRenderer.invoke(canal)` genérico no page world. |
| Allowlist IPC / RPC Electron | **PASS** | Canais `sand:*` e `sand-rpc:main:*` com tabela; edge main restrito ao top-frame. |
| Validação autoritativa de IPC | **PASS** | Segredos, persistência `sand.*`, modo local: `assertTrustedSecretsSender` / `assertOpenBotLocalMode`. URL externa: http(s)/mailto/obsidian/tel. |
| Navegação / `window.open` / downloads | **PASS** | `setWindowOpenHandler` deny + `openExternal` allowlisted; `will-navigate` prevenido. |
| HTTP de controlo unpackaged `:62150` | **FAIL** | F1. |
| Gateway bind | **PASS** | `127.0.0.1:1340` apenas (`src/main.ts:139-140, 1413`). |
| Authn/authz RPC | **PASS** | Token + CSRF Host/Origin loopback em POST; tabela `RPC_METHOD_TABLE`; método desconhecido → 404. |
| DNS rebinding em POST RPC | **PASS** | Host não-loopback → 403 csrf. |
| SSE scoping / backpressure | **PASS** com hardening | Limites 256 KiB / 32 clientes; overflow → resync. Ver H1. |
| Staging opaco `attachment:<id>` | **PASS** | IDs `att-`+UUID; magic bytes; caps; SHA-256 no consume; isolamento por agente. |
| Traversal / symlink / TOCTOU de anexos | **PASS** | Path opaco não é FS; `lstat`+`realpath`+hash. Swap de bytes rejeitado (teste). |
| XSS overlays `openbot-*.js` | **PASS** | Campos dinâmicos via `esc`/`escapeHtml`; status via `textContent`. |
| XSS chat proprietário | **NÃO CONFIRMADO** | Streamdown/marked/`dangerouslySetInnerHTML` (hljs) — gap, não finding. |
| Integridade renderer (tamper acidental) | **PASS** | Baseline + manifest + verifier GREEN. |
| Autenticidade criptográfica do renderer | **N/A** | Limitação deliberada do baseline mutável. |

---

## 4. Falsos positivos eliminados

| Hipótese | Por que não é vulnerabilidade |
|----------|-------------------------------|
| `invoke` genérico no renderer | Preload só expõe métodos fechados; `mainEdgeTransport.invoke` não vai para o page world. |
| Path traversal via `attachment:<id>` | `resolveForSend` rejeita refs sem prefixo (`src/attachments/staging.ts:391-393`). IDs gerados no servidor. |
| Cross-agent no staging | `get` / SQL amarram `agent_id`; teste `p23-attachment-staging.test.ts:172-178, 258-266`. |
| TOCTOU symlink a vazar outro ficheiro | `revalidate` compara SHA-256 dos bytes lidos com o ledger; conteúdo diferente falha. Teste de swap `:142-150`. |
| Prototype pollution no `JSON.parse` do gateway | Handlers leem chaves conhecidas; sem merge perigoso no dispatch HTTP. A2A já rejeita prototype exótico. |
| XSS nos overlays por filename/snippet/erro | `esc()` (inclui `&#39;`) em listas P2.3; erros em `textContent`. P2.2 usa `esc` em label/detail/error. `escapeHtml` legado omite `'`, mas atributos usam aspas duplas e `<` é encoded. |
| SVG malicioso como imagem P2.3 | Magic de imagem não inclui SVG; UTF-8 printable vira `text`, não `data:` SVG. |
| Search/reply a introduzir paths | `searchTranscript` devolve `entryId`/`snippet`; reply resolve no servidor (`src/rpc/p23.ts:156-171`, `send.ts` `resolveReply`). |
| `deleteBytes` a apagar fora do root | `stored_path` é escrito pelo servidor; `ownedPath` recusa fora de `resolve(root)`. Sem input de path pelo renderer. |
| RPC interno não tabelado | Path `/api/foo` fora de `RPC_METHOD_TABLE` → 404 (`gateway.ts:1016-1020`). Teste `gateway.integration.test.ts:180-188`. |
| Token vazio em produção | `loadOrCreateGatewayToken`; `allowUnauthenticatedLocalGateway` é test-only (`src/main.ts:436-438`). |
| `/health` como vazamento de segredo | Expõe `pid`/`isBusy`/`activeAgentId` — usado pelo launcher. Sem token/credencial. |
| Baseline a “provar” origem | O próprio JSON declara que não prova autenticidade se baseline+verifier mudarem juntos. |

---

## 5. Hardening (não elevados a finding)

**H1 — SSE transcript/reasoning sem `?agentId=` faz fan-out.**  
`gateway.ts:471-478`: filtro por `payload.agentId` só se `client.agentId !== null`. Token holder sem `agentId` recebe todos os agentes. O mesmo token já pode `listAgents` + `openAgentTail`. Não acrescenta autoridade; estreitar o default reduz superfície.

**H2 — `sendPrompt` ainda aceita paths de filesystem.**  
`send.ts:3426-3440` exige `path`+`name` string, não o prefixo `attachment:`. `main.ts:1312-1316` ainda chama `readTurnAttachments` + `defaultAttachmentRoots` (inclui `%APPDATA%\OpenBot`, home do agente, `~/.cursor/sand`). O overlay P2.3 só envia refs opacas. Quem já tem token (ou XSS com `window.desktop`) já é o cliente de controlo. Fechar o ramo legado alinha o RPC ao invariante P2.3.

**H3 — GET `/health` e `/avatars/*` sem token.**  
Intencional para o launcher. DNS rebinding em GET não está coberto pelo CSRF (só POST). Impacto: fingerprint. Browsers com Private Network Access reduzem o caso remoto; processo local já vê a porta.

**H4 — Token SSE em `?token=`.**  
`gateway.ts:580` + `auth.ts:55`. Risco de log/Referer se um cliente browser usar query string. O desktop local usa Bearer no RPC (`electron-windows-patches.test.ts`).

**H5 — `sandbox: false` no preload principal.**  
Preload tem Node (`require`). Compromisso do preload (não do page world) amplia o raio. Webviews forçam `sandbox: true`.

**H6 — `window.desktop` é amplo.**  
XSS no renderer principal = `secrets.reveal`, MCP, anexos, CRUD de agentes. Mitigação real é impedir XSS + CSP `script-src 'self'`. Overlays revistos não entregam esse XSS.

**H7 — MIME de imagem no ledger é sempre `image/png`.**  
`mimeForKind` (`staging.ts:170-176`) ignora JPEG/GIF/WEBP detetados. Pode confundir provider; não é escape de FS.

**H8 — Webview `confirm()` sempre `true`.**  
`preload-webview.cjs`. Conteúdo guest auto-confirma diálogos da página. Isolado do `desktop` API.

**H9 — `ownedPath` no delete usa `resolve`, não `realpath`.**  
Mais fraco que `revalidate`. Path não é controlado pelo cliente; residual só com SQLite adulterado (já é compromisso do estado).

---

## 6. Gaps de testes

| Gap | Por que importa |
|-----|-----------------|
| HTTP `:62150` com `OPENBOT_LOCAL_GATEWAY=1` unpackaged | F1 sem RED. |
| `resolveForSend` + `conversationId` incompatível | Código em `staging.ts:362-364`; sem teste `"conversa incompatível"`. |
| Symlink/junction **real** no disco (não mock de `lstat`) | Staging só mocka `isSymbolicLink`. Junctions Windows testadas noutros módulos, não em P2.3. |
| Hard link no verifier do renderer | `lstatSync().isSymbolicLink()` não vê hard links. |
| `sendPrompt` com path legado sob `defaultAttachmentRoots` | Documentar rejeição ou aceite explícito. |
| `__proto__` no body RPC | Risco baixo; sem regressão. |
| XSS P2.3 com filename/snippet `<img onerror>` | Overlay escapa; gate P2.3 não injecta payload malicioso (P2.2 sim, para tasks). |
| Streamdown/marked/Mermaid/hljs no bundle proprietário | Maior superfície XSS não fuzzada. |
| SSE lento além de `gateway-backpressure.test.ts` | Sem sessão Electron real. |
| Shutdown durante `stageAttachment` / `sendPrompt` | Sem teste de corrida. |
| Pacote Windows instalado vs checkout **ficheiro a ficheiro** no renderer | Gate de ZIP/digest existe; P2.2/P2.3 correm contra `client/extracted/dist/`, não contra a árvore instalada. |
| RPC desconhecido **via preload Electron** | Gateway HTTP está coberto; IPC `sand-rpc` unserved é outro caminho. |

---

## 7. Limitações de integridade / autenticidade

O baseline `provenance/renderer-boundary-v1.json` (algoritmo `sha256(sorted-lowercase-posix-relative-path-nul-file-sha256-lf)-v1`) e `client/client-artifacts.manifest.json` são ficheiros **locais mutáveis** no checkout.

**Deteta (integridade contra alteração acidental / drift honesto):**

- Byte add/delete/mutate no conjunto imutável (index.html, JS/MJS/CSS, PNG/JPG/SVG/WOFF2 listados).
- Ficheiro novo inesperado na árvore do renderer.
- Overlay ou media fora da allowlist fechada (`openbot-local-settings.js`, `openbot-memory-ui.js`, `openbot-welcome-renaissance.png`).
- `.map` e `sourceMappingURL` em JS/MJS/CSS.
- Symlink/junction na root, subtree ou ficheiro declarado (mesmo com bytes iguais).
- Agregado do manifest ≠ agregado do baseline.

**Não deteta (não é autenticidade):**

- Atacante que altera **baseline + manifest + verifier** no mesmo checkout (texto em `renderer-boundary-v1.json` `limitations`).
- Runtime XSS / IPC / gateway com bytes em disco intactos.
- Assinatura de publicador, cadeia de certificação, ou “este binário veio do CI”.
- Hard links (ver gap).
- `verify-client-artifacts` sozinho **não** enumera todos os ficheiros do renderer — só index, `requiredAssets` e artefactos de launcher; o closed-world é `verify-renderer-boundary`.

Overlays são **mutáveis por política** (hash conferido, não congelados como chunks proprietários). Mutar um overlay sem atualizar baseline+manifest falha o gate; mutar os três juntos o gate aceita.

Pacote final: `verify:windows-artifact` / lifecycle cobrem digest do ZIP e ficheiros de release, não a igualdade per-file renderer checkout↔install que o boundary faz no tree extraído.

---

## 8. Detalhe por questão obrigatória

### Electron e preload

| Controlo | Estado |
|----------|--------|
| `contextIsolation` / `nodeIntegration` | true / false na janela principal e webviews. |
| `sandbox` | false na janela principal; true forçado em webview attach. |
| `webSecurity` | não overridden (default true). Browser host OpenBot: explicit true. |
| APIs `contextBridge` | `desktop` (superfície grande, métodos nomeados), `coordinatorPort`. Dev panel: `sand.devControls` noutro processo. |
| Invoke genérico | ausente no page world. |
| Allowlist | `MAIN_METHOD_TABLE` + canais `sand:*` wired; métodos RPC “unserved” no edge recusam. |
| Validação | main process nas arestas de segredos/persistência/modo local; preload quase só wrapping. |
| URL/janelas | deny + allowlist de protocolos; webview `src` só http(s)/about. |
| FS/shell no preload | Node existe no preload unsandboxed; **não** exposto à página. I/O via IPC. |
| Dados sensíveis ao renderer | `desktop.secrets.reveal` (plaintext) — modelo “renderer confiável”. XSS = compromisso. |
| Extraído vs pacote | OpenBot corre extraído; `isPackaged=false` liga F1. Patches T15/T17 (Cursor/update) no main extraído. |

### RPC, HTTP, SSE

Token Bearer / `x-openbot-token` / `?token=`. CSRF: Host loopback obrigatório; Origin, se presente, loopback. Corpo JSON ≤ 1 000 000 bytes. `agentId`/`conversationId` validados nos handlers (send, transcript, p23, tasks). Extra keys no body de `sendPrompt` passam no spread (`normalizeSendPrompt`) — H2-adjacent, não pollution. Backpressure SSE: buffer 256 KiB → frame `resync` `backpressure`; não destrói o cliente. Cleanup: `close` no SSE, `abortAllTurns` no shutdown. Métodos não declarados: 404.

### Anexos e staging

IDs opacos; isolamento agente (testado) e conversa quando `conversationId` foi gravado (não testado). Caps: 256 KiB text / 2 MiB pdf+image / 16 por turno / 4 MiB agregado / pool 32 e 32 MiB por agente. Consume único + delete bytes. Expiry 15 min + sweep. Overlay descarta no Escape/pagehide/close. Hash no send. Cleanup `ownedPath`. Ramo legado de path FS ainda existe no `readAttachments` do `main.ts`.

### Renderer e XSS

Overlays: `innerHTML` com escape; sem `eval`/`javascript:`/`insertAdjacentHTML`. Drag/drop e paste no P2.3 enviam **bytes** a `stageAttachmentBytes`, não paths. Teardown Escape/pagehide presente. Conteúdo renderizado **não** recebe `ipcRenderer`; só `window.desktop` se XSS no mesmo mundo — overlays revistos não injectam script. Chat proprietário: CSP `script-src 'self'`; `img-src` inclui `https:` (pixels remotos possíveis se o markdown renderizar `<img>`).

### Integridade do renderer

Cobertura confirmada: index.html, JS/MJS/CSS, PNG/JPG/SVG/WOFF2 no baseline, ficheiros novos, overlays e media allowlisted, source maps proibidos. Igualdade checkout↔manifest↔agregado: GREEN nesta revisão. Igualdade checkout↔pacote instalado: não provada per-file aqui.

---

## 9. Comandos executados e resultados

Todos locais, exit 0.

| Comando | Resultado |
|---------|-----------|
| `npm run typecheck` | GREEN (~10 s) |
| `npm run build` | GREEN (~8 s) |
| `npm run verify:renderer-boundary` | `ok: true`; immutable aggregate `8be890dd0e54aa5b31fb2821b08c89dcc3bba6a6faa28c11de8ea613089d460d` |
| `npm run verify:client-artifacts` | `CLIENT_ARTIFACTS GREEN` (12 checks). WARN: source maps stale em artifact main/preload **sem referência runtime** |
| `npm run verify:visual-ui -- --artifacts-only` | `VISUAL_UI_GATE GREEN (artifacts-only)` |
| `npx vitest run test/p23-attachment-staging.test.ts test/renderer-boundary.test.ts test/electron-client-artifacts.test.ts test/gateway-backpressure.test.ts --maxWorkers=1 --no-file-parallelism` | 4 ficheiros, **58/58** testes |

Não lançado: Electron desktop (logo não se fez GET vivo a `:62150`). Não corridos: `rpc-send-gateway.integration.test.ts`, `gateway.integration.test.ts`, `p23-electron-gate.test.ts`, `electron-windows-patches.test.ts` (lidos; não na lista de execução desta revisão).

---

## 10. Plano mínimo de correção (não implementado)

1. **F1 (obrigatório):** em `registerDevWiring`, se `process.env.OPENBOT_LOCAL_GATEWAY === "1"`, não chamar `startDevControlServer`. Complemento: Host loopback + token se o servidor existir em qualquer outro modo. Teste RED no patch de `main.cjs` (padrão já usado em `test/electron-windows-patches.test.ts` / `desktop-lifecycle-hardening.test.ts`).
2. **H2:** em `validate` de `sendPrompt`, rejeitar `path` que não comece por `attachment:`. Remover o ramo `legacy` em `main.ts` `readAttachments` quando o invariante P2.3 for o único caminho.
3. **H1:** exigir `?agentId=` para canais `transcript` e `reasoning` (como já para tasks), ou filtrar `agentId === null` para não receber esses canais.
4. **Testes:** conversa incompatível no staging; junction real; filename XSS no gate P2.3; `sendPrompt` path legado 400; shutdown a meio do stage; comparação renderer checkout vs árvore do pacote Windows.
5. **Integridade:** manter o boundary como deteção de drift. Não o vender como autenticidade. Se o modelo de ameaça incluir maintainer/checkout hostil, assinar o aggregate fora do repo (não misturar com o SHA local).

Nenhum outro defeito confirmado. Não inventar findings para preencher este relatório.
