// Optional real-document replay. Inputs are user-owned; all outputs are QA-only
// copies in a new temporary directory. Dictionary keys are slide/run IDs.
const { app } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { inspectOfficeTranslation, applyOfficeTranslation, verifyOfficeTranslationFidelity } = require("../../dist/electron/electron/documents/office-translation.js");
const { fitPptxTranslation } = require("../../dist/electron/electron/documents/pptx-translation-layout.js");
const { measurePptxTextFit } = require("../../dist/electron/electron/utils/measure-pptx-text-fit.js");
const { renderOfficeHtmlVisualEvidence } = require("../../dist/electron/electron/utils/office-html-visual-renderer.js");
app.on("window-all-closed", () => {});
(async () => {
  const [sourcePath, dictionaryPath] = process.argv.slice(2);
  assert(sourcePath && dictionaryPath, "Pass source.pptx and a {slide:{run:text}} JSON dictionary");
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-translation-layout-qa-"));
  await fs.mkdir(path.join(output, "user-data"));
  app.setPath("userData", path.join(output, "user-data"));
  await app.whenReady();
  const source = await fs.readFile(sourcePath);
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const dictionary = JSON.parse(await fs.readFile(dictionaryPath, "utf8"));
  const manifest = await inspectOfficeTranslation(source);
  for (const [slide, translations] of Object.entries(dictionary)) for (const [index, text] of Object.entries(translations)) {
    const id = `ppt/slides/slide${slide}.xml#${index}`;
    const unit = manifest.units.find((unit) => unit.id === id); assert(unit, id);
    unit.text = text;
  }
  const translated = await applyOfficeTranslation(source, manifest);
  let boxes;
  const fitted = await fitPptxTranslation(source, translated, manifest, async (candidate, descriptors) => {
    boxes = descriptors;
    await fs.writeFile(path.join(output, "before-fit.pptx"), candidate);
    const measurements = await measurePptxTextFit(candidate, descriptors);
    await fs.writeFile(path.join(output, "measurements.json"), JSON.stringify(measurements, null, 2));
    return measurements;
  });
  await fs.writeFile(path.join(output, "fit-report.json"), JSON.stringify({ ...fitted, output: undefined }, null, 2));
  console.log(JSON.stringify({ output, checked: fitted.checkedShapes, adjusted: fitted.adjustedShapes, issues: fitted.issues.map(x => ({slide:x.slide,ids:x.unitIds,reason:x.reason})) }));
  assert(fitted.output, "Translation still needs concise rewriting; inspect fit-report.json");
  await verifyOfficeTranslationFidelity(source, fitted.output, true);
  const second = await measurePptxTextFit(fitted.output, boxes);
  await fs.writeFile(path.join(output, "post-write-measurements.json"), JSON.stringify(second, null, 2));
  assert(second.every((result) => result.fits && result.scale === 1), "Serialized PowerPoint must fit without further DOM adjustments");
  const filename = path.join(output, "QA-selected-pages.pptx");
  await fs.writeFile(filename, fitted.output);
  const images = [];
  for (const slide of Object.keys(dictionary)) {
    const htmlPath = path.join(output, `slide-${slide}.html`);
    await promisify(execFile)(path.resolve("build/officecli/mac-arm64/officecli"), ["view", filename, "html", "--page", slide, "-o", htmlPath, "--json"], { env: {...process.env, OFFICECLI_NO_AUTO_RESIDENT:"1"} });
    const visual = await renderOfficeHtmlVisualEvidence({ htmlPath, outputPath: path.join(output, `slide-${slide}.png`) });
    assert.equal(visual.imagePaths.length, 1); images.push(visual.imagePaths[0]);
  }
  assert.equal(sha(await fs.readFile(sourcePath)), sha(source));
  console.log(JSON.stringify({ output, sourceUnchanged: true, textFitVerifiedAfterSerialization: true, images }));
})().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
