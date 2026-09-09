# OpenBot Local User Profile Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Replace inherited logout/account UI with a persistent local display-name configuration.

**Architecture:** Extend the existing injected renderer override. Detect and hide the native account card, mount a scoped local-profile form in its place, persist the name in renderer profile storage and continuously reconcile the sidebar label after React renders.

**Tech Stack:** Electron renderer DOM/CSS, localStorage, Vitest contract tests, CDP visual verification.

---

### Task 1: Define the regression contract

**Files:**
- Modify: `test/electron-windows-patches.test.ts`

- [x] Assert the profile key, semantic form, bounded input and status region.
- [x] Assert logout/sign-out cleanup and Cursor dialog cancellation.
- [x] Run the focused test and confirm it fails before implementation.

### Task 2: Implement the local profile surface

**Files:**
- Modify: `client/extracted/dist/renderer/assets/openbot-local-settings.js`

- [x] Add scoped, responsive CSS using existing UI tokens.
- [x] Detect the native account card and replace it with the local form.
- [x] Normalize, validate and persist the chosen name.
- [x] Reconcile the saved name in the sidebar without editing the compiled React bundle.
- [x] Cancel/hide inherited sign-out dialogs and controls.

### Task 3: Verify real renderer behavior

**Files:**
- Modify: `scripts/visual-ui-verify.mjs`

- [x] Add an isolated account-card fixture matching the renderer semantics.
- [x] Prove native card replacement, name persistence, label propagation and absence of legacy account text.
- [x] Run syntax, focused unit, typecheck, visual and desktop E2E gates.

### Task 4: Record acceptance

**Files:**
- Create: `docs/openbot-local-user-profile-acceptance-2026-08-16.md`
- Modify: `docs/openbot-readiness-assessment-2026-08-16.md`

- [x] Record behavior, storage boundary, commands and evidence paths.
- [x] Link the acceptance note from the readiness document.
