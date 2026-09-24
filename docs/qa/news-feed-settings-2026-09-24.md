# News Feed source settings validation — 2026-09-24

## Scope

Rename the feed to News Feed in English and 资讯动态 in Chinese. Add independently saved settings for arXiv, Hugging Face and GitHub. This change does not add a financial feed or publish an installer.

## Automated checks

- 26 tests passed across feed adapters/service, request transport, IPC, and sidebar navigation.
- Regression coverage: legacy cache/config migration; independent keyword/date ranking; arXiv category and GitHub language/star queries; bounded query size and rejected invalid filters; Hugging Face matching-only filtering without removing bookmarks; source-specific cache invalidation and refresh; preserved cooldowns; IPC source validation; Chinese/English navigation names.
- Electron TypeScript compilation passed.
- Renderer production build passed.
- Focused lint passed with no warnings or errors.
- Renderer type diagnostics compared against the pre-change source: 163 existing diagnostic identities, no new diagnostics.

## Browser checks

The real React component and application styles were rendered in an isolated local harness using public feed metadata and in-memory IPC substitutes. The installed application's profile was not modified.

- Chinese title, description, navigation labels and setting labels reviewed.
- English News Feed, Source settings, GitHub language/star controls and save action reviewed.
- Each source panel opens its own settings; official source marks and the shared light-blue treatment remain.
- Draft GitHub changes survived switching to Hugging Face and saving only Hugging Face; the GitHub save then applied only GitHub and refreshed that source.
- arXiv accepted cs.AI and retained it after save. Closing/reopening settings retained saved GitHub options.
- No browser console errors were recorded.

These checks verify rendering and settings interactions with the service covered separately by tests. They are not a live network integration test or a packaged macOS/Windows installer test.
