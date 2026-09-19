# Cross-platform reliability verification - 2026-09-16

## Scope

Validated the current working tree, including existing uncommitted fixes. Baseline:
`340460ab7516581875cb3ab31ed724fabacc4561`. Tests ran on macOS, not a Windows host.
No installer was produced or installed, no application database was modified,
and no source document was overwritten. This report is not a release sign-off.

## Changes and evidence

| Area | Correction | Verification |
| --- | --- | --- |
| Temporary artifacts | Canonicalize existing paths/ancestors for Windows short paths and macOS aliases; retain containment and symlink checks | Workspace alias, escape rejection, persistence and restore tests |
| Office translation | Group adjacent equally formatted runs; retain native objects, styles, media, formulas and relationships | DOCX, PPTX and XLSX structural tests; legacy manifest compatibility |
| Translation recovery | Persist batches, reject incomplete/corrupt checkpoints, resume pending units, deduplicate identical text with identical context | Fresh tool instance resumes saved work; partial apply rejected; language checkpoints separated |
| Publication retry | Preserve ZIP entry metadata and reuse unchanged generated output after registration failure | Byte-identical results across simulated dates; retry creates no second document |
| Completion | Exclude internal files; language fallback cannot assert success; translation requires verified output even without an attachment descriptor | JSON-only and missing-output regression tests |
| Windows commands | Expose actual host/container environment before execution; suppress immediate missing-executable retries; log command durations | Docker versus direct Windows runner tests; retry after repair; sandbox policy retained |
| Docker caches | Writable HOME/npm/pip caches under tmpfs | Read-only root, dropped capabilities and network isolation still asserted |
| Long tasks | Separate a five-minute idle budget from a thirty-minute maximum prompt deadline | Progress keeps the request alive; hard deadline and cancellation remain enforced |
| Vision | One bounded same-provider retry for empty output caused by token-budget exhaustion | Successful recovery and no infinite retry; no exposure of hidden reasoning |
| PPT preview | Read presentation relationships for slide order instead of using ZIP filenames as page numbers | Reordered/gapped/orphan parts; real five-page template deck renders five distinct pages |
| Conversation UI | Existing fixes for cards, timers, session scrolling, internal execution text, heading size and right-click actions | Browser/Electron checks below |
| Document UI | Existing image layering, isolated PDF error handling, DOCX paged preview and bundled PPT renderer | Browser/Electron checks below |

Windows CI now includes environment, native Office translation, durable artifact,
PPT preview and extraction regressions in its execution-chain job. The workflow
has not been dispatched remotely as part of this run.

## Verification results

- Final targeted run: 1,000 passed, zero failed, four Windows-only tests skipped.
- Additional final shell and delivery runs: four and 222 passed respectively,
  including two additional regressions. These overlap the targeted run and must
  not be added together as independent test counts.
- Translation tests: 36 passed, including cross-date retry and staged recovery.
- Electron TypeScript build: passed. Renderer production build: passed.
- Artifact cards: 32 browser scenarios passed, covering PPTX/PDF/XLSX/DOCX,
  late artifact events, subsequent turns, and two viewport widths.
- Execution-record display: 16 scenarios passed; internal attachment extracts
  remain hidden with records enabled and disabled; earlier history remains loadable.
- Timers: 20 checks passed, including immediate follow-up start, initialization,
  minute boundaries, and completed prior turns.
- Session scroll: eight checks passed, including new questions and restored
  reading positions, without sweeping through the conversation history.
- Image preview: pixel checks passed at 100%, 175% and 300%, desktop and narrow.
  PDF error-isolation checks passed in the same browser harness.
- DOCX: paged cover, page break, headers, footers and table verified at two widths.
- Right-click: native copy/cut/paste/undo/redo, rich input and custom-menu checks passed.
- PPT template: five requested slides, four requested images and seven unchanged
  template parts verified. Missing-image input fails without publishing output.
- PPT renderer: five distinct nonblank slide images, cache hit and source hash
  preservation passed after fixing the discovered page-index mismatch.
- `git diff --check`: passed.

## Baseline failures and limits

- Full renderer/shared type-check is NOT green: 313 errors both in an isolated
  baseline checkout and in the current tree. Comparing error messages without
  line numbers found no new errors. These existing errors remain unresolved.
- Broad UI test run: 1,482 passed and 29 failed. The same 28 functional/snapshot
  failures reproduce on the baseline; the remaining timing-budget test passed
  on rerun. Broad UI tests are NOT being presented as an all-green suite.
- Windows real-process/installed-app behavior, actual 8.3 paths, antivirus,
  font availability and end-to-end model latency still need a Windows run.
  No measured claim of reducing a 6.5-minute task to 2.5 minutes is made.
- Native Office structure preservation is not proof of translation accuracy,
  translated text fitting every shape, or translating pixels inside images.
- Faithful PDF translation remains unsupported. The app must disclose that
  limitation rather than silently rebuild a report or move images to an appendix.
- DOCX and PPT compatibility previews can differ from Microsoft Office for
  unsupported layout/font features. Source files remain available unchanged.

Raw local test reports are in `/tmp/neoworker-targeted-final.json`,
`/tmp/neoworker-delivery-final.json`, `/tmp/neoworker-translation-final.json`,
`/tmp/neoworker-followup-tests.json`, `/tmp/neoworker-ui-tests.json`, and
`/tmp/neoworker-baseline-ui-tests.json`. These are temporary local evidence,
not files intended for distribution to customers.
