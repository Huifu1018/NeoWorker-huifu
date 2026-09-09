import { randomUUID } from "node:crypto";
import type { ToolResultEnvelopeStatus } from "../../../shared/types";
import type { ToolExecutionCoordinator, CoordinatedToolExecutionResult } from "./ToolExecutionCoordinator";
import type { ToolInvocationContext } from "./ToolInvocationContext";

/** Versioned boundary between an agent runtime and NeoWorker's local tools. */
export const TOOL_HOST_SCHEMA_VERSION = "neoworker_tool_host_v1" as const;

export interface ToolHostRequest {
  requestId: string;
  toolCallId: string;
  schemaVersion: typeof TOOL_HOST_SCHEMA_VERSION;
  toolName: string;
  input: unknown;
  checkpoint?: Record<string, unknown>;
}

export interface ToolHostResponse {
  requestId: string;
  toolCallId: string;
  schemaVersion: typeof TOOL_HOST_SCHEMA_VERSION;
  status: ToolResultEnvelopeStatus;
  result?: unknown;
  error?: { message: string; code?: string };
  checkpoint?: Record<string, unknown>;
}

export interface ToolHostExecution {
  response: ToolHostResponse;
  outcome: CoordinatedToolExecutionResult;
}

function requiredId(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`Tool host ${label} is required`);
  return normalized;
}

function normalizeRequest(request: ToolHostRequest): ToolHostRequest {
  if (request.schemaVersion !== TOOL_HOST_SCHEMA_VERSION) {
    throw new Error(`Unsupported tool host schema: ${String(request.schemaVersion)}`);
  }
  const requestId = requiredId(request.requestId, "requestId");
  const toolCallId = requiredId(request.toolCallId, "toolCallId");
  const toolName = requiredId(request.toolName, "toolName");
  return { ...request, requestId, toolCallId, toolName };
}

/**
 * Host-owned tool boundary used by NeoWorker's native runtime and Gateway
 * providers. The coordinator remains the single place that applies approval,
 * sandbox, timeout, logging and bounded-result policy.
 */
export class NeoWorkerToolHost {
  private readonly inFlightOrCompleted = new Map<string, Promise<CoordinatedToolExecutionResult>>();

  constructor(private readonly coordinator: ToolExecutionCoordinator) {}

  async execute(
    request: ToolHostRequest,
    context: ToolInvocationContext,
  ): Promise<ToolHostExecution> {
    const normalized = normalizeRequest(request);
    // A model may resend the same tool call after a transport timeout. Keep
    // one promise per task/toolCallId so a side effect is never executed twice.
    // Each transport attempt keeps its own requestId; callers correlate
    // retries by the stable toolCallId.
    const executionKey = `${context.taskId}:${normalized.toolCallId}`;
    let outcomePromise = this.inFlightOrCompleted.get(executionKey);
    if (!outcomePromise) {
      outcomePromise = this.coordinator.executeTool(
        normalized.toolName,
        normalized.input,
        context,
        normalized.toolCallId,
      );
      this.inFlightOrCompleted.set(executionKey, outcomePromise);
      void outcomePromise.catch(() => {
        // Do not poison a key if an adapter-level exception escapes the
        // coordinator; a later transport retry may safely attempt the call.
        if (this.inFlightOrCompleted.get(executionKey) === outcomePromise) {
          this.inFlightOrCompleted.delete(executionKey);
        }
      });
    }
    const outcome = await outcomePromise;
    const error = outcome.error
      ? {
          message: String((outcome.error as { message?: unknown })?.message || outcome.error),
          ...((outcome.error as { code?: unknown })?.code
            ? { code: String((outcome.error as { code: unknown }).code) }
            : {}),
        }
      : undefined;
    return {
      outcome,
      response: {
        requestId: normalized.requestId,
        toolCallId: normalized.toolCallId,
        schemaVersion: TOOL_HOST_SCHEMA_VERSION,
        status: outcome.envelope.status,
        ...(outcome.error ? { error } : { result: outcome.envelope.structuredData }),
        ...(normalized.checkpoint ? { checkpoint: normalized.checkpoint } : {}),
      },
    };
  }
}

export function createToolHostRequest(params: {
  taskId: string;
  toolName: string;
  toolCallId?: string;
  input: unknown;
  checkpoint?: Record<string, unknown>;
}): ToolHostRequest {
  const taskId = requiredId(params.taskId, "taskId");
  const toolName = requiredId(params.toolName, "toolName");
  const toolCallId = params.toolCallId?.trim() || `${toolName}:${randomUUID()}`;
  return {
    requestId: `${taskId}:${randomUUID()}`,
    toolCallId,
    schemaVersion: TOOL_HOST_SCHEMA_VERSION,
    toolName,
    input: params.input,
    ...(params.checkpoint ? { checkpoint: params.checkpoint } : {}),
  };
}
