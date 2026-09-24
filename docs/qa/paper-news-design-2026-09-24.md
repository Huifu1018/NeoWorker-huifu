# Paper News redesign — 2026-09-24

## Design scope

Research browsing for NeoWorker users, with a compact editorial layout and authentic source branding. Design variance 5, motion intensity 2, density 6. The initial generic source icons and colored card-top borders were rejected; this revision replaces them with official, unmodified brand assets, neutral source panels and topic chips. A subsequent user review rejected the tinted source backgrounds and multiple action colors: the final palette uses neutral theme surfaces, original logo colors, and the existing NeoWorker blue accent for primary actions and selection. Titles flow naturally rather than reserving a fixed-height blank area. Short abstracts appear before their disclosure controls. The application header and business behavior are retained.

## Verification

- Browser QA used the real component, cached public feed metadata, and isolated in-memory IPC. No installed profile data was changed.
- Wide panel: three equal columns (approximately 387–390px, depending on scrollbar visibility). At 930px: two 432px columns. At 550px: one 514px column. No horizontal panel overflow.
- Chinese and English inspected. English repository action labels did not clip in the wide or medium layout.
- Final neutral palette rechecked in light and dark themes; all three source panels share the same background (white in light mode).
- Light and dark screenshots inspected; official GitHub/arXiv white variants are selected for dark surfaces, while the Hugging Face mark retains its original colors. No missing brand images.
- Source filtering, search (PackLab), bookmark count update, and the reading draft callback verified. Browser error log was empty.
- Official SVG assets checked for scripts, event handlers, foreign objects, and external image references. Provenance is recorded next to the assets.
- Renderer type check reports 163 diagnostic identities, all contained in the 169-error pre-existing baseline; no new diagnostics remain. The SVG URL declaration also resolves existing SVG import diagnostics.
- Targeted navigation tests: 2 passed. Renderer lint and production build passed.

No installer or public release is produced for this visual-only revision. Browser QA verifies the renderer and its interactions against a stubbed IPC bridge, not live fetch or installed-app task execution.

## Final palette alignment

User requested the same simple light-blue treatment as other pages. Source panels now reuse the 8% accent blend from `automation-hub.css` / the shared page header, with an 18% accent border blend and a 12% selected background. Official marks retain their original colors; paper cards and topic labels remain neutral. This supersedes the all-neutral source panels above.

Verified light/dark renderer screenshots and equal source backgrounds; browser error log was empty. Frontend production build passed.
