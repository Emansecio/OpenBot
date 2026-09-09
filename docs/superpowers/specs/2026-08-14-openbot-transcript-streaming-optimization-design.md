# Onda 1 — Transcript e streaming

## Objetivo

Tornar o custo de um turno limitado pelo contexto útil e pela resposta atual, não pelo transcript total nem pelo número de deltas.

## Componentes

### `TranscriptStore`

A interface mantém os métodos legados e adiciona:

```ts
interface RecentEntriesOptions {
  limit: number;
  kinds?: readonly TranscriptEntry["kind"][];
}

interface TranscriptStore {
  getRecentEntries(agentId: string, options: RecentEntriesOptions): readonly TranscriptEntry[];
  getLatestAssistant(agentId: string): Extract<TranscriptEntry, { kind: "message" }> | undefined;
  getOpenToolCalls(agentId: string): readonly Extract<TranscriptEntry, { kind: "tool-call" }>[];
}
```

`getRecentEntries()` consulta em ordem descendente com `LIMIT`, depois devolve o pequeno resultado em ordem cronológica. A implementação em memória usa `slice()` no tail e mantém a mesma semântica.

### SQLite

- Statements usados repetidamente são preparados uma vez no construtor e armazenados como campos privados.
- `getLatestAssistant()` usa `kind='message'`, `json_extract(payload_json, '$.role')='assistant'`, ordem descendente e `LIMIT 1`.
- `getOpenToolCalls()` filtra `kind='tool-call'` e status `pending|running` por `json_extract`.
- O outline usa queries específicas para primeira mensagem do usuário e última mensagem não vazia; não chama `getEntries()`.
- A poda do ledger usa um único `DELETE`, preservando os `cap` rowids mais recentes. `cap=0` remove todos.
- A schema version só muda se uma alteração de tabela for necessária. As queries propostas funcionam com o schema atual, portanto não exigem migração.

### `LiveStreamState`

Novo módulo `src/rpc/stream-state.ts`:

```ts
interface LiveStreamOptions {
  publishIntervalMs: number;   // 100
  persistIntervalMs: number;   // 1000
  maxTextBytes: number;        // 192 * 1024
}

interface LiveStreamActions {
  publish(entry: TranscriptEntry): void;
  persist(entry: TranscriptEntry): void;
  abortForLimit(): void;
}
```

O estado mantém chunks, conteúdo materializado sob demanda, bytes UTF-8, horário da última publicação e horário do último checkpoint. O primeiro delta cria/persiste a entry streaming. Deltas seguintes:

1. acumulam chunk e bytes;
2. publicam `updated` somente após 100 ms;
3. persistem somente após 1.000 ms;
4. ao atingir 192 KiB, preservam o prefixo válido, abortam o provider e publicam notice explícita.

Na finalização, o conteúdo é materializado uma vez, persistido como `streaming:false` e publicado no shape existente.

## Alterações no `TurnRunner`

- Remover o snapshot integral do começo de `runTurn()`.
- Remover o snapshot integral ao concluir/falhar tool call; `updated` já contém a entry final.
- `latestAssistantPreview()` usa `getLatestAssistant()`.
- `closeOpenToolCalls()` usa `getOpenToolCalls()`.
- `toProviderMessages()` será substituído pela Onda 2; durante esta onda usa `getRecentEntries()` com limite compatível temporário.
- Identidade/config continuam inalterados nesta onda para isolar risco.

## Compatibilidade

- `appended`, `updated`, `message`, `send-message` e notices preservam o formato atual.
- Nenhum campo obrigatório novo é adicionado.
- Clientes que já hidratam por RPC continuam recebendo apenas mudanças incrementais.
- A RPC paginada existente não muda a direção/semântica nesta onda.

## Erros

- Falha de checkpoint parcial é capturada e registrada; o stream continua em memória.
- Falha da persistência final produz notice e erro do turno, sem fingir durabilidade.
- Excesso de 192 KiB gera notice específica, não uma desconexão SSE.
- O gateway mantém o teto de 256 KiB como última linha de defesa.

## Testes exigidos

1. Turno não publica snapshot no início.
2. Tool concluída publica `updated`, não snapshot integral.
3. 5.000 ticks geram número de persists limitado por checkpoints, não 5.000 replaces.
4. Frequência de `updated` respeita 100 ms com relógio injetado.
5. Texto acima de 192 KiB aborta com notice e nenhum frame excede 256 KiB.
6. Store com 10.000 entries consulta somente o tail solicitado.
7. Latest assistant e open tool calls não chamam `getEntries()`.
8. Outline retorna os mesmos valores sem carregar todo o transcript.
9. Poda de nonces preserva exatamente os `cap` mais recentes, inclusive `cap=0`.
10. Implementações SQLite e memória passam o mesmo contrato.

## Critérios de aceite

- Writes de streaming crescem com duração/checkpoint, não com deltas.
- Bytes SSE não incluem snapshots do transcript total.
- Conversa com 10.000 entries não desconecta ao iniciar turno.
- Todos os eventos consumidos pelo renderer mantêm shapes existentes.