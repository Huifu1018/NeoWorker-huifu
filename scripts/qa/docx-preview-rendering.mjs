import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "vite";
import { chromium } from "playwright";
import { Document, Packer, Paragraph, TextRun, PageBreak, Table, TableRow, TableCell, Header, Footer } from "docx";

const require = createRequire(import.meta.url);
const { buildDocumentPreviewFromFile } = require("../../dist/electron/electron/utils/document-preview.js");
const output = await mkdtemp(path.join(tmpdir(), "neoworker-docx-preview-qa-"));
const fixture = path.join(output, "layout.docx");
await writeFile(fixture, await Packer.toBuffer(new Document({ sections: [{
  properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
  headers: { default: new Header({ children: [new Paragraph("QA HEADER")] }) },
  footers: { default: new Footer({ children: [new Paragraph("QA FOOTER")] }) },
  children: [
    new Paragraph({ alignment: "center", children: [new TextRun({ text: "ORIGINAL COVER", size: 48, color: "C00000", bold: true })] }),
    new Paragraph({ children: [new PageBreak()] }),
    new Paragraph("BODY ON PAGE TWO"),
    new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph("CELL A")] }), new TableCell({ children: [new Paragraph("CELL B")] })] })] }),
  ],
}] })));

const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {DocumentArtifactViewer} from '/components/DocumentArtifactViewer.tsx';
import '/styles/index.css';
window.writes = 0;
window.readOptions = null;
window.electronAPI = new Proxy({}, {get: (_, key) => {
  if (String(key).startsWith('on')) return () => () => {};
  if (key === 'readFileForViewer') return async (_path,_workspace,options) => { window.readOptions=options; return window.previewResult; };
  if (key === 'updateDocumentFile') return async () => { window.writes++; return window.previewResult; };
  if (key === 'getAppearanceSettings') return async () => ({theme:'light',language:'zh-CN'});
  if (key === 'getPermissionSettings') return async () => ({defaultPermissionMode:'bypass_permissions'});
  if (key === 'getVoiceSettings') return async () => ({enabled:false});
  return async () => [];
}});
document.body.classList.add('theme-light');
const root=createRoot(document.getElementById('root'));
let version=0;
window.showDocument=async (data) => {
  window.previewResult={success:true,data};
  root.render(React.createElement(DocumentArtifactViewer,{filePath:data.path,workspacePath:'/tmp',mode:'sidebar',refreshKey:++version,onClose:()=>{},onFullscreen:()=>{},onExitFullscreen:()=>{}}));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};
`;
const server = await createServer({
  configFile: path.resolve("config/vite.config.ts"),
  server: { port: 0, host: "127.0.0.1" },
  plugins: [{
    name: "docx-preview-qa",
    resolveId(id) { if (id === "__docx_qa_entry") return "\0__docx_qa_entry"; },
    load(id) { if (id === "\0__docx_qa_entry") return entry; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/__docx-qa.html") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml(req.url, '<html><head><style>html,body,#root{height:100%;margin:0} #root>.document-viewer{height:100vh;width:100%}</style></head><body><div id="root"></div><script type="module" src="/@id/__docx_qa_entry"></script></body></html>'));
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (err) => { errors.push(err.message); console.error(err.message); });
  page.on("console", (message) => { if (message.type() === "error") console.error(message.text()); });
  await page.goto(server.resolvedUrls.local[0] + "__docx-qa.html");
  await page.waitForFunction(() => typeof window.showDocument === "function", null, { timeout: 90000 });
  const dataFor = async (filePath) => ({ path: filePath, fileName: path.basename(filePath), fileType: "docx", size: (await readFile(filePath)).length,
    documentPreview: await buildDocumentPreviewFromFile(filePath, { includeDocxBase64: true }) });
  const ready = () => page.waitForSelector('.docx-layout-preview[data-preview-status="ready"]');
  await page.evaluate((data) => window.showDocument(data), await dataFor(fixture));
  await ready();
  const frame = () => page.frames().find((item) => item !== page.mainFrame());
  assert.equal(await page.evaluate(() => window.readOptions.includeDocxBase64), true);
  assert.equal(await page.locator('[contenteditable="true"]').count(), 0);
  assert.equal(await frame().locator("section.docx").count(), 2);
  const cover = await frame().locator("section.docx").first().evaluate((page) => {
    const span = [...page.querySelectorAll("span")].find((node) => node.textContent === "ORIGINAL COVER");
    return { color: getComputedStyle(span).color, size: getComputedStyle(span).fontSize, alignment: getComputedStyle(span.parentElement).textAlign, text: page.textContent, width: page.offsetWidth };
  });
  assert.equal(cover.color, "rgb(192, 0, 0)");
  assert.equal(cover.size, "32px");
  assert.equal(cover.alignment, "center");
  assert(!cover.text.includes("BODY ON PAGE TWO"));
  assert(cover.text.includes("QA HEADER"));
  assert(cover.text.includes("QA FOOTER"));
  assert(cover.width > 790 && cover.width < 800);
  assert.equal(await frame().locator("table").count(), 1);
  assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-same-origin");
  await page.screenshot({ path: path.join(output, "fixture-desktop.png") });
  await page.setViewportSize({ width: 480, height: 900 });
  await page.waitForTimeout(300);
  assert(await frame().evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(output, "fixture-narrow.png") });
  await page.getByTitle("简化编辑", { exact: true }).click();
  await page.waitForSelector('[contenteditable="true"]');
  await page.locator('[contenteditable="true"]').click();
  await page.getByTitle("文档排版预览", { exact: true }).click();
  await ready();
  assert.equal(await page.evaluate(() => window.writes), 0);
  const initialZoom = await frame().locator("#pages").evaluate((node) => Number(node.style.zoom));
  await page.getByTitle("放大", { exact: true }).click();
  await page.waitForTimeout(100);
  assert(await frame().locator("#pages").evaluate((node) => Number(node.style.zoom)) > initialZoom);
  await page.getByTitle("恢复 100%", { exact: true }).click();

  for (const filePath of process.argv.slice(2)) {
    const digest = () => readFile(filePath).then((bytes) => createHash("sha256").update(bytes).digest("hex"));
    const before = await digest();
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.evaluate((data) => window.showDocument(data), await dataFor(filePath));
    await ready();
    await frame().waitForFunction(() => [...document.images].every((image) => image.complete));
    const result = await frame().evaluate(() => ({
      pages: document.querySelectorAll("section.docx").length,
      tables: document.querySelectorAll("table").length,
      images: [...document.images].map((image) => ({ width: image.naturalWidth, height: image.naturalHeight })),
      titleStyle: (() => {
        const title = document.querySelector("section.docx article p span");
        return title && { color: getComputedStyle(title).color, size: getComputedStyle(title).fontSize, alignment: getComputedStyle(title.closest("p")).textAlign };
      })(),
    }));
    // This generated report has no stored page breaks; do not invent a cover page.
    assert(result.pages >= 1);
    assert.equal(result.titleStyle.color, "rgb(31, 78, 121)");
    assert.equal(result.titleStyle.alignment, "center");
    assert(result.images.length > 0 && result.images.every((image) => image.width > 0));
    assert(result.tables > 0);
    await page.screenshot({ path: path.join(output, "actual-desktop.png") });
    await frame().evaluate(() => window.scrollTo(0, 1100));
    await page.screenshot({ path: path.join(output, "actual-body.png") });
    assert.equal(await digest(), before, "Preview must never modify the source file");
    console.log(JSON.stringify({ filePath, ...result }));
  }
  const invalid = { ...(await dataFor(fixture)), path: "/tmp/corrupt.docx" };
  invalid.documentPreview.docxDataBase64 = btoa("not a zip");
  await page.evaluate((data) => window.showDocument(data), invalid);
  await page.waitForSelector('.docx-layout-preview[data-preview-status="error"]');
  assert.equal(await page.locator('[contenteditable="true"]').count(), 0);
  await page.evaluate((data) => window.showDocument(data), await dataFor(fixture));
  await ready();
  assert.equal(await frame().locator("section.docx").count(), 2);
  assert.equal(await page.evaluate(() => window.writes), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, output }));
} finally {
  await browser?.close();
  await server.close();
}
