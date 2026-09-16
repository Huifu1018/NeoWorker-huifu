// Run after build:electron. Uses a disposable copy, never modifies the input.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const JSZip = require("jszip");
const { createHash } = require("node:crypto");
const { DocumentTools } = require("../../dist/electron/electron/agent/tools/document-tools.js");

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error("Usage: node scripts/qa/office-translation-source-smoke.cjs /path/to/source.pptx");
  const original = await fs.readFile(input);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-translation-source-qa-"));
  const sourceName = `source${path.extname(input)}`;
  await fs.writeFile(path.join(directory, sourceName), original);
  const published = [];
  const tools = new DocumentTools(directory, "translation-source-qa", (...args) => published.push(args));
  const inspected = await tools.officeTranslation({ action: "inspect", sourcePath: sourceName });
  assert.equal(published.length, 0, "Inspection must not publish a test artifact");
  const manifest = JSON.parse(await fs.readFile(path.join(directory, inspected.manifestPath), "utf8"));
  // Exercise real text replacements in titles and tables, not full translation.
  const translations = new Map([
    [" AI  vs ", " AI 对比 "], [" Vs ", " 对比 "], ["Positioning", "产品定位"],
    ["Advantages", "优势"], ["Disadvantages", "不足"], ["Marketing", "市场"],
    ["User Data", "用户数据"], ["Telecom", "电信"], ["Finance", "金融"],
    ["Medical", "医疗"], ["Internet", "互联网"], ["Laptop", "笔记本电脑"],
  ]);
  let changed = 0;
  for (const unit of manifest.units) {
    if (translations.has(unit.text)) { unit.text = translations.get(unit.text); changed += 1; }
  }
  assert.ok(changed > 0, "Fixture did not contain any expected test text");
  await fs.writeFile(path.join(directory, "translated-manifest.json"), JSON.stringify(manifest));
  const result = await tools.officeTranslation({ action: "apply", sourcePath: sourceName, translationsPath: "translated-manifest.json", filename: `translation-smoke${path.extname(input)}` });
  assert.equal(published.length, 1);
  assert.equal(hash(await fs.readFile(input)), hash(original), "Original attachment changed");
  const output = await fs.readFile(path.join(directory, result.path));
  const before = await JSZip.loadAsync(original);
  const after = await JSZip.loadAsync(output);
  const media = Object.keys(before.files).filter((name) => /\/media\//.test(name) && !before.files[name].dir);
  for (const name of media) assert.deepEqual(await before.file(name).async("nodebuffer"), await after.file(name).async("nodebuffer"));
  const report = { directory, outputPath: path.join(directory, result.path), sourceBytes: original.length, outputBytes: output.length, textUnits: manifest.units.length, changedTextUnits: changed, imagesUnchanged: media.length, sourceUnchanged: true, sourceFidelity: result.sourceFidelity, visualCheck: "not_performed", note: "Structural smoke test, not a complete translation" };
  await fs.writeFile(path.join(directory, "qa-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
