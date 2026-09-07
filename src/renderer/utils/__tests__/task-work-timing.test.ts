import { describe, expect, it } from "vitest";
import type { Task, TaskEvent } from "../../../shared/types";
import { deriveTaskWorkTiming } from "../task-working-state";

const task = { id: "task", status: "completed", createdAt: 1000, completedAt: 2000, updatedAt: 2000 } as Task;
const event = (type: string, timestamp: number, payload = {}) =>
  ({ id: `${type}:${timestamp}`, taskId: task.id, type, timestamp, payload }) as TaskEvent;

describe("current turn timing", () => {
  it("starts the second turn despite the first turn's completion timestamp", () => {
    expect(deriveTaskWorkTiming(task, [event("user_message", 3000)], false)).toMatchObject({
      startedAt: 3000, isActive: true, completedAt: undefined,
    });
  });
  it.each(["follow_up_failed", "follow_up_completed", "task_status"])(
    "ends on %s even when the task row and optimistic marker still say running", (type) => {
      expect(deriveTaskWorkTiming({ ...task, status: "executing" }, [
        event("user_message", 3000), event("executing", 3001), event(type, 8000, { status: "completed" }),
      ], false, 2900)).toMatchObject({ startedAt: 3000, isActive: false, completedAt: 8000 });
    },
  );
  it("uses the updated terminal row if failure events are not loaded", () => {
    expect(deriveTaskWorkTiming({ ...task, updatedAt: 8000 }, [event("user_message", 3000)], false, 2900))
      .toMatchObject({ startedAt: 3000, completedAt: 8000, isActive: false });
  });
  it("starts a third turn after failure without reusing the previous end", () => {
    expect(deriveTaskWorkTiming(task, [event("user_message", 3000), event("follow_up_failed", 8000), event("user_message", 10000)], false))
      .toMatchObject({ startedAt: 10000, isActive: true, completedAt: undefined });
  });
  it("ignores events belonging to other sessions", () => {
    expect(deriveTaskWorkTiming(task, [{ ...event("user_message", 9000), taskId: "other" }], false))
      .toMatchObject({ startedAt: 1000, completedAt: 2000, isActive: false });
  });
  it("ticks optimistically before the backend acknowledges a follow-up", () => {
    expect(deriveTaskWorkTiming(task, [], false, 3000))
      .toMatchObject({ startedAt: 3000, isActive: true, completedAt: undefined });
  });
});
