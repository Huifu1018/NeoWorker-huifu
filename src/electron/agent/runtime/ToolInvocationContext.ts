import type { ToolPolicyContext } from "../tool-policy-engine";

export type ToolLifecycleStatus =
  | "request"
  | "approval"
  | "running"
  | "result"
  | "failed"
  | "timed_out"
  | "cancelled";

export type ToolLifecycleEmitter = (
  status: ToolLifecycleStatus,
  extra?: Record<string, unknown>,
) => void;

export interface ToolBatchCorrelationMetaLite {
  toolUseId: string;
  toolCallIndex: number;
  phase: "step" | "follow_up";
  groupId?: string;
}

export interface ToolInvocationContext {
  taskId: string;
  stepId?: string;
  phase: "step" | "follow_up";
  targetPaths?: string[];
  followUp?: boolean;
  toolPolicyContext?: ToolPolicyContext;
  signal?: AbortSignal;
  emitEvent?: (type: string, payload: Any) => void;
  beginHeartbeat?: (toolName: string, toolTimeoutMs: number, input: unknown) => (() => void) | void;
  timeoutMsResolver?: (toolName: string, input: unknown) => number;
  /**
   * Read the last persisted Tool Host lifecycle record for a tool call. A
   * response may be replayed safely; a request without a response is treated
   * as an unknown side effect and must never be re-executed automatically.
   */
  loadToolHostRecord?: (toolCallId: string) => unknown;
  workspaceRecovery?: (args: {
    toolName: string;
    input: Any;
    errorMessage: string;
    toolTimeoutMs: number;
    stepId?: string;
    targetPaths?: string[];
    followUp?: boolean;
  }) => Promise<{ recovered: boolean; result?: Any; input?: Any }>;
}
