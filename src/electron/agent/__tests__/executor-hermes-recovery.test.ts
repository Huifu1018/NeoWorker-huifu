import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { TaskExecutor } from "../executor";
import { HermesAcpClient, HermesAcpError } from "../runtime/hermes-acp-client";
import type { HermesRuntimeAdapter } from "../runtime/hermes-runtime-adapter";

const cwd = __dirname;
const fixture = path.join(cwd, "../runtime/__tests__/fixtures/hermes-acp-fixture.cjs");
const adapters: HermesRuntimeAdapter[] = [];
const executorsToCleanup: Any[] = [];
afterEach(async () => {
  await Promise.all(
    executorsToCleanup
      .splice(0)
      .map((instance) =>
        TaskExecutor.prototype.closeExternalRuntime.call(
          instance,
          "test_cleanup",
        ),
      ),
  );
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
  vi.restoreAllMocks();
});

function executor(events: Array<{ payload: unknown }>) {
  const instance = Object.create(TaskExecutor.prototype) as Any;
  instance.task = { id: "recover-hermes" };
  instance.workspace = { path: cwd };
  instance.emitEvent = vi.fn();
  instance.enforceToolBudget = vi.fn();
  instance.totalToolCallCount = 0;
  instance.daemon = {
    getTaskEvents: vi.fn(() => events.slice(-1)),
    logEvent: vi.fn((_task, type, payload) => {
      if (type === "hermes_runtime_checkpoint") events.push({ payload });
    }),
    createHermesPermissionHandler: () => async () => null,
  };
  executorsToCleanup.push(instance);
  return instance as TaskExecutor;
}

function fixtureTransport() {
  const start = HermesAcpClient.prototype.start;
  vi.spyOn(HermesAcpClient.prototype, "start").mockImplementation(function (options) {
    return start.call(this, { ...options, command: process.execPath, args: [fixture] });
  });
}

function adapter(instance: TaskExecutor) {
  const result = instance.createHermesRuntimeAdapter();
  adapters.push(result);
  return result;
}

describe("Executor Hermes recovery", () => {
  it("applies a dynamically invoked Skill and returns its hidden guidance to Hermes", () => {
    const instance = executor([]) as Any;
    const application = {
      skillId: "documents",
      skillName: "Documents",
      trigger: "model",
      args: "report.docx",
      parameters: { output: "docx" },
      content: "Use the document workflow and verify the final file.",
      reason: "Applied as additive skill context.",
      appliedAt: Date.now(),
      contextDirectives: {
        allowedTools: ["read_file", "write_file"],
        artifactDirectories: ["/tmp/artifacts"],
      },
    };
    instance.toolRegistry = {
      takeResolvedSkillInvocation: vi.fn(() => application),
    };
    instance.appliedSkills = [];

    const enriched = (TaskExecutor.prototype as Any).enrichHermesSkillToolResult.call(
      instance,
      "Skill",
      { skill: "documents", args: "report.docx" },
      {
        success: true,
        skill: "documents",
        skill_name: "Documents",
        skill_invocation_id: "skill-recover-hermes-1",
      },
    );

    expect(enriched).toMatchObject({
      success: true,
      neoworker_skill_applied: true,
      neoworker_skill_directives: application.contextDirectives,
    });
    expect(enriched.neoworker_skill_context).toContain(
      "Use the document workflow and verify the final file.",
    );
    expect(instance.appliedSkills).toHaveLength(1);
    expect(instance.appliedSkills[0]).toMatchObject({
      skillId: "documents",
      skillName: "Documents",
      content: application.content,
    });
  });

  it("routes a new Hermes session's MCP tool call through the executor Tool Host", async () => {
    fixtureTransport();
    const instance = executor([]) as Any;
    instance.getAvailableTools = () => [{ name: "run_command", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } }];
    instance.getToolTimeoutMs = () => 1000;
    instance.executeToolWithHeartbeat = vi.fn(async (_name, _input, _timeout, toolCallId) => ({
      toolHostResponse: {
        schemaVersion: "neoworker_tool_host_v1", requestId: "host-response", toolCallId,
        status: "success", result: { stdout: "host\n", exitCode: 0 },
      },
    }));
    const runtime = adapter(instance);
    const result = await runtime.prompt("host-tool");
    expect(instance.executeToolWithHeartbeat).toHaveBeenCalledWith(
      "run_command", { command: "echo host" }, 1000, expect.stringContaining("hermes-mcp:"), expect.any(AbortSignal),
      expect.objectContaining({
        schema: "neoworker_hermes_acp_v1",
        sessionId: "fixture-session",
      }),
    );
    expect(JSON.parse(result.assistantText)).toMatchObject({ result: { isError: false, content: [{ text: '{"stdout":"host\\n","exitCode":0}' }] } });
    expect(runtime.getCheckpoint()?.toolOwnership).toBe("neoworker");
    const dispatchCheckpoint = instance.executeToolWithHeartbeat.mock.calls[0]?.[5];
    expect(dispatchCheckpoint).toMatchObject({
      schema: "neoworker_hermes_acp_v1",
      sessionId: "fixture-session",
      toolProgress: {
        activeToolCallIds: [expect.stringContaining("hermes-mcp:")],
      },
    });
    expect(runtime.getCheckpoint()?.toolProgress?.completedToolCallIds).toEqual([
      expect.stringContaining("hermes-mcp:"),
    ]);
    expect(instance.enforceToolBudget).toHaveBeenCalledWith("run_command");
    expect(instance.emitEvent).toHaveBeenCalledWith("tool_result", expect.objectContaining({ tool: "run_command", runtime: "hermes" }));
    expect(instance.emitEvent).toHaveBeenCalledWith(
      "llm_streaming",
      expect.objectContaining({ runtime: "hermes", streaming: true }),
    );
    expect(
      instance.daemon.logEvent.mock.calls.some(
        ([, type, payload]: [string, string, Any]) =>
          type === "hermes_runtime_update" &&
          payload?.sessionUpdate === "agent_message_chunk",
      ),
    ).toBe(false);
    expect(instance.daemon.logEvent.mock.calls.some(([, type]) => type === "hermes_runtime_transport")).toBe(true);
  });

  it("keeps Hermes intermediate narration out of the final assistant text", async () => {
    fixtureTransport();
    const instance = executor([]) as Any;
    instance.getAvailableTools = () => [{
      name: "run_command",
      description: "Run a command",
      input_schema: { type: "object", properties: { command: { type: "string" } } },
    }];
    instance.getToolTimeoutMs = () => 1000;
    instance.executeToolWithHeartbeat = vi.fn(async (_name, _input, _timeout, toolCallId) => ({
      toolHostResponse: {
        schemaVersion: "neoworker_tool_host_v1",
        requestId: "host-response",
        toolCallId,
        status: "success",
        result: { stdout: "host\n", exitCode: 0 },
      },
    }));

    const result = await adapter(instance).prompt("narrated-host-tool");

    expect(result.assistantText).toBe("最终答案：已完成。");
  });

  it("finalizes a successful Hermes follow-up instead of leaving the task executing", async () => {
    const checkpoint = {
      schema: "neoworker_hermes_acp_v1",
      sessionId: "session-follow-up",
      cwd,
      agentVersion: "fixture",
      toolOwnership: "neoworker",
    } as const;
    const runtime = {
      getCheckpoint: vi.fn(() => checkpoint),
      close: vi.fn(async () => undefined),
    };
    const instance = executor([]) as Any;
    instance.task = {
      id: "follow-up-hermes",
      agentConfig: { externalRuntime: { kind: "acpx", agent: "hermes" } },
    };
    instance.getAcpxExternalRuntimeConfig = () => ({
      kind: "acpx",
      agent: "hermes",
    });
    instance.createHermesRuntimeAdapter = vi.fn(() => runtime);
    instance.runHermesPromptWithTransientRetry = vi.fn(async () => ({
      assistantText: "follow-up completed",
      stopReason: "end_turn",
      sessionId: checkpoint.sessionId,
    }));
    instance.buildQuotedAssistantContextMessage = (message: string) => message;
    instance.buildIntegrationMentionEventPayload = () => ({});
    instance.enforceTaskOutputLanguageForDisplay = (text: string) => text;
    instance.daemon.updateTaskStatus = vi.fn();
    instance.emitEvent = vi.fn();
    instance.finalizeTaskBestEffort = vi.fn();

    await TaskExecutor.prototype.sendMessageWithAcpxRuntime.call(
      instance,
      "Please verify the result.",
    );

    expect(instance.finalizeTaskBestEffort).toHaveBeenCalledWith(
      "follow-up completed",
      "hermes follow-up completed",
    );
    expect(instance.hermesRuntimeAdapter).toBe(runtime);
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("continues an initial Hermes turn when the first response is only an in-progress note", async () => {
    const checkpoint = {
      schema: "neoworker_hermes_acp_v1",
      sessionId: "session-initial-guard",
      cwd,
      agentVersion: "fixture",
      toolOwnership: "neoworker",
    } as const;
    const runtime = {
      getCheckpoint: vi.fn(() => checkpoint),
      close: vi.fn(async () => undefined),
    };
    const instance = executor([]) as Any;
    instance.task = {
      id: "initial-hermes-guard",
      rawPrompt: "帮我查询一下明天北京飞深圳的航班信息",
    };
    instance.paused = false;
    instance.cancelled = false;
    instance.taskCompleted = false;
    instance.hermesCheckpoint = undefined;
    instance.taskContextNotes = [];
    instance.getContractPrompt = () => "";
    instance.buildAppliedSkillContext = () => "";
    instance.daemon.updateTaskStatus = vi.fn();
    instance.createHermesRuntimeAdapter = vi.fn(() => runtime);
    instance.runHermesPromptWithTransientRetry = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText:
          "FlightStats 默认返回了今天（9月11日）的数据。我需要查询明天（9月12日）的航班时刻表。",
        stopReason: "end_turn",
        sessionId: checkpoint.sessionId,
      })
      .mockResolvedValueOnce({
        assistantText: "明天（9月12日）北京飞深圳有 51 班，最早 07:15 起飞。",
        stopReason: "end_turn",
        sessionId: checkpoint.sessionId,
      });
    instance.enforceTaskOutputLanguageForDisplay = (text: string) => text;
    instance.finalizeTaskBestEffort = vi.fn();
    instance.emitEvent = vi.fn();

    await TaskExecutor.prototype.executeWithHermesRuntime.call(
      instance,
      "帮我查询一下明天北京飞深圳的航班信息",
    );

    expect(instance.runHermesPromptWithTransientRetry).toHaveBeenCalledTimes(2);
    expect(instance.runHermesPromptWithTransientRetry.mock.calls[1][1]).toContain(
      "<neoworker_completion_guard_v1>",
    );
    expect(instance.emitEvent).toHaveBeenCalledWith(
      "progress_update",
      expect.objectContaining({
        phase: "hermes_runtime",
        state: "continuing",
      }),
    );
    expect(instance.finalizeTaskBestEffort).toHaveBeenCalledWith(
      "明天（9月12日）北京飞深圳有 51 班，最早 07:15 起飞。",
      "hermes runtime completed",
    );
    expect(instance.hermesRuntimeAdapter).toBe(runtime);
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("continues a Hermes follow-up turn before allowing queued messages to drain", async () => {
    const checkpoint = {
      schema: "neoworker_hermes_acp_v1",
      sessionId: "session-follow-up-guard",
      cwd,
      agentVersion: "fixture",
      toolOwnership: "neoworker",
    } as const;
    const runtime = {
      getCheckpoint: vi.fn(() => checkpoint),
      close: vi.fn(async () => undefined),
    };
    const instance = executor([]) as Any;
    instance.task = {
      id: "follow-up-hermes-guard",
      agentConfig: { externalRuntime: { kind: "acpx", agent: "hermes" } },
    };
    instance.getAcpxExternalRuntimeConfig = () => ({
      kind: "acpx",
      agent: "hermes",
    });
    instance.createHermesRuntimeAdapter = vi.fn(() => runtime);
    instance.runHermesPromptWithTransientRetry = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText: "我需要继续检查本地磁盘占用，重点看 Codex。",
        stopReason: "end_turn",
        sessionId: checkpoint.sessionId,
      })
      .mockResolvedValueOnce({
        assistantText: "Codex 相关目录合计约 12.4GB，主要占用来自构建缓存。",
        stopReason: "end_turn",
        sessionId: checkpoint.sessionId,
      });
    instance.buildQuotedAssistantContextMessage = (message: string) => message;
    instance.buildIntegrationMentionEventPayload = () => ({});
    instance.enforceTaskOutputLanguageForDisplay = (text: string) => text;
    instance.daemon.updateTaskStatus = vi.fn();
    instance.emitEvent = vi.fn();
    instance.finalizeTaskBestEffort = vi.fn();

    await TaskExecutor.prototype.sendMessageWithAcpxRuntime.call(
      instance,
      "帮我查一下本地磁盘情况，主要看一下 Codex 的占用",
    );

    expect(instance.runHermesPromptWithTransientRetry).toHaveBeenCalledTimes(2);
    expect(instance.runHermesPromptWithTransientRetry.mock.calls[1][1]).toContain(
      "<neoworker_completion_guard_v1>",
    );
    expect(instance.finalizeTaskBestEffort).toHaveBeenCalledWith(
      "Codex 相关目录合计约 12.4GB，主要占用来自构建缓存。",
      "hermes follow-up completed",
    );
    expect(instance.hermesRuntimeAdapter).toBe(runtime);
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("keeps sequential file and Shell steps inside the NeoWorker Tool Host", async () => {
    fixtureTransport();
    const instance = executor([]) as Any;
    instance.getAvailableTools = () => [
      { name: "write_file", description: "Write a file", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
      { name: "run_command", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
    ];
    instance.getToolTimeoutMs = () => 1000;
    instance.executeToolWithHeartbeat = vi.fn(async (name, input, _timeout, toolCallId) => ({
      toolHostResponse: {
        schemaVersion: "neoworker_tool_host_v1", requestId: `response-${name}`, toolCallId,
        status: "success", result: name === "write_file" ? { path: input.path, bytesWritten: input.content.length } : { stdout: "hello from Hermes", exitCode: 0 },
      },
      result: name === "write_file" ? { path: input.path, bytesWritten: input.content.length } : { stdout: "hello from Hermes", exitCode: 0 },
      status: "success", durationMs: 1, envelope: {}, policyTrace: [],
    }));
    const runtime = adapter(instance);
    const result = await runtime.prompt("host-multi-tool");
    expect(instance.executeToolWithHeartbeat).toHaveBeenCalledTimes(2);
    expect(instance.executeToolWithHeartbeat.mock.calls.map(([name]) => name)).toEqual(["write_file", "run_command"]);
    expect(instance.emitEvent).toHaveBeenCalledWith("tool_result", expect.objectContaining({ tool: "write_file", runtime: "hermes" }));
    expect(instance.emitEvent).toHaveBeenCalledWith("tool_result", expect.objectContaining({ tool: "run_command", runtime: "hermes" }));
    const assistant = JSON.parse(result.assistantText);
    expect(assistant.write.result.content[0].text).toContain("bytesWritten");
    expect(assistant.shell.result.content[0].text).toContain("hello from Hermes");
    expect(runtime.getCheckpoint()?.toolOwnership).toBe("neoworker");
  });

  it("propagates desktop pause to the active Hermes adapter", async () => {
    const pause = vi.fn(async () => undefined);
    const events: unknown[] = [];
    const instance = executor([]) as Any;
    instance.task = { id: "pause-hermes" };
    instance.getAcpxExternalRuntimeConfig = () => ({ agent: "hermes" });
    instance.hermesRuntimeAdapter = { pause };
    instance.daemon.updateTaskStatus = vi.fn();
    instance.emitEvent = vi.fn((type: string, payload: unknown) => events.push({ type, payload }));
    await TaskExecutor.prototype.pause.call(instance);
    expect(instance.paused).toBe(true);
    expect(pause).toHaveBeenCalledOnce();
    expect(instance.daemon.updateTaskStatus).toHaveBeenCalledWith("pause-hermes", "paused");
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "task_paused" })]));
  });

  it("resumes Hermes from the persisted checkpoint through the executor lifecycle", async () => {
    const events: unknown[] = [];
    const runtime = {
      prompt: vi.fn(async () => ({ assistantText: "continued", stopReason: "end_turn", sessionId: "session-1" })),
      getCheckpoint: vi.fn(() => ({ schema: "neoworker_hermes_acp_v1", sessionId: "session-1", cwd, agentVersion: "fixture" })),
      close: vi.fn(),
    };
    const instance = executor([]) as Any;
    instance.task = { id: "resume-hermes" };
    instance.paused = true;
    instance.waitingForUserInput = false;
    instance.cancelled = false;
    instance.taskCompleted = false;
    instance.hermesCheckpoint = runtime.getCheckpoint();
    instance.getAcpxExternalRuntimeConfig = () => ({ agent: "hermes" });
    instance.daemon.updateTaskStatus = vi.fn();
    instance.createHermesRuntimeAdapter = vi.fn(() => runtime);
    instance.getLifecycleMutex = () => ({ runExclusive: (fn: () => Promise<void>) => fn() });
    instance.emitEvent = vi.fn((type: string, payload: unknown) => events.push({ type, payload }));
    instance.enforceTaskOutputLanguageForDisplay = (text: string) => text;
    instance.finalizeTaskBestEffort = vi.fn();
    await TaskExecutor.prototype.resume.call(instance);
    expect(runtime.prompt).toHaveBeenCalledWith(expect.stringContaining("last checkpoint"));
    expect(instance.finalizeTaskBestEffort).toHaveBeenCalledWith("continued", "hermes runtime resumed");
    expect(instance.hermesRuntimeAdapter).toBe(runtime);
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("applies the bounded provider retry when Hermes resume fails before host progress", async () => {
    const events: Array<{ type: string; payload?: Any }> = [];
    const checkpoint = {
      schema: "neoworker_hermes_acp_v1",
      sessionId: "session-resume-transient",
      cwd,
      agentVersion: "fixture",
      toolOwnership: "neoworker",
    } as const;
    const failure = new HermesAcpError(
      "HTTP 502: The request queue is full",
      "HERMES_RUNTIME_ERROR",
    );
    const runtime = {
      prompt: vi.fn(async () => {
        throw failure;
      }),
      retry: vi.fn(async () => ({
        assistantText: "resumed after provider retry",
        stopReason: "end_turn",
        sessionId: checkpoint.sessionId,
      })),
      getCheckpoint: vi.fn(() => checkpoint),
      getToolProgressRevision: vi.fn(() => 0),
      close: vi.fn(async () => undefined),
    };
    const instance = executor([]) as Any;
    instance.task = { id: "resume-transient-hermes" };
    instance.paused = true;
    instance.waitingForUserInput = false;
    instance.cancelled = false;
    instance.taskCompleted = false;
    instance.hermesCheckpoint = checkpoint;
    instance.getAcpxExternalRuntimeConfig = () => ({ agent: "hermes" });
    instance.daemon.updateTaskStatus = vi.fn();
    instance.createHermesRuntimeAdapter = vi.fn(() => runtime);
    instance.getLifecycleMutex = () => ({
      runExclusive: (fn: () => Promise<void>) => fn(),
    });
    instance.emitEvent = vi.fn((type: string, payload?: Any) => {
      events.push({ type, payload });
    });
    instance.enforceTaskOutputLanguageForDisplay = (text: string) => text;
    instance.finalizeTaskBestEffort = vi.fn();

    await TaskExecutor.prototype.resume.call(instance);

    expect(runtime.prompt).toHaveBeenCalledOnce();
    expect(runtime.retry).toHaveBeenCalledOnce();
    expect(instance.finalizeTaskBestEffort).toHaveBeenCalledWith(
      "resumed after provider retry",
      "hermes runtime resumed",
    );
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "log",
        payload: expect.objectContaining({
          metric: "hermes_runtime_retry",
          safeBeforeToolDispatch: true,
          safeForAutomaticRetry: true,
        }),
      }),
    ]));
    expect(instance.hermesRuntimeAdapter).toBe(runtime);
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("uses a guarded retry prompt when initial execution finds a persisted checkpoint", async () => {
    const checkpoint = {
      schema: "neoworker_hermes_acp_v1",
      sessionId: "session-recover",
      cwd,
      agentVersion: "fixture",
      toolOwnership: "neoworker",
      toolProgress: {
        activeToolCallIds: ["active-1"],
        completedToolCallIds: [],
        failedToolCallIds: [],
        unknownToolCallIds: [],
      },
    } as const;
    const runtime = {
      getCheckpoint: vi.fn(() => checkpoint),
      retry: vi.fn(async (prompt: string) => ({
        assistantText: "recovered",
        stopReason: "end_turn",
        sessionId: checkpoint.sessionId,
        prompt,
      })),
      prompt: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const instance = executor([]) as Any;
    instance.task = { id: "initial-recovery", rawPrompt: "Build the project." };
    instance.hermesCheckpoint = checkpoint;
    instance.paused = false;
    instance.taskContextNotes = ["Persisted task context"];
    instance.appliedSkills = [];
    instance.daemon.updateTaskStatus = vi.fn();
    instance.createHermesRuntimeAdapter = vi.fn(() => runtime);
    instance.enforceTaskOutputLanguageForDisplay = (text: string) => text;
    instance.finalizeTaskBestEffort = vi.fn();

    await TaskExecutor.prototype.executeWithHermesRuntime.call(
      instance,
      "Build the project.",
    );

    expect(runtime.retry).toHaveBeenCalledWith(
      expect.stringContaining("<neoworker_recovery_v1>"),
    );
    expect(runtime.retry.mock.calls[0][0]).toContain(
      "Do not automatically repeat a tool call whose side effect result is unknown",
    );
    expect(runtime.prompt).not.toHaveBeenCalled();
    expect(instance.finalizeTaskBestEffort).toHaveBeenCalledWith(
      "recovered",
      "hermes runtime completed",
    );
    expect(instance.hermesRuntimeAdapter).toBe(runtime);
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("reuses a warm Hermes runtime for a follow-up in the same workspace", () => {
    const checkpoint = {
      schema: "neoworker_hermes_acp_v1",
      sessionId: "warm-session",
      cwd,
      agentVersion: "fixture",
      toolOwnership: "neoworker",
    } as const;
    const runtime = {
      getCheckpoint: vi.fn(() => checkpoint),
      close: vi.fn(async () => undefined),
    };
    const instance = executor([]) as Any;
    instance.hermesCheckpoint = checkpoint;
    instance.hermesRuntimeAdapter = runtime;
    instance.hermesRuntimeWorkspacePath = cwd;

    const reused = TaskExecutor.prototype.createHermesRuntimeAdapter.call(
      instance,
      checkpoint,
    );

    expect(reused).toBe(runtime);
    expect(instance.emitEvent).toHaveBeenCalledWith(
      "log",
      expect.objectContaining({
        metric: "hermes_runtime_session_reused",
        sessionId: "warm-session",
      }),
    );
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("reads only the latest task event when building Hermes checkpoints", () => {
    const instance = executor([]) as Any;
    const runtime = adapter(instance);
    const getTaskEvents = instance.daemon.getTaskEvents as Any;
    getTaskEvents.mockReturnValue([{ seq: 42 }]);

    expect((runtime as Any).options.getLogSequence()).toBe(42);
    expect(getTaskEvents).toHaveBeenCalledWith(
      "recover-hermes",
      { limit: 1 },
    );
    expect(
      getTaskEvents.mock.calls.some(
        ([taskId, options]: [string, Any]) =>
          taskId === "recover-hermes" && options === undefined,
      ),
    ).toBe(false);
  });

  it("retries a transient Hermes provider failure once when no host tool started", async () => {
    const events: Array<{ type: string; payload?: Any }> = [];
    const checkpoint = {
      schema: "neoworker_hermes_acp_v1",
      sessionId: "session-transient",
      cwd,
      agentVersion: "fixture",
      toolOwnership: "neoworker",
    } as const;
    let savedCheckpoint: Any;
    const runtime = {
      getCheckpoint: vi.fn(() => savedCheckpoint),
      getToolProgressRevision: vi.fn(() => 0),
      prompt: vi.fn(async () => {
        savedCheckpoint = checkpoint;
        throw new HermesAcpError(
          "HTTP 502: The request queue is full",
          "HERMES_RUNTIME_ERROR",
        );
      }),
      retry: vi.fn(async () => ({
        assistantText: "recovered after provider retry",
        stopReason: "end_turn",
        sessionId: checkpoint.sessionId,
      })),
      close: vi.fn(async () => undefined),
    };
    const instance = executor([]) as Any;
    instance.task = { id: "transient-hermes", rawPrompt: "Run a transient test." };
    instance.paused = false;
    instance.cancelled = false;
    instance.taskCompleted = false;
    instance.hermesCheckpoint = undefined;
    instance.taskContextNotes = [];
    instance.daemon.updateTaskStatus = vi.fn();
    instance.getContractPrompt = () => "";
    instance.buildAppliedSkillContext = () => "";
    instance.createHermesRuntimeAdapter = vi.fn(() => runtime);
    instance.enforceTaskOutputLanguageForDisplay = (text: string) => text;
    instance.finalizeTaskBestEffort = vi.fn();
    instance.emitEvent = vi.fn((type: string, payload?: Any) => {
      events.push({ type, payload });
    });

    await TaskExecutor.prototype.executeWithHermesRuntime.call(
      instance,
      "transient-provider-error",
    );

    expect(runtime.prompt).toHaveBeenCalledOnce();
    expect(runtime.retry).toHaveBeenCalledOnce();
    expect(instance.finalizeTaskBestEffort).toHaveBeenCalledWith(
      "recovered after provider retry",
      "hermes runtime completed",
    );
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "log",
        payload: expect.objectContaining({
          metric: "hermes_runtime_retry",
          safeBeforeToolDispatch: true,
          safeForAutomaticRetry: true,
        }),
      }),
    ]));
  });

  it("does not send the retry request when cancellation arrives during backoff", async () => {
    vi.useFakeTimers();
    try {
      const checkpoint = {
        schema: "neoworker_hermes_acp_v1",
        sessionId: "session-cancel-backoff",
        cwd,
        agentVersion: "fixture",
        toolOwnership: "neoworker",
      } as const;
      const failure = new HermesAcpError(
        "HTTP 502: The request queue is full",
        "HERMES_RUNTIME_ERROR",
      );
      let rejectPrompt!: (error: unknown) => void;
      let checkpointAvailable = false;
      const runtime = {
        getCheckpoint: vi.fn(() => checkpointAvailable ? checkpoint : undefined),
        getToolProgressRevision: vi.fn(() => 0),
        prompt: vi.fn(
          () => {
            checkpointAvailable = true;
            return new Promise<never>((_resolve, reject) => {
              rejectPrompt = reject;
            });
          },
        ),
        retry: vi.fn(),
        close: vi.fn(async () => undefined),
      };
      const instance = executor([]) as Any;
      instance.task = { id: "cancel-backoff-hermes", rawPrompt: "Cancel the retry." };
      instance.paused = false;
      instance.cancelled = false;
      instance.taskCompleted = false;
      instance.hermesCheckpoint = undefined;
      instance.taskContextNotes = [];
      instance.daemon.updateTaskStatus = vi.fn();
      instance.getContractPrompt = () => "";
      instance.buildAppliedSkillContext = () => "";
      instance.createHermesRuntimeAdapter = vi.fn(() => runtime);
      instance.enforceTaskOutputLanguageForDisplay = (text: string) => text;
      instance.finalizeTaskBestEffort = vi.fn();
      instance.abortController = new AbortController();

      const pending = TaskExecutor.prototype.executeWithHermesRuntime.call(
        instance,
        "cancel-retry",
      );
      const pendingAssertion = expect(pending).rejects.toBe(failure);
      rejectPrompt(failure);
      await Promise.resolve();
      await Promise.resolve();
      instance.cancelled = true;
      instance.abortController.abort();
      await vi.advanceTimersByTimeAsync(500);

      await pendingAssertion;
      expect(runtime.retry).not.toHaveBeenCalled();
      expect(runtime.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a transient Hermes failure after host progress changed", async () => {
    const checkpoint = {
      schema: "neoworker_hermes_acp_v1",
      sessionId: "session-side-effect",
      cwd,
      agentVersion: "fixture",
      toolOwnership: "neoworker",
      toolProgress: {
        activeToolCallIds: ["host-call-in-flight"],
        completedToolCallIds: [],
        failedToolCallIds: [],
        unknownToolCallIds: [],
      },
    } as const;
    let savedCheckpoint: Any;
    let revision = 0;
    const failure = new HermesAcpError(
      "HTTP 502: The request queue is full",
      "HERMES_RUNTIME_ERROR",
    );
    const runtime = {
      getCheckpoint: vi.fn(() => savedCheckpoint),
      getToolProgressRevision: vi.fn(() => revision),
      prompt: vi.fn(async () => {
        savedCheckpoint = checkpoint;
        revision = 1;
        throw failure;
      }),
      retry: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const instance = executor([]) as Any;
    instance.task = { id: "side-effect-hermes", rawPrompt: "Run a side effect." };
    instance.paused = false;
    instance.cancelled = false;
    instance.taskCompleted = false;
    instance.hermesCheckpoint = undefined;
    instance.taskContextNotes = [];
    instance.daemon.updateTaskStatus = vi.fn();
    instance.getContractPrompt = () => "";
    instance.buildAppliedSkillContext = () => "";
    instance.createHermesRuntimeAdapter = vi.fn(() => runtime);
    instance.enforceTaskOutputLanguageForDisplay = (text: string) => text;
    instance.finalizeTaskBestEffort = vi.fn();

    await expect(
      TaskExecutor.prototype.executeWithHermesRuntime.call(
        instance,
        "side-effect-provider-error",
      ),
    ).rejects.toBe(failure);

    expect(runtime.prompt).toHaveBeenCalledOnce();
    expect(runtime.retry).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("retries after completed host tools when Hermes queue capacity recovers", async () => {
    const checkpoint = {
      schema: "neoworker_hermes_acp_v1",
      sessionId: "session-completed-tool",
      cwd,
      agentVersion: "fixture",
      toolOwnership: "neoworker",
      toolProgress: {
        activeToolCallIds: [],
        completedToolCallIds: ["hermes-mcp:web-search-1"],
        failedToolCallIds: [],
        unknownToolCallIds: [],
        lastToolCallId: "hermes-mcp:web-search-1",
      },
    } as const;
    let savedCheckpoint: Any;
    const failure = new HermesAcpError(
      "HTTP 502: The request queue is full",
      "HERMES_RUNTIME_ERROR",
    );
    const runtime = {
      getCheckpoint: vi.fn(() => savedCheckpoint),
      prompt: vi.fn(async () => {
        savedCheckpoint = checkpoint;
        throw failure;
      }),
      retry: vi.fn(async () => ({
        assistantText: "recovered after completed search",
        stopReason: "end_turn",
        sessionId: checkpoint.sessionId,
      })),
      close: vi.fn(async () => undefined),
    };
    const instance = executor([]) as Any;
    instance.task = {
      id: "completed-tool-hermes",
      rawPrompt: "Search and summarize.",
    };
    instance.paused = false;
    instance.cancelled = false;
    instance.taskCompleted = false;
    instance.hermesCheckpoint = undefined;
    instance.taskContextNotes = [];
    instance.daemon.updateTaskStatus = vi.fn();
    instance.getContractPrompt = () => "";
    instance.buildAppliedSkillContext = () => "";
    instance.createHermesRuntimeAdapter = vi.fn(() => runtime);
    instance.enforceTaskOutputLanguageForDisplay = (text: string) => text;
    instance.finalizeTaskBestEffort = vi.fn();

    await TaskExecutor.prototype.executeWithHermesRuntime.call(
      instance,
      "completed-tool-provider-error",
    );

    expect(runtime.prompt).toHaveBeenCalledOnce();
    expect(runtime.retry).toHaveBeenCalledOnce();
    expect(instance.finalizeTaskBestEffort).toHaveBeenCalledWith(
      "recovered after completed search",
      "hermes runtime completed",
    );
  });

  it("does not retry a Hermes provider error explicitly marked non-retryable", async () => {
    const checkpoint = {
      schema: "neoworker_hermes_acp_v1",
      sessionId: "session-non-retryable",
      cwd,
      agentVersion: "fixture",
      toolOwnership: "neoworker",
    } as const;
    let savedCheckpoint: Any;
    const failure = new HermesAcpError(
      "HTTP 402: Insufficient Balance",
      "HERMES_RUNTIME_ERROR",
      { retryable: false },
    );
    const runtime = {
      getCheckpoint: vi.fn(() => savedCheckpoint),
      getToolProgressRevision: vi.fn(() => 0),
      prompt: vi.fn(async () => {
        savedCheckpoint = checkpoint;
        throw failure;
      }),
      retry: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const instance = executor([]) as Any;
    instance.task = { id: "non-retryable-hermes", rawPrompt: "Provider quota test." };
    instance.paused = false;
    instance.cancelled = false;
    instance.taskCompleted = false;
    instance.hermesCheckpoint = undefined;
    instance.taskContextNotes = [];
    instance.daemon.updateTaskStatus = vi.fn();
    instance.getContractPrompt = () => "";
    instance.buildAppliedSkillContext = () => "";
    instance.createHermesRuntimeAdapter = vi.fn(() => runtime);
    instance.enforceTaskOutputLanguageForDisplay = (text: string) => text;
    instance.finalizeTaskBestEffort = vi.fn();

    await expect(
      TaskExecutor.prototype.executeWithHermesRuntime.call(
        instance,
        "non-retryable-provider-error",
      ),
    ).rejects.toBe(failure);

    expect(runtime.prompt).toHaveBeenCalledOnce();
    expect(runtime.retry).not.toHaveBeenCalled();
  });

  it("restores a persisted session after executor recreation instead of creating a conversation", async () => {
    fixtureTransport();
    const events: Array<{ payload: unknown }> = [];
    const first = adapter(executor(events));
    await first.connect();
    const checkpoint = first.getCheckpoint();
    await first.close();
    const load = vi.spyOn(HermesAcpClient.prototype, "loadSession");
    const create = vi.spyOn(HermesAcpClient.prototype, "newSession");
    const restored = adapter(executor(events));
    expect(await restored.prompt("continue")).toMatchObject({
      sessionId: checkpoint!.sessionId, assistantText: "你好 OK",
    });
    expect(load).toHaveBeenCalledWith(checkpoint!.sessionId, cwd, [expect.objectContaining({
      type: "http",
      name: "neoworker",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
    })]);
    expect(checkpoint?.toolOwnership).toBe("neoworker");
    expect(create).not.toHaveBeenCalled();
  });

  it("retains the checkpoint in memory before a failed prompt returns", async () => {
    fixtureTransport();
    const instance = executor([]);
    const first = adapter(instance);
    const controller = new AbortController();
    await first.connect();
    controller.abort();
    await expect(first.prompt("wait", controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    // Simulate event retention not being available for this in-process retry.
    (instance as Any).daemon.getTaskEvents.mockReturnValue([]);
    expect(adapter(instance).getCheckpoint()).toEqual(first.getCheckpoint());
  });

  it.each([
    { schema: "wrong", sessionId: "old", cwd, agentVersion: "fixture" },
    { schema: "neoworker_hermes_acp_v1", sessionId: "old", cwd: "/other", agentVersion: "fixture" },
    { schema: "neoworker_hermes_acp_v1", sessionId: "", cwd, agentVersion: "fixture" },
    { schema: "neoworker_hermes_acp_v1", sessionId: "old", cwd, agentVersion: "fixture", toolOwnership: "invalid" },
  ])("does not silently restart a task with an invalid persisted checkpoint", payload => {
    expect(() => adapter(executor([{ payload }]))).toThrow("Cannot restore Hermes");
  });
});
