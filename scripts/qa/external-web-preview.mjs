import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { chromium } from "playwright";
const require = createRequire(import.meta.url);
const { createExternalWebPreviewUrl, closeExternalWebPreviews } = require("../../dist/electron/electron/web-preview/external-web-preview.js");
const output = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-browser-map-qa-"));
const requests = [];
// The regression uses a local image endpoint, never a tile prefetch against OSM.
const resources = http.createServer((req, res) => {
  requests.push({ referer: req.headers.referer, userAgent: req.headers["user-agent"] });
  res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" });
  res.end('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="green"/></svg>');
});
await new Promise(resolve => resources.listen(0, "127.0.0.1", resolve));
let browser;
try {
  await fs.mkdir(path.join(output, "assets"));
  await fs.writeFile(path.join(output, "assets/app.js"), "document.body.dataset.module = 'ready';");
  const filename = path.join(output, "地图.html");
  await fs.writeFile(filename, `<!doctype html><meta charset="utf-8"><script type="module" src="/assets/app.js"></script><h1>地图资源验证</h1><img src="http://127.0.0.1:${resources.address().port}/tile.svg">`);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const url = await createExternalWebPreviewUrl(filename);
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.module === "ready" && document.querySelector("img").naturalWidth > 0);
  assert.equal(requests[0].referer, new URL(url).origin + "/");
  assert(!requests[0].referer.includes(path.basename(output)));
  assert.equal(await page.locator("h1").textContent(), "地图资源验证");
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.module === "ready");
  await page.screenshot({ path: path.join(output, "browser.png") });
  console.log(JSON.stringify({ output, httpOrigin: true, originReferer: true, rootRelativeModules: true, reload: true }));
} finally {
  await browser?.close(); closeExternalWebPreviews(); resources.closeAllConnections(); resources.close();
}
