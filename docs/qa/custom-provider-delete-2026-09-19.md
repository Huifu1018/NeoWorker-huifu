# Custom provider list deletion

Date: 2026-09-19

## Changes

- Add a visible small X on the right of each user-added provider in the model dialog.
- Keep selection and deletion as separate keyboard-accessible buttons.
- Remove unsaved drafts immediately without writing settings. Confirm removal of saved providers and their model settings.
- Preserve the selected provider when deleting another row; choose another platform when deleting the selected row.
- Preserve other custom-provider drafts and credentials. Failed saves keep the deleted target available for retry.
- Ignore model-list responses that arrive after their custom provider was removed.

## Verification

- `node scripts/qa/custom-providers.mjs`: passed against the real Settings component and backend settings validation with in-memory storage.
- Covered duplicate unnamed drafts, selected/unselected deletion, keyboard deletion, confirmation cancellation, injected save failure and retry, preservation of another provider's unsaved edits, current-provider fallback, delayed model responses, and reload persistence.
- Checked screenshots at widths 1440 and 760 plus dark theme. Delete buttons stay within their rows.
- Renderer production build passed with the existing chunk-size warning.
- `git diff --check`: passed.
- macOS ARM64 DMG rebuilt in `release/macos-2026-09-19`; package signature, mount/checksum, embedded runtimes, and application launch passed.
- Compared all 2,424 packaged build files to current `dist` output and verified 3,931 source files against the build snapshot.

Browser evidence: `/var/folders/f6/v2yvmyfx77xdvgw7gfyj1xdr0000gn/T/neoworker-custom-providers-qa-WhUgP6`.

## Scope

No real supplier requests or user credential changes were made. The legacy platform and built-in providers retain their existing management controls.
