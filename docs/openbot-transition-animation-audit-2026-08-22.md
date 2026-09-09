# Auditoria de animações de transição — OpenBot

Data: 22/08/2026  
Escopo: `C:\SuperAgent\openbot`  
Cliente: OpenBot 0.1.0 sobre renderer Electron Grok Bot 0.16.0

## Resultado executivo

Foi confirmado um bug de alta prioridade na entrada de mensagens: a animação WAAPI local substituía temporariamente o `transform: translateY(...)` usado pelo transcript virtual para posicionar cada linha. Em uma reprodução com 520 entradas persistidas, a linha nova saiu de `y=142` para `y=8,78` durante o primeiro frame e voltou para a posição correta ao fim dos 280 ms.

A correção foi feita somente em `client/extracted/dist/renderer/assets/openbot-local-settings.js`: os keyframes de `message` agora preservam o `transform` inline da linha virtual. Nenhum chunk, bundle, CSS ou sourcemap proprietário foi editado.

O A/B confirmou a correção geométrica: depois do patch, a mesma linha parte de `y=150,78` (posição-base 142 + entrada intencional de 8 px) e termina em `y=142`. Não houve ganho de performance mensurável; o patch corrige um salto visual determinístico, não uma long task.

## Integridade e método

- Leitura estática de `openbot-local-settings.js`, `index-CqsZ1Ga4.css`, `index-DVUCYGay.js`, gateway/SSE e contrato visual.
- Electron real com CDP, GPU habilitada, provider fake local e data root temporário.
- 520 entradas persistidas em cada um de dois bots longos; a UI resumiu o histórico e montou apenas duas linhas virtuais.
- Cenários: welcome → primeira mensagem, tool-card com aprovação real, seis alternâncias rápidas A/B, stream de 50 deltas a 100 ms com troca de bot e cancelamento, e `prefers-reduced-motion: reduce`.
- Tracing: `devtools.timeline`, `cc`, scheduler, frames, layout, paint e long tasks.
- Harness reproduzível: [`analysis_outputs/transition-audit-2026-08-22/audit-transition-performance.mjs`](../analysis_outputs/transition-audit-2026-08-22/audit-transition-performance.mjs).

## Inventário atual

| Família / seletor | Gatilho | Propriedades | Duração | Curva | Origem |
|---|---|---|---:|---|---|
| `#openbot-welcome` | mount, `.is-ready`, `.is-leaving` | `opacity` | 280 ms | `cubic-bezier(.22,1,.36,1)` | override local |
| `#openbot-welcome .ob-welcome-art` | `.is-ready` | `opacity`, `transform` | 320 ms; ambiente 22 s alternado | curva local; ambiente `.45,.05,.55,.95` | override local |
| `#openbot-welcome .ob-welcome-light` | `.is-ready` | `opacity`, `transform` | ambiente 17 s alternado | `ease-in-out` | override local |
| kicker, título, texto, nota e botão do welcome | `.is-ready` | `opacity`, `transform: translateY` | 260 ms, delays 40–160 ms | `cubic-bezier(.22,1,.36,1)` | override local |
| conteúdo do welcome | `.is-leaving` | `transform` | 220 ms | `cubic-bezier(.4,0,1,1)` | override local |
| `surface`: menus/listboxes, `main.sand-chat`, estado vazio e perfil | nó inserido, observer → rAF | `opacity`, `transform` | 220 ms | `cubic-bezier(.22,1,.36,1)` | `animateOnce` local |
| `panel`: dialogs, settings, details, outline e `.sand-virtual-transcript` | nó inserido, observer → rAF | `opacity`, `transform` | 260 ms | `cubic-bezier(.22,1,.36,1)` | `animateOnce` local |
| `message`: row, card, tool dock/outcome, loading/error | uma raiz nova no mesmo flush | `opacity`, `transform` | 280 ms | `cubic-bezier(.2,.9,.3,1.15)` | `animateOnce` local |
| `status`: `#openbot-status`, `#openbot-profile-status` | nó/status inserido | `opacity`, transform neutro | 180 ms | `cubic-bezier(.22,1,.36,1)` | `animateOnce` local |
| `.sand-transcript-row[data-enter=new]` descendentes | `data-enter=new` nativo | `opacity`, `translateY(12px) scale(.94)` | 240 ms | `cubic-bezier(.23,1,.32,1)` | CSS proprietário, somente leitura |
| variante opacity de `data-enter=new` | `data-enter=new` nativo | `opacity` | 120 ms | padrão do asset | CSS proprietário, somente leitura |
| botões/inputs locais | hover, active, focus, mudança de estado | `transform`, background, border, color | 100–180 ms ou tokens nativos | easing nativo / `.22,1,.36,1` | override local |

O movimento explícito fica abaixo de 400 ms. Os ciclos de 17/22 s do welcome são iluminação/câmera passivas, não feedback de interação. `will-change` está limitado a duas camadas do welcome; não há promoção permanente de dezenas de mensagens. O código local não anima `top`, `left`, `width`, `height` ou margens.

O `MutationObserver` é único e agrupa inserções por `requestAnimationFrame`. Em bursts com mais de uma raiz de mensagem, as raízes são apenas marcadas, sem WAAPI; row+card aninhados colapsam na raiz externa. Isso evita stagger/hidratação em massa.

## Achados

### P1 — confirmado e corrigido: conflito com o transform da virtualização

Evidência estática:

- O renderer proprietário posiciona `.sand-virtual-transcript__row.sand-transcript-row` com `style.transform = translateY(topPx)` em `client/extracted/dist/renderer/assets/index-DVUCYGay.js:1`.
- Antes do patch, `animateOnce` aplicava keyframes `transform` com composição `replace` à mesma `.sand-transcript-row`.

Evidência dinâmica antes:

- inline/base: `translateY(142px)` / `matrix(1,0,0,1,0,142)`;
- durante: `matrix(.97,0,0,.97,0,8)`;
- retângulo: `y=142` → `y=8,78`;
- salto transitório: aproximadamente 133 px para cima.

Relatório e trace: [`report.json`](../logs/transition-audit/before-2026-08-22T04-33-36-962Z/report.json) e [`long-stream-background-switch-abort.trace.json.gz`](../logs/transition-audit/before-2026-08-22T04-33-36-962Z/long-stream-background-switch-abort.trace.json.gz).

### P2 — confirmado e corrigido no gate: asserção visual obsoleta

O gate exigia `Abrir no Explorer`, mas o contrato atual e o teste estático exigem `Abrir Documents` e `Abrir Projects`. A asserção em `scripts/visual-ui-verify.mjs` foi alinhada sem mudar a UI. Com gateway autenticado e isolado, o gate passou por settings, resize, focus, reduced motion, memória e idle.

### Confirmado sem patch: SSE não reanima a entry a cada `updated`

O backend publica uma entry nova como `appended` e substituições/streaming como `updated` (`src/rpc/send.ts`). O override não lê SSE nem streaming flag: ele reage a raízes DOM novas e usa `WeakSet`/`data-openbot-motion-runs`.

No stream instrumentado houve uma chamada `message` para a nova row, enquanto foram observadas 26 mutações de texto. Os deltas seguintes atualizaram o conteúdo sem repetir a entrada da mesma raiz. Tool-call usa `updated` ao trocar de estado; uma nova raiz visual ainda pode receber uma entrada única quando o renderer a substitui.

### Confirmado sem patch: lista longa e alternância de bot são limitadas

Após seis alternâncias rápidas entre dois bots com 520 entradas persistidas cada:

- histórico resumido pela UI: 500 entradas antigas;
- rows montadas: 2;
- rows de mensagem animadas na hidratação: 0;
- animações ativas ao estabilizar: 0;
- nenhuma animação de 500 nós e nenhum stagger.

O trace da alternância teve 0 long tasks; maior task 18,46 ms.

### Confirmado sem patch: estado por bot e cancelamento

Durante o stream de A, ao abrir B:

- A: `isBusy=true`, `canCancel=true`;
- B: `isBusy=false`, `canCancel=false`;
- stop control em B: oculto, `activeAgent=audit-long-b`, `busyAgents=audit-long-a`.

Ao voltar para A, o stop control foi clicado e o stream foi cancelado. Não houve reset nem duplicação do busy state do bot de fundo.

### Design intencional — não mexer

- Mensagem em 280 ms e mola leve são contrato explícito de `docs/openbot-visual-parity-grokbot-2026-08-19.md`; a mola continua exclusiva de `MOTION.message`.
- O welcome usa delays curtos e ambiente lento somente no plano de fundo; `prefers-reduced-motion` remove ambos.
- O CSS proprietário também anima descendentes de rows novas em 240/120 ms. Não houve evidência numérica de que essa composição seja um defeito, e removê-la mudaria o shell nativo.

## A/B do patch

| Métrica — stream longo, lista grande, troca e abort | Antes | Depois |
|---|---:|---:|
| posição-base da row | 142 px | 142 px |
| posição no primeiro rAF da entrada | 8,78 px | 150,78 px |
| keyframe inicial | somente `translateY(8px) scale(.97)` | `translateY(142px) translateY(8px) scale(.97)` |
| wall time | 4.739,25 ms | 4.656,37 ms |
| long tasks ≥ 50 ms | 0 | 0 |
| maior task | 20,55 ms | 40,34 ms |
| layouts / duração total | 984 / 192,13 ms | 969 / 202,09 ms |
| paint total | 126,74 ms | 145,12 ms |
| `DroppedFrame` / `FrameDropped` no trace | 88 / 0 | 94 / 0 |
| gaps rAF > 34 ms / máximo | 2 / 94,50 ms | 3 / 102,70 ms |

Conclusão: os números de CPU/frame estão no ruído entre execuções e não mostram ganho de throughput. A correção é mantida porque restaura um invariante geométrico exato: a animação não pode apagar a posição virtual da row. Em ambos os lados houve zero long task; nenhuma melhora de FPS é alegada.

Depois do patch, os cinco cenários também ficaram sem long tasks:

| Cenário | Wall | Maior task | Layout | Paint |
|---|---:|---:|---:|---:|
| welcome → primeira mensagem | 1.189,98 ms | 27,74 ms | 142 / 27,89 ms | 20,06 ms |
| tool-card | 1.173,64 ms | 9,26 ms | 255 / 50,79 ms | 30,00 ms |
| alternância rápida | 2.736,73 ms | 18,46 ms | 296 / 45,81 ms | 45,91 ms |
| stream + background + abort | 4.656,37 ms | 40,34 ms | 969 / 202,09 ms | 145,12 ms |
| reduced motion | 828,31 ms | 15,21 ms | 21 / 3,87 ms | 7,48 ms |

Evidência depois: [`report.json`](../logs/transition-audit/after-2026-08-22T04-34-49-503Z/report.json) e [`long-stream-background-switch-abort.trace.json.gz`](../logs/transition-audit/after-2026-08-22T04-34-49-503Z/long-stream-background-switch-abort.trace.json.gz).

Screenshots de estado estabilizado: [antes](../logs/transition-audit/before-2026-08-22T04-33-36-962Z/long-stream-after-abort.png) e [depois](../logs/transition-audit/after-2026-08-22T04-34-49-503Z/long-stream-after-abort.png). O frame transitório não é legível numa captura final; sua posição foi capturada no primeiro rAF pelo relatório CDP.

## Patch aplicado

Em `animateOnce`, somente para `kind === "message"`:

1. lê o `element.style.transform` da row virtual;
2. prefixa esse transform no keyframe inicial;
3. usa o mesmo transform como keyframe final;
4. mantém duração, curva, opacity, target, dedupe, observer e reduced motion.

SHA-256 do override: `150d02c6fb13749fc39c8bc75801fcbe6ba1423458757cc5cb82efd2dbfa7ab8`. Os dois registros correspondentes no manifesto foram atualizados. Um teste estático trava a composição com o transform-base.

## Não corrigido

Nenhum bug de animação confirmado ficou pendente por exigir edição de chunk proprietário.

Observações deliberadamente não alteradas:

- A virtualização, medição de altura e scroll continuam em `index-DVUCYGay.js`. O trace mostra layout durante streaming, mas não prova reflow integral nem long task. Otimizar isso exigiria instrumentação/alteração do virtualizer proprietário; hook mínimo futuro: expor `entryId`, tipo `appended|updated` e custo da recomputação no DOM/bridge, sem tentar inferir SSE pelo overlay.
- As animações nativas de 240/120 ms permanecem no CSS proprietário. Se um futuro A/B confirmar composição excessiva, o hook local mínimo seria uma regra injetada extremamente específica para os descendentes de `.sand-transcript-row[data-enter=new]`, sem editar o asset.
- O E2E desktop canônico falhou duas vezes antes do patch porque o renderer exibiu apenas o primeiro prefixo e não `E2E incremental stream`, embora o fixture estivesse `STREAMING`, com 3 chunks e 1 stream ativo. Evidências: [`run 1`](../logs/e2e-desktop/run-20260822-011628-82732/cdp-report.json) e [`run 2`](../logs/e2e-desktop/run-20260822-011707-89440/cdp-report.json). Isso ocorre antes da checagem de motion/cancel e não foi localizado como bug de animação; não foi corrigido por esta auditoria.

## Validação

- `npm run typecheck && npm run build`: GREEN.
- `npm run verify:visual-ui`: GREEN com gateway/data root isolados; client artifacts 11 checks GREEN. Avisos existentes: sourcemaps obsoletos de main/preload retidos sem referência runtime.
- Vitest obrigatório: 2 arquivos, 11 testes GREEN.
- Regressão adicional `test/electron-windows-patches.test.ts`: 19 testes GREEN.
- Auditoria CDP depois: GREEN; teardown confirmou processo encerrado e data root temporário removido.

## Limitações

- O provider foi fake e local para tornar stream/abort determinísticos; não mede latência de rede ou provider real.
- A UI resume as 500 entradas antigas e monta duas rows. O ensaio valida a hidratação virtual observada, não a renderização simultânea de 500 nós — comportamento que o produto procura evitar.
- `DroppedFrame` e `FrameDropped` são nomes distintos de eventos do trace Chromium. Os contadores foram reportados literalmente; não se interpreta `DroppedFrame=94` como 94 frames visivelmente perdidos, sobretudo com `FrameDropped=0`.
- Gaps de rAF incluem troca de bot, IPC, captura e tracing; não isolam somente a animação.
- Screenshots registram o estado final. O salto transitório foi provado por `computedStyle` e `getBoundingClientRect` no primeiro rAF, não por avaliação subjetiva.
- O CSS proprietário é minificado em uma linha; seletores/keyframes foram extraídos estaticamente, mas não foram editados.
