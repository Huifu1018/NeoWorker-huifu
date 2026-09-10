import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type AcpObject = Record<string, unknown>;
export interface HermesAcpNotification { method: string; params: AcpObject }
export interface HermesAcpTransportEvent {
  phase:
    | "request_started"
    | "first_byte"
    | "response"
    | "error"
    | "timeout"
    | "cancelled"
    | "connection_closed"
    | "protocol_error"
    | "spawn_error";
  requestId?: string;
  method?: string;
  code?: string | number;
  reason?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  firstByteElapsedMs?: number;
  timeoutMs?: number;
  firstByteTimeoutMs?: number;
}
export interface HermesAcpClientOptions {
  command?: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Time to the first correlated response, session update or permission request. */
  firstByteTimeoutMs?: number;
  maxFrameBytes?: number;
  /** MCP servers to attach to every ACP session. */
  mcpServers?: HermesAcpMcpServer[];
  /** Structured transport telemetry; response bodies are never included. */
  onTransportEvent?: (event: HermesAcpTransportEvent) => void;
}
export type HermesAcpMcpServer = {
  type: "http" | "sse";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
} | {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};
export interface AcpRequestOptions { timeoutMs?: number; signal?: AbortSignal }
export interface AcpRequestContext { signal: AbortSignal }

export class HermesAcpError extends Error {
  constructor(message: string, readonly code: string | number, readonly data?: unknown) {
    super(message);
    this.name = "HermesAcpError";
  }
}

interface PendingRequest {
  activitySessionId?: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  firstByte(): void;
}
interface Connection {
  child: ChildProcessWithoutNullStreams;
  pending: Map<string, PendingRequest>;
  inbound: Map<string, AbortController>;
  decoder: StringDecoder;
  buffer: string;
  timeoutMs: number;
  firstByteTimeoutMs: number;
  maxFrameBytes: number;
  closed: boolean;
  onTransportEvent?: (event: HermesAcpTransportEvent) => void;
}

function object(value: unknown): value is AcpObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Bidirectional ACP transport. No filesystem or shell permissions are implied. */
export class HermesAcpClient {
  private connection?: Connection;
  private sequence = 0;
  onNotification?: (notification: HermesAcpNotification) => void;
  onRequest?: (method: string, params: AcpObject, context: AcpRequestContext) => Promise<unknown>;

  async start(options: HermesAcpClientOptions): Promise<void> {
    if (this.connection && !this.connection.closed) {
      throw new HermesAcpError("Hermes ACP is already running", "ALREADY_RUNNING");
    }
    const child = spawn(options.command || "hermes", options.args || ["acp"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // No automatic hook approvals. The bridge profile must also disable
      // workspace hooks and native tools before production task routing.
      env: { ...process.env, ...options.env, HERMES_ACCEPT_HOOKS: "0" },
    });
    const conn: Connection = {
      child, pending: new Map(), inbound: new Map(), decoder: new StringDecoder("utf8"),
      buffer: "", closed: false, timeoutMs: options.timeoutMs ?? 120_000,
      firstByteTimeoutMs: options.firstByteTimeoutMs ?? 30_000,
      maxFrameBytes: options.maxFrameBytes ?? 8 * 1024 * 1024,
      onTransportEvent: options.onTransportEvent,
    };
    this.connection = conn;
    // Drain stderr even without a log subscriber: a full pipe stalls Hermes.
    // Do not forward raw diagnostic output, which can contain provider secrets.
    child.stderr.resume();
    child.stdout.on("data", (data: Buffer) => this.consume(conn, data));
    child.stdin.on("error", (error) => this.close(conn, error));
    child.on("error", (error) => this.close(conn, error));
    child.on("exit", (code, signal) => this.close(conn,
      new HermesAcpError(`Hermes ACP exited (${code ?? signal ?? "unknown"})`, "PROCESS_EXITED")));
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { child.off("spawn", ready); child.off("error", failed); };
      const ready = () => { cleanup(); resolve(); };
      const failed = (error: Error) => {
        cleanup();
        try {
          options.onTransportEvent?.({
            phase: "spawn_error",
            reason: error.message,
            code: (error as NodeJS.ErrnoException).code,
            endedAt: Date.now(),
          });
        } catch {
          // Telemetry must never change the transport outcome.
        }
        // Normalize launcher failures so the executor can distinguish a missing
        // Hermes installation from a protocol or task failure and apply its
        // configured fallback policy.
        const code = (error as NodeJS.ErrnoException).code;
        reject(new HermesAcpError(
          code === "ENOENT"
            ? `Hermes executable not found: ${options.command || "hermes"}`
            : `Failed to start Hermes ACP: ${error.message}`,
          code === "ENOENT" ? "HERMES_UNAVAILABLE" : "PROCESS_SPAWN_FAILED",
          { cause: error.message, errno: code },
        ));
      };
      child.once("spawn", ready);
      child.once("error", failed);
    });
  }

  request<T = unknown>(method: string, params: AcpObject, options: AcpRequestOptions | number = {}): Promise<T> {
    const conn = this.connection;
    if (!conn || conn.closed) return Promise.reject(new HermesAcpError("Hermes ACP is not running", "NOT_RUNNING"));
    const opts = typeof options === "number" ? { timeoutMs: options } : options;
    if (opts.signal?.aborted) return Promise.reject(new HermesAcpError("Hermes ACP request cancelled", "CANCELLED"));
    const timeoutMs = opts.timeoutMs ?? conn.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("Invalid ACP request timeout"));
    if (!Number.isFinite(conn.firstByteTimeoutMs) || conn.firstByteTimeoutMs <= 0) {
      return Promise.reject(new Error("Invalid ACP first-byte timeout"));
    }
    const id = String(++this.sequence);
    const startedAt = Date.now();
    this.emitTransport(conn, {
      phase: "request_started",
      requestId: id,
      method,
      startedAt,
      timeoutMs,
      firstByteTimeoutMs: conn.firstByteTimeoutMs,
    });
    return new Promise<T>((resolve, reject) => {
      let firstByteSeen = false;
      let terminal = false;
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(firstByteTimer);
        opts.signal?.removeEventListener("abort", aborted);
        conn.pending.delete(id);
      };
      const emitTerminal = (
        phase: HermesAcpTransportEvent["phase"],
        extra: Partial<HermesAcpTransportEvent> = {},
      ) => {
        if (terminal) return;
        terminal = true;
        const endedAt = Date.now();
        this.emitTransport(conn, {
          phase,
          requestId: id,
          method,
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
          ...extra,
        });
      };
      const interrupt = (code: "CANCELLED" | "REQUEST_TIMEOUT" | "FIRST_BYTE_TIMEOUT") => {
        if (!conn.pending.has(id)) return;
        if (method === "session/prompt" && typeof params.sessionId === "string") {
          this.send(conn, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: params.sessionId } });
        }
        // Prompt side effects may still be in flight. Close this transport
        // and require explicit session recovery. Never resubmit a prompt.
        const failure = new HermesAcpError(
          `Hermes ACP ${method} ${code === "CANCELLED" ? "cancelled" : code === "FIRST_BYTE_TIMEOUT" ? "timed out before first response" : "timed out"}`,
          code,
        );
        const pending = conn.pending.get(id)!;
        emitTerminal(code === "CANCELLED" ? "cancelled" : "timeout", {
          code,
          reason: failure.message,
        });
        pending.reject(failure);
        this.close(conn, failure);
      };
      const aborted = () => interrupt("CANCELLED");
      const timer = setTimeout(() => interrupt("REQUEST_TIMEOUT"), timeoutMs);
      const firstByteTimer = setTimeout(() => interrupt("FIRST_BYTE_TIMEOUT"), conn.firstByteTimeoutMs);
      // Register before writing: immediate responses must find their waiter.
      conn.pending.set(id, {
        activitySessionId: (method === 'session/prompt' || method === 'session/load') && typeof params.sessionId === 'string'
          ? params.sessionId : undefined,
        resolve: (value) => {
          emitTerminal("response");
          cleanup();
          resolve(value as T);
        },
        reject: (error) => {
          emitTerminal("error", {
            code: error instanceof HermesAcpError ? error.code : undefined,
            reason: error.message,
          });
          cleanup();
          reject(error);
        },
        firstByte: () => {
          if (firstByteSeen) return;
          firstByteSeen = true;
          clearTimeout(firstByteTimer);
          this.emitTransport(conn, {
            phase: "first_byte",
            requestId: id,
            method,
            startedAt,
            endedAt: Date.now(),
            firstByteElapsedMs: Date.now() - startedAt,
          });
        },
      });
      opts.signal?.addEventListener("abort", aborted, { once: true });
      this.send(conn, { jsonrpc: "2.0", id, method, params });
    });
  }

  initialize(): Promise<AcpObject> {
    return this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "NeoWorker", version: "0.1.8" },
      clientCapabilities: {},
    });
  }

  newSession(cwd: string, mcpServers: HermesAcpMcpServer[] = []): Promise<AcpObject> {
    return this.request("session/new", { cwd, mcpServers });
  }

  loadSession(sessionId: string, cwd: string, mcpServers: HermesAcpMcpServer[] = []): Promise<AcpObject> {
    return this.request("session/load", { sessionId, cwd, mcpServers });
  }

  prompt(sessionId: string, text: string, options: AcpRequestOptions | number = 300_000): Promise<AcpObject> {
    return this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, options);
  }

  cancel(sessionId: string): void {
    const conn = this.connection;
    if (conn && !conn.closed) this.send(conn, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  stop(): void {
    if (this.connection) this.close(this.connection, new HermesAcpError("Hermes ACP stopped", "STOPPED"));
  }

  private send(conn: Connection, message: AcpObject): void {
    if (conn.closed) return;
    try {
      conn.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.close(conn, error);
      });
    } catch (error) {
      this.close(conn, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private consume(conn: Connection, data: Buffer): void {
    if (conn.closed) return;
    conn.buffer += conn.decoder.write(data);
    let newline: number;
    while ((newline = conn.buffer.indexOf("\n")) !== -1) {
      const line = conn.buffer.slice(0, newline);
      conn.buffer = conn.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > conn.maxFrameBytes) return this.protocolFailure(conn, "ACP frame exceeds limit");
      if (line.trim()) this.handleLine(conn, line);
      if (conn.closed) return;
    }
    if (Buffer.byteLength(conn.buffer) > conn.maxFrameBytes) this.protocolFailure(conn, "ACP frame exceeds limit");
  }

  private handleLine(conn: Connection, line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { return this.protocolFailure(conn, "Invalid ACP JSON"); }
    if (!object(message) || message.jsonrpc !== "2.0") return this.protocolFailure(conn, "Invalid ACP envelope");
    if (typeof message.method === "string") {
      if (message.params !== undefined && !object(message.params)) return this.protocolFailure(conn, "Invalid ACP params");
      const params = (message.params ?? {}) as AcpObject;
      // ACP streams updates and approvals before the final JSON-RPC response.
      // Only traffic belonging to this pending session counts as a first
      // response; unrelated notifications must not keep a silent task alive.
      const sessionActivity =
        (message.method === 'session/update' && message.id === undefined &&
          object(params.update) && typeof params.update.sessionUpdate === 'string') ||
        (message.method === 'session/request_permission' &&
          (typeof message.id === 'string' || typeof message.id === 'number'));
      if (sessionActivity && typeof params.sessionId === 'string') {
        for (const request of conn.pending.values()) {
          if (request.activitySessionId === params.sessionId) request.firstByte();
        }
      }
      if (typeof message.id === "string" || typeof message.id === "number") {
        void this.handleRequest(conn, message.id, message.method, params);
      } else if (message.id === undefined) {
        try { this.onNotification?.({ method: message.method, params }); }
        catch { this.protocolFailure(conn, "ACP notification handler failed"); }
      } else this.protocolFailure(conn, "Invalid ACP request id");
      return;
    }
    if (typeof message.id !== "string" && typeof message.id !== "number") return this.protocolFailure(conn, "Invalid ACP response id");
    const pending = conn.pending.get(String(message.id));
    if (!pending) return; // Late response or server-issued request id.
    pending.firstByte();
    if (object(message.error)) {
      pending.reject(new HermesAcpError(String(message.error.message ?? "ACP request failed"),
        typeof message.error.code === "number" ? message.error.code : "REMOTE_ERROR", message.error.data));
    } else if ("result" in message) pending.resolve(message.result);
    else this.protocolFailure(conn, "ACP response has no result or error");
  }

  private async handleRequest(conn: Connection, id: string | number, method: string, params: AcpObject): Promise<void> {
    const controller = new AbortController();
    const key = `${typeof id}:${id}`;
    if (conn.inbound.has(key)) return this.protocolFailure(conn, "Duplicate ACP request id");
    conn.inbound.set(key, controller);
    try {
      if (!this.onRequest) {
        if (method === "session/request_permission") {
          this.send(conn, { jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
        } else this.send(conn, { jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported client method" } });
        return;
      }
      const result = await this.onRequest(method, params, { signal: controller.signal });
      if (!controller.signal.aborted) this.send(conn, { jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const unsupported = error instanceof HermesAcpError && error.code === -32601;
      if (!controller.signal.aborted) this.send(conn, { jsonrpc: "2.0", id, error: {
        code: unsupported ? -32601 : -32603,
        message: unsupported ? "Unsupported client method" : "Client request failed",
      } });
    } finally {
      conn.inbound.delete(key);
    }
  }

  private protocolFailure(conn: Connection, message: string): void {
    this.emitTransport(conn, {
      phase: "protocol_error",
      reason: message,
      endedAt: Date.now(),
    });
    this.close(conn, new HermesAcpError(message, "PROTOCOL_ERROR"));
  }

  private close(conn: Connection, error: Error): void {
    if (conn.closed) return;
    conn.closed = true;
    if (this.connection === conn) this.connection = undefined;
    this.emitTransport(conn, {
      phase: "connection_closed",
      code: error instanceof HermesAcpError ? error.code : undefined,
      reason: error.message,
      endedAt: Date.now(),
    });
    for (const request of conn.pending.values()) request.reject(error);
    conn.pending.clear();
    for (const request of conn.inbound.values()) request.abort();
    conn.inbound.clear();
    conn.buffer = "";
    conn.child.stdin.end();
    if (conn.child.exitCode === null && conn.child.signalCode === null) {
      conn.child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (conn.child.exitCode === null && conn.child.signalCode === null) conn.child.kill("SIGKILL");
      }, 1500);
      force.unref();
      conn.child.once("exit", () => clearTimeout(force));
    }
  }

  private emitTransport(
    conn: Connection,
    event: HermesAcpTransportEvent,
  ): void {
    try {
      conn.onTransportEvent?.(event);
    } catch {
      // Logging hooks are observers. A faulty observer must not break ACP.
    }
  }
}
