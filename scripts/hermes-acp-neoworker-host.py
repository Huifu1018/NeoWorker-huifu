"""Launch Hermes ACP with NeoWorker-owned tools enabled through MCP.

Hermes ACP currently hard-codes the ``hermes-acp`` toolset when it creates a
session. This launcher replaces that enabled list with the task-scoped
``mcp-neoworker`` toolset before AIAgent initialization. Disabling the
``hermes-acp`` bundle is insufficient: Hermes preserves its core file/shell
tools when disabling a platform bundle. No installed Hermes files are changed.
"""

from __future__ import annotations

import json
import os
import sys
from functools import wraps
from importlib.metadata import version


SUPPORTED_HERMES_VERSION = "0.18.0"
NEOWORKER_MCP_SERVER_NAME = "neoworker"


def is_neoworker_application_tool_error(result):
    """Return whether a failed tool result still proves the host is reachable.

    Hermes 0.18 increments its server-wide MCP circuit breaker for every
    ``isError`` tool result. A few ordinary web timeouts can therefore block
    unrelated local tools such as ``parse_document`` for the next minute.
    NeoWorker's host returns a valid MCP response for these application-level
    failures, so they must not be treated as transport outages.
    """
    try:
        payload = json.loads(result) if isinstance(result, str) else result
    except (TypeError, json.JSONDecodeError):
        return False
    if not isinstance(payload, dict) or "error" not in payload:
        return False

    error_text = str(payload.get("error") or "").strip().lower()
    if not error_text:
        return False
    transport_markers = (
        "mcp server 'neoworker' is unreachable",
        "mcp server 'neoworker' is not connected",
        "mcp server 'neoworker' transport is down",
        "mcp call failed:",
        "mcp client disconnected",
    )
    return not any(marker in error_text for marker in transport_markers)


def install_neoworker_mcp_failure_isolation():
    """Keep one tool failure from opening Hermes' server-wide breaker."""
    try:
        import tools.mcp_tool as mcp_tool
    except ImportError:
        return

    if getattr(mcp_tool, "_neoworker_failure_isolation_installed", False):
        return
    original_factory = mcp_tool._make_tool_handler

    def isolated_factory(server_name, tool_name, tool_timeout):
        handler = original_factory(server_name, tool_name, tool_timeout)
        if server_name != NEOWORKER_MCP_SERVER_NAME:
            return handler

        @wraps(handler)
        def isolated_handler(args, **kwargs):
            result = handler(args, **kwargs)
            if is_neoworker_application_tool_error(result):
                mcp_tool._reset_server_error(server_name)
            return result

        return isolated_handler

    mcp_tool._make_tool_handler = isolated_factory
    mcp_tool._neoworker_failure_isolation_installed = True


def neoworker_provider_kwargs():
    """Read the provider selected by NeoWorker, never Hermes user config."""
    provider = os.environ.get("NEOWORKER_HERMES_PROVIDER", "").strip()
    if not provider:
        return {}

    result = {
        "provider": provider,
        "model": os.environ.get("NEOWORKER_HERMES_MODEL", "").strip(),
        "api_mode": os.environ.get("NEOWORKER_HERMES_API_MODE", "").strip() or None,
        "base_url": os.environ.get("NEOWORKER_HERMES_BASE_URL", "").strip() or None,
        "api_key": os.environ.get("NEOWORKER_HERMES_API_KEY", "").strip() or None,
    }
    result = {key: value for key, value in result.items() if value is not None}
    # A configured NeoWorker route must never inherit a second provider's
    # external subprocess command from a Hermes config file.
    result["command"] = None
    result["args"] = []
    return result


def host_owned_agent_kwargs(kwargs):
    result = dict(kwargs)
    if result.get("platform") == "acp":
        result["enabled_toolsets"] = ["mcp-neoworker"]
        result["disabled_toolsets"] = None
        result["skip_context_files"] = True
        result["skip_memory"] = True
        result.update(neoworker_provider_kwargs())
    return result


def installed_hermes_version():
    # The frozen executable is built from the pinned Hermes distribution. Its
    # metadata is not needed at runtime, and avoiding a filesystem lookup also
    # keeps the standalone binary independent from the user's Python install.
    if getattr(sys, "frozen", False):
        return SUPPORTED_HERMES_VERSION
    return version("hermes-agent")


def runtime_check():
    """Validate the embedded ACP runtime without starting a model session."""
    installed_version = installed_hermes_version()
    if installed_version != SUPPORTED_HERMES_VERSION:
        raise RuntimeError(
            "NeoWorker embedded ACP requires hermes-agent "
            f"{SUPPORTED_HERMES_VERSION}; found {installed_version}."
        )

    # Import the same modules used by the live host. This catches incomplete
    # PyInstaller collection while keeping the check credential-free.
    import acp  # noqa: F401
    import acp_adapter.entry  # noqa: F401
    import acp_adapter.server  # noqa: F401
    import run_agent  # noqa: F401
    import tools.mcp_tool as mcp_tool

    install_neoworker_mcp_failure_isolation()
    failure_isolation_installed = bool(
        getattr(mcp_tool, "_neoworker_failure_isolation_installed", False)
    )
    if not failure_isolation_installed:
        raise RuntimeError("NeoWorker MCP failure isolation was not installed")

    print(json.dumps({
        "ok": True,
        "frozen": bool(getattr(sys, "frozen", False)),
        "hermesAgentVersion": installed_version,
        "mcpFailureIsolation": failure_isolation_installed,
    }))


def main():
    if "--neoworker-runtime-check" in sys.argv[1:]:
        runtime_check()
        return

    installed_version = installed_hermes_version()
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

    install_neoworker_mcp_failure_isolation()

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
