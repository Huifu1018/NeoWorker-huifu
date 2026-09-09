# Hermes 工具所有权审计

更新时间：2026-09-09，针对本机 Hermes Agent v0.18.0。

这份审计用于区分“模型入口”和“Agent Runtime”，避免把一个会执行本地操作的 Hermes 服务误当成纯模型 API。

## 结论

| 入口 | 实际行为 | NeoWorker 是否拥有本地副作用 |
| --- | --- | --- |
| Hermes API Server `8642/v1` | 创建 Hermes `AIAgent`，执行 Hermes toolset，并返回最终回答 | 否 |
| Hermes ACP `hermes acp` | 每个 ACP session 默认启用 `hermes-acp`，其中包含 `terminal`、`process`、`read_file`、`write_file`、`patch` | 否；当前只能桥接权限请求和生命周期 |
| Hermes Model Proxy `8645/v1` | 原样转发 OpenAI-compatible 请求和响应，附加 OAuth 凭据，不运行 Agent Loop | 是；NeoWorker 收到 tool calls 后由 Tool Host 执行 |

## 代码证据

- `gateway/platforms/api_server.py::_handle_chat_completions` 解析消息后调用 `_run_agent`。
- `gateway/platforms/api_server.py::_run_agent` 创建 `AIAgent` 并调用 `agent.run_conversation`。
- `gateway/platforms/api_server.py::_create_agent` 从 `platform_toolsets.api_server` 解析 Hermes toolset；HTTP 请求体里的 `tools` 只参与幂等指纹，不会成为 NeoWorker 的工具回调。
- `acp_adapter/session.py::_make_agent` 固定把 `hermes-acp` 放入 `enabled_toolsets`；`acp_adapter/session.py::_expand_acp_enabled_toolsets` 只额外添加 MCP server toolset。
- `toolsets.py` 中的 `hermes-acp` 包含文件、进程和终端工具。
- `hermes_cli/proxy/server.py` 读取请求体后原样转发到上游，并逐块转发响应；它没有 `AIAgent` 或工具执行循环。

因此，NeoWorker 不能仅凭“OpenAI-compatible”这一名称宣称 8642 或 ACP 的文件系统、Shell、沙箱和任务日志由自己控制。

## NeoWorker 使用方式

需要 NeoWorker 管理文件、Shell、审批、沙箱和任务日志时：

1. 启动 `hermes proxy start --provider nous` 或 `hermes proxy start --provider xai`。
2. 在 NeoWorker 设置中选择 **Hermes Model Proxy**，默认地址为 `http://127.0.0.1:8645/v1`。
3. 刷新并选择代理返回的模型。
4. 使用 NeoWorker 原生任务执行链；模型返回的工具调用会经过 `neoworker_tool_host_v1`、审批、策略、超时、日志和结果边界。

需要完整 Hermes Agent Loop 时可以选择 **Hermes Agent** 或 ACP，但这类任务必须按外部 Runtime 记录，不能把它们当作 NeoWorker Tool Host 的验收结果。
