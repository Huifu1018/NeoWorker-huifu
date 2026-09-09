import type { AcpObject, AcpRequestContext } from "./hermes-acp-client";

export interface HermesPermissionOption {
  optionId: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  name: string;
}

export interface HermesPermissionRequest {
  sessionId: string;
  toolCall: AcpObject & { toolCallId: string };
  options: HermesPermissionOption[];
}

/** Return an offered option ID, or null to dismiss. Never infer approval. */
export type HermesPermissionHandler = (
  request: HermesPermissionRequest,
  context: AcpRequestContext,
) => Promise<string | null>;

/** Adapt NeoWorker's boolean approval service to ACP's option-id response. */
export function createHermesPermissionHandler(
  requestApproval: (taskId: string, type: string, description: string, details: AcpObject, opts?: { allowAutoApprove?: boolean }) => Promise<boolean>,
  taskId: string,
): HermesPermissionHandler {
  if (!taskId.trim()) throw new Error("Hermes permission bridge requires a task id");
  return async (request, context) => {
    const tool = String(request.toolCall.title || "Hermes operation");
    const approved = await requestApproval(taskId, "hermes_tool", tool, {
      hermesSessionId: request.sessionId,
      toolCall: request.toolCall,
      options: request.options,
      signalAborted: context.signal.aborted,
    }, { allowAutoApprove: true });
    if (!approved || context.signal.aborted) return null;
    return request.options.find((option) => option.kind === "allow_once")?.optionId ??
      request.options.find((option) => option.kind === "allow_always")?.optionId ?? null;
  };
}

const cancelled = () => ({ outcome: { outcome: "cancelled" as const } });
const isObject = (value: unknown): value is AcpObject =>
  !!value && typeof value === "object" && !Array.isArray(value);
const kinds = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);

/** Only mediates ACP permission requests; this is not a sandbox or a tool executor. */
export class HermesPermissionBridge {
  private readonly pending = new Set<AbortController>();

  constructor(
    private readonly handler?: HermesPermissionHandler,
    private readonly timeoutMs = 120_000,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid permission timeout");
  }

  cancelPending(): void {
    for (const controller of this.pending) controller.abort();
  }

  async request(params: AcpObject, sessionId: string | undefined, context: AcpRequestContext) {
    if (!this.handler || !sessionId || params.sessionId !== sessionId || context.signal.aborted) return cancelled();
    if (!isObject(params.toolCall) || typeof params.toolCall.toolCallId !== "string" || !params.toolCall.toolCallId) return cancelled();
    if (!Array.isArray(params.options) || !params.options.length || params.options.length > 16) return cancelled();
    const options: HermesPermissionOption[] = [];
    const ids = new Set<string>();
    for (const value of params.options) {
      if (!isObject(value) || typeof value.optionId !== "string" || !value.optionId || ids.has(value.optionId) ||
          typeof value.name !== "string" || typeof value.kind !== "string" || !kinds.has(value.kind)) return cancelled();
      ids.add(value.optionId);
      options.push({ optionId: value.optionId, name: value.name, kind: value.kind as HermesPermissionOption["kind"] });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal.addEventListener("abort", abort, { once: true });
    this.pending.add(controller);
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      const dismissed = new Promise<null>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(null), { once: true });
      });
      // Capture synchronous throws and reject safely even if the UI ignores cancellation.
      const choice = Promise.resolve().then(() => {
        if (controller.signal.aborted) return null;
        return this.handler!({
          sessionId,
          toolCall: params.toolCall as HermesPermissionRequest["toolCall"],
          options,
        }, { signal: controller.signal });
      });
      const selected = await Promise.race([choice, dismissed]);
      if (controller.signal.aborted || typeof selected !== "string" || !ids.has(selected)) return cancelled();
      return { outcome: { outcome: "selected" as const, optionId: selected } };
    } catch {
      return cancelled();
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
      this.pending.delete(controller);
      controller.abort();
    }
  }
}
