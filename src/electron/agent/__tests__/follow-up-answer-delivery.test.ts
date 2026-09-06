import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";

vi.mock("electron", () => ({ app: { getPath: vi.fn(() => "/tmp") } }));

// Captured from the affected turn: tools returned, but the only final text
// announced acquisition and never answered the user's weather question.
const acquisition = "拿到了权威数据（中国天气网）。明天 2026-09-07（周一）的预报已经读到。";
const answer = "北京明天晴，20–28°C，北风 2 级。来源：中国天气网。";
const noFiles = { created: [], outputCount: 0, folders: [] };

function fixture(reply: string): Any {
  const e = Object.create(TaskExecutor.prototype) as Any;
  e.task = { id: "weather-after-html", status: "executing", terminalStatus: "partial_success", failureClass: "contract_unmet_write_required" };
  e.failureClass = "contract_unmet_write_required";
  e.bestKnownOutcome = {
    capturedAt: 1,
    resultSummary: "Earlier HTML draft is missing sections. ".repeat(30),
    terminalStatus: "partial_success",
    failureClass: "contract_unmet_write_required",
    blockingIssues: ["HTML missing"],
    outputSummary: { created: ["old.html"], outputCount: 1, folders: [] },
  };
  e.conversationHistory = [];
  e.systemPrompt = "Answer from evidence.";
  e.activeConversationTurnId = "weather-turn";
  e.sanitizeFallbackInstruction = (text: string) => text;
  e.runTextTurnKernel = vi.fn(async (opts: Any) => ({
    messages: [...opts.messages, { role: "assistant", content: [{ type: "text", text: reply }] }],
    assistantText: reply,
  }));
  e.enforceTaskOutputLanguageForDisplay = (text: string) => text;
  e.getFollowUpArtifactGuardError = vi.fn(() => null);
  e.emitEvent = vi.fn();
  e.daemon = { updateTask: vi.fn() };
  e.applyRuntimeTaskProjectionToTask = vi.fn(() => ({}));
  e.getCompletionProjectionFields = vi.fn(() => ({}));
  e.buildTaskOutputSummary = vi.fn(() => noFiles);
  e.applyGoalTerminalState = vi.fn();
  e.getContentFallback = vi.fn(() => "");
  e.saveConversationSnapshot = vi.fn();
  e.appendConversationHistory = vi.fn((message: Any) => e.conversationHistory.push(message));
  return e;
}

function recoveryOptions(extensions: string[] = []): Any {
  return {
    messages: [
      { role: "user", content: [{ type: "text", text: "帮我查一下明天北京的天气" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "fetch-1", content: "Fixture forecast: sunny, 20–28°C, north wind force 2." }] },
      { role: "assistant", content: [{ type: "text", text: acquisition }] },
    ],
    outputLanguageDirective: "用简体中文回答。",
    requiresSimplifiedChinese: true,
    contract: { requiresArtifactEvidence: extensions.length > 0, requiredArtifactExtensions: extensions },
    evidenceStartedAt: 10,
    createdFilesBefore: new Set(),
  };
}

describe("follow-up answer delivery", () => {
  it.each([
    acquisition,
    "已读取文件。",
    "已经获取了相关信息。",
    "I found the requested information.",
    "We have retrieved the forecast data.",
  ])("does not accept acquisition-only text: %s", (text) => {
    const e = fixture("");
    expect(e.isProgressOnlyFollowUpText(text)).toBe(true);
    expect(e.isUsefulResultSummaryCandidate(text)).toBe(false);
    expect(e.followUpNeedsToolFreeFinalResponse(true, !e.isProgressOnlyFollowUpText(text))).toBe(true);
  });

  it.each([
    answer,
    `${acquisition}\n北京明天晴，20–28°C。`,
    "未查到明天的预报：来源被验证码拦截，无法核实温度。",
    "OK",
    "I found the data. Revenue increased by 12%.",
    "拿到了数据：营收同比增长 12%。",
  ])("preserves actual findings, short verdicts and blockers: %s", (text) => {
    expect(fixture("").isProgressOnlyFollowUpText(text)).toBe(false);
  });

  it("recovers the actual answer from current tool results with one answer-only call", async () => {
    const e = fixture(answer);
    const messages = await e.completeFollowUpAnswer(recoveryOptions());
    expect(e.runTextTurnKernel).toHaveBeenCalledTimes(1);
    expect(e.runTextTurnKernel.mock.calls[0][0].messages[1]).toEqual(recoveryOptions().messages[1]);
    expect(e.runTextTurnKernel.mock.calls[0][0]).not.toHaveProperty("tools");
    expect(messages.at(-1).content[0].text).toBe(answer);
    expect(e.lastAssistantText).toBe(answer);
    expect(e.emitEvent).toHaveBeenCalledWith("assistant_message", expect.objectContaining({ message: answer }));
  });

  it("recovers a planning acknowledgement even without tool calls and preserves a short new answer", async () => {
    const e = fixture("42");
    const status = "规划模式（PLANNING MODE）已确认，跳过本步骤的工具调用。";
    expect(e.followUpNeedsToolFreeFinalResponse(false, true, status)).toBe(true);
    expect(e.followUpNeedsToolFreeFinalResponse(false, true, "42")).toBe(false);
    e.conversationHistory = await e.completeFollowUpAnswer(recoveryOptions());
    e.finalizeFollowUpCompletion("Follow-up completed", { outputEvidenceStartedAt: 10 });
    expect(e.task.resultSummary).toBe("42");
    expect(e.bestKnownOutcome.resultSummary).toBe("42");
  });

  it.each(["", acquisition])("fails an unanswered non-artifact turn without inventing file success (%s)", async (reply) => {
    const e = fixture(reply);
    await expect(e.completeFollowUpAnswer(recoveryOptions())).rejects.toThrow("without a conclusive final response");
    expect(e.runTextTurnKernel).toHaveBeenCalledTimes(1);
    expect(e.getFollowUpArtifactGuardError).not.toHaveBeenCalled();
    expect(e.emitEvent.mock.calls.some(([, payload]: Any[]) => payload.synthesizedFromArtifactEvidence)).toBe(false);
  });

  it("retains the fallback only for an explicitly requested, verified artifact", async () => {
    const e = fixture("");
    const messages = await e.completeFollowUpAnswer(recoveryOptions([".html"]));
    expect(e.getFollowUpArtifactGuardError).toHaveBeenCalledTimes(1);
    expect(messages.at(-1).content[0].text).toContain("HTML 文件");
    e.getFollowUpArtifactGuardError.mockReturnValue("HTML incomplete");
    await expect(e.completeFollowUpAnswer(recoveryOptions([".html"]))).rejects.toThrow("without a conclusive final response");
  });

  it("can fail then answer again in the same session without stale HTML outcomes", async () => {
    const e = fixture(acquisition);
    await e.completeFollowUpAnswer(recoveryOptions()).catch((error: Error) => {
      e.finalizeRecoverableFollowUpFailure(error, "completed", 5);
    });
    expect(e.task.status).toBe("completed"); // terminal parent; composer is not busy
    expect(e.emitEvent).toHaveBeenCalledWith("follow_up_failed", expect.objectContaining({ turnId: "weather-turn" }));
    expect(e.emitEvent.mock.calls.some(([type]: Any[]) => type === "task_completed")).toBe(false);

    e.runTextTurnKernel.mockImplementation(async (opts: Any) => ({
      messages: [...opts.messages, { role: "assistant", content: [{ type: "text", text: answer }] }], assistantText: answer,
    }));
    e.conversationHistory = await e.completeFollowUpAnswer(recoveryOptions());
    e.finalizeFollowUpCompletion("Follow-up completed", { outputEvidenceStartedAt: 10 });
    expect(e.task.resultSummary).toBe(answer);
    expect(e.task.terminalStatus).toBe("ok");
    expect(e.task.failureClass).toBeUndefined();
    expect(e.bestKnownOutcome.resultSummary).toBe(answer);
    expect(e.bestKnownOutcome.outputSummary).toEqual(noFiles);
    expect(e.bestKnownOutcome.blockingIssues ?? []).toEqual([]);
    expect(e.bestKnownOutcome.failureClass).toBeUndefined();
    expect(e.daemon.updateTask).toHaveBeenCalledWith(e.task.id, expect.objectContaining({ terminalStatus: "ok", failureClass: undefined, error: null }));
    expect(e.emitEvent).toHaveBeenCalledWith("task_completed", expect.objectContaining({ resultSummary: answer, outputSummary: noFiles }));
  });
});
