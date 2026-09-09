# OpenBot — aceite da tela de boas-vindas

Data: 16/08/2026

## Resultado

A tela de entrada de cada nova abertura está implementada e validada no Electron real. Ela apresenta o OpenBot antes da lista de bots, usa arte renascentista original, animação suave e um único caminho de avanço pelo botão **Continuar**.

## Comportamento fechado

- aparece uma vez por nova janela do aplicativo;
- salva a conclusão apenas na sessão da janela em `openbot.welcome.completed.session.v1`;
- reaparece em cada nova abertura do aplicativo, sem reaparecer em recargas internas da mesma janela;
- bloqueia interação com o app ao fundo usando `inert` e restaura o app ao sair;
- mantém **Continuar** disponível ao teclado sem exibir aro de foco automático; o aro aparece quando a navegação por `Tab` começa;
- respeita `prefers-reduced-motion`;
- mantém layout responsivo e alvo de interação de 44 px;
- desaparece com fade e leve escala antes de revelar a tela existente dos bots.

## Refino visual

- título em Cambria regular, com desenho mais leve que a versão anterior em Georgia;
- textos auxiliares suavizados em Segoe UI Variable;
- dourado reduzido a um detalhe champanhe discreto;
- movimento ambiente em dois planos: câmera lenta de 22 s na arte e luz de 17 s;
- conteúdo central estável após a entrada;
- animações limitadas a `transform` e `opacity`, com alternativa estática em `prefers-reduced-motion`;
- ações primárias próprias do OpenBot usam somente preto, cinza e branco, sem o antigo azul de accent.

## Arte

- Asset: `client/extracted/dist/renderer/assets/openbot-welcome-renaissance.png`
- Dimensões: 1672 × 941
- SHA-256: `0386BD09883B79E380A83D14C8E71B2F02ED431AC5B85C15B299D8A6D1134CEA`
- Origem: ImageGen integrado, composição original inspirada no Renascimento; nenhum texto, logo ou cópia direta de obra existente.

Prompt final usado:

> Use case: historical-scene. Asset type: full-window background for a premium dark Electron desktop app welcome screen. Create an original Renaissance-inspired painting suggesting the meeting of humanism and artificial intelligence, set in a refined Florentine studiolo at dusk. Grand but intimate Renaissance study with arches, dark walnut shelves, celestial instruments, manuscripts, a subtle brass automaton and a thoughtful humanist scholar, distant Tuscan twilight through a window. Museum-quality oil painting inspired by the visual language of the High Renaissance, original composition, aged varnish texture, realistic chiaroscuro, not a copy of any existing artwork. Wide 16:9 cinematic landscape; keep the center and lower-center visually calm and dark for overlay text and a button; place detailed figures and objects mostly toward the left and right thirds; no hard focal point directly behind the center. Restrained golden candlelight against deep umber, charcoal and muted ultramarine; contemplative, intelligent, timeless, welcoming rather than religious or ominous. No text, letters, logos, watermark, UI elements, frame, modern electronics, obvious robot face or crowded center; must remain readable when darkened with a 55% black overlay. Avoid kitsch, fantasy glow, steampunk excess, sci-fi neon, direct imitation of a named painting, distorted anatomy, extra fingers and illegible writing.

## Evidências

| Gate | Resultado |
|---|---|
| `node --check client/extracted/dist/renderer/assets/openbot-local-settings.js` | GREEN |
| teste focado `electron-windows-patches` | GREEN — 14/14 |
| `npm run typecheck` | GREEN |
| `node scripts/visual-ui-verify.mjs` | GREEN — asset carregado, diálogo/foco/inert/persistência confirmados |
| `npm run verify:e2e:desktop` | GREEN — build, reload, chat, cancelamento, Skills e cleanup |

Evidência E2E: `logs/e2e-desktop/run-20260816-201951-22772`.

Capturas visuais: `logs/visual-ui-verify-8OuGu0/visual-welcome.png` e `logs/visual-ui-verify-8OuGu0/visual-settings-initial.png`.

## Observação

O verificador visual isolado não iniciou o gateway local na porta 1340 e, por isso, registrou mensagens esperadas de conexão recusada nas rotinas posteriores de settings. Isso não afetou o gate da tela de entrada. O E2E desktop completo, que inicia seu fixture e gateway próprios, terminou GREEN.
