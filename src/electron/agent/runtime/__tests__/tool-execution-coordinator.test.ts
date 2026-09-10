import { describe, expect, it, vi } from "vitest";
import { ToolExecutionCoordinator } from "../ToolExecutionCoordinator";

function coordinatorFor(result: unknown, rejection?: Error) {
  const registry = {
    executeToolWithRuntime: rejection
      ? vi.fn().mockRejectedValue(rejection)
      : vi.fn().mockResolvedValue({ result }),
  } as Any;
  return {
    coordinator: new ToolExecutionCoordinator(registry),
    registry,
  };
}

function legacyCoordinatorFor(result: unknown) {
  const registry = {
    executeTool: vi.fn().mockResolvedValue(result),
  } as Any;
  return {
    coordinator: new ToolExecutionCoordinator(registry),
    registry,
  };
}

function lifecycleContext(events: Any[], overrides: Any = {}) {
  return {
    taskId: "task-1",
    phase: "step" as const,
    emitEvent: (type: string, payload: Any) => events.push({ type, payload }),
    ...overrides,
  };
}

describe("ToolExecutionCoordinator lifecycle", () => {
  it("falls back to a legacy registry executor when runtime context is unavailable", async () => {
    const events: Any[] = [];
    const { coordinator, registry } = legacyCoordinatorFor({
      success: true,
      value: "legacy-ok",
    });

    const output = await coordinator.executeTool(
      "read_file",
      { path: "README.md" },
      lifecycleContext(events),
      "legacy-call",
    );

    expect(registry.executeTool).toHaveBeenCalledWith(
      "read_file",
      { path: "README.md" },
      expect.objectContaining({ toolUseId: "legacy-call" }),
    );
    expect(output.envelope.status).toBe("success");
    expect(
      events.some(
        (event) =>
          event.payload.metric === "tool_lifecycle" &&
          event.payload.status === "result",
      ),
    ).toBe(true);
  });

  it("records request, running and result states with duration and toolCallId", async () => {
    const events: Any[] = [];
    const { coordinator } = coordinatorFor({ success: true, value: "ok" });
    const output = await coordinator.executeTool(
      "read_file",
      { path: "README.md" },
      lifecycleContext(events),
      "call-1",
    );

    const lifecycle = events.filter((event) => event.payload.metric === "tool_lifecycle");
    expect(lifecycle.map((event) => event.payload.status)).toEqual([
      "request",
      "running",
      "result",
    ]);
    expect(lifecycle[0].payload).toMatchObject({
      taskId: "task-1",
      tool: "read_file",
      toolCallId: "call-1",
      idempotencyKey: '["task-1","call-1"]',
      startedAt: expect.any(Number),
    });
    expect(lifecycle[2].payload.durationMs).toEqual(expect.any(Number));
    expect(lifecycle[2].payload.endedAt).toEqual(expect.any(Number));
    expect(output.envelope.status).toBe("success");
  });

  it("classifies structured tool failures as failed", async () => {
    const events: Any[] = [];
    const { coordinator } = coordinatorFor({ success: false, error: "permission denied" });
    const output = await coordinator.executeTool(
      "write_file",
      { path: "secret.txt" },
      lifecycleContext(events),
      "call-2",
    );

    expect(events.find((event) => event.payload.metric === "tool_lifecycle" && event.payload.status === "failed")?.payload)
      .toMatchObject({ toolCallId: "call-2", error: "permission denied" });
    expect(output.envelope.status).toBe("error");
  });

  it("preserves cancellation status when a shell reports it was stopped", async () => {
    const events: Any[] = [];
    const { coordinator } = coordinatorFor({
      success: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      terminationReason: "user_stopped",
    });
    const output = await coordinator.executeTool(
      "run_command",
      { command: "long-running-command" },
      lifecycleContext(events),
      "call-stopped",
    );

    expect(output.envelope.status).toBe("cancelled");
    expect(events.find((event) => event.payload.metric === "tool_lifecycle" && event.payload.status === "cancelled")?.payload)
      .toMatchObject({
        taskId: "task-1",
        toolCallId: "call-stopped",
        exitCode: null,
        terminationReason: "user_stopped",
      });
  });

  it.each([
    [new Error("tool timed out"), "timed_out"],
    [new Error("request cancelled"), "cancelled"],
    [new Error("process exited"), "failed"],
  ])("classifies thrown errors as %s", async (error, expected) => {
    const events: Any[] = [];
    const { coordinator } = coordinatorFor(undefined, error);
    await coordinator.executeTool("run_command", { command: "build" }, lifecycleContext(events), "call-error");
    expect(events.find((event) => event.payload.metric === "tool_lifecycle" && event.payload.status === expected)?.payload)
      .toMatchObject({
        taskId: "task-1",
        toolCallId: "call-error",
        idempotencyKey: '["task-1","call-error"]',
        error: error.message,
        errorType: "Error",
      });
  });

  it("does not start workspace recovery after cancellation", async () => {
    const events: Any[] = [];
    const recovery = vi.fn(async () => ({
      recovered: true,
      result: { success: true, value: "unexpected-replay" },
    }));
    const { coordinator } = coordinatorFor(undefined, new Error("request cancelled"));
    const controller = new AbortController();
    controller.abort();

    const output = await coordinator.executeTool(
      "run_command",
      { command: "long-running-command" },
      lifecycleContext(events, { signal: controller.signal, workspaceRecovery: recovery }),
      "call-cancelled",
    );

    expect(recovery).not.toHaveBeenCalled();
    expect(output.envelope.status).toBe("error");
    expect(events.find((event) => event.payload.metric === "tool_lifecycle" && event.payload.status === "cancelled")?.payload)
      .toMatchObject({ toolCallId: "call-cancelled" });
  });

  it("discards a recovery result when cancellation races with recovery", async () => {
    const events: Any[] = [];
    const controller = new AbortController();
    const recovery = vi.fn(async () => {
      controller.abort();
      await Promise.resolve();
      return { recovered: true, result: { success: true, value: "late" } };
    });
    const { coordinator } = coordinatorFor(undefined, new Error("workspace boundary failure"));

    const output = await coordinator.executeTool(
      "read_file",
      { path: "/outside/workspace/file.txt" },
      lifecycleContext(events, { signal: controller.signal, workspaceRecovery: recovery }),
      "call-race",
    );

    expect(recovery).toHaveBeenCalledTimes(1);
    expect(output.envelope.status).toBe("error");
    expect(events.find((event) => event.payload.metric === "tool_lifecycle" && event.payload.status === "cancelled")?.payload)
      .toMatchObject({ toolCallId: "call-race" });
    expect(events.some((event) => event.payload.metric === "tool_lifecycle" && event.payload.status === "result" && event.payload.recovered)).toBe(false);
  });
});
