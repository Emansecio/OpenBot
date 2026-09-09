# OpenBot Shared Skills + MCP Chat — plano de execução

> Execução autônoma autorizada em 16/08/2026.

## 1. Contratos e segurança do catálogo

- [x] Criar contratos de Skills/MCP e defaults compatíveis no `ConfigStore`.
- [x] Escrever testes RED para paths, UTF-8, limites, precedência e isolamento por bot.
- [x] Implementar `SkillCatalog` compartilhado e projeção por política.

## 2. Tools e contexto do turno

- [x] Generalizar o loop para um executor adicional sem contornar o broker local.
- [x] Adicionar `search_skills`/`use_skill`, prompt curto e referência explícita por `richText`/`/skill`.
- [x] Provar lifecycle, limites, abort e ausência de vazamento no transcript.

## 3. Contrato nativo do composer

- [x] Implementar `getAgentWorkflows` e os RPCs de refresh/status.
- [x] Conectar gateway e o contrato Electron já consumido pelo composer nativo.
- [x] E2E: `/` abre lista nativa, escolha cria chip e envio resolve a Skill com uma única resposta final.

## 4. MCP

- [x] Adicionar o SDK oficial e `McpManager` lazy compartilhado.
- [x] Implementar Streamable HTTP e stdio sem shell, validação de endpoint/comando, timeout, abort e limite de resultado.
- [x] Projetar tools autorizadas por bot no provider e executá-las no tool loop.
- [x] Testar HTTP/stdio reais, SSRF/DNS pinning, política cruzada, isolamento de falha e shutdown.

## 5. Validação e documentação

- [x] Rodar testes focados a cada slice RED/GREEN.
- [x] Rodar `npm run typecheck`, `npm test`, `npm run build`, smoke e E2E desktop isolado.
- [x] Fazer revisão final de segurança e qualidade com subagentes Luna.
- [x] Atualizar README/status com configuração, uso autônomo, `/`, MCP e limites reais.

**Fechamento:** 71 testes focados; 740 testes completos passando e 1 skipped; typecheck, build, smoke e Electron E2E `GREEN`.
