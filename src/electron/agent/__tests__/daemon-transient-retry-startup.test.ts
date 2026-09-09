import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";
import type { Task, TaskEvent } from "../../../shared/types";

// Use production initialize/retry/timer methods with isolated persistence and
// dispatch dependencies. Each harness is a fresh daemon with empty retry maps.
function createHarness(tasks: Task[] = [], events: TaskEvent[] = []) {
  const stored = new Map(tasks.map((task) => [task.id, task]));
  const history = [...events];
  const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
    options: {},
    retryCounts: new Map(), pendingRetries: new Map(), activeTasks: new Map(),
    pendingApprovals: new Map(), pendingInputRequests: new Map(), pendingTaskImages: new Map(),
    completionTelemetryBackfilledTaskIds: new Set(),
    maxTaskRetries: 2, retryBaseDelayMs: 5_000, retryMaxDelayMs: 60_000,
    taskRepo: {
      findById: vi.fn((id: string) => stored.get(id)),
      findByStatus: vi.fn((statuses: string | string[]) =>
        [...stored.values()].filter((task) =>
          (Array.isArray(statuses) ? statuses : [statuses]).includes(task.status),
        ),
      ),
      update: vi.fn((id: string, updates: Partial<Task>) => {
        const task = stored.get(id);
        if (task) stored.set(id, { ...task, ...updates });
      }),
    },
    eventRepo: {
      migrateLegacyEventsForTasks: vi.fn(() => 0),
      findByTaskIdAndTypes: vi.fn((id: string, types: string[], limit?: number) => {
        const matching = history.filter((event) =>
          event.taskId === id && types.includes(event.legacyType || event.type),
        );
        return limit ? matching.slice(-limit) : matching;
      }),
    },
    queueManager: {
      initialize: vi.fn(async () => {}),
      isRunning: vi.fn(() => false), isQueued: vi.fn(() => false),
    },
    orchestrationGraphEngine: {
      start: vi.fn(), stop: vi.fn(), resumeRunningRuns: vi.fn(async () => {}),
    },
    backfillTaskCompletionTelemetry: vi.fn(),
    isStaleAttachedCliTask: vi.fn(() => false),
    logEvent: vi.fn((taskId: string, type: string, payload: unknown) => {
      history.push({ taskId, type, payload, timestamp: Date.now() } as TaskEvent);
    }),
    startTask: vi.fn(async () => {}), failTask: vi.fn(),
    finishQueueSlot: vi.fn(), removeAllListeners: vi.fn(),
  }) as Any;
  return { daemon, stored, history };
}

function queuedTask(): Task {
  return { id: "retry-task", workspaceId: "workspace", status: "queued", error: "", createdAt: Date.now() } as Task;
}

describe("AgentDaemon persisted transient retry startup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("restores the remaining cooldown and retry budget after process loss", async () => {
    const before = createHarness([queuedTask()]);
    before.daemon.retryCounts.set("retry-task", 1);
    const retryAt = Date.now() + 60_000;
    before.daemon.handleTransientTaskFailure("retry-task", "rate limit", 60_000);
    expect(before.history.find((event) => event.type === "task_queued")?.payload)
      .toMatchObject({ retryCount: 2, delayMs: 60_000, retryAt });
    clearTimeout(before.daemon.pendingRetries.get("retry-task"));
    before.daemon.pendingRetries.clear(); // Simulate process exit; persisted data remains unchanged.

    const after = createHarness([...before.stored.values()], before.history);
    await after.daemon.initialize();
    expect(after.daemon.queueManager.initialize).toHaveBeenCalledWith([], []);
    expect(after.daemon.getTransientRetryCount("retry-task")).toBe(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(after.daemon.startTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(after.daemon.startTask).toHaveBeenCalledTimes(1);
    expect(after.daemon.handleTransientTaskFailure("retry-task", "rate limit")).toBe(false);
  });

  it("queues an expired retry immediately without resetting its count", async () => {
    const before = createHarness([queuedTask()]);
    before.daemon.handleTransientTaskFailure("retry-task", "network error");
    clearTimeout(before.daemon.pendingRetries.get("retry-task"));
    before.daemon.pendingRetries.clear();
    vi.setSystemTime(Date.now() + 20_000);
    const after = createHarness([...before.stored.values()], before.history);
    await after.daemon.initialize();
    expect(after.daemon.queueManager.initialize).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "retry-task", status: "queued" })], [],
    );
    expect(after.daemon.getTransientRetryCount("retry-task")).toBe(1);
    expect(after.daemon.pendingRetries.size).toBe(0);
  });

  it("preserves the deadline when correcting stale executing state on startup", async () => {
    const before = createHarness([queuedTask()]);
    before.daemon.handleTransientTaskFailure("retry-task", "network error", 7_000);
    before.daemon.taskRepo.update("retry-task", { status: "executing" });
    clearTimeout(before.daemon.pendingRetries.get("retry-task"));
    before.daemon.pendingRetries.clear();
    const after = createHarness([...before.stored.values()], before.history);
    await after.daemon.initialize();
    expect(after.stored.get("retry-task")?.status).toBe("queued");
    expect(after.daemon.queueManager.initialize).toHaveBeenCalledWith([], []);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(after.daemon.startTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(after.daemon.startTask).toHaveBeenCalledTimes(1);
  });

  it.each(["task_dequeued", "task_resumed", "task_paused", "task_completed", "task_cancelled", "task_status"])(
    "does not restore an old retry superseded by %s", async (type) => {
      const before = createHarness([queuedTask()]);
      before.daemon.handleTransientTaskFailure("retry-task", "network error", 60_000);
      before.daemon.logEvent("retry-task", type, {});
      vi.clearAllTimers();
      const after = createHarness([...before.stored.values()], before.history);
      await after.daemon.initialize();
      expect(after.daemon.pendingRetries.size).toBe(0);
      expect(after.daemon.getTransientRetryCount("retry-task")).toBe(0);
    },
  );

  it("ignores an old retry event when the task no longer carries a retry marker", async () => {
    const before = createHarness([queuedTask()]);
    before.daemon.handleTransientTaskFailure("retry-task", "network error", 60_000);
    before.daemon.taskRepo.update("retry-task", { error: undefined });
    vi.clearAllTimers();
    const after = createHarness([...before.stored.values()], before.history);
    await after.daemon.initialize();
    expect(after.daemon.pendingRetries.size).toBe(0);
  });

  it("does not spend another attempt for duplicate failure delivery", async () => {
    const { daemon, history } = createHarness([queuedTask()]);
    daemon.handleTransientTaskFailure("retry-task", "network error", 7_000);
    const timer = daemon.pendingRetries.get("retry-task");
    expect(daemon.handleTransientTaskFailure("retry-task", "same error", 60_000)).toBe(true);
    expect(daemon.getTransientRetryCount("retry-task")).toBe(1);
    expect(daemon.pendingRetries.get("retry-task")).toBe(timer);
    expect(history.filter((event) => event.type === "task_queued")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(daemon.startTask).toHaveBeenCalledTimes(1);
  });

  it.each(["paused", "cancelled", "failed", "completed"])(
    "does not restart a task changed to %s during cooldown", async (status) => {
      const { daemon } = createHarness([queuedTask()]);
      daemon.handleTransientTaskFailure("retry-task", "network error");
      daemon.taskRepo.update("retry-task", { status });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(daemon.startTask).not.toHaveBeenCalled();
    },
  );

  it("does not rewrite executing state when a live executor already owns it", async () => {
    const { daemon, stored } = createHarness([queuedTask()]);
    daemon.handleTransientTaskFailure("retry-task", "network error");
    daemon.taskRepo.update("retry-task", { status: "executing" });
    daemon.activeTasks.set("retry-task", { executor: {} });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stored.get("retry-task")?.status).toBe("executing");
    expect(daemon.startTask).not.toHaveBeenCalled();
  });

  it("reports dispatch failures instead of an unhandled timer rejection", async () => {
    const { daemon } = createHarness([queuedTask()]);
    daemon.startTask.mockRejectedValue(new Error("workspace unavailable"));
    daemon.handleTransientTaskFailure("retry-task", "network error");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(daemon.failTask).toHaveBeenCalledWith(
      "retry-task", "Failed to start scheduled retry: workspace unavailable",
    );
  });

  it("clears shutdown timers while retaining persisted deadlines for the next daemon", async () => {
    const before = createHarness([queuedTask()]);
    before.daemon.handleTransientTaskFailure("retry-task", "rate limit", 60_000);
    await before.daemon.shutdown();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(before.daemon.startTask).not.toHaveBeenCalled();
    expect(before.daemon.pendingRetries.size).toBe(0);
    const after = createHarness([...before.stored.values()], before.history);
    await after.daemon.initialize();
    await vi.advanceTimersByTimeAsync(39_999);
    expect(after.daemon.startTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(after.daemon.startTask).toHaveBeenCalledTimes(1);
  });
});
