# OpenBot Readiness Convergence Design

## Objetivo

Levar o checkout atual do OpenBot de `NÃO APTO` a `APTO` para uso pessoal diário em três etapas sequenciais, seguidas por um loop de auditoria que termina após um checkup integral sem bugs ou gargalos funcionais confirmados.

O escopo de gargalo é funcional: travamento, timeout, fila bloqueada, vazamento de processo/porta/handle, limite operacional excedido ou cleanup incompleto. Otimização especulativa de CPU, memória ou latência fica fora do escopo.

## Restrições

- O checkout não possui Git. Antes de cada tarefa, registrar hashes dos arquivos sob responsabilidade; não sobrescrever mudanças alheias detectadas durante a tarefa.
- Não criar commits, branches ou worktrees.
- Testes e E2E devem usar raízes temporárias explícitas. Nenhum teste pode gravar ou remover `%APPDATA%\OpenBot`, `%LOCALAPPDATA%\OpenBot`, workspaces, instalação ou distro permanentes.
- Código proprietário extraído não será desminificado, recompilado ou copiado. Integrações locais permanecem nos seams versionados já existentes.
- Cada mudança segue RED reproduzível, patch mínimo, GREEN focado e gate de etapa.

## Estratégia escolhida

A execução é sequencial por etapa. Tarefas de implementação que compartilham a árvore não rodam em paralelo. GPT Luna pode implementar tarefas estreitas e realizar inspeções independentes; arquitetura, segurança, integração, confirmação de achados e gate final permanecem com o agente principal.

Após cada tarefa:

1. implementação e autoteste;
2. revisão independente de conformidade com a especificação;
3. revisão independente de qualidade;
4. correção e nova revisão enquanto houver questão aberta.

## Etapa 1 — baseline executável confiável

### Isolamento de testes

O teste de integração do keystore deve receber diretório temporário explícito. O construtor do keystore deve falhar em ambiente de teste quando nenhuma raiz isolada for fornecida, impedindo reincidência silenciosa. Testes que verificam a resolução do caminho default devem injetar `APPDATA` ou `OPENBOT_DATA_ROOT` temporário.

### Contratos atuais

- `/local-exec/execute` é a única rota HTTP direta de execução local.
- `/webauthn/ceremony` é a única rota WebAuthn; subrotas desconhecidas retornam 404.
- Os modos ativos são `lite`, `browser` e `developer`.

Os testes antigos serão atualizados para esses contratos sem enfraquecer autenticação, CSRF ou validação de corpo.

### Paridade fonte/build

O launcher de desenvolvimento e o empacotador não podem consumir `dist` obsoleto. O build continua sendo a única origem dos arquivos compilados. Um verificador de backend confirma módulos obrigatórios e que nenhum fonte compilável é mais novo que sua saída correspondente. O empacotamento executa build e verificação antes de copiar `dist`.

Critério de saída da Etapa 1:

- teste algum toca o data root real;
- typecheck e suíte completa verdes;
- build verde;
- bridges e driver local presentes no `dist`;
- boot temporário do `dist` observa os contratos atuais;
- verificação de cliente e backend verdes.

## Etapa 2 — lifecycle para uso diário

### Shutdown gracioso

O gateway ganha `POST /shutdown`, protegido por loopback, CSRF e Bearer token. A rota é idempotente, entra em quiescência e responde `202` antes de agendar o teardown; ela não espera `server.close()` dentro da própria requisição.

Um helper de launcher:

1. confirma ownership do PID;
2. lê o token do data root esperado sem expô-lo em argv, logs ou `process.json`;
3. solicita shutdown;
4. espera processo e porta desaparecerem;
5. usa `taskkill /T /F` somente após timeout e nova prova de ownership.

Gateway adotado por outra invocação nunca é encerrado. Update, uninstall e rollback preservam o estado de ownership se não conseguirem provar o teardown.

### Primeiro boot e restart

Um gate desktop cria raiz aleatória sob `%TEMP%` e redireciona APPDATA, LOCALAPPDATA, data root, local data root, user-data, logs e instalação. Ele executa primeiro boot, fechamento normal e restart usando os mesmos diretórios, verificando persistência, ausência de segredo em logs e cleanup de processos/porta.

Critério de saída da Etapa 2:

- caminho saudável não chama `/F`;
- turnos, browser, runtime, gateway, HTTP e stores fecham;
- primeiro boot e restart terminam sem órfãos;
- documentação operacional descreve os contratos efetivos.

## Etapa 3 — proteção nativa e gates avançados

### DPAPI CurrentUser

Novas gravações de segredos no Windows usam DPAPI `CurrentUser` por um addon Node-API carregado pelo gateway. O formato em disco recebe uma tag explícita de backend. Nenhum segredo trafega por argv, ambiente, stdout ou IPC.

A migração é transacional:

1. abre registros `local-file` com a `.master.key` existente;
2. cifra cada valor com DPAPI;
3. grava arquivo temporário, sincroniza e renomeia;
4. reabre e verifica todos os registros;
5. somente então remove ou arquiva de forma recuperável a chave antiga.

Falha de DPAPI é fail-closed para novas gravações. O fallback AES permanece apenas como leitor de migração. Testes normais usam backend injetável; o teste DPAPI live é Windows-only, opt-in e usa diretório temporário.

### WSL Developer

O gate live passa pelo bootstrap/RPC real do aplicativo com estado temporário e distro de teste, cobrindo dois agentes, identidade não-root, seccomp, rede bloqueada, quotas, timeout, cancelamento, recovery e ausência de leases/processos/cgroups/distro residual.

### Browser e release

O browser Electron mantém o gate offline real e ganha uma navegação pública controlada separada, allowlisted, sem credenciais, formulários, upload ou download. O lifecycle de release roda package, install, preflight, repair, update, rollback e uninstall em roots temporários, incluindo falhas injetadas e preservação de dados.

Critério de saída da Etapa 3:

- DPAPI persiste e decifra após restart;
- migração AES → DPAPI é verificável e recuperável;
- WSL, browser e release completam com cleanup integral;
- nenhum segredo aparece em logs, manifestos ou relatórios.

## Checkup mestre e loop de convergência

O checkup integral executa, em ordem:

1. sentinela de isolamento de paths;
2. typecheck;
3. build e paridade de backend/cliente;
4. suíte Vitest serial completa;
5. core acceptance, chat resilience e Skills/MCP;
6. Local Exec e approvals;
7. browser Electron;
8. desktop clean-profile;
9. ACL live;
10. WSL live;
11. release lifecycle;
12. DPAPI live e restart;
13. inventário final de processos, porta 1340, distros, leases, temporários e logs.

Revisores Luna inspecionam independentemente runtime/WSL, Electron/browser, release/lifecycle, secrets/segurança e cleanup. Relatórios são somente leitura. O agente principal elimina hipóteses sem prova e escolhe o achado confirmado de maior severidade.

Para cada achado confirmado:

1. produzir RED determinístico;
2. corrigir apenas o necessário;
3. obter GREEN focado;
4. executar novamente o checkup mestre completo;
5. reabrir a auditoria caso o checkup ou os revisores encontrem outro achado.

O loop termina após uma rodada integral limpa. “Limpa” significa todos os gates aplicáveis verdes, nenhum skip não justificado, nenhum achado confirmado aberto e nenhum resíduo operacional. Isso não afirma ausência absoluta de bugs fora da matriz verificada.

