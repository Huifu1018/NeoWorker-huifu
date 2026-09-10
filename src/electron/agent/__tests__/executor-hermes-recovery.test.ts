import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { TaskExecutor } from "../executor";
import { HermesAcpClient, HermesAcpError } from "../runtime/hermes-acp-client";
import type { HermesRuntimeAdapter } from "../runtime/hermes-runtime-adapter";

const cwd = __dirname;
const fixture = path.join(cwd, "../runtime/__tests__/fixtures/hermes-acp-fixture.cjs");
const adapters: HermesRuntimeAdapter[] = [];
afterEach(async () => {
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
    expect(instance.daemon.logEvent.mock.calls.some(([, type]) => type === "hermes_runtime_transport")).toBe(true);
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
    expect(runtime.close).toHaveBeenCalledOnce();
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
        }),
      }),
    ]));
    expect(runtime.close).toHaveBeenCalledOnce();
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
    expect(runtime.close).toHaveBeenCalledOnce();
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
