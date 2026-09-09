# Auditoria completa do OpenBot  
## Persistência de modelos, memória, contexto, compactação e durabilidade

**Projeto auditado:** `C:\SuperAgent\openbot`  
**Referência arquitetural:** `E:\grok-bot-0.18-reconstructed`  
**Estado ativo inspecionado:** instalação `0.1.0` em `%LOCALAPPDATA%\OpenBot\install` e dados em `%APPDATA%\OpenBot`  
**Data da auditoria:** 29/08/2026  
**Modalidade:** leitura e análise estática, com inspeção sanitizada do estado ativo. Nenhum arquivo do projeto foi editado.

> **Reconciliação documental — 06/09/2026:** os achados abaixo são históricos. O checkout já contém estimativa de tokens separada de bytes em [model-context.ts](src/memory/model-context.ts) e capacidades por modelo em [models.ts](src/config/models.ts). A afirmação de que o caminho padrão conta bytes como tokens não descreve mais essa implementação. Esta conferência estática não encerra os demais achados nem valida a instalação em uso.

---

## 1. Escopo, método e grau de certeza

A análise foi feita em quatro planos separados:

1. **Checkout atual do OpenBot**, para avaliar o código que está em `C:\SuperAgent\openbot`.
2. **Bundles Electron gerados no checkout**, especialmente renderer, preload e main process.
3. **Instalação realmente ativa**, para verificar se o executável em uso corresponde ao checkout.
4. **Estado persistido real**, mediante leitura sanitizada de metadados do `openbot-config.json` e de estrutura/contagens do SQLite, sem ler o conteúdo das conversas, memórias ou segredos.

A referência `grok-bot-0.18-reconstructed` é útil como desenho arquitetural, mas **não deve ser tratada como fonte primária do produto Grok real**. É um repositório reconstruído/redigido. As conclusões sobre o OpenBot, por outro lado, estão baseadas no código executável e no estado local inspecionado.

### Escala de severidade

| Nível | Critério |
|---|---|
| **P0** | Pode destruir continuidade lógica, alterar memória protegida ou tornar a memória estruturalmente não confiável. |
| **P1** | Defeito funcional relevante, capacidade muito abaixo do declarado, contrato inconsistente ou risco de privacidade/durabilidade. |
| **P2** | Hardening, observabilidade, retenção, UX semântica ou risco operacional não imediato. |

---

# 2. Veredito executivo

O parecer raso recebido está correto em alguns pontos, mas omite falhas mais graves do que a persistência de `reasoningEffort`.

## Conclusões principais

1. **O bug “Raciocínio Alto não persiste” está confirmado tanto na instalação ativa quanto no checkout atual.**  
   A UI envia `reasoningEffort`; o preload encaminha o objeto; o main process Electron reconstrói manualmente o payload e descarta o campo. O backend e o `ConfigStore` suportam o campo corretamente. O defeito está no bridge intermediário.

2. **A compactação atual não é cumulativa.**  
   Depois do primeiro resumo, o próximo job recebe apenas as mensagens posteriores ao limite anterior, sem receber o resumo anterior. O novo resumo substitui integralmente o antigo no SQLite. Em conversas longas, isso produz amnésia lógica previsível.

3. **Compactação e memória entre conversas estão acopladas de forma incorreta.**  
   No modo `automatic`, há uma chamada extra de reflexão após cada turno concluído. No modo `explicit`, resumo e memória só são atualizados quando a mensagem parece um pedido explícito de memorização. No modo `off`, não há novos resumos. Portanto, desligar memória entre conversas também desliga silenciosamente a compactação da conversa corrente.

4. **Memórias `pinned` ou `trust:user` não estão realmente protegidas no limite de persistência.**  
   A proteção existe apenas para operações explícitas `supersede` e `forget`. Um `upsert` automático com a mesma `canonicalKey` pode substituir a memória protegida pelo caminho de conflito do SQLite.

5. **Os números de contexto são rotulados como tokens, mas o runtime conta bytes UTF-8 como tokens.**  
   Isso é uma inconsistência dimensional. Para Luna/Sol/Terra, a janela declarada de 272.000 tokens vira, na prática, aproximadamente 228.416 **bytes** antes de sistema, ferramentas e demais reservas. Em português, caracteres multibyte tornam o desperdício ainda maior.

6. **O limite de 256 KiB mede um corpo diferente do corpo realmente enviado.**  
   Para OpenAI, o medidor serializa o formato padrão da Responses API, mas o adaptador ativo envia o formato Codex. Para OpenCode Go, o medidor usa um corpo genérico de Chat Completions, embora o adaptador possa enviar Responses, Chat ou Anthropic.

7. **Os modelos OpenCode Go e o endpoint OpenAI-compatible não têm metadados de contexto no catálogo.**  
   Todos caem no fallback de 16.384 de contexto, 2.048 de saída e margem de 20%. O conteúdo útil máximo teórico fica perto de 11 KiB antes de sistema e ferramentas, independentemente da capacidade real do modelo remoto.

8. **A mensagem atual pode ser recuperada como “histórico relevante” e entrar duas vezes no mesmo request.**  
   O turno do usuário é persistido antes da busca FTS; a busca não exclui a conversa ou o `sequence_id` corrente.

9. **“Esquecer” é tombstone lógico, não apagamento.**  
   Texto, valor e revisões permanecem no banco. Isso é aceitável para auditoria, mas não equivale a exclusão por privacidade.

10. **A instalação ativa está divergente do checkout.**  
    O renderer principal coincide em parte, mas main process, preload e módulos de settings/memória têm hashes diferentes. A instalação ainda contém a UI/IPC de WhatsApp já removida do checkout. O runtime atual ainda possui código de WhatsApp em outras camadas, portanto “WhatsApp foi totalmente removido” também seria uma afirmação incorreta.

11. **O SQLite ativo está íntegro, mas já contém resíduos de agentes ausentes do config.**  
    O config contém um agente; o banco contém nove `agent_id` distintos em todas as tabelas. A maior parte está em histórico A2A, que é deliberadamente aposentado, não apagado. Contudo, dois agentes ausentes do config ainda possuem estado de conversa e uma conversa vazia cada. O fluxo atual de exclusão não é atomicamente transacional entre JSON e SQLite e não há reconciliação de boot.

---

# 3. Matriz priorizada de achados

| ID | Severidade | Achado | Consequência |
|---|---:|---|---|
| F-01 | **P0** | Resumo incremental não recebe o resumo anterior e substitui a linha existente | Perda progressiva da continuidade compactada |
| F-02 | **P0** | `upsert` por `canonicalKey` pode substituir memória `pinned`/`trust:user` | Modelo automático pode alterar fato explicitamente protegido |
| F-03 | **P0/P1** | Compactação usa o mesmo gatilho da memória | `off` e `explicit` degradam conversas longas; `automatic` faz chamada extra todo turno |
| F-04 | **P1** | Electron bridge descarta `reasoningEffort` | Valor selecionado volta a `medium` após reload |
| F-05 | **P1** | `reasoningEffort` não tem efeito uniforme entre providers | Mesmo persistido diretamente, xAI, OpenAI-compatible e protocolos Chat/Anthropic podem ignorá-lo |
| F-06 | **P1** | Bytes UTF-8 tratados como tokens | Janela real muito menor que a declarada e forte desperdício de contexto |
| F-07 | **P1** | Medição de 256 KiB usa serializador diferente do wire real | Pode truncar em excesso ou deixar passar request maior que o pretendido |
| F-08 | **P1** | OpenCode Go e OpenAI-compatible usam fallback 16k/2k | Capacidade extremamente subutilizada |
| F-09 | **P1** | Mensagem corrente pode reaparecer via FTS | Prompt duplicado, maior custo e distorção de atenção |
| F-10 | **P1** | `forget` não apaga plaintext e revisões | Risco semântico e de privacidade se a UI prometer exclusão |
| F-11 | **P1** | OpenRouter/CLI podem ser persistidos sem rota normal de uso | Configuração aparentemente válida, mas inerte ou inalcançável |
| F-12 | **P1** | Exclusão de agente cruza JSON e SQLite sem commit único | Crash entre etapas deixa resíduos; o estado ativo já contém dois casos compatíveis |
| F-13 | **P2** | Seleção de contexto pode criar lacunas cronológicas | Turno mais recente e grande pode ser omitido enquanto um mais antigo e curto permanece |
| F-14 | **P2** | Busca FTS usa até 16 termos unidos por `AND` | Recall lexical fraco e muitos falsos negativos |
| F-15 | **P2** | Proveniência é atribuída por job, não por memória candidata | Evidência imprecisa e auditoria fraca |
| F-16 | **P2** | Revisões, tombstones e transcritos não têm política geral de retenção | Crescimento indefinido |
| F-17 | **P2** | Bundle ativo não é verificavelmente o checkout | Bugs corrigidos no fonte podem continuar em produção |
| F-18 | **P2** | Escrita atômica sem `fsync` e SQLite `synchronous=NORMAL` | Boa tolerância a crash de processo, menor garantia contra perda de energia |

---

# 4. Correção precisa do feedback recebido

| Afirmação recebida | Veredito |
|---|---|
| “Nome, título, descrição, avatar, notificações, provider e modelo persistem” | **Verdadeiro, mas incompleto.** O config também contém `reasoningEffort`, `runtimeMode`, políticas de Skills/MCP, flags, host settings e optional providers. Persistir no JSON não garante chegar ao provider. |
| “Raciocínio Alto não persiste; a UI envia e o bridge descarta” | **Exatamente confirmado.** O defeito também existe no bundle do checkout atual, não apenas na instalação antiga. |
| “O histórico completo permanece no SQLite” | **Verdadeiro enquanto a conversa/agente não for explicitamente limpo.** A compactação não apaga mensagens. |
| “Após cada turno o automático gera resumo” | **Impreciso.** O sistema enfileira uma reflexão assíncrona após cada turno concluído com sucesso. O job pode coalescer, atrasar, falhar, morrer após retries ou retornar sem resumo. |
| “Entram resumo, memórias e até 80 mensagens” | **Parcial.** Isso depende do modo, orçamento, temporariedade, disponibilidade do resumo e do fitter. Há também histórico FTS, anexos, ferramentas, sistema e um possível anchor do primeiro usuário. |
| “Luna tem 272 mil de contexto e 16.384 de saída, com teto de 256 KiB” | **Os números estão no catálogo, mas a interpretação está errada.** O runtime trata bytes como tokens; 16.384 é reserva local e não é enviado como `max_output_tokens` no protocolo Codex; o teto de 256 KiB mede outro corpo. |
| “WhatsApp aparece porque a instalação está anterior à remoção” | **Correto para a UI/IPC.** O bundle instalado é diferente e contém esses handlers. Porém ainda existe código de runtime/tool de WhatsApp no checkout, então a remoção não é integral. |

---

# 5. Estado ativo observado

## 5.1 Instalação e config

- Versão ativa: `0.1.0`.
- Raiz de instalação: `%LOCALAPPDATA%\OpenBot\install\versions\0.1.0`.
- Config: `%APPDATA%\OpenBot\openbot-config.json`.
- Schema do config: `version: 1`.
- Agente ativo auditado:
  - nome: `Geraldo - O Lider`;
  - provider: `openai`;
  - modelo: `gpt-5.6-luna`;
  - `reasoningEffort: medium`.
- O config ainda possui a chave legada `integrations.whatsapp`.

Nenhum token, segredo, mensagem ou conteúdo de memória foi coletado.

## 5.2 Divergência de bundle

Foram comparados os hashes de arquivos equivalentes da versão instalada e do checkout. Main process, preload, módulo de settings, módulo de memória e launcher divergem. O renderer `index.html` principal coincide, mas isso não prova equivalência do aplicativo, pois os módulos carregados e os bridges são diferentes.

O bundle instalado contém `WhatsApp`, `getAgentWhatsapp` e `setAgentWhatsapp`; o checkout atual removeu essas rotas da UI/IPC de settings. O estado em execução, portanto, não pode ser inferido pelo checkout.

## 5.3 SQLite ativo

Snapshot estrutural:

- arquivo: aproximadamente 616 KiB;
- schema: `PRAGMA user_version = 13`;
- `journal_mode = WAL`;
- `synchronous = NORMAL`;
- `foreign_keys = ON`;
- `busy_timeout = 5000`;
- `PRAGMA quick_check = ok`;
- zero violações de foreign key;
- uma conclusão de turno;
- um job de memória concluído em uma tentativa;
- um resumo de conversa, revisão 1;
- zero memórias duráveis;
- modo de memória `automatic`.

Isso confirma que, no primeiro turno observado, o modo automático realmente produziu um job e um resumo. Como existe apenas revisão 1, o defeito de resumo não cumulativo ainda não havia se manifestado naquele banco.

### Resíduo de agentes

O config possui um agente, mas o banco contém nove identificadores de agente em todas as tabelas:

- vários aparecem apenas em `a2a_agent_incarnations`; essa tabela é histórica e o código aposenta encarnações em vez de removê-las;
- dois agentes ausentes do config ainda possuem `agent_conversation_state` e uma conversa vazia cada;
- um registro ausente também mantém estado de projeção A2A.

A presença desses registros não prova que o fluxo atual de exclusão sempre falha. Contudo, o fluxo atual atualiza o JSON e depois limpa o SQLite, em operações distintas (`src/rpc/roster.ts:731-873`). Uma queda do processo entre `config.update(...)` e `store.clear(...)` deixa exatamente esse tipo de resíduo. Não há uma reconciliação de boot que elimine ou quarantine conversas pertencentes a agentes que não existem mais no config.

---

# 6. Persistência de configurações de modelos

## 6.1 O que o `ConfigStore` realmente persiste

`src/config/store.ts:61-132` define:

### Por agente

- `id`;
- `name`;
- `title`;
- `avatarId`;
- `description`;
- `origin`;
- `avatarShape`;
- `avatarColor`;
- `avatarPngBase64`;
- `createdAt`;
- `updatedAt`;
- `hasUnread`;
- `hiddenFromSidebar`;
- `notificationsEnabled`;
- `notifyOnUpdatesEnabled`;
- `model`;
- `provider`;
- `reasoningEffort`;
- `runtimeMode`;
- políticas de Skills e MCP.

### Globalmente

- `profile`;
- lista de agentes;
- `activeProvider`;
- `globalModel`;
- `globalReasoningEffort`;
- `compatBaseUrl`;
- `hostSettings`;
- flags;
- servidores MCP;
- optional providers.

O caminho padrão é resolvido em `src/config/store.ts:153-160`.

## 6.2 Qualidade da escrita do config

Pontos positivos:

- lock interprocesso;
- releitura do arquivo dentro do lock;
- merge sobre o estado mais recente;
- validação antes do commit;
- arquivo temporário com modo `0600`;
- `rename` atômico;
- estado em memória só é atualizado após persistência.

Evidência: `src/config/store.ts:700-714`, `758-783` e `807-824`.

Limitações:

- não há `fsync` explícito do arquivo temporário nem do diretório;
- o schema continua em `version: 1`, com migrações pontuais dentro do decoder;
- config e SQLite são autoridades separadas e não compartilham transação;
- campos de agente são normalizados estritamente, o que pode descartar chaves legadas;
- `integrations.whatsapp` é aceito para compatibilidade e removido na normalização atual.

O `ConfigStore` em si é razoavelmente robusto. O principal defeito não está nele, mas na cadeia que chega até ele.

---

## 6.3 Prova do defeito de `reasoningEffort`

### Renderer

`client/extracted/dist/renderer/assets/openbot-local-settings.js:2120-2130` envia:

```js
desktop().agent.setProviderConfig({
  agentId,
  provider,
  model,
  reasoningEffort
})
```

### Preload

`client/extracted/dist/electron-preload/preload.cjs:878-883` encaminha o objeto inteiro ao canal `sand:provider-config-set`.

### Main process Electron

`client/extracted/dist/electron-main/main.cjs:472418-472432` recria o objeto com:

```js
{
  agentId,
  requireActive: true,
  provider,
  model
}
```

`reasoningEffort` desaparece.

### Backend

`src/rpc/roster.ts:1005-1121` aceita, valida e persiste `reasoningEffort`.  
`src/rpc/identity.ts:23-30` resolve a precedência agente → global → default.  
`src/rpc/send.ts:2510-2521` injeta o esforço na requisição ao provider.

### Conclusão

O fluxo quebra em um único seam:

```text
UI correta
  → preload correto
    → main Electron incorreto
      → RPC correto
        → ConfigStore correto
          → provider parcialmente correto
```

O conserto mínimo é encaminhar o campo. A correção arquitetural é eliminar DTO manual duplicado e transportar um objeto de seleção de modelo versionado, validado por um contrato compartilhado.

---

## 6.4 Por que os testes não detectaram

- `test/electron-windows-patches.test.ts` verifica que o renderer contém strings relacionadas a `reasoningEffort`, mas não confirma o payload real do main process.
- `test/roster-reconciliation.test.ts` chama diretamente o handler RPC e prova apenas backend + ConfigStore.
- `scripts/visual-ui-verify.mjs` substitui `agent.setProviderConfig` por um mock dentro do renderer. O bridge real é contornado.

Logo, existem testes verdes em ambos os lados da falha, mas nenhum teste atravessa o seam defeituoso.

---

## 6.5 Persistir não significa produzir efeito no provider

Mesmo que o bridge seja corrigido, o suporte de `reasoningEffort` não é uniforme:

| Provider/protocolo | Persistência | Efeito no wire |
|---|---|---|
| OpenAI Codex, Luna/Sol/Terra | Backend suporta | `buildCodexResponsesBody` mantém `reasoning`, portanto tende a chegar |
| xAI/Grok via Chat Completions | Backend suporta | `buildChatBody` não serializa `reasoningEffort`; valor é ignorado |
| OpenCode Go, protocolo Responses | Backend suporta | Pode chegar pela Responses API |
| OpenCode Go, protocolo Chat | Backend suporta | Ignorado pelo serializer Chat |
| OpenCode Go, protocolo Anthropic | Backend suporta | Ignorado por `buildAnthropicBody` |
| OpenAI-compatible | Backend suporta | Serializer Chat não inclui o campo |

Evidências:

- `src/providers/request-bodies.ts:11-75`;
- `src/providers/openai-helpers.ts:246-265`;
- `src/providers/opencode-go.ts:58-87` e `136-143`.

Portanto, “Raciocínio Alto persiste” e “Raciocínio Alto altera o comportamento do modelo” são dois requisitos diferentes. O sistema atual falha no primeiro pela UI Electron e, para vários providers, falha também no segundo.

---

## 6.6 Catálogo e parâmetros não persistidos

`src/config/models.ts:17-24` mantém contexto, reserva de saída, estratégia de contagem, margem e visão como constantes de catálogo. Esses itens **não são configurações persistidas por agente**.

Não existem controles genéricos persistidos para:

- temperatura;
- `top_p`;
- limite de saída escolhido pelo usuário;
- janela de contexto escolhida;
- nível de verbosidade;
- parâmetros provider-specific;
- modo rápido;
- parâmetros futuros de modelos.

A arquitetura exige acrescentar cada novo campo em UI, preload, main process, RPC, tipos, config, resolução e serializer. O bug de `reasoningEffort` é consequência direta desse desenho.

A referência reconstruída usa um `SandAgentModelSelection` contendo `modelId`, `maxMode` e uma coleção de `parameters`, persistindo e encaminhando o objeto inteiro (`source/shared/node/settings/sand-settings-store.ts:121-124`; `source/host/extensions/inference/cursor-session.ts:20-33`). Esse padrão reduz a probabilidade de um parâmetro novo desaparecer em um bridge intermediário.

---

## 6.7 Optional providers persistidos, mas não integrados ao fluxo normal

`optionalProviders` aceita:

- `openrouter`;
- `codex-cli`;
- `claude-code`.

Entretanto:

- `ProviderKind` contém apenas `openai | xai | opencode-go | openai-compat` (`src/shared/contracts.ts:387-391`);
- OpenRouter não aparece no catálogo normal;
- o seletor de settings não oferece OpenRouter;
- o handler de seleção normal valida contra `ProviderKind`;
- `main.ts:728-785` registra OpenRouter quando habilitado, mas deixa os adapters CLI em uma fronteira explícita porque o roteamento normal não os representa.

Conclusão:

- OpenRouter pode ser configurado e até registrado, mas não possui uma rota normal consistente de seleção por agente;
- Codex CLI e Claude Code podem ter configuração persistida, mas não participam do chat normal;
- a UI pode transmitir a impressão de provider configurável sem garantir usabilidade.

Isso deve ser resolvido de uma de duas formas: integração completa no contrato de modelo ou remoção da configuração da superfície normal até o recurso estar operacional.

---

# 7. Sistema de memória

## 7.1 Três camadas diferentes

O OpenBot possui:

1. **Transcrito bruto:** `transcript_entries`.
2. **Resumo da conversa:** uma linha em `conversation_summaries`.
3. **Memórias duráveis do agente:** `agent_memories`, com revisões, jobs e FTS.

Isso é conceitualmente correto. O erro do parecer original foi tratar resumo e memória como se fossem a mesma camada.

O schema está em `src/store/schema.ts`, com FTS5 para mensagens/resumos e memórias. Não há embeddings nem índice vetorial.

---

## 7.2 Modos de memória

`src/memory/context.ts:568-572` implementa:

- `automatic`: job depois de cada turno concluído;
- `explicit`: job somente quando o texto corresponde a intenção explícita de memória;
- `off`: não cria job;
- conversa temporária: também não cria job.

A recuperação entre conversas é desabilitada em `off`, mas um resumo já existente da conversa atual continua sendo carregado (`src/memory/context.ts:815-817`).

### Defeito arquitetural: compactação acoplada à memória

O mesmo job produz:

- resumo da conversa;
- upserts/supersedes/forgets de memória.

Consequências:

- `automatic` gera uma chamada adicional ao modelo em todo turno, mesmo quando a janela está quase vazia;
- `explicit` só atualiza o resumo quando o usuário diz algo semelhante a “lembre disso”;
- `off` para de atualizar o resumo da conversa corrente;
- uma conversa longa com memória desligada perde contexto antigo quando o tail de mensagens é cortado;
- o usuário acredita estar desligando memória entre chats, mas também desliga compactação intra-chat.

A correção é separar dois serviços:

```text
ConversationCompactor
  gatilho: pressão de contexto
  escopo: conversa atual
  saída: resumo cumulativo + blocos determinísticos

MemorySynthesizer
  gatilho: debounce, evidência ou pedido explícito
  escopo: memória durável do agente
  saída: fatos com proveniência e política de autoridade
```

---

## 7.3 P0: resumo não cumulativo

O fluxo é determinístico:

1. `src/rpc/send.ts:1444-1466` define o próximo intervalo como:
   - início = `throughSequenceId` do resumo anterior + 1;
   - fim = último `sequence_id`.

2. `src/main.ts:979-999` carrega apenas esse delta do transcrito.

3. `src/memory/context.ts:283-360` monta o payload de reflexão apenas com:
   - IDs;
   - provider/model;
   - intervalo;
   - entries.

4. O payload **não contém**:
   - resumo anterior;
   - revisão anterior;
   - memórias ativas existentes;
   - estado determinístico da conversa.

5. `src/memory/reflection.ts:275-285` aplica o resumo retornado.

6. `src/memory/sqlite-store.ts:819-836` faz `ON CONFLICT ... DO UPDATE` e substitui `summary_json` e `rendered_text`.

Exemplo:

```text
Resumo 1 cobre mensagens 1–20: A + B + C
Job 2 recebe somente mensagens 21–25: D + E
Resumo 2 salvo: D + E
Resumo 1 é substituído
```

O transcrito bruto continua no banco, portanto não há perda física. Porém, quando 1–20 saem do tail e não são recuperados por FTS, A/B/C desaparecem do contexto. É perda de continuidade lógica.

Há ainda uma inconsistência textual: o system prompt de reflexão menciona “prior summaries” em `src/main.ts:224-232`, mas nenhum resumo anterior é enviado.

### Correção obrigatória

O job deve receber:

```ts
{
  previousSummary: {
    revision,
    throughSequenceId,
    summaryJson,
    renderedText
  },
  deltaEntries,
  expectedPreviousRevision,
  transcriptFingerprint
}
```

O commit deve verificar `expectedPreviousRevision`/fingerprint e o servidor, não o modelo, deve controlar a nova revisão.

---

## 7.4 P0: memória protegida pode ser substituída

`src/memory/reflection.ts:209-229` impede `supersede` e `forget` automáticos quando a memória é:

- `pinned`;
- `trust:user`.

Isso parece correto, mas a proteção está na camada errada.

`src/memory/reflection.ts:257-292` envia operações `upsert` diretamente a `store.upsertMemory(...)`.

Em `src/memory/sqlite-store.ts:533-635`:

1. procura memória ativa com a mesma `canonical_key`;
2. se o ID for diferente, marca a anterior como `superseded`;
3. insere a nova;
4. não verifica `pinned` nem `trust:user`.

Assim, o modelo pode emitir:

```json
{
  "op": "upsert",
  "memory": {
    "canonicalKey": "user.preferred_language",
    "text": "novo valor",
    "trust": "external_observation"
  }
}
```

Se já existir uma memória explícita/protegida com a mesma chave, ela é substituída pelo caminho de conflito.

### Princípio violado

Política de autoridade deve ser aplicada **no limite transacional da store**, não apenas no chamador. Qualquer chamador futuro, migração, ferramenta ou job que use `upsertMemory` também consegue contornar a proteção.

### Correção

`upsertMemory` deve receber uma origem de mutação:

```ts
type MutationAuthority =
  | { kind: "user"; expectedRevision?: number }
  | { kind: "automatic"; conversationId: string; evidenceIds: string[] }
  | { kind: "admin" };
```

Em colisão por ID ou `canonicalKey`:

- `automatic` não altera `pinned` ou `trust:user`;
- `user` pode alterar com confirmação/revisão;
- commit usa optimistic concurrency;
- tentativa rejeitada gera métrica e auditoria.

---

## 7.5 Intenção explícita é calculada por lote

`src/memory/reflection.ts:175-183` verifica se **qualquer** entry do job contém intenção explícita. Se sim, `allowUserTrust` é habilitado para todos os upserts do lote (`262-265`).

Como jobs podem agregar várias mensagens, um único “lembre X” pode permitir que outra candidata inferida no mesmo lote receba `trust:user`.

A intenção e a autoridade devem ser vinculadas à evidência específica citada por cada candidata, não ao job inteiro.

---

## 7.6 Proveniência imprecisa

`deriveJobSourceEntryIds` coleta IDs de todas as entries do job e `jobScopedMemory` atribui o conjunto inteiro a cada memória (`src/memory/reflection.ts:159-195`).

Consequências:

- uma memória sobre a primeira mensagem aparece como derivada de todas as mensagens;
- não é possível auditar qual evidência sustentou qual fato;
- remoção por conversa e verificação posterior ficam menos confiáveis.

A saída do modelo deve exigir `sourceEvidenceIds` por operação, e o servidor deve validar que todos pertencem ao input. A referência reconstruída faz isso em `memory-synthesis-service.ts:25-27`, `72-83` e `258-280`.

---

## 7.7 “Esquecer” não significa apagar

`src/memory/sqlite-store.ts:686-703`:

- muda `status` para `forgotten`;
- mantém `text`;
- mantém `value_json`;
- grava uma nova revisão com snapshot.

A exclusão de conversa com política de apagar derivados também marca memórias como esquecidas ou remove proveniência, mas não necessariamente remove plaintext e revisões (`src/memory/sqlite-store.ts:1348-1389`).

Isso é útil para auditoria e prevenção de ressurreição, mas precisa de semântica explícita:

- **forget:** não recuperar nem usar;
- **erase:** apagar memória, revisões, FTS e referências;
- **clear agent:** apagar todo o escopo;
- **retention purge:** remover tombstones/revisões após prazo.

Se a UI chamar a operação atual de “Excluir memória” sem explicar a retenção, há uma discrepância de privacidade.

---

## 7.8 Recuperação lexical frágil

`src/memory/sqlite-store.ts:338-342`:

```ts
terms
  .slice(0, 16)
  .map(term => `"${term}"`)
  .join(" AND ")
```

A consulta exige que todos os termos estejam presentes. Em linguagem natural:

- flexões;
- pontuação;
- sinônimos;
- pequenas mudanças de formulação;
- nomes compostos;
- palavras irrelevantes

podem zerar o recall.

O sistema tenta queries auxiliares, mas o primeiro candidato ainda é o prompt completo (`src/memory/context.ts:479-492`).

Melhoria mínima:

- remoção de stopwords;
- query lexical com termos ponderados e `OR`;
- BM25;
- filtros de data/escopo;
- fallback por trigramas.

Melhoria ideal:

- busca híbrida FTS + embedding;
- reranker;
- diversidade por conversa/fonte;
- avaliação offline de recall e precisão.

---

## 7.9 A mensagem corrente pode entrar duas vezes

Ordem real:

1. `src/rpc/send.ts:2356-2408` persiste a mensagem do usuário.
2. Depois monta o contexto.
3. `src/memory/context.ts:823-829` executa busca em memórias e histórico.
4. `searchHistory` não recebe exclusão da conversa ou do `sequence_id` corrente (`src/memory/sqlite-store.ts:841-908`).
5. O trigger FTS já indexou a mensagem recém-persistida.
6. O mesmo texto também está no tail recente.

Resultado possível:

```text
[Relevant past history]
<mensagem que o usuário acabou de enviar>

[user]
<mesma mensagem>
```

Correções possíveis:

- buscar antes de persistir;
- passar `excludeConversationId`;
- passar `maxSequenceId = currentSequenceId - 1`;
- excluir todo o tail recente da recuperação histórica;
- deduplicar por hash de conteúdo, além de provenance.

---

## 7.10 Escopo e isolamento

Pontos positivos:

- queries e writes filtram consistentemente por `agent_id`;
- não foi confirmado vazamento cross-agent;
- conversas temporárias são excluídas da memória/FTS durável;
- snippets são embrulhados como conteúdo não confiável;
- o system prompt reforça que memória, anexos e ferramentas não são instruções.

Limitações:

- memória durável é apenas por agente;
- não há escopo user-wide ou project-wide;
- não há compartilhamento controlado entre agentes;
- não há decay geral de fatos;
- não há limite total de memórias ativas;
- não há verificador de consistência.

A referência reconstruída oferece escopos de agente, usuário e projeto, com shards de escritor único e precedência explícita (`source/host/runner/sand-memory.ts:282-339`).

---

# 8. Montagem e orçamento de contexto

## 8.1 Conteúdo de uma requisição

O request pode conter:

- system prompt global;
- persona do agente;
- prompt/home state;
- descrições e schemas de ferramentas;
- nota de contexto não confiável;
- memórias pinned;
- memórias relevantes;
- resumo atual;
- histórico relevante;
- tail recente;
- anexos;
- tool calls e resultados dobrados;
- anchor do usuário mais antigo;
- reserva de saída.

`src/memory/context.ts:815-885` monta o overlay de memória/histórico e o tail. `src/rpc/send.ts:1150-1235` e `2864-2908` fazem a conversão final e o anchor.

---

## 8.2 O limite de “80 mensagens”

Constantes:

- `MAX_CONTEXT_RECENT_MESSAGES = 80`;
- fetch inicial de até 160 entradas;
- `MAX_PROVIDER_TRANSCRIPT_MESSAGES = 80`;
- teto textual de 256 KiB.

“80 mensagens” não significa:

- 80 turnos;
- 80 linhas do SQLite;
- garantia de que 80 entram;
- limite total de todos os blocos.

Entradas de attachment/tool/notice podem ser dobradas em menos mensagens. O fitter pode reduzir para muito menos. Se o primeiro pedido do usuário ficou fora do tail, o sistema reserva espaço para um anchor e usa até 79 mensagens restantes.

---

## 8.3 Catálogo atual por modelo

`src/config/models.ts:17-24`:

| Família | Catálogo | Runtime de contagem |
|---|---:|---|
| Grok 4.6 | 500.000 contexto, 32.768 saída, margem 10% | bytes UTF-8 tratados como tokens |
| Luna/Sol/Terra | 272.000 contexto, 16.384 saída, margem 10% | bytes UTF-8 tratados como tokens |
| OpenCode Go | sem metadados explícitos | fallback 16.384/2.048, margem 20% |
| OpenAI-compatible | sem metadados explícitos | fallback 16.384/2.048, margem 20% |

### Limite teórico antes de sistema/ferramentas

- Luna/Sol/Terra:  
  `floor(272000 × 0,9) - 16384 = 228416` unidades.  
  Como a unidade é byte, são aproximadamente **228 KiB**, não 228 mil tokens.

- Grok 4.6:  
  `450000 - 32768 = 417232` bytes.  
  Nesse caso, o envelope de 256 KiB tende a ser o limitante posterior.

- Fallback OpenCode/OpenAI-compatible:  
  `floor(16384 × 0,8) - 2048 = 11059` bytes antes de sistema e ferramentas.

Esse fallback pode deixar modelos OpenCode Go com cerca de 11 KiB úteis mesmo que o serviço remoto aceite muito mais.

---

## 8.4 P1: bytes usados como tokens

`src/memory/model-context.ts:43-50` implementa a estratégia `bytes` com `Buffer.byteLength(...)`.  
`computeModelContextBudget` trata esse número como tokens (`158-194`).

O erro não é apenas conservador. É dimensional:

```text
contextWindow: número rotulado como tokens
estimate: número de bytes
comparação: bytes <= tokens
```

Em português, `á`, `ç`, `ã` e outros caracteres geralmente ocupam mais de um byte. JSON, base64 de imagens e schemas de tools ampliam a divergência.

### Correção arquitetural

Criar tipos e APIs distintos:

```ts
type TokenCount = number & { readonly __unit: "tokens" };
type ByteCount  = number & { readonly __unit: "bytes" };
```

Cada adapter deve expor:

```ts
interface ProviderBudgetAdapter {
  countTokens(request: ProviderChatRequest): Promise<TokenCount> | TokenCount;
  serialize(request: ProviderChatRequest): Uint8Array;
  maxRequestBytes?: ByteCount;
  modelCapabilities(model: string): ModelCapabilities;
}
```

Quando não houver tokenizer exato, usar um estimador conservador em unidades de token, calibrado contra `usage.input_tokens`, e não chamar bytes de tokens.

---

## 8.5 P1: o corpo medido não é o corpo enviado

`src/providers/request-bodies.ts` contém:

- `buildResponsesBody`;
- `buildCodexResponsesBody`;
- `buildChatBody`;
- `providerRequestBodyBytes`.

Para OpenAI GPT-5.6, `providerRequestBodyBytes` usa `buildResponsesBody`.  
Entretanto, `src/main.ts:708-712` registra o adapter OpenAI com `protocol: "codex"`, e `src/providers/openai.ts:437-440` envia `buildCodexResponsesBody`.

Diferenças incluem:

- `instructions`;
- `include`;
- `text`;
- remoção de `max_output_tokens`;
- shape de ferramentas;
- campos específicos do backend Codex.

Para OpenCode Go, o medidor usa Chat, mas `src/providers/opencode-go.ts:136-143` escolhe em runtime entre:

- Responses;
- Chat;
- Anthropic.

Portanto, o teto de 256 KiB é aproximado e não verificável.

### Correção

O mesmo método que envia deve serializar para medição:

```ts
const serialized = adapter.serialize(request);
if (serialized.byteLength > adapter.maxRequestBytes) {
  request = shrink(request);
}
await adapter.sendSerialized(serialized);
```

Não deve existir um segundo serializer “parecido” apenas para estimativa.

---

## 8.6 Os 16.384 de saída da Luna não são um limite efetivo no wire

O contexto reserva 16.384 tokens e `send.ts` define `maxTokens` com esse valor. Porém, `buildCodexResponsesBody` remove `max_output_tokens` antes do envio.

Logo:

- 16.384 é uma reserva local de orçamento;
- não é possível afirmar que o OpenBot efetivamente instrui o backend Codex a limitar a saída a 16.384;
- há ainda um hard cap local de 192 KiB para a resposta em streaming (`src/rpc/stream-state.ts:3`).

A documentação/UI deve distinguir reserva de contexto, parâmetro enviado e hard cap local.

---

## 8.7 Lacunas cronológicas

`selectCompleteMessageGroups` percorre grupos do mais novo para o mais antigo. Se um grupo não cabe e já há algo selecionado, usa `continue` em vez de encerrar (`src/memory/model-context.ts:312-343` e `419-446`).

Exemplo:

```text
Turno 10: pequeno, entra
Turno 9: muito grande, não entra
Turno 8: pequeno, entra
```

O modelo recebe 8 e 10, mas não 9, sem qualquer marcador de lacuna. Isso pode inverter causalidade e fazer uma resposta parecer desconectada.

Melhor comportamento:

- manter um sufixo cronologicamente contíguo;
- ao primeiro overflow, parar;
- ou substituir a lacuna por um resumo explicitamente marcado.

---

## 8.8 Ordem de degradação

Ao exceder orçamento, o sistema reduz nesta ordem:

1. histórico;
2. memórias relevantes;
3. resumo;
4. mensagens recentes;
5. fitter final.

Memórias pinned não participam do loop principal de redução e até quatro são injetadas. Isso preserva instruções duráveis, mas uma pinned obsoleta pode deslocar contexto recente essencial. Pinned precisa de revisão, validade temporal e orçamento próprio.

---

# 9. Compactação e sumarização

## 9.1 O que acontece hoje

No modo automático:

1. turno finaliza com sucesso;
2. é criado/enfileirado um job durável;
3. o worker roda assíncronamente;
4. usa o mesmo provider/model da conversa;
5. timeout padrão de 30 s;
6. até três tentativas;
7. backoff de 5 s, 30 s e 5 min;
8. input principal de 64 KiB;
9. retry reduzido a 32 KiB;
10. saída de reflexão limitada;
11. resultado pode conter resumo e operações de memória.

Pontos positivos:

- jobs persistem no SQLite;
- jobs abandonados podem ser recuperados;
- concorrência por agente é limitada;
- jobs pendentes podem ser coalescidos;
- turnos foreground têm prioridade;
- mensagens antigas não são apagadas.

Ponto negativo central: resumo e memória são duas responsabilidades diferentes dentro do mesmo job e do mesmo modo.

---

## 9.2 Custo e latência

A reflexão é assíncrona, portanto não necessariamente aumenta diretamente o tempo até a primeira resposta. Ainda assim:

- consome uma chamada adicional de modelo por turno no modo automático;
- consome quota;
- pode competir por rate limit;
- pode gerar backlog;
- pode impedir ou atrasar reflexão se o agente receber turnos continuamente;
- usa modelo potencialmente caro para um resumo minúsculo;
- faz trabalho mesmo com contexto quase vazio.

A referência reconstruída separa síntese de memória de compactação e aciona compactação por pressão de contexto: 1.000 turnos ou 90% da janela para self-summary (`source/packages/agent/self-summary/constants.ts:1-3`; `self-summary.ts:70-95`), além de mecanismos de background.

---

## 9.3 Ausência de verificação de cobertura

O OpenBot valida shape, limites e conteúdo sensível, mas não verifica:

- se o resumo preservou todos os open loops;
- se decisões antigas continuam;
- se restrições do usuário foram mantidas;
- se estados de ferramenta/arquivos foram preservados;
- se o novo resumo é semanticamente consistente com o anterior;
- se operações de memória são sustentadas por evidência específica.

A referência reconstruída usa proposta + verificador para memória (`memory-synthesis-service.ts:240-280`) e mantém blocos determinísticos para plano, todos, prompts e outros estados (`agent-summarization/durable-blocks.ts`).

---

## 9.4 Compactação lógica, não física

O parecer recebido acertou: mensagens antigas permanecem no SQLite. O resumo apenas altera o que é remontado no request.

Isso é adequado para:

- recuperação;
- auditoria;
- recompactação;
- exportação;
- busca.

Mas exige:

- política de retenção;
- criptografia/controle de acesso quando necessário;
- hard delete;
- backup;
- vacuum;
- observabilidade de tamanho.

---

# 10. SQLite, durabilidade e recuperação

## 10.1 Pontos fortes

`src/store/index.ts:730-765`:

- foreign keys;
- WAL;
- `synchronous=NORMAL`;
- busy timeout;
- migrations versionadas no SQLite.

Outros pontos:

- append do transcrito e atualização da conversa em transação;
- IDs e sequência duráveis;
- nonces/idempotência;
- turn attempts/completions;
- checkpoints de efeitos;
- recuperação de turnos interrompidos no boot;
- tool calls pendentes marcadas como falha;
- streaming persistido aproximadamente a cada segundo;
- snapshots e restore de agente;
- clear transacional;
- jobs de memória duráveis.

Para um agente local, essa fundação é consideravelmente melhor do que persistir tudo em JSON ou localStorage.

## 10.2 Janela de perda no streaming

`STREAM_PERSIST_INTERVAL_MS = 1000`.

Em crash, até aproximadamente um segundo do final ainda não checkpointado pode ser perdido. O boot marca o conteúdo parcial como interrompido. É um compromisso razoável, desde que documentado.

## 10.3 Config e banco não são uma transação única

A exclusão de agente:

1. para runtime;
2. snapshot;
3. remove/quarentena home;
4. atualiza `openbot-config.json`;
5. limpa SQLite;
6. limpa activity/A2A/tasks;
7. publica roster.

Há compensação para exceptions capturadas, mas não para queda abrupta do processo entre os passos. O banco ativo contém duas conversas vazias de agentes ausentes do config, um estado compatível com essa classe de falha ou com migrações antigas.

Recomendação:

- registrar operação de lifecycle em uma tabela journal;
- fase `prepared`;
- commit do config;
- cleanup do DB/home;
- fase `committed`;
- reconciliar jobs incompletos no boot;
- não apagar automaticamente histórico A2A sem política própria.

## 10.4 Retenção e manutenção

Não foi encontrada política geral para:

- TTL de transcritos;
- poda de revisões;
- poda de tombstones;
- limite por agente;
- backup programado;
- `wal_checkpoint` programado;
- `VACUUM`/incremental vacuum;
- `quick_check` periódico;
- alerta por crescimento.

Há poda parcial de jobs concluídos/mortos antigos, mas não de todas as estruturas.

## 10.5 Garantia contra perda de energia

- SQLite `WAL + NORMAL`: boa proteção contra crash de processo e corrupção, mas menos forte que `FULL` para perda abrupta de energia.
- Config: temp + rename, mas sem `fsync`.

Não é necessário mudar tudo para `FULL` indiscriminadamente. A decisão deve depender do custo de reconstituição. Para config e memórias explícitas, um commit mais forte é justificável.

---

# 11. Comparação com `grok-bot-0.18-reconstructed`

## 11.1 Persistência de settings

### Referência

- `profile.json` por agente com temp + rename;
- `settings.json` por agente com merge;
- settings globais;
- seleção de modelo como objeto completo, incluindo coleção de parâmetros;
- resolução de override de sessão/env/default;
- encaminhamento do objeto de parâmetros.

### OpenBot

- config central mais tipado;
- lock interprocesso;
- validação robusta;
- commit atômico por rename;
- porém parâmetros atravessam vários DTOs manuais.

### Veredito

O OpenBot é melhor em concorrência de arquivo. A referência é melhor na forma de representar uma seleção de modelo extensível.

---

## 11.2 Memória

### Referência

`source/host/extensions/memory/memory-service.ts`:

- `profile.md`;
- logs mensais;
- origem explícita ou sintetizada;
- tombstone por hash;
- remoção do plaintext da linha;
- snapshot fingerprint;
- bloqueio de update/remove automático de memória explícita no commit;
- escopos de agente, usuário e projeto.

`memory-synthesis-service.ts`:

- envia memórias existentes;
- exige IDs de evidência por alteração;
- usa verificador;
- rejeita snapshot stale;
- retries e métricas.

### OpenBot

- SQLite transacional;
- tipos de memória mais ricos;
- revisões;
- FTS;
- jobs duráveis;
- recuperação após crash;
- porém não envia estado existente ao sintetizador;
- proteção pode ser contornada por `upsert`;
- proveniência é por job;
- não há verifier.

### Veredito

O OpenBot tem melhor durabilidade de fila. A referência tem melhor autoridade, verificação, proveniência e concorrência otimista.

---

## 11.3 Compactação

### Referência

- gatilho por tokens/turnos;
- background summarization;
- validação de prefixo antes de persistir;
- descarte de resumo stale;
- resumo substitui o contexto vivo;
- mensagens posteriores ao início são anexadas;
- tail recente preservado;
- system/user info preservados;
- durable blocks;
- arquivos/blobs de resumo;
- retries, redução de input e fallback;
- telemetria de compressão.

### OpenBot

- resumo depois de cada turno automático;
- job durável;
- uma linha por conversa;
- overlay lógico;
- nenhuma mensagem apagada;
- resumo não cumulativo;
- sem prefix fingerprint;
- sem durable blocks;
- sem verifier.

### Veredito

A referência é claramente superior no desenho de compactação. O OpenBot deve copiar os princípios, não necessariamente o formato de implementação.

---

## 11.4 Onde o OpenBot é superior

Não é correto concluir que a referência é melhor em tudo.

O OpenBot possui vantagens reais:

- lock interprocesso no config;
- SQLite com transações;
- jobs de reflexão duráveis;
- recovery de turnos interrompidos;
- idempotência e nonces;
- snapshots lógicos completos;
- isolamento forte por `agent_id`;
- políticas explícitas de segredo/instruction injection;
- schema mais estruturado de memória.

A melhor arquitetura combina essas vantagens com os mecanismos de autoridade e compactação da referência.

---

# 12. Arquitetura-alvo recomendada

## 12.1 `ModelSelectionV2`

```ts
interface ModelSelectionV2 {
  version: 2;
  providerId: string;
  modelId: string;
  parameters: Record<string, string | number | boolean>;
}
```

Requisitos:

- schema compartilhado entre renderer/preload/main/backend;
- UI gerada por capabilities do modelo;
- bridge encaminha o objeto sem reconstrução destrutiva;
- backend valida parâmetros suportados;
- adapter recebe exatamente a seleção efetiva;
- persistência e runtime usam o mesmo tipo;
- migração de `reasoningEffort` para `parameters.reasoningEffort`.

## 12.2 `ConversationCompactor`

- independente do modo de memória;
- gatilho por ocupação real de contexto;
- resumo cumulativo;
- expected revision;
- transcript fingerprint;
- prefix validation;
- tail contíguo;
- blocos determinísticos:
  - objetivo atual;
  - restrições;
  - decisões;
  - arquivos alterados;
  - comandos executados;
  - erros;
  - open loops;
  - tool state;
  - todos/plano;
- fallback determinístico quando o modelo falha;
- telemetria de compressão e cobertura.

## 12.3 `MemorySynthesizer`

- debounce ou lote por evidência;
- modo automatic/explicit/off apenas para memória durável;
- input com memórias atuais;
- `sourceEvidenceIds` por alteração;
- verifier;
- optimistic concurrency;
- autoridade aplicada na store;
- explicit/pinned imutáveis para automação;
- decay e validade temporal;
- scopes agent/user/project opcionais.

## 12.4 `ContextPlanner`

- unidade token distinta de byte;
- tokenizer/estimador por adapter;
- serialização exata para medir bytes;
- suffix cronologicamente contíguo;
- exclusão do tail/current turn da busca histórica;
- ranking híbrido;
- orçamento por categoria;
- explicação observável de cortes;
- não duplicar conteúdo por hash.

## 12.5 Lifecycle persistente

- journal de operações de criação/exclusão;
- reconciliação config ↔ SQLite ↔ homes no boot;
- build ID único em renderer/preload/main/backend;
- manifest de hashes;
- updater com troca atômica de versão;
- tela “Sobre” mostrando commit/build;
- health check que prova que todas as camadas pertencem ao mesmo build.

---

# 13. Plano de correção recomendado

## Fase 0 — bloquear corrupção lógica

### 1. Corrigir o bridge de `reasoningEffort`

- incluir o campo no payload real;
- validar `REASONING_EFFORTS`;
- adicionar E2E renderer → preload → main → RPC → ConfigStore → reload;
- verificar corpo final do provider.

### 2. Tornar resumo cumulativo

- passar resumo anterior;
- revisão controlada pelo servidor;
- expected revision/fingerprint;
- rejeitar job stale;
- teste com sentinelas A/B em duas compactações.

### 3. Proteger memória na store

- autoridade de mutação obrigatória;
- bloquear colisão de canonical key contra pinned/user;
- expected revision;
- teste automático de bypass.

### 4. Separar compactação de memória

- `off` não pode desativar continuidade da conversa;
- `automatic` não deve obrigar compactação a cada turno;
- memória e resumo passam a ter filas/gatilhos diferentes.

---

## Fase 1 — corrigir capacidade e contexto

### 5. Substituir byte-as-token

- contador por provider/model;
- calibração com usage real;
- tipos de unidade;
- testes multilíngues e com tools/imagens.

### 6. Medir o corpo real

- serializer único por adapter;
- OpenAI Codex, xAI, OpenCode Responses/Chat/Anthropic e compat;
- byte gate depois da serialização exata.

### 7. Completar capabilities

- metadados explícitos para todos os OpenCode Go;
- configuração explícita para OpenAI-compatible;
- remover fallback silencioso ou expô-lo como warning.

### 8. Corrigir recuperação histórica

- excluir turno corrente;
- excluir tail recente;
- dedupe por hash;
- consulta lexical menos rígida;
- opcionalmente embeddings/reranker.

### 9. Contexto contíguo

- parar no primeiro grupo que não cabe;
- ou inserir gap summary;
- nunca esconder lacuna causal.

---

## Fase 2 — privacidade, operação e release

### 10. `forget` versus `erase`

- duas APIs;
- UX explícita;
- hard delete de revisões;
- política de tombstone.

### 11. Retenção e manutenção

- quotas por agente;
- prune de revisões/jobs/tombstones;
- backup;
- integrity check;
- checkpoint;
- vacuum controlado.

### 12. Reconciliar resíduos

- boot scan de agentes ausentes;
- distinguir histórico A2A legítimo de dados operacionais órfãos;
- quarantine antes de apagar;
- journal de lifecycle.

### 13. Integridade de build

- manifest;
- build ID;
- hash verification;
- smoke test do pacote instalado;
- remover WhatsApp da superfície e do runtime de forma coerente, ou mantê-lo explicitamente.

---

# 14. Testes mínimos obrigatórios

## 14.1 Persistência de modelo

```text
selecionar Luna + high
→ fechar settings
→ reiniciar Electron
→ ler ConfigStore
→ montar request
→ inspecionar body Codex
→ high deve existir em todas as etapas
```

Repetir por provider/protocolo e afirmar explicitamente quando um parâmetro não é suportado.

## 14.2 Resumo cumulativo

```text
turno 1: SENTINELA_A
compactação 1: resumo contém A

turno 2: SENTINELA_B
compactação 2: resumo contém A e B
boundary = último sequence_id
revision = anterior + 1
```

## 14.3 Memória protegida

```text
criar trust:user + pinned canonicalKey=K
reflection automática emite upsert canonicalKey=K com outro texto
commit deve ser rejeitado
memória original e revisão devem permanecer
```

## 14.4 Memória off

```text
modo off
conversa excede tail/context
compactor deve continuar operando
nenhuma memória cross-chat deve ser criada
```

## 14.5 Autorretrieval

```text
persistir prompt corrente
montar contexto
nenhum hit de histórico deve apontar para currentSequenceId
nenhum conteúdo deve aparecer duas vezes
```

## 14.6 Corpo exato

Para cada protocolo:

```text
serializeForMeasurement(request)
serializeForWire(request)
bytes e conteúdo devem ser idênticos
```

## 14.7 Contexto multilíngue

Casos:

- português com acentos;
- CJK;
- código;
- JSON;
- tools grandes;
- base64/imagens;
- tool result longo.

Comparar estimativa com usage observado e manter margem mensurável.

## 14.8 Crash consistency

Injetar crash entre:

- config commit e SQLite clear;
- SQLite clear e A2A retire;
- summary generation e commit;
- stream checkpoint e finalização.

No reboot, o journal/reconciliador deve restaurar estado consistente.

## 14.9 Pacote instalado

O teste deve executar a versão empacotada, não os módulos do checkout:

- build ID igual em todas as camadas;
- WhatsApp ausente/presente conforme manifest;
- bridge real de settings;
- restart real;
- banco temporário real.

---

# 15. Critérios de aceite

A correção não deve ser considerada concluída enquanto:

1. `reasoningEffort=high` sobreviver a restart e aparecer no corpo real do provider que o suporta.
2. Um segundo resumo preservar fatos do primeiro.
3. Modo `off` impedir memória cross-chat sem impedir compactação intra-chat.
4. Reflexão automática não conseguir alterar `pinned` ou `trust:user` por nenhuma operação.
5. O corpo medido e enviado for o mesmo objeto serializado.
6. Nenhum modelo do catálogo cair em fallback sem warning explícito.
7. A mensagem corrente não aparecer em histórico recuperado.
8. “Excluir” tiver semântica física ou for renomeado para “Esquecer”.
9. Contexto final for cronologicamente contíguo ou marcar lacunas.
10. A versão instalada expuser um build ID verificável e corresponder ao manifest.
11. O boot detectar resíduos operacionais de agentes ausentes do config.
12. Testes atravessarem o Electron real, em vez de mocks que pulam o seam.

---

# 16. Conclusão

A base de persistência do OpenBot não é ruim. O projeto já possui elementos sólidos: SQLite transacional, WAL, recovery, idempotência, jobs duráveis, validação de config, lock interprocesso e isolamento por agente.

O problema está no desenho entre as camadas:

- parâmetros de modelo são repetidos manualmente e se perdem nos bridges;
- compactação e memória foram fundidas em um único job;
- o resumo incremental não recebe o estado anterior;
- autoridade de memória é aplicada no chamador, não na store;
- bytes e tokens foram misturados;
- o medidor de request não usa o serializer real;
- providers parcialmente configurados aparecem antes de estarem integrados;
- release e checkout não têm identidade verificável comum.

A prioridade correta não é apenas “persistir Raciocínio Alto”. Corrigir somente esse campo deixaria intactos dois defeitos mais graves: **amnésia por resumo não cumulativo** e **substituição de memória protegida por upsert automático**.

A sequência tecnicamente correta é:

```text
1. autoridade e cumulatividade
2. separação memória/compactação
3. bridge de modelo
4. orçamento/serializer exato
5. recuperação e privacidade
6. lifecycle/release/observabilidade
```
