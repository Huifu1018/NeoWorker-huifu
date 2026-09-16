import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../shared/types";
import {
  appendRendererTaskEvents,
  capTaskEvents,
  getTransientEventReplacementKey,
  isRendererNoiseEvent,
} from "../task-event-append";
import { deriveSharedTaskEventUiState } from "../task-event-derived";

function makeEvent(
  overrides: Partial<TaskEvent> &
    Pick<TaskEvent, "taskId" | "type" | "timestamp">,
): TaskEvent {
  return {
    id:
      overrides.id ??
      `${overrides.taskId}:${overrides.type}:${overrides.timestamp}`,
    ...(overrides.eventId ? { eventId: overrides.eventId } : {}),
    taskId: overrides.taskId,
    type: overrides.type,
    timestamp: overrides.timestamp,
    ...(typeof overrides.seq === "number" ? { seq: overrides.seq } : {}),
    ...(overrides.legacyType ? { legacyType: overrides.legacyType } : {}),
    payload: overrides.payload ?? {},
    schemaVersion: overrides.schemaVersion ?? 2,
    ...(overrides.stepId ? { stepId: overrides.stepId } : {}),
    ...(overrides.groupId ? { groupId: overrides.groupId } : {}),
  };
}

describe("isRendererNoiseEvent", () => {
  it("identifies noise event types", () => {
    expect(
      isRendererNoiseEvent(
        makeEvent({ taskId: "t1", type: "log", timestamp: 1 }),
      ),
    ).toBe(true);
    expect(
      isRendererNoiseEvent(
        makeEvent({ taskId: "t1", type: "llm_streaming", timestamp: 1 }),
      ),
    ).toBe(true);
    expect(
      isRendererNoiseEvent(
        makeEvent({ taskId: "t1", type: "progress_update", timestamp: 1 }),
      ),
    ).toBe(true);
  });

  it("identifies structural event types", () => {
    expect(
      isRendererNoiseEvent(
        makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 1 }),
      ),
    ).toBe(false);
    expect(
      isRendererNoiseEvent(
        makeEvent({ taskId: "t1", type: "task_completed", timestamp: 1 }),
      ),
    ).toBe(false);
  });

  it("treats internal runtime telemetry as disposable renderer noise", () => {
    expect(
      isRendererNoiseEvent(
        makeEvent({
          taskId: "t1",
          type: "timeline_step_updated",
          legacyType: "hermes_runtime_checkpoint",
          timestamp: 1,
          payload: { runtime: "hermes", phase: "hermes_checkpoint" },
        }),
      ),
    ).toBe(true);
  });
});

describe("getTransientEventReplacementKey", () => {
  it("returns null for non-replaceable types", () => {
    expect(
      getTransientEventReplacementKey(
        makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 1 }),
      ),
    ).toBeNull();
  });

  it("builds a key from taskId, type, stepId, groupId, and stage", () => {
    const event = makeEvent({
      taskId: "t1",
      type: "progress_update",
      timestamp: 1,
      stepId: "step-1",
      groupId: "group-1",
      payload: { stage: "analyzing" },
    });
    expect(getTransientEventReplacementKey(event)).toBe(
      "t1:progress_update:step-1:group-1:analyzing",
    );
  });

  it("extracts stepId from payload.step.id", () => {
    const event = makeEvent({
      taskId: "t1",
      type: "executing",
      timestamp: 1,
      payload: { step: { id: "nested-step" } },
    });
    expect(getTransientEventReplacementKey(event)).toBe(
      "t1:executing:nested-step::",
    );
  });

  it("uses label as fallback for stage", () => {
    const event = makeEvent({
      taskId: "t1",
      type: "llm_streaming",
      timestamp: 1,
      payload: { label: "generating" },
    });
    expect(getTransientEventReplacementKey(event)).toBe(
      "t1:llm_streaming:::generating",
    );
  });
});

describe("appendRendererTaskEvents", () => {
  it("returns previous events unchanged when incoming is empty", () => {
    const prev = [
      makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 1 }),
    ];
    expect(appendRendererTaskEvents(prev, [])).toBe(prev);
  });

  it("appends non-replaceable events", () => {
    const prev = [
      makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 1 }),
    ];
    const incoming = [
      makeEvent({ taskId: "t1", type: "task_completed", timestamp: 2 }),
    ];
    const result = appendRendererTaskEvents(prev, incoming);
    expect(result).toHaveLength(2);
    expect(result[1].type).toBe("task_completed");
  });

  it("replaces existing events by transient key", () => {
    const existing = makeEvent({
      taskId: "t1",
      type: "progress_update",
      timestamp: 1,
      stepId: "s1",
      payload: { stage: "planning", message: "old" },
    });
    const replacement = makeEvent({
      taskId: "t1",
      type: "progress_update",
      timestamp: 2,
      stepId: "s1",
      payload: { stage: "planning", message: "new" },
    });
    const result = appendRendererTaskEvents([existing], [replacement]);
    expect(result).toHaveLength(1);
    expect((result[0].payload as Record<string, unknown>).message).toBe("new");
  });

  it("appends replaceable events when no match exists in previous", () => {
    const prev = [
      makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 1 }),
    ];
    const incoming = [
      makeEvent({
        taskId: "t1",
        type: "progress_update",
        timestamp: 2,
        stepId: "s1",
        payload: { stage: "running" },
      }),
    ];
    const result = appendRendererTaskEvents(prev, incoming);
    expect(result).toHaveLength(2);
    expect(result[1].type).toBe("progress_update");
  });

  it("replaces existing events by ID when re-emitted with updated payload", () => {
    const original = makeEvent({
      id: "evt-123",
      taskId: "t1",
      type: "assistant_message",
      timestamp: 1,
      payload: { message: "Here is a draft." },
    });
    const updated = makeEvent({
      id: "evt-123",
      taskId: "t1",
      type: "assistant_message",
      timestamp: 1,
      payload: {
        message: "Here is a draft.",
        inlineFrames: [{ kind: "mail_compose", draftId: "d1" }],
      },
    });
    const result = appendRendererTaskEvents([original], [updated]);
    expect(result).toHaveLength(1);
    expect(
      (result[0].payload as Record<string, unknown>).inlineFrames,
    ).toBeDefined();
  });

  it("replaces existing events by durable eventId even when renderer id changes", () => {
    const original = makeEvent({
      id: "renderer-1",
      eventId: "durable-event-1",
      taskId: "t1",
      type: "assistant_message",
      timestamp: 10,
      payload: { message: "old" },
    });
    const updated = makeEvent({
      id: "renderer-2",
      eventId: "durable-event-1",
      taskId: "t1",
      type: "assistant_message",
      timestamp: 10,
      payload: { message: "new" },
    });

    const result = appendRendererTaskEvents([original], [updated]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("renderer-2");
    expect((result[0].payload as Record<string, unknown>).message).toBe("new");
  });

  it("appends event with new ID that does not match any existing event", () => {
    const prev = [
      makeEvent({
        id: "evt-1",
        taskId: "t1",
        type: "user_message",
        timestamp: 1,
      }),
    ];
    const incoming = [
      makeEvent({
        id: "evt-2",
        taskId: "t1",
        type: "assistant_message",
        timestamp: 2,
      }),
    ];
    const result = appendRendererTaskEvents(prev, incoming);
    expect(result).toHaveLength(2);
  });

  it("handles mixed replaceable and non-replaceable incoming events", () => {
    const existing = makeEvent({
      taskId: "t1",
      type: "progress_update",
      timestamp: 1,
      stepId: "s1",
      payload: { stage: "old" },
    });
    const prev = [
      makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 0 }),
      existing,
    ];

    const replacement = makeEvent({
      taskId: "t1",
      type: "progress_update",
      timestamp: 2,
      stepId: "s1",
      payload: { stage: "old" },
    });
    const append = makeEvent({
      taskId: "t1",
      type: "task_completed",
      timestamp: 3,
    });

    const result = appendRendererTaskEvents(prev, [replacement, append]);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("assistant_message");
    expect(result[1].type).toBe("progress_update");
    expect(result[1].timestamp).toBe(2);
    expect(result[2].type).toBe("task_completed");
  });

  it("inserts late-arriving events into chronological order", () => {
    const prev = [
      makeEvent({ taskId: "t1", type: "user_message", timestamp: 100 }),
      makeEvent({ taskId: "t1", type: "task_completed", timestamp: 300 }),
    ];
    const artifact = makeEvent({
      taskId: "t1",
      type: "artifact_created",
      timestamp: 200,
      payload: { path: "/tmp/report.pdf" },
    });

    const result = appendRendererTaskEvents(prev, [artifact]);

    expect(result.map((event) => event.type)).toEqual([
      "user_message",
      "artifact_created",
      "task_completed",
    ]);
  });

  it("keeps sequence order when a transient replacement timestamp changes", () => {
    const progress = makeEvent({
      taskId: "t1",
      type: "progress_update",
      seq: 1,
      timestamp: 5,
      stepId: "s1",
      payload: { stage: "working", message: "old" },
    });
    const completion = makeEvent({
      taskId: "t1",
      type: "task_completed",
      seq: 2,
      timestamp: 10,
    });
    const replacement = makeEvent({
      taskId: "t1",
      type: "progress_update",
      seq: 1,
      timestamp: 12,
      stepId: "s1",
      payload: { stage: "working", message: "new" },
    });

    const result = appendRendererTaskEvents(
      [progress, completion],
      [replacement],
    );

    expect(result.map((event) => event.type)).toEqual([
      "progress_update",
      "task_completed",
    ]);
    expect((result[0].payload as Record<string, unknown>).message).toBe("new");
  });
});

describe("capTaskEvents", () => {
  it("returns events unchanged when under the cap", () => {
    const events = [
      makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 1 }),
    ];
    expect(capTaskEvents(events, 10)).toBe(events);
  });

  it("prioritizes structural events over noise events", () => {
    const structural = makeEvent({
      taskId: "t1",
      type: "assistant_message",
      timestamp: 100,
    });
    const noise = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ taskId: "t1", type: "log", timestamp: i }),
    );
    const events = [...noise, structural];
    const result = capTaskEvents(events, 3);
    expect(result.some((e) => e.type === "assistant_message")).toBe(true);
    expect(result).toHaveLength(3);
  });

  it("keeps most recent noise when budget allows", () => {
    const structural = makeEvent({
      taskId: "t1",
      type: "assistant_message",
      timestamp: 50,
    });
    const noise = Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        taskId: "t1",
        type: "progress_update",
        timestamp: i,
        id: `n-${i}`,
      }),
    );
    const events = [...noise, structural];
    const result = capTaskEvents(events, 4);
    expect(result).toHaveLength(4);
    expect(result[result.length - 1].type).toBe("assistant_message");
  });

  it("preserves every conversation round across thousands of later tool events", () => {
    const conversationEvents = Array.from({ length: 5 }, (_, index) => {
      const base = index * 3;
      return [
        makeEvent({
          id: `user-${index}`,
          taskId: "t1",
          type: "user_message",
          timestamp: base + 1,
          payload: { message: `Query ${index + 1}` },
        }),
        makeEvent({
          id: `assistant-${index}`,
          taskId: "t1",
          type: "assistant_message",
          timestamp: base + 2,
          payload: { message: `Result ${index + 1}` },
        }),
        makeEvent({
          id: `completed-${index}`,
          taskId: "t1",
          type: "task_completed",
          timestamp: base + 3,
        }),
      ];
    }).flat();
    const toolEvents = Array.from({ length: 2000 }, (_, index) =>
      makeEvent({
        id: `tool-${index}`,
        taskId: "t1",
        type: "tool_call",
        timestamp: 100 + index,
        payload: { tool: "run_command", index },
      }),
    );

    const result = capTaskEvents([...conversationEvents, ...toolEvents], 1200);
    const retainedIds = new Set(result.map((event) => event.id));

    expect(result).toHaveLength(1200);
    for (const event of conversationEvents) {
      expect(retainedIds.has(event.id)).toBe(true);
    }
  });

  it("does not preserve internal assistant progress as a conversation reply", () => {
    const internal = makeEvent({
      id: "internal-assistant",
      taskId: "t1",
      type: "assistant_message",
      timestamp: 1,
      payload: { internal: true, message: "Internal progress" },
    });
    const later = Array.from({ length: 5 }, (_, index) =>
      makeEvent({
        id: `tool-${index}`,
        taskId: "t1",
        type: "tool_call",
        timestamp: 10 + index,
      }),
    );

    const result = capTaskEvents([internal, ...later], 3);

    expect(result.map((event) => event.id)).not.toContain(internal.id);
  });

  it("truncates large command output payloads in renderer state", () => {
    const hugeOutput = "x".repeat(80 * 1024);
    const event = makeEvent({
      taskId: "t1",
      type: "command_output",
      timestamp: 1,
      payload: { type: "stderr", output: hugeOutput },
    });

    const [result] = capTaskEvents([event], 10);

    expect(result).not.toBe(event);
    expect(String(result.payload?.output || "").length).toBeLessThan(20 * 1024);
    expect(String(result.payload?.output || "")).toContain(
      "renderer payload truncated",
    );
  });

  it("preserves approval request payloads so approval dialogs keep full command details", () => {
    const command = "x".repeat(80 * 1024);
    const approval = makeEvent({
      taskId: "t1",
      type: "approval_requested",
      timestamp: 1,
      id: "approval",
      payload: {
        approval: {
          id: "approval-1",
          type: "run_command",
          description: "Run command",
          details: { command },
        },
      },
    });
    const noisyOutput = makeEvent({
      taskId: "t1",
      type: "command_output",
      timestamp: 2,
      id: "output",
      payload: { output: "y".repeat(80 * 1024) },
    });

    const result = capTaskEvents([approval, noisyOutput], 10, 32 * 1024);
    const retainedApproval = result.find((event) => event.id === "approval");

    expect(retainedApproval).toBeDefined();
    expect(
      String(
        (retainedApproval?.payload?.approval as Any)?.details?.command || "",
      ),
    ).toHaveLength(command.length);
  });

  it("caps retained payload bytes while preserving recent structural events", () => {
    const events = [
      makeEvent({
        taskId: "t1",
        type: "tool_result",
        timestamp: 1,
        id: "old-large",
        payload: { content: "a".repeat(40 * 1024) },
      }),
      makeEvent({
        taskId: "t1",
        type: "assistant_message",
        timestamp: 2,
        id: "structural",
        payload: { content: "keep me" },
      }),
      makeEvent({
        taskId: "t1",
        type: "tool_result",
        timestamp: 3,
        id: "new-large",
        payload: { content: "b".repeat(40 * 1024) },
      }),
    ];

    const result = capTaskEvents(events, 10, 45 * 1024);

    expect(result.map((event) => event.id)).toContain("structural");
    expect(result.map((event) => event.id)).toContain("new-large");
    expect(result.map((event) => event.id)).not.toContain("old-large");
  });

  it("preserves the latest plan and step lifecycle state under payload pressure", () => {
    const plan = makeEvent({
      id: "plan",
      taskId: "t1",
      type: "timeline_step_updated",
      timestamp: 1,
      stepId: "task:t1",
      payload: {
        legacyType: "plan_created",
        plan: {
          steps: [
            { id: "1", description: "Collect sources", status: "pending" },
            { id: "2", description: "Write report", status: "pending" },
          ],
        },
      },
    });
    const stepOneCompleted = makeEvent({
      id: "step-1-completed",
      taskId: "t1",
      type: "timeline_step_finished",
      timestamp: 3,
      stepId: "1",
      payload: {
        legacyType: "step_completed",
        step: { id: "1", description: "Collect sources" },
      },
    });
    const stepTwoStarted = makeEvent({
      id: "step-2-started",
      taskId: "t1",
      type: "timeline_step_started",
      timestamp: 6,
      stepId: "2",
      payload: {
        legacyType: "step_started",
        step: { id: "2", description: "Write report" },
      },
    });
    const events = [
      plan,
      makeEvent({
        id: "old-large",
        taskId: "t1",
        type: "tool_result",
        timestamp: 2,
        payload: { content: "a".repeat(40 * 1024) },
      }),
      stepOneCompleted,
      makeEvent({
        id: "middle-large",
        taskId: "t1",
        type: "tool_result",
        timestamp: 4,
        payload: { content: "b".repeat(40 * 1024) },
      }),
      makeEvent({
        id: "new-large",
        taskId: "t1",
        type: "tool_result",
        timestamp: 5,
        payload: { content: "c".repeat(40 * 1024) },
      }),
      stepTwoStarted,
    ];

    const result = capTaskEvents(events, 5, 45 * 1024);
    const shared = deriveSharedTaskEventUiState({
      rawEvents: result,
      task: { id: "t1", status: "executing" } as Any,
      workspace: null,
      projectionMode: "live",
      liveWindowSize: 2,
    });

    expect(result.map((event) => event.id)).toContain("plan");
    expect(result.map((event) => event.id)).toContain("step-1-completed");
    expect(result.map((event) => event.id)).toContain("step-2-started");
    expect(shared.planSteps).toEqual([
      expect.objectContaining({ id: "1", status: "completed" }),
      expect.objectContaining({ id: "2", status: "in_progress" }),
    ]);
  });

  it("keeps long multi-query attachment turns paired with their own replies", () => {
    const taskId = "multi-query-attachments";
    const turn = (
      number: number,
      userMessage: string,
      assistantMessage: string,
      startSeq: number,
    ): TaskEvent[] => {
      const turnId = `turn:${taskId}:follow-up:${number}`;
      return [
        makeEvent({
          id: `user-${number}`,
          eventId: `user-${number}`,
          taskId,
          type: "timeline_step_updated",
          legacyType: "user_message",
          timestamp: startSeq,
          seq: startSeq,
          stepId: turnId,
          payload: { legacyType: "user_message", message: userMessage },
        }),
        ...Array.from({ length: 630 }, (_, index) =>
          makeEvent({
            id: `runtime-${number}-${index}`,
            eventId: `runtime-${number}-${index}`,
            taskId,
            type: "timeline_step_updated",
            legacyType: "hermes_runtime_update",
            timestamp: startSeq + index + 1,
            seq: startSeq + index + 1,
            stepId: turnId,
            payload: {
              legacyType: "hermes_runtime_update",
              runtime: "hermes",
              chunk: index,
            },
          }),
        ),
        makeEvent({
          id: `assistant-${number}`,
          eventId: `assistant-${number}`,
          taskId,
          type: "timeline_step_updated",
          legacyType: "assistant_message",
          timestamp: startSeq + 631,
          seq: startSeq + 631,
          stepId: turnId,
          payload: {
            legacyType: "assistant_message",
            message: assistantMessage,
          },
        }),
        makeEvent({
          id: `complete-${number}`,
          eventId: `complete-${number}`,
          taskId,
          type: "timeline_step_finished",
          legacyType: "task_completed",
          timestamp: startSeq + 632,
          seq: startSeq + 632,
          stepId: turnId,
          payload: {
            legacyType: "task_completed",
            resultSummary: assistantMessage,
          },
        }),
      ];
    };

    const events = [
      ...turn(1, "查询明天上海飞北京的航班", "航班查询结果", 1),
      ...turn(2, "翻译成韩文，并输出 PPT", "韩文 PPT 已完成", 700),
      ...turn(3, "输出日文版 PDF，保留图片", "日文 PDF 已完成", 1_400),
    ];
    const capped = capTaskEvents(events);
    const shared = deriveSharedTaskEventUiState({
      rawEvents: capped,
      task: { id: taskId, status: "completed" } as Any,
      workspace: null,
      projectionMode: "inspect",
      verboseSteps: false,
    });
    const conversation = shared.baseTimelineItems
      .filter((item) => item.kind === "event")
      .map((item) =>
        item.kind === "event"
          ? {
              id: item.event.id,
              type:
                item.event.legacyType ||
                item.event.payload?.legacyType,
              text:
                item.event.payload?.message ||
                item.event.payload?.resultSummary,
            }
          : null,
      );

    expect(capped.length).toBeLessThanOrEqual(600);
    expect(conversation).toEqual([
      { id: "user-1", type: "user_message", text: "查询明天上海飞北京的航班" },
      { id: "complete-1", type: "task_completed", text: "航班查询结果" },
      { id: "user-2", type: "user_message", text: "翻译成韩文，并输出 PPT" },
      { id: "complete-2", type: "task_completed", text: "韩文 PPT 已完成" },
      { id: "user-3", type: "user_message", text: "输出日文版 PDF，保留图片" },
      { id: "complete-3", type: "task_completed", text: "日文 PDF 已完成" },
    ]);
  });
});
