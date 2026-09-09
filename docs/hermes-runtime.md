# Hermes Runtime integration

NeoWorker has two Hermes integration layers:

- **Hermes Agent provider** sends model requests to a local Hermes OpenAI-compatible Gateway (`http://127.0.0.1:8642/v1`). The normal NeoWorker `SessionRuntime`, `ToolRegistry`, approval policy, sandbox, and Shell executor remain in control.
- **Hermes ACP session adapter** (`HermesAcpClient` and `HermesRuntimeAdapter`) can start a real `hermes acp` process, persist an ACP session handle, stream `session/update` events, cancel a prompt, and restore a session. It is available for explicitly selected external-runtime tasks.

The ACP adapter is opt-in through the task's external runtime configuration; ordinary NeoWorker tasks continue to use the native execution path. Hermes owns tool execution for ACP tasks, while NeoWorker mediates permission requests and records runtime events. ACP permission callbacks do not cover every operation and are not a sandbox. A pinned-source adapter remains a viable implementation path. The adapter supports cancellation and safe pause/resume at a session boundary; resuming loads the persisted session and sends an explicit continuation prompt.

`HermesRuntimeOptions.onPermissionRequest` receives the operation details, offered options, and an AbortSignal. Return the selected option ID or null. `HermesPermissionBridge` validates the active session and options and dismisses on timeout, cancellation or handler failure. Generic `onRequest` callbacks cannot approve permission requests. The host must wire this handler to its task approval service and close pending UI when the signal aborts. This wiring is not implemented yet.

The daemon exposes `createHermesPermissionHandler(taskId)`, which delegates to the existing `requestApproval` path and keeps workspace rules, persisted approval actions, and UI events centralized. The production executor passes this handler when constructing the ACP adapter. Permission requests are therefore routed through NeoWorker's approval service rather than a generic callback.

Tool results sent back to the model are capped at 200,000 characters. The full structured result remains available to task logs and evidence, while the model receives a valid truncated payload with an explicit marker.

For current evidence, outstanding requirements and package freshness, see [hermes-test-report.md](hermes-test-report.md).

## Local test

1. Start and configure Hermes (`hermes status`; `hermes acp --check`).
2. Start Hermes Gateway if testing the Provider entry, or use the ACP adapter tests for the subprocess path.
3. In NeoWorker settings choose **Hermes Agent**, keep the default base URL, and select a model advertised by the Gateway.
4. Run the focused checks:

```sh
hermes acp --check
npm test -- --run src/electron/agent/runtime/__tests__/hermes-acp-client.test.ts
npm test -- --run src/electron/agent/tools/__tests__/shell-tools.test.ts
```

Do not automatically retry an interrupted ACP prompt: Hermes may already have performed a side effect. Restore the checkpoint and let the user explicitly continue.
