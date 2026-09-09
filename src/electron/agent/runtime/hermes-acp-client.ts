import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type AcpObject = Record<string, unknown>;
export interface HermesAcpNotification { method: string; params: AcpObject }
export interface HermesAcpClientOptions {
  command?: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxFrameBytes?: number;
}
export interface AcpRequestOptions { timeoutMs?: number; signal?: AbortSignal }
export interface AcpRequestContext { signal: AbortSignal }

export class HermesAcpError extends Error {
  constructor(message: string, readonly code: string | number, readonly data?: unknown) {
    super(message);
    this.name = "HermesAcpError";
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}
interface Connection {
  child: ChildProcessWithoutNullStreams;
  pending: Map<string, PendingRequest>;
  inbound: Map<string, AbortController>;
  decoder: StringDecoder;
  buffer: string;
  timeoutMs: number;
  maxFrameBytes: number;
  closed: boolean;
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
      maxFrameBytes: options.maxFrameBytes ?? 8 * 1024 * 1024,
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
      const failed = (error: Error) => { cleanup(); reject(error); };
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
    const id = String(++this.sequence);
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", aborted);
        conn.pending.delete(id);
      };
      const interrupt = (code: "CANCELLED" | "REQUEST_TIMEOUT") => {
        if (!conn.pending.has(id)) return;
        if (method === "session/prompt" && typeof params.sessionId === "string") {
          this.send(conn, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: params.sessionId } });
        }
        // Prompt side effects may still be in flight. Close this transport
        // and require explicit session recovery. Never resubmit a prompt.
        const failure = new HermesAcpError(`Hermes ACP ${method} ${code === "CANCELLED" ? "cancelled" : "timed out"}`, code);
        const pending = conn.pending.get(id)!;
        pending.reject(failure);
        this.close(conn, failure);
      };
      const aborted = () => interrupt("CANCELLED");
      const timer = setTimeout(() => interrupt("REQUEST_TIMEOUT"), timeoutMs);
      // Register before writing: immediate responses must find their waiter.
      conn.pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value as T); },
        reject: (error) => { cleanup(); reject(error); },
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

  newSession(cwd: string): Promise<AcpObject> {
    return this.request("session/new", { cwd, mcpServers: [] });
  }

  loadSession(sessionId: string, cwd: string): Promise<AcpObject> {
    return this.request("session/load", { sessionId, cwd, mcpServers: [] });
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
    this.close(conn, new HermesAcpError(message, "PROTOCOL_ERROR"));
  }

  private close(conn: Connection, error: Error): void {
    if (conn.closed) return;
    conn.closed = true;
    if (this.connection === conn) this.connection = undefined;
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
}
