import { describe, expect, it, vi } from "vitest";
import {
  NeoWorkerToolHost,
  ToolHostRequestConflictError,
  TOOL_HOST_SCHEMA_VERSION,
  createToolHostRequest,
} from "../tool-host-protocol";

const context = { taskId: "task-1", phase: "step" as const };

describe("NeoWorker tool host protocol", () => {
  it("creates correlated, versioned requests", () => {
    const request = createToolHostRequest({
      taskId: "task-1",
      toolName: "read_file",
      input: { path: "README.md" },
    });
    expect(request).toMatchObject({
      toolCallId: expect.stringContaining("read_file:"),
      requestId: expect.stringContaining("task-1:"),
      schemaVersion: TOOL_HOST_SCHEMA_VERSION,
      toolName: "read_file",
    });
  });

  it("returns a stable success envelope while preserving the coordinator outcome", async () => {
    const outcome = {
      result: { path: "README.md", content: "ok" },
      durationMs: 3,
      resultJson: "{\"path\":\"README.md\"}",
      envelope: {
        toolUseId: "call-1",
        toolName: "read_file",
        status: "success" as const,
        modelPayload: "{}",
        userSummary: "read_file completed",
        structuredData: { path: "README.md", content: "ok" },
        evidence: [],
        retryable: false,
      },
    };
    const coordinator = { executeTool: vi.fn().mockResolvedValue(outcome) } as Any;
    const host = new NeoWorkerToolHost(coordinator);
    const request = createToolHostRequest({ taskId: "task-1", toolName: "read_file", toolCallId: "call-1", input: {} });
    const execution = await host.execute(request, context);
    expect(coordinator.executeTool).toHaveBeenCalledWith("read_file", {}, context, "call-1");
    expect(execution.outcome).toBe(outcome);
    expect(execution.response).toMatchObject({
      requestId: request.requestId,
      toolCallId: "call-1",
      schemaVersion: TOOL_HOST_SCHEMA_VERSION,
      status: "success",
      result: outcome.result,
    });
  });

  it("rejects an unversioned or malformed request before running a tool", async () => {
    const coordinator = { executeTool: vi.fn() } as Any;
    const host = new NeoWorkerToolHost(coordinator);
    await expect(host.execute({
      requestId: "r1",
      toolCallId: "c1",
      schemaVersion: "old" as Any,
      toolName: "read_file",
      input: {},
    }, context)).rejects.toThrow("Unsupported tool host schema");
    expect(coordinator.executeTool).not.toHaveBeenCalled();
  });

  it("deduplicates a repeated toolCallId while preserving each requestId", async () => {
    let resolve!: (value: Any) => void;
    const pending = new Promise((done) => { resolve = done; });
    const outcome = {
      result: { success: true },
      durationMs: 1,
      resultJson: "{}",
      envelope: {
        toolUseId: "call-1",
        toolName: "write_file",
        status: "success" as const,
        modelPayload: "{}",
        userSummary: "write_file completed",
        structuredData: { success: true },
        evidence: [],
        retryable: false,
      },
    };
    const coordinator = {
      executeTool: vi.fn().mockImplementation(async () => { await pending; return outcome; }),
    } as Any;
    const host = new NeoWorkerToolHost(coordinator);
    const first = createToolHostRequest({ taskId: "task-1", toolName: "write_file", toolCallId: "call-1", input: { path: "a" } });
    const second = createToolHostRequest({ taskId: "task-1", toolName: "write_file", toolCallId: "call-1", input: { path: "a" } });
    const firstResult = host.execute(first, context);
    const secondResult = host.execute(second, context);
    resolve(outcome);
    const [a, b] = await Promise.all([firstResult, secondResult]);
    expect(coordinator.executeTool).toHaveBeenCalledTimes(1);
    expect(a.response.requestId).toBe(first.requestId);
    expect(b.response.requestId).toBe(second.requestId);
    expect(a.outcome).toBe(b.outcome);
  });

  it("rejects reuse of a toolCallId with different input", async () => {
    const outcome = {
      result: { success: true }, durationMs: 1, resultJson: "{}",
      envelope: { toolUseId: "call-1", toolName: "write_file", status: "success" as const,
        modelPayload: "{}", userSummary: "write_file completed", structuredData: { success: true },
        evidence: [], retryable: false },
    };
    const coordinator = { executeTool: vi.fn().mockResolvedValue(outcome) } as Any;
    const host = new NeoWorkerToolHost(coordinator);
    const first = createToolHostRequest({ taskId: "task-1", toolName: "write_file", toolCallId: "call-1", input: { path: "a" } });
    const conflicting = createToolHostRequest({ taskId: "task-1", toolName: "write_file", toolCallId: "call-1", input: { path: "b" } });
    await host.execute(first, context);
    await expect(host.execute(conflicting, context)).rejects.toBeInstanceOf(ToolHostRequestConflictError);
    expect(coordinator.executeTool).toHaveBeenCalledTimes(1);
  });

  it("keeps a rejected side-effect promise fail-closed on retransmission", async () => {
    const failure = new Error("transport lost after dispatch");
    const coordinator = { executeTool: vi.fn().mockRejectedValue(failure) } as Any;
    const host = new NeoWorkerToolHost(coordinator);
    const request = createToolHostRequest({ taskId: "task-1", toolName: "run_command", toolCallId: "call-1", input: { command: "echo hi" } });
    await expect(host.execute(request, context)).rejects.toThrow("transport lost");
    await expect(host.execute({ ...request, requestId: "retry" }, context)).rejects.toThrow("transport lost");
    expect(coordinator.executeTool).toHaveBeenCalledTimes(1);
  });

  it("keeps task/tool idempotency keys distinct when IDs contain separators", async () => {
    const outcome = {
      result: { success: true }, durationMs: 1, resultJson: "{}",
      envelope: { toolUseId: "call-1", toolName: "read_file", status: "success" as const,
        modelPayload: "{}", userSummary: "read_file completed", structuredData: { success: true },
        evidence: [], retryable: false },
    };
    const coordinator = { executeTool: vi.fn().mockResolvedValue(outcome) } as Any;
    const host = new NeoWorkerToolHost(coordinator);
    const first = createToolHostRequest({ taskId: "task:a", toolName: "read_file", toolCallId: "b", input: { path: "a" } });
    const second = createToolHostRequest({ taskId: "task", toolName: "read_file", toolCallId: "a:b", input: { path: "b" } });
    await host.execute(first, { taskId: "task:a", phase: "step" });
    await host.execute(second, { taskId: "task", phase: "step" });
    expect(coordinator.executeTool).toHaveBeenCalledTimes(2);
  });

  it("records request, deduplication, and response lifecycle metadata", async () => {
    const outcome = {
      result: { success: true }, durationMs: 4, resultJson: "{}",
      envelope: { toolUseId: "call-1", toolName: "read_file", status: "success" as const,
        modelPayload: "{}", userSummary: "read_file completed", structuredData: { success: true },
        evidence: [], retryable: false },
    };
    const coordinator = { executeTool: vi.fn().mockResolvedValue(outcome) } as Any;
    const events: Any[] = [];
    const host = new NeoWorkerToolHost(coordinator);
    const request = createToolHostRequest({ taskId: "task-1", toolName: "read_file", toolCallId: "call-1", input: {} });
    const executionContext = { ...context, emitEvent: vi.fn((type, payload) => events.push({ type, payload })) };
    await host.execute(request, executionContext);
    await host.execute({ ...request, requestId: "retry-request" }, executionContext);
    const lifecycle = events.filter((event) => event.payload.metric === "tool_host_lifecycle");
    expect(lifecycle.map((event) => event.payload.status)).toEqual([
      "request", "response", "request", "deduplicated", "response",
    ]);
    expect(lifecycle[0].payload).toMatchObject({
      requestId: request.requestId,
      toolCallId: "call-1",
      idempotencyKey: '["task-1","call-1"]',
      schemaVersion: TOOL_HOST_SCHEMA_VERSION,
    });
  });
});
