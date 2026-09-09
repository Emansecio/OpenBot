# OpenBot Welcome Screen Design

## Objetivo

Apresentar o OpenBot no primeiro acesso com uma entrada breve e premium antes da lista de bots, sem alterar a navegação principal nem o runtime.

## Experiência

- Tela modal em janela cheia sobre o renderer atual.
- Arte original de inspiração renascentista, escurecida para preservar contraste.
- Texto central curto: boas-vindas, posicionamento como alternativa local ao GrokBot e controle do usuário sobre bots, modelos e workspaces.
- Um único botão primário, **Continuar**.
- Título em Cambria, peso regular, com texto auxiliar em Segoe UI Variable e paleta marfim/champanhe de baixo contraste cromático.
- Entrada com fade e elementos escalonados; depois do assentamento, somente a arte e uma camada de luz mantêm movimento lento e contínuo. O conteúdo permanece estável.
- Botões próprios do OpenBot usam escala neutra preto/cinza/branco; azul de destaque não faz parte desta linguagem visual.
- Movimento reduzido respeita `prefers-reduced-motion`.

## Frequência por abertura

O aceite é salvo somente na sessão da janela Electron, em `sessionStorage`, na chave `openbot.welcome.completed.session.v1`. Assim, a tela aparece em cada nova abertura do aplicativo, mas não volta durante recargas internas da mesma janela.

## Acessibilidade

- `role="dialog"`, `aria-modal="true"` e título associado.
- O diálogo recebe foco sem desenhar um aro automático no botão. Ao navegar com `Tab`, o foco do botão torna-se visível.
- Conteúdo principal fica `inert` enquanto a entrada está aberta.
- Botão com alvo mínimo de 44 px, foco visível e contraste alto.

## Integração

A implementação permanece em `openbot-local-settings.js`, o ponto de extensão já usado pelo OpenBot, sem reescrever o bundle extraído. O asset fica no diretório de assets do renderer e é servido pela CSP existente.

## Arte

Gerada com o ImageGen integrado a partir de uma composição original: studiolo florentino ao entardecer, humanista e autômato de latão nas laterais, centro visualmente calmo, chiaroscuro e sem texto, logotipos ou cópia de obra existente.
