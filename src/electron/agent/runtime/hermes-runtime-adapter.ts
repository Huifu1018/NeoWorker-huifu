import {
  HermesAcpClient, HermesAcpError,
  type AcpObject, type AcpRequestContext, type HermesAcpClientOptions,
  type HermesAcpMcpServer,
} from "./hermes-acp-client";
import { HermesPermissionBridge, type HermesPermissionHandler } from "./hermes-permission-bridge";
import { HermesToolHostMcpServer, type HermesToolHostMcpOptions } from "./hermes-tool-host-mcp";

export interface HermesSessionCheckpoint {
  schema: "neoworker_hermes_acp_v1";
  sessionId: string;
  cwd: string;
  agentVersion: string;
  /** Missing means a legacy session using Hermes-native tools. */
  toolOwnership?: "neoworker" | "hermes";
}
export interface HermesRuntimeOptions extends HermesAcpClientOptions {
  checkpoint?: HermesSessionCheckpoint;
  onCheckpoint?: (checkpoint: HermesSessionCheckpoint) => Promise<void>;
  onUpdate?: (update: AcpObject) => void;
  onPermissionRequest?: HermesPermissionHandler;
  permissionTimeoutMs?: number;
  onRequest?: (method: string, params: AcpObject, context: AcpRequestContext) => Promise<unknown>;
  /**
   * Optional task-scoped NeoWorker Tool Host exposed to Hermes through MCP.
   * The caller remains responsible for disabling Hermes native tools when
   * selecting this mode; otherwise duplicate native and host-owned tools may
   * be offered by the ACP runtime.
   */
  hostToolBridge?: HermesToolHostMcpOptions;
}
export interface HermesPromptResult {
  assistantText: string;
  stopReason: string;
  sessionId: string;
}

// Keep a single task's accumulated assistant transcript bounded. Individual
// ACP frames are already capped by HermesAcpClient, but a long-running session
// can otherwise append an unbounded number of valid chunks in the Electron
// process.
const MAX_ASSISTANT_TEXT_CHARS = 2_000_000;
const ASSISTANT_TEXT_TRUNCATION_MARKER = "\n[Hermes response truncated by NeoWorker]\n";

/**
 * A real Hermes ACP session, independent of NeoWorker's TurnKernel.
 * The production executor owns the host-side policy boundary; this adapter keeps
 * Hermes protocol details isolated from Electron business code.
 */
export class HermesRuntimeAdapter {
  private readonly client = new HermesAcpClient();
  private checkpoint?: HermesSessionCheckpoint;
  private activePrompt?: Promise<HermesPromptResult>;
  private text = "";
  private acceptingUpdates = false;
  private connected = false;
  private connecting?: Promise<HermesSessionCheckpoint>;
  private readonly permissions: HermesPermissionBridge;
  private cancelRequested = false;
  private paused = false;
  private hostToolServer?: HermesToolHostMcpServer;
  private hostToolServerConfig?: HermesAcpMcpServer;

  constructor(private readonly options: HermesRuntimeOptions) {
    this.checkpoint = options.checkpoint;
    this.permissions = new HermesPermissionBridge(options.onPermissionRequest, options.permissionTimeoutMs);
    this.client.onRequest = (method, params, context) => {
      if (method === "session/request_permission") {
        return this.permissions.request(params, this.acceptingUpdates ? this.checkpoint?.sessionId : undefined, context);
      }
      if (options.onRequest) return options.onRequest(method, params, context);
      return Promise.reject(new HermesAcpError("Unsupported client method", -32601));
    };
    this.client.onNotification = ({ method, params }) => {
      if (method !== "session/update" || params.sessionId !== this.checkpoint?.sessionId) return;
      const update = params.update;
      if (!update || typeof update !== "object" || Array.isArray(update)) return;
      const value = update as AcpObject;
      if (this.acceptingUpdates && value.sessionUpdate === "agent_message_chunk") {
        const content = value.content as AcpObject | undefined;
        if (content?.type === "text" && typeof content.text === "string") {
          if (this.text.length < MAX_ASSISTANT_TEXT_CHARS) {
            const remaining = MAX_ASSISTANT_TEXT_CHARS - this.text.length;
            this.text += content.text.slice(0, remaining);
            if (content.text.length > remaining) this.text += ASSISTANT_TEXT_TRUNCATION_MARKER;
          }
        }
      }
      this.options.onUpdate?.(value);
    };
  }

  connect(): Promise<HermesSessionCheckpoint> {
    if (this.connected && this.checkpoint) return Promise.resolve({ ...this.checkpoint });
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async open(): Promise<HermesSessionCheckpoint> {
    try {
      if (this.options.hostToolBridge && !this.hostToolServer) {
        this.hostToolServer = new HermesToolHostMcpServer({
          ...this.options.hostToolBridge,
          taskId: this.options.hostToolBridge.taskId,
        });
        this.hostToolServer.suspendToolCalls();
        const endpoint = await this.hostToolServer.start();
        this.hostToolServerConfig = {
          type: "http",
          name: "neoworker",
          url: endpoint.url,
          headers: endpoint.headers,
        };
      }
      const launchOptions = this.hostToolServerConfig
        ? {
            ...this.options,
            env: {
              ...this.options.env,
              // The MCP endpoint is task-local. Inherited HTTP proxies must
              // never route loopback tool calls through an external proxy.
              NO_PROXY: this.loopbackNoProxy("NO_PROXY"),
              no_proxy: this.loopbackNoProxy("no_proxy"),
            },
          }
        : this.options;
      await this.client.start(launchOptions);
      const init = await this.client.initialize();
      if (init.protocolVersion !== 1) throw new Error("Unsupported Hermes ACP protocol version");
      const agentInfo = init.agentInfo as AcpObject | undefined;
      const agentVersion = String(agentInfo?.version ?? "unknown");
      if (this.checkpoint) {
        if (this.checkpoint.schema !== "neoworker_hermes_acp_v1" || this.checkpoint.cwd !== this.options.cwd) {
          throw new Error("Hermes checkpoint does not match this workspace");
        }
        const ownership = this.checkpoint.toolOwnership ?? "hermes";
        if (ownership !== (this.options.hostToolBridge ? "neoworker" : "hermes")) {
          throw new Error("Hermes checkpoint tool ownership does not match this runtime");
        }
        const caps = init.agentCapabilities as AcpObject | undefined;
        if (caps?.loadSession !== true) throw new Error("Hermes cannot restore sessions");
        await this.client.loadSession(this.checkpoint.sessionId, this.options.cwd, this.getMcpServers());
      } else {
        const session = await this.client.newSession(this.options.cwd, this.getMcpServers());
        if (typeof session.sessionId !== "string" || !session.sessionId) throw new Error("Hermes returned no session id");
        this.checkpoint = {
          schema: "neoworker_hermes_acp_v1", sessionId: session.sessionId,
          cwd: this.options.cwd, agentVersion,
          toolOwnership: this.options.hostToolBridge ? "neoworker" : "hermes",
        };
      }
      // Persist the stable Hermes session handle before a prompt can run tools.
      await this.options.onCheckpoint?.({ ...this.checkpoint });
      this.connected = true;
      return { ...this.checkpoint };
    } catch (error) {
      this.client.stop();
      await this.hostToolServer?.stop();
      this.hostToolServer = undefined;
      this.hostToolServerConfig = undefined;
      this.connected = false;
      throw error;
    }
  }

  prompt(text: string, signal?: AbortSignal): Promise<HermesPromptResult> {
    if (this.activePrompt) return Promise.reject(new HermesAcpError("A Hermes prompt is already running", "SESSION_BUSY"));
    const prePaused = this.paused;
    this.cancelRequested = prePaused;
    if (!prePaused) this.paused = false;
    const run = async () => {
      // An AbortSignal can fire while ACP is still connecting or while the
      // remote agent is waiting for a tool response.  Suspend the host before
      // the transport observes the abort so no late file/Shell call can start
      // after the caller has asked us to stop.
      let signalAborted = false;
      const onAbort = () => {
        signalAborted = true;
        this.cancelRequested = true;
        this.acceptingUpdates = false;
        this.permissions.cancelPending();
        this.hostToolServer?.suspendToolCalls();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      try {
        const checkpoint = await this.connect();
        if (signalAborted || signal?.aborted) {
          // Keep AbortSignal cancellation observable as a rejected prompt;
          // callers use the error code to distinguish it from pause(), whose
          // internal cancel intentionally resolves with stopReason=cancelled.
          throw new HermesAcpError("Hermes ACP prompt cancelled", "CANCELLED");
        }
        if (this.cancelRequested) {
          return { assistantText: "", stopReason: "cancelled", sessionId: checkpoint.sessionId };
        }
        this.hostToolServer?.resumeToolCalls();
        this.text = "";
        this.acceptingUpdates = true;
        const result = await this.client.prompt(checkpoint.sessionId, text, {
          timeoutMs: this.options.timeoutMs ?? 300_000, signal,
        });
        const meta = result._meta as { neoworker?: { runtimeError?: { code?: unknown; message?: unknown } } } | undefined;
        const runtimeError = meta?.neoworker?.runtimeError;
        if (runtimeError && typeof runtimeError.message === "string") {
          throw new HermesAcpError(
            runtimeError.message,
            typeof runtimeError.code === "string" ? runtimeError.code : "HERMES_RUNTIME_ERROR",
            runtimeError,
          );
        }
        if (typeof result.stopReason !== "string") throw new Error("Hermes prompt returned no stop reason");
        return { assistantText: this.text, stopReason: this.cancelRequested ? "cancelled" : result.stopReason, sessionId: checkpoint.sessionId };
      } catch (error) {
        // Never resubmit an interrupted prompt automatically: tools may already
        // have produced side effects. The user can restore the existing session.
        this.client.stop();
        this.connected = false;
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        this.hostToolServer?.suspendToolCalls();
        this.acceptingUpdates = false;
        this.permissions.cancelPending();
      }
    };
    this.activePrompt = run().finally(() => { this.activePrompt = undefined; });
    return this.activePrompt;
  }

  async cancel(): Promise<void> {
    const active = this.activePrompt;
    if (!active) return;
    this.cancelRequested = true;
    this.acceptingUpdates = false;
    this.permissions.cancelPending();
    this.hostToolServer?.suspendToolCalls();
    // Cancel after any in-flight initialize/session load, before prompt output.
    if (this.connecting) await this.connecting.catch(() => undefined);
    // ACP cancellation is advisory for the remote Agent Loop. Abort the
    // task-scoped MCP calls immediately so a tool that ignores ACP cancel
    // cannot keep a NeoWorker side effect alive until the hard close timeout.
    this.hostToolServer?.suspendToolCalls();
    if (this.checkpoint) this.client.cancel(this.checkpoint.sessionId);
    let force: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        active.catch(() => undefined),
        new Promise<void>((resolve) => {
          force = setTimeout(() => { this.close(); resolve(); }, 3000);
        }),
      ]);
    } finally {
      if (force) clearTimeout(force);
      // A cancelled Hermes process may still emit updates or initiate a late
      // MCP call. Resume the persisted session on a fresh transport.
      if (this.options.hostToolBridge) this.close();
    }
  }

  /**
   * Pause at a safe protocol boundary. Hermes has no portable pause primitive,
   * so an active prompt is cancelled without discarding its persisted session;
   * resume() continues that session and never replays the interrupted request.
   */
  async pause(): Promise<void> {
    this.paused = true;
    await this.cancel();
  }

  async resume(prompt = "Continue the task from the last checkpoint. Do not repeat side effects whose result is unknown."): Promise<HermesPromptResult> {
    if (!this.paused) throw new HermesAcpError("Hermes session is not paused", "SESSION_NOT_PAUSED");
    this.paused = false;
    return this.prompt(prompt);
  }

  isPaused(): boolean {
    return this.paused;
  }

  getCheckpoint(): HermesSessionCheckpoint | undefined {
    return this.checkpoint ? { ...this.checkpoint } : undefined;
  }

  close(): void {
    this.cancelRequested = true;
    this.acceptingUpdates = false;
    this.permissions.cancelPending();
    this.client.stop();
    void this.hostToolServer?.stop();
    this.hostToolServer = undefined;
    this.hostToolServerConfig = undefined;
    this.connected = false;
  }

  private getMcpServers(): HermesAcpMcpServer[] {
    const configured = Array.isArray(this.options.mcpServers) ? this.options.mcpServers : [];
    return this.hostToolServerConfig ? [...configured, this.hostToolServerConfig] : configured;
  }

  private loopbackNoProxy(key: "NO_PROXY" | "no_proxy"): string {
    const current = this.options.env?.[key] ?? process.env[key] ?? "";
    return [...new Set([...current.split(",").map((part) => part.trim()).filter(Boolean), "127.0.0.1", "localhost", "::1"])].join(",");
  }
}
