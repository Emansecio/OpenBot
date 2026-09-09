# OpenBot — avaliação de prontidão

**Data da avaliação:** 16/08/2026  
**Leitor:** usuário do OpenBot e futuro mantenedor local  
**Objetivo:** permitir decidir se o OpenBot já pode ser usado diariamente, sem confundir prontidão local com maturidade para distribuição a terceiros.

## Resultado executivo

O OpenBot está em **96/100 de prontidão geral** e pode ser classificado como **release candidate avançado para uso local pessoal**.

Para o uso prático neste computador, a prontidão é **99/100**. Os cinco pilares priorizados — chat/providers/persistência, lifecycle dos bots, navegação web visual, Skills/MCP e Runtime Developer/WSL — atingiram **100/100 dentro dos critérios técnicos de aceite definidos**. O ambiente já pode ser usado diariamente para criar bots reais, conversar, persistir estado, manipular arquivos, navegar visualmente, usar Skills e acessar ferramentas MCP autorizadas e executar tarefas Developer no runtime WSL compartilhado.

Isso não equivale a um produto final de distribuição pública. Empacotamento, atualização, manutenção do renderer herdado e reprodução integral de alguns gates ainda precisam amadurecer.

## Método de cálculo

A nota geral é a média simples das sete áreas avaliadas. A média exata é `95,71`, arredondada para **96**.

A nota de uso prático exclui distribuição e manutenção futura, porque esses fatores não impedem o uso pessoal. Ela usa os seguintes pesos operacionais:

| Área | Peso prático |
|---|---:|
| Chat, providers e persistência | 25% |
| Criação, exclusão e isolamento dos bots | 20% |
| Navegação web visual | 20% |
| Skills e MCP | 15% |
| Runtime Developer/WSL | 5% |
| Segurança e recuperação | 15% |

O resultado ponderado é `98,8`, arredondado para **99**.

As notas representam o estado verificado nesta data. Elas não são uma promessa permanente: mudanças no Electron, no WSL, nos providers ou nos contratos do renderer exigem nova validação.

## Notas por área

| Área | Nota | Fundamentação |
|---|---:|---|
| Chat, providers e persistência | 100% | Gate integrado parte de roster vazio, cria o primeiro bot, persiste Name/Title/Description e provider/modelo/chave, valida streaming intermediário, retry sem duplicação, cancelamento forte, transcript/nonce e restart, sem vazamento da chave. |
| Criação, exclusão e isolamento dos bots | 100% | Create/duplicate compensam falhas sem home órfã; ACL Windows falha fechado; restore/import/repair/export drenam browser; delete restaura transcript/nonces/decisions/activity em rollback; shutdown tenta todos os cleanups. |
| Navegação web visual | 100% | Gate Electron real e versionado cobre navegação, snapshot, interação, screenshots, upload, download, handoff, dois bots isolados, negativos de segurança e cleanup. Corridas de lease/host/teardown e o diálogo fatal do Electron foram eliminados e protegidos por regressões. |
| Skills e MCP | 100% | Gate único cobre descoberta autônoma, invocação manual no chat, políticas por bot, MCP HTTP/stdio reais, segredos, limites, transcript, reconexão após falha, timeout total e UI Electron com `/` e chip. |
| Runtime Developer/WSL | 100% | Gate live único e versionado cobre pacote/digest, instalação, `process.run`, identidade não-root, seccomp, cgroups, rede bloqueada, timeout/abort, cleanup parcial idempotente, recovery de órfãos, rollback e remoção integral da distro temporária. |
| Segurança e recuperação | 92% | Containment, DACL, egress mediado, proteção de segredos, limites de tools e recuperação estão cobertos. Permanece uma janela TOCTOU teórica no `cwd` de MCP stdio, sem bypass prático demonstrado. |
| Distribuição e manutenção futura | 78% | O desktop funciona localmente, mas ainda depende de patches sobre renderer compilado e não possui maturidade equivalente a instalador, atualização e manutenção de um produto distribuído. |

## Evidências consideradas

- suíte serial com **806 testes aprovados** e **1 ignorado**, em **81 arquivos**;
- typecheck e build verdes;
- gate core integrado verde, com **3 de 3 cenários aprovados**;
- gate Electron desktop verde, incluindo inventário, streaming, cancelamento, Skill, processos ausentes, portas livres e temporários removidos;
- gate real de ACL Windows com **6 de 6 testes aprovados**;
- gate do browser real verde, com **10 de 10 testes**, incluindo fail-fast sem diálogo nativo;
- gate Skills/MCP verde com **132 testes focados**, **3 cenários core** e E2E Electron com teardown completo;
- runtime WSL validado pelo gate live versionado com `process.run`, identidade, seccomp, rede bloqueada, cleanup parcial, timeout, abort, recuperação e rollback;
- supervisor Rust com **16 testes aprovados** durante o build oficial do guest;
- auditoria de dependências de produção com **zero vulnerabilidades**;
- revisão independente de interface e backend sem bloqueio P0/P1 confirmado.

## Por que ainda não é 100%

1. A janela TOCTOU teórica do `cwd` de MCP stdio precisa ser eliminada com launcher nativo ou formalmente aceita como risco residual.
2. Os patches locais do renderer compilado precisam continuar protegidos por testes e E2E, ou migrar para uma superfície mantida pelo projeto.
3. O primeiro ciclo prolongado com bots reais, chaves e providers do usuário ainda deve confirmar a estabilidade operacional cotidiana; isso não reabre os critérios técnicos já fechados dos cinco pilares.
4. Empacotamento, atualização e processo de manutenção precisam amadurecer antes de distribuição a terceiros.

## Interpretação operacional

- **Pode ser usado agora:** sim, para uso pessoal local.
- **Pode receber bots reais:** sim; a criação continua leve e os serviços pesados são compartilhados e iniciados sob demanda.
- **É seguro tratar como VM por bot:** não; os bots compartilham Windows, identidade do usuário e serviços locais, embora seus estados persistentes sejam separados.
- **Está pronto para entregar a terceiros como produto final:** ainda não.
- **Classificação recomendada:** release candidate local avançado, em validação cotidiana.

## Critério para a próxima nota

A prontidão deve ser reavaliada depois de:

1. criar e usar os primeiros bots reais com provider configurado;
2. executar tarefas reais de chat, arquivos, browser, Skills, MCP e Developer;
3. registrar falhas observadas durante uso prolongado;
4. repetir os gates Skills/MCP e WSL após mudanças nessas superfícies;
5. decidir a estratégia de manutenção do renderer e de distribuição do desktop.

A nota **100 geral** deve ser reservada para ausência de pendências relevantes nas sete áreas, incluindo segurança residual e distribuição/manutenção, não apenas nos cinco pilares técnicos já fechados.

## Documentos relacionados

- [Revisão de bugs e gargalos](openbot-bug-bottleneck-review-2026-08-16.md)
- [Ambiente prático final](practical-bot-environment-final.md)
- [Revisão de polimento](openbot-polish-review-2026-08-16.md)
- [Gates de verificação](verification-gates.md)
- [Aceite 100/100 dos três pilares](openbot-three-pillars-100-acceptance-2026-08-16.md)
- [Aceite 100/100 de Skills/MCP e Runtime/WSL](openbot-skills-mcp-runtime-100-acceptance-2026-08-16.md)
- [Skills e MCP no chat](shared-skills-mcp-chat.md)
- [Aceite da tela de boas-vindas](openbot-welcome-screen-acceptance-2026-08-16.md)
- [Aceite do perfil local do usuário](openbot-local-user-profile-acceptance-2026-08-16.md)
- [Estado da execução local](phase-2-local-execution-status.md)
