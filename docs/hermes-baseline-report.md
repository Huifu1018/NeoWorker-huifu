# NeoWorker Hermes 阶段 0 基线快照

更新时间：2026-09-09。工作区：`/Users/wangchao/Documents/ChatGPT/NeoWorker`。远端交付仓库：`Huifu1018/NeoWorker-huifu`。

这份快照记录当前 NeoWorker 工作树的可复现基线。它用于比较后续修复效果，不把既有 Renderer、快照和工具环境问题误归因于 Hermes 集成。

## 环境与命令

| 项目 | 值 |
| --- | --- |
| Git 提交 | `6c53139` |
| Node.js | `v24.13.1` |
| npm | `11.8.0` |
| Hermes | `v0.18.0`（本机已安装） |
| TypeScript 基线 | `npm run type-check` |
| Vitest 基线 | `npm test` |

## 当前结果

- `npm run type-check`：退出码 2，共记录 305 个 `TS` 错误。主要集中在 `UsageInsightsPanel.tsx` 的可空数据、Renderer 类型漂移、缺失背景 SVG、UI density 导出和少量测试类型断言。
- `npm test`：843 个测试文件中 783 通过、59 失败、1 个跳过；8425 个测试中 8257 通过、163 失败、3 个跳过、2 个 todo。执行耗时约 61 秒（含测试环境初始化）。
- Hermes/NeoWorker 专项回归：6 个测试文件、106 项测试通过，覆盖 ACP 通信与首字节/总时限、权限桥接、暂停恢复、Provider 辅助请求超时、Windows Shell 和 `neoworker_tool_host_v1`。
- Electron、Daemon、CLI 编译均通过；macOS ARM64 unsigned/ad hoc DMG smoke 通过；Windows x64 GitHub Actions 安装器、密钥扫描、安装 smoke 和 artifact 上传通过。

## 已识别的基线问题分类

1. Renderer 既有类型和快照失败需要单独清理，不能用全量 Vitest 结果判断 Hermes Runtime 成败。
2. 本地 Hermes ACP 可执行文件可用，但 Hermes ACP 0.18.0 的内置 `hermes-acp` toolset 仍直接执行其原生文件和终端工具；ACP 协议没有把这些调用回调给 NeoWorker 的字段。
3. 因此当前推荐的宿主权限路径是 Hermes Model Proxy（8645）：Hermes 只负责凭据转发和模型入口，NeoWorker `SessionRuntime`、`ToolRegistry`、审批、Numbat 沙箱、Shell 生命周期和任务日志负责本地副作用。Hermes API Server（8642）和 ACP 属于外部 Agent Runtime，不满足这一所有权结论。

## 比较规则

后续阶段应分别报告：Hermes 专项回归、全量基线失败数量、Windows runner 结果、macOS 包 smoke，以及一次真实多步文件/Shell 任务的工具调用日志。只有最后一项也能证明每个工具调用经过 NeoWorker Tool Host 时，才能关闭计划中的阶段 2 门禁。
