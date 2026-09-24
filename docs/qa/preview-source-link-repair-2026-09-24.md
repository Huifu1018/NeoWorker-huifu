# Preview, source-link and feed recovery validation — 2026-09-24

## Reproduced and repaired

- A completed task containing `report.pdf` and `report-v2.pdf` made the preview replacement selector alternate between them indefinitely. The same fixture reproduced the error for XLSX. Both regression tests failed before the fix. The selector now chooses one stable candidate, including the current preview when it is already the winner.
- Opening an existing file card no longer treats the last historical user message as a new preview follow-up. Automatic replacement is limited to an explicit follow-up initiated from the preview.
- GFM implicit URLs included full-width punctuation and following Chinese source commentary. Rendered anchor tests cover the reported arXiv and Hugging Face examples, explicit Unicode links, query strings, fragments and code spans.
- Feed failures no longer share successful-source freshness. Access denial and rate limiting are distinct; source cooldowns survive restart and topic changes, and server retry deadlines are preserved.

## Validation

- 59 tests passed across eight targeted suites, including React state/effect render-cycle tests for PDF and XLSX revision selection, source-link HTML, feed recovery, trusted IPC, navigation and existing Markdown behavior.
- Browser interaction QA with the real preview components displayed the reported PackLab PDF and a spreadsheet fixture, switched between PDF and XLSX and their v2 revisions, and remained free of renderer error logs. This used an isolated test bridge, not the installed application profile. Both adjacent source links had clean destinations.
- Targeted lint: no warnings or errors.
- Full application build passed (renderer, Electron, daemon, CLI and platform helpers).
- Renderer type-check comparison with `b46ccaf`: 169 pre-existing diagnostic identities, no new diagnostics.

## Limits

- The revision fixtures reproduce the selection/state-loop defect; they do not validate the contents of every user-generated PDF or spreadsheet.
- No full model-driven translation or research task was repeated in this run.
- The local macOS test package is separate from published v0.2.3 release assets. No release tag is moved or created.
