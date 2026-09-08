# Hermes 集成验证记录

更新时间：2026-09-09。状态：集成未完成，不能作为完整 Runtime 替换的验收通过报告。

## 已有证据与验证范围

| 项目 | 证据 | 未证明的范围 |
| --- | --- | --- |
| Electron 编译 | `npm run build:electron` 通过 | 不代表安装后的真实任务通过 |
| 本机 Hermes ACP | `hermes acp --check` 通过；此前实测 initialize/session/new | 未完成真实模型的多步工具任务 |
| ACP 传输与会话 | Node fixture 子进程测试：恢复、取消、超时、异常退出 | fixture 不是 Hermes Agent Loop |
| 审批适配 | `HermesPermissionBridge` 接入 RuntimeAdapter，校验会话与选项，取消/超时拒绝 | 尚未连接 NeoWorker UI/任务审批服务；并非每个 Hermes 工具都会请求 ACP 审批 |
| OpenAI 兼容流式实现 | mocked SSE 文本、工具参数分片、断流错误测试 | 未验证实际 Hermes HTTP 服务可作为无内部工具的模型代理 |
| Shell | 现有专项测试含 Windows 参数/编码分支 | 尚未在真实 Windows 运行 Shell、路径、进程树验收 |
| macOS ARM64 包 | 此前 DMG smoke 与 asar 文件清单通过 | 00:33 的包不包含本轮新增审批桥接；包含适配器文件不代表生产任务启用 Hermes |
| Windows x64 包 | 本机构建在 better-sqlite3 跨平台重编译处失败 | 未产出本次新版 Windows 包；已有 CI 配置不代表已执行 |

## 本轮测试

```sh
npx vitest run \
  src/electron/agent/runtime/__tests__/hermes-permission-bridge.test.ts \
  src/electron/agent/runtime/__tests__/hermes-acp-client.test.ts
npm run build:electron
```

此前 6 文件/161 项通过是专项单元与 fixture 测试，不能证明六项真实应用场景验收通过。完整测试曾报告 56 文件失败、121 项失败；没有完成基线对照，不能将全部失败断言为既有问题。

## 当前实现边界

普通任务仍使用 NeoWorker 的 SessionRuntime/TurnKernel。Hermes Provider 配置条目不会把它替换成 Hermes Agent Loop，也不会自动安装或启动 Hermes。

Hermes ACP 适配器已支持独立进程会话和审批回调。新的 `onPermissionRequest` 返回服务端提供的 optionId 或 null；会话不匹配、无 handler、异常、取消、超时均不批准。通用 `onRequest` 不再接管审批请求，避免绕过这层校验。

ACP 权限回调不是沙箱：它仅处理 Hermes 发出的权限请求，不能假定覆盖所有读写、Shell、插件或 hook。继续接入需要固定 Hermes 版本，配置并验证执行后端和工作区范围，再对接 NeoWorker 的审批服务、事件存储和任务生命周期。源码适配是可继续开发的路线，无需将其描述为必须等待上游的阻塞。

## 未完成的交付

- Hermes Agent Loop 生产路由、模型配置与随包运行环境。
- 实际审批 UI、任务日志、暂停/恢复与执行后端接线。
- 文件、Shell、依赖安装、多步任务、失败恢复、取消继续的真实场景测试。
- 性能基线、长任务压力和完整故障注入验证。
- 包含上述实现的新 macOS 包、Windows x64 包及安装后验收。

旧测试包位于 `release/NeoWorker-0.1.8-3-arm64.dmg` 和 `release/NeoWorker-0.1.8-3-arm64-mac.zip`，不能作为本轮新增实现的交付物。
