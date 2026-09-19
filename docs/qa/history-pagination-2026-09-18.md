# Conversation History Pagination

## Scope

- Remove the persistent load-earlier button; retain timeline pagination.
- Request one page on upward wheel, touch, keyboard, or scrollbar reading near the start of the feed.
- Opening a session, restoring scroll, toggling execution records, and page completion do not drain history automatically.
- Preserve the visible DOM anchor on prepend; stop bottom-follow when reading history.
- Show a brief loading status without changing layout. Show retry only after failure, without exposing raw backend errors.
- Reset pending UI/anchors across task switches and ignore stale callback completion.
- Retain existing execution-detail expansion and filtering. No new separate backend history store or translation changes.

## Verification

- 141 tests passed in main-content-working-state and main-content-session-rendering.
- Browser: 30 history checks at 1365px and 480px, including prepend anchoring, request deduplication, keyboard/touch, retry/rejection, hidden-only pages, end of history, switching while loading, and synchronous no-op callbacks.
- Browser: 8 session-scroll checks and 16 execution-record checks passed at 1365px and 760px.
- Prepend position difference in the fixture: 0.094px.
- History screenshots: `/var/folders/f6/v2yvmyfx77xdvgw7gfyj1xdr0000gn/T/neoworker-artifact-turn-qa-mp0chH`.
- Combined scroll/execution screenshots: `/var/folders/f6/v2yvmyfx77xdvgw7gfyj1xdr0000gn/T/neoworker-artifact-turn-qa-zctNpR`.
- Frontend production build passed. Full repository type-check does not pass (unrelated declarations and optional-value errors remain); no diagnostics were reported for the new pagination hook.
- No installer packaged; no native Windows smoke test. Browser fixtures do not write user task data.

## Environment

Disk exhaustion interrupted one regression attempt. Removed only two duplicate disposable PPT preview QA output directories, retaining the final preview evidence and all user documents, databases, and installers. Regression then passed. Disk remains critically low.
