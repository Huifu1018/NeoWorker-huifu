// NEOWORKER_QA_TIMING_ONLY=1 node scripts/qa/artifact-turn-rendering.mjs
import assert from "node:assert/strict";
import path from "node:path";

export async function runTimerChecks(page, output) {
  const start = Date.now();
  await page.clock.install({ time: new Date(start) });
  await page.clock.pauseAt(new Date(start));
  const event = (type, timestamp, payload = {}) => ({
    id: `${type}:${timestamp}`,
    eventId: `${type}:${timestamp}`,
    taskId: "timer-qa",
    type,
    legacyType: type,
    timestamp,
    payload,
  });
  let events = [];
  let task = {
    id: "timer-qa",
    title: "Timer QA",
    prompt: "FIRST_QUERY",
    workspaceId: "qa-workspace",
    status: "executing",
    createdAt: start,
    updatedAt: start,
  };
  const label = page.locator(".timeline-controls-label.with-duration");
  const mount = async () => {
    await page.evaluate((data) => window.renderData(data), { task, events });
    await page.clock.runFor(100);
  };
  const seconds = async () => {
    const text = (await label.allTextContents()).join(" ");
    const match = text.match(
      /(?:已工作|用时|Working for|Worked for)\s*(?:(\d+)m\s*)?(?:(\d+)s)?/,
    );
    assert.ok(match, "Missing timer: " + text);
    return Number(match[1] || 0) * 60 + Number(match[2] || 0);
  };
  let checks = 0;
  for (let turn = 1; turn <= 5; turn++) {
    if (turn === 3) await page.setViewportSize({ width: 760, height: 1000 });
    const now = await page.evaluate(() => Date.now());
    events = [
      ...events,
      event("user_message", now, {
        message: turn === 1 ? "FIRST_QUERY" : `FOLLOW_UP_${turn}`,
      }),
    ];
    // Keep the previous completedAt on later executing task rows, as happens in IPC updates.
    task = { ...task, status: "executing", updatedAt: now };
    await mount();
    const before = await seconds();
    assert.ok(before <= 1, `Turn ${turn} did not reset: ${before}s`);
    await page.clock.runFor(5000);
    const after = await seconds();
    await page.screenshot({
      path: path.join(output, `timer-turn-${turn}.png`),
    });
    assert.ok(
      after >= before + 4,
      `Turn ${turn} froze: ${before}s -> ${after}s without new events`,
    );
    assert.equal(
      await page.locator(".timeline-controls-label.is-working").count(),
      1,
      "More than one round is spinning",
    );
    console.log(JSON.stringify({ turn, before, after }));
    checks++;
    if (turn === 2) {
      await page.locator(".verbose-switch").click();
      await page.clock.runFor(2000);
      assert.ok(
        (await seconds()) >= after + 1,
        "Toggling execution records froze the clock",
      );
      await page.locator(".verbose-switch").click();
      checks++;
    }
    if (turn === 3) {
      await page.clock.fastForward(60_000);
      assert.ok((await seconds()) >= 65, "Clock stopped across the minute boundary");
      checks++;
    }
    // Ending the turn must freeze the visible time even before the task row refresh arrives.
    const endedAt = await page.evaluate(() => Date.now());
    events = [
      ...events,
      event(turn === 4 ? "follow_up_failed" : "task_completed", endedAt, {
        resultSummary: `TURN_${turn}_DONE`,
        outputSummary: { created: [], outputCount: 0, folders: [] },
      }),
    ];
    await mount();
    assert.equal(
      await page.locator(".timeline-controls-label.is-working").count(),
      0,
      "Terminal event left a running indicator",
    );
    task = {
      ...task,
      status: turn === 4 ? "failed" : "completed",
      completedAt: endedAt,
      updatedAt: endedAt,
    };
    await mount();
    const ended = await seconds();
    await page.clock.runFor(3000);
    assert.equal(
      await seconds(),
      ended,
      `Turn ${turn} kept ticking after completion`,
    );
    assert.equal(
      await page.locator(".timeline-controls-label.is-working").count(),
      0,
      "A historical round kept spinning",
    );
    checks++;
  }
  return checks;
}
