# Translation recovery and preview regression

## Reproduced failures

- The actual 39-slide NV deck Arabic translation completed in 939.84 seconds with 13 tool errors.
- A replacement character in `ppt/slides/slide21.xml` caused the strict HTML quality check to abort the entire image preview.
- The original source did not contain this character. Ordinary preview and delivery quality checks shared the same rejection behavior.

## Changes

- Resumable translation returns an opaque `translationId`. The host resolves its source and checkpoint, enforcing workspace containment, source hash and the current request's original-attachment restriction.
- Legacy stage calls missing their checkpoint path can recover only via an exact source/batch match. No language or path guessing.
- Keyed batches retain valid translations and return structured issues plus only the unresolved source units/context. Legacy ID-based batches also retain valid text when other known units have invalid text. Unknown/duplicate native IDs still fail atomically.
- Repair priority and no-progress counts survive tool-instance restarts. After three no-progress replies the tool reports `needsAttention`, `retryable=false`, and withholds further automatic batch work. This is a tool-level stop signal, not a guarantee about arbitrary provider behavior.
- Text validation rejects replacement characters, isolated surrogates and invalid controls without rejecting legitimate multilingual letters, combining marks or bidi controls.
- Inspection, stage and final apply reopen invalid completed translations from old checkpoints; valid saved work is retained. Direct manifest application also rejects invalid Unicode.
- Ordinary PPT image preview explicitly uses warning mode. Strict document/visual quality checks remain the default. Warning page numbers survive preview cache reloads and are displayed in the UI, including fullscreen.
- Preview capture retries a repeated preceding compositor frame after a scroll. Existing files are not rewritten.

## Verification

- 354 related unit/integration tests in 12 suites: translation recovery, source fidelity, dedupe, original-attachment guarding, completion checks, strict artifact quality, preview service and viewer rendering.
- Electron TypeScript build and renderer production build.
- Actual Arabic PPT rendered through bundled OfficeCLI/Chromium: 39 pages, 39 distinct image captures in the final run; fast cache reload passed; warning on slide 21; source hash unchanged.
- Real Electron HTML fixtures: strict mode still rejects malformed text; warning mode renders both pages and identifies only page 2. Static and dynamically activated slides retain their page-count checks.
- Playwright viewer checks at 1440x1000 and 480x1000: actual slide image loaded, warning page number visible, no text fallback or browser exceptions.
- Offline replay using the real 2661-unit source and saved Arabic responses completed in 20 stage calls, including two repair calls (one injected missing entry and the existing malformed entry). Every stage recreated the tool instance. Source attachment and original saved checkpoint remained byte-identical. The test artifact uses a deliberate QA substitute for the corrupted text and is NOT a user deliverable.

## Limits

- The offline replay is not live model latency measurement or semantic translation evaluation. No claim of a 4-5 minute end-to-end translation is justified yet.
- Native Windows execution was not available; these are shared-code fixes tested on macOS.
- Existing Arabic text fit/RTL layout and source image text are not repaired by the preview availability fix. Compatibility rendering is not identical to PowerPoint.
- This change is not yet included in a newly built installer. The running installed app and user documents were not replaced.
