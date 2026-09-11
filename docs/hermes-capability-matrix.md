# Hermes Harness Capability Matrix

更新时间：2026-09-11。本文描述 NeoWorker 当前的 Hermes ACP 宿主模式，不代表 Hermes 本身的全部能力。

## 设计原则

NeoWorker 采用“**Hermes 负责 Agent Loop，NeoWorker 负责 Tool Host 和副作用治理**”的边界：

- Hermes 负责理解任务、拆解步骤、选择工具、组织多轮执行和生成最终回答。
- NeoWorker 负责工具目录、权限审批、沙箱、超时、幂等、任务状态、checkpoint、时间线和最终交付。
- Hermes 的原生文件、Shell、进程和补丁工具在宿主模式中被关闭，避免同一个任务出现两套副作用所有权。
- 旧的 Hermes-native checkpoint 保留原有所有权，不自动迁移到 NeoWorker 宿主模式。

## 当前能力映射

| 能力 | 宿主模式所有者 | 当前状态 | 说明 |
| --- | --- | --- | --- |
| Agent Loop / 任务规划 | Hermes ACP | 已接入 | 通过 `HermesRuntimeAdapter` 管理 ACP session、prompt、follow-up、取消、暂停和恢复。 |
| 文件读取与写入 | NeoWorker Tool Host | 已接入 | Hermes 通过任务级 loopback MCP 调用 NeoWorker 工具，结果回到 Hermes。 |
| Shell / 进程执行 | NeoWorker Tool Host | 已接入 | 继续使用 NeoWorker 的 Shell executor、超时、输出边界和进程回收。 |
| Office 文件操作 | NeoWorker Tool Host | 已接入 | 文档、表格和演示文稿工具仍经过 NeoWorker 的工具策略和 artifact 交付链。 |
| Web / 外部服务 | NeoWorker Tool Host | 已接入 | 访问、凭据、审批和结果记录仍由 NeoWorker 的现有工具链负责。 |
| 权限审批 | NeoWorker Daemon | 已接入 | Hermes ACP permission request 与 NeoWorker approval service 对接；Tool Host 仍执行最终策略判断。 |
| 沙箱与工作区边界 | NeoWorker | 已接入 | 工具只获得当前任务允许的工作区和权限快照。 |
| 幂等与副作用恢复 | NeoWorker | 已接入 | `toolCallId`、checkpoint 和未知副作用确认阻止自动重复执行。 |
| 任务状态与时间线 | NeoWorker | 已接入 | Hermes active、fallback、failed 和 tool progress 都投影为可见的 NeoWorker 时间线状态。 |
| 任务上下文与技能提示 | NeoWorker | 已接入 | 以有界 prompt 层注入工作区、任务、上下文和技能信息；follow-up 只发送新增指令。 |
| Hermes 原生 context / memory / project plugins / kanban | 无 | 宿主模式关闭 | 防止 Hermes 的隐式上下文或工具绕过 NeoWorker 的任务边界。 |
| 旧 Hermes-native session | Hermes | 兼容保留 | 仅用于已有 `toolOwnership=hermes` 或缺失 ownership 标记的历史 checkpoint。 |

## 运行时选择

| 选择 | 行为 | 失败策略 |
| --- | --- | --- |
| `Auto` | 复杂执行、结构化网页查询、研究、代码/操作和多步 Office 任务优先 Hermes；简单对话留在 NeoWorker native loop。 | Hermes 在任何宿主副作用开始前不可用时，可记录 fallback 并回到 native loop。 |
| `Hermes` | 强制使用 Hermes ACP Harness 和 NeoWorker Tool Host。 | ACP 启动或运行失败时 fail closed，不降级。 |
| `Native` | 强制使用 NeoWorker 原生 SessionRuntime/TurnKernel。 | 不启动 Hermes。 |

## 验收门槛

宿主模式的后续改动必须继续满足以下条件：

1. `tools/list` 只暴露当前任务允许的 NeoWorker 工具，不出现 Hermes 原生文件或终端工具。
2. 每个副作用调用都能按 `taskId + toolCallId` 找到 request、approval、running 和 terminal lifecycle。
3. 取消、断线或进程崩溃后，未知副作用必须要求显式确认，不能自动重放。
4. Auto、Hermes、Native 三种选择的路由和失败策略都有确定性测试。
5. 时间线能明确显示当前 runtime 是 Hermes active、native fallback 还是 forced failure。
6. 不把 Hermes provider/API Server 的成功回答误判为 NeoWorker 已经拥有本地副作用。

对应测试入口：

```sh
npm test -- --run src/electron/agent/runtime/__tests__/hermes-runtime-routing.test.ts
npm test -- --run src/electron/agent/__tests__/executor-entrypoints.test.ts
npm test -- --run src/renderer/components/__tests__/timeline-tool-payload-details.test.ts
python3 scripts/qa/test_hermes_host_launcher.py
```
