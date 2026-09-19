import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const { LLMProviderFactory } = require("../../dist/electron/electron/agent/llm/provider-factory.js");
const { LLMSettingsSchema } = require("../../dist/electron/electron/utils/validation.js");
const { buildSavedLLMSettings } = require("../../dist/electron/electron/ipc/llm-settings-save.js");
const legacy = { displayName: "Existing Platform", apiKey: "legacy-test-key", baseUrl: "https://legacy.example/v1", model: "shared-model" };
let saved = { providerType: "openai-compatible", modelKey: "shared-model", openaiCompatible: { ...legacy }, providerModelRegistry: { "openai-compatible": { models: ["shared-model"] } } };
let saveCalls = 0;
let failNextSave = false;
LLMProviderFactory.loadSettings = () => structuredClone(saved);
const output = mkdtempSync(path.join(tmpdir(), "neoworker-custom-providers-qa-"));
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Settings} from '/components/Settings.tsx';
import {installBrowserElectronApi} from '/browser-electron-api.ts';
import {applyPersistedLanguage} from '/i18n/index.ts';
import '/styles/index.css';
installBrowserElectronApi();
const api = async (method, body) => {const r = await fetch('/__provider-api/'+method,{method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok) throw Error(data.error); return data;};
window.electronAPI.getLLMSettings = () => api('settings');
window.electronAPI.getLLMConfigStatus = () => api('status');
window.electronAPI.saveLLMSettings = value => api('save', value);
window.electronAPI.refreshCustomProviderModels = async () => {
  if (window.__holdProviderModels) return new Promise(resolve => { window.__releaseProviderModels = () => resolve([]); });
  return [];
};
window.electronAPI.getLLMRoutingStatus = async () => null;
applyPersistedLanguage('zh-CN');
document.body.classList.add('theme-light');
createRoot(document.getElementById('root')).render(React.createElement(Settings,{initialTab:'llm',onBack:()=>{},devRunLoggingEnabled:false,onDevRunLoggingEnabledChange:()=>{}}));
`;
const server = await createServer({ configFile: path.resolve("config/vite.config.ts"), server: { port: 0, host: "127.0.0.1" }, plugins: [{
  name: "custom-providers-qa",
  resolveId: id => id === "__provider_qa" ? "\0__provider_qa" : null,
  load: id => id === "\0__provider_qa" ? entry : null,
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.startsWith("/__provider-api/")) {
        res.setHeader("Content-Type", "application/json");
        try {
          if (req.url.endsWith("/save")) {
            saveCalls += 1;
            if (failNextSave) { failNextSave = false; throw new Error("QA save rejected"); }
            let body = ""; for await (const chunk of req) body += chunk;
            saved = buildSavedLLMSettings(LLMSettingsSchema.parse(JSON.parse(body)), saved);
          }
          res.end(JSON.stringify(req.url.endsWith("/status") ? LLMProviderFactory.getConfigStatus() : saved));
        } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); }
        return;
      }
      if (req.url !== "/__provider-qa.html") return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/@id/__provider_qa"></script></body></html>'));
    });
  },
}] });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  await page.goto(server.resolvedUrls.local[0] + "__provider-qa.html");
  const modal = page.locator(".model-add-modal");
  const open = async () => {
    await page.locator(".llm-agentflow-toolbar").getByRole("button", { name: /添加模型|Add model/i }).click();
    await modal.waitFor();
  };
  for (const [name, suffix] of [["Second Platform", "second"], ["Third Platform", "third"]]) {
    await open();
    await modal.getByRole("button", { name: "新增自定义供应商" }).click();
    const inputs = modal.locator(".model-add-config .model-add-field > input");
    await inputs.nth(0).fill(name);
    await inputs.nth(1).fill(`https://${suffix}.example/v1`);
    await modal.locator('input[type="password"]').fill(`test-key-${suffix}`);
    await modal.locator(".model-add-custom-model summary").click();
    await modal.getByPlaceholder("model-id", { exact: true }).fill("shared-model");
    await page.screenshot({ path: path.join(output, `${suffix}-configured.png`) });
    await modal.locator(".model-add-modal-footer .button-primary").click();
    await modal.waitFor({ state: "hidden" });
    assert.equal(saved.openaiCompatible.apiKey, legacy.apiKey);
    assert.equal(saved.openaiCompatible.baseUrl, legacy.baseUrl);
    assert.equal(saved.openaiCompatible.displayName, legacy.displayName);
  }
  assert.equal(Object.keys(saved.customProviders).length, 2);
  assert.deepEqual(Object.values(saved.customProviders).map(p => p.displayName).sort(), ["Second Platform", "Third Platform"]);
  await page.reload();
  await page.getByText("Third Platform", { exact: true }).first().waitFor();
  await open();
  const providerRow = name => modal.locator(".model-add-provider-row").filter({ has: page.getByRole("button", { name, exact: true }) });
  assert.equal(await providerRow("Existing Platform").locator(".model-add-provider-delete").count(), 0);
  const savesBeforeDrafts = saveCalls;
  await modal.getByRole("button", { name: "新增自定义供应商" }).click();
  await modal.getByRole("button", { name: "新增自定义供应商" }).click();
  assert.equal(await modal.locator(".model-add-provider-delete").count(), 4);
  await modal.locator(".model-add-provider-row:has(.active) .model-add-provider-delete").click();
  assert.equal(await modal.locator(".model-add-provider-delete").count(), 3);
  await modal.getByRole("button", { name: "Second Platform", exact: true }).click();
  const draftDelete = modal.getByRole("button", { name: "删除 自定义供应商", exact: true });
  await draftDelete.focus();
  await page.keyboard.press("Enter");
  assert.equal(await modal.locator(".model-add-provider-delete").count(), 2);
  assert.equal(await modal.getByRole("button", { name: "Second Platform", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(saveCalls, savesBeforeDrafts);
  assert.equal(Object.keys(saved.customProviders).length, 2);
  assert.equal(await modal.locator('input[type="password"]').inputValue(), "test-key-second");
  await modal.getByRole("button", { name: "Existing Platform", exact: true }).click();
  assert.equal(await modal.locator('input[type="password"]').inputValue(), legacy.apiKey);
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({ path: path.join(output, `provider-list-${width}.png`) });
    assert.equal(await modal.getByRole("button", { name: "新增自定义供应商" }).isVisible(), true);
    const bounds = await providerRow("Second Platform").boundingBox();
    const deleteBounds = await providerRow("Second Platform").locator(".model-add-provider-delete").boundingBox();
    assert.ok(deleteBounds.x >= bounds.x && deleteBounds.x + deleteBounds.width <= bounds.x + bounds.width);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.body.classList.remove("theme-light"); document.body.classList.add("theme-dark"); });
  await page.screenshot({ path: path.join(output, "provider-list-dark.png") });
  await page.evaluate(() => { document.body.classList.remove("theme-dark"); document.body.classList.add("theme-light"); });
  await modal.getByRole("button", { name: "Second Platform", exact: true }).click();
  await modal.locator(".model-add-config .model-add-field > input").nth(0).fill("Renamed Platform");
  await modal.locator(".model-add-modal-footer .button-primary").click();
  await modal.waitFor({ state: "hidden" });
  assert.ok(Object.values(saved.customProviders).some(p => p.displayName === "Renamed Platform"));
  await open();
  await modal.getByRole("button", { name: "Renamed Platform", exact: true }).click();
  await modal.locator(".model-add-config .model-add-field > input").nth(0).fill("Pending Rename");
  const thirdRow = providerRow("Third Platform");
  await thirdRow.locator(".model-add-provider-delete").click();
  await thirdRow.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(Object.keys(saved.customProviders).length, 2);
  await thirdRow.locator(".model-add-provider-delete").click();
  failNextSave = true;
  await thirdRow.getByRole("button", { name: "删除", exact: true }).click();
  await modal.getByText("QA save rejected", { exact: true }).waitFor();
  assert.equal(Object.keys(saved.customProviders).length, 2);
  assert.equal(await thirdRow.isVisible(), true);
  await page.screenshot({ path: path.join(output, "delete-confirm.png") });
  await thirdRow.getByRole("button", { name: "删除", exact: true }).click();
  await thirdRow.waitFor({ state: "hidden" });
  assert.equal(Object.keys(saved.customProviders).length, 1);
  assert.equal(await modal.locator(".model-add-config .model-add-field > input").nth(0).inputValue(), "Pending Rename");
  await modal.locator(".model-add-modal-footer .button-primary").click();
  await modal.waitFor({ state: "hidden" });
  assert.equal(Object.values(saved.customProviders)[0].apiKey, "test-key-second");
  assert.equal(saved.openaiCompatible.apiKey, legacy.apiKey);
  await page.reload();
  await page.getByText("Pending Rename", { exact: true }).first().waitFor();
  assert.equal(await page.locator(".llm-provider-row").filter({ hasText: "Third Platform" }).count(), 0);
  await open();
  await page.evaluate(() => { window.__holdProviderModels = true; });
  await modal.getByRole("button", { name: "Pending Rename", exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__releaseProviderModels));
  await providerRow("Pending Rename").locator(".model-add-provider-delete").click();
  await providerRow("Pending Rename").getByRole("button", { name: "删除", exact: true }).click();
  await providerRow("Pending Rename").waitFor({ state: "hidden" });
  assert.equal(Object.keys(saved.customProviders).length, 0);
  assert.equal(saved.providerType, "openai-compatible");
  assert.equal(await modal.locator(".model-add-provider-option.active").count(), 1);
  assert.equal(saved.openaiCompatible.apiKey, legacy.apiKey);
  await page.evaluate(() => { window.__holdProviderModels = false; window.__releaseProviderModels(); });
  await modal.getByRole("button", { name: "刷新模型列表" }).waitFor();
  assert.equal(await modal.locator(".model-add-provider-delete").count(), 0);
  await page.reload();
  await open();
  assert.equal(await modal.locator(".model-add-provider-delete").count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "PASS", output, providers: Object.keys(saved.customProviders).length }));
} finally { await browser?.close(); await server.close(); }
