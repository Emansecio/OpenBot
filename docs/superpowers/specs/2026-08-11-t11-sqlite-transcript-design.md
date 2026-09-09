# T11 — Persistência SQLite do transcript e rotas de leitura

> **Status atual (2026-08-12): documento histórico.** Este documento preserva o plano/design original. O estado executável atual está em [`../../phase-2-local-execution-progress.md`](../../phase-2-local-execution-progress.md) e no [`README`](../../../README.md).


## Objetivo

Substituir o store em memória do T10 por um store SQLite local, preservando transcript e dedupe de `clientNonce` após restart, e expor as três rotas RPC de leitura previstas no contrato MVP:

- `getAgentTranscriptTail`;
- `openAgentTail`;
- `getConversationOutline`.

Roster, settings, catálogo mutável e configuração local permanecem fora do T11.

## Arquitetura

O store será uma implementação síncrona de `TranscriptStore`, usando `better-sqlite3`, para manter o contrato atual do `TurnRunner` síncrono nas operações de aceitação, leitura e append. Uma conexão SQLite será criada por instância do servidor e fechada no encerramento.

O banco será único por instalação (`store.db`) e particionado por `agentId`. O caminho será configurável nos testes e, no boot de produção, ficará em `%APPDATA%\\OpenBot\\store.db` através da opção já existente de diretório de dados.

### Schema

A inicialização usará migração versionada via `PRAGMA user_version` e prepared statements:

```sql
CREATE TABLE IF NOT EXISTS transcript_entries (
  sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  entry_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transcript_agent_sequence
  ON transcript_entries(agent_id, sequence_id);

CREATE TABLE IF NOT EXISTS accepted_nonces (
  agent_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  PRIMARY KEY (agent_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_nonce_agent_time
  ON accepted_nonces(agent_id, accepted_at_ms);
```

O payload completo da `TranscriptEntry` será serializado em `payload_json`, evitando que o schema precise conhecer todas as variantes do contrato. `entry_id` e `created_at_ms` serão derivados quando existirem; entries sem esses campos continuam válidas.

A conexão habilitará `foreign_keys`, `WAL`, `synchronous=NORMAL` e `busy_timeout`. Todas as queries com valores externos usarão parâmetros; não haverá interpolação de `agentId`, cursor, nonce ou JSON.

## API do store

`SqliteTranscriptStore` implementará:

- `getEntries(agentId): readonly TranscriptEntry[]` — todas as entries em ordem cronológica;
- `append(agentId, entries)` — inserção em uma transação única, preservando a ordem recebida;
- `clear(agentId)` — remove transcript e ledger do agente;
- `hasAcceptedNonce(agentId, nonce)`;
- `rememberAcceptedNonce(agentId, nonce)` — inserção idempotente por `(agentId, nonce)`;
- `trimAcceptedNonces(agentId, cap)` — remove os nonces mais antigos até atingir a capacidade;
- `getAgentTranscriptTail(agentId, limit?, cursor?)`;
- `openAgentTail(agentId, limit?, cursor?)` — alias semântico para a mesma leitura paginada;
- `getConversationOutline(agentId)` — título/primeira mensagem identificável e última mensagem, ou outline vazio para histórico inexistente.

A paginação será baseada em cursor opaco contendo o último `sequence_id` retornado. A query buscará entries do agente com `sequence_id > cursor`, ordenadas ascendentemente, limitadas a `limit + 1`; o item extra servirá para decidir se existe `nextCursor`. Cursor inválido ou pertencente a outro agente será rejeitado antes da query.

O limite padrão será finito e o máximo será limitado para evitar respostas descontroladas. O shape retornado por transcript será `SandTranscriptPage { entries, nextCursor? }`.

## Rotas RPC

`registerRpcHandlers` registrará os handlers de T10 e T11:

- `getAgentTranscriptTail`;
- `openAgentTail`;
- `getConversationOutline`.

Cada handler validará um objeto com `agentId` string não vazia. `limit`, quando presente, deverá ser inteiro positivo dentro do máximo definido. `cursor`, quando presente, deverá ter formato válido. Falhas de validação retornarão `RpcError(400)` e o gateway produzirá `{ok:false,failure}`.

## Integração no bootstrap

`startServer` criará o store SQLite e o injetará em `registerRpcHandlers`, que por sua vez o entregará ao `TurnRunner`. O `ServerHandle` exporá o store para testes e encerrará a conexão no caminho normal de `stopServer`.

O diretório de dados será configurável para testes. O boot não apagará nem recriará o banco existente; abrirá o arquivo e executará migrações idempotentes.

## Tratamento de erros

- Falhas de validação RPC: HTTP 400 com envelope de falha.
- Falha de abertura/migração do banco: rejeição do bootstrap com erro operacional; o servidor não aceitará requisições com store parcialmente inicializado.
- Falha de leitura/escrita durante RPC: HTTP 500 com mensagem genérica, sem SQL, caminhos internos ou conteúdo sensível.
- Append de múltiplas entries: transação atômica; nenhuma parte será persistida se a operação falhar.

## Testes

Adicionar testes unitários e de integração para:

1. schema inicializado e operações básicas;
2. entries preservadas em ordem e com todos os campos após serialização JSON;
3. append atômico;
4. reabertura do mesmo arquivo preservando transcript;
5. dedupe de nonce preservado após reabertura;
6. limpeza FIFO do ledger;
7. paginação, `nextCursor`, limite e cursor inválido;
8. outline vazio e outline com mensagens;
9. três rotas HTTP com envelopes, validação e dados persistidos;
10. fluxo T10 completo usando SQLite em vez do store em memória.

Comandos de aceite:

```text
npm run build
npm test
```

O aceite exige build sem erros e todos os testes existentes mais os novos verdes.
