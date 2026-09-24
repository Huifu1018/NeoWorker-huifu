# News Feed editorial cards and dynamic covers — 2026-09-25

final result: passed

## Visual comparison

The selected first design (`exec-de16f548-6372-4490-b6da-1ab94f8a2fd1.png`) and the implementation were opened together in the same comparison input at 1487 × 1058. The latest user requirement replaces the mock's repeated illustrative artwork with source-specific images and per-item text covers. This is a production-component integration, not a pixel-identical reproduction of the sample feed.

The browser harness imports the real PaperNewsPanel, PaperNewsCover and application styles. Its feed metadata and interaction transport are isolated fixtures. The first three cover payloads came from separate live Electron requests to arXiv, Hugging Face and GitHub, including actual normalization and cache writes. Historical GPT-4 content intentionally exercises arXiv HTML image extraction; it does not represent today's search results. Production full feed refresh and task execution are not simulated as passing end-to-end here.

- Typography: existing DM Sans and Chinese system fallback retained; 18 px card titles, 14 px summaries. The app header is intentionally more compact than the mock, consistent with the other application pages. Source text remains untranslated, controls follow locale.
- Layout: three equal 455 px tracks at 1487 px, landscape covers, unboxed editorial cards, aligned bottom actions and dividers. Authors, source/PDF links and ranking details remain available, making rows taller than the simplified mock. Two columns confirmed at 1000 px and one at 480/360 px; no horizontal overflow.
- Color: shared white/soft-blue surfaces and blue primary action; dark theme follows existing tokens. No per-source colored card backgrounds.
- Imagery: official bundled source logos; publisher images retain their complete aspect ratio. Portrait images have white margins rather than cropped diagrams. A source image is not necessarily a representative summary figure; captions accurately identify its origin. Missing images use the current title, not an unrelated illustration.
- Copy and interactions: News Feed naming, independent source settings, bookmarks, empty search, successful search, source opening and creation of a reading draft verified. This test did not send any task to a model.

## Iteration

A small-card inspection identified that the full three-line text-cover treatment could become too crowded at narrow widths. Added a cover-specific container rule below 340 px: two title lines, tighter padding, and no secondary author line. The 360 px post-fix screenshot confirms no collision with the cover caption. Recompared the final desktop screenshot with the selected design; no remaining actionable P0/P1/P2 visual issues were found within this scope. Full screenshots provide readable typography and controls; the narrow-cover capture is the focused evidence for the fix.

## Evidence

- [Desktop, Chinese/light](news-covers-2026-09-25/desktop.png)
- [Desktop, English/dark](news-covers-2026-09-25/dark-en.png)
- [Narrow layout](news-covers-2026-09-25/mobile.png)
- [Narrow text-cover detail after fix](news-covers-2026-09-25/text-narrow.png)

## Engineering validation

- 35 focused tests passed across cover caching, metadata parsing, source state, IPC validation and navigation. Cover tests include request deduplication, restart cache reuse, negative cache expiry, host cooldowns, concurrency limits, malformed caches, unsupported content and PDF fallback.
- Electron TypeScript build passed; production Vite renderer build passed (existing large-chunk warning remains).
- Differential renderer type check: zero new diagnostic identities against 163 existing baseline diagnostics. This is not a clean whole-project type-check claim.
- Live publisher checks: GitHub repository social preview, Hugging Face paper thumbnail and arXiv original HTML image retrieved and converted to bounded JPEGs.
- Actual bundled PDF first-page renderer exercised inside Electron with a generated fixture PDF; output successfully normalized.
- Browser console: no errors observed in tested states.

No installer, release, application-profile migration or installed-app replacement was performed. Network restrictions, publisher availability and limits can still produce a text cover. Windows packaging and live model translation/research are outside this change's validation.
