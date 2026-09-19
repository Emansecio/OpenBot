# Auditoria técnica do Openbot

**Data:** 11 de setembro de 2026.  
**Código analisado:** árvore de trabalho de `C:\SuperAgent\openbot`.  
**Commit-base:** `2e1c2ed2465eec77116c9fe5726e7afbc496344c`, de 09/09/2026. Há numerosas modificações não commitadas; os achados se referem aos arquivos efetivamente lidos, não apenas a esse commit.  
**Escopo:** análise e relatório, sem alteração de código, instalação, build ou chamadas a provedores reais.

## Conclusão executiva

Existem oportunidades claras e nativas. As mais importantes não exigem trocar de provedor, modelo, banco de dados ou framework. Elas estão na coordenação das ferramentas, no orçamento multimodal, na continuidade da memória, na admissão de inferência e no ciclo de vida das projeções da interface e dos inventários de workspace.

A prioridade deve ser corrigir otimizações que hoje podem produzir informação incorreta ou incompleta. Economizar uma chamada devolvendo uma leitura velha, remover uma imagem por um cálculo inadequado ou avançar a compactação sobre mensagens não examinadas não representa ganho de eficiência com qualidade preservada.

Oito comportamentos foram reproduzidos em ensaios isolados usando os módulos reais do código-fonte, carregados por transpilation em memória, com executores, armazenamento e provedor simulados. Isso valida os mecanismos locais descritos; não mede a frequência desses casos em produção nem o desempenho completo do aplicativo instalado.

Não foram medidos tempo até o primeiro token, duração total com provedores reais, FPS, CPU ou memória do Electron em uma sessão de produção. Portanto, não há base para prometer percentuais de aceleração.

## Fluxo examinado

Foram examinados os pontos de entrada e os caminhos de aceitação/execução em `src/rpc/send.ts`; seleção e execução de ferramentas; roteamento e admissão de provedores; preparação de contexto e de requisições; memória, reflexão e operações SQLite; execução local Windows, backend por agente, quota e workspace; publicação SSE; adaptação do transcript para o renderer; e os mecanismos de descoberta de Skills/MCP.

O renderer extraído contém um bundle muito grande. A conclusão sobre interface está sustentada principalmente pelo contrato entre publicação do backend, adaptador do transcript e projeção entregue ao renderer. Não se afirma que todos os componentes do bundle foram perfilados ou que cada snapshot causa um rerender completo de toda a interface.

Todas as referências de código abaixo são relativas à raiz do projeto e indicam as linhas dos arquivos analisados.

## Resultados dos ensaios isolados

| Ensaio | Resultado observado |
|---|---|
| Ler, escrever e reler o mesmo recurso em uma rodada | O executor recebeu apenas `read, write`; o modelo recebeu `old, new, old`, embora o estado final fosse `new`. |
| Cancelar duas leituras paralelas já iniciadas | Duas execuções iniciadas; apenas uma conclusão registrada no ledger; estados finais do mock: `completed, started`. |
| Retry transitório com limite global de uma inferência | A vaga continuou ocupada dentro do callback de backoff; foi liberada ao final. |
| Pedidos de esquecimento | `Esqueça...`, `Apague essa memória` e `Forget...` não habilitaram a ferramenta. Um pedido de lembrança habilitou-a com os mesmos demais parâmetros válidos. |
| Projeção de reflexão sobre 40 mensagens extensas | Apenas 7 mensagens retidas; 33 omitidas; intervalo declarado permaneceu 1–40; o fato inicial não foi enviado. Payload: 58.209 bytes. |
| Anexo já representado + contexto adicional de Skill | O anexo permaneceu; a instrução exclusiva da Skill desapareceu do contexto montado. |
| Resumo armazenado de 4.272 bytes | Um fato no final do resumo não entrou na requisição, embora houvesse amplo orçamento disponível. |
| Parte multimodal com 600.000 caracteres base64 sintéticos | Estimativa local de 200.025 tokens; com orçamento de 100.000 tokens, a parte de imagem foi substituída pelo marcador de omissão. Não foi teste de decodificação visual nem de tokenização real de um provedor. |

## 1. Leituras reutilizadas após alteração do recurso

**Prioridade:** P1. **Confiança:** alta, mecanismo reproduzido. **Esforço:** médio. **Risco da correção:** médio, porque é necessário preservar idempotência de efeitos colaterais.

**Evidência:** `src/execution/tool-loop.ts:372–405`, `522–530`, `565–584`, `601–609`.

O loop reutiliza resultados por fingerprint semântico. Na mesma rodada, uma chamada idêntica recupera `roundOutcomes`. Entre rodadas, `previousRoundFingerprints` pode bloquear a repetição. Existe invalidação específica para observações do navegador depois de ações de navegador, mas não uma invalidação equivalente para leituras de arquivos após mutações.

O ensaio fez uma leitura, uma escrita e outra leitura do mesmo caminho. A segunda leitura não foi executada e recebeu o resultado anterior à escrita. Isso compromete verificações de alterações, inspeções de configuração e ciclos de correção do agente.

Além disso, o ledger retomável usa identidade derivada do fingerprint no turno. Corrigir apenas o cache da rodada não basta: leituras legitimamente repetidas também precisam distinguir versões ou ocorrências da observação.

**Recomendação:** separar resultados observacionais de efeitos idempotentes. Invalidar observações conforme o recurso ou uma geração de workspace quando ocorrer uma mutação relevante. Para comandos com efeitos desconhecidos, a invalidação deve ser conservadora. Não resolver removendo indiscriminadamente a proteção contra replay de operações mutáveis.

**Critério de aceite:** ler–escrever–reler devolve o estado novo, inclusive entre rodadas e com ledger ativo; duplicatas equivalentes sem mutação continuam evitando trabalho; efeitos mutáveis concluídos não são repetidos automaticamente após interrupção.

## 2. Cancelamento pode deixar conclusões paralelas sem registro

**Prioridade:** P1. **Confiança:** alta, reproduzido. **Esforço:** baixo. **Risco:** baixo a médio.

**Evidência:** `src/execution/tool-loop.ts:547–551`, `634–659`, especialmente a linha `648`.

O uso de `Promise.allSettled` é apropriado para não perder resultados dos irmãos quando uma leitura falha. Entretanto, a aplicação dos resultados usa `aborted ??= applyOutcome(item, outcome)`. Depois que a primeira aplicação retorna um resultado de cancelamento, o operador deixa de avaliar `applyOutcome` nos demais itens.

No ensaio, duas leituras chegaram a executar, mas apenas uma conclusão entrou no ledger. A outra permaneceu como iniciada no estado simulado. O encerramento do turno pode posteriormente converter esse estado em interrupção/incerteza; isso não recupera o resultado que deixou de ser registrado.

**Recomendação:** executar a persistência/finalização de cada resultado já liquidado incondicionalmente e acumular separadamente o primeiro estado de cancelamento ou erro. Cancelar não deve iniciar novos trabalhos, mas também não deve apagar conclusões de trabalhos já terminados.

**Critério de aceite:** cancelar durante um lote paralelo finaliza todos os resultados já conhecidos; nenhum efeito concluído fica artificialmente sem confirmação; nenhuma nova ferramenta começa após o cancelamento.

## 3. Backoff ocupa indevidamente uma vaga global de inferência

**Prioridade:** P1. **Confiança:** alta, reproduzido. **Esforço:** baixo a médio. **Risco:** baixo.

**Evidência:** `src/providers/router.ts:543–663`; `src/providers/admission.ts:8–10`, `99–154`.

A admissão é adquirida antes da tentativa. Quando há erro transitório sem saída observável, o código aguarda o backoff dentro do `catch`. A liberação da vaga ocorre somente no `finally`, depois da espera.

Consequentemente, uma requisição que não está usando o provedor continua consumindo capacidade de concorrência. O efeito é mais relevante com vários bots e com `Retry-After` longo. No teste com capacidade um, a ocupação permaneceu em um durante o callback de espera.

**Recomendação:** delimitar a concessão à tentativa efetiva e liberá-la antes da espera. A próxima tentativa deve voltar à fila, respeitando justiça, cancelamento e eventual cooldown apropriado ao provedor. Aumentar o limite global não corrige essa ocupação indevida.

**Critério de aceite:** outro bot elegível pode progredir durante o backoff; o bot em retry não fura a fila; não há liberação dupla nem retry após saída observável.

## 4. O orçamento multimodal trata base64 como texto

**Prioridade:** P1. **Confiança:** alta para o comportamento local reproduzido. **Esforço:** médio. **Risco:** médio, pois o orçamento de imagem depende da capacidade do adaptador/modelo.

**Evidência:** `src/memory/model-context.ts:456–478`, especialmente `467–475`; `539–568`. Também `src/rpc/send.ts:3441–3471` para a seleção inicial das imagens.

O contador concatena o conteúdo textual com `part.image_url.url` e aplica o tokenizer textual ao conjunto. Uma imagem embutida em base64 passa, assim, a consumir uma estimativa proporcional ao tamanho textual do transporte, não à representação visual que o modelo processa.

O ensaio com 600.000 caracteres base64 sintéticos gerou 200.025 tokens estimados e removeu a imagem em uma janela disponível de 100.000 tokens. O ensaio não mede quantos tokens um provedor cobraria, mas comprova a regra local inadequada e a remoção que ela provoca.

A documentação primária de visão da OpenAI distingue a representação base64 das regras de tokens visuais, calculadas por características do modelo e da imagem. Não é correto aplicar uma fórmula visual única a todos os provedores, tampouco usar o comprimento base64 como tokenização textual.

Há ainda um problema de completude na seleção inicial: o limite acumulado é verificado antes da inclusão da próxima imagem, e a interrupção da iteração pode deixar imagens posteriores sem representação individual. A mensagem não deve induzir o modelo a acreditar que viu todos os anexos.

**Recomendação:** separar orçamento textual, estimativa visual e limite serializado de transporte. Os adaptadores devem fornecer estimativas/capacidades visuais verificáveis; quando não houver estimador confiável, usar política conservadora explícita, sem tokenizar o base64 como prosa. Manter os limites de bytes e tornar a omissão de cada anexo identificável.

**Critério de aceite:** variantes de transporte da mesma imagem não geram uma diferença artificial equivalente ao número de caracteres base64; imagens omitidas são identificadas; o envelope final continua dentro do limite real de bytes.

## 5. Anexos podem suprimir instruções da Skill selecionada

**Prioridade:** P1. **Confiança:** alta, reproduzido. **Esforço:** baixo a médio. **Risco:** baixo a médio.

**Evidência:** `src/rpc/send.ts:2823–2843`; `src/memory/context.ts:1227–1234`; `src/integrations/shared-tools.ts:228–256`.

O fluxo combina contexto do anexo e contexto da Skill. Na montagem do histórico, quando a última mensagem já contém o delimitador de anexo, a condição destinada a evitar duplicação impede a inclusão de todo o contexto adicional. Isso também elimina a parte exclusiva da Skill.

No ensaio, o contexto final manteve o anexo e perdeu o marcador exclusivo das instruções selecionadas. O comportamento pode parecer um problema do modelo ignorando a Skill, embora as instruções não tenham chegado à requisição.

**Recomendação:** representar separadamente anexos, referências e instruções de Skill, com identidades próprias. Deduplicar somente o componente já representado, não uma string composta inteira pela presença de um delimitador de outro componente.

**Critério de aceite:** anexo isolado, Skill isolada e anexo+Skill chegam completos; o anexo não é duplicado; o histórico não acumula indefinidamente instruções efêmeras de Skills anteriores.

## 6. Pedidos naturais para esquecer não habilitam a ferramenta

**Prioridade:** P1. **Confiança:** alta, reproduzido. **Esforço:** baixo a médio. **Risco:** médio, por envolver autorização de mutação persistente.

**Evidência:** `src/memory/context.ts:704–711`, `754–759`, `864–866` e `987`.

O mesmo predicado de intenção explícita habilita lembrar e esquecer. Ele contempla expressões de armazenamento/lembrança, mas não pedidos usuais como “Esqueça minha preferência”, “Apague essa memória” e “Forget my old preference”. Com parâmetros de conversa e proveniência válidos, esses três pedidos não disponibilizaram `memory_forget`; um pedido de lembrança disponibilizou.

Isso não significa que a exclusão pela interface esteja quebrada. O achado é especificamente a autorização/disponibilização pelo pedido conversacional.

**Recomendação:** distinguir intenção explícita de salvar/atualizar da intenção explícita de esquecer. A interpretação deve ser ancorada na mensagem atual do usuário, não em texto recuperado ou anexos. Preservar identificação canônica, escopo, registros de esquecimento e proteção contra reaprendizado indevido.

**Critério de aceite:** pedidos explícitos de esquecimento em português e inglês funcionam; frases negadas, citadas ou provenientes de conteúdo não confiável não provocam exclusão involuntária.

## 7. Compactação avança sobre mensagens que a reflexão não examinou

**Prioridade:** P1. **Confiança:** alta para a projeção reproduzida e o contrato de avanço confirmado em código. **Esforço:** médio. **Risco:** médio.

**Evidência:** `src/memory/context.ts:411–491`; `src/memory/reflection.ts:450–454`; `src/main.ts:1069–1113`; `src/memory/context.ts:1301–1311`.

Quando o intervalo é extenso, a projeção seleciona mensagens dentro do orçamento, priorizando âncoras e conteúdo recente, mas conserva o `throughSequenceId` do intervalo completo. A aplicação do resumo exige essa fronteira, e o contexto futuro passa a buscar mensagens posteriores à fronteira resumida.

No ensaio com 40 mensagens extensas, apenas sete mensagens foram enviadas à reflexão. O payload informou a omissão das outras 33, porém permaneceu declarando cobertura de 1 a 40. Um fato na primeira mensagem não foi enviado.

Isso é diferente da perda normal de detalhes inerente a resumir: o resumo pode passar a representar como coberto um trecho que sequer foi examinado. O histórico bruto não precisa ser apagado para haver perda de continuidade no contexto automático.

**Recomendação:** processar lotes contíguos e fazer a fronteira avançar somente até o último ponto efetivamente coberto. Manter resumo cumulativo e revisão esperada, que já existem. Se houver seleção não contígua, a cobertura precisa ser representada explicitamente e não pode excluir automaticamente os intervalos ausentes do contexto futuro.

**Critério de aceite:** fatos colocados no início, meio e fim de um intervalo acima do orçamento não desaparecem por salto de fronteira; cancelamento ou falha não avança a cobertura; jobs agrupados continuam sendo processados sem omitir intervalos.

## 8. O resumo persistido é cortado por posição, mesmo com contexto sobrando

**Prioridade:** P1 para continuidade de tarefas longas. **Confiança:** alta, reproduzido. **Esforço:** médio. **Risco:** médio.

**Evidência:** `src/memory/policy.ts:10`; `src/memory/context.ts:43–44`, `1301–1350`, `1381–1409`.

O armazenamento aceita resumo renderizado de até 32 KiB. A montagem injeta normalmente apenas 2.048 bytes ou 1.536 bytes, conforme o tipo de prompt, podendo reduzir ainda mais sob pressão. Trata-se de um corte de prefixo, não de seleção por relevância.

No ensaio, um resumo de 4.272 bytes perdeu o fato situado no final, embora a requisição tivesse ampla folga de orçamento. O efeito é agravado porque as mensagens anteriores à fronteira já não entram no histórico recente e as memórias originadas na própria conversa são filtradas da recuperação automática.

**Recomendação:** tratar o resumo como estado de trabalho estruturado: objetivo, decisões vigentes, restrições, recursos, progresso e pendências. Alocar o orçamento conforme relevância e disponibilidade, em vez de cortar invariavelmente o prefixo. Preservar fatos importantes/pinados da conversa atual quando não estiverem representados no contexto recente efetivamente incluído.

Não é recomendação para enviar toda a memória sempre. É substituir um corte posicional cego por seleção que preserve a continuidade.

**Critério de aceite:** decisões importantes no final do resumo continuam disponíveis com folga de orçamento; memórias atuais não são removidas só por sua origem; esquecimento, proveniência e prioridade da mensagem atual continuam corretos.

## 9. O término de ferramentas republica snapshots grandes do transcript

**Prioridade:** P2, oportunidade clara de reduzir trabalho interno e tráfego. **Confiança:** alta na redundância; ganho de tempo total ainda não medido. **Esforço:** médio. **Risco:** médio, devido ao protocolo de ordenação e recuperação.

**Evidência:** `src/rpc/send.ts:1851–1858`, `3860–3886`; `client/extracted/dist/node-agent-coordinator/openbot-transcript-adapter.cjs:220–226`, `261–303`.

Ao concluir/falhar uma ferramenta, o backend publica a atualização da entrada e também um snapshot do transcript. A cauda consultada pode conter 500 entradas, sujeita ao limite de frame. Num lote de várias ferramentas, essa operação se repete por conclusão.

No adaptador, snapshots substituem o conjunto de entradas, limpam mapas de controle e inauguram uma nova geração de projeção. Portanto, não se trata somente de acrescentar um status em um card.

**Recomendação:** usar atualizações incrementais ordenadas como caminho normal e reservar snapshots para conexão, troca de conversa, recuperação de lacuna e checkpoints deliberados. Se algum cenário ainda depender do reparo periódico, agrupá-lo por rodada ou janela, com flush terminal, em vez de publicar um snapshot por ferramenta.

Não remover o mecanismo de ressincronização. Não afirmar antecipadamente que toda a árvore React rerenderiza: isso precisa de perfilamento do renderer.

**Critério de aceite:** um lote com múltiplas ferramentas reduz snapshots sem perder cards, ordem ou estados finais; reconexão/backpressure continuam recuperando a projeção; medir bytes, serialização e custo do adaptador separadamente de FPS e latência total.

## 10. O inventário de quota tem ciclo de vida curto demais para comandos sequenciais

**Prioridade:** P2, potencial relevante para bots com workspaces grandes. **Confiança:** alta no caminho; duração real não medida. **Esforço:** médio. **Risco:** médio a alto se a autoridade da quota for enfraquecida.

**Evidência:** `src/execution/runtime/wsl/process-backend.ts:123–144`, `153–194`; `src/execution/quota.ts:110–171`; `src/execution/quota-observer.ts:140–153`, `172–179`, `237–243`.

Apesar do nome do arquivo, esse backend também é usado pelo runtime local por meio de `src/execution/runtime/agent-backend.ts:63–79`.

Um processo adquire observação do workspace. Quando o último consumidor termina, o observer é encerrado. O início estabelece inventário completo e o fechamento faz uma caminhada completa final. O comando sequencial seguinte pode repetir ambas as etapas. Durante observação prolongada, também há reconciliação periódica.

Esse custo cresce com a árvore do bot, incluindo projetos com dependências e caches. A implementação já possui acompanhamento incremental e compartilhamento entre consumidores simultâneos; a oportunidade é ampliar a vida útil desse estado entre comandos relacionados.

**Recomendação:** manter observação por workspace ativo/turno ou durante uma janela de ociosidade limitada, com encerramento por manutenção, exclusão do bot e shutdown. Drenar eventos e validar a autoridade da quota nas fronteiras necessárias; realizar reconciliação completa quando houver perda de eventos, inconsistência, reinício ou política periódica.

Não simplesmente remover as varreduras nem considerar `fs.watch` infalível. A alternativa precisa definir como detecta e recupera perdas de eventos.

**Critério de aceite:** comandos sequenciais reaproveitam o inventário; quota permanece correta com escritores externos, overflow, mudanças de diretório e cancelamento; medir scans por comando e duração de varredura em workspaces representativos.

## 11. Reflexão automática precisa de elegibilidade, prioridade e erros mais específicos

**Prioridade:** P2. **Confiança:** alta no mecanismo; economia real depende do uso. **Esforço:** médio. **Risco:** médio, por risco de deixar de registrar informação importante.

**Evidência:** `src/memory/context.ts:166–175`; `src/rpc/send.ts:1557–1603`; `src/main.ts:1044–1047`, `1115–1165`, `1511`; `src/memory/reflection.ts:584–588`, `709–795`.

No modo automático, a política solicita reflexão de memória por turno elegível, mesmo quando o conteúdo novo pode ser somente uma confirmação. O sistema já agrupa jobs pendentes e impede começar reflexão para o mesmo agente enquanto ele está ocupado. Portanto, não é correto afirmar que toda mensagem sempre produz exatamente uma requisição adicional nem que a reflexão é aguardada pelo chat.

Ainda assim, reflexões usam o mesmo pool global de inferência. Uma reflexão já admitida pode disputar capacidade com uma nova tarefa interativa. O prazo de 30 segundos engloba espera de admissão e execução; o worker trata falhas genericamente como `reflection_failed`/timeout e pode repetir casos permanentes até o limite de tentativas.

**Recomendação:** separar gatilhos de compactação e de memória durável; usar revisão de conteúdo novo, agrupamento e exclusão conservadora de confirmações sem informação; distinguir fila de trabalho interativo e manutenção com justiça para evitar starvation; não consumir todo o prazo de execução apenas aguardando vaga; classificar erros permanentes, transitórios e de formato.

Não trocar silenciosamente o modelo ou reduzir o raciocínio escolhido pelo usuário. A economia principal proposta é evitar trabalho sem mudança relevante e retries sem perspectiva de sucesso.

**Critério de aceite:** confirmações triviais não provocam reflexão desnecessária; fatos e correções novos continuam sendo registrados; falha permanente não entra em repetição inútil; reflexão não deixa de progredir indefinidamente sob tráfego contínuo.

## 12. Mascaramento de resultados antigos é agressivo demais para ser incondicional

**Prioridade:** P2, ajuste de política com avaliação de qualidade. **Confiança:** alta no comportamento; impacto em sucesso de tarefas não foi quantificado. **Esforço:** médio. **Risco:** médio.

**Evidência:** `src/execution/tool-loop.ts:160–201`, `313–316`.

O loop mantém integralmente os resultados da rodada mais recente e transforma resultados anteriores em previews de 256 bytes. Essa redução ocorre independentemente de haver orçamento sobrando ou de a próxima etapa precisar comparar observações de rodadas diferentes.

Ler o documento A numa rodada e B na seguinte pode deixar o modelo com B completo e apenas o início de A. Uma nova leitura pode recuperar o material em alguns fluxos, mas produz custo extra e interage com o controle de repetição descrito no achado 1.

**Recomendação:** preservar observações pequenas, recentes ou necessárias à tarefa; aplicar redução sob pressão real, com limites por item e reserva de evidência útil. Para resultados grandes, manter referências recuperáveis a artefatos existentes e sinalização explícita de incompletude. Não introduzir uma chamada de LLM para resumir cada resultado por padrão.

**Critério de aceite:** tarefas que comparam observações entre rodadas continuam corretas; medir releituras, tokens e sucesso conjuntamente, não apenas a redução de bytes enviados.

## 13. O contador usado para permitir retry é capturado antes do await

**Prioridade:** P1 de correção localizada, embora o cenário seja específico. **Confiança:** alta por leitura direta; o turno completo desse cenário não foi reproduzido. **Esforço:** baixo. **Risco:** baixo.

**Evidência:** `src/rpc/send.ts:2978–3002`. O mesmo padrão de captura também aparece em `2918–2922`, mas o retry externo examinado é restrito a `kind === "stream"`.

O objeto retornado contém `observableCount` antes da propriedade `result: await streamChat(...)`. A avaliação da propriedade copia o contador antes de o streaming atualizá-lo. A decisão posterior de retry por overflow usa esse valor capturado.

Se um adaptador produzir saída e depois terminar com erro classificado como overflow, a guarda de “nenhuma saída observável” pode autorizar outra tentativa. Não se afirma que esse cenário seja frequente; o erro no momento da leitura do contador, porém, é objetivo.

**Recomendação:** concluir o await antes de materializar o contador no resultado, ou representar o estado de observação de modo explicitamente atualizado. Preservar a regra de não repetir automaticamente após saída observável.

**Critério de aceite:** provedor simulado que emite delta e depois erro de overflow não é chamado novamente; overflow antes de qualquer saída ainda permite uma única tentativa reduzida conforme a política.

## Workspaces: organização por bot não equivale a isolamento de segurança

**Evidência:** `src/execution/runtime/local/environment.ts:5–39`; `src/execution/runtime/local/driver.ts:82–100`; `src/execution/runtime/agent-backend.ts:101–153`.

O runtime local assume execução confiável no host. O ambiente acrescenta diretórios temporários e caches específicos, mas herda `process.env`; o próprio comentário explicita que isso não cria usuário/perfil Windows nem fronteira de segurança. Job Objects controlam ciclo de vida; não substituem a política de acesso dos processos. A documentação primária da Microsoft também distingue limites de segurança individuais dos processos associados ao job.

Para melhorar o funcionamento cotidiano, convém explicitar o modo de workspace e o ambiente operacional de cada bot: raiz ativa, diretórios de projeto, ambiente virtual quando adotado, caches e permissões concedidas. Não se recomenda alterar globalmente o `USERPROFILE`, compartilhar caches mutáveis sem critério ou apresentar pastas separadas como sandbox forte.

Se o produto continuar sendo um assistente pessoal confiável com acesso ao host, isso é uma escolha de arquitetura que deve estar clara. Se o requisito passar a incluir bots menos confiáveis ou isolamento efetivo entre bots, será necessário um modo de execução restrito coerente, não apenas convenções de caminhos. Esta auditoria não realizou exploração de fronteiras de segurança.

## O que já está presente e deve ser preservado

- Paralelização conservadora de lotes exclusivamente de leitura, limitada por rodada, em `src/execution/tool-loop.ts:554–659`. Não recomendar paralelizar operações mutáveis indiscriminadamente.
- Transmissão incremental no backend e agrupamento de atualizações no adaptador, em `src/rpc/send.ts:3590–3689` e `openbot-transcript-adapter.cjs:242–258`. O achado de interface é a repetição dos snapshots, não ausência geral de streaming incremental.
- Admissão global com limites e justiça por agente, em `src/providers/admission.ts:69–154`, `239–265`. O problema identificado está no tempo de posse da vaga e na competição entre classes de trabalho.
- Memória com resumo anterior, revisão esperada, proveniência e jobs duráveis, em `src/main.ts:1080–1113` e `src/memory/reflection.ts:385–533`. Não reabrir como diagnóstico atual a alegação de que o resumo não é cumulativo.
- SQLite com WAL e statements preparados, em `src/store/index.ts:751–753`, `939–1118`. Não há evidência nesta análise para recomendar troca de banco ou migração de toda a persistência para workers.
- Limites de fila/frame e ressincronização SSE em `src/server/gateway.ts:49–52`, `500–530`.
- Descoberta MCP fora da espera principal, ferramentas de gateway e cache de listagem/sessão, em `src/integrations/shared-tools.ts:150–198` e `src/mcp/manager.ts:714–784`. Não recomendar como novidade a inclusão de cache genérico de MCP.
- Memoização da contagem textual por identidade em `src/memory/model-context.ts:437–485`. Existe preparação inicial repetida em `src/rpc/send.ts:2899–2908`, `2961–2972`, mas sem medição não a classifico como gargalo principal.

## Ordem de implementação recomendada

### Primeira etapa: consistência e correções localizadas

Corrigir a finalização dos resultados paralelos, a posse da vaga durante backoff e a captura antecipada de `observableCount`. Em seguida, tratar o orçamento multimodal, a composição anexo+Skill e a autorização de esquecimento. Esses casos têm mecanismos específicos e testes de regressão pequenos.

### Segunda etapa: continuidade do agente

Tratar conjuntamente cache de observações, identidade retomável, cobertura de compactação, seleção do resumo e mascaramento de resultados. Corrigir apenas um desses pontos pode deixar a mesma perda reaparecer em outra camada.

### Terceira etapa: reduzir trabalho recorrente

Reduzir snapshots por conclusão, ampliar a vida útil segura do inventário de quota e tornar a reflexão elegível/priorizada. São oportunidades concretas, mas precisam ser comparadas em workloads representativos antes de atribuir ganho de tempo total.

## Medições que fecham o diagnóstico de desempenho

Instrumentar o caminho existente, sem criar um subsistema paralelo: aceitação e commit do prompt; preparação do contexto; espera de admissão; início do transporte, primeira saída e término; duração por ferramenta; inventários de quota; escrita/persistência; bytes e quantidade de eventos; snapshots e resyncs; execução e falhas da reflexão.

Comparar tarefa simples, tarefa com múltiplas leituras, ciclo ler–alterar–verificar, anexo+Skill, análise visual, conversa compactada e vários bots ativos. A avaliação deve cruzar duração, tokens e chamadas com correção, recuperação e completude do contexto.

Para UI, separar bytes/serialização/projeção de FPS e tarefas longas do renderer. Para workspace, separar duração do comando da preparação, inventário e teardown. Para provedor, separar fila interna de rede/inferência. Para memória, separar economia por menos reflexão de perda de qualidade por omissão.

## Referências externas primárias consultadas

OpenAI, **Images and vision**, especialmente a seção **Calculating costs**, consultada em 11/09/2026. Usada somente para distinguir transporte base64 de contabilização visual de tokens.

Microsoft Learn, **Job Objects**, especialmente os limites e a observação sobre segurança por processo, consultada em 11/09/2026. Usada somente para qualificar a distinção entre ciclo de vida de processos e isolamento de segurança.

## Parecer final

O Openbot não precisa de uma reescrita para obter melhorias relevantes. A base já contém mecanismos úteis de controle, persistência, streaming e recuperação. O maior retorno imediato está em corrigir invalidações e fronteiras incorretas; depois, eliminar republicações e inventários repetidos, sem enfraquecer durabilidade, quota ou recuperação.

A recomendação é preservar qualidade como condição de aceitação. Menos tokens e menos chamadas só são uma melhoria quando o bot continua recebendo as evidências necessárias, executando verificações reais e retomando de um estado confiável.
