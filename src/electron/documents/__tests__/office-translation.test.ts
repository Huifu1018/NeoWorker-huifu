import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import ExcelJS from "exceljs";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { applyOfficeTranslation, inspectOfficeTranslation, verifyOfficeTranslationFidelity, translationUnitIssue } from "../office-translation";

async function pptxFixture() {
  const pptx = new PptxGenJS();
  pptx.defineSlideMaster({ title: "ORIGINAL", background: { color: "267A65" }, objects: [] });
  const slide = pptx.addSlide("ORIGINAL");
  slide.addText([{ text: "Hello", options: { bold: true } }, { text: " world" }], { x: 1, y: 1, w: 5, h: 1 });
  slide.addNotes("Original notes");
  slide.addImage({ data: "image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXuoAAAAASUVORK5CYII=", x: 4, y: 3, w: 1, h: 1 });
  return Buffer.from(await pptx.write({ outputType: "nodebuffer" }) as Buffer);
}

async function translated(source: Buffer) {
  const manifest = await inspectOfficeTranslation(source);
  manifest.units = manifest.units.map((unit) => ({ ...unit, text: unit.text.includes("⟦s0⟧") ? unit.text.replace("⟦s0⟧", "⟦s0⟧译文 ") : `译文 ${unit.text}` }));
  return applyOfficeTranslation(source, manifest);
}

describe("native Office translation", () => {
  it("translates mixed-language proofing runs as one paragraph, preserving spaces and real emphasis", async () => {
    const pptx = new PptxGenJS();
    pptx.addSlide().addText([{ text: "BCM", options: { lang: "en-US" } }, { text: "采用", options: { lang: "zh-CN" } },
      { text: "ISO", options: { lang: "en-US" } }, { text: "镜像安装", options: { lang: "zh-CN" } }], { x: 1, y: 1, w: 6, h: 1, fontSize: 18 });
    const source = Buffer.from(await pptx.write({ outputType: "nodebuffer" }) as Buffer);
    const manifest = await inspectOfficeTranslation(source);
    const unit = manifest.units.find((unit) => unit.context === "BCM采用ISO镜像安装")!;
    expect(unit.text).toBe("BCM采用ISO镜像安装");
    unit.text = "BCM nutzt ISO-Images zur Installation.";
    const output = await applyOfficeTranslation(source, manifest);
    const xml = await (await JSZip.loadAsync(output)).file("ppt/slides/slide1.xml")!.async("text");
    expect(xml).toContain("BCM nutzt ISO-Images zur Installation.");
    expect(xml).not.toContain("BCMnutzt");
    await expect(verifyOfficeTranslationFidelity(source, output)).resolves.toBeUndefined();
  });
  it("keeps bold and normal sentences in one unit with validated formatting anchors", async () => {
    expect(translationUnitIssue({ id: "plain", text: "Plain text" }, "⟦s0⟧Injected anchors⟦/s0⟧")).toBe("format_anchors_changed");
    const source = await pptxFixture();
    const manifest = await inspectOfficeTranslation(source);
    const unit = manifest.units.find((unit) => unit.context === "Hello world")!;
    expect(unit.text).toBe("⟦s0⟧Hello⟦/s0⟧⟦s1⟧ world⟦/s1⟧");
    for (const invalid of ["Hallo Welt", "extra " + unit.text, "⟦s0⟧Hallo⟦/s0⟧ ⟦s1⟧Welt⟦/s1⟧", "⟦s1⟧Welt⟦/s1⟧⟦s0⟧Hallo⟦/s0⟧"]) {
      expect(translationUnitIssue(unit, invalid)).toBeTruthy();
    }
    unit.text = "⟦s0⟧Hallo⟦/s0⟧⟦s1⟧ Welt⟦/s1⟧";
    const output = await applyOfficeTranslation(source, manifest);
    const xml = await (await JSZip.loadAsync(output)).file("ppt/slides/slide1.xml")!.async("text");
    expect(xml).toContain(">Hallo</a:t>"); expect(xml).toContain("> Welt</a:t>");
    expect(xml).not.toContain("⟦");
    await expect(verifyOfficeTranslationFidelity(source, output)).resolves.toBeUndefined();
  });
  it.each(["bad\uFFFD", "bad\ud800", "bad\u0001"])("blocks corrupt text %j at final apply", async (text) => {
    const source = await pptxFixture();
    const manifest = await inspectOfficeTranslation(source);
    manifest.units[0].text = text;
    await expect(applyOfficeTranslation(source, manifest)).rejects.toThrow(manifest.units[0].id);
  });
  it("produces identical bytes when retrying a saved translation at a later time", async () => {
    const source = await pptxFixture();
    const manifest = await inspectOfficeTranslation(source);
    manifest.units[0].text = manifest.units[0].text.replace("Hello", "Translated title");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const first = await applyOfficeTranslation(source, manifest);
      vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
      expect(await applyOfficeTranslation(source, manifest)).toEqual(first);
    } finally { vi.useRealTimers(); }
  });
  it("groups adjacent equally formatted Word fragments without changing runs or styles", async () => {
    const source = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun("版"), new TextRun("本"), new TextRun({ text: "说明", bold: true })] })] }] }));
    const manifest = await inspectOfficeTranslation(source, true);
    expect(manifest.schema).toBe("neoworker.office-translation.v2");
    expect(manifest.units.map((unit) => unit.text)).toEqual(["版本", "说明"]);
    manifest.units[0].text = "Version";
    manifest.units[1].text = "Description";
    const output = await applyOfficeTranslation(source, manifest);
    await expect(verifyOfficeTranslationFidelity(source, output)).resolves.toBeUndefined();
    const xml = await (await JSZip.loadAsync(output)).file("word/document.xml")!.async("text");
    expect(xml).toContain("Version");
    expect(xml).toContain("Description");
  });

  it("keeps legacy manifests readable and names the invalid unit instead of silently deleting text", async () => {
    const source = await pptxFixture();
    const manifest = await inspectOfficeTranslation(source, false);
    expect(manifest.schema).toBe("neoworker.office-translation.v1");
    manifest.units[0].text = " ";
    await expect(applyOfficeTranslation(source, manifest)).rejects.toThrow(manifest.units[0].id);
    manifest.units = manifest.units.map((unit) => ({ ...unit, text: "Translated" }));
    await expect(applyOfficeTranslation(source, manifest)).resolves.toBeInstanceOf(Buffer);
  });
  it("changes PPT text while preserving original masters, pictures, slide order and geometry", async () => {
    const source = await pptxFixture();
    const output = await translated(source);
    await expect(verifyOfficeTranslationFidelity(source, output)).resolves.toBeUndefined();
    const original = await JSZip.loadAsync(source);
    const edited = await JSZip.loadAsync(output);
    expect(Object.keys(edited.files)).toEqual(Object.keys(original.files));
    for (const name of Object.keys(original.files).filter((name) => /media\/|\.rels$|ppt\/presentation.xml$/.test(name) && !original.files[name].dir)) {
      expect(await edited.file(name)!.async("nodebuffer")).toEqual(await original.file(name)!.async("nodebuffer"));
    }
    expect(await edited.file("ppt/slides/slide1.xml")!.async("text")).toContain("译文 Hello");
  });
  it("preserves Excel formulas, numeric cells, styles, merges and sheet names", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Original");
    sheet.getCell("A1").value = "Revenue";
    sheet.getCell("A1").font = { bold: true, color: { argb: "FF228844" } };
    sheet.mergeCells("A1:B1");
    sheet.getCell("A2").value = 123;
    sheet.getCell("B2").value = { formula: "A2*2", result: 246 };
    sheet.getCell("B2").numFmt = "$0.00";
    const source = Buffer.from(await workbook.xlsx.writeBuffer());
    const output = await translated(source);
    const result = new ExcelJS.Workbook();
    await result.xlsx.load(output);
    const actual = result.getWorksheet("Original")!;
    expect(actual.getCell("A1").value).toBe("译文 Revenue");
    expect(actual.getCell("A1").font).toEqual(sheet.getCell("A1").font);
    expect(actual.getCell("A2").value).toBe(123);
    expect(actual.getCell("B2").value).toEqual({ formula: "A2*2", result: 246 });
    expect(actual.getCell("B2").numFmt).toBe("$0.00");
    expect(actual.getCell("B1").isMerged).toBe(true);
  });
  it("preserves Word styles and paragraph/run structure", async () => {
    const source = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun({ text: "Hello", bold: true }), new TextRun(" world")] })] }] }));
    const output = await translated(source);
    const original = await JSZip.loadAsync(source);
    const result = await JSZip.loadAsync(output);
    expect(await result.file("word/styles.xml")!.async("nodebuffer")).toEqual(await original.file("word/styles.xml")!.async("nodebuffer"));
    expect(await result.file("word/document.xml")!.async("text")).toContain("译文 Hello");
    await expect(verifyOfficeTranslationFidelity(source, output)).resolves.toBeUndefined();
  });
  it.each(["missing", "duplicate", "stale", "empty", "unchanged"])("rejects %s translation manifests before writing", async (caseName) => {
    const source = await pptxFixture();
    const manifest = await inspectOfficeTranslation(source);
    if (caseName === "missing") manifest.units.pop();
    if (caseName === "duplicate") manifest.units[1] = manifest.units[0];
    if (caseName === "stale") manifest.sourceSha256 = "stale";
    if (caseName === "empty") manifest.units[0].text = "";
    await expect(applyOfficeTranslation(source, manifest)).rejects.toThrow();
  });
  it("rejects replacing the source deck with a structurally valid new template", async () => {
    const source = await pptxFixture();
    const replacement = new PptxGenJS();
    replacement.addSlide().addText("Translated report", { x: 1, y: 1, w: 5, h: 1 });
    await expect(verifyOfficeTranslationFidelity(source, Buffer.from(await replacement.write({ outputType: "nodebuffer" }) as Buffer))).rejects.toThrow();
  });
  it("rejects geometry and formula changes even when the file can still open", async () => {
    const source = await pptxFixture();
    const zip = await JSZip.loadAsync(await translated(source));
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("text");
    zip.file("ppt/slides/slide1.xml", xml.replace(/<a:off x="\d+"/, '<a:off x="12345"'));
    await expect(verifyOfficeTranslationFidelity(source, await zip.generateAsync({ type: "nodebuffer" }))).rejects.toThrow("原版式");
  });
});
