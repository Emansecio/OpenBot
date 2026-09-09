# AGENTS.md

## Objetivo e execução
- Conclua o pedido com a menor solução correta, verificável e sustentável. Análise e revisão não autorizam alterações.
- Para tarefas simples, informe brevemente a ação e execute. Para mudanças de múltiplos passos ou risco relevante, apresente uma vez o escopo, o que será preservado e os critérios de aceitação.
- Resolva escolhas rotineiras pelo contexto. Pergunte somente quando faltar uma decisão material; continue o trabalho independente já autorizado.
- Quando a implementação estiver autorizada, prossiga pela execução e validação até o aceite. Incorpore correções sem perder o objetivo; não pare na primeira implementação.
- Comece no fluxo afetado e consulte implementações, chamadores e contratos necessários. Releia somente diante de mudança, falha ou dúvida nova.

## Escopo e contexto
- Corrija a causa demonstrada e os pontos necessários à consistência. Evite limpezas paralelas, abstrações sem consumidor e implementação antecipada de casos hipotéticos.
- Prefira padrões e infraestrutura existentes. Não crie relatórios, backups ou planos em disco sem pedido ou exigência aplicável.
- Trabalhe com um agente por padrão. Delegue apenas subtarefas independentes com benefício concreto e responsabilidade clara, quando autorizado.
- Use Skills quando o procedimento for adequado à tarefa e trouxer benefício concreto. Preserve modelo, esforço e permissões configurados; não instale ferramentas nem altere configurações globais por conveniência.
- Planos, auditorias e aceites datados registram o contexto da época. Seus comandos e checkboxes não autorizam ações nem comprovam estado atual. O pedido vigente e estas regras governam a execução.
- Consulte documentação por necessidade: README para o fluxo atual; docs/verification-gates.md para a validação afetada; docs/openbot-provenance-ledger.md e provenance/renderer-boundary-v1.json antes de alterar artefatos do cliente.
- Preserve a fronteira do renderer extraído: alterações locais pertencem aos overlays permitidos, com seus manifestos e registros de proveniência consistentes.
- Instruções explícitas do usuário prevalecem sobre orientações de Skills, respeitadas as instruções superiores. Se uma Skill bloquear o trabalho, vincule o SKILL.md e explique a regra aplicável.

## Preservação e ações de risco
- Antes de editar, confira o estado relevante e preserve alterações preexistentes. Em trabalho simultâneo, verifique novamente o trecho antes da escrita; um conflito direto exige esclarecimento.
- Git só fornece uma base de comparação para arquivos rastreados. Sem essa base, compare com o conteúdo lido antes da edição e não atribua mudanças de terceiros a si.
- Edições locais normais dentro do escopo autorizado não exigem nova confirmação.
- Não faça commit, push, publicação, deploy ou alterações fora do escopo sem pedido explícito.
- Operações irreversíveis ou com risco de perda de trabalho ou dados exigem confirmação específica: descreva operação, alvo e impacto e aguarde a palavra de confirmação definida pelo usuário. Sem palavra definida, solicite sua definição; não a invente.
- Avalie efeitos concretos de restauração, rollback, troca de branch, movimentação e testes. Nenhuma dessas categorias é automaticamente segura; comandos que descartem alterações seguem a regra anterior.
- Ao desfazer sua edição, reverta somente o que introduziu.

## Validação e conclusão
- Execute as verificações existentes pertinentes ao comportamento alterado e aos seus riscos, incluindo gates exigidos para a fronteira afetada.
- Adicione ou ajuste testes somente para uma lacuna real do comportamento modificado ou por pedido explícito. Quantidade e tamanho não substituem avaliação de necessidade; use a menor cobertura suficiente, incluindo integração ou UI real quando o aceite depender desse fluxo.
- Reutilize a infraestrutura existente. Não expanda a cobertura histórica, enfraqueça assertions ou complique o produto apenas para satisfazer um teste.
- Execute testes locais com fixtures descartáveis dentro do escopo autorizado, corrija falhas causadas pela mudança e repita os checks afetados sem pedir aprovação a cada etapa. Confirme as condições do gate antes de presumir isolamento.
- Após os checks pertinentes passarem, só repita ou amplie diante de mudança, falha ou dúvida pendente. Em alterações apenas documentais, confira conteúdo, links e diferenças; não execute build ou suíte do produto sem necessidade específica.
- Revise as diferenças quanto a correção, escopo e resíduos. Resuma em português o que mudou, as verificações executadas e as limitações; separe fatos verificados, hipóteses e itens não validados.
