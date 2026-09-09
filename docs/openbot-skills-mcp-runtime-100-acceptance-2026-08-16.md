# OpenBot — aceite 100/100 de Skills/MCP e Runtime Developer/WSL

**Data:** 16/08/2026  
**Escopo:** os dois pilares solicitados; não representa nota 100 do produto inteiro.

## Resultado

| Pilar | Nota técnica | Gate principal |
|---|---:|---|
| Skills e MCP | 100/100 | `npm run verify:skills-mcp` |
| Runtime Developer/WSL | 100/100 | `npm run verify:runtime-wsl-live` |

Com esses dois fechamentos, os cinco pilares práticos do OpenBot estão em 100/100. A prontidão geral passa a **96/100** e a prontidão para uso pessoal local a **99/100**. Segurança residual e distribuição/manutenção continuam avaliadas separadamente.

## Skills e MCP

Foram fechados:

- sessão MCP morta é invalidada após falha pós-conexão; a chamada atual não é repetida e a próxima reconecta;
- timeout usa um deadline total compartilhado por conexão, `listTools` e `callTool`;
- alteração das flags de invocação de Skill é rejeitada até `refresh`, sem impedir atualização legítima do corpo;
- descoberta autônoma, invocação manual por `/`, chip nativo, fallback textual e políticas por bot;
- HTTP e stdio reais pelo SDK, segredos, limites e transcript sem corpo/path/contexto efêmero de Skill.

Evidência final:

- **132/132** testes focados;
- **3/3** cenários core;
- Electron isolado `GREEN`, uma resposta final, processos ausentes, portas livres e temporário removido.

As revisões independentes de conformidade e qualidade aprovaram o pilar após a correção do deadline total.

## Runtime Developer/WSL

Foram fechados:

- `wait_empty` de cgroup fail-closed e cleanup de criação parcial;
- validação real de cgroup v2 e controladores obrigatórios;
- `setgroups`, UID/GID, `NoNewPrivs`, seccomp e rede isolada fail-closed;
- timeout e abort com prova positiva de sandbox/cgroup sem resíduos;
- cleanup idempotente após sucesso parcial, inclusive cgroup já ausente;
- reconciliador WSL concreto no bootstrap de produção, IDs estritos e journal mantido até prova de teardown;
- instalação candidata, falha, rollback e recovery de lease órfã;
- runner com timeout real, stdout/stderr assíncronos e `finally` protegido por nome exato;
- build e gate usam somente `OpenBotBuild` descartável e `OpenBotRuntimeLive-<UUID>`; nenhuma distro por bot.

Evidência final:

- typecheck e build `GREEN`;
- **16/16** testes Rust durante o build oficial;
- gate live `GREEN` com archive `sha256:b7653bcc9cfbd74a38ff040f0ab840891c780396baf5de39b8672beddc240266`;
- `installed`, `process`, `identity`, `abortRecovery` e `rollback` verdadeiros;
- `cleanupErrors=[]`, snapshots permanentes iguais e distro temporária ausente;
- antes/depois: somente `Ubuntu-24.04`, `OpenBotRuntime` e `Ubuntu`, todas `Stopped`, WSL2.

O primeiro protótipo do runner revelou um bloqueio de leitura que deixou uma distro temporária registrada. A execução foi interrompida, a distro exata foi removida sem tocar as permanentes, o timeout/teardown foi corrigido e dois gates live posteriores terminaram limpos. Essa falha foi tratada como evidência de teste, não escondida como sucesso.

As revisões independentes encontraram e exigiram o fechamento do reconciliador de produção, da idempotência após cleanup parcial e da validação de `runtimeBootId`. A re-revisão final aprovou o pilar sem gap concreto restante.

## Regressão integrada final

| Verificação | Resultado |
|---|---|
| `npm run typecheck` | `GREEN` |
| `npm run build` | `GREEN` |
| suíte Vitest serial | 81 arquivos; 806 aprovados; 1 skipped condicional |
| `npm run verify:skills-mcp` | `GREEN` |
| `npm run verify:runtime-wsl-live` | `GREEN` |
| processos/portas desktop | ausentes/livres |
| distros temporárias e `TempRoot` | ausentes |

## Limites honestos

- A configuração de servidores MCP e chaves comerciais depende das integrações escolhidas no uso real; isso não é lacuna do mecanismo compartilhado.
- Bots compartilham o mesmo Windows e uma única distro WSL; o isolamento entregue é de workspace, lease, cgroup, mounts, políticas e estado, não uma VM por bot.
- Código deliberadamente hostil continua fora da garantia de isolamento forte.
- A nota geral não é 100 enquanto segurança residual e distribuição/manutenção permanecerem abaixo de 100.
