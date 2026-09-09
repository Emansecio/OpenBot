# OpenBot — revisão de polimento de interface e backend

**Data:** 2026-08-16  
**Escopo:** interface Electron, bridge preload/main, gateway/RPC, runtime, contexto de Skills, execução de tools, providers, testes e dependências.  
**Método:** revisão inicialmente somente leitura em seis frentes Luna independentes; achados confirmados foram consolidados antes das correções.

## Resultado

Não restou bloqueio P0/P1 confirmado no escopo revisado. A integração final passou typecheck, build, suíte completa, ACL real do Windows e E2E Electron isolado.

| Área | Achado confirmado | Correção |
|---|---|---|
| UI | formulário vazio sem nome acessível; foco fraco; textos com mojibake | label/form semânticos, Enter nativo, foco visível, `color-scheme: dark`, raízes customizadas em `pt-BR` e textos corrigidos |
| Desktop | falha terminal do renderer podia deixar janela preta/processo vivo | janela destruída e processo encerrado com código 1 |
| Desktop | verificador visual usava porta e perfil fixos e teardown incompleto | porta livre, AppData/user-data temporários e encerramento da árvore de processos |
| Workspace | UI não tinha acesso seguro ao inventário do bot ativo | bridge sem `agentId` externo; main resolve somente o bot ativo e exige sender confiável/modo local |
| Exclusão | fence do runtime podia permanecer após delete/falha | liberação garantida em `finally` |
| Exclusão | falha após quarentena podia separar roster e home | transação com compensação de config/home; teardown do browser separado |
| Contrato | `getForeverBoxStatus` havia divergido do shape legado | restaurado exatamente para `{ vncUrl: null, windows: [] }` |
| Modelos | seleção global sem bots respondia sucesso sem persistir | catálogo global persistido; modelo custom sem bot é rejeitado |
| Skills | erro de limite de contexto era descartado | erro propagado e turno falha antes de transcript/provider |
| Contexto | nome/descrição sem limites proporcionais | nome até 120 caracteres; descrição até 16 KiB UTF-8; NUL rejeitado |
| Tools | resultados e resumos podiam crescer excessivamente | 128 KiB por rodada com corte UTF-8 seguro; resumo sanitizado em até 120 caracteres |
| Shutdown | timeout de abort podia permitir fechamento de recursos com turno vivo | `abortAllTurns` agora lança no timeout e impede continuidade silenciosa do shutdown |
| Providers | falhas transitórias não eram repetidas | até duas novas tentativas, abortáveis, somente antes de delta/tool observável |
| Dependências | Electron 40.10.2 e `extract-zip` geravam duas vulnerabilidades altas | Electron 41.10.5 e `@electron-internal/extract-zip`; audit de produção zerado |

## Decisões de revisão

- O documento-base continua `lang="en"`, porque a shell herdada mistura conteúdo nativo em inglês; somente as superfícies adicionadas pelo OpenBot usam `lang="pt-BR"`.
- O timeout de shutdown não força o fechamento de stores/runtimes: ele interrompe a sequência com erro para não criar corrida com um turno ainda vivo.
- O teste de reader SSE malformado foi fixado com `maxRetries: 0`, pois ele verifica exclusivamente teardown do body; retry tem cobertura própria no router.
- O verificador visual standalone continua sendo um ensaio do painel injetado e pode registrar gateway indisponível quando executado sozinho. O gate funcional autoritativo é o E2E isolado com fixture e gateway reais.

## Evidência final

| Gate | Resultado |
|---|---|
| `npm run typecheck` | GREEN |
| `npm run build` | GREEN |
| suíte serial | 81 arquivos; 788 testes passando; 1 skipped |
| `npm run verify:core:acceptance` | 3/3 cenários integrados |
| `npm run verify:acl:live` | 6/6 testes reais de ACL Windows |
| `npm run verify:e2e:desktop` | GREEN; bridge de inventário real, streaming, cancelamento e Skill; zero erros de renderer |
| `npm run verify:e2e:browser` | 10/10; browser Electron real, negativos de segurança e fail-fast |
| teardown E2E | `ownedProcessesAbsent=true`, `portsFree=true`, `cleanup=temp-root-removed` |
| `npm audit --omit=dev` | 0 vulnerabilidades |

Evidência E2E desktop final: `logs/e2e-desktop/run-20260816-063153-16628/`. O relatório `cdp-report.json` registra inventário, cancelamento observado, contexto de Skill recebido e resposta final única; o resumo confirma processos ausentes, portas livres e raiz temporária removida.

## Gates reproduzíveis

```powershell
npm run typecheck
npm run build
npx vitest run --maxWorkers=1 --no-file-parallelism
npm run verify:acl:live
npm run verify:e2e:desktop
npm audit --omit=dev
```

Detalhes de isolamento e efeitos dos gates: [`verification-gates.md`](verification-gates.md).

## Riscos residuais conhecidos

- O gate WSL live completo ainda não possui runner único versionado; a limitação de rastreabilidade permanece documentada no relatório do ambiente prático.
- A proteção de `cwd` do subprocesso possui uma janela TOCTOU teórica entre a segunda canonicalização e o `spawn`; nenhum bypass prático foi demonstrado.
- O renderer herdado é distribuído como bundle compilado; patches locais precisam continuar cobertos pelos testes estáticos e pelo E2E Electron.
