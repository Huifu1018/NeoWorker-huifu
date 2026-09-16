import { describe, expect, it } from "vitest";

import {
  annotateRecoveredIntermediateFailures,
  collapseRepeatedTimelineFailures,
  getCompletionSummaryText,
  resolveTimelineControlsPlacement,
  shouldShowTimelineControls,
} from "../MainContent/task-event-presentation";

const taskEvent = (
  id: string,
  type: string,
  timestamp: number,
  payload: Record<string, unknown> = {},
) =>
  ({ id, taskId: "task-1", type, timestamp, payload }) as any;

describe("annotateRecoveredIntermediateFailures", () => {
  it("marks a failed presentation alias as recovered after a later alias succeeds", () => {
    const events = annotateRecoveredIntermediateFailures([
      taskEvent("query", "user_message", 1),
      taskEvent("failure", "timeline_error", 2, {
        legacyType: "tool_error",
        tool: "create_presentation",
        toolUseId: "call-1",
        error: "Unsupported presentation field at slides[0].0",
      }),
      taskEvent("success", "tool_result", 3, {
        tool: "generate_presentation",
        toolUseId: "call-2",
        result: { success: true, path: "final.pptx" },
      }),
    ]);

    expect(events[1].payload?.recoveredIntermediateFailure).toBe(true);
  });

  it("marks a blocked Shell attempt as recovered only after useful fallback output", () => {
    const events = annotateRecoveredIntermediateFailures([
      taskEvent("query", "user_message", 1),
      taskEvent("shell", "timeline_error", 2, {
        legacyType: "tool_error",
        tool: "run_command",
        error: "Tool run_command blocked by policy: Workspace shell capability is disabled.",
      }),
      taskEvent("parse", "tool_result", 3, {
        tool: "parse_presentation",
        result: { success: true },
      }),
      taskEvent("complete", "task_completed", 4, { status: "completed" }),
    ]);

    expect(events[1].payload?.recoveredIntermediateFailure).toBe(true);
  });

  it("does not let a later user turn recover an earlier turn's failure", () => {
    const events = annotateRecoveredIntermediateFailures([
      taskEvent("query-1", "user_message", 1),
      taskEvent("failure", "timeline_error", 2, {
        legacyType: "tool_error",
        tool: "create_presentation",
        error: "Invalid input",
      }),
      taskEvent("query-2", "user_message", 3),
      taskEvent("success", "tool_result", 4, {
        tool: "generate_presentation",
        result: { success: true },
      }),
    ]);

    expect(events[1].payload?.recoveredIntermediateFailure).toBeUndefined();
  });

  it("presents failures as pending recovery while the current task is still running", () => {
    const events = annotateRecoveredIntermediateFailures(
      [
        taskEvent("query", "user_message", 1),
        taskEvent("failure", "timeline_error", 2, {
          legacyType: "tool_error",
          tool: "run_command",
          error: "Command exited with code 1",
        }),
      ],
      "executing",
    );

    expect(events[1].payload?.intermediateFailurePending).toBe(true);
    expect(events[1].payload?.recoveredIntermediateFailure).toBeUndefined();
  });

  it("marks earlier execution failures as recovered when a later artifact is emitted", () => {
    const events = annotateRecoveredIntermediateFailures([
      taskEvent("query", "user_message", 1),
      taskEvent("failure", "timeline_error", 2, {
        legacyType: "tool_error",
        tool: "monty_run",
        error: "Variable x is not defined",
      }),
      taskEvent("artifact", "timeline_artifact_emitted", 3, {
        path: "translated.pptx",
      }),
    ]);

    expect(events[1].payload?.recoveredIntermediateFailure).toBe(true);
    expect(events[1].payload?.intermediateFailurePending).toBe(false);
  });

  it("keeps unresolved failures fatal after the task fails", () => {
    const events = annotateRecoveredIntermediateFailures(
      [
        taskEvent("query", "user_message", 1),
        taskEvent("failure", "timeline_error", 2, {
          legacyType: "tool_error",
          tool: "run_command",
          error: "Command exited with code 1",
        }),
      ],
      "failed",
    );

    expect(events[1].payload?.intermediateFailurePending).toBeUndefined();
    expect(events[1].payload?.recoveredIntermediateFailure).toBeUndefined();
  });
});

describe("collapseRepeatedTimelineFailures", () => {
  it("shows one aggregate row for repeated tool failures in one user turn", () => {
    const events = collapseRepeatedTimelineFailures([
      taskEvent("query", "user_message", 1),
      taskEvent("failure-1", "timeline_error", 2, {
        legacyType: "tool_error",
        tool: "generate_spreadsheet",
        error: "At least one worksheet is required.",
      }),
      taskEvent("progress", "progress_update", 3, { message: "Retrying" }),
      taskEvent("failure-2", "timeline_error", 4, {
        legacyType: "tool_error",
        tool: "create_spreadsheet",
        error: "At least one worksheet is required.",
      }),
      taskEvent("failure-3", "timeline_error", 5, {
        legacyType: "tool_error",
        tool: "generate_spreadsheet",
        error: "At least one worksheet is required.",
      }),
    ]);

    expect(events.map((event) => event.id)).toEqual([
      "query",
      "failure-1",
      "progress",
    ]);
    expect(events[1].payload?.repeatedFailureCount).toBe(3);
  });

  it("does not merge the same error across follow-up turns", () => {
    const events = collapseRepeatedTimelineFailures([
      taskEvent("query-1", "user_message", 1),
      taskEvent("failure-1", "timeline_error", 2, {
        legacyType: "tool_error",
        tool: "create_spreadsheet",
        error: "At least one worksheet is required.",
      }),
      taskEvent("query-2", "user_message", 3),
      taskEvent("failure-2", "timeline_error", 4, {
        legacyType: "tool_error",
        tool: "create_spreadsheet",
        error: "At least one worksheet is required.",
      }),
    ]);

    expect(events.map((event) => event.id)).toEqual([
      "query-1",
      "failure-1",
      "query-2",
      "failure-2",
    ]);
  });
});

describe("getCompletionSummaryText", () => {
  it("does not append an internal semantic tool summary to a delivered answer", () => {
    const text = getCompletionSummaryText({
      id: "completed-1",
      taskId: "task-1",
      timestamp: 1,
      type: "timeline_step_finished",
      payload: {
        legacyType: "task_completed",
        resultSummary: "这是正式回复。",
        semanticSummary: "Let Me Check The Workspace",
      },
    } as any);

    expect(text).toBe("这是正式回复。");
  });

  it("uses the semantic summary only when no delivery message is available", () => {
    const text = getCompletionSummaryText({
      id: "completed-2",
      taskId: "task-1",
      timestamp: 1,
      type: "timeline_step_finished",
      payload: {
        legacyType: "task_completed",
        semanticSummary: "任务已完成。",
      },
    } as any);

    expect(text).toBe("任务已完成。");
  });

  it("prefers the durable delivery when a late progress line overwrote the direct summary", () => {
    const text = getCompletionSummaryText({
      id: "completed-3",
      taskId: "task-1",
      timestamp: 1,
      type: "timeline_step_finished",
      payload: {
        legacyType: "task_completed",
        resultSummary: "中文文件名导致 shell 执行异常。",
        bestKnownOutcome: {
          resultSummary: "Excel 已生成，共 5 个工作表、85 行数据。",
        },
      },
    } as any);

    expect(text).toBe("Excel 已生成，共 5 个工作表、85 行数据。");
  });

  it("keeps the turn-authoritative delivery when an older verbose analysis is longer", () => {
    const text = getCompletionSummaryText({
      id: "completed-4",
      taskId: "task-1",
      timestamp: 1,
      type: "timeline_step_finished",
      payload: {
        legacyType: "task_completed",
        resultSummary: "✅ 正式 DOCX 已生成并通过质检。",
        outputSummary: {
          created: ["final.docx"],
          primaryOutputPath: "final.docx",
          outputCount: 1,
          folders: ["."],
        },
        bestKnownOutcome: {
          resultSummary:
            "本步骤完成（只读分析，未产出交付文件）。这是更长但已经过时的中间分析。",
        },
      },
    } as any);

    expect(text).toBe("✅ 正式 DOCX 已生成并通过质检。");
  });

  it("does not borrow task-level durable text for a recovered older turn", () => {
    const text = getCompletionSummaryText({
      id: "completed-5",
      taskId: "task-1",
      timestamp: 1,
      type: "task_completed",
      payload: {
        outputSummary: {
          created: ["translated.pptx"],
          primaryOutputPath: "translated.pptx",
          outputCount: 1,
          folders: ["."],
        },
        bestKnownOutcome: {
          resultSummary:
            "明天是 2026年9月14日（周一）。推荐坐高铁，首选 G19。",
        },
        deliveryRecoveredBeforeLaterUserMessage: true,
      },
    } as any);

    expect(text).toBe("");
  });
});

describe("shouldShowTimelineControls", () => {
  it("keeps task status controls visible while a conversational task is running", () => {
    expect(
      shouldShowTimelineControls({
        hasNonConversationEvents: false,
        isTaskWorking: true,
        isTaskFinished: false,
      }),
    ).toBe(true);
  });

  it("keeps task status controls visible after completion", () => {
    expect(
      shouldShowTimelineControls({
        hasNonConversationEvents: false,
        isTaskWorking: false,
        isTaskFinished: true,
      }),
    ).toBe(true);
  });

  it("does not show task controls for an idle prompt without execution state", () => {
    expect(
      shouldShowTimelineControls({
        hasNonConversationEvents: false,
        isTaskWorking: false,
        isTaskFinished: false,
      }),
    ).toBe(false);
  });
});

describe("resolveTimelineControlsPlacement", () => {
  it("moves controls from the initial prompt to the latest follow-up query", () => {
    expect(
      resolveTimelineControlsPlacement({
        showTimelineControls: true,
        hasInitialPrompt: true,
        hasUserFollowUp: true,
      }),
    ).toBe("latest-query");
  });

  it("keeps controls on the initial query before any follow-up", () => {
    expect(
      resolveTimelineControlsPlacement({
        showTimelineControls: true,
        hasInitialPrompt: true,
        hasUserFollowUp: false,
      }),
    ).toBe("initial-query");
  });

  it("falls back to a standalone row only when no query bubble exists", () => {
    expect(
      resolveTimelineControlsPlacement({
        showTimelineControls: true,
        hasInitialPrompt: false,
        hasUserFollowUp: false,
      }),
    ).toBe("standalone");
  });
});
