# OpenBot Desktop Motion Polish Design

## Goal

Make observed desktop surface changes feel continuous and deliberate without changing the proprietary renderer, application behavior, or visual identity.

## Observed baseline

- The local provider panel and native workflow listbox appear fully formed in a single frame; the current local layer has no reusable entry-motion helper.
- Streaming messages, retry notices, and status feedback are inserted without a local entrance treatment.
- Buttons in the local panel have inconsistent press feedback (`translateY(1px)` versus `scale(.96)`).
- The welcome overlay already has motion, but its 520–1100 ms entrance is slower than the requested 160–320 ms desktop rhythm.
- The existing global `MutationObserver` scans the complete document subtree. New motion work must not add a second global observer or force layout in the mutation callback.

## Approaches considered

1. **Local DOM/WAAPI layer (selected).** Add a small set of semantic selectors, a `WeakSet` de-duplication guard, and one WAAPI entrance helper inside `openbot-local-settings.js`. Reuse the existing observer records and schedule work once per animation frame.
2. **CSS-only broad selectors.** Simpler, but CSS animations replay when React changes classes and cannot reliably distinguish first entry from state updates.
3. **Patch proprietary React/Motion chunks.** Offers component-level exits, but violates the clean-room boundary and would be brittle across bundle changes.

## Design

### Motion primitives

- `surface`: opacity 0 → 1, translateY 6 px → 0, scale .985 → 1, 220 ms.
- `panel`: opacity 0 → 1, translateX 8 px → 0, scale .99 → 1, 260 ms.
- `message`: opacity 0 → 1, translateY 6 px → 0, 200 ms.
- `status`: opacity 0 → 1, translateY 4 px → 0, 180 ms.
- Easing: `cubic-bezier(.22,1,.36,1)`.

Only `transform` and `opacity` are animated. Each connected element runs at most once. If `prefers-reduced-motion: reduce` matches, the helper records the element as handled and creates no animation.

### Stable targets

- Local settings: `#openbot-provider-settings` and its discovered settings mount.
- Native menus/popovers: `.sand-workflow-listbox`, `[role="menu"]`, visible `[role="listbox"]`.
- Native modal surfaces: visible `[role="dialog"]` excluding the already-managed welcome overlay.
- Main detail/chat screen: newly connected `main.sand-chat`.
- Transcript entries: newly added visible message-level nodes inside `main.sand-chat`; inner descendants are collapsed to one target.
- Local feedback: `#openbot-status`, `#openbot-profile-status`, `.ob-retry-generation`, and the stop control when it becomes visible.

No minified StyleX class other than the established semantic `sand-*` markers is used as an identity contract.

### Lifecycle and performance

- Reuse one observer; process only `addedNodes` and relevant local attribute changes.
- Queue a single `requestAnimationFrame`; collect targets in a `Set` to avoid repeated work and layout reads.
- Bind the observer to `#root` when available, with a short-lived document fallback only until React creates the root.
- Cancel queued animation-frame work and active local WAAPI animations on `pagehide`.
- Do not delay React unmounts and do not synthesize clicks, focus, or keyboard events.

### Verification

- Static regression tests assert the bounded observer, reduced-motion short circuit, de-duplication, cleanup, explicit transition properties, and duration constants.
- The isolated visual gate captures comparable screenshots and samples animation state immediately after opening a settings panel/menu.
- The desktop E2E continues to cover real chat, streaming, cancellation/reconnection, retry, workflow menu, runtime errors, cleanup, and free ports.
- Manual DOM checks cover rapid repeat open/switch, resize, keyboard focus, duplicate animation prevention, reduced motion, and idle animation count/CPU.

## Scope boundary

Safe exit animations are limited to the local welcome overlay. Native React surfaces may unmount synchronously, so the patch prioritizes deterministic entrances and interruptible interaction states.
