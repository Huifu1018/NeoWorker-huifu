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

  it("keeps file and shell steps on the same host-owned boundary", async () => {
    const requestBodies: Any[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body || "{}")));
      const step = requestBodies.length;
      const payload = step === 1
        ? { choices: [{ message: { tool_calls: [{ id: "read-1", type: "function", function: { name: "read_file", arguments: '{"path":"input.txt"}' } }] }, finish_reason: "tool_calls" }] }
        : step === 2
          ? { choices: [{ message: { tool_calls: [{ id: "shell-1", type: "function", function: { name: "run_command", arguments: '{"command":"echo ready"}' } }] }, finish_reason: "tool_calls" }] }
          : { choices: [{ message: { content: "Finished reading input.txt and running the command." }, finish_reason: "stop" }] };
      return { ok: true, json: async () => payload } as Response;
    });

    const provider = LLMProviderFactory.createProviderFromConfig({ type: "hermes-proxy", model: "proxy-model" } as Any);
    const events: Any[] = [];
    const outcomes: Record<string, Any> = {
      read_file: { result: { success: true, content: "hello" }, durationMs: 1, resultJson: '{"success":true,"content":"hello"}', envelope: { toolUseId: "read-1", toolName: "read_file", status: "success", modelPayload: '{"success":true,"content":"hello"}', userSummary: "read_file completed", structuredData: { success: true, content: "hello" }, evidence: [], retryable: false } },
      run_command: { result: { success: true, stdout: "ready\n", exitCode: 0 }, durationMs: 1, resultJson: '{"success":true,"stdout":"ready\\n","exitCode":0}', envelope: { toolUseId: "shell-1", toolName: "run_command", status: "success", modelPayload: '{"success":true,"stdout":"ready\\n","exitCode":0}', userSummary: "run_command completed", structuredData: { success: true, stdout: "ready\n", exitCode: 0 }, evidence: [], retryable: false } },
    };
    const coordinator = { executeTool: vi.fn(async (name: string) => outcomes[name]) } as Any;
    const host = new NeoWorkerToolHost(coordinator);
    const context = { taskId: "file-shell-task", phase: "step" as const, emitEvent: (_type: string, payload: Any) => events.push(payload) };
    const tools = [
      { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "run_command", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
    ];
    const messages: Any[] = [{ role: "user", content: "Read the file, run the command, and report." }];

    for (let step = 0; step < 2; step += 1) {
      const response = await provider.createMessage({ model: "proxy-model", system: "Use NeoWorker tools.", maxTokens: 256, messages, tools });
      const toolUse = response.content.find((block: Any) => block.type === "tool_use");
      const execution = await host.execute(createToolHostRequest({ taskId: context.taskId, toolName: toolUse.name, toolCallId: toolUse.id, input: toolUse.input }), context);
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(execution.response.result) }] });
    }
    const final = await provider.createMessage({ model: "proxy-model", system: "Use NeoWorker tools.", maxTokens: 256, messages, tools });

    expect(final.stopReason).toBe("end_turn");
    expect(coordinator.executeTool).toHaveBeenCalledTimes(2);
    expect(coordinator.executeTool.mock.calls.map((call: Any[]) => call[0])).toEqual(["read_file", "run_command"]);
    expect(events.filter((event) => event.metric === "tool_host_lifecycle" && event.status === "response")).toHaveLength(2);
    expect(requestBodies).toHaveLength(3);
    fetchSpy.mockRestore();
  });
});
