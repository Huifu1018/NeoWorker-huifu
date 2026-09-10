import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesToolHostMcpServer } from "../hermes-tool-host-mcp";
import type { ToolHostResponse } from "../tool-host-protocol";

const tool = {
  name: "run_command",
  description: "Run a command in the NeoWorker workspace",
  input_schema: {
    type: "object" as const,
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};

const servers: HermesToolHostMcpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function post(server: HermesToolHostMcpServer, token: string, body: unknown, sessionId?: string): Promise<Response> {
  const port = server.getPort();
  expect(port).toBeTypeOf("number");
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    body: JSON.stringify(body),
  });
}

describe("HermesToolHostMcpServer", () => {
  it("exposes filtered tools and forwards calls through the host boundary", async () => {
    const execute = vi.fn(async ({ toolName, toolCallId, input }): Promise<ToolHostResponse> => ({
      requestId: "request-1",
      toolCallId,
      schemaVersion: "neoworker_tool_host_v1",
      status: "success",
      result: { success: true, toolName, input },
    }));
    const server = new HermesToolHostMcpServer({ taskId: "task-1", getTools: () => [tool], execute });
    servers.push(server);
    const endpoint = await server.start();
    const token = endpoint.headers[0]!.value.replace(/^Bearer /, "");

    const initialize = await post(server, token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(initialize.status).toBe(200);
    expect(await initialize.json()).toMatchObject({ result: { protocolVersion: "2024-11-05" } });
    const sessionId = initialize.headers.get("mcp-session-id")!;

    const list = await post(server, token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
    expect(await list.json()).toMatchObject({ result: { tools: [{ name: "run_command", inputSchema: tool.input_schema }] } });

    const call = await post(server, token, {
      jsonrpc: "2.0",
      id: "call-7",
      method: "tools/call",
      params: { name: "run_command", arguments: { command: "echo hello" } },
    }, sessionId);
    expect(await call.json()).toMatchObject({
      result: {
        isError: false,
        content: [{ type: "text", text: expect.stringContaining("echo hello") }],
      },
    });
    expect(execute).toHaveBeenCalledWith({
      toolName: "run_command",
      toolCallId: `hermes-mcp:${JSON.stringify(["task-1", sessionId, "string", "call-7"])}`,
      input: { command: "echo hello" },
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects unauthenticated and oversized requests", async () => {
    const server = new HermesToolHostMcpServer({
      taskId: "task-2",
      getTools: () => [],
      execute: vi.fn(),
      maxRequestBytes: 32,
    });
    servers.push(server);
    const endpoint = await server.start();
    const port = server.getPort()!;
    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(unauthorized.status).toBe(401);

    const token = endpoint.headers[0]!.value.replace(/^Bearer /, "");
    const oversized = await post(server, token, { jsonrpc: "2.0", id: 1, method: "ping", padding: "x".repeat(100) });
    expect(oversized.status).toBe(400);
  });

  it("rejects tools outside the task catalog before dispatch", async () => {
    const execute = vi.fn();
    const server = new HermesToolHostMcpServer({ taskId: "restricted", getTools: () => [tool], execute });
    servers.push(server);
    const endpoint = await server.start();
    const token = endpoint.headers[0]!.value.replace(/^Bearer /, "");
    const init = await post(server, token, { jsonrpc: "2.0", id: 1, method: "initialize" });
    const call = await post(server, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_file", arguments: {} } }, init.headers.get("mcp-session-id")!);
    expect(await call.json()).toMatchObject({ id: 2, error: { code: -32602 } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("aborts timed-out host calls and reports a tool error", async () => {
    let signal: AbortSignal | undefined;
    const server = new HermesToolHostMcpServer({
      taskId: "timeout", getTools: () => [tool], requestTimeoutMs: 20,
      execute: async (call) => { signal = call.signal; return new Promise(() => {}); },
    });
    servers.push(server);
    const endpoint = await server.start();
    const token = endpoint.headers[0]!.value.replace(/^Bearer /, "");
    const init = await post(server, token, { jsonrpc: "2.0", id: 1, method: "initialize" });
    const call = await post(server, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_command", arguments: {} } }, init.headers.get("mcp-session-id")!);
    const payload = await call.json() as Any;
    expect(payload).toMatchObject({ result: { isError: true } });
    expect(JSON.parse(payload.result.content[0].text)).toMatchObject({
      error: expect.stringContaining("timed out"),
    });
    expect(signal?.aborted).toBe(true);
  });

  it("serializes rejected host dispatches as structured tool errors", async () => {
    const server = new HermesToolHostMcpServer({
      taskId: "dispatch-error",
      getTools: () => [tool],
      execute: async () => {
        throw Object.assign(new Error("TOOL_CALL_OUTCOME_UNKNOWN"), {
          code: "TOOL_CALL_OUTCOME_UNKNOWN",
        });
      },
    });
    servers.push(server);
    const endpoint = await server.start();
    const token = endpoint.headers[0]!.value.replace(/^Bearer /, "");
    const init = await post(server, token, { jsonrpc: "2.0", id: 1, method: "initialize" });
    const call = await post(
      server,
      token,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "run_command", arguments: { command: "echo never" } },
      },
      init.headers.get("mcp-session-id")!,
    );
    const payload = await call.json() as Any;
    expect(payload).toMatchObject({ result: { isError: true } });
    expect(JSON.parse(payload.result.content[0].text)).toMatchObject({
      error: "TOOL_CALL_OUTCOME_UNKNOWN",
    });
  });

  it("cancels active calls, rejects late dispatches and permits explicit resume", async () => {
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const execute = vi.fn(async (call): Promise<ToolHostResponse> => {
      signal = call.signal;
      started();
      // Even an uncooperative handler cannot leave the HTTP response hanging.
      return new Promise(() => {});
    });
    const server = new HermesToolHostMcpServer({
      taskId: "cancel", getTools: () => [tool], requestTimeoutMs: 60_000, execute,
    });
    servers.push(server);
    const endpoint = await server.start();
    const token = endpoint.headers[0]!.value.replace(/^Bearer /, "");
    const init = await post(server, token, { jsonrpc: "2.0", id: 1, method: "initialize" });
    const pending = post(server, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_command", arguments: {} } }, init.headers.get("mcp-session-id")!);
    await ready;
    server.suspendToolCalls();
    const cancelled = await pending;
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ result: { isError: true } });
    expect(signal?.aborted).toBe(true);
    const ping = await post(server, token, { jsonrpc: "2.0", id: 3, method: "ping" }, init.headers.get("mcp-session-id")!);
    expect(ping.status).toBe(200);
    const late = await post(server, token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run_command", arguments: {} } }, init.headers.get("mcp-session-id")!);
    expect(await late.json()).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("suspended") }] } });
    expect(execute).toHaveBeenCalledOnce();
    execute.mockResolvedValueOnce({ requestId: "resumed", toolCallId: "resumed", schemaVersion: "neoworker_tool_host_v1", status: "success", result: { exitCode: 0 } });
    server.resumeToolCalls();
    const resumed = await post(server, token, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "run_command", arguments: {} } }, init.headers.get("mcp-session-id")!);
    expect(await resumed.json()).toMatchObject({ result: { isError: false } });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("separates reused RPC ids across MCP reconnects and caps model output", async () => {
    const largeResult = { stdout: "x".repeat(300_000), exitCode: 0, success: true };
    const execute = vi.fn(async ({ toolCallId }): Promise<ToolHostResponse> => ({
      requestId: "result", toolCallId, schemaVersion: "neoworker_tool_host_v1", status: "success", result: largeResult,
    }));
    const server = new HermesToolHostMcpServer({ taskId: "reconnect", getTools: () => [tool], execute });
    servers.push(server);
    const endpoint = await server.start();
    const token = endpoint.headers[0]!.value.replace(/^Bearer /, "");
    for (let attempt = 0; attempt < 2; attempt++) {
      const init = await post(server, token, { jsonrpc: "2.0", id: 1, method: "initialize" });
      const call = await post(server, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_command", arguments: {} } }, init.headers.get("mcp-session-id")!);
      const payload = await call.json() as Any;
      expect(payload.result.content[0].text.length).toBeLessThanOrEqual(200_000);
      expect(JSON.parse(payload.result.content[0].text)).toMatchObject({ truncated: true, exitCode: 0 });
    }
    expect(execute.mock.calls[0]![0].toolCallId).not.toBe(execute.mock.calls[1]![0].toolCallId);
    expect(largeResult.stdout.length).toBe(300_000);
  });
});
