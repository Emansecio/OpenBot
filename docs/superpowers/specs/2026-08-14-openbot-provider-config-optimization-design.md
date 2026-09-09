# Onda 3 — Providers e configuração

## Objetivo

Tornar falhas transitórias recuperáveis, eliminar transporte duplicado e remover config pesado do hot path.

## Transporte OpenAI-like compartilhado

Novo módulo `src/providers/openai-transport.ts`:

```ts
interface OpenAiTransportTimeouts {
  connectMs: number; // 30_000
  idleMs: number;    // 120_000
  totalMs: number;   // 300_000
}

interface OpenAiRetryPolicy {
  maxRetries: number; // 2
  baseDelayMs: number; // 250
  maxDelayMs: number;  // 2_000
}
```

O transport recebe URL, headers, body, fetch injetável, AbortSignal, timeouts, retry policy, sleep/random injetáveis e callback de evento parcial.

### Timeouts

- Connect: inicia antes do fetch e encerra ao receber headers.
- Idle: inicia ao receber body e reinicia a cada chunk.
- Total: cobre a tentativa inteira.
- Abort externo tem precedência e vira `aborted`.
- Timeout interno lança erro com `code='ETIMEDOUT'`, `phase='connect'|'idle'|'total'` e classificação `network`.

### Retry

- Elegíveis: 429, 5xx e erros network/ETIMEDOUT.
- Máximo: tentativa inicial + 2 retries.
- Proibido se qualquer delta ou tool call já foi entregue ao caller.
- Delay: exponencial com jitter, limitado a 2 s.
- `Retry-After` em segundos ou data HTTP é respeitado até 10 s.
- 400/401/403/404/422 nunca são retentados.

### SSE

Um único parser incremental processa CRLF/LF, frames multi-line, `[DONE]`, limite de 1 MiB e tool-call chunks. OpenAI e OpenAI-compatible apenas configuram auth, URL e label. xAI continua reutilizando o adapter OpenAI.

## ConfigStore leve

`ConfigStore` ganha revisão monotônica e selectors:

```ts
get revision(): number;
getProfile(): LocalProfile;
getAgent(agentId: string): LocalAgent | undefined;
getAgents(): readonly LocalAgent[];
getHostSettings(): SandHostSettings;
getInference(agentId?: string): ResolvedProvider;
```

Selectors devolvem cópias apenas do fragmento solicitado. `snapshot()` permanece para compatibilidade, mas sai do streaming e dos loops por agente.

O `TurnRunner` captura uma identidade imutável no começo do turno:

```ts
interface TurnIdentity {
  agent: TranscriptAgentRef;
  human: TranscriptUserRef;
  systemPrompt: string;
  provider: string;
  model: string;
  maxOutputTokens: number;
}
```

Mudanças de nome/modelo durante um turno entram no turno seguinte. Isso evita clones repetidos e torna a semântica determinística.

## Migração de avatar

Nova função idempotente chamada no bootstrap depois de criar `AgentHomeStore`:

```ts
migrateLegacyAgentAvatars(config, homes): Promise<void>
```

Para cada agent com `avatarPngBase64`:

1. decodifica e valida 1..2 MiB;
2. garante a home;
3. grava `.openbot/avatar.png` por temporário exclusivo + rename;
4. somente após sucesso remove o campo do agent e persiste config;
5. em falha, preserva base64 e registra warning sem impedir boot.

`setAgentAvatarBytes` grava somente arquivo e metadata; nunca reintroduz base64. `getAgentAvatar` lê arquivo e mantém fallback legado enquanto houver migração pendente.

## Capabilities e parâmetros reais

`ModelCatalogEntry` recebe campos opcionais `contextWindow` e `maxOutputTokens`, expostos de forma aditiva ao cliente. O runner usa `maxOutputTokens` em `ProviderChatRequest.maxTokens`.

`toClientDefaultModel()` deixa de anunciar `effort=high` e `fast=true` quando esses parâmetros não são enviados. O shape `parameters: []` é preservado. Não será enviado parâmetro provider-specific sem capability explícita.

O system prompt passa a ter uma única identidade:

- usa o nome/persona do agent;
- pede resposta no idioma do usuário;
- descreve tools locais quando disponíveis;
- não afirma simultaneamente “You are <nome>” e “You are OpenBot”;
- não afirma que a inferência está local quando o provider é remoto.

## Erros

- Timeout interno e cancelamento externo nunca compartilham classificação.
- Retry esgotado retorna o último `ProviderError` com número de tentativas.
- Migração de avatar parcial é recuperável e idempotente.
- Selector nunca expõe referência mutável ao config interno.
- Capability ausente usa default OpenAI-compatible 32k/4k.

## Testes exigidos

1. Timeout real do adapter retorna `network`, `ETIMEDOUT`, retryable.
2. Abort externo retorna `aborted` e zero retries.
3. 429/5xx/network antes do primeiro delta retentam no máximo duas vezes.
4. Erro após delta não retenta.
5. `Retry-After` é respeitado com sleep injetado.
6. OpenAI e compat passam a mesma suíte de contrato do transport.
7. Selectors não clonam avatar/config completo e não permitem mutação interna.
8. Um turno captura identidade uma vez e não chama `snapshot()` por delta.
9. Avatar legado migra e é removido do JSON somente após sucesso.
10. Falha de escrita preserva base64 e o boot continua.
11. Novo avatar não é persistido em base64.
12. `maxTokens` deriva da capability e parâmetros cosméticos deixam de ser anunciados.
13. System prompt contém uma única identidade.

## Critérios de aceite

- Reprodução anterior de timeout deixa de retornar `unknown`.
- Nenhum retry ocorre após saída parcial.
- Hot path do stream não executa `structuredClone` do config.
- Config persistente não cresce com bytes de avatar após migração.
- OpenAI e compat compartilham uma implementação de transporte.