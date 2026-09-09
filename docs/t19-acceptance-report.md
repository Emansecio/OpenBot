# T19 — Relatório de aceite da Fase 1

Data: 2026-08-12

## Aceite automatizado

- Build TypeScript: `npm run build`.
- Suíte: `npm test` — 24 arquivos, 316 testes.
- Smoke determinístico: `npm run smoke:local`.
  - gateway real em porta loopback dinâmica;
  - provider fake em memória;
  - `sendPrompt` e streaming do turno;
  - dedupe de `clientNonce` (uma chamada ao provider);
  - transcript com usuário, send-message e resposta;
  - fechamento/reabertura do SQLite e releitura do transcript.
- Cliente extraído: `node scripts/audit-local-client.cjs`.
  - conector por descritor local presente;
  - loopback somente com opt-in;
  - sem egress executável detectado para Cursor auth/API, Statsig e Sentry.
- Bundles: `node --check` em Electron main, preload, coordinator e local-exec daemon.
- Renderer visual: inicialização limpa confirmou `dom-ready`, `ready-to-show`, `window shown` e `renderer state rendered`, sem handlers IPC ausentes.
- Monitor do smoke filtrado pelo PID: nenhuma conexão não-loopback observada.

## Correções incorporadas no aceite

- Criação da janela restaurada para depois do registro de IPC de settings, persistência, secrets e auth.
- Métodos de provider removidos do contrato interno `mainEdge`, onde não tinham trust policy; os canais IPC dedicados permanecem como integração correta.
- Provider/modelo/baseURL persistidos e validados no gateway.
- Perfil isolado no launcher visual evita locks de instâncias Electron antigas.


## Progresso posterior ao aceite da Fase 1

A execução local restrita da Fase 2 está ligada no bootstrap padrão. Cada agente ganha `%LOCALAPPDATA%\\OpenBot\\workspaces\\<agentId>\\` (Desktop/Documents/Downloads/Projects). O backend cobre arquivos, busca interna, aprovações e o loop de tool calling, sem shell arbitrário ou rota HTTP de execução direta. Consulte [`phase-2-local-execution-progress.md`](phase-2-local-execution-progress.md).

O roster é multi-agente: o `+` nativo (New chat → Create new Bot) chama `createAgent` e seleciona o bot. Customização (Name/Title/Description) é o painel nativo **View agent settings**; os três valores persistem por bot, com fallback `Title = Name` apenas para registros antigos sem título explícito. Modelo/provedor/chave entram só nesse painel. Computer, Plugins e Log out ficam ocultos. `getForeverBoxStatus` continua `{ vncUrl: null, windows: [] }`.

Suíte posterior ao aceite original: mais arquivos e testes do que os 316/24 do corte T19 — o número vigente é o de `npm test`.

## Pendências que exigem recurso externo ou confirmação humana

1. Conversa com chave real OpenAI e/ou xAI para provar o endpoint comercial e cobrança.
2. Cadastro e alternância de provider/modelo pela UI observados por uma pessoa.
3. Smoke OpenAI-compatible contra LM Studio/vLLM real, caso esse runtime esteja instalado.
4. Prova de rede com firewall/ETW durante uma conversa real com provider comercial. O smoke Electron prolongado já confirmou zero conexões não-loopback sem credencial real, mas não substitui o cenário com chave e tráfego do provider.

Essas pendências não podem ser concluídas automaticamente sem credencial de provider, runtime compatível ou inspeção humana da UI.
