// Real offline PDF equation export on both desktop platforms.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const root = path.resolve(__dirname, '../..');
const runtime = process.env.NEOWORKER_QA_ASAR || path.join(root, 'release', process.platform === 'darwin'
  ? 'mac-arm64/NeoWorker.app/Contents/Resources/app.asar' : 'win-unpacked/resources/app.asar');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'neoworker-math-smoke-'));
app.setPath('userData', path.join(temp, 'profile'));
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('Math PDF export timed out'); app.exit(1); }, 180000);
(async () => {
  await app.whenReady();
  const { generatePDF } = require(runtime + '/dist/electron/electron/utils/document-generators/pdf-generator.js');
  const { reviewPdfLayout } = require(runtime + '/dist/electron/electron/utils/pdf-layout-review.js');
  const output = process.env.NEOWORKER_MATH_OUTPUT || path.join(temp, 'equations.pdf');
  const result = await generatePDF(output, { markdown: fs.readFileSync(path.join(root, 'scripts/qa/fixtures/paper-equations.md'), 'utf8') });
  assert.equal(result.success, true);
  const review = await reviewPdfLayout(output);
  assert.equal(review.passed, true);
  assert(!/\\(?:frac|sum|tag|begin)/.test(review.text), 'LaTeX must not be printed verbatim');
  const bytes = fs.readFileSync(output).toString('latin1');
  assert(bytes.includes('KaTeX'), 'Mathematical fonts must be embedded');
  for (const number of ['1', '2', '3']) assert(review.text.replace(/\s/g, '').includes('(' + number + ')'));
  await assert.rejects(() => generatePDF(path.join(temp, 'invalid.pdf'), { markdown: '$$\\badEquation{x}$$' }), /formula could not be typeset/);
  assert(!fs.existsSync(path.join(temp, 'invalid.pdf')));
  console.log(JSON.stringify({ passed: true, platform: process.platform, pages: result.pageCount, output }));
})().then(() => { clearTimeout(timeout); app.exit(0); }).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
