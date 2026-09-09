# OpenBot — autenticação somente OAuth

## Decisão

A experiência ativa terá apenas dois provedores:

- **xAI** — login com SuperGrok/X Premium por OAuth device code.
- **OpenAI Codex** — login com ChatGPT Plus/Pro por OAuth PKCE no navegador.

API keys, Base URL e OpenAI-compatible deixam de aparecer na interface. O suporte legado pode permanecer internamente para não ampliar o patch, mas não será selecionável pelo usuário.

## Abordagem

Usar o fluxo do Pi como referência de protocolo, sem adicionar o pacote completo como dependência:

1. Um coordenador OAuth local inicia, acompanha, cancela e encerra logins.
2. Credenciais `{ access, refresh, expires }` ficam no keystore criptografado do OpenBot.
3. O acesso é renovado automaticamente antes de expirar.
4. xAI continua no adapter existente, usando o access token como Bearer.
5. Codex usa `chatgpt.com/backend-api/codex/responses`, o account id do JWT e os cabeçalhos próprios do Codex.

Isso evita dependências pesadas e mantém o runtime atual compartilhado.

## Interface

As configurações mostram provedor, modelo, estado da conta e um único botão contextual:

- desconectado: **Entrar com xAI** ou **Entrar com ChatGPT**;
- conectando: instrução/código e opção **Cancelar**;
- conectado: conta ativa e botão **Desconectar**.

Salvar altera apenas provedor/modelo. “Testar conexão” usa a sessão OAuth salva e o modelo selecionado.

## Erros e segurança

- `state` e PKCE obrigatórios no Codex.
- URLs abertas pelo OAuth devem ser HTTPS; somente o callback loopback do Codex usa HTTP.
- Nenhum token cru atravessa o renderer, aparece em log ou arquivo de configuração.
- Logout remove access e refresh token.
- Falha de refresh marca a conta como desconectada e exige novo login.

## Validação

- Testes unitários para PKCE, parsing do JWT, refresh e estados do login.
- Testes RPC/IPC garantindo que tokens não chegam ao renderer.
- Testes dos adapters para endpoint/cabeçalhos Codex e Bearer xAI.
- Teste do patch de interface confirmando ausência de API key/OpenAI-compatible.
- Typecheck, testes focados e suíte serial proporcional ao risco.

