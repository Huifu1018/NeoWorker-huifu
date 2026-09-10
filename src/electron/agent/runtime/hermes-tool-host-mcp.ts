import { randomBytes } from "node:crypto";
import * as http from "node:http";

import type { LLMTool } from "../llm";
import type { ToolHostResponse } from "./tool-host-protocol";
import { timingSafeEqualString } from "../../utils/webhook-auth";
import { buildToolResultEnvelope } from "./tool-result-envelope";

/** A task-scoped MCP endpoint used when Hermes ACP is running host-owned tools. */
export interface HermesToolHostMcpOptions {
  taskId: string;
  getTools: () => LLMTool[];
  execute: (input: {
    toolName: string;
    toolCallId: string;
    input: unknown;
    signal: AbortSignal;
  }) => Promise<ToolHostResponse>;
  /** Bind to an ephemeral loopback port by default. */
  port?: number;
  /** Maximum JSON request body accepted from Hermes. */
  maxRequestBytes?: number;
  /** Maximum time allowed for a tool call before returning an MCP error. */
  requestTimeoutMs?: number;
}

export interface HermesToolHostMcpEndpoint {
  url: string;
  headers: Array<{ name: string; value: string }>;
}

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MCP_PROTOCOL_VERSION = "2024-11-05";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || typeof value === "number";
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonRpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function toolToMcp(tool: LLMTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema,
  };
}

/**
 * Small, dependency-free Streamable HTTP MCP server for a single NeoWorker
 * task. It deliberately exposes only the task's filtered tools and forwards
 * every call through ToolHost, so approval, sandboxing, lifecycle logging and
 * idempotency stay in NeoWorker.
 */
export class HermesToolHostMcpServer {
  private server: http.Server | undefined;
  private port: number | undefined;
  private readonly authToken = randomBytes(32).toString("base64url");
  private readonly maxRequestBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly activeCalls = new Set<AbortController>();
  private acceptingToolCalls = true;
  private readonly sessions = new Set<string>();

  constructor(private readonly options: HermesToolHostMcpOptions) {
    if (!options.taskId.trim()) throw new Error("Hermes MCP taskId is required");
    this.maxRequestBytes = Number.isFinite(options.maxRequestBytes) && (options.maxRequestBytes as number) > 0
      ? Math.floor(options.maxRequestBytes as number)
      : DEFAULT_MAX_REQUEST_BYTES;
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) && (options.requestTimeoutMs as number) > 0
      ? Math.floor(options.requestTimeoutMs as number)
      : DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async start(): Promise<HermesToolHostMcpEndpoint> {
    if (this.server) throw new Error("Hermes MCP Tool Host is already running");
    this.server = http.createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port ?? 0, "127.0.0.1");
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      await this.stop();
      throw new Error("Hermes MCP Tool Host did not expose a TCP port");
    }
    this.port = address.port;
    return {
      url: `http://127.0.0.1:${this.port}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${this.authToken}` }],
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.sessions.clear();
    this.suspendToolCalls();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  getPort(): number | undefined {
    return this.port;
  }

  /** Reject late calls as well as aborting those already dispatched. */
  suspendToolCalls(): void {
    this.acceptingToolCalls = false;
    for (const controller of this.activeCalls) {
      controller.abort(new Error("NeoWorker tool host request cancelled"));
    }
  }

  resumeToolCalls(): void {
    this.acceptingToolCalls = true;
  }

  private async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "GET" && request.url === "/health") {
      this.writeJson(response, 200, { ok: true, taskId: this.options.taskId, protocolVersion: MCP_PROTOCOL_VERSION });
      return;
    }
    if (request.method === "GET" && request.url === "/mcp") {
      // This request/response transport does not open an SSE stream.
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/mcp") {
      this.writeJson(response, 404, { error: "Not found" });
      return;
    }
    const authorization = String(request.headers.authorization || "");
    if (!timingSafeEqualString(authorization, `Bearer ${this.authToken}`)) {
      this.writeJson(response, 401, jsonRpcError(null, -32001, "Unauthorized"));
      return;
    }
    try {
      const body = await this.readBody(request);
      const parsed = JSON.parse(body) as unknown;
      const initializing = isRecord(parsed) && parsed.method === "initialize";
      const sessionId = initializing
        ? randomBytes(24).toString("base64url")
        : String(request.headers["mcp-session-id"] || "");
      if (!initializing && !this.sessions.has(sessionId)) {
        this.writeJson(response, 404, jsonRpcError(null, -32001, "Unknown MCP session"));
        return;
      }
      const result = await this.handleMessage(parsed, sessionId, request, response);
      if (initializing) {
        this.sessions.add(sessionId);
        response.setHeader("Mcp-Session-Id", sessionId);
      }
      if (result === undefined) {
        response.writeHead(202).end();
      } else {
        this.writeJson(response, 200, result);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeJson(response, 400, jsonRpcError(null, -32600, message));
    }
  }

  private async handleMessage(
    message: unknown,
    sessionId: string,
    httpRequest?: http.IncomingMessage,
    response?: http.ServerResponse,
  ): Promise<Record<string, unknown> | undefined> {
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      throw new Error("Invalid MCP JSON-RPC request");
    }
    const request = message as JsonRpcRequest;
    const hasId = Object.prototype.hasOwnProperty.call(request, "id");
    if (!hasId) return undefined;
    if (!isJsonRpcId(request.id)) throw new Error("Invalid MCP request id");
    const id = request.id;
    const params = isRecord(request.params) ? request.params : {};
    switch (request.method) {
      case "initialize":
        return jsonRpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "NeoWorker Hermes Tool Host", version: "1.0.0" },
        });
      case "tools/list":
        return jsonRpcResult(id, { tools: this.options.getTools().map(toolToMcp) });
      case "tools/call":
        try {
          return jsonRpcResult(id, await this.callTool(id, params, sessionId, httpRequest, response));
        } catch (error) {
          return jsonRpcError(id, -32602, error instanceof Error ? error.message : String(error));
        }
      case "ping":
        return jsonRpcResult(id, {});
      default:
        return jsonRpcError(id, -32601, `Method not found: ${request.method}`);
    }
  }

  private async callTool(
    id: JsonRpcId,
    params: Record<string, unknown>,
    sessionId: string,
    httpRequest?: http.IncomingMessage,
    response?: http.ServerResponse,
  ): Promise<Record<string, unknown>> {
    if (!this.acceptingToolCalls) {
      return { content: [{ type: "text", text: "NeoWorker tool execution is suspended" }], isError: true };
    }
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name) throw new Error("Tool name is required");
    if (!this.options.getTools().some((tool) => tool.name === name)) {
      throw new Error(`Tool ${name} is not available for this task`);
    }
    const input = params.arguments ?? {};
    if (!isRecord(input)) throw new Error("Tool arguments must be an object");
    // Preserve the JSON-RPC id's type and task boundary. A numeric id and a
    // string id with the same text must never deduplicate different calls.
    const toolCallId = `hermes-mcp:${JSON.stringify([this.options.taskId, sessionId, typeof id, id])}`;
    const controller = new AbortController();
    this.activeCalls.add(controller);
    const abortOnRequest = () => controller.abort(new Error("MCP client disconnected"));
    const abortOnResponseClose = () => {
      if (!response?.writableEnded) abortOnRequest();
    };
    httpRequest?.once("aborted", abortOnRequest);
    response?.once("close", abortOnResponseClose);
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timeout = setTimeout(() => {
      controller.abort(new Error("NeoWorker tool host request timed out"));
    }, this.requestTimeoutMs);
    try {
      const outcome = await Promise.race([
        cancelled,
        this.options.execute({ toolName: name, toolCallId, input, signal: controller.signal }),
      ]);
      const text = buildToolResultEnvelope({
        toolUseId: toolCallId,
        toolName: name,
        status: outcome.status,
        result: outcome.result,
        error: outcome.error,
      }).modelPayload;
      return {
        content: [{ type: "text", text }],
        isError: outcome.status !== "success",
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      httpRequest?.off("aborted", abortOnRequest);
      response?.off("close", abortOnResponseClose);
      this.activeCalls.delete(controller);
    }
  }

  private readBody(request: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      request.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > this.maxRequestBytes) {
          fail(new Error("MCP request body exceeds limit"));
          return;
        }
        chunks.push(buffer);
      });
      request.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      request.on("error", (error) => fail(error));
    });
  }

  private writeJson(response: http.ServerResponse, status: number, payload: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  }
}
