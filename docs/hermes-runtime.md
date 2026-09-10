# Hermes Runtime integration

NeoWorker has three Hermes integration choices:

- **Hermes Agent provider** points at Hermes API Server (`http://127.0.0.1:8642/v1`). This is a complete Hermes agent runtime: it creates an `AIAgent` and executes Hermes-native tools inside the Hermes process. It is an external-runtime option, so NeoWorker cannot claim ownership of those side effects.
- **Hermes Model Proxy provider** points at Hermes' model-only credential proxy (`http://127.0.0.1:8645/v1`). The proxy forwards OpenAI-compatible request and response bodies without running an agent loop. This is the host-owned path: NeoWorker's `SessionRuntime`, `ToolRegistry`, approval policy, sandbox, Shell executor, and task log receive and execute the returned tool calls.
- **Hermes ACP session adapter** (`HermesAcpClient` and `HermesRuntimeAdapter`) runs Hermes' Agent Loop, persists an ACP session handle, streams `session/update` events, cancels prompts, and restores sessions. New tasks launch through NeoWorker's version-pinned Python wrapper and expose task tools through a loopback MCP Tool Host.

The ACP adapter is opt-in through the task's external runtime configuration; ordinary NeoWorker tasks continue to use the native execution path. For new Hermes tasks, Hermes owns the model loop while NeoWorker executes the exposed tools through `NeoWorkerToolHost` and `ToolExecutionCoordinator`. Existing checkpoints without `toolOwnership: neoworker` remain legacy Hermes-native sessions; they are never silently migrated across tool ownership. Desktop pause/resume retains the saved session and sends an explicit continuation prompt.

The adapter exposes a stable lifecycle surface: `start()`/`prompt()`, `cancel()`/`pause()`, `resume()`/`retry()`, `checkpoint()` and `close()`. Each host call is marked running before dispatch and is recorded as completed, failed, cancelled or unknown after the response boundary. NeoWorker `tool_lifecycle` events include the task ID, structured idempotency key, phase, start/end timestamps, duration, exit code or termination reason when available, and a classified error type. ACP transport events are normalized as durable `hermes_runtime_transport` task events with request, first-byte, response, timeout, cancellation, protocol-error and connection-close phases; response bodies are never logged. Every NeoWorker Tool Host request carries a fresh bounded checkpoint snapshot after its call is marked active, and the terminal response carries a new snapshot after the outcome is persisted. The checkpoint keeps bounded tool-call IDs and the last NeoWorker event sequence. `resume()` and `retry()` treat persisted active calls as unknown and invoke the host's explicit confirmation callback before submitting another Hermes turn; they never replay a tool call automatically.

`HermesRuntimeOptions.onPermissionRequest` receives the operation details, offered options, and an AbortSignal. Return the selected option ID or null. `HermesPermissionBridge` validates the active session and options and dismisses on timeout, cancellation or handler failure. Generic `onRequest` callbacks cannot approve permission requests. The production executor wires this handler to the daemon task approval service; UI integrations must still close any pending approval surface when the signal aborts.

The daemon exposes `createHermesPermissionHandler(taskId)`, which delegates to the existing `requestApproval` path. In host-owned ACP sessions, tool execution also goes through the regular NeoWorker tool policy, approval, sandbox, timeout and lifecycle path. ACP permission callbacks alone are not a sandbox and remain relevant to legacy sessions.

The adapter keeps the task-scoped MCP Tool Host suspended until an ACP prompt is active. Pause, cancel, or an externally aborted `AbortSignal` immediately aborts active host calls and rejects late `tools/call` requests. A cancelled host-owned prompt closes its transport after the ACP cancel handshake; resume reconnects to the persisted checkpoint on a fresh transport so late updates or calls from the cancelled turn cannot start a new side effect.

## ACP Tool Host boundary

Hermes Agent v0.18.0's ACP `session/new` contract accepts `mcpServers`, but its server creates each session with the built-in `hermes-acp` toolset. That toolset includes native `terminal`, `read_file`, `write_file`, `patch`, and `process` tools. The current ACP contract has no request field for replacing that toolset or forwarding native tool calls to the client. Registering a NeoWorker MCP server therefore adds tools but does not, by itself, transfer ownership of those side effects.

`scripts/hermes-acp-neoworker-host.py` replaces the ACP agent's enabled toolsets with only `mcp-neoworker` before initialization. It disables workspace context loading, memory loading, project plugins and inherited kanban tool activation for this process. It does not modify the user's Hermes installation. The wrapper requires exactly `hermes-agent==0.18.0`; another version fails closed until the adapter is verified. Disabling the `hermes-acp` bundle would be insufficient because Hermes deliberately preserves core tools when disabling a platform bundle.

`HermesToolHostMcpServer` exposes only the task's filtered catalog on an ephemeral `127.0.0.1` port with a random bearer token. Every tool call enters the existing executor Tool Host, and the persisted result is returned to Hermes as a bounded MCP tool result. Session-scoped correlation prevents reused MCP request IDs from aliasing calls after reconnect. Request timeout, runtime shutdown, and rejected host dispatches propagate as structured tool results so Hermes can distinguish a failed operation from a malformed MCP response. Loopback addresses are added to the child process's `NO_PROXY`/`no_proxy` so local tool traffic cannot accidentally go through an inherited HTTP proxy.

The launcher resolves the interpreter from the installed `hermes` executable where possible. Set `NEOWORKER_HERMES_PYTHON` to an explicit interpreter path for a custom installation. The final desktop package includes the launcher as an external resource, and artifact smoke compares its bytes with the source being delivered.

The real local Hermes 0.18.0 probe on 2026-09-10 listed exactly the supplied host probe tool and successfully invoked it once through a configured model, returning `NEOWORKER_HOST_OK`. This proves the ACP→MCP→host callback path and native-tool exclusion for that probe. A later real-model attempt returned HTTP 402 (insufficient balance) before any tool call; the wrapper preserves that provider failure as `field_meta.neoworker.runtimeError` so ACP `end_turn` cannot be mistaken for success. Full file/Shell/approval/cancellation scenarios still need end-to-end validation before closing the phase 2 gate.

Tool results sent back to the model are capped at 200,000 characters. The full structured result remains available to task logs and evidence, while the model receives a valid truncated payload with an explicit marker.

For the source-level ownership evidence, see [hermes-tool-ownership-audit.md](hermes-tool-ownership-audit.md). For current evidence, outstanding requirements and package freshness, see [hermes-test-report.md](hermes-test-report.md).

## Local test

1. Start and configure Hermes (`hermes status`; `hermes acp --check`).
2. For host-owned NeoWorker tools, start `hermes proxy start --provider nous` (or `xai`) and choose **Hermes Model Proxy**. Do not use the `8642/v1` API Server entry for this test, because that entry runs Hermes-native tools.
3. Select a model advertised by the proxy and run the focused checks.
4. Run the focused checks:

```sh
hermes acp --check
npm test -- --run src/electron/agent/runtime/__tests__/hermes-acp-client.test.ts
npm test -- --run src/electron/agent/runtime/__tests__/hermes-tool-host-mcp.test.ts src/electron/agent/__tests__/executor-hermes-recovery.test.ts
npm test -- --run src/electron/agent/runtime/__tests__/hermes-host-owned-toolchain.test.ts
python3 scripts/qa/test_hermes_host_launcher.py
npm test -- --run src/electron/agent/tools/__tests__/shell-tools.test.ts
```

Do not automatically retry an interrupted ACP prompt: Hermes may already have performed a side effect. Restore the checkpoint and let the user explicitly continue.
