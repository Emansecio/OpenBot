# Recuperação e prontidão operacional local

Este documento é o runbook para manter, diagnosticar e recuperar o OpenBot
executado a partir deste checkout no Windows. Ele parte do escopo de uso
pessoal: sem telemetria, serviço remoto, atualização automática ou
infraestrutura comercial.

## Ações rápidas

Feche o OpenBot antes de criar ou restaurar backups. Na raiz do checkout:

```powershell
npm run recovery:status
npm run recovery:backup
npm run recovery:verify -- --backup <pasta-do-backup>
npm run recovery:restore -- --backup <pasta-do-backup> --yes
npm run recovery:diagnostics -- --output <arquivo-json>
```

`--data-root` e `--local-data-root` apontam para outras raízes de dados;
`--backup-root` escolhe onde os backups são gravados. Sem essa opção, eles ficam
na pasta `backups` da raiz local de dados (`%LOCALAPPDATA%\OpenBot\backups`).

## O que o status informa

O status apresenta somente metadados operacionais:

- raízes do checkout e dos dados roaming e local;
- presença do build (`dist/entry.js`), da raiz de dados e do registro de processos;
- saúde do gateway local: se responde, se pertence a este checkout e se usa o
  build atual.

Valores que se pareçam com token, senha, segredo, API key ou Bearer são
redigidos. O status nunca lê nem imprime o conteúdo das credenciais.

## Garantias de backup e restore

- Backup e restore recusam execução enquanto um gateway OpenBot ainda responde,
  inclusive um supervisor registrado em `process.json` durante o reinício do
  worker.
- Cada entrada do backup possui SHA-256; entrada ausente, duplicada, inesperada
  ou adulterada encerra a operação.
- Restore exige `--yes`, valida o backup e cria um backup pré-restauração antes
  de alterar dados.
- A troca é transacional: se falhar no meio, cada pasta substituída é devolvida;
  se a devolução também falhar, o resultado informa onde ficou a cópia anterior.
- Configuração, SQLite, credenciais locais e workspaces entram no backup; os
  testes nunca usam o AppData real.

`restore` repõe dados, não o código. Para voltar também o código, use o controle
de versão do checkout.

## Diagnóstico e logs

O comando `diagnostics` grava um JSON local com status e caudas limitadas dos
logs. Até oito arquivos `.log` são incluídos, com no máximo 64 KiB por arquivo,
sempre após redação de padrões sensíveis.

O gateway limita cada log a 2 MiB durante a própria execução e mantém duas
cópias rotacionadas. Falha de escrita do log não derruba o gateway. O launcher
usa um log exclusivo por invocação, remove-o no sucesso e retém falhas por até
sete dias.

## Gates de manutenção

```powershell
npm run verify:data-recovery
npm run verify:skills-mcp
npm test
```

`verify:data-recovery` cria SQLite real em modo WAL, configuração, credenciais
de fixture e workspace em `%TEMP%`; depois valida backup, adulteração, restore e
`PRAGMA integrity_check`. Os demais gates estão em
[`verification-gates.md`](verification-gates.md).
