"""Launch Hermes ACP with NeoWorker-owned tools enabled through MCP.

Hermes ACP currently hard-codes the ``hermes-acp`` toolset when it creates a
session. This launcher replaces that enabled list with the task-scoped
``mcp-neoworker`` toolset before AIAgent initialization. Disabling the
``hermes-acp`` bundle is insufficient: Hermes preserves its core file/shell
tools when disabling a platform bundle. No installed Hermes files are changed.
"""

from __future__ import annotations

import os
from importlib.metadata import version


SUPPORTED_HERMES_VERSION = "0.18.0"


def host_owned_agent_kwargs(kwargs):
    result = dict(kwargs)
    if result.get("platform") == "acp":
        result["enabled_toolsets"] = ["mcp-neoworker"]
        result["disabled_toolsets"] = None
        result["skip_context_files"] = True
        result["skip_memory"] = True
    return result


def main():
    installed_version = version("hermes-agent")
    if installed_version != SUPPORTED_HERMES_VERSION:
        raise RuntimeError(
            "NeoWorker host-owned ACP requires hermes-agent "
            f"{SUPPORTED_HERMES_VERSION}; found {installed_version}. "
            "The adapter must be verified before using another Hermes version."
        )
    # Inherited kanban metadata can automatically add native toolsets even
    # when enabled_toolsets is explicit. It is unrelated to this host task.
    os.environ["HERMES_KANBAN_TASK"] = ""
    os.environ["HERMES_ACCEPT_HOOKS"] = "0"
    os.environ["HERMES_ENABLE_PROJECT_PLUGINS"] = "0"

    import run_agent

    original_agent = run_agent.AIAgent

    class NeoWorkerAIAgent(original_agent):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **host_owned_agent_kwargs(kwargs))

        def run_conversation(self, *args, **kwargs):
            self._neoworker_runtime_error = None
            try:
                result = super().run_conversation(*args, **kwargs)
            except Exception as error:
                self._neoworker_runtime_error = {
                    "code": "HERMES_RUNTIME_ERROR", "message": str(error)[:4000],
                }
                raise
            if isinstance(result, dict) and (result.get("error") or result.get("failed")):
                self._neoworker_runtime_error = {
                    "code": "HERMES_RUNTIME_ERROR",
                    "message": str(result.get("error") or result.get("final_response") or "Hermes runtime failed")[:4000],
                    "retryable": result.get("retryable") is True,
                    "reason": str(result.get("failure_reason") or ""),
                }
            return result

    run_agent.AIAgent = NeoWorkerAIAgent

    # Hermes 0.18 reports provider failures as assistant text with end_turn,
    # discarding run_conversation's error flag. Preserve that structured flag
    # in ACP metadata so NeoWorker never marks an HTTP 402/401/etc. as success.
    import acp_adapter.server as acp_server

    original_server = acp_server.HermesACPAgent

    class NeoWorkerACPAgent(original_server):
        async def prompt(self, prompt, session_id, **kwargs):
            state = self.session_manager.get_session(session_id)
            if state is not None:
                state.agent._neoworker_runtime_error = None
            response = await super().prompt(prompt=prompt, session_id=session_id, **kwargs)
            state = self.session_manager.get_session(session_id)
            error = getattr(state.agent, "_neoworker_runtime_error", None) if state else None
            if error and response.stop_reason != "cancelled":
                meta = dict(response.field_meta or {})
                meta["neoworker"] = {"runtimeError": error}
                response.field_meta = meta
            return response

    acp_server.HermesACPAgent = NeoWorkerACPAgent

    from acp_adapter.entry import main as acp_main

    acp_main()


if __name__ == "__main__":
    main()
