# OpenBot Chat And Provider Resilience Design

## Objective

Make local chat failure handling deterministic and recoverable without changing the existing provider architecture or introducing background infrastructure.

## Decisions

- Pin provider and model when a prompt is accepted. Configuration changes affect only prompts accepted afterward.
- Preserve the original user entry during a retry. A retry creates a new attempt marker and assistant response, never a duplicate user message.
- Retry the latest retryable failed turn through a dedicated `retryPrompt` RPC. Repeated clicks on the same failure are idempotent.
- Persist provider/model/turn provenance and normalized failure metadata in transcript entries.
- Treat structurally invalid chat-completions SSE frames as provider failures instead of successful empty responses.
- Honor bounded `Retry-After` values for HTTP 429/5xx responses. Do not automatically repeat a request that already consumed the full provider timeout.
- Drive the renderer stop control from a gateway prompt-status RPC. Transport uncertainty keeps cancellation available instead of hiding it on a fixed timer.

## Data Flow

1. `sendPrompt` validates the request and captures `{provider, model}` before enqueueing.
2. `runTurn` persists the user echo or, for retry, a durable `retry-attempt` event.
3. Provider events update one assistant entry carrying turn/provider/model provenance.
4. Failure notices carry normalized kind, code, retryability, turn identity and the originating client nonce.
5. `retryPrompt` selects the latest retryable notice, reconstructs the original prompt and attachments, and enqueues one idempotent attempt pinned to the original provider/model.
6. The renderer presents “Tentar novamente” only for provider-generation failures and calls the dedicated IPC bridge method.

## Error Policy

- Network: explain that the internet or local provider is unreachable.
- Timeout: explain that the provider exceeded its response limit.
- Rate limit: explain that the usage limit was reached and retry is possible.
- Server: explain that the provider is temporarily unavailable.
- Authentication: direct the user to provider settings; never mark retryable.
- Validation: explain that the request/model was rejected; never mark retryable.
- Invalid SSE: classify as a retryable provider/server failure when no output was observed; preserve partial output and avoid automatic replay after a delta.

## Verification

- Provider tests: invalid SSE, incomplete tool call, Retry-After and timeout retry policy.
- Turn-runner tests: pinned inference, structured error notice, idempotent safe retry and no duplicate user entry.
- Store tests: retry-attempt nonce survives restart reconciliation.
- Electron patch tests: status/retry IPC exposure and removal of the 120-second cancellation fallback.
- Focused tests, typecheck, build, complete serial suite, client artifact verification and isolated desktop smoke.

## Scope

No automatic provider failover, automatic updates, cloud telemetry, conversation rewriting or provider-specific SDK migration.
