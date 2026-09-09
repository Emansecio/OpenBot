# OpenBot guest runtime

> Visão consolidada do ambiente prático, browser, lifecycle e evidências: [`docs/practical-bot-environment-final.md`](../../docs/practical-bot-environment-final.md).
>
> Skills e MCP usam o runtime Node compartilhado do host e não criam guest ou distro por bot: [`docs/shared-skills-mcp-chat.md`](../../docs/shared-skills-mcp-chat.md).

`supervisor/` é um crate Rust executado exclusivamente dentro da distribuição WSL2 gerenciada `OpenBotRuntime`.

Build do binário em ambiente Linux/cross dedicado:

```bash
cargo build --manifest-path runtime/guest/supervisor/Cargo.toml --release --target x86_64-unknown-linux-musl
```

## Pipeline WSL reproduzível

Em Windows, o pipeline sem interação baixa o minirootfs Alpine 3.24.1 da
origem oficial, verifica o SHA-256 fixado, usa somente a distro descartável
`OpenBotBuild`, compila o supervisor como static PIE, prepara o rootfs interno
e a base externa importável e deixa o pacote em
`%LOCALAPPDATA%\OpenBot\runtime\staging`:

```powershell
.\scripts\build-runtime-guest.ps1
```

`OpenBotBuild` é descartável e o pipeline a remove ao final. Se uma execução
for interrompida, a limpeza explícita continua limitada à distro de build:

```powershell
.\scripts\build-runtime-guest.ps1 -Action Cleanup
```

O script não termina, importa, unregistera ou altera as distros pessoais
`Ubuntu`/`Ubuntu-24.04`.

Validação prática reexecutada em 2026-08-16:

- build WSL reproduzível passou;
- `OpenBotRuntime` foi instalada e validada com `seccomp` ativo;
- `process.run`, timeout, abort, cleanup parcial idempotente, recovery e teardown passaram no guest real;
- `OpenBotBuild` foi removida via `-Action Cleanup`;
- `Ubuntu` e `Ubuntu-24.04` permaneceram intactas e paradas.

O gate live completo agora é reproduzível pelo comando versionado
`npm run verify:runtime-wsl-live`. Ele cria somente uma distro aleatória
`OpenBotRuntimeLive-<guid>` e um `TempRoot` próprio, valida package/digest,
install/promotion/rollback, `process.run`, identidade não-root, seccomp, rede bloqueada, timeout, abort, cleanup parcial, recuperação de lease
órfã e teardown; ao final emite um resumo JSON `GREEN`/`RED` e prova que as
distros pessoais não mudaram. O gate exige Windows com WSL2 e um pacote já
empacotado (ou `OPENBOT_GUEST_PACKAGE` explícito); não usa `OpenBotBuild`.

O resultado esperado é um ELF Linux x86-64 estático. O supervisor instala o filtro seccomp pelo syscall nativo `seccomp(2)` e falha fechado se namespaces, mounts, cgroups ou seccomp não puderem ser aplicados.

Digests validados no gate live:

- `supervisorDigest`: `sha256:35cc7499f7df729ccf440f0f230b4196ad3ef7c792346a9707d29775198308cc`
- `rootfsDigest`: `sha256:9997f75923a62c24ada384f6dc1659e0374d9d9689faafd14c5e5585755fec63`
- `archiveDigest`: `sha256:b7653bcc9cfbd74a38ff040f0ab840891c780396baf5de39b8672beddc240266`

O pacote de runtime deve conter:

```text
etc/passwd
bin/sh
sbin/mount.drvfs
usr/lib/openbot/supervisor
usr/lib/openbot/rootfs/
etc/openbot/guest-policy.json
etc/wsl.conf
```

Empacotamento validado (a partir da raiz do repositório):

```powershell
$env:OPENBOT_GUEST_BINARY = "C:\caminho\para\supervisor"
$env:OPENBOT_GUEST_BASE_ROOTFS = "C:\caminho\para\base-rootfs-wsl"
$env:OPENBOT_GUEST_ROOTFS = "C:\caminho\para\rootfs"
$env:OPENBOT_GUEST_PACKAGE = "runtime\guest\openbot-runtime-package.tar"
npm run package:runtime-guest
```

`OPENBOT_GUEST_BASE_ROOTFS` é a distribuição mínima externa importável pelo
WSL; ela é copiada primeiro e deve fornecer uma conta `root` uid/gid 0 em
`/etc/passwd`, `/bin/sh` e `/sbin/mount.drvfs`. O rootfs de execução informado
em `OPENBOT_GUEST_ROOTFS` permanece separado em `/usr/lib/openbot/rootfs`.

O comando exige um ELF Linux x86-64 (ET_EXEC/PIE), rejeita componentes de
caminho controlados por symlink e rejeita links de ambos os rootfs que escapem
da raiz ou apontem para um destino inexistente. A única exceção dangling é
`/sbin/mount.drvfs -> /init` na base externa, pois o WSL injeta `/init` no boot.
Ele produz `manifest.json` ao lado do
`.tar`, que é o manifesto consumido pelo driver WSL, além das cópias internas
usadas pelo guest. O staging temporário é removido mesmo quando o `tar` falha;
o `--mtime` e a normalização de timestamps tornam o arquivo reproduzível quando
suportados pela implementação de `tar` instalada.

`rootfsDigest` é calculado sobre a árvore final em
`usr/lib/openbot/rootfs`, depois que os diretórios de montagem (`workspace`,
`tmp`, `run`, `proc` e `dev`) são adicionados. Essa é a mesma árvore e o mesmo
formato de digest verificados pelo supervisor dentro do guest; o manifesto não
usa apenas o digest do diretório-fonte antes da montagem do pacote.

O binário não deve ser copiado para uma distribuição pessoal. O provisioner do host valida `OpenBotRuntime`, o manifesto e o digest do binário antes de promover uma imagem.

Antes de montar um workspace, o host valida de forma fail-closed que ele é exatamente a home canônica `<workspacesRoot>/<agentId>`. A raiz gerenciada e cada componente são resolvidos por `realpath`; paths externos, symlinks, junctions e reparse points são rejeitados antes de chamar o guest.

A validação atual usa `cargo fmt --check`, `cargo check --release --tests` para Linux, `npm run typecheck`, `npm run build` e a suíte Vitest completa. O estado final e a evidência operacional estão em [`docs/phase-2-local-execution-status.md`](../../docs/phase-2-local-execution-status.md). Os testes TypeScript do contrato host não chamam as distribuições Ubuntu existentes.
