# NeoWorker identity and inspiration availability

## Scope

- The inspiration gallery now separates ready, setup-required, and plan-only entries; checks skills, platform/dependencies and configured integrations; and rechecks before handing a draft to the composer. This builds on the September 17 changes already in this worktree.
- This pass adds a bounded 10-second availability check and rejects malformed status responses. Failed or stalled checks hide actionable cards and allow refresh/retry.
- The embedded Hermes 0.18.0 system prompt previously supplied `You are Hermes Agent` and standalone Hermes self-help guidance. Task-level NeoWorker wording did not replace that system identity.
- The host launcher now installs the NeoWorker identity at system-prompt construction, disables standalone SOUL identity, supplies the actual `HERMES_HOME` configuration as JSON data, and distinguishes configured paths from observed filesystem facts.
- The engine's persisted-system-prompt compatibility check rejects pre-fix identities and changed directory configuration. Hermes rebuilds through its existing persistence path; the patch does not edit conversation messages or user documents.
- Initial, follow-up and recovery task prompts reinforce the same identity and scoped-evidence rules. Engine provenance remains explainable; responses and document contents are not globally string-replaced.
- The runtime build gate requires `hostIdentity: NeoWorker`; the local macOS arm64 embedded runtime was rebuilt.

## Verification

- `python3 scripts/qa/test_hermes_host_launcher.py`: 18 tests passed, including macOS/Windows path facts, missing configuration, disabling SOUL overrides and stale-cache rejection.
- Ten focused Vitest suites: 237 tests passed (task prompts, launcher, provider bridge, recovery, chat mode, skill loader/eligibility, gallery catalog/availability/product visibility). Skill-loader tests emit existing mock warnings but pass.
- `node scripts/qa/hermes-identity.mjs`: passed using the real rebuilt binary, actual ACP session persistence, isolated SQLite database and local fake model endpoint. Inspected outgoing system prompts for initial/follow-up/resumed sessions; seeded a pre-fix stored identity and verified migration. History payloads and timestamps are preserved; Hermes reallocates SQLite row IDs during normal restoration.
- `node scripts/qa/ideas-availability.mjs`: passed desktop/narrow browser tests, including unavailable Notion/calendar, configuration navigation, disconnect-before-click, disabled skills, plan-only handoff, failed checks, timeout and retry. No browser errors or horizontal overflow.
- `npm run build:electron`, `npm run build:react`, `npm run build:hermes-runtime`: passed.

## Limits

- The fake model test verifies what the real embedded runtime sends, not probabilistic response behavior from a paid model.
- No Notion writes, bookings or smart-home device operations were performed. Configured status is not proof that remote credentials remain valid.
- Windows paths are covered by tests, but a Windows native binary/session was not run here.
- Explicitly selected external runtimes and legacy standalone Hermes installations are not reconfigured by this patch.
- No installer was generated or installed in this pass; the running installed application does not automatically inherit workspace changes.
