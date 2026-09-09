# Grupos locais de bots no OpenBot

**Leitor:** um implementador (humano ou modelo) sem o histórico desta conversa.

**Ação depois de ler:** implementar exatamente este contrato. Se algo não estiver aqui, não invente. Releia a seção correspondente. O plano de tarefas está em `docs/superpowers/plans/2026-09-03-local-bot-groups.md`.

**Fontes de evidência:** capturas reais do fluxo “criar grupo” (fonte visual canônica, spec §11); cruzamento no GrokBot 0.36.0 em `C:\Users\User\Downloads\grokbot_app` (`index-ClQIHGtc.js`, `chunk-new-chat-bar-7g9Ki6Z_.js`, i18n `chunk-core-TZPxtqo-.js` / `chunk-chat-BouG3H13.js` / `chunk-agents-B_wsHPsC.js`, coordinator `main.cjs`); documento `GROK_BOT_GROUPS.md` (RPC/protobuf — não copie rooms cloud); host OpenBot atual (roster, A2A, `create_bot`, overlay 0.16).

---

## 1. Produto em uma frase

Um **grupo** é um item do roster local, igual a um bot na sidebar, cujo chat é compartilhado; os falantes são **bots que já existiam no roster no momento em que foram colocados no grupo**. O grupo não pensa. Os membros pensam, cada um com o próprio modelo, home e tools.

---

## 2. Vocabulário (use só estes nomes)

| Nome | Significado neste documento |
|---|---|
| **Bot** | Agente permanente do roster (`isGroup` falso). Tem home, conversa privada, modelo, tools. |
| **Grupo** | Agente permanente do roster com `isGroup` verdadeiro. Tem home e conversa, mas **não** roda inferência no próprio id. |
| **Membro** | Bot cujo id está em `memberIds` do grupo. Continua existindo fora do grupo. |
| **Transcript do grupo** | Histórico da conversa compartilhada, gravado no `agentId` do grupo. |
| **Conversa privada** | Histórico 1:1 de um bot com o usuário. Grupo **não** escreve aqui. |
| **Ator** | O membro que está falando neste turno. Inferência, tools e home são do ator. Transcript é do grupo. |
| **Pasta da sidebar** | Feature *outra* do GrokBot 0.36 (`nlt`: `{ id, name, agentIds, isCollapsed }`). **Fora de escopo.** |

Se um texto chamar o grupo de “canal”, “sala” ou “room”, é o mesmo objeto **Grupo**. O GrokBot 0.36 chama a criação de “channel” no erro (`Couldn't create the channel`) e de “group chat” no picker (`Create group chat`). No OpenBot o nome visível é **grupo**.

---

## 3. Duas UIs no GrokBot 0.36 — não misture

O app 0.36 tem **dois** conceitos de “grupo”. Só o segundo é este produto.

### 3.1 Pasta da sidebar (NÃO implementar)

No renderer 0.36 existe um schema de pastas (`nlt`) com `{ id, name, agentIds[], isCollapsed }`, `withFolds` e um id sentinela para bots sem pasta. Isso só organiza a lista. Bots numa pasta **não** conversam entre si.

**Não implemente pastas, collapse, drag-and-drop de sidebar, nem o schema `nlt`.**

### 3.2 Canal / group chat (implementar o equivalente local)

Os prints só existem com **`isChannelsEnabled === false`**. Se essa flag estiver ligada, o 0.36 **esconde** `create-group` e o clique num bot vira 1:1. Não implemente o modo channel.

Dois caminhos de `createGroup` no 0.36 — só o primeiro é o produto:

| Caminho | Arquivo | O que faz | OpenBot |
|---|---|---|---|
| Compose `hxt` (prints) | `index-ClQIHGtc.js` | Nome derivado `_vt(membros, currentUserName)`, `description: ""`, depois `selectAgent` + `sendFirstMessage` | **Sim** |
| Dialog `sand-new-channel-dialog` 520px | mesmo index | Nome digitado; erro `DImcpZ` “Não foi possível criar o canal.” | **Não** |

RPC no coordinator: `createGroup({ name: string, description?: string, memberAgentIds: string[] })` — o cliente 0.36 **sempre manda `name`**. Overlay OpenBot pode omitir; o host deriva (§7).

Barra: `chunk-new-chat-bar-7g9Ki6Z_.js`. Classes `sand-new-chat-bar`, `sand-new-chat-chip`, `sand-new-chat-menu`, `sand-new-chat-row`. Teto de chips: constante **`PS = 6`** (não 8). Atalhos `Ctrl/⌘+1…9` são outra constante (`Be=9`).

O picker **não oferece grupos** (`!d.isGroup`). Grupos já existentes não são destinatário.

Cliente OpenBot empacotado = 0.16. Se a barra nativa **já** existir, o host só alimenta os RPCs (e aceita o `name` que o 0.36 mandar). Se não existir, overlay clona A–C. D–E = chat nativo + `listAgents`.

---

## 4. Regras que um modelo não pode violar

Copie estas regras para o código. Se o pedido do usuário do chat conflitar com uma regra, a regra ganha.

1. **Criar grupo não cria bot.** `createGroup` só aceita ids que já estão no roster, com `isGroup === false`, no instante da chamada.
2. **Não clone membro.** Não nasça `sand-subagent-*`, harness temporal, cópia de home, nem “instância de sala”.
3. **Não infira como o grupo.** `sendPrompt` no id do grupo nunca chama o provider com o `agentId` do grupo. Sempre um membro ator.
4. **Não escreva na conversa privada do membro** por causa do grupo.
5. **Não use A2A 1:1 como o chat do grupo.** A2A continua para recado privado bot→bot. O fio do grupo é o transcript do grupo.
6. **Não chame nuvem Cursor / protobuf `aiserver.v1.GrokBotRoom`.** Host local, SQLite, config JSON.
7. **Não atualize o cliente para 0.36** e **não patch chunks** do renderer 0.16. Overlay + RPCs.
8. **Não auto-preencha “todos os bots”.** Só os ids que o caller passou. Se o caller passou todos os bots atuais, aí sim o grupo tem todos — porque ele pediu, não porque o host inventou.
9. **Não adicione o criador automaticamente** se o id dele não veio em `memberAgentIds`.
10. **Mínimo 2 membros na criação. Máximo 6** (teto da barra 0.36, `PS=6`). O cap A2A de 8 **não** vale para grupo. O picker 0.36 *pode* mandar 1 membro se o humano clicar um bot no estado A sem entrar em group mode — o host OpenBot **recusa** isso (400). Overlay: nesse clique abra o 1:1, não chame `createGroup`.
11. **`setGroupMembers` é um set completo**, igual o 0.36: a lista enviada *substitui* `memberIds`. Para adicionar: ler atuais, concatenar, reenviar. Para remover: reenviar sem o id. A UI/tool pode oferecer “add/remove”; o RPC é sempre o set.
12. **Não dê kickstart, modelo próprio, nem tools ao grupo como ator.** O grupo tem home/conversa só para parecer um bot na sidebar e guardar o fio.
13. **`create_bot` durante um turno de grupo cria um bot normal e NÃO o coloca no grupo.** Colocar exige `setGroupMembers` depois, com o id já existente.
14. **Apagar o grupo não apaga os membros.** Apagar um membro remove o id de todos os `memberIds`.
15. **Não implemente pastas `nlt`, channels cloud, `broadcastToAgents` “all”, nem templates de bot.**

---

## 5. Como o grupo “é igual aos demais bots”

O grupo entra no mesmo ciclo de vida de `createAgent`, com as diferenças abaixo.

| Peça | Bot | Grupo |
|---|---|---|
| Linha na sidebar | sim | sim |
| `listAgents` / `agent-upserted` / `openAgent` | sim | sim |
| Home NTFS + conversa default | sim | sim (home existe; grupo não executa tools nela) |
| `sendPrompt` / transcript / cancel | sim | sim, mas o runner despacha a um membro |
| `createAgent` | cria o bot | **proibido** para fazer grupo |
| `createGroup` | não | único jeito |
| Provider / model no próprio id | sim | ignorado na inferência |
| `kickstartAgent` | permitido | 400: grupos não têm kickstart |
| `setAgentDefaultModel` | permitido | 400: grupo não tem inferência própria |
| Tools | as do bot | no turno, as do **ator** |

O grupo **conta** no teto `MAX_LOCAL_AGENTS` (128), porque é uma linha do roster.

---

## 6. Dados

Estenda `LocalAgent` (config JSON já usada pelo roster):

```ts
isGroup?: boolean;          // default false; omitir = bot
memberIds?: string[];       // só se isGroup === true; ids de bots, sem o id do grupo
ownerAgentId?: string;      // "user" ou id do bot que chamou create_group
```

Validação no `validateAgents` (precisa da lista inteira):

- Se `isGroup` não é true: `memberIds` ausente ou `[]`.
- Se `isGroup` é true:
  - `memberIds` na criação/set RPC tem 2..6 ids; depois de exclusões de membro pode cair a 1 (ver §9).
  - ids únicos, case-insensitive como o roster.
  - cada id existe na mesma lista e tem `isGroup !== true`.
  - nenhum id é o próprio grupo.
- Cursor de round-robin **não** vai no config. Tabela SQLite `group_turn_state`:

```
group_id TEXT PRIMARY KEY
last_speaker_agent_id TEXT
hop_count INTEGER NOT NULL DEFAULT 0
updated_at_ms INTEGER NOT NULL
```

`summarize()` (já devolve `isGroup: false` e `memberIds: []` hoje) passa a devolver os valores reais. `conversationPartnerIds` permanece `[]` neste recorte (o 0.16 OpenBot não usa; o 0.36 usa partners em outro fluxo).

---

## 7. RPCs

Registre em `RPC_METHOD_TABLE` e no roster.

### `createGroup`

Entrada:

```
{ name?: string, description?: string, memberAgentIds: string[], origin?: string }
```

Regras:

- `name` opcional. Se omitido ou vazio, o host monta o título como o 0.36 `_vt`: `profile.name` + nomes dos membros, `Intl.ListFormat` **narrow + conjunction** (pt-BR: vírgulas), depois trim e teto **72** caracteres. Com ≥2 membros (único caso que o RPC aceita): humano **primeiro**, depois os bots na ordem de `memberAgentIds`. Não peça um “nome do grupo”.
- Composer **ainda em compose** (chips, grupo ainda não existe): outro formatador — `ListFormat` **long + conjunction** (pt-BR: “e”) **só dos chips**, sem o humano. Isso é UI, não o `name` persistido.
- `memberAgentIds`: 2..6, ids existentes, não-grupos, únicos.
- **Não** chama `createAgent` para nenhum membro. (O 0.36 `hxt` *pode* `createAgent` se o chip for `kind:"new"`; o overlay OpenBot **não** copia isso — só bots já no roster.)
- Cria **um** `LocalAgent` com `isGroup: true`, `memberIds` na ordem recebida (ordem = ordem de round-robin).
- `ensure` home + `ensureDefault` conversa, mesmo rollback de `createAgent`.
- Publica `agent-upserted` + roster SSE.
- Resposta: `{ agent }` no mesmo shape de `createAgent`.
- `origin`: `"user"` se o humano chamou; `"agent:<id>"` se a tool chamou (não troca o chat ativo, igual `create_bot`).

Erros 400: `name` presente e inválido (vazio depois de trim conta como omitido, não como erro); menos de 2; mais de 6; id desconhecido; id é grupo; id duplicado. 409: teto de agentes.

### `setGroupMembers`

Entrada:

```
{ id: string, memberAgentIds: string[], requesterAgentId?: string }
```

- `id` é o grupo.
- `memberAgentIds` é a lista **final**.
- Humano (RPC sem `requesterAgentId`): sempre permitido.
- Bot (`requesterAgentId`): só se o requester já é membro **ou** é `ownerAgentId`.
- Depois da troca: 2..6 membros (não deixar o grupo com 1 via este RPC; remoção até 1 só acontece por `deleteAgents` de um membro).
- Publica `agent-upserted`.

### `listAgents` / `getAgent`

Já existem. Só preencher `isGroup` e `memberIds`.

Não adicione `requestGrokBotRoomMemberTurn` nem `broadcastToAgents`.

---

## 8. Tools (bots)

Duas tools, no mesmo estilo de `create_bot`. Só quando o usuário pediu explicitamente, ou quando o bot já está num grupo e precisa alterar membros.

### `create_group`

```
{ name?, description?, members: string[] }
```

`name` opcional (mesmo default derivado do RPC). `members` aceita **id** ou **nome único** (case-insensitive) dos bots atuais. Ambíguo ou inexistente → falha de validação, sem criar nada.

Não inclui o caller sozinho. Se o usuário disse “me inclui”, o modelo coloca o próprio id na lista.

### `set_group_members`

```
{ group_id, member_ids: string[] }
```

Set completo. Mesma resolução id/nome. `requesterAgentId` = o `context.agentId` da tool.

Prompt de sistema curto: o bot pode criar grupo e alterar membros **só com bots que já existem**; nunca inventar membro; nunca criar bot “para o grupo”.

---

## 9. Exclusão

- `deleteAgents([grupo])`: apaga home, transcript, `group_turn_state` do grupo. Membros ficam.
- `deleteAgents([bot])`: remove esse id de todo `memberIds`. Se o grupo ficar com 0 membros, apague o grupo (não deixe fantasma). Se ficar com 1, o grupo permanece listado; `sendPrompt` ainda funciona com o único ator; a UI deve permitir adicionar outro bot depois. Não force 2 na exclusão — o usuário acabou de matar um membro.
- Recriar um bot com o mesmo id depois não o recoloca em grupos antigos.

---

## 10. Turnos (como eles conversam)

### 10.1 Humano fala no grupo

1. UI `sendPrompt({ agentId: grupoId, prompt, clientNonce })` — igual a falar com um bot.
2. Host vê `isGroup`, **não** resolve provider do grupo.
3. Aceita nonce no ledger do **grupo** (o spinner da UI é o do grupo).
4. Grava mensagem `role: "user", fromUser` no transcript do grupo.
5. Escolhe ator (ver 10.3).
6. Espera a fila do ator ficar livre (não paralelizar tools na mesma home).
7. Roda inferência como o ator: system prompt do ator + bloco de sala; tools/home/modelo do ator; **append** no transcript do **grupo**.
8. Mensagem do ator: `kind: "message", role: "assistant", fromAgent: { kind: "agent", id, name }`, conteúdo = o texto dele, sem prefixar o nome no conteúdo.
9. Cards de tool no transcript do grupo.
10. Reset `hop_count` para 0 no início da mensagem humana.

### 10.2 Escolha do ator

Ordem:

1. Se o texto humano (ou o `/pass` do turno anterior) aponta um membro por `@Nome` ou `@id` e o match é único entre os membros atuais → esse membro.
2. Senão, o próximo depois de `last_speaker_agent_id` na ordem de `memberIds`. Se o último saiu, começa no índice 0.
3. Nunca ator fora de `memberIds` ou fenced.

### 10.3 Bots falando entre si

Protocolo mínimo, para o parser não adivinhar:

- Última linha da resposta do ator, sozinha: `/pass @NomeOuId`
- Se o alvo é membro e `hop_count < 4`, enfileira **um** turno dele no mesmo grupo, sem nova mensagem humana. Incrementa `hop_count`.
- Sem `/pass` válido, a cadeia para. O humano fala de novo quando quiser.

Não faça “todo mundo responde”. Um falante por vez.

### 10.4 Prompt de sala (injetado só no turno de grupo)

Depois do system prompt normal do ator:

```
You are speaking in the OpenBot group "{groupName}".
You are {memberName}. Speak only as yourself.
Other members: {list of name (id)}.
This transcript is the shared group chat, not your private chat with the user.
To hand the next turn to another member, end with a single line: /pass @NameOrId
Otherwise stop after your reply.
```

O contexto enviado ao modelo é o transcript **do grupo**, não o privado do ator.

### 10.5 Fila

- Serializar o chat do grupo na fila do `grupoId` (um turno de grupo por vez).
- Antes do provider, também não sobrepor um turno privado do ator. Se o ator estiver busy, o turno de grupo espera na fila do grupo.

### 10.6 Cancel

`cancelPrompt` no grupo aborta o turno do ator em curso e não dispara `/pass`.

---

## 11. Interface alvo (prints + código 0.36)

Fonte visual: os cinco prints. Fonte de comportamento: barra `NewChatBar` + `hxt`. Substitui qualquer formulário “Novo grupo + checkboxes + nome”.

O humano **não** é `memberAgentId`. Entra no **título** e nos **avatares empilhados** via `currentUserName` / foto do perfil.

Faixa amarela “Reconectando ao seu computador…” (`z2Cwm8`) **não** faz parte do fluxo de grupo.

### 11.1 Estado A — Novo chat (ainda não é grupo)

- Sidebar: **+ Novo chat** (`hIQkLb`).
- **Para:** (`ZxkdRe`) + placeholder **Buscar ou criar Bots** (`PHfiXN`). Combobox, `aria-label` igual ao placeholder. Fechar: `CceQuV`.
- Dropdown (`sand-new-chat-menu`, `yPrbsy` = “Destinatários”):
  1. **+ Criar novo Bot** (`6X9ton`, ícone `plus`) — cria bot, não grupo.
  2. **Criar chat em grupo** (`hRyPRc`, ícone `people`) — só `enter-group-mode`. Zero RPC.
  3. Bots existentes: **só nome + avatar**. As tags cinzas `bot designer` / `plugin wizard` são `purpose`/`role` da **sidebar**, não desta lista.
- Composer: **Mensagem para o Bot** (`WGiJQZ`). `+` = **Anexar** (`igVDFt`). Mic = **Iniciar uma chamada de voz** (`yR6Tvw`).

**0.36 vs OpenBot no clique do bot neste estado:** o nativo, com channels off, commita `{type:"group", recipients:[esseBot]}` e `hxt` cria grupo de 1. O host OpenBot recusa 1 membro. Overlay: clique no bot = **abrir o 1:1**, não `createGroup`.

### 11.2 Estado B — Modo grupo

- Sidebar vira **+ Novo chat em grupo** (`yqxI6O`) assim que `isGroupMode` **ou** existe chip.
- Picker: some `create-new` / `create-group`; só bots ainda não escolhidos.
- Hover no bot destacado: **Adicionar ao chat em grupo** (`zeQMAX`). Fora do modo grupo o mesmo slot seria `hIQkLb`.
- Sem nome, sem checkbox. Um clique = chip. Máximo **6** chips.

### 11.3 Estado C — Chips

- Chip: avatar + nome + X (`Y47eWa` “Remover {0}”), classe `sand-new-chat-chip`.
- Composer: **Mensagem para {chips}** (`jGH82H`) com `ListFormat` **long** → “Claudin e Criador de Bots”. Sem o humano.
- Teclado da barra (copiar se overlay): ↑↓; Tab ou `,` adiciona o destacado; Backspace no input vazio remove o último chip; Enter commita; Esc fecha menu depois a barra; `Ctrl/⌘+1–9` ativa a linha.
- Primeira mensagem → `createGroup` (≥2 ids) + `sendPrompt`. Não criar grupo no segundo chip sozinho.

Lista vazia (não está nos prints): query vazia → `r32WRY`; sem match → `12i8o8`. Digitar nome inexistente no 0.36 vira kind `create` e `hxt` chama `createAgent` — **proibido** no overlay OpenBot.

### 11.4 Estado D — Depois do primeiro “Oi”

- Header: `sand-kit-avatar-stack`; título = `name` persistido (narrow, humano primeiro, vírgulas).
- Ícone **i**: “Ver detalhes da conversa” (`+fxiY8`). Não é Computer. Não é o item de menu “Sobre” (`uyJsf6`).
- Data: **Hoje {hora}** (`GjJ5lX`). Sidebar usa outro relógio (hoje = só hora; 2–6 dias = weekday long, ex. “terça-feira”).
- Status: `{nome} está trabalhando` (`rbijNi`) + reticências do wrapper `je49i+`. Só com ator/`fromAgent` (`hasAuthor`). Sem nome: `PxYAul` “Digitando…”.
- Composer: **Mensagem para {name do grupo}** (já inclui o humano, vírgulas) — não relistar chips.

### 11.5 Estado E — Linha na sidebar

- Título = mesmo `name`, CSS trunca (`Cri...`). Preview da última mensagem. Hora da última atividade.
- Clicar a linha = grupo. Clicar **Claudin** = privado.

Membros depois: `setGroupMembers` com lista completa. `+` do composer continua anexo.

### 11.6 O que a UI não é

- Modal nome + checkboxes; `sand-new-channel-dialog`; pasta `nlt`; segundo botão permanente “Novo grupo”; kind novo de bolha; convite pelo `+` do composer.

### 11.7 Tokens e chaves i18n (copiar literal)

`--cursor-*`, pt-BR, sentence case. Sem gradient.

| Chave | PT | Onde |
|---|---|---|
| `ZxkdRe` | Para: | barra |
| `PHfiXN` | Buscar ou criar Bots | barra |
| `6X9ton` | Criar novo Bot | dropdown A |
| `hRyPRc` | Criar chat em grupo | dropdown A |
| `zeQMAX` | Adicionar ao chat em grupo | hover B |
| `hIQkLb` | Novo chat | sidebar A / hover fora de grupo |
| `yqxI6O` | Novo chat em grupo | sidebar B–C |
| `WGiJQZ` | Mensagem para o Bot | composer A–B |
| `jGH82H` | Mensagem para {names} | composer C+ |
| `Y47eWa` | Remover {0} | chip |
| `rbijNi` | {name} está trabalhando | status D |
| `GjJ5lX` | Hoje {time} | transcript |
| `igVDFt` | Anexar | + composer |
| `CceQuV` | Fechar novo chat | X da barra |
| `JuesWZ` | Bots ocultos | sidebar (não é grupo) |
| `DImcpZ` | Não foi possível criar o canal… | só o dialog que **não** implementamos |

### 11.8 Não copiar do 0.36

- Grupo de 1 membro pelo clique no estado A.
- `createAgent` dentro do compose de grupo.
- Dialog de canal / copy “canal”.
- Teto 8 (A2A). Teto visual = 6.
- `broadcastToAgents`, protobuf rooms, pastas `nlt`.

---

## 12. Caminho feliz (teste mental)

Roster: Claudin, Criador de Bots. Usuário: Novo chat → Criar chat em grupo → adiciona os dois → manda “Oi”.

1. `createGroup` com esses dois ids. Zero bots novos. Título derivado: `"{usuário}, Claudin, Criador de Bots"`.
2. Transcript do grupo tem o “Oi” do humano. Claudin (primeiro ator) fica `isRunning`; UI: “Claudin está trabalhando...”.
3. Resposta no mesmo fio com `fromAgent` Claudin. Chat privado de Claudin inalterado.
4. `/pass @Criador de Bots` → o outro membro fala no mesmo fio.
5. Tool `set_group_members` só aceita um terceiro bot **já existente**.

---

## 13. Aceite

Pronto quando:

- `createGroup` com dois bots existentes cria um grupo e **zero** bots extras.
- `createGroup` com id inexistente falha e o roster não muda.
- `sendPrompt` no grupo produz assistant com `fromAgent` de um membro; a conversa privada do membro não ganha essa linha.
- `setGroupMembers` troca a lista; um bot membro consegue adicionar outro bot **já existente**.
- Apagar o grupo não apaga os membros.
- A criação visível segue os estados A–E (§11): Para, chips (teto 6), título = nomes (narrow), avatar empilhado, “está trabalhando” no ator. Sem tela de nome/checkbox. Clique no bot no estado A no overlay = 1:1, não grupo de 1.
- Chunks nativos do cliente empacotado não são editados. Se a barra 0.36 já existe, só o host. Se for 0.16, overlay clona A–C.

---

## 14. Fora de escopo (explícito)

Pastas `nlt`; upgrade 0.36; protobuf/rooms cloud; harness temporal; `broadcastToAgents`; mentions `@grupo` no composer nativo; fan-out todos-falam; templates; segunda implementação de A2A; página React nova; testes além dos nomeados no plano.
