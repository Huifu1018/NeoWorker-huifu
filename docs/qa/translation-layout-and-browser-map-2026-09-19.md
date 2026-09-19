# PPT translation layout and external browser maps — 2026-09-19

The German translation screenshots exposed two defects: proofing/language runs were translated independently (even punctuation), and translated text kept fixed font sizes or expanding text boxes without a fit check. External HTML opening also used `shell.openPath`, producing a `file:` page with no HTTP origin for remote map requests.

## Changes

- Translation v3 groups uninterrupted paragraphs across proofing and formatting runs. Actual style boundaries use ordered formatting anchors; missing, duplicated, reordered or invented anchors are rejected before writing text. Every original run and its formatting remains in the package.
- New v3 checkpoints reuse complete compatible legacy passages. Independently translated fragments are not concatenated into new paragraphs. Legacy files remain untouched, and explicit legacy handles remain readable.
- PPT apply renders changed slide text with bundled OfficeCLI/Chromium. Native `normAutofit` scales shape text no lower than 65% and 8 pt; original geometry, font declarations, pictures and relationships are verified unchanged. Table cells are checked at their existing font sizes. Content that still does not fit returns the affected source units and previous translations for concise rewriting; no delivery artifact is registered. Failed rewrite cycles are bounded.
- Normal font ascent/descent inside the frame padding is permitted; complete line boxes must fit the padded area. This avoids false overflow for Calibri fallback in table cells.
- External HTML opens on a loopback HTTP origin with a token bootstrap and HttpOnly cookie. Relative and root-relative modules/assets work; resource requests carry the actual origin, never a forged Referer or a local filename. Servers reject cross-origin/Host misuse, traversal, hidden files, symlink escapes and writes. They close on idle timeout or app exit.
- The reported Tokyo HTML was updated to the canonical OSM tile URL with linked attribution. Its pre-edit backup is in the local QA folder.

## Verification

- 273 related tests passed across 14 files. The final anchor-validation follow-up passed all 61 affected tests again.
- Full renderer, Electron, daemon and CLI builds passed. Electron/daemon/CLI were rebuilt after the last source changes. Bundled Numbat verification passed.
- Four real OfficeCLI/Chromium fixtures passed: a fitting text box and table cell are accepted, and deliberately excessive translations in each are blocked.
- On the user's original 39-slide package, a QA copy with coherent German translations for pages 2, 3 and 9 checked 32 changed text boxes and applied native fitting to 27. Reopening the serialized PPTX required no further DOM font adjustment. All three affected pages were rendered and visually inspected: titles and body text stayed in their boxes; artwork and geometry were preserved. The source hash stayed unchanged.
- Chrome opened the actual Tokyo page through the new HTTP path: 12 tile responses were HTTP 200, all 10 markers rendered, and the request Referer was the real loopback origin. A separate browser fixture verified module loading, reload and origin-only Referer without contacting a tile server.

## Scope and local evidence

This fixes the translation pipeline and browser-open behavior. The selected-page QA copy is not a complete new translation of the 39-slide document and is not delivered as one. Existing German output is unchanged and needs a new translation run to benefit from paragraph-level translation. Fit checks cover rendered slide text boxes and table cells, not semantic accuracy or text embedded in pictures/charts. Native Microsoft PowerPoint was not used for the visual check. The HTTP preview lives while NeoWorker runs; copying an HTML file and opening it directly with `file:` does not create that origin.

Evidence paths on the development machine:

- `/tmp/neoworker-layout-fix-20260919/`: build/test logs, map screenshot and pre-edit HTML backup.
- `/var/folders/f6/v2yvmyfx77xdvgw7gfyj1xdr0000gn/T/neoworker-translation-layout-qa-PVizPV/`: final selected-page PPTX, native post-write measurements and page images.
- `/var/folders/f6/v2yvmyfx77xdvgw7gfyj1xdr0000gn/T/neoworker-text-fit-fixtures-WEIYWc/`: four renderer fixture results.
- `/var/folders/f6/v2yvmyfx77xdvgw7gfyj1xdr0000gn/T/neoworker-browser-map-qa-CfOaQp/`: browser origin/module regression.

Replays: `scripts/qa/translation-layout.cjs` (Electron, user-supplied source/dictionary), `scripts/qa/translation-text-fit-fixtures.cjs` (Electron), and `scripts/qa/external-web-preview.mjs` (Chrome).
