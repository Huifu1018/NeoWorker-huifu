import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const preview = JSON.parse(await readFile(process.argv[2], "utf8"));
assert.equal(preview.slides.length, 39);
assert.deepEqual(preview.textWarningPages, [21]);
const output = await mkdtemp(path.join(tmpdir(), "neoworker-preview-warning-ui-"));
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {PresentationViewer} from '/components/PresentationViewer.tsx';
import '/styles/index.css';
import '/components/MainContent/main-content.css';
import '/styles/neoworker-design-system.css';
window.electronAPI = new Proxy({}, {get: (_, key) => String(key).startsWith('on') ? () => () => {} : async () => []});
document.documentElement.classList.add('theme-light','visual-oblivion');
const root=createRoot(document.getElementById('root'));
window.showPreview = (preview) => root.render(React.createElement(PresentationViewer,{fileName:'Translation.pptx',preview,onOpenExternal:()=>{},onShowInFinder:()=>{}}));
`;
const server = await createServer({
  configFile: path.resolve("config/vite.config.ts"),
  server: { port: 0, host: "127.0.0.1" },
  plugins: [{
    name: "presentation-warning-qa",
    resolveId(id) { if (id === "__preview_warning") return "\0__preview_warning"; },
    load(id) { if (id === "\0__preview_warning") return entry; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/__preview.html") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml(req.url, '<html><head><style>html,body,#root{height:100%;margin:0}.presentation-viewer{height:100vh}</style></head><body><div id="root"></div><script type="module" src="/@id/__preview_warning"></script></body></html>'));
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
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + "__preview.html");
  await page.waitForFunction(() => typeof window.showPreview === "function");
  await page.evaluate((data) => window.showPreview(data), preview);
  for (const width of [1440, 480]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('.presentation-viewer-render-note[role="status"]').waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const image = document.querySelector('.presentation-viewer-slide-image');
      return image?.complete && image.naturalWidth > 900;
    });
    assert.equal(await page.locator('.presentation-viewer-slide-text').count(), 0);
    assert.match(await page.locator('.presentation-viewer-render-note[role="status"]').innerText(), /21/);
    await page.screenshot({ path: path.join(output, `preview-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ output, slides: preview.slides.length, warnings: preview.textWarningPages, viewports: [1440, 480] }));
} finally {
  await browser?.close();
  await server.close();
}
