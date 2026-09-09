# OpenBot — revisão de bugs e gargalos

Data: 2026-08-16  
Escopo: interface Electron, chat/persistência, Skills/MCP, navegador visual, segurança/isolamento, runtime Developer/WSL e ciclo de vida.

## Resultado

Seis agentes Luna fizeram auditorias independentes e somente leitura. O agente principal revisou cada achado no código e nas provas reproduzíveis antes de autorizar correções. Foram confirmados e corrigidos **21 problemas**, agrupados abaixo. Não foi atribuída severidade a hipóteses sem reprodução ou impacto demonstrável.

## Correções confirmadas

### Chat e persistência

1. Exclusão concorrente de bots podia sobrescrever uma criação ou atualização concluída durante o `await`; o roster agora é relido no commit e remove somente os IDs solicitados.

### Skills e MCP

2. A busca autônoma podia selecionar uma Skill sem `autoSelect=true`; a política agora é respeitada.
3. O cancelamento não atravessava toda a descoberta e execução MCP; o `AbortSignal` agora chega às ferramentas compartilhadas.
4. Uma ferramenta podia terminar depois do cancelamento e ainda iniciar nova chamada ao provider; há novo gate de aborto pós-ferramenta.
5. Argumentos MCP JSON malformados podiam aparecer crus no resumo do transcript; a apresentação agora é sanitizada.

### Navegador visual e segurança local

6. O pipe de comandos do browser mantinha um timer de 15 segundos após resolver; o timer agora é limpo em todos os encerramentos.
7. A navegação mantinha timer pendente depois de concluir; o teardown agora é determinístico.
8. O upload validava o caminho antes da abertura, deixando uma janela TOCTOU; agora valida `realpath`, identidade `dev/ino` do handle e lê pelo handle aberto.
9. Os estados em `%APPDATA%\OpenBot` e `%LOCALAPPDATA%\OpenBot` podiam herdar permissões amplas; o bootstrap aplica DACL fail-closed antes de abrir configuração, banco, runtime, workspaces ou perfis do browser. A ACL ao vivo ficou limitada ao usuário atual, `SYSTEM` e `Administrators`.

### Desempenho e ciclo de vida

10. As raízes de Skills eram verificadas e varridas repetidamente no boot; agora cada raiz aceita é escaneada uma vez.
11. Atualizações de ferramenta percorriam o transcript inteiro; foi criado índice SQLite por `localId` e lookup direto equivalente na memória.
12. Estado de geração podia ser removido mesmo se a exclusão do bot falhasse; a limpeza ocorre somente após commit.
13. Promessas de backends por bot permaneciam no cache depois de exclusão confirmada; o callback de commit agora as remove.

### Runtime Developer/WSL

14. Falhas de release/cleanup descartavam cedo demais lease, scheduler ou journal, impedindo retry confiável; o estado é preservado até o teardown concluir.
15. O registro do agente podia desaparecer antes de `agent-delete` terminar; a remoção agora ocorre depois do sucesso.
16. O aborto de subprocessos WSL podia rejeitar antes do evento `close`; o fluxo aguarda o encerramento real.
17. Cleanup de candidatos e rollback de provisionamento podiam se sobrepor; a sequência agora é transacional.
18. Arquivos arquivados durante ativação não participavam integralmente da transação; snapshots e restauração foram incluídos.
19. O boot não confrontava `runtimeVersion` e `imageDigest` devolvidos pelo guest com o manifesto instalado; divergências agora falham o gate.
20. Bridges de host podiam sobreviver a execuções/restarts; a limpeza usa a identidade exata do bridge.
21. Marcadores de nonce do supervisor guest cresciam sem limite; agora são podados com cobertura de regressão.

## Achados descartados

- **Janela Electron preta após falha de bootstrap:** falso positivo. O fluxo atual destrói a janela, executa `app.exit(1)` e propaga o erro.
- **Promise de `ensureMainWindow` necessariamente sem tratamento:** não reproduzido e sem caminho acionável confirmado.
- **DACL como isolamento forte entre bots do mesmo usuário:** não é um bug novo; é uma limitação documentada do modo PC Lite compartilhado.
- **Reconciliação SQLite como gargalo atual:** medição local aproximada de 25 ms em 200 mil registros não justificou alteração adicional.

## Verificação final

| Gate | Resultado |
|---|---:|
| `npm run typecheck` | aprovado |
| `npm run build` | aprovado |
| suíte serial completa | 84 arquivos; 839 aprovados; 1 teste ACL opcional ignorado |
| `npm run verify:skills-mcp` | aprovado; 133 testes focados, aceite 3/3 e E2E desktop GREEN |
| `npm run verify:e2e:browser` | aprovado; 14 testes e host Electron real isolado |
| `npm run verify:runtime-wsl-live` | GREEN; instalação, processo, identidade, aborto, rollback e limpeza confirmados |
| `npm run verify:acl:live` | 6/6 aprovados |
| ACL real Roaming + Local | usuário atual, `SYSTEM` e `Administrators`; `icacls` sem falhas |

## Pendência residual conhecida

Se `driver.acquire()` conseguir criar uma lease no guest e lançar uma exceção antes de devolver qualquer identidade recuperável, o manager não tem dados contratuais para compensar esse recurso. Corrigir isso exige evoluir o contrato do driver, não apenas tratar a exceção localmente. O caso permanece documentado; não foi mascarado como resolvido.

## Limite da conclusão

Esta revisão confirma os problemas encontrados pelos auditores e cobertos pelos gates executados. Ela não afirma que software complexo esteja livre de todo bug possível. Não há Git neste diretório, portanto a evidência é baseada no estado atual dos arquivos, nos testes e nos gates ao vivo, sem atribuição por diff de repositório.
