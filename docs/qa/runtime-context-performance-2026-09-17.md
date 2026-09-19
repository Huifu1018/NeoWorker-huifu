# Runtime Context and Progress Verification

## Scope

- General Hermes API context projection, not a translation-only fast path.
- Stale ToolRegistry references after workspace/permission updates.
- Concise, evidence-based progress signals, without displaying reasoning text.
- No change to provider, model, reasoning level, translation coverage, source
  fidelity checks, approval policy, or side-effect retry policy.

## Implementation

Before building API arguments, large older completed tool exchanges are archived
as content-addressed JSON under `<workspace>/.neoworker/context/`. Their API-only
projection carries the retrieval path and bounded metadata. Original session
messages are unchanged. The model is instructed to retrieve omitted evidence
before relying on exact details and not to repeat side effects for retrieval.

The soft tool-payload budget is 80,000 characters. User/system messages, assistant
prose, provider-required reasoning, the two newest tool exchanges, structured
errors, pending calls and multimodal results are preserved. Therefore this is
not a hard limit on total model context. Disk failures or archive verification
failures retain the complete original exchange. Projection is disabled if the
session-scoped direct/deferred catalog has no NeoWorker read_file tool. Files stay local to the same
workspace; raw content is not written to performance log lines.

ToolExecutionCoordinator resolves the current registry once per dispatch, so
new calls use updated workspace permissions and document contracts while active
calls stay with their original instance.

Reasoning chunks generate at most one content-free activity event every 15
seconds. Header labels cover document, presentation, spreadsheet, file and
command operations; translation counts reflect committed checkpoint results.
After 45 seconds without a new execution signal the header reports elapsed
silence, not a presumed hang. Signals from previous user turns and late text
chunks after prompt completion are excluded.

## Offline Replay

Read-only replay of the reported Japanese translation, ending before subsequent
queued requests. No model API calls; archives created only in a temporary test
directory and removed when replay exits.

| Measurement | Original | Projected |
| --- | ---: | ---: |
| Cumulative stored-message characters across 29 requests | 13,741,818 | 7,246,608 |
| Last request, stored-message characters | 817,787 | 377,491 |
| Last request, tool-payload characters | 558,334 | 118,038 |

Cumulative reduction: approximately 47.3%. These are serialized character counts,
not token counts, not elapsed times, and exclude the separately injected system
prompt/tool schemas. Reasoning and recent/error payloads explain why the final
tool payload still exceeds the soft budget. This does not demonstrate restored
4-5 minute latency or unchanged semantic quality on a new live translation.

Reproduce with:

```sh
python3 scripts/qa/replay_hermes_context.py /path/to/state.db SESSION_ID --before UNIX_TIMESTAMP_SECONDS
```

## Checks and Remaining Gates

- 16 Python launcher tests pass, covering archival/retrieval, reader availability, original-message immutability,
  model-option preservation, simple requests, error/pending/multimodal handling,
  parallel call pairing, disk failure and workspace symlink escape.
- 356 targeted TypeScript regression tests pass, covering registry replacement during execution,
  translation completeness/fidelity, recovery, cancellation and progress labels.
- Electron TypeScript compilation passes.
- Full renderer type-check is not green: existing application/interface/test
  diagnostics remain outside the changed progress logic.
- A fresh packaged build is required to include the Python launcher change;
  previously delivered installers do not contain it.
- Real-provider latency, evidence retrieval behavior and semantic-quality
  comparisons still need live acceptance testing. No Windows machine was used
  for this change; cross-platform behavior is covered by portable code/tests,
  not a claim of Windows end-to-end verification.
