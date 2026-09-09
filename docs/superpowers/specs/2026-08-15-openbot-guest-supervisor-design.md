# OpenBot — supervisor guest Rust e sandbox Linux

> **Status:** design aprovado pelo usuário em 15/08/2026.
> **Escopo:** próxima etapa do runtime WSL2 compartilhado.
> **Pré-requisito:** `docs/superpowers/specs/2026-08-15-openbot-wsl2-runtime-design.md`.

## 1. Objetivo

Empacotar um supervisor guest real para a distribuição WSL2 gerenciada `OpenBotRuntime` e conectar o contrato host de `process.run` a um sandbox Linux efêmero. O supervisor será um binário Rust estático, executado como root somente dentro da distro dedicada, e será responsável por preparar e destruir sandboxes; o processo do bot sempre cairá para UID/GID não privilegiado.

Esta etapa deve entregar:

- crate Rust independente em `runtime/guest/supervisor/`;
- protocolo guest estrito sobre `stdin`/`stdout`, sem payload sensível em argv;
- validação de boot, lease, agente, nonce, deadline e policy digest;
- namespaces de mount, PID, IPC, UTS e rede;
- rootfs somente leitura, `/tmp` e `/run` efêmeros e bind mount de uma única home;
- cgroup v2 próprio por lease, com limites finitos;
- `no_new_privs`, capabilities removidas e seccomp allowlist;
- execução estruturada sem shell e com rede sem interfaces;
- release/timeout/cancelamento que matam o cgroup e confirmam teardown;
- provisionamento e manifesto que só aceitam o pacote da `OpenBotRuntime`;
- fallback Lite inalterado quando a distro ou o pacote não estiverem disponíveis.

Não será feita qualquer operação na distro pessoal `Ubuntu`/`Ubuntu-24.04`.

## 2. Limites desta etapa

Incluído:

- supervisor de processos e sandbox Linux;
- mount bridge controlado para uma única home Windows;
- runner host real para `process.run`;
- instalação do binário e configuração mínima dentro da imagem gerenciada;
- testes Rust unitários, testes TypeScript de protocolo e testes WSL opcionais.

Adiado:

- Chromium, CDP, display, noVNC e uploads/downloads especiais;
- egress `web`/`allowlist`/`packages`;
- toolchains adicionais e instalação de dependências;
- assinatura de release externa e inventário de CVEs completo;
- VM Hyper-V;
- uso do supervisor fora da distro `OpenBotRuntime`.

A etapa não promete isolamento de kernel: todos os sandboxes compartilham o kernel WSL2.

## 3. Arquitetura

```text
OpenBot / Windows
  RuntimeManager
    WslRuntimeAdapter
      WslGuestClient
        wsl.exe -d OpenBotRuntime --user root -- supervisor ...
                                      │ stdin/stdout JSON
                                      ▼
OpenBotRuntime
  /usr/lib/openbot/supervisor       Rust estático, root administrativo
    /run/openbot/boot.json           estado efêmero do boot
    /run/openbot/leases/<leaseId>    estado efêmero de leases
    /sys/fs/cgroup/openbot/<lease>   cgroup v2
                                      │
                                      └─ worker não privilegiado
                                           namespaces próprios
                                           rootfs read-only
                                           workspace de um agente
```

O supervisor será daemonless no primeiro release: cada comando administrativo abre uma invocação curta do binário dentro da distro. O estado de boot e de lease fica em `/run/openbot`, protegido por lock exclusivo e removido no stop. O worker é filho do comando `run`, entra no cgroup antes do `exec`, e nunca recebe o socket/estado administrativo.

A execução seguirá esta ordem:

1. host valida `ExecutionRequest` e capability;
2. host garante runtime e adquire lease;
3. host envia frame `run` pelo stdin do supervisor;
4. supervisor verifica boot/lease/policy/deadline e locka o estado;
5. supervisor cria cgroup e worker;
6. worker configura namespaces, mounts, `no_new_privs`, UID/GID e seccomp;
7. supervisor coleta stdout/stderr limitados;
8. supervisor envia resultado estruturado;
9. host envia `release` e aguarda cgroup vazio, mounts desmontados e diretório temporário removido.

## 4. Crate Rust

Arquivos:

```text
runtime/guest/supervisor/
  Cargo.toml
  Cargo.lock
  src/
    main.rs       # CLI, stdin/stdout e dispatch
    protocol.rs   # frames e payloads estritos
    state.rs      # boot, lease, lock e journal efêmero
    sandbox.rs    # fork/exec, namespaces e lifecycle
    mounts.rs     # rootfs, bind, tmpfs, proc e desmontagem
    cgroup.rs     # cgroup v2 e limites
    seccomp.rs    # no_new_privs e BPF allowlist
    error.rs      # erros públicos sanitizados
```

Dependências permitidas:

- `libc` para syscalls, `prctl`, `mount`, `umount2`, `setresuid`, `setresgid`, `unshare`, `kill` e `waitpid`;
- `serde` e `serde_json` para frames estritos;
- `sha2` somente para verificar o digest de manifesto/configuração, sem aceitar digest informado pelo worker.

O binário será compilado com perfil release, símbolos removidos e linking estático quando o toolchain Linux usado pela imagem permitir. O build não usará `build.rs` que execute comandos do host. O `Cargo.lock` ficará fixado e o pacote será identificado por versão e SHA-256 no manifesto da imagem.

## 5. Protocolo guest

O frame host/guest mantém a versão 1 e passa a aceitar `run`:

```ts
type GuestFrameType = "start" | "health" | "acquire" | "run" | "release" | "stop";

interface GuestFrame {
  protocolVersion: 1;
  type: GuestFrameType;
  runtimeBootId: string | null;
  leaseId: string | null;
  agentId: string | null;
  nonce: string;
  deadline: number;
  policyDigest: string;
  payload: Record<string, unknown>;
}
```

O transporte host adicionará `input?: Buffer` ao `WslCommandRunner`. `start` e `health` podem usar argumentos estruturados não sensíveis; `acquire`, `run`, `release` e `stop` serão enviados como JSON no stdin. O comando guest será sempre equivalente a:

```text
wsl.exe -d OpenBotRuntime --user root -- /usr/lib/openbot/supervisor --protocol-version 1 frame
```

O supervisor lerá exatamente um frame, rejeitará bytes extras, responderá com exatamente um JSON e encerrará. Limites:

- frame total: 64 KiB;
- nonce: não vazio, máximo 256 bytes;
- deadline: inteiro seguro e futuro;
- IDs: não vazios, sem NUL, máximo 256 bytes;
- payload: campos exatos por tipo;
- `policyDigest`: 64 hex bytes;
- `run` com o contrato já validado de `process.run`;
- nenhuma resposta contém path administrativo, env secreto, prompt ou stack trace.

O supervisor manterá `ReplayGuard` por boot. Frame de boot antigo, lease de agente diferente, nonce repetido, deadline expirado, policy divergente ou lease inexistente retorna erro sanitizado e não cria processo.

Payload `run`:

```json
{
  "executable": "node",
  "argv": ["script.js"],
  "cwd": ".",
  "env": {"LANG": "C.UTF-8"},
  "stdin": "...",
  "timeoutMs": 10000,
  "networkProfile": "none",
  "workspaceWindowsPath": "C:\\...\\workspaces\\agent-a"
}
```

`workspaceWindowsPath` é criado pelo adapter host a partir da home já validada; não é aceito do modelo diretamente. O supervisor só aceita path absoluto Windows sem `..`, NUL, UNC ou device prefix, cuja última pasta seja o `agentId`, e converte a unidade para uma origem DrvFs controlada. O worker recebe somente o destino `/workspace`.

## 6. Sandbox e mounts

### 6.1 Namespaces

O worker será criado em namespaces novos:

- `CLONE_NEWNS` para mounts privados;
- `CLONE_NEWPID` para PID 1 isolado;
- `CLONE_NEWIPC` para IPC;
- `CLONE_NEWUTS` para hostname efêmero;
- `CLONE_NEWNET` sem interface, rota ou DNS.

O worker não receberá `CAP_SYS_ADMIN`, `CAP_SYS_PTRACE`, `CAP_NET_ADMIN`, `CAP_NET_RAW`, `CAP_SYS_MODULE`, `CAP_MKNOD` ou outras capabilities. `PR_SET_NO_NEW_PRIVS` será aplicado antes do seccomp. O worker não terá acesso à interop Windows nem a executáveis Windows.

### 6.2 Rootfs

A imagem gerenciada conterá um rootfs base em `/usr/lib/openbot/rootfs`. O supervisor:

1. abre o diretório somente após validar o digest do manifesto ativo;
2. cria uma árvore temporária exclusiva do lease;
3. faz bind mount do rootfs e remonta-o read-only;
4. cria `/workspace`, `/tmp`, `/run`, `/proc` e `/dev` mínimo;
5. monta `/tmp` e `/run` como tmpfs com tamanho limitado;
6. monta `/proc` para o PID namespace do worker;
7. não monta `/sys`, ou monta somente uma visão read-only mínima se uma ferramenta aprovada exigir;
8. não monta `/mnt/c`, `/mnt/d`, root de workspaces, sockets administrativos ou o diretório do supervisor;
9. faz bind somente da home do agente em `/workspace`;
10. executa `pivot_root`/`chroot` e desmonta o acesso à árvore de preparação.

A origem Windows poderá ser acessada pelo supervisor administrativo somente durante a preparação do bind mount. O namespace do worker recebe o mount já restrito e não possui capacidade para criar novos mounts.

### 6.3 Executável

O supervisor resolve o identificador `executable` contra um allowlist fixo do manifesto, por exemplo `node`, `python3` e `git` quando presentes na imagem. Não aceita path absoluto, path com `..`, shell, loader arbitrário ou busca em PATH herdado. O binário final deve existir dentro do rootfs e ser regular; argv continua sendo uma lista, nunca uma string de shell.

## 7. Cgroup v2 e limites

O supervisor exige cgroup v2 montado e grava somente em uma raiz própria `/sys/fs/cgroup/openbot`. Para cada lease cria:

```text
/sys/fs/cgroup/openbot/<bootId>/<leaseId>/
```

A criação falha fechada se a raiz for symlink, se o filesystem não for cgroup2 ou se qualquer arquivo obrigatório estiver ausente. O supervisor aplica limites finitos antes de iniciar o worker:

- `pids.max`: limite do runtime;
- `memory.max` e `memory.swap.max` conforme policy;
- `cpu.max` conforme policy;
- `io.max` quando suportado;
- `cgroup.kill` em timeout, cancelamento, release ou erro fatal.

O resultado só é sucesso depois de confirmar que não existem PIDs no cgroup. Falha ao matar ou esvaziar o cgroup marca o runtime como unhealthy e impede nova aquisição.

## 8. Seccomp

O filtro será instalado no worker após namespaces, mounts, UID/GID e `no_new_privs` e antes do `exec`. A allowlist será construída por classe de imagem e não por entrada do modelo. O filtro deve bloquear, no mínimo:

- `mount`, `umount2`, `pivot_root` após a preparação;
- `unshare`, `setns`, `clone3` e criação de novos namespaces;
- `ptrace`, `process_vm_readv`, `process_vm_writev`;
- `bpf`, `perf_event_open`, `init_module`, `finit_module`, `delete_module`;
- `mknod`, `kexec_load`, `reboot`, `swapon`, `swapoff`;
- chamadas de keyring e acesso a dispositivos não necessários;
- qualquer syscall dependente de interop Windows.

A lista também deve conter os syscalls mínimos para o executável aprovado funcionar. Se a allowlist não puder ser instalada, o processo não inicia. O teste do filtro usará workers que tentam cada syscall proibido e verificará término por `SIGSYS`/erro equivalente.

## 9. Estado e teardown

`start` verifica WSL2 guest, cgroup2, rootfs, seccomp configurável e layout; gera `runtimeBootId` novo e grava `boot.json` com modo `0600`. `health` só retorna `ok: true` se todos esses pré-requisitos continuarem presentes.

`acquire` cria apenas o registro de lease, exclusivo por `leaseId`, com `agentId`, policy digest, expiration e estado `allocated`. Não cria processo persistente.

`run` permite uma execução por lease por vez. O supervisor rejeita concorrência duplicada, aplica deadline e registra PID/cgroup. Em erro ou timeout:

1. envia SIGTERM ao cgroup;
2. aguarda grace period;
3. envia SIGKILL por `cgroup.kill`;
4. desmonta em ordem inversa;
5. confirma ausência de processos e mounts;
6. retorna `process_timeout`, `process_aborted` ou `teardown_incomplete`.

`release` repete teardown idempotente. `stop` bloqueia novas operações, libera todos os leases, mata cgroups órfãos identificados pelo boot, desmonta árvores temporárias e só retorna sucesso com estado vazio. O host só chama `wsl.exe --terminate OpenBotRuntime` depois de receber sucesso do frame guest `stop`; se o frame falhar, a distro não é terminada silenciosamente e o runtime fica unhealthy. Nunca remove uma home persistente como parte de `stop`.

## 10. Integração host

Modificar:

```text
src/execution/runtime/contracts.ts       # frame run e lease/process metadata
src/execution/runtime/wsl/transport.ts  # frame stdin, respostas estritas
src/execution/runtime/wsl/provisioner.ts # pacote, manifesto e config guest
src/execution/runtime/wsl/driver.ts      # --user root e client compartilhado
src/execution/runtime/wsl/process-backend.ts
src/execution/runtime/wsl/guest-runner.ts # runner real de process.run
src/execution/runtime/agent-backend.ts   # workspaceRoot no runner
src/main.ts                              # runner real por agente
```

`ExecutionBackend.execute(request, signal)` permanece inalterado. A implementação default substituirá apenas o `unavailableProcessRunner` quando o runtime real estiver configurado; injeções de teste continuam funcionando.

`WslGuestClient` será compartilhado pelo adapter e pelo runner. `WslProcessRunner` receberá `agentId` e `workspaceRoot` no construtor, validará a home antes de formar o frame `run` e enviará o lease recebido pelo manager. `AgentRuntimeBackend` continuará aceitando um runner injetado nos testes; o bootstrap de produção criará um runner real por agente para não compartilhar acidentalmente o path de uma home.

O host deve:

- resolver e validar `workspaceRoot` com `WorkspaceSandbox`/`AgentHomeStore` antes de montar;
- enviar somente a home do `agentId` corrente;
- não derivar path a partir de texto não validado do modelo;
- manter `runtimeProcessRunner` injetável;
- traduzir erro guest para códigos existentes e sanitizados;
- não expor stderr bruto do supervisor ao provider;
- abortar o runner quando o `AbortSignal` for cancelado;
- sempre liberar lease em `finally`.

## 11. Empacotamento e instalação

O pacote guest terá:

```text
runtime-package/
  manifest.json
  usr/lib/openbot/supervisor
  usr/lib/openbot/rootfs/...
  etc/openbot/guest-policy.json
  etc/wsl.conf
```

`wsl.conf` da distro dedicada desabilitará interop e automount geral para o worker. O supervisor usará somente o mount bridge explícito e temporário para a home autorizada. A configuração não será instalada em distro cujo nome não seja exatamente `OpenBotRuntime`.

O provisioner:

1. valida archive dentro de `layout.staging`;
2. valida manifesto, versão, digest do supervisor e schema;
3. importa em `layout.distro` usando `--import OpenBotRuntime ... --version 2`;
4. verifica que o binário existe, é regular e responde `health`;
5. só então promove `current`;
6. mantém `previous` até health passar;
7. nunca executa `--unregister`, `--terminate`, `--import` ou `--set-default` para uma distro pessoal.

Se cargo, WSL2, a imagem ou o pacote guest não estiverem disponíveis, os testes host continuam reportando `runtime_unavailable`; o Lite permanece operacional.

## 12. Testes

### Rust unitários

- parsing com campos extras, JSON truncado, bytes extras e frame grande;
- replay, deadline, boot id, lease e agent mismatch;
- validação de path Windows e allowlist de executáveis;
- detecção de cgroup v1/ausente/symlink;
- geração dos mounts e teardown idempotente;
- policy seccomp contém syscalls proibidos;
- limites rejeitam zero, negativos e valores acima do máximo.

### TypeScript

- `WslCommandRunner` transmite stdin e não coloca frame em argv;
- driver sempre usa `OpenBotRuntime` e `--user root`;
- response guest inválida vira `runtime_protocol_error`;
- `run` preserva workspace/agent/lease corretos;
- cancelamento libera lease e trata falha de teardown;
- pacote inválido, digest divergente e rootfs ausente falham fechado;
- distro pessoal nunca recebe comando de import/terminate;
- Lite e criação de agente não iniciam runtime.

### Integração Linux/WSL2 opcional

Quando `OpenBotRuntime` estiver instalada:

- `health` falha sem cgroup2/rootfs/seccomp;
- processo vê somente `/workspace`, `/tmp`, `/run`, `/proc` próprio e rootfs read-only;
- `/mnt/c`, outra home, supervisor, gateway e keystore não são acessíveis;
- `ip link` não mostra interface utilizável;
- `mount`, `unshare`, `setns`, `ptrace`, `mknod`, `bpf` e interop falham;
- timeout e cancelamento deixam zero PID e zero mount do lease;
- dois agentes não cruzam arquivos nem cgroups;
- nenhum listener é exposto à LAN.

A integração real não será executada contra `Ubuntu` ou `Ubuntu-24.04`.

## 13. Critérios de aceite

1. O crate Rust compila com lockfile e manifesto verificáveis.
2. O supervisor só executa na `OpenBotRuntime` e como canal administrativo root.
3. Frames sensíveis não aparecem em argv.
4. Um lease cria sandbox sem processo permanente por bot.
5. O worker não possui capabilities para criar namespaces/mounts/cgroups.
6. O rootfs é read-only e a home é a única persistência montada.
7. Rede não possui interface utilizável.
8. Cgroup e seccomp são pré-condições, não otimizações.
9. Timeout, abort e release matam e confirmam o cgroup.
10. Falha de teardown impede falso estado `ready`.
11. Uma distro pessoal nunca é modificada.
12. Lite funciona sem `OpenBotRuntime`.
13. `npm test` e `npm run build` continuam verdes.
14. As limitações de kernel WSL2 compartilhado continuam documentadas.
