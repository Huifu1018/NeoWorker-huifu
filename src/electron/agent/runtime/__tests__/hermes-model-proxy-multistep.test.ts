import { describe, expect, it, vi } from "vitest";

import { LLMProviderFactory } from "../../llm/provider-factory";
import { NeoWorkerToolHost, createToolHostRequest, TOOL_HOST_SCHEMA_VERSION } from "../tool-host-protocol";

const runCommandTool = {
  name: "run_command",
  description: "Run a command in the NeoWorker workspace",
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

describe("Hermes Model Proxy host-owned multistep flow", () => {
  it("executes a proxy tool call locally and sends its result into the next model turn", async () => {
    const requestBodies: Any[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body || "{}")));
      const callCount = requestBodies.length;
      const payload = callCount === 1
        ? {
            choices: [{
              message: {
                content: "",
                tool_calls: [{
                  id: "proxy_call_1",
                  type: "function",
                  function: { name: "run_command", arguments: '{"command":"echo hello"}' },
                }],
              },
              finish_reason: "tool_calls",
            }],
          }
        : {
            choices: [{
              message: { content: "Command completed: hello" },
              finish_reason: "stop",
            }],
          };
      return { ok: true, json: async () => payload } as Response;
    });

    const provider = LLMProviderFactory.createProviderFromConfig({
      type: "hermes-proxy",
      model: "proxy-model",
    } as Any);
    const outcome = {
      result: { success: true, stdout: "hello\n", exitCode: 0 },
      durationMs: 2,
      resultJson: '{"success":true,"stdout":"hello\\n","exitCode":0}',
      envelope: {
        toolUseId: "proxy_call_1",
        toolName: "run_command",
        status: "success" as const,
        modelPayload: '{"success":true,"stdout":"hello\\n","exitCode":0}',
        userSummary: "run_command completed",
        structuredData: { success: true, stdout: "hello\n", exitCode: 0 },
        evidence: [],
        retryable: false,
      },
    };
    const coordinator = { executeTool: vi.fn().mockResolvedValue(outcome) } as Any;
    const host = new NeoWorkerToolHost(coordinator);
    const context = { taskId: "multistep-task", phase: "step" as const };
    const initialMessages = [{ role: "user" as const, content: "Run the command and report the result." }];

    const first = await provider.createMessage({
      model: "proxy-model",
      system: "Use NeoWorker tools.",
      maxTokens: 256,
      messages: initialMessages,
      tools: [runCommandTool],
    });
    expect(first.stopReason).toBe("tool_use");
    const toolUse = first.content.find((block: Any) => block.type === "tool_use");
    expect(toolUse).toMatchObject({ id: "proxy_call_1", name: "run_command", input: { command: "echo hello" } });

    const execution = await host.execute(
      createToolHostRequest({
        taskId: context.taskId,
        toolName: toolUse.name,
        toolCallId: toolUse.id,
        input: toolUse.input,
      }),
      context,
    );
    expect(execution.response.schemaVersion).toBe(TOOL_HOST_SCHEMA_VERSION);
    expect(coordinator.executeTool).toHaveBeenCalledOnce();

    const second = await provider.createMessage({
      model: "proxy-model",
      system: "Use NeoWorker tools.",
      maxTokens: 256,
      messages: [
        ...initialMessages,
        { role: "assistant" as const, content: first.content },
        {
          role: "user" as const,
          content: [{
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content: JSON.stringify(execution.response.result),
          }],
        },
      ],
      tools: [runCommandTool],
    });

    expect(second.stopReason).toBe("end_turn");
    expect(second.content).toContainEqual({ type: "text", text: "Command completed: hello" });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "proxy_call_1" })] }),
      expect.objectContaining({ role: "tool", tool_call_id: "proxy_call_1" }),
    ]));

    fetchSpy.mockRestore();
  });
});
