# PDF figure resolution regression — 2026-09-25

## Reproduced cause

A local 19-page translation used a figure cropped from a 150-DPI overview. The task cropped a 385 × 392 raster region, then resized it 2× to 770 × 784 with interpolation. The final PDF embedded that unchanged raster at about 504.8 × 513.7 points: 110 nominal DPI, with only about 55 DPI of original sampled detail. Enlarging the PNG did not recover the vector source detail.

The native figure renderer also previously cropped a page limited to 3× scale/2400px on the longest edge. Small column figures could consequently have too few pixels when reused at full text width. Export checks decoded images but did not check printed resolution.

## Changes

- Render directly from PDF drawing instructions into the cropped canvas, applying a viewport translation. Do not rasterize the whole page at preview scale and then crop/upscale it.
- Default 300 source DPI, optional 72–600 DPI. Figure regions additionally target 2400px width, bounded to 6000px per side and approximately 24 megapixels. Report actual source rendering DPI, usable 300-DPI print width, and resource-limit warnings.
- Keep News Feed thumbnail rendering explicitly at 144 DPI; thumbnail and deliverable quality policies remain separate.
- Include render version and DPI in visual-tool asset/cache identity.
- Inspect final PDF image transforms, including nested forms and rotated images. Reject raster figures larger than two inches below 180 effective DPI in built-in export and full-translation delivery; the generation guidance targets 300 DPI. Small icons and vector artwork are exempt.
- Advise returning to the original PDF for repairs; prohibit enlarging existing low-resolution previews. Upscaling can artificially inflate nominal DPI, so the numeric check is a conservative guard, not proof of source fidelity or semantic correctness.

## Evidence

The actual local manuscript was re-exported with all six figures rendered from the original PDF using the unchanged crop regions. The result has 19 pages and identical normalized extracted text. Figure 2 is now 2400 × 2444px, approximately 342 effective DPI. All six raster figures pass a separate 300-DPI review. The previous PDF triggers three low-resolution findings (pages 4, 8, 18).

The repaired document and review data are local artifacts under `output/pdf/pastabench-figure-repair/`; user documents and task logs are not committed. The final page 4 was rendered at 300 DPI and visually inspected: small labels and sector boundaries are crisp, caption and following text remain readable. All final pages passed structural text/layout review and were rendered for evidence. This does not re-evaluate translation accuracy.

## Validation

- 72 focused tests passed: source crop pixels, output sizing/resource bounds, printed DPI, rotation, nested forms, vector exemption, translation contracts, image path embedding and vision caching.
- Electron TypeScript build passed.
- Focused lint: zero errors; two pre-existing native-canvas CommonJS import warnings.
- No installer or release was produced; the installed app has not been replaced.
