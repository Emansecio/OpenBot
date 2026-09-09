# Aceite do perfil local do usuário

Data: 2026-08-16

## Resultado

O OpenBot não apresenta mais a conta local fictícia como uma sessão autenticada. A área herdada de conta foi substituída por **Perfil local**, com um campo para definir o nome do usuário.

O fluxo herdado de `Sign out` foi removido da interface. Caso o renderer tente abrir o diálogo antigo, inclusive a mensagem que menciona uma conta Cursor, o OpenBot cancela e oculta o diálogo automaticamente.

## Comportamento aceito

- o nome inicial é `OpenBot Local`;
- o usuário pode definir um nome de até 80 caracteres;
- espaços repetidos são normalizados e valores vazios são rejeitados;
- o nome e as iniciais são atualizados na interface após salvar;
- a ação **Salvar** é neutra, compacta e permanece desabilitada até o nome mudar;
- o sucesso é confirmado temporariamente por ícone e texto **Salvo**;
- a preferência persiste no perfil Electron pela chave `openbot.profile.name.v1` do `localStorage`;
- nenhuma conta remota é criada e nenhum e-mail fictício é exibido;
- credenciais de providers e chaves de API continuam separadas desta preferência visual;
- controles `Sign out`, `Log out` e `Sair` herdados são ocultados e bloqueados.

## Implementação

- renderer: `client/extracted/dist/renderer/assets/openbot-local-settings.js`;
- regressão estática: `test/electron-windows-patches.test.ts`;
- prova CDP visual e de persistência: `scripts/visual-ui-verify.mjs`.

## Evidências

- `node --check client/extracted/dist/renderer/assets/openbot-local-settings.js`: aprovado;
- teste focado: 14 de 14 testes aprovados;
- `npm run typecheck`: aprovado;
- `node scripts/visual-ui-verify.mjs`: aprovado, incluindo substituição do cartão, cancelamento do diálogo Cursor, ausência de `Sign out`, persistência, iniciais e propagação do nome;
- captura visual: `logs/visual-ui-verify-2enjaZ/visual-profile.png`;
- `npm run verify:e2e:desktop`: `GREEN`, cleanup completo, processos encerrados e portas liberadas;
- evidência E2E: `logs/e2e-desktop/run-20260816-200254-29532`.

A suíte serial desta rodada aprovou 83/84 arquivos e 838 testes, com 1 skip esperado. O único vermelho foi um teste de orçamento temporal de `mcp-manager`, sem relação com a interface; ele passou 21/21 quando repetido isoladamente.

Os avisos de conexão recusada do gate visual são esperados nesse cenário isolado, que executa o renderer sem iniciar o gateway local. Eles não afetaram os critérios específicos deste aceite.
