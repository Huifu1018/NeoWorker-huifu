# Translation batching performance

## Change

- Replace fixed 40-unit batches with adaptive batches: at most 160 units, 6,000 source/context characters and 18,000 serialized unit characters. A single oversized unit stays intact.
- Prefer keyed `translations: [{key, text}]` with stable short keys and a source/language/progress/content-bound `batchId`, avoiding repeated native XML IDs in model output. Return order does not matter. Explicit `units` remain supported for corrections and old checkpoints. Plain string arrays are rejected.
- Prefer keeping adjacent units sharing native-part/context boundaries together. Oversized groups can split within the limits while retaining context; this is a context-boundary heuristic, not a full paragraph parser.
- Validate the whole batch before writing. Serialize checkpoint operations per canonical workspace within the host process so overlapping requests cannot overwrite progress.
- Keep original-package fidelity checks, complete-before-delivery validation and atomic checkpoint writes.
- Report advisory hints for changed numbers, unchanged long sentences and extreme length changes. These are not semantic validation or automatic delivery blockers. Legitimate localization can trigger hints; unchanged warnings must not cause retry loops.

## Verification

Offline replay used the previously completed Korean translation of the 39-slide PPT. No model requests were made, and the original document and checkpoint remained unchanged. A temporary workspace was removed after verification.

| Measurement | Result |
| --- | --- |
| Native text units / unique units | 2,661 / 2,287 |
| Previous effective batches | 58 |
| Adaptive keyed batches | 18 |
| Split context groups | 0 |
| Explicit-ID payload characters for the same adaptive batches | 132,194 |
| Compact keyed payload characters | 87,498 (34% reduction) |
| Local replay, apply and verification | 9.59 seconds |
| Translation equality with saved result | All 2,661 units matched, with every reply array deliberately reversed |
| Native package fidelity | Passed |
| Advisory review | 3 units flagged for review, not confirmed translation errors |
| Regression suite | 185 tests passed across 12 files |
| Electron TypeScript build | Passed |

The keyed design supersedes the earlier ordered-string experiment (17 batches, 71% payload reduction). It intentionally spends more output characters to make reply mapping independent of order and preserve context boundaries.

The local replay time excludes model generation and network latency and ran alongside the regression suite. It is not a comparable CPU benchmark, an end-to-end translation benchmark, or a promise of a 4-5 minute completion time. Full model-driven latency and translation quality still need validation with a newly packaged app. These follow-up changes have not been included in a new installer yet.

Regression coverage includes PPTX/DOCX/XLSX completion with reversed replies, stable keys on resume, context boundaries, oversized groups, partial legacy batches, restart/resume, stale replies, unknown/duplicate/missing keys, wrong counts, invalid text, conflicting input formats, overlapping tool instances, true duplicate protection, advisory review and correction, and preservation of the source.
