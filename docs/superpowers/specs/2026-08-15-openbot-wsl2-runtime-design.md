# OpenBot — runtime WSL2 compartilhado e sandbox de processos

> **Status:** design aprovado pelo usuário em 15/08/2026.
> **Escopo:** primeiro subprojeto do roadmap de `OPENBOT-PC-LOCAL.md`.
> **Princípio:** o Lite continua funcional; WSL2 é um adapter incremental, não uma substituição abrupta.

## 1. Objetivo

Adicionar ao OpenBot um runtime Linux local compartilhado, administrado pelo próprio produto, capaz de executar processos confinados por bot sem criar uma distro, uma VM ou um sistema operacional por agente.

O primeiro slice entrega:

- distribuição WSL2 dedicada `OpenBotRuntime`;
- lifecycle sob demanda, com estado factual e recuperação após crash;
- supervisor guest e protocolo IPC autenticado/versionado;
- lease de sandbox vinculado a um único `agentId`;
- isolamento de filesystem/processos/mounts/PIDs/IPC/UTS e cgroup;
- execução `process.run` estruturada, com rede `none`;
- teardown integral e fail-closed;
- integração com criação/remoção de bots sem iniciar runtime para bots parados;
- fallback Lite quando WSL2 estiver indisponível.

O workspace Windows continua sendo criado imediatamente no `createAgent`, `duplicateAgent` e boot do agente default. O runtime WSL2 é iniciado apenas no primeiro uso de uma capability que o exige.

## 2. Contexto atual

O projeto já possui:

- `AgentHomeStore` em `src/execution/home.ts`;
- `WorkspaceSandbox` com validação de paths Windows e rejeição de links;
- `HomeWorkspaceBackend` para arquivos e buscas internas;
- `LocalExecutionBroker` com roteamento por `agentId`;
- `ExecutionBackend.execute(request, signal)` como seam de execução;
- `createAgent`, `duplicateAgent` e `deleteAgents` no roster;
- 492 testes passando em 39 arquivos e build TypeScript verde em 15/08/2026.

O projeto ainda não possui WSL2, processo arbitrário, namespaces, cgroups, navegador, egress mediado ou status real de runtime. `getForeverBoxStatus` é legado e não deve receber campos incompatíveis.

## 3. Decisões de produto

### 3.1 Custos e provisionamento

- Uma distro WSL2 compartilhada atende todos os bots.
- A imagem base, Chromium futuro e toolchains aprovados serão compartilhados.
- Cada bot terá apenas workspace e estado persistente próprios.
- Não haverá processo WSL, navegador ou desktop permanente por bot parado.
- `createAgent` não inicia WSL2 nem Chromium.
- Primeiro uso de `process.run` faz `ensure` e `acquire` sob demanda.
- Se o usuário escolher Lite ou WSL2 estiver indisponível, o chat e as tools Lite continuam operacionais.

### 3.2 Limites honestos

O slice usa o kernel compartilhado da WSL2. Não é equivalente a uma VM com kernel separado. O modo Hyper-V continua reservado para código deliberadamente hostil, requisitos de kernel separado ou compliance específico.

### 3.3 Escopo inicial e posteriores

Incluído agora:

- Fase 2: distro, installer, health, IPC, start/stop e recuperação;
- Fase 3: sandbox de processos, mounts mínimos, cgroups, seccomp e rede desligada.

Adiado para slices posteriores:

- egress gateway e perfis `web`, `allowlist` e `packages`;
- Chromium, CDP, display, noVNC, upload e download;
- caches de pacotes, toolchains persistentes e Developer UX completa;
- quotas por classe, lixeira, export/import/repair e remoção recuperável do workspace;
- DACLs, atualização assinada completa, compactação de VHDX e Hyper-V.

Esses itens terão de usar os contratos deste design, não criar um segundo caminho de execução.

## 4. Arquitetura

```text
Windows / OpenBot
  Gateway + RPC
  TurnRunner + Tool Loop
  Capability Broker
  AgentHomeStore
  AgentRuntimeManager
  WslRuntimeAdapter
        │ IPC local autenticado
        ▼
WSL2 — OpenBotRuntime
  Supervisor confiável
    ├─ health e protocolo
    ├─ mounts/namespaces/cgroups
    ├─ lifecycle de leases
    └─ worker por sandbox
        ├─ workspace único do agentId
        ├─ rootfs read-only
        ├─ /tmp e /run efêmeros
        ├─ PID/IPC/UTS/mount próprios
        ├─ UID não privilegiado
        └─ network namespace sem rede
```

O plano de controle permanece no Windows. O worker não acessa gateway, keystore, supervisor, outros workspaces, sockets administrativos ou credenciais do host.

### 4.1 Módulos do host

Criar os módulos abaixo sem alterar o contrato de `ExecutionBackend`:

```text
src/execution/runtime/
  contracts.ts       # modos, estados, capabilities, leases e erros
  manager.ts         # lifecycle e state machine por runtime/agente
  scheduler.ts       # leases, single-flight, idle timeout e limites
  policy.ts          # validação de capability e digest de policy
  wsl/
    adapter.ts       # implementação host do runtime WSL2
    transport.ts     # transporte IPC autenticado
    installer.ts     # import, staging, versão e rollback
    health.ts        # probes, reconciliação e diagnóstico
```

O supervisor guest será mantido em um pacote separado de `src/execution/`, com seu próprio protocolo e testes. Ele não reutiliza o parser de tools do host nem recebe objetos de configuração do provider.

### 4.2 Caminhos administrados

A instalação gerenciada usará uma raiz própria sob `%LOCALAPPDATA%\\OpenBot\\runtime\\`, separada de:

- `%LOCALAPPDATA%\\OpenBot\\workspaces\\`;
- `%APPDATA%\\OpenBot\\`;
- qualquer distribuição pessoal do usuário;
- o VHDX ou configuração de outras aplicações.

A estrutura deverá separar `distro`, `images`, `state`, `staging`, `current` e `previous`. A escolha de VHDX/diretório avançado será configurável antes da importação, nunca por reutilização silenciosa de uma distro existente.

## 5. Contratos

### 5.1 Runtime

```ts
type RuntimeMode = "lite" | "browser" | "developer" | "isolated-vm";

type RuntimeState =
  | "lite-ready"
  | "runtime-unavailable"
  | "runtime-installing"
  | "stopped"
  | "starting"
  | "ready"
  | "busy"
  | "waiting-approval"
  | "stopping"
  | "unhealthy"
  | "quota-exceeded"
  | "repair-required";

type RuntimeCapability =
  | { kind: "process.run"; networkProfile: "none" };

type StopReason = "idle" | "shutdown" | "agent-delete" | "health-failure" | "manual";

interface RuntimeStatus {
  agentId: string;
  mode: RuntimeMode;
  state: RuntimeState;
  runtimeVersion: string | null;
  imageDigest: string | null;
  runtimeBootId: string | null;
  activeLeaseCount: number;
  activeProcessCount: number;
  lastActivityAt: string | null;
  lastError: SanitizedRuntimeError | null;
}

interface AgentRuntimeManager {
  ensure(agentId: string, mode: RuntimeMode, signal?: AbortSignal): Promise<RuntimeStatus>;
  acquire(agentId: string, capability: RuntimeCapability, signal?: AbortSignal): Promise<RuntimeLease>;
  status(agentId: string): Promise<RuntimeStatus>;
  stop(agentId: string, reason: StopReason): Promise<RuntimeStatus>;
  repair(agentId: string): Promise<RepairResult>;
  close(): Promise<void>;
}
```

`RuntimeMode` já reserva Browser e Isolated VM para compatibilidade futura. Este slice implementa `lite` e o sandbox de processo sem rede; capabilities de navegador, egress e Hyper-V retornam erro estável de não suportado, sem iniciar componentes parciais.

`RuntimeStatus` só pode reportar `ready` após handshake e health check do supervisor. A existência da pasta, da distro ou de um PID antigo nunca basta.

### 5.2 Lease

Cada `RuntimeLease` contém:

- `leaseId` aleatório e não reutilizável;
- `agentId` canônico;
- `runtimeBootId` da inicialização atual;
- capability exata e digest da policy;
- instante de criação e deadline;
- nonce usado nas mensagens IPC;
- referência ao sandbox e ao cgroup no guest, sem expor paths administrativos ao modelo.

O lease deve oferecer execução e liberação cooperativa. Após release, timeout, cancelamento ou erro fatal, o manager confirma a destruição antes de liberar o objeto.

### 5.3 Processo

Estender `ExecutionRequest` com uma união discriminada:

```ts
{
  operation: "process.run";
  executable: string;
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  networkProfile: "none";
}
```

Regras do parser:

- somente campos exatos;
- executável deve ser um identificador allowlisted da imagem ou path relativo permitido dentro do workspace;
- `argv` não pode ser convertido em uma string de shell;
- `cwd` é relativo ao workspace;
- env não herda o supervisor e rejeita nomes/valores de secret;
- stdin, argv, env, timeout e saída possuem limites finitos;
- `networkProfile` diferente de `none` é rejeitado neste slice;
- `sh -c`, `bash -c`, `cmd.exe`, `powershell.exe`, `wsl.exe`, interop Windows e PATH do host não são expostos.

O resultado de processo inclui `exitCode`, sinal quando aplicável, duração, stdout/stderr limitados, flags de truncamento e métricas agregadas. Não inclui paths internos, env secreto, command line sanitizada de modo inseguro ou conteúdo além dos limites.

## 6. Lifecycle

### 6.1 Criação do bot

1. `createAgent` valida o id.
2. `AgentHomeStore.ensure` cria a home Windows imediatamente.
3. Configuração e roster são persistidos como hoje.
4. Nenhum processo WSL é criado.
5. O runtime permanece em `stopped` até uma capability que o exija.

Se a criação da home falhar, o agente não é persistido. Essa garantia existente deve continuar coberta por teste.

### 6.2 Primeiro uso

1. `TurnRunner` traduz uma chamada para `process.run`.
2. O broker valida agente, modo, capability e policy.
3. `RuntimeManager.ensure` executa single-flight.
4. O adapter verifica WSL2, virtualização, espaço, versão e imagem.
5. A distro dedicada é iniciada, se necessário.
6. O supervisor negocia protocolo e `runtimeBootId`.
7. `acquire` cria lease e prepara sandbox exclusivo.
8. O processo é iniciado com limites e rede `none`.
9. O resultado volta ao tool loop como resultado estruturado.
10. O lease é reutilizado apenas dentro do escopo permitido e nunca entre bots.

### 6.3 Idle e stop

Quando não houver operação, processo ou lease dentro do runtime:

1. o scheduler bloqueia novas aquisições;
2. solicita shutdown gracioso;
3. espera o grace period;
4. mata cgroup remanescente;
5. desmonta workspace e overlays;
6. verifica zero lease, processo e mount;
7. marca `stopped`;
8. permite o encerramento da distro.

Não se deve manter um daemon por bot. O supervisor global só permanece vivo enquanto houver leases, processos ou manutenção necessária.

### 6.4 Delete durante execução

`deleteAgents` deve manter o fence já existente do `TurnRunner` e, nesta integração, também:

1. cancelar o turno;
2. revogar approvals pendentes;
3. impedir novos leases para o agente;
4. chamar `stop(agentId, "agent-delete")`;
5. confirmar teardown integral;
6. só então limpar transcript e remover a home pelo caminho atual.

O slice posterior de remoção recuperável trocará a exclusão direta por quarentena sem mudar a ordem de segurança.

### 6.5 Crash recovery

O host manterá journal mínimo de `runtimeBootId`, leases e diretórios temporários, sem conteúdo de prompt ou arquivo. No boot seguinte:

- confirma se a distro é a OpenBotRuntime esperada;
- enumera leases/cgroups/mounts órfãos pelo identificador do runtime;
- mata processos remanescentes;
- remove temporários identificados;
- não remove workspace ou perfil persistente válido;
- marca `repair-required` após falhas repetidas;
- nunca resemeia ou apaga dados do bot como reação automática a uma corrupção não compreendida.

## 7. Distro e IPC

### 7.1 Instalação

O installer deve:

- verificar WSL2, virtualização, kernel, espaço livre e versão mínima;
- instalar/importar somente `OpenBotRuntime` em raiz administrada;
- usar staging antes de ativar uma versão;
- validar hash, metadados de versão e schema;
- manter a versão anterior até o health check;
- rejeitar distro pessoal, nome desconhecido ou root incompatível;
- deixar Lite operacional se a instalação não puder prosseguir;
- pedir consentimento explícito antes de habilitar recurso Windows ou reiniciar a máquina.

Assinatura, SBOM, CVE inventory e rollback completo pertencem ao hardening operacional, mas a estrutura de versão e staging deste slice deve permitir sua adição sem alterar o adapter.

### 7.2 Configuração guest

Na distro dedicada:

- automount geral fica desativado;
- interop Windows fica desativado;
- PATH Windows não é injetado;
- executáveis Windows e sockets do host não são acessíveis ao worker;
- não há SSH server, Docker daemon, cron genérico, serviço de descoberta ou pacote não utilizado;
- somente o supervisor possui privilégios para preparar o sandbox;
- o worker não possui `CAP_SYS_ADMIN`.

O mount da home é resolvido pelo supervisor após validar `agentId`, manifesto e lease. O sandbox não recebe o diretório pai contendo outros agentes.

### 7.3 Protocolo

Toda mensagem inclui:

- versão do protocolo;
- tipo estrito de operação;
- `runtimeBootId`;
- `leaseId`;
- `agentId`;
- nonce monotônico/único;
- deadline;
- tamanho máximo de frame;
- policy digest;
- payload validado sem campos extras.

O canal:

- não escuta em `0.0.0.0`;
- não é publicado na LAN;
- usa AF_VSOCK como transporte primário;
- só usa loopback como fallback local, com token efêmero forte, binding explícito em `127.0.0.1`, firewall e verificação do processo dono;
- rejeita replay, lease de outro boot, agentId divergente e frames atrasados;
- fecha em timeout/cancelamento;
- retorna erros sanitizados.

Nenhum socket administrativo é montado no sandbox. O segredo de boot é entregue somente ao supervisor e rotacionado a cada boot do runtime.

## 8. Isolamento do sandbox

Cada lease de processo terá:

- mount namespace próprio;
- PID namespace próprio;
- IPC namespace próprio;
- UTS namespace próprio;
- network namespace próprio sem interface e sem DNS;
- UID/GID não privilegiado exclusivo ou mapeado sem acesso cruzado;
- rootfs read-only;
- `/tmp` e `/run` em tmpfs próprio;
- `/proc` limitado ao PID namespace;
- `/sys` ausente ou somente leitura minimizado;
- devices mínimos, sem block device, `/dev/kvm` ou socket administrativo;
- capabilities removidas;
- `no_new_privs`;
- seccomp allowlist compatível com toolchains aprovados;
- cgroup v2 próprio;
- umask restritiva;
- ambiente filtrado;
- diretório inicial explícito.

Layout guest:

```text
/
  app/                 imagem base somente leitura
  workspace/           somente a home do agente
  home/openbot/        home controlada
  tmp/                 tmpfs efêmero
  run/                 tmpfs efêmero
  openbot-state/       estado permitido e limitado
```

A imagem base é compartilhada. `upperdir`, `workdir` e temporários são exclusivos do lease e descartados no teardown. Nenhum bind mount adicional pode ser solicitado pelo worker.

## 9. Estados, erros e observabilidade

### 9.1 Transições permitidas

```text
stopped → starting → ready → busy → ready
starting → unhealthy | runtime-unavailable
ready/busy → stopping → stopped
qualquer estado ativo → unhealthy
unhealthy → repair-required | starting
```

`runtime-unavailable` significa que o Lite ainda pode operar, mas o requisito WSL2 não está disponível. `repair-required` exige diagnóstico/reparo explícito e não faz reset destrutivo.

### 9.2 Códigos de erro

O runtime deve distinguir pelo menos:

- `runtime_unavailable`;
- `runtime_version_mismatch`;
- `runtime_protocol_error`;
- `runtime_unhealthy`;
- `lease_expired`;
- `lease_replayed`;
- `agent_not_registered`;
- `sandbox_setup_failed`;
- `process_not_allowed`;
- `process_timeout`;
- `process_aborted`;
- `process_output_limit`;
- `network_profile_unsupported`;
- `teardown_incomplete`.

Mensagens de provider e UI são estáveis e sanitizadas. Logs não registram conteúdo de arquivo, prompt, screenshot, token, cookie, env secreto ou command line com segredo.

### 9.3 Status RPC

`getForeverBoxStatus` continua compatível com seu contrato legado e não recebe campos arbitrários. O runtime factual será exposto por um contrato versionado separado, `getLocalRuntimeStatus`, com:

- `agentId`;
- modo e estado;
- versão/digest do runtime;
- boot id não secreto ou identificador pseudonimizado;
- leases/processos ativos;
- última atividade;
- erro sanitizado;
- indicação se Lite está disponível;
- indicação de reparo necessário.

O status nunca chama `running` quando só a home existe.

## 10. Testes e gates

### 10.1 Unitários

- parsing estrito de runtime, capability, lease e `process.run`;
- state machine e transições inválidas;
- single-flight e concorrência de `ensure`;
- nonce, deadline, boot id e replay;
- policy digest e rejeição de capability ampliada;
- sanitização de erros/logs;
- compatibilidade de manifest e fallback Lite.

### 10.2 Integração Windows/WSL2

- instalação em diretório temporário administrado;
- distro pessoal não tocada;
- WSL ausente, desabilitada, incompatível e corrompida;
- start/stop e health check;
- handshake AF_VSOCK e fallback loopback local;
- falta de espaço e interrupção durante staging;
- restart do app e da distro;
- crash recovery e limpeza de leases órfãos;
- nenhum listener LAN ou `0.0.0.0`.

### 10.3 Testes adversariais

O worker tentará:

- ler `/mnt/c`, host, root de workspaces e bot vizinho;
- chamar `cmd.exe`, PowerShell, `wsl.exe` ou interop;
- acessar supervisor, gateway, keystore ou CDP;
- criar bind mount, mount, chroot, unshare ou device node;
- ganhar capability ou remover `no_new_privs`;
- atravessar symlink e path fora da home;
- fazer fork bomb, memory bomb e preencher disco/inodes;
- sobreviver ao timeout/cancelamento como daemon;
- explorar `/proc`, `/sys`, sockets e devices.

### 10.4 Concorrência e delete

- dois bots executando simultaneamente sem leitura cruzada;
- múltiplos leases do mesmo bot conforme limite;
- delete durante processo bloqueia novos turnos e encerra o cgroup;
- timeout e shutdown do OpenBot não deixam processo/mount;
- falha no teardown vira `unhealthy`, não falso sucesso;
- reinício recupera sem apagar workspace válido.

### 10.5 Gate de aceite

O primeiro slice só passa quando:

1. Lite funciona com WSL2 ausente;
2. um runtime compartilhado atende múltiplos bots;
3. bot parado não mantém processo WSL ou sandbox;
4. sandbox A vê somente sua home;
5. A não lê B, host, gateway ou keystore;
6. `process.run` não aceita shell, PATH do Windows ou rede;
7. limites de processo e saída são aplicados;
8. cancelamento/timeout mata o cgroup inteiro;
9. delete aguarda teardown antes de remover os dados;
10. status é factual;
11. crash recovery limpa resíduos identificados;
12. nenhum socket do supervisor fica acessível ao worker;
13. nenhuma porta é exposta à LAN;
14. suíte existente continua verde;
15. documentação declara kernel WSL2 compartilhado.

## 11. Roadmap após este slice

Depois do gate WSL2/processo:

1. egress mediado com `none`, `web`, `allowlist` e `packages`;
2. Chromium headed isolado, perfil por bot, CDP privado, downloads/uploads e handoff;
3. Developer Sandbox com toolchains versionados, caches deduplicados e camadas resetáveis;
4. workspace Lite robusto com inventário, quotas, lixeira, export/import/repair, DACLs e quarentena recuperável;
5. observabilidade operacional, updates assinados, rollback, compactação e soak tests;
6. spike de Hyper-V/AppContainer apenas se houver demanda por kernel separado.

Todos os slices preservam `ExecutionBackend`, o broker de capabilities e a separação entre plano de controle e worker.
