# Source-based report quality regression

## Reproduction

Inspected the user-provided `源2.0-M32大模型发布会-内容分析报告.docx`
and its 14-slide source `源2.0-M32大模型发布会-V4.pptx`, read-only.

- The report's architecture image is the source's `image7.png`, a plus
  operator, not the composed architecture diagram. Slide 5 places it at
  185040 x 201600 EMU (about 0.20 x 0.22 inches before group transforms).
- Slide 9 has a complete native benchmark table. Before this change,
  NeoWorker extraction returned only `[Graphic - 表格 110]`: both the inner
  table and its outer graphicFrame were replaced using overlapping offsets.
  The outer replacement erased the extracted rows and could erase following
  content because the inner replacement had already changed string length.
- The report says 37 亿 in prose but 37B in its table; the source table says
  3.7B. Its 78.0 HumanEval score is a few-shot result from slide 10, not the
  74.4 benchmark result in slide 9. The report also substitutes a relative
  compute ratio for the absolute GFLOPS value.
- Five images have the same generic caption. 12 of the report table's 36
  body cells are blank/placeholders despite relevant values in the source.

## Changes

- Keep table extraction when a graphicFrame contains a native table. Preserve
  subsequent text; no model call or renderer is needed for this fix.
- Describe extracted pictures as media assets, including shape-local size,
  without asserting they are complete diagrams. Group transforms are explicitly
  excluded from that size; no small-image rejection heuristic is applied.
- Add bounded, local DOCX content review for repeated unnumbered figure
  captions, sparse tables and ratios placed in absolute compute columns.
  These are advisory source-review findings, separate from structural and
  rendering checks. They still run when OfficeCLI is unavailable.
- Preserve content findings in the published-artifact reminder. Rendering
  is not represented as factual or semantic verification. No unchanged
  automatic rebuild is introduced.
- Add report guidance covering source-page provenance, native diagram
  composition, units, benchmark conditions, figure relevance and visual QA,
  including reports authored through shell scripts.

## Verification

- Four focused suites: 29 tests passed. Three additional preview, tool-catalog
  and skill-routing suites: 125 tests passed (154 total).
- `npm run build:electron`: passed.
- `git diff --check`: passed.
- Real-source extraction now returns all six benchmark rows, including
  `3.7B`, `7.4`, `55.9`, `92.5`, `74.4`, `72.2`, `95.8`, `79.10`, `10.69`.
- Real-DOCX review returned all three finding types in approximately 20 ms
  on this Mac. This is a local check measurement, not a generation benchmark.

## Follow-up: delivery checkpoint and source-image review

- The default Hermes completion path now locally inspects newly created or
  modified DOCX deliverables, including outputs written through shell scripts.
  Initial, follow-up and resumed turns share the checkpoint.
- Findings trigger at most one targeted model correction request (without an
  automatic quality-repair retry/continuation loop), with a 90-second abort
  deadline. Clean reports cause no additional model request. Actual files are rechecked
  afterwards. Unresolved findings or unavailable checks appear in the final
  response; repair failure does not discard the completed file.
- Source-preserving translation tasks are excluded from report-style repair.
  Uploads, staging directories, old artifacts, traversal paths and symlink
  escapes are excluded. Checks honor cancellation and have file/part/count
  limits; source-image decompression is capped at 24 MiB per reviewed output.
- Byte-identical media and PPT group transforms are used to detect small source
  components enlarged into large DOCX figures. This is a review hint, not an
  automatic image deletion policy. Unknown transforms and assets also used at
  large size are not labelled as tiny components.
- Read-only replay on the provided report identifies `image7.png`, used at
  0.21 inches in source slide parts 5/6, enlarged to 4.33 inches in Word. It
  returns the other three content findings as well. Local scan: about 237 ms
  on this Mac; no model/network call is used for detection.
- Final regression run: nine suites, 256 tests passed, including correction
  timeout, cancellation, missing outputs, old-file exclusion and source-image
  group transforms. Electron compilation and diff whitespace checks passed.

## Limits

The existing report was not rewritten, and no fresh model-driven report or
installer was produced. Heuristics do not establish factual correctness or
image relevance; a report with no findings is explicitly unverified, not
content-approved. The new completion checkpoint covers the default Hermes
runtime, not every alternative external runtime. It is not an enforced full
semantic review, nor does it replace rendered-page inspection. There was no Windows live
test and no full document rendering: no bundled document runtime was available.
