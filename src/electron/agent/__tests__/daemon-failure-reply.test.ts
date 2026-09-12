import { describe, expect, it, vi } from "vitest";

import { AgentDaemon } from "../daemon";

function createDaemonLike() {
  const events: Any[] = [];
  const taskState: Any = {
    id: "task-1",
    title: "Task 1",
    status: "executing",
    workspaceId: "workspace-1",
  };
  const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
    taskRepo: {
      findById: vi.fn(() => taskState),
      update: vi.fn((_taskId: string, updates: Record<string, unknown>) => {
        Object.assign(taskState, updates);
      }),
    },
    eventRepo: {
      findByTaskId: vi.fn(() => events),
    },
    approvalRepo: {
      update: vi.fn(),
    },
    clearRetryState: vi.fn(),
    activeTasks: new Map(),
    pendingApprovals: new Map(),
    activeTimelineStageByTask: new Map(),
    activeStepIdsByTask: new Map(),
    failedPlanStepsByTask: new Map(),
    timelineErrorsByTask: new Map(),
    knownPlanStepIdsByTask: new Map(),
    evidenceRefsByTask: new Map(),
    lastKnownLlmProviderByTask: new Map(),
    taskSeqById: new Map(),
    completionTelemetryBackfilledTaskIds: new Set(),
    logEvent: vi.fn((_taskId: string, type: string, payload: Any) => {
      events.push({
        id: `event-${events.length + 1}`,
        taskId: "task-1",
        type,
        payload,
        timestamp: Date.now(),
      });
    }),
    queueManager: {
      onTaskFinished: vi.fn(),
    },
    finishQueueSlot: vi.fn(),
    releaseComputerUseSession: vi.fn(),
    teamOrchestrator: null,
  });
  return daemonLike as Any;
}

describe("AgentDaemon failure replies", () => {
  it("exposes a daemon-level failure in the conversation and deduplicates it", () => {
    const daemonLike = createDaemonLike();

    AgentDaemon.prototype.failTask.call(
      daemonLike,
      "task-1",
      "Hermes ACP exited (1)",
      {
        terminalStatus: "failed",
        failureClass: "dependency_unavailable",
      },
    );

    expect(
      daemonLike.logEvent.mock.calls.filter(
        (call: unknown[]) => call[1] === "assistant_message",
      ),
    ).toHaveLength(1);
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-1",
      "assistant_message",
      expect.objectContaining({
        terminalFailure: true,
        failureClass: "dependency_unavailable",
        message: expect.stringContaining("Hermes ACP exited (1)"),
      }),
    );

    // A second observer of the same failure must not create a second chat
    // bubble, even when it races before the task record is refreshed.
    taskStateStatusBackToExecuting(daemonLike);
    AgentDaemon.prototype.failTask.call(daemonLike, "task-1", "Hermes ACP exited (1)");

    expect(
      daemonLike.logEvent.mock.calls.filter(
        (call: unknown[]) => call[1] === "assistant_message",
      ),
    ).toHaveLength(1);
  });
});

function taskStateStatusBackToExecuting(daemonLike: Any): void {
  const task = daemonLike.taskRepo.findById("task-1");
  task.status = "executing";
}
