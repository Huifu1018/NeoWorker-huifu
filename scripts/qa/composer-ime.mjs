// Exercise the real composer with Chromium composition events, without an agent.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import { chromium } from "playwright";

const entry = `
import React, {useState, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {PromptComposerInput} from '/components/PromptComposerInput.tsx';
function Harness() {
  const [value, setValue] = useState('');
  const [mentions, setMentions] = useState([]);
  const [, setTick] = useState(0);
  const ref = useRef(null);
  window.refresh = () => setTick(n => n + 1);
  window.reset = text => {setValue(text); setMentions([]);};
  window.draft = () => ref.current.getSnapshot();
  window.caret = (start, end = start) => ref.current.setSelectionRange(start, end);
  return React.createElement(PromptComposerInput, {
    ref, value, mentions, className:'qa-composer', ariaLabel:'Message',
    onChange:(text, cursor, spans) => {setValue(text); setMentions(spans);},
    onKeyDown:event => {
      if(event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault(); window.sent.push(ref.current.getValue());
      }
    },
    onCompositionChange:active => {window.composing = active; setTick(n => n + 1);},
    onCursorChange:() => setTick(n => n + 1), onPaste:() => {},
  });
}
window.sent = [];
const root = createRoot(document.getElementById('root'));
if (location.search === '?main') {
  window.electronAPI = new Proxy({}, {get: (_, key) => {
    if (String(key).startsWith('on')) return () => () => {};
    if (key === 'getAgentRoles') return async () => [{id:'qa-tester',name:'QA Tester',displayName:'测试工程师',description:'Test code',isActive:true,sortOrder:0,capabilities:[]}];
    if (key === 'getAppearanceSettings') return async () => ({theme:'light',language:'zh-CN'});
    if (key === 'getPermissionSettings') return async () => ({defaultPermissionMode:'bypass_permissions'});
    if (key === 'getVoiceSettings') return async () => ({enabled:false});
    if (key === 'getPersonalitySettings') return async () => ({});
    return async () => [];
  }});
  const {applyPersistedLanguage} = await import('/i18n/index.ts');
  applyPersistedLanguage('zh-CN');
  const {MainContent} = await import('/components/MainContent/MainContent.tsx');
  await import('/styles/index.css');
  document.body.classList.add('theme-light');
  const task = {id:'qa',title:'QA',prompt:'QA',status:'completed',workspaceId:'qa',createdAt:1,updatedAt:2};
  root.render(React.createElement(MainContent, {task,selectedTaskId:'qa',events:[],workspace:{id:'qa',name:'QA',path:'/tmp/qa',permissions:{read:true,write:true}},onSendMessage:()=>{},onModelChange:()=>{},selectedModel:'qa',selectedProvider:'openai',availableModels:[]}));
} else root.render(React.createElement(Harness));
`;
const server = await createServer({
  configFile: path.resolve("config/vite.config.ts"),
  server: { port: 0, host: "127.0.0.1" },
  plugins: [{
    name: "composer-ime-qa",
    resolveId: id => id === "__composer_qa" ? "\0__composer_qa" : null,
    load: id => id === "\0__composer_qa" ? entry : null,
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== "/__composer-qa.html") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml(req.url, `
          <html><head><style>.qa-composer {white-space:pre-wrap;min-height:100px;border:1px solid #ccc;padding:16px}</style></head>
          <body><div id="root"></div><script type="module" src="/@id/__composer_qa"></script></body></html>`));
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => {errors.push(error.message); console.error(error.message);});
  await page.goto(server.resolvedUrls.local[0] + "__composer-qa.html");
  const editor = page.getByRole("textbox");
  await editor.waitFor();
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => window.reset('first\nsecond'));
  await settle();
  await editor.focus();
  await page.evaluate(() => {
    window.caret(6);
    window.originalNode = document.querySelector('[role=textbox]').firstChild;
    window.refresh();
  });
  await settle();
  assert.equal(await page.evaluate(() => document.querySelector('[role=textbox]').firstChild === window.originalNode), true,
    "An unrelated render replaced the text node at the start of a line");
  assert.equal(await page.evaluate(() => getSelection().anchorOffset), 6, "An unrelated render moved the caret");

  await page.evaluate(() => window.reset(''));
  await settle();
  await editor.focus();
  const cdp = await page.context().newCDPSession(page);
  if (process.env.NEOWORKER_QA_IME_TRACE) {
    page.on('console', message => console.log(message.text()));
    await editor.evaluate(el => {
      for (const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input']) {
        el.addEventListener(type, event => console.log(JSON.stringify({type, data:event.data, inputType:event.inputType, composing:event.isComposing, html:el.innerHTML, offset:getSelection().anchorOffset})));
      }
    });
  }
  for (let line = 0; line < 3; line++) {
    if (line) await page.keyboard.press('Shift+Enter');
    await cdp.send('Input.imeSetComposition', {text:'ni', selectionStart:2, selectionEnd:2});
    await page.evaluate(() => window.refresh());
    await settle();
    await cdp.send('Input.imeSetComposition', {text:'nih', selectionStart:3, selectionEnd:3});
    await cdp.send('Input.insertText', {text:'你好'});
    await settle();
    assert.equal(await page.evaluate(() => window.draft().value), Array(line + 1).fill('你好').join('\n'));
  }
  assert.deepEqual(await page.evaluate(() => window.sent), [], "Composition confirmation submitted the message");
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.sent), ['你好\n你好\n你好']);

  // A commit event may be non-cancelable. Only the browser may apply it.
  assert.equal(await editor.evaluate(el => {
    const prior = window.draft().value;
    el.dispatchEvent(new InputEvent('beforeinput', {bubbles:true, cancelable:false, inputType:'insertText', data:'x'}));
    return window.draft().value === prior;
  }), true, "Non-cancelable input was also applied programmatically");

  // Native composing input remains authoritative even if compositionstart is absent.
  await editor.evaluate(el => {
    el.dispatchEvent(new InputEvent('beforeinput', {bubbles:true, cancelable:true, inputType:'insertCompositionText', data:'n', isComposing:true}));
    el.firstChild.appendData('n');
    el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertCompositionText', data:'n', isComposing:true}));
    window.originalNode = el.firstChild;
  });
  await settle();
  assert.equal(await editor.evaluate(el => el.firstChild === window.originalNode), true);
  await editor.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', {bubbles:true, key:'Enter', keyCode:229})));
  assert.equal(await page.evaluate(() => window.sent.length), 1, "IME Enter submitted the message");
  await editor.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true, data:'n'})));
  await settle();
  assert.equal(await page.evaluate(() => window.composing), false);
  assert.deepEqual(errors, []);
  console.log('Composer IME checks passed: stable DOM/caret, multiline composition, Enter, non-cancelable input, missing compositionstart.');

  await page.goto(server.resolvedUrls.local[0] + '__composer-qa.html?main');
  const mainEditor = page.locator('.prompt-composer-input').last();
  await mainEditor.waitFor({timeout:60000});
  await page.waitForTimeout(500);
  if (process.env.NEOWORKER_QA_IME_TRACE) await mainEditor.evaluate(el => {
    for (const type of ['keydown','keyup','beforeinput','input','focus','blur']) el.addEventListener(type, event => console.log(JSON.stringify({main:true,type,key:event.key,data:event.data,inputType:event.inputType,prevented:event.defaultPrevented,html:el.innerHTML})));
  });
  const option = page.locator('.mention-autocomplete-item').filter({hasText:'测试工程师'});
  for (const selection of ['mouse', 'keyboard']) {
    await mainEditor.fill('');
    await settle();
    await mainEditor.pressSequentially('@');
    await settle();
    if (process.env.NEOWORKER_QA_IME_TRACE) {
      await settle();
      console.log(await page.locator('body').innerText());
      console.log(await mainEditor.evaluate(el => el.outerHTML));
    }
    await option.waitFor();
    if (selection === 'mouse') await option.click();
    else await mainEditor.press('Enter');
    await settle();
    assert.equal(await page.locator('.mention-autocomplete-dropdown').count(), 0, 'Menu remained open after selection');
    await mainEditor.pressSequentially('帮我分析一下代码');
    await settle();
    assert.equal(await mainEditor.textContent(), '@测试工程师 帮我分析一下代码');
    assert.equal(await page.locator('.mention-autocomplete-dropdown').count(), 0, 'Typing reopened a completed mention');
    await mainEditor.press('Space');
    await mainEditor.pressSequentially('@');
    await option.waitFor();
    await mainEditor.press('Escape');
    await settle();
    assert.equal(await page.locator('.mention-autocomplete-dropdown').count(), 0);
  }
  const output = mkdtempSync(path.join(tmpdir(), 'neoworker-composer-qa-'));
  await mainEditor.fill('@测试工程师 帮我分析一下代码');
  await settle();
  await page.screenshot({path:path.join(output, 'selected-agent.png')});
  assert.deepEqual(errors, []);
  console.log('Actual MainContent checks passed: mouse/keyboard selection closes menu, prose does not reopen it, new @ opens it, Escape closes it. Screenshot: ' + output);
} finally {
  await browser?.close();
  await server.close();
}
