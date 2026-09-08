import {
  HermesAcpClient, HermesAcpError,
  type AcpObject, type AcpRequestContext, type HermesAcpClientOptions,
} from "./hermes-acp-client";
import { HermesPermissionBridge, type HermesPermissionHandler } from "./hermes-permission-bridge";

export interface HermesSessionCheckpoint {
  schema: "neoworker_hermes_acp_v1";
  sessionId: string;
  cwd: string;
  agentVersion: string;
}
export interface HermesRuntimeOptions extends HermesAcpClientOptions {
  checkpoint?: HermesSessionCheckpoint;
  onCheckpoint?: (checkpoint: HermesSessionCheckpoint) => Promise<void>;
  onUpdate?: (update: AcpObject) => void;
  onPermissionRequest?: HermesPermissionHandler;
  permissionTimeoutMs?: number;
  onRequest?: (method: string, params: AcpObject, context: AcpRequestContext) => Promise<unknown>;
}
export interface HermesPromptResult {
  assistantText: string;
  stopReason: string;
  sessionId: string;
}

/**
 * A real Hermes ACP session, independent of NeoWorker's TurnKernel.
 * Not yet selected by the production executor. Permission callbacks are mediated
 * here; enforcing the workspace's sandbox policy requires a configured backend.
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
        if (content?.type === "text" && typeof content.text === "string") this.text += content.text;
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
      await this.client.start(this.options);
      const init = await this.client.initialize();
      if (init.protocolVersion !== 1) throw new Error("Unsupported Hermes ACP protocol version");
      const agentInfo = init.agentInfo as AcpObject | undefined;
      const agentVersion = String(agentInfo?.version ?? "unknown");
      if (this.checkpoint) {
        if (this.checkpoint.schema !== "neoworker_hermes_acp_v1" || this.checkpoint.cwd !== this.options.cwd) {
          throw new Error("Hermes checkpoint does not match this workspace");
        }
        const caps = init.agentCapabilities as AcpObject | undefined;
        if (caps?.loadSession !== true) throw new Error("Hermes cannot restore sessions");
        await this.client.loadSession(this.checkpoint.sessionId, this.options.cwd);
      } else {
        const session = await this.client.newSession(this.options.cwd);
        if (typeof session.sessionId !== "string" || !session.sessionId) throw new Error("Hermes returned no session id");
        this.checkpoint = {
          schema: "neoworker_hermes_acp_v1", sessionId: session.sessionId,
          cwd: this.options.cwd, agentVersion,
        };
      }
      // Persist the stable Hermes session handle before a prompt can run tools.
      await this.options.onCheckpoint?.({ ...this.checkpoint });
      this.connected = true;
      return { ...this.checkpoint };
    } catch (error) {
      this.client.stop();
      this.connected = false;
      throw error;
    }
  }

  prompt(text: string, signal?: AbortSignal): Promise<HermesPromptResult> {
    if (this.activePrompt) return Promise.reject(new HermesAcpError("A Hermes prompt is already running", "SESSION_BUSY"));
    this.cancelRequested = false;
    const run = async () => {
      const checkpoint = await this.connect();
      if (this.cancelRequested) return { assistantText: "", stopReason: "cancelled", sessionId: checkpoint.sessionId };
      this.text = "";
      this.acceptingUpdates = true;
      try {
        const result = await this.client.prompt(checkpoint.sessionId, text, {
          timeoutMs: this.options.timeoutMs ?? 300_000, signal,
        });
        if (typeof result.stopReason !== "string") throw new Error("Hermes prompt returned no stop reason");
        return { assistantText: this.text, stopReason: this.cancelRequested ? "cancelled" : result.stopReason, sessionId: checkpoint.sessionId };
      } catch (error) {
        // Never resubmit an interrupted prompt automatically: tools may already
        // have produced side effects. The user can restore the existing session.
        this.client.stop();
        this.connected = false;
        throw error;
      } finally {
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
    // Cancel after any in-flight initialize/session load, before prompt output.
    if (this.connecting) await this.connecting.catch(() => undefined);
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
    }
  }

  getCheckpoint(): HermesSessionCheckpoint | undefined {
    return this.checkpoint ? { ...this.checkpoint } : undefined;
  }

  close(): void {
    this.cancelRequested = true;
    this.acceptingUpdates = false;
    this.permissions.cancelPending();
    this.client.stop();
    this.connected = false;
  }
}
