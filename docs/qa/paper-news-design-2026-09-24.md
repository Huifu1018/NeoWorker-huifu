# Paper News visual refresh — 2026-09-24

## Design scope

Targeted evolution of the existing research feed: preserve navigation, source data, settings, bookmarks and task actions. The prior surface used neutral source tiles and a two-column feed. Retain NeoWorker typography, blue actions, rounded controls, theme tokens and Lucide icons. Add rose, amber and green source identities, consistently repeated in overview tiles and card badges. Design variance 3, motion intensity 2, visual density 6: organized, compact browsing with only hover feedback.

## Verified

- Browser QA used the real component with cached public feed metadata and an isolated in-memory IPC bridge. The installed profile was not modified.
- At a 1270px panel width, computed card columns were 390px / 390px / 390px. At 930px: two 432px columns. At 550px: one 514px column. None overflowed horizontally.
- Light and dark modes visually inspected. Source identity uses text and icons as well as color. Existing focus states and reduced-motion support preserved.
- Chinese and English inspected; English repository action buttons had no clipped labels at the wide layout.
- Source filtering and the reading task draft action worked. No browser error logs were recorded.
- Renderer production build and targeted lint passed. Renderer type-check comparison retained 169 pre-existing diagnostic identities, with no new diagnostics.
- Existing Chinese/English navigation tests passed (2 tests).

No installer or public release was produced for this visual-only change.
