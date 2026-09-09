# OpenBot — aceite 100/100 dos três pilares

**Data:** 16/08/2026  
**Escopo:** chat/providers/persistência, lifecycle dos bots e navegação web visual.

## Resultado

Os três pilares atingiram **100/100 dentro dos critérios técnicos definidos neste documento**. Isso não significa 100/100 do produto inteiro: Skills/MCP, runtime WSL, segurança global e distribuição continuam avaliados separadamente.

| Pilar | Nota | Gate principal |
|---|---:|---|
| Chat, providers e persistência | 100/100 | `npm run verify:core:acceptance` |
| Lifecycle dos bots | 100/100 | suíte serial + `npm run verify:acl:live` + `npm run verify:e2e:desktop` |
| Navegação web visual | 100/100 | `npm run verify:e2e:browser` |

## 1. Chat, providers e persistência

O gate usa somente uma instância ativa do `startServer` de produção por vez e estado temporário. Ele valida roster inicialmente vazio, criação do primeiro bot, Name/Title/Description independentes, provider/modelo/baseURL/chave, streaming intermediário, retry sem duplicação, cancelamento com abort observado e zero chunks posteriores, transcript final único, nonce e restart. A chave não pode aparecer no request do provider, transcript ou artefatos temporários.

## 2. Lifecycle dos bots

Foram fechadas as seguintes bordas:

- create/duplicate compensam falha de commit e colocam somente homes recém-criadas em quarentena;
- home preexistente e dados do usuário são preservados;
- ACL Windows falha fechado em create/restore/import/repair;
- restore/import/repair/export drenam o browser dentro do fence e sempre liberam o fence;
- shutdown tenta todos os cleanups mesmo quando o abort falha;
- delete com falha após limpar SQLite restaura transcript, nonces, interaction decisions e activity antes de reativar config/home;
- o runner desktop distingue filhos reais de processos preexistentes com PID reutilizado e recolhe filhos que nascem durante o teardown.

## 3. Browser visual

Foram corrigidas aquisição concorrente de lease, lease stale após queda do host, close/release sob timeout e as corridas teardown versus aquisição/operação delegada. O E2E real cobre open/navigate, snapshot/texto, click/type, screenshots viewport/full-page, upload, download/evento, handoff e dois bots com partições/armazenamento/Downloads isolados.

O gate também executa negativos de proxy/SSRF/esquema, permissões, popup/webview, limites e hardlink. Durante o aceite foi reproduzido um diálogo `A JavaScript error occurred in the main process` causado por acesso a `window.webContents` depois de a janela ser destruída. O callback passou a usar o ID capturado antes do fechamento. Handlers fail-fast de `uncaughtException`/`unhandledRejection` agora encerram o host com erro controlado e impedem o diálogo nativo bloqueante; uma injeção disponível somente em teste prova esse contrato.

## Evidência final

- `npm run typecheck`: GREEN;
- `npm run build`: GREEN;
- suíte serial revalidada após os pilares seguintes: **81 arquivos**, **806 aprovados**, **1 ignorado condicionalmente**;
- `npm run verify:core:acceptance`: **3/3**;
- `npm run verify:acl:live`: **6/6**;
- `npm run verify:e2e:browser`: **10/10**;
- `npm run verify:e2e:desktop`: `status=GREEN`, `ownedProcessesAbsent=true`, `portsFree=true`, `cleanup=temp-root-removed`;
- `npm audit --omit=dev`: **0 vulnerabilidades**.

## Limite da nota

O 100/100 representa ausência de pendência relevante nos critérios técnicos reproduzíveis desses três pilares. Disponibilidade de providers comerciais, comportamento de sites externos e uso prolongado continuam sendo validações operacionais, não lacunas desses gates determinísticos.

Skills/MCP e Runtime/WSL foram fechados posteriormente em [aceite próprio](openbot-skills-mcp-runtime-100-acceptance-2026-08-16.md).
