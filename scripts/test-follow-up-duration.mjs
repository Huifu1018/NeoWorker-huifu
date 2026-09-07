// Real React/browser regression: no model requests and no user session writes.
// Run: node scripts/test-follow-up-duration.mjs [Chrome executable path]
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { chromium } from "playwright";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let timingImports = `import {useTaskDuration} from './src/renderer/hooks/useTaskDuration';
import {deriveTaskWorkTiming} from './src/renderer/utils/task-working-state';`;
if (process.env.NEOWORKER_TEST_ASAR) {
  const asar = createRequire(import.meta.url)("@electron/asar");
  const archive = process.env.NEOWORKER_TEST_ASAR;
  const html = asar.extractFile(archive, "dist/renderer/index.html").toString();
  const entry = html.match(/src="\.\/(assets\/index-[^\"]+\.js)"/)?.[1];
  assert.ok(entry);
  const text = asar.extractFile(archive, `dist/renderer/${entry}`).toString();
  const ast = ts.createSourceFile("bundle.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = ["F6", "W6"].map(name => {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node, `Missing packaged ${name}`);
    return node.getText(ast);
  });
  const helper = text.match(/\/\* NW_FOLLOW_UP_TIMING_V1_HELPER_BEGIN \*\/([\s\S]+?)\/\* NW_FOLLOW_UP_TIMING_V1_HELPER_END \*\//)?.[1];
  assert.ok(helper, "Missing packaged timing helper");
  timingImports = `const x=React; ${functions.join("\n")} ${helper}
    const useTaskDuration=W6, deriveTaskWorkTiming=__NWFollowUpTiming.deriveTaskWorkTiming;`;
  console.log(`Testing timing code extracted from ${archive}`);
}
const bundle = await build({
  absWorkingDir: root,
  stdin: {
    resolveDir: root,
    contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      ${timingImports}
      function Harness() {
        const [input, setInput] = useState({startedAt: Date.now()-10000, completedAt: Date.now(), isActive: false});
        window.setTiming = setInput;
        const duration = useTaskDuration(input.startedAt, input.completedAt, input.isActive);
        return React.createElement('div', null,
          React.createElement('span', {id: 'duration'}, duration),
          React.createElement('span', {id: 'spinner'}, input.isActive ? 'running' : 'stopped'));
      }
      window.deriveTiming = deriveTaskWorkTiming;
      createRoot(document.getElementById('root')).render(React.createElement(Harness));
    `,
  },
  bundle: true,
  write: false,
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
});
const browser = await chromium.launch({
  headless: true,
  ...(process.argv[2] || process.platform === "darwin" ? {
    executablePath: process.argv[2] || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  } : {}),
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => document.querySelector("#duration")?.textContent === "10s");
  // The active hook must ignore a stale completedAt even if a caller passes it.
  await page.evaluate(() => {
    window.secondStart = Date.now();
    window.setTiming({ startedAt: window.secondStart, completedAt: window.secondStart - 1000, isActive: true });
  });
  await page.waitForFunction(() => document.querySelector("#duration")?.textContent === "2s");
  console.log("PASS: second-turn clock advanced from 0s to 2s with stale completedAt");
  await page.evaluate(() => {
    const start = window.secondStart;
    const task = { id: "test", createdAt: start - 10000, completedAt: start - 1000, updatedAt: start - 1000, status: "executing" };
    window.setTiming(window.deriveTiming(task, [
      { taskId: "test", type: "user_message", timestamp: start },
      { taskId: "test", type: "follow_up_failed", timestamp: start + 2000 },
    ], false, start));
  });
  await page.waitForFunction(() => document.querySelector("#spinner")?.textContent === "stopped");
  await page.waitForTimeout(1200);
  assert.equal(await page.locator("#duration").textContent(), "2s");
  console.log("PASS: failure stopped the spinner and froze this turn at 2s, not 0s");
  await page.evaluate(() => window.setTiming({ startedAt: Date.now(), isActive: true }));
  await page.waitForFunction(() => document.querySelector("#duration")?.textContent === "1s");
  assert.equal(await page.locator("#spinner").textContent(), "running");
  assert.deepEqual(errors, []);
  console.log("PASS: third-turn clock restarted and advanced; no browser errors");
} finally {
  await browser.close();
}
