# OpenBot Release Identity and Context Budget Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Ship OpenBot 0.1.1 with an immutable build identity and separate token and serialized-byte context budgets.

**Architecture:** A release is identified by `productVersion`, a deterministic source `buildId`, its packaged `contentSha256`, and `generatedAt`; installed directories and rollback state use a release ID derived from version plus build ID. Context retention uses an explicit token estimator and model capabilities, while the final adapter serializer enforces `maxRequestBytes` independently.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, Windows portable release scripts.

**Spec:** `auditoria_openbot_persistencia_memoria_contexto.md` sections 8.4-8.6 plus the user requirements dated 2026-09-01.

> **Reconciliação documental — 06/09/2026:** os checkboxes originais não são um inventário atual. O checkout já declara versão 0.1.1 em [package.json](../../../package.json) e implementa a estratégia estimated com recusa explícita de provider sem tokenizer em [model-context.ts](../../../src/memory/model-context.ts). Não repetir essas implementações por causa dos campos desmarcados; verificar separadamente os demais requisitos e evidências de instalação.

## Global Constraints

- Preserve the extracted renderer; only stamp the packaged copy of the existing About text.
- Do not add a tokenizer dependency or a second provider serializer.
- Keep legacy install state readable long enough to update the active 0.1.0 installation.
- Add only focused tests for new identity collision and token/byte separation behavior.

---

### Task 1: Immutable release identity

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `scripts/release.mjs`, `scripts/release-common.mjs`
- Modify: `scripts/install.mjs`, `scripts/update.mjs`, `scripts/launch.mjs`
- Test: `test/release-lifecycle.test.ts`

**Interfaces:**
- Produces manifest fields `productVersion`, `buildId`, `releaseId`, `contentSha256`, `generatedAt`.
- Produces install-state fields `activeBuildId`, `activeReleaseId`, `activeContentSha256` and previous/staged counterparts.

- [ ] Bump the product version to `0.1.1`.
- [ ] Derive a deterministic SHA-256 `buildId` from packaged source inputs before publication.
- [ ] Validate all identity fields and stamp version/build into the packaged About text.
- [ ] Install into `versions/<productVersion>-<buildId-prefix>` and reject exact duplicate updates without overwriting a materially different build.
- [ ] Preserve distinct previous release identity and backup linkage for rollback.
- [ ] Emit release identity at launch and include it in process/install state.
- [ ] Run `npm run verify:release-lifecycle` and require PASS.

### Task 2: Token and wire-byte budgets

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/providers/opencode-go-models.ts`, `src/config/models.ts`
- Modify: `src/memory/model-context.ts`, `src/memory/context.ts`, `src/rpc/send.ts`
- Test: `test/model-context.test.ts`, `test/shared-contracts.test.ts`

**Interfaces:**
- Extends `ModelCapabilities` with `maxRequestBytes`.
- Adds tokenizer strategy `estimated`; `provider` fails explicitly until supplied by an adapter.
- Adds provider-round telemetry fields `estimatedInputTokens`, `serializedRequestBytes`, `retainedTurns`, `droppedTurns`, `truncationReason`.

- [ ] Add a deterministic conservative token estimator for PT-BR, code, JSON, Unicode, tool text, and image placeholders.
- [ ] Make `provider` fail explicitly rather than falling back to bytes.
- [ ] Populate model token/output/byte capabilities, using the current local OpenCode Go catalog.
- [ ] Replace the global 256 KiB send/assembly cap with each model's `maxRequestBytes`, retaining 256 KiB only for unknown models.
- [ ] Report final token and serialized-wire metrics from the same serializer used by each adapter.
- [ ] Run focused model/context/shared-contract tests, typecheck, and build; require PASS.

### Task 3: Package and deployment proof

**Files:**
- Generated only after gates: `release/OpenBot-0.1.1-win32-x64*`
- External managed install state: `%LOCALAPPDATA%\Programs\OpenBot\state.json` (resolved by scripts)

- [ ] Initialize Git metadata without inventing history for excluded/generated files.
- [ ] Run the relevant readiness gates before `npm run release:package`.
- [ ] Create a data backup, update the managed installation with the new package, and verify package/install hashes.
- [ ] Confirm recovery status exposes distinct active/previous release identities and a non-null backup.
