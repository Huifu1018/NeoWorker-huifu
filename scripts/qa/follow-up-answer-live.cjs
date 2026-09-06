// Run against a development Electron launched with --remote-debugging-port=9335.
// Uses the app's configured model; creates one isolated QA workspace/session.
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const version = await new Promise((resolve, reject) => {
    require('node:http').get('http://127.0.0.1:9335/json/version', response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }).on('error', reject);
  });
  const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
  try {
    const page = browser.contexts().flatMap(context => context.pages())
      .find(page => page.url().includes('127.0.0.1:5173'));
    assert.ok(page, 'NeoWorker development renderer must be loaded');
    await page.waitForFunction(() => typeof window.electronAPI?.createTask === 'function');
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neoworker-answer-qa-'));
    const workspace = await page.evaluate(input => window.electronAPI.createWorkspace(input), {
      name: 'QA — follow-up answer delivery', path: workspacePath,
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
    });
    const task = process.env.NEOWORKER_QA_TASK_ID
      ? await page.evaluate(id => window.electronAPI.getTask(id), process.env.NEOWORKER_QA_TASK_ID)
      : await page.evaluate(input => window.electronAPI.createTask(input), {
      title: 'QA 连续追问与实际答案回归',
      prompt: '这是软件回归测试。只回复“回归测试会话已就绪”，不要执行工具。',
      workspaceId: workspace.id,
      agentConfig: { executionMode: 'chat', executionModeSource: 'user', permissionMode: 'dangerous_only' },
    });
    console.log(JSON.stringify({ phase: 'created', taskId: task.id, workspacePath }));
    async function waitForTerminal(after, followUp) {
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        const events = await page.evaluate(id => window.electronAPI.getTaskEvents(id), task.id);
        const fresh = events.filter(event => event.timestamp >= after);
        const kind = event => event.legacyType || event.payload?.legacyType || event.type;
        const terminal = fresh.find(event => followUp
          ? ['follow_up_completed', 'follow_up_failed'].includes(kind(event))
          : ['task_completed', 'error', 'task_failed'].includes(kind(event)));
        if (terminal) {
          // Let the completed-event handler persist the terminal projection.
          await new Promise(resolve => setTimeout(resolve, 1000));
          const row = await page.evaluate(id => window.electronAPI.getTask(id), task.id);
          console.log(JSON.stringify({ phase: followUp ? 'follow-up' : 'initial', event: kind(terminal),
            status: row.status, terminalStatus: row.terminalStatus, resultSummary: row.resultSummary,
            failureClass: row.failureClass }));
          assert.notEqual(kind(terminal), 'follow_up_failed');
          assert.equal(row.status, 'completed');
          return row;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      throw new Error('QA turn timed out; inspect the QA session before retrying');
    }
    if (!process.env.NEOWORKER_QA_TASK_ID) await waitForTerminal(task.createdAt || 0, false);
    const prompts = [
      '帮我查一下明天北京的天气。请给出实际预报、温度和来源；如果无法核实，请明确说明，不能只说已经查询或读到。',
      '现在换个问题，不用工具：17 加 25 等于多少？请直接给出答案。',
    ];
    const selectedPrompts = process.env.NEOWORKER_QA_ARITHMETIC_ONLY ? prompts.slice(1) : prompts;
    for (const prompt of selectedPrompts) {
      const after = Date.now();
      await page.evaluate(({ id, prompt }) => {
        void window.electronAPI.sendMessage(id, prompt, undefined, undefined, {
          executionMode: 'execute',
        });
      }, { id: task.id, prompt });
      const row = await waitForTerminal(after, true);
      if (prompt.includes('17')) assert.match(row.resultSummary, /42/);
      else assert.ok(row.resultSummary && !/^拿到了权威数据[^\n]*预报已经读到。$/.test(row.resultSummary));
      assert.equal(row.terminalStatus, 'ok');
      assert.ok(!row.failureClass);
      assert.equal(row.bestKnownOutcome?.resultSummary, row.resultSummary);
      assert.equal(row.bestKnownOutcome?.outputSummary?.outputCount || 0, 0);
    }
    console.log(`PASS: live model answered ${selectedPrompts.length} follow-up(s) in the same session with current-turn outcomes.`);
  } finally {
    await browser.close(); // Disconnect CDP, leave the desktop app open.
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
