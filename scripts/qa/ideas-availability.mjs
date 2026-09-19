import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { createServer } from "vite";
import { chromium } from "playwright";

// Read the actual catalog's skill IDs without maintaining a parallel catalog.
const source = ts.createSourceFile('IdeasPanel.tsx', readFileSync('src/renderer/components/IdeasPanel.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const ids = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'IDEAS') {
    for (const item of node.initializer.elements) {
      const skill = item.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'skill');
      if (skill) ids.push(skill.initializer.text);
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {IdeasPanel} from '/components/IdeasPanel.tsx';
import {applyPersistedLanguage} from '/i18n/index.ts';
import '/styles/index.css';
const empty = () => ({bins:[],anyBins:[],env:[],config:[],os:[]});
window.state = {fail:false,disabled:[],integrations:[]};
window.launches = []; window.settings = [];
window.electronAPI = {
  getSkillStatus: async () => {
    if (window.state.fail) throw new Error('test unavailable');
    if (window.state.hang) return new Promise(() => {});
    return {skills: ${JSON.stringify(ids)}.map(id => ({id, name:id, enabled:true, eligible:!window.state.disabled.includes(id), disabled:window.state.disabled.includes(id), blockedByAllowlist:false, missing:empty(), requirements:empty()}))};
  },
  listIntegrationMentionOptions: async () => window.state.integrations,
};
applyPersistedLanguage('zh-CN');
document.body.classList.add('theme-light');
const root = createRoot(document.getElementById('root'));
root.render(React.createElement(IdeasPanel, {onUsePrompt:value => window.launches.push(value), onOpenSettings:value => window.settings.push(value)}));
`;
const output = mkdtempSync(path.join(tmpdir(), 'neoworker-ideas-qa-'));
const server = await createServer({
  configFile:path.resolve('config/vite.config.ts'),
  server:{port:0,host:'127.0.0.1'},
  plugins:[{
    name:'ideas-qa',
    resolveId:id => id === '__ideas_qa' ? '\0__ideas_qa' : null,
    load:id => id === '\0__ideas_qa' ? entry : null,
    configureServer(server) {
      server.middlewares.use(async (req,res,next) => {
        if(req.url !== '/__ideas-qa.html') return next();
        res.setHeader('Content-Type','text/html');
        res.end(await server.transformIndexHtml(req.url,'<html><body><div id="root"></div><script type="module" src="/@id/__ideas_qa"></script></body></html>'));
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({headless:true,channel:'chrome'});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];
  page.on('pageerror', error=>errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]+'__ideas-qa.html');
  const card = id => page.locator('[data-idea-id="'+id+'"]');
  const refresh = async () => {
    await page.getByRole('button',{name:'刷新可用状态'}).click();
    await page.waitForFunction(() => !document.querySelector('.ideas-availability-refresh')?.disabled);
  };
  await card('code-review').waitFor();
  assert.equal(await card('usecase-household-capture').count(),0);
  assert.equal(await card('usecase-booking-options').count(),0);
  assert.equal(await page.locator('[data-availability="plan"]').count(),0);
  await page.getByRole('tab',{name:'需配置'}).click();
  assert.match(await card('usecase-household-capture').innerText(), /服务未配置: Notion/);
  await card('usecase-household-capture').locator('.ideas-card-launch').click();
  assert.deepEqual(await page.evaluate(()=>window.settings),['integrations']);
  assert.deepEqual(await page.evaluate(()=>window.launches),[]);
  await page.evaluate(()=>window.state.integrations=[{id:'builtin:notion',providerKey:'notion',label:'Notion',source:'builtin',status:'configured',tools:['notion_action']}]);
  await refresh();
  await page.getByRole('tab',{name:'可开始'}).click();
  await card('usecase-household-capture').waitFor();
  await card('usecase-household-capture').locator('.ideas-card-launch').click();
  await page.waitForFunction(()=>window.launches.length===1);
  assert.equal(await page.evaluate(()=>window.launches[0].skillId),'usecase-household-capture');

  // A disconnect after rendering must not hand off a stale launchable card.
  await page.evaluate(()=>window.state.integrations=[]);
  await card('usecase-household-capture').locator('.ideas-card-launch').click();
  await page.getByRole('tab',{name:'需配置',selected:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.launches.length),1);
  await page.evaluate(()=>window.state.disabled=['code-review']);
  await refresh();
  assert.match(await card('code-review').innerText(),/技能未启用/);

  await page.getByRole('tab',{name:'方案模板'}).click();
  const plan=page.locator('[data-availability="plan"]');
  await plan.locator('.ideas-card-launch').click();
  await page.waitForFunction(()=>window.launches.length===2);
  const selected=await page.evaluate(()=>window.launches[1]);
  assert.equal(selected.skillId,undefined);
  assert.match(selected.prompt,/不连接或控制设备/);

  await page.evaluate(()=>window.state.fail=true);
  await refresh();
  assert.equal(await page.locator('.ideas-card-launch').count(),0);
  assert.match(await page.getByRole('status').innerText(),/检查失败/);
  await page.evaluate(()=>window.state.fail=false);
  await refresh();
  await page.evaluate(()=>window.state.hang=true);
  await refresh();
  assert.match(await page.getByRole('status').innerText(),/检查失败/);
  assert.equal(await page.locator('.ideas-card-launch').count(),0);
  await page.evaluate(()=>window.state.hang=false);
  await refresh();
  await page.getByRole('tab',{name:'需配置'}).click();
  await page.getByRole('searchbox').fill('家务');
  await page.screenshot({path:path.join(output,'needs-setup-desktop.png')});
  await page.setViewportSize({width:760,height:900});
  await page.screenshot({path:path.join(output,'needs-setup-narrow.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log('Ideas availability browser checks passed. Screenshots: '+output);
} finally {
  await browser?.close();
  await server.close();
}
