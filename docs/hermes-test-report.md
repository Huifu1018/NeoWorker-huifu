# Hermes 集成验证记录

更新时间：2026-09-10。当前开发分支：`codex/hermes-neoworker`；交付远端为 `Huifu1018/NeoWorker-huifu`。本轮桥接改动已通过本地专项验证，随提交 `ba22ef4` 推送。

阶段 0 基线快照见 [hermes-baseline-report.md](./hermes-baseline-report.md)，其中记录了当前全量 type-check/Vitest 的失败数量及与 Hermes 专项结果的区分规则。

## 当前已验证范围

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| Electron、Daemon、CLI 编译 | 通过 | `npm run build:electron`、`npm run build:daemon`、`npm run build:cli` |
| Hermes ACP 传输 | 通过 | ACP 子进程 fixture：31 项测试通过，含首字节/总时限、取消、外部 AbortSignal 和恢复边界 |
| Hermes 权限桥接 | 通过 | 会话校验、选项校验、取消和超时测试通过 |
| Hermes Provider | 通过专项验证 | `Hermes Model Proxy` 使用 8645 的模型-only 转发入口；`Hermes Agent` 的 8642 API Server 被明确标注为外部 Agent Runtime |
| OpenAI 兼容流式响应边界 | 通过专项验证 | 流式响应在输出部分内容后提前断开时返回 `STREAM_INCOMPLETE` 且标记为可重试，避免把截断文本或不完整工具参数当成成功 |
| Provider 辅助请求超时 | 通过 | 连接测试与模型刷新默认 15 秒超时；超时不会无限阻塞 Electron |
| Windows Shell 路由 | 通过单元验证 | PowerShell/cmd 参数、跨 chunk UTF-8/代码页编码、路径处理测试通过；npm/npx `.cmd/.bat` 包装器转换为 `node.exe + *-cli.js`，保持 `shell:false` |
| Windows Shell 环境继承 | 通过单元验证 | 自定义环境变量不再覆盖系统 PATH；PowerShell 原生命令统一使用 UTF-8 编码 |
| Windows Hermes 启动路径 | 通过单元验证 | `hermes-host-launcher.test.ts` 覆盖显式 Python、Hermes shebang 和带引号 PATH 目录，避免含空格的虚拟环境路径回退到错误解释器 |
| Windows runner 执行链 | 已加入 CI | `.github/workflows/ci.yml` 的 `windows-agent-runtime` 在 `windows-latest` 上执行 Electron 构建与 Hermes/Tool Host/Shell 专项测试，不提前打包 |
| 长任务与故障注入 | 通过专项验证 | `hermes-fault-injection.test.ts` 验证 32 项只读任务受并发上限约束、失败读取不污染缓存、副作用调用即使请求并发也保持串行 |
| 普通 CI 打包门禁 | 已收紧 | push/PR 只执行编译和执行链验证；仅手动 `workflow_dispatch` 才运行打包步骤，且矩阵打包依赖 Windows 执行链 job 通过 |
| CI 类型检查门禁 | 已拆分 | Electron、Daemon、CLI 类型检查作为严格门禁；Renderer 全量检查继续输出完整报告，但既有错误不阻断运行时交付 |
| Hermes Runtime 生产路由 | 已接入 | Executor 根据显式 `externalRuntime.agent=hermes` 创建适配器 |
| Hermes ACP 宿主工具桥接 | 已接入并通过探针 | 新建 ACP 任务使用固定 0.18.0 包装器，仅启用 `mcp-neoworker`；任务级 MCP endpoint 调用 Executor Tool Host；真实模型探针只执行一次并返回 `NEOWORKER_HOST_OK` |
| Hermes 宿主多步路由 | 通过 NeoWorker 侧真实工具链回归 | `hermes-host-owned-toolchain.test.ts` 使用 ACP fixture 依次调用 `write_file` 和 `run_command`；两次调用都经过真实 `ToolRegistry → FileTools/ShellTools → Coordinator → Tool Host`，验证审批、沙箱、文件产物、Shell 输出和生命周期日志；真实模型多步验收仍待供应商余额恢复 |
| Hermes 上游错误识别 | 已补齐专项测试 | ACP `end_turn` 响应中的 `field_meta.neoworker.runtimeError` 会被适配器转为失败；最新真实复测为 HTTP 402 余额不足，未进入工具执行，不计为成功 |
| MCP 执行边界 | 通过专项验证 | bearer 认证、任务工具白名单、请求大小限制、超时取消、客户端断开、重连 ID 隔离、异常结构化工具结果、200,000 字符模型输出上限 |
| macOS ARM64 安装包 | 延后 | 按开发计划，待全部开发与跨平台实机验证完成后再打包 |
| Windows x64 安装包 | 延后 | 需要 Windows runner 和安装后 smoke；当前不把旧构建结果当作本轮交付证据 |
| 安装包 Runtime 内容 | 已加入最终 smoke 门禁 | `smoke-desktop-artifacts.mjs` 在 macOS/Windows 安装后检查 `app.asar` 内 Hermes ACP、Tool Host、Coordinator 和 Sandbox 模块 |
| 工具结果边界 | 通过 | 模型 payload 上限 200,000 字符，完整结构化结果仍保留 |
| Tool Host 日志持久化 | 通过专项验证 | `log` 事件保留 `tool_host_lifecycle`；重启查询按 taskId/toolCallId 直接命中最新记录，不受 200 条历史窗口影响；无终态时继续拒绝副作用重放 |
| 只读工具重复调用 | 通过专项验证 | 同一批次内对规范化输入的 `read_parallel + idempotent` 调用复用成功结果；失败、写入和 Shell 调用不缓存 |
| 工具并发边界 | 通过专项验证 | 只有明确 `readOnly` 的幂等只读工具进入并行批次；写文件、Shell、安装依赖及其他副作用调用保持串行 |
| 取消后的恢复边界 | 通过专项验证 | 已取消或终止的工具不会再进入工作区路径恢复，避免取消变慢或重复触发副作用 |
| 调度取消边界 | 通过专项验证 | 并行队列中未获得执行资格的调用不会触发派发事件、工具计数或“已启动”日志 |
| Windows 实机执行场景 | 已加入 CI | Windows runner 直接验证工作目录、Unicode/参数、非零退出、离线 npm、本进程树超时与后续恢复命令 |
| Hermes session 暂停恢复 | 通过专项测试 | executor pause/resume 和外部 AbortSignal 已接通；活动 Tool Host 调用会立即挂起，checkpoint 保留、session 恢复和未知副作用不重放；桌面暂停回归测试通过 |
| 本机 Hermes ACP | 通过 | Hermes Agent v0.18.0：`hermes acp --check`、`initialize` 与 `session/new` 均成功 |
| 本机 Hermes Model Proxy | 环境未就绪 | `hermes proxy status` 显示 Nous Portal/xAI OAuth 均未登录；8645 当前返回 502，待登录后执行真实多步文件/Shell 验证 |
| NeoWorker Tool Host 协议 | 通过专项测试 | `neoworker_tool_host_v1` 固定 requestId/toolCallId/schemaVersion/status/result/error；模型分派的原生工具调用统一经过审批、沙箱、超时、日志和结果边界；重复 toolCallId 不重复执行副作用 |
| 评测与时间线门禁 | 通过 | 在允许空评测数据库的 CI 参数下，`reliability-regressions` 评测和 `timeline-reliability-gate` 均通过；当前环境没有可执行评测样例 |

## 安装包

本轮开发尚未生成新的安装包。按照开发计划，macOS ARM64 和 Windows x64 包会在运行时、Shell、恢复、性能和跨平台实机验证完成后统一构建，并核验包内 Runtime 与提交一致。

## 已知边界

- 新建 Hermes ACP 宿主工具任务需要安装 `hermes-agent==0.18.0` 的 Python 环境；包装器不会修改已安装 Hermes，其他版本在验证前拒绝启动。可通过 `NEOWORKER_HERMES_PYTHON` 指定解释器。
- 普通 NeoWorker 任务仍使用原生 SessionRuntime/TurnKernel；只有显式选择 Hermes 外部 Runtime 的任务才进入 ACP。
- 新建 ACP 任务已接入 NeoWorker Tool Host；旧 checkpoint 的原生工具所有权保持不变。确定性回归已经证明 NeoWorker 侧真实文件/Shell/审批/沙箱/日志链路，真实模型驱动的文件/Shell/审批/取消完整场景仍待验证，阶段 2 尚未关闭。
- Hermes API Server（8642）是完整的 Hermes Agent Runtime，会执行 Hermes-native 工具；该路径不满足 NeoWorker 本地副作用所有权要求，现已在 Provider 描述和文档中明确标注。
- Hermes Model Proxy（8645）只是凭据转发器，不运行 Agent Loop。使用该入口时，NeoWorker 原生 SessionRuntime 收到模型返回的工具调用，并通过版本化 Tool Host 边界执行，因此文件系统、Shell、审批、沙箱和任务日志由 NeoWorker 负责。
- 全量 Vitest（2026-09-10 15:02）为 852 个测试文件：793 通过、57 失败、2 跳过；8518 个测试：8350 通过、159 失败、7 跳过、2 todo。失败主要是既有 Renderer 文案/快照、数据库初始化、外部 SecureSettings 和环境迁移测试；本轮执行链专项未出现新增回归。`npm run lint` 为 0 错误、510 个既有警告。

## 下一步

1. 在真实 Hermes ACP 宿主工具模式执行文件操作、Shell、依赖安装和多步任务，并记录每个 Tool Host 生命周期事件；确定性链路回归见 `src/electron/agent/runtime/__tests__/hermes-host-owned-toolchain.test.ts`。
2. 验证审批拒绝、取消与恢复、旧 checkpoint 所有权隔离，以及 Windows Python/Hermes 启动路径。
3. 完成跨平台实机验证后再生成安装包。
