import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentDaemon } from "../daemon";

describe("AgentDaemon.handleTransientTaskFailure recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses bounded exponential backoff when no provider delay is supplied", () => {
    const taskId = "task-retry-backoff";
    const storedTask: Any = { id: taskId, status: "queued", error: "" };
    const daemonLike = {
      retryCounts: new Map<string, number>(),
      pendingRetries: new Map<string, ReturnType<typeof setTimeout>>(),
      activeTasks: new Map<string, Any>([[taskId, { executor: {} }]]),
      maxTaskRetries: 2,
      retryBaseDelayMs: 5_000,
      retryMaxDelayMs: 60_000,
      taskRepo: {
        findById: vi.fn(() => storedTask),
        update: vi.fn(),
      },
      queueManager: {
        onTaskFinished: vi.fn(),
        isRunning: vi.fn(() => false),
        isQueued: vi.fn(() => false),
      },
      logEvent: vi.fn(),
      startTask: vi.fn(async () => {}),
      finishQueueSlot: vi.fn(),
      releaseComputerUseSession: vi.fn(),
      isTransientRetryErrorMessage: () => true,
    } as Any;

    expect(
      AgentDaemon.prototype.handleTransientTaskFailure.call(
        daemonLike,
        taskId,
        "socket hang up",
      ),
    ).toBe(true);
    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(taskId, {
      status: "queued",
      error: "Transient provider error. Retry 1/2 in 5s.",
    });

    vi.advanceTimersByTime(5_000);
    daemonLike.retryCounts.set(taskId, 1);
    expect(
      AgentDaemon.prototype.handleTransientTaskFailure.call(
        daemonLike,
        taskId,
        "socket hang up",
      ),
    ).toBe(true);
    expect(daemonLike.taskRepo.update).toHaveBeenLastCalledWith(taskId, {
      status: "queued",
      error: "Transient provider error. Retry 2/2 in 10s.",
    });
  });

  it("recovers a stale executing+transient task back to queued before retry start", async () => {
    const taskId = "task-retry-recover";
    let storedTask: Any = {
      id: taskId,
      status: "queued",
      error: "",
    };

    const daemonLike = {
      retryCounts: new Map<string, number>(),
      pendingRetries: new Map<string, ReturnType<typeof setTimeout>>(),
      activeTasks: new Map<string, Any>([[taskId, { executor: {} }]]),
      maxTaskRetries: 2,
      retryDelayMs: 30_000,
      taskRepo: {
        findById: vi.fn(() => storedTask),
        update: vi.fn((id: string, updates: Record<string, unknown>) => {
          if (id !== taskId) return;
          storedTask = { ...storedTask, ...updates };
        }),
      },
      queueManager: {
        onTaskFinished: vi.fn(),
        isRunning: vi.fn(() => false),
        isQueued: vi.fn(() => false),
      },
      logEvent: vi.fn(),
      startTask: vi.fn(async () => {}),
      finishQueueSlot: vi.fn(),
      releaseComputerUseSession: vi.fn(),
      isTransientRetryErrorMessage: (message: unknown) =>
        typeof message === "string" &&
        /^Transient provider error\.\s*Retry\s+\d+\/\d+\s+in\s+\d+s\./i.test(message.trim()),
    } as Any;

    const scheduled = AgentDaemon.prototype.handleTransientTaskFailure.call(
      daemonLike,
      taskId,
      "socket hang up",
      1000,
    );

    expect(scheduled).toBe(true);
    expect(storedTask.status).toBe("queued");

    // Simulate status drift caused by an out-of-band stale resume call.
    storedTask = {
      ...storedTask,
      status: "executing",
      error: "Transient provider error. Retry 1/2 in 1s.",
    };

    await vi.advanceTimersByTimeAsync(1000);

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(taskId, { status: "queued" });
    expect(daemonLike.startTask).toHaveBeenCalledWith(expect.objectContaining({ id: taskId }));
    expect(daemonLike.pendingRetries.has(taskId)).toBe(false);
  });

  it("does not force-queue non-transient executing tasks", async () => {
    const taskId = "task-retry-no-recover";
    let storedTask: Any = {
      id: taskId,
      status: "queued",
      error: "",
    };

    const daemonLike = {
      retryCounts: new Map<string, number>(),
      pendingRetries: new Map<string, ReturnType<typeof setTimeout>>(),
      activeTasks: new Map<string, Any>([[taskId, { executor: {} }]]),
      maxTaskRetries: 2,
      retryDelayMs: 30_000,
      taskRepo: {
        findById: vi.fn(() => storedTask),
        update: vi.fn((id: string, updates: Record<string, unknown>) => {
          if (id !== taskId) return;
          storedTask = { ...storedTask, ...updates };
        }),
      },
      queueManager: {
        onTaskFinished: vi.fn(),
        isRunning: vi.fn(() => false),
        isQueued: vi.fn(() => false),
      },
      logEvent: vi.fn(),
      startTask: vi.fn(async () => {}),
      finishQueueSlot: vi.fn(),
      releaseComputerUseSession: vi.fn(),
      isTransientRetryErrorMessage: (message: unknown) =>
        typeof message === "string" &&
        /^Transient provider error\.\s*Retry\s+\d+\/\d+\s+in\s+\d+s\./i.test(message.trim()),
    } as Any;

    const scheduled = AgentDaemon.prototype.handleTransientTaskFailure.call(
      daemonLike,
      taskId,
      "socket hang up",
      1000,
    );

    expect(scheduled).toBe(true);

    // Drift to executing without a transient-retry marker should not be auto-corrected.
    storedTask = {
      ...storedTask,
      status: "executing",
      error: "Some other runtime error",
    };

    await vi.advanceTimersByTimeAsync(1000);

    expect(daemonLike.taskRepo.update).not.toHaveBeenCalledWith(taskId, { status: "queued" });
    expect(daemonLike.startTask).not.toHaveBeenCalled();
  });
});
