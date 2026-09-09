# OpenBot — Fork 100% local (Windows-only) do Grok Bot 0.16.0

Fork **100% local, Windows-only** do Grok Bot (identidade interna
sand/Cursor/Anysphere 0.16.0). A Fase 1 (MVP) está aceita e a Fase 2 entrega o
ambiente por bot: home NTFS, runtime nativo Windows e browser visual. Um **shim** em TypeScript/Node substitui o par
"host original + backend Cursor": emula o gateway HTTP+SSE (`gateway-protocol.ts`,
mapa-funcoes §4.5) e a mesa RPC mínima, e faz inferência sobre providers abertos
(OpenAI, xAI/Grok, OpenAI-compatible com baseURL custom). O cliente original (UI)
se conecta ao shim via `EnvDescriptorHostConnector` na porta local — a UI não sabe
que o backend mudou (estratégia do plano §2). A execução local usa broker próprio,
processos no host Windows, um host Electron sob demanda e catálogos compartilhados de Skills/MCP. A seleção do driver WSL é restrita ao bootstrap de testes; não é o backend padrão do produto.

> Registro histórico do ambiente WSL (agosto de 2026): [`docs/practical-bot-environment-final.md`](docs/practical-bot-environment-final.md).
>
> Aceite histórico das sete áreas (agosto de 2026): [`docs/openbot-all-areas-100-acceptance-2026-08-17.md`](docs/openbot-all-areas-100-acceptance-2026-08-17.md).
>
> Skills autônomas, seletor `/` nativo e MCP compartilhado: [`docs/shared-skills-mcp-chat.md`](docs/shared-skills-mcp-chat.md).
>
> Conversas separadas e memória durável isolada por bot: [`docs/openbot-bot-memory-conversations-2026-08-18.md`](docs/openbot-bot-memory-conversations-2026-08-18.md).
>
>
> Paridade visual consciente com a vitrine Grok Bot 0.18 (o que copiar, o que recusar): [`docs/openbot-visual-parity-grokbot-2026-08-19.md`](docs/openbot-visual-parity-grokbot-2026-08-19.md).
>
> Grupos locais de bots (compose Para/chips, membros já existentes; spec cruzada com Grok Bot 0.36): [`docs/superpowers/specs/2026-09-03-local-bot-groups-design.md`](docs/superpowers/specs/2026-09-03-local-bot-groups-design.md) · plano [`docs/superpowers/plans/2026-09-03-local-bot-groups.md`](docs/superpowers/plans/2026-09-03-local-bot-groups.md).
>
> Relatório consolidado da auditoria histórica P0/P1/P2 com a reconstrução 0.18, agentes, páginas e effects: [`docs/openbot-grokbot-018-consolidated-improvement-report-2026-08-24.md`](docs/openbot-grokbot-018-consolidated-improvement-report-2026-08-24.md).
>
> Auditoria CDP das transições, lista longa, streaming e correção do transform virtual: [`docs/openbot-transition-animation-audit-2026-08-22.md`](docs/openbot-transition-animation-audit-2026-08-22.md).
>
> Fronteiras de confiança e configuração segura: [`SECURITY.md`](SECURITY.md).

> Referências históricas externas: `plano-fase1-mvp.md`, `mapa-frontend.md` e `mapa-funcoes.md`. Esses arquivos não estão disponíveis nos caminhos anteriormente referenciados; as menções a suas seções abaixo registram a origem histórica, não uma dependência de leitura atual.

## Desenvolvimento com GPT-6 Astra

O [AGENTS.md](AGENTS.md) define o fluxo de trabalho do agente que mantém este
checkout. Foi ajustado ao [guia oficial do Astra](https://developers.openai.com/api/docs/guides/latest-model)
consultado em 04/09/2026, preservando o escopo mínimo, a execução em um único
agente por padrão e a confirmação por senha para operações irreversíveis.

Esta orientação de desenvolvimento não altera os modelos dos bots. O catálogo
continua em [src/config/models.ts](src/config/models.ts), sem entrada para
`gpt-6-astra` nesta revisão. O [adapter OpenAI](src/providers/openai.ts) já possui
transporte Responses, mas a seleção automática por nome cobre `gpt-5.6-*`;
também existem overrides explícitos de protocolo. Para Astra, ferramentas exigem
Responses API. Uma integração do modelo no produto precisa validar catálogo,
seleção de transporte e parâmetros; esta atualização é apenas documental.

## Decisões históricas do MVP (11/08/2026)

A tabela registra o escopo original. Para comportamento atual, consulte o fluxo operacional abaixo e a implementação; não trate fases antigas como restrições novas.

| # | Decisão | Valor congelado |
|---|---|---|
| §8.3 | Catálogo de modelos | **Estático local** (`src/config/models.ts` → JSON versionado; sem rede; fetch dinâmico só na Fase 4) |
| §8.7 | Porta do gateway | **Fixa `127.0.0.1:1340`** — sem fallback dinâmico; porta ocupada = erro claro |
| §8.6 | Persistência | **SQLite particionado por agente** (`better-sqlite3`); boot válido com zero bots; **roster multi-agente** via `createAgent` nativo |
| §8.4 | VNC/cloud computer | **Stubs inertes**: `getForeverBoxStatus → {vncUrl:null, windows:[]}`; botão Computer / Plugins / Log out ocultos no cliente local |
| §8.5 | Transcribe de áudio | **Off (no-op)** no MVP |

Modelo **por bot** (fallback global `grok-4.6`). Catálogo OpenAI: `gpt-5.6-luna`,
`gpt-5.6-sol` e `gpt-5.6-terra`. Sem conta/backend/cloud; chaves do usuário via
safeStorage/DPAPI (T4+). Telemetria/updates: off (T17+).

## Arquitetura (plano §1)

```
src/
├─ main.ts            # bootstrap: porta fixa 1340, descritor local, spawn/lifecycle
├─ shared/            # CONTRATOS congelados (espelho do gateway-protocol): types de
│                     #   transcript/transcript-page/sendPrompt/envelopes/eventos SSE
│                     #   + fixtures golden (JSON authorados dos mapas §3.2/§3.3)
├─ server/            # gateway HTTP+SSE (T3+): GET /api/events, POST /api/<method>,
│                     #   /health, /prepare-upgrade, /avatars, CSRF loopback, gzip
├─ rpc/               # dispatch da mesa MVP (T3+): chat / transcript / tools / settings
├─ providers/         # roteador unificado streamChat (T5+) + adapters
├─ keystore/          # safeStorage/DPAPI (T4+): sand-secrets.json em %APPDATA%\OpenBot\
├─ execution/         # sandbox Windows, arquivos, busca, broker e tool loop
├─ skills/            # catálogo seguro e dispatcher autônomo/explicito
├─ mcp/               # manager compartilhado HTTP/stdio, policies e limites
├─ integrations/      # composição das tools locais, Skills e MCP
├─ store/             # sqlite por agente: transcript, ledger e decisões
└─ config/            # catálogo estático de modelos, perfil local, flags (JSON)
test/                 # unit + contrato RPC (golden) + e2e com mocks de provider
scripts/              # (Fase 1, T19) smoke-test + monitor de rede (zero egress)
patches/              # (Fase 1, Onda 3) diffs documentados dos patches no cliente
```

**Estratégia de conexão app ↔ shim (plano §2):** renderer ↔ main ↔ coordinator INTACTA
(zero patch); coordinator ↔ gateway via `EnvDescriptorHostConnector` com
`SAND_HOST_GATEWAY_URL=http://127.0.0.1:1340` + token local aleatório (patch de 1 ponto,
T16); gateway HTTP+SSE reproduzido no shim (spec §4.5); inferência via roteador novo
(adapters OpenAI/xAI/OpenAI-compat, T5–T8); UI sem rebuild do renderer.

## Checklist de revisão das fixtures golden (T2)

Fixtures authoradas **à mão** dos shapes dos mapas (sem abrir código) e revisadas
contra:

- [x] `test/fixtures/transcript-page.json` → mapa-frontend §3.3 (`SandTranscriptPage
      {entries[], nextCursor?}`; kinds `message`/`user-attachment`/`tool-call`/`notice`/`event`)
- [x] `test/fixtures/send-message-kinds.json` → mapa-frontend §3.3 (union `message.type`
      com as 13 variantes: text/attachment/widget/cursor-agent/secret-request/email-draft/
      slack-draft/permission-request/auto-review-approval/local-tool-permission/connector/
      connectors/listener-connect — garante "nenhum card missing")
- [x] `test/fixtures/rpc-envelopes.json` → mapa-frontend §3.2 (`{ok,value}` / `{ok:false,failure}`)
- [x] `test/fixtures/sse-events.json` → mapa-funcoes §4.5 (evento `{channel,payload}`,
      `snapshot`/`appended`, heartbeat `:ping` 15s, `retry:1000`)
- [x] `test/fixtures/stubs-box-settings-models.json` → plano §3 T13 + mapa-funcoes §4.5
      (box stub inerte, `SandHostSettings`, `getAvailableModels`, flags)

Os testes de shape (`test/shared-contracts.test.ts`, `test/fixtures-golden.test.ts`)
referenciam as fixtures e validam cada variante contra o contrato congelado
(`src/shared/contracts.ts`). Mudança de shape exige atualizar fixture + revisão.

## Comandos

```bash
npm install          # deps mínimas: typescript, vitest, better-sqlite3, @types/*
npm run build        # tsc → dist/ (verde)
npm test             # vitest run
npm run smoke:local  # build + prompt/SSE/dedupe/restart sem rede externa
npm start            # sobe gateway em http://127.0.0.1:1340 (Ctrl+C derruba)
npm run desktop      # gateway + Electron (defina ELECTRON_PATH se não houver node_modules/electron)
npm run verify:data-recovery  # SQLite WAL + backup/checksum/restore em %TEMP%
npm run verify:clean-profile  # primeiro boot/restart isolados, sem provider real
npm run verify:chat-resilience # falhas, retry, cancelamento e troca de provider/modelo
npm run verify:bot-memory     # conversas, memória, contexto, worker e ponte Electron
npm run verify:client-artifacts # artefatos de validação de cliente e contratos
npm run verify:memory-flow-e2e # fluxo de memória real com OpenAiCompatAdapter (HTTP/SSE local)
npm run recovery:status       # diagnóstico da instalação local
```

`verify:clean-profile` usa uma `TempRoot` própria para APPDATA, dados, logs,
user-data e install root, inicia gateway e Electron reais, e verifica token/
configuração persistidos, roster vazio e teardown sem processos/porta
residuais. O keystore Node atual usa fallback local quando não há keyring
injetado; DPAPI/safeStorage não é afirmado por este gate e fica para a Etapa 3.

Scripts em `scripts/`: `openbot-desktop.cmd` é o launcher operacional; `openbot-desktop.vbs` o inicia sem terminal, usa um log exclusivo por invocação, apaga esse log no sucesso, retém falhas por até 7 dias e mostra o caminho no diálogo de erro. Os demais (`visual-*`, `audit-*`, `patch-process-metrics.cjs`) são forenses/de desenvolvimento e não fazem parte do fluxo de produto.

O pacote local instala atalhos para `wscript.exe`/`OpenBot.vbs`, nunca diretamente para `.cmd`. A instalação gera `Update-OpenBot.cmd <pacote>` e `Rollback-OpenBot.cmd`: cada update quiesce a instância, cria backup de configuração, conversas SQLite, credenciais (`sand-secrets.json` + `.master.key`) e workspaces, mantém a versão anterior e permite rollback manual. Backups ficam em `%LOCALAPPDATA%\OpenBot\backups` por padrão. `OPENBOT_DATA_ROOT` controla dados roaming; `OPENBOT_LOCAL_DATA_ROOT` controla workspaces/runtime. Desinstalação preserva ambos por padrão; purge exige marcador de propriedade e `--yes`.

O Recovery Center local expõe o mesmo estado sem telemetria: `npm run recovery:status`, `recovery:backup`, `recovery:verify -- --backup <pasta>`, `recovery:restore -- --backup <pasta> --yes` e `recovery:diagnostics -- --output <arquivo>`. Restore recusa gateway ativo, valida checksums e cria um backup pré-restauração.

Runbook operacional: [`docs/openbot-recovery-readiness-2026-08-17.md`](docs/openbot-recovery-readiness-2026-08-17.md).

Relatório final de convergência de prontidão: [`docs/openbot-readiness-convergence-2026-08-22.md`](docs/openbot-readiness-convergence-2026-08-22.md).

Comportamento do chat sob falhas: [`docs/chat-provider-resilience.md`](docs/chat-provider-resilience.md).

Requisitos: Node.js ≥ 20 (testado em v22), Windows (keystore DPAPI a partir de T4).

## Fluxo operacional do checkout

### Fase 2 concluída — ambiente prático por bot

> Caminho atual de execução: [bootstrap](src/main.ts) e [driver local](src/execution/runtime/local/driver.ts). O [relatório de agosto](docs/practical-bot-environment-final.md) registra a arquitetura WSL anterior.

- `src/execution/` implementa contratos estritos, workspace Windows confinado e operações `file.list`, `file.read`, `file.write`, `search.files` e `search.text`.
- `process.run` executa processos nativos no host Windows confiável (conta do usuário, ambiente herdado, rede do host, qualquer executável instalado). Pedidos passam por contrato estruturado; a bridge HTTP `/local-exec/*` reutiliza o mesmo parser e broker, sem shell arbitrário.
- O boot aceita roster vazio. Ao criar um bot, `startServer` usa `%LOCALAPPDATA%\OpenBot\workspaces\<agentId>\` (Desktop/Documents/Downloads/Projects) e liga arquivos, busca, browser visual e o runtime local confiável.
- `localToolPermission` é fixo em `always` e `runtimeMode` em `developer` para todos os agentes; não há modo Lite selecionável. Aprovações RPC continuam para brokers injetados.
- O `TurnRunner` publica um card `tool-call` por chamada (`pending` → `running` → `completed`/`failed`) com `result` sanitizado, além do loop tool-result para o provider.
- Cada bot pode descobrir Skills sozinho ou recebê-las pelo seletor `/` e chip nativo do chat. MCP é compartilhado/lazy, mas fica deny-all até configuração e allowlist explícitas por bot.
- Create/customização usam o seletor nativo do Grok Bot (`+` → Create new Bot → View agent settings). Provider/chave ficam só nesse painel. Entries de transcript expõem `toAgent`/`fromAgent`/`fromUser` como objetos (`id`+`name`), o shape que o renderer espera.
- Baseline local consolidado (18/08/2026): suíte serial de 103 arquivos, **1187 pass, 1 skipped, 0 failures**; typecheck, build, resiliência do chat, recuperação SQLite, smoke e desktop E2E verdes. Skills/MCP, WSL live e browser permanecem documentados nos respectivos artefatos.

### Evidências históricas de memória e runtime (18/08/2026)

Os resultados e itens T1–T17 abaixo descrevem aquela revisão. Não são comprovação do checkout atual; comandos e contratos atuais devem ser conferidos nos arquivos correspondentes.

- `verify:bot-memory` concluído com **7 arquivos / 100 testes**, `CLIENT_ARTIFACTS_GREEN`, `BRIDGE_REAL_GREEN` (`logs/bridge-real-verify-eB4r3l/`) e `MEMORY_FLOW_E2E_GREEN` (`logs/memory-flow-e2e-SxUjCk/`).
- `VISUAL_UI_GATE`: `GREEN` (`logs/visual-ui-verify-BaUhGs/`).
- Skills/MCP: **164/164** + core **3/3** + desktop E2E green (`logs/e2e-desktop/run-20260818-221145-126260/`).
- Browser: **17/17**.  
- WSL live: green.

- **T1 (scaffold):** DONE — repo compila, testes verdes, `npm start` abre 127.0.0.1:1340.
- **T2 (contratos + fixtures golden):** DONE — `src/shared/` com todos os types do
  contrato MVP; fixtures authoradas; testes de shape verdes.
- **T3 (gateway HTTP+SSE):** DONE — `src/server/gateway.ts` montado no bootstrap
  (`src/main.ts`): `GET /api/events` (SSE, heartbeat `:ping` 15s, `?channels=`,
  `retry:1000`), `POST /api/<method>` (tabela de rota explícita — 404 método
  desconhecido, 400 JSON inválido, 500/erros como `{ok:false,failure}`), `GET /health`
  `{ok,pid,isBusy,activeAgentId,startedAt}`, `POST /prepare-upgrade`, `GET /avatars/<id>`
  (placeholder SVG), CSRF Host/Origin loopback (403 `{error:csrf}`), gzip (respostas
  grandes com `accept-encoding: gzip`); `/local-exec/*` e `/webauthn/*` → 501. Roteador
  extensível: `gateway.registerHandler(method, fn)` pluga as mesas RPC de T10+.
  Testes de integração HTTP em `test/gateway.integration.test.ts`.
- **T15–T17 (cliente local):** patches aplicados e auditáveis em `client/extracted/`; o gateway local é opt-in por `OPENBOT_LOCAL_GATEWAY=1`, com broker preservado fora do modo local. Updates, autenticação Cursor e telemetria de rede foram neutralizados nos caminhos auditados. O gate T19 de zero-egress do cliente local foi concluído. Navegação deliberada do browser não é zero-egress: ela passa exclusivamente pelo proxy autenticado descrito no [relatório final](docs/practical-bot-environment-final.md).
- **T13/T14 (configuração e roster):** DONE — configuração persistente em `%APPDATA%\\OpenBot\\openbot-config.json`, zero-agent bootstrap, catálogo de modelos, provider/settings e stubs locais registrados no bootstrap.
- **T11 (SQLite transcript):** DONE — `src/store/index.ts` implementa `SqliteTranscriptStore` com `store.db` particionado por agente, WAL, migração idempotente, transcript JSON completo, ledger persistente de `clientNonce`, paginação por cursor e outline. `startServer` injeta o store no runner, fecha-o em `stopServer` e registra as rotas `getAgentTranscriptTail`, `openAgentTail` e `getConversationOutline`. O caminho pode ser sobrescrito por `startServer(..., {storePath})`; o default é `%APPDATA%\\OpenBot\\store.db`.

## Registro histórico — T5 (roteador unificado)

- **T5 (roteador):** DONE — `src/providers/router.ts` com o contrato
  `ProviderChatRequest`/`ProviderStreamEvent`, o acumulador de deltas
  (`DeltaAccumulator` — deltas viram `message` COMPLETA, spec §3.1/§3.2),
  `classifyProviderError` (transiente 429/5xx/rede vs permanente auth/validação),
  `ProviderAdapter` (interface de T6/T7/T8) e `defaultRegistry`.
  Testes em `test/router.test.ts` (21) com adapter fake (`test/mocks/fake-provider-adapter.ts`).

## Registro histórico — T6 (adapter OpenAI + helpers OpenAI-like)

- **T6 (adapter OpenAI):** DONE — `src/providers/openai.ts` + `src/providers/openai-helpers.ts`:
  - `OpenAiAdapter` (contrato `ProviderAdapter`): `chat.completions` com `stream:true`
    + parâmetro `tools`; chave via keystore `reveal` (namespace
    `scoped:v1:provider:openai:apiKey`); emite `delta` (content) e `tool-call`
    (tool_calls acumuladas por índice); respeita `req.signal` (abort encerra o stream);
    erros normalizados para `classifyProviderError` do roteador (401/403 → auth,
    429 → rate-limit, 5xx → server, 400/404/422 → validation).
  - Helpers reusáveis por T7 (xAI) e T8 (OpenAI-compat): `buildChatBody` (system
    inline + tools + max_tokens), `OpenAiToolCallAccumulator` (normalização de
    tool calls), `parseOpenAiSseChunk`/`splitSseLines`/`parseSseLine` (parser de
    SSE da OpenAI com `[DONE]`), `normalizeOpenAiError`/`ApiError`/`OpenAIError`/
    `extractOpenAiErrorMessage` (normalização de erros).
  - Registro no roteador como `"openai"` no boot (`src/main.ts` →
    `registerOpenAiAdapter({ keystore })`); T7/T8 entram na sequência com o mesmo padrão.
  - Mock de provider reusável: `test/mocks/provider-server.ts` (HTTP fake falando
    `chat.completions` SSE — scripts de deltas/tool_calls, SSE bruto de fixture,
    erros com status, validação de Authorization). Fixtures de contrato:
    `test/fixtures/openai-chat-request.json` e `test/fixtures/openai-sse-toolcalls.json`.
  - Testes: `test/providers.test.ts` (34) — paridade contra o mock (deltas e
    tool_calls), chave via keystore, classificação de erros, abort, fixtures.

## Registro histórico — T4 (keystore de providers)

- **T4 (keystore):** DONE — `src/keystore/` com:
  - `sand-secrets.json` em `%APPDATA%\OpenBot\` (namespace `scoped:v1:provider:<name>:apiKey`).
  - Criptografia via `safeStorage.encryptString` (DPAPI Windows). No shim Node puro,
    o safeStorage real é **injetado** pelo main do Electron na integração
    (utilityProcess) — contrato documentado em `src/keystore/backend.ts`
    ("Integração Electron"). Sem keyring → **fallback em memória** (AES-256-GCM,
    chave por processo): nenhum plaintext novo é gravado; registros DPAPI legados
    continuam legíveis via `nodeLegacyBackend` (somente leitura).
  - API `upsert/reveal/delete/list` por provider (`src/keystore/index.ts`).
  - `waitForEncryptedStorage` (espelho do original, spec §3.3).
  - Integração ao gateway no bootstrap (`src/main.ts`):
    `POST /api/setBoxSecrets` (upsert/delete → `{synced, upserted, deleted}`) e
    `POST /api/getBoxSecretsStatus` (`{secrets: string[]}` — **só nomes, nunca
    valores**). Métodos já na `RPC_METHOD_TABLE` (T3).
  - Testes focados de keystore e gateway — round-trip encrypt/decrypt,
    **scan do disco provando que nenhuma chave
    aparece em claro**, fallback em memória (nada gravado), migração legado,
    re-leitura entre sessões, contrato HTTP das duas rotas.
