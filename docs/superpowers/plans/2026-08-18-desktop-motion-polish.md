# OpenBot Desktop Motion Polish Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Add a small removable motion layer to the precompiled OpenBot desktop renderer and prove it through isolated visual and functional gates.

**Architecture:** Keep all runtime behavior in the existing injected renderer script. Reuse its observer, gate motion through `matchMedia`, de-duplicate elements with `WeakSet`, and animate only semantic surfaces via WAAPI or explicit CSS transitions.

**Tech Stack:** Electron 41, browser DOM APIs, Web Animations API, CSS, Vitest, CDP visual harness.

---

### Task 1: Lock the motion contract with focused tests

**Files:**
- Modify: `test/electron-windows-patches.test.ts`

- [ ] Add a focused test that requires `MOTION_EASING`, the 180/200/220/260 ms durations, a `WeakSet`, a reduced-motion query, `Element.animate`, one animation-frame queue, and `pagehide` cleanup.
- [ ] Assert the observer consumes mutation records and does not introduce a second observer.
- [ ] Assert the CSS contains no `transition:all`, and reduced motion disables local transitions and animations.
- [ ] Run `npx vitest run test/electron-windows-patches.test.ts --maxWorkers=1 --no-file-parallelism`; expect the new motion test to fail before implementation.

### Task 2: Implement the bounded motion infrastructure

**Files:**
- Modify: `client/extracted/dist/renderer/assets/openbot-local-settings.js`

- [ ] Add explicit motion constants and `motionReduced()`.
- [ ] Add `animateOnce(element, kind)` with keyframes limited to opacity/transform, `WeakSet` de-duplication, cancellation tracking, and cleanup after `finished`.
- [ ] Add target classification for settings, dialogs/listboxes, `main.sand-chat`, transcript additions, retry/status feedback, and the stop control.
- [ ] Feed only observer `addedNodes`/relevant attributes into a `Set`, flush once through `requestAnimationFrame`, and bind observation to `#root` as soon as it exists.
- [ ] Cancel the frame, animations, timers, and observer on `pagehide` without altering React teardown.
- [ ] Normalize local button press feedback to `scale(.96)` and shorten welcome motion to the 180–320 ms range.
- [ ] Run `node --check client/extracted/dist/renderer/assets/openbot-local-settings.js` and the focused Vitest file; expect both to pass.

### Task 3: Extend measurable visual evidence

**Files:**
- Modify: `scripts/visual-ui-verify.mjs`

- [ ] Capture computed WAAPI animation metadata immediately after the settings surface enters.
- [ ] Emulate `prefers-reduced-motion: reduce`, recreate a settings surface, and assert no OpenBot WAAPI animation is created.
- [ ] Exercise repeated settings opening, resize, focus-by-keyboard, and duplicate-animation counts without depending on real user data.
- [ ] Preserve before/after screenshots in separate run directories and print the evidence directory.
- [ ] Run `npm run verify:visual-ui`; expect `VISUAL_UI_GATE GREEN` with motion and reduced-motion checks present.

### Task 4: Run full proportional verification

**Files:**
- Update generated artifact hash only if the existing client-artifact manifest requires it.

- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run the focused renderer test serially.
- [ ] Run `npm test -- --maxWorkers=1 --no-file-parallelism`.
- [ ] Run `npm run verify:e2e:desktop` and confirm streaming, cancellation, reconnect, retry, menus, runtime errors, cleanup, and free ports remain green.
- [ ] Run `npm run verify:visual-ui` and inspect before/after screenshots.
- [ ] Verify no owned OpenBot/Electron process remains and loopback ports used by the gates are free.
- [ ] Measure idle renderer CPU over a bounded interval and confirm there are no active OpenBot animations at rest.

### Task 5: Final review

**Files:**
- Review all files changed above.

- [ ] Inspect the exact changed-file hashes because no Git history is available.
- [ ] Check selectors, focus semantics, keyboard behavior, reduced motion, cleanup, and observer scope against the design.
- [ ] Report only observed improvements and explicitly retain the precompiled-renderer limitation for unsafe exits and unexercised native surfaces.
