# Hermes Runtime integration

NeoWorker has three Hermes integration choices:

- **Hermes Agent provider** points at Hermes API Server (`http://127.0.0.1:8642/v1`). This is a complete Hermes agent runtime: it creates an `AIAgent` and executes Hermes-native tools inside the Hermes process. It is an external-runtime option, so NeoWorker cannot claim ownership of those side effects.
- **Hermes Model Proxy provider** points at Hermes' model-only credential proxy (`http://127.0.0.1:8645/v1`). The proxy forwards OpenAI-compatible request and response bodies without running an agent loop. This is the host-owned path: NeoWorker's `SessionRuntime`, `ToolRegistry`, approval policy, sandbox, Shell executor, and task log receive and execute the returned tool calls.
- **Hermes ACP session adapter** (`HermesAcpClient` and `HermesRuntimeAdapter`) can start a real `hermes acp` process, persist an ACP session handle, stream `session/update` events, cancel a prompt, and restore a session. It is available for explicitly selected external-runtime tasks.

The ACP adapter is opt-in through the task's external runtime configuration; ordinary NeoWorker tasks continue to use the native execution path. Hermes owns tool execution for ACP tasks, while NeoWorker mediates permission requests and records runtime events. ACP permission callbacks do not cover every operation and are not a sandbox. A pinned-source adapter remains a viable implementation path. The desktop task pause controller now calls the adapter's safe session-boundary pause/resume primitives; resuming loads the persisted checkpoint and sends an explicit continuation prompt.

`HermesRuntimeOptions.onPermissionRequest` receives the operation details, offered options, and an AbortSignal. Return the selected option ID or null. `HermesPermissionBridge` validates the active session and options and dismisses on timeout, cancellation or handler failure. Generic `onRequest` callbacks cannot approve permission requests. The production executor wires this handler to the daemon task approval service; UI integrations must still close any pending approval surface when the signal aborts.

The daemon exposes `createHermesPermissionHandler(taskId)`, which delegates to the existing `requestApproval` path and keeps workspace rules, persisted approval actions, and UI events centralized. The production executor passes this handler when constructing the ACP adapter. Permission requests are therefore routed through NeoWorker's approval service rather than a generic callback. ACP-native tool execution is not yet equivalent to the NeoWorker Tool Host: filesystem, Shell, sandbox and task-log ownership still require a host bridge before the full plan gate is met.

## ACP Tool Host boundary

Hermes Agent v0.18.0's ACP `session/new` contract accepts `mcpServers`, but its server creates each session with the built-in `hermes-acp` toolset. That toolset includes native `terminal`, `read_file`, `write_file`, `patch`, and `process` tools. The current ACP contract has no request field for replacing that toolset or forwarding native tool calls to the client. Registering a NeoWorker MCP server therefore adds tools but does not, by itself, transfer ownership of those side effects.

Until Hermes exposes a supported toolset override or client-side tool-call callback, NeoWorker keeps ACP Hermes tasks explicitly opt-in and records this boundary as an open integration item. The safe host-owned alternative is **Hermes Model Proxy**, not Hermes API Server. Start the proxy with `hermes proxy start --provider nous` or `hermes proxy start --provider xai`, then select **Hermes Model Proxy** in NeoWorker and refresh its model list. Hermes v0.18.0's proxy is a credential-attaching forwarder; it does not execute tools.

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
npm test -- --run src/electron/agent/tools/__tests__/shell-tools.test.ts
```

Do not automatically retry an interrupted ACP prompt: Hermes may already have performed a side effect. Restore the checkpoint and let the user explicitly continue.
