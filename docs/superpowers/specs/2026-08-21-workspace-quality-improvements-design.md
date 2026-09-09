# Qualidade do espaço por bot — sete melhorias propostas

> **Status:** proposta (2026-08-21). Nada disto está implementado.
> **Leitor:** engenheiro do OpenBot.
> **Origem:** comparativo "Qualidade do espaço por bot" (OpenBot local 4.2 vs CopilotKit 3.9) e auditoria de `src/execution/` em 2026-08-21.
> **Premissa:** todas as sete são resolvidas em código — sem wizard, sem feature do Windows, sem tela nova, sem mudança nos contratos HTTP congelados (`SandForeverBoxStatus` segue `{ vncUrl: null, windows: [] }`).

## 0. Resumo

| # | Melhoria | Buraco que fecha | Nota hoje | Esforço |
|---|---|---|---|---|
| 1 | Pastas do usuário opt-in por bot (redirect + grant) | Desktop/Documents/Downloads reais compartilhados entre todos os bots | 3 | M |
| 2 | Audit-before-act + política de ação declarativa | Broker `always` executa sem registro nem regra | 3 | M |
| 3 | Snapshot/restore da home | Sem "reset do computador" antes de operação destrutiva | — | P |
| 4 | Usuário Linux por bot no WSL | Distro compartilhada, supervisor roda como root | 4 | G |
| 5 | Segredos escopados por `agentId` | Keystore global: bot A lê segredo do bot B | — | P |
| 6 | Quota por pasta + drift de inventário | Quota única global; sem detecção de divergência | — | P |
| 7 | `layoutVersion` como migração real | Manifest com versão divergente **falha** em vez de migrar | — | P |

Onda sugerida: **1 → 2 → 3** (fecha o gap contra o `/workspace` do CopilotKit), depois **5 → 6 → 7**, por último **4**.

---

## 1. Pastas do usuário: opt-in por bot, redirect por padrão

### Problema
`SHARED_USER_DIRECTORIES` (`src/execution/user-files.ts:6`) monta Desktop, Documents, Downloads, Pictures, Videos e Music **reais** do usuário com leitura e escrita para todo bot (`loadSharedUserMounts`, `user-files.ts:112`). Dois bots criados pelo usuário leem e escrevem o mesmo `Documents`. O único isolamento de arquivos de verdade é a home NTFS + DACL (`home-acl.ts`). É o que o comparativo usa para dar nota 3 em Arquivos e perder do volume `/workspace`.

Já existe o padrão certo no código: `agentSharedDownloadRoot` (`user-files.ts:31`) redireciona Downloads para `Downloads\OpenBot\<agentId>\Downloads`.

### Proposta
1. **Redirect por padrão para todas as pastas compartilhadas**, não só Downloads: `Documents\OpenBot\<agentId>\Documents`, etc. O bot continua "vendo" `Desktop\`, `Documents\`… no seu namespace, mas resolve na pasta dele. O overlay já está semipronto: `resolveAgentVisiblePath` com `options.overlay` (`user-files.ts:135`) trata mount inexistente caindo na home — estender para resolver no redirect.
2. **Grant opt-in por bot por pasta** para enxergar a pasta **real**: `none` (default) | `read` | `write`, com expiração opcional. Persistido em `.openbot/grants.json` dentro da home (entra no DACL e no archive).
3. **Pedido de acesso via tool-card existente**: quando o bot tenta acessar pasta sem grant, o broker devolve decisão `ask` com card "Bot quer acesso de leitura a Documents". Zero burocracia no default (regra §2.1 do spec da home) — quem não pede a pasta real nunca vê card.
4. `SHARED_USER_DIRECTORIES` deixa de ser lista de mounts automáticos e vira catálogo de redirects; `loadSharedUserMounts` só abre mounts reais para pastas com grant ativo.

### Não-objectivos
- Nenhuma tela de configuração de pastas. Grant nasce do card de permissão, morre por expiração ou pelo usuário apagando o bot.
- Downloads do browser host continua pousando em `agentSharedDownloadRoot` (contrato do host não muda).

---

## 2. Audit-before-act + política de ação declarativa

### Problema
`src/execution/broker.ts:238-255`: `never` → negado; `ask` → card; `always` → `runIdempotently` **sem nenhum registro**. Não há trilha do que cada bot fez, nem regra declarativa por ferramenta/caminho. O CopilotKit ganha confiança operacional exatamente aqui (CEL + audit row antes de chamar o computer).

### Proposta
1. **Audit log append-only por bot**: `.openbot/audit/audit-YYYYMMDD.jsonl` dentro da home (rota pelo sandbox, herda quota e DACL). Cada linha: `{ ts, agentId, tool, args resumidos, decisão (allow/deny/ask→grant), duração, erro? }`. Gravado **antes** da execução (write-ahead), com rotação por dia e teto de arquivos pela quota.
2. **Política declarativa** em `.openbot/policy.json` (semeada com default sensato, editável por config global `%APPDATA%\OpenBot\policy.json` com override por bot):
   ```json
   {
     "rules": [
       { "match": { "tool": "file.*", "path": "**" }, "effect": "allow" },
       { "match": { "tool": "file.write", "path": "Desktop/**" }, "effect": "ask" },
       { "match": { "tool": "command.run", "path": "**" }, "effect": "allow", "rateLimit": "30/min" }
     ],
     "default": "ask"
   }
   ```
   Matcher de path glob simples (sem CEL no primeiro slice — mesmos casos, JSON legível). Avaliação: primeira regra que casa vence; `ask` usa o card existente; `never` segue sendo kill-switch global.
3. **Idempotência preservada**: audit grava a decisão, `runIdempotently` continua deduplicando retry — retry não duplica linha de execução, só de decisão.

### Não-objectivos
- Sem tela de auditoria. O log existe para o usuário abrir (e para o próprio bot ler via `file.read`, que é útil).
- Sem política por conteúdo de arquivo — só por tool + path + rate.

---

## 3. Snapshot/restore da home

### Problema
`home-archive.ts` já tem export/import versionado (`HOME_ARCHIVE_VERSION = 1`), staging atômico (`materializeHomeArchive` + `discardStage`) e validação de path. Falta o gesto de "voltar o computador ao estado anterior" — o análogo do `reset` do CopilotKit, barato porque tudo é NTFS local.

### Proposta
1. **`snapshotHome(agentId)`**: export para `%LOCALAPPDATA%\OpenBot\snapshots\<agentId>\<seq>\` usando `exportHomeArchive` (mesmo manifest, mesma validação). Retenção: últimos N=5 por bot, mais antigo apagado (respeitando quota global de snapshots).
2. **`restoreHome(agentId, seq)`**: quarentena atômica da home atual (rename para `.openbot/trash`-style staging fora do root) → `materializeHomeArchive` em stage → swap → discard do antigo. Mesmo padrão de quarentena do lifecycle existente; falha em qualquer passo = rollback sem perda.
3. **Gatilhos**: (a) comando do usuário no roster ("Restaurar computador do bot"); (b) automático antes de restore/import de archive destrutivo. Snapshot **não** é automático antes de cada turn (custo de disco) — é gesto explícito.
4. Snapshots ficam **fora** da home (não contam na quota do bot) e fora do archive exportado pelo usuário.

---

## 4. Usuário Linux por bot no WSL

### Problema
O provisioner sobe o supervisor como `--user root` na distro compartilhada (`src/execution/runtime/wsl/provisioner.ts:435-456`) e o `guest-runner` executa comandos do bot no mesmo contexto. Um bot pode ler o workspace montado de outro se a política do supervisor falhar; não há isolamento de identidade POSIX.

### Proposta
1. **`openbot-<agentId>`** criado sob demanda no primeiro uso do runtime pelo bot (`useradd --system --home <mount da home>`), idempotente, catálogo de usuários no manifest do provisioner.
2. **Supervisor faz setuid** para o usuário do bot antes de executar `command.run`; root fica só no bootstrap/health (como hoje).
3. **Permissão POSIX alinhada à DACL**: home do bot = `0700` do usuário dele; mounts de outros bots invisíveis por permissão, não só por política do supervisor. Defense-in-depth sobre a DACL NTFS (que continua sendo a barreira primária no host).
4. **Fail-closed**: se `useradd` falhar, recusa execução de comando com erro claro — nunca degrada para root compartilhado.
5. Env/secrets do bot injetados só no processo setuidado (sinergia com melhoria 5).

### Não-objectivos
- Distro por bot: recusa consciente (densidade é vantagem nossa — um gateway, um WSL, um Electron).
- Kernel isolation real: fora de escopo no Windows client; o documento de posicionamento já assume isso.

---

## 5. Segredos escopados por `agentId`

### Problema
`SecretsFileShape = Record<string, EncryptedEntry>` (`src/keystore/index.ts:61`) é um namespace global: qualquer bot que consiga ler o secrets file (ou pedir via tool) enxerga credenciais de todos.

### Proposta
1. Novo shape: `Record<agentId, Record<key, EncryptedEntry>>`. Migração no boot: arquivo no formato antigo vira escopo `openbot-default` (ou escopo do único agente existente no config), com backup `.bak`.
2. `box.secrets.set/get` ganham escopo implícito do `agentId` da chamada (o broker já sabe quem chamou). Nenhum bot lê escopo de outro; leitura cruzada só por grant explícito do usuário (mesmo mecanismo de ask do item 1).
3. Injeção de env no `command.run`/browser host usa só o escopo do bot ativo.

---

## 6. Quota por pasta + drift de inventário

### Problema
`DEFAULT_WORKSPACE_QUOTA` (`src/execution/quota.ts:273`) é teto único da home. Downloads pode starvar Projects. E nada detecta divergência entre o inventário (`home-inventory.ts`) e o disco real (editores, antivírus, o próprio usuário mexendo fora do app).

### Proposta
1. **Quotas por pasta**: `Downloads` (menor), `Desktop/Documents` (médio), `Projects` (maior), `.openbot/audit` (pequeno, com teto próprio para o audit não comer a quota do bot). `WorkspaceQuota` já aceita opções — virar mapa `{ prefixo → limites }` com fallback ao default.
2. **Drift check no boot**: `inventoryHome` vs `calculateWorkspaceUsage` por pasta; divergência acima de limiar (ex.: >5% de bytes ou >50 arquivos) grava `drift` em `home.json` e aparece no card de status do bot no roster (sem tela nova). Bot com drift não é bloqueado — é sinalizado; `repair` do lifecycle existente resolve.
3. Quota excedida continua com a mesma mensagem acionável de hoje (`quota.ts:205`), agora apontando a pasta específica.

---

## 7. `layoutVersion` como migração real

### Problema
`home.ts:713`: manifest com `layoutVersion !== HOME_LAYOUT_VERSION` **falha** a validação. Qualquer evolução do layout (novas pastas, novo `Bem-vindo.md`, grants/policy semeados pelas melhorias 1–2) quebraria bots existentes — ou exigiria bump manual.

### Proposta
1. **Migração aditiva passo-a-passo**: `vN → vN+1 → … → atual`, cada passo idempotente e só-adiciona (cria pasta faltante, semeia arquivo só se ausente — mesmas regras do seed original, `home.ts` §3).
2. **`Bem-vindo.md` versionado com hash**: manifest passa a guardar `welcomeHash`; migração só sobrescreve se o bot nunca editou o arquivo.
3. Manifest ganha `migratedAt` + `migrationLog[]` (apendado a cada passo) para diagnóstico.
4. Falha de migração = erro claro com o passo que falhou (padrão dos erros atuais do `ensure`), nunca reseed silencioso.

Este item é pré-requisito operacional dos itens 1 e 2: é ele que permite semear `grants.json` e `policy.json` em homes já criadas sem quebrar nada.

---

## Regras que nenhuma melhoria quebra

Herdadas do spec da home (2026-08-13) e mantidas como critério de aceite:

1. Zero burocracia no default — card de permissão só quando o bot pede a pasta real ou a política manda `ask`.
2. Tudo interno — o processo cria/migra/audita; o usuário não configura nada para ganhar as melhorias.
3. Sem tela nova — audit, drift e snapshots aparecem nos cards e no roster existentes.
4. Contratos HTTP congelados — nada de campo extra em `SandForeverBoxStatus`.
5. Nunca apagar arquivo do bot — migração e restore sempre via quarentena/staging com rollback.

## Métrica de sucesso

Rodar o comparativo de novo após a onda 1: a dimensão **Arquivos** do OpenBot local sai de 3 para 5 (redirect + grant por bot = isolamento equivalente ao volume `/workspace`, mantendo a metáfora de casa que ainda é nossa vantagem em "Casa do bot" e "Default ao criar"), e **Governança** sai de 3 para 4–5 (audit-before-act + política). Média esperada: ≥ 4.6.
