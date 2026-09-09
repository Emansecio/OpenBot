# Local Profile and Settings Hardening Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Persist local profile identity and appearance, remove unsupported Settings surfaces, and keep Settings centered from first paint.

**Architecture:** `OpenBotConfig.profile` remains the source of truth and gains optional appearance fields. Gateway handlers expose a narrow local-profile API through guarded Electron IPC; injected renderer uses that API and only reads legacy localStorage for one-time migration. Unsupported inherited routes are removed by exact-label DOM sanitization, and panel motion never writes `transform`.

**Tech Stack:** TypeScript, Node.js, Electron IPC, browser DOM JavaScript, Vitest.

---

### Task 1: Persist local profile in gateway

**Files:**
- Modify: `src/config/store.ts`
- Modify: `src/rpc/roster.ts`
- Modify: `src/server/gateway.ts`
- Test: `test/config-store.test.ts`
- Test: `test/roster-agents.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving legacy `Local User` migrates to `OpenBot Local`, `getLocalProfile` returns profile, `updateLocalProfile` persists trimmed name/appearance, and invalid empty name or invalid PNG returns 400.

```ts
expect(store.snapshot().profile.name).toBe("OpenBot Local");
expect((await post(handle, "updateLocalProfile", {
  name: " Openbot ", avatarShape: "rounded", avatarColor: "#7c3aed",
})).json.value).toMatchObject({ name: "Openbot", avatarShape: "rounded", avatarColor: "#7c3aed" });
expect(handle.config.snapshot().profile.name).toBe("Openbot");
```

- [ ] **Step 2: Verify RED**

Run: `vitest run test/config-store.test.ts test/roster-agents.test.ts --maxWorkers=1 --no-file-parallelism`

Expected: FAIL because migration and local-profile handlers do not exist.

- [ ] **Step 3: Implement minimal profile contract**

Extend `LocalProfile` with optional `avatarShape`, `avatarColor`, and `avatarPngBase64`; default/migrate name to `OpenBot Local`. Register:

```ts
gateway.registerHandler("getLocalProfile", () => structuredClone(config.snapshot().profile));
gateway.registerHandler("updateLocalProfile", (body) => {
  // normalize name; validate shape/color/PNG; config.update({ profile: patch })
  return structuredClone(config.snapshot().profile);
});
```

Add both method names to gateway allowlist.

- [ ] **Step 4: Verify GREEN**

Run same Vitest command. Expected: PASS.

### Task 2: Add guarded Electron profile bridge

**Files:**
- Modify: `client/extracted/dist/electron-main/main.cjs`
- Modify: `client/extracted/dist/electron-preload/preload.cjs`
- Test: `test/electron-windows-patches.test.ts`

- [ ] **Step 1: Write failing bridge assertions**

```ts
expect(main).toMatch(/"sand:local-profile-set"[\s\S]{0,250}assertTrustedSecretsSender[\s\S]{0,200}assertOpenBotLocalMode/);
expect(preload).toContain('invoke("sand:local-profile-get")');
expect(preload).toContain('invoke("sand:local-profile-set", profile)');
```

- [ ] **Step 2: Verify RED**

Run: `vitest run test/electron-windows-patches.test.ts --maxWorkers=1 --no-file-parallelism`

Expected: FAIL because IPC channels are absent.

- [ ] **Step 3: Add bridge**

Main process:

```js
ipcMain.handle("sand:local-profile-get", () => callOpenBotProviderRpc("getLocalProfile"));
ipcMain.handle("sand:local-profile-set", (_event, profile) => {
  senderGuards.assertTrustedSecretsSender(_event);
  assertOpenBotLocalMode();
  return callOpenBotProviderRpc("updateLocalProfile", profile ?? {});
});
```

Preload `desktop.agent` gains `getLocalProfile()` and `updateLocalProfile(profile)`.

- [ ] **Step 4: Verify GREEN**

Run focused test. Expected: PASS.

### Task 3: Give local profile durable appearance controls

**Files:**
- Modify: `client/extracted/dist/renderer/assets/openbot-local-settings.js`
- Test: `test/electron-windows-patches.test.ts`

- [ ] **Step 1: Write failing renderer assertions**

Require gateway hydration/save, color controls, shape controls, PNG upload/removal, and localStorage migration-only behavior.

```ts
expect(settings).toContain("getLocalProfile()");
expect(settings).toContain("updateLocalProfile(");
expect(settings).toContain('id="openbot-profile-avatar-file"');
expect(settings).toContain('data-avatar-shape="rounded"');
expect(settings).not.toContain("localStorage.setItem(PROFILE_KEY, name)");
```

- [ ] **Step 2: Verify RED**

Run focused patch test. Expected: FAIL on new assertions.

- [ ] **Step 3: Implement renderer profile state**

Hydrate from backend, migrate legacy localStorage name only when backend is still default, preview persisted appearance, validate PNG client-side, and submit one profile object. Keep keyboard labels/status and 700 KiB limit.

- [ ] **Step 4: Verify GREEN**

Run focused patch test. Expected: PASS.

### Task 4: Remove unsupported routes and preserve centering

**Files:**
- Modify: `client/extracted/dist/renderer/assets/openbot-local-settings.js`
- Test: `test/electron-windows-patches.test.ts`

- [ ] **Step 1: Write failing assertions**

```ts
expect(settings).toContain('UNAVAILABLE_NAV_LABELS');
expect(settings).toContain('Help Center|Send Feedback|Updates');
expect(settings).toContain("blockUnavailableNavigation");
expect(settings).toMatch(/kind === "panel"[\s\S]{0,180}opacity/);
expect(settings).not.toMatch(/kind === "panel"[\s\S]{0,180}config\.from/);
```

- [ ] **Step 2: Verify RED**

Run focused patch test. Expected: FAIL.

- [ ] **Step 3: Implement exact-label removal and opacity-only panel motion**

Capture clicks before inherited handlers, hide exact menu/nav controls, activate General if Updates was active, hide Updates pane, and use `[ { opacity: 0 }, { opacity: 1 } ]` keyframes for `panel`.

- [ ] **Step 4: Verify GREEN**

Run focused patch test. Expected: PASS.

### Task 5: Refresh artifact identity and verify desktop

**Files:**
- Modify: `client/client-artifacts.manifest.json`
- Modify: `patches/client-artifacts.json`

- [ ] **Step 1: Compute SHA-256 values**

Run a Node script using `createHash("sha256")` for main, preload, and injected renderer. Update both renderer hash entries plus main/preload hashes and bump renderer patch version to `openbot-local-settings-v2`.

- [ ] **Step 2: Run focused checks**

Run:

```powershell
npm run typecheck
npm run build
vitest run test/config-store.test.ts test/roster-agents.test.ts test/electron-windows-patches.test.ts test/electron-client-artifacts.test.ts --maxWorkers=1 --no-file-parallelism
npm run verify:client-artifacts
```

Expected: all commands exit 0.

- [ ] **Step 3: Run desktop checks**

Run `npm run smoke:shortcut`, then visual/CDP gate that opens Settings and verifies every panel rect stays inside window from first observed frame and unsupported labels are absent.

Expected: healthy gateway, visible centered window, no Help Center/Send Feedback/Updates, profile save survives renderer restart.

- [ ] **Step 4: Run full suite**

Run: `npm test -- --maxWorkers=1 --no-file-parallelism`

Expected: exit 0.
