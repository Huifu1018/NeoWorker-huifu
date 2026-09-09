# Hermes 集成验证记录

更新时间：2026-09-09。

## 当前已验证范围

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| Electron、Daemon、CLI 编译 | 通过 | `npm run build:electron`、`npm run build:daemon`、`npm run build:cli` |
| Hermes ACP 传输 | 通过 | ACP 子进程 fixture：24 项测试通过，含首字节超时 |
| Hermes 权限桥接 | 通过 | 会话校验、选项校验、取消和超时测试通过 |
| Hermes Provider | 通过 | Provider catalog 与 OpenAI 兼容入口测试通过 |
| Windows Shell 路由 | 通过单元验证 | PowerShell/cmd 参数、UTF-8 编码、路径处理测试通过 |
| Hermes Runtime 生产路由 | 已接入 | Executor 根据显式 `externalRuntime.agent=hermes` 创建适配器 |
| macOS ARM64 安装包 | 通过 | DMG smoke、ad hoc 签名和 app.asar 内容检查通过 |
| Windows x64 安装包 | 通过 | GitHub Actions run 34319024080：构建、密钥检查、安装后 smoke 和构件上传全部通过 |
| 工具结果边界 | 通过 | 模型 payload 上限 200,000 字符，完整结构化结果仍保留 |
| Hermes 暂停恢复 | 通过专项测试 | checkpoint 保留、session 恢复和未知副作用不重放 |

## 安装包

当前测试包：

- `release/NeoWorker-0.1.8-3-arm64.dmg`
- `release/NeoWorker-0.1.8-3-arm64-mac.zip`

该包为 unsigned/ad hoc 签名测试包。OfficeCLI 下载源不可用时使用了仓库支持的 `NEOWORKER_SKIP_OFFICECLI=1`，不影响 Hermes Runtime 和 Electron 主程序验证。

## 已知边界

- Hermes ACP 需要本机可执行的 `hermes acp`；缺失时会返回结构化的 `HERMES_UNAVAILABLE`。
- 普通 NeoWorker 任务仍使用原生 SessionRuntime/TurnKernel；只有显式选择 Hermes 外部 Runtime 的任务才进入 ACP。
- ACP 权限回调负责审批协调，不等同于操作系统沙箱；实际工具权限仍受 NeoWorker 工作区策略约束。
- 全量 Vitest 仍有大量既有 Renderer/快照失败，需要建立基线后逐项清理；Hermes 专项测试目前通过。

## 下一步

1. 在真实 Hermes Agent 环境执行文件操作、Shell、依赖安装和多步任务。
2. 建立长任务、失败重试、取消恢复和性能基线。
