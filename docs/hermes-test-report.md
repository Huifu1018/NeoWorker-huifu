# Hermes 集成验证记录

更新时间：2026-09-09。

阶段 0 基线快照见 [hermes-baseline-report.md](./hermes-baseline-report.md)，其中记录了当前全量 type-check/Vitest 的失败数量及与 Hermes 专项结果的区分规则。

## 当前已验证范围

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| Electron、Daemon、CLI 编译 | 通过 | `npm run build:electron`、`npm run build:daemon`、`npm run build:cli` |
| Hermes ACP 传输 | 通过 | ACP 子进程 fixture：28 项测试通过，含首字节/总时限、取消和恢复边界 |
| Hermes 权限桥接 | 通过 | 会话校验、选项校验、取消和超时测试通过 |
| Hermes Provider | 通过专项验证 | `Hermes Model Proxy` 使用 8645 的模型-only 转发入口；`Hermes Agent` 的 8642 API Server 被明确标注为外部 Agent Runtime |
| Provider 辅助请求超时 | 通过 | 连接测试与模型刷新默认 15 秒超时；超时不会无限阻塞 Electron |
| Windows Shell 路由 | 通过单元验证 | PowerShell/cmd 参数、UTF-8 编码、路径处理测试通过 |
| Windows Shell 环境继承 | 通过单元验证 | 自定义环境变量不再覆盖系统 PATH；PowerShell 原生命令统一使用 UTF-8 编码 |
| Hermes Runtime 生产路由 | 已接入 | Executor 根据显式 `externalRuntime.agent=hermes` 创建适配器 |
| macOS ARM64 安装包 | 通过 | DMG smoke、ad hoc 签名和 app.asar 内容检查通过 |
| Windows x64 安装包 | 通过 | GitHub Actions run 34332716271（提交 fe8471d）：构建、密钥检查、安装后 smoke 和构件上传全部通过；artifact 约 240 MB |
| 工具结果边界 | 通过 | 模型 payload 上限 200,000 字符，完整结构化结果仍保留 |
| Hermes session 暂停恢复 | 通过专项测试 | executor pause/resume 已接通；checkpoint 保留、session 恢复和未知副作用不重放；桌面暂停回归测试通过 |
| 本机 Hermes ACP | 通过 | Hermes Agent v0.18.0：`hermes acp --check`、`initialize` 与 `session/new` 均成功 |
| NeoWorker Tool Host 协议 | 通过专项测试 | `neoworker_tool_host_v1` 固定 requestId/toolCallId/schemaVersion/status/result/error；模型分派的原生工具调用统一经过审批、沙箱、超时、日志和结果边界；重复 toolCallId 不重复执行副作用 |

## 安装包

当前测试包：

- `release/NeoWorker-0.1.8-3-arm64.dmg`
- `release/NeoWorker-0.1.8-3-arm64-mac.zip`

以上 macOS 包于 2026-09-09 17:11 重新生成，包含提交 fe8471d 的 NeoWorker Tool Host 协议去重、Provider 辅助请求/响应解析超时修复和 Windows Shell 修复，并再次通过 DMG smoke。对应 Windows x64 安装包由 GitHub Actions run 34332716271 构建并通过密钥扫描、安装 smoke，可从该 run 的 `NeoWorker-0.1.8-3-windows-x64` artifact 下载。

该包为 unsigned/ad hoc 签名测试包。OfficeCLI 下载源不可用时使用了仓库支持的 `NEOWORKER_SKIP_OFFICECLI=1`，不影响 Hermes Runtime 和 Electron 主程序验证。

## 已知边界

- Hermes ACP 需要本机可执行的 `hermes acp`；缺失时会返回结构化的 `HERMES_UNAVAILABLE`。
- 普通 NeoWorker 任务仍使用原生 SessionRuntime/TurnKernel；只有显式选择 Hermes 外部 Runtime 的任务才进入 ACP。
- ACP 权限回调负责审批协调，不等同于操作系统沙箱；ACP-native 工具托管尚未完全迁移到 NeoWorker Tool Host。
- Hermes API Server（8642）是完整的 Hermes Agent Runtime，会执行 Hermes-native 工具；该路径不满足 NeoWorker 本地副作用所有权要求，现已在 Provider 描述和文档中明确标注。
- Hermes Model Proxy（8645）只是凭据转发器，不运行 Agent Loop。使用该入口时，NeoWorker 原生 SessionRuntime 收到模型返回的工具调用，并通过版本化 Tool Host 边界执行，因此文件系统、Shell、审批、沙箱和任务日志由 NeoWorker 负责。
- 全量 Vitest 仍有大量既有 Renderer/快照失败，需要建立基线后逐项清理；Hermes 专项测试目前通过。

## 下一步

1. 在真实 Hermes Model Proxy 环境执行文件操作、Shell、依赖安装和多步任务，并把 Hermes API Server/ACP 的外部 Runtime 结果单独记录。
2. 建立长任务、失败重试、取消恢复和性能基线。
