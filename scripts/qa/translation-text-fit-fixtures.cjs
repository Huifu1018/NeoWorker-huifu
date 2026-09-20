const { app } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const PptxGenJS = require("pptxgenjs");
const JSZip = require("jszip");
const { inspectOfficeTranslation, applyOfficeTranslation } = require("../../dist/electron/electron/documents/office-translation.js");
const { fitPptxTranslation } = require("../../dist/electron/electron/documents/pptx-translation-layout.js");
app.on("window-all-closed", () => {});
(async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-text-fit-fixtures-"));
  await fs.mkdir(path.join(output, "user-data")); app.setPath("userData", path.join(output, "user-data"));
  await app.whenReady();
  const results = [];
  for (const kind of ["shape", "table"]) {
    const pptx = new PptxGenJS(); const slide = pptx.addSlide();
    if (kind === "shape") slide.addText("Example", { x: 1, y: 1, w: 3, h: 0.5, fontSize: 20 });
    else slide.addTable([["Example", "Count"], ["Value", "10"]], { x: 1, y: 1, w: 4, h: 1, fontSize: 14, rowH: 0.5, margin: 4 });
    const source = Buffer.from(await pptx.write({ outputType: "nodebuffer" }));
    for (const long of [false, true]) {
      const manifest = await inspectOfficeTranslation(source);
      manifest.units.find((unit) => unit.text === "Example").text = long ? "Ein sehr langer deutscher Satz. ".repeat(80) : "Ein Beispiel";
      const translated = await applyOfficeTranslation(source, manifest);
      const result = await fitPptxTranslation(source, translated, manifest);
      results.push({ kind, long, checked: result.checkedShapes, issues: result.issues });
      assert.equal(Boolean(result.output), !long, JSON.stringify(results.at(-1)));
      if (long) assert(result.issues.every((issue) => issue.reason === "translation_too_long"));
    }
  }
  // Regression: justified Korean wraps with hanging spaces in Chromium's
  // whole-node Range rects. Those spaces must not trigger destructive rewrites.
  for (const overflow of [false, true]) {
    const pptx = new PptxGenJS(); const slide = pptx.addSlide();
    slide.addText("原文", { x: 1, y: 1, w: 198.72 / 72, h: 144.82 / 72,
      fontSize: 13.33, fontFace: "Microsoft YaHei", bold: true, margin: 0,
      align: "justify", valign: "mid", lineSpacingMultiple: 1.2 });
    const source = Buffer.from(await pptx.write({ outputType: "nodebuffer" }));
    const manifest = await inspectOfficeTranslation(source);
    manifest.units.find(unit => unit.text === "原文").text =
      "Token 플랫폼을 구축해 주는 대리점은 서버만 파는 곳과 다른 수준의 파트너. 더 이른 AI 논의·큰 기회·경쟁 대체 차단.".repeat(overflow ? 20 : 1);
    const result = await fitPptxTranslation(source, await applyOfficeTranslation(source, manifest), manifest);
    results.push({ kind: "justified-korean", overflow, checked: result.checkedShapes, adjusted: result.adjustedShapes, issues: result.issues });
    assert.equal(Boolean(result.output), !overflow, JSON.stringify(results.at(-1)));
    if (!overflow) assert.equal(result.adjustedShapes, 0, "Visible text fits at its original font size");
    else assert(result.issues.every(issue => issue.reason === "translation_too_long"));
  }
  // Adjacent text is a real constraint even when the original frames overlap.
  {
    const pptx = new PptxGenJS(); const slide = pptx.addSlide();
    slide.addText("费用", { x: 1, y: 1, w: 5, h: 0.5, fontSize: 20, margin: 0 });
    slide.addText("每年", { x: 3.5, y: 1, w: 2, h: 0.5, fontSize: 20, margin: 0 });
    const source = Buffer.from(await pptx.write({ outputType: "nodebuffer" }));
    const manifest = await inspectOfficeTranslation(source);
    manifest.units.find(u => u.text === "费用").text = "Jährliche Infrastrukturkosten";
    manifest.units.find(u => u.text === "每年").text = "pro Jahr";
    const result = await fitPptxTranslation(source, await applyOfficeTranslation(source, manifest), manifest);
    assert(result.output, JSON.stringify(result.issues));
    assert(result.adjustedShapes > 0, "Overlapping frames must not publish colliding glyphs at full size");
    results.push({ kind: "overlapping-source-frames", checked: result.checkedShapes, adjusted: result.adjustedShapes, issues: result.issues });
  }
  // Both centered labels grow into the same gap; fitting each against only
  // the neighbor's old glyphs passes, then the final overlap check fails.
  for (const distance of [0.6, 1.2]) {
    const pptx = new PptxGenJS(); const slide = pptx.addSlide();
    slide.addText("甲", { x: 1, y: 1, w: 2, h: 0.3, fontSize: 14, margin: 0, align: "center" });
    slide.addText("乙", { x: 1 + distance, y: 1, w: 2, h: 0.3, fontSize: 14, margin: 0, align: "center" });
    const source = Buffer.from(await pptx.write({ outputType: "nodebuffer" }));
    const manifest = await inspectOfficeTranslation(source);
    manifest.units[0].text = "Centralized storage";
    manifest.units[1].text = "Distributed storage";
    const result = await fitPptxTranslation(source, await applyOfficeTranslation(source, manifest), manifest);
    assert.equal(Boolean(result.output), distance > 1, JSON.stringify(result.issues));
    if (result.output) assert.equal(result.adjustedShapes, 2);
    else assert(result.issues.every(issue => ["translation_too_long", "translated_neighbor_text_overlap"].includes(issue.reason)));
    results.push({ kind: "shared-centered-label-gap", distance, checked: result.checkedShapes, adjusted: result.adjustedShapes, issues: result.issues });
  }
  for (const kind of ["local-font", "vertical-autofit", "duplicate-unchanged", "centered-blank-line"]) {
    const pptx = new PptxGenJS(); const slide = pptx.addSlide();
    if (kind === "duplicate-unchanged") slide.addText("Same", { x: 1, y: 1, w: 2, h: 0.5, fontSize: 14 });
    slide.addText("原文", { x: 1, y: 3, w: kind === "vertical-autofit" ? 0.8 : 3, h: kind === "local-font" ? 0.18 : 1.6,
      fontSize: kind === "local-font" ? 10 : 14, margin: 0, valign: "mid", vert: kind === "vertical-autofit" ? "eaVert" : undefined });
    let source = Buffer.from(await pptx.write({ outputType: "nodebuffer" }));
    const zip = await JSZip.loadAsync(source);
    let xml = await zip.file("ppt/slides/slide1.xml").async("text");
    if (kind === "local-font") xml = xml.replace(/ sz="1000"/g, "").replace('<a:lstStyle/>', '<a:lstStyle><a:lvl1pPr><a:defRPr sz="1000"/></a:lvl1pPr></a:lstStyle>');
    if (kind === "vertical-autofit") xml = xml.replace('</a:bodyPr>', '<a:spAutoFit/></a:bodyPr>');
    if (kind === "centered-blank-line") xml = xml.replace('</p:txBody>', '<a:p><a:endParaRPr sz="1200"/></a:p></p:txBody>');
    zip.file("ppt/slides/slide1.xml", xml); source = await zip.generateAsync({ type: "nodebuffer" });
    const manifest = await inspectOfficeTranslation(source);
    manifest.units.find(unit => unit.text === "原文").text = kind === "duplicate-unchanged" ? "Same" : kind === "vertical-autofit" ? "Memory" : "Source text";
    const result = await fitPptxTranslation(source, await applyOfficeTranslation(source, manifest), manifest);
    assert(result.output, JSON.stringify({ kind, issues: result.issues }));
    if (kind === "duplicate-unchanged") assert.equal(result.adjustedShapes, 0);
    results.push({ kind, checked: result.checkedShapes, adjusted: result.adjustedShapes, issues: result.issues });
  }
  {
    const pptx = new PptxGenJS(); const slide = pptx.addSlide();
    slide.addText("全链路安全合规", { x: 1, y: 1, w: 0.25, h: 2, fontSize: 12, margin: 0 });
    const source = Buffer.from(await pptx.write({ outputType: "nodebuffer" }));
    const manifest = await inspectOfficeTranslation(source);
    manifest.units[0].text = "End-to-end security & compliance";
    const result = await fitPptxTranslation(source, await applyOfficeTranslation(source, manifest), manifest);
    assert(result.output, JSON.stringify(result.issues));
    assert.equal(result.rotatedLabels, 1);
    results.push({ kind: "narrow-cjk-label", checked: result.checkedShapes, adjusted: result.adjustedShapes, issues: result.issues });
  }
  await fs.writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, casesPassed: results.length }));
})().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
