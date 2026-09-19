# Office translation after an unrelated Hermes task

## Reproduction and cause

The reported task first generated a Seoul HTML map, then received a PPTX attachment with “翻译成韩文”, followed by “继续”. The September 19 task trace contains no successful `office_translation` invocation. It instead searches for a translation skill/CLI, tries `create_presentation`, and probes `create_spreadsheet`.

Hermes caches its initial MCP tool catalog. `TaskExecutor.getHermesHostTools()` stabilized the six Office creation tools across turns but omitted `office_translation`. A map task's filtered catalog could therefore omit the tool required by a later translation turn. The installed `/Applications/NeoWorker.app` archive was checked and contains that omission. Generic format recovery also ran before the translation guard, directing the spreadsheet probe back to the prohibited PPT creation tool.

## Changes

- Include the complete translation tool schema in the stable Hermes catalog from the first turn, respecting registry settings and task/agent permissions.
- Retain translation in the active document task's tool allowlist for native execution as well.
- Check the source-preservation guard before generic Office format recovery. All creation aliases now return the same inspect/stage/apply guidance during translation.
- Identify `office_translation` / `mcp_neoworker_office_translation` as a direct tool, with explicit inspect arguments; distinguish it from a skill or shell command.
- Keep the original-source and verified-output gates intact.
- Rebuild the active document request from persisted user events after app restart. Legacy Hermes snapshots may contain only assistant output plus “继续”; tool output, assistant text, and attachment instructions cannot reset the translation constraint. Later unrelated user requests still release it.

## Verification

`npm run build` passed for renderer, Electron, daemon and CLI.

335 tests passed across nine focused files: Hermes recovery, translation contract, registry skill/tool behavior, document tools, tool catalog caching, translation deduplication, completion contracts, MCP tool host, and Hermes prompts.

The broader `executor-plan-parsing.test.ts` run has five existing failures (Excel plan wording and book-review plan/tool expectations). An isolated copy with this change's executor edits reversed reproduced exactly the same five failures, with 78 other tests passing. The baseline copies were removed afterward.

`scripts/qa/translation-follow-up.cjs` uses the real bundled Hermes executable, MCP transport, registry, tool coordinator, checkpoint files, PPT translation engine and OfficeCLI/Chromium fit check. Model replies are deterministic responses from a local HTTP endpoint; no live provider is needed. It verifies:

1. The first HTML map turn already exposes the complete translation schema.
2. A subsequent Korean translation turn receives correct recovery feedback after an intentionally wrong spreadsheet call.
3. Inspect and stage persist partial progress (1/8 units).
4. “继续” inspects the same checkpoint, translates the remaining seven units and applies a new PPTX.
5. Source fidelity and text fit pass; the original bytes remain identical.
6. Closing and reopening the real Hermes process with a fresh tool registry recovers the active translation constraint from user events, the same translation ID and zero remaining units, with no unknown tool calls.

The user's `源2.0-M32大模型发布会-V4.pptx` (20,719,017 bytes) was copied into a private QA directory and inspected through `DocumentTools.officeTranslation`: 544 units, an initial batch of 160, valid checkpoint and batch IDs. Original SHA-256 remained `08da3052ffcfec0c1bdea544b5c8454c57d9ed24900b052c0544ef1ad51f2187`.

This validates routing, persistence and tool execution. It does not certify a complete Korean translation of the user's 544 units or the quality of a live model's wording. Previous layout/browser fixes remain included.

## Test package

`release/macos-2026-09-19-translation-followup/NeoWorker-0.1.8-8-arm64.dmg`

The release folder contains build, test, runtime QA, source-inspection, packaged-secret audit and DMG smoke-test evidence. Version remains 0.1.8-8; use this dated folder to distinguish it from earlier test packages. Quit the existing app before replacing it, then reopen the original task and send “继续”.
