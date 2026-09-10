"""Exercise the host launcher without requiring Hermes or model credentials."""

import importlib.util
import asyncio
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "neoworker_host_launcher",
    Path(__file__).resolve().parents[1] / "hermes-acp-neoworker-host.py",
)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class HostLauncherTests(unittest.TestCase):
    @staticmethod
    def _modules(run_agent, entry_main, server_agent=None):
        """Build package-shaped stubs so CI does not need Hermes installed."""
        package = types.ModuleType("acp_adapter")
        package.__path__ = []
        entry = types.ModuleType("acp_adapter.entry")
        entry.main = entry_main
        server = types.ModuleType("acp_adapter.server")
        if server_agent is not None:
            server.HermesACPAgent = server_agent
        return {
            "run_agent": run_agent,
            "acp_adapter": package,
            "acp_adapter.entry": entry,
            "acp_adapter.server": server,
        }

    def test_replaces_the_native_and_configured_toolsets_before_agent_init(self):
        created = []
        run_agent = types.ModuleType("run_agent")

        class Agent:
            def __init__(self, *args, **kwargs):
                created.append(kwargs)

        run_agent.AIAgent = Agent
        entry_main = lambda: run_agent.AIAgent(
            platform="acp", model="test-model",
            enabled_toolsets=["hermes-acp", "mcp-other"],
            disabled_toolsets=["terminal"],
        )
        class ServerAgent:
            pass
        with (
            patch.object(launcher, "version", return_value="0.18.0"),
            patch.dict(sys.modules, self._modules(run_agent, entry_main, ServerAgent)),
            patch.dict(launcher.os.environ, {"HERMES_KANBAN_TASK": "old-task", "HERMES_ACCEPT_HOOKS": "1"}),
        ):
            launcher.main()
            self.assertEqual(launcher.os.environ["HERMES_KANBAN_TASK"], "")
            self.assertEqual(launcher.os.environ["HERMES_ACCEPT_HOOKS"], "0")
            self.assertEqual(launcher.os.environ["HERMES_ENABLE_PROJECT_PLUGINS"], "0")
        self.assertEqual(created, [{
            "platform": "acp", "model": "test-model",
            "enabled_toolsets": ["mcp-neoworker"], "disabled_toolsets": None,
            "skip_context_files": True, "skip_memory": True,
        }])

    def test_rejects_an_unverified_hermes_version_before_launch(self):
        with patch.object(launcher, "version", return_value="0.19.0"):
            with self.assertRaisesRegex(RuntimeError, "requires hermes-agent 0.18.0"):
                launcher.main()

    def test_does_not_mutate_the_callers_kwargs(self):
        original = {"platform": "acp", "enabled_toolsets": ["hermes-acp"]}
        launcher.host_owned_agent_kwargs(original)
        self.assertEqual(original["enabled_toolsets"], ["hermes-acp"])

    def test_surfaces_a_provider_failure_as_structured_acp_metadata(self):
        run_agent = types.ModuleType("run_agent")

        class Agent:
            def __init__(self, *args, **kwargs):
                pass

            def run_conversation(self, *args, **kwargs):
                return {
                    "error": "HTTP 402: Insufficient Balance",
                    "retryable": False,
                    "failure_reason": "provider_error",
                }

        run_agent.AIAgent = Agent
        responses = []

        class State:
            def __init__(self, agent):
                self.agent = agent

        class Manager:
            def __init__(self):
                self.state = None

            def get_session(self, _session_id):
                return self.state

        class Response:
            stop_reason = "end_turn"
            field_meta = {}

        class ServerAgent:
            def __init__(self):
                self.session_manager = Manager()
                self.session_manager.state = State(run_agent.AIAgent(platform="acp"))

            async def prompt(self, prompt, session_id, **kwargs):
                self.session_manager.state.agent.run_conversation()
                return Response()

        async def invoke():
            import acp_adapter.server as server
            response = await server.HermesACPAgent().prompt([], "session")
            responses.append(response)

        entry_main = lambda: asyncio.run(invoke())
        with (
            patch.object(launcher, "version", return_value="0.18.0"),
            patch.dict(sys.modules, self._modules(run_agent, entry_main, ServerAgent)),
            patch.dict(launcher.os.environ, {"HERMES_KANBAN_TASK": ""}),
        ):
            launcher.main()

        self.assertEqual(responses[0].field_meta, {
            "neoworker": {
                "runtimeError": {
                    "code": "HERMES_RUNTIME_ERROR",
                    "message": "HTTP 402: Insufficient Balance",
                    "retryable": False,
                    "reason": "provider_error",
                },
            },
        })


if __name__ == "__main__":
    unittest.main()
