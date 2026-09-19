import assert from "node:assert/strict";
import path from "node:path";

export async function runHistoryPaginationChecks(page, output) {
  await page.addStyleTag({ content: "html,body,#root{height:100%;margin:0}.main-content{height:100%;min-height:0}" });
  let checks = 0;
  for (const width of [1365, 480]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate((width) => {
      const id = `history-${width}`;
      const events = [];
      for (let turn = 0; turn < 8; turn++) {
        events.push({ id: `${id}-user-${turn}`, taskId: id, type: "user_message", timestamp: 1000 + turn * 1000, payload: { message: `QUESTION_${turn}` } });
        events.push({ id: `${id}-answer-${turn}`, taskId: id, type: "task_completed", timestamp: 1001 + turn * 1000, payload: { resultSummary: `ANSWER_${turn}\n\n` + Array.from({ length: 6 }, (_, i) => `Paragraph ${i}. Stable text for history reading position verification.`).join("\n\n") } });
      }
      window.historyRequests = 0;
      window.historyData = {
        task: { id, title: id, prompt: "QUESTION_0", workspaceId: "qa-workspace", status: "completed", createdAt: 1000, updatedAt: 8001, completedAt: 8001 },
        events: events.slice(10),
        qaProps: { hasMoreTimelineHistory: true, onLoadMoreTimelineHistory: async () => {
          window.historyRequests++;
          window.historyData.qaProps.isLoadingTimelineHistory = true;
          window.historyData.qaProps.timelineHistoryError = null;
          window.renderData({ ...window.historyData, qaProps: { ...window.historyData.qaProps } });
          await new Promise((resolve, reject) => { window.finishHistory = (mode) => {
            window.historyData.qaProps.isLoadingTimelineHistory = false;
            if (mode === "error") window.historyData.qaProps.timelineHistoryError = "private backend failure";
            if (mode === "prepend") window.historyData.events = events.slice(6);
            if (mode === "done") window.historyData.qaProps.hasMoreTimelineHistory = false;
            if (mode !== "detached") window.renderData({ ...window.historyData, qaProps: { ...window.historyData.qaProps } });
            if (mode === "reject") reject(new Error("unexpected callback error")); else resolve();
          }; });
        } },
      };
      window.renderData(window.historyData);
    }, width);
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole("button", { name: /加载更早对话|Load earlier messages/ }).count(), 0);
    assert.equal(await page.evaluate(() => window.historyRequests), 0, "Opening must not fetch history");
    await page.locator(".main-body").evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.historyRequests), 0, "Programmatic restoration must not fetch");
    const box = await page.locator(".main-body").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 100);
    const anchor = page.locator(".assistant-message").filter({ hasText: "ANSWER_5" }).first();
    const before = await anchor.evaluate((el) => el.getBoundingClientRect().top);
    await page.mouse.wheel(0, -100);
    await page.waitForFunction(() => window.historyRequests === 1);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.historyRequests), 1, "In-flight requests must be deduplicated");
    await page.evaluate(() => window.finishHistory("prepend"));
    await page.waitForTimeout(500);
    console.log(JSON.stringify({ width, before, after: await anchor.evaluate((el) => el.getBoundingClientRect().top), scroll: await page.locator(".main-body").evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, body: el.clientHeight })) }));
    assert.ok(Math.abs(await anchor.evaluate((el) => el.getBoundingClientRect().top) - before) < 3, "Prepending must preserve visible text position");
    assert.equal(await page.evaluate(() => window.historyRequests), 1, "Page completion must not drain remaining pages");
    checks += 5;

    const requestFromTop = async (count, input = "wheel") => {
      await page.locator(".main-body").evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
      await page.waitForTimeout(450);
      if (input === "keyboard") {
        assert.equal(await page.locator(".main-body").getAttribute("tabindex"), "0");
        await page.locator(".main-body").focus();
        await page.keyboard.press("Home");
      } else await page.mouse.wheel(0, -100);
      await page.waitForFunction((n) => window.historyRequests === n, count);
    };
    await requestFromTop(2, "keyboard");
    await page.evaluate(() => window.finishHistory("error"));
    await page.getByRole("button", { name: /重试|Retry/, exact: true }).waitFor();
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(450);
    assert.equal(await page.evaluate(() => window.historyRequests), 2, "Failure must not retry automatically");
    assert.doesNotMatch(await page.locator(".main-body").innerText(), /private backend failure/);
    await page.getByRole("button", { name: /重试|Retry/, exact: true }).click();
    await page.waitForFunction(() => window.historyRequests === 3);
    await page.evaluate(() => window.finishHistory("reject"));
    await page.getByRole("button", { name: /重试|Retry/, exact: true }).waitFor();
    await page.getByRole("button", { name: /重试|Retry/, exact: true }).click();
    await page.waitForFunction(() => window.historyRequests === 4);
    await page.evaluate(() => window.finishHistory("empty"));
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.historyRequests), 4, "A page of hidden logs must not cause a fetch loop");
    assert.equal(await page.getByRole("button", { name: /重试|Retry/, exact: true }).count(), 0);
    checks += 4;

    await requestFromTop(5);
    await page.evaluate(() => window.finishHistory("done"));
    await page.waitForTimeout(500);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.historyRequests), 5, "End of history must not fetch");
    await page.screenshot({ path: path.join(output, `history-pagination-${width}.png`) });
    checks++;

    await page.evaluate(() => {
      window.historyData.qaProps.hasMoreTimelineHistory = true;
      window.renderData({ ...window.historyData, qaProps: { ...window.historyData.qaProps } });
    });
    await page.waitForTimeout(450);
    await page.locator(".main-body").evaluate((el) => {
      el.dispatchEvent(new TouchEvent("touchstart", { touches: [new Touch({ identifier: 1, target: el, clientY: 100 })] }));
      el.dispatchEvent(new TouchEvent("touchmove", { touches: [new Touch({ identifier: 1, target: el, clientY: 180 })] }));
    });
    await page.waitForFunction(() => window.historyRequests === 6);
    await page.evaluate(() => {
      window.renderData({ task: { ...window.historyData.task, id: "other-session", prompt: "OTHER_SESSION" }, events: [], qaProps: {} });
    });
    await page.waitForTimeout(300);
    const switchedTop = await page.locator(".main-body").evaluate((el) => el.scrollTop);
    await page.evaluate(() => window.finishHistory("detached"));
    await page.waitForTimeout(500);
    assert.match(await page.locator(".main-body").innerText(), /OTHER_SESSION/);
    assert.equal(await page.locator(".main-body").evaluate((el) => el.scrollTop), switchedTop);
    assert.equal(await page.evaluate(() => window.historyRequests), 6, "Switching sessions must not request additional pages");
    checks += 2;
    await page.evaluate(() => {
      window.shortRequests = 0;
      window.renderData({
        task: { ...window.historyData.task, id: "short-history", prompt: "SHORT_TASK" },
        events: [{ id: "short-answer", taskId: "short-history", type: "task_completed", timestamp: 8001, payload: { resultSummary: "SHORT_ANSWER" } }],
        qaProps: { hasMoreTimelineHistory: true, onLoadMoreTimelineHistory: () => { window.shortRequests++; } },
      });
    });
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.shortRequests), 0);
    for (const expected of [1, 2]) {
      await page.mouse.wheel(0, -100);
      await page.waitForFunction((n) => window.shortRequests === n, expected);
      await page.waitForTimeout(450);
      assert.equal(await page.locator(".timeline-history-control.is-loading").count(), 0, "A no-op callback must release pending state");
    }
    checks += 3;
  }
  return checks;
}
