# Multiple Custom Providers QA

Date: 2026-09-18

## Scope

- Add independent OpenAI-compatible provider instances from the model settings dialog.
- Retain the existing `openaiCompatible` configuration without migration or replacement.
- Keep names, endpoints, API keys, selected models, and model registries keyed by instance ID.
- Accept instance IDs in task selection, provider construction, and the Hermes provider bridge.

## Verification

- Electron TypeScript build: passed.
- Renderer production build: passed (existing chunk-size warning).
- Eight focused Vitest files: 198 tests passed, covering user-defined providers, existing custom providers, model selection, runtime bridging, settings saves, validation, display names, and control-plane configuration.
- Browser QA: `node scripts/qa/custom-providers.mjs` passed using the real settings UI and backend settings validation/factory with in-memory storage.
- Browser workflow: preserve an existing provider, add two more with the same model ID, reload, switch configurations, rename one, delete the other, reload again, and verify the remaining credentials are unchanged.
- Screenshots checked at widths 1440 and 760; custom providers appear near the top and the add-provider button remains visible.
- Request-routing test uses mocked responses and verifies distinct endpoints and authorization headers for identical model IDs.
- `git diff --check`: passed.

## Limits

- No real supplier API calls or user credential changes were made.
- Full repository type-check remains failing, including pre-existing unused image/video panel functions and incompatible settings-tab comparisons outside this change.
- No native Windows run or installer packaging was performed.

## Screenshot Evidence

Local browser output: `/var/folders/f6/v2yvmyfx77xdvgw7gfyj1xdr0000gn/T/neoworker-custom-providers-qa-bkXrop`.
