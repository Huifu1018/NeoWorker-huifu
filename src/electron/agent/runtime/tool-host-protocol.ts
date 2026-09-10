import { createHash, randomUUID } from "node:crypto";
import type { ToolResultEnvelopeStatus } from "../../../shared/types";
import type { ToolExecutionCoordinator, CoordinatedToolExecutionResult } from "./ToolExecutionCoordinator";
import type { ToolInvocationContext } from "./ToolInvocationContext";
import { stableJsonStringify } from "../../utils/json-utils";

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

export interface PersistedToolHostRecord {
  status: "request" | "running" | "deduplicated" | "response";
  fingerprint: string;
  outcome?: CoordinatedToolExecutionResult;
}

interface CachedToolExecution {
  fingerprint: string;
  promise: Promise<CoordinatedToolExecutionResult>;
}

export class ToolHostRequestConflictError extends Error {
  readonly code = "TOOL_CALL_ID_CONFLICT";

  constructor(toolCallId: string) {
    super(`Tool call ${toolCallId} was retransmitted with different tool or input`);
    this.name = "ToolHostRequestConflictError";
  }
}

export class ToolHostUnknownOutcomeError extends Error {
  readonly code = "TOOL_CALL_OUTCOME_UNKNOWN";

  constructor(toolCallId: string) {
    super(`Tool call ${toolCallId} was previously dispatched but has no persisted result; refusing automatic replay`);
    this.name = "ToolHostUnknownOutcomeError";
  }
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
 * Host-owned tool boundary used by NeoWorker's native runtime and model-only
 * providers. The coordinator remains the single place that applies approval,
 * sandbox, timeout, logging and bounded-result policy.
 */
export class NeoWorkerToolHost {
  private readonly inFlightOrCompleted = new Map<string, CachedToolExecution>();

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
    // Encode both components structurally so task/tool IDs containing ':'
    // cannot alias another pair (for example ['a:b', 'c'] vs ['a', 'b:c']).
    const executionKey = stableJsonStringify([context.taskId, normalized.toolCallId], { sortKeys: false });
    const fingerprint = createHash("sha256")
      .update(
        `${normalized.toolName}\n${String(stableJsonStringify(normalized.input, { sortKeys: true, maxOutputChars: 500_000 }))}`,
      )
      .digest("hex");
    const startedAt = Date.now();
    const emitHostLifecycle = (status: "request" | "deduplicated" | "response", extra: Record<string, unknown> = {}) => {
      context.emitEvent?.("log", {
        metric: "tool_host_lifecycle",
        taskId: context.taskId,
        phase: context.phase,
        requestId: normalized.requestId,
        toolCallId: normalized.toolCallId,
        tool: normalized.toolName,
        idempotencyKey: executionKey,
        fingerprint,
        status,
        startedAt,
        ...extra,
      });
    };
    const cached = this.inFlightOrCompleted.get(executionKey);
    const persisted = !cached
      ? (context.loadToolHostRecord?.(normalized.toolCallId) as PersistedToolHostRecord | undefined)
      : undefined;
    emitHostLifecycle("request", { schemaVersion: normalized.schemaVersion });
    if (cached && cached.fingerprint !== fingerprint) {
      // A stable toolCallId is an idempotency key. Reusing it for another
      // operation would make a transport retry indistinguishable from a new
      // side effect, so fail closed instead of returning the old result.
      throw new ToolHostRequestConflictError(normalized.toolCallId);
    }
    let outcomePromise = cached?.promise;
    if (cached) emitHostLifecycle("deduplicated");
    if (!cached && persisted) {
        if (persisted.fingerprint !== fingerprint) {
          throw new ToolHostRequestConflictError(normalized.toolCallId);
        }
        if (persisted.status !== "response" || !persisted.outcome) {
          throw new ToolHostUnknownOutcomeError(normalized.toolCallId);
        }
        outcomePromise = Promise.resolve(persisted.outcome);
    }
    if (!outcomePromise) {
      outcomePromise = this.coordinator.executeTool(
        normalized.toolName,
        normalized.input,
        context,
        normalized.toolCallId,
      );
      // Keep rejected promises too. Once a side-effecting coordinator call
      // has started, its final state is unknown; automatic replay is unsafe.
      this.inFlightOrCompleted.set(executionKey, { fingerprint, promise: outcomePromise });
    }
    try {
      const outcome = await outcomePromise;
      const error = outcome.error
        ? {
            message: String((outcome.error as { message?: unknown })?.message || outcome.error),
            ...((outcome.error as { code?: unknown })?.code
              ? { code: String((outcome.error as { code: unknown }).code) }
              : {}),
          }
        : undefined;
      const endedAt = Date.now();
      emitHostLifecycle("response", {
        responseStatus: outcome.envelope.status,
        endedAt,
        durationMs: endedAt - startedAt,
        outcome,
      });
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
    } catch (error) {
      const endedAt = Date.now();
      const errorRecord = error && typeof error === "object"
        ? error as { message?: unknown; code?: unknown; name?: unknown }
        : {};
      emitHostLifecycle("response", {
        responseStatus: "error",
        endedAt,
        durationMs: endedAt - startedAt,
        error: String(errorRecord.message || error || "Tool host execution failed"),
        ...(typeof errorRecord.code === "string" && errorRecord.code.trim()
          ? { errorType: errorRecord.code.trim() }
          : typeof errorRecord.name === "string" && errorRecord.name.trim()
            ? { errorType: errorRecord.name.trim() }
            : {}),
      });
      throw error;
    }
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
