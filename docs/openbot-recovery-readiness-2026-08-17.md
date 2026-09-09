# Recuperação e prontidão operacional local

Este documento é o runbook para manter, diagnosticar e recuperar uma instalação
local do OpenBot no Windows. Ele parte do escopo de uso pessoal: sem telemetria,
serviço remoto, atualização automática ou infraestrutura comercial.

## Ações rápidas

Feche o OpenBot antes de criar ou restaurar backups. No checkout de manutenção:

```powershell
npm run recovery:status
npm run recovery:backup
npm run recovery:verify -- --backup <pasta-do-backup>
npm run recovery:restore -- --backup <pasta-do-backup> --yes
npm run recovery:diagnostics -- --output <arquivo-json>
```

Em uma instalação empacotada, use `Recovery-OpenBot.cmd` com os mesmos comandos:

```powershell
Recovery-OpenBot.cmd
Recovery-OpenBot.cmd backup
Recovery-OpenBot.cmd verify-backup --backup <pasta-do-backup>
Recovery-OpenBot.cmd restore --backup <pasta-do-backup> --yes
Recovery-OpenBot.cmd diagnostics --output <arquivo-json>
```

Sem subcomando, o wrapper mostra o status da instalação.

Backups manuais ficam na pasta `backups` da raiz local de dados, salvo quando
uma raiz alternativa é informada.

## O que o status informa

O status apresenta somente metadados operacionais:

- versão ativa e versão anterior;
- raízes de dados roaming e local;
- existência da versão ativa e do registro de processos;
- saúde do gateway local;
- último backup e última falha registrada.

Valores que se pareçam com token, senha, segredo, API key ou Bearer são
redigidos. O status nunca lê nem imprime o conteúdo das credenciais.

## Garantias de backup e restore

- O Recovery Center aceita somente uma raiz de instalação gerenciada e com
  raízes de dados explícitas.
- Backup e restore recusam execução enquanto um gateway OpenBot ainda responde.
- Cada entrada do backup possui SHA-256; entrada ausente, duplicada, inesperada
  ou adulterada encerra a operação.
- Restore exige `--yes` e cria um backup pré-restauração antes de alterar dados.
- A promoção do restore é transacional: uma falha devolve o destino anterior.
- Configuração, SQLite, credenciais locais e workspaces permanecem no escopo do
  backup; os testes nunca usam o AppData real.

`restore` repõe dados, mas não troca a versão executável do OpenBot. Antes de
restaurar, confira no resultado de `verify-backup` se `activeVersion` corresponde
à versão instalada. Para voltar aplicação e dados em conjunto, use
`Rollback-OpenBot.cmd`.

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
npm run verify:local-provider-live
npm run verify:skills-mcp
npm test -- --maxWorkers=1 --no-file-parallelism
```

`verify:data-recovery` cria SQLite real em modo WAL, configuração, credenciais
de fixture e workspace em `%TEMP%`; depois valida backup, adulteração, restore e
`PRAGMA integrity_check`.

`verify:local-provider-live` consulta somente LM Studio e Ollama em loopback.
Sem serviço ativo, retorna `SKIP`. Para exigir um provider, defina
`OPENBOT_REQUIRE_LOCAL_PROVIDER=1`. Para incluir stream curto, cancelamento e
reconexão, defina também `OPENBOT_LOCAL_PROVIDER_CHAT=1`.

## Baseline validado nesta entrega

- typecheck e build aprovados;
- suíte serial: 94 arquivos, 992 testes aprovados, 1 teste ambiental ignorado;
- gate de recuperação SQLite: 2 de 2 cenários aprovados;
- Skills/MCP: 149 testes focados e 3 cenários core aprovados;
- Electron E2E: GREEN, com processos ausentes, portas livres e temporários removidos;
- smoke do atalho: janela aberta sem console, segunda instância encerrada corretamente,
  porta liberada e token ausente dos logs;
- LM Studio/Ollama: `SKIP` factual porque nenhum dos dois estava ativo.

## Limites

O gate live não comprova geração local enquanto LM Studio ou Ollama estiverem
desligados. O runtime WSL não foi alterado nesta entrega; seu gate live continua
separado. Assinatura pública, instalador comercial, telemetria remota e suporte
multiusuário hostil permanecem fora do escopo.
