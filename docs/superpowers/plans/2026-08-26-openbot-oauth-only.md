# OpenBot OAuth-Only Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Replace the active API-key setup with xAI subscription OAuth and ChatGPT Codex OAuth.

**Architecture:** A backend OAuth coordinator owns login, encrypted credentials, refresh and logout. Existing provider adapters receive short-lived Bearer credentials; the renderer receives status only.

**Tech Stack:** TypeScript, Node HTTP/fetch/crypto, Electron IPC, Vitest.

---

### Task 1: OAuth coordinator

**Files:**
- Create: `src/providers/oauth.ts`
- Test: `test/provider-oauth.test.ts`

- [ ] Test PKCE, Codex callback/token exchange, xAI device flow, refresh and secret-free status.
- [ ] Implement `ProviderOAuthManager` with `start`, `status`, `cancel`, `disconnect` and `resolveCredential`.
- [ ] Persist `{type:"oauth",access,refresh,expires,accountId?}` through the existing encrypted keystore.
- [ ] Run `vitest run test/provider-oauth.test.ts --maxWorkers=1 --no-file-parallelism` and require PASS.

### Task 2: Provider and gateway integration

**Files:**
- Modify: `src/providers/openai.ts`
- Modify: `src/providers/request-bodies.ts`
- Modify: `src/main.ts`
- Modify: `src/server/gateway.ts`
- Test: `test/providers.test.ts`

- [ ] Add injectable OAuth credential resolution without removing test-only API-key injection.
- [ ] Route OpenAI production traffic to Codex Responses with its account header and request body.
- [ ] Route xAI production traffic with its refreshed OAuth Bearer token.
- [ ] Register OAuth RPC methods and run provider/gateway tests.

### Task 3: Electron and renderer

**Files:**
- Modify: `client/extracted/dist/electron-main/main.cjs`
- Modify: `client/extracted/dist/electron-preload/preload.cjs`
- Modify: `client/extracted/dist/renderer/assets/openbot-local-settings.js`
- Modify: `test/electron-windows-patches.test.ts`

- [ ] Expose trusted IPC for start/status/cancel/disconnect.
- [ ] Show only xAI and OpenAI Codex, with connect/cancel/disconnect states.
- [ ] Remove API-key, Base URL and OpenAI-compatible controls from the active UI.
- [ ] Run the focused Electron test and artifact verification.

### Task 4: Verification

- [ ] Run `npm run typecheck`.
- [ ] Run focused OAuth/provider/Electron/keystore tests serially.
- [ ] Run `npm run verify:client-artifacts` and update only generated integrity metadata if required.
- [ ] Inspect modified files and report live-login validation as pending when user interaction is required.

