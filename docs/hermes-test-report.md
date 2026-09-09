# Hermes 集成验证记录

更新时间：2026-09-10。当前交付提交：`e8c67c3`（`Huifu1018/NeoWorker-huifu`）。

阶段 0 基线快照见 [hermes-baseline-report.md](./hermes-baseline-report.md)，其中记录了当前全量 type-check/Vitest 的失败数量及与 Hermes 专项结果的区分规则。

## 当前已验证范围

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| Electron、Daemon、CLI 编译 | 通过 | `npm run build:electron`、`npm run build:daemon`、`npm run build:cli` |
| Hermes ACP 传输 | 通过 | ACP 子进程 fixture：28 项测试通过，含首字节/总时限、取消和恢复边界 |
| Hermes 权限桥接 | 通过 | 会话校验、选项校验、取消和超时测试通过 |
| Hermes Provider | 通过专项验证 | `Hermes Model Proxy` 使用 8645 的模型-only 转发入口；`Hermes Agent` 的 8642 API Server 被明确标注为外部 Agent Runtime |
| Provider 辅助请求超时 | 通过 | 连接测试与模型刷新默认 15 秒超时；超时不会无限阻塞 Electron |
| Windows Shell 路由 | 通过单元验证 | PowerShell/cmd 参数、跨 chunk UTF-8/代码页编码、路径处理测试通过；npm/npx `.cmd/.bat` 包装器转换为 `node.exe + *-cli.js`，保持 `shell:false` |
| Windows Shell 环境继承 | 通过单元验证 | 自定义环境变量不再覆盖系统 PATH；PowerShell 原生命令统一使用 UTF-8 编码 |
| Windows runner 执行链 | 已加入 CI | `.github/workflows/ci.yml` 的 `windows-agent-runtime` 在 `windows-latest` 上执行 Electron 构建与 Hermes/Tool Host/Shell 专项测试，不提前打包 |
| 长任务与故障注入 | 通过专项验证 | `hermes-fault-injection.test.ts` 验证 32 项只读任务受并发上限约束、失败读取不污染缓存、副作用调用即使请求并发也保持串行 |
| 普通 CI 打包门禁 | 已收紧 | push/PR 只执行编译和执行链验证；仅手动 `workflow_dispatch` 才运行打包步骤，且矩阵打包依赖 Windows 执行链 job 通过 |
| Hermes Runtime 生产路由 | 已接入 | Executor 根据显式 `externalRuntime.agent=hermes` 创建适配器 |
| macOS ARM64 安装包 | 延后 | 按开发计划，待全部开发与跨平台实机验证完成后再打包 |
| Windows x64 安装包 | 延后 | 需要 Windows runner 和安装后 smoke；当前不把旧构建结果当作本轮交付证据 |
| 安装包 Runtime 内容 | 已加入最终 smoke 门禁 | `smoke-desktop-artifacts.mjs` 在 macOS/Windows 安装后检查 `app.asar` 内 Hermes ACP、Tool Host、Coordinator 和 Sandbox 模块 |
| 工具结果边界 | 通过 | 模型 payload 上限 200,000 字符，完整结构化结果仍保留 |
| Tool Host 日志持久化 | 通过专项验证 | `log` 事件保留 `tool_host_lifecycle`；重启查询按 taskId/toolCallId 直接命中最新记录，不受 200 条历史窗口影响；无终态时继续拒绝副作用重放 |
| 只读工具重复调用 | 通过专项验证 | 同一批次内对规范化输入的 `read_parallel + idempotent` 调用复用成功结果；失败、写入和 Shell 调用不缓存 |
| 工具并发边界 | 通过专项验证 | 只有明确 `readOnly` 的幂等只读工具进入并行批次；写文件、Shell、安装依赖及其他副作用调用保持串行 |
| 取消后的恢复边界 | 通过专项验证 | 已取消或终止的工具不会再进入工作区路径恢复，避免取消变慢或重复触发副作用 |
| Hermes session 暂停恢复 | 通过专项测试 | executor pause/resume 已接通；checkpoint 保留、session 恢复和未知副作用不重放；桌面暂停回归测试通过 |
| 本机 Hermes ACP | 通过 | Hermes Agent v0.18.0：`hermes acp --check`、`initialize` 与 `session/new` 均成功 |
| 本机 Hermes Model Proxy | 环境未就绪 | `hermes proxy status` 显示 Nous Portal/xAI OAuth 均未登录；8645 当前返回 502，待登录后执行真实多步文件/Shell 验证 |
| NeoWorker Tool Host 协议 | 通过专项测试 | `neoworker_tool_host_v1` 固定 requestId/toolCallId/schemaVersion/status/result/error；模型分派的原生工具调用统一经过审批、沙箱、超时、日志和结果边界；重复 toolCallId 不重复执行副作用 |

## 安装包

本轮开发尚未生成新的安装包。按照开发计划，macOS ARM64 和 Windows x64 包会在运行时、Shell、恢复、性能和跨平台实机验证完成后统一构建，并核验包内 Runtime 与提交一致。

## 已知边界

- Hermes ACP 需要本机可执行的 `hermes acp`；缺失时会返回结构化的 `HERMES_UNAVAILABLE`。
- 普通 NeoWorker 任务仍使用原生 SessionRuntime/TurnKernel；只有显式选择 Hermes 外部 Runtime 的任务才进入 ACP。
- ACP 权限回调负责审批协调，不等同于操作系统沙箱；ACP-native 工具托管尚未完全迁移到 NeoWorker Tool Host。
- Hermes API Server（8642）是完整的 Hermes Agent Runtime，会执行 Hermes-native 工具；该路径不满足 NeoWorker 本地副作用所有权要求，现已在 Provider 描述和文档中明确标注。
- Hermes Model Proxy（8645）只是凭据转发器，不运行 Agent Loop。使用该入口时，NeoWorker 原生 SessionRuntime 收到模型返回的工具调用，并通过版本化 Tool Host 边界执行，因此文件系统、Shell、审批、沙箱和任务日志由 NeoWorker 负责。
- 全量 Vitest 当前为 847 个测试文件：787 通过、59 失败、1 跳过；8480 个测试：8312 通过、163 失败、3 跳过、2 todo。失败主要是既有 Renderer 文案/快照、数据库初始化、外部 SecureSettings 和环境迁移测试；本轮执行链专项未出现新增回归。

## 下一步

1. 在真实 Hermes Model Proxy 环境执行文件操作、Shell、依赖安装和多步任务，并记录每个 Tool Host 生命周期事件。
2. 在真实 Hermes Model Proxy 环境建立文件/Shell/依赖安装的多步基线。
3. 完成跨平台实机验证后再生成安装包。
