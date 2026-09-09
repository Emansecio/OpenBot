# OpenBot — paridade visual consciente com Grok Bot

**Data da observação:** 19/08/2026  
**Fonte oficial observada:** `https://x.ai/bot` (landing Early Beta, download Windows 0.18.0)  
**Fonte local:** overlay OpenBot + shell Electron herdada 0.16.0, Windows-only  
**Modo:** especificação de design. Nada disto foi implementado por este documento.

Este texto não é um pedido para clonar o Grok Bot 0.18. É um mapa do que *parece* o produto oficial, o que o OpenBot já é, e o que um implementador pode aplicar sem mentir sobre o nosso runtime.

O alvo é o desktop Windows que o OpenBot já é. Peças da landing que só existem como chrome de outro sistema, ou como produto que não temos, não entram nem como recusa longa: ficam de fora.

---

## 0. Como usar este documento

### Quem é o leitor

Um implementador (humano ou modelo) que vai mexer no overlay visual. Você não precisa reabrir o site para decidir. Você precisa saber **o que copiar, o que adaptar e o que recusar**.

### O que você deve conseguir fazer depois de ler

1. Distinguir “linguagem visual” de “funcionalidade de produto”.
2. Aplicar **só o P1** sem reabrir Computer, rotinas ou o cliente 0.18.
3. Explicar por que a tela do bot **não** entra no escopo.
4. Recusar um pedido do tipo “deixa igual ao site” quando o pedido exige dado que o OpenBot não tem.

### Regras para o implementador

- OpenBot é **outro produto**. Identidade local, Windows-only, gateway próprio, sem cloud computer.
- A UI nativa é um **renderer pré-compilado 0.16.0**. Não reconstrua o React, não patch chunks minificados, não atualize o cliente para 0.18 “para ficar igual”.
- Superfície permitida neste ciclo: só `openbot-local-settings.js`. Não mexa em `openbot-memory-ui.js` por paridade.
- Seletores estáveis: `sand-*`, papéis ARIA, IDs `openbot-*`. Não use classe StyleX minificada como contrato.
- Anime só `opacity` e `transform`. Respeite `prefers-reduced-motion`.
- Não invente widget, kind de transcript, RPC ou payload para parecer 0.18.
- Computer, Plugins e Log out **já são ocultados de propósito**. Não os reabra por estética. Não edite `hideChrome` por paridade visual.
- Welcome do OpenBot (arte própria, câmera lenta) **não** deve ser trocado pelo fade de 1 s da landing.
- `MOTION_EASING` (`.22,1,.36,1`) é o easing **global**. A mola do site é só de mensagem. Não troque a constante global.
- Depois de editar o overlay, atualize o manifesto de artefatos do cliente. Sem hash novo, o patch não existe.

### Como achar o código

| Procurar por | Onde mora a ideia |
|---|---|
| `MOTION` / `MOTION_EASING` / `animateOnce` / `flushMotionQueue` | Contrato de entrada do overlay |
| `MESSAGE_SELECTOR` / `queueSemanticMotion` | O que conta como mensagem vs painel |
| `hideChrome` / `hideLegacyScreenPane` | Computer e chrome legado ficam fora |
| `#openbot-welcome` / `ob-welcome-*` | Tela de entrada do OpenBot (não copiar da landing) |
| `client-artifacts.manifest.json` | Hash do overlay; qualquer CSS/JS visual passa por aqui |

---

## 1. O que foi comparado

A página `https://x.ai/bot` **não é o app**. É marketing. O “chat” do hero é um mock interativo (`baby-grok-bot`): troca de bot, composer somente leitura, painel Computer de mentira, rotinas de mentira, trailer e preços.

Do mock, só entra neste ciclo o que o overlay já anima sem mentir o produto:

1. Mensagens que entram com um pop curto (sobe + escala + mola) — **P1**.
2. Bolhas, card de ferramenta e composer nativos **já existem** no 0.16. Não redesenhar.

O OpenBot, no mesmo olhar:

- shell 0.16.0 (`sand-chat`, `sand-transcript-row`, `sand-message-card`);
- overlay local (welcome, perfil, settings, memória, retry, stop, motion 180–260 ms);
- runtime real: WSL Developer, browser Electron, Skills/MCP, transcripts SQLite;
- **sem** desktop remoto do bot e **sem** rotinas de produto.

A diferença grande não é “falta polimento”. É **produto diferente** usando uma família visual parecida (Cursor dark + easing `.22,1,.36,1`).

---

## 2. Fronteiras duras — não copiar

Estes itens existem no site e **não** devem ser reproduzidos no OpenBot. Não são atraso de UI. São mentira de produto se forem pintados sem o sistema por trás.

### 2.1 Tela / Computer / VNC

O mock tem “Open computer”, screenshot do desktop do bot, cursor andando na tela e pane “Chief’s screen”.

No OpenBot isso é contrato congelado: `getForeverBoxStatus` devolve `{ vncUrl: null, windows: [] }`. O overlay esconde o botão Computer e qualquer pane legado de “screen”.

**Não faça:** reexibir Computer, inventar um frame com wallpaper, simular “tela do bot”, animar cursor sobre um preview, ou usar a home NTFS/WSL como se fosse VNC.

O usuário local já tem workspace e, quando fizer sentido, um **browser Electron separado**. Isso não é o painel Computer da landing. Não misture os dois.

### 2.2 Routines como produto

O mock mostra “Created routine Overnight outbound” e uma lista “Weekdays at 8:00 AM”. OpenBot não tem agendador de rotinas na UI do chat.

**Não faça:** chip “Created routine”, lista de horários, ou ícone de relógio fingindo schedule.

### 2.3 Colaboração multi-bot no mesmo fio

O mock injeta “Messages from Account Manager and Chief” no transcript do Sales Outbound. OpenBot tem roster multi-agente e conversas **separadas**. Bots não passam recado visualmente no mesmo fio.

**Não faça:** cartão “messages from” sintético. Se um dia existir handoff real no transcript, estilize o kind que já veio do gateway — não invente o kind no overlay.

### 2.4 Apps de marketing no transcript

O transcript da landing tem Salesforce/Hex/LinkedIn como se fossem apps nativos.

Tools reais do OpenBot são as do broker local, Skills e MCP do usuário.

**Não faça:** cards de apps que não existem, checklist de “52 accounts” de demo.

### 2.5 Identidade e welcome

A landing é “Meet Grok Bot” / SpaceXAI. O welcome OpenBot é marca própria (renascimento, Cambria, champanhe discreto, câmera 22 s). Isso já foi aceito.

**Não faça:** trocar o welcome por um fade de 1 s da landing, nem reintroduzir wordmark Grok.

### 2.6 Subir o cliente para 0.18

O download oficial é 0.18.0 hospedado pela Cursor. OpenBot está amarrado ao extrato 0.16.0 + shim local. Trazer o 0.18 quebra o contrato do gateway, os hashes e a estratégia “UI não sabe que o backend mudou”.

**Não faça:** extrair o setup 0.18 para “ficar igual”.

---

## 3. Linguagem visual que podemos tomar emprestada

Isto é o que o site faz bem **sem** exigir Computer, rotinas ou 0.18. Neste ciclo, só o motion de mensagem entra no overlay.

### 3.1 Movimento (o ganho mais barato e mais honesto)

Medido no mock ao vivo:

| Token | Landing 0.18 | OpenBot hoje | Decisão |
|---|---|---|---|
| Easing de montagem | `cubic-bezier(0.22, 1, 0.36, 1)` | o mesmo (`MOTION_EASING`) | **manter** |
| Entrada de mensagem | 280 ms, `translateY(8px) scale(0.97)`, mola `cubic-bezier(0.2, 0.9, 0.3, 1.15)` | 200 ms, só `translateY(6px)`, sem mola | **aproximar** (P1) |
| Mensagem “fresh” | 420 ms, mesma curva | não distingue | **não fazer** — 420 ms piora snapshot/troca |
| Painel | 260 ms em cards | `panel` 260 ms | **manter** — `verify:visual-ui` trava 260 / 1 run |
| Surface / menu | hover 120 ms em cor | `surface` 220 ms | **manter** |
| Status / working | typing 1.3 s; spinner 2.4 s; check `scale(.4→1)` | `status` 180 ms; retry/stop **fora** do WAAPI | **manter** — `queueSemanticMotion` já ignora retry/stop |
| Welcome | fade 1000 ms | câmera 22 s + luz 17 s + stagger 260 ms | **não alinhar** — welcome é OpenBot |
| Reduced motion | desliga enter, typing, mount | `animateOnce` já no-op em todo kind | **manter** — o token novo de mensagem passa pelo mesmo `motionReduced()`; não acrescente CSS no transcript nativo |

Regra da mola: o `1.15` no bezier dá um overshoot leve. Use **somente** em `MOTION.message`, com um campo `easing` próprio. `animateOnce` hoje aplica `MOTION_EASING` a todos os kinds — o P1 precisa ler `config.easing || MOTION_EASING`. Se você alterar a constante global, settings, menus, welcome e o teste que trava `MOTION_EASING` destoam juntos.

Não anime `width`, `height`, `top`, `left`, `padding`, `font-size`, `line-height`, `box-shadow` ou `filter`. Transcript nativo é virtualizado (`.sand-virtual-transcript`): mudar caixa ou tipo nas linhas faz a lista pular.

### 3.2 Matéria do chat (sem mentir o dado)

O 0.16 **já** desenha bolha, card de ferramenta e composer. Pintar por cima destoa: StyleX ganha do CSS do overlay, o transcript é virtualizado, e não há seletor estável usuário vs assistente.

Não use o creme da landing. Não force tracking, 13/14 px, nem raio novo nas linhas nativas. Superfícies OpenBot (welcome, settings, retry, memória) já usam `--cursor-*` — deixe assim.

### 3.3 Cor e tipo — copiar o sistema, não a marca

O mock `cursor-dark` usa a mesma família que o overlay já consome (`--cursor-*`):

- fundo e texto já vêm de `--cursor-*` no overlay — **manter**;
- sucesso / aviso / perigo já existem (`--cursor-green`, danger);
- cores hex da landing (creme de bolha, accent `#64b5ff`) **não** se copiam.

OpenBot já decidiu: ações primárias **nossas** são preto / cinza / branco, sem o azul antigo. Mantenha isso no welcome, retry, save, stop.

Tint por agente (ciano no Chief, etc.) é 0.18. **Não invente** paleta por nome de bot.

### 3.4 Microinteração já alinhada

- `:active { transform: scale(.96) }` nos botões locais — manter.
- Foco visível de 2 px já existe no overlay. Não troque por ouro da landing.
- Não pinte hover no roster nativo. Seletor instável.

---

## 4. Estado atual, em uma frase por superfície

| Superfície | Está “de acordo”? | Por quê |
|---|---|---|
| Família de easing | Sim | Mesmo `.22,1,.36,1` de montagem |
| Entrada de mensagem | Não | Mais curta, sem scale, sem mola |
| Welcome | Melhor que o site, e diferente | Marca OpenBot; não compete com o mock |
| Settings / memória / retry | Nosso, coerente | Tokens Cursor + motion local |
| Bolhas e composer nativos | Não é 0.18 | Shell 0.16; **não pintar** neste ciclo |
| Computer / routines | Propositalmente ausentes | Contrato local, não falta de CSS |

“Não está de acordo com o site” é o resultado certo nas linhas de produto. O único débito visual **deste ciclo** é a entrada de mensagem (P1).

---

## 5. O que aplicar

Neste ciclo só existe **P1**. Arquivo único: `openbot-local-settings.js`.

### P1 — Mensagem com o ritmo do mock

**Fazer:**

```js
message: {
  duration: 280,
  from: "translate3d(0,8px,0) scale(.97)",
  easing: "cubic-bezier(.2,.9,.3,1.15)",
}
```

Em `animateOnce`, a duração e o `from` já vêm de `config`. Passe também `easing: config.easing || MOTION_EASING`. Não altere a constante `MOTION_EASING` nem os kinds `surface` / `panel` / `status`.

**Burst = snapshot de raízes, não de nós aninhados.** `collectMotionTargets` enfileira o nó **e** cada descendente que casa `MESSAGE_SELECTOR`. Uma linha viva costuma ser `.sand-transcript-row` **com** `.sand-message-card` (ou loading) dentro. Contar nós crus trata append ao vivo como snapshot e o pop nunca roda. O E2E (`cdp-check.mjs`) exige `runs === "1"` nessa raiz.

Antes de contar, colapse para a raiz mais externa: se um alvo `message` está dentro de outro alvo `message` do mesmo flush, ignore o interno. Depois:

- **mais de uma raiz** no frame: não chame `animateOnce` (só WeakSet) — troca/snapshot;
- **uma raiz**: anime essa raiz — append ao vivo.

Não invente `data-fresh`, não leia SSE no overlay, não use timer. Não escreva teste do tipo “quaisquer dois alvos `message` pulam WAAPI” — isso trava o bug do aninhamento.

`queueSemanticMotion` já ignora `#openbot-stop-turn` e `.ob-retry-generation`. **Deixe assim.** Retry só tem `:active { scale(.96) }` em CSS.

**Não fazer:** mola em settings, welcome, menus ou Computer. Segundo observer. Typewriter. `transition:all` (teste estático proíbe). Mexer no `visual-ui-verify` que trava settings `panel` / `260`.

**Prova (três lugares, não um):**

1. Vitest `adds bounded, reduced-motion-safe entrance polish…`: `message` passa a 280 + `from` com scale + easing próprio. `MOTION_EASING` global **não** muda. Burst: duas **raízes** `message` no mesmo flush não geram WAAPI; row+card aninhados **geram uma**.
2. `test/e2e-desktop/cdp-check.mjs`: a checagem incremental hoje exige `duration === "200"`. Troque para `"280"`. `kind === "message"` e `runs === "1"` ficam. Sem isso o E2E fica vermelho — a duração **é** contrato visível no DOM (`data-openbot-motion-duration`).
3. `client/client-artifacts.manifest.json`: o overlay tem **dois** sha256 (`artifacts.rendererInjected` e `renderer.requiredAssets`). Atualize os dois. `scripts/verify-client-artifacts.mjs` só verifica; não tem `--write`.

`verify:visual-ui` (settings `panel` 260 / 1 run) não muda. RPC/SSE/persistência não mudam.

### Fora da fila (recusar com este documento)

- Pintar bolha / card / composer nativos
- Check WAAPI no retry ou mudança de `MOTION.status`
- Preview de tela / Computer / “Open screen”
- Routines e “Created routine”
- Upgrade do asar para 0.18
- Typing dots por cima do indicador nativo
- Animação contínua em idle
- Qualquer edição em `openbot-memory-ui.js` por paridade

---

## 6. Como o P1 “passa”

1. Mudaram só: `openbot-local-settings.js`, o teste estático de motion, `cdp-check.mjs` (`200` → `280`), e os **dois** sha256 do overlay no manifesto.
2. `prefers-reduced-motion: reduce` não cria a animação nova.
3. Computer, Plugins e Log out continuam ocultos. `hideChrome` não foi “melhorado”.
4. Welcome continua o OpenBot, não o fade da landing.
5. O teste `electron-windows-patches` cobre `message` 280 + easing próprio + burst por **raiz**, e **ainda** exige `MOTION_EASING` global inalterado.
6. E2E desktop de chat / cancel / retry continua verde com duração incremental `280`. RPC/SSE/persistência não mudam.
7. `verify:visual-ui` continua verde com settings `panel` / duração `260` / 1 run.
8. Em idle, zero animação WAAPI OpenBot rodando.

Não use “parece o print do site” como aceite. O aceite é: *a mensagem que acaba de entrar no fio aberto tem o pop do mock; o resto do app não mudou de cara nem de contrato.*

---

## 7. Relação com o motion já especificado

O design de 18/08/2026 (`docs/superpowers/specs/2026-08-18-desktop-motion-polish-design.md`) travou:

- `message` 200 ms, só translateY 6 px;
- easing único `.22,1,.36,1`;
- sem segundo observer;
- sem exit em superfície nativa.

Este documento **não cancela** essa infra. Ele atualiza o *alvo* de `message` (e só de `message`) para o ritmo medido no site, com easing **no kind**, não na constante global, e com skip de burst no flush. Surface, panel, status, welcome, observer único, WeakSet e reduced-motion continuam iguais.

Se um teste ainda exigir 200 ms em mensagem, o teste descreve o contrato antigo. Mude essa asserção junto com o P1, não a de `MOTION_EASING`.

---

## 8. Resumo para decisão rápida

| Pedido | Resposta |
|---|---|
| “Deixa o chat com a mesma fluidez do x.ai/bot” | Sim: só P1 (mensagem 280 ms + mola no kind + skip de burst). |
| “Pinta as bolhas / composer iguais ao site” | Não neste ciclo. StyleX + lista virtualizada. |
| “Quero ver a tela do bot igual ao site” | Não. Contrato local: Computer inerte e oculto. Workspace/browser não são VNC. |
| “Cria rotina / chip Overnight outbound” | Não. Não há produto de rotina. |
| “Sobe para o 0.18” | Não. Cliente 0.16 + shim é a arquitetura. |
| “O welcome deveria ser o fade deles” | Não. Welcome é marca OpenBot. |
| “Pinta Salesforce/Hex no transcript” | Não. Estilize tools reais, não apps de marketing. |

A paridade honesta deste ciclo é: **mesmo escuro, mesmo easing global, mensagem ao vivo com o pop do 0.18**. Bolha, composer e cards nativos ficam como o 0.16 os desenha. Computador remoto, agenda e cliente novo ficam de fora — de propósito.
