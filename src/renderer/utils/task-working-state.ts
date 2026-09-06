import type { EventType, Task, TaskEvent } from "../../shared/types";
import { deriveCanonicalTaskStatus } from "../../shared/task-status";
import { getEffectiveTaskEventType } from "./task-event-compat";

const ACTIVE_WORK_SIGNAL_WINDOW_MS = 30_000;

const ACTIVE_WORK_EVENT_TYPES: EventType[] = [
  "executing",
  "step_started",
  "step_completed",
  "progress_update",
  "tool_call",
  "tool_result",
  "verification_started",
  "retry_started",
  "llm_streaming",
];

const TERMINAL_WORK_EVENT_TYPES = new Set<
  EventType | "task_paused" | "task_cancelled" | "follow_up_failed"
>([
  "task_paused",
  "approval_requested",
  "task_completed",
  "task_cancelled",
  "follow_up_completed",
  "follow_up_failed",
]);

function isActiveWorkSignal(event: TaskEvent, effectiveType: string): boolean {
  const isActiveProgressSignal =
    effectiveType === "progress_update" &&
    (event.payload?.phase === "tool_execution" ||
      event.payload?.state === "active" ||
      event.payload?.heartbeat === true);
  const isTimelineActiveLifecycle =
    event.type === "timeline_group_started" ||
    event.type === "timeline_step_started" ||
    event.type === "timeline_step_updated";
  return (
    isTimelineActiveLifecycle ||
    ACTIVE_WORK_EVENT_TYPES.includes(effectiveType as EventType) ||
    isActiveProgressSignal
  );
}

export function isTaskActivelyWorking(
  task: Task | null | undefined,
  events: TaskEvent[],
  hasActiveChildren: boolean,
  now = Date.now(),
): boolean {
  if (!task) return false;

  // The persisted status can briefly lag the terminal marker while the
  // renderer receives the final event. Always make lifecycle decisions from
  // the canonical status so an old `executing` value cannot keep the Stop
  // button alive after a completed/failed follow-up.
  const canonicalStatus = deriveCanonicalTaskStatus(task);

  if (canonicalStatus === "pending" && task.branchFromTaskId) {
    return false;
  }

  // A follow-up is recorded as a user_message before the daemon publishes the
  // new executing status. During that short window the task object can still
  // say "completed" (and retain the previous completedAt), which used to make
  // the header timer stop at 0s until a refresh. Treat a user message newer
  // than the previous terminal marker as the start of a new active turn.
  let latestUserMessageTimestamp: number | null = null;
  let latestTerminalTimestamp: number | null = null;
  for (const event of events) {
    if (event.taskId !== task.id) continue;
    const effectiveType = getEffectiveTaskEventType(event);
    if (effectiveType === "user_message") {
      latestUserMessageTimestamp = Math.max(
        latestUserMessageTimestamp ?? event.timestamp,
        event.timestamp,
      );
    }
    if (
      TERMINAL_WORK_EVENT_TYPES.has(
        effectiveType as
          | EventType
          | "task_paused"
          | "task_cancelled"
          | "follow_up_failed",
      )
    ) {
      latestTerminalTimestamp = Math.max(
        latestTerminalTimestamp ?? event.timestamp,
        event.timestamp,
      );
    }
  }
  // Follow-up failures intentionally preserve the prior run's completedAt so
  // the original result remains anchored in history. For activity detection,
  // a terminal task's updatedAt is the newer terminal marker and must also
  // close the follow-up turn when the terminal event itself was not loaded.
  const terminalTaskMarker =
    canonicalStatus === "completed" ||
    canonicalStatus === "failed" ||
    canonicalStatus === "cancelled"
      ? Math.max(
          task.completedAt ?? Number.NEGATIVE_INFINITY,
          task.updatedAt ?? Number.NEGATIVE_INFINITY,
        )
      : task.completedAt ?? Number.NEGATIVE_INFINITY;
  const previousCompletionTimestamp = Math.max(
    terminalTaskMarker,
    latestTerminalTimestamp ?? Number.NEGATIVE_INFINITY,
  );
  const hasNewerFollowUp =
    latestUserMessageTimestamp !== null &&
    latestUserMessageTimestamp > previousCompletionTimestamp;
  if (hasNewerFollowUp) return true;

  if (canonicalStatus === "executing" || canonicalStatus === "planning") {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.taskId !== task.id) continue;
      const effectiveType = getEffectiveTaskEventType(event);
      if (
        TERMINAL_WORK_EVENT_TYPES.has(
          effectiveType as
            | EventType
            | "task_paused"
            | "task_cancelled"
            | "follow_up_failed",
        )
      ) {
        return false;
      }
      if (isActiveWorkSignal(event, effectiveType)) {
        return true;
      }
    }
    return true;
  }

  if (canonicalStatus === "completed" && hasActiveChildren) {
    return true;
  }
  if (canonicalStatus === "interrupted") return true;
  if (
    canonicalStatus === "completed" ||
    canonicalStatus === "paused" ||
    canonicalStatus === "blocked" ||
    canonicalStatus === "failed" ||
    canonicalStatus === "cancelled"
  ) {
    return false;
  }

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.taskId !== task.id) continue;
    const effectiveType = getEffectiveTaskEventType(event);

    if (
      TERMINAL_WORK_EVENT_TYPES.has(
        effectiveType as
          | EventType
          | "task_paused"
          | "task_cancelled"
          | "follow_up_failed",
      )
    ) {
      return false;
    }
    if (isActiveWorkSignal(event, effectiveType)) {
      return now - event.timestamp <= ACTIVE_WORK_SIGNAL_WINDOW_MS;
    }
  }

  return false;
}
