# Perfil local e Settings — design

## Objetivo

Corrigir quatro falhas do desktop OpenBot:

1. nome do perfil local não persiste no gateway;
2. perfil local não oferece aparência equivalente à de bots;
3. Help Center, Send Feedback e Updates aparecem sem implementação;
4. Settings nasce fora do centro porque animação customizada sobrescreve seu `transform`.

## Causas

- `openbot-local-settings.js` grava nome apenas em `localStorage`; `OpenBotConfig.profile` continua com valor legado.
- card customizado do perfil contém somente input de nome.
- sanitização de chrome não reconhece itens indisponíveis.
- animação `panel` aplica `transform` próprio sobre painel centralizado pelo cliente.

## Solução

### Perfil persistido

Adicionar handlers `getLocalProfile` e `updateLocalProfile` ao gateway. Perfil aceita:

- `name`;
- `avatarId`;
- `avatarShape` opcional;
- `avatarColor` opcional;
- `avatarPngBase64` opcional, PNG de até 700 KiB.

Nome é normalizado, vazio é rejeitado e configuração é gravada atomicamente pelo `ConfigStore`. Valor legado `Local User` migra para `OpenBot Local`.

Electron main/preload expõem bridge local autenticada para leitura e atualização. Renderer usa gateway como fonte de verdade; `localStorage` serve somente como migração de valor existente.

### Aparência

Card de perfil ganha:

- preview de avatar;
- cores predefinidas;
- formato circular, arredondado ou quadrado;
- upload/remover PNG;
- salvamento único junto ao nome.

Nenhum agente oculto será criado.

### Itens indisponíveis

Renderer remove e bloqueia controles com rótulos exatos:

- Help Center;
- Send Feedback;
- Updates.

Se Updates estiver selecionado por estado herdado, General é ativado antes da remoção. Conteúdo de Updates também é ocultado. Código herdado permanece no bundle minificado, mas fica sem rota ou superfície interativa.

### Centralização

Animação de painel deixa de escrever `transform`. Painéis usam somente fade de opacidade; transform e posicionamento nativos permanecem ativos desde primeiro frame.

## Segurança e limites

- IPC de escrita exige sender confiável e modo local.
- PNG valida assinatura e tamanho antes da persistência.
- labels removidos usam igualdade exata, evitando esconder conteúdo legítimo.
- perfil não recebe acesso a operações de agente, workspace ou runtime.

## Testes

1. testes de gateway provam persistência e validação do perfil;
2. testes de patches provam bridge, controles visuais, remoção dos itens e animação sem transform;
3. typecheck e build;
4. testes Electron focados;
5. smoke real do atalho e captura visual/CDP da Settings centralizada.
