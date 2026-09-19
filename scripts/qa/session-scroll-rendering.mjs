import assert from "node:assert/strict";
import path from "node:path";

export async function runSessionScrollChecks(page, output) {
  await page.addStyleTag({ content: "html,body,#root{height:100%;margin:0} .main-content{height:100%;min-height:0}" });
  const makeSession = (id, turns) => {
    const events = [];
    for (let turn = 0; turn < turns; turn++) {
      for (const [offset, type, payload] of [
        [0, "user_message", { message: `${id} question ${turn}` }],
        [1, "task_completed", { resultSummary: `${id} answer ${turn}\n\n` + Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: stable conversation content for scroll regression testing.`).join("\n\n") }],
      ]) events.push({ id: `${id}:${turn}:${offset}`, taskId: id, type, timestamp: 1000 + turn * 1000 + offset, payload });
    }
    return { task: { id, title: id, prompt: `${id} question 0`, workspaceId: "qa-workspace", status: "completed", createdAt: 1000, updatedAt: events.at(-1).timestamp, completedAt: events.at(-1).timestamp }, events };
  };
  const long = makeSession("scroll-long", 8);
  const short = makeSession("scroll-short", 1);
  const render = async (data) => {
    await page.evaluate((value) => window.renderData(value), data);
    await page.waitForTimeout(500);
  };
  const sample = async (data) => page.evaluate(async (value) => {
    const frames = [];
    window.renderData(value);
    for (let i = 0; i < 24; i++) {
      await new Promise(requestAnimationFrame);
      const el = document.querySelector(".main-body");
      if (!el.textContent.includes(value.task.prompt)) continue;
      const anchor = Array.from(el.querySelectorAll(".assistant-message")).find((node) => node.textContent.includes(`${value.task.id} answer 1`));
      frames.push({ top: el.scrollTop, bottom: el.scrollHeight - el.clientHeight, behavior: getComputedStyle(el).scrollBehavior, anchorTop: anchor?.getBoundingClientRect().top });
    }
    return frames;
  }, data);
  let checks = 0;
  for (const width of [1365, 760]) {
    await page.setViewportSize({ width, height: 1000 });
    await render(long);
    await page.evaluate(() => {
      const el = document.querySelector(".main-body");
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    });
    await page.waitForTimeout(100);
    await render(short);
    const restored = await sample(long);
    console.log(JSON.stringify({ width, restored }));
    assert.ok(restored.length > 0 && restored.every((frame) => Math.abs(frame.bottom - frame.top) < 3), "Switching sessions swept through historical messages");
    checks++;
    const timestamp = Date.now();
    const followUp = {
      task: { ...long.task, status: "executing", completedAt: undefined, updatedAt: timestamp },
      events: [...long.events, { id: `next-${width}`, taskId: long.task.id, type: "user_message", timestamp, payload: { message: "NEXT_QUESTION" } }],
      optimisticFollowUpStartedAt: timestamp,
    };
    const sent = await sample(followUp);
    console.log(JSON.stringify({ width, sent }));
    assert.ok(sent.length > 0 && sent.every((frame) => Math.abs(frame.bottom - frame.top) < 3), "Sending a question swept through history");
    checks++;
    await page.screenshot({ path: path.join(output, `session-scroll-${width}.png`) });

    await render(long);
    await page.evaluate(() => {
      document.querySelector(".main-body").scrollTo({ top: 700, behavior: "instant" });
    });
    await page.waitForTimeout(100);
    const readerAnchorTop = await page.locator(".assistant-message").filter({ hasText: "scroll-long answer 1" }).first().evaluate((el) => el.getBoundingClientRect().top);
    await render(short);
    const reader = await sample(long);
    console.log(JSON.stringify({ width, reader }));
    // Browser scroll anchoring can adjust scrollTop when headers settle; the
    // paragraph on screen, rather than its document offset, must stay fixed.
    assert.ok(reader.length > 0 && reader.every((frame) => Math.abs(frame.anchorTop - readerAnchorTop) < 3), "Switching sessions lost the reader's position");
    checks++;
    // A background update must not pull someone reading history to the bottom.
    await render({ ...long, task: { ...long.task, updatedAt: Date.now() } });
    assert.ok(Math.abs(await page.locator(".main-body").evaluate((el) => el.scrollTop) - 700) < 3);
    checks++;
  }
  return checks;
}
