import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../../../../shared/types";
import { IntentRouter } from "../../strategy/IntentRouter";
import { TaskStrategyService } from "../../strategy/TaskStrategyService";
import {
  buildHermesExternalRuntimeConfig,
  resolveTaskRuntimeRoute,
} from "../hermes-runtime-routing";

function routeTask(
  title: string,
  prompt: string,
  agentConfig?: AgentConfig,
) {
  const route = IntentRouter.route(title, prompt);
  const strategy = TaskStrategyService.derive(route, agentConfig, {
    title,
    prompt,
  });
  return resolveTaskRuntimeRoute({
    title,
    prompt,
    route,
    strategy,
    agentConfig,
  });
}

describe("Hermes runtime routing", () => {
  it("routes structured flight lookups to Hermes in Auto mode", () => {
    const decision = routeTask(
      "查询航班",
      "帮我查询明天北京飞深圳的航班信息",
      { runtimePreference: "auto" },
    );

    expect(decision.resolved).toBe("hermes");
    expect(decision.allowFallback).toBe(true);
    expect(decision.reason).toBe("auto_complex_task");
    expect(decision.signals).toContain("structured-web");
  });

  it("routes multi-step Office work to Hermes", () => {
    const decision = routeTask(
      "填写 PPT 模板",
      "读取模板内容，分析现有数据，填入 AIStation 的位置和数据，然后导出新的 PPTX 文件",
      { runtimePreference: "auto" },
    );

    expect(decision.resolved).toBe("hermes");
    expect(decision.signals).toContain("office-artifact");
  });

  it("keeps a simple conversational request on the native loop", () => {
    const decision = routeTask("问候", "你好，介绍一下你自己", {
      runtimePreference: "auto",
    });

    expect(decision.resolved).toBe("native");
    expect(decision.allowFallback).toBe(false);
  });

  it("honors explicit Hermes and Native selections", () => {
    expect(
      routeTask("简单问题", "请直接回答，不需要执行操作", {
        runtimePreference: "hermes",
      }),
    ).toMatchObject({
      resolved: "hermes",
      allowFallback: false,
      reason: "user_forced_hermes",
    });

    expect(
      routeTask("复杂代码任务", "修复项目中的测试并运行验证", {
        runtimePreference: "native",
      }),
    ).toMatchObject({
      resolved: "native",
      allowFallback: false,
      reason: "user_forced_native",
    });
  });

  it("preserves an existing explicit ACP runtime", () => {
    const decision = routeTask("Use Claude", "Use Claude Code to inspect this repository", {
      externalRuntime: {
        kind: "acpx",
        agent: "claude",
        sessionMode: "persistent",
        outputMode: "json",
        permissionMode: "approve-reads",
      },
    });

    expect(decision).toMatchObject({
      resolved: "external",
      runtimeAgent: "claude",
      reason: "existing_external_runtime",
      allowFallback: false,
    });
  });

  it("maps NeoWorker permission modes to Hermes ACP permissions", () => {
    expect(buildHermesExternalRuntimeConfig("bypass_permissions")).toMatchObject({
      agent: "hermes",
      permissionMode: "approve-all",
    });
    expect(buildHermesExternalRuntimeConfig("plan")).toMatchObject({
      agent: "hermes",
      permissionMode: "deny-all",
    });
    expect(buildHermesExternalRuntimeConfig("default")).toMatchObject({
      agent: "hermes",
      permissionMode: "approve-reads",
    });
  });
});
