import assert from "node:assert/strict";
import path from "node:path";

export async function runExecutionRecordChecks(page, output) {
  const id = "record-qa";
  const attached = "Translate the attached slides\n\nAttached files (relative to workspace):\n- source.pptx (.neoworker/uploads/1/source.pptx)\nAttachment metadata: size=100; mime=application/pptx\nExtracted content:\n[[ATTACHMENT_EXTRACTED_CONTENT_START]]\nSlide 1\nINTERNAL_EXTRACT_SHOULD_NEVER_RENDER\n\nSlide 2\nINTERNAL_TABLE_SHOULD_NEVER_RENDER\n[[ATTACHMENT_EXTRACTED_CONTENT_END]]";
  const event = (type, timestamp, payload) => ({ id: `${type}-${timestamp}`, taskId: id, type, timestamp, payload });
  const events = [
    event("user_message", 1000, { message: "FIRST_QUESTION" }),
    event("task_completed", 2000, { resultSummary: "FIRST_ANSWER" }),
    event("user_message", 3000, { message: attached }),
    event("tool_call", 4000, { tool: "read_file", input: { path: "source.pptx" } }),
    event("tool_result", 5000, { tool: "read_file", result: { success: true } }),
    event("follow_up_completed", 6000, { followUpMessage: attached }),
    event("task_completed", 7000, { resultSummary: "TRANSLATION_READY translated.pptx", outputSummary: { created: ["translated.pptx"], primaryOutputPath: "translated.pptx", outputCount: 1, folders: ["."] } }),
  ];
  const task = { id, title: "Execution record QA", prompt: "FIRST_QUESTION", workspaceId: "qa-workspace", status: "completed", createdAt: 1000, completedAt: 7000, updatedAt: 7000 };
  let checks = 0;
  for (const width of [1365, 760]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const running of [false, true]) {
      const data = { task: running ? { ...task, status: "executing", completedAt: undefined, updatedAt: 8000 } : task,
        events: running ? [...events, event("user_message", 8000, { message: "NEXT_QUESTION" })] : events,
        qaProps: { hasMoreTimelineHistory: true },
      };
      // Functions are supplied in the browser, not serialized across Playwright.
      await page.evaluate((value) => { value.qaProps.onLoadMoreTimelineHistory = () => { window.historyRequests = (window.historyRequests || 0) + 1; }; window.renderData(value); }, data);
      await page.locator(".verbose-switch").waitFor();
      for (const enabled of [true, false, true, false]) {
        const toggle = page.locator(".verbose-switch");
        if ((await toggle.getAttribute("aria-checked")) !== String(enabled)) await toggle.click();
        await page.waitForTimeout(150);
        const text = await page.locator(".main-body").innerText();
        assert.match(text, /FIRST_ANSWER/);
        assert.match(text, /TRANSLATION_READY/);
        assert.doesNotMatch(text, /INTERNAL_EXTRACT|INTERNAL_TABLE|Attachment metadata|ATTACHMENT_EXTRACTED|Attached files/);
        assert.doesNotMatch(text, /完整时间线|Show full timeline|Load earlier history|已收到跟进/);
        assert.equal(await page.locator(".conversation-artifact-stack").filter({ hasText: "translated.pptx" }).count(), 1);
        if (enabled) {
          assert.ok(await page.locator(".action-block").count() > 0, "Execution records must expose useful tool steps");
          await page.screenshot({ path: path.join(output, `execution-record-on-${width}-${running}.png`), fullPage: true });
        } else {
          assert.equal(await page.locator(".action-block").count(), 0);
          assert.equal(await page.locator(".follow-up-completed-details").count(), 0);
        }
        const history = page.getByRole("button", { name: /加载更早对话|Load earlier messages/ });
        assert.equal(await history.count(), 1);
        await history.click();
        checks++;
      }
      await page.screenshot({ path: path.join(output, `execution-record-${width}-${running}.png`), fullPage: true });
    }
  }
  assert.equal(await page.evaluate(() => window.historyRequests), checks);
  return checks;
}
