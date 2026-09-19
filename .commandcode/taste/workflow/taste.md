# Workflow

- Antes de alterar qualquer coisa, lê AGENTS.md e as instruções/documentos aplicáveis do repositório e confere o Git (status/log/stash) para preservar todo trabalho preexistente. Confidence: 0.8
- Não faz commit, instalação, deploy, chamadas pagas nem alterações em dados reais, salvo pedido explícito. Confidence: 0.75
- Não reinicia bots/serviços em uso nem minimiza ou atrapalha as janelas do usuário. Confidence: 0.65
- Antes de alterar artefatos do cliente, exige consultar os gates e registros da fronteira (docs/verification-gates.md, docs/openbot-provenance-ledger.md, provenance/renderer-boundary-v1.json) e manter manifestos e registros consistentes. Confidence: 0.6
- Espera implementação e validação de fato — rodar os checks e gates pertinentes com resultados reais — e não que o trabalho termine apenas com um diagnóstico. Confidence: 0.75
- A entrega deve declarar explicitamente limitações e pontos não validados, além do que foi verificado. Confidence: 0.7
- Validação deve usar fixtures isoladas e providers simulados, reaproveitando os testes existentes, e cobrir o percurso completo afetado. Confidence: 0.65
- Exige validação em execução real no fixture (comportamento observado de fato no fluxo, ex. stream pausado, troca de bot, reconexão), não apenas testes unitários ou focados. Confidence: 0.65
- Preserva o estado local não commitado exatamente como está: não usa HEAD como cópia do estado anterior de arquivos já modificados nem reconstrói arquivos a partir dele. Confidence: 0.7
- Mantém o escopo restrito ao que foi pedido e conclui as melhorias já implementadas sem reiniciar trabalho nem ampliar frentes. Confidence: 0.7