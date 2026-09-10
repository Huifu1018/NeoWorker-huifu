import type { ToolPolicyTrace } from "../../../shared/types";
import type { ToolRegistry } from "../tools/registry";
import type {
  ToolInvocationContext,
  ToolLifecycleEmitter,
  ToolLifecycleStatus,
} from "./ToolInvocationContext";
import { buildToolResultEnvelope } from "./tool-result-envelope";
import { stableJsonStringify } from "../../utils/json-utils";

export interface CoordinatedToolExecutionResult {
  result?: Any;
  error?: unknown;
  durationMs: number;
  resultJson: string;
  envelope: ReturnType<typeof buildToolResultEnvelope>;
  policyTrace?: ToolPolicyTrace;
}

export class ToolExecutionCoordinator {
  constructor(private readonly toolRegistry: ToolRegistry) {}

  private getResultRecord(result: unknown): Record<string, unknown> {
    return result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  }

  private getResultExitCode(result: unknown): number | null | undefined {
    const value = this.getResultRecord(result).exitCode;
    return typeof value === "number" || value === null ? value : undefined;
  }

  private getResultTerminationReason(result: unknown): string | undefined {
    const value = this.getResultRecord(result).terminationReason;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private getErrorType(error: unknown): string | undefined {
    if (!error || typeof error !== "object") return undefined;
    const record = error as { code?: unknown; name?: unknown };
    if (typeof record.code === "string" && record.code.trim()) {
      return record.code.trim();
    }
    if (typeof record.name === "string" && record.name.trim()) {
      return record.name.trim();
    }
    return undefined;
  }

  private getModelReminder(result: unknown): string | undefined {
    if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
    const reminder = (result as { immediateReminder?: unknown }).immediateReminder;
    return typeof reminder === "string" && reminder.trim().length > 0 ? reminder.trim() : undefined;
  }

  async executeTool(
    toolName: string,
    input: Any,
    context: ToolInvocationContext,
    toolUseId = `${toolName}:${Date.now()}`,
  ): Promise<CoordinatedToolExecutionResult> {
    const startedAt = Date.now();
    const toolTimeoutMs = context.timeoutMsResolver?.(toolName, input) ?? 30_000;
    const idempotencyKey = stableJsonStringify(
      [context.taskId, toolUseId],
      { sortKeys: false },
    );
    const stopHeartbeat = context.beginHeartbeat?.(toolName, toolTimeoutMs, input);
    const emitLifecycle: ToolLifecycleEmitter = (
      status: ToolLifecycleStatus,
      extra: Record<string, unknown> = {},
    ) => {
      context.emitEvent?.("log", {
        metric: "tool_lifecycle",
        taskId: context.taskId,
        tool: toolName,
        toolCallId: toolUseId,
        idempotencyKey,
        phase: context.phase,
        ...(context.stepId ? { stepId: context.stepId } : {}),
        status,
        startedAt,
        ...extra,
      });
    };
    emitLifecycle("request", { timeoutMs: toolTimeoutMs });
    emitLifecycle("running", { timeoutMs: toolTimeoutMs });

    try {
      const executionWithRuntime = await this.toolRegistry.executeToolWithRuntime(toolName, input, {
        toolPolicyContext: context.toolPolicyContext,
        toolUseId,
        signal: context.signal,
        timeoutMs: toolTimeoutMs,
        targetPaths: context.targetPaths,
        followUp: context.followUp,
        stepId: context.stepId,
        emitLifecycle,
      });
      const result = executionWithRuntime?.result;
      const policyTrace = executionWithRuntime?.policyTrace;
      const modelReminder = this.getModelReminder(result);
      const cancelled =
        context.signal?.aborted === true ||
        (result &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          ((result as { terminationReason?: unknown }).terminationReason === "user_stopped" ||
            (result as { terminationReason?: unknown }).terminationReason === "cancelled"));
      const envelope = buildToolResultEnvelope({
        toolUseId,
        toolName,
        status: cancelled ? "cancelled" : result?.success === false ? "error" : "success",
        result,
        retryable: false,
        policyTrace,
        modelReminder,
        userSummary: `${toolName} ${cancelled ? "cancelled" : result?.success === false ? "failed" : "completed"}`,
      });
      const succeeded = !cancelled && result?.success !== false;
      const endedAt = Date.now();
      emitLifecycle(cancelled ? "cancelled" : succeeded ? "result" : "failed", {
        endedAt,
        durationMs: endedAt - startedAt,
        ...(this.getResultExitCode(result) !== undefined
          ? { exitCode: this.getResultExitCode(result) }
          : {}),
        ...(this.getResultTerminationReason(result)
          ? { terminationReason: this.getResultTerminationReason(result) }
          : {}),
        ...(succeeded ? {} : { error: this.getResultError(result) }),
        ...(succeeded ? {} : { errorType: "tool_result_error" }),
      });
      context.emitEvent?.("log", {
        metric: "tool_runtime_trace",
        taskId: context.taskId,
        tool: toolName,
        toolUseId,
        idempotencyKey,
        envelope,
        policyTrace,
      });
      return {
        result,
        durationMs: endedAt - startedAt,
        resultJson: envelope.modelPayload,
        policyTrace,
        envelope,
      };
    } catch (error) {
      const errorMessage = String((error as { message?: string })?.message || error || "Tool execution failed");
      const initiallyCancelled = context.signal?.aborted === true || /cancel|abort/i.test(errorMessage);
      const timedOut = /timed? ?out|timeout/i.test(errorMessage);
      // Cancellation is a terminal control-flow decision. Do not enter path
      // recovery after an abort: recovery can perform filesystem probes or
      // retry a tool, which makes cancellation slow and may repeat a side
      // effect after the caller has already asked us to stop.
      const recovery = initiallyCancelled
        ? undefined
        : await context.workspaceRecovery?.({
            toolName,
            input,
            errorMessage: String((error as { message?: string })?.message || error || ""),
            toolTimeoutMs,
            stepId: context.stepId,
            targetPaths: context.targetPaths,
            followUp: context.followUp,
          });
      // The abort can race with an already-running recovery probe. Re-check
      // after the await so a late recovery result cannot turn cancellation
      // into a false success.
      const cancelled = initiallyCancelled || context.signal?.aborted === true;
      if (cancelled) {
        // Deliberately ignore any recovery result obtained after cancellation.
        // The original error remains the authoritative terminal outcome.
      } else if (recovery?.recovered) {
        const recoveredResult = recovery.result;
        const recoveredReminder = this.getModelReminder(recoveredResult);
        const envelope = buildToolResultEnvelope({
          toolUseId,
          toolName,
          status: "success",
          result: recoveredResult,
          modelReminder: recoveredReminder,
          userSummary: `${toolName} recovered and completed`,
        });
        const endedAt = Date.now();
        emitLifecycle("result", {
          endedAt,
          durationMs: endedAt - startedAt,
          recovered: true,
        });
        return {
          result: recoveredResult,
          durationMs: endedAt - startedAt,
          resultJson: envelope.modelPayload,
          envelope,
        };
      }
      const envelope = buildToolResultEnvelope({
        toolUseId,
        toolName,
        status: "error",
        error,
        retryable: false,
        userSummary: `${toolName} failed`,
      });
      const endedAt = Date.now();
      emitLifecycle(cancelled ? "cancelled" : timedOut ? "timed_out" : "failed", {
        endedAt,
        durationMs: endedAt - startedAt,
        error: errorMessage,
        ...(this.getErrorType(error)
          ? { errorType: this.getErrorType(error) }
          : {}),
      });
      context.emitEvent?.("log", {
        metric: "tool_runtime_trace",
        taskId: context.taskId,
        tool: toolName,
        toolUseId,
        idempotencyKey,
        envelope,
      });
      return {
        error,
        durationMs: Date.now() - startedAt,
        resultJson: "",
        envelope,
      };
    } finally {
      if (typeof stopHeartbeat === "function") {
        stopHeartbeat();
      }
    }
  }

  private getResultError(result: unknown): string | undefined {
    if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
    const value = (result as { error?: unknown; message?: unknown }).error ??
      (result as { message?: unknown }).message;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
}
