# OpenCode Go Provider Implementation Plan

> **For Codex:** Execute this plan inline with the `executing-plans` workflow. This checkout has no Git metadata; do not create commits.

**Goal:** Add OpenCode Go with encrypted API-key storage, live model discovery, and protocol-correct streaming for Responses, Chat Completions, and Anthropic Messages.

**Architecture:** A dedicated adapter owns model discovery and delegates OpenAI-compatible traffic to the existing adapter while implementing the small Anthropic SSE surface locally. Static metadata defines the safe protocol for known IDs; the UI exposes only IDs confirmed by `GET /models`.

**Tech Stack:** TypeScript, Electron IPC, native `fetch`, Vitest, injected renderer JavaScript.

---

### Task 1: Provider contract and transport

**Files:**
- Create: `src/providers/opencode-go.ts`
- Modify: `src/providers/openai.ts`
- Test: `test/opencode-go.test.ts`

1. Add failing tests for discovery, protocol routing, missing credentials, unknown models, and Anthropic text/tool SSE.
2. Extend `OpenAiAdapter` with an explicit Responses protocol.
3. Implement the OpenCode Go protocol map, discovery, filtering, and three transports.
4. Run `npx vitest run test/opencode-go.test.ts --maxWorkers=1 --no-file-parallelism`.

### Task 2: Runtime registration and dynamic catalog

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/config/models.ts`
- Modify: `src/config/store.ts`
- Modify: `src/providers/capabilities.ts`
- Modify: `src/rpc/roster.ts`
- Modify: `src/rpc/identity.ts`
- Modify: `src/main.ts`
- Test: relevant config, roster, capability, and provider tests

1. Register `opencode-go` as a first-class provider and add known model metadata.
2. Return OpenCode models only when live discovery confirms them.
3. Register the adapter with the existing keystore credential resolver.
4. Run focused runtime tests and typecheck.

### Task 3: Secure API-key IPC and renderer flow

**Files:**
- Modify: Electron main/preload bridge files located by existing OAuth handlers
- Modify: `client/extracted/dist/renderer/assets/openbot-local-settings.js`
- Test: Electron source-contract and renderer-boundary tests

1. Add a narrow IPC operation that accepts keys only for `opencode-go` and stores them through the keystore.
2. Add OpenCode Go to the provider selector and show its API-key controls only for that provider.
3. Refresh detected models after save; disconnect deletes the key and removes discovered models.
4. Run bridge and renderer tests.

### Task 4: Verification and artifact integrity

**Files:**
- Modify: generated client manifest/provenance hashes only if required by repository checks

1. Run the full focused test set, typecheck, and build.
2. Refresh integrity hashes using the repository's existing command when checks identify stale artifacts.
3. Re-run all affected checks and report exact pass/fail evidence.
