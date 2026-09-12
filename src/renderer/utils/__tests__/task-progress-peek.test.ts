import { describe, expect, it } from "vitest";
import type { PlanStep, Task, TaskEvent } from "../../../shared/types";
import {
  deriveTaskProgressPeekModel,
  humanizeProgressStepDescription,
} from "../task-progress-peek";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task",
    prompt: "Do the work",
    status: "executing",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as Task;
}

function makeEvent(
  type: TaskEvent["type"],
  payload: Record<string, unknown>,
  timestamp: number,
): TaskEvent {
  return {
    id: `${type}-${timestamp}`,
    eventId: `${type}-${timestamp}`,
    taskId: "task-1",
    type,
    payload,
    timestamp,
  } as TaskEvent;
}

function makeStep(overrides: Partial<PlanStep>): PlanStep {
  return {
    id: "step-1",
    description: "Inspect files",
    status: "pending",
    ...overrides,
  };
}

describe("deriveTaskProgressPeekModel", () => {
  it("calculates determinate progress from completed and skipped steps", () => {
    const model = deriveTaskProgressPeekModel({
      task: makeTask(),
      events: [],
      label: "Working for 2m",
      isTaskWorking: true,
      now: 10_000,
      planSteps: [
        makeStep({ id: "a", status: "completed" }),
        makeStep({ id: "b", status: "skipped" }),
        makeStep({ id: "c", status: "in_progress" }),
        makeStep({ id: "d", status: "pending" }),
      ],
    });

    expect(model.progressPercent).toBe(50);
    expect(model.progressText).toBe("2 / 4 个步骤已完成");
    expect(model.activeStep?.id).toBe("c");
    expect(model.status).toBe("working");
  });

  it("falls back cleanly when no plan exists", () => {
    const model = deriveTaskProgressPeekModel({
      task: makeTask({ status: "completed" }),
      events: [],
      label: "Worked for 8s",
      isTaskWorking: false,
      planSteps: [],
    });

    expect(model.progressPercent).toBeNull();
    expect(model.progressText).toBe("还没有计划步骤");
    expect(model.activeStep).toBeNull();
    expect(model.statusLabel).toBe("已完成");
  });

  it("collects recent user-facing activity and filters noise", () => {
    const model = deriveTaskProgressPeekModel({
      task: makeTask(),
      label: "Working for 1m",
      isTaskWorking: true,
      planSteps: [],
      now: 130_000,
      events: [
        makeEvent("progress_update", { message: "thinking" }, 100_000),
        makeEvent(
          "progress_update",
          { message: "Reading renderer timeline code" },
          110_000,
        ),
        makeEvent(
          "step_completed",
          { step: { id: "a", description: "Inspect files" } },
          120_000,
        ),
      ],
    });

    expect(model.recentActivity.map((activity) => activity.label)).toEqual([
      "Reading renderer timeline code",
      "已完成：Inspect files",
    ]);
    expect(model.recentActivity[1]?.tone).toBe("success");
  });

  it("surfaces waiting state for approval terminal status", () => {
    const model = deriveTaskProgressPeekModel({
      task: makeTask({ terminalStatus: "awaiting_approval" }),
      label: "Working for 4m",
      isTaskWorking: false,
      planSteps: [],
      events: [],
    });

    expect(model.status).toBe("waiting");
    expect(model.statusLabel).toBe("等待中");
  });

  it("preserves blocked status when the task is not awaiting approval", () => {
    const model = deriveTaskProgressPeekModel({
      task: makeTask({ status: "blocked" }),
      label: "Blocked",
      isTaskWorking: false,
      planSteps: [],
      events: [],
    });

    expect(model.status).toBe("blocked");
    expect(model.statusLabel).toBe("阻塞");
  });
});

describe("humanizeProgressStepDescription", () => {
  it("removes leaked tool-call and markdown syntax", () => {
    expect(
      humanizeProgressStepDescription(
        "Use the `Skill` tool with skill ID `novelist`.",
      ),
    ).toBe("运行 小说创作 技能");
    expect(
      humanizeProgressStepDescription(
        "assistant to=read_file path=`src/App.tsx`",
      ),
    ).toBe("Read file");
    expect(humanizeProgressStepDescription("Review **renderer** state")).toBe(
      "Review renderer state",
    );
  });
});
