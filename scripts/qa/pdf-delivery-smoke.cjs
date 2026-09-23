// Exercise the packaged PDF exporter, including manuscript-relative images.
// Run with Electron after packaging, on either supported desktop platform.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');

const root = path.resolve(__dirname, '../..');
const asar = process.env.NEOWORKER_QA_ASAR || path.join(root, 'release',
  process.platform === 'darwin' ? 'mac-arm64/NeoWorker.app/Contents/Resources/app.asar' : 'win-unpacked/resources/app.asar');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoworker-pdf-smoke-'));
app.setPath('userData', path.join(directory, 'profile'));
process.env.NEOWORKER_USER_DATA_DIR = path.join(directory, 'profile');
app.on('window-all-closed', () => {});

const timeout = setTimeout(() => { console.error('PDF smoke timed out'); app.exit(1); }, 180_000);

async function main() {
  await app.whenReady();
  assert.equal(require(asar + '/package.json').version, require(root + '/package.json').version);
  const { PRODUCT_SEMVER } = require(asar + '/dist/electron/shared/product-brand.js');
  assert.equal(PRODUCT_SEMVER, require(root + '/package.json').version);
  const { renderPdfPages } = require(asar + '/dist/electron/electron/utils/pdf-page-render.js');
  const { DocumentTools } = require(asar + '/dist/electron/electron/agent/tools/document-tools.js');
  const PDFDocument = require('pdfkit');
  const source = path.join(directory, 'source.pdf');
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [600, 800] });
    const stream = fs.createWriteStream(source);
    doc.pipe(stream);
    doc.rect(60, 80, 200, 150).fill('#1684ca');
    doc.fillColor('#ffffff').fontSize(28).text('Original figure', 70, 125);
    doc.fillColor('#111111').fontSize(12).text('Source document text. '.repeat(50), 50, 300, { width: 480 });
    doc.end();
    stream.on('finish', resolve).on('error', reject);
  });
  console.log('PDF smoke: render original figure');
  await renderPdfPages(source, path.join(directory, 'images'), {
    firstPage: 1, lastPage: 1, crop: { x: 0.1, y: 0.1, width: 1 / 3, height: 0.1875 },
  });
  fs.mkdirSync(path.join(directory, 'drafts'));
  const text = [
    '# 中文图片交付验证',
    '这是一份包含原始图片的中文文档。导出程序应保留图片内容，并提供可以直接打开的最终文件。',
    '## 正文与原图',
    '源文档中的矢量图先由内置渲染器生成图片。下方引用使用相对于稿件目录的路径，测试不依赖外部浏览器或网络服务。',
    '![原始图片](../images/page-1.png)',
    '## 交付检查',
    '生成结束后，重新读取最终字节并统计图片绘制操作。中文标题需要能够正常提取，临时稿件的路径应记录在导出信息中。',
    '缺失图片和损坏文件分别作为失败样例运行。这两种情况必须拒绝生成，不得添加成功的文件卡片。',
    '安装包版本与界面版本来自同一份源代码，并在本检查中与发布版本进行核对。',
    '最终报告只记录检查结果，不依赖用户账号、模型配置或私人文档。',
  ].join('\n\n');
  fs.writeFileSync(path.join(directory, 'drafts', 'translation.md'), text);
  const artifacts = [];
  const tools = new DocumentTools(directory, 'pdf-release-smoke', (...args) => artifacts.push(args));
  console.log('PDF smoke: export translated PDF');
  const exported = await tools.generateDocument({ filename: 'final.pdf', markdown_path: 'drafts/translation.md' });
  console.log('PDF smoke: validate final PDF');
  assert.equal(exported.success, true);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0][3].manuscriptPath, path.join('drafts', 'translation.md'));
  const pdfjs = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(exported.path)), useSystemFonts: true }).promise;
  let imageCount = 0;
  let outputText = '';
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const operators = await page.getOperatorList();
    imageCount += operators.fnArray.filter((op) => [pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageXObjectRepeat].includes(op)).length;
    outputText += (await page.getTextContent()).items.map((item) => item.str || '').join('');
  }
  assert.equal(imageCount, 1);
  console.log(JSON.stringify({ phase: 'pdf-text', outputText, imageCount }));
  assert(outputText.normalize('NFKC').replace(/\s/g, '').includes('中文图片交付验证'));
  fs.writeFileSync(path.join(directory, 'images', 'corrupt.png'), 'invalid image bytes');
  for (const name of ['missing', 'corrupt']) {
    await assert.rejects(() => tools.generateDocument({ filename: name + '.pdf', markdown: `# 图片校验\n\n![required image](images/${name}.png)` }));
    assert.equal(fs.existsSync(path.join(directory, name + '.pdf')), false);
  }
  assert.equal(artifacts.length, 1, 'Rejected exports must not create artifact cards');
  console.log(JSON.stringify({ passed: true, platform: process.platform, version: PRODUCT_SEMVER, imageCount, pages: pdf.numPages }));
  await pdf.destroy();
}

main().then(() => {
  clearTimeout(timeout);
  // Chromium can hold its temporary profile open until process exit on Windows.
  try { fs.rmSync(directory, { recursive: true, force: true }); }
  catch (error) {
    if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
    console.log('Temporary browser profile will be removed by runner cleanup.');
  }
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error(error);
  console.error('PDF smoke evidence retained at ' + directory);
  app.exit(1);
});
