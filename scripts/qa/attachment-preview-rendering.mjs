import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { createHash } from "node:crypto";

const output = await mkdtemp(path.join(tmpdir(), "neoworker-attachment-preview-qa-"));
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AttachmentImagePreview} from '/components/AttachmentImagePreview.tsx';
import {DocumentArtifactViewer} from '/components/DocumentArtifactViewer.tsx';
import '/styles/index.css';
import '/components/MainContent/main-content.css';
import '/styles/neoworker-design-system.css';
import '/styles/conversation-reading.css';
window.electronAPI = new Proxy({}, {get: (_, key) => {
  if (String(key).startsWith('on')) return () => () => {};
  if (key === 'readFileForViewer') return async () => window.previewResult;
  if (key === 'getAppearanceSettings') return async () => ({theme:'light',language:'zh-CN'});
  if (key === 'getPermissionSettings') return async () => ({defaultPermissionMode:'bypass_permissions'});
  if (key === 'getVoiceSettings') return async () => ({enabled:false});
  return async () => [];
}});
document.documentElement.classList.add('theme-light','visual-oblivion');
const root=createRoot(document.getElementById('root'));
window.showImage = (base64) => {
  const canvas = document.createElement('canvas'); canvas.width=600; canvas.height=240;
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='black';ctx.font='28px sans-serif';ctx.fillText('Attachment preview test',30,60);
  ctx.fillStyle='#ff0000';ctx.fillRect(30,100,120,100);
  root.render(React.createElement(React.StrictMode,null,React.createElement(AttachmentImagePreview,{name:'test.png',mimeType:'image/png',dataBase64:base64 || canvas.toDataURL().split(',')[1]})));
};
let version=0;
window.showDocument = (data) => {
  window.previewResult={success:true,data};
  root.render(React.createElement(React.StrictMode,null,React.createElement(DocumentArtifactViewer,{filePath:data.path,workspacePath:'/tmp',mode:'fullscreen',refreshKey:++version,onClose:()=>{},onFullscreen:()=>{},onExitFullscreen:()=>{}})));
};
`;
const server = await createServer({
  configFile: path.resolve("config/vite.config.ts"),
  server: { port: 0, host: "127.0.0.1" },
  plugins: [
    {
      name: "attachment-preview-qa",
      resolveId(id) {
        if (id === "__attachment_qa_entry") return "\0__attachment_qa_entry";
      },
      load(id) {
        if (id === "\0__attachment_qa_entry") return entry;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__attachment-qa.html") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<html><head><style>html,body,#root{height:100%;margin:0} #root>.document-viewer{height:100vh;width:100%}</style></head><body><div id="root"></div><script type="module" src="/@id/__attachment_qa_entry"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error);
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page.goto(server.resolvedUrls.local[0] + "__attachment-qa.html");
  await page.waitForFunction(() => typeof window.showImage === "function", null, {
    timeout: 90000,
  });
  const inputs = process.argv.slice(2);
  const images = [null, ...inputs.filter((file) => /\.png$/i.test(file))];
  for (const [index, image] of images.entries()) {
    const bytes = image ? await readFile(image) : null;
    for (const viewport of [
      { width: 1200, height: 1000 },
      { width: 480, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate((data) => window.showImage(data), bytes?.toString("base64"));
      await page.locator(".attachment-image-preview-trigger").click();
      for (const zoom of [100, 175, 300]) {
        const current = Number(
          (await page.locator(".attachment-image-lightbox-zoom span").innerText()).replace("%", ""),
        );
        for (let n = current; n < zoom; n += 25)
          await page.locator(".attachment-image-lightbox-zoom button").last().click();
        await page.waitForTimeout(180);
        const imageElement = page.locator(".attachment-image-lightbox-stage img");
        assert.equal(
          await imageElement.evaluate((el) => getComputedStyle(el).backgroundColor),
          "rgb(255, 255, 255)",
        );
        const rect = await imageElement.boundingBox();
        const screenshot = await page.screenshot({
          path: path.join(output, `image-${index}-${viewport.width}-${zoom}.png`),
        });
        const png = PNG.sync.read(screenshot);
        let white = 0,
          total = 0;
        for (
          let y = Math.max(100, Math.ceil(rect.y) + 12);
          y < Math.min(viewport.height - 100, rect.y + rect.height - 12);
          y += 3
        ) {
          for (
            let x = Math.max(30, Math.ceil(rect.x) + 12);
            x < Math.min(viewport.width - 30, rect.x + rect.width - 12);
            x += 3
          ) {
            const p = (y * png.width + x) * 4;
            total++;
            if (png.data[p] > 220 && png.data[p + 1] > 220 && png.data[p + 2] > 220) white++;
          }
        }
        assert(
          white / total > 0.65,
          `Transparent image appears dark at ${viewport.width}px/${zoom}%: ${white}/${total}`,
        );
      }
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".attachment-image-lightbox").count(), 0);
    }
    if (image) assert.deepEqual(await readFile(image), bytes, "Preview modified the image");
  }
  await page.setViewportSize({ width: 1200, height: 1000 });
  for (const filePath of inputs.filter((file) => /\.pdf$/i.test(file))) {
    const bytes = await readFile(filePath);
    await page.evaluate((data) => window.showDocument(data), {
      path: filePath,
      fileName: path.basename(filePath),
      fileType: "pdf",
      pdfDataBase64: bytes.toString("base64"),
      size: bytes.length,
      content: "",
    });
    await page.waitForFunction(() => {
      const c = document.querySelector("canvas");
      return c && c.width > 300 && c.height > 150;
    });
    const canvases = page.locator(".pdf-page-canvas");
    await page.waitForTimeout(500);
    for (let i = 0; i < (await canvases.count()); i++) {
      await canvases.nth(i).scrollIntoViewIfNeeded();
      await page.waitForFunction((index) => {
        const c = document.querySelectorAll("canvas")[index];
        return c && c.width > 300 && c.height > 150;
      }, i);
      await page.waitForTimeout(200);
      const dark = await canvases.nth(i).evaluate((canvas) => {
        const rgba = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] > 200 && rgba[i] < 180) count++;
        return count;
      });
      assert(dark > 100, `Blank PDF page ${i + 1}: ${filePath}`);
    }
    console.log(path.basename(filePath), `PASS: ${await canvases.count()} pages painted`);
    await page.screenshot({ path: path.join(output, path.basename(filePath) + ".png") });
    assert.equal(
      createHash("sha256")
        .update(await readFile(filePath))
        .digest("hex"),
      createHash("sha256").update(bytes).digest("hex"),
    );
  }
  console.log(JSON.stringify({ output, errors }));
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
