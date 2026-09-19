# Japanese PPTX translation recovery regression

The reported task `fb41386e-302e-4cb0-a503-9416daa034e5` translated 440 units from the 13-slide MotusAI5.12 deck. Repeated layout repairs then hit exact-call deduplication. Updating the app also retained the exhausted layout-repair counter.

Changes:
- Scope apply retry invalidation to the translation checkpoint after an accepted stage. Inspect, unrelated checkpoints, zero-progress stages and repeated identical stages retain loop protection.
- Measure and apply bounded native table text autofit across the full table, including unchanged labels. Keep the 65% scale / 8-point minimum and table-frame growth checks; tolerate the renderer's 2–3 pixel border seam.
- Compare unresolved shape overflow against the original source. The five two-line GPU labels on slide 8 already overflow their original 17.78-point frames. Equal-scale, no-worse overflow is accepted; increased overflow remains blocked. This does not claim to repair pre-existing source layout.
- Version layout repair checkpoints. When inspecting an old checkpoint, restore saved valid text reopened by the obsolete checker, reset its obsolete repair budget and recheck using the corrected gate. Preserve all original data and still enforce a bounded repair loop.

Validation:
- 156 focused tests passed across eight suites, followed by the updated 13-case deduplication suite. This includes real document tools, old-checkpoint migration, regression checks for new vs pre-existing overflow, exact repeat protection and structured recovery transport.
- Six OfficeCLI/Chromium fixture cases passed for fitting/overflowing text, tables and Korean justification.
- The actual TaskExecutor → HTTP MCP → coordinator → native document-tool replay used the saved Japanese translation, not a live model. It staged all 440 units, returned five actionable wording repairs on slides 10/13, staged concise equivalents, generated one final artifact and passed source fidelity. No original task/database/source/checkpoint was modified.
- Final output contains all 13 slides. Second render/measurement required no further shrinking; the only remaining frame-boundary diagnostics are the five inherited source overflows on slide 8. Reviewed enlarged slides 6, 8, 10 and 13; native table text remains inside the table.
- A separate replay of the exact latest checkpoint (75 pending units, four previous layout failures) restored all 440 saved units on inspect and generated the PPTX without further translation or wording edits. Rendered all 13 recovered pages and reviewed pages 6, 8, 10 and 13.
- Full renderer, Electron, daemon and CLI build passed.

Limitations: the replay does not certify the live provider's next choices or Microsoft PowerPoint rendering. It validates the tool workflow and bundled OfficeCLI/Chromium renderer. The delivered recovered artifact uses the latest saved checkpoint wording unchanged; it is not a full linguistic review. Image text remains unchanged.

Installer and recovery file: `release/macos-2026-09-19-translation-repair-2/`.

Package verification: packaged repair modules match compiled source, deep ad-hoc signature verification passed, DMG checksum/mount/renderer launch smoke passed. Secret audit passed with the same repository rules read directly from the archive to avoid full extraction on a nearly full disk. Built the app using electron-builder on a temporary RAM volume and compressed it with hdiutil; the DMG includes the Applications shortcut. Old installers and user data were preserved.
