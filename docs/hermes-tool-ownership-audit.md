# Hermes 工具所有权审计

更新时间：2026-09-10，针对本机 Hermes Agent v0.18.0；开发分支为 `codex/hermes-neoworker`。

这份审计用于区分“模型入口”和“Agent Runtime”，避免把一个会执行本地操作的 Hermes 服务误当成纯模型 API。

## 结论

| 入口 | 实际行为 | NeoWorker 是否拥有本地副作用 |
| --- | --- | --- |
| Hermes API Server `8642/v1` | 创建 Hermes `AIAgent`，执行 Hermes toolset，并返回最终回答 | 否 |
| Hermes ACP `hermes acp` | 每个 ACP session 默认启用 `hermes-acp`，其中包含 `terminal`、`process`、`read_file`、`write_file`、`patch` | 否；当前只能桥接权限请求和生命周期 |
| NeoWorker 新建 Hermes ACP 任务 | 版本固定的启动包装器只启用 `mcp-neoworker`；MCP 工具回调进入 NeoWorker Executor → Tool Host → Coordinator | 已接通；真实模型探针通过，文件/Shell/审批/取消完整场景待验收 |
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

需要完整 Hermes Agent Loop 时，显式选择 ACP Hermes 任务会为新会话启动 NeoWorker 的宿主工具模式。已有原生 Hermes checkpoint 保留旧所有权，不自动切换。`Hermes Agent` HTTP Provider（8642）仍是外部工具执行入口，不属于该桥接路径。

本机真实验证：2026-09-10，包装器启动 Hermes 0.18.0 后，`/tools` 只返回 `mcp_neoworker_neoworker_probe`，没有原生文件和终端工具；真实模型通过该工具回调一次并收到 `NEOWORKER_HOST_OK`。这项证据不替代文件操作、Shell、审批与取消的完整端到端验收。

同日后续真实模型复测收到上游 HTTP 402（余额不足），在工具调用前结束；适配器现已为该类 ACP `end_turn` 响应保留结构化错误元数据，避免把供应商失败误报为任务成功。
