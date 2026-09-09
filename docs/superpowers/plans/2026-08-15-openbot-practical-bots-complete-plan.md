# OpenBot Practical Bots Complete — plano de execução

> Execução autônoma concluída em 2026-08-15; os itens abaixo refletem o estado entregue.

## Bloco 1 — estado vazio e lifecycle

- [x] Aceitar `agents: []` e remover bootstrap implícito de `openbot-default`.
- [x] Adicionar backup, inventário, DACL, quarentena listável/restaurável, export/import seguro e repair.
- [x] Adicionar RPCs e UI de onboarding/lifecycle.
- [x] Migrar os 27 bots de teste para backup/quarentena e limpar ghosts do store.

## Bloco 2 — runtime guest P0/produto

- [x] Corrigir package externo/limpeza e unificar policy.
- [x] Criar build reproduzível em `OpenBotBuild`, supervisor estático e rootfs versionado.
- [x] Verificar ELF, hashes de árvore e manifest antes/depois da importação.
- [x] Implementar install staging, promotion, previous, rollback e repair conservador.
- [x] Integrar recovery no boot e fechar resíduos inválidos.
- [x] Rodar gate live seccomp/process/abort/delete em `OpenBotRuntime`.

## Bloco 3 — navegador visual

- [x] Implementar proxy egress local autenticado com resolução segura.
- [x] Implementar host Electron compartilhado e manager/leases por bot.
- [x] Adicionar operações estruturadas open/navigate/snapshot/click/type/screenshot/download/upload/close/handoff.
- [x] Implementar full-page real, upload limitado à home e fechamento de aba para leases expirados.
- [x] Integrar broker, ferramentas do modelo, RPC/SSE e painel visual.
- [x] Testar persistência isolada, SSRF, abort/delete e zero processos residuais.

## Bloco 4 — UX, resiliência e aceite

- [x] Status/diagnóstico factual, quotas e repair na UI.
- [x] E2E prático em estado vazio, Lite e Developer reais.
- [x] E2E visual de navegador no painel principal e handoff.
- [x] Rehearsal final em AppData isolado, seguido de validação do estado real limpo.
- [x] Garantir que a suíte de testes não escreva no AppData real do usuário.
- [x] Atualizar os documentos de status/progresso apenas com evidência observada.
