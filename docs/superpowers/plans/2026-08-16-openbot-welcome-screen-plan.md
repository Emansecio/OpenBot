# OpenBot Welcome Screen Implementation Plan

> **For agentic workers:** Execute each task with focused validation and preserve the existing injected-renderer boundary.

**Goal:** Add a first-access welcome experience that transitions into the existing bots screen.

**Architecture:** The welcome layer is owned by `openbot-local-settings.js`, stores completion in renderer-local storage, and temporarily makes `#root` inert. No main-process or IPC changes are required.

**Tech Stack:** Electron renderer, DOM/CSS, Vitest contract tests, CDP visual verification.

---

### Task 1: Add the generated asset

- Save the ImageGen output as `client/extracted/dist/renderer/assets/openbot-welcome-renaissance.png`.
- Verify dimensions, checksum and renderer-relative URL.

### Task 2: Implement welcome behavior

- Add scoped CSS, reduced-motion handling and responsive layout.
- Add accessible dialog markup, focus handling, persistence and interruptible exit animation.
- Restore the app root before removing the overlay.

### Task 3: Protect behavior with tests

- Extend the renderer contract test for semantics, persistence and asset reference.
- Extend CDP visual verification to capture, inspect and dismiss the welcome screen.
- Make desktop E2E dismiss the first-run screen before testing the main app.

### Task 4: Validate and document

- Run focused unit/type checks and the native visual check.
- Record commands, evidence and any remaining limitation in the project status documentation.
