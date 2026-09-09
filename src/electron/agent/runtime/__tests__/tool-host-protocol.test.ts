import { describe, expect, it, vi } from "vitest";
import {
  NeoWorkerToolHost,
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
});
