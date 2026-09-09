# OpenCode Go Provider

## Objetivo

Adicionar `opencode-go` ao OpenBot com API key protegida, descoberta dinâmica de modelos e execução pelo protocolo correto, seguindo o contrato do Pi sem adicionar sua dependência completa.

## Contratos externos

- Base: `https://opencode.ai/zen/go/v1`
- Autenticação: `Authorization: Bearer <OPENCODE_API_KEY>`
- Modelos: `GET /models`
- Inferência: `/responses`, `/chat/completions` ou `/messages`, conforme o modelo.

## Componentes

1. `OpenCodeGoAdapter`: resolve a chave pela keystore, descobre modelos e encaminha cada modelo ao protocolo definido pelo catálogo compatível com o Pi.
2. Catálogo dinâmico: combina apenas os IDs retornados por `/models` com metadados locais de protocolo. Modelos desconhecidos permanecem visíveis somente quando houver transporte seguro compatível; caso contrário, falham fechados.
3. RPC/UI: OpenCode Go aparece junto a xAI e OpenAI Codex. Apenas esse provedor exibe o campo de API key. Salvar a chave dispara descoberta e preenche o seletor.
4. Persistência: a chave nunca entra na configuração nem retorna ao renderer; somente o estado configurado é exposto.

## Erros

- Chave ausente ou inválida: mensagem de autenticação e nenhum modelo selecionável.
- Falha em `/models`: mantém a configuração anterior, sem inventar catálogo.
- Modelo sem protocolo conhecido: bloqueado antes da chamada.
- Timeout, cancelamento e SSE seguem os contratos existentes do roteador.

## Verificação

- Testes isolados de descoberta, autenticação e roteamento dos três protocolos.
- Teste do bridge Electron e da UI condicional.
- Typecheck, build, suíte focada e verificadores de artefatos/renderer.
