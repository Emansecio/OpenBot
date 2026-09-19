# OpenBot provenance ledger

The executable catalog is `provenance/openbot-components.json`. Run
`npm run verify:provenance` before work that depends on extracted or observed
components. The gate is fail-closed: an invalid entry makes the command exit
non-zero and it never repairs the catalog.

## Autoria registrada

O bloco `authorship` do catálogo registra a autoria da implementação local
deste ciclo: as mudanças P0.1--P0.4 de 2026-08-24 foram implementadas por
agentes OpenAI Codex sob direção do proprietário do repositório. A identidade
do proprietário não está registrada neste checkout (`ownerIdentityRecorded:
false`); nenhum nome humano é inferido.

Isso não atribui autoria histórica dos componentes que já existiam. Para o
código OpenBot pré-existente e para os artefatos Grok Bot extraídos, o estado é
explicitamente `unknown`, e ambos ficam fora do registro de implementação
local. O verificador valida todas essas afirmações estruturais no catálogo.

The gate validates only the local inventory and its metadata: schema, required
fields, classification/reuse mapping, local path containment and existence,
and remote-reference syntax. It does **not** prove that a clean-room process was
followed, that a license or redistribution authorization exists, or that a
remote repository or commit exists. The verifier deliberately performs no
network lookup.

## Classifications

- `own-code`: locally authored OpenBot source or media declared as owned by the project; requires `reuse: "copy"`.
- `licensed-dependency`: a dependency inventory whose individual packages remain subject to their own licenses; requires `reuse: "per-license"`.
- `extracted-artifact`: a locally retained extracted binary or bundled artifact; requires `reuse: "no-copy"`.
- `observational-reference`: a fixed external snapshot used only to observe behavior or contracts; requires `reuse: "no-copy"`.
- `non-reusable`: material retained only as evidence and not authorized for reuse; requires `reuse: "no-copy"`.

Every entry has an ID, origin, reuse rule, and exactly one verifiable reference:
a local path contained by the OpenBot root, or an HTTPS repository plus an
immutable hexadecimal commit SHA. Branches, tags, HTTP URLs and ambiguous
local/remote references are rejected.

## Clean-room boundary

Extracted artifacts, observational references and non-reusable material are
no-copy boundaries. They must not contribute copied code, prompts, patches,
assets, endpoints or binaries to a new OpenBot implementation. `no-copy` and
no-redistribution are policy and intent for reuse and future distribution, not
a claim that the current package already satisfies a clean-room boundary.
Behavior and public contracts may be observed, then independently reimplemented
from OpenBot requirements. The Grok Bot 0.18 snapshot in the catalog is evidence
only; it grants no reuse or redistribution permission.

The extracted 0.16 client remains an explicitly recorded, non-reusable
artifact boundary. The two OpenBot overlays and the declared welcome media are
listed separately so their local classification is not confused with the
surrounding extracted bundle.

The current release pipeline is not a clean-room package: `scripts/release.mjs`
copies `client/extracted/dist` into the release staging tree, so the resulting
package still contains extracted artifacts. It must not be treated as
redistributable without the necessary authorization or replacement of those
artifacts with a clean-room implementation.

**A hash proves the integrity of the observed file; it does not prove
authorship, license, or authenticity.** A dependency manifest likewise records
inventory, not a blanket license for every package or for the assembled product.

## Local queue and task polish — 2026-09-16

The queue recovery IPC additions live in the declared main/preload artifacts;
queue feedback, explicit draft review and incremental transcript decoration live
in `openbot-local-settings.js`. Task list ordering and status presentation live
in `openbot-memory-ui.js`. Their current hashes and local patch records are in
the client manifest and `patches/client-artifacts.json`. Only the two permitted
overlay hashes change in the renderer boundary; immutable renderer files and
their aggregate baseline remain unchanged. These local changes do not grant
redistribution rights to the surrounding extracted artifacts.

## Execution status and backend-driven recovery — 2026-09-18

The real execution status (`promptStatus.execution`/`lastTurn`) and the
structured recovery contract (`getPromptRecovery`) are local OpenBot additions.
The gateway method lives in `src/rpc/send.ts`; the IPC channel
`sand:prompt-recovery` is declared in the main/preload artifacts, and the
overlay feedback (status strip, recovery actions) lives in
`openbot-local-settings.js`. Their current hashes and local patch records are in
the client manifest and `patches/client-artifacts.json`. Only the
`openbot-local-settings.js` overlay hash changes in the renderer boundary;
immutable renderer files and their aggregate baseline remain unchanged. The
overlay no longer infers recovery actions from displayed error text. These local
changes do not grant redistribution rights to the surrounding extracted
artifacts.
