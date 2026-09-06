import { useState, useEffect } from "react";

/**
 * Format a duration in milliseconds to a human-readable string.
 * Examples: "3s", "2m 15s", "1h 30m", "2h 5m"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Hook that returns a live-updating duration string for a task.
 * For finished tasks (completedAt set), returns a static string.
 * For active tasks, ticks every second.
 */
export function useTaskDuration(
  createdAt: number,
  completedAt?: number,
  isActive: boolean = false,
): string {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    // Reset immediately whenever a new turn starts. Without this, the first
    // render of a follow-up can reuse the previous turn's clock value and the
    // interval may not visibly advance until some unrelated refresh occurs.
    // There is no reason to write state for an inactive/completed task. Apart
    // from avoiding needless renders, this is important for the welcome view:
    // callers may use a transient Date.now() fallback when no task is
    // selected, and setting state here would turn that changing fallback into
    // an update loop.
    if (!isActive || completedAt) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [createdAt, isActive, completedAt]);

  const endTime = completedAt || (isActive ? now : Date.now());
  return formatDuration(endTime - createdAt);
}
