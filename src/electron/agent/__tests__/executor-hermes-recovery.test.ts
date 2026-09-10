import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { TaskExecutor } from "../executor";
import { HermesAcpClient } from "../runtime/hermes-acp-client";
import type { HermesRuntimeAdapter } from "../runtime/hermes-runtime-adapter";

const cwd = __dirname;
const fixture = path.join(cwd, "../runtime/__tests__/fixtures/hermes-acp-fixture.cjs");
const adapters: HermesRuntimeAdapter[] = [];
afterEach(() => {
  adapters.splice(0).forEach(adapter => adapter.close());
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
    );
    expect(JSON.parse(result.assistantText)).toMatchObject({ result: { isError: false, content: [{ text: '{"stdout":"host\\n","exitCode":0}' }] } });
    expect(runtime.getCheckpoint()?.toolOwnership).toBe("neoworker");
    expect(instance.enforceToolBudget).toHaveBeenCalledWith("run_command");
    expect(instance.emitEvent).toHaveBeenCalledWith("tool_result", expect.objectContaining({ tool: "run_command", runtime: "hermes" }));
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

  it("restores a persisted session after executor recreation instead of creating a conversation", async () => {
    fixtureTransport();
    const events: Array<{ payload: unknown }> = [];
    const first = adapter(executor(events));
    await first.connect();
    const checkpoint = first.getCheckpoint();
    first.close();
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
