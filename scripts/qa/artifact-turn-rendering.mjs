// Mount the actual conversation UI without an agent, network tools, or user-data writes.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { runTimerChecks } from "./task-timer-rendering.mjs";
import { runSessionScrollChecks } from "./session-scroll-rendering.mjs";
import { runExecutionRecordChecks } from "./execution-record-rendering.mjs";
import { createRequire } from "node:module";
const { recoverVerifiedDeliveryEvents } = createRequire(import.meta.url)("../../dist/electron/electron/agent/verified-delivery-artifacts.js");

const output = mkdtempSync(path.join(tmpdir(), "neoworker-artifact-turn-qa-"));
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MainContent} from '/components/MainContent/MainContent.tsx';
import {reconcileTaskDeliveryEvents} from '/utils/task-event-stream.ts';
import '/styles/index.css';
window.electronAPI = new Proxy({}, {get: (_, key) => {
  if (String(key).startsWith('on')) return () => () => {};
  if (key === 'getAppearanceSettings') return async () => ({theme:'light', language:'zh-CN'});
  if (key === 'getPermissionSettings') return async () => ({defaultPermissionMode:'bypass_permissions'});
  if (key === 'getVoiceSettings') return async () => ({enabled:false});
  if (key === 'getPersonalitySettings') return async () => ({});
  return async () => [];
}});
const root = createRoot(document.getElementById('root'));
const noop = () => {};
document.body.classList.add('theme-light');
window.renderData = ({task,events,optimisticFollowUpStartedAt,qaProps={}}) => root.render(React.createElement(MainContent, {task,selectedTaskId:task.id,optimisticFollowUpStartedAt,
  events:reconcileTaskDeliveryEvents(task,events),workspace:{id:'qa-workspace',name:'QA',path:'/tmp/artifact-qa',permissions:{read:true,write:true}},
  onSendMessage:noop,onModelChange:noop,selectedModel:'qa',selectedProvider:'openai',availableModels:[],...qaProps}));
window.renderCase = ({extension='pptx', stale=true, next=false, late=false, differing=false}) => {
  const output = (name) => ({created:[name], primaryOutputPath:name, outputCount:1, folders:['.']});
  const event = (id, seq, type, payload) => ({id,eventId:id,taskId:'qa',seq,timestamp:1789470000000+seq*1000,type,legacyType:type,payload});
  const ru = 'qa_RU.'+extension, ko='qa_KO.'+extension;
  const korean = 'KOREAN_CURRENT_REPLY: Translation completed. '+ko;
  const russian = 'RUSSIAN_PREVIOUS_REPLY: Previous translation verified. '+ru;
  const events = [
    event('ru-user',1,'user_message',{message:'Translate to Russian'}),
    event('ru-created',2,'file_created',{path:ru}),
    event('ru-completed',3,'task_completed',{resultSummary:russian, outputSummary:output(ru)}),
    event('ko-user',4,'user_message',{message:'Translate to Korean using the original template'}),
    event('ko-created',5,'file_created',{path:ko}),
    event('ko-assistant',6,'assistant_message',{message:korean}),
    event('ko-completed',7,'task_completed',{resultSummary:korean+(differing?' Validation passed.':''),outputSummary:output(ko)}),
  ];
  if (late) {
    events.splice(5,1);
    events.push(event('ko-assistant',8,'assistant_message',{message:korean+' Late reply.'}));
  }
  if (next) events.push(
    event('next-user',9,'user_message',{message:'NEXT_QUERY: another question'}),
    event('next-completed',10,'task_completed',{resultSummary:'NEXT_ANSWER',outputSummary:{created:[],outputCount:0,folders:[]}}));
  const task={id:'qa', title:'Artifact turn QA', prompt:'Translate to Russian', workspaceId:'qa-workspace',
    status:'completed',createdAt:events[0].timestamp,updatedAt:events.at(-1).timestamp,
    completedAt:events.at(-1).timestamp,resultSummary:stale?russian:korean,
    bestKnownOutcome:{capturedAt:events[6]?.timestamp,resultSummary:korean,outputSummary:output(ko)}};
  window.renderData({task,events});
};
window.renderCase({});
`;

const server = await createServer({
  configFile: path.resolve("config/vite.config.ts"),
  server: { port: 0, strictPort: false, host: "127.0.0.1" },
  plugins: [
    {
      name: "artifact-turn-qa",
      resolveId(id) {
        if (id === "__artifact_qa_entry") return "\0__artifact_qa_entry";
      },
      load(id) {
        if (id === "\0__artifact_qa_entry") return entry;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url === "/__artifact-qa.html") {
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                req.url,
                '<html><head></head><body><div id="root"></div><script type="module" src="/@id/__artifact_qa_entry"></script></body></html>',
              ),
            );
          } else next();
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage({
    viewport: { width: 1365, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.goto(server.resolvedUrls.local[0] + "__artifact-qa.html");
  await page.waitForSelector(".conversation-artifact-stack", {
    timeout: 60000,
  });
  let checks = 0;
  if (process.env.NEOWORKER_QA_TIMING_ONLY) {
    checks += await runTimerChecks(page, output);
  }
  if (process.env.NEOWORKER_QA_SCROLL_ONLY) {
    checks += await runSessionScrollChecks(page, output);
  }
  if (process.env.NEOWORKER_QA_RECORD_ONLY) {
    checks += await runExecutionRecordChecks(page, output);
  }
  for (const width of process.env.NEOWORKER_QA_TIMING_ONLY || process.env.NEOWORKER_QA_SCROLL_ONLY || process.env.NEOWORKER_QA_RECORD_ONLY ? [] : [1365, 760]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const extension of ["pptx", "pdf", "xlsx", "docx"]) {
      for (const variation of [
        { stale: true },
        { stale: false, differing: true },
        { stale: false, late: true },
        { stale: true, next: true },
      ]) {
        await page.evaluate((args) => window.renderCase(args), {
          extension,
          ...variation,
        });
        const card = page
          .locator(".conversation-artifact-stack")
          .filter({ hasText: "qa_KO." + extension });
        await card.waitFor();
        await page.waitForFunction(() =>
          Array.from(document.querySelectorAll(".assistant-message")).some(
            (el) => el.textContent.includes("KOREAN_CURRENT_REPLY"),
          ),
        );
        const position = await page.evaluate(() => {
          const replies = Array.from(
            document.querySelectorAll(".assistant-message"),
          ).filter((el) => el.textContent.includes("KOREAN_CURRENT_REPLY"));
          const card = Array.from(
            document.querySelectorAll(".conversation-artifact-stack"),
          ).find((el) => el.textContent.includes("qa_KO."));
          return {
            replyBottom: Math.max(
              ...replies.map((el) => el.getBoundingClientRect().bottom),
            ),
            cardTop: card.getBoundingClientRect().top,
            staleBelowQuery: document.body.innerText
              .split("Translate to Korean using the original template")
              .at(-1)
              .includes("RUSSIAN_PREVIOUS_REPLY"),
          };
        });
        assert.equal(
          position.staleBelowQuery,
          false,
          "Previous answer leaked into current turn",
        );
        assert.ok(
          position.cardTop >= position.replyBottom - 1,
          JSON.stringify(position),
        );
        if (variation.next) {
          await page
            .getByText("NEXT_QUERY: another question", { exact: true })
            .waitFor();
          const nextTop = await page
            .getByText("NEXT_QUERY: another question", { exact: true })
            .evaluate((el) => el.getBoundingClientRect().top);
          const cardBottom = await card.evaluate(
            (el) => el.getBoundingClientRect().bottom,
          );
          assert.ok(
            cardBottom <= nextTop,
            "Artifact moved into the next query",
          );
        }
        checks++;
      }
    }
    await page.screenshot({
      path: path.join(output, "conversation-" + width + ".png"),
      fullPage: true,
    });
  }
  const taskId = process.env.NEOWORKER_QA_TASK_ID;
  if (taskId) {
    assert.match(taskId, /^[a-f0-9-]+$/i);
    const db =
      process.env.NEOWORKER_QA_DB ||
      path.join(
        process.env.HOME,
        "Library/Application Support/NeoWorker/neoworker.db",
      );
    const query = (sql) =>
      JSON.parse(
        execFileSync("sqlite3", ["-readonly", "-json", db, sql], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        }),
      );
    const [row] = query("SELECT * FROM tasks WHERE id='" + taskId + "'");
    let events = query(
      "SELECT * FROM task_events WHERE task_id='" + taskId + "' ORDER BY seq",
    ).map((row) => ({
      id: row.id,
      eventId: row.event_id,
      taskId: row.task_id,
      seq: row.seq,
      timestamp: row.timestamp,
      type: row.type,
      legacyType: row.legacy_type,
      status: row.status,
      payload: JSON.parse(row.payload),
    }));
    const [workspace] = query("SELECT path FROM workspaces WHERE id='" + row.workspace_id.replaceAll("'", "''") + "'");
    events = recoverVerifiedDeliveryEvents(events, taskId, workspace?.path);
    const task = {
      id: row.id,
      status: row.status,
      title: row.title,
      prompt: row.prompt,
      workspaceId: row.workspace_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      resultSummary: row.result_summary,
      bestKnownOutcome: JSON.parse(row.best_known_outcome),
    };
    await page.setViewportSize({ width: 1365, height: 1000 });
    await page.evaluate((data) => window.renderData(data), { task, events });
    const file = events.filter((event) => (event.legacyType || event.type) === "task_completed").at(-1).payload.outputSummary.primaryOutputPath;
    const card = page
      .locator(".conversation-artifact-stack")
      .filter({ hasText: file });
    await card.waitFor();
    const current = events
      .filter((event) => (event.legacyType || event.type) === "task_completed")
      .at(-1);
    const firstLine = current.payload.resultSummary
      .split("\n")[0]
      .replaceAll("**", "");
    await page.getByText(firstLine, { exact: true }).waitFor();
    const reply = page
      .locator(".assistant-message")
      .filter({ hasText: firstLine })
      .last();
    await card.scrollIntoViewIfNeeded();
    assert.ok(
      (await card.evaluate((el) => el.getBoundingClientRect().top)) >=
        (await reply.evaluate((el) => el.getBoundingClientRect().bottom)) - 1,
    );
    for (const ignored of [0, 1]) {
      await page.locator(".verbose-switch").click();
      await card.waitFor();
      assert.ok(
        (await card.evaluate((el) => el.getBoundingClientRect().top)) >=
          (await reply.evaluate((el) => el.getBoundingClientRect().bottom)) - 1,
      );
      checks++;
    }
    const previous = events
      .filter((event) => (event.legacyType || event.type) === "task_completed")
      .at(-2);
    await page.evaluate((data) => window.renderData(data), {
      task: { ...task, resultSummary: previous.payload.resultSummary },
      events,
    });
    await page.getByText(firstLine, { exact: true }).waitFor();
    assert.ok(
      (await card.evaluate((el) => el.getBoundingClientRect().top)) >=
        (await reply.evaluate((el) => el.getBoundingClientRect().bottom)) - 1,
    );
    checks++;
    await page.screenshot({
      path: path.join(output, "real-session.png"),
      fullPage: true,
    });
    await page.screenshot({ path: path.join(output, "real-session-current.png") });
    checks++;
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, output, status: "PASS" }));
} finally {
  await browser?.close();
  await server.close();
}
