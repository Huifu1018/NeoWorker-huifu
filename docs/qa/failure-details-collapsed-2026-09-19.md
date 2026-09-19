# Failure details stay collapsed

Changed the conversation renderer so failed tool results, timeline errors and failed steps do not automatically expand, including when they are the latest event in an active task or have nested children. Manual disclosure remains available. Failure status and diagnostic contents are retained.

Read the installed app's task database in read-only mode. The latest Japanese and German translation tasks are recorded as completed, but contain intermediate translation layout errors, translation guard errors and command failures. This UI change does not resolve those underlying tool failures or certify their output quality.

The translation guard also persisted the Chinese implementation note `（Hermes 中为 mcp_neoworker_office_translation）`. The display sanitizer now removes that specific runtime alias note, including from historical events, without replacing ordinary discussion of Hermes.

Validation:

- 40 tests passed across timeline payload details, runtime privacy and event presentation.
- 46 browser checks passed using the actual MainContent component: execution-record controls plus failure disclosure for tool results, normalized timeline errors and failed steps at 1365px and 760px. Verified default collapse, manual open/close, progress updates and terminal failure updates.
- Frontend production build passed (existing chunk-size warnings).
- Visually inspected the collapsed timeline-error screenshot.

Commands:

```sh
npx vitest --config config/vitest.config.ts run src/renderer/components/__tests__/timeline-tool-payload-details.test.ts src/renderer/utils/__tests__/runtime-privacy.test.ts src/renderer/components/__tests__/task-event-presentation.test.ts --maxWorkers=1
NEOWORKER_QA_RECORD_ONLY=1 node scripts/qa/artifact-turn-rendering.mjs
npm run build:react
```

This change is in source and the renderer build. The installed application and previous DMG have not been updated by this work.
