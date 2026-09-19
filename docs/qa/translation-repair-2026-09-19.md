# PPT translation repair failures

## Reproduction

The reported 14-slide Korean translation reached 456/456 saved text units before its first `apply`. The new layout gate reopened 18 units, but the model received only `Tool execution failed`. It repeatedly shortened paragraphs and retried until the task failed with no PPTX. Saved progress and source bytes were intact.

Two defects combined:

1. The HTML measurement used a whole-text-node DOM Range. Chromium returns hanging line-end space rectangles beyond the right edge of justified paragraphs. The gate treated those invisible spaces as overflowing glyphs, even when all visible text fit at the original font size. Repeated shortening did not reliably remove the false positive.
2. The executor did not recognize `result.message` as a failure reason. Its added generic error then caused the MCP result envelope to discard the structured failure result, including `nextUnits`, `previousTranslation`, `batchId`, `textFit.issues`, and `retryable=false`.

## Changes

- Measure ranges of visible non-whitespace text without changing the document or its layout. Continue checking complete paragraph heights, margins, blank lines, actual frame boundaries, table growth, and minimum font/scale limits.
- Preserve structured failure results when the host supplies an error label; retain JSON bounds and existing error precedence.
- Use actionable result messages in the executor and persist result/envelope details on failed tool events.
- Preserve explicit retryability through the coordinator. When automatic layout repair is exhausted or unavailable, return a clear stop message with the specific issue records.
- Keep native source-fidelity and output-publication gates enabled.

## Verification

- 163 tests passed across nine focused suites, including executor → Hermes fixture → real HTTP MCP failure projection, retryable/non-retryable repair payloads, checkpoint behavior, source-fidelity gating, and stop diagnostics.
- Six real OfficeCLI/Chromium fixture cases passed: fitting and overflowing shapes/tables, plus justified Korean text that must remain at its original size and genuinely overflowing justified Korean that must fail.
- `scripts/qa/translation-repair-replay.cjs` replays saved translations through the actual TaskExecutor host bridge, HTTP MCP server, coordinator and native document tool. It copies inputs into a private QA workspace and uses no live model API or user database writes.
- Recovered the first complete set of 456 translations from the user's persisted stage calls, before the faulty gate caused repeated shortening. With the corrected measurement, 17 of the original 18 flagged units fit. One real overflow on slide 9 was rewritten concisely while retaining local AI compute/inference, rapid self-hosting, Red Hat independence and immediate usability.
- The real document replay exercised `inspect` → all `stage` batches → failed `apply` with one actionable repair → `stage` → successful `apply`. No invalid artifact was registered; exactly one final artifact was registered. Native source fidelity passed and the source SHA-256 remained `e0072d3a5d03a06455c709ea144bb7493efefd5780e0b1548279169151f97e7f`.
- All 256 translated slide text frames passed. After writing the final PPTX, a second independent render/measurement required no additional shrinking. Rendered all 14 pages, reviewed the contact sheet and enlarged slides 9, 11 and 14. Source shapes, pictures, master content and geometry remain preserved.
- Full renderer, Electron, daemon and CLI build passed. The existing real bundled-Hermes local-model replay also passed warm task switching, partial checkpoint continuation and restart recovery.

This validates the failure transport, recovery workflow and OfficeCLI/Chromium rendering for this real document. It does not certify a live model's translation choices or native Microsoft PowerPoint rendering. Existing image text is preserved rather than translated. The recovered output retains the initially saved wording except the one required fit repair; it is not a new linguistic review.

## Deliverables

Test package: `release/macos-2026-09-19-translation-repair/NeoWorker-0.1.8-8-arm64.dmg`.

Recovered PPTX: `release/macos-2026-09-19-translation-repair/海外季度营销计划材料-MotusAI-韩语-恢复版.pptx`.

The release directory contains source/build hashes, tests, runtime replay reports, final text-fit measurements, visual evidence, packaged-secret verification and installer smoke evidence. Version remains 0.1.8-8; the dated folder distinguishes this package from previous builds. The installer is an ad-hoc signed Apple Silicon test build. The original task/database/checkpoint are not modified by this repair session.
