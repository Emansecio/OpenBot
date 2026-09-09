# Local Bot Groups Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Local OpenBot groups that appear like bots in the sidebar, whose members are whatever pre-existing roster bots the caller selected, and that share one transcript with one speaker at a time.

**Architecture:** A group is a `LocalAgent` with `isGroup: true` and `memberIds`. `createGroup` never creates members. `sendPrompt` on a group id writes the group transcript and runs inference as a member actor. Visual create flow is compose-to (spec §11: Para / chips), not a named checkbox modal. Overlay clones A–C only: click a bot in state A opens 1:1 (do not copy 0.36’s 1-member group). Chip cap 6. Composer `+` is attach. No `createAgent` for typed names inside group compose. No Cursor protobuf rooms.

**Tech Stack:** TypeScript, SQLite (`better-sqlite3`), Vitest, existing OpenBot overlay.

**Spec:** `docs/superpowers/specs/2026-09-03-local-bot-groups-design.md` — consult the relevant sections when starting work and revisit them only after changes or new uncertainty. If the spec and this plan disagree, the spec wins.

## Global Constraints

- Members are existing non-group roster agents at call time. Never spawn clones or temporal subagents.
- Do not infer as the group id. Do not write group turns into a member's private conversation.
- Do not patch extracted 0.16 renderer/main/preload chunks. Overlay + host only.
- Do not implement sidebar folders (`nlt` / `isCollapsed` / `agentIds` folders).
- Do not add protobuf, `broadcastToAgents`, templates, or extra test frameworks.
- New tests: one main path and one critical failure per new behavior. Do not expand coverage of unrelated modules.
- Do not git commit unless the user asks.

---

### Task 1: Persist group fields on the roster

**Files:**
- Modify: `src/config/store.ts` (`LocalAgent`, `validateAgent` / `validateAgents`)
- Modify: `src/rpc/roster.ts` (`summarize`)
- Test: `test/roster-agents.test.ts` (keep existing `isGroup: false` for normal bots)

**Interfaces:**
- `LocalAgent.isGroup?: boolean`
- `LocalAgent.memberIds?: string[]`
- `LocalAgent.ownerAgentId?: string`
- `summarize` returns real `isGroup` and `memberIds` (still `conversationPartnerIds: []`)

- [ ] **Step 1:** Add the three optional fields on `LocalAgent`.
- [ ] **Step 2:** In `validateAgents`, after individual `validateAgent`: if `isGroup` then `memberIds` must be unique, must not include self, each id must exist and must not be a group. If not a group, `memberIds` must be absent or empty.
- [ ] **Step 3:** `summarize` uses `Boolean(agent.isGroup)` and `agent.memberIds ?? []`.
- [ ] **Step 4:** Run `npx vitest run test/roster-agents.test.ts`. Existing non-group agents still have `isGroup === false` and empty `memberIds`.

---

### Task 2: RPC `createGroup` and `setGroupMembers`

**Files:**
- Modify: `src/server/gateway.ts` (`RPC_METHOD_TABLE` — add `createGroup`, `setGroupMembers`)
- Modify: `src/rpc/roster.ts` (handlers next to `createAgent`; reuse home/conversation rollback)
- Test: `test/roster-agents.test.ts` or new `test/roster-groups.test.ts` if the file would otherwise grow a second unrelated suite — prefer `test/roster-groups.test.ts`

**Interfaces:**
- `createGroup({ name?, description?, memberAgentIds, origin? })` → `{ agent }`
- `setGroupMembers({ id, memberAgentIds, requesterAgentId? })` → `{ agent }` or 4xx
- Constants: min members 2, max 6 at these RPCs (native chat bar `PS=6`, not A2A 8)
- Empty/omitted `name` → derived `_vt`: profile name first, then bot names, narrow list format, max 72 chars (spec §7)

- [ ] **Step 1:** Write a focused test: create two bots, `createGroup` with those ids and **no name**, assert `listAgents` has three rows, exactly one `isGroup: true`, `memberIds` equal to the two ids, no fourth agent, and `name` starts with the profile name then the two bot names.
- [ ] **Step 2:** Write the critical failure test: `createGroup` with a missing id returns 400 and roster length unchanged.
- [ ] **Step 3:** Implement `createGroup`: validate members, `sanitizeAgentId` new id, `homes.ensure`, config mutate with `isGroup: true`, `conversationStore.ensureDefault`, publish `agent-upserted` + roster. Do **not** call `createAgent` for members. Skip kickstart. Copy `origin` rules from `createAgent` (agent origin does not steal the open chat).
- [ ] **Step 4:** Implement `setGroupMembers` as a full replace (spec §7). User RPC always allowed; bot requester must be member or owner. Still 2..6 members.
- [ ] **Step 5:** Run the new tests plus `npx vitest run test/roster-agents.test.ts`. Require PASS.

---

### Task 3: Deletion strips membership

**Files:**
- Modify: `src/rpc/roster.ts` (`deleteAgents` commit path)
- Test: `test/roster-groups.test.ts`

**Interfaces:**
- Consumes: group `memberIds` on remaining agents
- Produces: members removed from every group; empty groups deleted with their home/transcript

- [ ] **Step 1:** Test: group of A+B; delete A; B remains; group `memberIds` is `[B]` (or group deleted only if 0 members).
- [ ] **Step 2:** Test: delete the group id; A and B still in `listAgents`.
- [ ] **Step 3:** Implement strip/delete-empty in the same mutation that removes agents. Clear `group_turn_state` when the group row disappears (table may land in Task 4 — if the table does not exist yet, skip that line and do it in Task 4).
- [ ] **Step 4:** Run `npx vitest run test/roster-groups.test.ts`. Require PASS.

---

### Task 4: Group sendPrompt — actor split

**Files:**
- Create: `src/groups/contracts.ts` (parse `/pass @token`, mention match, min/max, hop cap 4)
- Create: `src/groups/scheduler.ts` (pick next member from `memberIds` + `last_speaker_agent_id`)
- Modify: `src/store/schema.ts` (table `group_turn_state`)
- Modify: `src/rpc/send.ts` (`sendPrompt` / `acceptPrompt` / `runTurn`: if target `isGroup`, transcript+nonce on group id, inference/tools/home/system prompt on actor id, assistant `fromAgent`)
- Modify: `src/rpc/identity.ts` or send path: append the group-room system block from spec §10.4
- Modify: `src/rpc/roster.ts`: `kickstartAgent` and `setAgentDefaultModel` reject groups with 400
- Test: `test/rpc-send.test.ts` or `test/group-turn.test.ts` — prefer `test/group-turn.test.ts`

**Interfaces:**
- `parsePassLine(text): { memberToken: string } | null` — last line must be exactly `/pass @token`
- `pickActor({ memberIds, lastSpeakerId, mentionToken }): string`
- Turn runner: `transcriptAgentId = group.id`, `actorAgentId = member.id`

- [ ] **Step 1:** Test main path with a fake provider: two bots + group; `sendPrompt` on the group; group transcript has user + assistant `fromAgent` of a member; member private entries stay empty (or unchanged).
- [ ] **Step 2:** Implement contracts + scheduler + `group_turn_state`.
- [ ] **Step 3:** Intercept `sendPrompt` when `config` says the agent is a group. Refuse to call `resolveProviderFn(groupId)` for inference. Pin inference with the actor's provider. Enqueue on the group queue; wait until the actor has no running turn.
- [ ] **Step 4:** After an actor reply, if `/pass` targets a living member and hops < 4, enqueue one follow-up group turn (origin agent, no new user echo).
- [ ] **Step 5:** Run `npx vitest run test/group-turn.test.ts test/rpc-send.test.ts`. Require PASS. Existing 1:1 send tests must still pass.

---

### Task 5: Tools `create_group` and `set_group_members`

**Files:**
- Create: `src/integrations/group-tools.ts` (mirror `agent-management-tools.ts` size and style)
- Modify: `src/integrations/agent-management-tools.ts` or `src/main.ts` to compose the extra tools/prompt
- Test: `test/roster-groups.test.ts` (invoke via the same pattern as `create_bot` in `test/roster-agents.test.ts`)

**Interfaces:**
- Tool `create_group` `{ name?, description?, members: string[] }` → calls `createGroup`
- Tool `set_group_members` `{ group_id, member_ids: string[] }` → calls `setGroupMembers` with `requesterAgentId`
- Name resolution: exact id, else unique case-insensitive name among current non-group agents

- [ ] **Step 1:** Test: bot tool creates a group from two existing names/ids; roster gains one group; `create_bot` is not called.
- [ ] **Step 2:** Implement tools + a short system-prompt sentence (spec §8). Never create members.
- [ ] **Step 3:** Run the focused group tests. Require PASS.

---

### Task 6: UI — compose-to / chips (not a “Novo grupo” form)

**Files:**
- Modify only if the packaged 0.16 renderer **lacks** `enter-group-mode` / `sand-new-chat-chip`: `client/extracted/dist/renderer/assets/openbot-local-settings.js` + overlay hash in `client/client-artifacts.manifest.json`
- Modify: `test/electron-windows-patches.test.ts` only if the overlay is used
- Do **not** modify `electron-main/main.cjs`, preload, or vendor renderer chunks
- Do **not** implement `sand-new-channel-dialog` (named channel modal)

**First check (do this before writing overlay):** search the running renderer for `enter-group-mode` or copy **Criar chat em grupo**. If present, Task 6 is: expose `createGroup` / `setGroupMembers` on the existing API table the native bar already calls; skip overlay screens. If absent, clone spec §11 states A–C in the overlay.

**Interfaces (overlay path only):**
- Compose field **Para: Buscar ou criar Bots**
- Dropdown: **+ Criar novo Bot**, **Criar chat em grupo**, then existing bots (name+avatar only; purpose tags stay on the sidebar)
- Clicking a bot in state A opens that bot’s 1:1. Do **not** `createGroup` with one id.
- After group mode: hover **Adicionar ao chat em grupo**; chips with X; cap **6**; no name field; no checkboxes; no `createAgent` for a typed unknown name
- `createGroup({ memberAgentIds, origin: "user" })` on first send with ≥2 chips. Do not pass a custom group name.
- Copy in pt-BR from spec §11.7 keys
- Composer **+** = attach

- [ ] **Step 1:** If overlay is needed, add tests in `electron-windows-patches.test.ts` for the compose strings (`Criar chat em grupo`, `Adicionar ao chat em grupo`), chips (not checkboxes), and `api.createGroup` **without** requiring `name`. Do not test `openCreateGroup` / “Novo grupo”.
- [ ] **Step 2:** Implement states A–C from spec §11. Reuse `--cursor-*`. After `createGroup`, open the group chat natively (`openAgent`). Do not clone the transcript. Sidebar row D/E: if `listAgents` already renders the group, do not duplicate the row; stacked avatars only if the native row cannot show `memberIds` (optional overlay mark, not a second list).
- [ ] **Step 3:** Adding a member later: same Para/chips or info **i** → `setGroupMembers` with the full list. Composer **+** is attachment; do not bind it to invite unless the native client already does.
- [ ] **Step 4:** If overlay files changed, update the overlay artifact hash/version. Run `npx vitest run test/electron-windows-patches.test.ts test/electron-client-artifacts.test.ts`. If overlay was skipped, run the artifact test only and record “native bar present”.

---

### Task 7: Cheap falsifiers before calling done

**Files:** none new

- [ ] Run `npx tsc --noEmit` (or `npm run build`) and the focused tests from tasks 1–6.
- [ ] Confirm `createGroup` does not appear to call `createAgent` for members (read the handler).
- [ ] Confirm vendor client artifact hashes for main/preload/renderer **native** files are unchanged.
- [ ] If desktop is available: two real bots → **Criar chat em grupo** → two chips → send one message → title is names (not a custom group name) → one member shows “está trabalhando” on that chat. If desktop is not available, say so; do not fake a screenshot.

---

## Execution notes for a weak model

- Read spec sections 4, 7, 10, 11 before coding.
- If you are about to create a bot inside `createGroup`, stop.
- If you are about to run `resolveProviderFn(groupId)` for the group’s own completion, stop.
- If you are about to edit a file under `client/extracted/dist/electron-main` or a vendor `chunk-*.js`, stop.
- If you are about to add a test file for memory, WSL, or MCP “while you are here”, stop.
- If you are about to draw a “Novo grupo” modal with name + checkboxes, stop. Use spec §11 (Para / chips).
- If you are about to `createGroup` with one member because 0.36’s picker does that, stop. Overlay: 1:1. RPC: 400.
- If you are about to cap members at 8, stop. Cap is 6.
