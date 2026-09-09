# OpenBot Local User Profile Design

## Objective

Replace the inherited account/logout surface with a truthful local profile that lets the user choose the name shown by OpenBot.

## Behavior

- The General settings account card becomes **Perfil local**.
- The card contains generated initials, a **Seu nome** field, a short explanation and a compact neutral **Salvar** action with a check icon.
- The name is stored in the current Electron profile under `openbot.profile.name.v1` and is reused after restart.
- The saved name replaces the inherited `OpenBot Local` label in the sidebar/footer.
- Empty names are rejected; values are trimmed, whitespace is normalized and length is limited to 80 characters.

## Legacy cleanup

- `Sign out`, `Log out` and `Sair` controls are hidden in local mode.
- An already-open inherited sign-out dialog is cancelled and hidden.
- The fake `local@openbot.invalid` identity and the Cursor-account message are never shown in the replacement surface.
- Provider authentication remains separate; changing the local display name does not touch API keys, providers or bot identities.

## Accessibility and UI

- Native settings layout and tokens are preserved.
- The field has an explicit label and status region.
- Save is a real form submission, so Enter works.
- Save stays disabled until the value changes and briefly confirms **Salvo** after persistence.
- Focus rings, 40 px minimum targets, responsive stacking and reduced motion are supported.

## Storage boundary

The value is non-sensitive UI preference data. Renderer `localStorage` is appropriate because it is already isolated by the Electron user-data profile and requires no new privileged IPC surface.
